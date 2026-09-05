export const HEX_BITWISE_MAX_EXPRESSION_LENGTH = 4096;

export type HexBitwiseErrorReason =
    | 'empty'
    | 'invalid-width'
    | 'invalid-token'
    | 'invalid-expression'
    | 'out-of-range'
    | 'invalid-shift'
    | 'too-complex';

export type HexBitwiseResult =
    | { ok: true; hex: string; decimal: string; binary: string }
    | { ok: false; reason: HexBitwiseErrorReason; index: number };

/**
 * 선택한 폭의 unsigned 정수 수식을 계산한다. 모든 중간 결과도 같은 폭을 유지한다.
 * webview에 toString()으로 주입하므로 런타임 의존성은 이 함수 내부에만 둔다.
 * 오류 index는 0부터 시작하며, shift 오류는 횟수 식의 시작을 가리킨다.
 */
export function evaluateHexBitwiseExpression(expression: string, width: number): HexBitwiseResult {
    // 외부 상수를 참조하면 직렬화한 함수에서 사용할 수 없다.
    const maxExpressionLength = 4096;
    const maxTokens = 256;
    const maxNesting = 32;
    if (width !== 8 && width !== 16 && width !== 32 && width !== 64) {
        return { ok: false, reason: 'invalid-width', index: 0 };
    }
    if (expression.length > maxExpressionLength) {
        return { ok: false, reason: 'too-complex', index: maxExpressionLength };
    }
    if (expression.trim().length === 0) {
        return { ok: false, reason: 'empty', index: 0 };
    }

    type Operator = '&' | '|' | '^' | '~' | '<<' | '>>' | '(' | ')';
    type Token =
        | { kind: 'number'; value: bigint; index: number }
        | { kind: Operator | 'end'; index: number };

    class ParseError extends Error {
        constructor(readonly reason: HexBitwiseErrorReason, readonly index: number) {
            super(reason);
        }
    }

    const bitWidth = BigInt(width);
    const mask = (1n << bitWidth) - 1n;
    const tokens: Token[] = [];
    let cursor = 0;

    function peek(): Token {
        return tokens[cursor];
    }

    function parseUnary(nesting: number): bigint {
        const token = peek();
        if (token.kind === '~' || token.kind === '(') {
            if (nesting >= maxNesting) {
                throw new ParseError('too-complex', token.index);
            }
            cursor++;
            if (token.kind === '~') {
                return ~parseUnary(nesting + 1) & mask;
            }
            const value = parseOr(nesting + 1);
            if (peek().kind !== ')') {
                throw new ParseError('invalid-expression', peek().index);
            }
            cursor++;
            return value;
        }
        if (token.kind !== 'number') {
            throw new ParseError('invalid-expression', token.index);
        }
        cursor++;
        return token.value;
    }

    function parseShift(nesting: number): bigint {
        let value = parseUnary(nesting);
        while (peek().kind === '<<' || peek().kind === '>>') {
            const operator = peek().kind;
            cursor++;
            const shiftIndex = peek().index;
            const shift = parseUnary(nesting);
            if (shift >= bitWidth) {
                throw new ParseError('invalid-shift', shiftIndex);
            }
            // value는 항상 비음수이므로 >>가 0으로 채우는 logical shift가 된다.
            value = (operator === '<<' ? value << shift : value >> shift) & mask;
        }
        return value;
    }

    function parseAnd(nesting: number): bigint {
        let value = parseShift(nesting);
        while (peek().kind === '&') {
            cursor++;
            value = (value & parseShift(nesting)) & mask;
        }
        return value;
    }

    function parseXor(nesting: number): bigint {
        let value = parseAnd(nesting);
        while (peek().kind === '^') {
            cursor++;
            value = (value ^ parseAnd(nesting)) & mask;
        }
        return value;
    }

    function parseOr(nesting: number): bigint {
        let value = parseXor(nesting);
        while (peek().kind === '|') {
            cursor++;
            value = (value | parseXor(nesting)) & mask;
        }
        return value;
    }

    try {
        for (let index = 0; index < expression.length;) {
            const character = expression[index];
            if (/\s/.test(character)) {
                index++;
                continue;
            }
            if (tokens.length >= maxTokens) {
                throw new ParseError('too-complex', index);
            }
            const start = index;
            if (/[0-9]/.test(character)) {
                // 숫자에 붙은 잘못된 접두사·접미사도 별도 정수로 분리하지 않는다.
                while (index < expression.length && /[A-Za-z0-9_]/.test(expression[index])) {
                    index++;
                }
                const literal = expression.slice(start, index);
                const prefixLength = /^0[xXbB]/.test(literal) ? 2 : 0;
                const digitPattern = /^0[xX]/.test(literal) ? /[0-9a-fA-F]/
                    : /^0[bB]/.test(literal) ? /[01]/ : /[0-9]/;
                if (literal.length === prefixLength) {
                    throw new ParseError('invalid-token', start + prefixLength);
                }
                for (let digit = prefixLength; digit < literal.length; digit++) {
                    if (!digitPattern.test(literal[digit])) {
                        throw new ParseError('invalid-token', start + digit);
                    }
                }
                const value = BigInt(literal);
                if (value > mask) {
                    throw new ParseError('out-of-range', start);
                }
                tokens.push({ kind: 'number', value, index: start });
                continue;
            }
            if ((character === '<' || character === '>') && expression[index + 1] === character) {
                tokens.push({ kind: character === '<' ? '<<' : '>>', index });
                index += 2;
                continue;
            }
            if (character === '&' || character === '|' || character === '^' || character === '~'
                || character === '(' || character === ')') {
                tokens.push({ kind: character, index });
                index++;
                continue;
            }
            throw new ParseError('invalid-token', index);
        }
        tokens.push({ kind: 'end', index: expression.length });
        const value = parseOr(0);
        if (peek().kind !== 'end') {
            throw new ParseError('invalid-expression', peek().index);
        }
        return {
            ok: true,
            hex: '0x' + value.toString(16).toUpperCase().padStart(width / 4, '0'),
            decimal: value.toString(10),
            binary: '0b' + value.toString(2).padStart(width, '0'),
        };
    } catch (error) {
        if (error instanceof ParseError) {
            return { ok: false, reason: error.reason, index: error.index };
        }
        throw error;
    }
}
