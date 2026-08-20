import * as path from 'path';

/** `.debug_line` 하나가 차지할 수 있는 최대 크기. Memory Map 전체 한도는 100MB다. */
export const DWARF_LINE_MAX_SECTION_BYTES = 32 * 1024 * 1024;
/** 웹뷰 행보다 훨씬 넉넉하되, 변조된 line program이 메모리를 무제한 쓰지 못하게 한다. */
export const DWARF_LINE_MAX_ROWS = 500_000;
export const DWARF_LINE_MAX_UNITS = 10_000;
export const DWARF_LINE_MAX_FILES = 200_000;
export const DWARF_LINE_MAX_DIRECTORIES = 100_000;
export const DWARF_LINE_MAX_STRING_BYTES = 4096;
export const DWARF_LINE_MAX_LEB_BYTES = 10;

const DW_LNS_COPY = 1;
const DW_LNS_ADVANCE_PC = 2;
const DW_LNS_ADVANCE_LINE = 3;
const DW_LNS_SET_FILE = 4;
const DW_LNS_SET_COLUMN = 5;
const DW_LNS_NEGATE_STMT = 6;
const DW_LNS_SET_BASIC_BLOCK = 7;
const DW_LNS_CONST_ADD_PC = 8;
const DW_LNS_FIXED_ADVANCE_PC = 9;
const DW_LNS_SET_PROLOGUE_END = 10;
const DW_LNS_SET_EPILOGUE_BEGIN = 11;
const DW_LNS_SET_ISA = 12;

const DW_LNE_END_SEQUENCE = 1;
const DW_LNE_SET_ADDRESS = 2;
const DW_LNE_DEFINE_FILE = 3;
const DW_LNE_SET_DISCRIMINATOR = 4;

export interface DwarfSourceLocation {
    address: number;
    /** 이 위치가 적용되는 첫 다음 주소. `address <= pc < endAddress`. */
    endAddress: number;
    /** DWARF producer가 기록한 전체 또는 상대 경로. 실제 워크스페이스 경로는 호스트에서 해석한다. */
    filePath: string;
    line: number;
    column: number;
    isStatement: boolean;
}

export interface DwarfLineParseResult {
    locations: DwarfSourceLocation[];
    parsedUnits: number;
    /** 지원 범위 밖인 line-program version. 해당 unit만 건너뛴다. */
    unsupportedVersions: number[];
    /** 32-bit ELF 안의 DWARF64 line unit은 첫 수직 구현 범위 밖이다. */
    skippedDwarf64Units: number;
}

interface DwarfFileEntry {
    name: string;
    directoryIndex: number;
}

interface LineState {
    address: number;
    opIndex: number;
    file: number;
    line: number;
    column: number;
    isStatement: boolean;
}

interface PendingRow extends LineState { }

class DwarfReader {
    constructor(
        readonly buffer: Buffer,
        readonly littleEndian: boolean,
        public offset = 0
    ) { }

    ensure(bytes: number, limit: number, label: string): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > limit) {
            throw new Error(`DWARF .debug_line ${label} exceeds its unit boundary.`);
        }
    }

    readU8(limit: number): number {
        this.ensure(1, limit, 'read');
        return this.buffer[this.offset++];
    }

    readI8(limit: number): number {
        const value = this.readU8(limit);
        return value >= 0x80 ? value - 0x100 : value;
    }

    readU16(limit: number): number {
        this.ensure(2, limit, '16-bit read');
        const value = this.littleEndian
            ? this.buffer.readUInt16LE(this.offset)
            : this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    readU32(limit: number): number {
        this.ensure(4, limit, '32-bit read');
        const value = this.littleEndian
            ? this.buffer.readUInt32LE(this.offset)
            : this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readU64(limit: number): bigint {
        this.ensure(8, limit, '64-bit read');
        const value = this.littleEndian
            ? this.buffer.readBigUInt64LE(this.offset)
            : this.buffer.readBigUInt64BE(this.offset);
        this.offset += 8;
        return value;
    }

    readULEB(limit: number): number {
        let value = 0n;
        let shift = 0n;
        for (let i = 0; i < DWARF_LINE_MAX_LEB_BYTES; i++) {
            const byte = this.readU8(limit);
            value |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error('DWARF .debug_line ULEB128 value exceeds the safe integer range.');
                }
                return Number(value);
            }
            shift += 7n;
        }
        throw new Error('DWARF .debug_line ULEB128 value is too long.');
    }

    readSLEB(limit: number): number {
        let value = 0n;
        let shift = 0n;
        let byte = 0;
        for (let i = 0; i < DWARF_LINE_MAX_LEB_BYTES; i++) {
            byte = this.readU8(limit);
            value |= BigInt(byte & 0x7f) << shift;
            shift += 7n;
            if ((byte & 0x80) === 0) {
                if ((byte & 0x40) !== 0) {
                    value |= (-1n) << shift;
                }
                const min = BigInt(Number.MIN_SAFE_INTEGER);
                const max = BigInt(Number.MAX_SAFE_INTEGER);
                if (value < min || value > max) {
                    throw new Error('DWARF .debug_line SLEB128 value exceeds the safe integer range.');
                }
                return Number(value);
            }
        }
        throw new Error('DWARF .debug_line SLEB128 value is too long.');
    }

    readCString(limit: number): string {
        if (this.offset >= limit) {
            throw new Error('DWARF .debug_line string terminator is missing.');
        }
        const maxEnd = Math.min(limit, this.offset + DWARF_LINE_MAX_STRING_BYTES + 1);
        const end = this.buffer.indexOf(0, this.offset);
        if (end < 0 || end >= maxEnd || end >= limit) {
            throw new Error(`DWARF .debug_line string exceeds ${DWARF_LINE_MAX_STRING_BYTES} bytes or is unterminated.`);
        }
        const value = this.buffer.toString('utf8', this.offset, end);
        this.offset = end + 1;
        return value;
    }
}

function portableIsAbsolute(value: string): boolean {
    return path.posix.isAbsolute(value.replace(/\\/g, '/'))
        || /^[A-Za-z]:[\\/]/.test(value)
        || /^[/\\]{2}/.test(value);
}

function joinDwarfPath(directory: string, fileName: string): string {
    if (!directory || portableIsAbsolute(fileName)) { return fileName; }
    const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
    return `${directory.replace(/[\\/]$/, '')}${separator}${fileName}`;
}

function sourcePath(files: DwarfFileEntry[], directories: string[], fileIndex: number): string | undefined {
    if (!Number.isSafeInteger(fileIndex) || fileIndex <= 0 || fileIndex > files.length) { return undefined; }
    const file = files[fileIndex - 1];
    if (!file.name) { return undefined; }
    if (portableIsAbsolute(file.name) || file.directoryIndex === 0) { return file.name; }
    if (file.directoryIndex > directories.length) { return undefined; }
    const directory = directories[file.directoryIndex - 1];
    return directory ? joinDwarfPath(directory, file.name) : undefined;
}

function safeAdd(value: number, delta: number, label: string): number {
    const next = value + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(`DWARF .debug_line ${label} leaves the safe integer range.`);
    }
    return next;
}

/**
 * ELF32의 `.debug_line` section을 DWARF 2~4 line matrix로 확장한다.
 *
 * DWARF 5와 DWARF64 unit은 section 안의 다음 unit을 계속 읽기 위해 길이만
 * 검증하고 건너뛴다. 손상된 지원 unit은 잘못된 소스 위치를 내는 대신 예외로
 * 거부하며, 호출자는 Memory Map 자체를 계속 열고 소스 동작만 숨긴다.
 */
export function parseDwarfLineSection(section: Buffer, littleEndian: boolean): DwarfLineParseResult {
    if (section.length > DWARF_LINE_MAX_SECTION_BYTES) {
        throw new Error(`DWARF .debug_line section exceeds ${DWARF_LINE_MAX_SECTION_BYTES} bytes.`);
    }
    const reader = new DwarfReader(section, littleEndian);
    const locations: DwarfSourceLocation[] = [];
    const unsupportedVersions = new Set<number>();
    let parsedUnits = 0;
    let skippedDwarf64Units = 0;
    let unitCount = 0;
    let appendedRows = 0;
    let totalFiles = 0;
    let totalDirectories = 0;

    while (reader.offset < section.length) {
        if (++unitCount > DWARF_LINE_MAX_UNITS) {
            throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_UNITS} units.`);
        }
        const unitStart = reader.offset;
        const initialLength = reader.readU32(section.length);
        if (initialLength === 0) {
            // Linkers may leave zero padding after the last unit. Advancing through every
            // four-byte word would turn a padded section into a CPU loop, so stop here.
            break;
        }

        let unitLength = initialLength;
        let dwarf64 = false;
        if (initialLength === 0xffffffff) {
            dwarf64 = true;
            const length64 = reader.readU64(section.length);
            if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('DWARF64 .debug_line unit length exceeds the safe integer range.');
            }
            unitLength = Number(length64);
        } else if (initialLength >= 0xfffffff0) {
            throw new Error(`DWARF .debug_line uses reserved initial length 0x${initialLength.toString(16)}.`);
        }

        const unitEnd = reader.offset + unitLength;
        if (!Number.isSafeInteger(unitEnd) || unitEnd <= reader.offset || unitEnd > section.length) {
            throw new Error(`DWARF .debug_line unit at 0x${unitStart.toString(16)} exceeds the section boundary.`);
        }
        if (dwarf64) {
            skippedDwarf64Units++;
            reader.offset = unitEnd;
            continue;
        }

        const version = reader.readU16(unitEnd);
        if (version < 2 || version > 4) {
            unsupportedVersions.add(version);
            reader.offset = unitEnd;
            continue;
        }

        const headerLength = reader.readU32(unitEnd);
        const headerEnd = reader.offset + headerLength;
        if (!Number.isSafeInteger(headerEnd) || headerEnd > unitEnd) {
            throw new Error('DWARF .debug_line header exceeds its unit boundary.');
        }

        const minimumInstructionLength = reader.readU8(headerEnd);
        const maximumOperationsPerInstruction = version >= 4 ? reader.readU8(headerEnd) : 1;
        const defaultIsStatement = reader.readU8(headerEnd) !== 0;
        const lineBase = reader.readI8(headerEnd);
        const lineRange = reader.readU8(headerEnd);
        const opcodeBase = reader.readU8(headerEnd);
        if (minimumInstructionLength === 0 || maximumOperationsPerInstruction === 0 || lineRange === 0 || opcodeBase === 0) {
            throw new Error('DWARF .debug_line header contains a zero instruction, operation, line range, or opcode base.');
        }

        const standardOpcodeLengths: number[] = [];
        for (let opcode = 1; opcode < opcodeBase; opcode++) {
            standardOpcodeLengths.push(reader.readU8(headerEnd));
        }

        const directories: string[] = [];
        while (true) {
            const directory = reader.readCString(headerEnd);
            if (!directory) { break; }
            directories.push(directory);
            if (++totalDirectories > DWARF_LINE_MAX_DIRECTORIES) {
                throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_DIRECTORIES} directories.`);
            }
        }

        const files: DwarfFileEntry[] = [];
        const readFileEntry = (limit: number, name?: string): DwarfFileEntry | undefined => {
            const fileName = name ?? reader.readCString(limit);
            if (!fileName) { return undefined; }
            const directoryIndex = reader.readULEB(limit);
            reader.readULEB(limit); // modification time
            reader.readULEB(limit); // file size
            if (++totalFiles > DWARF_LINE_MAX_FILES) {
                throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_FILES} files.`);
            }
            return { name: fileName, directoryIndex };
        };
        while (true) {
            const file = readFileEntry(headerEnd);
            if (!file) { break; }
            files.push(file);
        }
        // Producers may reserve bytes at the end of the prologue. The line program begins
        // exactly at headerEnd, not necessarily at the byte after the file terminator.
        reader.offset = headerEnd;

        const initialState = (): LineState => ({
            address: 0,
            opIndex: 0,
            file: 1,
            line: 1,
            column: 0,
            isStatement: defaultIsStatement,
        });
        let state = initialState();
        let pending: PendingRow | undefined;
        let sequenceLocationStart = locations.length;

        const advanceOperation = (operationAdvance: number): void => {
            if (!Number.isSafeInteger(operationAdvance) || operationAdvance < 0) {
                throw new Error('DWARF .debug_line operation advance is invalid.');
            }
            const combined = state.opIndex + operationAdvance;
            const instructionAdvance = Math.floor(combined / maximumOperationsPerInstruction);
            state.address = safeAdd(
                state.address,
                minimumInstructionLength * instructionAdvance,
                'address'
            );
            state.opIndex = combined % maximumOperationsPerInstruction;
        };

        const appendRow = (endSequence: boolean): void => {
            if (++appendedRows > DWARF_LINE_MAX_ROWS) {
                throw new Error(`DWARF .debug_line expands to more than ${DWARF_LINE_MAX_ROWS} rows.`);
            }
            if (pending && state.address < pending.address) {
                throw new Error('DWARF .debug_line sequence addresses decrease.');
            }
            if (pending && state.address > pending.address) {
                const filePath = sourcePath(files, directories, pending.file);
                if (filePath && pending.line > 0 && Number.isSafeInteger(pending.line)) {
                    locations.push({
                        address: pending.address,
                        endAddress: state.address,
                        filePath,
                        line: pending.line,
                        column: Number.isSafeInteger(pending.column) && pending.column >= 0 ? pending.column : 0,
                        isStatement: pending.isStatement,
                    });
                }
            }
            if (endSequence) {
                pending = undefined;
                state = initialState();
                sequenceLocationStart = locations.length;
            } else {
                pending = { ...state };
            }
        };

        while (reader.offset < unitEnd) {
            const opcode = reader.readU8(unitEnd);
            if (opcode === 0) {
                const extendedLength = reader.readULEB(unitEnd);
                if (extendedLength === 0) {
                    throw new Error('DWARF .debug_line extended opcode has zero length.');
                }
                const extendedEnd = reader.offset + extendedLength;
                if (!Number.isSafeInteger(extendedEnd) || extendedEnd > unitEnd) {
                    throw new Error('DWARF .debug_line extended opcode exceeds its unit boundary.');
                }
                const extendedOpcode = reader.readU8(extendedEnd);
                if (extendedOpcode === DW_LNE_END_SEQUENCE) {
                    appendRow(true);
                } else if (extendedOpcode === DW_LNE_SET_ADDRESS) {
                    // Existing Memory Map supports ELF32 only, so the target address is 4 bytes.
                    if (extendedEnd - reader.offset !== 4) {
                        throw new Error('DWARF .debug_line set_address size does not match ELF32.');
                    }
                    state.address = reader.readU32(extendedEnd);
                    state.opIndex = 0;
                } else if (extendedOpcode === DW_LNE_DEFINE_FILE) {
                    const file = readFileEntry(extendedEnd);
                    if (file) { files.push(file); }
                } else if (extendedOpcode === DW_LNE_SET_DISCRIMINATOR) {
                    reader.readULEB(extendedEnd);
                }
                reader.offset = extendedEnd;
                continue;
            }

            if (opcode >= opcodeBase) {
                const adjustedOpcode = opcode - opcodeBase;
                const operationAdvance = Math.floor(adjustedOpcode / lineRange);
                state.line = safeAdd(state.line, lineBase + (adjustedOpcode % lineRange), 'line');
                advanceOperation(operationAdvance);
                appendRow(false);
                continue;
            }

            switch (opcode) {
                case DW_LNS_COPY:
                    appendRow(false);
                    break;
                case DW_LNS_ADVANCE_PC:
                    advanceOperation(reader.readULEB(unitEnd));
                    break;
                case DW_LNS_ADVANCE_LINE:
                    state.line = safeAdd(state.line, reader.readSLEB(unitEnd), 'line');
                    break;
                case DW_LNS_SET_FILE:
                    state.file = reader.readULEB(unitEnd);
                    break;
                case DW_LNS_SET_COLUMN:
                    state.column = reader.readULEB(unitEnd);
                    break;
                case DW_LNS_NEGATE_STMT:
                    state.isStatement = !state.isStatement;
                    break;
                case DW_LNS_SET_BASIC_BLOCK:
                case DW_LNS_SET_PROLOGUE_END:
                case DW_LNS_SET_EPILOGUE_BEGIN:
                    break;
                case DW_LNS_CONST_ADD_PC:
                    advanceOperation(Math.floor((255 - opcodeBase) / lineRange));
                    break;
                case DW_LNS_FIXED_ADVANCE_PC:
                    state.address = safeAdd(state.address, reader.readU16(unitEnd), 'address');
                    state.opIndex = 0;
                    break;
                case DW_LNS_SET_ISA:
                    reader.readULEB(unitEnd);
                    break;
                default: {
                    const operandCount = standardOpcodeLengths[opcode - 1] ?? 0;
                    for (let i = 0; i < operandCount; i++) { reader.readULEB(unitEnd); }
                    break;
                }
            }
        }

        // A valid sequence must end with DW_LNE_end_sequence. Do not keep ranges from
        // a truncated final sequence whose upper address is unknown.
        if (pending) {
            locations.splice(sequenceLocationStart);
        }
        reader.offset = unitEnd;
        parsedUnits++;
    }

    locations.sort((a, b) => a.address - b.address || a.endAddress - b.endAddress);
    return {
        locations,
        parsedUnits,
        unsupportedVersions: Array.from(unsupportedVersions).sort((a, b) => a - b),
        skippedDwarf64Units,
    };
}

/** 심볼 시작 주소(ARM Thumb bit 포함)를 source range에 연결한다. */
export function findDwarfSourceLocation(
    locations: DwarfSourceLocation[],
    symbolAddress: number,
    symbolSize: number = 1
): DwarfSourceLocation | undefined {
    if (!Number.isSafeInteger(symbolAddress) || symbolAddress < 0 || !Number.isSafeInteger(symbolSize) || symbolSize <= 0) {
        return undefined;
    }
    const address = (symbolAddress & 1) === 1 ? symbolAddress - 1 : symbolAddress;
    const symbolEnd = safeAdd(address, symbolSize, 'symbol range');

    let low = 0;
    let high = locations.length;
    while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (locations[mid].address <= address) { low = mid + 1; } else { high = mid; }
    }
    // Overlaps are unusual for linked compilation units, but optimized/debug producer
    // output can duplicate rows. Prefer the closest starting range without an unbounded scan.
    let containing: DwarfSourceLocation | undefined;
    for (let i = low - 1, checked = 0; i >= 0 && checked < 64; i--, checked++) {
        const location = locations[i];
        if (location.address <= address && address < location.endAddress) {
            // An exact row at the function entry is stronger than the prologue heuristic below.
            if (location.address === address) { return location; }
            containing = location;
            break;
        }
    }

    // A function symbol may start in a prologue while the preceding line row's range still
    // crosses the entry. Prefer the first row that actually starts inside this function;
    // if none exists, the containing row remains the best available location.
    const next = locations[low];
    if (next && next.address > address && next.address < symbolEnd) { return next; }
    return containing;
}
