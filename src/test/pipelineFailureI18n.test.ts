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
