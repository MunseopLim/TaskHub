import * as assert from 'assert';
import * as vm from 'vm';
import {
    evaluateHexBitwiseExpression,
    HEX_BITWISE_MAX_EXPRESSION_LENGTH,
    HexBitwiseErrorReason,
} from '../hexBitwiseUtils';

suite('Hex 비트 수식 순수 로직', () => {
    function expectValue(expression: string, width: number, expected: bigint): void {
        assert.deepStrictEqual(evaluateHexBitwiseExpression(expression, width), {
            ok: true,
            hex: '0x' + expected.toString(16).toUpperCase().padStart(width / 4, '0'),
            decimal: expected.toString(),
            binary: '0b' + expected.toString(2).padStart(width, '0'),
        }, expression);
    }

    function expectError(expression: string, width: number, reason: HexBitwiseErrorReason, index: number): void {
        assert.deepStrictEqual(evaluateHexBitwiseExpression(expression, width), {
            ok: false, reason, index,
        }, expression);
    }

    test('Hex·binary·decimal과 공백을 읽고 각 진법 결과를 고정 폭으로 출력한다', () => {
        assert.deepStrictEqual(evaluateHexBitwiseExpression(' (0x1234 >> 8) & 0xFF ', 32), {
            ok: true,
            hex: '0x00000012',
            decimal: '18',
            binary: '0b00000000000000000000000000010010',
        });
        for (const expression of ['0xAB', '0Xab', '0b10101011', '0B10101011', '171', '00171', '\n\t171\r ']) {
            expectValue(expression, 8, 171n);
        }
        expectValue('010', 8, 10n);
        expectValue('08', 8, 8n);
        expectValue('000', 8, 0n);
        expectValue('0777', 16, 777n);
        expectValue('0755 & 0xFF', 16, 243n);
    });

    test('모든 연산자와 C 계열 우선순위 및 괄호를 지원한다', () => {
        expectValue('0xAA & 0x0F', 8, 10n);
        expectValue('0xA0 | 0x05', 8, 165n);
        expectValue('0xAA ^ 0x0F', 8, 165n);
        expectValue('~0x0F', 8, 240n);
        expectValue('1 << 3', 8, 8n);
        expectValue('0x80 >> 3', 8, 16n);
        expectValue('~1 << 1', 8, 252n);
        expectValue('4 & 1 << 2', 8, 4n);
        expectValue('1 ^ 3 & 2', 8, 3n);
        expectValue('1 | 1 ^ 3', 8, 3n);
        expectValue('(1 | 1) ^ 3', 8, 2n);
        expectValue('(4 & 1) << 2', 8, 0n);
        expectValue('~(0x0F | 0x80)', 8, 112n);
    });

    test('shift는 왼쪽부터 계산하고 unsigned 오른쪽 shift를 적용한다', () => {
        expectValue('0x80 >> 1 >> 2', 8, 16n);
        expectValue('1 << 2 << 1', 8, 8n);
        expectValue('0x80 >> 1 << 1', 8, 128n);
        expectValue('0x80000000 >> 1', 32, 1073741824n);
        expectValue('0x8000000000000000 >> 63', 64, 1n);
        expectValue('1 << (1 | 2)', 8, 8n);
    });

    test('중간 overflow와 NOT를 선택한 폭으로 자른다', () => {
        expectValue('0x80 << 1', 8, 0n);
        expectValue('0x80 << 1 >> 1', 8, 0n);
        expectValue('~0 >> 4', 8, 15n);
        expectValue('~(~0xA5)', 8, 165n);
        expectValue('(~0x7F << 1) | 1', 8, 1n);
        expectValue('0x8000000000000000 << 1', 64, 0n);
    });

    test('8·16·32·64비트 최댓값과 그 다음 정수를 구분한다', () => {
        for (const width of [8, 16, 32, 64]) {
            const maximum = (1n << BigInt(width)) - 1n;
            expectValue(maximum.toString(), width, maximum);
            expectValue('0x' + maximum.toString(16), width, maximum);
            expectValue('0b' + maximum.toString(2), width, maximum);
            expectValue('~0', width, maximum);
            expectError((maximum + 1n).toString(), width, 'out-of-range', 0);
            expectError('0 | 0x' + (maximum + 1n).toString(16), width, 'out-of-range', 4);
            expectError('0b' + (maximum + 1n).toString(2), width, 'out-of-range', 0);
        }
    });

    test('Number의 안전 정수 범위를 넘는 64비트 하위 비트를 보존한다', () => {
        expectValue('9007199254740993', 64, 9007199254740993n);
        expectValue('9007199254740993 & 0xFF', 64, 1n);
        expectValue('18446744073709551615 ^ 1', 64, 18446744073709551614n);
        expectValue('0xFEDCBA9876543210 & 0x00000000FFFFFFFF', 64, 1985229328n);
        expectValue('1 << 63 | 1', 64, 9223372036854775809n);
    });

    test('폭과 shift 횟수의 경계를 검사하고 횟수 위치를 알려준다', () => {
        for (const width of [8, 16, 32, 64]) {
            expectValue('1 << 0', width, 1n);
            expectValue('1 << ' + (width - 1), width, 1n << BigInt(width - 1));
            expectError('1 << ' + width, width, 'invalid-shift', 5);
            expectError('1 >> ' + width, width, 'invalid-shift', 5);
        }
        expectError('1 << (4 | 8)', 8, 'invalid-shift', 5);
        expectError('1 << ~0', 8, 'invalid-shift', 5);
        expectError('1 << -1', 8, 'invalid-token', 5);
        for (const width of [0, 7, 16.5, 65, -8, NaN, Infinity]) {
            expectError('1', width, 'invalid-width', 0);
        }
    });

    test('빈 입력과 불완전한 문법에 오류 위치를 반환한다', () => {
        expectError('', 32, 'empty', 0);
        expectError(' \n\t', 32, 'empty', 0);
        const cases: [string, number][] = [
            ['1 &', 3], ['| 1', 0], ['()', 1], ['(1', 2], ['1)', 1],
            ['1 2', 2], ['1(2)', 1], ['1 ~ 2', 2], ['~~', 2],
            ['1 && 2', 3], ['1 || 2', 3], ['(1 | )', 5],
            ['1 <<', 4], ['(1 2)', 3],
        ];
        for (const [expression, index] of cases) {
            expectError(expression, 32, 'invalid-expression', index);
        }
    });

    test('다른 진법·접미사·소수·음수와 잘못된 자릿수를 조용히 보정하지 않는다', () => {
        const cases: [string, number][] = [
            ['0x', 2], ['0B', 2], ['0xG1', 2], ['0b102', 4], ['0o77', 1],
            ['FF', 0], ['1e3', 1], ['1n', 1], ['0x1ULL', 3], ['0x1_0', 3],
            ['1.5', 1], ['-1', 0], ['+1', 0], ['1 + 2', 2], ['1 >>> 1', 4],
            ['1 < 2', 2], ['1 > 2', 2], ['1 / 2', 2], ['１', 0],
        ];
        for (const [expression, index] of cases) {
            expectError(expression, 32, 'invalid-token', index);
        }
    });

    test('함수 호출·프로퍼티 접근·스크립트 문자열을 실행하지 않는다', () => {
        for (const expression of [
            'process.exit()', 'globalThis.alert(1)', 'constructor.constructor("return 1")()',
            '1; throw 1', '<script>alert(1)</script>', '1/* comment */|2', '`1`',
        ]) {
            const result = evaluateHexBitwiseExpression(expression, 64);
            assert.strictEqual(result.ok, false, expression);
        }
    });

    test('문자 수 한도는 경계까지 허용하며 초과한 입력을 먼저 차단한다', () => {
        expectValue('0'.repeat(HEX_BITWISE_MAX_EXPRESSION_LENGTH), 64, 0n);
        expectError('0'.repeat(HEX_BITWISE_MAX_EXPRESSION_LENGTH + 1), 64, 'too-complex',
            HEX_BITWISE_MAX_EXPRESSION_LENGTH);
        expectError(' '.repeat(HEX_BITWISE_MAX_EXPRESSION_LENGTH + 1), 64, 'too-complex',
            HEX_BITWISE_MAX_EXPRESSION_LENGTH);
    });

    test('토큰은 256개까지 허용하고 괄호·NOT 중첩은 합산해 32개로 제한한다', () => {
        // ~ 1개, 정수 128개, | 127개로 정확히 256개다.
        expectValue('~' + Array.from({ length: 128 }, () => '0').join('|'), 8, 255n);
        expectError(Array.from({ length: 129 }, () => '0').join('|'), 8, 'too-complex', 256);
        expectValue('('.repeat(32) + '1' + ')'.repeat(32), 8, 1n);
        expectError('('.repeat(33) + '1' + ')'.repeat(33), 8, 'too-complex', 32);
        expectValue('~'.repeat(32) + '1', 8, 1n);
        expectError('~'.repeat(33) + '1', 8, 'too-complex', 32);
        expectValue('~('.repeat(16) + '1' + ')'.repeat(16), 8, 1n);
        expectError('~('.repeat(16) + '~1' + ')'.repeat(16), 8, 'too-complex', 32);
    });

    test('직렬화한 함수는 webview처럼 외부 모듈 없이 실행된다', () => {
        const isolated = vm.runInNewContext('(' + evaluateHexBitwiseExpression.toString() + ')');
        const cases: [string, number][] = [
            ['0x8000000000000001 >> 63', 64], ['~0xF & (1 << 7)', 8],
            ['0x100', 8], ['1 << 8', 8], ['0x', 8], ['(1', 8],
            ['0'.repeat(HEX_BITWISE_MAX_EXPRESSION_LENGTH + 1), 64],
        ];
        for (const [expression, width] of cases) {
            assert.deepStrictEqual(
                JSON.parse(JSON.stringify(isolated(expression, width))),
                evaluateHexBitwiseExpression(expression, width), expression
            );
        }
    });
});
