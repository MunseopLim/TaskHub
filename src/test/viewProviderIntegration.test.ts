import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { actionStates } from '../providers/actionStatus';
import { Favorite, FavoriteGroup, FavoriteViewProvider } from '../providers/favoriteViewProvider';
import { Link, LinkGroup, LinkViewProvider } from '../providers/linkViewProvider';
import { Action, Folder, MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem } from '../schema';

/**
 * Integration tests for TreeDataProviders backed by VS Code workspace state
 * and workspace JSON files. Scenario index lives in docs/integration-tests.md.
 */
suite('View provider integration', function () {
    this.timeout(15000);

    const extensionRoot = path.resolve(__dirname, '..', '..');
    let tempWorkspace: string | undefined;

    teardown(() => {
        actionStates.clear();
        if (tempWorkspace && fs.existsSync(tempWorkspace)) {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
            tempWorkspace = undefined;
        }
    });

    function labelOf(item: vscode.TreeItem): string | undefined {
        return typeof item.label === 'string' ? item.label : item.label?.label;
    }

    function makeContext(options?: { extensionPath?: string; workspaceState?: Map<string, unknown>; version?: string }): vscode.ExtensionContext {
        const workspaceState = options?.workspaceState ?? new Map<string, unknown>();
        return {
            extensionPath: options?.extensionPath ?? extensionRoot,
            subscriptions: [],
            workspaceState: {
                get: <T>(key: string, defaultValue?: T) =>
                    workspaceState.has(key) ? workspaceState.get(key) as T : defaultValue,
                update: (key: string, value: unknown) => {
                    workspaceState.set(key, value);
                    return Promise.resolve();
                },
                keys: () => Array.from(workspaceState.keys())
            },
            globalState: {
                get: <T>(_key: string, defaultValue?: T) => defaultValue,
                update: () => Promise.resolve(),
                keys: () => [],
                setKeysForSync: () => {}
            },
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: options?.version ?? '9.9.9-test' } }
        } as unknown as vscode.ExtensionContext;
    }

    function createWorkspace(): string {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-view-workspace-'));
        fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
        tempWorkspace = workspace;
        return workspace;
    }

    function makeWorkspaceFolder(workspace: string): vscode.WorkspaceFolder {
        return {
            uri: vscode.Uri.file(workspace),
            name: 'provider-ws',
            index: 0
        };
    }

    test('IT-021: LinkViewProvider는 workspace links.json을 lazy load하고 그룹/정렬/태그를 구성', async () => {
        const workspace = createWorkspace();
        const linksPath = path.join(workspace, '.vscode', 'links.json');
        fs.writeFileSync(linksPath, JSON.stringify([
            { title: 'Zeta', link: 'https://zeta.example', group: 'Docs', tags: [' zeta ', ''] },
            { title: 'Alpha', link: 'https://alpha.example', group: 'Docs', tags: [' stable '] },
            { title: 'Loose', link: 'https://loose.example', tags: [' misc '] }
        ], null, 2));

        const provider = new LinkViewProvider(makeContext(), 'workspace', () => [makeWorkspaceFolder(workspace)]);
        provider.view = { title: 'Workspace Links' } as vscode.TreeView<any>;

        const roots = await provider.getChildren();

        assert.strictEqual((provider.view as any).title, 'Workspace Links (3)');
        assert.strictEqual(roots.length, 2);
        assert.ok(roots[0] instanceof LinkGroup);
        assert.strictEqual(labelOf(roots[0]), 'Docs');
        assert.strictEqual(roots[0].description, '2');
        assert.ok(roots[1] instanceof Link);
        assert.strictEqual(labelOf(roots[1]), 'Loose');
        assert.strictEqual((roots[1] as Link).getLink(), 'https://loose.example');
        assert.strictEqual(roots[1].description, 'misc');

        const groupChildren = await provider.getChildren(roots[0]);
        assert.deepStrictEqual(groupChildren.map(item => labelOf(item)), ['Alpha', 'Zeta']);
        assert.strictEqual((groupChildren[0] as Link).getEntry().sourceFile, linksPath);
        assert.deepStrictEqual((groupChildren[0] as Link).getEntry().tags, ['stable']);
        assert.strictEqual(provider.getAllEntries().length, 3);
    });

    test('IT-022: FavoriteViewProvider는 workspace favorites.json을 lazy load하고 line/tags/workspace를 보존', async () => {
        const workspace = createWorkspace();
        const favoritesPath = path.join(workspace, '.vscode', 'favorites.json');
        fs.writeFileSync(favoritesPath, JSON.stringify([
            { title: 'Beta', path: path.join(workspace, 'beta.c'), group: 'Core', line: '3', tags: [' beta ', ''] },
            { title: 'Alpha', path: path.join(workspace, 'alpha.c'), group: 'Core', line: 1.9, tags: [' a '] },
            { title: 'Loose', path: path.join(workspace, 'loose.c'), line: 0, tags: [' solo '] }
        ], null, 2));

        const provider = new FavoriteViewProvider(makeContext(), () => [makeWorkspaceFolder(workspace)]);
        provider.view = { title: 'Favorite Files' } as vscode.TreeView<any>;

        const roots = await provider.getChildren();

        assert.strictEqual((provider.view as any).title, 'Favorite Files (3)');
        assert.strictEqual(roots.length, 2);
        assert.ok(roots[0] instanceof FavoriteGroup);
        assert.strictEqual(labelOf(roots[0]), 'Core');
        assert.strictEqual(roots[0].description, '2');
        assert.ok(roots[1] instanceof Favorite);
        assert.strictEqual(labelOf(roots[1]), 'Loose');
        assert.strictEqual((roots[1] as Favorite).getLine(), undefined);
        assert.strictEqual(roots[1].description, 'solo');

        const groupChildren = await provider.getChildren(roots[0]);
        assert.deepStrictEqual(groupChildren.map(item => labelOf(item)), ['Alpha', 'Beta']);
        const alpha = groupChildren[0] as Favorite;
        assert.strictEqual(alpha.getLine(), 1);
        assert.ok(String(alpha.description).includes('line 1'));
        assert.ok(String(alpha.description).includes('a'));
        assert.strictEqual(alpha.getEntry().sourceFile, favoritesPath);
        assert.strictEqual(alpha.getEntry().workspaceFolder, workspace);
        assert.strictEqual(provider.getAllEntries().length, 3);
    });

    test('IT-023: MainViewProvider는 version/folder/separator/action TreeItem을 상태와 함께 구성', async () => {
        const workspaceState = new Map<string, unknown>([['folderState:fw', true]]);
        const context = makeContext({ workspaceState, version: '1.2.3-test' });
        const actions: ActionItem[] = [
            {
                id: 'fw',
                title: 'Firmware',
                type: 'folder',
                children: [
                    {
                        id: 'build',
                        title: 'Build',
                        action: {
                            description: 'Build firmware',
                            tasks: [
                                { id: 'compile', type: 'shell', command: 'echo compile' },
                                { id: 'trim', type: 'stringManipulation', function: 'trim', input: 'x' }
                            ]
                        }
                    }
                ]
            },
            { id: 'sep', title: '---', type: 'separator' },
            {
                id: 'flash',
                title: 'Flash',
                action: {
                    description: 'Flash firmware',
                    tasks: [{ id: 'run', type: 'shell', command: 'echo flash' }]
                }
            }
        ];
        actionStates.set('flash', { state: 'success' });

        const provider = new MainViewProvider(context, () => actions);
        const roots = await provider.getChildren();

        assert.strictEqual(roots.length, 4);
        assert.strictEqual(labelOf(roots[0]), '1.2.3-test');
        assert.strictEqual(roots[0].contextValue, 'versionItem');
        assert.ok(roots[1] instanceof Folder);
        assert.strictEqual(labelOf(roots[1]), 'Firmware');
        assert.strictEqual(roots[1].collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(roots[2].contextValue, 'separator');
        assert.ok(roots[3] instanceof Action);
        assert.strictEqual(labelOf(roots[3]), 'Flash');
        assert.strictEqual(roots[3].contextValue, 'succeededAction');
        assert.strictEqual((roots[3].iconPath as vscode.ThemeIcon).id, 'check');

        const folderChildren = await provider.getChildren(roots[1]);
        assert.strictEqual(folderChildren.length, 1);
        assert.ok(folderChildren[0] instanceof Action);
        assert.strictEqual(labelOf(folderChildren[0]), 'Build');
        assert.strictEqual(folderChildren[0].contextValue, 'action');
        assert.strictEqual((folderChildren[0].iconPath as vscode.ThemeIcon).id, 'debug-alt');
        assert.strictEqual((folderChildren[0] as Action).command?.command, 'taskhub.executeAction');
    });
});
