import * as assert from 'assert';
import {
    parseSizeValue,
    parseLinkerConstantExpression,
    parseLinkerScript,
    parseScatterFile,
    parseLinkerFile,
    parseLinkerFileWithDiagnostics,
} from '../linkerScriptParser';

suite('Linker Script Parser Test Suite', () => {
    suite('parseSizeValue', () => {
        test('should parse hex value', () => {
            assert.strictEqual(parseSizeValue('0x100000'), 0x100000);
        });

        test('should parse decimal value', () => {
            assert.strictEqual(parseSizeValue('4096'), 4096);
        });

        test('should parse K suffix', () => {
            assert.strictEqual(parseSizeValue('256K'), 256 * 1024);
        });

        test('should parse lowercase k suffix', () => {
            assert.strictEqual(parseSizeValue('64k'), 64 * 1024);
        });

        test('should parse M suffix', () => {
            assert.strictEqual(parseSizeValue('1M'), 1024 * 1024);
        });

        test('should parse lowercase m suffix', () => {
            assert.strictEqual(parseSizeValue('2m'), 2 * 1024 * 1024);
        });

        test('should parse hex with K suffix', () => {
            assert.strictEqual(parseSizeValue('0x10K'), 0x10 * 1024);
        });

        test('should handle whitespace', () => {
            assert.strictEqual(parseSizeValue('  512K  '), 512 * 1024);
        });

        test('should return null for invalid input', () => {
            assert.strictEqual(parseSizeValue('abc'), null);
        });

        test('should return null for empty string', () => {
            assert.strictEqual(parseSizeValue(''), null);
        });
    });

    suite('parseLinkerScript', () => {
        test('should parse standard MEMORY block', () => {
            const content = `
MEMORY
{
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 0x100000
    RAM (rwx)   : ORIGIN = 0x20000000, LENGTH = 0x40000
}

SECTIONS { }
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 2);
            assert.strictEqual(regions[0].name, 'FLASH');
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x100000);
            assert.strictEqual(regions[1].name, 'RAM');
            assert.strictEqual(regions[1].origin, 0x20000000);
            assert.strictEqual(regions[1].size, 0x40000);
        });

        test('should parse K/M suffixes', () => {
            const content = `
MEMORY
{
    FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1M
    RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 256K
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 2);
            assert.strictEqual(regions[0].size, 1024 * 1024);
            assert.strictEqual(regions[1].size, 256 * 1024);
        });

        test('should parse multiple regions', () => {
            const content = `
MEMORY
{
    FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 2M
    DTCM (rwx)  : ORIGIN = 0x20000000, LENGTH = 64K
    ITCM (rx)   : ORIGIN = 0x00100000, LENGTH = 32K
    RAM (rwx)   : ORIGIN = 0x20010000, LENGTH = 128K
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 4);
            assert.strictEqual(regions[0].name, 'FLASH');
            assert.strictEqual(regions[1].name, 'DTCM');
            assert.strictEqual(regions[2].name, 'ITCM');
            assert.strictEqual(regions[3].name, 'RAM');
        });

        test('should handle org/len shorthand', () => {
            const content = `
MEMORY
{
    FLASH (rx) : org = 0x08000000, len = 0x100000
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x100000);
        });

        test('should handle o/l shorthand', () => {
            const content = `
MEMORY
{
    RAM (rwx) : o = 0x20000000, l = 256K
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].size, 256 * 1024);
        });

        test('should return empty array when no MEMORY block', () => {
            const content = `SECTIONS { .text : { *(.text) } }`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 0);
        });

        test('should ignore comments and other content', () => {
            const content = `
/* Memory configuration */
MEMORY
{
    /* Flash memory */
    FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 512K
    /* RAM */
    RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 128K
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 2);
        });

        test('should handle no attributes', () => {
            const content = `
MEMORY
{
    FLASH : ORIGIN = 0x08000000, LENGTH = 1M
}
`;
            const regions = parseLinkerScript(content);
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'FLASH');
        });
    });

    suite('GNU constant expressions and incomplete results', () => {
        test('evaluates entire expressions, parentheses, precedence and multiline declarations', () => {
            const result = parseLinkerFileWithDiagnostics(`MEMORY {
                FLASH (rx) : ORIGIN = 0x08000000 + 4K,
                    LENGTH = 128K - 4K
                RAM (rw) : ORIGIN = (0x20000000 + 1024 * 2), LENGTH = (64K - 1K)
            }`, 'memory.ld');
            assert.deepStrictEqual(result.regions, [
                { name: 'FLASH', origin: 0x08001000, size: 124 * 1024 },
                { name: 'RAM', origin: 0x20000800, size: 63 * 1024 },
            ]);
            assert.deepStrictEqual(result.warnings, []);
            assert.strictEqual(parseLinkerConstantExpression('(10 / 3) * 1K + 10 % 4'), 3074);
            assert.strictEqual(parseLinkerConstantExpression('010 + 0X10'), 24);
            assert.strictEqual(parseLinkerConstantExpression('08'), null);
        });

        for (const expression of ['128K - RESERVE', '128K trailing', '(64K - 1K', '10 / 0', '1 << 4', '-1', '9007199254740991 + 2']) {
            test(`rejects the whole unsupported expression: ${expression}`, () => {
                const result = parseLinkerFileWithDiagnostics(`MEMORY {
                    FLASH : ORIGIN = 0x08000000, LENGTH = ${expression}
                    RAM : ORIGIN = 0x20000000, LENGTH = 4K
                }`, 'memory.ld');
                assert.deepStrictEqual(result.regions.map(region => region.name), ['RAM']);
                assert.ok(result.warnings.some(warning => warning.includes('FLASH')));
            });
        }

        test('comments cannot create fake regions or hide valid regions', () => {
            const result = parseLinkerFileWithDiagnostics(`/* MEMORY { FAKE : ORIGIN = 0, LENGTH = 1M } */
                MEMORY { FLASH : ORIGIN = 0x08000000, LENGTH = (128K /* reserved */ - 4K) }`, 'memory.ld');
            assert.deepStrictEqual(result.regions, [{ name: 'FLASH', origin: 0x08000000, size: 124 * 1024 }]);
            assert.deepStrictEqual(result.warnings, []);
        });

        test('missing fields and incomplete additional MEMORY blocks are diagnosed', () => {
            const result = parseLinkerFileWithDiagnostics(`MEMORY {
                FLASH : ORIGIN = 0, LENGTH = 4K
                RAM : ORIGIN = 0x20000000
            } MEMORY {`, 'memory.ld');
            assert.strictEqual(result.regions.length, 1);
            assert.strictEqual(result.warnings.length, 2);
        });

        test('scatter diagnostics also report a skipped symbolic region in partial results', () => {
            const result = parseLinkerFileWithDiagnostics(`LR_FLASH 0x08000000 1M {
                ER_FLASH 0x08000000 1M { }
                RW_RAM 0x20000000 RAM_SIZE { }
            }`, 'memory.sct');
            assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH']);
            assert.ok(result.warnings.some(warning => warning.includes('RW_RAM')));
        });
    });

    suite('Scatter completeness diagnostics', () => {
        for (const content of [
            'LR_FLASH 0x08000000 1M { ER_FLASH 0x08000000 64K { }',
            'LR_FLASH 0x08000000 1M { ER_FLASH 0x08000000 64K { } RW_RAM 0x20000000 RAM_SIZE }',
            'LR_FLASH 0x08000000 1M { ER_FLASH 0x08000000 64K { } RW_RAM 0x20000000 128K - 4K { } }',
        ]) {
            test(`partial valid regions cannot conceal an incomplete declaration: ${content}`, () => {
                const result = parseLinkerFileWithDiagnostics(content, 'memory.sct');
                assert.deepStrictEqual(result.regions, [{ name: 'ER_FLASH', origin: 0x08000000, size: 64 * 1024 }]);
                assert.ok(result.warnings.length > 0);
            });
        }

        test('whole scatter headers work across newlines and multiple regions on one line', () => {
            const result = parseLinkerFileWithDiagnostics(`LR_FLASH 0x08000000 1M
            {
                ER_FLASH 0x08000000 64K
                { } RW_RAM 0x20000000 128K { }
            }`, 'memory.sct');
            assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH', 'RW_RAM']);
            assert.deepStrictEqual(result.warnings, []);
        });
    });

    suite('parseScatterFile', () => {
        test('should parse basic scatter file', () => {
            const content = `
LR_IROM1 0x08000000 0x00100000 {
    ER_IROM1 0x08000000 0x00100000 {
        *.o (RESET, +First)
        *(InRoot$$Sections)
        .ANY (+RO)
    }
    RW_IRAM1 0x20000000 0x00040000 {
        .ANY (+RW +ZI)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.strictEqual(regions.length, 2);
            assert.strictEqual(regions[0].name, 'ER_IROM1');
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x00100000);
            assert.strictEqual(regions[1].name, 'RW_IRAM1');
            assert.strictEqual(regions[1].origin, 0x20000000);
            assert.strictEqual(regions[1].size, 0x00040000);
        });

        test('should handle multiple load regions', () => {
            const content = `
LR_IROM1 0x08000000 0x00080000 {
    ER_IROM1 0x08000000 0x00080000 {
        .ANY (+RO)
    }
}

LR_IROM2 0x08080000 0x00080000 {
    ER_IROM2 0x08080000 0x00080000 {
        .ANY (+RO)
    }
    RW_IRAM1 0x20000000 0x00020000 {
        .ANY (+RW +ZI)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.strictEqual(regions.length, 3);
        });

        test('should skip duplicate region names', () => {
            const content = `
LR1 0x00000000 0x100000 {
    ER_ROM 0x00000000 0x100000 {
        .ANY (+RO)
    }
}
LR2 0x10000000 0x100000 {
    ER_ROM 0x10000000 0x100000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'ER_ROM');
        });

        test('should return empty array for empty content', () => {
            const regions = parseScatterFile('');
            assert.strictEqual(regions.length, 0);
        });

        test('should not match load regions (top-level)', () => {
            // Load regions are not indented; only execution regions (indented) should match
            const content = `
LR_IROM1 0x08000000 0x00100000 {
    ER_IROM1 0x08000000 0x00100000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseScatterFile(content);
            // Should only get ER_IROM1, not LR_IROM1
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'ER_IROM1');
        });

        test('should keep execution region with same name as load region', () => {
            const content = `
SAME 0x08000000 0x00100000 {
    SAME +0 0x00010000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'SAME');
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x00010000);
        });

        test('should skip symbolic scatter sizes instead of misclassifying load regions', () => {
            const content = `
LR 0x08000000 0x00100000 {
    ER_SYM +0 ImageLimit(ER_SYM) {
        .ANY (+RO)
    }
    ER_OK 0x20000000 +0 {
        .ANY (+RW)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.deepStrictEqual(regions, [{ name: 'ER_OK', origin: 0x20000000, size: 0 }]);
        });

        test('should skip +offset execution region when the load origin is symbolic', () => {
            // The load region origin is a symbol, so the absolute address of a
            // '+offset' execution region cannot be resolved — the region must be
            // skipped rather than leaking the raw offset (0x10) as an absolute.
            const content = `
LR_SYM SymStart 0x100000 {
    ER +0x10 0x1000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.deepStrictEqual(regions, []);
        });

        test('should resolve +offset execution region against a numeric load origin', () => {
            const content = `
LR 0x08000000 0x100000 {
    ER +0x10 0x1000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseScatterFile(content);
            assert.deepStrictEqual(regions, [{ name: 'ER', origin: 0x08000010, size: 0x1000 }]);
        });
    });

    suite('parseLinkerFile', () => {
        test('should detect .sct file and use scatter parser', () => {
            const content = `
LR_IROM1 0x08000000 0x00100000 {
    ER_IROM1 0x08000000 0x00100000 {
        .ANY (+RO)
    }
}
`;
            const regions = parseLinkerFile(content, '/path/to/firmware.sct');
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'ER_IROM1');
        });

        test('should detect .ld file and use linker script parser', () => {
            const content = `
MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1M }
`;
            const regions = parseLinkerFile(content, '/path/to/link.ld');
            assert.strictEqual(regions.length, 1);
            assert.strictEqual(regions[0].name, 'FLASH');
        });

        test('should detect .lds file as linker script', () => {
            const content = `
MEMORY { RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
`;
            const regions = parseLinkerFile(content, 'firmware.lds');
            assert.strictEqual(regions.length, 1);
        });

        test('should default to linker script for unknown extension', () => {
            const content = `
MEMORY { FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 2M }
`;
            const regions = parseLinkerFile(content, 'linker.lcf');
            assert.strictEqual(regions.length, 1);
        });
    });

    suite('parseLinkerFileWithDiagnostics', () => {
        test('서로 다른 주소·크기의 Scatter 동명 영역은 누락을 진단한다', () => {
            for (const second of ['0x20000000 1K', '0x08000000 2K']) {
                const result = parseLinkerFileWithDiagnostics(
                    `LR 0x08000000 1M { ER 0x08000000 1K {} ER ${second} {} }`, 'firmware.sct'
                );
                assert.strictEqual(result.regions.length, 1);
                assert.ok(result.warnings.some(warning => /more than once/.test(warning)));
            }
            const identical = parseLinkerFileWithDiagnostics(
                'LR 0x08000000 1M { ER 0x08000000 1K {} ER 0x08000000 1K {} }', 'firmware.sct'
            );
            assert.deepStrictEqual(identical.warnings, []);
        });

        test('warns when input is empty', () => {
            const result = parseLinkerFileWithDiagnostics('', '/path/to/link.ld');
            assert.strictEqual(result.regions.length, 0);
            assert.strictEqual(result.warnings.length, 1);
            assert.match(result.warnings[0], /empty/i);
        });

        test('warns when .ld file has no MEMORY block', () => {
            const result = parseLinkerFileWithDiagnostics(
                'SECTIONS { .text : { *(.text) } }',
                '/path/to/link.ld'
            );
            assert.strictEqual(result.regions.length, 0);
            assert.ok(result.warnings.some(w => /MEMORY/.test(w)));
        });

        test('warns when MEMORY block has no matching region lines', () => {
            const result = parseLinkerFileWithDiagnostics(
                'MEMORY { /* empty */ }',
                '/path/to/link.ld'
            );
            assert.strictEqual(result.regions.length, 0);
            assert.ok(result.warnings.some(w => /no region lines/i.test(w)));
        });

        test('warns when .sct file has no execution regions', () => {
            const result = parseLinkerFileWithDiagnostics(
                'LR_IROM1 0x08000000 0x00100000 {\n}\n',
                '/path/to/file.sct'
            );
            assert.strictEqual(result.regions.length, 0);
            assert.ok(result.warnings.some(w => /execution regions/i.test(w)));
        });

        test('returns no warnings when regions are found', () => {
            const result = parseLinkerFileWithDiagnostics(
                'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1M }',
                '/path/to/link.ld'
            );
            assert.strictEqual(result.regions.length, 1);
            assert.strictEqual(result.warnings.length, 0);
        });
    });
});
