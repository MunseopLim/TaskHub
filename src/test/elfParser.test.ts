import * as assert from 'assert';
import {
    parseElf32,
    classifySections,
    computeMemoryUsage,
    summarizeSections,
    generateTextReport,
    formatSize,
    formatHex,
    ElfSection,
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
            const buf = Buffer.from('Not an ELF file');
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

        test('should include memory region usage when provided', () => {
            const summary = [{ name: '.text', size: 100, addr: 0, endAddr: 100, type: 'CODE' }];
            const usage = [{ region: 'FLASH', used: 100, total: 1000, sections: [{ name: '.text', size: 100, addr: 0, type: 'CODE' }], freeSpaces: [{ addr: 100, size: 900 }] }];
            const report = generateTextReport('fw.elf', 0, 100, 0, summary, usage);
            assert.ok(report.includes('FLASH'));
            assert.ok(report.includes('10.0%'));
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
});
