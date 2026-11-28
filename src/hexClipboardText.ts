/**
 * 클립보드 텍스트를 바이트로 읽는다. Hex Viewer의 "클립보드에서 Hex 열기"가 쓴다.
 *
 * 사용자가 실제로 복사해 오는 텍스트는 순수 Hex가 아니라 주소 열과 ASCII 열이 붙은
 * dump인 경우가 많다. ASCII 열을 무시하지 않고 그대로 토큰으로 읽으면 `cafe` 같은
 * 글자가 Hex 숫자로 섞여 조용히 다른 바이트가 되므로, 형식을 먼저 알아본 뒤 각 형식의
 * 구조로 Hex 영역만 잘라 낸다.
 *
 * 여러 바이트를 묶은 토큰(`20000008`)은 적힌 순서인지 Little Endian 값인지 텍스트만으로
 * 알 수 없다. 이 모듈은 적힌 순서와 토큰 크기만 돌려주고, 해석은 호출부가 사용자에게 묻는다.
 * vscode API에 의존하지 않는 순수 모듈이라 단위 테스트에서 바로 검사한다.
 */

export type HexClipboardFormat = 'hex' | 'xxd' | 'hexdump' | 'memory' | 'cArray';

export type HexClipboardErrorReason = 'empty' | 'invalid-character' | 'odd-digits' | 'missing-byte' | 'too-large';

export type HexClipboardParseResult =
    | {
        ok: true;
        format: HexClipboardFormat;
        /** 텍스트에 적힌 순서 그대로의 바이트. */
        bytes: Uint8Array;
        /** 토큰별 바이트 수. 합은 `bytes.length`와 같다. */
        tokenSizes: number[];
        /**
         * 바이트 순서를 사용자가 고를 필요가 없는지. xxd·hexdump처럼 형식이 바이트 순서를
         * 정하거나, 모든 토큰이 1바이트이거나, 값으로 볼 수 없는 긴 토큰이 있으면 true다.
         */
        orderFixed: boolean;
    }
    | { ok: false; reason: HexClipboardErrorReason; line?: number; column?: number };

/** 한 토큰을 값으로 볼 수 있는 최대 크기. Hex Viewer 표시 단위의 최댓값과 같다. */
const MAX_VALUE_TOKEN_BYTES = 8;

const XXD_LINE = /^\s*[0-9a-f]{4,16}:(?: [0-9a-f]{2,})+/i;
const HEXDUMP_ASCII = / {2}\|[^\n]*\|\s*$/;
const COLON_ADDRESS = /^\s*(?:0x[0-9a-f]+|[0-9a-f]{4,})(?:\s*<[^>\n]*>)?:/i;

/** 문자열 위치를 1부터 세는 줄·글자 번호로 바꾼다. */
function positionAt(text: string, index: number): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < index; i++) {
        if (text[i] === '\n') {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, column: index - lineStart + 1 };
}

/** 위치를 유지하도록 지울 구간을 같은 길이의 공백(줄바꿈은 유지)으로 바꾼다. */
function blank(text: string, start: number, end: number): string {
    return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

/** C 주석을 지우고, 중괄호가 있으면 첫 `{`와 마지막 `}` 사이만 남긴다. */
function stripCSyntax(text: string): { text: string; cArray: boolean } {
    let result = text;
    for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
        result = blank(result, match.index, match.index + match[0].length);
    }
    const open = result.indexOf('{');
    const close = result.lastIndexOf('}');
    if (open < 0 || close <= open) { return { text: result, cArray: false }; }
    result = blank(result, close, result.length);
    result = blank(result, 0, open + 1);
    return { text: result, cArray: true };
}

export function parseHexClipboardText(input: string, maxBytes: number): HexClipboardParseResult {
    // dump 형식은 바이트당 4~5글자를 쓴다. 바이트로 환산하기 전에도 입력 길이를 제한한다.
    if (input.length > maxBytes * 8) { return { ok: false, reason: 'too-large' }; }
    const normalized = input.replace(/\r\n?/g, '\n');
    const { text, cArray } = stripCSyntax(normalized);
    const lines = text.split('\n');

    // 한 줄이라도 형식의 표지가 있으면 텍스트 전체를 그 형식으로 읽는다. hexdump -C의
    // 마지막 줄은 주소만 있어 줄마다 따로 판단하면 그 주소를 데이터로 읽게 된다.
    let format: HexClipboardFormat = cArray ? 'cArray' : 'hex';
    if (!cArray) {
        if (lines.some(line => HEXDUMP_ASCII.test(line))) {
            format = 'hexdump';
        } else if (lines.some(line => XXD_LINE.test(line) && / {2}\S/.test(line.replace(XXD_LINE, '')))) {
            format = 'xxd';
        } else if (lines.some(line => COLON_ADDRESS.test(line))) {
            format = 'memory';
        }
    }

    const tokenSizes: number[] = [];
    const digits: string[] = [];
    let digitCount = 0;
    let lineStart = 0;
    for (const line of lines) {
        let start = 0;
        let end = line.length;
        if (format === 'hexdump') {
            const ascii = HEXDUMP_ASCII.exec(line);
            if (ascii) { end = ascii.index; }
            // 줄 첫 토큰은 주소다. 마지막 줄처럼 주소만 있는 줄은 건너뛴다.
            const address = /^\s*[0-9a-f]+/i.exec(line);
            if (address) { start = address[0].length; }
        } else if (format === 'xxd' || format === 'memory') {
            const address = COLON_ADDRESS.exec(line);
            if (address) {
                start = address[0].length;
                // 주소가 붙은 줄의 ASCII 열은 두 칸 이상의 공백 뒤에 온다. xxd는 구조가
                // 정해져 있어 항상 자른다. 다른 메모리 창은 열을 두 칸으로 띄우기도 하므로,
                // 그 뒤에 Hex로 읽을 수 없는 글자가 있을 때만 ASCII 열로 보고 자른다.
                // gdb처럼 탭으로 값을 나누는 형식은 영향받지 않는다.
                const rest = line.slice(start);
                const firstValue = rest.search(/\S/);
                if (firstValue >= 0) {
                    const gap = rest.slice(firstValue).search(/ {2,}/);
                    const gapAt = start + firstValue + gap;
                    if (gap >= 0 && (format === 'xxd' || /[^0-9a-fx\s,;]/i.test(line.slice(gapAt)))) {
                        end = gapAt;
                    }
                }
            }
        }

        const area = line.slice(start, end);
        let index = 0;
        while (index < area.length) {
            const ch = area[index];
            if (/[\s,;]/.test(ch) || (format !== 'hexdump' && /[\-_:]/.test(ch))) {
                index++;
                continue;
            }
            const tokenStart = index;
            const prefixed = ch === '0' && (area[index + 1] === 'x' || area[index + 1] === 'X');
            if (prefixed) { index += 2; }
            const digitsStart = index;
            while (index < area.length && /[0-9a-f]/i.test(area[index])) { index++; }
            let token = area.slice(digitsStart, index);
            // C 정수 접미사(`0x08u`, `0xFFUL`)는 0x로 시작한 값에만 허용한다.
            if (prefixed) {
                while (index < area.length && /[ul]/i.test(area[index])) { index++; }
            }
            const next = area[index];
            const errorAt = (reason: HexClipboardErrorReason, at: number): HexClipboardParseResult => ({
                ok: false, reason, ...positionAt(normalized, lineStart + start + at),
            });
            if (next !== undefined && !/[\s,;]/.test(next) && !(format !== 'hexdump' && /[\-_:]/.test(next))) {
                return errorAt('invalid-character', index);
            }
            if (token.length === 0) {
                return errorAt(prefixed ? 'missing-byte' : 'invalid-character', tokenStart);
            }
            if (token.length % 2 !== 0) {
                if (!prefixed) { return errorAt('odd-digits', tokenStart); }
                token = `0${token}`;
            }
            digitCount += token.length;
            if (digitCount > maxBytes * 2) { return { ok: false, reason: 'too-large' }; }
            digits.push(token);
            tokenSizes.push(token.length / 2);
        }
        lineStart += line.length + 1;
    }

    if (digitCount === 0) { return { ok: false, reason: 'empty' }; }
    const bytes = new Uint8Array(digitCount / 2);
    let offset = 0;
    for (const token of digits) {
        for (let i = 0; i < token.length; i += 2) {
            bytes[offset++] = Number.parseInt(token.slice(i, i + 2), 16);
        }
    }
    const orderFixed = format === 'xxd' || format === 'hexdump'
        || tokenSizes.every(size => size === 1)
        || tokenSizes.some(size => size > MAX_VALUE_TOKEN_BYTES);
    return { ok: true, format, bytes, tokenSizes, orderFixed };
}

/** 각 토큰을 Little Endian 값으로 보고 토큰 안의 바이트 순서를 뒤집는다. */
export function toLittleEndianTokens(bytes: Uint8Array, tokenSizes: readonly number[]): Uint8Array {
    const result = new Uint8Array(bytes.length);
    let offset = 0;
    for (const size of tokenSizes) {
        for (let i = 0; i < size; i++) {
            result[offset + i] = bytes[offset + size - 1 - i];
        }
        offset += size;
    }
    return result;
}

/**
 * 붙여넣은 글자와 같은 모양으로 보이는 표시 단위. 모든 토큰이 같은 크기(마지막 토큰만
 * 짧을 수 있다)이고 Hex Viewer 단위(2·4·8)면 그 크기, 아니면 1이다.
 */
export function uniformTokenUnit(tokenSizes: readonly number[]): 1 | 2 | 4 | 8 {
    const first = tokenSizes[0];
    if (first !== 2 && first !== 4 && first !== 8) { return 1; }
    const lastIndex = tokenSizes.length - 1;
    const uniform = tokenSizes.every((size, index) => size === first || (index === lastIndex && size < first));
    return uniform ? first : 1;
}
