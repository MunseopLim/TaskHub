import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

suite('릴리스 버전 검사 CLI', function () {
    this.timeout(30_000);
    const checker = path.resolve(__dirname, '..', '..', 'scripts', 'check-release-version.cjs');
    let tempDir: string;
    let repository: string;
    let environment: NodeJS.ProcessEnv;

    function git(...args: string[]): string {
        return execFileSync('git', args, { cwd: repository, env: environment, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    }

    function write(name: string, content: string): void {
        const target = path.join(repository, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }

    function writeJson(name: string, content: unknown): void {
        write(name, JSON.stringify(content, null, 2) + '\n');
    }

    function changeJson(name: string, change: (content: any) => void): void {
        const content = JSON.parse(fs.readFileSync(path.join(repository, name), 'utf8'));
        change(content);
        writeJson(name, content);
    }

    function bump(version = '1.2.4'): void {
        changeJson('package.json', content => { content.version = version; });
        changeJson('package-lock.json', content => {
            content.version = version;
            content.packages[''].version = version;
        });
        write('CHANGELOG.md', `# Change Log\n\n<!--\n## [9.9.9] - 형식 예시\n-->\n\n## [${version}] - 2026-09-15\n\n수정 내용\n`);
    }

    function commit(): void {
        git('add', '--all');
        git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    }

    function check(expected: number, base?: string): string {
        const result = spawnSync(process.execPath, [checker], {
            cwd: repository,
            env: { ...environment, ...(base === undefined ? {} : { TASKHUB_VERSION_BASE: base }), ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 15_000,
        });
        const output = result.stdout + result.stderr;
        assert.ifError(result.error);
        assert.strictEqual(result.status, expected, output);
        return output;
    }

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-release-version-'));
        repository = path.join(tempDir, 'repository with spaces 한글');
        fs.mkdirSync(repository);
        // Git for Windows는 os.devNull의 장치 경로를 config 파일로 열지 못한다.
        // 실제 빈 파일로 사용자 설정을 격리하고 임시 저장소와 함께 정리한다.
        const globalConfig = path.join(tempDir, 'empty-gitconfig');
        fs.writeFileSync(globalConfig, '');
        environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
        for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'TASKHUB_VERSION_BASE']) {
            delete environment[key];
        }
        git('init', '--quiet');
        git('config', 'user.name', 'Release fixture');
        git('config', 'user.email', 'release-fixture@example.invalid');
        writeJson('package.json', {
            name: 'fixture', version: '1.2.3', main: './dist/extension.js',
            engines: { vscode: '^1.75.0' }, scripts: { test: 'node test.js' },
            dependencies: { library: '1.0.0' }, devDependencies: { tool: '1.0.0' },
        });
        writeJson('package-lock.json', {
            name: 'fixture', version: '1.2.3', lockfileVersion: 3,
            packages: {
                '': { name: 'fixture', version: '1.2.3', dependencies: { library: '1.0.0' }, devDependencies: { tool: '1.0.0' } },
                'node_modules/library': { version: '1.0.0', resolved: 'https://example.invalid/library-1.tgz', integrity: 'sha512-a' },
                'node_modules/tool': { version: '1.0.0', dev: true },
            },
        });
        write('CHANGELOG.md', '# Change Log\n\n## [1.2.3] - 2026-09-15\n');
        write('src/extension.ts', 'export const enabled = true;\n');
        write('src/test/example.test.ts', 'test fixture\n');
        write('.gitignore', 'ignored/\n');
        commit();
    });

    teardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    test('현재 저장소와 npm test/package의 필수 검사 연결을 검증한다', () => {
        const root = path.resolve(__dirname, '..', '..');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.strictEqual(manifest.scripts['check-version'], 'node scripts/check-release-version.cjs');
        for (const script of ['pretest', 'package']) {
            assert.match(manifest.scripts[script], /^npm run check-version\s*&&/, `${script}는 버전 검사를 먼저 실행해야 한다`);
        }
        const result = spawnSync(process.execPath, [checker], {
            cwd: root,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 15_000,
        });
        assert.ifError(result.error);
        assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    });

    test('실행 코드 변경과 네 위치 버전 증가를 함께 검사한다', () => {
        write('src/extension.ts', 'export const enabled = false;\n');
        assert.match(check(1), /버전이 증가하지 않았습니다/);
        bump();
        assert.match(check(0), /1\.2\.4.*기준 HEAD: 1\.2\.3/);
    });

    for (const target of ['package.json', 'lockTop', 'lockRoot', 'CHANGELOG.md']) {
        test(`버전 불일치를 거부한다: ${target}`, () => {
            if (target === 'package.json') {
                changeJson(target, value => { value.version = '1.2.4'; });
            } else if (target === 'lockTop' || target === 'lockRoot') {
                changeJson('package-lock.json', value => {
                    if (target === 'lockTop') { value.version = '1.2.4'; }
                    else { value.packages[''].version = '1.2.4'; }
                });
            } else {
                write(target, '## [1.2.4] - 2026-09-15\n');
            }
            assert.match(check(1), /버전이 일치하지 않습니다/);
        });
    }

    test('문서·테스트·지침·CI·검증 스크립트만 변경하면 버전을 유지한다', () => {
        for (const file of ['docs/features.md', 'docs/images/screenshot.webp', 'README.md', 'AGENTS.md', 'CLAUDE.md', '.github/workflows/ci.yml', 'src/test/example.test.ts', 'scripts/check-release-version.cjs', 'scripts/test_encoding.py']) {
            write(file, 'development change\n');
        }
        assert.match(check(0), /개발\/문서 변경만 있음/);
    });

    test('manifest 개발 메타와 dev-only lock 변경은 버전 증가를 요구하지 않는다', () => {
        changeJson('package.json', value => {
            value.scripts.test = 'node other-test.js';
            value.scripts.lint = 'eslint src';
            value.scripts['check-version'] = 'node scripts/check-release-version.cjs';
            value.devDependencies.tool = '2.0.0';
            value.packageManager = 'npm@11.0.0';
        });
        changeJson('package-lock.json', value => {
            value.packages[''].devDependencies.tool = '2.0.0';
            value.packages['node_modules/tool'].version = '2.0.0';
            value.packages['node_modules/new-dev-tool'] = { version: '1.0.0', dev: true };
        });
        check(0);
    });

    for (const script of ['compile', 'package', 'vscode:prepublish', 'build', 'prepare', 'prepackage', 'build:webview', 'prevscode:prepublish', 'postvscode:prepublish', 'vscode:prepublish:assets']) {
        test(`빌드·패키징 script ${script} 변경은 버전 증가가 필요하다`, () => {
            changeJson('package.json', value => { value.scripts[script] = 'node build.js'; });
            assert.match(check(1), /실행\/배포 필드/);
        });
    }

    for (const field of ['main', 'engines', 'activationEvents', 'contributes', 'dependencies', 'overrides']) {
        test(`manifest ${field}만 바뀌어도 버전 증가가 필요하다`, () => {
            changeJson('package.json', value => {
                value[field] = field === 'main' ? './dist/new.js' : { changed: 'value' };
            });
            assert.match(check(1), /package\.json \(실행\/배포 필드\)/);
        });
    }

    test('lock의 transitive runtime 변경을 dev 도구 변경과 구분한다', () => {
        changeJson('package-lock.json', value => {
            value.packages['node_modules/library'].integrity = 'sha512-changed';
        });
        assert.match(check(1), /런타임 의존성/);
    });

    test('dev 패키지가 runtime으로 전환되면 버전 증가가 필요하다', () => {
        changeJson('package-lock.json', value => { delete value.packages['node_modules/tool'].dev; });
        assert.match(check(1), /런타임 의존성/);
    });

    for (const file of ['src/new file 한글.ts', 'src/line\nbreak.ts', 'media/icon.svg', 'schema/actions.schema.json', 'package.nls.json', '.vscodeignore', 'esbuild.js', 'tsconfig.json', 'scripts/build.cjs', 'scripts/check-build.cjs']) {
        test(`untracked 실행·배포 파일 추가를 검사한다: ${JSON.stringify(file)}`, function () {
            // Windows 파일명에는 개행을 사용할 수 없다. 공백/한글은 모든 OS에서 검사한다.
            if (process.platform === 'win32' && file.includes('\n')) { this.skip(); }
            write(file, 'new runtime content\n');
            assert.match(check(1), /버전이 증가하지 않았습니다/);
        });
    }

    test('삭제와 runtime→test 및 test→runtime 이동을 모두 검사한다', () => {
        fs.unlinkSync(path.join(repository, 'src/extension.ts'));
        assert.match(check(1), /src\/extension\.ts/);
        git('restore', '--worktree', '.');
        git('mv', 'src/extension.ts', 'src/test/moved.ts');
        assert.match(check(1), /src\/extension\.ts/);
        git('reset', '--hard', 'HEAD');
        git('mv', 'src/test/example.test.ts', 'src/new-runtime.ts');
        assert.match(check(1), /src\/new-runtime\.ts/);
    });

    test('stage한 실행 변경을 작업파일에서 상쇄해도 검사한다', () => {
        write('src/extension.ts', 'export const enabled = false;\n');
        git('add', 'src/extension.ts');
        write('src/extension.ts', 'export const enabled = true;\n');
        assert.match(check(1), /버전이 증가하지 않았습니다/);
    });

    test('stage한 manifest 실행 변경을 작업파일에서 상쇄해도 검사한다', () => {
        const original = fs.readFileSync(path.join(repository, 'package.json'), 'utf8');
        changeJson('package.json', value => { value.main = './dist/new.js'; });
        git('add', 'package.json');
        write('package.json', original);
        assert.match(check(1), /실행\/배포 필드/);
    });

    test('clean CI에서는 HEAD 부모와 비교하여 누락된 bump를 거부한다', () => {
        write('src/extension.ts', 'export const enabled = false;\n');
        commit();
        assert.match(check(1), /HEAD\^: 1\.2\.3/);
        bump();
        commit();
        assert.match(check(0), /기준 HEAD\^: 1\.2\.3/);
    });

    test('clean 문서-only commit은 같은 버전으로 통과한다', () => {
        write('docs/features.md', 'documentation\n');
        commit();
        check(0);
    });

    test('명시적 base는 clean 마지막 문서 commit을 넘어 전체 변경을 검사한다', () => {
        const base = git('rev-parse', 'HEAD').trim();
        write('src/extension.ts', 'export const enabled = false;\n');
        commit();
        write('README.md', 'documentation\n');
        commit();
        check(0);
        assert.match(check(1, base), /버전이 증가하지 않았습니다/);
        bump();
        check(0, base);
    });

    test('명시한 기준이 없으면 fallback 없이 실패한다', () => {
        write('README.md', 'documentation\n');
        assert.match(check(1, 'missing-ref'), /비교 기준 missing-ref.*읽을 수 없습니다/);
        assert.match(check(1, '--help'), /비교 기준 --help.*읽을 수 없습니다/);
    });

    test('clean shallow clone에 부모가 없으면 검사를 생략하지 않는다', () => {
        write('README.md', 'documentation\n');
        commit();
        const clone = path.join(tempDir, 'shallow');
        git('clone', '--quiet', '--depth=1', '--no-local', repository, clone);
        repository = clone;
        assert.match(check(1), /TASKHUB_VERSION_BASE.*shallow/);
    });

    test('숫자 SemVer 순서로 비교하며 감소와 build metadata-only 증가를 거부한다', () => {
        write('src/extension.ts', 'runtime change\n');
        bump('1.2.2');
        check(1);
        bump('1.2.3+build.1');
        check(1);
        bump('1.10.0');
        check(0);
    });

    test('오래된 lock 형식이나 누락된 changelog 버전을 조용히 면제하지 않는다', () => {
        changeJson('package-lock.json', value => { value.lockfileVersion = 1; });
        assert.match(check(1), /lockfileVersion 2 또는 3/);
        changeJson('package-lock.json', value => { value.lockfileVersion = 3; });
        write('CHANGELOG.md', '# Change Log\n');
        assert.match(check(1), /CHANGELOG\.md 최상단.*SemVer/);
    });
});
