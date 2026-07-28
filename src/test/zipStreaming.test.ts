import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractZipArchive } from '../archiveUtils';

/**
 * ZIP 스트리밍 추출 (0.6.45).
 *
 * 이전에는 `adm-zip` 으로 풀었는데 그 라이브러리는 두 곳에서 전량을 메모리에
 * 올린다:
 *
 *   1. `new AdmZip(path)` 가 **압축 파일 전체**를 `readFileSync` 로 읽는다.
 *   2. `getData()` 가 엔트리 하나를 통째로 푼다. `extractEntryTo()` 도 내부에서
 *      `getData()` 를 부르므로 스트리밍이 아니다 — 소스를 확인했다.
 *
 * 그래서 peak 가 "압축 파일 + 엔트리 하나" 였고, 0.6.39 의 크기 상한(총 2GB /
 * 엔트리 512MB)을 둬도 **그 상한만큼 메모리를 쓸 수 있었다** — 상한이 디스크
 * 기준이지 메모리 기준이 아니었다.
 *
 * `yauzl` 은 파일을 fd 로 읽고 엔트리를 read stream 으로 주므로 peak 가 파일
 * 크기와 무관한 상수가 된다. 생성(`createZipArchive`)은 그대로 `adm-zip` 을
 * 쓴다 — `yauzl` 은 읽기 전용이고, 쓰기까지 바꾸면 교체 범위가 필요 이상으로
 * 커진다.
 */
suite('ZIP 스트리밍 추출', () => {

    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-zipstream-'));
    });

    teardown(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    /** 지정한 엔트리들을 담은 zip 을 만든다. */
    function makeZip(name: string, entries: { name: string; data: Buffer }[]): string {
        const zip = new AdmZip();
        for (const e of entries) { zip.addFile(e.name, e.data); }
        const p = path.join(tempDir, name);
        zip.writeZip(p);
        return p;
    }

    test('큰 엔트리를 풀어도 메모리가 그 크기만큼 늘지 않는다', async function () {
        this.timeout(120000);
        // 64MB 짜리 엔트리. 예전 경로는 압축 파일(≈64MB) + 엔트리 버퍼(64MB)
        // 를 동시에 잡았다.
        const size = 64 * 1024 * 1024;
        const payload = Buffer.alloc(size);
        // 압축이 되지 않도록 난수로 채운다 — 0으로 두면 거의 무한 압축돼
        // "압축 파일 전체 적재" 비용이 드러나지 않는다.
        for (let i = 0; i < size; i += 4096) {
            payload.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, i);
        }
        const archivePath = makeZip('big.zip', [{ name: 'big.bin', data: payload }]);
        const dest = path.join(tempDir, 'out');

        // **`external` 을 잰다.** Node `Buffer` 는 V8 힙 밖에 잡히므로
        // `heapUsed` 로는 보이지 않는다 — 처음에 heapUsed 로 짰다가 옛
        // adm-zip 경로도 0.3MB 로 통과하는 것을 보고 알아챘다. 실측하면
        // 옛 경로 external +128MB, 새 경로 +0.2MB 로 갈린다.
        const before = process.memoryUsage().external;

        await extractZipArchive(archivePath, dest);

        const grew = process.memoryUsage().external - before;

        assert.strictEqual(fs.statSync(path.join(dest, 'big.bin')).size, size, '내용이 온전히 풀려야 한다');
        // 스트리밍이면 증가분이 파일 크기와 무관하게 작다. 여유를 크게 잡아도
        // (파일의 절반) 예전 경로는 통과할 수 없다 — 최소 2배가 잡혔다.
        assert.ok(
            grew < size / 2,
            `external 이 ${(grew / 1024 / 1024).toFixed(1)}MB 늘었다 (파일 ${size / 1024 / 1024}MB) — 전량이 메모리에 올라온 것으로 보인다`
        );
    });

    test('여러 엔트리를 순서대로 정확히 푼다', async () => {
        const archivePath = makeZip('multi.zip', [
            { name: 'a.txt', data: Buffer.from('first') },
            { name: 'nested/b.txt', data: Buffer.from('second') },
            { name: 'nested/deep/c.bin', data: Buffer.from([0, 1, 2, 3]) },
        ]);
        const dest = path.join(tempDir, 'multi-out');

        await extractZipArchive(archivePath, dest);

        assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'first');
        assert.strictEqual(fs.readFileSync(path.join(dest, 'nested', 'b.txt'), 'utf8'), 'second');
        assert.deepStrictEqual(
            Array.from(fs.readFileSync(path.join(dest, 'nested', 'deep', 'c.bin'))),
            [0, 1, 2, 3]
        );
    });

    test('빈 파일도 정확히 복원된다', async () => {
        const archivePath = makeZip('empty.zip', [{ name: 'zero.bin', data: Buffer.alloc(0) }]);
        const dest = path.join(tempDir, 'empty-out');

        await extractZipArchive(archivePath, dest);

        assert.strictEqual(fs.statSync(path.join(dest, 'zero.bin')).size, 0);
    });

    test('추출 후 아카이브 파일을 지울 수 있다 (fd 를 닫는다)', async () => {
        // `autoClose: false` 로 열므로 직접 닫아야 한다. 안 닫으면 Windows 에서
        // 파일이 잠긴 채 남아 후속 정리가 실패한다.
        const archivePath = makeZip('lock.zip', [{ name: 'x.txt', data: Buffer.from('x') }]);
        const dest = path.join(tempDir, 'lock-out');

        await extractZipArchive(archivePath, dest);

        assert.doesNotThrow(() => fs.unlinkSync(archivePath), '아카이브 fd 가 열린 채 남아 있다');
    });

    test('손상된 아카이브는 명확히 실패한다', async () => {
        const bad = path.join(tempDir, 'broken.zip');
        fs.writeFileSync(bad, Buffer.from('not a zip at all'));

        await assert.rejects(
            extractZipArchive(bad, path.join(tempDir, 'broken-out')),
            /end of central directory|Failed to open archive|signature/i
        );
    });
});
