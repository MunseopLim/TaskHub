import * as assert from 'assert';
import { buildHexViewerHtml } from '../hexViewer';
import { parseIntelHex } from '../hexParser';

/**
 * 파일 끝의 불완전한 unit (0.6.36).
 *
 * 2/4/8-byte unit 모드에서 파일 길이가 unit 의 배수가 아니면 마지막 unit 이
 * 덜 찬다. 이 경계를 세 번에 걸쳐 잘못 다뤘다.
 *
 *   - **~0.6.34**: 완전한 unit 에만 셀을 만들었다. 18바이트 파일의 4-byte
 *     모드에서 offset 16 셀이 아예 없어, 키보드 End / Go to / Find 가
 *     존재하지 않는 위치를 가리켰다 — 상태 표시줄만 바뀌고 선택 표시가
 *     사라졌다.
 *   - **0.6.35**: 키보드 핸들러에만 clamp 를 넣었다. Go to 는 그대로였다.
 *   - **0.6.36 초안**: clamp 를 `jumpToOffset` 으로 옮겼다. 이번엔 **요청한
 *     주소를 조용히 바꿨다** — Go to 17 → 12, Go to 15 → 12. Find 도 같은
 *     함수를 타므로 끝부분 검색 결과가 엉뚱한 위치를 가리켰다. 존재하지 않는
 *     셀을 고르는 것보다 나쁜 동작이다.
 *
 * 결론: **표현할 수 있는 것을 표현한다.** 남은 바이트만으로 값을 읽어 셀을
 * 그리면 파일 안의 모든 unit 경계에 셀이 존재하므로 clamp 자체가 필요 없다.
 *
 * 정렬 로직과 달리 이 부분은 **호스트가 만드는 정적 HTML** 에 드러나므로
 * (셀 생성 코드가 스크립트 안이라 렌더 결과는 아니지만, 경계 계산과 clamp
 * 부재는 소스로 확인할 수 있다) 아래는 두 축을 나눠 본다:
 * 데이터 경계 계산은 순수 함수로, clamp 부재는 스크립트로.
 */
suite('Hex Viewer — 파일 끝의 불완전한 unit', () => {

    /**
     * `unitBytesAt` 과 같은 규칙. 웹뷰 스크립트 안의 함수를 여기서 직접 부를
     * 수 없으므로 계약을 복제해 **경계 규칙 자체**를 고정한다. 스크립트가 이
     * 규칙을 벗어나면 아래 소스 검사가 잡는다.
     */
    function unitBytesAt(totalSize: number, unitSize: number, offset: number): number {
        return Math.max(0, Math.min(unitSize, totalSize - offset));
    }

    /** 선택 가능한 마지막 offset — 마지막 unit 셀의 시작. */
    function lastSelectableOffset(totalSize: number, unitSize: number): number {
        if (totalSize <= 0) { return -1; }
        return Math.floor((totalSize - 1) / unitSize) * unitSize;
    }

    suite('경계 계산', () => {
        test('18바이트 파일 · 4-byte unit — 마지막 셀은 offset 16, 2바이트', () => {
            assert.strictEqual(lastSelectableOffset(18, 4), 16, '마지막 unit 셀이 16이어야 한다');
            assert.strictEqual(unitBytesAt(18, 4, 16), 2, '남은 2바이트만 읽어야 한다');
            assert.strictEqual(unitBytesAt(18, 4, 12), 4, '완전한 unit 은 종전대로 4바이트');
        });

        test('파일 길이가 unit 의 배수면 불완전한 셀이 없다', () => {
            assert.strictEqual(lastSelectableOffset(16, 4), 12);
            assert.strictEqual(unitBytesAt(16, 4, 12), 4);
        });

        test('파일이 unit 하나보다 작아도 셀이 존재한다', () => {
            // 예전에는 이 경우 아무 셀도 없어 Go to 가 통째로 무반응이었다.
            assert.strictEqual(lastSelectableOffset(2, 4), 0, '0 에 셀이 있어야 한다');
            assert.strictEqual(unitBytesAt(2, 4, 0), 2);
        });

        test('빈 파일은 선택 가능한 offset 이 없다', () => {
            assert.strictEqual(lastSelectableOffset(0, 4), -1);
            assert.strictEqual(unitBytesAt(0, 4, 0), 0);
        });

        test('1-byte unit 에서는 언제나 완전하다', () => {
            assert.strictEqual(lastSelectableOffset(18, 1), 17);
            assert.strictEqual(unitBytesAt(18, 1, 17), 1);
        });

        test('모든 unit 경계가 셀을 갖는다 (clamp 가 필요 없는 근거)', () => {
            // 파일 안의 어떤 주소든, 그 주소를 담은 unit 셀이 존재해야
            // Go to / Find 가 주소를 바꾸지 않고 이동할 수 있다.
            for (const total of [1, 2, 3, 15, 16, 17, 18, 31, 33]) {
                for (const unit of [1, 2, 4, 8]) {
                    const last = lastSelectableOffset(total, unit);
                    for (let addr = 0; addr < total; addr++) {
                        const cellStart = Math.floor(addr / unit) * unit;
                        assert.ok(
                            cellStart <= last,
                            `total=${total} unit=${unit} addr=${addr}: 담을 셀(${cellStart})이 마지막 셀(${last})을 넘는다`
                        );
                        assert.ok(
                            unitBytesAt(total, unit, cellStart) > 0,
                            `total=${total} unit=${unit} addr=${addr}: 셀에 바이트가 없다`
                        );
                    }
                }
            }
        });
    });

    suite('구현이 그 규칙을 따른다', () => {
        // 18바이트 — 4/8-byte unit 에서 불완전한 꼬리가 생긴다.
        const parsed = parseIntelHex([
            ':10000000000102030405060708090A0B0C0D0E0F78',
            ':020010001011CD',
            ':00000001FF',
        ].join('\n'));
        const html = buildHexViewerHtml('tail.hex', parsed);

        test('전제: 픽스처가 unit 배수가 아닌 크기다', () => {
            assert.strictEqual(parsed.maxAddress - parsed.minAddress + 1, 18);
        });

        test('불완전한 unit 도 셀을 만든다', () => {
            assert.ok(html.includes('function unitBytesAt(offset)'), '남은 바이트 계산 함수가 없다');
            assert.ok(
                /const availableBytes = unitBytesAt\(byteOffset\);[\s\S]{0,80}if \(availableBytes > 0\)/.test(html),
                '완전한 unit 만 렌더하는 옛 조건이 남아 있다'
            );
            assert.ok(
                !html.includes('if (byteOffset + unitSize <= TOTAL_SIZE) {'),
                '완전한 unit 조건이 되살아났다 — 꼬리 셀이 사라진다'
            );
            assert.ok(html.includes("td.classList.add('partial-unit')"), '불완전한 셀 표시가 없다');
        });

        test('jumpToOffset 이 요청한 주소를 바꾸지 않는다', () => {
            // 이 clamp 가 되살아나면 Go to 와 Find 가 조용히 다른 주소로 간다.
            assert.ok(
                !/offset = Math\.min\(offset, maxOffset\)/.test(html),
                'jumpToOffset 이 입력 주소를 clamp 한다 — Go to 17 이 12 로 바뀐다'
            );
            assert.ok(
                !/const maxOffset = lastSelectableOffset\(\);/.test(html),
                'clamp 용 경계 계산이 jumpToOffset 에 남아 있다'
            );
        });

        test('키보드 이동은 여전히 파일 끝을 넘지 않는다', () => {
            // clamp 를 없앤 것은 "요청 주소를 바꾸지 말라"는 뜻이지,
            // 화살표가 파일 밖으로 나가도 된다는 뜻이 아니다.
            assert.ok(html.includes('const lastUnitStart = lastSelectableOffset();'));
            assert.ok(html.includes('Math.min(next, lastUnitStart)'));
        });
    });
});
