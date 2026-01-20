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
            // static members don't contribute to instance size, but parser includes them
            assert.strictEqual(result.totalSize, 12); // 3 * 4 bytes
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
});
