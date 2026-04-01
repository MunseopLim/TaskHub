import * as assert from 'assert';
import * as path from 'path';
import {
    detectFormat,
    parseIntelHex,
    parseSrec,
    parseBinary,
    toFlatArray,
    hasData,
} from '../hexParser';
import { parseFile, buildHexViewerHtml } from '../hexViewer';

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
            assert.strictEqual(result.data.get(0), 0x00);
            assert.strictEqual(result.data.get(3), 0x08);
        });

        test('should support base address', () => {
            const buf = Buffer.from([0xFF]);
            const result = parseBinary(buf, 0x08000000);
            assert.strictEqual(result.minAddress, 0x08000000);
            assert.strictEqual(result.maxAddress, 0x08000000);
            assert.strictEqual(result.data.get(0x08000000), 0xFF);
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
                assert.strictEqual(result.data.get(0), 0x00);
                assert.strictEqual(result.data.get(2), 0x02);
                assert.strictEqual(result.data.get(3), 0x20);
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
    });
});
