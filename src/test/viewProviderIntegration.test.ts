import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { actionStates } from '../providers/actionStatus';
import { Favorite, FavoriteEntry, FavoriteGroup, FavoriteViewProvider, loadFavoritesFromDisk, removeFavoriteByIdentity } from '../providers/favoriteViewProvider';
import { buildActionCommandId, buildRunAnyActionPaletteItems, buildRunAnyActionPicks, planRunAnyAction, serializeFavorites, syncActionCommandsFromActions, updateRunAnyActionMru, RUN_ANY_ACTION_MRU_DEFAULT_LIMIT } from '../extension';
import { Link, LinkGroup, LinkViewProvider } from '../providers/linkViewProvider';
import { Action, Folder, MainViewProvider } from '../providers/mainViewProvider';
import { HistoryEntry, HistoryProvider } from '../providers/historyProvider';
import { ActionItem } from '../schema';

function normalizeWindowsPathForAssert(value: string): string {
    return process.platform === 'win32'
        ? value.replace(/\b([a-z]):\\/g, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
        : value;
}

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
        assert.strictEqual(
            normalizeWindowsPathForAssert((groupChildren[0] as Link).getEntry().sourceFile ?? ''),
            normalizeWindowsPathForAssert(linksPath)
        );
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
        assert.strictEqual(
            normalizeWindowsPathForAssert(alpha.getEntry().sourceFile ?? ''),
            normalizeWindowsPathForAssert(favoritesPath)
        );
        assert.strictEqual(
            normalizeWindowsPathForAssert(alpha.getEntry().workspaceFolder ?? ''),
            normalizeWindowsPathForAssert(workspace)
        );
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

    test('IT-068: HistoryItem.description에 status + 시각 + 소요 시간 배지가 노출됨', async () => {
        // Pins last-run badge placement: each rendered
        // HistoryItem carries a "last run" badge in its description slot.
        // Actions panel intentionally has no equivalent badge — the
        // user-facing "did it run today?" question is answered on the
        // history surface, where the data naturally lives.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        const now = Date.now();
        // newest-first via repeated addHistoryEntry (which unshifts).
        provider.addHistoryEntry({ actionId: 'old', actionTitle: 'Old', timestamp: now - 7_200_000, status: 'failure', output: 'boom' });
        provider.updateHistoryStatus('old', now - 7_200_000, 'failure', 'boom', 99);
        provider.addHistoryEntry({ actionId: 'flash', actionTitle: 'Flash', timestamp: now - 30_000, status: 'running' });
        provider.updateHistoryStatus('flash', now - 30_000, 'failure', 'broken', 45);
        provider.addHistoryEntry({ actionId: 'build', actionTitle: 'Build', timestamp: now - 60_000, status: 'running' });
        provider.updateHistoryStatus('build', now - 60_000, 'success', undefined, 1234);
        // Still-running entry — must NOT carry a badge.
        provider.addHistoryEntry({ actionId: 'live', actionTitle: 'Live', timestamp: now - 1_000, status: 'running' });

        const items = await provider.getChildren();
        const byId = new Map(items.map(i => [i.getEntry().actionId, i]));

        const buildItem = byId.get('build')!;
        assert.ok(typeof buildItem.description === 'string', 'build should have a description badge');
        assert.ok((buildItem.description as string).startsWith('✓'), `expected ✓ prefix, got ${buildItem.description}`);
        assert.ok((buildItem.description as string).includes('1.2s'), `expected duration "1.2s" in ${buildItem.description}`);

        const flashItem = byId.get('flash')!;
        assert.ok(typeof flashItem.description === 'string', 'flash should have a description badge');
        assert.ok((flashItem.description as string).startsWith('✗'), `expected ✗ prefix, got ${flashItem.description}`);
        assert.ok((flashItem.description as string).includes('45ms'), `expected duration "45ms" in ${flashItem.description}`);

        // Running entry: spinner-equivalent iconPath only, no description.
        const liveItem = byId.get('live')!;
        assert.strictEqual(liveItem.description, undefined);
    });

    test('IT-087: 같은 title 액션이 두 폴더에 있을 때 HistoryItem 라벨이 풀 경로로 disambiguate', async () => {
        // Pins history label disambiguation: when `Firmware/Build` and `Bootloader/Build`
        // both appear in history, both labels swap to `Firmware > Build` /
        // `Bootloader > Build` so the user can tell them apart. A non-colliding
        // entry alongside them keeps its bare title.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        provider.addHistoryEntry({
            actionId: 'fw.build',
            actionTitle: 'Build',
            timestamp: 1,
            status: 'success',
            actionPath: ['Firmware', 'Build']
        });
        provider.addHistoryEntry({
            actionId: 'bl.build',
            actionTitle: 'Build',
            timestamp: 2,
            status: 'success',
            actionPath: ['Bootloader', 'Build']
        });
        provider.addHistoryEntry({
            actionId: 'fw.flash',
            actionTitle: 'Flash',
            timestamp: 3,
            status: 'success',
            actionPath: ['Firmware', 'Flash']
        });

        const items = await provider.getChildren();
        const byId = new Map(items.map(i => [i.getEntry().actionId, i]));

        // Both colliding entries get the breadcrumb prefix...
        assert.strictEqual(labelOf(byId.get('fw.build')!), 'Firmware > Build');
        assert.strictEqual(labelOf(byId.get('bl.build')!), 'Bootloader > Build');
        // ...but the unique-title entry stays bare.
        assert.strictEqual(labelOf(byId.get('fw.flash')!), 'Flash');
    });

    test('IT-087b: 같은 액션을 여러 번 실행해도 disambiguation은 발동하지 않음', async () => {
        // Repeated runs of the SAME actionId share the title trivially —
        // disambiguating them would be pure noise. Only distinct actionIds
        // sharing a title constitutes a collision.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        provider.addHistoryEntry({
            actionId: 'fw.build',
            actionTitle: 'Build',
            timestamp: 1,
            status: 'success',
            actionPath: ['Firmware', 'Build']
        });
        provider.addHistoryEntry({
            actionId: 'fw.build',
            actionTitle: 'Build',
            timestamp: 2,
            status: 'failure',
            actionPath: ['Firmware', 'Build']
        });

        const items = await provider.getChildren();
        for (const item of items) {
            assert.strictEqual(labelOf(item), 'Build');
        }
    });

    test('IT-087d: 두 액션이 같은 actionPath를 가지면 라벨/툴팁 모두 (id) suffix로 disambiguate', async () => {
        // 동일 폴더 구조가 두 군데 존재(또는 rename 후 legacy entry)일 때,
        // path까지 동일한 entry 두 개가 history에 들어옴. step 1 만으로는
        // 둘 다 "Firmware > Build"로 남아 구분 불가 → step 2가 actionId
        // suffix를 붙여 라벨과 툴팁 모두 일관되게 disambiguate.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        provider.addHistoryEntry({
            actionId: 'fw1.build',
            actionTitle: 'Build',
            timestamp: 1,
            status: 'success',
            actionPath: ['Firmware', 'Build']
        });
        provider.addHistoryEntry({
            actionId: 'fw2.build',
            actionTitle: 'Build',
            timestamp: 2,
            status: 'success',
            actionPath: ['Firmware', 'Build']
        });

        const items = await provider.getChildren();
        const byId = new Map(items.map(i => [i.getEntry().actionId, i]));

        const item1 = byId.get('fw1.build')!;
        const item2 = byId.get('fw2.build')!;
        assert.strictEqual(labelOf(item1), 'Firmware > Build (fw1.build)');
        assert.strictEqual(labelOf(item2), 'Firmware > Build (fw2.build)');

        // 툴팁의 첫 줄도 disambiguated 라벨과 일치해야 함 — 두 row가 시각적으로
        // 구분되는데 hover 시 둘 다 "Firmware > Build"로 보이면 가드가 무의미.
        assert.ok(typeof item1.tooltip === 'string', 'tooltip should be a string');
        assert.ok((item1.tooltip as string).startsWith('Firmware > Build (fw1.build)\n'),
            `expected tooltip to lead with disambiguated label, got: ${item1.tooltip}`);
        assert.ok((item2.tooltip as string).startsWith('Firmware > Build (fw2.build)\n'),
            `expected tooltip to lead with disambiguated label, got: ${item2.tooltip}`);
    });

    test('IT-087c: 레거시 entry(actionPath 부재)는 충돌 시 `Title (actionId)`로 폴백', async () => {
        // Entries persisted before the actionPath field existed lack the
        // breadcrumb data. They can't render the path, but the
        // distinct-id invariant still holds — append actionId so the row
        // is visually distinct from the colliding new entry.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        provider.addHistoryEntry({
            actionId: 'old',
            actionTitle: 'Build',
            timestamp: 1,
            status: 'success'
            // no actionPath
        });
        provider.addHistoryEntry({
            actionId: 'new',
            actionTitle: 'Build',
            timestamp: 2,
            status: 'success',
            actionPath: ['Firmware', 'Build']
        });

        const items = await provider.getChildren();
        const byId = new Map(items.map(i => [i.getEntry().actionId, i]));
        assert.strictEqual(labelOf(byId.get('old')!), 'Build (old)');
        assert.strictEqual(labelOf(byId.get('new')!), 'Firmware > Build');
    });

    test('IT-087e: 두 root-level 액션이 같은 title을 가지면 라벨/툴팁 모두 (actionId) suffix로 disambiguate', async () => {
        // Pure root-level collision — neither entry has a usable
        // breadcrumb, so the id suffix is the only signal. Without this
        // fallback both rows would render as bare "Build" and look
        // identical, breaking the distinct-id invariant.
        const ctx = makeContext();
        const provider = new HistoryProvider(ctx);
        provider.addHistoryEntry({
            actionId: 'root.build.a',
            actionTitle: 'Build',
            timestamp: 1,
            status: 'success',
            actionPath: ['Build']
        });
        provider.addHistoryEntry({
            actionId: 'root.build.b',
            actionTitle: 'Build',
            timestamp: 2,
            status: 'success',
            actionPath: ['Build']
        });

        const items = await provider.getChildren();
        const byId = new Map(items.map(i => [i.getEntry().actionId, i]));

        const itemA = byId.get('root.build.a')!;
        const itemB = byId.get('root.build.b')!;
        assert.strictEqual(labelOf(itemA), 'Build (root.build.a)');
        assert.strictEqual(labelOf(itemB), 'Build (root.build.b)');

        // Tooltip path line tracks the disambiguated label so hover also
        // distinguishes the two rows.
        assert.ok(typeof itemA.tooltip === 'string', 'tooltip should be a string');
        assert.ok((itemA.tooltip as string).startsWith('Build (root.build.a)\n'),
            `expected tooltip to lead with disambiguated label, got: ${itemA.tooltip}`);
        assert.ok((itemB.tooltip as string).startsWith('Build (root.build.b)\n'),
            `expected tooltip to lead with disambiguated label, got: ${itemB.tooltip}`);
    });

    test('IT-072: 멀티 task 액션이 running일 때 Action TreeItem.description에 progress 표시', async () => {
        // Pins multi-task progress indicator: while a multi-task action is running, the
        // Action TreeItem renders `index/total · taskId` so the user can
        // tell "지금 어디" without opening the terminal. After the action
        // terminates, finalizeActionRun clears `progress` and the
        // description goes back to undefined (covered by IT-072b below).
        const context = makeContext();
        const actions: ActionItem[] = [
            {
                id: 'multi',
                title: 'Multi',
                action: {
                    description: 'multi',
                    tasks: [
                        { id: 'compile', type: 'shell', command: 'echo' },
                        { id: 'link', type: 'shell', command: 'echo' },
                        { id: 'package', type: 'shell', command: 'echo' }
                    ]
                }
            }
        ];
        actionStates.set('multi', {
            state: 'running',
            progress: { index: 2, total: 3, taskId: 'link' }
        });

        const provider = new MainViewProvider(context, () => actions);
        const roots = await provider.getChildren();
        const multiItem = roots[1] as Action;

        assert.strictEqual(multiItem.contextValue, 'runningAction');
        assert.strictEqual(multiItem.description, '2/3 · link');
    });

    test('IT-072b: 단일 task 액션은 running이어도 progress description을 채우지 않는다', async () => {
        // `1/1 · taskId` is pure noise — single-task pipelines have no
        // "지금 어디" question to answer.
        const context = makeContext();
        const actions: ActionItem[] = [
            {
                id: 'solo',
                title: 'Solo',
                action: {
                    description: 'solo',
                    tasks: [{ id: 'run', type: 'shell', command: 'echo' }]
                }
            }
        ];
        actionStates.set('solo', {
            state: 'running',
            progress: { index: 1, total: 1, taskId: 'run' }
        });

        const provider = new MainViewProvider(context, () => actions);
        const roots = await provider.getChildren();
        const soloItem = roots[1] as Action;

        assert.strictEqual(soloItem.contextValue, 'runningAction');
        assert.strictEqual(soloItem.description, undefined,
            'single-task action must not render the 1/1 progress noise');
    });

    test('IT-072c: progress가 없는 running 상태(legacy/manual)에서도 description은 비어 있다', async () => {
        // Defends against partially-populated actionStates from older
        // code paths that set state but skipped progress.
        const context = makeContext();
        const actions: ActionItem[] = [
            {
                id: 'partial',
                title: 'Partial',
                action: {
                    description: 'partial',
                    tasks: [
                        { id: 'a', type: 'shell', command: 'echo' },
                        { id: 'b', type: 'shell', command: 'echo' }
                    ]
                }
            }
        ];
        actionStates.set('partial', { state: 'running' });

        const provider = new MainViewProvider(context, () => actions);
        const roots = await provider.getChildren();
        const item = roots[1] as Action;

        assert.strictEqual(item.contextValue, 'runningAction');
        assert.strictEqual(item.description, undefined);
    });

    test('IT-068b: MainViewProvider가 history를 더 이상 읽지 않아 Action TreeItem에는 배지가 없다 (회귀 가드)', async () => {
        // Symmetric assertion to IT-068: badges live exclusively on the
        // History panel now. If a future refactor accidentally re-adds
        // a description on Action TreeItem (e.g. "오늘 빌드 됐었지?"
        // request reverts the move), this test catches it before it
        // ships.
        const context = makeContext();
        const actions: ActionItem[] = [
            {
                id: 'build',
                title: 'Build',
                action: { description: 'Build', tasks: [{ id: 'compile', type: 'shell', command: 'echo' }] }
            }
        ];
        const provider = new MainViewProvider(context, () => actions);
        const roots = await provider.getChildren();
        const buildItem = roots[1] as Action;
        assert.strictEqual(buildItem.description, undefined,
            'Action TreeItem must not render a last-run badge — that lives on HistoryItem');
    });

    suite('syncActionCommands (dynamic command registration)', () => {
        // Pins dynamic command registration: every action with an id is exposed as a
        // `taskhub.runAction.<id>` VS Code command so users can bind a key
        // from the native Keyboard Shortcuts UI. Folder/separator entries
        // intentionally have no command — they aren't runnable.
        //
        // Uses an isolated registry per test so we don't disturb the live
        // command registrations the activated extension owns.
        let testRegistry: Map<string, vscode.Disposable>;
        setup(() => {
            testRegistry = new Map<string, vscode.Disposable>();
        });
        teardown(() => {
            for (const disposable of testRegistry.values()) {
                disposable.dispose();
            }
            testRegistry.clear();
        });

        async function listRegisteredTestCommands(): Promise<string[]> {
            const all = await vscode.commands.getCommands(true);
            const ours = new Set(testRegistry.keys());
            return all.filter(c => ours.has(c));
        }

        test('IT-083: 액션마다 taskhub.runAction.<id>가 등록되고 folder/separator는 등록되지 않는다', async () => {
            const actions: ActionItem[] = [
                {
                    id: 'fw',
                    title: 'Firmware',
                    type: 'folder',
                    children: [
                        {
                            id: 'fw.build',
                            title: 'Build',
                            action: { description: 'Build', tasks: [{ id: 'compile', type: 'shell', command: 'echo' }] }
                        }
                    ]
                },
                { id: 'sep', title: '---', type: 'separator' },
                {
                    id: 'flash',
                    title: 'Flash',
                    action: { description: 'Flash', tasks: [{ id: 'run', type: 'shell', command: 'echo' }] }
                }
            ];

            syncActionCommandsFromActions(actions, testRegistry);

            const registered = await listRegisteredTestCommands();
            assert.ok(registered.includes('taskhub.runAction.fw.build'),
                `expected fw.build command, got: ${registered.join(', ')}`);
            assert.ok(registered.includes('taskhub.runAction.flash'),
                `expected flash command, got: ${registered.join(', ')}`);
            // Folder + separator have ids but no `action` — must not register.
            assert.ok(!testRegistry.has('taskhub.runAction.fw'),
                'folder must not be registered as a runnable command');
            assert.ok(!testRegistry.has('taskhub.runAction.sep'),
                'separator must not be registered as a runnable command');
        });

        test('IT-084: 액션이 actions.json에서 제거되면 해당 커맨드 등록은 dispose된다', async () => {
            const initial: ActionItem[] = [
                { id: 'a', title: 'A', action: { description: 'A', tasks: [{ id: 't', type: 'shell', command: 'echo' }] } },
                { id: 'b', title: 'B', action: { description: 'B', tasks: [{ id: 't', type: 'shell', command: 'echo' }] } }
            ];
            syncActionCommandsFromActions(initial, testRegistry);
            assert.ok(testRegistry.has('taskhub.runAction.a'));
            assert.ok(testRegistry.has('taskhub.runAction.b'));

            // Remove 'b' and re-sync.
            const reduced: ActionItem[] = [initial[0]];
            syncActionCommandsFromActions(reduced, testRegistry);

            const after = await listRegisteredTestCommands();
            assert.ok(after.includes('taskhub.runAction.a'),
                'surviving action keeps its command');
            assert.ok(!testRegistry.has('taskhub.runAction.b'),
                'removed action must dispose its command registration');
        });

        test('IT-085: 액션 id를 변경하면 옛 커맨드는 dispose되고 새 커맨드가 등록된다', async () => {
            syncActionCommandsFromActions([
                { id: 'old.id', title: 'Old', action: { description: 'X', tasks: [{ id: 't', type: 'shell', command: 'echo' }] } }
            ], testRegistry);
            assert.ok(testRegistry.has('taskhub.runAction.old.id'));

            // Same action, fresh id.
            syncActionCommandsFromActions([
                { id: 'new.id', title: 'New', action: { description: 'X', tasks: [{ id: 't', type: 'shell', command: 'echo' }] } }
            ], testRegistry);

            assert.ok(!testRegistry.has('taskhub.runAction.old.id'),
                'old id must be disposed');
            assert.ok(testRegistry.has('taskhub.runAction.new.id'),
                'new id must be registered');
            // Stable count: rename should not leak entries.
            assert.strictEqual(testRegistry.size, 1,
                'rename must not leak entries in the registry');
        });

        test('IT-086: command id 스킴은 bijective percent-encoding이며 동적 등록 / assignShortcut 양쪽이 같은 도출을 사용한다', () => {
            // The dynamic registration in `syncActionCommandsFromActions` and
            // the `taskhub.assignShortcut` handler both route through
            // `buildActionCommandId`. Pinning the contract here catches any
            // future drift (prefix rename, encoding change) before it
            // breaks user keybindings already saved against the old id.
            //
            // Common case — safe alphabet ids round-trip unchanged so user
            // keybindings.json reads naturally:
            assert.strictEqual(buildActionCommandId('fw.build'), 'taskhub.runAction.fw.build');
            assert.strictEqual(buildActionCommandId('flash'), 'taskhub.runAction.flash');
            assert.strictEqual(buildActionCommandId('default-button_v2'), 'taskhub.runAction.default-button_v2');
            // Unsafe chars — encoded as %HH so distinct ids stay distinct.
            // This is the load-bearing property: `a/b` and `a:b` MUST NOT
            // collide, otherwise Assign Shortcut would let the wrong action
            // run. (See 1차 리뷰 follow-up in CHANGELOG 0.4.23.)
            assert.strictEqual(buildActionCommandId('weird id'), 'taskhub.runAction.weird%20id');
            assert.strictEqual(buildActionCommandId('a/b'), 'taskhub.runAction.a%2Fb');
            assert.strictEqual(buildActionCommandId('a:b'), 'taskhub.runAction.a%3Ab');
            assert.notStrictEqual(buildActionCommandId('a/b'), buildActionCommandId('a:b'),
                'distinct unsafe ids must produce distinct command ids');
            // `%` itself is encoded so the scheme is unambiguously reversible.
            assert.strictEqual(buildActionCommandId('a%b'), 'taskhub.runAction.a%25b');
        });
    });

    suite('runAnyAction palette (build picks + MRU)', () => {
        // The palette is the single-command entry point for fuzzy-finding any
        // action (#9 on docs/roadmap.md). The handler is wired to VS Code's
        // QuickPick UI, but the *data* shaping is pure: pinning these helpers
        // keeps the visible behavior — recently-used on top, stale ids hidden,
        // folders/separators excluded — independent of UI changes.

        const sampleActions: ActionItem[] = [
            {
                id: 'fw',
                title: 'Firmware',
                type: 'folder',
                children: [
                    {
                        id: 'fw.build',
                        title: 'Build',
                        action: { description: 'Build', tasks: [{ id: 't', type: 'shell', command: 'echo' }] }
                    },
                    {
                        id: 'fw.flash',
                        title: 'Flash',
                        action: { description: 'Flash', tasks: [{ id: 't', type: 'shell', command: 'echo' }] }
                    }
                ]
            },
            { id: 'sep', title: '---', type: 'separator' },
            {
                id: 'top',
                title: 'Top-level Action',
                action: { description: 'Top', tasks: [{ id: 't', type: 'shell', command: 'echo' }] }
            }
        ];

        test('IT-088: folder/separator는 picks에서 제외되고 runnable action만 평면화된다', () => {
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, []);
            assert.strictEqual(recent.length, 0, 'no MRU → recent section empty');
            const ids = rest.map(p => p.actionId).sort();
            assert.deepStrictEqual(ids, ['fw.build', 'fw.flash', 'top'],
                'folder (fw) and separator (sep) must not appear; only items with .action are runnable');
        });

        test('IT-089: folderPath는 leaf 제외 breadcrumb 이고 root level은 빈 문자열', () => {
            const { rest } = buildRunAnyActionPicks(sampleActions, []);
            const byId = new Map(rest.map(p => [p.actionId, p]));
            assert.strictEqual(byId.get('fw.build')!.folderPath, 'Firmware',
                'nested action shows parent folder breadcrumb');
            assert.strictEqual(byId.get('top')!.folderPath, '',
                'root-level action has empty folder path');
        });

        test('IT-090: MRU 순서대로 recent 섹션이 채워지고 rest 에서는 제외된다', () => {
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['top', 'fw.build']);
            assert.deepStrictEqual(recent.map(p => p.actionId), ['top', 'fw.build'],
                'recent preserves MRU order, not tree order');
            assert.ok(recent.every(p => p.recent === true), 'recent picks must carry recent: true');
            assert.deepStrictEqual(rest.map(p => p.actionId), ['fw.flash'],
                'rest excludes anything already in recent');
        });

        test('IT-091: stale MRU 엔트리(삭제된 액션 / 폴더 id)는 조용히 누락된다', () => {
            // 'gone' was deleted from actions.json; 'fw' is a folder id (no .action).
            // Either would surface "execute something that does not exist" in the
            // palette if not filtered out at display time.
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['gone', 'fw', 'fw.build']);
            assert.deepStrictEqual(recent.map(p => p.actionId), ['fw.build'],
                'stale + folder ids are dropped; only resolvable runnable ids remain');
            assert.deepStrictEqual(rest.map(p => p.actionId).sort(), ['fw.flash', 'top']);
        });

        test('IT-092: MRU 내부 중복은 첫 등장만 유지된다', () => {
            const { recent } = buildRunAnyActionPicks(sampleActions, ['top', 'fw.build', 'top']);
            assert.deepStrictEqual(recent.map(p => p.actionId), ['top', 'fw.build'],
                'duplicate MRU entry must collapse to its first occurrence');
        });

        test('IT-093: updateRunAnyActionMru — 신규 id는 맨 앞에 추가된다', () => {
            const next = updateRunAnyActionMru([], 'fw.build');
            assert.deepStrictEqual(next, ['fw.build']);
        });

        test('IT-094: updateRunAnyActionMru — 기존 id는 맨 앞으로 이동하고 중복은 제거된다', () => {
            const next = updateRunAnyActionMru(['a', 'b', 'c'], 'b');
            assert.deepStrictEqual(next, ['b', 'a', 'c'],
                'most-recent moves to front; relative order of others preserved');
        });

        test('IT-095: updateRunAnyActionMru — 기본 cap 을 넘으면 가장 오래된 항목이 잘린다', () => {
            // Saturate well past the default so the cap path is exercised
            // regardless of what the default is set to (5 today, may change).
            const oversized = Array.from({ length: RUN_ANY_ACTION_MRU_DEFAULT_LIMIT + 5 }, (_, i) => `id${i}`);
            const next = updateRunAnyActionMru(oversized, 'new');
            assert.strictEqual(next.length, RUN_ANY_ACTION_MRU_DEFAULT_LIMIT,
                `MRU must cap at default (${RUN_ANY_ACTION_MRU_DEFAULT_LIMIT}) when no explicit max passed`);
            assert.strictEqual(next[0], 'new', 'newest entry sits at the head');
            assert.ok(!next.includes(oversized[oversized.length - 1]),
                'oldest entry is dropped past the cap');
        });

        test('IT-096: updateRunAnyActionMru — 명시적 max 인자가 default 를 override 한다', () => {
            // The setting `taskhub.runAnyAction.recentLimit` is wired through
            // by passing `max` explicitly at the call site. Pinning that the
            // explicit value overrides the default — otherwise narrowing the
            // setting from 5 → 3 would leak old entries past the user's choice.
            const next = updateRunAnyActionMru(['a', 'b', 'c', 'd'], 'new', 3);
            assert.deepStrictEqual(next, ['new', 'a', 'b'],
                'explicit max=3 must trim to 3, not the default');
        });

        test('IT-097: updateRunAnyActionMru — max=0 은 빈 배열을 반환한다 (recent 섹션 비활성)', () => {
            // Setting recentLimit=0 disables the "Recently used" section.
            // The pure helper has to honor that without producing a singleton
            // — otherwise the next palette open would still show one item.
            const next = updateRunAnyActionMru(['a', 'b'], 'new', 0);
            assert.deepStrictEqual(next, [],
                'max=0 must return [] so recentLimit=0 fully disables the section');
        });

        test('IT-098: stale id가 MRU 앞쪽을 채워도 valid 항목이 limit에 그대로 들어온다 (review P2)', () => {
            // Regression for the "slice-then-filter" bug: storage was
            // `[deleted×5, valid1, valid2]` with limit=5 → recent ended up [].
            // The fix filters stale ids first, *then* takes the limit, so the
            // user's last N runnable actions stay visible even after they
            // delete several actions in a row. Without this guarantee, the
            // palette's "Recently used" section silently empties out.
            const mru = ['gone1', 'gone2', 'gone3', 'gone4', 'gone5', 'fw.build', 'top'];
            const { recent } = buildRunAnyActionPicks(sampleActions, mru, 5);
            assert.deepStrictEqual(recent.map(p => p.actionId), ['fw.build', 'top'],
                'stale ids must be filtered before applying limit; valid ids must not be crowded out');
        });

        test('IT-099: buildRunAnyActionPicks — 명시적 recentLimit이 default를 override 하고 limit=0이면 recent 비활성', () => {
            // Two assertions in one: explicit limit narrowing, and limit=0
            // disabling the section entirely. Both pin the wiring used by the
            // `taskhub.runAnyAction.recentLimit` setting.
            const picks2 = buildRunAnyActionPicks(sampleActions, ['top', 'fw.build', 'fw.flash'], 2);
            assert.deepStrictEqual(picks2.recent.map(p => p.actionId), ['top', 'fw.build'],
                'explicit recentLimit=2 must trim to first 2 valid recent ids');
            assert.deepStrictEqual(picks2.rest.map(p => p.actionId), ['fw.flash'],
                'items past the limit fall through to rest, not recent');

            const picks0 = buildRunAnyActionPicks(sampleActions, ['top', 'fw.build'], 0);
            assert.strictEqual(picks0.recent.length, 0,
                'recentLimit=0 must produce no recent picks regardless of MRU contents');
            assert.strictEqual(picks0.rest.length, 3,
                'recentLimit=0 must route every runnable action into rest');
        });

        test('IT-100: buildRunAnyActionPaletteItems — recent 가 비어있으면 leading "All actions" separator 가 생기지 않는다 (review P3)', () => {
            // Regression for the leading-separator bug. With recentLimit=0 the
            // palette should be a single flat list (per docs); the prior code
            // emitted an "All actions" separator at the top with nothing
            // before it to disambiguate from.
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, [], 0);
            const items = buildRunAnyActionPaletteItems(recent, rest, {
                recent: 'Recently used',
                rest: 'All actions'
            });
            const separators = items.filter(i => i.kind === 'separator');
            assert.strictEqual(separators.length, 0,
                'with no recent picks the palette must render as a flat list — no leading "All actions" heading');
            assert.ok(items.every(i => i.kind === 'pick' && i.section === 'rest'),
                'all rendered rows must be runnable picks routed via the rest section');
        });

        test('IT-102: planRunAnyAction — actions.json broken (loader throws) → load-error outcome 으로 라우팅된다', () => {
            // Regression for the "broken actions.json" UX question. The
            // command must NOT swallow the error and show an empty palette;
            // it has to surface the loader's message so the user can see
            // which file failed and why. Mirrors what `loadAndValidateActions`
            // throws on JSON parse / schema-validation failure.
            const fakeError = new Error('Error parsing JSON in actions.json: Unexpected token } at position 42');
            const outcome = planRunAnyAction(
                () => { throw fakeError; },
                ['top'],
                5,
                { recent: 'Recently used', rest: 'All actions' }
            );
            assert.strictEqual(outcome.kind, 'load-error',
                'loader throws must produce a load-error outcome — never silently fall through to empty/show-palette');
            if (outcome.kind === 'load-error') {
                assert.match(outcome.errorMessage, /Error parsing JSON/,
                    'errorMessage must propagate the loader error so the toast can name the failure');
                assert.match(outcome.errorMessage, /position 42/,
                    'parser error detail (position) must reach the user-facing message');
            }
        });

        test('IT-103: planRunAnyAction — actions.json validation 실패도 load-error 로 묶인다 (schema/JSON 구분 없이 동일 surface)', () => {
            // The handler treats schema-validation failures the same as JSON
            // parse failures: both routed through showErrorMessage. Pinning
            // that the helper does not branch on error subtype keeps the
            // surface consistent for users (they always get a single toast).
            const outcome = planRunAnyAction(
                () => { throw new Error("Validation failed for actions.json:\n  - path: '/0/title' - message: must be string"); },
                [],
                5,
                { recent: 'R', rest: 'A' }
            );
            assert.strictEqual(outcome.kind, 'load-error');
            if (outcome.kind === 'load-error') {
                assert.match(outcome.errorMessage, /Validation failed/);
            }
        });

        test('IT-104: planRunAnyAction — loader 가 빈 배열을 반환하면 empty outcome (info 토스트로 라우팅)', () => {
            // Distinct from load-error: actions.json is missing/empty but
            // *valid*, so we want the friendlier "no runnable actions" toast,
            // not a scary error. The split is what lets the handler pick the
            // right vscode.window.show* call.
            const outcome = planRunAnyAction(() => [], ['stale'], 5, { recent: 'R', rest: 'A' });
            assert.strictEqual(outcome.kind, 'empty',
                'no actions loaded → empty outcome, NOT load-error');
        });

        test('IT-105: planRunAnyAction — happy path: items + recentIds + limit 가 핸들러로 전달된다', () => {
            // The handler relies on the helper to compute (a) the rendered
            // QuickPickItem plan, (b) the recentIds used as the MRU write base
            // (review feedback P2), and (c) the clamped limit. Pin all three.
            const outcome = planRunAnyAction(
                () => sampleActions,
                ['top', 'fw.build'],
                3,
                { recent: 'Recently used', rest: 'All actions' }
            );
            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind === 'show-palette') {
                assert.strictEqual(outcome.limit, 3, 'setting value passes through after clamp');
                assert.deepStrictEqual(outcome.recentIds, ['top', 'fw.build'],
                    'recentIds must be the displayed (filtered + capped) list, not raw stored MRU');
                // Plan starts with the Recently used separator, then the
                // recent picks, then the All actions separator + rest picks.
                assert.strictEqual(outcome.items[0].kind, 'separator');
                assert.strictEqual(outcome.items[0].label, 'Recently used');
            }
        });

        test('IT-106: planRunAnyAction — out-of-range setting 은 [0, MAX_LIMIT] 으로 클램프되고 NaN/undefined 는 default 로 폴백', () => {
            // Defensive: settings.json can be hand-edited past the schema's
            // 0–20 bounds, and `getConfiguration().get()` returns whatever is
            // there. The clamp prevents the pure helper from emitting a
            // 999-entry recent section or a negative slice that crashes.
            const tooHigh = planRunAnyAction(() => sampleActions, ['top', 'fw.build', 'fw.flash'], 999, { recent: 'R', rest: 'A' });
            if (tooHigh.kind !== 'show-palette') { assert.fail('expected show-palette'); }
            assert.ok(tooHigh.limit <= 20,
                'over-max setting must clamp down to MAX_LIMIT (20)');

            const negative = planRunAnyAction(() => sampleActions, ['top'], -5, { recent: 'R', rest: 'A' });
            if (negative.kind !== 'show-palette') { assert.fail('expected show-palette'); }
            assert.strictEqual(negative.limit, 0,
                'negative setting clamps to 0 (= recent section disabled)');
            assert.strictEqual(negative.recentIds.length, 0,
                'limit=0 must produce no recentIds');

            const nanish = planRunAnyAction(() => sampleActions, ['top'], NaN, { recent: 'R', rest: 'A' });
            if (nanish.kind !== 'show-palette') { assert.fail('expected show-palette'); }
            assert.strictEqual(nanish.limit, RUN_ANY_ACTION_MRU_DEFAULT_LIMIT,
                'NaN falls back to the default rather than producing 0/NaN-driven slicing');
        });

        test('IT-107: buildRunAnyActionPaletteItems — recent 와 rest 가 모두 있으면 두 separator 가 정확한 순서로 들어간다', () => {
            // Pinning the "happy path" so a future refactor of section order
            // / labels is caught immediately. The Recently used heading must
            // sit at index 0 and the All actions heading must precede the
            // first non-recent pick.
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['top'], 5);
            const items = buildRunAnyActionPaletteItems(recent, rest, {
                recent: 'Recently used',
                rest: 'All actions'
            });
            assert.strictEqual(items[0].kind, 'separator');
            assert.strictEqual(items[0].label, 'Recently used');
            assert.strictEqual(items[0].section, 'recent');

            const restSeparatorIdx = items.findIndex(i => i.kind === 'separator' && i.section === 'rest');
            assert.ok(restSeparatorIdx > 0, 'rest separator must come after the recent section');
            assert.strictEqual(items[restSeparatorIdx].label, 'All actions');
            assert.ok(items.slice(restSeparatorIdx + 1).every(i => i.kind === 'pick' && i.section === 'rest'),
                'every row after the rest separator must be a rest pick');
        });
    });

    suite('removeFavoriteByIdentity (stale favorite removal)', () => {
        test('IT-039: 존재하지 않는 파일을 가리키는 항목만 제거되고 나머지는 원본 순서/내용 보존', async () => {
            const workspace = createWorkspace();
            const favoritesPath = path.join(workspace, '.vscode', 'favorites.json');
            fs.writeFileSync(path.join(workspace, 'exists.md'), 'hello');
            fs.writeFileSync(favoritesPath, JSON.stringify([
                { title: 'Readme', path: '${workspaceFolder}/exists.md', group: 'Docs' },
                { title: 'Missing', path: '${workspaceFolder}/scripts/missing.sh', group: 'Scripts' },
                { title: 'Example', path: '${workspaceFolder}/example.cfg', tags: ['cfg'] }
            ], null, 2));

            const favorites = loadFavoritesFromDisk(favoritesPath, true, workspace);
            assert.strictEqual(favorites.length, 3);
            const stale = favorites.find(f => f.title === 'Missing')!;

            const filtered = removeFavoriteByIdentity(favorites, stale);

            assert.strictEqual(filtered.length, 2);
            fs.writeFileSync(favoritesPath, JSON.stringify(serializeFavorites(filtered), null, 2) + '\n');

            const reloaded = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8'));
            assert.deepStrictEqual(reloaded.map((f: any) => f.title), ['Readme', 'Example']);
            assert.strictEqual(reloaded[0].group, 'Docs');
            assert.deepStrictEqual(reloaded[1].tags, ['cfg']);
        });

        test('IT-040: path + title 이 같지만 line 이 다른 두 항목 중 target 만 제거', () => {
            const workspace = createWorkspace();
            const favoritesPath = path.join(workspace, '.vscode', 'favorites.json');
            const commonPath = path.join(workspace, 'src', 'main.c');
            fs.writeFileSync(favoritesPath, JSON.stringify([
                { title: 'Init', path: commonPath, line: 10 },
                { title: 'Init', path: commonPath, line: 42 }
            ], null, 2));

            const favorites = loadFavoritesFromDisk(favoritesPath, true, workspace);
            const target: FavoriteEntry = favorites.find(f => f.line === 42)!;
            const filtered = removeFavoriteByIdentity(favorites, target);

            assert.strictEqual(filtered.length, 1);
            assert.strictEqual(filtered[0].line, 10);
        });

        test('IT-041: 존재하지 않는 target 은 no-op (길이/내용 변화 없음)', () => {
            const workspace = createWorkspace();
            const favoritesPath = path.join(workspace, '.vscode', 'favorites.json');
            fs.writeFileSync(favoritesPath, JSON.stringify([
                { title: 'Readme', path: '${workspaceFolder}/exists.md' }
            ], null, 2));

            const favorites = loadFavoritesFromDisk(favoritesPath, true, workspace);
            const ghost: FavoriteEntry = { title: 'Ghost', path: '${workspaceFolder}/nope.md' };

            const filtered = removeFavoriteByIdentity(favorites, ghost);

            assert.strictEqual(filtered.length, favorites.length);
            assert.strictEqual(filtered[0].title, 'Readme');
        });

        test('IT-042: 같은 path·title 이어도 group 이 다르면 보존', () => {
            const workspace = createWorkspace();
            const favoritesPath = path.join(workspace, '.vscode', 'favorites.json');
            const commonPath = path.join(workspace, 'config.toml');
            fs.writeFileSync(favoritesPath, JSON.stringify([
                { title: 'Config', path: commonPath, group: 'Dev' },
                { title: 'Config', path: commonPath, group: 'Prod' }
            ], null, 2));

            const favorites = loadFavoritesFromDisk(favoritesPath, true, workspace);
            const devTarget = favorites.find(f => f.group === 'Dev')!;
            const filtered = removeFavoriteByIdentity(favorites, devTarget);

            assert.strictEqual(filtered.length, 1);
            assert.strictEqual(filtered[0].group, 'Prod');
        });
    });
});
