import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { openMemoryMapPanel, panelRegistry } from '../memoryMapViewer';
import { buildElf32WithSymbols } from './fixtures/elfFixtures';

/**
 * Object Summary 정렬 (0.6.34).
 *
 * 재현: Expand All → region의 Object Summary 펼치기 → *Details* 토글로 section
 * 행까지 표시 → Size / Bytes / Percent 정렬. 원인이 둘이었다.
 *
 * **1. 부모만 이동하고 section 행은 제자리에 남았다.** 정렬기가
 * `tr:not(.obj-detail-row)`로 부모 행만 골라 재배치했다. Details가 열려 있으면
 * 묶음이 통째로 어긋나 "정렬이 안 된 것"처럼 보인다. `toggleObjDetailRows`는
 * display만 뒤집고 재렌더하지 않으므로 토글로도 복구되지 않는다.
 *
 * **2. colspan 때문에 헤더 순번과 셀 순번이 어긋났다.** 부모 행은
 * colspan=2 탓에 <td>가 헤더보다 하나 적은데, 정렬기는 헤더 index를
 * `row.children[]`에 그대로 썼다. 결과적으로 Size와 Bytes는 Percent 셀을,
 * Percent는 mini-bar의 빈 텍스트를 읽었다.
 *
 * 증상이 열마다 달랐다는 점이 이 결함이 오래 숨은 이유다.
 *
 *   - Percent: 빈 문자열끼리 비교 → 항상 0 → **아무것도 움직이지 않는다.**
 *   - Size / Bytes: 퍼센트가 같은 region 안에서 bytes에 비례하므로 방향은
 *     대체로 맞아 보인다. 그러나 화면용 퍼센트는 `toFixed(1)`로 반올림돼
 *     크기가 가까운 객체가 동률이 되고, `Array.sort`가 안정 정렬이라 그
 *     구간에는 **직전 정렬 순서가 그대로 남는다**. 처음 열었을 때는 목록이
 *     이미 크기 내림차순으로 렌더돼 있어(regionObjSummary의 사전 정렬)
 *     정확해 보이지만, Name으로 한 번 정렬한 뒤 Size를 누르면 동률 구간에
 *     Name 순서가 남아 크기 순서가 깨진다.
 *
 * 정렬 로직은 웹뷰 스크립트 안에서 실행되므로 확장 호스트 테스트에서 DOM을
 * 돌려볼 수 없다. 아래 검사는 (a) 정렬에 쓰이는 **데이터**가 반올림 전 값인지,
 * (b) 스크립트가 그 값을 쓰고 그룹 단위로 재배치하는지를 각각 고정한다.
 */
suite('Object Summary 정렬', () => {

    let filePath: string;
    let html: string;

    suiteSetup(() => {
        panelRegistry.clear();
        filePath = path.join(os.tmpdir(), `taskhub-objsort-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildElf32WithSymbols());
        const ctx = {
            extensionPath: path.resolve(__dirname, '..', '..'),
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapPanel(ctx, filePath, {
            regions: [
                { name: 'FLASH', origin: 0x08000000, size: 512 * 1024 },
                { name: 'RAM', origin: 0x20000000, size: 128 * 1024 },
            ],
        }), '패널이 열려야 검사할 수 있다');
        html = panelRegistry.getHtml(filePath) ?? '';
    });

    suiteTeardown(() => {
        panelRegistry.clear();
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    });

    /** 웹뷰에 주입된 region 데이터에서 objSummary 항목들을 뽑는다. */
    function objectSummaries(): Array<{ n: string; ts: number; p: string; pv: number }> {
        const found: Array<{ n: string; ts: number; p: string; pv: number }> = [];
        for (const match of html.matchAll(/\{"n":"[^"]*","ts":\d+,"tss":"[^"]*","p":"[^"]*","pv":[0-9.eE+-]+/g)) {
            found.push(JSON.parse(match[0] + '}'));
        }
        return found;
    }

    suite('정렬에 쓰는 값', () => {
        test('전제: 픽스처가 Object Summary를 렌더한다', () => {
            assert.ok(html.includes('"hmo":true'),
                'objSummary가 2개 미만이면 표 자체가 그려지지 않아 이 검사가 무의미해진다');
            assert.ok(objectSummaries().length > 0, 'objSummary 항목을 찾지 못했다');
        });

        test('반올림 전 퍼센트(pv)를 함께 싣는다', () => {
            for (const o of objectSummaries()) {
                assert.strictEqual(typeof o.pv, 'number', `${o.n}: pv가 숫자가 아니다`);
                assert.strictEqual(
                    o.pv.toFixed(1),
                    o.p,
                    `${o.n}: 표시값 p가 pv의 1자리 반올림이어야 한다 (p=${o.p}, pv=${o.pv})`
                );
            }
        });

        test('pv는 표시값보다 정밀하다 (반올림된 값을 정렬하면 동률이 생긴다)', () => {
            const summaries = objectSummaries();
            assert.ok(
                summaries.some(o => o.pv !== Number(o.p)),
                `모든 pv가 표시값과 같으면 pv를 따로 둘 이유가 없다: ${JSON.stringify(summaries.map(o => [o.p, o.pv]))}`
            );
        });
    });

    suite('부모 행이 원본 값을 들고 있다', () => {
        test('세 정렬 키가 모두 행 속성으로 실린다', () => {
            for (const attr of ['data-sort-name=', 'data-sort-bytes=', 'data-sort-pct=']) {
                assert.ok(html.includes(attr), `${attr}가 없다 — colspan 어긋남을 피할 수단이 사라진다`);
            }
        });

        test('표시값이 아니라 원본 값을 싣는다', () => {
            // `o.tss`("352 B")나 `o.p`("27.5")를 실으면 정렬이 다시 부정확해진다.
            assert.ok(/data-sort-bytes="' \+ o\.ts\b/.test(html), 'bytes가 원본 숫자(o.ts)가 아니다');
            assert.ok(/data-sort-pct="' \+ o\.pv\b/.test(html), 'pct가 반올림 전 값(o.pv)이 아니다');
            assert.ok(!/data-sort-bytes="' \+ o\.tss\b/.test(html), '"352 B" 같은 표시 문자열로 정렬하면 단위가 섞인다');
            assert.ok(!/data-sort-pct="' \+ o\.p\b/.test(html), '반올림된 표시값으로 정렬하면 동률이 생긴다');
        });

        test('detail 행에는 정렬 속성을 두지 않는다', () => {
            // detail 행은 독립 정렬 대상이 아니라 부모를 따라다니기만 한다.
            // 속성을 두면 지금 필요 없는 셀 의미 차이까지 떠안게 된다.
            const detailRow = html.match(/<tr class="obj-detail-row">[^']*/);
            assert.ok(detailRow, 'obj-detail-row 마크업을 찾지 못했다');
            assert.ok(!detailRow![0].includes('data-sort-'), detailRow![0]);
        });
    });

    suite('정렬기가 그룹 단위로 움직인다', () => {
        test('부모만 골라내던 선택자가 사라졌다', () => {
            assert.ok(
                !html.includes("querySelectorAll('tr:not(.obj-detail-row)')"),
                'detail 행을 제외하고 부모만 재배치하면 묶음이 다시 어긋난다'
            );
        });

        test('detail 행을 직전 부모 그룹에 붙인다', () => {
            assert.ok(
                /classList\.contains\('obj-detail-row'\)[\s\S]{0,120}groups\[groups\.length - 1\]\.rows\.push/.test(html),
                'detail 행이 부모 그룹에 합류하지 않는다'
            );
        });

        test('그룹 전체를 순서대로 재배치한다', () => {
            assert.ok(
                /groups\.forEach\([\s\S]{0,160}appendChild/.test(html),
                '부모만 appendChild하면 section 행이 제자리에 남는다'
            );
        });

        test('정렬값은 행 속성을 우선하고 없으면 셀 텍스트로 폴백한다', () => {
            // 폴백이 없으면 속성을 두지 않는 All Sections / region 상세 표의
            // 정렬이 통째로 죽는다.
            assert.ok(html.includes("row.getAttribute('data-sort-' + sortByCol)"), '속성 우선 경로가 없다');
            assert.ok(
                /if \(attr !== null\) \{ return attr; \}/.test(html),
                '속성이 있을 때 그것을 쓰지 않는다'
            );
            assert.ok(
                html.includes('row.children[valIdx].textContent.trim()'),
                '셀 텍스트 폴백이 사라지면 다른 표의 정렬이 깨진다'
            );
        });
    });
});
