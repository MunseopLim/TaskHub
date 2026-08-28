export const HEX_CONVERTER_MAX_BYTES = 1024 * 1024;

export type HexConverterEncoding = 'utf8' | 'ascii';
export type HexConverterEndian = 'little' | 'big';
export type HexConverterGroupBytes = 1 | 2 | 4;
export type HexConverterBytesPerRow = 0 | 8 | 16 | 32;

export type HexInputResult =
    | { ok: true; bytes: Uint8Array }
    | { ok: false; reason: 'invalid-character' | 'missing-byte' | 'odd-digits' | 'too-large'; index?: number };

export type TextEncodeResult =
    | { ok: true; bytes: Uint8Array }
    | { ok: false; reason: 'non-ascii-character' | 'too-large'; index?: number };

export type TextDecodeResult =
    | { ok: true; text: string }
    | { ok: false; reason: 'non-ascii-byte' | 'invalid-utf8'; index?: number };

export interface HexValueRow {
    key: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'float32' | 'float64';
    value: string;
}

/**
 * `41 42`, `4142`, `0x41, 0x42` 형식을 같은 byte stream으로 읽는다.
 * `0x`는 token 시작에서만 허용해 `10x2` 같은 오타를 조용히 고치지 않는다.
 */
export function parseHexConverterInput(input: string, maxBytes: number): HexInputResult {
    let digits = '';
    let tokenStart = true;
    let prefixNeedsDigit = false;

    for (let index = 0; index < input.length; index++) {
        const ch = input[index];
        if (/\s|[,\-_:]/.test(ch)) {
            if (prefixNeedsDigit) {
                return { ok: false, reason: 'missing-byte', index };
            }
            tokenStart = true;
            continue;
        }
        if (tokenStart && ch === '0' && (input[index + 1] === 'x' || input[index + 1] === 'X')) {
            prefixNeedsDigit = true;
            tokenStart = false;
            index++;
            continue;
        }
        if (!/[0-9a-fA-F]/.test(ch)) {
            return { ok: false, reason: 'invalid-character', index };
        }
        digits += ch;
        prefixNeedsDigit = false;
        tokenStart = false;
        if (digits.length > maxBytes * 2) {
            return { ok: false, reason: 'too-large' };
        }
    }

    if (prefixNeedsDigit) {
        return { ok: false, reason: 'missing-byte', index: input.length };
    }
    if (digits.length % 2 !== 0) {
        return { ok: false, reason: 'odd-digits' };
    }

    const bytes = new Uint8Array(digits.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    }
    return { ok: true, bytes };
}

export function formatHexConverterBytes(
    bytes: Uint8Array,
    groupBytes: HexConverterGroupBytes = 1,
    bytesPerRow: HexConverterBytesPerRow = 0
): string {
    const size = groupBytes === 2 || groupBytes === 4 ? groupBytes : 1;
    const rowSize = bytesPerRow === 8 || bytesPerRow === 16 || bytesPerRow === 32 ? bytesPerRow : 0;
    let output = '';
    for (let offset = 0; offset < bytes.length; offset += size) {
        if (offset > 0) {
            output += rowSize > 0 && offset % rowSize === 0 ? '\n' : ' ';
        }
        let group = '';
        const end = Math.min(offset + size, bytes.length);
        for (let index = offset; index < end; index++) {
            group += bytes[index].toString(16).padStart(2, '0').toUpperCase();
        }
        output += group;
    }
    return output;
}

export function encodeHexConverterText(
    text: string,
    encoding: HexConverterEncoding,
    maxBytes: number
): TextEncodeResult {
    if (encoding === 'ascii') {
        const bytes: number[] = [];
        let utf16Index = 0;
        for (const character of text) {
            const codePoint = character.codePointAt(0)!;
            if (codePoint > 0x7f) {
                return { ok: false, reason: 'non-ascii-character', index: utf16Index };
            }
            bytes.push(codePoint);
            if (bytes.length > maxBytes) {
                return { ok: false, reason: 'too-large' };
            }
            utf16Index += character.length;
        }
        return { ok: true, bytes: Uint8Array.from(bytes) };
    }

    const bytes = new TextEncoder().encode(text);
    if (bytes.length > maxBytes) {
        return { ok: false, reason: 'too-large' };
    }
    return { ok: true, bytes };
}

export function decodeHexConverterBytes(bytes: Uint8Array, encoding: HexConverterEncoding): TextDecodeResult {
    if (encoding === 'ascii') {
        const invalidAt = bytes.findIndex(byte => byte > 0x7f);
        if (invalidAt >= 0) {
            return { ok: false, reason: 'non-ascii-byte', index: invalidAt };
        }
        // spread로 1MB 배열을 함수 인자에 펼치면 엔진의 인자 개수 한도를
        // 넘는다. 검증을 마친 ASCII는 UTF-8과 동일하므로 decoder로 읽는다.
        return { ok: true, text: new TextDecoder('utf-8').decode(bytes) };
    }

    try {
        return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
        return { ok: false, reason: 'invalid-utf8' };
    }
}

/** 첫 8바이트를 정수와 IEEE-754 부동소수점으로 해석한다. */
export function buildHexConverterValueRows(bytes: Uint8Array, endian: HexConverterEndian): HexValueRow[] {
    if (bytes.length === 0) { return []; }
    const source = bytes.slice(0, 8);
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const littleEndian = endian === 'little';
    const rows: HexValueRow[] = [
        { key: 'u8', value: String(view.getUint8(0)) },
        { key: 'i8', value: String(view.getInt8(0)) },
    ];

    if (source.length >= 2) {
        rows.push(
            { key: 'u16', value: String(view.getUint16(0, littleEndian)) },
            { key: 'i16', value: String(view.getInt16(0, littleEndian)) },
        );
    }
    if (source.length >= 4) {
        const float32 = view.getFloat32(0, littleEndian);
        rows.push(
            { key: 'u32', value: String(view.getUint32(0, littleEndian)) },
            { key: 'i32', value: String(view.getInt32(0, littleEndian)) },
            // IEEE-754 binary32 값을 다시 같은 bit pattern으로 읽을 수 있는
            // 9자리까지 보인다. 8자리면 인접한 두 값이 같게 표시될 수 있다.
            { key: 'float32', value: Number.isFinite(float32) ? float32.toPrecision(9) : String(float32) },
        );
    }
    if (source.length >= 8) {
        const float64 = view.getFloat64(0, littleEndian);
        rows.push(
            { key: 'u64', value: view.getBigUint64(0, littleEndian).toString() },
            { key: 'i64', value: view.getBigInt64(0, littleEndian).toString() },
            // binary64의 왕복 안전 유효숫자는 17자리다. 값 검사기에서 서로
            // 다른 bit pattern을 같은 숫자로 보이는 것보다 정확성을 우선한다.
            { key: 'float64', value: Number.isFinite(float64) ? float64.toPrecision(17) : String(float64) },
        );
    }
    return rows;
}
