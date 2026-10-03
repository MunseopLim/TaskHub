import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { executeAction, executeActionPipeline, runCommandCaptureLines } from '../extension';
import { buildBuiltinVariableContext } from '../builtinVariables';
import { actionStates } from '../providers/actionStatus';
import { HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem, Task } from '../schema';
import { RunLogStore } from '../runLogStore';

suite('파이프라인 실패 안내 다국어', function () {
    this.timeout(15000);
    let workspace: string;
    let context: vscode.ExtensionContext;
    let originalLanguage: PropertyDescriptor;
    let previousNotifications: unknown;

    setup(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-failure-i18n-'));
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
        originalLanguage = Object.getOwnPropertyDescriptor(vscode.env, 'language')!;
        assert.ok(originalLanguage?.configurable);
        const config = vscode.workspace.getConfiguration('taskhub');
        previousNotifications = config.inspect('executionNotifications')?.globalValue;
        await config.update('executionNotifications', 'on', vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        Object.defineProperty(vscode.env, 'language', originalLanguage);
        await vscode.workspace.getConfiguration('taskhub').update(
            'executionNotifications', previousNotifications, vscode.ConfigurationTarget.Global
        );
        actionStates.clear();
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    function setLanguage(language: string): void {
        Object.defineProperty(vscode.env, 'language', { value: language, configurable: true });
    }

    test('스트리밍 실패의 알림·History와 원샷 종료 안내를 한국어·영어로 제공한다', async () => {
        const originalExecute = vscode.tasks.executeTask;
        const originalEnd = vscode.tasks.onDidEndTaskProcess;
        const originalError = vscode.window.showErrorMessage;
        const listeners = new Set<(event: vscode.TaskProcessEndEvent) => unknown>();
        const errors: string[] = [];
        let exitCode: number | undefined = 7;
        let notified: (() => void) | undefined;
        (vscode.tasks as any).onDidEndTaskProcess = (listener: (event: vscode.TaskProcessEndEvent) => unknown) => {
            listeners.add(listener);
            return new vscode.Disposable(() => listeners.delete(listener));
        };
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            const execution = { task, terminate() {} } as vscode.TaskExecution;
            setImmediate(() => {
                for (const listener of [...listeners]) { listener({ execution, exitCode }); }
            });
            return execution;
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            notified?.();
        };
        try {
            for (const language of ['ko', 'en']) {
                setLanguage(language);
                for (const code of [7, undefined]) {
                    exitCode = code;
                    const item: ActionItem = {
                        id: `i18n-${language}-${code}`, title: 'Build',
                        action: { description: '', tasks: [{ id: 'build', type: 'command', command: 'unused-by-mock' }] },
                    };
                    const history = new HistoryProvider(context);
                    const view = new MainViewProvider(context, () => [item]);
                    try {
                        await assert.rejects(executeAction(item, context, view, history));
                        const expected = code === undefined
                            ? (language === 'ko' ? /종료 코드를 남기지 않고 종료/ : /terminated without an exit code/)
                            : (language === 'ko' ? /종료 코드 7로 실패/ : /failed with exit code 7/);
                        assert.match(errors.at(-1)!, expected);
                        assert.match(history.getHistory()[0].output ?? '', expected);
                        assert.ok(!errors.at(-1)!.includes('undefined'), '없는 종료 코드를 값처럼 표시하면 안 된다');
                        assert.strictEqual(listeners.size, 0, '종료 리스너를 남기면 안 된다');
                    } finally {
                        view.dispose();
                    }
                }
                exitCode = 7;
                let timer: ReturnType<typeof setTimeout> | undefined;
                const notification = new Promise<void>((resolve, reject) => {
                    notified = resolve;
                    timer = setTimeout(() => reject(new Error('One-shot failure notification timed out.')), 2000);
                });
                try {
                    await executeActionPipeline({ description: '', tasks: [{
                        id: 'background', type: 'command', command: 'unused-by-mock', isOneShot: true,
                    }] }, context, `i18n-one-shot-${language}`, workspace);
                    await notification;
                    const message = errors.at(-1)!;
                    assert.match(message, language === 'ko' ? /원샷.*실행 실패/ : /One-shot.*failed:/);
                    assert.ok(!/시작 실패|failed to start/.test(message), '실행 후 비정상 종료를 시작 실패로 표시하면 안 된다');
                } finally {
                    clearTimeout(timer);
                    notified = undefined;
                }
            }
        } finally {
            (vscode.tasks as any).executeTask = originalExecute;
            (vscode.tasks as any).onDidEndTaskProcess = originalEnd;
            (vscode.window as any).showErrorMessage = originalError;
        }
    });

    test('실패 알림의 버튼은 이 실행의 실행 로그 저장이 끝난 뒤의 기록을 쓴다', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(folder, '실행 로그를 쓸 워크스페이스가 필요하다');
        const taskhubDir = path.join(folder, '.taskhub');
        const hadTaskhubDir = fs.existsSync(taskhubDir);
        const config = vscode.workspace.getConfiguration('taskhub');
        const previousRunLogs = config.inspect('runLogs.enabled')?.globalValue;
        await config.update('runLogs.enabled', true, vscode.ConfigurationTarget.Global);
        const originalExecute = vscode.tasks.executeTask;
        const originalEnd = vscode.tasks.onDidEndTaskProcess;
        const originalError = vscode.window.showErrorMessage;
        const originalCommand = vscode.commands.executeCommand;
        const originalWrite = RunLogStore.prototype.write;
        const listeners = new Set<(event: vscode.TaskProcessEndEvent) => unknown>();
        const rerunEntries: any[] = [];
        let rerunDone!: () => void;
        const rerun = new Promise<void>(resolve => { rerunDone = resolve; });
        let writeStarted!: () => void;
        const writing = new Promise<void>(resolve => { writeStarted = resolve; });
        let releaseWrite!: () => void;
        const writeAllowed = new Promise<void>(resolve => { releaseWrite = resolve; });
        async function within(pending: Promise<void>, label: string): Promise<void> {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([pending, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3000);
                })]);
            } finally {
                clearTimeout(timer);
            }
        }
        (vscode.tasks as any).onDidEndTaskProcess = (listener: (event: vscode.TaskProcessEndEvent) => unknown) => {
            listeners.add(listener);
            return new vscode.Disposable(() => listeners.delete(listener));
        };
        (vscode.tasks as any).executeTask = async (task: vscode.Task) => {
            const execution = { task, terminate() {} } as vscode.TaskExecution;
            setImmediate(() => { for (const listener of [...listeners]) { listener({ execution, exitCode: 3 }); } });
            return execution;
        };
        // 사용자가 알림이 뜨자마자 "다시 실행"을 누른다.
        (vscode.window as any).showErrorMessage = async (_message: string, ...buttons: string[]) =>
            buttons.find(button => button === buttons[1]);
        (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
            // 같은 기록 객체가 나중에 갱신되므로 누른 시점의 사본을 남긴다.
            if (command === 'taskhub.rerunFromHistory') { rerunEntries.push(JSON.parse(JSON.stringify(args[0]))); rerunDone(); return; }
            return originalCommand.call(vscode.commands, command, ...args);
        };
        // 로그 저장이 시작된 뒤에도 명시적으로 풀기 전까지 완료되지 않게 한다.
        RunLogStore.prototype.write = function (this: RunLogStore, ...args: Parameters<RunLogStore['write']>) {
            writeStarted();
            return writeAllowed.then(() => originalWrite.apply(this, args));
        } as RunLogStore['write'];
        const item: ActionItem = {
            id: 'failure-report-wait', title: 'Build',
            action: { description: '', tasks: [{ id: 'build', type: 'command', command: 'unused-by-mock' }] },
        };
        const history = new HistoryProvider(context);
        const view = new MainViewProvider(context, () => [item]);
        let execution: Promise<void> | undefined;
        try {
            execution = assert.rejects(executeAction(item, context, view, history));
            await within(writing, 'run log write start');
            assert.strictEqual(rerunEntries.length, 0, '저장이 끝나기 전에는 기록으로 다시 실행하지 않는다');
            releaseWrite();
            await within(execution, 'action finalization');
            await within(rerun, 'rerun');
            assert.strictEqual(rerunEntries.length, 1);
            assert.ok(rerunEntries[0].runLog, '저장 전에 기록을 쓰면 보고서가 "로그를 남기지 못했다"로 열린다');
            assert.strictEqual(rerunEntries[0].status, 'failure');
        } finally {
            releaseWrite();
            await execution?.catch(() => undefined);
            view.dispose();
            RunLogStore.prototype.write = originalWrite;
            (vscode.tasks as any).executeTask = originalExecute;
            (vscode.tasks as any).onDidEndTaskProcess = originalEnd;
            (vscode.window as any).showErrorMessage = originalError;
            (vscode.commands as any).executeCommand = originalCommand;
            await config.update('runLogs.enabled', previousRunLogs, vscode.ConfigurationTarget.Global);
            if (!hadTaskhubDir) { fs.rmSync(taskhubDir, { recursive: true, force: true }); }
        }
    });

    test('잘못된 태스크 설정은 제품의 오류 안내를 지역화한다', async () => {
        const cases: Array<{ task: Task; ko: RegExp; en: RegExp }> = [
            { task: { id: 'bad', type: 'command' }, ko: /'command' 속성이 필요/, en: /requires a 'command' property/ },
            { task: { id: 'bad', type: 'writeFile', path: '', content: 'x' }, ko: /'path' 속성이 필요/, en: /requires a non-empty 'path'/ },
            { task: { id: 'bad', type: 'quickPick', items: [] }, ko: /'items' 배열.*필요/, en: /requires a non-empty 'items'/ },
            { task: { id: 'bad', type: 'zip', source: 'source' }, ko: /'archive' 속성이 없/, en: /missing the 'archive'/ },
            { task: { id: 'bad', type: 'inputBox', forEach: ['x'] }, ko: /대화형 유형.*사용할 수 없/, en: /cannot use 'forEach' with interactive type/ },
        ];
        for (const language of ['ko', 'en']) {
            setLanguage(language);
            for (const item of cases) {
                await assert.rejects(executeActionPipeline({ description: '', tasks: [item.task] }, context,
                    'invalid-settings', workspace, [workspace], {
                        builtinVariables: buildBuiltinVariableContext({
                            workspaceFolder: workspace, extensionPath: context.extensionPath, environment: {}, strict: true,
                        }),
                    }), language === 'ko' ? item.ko : item.en);
            }
        }
    });

    test('목록 명령의 제품 종료 안내만 지역화하고 외부 stderr는 그대로 전달한다', async () => {
        for (const language of ['ko', 'en']) {
            setLanguage(language);
            await assert.rejects(runCommandCaptureLines('node -e "process.exit(7)"', workspace),
                language === 'ko' ? /종료 코드 7/ : /exit code 7/);
            await assert.rejects(runCommandCaptureLines('node -e "process.stderr.write(\'external diagnostic\'); process.exit(7)"', workspace),
                (error: unknown) => error instanceof Error && error.message === 'external diagnostic');
        }
    });
});
