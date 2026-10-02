import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    BrowserTaskDeps,
    BrowserTaskRequest,
    openBrowserTask,
} from '../browserTask';
import { filePathIdentityKey } from '../pathIdentity';
import { buildBuiltinVariableContext } from '../builtinVariables';
import { executeAction, executeActionPipeline, MainViewProvider, stopRunningAction } from '../extension';
import { actionStates } from '../providers/actionStatus';
import { Action as PipelineAction, ActionItem } from '../schema';
import { ActionRunLogCollector } from '../runLogStore';

interface CapturedCommand {
    command: string;
    args: unknown[];
}

interface FakeBrowserDeps {
    deps: BrowserTaskDeps;
    commands: CapturedCommand[];
    externalUris: vscode.Uri[];
    externalUriInputs: vscode.Uri[];
    getCommandsArgs: Array<boolean | undefined>;
}

function assertSameFilePath(actual: string | undefined, expected: string): void {
    assert.ok(actual, '로컬 파일 결과에는 path가 있어야 한다');
    assert.strictEqual(filePathIdentityKey(actual), filePathIdentityKey(expected));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

function makeFakeDeps(options?: {
    availableCommands?: string[];
    externalOpened?: boolean;
    remoteName?: string;
    externalUri?: vscode.Uri;
}): FakeBrowserDeps {
    const commands: CapturedCommand[] = [];
    const externalUris: vscode.Uri[] = [];
    const externalUriInputs: vscode.Uri[] = [];
    const getCommandsArgs: Array<boolean | undefined> = [];
    return {
        deps: {
            getCommands: filterInternal => {
                getCommandsArgs.push(filterInternal);
                return Promise.resolve(options?.availableCommands ?? []);
            },
            executeCommand: <T = unknown>(command: string, ...args: unknown[]) => {
                commands.push({ command, args });
                return Promise.resolve(undefined as T);
            },
            openExternal: uri => {
                externalUris.push(uri);
                return Promise.resolve(options?.externalOpened ?? true);
            },
            asExternalUri: uri => {
                externalUriInputs.push(uri);
                return Promise.resolve(options?.externalUri ?? uri);
            },
            remoteName: () => options?.remoteName,
        },
        commands,
        externalUris,
        externalUriInputs,
        getCommandsArgs,
    };
}

suite('browserTask', () => {
    let workspaceRoot: string;
    let reportPath: string;

    setup(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-browser-task-'));
        const buildDir = path.join(workspaceRoot, 'build');
        fs.mkdirSync(buildDir);
        reportPath = path.join(buildDir, 'report page-한글.html');
        fs.writeFileSync(reportPath, '<!doctype html><title>report</title>');
    });

    teardown(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    function localRequest(overrides?: Partial<BrowserTaskRequest>): BrowserTaskRequest {
        return {
            url: 'build/report page-한글.html',
            baseDir: workspaceRoot,
            ...overrides,
        };
    }

    test('relative local path uses an encoded URI in the Integrated Browser command and result', async () => {
        const fake = makeFakeDeps({
            availableCommands: ['workbench.action.browser.open'],
        });

        const result = await openBrowserTask(localRequest(), fake.deps);

        assert.deepStrictEqual(fake.getCommandsArgs, [true]);
        assert.strictEqual(fake.commands.length, 1);
        assert.strictEqual(fake.commands[0].command, 'workbench.action.browser.open');
        const commandUrl = String(fake.commands[0].args[0]);
        assert.match(commandUrl, /\/build\/report%20page-%ED%95%9C%EA%B8%80\.html$/);
        assert.ok(!commandUrl.includes(' '));
        assert.ok(!commandUrl.includes('한글'));
        assert.deepStrictEqual(fake.externalUris, []);
        assert.deepStrictEqual(fake.externalUriInputs, []);
        assertSameFilePath(result.path, reportPath);
        assert.strictEqual(result.url, commandUrl);
    });

    test('absolute local path and file URL resolve to the same workspace file', async () => {
        for (const url of [reportPath, vscode.Uri.file(reportPath).toString()]) {
            const fake = makeFakeDeps({
                availableCommands: ['workbench.action.browser.open'],
            });
            const result = await openBrowserTask(localRequest({ url }), fake.deps);
            assertSameFilePath(result.path, reportPath);
            assert.strictEqual(result.url, vscode.Uri.file(reportPath).toString());
        }
    });

    test('file URL keeps encoded path and raw query semantics after local-file validation', async () => {
        const baseUrl = vscode.Uri.file(reportPath).toString();
        const integratedSource = `${baseUrl}`
            + '?mode=summary&label=a%26b#details';
        const integratedSuffix = '/build/report%20page-%ED%95%9C%EA%B8%80.html'
            + '?mode=summary&label=a%26b#details';
        const integratedFake = makeFakeDeps({
            availableCommands: ['workbench.action.browser.open'],
        });

        const integratedResult = await openBrowserTask(
            localRequest({ url: integratedSource }),
            integratedFake.deps,
        );

        assert.ok(integratedResult.url.endsWith(integratedSuffix));
        assert.ok(!integratedResult.url.includes('mode%3Dsummary'));
        assert.ok(!integratedResult.url.includes('label=a&b'));
        assertSameFilePath(integratedResult.path, reportPath);
        assert.deepStrictEqual(integratedFake.commands, [{
            command: 'workbench.action.browser.open',
            args: [integratedResult.url],
        }]);

        const defaultSource = `${baseUrl}?mode=summary&view=compact#details`;
        const defaultFake = makeFakeDeps();
        const defaultResult = await openBrowserTask(
            localRequest({ url: defaultSource, target: 'default' }),
            defaultFake.deps,
        );

        assert.match(defaultResult.url, /\?mode=summary&view=compact#details$/);
        assert.ok(!defaultResult.url.includes('mode%3Dsummary'));
        assertSameFilePath(defaultResult.path, reportPath);
        assert.strictEqual(defaultFake.externalUris.length, 1);
        assert.strictEqual(defaultFake.externalUris[0].query, 'mode=summary&view=compact');
        assert.strictEqual(defaultFake.externalUris[0].fragment, 'details');
    });

    test('Integrated Browser command takes priority over Simple Browser for HTTP', async () => {
        const fake = makeFakeDeps({
            availableCommands: ['simpleBrowser.show', 'workbench.action.browser.open'],
        });

        const source = 'https://example.com/search?q=a%26b&r=x%3Dy#summary';
        const result = await openBrowserTask(localRequest({ url: source }), fake.deps);

        assert.deepStrictEqual(fake.commands, [{
            command: 'workbench.action.browser.open',
            args: [source],
        }]);
        assert.deepStrictEqual(result, { url: source });
    });

    test('HTTP uses Simple Browser only when the Integrated Browser command is unavailable', async () => {
        const fake = makeFakeDeps({ availableCommands: ['simpleBrowser.show'] });

        await openBrowserTask(localRequest({ url: 'http://127.0.0.1:8080/' }), fake.deps);

        assert.deepStrictEqual(fake.commands, [{
            command: 'simpleBrowser.show',
            args: ['http://127.0.0.1:8080/'],
        }]);
        assert.deepStrictEqual(fake.externalUris, []);
    });

    test('remote HTTP is converted with asExternalUri before opening it internally', async () => {
        const source = 'http://localhost:3000/report?mode=summary&view=compact#section';
        const forwardedUrl = 'https://forwarded.example.test/tunnel?token=abc&port=3000#view';
        const forwarded = vscode.Uri.parse(forwardedUrl);
        const fake = makeFakeDeps({
            availableCommands: ['workbench.action.browser.open'],
            remoteName: 'ssh-remote',
            externalUri: forwarded,
        });

        const result = await openBrowserTask(localRequest({ url: source }), fake.deps);

        assert.strictEqual(fake.externalUriInputs.length, 1);
        assert.strictEqual(fake.externalUriInputs[0].toString(true), source);
        assert.deepStrictEqual(fake.commands, [{
            command: 'workbench.action.browser.open',
            args: [forwardedUrl],
        }]);
        assert.deepStrictEqual(result, { url: forwardedUrl });
        assert.ok(!result.url.includes('token%3Dabc'));
    });

    test('default target delegates directly to openExternal without command discovery', async () => {
        const fake = makeFakeDeps({
            availableCommands: ['workbench.action.browser.open'],
            remoteName: 'ssh-remote',
            externalUri: vscode.Uri.parse('https://must-not-be-used.example.test/'),
        });
        const source = 'https://example.com/report';

        const result = await openBrowserTask(localRequest({
            url: source,
            target: 'default',
        }), fake.deps);

        assert.deepStrictEqual(fake.getCommandsArgs, []);
        assert.deepStrictEqual(fake.commands, []);
        assert.deepStrictEqual(fake.externalUriInputs, []);
        assert.strictEqual(fake.externalUris.length, 1);
        assert.strictEqual(fake.externalUris[0].toString(), source);
        assert.deepStrictEqual(result, { url: source });
    });

    test('default target returns a local path result after opening a file URI', async () => {
        const fake = makeFakeDeps();

        const result = await openBrowserTask(localRequest({ target: 'default' }), fake.deps);

        assertSameFilePath(fake.externalUris[0].fsPath, reportPath);
        assert.deepStrictEqual(Object.keys(result).sort(), ['path', 'url']);
        assert.strictEqual(result.url, vscode.Uri.file(reportPath).toString());
        assertSameFilePath(result.path, reportPath);
    });

    test('Remote environments reject existing and missing local files before any browser call', async () => {
        for (const target of ['integrated', 'default'] as const) {
            for (const url of [
                'build/report page-한글.html',
                vscode.Uri.file(reportPath).toString(),
                'build/missing.html',
            ]) {
                const fake = makeFakeDeps({
                    availableCommands: ['workbench.action.browser.open'],
                    remoteName: 'ssh-remote',
                });
                await assert.rejects(
                    openBrowserTask(localRequest({ url, target }), fake.deps),
                    /Remote environment.*Serve the file over HTTP/i,
                );
                assert.deepStrictEqual(fake.getCommandsArgs, []);
                assert.deepStrictEqual(fake.commands, []);
                assert.deepStrictEqual(fake.externalUris, []);
                assert.deepStrictEqual(fake.externalUriInputs, []);
            }
        }
    });

    test('file URLs with a network authority are rejected instead of becoming a local path', async () => {
        const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });

        await assert.rejects(
            openBrowserTask(localRequest({
                url: 'file://server/share/definitely-missing.html',
            }), fake.deps),
            /network authority.*not supported/i,
        );
        assert.deepStrictEqual(fake.getCommandsArgs, []);
        assert.deepStrictEqual(fake.commands, []);
        assert.deepStrictEqual(fake.externalUris, []);
        assert.deepStrictEqual(fake.externalUriInputs, []);
    });

    test('integrated local file never falls back to Simple Browser or the default browser', async () => {
        const fake = makeFakeDeps({ availableCommands: ['simpleBrowser.show'] });

        await assert.rejects(
            openBrowserTask(localRequest(), fake.deps),
            /cannot open local files in the integrated browser/i,
        );
        assert.deepStrictEqual(fake.commands, []);
        assert.deepStrictEqual(fake.externalUris, []);
    });

    test('integrated HTTP never falls back to the default browser when no internal browser exists', async () => {
        const fake = makeFakeDeps();

        await assert.rejects(
            openBrowserTask(localRequest({ url: 'https://example.com/' }), fake.deps),
            /No VS Code integrated browser is available/i,
        );
        assert.deepStrictEqual(fake.commands, []);
        assert.deepStrictEqual(fake.externalUris, []);
    });

    test('rejects unsupported schemes and malformed HTTP URLs before invoking VS Code', async () => {
        for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'https://']) {
            const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
            await assert.rejects(openBrowserTask(localRequest({ url }), fake.deps));
            assert.deepStrictEqual(fake.getCommandsArgs, []);
            assert.deepStrictEqual(fake.commands, []);
            assert.deepStrictEqual(fake.externalUris, []);
        }
    });

    test('rejects empty URLs and invalid targets before invoking VS Code', async () => {
        const emptyFake = makeFakeDeps();
        await assert.rejects(
            openBrowserTask(localRequest({ url: '' }), emptyFake.deps),
            /requires a url/i,
        );

        const invalidFake = makeFakeDeps();
        await assert.rejects(
            openBrowserTask({
                ...localRequest(),
                target: 'other' as 'integrated',
            }, invalidFake.deps),
            /Unsupported browser target/i,
        );
        assert.deepStrictEqual(invalidFake.getCommandsArgs, []);
    });

    test('allows absolute paths outside the workspace for fileDialog and temporary-file results', async () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-browser-outside-'));
        const outsidePath = path.join(outsideDir, 'outside.html');
        fs.writeFileSync(outsidePath, '<title>outside</title>');
        try {
            const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
            const absoluteResult = await openBrowserTask(localRequest({ url: outsidePath }), fake.deps);
            assertSameFilePath(absoluteResult.path, outsidePath);

            const fileUriFake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
            const fileUriResult = await openBrowserTask(
                localRequest({ url: vscode.Uri.file(outsidePath).toString() }),
                fileUriFake.deps,
            );
            assertSameFilePath(fileUriResult.path, outsidePath);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    test('rejects relative paths without a base folder, missing files, and directories', async () => {
        const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
        await assert.rejects(
            openBrowserTask(localRequest({ baseDir: undefined }), fake.deps),
            /has no base folder.*absolute cwd/i,
        );
        await assert.rejects(
            openBrowserTask(localRequest({ url: 'missing.html' }), fake.deps),
            /file not found/i,
        );
        await assert.rejects(
            openBrowserTask(localRequest({ url: 'build' }), fake.deps),
            /only regular files/i,
        );
        assert.deepStrictEqual(fake.getCommandsArgs, []);
    });

    test('rejects null bytes in local paths before accessing the file system', async () => {
        const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
        await assert.rejects(
            openBrowserTask(localRequest({ url: 'build/report.html\x00ignored' }), fake.deps),
            /null byte/i,
        );
        assert.deepStrictEqual(fake.getCommandsArgs, []);
    });

    test('throws when openExternal reports that the default browser did not open', async () => {
        const fake = makeFakeDeps({ externalOpened: false });
        const source = `${vscode.Uri.file(reportPath).toString()}?mode=summary#details`;

        await assert.rejects(
            openBrowserTask(localRequest({
                url: source,
                target: 'default',
            }), fake.deps),
            error => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Could not open the URL in the default browser/i);
                assert.match(
                    error.message,
                    /report%20page-%ED%95%9C%EA%B8%80\.html\?mode=summary#details$/,
                );
                assert.ok(!error.message.includes('mode%3Dsummary'));
                return true;
            },
        );
        assert.strictEqual(fake.externalUris.length, 1);
    });

    test('an inactive request stops before browser preparation or external opening', async () => {
        for (const target of ['integrated', 'default'] as const) {
            const fake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
            const stopped = new Error('inactive browser task');
            await assert.rejects(openBrowserTask(localRequest({
                target,
                assertActive: () => { throw stopped; },
            }), fake.deps), error => error === stopped);
            assert.deepStrictEqual(fake.getCommandsArgs, []);
            assert.deepStrictEqual(fake.commands, []);
            assert.deepStrictEqual(fake.externalUris, []);
            assert.deepStrictEqual(fake.externalUriInputs, []);
        }
    });

    test('the default target rechecks the owning task immediately before openExternal', async () => {
        const fake = makeFakeDeps();
        let active = true;
        fake.deps.remoteName = () => { active = false; return undefined; };
        await assert.rejects(openBrowserTask(localRequest({
            target: 'default',
            assertActive: () => { if (!active) { throw new Error('inactive browser task'); } },
        }), fake.deps), /inactive browser task/);
        assert.deepStrictEqual(fake.externalUris, []);
    });

    for (const command of ['workbench.action.browser.open', 'simpleBrowser.show']) {
        test(`cancelled command discovery cannot dispatch ${command}`, async () => {
            const fake = makeFakeDeps();
            const discovery = deferred<string[]>();
            fake.deps.getCommands = () => discovery.promise;
            let active = true;
            const opening = openBrowserTask(localRequest({
                url: 'https://example.com/report',
                assertActive: () => { if (!active) { throw new Error('inactive browser task'); } },
            }), fake.deps);
            active = false;
            discovery.resolve([command]);
            await assert.rejects(opening, /inactive browser task/);
            assert.deepStrictEqual(fake.commands, []);
            assert.deepStrictEqual(fake.externalUris, []);
        });
    }

    test('cancelled Remote URI conversion cannot discover commands or open the forwarded URL', async () => {
        const fake = makeFakeDeps({ remoteName: 'ssh-remote' });
        const forwarding = deferred<vscode.Uri>();
        fake.deps.asExternalUri = () => forwarding.promise;
        let active = true;
        const opening = openBrowserTask(localRequest({
            url: 'http://localhost:3000/report',
            assertActive: () => { if (!active) { throw new Error('inactive browser task'); } },
        }), fake.deps);
        active = false;
        forwarding.resolve(vscode.Uri.parse('https://forwarded.example.test/'));
        await assert.rejects(opening, /inactive browser task/);
        assert.deepStrictEqual(fake.getCommandsArgs, []);
        assert.deepStrictEqual(fake.commands, []);
        assert.deepStrictEqual(fake.externalUris, []);
    });

    test('an already dispatched external open may complete after its owning task becomes inactive', async () => {
        const fake = makeFakeDeps();
        const dispatched = deferred<boolean>();
        fake.deps.openExternal = uri => { fake.externalUris.push(uri); return dispatched.promise; };
        let active = true;
        const opening = openBrowserTask(localRequest({
            url: 'https://example.com/report', target: 'default',
            assertActive: () => { if (!active) { throw new Error('inactive browser task'); } },
        }), fake.deps);
        assert.strictEqual(fake.externalUris.length, 1);
        active = false;
        dispatched.resolve(true);
        assert.deepStrictEqual(await opening, { url: 'https://example.com/report' });
    });
});

suite('browser task execution lifecycle', function () {
    this.timeout(8000);
    let workspaceRoot: string;
    let context: vscode.ExtensionContext;

    setup(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-browser-lifecycle-'));
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
        context.subscriptions.forEach(subscription => subscription.dispose());
        fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    function pauseBrowserPreparation(phase: 'commands' | 'forwarding', availableCommand: string) {
        const originalCommands = vscode.commands.getCommands;
        const originalExecute = vscode.commands.executeCommand;
        const originalExternal = vscode.env.openExternal;
        const originalForwarding = vscode.env.asExternalUri;
        const originalRemote = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
        const entered = deferred<void>();
        const commandGate = deferred<string[]>();
        const forwardingGate = deferred<vscode.Uri>();
        const opened: string[] = [];
        let discoveries = 0;
        Object.defineProperty(vscode.env, 'remoteName', {
            configurable: true, value: phase === 'forwarding' ? 'ssh-remote' : undefined,
        });
        vscode.commands.getCommands = () => {
            discoveries++;
            if (phase === 'commands') { entered.resolve(); return commandGate.promise; }
            return Promise.resolve([availableCommand]);
        };
        vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
            if (command === 'workbench.action.browser.open' || command === 'simpleBrowser.show') {
                opened.push(command);
                return undefined;
            }
            return originalExecute(command, ...args);
        }) as typeof originalExecute;
        vscode.env.openExternal = async () => { opened.push('external'); return true; };
        vscode.env.asExternalUri = uri => {
            if (phase === 'forwarding') { entered.resolve(); return forwardingGate.promise; }
            return Promise.resolve(uri);
        };
        const release = () => {
            commandGate.resolve([availableCommand]);
            forwardingGate.resolve(vscode.Uri.parse('https://forwarded.example.test/report'));
        };
        return {
            entered: entered.promise, opened, discoveries: () => discoveries, release,
            restore: () => {
                vscode.commands.getCommands = originalCommands;
                vscode.commands.executeCommand = originalExecute;
                vscode.env.openExternal = originalExternal;
                vscode.env.asExternalUri = originalForwarding;
                if (originalRemote) { Object.defineProperty(vscode.env, 'remoteName', originalRemote); }
                else { delete (vscode.env as { remoteName?: string }).remoteName; }
            },
        };
    }

    for (const [phase, command] of [
        ['commands', 'workbench.action.browser.open'],
        ['commands', 'simpleBrowser.show'],
        ['forwarding', 'workbench.action.browser.open'],
    ] as const) {
        test(`a timed-out pipeline browser cannot open after delayed ${phase} (${command})`, async () => {
            const gate = pauseBrowserPreparation(phase, command);
            const marker = path.join(workspaceRoot, 'after-timeout.txt');
            const action: PipelineAction = { description: '', tasks: [
                { id: 'browser', type: 'browser', url: 'http://localhost:3000/report',
                    timeoutSeconds: 0.05, continueOnError: true },
                { id: 'after', type: 'writeFile', path: marker, content: 'continued' },
            ] };
            const collector = new ActionRunLogCollector('browser-timeout', 'browser-timeout', Date.now(), action.tasks);
            const execution = executeActionPipeline(action, context, 'browser-timeout', workspaceRoot, [workspaceRoot], {
                builtinVariables: buildBuiltinVariableContext({ workspaceFolder: workspaceRoot,
                    extensionPath: context.extensionPath, environment: {}, strict: true }),
                runLogCollector: collector,
            });
            // Observe rejection immediately too, so a failed setup cannot create an
            // unhandled rejection while the test waits for the preparation gate.
            void execution.catch(() => {});
            try {
                await gate.entered;
                await execution;
                assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'continued');
                assert.strictEqual(collector.finish('success', Date.now()).tasks[0].status, 'continued');
                gate.release();
                // All continuations released above run before this event-loop fence.
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.deepStrictEqual(gate.opened, []);
                if (phase === 'forwarding') { assert.strictEqual(gate.discoveries(), 0); }
            } finally {
                gate.release();
                await execution.catch(() => {});
                await new Promise<void>(resolve => setImmediate(resolve));
                gate.restore();
            }
        });
    }

    for (const phase of ['commands', 'forwarding'] as const) {
        test(`Stop prevents a delayed ${phase} response from opening the browser or running the next task`, async () => {
            const gate = pauseBrowserPreparation(phase, 'workbench.action.browser.open');
            const marker = path.join(workspaceRoot, 'after-stop.txt');
            const id = `browser-stop-${phase}`;
            const item: ActionItem = { id, title: id, action: { description: '', tasks: [
                { id: 'browser', type: 'browser', url: 'http://localhost:3000/report' },
                { id: 'after', type: 'writeFile', path: marker, content: 'must not run' },
            ] } };
            const mainView = new MainViewProvider(context, () => [item]);
            const execution = executeAction(item, context, mainView);
            void execution.catch(() => {});
            try {
                await gate.entered;
                assert.strictEqual(stopRunningAction(id), true);
                gate.release();
                await execution;
                assert.deepStrictEqual(gate.opened, []);
                assert.strictEqual(fs.existsSync(marker), false);
                if (phase === 'forwarding') { assert.strictEqual(gate.discoveries(), 0); }
            } finally {
                stopRunningAction(id);
                gate.release();
                await execution.catch(() => {});
                gate.restore();
            }
        });
    }
});
