import * as assert from 'assert';
import { RegisterDecoder, RegisterDefinition, BitFieldDefinition } from '../registerDecoder';

suite('RegisterDecoder Test Suite', () => {
    let decoder: RegisterDecoder;

    setup(() => {
        decoder = new RegisterDecoder();
    });

    suite('Bit Field Value Extraction', () => {
        test('Extract single bit field (bit 0)', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'BIT0',
                        bitStart: 0,
                        bitEnd: 0,
                        bitWidth: 1
                    }
                ]
            };

            const result = decoder.decodeValue(0x01, definition);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields.length, 1);
            assert.strictEqual(result.fields[0].name, 'BIT0');
            assert.strictEqual(result.fields[0].value, 1);
            assert.strictEqual(result.fields[0].bitPosition, '0');
        });

        test('Extract single bit field (bit 5)', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'BIT5',
                        bitStart: 5,
                        bitEnd: 5,
                        bitWidth: 1
                    }
                ]
            };

            const result = decoder.decodeValue(0x20, definition); // 0x20 = bit 5 set

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields[0].value, 1);
        });

        test('Extract multi-bit field', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'FIELD',
                        bitStart: 4,
                        bitEnd: 7,
                        bitWidth: 4
                    }
                ]
            };

            const result = decoder.decodeValue(0xF0, definition); // 0xF0 = bits 7:4 = 0xF

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields[0].value, 0xF);
            assert.strictEqual(result.fields[0].bitPosition, '7:4');
        });

        test('Extract field with specific value', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'BAUD_SEL',
                        bitStart: 8,
                        bitEnd: 11,
                        bitWidth: 4
                    }
                ]
            };

            const result = decoder.decodeValue(0x500, definition); // bits 11:8 = 0x5

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields[0].value, 5);
            assert.strictEqual(result.fields[0].hex, '0x5');
            assert.strictEqual(result.fields[0].binary, '0b0101');
            assert.strictEqual(result.fields[0].decimal, '5');
        });
    });

    suite('Multiple Bit Fields', () => {
        test('Decode register with multiple single-bit fields', () => {
            const definition: RegisterDefinition = {
                name: 'UART_CTRL',
                totalBits: 32,
                fields: [
                    {
                        name: 'TX_EN',
                        bitStart: 0,
                        bitEnd: 0,
                        bitWidth: 1,
                        description: 'Transmit enable'
                    },
                    {
                        name: 'RX_EN',
                        bitStart: 1,
                        bitEnd: 1,
                        bitWidth: 1,
                        description: 'Receive enable'
                    },
                    {
                        name: 'PARITY_EN',
                        bitStart: 2,
                        bitEnd: 2,
                        bitWidth: 1,
                        description: 'Parity enable'
                    }
                ]
            };

            const result = decoder.decodeValue(0x03, definition); // TX_EN=1, RX_EN=1, PARITY_EN=0

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields.length, 3);

            assert.strictEqual(result.fields[0].name, 'TX_EN');
            assert.strictEqual(result.fields[0].value, 1);

            assert.strictEqual(result.fields[1].name, 'RX_EN');
            assert.strictEqual(result.fields[1].value, 1);

            assert.strictEqual(result.fields[2].name, 'PARITY_EN');
            assert.strictEqual(result.fields[2].value, 0);
        });

        test('Decode register with mixed single and multi-bit fields', () => {
            const definition: RegisterDefinition = {
                name: 'IRQ_CTRL',
                totalBits: 32,
                fields: [
                    {
                        name: 'BIT0',
                        bitStart: 0,
                        bitEnd: 0,
                        bitWidth: 1
                    },
                    {
                        name: 'BIT5',
                        bitStart: 5,
                        bitEnd: 5,
                        bitWidth: 1
                    },
                    {
                        name: 'PRIORITY',
                        bitStart: 8,
                        bitEnd: 11,
                        bitWidth: 4
                    }
                ]
            };

            const result = decoder.decodeValue(0x321, definition); // BIT0=1, BIT5=1, PRIORITY=3

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields.length, 3);

            assert.strictEqual(result.fields[0].value, 1); // BIT0
            assert.strictEqual(result.fields[1].value, 1); // BIT5
            assert.strictEqual(result.fields[2].value, 3); // PRIORITY
        });

        test('Fields should be sorted by bit position', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'HIGH_FIELD',
                        bitStart: 16,
                        bitEnd: 23,
                        bitWidth: 8
                    },
                    {
                        name: 'LOW_FIELD',
                        bitStart: 0,
                        bitEnd: 7,
                        bitWidth: 8
                    },
                    {
                        name: 'MID_FIELD',
                        bitStart: 8,
                        bitEnd: 15,
                        bitWidth: 8
                    }
                ]
            };

            const result = decoder.decodeValue(0x123456, definition);

            assert.strictEqual(result.success, true);
            // Should be sorted: LOW_FIELD, MID_FIELD, HIGH_FIELD
            assert.strictEqual(result.fields[0].name, 'LOW_FIELD');
            assert.strictEqual(result.fields[1].name, 'MID_FIELD');
            assert.strictEqual(result.fields[2].name, 'HIGH_FIELD');
        });
    });

    suite('Register Parsing from Struct', () => {
        test('Parse simple struct with bit fields', () => {
            const lines = [
                'struct TestReg {',
                '    // [0] [RW][0x0] Bit 0 field',
                '    Type bit0 : 1;',
                '    // [1] [RW][0x0] Bit 1 field',
                '    Type bit1 : 1;',
                '};'
            ];

            const structLine = RegisterDecoder.findStructDefinition(lines, 'TestReg');
            assert.strictEqual(structLine, 0);

            const definition = RegisterDecoder.parseRegisterFromStruct(lines, structLine, 'TestReg');

            assert.ok(definition);
            assert.strictEqual(definition.name, 'TestReg');
            assert.strictEqual(definition.fields.length, 2);
            assert.strictEqual(definition.fields[0].name, 'bit0');
            assert.strictEqual(definition.fields[1].name, 'bit1');
        });

        test('Parse struct with multi-bit fields', () => {
            const lines = [
                'struct UartCtrl {',
                '    Type tx_en : 1; // [0] [RW][0x0] Transmit enable',
                '    Type rx_en : 1; // [1] [RW][0x0] Receive enable',
                '    Type baud_sel : 4; // [5:2] [RW][0x0] Baud rate selector',
                '};'
            ];

            const structLine = RegisterDecoder.findStructDefinition(lines, 'UartCtrl');
            const definition = RegisterDecoder.parseRegisterFromStruct(lines, structLine, 'UartCtrl');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 3);

            assert.strictEqual(definition.fields[0].name, 'tx_en');
            assert.strictEqual(definition.fields[0].bitStart, 0);
            assert.strictEqual(definition.fields[0].bitEnd, 0);

            assert.strictEqual(definition.fields[1].name, 'rx_en');
            assert.strictEqual(definition.fields[1].bitStart, 1);
            assert.strictEqual(definition.fields[1].bitEnd, 1);

            assert.strictEqual(definition.fields[2].name, 'baud_sel');
            assert.strictEqual(definition.fields[2].bitStart, 2);
            assert.strictEqual(definition.fields[2].bitEnd, 5);
            assert.strictEqual(definition.fields[2].bitWidth, 4);
        });

        test('Parse struct with preceding line comments', () => {
            const lines = [
                'struct IrqCtrl {',
                '    // [0] [RW1C][0x0] Interrupt 0',
                '    Type int0 : 1;',
                '    // [5:1] [RO][0x0] Reserved',
                '    Type reserved : 5;',
                '    // [6] [RW][0x1] Interrupt enable',
                '    Type int_en : 1;',
                '};'
            ];

            const structLine = RegisterDecoder.findStructDefinition(lines, 'IrqCtrl');
            const definition = RegisterDecoder.parseRegisterFromStruct(lines, structLine, 'IrqCtrl');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 3);

            assert.strictEqual(definition.fields[0].description, 'Interrupt 0');
            assert.strictEqual(definition.fields[0].accessType, 'RW1C');

            assert.strictEqual(definition.fields[1].description, 'Reserved');
            assert.strictEqual(definition.fields[1].accessType, 'RO');

            assert.strictEqual(definition.fields[2].description, 'Interrupt enable');
            assert.strictEqual(definition.fields[2].accessType, 'RW');
        });

        test('Find struct definition by name', () => {
            const lines = [
                'int x = 5;',
                'struct FirstStruct {',
                '    int a;',
                '};',
                'struct SecondStruct {',
                '    int b;',
                '};'
            ];

            const firstLine = RegisterDecoder.findStructDefinition(lines, 'FirstStruct');
            assert.strictEqual(firstLine, 1);

            const secondLine = RegisterDecoder.findStructDefinition(lines, 'SecondStruct');
            assert.strictEqual(secondLine, 4);

            const notFound = RegisterDecoder.findStructDefinition(lines, 'NonExistent');
            assert.strictEqual(notFound, -1);
        });

        test('Return null for struct without bit fields', () => {
            const lines = [
                'struct EmptyStruct {',
                '    int regularField;',
                '};'
            ];

            const structLine = RegisterDecoder.findStructDefinition(lines, 'EmptyStruct');
            const definition = RegisterDecoder.parseRegisterFromStruct(lines, structLine, 'EmptyStruct');

            assert.strictEqual(definition, null);
        });
    });

    suite('Real-world Example', () => {
        test('Decode typical UART control register', () => {
            const definition: RegisterDefinition = {
                name: 'UART_CTRL',
                totalBits: 32,
                fields: [
                    {
                        name: 'TX_EN',
                        bitStart: 0,
                        bitEnd: 0,
                        bitWidth: 1,
                        description: 'Transmit enable',
                        accessType: 'RW'
                    },
                    {
                        name: 'RX_EN',
                        bitStart: 1,
                        bitEnd: 1,
                        bitWidth: 1,
                        description: 'Receive enable',
                        accessType: 'RW'
                    },
                    {
                        name: 'PARITY_EN',
                        bitStart: 2,
                        bitEnd: 2,
                        bitWidth: 1,
                        description: 'Parity enable',
                        accessType: 'RW'
                    },
                    {
                        name: 'STOP_BITS',
                        bitStart: 3,
                        bitEnd: 4,
                        bitWidth: 2,
                        description: 'Stop bits: 0=1bit, 1=1.5bits, 2=2bits',
                        accessType: 'RW'
                    },
                    {
                        name: 'BAUD_SEL',
                        bitStart: 8,
                        bitEnd: 11,
                        bitWidth: 4,
                        description: 'Baud rate selector',
                        accessType: 'RW'
                    }
                ]
            };

            // UART_CTRL = 0x30B
            // Binary: 0b0011_0000_1011
            // TX_EN (bit 0) = 1
            // RX_EN (bit 1) = 1
            // PARITY_EN (bit 2) = 0
            // STOP_BITS (bits 4:3) = 1
            // BAUD_SEL (bits 11:8) = 3
            const result = decoder.decodeValue(0x30B, definition);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.registerName, 'UART_CTRL');
            assert.strictEqual(result.registerValue, 0x30B);
            assert.strictEqual(result.fields.length, 5);

            // Check individual field values
            const txEn = result.fields.find(f => f.name === 'TX_EN');
            assert.ok(txEn);
            assert.strictEqual(txEn.value, 1);

            const rxEn = result.fields.find(f => f.name === 'RX_EN');
            assert.ok(rxEn);
            assert.strictEqual(rxEn.value, 1);

            const parityEn = result.fields.find(f => f.name === 'PARITY_EN');
            assert.ok(parityEn);
            assert.strictEqual(parityEn.value, 0);

            const stopBits = result.fields.find(f => f.name === 'STOP_BITS');
            assert.ok(stopBits);
            assert.strictEqual(stopBits.value, 1);

            const baudSel = result.fields.find(f => f.name === 'BAUD_SEL');
            assert.ok(baudSel);
            assert.strictEqual(baudSel.value, 3);
        });
    });

    suite('Union with Nested Struct', () => {
        test('Parse union with anonymous struct containing bit fields', () => {
            const lines = [
                'union IntRegSts {',
                '    Type dword;',
                '    struct {',
                '        Type int0_set : 1; // [0] [RW1C][0x0] Interrupt 0',
                '        Type int1_set : 1; // [1] [RW1C][0x0] Interrupt 1',
                '        Type reserved : 2; // [3:2] [RO][0x0] Reserved',
                '    } rst;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'IntRegSts');
            assert.strictEqual(unionLine, 0);

            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'IntRegSts');

            assert.ok(definition);
            assert.strictEqual(definition.name, 'IntRegSts');
            assert.strictEqual(definition.fields.length, 3);

            assert.strictEqual(definition.fields[0].name, 'int0_set');
            assert.strictEqual(definition.fields[0].bitStart, 0);
            assert.strictEqual(definition.fields[0].bitEnd, 0);

            assert.strictEqual(definition.fields[1].name, 'int1_set');
            assert.strictEqual(definition.fields[1].bitStart, 1);

            assert.strictEqual(definition.fields[2].name, 'reserved');
            assert.strictEqual(definition.fields[2].bitStart, 2);
            assert.strictEqual(definition.fields[2].bitEnd, 3);
        });

        test('Parse class containing template union with bit fields', () => {
            const lines = [
                'class RegTestInt {',
                'public:',
                '  template <typename Type>',
                '  union IntRegSts {',
                '    Type dword;',
                '    struct {',
                '      Type int0_set : 1; // [0] [RW1C][0x0] Test interrupt 1',
                '      Type int1_set : 1; // [1] [RW1C][0x0] Test interrupt 2',
                '      Type int_field_0 : 2; // [3:2][RW1C][0x3] Test field 0',
                '    } rst;',
                '  };',
                '};'
            ];

            const classLine = RegisterDecoder.findUnionDefinition(lines, 'RegTestInt');
            assert.ok(classLine !== -1);

            const definition = RegisterDecoder.parseRegisterFromUnion(lines, classLine, 'RegTestInt');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 3);

            assert.strictEqual(definition.fields[0].name, 'int0_set');
            assert.strictEqual(definition.fields[0].description, 'Test interrupt 1');

            assert.strictEqual(definition.fields[1].name, 'int1_set');
            assert.strictEqual(definition.fields[1].description, 'Test interrupt 2');

            assert.strictEqual(definition.fields[2].name, 'int_field_0');
            assert.strictEqual(definition.fields[2].bitWidth, 2);
        });

        test('Decode value using union definition', () => {
            const lines = [
                'union TestUnion {',
                '    Type dword;',
                '    struct {',
                '        Type bit0 : 1; // [0] [RW][0x0] Bit 0',
                '        Type bit1 : 1; // [1] [RW][0x0] Bit 1',
                '        Type bit6 : 1; // [6] [RW][0x0] Bit 6',
                '    } bits;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'TestUnion');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'TestUnion');

            assert.ok(definition);

            const result = decoder.decodeValue(0x42, definition); // 0x42 = 0b1000010

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields.length, 3);

            const bit0 = result.fields.find(f => f.name === 'bit0');
            assert.ok(bit0);
            assert.strictEqual(bit0.value, 0);

            const bit1 = result.fields.find(f => f.name === 'bit1');
            assert.ok(bit1);
            assert.strictEqual(bit1.value, 1);

            const bit6 = result.fields.find(f => f.name === 'bit6');
            assert.ok(bit6);
            assert.strictEqual(bit6.value, 1);
        });

        test('Return null for union without bit fields', () => {
            const lines = [
                'union SimpleUnion {',
                '    int a;',
                '    float b;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'SimpleUnion');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'SimpleUnion');

            assert.strictEqual(definition, null);
        });

        test('Parse union with named struct (not anonymous)', () => {
            const lines = [
                'union TestReg {',
                '    uint32_t dword;',
                '    struct BitFields {',
                '        uint32_t enable : 1; // [0] [RW][0x0] Enable bit',
                '        uint32_t ready : 1;  // [1] [RO][0x0] Ready bit',
                '        uint32_t mode : 2;   // [3:2] [RW][0x0] Mode select',
                '    } bits;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'TestReg');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'TestReg');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 3);
            assert.strictEqual(definition.fields[0].name, 'enable');
            assert.strictEqual(definition.fields[1].name, 'ready');
            assert.strictEqual(definition.fields[2].name, 'mode');
            assert.strictEqual(definition.fields[2].bitWidth, 2);
        });

        test('Parse union with sparse bit positions', () => {
            const lines = [
                'union SparseReg {',
                '    uint32_t dword;',
                '    struct {',
                '        uint32_t bit0 : 1;   // [0] [RW][0x0] Bit 0',
                '        uint32_t bit10 : 1;  // [10] [RW][0x0] Bit 10',
                '        uint32_t bit20 : 1;  // [20] [RW][0x0] Bit 20',
                '        uint32_t bit31 : 1;  // [31] [RW][0x0] Bit 31',
                '    } bits;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'SparseReg');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'SparseReg');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 4);
            assert.strictEqual(definition.fields[0].bitStart, 0);
            assert.strictEqual(definition.fields[1].bitStart, 10);
            assert.strictEqual(definition.fields[2].bitStart, 20);
            assert.strictEqual(definition.fields[3].bitStart, 31);

            // Test decoding with sparse values
            const result = decoder.decodeValue(0x80100001, definition); // bits 0, 20, 31 set
            assert.strictEqual(result.fields[0].value, 1); // bit0
            assert.strictEqual(result.fields[1].value, 0); // bit10
            assert.strictEqual(result.fields[2].value, 1); // bit20
            assert.strictEqual(result.fields[3].value, 1); // bit31
        });

        test('Parse union with large multi-bit fields', () => {
            const lines = [
                'union LargeFieldReg {',
                '    uint32_t dword;',
                '    struct {',
                '        uint32_t data : 16;    // [15:0] [RW][0x0] Data field',
                '        uint32_t status : 8;   // [23:16] [RO][0x0] Status field',
                '        uint32_t control : 8;  // [31:24] [RW][0x0] Control field',
                '    } fields;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'LargeFieldReg');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'LargeFieldReg');

            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 3);
            assert.strictEqual(definition.fields[0].bitWidth, 16);
            assert.strictEqual(definition.fields[1].bitWidth, 8);
            assert.strictEqual(definition.fields[2].bitWidth, 8);

            // Test decoding: 0x12345678
            // data (15:0) = 0x5678
            // status (23:16) = 0x34
            // control (31:24) = 0x12
            const result = decoder.decodeValue(0x12345678, definition);
            assert.strictEqual(result.fields[0].value, 0x5678);
            assert.strictEqual(result.fields[1].value, 0x34);
            assert.strictEqual(result.fields[2].value, 0x12);
        });

        test('Parse namespace containing class with union', () => {
            const lines = [
                'namespace HardwareReg {',
                '    class ControlReg {',
                '    public:',
                '        union StatusReg {',
                '            uint32_t dword;',
                '            struct {',
                '                uint32_t busy : 1; // [0] [RO][0x0] Busy flag',
                '                uint32_t error : 1; // [1] [RO][0x0] Error flag',
                '            } bits;',
                '        };',
                '    };',
                '}'
            ];

            const classLine = RegisterDecoder.findUnionDefinition(lines, 'ControlReg');
            assert.ok(classLine !== -1);

            const definition = RegisterDecoder.parseRegisterFromUnion(lines, classLine, 'ControlReg');
            assert.ok(definition);
            assert.strictEqual(definition.fields.length, 2);
        });

        test('Handle union with multiple struct definitions', () => {
            const lines = [
                'union MultiStructReg {',
                '    uint32_t dword;',
                '    struct {',
                '        uint32_t field1 : 8; // [7:0] [RW][0x0] Field 1',
                '        uint32_t field2 : 8; // [15:8] [RW][0x0] Field 2',
                '    } bytes;',
                '    struct {',
                '        uint32_t bit0 : 1; // [0] [RW][0x0] Bit 0',
                '        uint32_t bit1 : 1; // [1] [RW][0x0] Bit 1',
                '    } bits;',
                '};'
            ];

            const unionLine = RegisterDecoder.findUnionDefinition(lines, 'MultiStructReg');
            const definition = RegisterDecoder.parseRegisterFromUnion(lines, unionLine, 'MultiStructReg');

            assert.ok(definition);
            // Current implementation parses all structs in union
            // In practice, unions typically have one struct with bit fields
            assert.strictEqual(definition.fields.length, 4);
            assert.strictEqual(definition.fields[0].name, 'field1');
            assert.strictEqual(definition.fields[1].name, 'field2');
            assert.strictEqual(definition.fields[2].name, 'bit0');
            assert.strictEqual(definition.fields[3].name, 'bit1');
        });
    });

    suite('Edge Cases', () => {
        test('Decode zero value', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'FIELD1',
                        bitStart: 0,
                        bitEnd: 7,
                        bitWidth: 8
                    }
                ]
            };

            const result = decoder.decodeValue(0, definition);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields[0].value, 0);
        });

        test('Decode register with no fields', () => {
            const definition: RegisterDefinition = {
                name: 'EMPTY_REG',
                totalBits: 32,
                fields: []
            };

            const result = decoder.decodeValue(0x1234, definition);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields.length, 0);
        });

        test('Decode maximum value for field', () => {
            const definition: RegisterDefinition = {
                name: 'TEST_REG',
                totalBits: 32,
                fields: [
                    {
                        name: 'NIBBLE',
                        bitStart: 0,
                        bitEnd: 3,
                        bitWidth: 4
                    }
                ]
            };

            const result = decoder.decodeValue(0x0F, definition);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fields[0].value, 15);
        });
    });
});
