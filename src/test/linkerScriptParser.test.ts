import * as assert from 'assert';
import {
    parseSizeValue,
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
