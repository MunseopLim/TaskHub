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
import { InvalidJsonEntry } from './linkViewProvider';

export interface FavoriteEntry {
    title: string;
    path: string;
    line?: number;
    group?: string;
    tags?: string[];
    sourceFile?: string;
    workspaceFolder?: string;
    /** 디스크에서 읽은 원본 객체. `LinkEntry.raw` 와 같은 규약 — 그 주석 참조. */
    raw?: unknown;
    /** 이번 작업에서 편집했는가. `LinkEntry.edited` 주석 참조. */
    edited?: true;
}

export type FavoriteTreeNode = Favorite | FavoriteGroup | FavoriteParseError;

/**
 * 파싱에 실패한 파일을 트리에 남긴다. 근거는 `LinkParseError` 와 같다 —
 * 실패를 빈 배열로 바꾸면 "즐겨찾기가 없는 상태"와 구분되지 않고 빈 상태
 * CTA 까지 떠서, 고쳐야 할 JSON 이 있다는 사실이 사라진다.
 */
export class FavoriteParseError extends vscode.TreeItem {
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
        this.contextValue = 'favoriteParseError';
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    }
}

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

/**
 * Tree-side loader. Mirrors {@link loadLinksFromDisk}'s forgiving contract:
 * on parse failure, log + (optionally) toast + return `[]` so the tree
 * keeps rendering. Write-side callers MUST use {@link readFavoritesFromDisk}
 * instead — see the equivalent rationale on the link side.
 */
export function loadFavoritesFromDisk(filePath: string, reportErrors: boolean, workspaceFolderPath?: string): FavoriteEntry[] {
    const result = readFavoritesFromDisk(filePath, workspaceFolderPath);
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

export type FavoritesLoadResult =
    | { ok: true; entries: FavoriteEntry[]; invalid: InvalidJsonEntry[] }
    | { ok: false; error: string };

/**
 * Write-safe loader. See {@link readLinksFromDisk} for the rationale —
 * tagged result distinguishes "no entries" from "parse failure" so add /
 * delete / edit commands can refuse to overwrite a corrupt favorites.json.
 */
export function readFavoritesFromDisk(filePath: string, workspaceFolderPath?: string): FavoritesLoadResult {
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
    const entries: FavoriteEntry[] = [];
    const invalid: InvalidJsonEntry[] = [];
    parsed.forEach((item, index) => {
        if (item && typeof (item as any).title === 'string' && typeof (item as any).path === 'string') {
            const cast = item as any;
            const entry: FavoriteEntry = {
                title: cast.title,
                path: cast.path
            };
            const line = normalizeLineNumber(cast.line);
            if (line !== undefined) {
                entry.line = line;
            }
            const group = typeof cast.group === 'string' ? cast.group.trim() : '';
            if (group.length > 0) {
                entry.group = group;
            }
            const tags = normalizeTags(cast.tags);
            if (tags) {
                entry.tags = tags;
            }
            entry.raw = item;
            entry.sourceFile = filePath;
            if (workspaceFolderPath) {
                entry.workspaceFolder = workspaceFolderPath;
            }
            entries.push(entry);
            return;
        }
        // links.json 과 같은 이유로 버리지 않는다 — 걸러 낸 배열을 되쓰면
        // 사용자가 지운 적 없는 항목이 영구히 사라진다.
        invalid.push({ index, raw: item });
    });
    return { ok: true, entries, invalid };
}

export class FavoriteViewProvider implements vscode.TreeDataProvider<FavoriteTreeNode>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<FavoriteTreeNode | undefined | null | void> = new vscode.EventEmitter<FavoriteTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FavoriteTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<FavoriteTreeNode> | undefined;
    private cachedFavorites: FavoriteEntry[] = [];
    /** 이번 로드에서 파싱에 실패한 파일들. 트리에 오류 행으로 나타난다. */
    private parseFailures: { filePath: string; message: string }[] = [];
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

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    private updateTitle(): void {
        if (this.view) {
            this.view.title = t(
                `즐겨찾는 파일 (${this.cachedFavorites.length})`,
                `Favorite Files (${this.cachedFavorites.length})`
            );
        }
    }

    private loadFavorites(): FavoriteEntry[] {
        const entries: FavoriteEntry[] = [];
        this.parseFailures = [];
        const folders = this.getWorkspaceFolders();
        for (const folder of folders) {
            const favoritesPath = path.join(folder.uri.fsPath, '.vscode', 'favorites.json');
            const result = readFavoritesFromDisk(favoritesPath, folder.uri.fsPath);
            if (result.ok) {
                entries.push(...result.entries);
            } else {
                console.error(`Error parsing ${favoritesPath}: ${result.error}`);
                this.parseFailures.push({ filePath: favoritesPath, message: result.error });
                vscode.window.showErrorMessage(t(
                    `${path.basename(favoritesPath)} 파싱 오류: ${result.error}`,
                    `Error parsing ${path.basename(favoritesPath)}: ${result.error}`
                ));
            }
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
        // 오류를 맨 위에 둔다 — 목록을 훑기 전에 보여야 한다.
        for (const failure of this.parseFailures) {
            nodes.push(new FavoriteParseError(failure.filePath, failure.message));
        }
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
