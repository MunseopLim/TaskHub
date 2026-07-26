import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    StopAllActionsDeps,
    StopAllOutcome,
    collectRunningActionIds,
    formatStopAllConfirmMessage,
    runStopAllActions,
    STOP_ALL_CONFIRM_TITLE_LIMIT,
} from '../extension';
import { ActionProgress, ActionRunState } from '../providers/actionStatus';

/**
 * "실행 중지 / 터미널 닫기 분리" (0.6.13).
 *
 * 제목 표시줄의 종료 버튼이 실행 중이 아닐 때도 항상 보이고, 누르면 액션 중지와
 * 터미널 닫기를 한꺼번에 수행하던 동작을 갈랐다. 고정할 계약:
 *
 *   1. `taskhub.hasRunningActions` context key의 근거가 되는 실행 목록 계산
 *   2. 2개 이상 중지 시 대상 이름·개수를 보여주는 확인 문구
 *   3. manifest에서 버튼이 실제로 조건부로 노출되는지 (when 절 회귀 방지)
 */

type StateMap = Map<string, { state: ActionRunState; progress?: ActionProgress }>;

function states(entries: Array<[string, ActionRunState]>): StateMap {
    return new Map(entries.map(([id, state]) => [id, { state }]));
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
function readManifest(): any {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
}

suite('실행 중지 / 터미널 닫기', () => {

    suite('collectRunningActionIds', () => {
        test('running 상태만 골라낸다', () => {
            const map = states([
                ['fw.build', 'running'],
                ['fw.flash', 'success'],
                ['top', 'failure'],
                ['fw.test', 'running'],
            ]);
            assert.deepStrictEqual(collectRunningActionIds(map), ['fw.build', 'fw.test']);
        });

        test('완료된 액션만 남아 있으면 빈 배열 — 버튼이 숨는 조건', () => {
            const map = states([['fw.build', 'success'], ['top', 'failure']]);
            assert.deepStrictEqual(collectRunningActionIds(map), []);
        });

        test('상태 맵이 비어 있으면 빈 배열', () => {
            assert.deepStrictEqual(collectRunningActionIds(new Map()), []);
        });

        test('progress가 붙어 있어도 running 판정에는 영향이 없다', () => {
            const map: StateMap = new Map([
                ['fw.build', { state: 'running' as ActionRunState, progress: { total: 3, completed: 1, running: [{ taskId: 'a', index: 2 }] } }],
            ]);
            assert.deepStrictEqual(collectRunningActionIds(map), ['fw.build']);
        });
    });

    suite('formatStopAllConfirmMessage', () => {
        test('대상 개수와 이름을 함께 보여준다', () => {
            const message = formatStopAllConfirmMessage(['Build', 'Flash'], 'ko');
            assert.ok(message.startsWith('실행 중인 액션 2개를 중지할까요?'), message);
            assert.ok(message.includes('· Build'), message);
            assert.ok(message.includes('· Flash'), message);
        });

        test('영어 로케일', () => {
            const message = formatStopAllConfirmMessage(['Build', 'Flash'], 'en');
            assert.ok(message.startsWith('Stop 2 running action(s)?'), message);
        });

        test(`${STOP_ALL_CONFIRM_TITLE_LIMIT}개를 넘으면 나머지는 개수로 접는다 (modal이 화면을 넘지 않도록)`, () => {
            const titles = Array.from({ length: STOP_ALL_CONFIRM_TITLE_LIMIT + 3 }, (_, i) => `Action ${i}`);
            const ko = formatStopAllConfirmMessage(titles, 'ko');
            const en = formatStopAllConfirmMessage(titles, 'en');

            const listedKo = ko.split('\n').filter(line => line.startsWith('· '));
            assert.strictEqual(listedKo.length, STOP_ALL_CONFIRM_TITLE_LIMIT + 1, '나열 5줄 + 요약 1줄');
            assert.ok(ko.includes('· 외 3개'), ko);
            assert.ok(en.includes('· and 3 more'), en);
            assert.ok(ko.startsWith(`실행 중인 액션 ${titles.length}개를 중지할까요?`), '헤더 개수는 접기 전 전체 개수');
        });

        test('정확히 한계치면 접지 않는다', () => {
            const titles = Array.from({ length: STOP_ALL_CONFIRM_TITLE_LIMIT }, (_, i) => `Action ${i}`);
            const message = formatStopAllConfirmMessage(titles, 'ko');
            assert.ok(!message.includes('외 '), message);
        });
    });

    suite('runStopAllActions 오케스트레이션 (0.6.22)', () => {
        /**
         * 0.6.13 회귀: 일괄 중지가 terminate() 직후 `manuallyTerminatedActions`
         * 플래그를 동기적으로 지웠다. 태스크 종료는 비동기로 도착하므로
         * `executeAction`의 catch가 플래그를 못 보고 사용자 요청 중지를 일반
         * 실패로 처리했다 — 불필요한 실패 토스트, "Action stopped by user"
         * 기록 덮어쓰기, ✗ 아이콘 잔존.
         *
         * 수정은 삭제 한 줄을 빼는 데 그치지 않고, 오케스트레이터의 의존성
         * 표면에서 플래그 조작 자체를 없앴다. 아래 fake deps가 그 계약을
         * 그대로 반영한다 — 플래그를 건드릴 방법이 없다.
         */
        interface Recorder {
            deps: StopAllActionsDeps;
            stopped: string[];
            recorded: string[];
            reports: Array<{ outcome: StopAllOutcome; titles: string[] }>;
            confirmCalls: string[][];
            afterStopCalls: number;
        }

        function makeDeps(options: {
            targets: string[];
            confirm?: boolean;
            stoppable?: (id: string) => boolean;
        }): Recorder {
            const stopped: string[] = [];
            const recorded: string[] = [];
            const reports: Array<{ outcome: StopAllOutcome; titles: string[] }> = [];
            const confirmCalls: string[][] = [];
            let afterStopCalls = 0;
            const deps: StopAllActionsDeps = {
                collectTargets: () => options.targets,
                titleOf: (id) => `Title(${id})`,
                confirm: async (titles) => {
                    confirmCalls.push(titles);
                    return options.confirm !== false;
                },
                stop: (id) => {
                    const ok = options.stoppable ? options.stoppable(id) : true;
                    if (ok) { stopped.push(id); }
                    return ok;
                },
                recordStop: (id) => { recorded.push(id); },
                afterStop: () => { afterStopCalls += 1; },
                report: (outcome, titles) => { reports.push({ outcome, titles }); },
            };
            return {
                deps, stopped, recorded, reports, confirmCalls,
                get afterStopCalls() { return afterStopCalls; },
            } as Recorder;
        }

        test('대상이 없으면 none — 확인 창도 띄우지 않는다', async () => {
            const rec = makeDeps({ targets: [] });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'none');
            assert.deepStrictEqual(rec.confirmCalls, []);
            assert.deepStrictEqual(rec.stopped, []);
            assert.deepStrictEqual(rec.reports, [{ outcome: 'none', titles: [] }]);
        });

        test('대상이 하나면 확인 없이 곧바로 중지한다', async () => {
            const rec = makeDeps({ targets: ['fw.build'] });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'stopped');
            assert.deepStrictEqual(rec.confirmCalls, [], '한 개짜리에 modal은 과하다');
            assert.deepStrictEqual(rec.stopped, ['fw.build']);
            assert.deepStrictEqual(rec.recorded, ['fw.build'], '히스토리를 마감해야 한다');
            assert.deepStrictEqual(rec.reports[0], { outcome: 'stopped', titles: ['Title(fw.build)'] });
        });

        test('둘 이상이면 대상 이름을 담아 확인을 받는다', async () => {
            const rec = makeDeps({ targets: ['a', 'b', 'c'] });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'stopped');
            assert.deepStrictEqual(rec.confirmCalls, [['Title(a)', 'Title(b)', 'Title(c)']]);
            assert.deepStrictEqual(rec.stopped, ['a', 'b', 'c']);
        });

        test('확인을 취소하면 아무것도 중지하지 않는다', async () => {
            const rec = makeDeps({ targets: ['a', 'b'], confirm: false });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'cancelled');
            assert.deepStrictEqual(rec.stopped, [], '취소인데 하나라도 죽으면 최악이다');
            assert.deepStrictEqual(rec.recorded, []);
            assert.strictEqual(rec.afterStopCalls, 0, '취소 시에는 트리를 건드릴 이유가 없다');
        });

        test('취소 결과를 호출자에게 돌려준다 (호환 명령이 터미널을 살려 두는 근거)', async () => {
            const rec = makeDeps({ targets: ['a', 'b'], confirm: false });
            assert.strictEqual(await runStopAllActions(rec.deps), 'cancelled');
        });

        test('대상은 있었지만 하나도 못 멈추면 failed', async () => {
            const rec = makeDeps({ targets: ['a', 'b'], stoppable: () => false });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'failed');
            assert.deepStrictEqual(rec.recorded, [], '멈추지 못한 액션의 히스토리를 마감하면 거짓 기록이 된다');
            assert.strictEqual(rec.reports[0].outcome, 'failed');
        });

        test('일부만 멈춘 경우 멈춘 것만 기록하고 stopped로 보고한다', async () => {
            const rec = makeDeps({ targets: ['a', 'b', 'c'], stoppable: (id) => id !== 'b' });
            const outcome = await runStopAllActions(rec.deps);

            assert.strictEqual(outcome, 'stopped');
            assert.deepStrictEqual(rec.stopped, ['a', 'c']);
            assert.deepStrictEqual(rec.recorded, ['a', 'c']);
        });

        test('중지 후 트리/컨텍스트 갱신을 정확히 한 번 호출한다', async () => {
            const rec = makeDeps({ targets: ['a', 'b'] });
            await runStopAllActions(rec.deps);
            assert.strictEqual(rec.afterStopCalls, 1);
        });

        test('의존성 표면에 플래그를 지우는 수단이 없다 (회귀 봉쇄)', () => {
            const rec = makeDeps({ targets: [] });
            const surface = Object.keys(rec.deps).sort();
            assert.deepStrictEqual(surface, [
                'afterStop', 'collectTargets', 'confirm', 'recordStop', 'report', 'stop', 'titleOf',
            ], '오케스트레이터가 만질 수 있는 것이 늘어나면 0.6.13 회귀가 다시 가능해진다');
        });
    });

    suite('manifest 노출 조건', () => {
        test('Stop All Actions 버튼은 실행 중일 때만 제목 표시줄에 뜬다', () => {
            const entries = readManifest().contributes.menus['view/title']
                .filter((e: any) => e.command === 'taskhub.stopAllActions');
            assert.strictEqual(entries.length, 1);
            assert.ok(
                entries[0].when.includes('taskhub.hasRunningActions'),
                `조건 없는 노출로 회귀했다: ${entries[0].when}`
            );
        });

        test('터미널 닫기는 navigation 그룹(아이콘 줄)이 아니라 오버플로 메뉴에 있다', () => {
            const entries = readManifest().contributes.menus['view/title']
                .filter((e: any) => e.command === 'taskhub.closeAllTerminals');
            assert.strictEqual(entries.length, 1);
            assert.ok(
                !String(entries[0].group).startsWith('navigation'),
                '제목 표시줄 아이콘 수를 늘리지 않기로 한 결정을 고정'
            );
        });

        test('구 terminateAllActions는 메뉴에서 빠지고 팔레트에서도 숨겨진다 (호환용 등록만 유지)', () => {
            const manifest = readManifest();
            const inTitle = manifest.contributes.menus['view/title']
                .filter((e: any) => e.command === 'taskhub.terminateAllActions');
            assert.deepStrictEqual(inTitle, [], '제목 표시줄에서 제거되어야 한다');

            const hidden = manifest.contributes.menus.commandPalette
                .find((e: any) => e.command === 'taskhub.terminateAllActions');
            assert.strictEqual(hidden?.when, 'false', '팔레트에서 숨겨야 두 신규 명령과 헷갈리지 않는다');

            const declared = manifest.contributes.commands
                .find((c: any) => c.command === 'taskhub.terminateAllActions');
            assert.ok(declared, '기존 keybindings.json이 깨지지 않도록 명령 자체는 남긴다');
        });

        test('신규 두 명령이 모두 선언되어 있다', () => {
            const commands = readManifest().contributes.commands.map((c: any) => c.command);
            assert.ok(commands.includes('taskhub.stopAllActions'));
            assert.ok(commands.includes('taskhub.closeAllTerminals'));
        });
    });
});
