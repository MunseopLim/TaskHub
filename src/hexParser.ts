/**
 * Hex file parser supporting Intel HEX, Motorola SREC, and raw binary formats.
 */

export type HexFormat = 'intel' | 'srec' | 'binary';

export interface HexParseResult {
    format: HexFormat;
    /** Sparse memory data: address → byte value */
    data: Map<number, number>;
    /** Entry point address (if available) */
    entryPoint?: number;
    /** Minimum address in the data */
    minAddress: number;
    /** Maximum address in the data (inclusive) */
    maxAddress: number;
    /** Total byte count */
    byteCount: number;
}

/**
 * Detect file format from content.
 */
export function detectFormat(content: string | Buffer): HexFormat {
    if (Buffer.isBuffer(content)) {
        return 'binary';
    }
    const trimmed = content.trimStart();
    if (trimmed.startsWith(':')) {
        return 'intel';
    }
    if (/^S[0-9]/.test(trimmed)) {
        return 'srec';
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

        const byteCount = parseInt(line.substring(1, 3), 16);
        const address = parseInt(line.substring(3, 7), 16);
        const recordType = parseInt(line.substring(7, 9), 16);

        // Validate checksum
        let sum = 0;
        for (let i = 1; i < line.length - 2; i += 2) {
            sum += parseInt(line.substring(i, i + 2), 16);
        }
        const checksum = parseInt(line.substring(line.length - 2), 16);
        if (((sum + checksum) & 0xFF) !== 0) {
            continue; // Skip invalid lines
        }

        switch (recordType) {
            case 0x00: { // Data record
                const fullAddress = baseAddress + address;
                for (let i = 0; i < byteCount; i++) {
                    const byte = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
                    const addr = fullAddress + i;
                    data.set(addr, byte);
                    if (addr < minAddress) { minAddress = addr; }
                    if (addr > maxAddress) { maxAddress = addr; }
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
                baseAddress = parseInt(line.substring(9, 13), 16) << 16;
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

        const type = parseInt(line[1], 10);
        const byteCount = parseInt(line.substring(2, 4), 16);

        // Validate checksum
        let sum = 0;
        for (let i = 2; i < line.length - 2; i += 2) {
            sum += parseInt(line.substring(i, i + 2), 16);
        }
        const checksum = parseInt(line.substring(line.length - 2), 16);
        if (((sum + checksum) & 0xFF) !== 0xFF) {
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

        for (let i = 0; i < dataByteCount; i++) {
            const byte = parseInt(line.substring(dataStart + i * 2, dataStart + i * 2 + 2), 16);
            const addr = address + i;
            data.set(addr, byte);
            if (addr < minAddress) { minAddress = addr; }
            if (addr > maxAddress) { maxAddress = addr; }
        }
    }

    if (minAddress === Infinity) { minAddress = 0; maxAddress = 0; }

    return { format: 'srec', data, entryPoint, minAddress, maxAddress, byteCount: data.size };
}

/**
 * Parse raw binary data.
 */
export function parseBinary(buffer: Buffer, baseAddress: number = 0): HexParseResult {
    const data = new Map<number, number>();
    for (let i = 0; i < buffer.length; i++) {
        data.set(baseAddress + i, buffer[i]);
    }
    const minAddress = buffer.length > 0 ? baseAddress : 0;
    const maxAddress = buffer.length > 0 ? baseAddress + buffer.length - 1 : 0;
    return { format: 'binary', data, minAddress, maxAddress, byteCount: buffer.length };
}

/**
 * Convert sparse Map data to a flat Uint8Array for a given address range.
 * Missing bytes are filled with fillByte (default 0xFF).
 */
export function toFlatArray(result: HexParseResult, startAddress: number, length: number, fillByte: number = 0xFF): Uint8Array {
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
    return result.data.has(address);
}
