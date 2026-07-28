import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

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
 * Extract a zip archive to `destination`. Each entry path is validated to
 * remain inside `destination` — entries that would escape (path traversal,
 * a.k.a. "zip slip") cause the extraction to abort before writing anything.
 *
 * 크기 상한도 같은 시점에 검사한다 ({@link assertZipWithinLimits}).
 */
export async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }

    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries();
    const resolvedDest = path.resolve(destination);

    // Validate every entry first so we don't leave a half-extracted archive on
    // disk if a malicious entry appears midway through.
    for (const entry of entries) {
        const targetPath = path.resolve(resolvedDest, entry.entryName);
        const relative = path.relative(resolvedDest, targetPath);
        if (relative === '' && !entry.isDirectory) {
            // Entry resolves exactly to destination — only allowed for directories.
            throw new Error(`Invalid archive entry resolves to destination root: ${entry.entryName}`);
        }
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Blocked path traversal in archive: ${entry.entryName}`);
        }
    }

    // 경로 검증과 같은 이유로 **쓰기 전에** 전량을 검사한다 — 중간에 걸리면
    // 반쯤 풀린 디렉터리가 남는다.
    assertZipWithinLimits(entries);

    fs.mkdirSync(resolvedDest, { recursive: true });
    for (const entry of entries) {
        const targetPath = path.resolve(resolvedDest, entry.entryName);
        if (entry.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
        }
    }
}
