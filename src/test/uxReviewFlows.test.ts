import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { invalidateActionsCache, promptWorkspaceLinkEdit, runActionWithInputProfile, showActionRunReport } from '../extension';
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
});
