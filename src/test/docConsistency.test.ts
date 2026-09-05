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

function markdownDocFiles(): string[] {
    const roots = fs.readdirSync(REPO_ROOT)
        .filter(name => name.endsWith('.md'));
    const nested = ['docs', 'examples'].flatMap(dir =>
        fs.readdirSync(path.join(REPO_ROOT, dir))
            .filter(name => name.endsWith('.md'))
            .map(name => path.join(dir, name))
    );
    return [...roots, ...nested].sort();
}

/** Approximate GitHub's heading IDs while preserving Korean and other Unicode letters. */
function markdownHeadingIds(body: string): Set<string> {
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    for (const line of body.split('\n')) {
        const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (!match) { continue; }
        const base = match[1]
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/[`*~]/g, '')
            .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
            .toLocaleLowerCase('en-US')
            .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
            .replace(/\s/g, '-');
        const duplicateIndex = counts.get(base) ?? 0;
        counts.set(base, duplicateIndex + 1);
        ids.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
    }
    return ids;
}

function splitMarkdownTableRow(row: string): string[] {
    const cells: string[] = [];
    let cell = '';
    for (let i = 1; i < row.length - 1; i++) {
        const char = row[i];
        if (char === '|' && row[i - 1] !== '\\') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += char;
        }
    }
    cells.push(cell.trim());
    return cells;
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
    // 6. Task.type union (schema.ts) ↔ 단일 출처인 actions.md 선택표
    // =====================================================================
    suite('actions.md task type list ↔ schema.ts Task.type union', () => {
        test('every Task.type member appears in actions.md and architecture links there', () => {
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

            const actions = readRepoFile('docs/actions.md');
            const selectionTable = actions.match(/## 2\. 태스크 선택표[\s\S]*?(?=\n## 3\.)/);
            assert.ok(selectionTable, 'docs/actions.md에서 태스크 선택표를 찾지 못했다');
            const blockText = selectionTable![0];

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
                `schema.ts의 Task.type 중 docs/actions.md 선택표에 없는 타입:\n  ${missing.join('\n  ')}`
            );

            const arch = readRepoFile('docs/architecture.md');
            assert.match(
                arch,
                /actions\.md#2-태스크-선택표/,
                'architecture.md는 태스크 타입을 복제하지 말고 actions.md 선택표를 링크해야 한다'
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
        test('시나리오 ID 형식과 고유성을 지킨다', () => {
            const testDir = path.join(REPO_ROOT, 'src', 'test');
            const declared = new Map<string, string[]>();
            const malformed: string[] = [];
            for (const name of fs.readdirSync(testDir)) {
                if (!name.endsWith('.test.ts')) { continue; }
                if (name === 'docConsistency.test.ts') { continue; }
                const lines = fs.readFileSync(path.join(testDir, name), 'utf-8').split('\n');
                lines.forEach((line, index) => {
                    for (const match of line.matchAll(/test\(\s*[`'"](IT-[^:`'"]+)/g)) {
                        const id = match[1];
                        const location = `${name}:${index + 1}`;
                        if (!/^IT-\d{3}[a-z]?$/.test(id)) {
                            malformed.push(`${id} (${location})`);
                            continue;
                        }
                        const locations = declared.get(id) ?? [];
                        locations.push(location);
                        declared.set(id, locations);
                    }
                });
            }

            const duplicates = Array.from(declared)
                .filter(([, locations]) => locations.length > 1)
                .map(([id, locations]) => `${id}: ${locations.join(', ')}`);
            assert.deepStrictEqual(malformed, [], `형식이 IT-XXX가 아닌 시나리오 ID:\n  ${malformed.join('\n  ')}`);
            assert.deepStrictEqual(duplicates, [], `중복된 시나리오 ID:\n  ${duplicates.join('\n  ')}`);
        });

        test('대장 표의 시나리오 ID가 중복되지 않는다', () => {
            const seen = new Map<string, number[]>();
            readRepoFile('docs/integration-tests.md').split('\n').forEach((line, index) => {
                if (!/^\|\s*IT-/.test(line)) { return; }
                const firstCell = line.split('|')[1];
                for (const id of firstCell.match(/IT-\d{3}[a-z]*/g) ?? []) {
                    const lines = seen.get(id) ?? [];
                    lines.push(index + 1);
                    seen.set(id, lines);
                }
            });
            const duplicates = Array.from(seen)
                .filter(([, lines]) => lines.length > 1)
                .map(([id, lines]) => `${id}: ${lines.join(', ')}`);
            assert.deepStrictEqual(duplicates, [], `대장 표에 중복된 시나리오 ID:\n  ${duplicates.join('\n  ')}`);
        });

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

    // =====================================================================
    // 10. 저장소 내 Markdown 링크와 heading anchor
    // =====================================================================
    suite('Markdown local links and anchors', () => {
        test('heading의 식별자 내부 밑줄은 유지하고 강조 구분자만 제거한다', () => {
            assert.deepStrictEqual([...markdownHeadingIds([
                '### 15.4. 커스텀 타입 설정 (taskhub_types.json)',
                '## _강조_ 및 **제목**',
                '## `some_type` 설정',
            ].join('\n'))], ['154-커스텀-타입-설정-taskhub_typesjson', '강조-및-제목', 'some_type-설정']);
        });

        test('모든 로컬 Markdown 링크의 파일과 heading이 존재한다', () => {
            const files = markdownDocFiles();
            const headingCache = new Map<string, Set<string>>();
            const violations: string[] = [];
            const linkRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

            for (const doc of files) {
                const body = readRepoFile(doc);
                for (const match of body.matchAll(linkRe)) {
                    const rawTarget = match[1].replace(/^<|>$/g, '');
                    if (/^(?:https?:|mailto:|command:)/i.test(rawTarget)) { continue; }

                    const hashAt = rawTarget.indexOf('#');
                    const rawPath = hashAt === -1 ? rawTarget : rawTarget.slice(0, hashAt);
                    const rawAnchor = hashAt === -1 ? '' : rawTarget.slice(hashAt + 1);
                    let targetPath: string;
                    let anchor: string;
                    try {
                        targetPath = decodeURIComponent(rawPath);
                        anchor = decodeURIComponent(rawAnchor);
                    } catch {
                        violations.push(`${doc} — URI decode 실패: ${rawTarget}`);
                        continue;
                    }

                    const resolved = rawPath
                        ? path.resolve(REPO_ROOT, path.dirname(doc), targetPath)
                        : path.resolve(REPO_ROOT, doc);
                    if (!fs.existsSync(resolved)) {
                        violations.push(`${doc} — 파일 없음: ${rawTarget}`);
                        continue;
                    }
                    if (!anchor) { continue; }
                    const lineAnchor = /^L(\d+)(?:-L(\d+))?$/.exec(anchor);
                    if (lineAnchor) {
                        const lineCount = fs.readFileSync(resolved, 'utf-8').split('\n').length;
                        const start = Number(lineAnchor[1]);
                        const end = Number(lineAnchor[2] ?? lineAnchor[1]);
                        if (start < 1 || end < start || end > lineCount) {
                            violations.push(`${doc} — line anchor 범위 오류: ${rawTarget}`);
                        }
                        continue;
                    }
                    if (!fs.statSync(resolved).isFile() || path.extname(resolved).toLowerCase() !== '.md') {
                        violations.push(`${doc} — Markdown가 아닌 대상의 anchor: ${rawTarget}`);
                        continue;
                    }

                    let ids = headingCache.get(resolved);
                    if (!ids) {
                        ids = markdownHeadingIds(fs.readFileSync(resolved, 'utf-8'));
                        headingCache.set(resolved, ids);
                    }
                    if (!ids.has(anchor)) {
                        violations.push(`${doc} — heading 없음: ${rawTarget}`);
                    }
                }
            }

            assert.deepStrictEqual(
                violations,
                [],
                `깨진 로컬 Markdown 링크:\n  ${violations.join('\n  ')}`
            );
        });
    });

    // =====================================================================
    // 11. 설정 표 기본값·범위 ↔ package.json
    // =====================================================================
    suite('settings defaults and ranges ↔ features.md §21 table', () => {
        test('문서의 기본값과 수치 범위가 manifest와 일치한다', () => {
            const pkg = JSON.parse(readRepoFile('package.json'));
            const properties = pkg?.contributes?.configuration?.properties as Record<string, {
                type: string;
                default: unknown;
                enum?: unknown[];
                minimum?: number;
                maximum?: number;
            }>;
            const rows = new Map<string, string[]>();
            for (const line of readRepoFile('docs/features.md').split('\n')) {
                if (!/^\|\s*`taskhub\./.test(line)) { continue; }
                const cells = splitMarkdownTableRow(line);
                rows.set(cells[0].replace(/`/g, ''), cells);
            }

            const violations: string[] = [];
            for (const [key, definition] of Object.entries(properties)) {
                const cells = rows.get(key);
                if (!cells) { continue; } // Key presence is covered by suite 1.
                const documentedType = cells[1].replace(/`|\\/g, '');
                const documentedDefault = cells[2].replace(/`/g, '');
                const expectedDefault = typeof definition.default === 'string' || Array.isArray(definition.default)
                    ? JSON.stringify(definition.default)
                    : String(definition.default);

                if (definition.enum) {
                    for (const member of definition.enum) {
                        if (!documentedType.includes(JSON.stringify(member))) {
                            violations.push(`${key}: enum ${JSON.stringify(member)} 누락`);
                        }
                    }
                } else if (documentedType !== definition.type) {
                    violations.push(`${key}: 타입 ${documentedType}, manifest ${definition.type}`);
                }
                if (!documentedDefault.startsWith(expectedDefault)) {
                    violations.push(`${key}: 기본값 ${documentedDefault}, manifest ${expectedDefault}`);
                }
                if (definition.minimum !== undefined || definition.maximum !== undefined) {
                    const expectedRange = `${definition.minimum}–${definition.maximum}`;
                    if (!documentedDefault.includes(expectedRange)) {
                        violations.push(`${key}: 범위 ${documentedDefault}, manifest ${expectedRange}`);
                    }
                }
            }

            assert.deepStrictEqual(
                violations,
                [],
                `features.md §21 설정 값 drift:\n  ${violations.join('\n  ')}`
            );
        });
    });
});
