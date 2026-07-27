import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildMemoryMapStrings, openMemoryMapPanel, panelRegistry } from '../memoryMapViewer';
import { buildMinimalElf32 } from './fixtures/elfFixtures';

/**
 * "Memory Map 웹뷰 지역화 / 접근성" (0.6.21) — 웹뷰 3종의 마지막.
 *
 * 여기서 갈린 결정: **리포트 본문은 영어로 유지한다.** *Copy Report* /
 * *Copy Full Dump* 산출물은 이슈·커밋 메시지·문서에 붙여 남과 공유하는
 * 물건이라, 편집기 언어를 따라가는 것보다 문구가 안정적인 편이 낫다.
 * 지역화 대상은 그것을 둘러싼 UI(버튼·헤더·열 이름·검색)뿐이다.
 *
 * 접근성 쪽 핵심은 정렬이었다. 열 머리글 정렬이 클릭 전용이었고
 * `aria-sort`가 없어, 스크린리더는 어떤 열로 어떤 방향 정렬됐는지 알 수
 * 없었다(▲/▼ 글리프는 읽히지 않는다).
 */


suite('Memory Map 웹뷰 지역화 / 접근성', () => {
    const strings = buildMemoryMapStrings();
    let filePath: string;
    let html: string;

    suiteSetup(() => {
        panelRegistry.clear();
        filePath = path.join(os.tmpdir(), `taskhub-mm-a11y-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildMinimalElf32());
        const ctx = { extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [] } as unknown as vscode.ExtensionContext;
        // 영역 설정을 함께 준다: region이 없으면 사용량 막대 / 영역 카드 /
        // 모두 펼치기 버튼이 아예 렌더되지 않아 그 경로를 검사할 수 없다.
        const config = { regions: [{ name: 'FLASH', origin: 0x08000000, size: 512 * 1024 }] };
        assert.ok(openMemoryMapPanel(ctx, filePath, config), '패널이 열려야 HTML을 검사할 수 있다');
        html = panelRegistry.getHtml(filePath) ?? '';
        assert.ok(html.length > 0, '웹뷰 HTML이 비어 있다');
    });

    suiteTeardown(() => {
        panelRegistry.clear();
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    });

    suite('문자열 번들', () => {
        test('빈 문자열 없이 모든 키가 채워져 있다', () => {
            const empty = Object.entries(strings).filter(([, value]) => !value || !value.trim());
            assert.deepStrictEqual(empty, [], `비어 있는 문자열: ${empty.map(([k]) => k).join(', ')}`);
        });

        test('사용률 라벨의 플레이스홀더가 유지된다', () => {
            for (const token of ['{region}', '{percent}', '{used}', '{total}']) {
                assert.ok(strings.usageBarLabel.includes(token), `${token}이 없다: ${strings.usageBarLabel}`);
            }
        });

        test('웹뷰가 참조하는 S.* 키가 모두 번들에 있다', () => {
            const referenced = new Set(
                Array.from(html.matchAll(/\bS\.([A-Za-z][A-Za-z0-9]*)/g)).map(m => m[1])
            );
            assert.ok(referenced.size > 0, 'S.* 참조를 찾지 못했다');
            for (const key of referenced) {
                assert.ok(key in strings, `웹뷰가 참조하는 S.${key}가 번들에 없다`);
            }
        });
    });

    suite('지역화 범위', () => {
        test('UI 문자열은 번들을 쓴다', () => {
            assert.ok(html.includes(strings.copyReport), 'Copy Report 버튼');
            assert.ok(html.includes(strings.saveHtml), 'Save HTML 버튼');
            assert.ok(html.includes(strings.allSections), 'All Sections 제목');
            assert.ok(html.includes(strings.entryPoint), 'Entry Point 라벨');
        });

        test('한국어로 하드코딩돼 있던 문자열이 남아 있지 않다', () => {
            // 이전에는 ↑ 버튼 title이 '맨 위로'로 고정돼 영어 사용자에게도
            // 한국어가 보였다 — 반대 방향의 같은 결함.
            assert.ok(!html.includes('title="맨 위로"'), '하드코딩된 한국어 title이 남아 있다');
        });

        test('lang 속성이 en으로 고정돼 있지 않다', () => {
            const match = html.match(/<html lang="([^"]+)"/);
            assert.ok(match && ['ko', 'en'].includes(match[1]), `예상 밖의 lang: ${match?.[1]}`);
        });

        test('리포트 본문은 영어로 유지된다 (공유 산출물)', () => {
            // 리포트는 JSON 문자열 리터럴로 주입되므로 HTML 안에 그대로 있다.
            assert.ok(/Memory Map Report|SECTION|Section/.test(html),
                '리포트 본문이 사라졌거나 형태가 바뀌었다');
        });
    });

    suite('접근성', () => {
        test('정렬 가능한 열 머리글이 aria-sort와 키보드 포커스를 갖는다', () => {
            const headers = Array.from(html.matchAll(/<th[^>]*data-sort="[^"]*"[^>]*>/g)).map(m => m[0]);
            assert.ok(headers.length > 0, '정렬 머리글을 찾지 못했다');

            const sectionTableHeaders = headers.filter(h => h.includes('aria-sort'));
            assert.ok(sectionTableHeaders.length >= 6,
                `All Sections 표의 머리글에 aria-sort가 없다: ${headers.slice(0, 3).join(' ')}`);
            for (const header of sectionTableHeaders) {
                assert.ok(header.includes('tabindex="0"'),
                    `키보드로 정렬할 수 없다: ${header}`);
            }
        });

        test('Enter/Space로 정렬을 실행하는 처리기가 있다', () => {
            assert.ok(/keydown[\s\S]{0,200}th\.click\(\)/.test(html),
                '머리글 키보드 활성화 처리가 없다');
        });

        test('정렬 시 aria-sort가 갱신된다', () => {
            assert.ok(html.includes("setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending')"),
                '▲/▼ 글리프는 스크린리더에 읽히지 않으므로 aria-sort 갱신이 필요하다');
            assert.ok(html.includes("setAttribute('aria-sort', 'none')"), '다른 열의 정렬 상태를 해제해야 한다');
        });

        test('검색 결과 개수가 live region이다', () => {
            const count = html.match(/<span id="searchCount"[^>]*>/);
            assert.ok(count, 'searchCount 요소가 없다');
            assert.ok(count![0].includes('aria-live="polite"'), count![0]);
        });

        test('아이콘 전용 버튼에 aria-label이 있다', () => {
            for (const id of ['searchPrev', 'searchNext', 'scrollTop']) {
                const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
                assert.ok(button, `${id} 버튼을 찾지 못했다`);
                assert.ok(/aria-label="[^"]+"/.test(button![0]), `${id}에 aria-label이 없다: ${button![0]}`);
            }
        });

        test('모두 펼치기 버튼이 aria-expanded 상태를 갖는다', () => {
            const toggle = html.match(/<button[^>]*id="toggleAllBtn"[^>]*>/);
            assert.ok(toggle, 'toggleAllBtn을 찾지 못했다');
            assert.ok(toggle![0].includes('aria-expanded'), toggle![0]);
            assert.ok(html.includes("setAttribute('aria-expanded', 'true')"), '펼침 시 상태 갱신이 없다');
        });

        test('검색 입력에 접근 가능한 이름이 있다', () => {
            const input = html.match(/<input id="searchInput"[^>]*>/);
            assert.ok(/aria-label="[^"]+"/.test(input![0]), input![0]);
        });

        test('사용량 막대는 장식으로 처리된다 (수치는 이미 텍스트로 존재)', () => {
            assert.ok(html.includes('class="bar-bg" aria-hidden="true"'),
                '같은 수치를 두 번 읽히게 하면 표 탐색만 길어진다');
        });
    });

    /**
     * 0.6.21이 남긴 클릭 전용 인터랙션 (0.6.31에서 처리).
     *
     * 0.6.21은 정적 All Sections 표의 정렬만 키보드로 열었다. 정작 사용자가
     * 오래 머무는 **region 카드**는 펼치는 것부터 마우스 전용이었다 —
     * `<div class="region-header">`는 Tab이 닿지 않고 Enter/Space도 먹지 않아,
     * 마우스 없이는 영역 상세를 볼 방법이 아예 없었다.
     */
    suite('접힘 헤더와 동적 표 (0.6.31)', () => {

        test('region 헤더가 포커스를 받고 버튼으로 노출된다', () => {
            const header = html.match(/<div class="region-header"[^>]*>/);
            assert.ok(header, 'region-header를 찾지 못했다 — 픽스처가 영역 카드를 렌더하지 않았다');
            assert.ok(header![0].includes('tabindex="0"'), `Tab이 닿지 않는다: ${header![0]}`);
            assert.ok(header![0].includes('role="button"'), `역할이 없어 무엇인지 알 수 없다: ${header![0]}`);
            assert.ok(header![0].includes('aria-expanded'), `펼침 상태를 알 수 없다: ${header![0]}`);
        });

        test('펼침 글리프는 장식으로 처리된다', () => {
            // ▶/▼는 스크린리더에 아무 의미도 전달하지 않는다. 상태는
            // aria-expanded가 담당하므로 글리프를 읽히면 잡음만 된다.
            assert.ok(
                /<span class="fold-icon" aria-hidden="true">/.test(html),
                'fold-icon이 aria-hidden이 아니다'
            );
        });

        test('키보드 활성화 경로가 클릭 위임과 나란히 존재한다', () => {
            assert.ok(
                /addEventListener\('keydown'[\s\S]{0,400}data-action/.test(html),
                "data-action 요소에 keydown 경로가 없다 — role=button만 붙이면 포커스는 가지만 눌리지 않는다"
            );
        });

        test('진짜 button은 키보드 위임에서 제외된다 (이중 실행 방지)', () => {
            // 브라우저가 <button>의 Enter/Space에 click을 합성하므로, 위임에서
            // 또 처리하면 토글이 두 번 일어나 아무 일도 안 한 것처럼 보인다.
            assert.ok(
                html.includes("tagName === 'BUTTON'"),
                'button 제외 가드가 없다'
            );
        });

        test('동적 표 머리글이 정렬 가능한 열로 노출된다', () => {
            // 이 표들은 웹뷰 스크립트가 실행 시 조립하므로 렌더된 DOM을 볼 수
            // 없다. 조립하는 헬퍼가 필요한 속성을 붙이는지를 대신 고정한다.
            const helper = html.match(/function sortTh\(sortKey, label, opts\)[\s\S]{0,400}?\n    \}/);
            assert.ok(helper, 'sortTh 헬퍼를 찾지 못했다');
            for (const attr of ['tabindex="0"', 'role="columnheader"', 'aria-sort="none"', 'scope="col"']) {
                assert.ok(helper![0].includes(attr), `${attr}가 없다: ${helper![0]}`);
            }
        });

        test('정렬 불가 머리글에는 tabindex를 주지 않는다', () => {
            const helper = html.match(/function plainTh\(label, cls\)[\s\S]{0,200}?\n    \}/);
            assert.ok(helper, 'plainTh 헬퍼를 찾지 못했다');
            assert.ok(
                !helper![0].includes('tabindex'),
                '눌러도 아무 일이 없는 열에 포커스를 주면 혼란만 준다'
            );
        });

        test('region 표 정렬이 aria-sort를 갱신하고 키보드로도 동작한다', () => {
            assert.ok(
                /function sortRegionTable\(th\)/.test(html),
                '정렬 로직이 함수로 분리되지 않으면 클릭과 키보드가 같은 경로를 쓸 수 없다'
            );
            assert.ok(
                /addEventListener\('keydown'[\s\S]{0,300}section-table th\[data-sort\]/.test(html),
                'region 표 정렬에 키보드 경로가 없다'
            );
            assert.ok(
                /setAttribute\('aria-sort', asc \? 'ascending' : 'descending'\)/.test(html),
                '정렬 방향이 aria-sort로 노출되지 않는다'
            );
            assert.ok(
                /h\.setAttribute\('aria-sort', 'none'\)/.test(html),
                '이전 기준 열을 none으로 되돌리지 않으면 두 열이 정렬된 것으로 안내된다'
            );
        });
    });
});
