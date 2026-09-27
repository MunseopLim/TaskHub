import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { ParsedDiagnostic } from './diagnosticMatcher';
import { RegexTimeoutError, regexBudgetForInput } from './regexBudget';
import type { DiagnosticConfig, OutputCapture } from './schema';

export type UserRegexJob =
    | { op: 'capture'; output: string; capture: OutputCapture | OutputCapture[] }
    | { op: 'diagnostics'; output: string; config: DiagnosticConfig };

export type UserRegexJobReply =
    | { ok: true; value: unknown }
    | { ok: false; message: string; timeout?: { pattern: string; budgetMs: number } };

/** 취소 신호. `vscode.CancellationToken` 과 같은 모양이라 그대로 넘길 수 있다. */
export interface RegexJobCancellation {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

/** worker 기동·입력 복제에 주는 여유. 이 시간을 넘기면 worker 자체를 종료한다. */
const WORKER_WATCHDOG_MARGIN_MS = 5000;

/** 번들에서는 `dist/regexWorker.js`, 테스트에서는 `out/regexWorker.js` 다. */
export function regexWorkerPath(): string {
    return path.join(__dirname, 'regexWorker.js');
}

/** 작업이 취소됐다. 결과는 버려진다. */
export class RegexJobCancelledError extends Error {
    constructor() {
        super('Regular expression processing was canceled.');
        this.name = 'RegexJobCancelledError';
    }
}

/**
 * worker 전체에 주는 시간. worker 안에서는 캡처 규칙마다 예산이 따로 붙으므로
 * (`applyOutputCapture`), 작업 하나에 예산 하나만 주면 규칙마다 예산 안에 끝나는
 * 여러 규칙 캡처가 worker에서만 실패한다. 진단은 전체 순회를 한 예산으로 묶는다.
 */
export function regexWorkerWatchdogMs(job: UserRegexJob): number {
    const perRunBudget = regexBudgetForInput(job.output.length);
    let runs = 1;
    if (job.op === 'capture') {
        const rules = Array.isArray(job.capture) ? job.capture : [job.capture];
        runs = Math.max(1, rules.filter(rule => typeof rule?.regex === 'string' && rule.regex.length > 0).length);
    }
    return runs * perRunBudget + WORKER_WATCHDOG_MARGIN_MS;
}

/** 테스트가 비정상 worker·짧은 watchdog을 주입할 때만 쓴다. */
export interface RegexJobOptions {
    workerPath?: string;
    watchdogMs?: number;
}

/** 동시에 유지하는 worker 수. 넘치는 작업은 대기열에서 순서대로 기다린다. */
export const REGEX_WORKER_POOL_SIZE = 2;

/** 쉬는 worker를 이 시간 뒤 종료한다. 반복 캡처(forEach 등)는 같은 worker를 다시 쓴다. */
const IDLE_WORKER_TTL_MS = 30_000;

/**
 * 이보다 큰 입력(문자 수)을 처리한 worker는 재사용하지 않는다. 복제한 출력과
 * 결과가 GC 전까지 쉬는 isolate에 남아 수백 MB를 30초 동안 쥐고 있을 수 있다.
 */
const REUSE_MAX_INPUT_CHARS = 1024 * 1024;

interface PooledWorker {
    readonly worker: Worker;
    readonly workerPath: string;
    /** `terminating`은 종료를 요청했지만 아직 끝나지 않은 상태다. 끝날 때까지 자리를 차지한다. */
    state: 'busy' | 'idle' | 'terminating';
    idleTimer?: ReturnType<typeof setTimeout>;
}

interface PoolWaiter {
    readonly workerPath: string;
    readonly grant: (entry: PooledWorker) => void;
    /** 작업을 오류로 끝낸다(풀 정리, worker 생성 실패). */
    readonly abandon: (error: unknown) => void;
}

const pool: PooledWorker[] = [];
const waiters: PoolWaiter[] = [];
/** worker를 받아 실행 중인 작업. 풀을 정리할 때 취소로 끝낸다. */
const activeJobs = new Set<{ abandon: (error: unknown) => void }>();

function spawnPooledWorker(workerPath: string): PooledWorker {
    const entry: PooledWorker = { worker: new Worker(workerPath), workerPath, state: 'busy' };
    // 쉬는 동안의 오류로 처리되지 않은 'error' 이벤트가 나지 않게 한다. 작업 중 오류는 작업별 리스너가 처리한다.
    entry.worker.on('error', () => undefined);
    // 종료가 **끝난 뒤에야** 자리를 비운다. 그 전에 새 worker를 띄우면 한도보다 많은
    // isolate가 각자 입력 사본을 쥔 채 함께 살아 있게 된다.
    entry.worker.once('exit', () => {
        const index = pool.indexOf(entry);
        if (index >= 0) { pool.splice(index, 1); }
        if (entry.idleTimer) { clearTimeout(entry.idleTimer); }
        dispatchWaiters();
    });
    pool.push(entry);
    return entry;
}

function retireWorker(entry: PooledWorker): void {
    if (entry.state === 'terminating') { return; }
    entry.state = 'terminating';
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
    void entry.worker.terminate();
}

/** 쉬는 worker를 주거나, 자리가 있으면 새로 띄운다. 없으면 undefined. worker 생성 실패는 던진다. */
function tryAcquire(workerPath: string): PooledWorker | undefined {
    const idle = pool.find(entry => entry.state === 'idle' && entry.workerPath === workerPath);
    if (idle) {
        idle.state = 'busy';
        if (idle.idleTimer) { clearTimeout(idle.idleTimer); idle.idleTimer = undefined; }
        idle.worker.ref();
        return idle;
    }
    if (pool.length >= REGEX_WORKER_POOL_SIZE) {
        // 다른 경로의 쉬는 worker는 비워 자리를 만든다(테스트 주입 경로에서만 생긴다).
        // 종료가 끝나면 'exit'에서 대기열을 다시 돌린다.
        const other = pool.find(entry => entry.state === 'idle');
        if (other) { retireWorker(other); }
        return undefined;
    }
    return spawnPooledWorker(workerPath);
}

function dispatchWaiters(): void {
    while (waiters.length > 0) {
        let entry: PooledWorker | undefined;
        try {
            entry = tryAcquire(waiters[0].workerPath);
        } catch (error) {
            // 스레드를 만들지 못했다(자원 부족 등). 이 작업을 오류로 끝내고 다음 작업을 본다.
            waiters.shift()!.abandon(error);
            continue;
        }
        if (!entry) { return; }
        waiters.shift()!.grant(entry);
    }
}

/** 재사용할 수 있는 worker는 쉬게 두고, 나머지는 종료한다. */
function releaseWorker(entry: PooledWorker, reusable: boolean): void {
    if (!reusable || entry.state === 'terminating') {
        retireWorker(entry);
    } else {
        entry.state = 'idle';
        entry.worker.unref();
        entry.idleTimer = setTimeout(() => retireWorker(entry), IDLE_WORKER_TTL_MS);
        entry.idleTimer.unref?.();
    }
    dispatchWaiters();
}

/** 확장 비활성화 시 모든 worker를 종료하고, 대기·실행 중인 작업은 취소로 끝낸다. */
export function disposeRegexWorkerPool(): void {
    for (const waiter of waiters.splice(0)) { waiter.abandon(new RegexJobCancelledError()); }
    for (const job of [...activeJobs]) { job.abandon(new RegexJobCancelledError()); }
    for (const entry of [...pool]) { retireWorker(entry); }
}

/** 테스트용: 현재 풀이 차지한 worker 수(종료가 끝나지 않은 것 포함). */
export function regexWorkerPoolSize(): number {
    return pool.length;
}

/**
 * 출력 캡처·진단처럼 입력이 큰 사용자 정규식 작업을 worker에서 실행한다.
 *
 * 확장 호스트 스레드에서 돌리면 `vm` 예산이 끊기 전까지 호스트의 명령·Stop·
 * 타이머가 멈춘다(10MiB 입력이면 약 13초). worker로 옮기면 그동안에도 호스트가
 * 응답하며, 취소 신호가 오면 그 worker를 즉시 종료한다. worker는 작은 풀에서
 * 재사용하므로 반복 캡처가 매번 worker를 띄우지 않는다. 결과를 돌려준 worker(정상,
 * worker 안 `vm` 예산 초과, 설정 오류)는 입력이 작으면 다시 쓰고, watchdog 초과·취소·
 * worker 오류·비정상 종료가 난 worker는 버린다. watchdog은 worker를 받은 뒤부터 잰다.
 *
 * worker 파일이 없으면 설치가 손상된 것이다. 호스트에서 대신 돌리면 위의 정지가
 * 되살아나므로 재설치를 안내하는 오류로 끝낸다.
 */
export function runUserRegexJob(job: UserRegexJob, cancellation?: RegexJobCancellation, options: RegexJobOptions = {}): Promise<unknown> {
    if (cancellation?.isCancellationRequested) {
        return Promise.reject(new RegexJobCancelledError());
    }
    const workerPath = options.workerPath ?? regexWorkerPath();
    if (!fs.existsSync(workerPath)) {
        return Promise.reject(new Error(
            `TaskHub's regular expression worker is missing (${workerPath}). Reinstall the TaskHub extension.`
        ));
    }
    const watchdogMs = options.watchdogMs ?? regexWorkerWatchdogMs(job);
    const reusableAfterSuccess = job.output.length <= REUSE_MAX_INPUT_CHARS;
    return new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let entry: PooledWorker | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let cancelSubscription: { dispose(): void } | undefined;
        const listeners: Array<[string, (...args: any[]) => void]> = [];
        const active = { abandon: (error: unknown) => finish(() => reject(error), false) };
        const waiter: PoolWaiter = {
            workerPath,
            grant: granted => start(granted),
            abandon: error => finish(() => reject(error), false),
        };

        const finish = (outcome: () => void, reusable: boolean) => {
            if (settled) { return; }
            settled = true;
            if (watchdog) { clearTimeout(watchdog); }
            cancelSubscription?.dispose();
            activeJobs.delete(active);
            const index = waiters.indexOf(waiter);
            if (index >= 0) { waiters.splice(index, 1); }
            const released = entry;
            if (released) {
                for (const [event, listener] of listeners) { released.worker.off(event, listener); }
            }
            // 결과를 먼저 확정한다. 이어지는 worker 반환·대기열 처리에서 무엇이 던져져도
            // 이 작업이 끝나지 않은 채 남지 않는다.
            outcome();
            if (released) { releaseWorker(released, reusable); }
        };
        const listen = (event: string, listener: (...args: any[]) => void) => {
            listeners.push([event, listener]);
            entry!.worker.on(event, listener);
        };
        const start = (granted: PooledWorker) => {
            if (settled) {
                releaseWorker(granted, true);
                return;
            }
            entry = granted;
            activeJobs.add(active);
            watchdog = setTimeout(() => finish(() => reject(new RegexTimeoutError(describeJobPatterns(job), watchdogMs)), false), watchdogMs);
            listen('message', (reply: UserRegexJobReply) => {
                if (reply.ok) {
                    finish(() => resolve(reply.value), reusableAfterSuccess);
                } else if (reply.timeout) {
                    // worker 안의 vm 예산이 끊은 것이라 worker 자체는 멀쩡하다.
                    const timeout = reply.timeout;
                    finish(() => reject(new RegexTimeoutError(timeout.pattern, timeout.budgetMs)), reusableAfterSuccess);
                } else {
                    finish(() => reject(new Error(reply.message)), reusableAfterSuccess);
                }
            });
            listen('messageerror', error => finish(() => reject(error), false));
            listen('error', error => finish(() => reject(error), false));
            listen('exit', code => finish(() => reject(new Error(`Regular expression worker exited unexpectedly (code ${code}).`)), false));
            try {
                entry.worker.postMessage(job);
            } catch (error) {
                // 입력 복제 실패(아주 큰 출력 등). worker를 watchdog까지 남겨 두지 않는다.
                finish(() => reject(error), false);
            }
        };

        cancelSubscription = cancellation?.onCancellationRequested(() => finish(() => reject(new RegexJobCancelledError()), false));
        let immediate: PooledWorker | undefined;
        try {
            immediate = tryAcquire(workerPath);
        } catch (error) {
            finish(() => reject(error), false);
            return;
        }
        if (immediate) {
            start(immediate);
        } else {
            waiters.push(waiter);
        }
    });
}

function describeJobPatterns(job: UserRegexJob): string {
    if (job.op === 'capture') {
        const rules = Array.isArray(job.capture) ? job.capture : [job.capture];
        return rules.map(rule => typeof rule?.regex === 'string' ? rule.regex : '').filter(Boolean).join("', '");
    }
    const entries = Array.isArray(job.config) ? job.config : [job.config];
    return entries.map(entry => typeof entry === 'string' ? entry : entry.pattern).join("', '");
}

/** {@link applyOutputCapture} 를 worker에서 실행한다. */
export async function applyOutputCaptureOffThread(
    output: string,
    capture: OutputCapture | OutputCapture[],
    cancellation?: RegexJobCancellation
): Promise<Record<string, string>> {
    return await runUserRegexJob({ op: 'capture', output, capture }, cancellation) as Record<string, string>;
}

/** {@link applyDiagnosticMatchers} 를 worker에서 실행한다. */
export async function applyDiagnosticMatchersOffThread(
    output: string,
    config: DiagnosticConfig,
    cancellation?: RegexJobCancellation
): Promise<ParsedDiagnostic[]> {
    return await runUserRegexJob({ op: 'diagnostics', output, config }, cancellation) as ParsedDiagnostic[];
}
