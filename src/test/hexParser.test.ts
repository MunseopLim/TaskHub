import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    detectFormat,
    parseIntelHex,
    parseSrec,
    parseBinary,
    toFlatArray,
    hasData,
} from '../hexParser';
import {
    parseFile,
    buildHexViewerHtml,
    assertWithinHexViewerSpan,
    HEX_VIEWER_MAX_SPAN,
    parseHexViewerGoToOffset,
    computeHexViewerScrollScale,
    HEX_VIEWER_SAFE_MAX_HEIGHT,
    hexCellOverlapsSelection,
} from '../hexViewer';

suite('HexParser Test Suite', () => {

    suite('detectFormat', () => {
        test('should detect Intel HEX format', () => {
            assert.strictEqual(detectFormat(':020000040800F2\n:10000000...'), 'intel');
        });

        test('should detect SREC format', () => {
            assert.strictEqual(detectFormat('S0030000FC\nS1130000...'), 'srec');
        });

        test('should detect binary for non-text content', () => {
            assert.strictEqual(detectFormat(Buffer.from([0x00, 0x20, 0xFF])), 'binary');
        });

        test('should detect binary for unknown text', () => {
            assert.strictEqual(detectFormat('just some random text'), 'binary');
        });

        test('should not misdetect binary with S[0-9] in middle lines as SREC', () => {
            // Binary data converted to string may contain lines starting with S followed by a digit
            const binaryLikeText = 'random data here\nS3 looks like SREC but is not\nmore data';
            assert.strictEqual(detectFormat(binaryLikeText), 'binary');
        });

        /**
         * **첫 글자만 보면 바이너리가 텍스트로 넘어간다.** `:` 은 0x3A, `S0` 은
         * 0x53 0x30 이라 우연히 그렇게 시작하는 펌웨어 이미지가 실제로 있다.
         * 넘어가면 파서가 레코드를 하나도 못 읽어 **빈 뷰어**가 뜨고, 사용자는
         * 파일이 비었다고 오해한다. 첫 레코드가 통째로 유효할 때만 넘긴다.
         */
        test('첫 바이트가 `:` 인 바이너리를 Intel HEX 로 오인하지 않는다', () => {
            assert.strictEqual(detectFormat(Buffer.from([0x3A, 0x00, 0xFF]).toString('utf-8')), 'binary');
        });

        test('첫 바이트가 `S0` 인 바이너리를 SREC 로 오인하지 않는다', () => {
            assert.strictEqual(detectFormat(Buffer.from([0x53, 0x30, 0x01, 0x02]).toString('utf-8')), 'binary');
        });

        test('길이는 맞지만 체크섬이 틀린 첫 레코드는 텍스트로 넘기지 않는다', () => {
            // 체크섬을 F2 → F3 으로 한 글자만 바꿨다. 길이 검사만으로는 통과한다.
            assert.strictEqual(detectFormat(':020000040800F3\n:10000000...'), 'binary');
            // SREC 도 같다 (FC → FD).
            assert.strictEqual(detectFormat('S0030000FD\nS1130000...'), 'binary');
        });

        test('레코드가 잘려 있으면 텍스트로 넘기지 않는다', () => {
            // byteCount 는 0x10 인데 데이터가 그만큼 없다.
            assert.strictEqual(detectFormat(':10000000AABB'), 'binary');
        });

        test('16진수가 아닌 글자가 섞이면 텍스트로 넘기지 않는다', () => {
            // `parseInt` 는 앞부분만 읽고 성공하므로 자릿수 검사가 필요하다.
            assert.strictEqual(detectFormat(':0Z0000040800F2'), 'binary');
        });

        /**
         * 파서는 깨진 레코드를 건너뛰고 나머지를 읽는다. 첫 줄로만 판정하면
         * 첫 줄만 상한 HEX 파일이 갑자기 바이너리로 보인다 — 지금까지 정상으로
         * 열리던 파일이다. 그래서 앞 몇 줄 안에 유효한 레코드가 하나라도
         * 있으면 텍스트로 본다.
         */
        test('첫 줄이 깨졌어도 뒤에 유효한 레코드가 있으면 HEX 로 본다', () => {
            assert.strictEqual(detectFormat([
                ':020000040800F3',       // 체크섬 틀림 (F2 여야 한다)
                ':0400000000200008D4',   // 유효
            ].join('\n')), 'intel');
        });

        test('SREC 도 같다', () => {
            assert.strictEqual(detectFormat([
                'S0030000FD',            // 체크섬 틀림 (FC 여야 한다)
                'S107000001020304EE',    // 유효
            ].join('\n')), 'srec');
        });

        test('유효한 레코드가 하나도 없으면 앞 몇 줄을 다 봐도 바이너리다', () => {
            const allBroken = Array.from({ length: 12 }, () => ':020000040800F3').join('\n');
            assert.strictEqual(detectFormat(allBroken), 'binary');
        });

        test('S1 로 시작하는 SREC (S0 헤더가 없는 파일)', () => {
            assert.strictEqual(detectFormat('S107000001020304EE'), 'srec');
        });

        test('소문자 16진수와 CRLF 도 받는다', () => {
            assert.strictEqual(detectFormat(':0400000000200008d4\r\n:00000001FF'), 'intel');
            assert.strictEqual(detectFormat('S107000001020304ee\r\nS9030000FC'), 'srec');
        });

        test('완전한 레코드 뒤에 군더더기가 붙어도 받는다', () => {
            // 길이는 `expectedLength` 로 판정하므로 뒤에 붙은 것은 무시된다.
            assert.strictEqual(detectFormat(':020000040800F2   ; comment'), 'intel');
        });
    });

    suite('parseIntelHex', () => {
        test('should parse simple data record', () => {
            // :0A0000000102030405060708090ABF
            // Byte count=0A, Address=0000, Type=00 (data), Data=01..0A, Checksum=BF
            const line = ':0A0000000102030405060708090ABF';
            const result = parseIntelHex(line);
            assert.strictEqual(result.format, 'intel');
            assert.strictEqual(result.byteCount, 10);
            assert.strictEqual(result.minAddress, 0);
            assert.strictEqual(result.maxAddress, 9);
            assert.strictEqual(result.data.get(0), 0x01);
            assert.strictEqual(result.data.get(9), 0x0A);
        });

        test('should handle Extended Linear Address record', () => {
            // Set base address to 0x08000000
            const lines = [
                ':020000040800F2',              // Extended Linear Address: 0x0800
                ':04000000AABBCCDDCA',          // 4 bytes at 0x08000000 (checksum adjusted)
                ':00000001FF'                    // EOF
            ].join('\n');

            // Manually calculate: 02+00+00+04+08+00 = 0E, checksum = 0x100 - 0x0E = 0xF2 ✓
            // 04+00+00+00+AA+BB+CC+DD = sum, checksum must make sum+check ≡ 0 mod 256
            // We need correct checksums. Let me recalculate.
            // Line 2: byteCount=04, addr=0000, type=00, data=AA BB CC DD
            // sum = 04+00+00+00+AA+BB+CC+DD = 04+AA+BB+CC+DD
            //     = 4+170+187+204+221 = 786 = 0x312
            // checksum = (-0x312) & 0xFF = 0xEE ... let me recompute
            // Actually the checksum in the test data might be wrong. Let me use proper data.

            const properLines = [
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n');

            const result = parseIntelHex(properLines);
            assert.strictEqual(result.minAddress, 0x08000000);
            assert.strictEqual(result.data.get(0x08000000), 0x00);
            assert.strictEqual(result.data.get(0x08000001), 0x20);
            assert.strictEqual(result.data.get(0x08000002), 0x00);
            assert.strictEqual(result.data.get(0x08000003), 0x08);
        });

        test('should handle ELA >= 0x8000 without sign overflow (upper-half addresses)', () => {
            // M2 회귀 가드: `parseInt(...) << 16`은 32비트 부호 있는 시프트라
            // ELA ≥ 0x8000(예: STM32 QSPI 0x90000000)이 음수 베이스가 되어
            // minAddress/maxAddress/toFlatArray가 전부 깨졌다.
            // 체크섬: ELA 02+00+00+04+90+00=0x96 → 0x6A,
            //         data 01+00+00+00+AA=0xAB → 0x55,
            //         ELA 02+00+00+04+FF+FF=0x204 → 0xFC,
            //         data 01+00+10+00+BB=0xCC → 0x34
            const lines = [
                ':0200000490006A',   // ELA: 0x9000 → base 0x90000000
                ':01000000AA55',     // 1 byte (0xAA) at 0x90000000
                ':02000004FFFFFC',   // ELA: 0xFFFF → base 0xFFFF0000
                ':01001000BB34',     // 1 byte (0xBB) at 0xFFFF0010
                ':00000001FF'
            ].join('\n');

            const result = parseIntelHex(lines);
            assert.strictEqual(result.minAddress, 0x90000000);
            assert.strictEqual(result.maxAddress, 0xFFFF0010);
            assert.strictEqual(result.data.get(0x90000000), 0xAA);
            assert.strictEqual(result.data.get(0xFFFF0010), 0xBB);
        });

        test('should parse Start Linear Address (entry point)', () => {
            const lines = [
                ':0400000508000000EF',  // Start Linear Address: 0x08000000 (incorrect checksum, will be skipped)
                ':00000001FF'
            ].join('\n');

            // Let me compute correct checksum:
            // 04+00+00+05+08+00+00+00 = 11 = 0x11
            // checksum = (0x100 - 0x11) & 0xFF = 0xEF ✓
            const result = parseIntelHex(lines);
            assert.strictEqual(result.entryPoint, 0x08000000);
        });

        test('should handle empty content', () => {
            const result = parseIntelHex('');
            assert.strictEqual(result.byteCount, 0);
            assert.strictEqual(result.minAddress, 0);
        });

        test('should skip invalid checksum lines', () => {
            const lines = [
                ':0400000000200008FF',  // Invalid checksum
                ':00000001FF'
            ].join('\n');
            const result = parseIntelHex(lines);
            assert.strictEqual(result.byteCount, 0);
        });

        test('should handle Extended Segment Address', () => {
            // Type 02: Extended Segment Address
            // Set segment to 0x1000 → base = 0x1000 << 4 = 0x10000
            // :02000002100012  → 02+00+00+02+10+00 = 14, checksum = 0x100-0x14 = 0xEC
            const lines = [
                ':020000021000EC',
                ':01000000FF00',  // 1 byte at 0x10000, value 0xFF, checksum: 01+00+00+00+FF=100, cs=00
                ':00000001FF'
            ].join('\n');
            const result = parseIntelHex(lines);
            assert.strictEqual(result.minAddress, 0x10000);
            assert.strictEqual(result.data.get(0x10000), 0xFF);
        });
    });

    suite('parseSrec', () => {
        test('should parse S1 record (16-bit address)', () => {
            // S1 0D 0000 48656C6C6F576F726C6400 checksum
            // byteCount=0D (13), addr=0000 (2 bytes), data=Hello World\0 (10 bytes), checksum (1 byte)
            // sum = 0D+00+00+48+65+6C+6C+6F+57+6F+72+6C+64+00
            //     = 13+0+0+72+101+108+108+111+87+111+114+108+100+0 = 1033 = 0x409
            // complement = 0xFF - (0x09) = 0xF6... let me use simpler data

            // S1 07 0000 01020304 checksum
            // sum = 07+00+00+01+02+03+04 = 11 = 0x11 (but byteCount includes addr+data+checksum)
            // Wait, SREC byteCount = address bytes + data bytes + checksum byte
            // For S1: 2 addr + 4 data + 1 checksum = 7 → byteCount = 07
            // sum of all bytes after S1 record type: 07+00+00+01+02+03+04 = 0x11
            // checksum = 0xFF - 0x11 = 0xEE
            const lines = [
                'S0030000FC',       // Header
                'S10700000102030441',// S1, 7 bytes, addr=0000, data=01 02 03 04
                'S9030000FC'        // Termination
            ].join('\n');

            // Recompute: 07+00+00+01+02+03+04 = 0x11, cs = 0xFF - 0x11 = 0xEE
            // So the line should be S10700000102030441 → let's check: ...EE not 41
            // Let me fix the test data with correct checksum
            const properLines = [
                'S0030000FC',
                'S107000001020304EE',
                'S9030000FC'
            ].join('\n');

            const result = parseSrec(properLines);
            assert.strictEqual(result.format, 'srec');
            assert.strictEqual(result.byteCount, 4);
            assert.strictEqual(result.data.get(0), 0x01);
            assert.strictEqual(result.data.get(3), 0x04);
        });

        test('should parse S3 record (32-bit address)', () => {
            // S3 09 08000000 AABBCCDD checksum
            // byteCount = 4 addr + 4 data + 1 checksum = 9
            // sum = 09+08+00+00+00+AA+BB+CC+DD
            //     = 9+8+0+0+0+170+187+204+221 = 799 = 0x31F
            // checksum = 0xFF - 0x1F = 0xE0
            const lines = [
                'S0030000FC',
                'S30908000000AABBCCDDE0',
                'S70500000000FA'
            ].join('\n');
            const result = parseSrec(lines);
            assert.strictEqual(result.data.get(0x08000000), 0xAA);
            assert.strictEqual(result.data.get(0x08000003), 0xDD);
        });

        test('should parse entry point from S7 record', () => {
            // S7 05 08000000 checksum
            // sum = 05+08+00+00+00 = 0x0D
            // checksum = 0xFF - 0x0D = 0xF2
            const lines = [
                'S0030000FC',
                'S70508000000F2'
            ].join('\n');
            const result = parseSrec(lines);
            assert.strictEqual(result.entryPoint, 0x08000000);
        });

        test('should handle empty content', () => {
            const result = parseSrec('');
            assert.strictEqual(result.byteCount, 0);
        });
    });

    suite('parseBinary', () => {
        test('should parse binary buffer', () => {
            const buf = Buffer.from([0x00, 0x20, 0x00, 0x08]);
            const result = parseBinary(buf);
            assert.strictEqual(result.format, 'binary');
            assert.strictEqual(result.byteCount, 4);
            assert.strictEqual(result.minAddress, 0);
            assert.strictEqual(result.maxAddress, 3);
            assert.ok(result.rawBuffer);
            assert.strictEqual(result.rawBuffer![0], 0x00);
            assert.strictEqual(result.rawBuffer![3], 0x08);
        });

        test('should support base address', () => {
            const buf = Buffer.from([0xFF]);
            const result = parseBinary(buf, 0x08000000);
            assert.strictEqual(result.minAddress, 0x08000000);
            assert.strictEqual(result.maxAddress, 0x08000000);
            assert.ok(result.rawBuffer);
            assert.strictEqual(result.rawBuffer![0], 0xFF);
        });

        test('should handle empty buffer', () => {
            const result = parseBinary(Buffer.alloc(0));
            assert.strictEqual(result.byteCount, 0);
        });
    });

    suite('toFlatArray', () => {
        test('should create flat array from sparse data', () => {
            const result = parseIntelHex([
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));

            const arr = toFlatArray(result, 0x08000000, 4);
            assert.strictEqual(arr[0], 0x00);
            assert.strictEqual(arr[1], 0x20);
            assert.strictEqual(arr[2], 0x00);
            assert.strictEqual(arr[3], 0x08);
        });

        test('should fill gaps with default fill byte', () => {
            const result = parseBinary(Buffer.from([0xAA]), 0);
            const arr = toFlatArray(result, 0, 4);
            assert.strictEqual(arr[0], 0xAA);
            assert.strictEqual(arr[1], 0xFF); // fill byte
            assert.strictEqual(arr[3], 0xFF);
        });

        test('should use custom fill byte', () => {
            const result = parseBinary(Buffer.from([0xAA]), 0);
            const arr = toFlatArray(result, 0, 4, 0x00);
            assert.strictEqual(arr[1], 0x00);
        });
    });

    suite('hasData', () => {
        test('should return true for existing data', () => {
            const result = parseBinary(Buffer.from([0x01, 0x02]), 0);
            assert.strictEqual(hasData(result, 0), true);
            assert.strictEqual(hasData(result, 1), true);
        });

        test('should return false for non-existing address', () => {
            const result = parseBinary(Buffer.from([0x01]), 0);
            assert.strictEqual(hasData(result, 5), false);
        });
    });

    suite('parseFile', () => {
        const fs = require('fs');
        const os = require('os');

        test('should parse binary file', () => {
            const tmpFile = path.join(os.tmpdir(), 'test_taskhub.bin');
            fs.writeFileSync(tmpFile, Buffer.from([0x00, 0x00, 0x02, 0x20, 0x01, 0x01, 0x00, 0x08]));
            try {
                const result = parseFile(tmpFile);
                assert.strictEqual(result.format, 'binary');
                assert.strictEqual(result.byteCount, 8);
                assert.ok(result.rawBuffer);
                assert.strictEqual(result.rawBuffer![0], 0x00);
                assert.strictEqual(result.rawBuffer![2], 0x02);
                assert.strictEqual(result.rawBuffer![3], 0x20);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('should parse Intel HEX file', () => {
            const tmpFile = path.join(os.tmpdir(), 'test_taskhub.hex');
            fs.writeFileSync(tmpFile, [
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));
            try {
                const result = parseFile(tmpFile);
                assert.strictEqual(result.format, 'intel');
                assert.strictEqual(result.minAddress, 0x08000000);
                assert.strictEqual(result.data.get(0x08000000), 0x00);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('should parse SREC file', () => {
            const tmpFile = path.join(os.tmpdir(), 'test_taskhub.srec');
            fs.writeFileSync(tmpFile, [
                'S0030000FC',
                'S107000001020304EE',
                'S9030000FC'
            ].join('\n'));
            try {
                const result = parseFile(tmpFile);
                assert.strictEqual(result.format, 'srec');
                assert.strictEqual(result.byteCount, 4);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        /**
         * 확장자가 Raw Binary 를 확정하는 경우는 내용을 보지 않는다
         * (docs/features.md 지원 포맷 표: `.bin` · `.dat`). 사용자가 `.bin` 을
         * 열었다면 그것이 Raw Binary 라고 이미 말한 것이다.
         */
        for (const ext of ['.bin', '.dat']) {
            test(`${ext} 는 내용이 유효한 HEX 라도 Raw Binary 로 연다`, () => {
                const tmpFile = path.join(os.tmpdir(), `test_taskhub_extfirst${ext}`);
                // 그대로 두면 detectFormat 이 intel 로 판정할 완전한 레코드다.
                fs.writeFileSync(tmpFile, ':020000040800F2\n:00000001FF');
                try {
                    const result = parseFile(tmpFile);
                    assert.strictEqual(result.format, 'binary', '확장자보다 내용을 우선했다');
                    assert.ok(result.rawBuffer, 'Raw Binary 는 rawBuffer 로 온다');
                } finally {
                    fs.unlinkSync(tmpFile);
                }
            });
        }

        /**
         * 내용 탐지는 앞부분만 본다. 앞쪽 레코드가 여러 개 상한 `.hex` 는 탐지
         * 창을 벗어나 Raw Binary 로 열렸다 — 파서는 깨진 줄을 건너뛰고 읽을 수
         * 있는데도 그랬다. 확장자가 말해 주는 것을 내용 추측으로 뒤집지 않는다.
         */
        test('앞쪽 레코드가 여러 개 깨진 .hex 도 Intel HEX 로 연다', () => {
            const tmpFile = path.join(os.tmpdir(), 'test_taskhub_lateok.hex');
            fs.writeFileSync(tmpFile, [
                ...Array.from({ length: 8 }, () => ':020000040800F3'),  // 전부 체크섬 오류
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF',
            ].join('\n'));
            try {
                const result = parseFile(tmpFile);
                assert.strictEqual(result.format, 'intel', '확장자보다 내용 탐지를 우선했다');
                assert.strictEqual(result.data.get(0x08000000), 0x00, '유효한 레코드를 읽지 못했다');
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        for (const ext of ['.srec', '.s19']) {
            test(`${ext} 도 확장자로 SREC 를 확정한다`, () => {
                const tmpFile = path.join(os.tmpdir(), `test_taskhub_srecext${ext}`);
                fs.writeFileSync(tmpFile, ['S0030000FD', 'S107000001020304EE', 'S9030000FC'].join('\n'));
                try {
                    assert.strictEqual(parseFile(tmpFile).format, 'srec');
                } finally {
                    fs.unlinkSync(tmpFile);
                }
            });
        }

        test('첫 바이트가 `:` 인 .img 바이너리를 Intel HEX 로 열지 않는다', () => {
            // 확장자로는 정할 수 없는 자리 — 첫 레코드 검증이 막아야 한다.
            const tmpFile = path.join(os.tmpdir(), 'test_taskhub_colon.img');
            fs.writeFileSync(tmpFile, Buffer.from([0x3A, 0x00, 0xFF, 0x10, 0x20]));
            try {
                const result = parseFile(tmpFile);
                assert.strictEqual(result.format, 'binary');
                assert.strictEqual(result.byteCount, 5, '빈 뷰어가 되면 byteCount 가 0 이다');
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });

    suite('buildHexViewerHtml', () => {
        test('should generate valid HTML with data', () => {
            const result = parseBinary(Buffer.from([0x48, 0x65, 0x6C, 0x6C, 0x6F]), 0);
            const html = buildHexViewerHtml('test.bin', result);
            assert.ok(html.includes('<!DOCTYPE html>'));
            assert.ok(html.includes('test.bin'));
            assert.ok(html.includes('Binary'));
            assert.ok(html.includes('5 bytes'));
        });

        test('should include base address and total size in script', () => {
            const result = parseBinary(Buffer.from([0xFF]), 0x1000);
            const html = buildHexViewerHtml('offset.bin', result);
            assert.ok(html.includes('const BASE_ADDR = 4096'));
            assert.ok(html.includes('const TOTAL_SIZE = 1'));
        });

        test('should handle Intel HEX format label', () => {
            const result = parseIntelHex([
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));
            const html = buildHexViewerHtml('fw.hex', result);
            assert.ok(html.includes('Intel HEX'));
            assert.ok(html.includes('fw.hex'));
        });

        test('should include CSP and nonce in generated HTML', () => {
            const result = parseIntelHex([
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));
            const html = buildHexViewerHtml('fw.hex', result);
            assert.ok(html.includes('Content-Security-Policy'), 'missing CSP meta');
            // Base64 nonce from 16 random bytes: 22 chars of [A-Za-z0-9+/] plus 2 '=' pad.
            assert.ok(/<script nonce="[A-Za-z0-9+/]{22}=="/.test(html), 'missing script nonce');
        });
    });

    suite('parseHexViewerGoToOffset', () => {
        test('treats bare digits as decimal offsets for binary files', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('26214400', 0, 50 * 1024 * 1024),
                { kind: 'ok', offset: 26214400 }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('26222592', 0, 50 * 1024 * 1024),
                { kind: 'ok', offset: 26222592 }
            );
        });

        test('treats 0x-prefixed values as hexadecimal absolute addresses', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0x08000010', 0x08000000, 1024),
                { kind: 'ok', offset: 0x10 }
            );
        });

        test('accepts decimal absolute addresses when they fall inside the rendered range', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset(String(0x08000010), 0x08000000, 1024),
                { kind: 'ok', offset: 0x10 }
            );
        });

        test('falls back to decimal offset when a bare decimal is not an in-range absolute address', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('16', 0x08000000, 1024),
                { kind: 'ok', offset: 16 }
            );
        });

        test('treats h-suffix values as hexadecimal absolute addresses', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('100h', 0, 1024),
                { kind: 'ok', offset: 0x100 }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('8000010h', 0x08000000, 1024),
                { kind: 'ok', offset: 0x10 }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('FFh', 0, 1024),
                { kind: 'ok', offset: 0xFF }
            );
        });

        test('strips underscore digit separators before parsing', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('26_214_400', 0, 50 * 1024 * 1024),
                { kind: 'ok', offset: 26214400 }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0x0800_0010', 0x08000000, 1024),
                { kind: 'ok', offset: 0x10 }
            );
        });

        test('reports invalid-format for malformed inputs', () => {
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('not-an-offset', 0, 1024),
                { kind: 'invalid-format' }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0xZZ', 0, 1024),
                { kind: 'invalid-format' }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('-1', 0, 1024),
                { kind: 'invalid-format' }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('12.5', 0, 1024),
                { kind: 'invalid-format' }
            );
        });

        test('reports invalid-format for empty or whitespace-only input', () => {
            assert.deepStrictEqual(parseHexViewerGoToOffset('', 0, 1024), { kind: 'invalid-format' });
            assert.deepStrictEqual(parseHexViewerGoToOffset('   ', 0, 1024), { kind: 'invalid-format' });
            assert.deepStrictEqual(parseHexViewerGoToOffset('\t\n', 0, 1024), { kind: 'invalid-format' });
        });

        test('reports invalid-format for values past Number.MAX_SAFE_INTEGER', () => {
            // 0x20000000000000 == 2^53, just past Number.MAX_SAFE_INTEGER (2^53 - 1).
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0x20000000000000', 0, 1024),
                { kind: 'invalid-format' }
            );
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('9007199254740993', 0, 1024),
                { kind: 'invalid-format' }
            );
        });

        test('reports invalid-format when totalSize is non-positive or non-finite', () => {
            assert.deepStrictEqual(parseHexViewerGoToOffset('0', 0, 0), { kind: 'invalid-format' });
            assert.deepStrictEqual(parseHexViewerGoToOffset('0', 0, -1), { kind: 'invalid-format' });
            assert.deepStrictEqual(parseHexViewerGoToOffset('0', 0, Number.NaN), { kind: 'invalid-format' });
        });

        test('reports out-of-range with last offset & last absolute address (binary, base=0)', () => {
            const totalSize = 50 * 1024 * 1024;
            // 마지막 byte offset 직후 (totalSize 그대로) → out-of-range.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('52428800', 0, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: totalSize - 1 }
            );
            // 한참 큰 값.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('999999999', 0, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: totalSize - 1 }
            );
            // hex 표기도 동일하게.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0x10000000', 0, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: totalSize - 1 }
            );
        });

        test('reports out-of-range with absolute base address for hex files', () => {
            // 0x08000000 ~ 0x080003FF (totalSize 1024).
            const base = 0x08000000;
            const totalSize = 1024;
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('0x08000400', base, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: base + totalSize - 1 }
            );
            // bare decimal 이 absolute 도 offset 도 모두 범위 밖.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset('5000', base, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: base + totalSize - 1 }
            );
        });

        test('boundary: last byte is ok, just-past-last is out-of-range', () => {
            const totalSize = 1024;
            // offset = totalSize - 1: 마지막 byte. ok.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset(String(totalSize - 1), 0, totalSize),
                { kind: 'ok', offset: totalSize - 1 }
            );
            // offset = totalSize: 첫 out-of-range.
            assert.deepStrictEqual(
                parseHexViewerGoToOffset(String(totalSize), 0, totalSize),
                { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: totalSize - 1 }
            );
        });

        test('webview HTML 에 주입된 파서 본문이 동일하게 동작한다 (단일 출처 보증)', () => {
            // buildHexViewerHtml 은 parseHexViewerGoToOffset.toString() 을 webview 스크립트에
            // 인라인 주입한다. 본 테스트는 minify 후에도 함수가 self-contained 하게 살아남는지
            // 단위 테스트 단계에서 검증한다 (TS unit-test 빌드는 minify 가 꺼져 있지만, 추출된
            // 함수 본문을 직접 eval 해 호출 가능 여부 자체를 보증).
            const result = parseIntelHex([
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));
            const html = buildHexViewerHtml('fw.hex', result);
            const match = html.match(/parseGoToOffset\s*=\s*\((function[\s\S]+?\})\)/);
            assert.ok(match, 'webview HTML 에 parseGoToOffset 주입이 보이지 않음');
            type ParserFn = (
                input: string,
                baseAddress: number,
                totalSize: number
            ) => { kind: 'ok'; offset: number }
                | { kind: 'invalid-format' }
                | { kind: 'out-of-range'; maxOffset: number; maxAddress: number };
            const injected = eval('(' + match[1] + ')') as ParserFn;
            assert.deepStrictEqual(injected('26214400', 0, 50 * 1024 * 1024), { kind: 'ok', offset: 26214400 });
            assert.deepStrictEqual(injected('0x08000010', 0x08000000, 1024), { kind: 'ok', offset: 0x10 });
            assert.deepStrictEqual(injected('100h', 0, 1024), { kind: 'ok', offset: 0x100 });
            assert.deepStrictEqual(injected('not-an-offset', 0, 1024), { kind: 'invalid-format' });
            assert.deepStrictEqual(
                injected('99999999', 0, 1024),
                { kind: 'out-of-range', maxOffset: 1023, maxAddress: 1023 }
            );
        });
    });

    suite('computeHexViewerScrollScale', () => {
        const ROW_HEIGHT = 20;
        const BYTES_PER_ROW = 16;

        test('returns 1 when content fits inside the safe max', () => {
            // 1MB binary: 65,536 rows * 20 = 1.31M px → 한도 한참 밑이라 scale=1.
            const totalContentHeight = Math.ceil((1 * 1024 * 1024) / BYTES_PER_ROW) * ROW_HEIGHT;
            assert.strictEqual(computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT), 1);
        });

        test('returns < 1 when content exceeds the safe max (50MB binary)', () => {
            // 50MB: 3,276,800 rows * 20 = 65,536,000 px → cap (33M) 초과 → 축소 필요.
            const totalRowCount = Math.ceil((50 * 1024 * 1024) / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            assert.ok(scale < 1, 'scale 은 1 미만이어야 함');
            assert.ok(scale > 0, 'scale 은 양수여야 함');
            // scaledTotalHeight 가 SAFE_MAX 와 (부동소수점 오차 범위 내에서) 일치해야 한다.
            const scaledTotal = totalContentHeight * scale;
            assert.ok(
                Math.abs(scaledTotal - HEX_VIEWER_SAFE_MAX_HEIGHT) < 1,
                `scaledTotal ${scaledTotal} 가 SAFE_MAX ${HEX_VIEWER_SAFE_MAX_HEIGHT} 와 거의 일치해야 함`
            );
        });

        test('축소 후 scrollHeight 가 브라우저 single-element cap 미만 (50MB 기준)', () => {
            // Chromium ~33,554,400 px. 안전 마진 보고 33M 미만이면 OK.
            const totalRowCount = Math.ceil((50 * 1024 * 1024) / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            assert.ok(totalContentHeight * scale < 33_000_000, 'scaled height 가 cap 미만이어야 함');
        });

        test('축소 후 scrollHeight 가 cap 미만 (HEX_VIEWER_MAX_SPAN = 128MB 한계)', () => {
            // Hex Viewer 가 허용하는 최대 span 까지 cap 안에 들어와야 한다.
            const totalRowCount = Math.ceil(HEX_VIEWER_MAX_SPAN / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            assert.ok(totalContentHeight * scale <= HEX_VIEWER_SAFE_MAX_HEIGHT);
            assert.ok(totalContentHeight * scale < 33_000_000);
        });

        test('50MB 파일의 중앙 row(검색 marker 위치)가 cap 안에서 도달 가능', () => {
            // marker 가 offset 26,214,400 (= 50MB/2) 에 있다. 이 row 의 scaled scrollTop 은
            // SAFE_MAX_HEIGHT 의 거의 정확히 중간에 위치해야 한다.
            const totalRowCount = Math.ceil((50 * 1024 * 1024) / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            const scaledRowHeight = ROW_HEIGHT * scale;
            const markerOffset = 26214400;
            const markerRow = Math.floor(markerOffset / BYTES_PER_ROW);
            const markerScrollTop = markerRow * scaledRowHeight;
            assert.ok(
                markerScrollTop > 0 && markerScrollTop < HEX_VIEWER_SAFE_MAX_HEIGHT,
                `markerScrollTop=${markerScrollTop} 는 0 < x < ${HEX_VIEWER_SAFE_MAX_HEIGHT} 사이여야 함`
            );
            // 추가: 정확히 중앙 부근 (±5%) 에 있는지.
            const expected = HEX_VIEWER_SAFE_MAX_HEIGHT / 2;
            const tolerance = HEX_VIEWER_SAFE_MAX_HEIGHT * 0.05;
            assert.ok(
                Math.abs(markerScrollTop - expected) < tolerance,
                `markerScrollTop ${markerScrollTop} 이 중앙 ${expected} 부근에 있어야 함 (±${tolerance})`
            );
        });

        test('마지막 row 도 cap 미만의 scrollTop 으로 도달 가능 (50MB)', () => {
            const totalRowCount = Math.ceil((50 * 1024 * 1024) / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            const scaledRowHeight = ROW_HEIGHT * scale;
            const lastRow = totalRowCount - 1;
            const lastScrollTop = lastRow * scaledRowHeight;
            assert.ok(
                lastScrollTop < HEX_VIEWER_SAFE_MAX_HEIGHT,
                `lastScrollTop ${lastScrollTop} 가 SAFE_MAX ${HEX_VIEWER_SAFE_MAX_HEIGHT} 미만이어야 함`
            );
        });

        test('round-trip: rowToScrollTop → scrollTopToRow 가 ±1 row 안에서 복원된다', () => {
            // 부동소수점 오차로 ±1 row 의 차이는 허용. visible 영역에 BUFFER_ROWS=20 마진이
            // 있으므로 ±1 정도는 사용자 경험에 영향이 없다.
            const totalRowCount = Math.ceil((50 * 1024 * 1024) / BYTES_PER_ROW);
            const totalContentHeight = totalRowCount * ROW_HEIGHT;
            const scale = computeHexViewerScrollScale(totalContentHeight, HEX_VIEWER_SAFE_MAX_HEIGHT);
            const scaledRowHeight = ROW_HEIGHT * scale;
            const samples = [0, 1, 100, 65535, 1638400, totalRowCount - 1];
            for (const row of samples) {
                const scrollTop = row * scaledRowHeight;
                const recovered = Math.floor(scrollTop / scaledRowHeight);
                assert.ok(
                    Math.abs(recovered - row) <= 1,
                    `row ${row} round-trip 오차가 너무 큼 (recovered=${recovered})`
                );
            }
        });

        test('비정상 입력은 1 을 반환 (defensive)', () => {
            assert.strictEqual(computeHexViewerScrollScale(0, HEX_VIEWER_SAFE_MAX_HEIGHT), 1);
            assert.strictEqual(computeHexViewerScrollScale(-1, HEX_VIEWER_SAFE_MAX_HEIGHT), 1);
            assert.strictEqual(computeHexViewerScrollScale(Number.NaN, HEX_VIEWER_SAFE_MAX_HEIGHT), 1);
            assert.strictEqual(computeHexViewerScrollScale(1000, 0), 1);
            assert.strictEqual(computeHexViewerScrollScale(1000, -1), 1);
            assert.strictEqual(computeHexViewerScrollScale(1000, Number.NaN), 1);
        });
    });

    suite('hexCellOverlapsSelection', () => {
        test('unit=1: 단일 byte selection 은 정확히 그 byte 셀만 매칭', () => {
            // unit=1 이면 셀 = byte 한 개. 기존 동작과 동일해야 한다 (회귀 방지).
            assert.strictEqual(hexCellOverlapsSelection(0x123, 1, 0x123, 0x123), true);
            assert.strictEqual(hexCellOverlapsSelection(0x122, 1, 0x123, 0x123), false);
            assert.strictEqual(hexCellOverlapsSelection(0x124, 1, 0x123, 0x123), false);
        });

        test('unit=4 + Goto 0x123 (unaligned): 0x120 셀이 매칭, 0x124 셀은 안 됨', () => {
            // 핵심 회귀 케이스 — 4-byte 모드에서 Goto 0x123 이 시각적으로 안 보였던 버그.
            // 0x120 셀의 byte range 는 [0x120, 0x123] → 0x123 포함.
            assert.strictEqual(hexCellOverlapsSelection(0x120, 4, 0x123, 0x123), true);
            // 0x124 셀의 byte range 는 [0x124, 0x127] → 0x123 미포함.
            assert.strictEqual(hexCellOverlapsSelection(0x124, 4, 0x123, 0x123), false);
            assert.strictEqual(hexCellOverlapsSelection(0x11C, 4, 0x123, 0x123), false);
        });

        test('unit=4: aligned offset Goto/click 은 그 셀만 매칭 (인접 셀 영향 없음)', () => {
            // 0x120 selection 은 0x120 셀만 매칭, 0x11C/0x124 는 미매칭.
            assert.strictEqual(hexCellOverlapsSelection(0x120, 4, 0x120, 0x120), true);
            assert.strictEqual(hexCellOverlapsSelection(0x11C, 4, 0x120, 0x120), false);
            assert.strictEqual(hexCellOverlapsSelection(0x124, 4, 0x120, 0x120), false);
        });

        test('unit=4 + 다중 byte selection: 셀의 byte range 와 겹치는 모든 셀 매칭', () => {
            // selection [0x122, 0x125] 은 셀 0x120 (range 0x120-0x123) 과 셀 0x124 (range 0x124-0x127) 모두와 겹침.
            assert.strictEqual(hexCellOverlapsSelection(0x120, 4, 0x122, 0x125), true);
            assert.strictEqual(hexCellOverlapsSelection(0x124, 4, 0x122, 0x125), true);
            assert.strictEqual(hexCellOverlapsSelection(0x128, 4, 0x122, 0x125), false);
            assert.strictEqual(hexCellOverlapsSelection(0x11C, 4, 0x122, 0x125), false);
        });

        test('unit=8 + Goto unaligned: 8-byte 셀의 byte range 와 겹침 판정', () => {
            // 0x120 셀 (8-byte): range [0x120, 0x127]. 0x125 입력 → 매칭.
            assert.strictEqual(hexCellOverlapsSelection(0x120, 8, 0x125, 0x125), true);
            assert.strictEqual(hexCellOverlapsSelection(0x128, 8, 0x125, 0x125), false);
            assert.strictEqual(hexCellOverlapsSelection(0x118, 8, 0x125, 0x125), false);
        });

        test('unit=2 경계: 셀 끝 byte 와 셀 시작 byte 도 정확히 판정', () => {
            // 셀 0x10 (range [0x10, 0x11]): 0x10 매칭, 0x11 매칭, 0x12 미매칭, 0x0F 미매칭.
            assert.strictEqual(hexCellOverlapsSelection(0x10, 2, 0x10, 0x10), true);
            assert.strictEqual(hexCellOverlapsSelection(0x10, 2, 0x11, 0x11), true);
            assert.strictEqual(hexCellOverlapsSelection(0x10, 2, 0x12, 0x12), false);
            assert.strictEqual(hexCellOverlapsSelection(0x10, 2, 0x0F, 0x0F), false);
        });

        test('shift-click 범위 selection 은 unit > 1 에서도 click 흐름과 호환', () => {
            // click 흐름: selectedOffset/EndOffset 는 항상 unit-aligned. 0x100 ~ 0x130 범위.
            // 0x110 / 0x12C 셀 모두 매칭, 0x100 / 0x130 셀도 매칭, 0xFC / 0x134 는 미매칭.
            assert.strictEqual(hexCellOverlapsSelection(0x100, 4, 0x100, 0x130), true);
            assert.strictEqual(hexCellOverlapsSelection(0x110, 4, 0x100, 0x130), true);
            assert.strictEqual(hexCellOverlapsSelection(0x12C, 4, 0x100, 0x130), true);
            assert.strictEqual(hexCellOverlapsSelection(0x130, 4, 0x100, 0x130), true);
            assert.strictEqual(hexCellOverlapsSelection(0xFC, 4, 0x100, 0x130), false);
            assert.strictEqual(hexCellOverlapsSelection(0x134, 4, 0x100, 0x130), false);
        });

        test('webview HTML 의 selection 비교가 helper 와 동일한 분기를 사용한다 (회귀 방지)', () => {
            // applySelectionToVisible 안에 inline 으로 같은 overlap 비교가 들어 있는지 정적 검사.
            // 두 곳 동기화가 깨지면 4-byte unit + Goto unaligned 회귀가 다시 발생할 수 있음.
            const result = parseIntelHex([
                ':020000040800F2',
                ':0400000000200008D4',
                ':00000001FF'
            ].join('\n'));
            const html = buildHexViewerHtml('fw.hex', result);
            assert.ok(
                html.includes('cellEnd >= minOff && off <= maxOff'),
                'webview 의 applySelectionToVisible 이 overlap 비교를 사용해야 함'
            );
            assert.ok(
                /Math\.floor\(offset\s*\/\s*unitSize\)\s*\*\s*unitSize/.test(html),
                'jumpToOffset 의 cell querySelector 가 unit-aligned 로 보정되어야 함'
            );
        });

        test('webview HTML 의 status bar 가 gap bitmap 을 확인한다', () => {
            const result = parseIntelHex([
                ':01000000AA55',
                ':01000200BB42',
                ':00000001FF'
            ].join('\n'));
            const html = buildHexViewerHtml('sparse.hex', result);
            assert.ok(html.includes('function hasDataRange(offset, size)'));
            // 0.6.20: "Value: no data" 문자열이 로케일 번들(S.statusNoData)로
            // 옮겨졌다. 검증 대상은 문구가 아니라 gap 구간에서 no-data 상태를
            // 렌더한다는 사실이다.
            assert.ok(html.includes('S.statusNoData'), 'gap 구간에서 no-data 상태를 표시해야 함');
            assert.ok(html.includes('hasDataRange(minOff, 2)'));
            assert.ok(html.includes('hasDataRange(minOff, 4)'));
        });
    });

    suite('defensive limits', () => {
        test('parseIntelHex should ignore data records with invalid byteCount', () => {
            // byteCount field 'ZZ' is NaN; the record must be skipped without throwing.
            const result = parseIntelHex(':ZZ000000000000\n:00000001FF');
            assert.strictEqual(result.byteCount, 0);
        });

        test('parseIntelHex should ignore truncated records before reading checksum as data', () => {
            // Declares two data bytes but only contains the checksum byte.
            const result = parseIntelHex(':02000000FE\n:00000001FF');
            assert.strictEqual(result.byteCount, 0);
        });

        test('parseSrec should ignore truncated records before reading checksum as data', () => {
            // Declares one data byte but only contains address + checksum.
            const result = parseSrec('S1040000FB');
            assert.strictEqual(result.byteCount, 0);
        });

        test('buildHexViewerHtml rejects sparse files with a huge address span', () => {
            // Two data bytes at very different addresses: passes the byteCount cap
            // but would require allocating a multi-GB flat buffer without the span cap.
            const result = {
                format: 'intel' as const,
                data: new Map<number, number>([[0, 0xAA], [0x20000000, 0xBB]]),
                minAddress: 0,
                maxAddress: 0x20000000,
                byteCount: 2,
            };
            assert.throws(() => buildHexViewerHtml('sparse.hex', result), /display limit/);
        });

        // --- HEX_VIEWER_MAX_SPAN off-by-one boundary (pure guard) ----------
        // Guard is `totalSize > HEX_VIEWER_MAX_SPAN` so a span exactly at the
        // limit must be accepted, and a span one byte larger must throw. We
        // exercise the extracted pure helper rather than buildHexViewerHtml
        // so the success case does not allocate the 128 MB flat buffer the
        // real renderer would create.
        test('assertWithinHexViewerSpan accepts a span exactly at HEX_VIEWER_MAX_SPAN', () => {
            assert.doesNotThrow(() => assertWithinHexViewerSpan(HEX_VIEWER_MAX_SPAN));
        });

        test('assertWithinHexViewerSpan accepts a span one byte below the limit', () => {
            assert.doesNotThrow(() => assertWithinHexViewerSpan(HEX_VIEWER_MAX_SPAN - 1));
        });

        test('assertWithinHexViewerSpan rejects a span one byte above the limit', () => {
            assert.throws(
                () => assertWithinHexViewerSpan(HEX_VIEWER_MAX_SPAN + 1),
                /display limit/
            );
        });

        test('assertWithinHexViewerSpan rejects non-finite / negative spans', () => {
            assert.throws(() => assertWithinHexViewerSpan(Number.NaN), /display limit/);
            assert.throws(() => assertWithinHexViewerSpan(Number.POSITIVE_INFINITY), /display limit/);
            assert.throws(() => assertWithinHexViewerSpan(-1), /display limit/);
        });
    });

    suite('hexViewer webview source guards (M5 회귀 가드)', () => {
        test('unit values are formatted as BigInt, not via Number()', () => {
            // 8-byte unit에서 readUnit()의 BigInt를 Number()로 변환하면 2^53
            // 초과 값(FF*8 등)의 표시·복사가 깨진다. formatHex에 BigInt를
            // 그대로 넘겨야 한다 (toString(16)은 BigInt에서도 동작).
            const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'hexViewer.ts'), 'utf-8');
            assert.ok(
                !/formatHex\(Number\(/.test(src),
                'hexViewer must not route unit values through Number() before formatHex'
            );
        });
    });
});
