import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
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

    test('큰 엔트리를 풀어도 메모리가 그 크기만큼 늘지 않는다', function () {
        this.timeout(180000);
        const size = 64 * 1024 * 1024;

        // 페이로드를 **전체** 난수로 채운다. 예전에는 4096바이트마다 4바이트만
        // 흩뿌려서, 나머지 99.9% 가 0인 탓에 64MB 페이로드가 **0.18MB
        // 아카이브**로 압축됐다 — 이 테스트가 겨냥한 "압축 파일 전체 적재"
        // 비용이 아예 발생하지 않는 상태였다(주석은 난수로 채운다고 적혀
        // 있었지만 실제로는 아니었다). 전량을 채우면 아카이브도 64MB 가 된다.
        const archivePath = path.join(tempDir, 'big.zip');
        {
            const payload = Buffer.alloc(size);
            for (let off = 0; off < size; off += 65536) {
                crypto.randomFillSync(payload, off, Math.min(65536, size - off));
            }
            makeZip('big.zip', [{ name: 'big.bin', data: payload }]);
        }
        assert.ok(
            fs.statSync(archivePath).size > size * 0.9,
            '전제가 깨졌다 — 아카이브가 압축돼 버려 "압축 파일 전체 적재" 비용이 발생하지 않는다'
        );

        // **측정은 자식 프로세스에서 한다.** 같은 프로세스에서 재면 방금 만든
        // 페이로드와 adm-zip 의 압축 버퍼(합쳐 128MB)가 `external` 에 쓰레기로
        // 남아, 그것이 언제 회수되느냐가 결과를 지배한다. 실측으로 확인했다:
        // 같은 코드가 일반 node 에서는 -122MB, 확장 호스트에서는 +63MB 로
        // 나왔다 — 추출이 쓰는 양이 아니라 GC 타이밍을 잰 셈이다.
        //
        // 갓 뜬 프로세스에서 **추출만** 하면 기준선이 사실상 0이라 증가분이
        // 곧 추출이 쓴 양이다. 확장 호스트의 `process.execPath` 는 Electron
        // 이므로 `ELECTRON_RUN_AS_NODE` 로 node 처럼 띄운다.
        const probePath = path.join(tempDir, 'probe.js');
        const modulePath = path.join(__dirname, '..', 'archiveUtils.js');
        fs.writeFileSync(probePath, `
            const { extractZipArchive } = require(${JSON.stringify(modulePath)});
            const before = process.memoryUsage().external;
            let peak = before;
            const sampler = setInterval(() => {
                peak = Math.max(peak, process.memoryUsage().external);
            }, 10);
            extractZipArchive(${JSON.stringify(archivePath)}, ${JSON.stringify(path.join(tempDir, 'out'))})
                .then(() => {
                    clearInterval(sampler);
                    process.stdout.write(JSON.stringify({ peakDelta: peak - before }));
                })
                .catch(e => { clearInterval(sampler); process.stderr.write(String(e && e.message)); process.exit(1); });
        `);

        const raw = execFileSync(process.execPath, [probePath], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            encoding: 'utf8',
            timeout: 120000,
        });
        const { peakDelta } = JSON.parse(raw) as { peakDelta: number };

        assert.strictEqual(
            fs.statSync(path.join(tempDir, 'out', 'big.bin')).size,
            size,
            '내용이 온전히 풀려야 한다'
        );
        // 스트리밍이면 최대 증가분이 파일 크기와 무관한 상수다(실측 ≈5MB).
        // 옛 adm-zip 경로는 압축 파일 64MB + 엔트리 64MB 를 동시에 잡았으므로
        // 파일의 절반이라는 헐거운 기준으로도 통과할 수 없다.
        assert.ok(
            peakDelta < size / 2,
            `추출 중 external 최대 증가분이 ${(peakDelta / 1048576).toFixed(1)}MB 였다 ` +
            `(파일 ${size / 1048576}MB) — 전량이 메모리에 올라온 것으로 보인다`
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
