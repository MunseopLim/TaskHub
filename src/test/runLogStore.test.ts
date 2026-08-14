import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ActionRunLog,
    ActionRunLogCollector,
    RunLogStore,
    serializeActionRunLog,
} from '../runLogStore';

suite('Action run log storage', () => {
    let workspaceRoot: string;

    setup(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-run-logs-'));
    });

    teardown(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    function sampleLog(startedAt = Date.parse('2026-08-14T00:00:00.000Z')): ActionRunLog {
        const collector = new ActionRunLogCollector('build/firmware', 'Build Firmware', startedAt, [
            { id: 'build', type: 'command' },
            { id: 'flash', type: 'shell' },
        ]);
        collector.startTask('build', startedAt + 10);
        collector.recordCommand('build', 'node build.js', workspaceRoot, 'captured');
        collector.finishTask('build', {
            status: 'success',
            finishedAt: startedAt + 20,
            output: { availability: 'captured', stdout: 'ok\n', stderr: '' },
        });
        collector.startTask('flash', startedAt + 21);
        collector.recordCommand('flash', 'flash ***', workspaceRoot, 'redacted');
        collector.finishTask('flash', {
            status: 'failure',
            finishedAt: startedAt + 30,
            error: 'details hidden',
            output: { availability: 'redacted' },
        });
        return collector.finish('failure', startedAt + 31, 'flash failed');
    }

    test('수집기는 태스크 상태·시간·마스킹된 명령과 출력 가용성을 구조화한다', () => {
        const log = sampleLog();

        assert.strictEqual(log.outcome, 'failure');
        assert.strictEqual(log.tasks[0].durationMs, 10);
        assert.strictEqual(log.tasks[0].output.stdout, 'ok\n');
        assert.strictEqual(log.tasks[1].command, 'flash ***');
        assert.strictEqual(log.tasks[1].output.availability, 'redacted');
        assert.strictEqual(log.tasks[1].output.stdout, undefined);
        assert.strictEqual(log.tasks[1].output.stderr, undefined);
    });

    test('파일 상한을 넘는 stdout/stderr는 완전한 로그처럼 보이지 않게 표시한다', () => {
        const log = sampleLog();
        log.tasks[0].output.stdout = '가'.repeat(10_000);
        log.tasks[0].output.stderr = 'e'.repeat(10_000);

        const encoded = serializeActionRunLog(log, 2_048);
        const parsed = JSON.parse(encoded) as ActionRunLog;

        assert.ok(Buffer.byteLength(encoded, 'utf8') <= 2_048);
        assert.strictEqual(parsed.truncated, true);
        assert.strictEqual(parsed.tasks[0].output.truncated, true);
        assert.ok((parsed.tasks[0].output.originalBytes ?? 0) > 20_000);
    });

    test('워크스페이스 내부에 원자적으로 쓰고 logs 전용 .gitignore를 만든다', async () => {
        let nonce = 0;
        const store = new RunLogStore(workspaceRoot, () => Date.now(), () => `n${++nonce}`);
        const result = await store.write(sampleLog(), {
            maxFiles: 10,
            retentionDays: 30,
            maxTotalBytes: 10 * 1024 * 1024,
        });

        assert.ok(result.workspaceRelativePath.startsWith('.taskhub/logs/'));
        assert.ok(fs.existsSync(result.absolutePath));
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(result.absolutePath, 'utf8')).version, 1);
        assert.strictEqual(
            fs.readFileSync(path.join(workspaceRoot, '.taskhub', 'logs', '.gitignore'), 'utf8'),
            '# TaskHub generated run logs\n*\n!.gitignore\n'
        );
        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(result.absolutePath)).filter(name => name.includes('.tmp-')),
            []
        );
    });

    test('회전은 워크스페이스 전체에서 가장 오래된 로그부터 개수 상한을 맞춘다', async () => {
        let nonce = 0;
        const store = new RunLogStore(workspaceRoot, () => Date.now(), () => `n${++nonce}`);
        const policy = { maxFiles: 2, retentionDays: 0, maxTotalBytes: 10 * 1024 * 1024 };
        await store.write(sampleLog(Date.parse('2026-08-14T00:00:00.000Z')), policy);
        await store.write(sampleLog(Date.parse('2026-08-14T00:00:01.000Z')), policy);
        await store.write(sampleLog(Date.parse('2026-08-14T00:00:02.000Z')), policy);

        const actionDirs = fs.readdirSync(path.join(workspaceRoot, '.taskhub', 'logs'))
            .filter(name => name !== '.gitignore');
        const logs = actionDirs.flatMap(dir =>
            fs.readdirSync(path.join(workspaceRoot, '.taskhub', 'logs', dir)).filter(name => name.endsWith('.log'))
        );
        assert.strictEqual(logs.length, 2);
    });

    test('기간 회전은 새로 쓴 로그는 남기고 만료된 이전 로그를 지운다', async () => {
        let nonce = 0;
        const now = Date.parse('2026-08-14T12:00:00.000Z');
        const store = new RunLogStore(workspaceRoot, () => now, () => `n${++nonce}`);
        const policy = { maxFiles: 10, retentionDays: 7, maxTotalBytes: 10 * 1024 * 1024 };
        const old = await store.write(sampleLog(now - 14 * 24 * 60 * 60 * 1000), policy);
        const oldTime = new Date(now - 14 * 24 * 60 * 60 * 1000);
        fs.utimesSync(old.absolutePath, oldTime, oldTime);

        const newest = await store.write(sampleLog(now), policy);

        assert.ok(!fs.existsSync(old.absolutePath));
        assert.ok(fs.existsSync(newest.absolutePath));
    });

    test('총 용량 회전은 새로 쓴 로그를 보존하며 오래된 파일부터 지운다', async () => {
        let nonce = 0;
        const store = new RunLogStore(workspaceRoot, () => Date.now(), () => `n${++nonce}`);
        const generous = { maxFiles: 10, retentionDays: 0, maxTotalBytes: 10 * 1024 * 1024 };
        const old = await store.write(sampleLog(), generous);
        const oneFileBytes = fs.statSync(old.absolutePath).size;

        const newest = await store.write(sampleLog(Date.parse('2026-08-14T00:00:01.000Z')), {
            ...generous,
            maxTotalBytes: oneFileBytes + 16,
        });

        assert.ok(!fs.existsSync(old.absolutePath));
        assert.ok(fs.existsSync(newest.absolutePath));
    });

    test('고정 로그 경로의 상위 디렉터리가 symlink면 워크스페이스 밖 쓰기를 거부한다', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-run-logs-outside-'));
        try {
            fs.symlinkSync(outside, path.join(workspaceRoot, '.taskhub'));
            const store = new RunLogStore(workspaceRoot);
            await assert.rejects(
                store.write(sampleLog(), { maxFiles: 10, retentionDays: 30, maxTotalBytes: 1024 * 1024 }),
                /not a real directory/
            );
            assert.deepStrictEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
