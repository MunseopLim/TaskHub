import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import lockfile from 'proper-lockfile';
import { UpdateInstallState, withUpdateInstallLock } from '../updateLock';

suite('Update installation lock', () => {
    let temporaryDirectory: string;
    let storageDirectory: string;
    const originalLock = lockfile.lock;

    setup(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskhub-update-lock-'));
        storageDirectory = path.join(temporaryDirectory, '한글 storage', 'updates');
    });

    teardown(async () => {
        lockfile.lock = originalLock;
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    test('동시 호출은 대기 없이 제외하고 해제 후 다음 설치를 허용한다', async () => {
        let unblock!: () => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const blocked = new Promise<void>(resolve => { unblock = resolve; });
        const first = withUpdateInstallLock(storageDirectory, async () => {
            entered();
            await blocked;
            return 'installed';
        });
        try {
            await started;
            const second = await withUpdateInstallLock(storageDirectory, async () => {
                assert.fail('잠금 중인 설치와 동시에 실행되면 안 된다');
            });
            assert.deepStrictEqual(second, { acquired: false });
        } finally {
            unblock();
            await first;
        }
        assert.deepStrictEqual(await first, { acquired: true, value: 'installed' });
        assert.deepStrictEqual(
            await withUpdateInstallLock(storageDirectory, async () => 'next'),
            { acquired: true, value: 'next' }
        );
    });

    test('설치 실패를 전달하고 잠금을 남기지 않는다', async () => {
        const failure = new Error('download failed');
        await assert.rejects(
            withUpdateInstallLock(storageDirectory, async () => { throw failure; }),
            error => error === failure
        );
        assert.deepStrictEqual(await fs.readdir(storageDirectory), []);
        assert.deepStrictEqual(
            await withUpdateInstallLock(storageDirectory, async state => state.installedVersion),
            { acquired: true, value: undefined }
        );
    });

    test('별도 프로세스에서도 동시 설치를 차단하고 성공 표식을 공유한다', async function () {
        this.timeout(30_000);
        const runOtherProcess = async (): Promise<unknown> => {
            const script = `
                const { withUpdateInstallLock } = require(process.argv[1]);
                withUpdateInstallLock(process.argv[2], async state => state.installedVersion)
                    .then(result => process.stdout.write(JSON.stringify(result)))
                    .catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
            `;
            const result = await promisify(execFile)(process.execPath, [
                '-e', script, path.join(__dirname, '..', 'updateLock.js'), storageDirectory,
            ], {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                timeout: 10_000,
                maxBuffer: 1024 * 1024,
            });
            return JSON.parse(result.stdout);
        };
        await withUpdateInstallLock(storageDirectory, async state => {
            await state.markInstalled('1.2.3');
            assert.deepStrictEqual(await runOtherProcess(), { acquired: false });
        });
        assert.deepStrictEqual(await runOtherProcess(), { acquired: true, value: '1.2.3' });
    });

    test('비정상 종료로 남은 만료된 잠금을 회수한다', async () => {
        const lockDirectory = path.join(storageDirectory, 'install.lock');
        await fs.mkdir(lockDirectory, { recursive: true });
        const old = new Date(Date.now() - 300_000);
        await fs.utimes(lockDirectory, old, old);
        assert.deepStrictEqual(
            await withUpdateInstallLock(storageDirectory, async () => 'recovered'),
            { acquired: true, value: 'recovered' }
        );
        assert.deepStrictEqual(await fs.readdir(storageDirectory), []);
    });

    test('성공한 버전을 공유하고 다음 성공 버전으로 원자적으로 교체한다', async () => {
        await withUpdateInstallLock(storageDirectory, async state => {
            assert.strictEqual(state.installedVersion, undefined);
            assert.strictEqual(state.signal.aborted, false);
            await state.markInstalled('1.2.3');
            assert.strictEqual(state.installedVersion, '1.2.3');
        });
        await withUpdateInstallLock(storageDirectory, async state => {
            assert.strictEqual(state.installedVersion, '1.2.3');
            await state.markInstalled('1.2.4');
        });
        assert.deepStrictEqual(
            await withUpdateInstallLock(storageDirectory, async state => state.installedVersion),
            { acquired: true, value: '1.2.4' }
        );
        assert.deepStrictEqual(await fs.readdir(storageDirectory), ['installed.json']);
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(storageDirectory, 'installed.json'), 'utf8')), '1.2.4');
    });

    test('부분 기록·잘못된 타입·유효하지 않은 버전·초과 크기 표식을 무시한다', async () => {
        await fs.mkdir(storageDirectory, { recursive: true });
        const markerPath = path.join(storageDirectory, 'installed.json');
        const invalidMarkers = ['"1.2.', '{"version":"1.2.3"}', 'null', '123', '"bad"', ' '.repeat(4097) + '"1.2.3"'];
        for (const marker of invalidMarkers) {
            await fs.writeFile(markerPath, marker);
            await withUpdateInstallLock(storageDirectory, async state => {
                assert.strictEqual(state.installedVersion, undefined, marker.slice(0, 50));
                await state.markInstalled('1.2.3');
            });
            assert.strictEqual(JSON.parse(await fs.readFile(markerPath, 'utf8')), '1.2.3');
        }
    });

    test('유효하지 않은 새 표식과 잠금 밖에서 호출한 표식 저장을 거부한다', async () => {
        let releasedState!: UpdateInstallState;
        await withUpdateInstallLock(storageDirectory, async state => {
            releasedState = state;
            await state.markInstalled('1.2.3');
            await assert.rejects(state.markInstalled('invalid'), /Invalid installed extension version/);
        });
        await assert.rejects(releasedState.markInstalled('1.2.4'), /lock has been released/);
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(storageDirectory, 'installed.json'), 'utf8')), '1.2.3');
    });

    test('잠금 획득의 일반 오류를 busy로 숨기지 않는다', async () => {
        await fs.mkdir(path.dirname(storageDirectory), { recursive: true });
        await fs.writeFile(storageDirectory, 'not a directory');
        await assert.rejects(withUpdateInstallLock(storageDirectory, async () => undefined));
    });

    test('표식 교체 실패도 잠금과 임시 파일을 정리한다', async () => {
        await fs.mkdir(path.join(storageDirectory, 'installed.json'), { recursive: true });
        await assert.rejects(withUpdateInstallLock(storageDirectory, async state => {
            await state.markInstalled('1.2.3');
        }));
        assert.deepStrictEqual(await fs.readdir(storageDirectory), ['installed.json']);
    });

    test('임대가 손상되면 취소 신호를 보내고 표식과 성공 결과를 거부한다', async () => {
        const compromise = Object.assign(new Error('lock compromised'), { code: 'ECOMPROMISED' });
        let compromiseLock!: () => void;
        let released = false;
        lockfile.lock = async (_file, options) => {
            compromiseLock = () => options!.onCompromised!(compromise);
            return async () => { released = true; };
        };
        await assert.rejects(withUpdateInstallLock(storageDirectory, async state => {
            compromiseLock();
            assert.strictEqual(state.signal.aborted, true);
            assert.strictEqual(state.signal.reason, compromise);
            await assert.rejects(state.markInstalled('1.2.3'), error => error === compromise);
            return 'must not succeed';
        }), error => error === compromise);
        assert.strictEqual(released, true);
        assert.deepStrictEqual(await fs.readdir(storageDirectory), []);
    });
});
