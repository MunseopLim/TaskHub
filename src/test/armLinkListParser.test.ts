import * as assert from 'assert';
import {
    parseArmLinkList,
    toMemoryRegions,
    toElfSections,
    toAggregatedSummary,
    toMemoryUsage,
    toObjectSummary,
} from '../armLinkListParser';

// Sample ARM Compiler 6 listing (Exec base format)
const SAMPLE_AC6 = `
==============================================================================

Image component sizes

      Code (inc. data)   RO Data    RW Data    ZI Data      Debug   Object Name

      1024        128        256         16       1024       4096   main.o
       256         32         64          0          0       2048   startup.o

    ----------------------------------------------------------------------
      1280        160        320         16       1024       6144   Object Totals

==============================================================================

    Image Entry point : 0x08000199

  Load Region LR_IROM1 (Base: 0x08000000, Size: 0x00000640, Max: 0x00080000, ABSOLUTE, PI)

    Execution Region ER_IROM1 (Exec base: 0x08000000, Load base: 0x08000000, Size: 0x00000640, Max: 0x00080000, ABSOLUTE, FIXED)

    0x08000000   0x00000100   Data   RO          280    startup.o(RESET)
    0x08000100   0x00000040   Code   RO          283    startup.o(.text)
    0x08000140   0x00000400   Code   RO         2899    main.o(.text)
    0x08000540   0x00000100   Data   RO         2900    main.o(.constdata)

    Execution Region RW_IRAM1 (Exec base: 0x20000000, Load base: 0x08000640, Size: 0x00000410, Max: 0x00020000, ABSOLUTE, FIXED)

    0x20000000   0x00000010   Data   RW         3001    main.o(.data)
    0x20000010   0x00000400   Zero   ZI         3002    main.o(.bss)

==============================================================================

      Total RO  Size (Code + RO Data)         1600 (   1.56kB)
      Total RW  Size (RW Data + ZI Data)      1040 (   1.02kB)
      Total ROM Size (Code + RO Data + RW Data)  1616 (   1.58kB)
`;

// Sample ARM Compiler 5 listing (Base format, no "Exec base")
const SAMPLE_AC5 = `
==============================================================================

    Image Entry point : 0x08000000

  Load Region LR_IROM1 (Base: 0x08000000, Size: 0x00000300, Max: 0x00040000, ABSOLUTE)

    Execution Region ER_IROM1 (Base: 0x08000000, Size: 0x00000300, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000100   Code   RO            1    startup.o(RESET)
    0x08000100   0x00000004   PAD
    0x08000104   0x00000100   Code   RO            2    main.o(i.main)
    0x08000204   0x000000fc   Data   RO            3    main.o(.constdata)

    Execution Region RW_IRAM1 (Base: 0x20000000, Size: 0x00000200, Max: 0x00010000, ABSOLUTE)

    0x20000000   0x00000200   Zero   ZI            4    main.o(.bss)

==============================================================================

      Total RO  Size (Code + RO Data)          764 (   0.75kB)
      Total RW  Size (RW Data + ZI Data)       512 (   0.50kB)
      Total ROM Size (Code + RO Data + RW Data)   764 (   0.75kB)
`;

suite('ArmLinkListParser Test Suite', () => {
    suite('parseArmLinkList', () => {
        test('should parse AC6 execution regions', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            assert.strictEqual(result.execRegions.length, 2);

            const flash = result.execRegions[0];
            assert.strictEqual(flash.name, 'ER_IROM1');
            assert.strictEqual(flash.execBase, 0x08000000);
            assert.strictEqual(flash.maxSize, 0x00080000);
            assert.strictEqual(flash.entries.length, 4);

            const ram = result.execRegions[1];
            assert.strictEqual(ram.name, 'RW_IRAM1');
            assert.strictEqual(ram.execBase, 0x20000000);
            assert.strictEqual(ram.maxSize, 0x00020000);
            assert.strictEqual(ram.entries.length, 2);
        });

        test('should parse AC5 format (Base instead of Exec base)', () => {
            const result = parseArmLinkList(SAMPLE_AC5);
            assert.strictEqual(result.execRegions.length, 2);

            const flash = result.execRegions[0];
            assert.strictEqual(flash.name, 'ER_IROM1');
            assert.strictEqual(flash.execBase, 0x08000000);
            assert.strictEqual(flash.maxSize, 0x00040000);
        });

        test('should parse entry point', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            assert.strictEqual(result.entryPoint, 0x08000199);
        });

        test('should parse image totals', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            assert.strictEqual(result.totals.roSize, 1600);
            assert.strictEqual(result.totals.rwSize, 1040);
            assert.strictEqual(result.totals.romSize, 1616);
        });

        test('should parse section entries with object and section names', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const entries = result.execRegions[0].entries;

            assert.strictEqual(entries[0].object, 'startup.o');
            assert.strictEqual(entries[0].section, 'RESET');
            assert.strictEqual(entries[0].kind, 'Data');
            assert.strictEqual(entries[0].attr, 'RO');
            assert.strictEqual(entries[0].addr, 0x08000000);
            assert.strictEqual(entries[0].size, 0x100);

            assert.strictEqual(entries[2].object, 'main.o');
            assert.strictEqual(entries[2].section, '.text');
            assert.strictEqual(entries[2].kind, 'Code');
            assert.strictEqual(entries[2].size, 0x400);
        });

        test('should skip PAD entries', () => {
            const result = parseArmLinkList(SAMPLE_AC5);
            const flash = result.execRegions[0];
            // PAD at 0x08000100 should be skipped → 3 entries, not 4
            assert.strictEqual(flash.entries.length, 3);
            assert.ok(flash.entries.every(e => e.kind !== 'PAD'));
        });

        test('should handle empty content', () => {
            const result = parseArmLinkList('');
            assert.strictEqual(result.execRegions.length, 0);
            assert.strictEqual(result.entryPoint, 0);
        });

        test('should handle content with no memory map section', () => {
            const content = `
==============================================================================
      Total RO  Size (Code + RO Data)         2048 (   2.00kB)
      Total RW  Size (RW Data + ZI Data)       256 (   0.25kB)
      Total ROM Size (Code + RO Data + RW Data)  2060 (   2.01kB)
`;
            const result = parseArmLinkList(content);
            assert.strictEqual(result.execRegions.length, 0);
            assert.strictEqual(result.totals.roSize, 2048);
            assert.strictEqual(result.totals.rwSize, 256);
        });

        test('should handle varied whitespace between columns', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000,  Load base: 0x08000000,  Size: 0x00000100,  Max: 0x00040000, ABSOLUTE)

    0x08000000    0x00000080     Code    RO           1     main.o(.text)
    0x08000080   0x00000080   Data   RO         2   main.o(.rodata)
`;
            const result = parseArmLinkList(content);
            assert.strictEqual(result.execRegions.length, 1);
            assert.strictEqual(result.execRegions[0].entries.length, 2);
            assert.strictEqual(result.execRegions[0].entries[0].size, 0x80);
            assert.strictEqual(result.execRegions[0].entries[1].section, '.rodata');
        });
    });

    suite('toMemoryRegions', () => {
        test('should convert execution regions to MemoryRegion array', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const regions = toMemoryRegions(result);

            assert.strictEqual(regions.length, 2);
            assert.strictEqual(regions[0].name, 'ER_IROM1');
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x00080000);
            assert.strictEqual(regions[1].name, 'RW_IRAM1');
            assert.strictEqual(regions[1].origin, 0x20000000);
            assert.strictEqual(regions[1].size, 0x00020000);
        });

        test('should filter out regions with maxSize 0', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            // Force a region with maxSize 0
            result.execRegions.push({
                name: 'EMPTY',
                execBase: 0,
                size: 0,
                maxSize: 0,
                entries: [],
            });
            const regions = toMemoryRegions(result);
            assert.strictEqual(regions.length, 2); // EMPTY filtered out
        });
    });

    suite('toElfSections', () => {
        test('should convert entries to ElfSection array', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const sections = toElfSections(result);

            // 4 flash + 2 ram = 6 sections
            assert.strictEqual(sections.length, 6);

            // Check first entry (startup.o RESET → Data RO)
            const reset = sections[0];
            assert.strictEqual(reset.name, 'RESET');
            assert.strictEqual(reset.addr, 0x08000000);
            assert.strictEqual(reset.isExec, false);
            assert.strictEqual(reset.isWrite, false);
            assert.strictEqual(reset.isNoBits, false);

            // Check .text entry (Code RO)
            const text = sections[1];
            assert.strictEqual(text.name, '.text');
            assert.strictEqual(text.isExec, true);

            // Check .bss entry (Zero ZI)
            const bss = sections[5];
            assert.strictEqual(bss.name, '.bss');
            assert.strictEqual(bss.isNoBits, true);
            assert.strictEqual(bss.addr, 0x20000010);
        });

        test('should skip zero-size entries', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            // Add a zero-size entry
            result.execRegions[0].entries.push({
                addr: 0x08001000, size: 0, kind: 'Code', attr: 'RO', object: 'empty.o', section: '.text', func: '',
            });
            const sections = toElfSections(result);
            assert.strictEqual(sections.length, 6); // zero-size not included
        });

        test('should use section name, falling back to object name', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const sections = toElfSections(result);
            // First entry has section="RESET" → name should be "RESET"
            assert.strictEqual(sections[0].name, 'RESET');
        });
    });

    suite('toAggregatedSummary', () => {
        test('should aggregate entries by section name', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toAggregatedSummary(result);

            // RESET, .text (2 entries merged), .constdata, .data, .bss → 5 groups
            assert.strictEqual(summary.length, 5);

            // .text should be aggregated from startup.o(.text) + main.o(.text)
            const text = summary.find(s => s.name === '.text');
            assert.ok(text);
            assert.strictEqual(text!.size, 0x40 + 0x400); // 64 + 1024 = 1088
            assert.strictEqual(text!.addr, 0x08000100); // min addr
            assert.strictEqual(text!.endAddr, 0x08000540); // max end
            assert.strictEqual(text!.type, 'CODE');
        });

        test('should classify types correctly', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toAggregatedSummary(result);

            const reset = summary.find(s => s.name === 'RESET');
            assert.strictEqual(reset!.type, 'RODATA'); // Data RO

            const bss = summary.find(s => s.name === '.bss');
            assert.strictEqual(bss!.type, 'NOBITS'); // Zero ZI

            const data = summary.find(s => s.name === '.data');
            assert.strictEqual(data!.type, 'DATA'); // Data RW
        });

        test('should sort by address', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toAggregatedSummary(result);

            for (let i = 1; i < summary.length; i++) {
                assert.ok(summary[i].addr >= summary[i - 1].addr,
                    `${summary[i].name} (${summary[i].addr}) should come after ${summary[i - 1].name} (${summary[i - 1].addr})`);
            }
        });
    });

    suite('toMemoryUsage', () => {
        test('should compute used per region from own entries only', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);

            assert.strictEqual(usages.length, 2);

            const flash = usages[0];
            assert.strictEqual(flash.region, 'ER_IROM1');
            assert.strictEqual(flash.total, 0x00080000);
            // 0x100 + 0x40 + 0x400 + 0x100 = 0x640
            assert.strictEqual(flash.used, 0x640);
            assert.strictEqual(flash.sections.length, 4);

            const ram = usages[1];
            assert.strictEqual(ram.region, 'RW_IRAM1');
            assert.strictEqual(ram.total, 0x00020000);
            // 0x10 + 0x400 = 0x410
            assert.strictEqual(ram.used, 0x410);
            assert.strictEqual(ram.sections.length, 2);
        });

        test('should include reportedUsed from linker', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);

            assert.strictEqual(usages[0].reportedUsed, 0x640);
            assert.strictEqual(usages[1].reportedUsed, 0x410);
        });

        test('should compute free spaces correctly', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);

            const flash = usages[0];
            // Sections: 0x08000000-0x08000100, 0x08000100-0x08000140, 0x08000140-0x08000540, 0x08000540-0x08000640
            // No gap between sections; free space at end: 0x08000640 to 0x08080000
            assert.ok(flash.freeSpaces.length >= 1);
            const tailFree = flash.freeSpaces[flash.freeSpaces.length - 1];
            assert.strictEqual(tailFree.addr, 0x08000640);
            assert.strictEqual(tailFree.size, 0x00080000 - 0x640);

            const ram = usages[1];
            // Sections: 0x20000000-0x20000010, 0x20000010-0x20000410
            // Free at end: 0x20000410 to 0x20020000
            const ramTailFree = ram.freeSpaces[ram.freeSpaces.length - 1];
            assert.strictEqual(ramTailFree.addr, 0x20000410);
            assert.strictEqual(ramTailFree.size, 0x00020000 - 0x410);
        });

        test('should filter out alignment padding (< 4 bytes) from freeSpaces', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);
            for (const u of usages) {
                for (const f of u.freeSpaces) {
                    assert.ok(f.size >= 4, `freeSpace size ${f.size} in ${u.region} should be >= 4`);
                }
            }
        });

        test('should not cross-count sections between regions', () => {
            // AC5 sample has overlapping address ranges between regions
            const result = parseArmLinkList(SAMPLE_AC5);
            const usages = toMemoryUsage(result);

            const flash = usages[0];
            const ram = usages[1];

            // Flash should only count its 3 entries, RAM only its 1 entry
            assert.strictEqual(flash.sections.length, 3);
            assert.strictEqual(ram.sections.length, 1);

            // RAM used = 0x200 only (just .bss)
            assert.strictEqual(ram.used, 0x200);
        });

        test('should filter out regions with maxSize 0', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            result.execRegions.push({
                name: 'EMPTY',
                execBase: 0,
                size: 0,
                maxSize: 0,
                entries: [],
            });
            const usages = toMemoryUsage(result);
            assert.strictEqual(usages.length, 2);
        });

        test('should include object info in section entries', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);
            const flash = usages[0];
            // name now comes from entry.object (e.g., "main.o")
            const mainEntry = flash.sections.find(s => s.name === 'main.o' && s.object === 'main.o');
            assert.ok(mainEntry, 'Should have entry with name=main.o');
            assert.strictEqual(mainEntry!.object, 'main.o');
        });

        test('should include section name in entries', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const usages = toMemoryUsage(result);
            const flash = usages[0];
            // .text section from main.o(.text)
            const textEntry = flash.sections.find(s => s.name === 'main.o' && s.section === '.text');
            assert.ok(textEntry, 'Should have entry with section=.text');
            assert.strictEqual(textEntry!.section, '.text');
        });
    });

    suite('toObjectSummary', () => {
        test('should group entries by object name', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toObjectSummary(result);

            // main.o and startup.o
            assert.strictEqual(summary.length, 2);
        });

        test('should sort by total size descending', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toObjectSummary(result);

            // main.o should be first (larger total)
            assert.strictEqual(summary[0].object, 'main.o');
            assert.ok(summary[0].totalSize > summary[1].totalSize);
        });

        test('should categorize sizes correctly for main.o', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toObjectSummary(result);
            const mainObj = summary.find(o => o.object === 'main.o')!;

            // main.o: .text (Code 0x400), .constdata (Data RO 0x100), .data (Data RW 0x10), .bss (Zero ZI 0x400)
            assert.strictEqual(mainObj.codeSize, 0x400);
            assert.strictEqual(mainObj.roSize, 0x100);
            assert.strictEqual(mainObj.dataSize, 0x10);
            assert.strictEqual(mainObj.bssSize, 0x400);
            assert.strictEqual(mainObj.totalSize, 0x400 + 0x100 + 0x10 + 0x400);
        });

        test('should include individual entries', () => {
            const result = parseArmLinkList(SAMPLE_AC6);
            const summary = toObjectSummary(result);
            const startupObj = summary.find(o => o.object === 'startup.o')!;

            assert.strictEqual(startupObj.entries.length, 2);
            assert.ok(startupObj.entries.find(e => e.section === 'RESET'));
            assert.ok(startupObj.entries.find(e => e.section === '.text'));
        });
    });

    suite('func extraction', () => {
        test('should extract function name from section token with .text. prefix', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000080   Code   RO         1    .text._ZN4Test8FuncNameEv    c_2.l(testfunc.o)
    0x08000080   0x00000040   Code   RO         2    .text.main    main.o(.text)
`;
            const result = parseArmLinkList(content);
            const entries = result.execRegions[0].entries;
            assert.strictEqual(entries.length, 2);

            // lib(obj.o) pattern: object = testfunc.o, func = _ZN4Test8FuncNameEv
            assert.strictEqual(entries[0].object, 'testfunc.o');
            assert.strictEqual(entries[0].func, '_ZN4Test8FuncNameEv');
            assert.strictEqual(entries[0].section, '.text');

            // object(.section) pattern: object = main.o, section = .text
            assert.strictEqual(entries[1].object, 'main.o');
            assert.strictEqual(entries[1].section, '.text');
            assert.strictEqual(entries[1].func, 'main');
        });

        test('should extract function name from .rodata. prefix', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000020   Data   RO         1    .rodata.myConst    main.o(.rodata)
`;
            const result = parseArmLinkList(content);
            assert.strictEqual(result.execRegions[0].entries[0].func, 'myConst');
        });

        test('should extract func from unknown .section.func pattern, empty for plain token', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000080   Code   RO         1    .mysection.SomeFunc    lib.a(custom.o)
    0x08000080   0x00000080   Code   RO         2    custom_section    other.a(mod.o)
`;
            const result = parseArmLinkList(content);
            // Unknown .prefix.func → extract func after second dot
            assert.strictEqual(result.execRegions[0].entries[0].func, 'SomeFunc');
            // Plain token without dot prefix → no func
            assert.strictEqual(result.execRegions[0].entries[1].func, '');
        });

        test('should have empty func when no section token (object(.section) only)', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000100   Code   RO         1    startup.o(RESET)
`;
            const result = parseArmLinkList(content);
            assert.strictEqual(result.execRegions[0].entries[0].func, '');
        });

        test('should extract function from entries without parentheses (object.o at end)', () => {
            const content = `
    Execution Region TEST_RO (Base: 0x00001000, Size: 0x00002000, Max: 0x00003000, ABSOLUTE)

    0x00001000   0x00000004   Code   RO         7955    .text                           c_2.l(use_no_semi.o)
    0x00001004   0x00000004   Code   RO         7957    .text._ZL16CheckTestFunctionEv  TestMgr.o
    0x00001008   0x00000020   Data   RO         7960    .rodata.kConfigTable            Config.o
`;
            const result = parseArmLinkList(content);
            const entries = result.execRegions[0].entries;
            assert.strictEqual(entries.length, 3);

            // First entry: lib(obj.o) pattern — no function in plain .text
            assert.strictEqual(entries[0].object, 'use_no_semi.o');
            assert.strictEqual(entries[0].section, '.text');
            assert.strictEqual(entries[0].func, '');

            // Second entry: .text._ZL16CheckTestFunctionEv TestMgr.o (no parens)
            assert.strictEqual(entries[1].object, 'TestMgr.o');
            assert.strictEqual(entries[1].section, '.text');
            assert.strictEqual(entries[1].func, '_ZL16CheckTestFunctionEv');

            // Third entry: .rodata.kConfigTable Config.o (no parens)
            assert.strictEqual(entries[2].object, 'Config.o');
            assert.strictEqual(entries[2].section, '.rodata');
            assert.strictEqual(entries[2].func, 'kConfigTable');
        });

        test('should handle mixed parenthesized and non-parenthesized objects', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000080   Code   RO         1    .text._ZN6Driver4InitEv       c_2.l(driver.o)
    0x08000080   0x00000040   Code   RO         2    .text._ZN6Logger3LogEPKc      Logger.o
    0x080000c0   0x00000020   Code   RO         3    .text                         main.o(.text)
`;
            const result = parseArmLinkList(content);
            const entries = result.execRegions[0].entries;

            // lib(obj.o) with function
            assert.strictEqual(entries[0].object, 'driver.o');
            assert.strictEqual(entries[0].func, '_ZN6Driver4InitEv');

            // object.o without parens, with function
            assert.strictEqual(entries[1].object, 'Logger.o');
            assert.strictEqual(entries[1].func, '_ZN6Logger3LogEPKc');

            // object(.section) without function
            assert.strictEqual(entries[2].object, 'main.o');
            assert.strictEqual(entries[2].section, '.text');
            assert.strictEqual(entries[2].func, '');
        });

        test('should set name to object and pass section in toMemoryUsage', () => {
            const content = `
    Execution Region ER_IROM1 (Exec base: 0x08000000, Size: 0x00000100, Max: 0x00040000, ABSOLUTE)

    0x08000000   0x00000080   Code   RO         1    .text._ZN4Test8FuncEv    c_2.l(testfunc.o)
`;
            const result = parseArmLinkList(content);
            const usages = toMemoryUsage(result);
            const entry = usages[0].sections[0];
            assert.strictEqual(entry.name, 'testfunc.o');
            assert.strictEqual(entry.section, '.text');
            assert.strictEqual(entry.func, '_ZN4Test8FuncEv');
        });
    });
});
