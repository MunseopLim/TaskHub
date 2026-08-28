import * as path from 'path';

/** `.debug_line` 하나가 차지할 수 있는 최대 크기. Memory Map 전체 한도는 100MB다. */
export const DWARF_LINE_MAX_SECTION_BYTES = 32 * 1024 * 1024;
/** 웹뷰 행보다 훨씬 넉넉하되, 변조된 line program이 메모리를 무제한 쓰지 못하게 한다. */
export const DWARF_LINE_MAX_ROWS = 500_000;
export const DWARF_LINE_MAX_UNITS = 10_000;
export const DWARF_LINE_MAX_FILES = 200_000;
export const DWARF_LINE_MAX_DIRECTORIES = 100_000;
export const DWARF_LINE_MAX_STRING_BYTES = 4096;
/** 외부 문자열 section의 같은 긴 경로를 반복 참조해 만드는 디코딩 증폭을 제한한다. */
export const DWARF_LINE_MAX_DECODED_PATH_BYTES = 32 * 1024 * 1024;
export const DWARF_LINE_MAX_LEB_BYTES = 10;
/** 정상 producer는 1~5개를 사용한다. 변조된 v5 descriptor의 곱셈 비용을 제한한다. */
export const DWARF_LINE_MAX_ENTRY_FORMATS = 64;
export const DWARF_LINE_MAX_ENTRY_VALUES = 2_000_000;

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

const DW_LNCT_PATH = 0x01;
const DW_LNCT_DIRECTORY_INDEX = 0x02;
const DW_LNCT_TIMESTAMP = 0x03;
const DW_LNCT_SIZE = 0x04;
const DW_LNCT_MD5 = 0x05;

const DW_FORM_BLOCK2 = 0x03;
const DW_FORM_BLOCK4 = 0x04;
const DW_FORM_DATA2 = 0x05;
const DW_FORM_DATA4 = 0x06;
const DW_FORM_DATA8 = 0x07;
const DW_FORM_STRING = 0x08;
const DW_FORM_BLOCK = 0x09;
const DW_FORM_BLOCK1 = 0x0a;
const DW_FORM_DATA1 = 0x0b;
const DW_FORM_FLAG = 0x0c;
const DW_FORM_SDATA = 0x0d;
const DW_FORM_STRP = 0x0e;
const DW_FORM_UDATA = 0x0f;
const DW_FORM_SEC_OFFSET = 0x17;
const DW_FORM_STRX = 0x1a;
const DW_FORM_STRP_SUP = 0x1d;
const DW_FORM_DATA16 = 0x1e;
const DW_FORM_LINE_STRP = 0x1f;
const DW_FORM_STRX1 = 0x25;
const DW_FORM_STRX2 = 0x26;
const DW_FORM_STRX3 = 0x27;
const DW_FORM_STRX4 = 0x28;

export interface DwarfSourceLocation {
    address: number;
    /** 이 위치가 적용되는 첫 다음 주소. `address <= pc < endAddress`. */
    endAddress: number;
    /** DWARF producer가 기록한 전체 또는 상대 경로. 실제 워크스페이스 경로는 호스트에서 해석한다. */
    filePath: string;
    /** DWARF 5 file table의 16-byte MD5. descriptor가 없으면 undefined다. */
    md5?: string;
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
    /** 형식은 유효하지만 아직 해석하지 않는 문자열 저장 방식. 해당 unit만 건너뛴다. */
    unsupportedFeatures: DwarfLineUnsupportedFeature[];
}

export type DwarfLineUnsupportedFeature =
    | 'compressed-debug-line-str'
    | 'compressed-debug-str'
    | 'indexed-path-forms'
    | 'supplementary-path-form';

/** DWARF 5 line header의 문자열 form이 참조할 수 있는 ELF section payload. */
export interface DwarfLineStringSections {
    debugLineStr?: Buffer;
    debugStr?: Buffer;
    /** section이 없어서가 아니라 SHF_COMPRESSED라 payload를 전달하지 않았음을 구분한다. */
    compressedDebugLineStr?: boolean;
    compressedDebugStr?: boolean;
}

interface DwarfFileEntry {
    name: string;
    directoryIndex: number;
    md5?: string;
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

interface DwarfLineEntryFormat {
    contentType: number;
    form: number;
}

interface DwarfLineFormValue {
    stringValue?: string;
    unsignedValue?: number;
    data16Value?: string;
    unsupportedFeature?: DwarfLineUnsupportedFeature;
}

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

    skip(bytes: number, limit: number, label: string): void {
        this.ensure(bytes, limit, label);
        this.offset += bytes;
    }

    readHexBytes(bytes: number, limit: number, label: string): string {
        this.ensure(bytes, limit, label);
        const value = this.buffer.toString('hex', this.offset, this.offset + bytes);
        this.offset += bytes;
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
        const relativeEnd = this.buffer.subarray(this.offset, maxEnd).indexOf(0);
        if (relativeEnd < 0) {
            throw new Error(`DWARF .debug_line string exceeds ${DWARF_LINE_MAX_STRING_BYTES} bytes or is unterminated.`);
        }
        const end = this.offset + relativeEnd;
        const value = this.buffer.toString('utf8', this.offset, end);
        this.offset = end + 1;
        return value;
    }
}

function readReferencedCString(section: Buffer | undefined, offset: number, sectionName: string): string {
    if (!section) {
        throw new Error(`DWARF .debug_line references missing ${sectionName}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= section.length) {
        throw new Error(`DWARF .debug_line ${sectionName} string offset is out of range.`);
    }
    const maxEnd = Math.min(section.length, offset + DWARF_LINE_MAX_STRING_BYTES + 1);
    const relativeEnd = section.subarray(offset, maxEnd).indexOf(0);
    if (relativeEnd < 0) {
        throw new Error(`DWARF .debug_line ${sectionName} string exceeds ${DWARF_LINE_MAX_STRING_BYTES} bytes or is unterminated.`);
    }
    const end = offset + relativeEnd;
    return section.toString('utf8', offset, end);
}

function validateLineContentForm(contentType: number, form: number): void {
    if (
        contentType !== DW_LNCT_PATH
        && contentType !== DW_LNCT_DIRECTORY_INDEX
        && contentType !== DW_LNCT_TIMESTAMP
        && contentType !== DW_LNCT_SIZE
        && contentType !== DW_LNCT_MD5
        && (contentType < 0x2000 || contentType > 0x3fff)
    ) {
        throw new Error(`DWARF 5 .debug_line uses unsupported content type 0x${contentType.toString(16)}.`);
    }
    let valid = true;
    switch (contentType) {
        case DW_LNCT_PATH:
            valid = form === DW_FORM_STRING || form === DW_FORM_LINE_STRP || form === DW_FORM_STRP
                || form === DW_FORM_STRX || form === DW_FORM_STRX1 || form === DW_FORM_STRX2
                || form === DW_FORM_STRX3 || form === DW_FORM_STRX4 || form === DW_FORM_STRP_SUP;
            break;
        case DW_LNCT_DIRECTORY_INDEX:
            valid = form === DW_FORM_DATA1 || form === DW_FORM_DATA2 || form === DW_FORM_UDATA;
            break;
        case DW_LNCT_TIMESTAMP:
            valid = form === DW_FORM_UDATA || form === DW_FORM_DATA4
                || form === DW_FORM_DATA8 || form === DW_FORM_BLOCK;
            break;
        case DW_LNCT_SIZE:
            valid = form === DW_FORM_UDATA || form === DW_FORM_DATA1 || form === DW_FORM_DATA2
                || form === DW_FORM_DATA4 || form === DW_FORM_DATA8;
            break;
        case DW_LNCT_MD5:
            valid = form === DW_FORM_DATA16;
            break;
        default:
            return;
    }
    if (!valid) {
        throw new Error(
            `DWARF 5 .debug_line content type 0x${contentType.toString(16)} uses invalid form 0x${form.toString(16)}.`
        );
    }
}

function readLineFormValue(
    reader: DwarfReader,
    form: number,
    limit: number,
    strings: DwarfLineStringSections,
    resolveString: boolean,
    captureData16: boolean
): DwarfLineFormValue {
    switch (form) {
        case DW_FORM_STRING:
            return { stringValue: reader.readCString(limit) };
        case DW_FORM_LINE_STRP: {
            const offset = reader.readU32(limit);
            if (resolveString && !strings.debugLineStr && strings.compressedDebugLineStr) {
                return { unsupportedFeature: 'compressed-debug-line-str' };
            }
            return resolveString
                ? { stringValue: readReferencedCString(strings.debugLineStr, offset, '.debug_line_str') }
                : {};
        }
        case DW_FORM_STRP: {
            const offset = reader.readU32(limit);
            if (resolveString && !strings.debugStr && strings.compressedDebugStr) {
                return { unsupportedFeature: 'compressed-debug-str' };
            }
            return resolveString
                ? { stringValue: readReferencedCString(strings.debugStr, offset, '.debug_str') }
                : {};
        }
        case DW_FORM_STRP_SUP:
            reader.readU32(limit);
            return resolveString ? { unsupportedFeature: 'supplementary-path-form' } : {};
        case DW_FORM_DATA1:
        case DW_FORM_FLAG:
            return { unsignedValue: reader.readU8(limit) };
        case DW_FORM_DATA2:
            return { unsignedValue: reader.readU16(limit) };
        case DW_FORM_DATA4:
        case DW_FORM_SEC_OFFSET:
            return { unsignedValue: reader.readU32(limit) };
        case DW_FORM_DATA8: {
            const value = reader.readU64(limit);
            return value <= BigInt(Number.MAX_SAFE_INTEGER) ? { unsignedValue: Number(value) } : {};
        }
        case DW_FORM_UDATA:
            return { unsignedValue: reader.readULEB(limit) };
        case DW_FORM_STRX:
            reader.readULEB(limit);
            return resolveString ? { unsupportedFeature: 'indexed-path-forms' } : {};
        case DW_FORM_SDATA:
            reader.readSLEB(limit);
            return {};
        case DW_FORM_DATA16:
            if (captureData16) {
                return { data16Value: reader.readHexBytes(16, limit, 'DW_FORM_data16') };
            }
            reader.skip(16, limit, 'DW_FORM_data16');
            return {};
        case DW_FORM_STRX1:
            reader.skip(1, limit, 'DW_FORM_strx1');
            return resolveString ? { unsupportedFeature: 'indexed-path-forms' } : {};
        case DW_FORM_STRX2:
            reader.skip(2, limit, 'DW_FORM_strx2');
            return resolveString ? { unsupportedFeature: 'indexed-path-forms' } : {};
        case DW_FORM_STRX3:
            reader.skip(3, limit, 'DW_FORM_strx3');
            return resolveString ? { unsupportedFeature: 'indexed-path-forms' } : {};
        case DW_FORM_STRX4:
            reader.skip(4, limit, 'DW_FORM_strx4');
            return resolveString ? { unsupportedFeature: 'indexed-path-forms' } : {};
        case DW_FORM_BLOCK1:
            reader.skip(reader.readU8(limit), limit, 'DW_FORM_block1');
            return {};
        case DW_FORM_BLOCK2:
            reader.skip(reader.readU16(limit), limit, 'DW_FORM_block2');
            return {};
        case DW_FORM_BLOCK4:
            reader.skip(reader.readU32(limit), limit, 'DW_FORM_block4');
            return {};
        case DW_FORM_BLOCK:
            reader.skip(reader.readULEB(limit), limit, 'DW_FORM_block');
            return {};
        default:
            throw new Error(`DWARF 5 .debug_line uses unsupported form 0x${form.toString(16)}.`);
    }
}

function readV5EntryFormats(reader: DwarfReader, limit: number, label: string): DwarfLineEntryFormat[] {
    const count = reader.readU8(limit);
    if (count > DWARF_LINE_MAX_ENTRY_FORMATS) {
        throw new Error(`DWARF 5 .debug_line ${label} contains more than ${DWARF_LINE_MAX_ENTRY_FORMATS} formats.`);
    }
    const formats: DwarfLineEntryFormat[] = [];
    for (let i = 0; i < count; i++) {
        const contentType = reader.readULEB(limit);
        const form = reader.readULEB(limit);
        validateLineContentForm(contentType, form);
        formats.push({ contentType, form });
    }
    return formats;
}

function validateV5EntryFormats(
    formats: DwarfLineEntryFormat[],
    entryCount: number,
    label: string
): void {
    if (entryCount === 0) { return; }
    if (formats.length === 0) {
        throw new Error(`DWARF 5 .debug_line ${label} has entries without a format.`);
    }
    const pathCount = formats.filter(format => format.contentType === DW_LNCT_PATH).length;
    if (pathCount !== 1) {
        throw new Error(`DWARF 5 .debug_line ${label} must describe exactly one path.`);
    }
}

function readV5Entry(
    reader: DwarfReader,
    formats: DwarfLineEntryFormat[],
    limit: number,
    strings: DwarfLineStringSections,
    onUnsupportedFeature: (feature: DwarfLineUnsupportedFeature) => void
): { path: string; directoryIndex: number; md5?: string } {
    let entryPath = '';
    let directoryIndex = 0;
    let md5: string | undefined;
    for (const descriptor of formats) {
        const value = readLineFormValue(
            reader,
            descriptor.form,
            limit,
            strings,
            descriptor.contentType === DW_LNCT_PATH,
            descriptor.contentType === DW_LNCT_MD5
        );
        if (value.unsupportedFeature) {
            onUnsupportedFeature(value.unsupportedFeature);
        }
        if (descriptor.contentType === DW_LNCT_PATH) {
            entryPath = value.stringValue ?? '';
        } else if (descriptor.contentType === DW_LNCT_DIRECTORY_INDEX) {
            directoryIndex = value.unsignedValue ?? 0;
        } else if (descriptor.contentType === DW_LNCT_MD5 && value.data16Value) {
            md5 = value.data16Value;
        }
    }
    return { path: entryPath, directoryIndex, md5 };
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

interface ResolvedDwarfSource {
    filePath: string;
    md5?: string;
}

function sourceFile(
    files: DwarfFileEntry[],
    directories: string[],
    fileIndex: number,
    version: number
): ResolvedDwarfSource | undefined {
    const zeroIndexed = version >= 5;
    const fileOffset = zeroIndexed ? fileIndex : fileIndex - 1;
    if (!Number.isSafeInteger(fileOffset) || fileOffset < 0 || fileOffset >= files.length) { return undefined; }
    const file = files[fileOffset];
    if (!file.name) { return undefined; }
    if (portableIsAbsolute(file.name) || (!zeroIndexed && file.directoryIndex === 0)) {
        return { filePath: file.name, md5: file.md5 };
    }
    const directoryOffset = zeroIndexed ? file.directoryIndex : file.directoryIndex - 1;
    if (!Number.isSafeInteger(directoryOffset) || directoryOffset < 0 || directoryOffset >= directories.length) {
        return undefined;
    }
    const directory = directories[directoryOffset];
    if (!directory) { return zeroIndexed ? { filePath: file.name, md5: file.md5 } : undefined; }
    if (zeroIndexed && directoryOffset > 0 && !portableIsAbsolute(directory)) {
        const compilationDirectory = directories[0];
        const resolvedDirectory = compilationDirectory
            ? joinDwarfPath(compilationDirectory, directory)
            : directory;
        return { filePath: joinDwarfPath(resolvedDirectory, file.name), md5: file.md5 };
    }
    return { filePath: joinDwarfPath(directory, file.name), md5: file.md5 };
}

function safeAdd(value: number, delta: number, label: string): number {
    const next = value + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(`DWARF .debug_line ${label} leaves the safe integer range.`);
    }
    return next;
}

/**
 * ELF32의 `.debug_line` section을 DWARF 2~5 line matrix로 확장한다.
 *
 * DWARF64 unit은 section 안의 다음 unit을 계속 읽기 위해 길이만 검증하고
 * 건너뛴다. 손상된 지원 unit은 잘못된 소스 위치를 내는 대신 예외로 거부하며,
 * 호출자는 Memory Map 자체를 계속 열고 소스 동작만 숨긴다.
 */
export function parseDwarfLineSection(
    section: Buffer,
    littleEndian: boolean,
    strings: DwarfLineStringSections = {}
): DwarfLineParseResult {
    if (section.length > DWARF_LINE_MAX_SECTION_BYTES) {
        throw new Error(`DWARF .debug_line section exceeds ${DWARF_LINE_MAX_SECTION_BYTES} bytes.`);
    }
    const reader = new DwarfReader(section, littleEndian);
    const locations: DwarfSourceLocation[] = [];
    const unsupportedVersions = new Set<number>();
    const unsupportedFeatures = new Set<DwarfLineUnsupportedFeature>();
    let parsedUnits = 0;
    let skippedDwarf64Units = 0;
    let unitCount = 0;
    let appendedRows = 0;
    let totalFiles = 0;
    let totalDirectories = 0;
    let decodedEntryValues = 0;
    let decodedPathBytes = 0;

    const accountDecodedPath = (value: string): void => {
        decodedPathBytes += Buffer.byteLength(value, 'utf8');
        if (!Number.isSafeInteger(decodedPathBytes) || decodedPathBytes > DWARF_LINE_MAX_DECODED_PATH_BYTES) {
            throw new Error(
                `DWARF 5 .debug_line decodes more than ${DWARF_LINE_MAX_DECODED_PATH_BYTES} path bytes.`
            );
        }
    };

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
        if (version < 2 || version > 5) {
            unsupportedVersions.add(version);
            reader.offset = unitEnd;
            continue;
        }

        const addressSize = version >= 5 ? reader.readU8(unitEnd) : 4;
        const segmentSelectorSize = version >= 5 ? reader.readU8(unitEnd) : 0;
        if (addressSize !== 4) {
            throw new Error(`DWARF .debug_line address size ${addressSize} does not match ELF32.`);
        }
        if (segmentSelectorSize !== 0) {
            throw new Error('DWARF .debug_line segmented addresses are not supported.');
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
        const files: DwarfFileEntry[] = [];
        const unitUnsupportedFeatures = new Set<DwarfLineUnsupportedFeature>();
        const readLegacyFileEntry = (limit: number, name?: string): DwarfFileEntry | undefined => {
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

        if (version >= 5) {
            const directoryFormats = readV5EntryFormats(reader, headerEnd, 'directory entry format');
            const directoryCount = reader.readULEB(headerEnd);
            validateV5EntryFormats(directoryFormats, directoryCount, 'directory entry format');
            if (directoryCount > DWARF_LINE_MAX_DIRECTORIES - totalDirectories) {
                throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_DIRECTORIES} directories.`);
            }
            const directoryValueCount = directoryCount * directoryFormats.length;
            if (
                !Number.isSafeInteger(directoryValueCount)
                || directoryValueCount > DWARF_LINE_MAX_ENTRY_VALUES - decodedEntryValues
            ) {
                throw new Error(`DWARF 5 .debug_line decodes more than ${DWARF_LINE_MAX_ENTRY_VALUES} entry values.`);
            }
            decodedEntryValues += directoryValueCount;
            totalDirectories += directoryCount;
            for (let i = 0; i < directoryCount; i++) {
                const directory = readV5Entry(
                    reader,
                    directoryFormats,
                    headerEnd,
                    strings,
                    feature => unitUnsupportedFeatures.add(feature)
                ).path;
                accountDecodedPath(directory);
                directories.push(directory);
            }

            const fileFormats = readV5EntryFormats(reader, headerEnd, 'file entry format');
            const fileCount = reader.readULEB(headerEnd);
            validateV5EntryFormats(fileFormats, fileCount, 'file entry format');
            if (fileCount > DWARF_LINE_MAX_FILES - totalFiles) {
                throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_FILES} files.`);
            }
            const fileValueCount = fileCount * fileFormats.length;
            if (
                !Number.isSafeInteger(fileValueCount)
                || fileValueCount > DWARF_LINE_MAX_ENTRY_VALUES - decodedEntryValues
            ) {
                throw new Error(`DWARF 5 .debug_line decodes more than ${DWARF_LINE_MAX_ENTRY_VALUES} entry values.`);
            }
            decodedEntryValues += fileValueCount;
            totalFiles += fileCount;
            for (let i = 0; i < fileCount; i++) {
                const file = readV5Entry(
                    reader,
                    fileFormats,
                    headerEnd,
                    strings,
                    feature => unitUnsupportedFeatures.add(feature)
                );
                accountDecodedPath(file.path);
                files.push({ name: file.path, directoryIndex: file.directoryIndex, md5: file.md5 });
            }
        } else {
            while (true) {
                const directory = reader.readCString(headerEnd);
                if (!directory) { break; }
                directories.push(directory);
                if (++totalDirectories > DWARF_LINE_MAX_DIRECTORIES) {
                    throw new Error(`DWARF .debug_line contains more than ${DWARF_LINE_MAX_DIRECTORIES} directories.`);
                }
            }
            while (true) {
                const file = readLegacyFileEntry(headerEnd);
                if (!file) { break; }
                files.push(file);
            }
        }
        if (unitUnsupportedFeatures.size > 0) {
            for (const feature of unitUnsupportedFeatures) {
                unsupportedFeatures.add(feature);
            }
            reader.offset = unitEnd;
            continue;
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
        const resolvedSources = new Map<number, ResolvedDwarfSource | undefined>();
        const resolveSource = (fileIndex: number): ResolvedDwarfSource | undefined => {
            if (resolvedSources.has(fileIndex)) {
                return resolvedSources.get(fileIndex);
            }
            const resolved = sourceFile(files, directories, fileIndex, version);
            resolvedSources.set(fileIndex, resolved);
            return resolved;
        };

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
                const source = resolveSource(pending.file);
                if (source && pending.line > 0 && Number.isSafeInteger(pending.line)) {
                    locations.push({
                        address: pending.address,
                        endAddress: state.address,
                        filePath: source.filePath,
                        md5: source.md5,
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
                    if (extendedEnd - reader.offset !== addressSize) {
                        throw new Error('DWARF .debug_line set_address size does not match ELF32.');
                    }
                    state.address = reader.readU32(extendedEnd);
                    state.opIndex = 0;
                } else if (extendedOpcode === DW_LNE_DEFINE_FILE) {
                    const file = readLegacyFileEntry(extendedEnd);
                    if (file) {
                        files.push(file);
                        // 이전 행이 아직 존재하지 않던 이 index를 참조했을 수 있다.
                        const definedFileIndex = version >= 5 ? files.length - 1 : files.length;
                        resolvedSources.delete(definedFileIndex);
                    }
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
        unsupportedFeatures: Array.from(unsupportedFeatures).sort(),
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
