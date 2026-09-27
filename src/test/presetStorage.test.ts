import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUNDLED_PRESET_FILES, MIGRATED_LEGACY_PRESETS_KEY, buildActionCommandId, discoverPresets, migrateLegacyExtensionPresets, personalPresetsDir, presetNameKey, presetSourceKey } from '../extension';

/** 개인 프리셋을 설치 경로가 아닌 사용자 저장소에 두는지 (R09). */
suite('개인 프리셋 저장소 이관', () => {
    let root: string;
    let extensionsRoot: string;
    let personalDir: string;

    setup(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-preset-storage-')));
        extensionsRoot = path.join(root, 'extensions');
        personalDir = personalPresetsDir(path.join(root, 'globalStorage'));
    });

    teardown(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function writePreset(installDir: string, file: string, content: string, mtime?: Date): string {
        const target = path.join(extensionsRoot, installDir, 'presets', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        if (mtime) { fs.utimesSync(target, mtime, mtime); }
        return target;
    }

    test('이관 후보가 없어도 하루 지난 전용 임시 파일만 정리한다', async () => {
        fs.mkdirSync(personalDir, { recursive: true });
        const old = path.join(personalDir, `.taskhub-migrate-${'a'.repeat(32)}.tmp`);
        const recent = path.join(personalDir, `.taskhub-migrate-${'b'.repeat(32)}.tmp`);
        const unrelated = path.join(personalDir, '.taskhub-migrate-user.tmp');
        const directory = path.join(personalDir, `.taskhub-migrate-${'c'.repeat(32)}.tmp`);
        const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        for (const file of [old, recent, unrelated]) { fs.writeFileSync(file, 'keep unless expired'); }
        fs.mkdirSync(directory);
        for (const file of [old, unrelated, directory]) { fs.utimesSync(file, yesterday, yesterday); }
        const link = path.join(personalDir, `.taskhub-migrate-${'d'.repeat(32)}.tmp`);
        if (process.platform !== 'win32') { fs.symlinkSync(unrelated, link); }

        const result = await migrateLegacyExtensionPresets(path.join(extensionsRoot, 'current'), 'Munseop.taskhub', personalDir);
        assert.deepStrictEqual(result, { copied: [], processedSources: [], failed: [] });
        assert.strictEqual(fs.existsSync(old), false);
        assert.strictEqual(fs.readFileSync(recent, 'utf8'), 'keep unless expired');
        assert.strictEqual(fs.readFileSync(unrelated, 'utf8'), 'keep unless expired');
        assert.ok(fs.statSync(directory).isDirectory());
        if (process.platform !== 'win32') { assert.ok(fs.lstatSync(link).isSymbolicLink()); }
    });

    test('임시 파일 정리 실패는 정상 이관을 막지 않고 다음 활성화에서 재시도한다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-cleanup.json', '["complete"]');
        fs.mkdirSync(personalDir, { recursive: true });
        const old = path.join(personalDir, `.taskhub-migrate-${'e'.repeat(32)}.tmp`);
        fs.writeFileSync(old, 'partial');
        const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        fs.utimesSync(old, yesterday, yesterday);
        const originalUnlink = fs.promises.unlink;
        let result!: Awaited<ReturnType<typeof migrateLegacyExtensionPresets>>;
        (fs.promises as any).unlink = async (file: fs.PathLike) => {
            if (file === old) { throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
            return originalUnlink(file);
        };
        try {
            result = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
            assert.deepStrictEqual(result.failed, []);
            assert.deepStrictEqual(result.copied, ['preset-cleanup.json']);
            assert.strictEqual(fs.readFileSync(path.join(personalDir, 'preset-cleanup.json'), 'utf8'), '["complete"]');
            assert.strictEqual(fs.existsSync(old), true);
        } finally {
            (fs.promises as any).unlink = originalUnlink;
        }
        await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir, new Set(result.processedSources));
        assert.strictEqual(fs.existsSync(old), false);
    });

    test('번들 프리셋 목록은 저장소의 presets/ 폴더와 같다', () => {
        const repoPresets = path.resolve(__dirname, '..', '..', 'presets');
        const files = fs.readdirSync(repoPresets).filter(f => f.startsWith('preset-') && f.endsWith('.json')).sort();
        assert.deepStrictEqual([...BUNDLED_PRESET_FILES].sort(), files,
            '새 번들 프리셋을 추가하면 BUNDLED_PRESET_FILES 에도 넣어야 개인 프리셋으로 이관되지 않는다');
    });

    test('이전·현재 설치 경로의 개인 프리셋을 복사하고 번들 파일·다른 확장은 제외한다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-example.json', '[]');
        const oldSource = writePreset('munseop.taskhub-0.8.38', 'preset-mine.json', '["old install"]');
        writePreset('munseop.taskhub-0.8.39', 'preset-current.json', '["current install"]');
        writePreset('munseop.taskhub-extras-1.0.0', 'preset-foreign.json', '["prefix collision"]');
        writePreset('other.extension-1.0.0', 'preset-foreign2.json', '["foreign"]');
        const migration = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        assert.deepStrictEqual(migration.copied.sort(), ['preset-current.json', 'preset-mine.json']);
        assert.deepStrictEqual(migration.failed, []);
        assert.ok(migration.processedSources.includes(oldSource));
        assert.strictEqual(fs.readFileSync(path.join(personalDir, 'preset-mine.json'), 'utf8'), '["old install"]');
        assert.ok(fs.existsSync(oldSource), '원본은 지우지 않는다');
        assert.deepStrictEqual(fs.readdirSync(personalDir).sort(), ['preset-current.json', 'preset-mine.json']);
    });

    test('같은 이름은 가장 최근 파일을 쓰고 이미 있는 개인 프리셋은 덮지 않는다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        fs.mkdirSync(current, { recursive: true });
        const older = writePreset('munseop.taskhub-0.8.37', 'preset-dup.json', '["older"]', new Date(2026, 0, 1));
        writePreset('munseop.taskhub-0.8.38', 'preset-dup.json', '["newer"]', new Date(2026, 5, 1));
        const kept = writePreset('munseop.taskhub-0.8.38', 'preset-kept.json', '["legacy"]');
        fs.mkdirSync(personalDir, { recursive: true });
        fs.writeFileSync(path.join(personalDir, 'preset-kept.json'), '["edited personal copy"]');
        const migration = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        assert.deepStrictEqual(migration.copied, ['preset-dup.json']);
        assert.ok(migration.processedSources.includes(older), '더 오래된 사본도 처리한 것으로 기록한다');
        assert.ok(migration.processedSources.includes(kept), '이미 있는 이름도 처리한 것으로 기록한다');
        assert.strictEqual(fs.readFileSync(path.join(personalDir, 'preset-dup.json'), 'utf8'), '["newer"]');
        assert.strictEqual(fs.readFileSync(path.join(personalDir, 'preset-kept.json'), 'utf8'), '["edited personal copy"]');
    });

    test('처리한 원본은 개인 폴더에서 지워도 다시 복사하지 않는다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        fs.mkdirSync(current, { recursive: true });
        writePreset('munseop.taskhub-0.8.38', 'preset-mine.json', '["old install"]');
        const first = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        fs.rmSync(path.join(personalDir, 'preset-mine.json'));
        const second = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir, new Set(first.processedSources));
        assert.deepStrictEqual(second.copied, []);
        assert.strictEqual(fs.existsSync(path.join(personalDir, 'preset-mine.json')), false);
    });

    /** 지정한 원본의 복사만 EACCES로 실패시킨다. */
    async function withCopyFailure<T>(blocked: string, run: () => Promise<T>): Promise<T> {
        const promises = (require('fs') as typeof fs).promises;
        const originalCopy = promises.copyFile;
        (promises as any).copyFile = (src: fs.PathLike, ...rest: unknown[]) => {
            if (String(src) === blocked) {
                return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
            }
            return (originalCopy as any)(src, ...rest);
        };
        try {
            return await run();
        } finally {
            (promises as any).copyFile = originalCopy;
        }
    }

    test('한 파일의 복사 실패는 나머지를 막지 않고 기록하지 않는다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        fs.mkdirSync(current, { recursive: true });
        const blocked = writePreset('munseop.taskhub-0.8.38', 'preset-blocked.json', '["a"]');
        writePreset('munseop.taskhub-0.8.38', 'preset-ok.json', '["b"]');
        const migration = await withCopyFailure(blocked, () => migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir));
        assert.deepStrictEqual(migration.copied, ['preset-ok.json']);
        assert.deepStrictEqual(migration.failed.map(failure => failure.file), ['preset-blocked.json']);
        assert.ok(!migration.processedSources.includes(blocked), '실패한 원본은 다음에 다시 시도한다');
    });

    test('동시 이관 중 한 복사가 부분 실패해도 다른 창은 완성된 개인 사본만 기록한다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        const source = writePreset('munseop.taskhub-0.8.39', 'preset-race.json', '["complete"]');
        const destination = path.join(personalDir, 'preset-race.json');
        const promises = (require('fs') as typeof fs).promises;
        const originalCopy = promises.copyFile;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const copying = new Promise<void>(resolve => { started = resolve; });
        let intercepted = false;
        (promises as any).copyFile = async (src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
            if (String(src) === source && !intercepted) {
                intercepted = true;
                await promises.writeFile(dest, '["partial', { flag: 'wx' });
                started();
                await held;
                await promises.unlink(dest);
                throw Object.assign(new Error('EIO: partial copy failed'), { code: 'EIO' });
            }
            return originalCopy(src, dest, mode);
        };
        const first = migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        try {
            await copying;
            assert.strictEqual(fs.existsSync(destination), false, '복사 중인 파일을 개인 프리셋으로 노출하지 않는다');
            const second = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
            assert.deepStrictEqual(second.copied, ['preset-race.json']);
            release();
            const failed = await first;
            assert.deepStrictEqual(failed.processedSources, []);
            assert.strictEqual(failed.failed.length, 1);
            assert.ok(second.processedSources.includes(presetNameKey('preset-race.json')));
            assert.strictEqual(fs.readFileSync(destination, 'utf8'), '["complete"]');
            assert.deepStrictEqual(fs.readdirSync(personalDir), ['preset-race.json']);
        } finally {
            release();
            await first;
            (promises as any).copyFile = originalCopy;
        }
    });

    test('완성 사본 공개 실패는 처리 기록을 남기지 않고 임시 파일을 정리한다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-publish.json', '[]');
        const promises = (require('fs') as typeof fs).promises;
        const originalLink = promises.link;
        (promises as any).link = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
        try {
            const result = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
            assert.deepStrictEqual(result.processedSources, []);
            assert.deepStrictEqual(result.copied, []);
            assert.strictEqual(result.failed.length, 1);
            assert.deepStrictEqual(fs.readdirSync(personalDir), []);
        } finally {
            (promises as any).link = originalLink;
        }
        assert.deepStrictEqual((await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir)).copied, ['preset-publish.json']);
    });

    test('최신 사본 복사가 실패하면 오래된 사본으로 대신하지 않고 다음에 최신 사본을 옮긴다', async () => {
        // F02: 오래된 사본이 먼저 자리를 차지하면 이후 재시도는 EEXIST 로 막혀 옛 정의가 굳어졌다.
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        fs.mkdirSync(current, { recursive: true });
        const older = writePreset('munseop.taskhub-0.8.37', 'preset-duplicate.json', '["older"]', new Date(2026, 0, 1));
        const newer = writePreset('munseop.taskhub-0.8.38', 'preset-duplicate.json', '["newer"]', new Date(2026, 5, 1));
        const first = await withCopyFailure(newer, () => migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir));
        assert.deepStrictEqual(first.copied, []);
        assert.deepStrictEqual(first.failed.map(failure => failure.file), ['preset-duplicate.json']);
        assert.ok(!first.processedSources.includes(older) && !first.processedSources.includes(newer));
        assert.strictEqual(fs.existsSync(path.join(personalDir, 'preset-duplicate.json')), false);

        const second = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir, new Set(first.processedSources));
        assert.deepStrictEqual(second.copied, ['preset-duplicate.json']);
        assert.strictEqual(fs.readFileSync(path.join(personalDir, 'preset-duplicate.json'), 'utf8'), '["newer"]');
    });

    test('이관 뒤 지운 개인 프리셋은 뒤늦게 보인 과거 사본이 있어도 다시 복사하지 않는다', async () => {
        // G01: 과거 설치 폴더를 처음에 읽지 못해 현재 사본만 옮겼다가, 사용자가 개인
        // 사본을 지운 뒤 과거 폴더가 보이면 이름 전체를 다시 복사했다.
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-duplicate.json', '["current"]', new Date(2026, 5, 1));
        const pastDir = path.join(extensionsRoot, 'munseop.taskhub-0.8.38', 'presets');
        const pastCopy = writePreset('munseop.taskhub-0.8.38', 'preset-duplicate.json', '["past"]', new Date(2026, 0, 1));
        const promises = (require('fs') as typeof fs).promises;
        const originalReaddir = promises.readdir;
        (promises as any).readdir = (dir: fs.PathLike, ...rest: unknown[]) => String(dir) === pastDir
            ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
            : (originalReaddir as any)(dir, ...rest);
        let first!: Awaited<ReturnType<typeof migrateLegacyExtensionPresets>>;
        try {
            first = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        } finally {
            (promises as any).readdir = originalReaddir;
        }
        assert.deepStrictEqual(first.copied, ['preset-duplicate.json']);

        for (const mutate of ['delete', 'rename'] as const) {
            const personalFile = path.join(personalDir, 'preset-duplicate.json');
            if (!fs.existsSync(personalFile)) { fs.writeFileSync(personalFile, '["current"]'); }
            if (mutate === 'delete') { fs.rmSync(personalFile); }
            else { fs.renameSync(personalFile, path.join(personalDir, 'preset-renamed.json')); }
            const second = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir, new Set(first.processedSources));
            assert.deepStrictEqual(second.copied, [], `${mutate} 뒤에 다시 복사하면 안 된다`);
            assert.strictEqual(fs.existsSync(personalFile), false);
            assert.ok(second.processedSources.includes(presetSourceKey(pastCopy)), '새로 보인 과거 사본도 처리 기록에 더한다');
        }
    });

    test('옮긴 원본이 있던 설치 폴더가 정리된 뒤에도 지운 개인 프리셋을 다시 복사하지 않는다', async () => {
        // G01 잔여: 경로 기록만 있으면 처리한 폴더가 사라진 뒤 다른 폴더의 같은 이름 사본이 새 파일이 됐다.
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        const currentCopy = writePreset('munseop.taskhub-0.8.39', 'preset-duplicate.json', '["current"]');
        const pastDir = path.join(extensionsRoot, 'munseop.taskhub-0.8.38', 'presets');
        const promises = (require('fs') as typeof fs).promises;
        const originalReaddir = promises.readdir;
        (promises as any).readdir = (dir: fs.PathLike, ...rest: unknown[]) => String(dir) === pastDir
            ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
            : (originalReaddir as any)(dir, ...rest);
        let first!: Awaited<ReturnType<typeof migrateLegacyExtensionPresets>>;
        try {
            writePreset('munseop.taskhub-0.8.38', 'preset-duplicate.json', '["past"]');
            first = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir);
        } finally {
            (promises as any).readdir = originalReaddir;
        }
        assert.deepStrictEqual(first.copied, ['preset-duplicate.json']);
        fs.rmSync(path.join(personalDir, 'preset-duplicate.json'));
        fs.rmSync(currentCopy);

        const second = await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir, new Set(first.processedSources));
        assert.deepStrictEqual(second.copied, []);
        assert.strictEqual(fs.existsSync(path.join(personalDir, 'preset-duplicate.json')), false);
    });

    test('링크인 후보는 따라가지 않는다', async function () {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        const presetsDir = path.join(current, 'presets');
        fs.mkdirSync(presetsDir, { recursive: true });
        const outside = path.join(root, 'outside.json');
        fs.writeFileSync(outside, '["secret"]');
        try {
            fs.symlinkSync(outside, path.join(presetsDir, 'preset-link.json'), 'file');
        } catch {
            this.skip();
        }
        assert.deepStrictEqual((await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir)).copied, []);
    });

    test('설치 폴더 경로가 바뀌어도 이름 기록만으로 이관을 마친 원본을 후보에서 뺀다', () => {
        // H01: 탐색이 경로 기록만 보면, 새 경로의 원본이 백그라운드 이관이 끝나기 전까지
        // 다시 후보가 돼 지운 프리셋의 명령이 활성화 직후 등록됐다.
        const moved = path.join(extensionsRoot, 'munseop.taskhub-0.8.40');
        writePreset('munseop.taskhub-0.8.40', 'preset-example.json', '[]');
        writePreset('munseop.taskhub-0.8.40', 'preset-personal.json', '[]');
        writePreset('munseop.taskhub-0.8.40', 'preset-never-migrated.json', '[]');
        const oldPath = path.join(extensionsRoot, 'munseop.taskhub-0.8.39', 'presets', 'preset-personal.json');
        const context = fakeContext(moved, [presetNameKey('preset-personal.json'), presetSourceKey(oldPath)]);
        const ids = discoverPresets(context).filter(p => p.source !== 'workspace').map(p => `${p.source}:${p.id}`).sort();
        assert.deepStrictEqual(ids, ['extension:example', 'extension:never-migrated']);

        // 번들 파일은 이름 기록이 있어도 숨기지 않고, 개인 사본이 있으면 그것이 우선한다.
        fs.mkdirSync(personalDir, { recursive: true });
        fs.writeFileSync(path.join(personalDir, 'preset-personal.json'), '[]');
        const withPersonal = fakeContext(moved, [presetNameKey('preset-personal.json'), presetNameKey('preset-example.json')]);
        const next = discoverPresets(withPersonal).filter(p => p.source !== 'workspace').map(p => `${p.source}:${p.id}`).sort();
        assert.deepStrictEqual(next, ['extension:example', 'extension:never-migrated', 'user:personal']);
    });

    test('처리 기록 키는 Windows 에서만 대소문자를 무시한다', () => {
        assert.strictEqual(presetSourceKey('C:\\Users\\Me\\.vscode\\Extensions\\p.json', 'win32'), 'c:\\users\\me\\.vscode\\extensions\\p.json');
        assert.strictEqual(presetSourceKey('/Users/Me/p.json', 'darwin'), '/Users/Me/p.json');
    });

    test('옮길 파일이 없으면 개인 폴더도 만들지 않는다', async () => {
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-example.json', '[]');
        assert.deepStrictEqual((await migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir)).copied, []);
        assert.strictEqual(fs.existsSync(personalDir), false);
    });

    function fakeContext(extensionPath: string, migratedSources: string[]): vscode.ExtensionContext {
        return {
            extensionPath,
            globalStorageUri: vscode.Uri.file(path.join(root, 'globalStorage')),
            globalState: { get: (key: string, fallback: unknown) => key === MIGRATED_LEGACY_PRESETS_KEY ? migratedSources : fallback },
        } as unknown as vscode.ExtensionContext;
    }

    test('이관을 마친 설치 폴더 원본은 개인 사본을 지운 뒤에도 후보로 돌아오지 않는다', async () => {
        // F03: 개인 사본이 없으면 현재 설치 폴더의 원본으로 fallback 해 옛 액션이 다시 등록됐다.
        const current = path.join(extensionsRoot, 'munseop.taskhub-0.8.39');
        writePreset('munseop.taskhub-0.8.39', 'preset-example.json', '[]');
        writePreset('munseop.taskhub-0.8.39', 'preset-personal.json', '[]');
        const failedSource = writePreset('munseop.taskhub-0.8.39', 'preset-notyet.json', '[]');
        const migration = await withCopyFailure(failedSource, () => migrateLegacyExtensionPresets(current, 'Munseop.taskhub', personalDir));
        assert.deepStrictEqual(migration.copied, ['preset-personal.json']);

        const context = fakeContext(current, migration.processedSources);
        const sources = () => discoverPresets(context).filter(p => p.source !== 'workspace').map(p => `${p.source}:${p.id}`).sort();
        assert.deepStrictEqual(sources(), ['extension:example', 'extension:notyet', 'user:personal'],
            '이관한 원본 대신 개인 사본을, 실패한 파일은 설치 폴더에서 찾는다');
        fs.rmSync(path.join(personalDir, 'preset-personal.json'));
        assert.deepStrictEqual(sources(), ['extension:example', 'extension:notyet'], '지운 개인 프리셋이 설치 폴더 원본으로 되살아나면 안 된다');
    });
});

/**
 * 선택한 프리셋 파일을 고치면 실제 확장이 동적 명령을 다시 등록하는지 (R05).
 * 테스트 워크스페이스(`schema/`)에 프리셋을 만들고 실제 FileSystemWatcher 경로를 탄다.
 */
suite('선택한 프리셋 파일 감시', function () {
    this.timeout(30000);
    const presetName = 'watch-regression';

    function presetActions(id: string): unknown[] {
        return [{ id, title: id, action: { description: id, tasks: [{ id: 'run', type: 'shell', command: 'echo' }] } }];
    }

    async function waitForCommand(commandId: string, present: boolean): Promise<void> {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const commands = await vscode.commands.getCommands(true);
            if (commands.includes(commandId) === present) { return; }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.fail(`${commandId} 가 ${present ? '등록' : '해제'}되지 않았다`);
    }

    test('선택한 워크스페이스 프리셋의 내용 변경을 반영한다', async function () {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) { this.skip(); }
        await vscode.extensions.getExtension('Munseop.taskhub')?.activate();
        const vscodeDir = path.join(folder!.uri.fsPath, '.vscode');
        const createdVscodeDir = !fs.existsSync(vscodeDir);
        const presetsDir = path.join(vscodeDir, 'presets');
        const createdPresetsDir = !fs.existsSync(presetsDir);
        const presetPath = path.join(presetsDir, `preset-${presetName}.json`);
        const config = vscode.workspace.getConfiguration('taskhub');
        const originalInfo = vscode.window.showInformationMessage;
        (vscode.window as any).showInformationMessage = () => Promise.resolve(undefined);
        try {
            fs.mkdirSync(presetsDir, { recursive: true });
            fs.writeFileSync(presetPath, JSON.stringify(presetActions('presetWatch.old')));
            await config.update('preset.selected', `${folder!.name}:${presetName}`, vscode.ConfigurationTarget.Global);
            await waitForCommand(buildActionCommandId('presetWatch.old'), true);

            fs.writeFileSync(presetPath, JSON.stringify(presetActions('presetWatch.new')));
            await waitForCommand(buildActionCommandId('presetWatch.new'), true);
            await waitForCommand(buildActionCommandId('presetWatch.old'), false);

            fs.rmSync(presetPath);
            await waitForCommand(buildActionCommandId('presetWatch.new'), false);
        } finally {
            await config.update('preset.selected', undefined, vscode.ConfigurationTarget.Global);
            (vscode.window as any).showInformationMessage = originalInfo;
            fs.rmSync(presetPath, { force: true });
            if (createdPresetsDir) { fs.rmSync(presetsDir, { recursive: true, force: true }); }
            if (createdVscodeDir) { fs.rmSync(vscodeDir, { recursive: true, force: true }); }
        }
    });
});
