import * as assert from 'assert';
import {
    parseBitFieldComment,
    calculateValidRange,
    parseBitFieldDeclaration,
    extractBitFieldInfo,
    extractHierarchy,
    formatHierarchy,
    BitFieldInfo
} from '../sfrBitFieldParser';

suite('SFR BitField Parser Test Suite', () => {
    suite('Comment Parsing Tests', () => {
        test('Parse single bit field comment', () => {
            const comment = '// [0] [RW1C][0x0] Test interrupt 1';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.bitPosition, '0');
            assert.strictEqual(result!.bitStart, 0);
            assert.strictEqual(result!.bitEnd, 0);
            assert.strictEqual(result!.bitWidth, 1);
            assert.strictEqual(result!.accessType, 'RW1C');
            assert.strictEqual(result!.resetValue, '0x0');
            assert.strictEqual(result!.resetValueNumeric, 0);
            assert.strictEqual(result!.description, 'Test interrupt 1');
        });

        test('Parse multi-bit field comment', () => {
            const comment = '// [12:10][RW1C][0x7] Test field 0';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.bitPosition, '12:10');
            assert.strictEqual(result!.bitStart, 10);
            assert.strictEqual(result!.bitEnd, 12);
            assert.strictEqual(result!.bitWidth, 3);
            assert.strictEqual(result!.accessType, 'RW1C');
            assert.strictEqual(result!.resetValue, '0x7');
            assert.strictEqual(result!.resetValueNumeric, 7);
            assert.strictEqual(result!.description, 'Test field 0');
        });

        test('Parse comment with extra whitespace', () => {
            const comment = '// [0]       [RW1C][0x0] Test interrupt 1';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.bitPosition, '0');
            assert.strictEqual(result!.accessType, 'RW1C');
            assert.strictEqual(result!.description, 'Test interrupt 1');
        });

        test('Parse comment with different access types', () => {
            const testCases = [
                { comment: '// [0][RO][0x0] Read only bit', expected: 'RO' },
                { comment: '// [1][WO][0x0] Write only bit', expected: 'WO' },
                { comment: '// [2][RW][0x0] Read write bit', expected: 'RW' },
                { comment: '// [3][W1S][0x0] Write 1 to set', expected: 'W1S' },
            ];

            for (const testCase of testCases) {
                const result = parseBitFieldComment(testCase.comment);
                assert.notStrictEqual(result, null);
                assert.strictEqual(result!.accessType, testCase.expected);
            }
        });

        test('Parse comment with binary reset value', () => {
            const comment = '// [7:4][RW][0b1010] Binary field';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.resetValue, '0b1010');
            assert.strictEqual(result!.resetValueNumeric, 10);
        });

        test('Parse comment with decimal reset value', () => {
            const comment = '// [3:0][RW][15] Decimal field';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.resetValue, '15');
            assert.strictEqual(result!.resetValueNumeric, 15);
        });

        test('Parse comment with large multi-bit field', () => {
            const comment = '// [31:16][RW][0xFFFF] Large field';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.bitStart, 16);
            assert.strictEqual(result!.bitEnd, 31);
            assert.strictEqual(result!.bitWidth, 16);
            assert.strictEqual(result!.resetValueNumeric, 0xFFFF);
        });

        test('Return null for invalid comment format', () => {
            const invalidComments = [
                '// Invalid comment',
                '// [0] Missing brackets',
                '// [RW1C][0x0] Missing bit position',
                '// Not a bit field comment',
                '',
            ];

            for (const comment of invalidComments) {
                const result = parseBitFieldComment(comment);
                assert.strictEqual(result, null, `Should return null for: ${comment}`);
            }
        });

        test('Return null for invalid bit position', () => {
            const invalidComments = [
                '// [abc][RW][0x0] Invalid bit position',
                '// [10:20][RW][0x0] Start > End',
                '// [:10][RW][0x0] Missing start',
            ];

            for (const comment of invalidComments) {
                const result = parseBitFieldComment(comment);
                assert.strictEqual(result, null, `Should return null for: ${comment}`);
            }
        });

        test('Parse comment with long description', () => {
            const comment = '// [5][RW1C][0x0] This is a very long description with multiple words and details';
            const result = parseBitFieldComment(comment);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.description, 'This is a very long description with multiple words and details');
        });
    });

    suite('Valid Range Calculation Tests', () => {
        test('Calculate range for 1-bit field', () => {
            const range = calculateValidRange(1);
            assert.strictEqual(range.min, 0);
            assert.strictEqual(range.max, 1);
        });

        test('Calculate range for 3-bit field', () => {
            const range = calculateValidRange(3);
            assert.strictEqual(range.min, 0);
            assert.strictEqual(range.max, 7);
        });

        test('Calculate range for 8-bit field', () => {
            const range = calculateValidRange(8);
            assert.strictEqual(range.min, 0);
            assert.strictEqual(range.max, 255);
        });

        test('Calculate range for 16-bit field', () => {
            const range = calculateValidRange(16);
            assert.strictEqual(range.min, 0);
            assert.strictEqual(range.max, 65535);
        });

        test('Calculate range for 32-bit field', () => {
            const range = calculateValidRange(32);
            assert.strictEqual(range.min, 0);
            assert.strictEqual(range.max, 4294967295);
        });
    });

    suite('Bit Field Declaration Parsing Tests', () => {
        test('Parse single bit field declaration', () => {
            const line = 'Type int0_set  : 1; // [0] [RW1C][0x0] Test interrupt 1';
            const result = parseBitFieldDeclaration(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'int0_set');
            assert.strictEqual(result!.declaredWidth, 1);
            assert.strictEqual(result!.inlineComment, '// [0] [RW1C][0x0] Test interrupt 1');
        });

        test('Parse multi-bit field declaration', () => {
            const line = 'Type int_field_0 : 3; // [12:10][RW1C][0x7] Test field 0';
            const result = parseBitFieldDeclaration(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'int_field_0');
            assert.strictEqual(result!.declaredWidth, 3);
            assert.strictEqual(result!.inlineComment, '// [12:10][RW1C][0x7] Test field 0');
        });

        test('Parse bit field without comment', () => {
            const line = 'Type reserved : 8;';
            const result = parseBitFieldDeclaration(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'reserved');
            assert.strictEqual(result!.declaredWidth, 8);
            assert.strictEqual(result!.inlineComment, null);
        });

        test('Parse bit field with extra whitespace', () => {
            const line = '      Type   field_name   :   16   ;   // comment';
            const result = parseBitFieldDeclaration(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'field_name');
            assert.strictEqual(result!.declaredWidth, 16);
        });

        test('Return null for non-bitfield line', () => {
            const invalidLines = [
                'int normalVariable = 0;',
                'Type dword;',
                'struct SomeStruct {',
                '// Just a comment',
                '',
            ];

            for (const line of invalidLines) {
                const result = parseBitFieldDeclaration(line);
                assert.strictEqual(result, null, `Should return null for: ${line}`);
            }
        });

        test('Return null for invalid bit width', () => {
            const invalidLines = [
                'Type field : 0;',  // Zero width
                'Type field : -1;', // Negative
                'Type field : abc;', // Not a number
            ];

            for (const line of invalidLines) {
                const result = parseBitFieldDeclaration(line);
                assert.strictEqual(result, null, `Should return null for: ${line}`);
            }
        });
    });

    suite('Complete Bit Field Info Extraction Tests', () => {
        test('Extract info with inline comment', () => {
            const line = 'Type int0_set : 1; // [0] [RW1C][0x0] Test interrupt 1';
            const result = extractBitFieldInfo(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'int0_set');
            assert.strictEqual(result!.declaredWidth, 1);
            assert.notStrictEqual(result!.commentInfo, null);
            assert.strictEqual(result!.commentInfo!.bitPosition, '0');
            assert.strictEqual(result!.commentInfo!.accessType, 'RW1C');
            assert.strictEqual(result!.commentInfo!.description, 'Test interrupt 1');
        });

        test('Extract info with preceding comment', () => {
            const precedingLine = '// [5] [RO][0x1] Status bit';
            const currentLine = 'Type status_bit : 1;';
            const result = extractBitFieldInfo(currentLine, precedingLine);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'status_bit');
            assert.strictEqual(result!.declaredWidth, 1);
            assert.notStrictEqual(result!.commentInfo, null);
            assert.strictEqual(result!.commentInfo!.bitPosition, '5');
            assert.strictEqual(result!.commentInfo!.accessType, 'RO');
        });

        test('Extract info without comment', () => {
            const line = 'Type reserved : 8;';
            const result = extractBitFieldInfo(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.fieldName, 'reserved');
            assert.strictEqual(result!.declaredWidth, 8);
            assert.strictEqual(result!.commentInfo, null);
        });

        test('Inline comment takes precedence over preceding comment', () => {
            const precedingLine = '// [5] [RO][0x1] Wrong comment';
            const currentLine = 'Type field : 1; // [3] [RW][0x0] Correct comment';
            const result = extractBitFieldInfo(currentLine, precedingLine);

            assert.notStrictEqual(result, null);
            assert.notStrictEqual(result!.commentInfo, null);
            assert.strictEqual(result!.commentInfo!.bitPosition, '3');
            assert.strictEqual(result!.commentInfo!.description, 'Correct comment');
        });

        test('Validate declared width matches comment info', () => {
            const line = 'Type int_field_0 : 3; // [12:10][RW1C][0x7] Test field 0';
            const result = extractBitFieldInfo(line);

            assert.notStrictEqual(result, null);
            assert.strictEqual(result!.declaredWidth, 3);
            assert.notStrictEqual(result!.commentInfo, null);
            assert.strictEqual(result!.commentInfo!.bitWidth, 3);
            // They should match!
            assert.strictEqual(result!.declaredWidth, result!.commentInfo!.bitWidth);
        });

        test('Return null for invalid declaration', () => {
            const line = 'int normalVariable = 0;';
            const result = extractBitFieldInfo(line);
            assert.strictEqual(result, null);
        });
    });

    suite('Hierarchy Extraction Tests', () => {
        test('Extract single class hierarchy', () => {
            const lines = [
                'class RegTestInt',
                '{',
                'public:',
                '  int value;',
                '  Type int0_set : 1;',
                '};'
            ];

            const scopes = extractHierarchy(lines, 4);
            assert.strictEqual(scopes.length, 1);
            assert.strictEqual(scopes[0].type, 'class');
            assert.strictEqual(scopes[0].name, 'RegTestInt');
        });

        test('Extract nested class and union hierarchy', () => {
            const lines = [
                'class RegTestInt',
                '{',
                'public:',
                '  template <typename Type>',
                '  union IntRegSts',
                '  {',
                '    Type dword;',
                '    Type int0_set : 1;',
                '  };',
                '};'
            ];

            const scopes = extractHierarchy(lines, 7);
            assert.strictEqual(scopes.length, 2);
            assert.strictEqual(scopes[0].type, 'class');
            assert.strictEqual(scopes[0].name, 'RegTestInt');
            assert.strictEqual(scopes[1].type, 'union');
            assert.strictEqual(scopes[1].name, 'IntRegSts');
        });

        test('Extract full hierarchy with class, union, and struct', () => {
            const lines = [
                'class RegTestInt',
                '{',
                'public:',
                '  template <typename Type>',
                '  union IntRegSts',
                '  {',
                '    Type dword;',
                '    struct',
                '    {',
                '      Type int0_set  : 1;',
                '      Type int_field_0 : 3;',
                '    } rst;',
                '  };',
                '};'
            ];

            const scopes = extractHierarchy(lines, 9);
            assert.strictEqual(scopes.length, 3);
            assert.strictEqual(scopes[0].type, 'class');
            assert.strictEqual(scopes[0].name, 'RegTestInt');
            assert.strictEqual(scopes[1].type, 'union');
            assert.strictEqual(scopes[1].name, 'IntRegSts');
            assert.strictEqual(scopes[2].type, 'struct');
            // Anonymous struct has no name
            assert.strictEqual(scopes[2].name, null);
        });

        test('Extract namespace hierarchy', () => {
            const lines = [
                'namespace Hardware',
                '{',
                '  class RegTestInt',
                '  {',
                '    Type int0_set : 1;',
                '  };',
                '}'
            ];

            const scopes = extractHierarchy(lines, 4);
            assert.strictEqual(scopes.length, 2);
            assert.strictEqual(scopes[0].type, 'namespace');
            assert.strictEqual(scopes[0].name, 'Hardware');
            assert.strictEqual(scopes[1].type, 'class');
            assert.strictEqual(scopes[1].name, 'RegTestInt');
        });

        test('Extract empty hierarchy for top-level declaration', () => {
            const lines = [
                'Type int0_set : 1;'
            ];

            const scopes = extractHierarchy(lines, 0);
            assert.strictEqual(scopes.length, 0);
        });

        test('Handle complex nested structures', () => {
            const lines = [
                'namespace HW {',
                '  class Regs {',
                '    union Status {',
                '      struct {',
                '        Type flag : 1;',
                '      } bits;',
                '    };',
                '  };',
                '}'
            ];

            const scopes = extractHierarchy(lines, 4);
            assert.strictEqual(scopes.length, 4);
            assert.strictEqual(scopes[0].name, 'HW');
            assert.strictEqual(scopes[1].name, 'Regs');
            assert.strictEqual(scopes[2].name, 'Status');
            assert.strictEqual(scopes[3].type, 'struct');
        });
    });

    suite('Hierarchy Formatting Tests', () => {
        test('Format hierarchy with class and field', () => {
            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 0 }
            ];
            const result = formatHierarchy(scopes, 'int0_set');
            assert.strictEqual(result, 'RegTestInt::int0_set');
        });

        test('Format hierarchy with class, union, and field', () => {
            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 0 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 4 }
            ];
            const result = formatHierarchy(scopes, 'int0_set');
            assert.strictEqual(result, 'RegTestInt::IntRegSts::int0_set');
        });

        test('Format hierarchy with anonymous struct', () => {
            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 0 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 4 },
                { type: 'struct' as const, name: null, lineNumber: 7 } // Anonymous
            ];
            const result = formatHierarchy(scopes, 'int0_set');
            // Anonymous scopes are skipped
            assert.strictEqual(result, 'RegTestInt::IntRegSts::int0_set');
        });

        test('Format hierarchy with namespace', () => {
            const scopes = [
                { type: 'namespace' as const, name: 'Hardware', lineNumber: 0 },
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 2 }
            ];
            const result = formatHierarchy(scopes, 'int0_set');
            assert.strictEqual(result, 'Hardware::RegTestInt::int0_set');
        });

        test('Format hierarchy with only field name', () => {
            const scopes: any[] = [];
            const result = formatHierarchy(scopes, 'int0_set');
            assert.strictEqual(result, 'int0_set');
        });

        test('Format complex hierarchy', () => {
            const scopes = [
                { type: 'namespace' as const, name: 'HW', lineNumber: 0 },
                { type: 'class' as const, name: 'Regs', lineNumber: 1 },
                { type: 'union' as const, name: 'Status', lineNumber: 2 },
                { type: 'struct' as const, name: null, lineNumber: 3 }
            ];
            const result = formatHierarchy(scopes, 'flag');
            assert.strictEqual(result, 'HW::Regs::Status::flag');
        });
    });
});
