import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Doc-consistency test suite — catches drift between documentation and code
 * that human review kept missing (설정이 README/features/package.json 중 한 곳
 *에만 반영되거나, `commandPalette: false`로 숨긴 명령이 "Command Palette로
 * 실행하세요"로 문서화되거나, examples/README 의 §N.M 참조가 features.md 에
 * 없는 섹션을 가리키는 등).
 *
 * 이 테스트는 vscode API 없이 pure Node file IO 로 동작하므로 빠르고
 * CI 환경에 의존성이 없다. 문서 구조가 바뀌면 여기의 정적 regex 도 함께
 * 갱신해야 한다 (CONTRIBUTING.md 의 "변경 유형별 체크리스트" 참조).
 */

// Tests compile to out/test/*.test.js, so the repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readRepoFile(relPath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

suite('Documentation Consistency', () => {

    // =====================================================================
    // 1. package.json contributes.configuration ↔ features.md §21 정합성
    // =====================================================================
    suite('settings ↔ features.md §21 table', () => {
        let packageSettingKeys: string[];
        let docSettingKeys: string[];

        suiteSetup(() => {
            const pkg = JSON.parse(readRepoFile('package.json'));
            const props = pkg?.contributes?.configuration?.properties;
            assert.ok(props && typeof props === 'object', 'package.json must expose contributes.configuration.properties');
            packageSettingKeys = Object.keys(props)
                .filter(k => k.startsWith('taskhub.'))
                .sort();

            const features = readRepoFile('docs/features.md');
            // Extract the §21.1 전체 설정 표 region.
            const tableStart = features.indexOf('### 21.1. 전체 설정 표');
            assert.ok(tableStart !== -1, 'features.md must contain "### 21.1. 전체 설정 표"');
            const tableEnd = features.indexOf('### 21.2.', tableStart);
            assert.ok(tableEnd !== -1, 'features.md must contain "### 21.2." after the table');
            const tableRegion = features.slice(tableStart, tableEnd);

            // Rows look like:  | `taskhub.xxx.yyy` | ... |
            const rowKeyRe = /^\|\s*`(taskhub\.[A-Za-z0-9_.]+)`/gm;
            const found = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = rowKeyRe.exec(tableRegion)) !== null) {
                found.add(m[1]);
            }
            docSettingKeys = Array.from(found).sort();
        });

        test('every package.json setting key is documented in features.md §21', () => {
            const missing = packageSettingKeys.filter(k => !docSettingKeys.includes(k));
            assert.deepStrictEqual(
                missing,
                [],
                `Settings defined in package.json but missing from features.md §21.1:\n  ${missing.join('\n  ')}`
            );
        });

        test('every features.md §21 row corresponds to a real package.json setting', () => {
            const stale = docSettingKeys.filter(k => !packageSettingKeys.includes(k));
            assert.deepStrictEqual(
                stale,
                [],
                `features.md §21.1 lists setting keys that do not exist in package.json:\n  ${stale.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 2. commandPalette `when: false` 로 숨긴 명령은 features.md 에서
    //    "Command Palette / 명령 팔레트에서 실행" 식으로 안내되지 않아야 함
    // =====================================================================
    suite('hidden palette commands are not documented as palette-invokable', () => {
        test('no doc says "Command Palette" next to a hidden command title', () => {
            const pkg = JSON.parse(readRepoFile('package.json'));
            const commands = (pkg?.contributes?.commands ?? []) as Array<{ command: string; title: string }>;
            const paletteMenu = (pkg?.contributes?.menus?.commandPalette ?? []) as Array<{ command: string; when?: string }>;
            const hiddenIds = new Set(
                paletteMenu.filter(e => e && e.when === 'false').map(e => e.command)
            );
            const hiddenTitles = commands
                .filter(c => hiddenIds.has(c.command))
                .map(c => c.title);

            assert.ok(hiddenTitles.length > 0, 'expected some commands hidden via menus.commandPalette: when:false');

            const docsToCheck = ['docs/features.md', 'examples/README.md'];
            const violations: string[] = [];
            const palettePhrases = ['Command Palette', '명령 팔레트'];

            for (const doc of docsToCheck) {
                const lines = readRepoFile(doc).split('\n');
                lines.forEach((line, idx) => {
                    // Skip explicit negations like "컨텍스트 전용 명령이며 Command Palette에는 노출되지 않습니다."
                    if (/(노출되지\s*않|not\s+exposed|hidden\s+from)/i.test(line)) {
                        return;
                    }
                    for (const title of hiddenTitles) {
                        const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        // Require a non-word boundary after the title so that a hidden
                        // title like "Export Action" does NOT match a different visible
                        // command "Export Actions" (plural, palette-exposed).
                        const titlePattern = new RegExp(`TaskHub:\\s*${escaped}(?![A-Za-z0-9])`);
                        const backtickPattern = new RegExp(`\`${escaped}\``);
                        const titleHit = titlePattern.test(line) || backtickPattern.test(line);
                        if (!titleHit) { continue; }
                        for (const phrase of palettePhrases) {
                            if (line.includes(phrase)) {
                                violations.push(`${doc}:${idx + 1} — hidden command "${title}" appears alongside "${phrase}"`);
                            }
                        }
                    }
                });
            }

            assert.deepStrictEqual(
                violations,
                [],
                `Commands hidden via menus.commandPalette (when:false) must not be documented as palette-invokable:\n  ${violations.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 3. examples/README.md 의 features.md §번호 참조가 실제로 존재하는지
    // =====================================================================
    suite('examples/README.md features.md §N.M references resolve', () => {
        test('every features.md §N(.M) reference in examples/README.md matches a real heading', () => {
            const features = readRepoFile('docs/features.md');
            const examples = readRepoFile('examples/README.md');

            // Build the set of valid headings from features.md.
            // Top-level:   `## 15. ...`   → key "15"
            // Sub-level:   `### 15.1. ...` → key "15.1"
            const validTopLevel = new Set<string>();
            const validSubLevel = new Set<string>();
            for (const line of features.split('\n')) {
                const top = /^##\s+(\d+)\.\s/.exec(line);
                if (top) {
                    validTopLevel.add(top[1]);
                }
                const sub = /^###\s+(\d+\.\d+)\.\s/.exec(line);
                if (sub) {
                    validSubLevel.add(sub[1]);
                }
            }

            // References in examples/README.md look like:
            //   features.md §15.1
            //   features.md §19
            const refRe = /features\.md\s*§\s*(\d+)(?:\.(\d+))?/g;
            const unresolved: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = refRe.exec(examples)) !== null) {
                const section = m[1];
                const sub = m[2];
                if (sub === undefined) {
                    if (!validTopLevel.has(section)) {
                        unresolved.push(`§${section}`);
                    }
                } else {
                    const key = `${section}.${sub}`;
                    if (!validSubLevel.has(key)) {
                        unresolved.push(`§${key}`);
                    }
                }
            }

            assert.deepStrictEqual(
                Array.from(new Set(unresolved)).sort(),
                [],
                `examples/README.md references features.md sections that don't exist:\n  ${unresolved.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 4. README 테이블이 여전히 포인터 상태인지 (전체 설정 표 재등장 금지)
    // =====================================================================
    suite('README does not re-embed the full settings table', () => {
        test('README.md / README.en.md do not list more than two setting keys in table rows', () => {
            // 설정 레퍼런스는 features.md §21 단일 출처. README 가 예전처럼 10 행
            // 표를 다시 끌어오면 drift 가 재발한다. 일반적인 언급(포인터 텍스트 안의
            // 1-2 개 key 는 허용)과 표 복구를 구분하기 위해 `| \`taskhub....\` |`
            // 형태의 표 행 발생 횟수를 세서 상한을 둔다.
            const rowRe = /^\|\s*`taskhub\.[^`]+`/gm;
            for (const doc of ['README.md', 'README.en.md']) {
                const body = readRepoFile(doc);
                const rowCount = (body.match(rowRe) ?? []).length;
                assert.ok(
                    rowCount <= 2,
                    `${doc} appears to re-introduce the full settings table (${rowCount} setting rows found). ` +
                    'Keep README as a pointer to features.md §21.'
                );
            }
        });
    });
});
