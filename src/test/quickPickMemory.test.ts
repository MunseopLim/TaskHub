import * as assert from 'assert';
import {
    initQuickPickMemory,
    pruneQuickPickSelections,
    quickPickSelectionScope,
    recallQuickPickSelection,
    rememberQuickPickSelection,
    QUICK_PICK_MEMORY_MAX_ENTRIES,
} from '../quickPickMemory';

suite('quickPickMemory', () => {
    teardown(() => { initQuickPickMemory(undefined); });

    function context() {
        const store = new Map<string, unknown>();
        return {
            store,
            context: {
                workspaceState: {
                    get: <T>(key: string) => store.get(key) as T | undefined,
                    update: async (key: string, value: unknown) => { store.set(key, value); },
                },
            },
        };
    }

    test('action과 task 조합마다 선택을 따로 기억한다', async () => {
        const memory = context();
        initQuickPickMemory(memory.context);
        const first = { actionId: 'build', id: 'mode' };
        const second = { actionId: 'deploy', id: 'mode' };

        await rememberQuickPickSelection(first, ['Release']);
        await rememberQuickPickSelection(second, ['Staging', 'Smoke']);

        assert.deepStrictEqual(recallQuickPickSelection(first), ['Release']);
        assert.deepStrictEqual(recallQuickPickSelection(second), ['Staging', 'Smoke']);
        assert.notStrictEqual(quickPickSelectionScope(first), quickPickSelectionScope(second));
    });

    test('돌려준 배열을 바꿔도 저장값은 변하지 않는다', async () => {
        const memory = context();
        initQuickPickMemory(memory.context);
        const task = { actionId: 'a', id: 'pick' };
        await rememberQuickPickSelection(task, ['A']);
        const recalled = recallQuickPickSelection(task)!;
        recalled[0] = 'changed';
        assert.deepStrictEqual(recallQuickPickSelection(task), ['A']);
    });

    test('상한을 넘으면 오래된 선택부터 버린다', () => {
        const entries: Record<string, { labels: string[]; at: number }> = Object.create(null);
        for (let i = 0; i < QUICK_PICK_MEMORY_MAX_ENTRIES + 2; i++) {
            entries[`scope-${i}`] = { labels: [`value-${i}`], at: i };
        }
        const pruned = pruneQuickPickSelections(entries);
        assert.strictEqual(Object.keys(pruned).length, QUICK_PICK_MEMORY_MAX_ENTRIES);
        assert.ok(!pruned['scope-0']);
        assert.ok(!pruned['scope-1']);
        assert.ok(pruned[`scope-${QUICK_PICK_MEMORY_MAX_ENTRIES + 1}`]);
    });

    test('저장소가 없거나 선택이 비어 있으면 조용히 건너뛴다', async () => {
        await rememberQuickPickSelection({ actionId: 'a', id: 'pick' }, ['A']);
        assert.strictEqual(recallQuickPickSelection({ actionId: 'a', id: 'pick' }), undefined);

        const memory = context();
        initQuickPickMemory(memory.context);
        await rememberQuickPickSelection({ actionId: 'a', id: 'pick' }, []);
        assert.strictEqual(memory.store.size, 0);
    });
});
