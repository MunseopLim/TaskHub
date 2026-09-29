import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    buildHistoryItemAriaLabel,
    createToolHistoryEntry,
    formatRecentRunDetail,
    HistoryEntry,
    HistoryItem,
    HistoryProvider,
} from '../providers/historyProvider';

suite('이전 세션의 실행 기록 복구', () => {
    function createStore(initial: HistoryEntry[]) {
        const data = new Map<string, unknown>([['taskhub.actionHistory', initial]]);
        const writes: HistoryEntry[][] = [];
        const context = {
            workspaceState: {
                get: (key: string, fallback: unknown) => data.has(key) ? data.get(key) : fallback,
                update: async (key: string, value: HistoryEntry[]) => {
                    writes.push(value);
                    data.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        return { context, writes, data };
    }

    function entry(actionId: string, status: HistoryEntry['status']): HistoryEntry {
        return { actionId, actionTitle: actionId, timestamp: 1234, status };
    }

    test('이전 running만 추적 중단으로 복구하며 입력·명령·출력·로그·시각을 보존한다', async () => {
        const legacy: HistoryEntry = {
            ...entry('legacy', 'running'),
            output: 'partial diagnostic output',
            inputs: { mode: { value: 'Debug' } },
            inputTaskTypes: { mode: 'quickPick' },
            commands: { compile: 'node build.cjs' },
            runLog: { workspaceFolderUri: 'file:///workspace', relativePath: '.taskhub/logs/build.log' },
            actionPath: ['Firmware', 'Build'],
        };
        const current: HistoryEntry = { ...entry('current', 'running'), entryType: 'action', durationMs: 12 };
        const finished: HistoryEntry[] = [
            entry('success', 'success'),
            { ...entry('failure', 'failure'), output: 'original failure' },
            { ...entry('stopped', 'cancelled'), cancelKind: 'stopped' },
            { ...entry('prompt', 'cancelled'), cancelKind: 'prompt' },
            createToolHistoryEntry({ kind: 'hexEditor', filePath: '/workspace/app.bin', timestamp: 1000 }),
        ];
        const original = [legacy, current, ...finished];
        const snapshot = structuredClone(original);
        const store = createStore(original);
        const provider = new HistoryProvider(store.context);
        try {
            await provider.recoverInterruptedRuns();
            assert.deepStrictEqual(provider.getHistory(), [
                { ...legacy, status: 'cancelled', cancelKind: 'interrupted' },
                { ...current, status: 'cancelled', cancelKind: 'interrupted' },
                ...finished,
            ]);
            assert.deepStrictEqual(original, snapshot, '복구 전에 읽은 기존 객체를 변경하면 안 된다');
            assert.strictEqual(provider.getHistory()[0].durationMs, undefined, '종료 시각을 임의로 계산하면 안 된다');
            assert.strictEqual(store.writes.length, 1, '한 번의 저장으로 모든 이전 실행을 복구한다');
        } finally {
            provider.dispose();
        }
    });

    test('복구를 영속화하고 다음 활성화에서는 같은 기록을 다시 쓰지 않는다', async () => {
        const store = createStore([entry('build', 'running')]);
        const first = new HistoryProvider(store.context);
        const second = new HistoryProvider(store.context);
        try {
            await first.recoverInterruptedRuns();
            await second.recoverInterruptedRuns();
            assert.strictEqual(second.getHistory()[0].status, 'cancelled');
            assert.strictEqual(second.getHistory()[0].cancelKind, 'interrupted');
            assert.strictEqual(store.writes.length, 1);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    test('일반 조회·refresh·추가 provider 생성은 현재 세션의 실행을 취소하지 않는다', async () => {
        const store = createStore([]);
        const provider = new HistoryProvider(store.context);
        let other: HistoryProvider | undefined;
        try {
            await provider.recoverInterruptedRuns();
            provider.addHistoryEntry(entry('live', 'running'));
            provider.refresh();
            other = new HistoryProvider(store.context);
            assert.strictEqual((await other.getChildren())[0].getEntry().status, 'running');
            assert.strictEqual(provider.getHistory()[0].cancelKind, undefined);
            assert.strictEqual(store.writes.length, 1, '실행 추가 외의 읽기 동작이 상태를 저장하면 안 된다');
        } finally {
            provider.dispose();
            other?.dispose();
        }
    });

    test('빈 기록과 완료 기록만 있으면 workspaceState를 쓰지 않는다', async () => {
        for (const initial of [[], [entry('done', 'success')]]) {
            const store = createStore(initial);
            const provider = new HistoryProvider(store.context);
            try {
                await provider.recoverInterruptedRuns();
                assert.strictEqual(provider.getHistory(), initial);
                assert.strictEqual(store.writes.length, 0);
            } finally {
                provider.dispose();
            }
        }
    });

    test('추적 중단을 Stop이나 실패로 표시하지 않고 KO/EN 상태와 tooltip에서 원인을 알린다', () => {
        const recovered: HistoryEntry = { ...entry('Build', 'cancelled'), cancelKind: 'interrupted' };
        for (const lang of ['ko', 'en'] as const) {
            const detail = formatRecentRunDetail(recovered, recovered.timestamp, lang)!;
            const aria = buildHistoryItemAriaLabel(recovered, 'Build', recovered.timestamp, lang);
            assert.ok(detail.startsWith(lang === 'ko' ? '추적 중단' : 'Interrupted'), detail);
            assert.ok(aria.includes(lang === 'ko' ? '추적 중단' : 'interrupted'), aria);
            assert.ok(!/Stop|stopped|실패|failure/i.test(detail + aria));
        }
        const item = new HistoryItem(recovered);
        assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'circle-slash');
        assert.match(String(item.tooltip), /이전 세션.*실행 결과를 확인할 수 없습니다|previous session ended.*outcome is unknown/);
        assert.strictEqual(item.command, undefined, '복구한 기록을 클릭해 자동 재실행하면 안 된다');
    });

    test('저장 실패 시 이전 기록을 변경하거나 복구 완료 이벤트를 내지 않는다', async () => {
        const original = [entry('build', 'running')];
        const store = createStore(original);
        const failure = new Error('storage unavailable');
        store.context.workspaceState.update = async () => { throw failure; };
        const provider = new HistoryProvider(store.context);
        let refreshed = false;
        const subscription = provider.onDidChangeTreeData(() => { refreshed = true; });
        try {
            await assert.rejects(provider.recoverInterruptedRuns(), error => error === failure);
            assert.strictEqual(provider.getHistory(), original);
            assert.strictEqual(original[0].status, 'running');
            assert.strictEqual(refreshed, false);
        } finally {
            subscription.dispose();
            provider.dispose();
        }
    });

    test('일반 기록 저장의 rejection은 처리하고 같은 장애의 알림은 한 번만 표시한다', async () => {
        const store = createStore([entry('build', 'running')]);
        store.context.workspaceState.update = async () => { throw new Error('storage unavailable'); };
        const provider = new HistoryProvider(store.context);
        const originalWarning = vscode.window.showWarningMessage;
        const warnings: string[] = [];
        (vscode.window as any).showWarningMessage = async (message: string) => { warnings.push(message); };
        try {
            provider.updateHistoryStatus('build', 1234, 'failure');
            provider.setHistoryInputs('build', 1234, { choice: { value: 'Debug' } });
            provider.setHistoryCommands('build', 1234, { build: 'node build.cjs' });
            // update Promise들의 rejection과 경고 처리가 끝난 뒤 결과를 확인한다.
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /실행 기록을 저장하지 못했습니다|Could not save execution history/);
            assert.strictEqual(provider.getHistory()[0].status, 'failure');
        } finally {
            (vscode.window as any).showWarningMessage = originalWarning;
            provider.dispose();
        }
    });
});
