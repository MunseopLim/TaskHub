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
});
