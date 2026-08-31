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
    const armScatterSymbol = 'Image$$RW_IRAM1$$Base';
    let filePath: string;
    let html: string;
    let noRegionFilePath: string;
    let noRegionHtml: string;

    function generatedCssRules(): Array<{ selectors: string[]; declarations: string }> {
        const css = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
            .map(match => match[1])
            .join('\n')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(match => ({
            selectors: match[1].split(',').map(selector => selector.trim()),
            declarations: match[2],
        }));
    }

    function generatedTextById(id: string): string {
        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const element = html.match(new RegExp(
            `<([A-Za-z][A-Za-z0-9-]*)\\b[^>]*\\bid="${escapedId}"[^>]*>([\\s\\S]*?)<\\/\\1>`
        ));
        return (element?.[2] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    suiteSetup(() => {
        panelRegistry.clear();
        filePath = path.join(os.tmpdir(), `taskhub-mm-a11y-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildMinimalElf32(armScatterSymbol));
        const ctx = { extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [] } as unknown as vscode.ExtensionContext;
        // 영역 설정을 함께 준다: region이 없으면 사용량 막대 / 영역 카드 /
        // 모두 펼치기 버튼이 아예 렌더되지 않아 그 경로를 검사할 수 없다.
        const config = { regions: [{ name: 'FLASH', origin: 0x08000000, size: 512 * 1024 }] };
        assert.ok(openMemoryMapPanel(ctx, filePath, config), '패널이 열려야 HTML을 검사할 수 있다');
        html = panelRegistry.getHtml(filePath) ?? '';
        assert.ok(html.length > 0, '웹뷰 HTML이 비어 있다');

        // 빠른 열기는 linker picker를 건너뛰므로, PT_LOAD도 설정도
        // 없는 ELF에서는 패널 안에 실제 복구 경로가 있어야 한다.
        noRegionFilePath = path.join(os.tmpdir(), `taskhub-mm-a11y-no-region-${process.pid}.axf`);
        fs.writeFileSync(noRegionFilePath, buildMinimalElf32());
        assert.ok(openMemoryMapPanel(ctx, noRegionFilePath), '영역 없는 패널도 열려야 한다');
        noRegionHtml = panelRegistry.getHtml(noRegionFilePath) ?? '';
        assert.ok(noRegionHtml.includes('class="no-regions"'), '영역 없음 안내 분기에 도달하지 못했다');
    });

    suiteTeardown(() => {
        panelRegistry.clear();
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        try { fs.unlinkSync(noRegionFilePath); } catch { /* best effort */ }
    });

    /**
     * 웹뷰 스크립트는 TS 템플릿 리터럴 **안의 문자열**이라 tsc도 eslint도
     * 내용을 보지 않는다. 중괄호 하나가 어긋나면 패널의 모든 상호작용(펼치기 ·
     * 검색 · 정렬 · 저장)이 한꺼번에 죽는데, 호스트 테스트는 HTML 문자열만
     * 보므로 전부 통과한다. `new Function`은 실행하지 않고 파싱만 한다.
     */
    test('웹뷰 스크립트가 문법적으로 유효하다', () => {
        const blocks = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)).map(m => m[1]);
        assert.ok(blocks.length > 0, '스크립트 블록을 찾지 못했다 — 검사 전제가 깨졌다');
        blocks.forEach((source, i) => {
            assert.ok(source.trim().length > 0, `${i}번 스크립트 블록이 비어 있다`);
            assert.doesNotThrow(() => new Function(source), `${i}번 스크립트 블록에 문법 오류가 있다`);
        });
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
            assert.ok(html.includes(strings.refresh), 'Refresh 버튼');
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
        test('ARM scatter 이름의 $$를 aria-label에서 그대로 보존한다', () => {
            const sectionButton = html.match(/<button\b[^>]*data-target-id="section:0"[^>]*>/);
            assert.ok(sectionButton, 'All Sections의 Hex 버튼을 찾지 못했다');
            const sectionLabel = strings.viewHexFor.replace('{name}', () => armScatterSymbol);
            assert.ok(sectionButton![0].includes(`aria-label="${sectionLabel}"`), sectionButton![0]);

            // region 상세 행은 웹뷰가 런타임에 조립하므로, 생성된 rowHtml 자체를
            // 격리해 실행한다. 문자열만 살피면 함수형 replacer가 다시 일반 문자열
            // replacer로 바뀌어도 ARM의 $$ 축약을 재현하지 못한다.
            const rowHtmlMatch = html.match(
                /    (function rowHtml\(e, hsi, hfi, hhx, hhs\) \{[\s\S]*?\n    \})\n\n    function matchSeg/
            );
            assert.ok(rowHtmlMatch, '웹뷰 rowHtml 함수를 찾지 못했다');
            const factory = new Function(
                'S', 'IS_STANDALONE', 'funcVis', 'esc', 'hl',
                `${rowHtmlMatch![1]}\nreturn rowHtml;`
            ) as (...args: unknown[]) => (...args: unknown[]) => string;
            const escapeHtml = (value: unknown): string => String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            const rowHtml = factory(strings, false, false, escapeHtml, escapeHtml);

            for (const name of [armScatterSymbol, 'Load$$LR$$LR_1$$Base']) {
                const row = rowHtml({
                    n: name, s: '.text', f: '', a: 0x08000000,
                    ah: '0x08000000', eh: '0x0800001F', sz: 32, ss: '32 B',
                    t: 'CODE', fr: false, hx: 'entry:0:0', ha: true, sx: 'source:0:0',
                }, false, false, true, true);
                const labels = Array.from(row.matchAll(/aria-label="([^"]*)"/g)).map(match => match[1]);
                assert.deepStrictEqual(labels, [
                    strings.viewHexFor.replace('{name}', () => name),
                    strings.viewSourceFor.replace('{name}', () => name),
                ]);
            }
        });

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

        test('Refresh 버튼과 실패 상태에 접근 가능한 이름과 live region이 있다', () => {
            const button = html.match(/<button[^>]*id="btnRefresh"[^>]*>/);
            assert.ok(button, 'btnRefresh를 찾지 못했다');
            assert.ok(/aria-label="[^"]+"/.test(button![0]), button![0]);
            assert.ok(/title="[^"]+"/.test(button![0]), button![0]);

            const status = html.match(/<div[^>]*id="refreshStatus"[^>]*>/);
            assert.ok(status, 'refreshStatus를 찾지 못했다');
            assert.ok(status![0].includes('role="status"'), status![0]);
            assert.ok(status![0].includes('aria-live="polite"'), status![0]);
            assert.ok(status![0].includes('aria-atomic="true"'), status![0]);
        });

        test('Refresh 진행과 실패는 서로 다른 상태 클래스를 쓴다', () => {
            const busyRules = Array.from(html.matchAll(
                /\.refresh-status\.([\w-]*(?:busy|refreshing)[\w-]*)[^\{]*\{([^}]*)\}/gi
            ));
            const errorRules = Array.from(html.matchAll(
                /\.refresh-status\.([\w-]*(?:error|failed)[\w-]*)[^\{]*\{([^}]*)\}/gi
            ));
            const busyRule = busyRules.find(rule => /(?:border|background|color)\s*:/.test(rule[2]));
            const errorRule = errorRules.find(rule => /inputValidation-error/i.test(rule[2]));
            assert.ok(busyRule, 'Refresh 진행 상태 클래스 CSS가 없다');
            assert.ok(errorRule, 'Refresh 실패 상태 클래스 CSS가 없다');
            assert.notStrictEqual(busyRule![1], errorRule![1], '진행과 실패가 같은 클래스를 쓰면 안 된다');
            assert.ok(!/inputValidation-error/i.test(busyRule![2]),
                `진행 상태가 오류 색으로 표시된다: ${busyRule![0]}`);
            assert.ok(/inputValidation-error/i.test(errorRule![2]),
                `실패 상태에 오류 테마 색이 없다: ${errorRule![0]}`);
            for (const className of [busyRule![1], errorRule![1]]) {
                const occurrences = html.split(className).length - 1;
                const stateName = className.replace(/^is-/, '');
                const dynamicStateClass = html.includes("' is-' + kind")
                    && new RegExp(`setRefreshFeedback\\(\\s*['\"]${stateName}(?:\\s|['\"])`).test(html);
                assert.ok(occurrences >= 2 || dynamicStateClass,
                    `${className}이 CSS에만 있고 스크립트 상태 전환에서 쓰이지 않는다`);
            }
        });

        test('Refresh 버튼은 처리 중 재실행을 막고 disabled 상태를 보여 준다', () => {
            const disabledRule = html.match(/button:disabled(?:\s*,[^\{]+)?\s*\{([^}]*)\}/);
            const nativeDisabled = disabledRule !== null
                && /(cursor|opacity|filter|background|color)\s*:/.test(disabledRule[1]);
            const ariaDisabledGuard = /aria-disabled/.test(html)
                && /(?:getAttribute\(\s*['"]aria-disabled['"]\s*\)|matches\([^)]*aria-disabled)[\s\S]{0,180}?(?:return|preventDefault)/.test(html);
            assert.ok(nativeDisabled || ariaDisabledGuard,
                '모든 button에 적용되는 :disabled 표시나 aria-disabled 재실행 가드가 없다');
            assert.ok(/refreshButton\.disabled\s*=\s*true/.test(html) || /aria-disabled[\s\S]{0,100}true/.test(html),
                'Refresh 요청 시 버튼을 disabled 상태로 만들지 않는다');
        });

        test('공유 button 규칙이 최소 24×24 터치 타깃을 보장한다', () => {
            const buttonRule = html.match(/(?:^|\n)\s*button\s*\{([^}]*)\}/);
            assert.ok(buttonRule, '공유 button CSS를 찾지 못했다');
            assert.match(buttonRule![1], /min-width\s*:\s*24px/);
            assert.match(buttonRule![1], /min-height\s*:\s*24px/);
        });

        test('Refresh status가 busy 소유자이며 live region에서 제거되지 않는다', () => {
            const status = html.match(/<div[^>]*id="refreshStatus"[^>]*>/);
            assert.ok(status, 'refreshStatus를 찾지 못했다');
            assert.ok(status![0].includes('aria-busy="false"'), status![0]);
            assert.ok(!/\shidden(?:\s|=|>)/.test(status![0]),
                `hidden은 live region을 접근성 트리에서 제거한다: ${status![0]}`);
            assert.ok(!/refreshStatus\.hidden\s*=/.test(html),
                'Refresh 상태 전환이 live region을 hidden으로 제거한다');
            const statusRules = Array.from(html.matchAll(/\.refresh-status[^\{]*\{([^}]*)\}/g)).map(match => match[1]);
            assert.ok(!statusRules.some(rule => /display\s*:\s*none/.test(rule)),
                'refresh-status CSS가 display:none으로 live region을 제거한다');

            const busyUpdates = Array.from(html.matchAll(
                /refreshStatus\.setAttribute\(\s*['"]aria-busy['"]\s*,\s*([^)]+)\)/g
            )).map(match => match[1]).join(' ');
            assert.ok(busyUpdates.includes("'true'") && busyUpdates.includes("'false'"),
                `refreshStatus aria-busy가 true/false로 갱신되지 않는다: ${busyUpdates}`);
        });

        test('Refresh 실패 색은 테마 token이 없을 때 기본 foreground로 폴백한다', () => {
            assert.ok(
                /color\s*:\s*var\(\s*--vscode-inputValidation-errorForeground\s*,\s*var\(\s*--fg\s*\)\s*\)/.test(html),
                'inputValidation.errorForeground에 --fg 폴백이 없다'
            );
        });

        test('Refresh는 title에만 의존하지 않는 접근 가능한 설명을 갖는다', () => {
            const button = html.match(/<button[^>]*id="btnRefresh"[^>]*>/);
            assert.ok(button, 'btnRefresh를 찾지 못했다');
            const describedBy = button![0].match(/aria-describedby="([^"]+)"/);
            assert.ok(describedBy, `Refresh 버튼에 aria-describedby가 없다: ${button![0]}`);

            const descriptionIds = describedBy![1].split(/\s+/).filter(Boolean);
            const descriptions = descriptionIds.map(generatedTextById).join(' ').trim();
            assert.ok(descriptions.length > 0, `aria-describedby 대상이 비어 있다: ${describedBy![1]}`);
            assert.ok(/(?:현재\s*입력|입력\s*파일|current\s+input)/i.test(descriptions)
                && /(?:다시\s*읽|reload|re-read)/i.test(descriptions),
                `무엇을 다시 읽는 동작인지 설명하지 않는다: ${descriptions}`);
            assert.ok(/(?:링커|스캐터|linker|scatter)/i.test(descriptions)
                && /(?:포함|include)/i.test(descriptions),
                `AXF/ELF Refresh에 linker/scatter 파일이 포함됨을 설명하지 않는다: ${descriptions}`);
            assert.ok(/(?:자동[\s\S]{0,20}(?:하지|않|없|안\s*함)|not[\s\S]{0,20}(?:watch|monitor))/i.test(descriptions),
                `파일 변경을 자동 감시하지 않음을 설명하지 않는다: ${descriptions}`);
        });

        test('Refresh 실패 배너가 좁은 폭에서 닫기 버튼을 밀어내지 않는다', () => {
            const statusRules = generatedCssRules()
                .filter(rule => rule.selectors.includes('.refresh-status'))
                .map(rule => rule.declarations)
                .join('\n');
            assert.match(statusRules, /min-width\s*:\s*0(?:px)?\s*(?:;|$)/,
                'flex item의 기본 min-width:auto가 긴 실패 사유의 축소를 막는다');
            assert.match(statusRules, /overflow-wrap\s*:\s*anywhere\s*(?:;|$)/,
                '긴 파일명/단일 토큰을 줄바꿈하지 못해 닫기 버튼이 viewport 밖으로 밀린다');

            const dismissRules = generatedCssRules()
                .filter(rule => rule.selectors.includes('.refresh-dismiss'))
                .map(rule => rule.declarations)
                .join('\n');
            assert.ok(/flex-shrink\s*:\s*0\s*(?:;|$)/.test(dismissRules)
                || /flex\s*:\s*0\s+0(?:\s+[^;]+)?\s*(?:;|$)/.test(dismissRules),
                `실패 세부 정보 버튼의 flex 축소 방지가 없다: ${dismissRules}`);
        });

        test('포커스 가능한 aria-disabled Refresh 라벨은 group opacity로 흐려지지 않는다', () => {
            const ariaDisabledRules = generatedCssRules().filter(rule => rule.selectors.some(selector =>
                /(?:^|[\s>+~])(?:button)?\[aria-disabled=(?:["']true["']|true)\](?![^\[]*:)/.test(selector)
            ));
            assert.ok(ariaDisabledRules.length > 0, 'aria-disabled 버튼의 CSS 규칙을 찾지 못했다');

            const computed = new Map<string, string>();
            for (const rule of ariaDisabledRules) {
                for (const declaration of rule.declarations.split(';')) {
                    const separator = declaration.indexOf(':');
                    if (separator < 0) { continue; }
                    const property = declaration.slice(0, separator).trim().toLowerCase();
                    const value = declaration.slice(separator + 1).trim();
                    if (property) { computed.set(property, value); }
                }
            }
            const opacity = computed.get('opacity');
            const opacityValue = opacity === undefined ? 1 : Number(opacity);
            assert.ok(Number.isFinite(opacityValue) && opacityValue >= 1,
                `aria-disabled Refresh가 group opacity ${opacity ?? '(없음)'}에 의존한다`);

            const hasExplicitColorPair = computed.has('color')
                && (computed.has('background') || computed.has('background-color'));
            const hasExplicitOpaqueStyle = opacity !== undefined && Number(opacity) >= 1;
            assert.ok(hasExplicitOpaqueStyle || hasExplicitColorPair,
                `aria-disabled Refresh에 opacity:1 또는 명시적 foreground/background 쌍이 없다: ${JSON.stringify(Object.fromEntries(computed))}`);
        });

        test('영역이 없을 때 linker 선택 흐름으로 가는 복구 action이 있다', () => {
            const block = noRegionHtml.match(/<div class="no-regions"[^>]*>([\s\S]*?)<\/div>/);
            assert.ok(block, 'no-regions 안내를 찾지 못했다');
            const interactive = block![1].match(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/);
            assert.ok(interactive, '안내 안에 실행 가능한 복구 컨트롤이 없다');
            const actionName = interactive![2].match(/data-action="([^"]+)"/)?.[1];
            assert.ok(actionName, `복구 컨트롤에 allowlist할 data-action이 없다: ${interactive![0]}`);
            assert.ok(/aria-label="[^"]+"/.test(interactive![2]) || interactive![3].replace(/<[^>]+>/g, '').trim().length > 0,
                `복구 컨트롤의 접근 가능한 이름이 없다: ${interactive![0]}`);

            const singleQuotedCase = `case '${actionName}'`;
            const doubleQuotedCase = `case "${actionName}"`;
            const caseOffset = Math.max(noRegionHtml.indexOf(singleQuotedCase), noRegionHtml.indexOf(doubleQuotedCase));
            assert.ok(caseOffset >= 0, `${actionName}을 처리하는 스크립트 분기가 없다`);
            assert.ok(/postMessage/.test(noRegionHtml.slice(caseOffset, caseOffset + 500)),
                `${actionName} 분기가 extension host에 복구 요청을 보내지 않는다`);
            assert.ok(interactive![3].includes(strings.configureMemoryMap),
                `복구 동작 자체가 버튼 라벨이어야 한다: ${interactive![0]}`);
            assert.ok(!/TaskHub:\s*(?:Memory Map 보기|Show Memory Map)/.test(interactive![3]),
                `전체 마법사 명령명을 동작 라벨로 쓰면 안 된다: ${interactive![0]}`);
        });

        test('실패 세부 정보 버튼은 접힌 뒤에도 disclosure로 남는다', () => {
            const button = html.match(/<button[^>]*id="refreshDismiss"[^>]*>/);
            assert.ok(button, 'Refresh failure disclosure를 찾지 못했다');
            assert.ok(button![0].includes('aria-controls="refreshStatus"'), button![0]);
            assert.ok(button![0].includes('aria-expanded="true"'), button![0]);
            assert.ok(html.includes('S.showRefreshDetails'), '접힌 실패를 다시 펼칠 접근 가능한 이름이 없다');
        });

        test('좁은 폭에서 header 컨트롤이 다음 줄로 wrap된다', () => {
            const headerRules = Array.from(html.matchAll(/\.header-row\s*\{([^}]*)\}/g)).map(match => match[1]);
            assert.ok(headerRules.some(rule => /flex-wrap\s*:\s*wrap/.test(rule)),
                'header-row에 flex-wrap: wrap이 없어 좁은 패널에서 버튼이 넘친다');
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
            assert.ok(/setAttribute\('aria-expanded', state\.any \? 'true' : 'false'\)/.test(html),
                '펼침 시 상태 갱신이 없다');
        });

        test('검색 입력에 접근 가능한 이름이 있다', () => {
            const input = html.match(/<input id="searchInput"[^>]*>/);
            assert.ok(/aria-label="[^"]+"/.test(input![0]), input![0]);
        });

        test('사용량 막대는 장식으로 처리된다 (수치는 이미 텍스트로 존재)', () => {
            // 속성 순서에 기대지 않는다 — 0.6.55에서 막대에 클릭 동작이 붙으며
            // 두 속성 사이에 data-action이 끼었고, 그때 이 검사가 깨졌다.
            const bar = html.match(/<div class="bar-bg"[^>]*>/);
            assert.ok(bar, 'bar-bg를 찾지 못했다');
            assert.ok(bar![0].includes('aria-hidden="true"'),
                '같은 수치를 두 번 읽히게 하면 표 탐색만 길어진다');
        });

        test('사용량 막대를 눌러도 영역이 열린다 (마우스 대상 넓히기)', () => {
            // 카드에서 가장 눈에 띄는 20px 띠가 눌러도 아무 일이 없었다.
            // 키보드 경로는 헤더가 담당하므로 여기서는 마우스 편의만 더한다.
            const bar = html.match(/<div class="bar-bg"[^>]*>/);
            assert.ok(bar![0].includes('data-action="toggle-region"'), bar![0]);
            assert.ok(!/tabindex/.test(bar![0]),
                'aria-hidden인 장식 요소에 포커스를 주면 Tab 순서에 빈 정거장이 생긴다');
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
            // 0.6.55부터 제목(h3)이 이 컨트롤을 감싼다 — 그래서 span 이다.
            const header = html.match(/<span class="region-header"[^>]*>/);
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

        test('펼침 상태 변경이 setRegionExpanded 한 곳으로 모인다 (0.6.35)', () => {
            // 0.6.31은 aria-expanded를 직접 클릭 경로에만 넣어, Expand All ·
            // 검색 자동 확장 · Overview/명령 이동으로 펼친 카드를 스크린리더가
            // 계속 "접힘"으로 읽었다. 상태를 바꾸는 경로가 다섯 곳인데 한
            // 곳만 고친 결과다 — 이제 전부 한 함수를 거친다.
            assert.ok(html.includes('function setRegionExpanded(card, expanded)'),
                '단일 경로 함수가 없다');
            const uses = (html.match(/setRegionExpanded\(card, /g) ?? []).length;
            assert.ok(uses >= 4,
                `호출이 ${uses}곳뿐이다 — toggleRegion / ensureRegionExpanded / foldAll / overview / scrollToRegion이 모두 거쳐야 한다`);
            // 우회 경로가 되살아나지 않았는지: display를 직접 펼치는 패턴이
            // setRegionExpanded 본문 밖에 남아 있으면 안 된다.
            const outside = html
                .split('function setRegionExpanded')[1]  // 본문 이후만
                ?.split('window.toggleRegion')[1] ?? '';
            assert.ok(!/detail\.style\.display = '';/.test(outside),
                'setRegionExpanded를 우회해 display를 직접 바꾸는 펼침 경로가 남아 있다');
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

    /**
     * Object Summary 접기와 "섹션 행" 토글 (0.6.55).
     *
     * 사용자 보고: *Details* 를 눌러도 화면이 그대로여서 고장인지 아닌지
     * 알 수 없다. 원인이 셋이었다.
     *
     * **1. 접힌 요약 안의 행을 토글했다.** Object Summary 본문은 기본이
     * `display:none`이고 버튼은 그 안의 `.obj-detail-row` 만 뒤집었다. 요약을
     * 먼저 펼치지 않은 사람에게는 **화면상 아무 일도 일어나지 않는다** — 그리고
     * region을 펼치면 요약은 접힌 상태이므로, 처음 누르는 사람은 예외 없이 그
     * 상태를 만난다.
     *
     * **2. 버튼이 자기 상태를 드러내지 않았다.** 라벨은 늘 `Details ▶`로
     * 고정이었다. 같은 화면의 다른 토글(region 글리프 · Object Summary 글리프 ·
     * Function 열)은 모두 상태를 뒤집어 보여 준다.
     *
     * **3. 라벨이 바로 위 "영역 상세"(regionDetails)와 구별되지 않았다.**
     *
     * 웹뷰 스크립트는 호스트 테스트에서 실행할 수 없으므로, 조립되는
     * 마크업과 토글 함수의 형태를 고정한다.
     */
    suite('Object Summary 접기와 섹션 행 토글 (0.6.55)', () => {

        /**
         * 웹뷰 스크립트에서 함수 하나의 **본문만** 잘라 온다.
         *
         * 길이를 상수로 잡으면 창이 다음 함수까지 넘어가, 뒤에 붙는 무관한
         * 코드가 이 검사들을 통과/실패시킬 수 있다.
         */
        function fnSource(name: string): string {
            const at = html.indexOf('window.' + name + ' = function');
            assert.ok(at >= 0, `${name}을 찾지 못했다`);
            const end = html.indexOf('\n    };', at);
            assert.ok(end > at, `${name}의 끝을 찾지 못했다`);
            return html.slice(at, end);
        }

        test('접힌 요약에서 섹션 행을 켜면 요약을 함께 펼친다', () => {
            const src = fnSource('toggleObjDetailRows');
            assert.ok(
                /setObjSummaryExpanded\(header, true\)/.test(src),
                '켜는 방향에서 요약을 펼치지 않으면 버튼이 화면상 아무 일도 하지 않는다'
            );
        });

        test('요약을 접으면 섹션 행 버튼도 끈 상태로 되돌린다', () => {
            // 되돌리지 않으면 무반응이 방향만 바뀌어 되살아난다: 켜고 → 헤더로
            // 요약을 접고 → 다시 누르면 **보이지 않는 행을 숨기는** 셈이라
            // 화면이 그대로다. 불변식은 "버튼 상태 = 화면에 보이는 것".
            const src = html.match(/function setObjSummaryExpanded\(header, expanded\)[\s\S]*?\n    \}/);
            assert.ok(src, 'setObjSummaryExpanded를 찾지 못했다');
            assert.ok(/if \(!expanded\) \{ resetObjDetailRows/.test(src![0]),
                '접는 경로가 버튼 상태를 되돌리지 않는다');
            const reset = html.match(/function resetObjDetailRows\(header, body\)[\s\S]*?\n    \}/);
            assert.ok(reset, 'resetObjDetailRows를 찾지 못했다');
            assert.ok(/aria-pressed', 'false'/.test(reset![0]) && /S\.objDetailRows \+ ' ▶'/.test(reset![0]),
                '버튼의 상태와 라벨을 함께 되돌려야 한다');
        });

        test('섹션 행 버튼이 라벨과 aria로 상태를 드러낸다', () => {
            const src = fnSource('toggleObjDetailRows');
            assert.ok(/btn\.setAttribute\('aria-pressed'/.test(src),
                '스크린리더가 켜짐 여부를 알 수 없다');
            assert.ok(/btn\.textContent = S\.objDetailRows/.test(src),
                '라벨이 고정이면 눌렀는지 아닌지 눈으로 확인할 방법이 없다');
        });

        test('버튼은 aria-expanded가 아니라 aria-pressed를 쓴다', () => {
            // 이 버튼이 여닫는 것은 요약 본문이 아니라 그 안의 행이다. 헤더와
            // 나란히 aria-expanded를 달면 같은 본문을 두고 "펼침"(버튼)과
            // "접힘"(헤더)이 동시에 읽히는 상태가 만들어진다.
            const button = html.match(/<button data-action="toggle-obj-detail-rows"[^>]*>/);
            assert.ok(button, '섹션 행 버튼 마크업을 찾지 못했다');
            assert.ok(button![0].includes('aria-pressed="false"'), button![0]);
            assert.ok(!button![0].includes('aria-expanded'),
                '같은 본문에 대해 두 컨트롤이 서로 다른 펼침 상태를 주장하게 된다');
        });

        test('토글 상태를 계산된 스타일이 아니라 버튼에서 읽는다', () => {
            const src = fnSource('toggleObjDetailRows');
            assert.ok(/btn\.getAttribute\('aria-pressed'\)/.test(src),
                '상태의 출처가 버튼이 아니면 라벨과 실제 동작이 갈라진다');
            assert.ok(!src.includes('getComputedStyle'),
                '행이 하나도 없는 표에서 옛 방식은 늘 "이미 보임"으로 판정해 아무 일도 하지 않았다');
        });

        test('섹션 행 버튼이 접기 헤더 밖에 있다 (버튼 안의 버튼 금지)', () => {
            const header = html.match(/<span class="obj-summary-header"[\s\S]*?<\/span><\/h4>/);
            assert.ok(header, 'obj-summary-header 마크업을 찾지 못했다');
            assert.ok(!header![0].includes('<button'),
                'role=button 안의 진짜 button은 잘못된 ARIA 구조이고, 한 줄 안에서 누르는 지점마다 다른 일이 일어난다');
            assert.ok(/<div class="obj-summary-bar">/.test(html),
                '헤더와 버튼을 나란히 놓을 컨테이너가 없다');
        });

        test('Object Summary가 제목으로도 노출된다 (3단 구조 이동)', () => {
            // 제목이 없으면 스크린리더 사용자는 영역 상세 → 영역 → 오브젝트
            // 요약 사이를 정렬 머리글까지 Tab으로 지나며 찾아야 한다.
            assert.ok(/<h4 class="obj-summary-heading"><span class="obj-summary-header"/.test(html),
                '접기 컨트롤을 제목이 감싸는 형태가 아니다');
            assert.ok(!/<h4[^>]*role="button"/.test(html),
                'role=button은 제목 역할을 덮어쓴다 — 컨트롤 자체를 제목으로 만들면 제목을 잃는다');
        });

        test('컨트롤이 달린 제목은 버튼 문구를 제목 이름에 끌어들이지 않는다', () => {
            // 컨테이너를 통째로 제목으로 만들면 "영역 상세 영역 모두 펼치기 함수 열"이
            // 하나의 제목 이름이 된다.
            const heading = html.match(/<div class="section-heading"><h2>[\s\S]*?<\/h2>/);
            assert.ok(heading, 'section-heading 안의 h2를 찾지 못했다');
            assert.ok(!heading![0].includes('<button'), heading![0]);
            const count = (html.match(/<div class="section-heading"><h2>/g) ?? []).length;
            assert.strictEqual(count, 3, `제목 3개(메모리 영역 · 영역 상세 · 전체 섹션)가 아니라 ${count}개다`);
        });

        test('제목 단계가 건너뜀 없이 이어진다 (h1 → h2 → h3 → h4)', () => {
            // 문서 = 파일 하나, 그 아래 세 구획, 그 아래 영역, 그 아래 오브젝트
            // 요약. 단계를 건너뛰면 제목 목록에서 구조가 무너진다.
            // <style>/<script> 본문은 뺀다 — CSS 주석이나 웹뷰가 실행 시
            // 조립하는 마크업 문자열이 문서의 제목 순서인 척하면 안 된다.
            const body = html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, '');
            const levels = Array.from(body.matchAll(/<h([1-6])[ >]/g)).map(m => Number(m[1]));
            assert.deepStrictEqual([...new Set(levels)].sort(), [1, 2, 3],
                `정적 마크업의 제목 단계가 예상과 다르다: ${[...new Set(levels)].join(', ')}`);
            assert.strictEqual(levels[0], 1, '문서 제목이 h1이 아니다');
            assert.ok(html.includes('<h4 class="obj-summary-heading">'),
                '오브젝트 요약은 영역(h3) 아래이므로 h4여야 한다');
        });

        test('영역 이름이 제목이라 영역 사이를 건너뛸 수 있다', () => {
            // 문서에 "영역 상세 → 영역 → 오브젝트 요약을 제목으로 이동한다"고
            // 적어 두었다. 영역이 제목이 아니면 그 문장이 거짓이 된다.
            assert.ok(/<h3 class="region-heading"><span class="region-header"/.test(html),
                '영역 이름이 제목이 아니다 — 버튼 이동으로만 닿는다');
            assert.ok(!/<h3[^>]*role="button"/.test(html),
                'role=button은 제목 역할을 덮어쓴다');
        });

        test('일괄 토글의 이름에 글리프가 섞이지 않는다', () => {
            // textContent 에 넣은 ▶/▼ 는 접근 가능한 이름에 그대로 들어간다
            // ("검은 오른쪽 삼각형 영역 모두 펼치기"). 같은 줄의 다른 버튼들은
            // 모두 aria-label 을 갖고 있었고 이것만 예외였다.
            const btn = html.match(/<button data-action="toggle-all"[^>]*>/);
            assert.ok(btn, 'toggleAllBtn을 찾지 못했다');
            assert.ok(/aria-label="[^"▶▼]+"/.test(btn![0]), btn![0]);
            assert.ok(/setAttribute\('aria-label', label\)/.test(html),
                '상태가 바뀔 때 이름도 함께 갱신해야 한다');
            // title 은 라벨을 되풀이하는 대신 이름을 바꾼 이유를 말한다.
            assert.ok(btn![0].includes('title="' + strings.expandAllHint), btn![0]);
        });

        test('오브젝트 요약 제목이 어느 영역 것인지 말한다', () => {
            assert.ok(/aria-label="' \+ esc\(S\.objectSummary \+ ' \(' \+ rd\.objSummary\.length \+ '\) — ' \+ rd\.name\)/.test(html),
                '카드를 여럿 펼치면 개수만 다른 같은 제목이 늘어선다');
        });

        test('헤더와 버튼이 aria-controls로 같은 본문을 가리킨다', () => {
            const controls = html.match(/aria-controls="' \+ bodyId \+ '"/g) ?? [];
            assert.strictEqual(controls.length, 2,
                '헤더와 버튼 둘 다 본문을 가리켜야 DOM 위치에 기대지 않고 본문을 찾을 수 있다');
            assert.ok(html.includes(`<div class="obj-summary-body" id="' + bodyId + '"`),
                '본문에 id가 없으면 aria-controls가 가리킬 대상이 없다');
        });

        test('본문 id가 region마다 다르다', () => {
            // 상수 id로 바뀌면 모든 region의 헤더/버튼이 첫 region의 요약을
            // 조작한다 — 카드를 하나만 열어 보면 정상으로 보이는 종류의 결함이다.
            assert.ok(/const bodyId = '[^']+' \+ idx;/.test(html),
                'region 인덱스가 섞이지 않은 id는 카드 여러 개를 펼치는 순간 충돌한다');
        });

        test('본문을 DOM 위치가 아니라 aria-controls로 찾는다', () => {
            // 헤더의 다음 형제는 이제 버튼이다. DOM 위치 기반 조회로 되돌아가면
            // 헤더가 버튼 자신을 숨기고 버튼의 조회는 null이 되어 전부 죽는데,
            // 마크업만 보는 다른 검사들은 그대로 통과한다.
            assert.ok(
                /getAttribute\('aria-controls'\)[\s\S]{0,160}document\.getElementById\(id\)/.test(html),
                'aria-controls → getElementById 경로가 없다'
            );
            assert.ok(!html.includes('nextElementSibling'),
                'DOM 위치로 본문을 찾으면 헤더 옆에 무엇을 놓느냐에 따라 조용히 깨진다');
        });

        test('오브젝트 행이 섹션 개수를 미리 보여 준다', () => {
            assert.ok(html.includes('class="num obj-sec-count"'),
                '무엇이 펼쳐질지(펼칠 것이 있기는 한지) 알려 주는 유일한 자리다');
            assert.ok(/S\.objSectionsOne : S\.objSectionsMany/.test(html),
                '영어 단/복수 처리가 없다');
        });

        test('섹션 개수 문구의 {n} 자리표시자가 유지된다', () => {
            for (const value of [strings.objSectionsOne, strings.objSectionsMany]) {
                assert.ok(value.includes('{n}'), `자리표시자가 없다: ${value}`);
            }
        });

        test('라벨이 "영역 상세"와 구별된다', () => {
            assert.notStrictEqual(strings.objDetailRows, strings.regionDetails);
            assert.ok(!strings.regionDetails.includes(strings.objDetailRows),
                '한쪽이 다른 쪽을 통째로 포함하면 두 이름이 같은 것을 가리키는 것처럼 읽힌다');
        });

        test('접힘 상태 변경이 setObjSummaryExpanded 한 곳으로 모인다', () => {
            // region 카드가 0.6.35에 겪은 문제(경로마다 aria가 갈림)를 여기서
            // 반복하지 않는다. 이제 경로가 둘(헤더 클릭 / 섹션 행 자동 펼침)이다.
            assert.ok(html.includes('function setObjSummaryExpanded(header, expanded)'),
                '단일 경로 함수가 없다');
            // 선언(`function setObjSummaryExpanded(header, expanded)`)은 세지
            // 않는다 — 세면 호출이 하나뿐이어도 통과한다.
            const calls = (html.match(/(?<!function )setObjSummaryExpanded\(header, /g) ?? []).length;
            assert.ok(calls >= 2,
                `호출이 ${calls}곳뿐이다 — 헤더 클릭과 섹션 행 자동 펼침이 모두 이 함수를 거쳐야 한다`);
        });

        test('펼쳤는데 비어 있는 영역은 그 사실을 말한다', () => {
            // 크기가 0으로 잡힌 영역은 상세가 빈 문자열이라, 글리프만 뒤집히고
            // 화면은 그대로다 — 이 릴리스가 고친 무반응과 똑같이 읽힌다.
            assert.ok(/if \(h === ''\) \{ h = '<div class="empty-region">'/.test(html),
                '빈 상세에 대한 안내가 없다');
            assert.ok(html.includes('S.emptyRegion'), '안내 문구가 번들을 거치지 않는다');
        });

        test('영역 일괄 토글의 이름이 무엇을 펼치는지 말한다', () => {
            // 이 버튼은 **영역만** 펼친다. 그 안의 Object Summary는 접힌 채로
            // 남으므로 "모두 펼치기"는 3단 구조에서 지키지 못할 약속이었다.
            for (const label of [strings.expandAll, strings.collapseAll]) {
                assert.ok(/영역|region/i.test(label), `무엇을 펼치는지 알 수 없다: ${label}`);
            }
        });

        test('일괄 토글: 글리프는 지금 상태, 라벨은 다음 동작', () => {
            // 0.6.54까지 이 글리프만 "다음 동작"을 가리켜, 전부 접힌 화면에서
            // 영역 헤더는 ▶인데 이 버튼만 ▼였다 — 같은 사실에 화살표 두 개가
            // 반대로 붙어 있었고, 자기 자신의 aria-expanded 와도 어긋났다.
            const sync = html.match(/window\.syncToggleAllLabel = function[\s\S]*?\n    \};/);
            assert.ok(sync, 'syncToggleAllLabel을 찾지 못했다');
            const src = sync![0];
            assert.ok(/textContent = \(state\.any \? '▼ ' : '▶ '\) \+ label/.test(src),
                `글리프가 지금 상태를 가리키지 않는다: ${src}`);
            assert.ok(/setAttribute\('aria-expanded', state\.any \? 'true' : 'false'\)/.test(src),
                '글리프와 aria-expanded가 서로 다른 사실을 말한다');
            // 최초 렌더는 전부 접힘이므로 정적 마크업도 ▶여야 한다.
            const initial = html.match(/<button data-action="toggle-all"[^>]*>[^<]*/);
            assert.ok(initial && initial[0].includes('▶'),
                `첫 화면부터 글리프가 어긋나 있다: ${initial?.[0]}`);
        });

        test('일부만 펼친 상태에서 한 번 더 누르면 나머지가 펼쳐진다', () => {
            // "하나라도 펼쳐졌으면 접기"였을 때는, 영역 하나를 펼쳐 본 사람이
            // 나머지를 보려면 전부 접었다가 다시 펼쳐야 했다(두 번 클릭).
            const sync = html.match(/window\.syncToggleAllLabel = function[\s\S]*?\n    \};/);
            assert.ok(/const label = state\.all \? S\.collapseAll : S\.expandAll;/.test(sync![0]),
                '전부 펼쳐졌을 때만 접기여야 한다');
            assert.ok(/window\.foldAll\(regionFoldState\(\)\.all\)/.test(html),
                '클릭 동작이 라벨과 같은 기준을 쓰지 않는다');
            assert.ok(/all: all && details\.length > 0/.test(html),
                '영역이 하나도 없으면 all이 참이 되어 첫 클릭이 접기로 간다');
        });

        test('검색이 요약 표에도 적용된다', () => {
            // 이게 없으면 한 카드 안에서 섹션 표는 걸러진 결과를, 바로 위
            // 요약 표는 전체 목록을 하이라이트도 없이 보여 준다 — "이 검색어가
            // 어느 오브젝트에 있나"가 이 표를 보는 이유인데도.
            assert.ok(/if \(rendered\.has\(idx\)\) \{ syncObjSummary\(card\); \}/.test(html),
                'doSearch가 요약 표를 갱신하지 않는다');
            assert.ok(/if \(curQ\) \{ syncObjSummary\(card\); \}/.test(html),
                '검색 중 자동으로 펼쳐진 영역의 요약이 걸러지지 않은 채로 그려진다');
        });

        test('오브젝트는 딸린 섹션이 걸려도 남는다', () => {
            const src = html.match(/function syncObjSummary\(card\)[\s\S]*?\n    \}/);
            assert.ok(src, 'syncObjSummary를 찾지 못했다');
            assert.ok(/const keep = parentHit \|\| detailHit\.indexOf\(true\) !== -1;/.test(src![0]),
                '이름만 대조하면 "어느 오브젝트에 있나"에 답하지 못한다');
        });

        test('섹션 행 표시는 토글과 검색을 한 곳에서 합쳐 정한다', () => {
            // 두 곳에서 각자 display를 만지면 나중에 실행된 쪽이 이기고, 그
            // 순간부터 버튼 상태와 화면이 갈라진다 — 이 릴리스가 고친 결함이다.
            const writes = (html.match(/\.style\.display = show \? 'table-row' : 'none'/g) ?? []).length;
            assert.strictEqual(writes, 1, `섹션 행의 display를 ${writes}곳에서 쓴다 — 한 곳이어야 한다`);
            const src = html.match(/function syncObjSummary\(card\)[\s\S]*?\n    \}/);
            assert.ok(/const show = keep && rowsOn && \(parentHit \|\| detailHit\[i\]\)/.test(src![0]),
                '두 조건(토글·검색)을 함께 보지 않는다');
        });

        test('하이라이트 전 원본 마크업을 보관한다', () => {
            // mark를 덧칠한 위에 또 칠하면 행이 조금씩 망가진다.
            const src = html.match(/function restoreRowHtml\(row\)[\s\S]*?\n    \}/);
            assert.ok(src, 'restoreRowHtml을 찾지 못했다');
            assert.ok(/staticOrig\.set\(row, row\.innerHTML\)/.test(src![0])
                && /row\.innerHTML = orig/.test(src![0]), src![0]);
        });

        test('접기 헤더에 키보드 포커스 표시가 있다', () => {
            // 둘 다 tabindex=0인 <div>다. 포커스 표시가 없으면 키보드 사용자는
            // Enter를 눌러 보기 전에는 자기 위치를 알 수 없다.
            for (const selector of ['.region-header:focus-visible', '.obj-summary-header:focus-visible']) {
                assert.ok(html.includes(selector), `${selector} 규칙이 없다`);
            }
        });
    });
});
