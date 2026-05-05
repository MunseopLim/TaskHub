import * as assert from 'assert';
import {
    parseElf32,
    classifySections,
    computeMemoryUsage,
    computeSymbolUsage,
    autoDetectRegions,
    summarizeSections,
    generateTextReport,
    generateSummaryReport,
    formatSize,
    formatHex,
    ElfSection,
    ElfSymbol,
    ElfSegment,
    MemoryRegion,
} from '../elfParser';

/**
 * Helper to build a minimal ELF32 little-endian binary in a Buffer.
 * Only constructs the ELF header, section headers, and string table.
 */
function buildMinimalElf32(sections: {
    name: string;
    type: number;
    flags: number;
    addr: number;
    size: number;
}[]): Buffer {
    // Section names: build string table (index 0 is always \0)
    let strTab = '\0';
    const nameOffsets: number[] = [];
    for (const sec of sections) {
        nameOffsets.push(strTab.length);
        strTab += sec.name + '\0';
    }
    // Add the .shstrtab entry itself
    const shstrtabNameOffset = strTab.length;
    strTab += '.shstrtab\0';

    const strTabBuf = Buffer.from(strTab, 'ascii');

    // Layout: ELF header (52 bytes) | string table | section headers
    const elfHeaderSize = 52;
    const shEntSize = 40;
    // Sections: null (index 0) + user sections + .shstrtab
    const totalSections = 1 + sections.length + 1;
    const strTabOffset = elfHeaderSize;
    const shOffset = elfHeaderSize + strTabBuf.length;
    const totalSize = shOffset + totalSections * shEntSize;

    const buf = Buffer.alloc(totalSize, 0);

    // ELF header
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // magic
    buf[4] = 1;     // ELFCLASS32
    buf[5] = 1;     // ELFDATA2LSB (little-endian)
    buf[6] = 1;     // EV_CURRENT
    buf.writeUInt16LE(2, 16);       // e_type: ET_EXEC
    buf.writeUInt16LE(40, 18);      // e_machine: ARM
    buf.writeUInt32LE(1, 20);       // e_version
    buf.writeUInt32LE(0x08000000, 24); // e_entry (entry point)
    buf.writeUInt32LE(shOffset, 32);   // e_shoff
    buf.writeUInt16LE(elfHeaderSize, 40); // e_ehsize
    buf.writeUInt16LE(shEntSize, 46);     // e_shentsize
    buf.writeUInt16LE(totalSections, 48); // e_shnum
    buf.writeUInt16LE(totalSections - 1, 50); // e_shstrndx (last section)

    // Copy string table data
    strTabBuf.copy(buf, strTabOffset);

    // Write section headers
    // Index 0: null section (already zeroed)

    // User sections (indices 1..N)
    for (let i = 0; i < sections.length; i++) {
        const base = shOffset + (i + 1) * shEntSize;
        buf.writeUInt32LE(nameOffsets[i], base);       // sh_name
        buf.writeUInt32LE(sections[i].type, base + 4); // sh_type
        buf.writeUInt32LE(sections[i].flags, base + 8);// sh_flags
        buf.writeUInt32LE(sections[i].addr, base + 12);// sh_addr
        buf.writeUInt32LE(strTabOffset, base + 16);    // sh_offset (dummy)
        buf.writeUInt32LE(sections[i].size, base + 20);// sh_size
    }

    // .shstrtab section header (last)
    const shstrtabBase = shOffset + (totalSections - 1) * shEntSize;
    buf.writeUInt32LE(shstrtabNameOffset, shstrtabBase);  // sh_name
    buf.writeUInt32LE(3, shstrtabBase + 4);                // sh_type: SHT_STRTAB
    buf.writeUInt32LE(0, shstrtabBase + 8);                // sh_flags
    buf.writeUInt32LE(0, shstrtabBase + 12);               // sh_addr
    buf.writeUInt32LE(strTabOffset, shstrtabBase + 16);    // sh_offset
    buf.writeUInt32LE(strTabBuf.length, shstrtabBase + 20);// sh_size

    return buf;
}

// Constants
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

suite('ELF Parser Test Suite', () => {
    suite('parseElf32', () => {
        test('should parse valid ELF32 with sections', () => {
            const buf = buildMinimalElf32([
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 4096 },
                { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08001000, size: 512 },
                { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 256 },
                { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000100, size: 1024 },
            ]);
            const result = parseElf32(buf);
            assert.strictEqual(result.isLittleEndian, true);
            assert.strictEqual(result.entryPoint, 0x08000000);

            const allocSections = result.sections.filter(s => s.isAlloc);
            assert.strictEqual(allocSections.length, 4);

            const text = result.sections.find(s => s.name === '.text');
            assert.ok(text);
            assert.strictEqual(text!.size, 4096);
            assert.strictEqual(text!.isExec, true);
            assert.strictEqual(text!.isNoBits, false);

            const bss = result.sections.find(s => s.name === '.bss');
            assert.ok(bss);
            assert.strictEqual(bss!.isNoBits, true);
            assert.strictEqual(bss!.isWrite, true);
        });

        test('should throw for non-ELF file', () => {
            // Use a buffer larger than the ELF header size so the size-guard does not
            // short-circuit before the magic-number check runs.
            const buf = Buffer.alloc(64);
            buf.write('Not an ELF file', 0);
            assert.throws(() => parseElf32(buf), /invalid magic number/);
        });

        test('should throw for ELF64', () => {
            const buf = buildMinimalElf32([]);
            buf[4] = 2; // ELFCLASS64
            assert.throws(() => parseElf32(buf), /Only 32-bit/);
        });

        test('should throw for invalid data encoding', () => {
            const buf = buildMinimalElf32([]);
            buf[5] = 0; // ELFDATANONE
            assert.throws(() => parseElf32(buf), /Unsupported data encoding/);
        });

        test('should parse ELF with no user sections', () => {
            const buf = buildMinimalElf32([]);
            const result = parseElf32(buf);
            // Only null section and .shstrtab
            const allocSections = result.sections.filter(s => s.isAlloc);
            assert.strictEqual(allocSections.length, 0);
        });
    });

    suite('classifySections', () => {
        const sections: ElfSection[] = [
            { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 4096, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
            { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08001000, size: 512, isAlloc: true, isWrite: false, isExec: false, isNoBits: false },
            { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 256, isAlloc: true, isWrite: true, isExec: false, isNoBits: false },
            { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000100, size: 1024, isAlloc: true, isWrite: true, isExec: false, isNoBits: true },
            { name: '.debug', type: 0, flags: 0, addr: 0, size: 2048, isAlloc: false, isWrite: false, isExec: false, isNoBits: false },
        ];

        test('should classify flash sections (text + rodata, not data)', () => {
            const { flash } = classifySections(sections);
            const names = flash.map(s => s.name);
            assert.ok(names.includes('.text'));
            assert.ok(names.includes('.rodata'));
            assert.ok(!names.includes('.data'), '.data should be RAM only (VMA-based)');
            assert.ok(!names.includes('.bss'));
            assert.ok(!names.includes('.debug'));
        });

        test('should classify ram sections (data + bss)', () => {
            const { ram } = classifySections(sections);
            const names = ram.map(s => s.name);
            assert.ok(names.includes('.data'));
            assert.ok(names.includes('.bss'));
            assert.ok(!names.includes('.text'));
        });

        test('should skip non-alloc and zero-size sections', () => {
            const { flash, ram } = classifySections(sections);
            assert.ok(!flash.find(s => s.name === '.debug'));
            assert.ok(!ram.find(s => s.name === '.debug'));
        });

        test('.data should appear in ram only (VMA-based classification)', () => {
            const { flash, ram } = classifySections(sections);
            assert.ok(!flash.find(s => s.name === '.data'));
            assert.ok(ram.find(s => s.name === '.data'));
        });
    });

    suite('computeMemoryUsage', () => {
        const sections: ElfSection[] = [
            { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 4096, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
            { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08001000, size: 512, isAlloc: true, isWrite: false, isExec: false, isNoBits: false },
            { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 256, isAlloc: true, isWrite: true, isExec: false, isNoBits: false },
            { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000100, size: 1024, isAlloc: true, isWrite: true, isExec: false, isNoBits: true },
        ];

        const regions: MemoryRegion[] = [
            { name: 'FLASH', origin: 0x08000000, size: 0x100000 },  // 1MB
            { name: 'RAM', origin: 0x20000000, size: 0x40000 },     // 256KB
        ];

        test('should compute usage per region', () => {
            const usages = computeMemoryUsage(sections, regions);
            assert.strictEqual(usages.length, 2);

            const flash = usages.find(u => u.region === 'FLASH');
            assert.ok(flash);
            assert.strictEqual(flash!.used, 4096 + 512); // .text + .rodata
            assert.strictEqual(flash!.total, 0x100000);

            const ram = usages.find(u => u.region === 'RAM');
            assert.ok(ram);
            assert.strictEqual(ram!.used, 256 + 1024); // .data + .bss
            assert.strictEqual(ram!.total, 0x40000);
        });

        test('should sort sections by size descending', () => {
            const usages = computeMemoryUsage(sections, regions);
            const ram = usages.find(u => u.region === 'RAM')!;
            assert.strictEqual(ram.sections[0].name, '.bss');  // 1024 > 256
            assert.strictEqual(ram.sections[1].name, '.data');
        });

        test('should compute free spaces between sections', () => {
            const usages = computeMemoryUsage(sections, regions);
            const flash = usages.find(u => u.region === 'FLASH')!;
            // .text: 0x08000000-0x08001000, .rodata: 0x08001000-0x08001200 (contiguous)
            // Free at end: 0x08001200 to 0x08100000
            assert.strictEqual(flash.freeSpaces.length, 1);
            assert.strictEqual(flash.freeSpaces[0].addr, 0x08001200);
            assert.strictEqual(flash.freeSpaces[0].size, 0x100000 - 0x1200);
        });

        test('should filter out alignment padding (< 4 bytes) from freeSpaces', () => {
            const paddedSections: ElfSection[] = [
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x101, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
                { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08000104, size: 0x100, isAlloc: true, isWrite: false, isExec: false, isNoBits: false },
            ];
            const rgn: MemoryRegion[] = [{ name: 'FLASH', origin: 0x08000000, size: 0x10000 }];
            const usages = computeMemoryUsage(paddedSections, rgn);
            const flash = usages[0];
            // Gap between .text and .rodata is 3 bytes (0x08000101-0x08000104) → filtered out
            // Only tail free (>= 4 bytes) should remain
            for (const f of flash.freeSpaces) {
                assert.ok(f.size >= 4, `freeSpace size ${f.size} should be >= 4`);
            }
        });

        test('should handle overlapping sections without inflating free space', () => {
            const overlapping: ElfSection[] = [
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x200, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
                { name: '.text2', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000100, size: 0x80, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
            ];
            const rgn: MemoryRegion[] = [{ name: 'FLASH', origin: 0x08000000, size: 0x1000 }];
            const usages = computeMemoryUsage(overlapping, rgn);
            const flash = usages[0];
            // .text ends at 0x200, .text2 ends at 0x180 (overlaps, cursor stays at 0x200)
            // Free: 0x200 to 0x1000 = 0xE00
            assert.strictEqual(flash.freeSpaces.length, 1);
            assert.strictEqual(flash.freeSpaces[0].addr, 0x08000200);
            assert.strictEqual(flash.freeSpaces[0].size, 0x1000 - 0x200);
        });

        test('should return empty usage for non-matching region', () => {
            const otherRegion: MemoryRegion[] = [{ name: 'DTCM', origin: 0x30000000, size: 0x10000 }];
            const usages = computeMemoryUsage(sections, otherRegion);
            assert.strictEqual(usages[0].used, 0);
            assert.strictEqual(usages[0].sections.length, 0);
        });
    });

    suite('summarizeSections', () => {
        test('should filter and sort by address', () => {
            const sections: ElfSection[] = [
                { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000100, size: 1024, isAlloc: true, isWrite: true, isExec: false, isNoBits: true },
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 4096, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
                { name: '.debug', type: 0, flags: 0, addr: 0, size: 2048, isAlloc: false, isWrite: false, isExec: false, isNoBits: false },
            ];
            const summary = summarizeSections(sections);
            assert.strictEqual(summary.length, 2); // .debug excluded
            assert.strictEqual(summary[0].name, '.text');  // lower addr first
            assert.strictEqual(summary[1].name, '.bss');
        });

        test('should assign correct type labels', () => {
            const sections: ElfSection[] = [
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0, size: 100, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
                { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 100, size: 50, isAlloc: true, isWrite: false, isExec: false, isNoBits: false },
                { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 200, size: 30, isAlloc: true, isWrite: true, isExec: false, isNoBits: false },
                { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 300, size: 20, isAlloc: true, isWrite: true, isExec: false, isNoBits: true },
            ];
            const summary = summarizeSections(sections);
            assert.strictEqual(summary.find(s => s.name === '.text')!.type, 'CODE');
            assert.strictEqual(summary.find(s => s.name === '.rodata')!.type, 'RODATA');
            assert.strictEqual(summary.find(s => s.name === '.data')!.type, 'DATA');
            assert.strictEqual(summary.find(s => s.name === '.bss')!.type, 'NOBITS');
        });

        test('should include endAddr', () => {
            const sections: ElfSection[] = [
                { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 4096, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
            ];
            const summary = summarizeSections(sections);
            assert.strictEqual(summary[0].endAddr, 0x08000000 + 4096);
        });
    });

    suite('generateTextReport', () => {
        test('should contain file name and section info', () => {
            const summary = [
                { name: '.text', size: 4096, addr: 0x08000000, endAddr: 0x08001000, type: 'CODE' },
                { name: '.bss', size: 1024, addr: 0x20000000, endAddr: 0x20000400, type: 'NOBITS' },
            ];
            const report = generateTextReport('test.axf', 0x08000000, 4096, 1024, summary, []);
            assert.ok(report.includes('test.axf'));
            assert.ok(report.includes('0x08000000'));
            assert.ok(report.includes('.text'));
            assert.ok(report.includes('.bss'));
            assert.ok(report.includes('4.0 KB'));
        });

        test('should display End address as inclusive (addr + size - 1)', () => {
            const summary = [
                { name: '.text', size: 4096, addr: 0x08000000, endAddr: 0x08001000, type: 'CODE' },
            ];
            const report = generateTextReport('test.axf', 0x08000000, 4096, 0, summary, []);
            // End should be 0x08000FFF (inclusive), not 0x08001000 (exclusive)
            assert.ok(report.includes('0x08000FFF'), 'End address should be inclusive (0x08000FFF)');
            assert.ok(!report.includes('0x08001000') || report.includes('0x08000000'), 'Should not show exclusive end as the End column');
        });

        test('should include memory region usage when provided', () => {
            const summary = [{ name: '.text', size: 100, addr: 0, endAddr: 100, type: 'CODE' }];
            const usage = [{ region: 'FLASH', used: 100, total: 1000, sections: [{ name: '.text', size: 100, addr: 0, type: 'CODE' }], freeSpaces: [{ addr: 100, size: 900 }] }];
            const report = generateTextReport('fw.elf', 0, 100, 0, summary, usage);
            assert.ok(report.includes('FLASH'));
            assert.ok(report.includes('10.0%'));
        });
    });

    suite('generateSummaryReport', () => {
        // Frozen timestamp so the "Generated:" line is deterministic.
        const generatedAt = new Date(2026, 4, 5, 12, 34, 56);

        // Mirror of the embedding helper used by getWebviewContent in
        // src/memoryMapViewer.ts. Kept tiny and inline so a regression in the
        // production helper without a corresponding test update would be caught
        // on next reviewer eyeballing the diff. If this drifts, the suite below
        // becomes the authoritative spec for the script-safe embedding.
        // Accepts string OR object — same surface as the production helper,
        // because the same payload type discipline applies to RD (object) and
        // textReport/summaryReport (string).
        const embedAsJsLiteral = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

        function buildLargeUsage(regionName: string, total: number, sectionSizes: number[]): {
            region: string; used: number; total: number;
            sections: { name: string; size: number; addr: number; type: string }[];
            freeSpaces: { addr: number; size: number }[];
        } {
            let cursor = 0x08000000;
            const sections = sectionSizes.map((sz, i) => {
                const s = { name: `.text.fn${i}`, size: sz, addr: cursor, type: 'CODE' };
                cursor += sz;
                return s;
            });
            const used = sectionSizes.reduce((a, b) => a + b, 0);
            const free = total - used;
            return {
                region: regionName, used, total, sections,
                freeSpaces: free > 0 ? [{ addr: cursor, size: free }] : [],
            };
        }

        test('header includes filename, file path, entry point, and generated timestamp', () => {
            const summary = [{ name: '.text', size: 100, addr: 0, endAddr: 100, type: 'CODE' }];
            const out = generateSummaryReport('fw.axf', '/abs/path/fw.axf', 0x08000199, 100, 0, summary, [], [], { generatedAt });
            assert.ok(out.includes('# Memory Map: fw.axf'), 'markdown H1 with filename');
            assert.ok(out.includes('`/abs/path/fw.axf`'), 'source path in backticks');
            assert.ok(out.includes('0x08000199'), 'entry point hex');
            assert.ok(out.includes('2026-05-05 12:34:56'), 'frozen timestamp formatted');
            assert.ok(out.includes('Sections: 1'), 'section count line');
        });

        test('emits markdown table for Memory Regions section', () => {
            const usage = [buildLargeUsage('FLASH', 1024, [200, 100])];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 1024 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 300, 0, [], usage, regions, { generatedAt });
            assert.ok(out.includes('| Region | Base | Max | Used | Free | Usage |'), 'markdown table header present');
            assert.ok(out.includes('|---|---|---|---|---|---|'), 'markdown table separator present');
            assert.ok(out.includes('| FLASH |'), 'region row');
            assert.ok(out.includes('29.3%'), '300/1024 ≈ 29.3% usage');
        });

        test('Memory Regions Base column shows region origin, NOT largest section address', () => {
            // Regression for P2: u.sections is sorted by size desc, so
            // u.sections[0].addr is the LARGEST section, not the region base.
            const region = { name: 'FLASH', origin: 0x08000000, size: 0x100000 };
            const usage = [{
                region: 'FLASH',
                used: 150,
                total: 0x100000,
                // Largest section sits at 0x08010000 (well above origin); a smaller
                // section sits at 0x08000200. Sorted desc by size to mimic real producer.
                sections: [
                    { name: '.text.big',   size: 100, addr: 0x08010000, type: 'CODE' },
                    { name: '.text.small', size: 50,  addr: 0x08000200, type: 'CODE' },
                ],
                freeSpaces: [],
            }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 150, 0, [], usage, [region], { generatedAt });
            // Region row Base column must be the origin, not the largest section's addr.
            assert.ok(/\|\s*FLASH\s*\|\s*0x08000000\s*\|/.test(out), 'Base column shows region.origin (0x08000000)');
            assert.ok(!/\|\s*FLASH\s*\|\s*0x08010000\s*\|/.test(out), 'Base column does NOT show largest-section addr (0x08010000)');
        });

        test('preserves UTF-8 chars (em dash, ≥) in output for clipboard correctness', () => {
            // Regression for P2 #1: webview previously used atob() on base64,
            // which mojibakes multi-byte UTF-8. The function output itself
            // must contain the exact characters; the embedding layer is
            // covered by integration round-trip below.
            const usage = [buildLargeUsage('FLASH', 1000, [900])]; // 90% used → saturated
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 1000 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 900, 0, [], usage, regions, { generatedAt });
            assert.ok(out.includes('—'), 'em dash present (used in section headings)');
            assert.ok(out.includes('≥80%'), '≥ char present (used in saturation warning)');
        });

        test('embedded JS literal round-trips UTF-8 (regression for atob mojibake)', () => {
            // Mimics what getWebviewContent does to embed the report into webview JS.
            const usage = [buildLargeUsage('FLASH', 1000, [900])];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 1000 }];
            const summary = generateSummaryReport('a.axf', '/a.axf', 0, 900, 0, [], usage, regions, { generatedAt });
            // The fix: embed via JSON.stringify (+ < escape, see next test),
            // then parse on the JS side. JSON.parse covers the JS-string surface;
            // the HTML-parser surface is checked separately.
            const literal = embedAsJsLiteral(summary);
            const roundTripped = JSON.parse(literal);
            assert.strictEqual(roundTripped, summary, 'JS literal embedding preserves all chars');
            assert.ok(roundTripped.includes('—'), 'em dash survives JS round-trip');
            assert.ok(roundTripped.includes('≥80%'), '≥ survives JS round-trip');
        });

        test('embedding escapes < so payload cannot break out of <script> (HTML parser surface)', () => {
            // Regression for second-round P2: JSON.stringify alone is NOT enough
            // when the literal is inlined into <script>...</script>. HTML parses
            // </script> inside script bodies as a script-end token, so a
            // user-controlled string containing "</script>" can break out.
            // Inputs we don't fully control: file path, file name, region names,
            // section names — all flow into the report verbatim.
            const malicious = 'evil </script><script>alert("xss")</script> end';
            const literal = embedAsJsLiteral(malicious);

            // 1) The literal must NOT contain the dangerous tokens that the HTML
            //    parser would react to inside a <script> body.
            assert.ok(!literal.includes('</script>'), 'literal must not contain </script> verbatim');
            assert.ok(!literal.includes('<script'),  'literal must not contain <script verbatim');
            // 2) But every "<" must be there as the JS escape < so the JS
            //    parser still rebuilds the original string.
            assert.ok(literal.includes('\\u003c'), 'literal contains \\u003c escape for <');

            // 3) Round-trip: HTML-parser-safe wrapping + JS-parser decode = original.
            const html = `<script>const x = ${literal};</script>`;
            const scriptCloseCount = (html.match(/<\/script>/gi) || []).length;
            assert.strictEqual(scriptCloseCount, 1, 'exactly one </script> in HTML (the real closing tag)');
            assert.strictEqual(JSON.parse(literal), malicious, 'JS parser decodes \\u003c back to <');
        });

        test('embedding escapes < for OBJECT payload too (RD region data, not just strings)', () => {
            // Regression for follow-up P2: src/memoryMapViewer.ts also embeds
            // `RD = ${...}` where RD is an object containing region/section
            // names. If helper only handles strings, an evil section name in
            // the object would still break out of <script>.
            const obj = {
                regions: [
                    { name: 'evil </script><script>alert(1)</script>', sections: [
                        { name: 'inner </script>', size: 100 },
                    ]},
                ],
            };
            const literal = embedAsJsLiteral(obj);
            assert.ok(!literal.includes('</script>'), 'object literal must not contain </script>');
            assert.ok(!literal.includes('<script'),  'object literal must not contain <script');
            // Round-trip via JSON.parse rebuilds the original structure.
            const decoded = JSON.parse(literal);
            assert.deepStrictEqual(decoded, obj, 'object survives JSON round-trip');
            // Embedded inside a real <script> wrapper, the HTML parser still
            // sees exactly one </script> token — the real closing tag.
            const html = `<script>const RD = ${literal};</script>`;
            const closeCount = (html.match(/<\/script>/gi) || []).length;
            assert.strictEqual(closeCount, 1, 'exactly one </script> in HTML wrapper');
        });

        test('end-to-end: section/region name with </script> survives summary report embedding', () => {
            // Pretend an ELF section is literally named "</script><script>x</script>".
            // The summary embeds it; the embedded literal must still be safe.
            const evilSection = '.text.</script>';
            const usage = [{
                region: 'FLASH', used: 100, total: 1000,
                sections: [{ name: evilSection, size: 100, addr: 0x08000000, type: 'CODE' }],
                freeSpaces: [{ addr: 0x08000064, size: 900 }],
            }];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 1000 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 100, 0, [], usage, regions, { generatedAt });
            // The raw report contains the verbatim section name (that's expected — it's text).
            assert.ok(out.includes(evilSection), 'report contains the section name verbatim');
            // But the embedded form must not.
            const literal = embedAsJsLiteral(out);
            assert.ok(!literal.includes('</script>'), 'embedded form has no </script>');
            // And JS-side decode rebuilds the original report.
            assert.strictEqual(JSON.parse(literal), out, 'decoded literal === original report');
        });

        test('truncates per-region section list to topN, with "+ N more" footer', () => {
            // 8 sections, default topN = 5 → top 5 listed, footer mentions 3 more
            const usage = [buildLargeUsage('FLASH', 100000, [10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000])];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 100000 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 52000, 0, [], usage, regions, { generatedAt });
            // Top 5 by size: fn0..fn4 (sorted desc by size since they're in input desc order)
            for (const i of [0, 1, 2, 3, 4]) {
                assert.ok(out.includes(`.text.fn${i}`), `top section .text.fn${i} present`);
            }
            // Bottom 3 must NOT appear in the section table
            for (const i of [5, 6, 7]) {
                assert.ok(!out.includes(`.text.fn${i}`), `truncated section .text.fn${i} should NOT appear`);
            }
            // Truncated tail: 5000+4000+3000 = 12000 B = 11.7 KB
            assert.ok(out.includes('+ 3 more sections'), '+ N more footer present');
            assert.ok(out.includes('11.7 KB'), 'truncated total size shown');
        });

        test('respects custom topN', () => {
            const usage = [buildLargeUsage('FLASH', 100000, [10000, 9000, 8000])];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 100000 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 27000, 0, [], usage, regions, { generatedAt, topN: 1 });
            assert.ok(out.includes('.text.fn0'), 'top 1 section present');
            assert.ok(!out.includes('.text.fn1'), 'second section truncated');
            assert.ok(out.includes('+ 2 more sections'), '+ 2 more footer');
        });

        test('Highlights surface largest section, largest hole, and saturated regions', () => {
            const usage = [
                buildLargeUsage('FLASH', 1000, [800, 100]),  // 90% used → saturated
                buildLargeUsage('RAM', 1000, [50]),           // 5% used → not saturated
            ];
            const regions = [
                { name: 'FLASH', origin: 0x08000000, size: 1000 },
                { name: 'RAM', origin: 0x20000000, size: 1000 },
            ];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 850, 50, [], usage, regions, { generatedAt });
            assert.ok(out.includes('## Highlights'), 'Highlights section present');
            assert.ok(out.includes('Largest section'), 'largest section line');
            assert.ok(out.includes('.text.fn0'), 'largest section name (800 B section)');
            assert.ok(out.includes('Largest free hole'), 'largest hole line');
            assert.ok(out.includes('Saturated regions (≥80%)'), 'saturation warning');
            assert.ok(out.includes('FLASH (90.0%)'), 'saturated FLASH listed with pct');
            assert.ok(!out.includes('RAM (5.0%)'), 'non-saturated RAM not in saturation list');
        });

        test('omits Memory Regions / Highlights blocks when no usage data', () => {
            const summary = [{ name: '.text', size: 100, addr: 0, endAddr: 100, type: 'CODE' }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, 100, 0, summary, [], [], { generatedAt });
            assert.ok(!out.includes('## Memory Regions'), 'no Memory Regions block');
            assert.ok(!out.includes('## Highlights'), 'no Highlights block');
            assert.ok(out.includes('Sections: 1'), 'totals still present');
        });

        test('output is markdown-friendly: short, no padded-column dump', () => {
            // Build 50 sections in one region — full dump would be ~50 lines just for sections;
            // summary should stay well under that thanks to topN truncation.
            const sizes = Array.from({ length: 50 }, (_, i) => 100 + i);
            const usage = [buildLargeUsage('FLASH', 100000, sizes)];
            const regions = [{ name: 'FLASH', origin: 0x08000000, size: 100000 }];
            const out = generateSummaryReport('a.axf', '/a.axf', 0, sizes.reduce((a, b) => a + b), 0, [], usage, regions, { generatedAt });
            const lineCount = out.split('\n').length;
            assert.ok(lineCount < 40, `summary should stay compact even for 50 sections, got ${lineCount}`);
            // No padEnd-style runs (the legacy dump uses 24-char padded names).
            assert.ok(!/ {10,}/.test(out), 'no monospace-padding runs (markdown-only formatting)');
        });
    });

    suite('formatSize', () => {
        test('should format bytes', () => {
            assert.strictEqual(formatSize(512), '512 B');
        });

        test('should format kilobytes', () => {
            assert.strictEqual(formatSize(4096), '4.0 KB');
        });

        test('should format megabytes', () => {
            assert.strictEqual(formatSize(1048576), '1.00 MB');
        });

        test('should format fractional KB', () => {
            assert.strictEqual(formatSize(1536), '1.5 KB');
        });
    });

    suite('formatHex', () => {
        test('should format with 0x prefix and padding', () => {
            assert.strictEqual(formatHex(0x08000000), '0x08000000');
        });

        test('should format zero', () => {
            assert.strictEqual(formatHex(0), '0x00000000');
        });

        test('should format small value', () => {
            assert.strictEqual(formatHex(0xFF), '0x000000FF');
        });
    });

    suite('autoDetectRegions', () => {
        test('should detect FLASH and RAM from PT_LOAD segments', () => {
            const segments: ElfSegment[] = [
                { type: 1, vaddr: 0x08000000, memsz: 0x1200, filesz: 0x1200, flags: 5, isRead: true, isWrite: false, isExec: true },
                { type: 1, vaddr: 0x20000000, memsz: 0x500, filesz: 0x100, flags: 6, isRead: true, isWrite: true, isExec: false },
            ];
            const regions = autoDetectRegions(segments, []);
            assert.strictEqual(regions.length, 2);
            assert.strictEqual(regions[0].name, 'FLASH');
            assert.strictEqual(regions[0].origin, 0x08000000);
            assert.strictEqual(regions[0].size, 0x1200);
            assert.strictEqual(regions[1].name, 'RAM');
            assert.strictEqual(regions[1].origin, 0x20000000);
            assert.strictEqual(regions[1].size, 0x500);
        });

        test('should return empty for no PT_LOAD segments', () => {
            const segments: ElfSegment[] = [
                { type: 2, vaddr: 0, memsz: 0, filesz: 0, flags: 0, isRead: false, isWrite: false, isExec: false },
            ];
            const regions = autoDetectRegions(segments, []);
            assert.strictEqual(regions.length, 0);
        });

        test('should handle multiple flash regions', () => {
            const segments: ElfSegment[] = [
                { type: 1, vaddr: 0x08000000, memsz: 0x1000, filesz: 0x1000, flags: 5, isRead: true, isWrite: false, isExec: true },
                { type: 1, vaddr: 0x08100000, memsz: 0x800, filesz: 0x800, flags: 4, isRead: true, isWrite: false, isExec: false },
                { type: 1, vaddr: 0x20000000, memsz: 0x400, filesz: 0x100, flags: 6, isRead: true, isWrite: true, isExec: false },
            ];
            const regions = autoDetectRegions(segments, []);
            assert.strictEqual(regions.length, 3);
            assert.strictEqual(regions[0].name, 'FLASH');
            assert.strictEqual(regions[1].name, 'FLASH_1');
            assert.strictEqual(regions[2].name, 'RAM');
        });
    });

    suite('computeSymbolUsage', () => {
        const sections: ElfSection[] = [
            { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x200, isAlloc: true, isWrite: false, isExec: true, isNoBits: false },
            { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 0x100, isAlloc: true, isWrite: true, isExec: false, isNoBits: false },
        ];

        const symbols: ElfSymbol[] = [
            { name: 'main', addr: 0x08000000, size: 0x80, type: 'FUNC', sectionIndex: 1, binding: 'GLOBAL' },
            { name: 'helper', addr: 0x08000080, size: 0x40, type: 'FUNC', sectionIndex: 1, binding: 'GLOBAL' },
            { name: 'globalVar', addr: 0x20000000, size: 0x20, type: 'OBJECT', sectionIndex: 2, binding: 'GLOBAL' },
        ];

        const regions: MemoryRegion[] = [
            { name: 'FLASH', origin: 0x08000000, size: 0x10000 },
            { name: 'RAM', origin: 0x20000000, size: 0x5000 },
        ];

        test('should produce symbol-level entries', () => {
            const usages = computeSymbolUsage(symbols, sections, regions);
            assert.strictEqual(usages.length, 2);

            const flash = usages.find(u => u.region === 'FLASH')!;
            assert.ok(flash);
            // Should have: main, helper, .text [other] (uncovered portion)
            const mainEntry = flash.sections.find(s => s.name === 'main');
            assert.ok(mainEntry);
            assert.strictEqual(mainEntry!.size, 0x80);
            assert.strictEqual(mainEntry!.type, 'CODE');

            const helperEntry = flash.sections.find(s => s.name === 'helper');
            assert.ok(helperEntry);
            assert.strictEqual(helperEntry!.size, 0x40);
        });

        test('should include uncovered section portions as [other]', () => {
            const usages = computeSymbolUsage(symbols, sections, regions);
            const flash = usages.find(u => u.region === 'FLASH')!;
            const otherEntry = flash.sections.find(s => s.name.includes('[other]'));
            assert.ok(otherEntry, 'Should have [other] entry for uncovered .text bytes');
            // .text size=0x200, covered by symbols = 0x80 + 0x40 = 0xC0, uncovered = 0x140
            assert.strictEqual(otherEntry!.size, 0x200 - 0x80 - 0x40);
        });

        test('should compute free spaces correctly', () => {
            const usages = computeSymbolUsage(symbols, sections, regions);
            const flash = usages.find(u => u.region === 'FLASH')!;
            // .text ends at 0x08000200, region ends at 0x08010000
            const tailFree = flash.freeSpaces.find(f => f.addr === 0x08000200);
            assert.ok(tailFree);
            assert.strictEqual(tailFree!.size, 0x10000 - 0x200);
        });

        test('should fall back to computeMemoryUsage when no symbols', () => {
            const usages = computeSymbolUsage([], sections, regions);
            const flash = usages.find(u => u.region === 'FLASH')!;
            // Should show section-level only
            assert.ok(flash.sections.find(s => s.name === '.text'));
            assert.ok(!flash.sections.find(s => s.name === 'main'));
        });
    });

    suite('defensive header validation', () => {
        test('should reject a buffer that is too small for the ELF header', () => {
            assert.throws(() => parseElf32(Buffer.alloc(10)), /too small/);
        });

        test('should reject a buffer whose magic bytes are wrong', () => {
            const buf = Buffer.alloc(64);
            buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x00;
            assert.throws(() => parseElf32(buf), /valid ELF/);
        });
    });
});
