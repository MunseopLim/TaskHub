import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { collectRunningActionIds, executeAction, executeActionPipeline } from '../extension';
import { actionStates } from '../providers/actionStatus';
import { HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem, Task } from '../schema';

function describeExecution(task: vscode.Task): string {
    const execution = task.execution as any;
    return JSON.stringify({
        commandLine: execution?.commandLine,
        command: execution?.command,
        process: execution?.process,
        args: execution?.args,
    });
}

suite('Interactive Terminal', function () {
    this.timeout(15000);
    let workspace: string;
    let context: vscode.ExtensionContext;
    let originalExecute: typeof vscode.tasks.executeTask;
    let originalEnd: typeof vscode.tasks.onDidEndTaskProcess;
    let originalError: typeof vscode.window.showErrorMessage;
    let ended: vscode.EventEmitter<vscode.TaskProcessEndEvent>;
    let launched: Array<{ task: vscode.Task; execution: vscode.TaskExecution }>;
    let errors: string[];
    let previousNotifications: unknown;

    setup(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-interactive-terminal-'));
        const values = new Map<string, unknown>();
        const memento = {
            get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
            update: async (key: string, value: unknown) => { values.set(key, value); },
            keys: () => [...values.keys()],
        };
        context = {
            extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [],
            workspaceState: memento, globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } },
        } as unknown as vscode.ExtensionContext;
        const config = vscode.workspace.getConfiguration('taskhub');
        previousNotifications = config.inspect('executionNotifications')?.globalValue;
        await config.update('executionNotifications', 'on', vscode.ConfigurationTarget.Global);

        launched = [];
        errors = [];
        ended = new vscode.EventEmitter<vscode.TaskProcessEndEvent>();
        originalExecute = vscode.tasks.executeTask;
        originalEnd = vscode.tasks.onDidEndTaskProcess;
        originalError = vscode.window.showErrorMessage;
        (vscode.tasks as any).onDidEndTaskProcess = ended.event;
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            const execution = { task, terminate() {} } as vscode.TaskExecution;
            launched.push({ task, execution });
            return execution;
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            return undefined;
        };
    });

    teardown(async () => {
        // 끝나지 않은 가짜 실행이 다음 테스트로 새지 않게 모두 종료시킨다.
        for (const { execution } of launched) { ended.fire({ execution, exitCode: 0 }); }
        (vscode.tasks as any).executeTask = originalExecute;
        (vscode.tasks as any).onDidEndTaskProcess = originalEnd;
        (vscode.window as any).showErrorMessage = originalError;
        ended.dispose();
        actionStates.clear();
        await vscode.workspace.getConfiguration('taskhub').update(
            'executionNotifications', previousNotifications, vscode.ConfigurationTarget.Global
        );
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50));
    const ARGS = ['-e', 'setInterval(() => {}, 1000)'];

    /**
     * 같은 명령을 일반 터미널 실행(기다림)으로 띄웠을 때의 실행 형태.
     * one-shot 래퍼는 플랫폼마다 모양이 다르므로(POSIX `nohup`, Windows는
     * 인코딩된 PowerShell) 문자열 대신 이 기준과 같은지로 판정한다.
     */
    async function plainExecution(): Promise<string> {
        const before = launched.length;
        const run = executeActionPipeline({ description: '', tasks: [{
            id: 'plain', type: 'command', command: 'node', args: ARGS,
        }] }, context, 'plain-reference', workspace);
        await settle();
        const reference = launched[before];
        assert.ok(reference, '기준 실행이 시작되지 않았다');
        ended.fire({ execution: reference.execution, exitCode: 0 });
        await run;
        launched.splice(before, 1);
        return describeExecution(reference.task);
    }

    test('IT-294: interactiveTerminal + isOneShot은 래퍼 없이 터미널에 띄우고 시작 직후 완료한다', async () => {
        const item: ActionItem = {
            id: 'it294', title: 'Chat',
            action: { description: '', tasks: [{
                id: 'chat', type: 'command', command: 'node', args: ARGS,
                interactiveTerminal: true, isOneShot: true,
            }] },
        };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        try {
            const plain = await plainExecution();
            // 종료 이벤트를 보내지 않아도 액션이 끝나야 한다.
            await executeAction(item, context, view, history);
            await settle();
            assert.strictEqual(launched.length, 1);
            const { task, execution } = launched[0];
            assert.strictEqual(describeExecution(task), plain,
                '대화형 one-shot을 백그라운드 래퍼로 감싸면 터미널 입력이 끊긴다');
            assert.strictEqual(task.presentationOptions.focus, true, '바로 입력할 수 있게 터미널에 포커스를 줘야 한다');
            assert.strictEqual(history.getHistory()[0].status, 'success');
            assert.ok(!collectRunningActionIds().includes(item.id), '세션이 살아 있는 동안 액션이 실행 중으로 남으면 안 된다');

            // 사용자가 세션을 끝낸 종료 코드는 실패로 알리지 않는다.
            ended.fire({ execution, exitCode: 1 });
            await settle();
            assert.deepStrictEqual(errors, []);
        } finally {
            view.dispose();
        }
    });

    test('IT-295: isOneShot 없는 interactiveTerminal은 포커스를 주고 종료까지 기다린다', async () => {
        const plain = await plainExecution();
        const run = executeActionPipeline({ description: '', tasks: [{
            id: 'init', type: 'command', command: 'node', args: ARGS, interactiveTerminal: true,
        }] }, context, 'it295', workspace);
        let finished = false;
        void run.then(() => { finished = true; }, () => { finished = true; });
        await settle();
        assert.strictEqual(launched.length, 1);
        const { task, execution } = launched[0];
        assert.strictEqual(describeExecution(task), plain);
        assert.strictEqual(task.presentationOptions.focus, true);
        assert.strictEqual(finished, false, '종료 전에는 다음 단계로 넘어가면 안 된다');

        ended.fire({ execution, exitCode: 3 });
        await assert.rejects(run, /3/, '기다리는 대화형 태스크는 종료 코드를 그대로 결과로 쓴다');
    });

    test('IT-296: interactiveTerminal 없는 isOneShot은 기존 백그라운드 실행을 유지한다', async () => {
        const plain = await plainExecution();
        await executeActionPipeline({ description: '', tasks: [{
            id: 'server', type: 'command', command: 'node', args: ARGS, isOneShot: true,
        }] }, context, 'it296', workspace);
        await settle();
        assert.strictEqual(launched.length, 1);
        const { task } = launched[0];
        assert.notStrictEqual(describeExecution(task), plain, '일반 one-shot은 백그라운드 래퍼로 감싸야 한다');
        if (process.platform !== 'win32') {
            assert.match(describeExecution(task), /nohup/);
        }
        assert.notStrictEqual(task.presentationOptions.focus, true, '일반 태스크 터미널은 포커스를 가져가지 않는다');
    });

    test('IT-297: 캡처·민감 입력·forEach와 함께 쓰면 실행 전에 거부한다', async () => {
        const originalInput = vscode.window.showInputBox;
        (vscode.window as any).showInputBox = async () => 'hunter2';
        const cases: Array<{ name: string; tasks: Task[]; expected: RegExp }> = [
            {
                name: 'capture',
                tasks: [{ id: 'run', type: 'command', command: 'node', interactiveTerminal: true, passTheResultToNextTask: true }],
                expected: /passTheResultToNextTask/,
            },
            {
                name: 'password',
                tasks: [
                    { id: 'pw', type: 'inputBox', password: true },
                    { id: 'run', type: 'command', command: 'node', args: ['${pw}'], interactiveTerminal: true },
                ],
                expected: /interactiveTerminal/,
            },
            {
                name: 'environment',
                tasks: [{ id: 'run', type: 'command', command: 'node', args: ['${env:PATH}'], interactiveTerminal: true }],
                expected: /interactiveTerminal/,
            },
            {
                name: 'switch-inherited-capture',
                tasks: [{
                    id: 'run', type: 'switch', on: 'a', passTheResultToNextTask: true,
                    cases: { a: { type: 'command', command: 'node', interactiveTerminal: true } },
                }],
                expected: /passTheResultToNextTask/,
            },
            {
                name: 'forEach',
                tasks: [{ id: 'run', type: 'command', command: 'node', forEach: ['a'], interactiveTerminal: true }],
                expected: /forEach.*interactiveTerminal|interactiveTerminal.*forEach/,
            },
        ];
        try {
            for (const { name, tasks, expected } of cases) {
                await assert.rejects(
                    executeActionPipeline({ description: '', tasks }, context, `it297-${name}`, workspace),
                    (error: Error) => {
                        assert.match(error.message, expected, `${name}: ${error.message}`);
                        assert.ok(!error.message.includes('hunter2'), '거부 안내에 비밀 값이 실리면 안 된다');
                        return true;
                    }
                );
                assert.strictEqual(launched.length, 0, `${name}: 거부한 태스크가 터미널에서 실행되면 안 된다`);
            }
        } finally {
            (vscode.window as any).showInputBox = originalInput;
        }
    });

    test('IT-298: 대화형 one-shot은 시작 요청이 받아들여질 때까지 기다리고 거절을 실패로 전달한다', async () => {
        const tasks: Task[] = [
            { id: 'chat', type: 'command', command: 'node', args: ARGS, interactiveTerminal: true, isOneShot: true },
            { id: 'after', type: 'stringManipulation', function: 'trim', input: 'next' },
        ];

        // 요청 대기 중에는 액션이 끝나거나 다음 태스크로 넘어가면 안 된다.
        let accept!: () => void;
        const accepted = new Promise<void>(resolve => { accept = resolve; });
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            await accepted;
            const execution = { task, terminate() {} } as vscode.TaskExecution;
            launched.push({ task, execution });
            return execution;
        };
        const pending = executeActionPipeline({ description: '', tasks }, context, 'it298-pending', workspace);
        let finished = false;
        void pending.then(() => { finished = true; }, () => { finished = true; });
        await settle();
        assert.strictEqual(finished, false, '시작 요청이 끝나기 전에 액션을 완료하면 안 된다');
        accept();
        await pending;
        assert.strictEqual(launched.length, 1);

        // 거절된 요청은 알림만 띄우고 성공으로 마감하지 않고 액션 실패가 된다.
        const item: ActionItem = { id: 'it298-rejected', title: 'Chat', action: { description: '', tasks } };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        (vscode.tasks as any).executeTask = async () => { throw new Error('launch refused'); };
        try {
            await assert.rejects(executeAction(item, context, view, history), /launch refused/);
            assert.strictEqual(history.getHistory()[0].status, 'failure');
            assert.ok(!collectRunningActionIds().includes(item.id));
        } finally {
            view.dispose();
        }
    });

    test('IT-299: 바깥 switch의 충돌을 case가 덮어써 해소하면 대화형 터미널로 실행한다', async () => {
        const run = executeActionPipeline({ description: '', tasks: [{
            id: 'pick', type: 'switch', on: 'chat', interactiveTerminal: true, passTheResultToNextTask: true,
            cases: { chat: { type: 'command', command: 'node', args: ARGS, passTheResultToNextTask: false } },
        }] }, context, 'it299', workspace);
        await settle();
        assert.strictEqual(launched.length, 1, '캡처를 끈 case는 거부하지 않고 터미널에서 실행해야 한다');
        const { task, execution } = launched[0];
        assert.strictEqual(task.presentationOptions.focus, true);
        ended.fire({ execution, exitCode: 0 });
        await run;
    });
});
