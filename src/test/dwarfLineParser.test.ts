import * as assert from 'assert';
import {
    DWARF_LINE_MAX_DIRECTORIES,
    DWARF_LINE_MAX_DECODED_PATH_BYTES,
    DWARF_LINE_MAX_ENTRY_FORMATS,
    DWARF_LINE_MAX_ENTRY_VALUES,
    DWARF_LINE_MAX_FILES,
    DWARF_LINE_MAX_LEB_BYTES,
    DWARF_LINE_MAX_ROWS,
    DWARF_LINE_MAX_SECTION_BYTES,
    DWARF_LINE_MAX_STRING_BYTES,
    DWARF_LINE_MAX_UNITS,
    findDwarfSourceLocation,
    parseDwarfLineSection,
} from '../dwarfLineParser';
import { buildDwarf5LineSections } from './fixtures/elfFixtures';

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

interface Dwarf5UnitOptions {
    littleEndian?: boolean;
    addressSize?: number;
    segmentSelectorSize?: number;
    directoryTable?: number[];
    fileTable?: number[];
    program?: number[];
}

function buildDwarf5Unit(options: Dwarf5UnitOptions = {}): Buffer {
    const littleEndian = options.littleEndian ?? true;
    const commonHeader = [
        1, // minimum_instruction_length
        1, // maximum_operations_per_instruction
        1, // default_is_stmt
        0xfb, // line_base = -5
        14, // line_range
        13, // opcode_base
        0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1,
    ];
    const directoryTable = options.directoryTable ?? [
        1, ...uleb(0x01), ...uleb(0x08), // path: DW_FORM_string
        ...uleb(1), ...cstring('/workspace/src'),
    ];
    const fileTable = options.fileTable ?? [
        2,
        ...uleb(0x01), ...uleb(0x08), // path: DW_FORM_string
        ...uleb(0x02), ...uleb(0x0f), // directory_index: DW_FORM_udata
        ...uleb(1), ...cstring('main.c'), ...uleb(0),
    ];
    const header = [...commonHeader, ...directoryTable, ...fileTable];
    const program = options.program ?? [
        4, ...uleb(0),
        0, ...uleb(5), 2, ...uint32(0x08000100, littleEndian),
        1,
        3, ...sleb(9),
        2, ...uleb(4),
        1,
        2, ...uleb(4),
        0, ...uleb(1), 1,
    ];
    const body = [
        ...uint16(5, littleEndian),
        options.addressSize ?? 4,
        options.segmentSelectorSize ?? 0,
        ...uint32(header.length, littleEndian),
        ...header,
        ...program,
    ];
    return Buffer.from([...uint32(body.length, littleEndian), ...body]);
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
        assert.deepStrictEqual(result.unsupportedFeatures, []);
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

    test('DWARF 5 line_strp·0-based 인덱스·MD5 descriptor를 해석한다', () => {
        const fixture = buildDwarf5LineSections('/workspace/src/main.c');
        const result = parseDwarfLineSection(fixture.debugLine, true, {
            debugLineStr: fixture.debugLineStr,
        });
        assert.strictEqual(result.parsedUnits, 1);
        assert.deepStrictEqual(result.unsupportedVersions, []);
        assert.deepStrictEqual(result.locations.map(location => ({
            start: location.address,
            end: location.endAddress,
            file: location.filePath,
            line: location.line,
        })), [
            { start: 0x08000000, end: 0x08000120, file: '/workspace/src/main.c', line: 1 },
            { start: 0x08000120, end: 0x080001a0, file: '/workspace/src/main.c', line: 10 },
            { start: 0x080001a0, end: 0x08000300, file: '/workspace/src/main.c', line: 20 },
        ]);
    });

    test('DWARF 5 inline path의 상대 include directory와 초기 file 1을 해석한다', () => {
        const unit = buildDwarf5Unit({
            directoryTable: [
                1, ...uleb(0x01), ...uleb(0x08),
                ...uleb(2), ...cstring('/build/project'), ...cstring('include'),
            ],
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x08),
                ...uleb(0x02), ...uleb(0x0b),
                ...uleb(2),
                ...cstring('root.c'), 0,
                ...cstring('header.h'), 1,
            ],
            program: [
                // DWARF 상태 머신의 초기 file=1은 0-based table의 두 번째 파일이다.
                0, ...uleb(5), 2, ...uint32(0x08000100, true),
                1,
                2, ...uleb(4),
                0, ...uleb(1), 1,
            ],
        });
        const result = parseDwarfLineSection(unit, true);
        assert.deepStrictEqual(result.locations.map(location => location.filePath), [
            '/build/project/include/header.h',
        ]);
    });

    test('DWARF 5 big-endian strp와 vendor descriptor를 경계 손상 없이 소비한다', () => {
        const debugStr = Buffer.from([...cstring('/be/src'), ...cstring('main.c')]);
        const bigEndian = buildDwarf5Unit({
            littleEndian: false,
            directoryTable: [
                1, ...uleb(0x01), ...uleb(0x0e),
                ...uleb(1), ...uint32(0, false),
            ],
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x0e),
                ...uleb(0x02), ...uleb(0x05),
                ...uleb(1), ...uint32(cstring('/be/src').length, false), ...uint16(0, false),
            ],
        });
        assert.strictEqual(
            parseDwarfLineSection(bigEndian, false, { debugStr }).locations[0].filePath,
            '/be/src/main.c'
        );

        const debugLineStr = Buffer.from(cstring('embedded source'));
        const withVendorField = buildDwarf5Unit({
            fileTable: [
                4,
                ...uleb(0x01), ...uleb(0x08),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(0x05), ...uleb(0x1e),
                ...uleb(0x2001), ...uleb(0x1f),
                ...uleb(1), ...cstring('main.c'), ...uleb(0), ...Array(16).fill(0), ...uint32(0, true),
            ],
        });
        assert.strictEqual(
            parseDwarfLineSection(withVendorField, true, { debugLineStr }).locations[0].filePath,
            '/workspace/src/main.c'
        );

        const withIndexedVendorFields = buildDwarf5Unit({
            fileTable: [
                7,
                ...uleb(0x01), ...uleb(0x08),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(0x2000), ...uleb(0x1a),
                ...uleb(0x2001), ...uleb(0x25),
                ...uleb(0x2002), ...uleb(0x26),
                ...uleb(0x2003), ...uleb(0x27),
                ...uleb(0x2004), ...uleb(0x28),
                ...uleb(1),
                ...cstring('main.c'), ...uleb(0),
                ...uleb(300), 1, ...uint16(2, true), 3, 0, 0, ...uint32(4, true),
            ],
        });
        assert.strictEqual(
            parseDwarfLineSection(withIndexedVendorFields, true).locations[0].filePath,
            '/workspace/src/main.c'
        );
    });

    test('DWARF 5 외부 문자열 section 누락·범위 초과·NUL 누락을 거부한다', () => {
        const fixture = buildDwarf5LineSections('/workspace/src/main.c');
        assert.throws(
            () => parseDwarfLineSection(fixture.debugLine, true),
            /missing.*debug_line_str/i
        );

        const outOfRange = buildDwarf5Unit({
            directoryTable: [
                1, ...uleb(0x01), ...uleb(0x1f),
                ...uleb(1), ...uint32(99, true),
            ],
        });
        assert.throws(
            () => parseDwarfLineSection(outOfRange, true, { debugLineStr: Buffer.from([0]) }),
            /offset is out of range/i
        );
        assert.throws(
            () => parseDwarfLineSection(outOfRange, true, { debugLineStr: Buffer.alloc(120, 0x61) }),
            /unterminated/i
        );
    });

    test('압축된 DWARF 5 문자열 section 참조는 손상이 아닌 미지원 형식으로 분류한다', () => {
        const lineStrFixture = buildDwarf5LineSections('/workspace/src/main.c');
        const compressedLineStr = parseDwarfLineSection(lineStrFixture.debugLine, true, {
            compressedDebugLineStr: true,
        });
        assert.deepStrictEqual(compressedLineStr.locations, []);
        assert.strictEqual(compressedLineStr.parsedUnits, 0);
        assert.deepStrictEqual(compressedLineStr.unsupportedFeatures, ['compressed-debug-line-str']);

        const strpUnit = buildDwarf5Unit({
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x0e),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(1), ...uint32(0, true), ...uleb(0),
            ],
        });
        const compressedStr = parseDwarfLineSection(strpUnit, true, {
            compressedDebugStr: true,
        });
        assert.deepStrictEqual(compressedStr.locations, []);
        assert.strictEqual(compressedStr.parsedUnits, 0);
        assert.deepStrictEqual(compressedStr.unsupportedFeatures, ['compressed-debug-str']);
    });

    test('DWARF 5 path의 strx 계열·strp_sup form은 유효한 미지원 형식으로 분류한다', () => {
        const cases = [
            { form: 0x1a, value: uleb(300), feature: 'indexed-path-forms' },
            { form: 0x25, value: [1], feature: 'indexed-path-forms' },
            { form: 0x26, value: uint16(2, true), feature: 'indexed-path-forms' },
            { form: 0x27, value: [3, 0, 0], feature: 'indexed-path-forms' },
            { form: 0x28, value: uint32(4, true), feature: 'indexed-path-forms' },
            { form: 0x1d, value: uint32(5, true), feature: 'supplementary-path-form' },
        ];
        for (const testCase of cases) {
            const unit = buildDwarf5Unit({
                fileTable: [
                    2,
                    ...uleb(0x01), ...uleb(testCase.form),
                    ...uleb(0x02), ...uleb(0x0f),
                    ...uleb(1), ...testCase.value, ...uleb(0),
                ],
            });
            const result = parseDwarfLineSection(unit, true);
            assert.deepStrictEqual(result.locations, []);
            assert.strictEqual(result.parsedUnits, 0);
            assert.deepStrictEqual(result.unsupportedFeatures, [testCase.feature]);
        }
    });

    test('DWARF 5 header의 주소 크기·segment selector·descriptor 계약을 검증한다', () => {
        assert.throws(() => parseDwarfLineSection(buildDwarf5Unit({ addressSize: 8 }), true), /address size 8/i);
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({ segmentSelectorSize: 1 }), true),
            /segmented addresses/i
        );
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [1, ...uleb(0x03), ...uleb(0x0f), ...uleb(1), ...uleb(0)],
            }), true),
            /exactly one path/i
        );
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [
                    2,
                    ...uleb(0x01), ...uleb(0x08),
                    ...uleb(0x01), ...uleb(0x08),
                    ...uleb(1), ...cstring('first'), ...cstring('second'),
                ],
            }), true),
            /exactly one path/i
        );
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [1, ...uleb(0x01), ...uleb(0x0b), ...uleb(0)],
            }), true),
            /invalid form/i
        );
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [1, ...uleb(0x06), ...uleb(0x0b), ...uleb(0)],
            }), true),
            /unsupported content type/i
        );
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [0, ...uleb(1)],
            }), true),
            /entries without a format/i
        );
    });

    test('DWARF 5의 entry가 없으면 descriptor의 path 유무와 관계없이 허용한다', () => {
        const result = parseDwarfLineSection(buildDwarf5Unit({
            directoryTable: [1, ...uleb(0x03), ...uleb(0x0f), ...uleb(0)],
            fileTable: [0, ...uleb(0)],
            program: [],
        }), true);
        assert.strictEqual(result.parsedUnits, 1);
        assert.deepStrictEqual(result.locations, []);
    });

    test('DWARF 5의 format 수와 decoded entry 값 한도를 선할당 전에 강제한다', () => {
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [DWARF_LINE_MAX_ENTRY_FORMATS + 1],
            }), true),
            /more than.*formats/i
        );

        const descriptors = [
            ...uleb(0x01), ...uleb(0x08),
            ...Array.from({ length: 10 }, (_value, index) => [
                ...uleb(0x2000 + index), ...uleb(0x0b),
            ]).flat(),
        ];
        const fileCount = Math.floor(DWARF_LINE_MAX_ENTRY_VALUES / 11) + 1;
        assert.ok(fileCount <= DWARF_LINE_MAX_FILES);
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                fileTable: [11, ...descriptors, ...uleb(fileCount)],
            }), true),
            /entry values/i
        );

        const longPath = Buffer.from([...Buffer.alloc(DWARF_LINE_MAX_STRING_BYTES, 0x61), 0]);
        const repeatedPathCount = Math.floor(DWARF_LINE_MAX_DECODED_PATH_BYTES / DWARF_LINE_MAX_STRING_BYTES);
        assert.throws(
            () => parseDwarfLineSection(buildDwarf5Unit({
                directoryTable: [
                    1, ...uleb(0x01), ...uleb(0x1f),
                    ...uleb(1), ...uint32(0, true),
                ],
                fileTable: [
                    1, ...uleb(0x01), ...uleb(0x1f),
                    ...uleb(repeatedPathCount),
                    ...Array.from({ length: repeatedPathCount }, () => uint32(0, true)).flat(),
                ],
                program: [],
            }), true, { debugLineStr: longPath }),
            /path bytes/i
        );
    });

    test('DWARF 5 directory index가 범위를 벗어난 행은 basename으로 강등하지 않는다', () => {
        const unit = buildDwarf5Unit({
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x08),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(2),
                ...cstring('main.c'), ...uleb(1),
                ...cstring('util.c'), ...uleb(0),
            ],
            program: [
                4, ...uleb(0),
                0, ...uleb(5), 2, ...uint32(0x08000100, true),
                1,
                4, ...uleb(1),
                2, ...uleb(4),
                1,
                2, ...uleb(4),
                0, ...uleb(1), 1,
            ],
        });
        const result = parseDwarfLineSection(unit, true);
        assert.deepStrictEqual(result.locations.map(location => location.filePath), [
            '/workspace/src/util.c',
        ]);
    });

    test('DWARF 5의 호환 DW_LNE_define_file은 0-based file table에 추가된다', () => {
        const definedFilePayload = [
            3,
            ...cstring('generated.c'), ...uleb(0), ...uleb(0), ...uleb(0),
        ];
        const unit = buildDwarf5Unit({
            program: [
                4, ...uleb(1),
                0, ...uleb(5), 2, ...uint32(0x08000100, true),
                1,
                2, ...uleb(4),
                1, // 아직 없는 file 1을 undefined로 캐시
                0, ...uleb(definedFilePayload.length), ...definedFilePayload,
                2, ...uleb(4),
                1,
                2, ...uleb(4),
                0, ...uleb(1), 1,
            ],
        });
        const result = parseDwarfLineSection(unit, true);
        assert.deepStrictEqual(result.locations.map(location => ({
            address: location.address,
            filePath: location.filePath,
        })), [
            { address: 0x08000104, filePath: '/workspace/src/generated.c' },
            { address: 0x08000108, filePath: '/workspace/src/generated.c' },
        ]);
    });

    test('지원하지 않는 unit은 다음 지원 unit을 막지 않는다', () => {
        const dwarf64Length = Buffer.alloc(8);
        dwarf64Length.writeBigUInt64LE(1n);
        const dwarf64 = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), dwarf64Length, Buffer.from([0])]);
        const unsupportedBody = Buffer.from([...uint16(6, true)]);
        const unsupported = Buffer.from([...uint32(unsupportedBody.length, true), ...unsupportedBody]);
        const indexedPath = buildDwarf5Unit({
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x25),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(1), 0, ...uleb(0),
            ],
        });
        const supplementaryPath = buildDwarf5Unit({
            fileTable: [
                2,
                ...uleb(0x01), ...uleb(0x1d),
                ...uleb(0x02), ...uleb(0x0f),
                ...uleb(1), ...uint32(0, true), ...uleb(0),
            ],
        });
        const v5 = buildDwarf5LineSections('/workspace/src/v5.c');
        const result = parseDwarfLineSection(
            Buffer.concat([
                dwarf64,
                unsupported,
                indexedPath,
                supplementaryPath,
                v5.debugLine,
                buildLineUnit(),
            ]),
            true,
            { debugLineStr: v5.debugLineStr }
        );
        assert.deepStrictEqual(result.unsupportedVersions, [6]);
        assert.deepStrictEqual(result.unsupportedFeatures, [
            'indexed-path-forms',
            'supplementary-path-form',
        ]);
        assert.strictEqual(result.skippedDwarf64Units, 1);
        assert.strictEqual(result.parsedUnits, 2);
        assert.strictEqual(result.locations.length, 6);
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

    test('DW_LNE_define_file은 이전의 미해결 file index 경로 캐시를 무효화한다', () => {
        const definedFilePayload = [
            3, // DW_LNE_define_file
            ...cstring('generated.c'), ...uleb(1), ...uleb(0), ...uleb(0),
        ];
        const result = parseDwarfLineSection(buildLineUnit({
            program: [
                0, ...uleb(5), 2, ...uint32(0x08000100, true),
                4, ...uleb(3),
                1,
                2, ...uleb(4),
                1, // 아직 없는 file 3을 한 번 해석해 undefined로 캐시
                0, ...uleb(definedFilePayload.length), ...definedFilePayload,
                2, ...uleb(4),
                1,
                2, ...uleb(4),
                0, ...uleb(1), 1,
            ],
        }), true);
        assert.deepStrictEqual(result.locations.map(location => ({
            address: location.address,
            filePath: location.filePath,
        })), [
            { address: 0x08000104, filePath: '/workspace/src/generated.c' },
            { address: 0x08000108, filePath: '/workspace/src/generated.c' },
        ]);
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
        const unsupportedUnit = Buffer.from([...uint32(2, true), ...uint16(6, true)]);
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
