import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildJsonEditorStrings, getWebviewContent } from '../jsonEditor';

/**
 * "JSON Editor 웹뷰 지역화 / 접근성" (0.6.19).
 *
 * 확장 본체 UI는 `t(ko, en)`으로 두 벌을 제공하는데 웹뷰 안쪽은 `Save`,
 * `Reload`, `+ Row` 처럼 영어가 하드코딩돼 있었다. 아이콘만 있는 버튼(↶ ↷ ✕
 * ⠿)은 `title`만 있고 `aria-label`이 없었으며, 행 재정렬은 마우스 드래그
 * 전용이라 키보드로는 아예 불가능했다.
 *
 * 웹뷰는 확장 호스트가 만든 HTML 문자열이므로, 호스트가 로케일을 한 번
 * 해석해 문자열 번들을 주입한다. 아래 테스트는 그 번들과 결과 HTML의 계약을
 * 고정한다.
 */

const fakeWebview = { cspSource: 'https://test.invalid' } as unknown as vscode.Webview;

function render(data: Record<string, unknown> = { rows: [{ a: 1 }] }): string {
    return getWebviewContent(data, undefined, '/tmp/sample.json', fakeWebview);
}

suite('JSON Editor 웹뷰 지역화 / 접근성', () => {

    suite('문자열 번들', () => {
        const strings = buildJsonEditorStrings();

        test('빈 문자열 없이 모든 키가 채워져 있다', () => {
            const empty = Object.entries(strings).filter(([, value]) => !value || !value.trim());
            assert.deepStrictEqual(empty, [], `비어 있는 문자열: ${empty.map(([k]) => k).join(', ')}`);
        });

        test('플레이스홀더를 쓰는 문자열은 실제로 {name} 형식을 갖는다', () => {
            const withPlaceholders: Record<string, string[]> = {
                moveRow: ['{n}'],
                deleteRow: ['{n}'],
                rowMoved: ['{n}'],
                invalidJsonInCell: ['{col}', '{message}'],
                historyRestoreFailed: ['{message}'],
                scriptError: ['{message}', '{line}'],
            };
            for (const [key, tokens] of Object.entries(withPlaceholders)) {
                for (const token of tokens) {
                    assert.ok(strings[key]?.includes(token),
                        `${key}에 ${token}이 없으면 값이 문구에서 사라진다: ${strings[key]}`);
                }
            }
        });

        test('웹뷰 스크립트가 참조하는 키가 모두 번들에 있다', () => {
            // 스크립트에서 S.foo 로 쓰이는 키를 실제 HTML에서 추출해 대조한다.
            // 새 문자열을 추가하면서 번들에 넣는 것을 잊으면 undefined가 화면에
            // 찍히므로, 그 조합을 여기서 잡는다.
            const html = render();
            const referenced = new Set(
                Array.from(html.matchAll(/\bS\.([A-Za-z][A-Za-z0-9]*)/g)).map(m => m[1])
            );
            assert.ok(referenced.size > 0, 'S.* 참조를 하나도 찾지 못했다 — 추출 패턴을 확인할 것');
            for (const key of referenced) {
                assert.ok(key in strings, `웹뷰가 참조하는 S.${key}가 번들에 없다`);
            }
        });
    });

    suite('렌더된 HTML', () => {
        const html = render();
        const strings = buildJsonEditorStrings();

        test('lang 속성이 en으로 고정돼 있지 않다', () => {
            const match = html.match(/<html lang="([^"]+)"/);
            assert.ok(match, 'lang 속성이 없다');
            assert.ok(['ko', 'en'].includes(match![1]), `예상 밖의 lang: ${match![1]}`);
        });

        test('툴바 버튼이 번들 문자열을 쓴다 (하드코딩 영어 잔존 금지)', () => {
            assert.ok(html.includes(`>${strings.save}<`), 'Save 버튼이 번들을 쓰지 않는다');
            assert.ok(html.includes(`>${strings.reload}<`), 'Reload 버튼이 번들을 쓰지 않는다');
            assert.ok(html.includes(strings.addRow), 'Add Row 버튼이 번들을 쓰지 않는다');
        });

        test('아이콘 전용 버튼에 aria-label이 붙는다', () => {
            // ↶ / ↷ 는 글리프뿐이라 title만으로는 스크린리더 지원이 고르지 않다.
            for (const glyph of ['↶', '↷']) {
                const buttonMatch = html.match(new RegExp(`<button[^>]*>${glyph}</button>`));
                assert.ok(buttonMatch, `${glyph} 버튼을 찾지 못했다`);
                assert.ok(/aria-label="[^"]+"/.test(buttonMatch![0]),
                    `${glyph} 버튼에 aria-label이 없다: ${buttonMatch![0]}`);
            }
        });

        test('수정 표시와 오류 영역이 live region이다', () => {
            const modified = html.match(/<span class="modified-indicator"[^>]*>/);
            assert.ok(modified, '수정 표시 요소를 찾지 못했다');
            assert.ok(modified![0].includes('role="status"'), modified![0]);
            assert.ok(modified![0].includes('aria-live'), modified![0]);

            const error = html.match(/<div id="errorMsg"[^>]*>/);
            assert.ok(error![0].includes('role="alert"'),
                `오류 메시지는 즉시 읽혀야 한다: ${error![0]}`);
        });

        test('스크린리더 전용 상태 영역과 sr-only 스타일이 함께 존재한다', () => {
            assert.ok(/<div id="srStatus"[^>]*aria-live="polite"/.test(html));
            assert.ok(/\.sr-only\s*\{/.test(html), 'sr-only 클래스 정의가 없으면 텍스트가 화면에 노출된다');
        });
    });

    suite('행 재정렬 (키보드 경로)', () => {
        const html = render();

        test('드래그 핸들이 포커스 가능한 button으로 렌더된다', () => {
            assert.ok(html.includes('class="drag-grip"'),
                '핸들이 button이 아니면 키보드 포커스를 받을 수 없다');
            assert.ok(/data-move-row="' \+ rowIdx/.test(html) || html.includes('data-move-row='),
                'data-move-row 훅이 없다');
        });

        test('Alt+위/아래 처리기가 존재한다', () => {
            assert.ok(html.includes("'ArrowUp'") && html.includes("'ArrowDown'"), '방향키 처리가 없다');
            assert.ok(/if \(!e\.altKey/.test(html), 'Alt 조합으로 제한되지 않으면 셀 이동과 충돌한다');
        });

        test('이동 후 포커스를 옮긴 행으로 되돌리고 결과를 알린다', () => {
            assert.ok(html.includes('moved.focus()'),
                '재렌더 후 포커스를 복원하지 않으면 연속 이동이 불가능하다');
            assert.ok(html.includes('announce('), '이동 결과를 스크린리더에 알리지 않는다');
        });

        test('마우스 드래그 경로가 유지된다', () => {
            // 핸들을 button으로 바꾸면서 draggable을 잃으면 브라우저가 상위 행의
            // 드래그를 시작하지 않아 기존 마우스 사용자가 기능을 잃는다.
            assert.ok(/class="drag-grip" draggable="true"/.test(html),
                '그립 버튼이 draggable이 아니면 드래그 재정렬이 깨진다');
            assert.ok(html.includes("addEventListener('dragstart'"), 'dragstart 핸들러가 사라졌다');
        });
    });

    /**
     * 0.6.19가 남긴 두 가지 (0.6.31에서 처리).
     *
     * 1. **셀 편집 진입이 클릭 전용이었다.** 셀이 포커스를 받지 못해 키보드만
     *    으로는 값을 고칠 수 없었다 — 표를 읽을 수는 있으나 *편집기*로는 쓸 수
     *    없는 상태였다.
     * 2. **탭 패턴이 절반만 구현돼 있었다.** `role="tablist"` + `role="tab"`을
     *    붙이고 모든 탭에 `tabIndex=0`을 줬는데, ARIA tablist의 규약은 "Tab으로
     *    묶음에 진입, 화살표로 내부 이동"이다. 스크린리더는 규약대로 안내하지만
     *    화살표는 아무 동작도 하지 않았고, 탭이 무엇을 제어하는지도 알리지
     *    않았다. 부분 적용이 미적용보다 나쁠 수 있는 대표 사례다.
     */
    suite('셀 편집과 탭 패턴 (0.6.31)', () => {
        const html = render();

        test('셀이 포커스를 받고 키보드로 편집에 진입한다', () => {
            assert.ok(html.includes("view.setAttribute('tabindex', '0')"),
                '셀이 Tab 순서에 없으면 키보드로 편집을 시작할 수 없다');
            assert.ok(html.includes("view.setAttribute('role', 'button')"),
                '역할이 없으면 누를 수 있는 것인지 알 수 없다');
            assert.ok(/view\.addEventListener\('keydown'/.test(html),
                'tabindex만 주고 키 처리를 안 하면 포커스는 가지만 눌리지 않는다');
        });

        test('클릭과 키보드가 같은 진입 경로를 쓴다', () => {
            // 두 경로가 갈라지면 한쪽만 고쳐지는 회귀가 반복된다.
            assert.ok(html.includes('const beginEdit = () =>'), '편집 진입이 함수로 분리되지 않았다');
            assert.ok(html.includes("view.addEventListener('click', beginEdit)"), '클릭이 같은 함수를 쓰지 않는다');
        });

        test('편집 중인 셀에서는 재진입하지 않는다', () => {
            // 편집 중 input에서 누른 Enter가 올라오면 방금 연 셀을 다시 여는 셈이 된다.
            assert.ok(html.includes("if (td.classList.contains('editing')) { return; }"),
                '편집 중 가드가 없으면 Enter가 셀을 다시 연다');
        });

        test('roving tabindex — 활성 탭만 Tab 순서에 둔다', () => {
            assert.ok(html.includes('tab.tabIndex = idx === activeIdx ? 0 : -1'),
                '모든 탭이 tabIndex=0이면 tablist 규약(Tab 진입 + 화살표 이동)과 어긋난다');
        });

        test('화살표로 탭을 이동하고 양끝에서 순환한다', () => {
            assert.ok(/e\.key === 'ArrowRight'/.test(html) && /e\.key === 'ArrowLeft'/.test(html),
                '화살표 이동이 없으면 roving tabindex가 탭을 가둬 버린다');
            assert.ok(html.includes('% sheetMap.length'), '양끝 순환이 없다 (WAI-ARIA 권장 동작)');
        });

        test('탭과 패널이 서로를 가리킨다', () => {
            assert.ok(html.includes("tab.setAttribute('aria-controls', 'tableWrapper')"),
                '탭이 무엇을 제어하는지 알리지 않는다');
            assert.ok(/id="tableWrapper"[^>]*role="tabpanel"/.test(html),
                'role=tab이 가리키는 tabpanel이 없다');
            assert.ok(html.includes("panel.setAttribute('aria-labelledby', 'sheet-tab-' + activeIdx)"),
                '패널 이름이 활성 탭을 따라가지 않으면 내용과 어긋난다');
        });

        test('탭 전환 재렌더 후 포커스를 새 활성 탭으로 복원한다 (0.6.35)', () => {
            // renderTabs가 노드를 전부 새로 만들므로 포커스한 노드는 detach되고
            // 포커스가 body로 떨어진다. 복원이 없으면 화살표 이동이 한 번만
            // 동작하고 죽는다 — roving tabindex라 Tab으로도 못 돌아온다.
            assert.ok(
                html.includes('document.activeElement === document.body'),
                '포커스가 실제로 떨어졌는지 확인하지 않으면 마우스 사용자 포커스까지 뺏는다'
            );
            assert.ok(
                /tabsEl\.children\[activeIdx\][\s\S]{0,80}renewed\.focus\(\)/.test(html),
                '새 활성 탭으로 포커스를 복원하지 않는다'
            );
        });

        test('화살표 이동은 click만 부른다 (전환 무산 시 포커스가 현재 탭에 남도록)', () => {
            // focus 후 click하면 성공 시 그 노드가 detach돼 포커스가 죽고,
            // 셀 commit 거부로 무산되면 비활성 탭에 포커스가 남는다.
            assert.ok(
                !/nextTab\.focus\(\); nextTab\.click\(\)/.test(html),
                '이전의 focus-then-click 패턴이 되살아났다'
            );
            assert.ok(/if \(nextTab\) \{ nextTab\.click\(\); \}/.test(html));
        });

        test('탭이 하나뿐이면 끊긴 참조를 남기지 않는다', () => {
            // 탭 줄이 숨겨진 상태에서 aria-labelledby가 남으면 스크린리더가
            // 이름 없는 패널로 읽는다.
            assert.ok(html.includes("panel.removeAttribute('aria-labelledby')"),
                '탭이 없을 때 참조를 지우지 않는다');
        });
    });
});
