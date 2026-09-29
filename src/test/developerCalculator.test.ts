import * as assert from 'assert';
import * as vm from 'vm';
import { evaluateDeveloperExpression } from '../developerCalculator';

suite('Developer calculator', () => {
    function value(expression: string): string {
        const result = evaluateDeveloperExpression(expression);
        assert.ok(result.ok, JSON.stringify({ expression, result }));
        return result.decimal;
    }
    test('address differences preserve negative values and full 64-bit precision', () => {
        assert.strictEqual(value('0x08004000 - 0x08000000'), '16384');
        assert.strictEqual(value('0x08000000 - 0x08004000'), '-16384');
        assert.strictEqual(value('0xFFFFFFFFFFFFFFFF - 0xFFFFFFFFFFFFFFFE'), '1');
        assert.strictEqual(value('0xFFFFFFFFFFFFFFFF + 1'), '18446744073709551616');
        assert.strictEqual(value('0x10000000000000000 * 0x10000000000000000'), (1n << 128n).toString());
    });
    test('mixed bases, units, separators and C suffixes need no mode switching', () => {
        const cases: Array<[string, string]> = [
            ['0x10 + 10 + 0b10', '28'], ['64KiB - 0x1800', '59392'], ['1GiB / 1MiB', '1024'],
            ['0x1ULL << 40', '1099511627776'], ['0 + 0U', '0'], ["0xFF'FF + 1_000U", '66535'],
            ['1 + 2 * 3', '7'], ['(1 + 2) * 3', '9'], ['1 << 3 + 1', '16'],
            ['0xA5 & ~0x0F', '160'], ['8 / 3 * 3', '6'], ['-8 / 3', '-2'], ['-8 % 3', '-2'],
            ['-8 >> 2', '-2'], ['-7 >> 1', '-4'], ['1 | 2 ^ 3 & 4', '3'], ['+2 - -3', '5'],
        ];
        for (const [expression, expected] of cases) { assert.strictEqual(value(expression), expected, expression); }
    });
    test('rejects ambiguous leading-zero integers without changing explicit bases or single zero', () => {
        for (const literal of ['0755', '09', '00', '0755U', '00LL', '09KiB', "0'755", '0_9', '0_0ULL', "0'0MiB"]) {
            assert.deepStrictEqual(evaluateDeveloperExpression(`1 + ${literal}`), {
                ok: false, reason: 'leading-zero', index: 4,
            }, literal);
        }
        for (const literal of ['0', '0U', '0ll', '0LLU', '0KiB', '0MiB', '0GiB', '0x00', '0X0ULL', '0b00', '0B0u']) {
            assert.strictEqual(value(literal), '0', literal);
        }
        assert.strictEqual(value('0x0755'), '1877');
        assert.strictEqual(value('0b0101'), '5');
    });
    test('accepts C integer suffixes with matching long-long case only', () => {
        for (const suffix of ['u', 'U', 'l', 'L', 'll', 'LL', 'ul', 'uL', 'Ul', 'UL', 'lu', 'lU', 'Lu', 'LU',
            'ull', 'uLL', 'Ull', 'ULL', 'llu', 'llU', 'LLu', 'LLU']) {
            assert.strictEqual(value(`17${suffix}`), '17', suffix);
        }
        for (const suffix of ['lL', 'Ll', 'ulL', 'uLl', 'UlL', 'ULl', 'lLu', 'lLU', 'Llu', 'LlU', 'UU', 'LLL']) {
            assert.deepStrictEqual(evaluateDeveloperExpression(`17${suffix}`), {
                ok: false, reason: 'invalid-token', index: 0,
            }, suffix);
        }
        // A long suffix run followed by a non-suffix character used to trigger quadratic retries.
        assert.deepStrictEqual(evaluateDeveloperExpression('1' + 'L'.repeat(4094) + 'a'), {
            ok: false, reason: 'invalid-token', index: 0,
        });
        assert.deepStrictEqual(evaluateDeveloperExpression('1' + 'L'.repeat(4095)), {
            ok: false, reason: 'invalid-token', index: 0,
        });
    });
    test('memory helpers make end inclusivity and alignment explicit', () => {
        assert.strictEqual(value('rangeSize(0x08000000, 0x08003FFF)'), '16384');
        assert.strictEqual(value('rangeSize(0xFF, 0xFF)'), '1');
        assert.strictEqual(value('alignUp(0x20000103, 4)'), '536871172');
        assert.strictEqual(value('alignDown(0x20000103, 4)'), '536871168');
        assert.strictEqual(value('alignUp(12, 6)'), '12');
        assert.strictEqual(value('alignUp(rangeSize(0, 6), 4)'), '8');
        assert.strictEqual(value('alignDown(5, 3)'), '3');
    });
    test('results and byte interpretations are exact strings, with division truncation surfaced', () => {
        const result = evaluateDeveloperExpression('-0x4000');
        assert.ok(result.ok);
        assert.strictEqual(result.hex, '-0x4000');
        assert.strictEqual(result.binary, '-0b100000000000000');
        assert.strictEqual(result.size, '-16 KiB');
        const fraction = evaluateDeveloperExpression('1025');
        assert.ok(fraction.ok);
        assert.strictEqual(fraction.size, '1.0009765625 KiB');
        const zero = evaluateDeveloperExpression('0');
        assert.ok(zero.ok);
        assert.strictEqual(zero.size, '0 B');
        for (const [expression, expected] of [['8 / 3', true], ['(8 / 3) * 3', true], ['8 / 2', false], ['8 % 3', false]] as const) {
            const answer = evaluateDeveloperExpression(expression);
            assert.ok(answer.ok);
            assert.strictEqual(answer.truncated, expected, expression);
        }
    });
    test('matches exact integer arithmetic across a range of signed operands', () => {
        for (let index = 1n; index <= 80n; index++) {
            const left = (1n << 64n) + index;
            const right = index % 2n === 0n ? -index : index;
            for (const [operator, expected] of [['+', left + right], ['-', left - right], ['*', left * right], ['/', left / right], ['%', left % right]] as const) {
                assert.strictEqual(value(`${left} ${operator} (${right})`), expected.toString());
            }
        }
    });
    test('rejects invalid expressions, dangerous syntax, and floats without partial answers', () => {
        for (const expression of ['0755.0', '1e3', '0x1p2', '0b2', '0x', '0xFFLLL', '1__0', "1'", '1 +', '(1', '1 2',
            'alignUp(1)', 'alignUp(1,2,3)', 'unknown(1)', 'globalThis.x=1', 'constructor(1)', '__proto__', '1;2', '2 ** 3']) {
            const result = evaluateDeveloperExpression(expression);
            assert.strictEqual(result.ok, false, expression);
            if (!result.ok) { assert.ok(Number.isInteger(result.index) && result.index >= 0 && result.index <= expression.length); }
        }
    });
    test('reports division, shift, memory argument and intermediate overflow errors', () => {
        for (const [expression, reason] of [
            ['1 / 0', 'divide-by-zero'], ['1 % 0', 'divide-by-zero'], ['1 << -1', 'invalid-shift'],
            ['1 << 256', 'invalid-shift'], ['alignUp(1, 0)', 'invalid-arguments'], ['alignDown(-1, 4)', 'invalid-arguments'],
            ['rangeSize(2, 1)', 'invalid-arguments'], ['rangeSize(-1, 2)', 'invalid-arguments'],
            ['(1 << 255) * 2 - 1', 'out-of-range'], ['~(0x' + 'F'.repeat(64) + ')', 'out-of-range'],
        ]) {
            const result = evaluateDeveloperExpression(expression);
            assert.ok(!result.ok, expression);
            assert.strictEqual(result.reason, reason, expression);
        }
        assert.strictEqual(value('0x' + 'F'.repeat(64)), ((1n << 256n) - 1n).toString());
    });
    test('pinpoints invalid tokens, operands, delimiters, and overflowing operators', () => {
        for (const [expression, reason, index] of [
            ['', 'empty', 0], [' \t ', 'empty', 0], ['1 + $', 'invalid-token', 4], ['1 + 17lL', 'invalid-token', 4],
            ['1 + 0755', 'leading-zero', 4], ['1 + ', 'invalid-expression', 4], ['(1 + 2', 'invalid-expression', 6],
            ['1 2', 'invalid-expression', 2], ['1 / (2 - 2)', 'divide-by-zero', 4], ['1 << -1', 'invalid-shift', 5],
            ['1 >> 256', 'invalid-shift', 5], ['1 + alignUp(2, 0)', 'invalid-arguments', 4],
            ['1 + rangeSize(2, 1)', 'invalid-arguments', 4], ['(1 << 255) * 2', 'out-of-range', 11],
            ['1 + ' + (1n << 256n).toString(), 'out-of-range', 4],
        ] as const) {
            assert.deepStrictEqual(evaluateDeveloperExpression(expression), { ok: false, reason, index }, expression);
        }
    });
    test('checks shift, alignment, and inclusive range boundaries at the 256-bit limit', () => {
        const maximum = (1n << 256n) - 1n;
        const half = 1n << 255n;
        for (const [expression, expected] of [
            ['1 << 255', half], ['-1 << 255', -half], [`${maximum} >> 255`, 1n], ['-7 >> 255', -1n],
            ['0 << 255', 0n], [`-${maximum}`, -maximum], [`alignUp(${maximum}, 1)`, maximum],
            [`alignUp(${maximum}, ${maximum})`, maximum], [`alignUp(${maximum - 1n}, ${maximum})`, maximum],
            [`alignUp(0, ${maximum})`, 0n], [`alignDown(${maximum}, 2)`, maximum - 1n],
            [`alignDown(${maximum}, ${maximum})`, maximum], [`rangeSize(1, ${maximum})`, maximum],
            [`rangeSize(${maximum}, ${maximum})`, 1n],
        ] as const) {
            assert.strictEqual(value(expression), expected.toString(), expression);
        }
        for (const [expression, reason] of [
            ['0 << 256', 'invalid-shift'], ['0 >> 256', 'invalid-shift'], ['2 << 255', 'out-of-range'],
            [`${maximum} + 1`, 'out-of-range'], [`-${maximum} - 1`, 'out-of-range'],
            [`alignUp(${maximum}, 2)`, 'out-of-range'], [`rangeSize(0, ${maximum})`, 'out-of-range'],
            ['alignDown(0, 0)', 'invalid-arguments'], ['alignUp(0, -1)', 'invalid-arguments'],
        ] as const) {
            const result = evaluateDeveloperExpression(expression);
            assert.ok(!result.ok, expression);
            assert.strictEqual(result.reason, reason, expression);
        }
    });
    test('bounds input length, token count and recursive nesting', () => {
        for (const expression of ['1'.repeat(4097), '1+'.repeat(129) + '1', '('.repeat(34) + '1' + ')'.repeat(34), '-'.repeat(34) + '1']) {
            const result = evaluateDeveloperExpression(expression);
            assert.ok(!result.ok);
            assert.strictEqual(result.reason, 'too-complex');
        }
    });
    test('the exact same evaluator runs self-contained inside a webview', () => {
        const browserEvaluate = vm.runInNewContext(`(${evaluateDeveloperExpression.toString()})`);
        for (const expression of ['0xFFFFFFFFFFFFFFFF - 1', 'alignUp(0x103, 4)', '64KiB - 0x1800', '8 / 3', '1/0', '1e3', '0755', '1lL']) {
            assert.strictEqual(JSON.stringify(browserEvaluate(expression)), JSON.stringify(evaluateDeveloperExpression(expression)));
        }
    });
});
