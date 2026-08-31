/**
 * ELF32 픽스처 빌더.
 *
 * `buildMinimalElf32()`는 memoryMapViewer / memoryMapWebviewA11y /
 * webviewStringCoverage 세 테스트 파일에 각각 복사돼 있었다. 한 벌로 모은다 —
 * 픽스처가 커버리지를 좌우하는 물건이라(아래 참조) 세 벌이 따로 자라면 어느
 * 테스트가 무엇을 보고 있는지 알 수 없게 된다.
 *
 * ## 픽스처가 커버리지 경계다
 *
 * Memory Map 웹뷰는 **입력에 따라 다른 분기를 렌더한다.** 심볼이 없는 최소
 * ELF는 region 카드도 Object Summary 표도 그리지 않으므로, 그 마크업에 있는
 * 결함은 어떤 검사로도 보이지 않는다. 0.6.26의 하드코딩 문자열 탐지기가
 * `Function ▶`을 놓친 이유 중 하나가 이것이었다.
 *
 * 세 가지 입력이 서로 다른 영역을 연다.
 *
 * | 픽스처 | 여는 것 |
 * | --- | --- |
 * | `buildMinimalElf32()` | 개요 표, All Sections 표 |
 * | `buildElf32WithSymbols()` | + region 카드 상세 표, Object Summary |
 * | `buildElf32WithDwarfLines()` | + DWARF 4 함수별 소스 열기 |
 * | `buildElf32WithDwarf5Lines()` | + 외부 문자열 table을 쓰는 DWARF 5 소스 열기 |
 * | `examples/sample_armlink.txt` | + `func`(함수명) 열과 `Function ▶` 토글 |
 *
 * 마지막 줄이 중요하다: `func`는 **ARM link listing 파서만** 채운다.
 * `computeSymbolUsage`는 `object`까지만 만들므로, ELF를 아무리 풍부하게 만들어도
 * `hasFuncData`는 거짓이고 `Function ▶` 분기에는 도달하지 못한다.
 */

interface SectionSpec {
    name: string;
    /** SHT_* */
    type: number;
    /** SHF_* 조합 */
    flags: number;
    addr: number;
    size: number;
    /** 지정하면 결정적 패턴 대신 이 payload를 그대로 쓴다. */
    data?: Buffer;
}

interface SymbolSpec {
    name: string;
    addr: number;
    size: number;
    /** STT_FUNC(2) 또는 STT_OBJECT(1) — 파서는 이 둘만, 그것도 size>0일 때만 담는다. */
    type: 2 | 1;
    /** 소속 섹션 인덱스. `computeSymbolUsage`가 이걸로 부모 섹션명을 찾아 Object Summary를 묶는다. */
    sectionIndex: number;
}

const ELF_HEADER_SIZE = 52;
const SH_ENT_SIZE = 40;
const SYM_ENT_SIZE = 16;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

/**
 * 섹션 헤더만 있는 최소 ELF32 (심볼 테이블 없음).
 *
 * 파일 크기·매직·헤더 검증 같은 "파싱 자체"를 다루는 테스트용이다. 웹뷰
 * 렌더 분기를 검사하려면 `buildElf32WithSymbols()`를 쓸 것.
 */
export function buildMinimalElf32(sectionName = '.text'): Buffer {
    return assembleElf32([
        { name: sectionName, type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 1024 },
    ], []);
}

/**
 * 심볼 테이블을 가진 ELF32.
 *
 * `computeSymbolUsage`가 심볼 단위 엔트리를 만들고 부모 섹션명으로 묶어
 * **region 상세 표와 Object Summary 표**를 렌더시킨다 — 정적 마크업이 아니라
 * 웹뷰 스크립트가 `innerHTML`로 조립하는 영역이고, 정렬 헤더 접근성 결함이
 * 남아 있는 곳이다.
 *
 * 심볼을 두 섹션(.text / .data)에 걸쳐 두어 Object Summary가 그룹을 2개 이상
 * 갖게 한다. 그룹이 하나뿐이면 요약 표를 접는 분기로 빠진다.
 */
export function buildElf32WithSymbols(): Buffer {
    const sections: SectionSpec[] = [
        { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x400 },
        { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08000400, size: 0x100 },
        { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 0x80 },
        { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000080, size: 0x200 },
    ];
    // 섹션 인덱스는 1부터 (0번은 항상 NULL 섹션).
    const symbols: SymbolSpec[] = [
        { name: 'main', addr: 0x08000000, size: 0x120, type: 2, sectionIndex: 1 },
        { name: 'SystemInit', addr: 0x08000120, size: 0x80, type: 2, sectionIndex: 1 },
        { name: 'HAL_GPIO_Init', addr: 0x080001a0, size: 0x160, type: 2, sectionIndex: 1 },
        { name: 'g_config', addr: 0x20000000, size: 0x40, type: 1, sectionIndex: 3 },
        { name: 'g_buffer', addr: 0x20000040, size: 0x40, type: 1, sectionIndex: 3 },
    ];
    return assembleElf32(sections, symbols);
}

/**
 * 심볼과 DWARF 4 `.debug_line`을 함께 가진 ELF32.
 *
 * 세 함수의 시작 주소를 한 소스 파일의 서로 다른 줄에 연결한다. Memory Map의
 * host/webview 통합 테스트가 실제 ELF 파싱부터 소스 대상 생성까지 검증할 때 쓴다.
 */
export function buildElf32WithDwarfLines(sourcePath = 'src/main.c', debugLineFlags = 0): Buffer {
    const debugLine = buildDwarf4LineSection(sourcePath);
    const sections: SectionSpec[] = [
        { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x400 },
        { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08000400, size: 0x100 },
        { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 0x80 },
        { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000080, size: 0x200 },
        { name: '.debug_line', type: SHT_PROGBITS, flags: debugLineFlags, addr: 0, size: debugLine.length, data: debugLine },
    ];
    const symbols: SymbolSpec[] = [
        { name: 'main', addr: 0x08000000, size: 0x120, type: 2, sectionIndex: 1 },
        { name: 'SystemInit', addr: 0x08000120, size: 0x80, type: 2, sectionIndex: 1 },
        { name: 'HAL_GPIO_Init', addr: 0x080001a0, size: 0x160, type: 2, sectionIndex: 1 },
        { name: 'g_config', addr: 0x20000000, size: 0x40, type: 1, sectionIndex: 3 },
    ];
    return assembleElf32(sections, symbols);
}

export interface Dwarf5LineSectionsFixture {
    debugLine: Buffer;
    debugLineStr: Buffer;
}

/**
 * Clang/GCC가 내는 형태에 가까운 DWARF 5 line table을 만든다.
 * 경로는 `.debug_line_str`의 `DW_FORM_line_strp`로 참조하고 파일 인덱스 0을
 * line program에서 명시적으로 선택한다.
 */
export function buildDwarf5LineSections(
    sourcePath = 'src/main.c',
    sourceMd5?: Buffer
): Dwarf5LineSectionsFixture {
    if (sourceMd5 && sourceMd5.length !== 16) {
        throw new Error('DWARF 5 source MD5 fixture must contain exactly 16 bytes.');
    }
    const { directory, file } = splitDwarfPath(sourcePath);
    const directoryBytes = Buffer.from(encodeCString(directory));
    const fileOffset = directoryBytes.length;
    const debugLineStr = Buffer.concat([directoryBytes, Buffer.from(encodeCString(file))]);
    const header = [
        1, // minimum_instruction_length
        1, // maximum_operations_per_instruction
        1, // default_is_stmt
        0xfb, // line_base = -5
        14, // line_range
        13, // opcode_base
        0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1,
        1, // directory_entry_format_count
        ...encodeUleb(0x01), ...encodeUleb(0x1f), // path: line_strp
        ...encodeUleb(1),
        ...encodeUInt32LE(0),
        sourceMd5 ? 3 : 2, // file_name_entry_format_count
        ...encodeUleb(0x01), ...encodeUleb(0x1f), // path: line_strp
        ...encodeUleb(0x02), ...encodeUleb(0x0f), // directory_index: udata
        ...(sourceMd5 ? [...encodeUleb(0x05), ...encodeUleb(0x1e)] : []), // MD5: data16
        ...encodeUleb(1),
        ...encodeUInt32LE(fileOffset),
        ...encodeUleb(0),
        ...(sourceMd5 ?? []),
    ];
    const program = [
        4, ...encodeUleb(0), // DW_LNS_set_file 0 (DWARF 5의 0-based file table)
        0, ...encodeUleb(5), 2, ...encodeUInt32LE(0x08000000), // DW_LNE_set_address
        1, // main:1
        3, ...encodeSleb(9),
        2, ...encodeUleb(0x120),
        1, // SystemInit:10
        3, ...encodeSleb(10),
        2, ...encodeUleb(0x80),
        1, // HAL_GPIO_Init:20
        2, ...encodeUleb(0x160),
        0, ...encodeUleb(1), 1, // DW_LNE_end_sequence
    ];
    const body = [
        ...encodeUInt16LE(5),
        4, // address_size (ELF32)
        0, // segment_selector_size
        ...encodeUInt32LE(header.length),
        ...header,
        ...program,
    ];
    return {
        debugLine: Buffer.from([...encodeUInt32LE(body.length), ...body]),
        debugLineStr,
    };
}

/** 심볼과 DWARF 5 `.debug_line`·`.debug_line_str`을 함께 가진 ELF32. */
export function buildElf32WithDwarf5Lines(
    sourcePath = 'src/main.c',
    debugLineStrFlags = 0,
    additionalDebugLineUnits: Buffer[] = [],
    sourceMd5?: Buffer
): Buffer {
    const { debugLine, debugLineStr } = buildDwarf5LineSections(sourcePath, sourceMd5);
    const combinedDebugLine = Buffer.concat([debugLine, ...additionalDebugLineUnits]);
    const sections: SectionSpec[] = [
        { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 0x400 },
        { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, addr: 0x08000400, size: 0x100 },
        { name: '.data', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000000, size: 0x80 },
        { name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, addr: 0x20000080, size: 0x200 },
        { name: '.debug_line', type: SHT_PROGBITS, flags: 0, addr: 0, size: combinedDebugLine.length, data: combinedDebugLine },
        { name: '.debug_line_str', type: SHT_PROGBITS, flags: debugLineStrFlags, addr: 0, size: debugLineStr.length, data: debugLineStr },
    ];
    const symbols: SymbolSpec[] = [
        { name: 'main', addr: 0x08000000, size: 0x120, type: 2, sectionIndex: 1 },
        { name: 'SystemInit', addr: 0x08000120, size: 0x80, type: 2, sectionIndex: 1 },
        { name: 'HAL_GPIO_Init', addr: 0x080001a0, size: 0x160, type: 2, sectionIndex: 1 },
        { name: 'g_config', addr: 0x20000000, size: 0x40, type: 1, sectionIndex: 3 },
    ];
    return assembleElf32(sections, symbols);
}

function encodeUleb(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    do {
        let byte = rest & 0x7f;
        rest = Math.floor(rest / 128);
        if (rest > 0) { byte |= 0x80; }
        bytes.push(byte);
    } while (rest > 0);
    return bytes;
}

function encodeSleb(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    let more = true;
    while (more) {
        let byte = rest & 0x7f;
        rest >>= 7;
        const sign = (byte & 0x40) !== 0;
        more = !((rest === 0 && !sign) || (rest === -1 && sign));
        if (more) { byte |= 0x80; }
        bytes.push(byte);
    }
    return bytes;
}

function encodeCString(value: string): number[] {
    return [...Buffer.from(value, 'utf8'), 0];
}

function encodeUInt16LE(value: number): number[] {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    return [...buffer];
}

function encodeUInt32LE(value: number): number[] {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return [...buffer];
}

function splitDwarfPath(sourcePath: string): { directory: string; file: string } {
    const normalized = sourcePath.replace(/\\/g, '/');
    const separator = normalized.lastIndexOf('/');
    if (separator < 0) { return { directory: '', file: normalized }; }
    const directory = normalized.slice(0, separator) || '/';
    return { directory, file: normalized.slice(separator + 1) };
}

/** DWARF 4 line unit 하나를 만든다. */
export function buildDwarf4LineSection(sourcePath = 'src/main.c'): Buffer {
    const { directory, file } = splitDwarfPath(sourcePath);
    const directories = directory ? [...encodeCString(directory), 0] : [0];
    const header = [
        1, // minimum_instruction_length
        1, // maximum_operations_per_instruction
        1, // default_is_stmt
        0xfb, // line_base = -5
        14, // line_range
        13, // opcode_base
        0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1,
        ...directories,
        ...encodeCString(file), ...encodeUleb(directory ? 1 : 0), ...encodeUleb(0), ...encodeUleb(0),
        0,
    ];
    const program = [
        0, ...encodeUleb(5), 2, ...encodeUInt32LE(0x08000000), // DW_LNE_set_address
        1, // main:1
        3, ...encodeSleb(9),
        2, ...encodeUleb(0x120),
        1, // SystemInit:10
        3, ...encodeSleb(10),
        2, ...encodeUleb(0x80),
        1, // HAL_GPIO_Init:20
        2, ...encodeUleb(0x160),
        0, ...encodeUleb(1), 1, // DW_LNE_end_sequence
    ];
    const body = [
        ...encodeUInt16LE(4),
        ...encodeUInt32LE(header.length),
        ...header,
        ...program,
    ];
    return Buffer.from([...encodeUInt32LE(body.length), ...body]);
}

/**
 * 위 두 빌더가 공유하는 조립기.
 *
 * 레이아웃: [ELF 헤더][PROGBITS payload][.shstrtab][.strtab][.symtab][섹션 헤더 배열]
 * 섹션 헤더 인덱스: 0=NULL, 1..N=요청한 섹션, N+1=.shstrtab, N+2=.strtab, N+3=.symtab
 * (심볼이 없으면 뒤 둘은 만들지 않는다.)
 */
function assembleElf32(sections: SectionSpec[], symbols: SymbolSpec[]): Buffer {
    const withSymbols = symbols.length > 0;

    // --- 섹션 이름 문자열 테이블 (.shstrtab) ---
    let shstr = '\0';
    const sectionNameOffsets: number[] = [];
    for (const sec of sections) {
        sectionNameOffsets.push(shstr.length);
        shstr += sec.name + '\0';
    }
    const shstrtabNameOffset = shstr.length;
    shstr += '.shstrtab\0';
    let strtabNameOffset = 0;
    let symtabNameOffset = 0;
    if (withSymbols) {
        strtabNameOffset = shstr.length;
        shstr += '.strtab\0';
        symtabNameOffset = shstr.length;
        shstr += '.symtab\0';
    }
    const shstrBuf = Buffer.from(shstr, 'ascii');

    // --- 심볼 이름 문자열 테이블 (.strtab) ---
    let symStr = '\0';
    const symbolNameOffsets: number[] = [];
    for (const sym of symbols) {
        symbolNameOffsets.push(symStr.length);
        symStr += sym.name + '\0';
    }
    const symStrBuf = withSymbols ? Buffer.from(symStr, 'ascii') : Buffer.alloc(0);

    // --- 심볼 테이블 (.symtab). 0번은 관례상 NULL 엔트리. ---
    const symCount = withSymbols ? symbols.length + 1 : 0;
    const symtabBuf = Buffer.alloc(symCount * SYM_ENT_SIZE, 0);
    symbols.forEach((sym, i) => {
        const base = (i + 1) * SYM_ENT_SIZE;
        symtabBuf.writeUInt32LE(symbolNameOffsets[i], base);      // st_name
        symtabBuf.writeUInt32LE(sym.addr, base + 4);              // st_value
        symtabBuf.writeUInt32LE(sym.size, base + 8);              // st_size
        // st_info: 상위 4비트 binding(1=GLOBAL), 하위 4비트 type
        symtabBuf[base + 12] = (1 << 4) | sym.type;
        symtabBuf[base + 13] = 0;                                 // st_other
        symtabBuf.writeUInt16LE(sym.sectionIndex, base + 14);      // st_shndx
    });

    // --- 오프셋 배치 ---
    // 실제 file-backed payload를 넣는다. 예전 픽스처는 모든 섹션의 sh_offset을
    // .shstrtab에 겹쳐 놓아 Memory Map은 그럴듯했지만, 주소→파일 offset 기능은
    // 성공 경로를 하나도 만들 수 없었다.
    let payloadEnd = ELF_HEADER_SIZE;
    const sectionOffsets = sections.map(sec => {
        const offset = payloadEnd;
        if (sec.type !== SHT_NOBITS) { payloadEnd += sec.size; }
        return offset;
    });
    const shstrOffset = payloadEnd;
    const symStrOffset = shstrOffset + shstrBuf.length;
    const symtabOffset = symStrOffset + symStrBuf.length;
    const shOffset = symtabOffset + symtabBuf.length;

    const totalSections = 1 + sections.length + 1 + (withSymbols ? 2 : 0);
    const shstrtabIndex = 1 + sections.length;
    const strtabIndex = shstrtabIndex + 1;
    const symtabIndex = shstrtabIndex + 2;

    const buf = Buffer.alloc(shOffset + totalSections * SH_ENT_SIZE, 0);

    // --- ELF 헤더 ---
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;   // \x7fELF
    buf[4] = 1;   // EI_CLASS = ELFCLASS32
    buf[5] = 1;   // EI_DATA  = ELFDATA2LSB
    buf[6] = 1;   // EI_VERSION
    buf.writeUInt16LE(2, 16);              // e_type = ET_EXEC
    buf.writeUInt16LE(40, 18);             // e_machine = EM_ARM
    buf.writeUInt32LE(1, 20);              // e_version
    buf.writeUInt32LE(sections[0]?.addr ?? 0, 24);  // e_entry
    buf.writeUInt32LE(shOffset, 32);       // e_shoff
    buf.writeUInt16LE(ELF_HEADER_SIZE, 40);// e_ehsize
    buf.writeUInt16LE(SH_ENT_SIZE, 46);    // e_shentsize
    buf.writeUInt16LE(totalSections, 48);  // e_shnum
    buf.writeUInt16LE(shstrtabIndex, 50);  // e_shstrndx

    shstrBuf.copy(buf, shstrOffset);
    symStrBuf.copy(buf, symStrOffset);
    symtabBuf.copy(buf, symtabOffset);
    sections.forEach((sec, sectionIndex) => {
        if (sec.type === SHT_NOBITS) { return; }
        if (sec.data) {
            sec.data.copy(buf, sectionOffsets[sectionIndex]);
            return;
        }
        // 섹션마다 구분되는 결정적 byte 패턴. 선택 범위가 실제 payload를
        // 가리키는지 통합 테스트에서 확인할 수 있다.
        for (let i = 0; i < sec.size; i++) {
            buf[sectionOffsets[sectionIndex] + i] = (sectionIndex * 0x31 + i) & 0xff;
        }
    });

    // --- 섹션 헤더들 ---
    const writeSectionHeader = (index: number, fields: {
        nameOffset: number; type: number; flags: number; addr: number;
        offset: number; size: number; link?: number; entSize?: number;
    }) => {
        const base = shOffset + index * SH_ENT_SIZE;
        buf.writeUInt32LE(fields.nameOffset, base);       // sh_name
        buf.writeUInt32LE(fields.type, base + 4);         // sh_type
        buf.writeUInt32LE(fields.flags, base + 8);        // sh_flags
        buf.writeUInt32LE(fields.addr, base + 12);        // sh_addr
        buf.writeUInt32LE(fields.offset, base + 16);      // sh_offset
        buf.writeUInt32LE(fields.size, base + 20);        // sh_size
        buf.writeUInt32LE(fields.link ?? 0, base + 24);   // sh_link
        buf.writeUInt32LE(fields.entSize ?? 0, base + 36);// sh_entsize
    };

    sections.forEach((sec, i) => {
        writeSectionHeader(i + 1, {
            nameOffset: sectionNameOffsets[i],
            type: sec.type,
            flags: sec.flags,
            addr: sec.addr,
            // NOBITS는 현재 payload 끝을 가리키지만 파일 공간은 늘리지 않는다.
            offset: sectionOffsets[i],
            size: sec.size,
        });
    });

    writeSectionHeader(shstrtabIndex, {
        nameOffset: shstrtabNameOffset,
        type: SHT_STRTAB,
        flags: 0,
        addr: 0,
        offset: shstrOffset,
        size: shstrBuf.length,
    });

    if (withSymbols) {
        writeSectionHeader(strtabIndex, {
            nameOffset: strtabNameOffset,
            type: SHT_STRTAB,
            flags: 0,
            addr: 0,
            offset: symStrOffset,
            size: symStrBuf.length,
        });
        writeSectionHeader(symtabIndex, {
            nameOffset: symtabNameOffset,
            type: SHT_SYMTAB,
            flags: 0,
            addr: 0,
            offset: symtabOffset,
            size: symtabBuf.length,
            // sh_link는 이 심볼 테이블이 쓰는 문자열 테이블의 섹션 인덱스다.
            // 틀리면 파서가 "string table index out of range"로 던진다.
            link: strtabIndex,
            entSize: SYM_ENT_SIZE,
        });
    }

    return buf;
}
