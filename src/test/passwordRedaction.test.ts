import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { actionStates } from '../providers/actionStatus';
import { HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionRunLogCollector } from '../runLogStore';
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

    async function runPasswordSwitchFailure(matched: boolean): Promise<{
        secret: string;
        branchMarker: string;
        downstreamMarker: string;
        recordCommands: Record<string, string>;
        failure: Error;
        report: string;
    }> {
        const secret = matched ? 'Switch-Matched-P4ss' : 'Switch-Unmatched-P4ss';
        const id = matched ? 'password-switch-matched' : 'password-switch-unmatched';
        const branchMarker = path.join(tempWorkspace, `${id}-branch.txt`);
        const downstreamMarker = path.join(tempWorkspace, `${id}-downstream.txt`);
        const caseName = matched ? secret : 'some-other-case';
        const failingScript = [
            "const fs = require('fs');",
            `fs.writeFileSync(${JSON.stringify(downstreamMarker)}, process.argv[1]);`,
            "process.stdout.write('stdout:' + process.argv[1]);",
            "process.stderr.write('stderr:' + process.argv[1]);",
            'process.exit(7);',
        ].join('');
        const action: PipelineAction = {
            description: `${id} selector redaction`,
            tasks: [
                { id: 'pw', type: 'inputBox', prompt: 'password?', password: true },
                {
                    id: 'sw',
                    type: 'switch',
                    on: '${pw.value}',
                    cases: {
                        [caseName]: {
                            type: 'command',
                            command: platformCommand('node'),
                            args: ['-e', nodeWriteArgumentScript(branchMarker), '${pw.value}'],
                            cwd: tempWorkspace,
                            passTheResultToNextTask: true,
                        },
                    },
                },
                {
                    id: 'use',
                    type: 'command',
                    command: platformCommand('node'),
                    args: ['-e', failingScript, '${sw.selected}'],
                    cwd: tempWorkspace,
                    passTheResultToNextTask: true,
                },
            ],
        };
        const recordCommands: Record<string, string> = Object.create(null);
        const collector = new ActionRunLogCollector(id, id, Date.now(), action.tasks);
        const originalShowInputBox = vscode.window.showInputBox;
        (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => {
            assert.strictEqual(options.password, true);
            return secret;
        };

        let failure: Error | undefined;
        try {
            await extension.executeActionPipeline(
                action,
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { recordCommands, runLogCollector: collector },
            );
        } catch (error) {
            failure = error as Error;
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
        }

        assert.ok(failure, 'downstream command must fail so the public error path is exercised');
        return {
            secret,
            branchMarker,
            downstreamMarker,
            recordCommands,
            failure,
            report: JSON.stringify(collector.finish('failure', Date.now(), failure.message)),
        };
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
            // 이 suite 는 one-shot 을 `cwd: tempWorkspace` 로 띄운다. 테스트는
            // marker 파일이 보이면 곧바로 진행하는데 자식은 그 직후 아직 종료
            // 중이고, Windows 는 **실행 중 프로세스의 현재 디렉터리를 잠근다**
            // — 그 창에 걸리면 삭제가 `EPERM` 으로 죽어 정리 훅이 실패한다
            // (실측: Windows CI). `force` 는 "없는 경로 무시"일 뿐 EPERM 을
            // 재시도하지 않는다. pipelineIntegration.test.ts 와 같은 처리다:
            // 재시도 후에도 남으면 os.tmpdir() 아래 잔여 디렉터리는 무해하므로
            // 스위트를 실패시키지 않는다.
            try {
                fs.rmSync(tempWorkspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (err: any) {
                console.warn(`teardown: could not remove ${tempWorkspace} (${err?.code ?? err?.message ?? err}); leaving for OS temp cleanup`);
            }
        }
    });

    /**
     * `when` 이 거짓이면 그 사유가 verbose 로그에 그대로 실린다
     * (`condition-skipped` 분기). 사유에 **판정에 쓴 값**을 넣으면 비밀을
     * 참조하는 조건이 실패할 때 평문 비밀번호가 출력 채널에 남는다.
     *
     * 명령줄·cwd·출력은 진작부터 마스킹을 거쳤는데 이 경로만 빠져 있었다.
     */
    test('when 조건이 실패해도 비밀번호가 사유 문구로 새지 않는다', async () => {
        const secret = 'Wh3n-Gate-Secret';
        const marker = path.join(tempWorkspace, 'gate.json');

        const originalShowInputBox = vscode.window.showInputBox;
        (vscode.window as any).showInputBox = async () => secret;

        const actionItem: ActionItem = {
            id: 'password-when-gate',
            title: 'Password when gate',
            action: {
                description: 'when condition must not leak the password it compared',
                tasks: [
                    { id: 'pw', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        // 비밀번호와 절대 같지 않은 값을 요구해 조건을 반드시 실패시킨다.
                        id: 'gated',
                        type: 'command',
                        command: platformCommand('node'),
                        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
                        cwd: tempWorkspace,
                        when: { var: '${pw.value}', equals: 'definitely-not-the-password' },
                    },
                ],
            },
        };
        const context = makeContext();

        try {
            await extension.executeAction(actionItem, context, makeMainViewProvider(), new HistoryProvider(context));
        } finally {
            (vscode.window as any).showInputBox = originalShowInputBox;
        }

        assert.ok(!fs.existsSync(marker), '조건이 거짓인데 태스크가 실행됐다 — 픽스처가 잘못됐다');

        const verbose = verboseLines.join('\n');
        assert.ok(verbose.includes("Task 'gated' skipped"),
            `조건 스킵이 verbose 로그에 남지 않았다 — 이 테스트가 겨누는 줄이 없다:\n${verbose}`);
        assert.ok(!verbose.includes(secret), `비밀번호가 조건 사유로 샜다:\n${verbose}`);
        assert.ok(verbose.includes('***'), `사유의 값이 자리표시자로 바뀌지 않았다:\n${verbose}`);
    });

    test('password switch case 일치 결과는 명령·보고서·오류에서 가린다', async () => {
        const result = await runPasswordSwitchFailure(true);

        assert.strictEqual(fs.readFileSync(result.branchMarker, 'utf8'), result.secret,
            '선택된 case에는 실제 비밀번호가 전달되어야 한다');
        assert.strictEqual(fs.readFileSync(result.downstreamMarker, 'utf8'), result.secret,
            'switch.selected는 downstream 실행에 실제 선택값을 전달해야 한다');
        assert.deepStrictEqual(Object.keys(result.recordCommands).sort(), ['sw', 'use']);
        for (const command of Object.values(result.recordCommands)) {
            assert.ok(!command.includes(result.secret), `실행 기록에 switch 선택값이 남았다: ${command}`);
            assert.ok(command.includes('***'), `실행 기록에 마스킹 자리표시자가 없다: ${command}`);
        }
        assert.ok(!result.failure.message.includes(result.secret),
            `실패 오류에 switch 선택값이 남았다: ${result.failure.message}`);
        assert.ok(result.failure.message.includes('***'),
            `실패 오류에 마스킹된 명령이 없다: ${result.failure.message}`);
        assert.ok(!result.report.includes(result.secret),
            `collector 보고서에 switch 선택값이 남았다: ${result.report}`);
        assert.ok(result.report.includes('***'), 'collector 보고서에 마스킹 자리표시자가 없다');
        assert.ok(!verboseLines.join('\n').includes(result.secret), 'verbose 로그에 switch 선택값이 남았다');
    });

    test('password switch 미일치 selected 결과도 명령·보고서·오류에서 가린다', async () => {
        const result = await runPasswordSwitchFailure(false);

        assert.strictEqual(fs.existsSync(result.branchMarker), false,
            '일치하는 case가 없는데 branch가 실행됐다');
        assert.strictEqual(fs.readFileSync(result.downstreamMarker, 'utf8'), result.secret,
            '미일치 switch도 selected에 실제 선택값을 반환해야 한다');
        assert.deepStrictEqual(Object.keys(result.recordCommands), ['use']);
        assert.ok(!result.recordCommands.use.includes(result.secret),
            `실행 기록에 미일치 선택값이 남았다: ${result.recordCommands.use}`);
        assert.ok(result.recordCommands.use.includes('***'),
            `실행 기록에 마스킹 자리표시자가 없다: ${result.recordCommands.use}`);
        assert.ok(!result.failure.message.includes(result.secret),
            `실패 오류에 미일치 선택값이 남았다: ${result.failure.message}`);
        assert.ok(result.failure.message.includes('***'),
            `실패 오류에 마스킹된 명령이 없다: ${result.failure.message}`);
        assert.ok(!result.report.includes(result.secret),
            `collector 보고서에 미일치 선택값이 남았다: ${result.report}`);
        assert.ok(result.report.includes('***'), 'collector 보고서에 마스킹 자리표시자가 없다');
        assert.ok(!verboseLines.join('\n').includes(result.secret), 'verbose 로그에 미일치 선택값이 남았다');
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

    test('passTheResultToNextTask=false 민감 태스크는 기본 터미널 대신 bounded capture로 실행한다', async () => {
        const secret = 'No-Terminal-S3cret';
        const marker = path.join(tempWorkspace, 'no-terminal.marker');
        const originalExecuteTask = vscode.tasks.executeTask;
        let executeTaskCalls = 0;
        (vscode.tasks as any).executeTask = (..._args: unknown[]) => {
            executeTaskCalls++;
            throw new Error('sensitive non-one-shot must not enter the VS Code task terminal');
        };

        const actionItem: ActionItem = {
            id: 'sensitive-no-terminal',
            title: 'Sensitive no terminal',
            action: {
                description: 'discard password-derived output safely',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'deploy',
                        type: 'command',
                        command: platformCommand('node'),
                        args: [
                            '-e',
                            `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv[1]); process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]);`,
                            '${ask.value}',
                        ],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: false,
                    },
                ],
            },
        };

        try {
            await extension.executeActionPipeline(
                actionItem.action as PipelineAction,
                makeContext(),
                actionItem.id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
        } finally {
            (vscode.tasks as any).executeTask = originalExecuteTask;
        }

        assert.strictEqual(executeTaskCalls, 0);
        assert.strictEqual(fs.readFileSync(marker, 'utf8'), secret, '실제 배포 명령은 실행돼야 한다');
        assert.ok(!verboseLines.join('\n').includes(secret), 'discard된 민감 출력이 verbose log에 샜다');
    });

    test('민감 output.mode editor/terminal은 억제하고 file 저장은 opt-in 으로만 허용한다', async () => {
        const secret = 'Output-Mode-S3cret';
        const outputFile = path.join(tempWorkspace, `${secret}-output.txt`);
        const originalOpen = vscode.workspace.openTextDocument;
        const originalCreateTerminal = vscode.window.createTerminal;
        const originalShowWarning = vscode.window.showWarningMessage;
        let editorCalls = 0;
        let terminalCalls = 0;
        const warnings: string[] = [];
        (vscode.workspace as any).openTextDocument = (..._args: unknown[]) => {
            editorCalls++;
            throw new Error('password-derived output must not enter an untitled editor');
        };
        (vscode.window as any).createTerminal = (..._args: unknown[]) => {
            terminalCalls++;
            throw new Error('password-derived output must not enter a terminal');
        };
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };

        const outputCommand = {
            type: 'command' as const,
            command: platformCommand('node'),
            args: ['-e', 'process.stdout.write(process.argv[1])', '${ask.value}'],
            cwd: tempWorkspace,
            passTheResultToNextTask: true,
        };
        const actionItem: ActionItem = {
            id: 'sensitive-output-modes',
            title: 'Sensitive output modes',
            action: {
                description: 'sensitive display boundaries',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    { id: 'editor', ...outputCommand, output: { mode: 'editor' } },
                    { id: 'terminal', ...outputCommand, output: { mode: 'terminal' } },
                    {
                        id: 'file',
                        ...outputCommand,
                        // 저장 경로가 명시적이라는 것과 **비밀을 남기겠다는
                        // 의도**가 명시적인 것은 다르다. 후자는 이 플래그로만
                        // 선언된다.
                        allowSecretContent: true,
                        output: {
                            mode: 'file',
                            filePath: '${workspaceFolder}/${ask.value}-output.txt',
                            overwrite: true,
                        },
                    },
                ],
            },
        };

        try {
            await extension.executeActionPipeline(
                actionItem.action as PipelineAction,
                makeContext(),
                actionItem.id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
        } finally {
            (vscode.workspace as any).openTextDocument = originalOpen;
            (vscode.window as any).createTerminal = originalCreateTerminal;
            (vscode.window as any).showWarningMessage = originalShowWarning;
        }

        assert.strictEqual(editorCalls, 0);
        assert.strictEqual(terminalCalls, 0);
        // editor/terminal 억제 2건 + 비밀이 디스크에 남았다는 고지 1건.
        assert.strictEqual(warnings.length, 3, 'editor/terminal 억제와 파일 저장 사실을 각각 알려야 한다');
        assert.ok(!warnings.join('\n').includes(secret));
        assert.ok(!warnings.some(message => message.includes(outputFile)),
            '민감 입력에서 파생될 수 있는 파일 경로를 알림에 노출했다');
        assert.ok(warnings.some(message => message.includes('***-output.txt')),
            '파일 저장 고지에서 정적 경로까지 모두 잃었다');
        assert.strictEqual(fs.readFileSync(outputFile, 'utf8'), secret,
            'allowSecretContent 를 선언한 mode:file 저장은 그대로 수행한다');
        if (process.platform !== 'win32') {
            assert.strictEqual(
                fs.statSync(outputFile).mode & 0o777, 0o600,
                '비밀이 담긴 파일은 소유자만 읽을 수 있어야 한다'
            );
        }
    });

    test('allowSecretContent 없이는 password 파생 값을 파일로 쓰지 않는다', async () => {
        const secret = 'No-OptIn-S3cret';
        const outputFile = path.join(tempWorkspace, 'refused-output.txt');
        const writeFileTarget = path.join(tempWorkspace, 'refused-write.txt');

        for (const task of [
            {
                id: 'toFile',
                type: 'command' as const,
                command: platformCommand('node'),
                args: ['-e', 'process.stdout.write(process.argv[1])', '${ask.value}'],
                cwd: tempWorkspace,
                passTheResultToNextTask: true,
                output: { mode: 'file' as const, filePath: outputFile, overwrite: true },
            },
            {
                id: 'toFile',
                type: 'writeFile' as const,
                path: writeFileTarget,
                content: '${ask.value}',
            },
        ]) {
            const actionItem: ActionItem = {
                id: 'secret-file-optin',
                title: 'Secret file opt-in',
                action: {
                    description: 'refuse secret persistence without the flag',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        task,
                    ] as Task[],
                },
            };

            await assert.rejects(
                extension.executeActionPipeline(
                    actionItem.action as PipelineAction,
                    makeContext(),
                    actionItem.id,
                    tempWorkspace,
                    [tempWorkspace],
                    { presetInputs: { ask: { value: secret } } }
                ),
                (error: unknown) =>
                    error instanceof Error && /allowSecretContent/.test(error.message),
                `${task.type} must refuse without the opt-in`
            );
        }

        assert.ok(!fs.existsSync(outputFile), '거부된 output.mode:file 이 파일을 남겼다');
        assert.ok(!fs.existsSync(writeFileTarget), '거부된 writeFile 이 파일을 남겼다');
    });

    /**
     * 위 테스트는 비밀을 **참조하는** 태스크만 본다. 비밀을 만드는 태스크
     * 자신은 `secretTaskIds` 에 들어가기 **전에** 자기 output 을 처리하므로,
     * 같은 가드가 걸리는지 따로 확인해야 한다 — 이쪽이 더 직접적이다.
     * `${ask.value}` 를 거치지 않고 비밀번호 **원문**이 그대로 나간다.
     */
    test('password inputBox 자신의 output.mode editor/terminal도 억제한다 (file 은 opt-in)', async () => {
        const secret = 'Self-Output-S3cret';
        const outputFile = path.join(tempWorkspace, 'self-sensitive-output.txt');
        const originalOpen = vscode.workspace.openTextDocument;
        const originalCreateTerminal = vscode.window.createTerminal;
        const originalShowWarning = vscode.window.showWarningMessage;
        let editorCalls = 0;
        let terminalCalls = 0;
        const warnings: string[] = [];
        (vscode.workspace as any).openTextDocument = (..._args: unknown[]) => {
            editorCalls++;
            throw new Error('the password itself must not enter an untitled editor');
        };
        (vscode.window as any).createTerminal = (..._args: unknown[]) => {
            terminalCalls++;
            throw new Error('the password itself must not enter a terminal');
        };
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };

        const actionItem: ActionItem = {
            id: 'sensitive-self-output',
            title: 'Sensitive self output',
            action: {
                description: 'password task own output',
                tasks: [
                    {
                        id: 'askEditor',
                        type: 'inputBox',
                        prompt: 'password?',
                        password: true,
                        passTheResultToNextTask: true,
                        output: { mode: 'editor' },
                    },
                    {
                        id: 'askTerminal',
                        type: 'inputBox',
                        prompt: 'password again?',
                        password: true,
                        passTheResultToNextTask: true,
                        output: { mode: 'terminal' },
                    },
                    // `mode: file` 은 `allowSecretContent` 를 선언한 경우에만
                    // 수행한다. 비밀번호 태스크 **자신의** output 도 같은
                    // 게이트를 지나는지 여기서 고정한다 — 이쪽은 `${ask.value}`
                    // 를 거치지 않고 원문이 그대로 나가는 경로다.
                    {
                        id: 'askFile',
                        type: 'inputBox',
                        prompt: 'password to file?',
                        password: true,
                        passTheResultToNextTask: true,
                        allowSecretContent: true,
                        output: { mode: 'file', filePath: outputFile, overwrite: true },
                    },
                ] as Task[],
            },
        };

        try {
            await extension.executeActionPipeline(
                actionItem.action as PipelineAction,
                makeContext(),
                actionItem.id,
                tempWorkspace,
                [tempWorkspace],
                {
                    presetInputs: {
                        askEditor: { value: secret },
                        askTerminal: { value: secret },
                        askFile: { value: secret },
                    },
                }
            );
        } finally {
            (vscode.workspace as any).openTextDocument = originalOpen;
            (vscode.window as any).createTerminal = originalCreateTerminal;
            (vscode.window as any).showWarningMessage = originalShowWarning;
        }

        assert.strictEqual(editorCalls, 0, 'hot-exit 백업 대상인 untitled 에디터에 비밀번호가 그대로 들어갔다');
        assert.strictEqual(terminalCalls, 0, '터미널에 비밀번호가 그대로 찍혔다');
        assert.strictEqual(warnings.length, 3, 'editor/terminal 억제와 파일 저장 사실을 각각 알려야 한다');
        assert.ok(!warnings.join('\n').includes(secret), '억제 안내 문구에 비밀번호가 섞였다');
        // `output.content` 가 없으면 결과 객체 전체가 직렬화되므로
        // (`inputBox` 는 `{ value }`) 정확히 일치하는 대신 포함으로 본다.
        assert.ok(
            fs.readFileSync(outputFile, 'utf8').includes(secret),
            'allowSecretContent 를 선언한 mode:file 이 막혔다'
        );
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(outputFile).mode & 0o777, 0o600);
        }
    });

    test('password-derived ZIP의 제외 symlink 경고는 경로 없이 한 줄로 요약한다', async function () {
        if (process.platform === 'win32') { this.skip(); }

        const secret = 'Zip-Path-S3cret';
        const sourceDir = path.join(tempWorkspace, secret);
        const outsideTarget = path.join(tempWorkspace, `outside-${secret}.txt`);
        const linkName = `leaky-${secret}`;
        const archivePath = path.join(tempWorkspace, 'safe.zip');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(outsideTarget, 'outside');
        fs.symlinkSync(outsideTarget, path.join(sourceDir, linkName));

        const originalShowWarning = vscode.window.showWarningMessage;
        const warnings: string[] = [];
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };
        const actionItem: ActionItem = {
            id: 'sensitive-zip-symlink',
            title: 'Sensitive ZIP symlink',
            action: {
                description: 'redact skipped symlink paths',
                tasks: [
                    { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                    {
                        id: 'zip',
                        type: 'zip',
                        source: path.join(tempWorkspace, '${ask.value}'),
                        archive: archivePath,
                    },
                ],
            },
        };

        try {
            await extension.executeAction(
                actionItem,
                makeContext(),
                makeMainViewProvider(),
                undefined,
                { ask: { value: secret } }
            );
        } finally {
            (vscode.window as any).showWarningMessage = originalShowWarning;
        }

        const visible = `${warnings.join('\n')}\n${verboseLines.join('\n')}`;
        assert.ok(fs.existsSync(archivePath));
        assert.strictEqual(warnings.length, 1);
        assert.ok(/1/.test(warnings[0]), '제외 개수는 알려야 한다');
        assert.ok(!visible.includes(secret), `민감 symlink 경로가 노출됐다:\n${visible}`);
        assert.ok(!visible.includes(outsideTarget));
        assert.strictEqual(
            verboseLines.filter(line => /password-derived zip task/i.test(line)).length,
            1,
            '민감 symlink 경고는 링크별 로그가 아니라 요약 한 줄이어야 한다'
        );
    });

    test('민감 one-shot은 detached 생명주기를 유지하고 터미널·Stop All 유령을 만들지 않는다', async () => {
        const id = 'sensitive-one-shot-detached';
        const secret = 'Detached-S3cret';
        const marker = path.join(tempWorkspace, 'detached-one-shot.marker');
        const originalExecuteTask = vscode.tasks.executeTask;
        let executeTaskCalls = 0;
        (vscode.tasks as any).executeTask = () => {
            executeTaskCalls++;
            throw new Error('sensitive one-shot must not create a terminal Task');
        };

        try {
            await extension.executeActionPipeline(
                {
                    description: 'sensitive detached one-shot',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'background',
                            type: 'command',
                            command: platformCommand('node'),
                            args: [
                                '-e',
                                `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv[1]), 100);`,
                                '${ask.value}',
                            ],
                            isOneShot: true,
                        },
                    ],
                },
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
            assert.strictEqual(executeTaskCalls, 0, '민감 one-shot이 터미널 Task를 만들었다');
            assert.strictEqual(extension.stopRunningAction(id), false,
                '완료된 pipeline 뒤에 one-shot이 Stop All 유령 대상을 만들었다');

            // Windows CI의 Defender cold-start 지연을 제품 실패로 오인하지
            // 않도록 로컬보다 넉넉히 기다린다. native 경로는 판정된 실행
            // 파일을 직접 띄워 PowerShell 래퍼의 추가 시작 지연은 없다.
            const deadline = Date.now() + (process.platform === 'win32' ? 10000 : 3000);
            while (!fs.existsSync(marker) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.ok(
                fs.existsSync(marker),
                `detached one-shot marker timeout:\n${verboseLines.join('\n').split(secret).join('***')}`
            );
            assert.strictEqual(fs.readFileSync(marker, 'utf8'), secret,
                'detached one-shot이 pipeline 종료 뒤에도 완주하지 못했다');
            assert.ok(!verboseLines.join('\n').includes(secret), 'one-shot command가 verbose log에 샜다');
        } finally {
            (vscode.tasks as any).executeTask = originalExecuteTask;
        }
    });

    test('Windows 민감 non-native one-shot은 PowerShell 경로에서도 실행을 완주한다', async function () {
        if (process.platform !== 'win32') { this.skip(); }

        const id = 'sensitive-one-shot-cmd-shim';
        const secret = 'Cmd Shim S3cret & tail';
        const marker = path.join(tempWorkspace, 'cmd-shim-one-shot.marker');
        const runner = path.join(tempWorkspace, 'cmd-shim-runner.js');
        const shim = path.join(tempWorkspace, 'sensitive-shim.cmd');
        // 실패했을 때 `PowerShell → cmd.exe → %* → node` 중 **어디서** 끊겼는지
        // 한 번의 실행으로 가르기 위한 중간 신호들. 이게 없으면 "marker 없음"
        // 하나만 남아 제품 문제와 fixture 인용 문제를 구분할 수 없다.
        const reachedMarker = path.join(tempWorkspace, 'cmd-shim-reached.marker');
        const argvDump = path.join(tempWorkspace, 'cmd-shim-argv.json');
        fs.writeFileSync(
            runner,
            "const fs = require('fs');\n"
            + `fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv));\n`
            + 'fs.writeFileSync(process.argv[2], process.argv[3]);\n',
            'utf8'
        );
        fs.writeFileSync(
            shim,
            '@echo off\r\n'
            // 리다이렉션을 앞에 두어 `%*` 의 끝 문자가 리다이렉트 핸들로 읽히지
            // 않게 한다. 이 줄은 `%*` 를 건드리지 않으므로, 인용이 깨져 있어도
            // 배치가 실행됐다는 사실만은 반드시 남는다.
            + `>"%~dp0cmd-shim-reached.marker" echo reached\r\n`
            + 'node "%~dp0cmd-shim-runner.js" %*\r\n'
            + 'exit /b %errorlevel%\r\n',
            'utf8'
        );

        const originalExecuteTask = vscode.tasks.executeTask;
        const originalShowError = vscode.window.showErrorMessage;
        const shownErrors: string[] = [];
        let executeTaskCalls = 0;
        (vscode.tasks as any).executeTask = () => {
            executeTaskCalls++;
            throw new Error('sensitive one-shot must not create a terminal Task');
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            return undefined;
        };

        try {
            await extension.executeActionPipeline(
                {
                    description: 'sensitive .cmd shim one-shot',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'background',
                            type: 'command',
                            command: platformCommand(shim),
                            args: [marker, '${ask.value}'],
                            isOneShot: true,
                        },
                    ],
                },
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
            assert.strictEqual(executeTaskCalls, 0, '민감 .cmd one-shot이 터미널 Task를 만들었다');
            assert.strictEqual(extension.stopRunningAction(id), false,
                '완료된 pipeline 뒤에 .cmd one-shot이 Stop All 유령 대상을 만들었다');

            const deadline = Date.now() + 10000;
            while (!fs.existsSync(marker) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const redact = (value: string) => value.split(secret).join('***');
            const readIfPresent = (filePath: string) =>
                fs.existsSync(filePath) ? redact(fs.readFileSync(filePath, 'utf8').trim()) : '(없음)';
            assert.ok(
                fs.existsSync(marker),
                'PowerShell .cmd one-shot marker timeout — 어디서 끊겼는지:\n'
                + `  batch 진입(cmd.exe 실행됨): ${readIfPresent(reachedMarker)}\n`
                + `  node argv(%* 전달됨): ${readIfPresent(argvDump)}\n`
                + `  실패 알림(spawn 오류 또는 nonzero 종료): ${redact(shownErrors.join(' | ')) || '(없음)'}\n`
                + '  → 셋 다 없음이면 PowerShell 래퍼가 배치를 시작하지 못한 것(제품),\n'
                + '    진입만 있으면 `%*` 인용이 node 호출을 깨뜨린 것(fixture)이다.\n'
                + `${redact(verboseLines.join('\n'))}`
            );
            assert.strictEqual(fs.readFileSync(marker, 'utf8'), secret,
                'PowerShell .cmd one-shot이 password 인자를 보존하지 못했다');
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.strictEqual(shownErrors.length, 0,
                `성공한 민감 .cmd one-shot이 실패 알림을 냈다: ${redact(shownErrors.join(' | '))}`);
            assert.ok(!verboseLines.join('\n').includes(secret), '민감 .cmd 명령이 verbose log에 샜다');
        } finally {
            (vscode.tasks as any).executeTask = originalExecuteTask;
            (vscode.window as any).showErrorMessage = originalShowError;
        }
    });

    /**
     * 위 nonzero 테스트는 `node` 라 Windows 에서 native argv 분기만 탄다. `.cmd`
     * 는 PowerShell 분기로 가는데, 그 분기가 종료 코드를 그대로 물려주는지가
     * 이번 설계에서 `Start-Process` 를 **쓰지 않기로 한 이유**다 — `Start-Process`
     * 는 바깥 PowerShell 을 즉시 exit 0 으로 끝내 실패 알림을 없앤다. 이 경로는
     * stdio 도 없고 안내도 무내용이라, 알림이 유일한 단서다.
     */
    test('민감 non-native one-shot의 nonzero exit도 실패 알림을 한 번만 낸다', async function () {
        if (process.platform !== 'win32') { this.skip(); }

        const id = 'sensitive-one-shot-cmd-failure';
        const secret = 'Cmd Failure S3cret & tail';
        const shim = path.join(tempWorkspace, 'failing-shim.cmd');
        fs.writeFileSync(shim, '@echo off\r\nexit /b 7\r\n', 'utf8');

        const originalExecuteTask = vscode.tasks.executeTask;
        const originalShowError = vscode.window.showErrorMessage;
        const shownErrors: string[] = [];
        let executeTaskCalls = 0;
        let resolveFailure!: () => void;
        const failureShown = new Promise<void>(resolve => { resolveFailure = resolve; });
        (vscode.tasks as any).executeTask = () => {
            executeTaskCalls++;
            throw new Error('sensitive one-shot must not create a terminal Task');
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            resolveFailure();
            return undefined;
        };

        try {
            await extension.executeActionPipeline(
                {
                    description: 'sensitive .cmd shim failure reporting',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'background',
                            type: 'command',
                            command: platformCommand(shim),
                            args: ['${ask.value}'],
                            isOneShot: true,
                        },
                    ],
                },
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
            assert.strictEqual(executeTaskCalls, 0, '민감 .cmd one-shot이 터미널 Task를 만들었다');
            await Promise.race([
                failureShown,
                new Promise<never>((_, reject) => setTimeout(
                    () => reject(new Error(
                        'PowerShell .cmd one-shot이 exit 7을 알리지 않았다 '
                        + '(Start-Process 처럼 즉시 exit 0 으로 끝나면 이 단서가 사라진다):\n'
                        + verboseLines.join('\n').split(secret).join('***')
                    )),
                    10000
                )),
            ]);
            await new Promise(resolve => setTimeout(resolve, 25));
        } finally {
            (vscode.tasks as any).executeTask = originalExecuteTask;
            (vscode.window as any).showErrorMessage = originalShowError;
        }

        assert.strictEqual(shownErrors.length, 1, `error/exit가 중복 알림을 냈다: ${shownErrors.join(' | ')}`);
        assert.ok(!shownErrors[0].includes(secret), '실패 알림에 비밀이 샜다');
        assert.match(shownErrors[0], /details were hidden|상세.*숨겼/i);
        assert.strictEqual(extension.stopRunningAction(id), false);
    });

    test('민감 native one-shot의 nonzero exit는 경로 없는 실패 알림을 한 번만 낸다', async () => {
        const id = 'sensitive-one-shot-failure';
        const secret = 'Detached-Failure-S3cret';
        const originalShowError = vscode.window.showErrorMessage;
        const shownErrors: string[] = [];
        let resolveFailure!: () => void;
        const failureShown = new Promise<void>(resolve => { resolveFailure = resolve; });
        (vscode.window as any).showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            resolveFailure();
            return undefined;
        };

        try {
            await extension.executeActionPipeline(
                {
                    description: 'sensitive detached failure reporting',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'background',
                            type: 'command',
                            command: platformCommand('node'),
                            args: ['-e', 'process.exit(7)', '${ask.value}'],
                            isOneShot: true,
                        },
                    ],
                },
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );
            await Promise.race([
                failureShown,
                new Promise<never>((_, reject) => setTimeout(
                    () => reject(new Error(
                        `one-shot failure notification timeout:\n${verboseLines.join('\n').split(secret).join('***')}`
                    )),
                    process.platform === 'win32' ? 10000 : 3000
                )),
            ]);
            await new Promise(resolve => setTimeout(resolve, 25));
        } finally {
            (vscode.window as any).showErrorMessage = originalShowError;
        }

        assert.strictEqual(shownErrors.length, 1, `error/exit가 중복 알림을 냈다: ${shownErrors.join(' | ')}`);
        assert.ok(!shownErrors[0].includes(secret));
        assert.match(shownErrors[0], /details were hidden|상세.*숨겼/i);
        assert.strictEqual(extension.stopRunningAction(id), false);
    });

    test('IT-193g: explicit off는 민감 detached one-shot 실패도 로그만 남긴다', async () => {
        const config = vscode.workspace.getConfiguration('taskhub');
        const previousNotifications = config.inspect('executionNotifications')?.globalValue;
        const id = 'sensitive-one-shot-notification-off';
        const secret = 'Detached-Off-S3cret';
        const originalShowError = vscode.window.showErrorMessage;
        const shownErrors: string[] = [];
        (vscode.window as any).showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            return undefined;
        };

        try {
            await config.update('executionNotifications', 'off', vscode.ConfigurationTarget.Global);
            await extension.executeActionPipeline(
                {
                    description: 'silent sensitive detached failure reporting',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'background',
                            type: 'command',
                            command: platformCommand('node'),
                            args: ['-e', 'process.exit(7)', '${ask.value}'],
                            isOneShot: true,
                        },
                    ],
                },
                makeContext(),
                id,
                tempWorkspace,
                [tempWorkspace],
                { presetInputs: { ask: { value: secret } } }
            );

            const deadline = Date.now() + (process.platform === 'win32' ? 10000 : 3000);
            while (!verboseLines.some(line => /Sensitive one-shot|민감 원샷/.test(line))
                && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.ok(verboseLines.some(line => /Sensitive one-shot|민감 원샷/.test(line)),
                '알림을 꺼도 one-shot 실패는 출력 채널에 진단 흔적을 남겨야 한다');
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.deepStrictEqual(shownErrors, [],
                'explicit off인데 민감 one-shot 실패 토스트가 설정을 우회하면 안 된다');
            assert.ok(!verboseLines.join('\n').includes(secret));
        } finally {
            (vscode.window as any).showErrorMessage = originalShowError;
            await config.update('executionNotifications', previousNotifications, vscode.ConfigurationTarget.Global);
        }
    });

    /**
     * 실패 원인을 통째로 가리면 비밀번호를 쓰는 flash/deploy 가 실패했을 때
     * 사용자가 아무 단서도 없이 막힌다. 정책을 "기본은 안전한 메타데이터만,
     * 상세는 사용자가 승인한 일회성 실행에서만" 으로 완화했다 (0.6.46).
     */
    suite('실패 메타데이터와 일회성 민감 디버그', () => {

        /** 지정한 종료 코드로 끝나며 stderr 에 비밀을 그대로 뱉는 스크립트. */
        function makeFailingScript(secret: string, exitCode: number): string {
            const scriptPath = path.join(tempWorkspace, 'fail.js');
            fs.writeFileSync(
                scriptPath,
                `process.stderr.write('boom ' + process.argv[2] + '\\n');\n` +
                `process.exit(${exitCode});\n`
            );
            return scriptPath;
        }

        function passwordAction(id: string, scriptPath: string): ActionItem {
            return {
                id,
                title: `Sensitive ${id}`,
                action: {
                    description: 'a task that consumes a password and fails',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'use',
                            type: 'shell',
                            command: `node ${JSON.stringify(scriptPath)} \${ask.value}`,
                            passTheResultToNextTask: true,
                        },
                    ] as unknown as Task[],
                } as unknown as PipelineAction,
            } as unknown as ActionItem;
        }

        test('실패 메시지에 단계·종료 코드·마스킹된 명령이 남고 비밀은 없다', async () => {
            const secret = 'Sup3r-S3cret-Value';
            const scriptPath = makeFailingScript(secret, 3);
            const originalInputBox = vscode.window.showInputBox;
            (vscode.window as any).showInputBox = () => Promise.resolve(secret);

            let failure: Error | undefined;
            try {
                await extension.executeAction(
                    passwordAction('sensitive-meta', scriptPath),
                    makeContext(),
                    makeMainViewProvider()
                );
            } catch (e) {
                failure = e as Error;
            } finally {
                (vscode.window as any).showInputBox = originalInputBox;
            }

            assert.ok(failure, '태스크가 실패해야 이 테스트가 의미를 갖는다');
            const message = failure!.message;
            assert.ok(!message.includes(secret), `실패 메시지에 비밀이 남았다: ${message}`);
            assert.ok(!message.includes('boom'), `stderr 원문이 새어 나왔다: ${message}`);
            assert.ok(/\b3\b/.test(message), `종료 코드가 없다: ${message}`);
            assert.ok(message.includes('***'), `마스킹된 명령이 없다: ${message}`);
        });

        test('실패 알림 → 모달 동의 → 성공 재실행이 running 가드에 막히지 않는다', async () => {
            const id = 'sensitive-ui-rerun';
            const secret = 'UI-Rerun-S3cret';
            const firstRunMarker = path.join(tempWorkspace, 'first-run.marker');
            const scriptPath = path.join(tempWorkspace, 'fail-once.js');
            fs.writeFileSync(scriptPath, [
                "const fs = require('fs');",
                `const marker = ${JSON.stringify(firstRunMarker)};`,
                'if (!fs.existsSync(marker)) {',
                "  fs.writeFileSync(marker, 'failed');",
                "  process.stderr.write('first failure ' + process.argv[2]);",
                '  process.exit(9);',
                '}',
                "process.stdout.write('rerun success ' + process.argv[2]);",
            ].join('\n'));

            const context = makeContext();
            const history = new HistoryProvider(context);
            const originalInputBox = vscode.window.showInputBox;
            const originalShowError = vscode.window.showErrorMessage;
            const originalShowWarning = vscode.window.showWarningMessage;
            const originalShowInformation = vscode.window.showInformationMessage;
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            const stateAtFailurePrompt: Array<string | undefined> = [];
            const informationMessages: string[] = [];
            let modalCalls = 0;
            let panelHtml = '';
            let panelOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions | undefined;
            let resolvePanel!: () => void;
            const panelShown = new Promise<void>(resolve => { resolvePanel = resolve; });

            (vscode.window as any).showInputBox = () => Promise.resolve(secret);
            (vscode.window as any).showErrorMessage = async (_message: string, ...items: unknown[]) => {
                stateAtFailurePrompt.push(actionStates.get(id)?.state);
                return items.find(item => typeof item === 'string' && /민감 디버그|sensitive debug/i.test(item as string));
            };
            (vscode.window as any).showWarningMessage = async (_message: string, ...items: unknown[]) => {
                modalCalls++;
                // Ensure the second history timestamp cannot collide with the
                // first run's millisecond timestamp.
                await new Promise(resolve => setTimeout(resolve, 5));
                return [...items].reverse().find(item => typeof item === 'string');
            };
            (vscode.window as any).showInformationMessage = async (message: string) => {
                informationMessages.push(message);
                return undefined;
            };
            (vscode.window as any).createWebviewPanel = (_viewType: string, _title: string, _column: unknown, options: any) => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) {
                        panelHtml = value;
                        resolvePanel();
                    },
                },
                __options: (panelOptions = options),
            } as unknown as vscode.WebviewPanel);

            try {
                await extension.executeAction(
                    passwordAction(id, scriptPath),
                    context,
                    makeMainViewProvider(),
                    history
                ).catch(() => { /* 첫 실패는 재실행 제안의 입력이다. */ });

                await Promise.race([
                    panelShown,
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sensitive debug panel timeout')), 5000)),
                ]);
            } finally {
                (vscode.window as any).showInputBox = originalInputBox;
                (vscode.window as any).showErrorMessage = originalShowError;
                (vscode.window as any).showWarningMessage = originalShowWarning;
                (vscode.window as any).showInformationMessage = originalShowInformation;
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
            }

            assert.deepStrictEqual(stateAtFailurePrompt, ['failure'],
                '재실행 버튼을 보여 주기 전에 실패 상태로 전환해야 한다');
            assert.strictEqual(modalCalls, 1, '민감 출력 경고 모달을 거치지 않았다');
            assert.ok(!informationMessages.some(message => /이미 실행 중|already running/i.test(message)),
                `재실행이 duplicate guard에 막혔다: ${informationMessages.join(' | ')}`);
            assert.strictEqual(actionStates.get(id)?.state, 'success');
            assert.ok(panelHtml.includes(`rerun success ${secret}`), '성공 재실행의 원본 stdout이 없다');
            assert.strictEqual(panelOptions?.enableScripts, false);
            assert.strictEqual(panelOptions?.retainContextWhenHidden, false);

            const entries = history.getHistory().filter(entry => entry.actionId === id);
            assert.strictEqual(entries.length, 2, '최초 실패와 재실행을 각각 이력에 남겨야 한다');
            assert.ok(entries.some(entry => entry.status === 'failure'));
            assert.ok(entries.some(entry => entry.status === 'success'));
            assert.ok(!entries.some(entry => entry.status === 'running'), 'running 이력이 고착됐다');
            assert.ok(!JSON.stringify(entries).includes(secret), '민감 재실행 원본이 history에 저장됐다');
        });

        test('병렬 AggregateError 안의 민감 실패도 디버그 재실행을 제안한다', async () => {
            const id = 'sensitive-aggregate';
            const secret = 'Aggregate-S3cret';
            const originalInputBox = vscode.window.showInputBox;
            const originalShowError = vscode.window.showErrorMessage;
            const offeredItems: string[] = [];
            (vscode.window as any).showInputBox = () => Promise.resolve(secret);
            (vscode.window as any).showErrorMessage = async (_message: string, ...items: unknown[]) => {
                offeredItems.push(...items.filter((item): item is string => typeof item === 'string'));
                return undefined;
            };

            const actionItem: ActionItem = {
                id,
                title: 'Sensitive aggregate',
                action: {
                    description: 'two password-derived parallel failures',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                        {
                            id: 'failA',
                            type: 'command',
                            command: platformCommand('node'),
                            args: ['-e', "process.stderr.write(process.argv[1]); process.exit(2)", '${ask.value}'],
                            passTheResultToNextTask: true,
                            parallel: true,
                        },
                        {
                            id: 'failB',
                            type: 'command',
                            command: platformCommand('node'),
                            args: ['-e', "process.stderr.write(process.argv[1]); process.exit(3)", '${ask.value}'],
                            passTheResultToNextTask: true,
                            parallel: true,
                        },
                    ],
                },
            };
            let failure: unknown;
            try {
                await extension.executeAction(actionItem, makeContext(), makeMainViewProvider());
            } catch (error) {
                failure = error;
            } finally {
                (vscode.window as any).showInputBox = originalInputBox;
                (vscode.window as any).showErrorMessage = originalShowError;
            }

            assert.ok(failure instanceof AggregateError, '병렬 실패가 AggregateError여야 한다');
            assert.strictEqual(actionStates.get(id)?.state, 'failure');
            assert.ok(offeredItems.some(item => /민감 디버그|sensitive debug/i.test(item)),
                `AggregateError에서 민감 디버그 버튼이 빠졌다: ${offeredItems.join(' | ')}`);
            assert.ok(!offeredItems.join('\n').includes(secret), '디버그 제안 버튼에 비밀이 샜다');
        });

        test('민감 디버그를 요청하지 않으면 원본 출력을 열지 않는다', async () => {
            const secret = 'Another-S3cret';
            const scriptPath = makeFailingScript(secret, 1);
            const originalInputBox = vscode.window.showInputBox;
            const originalOpen = vscode.workspace.openTextDocument;
            let openedContent: string | undefined;
            (vscode.window as any).showInputBox = () => Promise.resolve(secret);
            (vscode.workspace as any).openTextDocument = (options: any) => {
                openedContent = typeof options?.content === 'string' ? options.content : '';
                return (originalOpen as any)({ content: '', language: 'plaintext' });
            };

            try {
                await extension.executeAction(
                    passwordAction('sensitive-noopen', scriptPath),
                    makeContext(),
                    makeMainViewProvider()
                ).catch(() => { /* 실패는 예상된 것이다 */ });
            } finally {
                (vscode.window as any).showInputBox = originalInputBox;
                (vscode.workspace as any).openTextDocument = originalOpen;
            }

            assert.strictEqual(
                openedContent,
                undefined,
                '승인하지 않았는데 원본 출력이 편집기로 열렸다'
            );
        });

        test('민감 디버그 플래그는 한 실행만 쓰고 다음 실행으로 새지 않는다', async () => {
            const secret = 'One-Shot-Only';
            const scriptPath = makeFailingScript(secret, 2);
            const originalInputBox = vscode.window.showInputBox;
            const originalOpen = vscode.workspace.openTextDocument;
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            const opened: string[] = [];
            let untitledCalls = 0;
            (vscode.window as any).showInputBox = () => Promise.resolve(secret);
            (vscode.workspace as any).openTextDocument = (...args: unknown[]) => {
                untitledCalls++;
                return (originalOpen as any)(...args);
            };
            (vscode.window as any).createWebviewPanel = (_viewType: string, _title: string, _column: unknown, options: any) => {
                const webview = { html: '' };
                opened.push(webview.html);
                return {
                    webview: {
                        get html() { return webview.html; },
                        set html(value: string) {
                            webview.html = value;
                            opened[opened.length - 1] = value;
                        },
                    },
                    __options: options,
                } as unknown as vscode.WebviewPanel;
            };

            try {
                // 첫 실행: 민감 디버그를 요청한 상태로 돌린다.
                extension.__testHook_requestSensitiveDebug('sensitive-once');
                await extension.executeAction(
                    passwordAction('sensitive-once', scriptPath),
                    makeContext(),
                    makeMainViewProvider()
                ).catch(() => { /* 실패는 예상된 것이다 */ });

                assert.strictEqual(opened.length, 1, '승인한 실행에서 원본이 열리지 않았다');
                assert.ok(opened[0].includes('boom'), '원본 stderr 가 담기지 않았다');
                assert.strictEqual(untitledCalls, 0, '민감 원본을 dirty untitled 문서로 열었다');

                // 두 번째 실행: 아무 요청도 하지 않았다.
                await extension.executeAction(
                    passwordAction('sensitive-once', scriptPath),
                    makeContext(),
                    makeMainViewProvider()
                ).catch(() => { /* 실패는 예상된 것이다 */ });

                assert.strictEqual(
                    opened.length,
                    1,
                    '플래그가 다음 실행으로 넘어가 원본이 또 열렸다 — 일회성이 아니다'
                );
            } finally {
                (vscode.window as any).showInputBox = originalInputBox;
                (vscode.workspace as any).openTextDocument = originalOpen;
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
            }
        });

        test('민감 디버그의 백그라운드 one-shot은 출력이 의도적으로 폐기됐다고 안내한다', async () => {
            const id = 'sensitive-debug-one-shot';
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            let panelHtml = '';
            (vscode.window as any).createWebviewPanel = () => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) { panelHtml = value; },
                },
            } as unknown as vscode.WebviewPanel);
            extension.__testHook_requestSensitiveDebug(id);

            try {
                await extension.executeAction(
                    {
                        id,
                        title: 'Sensitive debug one-shot',
                        action: {
                            description: 'one-shot output is intentionally unavailable',
                            tasks: [
                                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                                {
                                    id: 'background',
                                    type: 'command',
                                    command: platformCommand('node'),
                                    args: ['-e', 'process.exit(0)', '${ask.value}'],
                                    isOneShot: true,
                                },
                            ],
                        },
                    },
                    makeContext(),
                    makeMainViewProvider(),
                    undefined,
                    { ask: { value: 'One-Shot-Debug-S3cret' } }
                );
            } finally {
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
            }

            assert.match(panelHtml, /intentionally discarded|의도적으로 폐기/i);
            assert.ok(!panelHtml.includes('태스크 유형은 stdout') && !panelHtml.includes('task type does not expose'),
                '폐기 정책을 일반적인 미지원 태스크로 오해시키면 안 된다');
        });

        test('민감 디버그 timeout은 부분 출력과 raw timeout 메시지를 임시 화면에 남긴다', async () => {
            const id = 'sensitive-debug-timeout';
            const secret = 'Timeout-S3cret';
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            const originalShowError = vscode.window.showErrorMessage;
            let panelHtml = '';
            const shownErrors: string[] = [];
            (vscode.window as any).createWebviewPanel = () => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) { panelHtml = value; },
                },
            } as unknown as vscode.WebviewPanel);
            (vscode.window as any).showErrorMessage = async (message: string) => {
                shownErrors.push(message);
                return undefined;
            };

            extension.__testHook_requestSensitiveDebug(id);
            let failure: Error | undefined;
            try {
                await extension.executeAction(
                    {
                        id,
                        title: 'Sensitive timeout',
                        action: {
                            description: 'emit once, then time out',
                            tasks: [
                                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                                {
                                    id: 'deploy',
                                    type: 'command',
                                    command: platformCommand('node'),
                                    args: ['-e', 'process.stdout.write(process.argv[1]); setTimeout(() => {}, 5000)', '${ask.value}'],
                                    passTheResultToNextTask: true,
                                    timeoutSeconds: 0.08,
                                },
                            ],
                        },
                    },
                    makeContext(),
                    makeMainViewProvider(),
                    undefined,
                    { ask: { value: secret } }
                );
            } catch (error) {
                failure = error as Error;
            } finally {
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
                (vscode.window as any).showErrorMessage = originalShowError;
            }

            assert.ok(failure);
            assert.ok(!failure!.message.includes(secret), '기본 실패 객체에는 비밀이 없어야 한다');
            assert.ok(panelHtml.includes(secret), '동의한 화면에 timeout 전 부분 출력이 없다');
            assert.match(panelHtml, /timed out|시간 초과/i);
            assert.ok(!shownErrors.join('\n').includes(secret), '일반 실패 알림에 원본이 샜다');
        });

        test('stdout/stderr 없는 built-in 실패도 raw Error.message를 동의 화면에서 진단할 수 있다', async () => {
            const id = 'sensitive-debug-builtin';
            const secret = 'Missing-Zip-S3cret';
            const missingSource = path.join(tempWorkspace, secret, 'does-not-exist');
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            const originalShowError = vscode.window.showErrorMessage;
            let panelHtml = '';
            const shownErrors: string[] = [];
            (vscode.window as any).createWebviewPanel = () => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) { panelHtml = value; },
                },
            } as unknown as vscode.WebviewPanel);
            (vscode.window as any).showErrorMessage = async (message: string) => {
                shownErrors.push(message);
                return undefined;
            };

            extension.__testHook_requestSensitiveDebug(id);
            let failure: Error | undefined;
            try {
                await extension.executeAction(
                    {
                        id,
                        title: 'Sensitive built-in failure',
                        action: {
                            description: 'built-in zip has no output stream',
                            tasks: [
                                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                                {
                                    id: 'zip',
                                    type: 'zip',
                                    source: path.join(tempWorkspace, '${ask.value}', 'does-not-exist'),
                                    archive: path.join(tempWorkspace, 'missing.zip'),
                                },
                            ],
                        },
                    },
                    makeContext(),
                    makeMainViewProvider(),
                    undefined,
                    { ask: { value: secret } }
                );
            } catch (error) {
                failure = error as Error;
            } finally {
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
                (vscode.window as any).showErrorMessage = originalShowError;
            }

            assert.ok(failure);
            assert.ok(!failure!.message.includes(secret));
            assert.ok(panelHtml.includes(secret),
                `동의한 raw Error.message에 실패 경로가 없다: ${panelHtml.slice(0, 1000)}`);
            assert.match(panelHtml, /raw failure message|원본 실패 메시지/i);
            assert.ok(!shownErrors.join('\n').includes(secret), '일반 실패 알림에 built-in 경로가 샜다');
            assert.ok(!fs.existsSync(path.join(tempWorkspace, 'missing.zip')));
            assert.ok(missingSource.includes(secret), '테스트 전제 확인');
        });

        test('capture-limit 디버그 재실행은 부분 출력과 실패 이유를 반드시 표시한다', async () => {
            const id = 'sensitive-debug-capture-limit';
            const secret = 'Capture-Limit-S3cret';
            const config = vscode.workspace.getConfiguration('taskhub');
            const previousLimit = config.inspect<number>('pipeline.outputCaptureLimitMb')?.globalValue;
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            const originalShowError = vscode.window.showErrorMessage;
            let panelHtml = '';
            (vscode.window as any).createWebviewPanel = () => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) { panelHtml = value; },
                },
            } as unknown as vscode.WebviewPanel);
            (vscode.window as any).showErrorMessage = async () => undefined;
            await config.update('pipeline.outputCaptureLimitMb', 1, vscode.ConfigurationTarget.Global);

            extension.__testHook_requestSensitiveDebug(id);
            let failure: Error | undefined;
            try {
                await extension.executeAction(
                    {
                        id,
                        title: 'Sensitive capture limit',
                        action: {
                            description: 'exceed bounded capture',
                            tasks: [
                                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                                {
                                    id: 'deploy',
                                    type: 'command',
                                    command: platformCommand('node'),
                                    args: [
                                        '-e',
                                        "process.stdout.write(process.argv[1]); for (let i=0;i<24;i++) process.stdout.write('x'.repeat(65536));",
                                        '${ask.value}',
                                    ],
                                    passTheResultToNextTask: true,
                                },
                            ],
                        },
                    },
                    makeContext(),
                    makeMainViewProvider(),
                    undefined,
                    { ask: { value: secret } }
                );
            } catch (error) {
                failure = error as Error;
            } finally {
                await config.update('pipeline.outputCaptureLimitMb', previousLimit, vscode.ConfigurationTarget.Global);
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
                (vscode.window as any).showErrorMessage = originalShowError;
            }

            assert.ok(failure);
            assert.match(failure!.message, /output limit|출력 한도/i);
            assert.ok(!failure!.message.includes(secret));
            assert.ok(panelHtml.includes(secret), '한도 전까지 받은 원본 출력이 없다');
            assert.match(panelHtml, /capture limit|output limit|출력 한도/i);
        });

        test('민감 디버그 webview 원문은 실행 capture 설정과 무관하게 총 4MiB로 제한한다', async () => {
            const id = 'sensitive-debug-display-cap';
            const config = vscode.workspace.getConfiguration('taskhub');
            const previousCaptureLimit = config.inspect<number>('pipeline.outputCaptureLimitMb')?.globalValue;
            const previousTotalLimit = config.inspect<number>('pipeline.totalOutputLimitMb')?.globalValue;
            const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            let panelHtml = '';
            (vscode.window as any).createWebviewPanel = () => ({
                webview: {
                    get html() { return panelHtml; },
                    set html(value: string) { panelHtml = value; },
                },
            } as unknown as vscode.WebviewPanel);
            await config.update('pipeline.outputCaptureLimitMb', 10, vscode.ConfigurationTarget.Global);
            await config.update('pipeline.totalOutputLimitMb', 10, vscode.ConfigurationTarget.Global);

            extension.__testHook_requestSensitiveDebug(id);
            try {
                await extension.executeAction(
                    {
                        id,
                        title: 'Sensitive display cap',
                        action: {
                            description: 'large successful debug output',
                            tasks: [
                                { id: 'ask', type: 'inputBox', prompt: 'password?', password: true },
                                {
                                    id: 'deploy',
                                    type: 'command',
                                    command: platformCommand('node'),
                                    args: ['-e', "process.stdout.write('x'.repeat(5 * 1024 * 1024));", '${ask.value}'],
                                    passTheResultToNextTask: true,
                                },
                            ],
                        },
                    },
                    makeContext(),
                    makeMainViewProvider(),
                    undefined,
                    { ask: { value: 'Display-Cap-S3cret' } }
                );
            } finally {
                await config.update('pipeline.outputCaptureLimitMb', previousCaptureLimit, vscode.ConfigurationTarget.Global);
                await config.update('pipeline.totalOutputLimitMb', previousTotalLimit, vscode.ConfigurationTarget.Global);
                (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
            }

            assert.match(panelHtml, /omitted|생략/i, '4MiB 이후 생략 안내가 없다');
            assert.ok(panelHtml.length < 4 * 1024 * 1024 + 32 * 1024,
                `escape 전 원문을 통째로 복제했다: ${panelHtml.length} characters`);
        });
    });
});


/**
 * `shell` 과 `command` 의 계약 분리 (0.6.47).
 *
 * 이름은 "Shell Command" 인데 실제로는 argv 로 실행되어, `&&`·`|`·`>`·`$VAR`
 * 가 모두 리터럴이 됐다. 사용자가 터미널에서 쓰던 것을 붙여넣으면 **조용히**
 * 다르게 동작했다 — 오류도 없이 그냥 안 했다.
 *
 * 이제 `shell` 은 문자열을 셸에 그대로 넘기고, `command` 는 기존의 argv
 * 실행을 유지한다. 두 타입을 **함께** 봐야 한다 — 한쪽만 보면 둘 다 같은
 * 동작으로 바뀌는 회귀를 놓친다.
 */
suite('shell / command 실행 계약 (0.6.47)', function () {
    this.timeout(30000);

    let extension: typeof import('../extension');
    let workspace: string;

    suiteSetup(() => { extension = require('../extension') as typeof import('../extension'); });
    setup(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-shell-contract-')); });
    teardown(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ } });

    function makeCtx(): vscode.ExtensionContext {
        return {
            extensionPath: workspace, subscriptions: [],
            workspaceState: { get: (_k: string, d?: any) => d, update: async () => { }, keys: () => [], setKeysForSync: () => { } },
            globalState: { get: (_k: string, d?: any) => d, update: async () => { }, keys: () => [], setKeysForSync: () => { } },
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-shell-contract-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    /** 캡처 모드로 한 태스크를 돌리고 stdout 을 돌려준다. */
    async function runOne(type: 'shell' | 'command', command: string): Promise<string> {
        let captured = '';
        const item = {
            id: `contract-${type}-${Date.now()}`,
            title: 'Contract',
            action: {
                description: 'contract probe',
                tasks: [{ id: 'probe', type, command, cwd: workspace, passTheResultToNextTask: true,
                    output: { capture: [{ name: 'all', pattern: '([\\s\\S]*)' }] } }],
            },
        } as unknown as any;
        // 결과는 history 대신 파일로 받는다 — 셸 리다이렉션이 동작하는지가
        // 이 테스트의 핵심이라, 파일이 곧 증거다.
        await extension.executeAction(item, makeCtx(), { refresh: () => { } } as any)
            .catch(() => { /* 실패 여부는 아래 파일로 판정한다 */ });
        const out = path.join(workspace, 'out.txt');
        if (fs.existsSync(out)) { captured = fs.readFileSync(out, 'utf8'); }
        return captured;
    }

    test('shell 은 리다이렉션을 셸 연산자로 처리한다', async () => {
        await runOne('shell', 'echo redirected > out.txt');
        const out = path.join(workspace, 'out.txt');
        assert.ok(fs.existsSync(out), 'shell 타입인데 리다이렉션이 일어나지 않았다');
        assert.match(fs.readFileSync(out, 'utf8'), /redirected/);
    });

    test('command 는 리다이렉션을 리터럴 인자로 넘긴다', async () => {
        await runOne('command', 'echo redirected > out.txt');
        assert.ok(
            !fs.existsSync(path.join(workspace, 'out.txt')),
            'command 타입이 셸 리다이렉션을 수행했다 — argv 계약이 깨졌다'
        );
    });

    test('shell 은 && 로 이은 두 명령을 모두 실행한다', async function () {
        if (process.platform === 'win32') { this.skip(); }
        await runOne('shell', 'echo first > out.txt && echo second >> out.txt');
        const body = fs.readFileSync(path.join(workspace, 'out.txt'), 'utf8');
        assert.match(body, /first/);
        assert.match(body, /second/, '&& 뒤의 명령이 실행되지 않았다');
    });
});
