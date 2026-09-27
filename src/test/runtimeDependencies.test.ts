import * as assert from 'assert';
import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

/**
 * 제품 코드가 실행 시 불러오는 외부 패키지는 모두 `dependencies` 에 있어야 한다 (R07).
 *
 * esbuild 는 `devDependencies` 패키지도 번들에 넣는다. 그런 패키지는 CI 의
 * `npm audit --omit=dev` 에서 빠져, 배포 코드의 취약점을 감사가 놓친다.
 * 타입 전용 import(`import type`, `.d.ts`)는 번들에 남지 않으므로 제외한다.
 */
suite('운영 의존성 분류', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const builtins = new Set(builtinModules);
    const PACKAGE_NAME = /^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)(?:\/.*)?$/;

    function sourceFiles(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { return entry.name === 'test' ? [] : sourceFiles(full); }
            return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
        });
    }

    function runtimePackages(text: string): string[] {
        const specifiers: string[] = [];
        for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+(['"])([^'"]+)\1/gm)) { specifiers.push(match[2]); }
        for (const match of text.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm)) { specifiers.push(match[2]); }
        for (const match of text.matchAll(/\b(?:require|import)\(\s*(['"])([^'"]+)\1\s*\)/g)) { specifiers.push(match[2]); }
        return specifiers
            .filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('node:'))
            .map(specifier => PACKAGE_NAME.exec(specifier)?.[1])
            .filter((name): name is string => !!name && name !== 'vscode' && !builtins.has(name));
    }

    test('실행 코드가 불러오는 패키지는 모두 운영 의존성이다', () => {
        const used = new Map<string, string>();
        for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
            for (const name of runtimePackages(fs.readFileSync(file, 'utf8'))) {
                used.set(name, path.relative(repoRoot, file));
            }
        }
        assert.ok(used.has('yauzl'), `검사가 실제 import 를 찾지 못한다: ${[...used.keys()].join(', ')}`);
        const missing = [...used].filter(([name]) => !packageJson.dependencies?.[name]);
        assert.deepStrictEqual(missing, [], '번들에 들어가는 패키지가 dependencies 에 없다');
    });

    test('생성 검증기를 포함한 배포 번들의 패키지도 운영 의존성 감사에 포함된다', () => {
        const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
        const used = new Map<string, string>();
        for (const bundle of ['extension', 'features', 'actionsValidator', 'jsonEditorWebview', 'regexWorker']) {
            const metadata = JSON.parse(fs.readFileSync(path.join(repoRoot, 'out', 'build', `${bundle}.meta.json`), 'utf8'));
            for (const output of Object.values(metadata.outputs) as { inputs: Record<string, { bytesInOutput: number }> }[]) {
                for (const [input, contribution] of Object.entries(output.inputs)) {
                    if (contribution.bytesInOutput === 0) { continue; }
                    const match = /^(node_modules\/(?:.*\/node_modules\/)?((?:@[^/]+\/)?[^/]+))(?:\/|$)/.exec(input.replace(/\\/g, '/'));
                    if (match) { used.set(match[1], match[2]); }
                }
            }
        }
        assert.ok(used.has('node_modules/ajv'), '생성 검증기에 들어간 Ajv 런타임 도우미를 검사해야 한다');
        const missing = [...used].filter(([location, name]) => {
            const entry = lock.packages[location];
            return !entry || entry.dev === true
                || (packageJson.devDependencies?.[name] && !packageJson.dependencies?.[name]);
        });
        assert.deepStrictEqual(missing, [], '배포 번들의 패키지가 npm audit --omit=dev 범위에서 빠졌다');
    });
});
