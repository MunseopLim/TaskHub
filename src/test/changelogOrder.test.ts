import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CHANGELOG 릴리스 순서 (0.6.36).
 *
 * Marketplace 의 Changelog 탭은 파일을 위에서부터 그대로 보여준다. 최신
 * 릴리스가 첫 항목이 아니면 사용자가 제일 먼저 보는 것이 옛 버전이 된다.
 *
 * 실제로 0.6.28 작업에서 새 헤더를 0.6.27 **아래**에 끼워 넣는 실수를 했고,
 * 이후 0.6.29~0.6.35 가 전부 그 블록 안에 쌓여 0.6.27 이 맨 위에 남아 있었다.
 * 사람 눈에는 잘 안 띄는 종류라(각 블록은 정상이고 순서만 어긋난다) 검사로
 * 고정한다.
 */
suite('CHANGELOG 릴리스 순서', () => {

    const REPO_ROOT = path.resolve(__dirname, '..', '..');
    const text = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');

    /** `## [x.y.z]` 헤더의 버전을 파일에 나온 순서대로. */
    function releaseVersions(): string[] {
        return Array.from(text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)).map(m => m[1]);
    }

    function compare(a: string, b: string): number {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if (pa[i] !== pb[i]) { return pa[i] - pb[i]; }
        }
        return 0;
    }

    test('버전 헤더를 하나 이상 찾는다 (정규식이 무력화되지 않았는지)', () => {
        assert.ok(releaseVersions().length > 10, '헤더를 못 찾으면 아래 검사가 의미 없이 통과한다');
    });

    test('내림차순이다 — 최신이 맨 위', () => {
        const versions = releaseVersions();
        for (let i = 1; i < versions.length; i++) {
            assert.ok(
                compare(versions[i - 1], versions[i]) > 0,
                `${versions[i - 1]} 다음에 ${versions[i]} 가 온다 (index ${i}). ` +
                'Marketplace 는 파일 순서대로 보여주므로 최신이 맨 위여야 한다.'
            );
        }
    });

    test('중복된 버전 헤더가 없다', () => {
        const versions = releaseVersions();
        const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
        assert.deepStrictEqual(Array.from(new Set(dupes)), []);
    });

    test('package.json 의 현재 버전이 최상단 릴리스와 같다', () => {
        // 버전만 올리고 CHANGELOG 블록을 빠뜨리는(혹은 그 반대) 실수를 막는다.
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
        assert.strictEqual(releaseVersions()[0], pkg.version);
    });
});
