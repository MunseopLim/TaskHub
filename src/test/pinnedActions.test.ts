import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyCurrentInputProfileValidation, executeAction, findActionById, registerStopActionCommand, stopRunningAction } from '../extension';
import { InputProfileStore, InputProfileMemento, INPUT_PROFILES_STATE_KEY } from '../inputProfiles';
import { PinnedActionStore, PinnedActionStoreError, PINNED_ACTIONS_STATE_KEY, pinnedActionKey } from '../pinnedActions';
import { registerPinnedActionCommands } from '../pinnedActionCommands';
import { Action, Folder, MainViewProvider, PinnedAction } from '../providers/mainViewProvider';
import { actionStates } from '../providers/actionStatus';
import { HistoryProvider } from '../providers/historyProvider';
import { ActionItem } from '../schema';

class MemoryMemento implements InputProfileMemento {
    readonly values = new Map<string, unknown>();
    failWrites = false;
    get<T>(key: string, fallback: T): T { return this.values.has(key) ? this.values.get(key) as T : fallback; }
    async update(key: string, value: unknown): Promise<void> {
        await Promise.resolve();
        if (this.failWrites) { throw new Error('read-only'); }
        this.values.set(key, value);
    }
}

suite('Pinned action storage', () => {
    test('워크스페이스별 ID 참조만 저장하고 같은 조합은 중복되지 않는다', async () => {
        const memory = new MemoryMemento();
        const store = new PinnedActionStore(memory);
        assert.strictEqual(await store.add({ actionId: 'build' }), true);
        assert.strictEqual(await store.add({ actionId: 'build', profileId: 'office' }), true);
        assert.strictEqual(await store.add({ actionId: 'build', profileId: 'office' }), false);
        assert.deepStrictEqual(memory.values.get(PINNED_ACTIONS_STATE_KEY), {
            version: 1, pins: [{ actionId: 'build' }, { actionId: 'build', profileId: 'office' }]
        });
        const reloaded = new PinnedActionStore(memory);
        reloaded.list()[0].actionId = 'tampered';
        assert.deepStrictEqual(reloaded.list(), store.list());
        assert.deepStrictEqual(new PinnedActionStore(new MemoryMemento()).list(), []);
        assert.notStrictEqual(pinnedActionKey({ actionId: 'a:b', profileId: 'c' }), pinnedActionKey({ actionId: 'a', profileId: 'b:c' }));
    });

    test('동시에 고정·해제해도 쓰기가 직렬화되어 다른 변경을 잃지 않는다', async () => {
        const store = new PinnedActionStore(new MemoryMemento());
        await Promise.all([
            store.add({ actionId: 'a' }), store.add({ actionId: 'b' }), store.remove({ actionId: 'a' }), store.add({ actionId: 'c' })
        ]);
        assert.deepStrictEqual(store.list(), [{ actionId: 'b' }, { actionId: 'c' }]);
    });

    test('손상·미지원·중복 상태를 덮어쓰지 않고 저장 실패 후 재시도할 수 있다', async () => {
        for (const raw of [
            { version: 2, pins: [] }, { version: 1, pins: [{ actionId: 'a', profileId: null }] },
            { version: 1, pins: [{ actionId: 'a' }, { actionId: 'a' }] }
        ]) {
            const memory = new MemoryMemento();
            memory.values.set(PINNED_ACTIONS_STATE_KEY, raw);
            const store = new PinnedActionStore(memory);
            assert.throws(() => store.list(), PinnedActionStoreError);
            await assert.rejects(store.add({ actionId: 'b' }), PinnedActionStoreError);
            await assert.rejects(store.remove({ actionId: 'a' }), PinnedActionStoreError);
            assert.strictEqual(memory.values.get(PINNED_ACTIONS_STATE_KEY), raw);
        }
        const memory = new MemoryMemento();
        const store = new PinnedActionStore(memory);
        memory.failWrites = true;
        await assert.rejects(store.add({ actionId: 'a' }), /read-only/);
        assert.deepStrictEqual(store.list(), []);
        memory.failWrites = false;
        assert.strictEqual(await store.add({ actionId: 'a' }), true);
        memory.failWrites = true;
        await assert.rejects(store.remove({ actionId: 'a' }), /read-only/);
        assert.strictEqual(store.has({ actionId: 'a' }), true);
    });
});

suite('Pinned action tree and registered commands', () => {
    let memory: MemoryMemento;
    let store: PinnedActionStore;
    let profiles: InputProfileStore;
    let context: vscode.ExtensionContext;
    let provider: MainViewProvider;
    let history: HistoryProvider;
    let actions: ActionItem[];
    let callbacks: Map<string, (...args: any[]) => Promise<void>>;
    let errors: string[];
    let executions: Array<{ item: ActionItem; inputs: Record<string, unknown> | undefined }>;
    let duringPick: (() => Promise<void>) | undefined;
    let pickIndex: number | undefined;
    let confirm: () => Promise<boolean>;
    let usePipeline: boolean;
    let restore: () => void;
    let commands: vscode.Disposable;
    const actionId = 'pinned-action-test';
    const makeAction = (): ActionItem => ({
        id: actionId, title: 'Build', action: {
            description: 'Build fixture', tasks: [{ id: 'target', type: 'inputBox' }]
        }
    });
    const saveProfile = (name = 'Board A', value = 'a') => profiles.save({
        actionId, name, inputs: { target: { value } }, taskTypes: { target: 'inputBox' }
    });
    const pinRow = async (profileId?: string): Promise<PinnedAction> => {
        await store.add({ actionId, ...(profileId === undefined ? {} : { profileId }) });
        const rows = await provider.getChildren();
        return rows.find(row => row instanceof PinnedAction && row.pin.profileId === profileId) as PinnedAction;
    };

    setup(() => {
        memory = new MemoryMemento();
        store = new PinnedActionStore(memory);
        let profileId = 0;
        profiles = new InputProfileStore(memory, () => 1, () => `profile-${++profileId}`);
        context = {
            workspaceState: memory, globalState: memory, subscriptions: [],
            extensionPath: path.resolve(__dirname, '..', '..'), extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } }
        } as unknown as vscode.ExtensionContext;
        actions = [makeAction()];
        provider = new MainViewProvider(context, () => actions, () => [], store, profiles);
        history = new HistoryProvider(context);
        callbacks = new Map();
        errors = [];
        executions = [];
        duringPick = undefined;
        pickIndex = 0;
        confirm = async () => true;
        usePipeline = false;
        const original = {
            register: vscode.commands.registerCommand, pick: vscode.window.showQuickPick,
            error: vscode.window.showErrorMessage, info: vscode.window.showInformationMessage,
            input: vscode.window.showInputBox
        };
        restore = () => {
            vscode.commands.registerCommand = original.register;
            vscode.window.showQuickPick = original.pick;
            vscode.window.showErrorMessage = original.error;
            vscode.window.showInformationMessage = original.info;
            vscode.window.showInputBox = original.input;
        };
        (vscode.commands as any).registerCommand = (id: string, callback: (...args: any[]) => Promise<void>) => {
            callbacks.set(id, callback);
            return new vscode.Disposable(() => callbacks.delete(id));
        };
        (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
        (vscode.window as any).showInformationMessage = async () => undefined;
        (vscode.window as any).showQuickPick = async (items: unknown[]) => {
            await duringPick?.();
            return pickIndex === undefined ? undefined : items[pickIndex];
        };
        commands = vscode.Disposable.from(registerPinnedActionCommands({
            store, profiles, loadActions: () => actions, findAction: findActionById,
            refresh: () => provider.refresh(), validateInputs: applyCurrentInputProfileValidation,
            confirmOutdated: async () => confirm(),
            execute: async (item, _all, inputs) => {
                executions.push({ item, inputs });
                if (usePipeline) { await executeAction(item, context, provider, history, inputs, [item.title]); }
            }
        }), registerStopActionCommand(history));
        // 이후 pipeline의 다른 동적 명령 등록은 실제 API를 사용한다.
        vscode.commands.registerCommand = original.register;
    });

    teardown(() => {
        commands.dispose();
        provider.dispose();
        history.dispose();
        actionStates.delete(actionId);
        restore();
    });

    test('일반 액션·프로필을 선택해 고정하고 취소·중복은 목록을 바꾸지 않는다', async () => {
        await saveProfile();
        const ordinary = (await provider.getChildren())[0] as Action;
        await callbacks.get('taskhub.pinAction')!(ordinary);
        pickIndex = 1;
        await callbacks.get('taskhub.pinAction')!(ordinary);
        await callbacks.get('taskhub.pinAction')!(ordinary);
        pickIndex = undefined;
        await callbacks.get('taskhub.pinAction')!(ordinary);
        const rows = await provider.getChildren();
        assert.deepStrictEqual(rows.map(row => row.label), ['Build', 'Build · Board A', 'Build']);
        assert.strictEqual(store.list().length, 2);
        assert.strictEqual(rows[0].command?.command, 'taskhub.runPinnedAction');
        assert.strictEqual(rows[2].command?.command, 'taskhub.executeAction');
        await callbacks.get('taskhub.unpinAction')!(rows[0]);
        assert.strictEqual(store.list().length, 1);
        assert.deepStrictEqual(errors, []);
    });

    test('선택창이 열린 동안 프로필이 삭제되면 고정하지 않는다', async () => {
        const profile = await saveProfile();
        pickIndex = 1;
        duringPick = async () => { await profiles.delete(profile.id); };
        await callbacks.get('taskhub.pinAction')!((await provider.getChildren())[0]);
        assert.deepStrictEqual(store.list(), []);
        assert.strictEqual(errors.length, 1);
    });

    test('프로필 저장소를 읽을 수 없어도 안내와 함께 액션만 고정할 수 있고 원본 데이터는 보존한다', async () => {
        const corrupted = { version: 2, profiles: [] };
        memory.values.set(INPUT_PROFILES_STATE_KEY, corrupted);
        let offered: vscode.QuickPickItem[] = [];
        (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
            offered = items;
            return items[0];
        };
        await callbacks.get('taskhub.pinAction')!((await provider.getChildren())[0]);
        assert.strictEqual(offered.length, 1, '사용할 수 없는 프로필은 선택지로 제공하지 않는다');
        assert.ok(offered[0].detail, '프로필을 사용할 수 없는 이유를 선택창에서 알려야 한다');
        assert.deepStrictEqual(store.list(), [{ actionId }]);
        assert.strictEqual(memory.values.get(INPUT_PROFILES_STATE_KEY), corrupted);
        assert.deepStrictEqual(errors, []);
    });

    test('원본·프로필별 행·사용자 정의 ID 충돌에서도 tree ID가 모두 다르다', async () => {
        const profile = await saveProfile();
        const base = `taskhub.pinned:${pinnedActionKey({ actionId })}`;
        actions = [{ id: base, title: 'Folder', type: 'folder', children: actions }];
        await pinRow();
        await pinRow(profile.id);
        const rows = await provider.getChildren();
        const children = await provider.getChildren(rows.find(row => row instanceof Folder));
        const ids = [...rows, ...children].map(row => row.id);
        assert.strictEqual(new Set(ids).size, ids.length);
        const pinned = rows[0] as PinnedAction;
        assert.strictEqual(pinned.actionId, actionId, 'Stop must use the underlying action ID');
        assert.notStrictEqual(pinned.id, pinned.actionId);
    });

    test('이름 변경은 행에 반영하고 삭제된 참조는 실행하지 않으며 해제할 수 있다', async () => {
        const profile = await saveProfile();
        const oldRow = await pinRow(profile.id);
        actions[0].title = 'New Build';
        await profiles.rename(profile.id, 'Renamed');
        assert.strictEqual((await provider.getChildren())[0].label, 'New Build · Renamed');
        await profiles.delete(profile.id);
        const missing = (await provider.getChildren())[0];
        assert.strictEqual(missing.contextValue, 'pinnedUnavailableAction');
        assert.strictEqual(missing.command, undefined);
        await callbacks.get('taskhub.runPinnedAction')!(oldRow);
        assert.strictEqual(executions.length, 0);
        await callbacks.get('taskhub.unpinAction')!(missing);
        assert.deepStrictEqual(store.list(), []);
        await pinRow();
        actions = [];
        const noAction = (await provider.getChildren())[0];
        assert.strictEqual(noAction.contextValue, 'pinnedUnavailableAction');
        await callbacks.get('taskhub.runPinnedAction')!(noAction);
        assert.strictEqual(executions.length, 0);
    });

    test('모든 고정 행이 원본 액션의 실행·중지 상태를 공유하고 완료 결과는 복제하지 않는다', async () => {
        const profile = await saveProfile();
        await pinRow();
        await pinRow(profile.id);
        actionStates.set(actionId, { state: 'running', progress: { total: 2, completed: 0, running: [{ taskId: 'target', index: 1 }] } });
        const rows = await provider.getChildren();
        assert.deepStrictEqual(rows.map(row => row.contextValue), ['pinnedRunningAction', 'pinnedRunningAction', 'runningAction']);
        assert.ok(String(rows[0].description).includes('1/2'));
        assert.strictEqual((rows[0] as PinnedAction).actionId, (rows[1] as PinnedAction).actionId);
        actionStates.set(actionId, { state: 'success' });
        assert.deepStrictEqual((await provider.getChildren()).map(row => row.contextValue), ['pinnedAction', 'pinnedAction', 'succeededAction']);
    });

    test('빈 목록 welcome과 원본 파싱 오류·충돌 경고를 유지하고 손상된 고정 목록만 격리한다', async () => {
        actions = [];
        assert.deepStrictEqual(await provider.getChildren(), []);
        actions = [makeAction()];
        memory.values.set(PINNED_ACTIONS_STATE_KEY, { version: 9 });
        assert.deepStrictEqual((await provider.getChildren()).map(row => row.contextValue), ['pinnedActionsLoadError', 'action']);
        const broken = new MainViewProvider(context, () => { throw new Error('broken JSON'); }, () => [], store, profiles);
        const warned = new MainViewProvider(context, () => actions, () => ['duplicate'], store, profiles);
        try {
            assert.deepStrictEqual((await broken.getChildren()).map(row => row.contextValue), ['actionsLoadError']);
            assert.deepStrictEqual((await warned.getChildren()).map(row => row.contextValue), ['actionSourceConflicts', 'pinnedActionsLoadError', 'action']);
        } finally { broken.dispose(); warned.dispose(); }
    });

    test('클릭 시 최신 프로필 입력을 파이프라인에서 재사용하고 일반 고정은 입력을 묻는다', async () => {
        const profile = await saveProfile();
        const row = await pinRow(profile.id);
        await profiles.save({ actionId, name: 'Board A', inputs: { target: { value: 'updated' } }, taskTypes: { target: 'inputBox' } }, profile.id);
        let prompts = 0;
        (vscode.window as any).showInputBox = async () => { prompts++; return 'fresh'; };
        usePipeline = true;
        await callbacks.get('taskhub.runPinnedAction')!(row);
        assert.strictEqual(prompts, 0);
        assert.deepStrictEqual(history.getHistory()[0].inputs?.target, { value: 'updated' });
        assert.strictEqual(history.getHistory()[0].actionId, actionId);
        await callbacks.get('taskhub.runPinnedAction')!(await pinRow());
        assert.strictEqual(prompts, 1);
        assert.strictEqual(executions[1].inputs, undefined);
        assert.deepStrictEqual(errors, []);
    });

    test('현재 입력 검증을 통과하지 못하면 저장값 대신 다시 묻는다', async () => {
        const profile = await saveProfile('Old', 'invalid');
        const row = await pinRow(profile.id);
        actions[0].action!.tasks = [{ id: 'target', type: 'inputBox', validatePattern: '^valid$' }];
        let prompts = 0;
        (vscode.window as any).showInputBox = async () => { prompts++; return 'valid'; };
        usePipeline = true;
        await callbacks.get('taskhub.runPinnedAction')!(row);
        assert.strictEqual(prompts, 1);
        assert.deepStrictEqual(history.getHistory()[0].inputs?.target, { value: 'valid' });
        assert.deepStrictEqual(errors, []);
    });

    test('다른 프로필 고정 행의 Stop 명령도 원본 실행을 취소하고 모든 별칭과 History를 정리한다', async function () {
        this.timeout(10000);
        const profile = await saveProfile();
        const ordinaryPin = await pinRow();
        await pinRow(profile.id);
        let opened!: () => void;
        const inputOpened = new Promise<void>(resolve => { opened = resolve; });
        let releaseInput: (() => void) | undefined;
        let subscription: vscode.Disposable | undefined;
        let cancelled = false;
        (vscode.window as any).showInputBox = (_options: vscode.InputBoxOptions, token: vscode.CancellationToken) => {
            return new Promise<string | undefined>(resolve => {
                releaseInput = () => resolve(undefined);
                subscription = token.onCancellationRequested(() => { cancelled = true; resolve(undefined); });
                opened();
            });
        };
        usePipeline = true;
        const run = callbacks.get('taskhub.runPinnedAction')!(ordinaryPin);
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                inputOpened,
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('input did not open')), 3000); })
            ]);
            const runningRows = await provider.getChildren();
            const sibling = runningRows.find(row => row instanceof PinnedAction && row.pin.profileId === profile.id) as PinnedAction;
            assert.strictEqual(sibling.contextValue, 'pinnedRunningAction');
            assert.notStrictEqual(sibling.id, actionId);
            await callbacks.get('taskhub.stopAction')!(sibling);
            await run;
            assert.strictEqual(cancelled, true, 'the original action cancellation token must be cancelled');
            assert.strictEqual(actionStates.has(actionId), false);
            assert.deepStrictEqual((await provider.getChildren()).map(row => row.contextValue), ['pinnedAction', 'pinnedAction', 'action']);
            assert.strictEqual(history.getHistory()[0].actionId, actionId);
            assert.strictEqual(history.getHistory()[0].status, 'cancelled');
            assert.strictEqual(history.getHistory()[0].cancelKind, 'stopped');
            assert.deepStrictEqual(errors, []);
        } finally {
            if (timer) { clearTimeout(timer); }
            stopRunningAction(actionId);
            releaseInput?.();
            await run;
            subscription?.dispose();
        }
    });

    test('오래된 프로필 확인을 취소하거나 확인 중 고정을 해제하면 실행하지 않는다', async () => {
        const profile = await saveProfile();
        const row = await pinRow(profile.id);
        actions[0].action!.tasks = [{ id: 'newTarget', type: 'inputBox' }];
        confirm = async () => false;
        await callbacks.get('taskhub.runPinnedAction')!(row);
        assert.strictEqual(executions.length, 0);
        confirm = async () => { await store.remove(row.pin); return true; };
        await callbacks.get('taskhub.runPinnedAction')!(row);
        assert.strictEqual(executions.length, 0);
    });

    test('확인 중 액션과 프로필이 바뀌면 최신 정의를 다시 검증해 실행한다', async () => {
        const profile = await saveProfile();
        const row = await pinRow(profile.id);
        actions[0].action!.tasks = [{ id: 'newTarget', type: 'inputBox' }];
        let confirmations = 0;
        confirm = async () => {
            confirmations++;
            actions[0] = { ...makeAction(), title: 'Changed while confirming' };
            await profiles.save({ actionId, name: 'Board A', inputs: { target: { value: 'latest' } }, taskTypes: { target: 'inputBox' } }, profile.id);
            return true;
        };
        await callbacks.get('taskhub.runPinnedAction')!(row);
        assert.strictEqual(confirmations, 1);
        assert.strictEqual(executions[0].item.title, 'Changed while confirming');
        assert.deepStrictEqual(executions[0].inputs?.target, { value: 'latest' });
        assert.deepStrictEqual(errors, []);
    });

    test('다른 액션 프로필·중복 ID·손상 프로필 저장소는 새 입력 실행으로 후퇴하지 않는다', async () => {
        const profile = await saveProfile();
        const row = await pinRow(profile.id);
        const raw = memory.values.get(INPUT_PROFILES_STATE_KEY) as { version: number; profiles: unknown[] };
        for (const bad of [
            { version: 2, profiles: [] },
            { version: 1, profiles: [{ ...profile, actionId: 'different' }] },
            { version: 1, profiles: [profile, { ...profile, name: 'Ambiguous' }] }
        ]) {
            memory.values.set(INPUT_PROFILES_STATE_KEY, bad);
            assert.strictEqual((await provider.getChildren())[0].contextValue, 'pinnedUnavailableAction');
            await callbacks.get('taskhub.runPinnedAction')!(row);
        }
        memory.values.set(INPUT_PROFILES_STATE_KEY, raw);
        assert.strictEqual(executions.length, 0);
        assert.strictEqual(errors.length, 3);
    });
});
