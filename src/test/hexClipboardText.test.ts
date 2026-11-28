import * as assert from 'assert';
import { parseHexClipboardText, toLittleEndianTokens, uniformTokenUnit } from '../hexClipboardText';

const MAX = 1024;

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex').toUpperCase();
}

function parseOk(text: string) {
    const result = parseHexClipboardText(text, MAX);
    assert.ok(result.ok, `${JSON.stringify(text)} → ${JSON.stringify(result)}`);
    return result;
}

suite('클립보드 텍스트를 바이트로 읽기', () => {
    test('TaskHub 표시값처럼 여러 바이트로 묶인 값은 적힌 순서와 토큰 크기를 돌려주고 순서를 고르게 한다', () => {
        const result = parseOk('20000008 08000101');
        assert.strictEqual(result.format, 'hex');
        assert.strictEqual(hex(result.bytes), '2000000808000101');
        assert.deepStrictEqual(result.tokenSizes, [4, 4]);
        assert.strictEqual(result.orderFixed, false);
        assert.strictEqual(hex(toLittleEndianTokens(result.bytes, result.tokenSizes)), '0800002001010008');
        assert.strictEqual(uniformTokenUnit(result.tokenSizes), 4);

        // 선택이 단위 중간에서 끝나 마지막 값만 짧아도 같은 단위로 본다.
        const partial = parseOk('14131211 15');
        assert.strictEqual(hex(toLittleEndianTokens(partial.bytes, partial.tokenSizes)), '1112131415');
        assert.strictEqual(uniformTokenUnit(partial.tokenSizes), 4);
        assert.strictEqual(uniformTokenUnit(parseOk('1211 13121110').tokenSizes), 1);
    });

    test('바이트 목록·구분자·C 배열은 적힌 순서로 읽고 순서를 묻지 않는다', () => {
        for (const text of [
            '08 00 00 20',
            '08,00,00,20',
            '08:00:00:20',
            '08-00-00-20',
            '0x08, 0x00, 0x0, 0x20',
            'static const uint8_t data[] = {\n    0x08, 0x00, // SP\n    0x00u, 0x20 /* top */\n};',
        ]) {
            const result = parseOk(text);
            assert.strictEqual(hex(result.bytes), '08000020', text);
            assert.strictEqual(result.orderFixed, true, text);
        }
        assert.strictEqual(parseOk('{ 0x08, 0x20 };').format, 'cArray');
        // 값으로 볼 수 없는 긴 연속 Hex는 바이트열이다.
        assert.strictEqual(parseOk('080000200101000801').orderFixed, true);
    });

    test('xxd는 주소와 ASCII 열을 걸러 내고, ASCII 열의 Hex처럼 보이는 글자를 바이트로 읽지 않는다', () => {
        const result = parseOk([
            '00000000: 0800 0020 0101 0008 0102 0008 0103 0008  ... ............',
            '00000010: 0001 0203 0405 0607 0809 0a0b 0c0d 0e0f  ................',
            '00000020: 5461 736b 4875 6220 4865 7820 436f 7079  TaskHub Hex Copy',
            '00000030: cafe babe                                cafe',
        ].join('\n'));
        assert.strictEqual(result.format, 'xxd');
        assert.strictEqual(result.bytes.length, 52);
        assert.strictEqual(hex(result.bytes.subarray(0, 4)), '08000020');
        assert.strictEqual(hex(result.bytes.subarray(32, 36)), '5461736B');
        assert.strictEqual(hex(result.bytes.subarray(48)), 'CAFEBABE');
        assert.strictEqual(result.orderFixed, true, 'xxd의 묶음은 값이 아니라 적힌 바이트 순서다');
    });

    test('hexdump -C는 가운데 두 칸 공백을 지나 읽고, ASCII 열과 주소만 있는 마지막 줄은 건너뛴다', () => {
        const result = parseOk([
            '00000000  08 00 00 20 01 01 00 08  01 02 00 08 01 03 00 08  |... ............|',
            '00000010  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|',
            '00000020  54 61 73 6b 48 75 62 20                           |TaskHub |',
            '00000028',
        ].join('\r\n'));
        assert.strictEqual(result.format, 'hexdump');
        assert.strictEqual(result.bytes.length, 40);
        assert.strictEqual(hex(result.bytes.subarray(8, 12)), '01020008');
        assert.strictEqual(hex(result.bytes.subarray(32)), '5461736B48756220');
    });

    test('디버거·gdb 메모리 창은 주소를 걸러 내고 ASCII 열이 있을 때만 자른다', () => {
        const gdb = parseOk('0x20000000 <buffer>:\t0x20000008\t0x08000101\n0x20000008 <buffer+8>:\t0x08000201\t0x08000301');
        assert.strictEqual(gdb.format, 'memory');
        assert.deepStrictEqual(gdb.tokenSizes, [4, 4, 4, 4]);
        assert.strictEqual(gdb.orderFixed, false);
        assert.strictEqual(hex(toLittleEndianTokens(gdb.bytes, gdb.tokenSizes)).slice(0, 16), '0800002001010008');

        assert.strictEqual(hex(parseOk('0x20000000: 08 00 00 20  01 01 00 08').bytes), '0800002001010008',
            '두 칸으로 띄운 Hex 열을 ASCII로 잘못 잘라 버리지 않는다');
        assert.strictEqual(hex(parseOk('0x20000000: 08 00 00 20 54 61  ... Ta').bytes), '080000205461');
    });

    test('읽을 수 없는 입력은 줄·글자 위치와 이유를 알려 준다', () => {
        assert.deepStrictEqual(parseHexClipboardText('08 00 G0', MAX), { ok: false, reason: 'invalid-character', line: 1, column: 7 });
        assert.deepStrictEqual(parseHexClipboardText('08 00\n00 2', MAX), { ok: false, reason: 'odd-digits', line: 2, column: 4 });
        assert.deepStrictEqual(parseHexClipboardText('08 0x', MAX), { ok: false, reason: 'missing-byte', line: 1, column: 4 });
        // 다른 프로그램에서 Hex와 ASCII 열을 함께 드래그해 복사한 텍스트
        assert.deepStrictEqual(parseHexClipboardText('08\t00\t.\t.', MAX), { ok: false, reason: 'invalid-character', line: 1, column: 7 });
        assert.deepStrictEqual(parseHexClipboardText('  \n ', MAX), { ok: false, reason: 'empty' });
        assert.deepStrictEqual(parseHexClipboardText('00'.repeat(MAX + 1), MAX), { ok: false, reason: 'too-large' });
        assert.deepStrictEqual(parseHexClipboardText(' '.repeat(MAX * 8 + 1), MAX), { ok: false, reason: 'too-large' });
    });
});
