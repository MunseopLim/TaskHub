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

export function loadLinksFromDisk(filePath: string, reportErrors: boolean): LinkEntry[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.reduce<LinkEntry[]>((acc, item) => {
            if (item && typeof item.title === 'string' && typeof item.link === 'string') {
                const entry: LinkEntry = {
                    title: item.title,
                    link: item.link,
                    group: typeof item.group === 'string' && item.group.trim().length > 0 ? item.group.trim() : undefined,
                    tags: normalizeTags(item.tags),
                    sourceFile: filePath
                };
                acc.push(entry);
            }
            return acc;
        }, []);
    } catch (error: any) {
        console.error(`Error parsing ${filePath}: ${error.message}`);
        if (reportErrors) {
            vscode.window.showErrorMessage(t(`${path.basename(filePath)} 파싱 오류: ${error.message}`, `Error parsing ${path.basename(filePath)}: ${error.message}`));
        }
        return [];
    }
}

export class LinkViewProvider implements vscode.TreeDataProvider<LinkTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<LinkTreeNode | undefined | null | void> = new vscode.EventEmitter<LinkTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LinkTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<LinkTreeNode> | undefined;
    private cachedEntries: LinkEntry[] = [];
    // Distinguish "never loaded" from "loaded but empty" so ensureCache() does
    // not keep re-reading the JSON when the user genuinely has zero links.
    private loaded = false;

    constructor(private context: vscode.ExtensionContext, private readonly mode: 'builtin' | 'workspace') {
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

    private updateTitle(): void {
        if (this.view) {
            const count = this.cachedEntries.length;
            const label = this.mode === 'builtin' ? 'Built-in Links' : 'Workspace Links';
            this.view.title = `${label} (${count})`;
        }
    }

    private loadLinks(): LinkEntry[] {
        const results: LinkEntry[] = [];
        if (this.mode === 'builtin') {
            const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'links.json');
            results.push(...loadLinksFromDisk(mediaJsonPath, false));
        } else {
            const folders = vscode.workspace.workspaceFolders ?? [];
            for (const folder of folders) {
                const workspaceLinksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
                results.push(...loadLinksFromDisk(workspaceLinksPath, true));
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
