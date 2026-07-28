import * as fs from 'fs';
import * as path from 'path';
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
                fs.mkdirSync(path.resolve(resolvedDest, entry.fileName), { recursive: true });
                continue;
            }
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            await new Promise<void>((resolve, reject) => {
                zipFile.openReadStream(entry, (err, readStream) => {
                    if (err || !readStream) { reject(err ?? new Error('Failed to open entry stream')); return; }
                    const out = fs.createWriteStream(targetPath);
                    readStream.on('error', reject);
                    out.on('error', reject);
                    out.on('close', () => resolve());
                    readStream.pipe(out);
                });
            });
        }
    } finally {
        // `autoClose: false` 로 열었으므로 fd 를 직접 닫는다. 안 닫으면 Windows
        // 에서 아카이브 파일이 잠긴 채 남는다.
        try { zipFile.close(); } catch { /* best effort */ }
    }
}
