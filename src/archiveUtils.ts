import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Readable, Transform, Writable, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createDeflateRaw } from 'zlib';
import * as yauzl from 'yauzl';

/**
 * 취소를 받는 방법.
 *
 * 이 모듈은 `vscode` 를 import 하지 않는다 — 순수 node 자식 프로세스에서도
 * require 할 수 있어야 하기 때문이다(메모리 테스트가 그렇게 쓴다). 그래서
 * VS Code 의 `CancellationToken` 대신 표준 `AbortSignal` 을 받는다. 호출부가
 * 토큰을 signal 로 이어 준다.
 */
export interface ArchiveOptions {
    signal?: AbortSignal;
    /**
     * 소스 루트 **밖**을 가리켜 아카이브에서 제외한 심볼릭 링크를 알린다.
     *
     * 이 모듈은 `vscode` 를 모르므로 사용자에게 직접 알릴 수 없다. 호출부가
     * 이 콜백으로 받아 경고를 띄운다 — 조용히 빼면 "왜 이 파일이 zip 에
     * 없지?" 가 되고, 조용히 담으면 비밀이 새어 나간다.
     */
    onSkippedSymlink?: (info: { sourcePath: string; resolvedTarget: string }) => void;
}

/** 취소되었으면 던진다. `pipeline` 의 중단과 같은 `AbortError` 로 맞춘다. */
function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        const e = new Error('Archive operation was cancelled.');
        e.name = 'AbortError';
        throw e;
    }
}

const CRC32_TABLE: readonly number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/** 데이터를 그대로 통과시키면서 ZIP 규약의 CRC32와 바이트 수를 누적한다. */
class Crc32Transform extends Transform {
    private crc = 0xffffffff;
    byteCount = 0;

    get checksum(): number {
        return (this.crc ^ 0xffffffff) >>> 0;
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        for (const byte of chunk) {
            this.crc = CRC32_TABLE[(this.crc ^ byte) & 0xff] ^ (this.crc >>> 8);
        }
        this.byteCount += chunk.length;
        callback(null, chunk);
    }
}

function closeFd(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.close(fd, err => err ? reject(err) : resolve());
    });
}

function syncFd(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.fsync(fd, err => err ? reject(err) : resolve());
    });
}

/** 현재 fd 위치에 버퍼 전체를 쓴다. `fs.write` 의 short write 도 처리한다. */
function writeFdBuffer(fd: number, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        let offset = 0;
        const next = () => {
            if (offset === buffer.length) { resolve(); return; }
            fs.write(fd, buffer, offset, buffer.length - offset, null, (err, written) => {
                if (err) { reject(err); return; }
                if (written <= 0) { reject(new Error('Failed to make progress while writing ZIP archive.')); return; }
                offset += written;
                next();
            });
        };
        next();
    });
}

/** 공유 archive fd를 닫지 않는 entry별 pipeline sink. */
class ArchiveFdSink extends Writable {
    bytesWritten = 0;
    private activeWrite: Promise<void> | undefined;

    constructor(private readonly fd: number) {
        super();
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const write = writeFdBuffer(this.fd, chunk);
        this.activeWrite = write;
        void write.then(() => {
            if (this.activeWrite === write) { this.activeWrite = undefined; }
            this.bytesWritten += chunk.length;
            callback();
        }, error => {
            if (this.activeWrite === write) { this.activeWrite = undefined; }
            callback(error);
        });
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        const write = this.activeWrite;
        if (!write) {
            callback(error);
            return;
        }

        // `pipeline(..., { signal })` destroys its streams immediately on
        // abort. A custom Writable's pending `_write` is not automatically an
        // I/O barrier: without this hook pipeline can reject while fs.write is
        // still using the externally-owned fd, and the caller's finally block
        // may close/reuse it underneath that operation. Finish the outstanding
        // write before allowing pipeline cleanup to close the descriptor.
        void write.then(
            () => callback(error),
            writeError => callback(error ?? (
                writeError instanceof Error ? writeError : new Error(String(writeError))
            ))
        );
    }
}

interface ExclusiveTempFile {
    tempPath: string;
    fd: number;
}

/**
 * 대상과 같은 디렉터리에 예측 불가능한 이름을 `O_EXCL` 로 만든다.
 * 같은 파일시스템에 있어야 마지막 rename이 원자적이다.
 */
function openExclusiveSiblingTempFile(targetPath: string, kind: 'archive' | 'entry'): ExclusiveTempFile {
    const parent = path.dirname(targetPath);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0);
    let lastError: unknown;

    for (let attempt = 0; attempt < 16; attempt++) {
        const token = randomBytes(12).toString('hex');
        // Do not embed the target basename. A perfectly valid 255-byte entry
        // name would exceed the filesystem's NAME_MAX once our suffix was
        // appended, regressing extraction/creation with ENAMETOOLONG.
        const tempPath = path.join(parent, `.taskhub-${kind}-${process.pid}-${token}.tmp`);
        try {
            // 경로 검증 직후 같은 event-loop turn에서 연다. 이 짧은 metadata
            // syscall까지 비동기로 넘기면 부모 링크가 바뀔 JS-level 틈이 생긴다.
            const fd = fs.openSync(tempPath, flags, 0o600);
            return { tempPath, fd };
        } catch (error) {
            lastError = error;
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        }
    }
    throw lastError ?? new Error(`Could not create a temporary file beside: ${targetPath}`);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
}

function defaultCreatedFileMode(): number {
    return 0o666 & ~process.umask();
}

function replacementModeForArchive(targetPath: string): number {
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isFile() && !stat.isSymbolicLink()) { return stat.mode & 0o777; }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
    return defaultCreatedFileMode();
}

/**
 * `realTarget` 이 `rootReal` 안에 있는가 (같은 경로 포함).
 *
 * 문자열 접두사만 보면 `/a/bc` 가 `/a/b` 안이라고 오판하므로 구분자까지 본다.
 */
function isWithinRoot(rootReal: string, realTarget: string): boolean {
    if (realTarget === rootReal) { return true; }
    const relative = path.relative(rootReal, realTarget);
    // `..payload` is an ordinary child name, not a parent traversal. Only a
    // complete `..` path component escapes the root.
    return relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

interface ZipSourceEntry {
    sourcePath: string;
    /** Canonical path selected while enumerating the source tree. */
    readPath: string;
    /** Directory-source boundary. Directly selected files have no boundary. */
    rootRealPath?: string;
    entryName: string;
    isDirectory: boolean;
    stat: fs.Stats;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function sourceChangedError(sourcePath: string): Error {
    return new Error(`Archive source changed while it was being prepared: ${sourcePath}`);
}

/**
 * Open the exact regular file selected during enumeration and pin it by fd.
 *
 * Checking a path and then passing that path to `createReadStream()` leaves a
 * TOCTOU window: a file or any ancestor directory can be replaced by a link to
 * an outside secret between the two operations. Node does not expose
 * `openat2(RESOLVE_BENEATH)`, so fail closed using all portable primitives we
 * have:
 *
 * 1. open asynchronously with `O_NOFOLLOW` (final-component link defense),
 * 2. compare the opened fd's device/inode with the enumerated file,
 * 3. while that fd remains pinned, re-resolve the path and verify that it
 *    still names the fd and remains under the directory-source root, and
 * 4. stream from the already-open fd, never by reopening the path.
 *
 * An external process can always race portable path syscalls at the kernel
 * level, but identity revalidation detects ancestor swaps and the async
 * metadata calls do not freeze the extension-host event loop.
 */
async function openVerifiedSourceStream(entry: ZipSourceEntry): Promise<fs.ReadStream> {
    const flags = fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0);
    let handle: fs.promises.FileHandle | undefined;

    try {
        // FileHandle keeps the same descriptor pinned throughout verification
        // without blocking the extension-host event loop on a slow/network FS.
        handle = await fs.promises.open(entry.readPath, flags);
        const openedStat = await handle.stat();
        if (!openedStat.isFile() || !sameFileIdentity(openedStat, entry.stat)) {
            throw sourceChangedError(entry.sourcePath);
        }

        let currentRealPath: string;
        let currentPathStat: fs.Stats;
        try {
            currentRealPath = await fs.promises.realpath(entry.readPath);
            currentPathStat = await fs.promises.stat(currentRealPath);
        } catch {
            throw sourceChangedError(entry.sourcePath);
        }
        if ((entry.rootRealPath && !isWithinRoot(entry.rootRealPath, currentRealPath)) ||
            !sameFileIdentity(openedStat, currentPathStat)) {
            throw sourceChangedError(entry.sourcePath);
        }

        // FileHandle.createReadStream uses this already-open descriptor rather
        // than reopening the path. Ownership passes to the stream/pipeline.
        const stream = handle.createReadStream({ autoClose: true });
        handle = undefined;
        return stream;
    } finally {
        if (handle !== undefined) {
            try { await handle.close(); } catch { /* preserve the verification error */ }
        }
    }
}

function normalizeArchiveEntryName(name: string, isDirectory: boolean): string {
    const reject = (reason: string): never => {
        throw new Error(`Unsafe archive entry name (${reason}): ${JSON.stringify(name)}`);
    };

    if (name.includes('\0')) { reject('NUL byte'); }
    // ZIP uses `/` on every platform. On POSIX, `\\` is a legal literal file
    // name; converting it to `/` would turn `..\\..\\secret` into traversal.
    // Generated Windows names never need a backslash either, because we only
    // receive basenames/readdir names and compose them with `/` ourselves.
    if (name.includes('\\')) { reject('ambiguous backslash'); }
    if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
        reject('absolute path');
    }

    const components = name.split('/');
    if (components.length === 0 || components.some(component => component === '')) {
        reject('empty path component');
    }
    if (components.some(component => component === '.' || component === '..')) {
        reject('dot path component');
    }
    return isDirectory ? `${name}/` : name;
}

const ZIP_CREATE_MAX_ENTRIES = 0xffff;

/** Apply the classic-ZIP entry limit while walking, before aliases can amplify memory use. */
function appendZipSourceEntry(entries: ZipSourceEntry[], entry: ZipSourceEntry): void {
    if (entries.length >= ZIP_CREATE_MAX_ENTRIES) {
        throw new Error('Archive contains more than 65535 entries; ZIP64 creation is not supported.');
    }
    entries.push(entry);
}

async function collectDirectoryEntries(
    sourceDir: string,
    archiveDir: string,
    activeRealDirectories: Set<string>,
    entries: ZipSourceEntry[],
    signal: AbortSignal | undefined,
    rootRealPath: string,
    options: ArchiveOptions
): Promise<void> {
    throwIfAborted(signal);
    const names = await fs.promises.readdir(sourceDir);
    names.sort();

    for (const name of names) {
        throwIfAborted(signal);
        const sourcePath = path.join(sourceDir, name);

        // **`lstat` 을 먼저 본다.** `stat` 은 링크를 따라가므로, 소스 폴더 안의
        // `link -> ~/.ssh` 같은 링크가 있으면 바깥의 비밀이 조용히 아카이브에
        // 담긴다. 실측: `proj/linkdir -> /secret` 상태에서 압축하면
        // `proj/linkdir/id_rsa` 로 개인 키 내용이 그대로 들어갔다.
        //
        // 규칙은 추출 측과 대칭이다 — **소스 루트 안**으로 해석되는 링크는
        // 그대로 따라가고(프로젝트 안에서 서로를 가리키는 링크는 흔하고
        // 정상이다), 밖을 가리키면 건너뛰고 호출부에 알린다.
        const linkStat = await fs.promises.lstat(sourcePath);
        let resolvedTarget: string;
        try {
            // Resolve every entry, not only a final-component symlink. An
            // ancestor may itself be an allowed in-tree symlink, or may have
            // been replaced concurrently.
            resolvedTarget = await fs.promises.realpath(sourcePath);
        } catch (error) {
            if (linkStat.isSymbolicLink()) { continue; } // broken link
            throw error;
        }
        if (!isWithinRoot(rootRealPath, resolvedTarget)) {
            options.onSkippedSymlink?.({ sourcePath, resolvedTarget });
            continue;
        }

        const stat = await fs.promises.stat(resolvedTarget);
        const entryName = normalizeArchiveEntryName(`${archiveDir}/${name}`, stat.isDirectory());
        if (stat.isDirectory()) {
            appendZipSourceEntry(entries, {
                sourcePath, readPath: resolvedTarget, rootRealPath, entryName, isDirectory: true, stat,
            });
            // Only ancestors in the current recursion branch form a cycle.
            // A global visited set made a second legitimate alias to the same
            // directory appear as an empty folder, depending on sort order.
            if (!activeRealDirectories.has(resolvedTarget)) {
                activeRealDirectories.add(resolvedTarget);
                try {
                    await collectDirectoryEntries(
                        sourcePath,
                        entryName.replace(/\/$/, ''),
                        activeRealDirectories,
                        entries,
                        signal,
                        rootRealPath,
                        options
                    );
                } finally {
                    activeRealDirectories.delete(resolvedTarget);
                }
            }
        } else if (stat.isFile()) {
            appendZipSourceEntry(entries, {
                sourcePath, readPath: resolvedTarget, rootRealPath, entryName, isDirectory: false, stat,
            });
        }
        // adm-zip도 폴더 안의 socket/FIFO/device는 엔트리로 만들지 않는다.
    }
}

async function collectZipSourceEntries(sources: string[], signal: AbortSignal | undefined, options: ArchiveOptions): Promise<ZipSourceEntry[]> {
    const entries: ZipSourceEntry[] = [];
    for (const source of sources) {
        throwIfAborted(signal);
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(source);
        } catch {
            throw new Error(`Source path not found: ${source}`);
        }

        if (stat.isDirectory()) {
            // 사용자가 **직접 지정한** source 는 링크여도 따라간다 — 그건
            // 스스로의 선택이고, 그 실제 경로가 이 트리의 루트가 된다.
            const realPath = await fs.promises.realpath(source);
            await collectDirectoryEntries(
                source,
                normalizeArchiveEntryName(path.basename(source), false),
                new Set([realPath]),
                entries,
                signal,
                realPath,
                options
            );
        } else if (stat.isFile()) {
            const realPath = await fs.promises.realpath(source);
            appendZipSourceEntry(entries, {
                sourcePath: source,
                readPath: realPath,
                entryName: normalizeArchiveEntryName(path.basename(source), false),
                isDirectory: false,
                stat,
            });
        } else {
            throw new Error(`Unsupported source type (not a file or directory): ${source}`);
        }
    }
    return entries;
}

interface CentralDirectoryEntry {
    name: Buffer;
    flags: number;
    method: number;
    dosTime: number;
    dosDate: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    externalAttributes: number;
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    return {
        dosTime: ((date.getHours() & 0x1f) << 11) |
            ((date.getMinutes() & 0x3f) << 5) |
            ((Math.floor(date.getSeconds() / 2)) & 0x1f),
        dosDate: (((year - 1980) & 0x7f) << 9) |
            (((date.getMonth() + 1) & 0x0f) << 5) |
            (date.getDate() & 0x1f),
    };
}

function assertClassicZipValue(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${label} exceeds the 4 GB limit of this ZIP writer.`);
    }
}

function buildLocalFileHeader(entry: CentralDirectoryEntry): Buffer {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.dosTime, 10);
    header.writeUInt16LE(entry.dosDate, 12);
    if ((entry.flags & 0x0008) === 0) {
        header.writeUInt32LE(entry.crc32, 14);
        header.writeUInt32LE(entry.compressedSize, 18);
        header.writeUInt32LE(entry.uncompressedSize, 22);
    }
    header.writeUInt16LE(entry.name.length, 26);
    return header;
}

function buildDataDescriptor(entry: CentralDirectoryEntry): Buffer {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc32, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.uncompressedSize, 12);
    return descriptor;
}

function buildCentralDirectoryHeader(entry: CentralDirectoryEntry): Buffer {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.dosTime, 12);
    header.writeUInt16LE(entry.dosDate, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(entry.localHeaderOffset, 42);
    return header;
}

/**
 * Create a zip archive at `archivePath` containing the given sources. Each
 * source may be a file or a directory; directories are added recursively under
 * their basename. Returns after the archive is flushed to disk.
 *
 * 파일 읽기와 deflate를 스트리밍하므로 확장 호스트의 이벤트 루프를 막지 않고,
 * 큰 파일 하나를 처리하는 도중에도 `AbortSignal`이 pipeline을 중단한다. 결과는
 * 같은 디렉터리의 임시 파일에 먼저 완성하고 fsync/close한 뒤 rename한다 — 실패나
 * 중지로 반쪽 ZIP이 생겨도 기존 `archivePath`는 마지막 성공본 그대로 남는다.
 */
export async function createZipArchive(archivePath: string, sources: string[], options: ArchiveOptions = {}): Promise<void> {
    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error('createZipArchive requires at least one source path.');
    }
    throwIfAborted(options.signal);
    const sourceEntries = await collectZipSourceEntries(sources, options.signal, options);
    if (sourceEntries.length > ZIP_CREATE_MAX_ENTRIES) {
        throw new Error('Archive contains more than 65535 entries; ZIP64 creation is not supported.');
    }
    for (const entry of sourceEntries) {
        const nameLength = Buffer.byteLength(entry.entryName, 'utf8');
        if (nameLength > 0xffff) {
            throw new Error(`Archive entry name is too long: ${entry.entryName}`);
        }
        if (!entry.isDirectory) {
            assertClassicZipValue(entry.stat.size, `Archive entry '${entry.entryName}'`);
        }
    }

    const resolvedArchivePath = path.resolve(archivePath);
    await fs.promises.mkdir(path.dirname(resolvedArchivePath), { recursive: true });
    throwIfAborted(options.signal);
    const temp = openExclusiveSiblingTempFile(resolvedArchivePath, 'archive');
    let fdOpen = true;
    let committed = false;

    try {
        const centralEntries: CentralDirectoryEntry[] = [];
        let archiveOffset = 0;

        for (const sourceEntry of sourceEntries) {
            throwIfAborted(options.signal);
            const name = Buffer.from(sourceEntry.entryName, 'utf8');
            const { dosTime, dosDate } = dosDateTime(sourceEntry.stat.mtime);
            const central: CentralDirectoryEntry = {
                name,
                flags: 0x0800 | (sourceEntry.isDirectory ? 0 : 0x0008),
                method: sourceEntry.isDirectory ? 0 : 8,
                dosTime,
                dosDate,
                crc32: 0,
                compressedSize: 0,
                uncompressedSize: 0,
                localHeaderOffset: archiveOffset,
                externalAttributes: (
                    (((sourceEntry.stat.mode & 0xffff) << 16) >>> 0) |
                    (sourceEntry.isDirectory ? 0x10 : 0)
                ) >>> 0,
            };

            const localHeader = buildLocalFileHeader(central);
            await writeFdBuffer(temp.fd, localHeader);
            await writeFdBuffer(temp.fd, name);
            archiveOffset += localHeader.length + name.length;

            if (!sourceEntry.isDirectory) {
                const checksum = new Crc32Transform();
                const sink = new ArchiveFdSink(temp.fd);
                await pipeline(
                    await openVerifiedSourceStream(sourceEntry),
                    checksum,
                    createDeflateRaw(),
                    sink,
                    { signal: options.signal }
                );
                central.crc32 = checksum.checksum;
                central.uncompressedSize = checksum.byteCount;
                central.compressedSize = sink.bytesWritten;
                assertClassicZipValue(central.uncompressedSize, `Archive entry '${sourceEntry.entryName}'`);
                assertClassicZipValue(central.compressedSize, `Compressed archive entry '${sourceEntry.entryName}'`);
                archiveOffset += central.compressedSize;

                const descriptor = buildDataDescriptor(central);
                await writeFdBuffer(temp.fd, descriptor);
                archiveOffset += descriptor.length;
            }
            assertClassicZipValue(archiveOffset, 'ZIP archive');
            centralEntries.push(central);
        }

        throwIfAborted(options.signal);
        const centralDirectoryOffset = archiveOffset;
        for (const central of centralEntries) {
            throwIfAborted(options.signal);
            const header = buildCentralDirectoryHeader(central);
            await writeFdBuffer(temp.fd, header);
            await writeFdBuffer(temp.fd, central.name);
            archiveOffset += header.length + central.name.length;
            assertClassicZipValue(archiveOffset, 'ZIP archive');
        }
        const centralDirectorySize = archiveOffset - centralDirectoryOffset;

        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(centralEntries.length, 8);
        end.writeUInt16LE(centralEntries.length, 10);
        end.writeUInt32LE(centralDirectorySize, 12);
        end.writeUInt32LE(centralDirectoryOffset, 16);
        await writeFdBuffer(temp.fd, end);
        throwIfAborted(options.signal);
        fs.fchmodSync(temp.fd, replacementModeForArchive(resolvedArchivePath));
        await syncFd(temp.fd);
        await closeFd(temp.fd);
        fdOpen = false;

        // 이 검사와 rename 사이에는 await가 없다. 이 지점이 생성의 commit point다.
        throwIfAborted(options.signal);
        await fs.promises.rename(temp.tempPath, resolvedArchivePath);
        committed = true;
    } finally {
        if (fdOpen) {
            try { await closeFd(temp.fd); } catch { /* best effort */ }
        }
        if (!committed) {
            try { await unlinkIfPresent(temp.tempPath); } catch { /* 원래 오류를 보존한다 */ }
        }
    }
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
 * 방어다 — 거짓으로 작게 신고하면 압축 해제 결과가 헤더와 어긋나고, 아래
 * 스트리밍 크기/CRC 검증이 잡는다. 목적은 "정직하게 거대한" 아카이브를
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
 * 파일 엔트리의 최종 경로를 **링크를 따라가지 않고** 검사한다.
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
 * 엔트리 데이터는 별도 임시 파일에 이미 완성되어 있으므로 최종 대상은 쓰기
 * 모드로 열거나 자를 필요가 없다. 기존 대상이 있으면 **fd 로 열어 검사**한다:
 *
 *   1. `O_NOFOLLOW` — 마지막 이름이 심볼릭 링크면 커널이 `ELOOP` 로 막는다.
 *      경로를 `lstat` 한 뒤 다시 여는 방식의 TOCTOU 도 함께 사라진다.
 *   2. `fstat().nlink` — 하드 링크면 최종 rename 전에 거부한다.
 *
 * 링크를 지우고 새로 쓰는 대신 **거부**한다 — 사용자가 의도해 둔 링크를
 * 아카이브가 조용히 없애는 편이 더 나쁘다.
 */
function assertEntryTargetReplaceable(resolvedDest: string, targetPath: string): number {
    const shown = path.relative(resolvedDest, targetPath);
    let pathStat: fs.Stats;
    try {
        pathStat = fs.lstatSync(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return defaultCreatedFileMode(); }
        throw error;
    }
    if (pathStat.isSymbolicLink()) {
        throw new Error(`Blocked symlinked path in archive destination: ${shown}`);
    }
    if (!pathStat.isFile()) {
        throw new Error(`Archive entry needs a file but a non-file exists at: ${shown}`);
    }

    // Windows 에는 `O_NOFOLLOW` 가 없다. 그쪽에서도 lstat로 명백한 링크를 막고,
    // 마지막 동작은 링크를 따라 쓰는 open이 아니라 링크 자체를 교체하는 rename이다.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd: number;
    try {
        fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
            throw new Error(`Blocked symlinked path in archive destination: ${shown}`);
        }
        // 검사 사이에 대상이 사라졌다면 rename은 새 파일을 만들 뿐이다.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') { return defaultCreatedFileMode(); }
        throw e;
    }

    try {
        const openedStat = fs.fstatSync(fd);
        if (!openedStat.isFile()) {
            throw new Error(`Archive entry needs a file but a non-file exists at: ${shown}`);
        }
        if (openedStat.nlink > 1) {
            throw new Error(`Blocked hard-linked path in archive destination: ${shown}`);
        }
        return openedStat.mode & 0o777;
    } finally {
        try { fs.closeSync(fd); } catch { /* best effort */ }
    }
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
    if (!isWithinRoot(resolvedDest, targetPath)) {
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
 * 파일 하나는 같은 디렉터리의 임시 파일에 끝까지 스트리밍하고 크기와 CRC를
 * 확인한 뒤에만 rename한다. 따라서 현재 엔트리가 손상됐거나 중지되면 기존
 * 대상은 byte-for-byte 보존되고 임시 파일은 지워진다. 이미 완료해 교체한 앞쪽
 * 엔트리와 생성한 디렉터리까지 되돌리는 archive 전체 transaction은 아니다.
 */
export async function extractZipArchive(archivePath: string, destination: string, options: ArchiveOptions = {}): Promise<void> {
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Archive not found: ${archivePath}`);
    }
    throwIfAborted(options.signal);
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
                    throwIfAborted(options.signal);
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
            // 엔트리 경계마다 확인한다. 엔트리 **안**에서의 중단은 아래
            // `pipeline` 에 signal 을 넘겨 처리한다 — 큰 파일 하나를 푸는
            // 도중에도 중지가 듣게 하려면 그쪽이 필요하다.
            throwIfAborted(options.signal);
            const targetPath = resolveEntryTarget(resolvedDest, entry.fileName);
            if (targetPath === null) {
                mkdirWithinDestination(resolvedDest, path.resolve(resolvedDest, entry.fileName));
                continue;
            }
            mkdirWithinDestination(resolvedDest, path.dirname(targetPath));

            // 읽기 스트림을 먼저 연다. 암호화 엔트리나 미지원 압축 방식이면
            // 임시 파일조차 만들지 않고 거부할 수 있다.
            const readStream = await new Promise<Readable>((resolve, reject) => {
                zipFile.openReadStream(entry, (err, stream) => {
                    if (err || !stream) { reject(err ?? new Error('Failed to open entry stream')); return; }
                    resolve(stream);
                });
            });

            let temp: ExclusiveTempFile;
            try {
                // openReadStream을 기다리는 동안 부모가 링크로 바뀌었을 수 있다.
                // 임시 파일 open 직전에 다시 검사하고 같은 turn에서 O_EXCL로 연다.
                mkdirWithinDestination(resolvedDest, path.dirname(targetPath));
                temp = openExclusiveSiblingTempFile(targetPath, 'entry');
            } catch (e) {
                readStream.destroy();
                throw e;
            }

            let fdOwned = true;
            let committed = false;
            try {
                const checksum = new Crc32Transform();
                // 이 sink는 fd를 닫지 않는다. CRC 검증 뒤 fsync/close까지 우리가
                // 소유해야 임시 파일의 완성 시점과 commit을 분리할 수 있다.
                const output = new ArchiveFdSink(temp.fd);
                await pipeline(readStream, checksum, output, { signal: options.signal });

                if (checksum.byteCount !== entry.uncompressedSize) {
                    throw new Error(
                        `Archive entry size mismatch for '${entry.fileName}': ` +
                        `expected ${entry.uncompressedSize}, got ${checksum.byteCount}.`
                    );
                }
                if (checksum.checksum !== entry.crc32) {
                    throw new Error(`Archive entry CRC mismatch: ${entry.fileName}`);
                }
                throwIfAborted(options.signal);

                // 부모가 링크로 바뀌지 않았는지 다시 확인하고, 최종 이름 자체의
                // symlink/hardlink 방어도 commit 직전에 수행한다.
                mkdirWithinDestination(resolvedDest, path.dirname(targetPath));
                const finalMode = assertEntryTargetReplaceable(resolvedDest, targetPath);
                fs.fchmodSync(temp.fd, finalMode);
                await closeFd(temp.fd);
                fdOwned = false;

                // close 동안 대상 경로가 바뀔 수 있으므로 마지막으로 한 번 더
                // 링크 방어를 확인한다. rename은 링크를 따라 쓰지 않고 이름을 교체한다.
                mkdirWithinDestination(resolvedDest, path.dirname(targetPath));
                assertEntryTargetReplaceable(resolvedDest, targetPath);
                throwIfAborted(options.signal);
                await fs.promises.rename(temp.tempPath, targetPath);
                committed = true;
            } finally {
                if (fdOwned) {
                    try { await closeFd(temp.fd); } catch { /* best effort */ }
                }
                if (!committed) {
                    try { await unlinkIfPresent(temp.tempPath); } catch { /* 원래 오류를 보존한다 */ }
                }
            }
        }
    } finally {
        // `autoClose: false` 로 열었으므로 fd 를 직접 닫는다. 안 닫으면 Windows
        // 에서 아카이브 파일이 잠긴 채 남는다.
        try { zipFile.close(); } catch { /* best effort */ }
    }
}
