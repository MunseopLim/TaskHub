import * as assert from 'assert';
import { buildHexViewerHtml, buildHexViewerStrings } from '../hexViewer';
import { parseIntelHex } from '../hexParser';

/**
 * "Hex Viewer 웹뷰 지역화 / 접근성" (0.6.20).
 *
 * JSON Editor(0.6.19)와 같은 계약을 Hex Viewer에 적용한다. 여기서 특히
 * 문제였던 것은 폼 구조다 — `<label>Unit:</label>` 처럼 `for` 없이 떠 있는
 * 라벨은 스크린리더에서 select와 연결되지 않아, 사용자는 "콤보 상자"라는
 * 사실만 듣고 그게 무엇을 고르는 것인지 알 수 없었다. 찾기 결과 개수도
 * live region이 아니라 조용히 바뀌었다.
 */

const sample = parseIntelHex([':10000000000102030405060708090A0B0C0D0E0F78', ':00000001FF'].join('\n'));

function render(): string {
    return buildHexViewerHtml('firmware.hex', sample);
}

suite('Hex Viewer 웹뷰 지역화 / 접근성', () => {

    suite('문자열 번들', () => {
        const strings = buildHexViewerStrings();

        test('빈 문자열 없이 모든 키가 채워져 있다', () => {
            const empty = Object.entries(strings).filter(([, value]) => !value || !value.trim());
            assert.deepStrictEqual(empty, [], `비어 있는 문자열: ${empty.map(([k]) => k).join(', ')}`);
        });

        test('플레이스홀더 형식이 유지된다', () => {
            assert.ok(strings.statusSelected.includes('{n}'),
                `선택 바이트 수가 문구에서 빠진다: ${strings.statusSelected}`);
        });

        test('웹뷰가 참조하는 S.* 키가 모두 번들에 있다', () => {
            const html = render();
            const referenced = new Set(
                Array.from(html.matchAll(/\bS\.([A-Za-z][A-Za-z0-9]*)/g)).map(m => m[1])
            );
            assert.ok(referenced.size > 0, 'S.* 참조를 찾지 못했다');
            for (const key of referenced) {
                assert.ok(key in strings, `웹뷰가 참조하는 S.${key}가 번들에 없다`);
            }
        });
    });

    suite('폼 라벨 연결', () => {
        const html = render();

        test('Unit / Endian / Go to 라벨이 for 속성으로 컨트롤과 묶인다', () => {
            for (const id of ['unitSize', 'endian', 'gotoInput']) {
                assert.ok(new RegExp(`<label for="${id}"`).test(html),
                    `${id}에 연결된 <label for>가 없다 — 스크린리더가 컨트롤 이름을 읽지 못한다`);
                assert.ok(new RegExp(`id="${id}"`).test(html), `${id} 컨트롤이 없다`);
            }
        });

        test('for 없는 떠 있는 label이 남아 있지 않다', () => {
            const orphan = Array.from(html.matchAll(/<label(?![^>]*\bfor=)[^>]*>/g));
            assert.deepStrictEqual(orphan.map(m => m[0]), [],
                '컨트롤과 연결되지 않은 label이 남아 있다');
        });

        test('placeholder만 있는 입력에는 aria-label이 붙는다', () => {
            // placeholder는 접근 가능한 이름이 아니며 입력 시작과 동시에 사라진다.
            const findInput = html.match(/<input[^>]*id="findHexInput"[^>]*>/);
            assert.ok(findInput, '찾기 입력을 찾지 못했다');
            assert.ok(/aria-label="[^"]+"/.test(findInput![0]), findInput![0]);
        });

        test('찾기 방식 select에 접근 가능한 이름이 있다', () => {
            const select = html.match(/<select[^>]*id="findMode"[^>]*>/);
            assert.ok(/aria-label="[^"]+"/.test(select![0]), select![0]);
        });
    });

    suite('상태 알림', () => {
        const html = render();

        test('찾기 결과 개수가 live region으로 노출된다', () => {
            const findInfo = html.match(/<span class="find-info"[^>]*>/);
            assert.ok(findInfo, 'find-info 요소가 없다');
            assert.ok(findInfo![0].includes('aria-live="polite"'),
                `결과 개수가 조용히 바뀌면 스크린리더 사용자는 검색 성패를 알 수 없다: ${findInfo![0]}`);
        });

        test('상태 표시줄(바이트 검사 결과)이 live region이다', () => {
            const statusBar = html.match(/<div class="status-bar"[^>]*>/);
            assert.ok(statusBar![0].includes('role="status"'), statusBar![0]);
            assert.ok(statusBar![0].includes('aria-live'), statusBar![0]);
        });

        test('아이콘 전용 버튼(◀ ▶ ✕)에 aria-label이 있다', () => {
            for (const id of ['findPrev', 'findNext', 'findClose']) {
                const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
                assert.ok(button, `${id} 버튼을 찾지 못했다`);
                assert.ok(/aria-label="[^"]+"/.test(button![0]), `${id}에 aria-label이 없다: ${button![0]}`);
            }
        });
    });

    suite('검색 유효성', () => {
        const html = render();

        test('sparse HEX의 빈 주소를 검색 결과로 취급하지 않는다', () => {
            assert.ok(
                html.includes('if (!hasDataRange(i, bytes.length)) { continue; }'),
                'DATA의 gap 채움값만 비교하면 존재하지 않는 주소에서 FF가 검색된다'
            );
        });

        test('ASCII 범위를 벗어난 입력은 하위 바이트로 잘라 검색하지 않는다', () => {
            assert.ok(html.includes('S.findAsciiOnly'), '비 ASCII 입력 안내가 없다');
            assert.ok(html.includes('if (code > 0x7F) { return null; }'),
                'Unicode code unit의 하위 바이트를 ASCII로 오인할 수 있다');
        });

        test('대용량 검색은 이벤트 루프에 양보하고 새 검색으로 취소할 수 있다', () => {
            assert.ok(html.includes('async function doFind()'), '검색 루프가 동기 함수다');
            assert.ok(html.includes('await new Promise(resolve => setTimeout(resolve, 0))'),
                '긴 검색 중 웹뷰가 입력과 렌더링을 처리할 틈이 없다');
            assert.ok(html.includes('generation !== findGeneration'), '새 검색이 이전 검색을 중단하지 못한다');
        });
    });

    suite('표 구조', () => {
        const html = render();

        test('열 머리글에 scope="col"이 붙는다', () => {
            assert.ok(html.includes('class="addr-header" scope="col"'), '주소 열 머리글에 scope가 없다');
            assert.ok(html.includes('class="ascii-header" scope="col"'), 'ASCII 열 머리글에 scope가 없다');
        });

        test('구분용 빈 열은 aria-hidden으로 표에서 제외된다', () => {
            assert.ok(html.includes('class="group-sep" aria-hidden="true"'),
                '빈 구분 열이 읽히면 표 탐색이 불필요하게 길어진다');
            assert.ok(html.includes('class="ascii-sep" aria-hidden="true"'));
        });
    });

    suite('지역화', () => {
        const html = render();

        test('lang 속성이 en으로 고정돼 있지 않다', () => {
            const match = html.match(/<html lang="([^"]+)"/);
            assert.ok(match && ['ko', 'en'].includes(match[1]), `예상 밖의 lang: ${match?.[1]}`);
        });

        test('툴바와 헤더가 번들 문자열을 쓴다', () => {
            const strings = buildHexViewerStrings();
            assert.ok(html.includes(strings.unitLabel), 'Unit 라벨이 번들을 쓰지 않는다');
            assert.ok(html.includes(strings.gotoButton), 'Go 버튼이 번들을 쓰지 않는다');
            assert.ok(html.includes(strings.findButton), 'Find 버튼이 번들을 쓰지 않는다');
            assert.ok(html.includes(strings.statusHint), '상태 표시줄 안내가 번들을 쓰지 않는다');
        });

        test('기술 식별자는 번역하지 않고 그대로 둔다', () => {
            // 프로젝트 i18n 규칙: 짧은 기술 식별자와 예시 입력은 제외 대상.
            assert.ok(html.includes('Little-Endian'), 'Endian 값은 그대로 유지한다');
            assert.ok(html.includes('ASCII'), 'ASCII 열 이름은 그대로 유지한다');
            assert.ok(html.includes('placeholder="0x08000000 / 1024"'), '예시 입력은 그대로 유지한다');
        });
    });

    /**
     * 바이트 선택 (0.6.31).
     *
     * 0.6.20은 툴바·찾기 바·상태 표시줄의 접근성을 정리했지만, 정작 뷰어의
     * 본래 용도인 **바이트 선택은 클릭 전용**으로 남아 있었다. 마우스 없이는
     * 어떤 값도 검사할 수 없었으니, 표를 읽을 수는 있어도 뷰어로는 쓸 수 없는
     * 상태였다.
     *
     * 셀마다 `tabindex`를 주는 흔한 해법은 여기서 쓸 수 없다 — 행이 가상
     * 스크롤로 만들어졌다 사라지므로 Tab stop이 수천 개 생기고, 스크롤 밖으로
     * 나간 셀에 포커스가 남는다. 격자의 표준 패턴인 "단일 tab stop + 화살표
     * 이동"을 쓴다.
     */
    suite('바이트 선택 (0.6.31)', () => {
        const html = render();
        const strings = buildHexViewerStrings();

        test('격자가 단일 tab stop이고 이름과 역할을 갖는다', () => {
            const container = html.match(/<div class="hex-container" id="hexContainer"[^>]*>/);
            assert.ok(container, 'hexContainer를 찾지 못했다');
            assert.ok(container![0].includes('tabindex="0"'), `Tab이 닿지 않는다: ${container![0]}`);
            assert.ok(container![0].includes('role="grid"'), `역할이 없다: ${container![0]}`);
            assert.ok(/aria-label="[^"]+"/.test(container![0]), `접근 가능한 이름이 없다: ${container![0]}`);
        });

        test('격자 이름이 조작법을 알려 준다', () => {
            // 화살표로 움직인다는 사실은 화면에 보이지 않으므로, 이름이
            // 알려주지 않으면 스크린리더 사용자는 조작법을 알 길이 없다.
            assert.ok(
                /화살표|arrow/i.test(strings.gridLabel),
                `이동 방법이 안내되지 않는다: ${strings.gridLabel}`
            );
            assert.ok(
                /Shift/i.test(strings.gridLabel),
                `범위 선택 방법이 안내되지 않는다: ${strings.gridLabel}`
            );
        });

        test('화살표 · PageUp/Down · Home/End로 이동한다', () => {
            for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
                assert.ok(html.includes(`'${key}'`), `${key} 처리가 없다`);
            }
        });

        test('Shift와 함께 누르면 시작점을 고정한 채 범위를 넓힌다', () => {
            assert.ok(
                /if \(e\.shiftKey && selectedOffset >= 0\)[\s\S]{0,120}selectedEndOffset = next/.test(html),
                'Shift 확장이 Shift+클릭과 같은 의미로 동작하지 않는다'
            );
        });


        test('컨테이너 안의 폼 요소가 키를 먼저 가져간다', () => {
            // Go to 입력에서 누른 화살표까지 격자가 가로채면 입력이 불가능해진다.
            assert.ok(
                html.includes("tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'"),
                '폼 요소 가드가 없다'
            );
        });
    });
});
