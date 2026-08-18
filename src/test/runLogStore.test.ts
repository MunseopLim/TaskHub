import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ActionRunLog,
    ActionRunLogCollector,
    readActionRunLog,
    RunLogReadError,
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
        collector.recordDiagnostics('build', { error: 1, warning: 2, info: 0, hint: 0 });
        collector.recordArtifact('build', path.join(workspaceRoot, 'build', 'firmware.elf'));
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
        assert.deepStrictEqual(log.tasks[0].diagnostics, { error: 1, warning: 2, info: 0, hint: 0 });
        assert.deepStrictEqual(log.tasks[0].artifacts, [path.join(workspaceRoot, 'build', 'firmware.elf')]);
    });

    test('같은 태스크의 반복 명령은 실행 보고서에 순서대로 모두 남긴다', () => {
        const collector = new ActionRunLogCollector('foreach', 'For each', 1, [
            { id: 'inspect', type: 'command' },
        ]);
        collector.startTask('inspect', 2);
        collector.recordCommand('inspect', 'tool "one.bin"', workspaceRoot, 'captured');
        collector.recordCommand('inspect', 'tool "two space.bin"', workspaceRoot, 'captured');
        collector.finishTask('inspect', { status: 'success', finishedAt: 3 });
        const log = collector.finish('success', 4);
        assert.strictEqual(log.tasks[0].command, 'tool "one.bin"\ntool "two space.bin"');
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

        const readBack = await readActionRunLog(workspaceRoot, result.workspaceRelativePath);
        assert.strictEqual(readBack.actionId, 'build/firmware');
        assert.strictEqual(readBack.tasks[0].diagnostics?.warning, 2);
    });

    test('회전·수동 삭제로 사라진 History 참조는 missing으로 구분한다', async () => {
        await assert.rejects(
            readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/missing.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'missing'
        );
    });

    test('History의 조작된 상대 경로는 워크스페이스 파일을 읽기 전에 거부한다', async () => {
        fs.writeFileSync(path.join(workspaceRoot, 'outside.log'), JSON.stringify(sampleLog()));
        for (const relativePath of [
            '../outside.log',
            '.taskhub/logs/../../outside.log',
            '.taskhub\\logs\\action\\run.log',
            '/tmp/outside.log',
        ]) {
            await assert.rejects(
                readActionRunLog(workspaceRoot, relativePath),
                (error: unknown) => error instanceof RunLogReadError && error.code === 'unsafe-path',
                relativePath
            );
        }
    });

    test('손상된 JSON과 지원하지 않는 로그 버전을 invalid로 구분한다', async () => {
        const actionDir = path.join(workspaceRoot, '.taskhub', 'logs', 'action-deadbeef');
        fs.mkdirSync(actionDir, { recursive: true });
        const invalidJson = path.join(actionDir, 'invalid.log');
        fs.writeFileSync(invalidJson, '{');
        await assert.rejects(
            readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/invalid.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'invalid'
        );

        fs.writeFileSync(invalidJson, JSON.stringify({ ...sampleLog(), version: 2 }));
        await assert.rejects(
            readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/invalid.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'invalid'
        );
    });

    test('구조가 깨진 태스크 레코드는 UI에 닿기 전에 거부한다', async () => {
        const actionDir = path.join(workspaceRoot, '.taskhub', 'logs', 'action-deadbeef');
        fs.mkdirSync(actionDir, { recursive: true });
        const target = path.join(actionDir, 'invalid.log');
        const broken: Array<Record<string, unknown>> = [
            { status: 'bogus' },
            { index: 0 },
            { index: 1.5 },
            { taskId: 42 },
            { exitCode: 'one' },
            { errorCode: 'made-up' },
            { diagnostics: { error: -1, warning: 0, info: 0, hint: 0 } },
            { diagnostics: { error: 1 } },
            { diagnostics: { error: 1.5, warning: 0, info: 0, hint: 0 } },
            { artifacts: [1] },
            { artifacts: 'one.elf' },
            { output: { availability: 'made-up' } },
            { output: { availability: 'captured', originalBytes: -1 } },
        ];
        for (const patch of broken) {
            const log = JSON.parse(JSON.stringify(sampleLog())) as Record<string, any>;
            log.tasks[0] = { ...log.tasks[0], ...patch };
            fs.writeFileSync(target, JSON.stringify(log));
            await assert.rejects(
                readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/invalid.log'),
                (error: unknown) => error instanceof RunLogReadError && error.code === 'invalid',
                JSON.stringify(patch)
            );
        }
    });

    test('액션 수준 errorCode도 화이트리스트로 좁힌다', async () => {
        const actionDir = path.join(workspaceRoot, '.taskhub', 'logs', 'action-deadbeef');
        fs.mkdirSync(actionDir, { recursive: true });
        const target = path.join(actionDir, 'code.log');

        fs.writeFileSync(target, JSON.stringify({ ...sampleLog(), errorCode: 'made-up' }));
        await assert.rejects(
            readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/code.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'invalid'
        );

        fs.writeFileSync(target, JSON.stringify({ ...sampleLog(), errorCode: 'stopped-by-user' }));
        const parsed = await readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/code.log');
        assert.strictEqual(parsed.errorCode, 'stopped-by-user');
    });

    test('중지·비밀 실패 사유는 문장이 아니라 코드로 저장한다', () => {
        const collector = new ActionRunLogCollector('a', 'A', 1, [{ id: 'one', type: 'command' }]);
        collector.startTask('one', 2);
        collector.finishTask('one', {
            status: 'failure',
            finishedAt: 3,
            error: "Task 'one' details hidden because it used a password input.",
            errorCode: 'sensitive-hidden',
        });
        const log = collector.finish('stopped', 4, 'Action stopped by the user.', 'stopped-by-user');

        assert.strictEqual(log.errorCode, 'stopped-by-user');
        assert.strictEqual(log.tasks[0].errorCode, 'sensitive-hidden');
        // 원문은 로그 파일을 직접 여는 사람을 위해 남긴다.
        assert.strictEqual(log.error, 'Action stopped by the user.');
    });

    test('관리 디렉터리 밖을 가리키는 상대 경로 형태를 모두 거부한다', async () => {
        for (const relativePath of [
            '',
            'taskhub/logs/action/run.log',
            '.taskhub/logs/action/run.txt',
            '.taskhub/logs/action/nested/run.log',
            '.taskhub/logs/run.log',
            '.taskhub/logs/action/',
            './.taskhub/logs/action/run.log',
        ]) {
            await assert.rejects(
                readActionRunLog(workspaceRoot, relativePath),
                (error: unknown) => error instanceof RunLogReadError && error.code === 'unsafe-path',
                relativePath
            );
        }
    });

    test('로그 파일 자리가 symlink거나 디렉터리면 열지 않는다', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const actionDir = path.join(workspaceRoot, '.taskhub', 'logs', 'action-deadbeef');
        fs.mkdirSync(actionDir, { recursive: true });
        const outside = path.join(workspaceRoot, 'secret.json');
        fs.writeFileSync(outside, JSON.stringify(sampleLog()));
        fs.symlinkSync(outside, path.join(actionDir, 'link.log'));
        fs.mkdirSync(path.join(actionDir, 'dir.log'));

        for (const name of ['link.log', 'dir.log']) {
            await assert.rejects(
                readActionRunLog(workspaceRoot, `.taskhub/logs/action-deadbeef/${name}`),
                (error: unknown) => error instanceof RunLogReadError && error.code === 'unsafe-path',
                name
            );
        }
    });

    test('워크스페이스 루트가 사라진 경우와 로그 회전을 구분한다', async () => {
        const missingRoot = path.join(workspaceRoot, 'gone');
        await assert.rejects(
            readActionRunLog(missingRoot, '.taskhub/logs/action-deadbeef/run.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'workspace-missing'
        );
    });

    test('읽기 상한보다 큰 파일은 JSON 파싱 전에 거부한다', async () => {
        const actionDir = path.join(workspaceRoot, '.taskhub', 'logs', 'action-deadbeef');
        fs.mkdirSync(actionDir, { recursive: true });
        const oversized = path.join(actionDir, 'oversized.log');
        fs.writeFileSync(oversized, 'x');
        fs.truncateSync(oversized, 8 * 1024 * 1024 + 1);
        await assert.rejects(
            readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/oversized.log'),
            (error: unknown) => error instanceof RunLogReadError && error.code === 'too-large'
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

    test('읽기 참조의 중간 디렉터리가 symlink면 워크스페이스 밖 파일을 열지 않는다', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-run-report-outside-'));
        try {
            const outsideAction = path.join(outside, 'action-deadbeef');
            fs.mkdirSync(outsideAction);
            fs.writeFileSync(path.join(outsideAction, 'run.log'), JSON.stringify(sampleLog()));
            fs.mkdirSync(path.join(workspaceRoot, '.taskhub'));
            fs.symlinkSync(outside, path.join(workspaceRoot, '.taskhub', 'logs'));
            await assert.rejects(
                readActionRunLog(workspaceRoot, '.taskhub/logs/action-deadbeef/run.log'),
                (error: unknown) => error instanceof RunLogReadError && error.code === 'unsafe-path'
            );
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
