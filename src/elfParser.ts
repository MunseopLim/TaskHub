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
const SHT_NOBITS = 8;

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

export interface MemoryUsage {
    region: string;
    used: number;
    total: number;
    sections: { name: string; size: number; addr: number; type: string }[];
    freeSpaces: { addr: number; size: number }[];
}

export interface ElfParseResult {
    sections: ElfSection[];
    entryPoint: number;
    isLittleEndian: boolean;
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
    const shOff = read32(32);        // Section header table offset
    const shEntSize = read16(46);    // Section header entry size
    const shNum = read16(48);        // Number of section header entries
    const shStrNdx = read16(50);     // Section name string table index

    if (shOff === 0 || shNum === 0) {
        throw new Error('ELF file has no section headers.');
    }

    // Read section name string table
    const strTabOffset = read32(shOff + shStrNdx * shEntSize + 16);
    const strTabSize = read32(shOff + shStrNdx * shEntSize + 20);

    const readString = (nameOffset: number): string => {
        const start = strTabOffset + nameOffset;
        if (start >= buffer.length) { return ''; }
        const end = Math.min(start + 256, strTabOffset + strTabSize, buffer.length);
        let str = '';
        for (let i = start; i < end; i++) {
            if (buffer[i] === 0) { break; }
            str += String.fromCharCode(buffer[i]);
        }
        return str;
    };

    // Parse section headers
    const sections: ElfSection[] = [];
    for (let i = 0; i < shNum; i++) {
        const base = shOff + i * shEntSize;
        const nameIdx = read32(base);
        const type = read32(base + 4);
        const flags = read32(base + 8);
        const addr = read32(base + 12);
        const size = read32(base + 20);

        const name = readString(nameIdx);

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

    return { sections, entryPoint, isLittleEndian };
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
        let used = 0;

        for (const sec of sections) {
            if (!sec.isAlloc || sec.size === 0) { continue; }
            if (sec.addr >= region.origin && sec.addr < regionEnd) {
                const type = sec.isNoBits ? 'NOBITS' : (sec.isExec ? 'CODE' : (sec.isWrite ? 'DATA' : 'RODATA'));
                matchingSections.push({ name: sec.name, size: sec.size, addr: sec.addr, type });
                used += sec.size;
            }
        }

        // Sort by address to compute free spaces (gaps between sections)
        const addrSorted = [...matchingSections].sort((a, b) => a.addr - b.addr);
        const freeSpaces: { addr: number; size: number }[] = [];
        let cursor = region.origin;
        for (const sec of addrSorted) {
            if (sec.addr > cursor) {
                freeSpaces.push({ addr: cursor, size: sec.addr - cursor });
            }
            cursor = sec.addr + sec.size;
        }
        if (cursor < regionEnd) {
            freeSpaces.push({ addr: cursor, size: regionEnd - cursor });
        }

        usages.push({
            region: region.name,
            used,
            total: region.size,
            sections: matchingSections.sort((a, b) => b.size - a.size),
            freeSpaces,
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
            const freePct = u.total > 0 ? ((u.total - u.used) / u.total * 100).toFixed(1) : '0.0';
            lines.push(`${u.region}: ${formatSize(u.used)} / ${formatSize(u.total)} (${pct}%) | Free: ${formatSize(u.total - u.used)} (${freePct}%)`);
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
            `${s.name.padEnd(24)} ${formatHex(s.addr).padStart(12)} ${formatHex(s.endAddr).padStart(12)} ${formatSize(s.size).padStart(10)} ${String(s.size).padStart(10)} ${s.type}`
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
