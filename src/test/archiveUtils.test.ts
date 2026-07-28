import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import {
    ZIP_MAX_ENTRIES,
    ZIP_MAX_ENTRY_BYTES,
    ZIP_MAX_TOTAL_BYTES,
    assertZipWithinLimits,
    createZipArchive,
    extractZipArchive,
} from './../archiveUtils';

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
    /** 일반 목적 플래그. bit 0 을 세우면 "암호화됨" 이 된다. */
    flags?: number;
    /** 압축 방식. 0=stored, 8=deflate. 그 외는 `yauzl` 이 지원하지 않는다. */
    method?: number;
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

    for (const { name, data, flags, method } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);       // local file header signature
        lfh.writeUInt16LE(20, 4);               // version needed to extract
        lfh.writeUInt16LE(flags ?? 0, 6);       // general purpose bit flag
        lfh.writeUInt16LE(method ?? 0, 8);      // compression method (0 = stored)
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
        cdh.writeUInt16LE(flags ?? 0, 8);       // general purpose bit flag
        cdh.writeUInt16LE(method ?? 0, 10);     // compression method (0 = stored)
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

    /**
     * 압축 해제 크기 상한 (0.6.39).
     *
     * `adm-zip` 은 엔트리를 통째로 메모리에 올려 쓰므로(`getData()`), 상한이
     * 없으면 작은 zip 하나로 확장 호스트를 OOM 으로 끌 수 있다 — zip bomb.
     * 압축 해제 크기는 중앙 디렉터리 헤더에 들어 있어 **적재 전에** 판단할 수
     * 있다. 풀어 본 뒤에 재는 방식은 이미 메모리를 쓴 뒤라 방어가 되지 않는다.
     *
     * 실제 2GB 아카이브를 만들 수는 없으므로, 크기 판정 자체는 순수 함수
     * (`assertZipWithinLimits`)에 주입한 작은 한도로 검증한다. 그 함수가
     * 추출 경로에 실제로 연결돼 있는지는 마지막 케이스가 본다.
     */
    suite('압축 해제 크기 상한', () => {
        const entry = (entryName: string, size: number, isDirectory = false) =>
            ({ entryName, isDirectory, header: { size } });

        test('기본 상한이 문서화된 값이다', () => {
            assert.strictEqual(ZIP_MAX_TOTAL_BYTES, 2 * 1024 * 1024 * 1024);
            assert.strictEqual(ZIP_MAX_ENTRY_BYTES, 512 * 1024 * 1024);
        });

        test('상한 안이면 통과한다', () => {
            assert.doesNotThrow(() =>
                assertZipWithinLimits([entry('a.bin', 100), entry('b.bin', 200)], 1000, 500));
        });

        test('엔트리 하나가 상한을 넘으면 거부한다', () => {
            assert.throws(
                () => assertZipWithinLimits([entry('huge.bin', 600)], 10000, 500),
                /huge\.bin.*per-entry limit/s
            );
        });

        test('총량이 상한을 넘으면 거부한다', () => {
            // 각각은 엔트리 상한 안이지만 합치면 넘는다 — 개수로 우회하는
            // 형태를 막는다.
            assert.throws(
                () => assertZipWithinLimits(
                    [entry('a', 400), entry('b', 400), entry('c', 400)], 1000, 500),
                /more than.*uncompressed/s
            );
        });

        test('디렉터리 엔트리는 크기에 세지 않는다', () => {
            // 디렉터리는 내용이 없으므로 헤더 size 가 비정상이어도 무시한다.
            assert.doesNotThrow(() =>
                assertZipWithinLimits([entry('d/', 999999, true), entry('a.bin', 100)], 1000, 500));
        });

        test('헤더 크기가 비정상이면 거부한다', () => {
            for (const bad of [-1, NaN, Infinity]) {
                assert.throws(
                    () => assertZipWithinLimits([entry('weird.bin', bad)], 1000, 500),
                    /Invalid uncompressed size/,
                    `size=${bad} 를 통과시켰다`
                );
            }
        });

        test('추출 경로가 실제로 이 검사를 거친다', async () => {
            // 순수 함수만 검증하면 배선이 빠져도 통과한다. 작은 한도를 줄 수
            // 없는 경로이므로, 기본 상한을 넘는 크기를 **헤더에만** 신고하는
            // 아카이브로 확인한다 — 실제 데이터를 만들지 않고도 사전 거부가
            // 동작하는지 볼 수 있고, 그 자체가 "적재 전에 막는다"의 증거다.
            const archivePath = path.join(tempDir, 'liar.zip');
            const zip = new AdmZip();
            zip.addFile('big.bin', Buffer.from('small'));
            zip.writeZip(archivePath);

            // 중앙 디렉터리의 uncompressed size 를 상한 초과로 바꾼다.
            const raw = fs.readFileSync(archivePath);
            const marker = Buffer.from('PK\x01\x02');            // central directory header
            const at = raw.indexOf(marker);
            assert.ok(at >= 0, '중앙 디렉터리를 찾지 못했다');
            raw.writeUInt32LE(0xF0000000, at + 24);              // uncompressed size 필드
            fs.writeFileSync(archivePath, raw);

            const dest = path.join(tempDir, 'liar-dest');
            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /per-entry limit|more than/,
                '추출이 크기 상한을 검사하지 않는다'
            );
            assert.ok(!fs.existsSync(dest), '거부됐는데 대상 디렉터리가 생겼다');
        });
    });

    /**
     * 대상 폴더 안의 **기존 심볼릭 링크**를 통한 경로 탈출 (0.6.46).
     *
     * 위 zip-slip 테스트들은 엔트리 *이름*이 `../` 로 벗어나는 형태를 본다.
     * 이건 다르다 — 엔트리 이름은 문자열로 완벽히 대상 안쪽인데, 대상 폴더에
     * 이미 바깥을 가리키는 링크가 있어서 파일시스템이 그 링크를 따라가는
     * 경우다. 이름만 보는 검사로는 원리적으로 잡히지 않는다.
     *
     * 0.6.45 에서 실제로 재현됐다: `dest/link -> outside` 상태에서 엔트리
     * `link/pwn.txt` 를 추출하면 예외 없이 `outside/pwn.txt` 가 만들어졌다.
     */
    suite('심볼릭 링크를 통한 경로 탈출', () => {
        /**
         * Windows 는 심볼릭 링크 생성에 개발자 모드나 관리자 권한이 필요하다.
         * 만들 수 없는 환경이면 이 시나리오 자체가 성립하지 않으므로 건너뛴다
         * — 실패로 두면 권한 문제를 회귀로 오인한다.
         */
        function trySymlink(target: string, linkPath: string): boolean {
            // Windows 는 `'dir'` 심볼릭 링크에 개발자 모드나 관리자 권한이
            // 필요하지만 **junction 은 권한 없이** 만들 수 있다. junction 으로
            // 대체해야 그쪽에서도 이 시나리오가 실제로 돌아간다 — 그냥 skip 하면
            // "Windows junction 도 막는다"는 주장이 영영 검증되지 않는다.
            const kinds: fs.symlink.Type[] = process.platform === 'win32'
                ? ['junction', 'dir']
                : ['dir'];
            for (const kind of kinds) {
                try {
                    fs.symlinkSync(target, linkPath, kind);
                    if (fs.lstatSync(linkPath).isSymbolicLink()) { return true; }
                    try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* best effort */ }
                } catch { /* 다음 종류로 */ }
            }
            return false;
        }

        test('대상 안의 링크된 디렉터리를 통해 밖으로 쓰지 못한다', async function () {
            const dest = path.join(tempDir, 'dest');
            const outside = path.join(tempDir, 'outside');
            fs.mkdirSync(dest, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            if (!trySymlink(outside, path.join(dest, 'link'))) { this.skip(); }

            // 엔트리 이름은 `../` 가 없어 문자열 검사로는 안쪽이다.
            const archivePath = writeRawZip('follow.zip', [
                { name: 'link/pwn.txt', data: Buffer.from('escaped!') },
            ]);

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /Blocked symlinked path/,
                '대상 안의 기존 심볼릭 링크를 그대로 따라갔다'
            );
            assert.ok(
                !fs.existsSync(path.join(outside, 'pwn.txt')),
                '대상 디렉터리 밖에 파일이 생겼다 — 경로 탈출'
            );
        });

        test('파일 이름 자체가 기존 링크면 그 링크를 따라 덮어쓰지 않는다', async function () {
            const dest = path.join(tempDir, 'dest-file');
            const outside = path.join(tempDir, 'outside-file');
            fs.mkdirSync(dest, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            const victim = path.join(outside, 'victim.txt');
            fs.writeFileSync(victim, 'original');
            // 디렉터리가 아니라 **파일**을 가리키는 링크.
            try {
                fs.symlinkSync(victim, path.join(dest, 'note.txt'), 'file');
                if (!fs.lstatSync(path.join(dest, 'note.txt')).isSymbolicLink()) { this.skip(); }
            } catch { this.skip(); }

            const archivePath = writeRawZip('overwrite.zip', [
                { name: 'note.txt', data: Buffer.from('overwritten!') },
            ]);

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /Blocked symlinked path/,
                '링크된 파일 이름을 그대로 따라 썼다'
            );
            assert.strictEqual(
                fs.readFileSync(victim, 'utf8'),
                'original',
                '대상 밖의 파일이 덮어써졌다'
            );
        });

        test('하드 링크된 파일 이름도 그 링크를 따라 덮어쓰지 않는다', async function () {
            // 심볼릭 링크와 **같은 공격인데 이름만으로는 구분할 수 없다** —
            // 하드 링크는 `lstat` 상 그냥 일반 파일이고, 같은 inode 를 가리키는
            // 디렉터리 항목이 둘일 뿐이다. 심볼릭 링크만 막았을 때 이 경로로
            // 그대로 뚫렸다(실측: 바깥 파일이 'PWNED' 로 덮어써짐).
            const dest = path.join(tempDir, 'dest-hard');
            const outside = path.join(tempDir, 'outside-hard');
            fs.mkdirSync(dest, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            const victim = path.join(outside, 'victim.txt');
            fs.writeFileSync(victim, 'original');
            try {
                fs.linkSync(victim, path.join(dest, 'note.txt'));
            } catch {
                this.skip();   // 하드 링크를 만들 수 없는 파일시스템
            }

            const archivePath = writeRawZip('hardlink.zip', [
                { name: 'note.txt', data: Buffer.from('PWNED') },
            ]);

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                /Blocked hard-linked path/,
                '하드 링크를 그대로 따라 썼다'
            );
            assert.strictEqual(
                fs.readFileSync(victim, 'utf8'),
                'original',
                '대상 밖의 파일이 덮어써졌다 — 자르기만 하고 거부해도 이미 늦다'
            );
        });

        test('엔트리 스트림을 열 수 없으면 기존 파일을 건드리지 않는다', async () => {
            // 링크 가드를 fd 기반으로 바꾸면서 **대상을 먼저 자르고** 나서
            // 읽기 스트림을 여는 순서가 됐었다. 그러면 암호화 엔트리처럼 스트림
            // 생성 자체가 실패하는 경우, 쓸 내용도 없이 기존 파일만 비워 놓는다
            // (실측: 16바이트 → 0바이트). 읽기 스트림을 먼저 열어야 한다.
            const dest = path.join(tempDir, 'dest-nostream');
            fs.mkdirSync(dest, { recursive: true });
            const existing = path.join(dest, 'keep.txt');
            fs.writeFileSync(existing, 'ORIGINAL CONTENT');

            // 압축 방식 9(Deflate64)는 `yauzl` 이 지원하지 않아 크기 검증을
            // 통과한 뒤 `openReadStream` 단계에서 실패한다 — 대상을 여는
            // 시점보다 **뒤**여야만 이 테스트가 의미를 갖는 지점이다.
            const archivePath = writeRawZip('nostream.zip', [
                { name: 'keep.txt', data: Buffer.from('new'), flags: 1, method: 9 },
            ]);

            await assert.rejects(extractZipArchive(archivePath, dest));
            assert.strictEqual(
                fs.readFileSync(existing, 'utf8'),
                'ORIGINAL CONTENT',
                '스트림도 못 열었는데 기존 파일이 잘렸다 — 데이터 손실'
            );
        });

        test('링크가 없는 평범한 중첩 경로는 그대로 통과한다', async () => {
            // 위 가드가 정상 추출까지 막으면 기능이 죽는다.
            const dest = path.join(tempDir, 'dest-plain');
            const archivePath = writeRawZip('plain.zip', [
                { name: 'a/b/c.txt', data: Buffer.from('ok') },
            ]);
            await extractZipArchive(archivePath, dest);
            assert.strictEqual(fs.readFileSync(path.join(dest, 'a', 'b', 'c.txt'), 'utf8'), 'ok');
        });
    });

    /**
     * 엔트리 **개수** 상한 (0.6.46).
     *
     * 크기 상한은 비압축 바이트만 세고 디렉터리는 건너뛰므로, 0바이트 파일과
     * 디렉터리는 비용 0으로 무제한 통과했다. 실측: 0바이트 엔트리 60,000개가
     * 아무 제지 없이 전부 추출됐다.
     */
    suite('엔트리 개수 상한', () => {
        test('기본 상한이 문서화된 값이다', () => {
            assert.strictEqual(ZIP_MAX_ENTRIES, 20000);
        });

        test('0바이트 엔트리라도 개수가 상한을 넘으면 거부한다', async () => {
            // 크기 총량은 0 이다 — 개수 상한이 없으면 이 아카이브는 통과한다.
            const entries = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({
                name: `f${i}.txt`,
                data: Buffer.alloc(0),
            }));
            const archivePath = writeRawZip('many.zip', entries);
            const dest = path.join(tempDir, 'many-dest');

            await assert.rejects(
                extractZipArchive(archivePath, dest),
                new RegExp(`more than ${ZIP_MAX_ENTRIES} entries`),
                '개수 상한이 없어 0바이트 엔트리가 무제한 통과한다'
            );
            assert.ok(!fs.existsSync(dest), '거부됐는데 대상 디렉터리가 생겼다');
        });

        test('상한 이하면 정상 추출한다', async () => {
            const archivePath = writeRawZip('few.zip', [
                { name: 'a.txt', data: Buffer.from('a') },
                { name: 'b.txt', data: Buffer.from('b') },
            ]);
            const dest = path.join(tempDir, 'few-dest');
            await extractZipArchive(archivePath, dest);
            assert.strictEqual(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'b');
        });
    });

    /**
     * 손상된 아카이브에서 출력 스트림이 남는 문제 (0.6.46).
     *
     * 예전에는 read 쪽 오류를 `reject` 만 하고 출력 `WriteStream` 을 닫지
     * 않아, 손상 아카이브 하나마다 파일 디스크립터가 하나씩 샜다. 실측:
     * 거부된 뒤에도 `closed:false, destroyed:false` 인 스트림이 남았다.
     */
    suite('손상된 아카이브의 스트림 정리', () => {
        test('추출이 반복 실패해도 파일 디스크립터가 쌓이지 않는다', async function () {
            // `fs.createWriteStream` 을 감싸 스트림 객체를 들여다보는 방법은 쓸 수
            // 없다 — 컴파일된 모듈 네임스페이스에서 그 속성은 getter 전용이다.
            // 대신 **결함 그 자체**(열린 fd 가 쌓이는 것)를 잰다.
            if (process.platform === 'win32') { this.skip(); }   // `/dev/fd` 없음

            // 잘 압축되는 데이터로 만든 뒤 deflate 스트림 중간을 뒤집는다.
            // 중앙 디렉터리(파일 끝)는 건드리지 않으므로 열기는 성공하고
            // 엔트리를 읽는 도중에 실패한다 — 출력 스트림이 이미 열린 시점이다.
            const archivePath = path.join(tempDir, 'corrupt.zip');
            const zip = new AdmZip();
            zip.addFile('big.bin', Buffer.alloc(200000, 0x41));
            zip.writeZip(archivePath);
            const raw = fs.readFileSync(archivePath);
            const mid = Math.floor(raw.length / 2);
            for (let i = mid; i < mid + 64; i++) { raw[i] = raw[i] ^ 0xff; }
            fs.writeFileSync(archivePath, raw);

            const openFdCount = () => fs.readdirSync('/dev/fd').length;
            const attempt = async (n: number) => {
                let rejected = false;
                try {
                    await extractZipArchive(archivePath, path.join(tempDir, `corrupt-dest-${n}`));
                } catch {
                    rejected = true;
                }
                assert.ok(rejected, '전제가 깨졌다 — 손상 아카이브가 거부되지 않았다');
            };

            // 첫 회는 지연 초기화(모듈 로드, fd 캐시 등)로 fd 가 늘 수 있으므로
            // 기준선에서 제외한다. 이후 증가분만 본다.
            await attempt(0);
            await new Promise(resolve => setTimeout(resolve, 200));
            const before = openFdCount();

            // **전제 확인**: 실패가 출력 스트림이 열린 *뒤에* 일어나야 이
            // 테스트에 의미가 있다. 손상 위치가 우연히 중앙 디렉터리로 옮겨
            // 가면 `yauzl.open` 단계에서 끝나 스트림이 아예 안 열리는데,
            // 그래도 "거부됐다"는 통과하므로 판별력이 조용히 사라진다.
            assert.ok(
                fs.existsSync(path.join(tempDir, 'corrupt-dest-0', 'big.bin')),
                '전제가 깨졌다 — 출력 파일이 만들어지기도 전에 실패했다 (손상 위치가 압축 데이터가 아니다)'
            );

            const rounds = 8;
            for (let i = 1; i <= rounds; i++) { await attempt(i); }
            await new Promise(resolve => setTimeout(resolve, 300));
            const after = openFdCount();

            // 실패 한 번에 fd 하나가 새면 증가분이 곧 `rounds` 가 된다.
            // 무관한 잡음을 감안해 넉넉히 잡아도 절반이면 충분히 갈린다.
            assert.ok(
                after - before < rounds / 2,
                `추출 실패 ${rounds}회에 열린 fd 가 ${after - before}개 늘었다 (${before} → ${after}) — 출력 스트림이 닫히지 않는다`
            );
        });
    });
});
