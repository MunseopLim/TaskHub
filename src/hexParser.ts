/**
 * Hex file parser supporting Intel HEX, Motorola SREC, and raw binary formats.
 */

export type HexFormat = 'intel' | 'srec' | 'binary';

/**
 * 파서가 받아들이는 최대 byte entry 수.
 *
 * 여기서 entry 는 **주소 하나에 담긴 바이트 하나**(`data: Map<주소, 바이트>`)다.
 * 이 Map 은 **HEX/SREC 전용**이고, binary 는 `rawBuffer`(Uint8Array)를 쓰므로
 * 이 상한과 무관하다.
 *
 * 이전 값(100M, 주석에 "최악 1.6GB")은 **도달할 수 없는 숫자**였다. HEX/SREC 는
 * 텍스트 포맷이라 1바이트를 최소 2자 + 레코드 오버헤드로 적으므로, Hex Viewer
 * 의 50MB 파일 상한을 통과한 입력이 만들 수 있는 entry 는 최대 약 25M 이다
 * (Intel HEX 최대 레코드 길이 255바이트 기준 2.05자/바이트, SREC 도 비슷).
 * 즉 옛 상한은 어떤 입력으로도 걸리지 않았고, 계산도 실제 V8 Map 비용(entry 당
 * 수십 바이트)보다 낙관적이었다.
 *
 * 32M 은 그 도달 가능 최대치(~25M) 위의 backstop 이다 — 정상 파일을 거부하지
 * 않으면서, 파일 상한이 어떤 이유로 완화되더라도 파서가 무한정 담지는 않는다.
 * 파일 상한과의 관계는 `hexParserLimits.test.ts` 가 고정한다.
 */
export const HEX_MAX_BYTE_ENTRIES = 32 * 1024 * 1024;
/** Maximum bytes per single record (Intel HEX data field is 1 byte → 255; SREC is 253). Guards malformed input. */
const HEX_MAX_RECORD_BYTES = 255;

export interface HexParseResult {
    format: HexFormat;
    /** Sparse memory data: address → byte value (used for HEX/SREC) */
    data: Map<number, number>;
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
}

/** 앞에서 훑어볼 줄 수. 앞줄만 깨진 파일을 살리되 바이너리에는 기회를 많이 주지 않는다. */
const HEX_DETECT_LINES = 5;
/** 판정에 읽을 앞부분 길이. 50MB 를 통째로 `split` 하지 않기 위한 것이다. */
const HEX_DETECT_WINDOW = 4096;

/**
 * 이 줄이 **완전한 레코드**이고 체크섬까지 맞는가.
 *
 * 판정과 파싱이 **같은 규칙**을 쓰도록 길이·체크섬 계산은 `parseIntelHex` /
 * `parseSrec` 의 것을 그대로 옮겼다. 한쪽만 바뀌면 "판정은 됐는데 아무것도 안
 * 읽히는" 자리가 다시 생긴다.
 *
 * 자릿수 검사가 따로 있는 이유: `parseInt('0Z', 16)` 은 `0` 을 돌려주며 **성공한다.**
 * 길이와 범위만 봐서는 16진수가 아닌 바이트가 섞인 파일이 그대로 통과한다.
 */
function recordIsValid(line: string, kind: 'intel' | 'srec'): boolean {
    const hexAt = (from: number, len: number): number => {
        const slice = line.substring(from, from + len);
        return /^[0-9a-fA-F]+$/.test(slice) && slice.length === len ? parseInt(slice, 16) : NaN;
    };

    if (kind === 'intel') {
        if (!line.startsWith(':') || line.length < 11) { return false; }
        const byteCount = hexAt(1, 2);
        if (!Number.isFinite(byteCount) || byteCount > HEX_MAX_RECORD_BYTES) { return false; }
        const expectedLength = 11 + byteCount * 2;
        if (line.length < expectedLength) { return false; }
        let sum = 0;
        for (let i = 1; i < expectedLength - 2; i += 2) {
            const byte = hexAt(i, 2);
            if (!Number.isFinite(byte)) { return false; }
            sum += byte;
        }
        const checksum = hexAt(expectedLength - 2, 2);
        return Number.isFinite(checksum) && ((sum + checksum) & 0xFF) === 0;
    }

    if (!/^S[0-9]/.test(line) || line.length < 4) { return false; }
    const byteCount = hexAt(2, 2);
    if (!Number.isFinite(byteCount)) { return false; }
    const expectedLength = 4 + byteCount * 2;
    if (line.length < expectedLength) { return false; }
    let sum = 0;
    for (let i = 2; i < expectedLength - 2; i += 2) {
        const byte = hexAt(i, 2);
        if (!Number.isFinite(byte)) { return false; }
        sum += byte;
    }
    const checksum = hexAt(expectedLength - 2, 2);
    return Number.isFinite(checksum) && ((sum + checksum) & 0xFF) === 0xFF;
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
    const data = new Map<number, number>();
    let baseAddress = 0;
    let entryPoint: number | undefined;
    let minAddress = Infinity;
    let maxAddress = -Infinity;

    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith(':')) { continue; }
        if (line.length < 11) { continue; }

        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);
        if (!Number.isFinite(byteCount) || byteCount < 0 || byteCount > HEX_MAX_RECORD_BYTES) {
            continue;
        }
        const expectedLength = 11 + byteCount * 2;
        if (line.length < expectedLength) {
            continue;
        }

        // Validate checksum
        let sum = 0;
        let validBytes = true;
        for (let i = 1; i < expectedLength - 2; i += 2) {
            const byte = parseInt(line.substring(i, i + 2), 16);
            if (!Number.isFinite(byte)) {
                validBytes = false;
                break;
            }
            sum += byte;
        }
        if (!validBytes) { continue; }
        const checksum = parseInt(line.substring(expectedLength - 2, expectedLength), 16);
        if (!Number.isFinite(checksum) || ((sum + checksum) & 0xFF) !== 0) {
            continue; // Skip invalid lines
        }

        switch (recordType) {
            case 0x00: { // Data record
                const fullAddress = baseAddress + address;
                for (let i = 0; i < byteCount; i++) {
                    const byte = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
                    if (!Number.isFinite(byte)) { continue; }
                    const addr = fullAddress + i;
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
                break;
            case 0x05: // Start Linear Address
                entryPoint = parseInt(line.substring(9, 17), 16);
                break;
        }
    }

    if (minAddress === Infinity) { minAddress = 0; maxAddress = 0; }

    return { format: 'intel', data, entryPoint, minAddress, maxAddress, byteCount: data.size };
}

/**
 * Parse Motorola SREC format (https://en.wikipedia.org/wiki/SREC_(file_format)).
 */
export function parseSrec(content: string): HexParseResult {
    const data = new Map<number, number>();
    let entryPoint: number | undefined;
    let minAddress = Infinity;
    let maxAddress = -Infinity;

    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('S')) { continue; }
        if (line.length < 4) { continue; }

        const type = parseInt(line[1], 10);
        const byteCount = parseInt(line.substring(2, 4), 16);
        if (!Number.isFinite(type) || !Number.isFinite(byteCount)) { continue; }
        const expectedLength = 4 + byteCount * 2;
        if (line.length < expectedLength) {
            continue;
        }

        // Validate checksum
        let sum = 0;
        let validBytes = true;
        for (let i = 2; i < expectedLength - 2; i += 2) {
            const byte = parseInt(line.substring(i, i + 2), 16);
            if (!Number.isFinite(byte)) {
                validBytes = false;
                break;
            }
            sum += byte;
        }
        if (!validBytes) { continue; }
        const checksum = parseInt(line.substring(expectedLength - 2, expectedLength), 16);
        if (!Number.isFinite(checksum) || ((sum + checksum) & 0xFF) !== 0xFF) {
            continue;
        }

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
            const byte = parseInt(line.substring(dataStart + i * 2, dataStart + i * 2 + 2), 16);
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

    return { format: 'srec', data, entryPoint, minAddress, maxAddress, byteCount: data.size };
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
