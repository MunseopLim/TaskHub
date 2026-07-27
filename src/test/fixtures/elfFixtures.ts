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
export function buildMinimalElf32(): Buffer {
    return assembleElf32([
        { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 1024 },
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
 * 위 두 빌더가 공유하는 조립기.
 *
 * 레이아웃: [ELF 헤더][.shstrtab][.strtab][.symtab][섹션 헤더 배열]
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
    const shstrOffset = ELF_HEADER_SIZE;
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
            // NOBITS는 파일을 차지하지 않는다. 어차피 내용을 읽지 않으므로
            // shstrtab 오프셋을 재사용해도 파서가 신경 쓰지 않는다.
            offset: shstrOffset,
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
