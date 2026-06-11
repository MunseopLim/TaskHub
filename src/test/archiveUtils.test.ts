import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { createZipArchive, extractZipArchive } from './../archiveUtils';

/**
 * adm-zip은 `addFile()` 시점에 엔트리 이름을 정규화하므로 ('../evil.txt' →
 * 'evil.txt') adm-zip 자체로는 악성 아카이브를 만들 수 없다. 반면 디스크에서
 * 읽을 때는 엔트리 이름을 그대로 보존하므로, zip-slip 가드를 검증하려면
 * 아카이브를 raw 바이트로 직접 조립해야 한다. 아래 빌더는 압축하지 않은
 * (stored) 엔트리만 담는 최소한의 ZIP을 만든다.
 */
interface RawZipEntry {
    name: string;
    data: Buffer;
}

const CRC_TABLE: number[] = (() => {
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

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buf) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function buildRawZip(entries: RawZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);       // local file header signature
        lfh.writeUInt16LE(20, 4);               // version needed to extract
        lfh.writeUInt16LE(0, 6);                // general purpose bit flag
        lfh.writeUInt16LE(0, 8);                // compression method: stored
        lfh.writeUInt16LE(0, 10);               // last mod time
        lfh.writeUInt16LE(0x21, 12);            // last mod date (1980-01-01)
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(data.length, 18);     // compressed size
        lfh.writeUInt32LE(data.length, 22);     // uncompressed size
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);               // extra field length
        const local = Buffer.concat([lfh, nameBuf, data]);

        const cdh = Buffer.alloc(46);
        cdh.writeUInt32LE(0x02014b50, 0);       // central directory signature
        cdh.writeUInt16LE(20, 4);               // version made by
        cdh.writeUInt16LE(20, 6);               // version needed to extract
        cdh.writeUInt16LE(0, 8);                // general purpose bit flag
        cdh.writeUInt16LE(0, 10);               // compression method: stored
        cdh.writeUInt16LE(0, 12);               // last mod time
        cdh.writeUInt16LE(0x21, 14);            // last mod date
        cdh.writeUInt32LE(crc, 16);
        cdh.writeUInt32LE(data.length, 20);     // compressed size
        cdh.writeUInt32LE(data.length, 24);     // uncompressed size
        cdh.writeUInt16LE(nameBuf.length, 28);  // file name length
        cdh.writeUInt32LE(offset, 42);          // local header offset
        centrals.push(Buffer.concat([cdh, nameBuf]));

        locals.push(local);
        offset += local.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);          // end of central directory signature
    eocd.writeUInt16LE(entries.length, 8);      // entries on this disk
    eocd.writeUInt16LE(entries.length, 10);     // total entries
    eocd.writeUInt32LE(centralBuf.length, 12);  // central directory size
    eocd.writeUInt32LE(offset, 16);             // central directory offset
    return Buffer.concat([...locals, centralBuf, eocd]);
}

suite('archiveUtils', () => {
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-archive-utils-'));
    });

    teardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (err: any) {
            console.warn(`teardown: could not remove ${tempDir} (${err?.code ?? err?.message ?? err}); leaving for OS temp cleanup`);
        }
    });

    function writeRawZip(fileName: string, entries: RawZipEntry[]): string {
        const archivePath = path.join(tempDir, fileName);
        fs.writeFileSync(archivePath, buildRawZip(entries));
        return archivePath;
    }

    suite('createZipArchive', () => {
        test('빈 sources 배열이면 거부', async () => {
            await assert.rejects(
                createZipArchive(path.join(tempDir, 'out.zip'), []),
                /requires at least one source path/
            );
        });

        test('존재하지 않는 source 경로면 해당 경로를 알려주며 거부', async () => {
            const missing = path.join(tempDir, 'no-such-file.txt');
            await assert.rejects(
                createZipArchive(path.join(tempDir, 'out.zip'), [missing]),
                (e: Error) => e.message.includes('Source path not found') && e.message.includes(missing)
            );
        });

        test('파일 소스는 아카이브 최상위에 basename으로 추가됨', async () => {
            const src = path.join(tempDir, 'hello.txt');
            fs.writeFileSync(src, 'hello world');
            const archivePath = path.join(tempDir, 'out.zip');

            await createZipArchive(archivePath, [src]);

            const names = new AdmZip(archivePath).getEntries().map(e => e.entryName);
            assert.deepStrictEqual(names, ['hello.txt']);
        });

        test('디렉터리 소스는 basename을 최상위 폴더로 하여 재귀적으로 추가됨', async () => {
            const dir = path.join(tempDir, 'proj');
            fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
            fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'B');
            const archivePath = path.join(tempDir, 'out.zip');

            await createZipArchive(archivePath, [dir]);

            const names = new AdmZip(archivePath).getEntries()
                .filter(e => !e.isDirectory)
                .map(e => e.entryName.replace(/\\/g, '/'))
                .sort();
            assert.deepStrictEqual(names, ['proj/a.txt', 'proj/sub/b.txt']);
        });

        test('archivePath의 부모 디렉터리가 없으면 생성', async () => {
            const src = path.join(tempDir, 'hello.txt');
            fs.writeFileSync(src, 'hi');
            const archivePath = path.join(tempDir, 'deep', 'nested', 'out.zip');

            await createZipArchive(archivePath, [src]);

            assert.ok(fs.existsSync(archivePath));
        });

        if (process.platform !== 'win32') {
            test('파일도 디렉터리도 아닌 소스(FIFO)는 거부', async function () {
                const fifo = path.join(tempDir, 'pipe.fifo');
                try {
                    execFileSync('mkfifo', [fifo]);
                } catch {
                    this.skip(); // mkfifo가 없는 환경이면 건너뛴다.
                    return;
                }
                await assert.rejects(
                    createZipArchive(path.join(tempDir, 'out.zip'), [fifo]),
                    /Unsupported source type/
                );
            });
        }
    });

    suite('extractZipArchive', () => {
        test('존재하지 않는 아카이브면 거부', async () => {
            await assert.rejects(
                extractZipArchive(path.join(tempDir, 'missing.zip'), path.join(tempDir, 'dest')),
                /Archive not found/
            );
        });

        test('zip → unzip 왕복으로 바이너리 내용과 중첩 구조가 보존됨', async () => {
            const dir = path.join(tempDir, 'bundle');
            fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
            const binary = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d]);
            fs.writeFileSync(path.join(dir, 'bin', 'blob.dat'), binary);
            fs.writeFileSync(path.join(dir, 'readme.txt'), '한국어 내용');
            const standalone = path.join(tempDir, 'top.txt');
            fs.writeFileSync(standalone, 'top-level');
            const archivePath = path.join(tempDir, 'out.zip');
            const dest = path.join(tempDir, 'restored');

            await createZipArchive(archivePath, [dir, standalone]);
            await extractZipArchive(archivePath, dest);

            assert.deepStrictEqual(fs.readFileSync(path.join(dest, 'bundle', 'bin', 'blob.dat')), binary);
            assert.strictEqual(fs.readFileSync(path.join(dest, 'bundle', 'readme.txt'), 'utf8'), '한국어 내용');
            assert.strictEqual(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'top-level');
        });

        test('대상 디렉터리가 없으면 생성', async () => {
            const archivePath = writeRawZip('ok.zip', [
                { name: 'file.txt', data: Buffer.from('content') },
            ]);
            const dest = path.join(tempDir, 'brand', 'new', 'dest');

            await extractZipArchive(archivePath, dest);

            assert.strictEqual(fs.readFileSync(path.join(dest, 'file.txt'), 'utf8'), 'content');
        });

        test('"../" 경로 탈출(zip slip) 엔트리를 차단', async () => {
            const archivePath = writeRawZip('slip.zip', [
                { name: '../evil.txt', data: Buffer.from('pwned') },
            ]);
            const dest = path.join(tempDir, 'dest');

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /Blocked path traversal/
            );
            assert.ok(!fs.existsSync(path.join(tempDir, 'evil.txt')));
        });

        test('깊은 중첩을 통한 경로 탈출도 차단', async () => {
            const archivePath = writeRawZip('slip-deep.zip', [
                { name: 'a/b/../../../evil.txt', data: Buffer.from('pwned') },
            ]);

            await assert.rejects(
                extractZipArchive(archivePath, path.join(tempDir, 'dest')),
                /Blocked path traversal/
            );
            assert.ok(!fs.existsSync(path.join(tempDir, 'evil.txt')));
        });

        test('절대 경로 엔트리를 차단', async () => {
            const outside = path.join(os.tmpdir(), `taskhub-abs-escape-${process.pid}.txt`);
            const archivePath = writeRawZip('abs.zip', [
                { name: outside, data: Buffer.from('pwned') },
            ]);

            try {
                await assert.rejects(
                    extractZipArchive(archivePath, path.join(tempDir, 'dest')),
                    /Blocked path traversal/
                );
                assert.ok(!fs.existsSync(outside));
            } finally {
                fs.rmSync(outside, { force: true });
            }
        });

        test('대상 루트로 해석되는 파일 엔트리("a/..")를 차단', async () => {
            const archivePath = writeRawZip('root.zip', [
                { name: 'a/..', data: Buffer.from('pwned') },
            ]);

            await assert.rejects(
                extractZipArchive(archivePath, path.join(tempDir, 'dest')),
                /resolves to destination root/
            );
        });

        test('악성 엔트리가 뒤에 있으면 앞의 정상 엔트리도 디스크에 쓰지 않음', async () => {
            const archivePath = writeRawZip('mixed.zip', [
                { name: 'innocent.txt', data: Buffer.from('fine') },
                { name: '../evil.txt', data: Buffer.from('pwned') },
            ]);
            const dest = path.join(tempDir, 'dest');

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /Blocked path traversal/
            );
            // 전체 검증이 쓰기보다 먼저 수행되어야 한다 — 반쯤 풀린
            // 아카이브(innocent.txt)도, 대상 디렉터리 자체도 남으면 안 된다.
            assert.ok(!fs.existsSync(path.join(dest, 'innocent.txt')));
            assert.ok(!fs.existsSync(dest));
        });

        test('디렉터리 엔트리는 빈 디렉터리로 복원됨', async () => {
            const archivePath = writeRawZip('dirs.zip', [
                { name: 'empty-dir/', data: Buffer.alloc(0) },
                { name: 'filled/inner.txt', data: Buffer.from('x') },
            ]);
            const dest = path.join(tempDir, 'dest');

            await extractZipArchive(archivePath, dest);

            assert.ok(fs.statSync(path.join(dest, 'empty-dir')).isDirectory());
            assert.strictEqual(fs.readFileSync(path.join(dest, 'filled', 'inner.txt'), 'utf8'), 'x');
        });
    });
});
