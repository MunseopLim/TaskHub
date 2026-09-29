export type DeveloperCalculatorResult =
    | { ok: true; hex: string; decimal: string; binary: string; size: string; truncated: boolean }
    | { ok: false; reason: 'empty' | 'invalid-token' | 'invalid-expression' | 'leading-zero' | 'out-of-range'
        | 'invalid-shift' | 'divide-by-zero' | 'invalid-arguments' | 'too-complex'; index: number };

/** Exact integer arithmetic. Self-contained because the webview embeds this function. */
export function evaluateDeveloperExpression(expression: string): DeveloperCalculatorResult {
    if (expression.length > 4096) { return { ok: false, reason: 'too-complex', index: 4096 }; }
    if (!expression.trim()) { return { ok: false, reason: 'empty', index: 0 }; }
    type Token = { kind: string; index: number; value?: bigint };
    const tokens: Token[] = [];
    const limit = (1n << 256n) - 1n;
    let cursor = 0;
    let truncated = false;
    class CalculationError extends Error {
        constructor(readonly reason: Exclude<DeveloperCalculatorResult, { ok: true }>['reason'], readonly index: number) {
            super(reason);
        }
    }
    function checked(value: bigint, index: number): bigint {
        if (value > limit || value < -limit) { throw new CalculationError('out-of-range', index); }
        return value;
    }
    function peek(): Token { return tokens[cursor]; }
    function requireToken(kind: string): void {
        if (peek().kind !== kind) { throw new CalculationError('invalid-expression', peek().index); }
        cursor++;
    }
    const precedence: Record<string, number> = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
    function parse(minimum: number, depth: number): bigint {
        if (depth > 32) { throw new CalculationError('too-complex', peek().index); }
        const token = tokens[cursor++];
        let value: bigint;
        if (token.kind === 'number') {
            value = token.value!;
        } else if (token.kind === '+' || token.kind === '-' || token.kind === '~') {
            const operand = parse(7, depth + 1);
            value = checked(token.kind === '-' ? -operand : token.kind === '~' ? ~operand : operand, token.index);
        } else if (token.kind === '(') {
            value = parse(0, depth + 1);
            requireToken(')');
        } else if (token.kind === 'alignUp' || token.kind === 'alignDown' || token.kind === 'rangeSize') {
            requireToken('(');
            const left = parse(0, depth + 1);
            requireToken(',');
            const right = parse(0, depth + 1);
            requireToken(')');
            if (left < 0n || (token.kind === 'rangeSize' ? right < left : right <= 0n)) {
                throw new CalculationError('invalid-arguments', token.index);
            }
            value = checked(token.kind === 'rangeSize' ? right - left + 1n
                : token.kind === 'alignDown' ? left / right * right
                    : (left / right + (left % right === 0n ? 0n : 1n)) * right, token.index);
        } else {
            throw new CalculationError('invalid-expression', token.index);
        }
        while (Object.prototype.hasOwnProperty.call(precedence, peek().kind) && precedence[peek().kind] >= minimum) {
            const operator = tokens[cursor++];
            const rightIndex = peek().index;
            const right = parse(precedence[operator.kind] + 1, depth + 1);
            switch (operator.kind) {
                case '+': value += right; break;
                case '-': value -= right; break;
                case '*': value *= right; break;
                case '/':
                case '%':
                    if (right === 0n) { throw new CalculationError('divide-by-zero', rightIndex); }
                    if (operator.kind === '/') { truncated ||= value % right !== 0n; value /= right; }
                    else { value %= right; }
                    break;
                case '<<':
                case '>>':
                    if (right < 0n || right > 255n) { throw new CalculationError('invalid-shift', rightIndex); }
                    value = operator.kind === '<<' ? value << right : value >> right;
                    break;
                case '&': value &= right; break;
                case '^': value ^= right; break;
                case '|': value |= right; break;
            }
            checked(value, operator.index);
        }
        return value;
    }
    try {
        for (let index = 0; index < expression.length;) {
            if (/\s/.test(expression[index])) { index++; continue; }
            if (tokens.length >= 256) { throw new CalculationError('too-complex', index); }
            const start = index;
            const character = expression[index];
            if (/[0-9]/.test(character)) {
                while (index < expression.length && /[A-Za-z0-9_']/.test(expression[index])) { index++; }
                let literal = expression.slice(start, index);
                const unit = literal.match(/(KiB|MiB|GiB)$/)?.[0];
                if (unit) { literal = literal.slice(0, -unit.length); }
                // Walk the trailing suffix once: an unanchored regex would retry at each character.
                let suffixStart = literal.length;
                while (suffixStart > 0 && 'uUlL'.includes(literal[suffixStart - 1])) { suffixStart--; }
                const suffix = literal.slice(suffixStart);
                if (suffix) {
                    if (unit || !/^(?:[uU](?:[lL]|ll|LL)?|(?:[lL]|ll|LL)[uU]?)$/.test(suffix)) {
                        throw new CalculationError('invalid-token', start);
                    }
                    literal = literal.slice(0, -suffix.length);
                }
                if (!/^(?:0[xX][\da-fA-F](?:['_]?[\da-fA-F])*|0[bB][01](?:['_]?[01])*|\d(?:['_]?\d)*)$/.test(literal)) {
                    throw new CalculationError('invalid-token', start);
                }
                const normalized = literal.replace(/['_]/g, '');
                if (/^0\d/.test(normalized)) { throw new CalculationError('leading-zero', start); }
                const multiplier = unit === 'KiB' ? 1024n : unit === 'MiB' ? 1048576n : unit === 'GiB' ? 1073741824n : 1n;
                tokens.push({ kind: 'number', value: checked(BigInt(normalized) * multiplier, start), index: start });
                continue;
            }
            if (/[A-Za-z_]/.test(character)) {
                while (index < expression.length && /[A-Za-z0-9_]/.test(expression[index])) { index++; }
                const name = expression.slice(start, index);
                if (!['alignUp', 'alignDown', 'rangeSize'].includes(name)) { throw new CalculationError('invalid-token', start); }
                tokens.push({ kind: name, index: start });
                continue;
            }
            const pair = expression.slice(index, index + 2);
            if (pair === '<<' || pair === '>>') { tokens.push({ kind: pair, index }); index += 2; continue; }
            if ('+-*/%&|^~(),'.includes(character)) { tokens.push({ kind: character, index }); index++; continue; }
            throw new CalculationError('invalid-token', index);
        }
        tokens.push({ kind: 'end', index: expression.length });
        const value = parse(0, 0);
        if (peek().kind !== 'end') { throw new CalculationError('invalid-expression', peek().index); }
        const magnitude = value < 0n ? -value : value;
        const sign = value < 0n ? '-' : '';
        const power = magnitude >= 1073741824n ? 30 : magnitude >= 1048576n ? 20 : magnitude >= 1024n ? 10 : 0;
        const divisor = 1n << BigInt(power);
        const fraction = ((magnitude % divisor) * (5n ** BigInt(power))).toString().padStart(power, '0').replace(/0+$/, '');
        const size = sign + (magnitude / divisor).toString() + (fraction ? '.' + fraction : '')
            + ' ' + (power === 30 ? 'GiB' : power === 20 ? 'MiB' : power === 10 ? 'KiB' : 'B');
        return { ok: true, hex: sign + '0x' + magnitude.toString(16).toUpperCase(), decimal: value.toString(),
            binary: sign + '0b' + magnitude.toString(2), size, truncated };
    } catch (error) {
        if (error instanceof CalculationError) { return { ok: false, reason: error.reason, index: error.index }; }
        throw error;
    }
}
