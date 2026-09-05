import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
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

        test('GNU paths containing // or quoted comment markers do not hide MEMORY declarations', () => {
            for (const prefix of [
                'INPUT(/usr/lib//libc.a)',
                'INPUT("objects/path/*literal*/file.a")',
                'INPUT("objects//file.a")',
                'INPUT("MEMORY { FAKE : ORIGIN = 0, LENGTH = 1M }")',
            ]) {
                const result = parseLinkerFileWithDiagnostics(`${prefix} MEMORY { FLASH : ORIGIN = 0, LENGTH = 4K }`, 'memory.ld');
                assert.deepStrictEqual(result.regions, [{ name: 'FLASH', origin: 0, size: 4096 }], prefix);
                assert.deepStrictEqual(result.diagnostics, [], prefix);
            }
        });

        test('GNU // inside a MEMORY expression is not treated as a comment', () => {
            const result = parseLinkerFileWithDiagnostics('MEMORY { FLASH : ORIGIN = 0, LENGTH = 4K // invalid\n}', 'memory.ld');
            assert.deepStrictEqual(result.regions, []);
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete'));
        });

        test('masking quoted file names must not turn unsupported MEMORY expressions into constants', () => {
            for (const declaration of ['ORIGIN = 0 "symbol", LENGTH = 4K', 'ORIGIN = 0, LENGTH = 4K "symbol"']) {
                const result = parseLinkerFileWithDiagnostics(`MEMORY { FLASH : ${declaration} }`, 'memory.ld');
                assert.deepStrictEqual(result.regions, []);
                assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete'));
            }
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
        test('official attribute order accepts fixed execution regions and an optional load capacity', () => {
            for (const loadSize of ['', ' 1M']) {
                const result = parseLinkerFileWithDiagnostics(`LR_FLASH 0x08000000 ABSOLUTE NOCOMPRESS${loadSize} {
                    ER_FLASH + 0 FIXED NOCOMPRESS 64K { .ANY (+RO) }
                    RW_RAM 0x20000000 ABSOLUTE UNINIT 16K { .ANY (+RW +ZI) }
                }`, 'memory.sct');
                assert.deepStrictEqual(result.regions, [
                    { name: 'ER_FLASH', origin: 0x08000000, size: 64 * 1024 },
                    { name: 'RW_RAM', origin: 0x20000000, size: 16 * 1024 },
                ]);
                assert.deepStrictEqual(result.diagnostics, []);
            }
        });

        test('ScatterAssert before, between, and after regions is a note, not a skipped region', () => {
            const result = parseLinkerFileWithDiagnostics(`ScatterAssert(1)
                LR_FLASH 0x08000000 NOCOMPRESS 1M {
                    ScatterAssert(1) ER_FLASH +0 FIXED 64K { .ANY (+RO) }
                    ScatterAssert((ImageLength(ER_FLASH) + 4) < 65536)
                    RW_RAM 0x20000000 UNINIT 16K { .ANY (+ZI) }
                    ScatterAssert(ImageLimit(RW_RAM) <= 0x20004000)
                } ScatterAssert(1)`, 'memory.sct');
            assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH', 'RW_RAM']);
            assert.deepStrictEqual(result.warnings, []);
            assert.deepStrictEqual(result.diagnostics.map(({ kind, code }) => ({ kind, code })), [{ kind: 'note', code: 'scatter-assert' }]);
        });

        for (const tail of ['ScatterAssert()', 'ScatterAssert((1)', 'ScatterAssert(1))', 'ImageLimit(ER_FLASH)', 'RW_RAM 0x20000000 16K']) {
            test(`a note must not conceal malformed scatter structure: ${tail}`, () => {
                const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 { ER_FLASH +0 64K {} ${tail} }`, 'memory.sct');
                assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete'));
            });
        }

        for (const header of ['0x20000000 PI 16K', '0x20000000 RELOC 16K', '0x20000000 ALIGN 8 16K',
            '0x20000000 EMPTY -16K', '0x20000000 OVERLAY 16K', '0x20000000 16K UNINIT', '0x20000000 16K ALIGN 8']) {
            test(`unsupported address semantics or attribute order remains incomplete: ${header}`, () => {
                const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 { ER_FLASH +0 64K {} RW_RAM ${header} {} }`, 'memory.sct');
                assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH']);
                assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete' && diagnostic.regionName === 'RW_RAM'));
            });
        }

        test('PI/RELOC load attributes are not silently ignored for inherited execution addresses', () => {
            for (const attribute of ['PI', 'RELOC']) {
                const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 ${attribute} 1M { ER +0 64K {} }`, 'memory.sct');
                assert.deepStrictEqual(result.regions, []);
                assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete'));
            }
        });

        test('relative successors require actual linked lengths, not declared maximum sizes or the load base', () => {
            const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 1M {
                FIRST +0 64K {} NEXT +0x10 16K {}
            } LR_NEXT +0 1M { ER_NEXT +0 64K {} }`, 'memory.sct');
            assert.deepStrictEqual(result.regions, [{ name: 'FIRST', origin: 0x08000000, size: 64 * 1024 }]);
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.regionName === 'NEXT' && diagnostic.kind === 'incomplete'));
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.regionName === 'LR_NEXT' && diagnostic.kind === 'incomplete'));
        });

        test('conditional preprocessing is incomplete even when all literal region headers can be read', () => {
            const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 {
                ER_FLASH +0 64K {}
                #if 0
                RW_RAM 0x20000000 16K {}
                #endif
            }`, 'memory.sct');
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'incomplete' && diagnostic.code === 'scatter-preprocessor'));
        });

        test('quoted selector paths do not introduce comments or nested region braces', () => {
            const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 {
                ER_FLASH +0 64K { "Objects/a;{b}//c.o" (+RO) }
                RW_RAM 0x20000000 UNINIT 16K { .ANY (+ZI) }
            }`, 'memory.sct');
            assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH', 'RW_RAM']);
            assert.deepStrictEqual(result.diagnostics, []);
        });

        test('an even number of escaped path backslashes still permits the closing quote', () => {
            for (const count of [0, 2, 4]) {
                const backslashes = String.fromCharCode(92).repeat(count);
                const result = parseLinkerFileWithDiagnostics(`LR 0x08000000 {
                    ER_FLASH +0 64K { "Objects/path${backslashes}" (+RO) }
                    RW_RAM 0x20000000 16K {}
                }`, 'memory.sct');
                assert.deepStrictEqual(result.regions.map(region => region.name), ['ER_FLASH', 'RW_RAM']);
                assert.deepStrictEqual(result.diagnostics, []);
            }
        });

        test('repository scatter fixture exposes every fixed region with assertion notes only', () => {
            const fixture = fs.readFileSync(path.resolve(__dirname, '../../examples/sample_memory.sct'), 'utf8');
            const result = parseLinkerFileWithDiagnostics(fixture, 'sample_memory.sct');
            assert.deepStrictEqual(result.regions, [
                { name: 'ER_IROM1', origin: 0x08000000, size: 0x80000 },
                { name: 'RW_IRAM1', origin: 0x20000000, size: 0xf000 },
                { name: 'RW_NOINIT', origin: 0x2000f000, size: 0x1000 },
            ]);
            assert.deepStrictEqual(result.warnings, []);
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.kind === 'note'));
        });

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
