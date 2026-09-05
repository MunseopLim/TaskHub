import * as assert from 'assert';
import { StructSizeCalculator, TypeConfigFile, StructSizeResult } from '../structSizeCalculator';

suite('StructSizeCalculator Test Suite', () => {
    let calculator: StructSizeCalculator;

    setup(() => {
        calculator = new StructSizeCalculator();
    });

    suite('Basic Struct Size Calculation', () => {
        test('Calculate size of simple struct with same-size members', () => {
            const lines = [
                'struct SimpleStruct {',
                '    int a;',
                '    int b;',
                '    int c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'SimpleStruct');
            const result = calculator.calculateStructSize('SimpleStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.strictEqual(result.totalSize, 12); // 3 * 4 bytes
            assert.strictEqual(result.alignment, 4);
        });

        test('Calculate size with different sized members', () => {
            const lines = [
                'struct MixedStruct {',
                '    char a;',
                '    int b;',
                '    char c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'MixedStruct');
            const result = calculator.calculateStructSize('MixedStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);

            // Layout: char(1) + padding(3) + int(4) + char(1) + padding(3) = 12
            assert.strictEqual(result.totalSize, 12);
            assert.strictEqual(result.members[0].offset, 0); // char a at 0
            assert.strictEqual(result.members[1].offset, 4); // int b at 4 (aligned)
            assert.strictEqual(result.members[2].offset, 8); // char c at 8
        });

        test('Calculate size with natural alignment', () => {
            const lines = [
                'struct AlignedStruct {',
                '    char a;',
                '    short b;',
                '    int c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'AlignedStruct');
            const result = calculator.calculateStructSize('AlignedStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: char(1) + padding(1) + short(2) + int(4) = 8
            assert.strictEqual(result.totalSize, 8);
            assert.strictEqual(result.members[0].offset, 0); // char at 0
            assert.strictEqual(result.members[1].offset, 2); // short at 2
            assert.strictEqual(result.members[2].offset, 4); // int at 4
        });
    });

    suite('Array Members', () => {
        test('Calculate size with array member', () => {
            const lines = [
                'struct ArrayStruct {',
                '    int values[10];',
                '    char flag;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'ArrayStruct');
            const result = calculator.calculateStructSize('ArrayStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 2);
            assert.strictEqual(result.members[0].size, 40); // 10 * 4 bytes
            assert.strictEqual(result.members[0].isArray, true);
            assert.strictEqual(result.members[0].arraySize, 10);
            // Total: int[10](40) + char(1) + padding(3) = 44
            assert.strictEqual(result.totalSize, 44);
        });

        test('Calculate size with char array', () => {
            const lines = [
                'struct CharArrayStruct {',
                '    char name[16];',
                '    int id;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'CharArrayStruct');
            const result = calculator.calculateStructSize('CharArrayStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: char[16](16) + int(4) = 20
            assert.strictEqual(result.totalSize, 20);
            assert.strictEqual(result.members[0].offset, 0);
            assert.strictEqual(result.members[1].offset, 16);
        });
    });

    suite('C aggregate edge cases', () => {
        test('Calculate size with packed bit fields', () => {
            const lines = [
                'struct BitFields {',
                '    uint32_t flags : 3;',
                '    uint32_t mode : 5;',
                '    uint8_t tail;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'BitFields');
            const result = calculator.calculateStructSize('BitFields', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.strictEqual(result.members[0].offset, 0);
            assert.strictEqual(result.members[1].offset, 0);
            assert.strictEqual(result.members[2].offset, 4);
            assert.strictEqual(result.totalSize, 8);
        });

        test('Zero-width anonymous bit fields force a new storage unit', () => {
            const lines = [
                'struct ZeroWidthBitFields {',
                '    uint32_t flags : 3;',
                '    uint32_t : 0;',
                '    uint32_t mode : 4;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'ZeroWidthBitFields');
            const result = calculator.calculateStructSize('ZeroWidthBitFields', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.strictEqual(result.members[0].offset, 0);
            assert.strictEqual(result.members[1].offset, 4);
            assert.strictEqual(result.members[1].size, 0);
            assert.strictEqual(result.members[2].offset, 4);
            assert.strictEqual(result.totalSize, 8);
        });

        test('Zero-width anonymous bit fields work inside comma declarators', () => {
            const lines = [
                'struct CommaZeroWidthBitFields {',
                '    uint32_t flags : 3, : 0, mode : 4;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'CommaZeroWidthBitFields');
            const result = calculator.calculateStructSize('CommaZeroWidthBitFields', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(m => m.offset), [0, 4, 4]);
            assert.strictEqual(result.totalSize, 8);
        });

        test('Calculate union size as the max member size', () => {
            const lines = [
                'union Value {',
                '    uint32_t word;',
                '    uint8_t bytes[4];',
                '    uint16_t half;',
                '};'
            ];

            const unionLine = StructSizeCalculator.findStructDefinition(lines, 'Value');
            const result = calculator.calculateStructSize('Value', lines, unionLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalSize, 4);
            assert.strictEqual(result.alignment, 4);
            assert.deepStrictEqual(result.members.map(m => m.offset), [0, 0, 0]);
        });

        test('Calculate size with anonymous nested union member', () => {
            const lines = [
                'struct Packet {',
                '    uint8_t tag;',
                '    union {',
                '        uint32_t word;',
                '        uint8_t bytes[4];',
                '    } payload;',
                '    uint16_t crc;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Packet');
            const result = calculator.calculateStructSize('Packet', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.strictEqual(result.members[1].name, 'payload');
            assert.strictEqual(result.members[1].offset, 4);
            assert.strictEqual(result.members[1].size, 4);
            assert.strictEqual(result.members[2].offset, 8);
            assert.strictEqual(result.totalSize, 12);
        });

        test('Parse one-line multiple declarators', () => {
            const lines = [
                'struct MultiDecl {',
                '    int a, b;',
                '    char c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'MultiDecl');
            const result = calculator.calculateStructSize('MultiDecl', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(m => m.name), ['a', 'b', 'c']);
            assert.strictEqual(result.totalSize, 12);
        });

        test('Anonymous (unnamed) nested struct member is laid out as a sub-object', () => {
            // C11 anonymous struct: gcc/clang sizeof === 12 (sub-object block),
            // not 8. Regression guard — the block must not be dropped.
            const lines = [
                'struct AnonStruct {',
                '    uint32_t x;',
                '    struct {',
                '        uint16_t a;',
                '        uint16_t b;',
                '    };',
                '    uint32_t y;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'AnonStruct');
            const result = calculator.calculateStructSize('AnonStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.deepStrictEqual(result.members.map(m => m.offset), [0, 4, 8]);
            assert.strictEqual(result.members[1].size, 4);
            assert.strictEqual(result.totalSize, 12);
        });

        test('Anonymous (unnamed) nested union member overlaps, not concatenates', () => {
            const lines = [
                'struct AnonUnion {',
                '    uint8_t tag;',
                '    union {',
                '        uint32_t w;',
                '        uint8_t bytes[4];',
                '    };',
                '    uint16_t c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'AnonUnion');
            const result = calculator.calculateStructSize('AnonUnion', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 3);
            assert.deepStrictEqual(result.members.map(m => m.offset), [0, 4, 8]);
            assert.strictEqual(result.members[1].size, 4);
            assert.strictEqual(result.totalSize, 12);
        });

        test('Hexadecimal array sizes are parsed', () => {
            const lines = [
                'struct HexArray {',
                '    uint8_t buf[0x100];',
                '    uint32_t len;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'HexArray');
            const result = calculator.calculateStructSize('HexArray', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].arraySize, 0x100);
            assert.strictEqual(result.members[0].size, 0x100);
            assert.strictEqual(result.members[1].offset, 0x100);
            assert.strictEqual(result.totalSize, 0x104);
        });

        test('Hexadecimal array size works in a multi-declarator line', () => {
            const lines = [
                'struct HexMulti {',
                '    int a[0x10], b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'HexMulti');
            const result = calculator.calculateStructSize('HexMulti', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(m => m.name), ['a', 'b']);
            assert.strictEqual(result.members[0].arraySize, 16);
            assert.strictEqual(result.members[1].offset, 64);
            assert.strictEqual(result.totalSize, 68);
        });
    });

    suite('Padding Calculation', () => {
        test('Calculate padding for struct alignment', () => {
            const lines = [
                'struct PaddedStruct {',
                '    char a;',
                '    int b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PaddedStruct');
            const result = calculator.calculateStructSize('PaddedStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: char(1) + padding(3) + int(4) = 8
            assert.strictEqual(result.totalSize, 8);
            assert.strictEqual(result.padding, 3); // 3 bytes of padding
        });

        test('Calculate trailing padding', () => {
            const lines = [
                'struct TrailingPadding {',
                '    int a;',
                '    char b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'TrailingPadding');
            const result = calculator.calculateStructSize('TrailingPadding', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: int(4) + char(1) + padding(3) = 8
            assert.strictEqual(result.totalSize, 8);
            assert.strictEqual(result.padding, 3); // 3 bytes trailing padding
        });

        test('No padding needed for aligned members', () => {
            const lines = [
                'struct NoPadding {',
                '    int a;',
                '    int b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'NoPadding');
            const result = calculator.calculateStructSize('NoPadding', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalSize, 8);
            assert.strictEqual(result.padding, 0); // No padding needed
        });
    });

    suite('Pointer Members', () => {
        test('Calculate size with pointer members', () => {
            const lines = [
                'struct PointerStruct {',
                '    int* ptr1;',
                '    char* ptr2;',
                '    void* ptr3;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PointerStruct');
            const result = calculator.calculateStructSize('PointerStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalSize, 12); // 3 * 4 bytes (32-bit pointers)
            assert.strictEqual(result.members[0].size, 4);
            assert.strictEqual(result.members[1].size, 4);
            assert.strictEqual(result.members[2].size, 4);
        });

        test('Calculate size with space-before-asterisk pointer style', () => {
            const lines = [
                'struct PtrStyles {',
                '    char *ptr1;',
                '    int *ptr2;',
                '    char * ptr3;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PtrStyles');
            const result = calculator.calculateStructSize('PtrStyles', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalSize, 12);
            assert.strictEqual(result.members.length, 3);
            assert.strictEqual(result.members[0].size, 4);
            assert.strictEqual(result.members[1].size, 4);
            assert.strictEqual(result.members[2].size, 4);
        });
    });

    suite('Type Qualifiers', () => {
        test('Handle const qualifier', () => {
            const lines = [
                'struct ConstStruct {',
                '    const int a;',
                '    volatile int b;',
                '    static int c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'ConstStruct');
            const result = calculator.calculateStructSize('ConstStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(member => member.name), ['a', 'b']);
            assert.strictEqual(result.totalSize, 8); // static storage is outside each instance
        });
    });

    suite('C++ declarations and unsupported layouts', () => {
        test('brace and equals initializers preserve all instance members', () => {
            const result = calculator.calculateStructSize('Initialized', [
                'struct Initialized {',
                '    int x{}, second = (1 + 2);',
                "    char text[3] = {'a', ',', '}'};",
                '    char y;',
                '};'
            ], 0);
            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(member => [member.name, member.offset]), [
                ['x', 0], ['second', 4], ['text', 8], ['y', 11]
            ]);
            assert.strictEqual(result.totalSize, 12);
        });

        test('review reproduction counts brace initialization and excludes static storage', () => {
            const initialized = calculator.calculateStructSize('S', ['struct S { int x{}; char y; };'], 0);
            assert.strictEqual(initialized.success, true);
            assert.strictEqual(initialized.totalSize, 8);
            const statics = calculator.calculateStructSize('S', ['struct S { static int x; const static int z = 3; char y; };'], 0);
            assert.strictEqual(statics.success, true);
            assert.deepStrictEqual(statics.members.map(member => member.name), ['y']);
            assert.strictEqual(statics.totalSize, 1);
        });

        for (const declaration of [
            'struct S { alignas(16) int x; char y; };',
            'struct alignas(16) S { int x; char y; };',
            'struct S { int x; char y; } __attribute__((packed));',
            'struct S { const char *url = "http://host"; char y; } __attribute__((packed));',
            'class S : public Base { int x; };',
            'class S { virtual void method(); int x; };',
            'struct S { [[no_unique_address]] Empty value; int x; };',
            'struct S { struct { Unknown value; } nested; int x; };',
        ]) {
            test(`does not certify an unsupported layout: ${declaration}`, () => {
                const result = calculator.calculateStructSize('S', [declaration], 0);
                assert.strictEqual(result.success, false);
                assert.ok(result.error);
            });
        }

        test('data after access labels and inline methods is retained', () => {
            const result = calculator.calculateStructSize('S', [
                'class S { public: void method() {} int x; private: char y; };'
            ], 0);
            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(result.members.map(member => member.name), ['x', 'y']);
            assert.strictEqual(result.totalSize, 8);
        });

        test('nested type declaration without an instance contributes no storage', () => {
            const result = calculator.calculateStructSize('S', [
                'struct S { struct Inner { int x; }; char y; };'
            ], 0);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.totalSize, 1);
        });

        test('failed custom type registration remains unresolved in its parent', () => {
            const failed = calculator.calculateStructSize('Inner', ['struct Inner { Unknown x; };'], 0);
            assert.strictEqual(failed.success, false);
            calculator.registerCustomType(failed);
            const parent = calculator.calculateStructSize('Outer', ['struct Outer { Inner value; char y; };'], 0);
            assert.strictEqual(parent.success, false);
        });

        for (const method of [
            'static inline int method() { return 1; }',
            'void method() {} public:',
            'void method() { const char *message = "virtual # alignas"; }',
        ]) {
            test(`inline method preserves following instance members: ${method}`, () => {
                const result = calculator.calculateStructSize('S', [`class S { ${method} int x; char y; };`], 0);
                assert.strictEqual(result.success, true);
                assert.deepStrictEqual(result.members.map(member => member.name), ['x', 'y']);
                assert.strictEqual(result.totalSize, 8);
            });
        }

        for (const value of ['virtual', '#', 'alignas(16)', '__attribute__((packed))']) {
            test(`initializer text does not become layout syntax: ${value}`, () => {
                const result = calculator.calculateStructSize('S', [`struct S { const char *text = "${value}"; int x; };`], 0);
                assert.strictEqual(result.success, true);
                assert.deepStrictEqual(result.members.map(member => member.name), ['text', 'x']);
                assert.strictEqual(result.totalSize, 8);
            });
        }

        for (const directives of [
            ['#pragma pack(push, 1)', '#pragma pack(pop)'],
            ['#pragma pack(1)', '#pragma pack()'],
            ['#pragma pack(push, first, 1)', '#pragma pack(push, second, 2)', '#pragma pack(pop, first)'],
            ['/*', '#pragma pack(1)', '*/'],
        ]) {
            test(`restored or commented packing does not reject later structs: ${directives.join(' ')}`, () => {
                const lines = [...directives, 'struct S { char x; int y; };'];
                const result = calculator.calculateStructSize('S', lines, directives.length);
                assert.strictEqual(result.success, true);
                assert.strictEqual(result.totalSize, 8);
            });
        }

        test('an outer active packing directive remains active after an inner pop', () => {
            const lines = ['#pragma pack(1)', '#pragma pack(push, 2)', '#pragma pack(pop)', 'struct S { char x; int y; };'];
            assert.strictEqual(calculator.calculateStructSize('S', lines, 3).success, false);
        });

        test('source pragma packing is rejected instead of using natural alignment', () => {
            const result = calculator.calculateStructSize('S', ['#pragma pack(push, 1)', 'struct S { char y; int x; };'], 1);
            assert.strictEqual(result.success, false);
        });
    });

    suite('Document scan bounds and invalidation', () => {
        test('three passes over a frozen document inspect a linear number of source lines', () => {
            const lines: string[] = [];
            const starts: number[] = [];
            for (let index = 0; index < 80; index++) {
                starts.push(lines.length);
                lines.push(`struct Sample${index} {`, ...Array.from({ length: 38 }, (_, member) => `int member${member};`), '};', '');
            }
            Object.freeze(lines);
            let inspectedLines = 0;
            const source = new Proxy(lines, {
                get(target, property, receiver) {
                    if (typeof property === 'string' && /^\d+$/.test(property)) { inspectedLines++; }
                    return Reflect.get(target, property, receiver);
                }
            });
            for (let pass = 0; pass < 3; pass++) {
                const current = new StructSizeCalculator();
                for (const [index, start] of starts.entries()) {
                    const result = current.calculateStructSize(`Sample${index}`, source, start);
                    assert.strictEqual(result.success, true);
                    assert.strictEqual(result.totalSize, 38 * 4);
                }
            }
            assert.ok(inspectedLines <= lines.length * 5,
                `expected one packing pass and bounded aggregate scans, got ${inspectedLines} reads for ${lines.length} lines`);
        });

        test('packing metadata is shared only for immutable snapshots and honors replacements', () => {
            const packed = ['#pragma pack(1)', 'struct S { char first; int last; };'];
            Object.freeze(packed);
            assert.strictEqual(calculator.calculateStructSize('S', packed, 1).success, false);
            const natural = ['#pragma pack()', packed[1]];
            Object.freeze(natural);
            assert.strictEqual(calculator.calculateStructSize('S', natural, 1).totalSize, 8);
            assert.strictEqual(calculator.calculateStructSize('S', natural, 1).success, true);
            const mutable = [...packed];
            assert.strictEqual(calculator.calculateStructSize('S', mutable, 1).success, false);
            mutable[0] = '#pragma pack()';
            assert.strictEqual(calculator.calculateStructSize('S', mutable, 1).success, true);
        });

        test('continued pragma directives preserve physical-line packing state', () => {
            const slash = String.fromCharCode(92);
            const lines = [`#pragma pack(push, ${slash}`, '1)', 'struct Packed { char first; int last; };',
                `#pragma pack(${slash}`, 'pop)', 'struct Natural { char first; int last; };'];
            Object.freeze(lines);
            assert.strictEqual(calculator.calculateStructSize('Packed', lines, 2).success, false);
            assert.strictEqual(calculator.calculateStructSize('Natural', lines, 5).success, true);
        });

        test('multiline trailing attributes are checked without scanning the next declaration', () => {
            const result = calculator.calculateStructSize('S', [
                'struct S {', '    int x;', '    char y;', '}',
                '    /* layout attribute on the next line */',
                '    __attribute__((packed));',
                'struct Next { int ignored; };'
            ], 0);
            assert.strictEqual(result.success, false);
            const natural = calculator.calculateStructSize('S', [
                'struct S { const char *url = "http://host"; int x; };',
                'struct alignas(16) Next { int ignored; };'
            ], 0);
            assert.strictEqual(natural.success, true);
            assert.strictEqual(natural.totalSize, 8);
        });

        test('struct lookup treats caller-supplied names as literal text', () => {
            const lines = ['struct Normal { int x; };'];
            for (const name of ['[', '(', 'Normal|Other', '.*']) {
                assert.doesNotThrow(() => StructSizeCalculator.findStructDefinition(lines, name));
                assert.strictEqual(StructSizeCalculator.findStructDefinition(lines, name), -1);
            }
            assert.strictEqual(StructSizeCalculator.findStructDefinition(lines, 'Normal'), 0);
        });

        test('objects initialized after the type definition do not change its layout or scan boundary', () => {
            for (const suffix of ['s{1}', 's = {1}', 's[] = {{1}, {2}}',
                's{[]() { const char *text = "virtual; }"; return 1; }()}']) {
                const result = calculator.calculateStructSize('S', [
                    `struct S { int x; } ${suffix};`,
                    'struct Next { int ignored; } __attribute__((packed));'
                ], 0);
                assert.strictEqual(result.success, true, suffix);
                assert.strictEqual(result.totalSize, 4, suffix);
                assert.deepStrictEqual(result.members.map(member => member.name), ['x']);
            }
            assert.strictEqual(calculator.calculateStructSize('S', ['struct S { int x; } s{1;'], 0).success, false);
            assert.strictEqual(calculator.calculateStructSize('S', ['struct S { int x; } __attribute__((packed)) s{1};'], 0).success, false);
        });
    });

    suite('Custom Type Configuration', () => {
        test('Use custom type sizes', () => {
            const customConfig: TypeConfigFile = {
                types: {
                    'int': { size: 2, alignment: 2 },  // 16-bit int
                    'char': { size: 1, alignment: 1 },
                    'pointer': { size: 2, alignment: 2 }  // 16-bit pointers
                },
                packingAlignment: 2
            };

            const customCalc = new StructSizeCalculator(customConfig);

            const lines = [
                'struct CustomSizeStruct {',
                '    int a;',
                '    char b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'CustomSizeStruct');
            const result = customCalc.calculateStructSize('CustomSizeStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout with 16-bit int: int(2) + char(1) + padding(1) = 4
            assert.strictEqual(result.totalSize, 4);
        });

        test('Use custom packing alignment', () => {
            const customConfig: TypeConfigFile = {
                types: {
                    'int': { size: 4, alignment: 4 },
                    'char': { size: 1, alignment: 1 }
                },
                packingAlignment: 1  // Pack to 1-byte boundary
            };

            const customCalc = new StructSizeCalculator(customConfig);

            const lines = [
                'struct PackedStruct {',
                '    char a;',
                '    int b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PackedStruct');
            const result = customCalc.calculateStructSize('PackedStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // With packing=1: char(1) + int(4) = 5 (no padding)
            assert.strictEqual(result.totalSize, 5);
            assert.strictEqual(result.padding, 0);
        });
    });

    suite('Nested Structs', () => {
        test('Calculate size with nested custom type', () => {
            const innerLines = [
                'struct InnerStruct {',
                '    int a;',
                '    char b;',
                '};'
            ];

            const innerLine = StructSizeCalculator.findStructDefinition(innerLines, 'InnerStruct');
            const innerResult = calculator.calculateStructSize('InnerStruct', innerLines, innerLine);
            calculator.registerCustomType(innerResult);

            const outerLines = [
                'struct OuterStruct {',
                '    InnerStruct inner;',
                '    int c;',
                '};'
            ];

            const outerLine = StructSizeCalculator.findStructDefinition(outerLines, 'OuterStruct');
            const outerResult = calculator.calculateStructSize('OuterStruct', outerLines, outerLine);

            assert.strictEqual(outerResult.success, true);
            // InnerStruct is 8 bytes, int is 4 bytes
            assert.strictEqual(outerResult.totalSize, 12);
        });

        test('Calculate size with multiple nested types', () => {
            // First struct
            const type1Lines = [
                'struct Type1 {',
                '    char a;',
                '    char b;',
                '};'
            ];
            const type1Line = StructSizeCalculator.findStructDefinition(type1Lines, 'Type1');
            const type1Result = calculator.calculateStructSize('Type1', type1Lines, type1Line);
            calculator.registerCustomType(type1Result);

            // Second struct using Type1
            const type2Lines = [
                'struct Type2 {',
                '    Type1 t1;',
                '    int value;',
                '};'
            ];
            const type2Line = StructSizeCalculator.findStructDefinition(type2Lines, 'Type2');
            const type2Result = calculator.calculateStructSize('Type2', type2Lines, type2Line);
            calculator.registerCustomType(type2Result);

            // Third struct using Type2
            const type3Lines = [
                'struct Type3 {',
                '    Type2 t2;',
                '    char flag;',
                '};'
            ];
            const type3Line = StructSizeCalculator.findStructDefinition(type3Lines, 'Type3');
            const type3Result = calculator.calculateStructSize('Type3', type3Lines, type3Line);

            assert.strictEqual(type3Result.success, true);
            // Type1: 2 bytes, Type2: 8 bytes (Type1(2) + padding(2) + int(4))
            // Type3: Type2(8) + char(1) + padding(3) = 12
            assert.strictEqual(type3Result.totalSize, 12);
        });
    });

    suite('Edge Cases', () => {
        test('Empty struct', () => {
            const lines = [
                'struct EmptyStruct {',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'EmptyStruct');
            const result = calculator.calculateStructSize('EmptyStruct', lines, structLine);

            assert.strictEqual(result.success, false);
            assert.ok(result.error);
        });

        test('Find struct by name', () => {
            const lines = [
                'int x = 5;',
                'struct FirstStruct {',
                '    int a;',
                '};',
                'struct SecondStruct {',
                '    int b;',
                '};'
            ];

            const first = StructSizeCalculator.findStructDefinition(lines, 'FirstStruct');
            assert.strictEqual(first, 1);

            const second = StructSizeCalculator.findStructDefinition(lines, 'SecondStruct');
            assert.strictEqual(second, 4);

            const notFound = StructSizeCalculator.findStructDefinition(lines, 'NonExistent');
            assert.strictEqual(notFound, -1);
        });

        test('Find class definition', () => {
            const lines = [
                'class MyClass {',
                '    int value;',
                '};'
            ];

            const classLine = StructSizeCalculator.findStructDefinition(lines, 'MyClass');
            assert.strictEqual(classLine, 0);
        });
    });

    suite('Multi-dim Arrays & Unparsed Declarations (M4 회귀 가드)', () => {
        // 이전 구현은 다차원 배열·매크로 차원·함수 포인터 선언이 정규식에
        // 매칭되지 않으면 문장 전체를 조용히 누락하고 success: true 로
        // 보고해 사용자가 잘못된 sizeof를 신뢰하게 했다.

        test('multi-dimensional array uses the dimension product', () => {
            const lines = [
                'struct Matrix {',
                '    int matrix[2][3];',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Matrix');
            const result = calculator.calculateStructSize('Matrix', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 1);
            assert.strictEqual(result.members[0].arraySize, 6);
            assert.strictEqual(result.totalSize, 24); // 2 * 3 * 4 bytes
        });

        test('3-D array with hex dimension', () => {
            const lines = [
                'struct Cube {',
                '    uint8_t c[2][0x10][4];',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Cube');
            const result = calculator.calculateStructSize('Cube', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].arraySize, 2 * 16 * 4);
            assert.strictEqual(result.totalSize, 128);
        });

        test('identifier (macro) array dimension fails explicitly instead of silently dropping', () => {
            const lines = [
                'struct Buf {',
                '    uint32_t header;',
                '    uint8_t buf[SIZE];',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Buf');
            const result = calculator.calculateStructSize('Buf', lines, structLine);

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('buf[SIZE]'), `error should name the unparsed declaration: ${result.error}`);
            // 부분 결과는 유지된다 — 파싱된 멤버는 그대로 보고
            assert.ok(result.members.some(m => m.name === 'header'));
        });

        test('function pointer member is sized as a pointer', () => {
            const lines = [
                'struct Callbacks {',
                '    void (*cb)(int);',
                '    int id;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Callbacks');
            const result = calculator.calculateStructSize('Callbacks', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 2);
            assert.strictEqual(result.members[0].name, 'cb');
            assert.strictEqual(result.members[0].size, 4); // 기본 설정 pointer = 4 bytes
            assert.strictEqual(result.totalSize, 8);
        });

        test('array of function pointers multiplies by element count', () => {
            const lines = [
                'struct Table {',
                '    void (*cbs[4])(int, char);',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Table');
            const result = calculator.calculateStructSize('Table', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].arraySize, 4);
            assert.strictEqual(result.totalSize, 16);
        });

        test('C++ method declarations do not trigger unparsed failure', () => {
            const lines = [
                'class Widget {',
                '    int value;',
                '    void method();',
                '    int compute(int x) const;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'Widget');
            const result = calculator.calculateStructSize('Widget', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members.length, 1);
            assert.strictEqual(result.totalSize, 4);
        });
    });

    suite('Windows Types', () => {
        test('Calculate size with UINT8 and UINT16', () => {
            const lines = [
                'struct WinTypesSmall {',
                '    UINT8 a;',
                '    UINT16 b;',
                '    UINT8 c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'WinTypesSmall');
            const result = calculator.calculateStructSize('WinTypesSmall', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: UINT8(1) + padding(1) + UINT16(2) + UINT8(1) + padding(1) = 6
            assert.strictEqual(result.members[0].size, 1); // UINT8
            assert.strictEqual(result.members[1].size, 2); // UINT16
            assert.strictEqual(result.members[2].size, 1); // UINT8
            assert.strictEqual(result.totalSize, 6);
        });

        test('Calculate size with UINT32 and UINT64', () => {
            const lines = [
                'struct WinTypesLarge {',
                '    UINT32 a;',
                '    UINT64 b;',
                '    UINT32 c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'WinTypesLarge');
            const result = calculator.calculateStructSize('WinTypesLarge', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: UINT32(4) + padding(4) + UINT64(8) + UINT32(4) + padding(4) = 24
            assert.strictEqual(result.members[0].size, 4);  // UINT32
            assert.strictEqual(result.members[1].size, 8);  // UINT64
            assert.strictEqual(result.members[2].size, 4);  // UINT32
            assert.strictEqual(result.totalSize, 24);
        });

        test('Calculate size with DWORD and QWORD', () => {
            const lines = [
                'struct DwordQword {',
                '    DWORD a;',
                '    QWORD b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'DwordQword');
            const result = calculator.calculateStructSize('DwordQword', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: DWORD(4) + padding(4) + QWORD(8) = 16
            assert.strictEqual(result.members[0].size, 4);  // DWORD
            assert.strictEqual(result.members[1].size, 8);  // QWORD
            assert.strictEqual(result.totalSize, 16);
        });

        test('Calculate size with BYTE, WORD, DWORD', () => {
            const lines = [
                'struct ByteWordDword {',
                '    BYTE a;',
                '    WORD b;',
                '    DWORD c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'ByteWordDword');
            const result = calculator.calculateStructSize('ByteWordDword', lines, structLine);

            assert.strictEqual(result.success, true);
            // Layout: BYTE(1) + padding(1) + WORD(2) + DWORD(4) = 8
            assert.strictEqual(result.members[0].size, 1);  // BYTE
            assert.strictEqual(result.members[1].size, 2);  // WORD
            assert.strictEqual(result.members[2].size, 4);  // DWORD
            assert.strictEqual(result.totalSize, 8);
        });

        test('Calculate size with INT8, INT16, INT32, INT64', () => {
            const lines = [
                'struct SignedTypes {',
                '    INT8 a;',
                '    INT16 b;',
                '    INT32 c;',
                '    INT64 d;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'SignedTypes');
            const result = calculator.calculateStructSize('SignedTypes', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].size, 1);  // INT8
            assert.strictEqual(result.members[1].size, 2);  // INT16
            assert.strictEqual(result.members[2].size, 4);  // INT32
            assert.strictEqual(result.members[3].size, 8);  // INT64
        });

        test('Calculate size with BOOL and BOOLEAN', () => {
            const lines = [
                'struct BoolTypes {',
                '    BOOL a;',
                '    BOOLEAN b;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'BoolTypes');
            const result = calculator.calculateStructSize('BoolTypes', lines, structLine);

            assert.strictEqual(result.success, true);
            // BOOL is 4 bytes, BOOLEAN is 1 byte
            assert.strictEqual(result.members[0].size, 4);  // BOOL
            assert.strictEqual(result.members[1].size, 1);  // BOOLEAN
        });

        test('Calculate size with Windows types array', () => {
            const lines = [
                'struct WinArray {',
                '    UINT32 values[10];',
                '    UINT16 flags[4];',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'WinArray');
            const result = calculator.calculateStructSize('WinArray', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].size, 40);  // UINT32[10] = 4 * 10
            assert.strictEqual(result.members[1].size, 8);   // UINT16[4] = 2 * 4
            assert.strictEqual(result.totalSize, 48);
        });
    });

    suite('Custom Type Registration', () => {
        test('Register and use Test32Class', () => {
            // Define Test32Class with UINT32 value
            const test32Lines = [
                'class Test32Class {',
                '    UINT32 value;',
                '};'
            ];

            const test32Line = StructSizeCalculator.findStructDefinition(test32Lines, 'Test32Class');
            const test32Result = calculator.calculateStructSize('Test32Class', test32Lines, test32Line);
            calculator.registerCustomType(test32Result);

            assert.strictEqual(test32Result.success, true);
            assert.strictEqual(test32Result.totalSize, 4);  // UINT32 = 4 bytes

            // Use Test32Class in another struct
            const contextLines = [
                'struct Context {',
                '    UINT16 a;',
                '    Test32Class b;',
                '};'
            ];

            const contextLine = StructSizeCalculator.findStructDefinition(contextLines, 'Context');
            const contextResult = calculator.calculateStructSize('Context', contextLines, contextLine);

            assert.strictEqual(contextResult.success, true);
            // Layout: UINT16(2) + padding(2) + Test32Class(4) = 8
            assert.strictEqual(contextResult.members[0].size, 2);  // UINT16
            assert.strictEqual(contextResult.members[1].size, 4);  // Test32Class
            assert.strictEqual(contextResult.totalSize, 8);
        });

        test('Register and use Test64Class', () => {
            // Define Test64Class with UINT64 value
            const test64Lines = [
                'class Test64Class {',
                '    UINT64 value;',
                '};'
            ];

            const test64Line = StructSizeCalculator.findStructDefinition(test64Lines, 'Test64Class');
            const test64Result = calculator.calculateStructSize('Test64Class', test64Lines, test64Line);
            calculator.registerCustomType(test64Result);

            assert.strictEqual(test64Result.success, true);
            assert.strictEqual(test64Result.totalSize, 8);  // UINT64 = 8 bytes

            // Use Test64Class in another struct
            const contextLines = [
                'struct Context {',
                '    UINT16 a;',
                '    Test64Class b;',
                '};'
            ];

            const contextLine = StructSizeCalculator.findStructDefinition(contextLines, 'Context');
            const contextResult = calculator.calculateStructSize('Context', contextLines, contextLine);

            assert.strictEqual(contextResult.success, true);
            // Layout: UINT16(2) + padding(6) + Test64Class(8) = 16
            assert.strictEqual(contextResult.members[0].size, 2);  // UINT16
            assert.strictEqual(contextResult.members[1].size, 8);  // Test64Class
            assert.strictEqual(contextResult.totalSize, 16);
        });

        test('Complex Context struct with multiple Windows types', () => {
            // Define Test32Class first
            const test32Lines = [
                'class Test32Class {',
                '    UINT32 value;',
                '};'
            ];

            const test32Line = StructSizeCalculator.findStructDefinition(test32Lines, 'Test32Class');
            const test32Result = calculator.calculateStructSize('Test32Class', test32Lines, test32Line);
            calculator.registerCustomType(test32Result);

            // Define Context struct
            const contextLines = [
                'struct Context {',
                '    UINT16 Aaaaa;',
                '    UINT16 Bbbbb;',
                '    UINT64 Ccccc;',
                '    UINT64 Ddddd;',
                '    Test32Class Eeeee;',
                '    UINT32 Fffff[80];',
                '};'
            ];

            const contextLine = StructSizeCalculator.findStructDefinition(contextLines, 'Context');
            const contextResult = calculator.calculateStructSize('Context', contextLines, contextLine);

            assert.strictEqual(contextResult.success, true);

            // Verify member sizes
            assert.strictEqual(contextResult.members[0].size, 2);   // UINT16 Aaaaa
            assert.strictEqual(contextResult.members[1].size, 2);   // UINT16 Bbbbb
            assert.strictEqual(contextResult.members[2].size, 8);   // UINT64 Ccccc
            assert.strictEqual(contextResult.members[3].size, 8);   // UINT64 Ddddd
            assert.strictEqual(contextResult.members[4].size, 4);   // Test32Class Eeeee
            assert.strictEqual(contextResult.members[5].size, 320); // UINT32[80] = 4 * 80

            // Layout:
            // UINT16(2) at offset 0
            // UINT16(2) at offset 2
            // padding(4) to align UINT64
            // UINT64(8) at offset 8
            // UINT64(8) at offset 16
            // Test32Class(4) at offset 24
            // padding(4) (not needed since array alignment is 4)
            // UINT32[80](320) at offset 28
            // Total = 348 bytes
        });

        test('Dependency chain: TypeA -> TypeB -> TypeC', () => {
            // TypeC is the base type (no dependencies)
            const typeCLines = [
                'struct TypeC {',
                '    UINT32 value;',
                '};'
            ];
            const typeCLine = StructSizeCalculator.findStructDefinition(typeCLines, 'TypeC');
            const typeCResult = calculator.calculateStructSize('TypeC', typeCLines, typeCLine);
            calculator.registerCustomType(typeCResult);

            assert.strictEqual(typeCResult.success, true);
            assert.strictEqual(typeCResult.totalSize, 4);

            // TypeB depends on TypeC
            const typeBLines = [
                'struct TypeB {',
                '    TypeC c;',
                '    UINT16 flag;',
                '};'
            ];
            const typeBLine = StructSizeCalculator.findStructDefinition(typeBLines, 'TypeB');
            const typeBResult = calculator.calculateStructSize('TypeB', typeBLines, typeBLine);
            calculator.registerCustomType(typeBResult);

            assert.strictEqual(typeBResult.success, true);
            // TypeC(4) + UINT16(2) + padding(2) = 8
            assert.strictEqual(typeBResult.totalSize, 8);

            // TypeA depends on TypeB
            const typeALines = [
                'struct TypeA {',
                '    TypeB b;',
                '    UINT64 data;',
                '};'
            ];
            const typeALine = StructSizeCalculator.findStructDefinition(typeALines, 'TypeA');
            const typeAResult = calculator.calculateStructSize('TypeA', typeALines, typeALine);

            assert.strictEqual(typeAResult.success, true);
            // TypeB(8) + UINT64(8) = 16
            assert.strictEqual(typeAResult.totalSize, 16);
            assert.strictEqual(typeAResult.members[0].size, 8);  // TypeB
            assert.strictEqual(typeAResult.members[1].size, 8);  // UINT64
        });

        test('Multiple custom types in single document simulation', () => {
            // Simulate registerAllCustomTypes behavior:
            // Register types in order they appear in document

            // First pass: register SmallType
            const smallTypeLines = [
                'struct SmallType {',
                '    UINT8 a;',
                '    UINT8 b;',
                '};'
            ];
            const smallLine = StructSizeCalculator.findStructDefinition(smallTypeLines, 'SmallType');
            const smallResult = calculator.calculateStructSize('SmallType', smallTypeLines, smallLine);
            calculator.registerCustomType(smallResult);

            assert.strictEqual(smallResult.totalSize, 2);  // 2 bytes

            // Second: register MediumType that uses SmallType
            const mediumTypeLines = [
                'struct MediumType {',
                '    SmallType small;',
                '    UINT32 value;',
                '};'
            ];
            const mediumLine = StructSizeCalculator.findStructDefinition(mediumTypeLines, 'MediumType');
            const mediumResult = calculator.calculateStructSize('MediumType', mediumTypeLines, mediumLine);
            calculator.registerCustomType(mediumResult);

            // SmallType(2) + padding(2) + UINT32(4) = 8
            assert.strictEqual(mediumResult.totalSize, 8);
            assert.strictEqual(mediumResult.members[0].size, 2);  // SmallType correctly sized

            // Third: register LargeType that uses MediumType
            const largeTypeLines = [
                'struct LargeType {',
                '    MediumType medium;',
                '    UINT64 timestamp;',
                '};'
            ];
            const largeLine = StructSizeCalculator.findStructDefinition(largeTypeLines, 'LargeType');
            const largeResult = calculator.calculateStructSize('LargeType', largeTypeLines, largeLine);

            // MediumType(8) + UINT64(8) = 16
            assert.strictEqual(largeResult.totalSize, 16);
            assert.strictEqual(largeResult.members[0].size, 8);  // MediumType correctly sized
        });
    });

    suite('Forward Reference Handling', () => {
        test('should return success false when referencing unregistered type', () => {
            const lines = [
                'struct UsesUnknown {',
                '    UnknownType field;',
                '    int x;',
                '};'
            ];
            const structLine = StructSizeCalculator.findStructDefinition(lines, 'UsesUnknown');
            const result = calculator.calculateStructSize('UsesUnknown', lines, structLine);

            assert.strictEqual(result.success, false);
            assert.ok(result.totalSize > 0); // still calculates with default size
        });

        test('should succeed after registering the dependency type', () => {
            // First register the dependency
            const depLines = [
                'struct DepType {',
                '    uint8_t a;',
                '    uint8_t b;',
                '};'
            ];
            const depLine = StructSizeCalculator.findStructDefinition(depLines, 'DepType');
            const depResult = calculator.calculateStructSize('DepType', depLines, depLine);
            assert.strictEqual(depResult.success, true);
            calculator.registerCustomType(depResult);

            // Now the struct using DepType should succeed
            const lines = [
                'struct UsesDepType {',
                '    DepType dep;',
                '    int x;',
                '};'
            ];
            const structLine = StructSizeCalculator.findStructDefinition(lines, 'UsesDepType');
            const result = calculator.calculateStructSize('UsesDepType', lines, structLine);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.members[0].size, 2); // DepType = 2 bytes
        });

        test('multi-pass resolves forward references', () => {
            // Simulate forward reference: StructA uses StructB, but B is defined later
            const allLines = [
                'struct StructA {',
                '    StructB b;',
                '    int x;',
                '};',
                'struct StructB {',
                '    uint16_t val;',
                '};'
            ];

            const definitions = [
                { name: 'StructA', line: 0 },
                { name: 'StructB', line: 4 }
            ];

            const registered = new Set<string>();
            const maxPasses = 3;

            for (let pass = 0; pass < maxPasses; pass++) {
                let newRegistrations = 0;
                for (const def of definitions) {
                    if (registered.has(def.name)) { continue; }
                    const result = calculator.calculateStructSize(def.name, allLines, def.line);
                    if (result.success) {
                        calculator.registerCustomType(result);
                        registered.add(def.name);
                        newRegistrations++;
                    }
                }
                if (newRegistrations === 0) { break; }
            }

            // StructB should be registered in pass 1, StructA in pass 2
            assert.ok(registered.has('StructB'));
            assert.ok(registered.has('StructA'));

            // Verify StructA has correct sizes
            const verifyLines = [
                'struct VerifyA {',
                '    StructA a;',
                '};'
            ];
            const verifyLine = StructSizeCalculator.findStructDefinition(verifyLines, 'VerifyA');
            const verifyResult = calculator.calculateStructSize('VerifyA', verifyLines, verifyLine);
            assert.strictEqual(verifyResult.success, true);
            // StructB = 2 bytes, StructA = StructB(2) + pad(2) + int(4) = 8
            assert.strictEqual(verifyResult.members[0].size, 8);
        });
    });

    suite('Real-world Examples', () => {
        test('Calculate typical register struct size', () => {
            const lines = [
                'struct RegisterBlock {',
                '    uint32_t control;',
                '    uint32_t status;',
                '    uint32_t data;',
                '    uint8_t flags;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'RegisterBlock');
            const result = calculator.calculateStructSize('RegisterBlock', lines, structLine);

            assert.strictEqual(result.success, true);
            // uint32_t * 3 = 12, uint8_t = 1, padding = 3 => 16 bytes
            assert.strictEqual(result.totalSize, 16);
        });

        test('Calculate packet header size', () => {
            const lines = [
                'struct PacketHeader {',
                '    uint16_t length;',
                '    uint16_t checksum;',
                '    uint8_t version;',
                '    uint8_t flags;',
                '    uint32_t timestamp;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PacketHeader');
            const result = calculator.calculateStructSize('PacketHeader', lines, structLine);

            assert.strictEqual(result.success, true);
            // uint16(2) + uint16(2) + uint8(1) + uint8(1) + padding(2) + uint32(4) = 12
            assert.strictEqual(result.totalSize, 12);
        });
    });

    suite('loadTypeConfig', () => {
        test('Load custom type configuration', () => {
            const configJson = {
                types: {
                    'HANDLE': { size: 8, alignment: 8 },
                    'PVOID': { size: 8, alignment: 8 }
                },
                packingAlignment: 4
            };

            const config = StructSizeCalculator.loadTypeConfig(configJson);

            assert.strictEqual(config.types['HANDLE'].size, 8);
            assert.strictEqual(config.types['HANDLE'].alignment, 8);
            assert.strictEqual(config.types['PVOID'].size, 8);
            assert.strictEqual(config.packingAlignment, 4);
        });

        test('Use default types when config is empty', () => {
            const configJson = {};

            const config = StructSizeCalculator.loadTypeConfig(configJson);

            // Should have default types
            assert.ok(config.types);
            assert.strictEqual(config.types['int'].size, 4);
            assert.strictEqual(config.packingAlignment, 8);  // default
        });

        test('Calculate struct with custom type config', () => {
            const configJson = {
                types: {
                    'HANDLE': { size: 8, alignment: 8 },
                    'int': { size: 4, alignment: 4 }
                },
                packingAlignment: 8
            };

            const config = StructSizeCalculator.loadTypeConfig(configJson);
            const customCalc = new StructSizeCalculator(config);

            const lines = [
                'struct HandleStruct {',
                '    HANDLE handle;',
                '    int value;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'HandleStruct');
            const result = customCalc.calculateStructSize('HandleStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // HANDLE(8) + int(4) + padding(4) = 16
            assert.strictEqual(result.members[0].size, 8);  // HANDLE
            assert.strictEqual(result.members[1].size, 4);  // int
            assert.strictEqual(result.totalSize, 16);
        });

        test('Custom packing alignment affects padding', () => {
            const configJson = {
                types: {
                    'char': { size: 1, alignment: 1 },
                    'int': { size: 4, alignment: 4 }
                },
                packingAlignment: 1  // Packed struct
            };

            const config = StructSizeCalculator.loadTypeConfig(configJson);
            const packedCalc = new StructSizeCalculator(config);

            const lines = [
                'struct PackedStruct {',
                '    char a;',
                '    int b;',
                '    char c;',
                '};'
            ];

            const structLine = StructSizeCalculator.findStructDefinition(lines, 'PackedStruct');
            const result = packedCalc.calculateStructSize('PackedStruct', lines, structLine);

            assert.strictEqual(result.success, true);
            // With packing=1: char(1) + int(4) + char(1) = 6 (no padding)
            assert.strictEqual(result.totalSize, 6);
            assert.strictEqual(result.padding, 0);
        });

        test('Merge custom types with defaults', () => {
            const configJson = {
                types: {
                    'MY_TYPE': { size: 16, alignment: 8 }
                }
            };

            const config = StructSizeCalculator.loadTypeConfig(configJson);
            const customCalc = new StructSizeCalculator(config);

            // Custom type should work
            const lines1 = [
                'struct WithCustom {',
                '    MY_TYPE custom;',
                '};'
            ];
            const result1 = customCalc.calculateStructSize('WithCustom', lines1, 0);
            assert.strictEqual(result1.members[0].size, 16);

            // Default types should still work (from merged config)
            const lines2 = [
                'struct WithDefault {',
                '    int value;',
                '};'
            ];
            const result2 = customCalc.calculateStructSize('WithDefault', lines2, 0);
            assert.strictEqual(result2.members[0].size, 4);
        });

        test('should not hang when a custom type declares zero alignment', () => {
            // Guard against the padding-modulo-0 regression.
            const config = StructSizeCalculator.loadTypeConfig({
                types: { Zero: { size: 4, alignment: 0 } }
            });
            const calc = new StructSizeCalculator(config);
            const lines = [
                'struct S {',
                '    Zero a;',
                '    int b;',
                '};'
            ];
            const result = calc.calculateStructSize('S', lines, 0);
            assert.strictEqual(result.success, true);
            assert.ok(Number.isFinite(result.totalSize));
        });
    });
});
