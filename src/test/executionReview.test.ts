import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    Action, MainViewProvider, executeAction, executeActionPipeline,
    executeShellCommand, registerStopActionCommand, TaskTransitionEvent,
} from '../extension';
import { Action as PipelineAction, ActionItem, Task } from '../schema';
import { HistoryProvider } from '../providers/historyProvider';
import { actionStates } from '../providers/actionStatus';
import { buildBuiltinVariableContext } from '../builtinVariables';
import { ActionRunLogCollector } from '../runLogStore';
import { TaskScheduler } from '../pipelineUtils';

suite('실행 경계 회귀', function () {
    this.timeout(15000);
    let workspace: string;
    let context: vscode.ExtensionContext;

    setup(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-execution-review-'));
        const state = new Map<string, unknown>();
        const memento = {
            get: (key: string, fallback?: unknown) => state.has(key) ? state.get(key) : fallback,
            update: async (key: string, value: unknown) => { state.set(key, value); },
            keys: () => [...state.keys()],
        };
        context = {
            extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [],
            workspaceState: memento, globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } },
        } as unknown as vscode.ExtensionContext;
    });

    teardown(() => {
        actionStates.clear();
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    function run(action: PipelineAction, options: Parameters<typeof executeActionPipeline>[5] = {}): Promise<void> {
        return executeActionPipeline(action, context, 'review', workspace, [workspace], {
            builtinVariables: buildBuiltinVariableContext({
                workspaceFolder: workspace, extensionPath: context.extensionPath,
                environment: {}, strict: true,
            }),
            ...options,
        });
    }

    for (const type of ['command', 'shell'] as const) {
        test(`${type} 캡처는 stdin EOF를 전달해 입력 없는 명령을 종료한다`, async () => {
            fs.writeFileSync(path.join(workspace, 'stdin.cjs'),
                "const fs = require('fs'); process.stdout.write('eof:' + fs.readFileSync(0, 'utf8').length);");
            const output = path.join(workspace, 'result.txt');
            await run({ description: '', tasks: [{
                id: 'read', type, command: 'node', args: ['stdin.cjs'], timeoutSeconds: 3,
                passTheResultToNextTask: true, output: { mode: 'file', filePath: output },
            }] });
            assert.strictEqual(fs.readFileSync(output, 'utf8'), 'eof:0');
        });
    }

    for (const selector of ['when', 'switch'] as const) {
        function failingTask(continueOnError: boolean): Task {
            const common = { id: 'bad', parallel: true, continueOnError };
            return selector === 'when'
                ? { ...common, type: 'stringManipulation', function: 'trim', input: 'x', when: { var: '${env:MISSING}', equals: 'x' } }
                : { ...common, type: 'switch', on: '${env:MISSING}', cases: { x: { type: 'stringManipulation', function: 'trim', input: 'x' } } };
        }

        test(`${selector} 평가 실패도 continueOnError와 로그·진행 상태를 따른다`, async () => {
            const action: PipelineAction = { description: '', tasks: [failingTask(true), {
                id: 'after', type: 'writeFile', path: 'after.txt', content: 'continued',
            }] };
            const collector = new ActionRunLogCollector('review', 'review', Date.now(), action.tasks);
            const transitions: TaskTransitionEvent[] = [];
            await run(action, { runLogCollector: collector, onTaskTransition: e => transitions.push(e) });
            assert.strictEqual(fs.readFileSync(path.join(workspace, 'after.txt'), 'utf8'), 'continued');
            assert.ok(transitions.some(e => e.taskId === 'bad' && e.state === 'skipped'));
            const failed = collector.finish('success', Date.now()).tasks.find(t => t.taskId === 'bad')!;
            assert.strictEqual(failed.status, 'continued');
            assert.strictEqual(failed.errorCode, 'sensitive-hidden');
            assert.ok(failed.error && !failed.error.includes('MISSING'), '환경변수 조건의 오류는 기존 민감정보 정책대로 가린다');
        });

        test(`${selector} 평가 실패 후에도 이미 시작한 병렬 형제가 끝날 때까지 추적한다`, async () => {
            const original = vscode.window.showOpenDialog;
            let release!: (value: vscode.Uri[] | undefined) => void;
            let opened!: () => void;
            const shown = new Promise<void>(resolve => { opened = resolve; });
            const dialog = new Promise<vscode.Uri[] | undefined>(resolve => { release = resolve; });
            (vscode.window as any).showOpenDialog = () => { opened(); return dialog; };
            let settled = false;
            const execution = run({ description: '', tasks: [
                { id: 'dialog', type: 'fileDialog', parallel: true }, failingTask(false),
            ] }).then(() => { settled = true; }, error => { settled = true; return error as Error; });
            try {
                await shown;
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.strictEqual(settled, false, '형제 대화상자가 남아 있는데 실행 추적을 종료했다');
                release(undefined);
                assert.ok(await execution instanceof Error);
            } finally {
                release(undefined);
                await execution;
                (vscode.window as any).showOpenDialog = original;
            }
        });
    }

    test('예기치 않은 스케줄러 예외는 실행 중인 형제 프로세스를 중단하고 종료까지 기다린다', async () => {
        const originalDialog = vscode.window.showOpenDialog;
        const originalComplete = TaskScheduler.prototype.markCompleted;
        const marker = new Error('unexpected scheduler failure');
        const pidFile = path.join(workspace, 'child.pid');
        const script = path.join(workspace, 'child.cjs');
        fs.writeFileSync(script, "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000);");
        let release!: (uris: vscode.Uri[]) => void;
        const dialog = new Promise<vscode.Uri[]>(resolve => { release = resolve; });
        vscode.window.showOpenDialog = () => dialog;
        TaskScheduler.prototype.markCompleted = function (id) {
            if (id === 'scheduler-error') { throw marker; }
            originalComplete.call(this, id);
        };
        let childPid: number | undefined;
        const execution = run({ description: '', tasks: [
            { id: 'sibling', type: 'command', command: 'node', args: [script], parallel: true, passTheResultToNextTask: true, timeoutSeconds: 10 },
            { id: 'scheduler-error', type: 'fileDialog', parallel: true },
        ] }, { abortDrainTimeoutMs: 2000 }).then(() => undefined, error => error);
        try {
            const deadline = Date.now() + 5000;
            while (!fs.existsSync(pidFile) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); }
            assert.ok(fs.existsSync(pidFile), 'The sibling must be running before injecting the scheduler exception.');
            childPid = Number(fs.readFileSync(pidFile, 'utf8'));
            assert.ok(childPid > 0);
            process.kill(childPid, 0);
            release([vscode.Uri.file(script)]);
            assert.strictEqual(await execution, marker);
            assert.throws(() => process.kill(childPid!, 0), 'Pipeline rejection must wait for the owned child to exit.');
        } finally {
            release([]);
            if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* Already drained. */ } }
            await execution;
            vscode.window.showOpenDialog = originalDialog;
            TaskScheduler.prototype.markCompleted = originalComplete;
        }
    });

    test('Stop을 두 번 눌러도 History는 cancelled이고 실패 알림이 없다', async () => {
        const originalDialog = vscode.window.showOpenDialog;
        const originalError = vscode.window.showErrorMessage;
        const originalRegister = vscode.commands.registerCommand;
        let release!: (value: vscode.Uri[] | undefined) => void;
        let opened!: () => void;
        const shown = new Promise<void>(resolve => { opened = resolve; });
        const dialog = new Promise<vscode.Uri[] | undefined>(resolve => { release = resolve; });
        const errors: string[] = [];
        let stop!: (item: Action) => void;
        (vscode.window as any).showOpenDialog = () => { opened(); return dialog; };
        (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
        (vscode.commands as any).registerCommand = (_id: string, handler: typeof stop) => {
            stop = handler;
            return new vscode.Disposable(() => {});
        };
        const item: ActionItem = { id: 'double-stop', title: 'double-stop', action: {
            description: '', tasks: [{ id: 'dialog', type: 'fileDialog' }],
        } };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        const registration = registerStopActionCommand(history);
        const execution = executeAction(item, context, view, history).catch(error => error);
        try {
            await shown;
            const row = new Action(item.title, item.action!, vscode.TreeItemCollapsibleState.None, context, item.id);
            stop(row);
            stop(row);
            release(undefined);
            await execution;
            assert.strictEqual(history.getHistory()[0].status, 'cancelled');
            assert.strictEqual(history.getHistory()[0].cancelKind, 'stopped');
            assert.deepStrictEqual(errors, []);
        } finally {
            release(undefined);
            await execution;
            registration.dispose();
            view.dispose();
            (vscode.commands as any).registerCommand = originalRegister;
            (vscode.window as any).showOpenDialog = originalDialog;
            (vscode.window as any).showErrorMessage = originalError;
        }
    });

    test('큰 stderr는 오류 요약만 제한하고 원본 진단 출력은 보존한다', async () => {
        fs.writeFileSync(path.join(workspace, 'failure.cjs'),
            "process.stderr.write('x'.repeat(1024 * 1024) + '\\nfinal diagnostic'); process.exitCode = 7;");
        await assert.rejects(executeShellCommand('node', ['failure.cjs'], workspace), (error: any) => {
            assert.ok(error.message.length < 4500);
            assert.match(error.message, /final diagnostic/);
            assert.match(error.message, /7/);
            assert.ok(error.stderr.length > 1024 * 1024);
            return true;
        });
    });

    test('큰 stderr가 History와 실패 알림에 전체 저장되지 않는다', async () => {
        const script = path.join(workspace, 'history-failure.cjs');
        fs.writeFileSync(script, "process.stderr.write('x'.repeat(1024 * 1024) + '\\nfinal diagnostic'); process.exitCode = 7;");
        const originalError = vscode.window.showErrorMessage;
        const messages: string[] = [];
        (vscode.window as any).showErrorMessage = async (message: string) => { messages.push(message); };
        const item: ActionItem = { id: 'bounded-failure', title: 'bounded-failure', action: {
            description: '', tasks: [{ id: 'fail', type: 'command', command: 'node', args: [script], passTheResultToNextTask: true }],
        } };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        try {
            await assert.rejects(executeAction(item, context, view, history));
            const entry = history.getHistory()[0];
            assert.strictEqual(entry.status, 'failure');
            assert.ok(entry.output && entry.output.length < 4500);
            assert.match(entry.output, /final diagnostic/);
            assert.strictEqual(messages.length, 1);
            assert.ok(messages[0].length < 600);
            assert.match(messages[0], /final diagnostic/);
            assert.match(messages[0], /7/);
        } finally {
            view.dispose();
            (vscode.window as any).showErrorMessage = originalError;
        }
    });
});
