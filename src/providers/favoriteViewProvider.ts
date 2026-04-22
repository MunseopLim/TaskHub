/**
 * Favorite view TreeDataProvider and its supporting TreeItems
 * (FavoriteGroup, Favorite).
 *
 * Extracted from `extension.ts` (phase 2 module split). Also hosts the
 * `FavoriteEntry` interface and the `loadFavoritesFromDisk` helper, which
 * is used both by this provider and by command handlers that still live
 * in `extension.ts`.
 *
 * `extension.ts` re-exports everything here so existing callers (including
 * tests) can keep `import { ... } from './extension'` unchanged.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';
import { normalizeLineNumber, normalizeTags } from './normalization';

export interface FavoriteEntry {
    title: string;
    path: string;
    line?: number;
    group?: string;
    tags?: string[];
    sourceFile?: string;
    workspaceFolder?: string;
}

export type FavoriteTreeNode = Favorite | FavoriteGroup;

export class FavoriteGroup extends vscode.TreeItem {
    constructor(public readonly groupName: string, private readonly entries: FavoriteEntry[]) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${entries.length}`;
        this.contextValue = 'favoriteGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }

    getEntries(): FavoriteEntry[] {
        return this.entries;
    }
}

export class Favorite extends vscode.TreeItem {
    constructor(private readonly entry: FavoriteEntry) {
        super(entry.title, vscode.TreeItemCollapsibleState.None);
        const line = normalizeLineNumber(entry.line);
        const location = line !== undefined ? `${entry.path}:${line}` : entry.path;
        const descriptionParts: string[] = [];
        if (line !== undefined) {
            descriptionParts.push(`line ${line}`);
        }
        if (entry.tags && entry.tags.length > 0) {
            descriptionParts.push(entry.tags.join(', '));
        }
        this.tooltip = `${entry.title} - ${location}`;
        this.description = descriptionParts.length > 0 ? descriptionParts.join(' • ') : undefined;
        this.command = { command: 'taskhub.openFavoriteFile', title: 'Open Favorite File', arguments: [entry] };
        this.contextValue = 'favoriteItem';
        this.iconPath = new vscode.ThemeIcon('star');
    }

    getFilePath(): string {
        return this.entry.path;
    }

    getLine(): number | undefined {
        return this.entry.line;
    }

    getEntry(): FavoriteEntry {
        return this.entry;
    }

    getSourceFile(): string | undefined {
        return this.entry.sourceFile;
    }
}

/**
 * Return a new favorites list with the entry that identity-matches `target`
 * removed. "Identity" = same path + line (normalized) + title + group. Used
 * both by explicit delete and by the "file not found → remove from favorites"
 * affordance so both paths stay consistent.
 */
export function removeFavoriteByIdentity(favorites: FavoriteEntry[], target: FavoriteEntry): FavoriteEntry[] {
    const targetLine = normalizeLineNumber(target.line);
    return favorites.filter(f => {
        const line = normalizeLineNumber(f.line);
        const samePath = f.path === target.path;
        const sameLine = (line ?? null) === (targetLine ?? null);
        const sameTitle = f.title === target.title;
        const sameGroup = (f.group ?? null) === (target.group ?? null);
        return !(samePath && sameLine && sameTitle && sameGroup);
    });
}

export function loadFavoritesFromDisk(filePath: string, reportErrors: boolean, workspaceFolderPath?: string): FavoriteEntry[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.reduce<FavoriteEntry[]>((acc, item) => {
            if (item && typeof item.title === 'string' && typeof item.path === 'string') {
                const entry: FavoriteEntry = {
                    title: item.title,
                    path: item.path
                };
                const line = normalizeLineNumber(item.line);
                if (line !== undefined) {
                    entry.line = line;
                }
                const group = typeof item.group === 'string' ? item.group.trim() : '';
                if (group.length > 0) {
                    entry.group = group;
                }
                const tags = normalizeTags(item.tags);
                if (tags) {
                    entry.tags = tags;
                }
                entry.sourceFile = filePath;
                if (workspaceFolderPath) {
                    entry.workspaceFolder = workspaceFolderPath;
                }
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

export class FavoriteViewProvider implements vscode.TreeDataProvider<FavoriteTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<FavoriteTreeNode | undefined | null | void> = new vscode.EventEmitter<FavoriteTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FavoriteTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<FavoriteTreeNode> | undefined;
    private cachedFavorites: FavoriteEntry[] = [];
    // Distinguish "never loaded" from "loaded but empty" so ensureCache() does
    // not keep re-reading the JSON when the user genuinely has zero favorites.
    private loaded = false;

    constructor(
        private context: vscode.ExtensionContext,
        private readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] = () => vscode.workspace.workspaceFolders ?? []
    ) {
        // No disk I/O in the constructor. The first refresh() (e.g. from a file
        // watcher) or the first getChildren() call (when the view becomes
        // visible) performs the load — see ensureCache().
    }

    refresh(): void {
        this.cachedFavorites = this.loadFavorites();
        this.loaded = true;
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    private updateTitle(): void {
        if (this.view) {
            this.view.title = `Favorite Files (${this.cachedFavorites.length})`;
        }
    }

    private loadFavorites(): FavoriteEntry[] {
        const entries: FavoriteEntry[] = [];
        const folders = this.getWorkspaceFolders();
        for (const folder of folders) {
            const favoritesPath = path.join(folder.uri.fsPath, '.vscode', 'favorites.json');
            entries.push(...loadFavoritesFromDisk(favoritesPath, true, folder.uri.fsPath));
        }
        return entries;
    }

    private ensureCache(): void {
        if (!this.loaded) {
            this.cachedFavorites = this.loadFavorites();
            this.loaded = true;
            // First lazy load: also update the view title so that the "(N)"
            // count appears as soon as the user opens the sidebar.
            this.updateTitle();
        }
    }

    private sortEntries(entries: FavoriteEntry[]): FavoriteEntry[] {
        return [...entries].sort((a, b) => {
            const titleCompare = a.title.localeCompare(b.title);
            if (titleCompare !== 0) {
                return titleCompare;
            }
            const lineA = normalizeLineNumber(a.line) || 0;
            const lineB = normalizeLineNumber(b.line) || 0;
            return lineA - lineB;
        });
    }

    private buildRootNodes(): FavoriteTreeNode[] {
        this.ensureCache();
        const grouped = new Map<string, FavoriteEntry[]>();
        const ungrouped: FavoriteEntry[] = [];

        for (const entry of this.cachedFavorites) {
            const groupName = entry.group;
            if (groupName) {
                const bucket = grouped.get(groupName) ?? [];
                bucket.push(entry);
                grouped.set(groupName, bucket);
            } else {
                ungrouped.push(entry);
            }
        }

        const nodes: FavoriteTreeNode[] = [];
        const sortedGroupNames = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroupNames) {
            const entries = this.sortEntries(grouped.get(name)!);
            nodes.push(new FavoriteGroup(name, entries));
        }

        const sortedUngrouped = this.sortEntries(ungrouped);
        for (const entry of sortedUngrouped) {
            nodes.push(new Favorite(entry));
        }

        return nodes;
    }

    getTreeItem(element: FavoriteTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FavoriteTreeNode): Thenable<FavoriteTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.buildRootNodes());
        }

        if (element instanceof FavoriteGroup) {
            const children = element.getEntries().map(entry => new Favorite(entry));
            return Promise.resolve(children);
        }

        return Promise.resolve([]);
    }

    public getAllEntries(): FavoriteEntry[] {
        this.ensureCache();
        return [...this.cachedFavorites];
    }
}
