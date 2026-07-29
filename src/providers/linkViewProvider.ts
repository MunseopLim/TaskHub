/**
 * Link view TreeDataProvider and its supporting TreeItems (LinkGroup, Link).
 *
 * Extracted from `extension.ts` (phase 2 module split). Also hosts the
 * `LinkEntry` interface and the `loadLinksFromDisk` helper, which is used
 * both by this provider and by command handlers that still live in
 * `extension.ts`.
 *
 * `extension.ts` re-exports everything here so existing callers (including
 * tests) can keep `import { ... } from './extension'` unchanged.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';
import { normalizeTags } from './normalization';

export interface LinkEntry {
    title: string;
    link: string;
    group?: string;
    tags?: string[];
    sourceFile?: string;
}

export type LinkTreeNode = Link | LinkGroup | LinkParseError;

/**
 * 파싱에 실패한 파일을 **트리에 남긴다**.
 *
 * 예전에는 실패를 빈 배열로 바꿔 loaded 로 확정했다. 토스트가 한 번 뜨긴
 * 했지만 그것이 사라지고 나면 트리는 "링크가 하나도 없는 상태"와 **구분이
 * 되지 않았고**, 빈 상태 CTA("링크 추가")까지 떠서 사용자는 파일이 비었다고
 * 읽었다 — 실제로는 고쳐야 할 JSON 이 있는데도.
 *
 * 행 하나가 남으면 빈 상태 CTA 도 뜨지 않고, 클릭하면 문제의 파일이 열린다.
 */
export class LinkParseError extends vscode.TreeItem {
    constructor(public readonly filePath: string, message: string) {
        super(t(`${path.basename(filePath)} 을(를) 읽지 못했습니다`, `Could not read ${path.basename(filePath)}`),
            vscode.TreeItemCollapsibleState.None);
        this.description = message;
        this.tooltip = t(
            `${filePath}\n\n${message}\n\n클릭하면 파일을 엽니다.`,
            `${filePath}\n\n${message}\n\nClick to open the file.`
        );
        this.command = {
            command: 'vscode.open',
            title: t('JSON 열기', 'Open JSON'),
            arguments: [vscode.Uri.file(filePath)],
        };
        this.contextValue = 'linkParseError';
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    }
}

export class LinkGroup extends vscode.TreeItem {
    constructor(public readonly groupName: string, private readonly entries: LinkEntry[]) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${entries.length}`;
        this.contextValue = 'linkGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }

    getEntries(): LinkEntry[] {
        return this.entries;
    }
}

export class Link extends vscode.TreeItem {
    constructor(private readonly entry: LinkEntry) {
        super(entry.title, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${entry.title} - ${entry.link}`;
        this.description = entry.tags && entry.tags.length > 0 ? entry.tags.join(', ') : undefined;
        this.command = { command: 'taskhub.openLink', title: 'Open Link', arguments: [entry.link] };
        this.contextValue = 'linkItem';
        this.iconPath = new vscode.ThemeIcon('link');
    }

    getLink(): string {
        return this.entry.link;
    }

    getEntry(): LinkEntry {
        return this.entry;
    }
}

/**
 * Tree-side loader. On parse failure: log + (optionally) toast + return `[]`.
 * Forgiving by design — tree rendering must keep working with stale/empty
 * results instead of refusing to render. Write-side callers (add/delete/edit
 * commands) MUST use {@link readLinksFromDisk} instead so a corrupt file
 * does not silently get overwritten with a synthetic 1-entry array.
 */
export function loadLinksFromDisk(filePath: string, reportErrors: boolean): LinkEntry[] {
    const result = readLinksFromDisk(filePath);
    if (result.ok) {
        return result.entries;
    }
    console.error(`Error parsing ${filePath}: ${result.error}`);
    if (reportErrors) {
        vscode.window.showErrorMessage(t(
            `${path.basename(filePath)} 파싱 오류: ${result.error}`,
            `Error parsing ${path.basename(filePath)}: ${result.error}`
        ));
    }
    return [];
}

export type LinksLoadResult =
    | { ok: true; entries: LinkEntry[] }
    | { ok: false; error: string };

/**
 * Write-safe loader: returns a tagged result that distinguishes `[]` (file
 * missing or empty array) from a parse failure. Add/delete/edit commands
 * call this so they can refuse to overwrite a corrupt links.json — the
 * old `loadLinksFromDisk` returned `[]` on parse failure, which the
 * write paths could not tell apart from "no entries yet" and would happily
 * append a single new entry on top, destroying the original content. Now
 * the caller can show a recovery toast (with an *Open links.json* button)
 * and abort instead. Vscode-free for unit-testability.
 */
export function readLinksFromDisk(filePath: string): LinksLoadResult {
    if (!fs.existsSync(filePath)) {
        return { ok: true, entries: [] };
    }
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error: any) {
        return { ok: false, error: error.message };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error: any) {
        return { ok: false, error: error.message };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, error: 'Top-level value must be an array.' };
    }
    const entries: LinkEntry[] = [];
    for (const item of parsed) {
        if (item && typeof (item as any).title === 'string' && typeof (item as any).link === 'string') {
            const cast = item as any;
            entries.push({
                title: cast.title,
                link: cast.link,
                group: typeof cast.group === 'string' && cast.group.trim().length > 0 ? cast.group.trim() : undefined,
                tags: normalizeTags(cast.tags),
                sourceFile: filePath
            });
        }
    }
    return { ok: true, entries };
}

export class LinkViewProvider implements vscode.TreeDataProvider<LinkTreeNode>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<LinkTreeNode | undefined | null | void> = new vscode.EventEmitter<LinkTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LinkTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<LinkTreeNode> | undefined;
    private cachedEntries: LinkEntry[] = [];
    /** 이번 로드에서 파싱에 실패한 파일들. 트리에 오류 행으로 나타난다. */
    private parseFailures: { filePath: string; message: string }[] = [];
    // Distinguish "never loaded" from "loaded but empty" so ensureCache() does
    // not keep re-reading the JSON when the user genuinely has zero links.
    private loaded = false;

    constructor(
        private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] = () => vscode.workspace.workspaceFolders ?? []
    ) {
        // No disk I/O in the constructor. The first refresh() (e.g. from a file
        // watcher) or the first getChildren() call (when the view becomes
        // visible) performs the load — see ensureCache().
    }

    refresh(): void {
        this.cachedEntries = this.loadLinks();
        this.loaded = true;
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    private updateTitle(): void {
        if (this.view) {
            const count = this.cachedEntries.length;
            this.view.title = `Workspace Links (${count})`;
        }
    }

    private loadLinks(): LinkEntry[] {
        const results: LinkEntry[] = [];
        // 실패한 파일을 기억해 트리에 오류 행으로 남긴다 (LinkParseError 주석 참조).
        this.parseFailures = [];
        const folders = this.getWorkspaceFolders();
        for (const folder of folders) {
            const workspaceLinksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
            const result = readLinksFromDisk(workspaceLinksPath);
            if (result.ok) {
                results.push(...result.entries);
            } else {
                console.error(`Error parsing ${workspaceLinksPath}: ${result.error}`);
                this.parseFailures.push({ filePath: workspaceLinksPath, message: result.error });
                vscode.window.showErrorMessage(t(
                    `${path.basename(workspaceLinksPath)} 파싱 오류: ${result.error}`,
                    `Error parsing ${path.basename(workspaceLinksPath)}: ${result.error}`
                ));
            }
        }
        return results;
    }

    private ensureCache(): void {
        if (!this.loaded) {
            this.cachedEntries = this.loadLinks();
            this.loaded = true;
            // First lazy load: also update the view title so that the "(N)"
            // count appears as soon as the user opens the sidebar.
            this.updateTitle();
        }
    }

    private sortEntries(entries: LinkEntry[]): LinkEntry[] {
        return [...entries].sort((a, b) => a.title.localeCompare(b.title));
    }

    private buildRootNodes(): LinkTreeNode[] {
        this.ensureCache();
        const grouped = new Map<string, LinkEntry[]>();
        const ungrouped: LinkEntry[] = [];

        for (const entry of this.cachedEntries) {
            const groupName = entry.group;
            if (groupName) {
                const bucket = grouped.get(groupName) ?? [];
                bucket.push(entry);
                grouped.set(groupName, bucket);
            } else {
                ungrouped.push(entry);
            }
        }

        const nodes: LinkTreeNode[] = [];
        // 오류를 맨 위에 둔다 — 목록을 훑기 전에 보여야 한다.
        for (const failure of this.parseFailures) {
            nodes.push(new LinkParseError(failure.filePath, failure.message));
        }
        const sortedGroupNames = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroupNames) {
            const entries = this.sortEntries(grouped.get(name)!);
            nodes.push(new LinkGroup(name, entries));
        }
        const sortedUngrouped = this.sortEntries(ungrouped);
        for (const entry of sortedUngrouped) {
            nodes.push(new Link(entry));
        }
        return nodes;
    }

    getTreeItem(element: LinkTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: LinkTreeNode): Thenable<LinkTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.buildRootNodes());
        }

        if (element instanceof LinkGroup) {
            const children = element.getEntries().map(entry => new Link(entry));
            return Promise.resolve(children);
        }

        return Promise.resolve([]);
    }

    public getAllEntries(): LinkEntry[] {
        this.ensureCache();
        return [...this.cachedEntries];
    }
}
