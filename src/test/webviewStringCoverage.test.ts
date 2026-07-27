import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildJsonEditorStrings, getWebviewContent as getJsonEditorHtml } from '../jsonEditor';
import { buildHexViewerHtml, buildHexViewerStrings } from '../hexViewer';
import { buildMemoryMapStrings, openMemoryMapFromListing, openMemoryMapPanel, panelRegistry } from '../memoryMapViewer';
import { parseIntelHex } from '../hexParser';
import { t } from '../i18n';
import { buildElf32WithSymbols, buildMinimalElf32 } from './fixtures/elfFixtures';

/**
 * 웹뷰 하드코딩 문자열 탐지 (0.6.26, 0.6.27에서 로케일 의존 제거).
 *
 * 0.6.19~0.6.21의 각 웹뷰 테스트는 `S.*` **참조**가 번들에 실재하는지만
 * 검사했다. 그 검사는 애초에 번들에 넣지 않은 문자열 — `+ Add`,
 * `Object Summary`, `No matches` 같은 것들 — 을 원리적으로 찾을 수 없다.
 * 코드 리뷰가 정확히 그 사각지대를 지적했고, 이 파일이 반대 방향에서 메운다.
 *
 * 방식: 렌더된 HTML에서 **사용자에게 보이는 자리**(버튼/옵션 텍스트,
 * `title` / `aria-label` / `placeholder` 속성)의 문자열을 뽑아, 번들 값이나
 * 아래 허용 목록에 없는 문자열이 남아 있으면 실패시킨다.
 *
 * ## 왜 두 로케일에서 모두 돌리는가 (0.6.27)
 *
 * 0.6.26의 탐지기는 **호스트 로케일에 의존**했다. 대조 대상인 `buildXStrings()`
 * 가 `t(ko, en)`로 평가되므로, 영어 호스트에서는 번들이 영어 문자열을 담는다.
 * 그래서 하드코딩된 영문 리터럴이 번들의 영어 값과 **우연히 일치**하면 그대로
 * 통과했다. `Function ▶`이 정확히 그 경우다 — 번들에 `colFunction: t('함수',
 * 'Function')`이 이미 있어서, 영어 CI에서는 `Function`이 "번들에 있는 값"으로
 * 보였다. 즉 한국어 사용자에게 결함이 보이는 바로 그 조건에서만 실패하고
 * CI에서는 조용히 통과하는, 없느니만 못한 검사였다.
 *
 * 이제 로케일을 명시적으로 고정해 두 번 돌린다.
 *
 *   - **ko 렌더**: 번들 값이 한국어이므로, 남아 있는 영문 리터럴은 더 이상
 *     번들 값과 겹칠 수 없다. 하드코딩 영문을 잡는 것은 이쪽이다.
 *   - **en 렌더**: 반대 방향 결함 — 영어 UI에 한글이 그대로 박힌 경우
 *     (0.6.21의 '맨 위로' 버튼이 실제 사례) — 을 잡는다.
 *
 * 허용 목록은 "번역하지 않기로 한 것"의 명시적 기록이다 — 짧은 기술 식별자,
 * 포맷 이름, 예시 입력값. 새 항목을 추가할 때는 왜 번역 대상이 아닌지
 * 분명해야 한다.
 *
 * ## 픽스처가 커버리지 경계다 (0.6.31)
 *
 * Memory Map 웹뷰는 **입력에 따라 다른 분기를 렌더한다.** 0.6.30까지는 심볼이
 * 없는 최소 ELF 하나만 썼고, 그래서 region 상세 표 / Object Summary /
 * `Function ▶` 토글이 달린 `section-heading` 분기가 아예 그려지지 않았다 —
 * 그 마크업의 결함은 어떤 검사로도 보이지 않았다. 이제 세 입력을 모두 돌린다.
 *
 *   - `buildElf32WithSymbols()` → region 상세 표, Object Summary
 *   - `examples/sample_armlink.txt` → `func` 열과 `Function ▶` 토글
 *     (`func`는 ARM link listing 파서만 채운다. `computeSymbolUsage`는
 *      `object`까지만 만들므로 ELF로는 이 분기에 닿을 수 없다.)
 *
 * 각 테스트는 검사 전에 **그 분기가 실제로 열렸는지** 먼저 단언한다. 픽스처가
 * 조용히 망가지면 빈 화면을 검사하며 통과하기 때문이다. 픽스처 자체의 전제는
 * `elfFixtures.test.ts`가 따로 못박는다.
 *
 * ## 남은 사각지대 — 과신하지 말 것
 *
 * **웹뷰 스크립트가 런타임에 조립하는 DOM은 여전히 검사하지 않는다.** 여기서
 * 보는 것은 호스트가 만든 정적 HTML이고, `isScriptFragment()`가 `S.*`를 포함한
 * 조각을 건너뛴다. `innerHTML +=`로 만들어지는 마크업(Hex Viewer 상태 표시줄의
 * `'<span>Offset: '`가 그 예였다)은 원리적으로 밖에 있다. 픽스처를 늘려도 이건
 * 닫히지 않는다 — 검사 대상이 문자열로서의 HTML이지 실행된 DOM이 아니기
 * 때문이다. "탐지기가 통과했으니 하드코딩이 없다"고 결론내면 안 된다.
 */

/**
 * `vscode.env.language`를 고정한 채 `body`를 실행한다.
 *
 * 고정이 **실제로 `t()`에 도달했는지**를 안에서 확인한다. 이 자기 검증이
 * 없으면 향후 VS Code가 `language`를 재정의 불가로 바꿨을 때 탐지기가 조용히
 * 원래의 로케일 의존 상태로 돌아간다 — 이 함수가 고치려는 결함 그 자체다.
 */
function withLanguage<T>(language: string, body: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.env, 'language');
    assert.ok(
        descriptor && (descriptor.configurable || typeof descriptor.set === 'function'),
        'vscode.env.language를 테스트에서 고정할 수 없다. 고정 없이는 이 탐지기가 호스트 로케일에 의존하게 되므로, 대안(예: t()에 주입 seam 추가)을 찾을 것.'
    );
    Object.defineProperty(vscode.env, 'language', { value: language, configurable: true });
    try {
        assert.strictEqual(
            t('한국어', 'English'),
            language.startsWith('ko') ? '한국어' : 'English',
            `로케일 고정이 t()에 반영되지 않았다 (language=${language})`
        );
        return body();
    } finally {
        Object.defineProperty(vscode.env, 'language', descriptor!);
    }
}

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
 * 한글이 섞여 있는가. **영어 렌더**에서만 의미가 있다 — 그 자리에 한글이
 * 보인다는 것은 `t()`를 거치지 않고 한국어를 박아 넣었다는 뜻이다
 * (0.6.21이 고친 '맨 위로' 버튼이 실제 사례).
 */
function containsHangul(value: string): boolean {
    return /[가-힣]/.test(value) && !looksLikeUserData(value);
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

/**
 * @param lang 이 HTML이 렌더된 로케일. **반대 언어**의 문자열이 보이는 자리에
 *   남아 있으면 하드코딩이다 — ko 렌더의 영문, en 렌더의 한글.
 */
function assertNoHardcodedStrings(
    html: string,
    bundle: Record<string, string>,
    label: string,
    lang: 'ko' | 'en'
): void {
    const known = new Set<string>();
    for (const value of Object.values(bundle)) {
        known.add(value);
        // "{n}번 행 삭제" 처럼 치환 후 형태도 허용 범위에 넣는다.
        known.add(value.replace(/\{\w+\}/g, '').replace(/\s+/g, ' ').trim());
    }

    // ko 렌더에서 영문을 찾는 쪽이 핵심 검사다. 번들 값이 한국어라 하드코딩된
    // 영문 리터럴이 번들 값과 겹칠 수 없다 — 0.6.26이 `Function ▶`을 놓친
    // 경로가 여기서 막힌다.
    const isSuspicious = lang === 'ko' ? looksLikeEnglishPhrase : containsHangul;

    const leftovers = extractVisibleStrings(html)
        .filter(isSuspicious)
        .filter(value => !known.has(value))
        .filter(value => !NOT_TRANSLATED.has(value))
        // `+ 항목 추가` 처럼 **렌더된 값이 번들 값을 감싸는** 경우만 통과시킨다.
        //
        // 반대 방향(`entry.includes(value)` — 긴 번들 값이 렌더된 조각을 포함)은
        // 0.6.26에 있었으나 제거했다. 그건 "어떤 번들 값 안에 이 조각이 우연히
        // 들어 있다"는 뜻일 뿐이고, 정확히 그 우연이 탐지기를 무력화한다:
        // 하드코딩된 `Function ▶`은 번들의 `toggleFunctionColumn`
        // (ko: `Function 열 표시 전환`)이 'Function'을 포함한다는 이유로
        // 통과했다. 이 탐지기가 잡아야 할 대표 사례가 필터에 걸려 있었던 것이다.
        .filter(value => !Array.from(known).some(entry =>
            entry.length >= 2 && value.includes(entry)));

    assert.deepStrictEqual(
        Array.from(new Set(leftovers)).sort(),
        [],
        `${label} (${lang} 렌더): 번들에 없는 ${lang === 'ko' ? '영문' : '한글'} 문자열이 남아 있다. 번역하거나, 의도적으로 두는 것이면 NOT_TRANSLATED에 근거와 함께 추가할 것.`
    );
}

suite('웹뷰 하드코딩 문자열 탐지', () => {

    // 두 로케일 모두에서 돌린다 — 근거는 파일 상단 주석 참조.
    for (const lang of ['ko', 'en'] as const) {

        test(`JSON Editor (${lang})`, () => {
            withLanguage(lang, () => {
                const html = getJsonEditorHtml(
                    { rows: [{ name: 'a', tags: ['x', 'y'] }] },
                    undefined,
                    '/tmp/sample.json',
                    { cspSource: 'https://test.invalid' } as unknown as vscode.Webview
                );
                assertNoHardcodedStrings(html, buildJsonEditorStrings(), 'JSON Editor', lang);
            });
        });

        test(`Hex Viewer (${lang})`, () => {
            withLanguage(lang, () => {
                const parsed = parseIntelHex([':10000000000102030405060708090A0B0C0D0E0F78', ':00000001FF'].join('\n'));
                assertNoHardcodedStrings(
                    buildHexViewerHtml('firmware.hex', parsed),
                    buildHexViewerStrings(),
                    'Hex Viewer',
                    lang
                );
            });
        });

        /**
         * ARM link listing 경로. ELF 픽스처로는 도달할 수 없는 분기를 연다.
         *
         * `func`(함수명)는 **listing 파서만** 채운다 — `computeSymbolUsage`는
         * `object`까지만 만든다. 그래서 `hasFuncData`가 참이 되는 경로가
         * ELF에는 없고, `Function ▶` 열 토글 버튼이 달린 `section-heading`
         * 분기 자체가 ELF 렌더에서는 그려지지 않았다. 0.6.27이 그 버튼의
         * 하드코딩을 고치고도 탐지기로는 확인할 수 없었던 이유다.
         */
        test(`Memory Map — ARM link listing (${lang})`, function () {
            this.timeout(10000);
            withLanguage(lang, () => {
                panelRegistry.clear();
                const listingPath = path.resolve(__dirname, '..', '..', 'examples', 'sample_armlink.txt');
                assert.ok(fs.existsSync(listingPath), `픽스처가 없다: ${listingPath}`);
                try {
                    const ctx = {
                        extensionPath: path.resolve(__dirname, '..', '..'),
                        subscriptions: [],
                    } as unknown as vscode.ExtensionContext;
                    assert.ok(openMemoryMapFromListing(ctx, listingPath));
                    const html = panelRegistry.getHtml(listingPath) ?? '';
                    // 이 분기가 실제로 열렸는지 먼저 못박는다. 픽스처가 바뀌어
                    // func 정보를 잃으면 아래 검사가 조용히 무의미해진다.
                    assert.ok(
                        html.includes('toggle-func-col'),
                        'Function 열 토글이 렌더되지 않았다 — 이 테스트가 열려던 분기에 도달하지 못했다'
                    );
                    assertNoHardcodedStrings(html, buildMemoryMapStrings(), 'Memory Map (listing)', lang);
                } finally {
                    panelRegistry.clear();
                }
            });
        });

        /**
         * 심볼을 가진 ELF. 최소 ELF로는 열리지 않는 **region 상세 표와
         * Object Summary** 분기를 그린다 — 웹뷰 스크립트가 `innerHTML`로
         * 조립하는 영역이라, 픽스처가 이걸 열지 못하면 그 마크업의 결함은
         * 어떤 검사로도 보이지 않는다.
         */
        test(`Memory Map (${lang})`, function () {
            this.timeout(10000);
            withLanguage(lang, () => {
                panelRegistry.clear();
                const filePath = path.join(os.tmpdir(), `taskhub-strcov-${lang}-${process.pid}.axf`);
                fs.writeFileSync(filePath, buildElf32WithSymbols());
                try {
                    const ctx = {
                        extensionPath: path.resolve(__dirname, '..', '..'),
                        subscriptions: [],
                    } as unknown as vscode.ExtensionContext;
                    assert.ok(openMemoryMapPanel(ctx, filePath, {
                        regions: [
                            { name: 'FLASH', origin: 0x08000000, size: 512 * 1024 },
                            { name: 'RAM', origin: 0x20000000, size: 128 * 1024 },
                        ],
                    }));
                    const html = panelRegistry.getHtml(filePath) ?? '';
                    // 분기가 실제로 열렸는지 못박는다. 픽스처가 조용히 망가지면
                    // 아래 검사가 빈 화면을 보며 통과한다.
                    assert.ok(html.includes('region-card'), 'region 카드가 렌더되지 않았다');
                    assertNoHardcodedStrings(html, buildMemoryMapStrings(), 'Memory Map', lang);
                } finally {
                    panelRegistry.clear();
                    try { fs.unlinkSync(filePath); } catch { /* best effort */ }
                }
            });
        });
    }

    test('탐지기가 실제로 하드코딩을 잡는지 (자기 검증)', () => {
        // 탐지기가 조용히 무력화되면(정규식 오류 등) 위 여섯 테스트가 의미 없이
        // 통과한다. 일부러 심은 문자열을 잡는지 확인한다.
        assert.throws(
            () => assertNoHardcodedStrings('<button title="Save all files">Save all files</button>', {}, 'probe', 'ko'),
            /번들에 없는 영문 문자열/
        );
        assert.throws(
            () => assertNoHardcodedStrings('<option value="x">Object Summary</option>', {}, 'probe', 'ko'),
            /번들에 없는 영문 문자열/
        );
        // 반대 방향 — 영어 UI에 박힌 한글 (0.6.21의 '맨 위로' 버튼이 실제 사례).
        assert.throws(
            () => assertNoHardcodedStrings('<button title="맨 위로">↑</button>', {}, 'probe', 'en'),
            /번들에 없는 한글 문자열/
        );
    });

    test('긴 번들 값이 짧은 하드코딩을 가리지 못한다 (0.6.26 마스킹 회귀 가드)', () => {
        // 0.6.26 탐지기는 "어떤 번들 값이 이 조각을 포함하면 통과"라는 양방향
        // 부분 일치를 썼다. 그 결과 하드코딩된 `Function ▶`이 번들의
        // `toggleFunctionColumn`(ko: `Function 열 표시 전환`)에 'Function'이
        // 들어 있다는 이유만으로 통과했다 — 이 탐지기가 잡으려던 대표 사례가
        // 필터에 걸려 있었다.
        //
        // **실제 번들**로 검사한다. 합성 번들로 대신하면 진짜 번들이 바뀌었을 때
        // 이 가드가 무의미해진다.
        const bundle = withLanguage('ko', () => buildMemoryMapStrings());
        assert.ok(
            Object.values(bundle).some(v => v.includes('Function')),
            '전제: ko 번들에 "Function"을 포함하는 값이 있어야 이 가드가 의미를 갖는다'
        );
        assert.throws(
            () => assertNoHardcodedStrings(
                '<button data-action="toggle-func-col">Function ▶</button>',
                bundle,
                'probe',
                'ko'
            ),
            /번들에 없는 영문 문자열/,
            '긴 번들 값에 포함된다는 이유로 하드코딩이 통과하면 안 된다'
        );
    });

    test('로케일 고정이 실제로 번들 값을 바꾼다 (탐지기 전제 검증)', () => {
        // 이 전제가 깨지면 두 로케일 실행이 같은 HTML을 두 번 검사하는 것에
        // 불과해진다 — 0.6.26이 `Function ▶`을 놓친 상태로 되돌아간다.
        const ko = withLanguage('ko', () => buildMemoryMapStrings());
        const en = withLanguage('en', () => buildMemoryMapStrings());
        assert.notDeepStrictEqual(ko, en, '로케일을 바꿔도 번들이 동일하다');
        assert.strictEqual(ko.colFunction, '함수');
        assert.strictEqual(en.colFunction, 'Function');
    });
});

