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

        test('Ignore #define prefix without delimiter', () => {
            const text = '#defineFOO 0xFF\n#define REAL_MACRO 0x01';
            const macros = MacroExpander.parseMacroDefinitions(text);

            assert.strictEqual(macros.size, 1);
            assert.ok(!macros.has('FOO'));
            assert.strictEqual(macros.get('REAL_MACRO')?.value, '0x01');
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

    /**
     * 깊이 제한만으로는 막을 수 없는 형태들.
     *
     * `#define Mn M(n-1) M(n-1)` 는 깊이가 n 밖에 안 되는데 결과는 2^n 으로
     * 커진다. 예산이 없던 시절 깊이 18 하나로 524,287자 · 262,144 step ·
     * steps 배열만 9.7MB 를 만들었고, 이 확장은 호버 한 번에 동기로 돌기
     * 때문에 Extension Host 가 그대로 멈췄다.
     */
    suite('Expansion budgets', () => {
        /** `Mn = M(n-1) M(n-1)` 사슬을 만든다 (M0 = 'A'). */
        function binaryChain(depth: number): Map<string, MacroDefinition> {
            const macros = new Map<string, MacroDefinition>();
            macros.set('M0', { name: 'M0', value: 'A' });
            for (let i = 1; i <= depth; i++) {
                macros.set(`M${i}`, { name: `M${i}`, value: `M${i - 1} M${i - 1}` });
            }
            return macros;
        }

        test('지수적으로 팽창하는 매크로는 성공 대신 오류로 끝난다', () => {
            const started = Date.now();
            const result = expander.expandMacro('M18', binaryChain(18));

            assert.strictEqual(result.success, false, '예산을 넘었으면 success 여서는 안 된다');
            assert.match(String(result.error), /combinatorially/);
            // 호버 경로는 동기다. 예산이 없으면 여기서 수백 ms ~ 수 초가 걸렸다.
            assert.ok(Date.now() - started < 2000, '예산 초과는 빠르게 판정되어야 한다');
        });

        test('예산 초과는 steps 를 무한정 모으지 않는다', () => {
            const result = expander.expandMacro('M18', binaryChain(18));
            assert.ok(
                result.expansionSteps.length <= 501,
                `steps 가 상한을 넘었다: ${result.expansionSteps.length}`
            );
        });

        test('상한 아래의 공유 하위식은 memo 로 접혀 정상 확장된다', () => {
            // M12 = 2^12 개의 'A' → 8191자. 상한(64KB) 아래라 성공해야 한다.
            // memo 가 없으면 4095번의 중복 재귀가 일어나는 자리다.
            const result = expander.expandMacro('M12', binaryChain(12));

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, new Array(4096).fill('A').join(' '));
        });

        test('memo 는 순환 참조 판정을 바꾸지 않는다', () => {
            // B 의 확장 결과는 "A 가 확장 중인가"에 달려 있으므로 memo 에 담기면
            // 안 된다. 담기면 A 를 먼저 확장한 뒤 B 를 확장할 때 A 문맥에서
            // 계산된 값이 새어 나온다. 두 진입점이 각자의 결과를 내야 한다.
            const macros = new Map<string, MacroDefinition>([
                ['A', { name: 'A', value: 'B' }],
                ['B', { name: 'B', value: 'A C' }],
                ['C', { name: 'C', value: '1' }]
            ]);

            const fromA = expander.expandMacro('A', macros);
            const fromB = expander.expandMacro('B', macros);

            assert.strictEqual(fromA.success, true);
            assert.strictEqual(fromA.expandedValue, 'B 1');
            assert.strictEqual(fromB.success, true);
            assert.strictEqual(fromB.expandedValue, 'A 1 1');

            // 순서를 뒤집어도 같아야 한다 (memo 가 호출을 가로질러 남지 않는다).
            const fresh = new MacroExpander();
            assert.strictEqual(fresh.expandMacro('B', macros).expandedValue, 'A 1 1');
            assert.strictEqual(fresh.expandMacro('A', macros).expandedValue, 'B 1');
        });

        test('3중 분기 사슬도 예산에 걸린다', () => {
            const macros = new Map<string, MacroDefinition>();
            macros.set('E0', { name: 'E0', value: '' });
            for (let i = 1; i <= 20; i++) {
                macros.set(`E${i}`, { name: `E${i}`, value: `E${i - 1} E${i - 1} E${i - 1}` });
            }

            const result = expander.expandMacro('E20', macros);
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /combinatorially/);
        });

        test('길이가 줄어드는 확장은 치환 횟수 예산이 잡는다', () => {
            // 길이 예산만으로는 못 막는 형태: `L` 은 빈 매크로로 확장되므로
            // 결과가 **짧아진다**. 노드 수만 폭발하는 경우를 위해 두 번째
            // 예산이 있고, 이 fixture 가 그것을 실제로 밟는다.
            const macros = new Map<string, MacroDefinition>([
                ['Z', { name: 'Z', value: '' }],
                ['L', { name: 'L', value: 'Z' }],
                ['M', { name: 'M', value: new Array(20001).fill('L').join(' ') }]
            ]);

            const result = expander.expandMacro('M', macros);

            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /20000 substitutions/);
        });

        test('참조가 없는 거대 매크로도 예산에 걸린다', () => {
            // 치환이 한 번도 일어나지 않으므로 "치환 후" 검사만으로는 통과한다.
            // 확장 비용은 없지만 70KB 문자열이 steps 와 호버 마크다운을 타고
            // 그대로 흐르므로, 진입 시점에도 재야 한다.
            const macros = new Map<string, MacroDefinition>([
                ['BIG', { name: 'BIG', value: 'X'.repeat(70000) }]
            ]);

            const result = expander.expandMacro('BIG', macros);

            assert.strictEqual(result.success, false, '참조 없는 거대 매크로가 그대로 통과했다');
            assert.match(String(result.error), /characters/);
            // 거대 문자열이 steps 에 실려 나가지도 않아야 한다.
            for (const step of result.expansionSteps) {
                assert.ok(step.length <= 65536 + 64, `steps 에 예산을 넘는 항목이 남았다: ${step.length}자`);
            }
        });

        test('중첩된 거대 leaf 도 예산에 걸린다', () => {
            const macros = new Map<string, MacroDefinition>([
                ['BIG', { name: 'BIG', value: 'X'.repeat(70000) }],
                ['WRAP', { name: 'WRAP', value: '(BIG)' }]
            ]);

            const result = expander.expandMacro('WRAP', macros);
            assert.strictEqual(result.success, false);
        });

        test('상한 바로 아래 매크로는 그대로 확장된다', () => {
            const value = 'X'.repeat(65536);
            const macros = new Map<string, MacroDefinition>([
                ['EDGE', { name: 'EDGE', value }]
            ]);

            const result = expander.expandMacro('EDGE', macros);
            assert.strictEqual(result.success, true, '경계값이 잘못 막혔다');
            assert.strictEqual(result.expandedValue, value);
        });

        test('memo 가 깊이 제한을 토큰 순서에 따라 우회하지 않는다', () => {
            // M0 → M1 → … → M51 → 1 사슬 (maxDepth 50 초과).
            // 치환이 역순이라 `M0 M50` 에서는 M50 이 먼저 캐시되고, 그 캐시를
            // 재사용한 M0 의 확장은 깊이 검사를 건너뛰어 성공해 버렸다.
            // 같은 정의 집합인데 토큰 순서로 답이 갈리면 안 된다.
            const chain = new Map<string, MacroDefinition>();
            for (let i = 0; i < 51; i++) {
                chain.set(`M${i}`, { name: `M${i}`, value: `M${i + 1}` });
            }
            chain.set('M51', { name: 'M51', value: '1' });

            const results = ['M0', 'M50 M0', 'M0 M50'].map(value => {
                const macros = new Map(chain);
                macros.set('X', { name: 'X', value });
                return { value, result: new MacroExpander().expandMacro('X', macros) };
            });

            for (const { value, result } of results) {
                assert.strictEqual(
                    result.success, false,
                    `'${value}' 가 깊이 제한을 우회했다 (결과: ${JSON.stringify(result.expandedValue)})`
                );
                assert.match(String(result.error), /depth/i);
            }
        });

        test('깊이 한도 안이면 memo 재사용이 그대로 동작한다', () => {
            // 위와 같은 구조지만 사슬이 짧아 어느 순서로도 성공해야 한다.
            const chain = new Map<string, MacroDefinition>();
            for (let i = 0; i < 5; i++) {
                chain.set(`M${i}`, { name: `M${i}`, value: `M${i + 1}` });
            }
            chain.set('M5', { name: 'M5', value: '1' });

            for (const value of ['M0 M4', 'M4 M0']) {
                const macros = new Map(chain);
                macros.set('X', { name: 'X', value });
                const r = new MacroExpander().expandMacro('X', macros);
                assert.strictEqual(r.success, true, `'${value}' 가 잘못 막혔다: ${r.error}`);
                assert.strictEqual(r.expandedValue, '1 1');
            }
        });

        test('평범한 임베디드 매크로는 예산에 걸리지 않는다', () => {
            const macros = new Map<string, MacroDefinition>([
                ['BASE', { name: 'BASE', value: '0x40000000' }],
                ['OFFSET', { name: 'OFFSET', value: '0x400' }],
                ['PORT', { name: 'PORT', value: '(BASE + OFFSET)' }],
                ['PIN_MASK', { name: 'PIN_MASK', value: '(1 << 5)' }],
                ['REG', { name: 'REG', value: '(PORT | PIN_MASK)' }]
            ]);

            const result = expander.expandMacro('REG', macros);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.expandedValue, '((0x40000000 + 0x400) | (1 << 5))');
        });
    });
});
