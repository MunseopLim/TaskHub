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
        assert.strictEqual(result.path, reportPath);
        assert.strictEqual(result.url, commandUrl);
    });

    test('absolute local path and file URL resolve to the same workspace file', async () => {
        for (const url of [reportPath, vscode.Uri.file(reportPath).toString()]) {
            const fake = makeFakeDeps({
                availableCommands: ['workbench.action.browser.open'],
            });
            const result = await openBrowserTask(localRequest({ url }), fake.deps);
            assert.strictEqual(result.path, reportPath);
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
        assert.strictEqual(integratedResult.path, reportPath);
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
        assert.strictEqual(defaultResult.path, reportPath);
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

        assert.strictEqual(fake.externalUris[0].fsPath, reportPath);
        assert.deepStrictEqual(result, {
            url: vscode.Uri.file(reportPath).toString(),
            path: reportPath,
        });
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
            assert.strictEqual(absoluteResult.path, outsidePath);

            const fileUriFake = makeFakeDeps({ availableCommands: ['workbench.action.browser.open'] });
            const fileUriResult = await openBrowserTask(
                localRequest({ url: vscode.Uri.file(outsidePath).toString() }),
                fileUriFake.deps,
            );
            assert.strictEqual(fileUriResult.path, outsidePath);
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
});
