import * as assert from 'assert';
import { HEX_MAX_BYTE_ENTRIES } from '../hexParser';
import { HEX_VIEWER_MAX_FILE_SIZE, localizeHexParseError } from '../hexViewer';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 파서 entry 상한과 파일 크기 상한의 관계 (0.6.41).
 *
 * `HEX_MAX_BYTE_ENTRIES` 는 주소별 고유 바이트 수 상한이다.
 * 여기서 entry 하나는 **주소 하나에 담긴 바이트 하나**이며, 이 저장소는
 * **HEX/SREC 전용**이다 (binary 는 `rawBuffer` 를 쓴다).
 *
 * 이전 값 100M 은 **어떤 입력으로도 도달할 수 없는 숫자**였다. HEX/SREC 는
 * 텍스트 포맷이라 1바이트를 최소 2자 + 레코드 오버헤드로 적으므로, 50MB 파일
 * 상한을 통과한 입력이 만들 수 있는 entry 는 최대 약 25M 이다. 즉 그 상한은
 * 방어 구실을 한 적이 없고, 딸린 주석의 "최악 1.6GB" 계산도 파일 상한을
 * 고려하지 않은 값이었다.
 *
 * 두 상수는 **함께 움직여야 의미가 있다.** 파일 상한만 올리면 파서 상한이
 * 조용히 무력해지고, 파서 상한만 내리면 정상 파일이 거부된다. 그 관계를
 * 여기서 고정한다.
 */
suite('Hex 파서 상한과 파일 상한의 관계', () => {

    /**
     * 1바이트를 적는 데 필요한 최소 문자 수.
     *
     * Intel HEX 한 레코드: `:` + LL(2) + AAAA(4) + TT(2) + data(2n) + CC(2)
     * + CRLF(2) = 13 + 2n 자로 n 바이트. n 이 클수록 바이트당 비용이 낮아지고,
     * 데이터 필드 길이는 1바이트 필드라 최대 255다.
     *
     * SREC(S3) 는 `S3` + LL(2) + AAAAAAAA(8) + data(2n) + CC(2) + CRLF(2)
     * = 16 + 2n, 최대 n=253 → 2.06자/바이트로 Intel HEX 와 거의 같다.
     */
    const MIN_CHARS_PER_BYTE = (13 + 2 * 255) / 255;   // ≈ 2.05

    /** 파일 상한을 통과한 HEX/SREC 가 만들 수 있는 최대 entry 수. */
    function reachableMaxEntries(): number {
        return Math.floor(HEX_VIEWER_MAX_FILE_SIZE / MIN_CHARS_PER_BYTE);
    }

    test('상한이 도달 가능한 최대치보다 크다 (정상 파일을 거부하지 않는다)', () => {
        assert.ok(
            HEX_MAX_BYTE_ENTRIES > reachableMaxEntries(),
            `파서 상한(${HEX_MAX_BYTE_ENTRIES})이 도달 가능 최대치(${reachableMaxEntries()})보다 작다. ` +
            '50MB 안의 정상 HEX 파일이 거부된다.'
        );
    });

    test('상한이 도달 가능한 최대치의 2배를 넘지 않는다 (backstop 구실을 한다)', () => {
        // 여유가 지나치면 옛 100M 처럼 "있으나 마나"가 된다. 파일 상한이
        // 완화됐을 때 파서가 실제로 제동을 걸 수 있는 범위에 둔다.
        assert.ok(
            HEX_MAX_BYTE_ENTRIES <= reachableMaxEntries() * 2,
            `파서 상한(${HEX_MAX_BYTE_ENTRIES})이 도달 가능 최대치(${reachableMaxEntries()})의 2배를 넘는다. ` +
            '어떤 입력으로도 걸리지 않아 방어 구실을 못 한다.'
        );
    });

    test('옛 값(100M)은 이 관계를 만족하지 않는다 (회귀 형태 고정)', () => {
        // 왜 바꿨는지를 숫자로 남긴다. 누군가 되돌리면 위 검사가 잡는다.
        const OLD = 100 * 1024 * 1024;
        assert.ok(
            OLD > reachableMaxEntries() * 2,
            '옛 값이 도달 불가능했다는 전제가 깨졌다 — 파일 상한이 크게 바뀌었는지 확인할 것'
        );
    });

    test('entry 상한은 페이지 저장소를 쓰는 HEX/SREC 에만 해당한다', () => {
        // binary 는 rawBuffer(Uint8Array)를 쓰므로 이 상한과 무관하다.
        // 파일 상한 50MB 가 binary 의 유일한 제동 장치다.
        assert.strictEqual(HEX_VIEWER_MAX_FILE_SIZE, 50 * 1024 * 1024);
    });
});

suite('HEX 한도 초과 오류의 사용자 언어 표시', () => {
    test('hexParser·hexByteStore 의 한도 문구를 한국어로 옮기고 모르는 문구는 그대로 둔다', () => {
        const original = Object.getOwnPropertyDescriptor(vscode.env, 'language');
        Object.defineProperty(vscode.env, 'language', { value: 'ko', configurable: true });
        try {
            assert.strictEqual(localizeHexParseError('Intel HEX payload exceeds 1000 byte entries; refusing to load.'),
                'Intel HEX 데이터가 1000바이트 한도를 넘어 열지 않았습니다.');
            assert.strictEqual(localizeHexParseError('SREC payload exceeds 5 byte entries; refusing to load.'),
                'SREC 데이터가 5바이트 한도를 넘어 열지 않았습니다.');
            assert.match(localizeHexParseError('HEX/SREC sparse storage exceeds 64 bytes; refusing to load.'), /저장 한도\(64바이트\)/);
            assert.strictEqual(localizeHexParseError('something else'), 'something else');
            // 원문이 바뀌면 번역이 조용히 빠진다 — 실제 파서 소스의 문구로 고정한다(한도까지 채우기엔 너무 크다).
            const root = path.resolve(__dirname, '..', '..', 'src');
            const parserSource = fs.readFileSync(path.join(root, 'hexParser.ts'), 'utf8');
            const storeSource = fs.readFileSync(path.join(root, 'hexByteStore.ts'), 'utf8');
            for (const format of ['Intel HEX', 'SREC']) {
                assert.ok(parserSource.includes('`' + format + ' payload exceeds ${HEX_MAX_BYTE_ENTRIES} byte entries; refusing to load.`'), format);
            }
            assert.ok(storeSource.includes('`HEX/SREC sparse storage exceeds ${this.storageLimit} bytes; refusing to load.`'));
        } finally {
            if (original) { Object.defineProperty(vscode.env, 'language', original); }
        }
    });
});
