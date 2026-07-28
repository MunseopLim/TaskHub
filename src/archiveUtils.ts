import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import * as yauzl from 'yauzl';

/**
 * Create a zip archive at `archivePath` containing the given sources. Each
 * source may be a file or a directory; directories are added recursively under
 * their basename. Returns after the archive is flushed to disk.
 */
export async function createZipArchive(archivePath: string, sources: string[]): Promise<void> {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error('createZipArchive requires at least one source path.');
    }

    const zip = new AdmZip();
    for (const source of sources) {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(source);
        } catch (e: any) {
            throw new Error(`Source path not found: ${source}`);
        }

        if (stat.isDirectory()) {
            // Preserve the directory name as the top-level folder inside the archive.
            zip.addLocalFolder(source, path.basename(source));
        } else if (stat.isFile()) {
            zip.addLocalFile(source);
        } else {
            throw new Error(`Unsupported source type (not a file or directory): ${source}`);
        }
    }

    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        zip.writeZip(archivePath, (err) => {
            if (err) { reject(err); } else { resolve(); }
        });
    });
}

/**
 * 압축 해제 총량 상한. 이 크기를 넘는 아카이브는 풀지 않는다.
 *
 * `adm-zip` 은 엔트리를 통째로 메모리에 올려 쓰므로(`getData()`), 상한이 없으면
 * 작은 zip 하나로 확장 호스트를 OOM 으로 끌 수 있다 — 이른바 zip bomb.
 */
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** 엔트리 하나의 압축 해제 크기 상한. 총량 안이라도 이걸 넘으면 거부한다. */
export const ZIP_MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * 엔트리 **개수** 상한.
 *
 * 크기 상한만으로는 이쪽이 막히지 않는다 — `assertZipWithinLimits` 는 비압축
 * 바이트만 세고 디렉터리는 아예 건너뛰므로, **0바이트 파일과 디렉터리는 비용
 * 0으로 무제한 통과**한다. 실측: 0바이트 엔트리 60,000개가 상한에 걸리지 않고
 * 전부 추출됐다. 엔트리 하나당 우리는 `yauzl.Entry` 객체와 메타데이터 객체를
 * 배열에 쌓고, 파일시스템에는 inode 를 만든다 — 몇십 KB 짜리 아카이브로
 * 확장 호스트 메모리와 대상 디스크를 모두 소모시킬 수 있다.
 */
export const ZIP_MAX_ENTRIES = 20000;

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`; }
    if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
    return `${bytes} B`;
}

/**
 * 압축 해제 크기를 검사한다. **적재 전에** 거부하는 것이 요점이다.
 *
 * zip 중앙 디렉터리에 엔트리별 원본 크기가 들어 있으므로, `getData()` 로
 * 메모리에 올리기 전에 헤더만 보고 판단할 수 있다. 풀어 본 뒤에 재는 방식은
 * 이미 메모리를 쓴 뒤라 방어가 되지 않는다.
 *
 * 헤더 값은 아카이브가 스스로 신고한 값이라 거짓일 수 있다. 그래도 유효한
 * 방어다 — 거짓으로 작게 신고하면 압축 해제 결과가 헤더와 어긋나고, 그건
 * `adm-zip` 이 CRC 불일치로 잡는다. 목적은 "정직하게 거대한" 아카이브를
 * 적재 전에 막는 것이다.
 *
 * 압축률(ratio) 검사는 두지 않았다. 절대 크기 상한이 이미 걸리므로 고압축
 * 아카이브라도 총량·엔트리 한도를 넘으면 그 지점에서 거부된다.
 */
export function assertZipWithinLimits(
    entries: readonly { entryName: string; isDirectory: boolean; header: { size: number } }[],
    maxTotalBytes: number = ZIP_MAX_TOTAL_BYTES,
    maxEntryBytes: number = ZIP_MAX_ENTRY_BYTES
): void {
    let total = 0;
    for (const entry of entries) {
        if (entry.isDirectory) { continue; }
        const size = Number(entry.header?.size ?? 0);
        if (!Number.isFinite(size) || size < 0) {
            throw new Error(`Invalid uncompressed size in archive entry: ${entry.entryName}`);
        }
        if (size > maxEntryBytes) {
            throw new Error(
                `Archive entry '${entry.entryName}' is ${formatBytes(size)} uncompressed, ` +
                `exceeding the ${formatBytes(maxEntryBytes)} per-entry limit.`
            );
        }
        total += size;
        if (total > maxTotalBytes) {
            throw new Error(
                `Archive expands to more than ${formatBytes(maxTotalBytes)} uncompressed; refusing to extract.`
            );
        }
    }
}

/** 엔트리 개수 상한을 검사한다 ({@link ZIP_MAX_ENTRIES}). */
function assertZipEntryCount(count: number): void {
    if (count > ZIP_MAX_ENTRIES) {
        throw new Error(
            `Archive contains more than ${ZIP_MAX_ENTRIES} entries; refusing to extract.`
        );
    }
}

/**
 * `yauzl` 의 경로 거부를 이 모듈의 계약에 맞춘다.
 *
 * `yauzl` 은 `decodeStrings` 기본값에서 `../` 같은 엔트리를 스스로 거부한다
 * (`invalid relative path: …`). 우리 검사와 **중복이지만 없애지 않는다** — 잘
 * 검증된 라이브러리의 독립적인 두 번째 방어선이고, 우리 쪽 검사가 훗날
 * 실수로 약해져도 여기서 걸린다.
 *
 * 다만 호출부와 테스트는 `Blocked path traversal` 이라는 이 모듈의 메시지에
 * 의존하므로, 라이브러리 문구를 그대로 흘려보내지 않고 번역한다.
 */
function normalizeZipError(error: unknown): Error {
    const e = error instanceof Error ? error : new Error(String(error));

    // `a/..` 처럼 대상 디렉터리 자체로 해석되는 엔트리. `yauzl` 은 이것도
    // "invalid relative path" 로 묶어 거부하지만, 이 모듈은 "탈출"과
    // "루트로 해석됨"을 구분해 안내해 왔다 — 원인이 다르므로 문구도 다르다.
    const relative = /invalid relative path:\s*(.+)/i.exec(e.message);
    if (relative) {
        const name = relative[1].trim();
        // `path.normalize('a/..')` 는 `'.'` 를 돌려준다 — 빈 문자열이 아니다.
        const normalized = path.normalize(name).replace(/[/\\]+$/, '');
        const resolvesToRoot = normalized === '' || normalized === '.';
        return new Error(resolvesToRoot
            ? `Invalid archive entry resolves to destination root: ${name}`
            : `Blocked path traversal in archive: ${name}`);
    }

    // 절대 경로 엔트리(`C:/…`, `/etc/…`)도 탈출의 한 형태다.
    const absolute = /absolute path:\s*(.+)/i.exec(e.message);
    if (absolute) {
        return new Error(`Blocked path traversal in archive: ${absolute[1].trim()}`);
    }
    return e;
}

/**
 * 대상 디렉터리 **안의 기존 심볼릭 링크**를 통한 경로 탈출을 막는다.
 *
 * `resolveEntryTarget` 은 문자열만 본다 — `path.resolve`/`path.relative` 로
 * `../` 를 걸러도, 대상 폴더 안에 이미 바깥을 가리키는 링크가 있으면
 * `dest/link/pwn.txt` 는 문자열로는 완벽히 안쪽이다. 그리고 `mkdir` 도
 * `createWriteStream` 도 링크를 **그대로 따라간다**.
 *
 * 실측(0.6.45): `dest/link -> outside` 가 있을 때 엔트리 `link/pwn.txt` 를
 * 추출하면 예외 없이 `outside/pwn.txt` 가 만들어졌다. 아카이브가 링크를
 * 심는 것이 아니라 **이미 있던 링크를 타는** 것이라, 엔트리 이름 검사로는
 * 원리적으로 잡을 수 없다.
 *
 * 그래서 실제로 만들거나 쓰기 직전에 파일시스템 상태를 본다: `dest` 아래
 * 각 세그먼트를 한 단계씩 만들며 `lstat` 으로 링크가 아님을 확인한다.
 * `mkdir -p` 로 한 번에 만들면 중간 세그먼트가 링크여도 "이미 존재"로
 * 통과하므로 재귀 생성을 쓰지 않는다.
 *
 * `dest` **자신**은 검사하지 않는다 — 사용자가 링크를 대상으로 지정한 것은
 * 스스로의 선택이고, 이 함수의 계약은 "dest 안에 머문다"이다.
 */
function mkdirWithinDestination(resolvedDest: string, dirPath: string): void {
    fs.mkdirSync(resolvedDest, { recursive: true });
    const relative = path.relative(resolvedDest, dirPath);
    if (relative === '') { return; }

    let current = resolvedDest;
    for (const segment of relative.split(path.sep)) {
        if (segment === '') { continue; }
        current = path.join(current, segment);
        let stat: fs.Stats | undefined;
        try {
            stat = fs.lstatSync(current);
        } catch {
            stat = undefined;   // 아직 없다 — 우리가 만든다
        }
        if (!stat) {
            fs.mkdirSync(current);
            continue;
        }
        // Windows 의 junction 도 Node 에서 `isSymbolicLink()` 로 잡힌다.
        if (stat.isSymbolicLink()) {
            throw new Error(`Blocked symlinked path in archive destination: ${path.relative(resolvedDest, current)}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Archive entry needs a directory but a file exists at: ${path.relative(resolvedDest, current)}`);
        }
    }
}

/**
 * 파일 엔트리의 최종 경로를 **링크를 따라가지 않고** 연다.
 *
 * 부모 경로는 {@link mkdirWithinDestination} 이 보장하지만, 마지막 이름
 * 자체가 기존 링크면 그 링크를 따라 바깥 파일이 덮어써진다. 링크에는 두
 * 종류가 있고 **둘 다** 막아야 한다:
 *
 *   - **심볼릭 링크**: `lstat` 으로 보이므로 이름만 봐도 걸러진다.
 *   - **하드 링크**: `lstat` 상 그냥 일반 파일이다. 구분할 방법이 이름에는
 *     없다 — 같은 inode 를 가리키는 디렉터리 항목이 둘일 뿐이다. 실측:
 *     `dest/note.txt` 가 `outside/victim.txt` 의 하드 링크일 때 엔트리
 *     `note.txt` 를 추출하면 예외 없이 바깥 파일이 덮어써졌다.
 *
 * 그래서 경로로 열지 않고 **fd 로 연 뒤 그 fd 를 검사**한다:
 *
 *   1. `O_NOFOLLOW` — 마지막 이름이 심볼릭 링크면 커널이 `ELOOP` 로 막는다.
 *      경로를 `lstat` 한 뒤 다시 여는 방식의 TOCTOU 도 함께 사라진다.
 *   2. `O_TRUNC` 를 **일부러 넣지 않는다**. 열자마자 자르면 하드 링크 검사
 *      전에 바깥 파일을 이미 비워 버린 뒤가 된다. 열고 → `fstat` 으로
 *      `nlink` 를 보고 → 통과한 뒤에 자른다.
 *
 * 링크를 지우고 새로 쓰는 대신 **거부**한다 — 사용자가 의도해 둔 링크를
 * 아카이브가 조용히 없애는 편이 더 나쁘다.
 */
function openEntryTargetForWrite(resolvedDest: string, targetPath: string): number {
    const shown = path.relative(resolvedDest, targetPath);
    // Windows 에는 `O_NOFOLLOW` 가 없다. 0 이면 플래그가 빠질 뿐이고, 그쪽은
    // 아래 `lstat` 검사와 junction 검사(`mkdirWithinDestination`)가 받는다.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    if (noFollow === 0) {
        let stat: fs.Stats | undefined;
        try { stat = fs.lstatSync(targetPath); } catch { stat = undefined; }
        if (stat?.isSymbolicLink()) {
            throw new Error(`Blocked symlinked path in archive destination: ${shown}`);
        }
    }

    let fd: number;
    try {
        fd = fs.openSync(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
            throw new Error(`Blocked symlinked path in archive destination: ${shown}`);
        }
        throw e;
    }

    try {
        if (fs.fstatSync(fd).nlink > 1) {
            throw new Error(`Blocked hard-linked path in archive destination: ${shown}`);
        }
        fs.ftruncateSync(fd, 0);
    } catch (e) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        throw e;
    }
    return fd;
}

/** zip 엔트리 이름이 디렉터리를 뜻하는가 (zip 규약: 끝이 `/`). */
function isDirectoryEntryName(entryName: string): boolean {
    return entryName.endsWith('/') || entryName.endsWith('\\');
}

/**
 * 대상 경로를 정하고 zip slip 을 막는다.
 *
 * 반환값이 `null` 이면 디렉터리 엔트리다. 규칙을 어긴 엔트리는 던진다 —
 * 호출부가 **쓰기 전에** 전량을 검사하므로 반쯤 풀린 디렉터리가 남지 않는다.
 */
function resolveEntryTarget(resolvedDest: string, entryName: string): string | null {
    const targetPath = path.resolve(resolvedDest, entryName);
    const relative = path.relative(resolvedDest, targetPath);
    const isDir = isDirectoryEntryName(entryName);
    if (relative === '' && !isDir) {
        // Entry resolves exactly to destination — only allowed for directories.
        throw new Error(`Invalid archive entry resolves to destination root: ${entryName}`);
    }
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Blocked path traversal in archive: ${entryName}`);
    }
    return isDir ? null : targetPath;
}

/**
 * Extract a zip archive to `destination`. Each entry path is validated to
 * remain inside `destination` — entries that would escape (path traversal,
 * a.k.a. "zip slip") cause the extraction to abort before writing anything.
 * 크기 상한도 같은 시점에 검사한다 ({@link assertZipWithinLimits}).
 *
 * **`yauzl` 로 스트리밍한다** (0.6.45부터). 이전에는 `adm-zip` 을 썼는데 그
 * 라이브러리는 두 곳에서 전량을 메모리에 올린다:
 *
 *   1. `new AdmZip(path)` 가 **압축 파일 전체**를 `readFileSync` 로 읽는다.
 *   2. `getData()` / `extractEntryTo()` 가 엔트리 하나를 통째로 푼다
 *      (`extractEntryTo` 도 내부에서 `getData()` 를 부르므로 스트리밍이 아니다).
 *
 * 그래서 peak 가 "압축 파일 + 엔트리 하나" 였고, 크기 상한을 둬도 그 상한만큼
 * 메모리를 쓸 수 있었다. `yauzl` 은 파일을 fd 로 읽고 엔트리를 read stream 으로
 * 주므로 peak 가 **파일 크기와 무관한 상수**가 된다.
 *
 * 생성(`createZipArchive`)은 그대로 `adm-zip` 을 쓴다 — `yauzl` 은 읽기 전용이고,
 * 쓰기까지 바꾸면 교체 범위가 필요 이상으로 커진다.
 */
export async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    const resolvedDest = path.resolve(destination);

    const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        // `lazyEntries` 는 엔트리를 하나씩 요청해 읽게 한다 — 전량을 미리
        // 펼치지 않는 것이 스트리밍의 전제다.
        yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, file) => {
            if (err || !file) { reject(normalizeZipError(err ?? new Error('Failed to open archive'))); return; }
            resolve(file);
        });
    });

    try {
        // 1단계: 전량 검증. 경로 규칙과 크기 상한을 **쓰기 전에** 확인한다 —
        // 중간에 걸리면 반쯤 풀린 디렉터리가 남는다.
        // 중앙 디렉터리가 신고한 개수를 **읽기 전에** 본다. 여기서 걸리면
        // 엔트리를 단 하나도 읽지 않는다.
        //
        // 신고값 하나만 검사하면 충분하다 — `yauzl` 은 `readEntry()` 를
        // `entryCount` 번만 수행하므로 실제로 읽히는 개수가 이 값을 넘을 수
        // 없다. (읽으면서 다시 세는 방어를 넣어 봤지만 도달 불가능한 코드였다.)
        assertZipEntryCount(zipFile.entryCount);

        const entries: yauzl.Entry[] = [];
        await new Promise<void>((resolve, reject) => {
            zipFile.on('entry', (entry: yauzl.Entry) => {
                try {
                    resolveEntryTarget(resolvedDest, entry.fileName);   // 규칙 위반이면 던진다
                } catch (e) {
                    reject(e);
                    return;
                }
                entries.push(entry);
                zipFile.readEntry();
            });
            zipFile.on('end', () => resolve());
            zipFile.on('error', (e) => reject(normalizeZipError(e)));
            zipFile.readEntry();
        });

        assertZipWithinLimits(entries.map(e => ({
            entryName: e.fileName,
            isDirectory: isDirectoryEntryName(e.fileName),
            header: { size: e.uncompressedSize },
        })));

        // 2단계: 스트리밍 추출. 엔트리 하나가 통째로 메모리에 올라오지 않는다.
        fs.mkdirSync(resolvedDest, { recursive: true });
        for (const entry of entries) {
            const targetPath = resolveEntryTarget(resolvedDest, entry.fileName);
            if (targetPath === null) {
                mkdirWithinDestination(resolvedDest, path.resolve(resolvedDest, entry.fileName));
                continue;
            }
            mkdirWithinDestination(resolvedDest, path.dirname(targetPath));

            // **읽기 스트림을 먼저 연다.** 순서가 뒤바뀌면 데이터가 사라진다:
            // `openEntryTargetForWrite` 는 대상 파일을 자르는데, 그 뒤에
            // `openReadStream` 이 실패하면(암호화 엔트리, 미지원 압축 방식 등)
            // **쓸 내용도 없이 기존 파일만 비워 놓은** 상태가 된다. 실측:
            // 16바이트 파일이 0바이트가 됐다. 스트림을 먼저 열면 그런 엔트리는
            // 대상을 건드리기도 전에 거부된다.
            const readStream = await new Promise<Readable>((resolve, reject) => {
                zipFile.openReadStream(entry, (err, stream) => {
                    if (err || !stream) { reject(err ?? new Error('Failed to open entry stream')); return; }
                    resolve(stream);
                });
            });

            let fd: number;
            try {
                // 경로가 아니라 **fd** 로 연다 — 심볼릭/하드 링크와 TOCTOU 를
                // 한 번에 막는다 (openEntryTargetForWrite 참조).
                fd = openEntryTargetForWrite(resolvedDest, targetPath);
            } catch (e) {
                // 대상을 열지 못하면(링크 거부 등) 이미 연 읽기 스트림의 주인이
                // 없어진다 — 버리지 않으면 zip 쪽 자원이 물린 채 남는다.
                readStream.destroy();
                throw e;
            }
            // `pipeline` 을 쓴다. 손으로 엮으면 **한쪽 오류에서 다른 쪽이 남는다** —
            // 예전에는 read 쪽 오류를 그대로 reject 만 하고 출력 `WriteStream` 은
            // 닫지 않아, 손상 아카이브 하나마다 fd 가 하나씩 샜다(실측: 거부 후에도
            // `closed:false, destroyed:false`). `pipeline` 은 어느 쪽이 실패하든
            // 양쪽을 destroy 하고 한 번만 settle 한다.
            // `fd` 를 넘긴다 — 경로로 다시 열면 링크 검사를 우회하게 된다.
            // `autoClose` 기본값이 true 라 `pipeline` 이 실패해도 fd 는 닫힌다.
            await pipeline(readStream, fs.createWriteStream(targetPath, { fd }));
        }
    } finally {
        // `autoClose: false` 로 열었으므로 fd 를 직접 닫는다. 안 닫으면 Windows
        // 에서 아카이브 파일이 잠긴 채 남는다.
        try { zipFile.close(); } catch { /* best effort */ }
    }
}
