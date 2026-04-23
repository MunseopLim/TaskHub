import * as assert from 'assert';
import { MacroExpander, MacroDefinition } from '../macroExpander';

suite('MacroExpander Test Suite', () => {
    let expander: MacroExpander;

    setup(() => {
        expander = new MacroExpander();
    });

    suite('Simple Macro Expansion', () => {
        test('Expand simple numeric macro', () => {
            const macros = new Map<string, MacroDefinition>([
                ['MAX_SIZE', { name: 'MAX_SIZE', value: '0x1000' }]
            ]);

            const result = expander.expandMacro('MAX_SIZE', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '0x1000');
            assert.ok(result.expansionSteps.length > 0);
        });

        test('Expand macro with binary value', () => {
            const macros = new Map<string, MacroDefinition>([
                ['FLAGS', { name: 'FLAGS', value: '0b11110000' }]
            ]);

            const result = expander.expandMacro('FLAGS', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '0b11110000');
        });

        test('Expand macro with decimal value', () => {
            const macros = new Map<string, MacroDefinition>([
                ['COUNT', { name: 'COUNT', value: '255' }]
            ]);

            const result = expander.expandMacro('COUNT', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '255');
        });
    });

    suite('Recursive Macro Expansion', () => {
        test('Expand macro referencing another macro', () => {
            const macros = new Map<string, MacroDefinition>([
                ['BIT0', { name: 'BIT0', value: '0x01' }],
                ['BIT5', { name: 'BIT5', value: '0x20' }],
                ['IRQ_ENABLE', { name: 'IRQ_ENABLE', value: 'BIT0 | BIT5' }]
            ]);

            const result = expander.expandMacro('IRQ_ENABLE', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '0x01 | 0x20');
            assert.ok(result.expansionSteps.length >= 2);
        });

        test('Expand deeply nested macros', () => {
            const macros = new Map<string, MacroDefinition>([
                ['LEVEL1', { name: 'LEVEL1', value: '0x01' }],
                ['LEVEL2', { name: 'LEVEL2', value: 'LEVEL1' }],
                ['LEVEL3', { name: 'LEVEL3', value: 'LEVEL2' }],
                ['LEVEL4', { name: 'LEVEL4', value: 'LEVEL3' }]
            ]);

            const result = expander.expandMacro('LEVEL4', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '0x01');
        });

        test('Expand macro with multiple references', () => {
            const macros = new Map<string, MacroDefinition>([
                ['BIT0', { name: 'BIT0', value: '(1 << 0)' }],
                ['BIT1', { name: 'BIT1', value: '(1 << 1)' }],
                ['BIT2', { name: 'BIT2', value: '(1 << 2)' }],
                ['ALL_BITS', { name: 'ALL_BITS', value: 'BIT0 | BIT1 | BIT2' }]
            ]);

            const result = expander.expandMacro('ALL_BITS', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '(1 << 0) | (1 << 1) | (1 << 2)');
        });
    });

    suite('Circular Reference Detection', () => {
        test('Detect direct circular reference', () => {
            const macros = new Map<string, MacroDefinition>([
                ['A', { name: 'A', value: 'A' }]
            ]);

            const result = expander.expandMacro('A', macros);

            // Should not expand to avoid infinite loop
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, 'A');
        });

        test('Detect indirect circular reference', () => {
            const macros = new Map<string, MacroDefinition>([
                ['A', { name: 'A', value: 'B' }],
                ['B', { name: 'B', value: 'A' }]
            ]);

            const result = expander.expandMacro('A', macros);

            // Should stop expansion when detecting circular reference
            assert.strictEqual(result.success, true);
            // Result should be either 'B' or 'A' depending on implementation
            assert.ok(result.expandedValue === 'A' || result.expandedValue === 'B');
        });
    });

    suite('Error Handling', () => {
        test('Handle undefined macro', () => {
            const macros = new Map<string, MacroDefinition>();

            const result = expander.expandMacro('UNDEFINED', macros);

            assert.strictEqual(result.success, false);
            assert.ok(result.error);
            assert.ok(result.error.includes('not found'));
        });

        test('Handle macro with undefined reference', () => {
            const macros = new Map<string, MacroDefinition>([
                ['DEFINED', { name: 'DEFINED', value: 'UNDEFINED_REF' }]
            ]);

            const result = expander.expandMacro('DEFINED', macros);

            // Should expand to the undefined reference
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, 'UNDEFINED_REF');
        });
    });

    suite('Macro Definition Parsing', () => {
        test('Parse simple #define', () => {
            const text = '#define MAX_SIZE 0x1000';
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 1);
            assert.ok(macros.has('MAX_SIZE'));
            assert.strictEqual(macros.get('MAX_SIZE')?.value, '0x1000');
        });

        test('Parse multiple #defines', () => {
            const text = `
#define BIT0 0x01
#define BIT1 0x02
#define BIT2 0x04
            `;
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 3);
            assert.strictEqual(macros.get('BIT0')?.value, '0x01');
            assert.strictEqual(macros.get('BIT1')?.value, '0x02');
            assert.strictEqual(macros.get('BIT2')?.value, '0x04');
        });

        test('Parse #define with expression', () => {
            const text = '#define IRQ_ENABLE (BIT0 | BIT5)';
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 1);
            assert.strictEqual(macros.get('IRQ_ENABLE')?.value, '(BIT0 | BIT5)');
        });

        test('Parse #define with trailing comment', () => {
            const text = '#define MAX_SIZE 0x1000 // Maximum buffer size';
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 1);
            assert.strictEqual(macros.get('MAX_SIZE')?.value, '0x1000');
        });

        test('Ignore non-define lines', () => {
            const text = `
int value = 10;
#define REAL_MACRO 0xFF
const int x = 5;
            `;
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 1);
            assert.ok(macros.has('REAL_MACRO'));
        });
    });

    suite('Numeric Evaluation', () => {
        test('Evaluate hex to number', () => {
            const result = MacroExpander.evaluateToNumber('0xFF');
            assert.strictEqual(result, 255);
        });

        test('Evaluate binary to number', () => {
            const result = MacroExpander.evaluateToNumber('0b11111111');
            assert.strictEqual(result, 255);
        });

        test('Evaluate decimal to number', () => {
            const result = MacroExpander.evaluateToNumber('255');
            assert.strictEqual(result, 255);
        });

        test('Evaluate shift expression', () => {
            const result = MacroExpander.evaluateToNumber('1 << 8');
            assert.strictEqual(result, 256);
        });

        test('Shift count is clamped to avoid overflow', () => {
            // Prior code performed `Math.pow(2, 9999)` which becomes Infinity.
            // The clamped version must return a finite number (possibly null, never NaN/Infinity).
            const result = MacroExpander.evaluateToNumber('1 << 9999');
            assert.ok(result === null || Number.isFinite(result), `expected finite or null, got ${result}`);
        });

        test('Very long expressions are rejected', () => {
            const result = MacroExpander.evaluateToNumber('(1)' + ' + 0'.repeat(5000));
            assert.strictEqual(result, null);
        });

        // --- 4096-length boundary -----------------------------------------
        // MacroExpander.evaluateToNumber bails with `cleaned.length > 4096`
        // as a ReDoS / huge-eval guard. The method trims leading/trailing
        // whitespace first (`cleaned = expanded.trim()`), so the inputs
        // below use only non-whitespace at each end to make the boundary
        // exact. The expressions `1+1+1+...+1` and `1 +1+1+...+1` do not
        // hit any of the simple-pattern early returns, pass the
        // safe-character regex, and survive hex/binary rewriting unchanged —
        // so length(cleaned) === length(input.trim()).
        test('expression at length 4095 evaluates (below the limit)', () => {
            // "1" (len 1) + "+1" * 2047 (len 4094) = 4095 chars, value 2048
            const expr = '1' + '+1'.repeat(2047);
            assert.strictEqual(expr.length, 4095);
            const result = MacroExpander.evaluateToNumber(expr);
            assert.strictEqual(result, 2048);
        });

        test('expression exactly at the 4096 length limit still evaluates', () => {
            // "1 " (len 2) + "+1" * 2047 (len 4094) = 4096 chars, value 2048
            const expr = '1 ' + '+1'.repeat(2047);
            assert.strictEqual(expr.length, 4096);
            const result = MacroExpander.evaluateToNumber(expr);
            assert.strictEqual(result, 2048);
        });

        test('expression at length 4097 is rejected (one char over the limit)', () => {
            // "1" + "+1" * 2048 (len 4096) = 4097 chars — no surrounding
            // whitespace, so cleaned.length === 4097 after trim().
            const expr = '1' + '+1'.repeat(2048);
            assert.strictEqual(expr.length, 4097);
            const result = MacroExpander.evaluateToNumber(expr);
            assert.strictEqual(result, null);
        });

        test('Evaluate OR expression', () => {
            const result = MacroExpander.evaluateToNumber('0x01 | 0x02');
            assert.strictEqual(result, 3);
        });

        test('Evaluate complex expression', () => {
            const result = MacroExpander.evaluateToNumber('(1 << 0) | (1 << 5)');
            assert.strictEqual(result, 33);
        });

        test('Return null for non-numeric string', () => {
            const result = MacroExpander.evaluateToNumber('NOT_A_NUMBER');
            assert.strictEqual(result, null);
        });

        test('Return null for unsafe expression', () => {
            const result = MacroExpander.evaluateToNumber('alert("bad")');
            assert.strictEqual(result, null);
        });
    });

    suite('Real-world Examples', () => {
        test('Expand typical bit mask macro', () => {
            const macros = new Map<string, MacroDefinition>([
                ['BIT0', { name: 'BIT0', value: '(1 << 0)' }],
                ['BIT5', { name: 'BIT5', value: '(1 << 5)' }],
                ['UART_TX_EN', { name: 'UART_TX_EN', value: '0x40' }],
                ['IRQ_ENABLE', { name: 'IRQ_ENABLE', value: '(BIT0 | BIT5 | UART_TX_EN)' }]
            ]);

            const result = expander.expandMacro('IRQ_ENABLE', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '((1 << 0) | (1 << 5) | 0x40)');

            // Should be able to evaluate to a number
            const numValue = MacroExpander.evaluateToNumber(result.expandedValue);
            assert.strictEqual(numValue, 0x61); // 0x01 | 0x20 | 0x40
        });

        test('Expand register bit field macro', () => {
            const macros = new Map<string, MacroDefinition>([
                ['REG_OFFSET', { name: 'REG_OFFSET', value: '0x1000' }],
                ['BASE_ADDR', { name: 'BASE_ADDR', value: '0x40000000' }],
                ['UART_CTRL', { name: 'UART_CTRL', value: '(BASE_ADDR + REG_OFFSET)' }]
            ]);

            const result = expander.expandMacro('UART_CTRL', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '(0x40000000 + 0x1000)');

            const numValue = MacroExpander.evaluateToNumber(result.expandedValue);
            assert.strictEqual(numValue, 0x40001000);
        });
    });

    suite('Edge Cases', () => {
        test('Handle macro with parentheses', () => {
            const macros = new Map<string, MacroDefinition>([
                ['WRAPPED', { name: 'WRAPPED', value: '(0xFF)' }]
            ]);

            const result = expander.expandMacro('WRAPPED', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '(0xFF)');
        });

        test('Handle macro with multiple operators', () => {
            const macros = new Map<string, MacroDefinition>([
                ['COMPLEX', { name: 'COMPLEX', value: '((1 << 5) | (1 << 3) & 0xFF)' }]
            ]);

            const result = expander.expandMacro('COMPLEX', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '((1 << 5) | (1 << 3) & 0xFF)');
        });

        test('Handle empty macro value', () => {
            const macros = new Map<string, MacroDefinition>([
                ['EMPTY', { name: 'EMPTY', value: '' }]
            ]);

            const result = expander.expandMacro('EMPTY', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '');
        });
    });
});
