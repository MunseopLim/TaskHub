import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
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

    function taskHubTempFiles(dir: string): string[] {
        if (!fs.existsSync(dir)) { return []; }
        return fs.readdirSync(dir).filter(name => name.includes('.taskhub-') && name.endsWith('.tmp'));
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

        test('긴 정상 파일명도 임시 접미사 때문에 ENAMETOOLONG이 되지 않는다', async () => {
            // 220 bytes is legal on common 255-byte NAME_MAX filesystems, but
            // appending the old `.<basename>.taskhub-...tmp` suffix crossed
            // that limit for both archive creation and entry extraction.
            const sourceName = `${'s'.repeat(216)}.txt`;
            const archiveName = `${'a'.repeat(216)}.zip`;
            const source = path.join(tempDir, sourceName);
            const archivePath = path.join(tempDir, archiveName);
            const destination = path.join(tempDir, 'long-name-output');
            fs.writeFileSync(source, 'long-name-content');

            await createZipArchive(archivePath, [source]);
            await extractZipArchive(archivePath, destination);

            assert.strictEqual(
                fs.readFileSync(path.join(destination, sourceName), 'utf8'),
                'long-name-content'
            );
            assert.deepStrictEqual(taskHubTempFiles(tempDir), []);
            assert.deepStrictEqual(taskHubTempFiles(destination), []);
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

    /**
     * 생성 측 심볼릭 링크 (0.6.46).
     *
     * 추출 측은 대상 폴더 밖으로 **쓰는** 것을 막는다. 생성 측은 거울상이다 —
     * 소스 폴더 안의 링크를 따라가면 바깥 파일이 아카이브에 **담긴다**.
     * 실측: `proj/linkdir -> /secret` 상태에서 압축하면 `proj/linkdir/id_rsa`
     * 로 개인 키 내용이 그대로 들어갔다.
     *
     * 규칙은 대칭이다 — 소스 루트 **안**으로 해석되는 링크는 따라가고(프로젝트
     * 안에서 서로를 가리키는 링크는 흔하고 정상이다), 밖을 가리키면 건너뛴다.
     */
    suite('생성 측 심볼릭 링크', () => {
        function trySymlink(target: string, linkPath: string, type: fs.symlink.Type): boolean {
            try {
                fs.symlinkSync(target, linkPath, type);
                return fs.lstatSync(linkPath).isSymbolicLink();
            } catch {
                return false;
            }
        }

        test('소스 밖을 가리키는 링크는 담지 않고 호출부에 알린다', async function () {
            const outside = path.join(tempDir, 'outside');
            fs.mkdirSync(outside, { recursive: true });
            fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL');
            const secretFile = path.join(tempDir, 'passwd.txt');
            fs.writeFileSync(secretFile, 'TOP SECRET');

            const src = path.join(tempDir, 'proj');
            fs.mkdirSync(src, { recursive: true });
            fs.writeFileSync(path.join(src, 'ok.txt'), 'fine');
            if (!trySymlink(outside, path.join(src, 'linkdir'), 'dir')) { this.skip(); }
            if (!trySymlink(secretFile, path.join(src, 'linkfile.txt'), 'file')) { this.skip(); }

            const archivePath = path.join(tempDir, 'created.zip');
            const skipped: string[] = [];
            await createZipArchive(archivePath, [src], {
                onSkippedSymlink: ({ sourcePath }) => { skipped.push(path.basename(sourcePath)); },
            });

            const names = new AdmZip(archivePath).getEntries().map(e => e.entryName).sort();
            assert.deepStrictEqual(names, ['proj/ok.txt'], `링크를 따라 바깥 내용이 담겼다: ${names.join(', ')}`);
            assert.deepStrictEqual(skipped.sort(), ['linkdir', 'linkfile.txt'], '건너뛴 링크를 알리지 않았다');
        });

        test('소스 안을 가리키는 링크는 그대로 담는다', async function () {
            // 프로젝트 안에서 서로를 가리키는 링크까지 막으면 정상 사용이 깨진다.
            const src = path.join(tempDir, 'proj-inner');
            fs.mkdirSync(path.join(src, 'real'), { recursive: true });
            fs.writeFileSync(path.join(src, 'real', 'data.txt'), 'inside');
            if (!trySymlink(path.join(src, 'real'), path.join(src, 'alias'), 'dir')) { this.skip(); }

            const archivePath = path.join(tempDir, 'inner.zip');
            const skipped: string[] = [];
            await createZipArchive(archivePath, [src], {
                onSkippedSymlink: ({ sourcePath }) => { skipped.push(sourcePath); },
            });

            const names = new AdmZip(archivePath).getEntries().map(e => e.entryName).sort();
            assert.deepStrictEqual(skipped, [], '소스 안을 가리키는 링크까지 건너뛰었다');
            assert.ok(
                names.includes('proj-inner/alias/data.txt'),
                `소스 안 링크가 담기지 않았다: ${names.join(', ')}`
            );
        });
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
     * 내장 ZIP 엔진의 취소 (0.6.46).
     *
     * 예전에는 `extractZipArchive` / `createZipArchive` 가 취소 신호를 아예
     * 받지 않았다. 사용자가 Stop 을 눌러도 작업은 끝까지 돌았고, 단독이거나
     * 마지막 태스크였다면 완료 후 성공 기록이 "중지됨" 이력을 덮었다.
     *
     * `vscode` 의 토큰이 아니라 표준 `AbortSignal` 을 받는다 — 이 모듈은
     * 순수 node 에서도 require 될 수 있어야 한다.
     */
    suite('취소', () => {
        test('이미 취소된 signal 이면 추출을 시작하지 않는다', async () => {
            const archivePath = writeRawZip('cancel-pre.zip', [
                { name: 'a.txt', data: Buffer.from('a') },
            ]);
            const dest = path.join(tempDir, 'cancel-pre-out');

            await assert.rejects(
                extractZipArchive(archivePath, dest, { signal: AbortSignal.abort() }),
                (e: Error) => e.name === 'AbortError'
            );
            assert.ok(!fs.existsSync(dest), '취소됐는데 대상 디렉터리가 생겼다');
        });

        test('엔트리 목록을 읽는 중에 취소하면 아무것도 풀지 않는다', async () => {
            const entries = Array.from({ length: 2000 }, (_, i) => ({
                name: `f${String(i).padStart(4, '0')}.txt`,
                data: Buffer.alloc(4096, 0x41),
            }));
            const archivePath = writeRawZip('cancel-phase1.zip', entries);
            const dest = path.join(tempDir, 'cancel-phase1-out');

            const controller = new AbortController();
            const run = extractZipArchive(archivePath, dest, { signal: controller.signal });
            controller.abort();   // 1단계(목록 읽기) 안에서 걸린다

            await assert.rejects(run, (e: Error) => e.name === 'AbortError');
            const written = fs.existsSync(dest) ? fs.readdirSync(dest).length : 0;
            assert.strictEqual(written, 0, '1단계에서 취소했는데 파일이 만들어졌다');
        });

        test('쓰기가 시작된 뒤 취소하면 남은 엔트리를 풀지 않는다', async function () {
            this.timeout(30000);
            // **타이머로 재지 않는다.** 처음에 `setTimeout(abort, 5)` 로 짰다가
            // 실측해 보니 5ms 는 1단계(엔트리 목록 읽기)에서 걸려 쓰기 루프를
            // 전혀 지나지 않았다 — 이름과 달리 위 케이스와 같은 것을 보고
            // 있었다. 첫 파일이 실제로 생긴 것을 확인하고 취소해야 "쓰기 루프가
            // 취소를 존중하는가"를 본다.
            const total = 2000;
            const entries = Array.from({ length: total }, (_, i) => ({
                name: `f${String(i).padStart(4, '0')}.txt`,
                data: Buffer.alloc(4096, 0x41),
            }));
            const archivePath = writeRawZip('cancel-phase2.zip', entries);
            const dest = path.join(tempDir, 'cancel-phase2-out');

            const controller = new AbortController();
            const run = extractZipArchive(archivePath, dest, { signal: controller.signal });

            const deadline = Date.now() + 15000;
            let started = false;
            while (Date.now() < deadline) {
                // 임시 파일이 보인 것만으로는 현재 엔트리가 commit됐다고 할 수
                // 없다. 첫 엔트리의 최종 이름이 생긴 뒤 취소해야 앞 엔트리는
                // 유지되고 뒤 엔트리만 멈춘다는 테스트가 된다.
                if (fs.existsSync(path.join(dest, 'f0000.txt'))) { started = true; break; }
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            assert.ok(started, '전제가 깨졌다 — 쓰기가 시작되지 않았다');
            controller.abort();

            await assert.rejects(run, (e: Error) => e.name === 'AbortError');
            const written = fs.readdirSync(dest).filter(name => !name.includes('.taskhub-')).length;
            assert.ok(written > 0, '전제가 깨졌다 — 쓰기 루프를 지나지 않았다');
            assert.ok(
                written < total,
                `취소했는데 ${written}/${total} 개가 전부 풀렸다 — 쓰기 루프가 취소를 무시한다`
            );
        });

        test('이미 취소된 signal 이면 아카이브를 만들지 않는다', async () => {
            const src = path.join(tempDir, 'src.txt');
            fs.writeFileSync(src, 'x');
            const archivePath = path.join(tempDir, 'cancelled.zip');

            await assert.rejects(
                createZipArchive(archivePath, [src], { signal: AbortSignal.abort() }),
                (e: Error) => e.name === 'AbortError'
            );
            assert.ok(!fs.existsSync(archivePath), '취소됐는데 아카이브 파일이 생겼다');
        });

        test('ZIP 생성 도중 취소하면 이벤트 루프에서 즉시 중단하고 기존 아카이브를 보존한다', async function () {
            this.timeout(30000);
            const src = path.join(tempDir, 'large-source.bin');
            const sourceFd = fs.openSync(src, 'w');
            try {
                // sparse 파일이라 fixture 생성은 빠르지만, deflate는 실제 64 MB를
                // 비동기로 읽어야 한다. 예전 동기 adm-zip 경로는 이 동안 타이머와
                // Stop command를 전혀 실행하지 못했다.
                fs.ftruncateSync(sourceFd, 64 * 1024 * 1024);
            } finally {
                fs.closeSync(sourceFd);
            }
            const archivePath = path.join(tempDir, 'keep-last-good.zip');
            const lastGood = Buffer.from('LAST-GOOD-ARCHIVE-BYTES');
            fs.writeFileSync(archivePath, lastGood);

            const controller = new AbortController();
            const run = createZipArchive(archivePath, [src], { signal: controller.signal });

            const deadline = Date.now() + 15000;
            let compressionStarted = false;
            while (Date.now() < deadline) {
                const temps = taskHubTempFiles(tempDir);
                if (temps.some(name => fs.statSync(path.join(tempDir, name)).size > 64)) {
                    compressionStarted = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            assert.ok(compressionStarted, '전제가 깨졌다 — ZIP 스트리밍 쓰기가 시작되지 않았다');
            controller.abort();

            await assert.rejects(run, (e: Error) => e.name === 'AbortError');
            assert.deepStrictEqual(
                fs.readFileSync(archivePath),
                lastGood,
                '생성 중 취소가 기존 정상 아카이브를 덮었다'
            );
            assert.deepStrictEqual(taskHubTempFiles(tempDir), [], '취소된 ZIP 임시 파일이 남았다');
        });

        test('취소 시 진행 중인 fs.write가 끝나기 전에 archive fd를 닫지 않는다', async function () {
            this.timeout(10000);
            const mutableFs = require('fs') as typeof fs;
            const originalWrite = mutableFs.write;
            const originalClose = mutableFs.close;
            const src = path.join(tempDir, 'pending-write-source.bin');
            const archivePath = path.join(tempDir, 'pending-write.zip');
            fs.writeFileSync(src, randomBytes(256 * 1024));

            let archiveFd: number | undefined;
            let delayedFd: number | undefined;
            let closeBeforeRelease = false;
            let released = false;
            let releaseWrite!: () => void;
            let reportWritePending!: () => void;
            const releaseGate = new Promise<void>(resolve => { releaseWrite = resolve; });
            const writePending = new Promise<void>(resolve => { reportWritePending = resolve; });

            (mutableFs as any).write = (
                fd: number,
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null,
                callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void
            ) => {
                if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
                    archiveFd = fd;
                }
                if (fd === archiveFd && delayedFd === undefined && length >= 1024) {
                    delayedFd = fd;
                    reportWritePending();
                    void releaseGate.then(() => {
                        (originalWrite as any)(fd, buffer, offset, length, position, callback);
                    });
                    return;
                }
                (originalWrite as any)(fd, buffer, offset, length, position, callback);
            };
            (mutableFs as any).close = (fd: number, callback: (error?: NodeJS.ErrnoException | null) => void) => {
                if (fd === delayedFd && !released) { closeBeforeRelease = true; }
                originalClose.call(mutableFs, fd, callback);
            };

            const controller = new AbortController();
            const run = createZipArchive(archivePath, [src], { signal: controller.signal });
            let settled = false;
            void run.then(() => { settled = true; }, () => { settled = true; });
            try {
                await writePending;
                controller.abort();
                await new Promise<void>(resolve => setImmediate(resolve));
                await new Promise<void>(resolve => setImmediate(resolve));

                assert.strictEqual(settled, false, 'pipeline이 pending fs.write보다 먼저 종료됐다');
                assert.strictEqual(closeBeforeRelease, false, 'pending fs.write가 archive fd close와 겹쳤다');

                released = true;
                releaseWrite();
                await assert.rejects(run, (error: Error) => error.name === 'AbortError');
                assert.deepStrictEqual(taskHubTempFiles(tempDir), [], '취소된 ZIP 임시 파일이 남았다');
            } finally {
                released = true;
                releaseWrite();
                (mutableFs as any).write = originalWrite;
                (mutableFs as any).close = originalClose;
            }
        });

        test('큰 엔트리 추출 도중 취소해도 기존 파일을 보존하고 임시 파일을 지운다', async function () {
            this.timeout(30000);
            const archivePath = path.join(tempDir, 'cancel-large-entry.zip');
            const zip = new AdmZip();
            zip.addFile('keep.bin', Buffer.alloc(32 * 1024 * 1024, 0x41));
            zip.writeZip(archivePath);

            const dest = path.join(tempDir, 'cancel-large-entry-out');
            fs.mkdirSync(dest, { recursive: true });
            const existing = path.join(dest, 'keep.bin');
            const original = Buffer.from('ORIGINAL-CONTENT-MUST-STAY');
            fs.writeFileSync(existing, original);

            const controller = new AbortController();
            const run = extractZipArchive(archivePath, dest, { signal: controller.signal });

            const deadline = Date.now() + 15000;
            let entryWriteStarted = false;
            while (Date.now() < deadline) {
                const temps = taskHubTempFiles(dest);
                if (temps.some(name => fs.statSync(path.join(dest, name)).size > 0)) {
                    entryWriteStarted = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            assert.ok(entryWriteStarted, '전제가 깨졌다 — 엔트리 임시 파일 쓰기가 시작되지 않았다');
            controller.abort();

            await assert.rejects(run, (e: Error) => e.name === 'AbortError');
            assert.deepStrictEqual(
                fs.readFileSync(existing),
                original,
                '추출 중 취소가 기존 엔트리를 0바이트/부분 데이터로 바꿨다'
            );
            assert.deepStrictEqual(taskHubTempFiles(dest), [], '취소된 엔트리 임시 파일이 남았다');
        });

        test('signal 을 주지 않으면 예전처럼 동작한다', async () => {
            // 취소를 넣으면서 기존 호출부(외부 tool 경로 등)를 깨면 안 된다.
            const archivePath = writeRawZip('nosignal.zip', [
                { name: 'a.txt', data: Buffer.from('ok') },
            ]);
            const dest = path.join(tempDir, 'nosignal-out');
            await extractZipArchive(archivePath, dest);
            assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'ok');
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
        function createCorruptedArchive(fileName: string): string {
            // 잘 압축되는 데이터로 만든 뒤 deflate 스트림 중간을 뒤집는다.
            // 중앙 디렉터리(파일 끝)는 건드리지 않으므로 열기는 성공하고
            // 엔트리를 읽는 도중에 실패한다 — 출력 스트림이 이미 열린 시점이다.
            const archivePath = path.join(tempDir, fileName);
            const zip = new AdmZip();
            zip.addFile('big.bin', Buffer.alloc(200000, 0x41));
            zip.writeZip(archivePath);
            const raw = fs.readFileSync(archivePath);
            const mid = Math.floor(raw.length / 2);
            for (let i = mid; i < mid + 64; i++) { raw[i] = raw[i] ^ 0xff; }
            fs.writeFileSync(archivePath, raw);
            return archivePath;
        }

        test('엔트리 스트림이 손상돼도 기존 파일을 byte-for-byte 보존하고 임시 파일을 지운다', async () => {
            const archivePath = createCorruptedArchive('corrupt-preserve.zip');
            const dest = path.join(tempDir, 'corrupt-preserve-out');
            fs.mkdirSync(dest, { recursive: true });
            const existing = path.join(dest, 'big.bin');
            const original = Buffer.from('ORIGINAL-CONTENT-MUST-STAY');
            fs.writeFileSync(existing, original);

            await assert.rejects(extractZipArchive(archivePath, dest));

            assert.deepStrictEqual(
                fs.readFileSync(existing),
                original,
                '스트림 오류가 기존 엔트리를 0바이트/부분 데이터로 바꿨다'
            );
            assert.deepStrictEqual(taskHubTempFiles(dest), [], '실패한 엔트리 임시 파일이 남았다');
        });

        test('크기는 맞지만 CRC가 틀린 엔트리도 commit하지 않는다', async () => {
            const archivePath = writeRawZip('bad-crc.zip', [
                { name: 'keep.bin', data: Buffer.from('COMPLETE-BUT-BAD-CRC') },
            ]);
            const raw = fs.readFileSync(archivePath);
            const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
            const centralOffset = raw.indexOf(centralSignature);
            assert.ok(centralOffset >= 0, '전제가 깨졌다 — central directory가 없다');
            const advertisedCrc = raw.readUInt32LE(centralOffset + 16);
            raw.writeUInt32LE((advertisedCrc ^ 0xffffffff) >>> 0, centralOffset + 16);
            fs.writeFileSync(archivePath, raw);

            const dest = path.join(tempDir, 'bad-crc-out');
            fs.mkdirSync(dest, { recursive: true });
            const existing = path.join(dest, 'keep.bin');
            const original = Buffer.from('ORIGINAL-CONTENT-MUST-STAY');
            fs.writeFileSync(existing, original);

            await assert.rejects(extractZipArchive(archivePath, dest), /CRC mismatch/);
            assert.deepStrictEqual(fs.readFileSync(existing), original);
            assert.deepStrictEqual(taskHubTempFiles(dest), []);
        });

        test('추출이 반복 실패해도 파일 디스크립터가 쌓이지 않는다', async function () {
            // `fs.createWriteStream` 을 감싸 스트림 객체를 들여다보는 방법은 쓸 수
            // 없다 — 컴파일된 모듈 네임스페이스에서 그 속성은 getter 전용이다.
            // 대신 **결함 그 자체**(열린 fd 가 쌓이는 것)를 잰다.
            if (process.platform === 'win32') { this.skip(); }   // `/dev/fd` 없음

            const archivePath = createCorruptedArchive('corrupt.zip');

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

            // 단계 2에 진입했으므로 대상 디렉터리는 생겼지만, 실패한 엔트리의
            // 최종 이름과 임시 파일은 commit/잔류하면 안 된다.
            assert.ok(
                fs.existsSync(path.join(tempDir, 'corrupt-dest-0')),
                '전제가 깨졌다 — 스트리밍 추출 단계에 진입하기 전에 실패했다'
            );
            assert.ok(!fs.existsSync(path.join(tempDir, 'corrupt-dest-0', 'big.bin')));
            assert.deepStrictEqual(taskHubTempFiles(path.join(tempDir, 'corrupt-dest-0')), []);

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
