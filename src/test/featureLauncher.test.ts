import * as assert from 'assert';
import * as vscode from 'vscode';
import { DIALOG_SCOPE, initDialogMemory } from '../dialogMemory';
import {
    buildFeatureLauncherItems,
    FEATURE_LAUNCHER_COMMAND,
    FEATURE_LAUNCHER_RECENT_KEY,
    FEATURE_LAUNCHER_STATUS_ID,
    normalizeFeatureLauncherRecent,
    registerFeatureLauncher,
    showFeatureLauncher,
} from '../featureLauncher';

function createMemoryState(): { memento: vscode.Memento; values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    const memento = {
        get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue,
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, value);
            }
        },
        keys: () => [...values.keys()],
    } as vscode.Memento;
    return { memento, values };
}

suite('TaskHub 기능 런처', () => {
    test('명령이 실제 extension host에 등록된다', async () => {
        const commands = new Set(await vscode.commands.getCommands(true));
        assert.ok(commands.has(FEATURE_LAUNCHER_COMMAND));
        for (const item of buildFeatureLauncherItems([])) {
            if (item.command) {
                assert.ok(commands.has(item.command), `런처 대상 명령이 없다: ${item.command}`);
            }
        }
    });

    test('손상·중복·알 수 없는 최근 항목을 버리고 세 개로 제한한다', () => {
        assert.deepStrictEqual(normalizeFeatureLauncherRecent(undefined), []);
        assert.deepStrictEqual(normalizeFeatureLauncherRecent('hexViewer'), []);
        assert.deepStrictEqual(
            normalizeFeatureLauncherRecent([
                'hexViewer', 'unknown', 42, 'hexViewer', 'memoryMap', 'hexConverter', 'doctor',
            ]),
            ['hexViewer', 'memoryMap', 'hexConverter']
        );
    });

    test('최근 사용을 먼저 두고 모든 기능을 분야별 구분선 아래에 표시한다', () => {
        const items = buildFeatureLauncherItems(['hexConverter', 'runAnyAction']);
        const recent = items.slice(1, 3).map(item => item.featureId);
        assert.deepStrictEqual(recent, ['hexConverter', 'runAnyAction']);
        assert.strictEqual(items[0].kind, vscode.QuickPickItemKind.Separator);

        const separators = items.filter(item => item.kind === vscode.QuickPickItemKind.Separator);
        assert.strictEqual(separators.length, 5, '최근 사용과 네 기능 그룹을 모두 구분해야 한다');
        assert.ok(separators.every(item => item.label.trim().length > 0));

        const allFeatureIds = items
            .filter(item => item.kind !== vscode.QuickPickItemKind.Separator)
            .map(item => item.featureId);
        const uniqueFeatureIds = new Set(allFeatureIds);
        assert.strictEqual(uniqueFeatureIds.size, 10);
        assert.ok(allFeatureIds.every(id => typeof id === 'string'));
        assert.ok(items.filter(item => item.featureId).every(item => item.label.includes('$(')));
    });

    test('선택한 기능을 최근 맨 앞에 저장하고 원래 명령을 실행한다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        let stored: unknown = ['memoryMap', 'hexConverter'];
        let executed: string | undefined;
        let options: vscode.QuickPickOptions | undefined;
        const context = {
            globalState: {
                get: (key: string) => key === FEATURE_LAUNCHER_RECENT_KEY ? stored : undefined,
                update: async (key: string, value: unknown) => {
                    assert.strictEqual(key, FEATURE_LAUNCHER_RECENT_KEY);
                    stored = value;
                },
            },
        } as unknown as vscode.ExtensionContext;

        try {
            (vscode.window as any).showQuickPick = async (
                items: ReturnType<typeof buildFeatureLauncherItems>,
                receivedOptions: vscode.QuickPickOptions
            ) => {
                options = receivedOptions;
                return items.find(item => item.featureId === 'hexViewer');
            };
            (vscode.commands as any).executeCommand = async (command: string) => { executed = command; };

            await showFeatureLauncher(context);

            assert.deepStrictEqual(stored, ['hexViewer', 'memoryMap', 'hexConverter']);
            assert.strictEqual(executed, 'taskhub.showHexViewer');
            assert.strictEqual(options?.matchOnDescription, true);
            assert.ok(options?.placeHolder);
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }
    });

    test('최근 목록 저장 실패가 선택한 기능 실행을 막지 않는다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        let executed: string | undefined;
        const context = {
            globalState: {
                get: () => [],
                update: async () => { throw new Error('storage unavailable'); },
            },
        } as unknown as vscode.ExtensionContext;

        try {
            (vscode.window as any).showQuickPick = async (items: ReturnType<typeof buildFeatureLauncherItems>) =>
                items.find(item => item.featureId === 'doctor');
            (vscode.commands as any).executeCommand = async (command: string) => { executed = command; };

            await showFeatureLauncher(context);
            assert.strictEqual(executed, 'taskhub.doctor');
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }
    });

    test('미리 보기 기능은 파일을 고르게 한 뒤 URI를 대상 명령에 전달한다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalShowOpenDialog = vscode.window.showOpenDialog;
        const originalExecuteCommand = vscode.commands.executeCommand;
        const executions: Array<{ command: string; args: unknown[] }> = [];
        const dialogOptions: vscode.OpenDialogOptions[] = [];
        let selectedId: 'markdownPreview' | 'htmlBrowser' = 'markdownPreview';
        let selectedUri = vscode.Uri.joinPath(vscode.Uri.file(process.cwd()), 'README.md');
        const workspaceState = createMemoryState();
        const globalState = createMemoryState();
        const context = {
            workspaceState: workspaceState.memento,
            globalState: globalState.memento,
        } as unknown as vscode.ExtensionContext;
        const previousMemoryContext = initDialogMemory(context);

        try {
            (vscode.window as any).showQuickPick = async (items: ReturnType<typeof buildFeatureLauncherItems>) =>
                items.find(item => item.featureId === selectedId);
            (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                dialogOptions.push(options);
                return [selectedUri];
            };
            (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
                executions.push({ command, args });
            };

            await showFeatureLauncher(context);
            selectedId = 'htmlBrowser';
            selectedUri = vscode.Uri.joinPath(vscode.Uri.file(process.cwd()), 'report.html');
            await showFeatureLauncher(context);

            assert.deepStrictEqual(executions.map(execution => ({
                command: execution.command,
                uri: (execution.args[0] as vscode.Uri).toString(),
            })), [
                {
                    command: 'taskhub.openMarkdownPreview',
                    uri: vscode.Uri.joinPath(vscode.Uri.file(process.cwd()), 'README.md').toString(),
                },
                {
                    command: 'taskhub.openHtmlInBrowser',
                    uri: vscode.Uri.joinPath(vscode.Uri.file(process.cwd()), 'report.html').toString(),
                },
            ]);
            assert.deepStrictEqual(dialogOptions[0].filters, { Markdown: ['md', 'markdown'] });
            assert.deepStrictEqual(dialogOptions[1].filters, { HTML: ['html', 'htm'] });
            assert.ok(dialogOptions.every(options => options.canSelectMany === false && options.openLabel));
            assert.deepStrictEqual(
                globalState.memento.get(FEATURE_LAUNCHER_RECENT_KEY),
                ['htmlBrowser', 'markdownPreview']
            );
            const locations = workspaceState.values.get('taskhub.dialogLocations') as Record<string, unknown>;
            assert.ok(locations[DIALOG_SCOPE.previewMarkdown]);
            assert.ok(locations[DIALOG_SCOPE.previewHtml]);
        } finally {
            initDialogMemory(previousMemoryContext);
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }
    });

    test('미리 보기 파일 선택을 취소하면 최근 목록과 대상 명령을 건드리지 않는다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalShowOpenDialog = vscode.window.showOpenDialog;
        const originalExecuteCommand = vscode.commands.executeCommand;
        let updateCount = 0;
        let executeCount = 0;
        const context = {
            globalState: {
                get: () => [],
                update: async () => { updateCount++; },
            },
        } as unknown as vscode.ExtensionContext;

        try {
            (vscode.window as any).showQuickPick = async (items: ReturnType<typeof buildFeatureLauncherItems>) =>
                items.find(item => item.featureId === 'markdownPreview');
            (vscode.window as any).showOpenDialog = async () => undefined;
            (vscode.commands as any).executeCommand = async () => { executeCount++; };

            await showFeatureLauncher(context);
            assert.strictEqual(updateCount, 0);
            assert.strictEqual(executeCount, 0);
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }
    });

    test('대상 기능 실패를 선택한 기능 이름과 원인이 있는 오류로 바꾼다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const languageDescriptor = Object.getOwnPropertyDescriptor(vscode.env, 'language');
        assert.ok(languageDescriptor?.configurable, '테스트에서 VS Code 언어를 고정할 수 있어야 한다');
        const errors: string[] = [];
        const context = {
            globalState: {
                get: () => [],
                update: async () => undefined,
            },
        } as unknown as vscode.ExtensionContext;

        try {
            Object.defineProperty(vscode.env, 'language', { value: 'ko', configurable: true });
            (vscode.window as any).showQuickPick = async (items: ReturnType<typeof buildFeatureLauncherItems>) =>
                items.find(item => item.featureId === 'doctor');
            (vscode.commands as any).executeCommand = async () => { throw new Error('doctor unavailable'); };
            (vscode.window as any).showErrorMessage = async (message: string) => {
                errors.push(message);
                return undefined;
            };

            await showFeatureLauncher(context);
            assert.strictEqual(errors.length, 1);
            assert.ok(errors[0].includes('Doctor'));
            assert.ok(errors[0].includes('doctor unavailable'));
            assert.ok(errors[0].includes("Doctor 실행' 기능을"));
            assert.ok(!errors[0].includes('$('));
        } finally {
            Object.defineProperty(vscode.env, 'language', languageDescriptor);
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        }
    });

    test('왼쪽 Status Bar에 한 항목을 등록하고 수명주기에 묶는다', () => {
        const originalRegisterCommand = vscode.commands.registerCommand;
        const originalCreateStatusBarItem = vscode.window.createStatusBarItem;
        let registeredCommand: string | undefined;
        let createdWith: [string, vscode.StatusBarAlignment, number] | undefined;
        let shown = false;
        const commandDisposable = { dispose: () => undefined };
        const status = {
            show: () => { shown = true; },
            dispose: () => undefined,
        } as unknown as vscode.StatusBarItem;
        const subscriptions: vscode.Disposable[] = [];
        const context = { subscriptions } as unknown as vscode.ExtensionContext;

        try {
            (vscode.commands as any).registerCommand = (command: string) => {
                registeredCommand = command;
                return commandDisposable;
            };
            (vscode.window as any).createStatusBarItem = (
                id: string,
                alignment: vscode.StatusBarAlignment,
                priority: number
            ) => {
                createdWith = [id, alignment, priority];
                return status;
            };

            registerFeatureLauncher(context);

            assert.deepStrictEqual(createdWith, [FEATURE_LAUNCHER_STATUS_ID, vscode.StatusBarAlignment.Left, 10]);
            assert.strictEqual(registeredCommand, FEATURE_LAUNCHER_COMMAND);
            assert.strictEqual(status.text, '$(tools) TaskHub');
            assert.strictEqual(status.command, FEATURE_LAUNCHER_COMMAND);
            assert.ok(status.name);
            assert.ok(status.tooltip);
            assert.ok(status.accessibilityInformation?.label);
            assert.strictEqual(shown, true);
            assert.deepStrictEqual(subscriptions, [commandDisposable, status]);
        } finally {
            (vscode.commands as any).registerCommand = originalRegisterCommand;
            (vscode.window as any).createStatusBarItem = originalCreateStatusBarItem;
        }
    });
});
