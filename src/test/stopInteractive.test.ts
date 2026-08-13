import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionItem } from '../schema';
import {
    ActionStoppedError,
    countPromptCancellations,
    isOnlyPromptCancellation,
    MainViewProvider,
    executeAction,
    isActionCancelled,
    runCommandCaptureLines,
    shouldUntrackTerminatedChild,
    stopRunningAction,
    __testHook_trackedChildProcesses,
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
                'cancelled',
                '사용자 중지는 cancelled 로 마감된다 — 0.6.46 이전에는 failure 였고, 의도적으로 멈춘 것이 진짜 실패와 같은 빨간 아이콘으로 쌓였다'
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
                    'cancelled',
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
                    'cancelled',
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

    /**
     * **자손이 실제로 존재하는** 명령을 만든다. 트리 종료 테스트의 전제다.
     *
     * `makeMarkerScript` 로는 트리를 검증할 수 없다. 우리가 띄우는 것은
     * `sh -c "node x.js"` 인데, 셸은 뒤에 할 일이 없는 단순 명령이면 fork 하지
     * 않고 **exec 해 버린다** — 래퍼가 사라지고 우리가 잡은 pid 가 곧 node 다.
     * 그러면 "래퍼만 죽였는가"를 가릴 자손 자체가 없어, 트리 종료를 통째로
     * 되돌려도 테스트가 통과한다(실측: `ps -o comm=` 가 `sh` 가 아니라 `node`
     * 를 보여주고 직계 자식이 0개다). 리다이렉트(`> /dev/null`)를 붙여도
     * `buildPosixCommandLine` 이 토큰마다 따옴표를 씌워 `'>'` 를 리터럴 인자로
     * 만들기 때문에 마찬가지다.
     *
     * 그래서 셸에 기대지 않고 **node 두 단계**로 트리를 만든다: runner 가
     * worker 를 spawn 하고 살아 있는다. 이것이 실제 결함의 모양이기도 하다 —
     * `make` 나 플래셔가 exec 되어 우리 pid 가 되고, 그것이 fork 한 컴파일러가
     * 고아로 남았다. runner 만 죽이면 worker 가 살아남아 marker 를 쓴다.
     *
     * **판별력의 범위**: macOS 에서 `detached` 를 빼고 IT-132/IT-133 이 실제로
     * 실패하는 것을 양방향으로 확인했다. Windows 는 **미검증**이다 — 그쪽은
     * `detached` 를 애초에 쓰지 않으므로(`taskkill /T` 가 pid 로 트리를 잡는다)
     * 이 테스트가 Windows 에서 거는 것은 `taskkill /T` 전제이지 POSIX 수정이
     * 아니다. Windows 판별력은 실제 러너에서 확인이 필요하다.
     */
    function makeTreeMarkerScript(label: string, delayMs: number): {
        command: string; runnerArgs: string[]; cwd: string; marker: string; startedMarker: string; cleanup: () => void;
    } {
        const stamp = `${process.pid}-${Date.now()}-${label}`;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-treetest-'));
        const marker = path.join(dir, `${stamp}.txt`);
        // 시작 마커는 **worker** 가 쓴다 — 자손이 실제로 떴는지를 기다려야
        // 하기 때문이다. runner 만 보고 중지하면 아직 자손이 없어서 "잘
        // 죽었다"는 잘못된 결론이 난다.
        const startedMarker = path.join(dir, `${stamp}.started`);
        const workerName = `${stamp}-worker.js`;
        const runnerName = `${stamp}-runner.js`;

        fs.writeFileSync(
            path.join(dir, workerName),
            `require('fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');\n` +
            `setTimeout(function () {\n` +
            `  require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
            `}, ${delayMs});\n`
        );
        fs.writeFileSync(
            path.join(dir, runnerName),
            // worker 는 runner 의 `process.execPath` 로 띄운다 — 이 시점의
            // execPath 는 진짜 node 이므로 PATH 조회가 필요 없다. (바깥
            // 명령줄은 여전히 `node <runner>` 라 PATH 에 의존한다. 확장
            // 호스트의 execPath 는 Electron 이라 그쪽에는 쓸 수 없다.)
            // stdio 는 'ignore': worker 가 부모의 stdout 파이프를 붙잡으면
            // runner 를 죽여도 close 가 오지 않아 액션이 끝나지 않는다.
            `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(dir, workerName))}], { stdio: 'ignore' });\n` +
            // runner 가 먼저 끝나 버리면 중지 시점에 죽일 대상이 없다. 반대로
            // 너무 길면 트리 종료가 실패한 실행(=이미 red)에서 스위트가 끝난
            // 뒤까지 남는다 — 판정에 충분하고 뒤끝은 짧은 20초로 둔다.
            `setTimeout(function () { }, 20000);\n`
        );

        return {
            // 메타문자 없는 단순 명령이라 `buildPosixCommandLine` 의 인용을
            // 그대로 통과하고, Windows 에서도 node 를 직접 띄운다.
            command: `node ${runnerName}`,
            // 실제 액션은 실행 파일과 argv를 분리한다. Windows raw shell의
            // 단일 실행 파일 예외도 이 형태에서만 native 경로를 타므로,
            // IT-133은 합쳐진 command 대신 이 값을 사용한다.
            runnerArgs: [runnerName],
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

        test('IT-132: 중지가 우리가 잡은 프로세스뿐 아니라 그 자손까지 죽인다', async function () {
            this.timeout(30000);
            // child.kill()은 우리가 잡은 프로세스 하나만 죽인다. Windows의
            // TerminateProcess는 트리를 따라가지 않고, POSIX는 자식이 다른
            // 프로세스 그룹이면 그룹 종료가 닿지 않는다 — 어느 쪽이든 그 아래
            // 실제 명령이 고아로 남아 계속 돈다.
            //
            // 자손이 살아 있으면 파일을 만드는 명령으로 확인한다: 취소 후
            // 충분히 기다렸는데 파일이 없어야 트리가 죽은 것이다.
            // `makeTreeMarkerScript` 를 쓰는 이유는 그 주석 참조 — 단순 명령은
            // 셸이 exec 해 버려 자손이 아예 생기지 않는다.
            // 자손의 타이머는 **여유 있게** 잡는다. 이 값은 "worker 가 뜬 것을
            // 폴링(50ms 간격)으로 알아채고 → 취소하고 → 트리가 죽기까지" 걸리는
            // 시간보다 커야 한다. 빠듯하면 굶주린 CI 에서 marker 가 먼저 써지고,
            // 그 실패가 트리 종료 회귀와 똑같아 보인다.
            const { command, cwd, marker, startedMarker, cleanup } = makeTreeMarkerScript('tree-kill', 3000);
            const cts = new vscode.CancellationTokenSource();
            try {
                const run = runCommandCaptureLines(command, cwd, 20000, cts.token);
                // 전제 assert 가 던지면 `run` 을 아무도 await 하지 않아 나중에
                // unhandled rejection 이 되고, mocha 가 그것을 **엉뚱한 테스트**
                // 탓으로 돌린다. 미리 삼켜 둔다 (아래 assert.rejects 가 진짜 판정).
                run.catch(() => { /* 아래에서 판정한다 */ });
                // 고정 sleep 대신 started 마커를 기다린다 — 느린 CI 에서
                // 아직 뜨지도 않은 프로세스를 죽이고 "잘 죽었다"고 결론내면
                // false positive 가 된다.
                assert.ok(
                    await waitForFile(startedMarker, 10000),
                    '명령이 시작되지 않았다 — 테스트 전제가 깨졌다'
                );
                cts.cancel();
                await assert.rejects(run, /canceled/i);

                // 자손의 타이머(3s)를 충분히 넘겨 기다린다.
                await new Promise(resolve => setTimeout(resolve, 4000));
                assert.ok(
                    !fs.existsSync(marker),
                    '우리가 잡은 프로세스만 죽고 그 자손이 살아남아 작업을 끝냈다 — 프로세스 트리를 종료해야 한다'
                );
            } finally {
                cts.dispose();
                cleanup();
            }
        });

        test('IT-133: 실제 shell 액션을 중지하면 자손 프로세스도 죽는다', async function () {
            this.timeout(40000);
            // IT-132 는 `runCommandCaptureLines`(항목 생성 명령)만 본다. 실제
            // 액션의 shell/command 실행은 **다른 spawn 지점**(extension.ts 의
            // POSIX 분기)이고, `detached` 가 없으면 `process.kill(-pid)` 가
            // ESRCH 로 실패해 우리가 잡은 프로세스만 죽는다 — 컴파일러·플래셔
            // 같은 자손이 계속 도는 상태였다. 이 테스트가 그 경로를 직접 지난다.
            //
            // 자손 구조는 **셸에 기대지 않고** node runner → node worker 로
            // 만든다. 예전에는 `node x.js > /dev/null` 로 "셸을 반드시 거치게"
            // 했다고 적어 두었지만 실제로는 그렇지 않았다:
            // `buildPosixCommandLine` 이 토큰마다 따옴표를 씌워 `'>'` 가 리터럴
            // 인자가 되고, 메타문자가 없어진 단순 명령을 셸이 exec 해 버려
            // 자손이 아예 생기지 않았다. 그래서 `detached` 를 통째로 빼도 이
            // 테스트가 통과했다. 자세한 근거는 `makeTreeMarkerScript` 주석 참조.
            const script = makeTreeMarkerScript('action-tree', 2500);
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-shell-tree',
                title: 'Stop shell tree',
                action: {
                    description: 'command spawns a node descendant',
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: 'node',
                        args: script.runnerArgs,
                        cwd: script.cwd,
                        // **필수**. 이게 없으면 shell 태스크는 `executeStreamedTask`
                        // → `vscode.tasks.executeTask` 로 가고, 중지는 VS Code 의
                        // 터미널 종료가 처리한다 — 우리 `spawn` 도 `killProcessTree`
                        // 도 지나지 않는다. 실제로 예전 형태의 이 테스트는
                        // `killProcessTree` 를 **한 번도 호출하지 않은 채** 통과하고
                        // 있었다. `passTheResultToNextTask` 를 켜야
                        // `handleCommand` → `executeShellCommand` 의 spawn 경로로
                        // 들어가고, 그곳이 이 수정이 `detached` 를 넣은 자리다.
                        passTheResultToNextTask: true,
                    }],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                // 전제 assert 가 던지면 `run` 이 미처리 거부로 남아 뒤의 다른
                // 테스트 실패로 둔갑한다 — 아래 settleWithin 이 진짜 판정이다.
                run.catch(() => { /* settleWithin 이 판정한다 */ });

                assert.ok(
                    await waitForFile(script.startedMarker, 10000),
                    '명령이 시작되지 않았다 — 테스트 전제가 깨졌다'
                );

                // 이 반환값 자체는 약한 신호다 — `stopRunningAction` 은
                // 취소 토큰 분기만으로도 true 를 준다. 실제 판정은 아래
                // marker 검사다.
                assert.strictEqual(stopRunningAction('stop-shell-tree'), true);
                await settleWithin(run, 10000, 'IT-133');

                // 자손의 타이머(2.5s)를 충분히 넘겨 기다린다.
                await new Promise(resolve => setTimeout(resolve, 3500));
                assert.ok(
                    !fs.existsSync(script.marker),
                    '중지했는데 자손이 살아남아 작업을 끝냈다 — 우리가 잡은 프로세스만 죽었다'
                );
            } finally {
                script.cleanup();
            }
        });

        test('IT-134: passTheResultToNextTask 없는 shell 태스크도 중지가 끝낸다', async function () {
            this.timeout(40000);
            // IT-133 이 `passTheResultToNextTask: true` 로 spawn 경로를 타면서
            // **기본 경로가 무주공산이 됐다**. `passTheResultToNextTask` 가
            // 없는 shell 태스크는 `executeStreamedTask` →
            // `vscode.tasks.executeTask` 로 가고, 중지는 우리 registry 가
            // 아니라 `activeTasks` 의 `exec.terminate()` 가 처리한다
            // (extension.ts 의 `stopRunningAction` 첫 분기). 그 분기에 닿는
            // 테스트는 예전 IT-133 이 유일했다.
            //
            // 여기서는 **자손 종료를 주장하지 않는다** — 터미널의 주인은 VS
            // Code 라 프로세스 트리가 우리 손을 떠나 있다. 이 테스트가 거는
            // 계약은 "스트리밍 태스크도 중지로 확실히 끝나고 실패로 기록된다"
            // 하나다.
            const script = makeTreeMarkerScript('streamed-stop', 3000);
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-streamed',
                title: 'Stop streamed task',
                action: {
                    description: 'streamed shell task (vscode.tasks path)',
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: script.command,
                        cwd: script.cwd,
                    }],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                run.catch(() => { /* settleWithin 이 판정한다 */ });

                assert.ok(
                    await waitForFile(script.startedMarker, 15000),
                    '스트리밍 태스크가 시작되지 않았다 — 테스트 전제가 깨졌다'
                );

                assert.strictEqual(stopRunningAction('stop-streamed'), true);
                await settleWithin(run, 15000, 'IT-134');

                const entries = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(
                    entries[0].status,
                    'cancelled',
                    '중지된 스트리밍 태스크가 성공으로 기록되면 사용자는 빌드가 끝난 줄 안다'
                );
                assert.ok(
                    !actionStates.has('stop-streamed'),
                    '중지된 액션은 상태 맵에서 지워져야 한다'
                );
            } finally {
                script.cleanup();
            }
        });

        test('IT-136: password 입력이 명령 이력에 평문으로 남지 않는다', async function () {
            this.timeout(20000);
            // `shouldRecordTaskInput` 이 password 입력 **자체**는 이력에서 빼
            // 준다. 그런데 그 값을 `${ask.output}` 으로 명령에 보간하면 보간이
            // 끝난 명령줄이 `recordCommands` 로 workspace 이력에 평문 저장됐다
            // — 가려 둔 값이 옆문으로 새는 셈이었다.
            const SECRET = 'hunter2-super-secret';
            const original = vscode.window.showInputBox;
            (vscode.window as any).showInputBox = () => Promise.resolve(SECRET);

            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'secret-leak',
                title: 'Secret leak',
                action: {
                    description: 'password value flows into a command',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        // 실제로 돌지 않아도 된다 — 기록은 실행 **전에** 남는다.
                        { id: 'use', type: 'shell', command: 'echo ${ask.value}' },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            try {
                const run = executeAction(actionItem, context, mainView, history);
                run.catch(() => { /* 명령 실행 성패는 이 테스트의 관심이 아니다 */ });
                await settleWithin(run, 15000, 'IT-136').catch(() => { /* 위와 같음 */ });

                const entries = history.getHistory();
                assert.strictEqual(entries.length, 1);
                const recorded = JSON.stringify(entries[0].commands ?? {});
                assert.ok(
                    !recorded.includes(SECRET),
                    `password 값이 명령 이력에 평문으로 남았다: ${recorded}`
                );
                assert.ok(
                    recorded.includes('***'),
                    `가림 자리표시자가 없다 — 기록 자체가 안 된 것인지 확인이 필요하다: ${recorded}`
                );
            } finally {
                (vscode.window as any).showInputBox = original;
            }
        });

        test('IT-135: 중지 후 완주한 액션이 성공으로 이력을 덮지 않는다', async function () {
            this.timeout(20000);
            // 취소 신호를 받지 않는 작업(0.6.46 이전의 내장 ZIP/Unzip 이 그랬다)
            // 이 단독 태스크이거나 마지막 태스크면, 중지 이후에도 끝까지 돌고
            // 파이프라인이 **성공**으로 마감된다. 그러면 방금 기록한
            // "Action stopped by user" 를 성공이 덮어써서, 사용자는 중지가
            // 무시된 것도 모른 채 성공했다고 읽는다. 실패 경로에는 예전부터
            // 같은 가드가 있었는데 성공 경로에만 없었다.
            //
            // 여기서는 "취소를 무시하고 완주하는 태스크"를 stringManipulation
            // 으로 흉내 낸다 — 프로세스도 토큰도 없이 즉시 성공하는 태스크라,
            // 중지를 누른 직후에도 파이프라인이 그대로 완주한다.
            const context = makeContext();
            const actionItem: ActionItem = {
                id: 'stop-then-succeed',
                title: 'Stop then succeed',
                action: {
                    description: 'task completes despite the stop request',
                    tasks: [
                        { id: 'work', type: 'stringManipulation', function: 'trim', input: '  x  ' },
                    ],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            const run = executeAction(actionItem, context, mainView, history);
            run.catch(() => { /* 아래에서 판정한다 */ });
            // 파이프라인이 돌기 시작한 직후에 중지한다.
            stopRunningAction('stop-then-succeed');
            await settleWithin(run, 10000, 'IT-135');

            const entries = history.getHistory();
            assert.strictEqual(entries.length, 1);
            assert.notStrictEqual(
                entries[0].status,
                'success',
                '중지를 눌렀는데 성공으로 기록됐다 — 사용자는 중지가 무시된 것을 알 수 없다'
            );
        });

        test('IT-137: 중지와 진짜 실패가 서로 다른 상태로 기록된다', async function () {
            this.timeout(20000);
            // 0.6.46 이전에는 둘 다 `failure` 였다. 사용자가 의도해서 멈춘 것이
            // 진짜 실패와 같은 빨간 오류 아이콘으로 History 에 쌓여, 목록을
            // 훑을 때 구분이 되지 않았다. 두 경로가 **갈라지는지**를 본다 —
            // 한쪽만 보면 둘 다 같은 값으로 바뀌어도 통과한다.
            const failing: ActionItem = {
                id: 'really-fails',
                title: 'Really fails',
                action: {
                    description: 'a task that genuinely fails',
                    tasks: [{ id: 'boom', type: 'shell', command: 'node --this-flag-does-not-exist', passTheResultToNextTask: true }],
                },
            } as unknown as ActionItem;

            const failCtx = makeContext();
            const failHistory = new HistoryProvider(failCtx);
            await executeAction(failing, failCtx, new MainViewProvider(failCtx, () => [failing]), failHistory)
                .catch(() => { /* 실패가 이 테스트의 전제다 */ });
            const failStatus = failHistory.getHistory()[0]?.status;

            const stopped: ActionItem = {
                id: 'gets-stopped',
                title: 'Gets stopped',
                action: {
                    description: 'stopped by the user',
                    tasks: [{ id: 'work', type: 'stringManipulation', function: 'trim', input: '  x  ' }],
                },
            } as unknown as ActionItem;
            const stopCtx = makeContext();
            const stopHistory = new HistoryProvider(stopCtx);
            const run = executeAction(stopped, stopCtx, new MainViewProvider(stopCtx, () => [stopped]), stopHistory);
            run.catch(() => { /* 아래에서 판정한다 */ });
            stopRunningAction('gets-stopped');
            await settleWithin(run, 10000, 'IT-137');
            const stopStatus = stopHistory.getHistory()[0]?.status;

            assert.strictEqual(failStatus, 'failure', '진짜 실패가 failure 로 기록되지 않는다');
            assert.strictEqual(stopStatus, 'cancelled', '사용자 중지가 cancelled 로 기록되지 않는다');
            assert.notStrictEqual(
                stopStatus,
                failStatus,
                '중지와 실패가 같은 상태로 기록되면 History 에서 구분되지 않는다'
            );
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
                    'cancelled',
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

    /**
     * 프롬프트 취소는 **실패가 아니다** (0.6.52).
     *
     * Stop 버튼은 0.6.46 에서 `cancelled` 로 갈렸는데, 다이얼로그를 Escape 로
     * 닫는 것 — 똑같이 의도된 "됐어요" — 은 계속 실패로 마감됐다: 빨간 오류
     * 토스트, History `failure`, 트리의 ✗. 게다가 메시지가 영어라 한국어 UI 에
     * 섞였다. 이 suite 는 그 마감이 갈라지는지, 그리고 **진짜 실패를 삼키지는
     * 않는지**를 함께 본다 — 한쪽만 보면 전부 `cancelled` 로 뭉개도 통과한다.
     */
    suite('프롬프트 취소의 마감', () => {

        function cancellingAction(id: string): ActionItem {
            return {
                id,
                title: `Cancelled ${id}`,
                action: {
                    description: 'user closes the prompt',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'value?' },
                        // 뒤 태스크가 있어야 "취소했는데 계속 실행됐다"를 구분할 수 있다.
                        { id: 'after', type: 'stringManipulation', function: 'trim', input: 'should-not-run' },
                    ],
                },
            } as unknown as ActionItem;
        }

        /** `showInputBox` 를 즉시 취소(undefined)로 만든다. */
        function stubCancelledInputBox(): () => void {
            const original = vscode.window.showInputBox;
            (vscode.window as any).showInputBox = async () => undefined;
            return () => { (vscode.window as any).showInputBox = original; };
        }

        /** 오류 토스트가 떴는지 관찰한다. */
        function stubErrorMessage(): { calls: string[]; restore: () => void } {
            const original = vscode.window.showErrorMessage;
            const calls: string[] = [];
            (vscode.window as any).showErrorMessage = async (msg: string) => { calls.push(msg); return undefined; };
            return { calls, restore: () => { (vscode.window as any).showErrorMessage = original; } };
        }

        /** 정보 토스트가 떴는지 관찰한다. */
        function stubInformationMessage(): { calls: string[]; restore: () => void } {
            const original = vscode.window.showInformationMessage;
            const calls: string[] = [];
            (vscode.window as any).showInformationMessage = async (msg: string) => { calls.push(msg); return undefined; };
            return { calls, restore: () => { (vscode.window as any).showInformationMessage = original; } };
        }

        test('IT-138: 프롬프트를 닫으면 오류 토스트 없이 cancelled 로 마감된다', async function () {
            this.timeout(20000);
            const restoreInput = stubCancelledInputBox();
            const toasts = stubErrorMessage();
            const infos = stubInformationMessage();
            try {
                const context = makeContext();
                const actionItem = cancellingAction('prompt-cancel');
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                // 던지지 않아야 한다 — 던지면 호출부가 `[ERROR] Execution failed`
                // 를 남기고, 사용자는 자기가 닫은 다이얼로그 때문에 오류를 본다.
                await executeAction(actionItem, context, mainView, history);

                const entry = history.getHistory()[0];
                assert.strictEqual(entry?.status, 'cancelled', '프롬프트 취소가 cancelled 로 기록되지 않았다');
                assert.strictEqual(entry?.cancelKind, 'prompt', '중지와 구분되는 cancelKind 가 붙지 않았다');
                assert.deepStrictEqual(toasts.calls, [], '취소인데 오류 토스트가 떴다');
                assert.deepStrictEqual(
                    infos.calls, [],
                    '실행을 마친 태스크가 없는데 안내가 떴다 — 진행도 카운터는 취소된 프롬프트까지 "완료"로 세므로 그대로 쓰면 안 된다'
                );
                assert.ok(
                    !actionStates.has('prompt-cancel'),
                    '상태가 남으면 트리에 스피너가 영원히 돈다 (finalizeActionRun 은 중지된 액션만 지운다)'
                );
            } finally {
                infos.restore();
                toasts.restore();
                restoreInput();
            }
        });

        test('IT-145: 앞선 태스크가 실제로 실행됐을 때만, 그 개수만큼만 안내한다', async function () {
            this.timeout(20000);
            // 진행도 카운터(`ActionProgress.completed`)는 `running` 이 아닌 모든
            // 종료 전이에서 올라간다 — 취소된 프롬프트도 `failure` 전이를 낸다.
            // 그 값을 그대로 쓰면 (a) 프롬프트가 첫 태스크인 액션에서도 안내가
            // 뜨고 (b) 개수가 항상 1 크다. 번들 예제는 대부분 프롬프트가 먼저라
            // (a) 가 기본 경험이었다.
            const restoreInput = stubCancelledInputBox();
            const infos = stubInformationMessage();
            try {
                const context = makeContext();
                const actionItem: ActionItem = {
                    id: 'ran-before-cancel',
                    title: 'Ran before cancel',
                    action: {
                        description: 'one task really runs, then a prompt is cancelled',
                        tasks: [
                            { id: 'first', type: 'stringManipulation', function: 'trim', input: '  x  ' },
                            { id: 'ask', type: 'inputBox', prompt: 'value?' },
                            { id: 'never', type: 'stringManipulation', function: 'trim', input: '  y  ' },
                        ],
                    },
                } as unknown as ActionItem;
                const history = new HistoryProvider(context);
                await executeAction(actionItem, context, new MainViewProvider(context, () => [actionItem]), history);

                assert.strictEqual(infos.calls.length, 1, '실행된 태스크가 있는데 안내가 뜨지 않았다');
                assert.match(
                    infos.calls[0],
                    /(전체 3개 중 이미 실행된 1개|1 of 3 tasks)/,
                    `실행 개수가 틀렸다 (취소된 프롬프트까지 세면 2가 된다): ${infos.calls[0]}`
                );
            } finally {
                infos.restore();
                restoreInput();
            }
        });

        test('IT-139: 중지와 프롬프트 취소는 같은 cancelled 안에서도 구분된다', async function () {
            this.timeout(20000);
            // History 는 `cancelled` 를 "중지됨 / Stopped" 로 렌더한다. 프롬프트를
            // 닫은 것을 "중지됨"이라 부르면 사실과 다르고, 스크린 리더에는 그
            // 한 단어가 유일한 설명이라 더 나쁘다.
            const restoreInput = stubCancelledInputBox();
            let promptKind: string | undefined;
            try {
                const context = makeContext();
                const actionItem = cancellingAction('kind-prompt');
                const history = new HistoryProvider(context);
                await executeAction(actionItem, context, new MainViewProvider(context, () => [actionItem]), history);
                promptKind = history.getHistory()[0]?.cancelKind;
            } finally {
                restoreInput();
            }

            const stopped: ActionItem = {
                id: 'kind-stopped',
                title: 'Gets stopped',
                action: {
                    description: 'stopped by the user',
                    tasks: [{ id: 'work', type: 'stringManipulation', function: 'trim', input: '  x  ' }],
                },
            } as unknown as ActionItem;
            const stopCtx = makeContext();
            const stopHistory = new HistoryProvider(stopCtx);
            const run = executeAction(stopped, stopCtx, new MainViewProvider(stopCtx, () => [stopped]), stopHistory);
            run.catch(() => { /* 아래에서 판정한다 */ });
            stopRunningAction('kind-stopped');
            await settleWithin(run, 10000, 'IT-139');
            const stopKind = stopHistory.getHistory()[0]?.cancelKind;

            assert.strictEqual(promptKind, 'prompt');
            assert.strictEqual(stopKind, 'stopped');
            assert.notStrictEqual(promptKind, stopKind, '두 취소가 구분되지 않으면 History 문구가 한쪽에 대해 거짓말한다');
        });

        test('IT-140: 취소와 진짜 실패가 섞이면 실패로 마감된다 (취소가 오류를 삼키지 않는다)', async function () {
            this.timeout(20000);
            // **동시성 설정을 고정한다.** 이 시나리오는 두 태스크가 같은 스케줄
            // 회차에 떠서 실패들이 AggregateError 로 묶이는 것을 전제로 한다.
            // `taskhub.pipeline.maxParallelTasks` 가 1이면 `ask` 가 먼저 실패해
            // 스케줄러가 abort 되고 `boom` 은 아예 뜨지 않는다 — 오류가 취소
            // 하나뿐이 되어 판정이 `cancelled` 로 **조용히 뒤집힌다**. 기본값이
            // 4라 지금은 통과하지만, 그것에 기대는 테스트는 언제든 뒤집힌다.
            const config = vscode.workspace.getConfiguration('taskhub');
            const previous = config.get<number>('pipeline.maxParallelTasks');
            await config.update('pipeline.maxParallelTasks', 4, vscode.ConfigurationTarget.Global);
            const restoreInput = stubCancelledInputBox();
            try {
                const context = makeContext();
                const actionItem: ActionItem = {
                    id: 'mixed-cancel',
                    title: 'Mixed',
                    action: {
                        description: 'a cancelled prompt AND a genuine failure',
                        tasks: [
                            { id: 'ask', type: 'inputBox', prompt: 'value?', parallel: true },
                            { id: 'boom', type: 'shell', command: 'node --this-flag-does-not-exist', parallel: true, passTheResultToNextTask: true },
                        ],
                    },
                } as unknown as ActionItem;
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                let raised: unknown;
                await executeAction(actionItem, context, mainView, history)
                    .catch((e: unknown) => { raised = e; });

                // 전제부터 확인한다 — 여기서 걸리면 "판정이 틀렸다"가 아니라
                // "시나리오가 성립하지 않았다"는 뜻이고, 그 둘은 원인이 다르다.
                assert.ok(
                    isOnlyPromptCancellation(raised) === false && countPromptCancellations(raised) === 1,
                    `전제 불성립: 취소 1건 + 진짜 실패 1건이 함께 올라와야 한다 (동시 실행이 되지 않았을 수 있다). 실제: ${String(raised)}`
                );
                assert.strictEqual(
                    history.getHistory()[0]?.status,
                    'failure',
                    '취소가 섞였다는 이유로 진짜 실패를 cancelled 로 뭉개면 사용자가 오류를 놓친다'
                );
            } finally {
                restoreInput();
                await config.update('pipeline.maxParallelTasks', previous, vscode.ConfigurationTarget.Global);
            }
        });

        test('IT-141: continueOnError 가 있으면 취소해도 뒤 태스크가 실행된다', async function () {
            this.timeout(20000);
            // 문서화된 계약("취소를 허용하려면 continueOnError"). 취소를 새 타입으로
            // 분류하면서 **태스크 수준에서는 여전히 실패**로 남겨 둔 이유가 이것이다.
            //
            // "뒤 태스크가 돌았는가" 는 마감 상태로 읽는다 — 돌았다면 액션이
            // 끝까지 가 `success` 가 되고, 취소가 끊었다면 `cancelled` 가 된다.
            // 파일 마커는 쓸 수 없다: `writeFile` 은 워크스페이스 밖 경로를
            // 거부하므로(resolveWithinWorkspace) 마커 자체가 실패한다.
            const restoreInput = stubCancelledInputBox();
            try {
                const context = makeContext();
                const actionItem: ActionItem = {
                    id: 'continue-on-cancel',
                    title: 'Continue on cancel',
                    action: {
                        description: 'cancel is tolerated',
                        tasks: [
                            { id: 'ask', type: 'inputBox', prompt: 'value?', continueOnError: true },
                            { id: 'after', type: 'stringManipulation', function: 'trim', input: '  ran  ' },
                        ],
                    },
                } as unknown as ActionItem;
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await executeAction(actionItem, context, mainView, history).catch(() => { /* 아래에서 판정한다 */ });

                assert.strictEqual(
                    history.getHistory()[0]?.status,
                    'success',
                    'continueOnError 가 있는데도 취소가 파이프라인을 끊었다 — 문서화된 계약이 깨졌다'
                );
            } finally {
                restoreInput();
            }
        });
    });
});


/**
 * 종료 실패를 registry 가 삼키던 문제 (0.6.46).
 *
 * `killProcessTree` 는 timeout·권한 문제·`ESRCH` 로 실패해도 resolve 한다.
 * 예전에는 그 결과와 무관하게 registry 에서 지워서, **아직 살아 있는**
 * 프로세스가 *Stop All* 의 시야에서 사라졌다 — 첫 Stop 이 실패한 것을 알
 * 방법도, 다시 시도할 방법도 없었다.
 *
 * 실제로 SIGKILL 을 견디는 프로세스를 만들 수는 없으므로(그 시그널은 잡을 수
 * 없다) 판단 규칙 자체를 검증한다.
 */
suite('종료 실패 시 프로세스 추적 유지', () => {
    test('정상 종료 코드로 끝났으면 추적을 해제한다', () => {
        assert.strictEqual(
            shouldUntrackTerminatedChild({ exitCode: 0, signalCode: null }), true);
        assert.strictEqual(
            shouldUntrackTerminatedChild({ exitCode: 137, signalCode: null }), true);
    });

    test('시그널로 끝났으면 추적을 해제한다', () => {
        assert.strictEqual(
            shouldUntrackTerminatedChild({ exitCode: null, signalCode: 'SIGKILL' }), true);
    });

    test('아직 살아 있으면 추적을 유지한다', () => {
        // 이것이 핵심이다. 여기서 true 를 돌려주면 죽지 않은 프로세스가
        // Stop All 대상 목록에서 사라진다.
        assert.strictEqual(
            shouldUntrackTerminatedChild({ exitCode: null, signalCode: null }),
            false,
            '종료가 확인되지 않았는데 추적을 해제하면 Stop All 이 다시 찾지 못한다'
        );
    });

    /**
     * 위 규칙을 `ChildProcess.error` 가 옆문으로 무효화하던 문제.
     *
     * Node 는 'error' 를 **spawn 실패**(프로세스가 없다)뿐 아니라 **kill 신호
     * 전달 실패**(프로세스는 살아 있다)에서도 낸다. 핸들러가 생존 여부와 무관하게
     * 먼저 추적을 해제하고 있어서, 후자에서 살아남은 flash/deploy 프로세스가
     * *Stop All* 의 시야에서 사라졌다.
     *
     * 규칙만 보는 위 세 케이스로는 이 경로가 드러나지 않는다 — 실제로 프로세스를
     * 띄우고 error 를 흘려 registry 를 직접 본다.
     */
    suite('spawn 이후의 error 는 추적을 지우지 않는다', () => {
        function makeContext(): vscode.ExtensionContext {
            const store = new Map<string, unknown>();
            const memento = {
                get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
                update: async (k: string, v: unknown) => { store.set(k, v); },
                keys: () => Array.from(store.keys()),
                setKeysForSync: () => { /* no-op */ },
            };
            return {
                extensionPath: os.tmpdir(),
                subscriptions: [],
                workspaceState: memento,
                globalState: memento,
                extensionMode: vscode.ExtensionMode.Test,
                extension: { packageJSON: { version: '0.0.0-child-error-test' } },
            } as unknown as vscode.ExtensionContext;
        }

        /**
         * 확장 호스트에서 `process.execPath` 는 **Electron** 이다. 그것을
         * `-e` 로 띄우면 (ELECTRON_RUN_AS_NODE 없이) 곧바로 끝나 버리고,
         * 'close' 가 추적을 정리한 뒤에 error 를 흘리게 되어 이 테스트가
         * 제품 결함과 무관하게 실패한다. 파일의 다른 테스트와 같이 PATH 의
         * `node` 로 스크립트를 띄우고, **started 마커로 살아 있음을 확인한
         * 뒤에** 손을 댄다.
         */
        function makeSleeperScript(label: string, delayMs: number): {
            command: string; cwd: string; startedMarker: string; cleanup: () => void;
        } {
            const stamp = `${process.pid}-${Date.now()}-${label}`;
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-childerr-'));
            const startedMarker = path.join(dir, `${stamp}.started`);
            const scriptName = `${stamp}.js`;
            fs.writeFileSync(
                path.join(dir, scriptName),
                `require('fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started');\n` +
                `setTimeout(function () {}, ${delayMs});\n`
            );
            return {
                command: `node ${scriptName}`,
                cwd: dir,
                startedMarker,
                cleanup: () => {
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
                },
            };
        }

        /** 위 suite 의 동명 헬퍼는 그 suite 스코프 안에 있어 여기서 못 쓴다. */
        async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (fs.existsSync(file)) { return true; }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        }

        test('kill 실패로 온 error 뒤에도 Stop All 이 프로세스를 찾는다', async function () {
            this.timeout(30000);
            const actionId = 'child-error-keeps-tracking';
            const script = makeSleeperScript('child-error', 20000);
            const context = makeContext();
            const actionItem: ActionItem = {
                id: actionId,
                title: 'Child error keeps tracking',
                action: {
                    description: 'long-running child',
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: script.command,
                        cwd: script.cwd,
                        // capture 경로(`executeShellCommand`)의 spawn 을 타야
                        // 이 error 핸들러를 지난다 — IT-133 주석 참조.
                        passTheResultToNextTask: true,
                    }],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            const run = executeAction(actionItem, context, mainView, history);
            run.catch(() => { /* 아래에서 판정한다 */ });

            try {
                assert.ok(
                    await waitForFile(script.startedMarker, 15000),
                    '자식이 시작되지 않았다 — 테스트 전제가 깨졌다'
                );
                const tracked = __testHook_trackedChildProcesses(actionId);
                assert.strictEqual(tracked.length, 1, '살아 있는 자식이 추적되지 않았다 — 테스트 전제가 깨졌다');
                const child = tracked[0];

                // Node 가 "kill 신호를 전달하지 못했다" 고 알릴 때와 같은 모양.
                // 프로세스는 **여전히 살아 있다**.
                child.emit('error', Object.assign(new Error('kill failed'), { code: 'EPERM' }));

                assert.strictEqual(
                    __testHook_trackedChildProcesses(actionId).length, 1,
                    'error 하나로 살아 있는 프로세스가 Stop All 의 시야에서 사라졌다'
                );
                assert.strictEqual(child.killed, false, '테스트 전제: 프로세스는 아직 살아 있어야 한다');
            } finally {
                stopRunningAction(actionId);
                await Promise.race([
                    run.catch(() => undefined),
                    new Promise(resolve => setTimeout(resolve, 5000)),
                ]);
                for (const leftover of __testHook_trackedChildProcesses(actionId)) {
                    try { leftover.kill('SIGKILL'); } catch { /* best effort */ }
                }
                script.cleanup();
            }
        });

        /**
         * 위 케이스의 짝. 이것이 없으면 `error` 핸들러에서 해제를 **통째로**
         * 빼도 전체 스위트가 통과한다(리뷰에서 실측). spawn 이 실패했을 때는
         * 프로세스가 없으므로 추적에 남기면 Stop All 이 죽은 항목을 붙잡는다.
         */
        test('spawn 자체가 실패하면 추적에 남기지 않는다', async function () {
            this.timeout(30000);
            const actionId = 'child-spawn-failure-untracks';
            const context = makeContext();
            const actionItem: ActionItem = {
                id: actionId,
                title: 'Spawn failure untracks',
                action: {
                    description: 'cwd does not exist',
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: 'node --version',
                        // 없는 디렉터리를 cwd 로 주면 spawn 이 ENOENT 로 실패한다
                        // ('spawn' 이벤트 없이 'error' 만 온다).
                        cwd: path.join(os.tmpdir(), `taskhub-missing-${Date.now()}`),
                        passTheResultToNextTask: true,
                    }],
                },
            } as unknown as ActionItem;
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            await executeAction(actionItem, context, mainView, history).catch(() => { /* 실패가 정상 */ });

            assert.strictEqual(
                __testHook_trackedChildProcesses(actionId).length, 0,
                '뜨지도 못한 프로세스가 Stop All 대상으로 남았다'
            );
        });
    });

});
