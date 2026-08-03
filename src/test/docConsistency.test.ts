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

    // =====================================================================
    // 5. architecture.md 에 개별 설정 키가 '나열' 수준으로 재출현하지 않는지
    //    (설정 단일 출처는 features.md §21. architecture.md 는 포인터만 유지)
    // =====================================================================
    suite('architecture.md does not re-embed the taskhub.* settings list', () => {
        test('architecture.md references at most 3 real configuration keys (illustrative mentions only)', () => {
            // 과거 drift 패턴: "configuration: VS Code 설정" 블록에 history 설정만
            // 2개 나열 → 새 설정이 추가될 때 여기가 drift. 이 테스트는 실제
            // package.json 에 정의된 configuration key 만을 대상으로 (workspaceState
            // key 같은 `taskhub.actionHistory` 는 제외) 개수를 세고, 3건까지만 허용.
            // 4건 이상이면 누군가 "나열 섹션"을 다시 만들고 있다는 신호.
            const pkg = JSON.parse(readRepoFile('package.json'));
            const realConfigKeys = new Set<string>(
                Object.keys(pkg?.contributes?.configuration?.properties ?? {})
                    .filter(k => k.startsWith('taskhub.'))
            );

            const body = readRepoFile('docs/architecture.md');
            const keyRe = /`(taskhub\.[A-Za-z0-9_.]+)`/g;
            const hits = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = keyRe.exec(body)) !== null) {
                if (realConfigKeys.has(m[1])) {
                    hits.add(m[1]);
                }
            }

            const matches = Array.from(hits).sort();
            assert.ok(
                matches.length <= 3,
                `docs/architecture.md references ${matches.length} real configuration keys ` +
                `(${matches.join(', ')}); move the list to features.md §21 and keep only short illustrative references here.`
            );
        });
    });

    // =====================================================================
    // 6. Task.type union (schema.ts) ↔ architecture.md 에 나열된 지원 태스크
    //    타입 목록이 일치하는지 (`writeFile`/`appendFile` 누락 재발 방어)
    // =====================================================================
    suite('architecture.md task type list ↔ schema.ts Task.type union', () => {
        test('every Task.type member appears in architecture.md supported task list', () => {
            const schema = readRepoFile('src/schema.ts');
            // Find the Task.type union line and extract each single-quoted member.
            const typeLineMatch = schema.match(/type:\s*(?:'[^']+'\s*\|\s*)+'[^']+'/);
            assert.ok(typeLineMatch, 'Could not find Task.type union in src/schema.ts');
            const memberRe = /'([A-Za-z]+)'/g;
            const members = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = memberRe.exec(typeLineMatch![0])) !== null) {
                members.add(m[1]);
            }
            assert.ok(members.size > 0, 'No Task.type members extracted');

            const arch = readRepoFile('docs/architecture.md');
            // Grab the "지원 태스크 타입" line(s) and the surrounding bullet, so
            // we match both backticked and plain list variants.
            const supportedBlock = arch.match(/지원 태스크 타입[\s\S]{0,400}/);
            assert.ok(supportedBlock, 'Could not locate "지원 태스크 타입" block in architecture.md');
            const blockText = supportedBlock![0];

            const missing: string[] = [];
            for (const type of members) {
                // Accept `shell`, 'shell', or bare `shell/command` notation.
                const found = blockText.includes('`' + type + '`')
                    || blockText.includes(`'${type}'`)
                    || new RegExp(`\\b${type}\\b`).test(blockText);
                if (!found) {
                    missing.push(type);
                }
            }

            assert.deepStrictEqual(
                missing,
                [],
                `Task.type members listed in schema.ts but missing from architecture.md "지원 태스크 타입" block:\n  ${missing.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 7. architecture.md 프로젝트 구조 트리 ↔ 실제 src/*.ts
    //
    // CONTRIBUTING.md 의 체크리스트가 "`src/` 파일 추가 → architecture.md 트리"
    // 를 요구하는데, 자동 검사가 없어 `dialogMemory.ts` 가 0.6.11 부터
    // 0.6.49 까지 누락돼 있었다. 사람 눈에만 맡긴 범주만 실제로 어긋났다.
    // =====================================================================
    suite('architecture.md 구조 트리 ↔ src/*.ts', () => {
        test('모든 src 모듈이 프로젝트 구조 트리에 있다', () => {
            const doc = readRepoFile('docs/architecture.md');
            const files: string[] = [];
            for (const dir of ['src', path.join('src', 'providers')]) {
                for (const name of fs.readdirSync(path.join(REPO_ROOT, dir))) {
                    if (name.endsWith('.ts')) { files.push(name); }
                }
            }

            assert.ok(files.length > 10, `src 모듈을 찾지 못했다 — 검사 전제가 깨졌다 (${files.length})`);
            const missing = files.filter(name => !doc.includes(name));
            assert.deepStrictEqual(
                missing,
                [],
                `src 에는 있는데 architecture.md 구조 트리에 없는 모듈:\n  ${missing.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 8. docs/integration-tests.md 대장 ↔ 실제 `test('IT-XXX` 제목
    //
    // 그 문서 스스로 "새 suite 를 만들 때 이 문서에 항목을 추가한다" 고
    // 규정하는데 검사가 없어, IT 35 건과 suite 3 개가 등재되지 않은 채
    // 쌓였다 (stopInteractive 의 중지·보안 검증 전체 포함).
    // =====================================================================
    suite('integration-tests.md 대장 ↔ IT- 테스트 제목', () => {
        test('모든 IT-XXX 테스트가 대장에 등재돼 있다', () => {
            const ledger = readRepoFile('docs/integration-tests.md');
            // **접미사(`IT-072b`)까지 포함해 센다.** 처음 구현은 `IT-\d+` 로만
            // 잡아 `IT-072b` 를 `IT-072` 로 뭉갰고, 그러면 접미사 시나리오가
            // 대장에 없어도 통과한다. `Map` 도 같은 id 를 덮어써 파일이 다른
            // 동명 시나리오를 하나로 합쳤다 — 둘 다 검사를 헐겁게 만든다.
            const documented = new Set(ledger.match(/IT-\d+[a-z]*/g) ?? []);
            const testDir = path.join(REPO_ROOT, 'src', 'test');
            const declared: { id: string; file: string }[] = [];
            const seen = new Set<string>();
            for (const name of fs.readdirSync(testDir)) {
                if (!name.endsWith('.test.ts')) { continue; }
                const source = fs.readFileSync(path.join(testDir, name), 'utf-8');
                for (const m of source.matchAll(/test\(\s*[\`'"](IT-\d+[a-z]*)/g)) {
                    const key = `${m[1]}\u0000${name}`;
                    if (seen.has(key)) { continue; }
                    seen.add(key);
                    declared.push({ id: m[1], file: name });
                }
            }

            assert.ok(declared.length > 50, `IT- 테스트를 찾지 못했다 — 검사 전제가 깨졌다 (${declared.length})`);
            const missing = declared
                .filter(({ id }) => !documented.has(id))
                .map(({ id, file }) => [id, file] as [string, string]);
            assert.deepStrictEqual(
                missing.map(([id, file]) => `${id} (${file})`),
                [],
                `테스트에는 있는데 docs/integration-tests.md 에 없는 시나리오:\n  `
                + missing.map(([id, file]) => `${id} (${file})`).join('\n  ')
            );
        });
    });

    // =====================================================================
    // 9. Doctor 진단 코드 ↔ features.md §Doctor 표
    //
    // 코드는 사용자가 Problems 패널에서 그대로 보는 식별자이고, 무엇을
    // 뜻하는지는 그 표에만 적혀 있다. 새 코드를 추가하면서 표를 잊으면
    // 사용자에게는 설명 없는 경고만 남는다 — 0.6.57 의 `args.array-joined`
    // 를 추가하면서 이 검사가 없다는 것을 알았다.
    // =====================================================================
    suite('Doctor 진단 코드 ↔ features.md', () => {
        test('doctor.ts 가 내는 모든 코드가 문서 표에 있다', () => {
            const source = readRepoFile('src/doctor.ts');
            const doc = readRepoFile('docs/features.md');
            // 템플릿 리터럴(`schema.${keyword}`)은 표에 `schema.*` 한 줄로
            // 대표되므로 고정 문자열만 센다.
            const emitted = new Set(Array.from(source.matchAll(/code:\s*'([a-z][a-z0-9.-]*)'/g)).map(m => m[1]));
            assert.ok(emitted.size > 5, `코드를 거의 못 찾았다 — 추출 규칙이 깨졌다: ${[...emitted].join(', ')}`);
            const missing = [...emitted].filter(code => !doc.includes(`\`${code}\``));
            assert.deepStrictEqual(missing, [],
                `features.md 의 Doctor 표에 없는 코드: ${missing.join(', ')}`);
        });
    });
});
