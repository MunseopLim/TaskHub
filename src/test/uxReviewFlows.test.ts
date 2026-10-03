import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { addLinkEntry, invalidateActionsCache, promptWorkspaceLinkEdit, runActionWithInputProfile, findActionJsonPointer, openActionDefinition, showActionFailureNotification, showActionRunReport } from '../extension';
import { InputProfileStore } from '../inputProfiles';
import { t } from '../i18n';
import { HistoryItem, HistoryProvider } from '../providers/historyProvider';
import { Link, LinkEntry, LinkViewProvider, readLinksFromDisk } from '../providers/linkViewProvider';
import { Action, MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem } from '../schema';

suite('UX review flows', function () {
    this.timeout(15000);
    const original = {
        input: vscode.window.showInputBox,
        pick: vscode.window.showQuickPick,
        warning: vscode.window.showWarningMessage,
        information: vscode.window.showInformationMessage,
        error: vscode.window.showErrorMessage,
    };
    let messages: string[];
    let warnings: string[];
    let errors: string[];

    setup(() => {
        messages = [];
        warnings = [];
        errors = [];
        vscode.window.showInformationMessage = (async (message: string) => { messages.push(message); }) as unknown as typeof original.information;
        vscode.window.showWarningMessage = (async (message: string) => { warnings.push(message); }) as typeof original.warning;
        vscode.window.showErrorMessage = (async (message: string) => { errors.push(message); }) as typeof original.error;
    });
    teardown(() => {
        vscode.window.showInputBox = original.input;
        vscode.window.showQuickPick = original.pick;
        vscode.window.showWarningMessage = original.warning;
        vscode.window.showInformationMessage = original.information;
        vscode.window.showErrorMessage = original.error;
    });

    suite('link edit identity', () => {
        let directory: string;
        let file: string;
        let provider: LinkViewProvider;
        setup(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-link-edit-'));
            file = path.join(directory, 'links.json');
            provider = {
                getAllEntries: () => {
                    const loaded = readLinksFromDisk(file);
                    assert.ok(loaded.ok);
                    return loaded.entries;
                },
                refresh: () => undefined,
            } as unknown as LinkViewProvider;
        });
        teardown(async () => {
            await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        });
        async function edit(entries: LinkEntry[], index: number, answers: string[], duringEdit?: () => void): Promise<any[]> {
            fs.writeFileSync(file, JSON.stringify(entries));
            const loaded = readLinksFromDisk(file);
            assert.ok(loaded.ok);
            let at = 0;
            vscode.window.showInputBox = (async () => {
                if (at === 0) { duringEdit?.(); }
                return answers[at++];
            }) as typeof original.input;
            await promptWorkspaceLinkEdit(provider, new Link(loaded.entries[index]));
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        const base = { title: 'Docs', link: 'https://example.com' };
        for (const metadata of [{ group: 'Firmware' }, { tags: ['manual'] }, { group: 'Firmware', tags: ['manual'] }]) {
            test(`adding rejects a title/URL duplicate regardless of metadata: ${JSON.stringify(metadata)}`, () => {
                const first = { ...base, ...metadata };
                const entries = [first];
                const added = addLinkEntry(entries, base);
                assert.strictEqual(added.added, false);
                assert.strictEqual(added.entries, entries);
                assert.deepStrictEqual(entries, [first]);
            });
            test(`the add command preserves an existing grouped/tagged link: ${JSON.stringify(metadata)}`, async () => {
                const extension = vscode.extensions.getExtension('Munseop.taskhub');
                assert.ok(extension);
                await extension.activate();
                const folders = vscode.workspace.workspaceFolders;
                assert.strictEqual(folders?.length, 1, 'test workspace must have one folder');
                const linksPath = path.join(folders![0].uri.fsPath, '.vscode', 'links.json');
                const directoryExisted = fs.existsSync(path.dirname(linksPath));
                const previous = fs.existsSync(linksPath) ? fs.readFileSync(linksPath) : undefined;
                const originalCreate = vscode.window.createInputBox;
                const originalClipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
                assert.ok(originalClipboard);
                const accept = new vscode.EventEmitter<void>();
                const noopEvent = () => new vscode.Disposable(() => {});
                const box = {
                    value: '',
                    onDidChangeValue: noopEvent,
                    onDidAccept: accept.event,
                    onDidHide: noopEvent,
                    show() { this.value = base.title; accept.fire(); },
                    dispose() { accept.dispose(); },
                };
                try {
                    fs.mkdirSync(path.dirname(linksPath), { recursive: true });
                    const originalText = JSON.stringify([{ ...base, ...metadata, extra: { preserved: true } }], null, 4) + '\n';
                    fs.writeFileSync(linksPath, originalText);
                    Object.defineProperty(vscode.env, 'clipboard', {
                        configurable: true, value: { readText: async () => '' },
                    });
                    vscode.window.showInputBox = (async () => base.link) as typeof original.input;
                    vscode.window.createInputBox = () => box as unknown as vscode.InputBox;
                    await vscode.commands.executeCommand('taskhub.addLink');
                    assert.strictEqual(fs.readFileSync(linksPath, 'utf8'), originalText,
                        'duplicate add must preserve file bytes, metadata, and unknown fields');
                    assert.ok(messages.includes(t('이 링크는 links.json에 이미 존재합니다.', 'This link already exists in links.json.')));
                    assert.deepStrictEqual(errors, []);
                } finally {
                    vscode.window.createInputBox = originalCreate;
                    Object.defineProperty(vscode.env, 'clipboard', originalClipboard);
                    accept.dispose();
                    if (previous !== undefined) { fs.writeFileSync(linksPath, previous); }
                    else { fs.rmSync(linksPath, { force: true }); }
                    if (!directoryExisted) { fs.rmdirSync(path.dirname(linksPath)); }
                }
            });
        }
        test('adding the same complete identity again keeps the original rows', () => {
            const entry = { ...base, group: 'Firmware', tags: ['manual'] };
            const entries = [entry];
            const duplicate = addLinkEntry(entries, { ...entry, title: '  Docs  ', link: '  https://example.com  ' });
            assert.strictEqual(duplicate.added, false);
            assert.strictEqual(duplicate.entries, entries);
            assert.deepStrictEqual(entries, [entry]);
        });
        test('adding treats omitted and empty tags as the same identity', () => {
            const entries = [base];
            assert.strictEqual(addLinkEntry(entries, { ...base, tags: [] }).added, false);
        });
        test('editing the second group keeps the first row and unknown fields intact', async () => {
            const first = { ...base, group: 'Firmware', extra: { keep: true } };
            const second = { ...base, group: 'Bootloader', extra: 42 };
            const saved = await edit([first, second], 1, ['Bootloader Docs', base.link, 'Bootloader', 'manual']);
            assert.deepStrictEqual(saved, [first, { ...second, title: 'Bootloader Docs', tags: ['manual'] }]);
        });
        test('same title and URL can retain separate tags when editing metadata', async () => {
            const first = { ...base, tags: ['firmware'] };
            const second = { ...base, tags: ['bootloader'] };
            const saved = await edit([first, second], 1, [base.title, base.link, '', 'bootloader,new']);
            assert.deepStrictEqual(saved, [first, { ...second, tags: ['bootloader', 'new'] }]);
        });
        test('editing into an existing complete identity preserves both original rows', async () => {
            const first = { ...base, group: 'Firmware', tags: ['manual'] };
            const second = { ...base, group: 'Bootloader' };
            const saved = await edit([first, second], 1, [base.title, base.link, 'Firmware', 'manual']);
            assert.deepStrictEqual(saved, [first, second]);
            assert.ok(messages.some(message => message.includes(t('이미 존재합니다', 'already exists'))));
        });
        test('a selected row removed during the form does not redirect the edit to its sibling', async () => {
            const first = { ...base, group: 'Firmware' };
            const second = { ...base, group: 'Bootloader' };
            const saved = await edit([first, second], 1, ['Updated', base.link, 'Bootloader', ''], () => {
                fs.writeFileSync(file, JSON.stringify([first]));
            });
            assert.deepStrictEqual(saved, [first]);
            assert.ok(messages.includes(t('links.json에서 선택한 링크를 찾을 수 없습니다.', 'Could not find the selected link in links.json.')));
        });
    });

    suite('input profile execution freshness', () => {
        const actionId = 'ux-review-profile';
        const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const actionsFile = path.join(workspace, '.vscode', 'actions.json');
        const outputFile = path.join(workspace, 'taskhub-ux-review-result.txt');
        let previousActions: Buffer | undefined;
        let store: InputProfileStore;
        let profileId: string;
        let context: vscode.ExtensionContext;
        let provider: MainViewProvider;
        let history: HistoryProvider;
        const action = (prefix = 'old', inputId = 'target'): ActionItem => ({
            id: actionId, title: 'Review action', action: {
                description: 'review fixture', tasks: [
                    { id: inputId, type: 'inputBox' },
                    { id: 'write', type: 'writeFile', path: outputFile, content: `${prefix}:\${${inputId}.value}`, overwrite: true },
                ],
            },
        });
        const writeAction = (item?: ActionItem): void => { fs.writeFileSync(actionsFile, JSON.stringify(item ? [item] : [])); };
        const run = () => runActionWithInputProfile({ id: actionId } as Action, context, provider, history, store);
        const replaceProfile = () => store.save({ actionId, name: 'Review', inputs: { target: { value: 'latest' } }, taskTypes: { target: 'inputBox' } }, profileId);
        setup(async () => {
            previousActions = fs.existsSync(actionsFile) ? fs.readFileSync(actionsFile) : undefined;
            fs.mkdirSync(path.dirname(actionsFile), { recursive: true });
            writeAction(action());
            invalidateActionsCache();
            const values = new Map<string, unknown>();
            const memory = {
                get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
                update: async (key: string, value: unknown) => { values.set(key, value); },
                keys: () => [...values.keys()],
                setKeysForSync: () => undefined,
            };
            context = {
                extensionPath: path.resolve(__dirname, '../..'), subscriptions: [],
                globalStorageUri: vscode.Uri.file(path.join(workspace, '.taskhub-review-global')),
                workspaceState: memory, globalState: memory,
                extension: { packageJSON: { version: '0.0.0-test' } },
            } as unknown as vscode.ExtensionContext;
            store = new InputProfileStore(memory);
            profileId = (await store.save({ actionId, name: 'Review', inputs: { target: { value: 'saved' } }, taskTypes: { target: 'inputBox' } })).id;
            provider = new MainViewProvider(context, () => [action()]);
            history = new HistoryProvider(context);
            vscode.window.showQuickPick = (async (items: any[]) => items[0]) as unknown as typeof original.pick;
            vscode.window.showInputBox = (async () => 'fresh') as typeof original.input;
        });
        teardown(() => {
            provider.dispose();
            history.dispose();
            if (previousActions) { fs.writeFileSync(actionsFile, previousActions); }
            else { fs.rmSync(actionsFile, { force: true }); }
            fs.rmSync(outputFile, { force: true });
            invalidateActionsCache();
        });
        test('a changed action and profile are re-read after selection and reach the real pipeline', async () => {
            vscode.window.showQuickPick = (async (items: any[]) => {
                writeAction(action('new'));
                await replaceProfile();
                return items[0];
            }) as unknown as typeof original.pick;
            await run();
            assert.deepStrictEqual(errors, []);
            assert.strictEqual(fs.readFileSync(outputFile, 'utf8'), 'new:latest');
            assert.deepStrictEqual(history.getHistory()[0].inputs?.target, { value: 'latest' });
        });
        for (const removed of ['action', 'profile'] as const) {
            test(`removing the ${removed} during selection stops execution`, async () => {
                vscode.window.showQuickPick = (async (items: any[]) => {
                    if (removed === 'action') { writeAction(); }
                    else { await store.delete(profileId); }
                    return items[0];
                }) as unknown as typeof original.pick;
                await run();
                assert.strictEqual(fs.existsSync(outputFile), false);
                assert.strictEqual(history.getHistory().length, 0);
                assert.strictEqual(errors.length, 1);
            });
        }
        test('confirmation repeats validation after action and profile change', async () => {
            writeAction(action('outdated', 'newTarget'));
            invalidateActionsCache();
            let confirmations = 0;
            vscode.window.showWarningMessage = (async (_message: string, _options: unknown, accept: string) => {
                confirmations++;
                writeAction(action('confirmed'));
                await replaceProfile();
                return accept;
            }) as typeof original.warning;
            await run();
            assert.strictEqual(confirmations, 1);
            assert.strictEqual(fs.readFileSync(outputFile, 'utf8'), 'confirmed:latest');
        });
        test('renaming the parent during confirmation updates the recorded action path', async () => {
            const nested = action('outdated', 'newTarget');
            const writeFolder = (title: string) => writeAction({ id: 'ux-review-folder', title, children: [nested] });
            writeFolder('Before');
            invalidateActionsCache();
            vscode.window.showWarningMessage = (async (_message: string, _options: unknown, accept: string) => {
                writeFolder('After');
                return accept;
            }) as typeof original.warning;
            await run();
            assert.deepStrictEqual(errors, []);
            assert.deepStrictEqual(history.getHistory()[0].actionPath, ['After', nested.title]);
        });
        test('canceling outdated input confirmation leaves no output or running history', async () => {
            writeAction(action('outdated', 'newTarget'));
            invalidateActionsCache();
            await run();
            assert.strictEqual(fs.existsSync(outputFile), false);
            assert.strictEqual(history.getHistory().length, 0);
        });
        for (const removed of ['action', 'profile'] as const) {
            test(`removing the ${removed} during outdated confirmation stops execution`, async () => {
                writeAction(action('outdated', 'newTarget'));
                invalidateActionsCache();
                vscode.window.showWarningMessage = (async (_message: string, _options: unknown, accept: string) => {
                    if (removed === 'action') { writeAction(); }
                    else { await store.delete(profileId); }
                    return accept;
                }) as typeof original.warning;
                await run();
                assert.strictEqual(fs.existsSync(outputFile), false);
                assert.strictEqual(history.getHistory().length, 0);
                assert.strictEqual(errors.length, 1);
            });
        }
    });

    suite('run log settings feedback', () => {
        const config = vscode.workspace.getConfiguration('taskhub.runLogs');
        let globalValue: boolean | undefined;
        let workspaceValue: boolean | undefined;
        setup(async () => {
            const inspected = vscode.workspace.getConfiguration('taskhub.runLogs').inspect<boolean>('enabled');
            globalValue = inspected?.globalValue;
            workspaceValue = inspected?.workspaceValue;
            await config.update('enabled', false, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage = (async (message: string, ...choices: string[]) => {
                messages.push(message);
                return choices.find(choice => choice === t('실행 로그 켜기', 'Turn on run logs'));
            }) as unknown as typeof original.information;
        });
        teardown(async () => {
            await config.update('enabled', globalValue, vscode.ConfigurationTarget.Global);
            await config.update('enabled', workspaceValue, vscode.ConfigurationTarget.Workspace);
        });
        const show = () => showActionRunReport(new HistoryItem({
            actionId: 'ux-review-run-log', actionTitle: 'Review', timestamp: 1, status: 'success',
        }).getEntry());
        test('실행 로그 폴더가 없고 저장이 꺼져 있으면 그 설정으로 바로 가는 버튼을 준다', async () => {
            await config.update('enabled', undefined, vscode.ConfigurationTarget.Workspace);
            const folder = vscode.workspace.workspaceFolders?.[0];
            assert.ok(folder, '테스트 워크스페이스가 필요하다');
            assert.ok(!fs.existsSync(path.join(folder.uri.fsPath, '.taskhub', 'logs')));
            const prompts: string[][] = [];
            vscode.window.showInformationMessage = (async (message: string, ...choices: string[]) => {
                messages.push(message);
                prompts.push(choices);
                return choices.find(choice => choice === t('설정 열기', 'Open Settings'));
            }) as unknown as typeof original.information;
            const originalExecute = vscode.commands.executeCommand;
            const opened: unknown[] = [];
            (vscode.commands as any).executeCommand = (command: string, ...args: unknown[]) => {
                if (command === 'workbench.action.openSettings') { opened.push(args[0]); return Promise.resolve(); }
                return originalExecute.call(vscode.commands, command, ...args);
            };
            try {
                await vscode.commands.executeCommand('taskhub.openRunLogsFolder');
            } finally {
                (vscode.commands as any).executeCommand = originalExecute;
            }
            assert.deepStrictEqual(prompts.at(-1), [t('설정 열기', 'Open Settings')]);
            assert.ok(!messages.at(-1)!.includes('`'), '알림은 마크다운을 그리지 않으므로 백틱이 그대로 보인다');
            assert.deepStrictEqual(opened, ['taskhub.runLogs.enabled']);
        });

        test('workspace false is reported instead of claiming future runs will be logged', async () => {
            await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
            await show();
            assert.strictEqual(vscode.workspace.getConfiguration('taskhub.runLogs').inspect<boolean>('enabled')?.globalValue, true);
            assert.strictEqual(vscode.workspace.getConfiguration('taskhub.runLogs').get('enabled'), false);
            assert.strictEqual(warnings.length, 1);
            assert.ok(warnings[0].includes(t('워크스페이스', 'workspace')));
            assert.ok(!messages.some(message => message.includes(t('다음 실행부터', 'Runs from now on'))));
        });
        test('without an override the enabled setting and success feedback agree', async () => {
            await config.update('enabled', undefined, vscode.ConfigurationTarget.Workspace);
            await show();
            assert.strictEqual(vscode.workspace.getConfiguration('taskhub.runLogs').get('enabled'), true);
            assert.strictEqual(warnings.length, 0);
            assert.ok(messages.some(message => message.includes(t('다음 실행부터', 'Runs from now on'))));
        });
    });

    suite('action failure notification', () => {
        test('실패 알림에서 같은 실행의 보고서 보기·다시 실행으로 바로 이어진다', async () => {
            const entry = { actionId: 'build', actionTitle: 'Build', timestamp: 42, status: 'failure' } as any;
            const prompts: string[][] = [];
            let answer: string | undefined;
            vscode.window.showErrorMessage = (async (message: string, ...buttons: string[]) => {
                errors.push(message);
                prompts.push(buttons);
                return answer;
            }) as unknown as typeof original.error;
            const originalExecute = vscode.commands.executeCommand;
            const executed: unknown[][] = [];
            (vscode.commands as any).executeCommand = async (...args: unknown[]) => { executed.push(args); };
            try {
                answer = t('다시 실행', 'Run Again');
                let lookups = 0;
                await showActionFailureNotification('Build failed', () => { lookups++; return entry; });
                assert.deepStrictEqual(prompts[0], [t('실행 보고서 보기', 'View Run Report'), t('다시 실행', 'Run Again')]);
                assert.strictEqual(lookups, 1, '기록은 버튼을 누른 시점에 찾는다');
                assert.deepStrictEqual(executed, [['taskhub.rerunFromHistory', entry]]);

                answer = t('다시 실행', 'Run Again');
                await showActionFailureNotification('Build failed', () => undefined);
                assert.strictEqual(executed.length, 1, '기록이 사라졌으면 실행하지 않고 이유를 알린다');
                assert.match(warnings.at(-1) ?? '', /기록|history entry/);

                await showActionFailureNotification('No history');
                assert.deepStrictEqual(prompts.at(-1), [], 'History가 없으면 버튼을 달지 않는다');

                // 알림은 실행 로그 저장보다 먼저 뜬다. 저장이 끝날 때까지 기록 조회를 기다려야
                // 보고서가 "로그를 남기지 못했다"로 잘못 열리지 않는다.
                let releaseSave!: (value: unknown) => void;
                const saved = new Promise(resolve => { releaseSave = resolve; });
                let settled = false;
                const pending = showActionFailureNotification('Build failed', async () => {
                    await saved;
                    settled = true;
                    return entry;
                }).then(() => { assert.ok(settled, '저장 완료 전에 기록을 쓰면 안 된다'); });
                await new Promise(resolve => setTimeout(resolve, 20));
                assert.strictEqual(executed.length, 1, '저장이 끝나기 전에는 다시 실행하지 않는다');
                releaseSave(undefined);
                await pending;
                assert.deepStrictEqual(executed.at(-1), ['taskhub.rerunFromHistory', entry]);
            } finally {
                (vscode.commands as any).executeCommand = originalExecute;
            }
        });
    });

    suite('open action definition', () => {
        test('폴더 아래 액션도 JSON 포인터로 찾고 그 정의 줄에서 actions.json을 연다', async () => {
            const actions = [
                { id: 'build', title: 'Build', action: { description: 'b', tasks: [{ id: 'flash', type: 'shell', command: 'x' }] } },
                { id: 'group', title: 'Group', children: [{ id: 'flash', title: 'Flash', action: { description: 'f', tasks: [] } }] },
            ];
            assert.strictEqual(findActionJsonPointer(actions, 'flash'), '/1/children/0', '태스크 id가 아니라 액션 id를 찾는다');
            assert.strictEqual(findActionJsonPointer(actions, 'missing'), undefined);

            const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-open-definition-'));
            const originalShow = vscode.window.showTextDocument;
            let shown: { line: number; file: string } | undefined;
            (vscode.window as any).showTextDocument = async (document: vscode.TextDocument, options: vscode.TextDocumentShowOptions) => {
                shown = { line: options.selection!.start.line, file: document.uri.fsPath };
            };
            try {
                fs.mkdirSync(path.join(folder, '.vscode'));
                const text = JSON.stringify(actions, null, 2);
                fs.writeFileSync(path.join(folder, '.vscode', 'actions.json'), text);
                await openActionDefinition('flash', folder);
                // 항목 객체를 여는 `{` 줄(= `"title": "Flash"` 두 줄 위)로 정확히 간다.
                const expectedLine = text.split('\n').findIndex(line => line.includes('"title": "Flash"')) - 2;
                assert.ok(shown, '파일을 열지 않았다');
                assert.strictEqual(path.basename(shown!.file), 'actions.json');
                assert.strictEqual(text.split('\n')[expectedLine].trim(), '{');
                assert.strictEqual(shown!.line, expectedLine);

                shown = undefined;
                await openActionDefinition('builtin-example', undefined);
                assert.strictEqual(shown, undefined, '워크스페이스에 없는 액션은 파일을 열지 않는다');
                assert.match(messages.at(-1) ?? '', /기본 예제|built-in examples/);
            } finally {
                (vscode.window as any).showTextDocument = originalShow;
                fs.rmSync(folder, { recursive: true, force: true });
            }
        });
    });
});
