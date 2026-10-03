import { HexByteStore } from './hexByteStore';

/**
 * Hex file parser supporting Intel HEX, Motorola SREC, and raw binary formats.
 */

export type HexFormat = 'intel' | 'srec' | 'binary';

/** HEX/SREC의 고유 바이트 수 상한. Binary는 rawBuffer와 파일 크기 제한을 쓴다. */
export const HEX_MAX_BYTE_ENTRIES = 32 * 1024 * 1024;
/** Maximum bytes per single record (Intel HEX data field is 1 byte → 255; SREC is 253). Guards malformed input. */
const HEX_MAX_RECORD_BYTES = 255;

export interface HexParseResult {
    format: HexFormat;
    /** Sparse memory data: address → byte value (HEX/SREC use compact pages) */
    data: ReadonlyMap<number, number> | HexByteStore;
    /** Raw buffer for binary format (avoids Map overhead for large files) */
    rawBuffer?: Uint8Array;
    /** Entry point address (if available) */
    entryPoint?: number;
    /** Minimum address in the data */
    minAddress: number;
    /** Maximum address in the data (inclusive) */
    maxAddress: number;
    /** Total byte count */
    byteCount: number;
    /** Invalid HEX/SREC records omitted from the displayed data. */
    invalidRecordCount?: number;
    /** Valid Intel HEX data records omitted after an invalid address extension. */
    unaddressedRecordCount?: number;
}

/** 앞에서 훑어볼 줄 수. 앞줄만 깨진 파일을 살리되 바이너리에는 기회를 많이 주지 않는다. */
const HEX_DETECT_LINES = 5;
/** 판정에 읽을 앞부분 길이. 50MB 를 통째로 `split` 하지 않기 위한 것이다. */
const HEX_DETECT_WINDOW = 4096;

/**
 * 이 줄이 **완전한 레코드**이고 체크섬까지 맞는가.
 *
 * 포맷 감지와 실제 파서가 함께 호출해 자릿수·레코드 길이·체크섬을 검증한다.
 *
 * 자릿수 검사가 따로 있는 이유: `parseInt('0Z', 16)` 은 `0` 을 돌려주며 **성공한다.**
 * 길이와 범위만 봐서는 16진수가 아닌 바이트가 섞인 파일이 그대로 통과한다.
 */
function recordIsValid(line: string, kind: 'intel' | 'srec'): boolean {
    const start = kind === 'intel' ? 1 : 2;
    if (kind === 'intel' ? !line.startsWith(':') : !/^S[0-9]/.test(line)) { return false; }
    const countText = line.slice(start, start + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(countText)) { return false; }
    const count = parseInt(countText, 16);
    const expectedLength = (kind === 'intel' ? 11 : 4) + count * 2;
    if (line.length < expectedLength) { return false; }
    // 기존에 허용한 공백 뒤 세미콜론 주석은 레코드 검증에서 제외한다.
    const suffix = line.slice(expectedLength);
    if (suffix && !/^\s+;/.test(suffix)) { return false; }
    const fields = line.slice(start, expectedLength);
    if (!/^[0-9a-fA-F]+$/.test(fields) || fields.length % 2 !== 0) { return false; }
    if (kind === 'intel') {
        const type = parseInt(line.slice(7, 9), 16);
        const required = [undefined, 0, 2, 4, 2, 4];
        if (type > 5 || (type !== 0 && (count !== required[type] || line.slice(3, 7) !== '0000'))) {
            return false;
        }
    } else {
        const type = Number(line[1]);
        const addressBytes = [2, 2, 3, 4, 0, 2, 3, 4, 3, 2][type];
        if (!addressBytes || count < addressBytes + 1) { return false; }
        if (type >= 5 && count !== addressBytes + 1) { return false; }
    }
    let sum = 0;
    for (let i = start; i < expectedLength; i += 2) {
        sum += hexByte(line, i);
    }
    return (sum & 0xFF) === (kind === 'intel' ? 0 : 0xFF);
}

/** 검증을 통과한 두 자리 16진수. parseInt용 임시 문자열을 바이트마다 만들지 않는다. */
function hexByte(line: string, offset: number): number {
    const high = line.charCodeAt(offset);
    const low = line.charCodeAt(offset + 1);
    return (high <= 57 ? high - 48 : (high | 32) - 87) * 16
        + (low <= 57 ? low - 48 : (low | 32) - 87);
}

/** 전체 줄 배열을 만들지 않는다. 레코드 한 줄만 임시 문자열로 유지한다. */
function* recordLines(content: string): IterableIterator<string> {
    let start = 0;
    while (start < content.length) {
        const newline = content.indexOf('\n', start);
        if (newline < 0) { yield content.slice(start); return; }
        yield content.slice(start, newline);
        start = newline + 1;
    }
}

function isHexCommentOrBlank(line: string): boolean {
    return !line || /^(?:;|#|\/\/)/.test(line);
}

/**
 * 앞 몇 줄 안에 **완전히 유효한 레코드가 하나라도** 있는가.
 *
 * 접두사 한 글자로 포맷을 정하면 바이너리가 텍스트로 넘어간다 — 실제로 바이트
 * `3A 00 FF` 로 시작하는 파일이 Intel HEX 로, `53 30` 으로 시작하는 파일이 SREC 로
 * 판정됐다(`:` 은 0x3A, `S0` 은 0x53 0x30). 그렇게 넘어가면 파서가 레코드를 하나도
 * 못 읽어 **빈 뷰어**가 뜨고, 사용자는 파일이 비었다고 오해한다.
 *
 * **첫 줄 하나만 보지 않는 이유.** 파서(`parseIntelHex`)는 깨진 레코드를 건너뛰고
 * 나머지를 읽으므로, 첫 줄만 상한 HEX 파일도 지금까지 정상으로 열렸다. 첫 줄로만
 * 판정하면 그런 파일이 갑자기 바이너리로 보인다. 반대로 줄 수를 늘려도 바이너리가
 * 통과할 위험은 거의 늘지 않는다 — 레코드 하나가 통과하려면 그 구간이 **전부
 * ASCII 16진수**이면서 체크섬까지 맞아야 하기 때문이다.
 */
function hasValidRecordNearStart(text: string, kind: 'intel' | 'srec'): boolean {
    const marker = kind === 'intel' ? ':' : 'S';
    const lines = text.slice(0, HEX_DETECT_WINDOW).split(/\r?\n/);
    let seen = 0;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith(marker)) { continue; }
        if (recordIsValid(line, kind)) { return true; }
        if (++seen >= HEX_DETECT_LINES) { return false; }
    }
    return false;
}

/**
 * Detect file format from content.
 *
 * 접두사만 보지 않고 **유효한 레코드를 실제로 하나 찾았을 때만** 텍스트 포맷으로 넘긴다.
 * 확장자로 이미 정해지는 경우는 호출부(`hexViewer.parseFile`)가 먼저 거른다.
 */
export function detectFormat(content: string | Buffer): HexFormat {
    if (Buffer.isBuffer(content)) {
        return 'binary';
    }
    const trimmed = content.trimStart();
    if (trimmed.startsWith(':')) {
        return hasValidRecordNearStart(trimmed, 'intel') ? 'intel' : 'binary';
    }
    if (/^S[0-9]/.test(trimmed)) {
        return hasValidRecordNearStart(trimmed, 'srec') ? 'srec' : 'binary';
    }
    return 'binary';
}

/**
 * Parse Intel HEX format (https://en.wikipedia.org/wiki/Intel_HEX).
 */
export function parseIntelHex(content: string): HexParseResult {
    const data = new HexByteStore();
    let baseAddress: number | undefined = 0;
    // Extended Segment(02) 주소 공간에서는 레코드 안의 오프셋이 64K에서 감긴다
    // (SBA*16 + ((DRLO + DRI) mod 64K)). Extended Linear(04)는 감기지 않는다.
    let segmentAddressing = false;
    let entryPoint: number | undefined;
    let minAddress = Infinity;
    let maxAddress = -Infinity;
    let invalidRecordCount = 0;
    let unaddressedRecordCount = 0;

    for (const rawLine of recordLines(content)) {
        const line = rawLine.trim();
        if (isHexCommentOrBlank(line)) { continue; }
        if (!recordIsValid(line, 'intel')) {
            invalidRecordCount++;
            // 손상된 주소 확장을 무시한 채 이전 기준점을 계속 쓰면 이후의 정상
            // 데이터도 잘못된 주소에 놓인다. 다음 정상 확장까지 주소를 확정하지 않는다.
            if (line.startsWith(':') && /^(?:02|04)$/.test(line.slice(7, 9))) {
                baseAddress = undefined;
            }
            continue;
        }
        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);

        switch (recordType) {
            case 0x00: { // Data record
                if (baseAddress === undefined) {
                    unaddressedRecordCount++;
                    break;
                }
                for (let i = 0; i < byteCount; i++) {
                    const byte = hexByte(line, 9 + i * 2);
                    if (!Number.isFinite(byte)) { continue; }
                    const addr = baseAddress + (segmentAddressing ? (address + i) & 0xFFFF : address + i);
                    data.set(addr, byte);
                    if (addr < minAddress) { minAddress = addr; }
                    if (addr > maxAddress) { maxAddress = addr; }
                    if (data.size > HEX_MAX_BYTE_ENTRIES) {
                        throw new Error(
                            `Intel HEX payload exceeds ${HEX_MAX_BYTE_ENTRIES} byte entries; refusing to load.`
                        );
                    }
                }
                break;
            }
            case 0x01: // EOF
                break;
            case 0x02: // Extended Segment Address
                baseAddress = parseInt(line.substring(9, 13), 16) << 4;
                segmentAddressing = true;
                break;
            case 0x03: // Start Segment Address
                entryPoint = (parseInt(line.substring(9, 13), 16) << 4) +
                    parseInt(line.substring(13, 17), 16);
                break;
            case 0x04: // Extended Linear Address
                // `<< 16`은 32비트 부호 있는 결과라 ELA ≥ 0x8000(0x80000000 이상
                // 주소 — STM32 QSPI 0x90000000, PIC32 kseg 등)이 음수가 된다.
                // 곱셈은 부호 없는 53비트 정수 범위에서 안전.
                baseAddress = parseInt(line.substring(9, 13), 16) * 0x10000;
                segmentAddressing = false;
                break;
            case 0x05: // Start Linear Address
                entryPoint = parseInt(line.substring(9, 17), 16);
                break;
        }
    }

    if (minAddress === Infinity) { minAddress = 0; maxAddress = 0; }

    return { format: 'intel', data, entryPoint, minAddress, maxAddress, byteCount: data.size, invalidRecordCount, unaddressedRecordCount };
}

/**
 * Parse Motorola SREC format (https://en.wikipedia.org/wiki/SREC_(file_format)).
 */
export function parseSrec(content: string): HexParseResult {
    const data = new HexByteStore();
    let entryPoint: number | undefined;
    let minAddress = Infinity;
    let maxAddress = -Infinity;
    let invalidRecordCount = 0;

    for (const rawLine of recordLines(content)) {
        const line = rawLine.trim();
        if (isHexCommentOrBlank(line)) { continue; }
        if (!recordIsValid(line, 'srec')) { invalidRecordCount++; continue; }
        const type = Number(line[1]);
        const byteCount = parseInt(line.substring(2, 4), 16);

        let addressBytes: number;
        switch (type) {
            case 0: continue; // Header
            case 1: addressBytes = 2; break; // Data (16-bit address)
            case 2: addressBytes = 3; break; // Data (24-bit address)
            case 3: addressBytes = 4; break; // Data (32-bit address)
            case 7: // Start address (32-bit)
                entryPoint = parseInt(line.substring(4, 12), 16);
                continue;
            case 8: // Start address (24-bit)
                entryPoint = parseInt(line.substring(4, 10), 16);
                continue;
            case 9: // Start address (16-bit)
                entryPoint = parseInt(line.substring(4, 8), 16);
                continue;
            case 5: case 6: continue; // Record count
            default: continue;
        }

        const address = parseInt(line.substring(4, 4 + addressBytes * 2), 16);
        const dataStart = 4 + addressBytes * 2;
        const dataByteCount = byteCount - addressBytes - 1; // -1 for checksum
        if (!Number.isFinite(dataByteCount) || dataByteCount < 0 || dataByteCount > HEX_MAX_RECORD_BYTES) {
            continue;
        }

        for (let i = 0; i < dataByteCount; i++) {
            const byte = hexByte(line, dataStart + i * 2);
            if (!Number.isFinite(byte)) { continue; }
            const addr = address + i;
            data.set(addr, byte);
            if (addr < minAddress) { minAddress = addr; }
            if (addr > maxAddress) { maxAddress = addr; }
            if (data.size > HEX_MAX_BYTE_ENTRIES) {
                throw new Error(
                    `SREC payload exceeds ${HEX_MAX_BYTE_ENTRIES} byte entries; refusing to load.`
                );
            }
        }
    }

    if (minAddress === Infinity) { minAddress = 0; maxAddress = 0; }

    return { format: 'srec', data, entryPoint, minAddress, maxAddress, byteCount: data.size, invalidRecordCount };
}

/**
 * Parse raw binary data.
 */
export function parseBinary(buffer: Buffer, baseAddress: number = 0): HexParseResult {
    const rawBuffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const minAddress = buffer.length > 0 ? baseAddress : 0;
    const maxAddress = buffer.length > 0 ? baseAddress + buffer.length - 1 : 0;
    return {
        format: 'binary',
        data: new Map(),
        rawBuffer,
        minAddress,
        maxAddress,
        byteCount: buffer.length
    };
}

/**
 * Convert sparse Map data to a flat Uint8Array for a given address range.
 * Missing bytes are filled with fillByte (default 0xFF).
 */
export function toFlatArray(result: HexParseResult, startAddress: number, length: number, fillByte: number = 0xFF): Uint8Array {
    if (result.rawBuffer) {
        const offset = startAddress - result.minAddress;
        const safeOffset = Math.max(0, offset);
        const safeEnd = Math.min(result.rawBuffer.length, offset + length);
        const arr = new Uint8Array(length);
        arr.fill(fillByte);
        if (safeEnd > safeOffset) {
            arr.set(result.rawBuffer.subarray(safeOffset, safeEnd), safeOffset - offset);
        }
        return arr;
    }
    const arr = new Uint8Array(length);
    arr.fill(fillByte);
    if (result.data instanceof HexByteStore) {
        result.data.copyTo(arr, startAddress);
        return arr;
    }
    // 희소한 결과는 주소 범위 대신 실제 데이터 항목만 돈다. 두 바이트뿐인
    // 128MiB 구간을 1억 번 `Map.get` 하던 비용이 항목 수에 비례하게 된다.
    if (result.data.size < length) {
        const end = startAddress + length;
        for (const [address, value] of result.data) {
            if (address >= startAddress && address < end) {
                arr[address - startAddress] = value;
            }
        }
        return arr;
    }
    for (let i = 0; i < length; i++) {
        const val = result.data.get(startAddress + i);
        if (val !== undefined) {
            arr[i] = val;
        }
    }
    return arr;
}

/**
 * Check if an address has data (not a gap).
 */
export function hasData(result: HexParseResult, address: number): boolean {
    if (result.rawBuffer) {
        const offset = address - result.minAddress;
        return offset >= 0 && offset < result.rawBuffer.length;
    }
    return result.data.has(address);
}
