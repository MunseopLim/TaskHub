import * as assert from 'assert';
import {
    NumberBaseHoverProvider,
    BitOperation,
    BitOperationType,
    detectBitOperation,
    calculateBitOperation,
    formatBitOperationResult
} from '../numberBaseHoverProvider';
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

    // ========================================================================
    // Bit Operation Tests (Experimental Feature)
    // ========================================================================
    suite('Bit Operation Detection', () => {
        test('should detect AND operation', () => {
            const line = '    value &= 0xFF;';
            const operation = detectBitOperation(line, 10); // Cursor on '&='

            assert.ok(operation, 'Should detect operation');
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
            assert.strictEqual(operation.operand, 0xFF);
            assert.strictEqual(operation.isAssignment, true);
        });

        test('should detect OR operation', () => {
            const line = '    reg |= 0x80;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'reg');
            assert.strictEqual(operation.operator, BitOperationType.OR_ASSIGN);
            assert.strictEqual(operation.operand, 0x80);
            assert.strictEqual(operation.isAssignment, true);
        });

        test('should detect XOR operation', () => {
            const line = '    mask ^= 0b10101010;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'mask');
            assert.strictEqual(operation.operator, BitOperationType.XOR_ASSIGN);
            assert.strictEqual(operation.operand, 0b10101010);
        });

        test('should detect left shift operation', () => {
            const line = '    value <<= 4;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.LEFT_SHIFT_ASSIGN);
            assert.strictEqual(operation.operand, 4);
        });

        test('should detect right shift operation', () => {
            const line = '    value >>= 2;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.RIGHT_SHIFT_ASSIGN);
            assert.strictEqual(operation.operand, 2);
        });

        test('should detect non-assignment AND', () => {
            const line = '    result = value & 0xFF;';
            const operation = detectBitOperation(line, 20); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND);
            assert.strictEqual(operation.operand, 0xFF);
            assert.strictEqual(operation.isAssignment, false);
        });

        test('should detect NOT operation', () => {
            const line = '    result = ~value;';
            const operation = detectBitOperation(line, 14); // Cursor on '~'

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.NOT);
        });

        test('should return undefined when no operation found', () => {
            const line = '    int value = 10;';
            const operation = detectBitOperation(line, 10);

            assert.strictEqual(operation, undefined);
        });

        test('should handle hex operands', () => {
            const line = '    value &= 0xABCD;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 0xABCD);
        });

        test('should handle binary operands', () => {
            const line = '    value |= 0b11110000;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 0b11110000);
        });

        test('should handle decimal operands', () => {
            const line = '    value <<= 8;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 8);
        });

        test('should NOT detect NOT on constant like ~0x00FF0000', () => {
            const line = '    config &= ~0x00FF0000;';
            const operation = detectBitOperation(line, 15); // Cursor on '~'

            // '~0x00FF0000' is a constant expression, should not be detected by NOT pattern
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable XOR variable (a ^ b)', () => {
            const line = '    uint8_t result = a ^ b;';
            const operation = detectBitOperation(line, 24); // Cursor on '^'

            // 'a ^ b' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable AND variable (data & mask)', () => {
            const line = '    uint8_t output = data & mask;';
            const operation = detectBitOperation(line, 27); // Cursor on '&'

            // 'data & mask' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable OR variable (flags | status)', () => {
            const line = '    result = flags | status;';
            const operation = detectBitOperation(line, 19); // Cursor on '|'

            // 'flags | status' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect left shift with variable operand (1 << shift)', () => {
            const line = '    uint8_t mask = 1 << shift;';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            // '1 << shift' pattern is NOT supported (right operand is variable)
            assert.strictEqual(operation, undefined);
        });

        test('should handle variable names starting with underscore', () => {
            const line = '    _value |= 0x80;';
            const operation = detectBitOperation(line, 11);

            assert.ok(operation);
            assert.strictEqual(operation.variable, '_value');
            assert.strictEqual(operation.operator, BitOperationType.OR_ASSIGN);
        });

        test('should handle variable names with digits (but not starting with digit)', () => {
            const line = '    value123 &= 0xFF;';
            const operation = detectBitOperation(line, 13);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value123');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
        });
    });

    suite('Constant Expression Detection', () => {
        test('should detect constant left shift: 1U << 5', () => {
            const line = '    #define MASK (1U << 5)';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation, 'Should detect constant expression');
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.LEFT_SHIFT);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 5);
            assert.strictEqual(operation.isAssignment, false);
        });

        test('should detect constant left shift without parentheses: 1U << 12', () => {
            const line = '    #define BIT12 1U << 12';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 12);
        });

        test('should detect constant AND: 0xFF & 0x0F', () => {
            const line = '    result = 0xFF & 0x0F;';
            const operation = detectBitOperation(line, 18); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.AND);
            assert.strictEqual(operation.leftOperand, 0xFF);
            assert.strictEqual(operation.operand, 0x0F);
        });

        test('should detect constant OR: 0x80 | 0x40', () => {
            const line = '    #define FLAGS (0x80 | 0x40)';
            const operation = detectBitOperation(line, 27); // Cursor on '|'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.OR);
            assert.strictEqual(operation.leftOperand, 0x80);
            assert.strictEqual(operation.operand, 0x40);
        });

        test('should detect constant XOR: 0xAA ^ 0x55', () => {
            const line = '    temp = 0xAA ^ 0x55;';
            const operation = detectBitOperation(line, 16); // Cursor on '^'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.XOR);
            assert.strictEqual(operation.leftOperand, 0xAA);
            assert.strictEqual(operation.operand, 0x55);
        });

        test('should detect constant right shift: 256 >> 4', () => {
            const line = '    value = 256 >> 4;';
            const operation = detectBitOperation(line, 16); // Cursor on '>>'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.RIGHT_SHIFT);
            assert.strictEqual(operation.leftOperand, 256);
            assert.strictEqual(operation.operand, 4);
        });

        test('should detect constant with binary literals: 0b1111 & 0b1010', () => {
            const line = '    mask = 0b1111 & 0b1010;';
            const operation = detectBitOperation(line, 19); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 0b1111);
            assert.strictEqual(operation.operand, 0b1010);
        });

        test('should handle constant with L suffix: 1L << 16', () => {
            const line = '    #define BIT (1L << 16)';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 16);
        });

        test('should handle constant with UL suffix: 1UL << 20', () => {
            const line = '    value = 1UL << 20;';
            const operation = detectBitOperation(line, 16); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 20);
        });

        test('should detect constant expression with spaces: 0xFF  &  0x0F', () => {
            const line = '    result = 0xFF  &  0x0F;';
            const operation = detectBitOperation(line, 19); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 0xFF);
            assert.strictEqual(operation.operand, 0x0F);
        });

        test('should detect multi-bit shift: 3U << 5', () => {
            const line = '    #define MASK 3U << 5';
            const operation = detectBitOperation(line, 20); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 3);
            assert.strictEqual(operation.operand, 5);
        });

        test('should prioritize variable pattern over constant when variable is present', () => {
            const line = '    value &= 0xFF;';
            const operation = detectBitOperation(line, 10); // Cursor on '&='

            // Should detect as variable operation, NOT constant expression
            assert.ok(operation);
            assert.strictEqual(operation.isConstant, undefined); // Not a constant expression
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
        });
    });

    suite('Bit Operation Calculation', () => {
        test('should calculate AND result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.AND_ASSIGN,
                operand: 0xFF,
                isAssignment: true,
                expression: 'value &= 0xFF',
                start: 0,
                end: 15
            };

            const result = calculateBitOperation(operation, 0x1234);

            assert.strictEqual(result.beforeValue, 0x1234);
            assert.strictEqual(result.afterValue, 0x34);
            assert.ok(result.changedBits.length > 0);
        });

        test('should calculate OR result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x0F);

            assert.strictEqual(result.beforeValue, 0x0F);
            assert.strictEqual(result.afterValue, 0x8F);
            assert.ok(result.setBits.includes(7)); // Bit 7 should be set
        });

        test('should calculate XOR result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.XOR_ASSIGN,
                operand: 0xFF,
                isAssignment: true,
                expression: 'value ^= 0xFF',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x00);

            assert.strictEqual(result.beforeValue, 0x00);
            assert.strictEqual(result.afterValue, 0xFF);
            assert.strictEqual(result.setBits.length, 8); // 8 bits set
        });

        test('should calculate left shift result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.LEFT_SHIFT_ASSIGN,
                operand: 4,
                isAssignment: true,
                expression: 'value <<= 4',
                start: 0,
                end: 13
            };

            const result = calculateBitOperation(operation, 0x01);

            assert.strictEqual(result.beforeValue, 0x01);
            assert.strictEqual(result.afterValue, 0x10);
        });

        test('should calculate right shift result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.RIGHT_SHIFT_ASSIGN,
                operand: 4,
                isAssignment: true,
                expression: 'value >>= 4',
                start: 0,
                end: 13
            };

            const result = calculateBitOperation(operation, 0xF0);

            assert.strictEqual(result.beforeValue, 0xF0);
            assert.strictEqual(result.afterValue, 0x0F);
        });

        test('should calculate NOT result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.NOT,
                operand: 0,
                isAssignment: false,
                expression: '~value',
                start: 0,
                end: 6
            };

            const result = calculateBitOperation(operation, 0xFF);

            assert.strictEqual(result.beforeValue, 0xFF);
            assert.strictEqual(result.afterValue, ~0xFF);
        });

        test('should identify set and cleared bits', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x81, // Bits 0 and 7
                isAssignment: true,
                expression: 'value |= 0x81',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x00);

            assert.strictEqual(result.setBits.length, 2);
            assert.ok(result.setBits.includes(0));
            assert.ok(result.setBits.includes(7));
            assert.strictEqual(result.clearedBits.length, 0);
        });
    });

    suite('Constant Expression Calculation', () => {
        test('should calculate constant left shift: 1 << 5', () => {
            const operation: BitOperation = {
                operator: BitOperationType.LEFT_SHIFT,
                operand: 5,
                leftOperand: 1,
                isAssignment: false,
                isConstant: true,
                expression: '1 << 5',
                start: 0,
                end: 6
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 1); // Left operand
            assert.strictEqual(result.afterValue, 32); // 1 << 5 = 32
        });

        test('should calculate constant left shift: 1U << 12', () => {
            const operation: BitOperation = {
                operator: BitOperationType.LEFT_SHIFT,
                operand: 12,
                leftOperand: 1,
                isAssignment: false,
                isConstant: true,
                expression: '1U << 12',
                start: 0,
                end: 8
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 1);
            assert.strictEqual(result.afterValue, 4096); // 1 << 12 = 0x1000
        });

        test('should calculate constant AND: 0xFF & 0x0F', () => {
            const operation: BitOperation = {
                operator: BitOperationType.AND,
                operand: 0x0F,
                leftOperand: 0xFF,
                isAssignment: false,
                isConstant: true,
                expression: '0xFF & 0x0F',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0xFF);
            assert.strictEqual(result.afterValue, 0x0F); // 0xFF & 0x0F = 0x0F
        });

        test('should calculate constant OR: 0x80 | 0x40', () => {
            const operation: BitOperation = {
                operator: BitOperationType.OR,
                operand: 0x40,
                leftOperand: 0x80,
                isAssignment: false,
                isConstant: true,
                expression: '0x80 | 0x40',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0x80);
            assert.strictEqual(result.afterValue, 0xC0); // 0x80 | 0x40 = 0xC0
        });

        test('should calculate constant XOR: 0xAA ^ 0x55', () => {
            const operation: BitOperation = {
                operator: BitOperationType.XOR,
                operand: 0x55,
                leftOperand: 0xAA,
                isAssignment: false,
                isConstant: true,
                expression: '0xAA ^ 0x55',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0xAA);
            assert.strictEqual(result.afterValue, 0xFF); // 0xAA ^ 0x55 = 0xFF
        });

        test('should calculate constant right shift: 256 >> 4', () => {
            const operation: BitOperation = {
                operator: BitOperationType.RIGHT_SHIFT,
                operand: 4,
                leftOperand: 256,
                isAssignment: false,
                isConstant: true,
                expression: '256 >> 4',
                start: 0,
                end: 8
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 256);
            assert.strictEqual(result.afterValue, 16); // 256 >> 4 = 16
        });
    });

    suite('Bit Operation Formatting', () => {
        test('should format operation result with before value', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x0F);
            const markdown = formatBitOperationResult(result);

            assert.ok(markdown.value.includes('Bit Operation Result'));
            assert.ok(markdown.value.includes('value |= 0x80'));
            assert.ok(markdown.value.includes('Before'));
            assert.ok(markdown.value.includes('After'));
            assert.ok(markdown.value.includes('0x0000008F')); // Hex values are 8-digit padded
        });

        test('should format operation result without before value', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation); // No before value
            const markdown = formatBitOperationResult(result);

            assert.ok(markdown.value.includes('Bit Operation Result'));
            assert.ok(markdown.value.includes('After'));
            assert.ok(markdown.value.includes('0x00000080'));
        });
    });
});
