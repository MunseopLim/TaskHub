import * as assert from 'assert';
import { buildHexViewerHtml, buildHexViewerPayload } from '../hexViewer';
import { parseBinary, parseIntelHex } from '../hexParser';

/**
 * 웹뷰 데이터 전송 (0.6.42).
 *
 * 예전에는 바이트를 Base64 로 만들어 **HTML 문자열 안에 인라인**했다. 그
 * 경로는 같은 내용을 네 번 복제한다:
 *
 *   1. dense `Uint8Array` (원본)
 *   2. Base64 문자열 (원본의 1.33배)
 *   3. 그 문자열이 박힌 HTML (또 한 벌)
 *   4. 웹뷰의 `atob()` 결과 문자열 → 다시 `Uint8Array`
 *
 * 50MB 파일이면 peak 가 수백 MB 였다. `postMessage` 는 구조화 복제로
 * `Uint8Array` 를 그대로 보내므로 2~4가 사라지고, Base64 인코딩과 `atob`
 * 디코딩 비용도 함께 없어진다 — 메모리뿐 아니라 속도에서도 이득이다.
 *
 * 대가는 데이터가 한 프레임 늦게 온다는 것뿐이라, 그동안 "불러오는 중"을
 * 보여 준다. 빈 표를 그대로 두면 사용자가 "파일이 비었나"로 읽는다.
 */
suite('Hex Viewer 데이터 전송', () => {

    /** n 바이트짜리 binary 파싱 결과. */
    function binaryOf(n: number) {
        const buf = Buffer.alloc(n);
        for (let i = 0; i < n; i++) { buf[i] = i & 0xff; }
        return parseBinary(buf);
    }

    suite('HTML 이 데이터를 담지 않는다', () => {
        test('파일이 커져도 HTML 크기가 따라 커지지 않는다', () => {
            // 이것이 이 변경의 핵심 증거다. 예전에는 HTML 이 Base64 를 품어
            // 데이터 크기에 비례해 자랐다.
            const small = buildHexViewerHtml('small.bin', binaryOf(64));
            const large = buildHexViewerHtml('large.bin', binaryOf(512 * 1024));

            const growth = large.length - small.length;
            assert.ok(
                growth < 4096,
                `데이터가 512KB 늘었는데 HTML 이 ${growth} 바이트 늘었다 — 데이터가 HTML 에 박혀 있다`
            );
        });

        test('실제 바이트 값이 HTML 에 나타나지 않는다', () => {
            // 알아보기 쉬운 패턴을 넣고 그것이 HTML 에 없는지 본다.
            const marker = Buffer.from('ZZTASKHUBMARKERZZ');
            const html = buildHexViewerHtml('marker.bin', parseBinary(marker));
            assert.ok(
                !html.includes('ZZTASKHUBMARKERZZ'),
                '원본 바이트가 HTML 에 그대로 들어 있다'
            );
            assert.ok(
                !html.includes(marker.toString('base64')),
                'Base64 인코딩된 데이터가 HTML 에 남아 있다'
            );
        });

        test('atob 디코딩 경로가 사라졌다', () => {
            const html = buildHexViewerHtml('x.bin', binaryOf(32));
            assert.ok(!/\batob\(/.test(html), 'atob 호출이 남아 있다');
        });
    });

    suite('payload 내용', () => {
        test('binary 는 dense 데이터만 보내고 gap 은 없다', () => {
            // 전 구간이 채워져 있으므로 gap 비트맵이 의미가 없다.
            const payload = buildHexViewerPayload(binaryOf(256));
            assert.strictEqual(payload.data.length, 256);
            assert.strictEqual(payload.data[0], 0);
            assert.strictEqual(payload.data[255], 255);
            assert.strictEqual(payload.gap, undefined);
        });

        test('HEX 는 gap 비트맵을 함께 보낸다', () => {
            // 0x00 에 4바이트, 0x10 에 2바이트 — 사이가 비어 있다.
            const parsed = parseIntelHex([
                ':0400000001020304F2',
                ':020010001011CD',
                ':00000001FF',
            ].join('\n'));
            const payload = buildHexViewerPayload(parsed);

            assert.ok(payload.gap, 'HEX 인데 gap 비트맵이 없다');
            const has = (offset: number) =>
                (payload.gap![Math.floor(offset / 8)] & (1 << (offset % 8))) !== 0;

            assert.ok(has(0), 'offset 0 에 데이터가 있어야 한다');
            assert.ok(has(3), 'offset 3 에 데이터가 있어야 한다');
            assert.ok(!has(4), 'offset 4 는 빈 구간이다');
            assert.ok(!has(15), 'offset 15 는 빈 구간이다');
            assert.ok(has(16), 'offset 16 에 데이터가 있어야 한다');
        });

        test('gap 비트맵 크기가 데이터 길이에 맞는다', () => {
            const parsed = parseIntelHex([':0400000001020304F2', ':00000001FF'].join('\n'));
            const payload = buildHexViewerPayload(parsed);
            assert.strictEqual(payload.gap!.length, Math.ceil(payload.data.length / 8));
        });
    });

    suite('웹뷰가 메시지를 기다린다', () => {
        const html = buildHexViewerHtml('x.bin', binaryOf(32));

        test('hexData 메시지를 받아 렌더한다', () => {
            assert.ok(/msg\.command !== 'hexData'/.test(html), 'hexData 수신 경로가 없다');
            assert.ok(/dataArrived = true;[\s\S]{0,120}render\(\)/.test(html),
                '데이터 도착 후 첫 렌더를 하지 않는다');
        });

        test('도착 전에는 빈 배열이라 렌더 함수가 터지지 않는다', () => {
            // 어떤 렌더 경로가 메시지보다 먼저 불려도 예외 없이 빈 화면을 그려야 한다.
            assert.ok(/let DATA = new Uint8Array\(0\);/.test(html), 'DATA 초기값이 안전하지 않다');
            assert.ok(/let GAP_BITMAP = null;/.test(html));
        });

        test('불러오는 중 표시가 있고 스크린리더에도 전달된다', () => {
            const loading = html.match(/<div id="hexLoading"[^>]*>/);
            assert.ok(loading, 'hexLoading 요소가 없다 — 빈 표를 "파일이 비었나"로 읽게 된다');
            assert.ok(loading![0].includes('role="status"'), loading![0]);
            assert.ok(loading![0].includes('aria-live'), loading![0]);
        });

        test('데이터가 끝내 오지 않아도 안내가 바뀐다', () => {
            // 호스트 오류 등으로 메시지가 안 오면 무한 "불러오는 중"에 갇힌다.
            assert.ok(/if \(!dataArrived && loadingEl\)/.test(html), '실패 안내 경로가 없다');
            assert.ok(html.includes('S.loadFailed'), '실패 문구가 번들을 쓰지 않는다');
        });
    });
});
