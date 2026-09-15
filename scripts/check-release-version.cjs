#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

// 개발 전용 필드만 제외한다. 새 manifest 필드는 기본적으로 배포 영향이 있다.
const developmentManifestFields = new Set(['version', 'scripts', 'devDependencies', 'packageManager', '$schema']);
const developmentFiles = new Set([
    '.gitignore', '.gitattributes', '.editorconfig', '.nvmrc', '.vscode-test.mjs',
    'eslint.config.mjs', 'LICENSE', 'scripts/check-release-version.cjs', 'scripts/test_encoding.py',
]);

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
    });
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label}: 올바른 JSON 파일이 아닙니다.`);
    }
}

function readJson(root, name) {
    return parseJson(fs.readFileSync(path.join(root, name), 'utf8'), name);
}

function readGitJson(root, revision, name) {
    try {
        return parseJson(git(root, ['show', `${revision}:${name}`]), `${revision}:${name}`);
    } catch (error) {
        throw new Error(`${revision}:${name} 기준 파일을 읽을 수 없습니다. ${error.message}`);
    }
}

function sorted(value) {
    if (Array.isArray(value)) {
        return value.map(sorted);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    }
    return value;
}

function same(left, right) {
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function runtimeManifest(manifest) {
    const runtime = Object.fromEntries(Object.entries(manifest).filter(([key]) => !developmentManifestFields.has(key)));
    // 빌드/패키징 명령과 npm의 pre/post hook은 결과물에 영향을 준다.
    // test/lint/check-* 등 개발 검사 명령은 버전 증가 대상에서 제외한다.
    const buildScripts = Object.fromEntries(Object.entries(manifest.scripts || {})
        .filter(([name]) => /^(?:pre|post)?(?:build|compile|package|prepare|vscode:prepublish)(?::|$)/.test(name)));
    if (Object.keys(buildScripts).length > 0) {
        runtime.scripts = buildScripts;
    }
    return runtime;
}

function runtimeLock(lock) {
    // v1에는 dev/runtime 구분에 필요한 packages 표가 없다. 조용히 면제하지 않는다.
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages['']) {
        throw new Error('package-lock.json은 packages 루트가 있는 lockfileVersion 2 또는 3이어야 합니다.');
    }
    const root = runtimeManifest(lock.packages['']);
    const packages = Object.fromEntries(Object.entries(lock.packages)
        .filter(([name, entry]) => name !== '' && entry.dev !== true));
    return { root, packages };
}

function requiresRelease(file) {
    if (file === 'package.json' || file === 'package-lock.json') {
        return false; // 필드/런타임 의존성 단위로 아래에서 비교한다.
    }
    if (developmentFiles.has(file) || /\.md$/i.test(file)) {
        return false;
    }
    if (/^(?:src\/test|tests?|docs|examples|\.github|\.agents|\.codex|\.claude)(?:\/|$)/.test(file)) {
        return false;
    }
    // src, media, presets, schema, NLS, 빌드/패키징 설정 및 새 배포 파일 포함.
    return true;
}

function validateVersions(manifest, lock, changelog) {
    const heading = changelog.replace(/<!--[\s\S]*?-->/g, '').match(/^##\s+\[([^\]\r\n]+)\]/m);
    const versions = {
        'package.json': manifest.version,
        'package-lock.json': lock.version,
        'package-lock.json packages[""]': lock.packages?.['']?.version,
        'CHANGELOG.md 최상단': heading?.[1],
    };
    for (const [label, version] of Object.entries(versions)) {
        if (typeof version !== 'string' || semver.valid(version) !== version) {
            throw new Error(`${label}: 유효한 SemVer 버전이 필요합니다 (${String(version)}).`);
        }
    }
    if (Object.values(versions).some(version => version !== manifest.version)) {
        throw new Error(`릴리스 버전이 일치하지 않습니다: ${Object.entries(versions).map(([label, version]) => `${label}=${version}`).join(', ')}`);
    }
}

function checkReleaseVersion(cwd = process.cwd(), explicitBase = process.env.TASKHUB_VERSION_BASE) {
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    const manifest = readJson(root, 'package.json');
    const lock = readJson(root, 'package-lock.json');
    validateVersions(manifest, lock, fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
    const currentRuntimeLock = runtimeLock(lock);

    const dirty = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0;
    const base = explicitBase || (dirty ? 'HEAD' : 'HEAD^');
    let revision;
    try {
        revision = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
    } catch {
        throw new Error(`비교 기준 ${base}를 읽을 수 없습니다. Git 이력을 fetch하거나 TASKHUB_VERSION_BASE에 존재하는 기준 commit을 지정하세요. shallow/초기 저장소 검사를 생략하지 않습니다.`);
    }
    const baselineManifest = readGitJson(root, revision, 'package.json');
    if (typeof baselineManifest.version !== 'string' || semver.valid(baselineManifest.version) !== baselineManifest.version) {
        throw new Error(`비교 기준 ${base}의 package.json 버전이 올바르지 않습니다.`);
    }
    const baselineLock = runtimeLock(readGitJson(root, revision, 'package-lock.json'));
    // --no-renames로 이동의 원래 경로와 새 경로를 모두 검사한다. NUL로 공백/개행도 보전한다.
    const workingPaths = git(root, ['diff', '--name-only', '--no-renames', '-z', revision, '--']).split('\0').filter(Boolean);
    const indexPaths = git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', revision, '--']).split('\0').filter(Boolean);
    const untrackedPaths = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const changedPaths = [...new Set([...workingPaths, ...indexPaths, ...untrackedPaths])].sort();
    const reasons = changedPaths.filter(requiresRelease);
    if (!same(runtimeManifest(manifest), runtimeManifest(baselineManifest))
        || (indexPaths.includes('package.json') && !same(runtimeManifest(readGitJson(root, '', 'package.json')), runtimeManifest(baselineManifest)))) {
        reasons.push('package.json (실행/배포 필드)');
    }
    if (!same(currentRuntimeLock, baselineLock)
        || (indexPaths.includes('package-lock.json') && !same(runtimeLock(readGitJson(root, '', 'package-lock.json')), baselineLock))) {
        reasons.push('package-lock.json (런타임 의존성)');
    }
    if (reasons.length > 0 && !semver.gt(manifest.version, baselineManifest.version)) {
        throw new Error(`실행 코드/배포 동작이 바뀌었지만 버전이 증가하지 않았습니다 (${base}: ${baselineManifest.version} → ${manifest.version}). package.json, package-lock.json의 두 버전과 CHANGELOG 최상단을 함께 올리세요. 변경: ${reasons.join(', ')}`);
    }
    return { version: manifest.version, base, baselineVersion: baselineManifest.version, releaseRequired: reasons.length > 0, reasons };
}

if (require.main === module) {
    try {
        const result = checkReleaseVersion();
        console.log(`릴리스 버전 검사 통과: ${result.version} (기준 ${result.base}: ${result.baselineVersion}, ${result.releaseRequired ? '배포 변경' : '개발/문서 변경만 있음'})`);
    } catch (error) {
        console.error(`릴리스 버전 검사 실패: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { checkReleaseVersion };
