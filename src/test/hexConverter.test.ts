import * as assert from 'assert';
import {
    buildHexConverterValueRows,
    decodeHexConverterBytes,
    encodeHexConverterText,
    formatHexConverterBytes,
    HEX_CONVERTER_MAX_BYTES,
    parseHexConverterInput,
} from '../hexConverterUtils';

suite('Hex/Text 변환 순수 로직', () => {
    test('compact, 구분자, 0x 표기를 같은 바이트로 읽는다', () => {
        for (const input of ['48656c6c6f', '48 65 6c 6c 6f', '0x48, 0x65-0x6c_6c:6f']) {
            const result = parseHexConverterInput(input, 1024);
            assert.strictEqual(result.ok, true, input);
            if (result.ok) {
                assert.deepStrictEqual(Array.from(result.bytes), [0x48, 0x65, 0x6c, 0x6c, 0x6f]);
                assert.strictEqual(formatHexConverterBytes(result.bytes), '48 65 6C 6C 6F');
            }
        }
    });

    test('Hex 출력을 1·2·4바이트 단위로 묶고 불완전한 마지막 단위도 표시한다', () => {
        const bytes = Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
        assert.strictEqual(formatHexConverterBytes(bytes, 1), '48 65 6C 6C 6F');
        assert.strictEqual(formatHexConverterBytes(bytes, 2), '4865 6C6C 6F');
        assert.strictEqual(formatHexConverterBytes(bytes, 4), '48656C6C 6F');
        const twoRows = Uint8Array.from({ length: 10 }, (_, index) => index);
        assert.strictEqual(
            formatHexConverterBytes(twoRows, 2, 8),
            '0001 0203 0405 0607\n0809'
        );
    });

    test('잘못된 문자, 빈 0x, 홀수 자릿수와 크기 초과를 구분한다', () => {
        assert.deepStrictEqual(parseHexConverterInput('41 G2', 10), {
            ok: false, reason: 'invalid-character', index: 3,
        });
        assert.deepStrictEqual(parseHexConverterInput('10x2', 10), {
            ok: false, reason: 'invalid-character', index: 2,
        });
        assert.deepStrictEqual(parseHexConverterInput('0x 41', 10), {
            ok: false, reason: 'missing-byte', index: 2,
        });
        assert.deepStrictEqual(parseHexConverterInput('ABC', 10), {
            ok: false, reason: 'odd-digits',
        });
        assert.deepStrictEqual(parseHexConverterInput('0001', 1), {
            ok: false, reason: 'too-large',
        });
    });

    test('UTF-8 한글과 emoji가 왕복한다', () => {
        const source = '안녕 👋';
        const encoded = encodeHexConverterText(source, 'utf8', HEX_CONVERTER_MAX_BYTES);
        assert.strictEqual(encoded.ok, true);
        if (!encoded.ok) { return; }
        assert.deepStrictEqual(
            Array.from(encoded.bytes),
            Array.from(Buffer.from(source, 'utf8')),
            '브라우저 TextEncoder와 Node UTF-8 결과가 같아야 한다'
        );
        assert.deepStrictEqual(decodeHexConverterBytes(encoded.bytes, 'utf8'), { ok: true, text: source });
    });

    test('ASCII 범위 밖 문자와 바이트를 조용히 대체하지 않는다', () => {
        assert.deepStrictEqual(encodeHexConverterText('A한', 'ascii', 10), {
            ok: false, reason: 'non-ascii-character', index: 1,
        });
        assert.deepStrictEqual(decodeHexConverterBytes(Uint8Array.from([0x41, 0x80]), 'ascii'), {
            ok: false, reason: 'non-ascii-byte', index: 1,
        });
        assert.deepStrictEqual(decodeHexConverterBytes(Uint8Array.from([0xc3, 0x28]), 'utf8'), {
            ok: false, reason: 'invalid-utf8',
        });
    });

    test('ASCII 최대 입력을 인자 개수 오류 없이 디코딩한다', () => {
        const bytes = new Uint8Array(HEX_CONVERTER_MAX_BYTES).fill(0x41);
        const decoded = decodeHexConverterBytes(bytes, 'ascii');
        assert.strictEqual(decoded.ok, true);
        if (decoded.ok) {
            assert.strictEqual(decoded.text.length, HEX_CONVERTER_MAX_BYTES);
            assert.strictEqual(decoded.text[decoded.text.length - 1], 'A');
        }
    });

    test('Endian 선택이 첫 바이트가 아닌 다중 바이트 값에만 적용된다', () => {
        const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        const little = Object.fromEntries(buildHexConverterValueRows(bytes, 'little').map(row => [row.key, row.value]));
        const big = Object.fromEntries(buildHexConverterValueRows(bytes, 'big').map(row => [row.key, row.value]));

        assert.strictEqual(little.u8, '1');
        assert.strictEqual(big.u8, '1');
        assert.strictEqual(little.u16, '513');
        assert.strictEqual(big.u16, '258');
        assert.strictEqual(little.u32, '67305985');
        assert.strictEqual(big.u32, '16909060');
        assert.strictEqual(little.u64, '578437695752307201');
        assert.strictEqual(big.u64, '72623859790382856');
        assert.ok('float32' in little && 'float64' in little);
    });

    test('Float32/64는 인접 bit pattern을 구분할 수 있는 왕복 안전 정밀도를 쓴다', () => {
        const float32Buffer = new ArrayBuffer(4);
        new DataView(float32Buffer).setFloat32(0, 0.1, true);
        const float32 = Object.fromEntries(
            buildHexConverterValueRows(new Uint8Array(float32Buffer), 'little').map(row => [row.key, row.value])
        );
        assert.strictEqual(float32.float32, '0.100000001');

        const float64Buffer = new ArrayBuffer(8);
        new DataView(float64Buffer).setFloat64(0, 0.1, true);
        const float64 = Object.fromEntries(
            buildHexConverterValueRows(new Uint8Array(float64Buffer), 'little').map(row => [row.key, row.value])
        );
        assert.strictEqual(float64.float64, '0.10000000000000001');
    });

    test('바이트가 부족한 해석은 값 행에 만들지 않는다', () => {
        assert.deepStrictEqual(buildHexConverterValueRows(new Uint8Array(), 'little'), []);
        assert.deepStrictEqual(
            buildHexConverterValueRows(Uint8Array.from([0xff]), 'little'),
            [{ key: 'u8', value: '255' }, { key: 'i8', value: '-1' }]
        );
    });
});
