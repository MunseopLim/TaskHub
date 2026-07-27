import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionItem } from '../schema';
import {
    ActionStoppedError,
    MainViewProvider,
    executeAction,
    isActionCancelled,
    runCommandCaptureLines,
    stopRunningAction,
} from '../extension';
import { HistoryProvider } from '../providers/historyProvider';
import { actionStates } from '../providers/actionStatus';

/**
 * 대화형 태스크 대기 중의 중지 (0.6.29).
 *
 * `activeTasks`와 `actionChildProcesses`는 **프로세스가 있는 작업**만 담는다.
 * 그런데 `inputBox` / `quickPick` / `fileDialog` 프롬프트 앞에 멈춰 있는 액션은
 * 둘 중 어느 것도 갖지 않으면서 상태는 명백히 `running`이다 — 트리에 스피너가
 * 돌고 인라인 중지 버튼도 떠 있다.
 *
 * 그 버튼을 누르면 `stopRunningAction`이 멈출 것을 하나도 찾지 못해
 * *"활성 태스크를 찾을 수 없습니다"* 경고를 띄웠고, 프롬프트는 화면에 그대로
 * 남았다. **중지하지 않는 중지 버튼**이었다.
 *
 * 수정은 액션마다 `CancellationTokenSource`를 두고 그 토큰을 프롬프트에
 * 넘기는 것이다. VS Code가 토큰 취소 시 프롬프트를 닫아 주므로 기존 취소
 * 분기로 자연스럽게 흘러간다. 네이티브 파일 대화상자는 토큰을 받지 않아
 * 프로그램적으로 닫을 수 없으므로, 취소를 **기록**해 두었다가 대화상자가
 * 반환되는 즉시 파이프라인을 중단시킨다.
 */
suite('대화형 태스크 대기 중 중지', () => {

    function makeContext(): vscode.ExtensionContext {
        const store = new Map<string, any>();
        const memento = {
            get: (k: string, d?: any) => (store.has(k) ? store.get(k) : d),
            update: async (k: string, v: any) => { store.set(k, v); },
            keys: () => Array.from(store.keys()),
            setKeysForSync: () => { /* no-op */ },
        };
        return {
            extensionPath: '/ext',
            subscriptions: [],
            workspaceState: memento,
            globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    function inputBoxAction(id: string): ActionItem {
        return {
            id,
            title: `Interactive ${id}`,
            action: {
                description: 'waits on a prompt',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'value?' },
                    // 두 번째 태스크가 있어야 "중지했는데 뒤 단계가 계속됐다"를
                    // 구분할 수 있다.
                    { id: 'after', type: 'stringManipulation', function: 'trim', input: 'should-not-run' },
                ],
            },
        } as unknown as ActionItem;
    }

    /**
     * `showInputBox`를 "토큰이 취소되면 undefined로 resolve"하는 가짜로
     * 바꾼다 — VS Code 실제 동작과 같은 계약이다. 토큰을 무시하도록 만들면
     * 이 테스트가 검증하려는 배선이 통과해 버린다.
     */
    function stubTokenAwareInputBox(): { restore: () => void; sawToken: () => boolean } {
        const original = vscode.window.showInputBox;
        let received: vscode.CancellationToken | undefined;
        (vscode.window as any).showInputBox = (_options: any, token?: vscode.CancellationToken) => {
            received = token;
            return new Promise<string | undefined>(resolve => {
                // 토큰이 없으면 중지할 방법이 없다는 것이 결함의 본질이지만,
                // 테스트에서 영원히 매달리게 두면 스위트 전체가 타임아웃으로
                // 무너진다. 토큰 유무는 아래 `sawToken()` 단언이 직접 잡는다.
                if (!token) { resolve(undefined); return; }
                if (token.isCancellationRequested) { resolve(undefined); return; }
                token.onCancellationRequested(() => resolve(undefined));
            });
        };
        return {
            restore: () => { (vscode.window as any).showInputBox = original; },
            sawToken: () => received !== undefined,
        };
    }

    teardown(() => {
        actionStates.clear();
    });

    /**
     * 액션이 끝나기를 기다리되 무한정 매달리지 않는다.
     *
     * 배선이 깨지면 프롬프트가 닫히지 않아 `executeAction`의 promise가 영원히
     * pending으로 남고, 그 하나가 스위트 전체를 타임아웃으로 무너뜨린다
     * (실제로 수정을 되돌려 확인했을 때 23개가 연쇄로 실패했다). 원인 테스트
     * 하나만 실패하도록 경계를 둔다.
     */
    async function settleWithin(run: Promise<unknown>, ms: number, what: string): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const guard = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), ms);
        });
        try {
            const outcome = await Promise.race([run.then(() => 'done' as const, () => 'done' as const), guard]);
            assert.notStrictEqual(outcome, 'timeout', `${what}: ${ms}ms 안에 끝나지 않았다 — 중지가 프롬프트를 닫지 못했다`);
        } finally {
            if (timer) { clearTimeout(timer); }
        }
    }

    test('IT-123: inputBox 대기 중 중지하면 프롬프트가 닫히고 뒤 단계가 실행되지 않는다', async function () {
        this.timeout(20000);
        const stub = stubTokenAwareInputBox();
        const context = makeContext();
        const actionItem = inputBoxAction('stop-inputbox');
        const history = new HistoryProvider(context);
        const mainView = new MainViewProvider(context, () => [actionItem]);

        try {
            const run = executeAction(actionItem, context, mainView, history);

            // 프롬프트가 실제로 떠서 토큰을 받을 때까지 기다린다.
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.ok(stub.sawToken(), 'showInputBox가 CancellationToken을 받아야 중지가 가능하다');
            assert.strictEqual(
                actionStates.get('stop-inputbox')?.state,
                'running',
                '프롬프트 대기 중에도 상태는 running — 중지 버튼이 보이는 근거다'
            );

            assert.strictEqual(
                stopRunningAction('stop-inputbox'),
                true,
                '프롬프트만 떠 있어도 중지가 "멈출 것을 찾았다"고 보고해야 한다 — false면 사용자에게 "활성 태스크를 찾을 수 없습니다" 경고가 뜬다'
            );

            await settleWithin(run, 3000, 'IT-123');

            const entries = history.getHistory();
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(
                entries[0].status,
                'failure',
                '사용자 중지는 실패 상태로 마감된다 (개별 중지와 동일한 계약)'
            );
            assert.ok(
                !actionStates.has('stop-inputbox'),
                '중지된 액션은 상태 맵에서 지워져 ✗ 아이콘이 남지 않는다'
            );
        } finally {
            stub.restore();
        }
    });

    test('IT-124: 중지 요청이 없으면 토큰은 취소되지 않는다', async function () {
        this.timeout(20000);
        const stub = stubTokenAwareInputBox();
        const context = makeContext();
        const actionItem = inputBoxAction('no-stop');
        const history = new HistoryProvider(context);
        const mainView = new MainViewProvider(context, () => [actionItem]);

        try {
            const run = executeAction(actionItem, context, mainView, history);
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.strictEqual(
                isActionCancelled('no-stop'),
                false,
                '중지를 누르지 않았는데 취소로 보이면 정상 실행이 곧바로 중단된다'
            );

            stopRunningAction('no-stop');
            await settleWithin(run, 3000, 'IT-124');
        } finally {
            stub.restore();
        }
    });

    test('IT-125: 실행이 끝나면 취소 스코프가 정리된다 (다음 실행이 즉시 중단되지 않도록)', async function () {
        this.timeout(20000);
        const context = makeContext();
        const actionItem: ActionItem = {
            id: 'scope-cleanup',
            title: 'Scope cleanup',
            action: {
                description: 'no prompt',
                tasks: [{ id: 'noop', type: 'stringManipulation', function: 'trim', input: ' x ' }],
            },
        } as unknown as ActionItem;
        const history = new HistoryProvider(context);
        const mainView = new MainViewProvider(context, () => [actionItem]);

        await executeAction(actionItem, context, mainView, history);

        // 스코프가 남아 있으면 `isActionCancelled`가 이전 실행의 토큰을 보게 된다.
        assert.strictEqual(
            isActionCancelled('scope-cleanup'),
            false,
            '끝난 실행의 취소 소스가 남으면 같은 액션의 다음 실행이 첫 검사에서 중단된다'
        );
    });

    test('ActionStoppedError는 사용자 중지를 실패와 구분하는 전용 타입이다', () => {
        const error = new ActionStoppedError();
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'ActionStoppedError');
        assert.match(error.message, /stopped by user/i);
    });

    /**
     * 0.6.29의 사각지대 (0.6.35에서 보완).
     *
     * 0.6.29는 inputBox / quickPick에 토큰을 배선하고 IT-123으로 inputBox만
     * 고정했다. 그런데 INTERACTIVE_TASK_TYPES에는 envPick과 confirm도 있다 —
     * 둘 다 중지 버튼이 뜨고 stopRunningAction이 true를 돌려주며 히스토리에
     * "stopped by user"까지 기록되는데, 프롬프트는 열린 채 남았고 사용자가
     * 값을 고르면 뒤 태스크가 계속 실행돼 **성공 기록이 중지 기록을 덮었다**
     * (성공 히스토리 갱신은 try 블록에서 무조건 실행되고,
     * manuallyTerminatedActions는 catch에서만 확인하기 때문).
     */
    suite('envPick / confirm 대기 중 중지 (0.6.35)', () => {

        test('IT-126: envPick 대기 중 중지하면 목록이 닫히고 뒤 단계가 실행되지 않는다', async function () {
            this.timeout(20000);
            // showQuickPick을 토큰 계약 그대로 흉내 낸다 (IT-123의 inputBox와 동일).
            const original = vscode.window.showQuickPick;
            let received: vscode.CancellationToken | undefined;
            (vscode.window as any).showQuickPick = (_items: any, _options: any, token?: vscode.CancellationToken) => {
                received = token;
                return new Promise<unknown>(resolve => {
                    if (!token) { resolve(undefined); return; }
                    if (token.isCancellationRequested) { resolve(undefined); return; }
                    token.onCancellationRequested(() => resolve(undefined));
                });
            };
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-envpick',
                title: 'Stop envPick',
                action: {
                    description: 'waits on env pick',
                    tasks: [
                        { id: 'pick', type: 'envPick' },
                        { id: 'after', type: 'stringManipulation', function: 'trim', input: 'should-not-run' },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                // envPick은 셸 프로브(getShellAccessibleEnvNames)를 먼저 돌리므로
                // 프롬프트 도달까지 폴링으로 기다린다.
                for (let i = 0; i < 100 && !received; i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                assert.ok(received, 'showQuickPick이 CancellationToken을 받아야 중지가 가능하다');

                assert.strictEqual(stopRunningAction('stop-envpick'), true);
                await settleWithin(run, 3000, 'IT-126');

                const entries = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(
                    entries[0].status,
                    'failure',
                    '중지 기록이 성공으로 덮이면 안 된다 — 뒤 태스크가 실행됐다는 뜻이다'
                );
            } finally {
                (vscode.window as any).showQuickPick = original;
            }
        });

        test('IT-127: confirm modal이 열린 채 중지되면, 사용자가 Yes를 눌러도 파이프라인이 중단된다', async function () {
            this.timeout(20000);
            // Modal은 토큰을 받지 않아 프로그램적으로 닫을 수 없다. 이 테스트는
            // "중지 후 사용자가 Yes를 누른" 순서를 재현한다 — modal은 중지
            // 요청을 기다렸다가 확인 라벨을 돌려준다.
            const original = vscode.window.showWarningMessage;
            (vscode.window as any).showWarningMessage = (_msg: string, _opts: any, ...buttons: string[]) =>
                new Promise<string>(resolve => {
                    const timer = setInterval(() => {
                        if (isActionCancelled('stop-confirm')) {
                            clearInterval(timer);
                            resolve(buttons[0]);   // 사용자가 Yes를 누른 상황
                        }
                    }, 25);
                });
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-confirm',
                title: 'Stop confirm',
                action: {
                    description: 'waits on modal',
                    tasks: [
                        { id: 'ask', type: 'confirm', message: 'proceed?' },
                        { id: 'after', type: 'stringManipulation', function: 'trim', input: 'should-not-run' },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                await new Promise(resolve => setTimeout(resolve, 100));

                assert.strictEqual(stopRunningAction('stop-confirm'), true,
                    'modal 대기 중에도 중지가 "멈출 것을 찾았다"고 보고해야 한다');
                await settleWithin(run, 3000, 'IT-127');

                const entries = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(
                    entries[0].status,
                    'failure',
                    'Yes를 눌렀어도 중지 요청이 먼저였다 — 뒤 태스크가 실행돼 성공으로 덮이면 안 된다'
                );
            } finally {
                (vscode.window as any).showWarningMessage = original;
            }
        });

        test('IT-128: itemsFromCommand의 항목 생성 명령이 중지 즉시 종료된다', async function () {
            this.timeout(20000);
            // 항목 생성 spawn은 activeTasks에도 child-process registry에도
            // 없어서, 토큰이 없으면 중지 후에도 timeout(기본 15초)까지 돌며
            // 그동안 중지가 무반응으로 보였다.
            // `node -e "…"` 는 Windows `cmd /c` 에서 따옴표가 뭉개져 즉시
            // 끝난다 — 그러면 "취소가 끝냈는가" 가 아니라 "명령이 스스로
            // 끝났는가" 를 재게 된다. 스크립트 파일 헬퍼를 쓴다.
            const { command, cwd, cleanup } = makeMarkerScript('stop-latency', 10000);
            const cts = new vscode.CancellationTokenSource();
            const started = Date.now();
            try {
                const run = runCommandCaptureLines(command, cwd, 15000, cts.token);
                setTimeout(() => cts.cancel(), 200);

                await assert.rejects(run, /canceled/i, '취소가 거부로 이어져야 파이프라인이 중단된다');
                const elapsed = Date.now() - started;
                assert.ok(
                    elapsed < 5000,
                    `취소 후 ${elapsed}ms — 명령 완료(10s)나 timeout(15s)을 기다렸다는 뜻이다`
                );
            } finally {
                cts.dispose();
                cleanup();
            }
        });

        test('IT-129: 이미 취소된 토큰이면 명령을 spawn조차 하지 않는다', async () => {
            // 0.6.35는 spawn *뒤에* 취소를 확인해, 이미 중지된 액션의 명령이
            // 죽기 전까지 잠깐 실행됐다 — 사용자가 취소한 임의 명령이 부수
            // 효과를 남길 수 있다. 실행 흔적이 남는 명령으로 확인한다.
            const { command, cwd, marker, cleanup } = makeMarkerScript('spawn-guard', 0);
            const cts = new vscode.CancellationTokenSource();
            cts.cancel();
            try {
                await assert.rejects(
                    runCommandCaptureLines(command, cwd, 15000, cts.token),
                    /canceled/i
                );
                // 명령이 돌았다면 파일이 생긴다. 비동기 spawn이라 여유를 준다.
                await new Promise(resolve => setTimeout(resolve, 500));
                assert.ok(
                    !fs.existsSync(marker),
                    '이미 취소된 상태인데 명령이 실행돼 부수 효과를 남겼다'
                );
            } finally {
                cts.dispose();
                cleanup();
            }
        });
    });

    /**
     * "N ms 뒤 marker 파일을 쓰는" node 스크립트를 임시 파일로 만들고, 그것을
     * 실행하는 셸 명령을 돌려준다.
     *
     * `node -e "..."` 를 쓰면 Windows `cmd /c` 가 안쪽 따옴표를 뭉개 명령이
     * 곧바로 끝나 버린다 — 그러면 "취소가 죽였는가"를 검증하려던 테스트가
     * 실은 "명령이 스스로 끝났는가"를 보게 된다(실제로 처음 작성했을 때
     * 이렇게 헛돌았다). 경로와 지연을 스크립트 안에 박아 명령줄을
     * `node "<script>"` 한 토큰으로 줄인다.
     */
    function makeMarkerScript(label: string, delayMs: number): {
        command: string; cwd: string; marker: string; startedMarker: string; cleanup: () => void;
    } {
        const stamp = `${process.pid}-${Date.now()}-${label}`;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-killtest-'));
        const marker = path.join(dir, `${stamp}.txt`);
        // 시작 즉시 남기는 마커. 고정 sleep 대신 이걸 폴링해 "명령이 실제로
        // 떴다"를 확인한 뒤 중지한다 — 느린 CI 에서 아직 뜨지도 않은 프로세스를
        // 죽이고 "잘 죽었다"고 결론내는 것을 막는다.
        const startedMarker = path.join(dir, `${stamp}.started`);
        const scriptName = `${stamp}.js`;
        fs.writeFileSync(
            path.join(dir, scriptName),
            `require('fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');\n` +
            `setTimeout(function () {\n` +
            `  require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
            `}, ${delayMs});\n`
        );
        // 명령줄에 따옴표를 넣지 않는다. `spawn('cmd.exe', ['/c', cmd])` 는 cmd
        // 문자열에 공백이 있으면 Node 가 통째로 한 번 더 인용하므로, 안쪽
        // 따옴표가 중첩돼 경로가 그대로 파일명이 돼 버린다(처음 작성 때 실제로
        // "Cannot find module '...\"C:\\...\"'" 로 실패했다). 스크립트가 있는
        // 폴더를 cwd 로 주고 파일명만 넘겨 공백 자체를 없앤다.
        return {
            command: `node ${scriptName}`,
            cwd: dir,
            marker,
            startedMarker,
            cleanup: () => {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
            },
        };
    }

    /** 파일이 생길 때까지 폴링. 고정 sleep 대신 실제 상태를 기다린다. */
    async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(file)) { return true; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    }

    /**
     * 중지가 파이프라인 전체를 확실히 끝내는가 (0.6.36).
     *
     * 0.6.29/0.6.35는 "프롬프트가 열려 있는 순간"만 다뤘고, 그 앞뒤 두 곳을
     * 놓쳤다 — 오류 처리 이후(`continueOnError`)와 대기열 진입 이전이다.
     */
    suite('중지가 continueOnError·대기열보다 우선한다 (0.6.36)', () => {

        test('IT-132: 중지가 셸 래퍼뿐 아니라 그 아래 실제 명령까지 죽인다', async function () {
            this.timeout(30000);
            // child.kill()은 우리가 띄운 cmd.exe / sh 래퍼만 죽인다. Windows의
            // TerminateProcess는 트리를 따라가지 않으므로 래퍼가 사라져도 그
            // 아래 명령이 고아로 남아 계속 돈다.
            //
            // 자손이 살아 있으면 파일을 만드는 명령으로 확인한다: 취소 후
            // 충분히 기다렸는데 파일이 없어야 트리가 죽은 것이다.
            const { command, cwd, marker, startedMarker, cleanup } = makeMarkerScript('tree-kill', 1500);
            const cts = new vscode.CancellationTokenSource();
            try {
                const run = runCommandCaptureLines(command, cwd, 20000, cts.token);
                // 고정 sleep 대신 started 마커를 기다린다 — 느린 CI 에서
                // 아직 뜨지도 않은 프로세스를 죽이고 "잘 죽었다"고 결론내면
                // false positive 가 된다.
                assert.ok(
                    await waitForFile(startedMarker, 10000),
                    '명령이 시작되지 않았다 — 테스트 전제가 깨졌다'
                );
                cts.cancel();
                await assert.rejects(run, /canceled/i);

                // 자손의 타이머(1.5s)를 충분히 넘겨 기다린다.
                await new Promise(resolve => setTimeout(resolve, 2500));
                assert.ok(
                    !fs.existsSync(marker),
                    '셸 래퍼만 죽고 실제 명령이 살아남아 작업을 끝냈다 — 프로세스 트리를 종료해야 한다'
                );
            } finally {
                cts.dispose();
                cleanup();
            }
        });

        test('IT-133: 실제 shell 액션을 중지하면 자손 프로세스도 죽는다', async function () {
            this.timeout(40000);
            // IT-132 는 `runCommandCaptureLines`(항목 생성 명령)만 본다. 실제
            // 액션의 shell/command 실행은 **다른 spawn 지점**이고, POSIX 에서는
            // `detached` 가 없으면 `process.kill(-pid)` 가 ESRCH 로 실패해
            // 래퍼만 죽는다 — 컴파일러·플래셔 같은 자손이 계속 도는 상태였다.
            // 이 테스트가 그 경로를 직접 지난다.
            //
            // **Windows 한계**: 확인해 보니 Windows 는 래퍼(PowerShell/cmd)를
            // 죽이면 콘솔을 공유하는 자손도 함께 사라져, 트리 종료를 되돌려도
            // 이 테스트가 통과한다. 즉 여기서 판별력이 나오는 것은 POSIX 뿐이며
            // (이 수정이 겨냥한 곳도 거기다), Windows 에서는 "중지 후 자손이
            // 남지 않는다"는 사후 조건만 확인하는 셈이다. Linux/macOS CI 에서
            // 돌리면 `detached` 누락을 실제로 잡는다.
            // 스크립트 **하나**로 둔다. `&&` 로 두 명령을 이으면 셸이 그것을
            // 어떻게 실행하느냐(직접 실행 / PowerShell 폴백)에 따라 프로세스
            // 구조가 달라져, 무엇이 자손인지 흐려진다. 한 스크립트가 시작
            // 마커를 즉시 남기고 2.5초 뒤 생존 마커를 남기면 셸 래퍼 → node
            // 관계가 명확하다.
            const script = makeMarkerScript('action-tree', 2500);
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-shell-tree',
                title: 'Stop shell tree',
                action: {
                    description: 'shell wrapper spawns a node descendant',
                    // 리다이렉트를 붙여 **셸을 반드시 거치게** 한다. Windows 는
                    // `node script.js` 처럼 메타문자가 없으면 셸 없이 exe 를
                    // 직접 띄우므로 래퍼가 없고, 그러면 "래퍼만 죽였는가"를
                    // 가릴 수 없다(실제로 이 형태로는 되돌려도 통과했다).
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: `${script.command} > ${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
                        cwd: script.cwd,
                    }],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);

                assert.ok(
                    await waitForFile(script.startedMarker, 10000),
                    '명령이 시작되지 않았다 — 테스트 전제가 깨졌다'
                );

                assert.strictEqual(stopRunningAction('stop-shell-tree'), true);
                await settleWithin(run, 10000, 'IT-133');

                // 자손의 타이머(2.5s)를 충분히 넘겨 기다린다.
                await new Promise(resolve => setTimeout(resolve, 3500));
                assert.ok(
                    !fs.existsSync(script.marker),
                    '중지했는데 자손이 살아남아 작업을 끝냈다 — 셸 래퍼만 죽었다'
                );
            } finally {
                script.cleanup();
            }
        });

        test('IT-130: continueOnError가 사용자 중지를 삼키지 않는다', async function () {
            this.timeout(20000);
            const stub = stubTokenAwareInputBox();
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-continue',
                title: 'Stop vs continueOnError',
                action: {
                    description: 'interactive task tolerates failure',
                    // 태스크를 **하나만** 둔다. 뒤에 태스크가 있으면 대기열
                    // 진입 검사(IT-131의 수정)가 먼저 막아 버려 이 결함이
                    // 가려진다 — 실제로 처음엔 2개짜리로 짰다가 수정을
                    // 되돌려도 통과하는 것을 보고 알아챘다. 마지막(=유일한)
                    // 태스크가 `skipped`로 바뀌면 파이프라인에 실패가 하나도
                    // 남지 않아 액션이 **성공**으로 마감되고, 그 성공 기록이
                    // 방금 쓴 "Action stopped by user"를 덮는다.
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'value?', continueOnError: true },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                await new Promise(resolve => setTimeout(resolve, 50));
                assert.ok(stub.sawToken());

                assert.strictEqual(stopRunningAction('stop-continue'), true);
                await settleWithin(run, 3000, 'IT-130');

                const entries = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(
                    entries[0].status,
                    'failure',
                    'continueOnError가 중지를 skipped로 바꾸면 뒤 태스크가 실행되고 성공 기록이 중지 기록을 덮는다'
                );
                assert.ok(
                    !actionStates.has('stop-continue'),
                    '중지된 액션은 상태 맵에서 지워져야 한다'
                );
            } finally {
                stub.restore();
            }
        });

        test('IT-131: 중지된 액션은 대기열을 빠져나올 때 프롬프트를 열지 않는다', async function () {
            this.timeout(20000);
            // 프롬프트 뮤텍스 뒤에 줄을 선 태스크가 대상이다. 첫 태스크가
            // 대기하는 동안 중지하면, 두 번째 인터랙티브 태스크는 실행 자체가
            // 없어야 한다 — 예전에는 앞 프롬프트가 끝난 뒤 새 대화상자가 떴다.
            const original = vscode.window.showInputBox;
            let promptCount = 0;
            (vscode.window as any).showInputBox = (_o: any, token?: vscode.CancellationToken) => {
                promptCount++;
                return new Promise<string | undefined>(resolve => {
                    if (!token) { resolve(undefined); return; }
                    if (token.isCancellationRequested) { resolve(undefined); return; }
                    token.onCancellationRequested(() => resolve(undefined));
                });
            };
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-queued',
                title: 'Stop queued prompt',
                action: {
                    description: 'two interactive tasks contending for the prompt lock',
                    // **병렬**이어야 대기열이 실제로 생긴다. 순차로 두면 첫
                    // 태스크가 실패한 시점에 스케줄러가 뒤 태스크를 아예
                    // 띄우지 않으므로, 대기열 검사가 없어도 두 번째 프롬프트가
                    // 안 뜬다 — 처음 그렇게 짰다가 수정을 되돌려도 통과하는
                    // 것을 보고 알아챘다.
                    //
                    // 병렬이면 둘 다 launch 되고, 인터랙티브 태스크는 프롬프트
                    // 뮤텍스를 잡으므로 두 번째는 락 뒤에 줄을 선다. 중지로 첫
                    // 프롬프트가 닫혀 락이 풀리는 순간이 문제의 구간이다.
                    tasks: [
                        { id: 'first', type: 'inputBox', prompt: 'one?', parallel: true },
                        { id: 'second', type: 'inputBox', prompt: 'two?', parallel: true },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                await new Promise(resolve => setTimeout(resolve, 50));
                assert.strictEqual(promptCount, 1, '첫 프롬프트가 열려 있어야 한다');

                stopRunningAction('stop-queued');
                await settleWithin(run, 3000, 'IT-131');

                assert.strictEqual(
                    promptCount,
                    1,
                    '중지 후 두 번째 프롬프트가 열렸다 — 대기열을 빠져나올 때 취소를 확인하지 않는다'
                );
            } finally {
                (vscode.window as any).showInputBox = original;
            }
        });
    });
});
