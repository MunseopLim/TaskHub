import * as assert from 'assert';
import {
    DWARF_LINE_MAX_DIRECTORIES,
    DWARF_LINE_MAX_FILES,
    DWARF_LINE_MAX_LEB_BYTES,
    DWARF_LINE_MAX_ROWS,
    DWARF_LINE_MAX_SECTION_BYTES,
    DWARF_LINE_MAX_STRING_BYTES,
    DWARF_LINE_MAX_UNITS,
    findDwarfSourceLocation,
    parseDwarfLineSection,
} from '../dwarfLineParser';

function uleb(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    do {
        let byte = rest & 0x7f;
        rest = Math.floor(rest / 128);
        if (rest > 0) { byte |= 0x80; }
        bytes.push(byte);
    } while (rest > 0);
    return bytes;
}

function sleb(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    let more = true;
    while (more) {
        let byte = rest & 0x7f;
        rest >>= 7;
        const sign = (byte & 0x40) !== 0;
        more = !((rest === 0 && !sign) || (rest === -1 && sign));
        if (more) { byte |= 0x80; }
        bytes.push(byte);
    }
    return bytes;
}

function cstring(value: string): number[] {
    return [...Buffer.from(value, 'utf8'), 0];
}

function uint16(value: number, littleEndian: boolean): number[] {
    const buffer = Buffer.alloc(2);
    littleEndian ? buffer.writeUInt16LE(value) : buffer.writeUInt16BE(value);
    return [...buffer];
}

function uint32(value: number, littleEndian: boolean): number[] {
    const buffer = Buffer.alloc(4);
    littleEndian ? buffer.writeUInt32LE(value) : buffer.writeUInt32BE(value);
    return [...buffer];
}

interface LineUnitOptions {
    version?: 2 | 3 | 4;
    littleEndian?: boolean;
    address?: number;
    directories?: string[];
    files?: { name: string; directoryIndex: number }[];
    program?: number[];
}

function buildLineUnit(options: LineUnitOptions = {}): Buffer {
    const version = options.version ?? 4;
    const littleEndian = options.littleEndian ?? true;
    const address = options.address ?? 0x08000100;
    const opcodeBase = version === 2 ? 9 : 13;
    const standardLengths = version === 2
        ? [0, 1, 1, 1, 1, 0, 0, 0]
        : [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1];
    const directories = options.directories ?? ['/workspace/src'];
    const files = options.files ?? [
        { name: 'main.c', directoryIndex: 1 },
        { name: 'util.c', directoryIndex: 1 },
    ];
    const header = [
        1, // minimum_instruction_length
        ...(version >= 4 ? [1] : []), // maximum_operations_per_instruction
        1, // default_is_stmt
        0xfb, // line_base = -5
        14, // line_range
        opcodeBase,
        ...standardLengths,
        ...directories.flatMap(cstring),
        0,
        ...files.flatMap(file => [
            ...cstring(file.name), ...uleb(file.directoryIndex), ...uleb(0), ...uleb(0),
        ]),
        0,
    ];
    const program = options.program ?? [
        0, ...uleb(5), 2, ...uint32(address, littleEndian), // DW_LNE_set_address
        1, // DW_LNS_copy: main.c:1 @ address
        3, ...sleb(9), // line 10
        2, ...uleb(4), // +4 bytes
        1, // main.c:10
        4, ...uleb(2), // util.c
        3, ...sleb(10), // line 20
        2, ...uleb(4),
        1, // util.c:20
        2, ...uleb(4),
        0, ...uleb(1), 1, // DW_LNE_end_sequence
    ];
    const body = [
        ...uint16(version, littleEndian),
        ...uint32(header.length, littleEndian),
        ...header,
        ...program,
    ];
    return Buffer.from([...uint32(body.length, littleEndian), ...body]);
}

suite('DWARF .debug_line parser', () => {
    test('DWARF 4 line program을 주소 범위와 파일·줄로 확장한다', () => {
        const result = parseDwarfLineSection(buildLineUnit(), true);
        assert.strictEqual(result.parsedUnits, 1);
        assert.deepStrictEqual(result.unsupportedVersions, []);
        assert.deepStrictEqual(result.locations.map(location => ({
            start: location.address,
            end: location.endAddress,
            file: location.filePath,
            line: location.line,
        })), [
            { start: 0x08000100, end: 0x08000104, file: '/workspace/src/main.c', line: 1 },
            { start: 0x08000104, end: 0x08000108, file: '/workspace/src/main.c', line: 10 },
            { start: 0x08000108, end: 0x0800010c, file: '/workspace/src/util.c', line: 20 },
        ]);
    });

    test('DWARF 2·3 헤더와 big-endian 주소를 해석한다', () => {
        for (const version of [2, 3] as const) {
            const result = parseDwarfLineSection(buildLineUnit({ version, littleEndian: false }), false);
            assert.strictEqual(result.parsedUnits, 1);
            assert.strictEqual(result.locations[0].address, 0x08000100);
            assert.strictEqual(result.locations[1].line, 10);
        }
    });

    test('지원하지 않는 unit은 다음 지원 unit을 막지 않는다', () => {
        const dwarf64Length = Buffer.alloc(8);
        dwarf64Length.writeBigUInt64LE(1n);
        const dwarf64 = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), dwarf64Length, Buffer.from([0])]);
        const unsupportedBody = Buffer.from([...uint16(5, true)]);
        const unsupported = Buffer.from([...uint32(unsupportedBody.length, true), ...unsupportedBody]);
        const result = parseDwarfLineSection(Buffer.concat([dwarf64, unsupported, buildLineUnit()]), true);
        assert.deepStrictEqual(result.unsupportedVersions, [5]);
        assert.strictEqual(result.skippedDwarf64Units, 1);
        assert.strictEqual(result.parsedUnits, 1);
        assert.strictEqual(result.locations.length, 3);
    });

    test('symbol 시작, Thumb bit, prologue 안의 첫 행을 source range에 연결한다', () => {
        const locations = parseDwarfLineSection(buildLineUnit(), true).locations;
        assert.strictEqual(findDwarfSourceLocation(locations, 0x08000104)?.line, 10);
        assert.strictEqual(findDwarfSourceLocation(locations, 0x08000105)?.line, 10);
        assert.strictEqual(findDwarfSourceLocation(locations, 0x080000fc, 16)?.line, 1);
        assert.strictEqual(findDwarfSourceLocation(locations, 0x080000fc, 4), undefined);
        assert.strictEqual(
            findDwarfSourceLocation(locations, 0x08000102, 8)?.line,
            10,
            '이전 행 범위가 함수 시작을 덮어도 함수 안에서 시작하는 첫 행을 우선해야 한다'
        );
    });

    test('파일의 directory_index가 테이블 범위를 벗어나면 basename으로 강등하지 않는다', () => {
        const invalidDirectory = Buffer.from(buildLineUnit());
        const fileEntry = Buffer.from([...cstring('main.c'), 1, 0, 0]);
        const entryOffset = invalidDirectory.indexOf(fileEntry);
        assert.ok(entryOffset > 0);
        invalidDirectory[entryOffset + cstring('main.c').length] = 2;

        const result = parseDwarfLineSection(invalidDirectory, true);
        assert.ok(result.locations.length > 0, '유효한 util.c 행까지 모두 버리면 안 된다');
        assert.ok(result.locations.every(location => location.filePath === '/workspace/src/util.c'));
    });

    test('잘린 unit과 잘못된 line_range를 거부한다', () => {
        const truncated = buildLineUnit().subarray(0, 20);
        assert.throws(() => parseDwarfLineSection(truncated, true), /unit.*boundary/i);

        const invalid = Buffer.from(buildLineUnit());
        // length(4) + version(2) + header_length(4) + min(1) + max_ops(1)
        // + default_is_stmt(1) + line_base(1) = line_range offset 14
        invalid[14] = 0;
        assert.throws(() => parseDwarfLineSection(invalid, true), /zero instruction.*line range/i);

        const wrongAddressSize = Buffer.from(buildLineUnit());
        const setAddress = wrongAddressSize.indexOf(Buffer.from([0, 5, 2]));
        assert.ok(setAddress > 0);
        wrongAddressSize[setAddress + 1] = 4;
        assert.throws(() => parseDwarfLineSection(wrongAddressSize, true), /set_address size/i);
    });

    test('section 크기 상한을 넘으면 상태 머신을 시작하기 전에 거부한다', () => {
        assert.throws(
            () => parseDwarfLineSection(Buffer.alloc(DWARF_LINE_MAX_SECTION_BYTES + 1), true),
            /section exceeds/i
        );
    });

    test('unit·row·file·directory·string·LEB 방어 한도를 각각 강제한다', () => {
        const unsupportedUnit = Buffer.from([...uint32(2, true), ...uint16(5, true)]);
        assert.throws(
            () => parseDwarfLineSection(Buffer.concat(Array(DWARF_LINE_MAX_UNITS + 1).fill(unsupportedUnit)), true),
            /more than.*units/i
        );

        const setAddress = [0, ...uleb(5), 2, ...uint32(0x08000100, true)];
        assert.throws(
            () => parseDwarfLineSection(buildLineUnit({
                program: [...setAddress, ...Array(DWARF_LINE_MAX_ROWS + 1).fill(1)],
            }), true),
            /more than.*rows/i
        );

        assert.throws(
            () => parseDwarfLineSection(buildLineUnit({
                files: Array.from({ length: DWARF_LINE_MAX_FILES + 1 }, () => ({
                    name: 'f', directoryIndex: 0,
                })),
                program: [],
            }), true),
            /more than.*files/i
        );

        assert.throws(
            () => parseDwarfLineSection(buildLineUnit({
                directories: Array(DWARF_LINE_MAX_DIRECTORIES + 1).fill('d'),
                files: [],
                program: [],
            }), true),
            /more than.*directories/i
        );

        assert.throws(
            () => parseDwarfLineSection(buildLineUnit({
                directories: ['s'.repeat(DWARF_LINE_MAX_STRING_BYTES + 1)],
                files: [],
                program: [],
            }), true),
            /string exceeds/i
        );

        assert.throws(
            () => parseDwarfLineSection(buildLineUnit({
                program: [...setAddress, 1, 2, ...Array(DWARF_LINE_MAX_LEB_BYTES).fill(0x80)],
            }), true),
            /ULEB128 value is too long/i
        );
    });

    test('end_sequence가 없는 마지막 sequence는 부분 범위를 남기지 않는다', () => {
        const unit = buildLineUnit();
        const withoutEnd = unit.subarray(0, unit.length - 3);
        const littleEndian = true;
        const bodyLength = withoutEnd.length - 4;
        littleEndian ? withoutEnd.writeUInt32LE(bodyLength, 0) : withoutEnd.writeUInt32BE(bodyLength, 0);
        const result = parseDwarfLineSection(withoutEnd, littleEndian);
        assert.deepStrictEqual(result.locations, []);
    });
});
