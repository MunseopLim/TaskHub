/**
 * ELF32 binary parser for ARM .axf/.elf files.
 * Extracts section headers and computes memory region usage.
 */

// ELF magic number
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7fELF

// ELF class
const ELFCLASS32 = 1;

// ELF data encoding
const ELFDATA2LSB = 1; // Little-endian
const ELFDATA2MSB = 2; // Big-endian

// Section header flags
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

// Section header types
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;

// Program header types
const PT_LOAD = 1;

// Program header flags
const PF_X = 0x1;
const PF_W = 0x2;
const PF_R = 0x4;

// Symbol info
const STT_FUNC = 2;
const STT_OBJECT = 1;
const STB_LOCAL = 0;

export interface ElfSection {
    name: string;
    type: number;
    flags: number;
    addr: number;
    size: number;
    isAlloc: boolean;
    isWrite: boolean;
    isExec: boolean;
    isNoBits: boolean; // .bss-like (occupies memory but not file space)
}

export interface MemoryRegion {
    name: string;
    origin: number;
    size: number;
}

export interface MemoryUsageEntry {
    name: string;
    size: number;
    addr: number;
    type: string;
    /** Object/source file name (e.g., "main.o" for listing, section name for ELF symbols) */
    object?: string;
    /** Section name (e.g., ".text", "RESET") */
    section?: string;
    /** Function/symbol name extracted from section token (prefix stripped) */
    func?: string;
}

export interface MemoryUsage {
    region: string;
    used: number;
    total: number;
    sections: MemoryUsageEntry[];
    freeSpaces: { addr: number; size: number }[];
    /** Linker-reported used size (includes PAD). Only set for listing files. */
    reportedUsed?: number;
}

export interface ElfSymbol {
    name: string;
    addr: number;
    size: number;
    type: 'FUNC' | 'OBJECT' | 'OTHER';
    sectionIndex: number;
    binding: string;
}

export interface ElfSegment {
    type: number;
    vaddr: number;
    memsz: number;
    filesz: number;
    flags: number;
    isRead: boolean;
    isWrite: boolean;
    isExec: boolean;
}

export interface ElfParseResult {
    sections: ElfSection[];
    entryPoint: number;
    isLittleEndian: boolean;
    symbols: ElfSymbol[];
    segments: ElfSegment[];
}

export function parseElf32(buffer: Buffer): ElfParseResult {
    // Validate ELF magic
    for (let i = 0; i < 4; i++) {
        if (buffer[i] !== ELF_MAGIC[i]) {
            throw new Error('Not a valid ELF file (invalid magic number).');
        }
    }

    // Validate ELF class (must be 32-bit)
    const elfClass = buffer[4];
    if (elfClass !== ELFCLASS32) {
        throw new Error(`Unsupported ELF class: ${elfClass}. Only 32-bit ELF (ELF32) is supported.`);
    }

    // Determine endianness
    const dataEncoding = buffer[5];
    if (dataEncoding !== ELFDATA2LSB && dataEncoding !== ELFDATA2MSB) {
        throw new Error(`Unsupported data encoding: ${dataEncoding}.`);
    }
    const isLittleEndian = dataEncoding === ELFDATA2LSB;

    const read16 = (offset: number): number =>
        isLittleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const read32 = (offset: number): number =>
        isLittleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);

    // ELF32 header fields
    const entryPoint = read32(24);
    const phOff = read32(28);        // Program header table offset
    const shOff = read32(32);        // Section header table offset
    const phEntSize = read16(42);    // Program header entry size
    const phNum = read16(44);        // Number of program header entries
    const shEntSize = read16(46);    // Section header entry size
    const shNum = read16(48);        // Number of section header entries
    const shStrNdx = read16(50);     // Section name string table index

    if (shOff === 0 || shNum === 0) {
        throw new Error('ELF file has no section headers.');
    }

    // Read section name string table
    const strTabOffset = read32(shOff + shStrNdx * shEntSize + 16);
    const strTabSize = read32(shOff + shStrNdx * shEntSize + 20);

    const readStringFrom = (tabOffset: number, tabSize: number, nameOffset: number): string => {
        const start = tabOffset + nameOffset;
        if (start >= buffer.length) { return ''; }
        const end = Math.min(start + 256, tabOffset + tabSize, buffer.length);
        let str = '';
        for (let i = start; i < end; i++) {
            if (buffer[i] === 0) { break; }
            str += String.fromCharCode(buffer[i]);
        }
        return str;
    };

    const readString = (nameOffset: number): string =>
        readStringFrom(strTabOffset, strTabSize, nameOffset);

    // Parse program headers (segments)
    const segments: ElfSegment[] = [];
    if (phOff > 0 && phNum > 0) {
        for (let i = 0; i < phNum; i++) {
            const base = phOff + i * phEntSize;
            if (base + phEntSize > buffer.length) { break; }
            const pType = read32(base);
            const vaddr = read32(base + 8);
            const filesz = read32(base + 16);
            const memsz = read32(base + 20);
            const flags = read32(base + 24);

            segments.push({
                type: pType,
                vaddr,
                memsz,
                filesz,
                flags,
                isRead: (flags & PF_R) !== 0,
                isWrite: (flags & PF_W) !== 0,
                isExec: (flags & PF_X) !== 0,
            });
        }
    }

    // Parse section headers
    const sections: ElfSection[] = [];
    let symtabIdx = -1;
    let symtabLink = 0;
    for (let i = 0; i < shNum; i++) {
        const base = shOff + i * shEntSize;
        const nameIdx = read32(base);
        const type = read32(base + 4);
        const flags = read32(base + 8);
        const addr = read32(base + 12);
        const size = read32(base + 20);
        const link = read32(base + 24);

        const name = readString(nameIdx);

        if (type === SHT_SYMTAB && symtabIdx < 0) {
            symtabIdx = i;
            symtabLink = link; // index of associated .strtab
        }

        sections.push({
            name,
            type,
            flags,
            addr,
            size,
            isAlloc: (flags & SHF_ALLOC) !== 0,
            isWrite: (flags & SHF_WRITE) !== 0,
            isExec: (flags & SHF_EXECINSTR) !== 0,
            isNoBits: type === SHT_NOBITS,
        });
    }

    // Parse symbol table
    const symbols: ElfSymbol[] = [];
    if (symtabIdx >= 0) {
        const symBase = shOff + symtabIdx * shEntSize;
        const symOffset = read32(symBase + 16);
        const symSize = read32(symBase + 20);
        const symEntSize = read32(symBase + 36);

        // Get the linked string table
        const strtabBase = shOff + symtabLink * shEntSize;
        const symStrTabOffset = read32(strtabBase + 16);
        const symStrTabSize = read32(strtabBase + 20);

        if (symEntSize > 0) {
            const numSyms = Math.floor(symSize / symEntSize);
            for (let i = 0; i < numSyms; i++) {
                const sBase = symOffset + i * symEntSize;
                if (sBase + symEntSize > buffer.length) { break; }
                const nameOff = read32(sBase);
                const value = read32(sBase + 4);
                const sz = read32(sBase + 8);
                const info = buffer[sBase + 12];
                const shndx = read16(sBase + 14);

                const sType = info & 0xf;
                const sBind = (info >> 4) & 0xf;

                // Only include FUNC and OBJECT symbols with nonzero size
                if ((sType === STT_FUNC || sType === STT_OBJECT) && sz > 0) {
                    symbols.push({
                        name: readStringFrom(symStrTabOffset, symStrTabSize, nameOff),
                        addr: value,
                        size: sz,
                        type: sType === STT_FUNC ? 'FUNC' : 'OBJECT',
                        sectionIndex: shndx,
                        binding: sBind === STB_LOCAL ? 'LOCAL' : 'GLOBAL',
                    });
                }
            }
        }
    }

    return { sections, entryPoint, isLittleEndian, symbols, segments };
}

export function classifySections(sections: ElfSection[]): { flash: ElfSection[]; ram: ElfSection[] } {
    const flash: ElfSection[] = [];
    const ram: ElfSection[] = [];

    for (const sec of sections) {
        if (!sec.isAlloc || sec.size === 0) { continue; }

        if (sec.isNoBits) {
            // .bss-like: RAM only (no file content)
            ram.push(sec);
        } else if (sec.isWrite) {
            // Writable with content (e.g., .data): VMA is in RAM.
            // LMA may be in Flash but we only have VMA from section headers.
            // Classify by VMA to stay consistent with computeMemoryUsage.
            ram.push(sec);
        } else {
            // Read-only or executable (e.g., .text, .rodata): Flash only
            flash.push(sec);
        }
    }

    return { flash, ram };
}

export function computeMemoryUsage(sections: ElfSection[], regions: MemoryRegion[]): MemoryUsage[] {
    const usages: MemoryUsage[] = [];

    for (const region of regions) {
        const regionEnd = region.origin + region.size;
        const matchingSections: { name: string; size: number; addr: number; type: string }[] = [];

        for (const sec of sections) {
            if (!sec.isAlloc || sec.size === 0) { continue; }
            if (sec.addr >= region.origin && sec.addr < regionEnd) {
                const type = sec.isNoBits ? 'NOBITS' : (sec.isExec ? 'CODE' : (sec.isWrite ? 'DATA' : 'RODATA'));
                matchingSections.push({ name: sec.name, size: sec.size, addr: sec.addr, type });
            }
        }

        // Sort by address to compute free spaces (gaps between sections)
        const addrSorted = [...matchingSections].sort((a, b) => a.addr - b.addr);
        const freeSpaces: { addr: number; size: number }[] = [];
        let cursor = region.origin;
        for (const sec of addrSorted) {
            const secEnd = Math.min(sec.addr + sec.size, regionEnd);
            if (sec.addr > cursor) {
                freeSpaces.push({ addr: cursor, size: sec.addr - cursor });
            }
            cursor = Math.max(cursor, secEnd);
        }
        if (cursor < regionEnd) {
            freeSpaces.push({ addr: cursor, size: regionEnd - cursor });
        }

        // Compute used from actual occupied span (handles overlapping sections)
        const actualUsed = region.size - freeSpaces.reduce((sum, f) => sum + f.size, 0);

        usages.push({
            region: region.name,
            used: Math.min(actualUsed, region.size),
            total: region.size,
            sections: matchingSections.sort((a, b) => b.size - a.size),
            freeSpaces: freeSpaces.filter(f => f.size >= 4),
        });
    }

    return usages;
}

/**
 * Auto-detect memory regions from ELF PT_LOAD segments.
 * Groups contiguous segments and labels them as FLASH or RAM
 * based on flags (executable → FLASH, writable → RAM).
 */
export function autoDetectRegions(segments: ElfSegment[], sections: ElfSection[]): MemoryRegion[] {
    const loadSegments = segments.filter(s => s.type === PT_LOAD && s.memsz > 0);
    if (loadSegments.length === 0) { return []; }

    // Sort by virtual address
    const sorted = [...loadSegments].sort((a, b) => a.vaddr - b.vaddr);

    const regions: MemoryRegion[] = [];
    let flashIdx = 0;
    let ramIdx = 0;

    for (const seg of sorted) {
        // Determine region type: executable or read-only → FLASH, writable → RAM
        const isFlash = seg.isExec || !seg.isWrite;
        let name: string;
        if (isFlash) {
            name = flashIdx === 0 ? 'FLASH' : `FLASH_${flashIdx}`;
            flashIdx++;
        } else {
            name = ramIdx === 0 ? 'RAM' : `RAM_${ramIdx}`;
            ramIdx++;
        }

        // Use memsz as the region size (includes .bss)
        regions.push({
            name,
            origin: seg.vaddr,
            size: seg.memsz,
        });
    }

    return regions;
}

/**
 * Compute symbol-level memory usage within sections.
 * Maps each symbol to its containing section and calculates coverage.
 */
export function computeSymbolUsage(
    symbols: ElfSymbol[],
    sections: ElfSection[],
    regions: MemoryRegion[]
): MemoryUsage[] {
    if (symbols.length === 0) {
        return computeMemoryUsage(sections, regions);
    }

    const usages: MemoryUsage[] = [];

    for (const region of regions) {
        const regionEnd = region.origin + region.size;

        // Find symbols in this region
        const regionSymbols = symbols.filter(
            sym => sym.addr >= region.origin && sym.addr < regionEnd
        );

        // Find sections in this region (for fallback and coverage check)
        const regionSections = sections.filter(
            sec => sec.isAlloc && sec.size > 0 && sec.addr >= region.origin && sec.addr < regionEnd
        );

        // Build entries: use symbols first, then fill remaining section coverage
        const entries: { name: string; size: number; addr: number; type: string; object?: string }[] = [];

        // Track symbol-covered ranges to find uncovered section portions
        const coveredRanges: { start: number; end: number }[] = [];

        for (const sym of regionSymbols) {
            const symType = sym.type === 'FUNC' ? 'CODE' : 'DATA';
            // Find parent section name
            const parentSection = sym.sectionIndex > 0 && sym.sectionIndex < sections.length
                ? sections[sym.sectionIndex] : undefined;
            const parentName = parentSection?.name || '';

            entries.push({
                name: sym.name,
                size: sym.size,
                addr: sym.addr,
                type: symType,
                object: parentName,
            });
            coveredRanges.push({ start: sym.addr, end: sym.addr + sym.size });
        }

        // Merge covered ranges
        coveredRanges.sort((a, b) => a.start - b.start);
        const merged: { start: number; end: number }[] = [];
        for (const r of coveredRanges) {
            if (merged.length > 0 && r.start <= merged[merged.length - 1].end) {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
            } else {
                merged.push({ ...r });
            }
        }

        // Add uncovered portions of sections
        for (const sec of regionSections) {
            const secStart = sec.addr;
            const secEnd = sec.addr + sec.size;
            let cursor = secStart;
            const secType = sec.isNoBits ? 'NOBITS' : (sec.isExec ? 'CODE' : (sec.isWrite ? 'DATA' : 'RODATA'));

            for (const cr of merged) {
                if (cr.start >= secEnd) { break; }
                if (cr.end <= cursor) { continue; }
                const gapStart = Math.max(cursor, secStart);
                const gapEnd = Math.min(cr.start, secEnd);
                if (gapEnd > gapStart) {
                    entries.push({
                        name: `${sec.name} [other]`,
                        size: gapEnd - gapStart,
                        addr: gapStart,
                        type: secType,
                        object: sec.name,
                    });
                }
                cursor = Math.max(cursor, cr.end);
            }
            // Remaining after all covered ranges
            const finalStart = Math.max(cursor, secStart);
            if (finalStart < secEnd) {
                // Check if any symbols covered this section at all
                const hasSymbols = regionSymbols.some(
                    sym => sym.addr >= secStart && sym.addr < secEnd
                );
                if (hasSymbols) {
                    entries.push({
                        name: `${sec.name} [other]`,
                        size: secEnd - finalStart,
                        addr: finalStart,
                        type: secType,
                        object: sec.name,
                    });
                } else {
                    // No symbols in this section, show as whole section
                    entries.push({
                        name: sec.name,
                        size: sec.size,
                        addr: sec.addr,
                        type: secType,
                    });
                }
            }
        }

        // Sort by address to compute free spaces
        const addrSorted = [...entries].sort((a, b) => a.addr - b.addr);
        const freeSpaces: { addr: number; size: number }[] = [];
        let cursor = region.origin;
        for (const e of addrSorted) {
            const eEnd = Math.min(e.addr + e.size, regionEnd);
            if (e.addr > cursor) {
                freeSpaces.push({ addr: cursor, size: e.addr - cursor });
            }
            cursor = Math.max(cursor, eEnd);
        }
        if (cursor < regionEnd) {
            freeSpaces.push({ addr: cursor, size: regionEnd - cursor });
        }

        const actualUsed = region.size - freeSpaces.reduce((sum, f) => sum + f.size, 0);

        usages.push({
            region: region.name,
            used: Math.min(actualUsed, region.size),
            total: region.size,
            sections: entries.sort((a, b) => b.size - a.size),
            freeSpaces: freeSpaces.filter(f => f.size >= 4),
        });
    }

    return usages;
}

export interface SectionSummary {
    name: string;
    size: number;
    addr: number;
    endAddr: number;
    type: string;
}

export function summarizeSections(sections: ElfSection[]): SectionSummary[] {
    return sections
        .filter(s => s.isAlloc && s.size > 0)
        .map(s => ({
            name: s.name,
            size: s.size,
            addr: s.addr,
            endAddr: s.addr + s.size,
            type: s.isNoBits ? 'NOBITS' : (s.isExec ? 'CODE' : (s.isWrite ? 'DATA' : 'RODATA')),
        }))
        .sort((a, b) => a.addr - b.addr);
}

export function generateTextReport(
    fileName: string,
    entryPoint: number,
    flashTotal: number,
    ramTotal: number,
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[]
): string {
    const lines: string[] = [];
    lines.push(`Memory Map: ${fileName}`);
    lines.push(`Entry Point: ${formatHex(entryPoint)}`);
    lines.push('');
    lines.push(`Flash (Code + RO Data): ${formatSize(flashTotal)}`);
    lines.push(`RAM (Data + BSS):       ${formatSize(ramTotal)}`);
    lines.push('');

    if (memoryUsage.length > 0) {
        lines.push('--- Memory Regions ---');
        for (const u of memoryUsage) {
            const pct = u.total > 0 ? (u.used / u.total * 100).toFixed(1) : '0.0';
            const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
            const freePct = u.total > 0 ? (calcFree / u.total * 100).toFixed(1) : '0.0';
            lines.push(`${u.region}: ${formatSize(u.used)} / ${formatSize(u.total)} (${pct}%) | Free: ${formatSize(calcFree)} (${freePct}%)`);
            for (const s of u.sections) {
                lines.push(`  ${s.name.padEnd(24)} ${formatSize(s.size).padStart(10)}`);
            }
            for (const f of u.freeSpaces) {
                lines.push(`  ${'[FREE]'.padEnd(24)} ${formatSize(f.size).padStart(10)}  @ ${formatHex(f.addr)}`);
            }
        }
        lines.push('');
    }

    lines.push('--- All Sections ---');
    lines.push(`${'Section'.padEnd(24)} ${'Address'.padStart(12)} ${'End'.padStart(12)} ${'Size'.padStart(10)} ${'Bytes'.padStart(10)} Type`);
    for (const s of sectionSummary) {
        lines.push(
            `${s.name.padEnd(24)} ${formatHex(s.addr).padStart(12)} ${formatHex(s.size > 0 ? s.endAddr - 1 : s.endAddr).padStart(12)} ${formatSize(s.size).padStart(10)} ${String(s.size).padStart(10)} ${s.type}`
        );
    }

    return lines.join('\n');
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatHex(value: number): string {
    return '0x' + value.toString(16).toUpperCase().padStart(8, '0');
}
