import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    DIALOG_MEMORY_MAX_ENTRIES,
    DIALOG_SCOPE,
    DialogMemoryDeps,
    LAST_USED_SCOPE,
    coerceDefaultUri,
    defaultDialogMemoryDeps,
    directoryToRemember,
    initDialogMemory,
    pruneDialogLocations,
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
        // 실제 구현과 같은 계약 두 가지 — scope 와 `LAST_USED_SCOPE` 를 함께
        // 기록하고, 설정이 꺼져 있으면 아무것도 기록하지 않는다. 앞의 것을
        // 빼먹으면 "다음 다이얼로그가 직전 위치를 이어받는다"를 검사할 수 없고,
        // 뒤의 것을 빼먹으면 OFF 경로가 가짜에서만 통과한다.
        remember: (scope, value) => {
            if (overrides.enabled === false) { return; }
            stored.set(scope, value);
            stored.set(LAST_USED_SCOPE, value);
        },
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
     * scope 를 가리지 않는 "가장 최근에 쓴 위치" 폴백 (0.6.54).
     *
     * scope 별 기억은 같은 용도를 반복할 때만 값을 갖는다. 그 scope 를 처음 쓰는
     * 다이얼로그는 기억이 없어 워크스페이스 루트로 떨어졌고, "펌웨어 파일을 고른
     * 뒤 출력 폴더를 고른다"처럼 이어지는 액션에서 두 번째 다이얼로그가 방금
     * 다녀온 폴더와 무관한 곳에서 열렸다. 그 빈자리에만 들어가는 폴백이다.
     */
    suite('직전 다이얼로그 위치 폴백 (LAST_USED_SCOPE)', () => {
        test('기억이 없는 scope는 직전 다이얼로그가 다녀온 폴더에서 연다', async () => {
            const workspace = dir('workspace');
            const firmwareDir = dir('project', 'build');
            const env = makeFakeEnv({
                dirs: [workspace, firmwareDir],
                fallbackDir: workspace,
                openResult: [vscode.Uri.file(path.join(firmwareDir, 'app.hex'))],
            });

            // 1) 펌웨어 파일 고르기 — 이 태스크의 scope 에 build 폴더가 남는다.
            await showOpenDialogWithMemory(taskDialogScope('file', { actionId: 'flash', id: 'pickFw' }), {}, env.deps);
            // 2) 출력 폴더 고르기 — 자기 scope 기억은 아직 없다.
            await showOpenDialogWithMemory(
                taskDialogScope('folder', { actionId: 'flash', id: 'pickOut' }),
                { canSelectFiles: false, canSelectFolders: true },
                env.deps
            );

            assertSamePath(
                env.openCalls[1].defaultUri?.fsPath,
                firmwareDir,
                '두 번째 다이얼로그가 직전 위치 대신 워크스페이스 루트에서 열렸다'
            );
        });

        test('자기 scope 기억이 있으면 직전 위치보다 우선한다', async () => {
            const workspace = dir('workspace');
            const outputDir = dir('release', 'out');
            const firmwareDir = dir('project', 'build');
            const folderScope = taskDialogScope('folder', { actionId: 'flash', id: 'pickOut' });
            const env = makeFakeEnv({
                dirs: [workspace, outputDir, firmwareDir],
                fallbackDir: workspace,
                remembered: { [folderScope]: outputDir },
                openResult: [vscode.Uri.file(path.join(firmwareDir, 'app.hex'))],
            });

            await showOpenDialogWithMemory(taskDialogScope('file', { actionId: 'flash', id: 'pickFw' }), {}, env.deps);
            await showOpenDialogWithMemory(folderScope, { canSelectFiles: false, canSelectFolders: true }, env.deps);

            assertSamePath(
                env.openCalls[1].defaultUri?.fsPath,
                outputDir,
                '늘 같은 출력 폴더를 고르던 사용자의 위치를 폴백이 덮어썼다'
            );
        });

        test('직전 위치가 사라졌으면 워크스페이스 폴백으로 내려간다', async () => {
            const workspace = dir('workspace');
            const removed = dir('unplugged', 'sdcard');
            const env = makeFakeEnv({
                dirs: [workspace],   // `removed`는 디스크에 없다.
                fallbackDir: workspace,
                remembered: { [LAST_USED_SCOPE]: removed },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, workspace);
        });

        test('액션 JSON의 defaultUri가 직전 위치보다 우선한다', async () => {
            const authored = dir('vendor', 'sdk');
            const recent = dir('project', 'build');
            const env = makeFakeEnv({
                dirs: [authored, recent],
                remembered: { [LAST_USED_SCOPE]: recent },
            });

            await showOpenDialogWithMemory(
                taskDialogScope('file', { actionId: 'flash', id: 'pickFw' }),
                { defaultUri: vscode.Uri.file(authored) },
                env.deps
            );

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, authored);
        });

        test('설정이 꺼져 있으면 직전 위치도 쓰지 않는다', async () => {
            const recent = dir('project', 'build');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                enabled: false,
                dirs: [recent, workspace],
                fallbackDir: workspace,
                remembered: { [LAST_USED_SCOPE]: recent },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(env.openCalls[0].defaultUri, undefined);
        });

        test('용도가 다른 다이얼로그 사이에서도 이어진다 (Hex Viewer → fileDialog 태스크)', async () => {
            const hexDir = dir('dumps');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                dirs: [hexDir, workspace],
                fallbackDir: workspace,
                openResult: [vscode.Uri.file(path.join(hexDir, 'flash.bin'))],
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);
            await showOpenDialogWithMemory(taskDialogScope('file', { actionId: 'a', id: 'b' }), {}, env.deps);

            assertSamePath(env.openCalls[1].defaultUri?.fsPath, hexDir);
        });

        test('저장 다이얼로그가 남긴 위치를 그 다음 열기가 이어받는다', async () => {
            const savedDir = dir('release');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                dirs: [savedDir, workspace],
                fallbackDir: workspace,
                saveResult: vscode.Uri.file(path.join(savedDir, 'actions.taskhub')),
            });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.actionsExport,
                'actions.taskhub',
                { defaultDir: workspace },
                env.deps
            );
            await showOpenDialogWithMemory(DIALOG_SCOPE.actionsImport, {}, env.deps);

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, savedDir, '저장 위치를 열기 쪽이 이어받지 못했다');
        });

        test('저장 다이얼로그의 defaultDir이 직전 위치보다 우선한다', async () => {
            // `defaultDir`은 호출자가 이 저장에 대해 아는 구체적인 사실이다 —
            // 분석 중인 바이너리 폴더(memoryMapExport)이거나 사용자가 방금 고른
            // 워크스페이스 폴더(actionsExport / presetSave 의 다중 루트 선택).
            // 용도를 가리지 않는 최근 위치가 그걸 덮으면 안 된다.
            const binaryDir = dir('proj', 'elf');
            const recent = dir('somewhere', 'else');
            const env = makeFakeEnv({
                dirs: [binaryDir, recent],
                remembered: { [LAST_USED_SCOPE]: recent },
            });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.memoryMapExport,
                'app_memory_map.html',
                { defaultDir: binaryDir },
                env.deps
            );

            assertSamePath(env.saveCalls[0].defaultUri?.fsPath, path.join(binaryDir, 'app_memory_map.html'));
        });

        test('defaultDir이 사라졌으면 저장 다이얼로그도 직전 위치로 내려간다', async () => {
            // 저장 쪽에서 이 폴백이 실제로 닿는 경로. 모든 호출부가 defaultDir을
            // 넘기므로(존재하는 한 그쪽이 이긴다), 남는 경우는 그 폴더가 사라진
            // 때다 — 예컨대 이전 세션의 filePath로 열려 있던 Memory Map 웹뷰에서
            // 저장을 누르는데 그 바이너리가 있던 드라이브가 빠진 상황.
            const recent = dir('project', 'build');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                dirs: [recent, workspace],   // defaultDir 로 줄 폴더는 없다.
                fallbackDir: workspace,
                remembered: { [LAST_USED_SCOPE]: recent },
            });

            await showSaveDialogWithMemory(
                DIALOG_SCOPE.memoryMapExport,
                'app_memory_map.html',
                { defaultDir: dir('unplugged', 'sdcard') },
                env.deps
            );

            assertSamePath(env.saveCalls[0].defaultUri?.fsPath, path.join(recent, 'app_memory_map.html'));
        });

        test('scope 기억이 사라졌으면 워크스페이스가 아니라 직전 위치로 내려간다', async () => {
            const removed = dir('gone');
            const recent = dir('project', 'build');
            const workspace = dir('workspace');
            const env = makeFakeEnv({
                dirs: [recent, workspace],
                fallbackDir: workspace,
                remembered: { [DIALOG_SCOPE.hexViewer]: removed, [LAST_USED_SCOPE]: recent },
            });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assertSamePath(env.openCalls[0].defaultUri?.fsPath, recent);
        });

        test('설정이 꺼져 있으면 직전 위치를 기록하지도 않는다', async () => {
            const picked = path.join(dir('project', 'build'), 'app.hex');
            const env = makeFakeEnv({ enabled: false, openResult: [vscode.Uri.file(picked)] });

            await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {}, env.deps);

            assert.strictEqual(env.stored.size, 0, '꺼진 상태에서 남긴 위치는 켤 때 되살아난다');
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

        test('저장 대화상자는 defaultUri를 아예 지정하지 않는다', async () => {
            // 0.6.30은 "폴더는 비우고 파일명만 제안"하려고 Uri.file(이름만)을
            // 넘겼는데, 상대 경로 Uri는 파일시스템 루트로 해석된다(Windows
            // \actions.taskhub) — TaskHub가 가장 이상한 위치를 지정한 셈이다.
            // 당시 이 테스트는 선행 구분자를 replace로 지우고 검사해 그 버그를
            // 정상으로 봉인하고 있었다. API에 파일명만 제안하는 수단이 없으므로
            // 꺼진 상태에서는 파일명 제안을 포기하는 것이 맞다.
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
                env.saveCalls[0].defaultUri,
                undefined,
                'TaskHub가 위치를 지정하면 VS Code 자체 최근 경로가 쓰일 수 없다'
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

        test('scope가 다르면 위치를 덮어쓰지 않는다 (폴백용 최근 위치는 별도 키)', async () => {
            const picked = path.join(dir('elf'), 'app.axf');
            const env = makeFakeEnv({ openResult: [vscode.Uri.file(picked)] });

            await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapBinary, {}, env.deps);

            assert.ok(env.stored.has(DIALOG_SCOPE.memoryMapBinary));
            assert.strictEqual(env.stored.has(DIALOG_SCOPE.hexViewer), false,
                '다른 scope의 기억을 건드리면 그 용도로 쓰던 위치가 사라진다');
            // 0.6.54부터 `LAST_USED_SCOPE`에도 같이 적히지만, 그건 기억이 **없는**
            // scope를 위한 폴백일 뿐 hexViewer의 기억이 되지는 않는다.
            assertSamePath(env.stored.get(LAST_USED_SCOPE), path.dirname(vscode.Uri.file(picked).fsPath));
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

        test('쓸 수 있는 폴더가 없으면 defaultUri를 지정하지 않는다', async () => {
            // 존재하는 디렉터리도, 워크스페이스 폴백도 없는 상태. 예전에는
            // Uri.file(파일명만)을 넘겼는데 상대 경로 Uri는 파일시스템 루트로
            // 해석돼, "폴더가 없으니 VS Code에 맡긴다"가 아니라 루트를 지정하는
            // 셈이 됐다 — rememberLastLocation OFF 경로와 같은 결함이다.
            const env = makeFakeEnv();

            await showSaveDialogWithMemory(DIALOG_SCOPE.presetSave, 'preset-hil.json', {}, env.deps);

            assert.strictEqual(env.saveCalls[0].defaultUri, undefined);
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
                update: (key: string, value: unknown) => {
                    // 실제 Memento는 `undefined`를 **삭제**로 다룬다. 가짜가
                    // 값을 그대로 넣어 두면 키가 남아, 마이그레이션이 옛 키를
                    // 지우는지 검사할 수 없다.
                    if (value === undefined) { store.delete(key); } else { store.set(key, value); }
                    return Promise.resolve();
                },
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

        /** 0.6.33부터의 저장 형식: scope → { dir, at } 맵 하나. */
        const STATE_KEY = 'taskhub.dialogLocations';
        const locationsIn = (store: Map<string, unknown>) =>
            (store.get(STATE_KEY) ?? {}) as Record<string, { dir: string; at: number }>;

        test('remember는 workspaceState와 globalState 양쪽에 기록한다', async () => {
            const deps = defaultDialogMemoryDeps();
            deps.remember('scope.a', tempRoot);
            // update는 비동기 chain이므로 microtask 한 바퀴를 돌린다.
            await Promise.resolve();

            assert.strictEqual(locationsIn(workspaceStore)['scope.a']?.dir, tempRoot);
            assert.strictEqual(locationsIn(globalStore)['scope.a']?.dir, tempRoot);
        });

        test('remember는 scope와 함께 LAST_USED_SCOPE도 기록한다', async () => {
            const deps = defaultDialogMemoryDeps();
            deps.remember('scope.a', tempRoot);
            await Promise.resolve();

            assert.strictEqual(locationsIn(workspaceStore)[LAST_USED_SCOPE]?.dir, tempRoot,
                '이게 없으면 다른 용도의 다이얼로그가 직전 위치를 이어받을 수 없다');
            assert.strictEqual(
                locationsIn(workspaceStore)[LAST_USED_SCOPE]?.at,
                locationsIn(workspaceStore)['scope.a']?.at,
                '두 항목은 한 번의 쓰기로 함께 갱신돼야 한다'
            );
        });

        /**
         * 예약 키는 **창 로컬**이다.
         *
         * scope별 기억이 globalState로도 가는 근거는 "다른 창에서 쓰던 **같은
         * 용도**의 위치를 물려받는다"인데, 예약 키에는 용도가 없다. 창을 넘기면
         * 다른 프로젝트에서 방금 다녀온 폴더가 이 프로젝트의 시작 위치가 되고,
         * 그건 §25가 없애려던 바로 그 증상이다.
         */
        test('LAST_USED_SCOPE는 globalState에 쓰지 않는다', async () => {
            const deps = defaultDialogMemoryDeps();
            deps.remember('scope.a', tempRoot);
            await Promise.resolve();

            assert.ok(!locationsIn(globalStore)[LAST_USED_SCOPE],
                '다른 창의 직전 위치가 이 프로젝트의 다이얼로그를 끌고 가면 안 된다');
            assert.strictEqual(locationsIn(globalStore)['scope.a']?.dir, tempRoot,
                'scope별 기억은 종전대로 양쪽에 남아야 한다');
        });

        test('globalState에 남은 LAST_USED_SCOPE는 읽지도 않는다', () => {
            // 저장소가 손상됐거나 옛 빌드가 남긴 값이 있어도 창을 넘지 않는다.
            globalStore.set(STATE_KEY, { [LAST_USED_SCOPE]: { dir: dir('other-project'), at: 1 } });
            assert.strictEqual(defaultDialogMemoryDeps().recall(LAST_USED_SCOPE), undefined);
        });

        test('LAST_USED_SCOPE는 실제 scope 이름과 겹치지 않는다', () => {
            const collides = (scope: string) => scope === LAST_USED_SCOPE || scope.startsWith('*');
            for (const scope of Object.values(DIALOG_SCOPE)) {
                assert.strictEqual(collides(scope), false, `고정 scope ${scope}가 예약 이름과 겹친다`);
            }
            // 액션/태스크 id는 사용자가 정하므로 예약 이름을 그대로 넣어 본다.
            // `task.` 접두사가 이 충돌을 구조적으로 막는다.
            for (const kind of ['file', 'folder'] as const) {
                assert.strictEqual(
                    collides(taskDialogScope(kind, { actionId: LAST_USED_SCOPE, id: LAST_USED_SCOPE })),
                    false,
                    '예약 키를 액션 id로 쓴 사용자가 다른 용도의 기억을 오염시킬 수 있다'
                );
            }
        });

        test('recall은 workspaceState를 우선하고 없으면 globalState로 내려간다', () => {
            const deps = defaultDialogMemoryDeps();
            globalStore.set(STATE_KEY, { 'scope.b': { dir: dir('from-global'), at: 1 } });
            assert.strictEqual(deps.recall('scope.b'), dir('from-global'));

            workspaceStore.set(STATE_KEY, { 'scope.b': { dir: dir('from-workspace'), at: 1 } });
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
                globalStore.set(STATE_KEY, { 'scope.c': { dir: tempRoot, at: 1 } });

                assert.strictEqual(deps.recall('scope.c'), undefined, '설정이 꺼지면 저장된 값을 무시한다');

                deps.remember('scope.d', tempRoot);
                await Promise.resolve();
                assert.ok(!locationsIn(workspaceStore)['scope.d']);
                assert.ok(!locationsIn(globalStore)['scope.d']);
                assert.ok(!locationsIn(workspaceStore)[LAST_USED_SCOPE],
                    '꺼진 상태에서 남긴 직전 위치는 다시 켤 때 되살아난다');
            } finally {
                await config.update('dialog.rememberLastLocation', undefined, vscode.ConfigurationTarget.Global);
            }
        });

        /**
         * 저장소 무한 증가 차단 (0.6.33).
         *
         * `taskDialogScope`는 액션 id + 태스크 id로 scope를 만든다. 액션 이름을
         * 바꾸거나 지울 때마다 옛 scope가 남는데, scope당 키 하나였던 옛 형식은
         * 정리 경로가 없어 **globalState에 영구히 쌓였다**. 0.6.23의 키 형식
         * 변경으로 이미 한 세대가 고아가 됐다.
         *
         * "현재 워크스페이스의 액션 id와 대조해 지운다"는 접근은 쓰지 않았다 —
         * globalState는 창 사이에 공유되므로 지금 열린 프로젝트에 없는 scope가
         * 곧 죽은 scope인 것은 아니고, 그 방식은 다른 프로젝트가 물려받아 쓰는
         * 위치를 지운다. 총량만 제한한다.
         */
        suite('저장소 크기 제한과 마이그레이션', () => {

            test('상한을 넘으면 오래 전에 기록된 것부터 버린다', () => {
                const map: Record<string, { dir: string; at: number }> = {};
                for (let i = 0; i < DIALOG_MEMORY_MAX_ENTRIES + 10; i++) {
                    map[`scope-${i}`] = { dir: dir(`d${i}`), at: i };
                }

                const pruned = pruneDialogLocations(map);

                assert.strictEqual(Object.keys(pruned).length, DIALOG_MEMORY_MAX_ENTRIES);
                assert.ok(pruned[`scope-${DIALOG_MEMORY_MAX_ENTRIES + 9}`], '최신 항목이 남아야 한다');
                assert.ok(!pruned['scope-0'], '가장 오래된 항목이 남아 있다');
            });

            test('상한 이하면 손대지 않는다 (같은 객체를 그대로 돌려준다)', () => {
                const map = { a: { dir: dir('a'), at: 1 } };
                assert.strictEqual(pruneDialogLocations(map), map);
            });

            test('at이 같으면 scope 이름으로 갈라 결과가 결정적이다', () => {
                const map = {
                    b: { dir: dir('b'), at: 5 },
                    a: { dir: dir('a'), at: 5 },
                    c: { dir: dir('c'), at: 5 },
                };
                const first = Object.keys(pruneDialogLocations(map, 2)).sort();
                const second = Object.keys(pruneDialogLocations(map, 2)).sort();
                assert.deepStrictEqual(first, second);
                assert.deepStrictEqual(first, ['a', 'b']);
            });

            test('remember가 상한을 유지한다', async () => {
                const deps = defaultDialogMemoryDeps();
                const seed: Record<string, { dir: string; at: number }> = {};
                for (let i = 0; i < DIALOG_MEMORY_MAX_ENTRIES; i++) {
                    seed[`old-${i}`] = { dir: dir(`old${i}`), at: i };
                }
                globalStore.set(STATE_KEY, seed);
                workspaceStore.set(STATE_KEY, { ...seed });

                deps.remember('brand-new', tempRoot);
                await Promise.resolve();

                const stored = locationsIn(globalStore);
                assert.strictEqual(Object.keys(stored).length, DIALOG_MEMORY_MAX_ENTRIES,
                    '기록할 때마다 상한을 지키지 않으면 저장소가 무한히 자란다');
                assert.strictEqual(stored['brand-new']?.dir, tempRoot);
                assert.ok(!stored['old-0'], '가장 오래된 항목이 밀려나야 한다');
            });

            test('LAST_USED_SCOPE는 가장 오래된 항목이어도 축출하지 않는다', () => {
                // 시계가 뒤로 갔거나 미래 시각이 적힌 저장소를 만난 경우. `at`
                // 비교만으로는 예약 키가 밀려나고, 그러면 "직전 위치 이어받기"가
                // 오래 쓴 프로젝트에서만 조용히 사라진다 — 재현이 어려운 결함이라
                // 시각 순서에 기대지 않고 함수에 박아 둔 규칙을 직접 검사한다.
                const map: Record<string, { dir: string; at: number }> = {
                    [LAST_USED_SCOPE]: { dir: dir('recent'), at: 1 },
                };
                for (let i = 0; i < DIALOG_MEMORY_MAX_ENTRIES; i++) {
                    map[`newer-${i}`] = { dir: dir(`d${i}`), at: 5_000_000 + i };
                }

                const pruned = pruneDialogLocations(map);

                assert.strictEqual(Object.keys(pruned).length, DIALOG_MEMORY_MAX_ENTRIES);
                assert.strictEqual(pruned[LAST_USED_SCOPE]?.dir, dir('recent'));
                assert.ok(!pruned['newer-0'], '예약 키 자리는 가장 오래된 일반 항목에서 나와야 한다');
            });

            test('예약 키만 남길 자리도 없으면(max<=0) 빈 맵을 낸다', () => {
                // 예약 키를 지키는 분기가 `max`를 넘기지 않는지 — 경계 계약.
                const map = { [LAST_USED_SCOPE]: { dir: dir('recent'), at: 1 }, a: { dir: dir('a'), at: 2 } };
                assert.deepStrictEqual(pruneDialogLocations(map, 0), {});
                assert.deepStrictEqual(Object.keys(pruneDialogLocations(map, 1)), [LAST_USED_SCOPE]);
            });

            test('remember는 workspaceState의 상한도 유지한다', async () => {
                // 예약 키가 함께 들어가는 쪽이라 항목이 하나 더 늘어난다.
                const deps = defaultDialogMemoryDeps();
                const seed: Record<string, { dir: string; at: number }> = {};
                for (let i = 0; i < DIALOG_MEMORY_MAX_ENTRIES; i++) {
                    seed[`old-${i}`] = { dir: dir(`old${i}`), at: i };
                }
                workspaceStore.set(STATE_KEY, seed);

                deps.remember('brand-new', tempRoot);
                await Promise.resolve();

                const stored = locationsIn(workspaceStore);
                assert.strictEqual(Object.keys(stored).length, DIALOG_MEMORY_MAX_ENTRIES);
                assert.strictEqual(stored['brand-new']?.dir, tempRoot);
                assert.strictEqual(stored[LAST_USED_SCOPE]?.dir, tempRoot);
                assert.ok(!stored['old-0'] && !stored['old-1'], '가장 오래된 두 항목이 밀려나야 한다');
            });

            test('옛 형식의 키를 흡수하고 지운다', () => {
                globalStore.set('dialogLocation:hexViewer', dir('legacy-hex'));
                globalStore.set('dialogLocation:task.fileDialog:/pick', dir('legacy-orphan'));

                // initDialogMemory가 마이그레이션을 돌린다.
                initDialogMemory({
                    workspaceState: makeMemento(workspaceStore),
                    globalState: makeMemento(globalStore),
                } as unknown as vscode.ExtensionContext);

                assert.strictEqual(locationsIn(globalStore)['hexViewer']?.dir, dir('legacy-hex'),
                    '흡수하지 않으면 사용자가 쓰던 위치가 사라진다');
                assert.ok(!globalStore.has('dialogLocation:hexViewer'), '옛 키가 남았다');
                assert.ok(!globalStore.has('dialogLocation:task.fileDialog:/pick'),
                    '0.6.23 이전의 빈 액션 id 고아 키도 함께 지워져야 한다');
            });

            test('마이그레이션은 멱등하고 새 형식을 덮어쓰지 않는다', () => {
                globalStore.set(STATE_KEY, { hexViewer: { dir: dir('current'), at: 99 } });
                globalStore.set('dialogLocation:hexViewer', dir('stale-legacy'));

                const rerun = () => initDialogMemory({
                    workspaceState: makeMemento(workspaceStore),
                    globalState: makeMemento(globalStore),
                } as unknown as vscode.ExtensionContext);
                rerun();
                rerun();

                assert.strictEqual(locationsIn(globalStore)['hexViewer']?.dir, dir('current'),
                    '새 형식에 이미 값이 있으면 그쪽이 최신이다');
            });

            test('옛 키가 없으면 아무것도 쓰지 않는다', () => {
                initDialogMemory({
                    workspaceState: makeMemento(workspaceStore),
                    globalState: makeMemento(globalStore),
                } as unknown as vscode.ExtensionContext);

                assert.ok(!globalStore.has(STATE_KEY),
                    '깨끗한 설치에서 빈 맵을 만들어 두면 마이그레이션이 매번 돈 것처럼 보인다');
            });

            test('손상된 저장 값은 무시하고 넘어간다', () => {
                globalStore.set(STATE_KEY, { good: { dir: dir('ok'), at: 1 }, bad: 'not-an-object', worse: { at: 5 } });
                assert.strictEqual(defaultDialogMemoryDeps().recall('good'), dir('ok'));
                assert.strictEqual(defaultDialogMemoryDeps().recall('bad'), undefined);
                assert.strictEqual(defaultDialogMemoryDeps().recall('worse'), undefined);
            });
        });

        test('컨텍스트가 없으면 조용히 무시한다 (activate 이전 호출)', () => {
            initDialogMemory(undefined);
            const deps = defaultDialogMemoryDeps();
            assert.strictEqual(deps.recall('scope.e'), undefined);
            assert.doesNotThrow(() => deps.remember('scope.e', tempRoot));
        });
    });
});
