import * as assert from 'assert';
import * as vscode from 'vscode';
import { ActionItem } from '../schema';
import {
    ActionStoppedError,
    MainViewProvider,
    executeAction,
    isActionCancelled,
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
});
