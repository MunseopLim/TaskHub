import * as assert from 'assert';
import {
    clearQuickPickSelections,
    initQuickPickMemory,
    forgetQuickPickSelection,
    pruneQuickPickSelections,
    quickPickSelectionScope,
    recallQuickPickSelection,
    rememberQuickPickSelection,
    QUICK_PICK_MEMORY_MAX_ENTRIES,
    QUICK_PICK_MEMORY_MAX_TOTAL_CHARS,
    QUICK_PICK_MEMORY_MAX_TOTAL_LABEL_CHARS,
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

        await rememberQuickPickSelection(first, [{ label: 'Release', custom: false, index: 0 }]);
        await rememberQuickPickSelection(second, [
            { label: 'Staging', custom: false, index: 0 },
            { label: 'Smoke', custom: false, index: 1 },
        ]);

        assert.deepStrictEqual(recallQuickPickSelection(first), [
            { label: 'Release', custom: false, index: 0 },
        ]);
        assert.deepStrictEqual(recallQuickPickSelection(second), [
            { label: 'Staging', custom: false, index: 0 },
            { label: 'Smoke', custom: false, index: 1 },
        ]);
        assert.notStrictEqual(quickPickSelectionScope(first), quickPickSelectionScope(second));
    });

    test('slash가 있는 action/task id 조합도 scope가 충돌하지 않는다', () => {
        assert.notStrictEqual(
            quickPickSelectionScope({ actionId: 'a/b', id: 'c' }),
            quickPickSelectionScope({ actionId: 'a', id: 'b/c' })
        );
    });

    test('구형 slash scope는 활성화 마이그레이션에서 제거한다', async () => {
        const memory = context();
        memory.store.set('taskhub.quickPickSelections', {
            'build/mode': { labels: ['plaintext secret'], at: 1 },
            [quickPickSelectionScope({ actionId: 'safe', id: 'mode' })]: {
                selections: [{ label: 'Release', custom: false, index: 0 }], at: 2,
            },
        });
        initQuickPickMemory(memory.context);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(memory.store.get('taskhub.quickPickSelections'), {
            [quickPickSelectionScope({ actionId: 'safe', id: 'mode' })]: {
                selections: [{ label: 'Release', custom: false, index: 0 }], at: 2,
            },
        });
    });

    test('민감 task 정리는 현재 remember 설정과 무관하게 구형 scope도 없앤다', async () => {
        const memory = context();
        memory.store.set('taskhub.quickPickSelections', {
            'build/mode': { labels: ['plaintext secret'], at: 1 },
        });
        initQuickPickMemory(memory.context);
        await forgetQuickPickSelection({ actionId: 'build', id: 'mode' });
        assert.deepStrictEqual(memory.store.get('taskhub.quickPickSelections'), {});
    });

    test('돌려준 배열을 바꿔도 저장값은 변하지 않는다', async () => {
        const memory = context();
        initQuickPickMemory(memory.context);
        const task = { actionId: 'a', id: 'pick' };
        await rememberQuickPickSelection(task, [{ label: 'A', custom: true }]);
        const recalled = recallQuickPickSelection(task)!;
        recalled[0].label = 'changed';
        assert.deepStrictEqual(recallQuickPickSelection(task), [{ label: 'A', custom: true }]);
    });

    test('안정 item id를 label과 함께 손실 없이 기억한다', async () => {
        const memory = context();
        initQuickPickMemory(memory.context);
        const task = { actionId: 'build', id: 'mode' };
        await rememberQuickPickSelection(task, [
            { label: '릴리스', itemId: 'release', custom: false, index: 1 },
        ]);
        assert.deepStrictEqual(recallQuickPickSelection(task), [
            { label: '릴리스', itemId: 'release', custom: false, index: 1 },
        ]);
    });

    test('현재 워크스페이스의 모든 QuickPick 기억을 한 번에 초기화한다', async () => {
        const memory = context();
        initQuickPickMemory(memory.context);
        await rememberQuickPickSelection({ actionId: 'build', id: 'mode' }, [
            { label: 'Release', itemId: 'release', custom: false },
        ]);
        await rememberQuickPickSelection({ actionId: 'deploy', id: 'target' }, [
            { label: 'Staging', custom: false },
        ]);

        assert.strictEqual(await clearQuickPickSelections(), 2);
        assert.strictEqual(memory.store.get('taskhub.quickPickSelections'), undefined);
        assert.strictEqual(recallQuickPickSelection({ actionId: 'build', id: 'mode' }), undefined);
        assert.strictEqual(await clearQuickPickSelections(), 0);
    });

    test('상한을 넘으면 오래된 선택부터 버린다', () => {
        const entries: Record<string, { selections: Array<{ label: string; custom: boolean }>; at: number }> = Object.create(null);
        for (let i = 0; i < QUICK_PICK_MEMORY_MAX_ENTRIES + 2; i++) {
            entries[`scope-${i}`] = { selections: [{ label: `value-${i}`, custom: false }], at: i };
        }
        const pruned = pruneQuickPickSelections(entries);
        assert.strictEqual(Object.keys(pruned).length, QUICK_PICK_MEMORY_MAX_ENTRIES);
        assert.ok(!pruned['scope-0']);
        assert.ok(!pruned['scope-1']);
        assert.ok(pruned[`scope-${QUICK_PICK_MEMORY_MAX_ENTRIES + 1}`]);
    });

    test('entry 개수와 별개로 label 총량도 제한한다', () => {
        const entries: Record<string, { selections: Array<{ label: string; custom: boolean }>; at: number }> = Object.create(null);
        for (let i = 0; i < QUICK_PICK_MEMORY_MAX_ENTRIES; i++) {
            entries[`scope-${i}`] = {
                selections: [{ label: `${i}:` + 'x'.repeat(1022), custom: false }],
                at: i,
            };
        }
        const pruned = pruneQuickPickSelections(entries);
        const total = Object.values(pruned).reduce(
            (sum, entry) => sum + entry.selections.reduce((n, selection) => n + selection.label.length, 0),
            0
        );
        assert.ok(total <= QUICK_PICK_MEMORY_MAX_TOTAL_LABEL_CHARS);
        assert.ok(pruned[`scope-${QUICK_PICK_MEMORY_MAX_ENTRIES - 1}`], '최신 항목을 우선해야 한다');
        assert.ok(Object.keys(pruned).length < QUICK_PICK_MEMORY_MAX_ENTRIES);
    });

    test('총량 상한에는 긴 scope key도 포함한다', () => {
        const hugeScope = JSON.stringify(['a'.repeat(QUICK_PICK_MEMORY_MAX_TOTAL_CHARS), 'pick']);
        const pruned = pruneQuickPickSelections({
            [hugeScope]: { selections: [{ label: 'A', custom: false }], at: 1 },
        });
        assert.deepStrictEqual(pruned, {});
    });

    test('저장소가 없거나 선택이 비어 있으면 조용히 건너뛴다', async () => {
        await rememberQuickPickSelection(
            { actionId: 'a', id: 'pick' },
            [{ label: 'A', custom: false }]
        );
        assert.strictEqual(recallQuickPickSelection({ actionId: 'a', id: 'pick' }), undefined);

        const memory = context();
        initQuickPickMemory(memory.context);
        await rememberQuickPickSelection({ actionId: 'a', id: 'pick' }, []);
        assert.strictEqual(memory.store.size, 0);
    });
});
