import * as assert from 'assert';
import { NumberBaseHoverProvider } from '../numberBaseHoverProvider';
import * as vscode from 'vscode';
import { CompleteBitFieldInfo } from '../sfrBitFieldParser';

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

    suite('Value Extraction Tests', () => {
        test('Extract value from const declaration', () => {
            const result = (provider as any).extractValueFromLine('const int MASK = 0xFF;');
            assert.strictEqual(result, 255);
        });

        test('Extract value from variable assignment', () => {
            const result = (provider as any).extractValueFromLine('int value = 0x100;');
            assert.strictEqual(result, 256);
        });

        test('Extract value from enum with comma', () => {
            const result = (provider as any).extractValueFromLine('    FLAG_A = 0x01,');
            assert.strictEqual(result, 1);
        });

        test('Extract value from #define', () => {
            const result = (provider as any).extractValueFromLine('#define MAX_SIZE 0x1000');
            assert.strictEqual(result, 4096);
        });

        test('Extract binary value from #define', () => {
            const result = (provider as any).extractValueFromLine('#define BIT_MASK 0b11110000');
            assert.strictEqual(result, 240);
        });

        test('Extract decimal value', () => {
            const result = (provider as any).extractValueFromLine('const int COUNT = 255;');
            assert.strictEqual(result, 255);
        });

        test('Return null for line without value', () => {
            const result = (provider as any).extractValueFromLine('int someVariable;');
            assert.strictEqual(result, null);
        });

        test('Return null for empty line', () => {
            const result = (provider as any).extractValueFromLine('');
            assert.strictEqual(result, null);
        });
    });

    suite('SFR Bit Field Hover Tests', () => {
        test('Generate hover content for single bit field', () => {
            const bitFieldInfo: CompleteBitFieldInfo = {
                fieldName: 'int0_set',
                declaredWidth: 1,
                commentInfo: {
                    bitPosition: '0',
                    bitStart: 0,
                    bitEnd: 0,
                    bitWidth: 1,
                    accessType: 'RW1C',
                    resetValue: '0x0',
                    resetValueNumeric: 0,
                    description: 'Test interrupt 1'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo,
                scopes,
                'h1/test.h',
                36
            );

            assert.ok(result.value.includes('RegTestInt::IntRegSts::int0_set'), 'Should include hierarchy name');
            assert.ok(result.value.includes('0'), 'Should include bit position');
            assert.ok(result.value.includes('RW1C'), 'Should include access type');
            assert.ok(result.value.includes('0x0'), 'Should include reset value');
            assert.ok(result.value.includes('Test interrupt 1'), 'Should include description');
            assert.ok(result.value.includes('h1/test.h:36'), 'Should include file location');
        });

        test('Generate hover content for multi-bit field with conversions', () => {
            const bitFieldInfo: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Test field 0'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo,
                scopes,
                'h1/test.h',
                47
            );

            assert.ok(result.value.includes('12:10'), 'Should include bit position range');
            assert.ok(result.value.includes('3 bits'), 'Should include bit width');
            assert.ok(result.value.includes('Dec: 7'), 'Should include decimal conversion');
            assert.ok(result.value.includes('Bin: 0b111'), 'Should include binary conversion');
            assert.ok(result.value.includes('0x00001C00'), 'Should include bit mask');
        });

        test('Verify different bit positions produce different content', () => {
            // First definition: 3 bits at [12:10]
            const bitFieldInfo1: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Test field 0'
                }
            };

            // Second definition: 2 bits at [11:10]
            const bitFieldInfo2: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 2,
                commentInfo: {
                    bitPosition: '11:10',
                    bitStart: 10,
                    bitEnd: 11,
                    bitWidth: 2,
                    accessType: 'RW1C',
                    resetValue: '0x3',
                    resetValueNumeric: 3,
                    description: 'Test field 0'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result1 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo1,
                scopes,
                'h1/test.h',
                47
            );

            const result2 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo2,
                scopes,
                'h2/test.h',
                47
            );

            // Verify first definition has correct info
            assert.ok(result1.value.includes('12:10'), 'First definition should show [12:10]');
            assert.ok(result1.value.includes('3 bits'), 'First definition should show 3 bits');
            assert.ok(result1.value.includes('0x7'), 'First definition should show reset value 0x7');
            assert.ok(result1.value.includes('0x00001C00'), 'First definition should show bit mask 0x00001C00');

            // Verify second definition has DIFFERENT info
            assert.ok(result2.value.includes('11:10'), 'Second definition should show [11:10]');
            assert.ok(result2.value.includes('2 bits'), 'Second definition should show 2 bits');
            assert.ok(result2.value.includes('0x3'), 'Second definition should show reset value 0x3');
            assert.ok(result2.value.includes('0x00000C00'), 'Second definition should show bit mask 0x00000C00');

            // Verify they are actually different
            assert.notStrictEqual(result1.value, result2.value, 'Different bit field definitions should produce different hover content');
        });

        test('Bit mask calculation for different bit positions', () => {
            // Test bit mask for [0] - single bit
            const bitFieldInfo1: CompleteBitFieldInfo = {
                fieldName: 'bit0',
                declaredWidth: 1,
                commentInfo: {
                    bitPosition: '0',
                    bitStart: 0,
                    bitEnd: 0,
                    bitWidth: 1,
                    accessType: 'RW1C',
                    resetValue: '0x0',
                    resetValueNumeric: 0,
                    description: 'Bit 0'
                }
            };

            const result1 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo1,
                [],
                'test.h',
                1
            );
            assert.ok(result1.value.includes('0x00000001'), 'Bit [0] should have mask 0x00000001');

            // Test bit mask for [12:10] - 3 bits
            const bitFieldInfo2: CompleteBitFieldInfo = {
                fieldName: 'bits_12_10',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Bits 12:10'
                }
            };

            const result2 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo2,
                [],
                'test.h',
                1
            );
            assert.ok(result2.value.includes('0x00001C00'), 'Bits [12:10] should have mask 0x00001C00');

            // Test bit mask for [11:10] - 2 bits
            const bitFieldInfo3: CompleteBitFieldInfo = {
                fieldName: 'bits_11_10',
                declaredWidth: 2,
                commentInfo: {
                    bitPosition: '11:10',
                    bitStart: 10,
                    bitEnd: 11,
                    bitWidth: 2,
                    accessType: 'RW1C',
                    resetValue: '0x3',
                    resetValueNumeric: 3,
                    description: 'Bits 11:10'
                }
            };

            const result3 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo3,
                [],
                'test.h',
                1
            );
            assert.ok(result3.value.includes('0x00000C00'), 'Bits [11:10] should have mask 0x00000C00');
        });
    });
});
