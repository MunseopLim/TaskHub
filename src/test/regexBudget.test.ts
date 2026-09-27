import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyDiagnosticMatchers } from '../diagnosticMatcher';
import { applyOutputCapture, evaluateTaskCondition } from '../pipelineUtils';
import {
    RegexTimeoutError,
    USER_REGEX_HOST_THREAD_MAX_MS,
    USER_REGEX_TIME_BUDGET_MS,
    USER_REGEX_TIME_BUDGET_PER_MIB_MS,
    regexBudgetForInput,
    runWithRegexBudget,
} from '../regexBudget';
import {
    RegexJobCancelledError,
    applyDiagnosticMatchersOffThread,
    REGEX_WORKER_POOL_SIZE,
    applyOutputCaptureOffThread,
    disposeRegexWorkerPool,
    regexWorkerPath,
    regexWorkerPoolSize,
    regexWorkerWatchdogMs,
    runUserRegexJob,
} from '../regexWorkerClient';

/**
 * 사용자 정규식의 역추적 폭주가 확장 호스트를 붙잡지 않는지 (R03).
 * 31자 입력의 `^(a+)+$` 는 예산이 없으면 수십 초 동안 끝나지 않는다.
 */
suite('사용자 정규식 시간 예산', function () {
    this.timeout(20000);
    const CATASTROPHIC = '^(a+)+$';
    const input = 'a'.repeat(30) + '!';
    /** 기본 예산에 watchdog 지연·느린 CI 여유를 더한 상한. 폭주하면 이보다 훨씬 길다. */
    const MAX_ELAPSED_MS = USER_REGEX_TIME_BUDGET_MS + 4000;

    function assertStopsQuickly(run: () => unknown): RegexTimeoutError {
        const started = Date.now();
        let caught: unknown;
        try {
            run();
        } catch (error) {
            caught = error;
        }
        const elapsed = Date.now() - started;
        assert.ok(caught instanceof RegexTimeoutError, `RegexTimeoutError 여야 한다: ${String(caught)}`);
        assert.ok(elapsed < MAX_ELAPSED_MS, `${elapsed}ms 안에 끊겨야 한다`);
        return caught;
    }

    test('정상 결과와 내부 오류는 그대로 전달한다', () => {
        assert.strictEqual(runWithRegexBudget('x', () => /w(or)ld/.exec('hello world')?.[1]), 'or');
        assert.throws(() => runWithRegexBudget('x', () => { throw new Error('inner'); }), /inner/);
        assert.strictEqual(runWithRegexBudget('outer', () => runWithRegexBudget('inner', () => 7)), 7);
    });

    test('예산은 입력 크기에 비례해 늘어난다', () => {
        assert.strictEqual(regexBudgetForInput(0), USER_REGEX_TIME_BUDGET_MS);
        assert.ok(regexBudgetForInput(31) <= USER_REGEX_TIME_BUDGET_MS + 1, '짧은 입력에 1MiB 몫을 더하지 않는다');
        assert.strictEqual(regexBudgetForInput(10 * 1024 * 1024), USER_REGEX_TIME_BUDGET_MS + 10 * USER_REGEX_TIME_BUDGET_PER_MIB_MS);
    });

    test('출력 캡처의 폭주 패턴을 중단하고 패턴을 알리며, 이후 호출은 정상 동작한다', () => {
        const error = assertStopsQuickly(() => applyOutputCapture(input, { name: 'match', regex: CATASTROPHIC }));
        assert.strictEqual(error.pattern, CATASTROPHIC);
        assert.match(error.message, /did not finish/);
        assert.deepStrictEqual(applyOutputCapture('version 1.2.3', { name: 'v', regex: '(\\d+\\.\\d+\\.\\d+)' }), { v: '1.2.3' });
    });

    test('긴 줄의 큰 출력에 흔한 비앵커 패턴을 써도 중단하지 않는다', () => {
        // 1000자 줄 2MiB. `(.+)` 는 줄 길이에 제곱으로 돌아 MiB당 수백 ms가 걸린다.
        const line = 'x'.repeat(999) + '\n';
        const output = line.repeat(2 * 1024) + 'Build: 3 errors';
        const captured = applyOutputCapture(output, { name: 'n', regex: '(\\d+) errors' });
        assert.deepStrictEqual(captured, { n: '3' });
        const quadratic = applyOutputCapture(output, { name: 'summary', regex: '(.+)\\s+(\\d+) errors', group: 2 });
        assert.deepStrictEqual(quadratic, { summary: '3' });
    });

    test('조건 matches 의 폭주 패턴은 "맞지 않음"으로 삼키지 않고 중단한다', () => {
        assertStopsQuickly(() => evaluateTaskCondition({ var: 'x', matches: CATASTROPHIC }, input));
        assert.strictEqual(evaluateTaskCondition({ var: 'x', matches: '^a+!$' }, input), true);
    });

    test('진단 매처의 폭주 패턴을 중단하고 여러 패턴은 따옴표로 구분해 알린다', () => {
        const error = assertStopsQuickly(() => applyDiagnosticMatchers(input, [
            { pattern: '^(\\S+):(\\d+): (.*)$', file: 1, line: 2, message: 3 },
            { pattern: CATASTROPHIC, file: 1, line: 1, message: 1 },
        ]));
        assert.ok(error.message.includes(`'^(\\S+):(\\d+): (.*)$', '${CATASTROPHIC}'`), error.message);
    });

    test('호스트 스레드의 조건 판정은 입력 길이와 관계없이 절대 상한 안에서 끊긴다', () => {
        const long = 'a'.repeat(30) + '!' + 'x'.repeat(30000);
        const started = Date.now();
        assert.throws(() => evaluateTaskCondition({ var: 'x', matches: CATASTROPHIC }, long), RegexTimeoutError);
        assert.ok(Date.now() - started < USER_REGEX_HOST_THREAD_MAX_MS + 2000);
    });
});

/**
 * 입력이 큰 출력 캡처·진단은 worker 에서 돈다 (F01).
 * 폭주 패턴이 도는 동안에도 확장 호스트의 타이머·취소가 처리돼야 한다.
 */
suite('사용자 정규식 worker 실행', function () {
    this.timeout(30000);
    teardown(() => disposeRegexWorkerPool());
    const CATASTROPHIC = '^(a+)+$';
    const input = 'a'.repeat(30) + '!';

    test('배포 번들과 테스트 출력에 worker 파일이 있다', () => {
        assert.ok(fs.existsSync(regexWorkerPath()), `없으면 캡처·진단이 재설치 안내 오류로 실패한다: ${regexWorkerPath()}`);
        const bundled = path.resolve(__dirname, '..', '..', 'dist', 'regexWorker.js');
        assert.ok(fs.existsSync(bundled), 'esbuild 가 dist/regexWorker.js 를 만들어야 VSIX 에서 worker 를 쓴다');
    });

    test('정상 결과와 설정 오류는 호스트에서 직접 부를 때와 같다', async () => {
        const output = 'main.c:12: error: boom\nversion 1.2.3';
        assert.deepStrictEqual(
            await applyOutputCaptureOffThread(output, { name: 'v', regex: '(\\d+\\.\\d+\\.\\d+)' }),
            applyOutputCapture(output, { name: 'v', regex: '(\\d+\\.\\d+\\.\\d+)' })
        );
        const matcher = { pattern: '^(\\S+):(\\d+): error: (.*)$', file: 1, line: 2, message: 3 };
        assert.deepStrictEqual(await applyDiagnosticMatchersOffThread(output, matcher), applyDiagnosticMatchers(output, matcher));
        await assert.rejects(applyOutputCaptureOffThread(output, { name: 'bad', regex: '(' }), /invalid regex/);
    });

    test('폭주 패턴이 도는 동안에도 호스트 타이머가 계속 실행된다', async () => {
        let ticks = 0;
        const interval = setInterval(() => { ticks++; }, 50);
        const started = Date.now();
        let caught: unknown;
        try {
            await applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC });
        } catch (error) {
            caught = error;
        } finally {
            clearInterval(interval);
        }
        const elapsed = Date.now() - started;
        assert.ok(caught instanceof RegexTimeoutError, String(caught));
        assert.strictEqual((caught as RegexTimeoutError).pattern, CATASTROPHIC);
        // 호스트에서 돌았다면 끝날 때까지 한 번도 실행되지 못한다.
        assert.ok(ticks >= Math.floor(elapsed / 50 / 4), `${elapsed}ms 동안 타이머가 ${ticks}번만 실행됐다`);
    });

    test('취소하면 끝나기를 기다리지 않고 worker 를 멈춘다', async () => {
        let listener: (() => void) | undefined;
        const token = {
            isCancellationRequested: false,
            onCancellationRequested(cb: () => void) { listener = cb; return { dispose() { listener = undefined; } }; },
        };
        const running = applyDiagnosticMatchersOffThread(input, { pattern: CATASTROPHIC, file: 1, line: 1, message: 1 }, token);
        await new Promise(resolve => setTimeout(resolve, 200));
        const started = Date.now();
        token.isCancellationRequested = true;
        listener?.();
        await assert.rejects(running, RegexJobCancelledError);
        assert.ok(Date.now() - started < 500, '취소는 즉시 반영돼야 한다');
        await assert.rejects(applyOutputCaptureOffThread('x', { name: 'x', regex: 'x' }, token), RegexJobCancelledError);
    });

    test('반복 작업은 worker 를 새로 띄우지 않고 재사용한다', async () => {
        disposeRegexWorkerPool();
        for (let i = 0; i < 20; i++) {
            assert.deepStrictEqual(await applyOutputCaptureOffThread(`n=${i}`, { name: 'n', regex: 'n=(\\d+)' }), { n: String(i) });
        }
        assert.strictEqual(regexWorkerPoolSize(), 1, '순차 작업은 쉬는 worker 하나를 계속 쓴다');
    });

    test('동시 작업은 풀 크기 안에서 나눠 처리하고 폭주한 worker 만 버린다', async () => {
        disposeRegexWorkerPool();
        const runaway = applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC });
        const normal = Array.from({ length: 6 }, (_, i) => applyOutputCaptureOffThread(`n=${i}`, { name: 'n', regex: 'n=(\\d+)' }));
        assert.ok(regexWorkerPoolSize() <= REGEX_WORKER_POOL_SIZE);
        assert.deepStrictEqual(await Promise.all(normal), Array.from({ length: 6 }, (_, i) => ({ n: String(i) })),
            '폭주 작업이 worker 하나를 붙잡아도 나머지 작업은 끝난다');
        await assert.rejects(runaway, RegexTimeoutError);
        assert.deepStrictEqual(await applyOutputCaptureOffThread('n=9', { name: 'n', regex: 'n=(\\d+)' }), { n: '9' });
        assert.ok(regexWorkerPoolSize() <= REGEX_WORKER_POOL_SIZE);
    });

    test('대기열에서 취소한 작업은 worker 를 받지 않고 끝난다', async () => {
        disposeRegexWorkerPool();
        const blockers = Array.from({ length: REGEX_WORKER_POOL_SIZE }, () =>
            applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC }).catch(error => error));
        let listener: (() => void) | undefined;
        const token = {
            isCancellationRequested: false,
            onCancellationRequested(cb: () => void) { listener = cb; return { dispose() { listener = undefined; } }; },
        };
        const queued = applyOutputCaptureOffThread('n=1', { name: 'n', regex: 'n=(\\d+)' }, token);
        token.isCancellationRequested = true;
        listener?.();
        await assert.rejects(queued, RegexJobCancelledError);
        const abandoned = applyOutputCaptureOffThread('n=2', { name: 'n', regex: 'n=(\\d+)' });
        disposeRegexWorkerPool();
        await assert.rejects(abandoned, RegexJobCancelledError, '풀을 정리하면 대기 작업도 끝나야 한다');
        await Promise.all(blockers);
    });

    test('worker 안의 예산 초과 뒤에도 같은 worker 로 다음 작업을 처리한다', async () => {
        disposeRegexWorkerPool();
        await assert.rejects(applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC }), RegexTimeoutError);
        assert.deepStrictEqual(await applyOutputCaptureOffThread('n=5', { name: 'n', regex: 'n=(\\d+)' }), { n: '5' });
        assert.strictEqual(regexWorkerPoolSize(), 1);
    });

    test('풀을 정리하면 실행 중인 작업도 취소로 끝난다', async () => {
        disposeRegexWorkerPool();
        const running = applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC });
        await new Promise(resolve => setTimeout(resolve, 100));
        disposeRegexWorkerPool();
        await assert.rejects(running, RegexJobCancelledError);
    });

    test('버린 worker 가 종료되면 대기 작업이 새 worker 를 받는다', async () => {
        disposeRegexWorkerPool();
        const tokens = Array.from({ length: REGEX_WORKER_POOL_SIZE }, () => {
            let listener: (() => void) | undefined;
            return {
                isCancellationRequested: false,
                onCancellationRequested(cb: () => void) { listener = cb; return { dispose() { listener = undefined; } }; },
                cancel() { this.isCancellationRequested = true; listener?.(); },
            };
        });
        const blockers = tokens.map(token => applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC }, token).catch(error => error));
        const queued = applyOutputCaptureOffThread('n=3', { name: 'n', regex: 'n=(\\d+)' });
        assert.strictEqual(regexWorkerPoolSize(), REGEX_WORKER_POOL_SIZE);
        const started = Date.now();
        tokens[0].cancel();
        assert.deepStrictEqual(await queued, { n: '3' });
        assert.ok(Date.now() - started < 2000, '폭주 작업의 예산을 기다리지 않아야 한다');
        assert.ok(regexWorkerPoolSize() <= REGEX_WORKER_POOL_SIZE, '종료 중인 worker 도 자리를 차지해 한도를 넘지 않는다');
        tokens[1].cancel();
        assert.ok((await Promise.all(blockers)).every(error => error instanceof RegexJobCancelledError));
    });

    test('worker 를 만들지 못하면 작업을 오류로 끝내고 대기열도 멈추지 않는다', async () => {
        disposeRegexWorkerPool();
        const threads = require('worker_threads') as typeof import('worker_threads');
        const OriginalWorker = threads.Worker;
        const failure = Object.assign(new Error('thread creation failed'), { code: 'ERR_WORKER_INIT_FAILED' });
        (threads as any).Worker = function () { throw failure; };
        try {
            await assert.rejects(applyOutputCaptureOffThread('n=1', { name: 'n', regex: 'n=(\\d+)' }), /thread creation failed/);
        } finally {
            (threads as any).Worker = OriginalWorker;
        }
        // 대기열 경로: 자리를 모두 채운 뒤 하나를 버리고, 새 worker 생성이 실패하게 한다.
        let listener: (() => void) | undefined;
        const token = {
            isCancellationRequested: false,
            onCancellationRequested(cb: () => void) { listener = cb; return { dispose() { listener = undefined; } }; },
        };
        const blockers = [
            applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC }, token).catch(error => error),
            ...Array.from({ length: REGEX_WORKER_POOL_SIZE - 1 }, () =>
                applyOutputCaptureOffThread(input, { name: 'x', regex: CATASTROPHIC }).catch(error => error)),
        ];
        const queued = applyOutputCaptureOffThread('n=2', { name: 'n', regex: 'n=(\\d+)' });
        (threads as any).Worker = function () { throw failure; };
        try {
            token.isCancellationRequested = true;
            listener?.();
            await assert.rejects(queued, /thread creation failed/);
        } finally {
            (threads as any).Worker = OriginalWorker;
            disposeRegexWorkerPool();
            await Promise.all(blockers);
        }
    });

    test('watchdog 은 캡처 규칙마다 예산을 더해 여러 규칙 캡처를 끊지 않는다', () => {
        // worker 안에서는 규칙마다 예산이 따로 붙는다. 작업 전체에 하나만 주면
        // 규칙마다 예산 안에 끝나는 캡처가 worker 에서만 실패했다.
        const output = 'x'.repeat(4 * 1024 * 1024);
        const perRule = regexBudgetForInput(output.length);
        const rules = [1, 2, 3].map(i => ({ name: `r${i}`, regex: '(.+) errors' }));
        const single = regexWorkerWatchdogMs({ op: 'capture', output, capture: rules[0] });
        const triple = regexWorkerWatchdogMs({ op: 'capture', output, capture: [...rules, { name: 'line', line: -1 }] });
        assert.ok(single > perRule);
        assert.strictEqual(triple - single, 2 * perRule, '정규식 규칙 수만큼 늘고 line 규칙은 세지 않는다');
        assert.strictEqual(regexWorkerWatchdogMs({ op: 'diagnostics', output, config: [{ pattern: 'a', file: 1, line: 1, message: 1 }, 'gcc'] }), single,
            '진단은 전체 순회를 한 예산으로 묶는다');
    });

    test('배포 번들의 worker 로도 같은 결과를 낸다', async () => {
        const bundled = path.resolve(__dirname, '..', '..', 'dist', 'regexWorker.js');
        assert.deepStrictEqual(
            await runUserRegexJob({ op: 'capture', output: 'version 1.2.3', capture: { name: 'v', regex: '(\\d+\\.\\d+\\.\\d+)' } }, undefined, { workerPath: bundled }),
            { v: '1.2.3' }
        );
    });

    suite('비정상 worker', () => {
        let tempDir: string;
        setup(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-regex-worker-')); });
        teardown(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

        test('worker 파일이 없으면 호스트에서 대신 돌리지 않고 재설치를 안내한다', async () => {
            // 호스트에서 대신 돌리면 큰 출력의 폭주 정규식이 다시 호스트를 붙잡는다.
            const job = { op: 'capture' as const, output: 'v=7', capture: { name: 'v', regex: 'v=(\\d)' } };
            await assert.rejects(runUserRegexJob(job, undefined, { workerPath: path.join(tempDir, 'missing.js') }), /missing[\s\S]*Reinstall/);
        });

        test('worker 가 답 없이 끝나면 오류로 알린다', async () => {
            const script = path.join(tempDir, 'exit.js');
            fs.writeFileSync(script, 'process.exit(3);');
            await assert.rejects(runUserRegexJob({ op: 'capture', output: 'x', capture: { name: 'x', regex: 'x' } }, undefined, { workerPath: script }),
                /exited unexpectedly \(code 3\)/);
        });

        test('worker 가 응답하지 않으면 watchdog 이 종료하고 시간 초과로 알린다', async () => {
            const script = path.join(tempDir, 'hang.js');
            fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
            const started = Date.now();
            await assert.rejects(
                runUserRegexJob({ op: 'capture', output: 'x', capture: { name: 'x', regex: 'x+' } }, undefined, { workerPath: script, watchdogMs: 300 }),
                (error: unknown) => error instanceof RegexTimeoutError && error.pattern === 'x+'
            );
            assert.ok(Date.now() - started < 3000);
        });
    });
});
