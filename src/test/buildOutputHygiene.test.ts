import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 컴파일 산출물 위생 (0.6.38).
 *
 * `vscode-test` 는 `out/**\/*.test.js` 를 글롭으로 모아 실행한다. 그런데
 * `compile-tests` 가 `tsc -p . --outDir out` 만 돌려 **출력 디렉터리를 비우지
 * 않았다.** 그래서 소스에서 지워지거나 브랜치/stash 로 사라진 테스트의
 * 컴파일 결과가 `out/` 에 남아 계속 실행됐다.
 *
 * 이 세션에서만 두 번 물렸다.
 *
 *   1. 임시로 만든 스크래치 테스트의 소스를 지웠는데 `out/test/zzpeek.test.js`
 *      가 남아 그대로 돌았다 (리뷰에서 발견).
 *   2. 커밋을 나누려고 일부 파일을 stash 했더니, 아직 남아 있던 산출물이
 *      **이미 없는 소스의 테스트**를 실행해 4건이 실패했다. 원인을 찾기 전까지
 *      "수정이 잘못됐나" 를 의심하게 만든다.
 *
 * 조용히 잘못된 신호를 주는 종류라 — 통과도 실패도 실제 소스와 무관할 수
 * 있다 — 빌드 스크립트에 정리 단계를 넣고, 그 단계가 빠졌을 때 여기서 잡는다.
 */
suite('컴파일 산출물 위생', () => {

    const REPO_ROOT = path.resolve(__dirname, '..', '..');
    const OUT_TEST = path.resolve(__dirname);
    const SRC_TEST = path.join(REPO_ROOT, 'src', 'test');

    /** `out/test` 아래의 컴파일된 테스트 파일 (하위 디렉터리 포함). */
    function compiledTestFiles(dir: string = OUT_TEST, prefix = ''): string[] {
        const found: string[] = [];
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
            if (dirent.isDirectory()) {
                found.push(...compiledTestFiles(path.join(dir, dirent.name), rel));
            } else if (dirent.name.endsWith('.test.js')) {
                found.push(rel);
            }
        }
        return found;
    }

    test('전제: 컴파일된 테스트를 찾는다 (경로가 어긋나지 않았는지)', () => {
        assert.ok(
            compiledTestFiles().length > 10,
            '산출물을 못 찾으면 아래 검사가 의미 없이 통과한다'
        );
    });

    test('모든 컴파일 산출물에 대응하는 소스가 있다', () => {
        // 대응 소스가 없는 .js 는 지워진/stash 된 테스트의 잔재다. 그것이
        // 계속 실행되면 통과도 실패도 현재 소스와 무관해진다.
        const orphans = compiledTestFiles().filter(rel => {
            const source = path.join(SRC_TEST, rel.replace(/\.js$/, '.ts'));
            return !fs.existsSync(source);
        });
        assert.deepStrictEqual(
            orphans,
            [],
            'src/test 에 없는 컴파일 산출물이 실행되고 있다. ' +
            '`npm run compile-tests` 가 out/ 를 비우는지 확인할 것 (clean-tests 스크립트).'
        );
    });

    test('빌드 스크립트가 out/ 를 비우고 컴파일한다', () => {
        // 위 검사는 "지금 깨끗한가" 만 본다. 정리 단계 자체가 사라지면
        // 다음 사람이 같은 함정에 빠지므로 스크립트도 함께 고정한다.
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
        const compileTests = String(pkg.scripts?.['compile-tests'] ?? '');
        assert.ok(
            compileTests.includes('clean-tests'),
            `compile-tests 가 정리 단계를 거치지 않는다: ${compileTests}`
        );
        const cleanTests = String(pkg.scripts?.['clean-tests'] ?? '');
        assert.ok(
            cleanTests.includes('out') && /rmSync|rimraf|rm -rf/.test(cleanTests),
            `clean-tests 가 out/ 를 지우지 않는다: ${cleanTests}`
        );
    });
});
