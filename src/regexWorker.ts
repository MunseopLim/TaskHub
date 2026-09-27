import { parentPort } from 'worker_threads';
import { applyDiagnosticMatchers } from './diagnosticMatcher';
import { applyOutputCapture } from './pipelineUtils';
import { RegexTimeoutError } from './regexBudget';
import type { UserRegexJob, UserRegexJobReply } from './regexWorkerClient';

/**
 * 사용자 정규식 작업을 확장 호스트 밖에서 실행하는 worker (`dist/regexWorker.js`).
 *
 * 같은 순수 함수를 그대로 부르므로 결과·오류 규칙은 호스트에서 직접 부를 때와 같다.
 * 함수 안의 `vm` 예산이 폭주를 끊고, 호스트 쪽 watchdog이 worker 자체를 종료한다.
 */
parentPort?.on('message', (job: UserRegexJob) => {
    let reply: UserRegexJobReply;
    try {
        const value = job.op === 'capture'
            ? applyOutputCapture(job.output, job.capture)
            : applyDiagnosticMatchers(job.output, job.config);
        reply = { ok: true, value };
    } catch (error: any) {
        reply = error instanceof RegexTimeoutError
            ? { ok: false, message: error.message, timeout: { pattern: error.pattern, budgetMs: error.budgetMs } }
            : { ok: false, message: error?.message ?? String(error) };
    }
    parentPort?.postMessage(reply);
});
