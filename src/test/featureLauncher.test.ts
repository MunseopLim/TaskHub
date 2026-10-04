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

    test('최근 사용을 먼저 두고 일반 그룹에서는 중복을 제거한다', () => {
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
        assert.strictEqual(uniqueFeatureIds.size, 15);
        assert.strictEqual(allFeatureIds.length, 15, '최근 기능을 일반 그룹에 다시 표시하면 검색 결과가 중복된다');
        assert.ok(allFeatureIds.every(id => typeof id === 'string'));
        assert.ok(items.filter(item => item.featureId).every(item => item.label.includes('$(')));
    });

    test('새로운 기능의 읽지 않은 버전 수를 런처에 표시한다', () => {
        const item = buildFeatureLauncherItems([], 2).find(candidate => candidate.featureId === 'whatsNew');
        assert.strictEqual(item?.command, 'taskhub.showWhatsNew');
        assert.ok(item?.description?.includes('2'));
        const read = buildFeatureLauncherItems([]).find(candidate => candidate.featureId === 'whatsNew');
        assert.notStrictEqual(read?.description, item?.description);
    });

    test('Jenkins가 꺼져 있어도 활성화 경로를 표시하고 최근 항목과 중복하지 않는다', () => {
        const enabled = buildFeatureLauncherItems(['jenkins'], 0, true);
        const jenkins = enabled.filter(item => item.featureId === 'jenkins');
        assert.strictEqual(jenkins.length, 1);
        assert.strictEqual(jenkins[0].command, 'taskhub.jenkins.showRuns');
        assert.strictEqual(enabled[1].featureId, 'jenkins');

        const disabled = buildFeatureLauncherItems(['jenkins'], 0, false);
        const enableJenkins = disabled.filter(item => item.featureId === 'jenkins');
        assert.strictEqual(enableJenkins.length, 1);
        assert.strictEqual(enableJenkins[0].command, 'workbench.action.openSettings');
        assert.notStrictEqual(enableJenkins[0].label, jenkins[0].label);
        assert.strictEqual(disabled[1].featureId, 'jenkins');
        assert.strictEqual(disabled.filter(item => item.featureId).length, 15);
        assert.ok(buildFeatureLauncherItems([], 0, false).some(item => item.featureId === 'jenkins'),
            '최근 사용 기록이 없는 신규 사용자에게도 활성화 경로를 표시해야 한다');
    });

    test('런처에서 꺼진 Jenkins는 활성화 설정을 열고 켠 뒤에는 실행 목록을 연다', async () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        const executions: Array<{ command: string; args: unknown[] }> = [];
        const { memento } = createMemoryState();
        const context = { globalState: memento } as unknown as vscode.ExtensionContext;
        let enabled = false;
        try {
            (vscode.workspace as any).getConfiguration = (section: string) => {
                assert.strictEqual(section, 'taskhub');
                return { get: (key: string, fallback: unknown) => key === 'experimental.jenkins.enabled' ? enabled : fallback };
            };
            (vscode.window as any).showQuickPick = async (items: ReturnType<typeof buildFeatureLauncherItems>) => {
                const jenkins = items.filter(item => item.featureId === 'jenkins');
                assert.strictEqual(jenkins.length, 1, '설정 상태와 관계없이 선택할 수 있어야 한다');
                return jenkins[0];
            };
            (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
                executions.push({ command, args });
            };
            await showFeatureLauncher(context);
            enabled = true;
            await showFeatureLauncher(context);
            enabled = false;
            await showFeatureLauncher(context);
            assert.deepStrictEqual(executions, [
                { command: 'workbench.action.openSettings', args: ['@id:taskhub.experimental.jenkins.enabled'] },
                { command: 'taskhub.jenkins.showRuns', args: [] },
                { command: 'workbench.action.openSettings', args: ['@id:taskhub.experimental.jenkins.enabled'] },
            ]);
            assert.deepStrictEqual(memento.get(FEATURE_LAUNCHER_RECENT_KEY), ['jenkins']);
        } finally {
            (vscode.workspace as any).getConfiguration = originalGetConfiguration;
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }
    });

    test('새로운 기능을 읽으면 상태 표시줄의 표시와 접근성 설명이 갱신된다', () => {
        const originalRegisterCommand = vscode.commands.registerCommand;
        const originalCreateStatusBarItem = vscode.window.createStatusBarItem;
        const changed = new vscode.EventEmitter<void>();
        let unreadCount = 2;
        const status = { show: () => undefined, dispose: () => undefined } as unknown as vscode.StatusBarItem;
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        try {
            (vscode.commands as any).registerCommand = () => ({ dispose: () => undefined });
            (vscode.window as any).createStatusBarItem = () => status;
            registerFeatureLauncher(context, { onDidChange: changed.event, getUnreadCount: () => unreadCount });
            assert.ok(status.text.includes('$(circle-filled)'));
            assert.ok(String(status.tooltip).includes('2'));
            assert.ok(status.accessibilityInformation?.label.includes('2'));
            unreadCount = 0;
            changed.fire();
            assert.strictEqual(status.text, '$(tools) TaskHub');
            assert.ok(!String(status.tooltip).includes('2'));
        } finally {
            context.subscriptions.forEach(disposable => disposable.dispose());
            changed.dispose();
            (vscode.commands as any).registerCommand = originalRegisterCommand;
            (vscode.window as any).createStatusBarItem = originalCreateStatusBarItem;
        }
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
