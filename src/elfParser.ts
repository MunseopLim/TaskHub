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
    /** ELF `sh_offset`. Listing에서 합성한 섹션에는 대응 파일이 없어 비어 있다. */
    offset?: number;
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
    /** ELF 원본 파일에서 이 행이 차지하는 바이트 범위. Listing 행에는 없다. */
    fileRange?: ElfFileRangeResolution;
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
    /** ELF `p_offset`. */
    offset: number;
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

/** ELF 가상 주소 범위를 원본 파일 바이트로 바꾼 결과. */
export type ElfFileRangeResolution =
    | { kind: 'file'; offset: number; size: number }
    | { kind: 'unavailable'; reason: 'nobits' | 'zero-fill' | 'unmapped' | 'outside-file' | 'invalid-range' };

const ELF32_HEADER_SIZE = 52;
const ELF32_PH_ENTRY_MIN = 32;
const ELF32_SH_ENTRY_MIN = 40;
/** ELF32 `Elf32_Sym` 은 정확히 16바이트다. 그보다 작으면 항목을 읽을 수 없다. */
const ELF32_SYM_ENTRY_MIN = 16;
const ELF_MAX_ENTRIES = 65535;
/**
 * 심볼 개수 상한. 100MB(Memory Map 한도) 를 16바이트로 다 채워도 6.25M 이므로
 * 정상 펌웨어는 근처에도 오지 않는다 — 변조된 헤더가 배열을 키우는 것만 막는다.
 *
 * **이 값이 렌더가 감당할 수 있는 수는 아니다.** `memoryMapViewer` 는 심볼마다
 * 세그먼트 객체를 만들고 HTML 문자열까지 조립하므로, 상한을 꽉 채운 입력(약
 * 16MB 파일)이 오면 뷰어 쪽에서 멈출 수 있다. 그럼에도 이 값을 낮추지 않기로
 * 한 것은 **의도한 결정**이다 — 이번 검증이 없앤 것은 "심볼 배열이 파일 크기만큼
 * 무한히 커지는" 경로이고, 100만 심볼짜리 임베디드 ELF 는 현실에 없다. 렌더
 * 비용을 다루려면 파서가 아니라 뷰어에서 표시 개수를 자르고 요약만 전체 기준으로
 * 계산해야 한다. 리뷰에서 반복해 제기되므로 판단 근거를 여기 남긴다.
 */
const ELF_MAX_SYMBOLS = 1_000_000;

export function parseElf32(buffer: Buffer): ElfParseResult {
    if (!buffer || buffer.length < ELF32_HEADER_SIZE) {
        throw new Error(
            `ELF file is too small (got ${buffer?.length ?? 0} bytes, need at least ${ELF32_HEADER_SIZE}).`
        );
    }

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

    const read16 = (offset: number): number => {
        if (offset < 0 || offset + 2 > buffer.length) {
            throw new Error(`ELF read out of bounds at offset 0x${offset.toString(16)} (read16).`);
        }
        return isLittleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    };
    const read32 = (offset: number): number => {
        if (offset < 0 || offset + 4 > buffer.length) {
            throw new Error(`ELF read out of bounds at offset 0x${offset.toString(16)} (read32).`);
        }
        return isLittleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    };

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
    if (phNum > 0 && phEntSize < ELF32_PH_ENTRY_MIN) {
        throw new Error(`ELF program header entry size (${phEntSize}) is too small.`);
    }
    if (shEntSize < ELF32_SH_ENTRY_MIN) {
        throw new Error(`ELF section header entry size (${shEntSize}) is too small.`);
    }
    if (shNum > ELF_MAX_ENTRIES || phNum > ELF_MAX_ENTRIES) {
        throw new Error(`ELF reports too many table entries (shNum=${shNum}, phNum=${phNum}).`);
    }
    const shTableEnd = shOff + shNum * shEntSize;
    if (shTableEnd > buffer.length) {
        throw new Error('ELF section header table exceeds file size.');
    }
    if (shStrNdx >= shNum) {
        throw new Error(`ELF section name string table index (${shStrNdx}) is out of range.`);
    }

    // Read section name string table
    const strTabOffset = read32(shOff + shStrNdx * shEntSize + 16);
    const strTabSize = read32(shOff + shStrNdx * shEntSize + 20);
    if (strTabOffset + strTabSize > buffer.length) {
        throw new Error('ELF section name string table exceeds file size.');
    }

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
            const offset = read32(base + 4);
            const vaddr = read32(base + 8);
            const filesz = read32(base + 16);
            const memsz = read32(base + 20);
            const flags = read32(base + 24);

            segments.push({
                type: pType,
                offset,
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
        const offset = read32(base + 16);
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
            offset,
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
        if (symtabLink >= shNum) {
            throw new Error(`ELF symbol table linked string table index (${symtabLink}) is out of range.`);
        }
        const strtabBase = shOff + symtabLink * shEntSize;
        const symStrTabOffset = read32(strtabBase + 16);
        const symStrTabSize = read32(strtabBase + 20);
        if (symStrTabOffset + symStrTabSize > buffer.length) {
            throw new Error('ELF symbol string table exceeds file size.');
        }

        // **빈 심볼 테이블은 검사할 것이 없다.** 크기가 0이면 조용히 넘어간다 —
        // 아래 검사를 무조건 걸면 심볼 없는 정상 ELF 가 거부된다.
        if (symSize > 0) {
            // 엔트리 크기를 검사하지 않으면 `sh_entsize` 를 1 로 적은 파일이
            // **바이트마다 심볼 하나**를 만들어 낸다. 실제로 확인했다: 엔트리
            // 크기 1, 크기 13 인 ELF 가 거부되지 않고 쓰레기 심볼 13개를 냈고,
            // 32MB 짜리로는 RSS 2.9GB 를 쓴 뒤에야 범위 초과로 끝났다. Memory
            // Map 은 100MB 까지 받으므로 그 크기면 extension host 가 OOM 으로 간다.
            //
            // 아래 읽기는 항목마다 16바이트 배치를 가정하므로(이름 0, 값 4,
            // 크기 8, info 12, shndx 14), 그보다 작은 엔트리는 애초에 해석할 수 없다.
            if (symEntSize < ELF32_SYM_ENTRY_MIN) {
                throw new Error(
                    `ELF symbol table entry size (${symEntSize}) is too small (need at least ${ELF32_SYM_ENTRY_MIN}).`
                );
            }
            // 섹션이 파일 안에 들어 있는지 **미리** 본다. 루프 안의 범위 검사만
            // 믿으면 파일 끝까지 헛돌며 심볼 배열만 키운다.
            if (symOffset + symSize > buffer.length) {
                throw new Error('ELF symbol table exceeds file size.');
            }
            const numSyms = Math.floor(symSize / symEntSize);
            if (numSyms > ELF_MAX_SYMBOLS) {
                throw new Error(`ELF reports too many symbols (${numSyms}, limit ${ELF_MAX_SYMBOLS}).`);
            }
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

/**
 * ELF 메모리 주소 범위를 원본 파일의 byte offset으로 바꾼다.
 *
 * 심볼이 유효한 섹션 인덱스를 가리키면 그 섹션이 최종 권위다. 깨진 심볼이 섹션
 * 밖을 가리킬 때 우연히 겹치는 segment로 다시 해석하면 엉뚱한 바이트를 보여 줄
 * 수 있으므로 fallback하지 않는다. 섹션 정보가 없을 때만 PT_LOAD를 사용한다.
 * PT_LOAD의 `memsz - filesz` 꼬리는 zero-fill 영역이므로 파일 바이트가 아니다.
 */
export function resolveElfFileRange(
    address: number,
    size: number,
    sections: ElfSection[],
    segments: ElfSegment[],
    fileSize: number,
    sectionIndex?: number
): ElfFileRangeResolution {
    const rangeEnd = address + size;
    if (
        !Number.isSafeInteger(address) || address < 0
        || !Number.isSafeInteger(size) || size <= 0
        || !Number.isSafeInteger(rangeEnd) || rangeEnd <= address
        || !Number.isSafeInteger(fileSize) || fileSize < 0
    ) {
        return { kind: 'unavailable', reason: 'invalid-range' };
    }

    if (sectionIndex !== undefined) {
        // SHN_UNDEF(0), SHN_ABS/COMMON 및 범위 밖 인덱스는 원본 파일의 어느
        // 섹션 바이트라고 단정할 수 없다. 우연히 겹치는 PT_LOAD로 재해석하지 않는다.
        if (sectionIndex <= 0 || sectionIndex >= sections.length) {
            return { kind: 'unavailable', reason: 'unmapped' };
        }
        const section = sections[sectionIndex];
        const sectionEnd = section.addr + section.size;
        if (!Number.isSafeInteger(sectionEnd) || address < section.addr || rangeEnd > sectionEnd) {
            return { kind: 'unavailable', reason: 'unmapped' };
        }
        if (section.isNoBits) {
            return { kind: 'unavailable', reason: 'nobits' };
        }
        if (!Number.isSafeInteger(section.offset) || section.offset! < 0) {
            return { kind: 'unavailable', reason: 'unmapped' };
        }
        const offset = section.offset! + (address - section.addr);
        const fileEnd = offset + size;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(fileEnd) || offset < 0 || fileEnd > fileSize) {
            return { kind: 'unavailable', reason: 'outside-file' };
        }
        return { kind: 'file', offset, size };
    }

    for (const segment of segments) {
        if (segment.type !== PT_LOAD || segment.memsz <= 0) { continue; }
        const memoryEnd = segment.vaddr + segment.memsz;
        if (!Number.isSafeInteger(memoryEnd) || address < segment.vaddr || rangeEnd > memoryEnd) { continue; }

        const fileBackedEnd = segment.vaddr + segment.filesz;
        if (!Number.isSafeInteger(fileBackedEnd) || rangeEnd > fileBackedEnd) {
            return { kind: 'unavailable', reason: 'zero-fill' };
        }
        const offset = segment.offset + (address - segment.vaddr);
        const fileEnd = offset + size;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(fileEnd) || offset < 0 || fileEnd > fileSize) {
            return { kind: 'unavailable', reason: 'outside-file' };
        }
        return { kind: 'file', offset, size };
    }

    return { kind: 'unavailable', reason: 'unmapped' };
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

export function computeMemoryUsage(
    sections: ElfSection[],
    regions: MemoryRegion[],
    segments: ElfSegment[] = [],
    fileSize?: number
): MemoryUsage[] {
    const usages: MemoryUsage[] = [];

    for (const region of regions) {
        const regionEnd = region.origin + region.size;
        const matchingSections: MemoryUsageEntry[] = [];

        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
            const sec = sections[sectionIndex];
            if (!sec.isAlloc || sec.size === 0) { continue; }
            if (sec.addr >= region.origin && sec.addr < regionEnd) {
                const type = sec.isNoBits ? 'NOBITS' : (sec.isExec ? 'CODE' : (sec.isWrite ? 'DATA' : 'RODATA'));
                matchingSections.push({
                    name: sec.name,
                    size: sec.size,
                    addr: sec.addr,
                    type,
                    fileRange: fileSize === undefined
                        ? undefined
                        : resolveElfFileRange(sec.addr, sec.size, sections, segments, fileSize, sectionIndex),
                });
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
    regions: MemoryRegion[],
    segments: ElfSegment[] = [],
    fileSize?: number
): MemoryUsage[] {
    if (symbols.length === 0) {
        return computeMemoryUsage(sections, regions, segments, fileSize);
    }

    const usages: MemoryUsage[] = [];
    const sectionIndexes = new Map<ElfSection, number>(sections.map((section, index) => [section, index]));

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
        const entries: MemoryUsageEntry[] = [];

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
                fileRange: fileSize === undefined
                    ? undefined
                    : resolveElfFileRange(sym.addr, sym.size, sections, segments, fileSize, sym.sectionIndex),
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
                        fileRange: fileSize === undefined
                            ? undefined
                            : resolveElfFileRange(gapStart, gapEnd - gapStart, sections, segments, fileSize, sectionIndexes.get(sec)),
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
                        fileRange: fileSize === undefined
                            ? undefined
                            : resolveElfFileRange(finalStart, secEnd - finalStart, sections, segments, fileSize, sectionIndexes.get(sec)),
                    });
                } else {
                    // No symbols in this section, show as whole section
                    entries.push({
                        name: sec.name,
                        size: sec.size,
                        addr: sec.addr,
                        type: secType,
                        fileRange: fileSize === undefined
                            ? undefined
                            : resolveElfFileRange(sec.addr, sec.size, sections, segments, fileSize, sectionIndexes.get(sec)),
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
    /** ELF 원본 파일에서 이 섹션이 차지하는 바이트 범위. Listing 요약에는 없다. */
    fileRange?: ElfFileRangeResolution;
}

export function summarizeSections(
    sections: ElfSection[],
    segments: ElfSegment[] = [],
    fileSize?: number
): SectionSummary[] {
    return sections
        .map((section, sectionIndex) => ({ section, sectionIndex }))
        .filter(({ section }) => section.isAlloc && section.size > 0)
        .map(({ section: s, sectionIndex }) => ({
            name: s.name,
            size: s.size,
            addr: s.addr,
            endAddr: s.addr + s.size,
            type: s.isNoBits ? 'NOBITS' : (s.isExec ? 'CODE' : (s.isWrite ? 'DATA' : 'RODATA')),
            fileRange: fileSize === undefined
                ? undefined
                : resolveElfFileRange(s.addr, s.size, sections, segments, fileSize, sectionIndex),
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

/**
 * Markdown summary report. Designed to be useful when pasted into PRs / issues /
 * Slack / Notion: ~50 lines for a 410-section file, formatting independent of
 * monospace fonts. The full per-section dump is available via generateTextReport.
 */
export function generateSummaryReport(
    fileName: string,
    filePath: string,
    entryPoint: number,
    flashTotal: number,
    ramTotal: number,
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[],
    regions: MemoryRegion[],
    options?: { topN?: number; generatedAt?: Date }
): string {
    const topN = options?.topN ?? 5;
    const now = options?.generatedAt ?? new Date();
    // Local-time ISO-ish: "2026-05-05 12:34:56" — round-trippable for humans
    // without a timezone surprise on paste.
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
        `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

    const lines: string[] = [];
    lines.push(`# Memory Map: ${fileName}`);
    lines.push('');
    lines.push(`- **Source**: \`${filePath}\``);
    lines.push(`- **Entry Point**: ${formatHex(entryPoint)}`);
    lines.push(`- **Generated**: ${ts}`);
    lines.push('');
    lines.push('## Totals');
    lines.push('');
    if (memoryUsage.length > 0) {
        lines.push(`- Flash (Code + RO Data): ${formatSize(flashTotal)}`);
        lines.push(`- RAM (Data + BSS): ${formatSize(ramTotal)}`);
    }
    lines.push(`- Sections: ${sectionSummary.length}`);
    lines.push('');

    if (memoryUsage.length > 0) {
        lines.push('## Memory Regions');
        lines.push('');
        lines.push('| Region | Base | Max | Used | Free | Usage |');
        lines.push('|---|---|---|---|---|---|');
        // Look up region origins from the authoritative regions array.
        // u.sections is sorted by size desc (see computeMemoryUsage / computeSymbolUsage),
        // so u.sections[0].addr is "largest section", NOT region base.
        const originByName = new Map(regions.map(r => [r.name, r.origin]));
        for (const u of memoryUsage) {
            const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
            const pct = u.total > 0 ? (u.used / u.total * 100).toFixed(1) + '%' : '—';
            const origin = originByName.get(u.region) ?? 0;
            lines.push(`| ${u.region} | ${formatHex(origin)} | ${formatSize(u.total)} | ${formatSize(u.used)} | ${formatSize(calcFree)} | ${pct} |`);
        }
        lines.push('');

        lines.push('## Top Sections per Region');
        lines.push('');
        for (const u of memoryUsage) {
            const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
            const pct = u.total > 0 ? (u.used / u.total * 100).toFixed(1) + '%' : '—';
            lines.push(`### ${u.region} — ${formatSize(u.used)} / ${formatSize(u.total)} (${pct})`);
            lines.push('');
            const sorted = [...u.sections].sort((a, b) => b.size - a.size);
            const top = sorted.slice(0, topN);
            const rest = sorted.slice(topN);
            if (top.length === 0) {
                lines.push('_No sections._');
            } else {
                lines.push('| Section | Address | Size |');
                lines.push('|---|---|---|');
                for (const s of top) {
                    lines.push(`| ${s.name} | ${formatHex(s.addr)} | ${formatSize(s.size)} |`);
                }
                if (rest.length > 0) {
                    const restSize = rest.reduce((sum, s) => sum + s.size, 0);
                    lines.push('');
                    lines.push(`_+ ${rest.length} more sections, ${formatSize(restSize)} total._`);
                }
            }
            if (u.freeSpaces.length > 0) {
                const largestHole = u.freeSpaces.reduce((m, f) => f.size > m.size ? f : m);
                lines.push('');
                lines.push(`Free: ${formatSize(calcFree)} total — largest hole ${formatSize(largestHole.size)} @ ${formatHex(largestHole.addr)}`);
            }
            lines.push('');
        }

        // Highlights: at-a-glance signals that a reader might miss in the per-region tables.
        lines.push('## Highlights');
        lines.push('');
        let largestSec: { name: string; size: number; region: string } | null = null;
        let largestHoleAcross: { size: number; addr: number; region: string } | null = null;
        for (const u of memoryUsage) {
            for (const s of u.sections) {
                if (!largestSec || s.size > largestSec.size) { largestSec = { name: s.name, size: s.size, region: u.region }; }
            }
            for (const f of u.freeSpaces) {
                if (!largestHoleAcross || f.size > largestHoleAcross.size) { largestHoleAcross = { size: f.size, addr: f.addr, region: u.region }; }
            }
        }
        if (largestSec) {
            lines.push(`- Largest section: **${largestSec.name}** (${formatSize(largestSec.size)}) in ${largestSec.region}`);
        }
        if (largestHoleAcross) {
            lines.push(`- Largest free hole: ${formatSize(largestHoleAcross.size)} @ ${formatHex(largestHoleAcross.addr)} in ${largestHoleAcross.region}`);
        }
        // Region-saturation heads-up — anything ≥80% used is worth flagging.
        const saturated = memoryUsage.filter(u => u.total > 0 && (u.used / u.total) >= 0.8);
        if (saturated.length > 0) {
            const labels = saturated.map(u => `${u.region} (${(u.used / u.total * 100).toFixed(1)}%)`).join(', ');
            lines.push(`- Saturated regions (≥80%): ${labels}`);
        }
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
