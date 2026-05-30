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

export type LinkTreeNode = Link | LinkGroup;

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
        const folders = this.getWorkspaceFolders();
        for (const folder of folders) {
            const workspaceLinksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
            results.push(...loadLinksFromDisk(workspaceLinksPath, true));
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
