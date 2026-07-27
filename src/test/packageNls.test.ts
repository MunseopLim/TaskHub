import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * manifest 지역화 정합성 (0.6.27).
 *
 * `package.json`의 사용자에게 보이는 문자열은 `%key%` 자리표시자로 두고 실제
 * 문구는 `package.nls.json`(기본/영어) / `package.nls.ko.json`(한국어)에 둔다.
 * `t()`가 닿지 않는 유일한 표면이라 CLAUDE.md의 i18n 규칙이 여기까지 오지
 * 못하고 있었다 — 0.6.15가 추가한 `viewsWelcome` 본문이 대표 사례다.
 *
 * 이 방식의 조용한 실패 모드는 **키 누락**이다. ko 번들에 키가 없으면 VS Code는
 * 오류 없이 기본 번들로 폴백하므로, 한국어 사용자에게 영어가 섞여 보일 뿐
 * 아무 신호도 나지 않는다. 반대로 package.json에서 지운 키가 번들에 남으면
 * 죽은 문구가 쌓인다. 세 파일이 서로를 검증하게 한다.
 */
suite('manifest 지역화 (package.nls)', () => {

    const root = path.resolve(__dirname, '..', '..');
    const manifestText = fs.readFileSync(path.join(root, 'package.json'), 'utf-8');
    const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf-8'));
    const ko = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.ko.json'), 'utf-8'));

    /** 주석용 키는 번역 대상이 아니다. */
    const META_KEYS = new Set(['_comment']);

    function bundleKeys(bundle: Record<string, unknown>): string[] {
        return Object.keys(bundle).filter(k => !META_KEYS.has(k)).sort();
    }

    /** manifest가 실제로 참조하는 `%key%` 목록. */
    function referencedKeys(): string[] {
        const found = new Set<string>();
        for (const match of manifestText.matchAll(/"%([A-Za-z][\w.]*)%"/g)) {
            found.add(match[1]);
        }
        return Array.from(found).sort();
    }

    test('두 번들의 키 집합이 정확히 일치한다', () => {
        // 누락은 조용한 영어 폴백, 잉여는 죽은 문구다. 어느 쪽도 런타임에
        // 오류를 내지 않으므로 여기서만 잡을 수 있다.
        assert.deepStrictEqual(bundleKeys(ko), bundleKeys(en));
    });

    test('manifest가 참조하는 키가 모두 번들에 있다', () => {
        const missing = referencedKeys().filter(key => !(key in en));
        assert.deepStrictEqual(missing, [], `package.json이 참조하는 키가 번들에 없다: ${missing.join(', ')}`);
    });

    test('번들의 키가 모두 manifest에서 쓰인다', () => {
        const referenced = new Set(referencedKeys());
        const unused = bundleKeys(en).filter(key => !referenced.has(key));
        assert.deepStrictEqual(unused, [], `번들에만 있고 package.json이 쓰지 않는 키: ${unused.join(', ')}`);
    });

    test('두 번들의 값이 실제로 다르다 (자리표시자만 복사한 것이 아님)', () => {
        // ko 번들을 en에서 복사만 해 두고 번역을 잊는 실수를 막는다.
        // 브랜드명·기술 식별자처럼 양쪽이 같아야 하는 값은 아래 예외에 둔다.
        const SAME_BY_DESIGN = new Set<string>([]);
        const identical = bundleKeys(en)
            .filter(key => !SAME_BY_DESIGN.has(key))
            .filter(key => en[key] === ko[key]);
        assert.deepStrictEqual(
            identical,
            [],
            `한국어 번역이 영어와 동일하다 (번역 누락 의심). 의도한 것이면 SAME_BY_DESIGN에 근거와 함께 추가할 것: ${identical.join(', ')}`
        );
    });

    test('welcome 본문의 command 링크가 양쪽 번들에서 동일하다', () => {
        // 링크 문구는 번역하되 `command:` 대상은 번역하면 안 된다 — 바꾸면
        // 버튼이 아무 동작도 하지 않고, 그 실패는 화면상 아무 표시가 없다.
        for (const key of bundleKeys(en).filter(k => k.startsWith('welcome.'))) {
            const commandsOf = (text: string) =>
                Array.from(String(text).matchAll(/\(command:([\w.]+)\)/g)).map(m => m[1]).sort();
            assert.deepStrictEqual(
                commandsOf(ko[key]),
                commandsOf(en[key]),
                `${key}: command 링크 대상이 두 번들에서 다르다`
            );
        }
    });

    /**
     * 설정 설명이 실제 동작과 어긋나면 조용히 잘못된 기대를 만든다 (0.6.36).
     *
     * `rememberLastLocation` 설명은 0.6.11부터 "창과 확장이 공유하는 VS Code
     * 최근 경로를 쓴다"고 적혀 있었는데 사실이 아니다. VS Code 는 `defaultUri`
     * 가 없으면 자체 `defaultFilePath()` — 활성 편집기 파일 → 워크스페이스
     * 폴더 → 홈 — 로 채운다. 전역 최근 경로가 아니다.
     */
    suite('설정 설명과 실제 동작', () => {
        const key = 'setting.rememberLastLocation';

        test('전역 최근 경로를 쓴다고 주장하지 않는다', () => {
            for (const [lang, bundle] of [['en', en], ['ko', ko]] as const) {
                const text = String(bundle[key] ?? '');
                assert.ok(text.length > 0, `${lang}: 설명이 비어 있다`);
                assert.ok(
                    !/last-used path|최근 경로가 쓰입니다|공유하는 VS Code 자체의 최근 경로/.test(text),
                    `${lang}: VS Code 는 전역 최근 경로가 아니라 활성 편집기/워크스페이스 기준으로 위치를 정한다:\n${text}`
                );
            }
        });

        test('저장 대화상자의 파일명 소실을 설정 설명에서 알린다', () => {
            // 깊은 문서에만 적으면 설정 UI 에서 끄는 사용자는 알 수 없다.
            assert.ok(/save dialogs? then lose/i.test(String(en[key])), `en: ${en[key]}`);
            assert.ok(/제안 파일명도 함께 사라집니다/.test(String(ko[key])), `ko: ${ko[key]}`);
        });
    });

    test('참조된 command 링크가 실제로 등록된 명령이다', () => {
        const manifest = JSON.parse(manifestText);
        const declared = new Set<string>(manifest.contributes.commands.map((c: any) => c.command));
        // VS Code 내장 명령은 확장이 선언하지 않는다.
        const BUILT_IN = new Set(['vscode.openFolder']);
        for (const key of bundleKeys(en).filter(k => k.startsWith('welcome.'))) {
            for (const match of String(en[key]).matchAll(/\(command:([\w.]+)\)/g)) {
                const command = match[1];
                assert.ok(
                    declared.has(command) || BUILT_IN.has(command),
                    `${key}: '${command}'는 contributes.commands에 없다 — 빈 상태 버튼이 아무 동작도 하지 않는다`
                );
            }
        }
    });
});
