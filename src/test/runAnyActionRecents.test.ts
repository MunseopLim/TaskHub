import * as assert from 'assert';
import { deriveRecentActionRuns, formatRecentRunDetail, HistoryEntry } from '../providers/historyProvider';
import { buildRunAnyActionPaletteItems, buildRunAnyActionPicks, planRunAnyAction } from '../extension';
import { ActionItem } from '../schema';

/**
 * "Run Any Action ↔ History 연동" (0.6.12).
 *
 * 팔레트가 들고 있던 자체 MRU 목록(globalState)을 없애고, 최근 실행을 History
 * 항목에서 유도하도록 바꾼 변경을 고정한다. 핵심 계약은 세 가지다.
 *
 *   1. 어느 경로로 실행했든(트리 클릭 / 단축키 / History 재실행 / 팔레트)
 *      History에 남으므로 팔레트의 "최근 실행"에 동일하게 반영된다.
 *   2. tool 항목(Memory Map / Hex / JSON 뷰어)은 실행 가능한 액션이 아니므로
 *      최근 목록에 섞이지 않는다.
 *   3. 최근 행에는 마지막 실행 시각·소요시간·실패 여부가 detail로 붙는다.
 */

function actionEntry(overrides: Partial<HistoryEntry> & { actionId: string }): HistoryEntry {
    return {
        actionTitle: overrides.actionId,
        timestamp: 1_000,
        status: 'success',
        ...overrides,
    };
}

function toolEntry(actionId: string, timestamp: number): HistoryEntry {
    return {
        entryType: 'tool',
        actionId,
        actionTitle: `Hex Editor: ${actionId}`,
        timestamp,
        status: 'success',
        tool: { kind: 'hexEditor', filePath: `C:/fw/${actionId}.hex`, fileName: `${actionId}.hex` },
    };
}

const sampleActions: ActionItem[] = [
    { id: 'top', title: 'Top Level', type: 'action', action: { description: 'top', tasks: [] } },
    {
        id: 'fw', title: 'Firmware', type: 'folder', children: [
            { id: 'fw.build', title: 'Build', type: 'action', action: { description: 'build', tasks: [] } },
            { id: 'fw.flash', title: 'Flash', type: 'action', action: { description: 'flash', tasks: [] } },
        ]
    },
] as unknown as ActionItem[];

suite('Run Any Action ↔ History 연동', () => {

    suite('deriveRecentActionRuns', () => {
        test('History 순서(최신 우선)를 그대로 최근 실행 순서로 쓴다', () => {
            const history: HistoryEntry[] = [
                actionEntry({ actionId: 'fw.flash', timestamp: 300 }),
                actionEntry({ actionId: 'top', timestamp: 200 }),
                actionEntry({ actionId: 'fw.build', timestamp: 100 }),
            ];

            assert.deepStrictEqual(
                deriveRecentActionRuns(history).map(e => e.actionId),
                ['fw.flash', 'top', 'fw.build']
            );
        });

        test('같은 액션의 반복 실행은 가장 최근 기록 하나로 접힌다', () => {
            const history: HistoryEntry[] = [
                actionEntry({ actionId: 'fw.build', timestamp: 300, durationMs: 30 }),
                actionEntry({ actionId: 'top', timestamp: 200 }),
                actionEntry({ actionId: 'fw.build', timestamp: 100, durationMs: 10 }),
            ];

            const runs = deriveRecentActionRuns(history);
            assert.deepStrictEqual(runs.map(e => e.actionId), ['fw.build', 'top']);
            assert.strictEqual(runs[0].timestamp, 300, '접힌 항목은 최신 실행이어야 detail도 최신이 된다');
            assert.strictEqual(runs[0].durationMs, 30);
        });

        test('tool 항목(Hex/JSON/Memory Map)은 최근 실행에서 제외된다', () => {
            const history: HistoryEntry[] = [
                toolEntry('taskhub.tool.hexEditor:file:C:/fw/app.hex', 300),
                actionEntry({ actionId: 'fw.build', timestamp: 200 }),
            ];

            assert.deepStrictEqual(
                deriveRecentActionRuns(history).map(e => e.actionId),
                ['fw.build']
            );
        });

        test('실행 중(running) 항목도 최근 실행으로 포함한다', () => {
            const history: HistoryEntry[] = [actionEntry({ actionId: 'fw.build', status: 'running' })];
            assert.deepStrictEqual(deriveRecentActionRuns(history).map(e => e.actionId), ['fw.build']);
        });

        test('실패한 실행도 최근 실행으로 포함한다 (성패가 아니라 최근성 기준)', () => {
            const history: HistoryEntry[] = [actionEntry({ actionId: 'fw.build', status: 'failure' })];
            assert.deepStrictEqual(deriveRecentActionRuns(history).map(e => e.actionId), ['fw.build']);
        });

        test('actionId가 없는 손상된 항목은 건너뛴다', () => {
            const history = [
                { actionTitle: 'broken', timestamp: 1, status: 'success' } as HistoryEntry,
                actionEntry({ actionId: 'top', timestamp: 2 }),
            ];
            assert.deepStrictEqual(deriveRecentActionRuns(history).map(e => e.actionId), ['top']);
        });

        test('빈 History면 빈 배열', () => {
            assert.deepStrictEqual(deriveRecentActionRuns([]), []);
        });
    });

    suite('formatRecentRunDetail', () => {
        // 2026-07-26 14:30 로컬 시각 — 같은 날이면 "HH:MM" 형식이 된다.
        const at1430 = new Date(2026, 6, 26, 14, 30).getTime();
        const at1500 = new Date(2026, 6, 26, 15, 0).getTime();

        test('성공은 시각 + 소요시간만 표시한다', () => {
            const detail = formatRecentRunDetail(
                actionEntry({ actionId: 'a', timestamp: at1430, durationMs: 1200 }), at1500, 'ko');
            assert.strictEqual(detail, '14:30 · 1.2s');
        });

        test('실패는 상태를 글자로 앞에 붙인다 (팔레트 행에는 상태 아이콘이 없다)', () => {
            const ko = formatRecentRunDetail(
                actionEntry({ actionId: 'a', timestamp: at1430, durationMs: 1200, status: 'failure' }), at1500, 'ko');
            const en = formatRecentRunDetail(
                actionEntry({ actionId: 'a', timestamp: at1430, durationMs: 1200, status: 'failure' }), at1500, 'en');
            assert.strictEqual(ko, '실패 · 14:30 · 1.2s');
            assert.strictEqual(en, 'Failed · 14:30 · 1.2s');
        });

        test('실행 중은 시각 대신 진행 상태를 표시한다', () => {
            assert.strictEqual(
                formatRecentRunDetail(actionEntry({ actionId: 'a', status: 'running' }), at1500, 'ko'), '실행 중');
            assert.strictEqual(
                formatRecentRunDetail(actionEntry({ actionId: 'a', status: 'running' }), at1500, 'en'), 'Running');
        });

        test('durationMs가 없는 예전 항목은 시각만 표시한다', () => {
            assert.strictEqual(
                formatRecentRunDetail(actionEntry({ actionId: 'a', timestamp: at1430 }), at1500, 'ko'), '14:30');
        });

        test('항목이 없으면 undefined', () => {
            assert.strictEqual(formatRecentRunDetail(undefined, at1500, 'ko'), undefined);
        });
    });

    suite('팔레트 조립', () => {
        test('detail은 recent 행에만 붙고 rest 행에는 붙지 않는다', () => {
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['fw.build'], 5);
            const items = buildRunAnyActionPaletteItems(
                recent, rest,
                { recent: 'Recently used', rest: 'All actions' },
                new Map([['fw.build', '14:30 · 1.2s'], ['top', '어제 09:00']])
            );

            const recentRow = items.find(i => i.kind === 'pick' && i.section === 'recent');
            const restRow = items.find(i => i.kind === 'pick' && i.section === 'rest' && i.actionId === 'top');
            assert.strictEqual(recentRow?.detail, '14:30 · 1.2s');
            assert.strictEqual(restRow?.detail, undefined,
                'rest 섹션에 detail이 붙으면 같은 액션이 두 줄로 중복 표시되는 것처럼 보인다');
        });

        test('detail 맵이 없어도 조립된다 (badge 없는 순수 경로)', () => {
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['top'], 5);
            const items = buildRunAnyActionPaletteItems(recent, rest, { recent: 'R', rest: 'A' });
            const recentRow = items.find(i => i.kind === 'pick' && i.section === 'recent');
            assert.strictEqual(recentRow?.actionId, 'top');
            assert.strictEqual(recentRow?.detail, undefined);
        });

        test('description(폴더 경로)은 detail과 별개로 유지된다 — matchOnDescription 오염 방지', () => {
            const { recent, rest } = buildRunAnyActionPicks(sampleActions, ['fw.build'], 5);
            const items = buildRunAnyActionPaletteItems(
                recent, rest,
                { recent: 'R', rest: 'A' },
                new Map([['fw.build', '3분 전']])
            );
            const recentRow = items.find(i => i.kind === 'pick' && i.section === 'recent');
            assert.strictEqual(recentRow?.description, 'Firmware', '폴더 경로가 detail로 대체되면 검색이 깨진다');
            assert.strictEqual(recentRow?.detail, '3분 전');
        });
    });

    suite('History → 팔레트 종단 경로', () => {
        function planFromHistory(history: HistoryEntry[], limit = 5) {
            const runs = deriveRecentActionRuns(history);
            const details = new Map<string, string>();
            for (const run of runs) {
                const detail = formatRecentRunDetail(run, Date.now(), 'ko');
                if (detail) { details.set(run.actionId, detail); }
            }
            return planRunAnyAction(
                () => sampleActions,
                runs.map(r => r.actionId),
                limit,
                { recent: 'Recently used', rest: 'All actions' },
                details
            );
        }

        test('트리/단축키 실행이 남긴 History가 그대로 최근 실행 순서가 된다', () => {
            // 팔레트를 한 번도 쓰지 않은 사용자의 History — 예전 MRU 구조라면
            // 이 목록이 비어 있었다.
            const outcome = planFromHistory([
                actionEntry({ actionId: 'fw.flash', timestamp: 300 }),
                actionEntry({ actionId: 'top', timestamp: 200 }),
            ]);

            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind !== 'show-palette') { return; }
            assert.deepStrictEqual(outcome.recentIds, ['fw.flash', 'top']);
            const recentRows = outcome.items.filter(i => i.kind === 'pick' && i.section === 'recent');
            assert.strictEqual(recentRows.length, 2);
            assert.ok(recentRows.every(r => typeof r.detail === 'string' && r.detail.length > 0),
                '최근 행에는 마지막 실행 정보가 붙어야 한다');
        });

        test('삭제된 액션의 History 항목은 최근 실행에서 조용히 빠진다', () => {
            const outcome = planFromHistory([
                actionEntry({ actionId: 'deleted.action', timestamp: 300 }),
                actionEntry({ actionId: 'top', timestamp: 200 }),
            ]);

            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind !== 'show-palette') { return; }
            assert.deepStrictEqual(outcome.recentIds, ['top']);
        });

        test('recentLimit=0이면 History가 있어도 최근 섹션이 사라진다', () => {
            const outcome = planFromHistory([actionEntry({ actionId: 'top', timestamp: 300 })], 0);

            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind !== 'show-palette') { return; }
            assert.deepStrictEqual(outcome.recentIds, []);
            assert.strictEqual(outcome.items.some(i => i.section === 'recent'), false);
        });

        test('History가 비어 있으면 모든 액션만 표시된다', () => {
            const outcome = planFromHistory([]);

            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind !== 'show-palette') { return; }
            assert.deepStrictEqual(outcome.recentIds, []);
            assert.deepStrictEqual(
                outcome.items.filter(i => i.kind === 'pick').map(i => i.actionId),
                ['top', 'fw.build', 'fw.flash']
            );
        });

        test('tool 기록만 있는 History도 최근 섹션을 만들지 않는다', () => {
            const outcome = planFromHistory([toolEntry('taskhub.tool.jsonEditor:file:C:/a.json', 300)]);

            assert.strictEqual(outcome.kind, 'show-palette');
            if (outcome.kind !== 'show-palette') { return; }
            assert.deepStrictEqual(outcome.recentIds, []);
        });
    });
});
