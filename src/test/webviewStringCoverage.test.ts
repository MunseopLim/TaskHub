import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildJsonEditorStrings, getWebviewContent as getJsonEditorHtml } from '../jsonEditor';
import { buildHexViewerHtml, buildHexViewerStrings } from '../hexViewer';
import { buildMemoryMapStrings, openMemoryMapPanel, panelRegistry } from '../memoryMapViewer';
import { parseIntelHex } from '../hexParser';

/**
 * 웹뷰 하드코딩 문자열 탐지 (0.6.26).
 *
 * 0.6.19~0.6.21의 각 웹뷰 테스트는 `S.*` **참조**가 번들에 실재하는지만
 * 검사했다. 그 검사는 애초에 번들에 넣지 않은 문자열 — `+ Add`,
 * `Object Summary`, `No matches` 같은 것들 — 을 원리적으로 찾을 수 없다.
 * 코드 리뷰가 정확히 그 사각지대를 지적했고, 이 파일이 반대 방향에서 메운다.
 *
 * 방식: 렌더된 HTML에서 **사용자에게 보이는 자리**(버튼/옵션 텍스트,
 * `title` / `aria-label` / `placeholder` 속성)의 문자열을 뽑아, 번들 값이나
 * 아래 허용 목록에 없는 영문 문자열이 남아 있으면 실패시킨다.
 *
 * 허용 목록은 "번역하지 않기로 한 것"의 명시적 기록이다 — 짧은 기술 식별자,
 * 포맷 이름, 예시 입력값. 새 항목을 추가할 때는 왜 번역 대상이 아닌지
 * 분명해야 한다.
 */

/** 번역 대상이 아닌 문자열. 각 항목의 근거는 CLAUDE.md의 i18n 제외 규칙. */
const NOT_TRANSLATED = new Set([
    // 포맷 / 기술 식별자
    'ASCII', 'Little-Endian', 'Big-Endian', 'Intel HEX', 'Motorola SREC', 'Binary',
    'JSON', 'HTML', 'u8', 'u16', 'u32', 'FREE',
    // 예시 입력값 (placeholder)
    '0x08000000 / 1024', '20020000', '00 00 02 20', 'Hello',
]);

/**
 * 스크립트가 런타임에 조립하는 조각인가.
 *
 * 웹뷰 HTML 안에는 `'... title="' + escapeAttr(S.foo) + '" ...'` 같은 JS
 * 리터럴이 그대로 들어 있어, 속성 정규식에 조각이 걸린다. 이런 조각은
 * 실행 시 번들 값으로 채워지므로 검사 대상이 아니다. **원본 문자열** 기준으로
 * 판정해야 한다 — 장식 글리프를 떼어낸 뒤에는 `+` 같은 단서가 사라진다.
 */
function isScriptFragment(raw: string): boolean {
    return /\$\{|'\s*\+|\+\s*'|escapeAttr\(|escapeHtml\(|\bS\.\w/.test(raw);
}

/**
 * 사용자 데이터인가 — 파일 경로, 섹션/심볼 이름, 주소 같은 값은 번역 대상이
 * 아니다. 파일 경로가 그대로 title에 들어가는 자리가 있어(현재 열린 파일)
 * 이 구분이 없으면 탐지기가 데이터를 문구로 오인한다.
 */
function looksLikeUserData(value: string): boolean {
    return /[\\/]/.test(value) || /^0x[0-9a-fA-F]/.test(value) || /^\.[a-z]/.test(value);
}

/** 영문 UI 문구로 보이는가 — 소문자 두 글자 이상이 이어지면 의심한다. */
function looksLikeEnglishPhrase(value: string): boolean {
    return /[a-z]{2}/.test(value) && !looksLikeUserData(value);
}

/**
 * 사용자에게 보이는 자리의 문자열을 뽑는다. 정규식이 놓치는 자리는 있지만,
 * 실제 결함(버튼 라벨 / 옵션 / 접근성 이름)이 나타나는 자리는 덮는다.
 */
function extractVisibleStrings(html: string): string[] {
    const found: string[] = [];
    const patterns = [
        /<button[^>]*>([^<]{2,})<\/button>/g,
        /<option[^>]*>([^<]{2,})<\/option>/g,
        /\btitle="([^"]{2,})"/g,
        /\baria-label="([^"]{2,})"/g,
        /\bplaceholder="([^"]{2,})"/g,
    ];
    for (const pattern of patterns) {
        for (const match of html.matchAll(pattern)) {
            const raw = match[1];
            if (isScriptFragment(raw)) { continue; }
            // 장식 글리프만 제거한다. `+`는 남긴다 — `Ctrl+F`, `Shift+Enter`
            // 처럼 번들 값의 일부인 경우가 있어 떼어내면 대조가 어긋난다.
            const value = raw
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                .replace(/[▶▼◀▲↑↶↷✕⠿]/g, '')
                .trim();
            if (value.length >= 2) { found.push(value); }
        }
    }
    return found;
}

function assertNoHardcodedStrings(html: string, bundle: Record<string, string>, label: string): void {
    const known = new Set<string>();
    for (const value of Object.values(bundle)) {
        known.add(value);
        // "{n}번 행 삭제" 처럼 치환 후 형태도 허용 범위에 넣는다.
        known.add(value.replace(/\{\w+\}/g, '').replace(/\s+/g, ' ').trim());
    }

    const leftovers = extractVisibleStrings(html)
        .filter(looksLikeEnglishPhrase)
        .filter(value => !known.has(value))
        .filter(value => !NOT_TRANSLATED.has(value))
        // `+ 항목 추가` 처럼 번들 값에 접두 글자가 붙거나, 치환자를 지운
        // 부분만 잡힌 경우는 통과시킨다 (양방향 부분 일치).
        .filter(value => !Array.from(known).some(entry =>
            entry.length >= 2 && (entry.includes(value) || value.includes(entry))));

    assert.deepStrictEqual(
        Array.from(new Set(leftovers)).sort(),
        [],
        `${label}: 번들에 없는 영문 문자열이 남아 있다. 번역하거나, 의도적으로 두는 것이면 NOT_TRANSLATED에 근거와 함께 추가할 것.`
    );
}

suite('웹뷰 하드코딩 문자열 탐지', () => {

    test('JSON Editor', () => {
        const html = getJsonEditorHtml(
            { rows: [{ name: 'a', tags: ['x', 'y'] }] },
            undefined,
            '/tmp/sample.json',
            { cspSource: 'https://test.invalid' } as unknown as vscode.Webview
        );
        assertNoHardcodedStrings(html, buildJsonEditorStrings(), 'JSON Editor');
    });

    test('Hex Viewer', () => {
        const parsed = parseIntelHex([':10000000000102030405060708090A0B0C0D0E0F78', ':00000001FF'].join('\n'));
        assertNoHardcodedStrings(buildHexViewerHtml('firmware.hex', parsed), buildHexViewerStrings(), 'Hex Viewer');
    });

    test('Memory Map', function () {
        this.timeout(10000);
        panelRegistry.clear();
        const filePath = path.join(os.tmpdir(), `taskhub-strcov-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildMinimalElf32());
        try {
            const ctx = {
                extensionPath: path.resolve(__dirname, '..', '..'),
                subscriptions: [],
            } as unknown as vscode.ExtensionContext;
            assert.ok(openMemoryMapPanel(ctx, filePath, {
                regions: [{ name: 'FLASH', origin: 0x08000000, size: 512 * 1024 }],
            }));
            assertNoHardcodedStrings(panelRegistry.getHtml(filePath) ?? '', buildMemoryMapStrings(), 'Memory Map');
        } finally {
            panelRegistry.clear();
            try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        }
    });

    test('탐지기가 실제로 하드코딩을 잡는지 (자기 검증)', () => {
        // 탐지기가 조용히 무력화되면(정규식 오류 등) 위 세 테스트가 의미 없이
        // 통과한다. 일부러 심은 문자열을 잡는지 확인한다.
        assert.throws(
            () => assertNoHardcodedStrings('<button title="Save all files">Save all files</button>', {}, 'probe'),
            /번들에 없는 영문 문자열/
        );
        assert.throws(
            () => assertNoHardcodedStrings('<option value="x">Object Summary</option>', {}, 'probe'),
            /번들에 없는 영문 문자열/
        );
    });
});

function buildMinimalElf32(): Buffer {
    const sections = [{ name: '.text', type: 1, flags: 0x6, addr: 0x08000000, size: 1024 }];
    let strTab = '\0';
    const nameOffsets: number[] = [];
    for (const sec of sections) {
        nameOffsets.push(strTab.length);
        strTab += sec.name + '\0';
    }
    const shstrtabNameOffset = strTab.length;
    strTab += '.shstrtab\0';

    const strTabBuf = Buffer.from(strTab, 'ascii');
    const elfHeaderSize = 52;
    const shEntSize = 40;
    const totalSections = 1 + sections.length + 1;
    const strTabOffset = elfHeaderSize;
    const shOffset = elfHeaderSize + strTabBuf.length;
    const buf = Buffer.alloc(shOffset + totalSections * shEntSize, 0);

    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
    buf[4] = 1; buf[5] = 1; buf[6] = 1;
    buf.writeUInt16LE(2, 16);
    buf.writeUInt16LE(40, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(0x08000000, 24);
    buf.writeUInt32LE(shOffset, 32);
    buf.writeUInt16LE(elfHeaderSize, 40);
    buf.writeUInt16LE(shEntSize, 46);
    buf.writeUInt16LE(totalSections, 48);
    buf.writeUInt16LE(totalSections - 1, 50);
    strTabBuf.copy(buf, strTabOffset);

    for (let i = 0; i < sections.length; i++) {
        const base = shOffset + (i + 1) * shEntSize;
        buf.writeUInt32LE(nameOffsets[i], base);
        buf.writeUInt32LE(sections[i].type, base + 4);
        buf.writeUInt32LE(sections[i].flags, base + 8);
        buf.writeUInt32LE(sections[i].addr, base + 12);
        buf.writeUInt32LE(strTabOffset, base + 16);
        buf.writeUInt32LE(sections[i].size, base + 20);
    }
    const shstrtabBase = shOffset + (totalSections - 1) * shEntSize;
    buf.writeUInt32LE(shstrtabNameOffset, shstrtabBase);
    buf.writeUInt32LE(3, shstrtabBase + 4);
    buf.writeUInt32LE(strTabOffset, shstrtabBase + 16);
    buf.writeUInt32LE(strTabBuf.length, shstrtabBase + 20);
    return buf;
}
