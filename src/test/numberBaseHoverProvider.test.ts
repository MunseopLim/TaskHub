import * as assert from 'assert';
import { NumberBaseHoverProvider } from '../numberBaseHoverProvider';
import * as vscode from 'vscode';

suite('NumberBaseHoverProvider Test Suite', () => {
    let provider: NumberBaseHoverProvider;

    setup(() => {
        provider = new NumberBaseHoverProvider();
    });

    suite('Number Parsing Tests', () => {
        test('Parse hexadecimal with 0x prefix', () => {
            const result = (provider as any).parseNumber('0xFF');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with 0X prefix (uppercase)', () => {
            const result = (provider as any).parseNumber('0XFF');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with h suffix', () => {
            const result = (provider as any).parseNumber('FFh');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with H suffix (uppercase)', () => {
            const result = (provider as any).parseNumber('FFH');
            assert.strictEqual(result, 255);
        });

        test('Parse binary with 0b prefix', () => {
            const result = (provider as any).parseNumber('0b11111111');
            assert.strictEqual(result, 255);
        });

        test('Parse binary with 0B prefix (uppercase)', () => {
            const result = (provider as any).parseNumber('0B11111111');
            assert.strictEqual(result, 255);
        });

        test('Parse decimal number', () => {
            const result = (provider as any).parseNumber('255');
            assert.strictEqual(result, 255);
        });

        test('Parse decimal number with digit separators', () => {
            const result = (provider as any).parseNumber('1\'000\'000');
            assert.strictEqual(result, 1000000);
        });

        test('Parse hexadecimal with digit separators', () => {
            const result = (provider as any).parseNumber('0xFF\'FF\'FF');
            assert.strictEqual(result, 0xFFFFFF);
        });

        test('Parse binary with digit separators', () => {
            const result = (provider as any).parseNumber('0b1111\'0000\'1111\'0000');
            assert.strictEqual(result, 0xF0F0);
        });

        test('Parse large 32-bit value', () => {
            const result = (provider as any).parseNumber('0xDEADBEEF');
            assert.strictEqual(result, 0xDEADBEEF);
        });

        test('Parse 64-bit value', () => {
            const result = (provider as any).parseNumber('0xFE0000000');
            assert.strictEqual(result, 0xFE0000000);
        });

        test('Return null for invalid input', () => {
            const result = (provider as any).parseNumber('invalid');
            assert.strictEqual(result, null);
        });

        test('Return null for empty string', () => {
            const result = (provider as any).parseNumber('');
            assert.strictEqual(result, null);
        });
    });

    suite('Number Detection Tests', () => {
        test('Find hex number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 0xFF;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '0xFF');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 12);
        });

        test('Find decimal number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 255;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '255');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 11);
        });

        test('Find binary number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 0b11111111;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '0b11111111');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 18);
        });

        test('Return null when no number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = value;', 8);
            assert.strictEqual(result, null);
        });
    });

    suite('Bit Position Tests', () => {
        test('Generate correct bit info for 0xFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0xFF);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            // Check that all bits 0-7 are mentioned
            for (let i = 0; i <= 7; i++) {
                assert.ok(result.includes(i.toString()), `Should mention bit ${i}`);
            }
        });

        test('Generate correct bit info for 0x00', () => {
            const result = (provider as any).generateBitPositionDisplay(0x00);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            assert.ok(result.includes('none') || result.includes('value is 0'), 'Should indicate no bits are set');
        });

        test('Generate correct bit info for 0x80000000', () => {
            const result = (provider as any).generateBitPositionDisplay(0x80000000);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            assert.ok(result.includes('31'), 'Should mention bit 31');
        });

        test('Generate 32-bit display for values <= 0xFFFFFFFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0xFFFFFFFF);
            assert.ok(result.includes('32-bit'));
        });

        test('Generate 64-bit display for values > 0xFFFFFFFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0x100000000);
            assert.ok(result.includes('64-bit'));
        });
    });
});
