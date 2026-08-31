/**
 * Link view TreeDataProvider and its supporting TreeItems (LinkGroup, Link).
 *
 * Extracted from `extension.ts` (phase 2 module split). Also hosts the
 * `LinkEntry` interface and the `loadLinksFromDisk` helper, which is used
 * both by this provider and by command handlers that still live in
 * `extension.ts`.
 *
 * `extension.ts` imports these symbols but does not re-export them. External
 * callers and tests should import them directly from this module.
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
    /**
     * 디스크에서 읽은 **원본 객체**.
     *
     * 이게 없던 동안에는 `serializeLinks` 가 **알려진 필드만** 내보내서,
     * 한 항목만 추가해도 파일 전체의 `custom: {...}` 같은 확장 속성과
     * 정규화에서 걸러진 값(`tags: ["keep", 42]` 의 `42`, `group: 42`)이
     * 사라졌다. 우리는 손대지 않은 항목의 형태를 정할 권한이 없다.
     */
    raw?: unknown;
    /**
     * 사용자가 이 항목을 **이번 작업에서 편집했는가**.
     *
     * `raw` 만으로는 "손대지 않았다" 와 "편집했다" 를 구분할 수 없다. 편집
     * 경로가 기존 항목을 spread 하면 `raw` 까지 복사되는데, 그때 `raw` 를
     * 그대로 되쓰면 **편집이 조용히 버려지고 옛 값이 다시 기록된다** — 실제로
     * 그 상태였다. 편집 여부를 명시적으로 표시해 갈라야 한다.
     *
     * 편집된 항목은 `raw` 위에 알려진 필드만 patch 한다 — 사용자가 고친 값이
     * 반영되면서 `custom` 같은 확장 속성은 남는다.
     */
    edited?: true;
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
        this.command = {
            command: 'taskhub.openLink',
            title: t('링크 열기', 'Open Link'),
            arguments: [entry.link]
        };
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

/**
 * 스키마를 만족하지 못해 `LinkEntry` 로 만들 수 없었던 항목. **원본을 그대로**
 * 들고 있다 — 쓰기 경로가 다시 끼워 넣어야 하기 때문이다.
 */
export interface InvalidJsonEntry {
    /** 원본 배열에서의 위치. 되돌려 쓸 때 순서를 최대한 지키는 데 쓴다. */
    index: number;
    raw: unknown;
}

export type LinksLoadResult =
    | { ok: true; entries: LinkEntry[]; invalid: InvalidJsonEntry[] }
    | { ok: false; error: string };

/**
 * 유효한 항목을 직렬화한 배열에 **무효 항목을 원래 자리로 되돌린다**.
 *
 * 이것이 없으면 `title`/`link` 타입이 틀린 항목이 로드 단계에서 조용히 걸러진
 * 뒤, 다음 Add/Edit/Delete 가 걸러진 배열을 직렬화해 원본 파일을 덮어써
 * **영구히 사라진다**. 사용자는 지운 적이 없다.
 *
 * 항목이 추가·삭제되면 인덱스가 밀리므로 원래 순서를 정확히 복원하지는
 * 못한다. 그래도 위치보다 **잃지 않는 것**이 우선이다 — 넘치는 인덱스는 끝에
 * 붙인다.
 */
export function mergeInvalidJsonEntries(serialized: unknown[], invalid: InvalidJsonEntry[]): unknown[] {
    if (invalid.length === 0) { return serialized; }
    const merged = [...serialized];
    for (const { index, raw } of [...invalid].sort((a, b) => a.index - b.index)) {
        merged.splice(Math.min(index, merged.length), 0, raw);
    }
    return merged;
}

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
        return { ok: true, entries: [], invalid: [] };
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
    const invalid: InvalidJsonEntry[] = [];
    parsed.forEach((item, index) => {
        if (item && typeof (item as any).title === 'string' && typeof (item as any).link === 'string') {
            const cast = item as any;
            entries.push({
                title: cast.title,
                link: cast.link,
                group: typeof cast.group === 'string' && cast.group.trim().length > 0 ? cast.group.trim() : undefined,
                tags: normalizeTags(cast.tags),
                sourceFile: filePath,
                raw: item
            });
            return;
        }
        // **버리지 않고 들고 간다.** 예전에는 여기서 조용히 걸러 낸 뒤 `ok: true`
        // 를 돌려줬고, 다음 Add/Edit/Delete 가 그 걸러진 배열을 직렬화해 원본을
        // 덮어썼다 — 사용자가 지운 적 없는 항목이 영구히 사라졌다.
        invalid.push({ index, raw: item });
    });
    return { ok: true, entries, invalid };
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
            this.view.title = t(`워크스페이스 링크 (${count})`, `Workspace Links (${count})`);
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
