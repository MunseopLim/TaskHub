import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    DIALOG_SCOPE,
    DialogMemoryDeps,
    coerceDefaultUri,
    defaultDialogMemoryDeps,
    directoryToRemember,
    initDialogMemory,
    showOpenDialogWithMemory,
    showSaveDialogWithMemory,
    taskDialogScope,
} from '../dialogMemory';

/**
 * 디스크를 건드리지 않는 합성 경로. `firstUsableDir`가 절대 경로만 받으므로
 * 플랫폼별 루트를 붙여 만든다.
 */
const ROOT = process.platform === 'win32' ? 'C:\\dlgmem' : '/dlgmem';
const dir = (...segments: string[]) => path.join(ROOT, ...segments);

/**
 * `vscode.Uri.file()`은 Windows에서 드라이브 문자를 소문자로 정규화하므로
 * (`C:\a` → `c:\a`) 경로 비교와 fake 저장소 조회는 대소문자를 무시한다.
 */
function normalizePath(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function assertSamePath(actual: string | undefined, expected: string | undefined, message?: string): void {
    const normalize = (value: string | undefined) => value === undefined ? undefined : normalizePath(value);
    assert.strictEqual(normalize(actual), normalize(expected), message);
}

interface FakeEnv {
    deps: DialogMemoryDeps;
    /** scope → 기억된 디렉터리. 테스트가 직접 읽고 쓴다. */
    stored: Map<string, string>;
    openCalls: vscode.OpenDialogOptions[];
    saveCalls: vscode.SaveDialogOptions[];
}

function makeFakeEnv(overrides: {
    dirs?: string[];
    files?: string[];
    remembered?: Record<string, string>;
    fallbackDir?: string;
    openResult?: vscode.Uri[];
    saveResult?: vscode.Uri;
    /** `taskhub.dialog.rememberLastLocation`. 지정하지 않으면 켜진 것으로 본다. */
    enabled?: boolean;
} = {}): FakeEnv {
    const dirs = new Set((overrides.dirs ?? []).map(normalizePath));
    const files = new Set((overrides.files ?? []).map(normalizePath));
    const stored = new Map<string, string>(Object.entries(overrides.remembered ?? {}));
    const openCalls: vscode.OpenDialogOptions[] = [];
    const saveCalls: vscode.SaveDialogOptions[] = [];

    const deps: DialogMemoryDeps = {
        showOpenDialog: (options) => {
            openCalls.push(options);
            return Promise.resolve(overrides.openResult);
        },
        showSaveDialog: (options) => {
            saveCalls.push(options);
            return Promise.resolve(overrides.saveResult);
        },
        isDirectory: (dirPath) => dirs.has(normalizePath(dirPath)),
        exists: (targetPath) => dirs.has(normalizePath(targetPath)) || files.has(normalizePath(targetPath)),
        recall: (scope) => stored.get(scope),
        remember: (scope, value) => { stored.set(scope, value); },
        workspaceFallbackDir: () => overrides.fallbackDir,
        isEnabled: () => overrides.enabled !== false,
    };

    return { deps, stored, openCalls, saveCalls };
}

suite('dialogMemory', () => {

    suite('showOpenDialogWithMemory - 시작 위치 결정', () => {
        test('기억된 위치가 없으면 워크스페이스 폴더에서 연다', async () => {
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace], fallbackDir: workspace });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, { canSelectMany: false }, env.deps);

            assert.strictEqual(env.openCalls.length, 1);
            assertSamePath(env.openCalls[0].defaultUri?.fsPath, workspace);
        });

        test('기억된 위치가 워크스페이스 폴백보다 우선한다', async () => {
            const workspace = dir('workspace');
            const lastUsed = dir('build', 'output');
            const env = makeFakeEnv({
                dirs: [workspace, lastUsed],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.hexViewer]: lastUsed },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, lastUsed);
        });

        test('기억된 폴더가 사라졌으면 워크스페이스 폴백으로 내려간다', async () => {
            const workspace = dir('workspace');
            const removed = dir('gone');
            // `removed`를 dirs에 넣지 않는다 = 디스크에서 삭제된 상태.
            const env = makeFakeEnv({
                dirs: [workspace],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.hexViewer]: removed },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, workspace);
        });

        test('후보가 하나도 없으면 defaultUri 없이 호출한다 (VS Code 기본 동작)', async () => {
            const env = makeFakeEnv({ remembered: { [DIALOG_SCOPE.hexViewer]: dir('gone') } });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(env.openCalls[0].defaultUri, undefined);
            assert.strictEqual('defaultUri' in env.openCalls[0], false, 'defaultUri 키 자체가 남지 않아야 한다');
        });

        test('호출자가 지정한 defaultUri가 존재하면 기억된 위치를 덮어쓰지 않는다', async () => {
            const workspace = dir('workspace');
            const lastUsed = dir('build');
            const explicit = dir('vendor', 'sdk');
            const env = makeFakeEnv({
                dirs: [workspace, lastUsed, explicit],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.hexViewer]: lastUsed },
            });

            await showOpenDialogWithMemory(
                DIALOG_SCOPE.hexViewer,
                { defaultUri: vscode.Uri.file(explicit) },
                env.deps
            );

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, explicit);
        });

        test('호출자가 지정한 defaultUri가 존재하지 않으면 기억된 위치로 폴백한다', async () => {
            const lastUsed = dir('build');
            const env = makeFakeEnv({
                dirs: [lastUsed],
                remembered: { [DIALOG_SCOPE.hexViewer]: lastUsed },
            });

            await showOpenDialogWithMemory(
                DIALOG_SCOPE.hexViewer,
                { defaultUri: vscode.Uri.file(dir('nonexistent')) },
                env.deps
            );

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, lastUsed);
        });

        test('options의 나머지 필드는 그대로 전달된다', async () => {
            const env = makeFakeEnv();

            await showOpenDialogWithMemory(
                DIALOG_SCOPE.jsonEditor,
                { canSelectMany: false, openLabel: 'Open JSON File', filters: { 'JSON Files': ['json'] } },
                env.deps
            );

            assert.strictEqual(env.openCalls[0].canSelectMany, false);
            assert.strictEqual(env.openCalls[0].openLabel, 'Open JSON File');
            assert.deepStrictEqual(env.openCalls[0].filters, { 'JSON Files': ['json'] });
        });

        test('원격/가상 FS의 defaultUri는 존재 확인 없이 그대로 넘긴다', async () => {
            // node fs로는 stat할 수 없어 검사하면 무조건 실패한다. 그대로
            // 버리면 원격 워크스페이스에서 작성자가 지정한 경로가 조용히 사라진다.
            const remote = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/dev/fw');
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace], fallbackDir: workspace });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, { defaultUri: remote }, env.deps);

            assert.strictEqual(
                env.openCalls[0].defaultUri?.toString(),
                remote.toString(),
                '워크스페이스 폴백이 원격 경로를 덮어썼다'
            );
        });

        test('존재하지 않는 file 경로는 종전대로 폴백한다', async () => {
            // 위 완화가 file scheme까지 풀어 버리면, 오래된 defaultUri를 가진
            // 액션이 늘 존재하지 않는 폴더에서 열리게 된다.
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace], fallbackDir: workspace });

            await showOpenDialogWithMemory(
                DIALOG_SCOPE.hexViewer,
                { defaultUri: vscode.Uri.file(dir('gone', 'missing')) },
                env.deps
            );

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, workspace);
        });
    });

    /**
     * `rememberLastLocation`을 끈 상태 (0.6.30).
     *
     * 0.6.11~0.6.29는 이 설정을 `recall`/`remember` 안쪽에서만 확인했다. 그래서
     * 꺼도 `workspaceFallbackDir()`가 그대로 적용돼 TaskHub는 여전히
     * `defaultUri`를 지정하고 있었다 — 설정 설명(package.json / features.md
     * §21·§25 / CHANGELOG)이 한목소리로 약속한 "VS Code 자체의 최근 경로"는
     * 어느 경우에도 쓰이지 않았다. 기존 OFF 테스트는 `recall`/`remember`만
     * 검사해 이 부분을 보지 못했다.
     */
    suite('rememberLastLocation OFF', () => {
        test('기억된 위치도 워크스페이스 폴백도 쓰지 않는다 (defaultUri 자체를 넣지 않음)', async () => {
            const workspace = dir('workspace');
            const lastUsed = dir('build', 'output');
            const env = makeFakeEnv({
                enabled: false,
                dirs: [workspace, lastUsed],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.hexViewer]: lastUsed },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(
                env.openCalls[0].defaultUri,
                undefined,
                'TaskHub가 위치를 지정하면 VS Code 자체 최근 경로가 쓰일 수 없다'
            );
        });

        test('액션 JSON이 명시한 defaultUri는 꺼도 존중한다', async () => {
            const authored = dir('firmware');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                enabled: false,
                dirs: [authored, workspace],
                fallbackDir: workspace,
            });

            await showOpenDialogWithMemory(
                taskDialogScope('file', { actionId: 'flash', id: 'pick' }),
                { defaultUri: vscode.Uri.file(authored) },
                env.deps
            );

            assertSamePath(
                env.openCalls[0].defaultUri?.fsPath,
                authored,
                '작성자가 액션에 적은 시작 위치는 TaskHub의 추측이 아니라 지시다'
            );
        });

        test('저장 대화상자는 폴더를 비우고 파일명만 제안한다', async () => {
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                enabled: false,
                dirs: [workspace],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.actionsExport]: workspace },
            });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                { defaultDir: workspace },
                env.deps
            );

            assert.strictEqual(
                env.saveCalls[0].defaultUri?.fsPath.replace(/^[/\\]/, ''),
                'actions.taskhub',
                '폴더가 남아 있으면 VS Code 최근 경로 대신 그 폴더가 열린다'
            );
        });

        test('file이 아닌 scheme의 defaultUri도 꺼진 상태에서 살아남는다', async () => {
            const env = makeFakeEnv({ enabled: false, dirs: [dir('workspace')], fallbackDir: dir('workspace') });
            const remote = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/dev/fw');

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, { defaultUri: remote }, env.deps);

            assert.strictEqual(env.openCalls[0].defaultUri?.toString(), remote.toString());
        });

        test('켜져 있을 때와 결과가 실제로 다르다 (설정이 무의미해지지 않았는지)', async () => {
            const workspace = dir('workspace');
            const on = makeFakeEnv({ dirs: [workspace], fallbackDir: workspace });
            const off = makeFakeEnv({ enabled: false, dirs: [workspace], fallbackDir: workspace });

            await showOpenDialogWithMemory(DIALOG_SCOPE.jsonEditor, {}, on.deps);
            await showOpenDialogWithMemory(DIALOG_SCOPE.jsonEditor, {}, off.deps);

            assertSamePath(on.openCalls[0].defaultUri?.fsPath, workspace);
            assert.strictEqual(off.openCalls[0].defaultUri, undefined);
        });
    });

    suite('showOpenDialogWithMemory - 선택 결과 기억', () => {
        test('파일을 고르면 그 파일이 있던 폴더를 기억한다', async () => {
            const picked = path.join(dir('build'), 'firmware.hex');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(picked)] });

            const result = await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(result?.length, 1);
            assertSamePath(env.stored.get(DIALOG_SCOPE.hexViewer), path.dirname(vscode.Uri.file(picked).fsPath));
        });

        test('폴더 선택 다이얼로그는 고른 폴더 자체를 기억한다', async () => {
            const picked = dir('artifacts');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(picked)] });

            await showOpenDialogWithMemory(
                'task.folderDialog:a/b',
                { canSelectFiles: false, canSelectFolders: true },
                env.deps
            );

            assertSamePath(env.stored.get('task.folderDialog:a/b'), vscode.Uri.file(picked).fsPath);
        });

        test('canSelectFiles가 함께 켜진 다이얼로그는 파일 기준(상위 폴더)으로 기억한다', async () => {
            const picked = path.join(dir('mixed'), 'thing');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(picked)] });

            await showOpenDialogWithMemory(
                'mixed.scope',
                { canSelectFiles: true, canSelectFolders: true },
                env.deps
            );

            assertSamePath(env.stored.get('mixed.scope'), path.dirname(vscode.Uri.file(picked).fsPath));
        });

        test('다중 선택은 첫 항목을 기준으로 기억한다', async () => {
            const first = path.join(dir('src'), 'a.c');
            const second = path.join(dir('other'), 'b.c');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(first), vscode.Uri.file(second)] });

            await showOpenDialogWithMemory(DIALOG_SCOPE.favoriteFile, { canSelectMany: true }, env.deps);

            assertSamePath(env.stored.get(DIALOG_SCOPE.favoriteFile), path.dirname(vscode.Uri.file(first).fsPath));
        });

        test('취소하면 기억을 갱신하지 않는다', async () => {
            const lastUsed = dir('build');
            const env = makeFakeEnv({
                dirs: [lastUsed],
                remembered: { [DIALOG_SCOPE.hexViewer]: lastUsed },
                openResult: undefined,
            });

            const result = await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(result, undefined);
            assertSamePath(env.stored.get(DIALOG_SCOPE.hexViewer), lastUsed);
        });

        test('scope가 다르면 위치를 공유하지 않는다', async () => {
            const picked = path.join(dir('elf'), 'app.axf');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(picked)] });

            await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapBinary, {}, env.deps);

            assert.ok(env.stored.has(DIALOG_SCOPE.memoryMapBinary));
            assert.strictEqual(env.stored.has(DIALOG_SCOPE.hexViewer), false);
        });
    });

    suite('showSaveDialogWithMemory', () => {
        test('기억된 폴더 + 제안된 파일명을 합쳐 defaultUri를 만든다', async () => {
            const lastUsed = dir('release');
            const env = makeFakeEnv({
                dirs: [lastUsed, dir('workspace')],
                fallbackDir: dir('workspace'),
                remembered: { [DIALOG_SCOPE.actionsExport]: lastUsed },
            });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                { defaultDir: dir('workspace') },
                env.deps
            );

            assertSamePath(env.saveCalls[0].defaultUri?.fsPath, path.join(lastUsed, 'actions.taskhub'));
        });

        test('기억이 없으면 defaultDir을 쓴다', async () => {
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace] });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                { defaultDir: workspace },
                env.deps
            );

            assertSamePath(env.saveCalls[0].defaultUri?.fsPath, path.join(workspace, 'actions.taskhub'));
        });

        test('defaultDir이 없으면 워크스페이스 폴백을 쓴다', async () => {
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace], fallbackDir: workspace });

            await showSaveDialogWithMemory(DIALOG_SCOPE.presetSave, 'preset-hil.json', {}, env.deps);

            assertSamePath(env.saveCalls[0].defaultUri?.fsPath, path.join(workspace, 'preset-hil.json'));
        });

        test('쓸 수 있는 폴더가 없으면 파일명만 제안한다', async () => {
            // 존재하는 디렉터리도, 워크스페이스 폴백도 없는 상태.
            const env = makeFakeEnv();

            await showSaveDialogWithMemory(DIALOG_SCOPE.presetSave, 'preset-hil.json', {}, env.deps);

            assert.strictEqual(
                path.basename(env.saveCalls[0].defaultUri!.fsPath),
                'preset-hil.json'
            );
        });

        test('저장한 폴더를 기억한다', async () => {
            const saved = path.join(dir('release'), 'actions.taskhub');
            const env = makeFakeEnv({ saveResult: vscode.Uri.file(saved) });

            const result = await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                {},
                env.deps
            );

            assert.ok(result);
            assertSamePath(env.stored.get(DIALOG_SCOPE.actionsExport), path.dirname(vscode.Uri.file(saved).fsPath));
        });

        test('취소하면 기억하지 않는다', async () => {
            const env = makeFakeEnv({ saveResult: undefined });

            const result = await showSaveDialogWithMemory(DIALOG_SCOPE.actionsExport, 'actions.taskhub', {}, env.deps);

            assert.strictEqual(result, undefined);
            assert.strictEqual(env.stored.size, 0);
        });

        test('filters 등 나머지 옵션은 전달하고 defaultDir은 전달하지 않는다', async () => {
            const workspace = dir('workspace');
            const env = makeFakeEnv({ dirs: [workspace] });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                { filters: { 'TaskHub Export': ['taskhub'] }, defaultDir: workspace },
                env.deps
            );

            assert.deepStrictEqual(env.saveCalls[0].filters, { 'TaskHub Export': ['taskhub'] });
            assert.strictEqual((env.saveCalls[0] as Record<string, unknown>).defaultDir, undefined);
        });
    });

    suite('coerceDefaultUri', () => {
        test('문자열 경로를 file Uri로 승격한다 (액션 JSON의 defaultUri)', () => {
            const uri = coerceDefaultUri(dir('proj'));
            assert.strictEqual(uri?.scheme, 'file');
            assertSamePath(uri?.fsPath, vscode.Uri.file(dir('proj')).fsPath);
        });

        test('이미 Uri면 그대로 돌려준다', () => {
            const original = vscode.Uri.file(dir('proj'));
            assert.strictEqual(coerceDefaultUri(original), original);
        });

        test('`scheme://` 형태만 URI로 parse한다', () => {
            const uri = coerceDefaultUri('vscode-remote://ssh-remote+box/home/dev');
            assert.strictEqual(uri?.scheme, 'vscode-remote');
        });

        test('Windows 드라이브 문자를 scheme으로 오인하지 않는다', () => {
            // 'C:\proj'의 콜론 때문에 Uri.parse를 쓰면 scheme='c'가 되어버린다.
            const uri = coerceDefaultUri('C:\\proj\\build');
            assert.strictEqual(uri?.scheme, 'file');
            assertSamePath(uri?.fsPath, vscode.Uri.file('C:\\proj\\build').fsPath);
        });

        test('빈 값이나 잘못된 타입은 undefined', () => {
            assert.strictEqual(coerceDefaultUri(undefined), undefined);
            assert.strictEqual(coerceDefaultUri(''), undefined);
            assert.strictEqual(coerceDefaultUri(42), undefined);
            assert.strictEqual(coerceDefaultUri({ path: '/x' }), undefined);
        });
    });

    suite('taskDialogScope', () => {
        test('액션/태스크 조합마다 다른 scope를 만든다', () => {
            const a = taskDialogScope('file', { actionId: 'build', id: 'pickElf' });
            const b = taskDialogScope('file', { actionId: 'build', id: 'pickOutput' });
            const c = taskDialogScope('file', { actionId: 'flash', id: 'pickElf' });
            assert.strictEqual(a, 'task.fileDialog:build/pickElf');
            assert.notStrictEqual(a, b);
            assert.notStrictEqual(a, c);
        });

        test('같은 태스크의 file/folder 다이얼로그는 분리된다', () => {
            assert.notStrictEqual(
                taskDialogScope('file', { actionId: 'build', id: 'pick' }),
                taskDialogScope('folder', { actionId: 'build', id: 'pick' })
            );
        });

        test('id가 없어도 안전한 문자열을 만든다', () => {
            assert.strictEqual(taskDialogScope('folder', {}), 'task.folderDialog:/');
        });
    });

    suite('directoryToRemember', () => {
        test('file scheme이 아니면 기억하지 않는다', () => {
            assert.strictEqual(directoryToRemember(vscode.Uri.parse('untitled:foo.txt'), false), undefined);
        });

        test('파일은 상위 폴더, 폴더는 자기 자신', () => {
            const target = vscode.Uri.file(path.join(dir('a'), 'b'));
            assertSamePath(directoryToRemember(target, false), path.dirname(target.fsPath));
            assertSamePath(directoryToRemember(target, true), target.fsPath);
        });
    });

    suite('defaultDialogMemoryDeps (실제 저장소/디스크)', () => {
        let tempRoot: string;
        let previousContext: vscode.ExtensionContext | undefined;
        let workspaceStore: Map<string, unknown>;
        let globalStore: Map<string, unknown>;

        function makeMemento(store: Map<string, unknown>): vscode.Memento {
            return {
                keys: () => Array.from(store.keys()),
                get: <T>(key: string, defaultValue?: T) => (store.has(key) ? store.get(key) as T : defaultValue),
                update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
                setKeysForSync: () => undefined,
            } as unknown as vscode.Memento;
        }

        setup(() => {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-dlgmem-'));
            workspaceStore = new Map();
            globalStore = new Map();
            previousContext = initDialogMemory({
                workspaceState: makeMemento(workspaceStore),
                globalState: makeMemento(globalStore),
            } as unknown as vscode.ExtensionContext);
        });

        teardown(() => {
            initDialogMemory(previousContext);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        });

        test('remember는 workspaceState와 globalState 양쪽에 기록한다', async () => {
            const deps = defaultDialogMemoryDeps();
            deps.remember('scope.a', tempRoot);
            // update는 비동기 chain이므로 microtask 한 바퀴를 돌린다.
            await Promise.resolve();

            assert.strictEqual(workspaceStore.get('dialogLocation:scope.a'), tempRoot);
            assert.strictEqual(globalStore.get('dialogLocation:scope.a'), tempRoot);
        });

        test('recall은 workspaceState를 우선하고 없으면 globalState로 내려간다', () => {
            const deps = defaultDialogMemoryDeps();
            globalStore.set('dialogLocation:scope.b', dir('from-global'));
            assert.strictEqual(deps.recall('scope.b'), dir('from-global'));

            workspaceStore.set('dialogLocation:scope.b', dir('from-workspace'));
            assert.strictEqual(deps.recall('scope.b'), dir('from-workspace'));
        });

        test('기억이 없는 scope는 undefined', () => {
            assert.strictEqual(defaultDialogMemoryDeps().recall('scope.never-used'), undefined);
        });

        test('isDirectory / exists는 실제 디스크 상태를 따른다', () => {
            const deps = defaultDialogMemoryDeps();
            const filePath = path.join(tempRoot, 'file.txt');
            fs.writeFileSync(filePath, 'x');

            assert.strictEqual(deps.isDirectory(tempRoot), true);
            assert.strictEqual(deps.isDirectory(filePath), false, '파일은 시작 디렉터리가 될 수 없다');
            assert.strictEqual(deps.exists(filePath), true);
            assert.strictEqual(deps.exists(path.join(tempRoot, 'missing')), false);
        });

        test('rememberLastLocation을 끄면 기억하지도 되살리지도 않는다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            await config.update('dialog.rememberLastLocation', false, vscode.ConfigurationTarget.Global);
            try {
                const deps = defaultDialogMemoryDeps();
                globalStore.set('dialogLocation:scope.c', tempRoot);

                assert.strictEqual(deps.recall('scope.c'), undefined, '설정이 꺼지면 저장된 값을 무시한다');

                deps.remember('scope.d', tempRoot);
                await Promise.resolve();
                assert.strictEqual(workspaceStore.has('dialogLocation:scope.d'), false);
                assert.strictEqual(globalStore.has('dialogLocation:scope.d'), false);
            } finally {
                await config.update('dialog.rememberLastLocation', undefined, vscode.ConfigurationTarget.Global);
            }
        });

        test('컨텍스트가 없으면 조용히 무시한다 (activate 이전 호출)', () => {
            initDialogMemory(undefined);
            const deps = defaultDialogMemoryDeps();
            assert.strictEqual(deps.recall('scope.e'), undefined);
            assert.doesNotThrow(() => deps.remember('scope.e', tempRoot));
        });
    });
});
