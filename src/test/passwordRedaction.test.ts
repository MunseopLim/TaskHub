import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { actionStates } from '../providers/actionStatus';
import { HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem, Action as PipelineAction, Task } from '../schema';

/**
 * Password results are deliberately kept intact for execution and are only
 * redacted at display/persistence boundaries. These tests exercise both
 * halves of that contract: marker files prove what the child process really
 * received, while history and the verbose OutputChannel must never contain
 * the same value.
 */
suite('Password taint and redaction', function () {
    this.timeout(30000);

    let extension: typeof import('../extension');
    let tempWorkspace: string;
    const verboseLines: string[] = [];
    const extensionModulePath = require.resolve('../extension');
    let previousExtensionModule: NodeModule | undefined;
    let previousVerboseGlobal: boolean | undefined;
    let previousShowStatusGlobal: boolean | undefined;

    class MemoryMemento implements vscode.Memento {
        private readonly values = new Map<string, unknown>();

        keys(): readonly string[] {
            return Array.from(this.values.keys());
        }

        get<T>(key: string): T | undefined;
        get<T>(key: string, defaultValue: T): T;
        get<T>(key: string, defaultValue?: T): T | undefined {
            return this.values.has(key) ? this.values.get(key) as T : defaultValue;
        }

        update(key: string, value: unknown): Thenable<void> {
            this.values.set(key, value);
            return Promise.resolve();
        }

        setKeysForSync(_keys: readonly string[]): void {
            // Not needed by these tests.
        }
    }

    function makeContext(): vscode.ExtensionContext {
        return {
            extensionPath: tempWorkspace,
            subscriptions: [],
            workspaceState: new MemoryMemento(),
            globalState: new MemoryMemento(),
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-password-redaction-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    function makeMainViewProvider(): MainViewProvider {
        return { refresh: () => undefined } as unknown as MainViewProvider;
    }

    function platformCommand(command: string): NonNullable<Task['command']> {
        return { windows: command, macos: command, linux: command };
    }

    function nodeWriteArgumentScript(filePath: string): string {
        return [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(filePath)}, process.argv[1]);`,
            "process.stdout.write('ok');",
        ].join('');
    }

    suiteSetup(async () => {
        const originalCreateOutputChannel = vscode.window.createOutputChannel;
        const fakeOutputChannel: vscode.OutputChannel = {
            name: 'TaskHub',
            append: value => verboseLines.push(value),
            appendLine: value => verboseLines.push(value),
            replace: value => {
                verboseLines.length = 0;
                verboseLines.push(value);
            },
            clear: () => { verboseLines.length = 0; },
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        };

        // extension.ts captures its OutputChannel at module evaluation time.
        // Reload only that module while createOutputChannel is intercepted so
        // verbose-log assertions can use the production formatting paths.
        previousExtensionModule = require.cache[extensionModulePath];
        (vscode.window as any).createOutputChannel = (name: string, ...args: unknown[]) => {
            if (name === 'TaskHub') {
                return fakeOutputChannel;
            }
            return (originalCreateOutputChannel as any)(name, ...args);
        };
        try {
            delete require.cache[extensionModulePath];
            extension = require('../extension') as typeof import('../extension');
        } finally {
            (vscode.window as any).createOutputChannel = originalCreateOutputChannel;
        }

        const config = vscode.workspace.getConfiguration('taskhub');
        previousVerboseGlobal = config.inspect<boolean>('pipeline.showVerboseLogs')?.globalValue;
        previousShowStatusGlobal = config.inspect<boolean>('showTaskStatus')?.globalValue;
        await config.update('pipeline.showVerboseLogs', true, vscode.ConfigurationTarget.Global);
        await config.update('showTaskStatus', true, vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
        const config = vscode.workspace.getConfiguration('taskhub');
        await config.update('pipeline.showVerboseLogs', previousVerboseGlobal, vscode.ConfigurationTarget.Global);
        await config.update('showTaskStatus', previousShowStatusGlobal, vscode.ConfigurationTarget.Global);

        if (previousExtensionModule) {
            require.cache[extensionModulePath] = previousExtensionModule;
        } else {
            delete require.cache[extensionModulePath];
        }
    });

    setup(() => {
        verboseLines.length = 0;
        actionStates.clear();
        tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-password-redaction-'));
    });

    teardown(() => {
        actionStates.clear();
        if (tempWorkspace && fs.existsSync(tempWorkspace)) {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
        }
    });

    test('platform command 객체와 args/cwd를 가리면서 파생 결과와 실제 출력은 유지한다', async () => {
        const secret = 'T4int-X9';
        const secretCwd = path.join(tempWorkspace, secret);
        const invocationMarker = path.join(tempWorkspace, 'invocation.json');
        const outputMarker = path.join(tempWorkspace, 'output.json');
        fs.mkdirSync(secretCwd, { recursive: true });

        const originalShowInputBox = vscode.window.showInputBox;
        (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => {
            assert.strictEqual(options.password, true);
            return secret;
        };

        const observeInvocation = [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(invocationMarker)}, JSON.stringify({ title: process.title, arg: process.argv[1], cwd: process.cwd() }));`,
            "process.stdout.write('stdout:' + process.argv[1]);",
            "process.stderr.write('stderr:' + process.argv[1]);",
        ].join('');
        const observeOutputFlow = [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(outputMarker)}, JSON.stringify({ stdout: process.argv[1], stderr: process.argv[2] }));`,
            "process.stdout.write('verified');",
        ].join('');

        const actionItem: ActionItem = {
            id: 'password-platform-object',
            title: 'Password platform object',
            action: {
                description: 'password redaction across derived command fields',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'derived',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: '  ${ask.value}  ',
                        passTheResultToNextTask: true,
                    },
                    {
                        id: 'invoke',
                        type: 'command',
                        command: platformCommand('node --title=${derived.output}'),
                        args: ['-e', observeInvocation, '${derived.output}'],
                        cwd: path.join(tempWorkspace, '${derived.output}'),
                        passTheResultToNextTask: true,
                    },
                    {
                        id: 'verifyOutput',
                        type: 'command',
                        command: platformCommand('node'),
                        args: ['-e', observeOutputFlow, '${invoke.output}', '${invoke.stderr}'],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: true,
                    },
                ],
            },
        };
        const context = makeContext();
        const history = new HistoryProvider(context);

        try {
            await extension.executeAction(actionItem, context, makeMainViewProvider(), history);
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
        }

        const actualInvocation = JSON.parse(fs.readFileSync(invocationMarker, 'utf8'));
        assert.strictEqual(actualInvocation.title, secret,
            'redacted placeholder must never replace the real platform command');
        assert.strictEqual(actualInvocation.arg, secret,
            'redacted placeholder must never replace the real argument');
        // macOS reports os.tmpdir() as /var/... while process.cwd() resolves
        // the same directory through its /private/var/... real path.
        assert.strictEqual(fs.realpathSync(actualInvocation.cwd), fs.realpathSync(secretCwd),
            'redacted placeholder must never replace the real cwd');

        const actualOutputFlow = JSON.parse(fs.readFileSync(outputMarker, 'utf8'));
        assert.deepStrictEqual(actualOutputFlow, {
            stdout: `stdout:${secret}`,
            stderr: `stderr:${secret}`,
        }, 'captured stdout/stderr must stay intact for downstream execution');

        const entry = history.getHistory()[0];
        assert.ok(entry, 'a successful action must create history');
        assert.strictEqual(entry.status, 'success');
        assert.ok(entry.commands?.invoke.includes('--title=***'),
            `platform command branch was not redacted: ${entry.commands?.invoke}`);
        assert.ok(entry.commands?.invoke.includes('***'), 'redacted argument placeholder is missing');
        assert.ok(entry.commands?.verifyOutput.includes('***'), 'derived command output must remain tainted');
        assert.ok(!JSON.stringify(entry).includes(secret), 'password leaked into persisted history');

        const verbose = verboseLines.join('\n');
        assert.ok(!verbose.includes(secret), `password leaked into verbose logs:\n${verbose}`);
        assert.ok(verbose.includes(path.join(tempWorkspace, '***')),
            `redacted cwd is missing from verbose logs:\n${verbose}`);
        assert.ok(verbose.includes('[INFO] STDOUT: [REDACTED: task used a password input]'));
        assert.ok(verbose.includes('[INFO] STDERR: [REDACTED: task used a password input]'));
    });

    test('preset password도 prompt 없이 taint되어 실제 값만 실행에 전달한다', async () => {
        const secret = 'Preset-P4ss';
        const marker = path.join(tempWorkspace, 'preset-actual.txt');
        const originalShowInputBox = vscode.window.showInputBox;
        let promptCalls = 0;
        (vscode.window as any).showInputBox = async () => {
            promptCalls++;
            throw new Error('password prompt must be skipped for preset input');
        };

        const actionItem: ActionItem = {
            id: 'password-preset',
            title: 'Password preset',
            action: {
                description: 'preset password redaction',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'use',
                        type: 'command',
                        command: platformCommand('node'),
                        args: ['-e', nodeWriteArgumentScript(marker), '${ask.value}'],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: true,
                    },
                ],
            },
        };
        const context = makeContext();
        const history = new HistoryProvider(context);

        try {
            await extension.executeAction(
                actionItem,
                context,
                makeMainViewProvider(),
                history,
                { ask: { value: secret } },
            );
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
        }

        assert.strictEqual(promptCalls, 0);
        assert.strictEqual(fs.readFileSync(marker, 'utf8'), secret,
            'preset secret must reach the child process unchanged');
        const entry = history.getHistory()[0];
        assert.strictEqual(entry.status, 'success');
        assert.ok(entry.commands?.use.includes('***'));
        assert.ok(!entry.inputs || !Object.prototype.hasOwnProperty.call(entry.inputs, 'ask'));
        assert.ok(!JSON.stringify(entry).includes(secret), 'preset password leaked into history');
        assert.ok(!verboseLines.join('\n').includes(secret), 'preset password leaked into verbose logs');
    });

    test('verbose stdout/stderr와 실패 history에는 password를 남기지 않는다', async () => {
        const secret = 'Failure-P4ss';
        const marker = path.join(tempWorkspace, 'failure-actual.txt');
        const originalShowInputBox = vscode.window.showInputBox;
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const shownErrors: string[] = [];
        (vscode.window as any).showInputBox = async () => secret;
        (vscode.window as any).showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            return undefined;
        };

        const failingScript = [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(marker)}, process.argv[1]);`,
            "process.stdout.write('stdout:' + process.argv[1]);",
            "process.stderr.write('stderr:' + process.argv[1]);",
            'process.exit(7);',
        ].join('');
        const actionItem: ActionItem = {
            id: 'password-failure',
            title: 'Password failure',
            action: {
                description: 'password failure redaction',
                failMessage: 'Expected failure',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'fail',
                        type: 'command',
                        command: platformCommand('node'),
                        args: ['-e', failingScript, '${ask.value}'],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: true,
                    },
                ],
            },
        };
        const context = makeContext();
        const history = new HistoryProvider(context);
        let caught: unknown;

        try {
            await extension.executeAction(actionItem, context, makeMainViewProvider(), history);
        } catch (error) {
            caught = error;
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        }

        assert.ok(caught instanceof Error, 'failing command must reject the action');
        assert.ok(!caught.message.includes(secret), 'public rejection retained the password');
        assert.match(caught.message, /hidden because.*password input/i);
        assert.strictEqual(fs.readFileSync(marker, 'utf8'), secret,
            'failure redaction must not replace the actual child-process argument');

        const entry = history.getHistory()[0];
        assert.strictEqual(entry.status, 'failure');
        assert.match(entry.output ?? '', /hidden because.*password input/i);
        assert.ok(!JSON.stringify(entry).includes(secret), 'password leaked into failure history');
        assert.ok(shownErrors.length > 0, 'failure should still be surfaced to the user');
        assert.ok(!shownErrors.join('\n').includes(secret), 'password leaked into failure notification');

        const verbose = verboseLines.join('\n');
        assert.ok(!verbose.includes(secret), `password leaked into verbose failure logs:\n${verbose}`);
        assert.ok(verbose.includes('[INFO] STDOUT: [REDACTED: task used a password input]'));
        assert.ok(verbose.includes('[INFO] STDERR: [REDACTED: task used a password input]'));
    });

    test('password-tainted stdout와 cwd를 Problems diagnostics에 게시하지 않는다', async () => {
        const secret = 'Diagnostic-P4ss';
        const secretCwd = path.join(tempWorkspace, secret);
        fs.mkdirSync(secretCwd, { recursive: true });

        const originalShowInputBox = vscode.window.showInputBox;
        const originalCreateDiagnosticCollection = vscode.languages.createDiagnosticCollection;
        let createCalls = 0;
        let setCalls = 0;
        (vscode.window as any).showInputBox = async () => secret;
        (vscode.languages as any).createDiagnosticCollection = () => {
            createCalls++;
            return {
                name: 'password-diagnostic-test',
                set: () => { setCalls++; },
                delete: () => undefined,
                clear: () => undefined,
                forEach: () => undefined,
                get: () => undefined,
                has: () => false,
                dispose: () => undefined,
            } as unknown as vscode.DiagnosticCollection;
        };

        const diagnosticScript = [
            `process.stdout.write('relative.c:1:1: error: ' + process.argv[1]);`,
        ].join('');
        const actionItem: ActionItem = {
            id: 'password-diagnostics',
            title: 'Password diagnostics',
            action: {
                description: 'secret output must not enter Problems',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'compile',
                        type: 'command',
                        command: platformCommand('node'),
                        args: ['-e', diagnosticScript, '${ask.value}'],
                        cwd: path.join(tempWorkspace, '${ask.value}'),
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' },
                    },
                ],
            },
        };

        try {
            await extension.executeAction(actionItem, makeContext(), makeMainViewProvider());
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
            (vscode.languages as any).createDiagnosticCollection = originalCreateDiagnosticCollection;
        }

        assert.strictEqual(createCalls, 0, 'tainted diagnostics must not create a Problems collection');
        assert.strictEqual(setCalls, 0, 'tainted diagnostics must not publish a message or secret-derived URI');
        const verbose = verboseLines.join('\n');
        assert.ok(verbose.includes("Diagnostics for task 'compile' were suppressed"));
        assert.ok(!verbose.includes(secret), `password leaked while suppressing diagnostics:\n${verbose}`);
    });

    test('짧은 password는 참조 위치만 가리고 동일한 정적 문자열은 보존한다', async () => {
        const secret = '1';
        const marker = path.join(tempWorkspace, 'short-secret.json');
        const commandScript = [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(1)));`,
            "process.stdout.write('ok');",
        ].join('');
        const action: PipelineAction = {
            description: 'short password provenance redaction',
            tasks: [
                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                {
                    id: 'use',
                    type: 'command',
                    command: platformCommand('node'),
                    args: ['-e', commandScript, '${ask.value}', '--retries=1'],
                    cwd: tempWorkspace,
                    passTheResultToNextTask: true,
                },
            ],
        };
        const recordCommands: Record<string, string> = {};
        const recordInputs: Record<string, unknown> = {};

        await extension.executeActionPipeline(
            action,
            makeContext(),
            'password-short-secret',
            tempWorkspace,
            [tempWorkspace],
            {
                presetInputs: { ask: { value: secret } },
                recordCommands,
                recordInputs,
            },
        );

        assert.deepStrictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['1', '--retries=1'],
            'the child process must receive both original values');
        assert.ok(recordCommands.use.includes('***'), 'secret reference was not redacted');
        assert.ok(recordCommands.use.includes('--retries=1'),
            `provenance redaction over-masked an unrelated literal: ${recordCommands.use}`);
        assert.ok(!Object.prototype.hasOwnProperty.call(recordInputs, 'ask'));
    });
});
