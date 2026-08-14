import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    buildInputProfileDraft,
    INPUT_PROFILE_MAX_BYTES,
    INPUT_PROFILES_STATE_KEY,
    InputProfileMemento,
    InputProfileStore,
    InputProfileStoreError,
    inspectInputProfile,
} from '../inputProfiles';
import type { Task } from '../schema';

class MemoryMemento implements InputProfileMemento {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue: T): T {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.values.set(key, value);
    }
}

suite('Named Input Profiles', () => {
    const tasks = (): Task[] => [
        { id: 'target', type: 'quickPick', items: ['dev', 'prod'] },
        { id: 'path', type: 'folderDialog' },
        { id: 'secret', type: 'inputBox', password: true },
        { id: 'build', type: 'command', command: 'node' },
    ];
    const recordedTypes = (ids: Array<'target' | 'path'>): Record<string, string> =>
        Object.fromEntries(ids.map(id => [id, id === 'target' ? 'quickPick' : 'folderDialog']));

    test('History 입력으로 task type 서명을 만들고 password 값은 재차 제거한다', () => {
        const draft = buildInputProfileDraft('deploy', ' Office ', tasks(), {
            target: { value: 'dev' },
            secret: { value: 'do-not-store' },
        }, { target: 'quickPick', secret: 'inputBox' });

        assert.strictEqual(draft.name, 'Office');
        assert.deepStrictEqual(Object.keys(draft.inputs), ['target']);
        assert.deepStrictEqual(draft.taskTypes, { target: 'quickPick' });
        assert.ok(!JSON.stringify(draft).includes('do-not-store'));
    });

    test('바뀐 task id는 stale로 남기고 현재 입력은 다시 묻는다', () => {
        const profile = {
            id: 'p1', actionId: 'deploy', name: 'Office',
            inputs: { oldPath: { path: '/old' }, target: { value: 'dev' } },
            taskTypes: { oldPath: 'folderDialog', target: 'quickPick' },
            createdAt: 1, updatedAt: 1,
        };

        const inspected = inspectInputProfile(profile, tasks());
        assert.deepStrictEqual(inspected.staleTaskIds, ['oldPath']);
        assert.deepStrictEqual(Object.keys(inspected.usableInputs), ['target']);
        assert.deepStrictEqual(inspected.promptTaskIds, ['path']);
    });

    test('같은 id의 task type이 바뀌면 옛 값을 재사용하지 않는다', () => {
        const profile = {
            id: 'p1', actionId: 'deploy', name: 'Office',
            inputs: { target: { value: 'dev' } },
            taskTypes: { target: 'inputBox' },
            createdAt: 1, updatedAt: 1,
        };
        const inspected = inspectInputProfile(profile, tasks());
        assert.deepStrictEqual(inspected.staleTaskIds, ['target']);
        assert.deepStrictEqual(inspected.promptTaskIds, ['target', 'path']);
    });

    test('프로필은 workspaceState에서 액션별·이름순으로 왕복한다', async () => {
        const memento = new MemoryMemento();
        let id = 0;
        const store = new InputProfileStore(memento, () => 10, () => `p${++id}`);
        await store.save(buildInputProfileDraft('a', 'Zulu', tasks(), { target: { value: 'prod' } }, recordedTypes(['target'])));
        await store.save(buildInputProfileDraft('b', 'Other', tasks(), { target: { value: 'dev' } }, recordedTypes(['target'])));
        await store.save(buildInputProfileDraft('a', 'Alpha', tasks(), { path: { path: '/tmp' } }, recordedTypes(['path'])));

        assert.deepStrictEqual(store.list('a').map(profile => profile.name), ['Alpha', 'Zulu']);
        assert.strictEqual(store.list('b').length, 1);
        assert.deepStrictEqual(store.listAll().map(profile => profile.actionId), ['a', 'a', 'b']);
        assert.ok(memento.values.has(INPUT_PROFILES_STATE_KEY));
    });

    test('같은 액션의 이름은 대소문자와 무관하게 중복을 막는다', async () => {
        const store = new InputProfileStore(new MemoryMemento(), () => 10, () => 'p1');
        await store.save(buildInputProfileDraft('a', 'Office', tasks(), { target: { value: 'dev' } }, recordedTypes(['target'])));
        await assert.rejects(
            store.save(buildInputProfileDraft('a', 'office', tasks(), { target: { value: 'prod' } }, recordedTypes(['target']))),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'duplicate-name'
        );
    });

    test('128KB 상한은 inputs와 taskTypes를 합친 실제 프로필 크기에 적용한다', async () => {
        const store = new InputProfileStore(new MemoryMemento(), () => 10, () => 'p1');
        const halfLimit = Math.floor(INPUT_PROFILE_MAX_BYTES * 0.6);
        await assert.rejects(
            store.save({
                actionId: 'a',
                name: 'Combined limit',
                inputs: { value: 'i'.repeat(halfLimit) },
                taskTypes: { value: 't'.repeat(halfLimit) },
            }),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'profile-too-large'
        );
    });

    test('손상된 개별 항목과 알 수 없는 루트 필드는 저장·삭제 뒤에도 원본 그대로 보존한다', async () => {
        const memento = new MemoryMemento();
        const valid = {
            id: 'existing', actionId: 'a', name: 'Existing',
            inputs: { target: { value: 'dev' } }, taskTypes: { target: 'quickPick' },
            createdAt: 1, updatedAt: 1,
        };
        const invalid = { id: 'damaged', name: 'Damaged', inputs: null, futureField: { keep: true } };
        memento.values.set(INPUT_PROFILES_STATE_KEY, {
            version: 1,
            profiles: [valid, invalid],
            futureMetadata: { keep: true },
        });
        const store = new InputProfileStore(memento, () => 10, () => 'new');

        assert.deepStrictEqual(store.listAll().map(profile => profile.id), ['existing']);
        await store.save({
            actionId: 'a', name: 'New',
            inputs: { target: { value: 'prod' } }, taskTypes: { target: 'quickPick' },
        });
        let persisted = memento.values.get(INPUT_PROFILES_STATE_KEY) as any;
        assert.strictEqual(persisted.profiles.length, 3);
        assert.deepStrictEqual(persisted.profiles.slice(0, 2), [valid, invalid]);
        assert.deepStrictEqual(persisted.futureMetadata, { keep: true });

        assert.strictEqual(await store.delete('existing'), true);
        persisted = memento.values.get(INPUT_PROFILES_STATE_KEY) as any;
        assert.deepStrictEqual(persisted.profiles[0], invalid);
        assert.deepStrictEqual(persisted.futureMetadata, { keep: true });
    });

    test('50개 상한은 숨겨진 손상 항목까지 포함한 워크스페이스 전체 배열에 적용한다', async () => {
        const memento = new MemoryMemento();
        const damagedProfiles = Array.from({ length: 50 }, (_, index) => ({ damaged: index }));
        const original = { version: 1, profiles: damagedProfiles };
        memento.values.set(INPUT_PROFILES_STATE_KEY, original);
        const store = new InputProfileStore(memento, () => 10, () => 'new');

        await assert.rejects(
            store.save({ actionId: 'a', name: 'New', inputs: { value: 1 }, taskTypes: { value: 'inputBox' } }),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'too-many-profiles'
        );
        assert.strictEqual(memento.values.get(INPUT_PROFILES_STATE_KEY), original);
    });

    test('손상되었거나 지원하지 않는 루트 상태는 읽기와 변경을 거부하고 덮어쓰지 않는다', async () => {
        const memento = new MemoryMemento();
        const unsupported = { version: 2, profiles: [{ future: true }] };
        memento.values.set(INPUT_PROFILES_STATE_KEY, unsupported);
        const store = new InputProfileStore(memento, () => 10, () => 'p1');

        assert.throws(
            () => store.listAll(),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'store-corrupt'
        );
        await assert.rejects(
            store.save({ actionId: 'a', name: 'New', inputs: { value: 1 }, taskTypes: { value: 'inputBox' } }),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'store-corrupt'
        );
        await assert.rejects(
            store.delete('future'),
            (error: unknown) => error instanceof InputProfileStoreError && error.code === 'store-corrupt'
        );
        assert.strictEqual(memento.values.get(INPUT_PROFILES_STATE_KEY), unsupported);
    });

    test('덮어쓰기·이름 변경·삭제는 profile id와 생성 시각을 보존한다', async () => {
        const memento = new MemoryMemento();
        let now = 10;
        const store = new InputProfileStore(memento, () => now++, () => 'p1');
        const first = await store.save(buildInputProfileDraft('a', 'Office', tasks(), { target: { value: 'dev' } }, recordedTypes(['target'])));
        const replaced = await store.save(
            buildInputProfileDraft('a', 'Office', tasks(), { target: { value: 'prod' } }, recordedTypes(['target'])),
            first.id
        );
        const renamed = await store.rename(first.id, 'Production');

        assert.strictEqual(replaced.id, first.id);
        assert.strictEqual(replaced.createdAt, first.createdAt);
        assert.strictEqual((renamed.inputs.target as any).value, 'prod');
        assert.strictEqual(renamed.name, 'Production');
        assert.strictEqual(await store.delete(first.id), true);
        assert.strictEqual(await store.delete(first.id), false);
        assert.deepStrictEqual(store.list('a'), []);
    });

    test('__proto__ task id도 own property인 입력으로 보존한다', () => {
        const historyInputs: Record<string, unknown> = JSON.parse('{"__proto__":{"value":"safe"}}');
        const draft = buildInputProfileDraft(
            'a', 'Prototype', [{ id: '__proto__', type: 'inputBox' }], historyInputs,
            JSON.parse('{"__proto__":"inputBox"}')
        );
        const inspected = inspectInputProfile({
            id: 'p', ...draft, createdAt: 1, updatedAt: 1,
        }, [{ id: '__proto__', type: 'inputBox' }]);

        assert.ok(Object.prototype.hasOwnProperty.call(inspected.usableInputs, '__proto__'));
        assert.deepStrictEqual(inspected.usableInputs.__proto__, { value: 'safe' });
    });

    test('타입 서명이 없는 0.7.27 이전 History 값은 검증 불가로 다시 묻는다', () => {
        const draft = buildInputProfileDraft(
            'a', 'Legacy', tasks(), { target: { value: 'dev' } }, undefined
        );
        const inspected = inspectInputProfile({
            id: 'legacy', ...draft, createdAt: 1, updatedAt: 1,
        }, tasks());

        assert.deepStrictEqual(inspected.staleTaskIds, ['target']);
        assert.deepStrictEqual(inspected.promptTaskIds, ['target', 'path']);
    });

    test('manifest는 context 명령과 orphan 정리용 전역 관리 명령을 구분한다', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
        const declared = new Set(manifest.contributes.commands.map((entry: any) => entry.command));
        const required = [
            'taskhub.runActionWithInputProfile',
            'taskhub.manageInputProfiles',
            'taskhub.manageAllInputProfiles',
            'taskhub.saveHistoryInputsAsProfile',
        ];
        required.forEach(command => assert.ok(declared.has(command), `${command}가 contributes.commands에 없다`));

        const hidden = new Set(
            manifest.contributes.menus.commandPalette
                .filter((entry: any) => entry.when === 'false')
                .map((entry: any) => entry.command)
        );
        assert.ok(hidden.has('taskhub.runActionWithInputProfile'));
        assert.ok(hidden.has('taskhub.manageInputProfiles'));
        assert.ok(hidden.has('taskhub.saveHistoryInputsAsProfile'));
        assert.ok(!hidden.has('taskhub.manageAllInputProfiles'), 'orphan 프로필 정리 명령은 Command Palette에 보여야 한다');

        const viewCommands = manifest.contributes.menus['view/item/context'].map((entry: any) => entry.command);
        assert.ok(viewCommands.includes('taskhub.runActionWithInputProfile'));
        assert.ok(viewCommands.includes('taskhub.manageInputProfiles'));
        assert.ok(viewCommands.includes('taskhub.saveHistoryInputsAsProfile'));
    });
});
