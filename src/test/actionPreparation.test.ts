import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Action, collectRunningActionIds, executeAction, MainViewProvider, registerStopActionCommand, saveActionFolderState } from '../extension';
import { HistoryProvider } from '../providers/historyProvider';
import { actionStates } from '../providers/actionStatus';
import { ActionItem } from '../schema';

suite('액션 준비와 중지 실패 정리', () => {
    function createContext(): vscode.ExtensionContext {
        const state = new Map<string, unknown>();
        const memento = {
            get: (key: string, fallback?: unknown) => state.has(key) ? state.get(key) : fallback,
            update: async (key: string, value: unknown) => { state.set(key, value); },
            keys: () => [...state.keys()],
        };
        return {
            extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [],
            workspaceState: memento, globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    test('폴더 펼침 상태 저장은 false를 보존하고 저장 거부가 이벤트 밖으로 새지 않는다', async () => {
        const context = createContext();
        await saveActionFolderState(context, 'folder', true);
        assert.strictEqual(context.workspaceState.get('folderState:folder'), true);
        await saveActionFolderState(context, 'folder', false);
        assert.strictEqual(context.workspaceState.get('folderState:folder'), false);
        context.workspaceState.update = async () => { throw new Error('storage unavailable'); };
        await assert.doesNotReject(saveActionFolderState(context, 'folder', true));
    });

    test('History 준비 중 예외가 나도 실행 상태를 정리하고 같은 액션을 다시 실행한다', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        assert.ok(workspace, '파일 쓰기 회귀는 실제 워크스페이스 안에서 검증한다');
        const dir = fs.mkdtempSync(path.join(workspace, '.taskhub-preparation-'));
        const context = createContext();
        const result = path.join(dir, 'result.txt');
        const item: ActionItem = { id: 'preparation-failure', title: 'Preparation', action: {
            description: '', tasks: [{ id: 'write', type: 'writeFile', path: result, content: 'restarted' }],
        } };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        const originalAdd = history.addHistoryEntry;
        const originalError = vscode.window.showErrorMessage;
        const failure = new Error('history preparation failed');
        history.addHistoryEntry = () => { throw failure; };
        (vscode.window as any).showErrorMessage = async () => undefined;
        try {
            await assert.rejects(executeAction(item, context, view, history), error => error === failure);
            assert.strictEqual(fs.existsSync(result), false, '준비에 실패하면 태스크를 실행하면 안 된다');
            assert.ok(!collectRunningActionIds().includes(item.id), '실패한 준비의 실행 상태가 남아 있다');
            assert.strictEqual(actionStates.get(item.id)?.state, 'failure');
            history.addHistoryEntry = originalAdd;
            await executeAction(item, context, view, history);
            assert.strictEqual(fs.readFileSync(result, 'utf8'), 'restarted');
            assert.strictEqual(history.getHistory()[0].status, 'success');
            assert.ok(!collectRunningActionIds().includes(item.id));
        } finally {
            history.addHistoryEntry = originalAdd;
            (vscode.window as any).showErrorMessage = originalError;
            view.dispose();
            actionStates.delete(item.id);
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    test('첫 Task 종료 요청이 실패하면 행의 Stop으로 다시 종료할 수 있다', async () => {
        const context = createContext();
        const item: ActionItem = { id: 'retry-stop', title: 'Retry Stop', action: {
            description: '', tasks: [{ id: 'long', type: 'command', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] }],
        } };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        const ended = new vscode.EventEmitter<vscode.TaskProcessEndEvent>();
        const originalExecute = vscode.tasks.executeTask;
        const originalEnd = vscode.tasks.onDidEndTaskProcess;
        const originalRegister = vscode.commands.registerCommand;
        let stop!: (row: Action) => void;
        let execution!: vscode.TaskExecution;
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        let terminateCalls = 0;
        (vscode.tasks as any).onDidEndTaskProcess = ended.event;
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            execution = { task, terminate: () => {
                terminateCalls++;
                if (terminateCalls === 1) { throw new Error('temporary termination failure'); }
            } };
            markStarted();
            return execution;
        };
        (vscode.commands as any).registerCommand = (_id: string, handler: typeof stop) => {
            stop = handler;
            return new vscode.Disposable(() => {});
        };
        const registration = registerStopActionCommand(history);
        const running = executeAction(item, context, view, history);
        try {
            await started;
            // executeTask의 Promise와 등록 콜백이 처리된 다음 사용자 클릭을 보낸다.
            await new Promise<void>(resolve => setImmediate(resolve));
            const row = new Action(item.title, item.action!, vscode.TreeItemCollapsibleState.None, context, item.id);
            stop(row);
            const firstCalls = terminateCalls;
            assert.ok(firstCalls > 0);
            stop(row);
            assert.ok(terminateCalls > firstCalls, '이미 중지를 요청했다는 이유로 재시도를 무시하면 안 된다');
            ended.fire({ execution, exitCode: undefined });
            await running;
            assert.strictEqual(history.getHistory()[0].status, 'cancelled');
            assert.strictEqual(history.getHistory()[0].cancelKind, 'stopped');
            assert.ok(!collectRunningActionIds().includes(item.id));
        } finally {
            if (execution) { ended.fire({ execution, exitCode: undefined }); }
            await running.catch(() => {});
            registration.dispose();
            ended.dispose();
            view.dispose();
            actionStates.delete(item.id);
            (vscode.tasks as any).executeTask = originalExecute;
            (vscode.tasks as any).onDidEndTaskProcess = originalEnd;
            (vscode.commands as any).registerCommand = originalRegister;
        }
    });
});
