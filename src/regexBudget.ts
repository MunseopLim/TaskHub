import * as vm from 'vm';

/**
 * 사용자 설정 정규식 한 번의 실행에 허용하는 시간.
 *
 * `^(a+)+$` 같은 중첩 수량자는 31자 입력에도 수십 초 동안 확장 호스트를
 * 점유한다. 같은 스레드의 타이머·`Promise.race` 로는 실행 중인 정규식을
 * 선점하지 못하므로, V8 watchdog 이 실행을 끊는 `vm` timeout 안에서 돌린다.
 * 한 호출의 추가 비용은 수십 µs라 줄마다가 아니라 함수 단위로 감싼다.
 *
 * 목적은 끝나지 않는 실행을 끊는 것이지 작업량을 조이는 것이 아니다. 비앵커
 * `(.+)…` 처럼 줄 길이에 제곱으로 도는 흔한 패턴도 긴 줄의 빌드 로그에서는
 * MiB당 수백 ms가 걸리므로 넉넉하게 잡는다.
 */
export const USER_REGEX_TIME_BUDGET_MS = 3000;

/**
 * 입력 1MiB(문자 기준)마다 더하는 시간. 출력 캡처 한도는 설정으로 1GiB까지
 * 늘릴 수 있어서, 고정 예산이면 정상 패턴도 큰 출력에서 중단된다.
 */
export const USER_REGEX_TIME_BUDGET_PER_MIB_MS = 1000;

/**
 * 확장 호스트 스레드에서 직접 도는 정규식의 절대 상한.
 *
 * 입력에 비례하는 예산은 큰 출력에서 호스트를 수십 초 붙잡을 수 있으므로, 입력이
 * 큰 출력 캡처·진단은 worker(`regexWorkerClient.ts`)에서 돌린다. 호스트에 남는
 * 것은 길이가 보간 상한(32KB) 안인 `when.matches`·inputBox 추출·검증뿐이며,
 * 이들은 입력 길이와 관계없이 이 시간을 넘기지 않는다.
 */
export const USER_REGEX_HOST_THREAD_MAX_MS = 1000;

/** 입력 길이에 비례해 늘린 예산. worker 안에서 쓰며, 작은 입력의 역추적 폭주는 약 3초에 끊긴다. */
export function regexBudgetForInput(inputLength: number): number {
    // 올림을 MiB 단위로 하면 몇 글자짜리 입력에도 1MiB 몫이 붙는다. 비례로 더한다.
    return USER_REGEX_TIME_BUDGET_MS + Math.ceil(inputLength * USER_REGEX_TIME_BUDGET_PER_MIB_MS / (1024 * 1024));
}

/** 사용자 정규식이 시간 예산을 넘겨 중단됐다. */
export class RegexTimeoutError extends Error {
    constructor(readonly pattern: string, readonly budgetMs: number) {
        super(`Regular expression '${pattern}' did not finish within ${budgetMs}ms and was stopped. Simplify the pattern, for example nested quantifiers such as '(a+)+'.`);
        this.name = 'RegexTimeoutError';
    }
}

let currentJob: (() => unknown) | undefined;
const sandbox = vm.createContext({ run: () => currentJob!() });
const runner = new vm.Script('run()');

/**
 * `fn` 을 시간 예산 안에서 실행한다. 예산을 넘기면 실행을 끊고
 * {@link RegexTimeoutError} 를 던진다. `fn` 이 던진 오류는 그대로 전달한다.
 */
export function runWithRegexBudget<T>(pattern: string, fn: () => T, budgetMs = USER_REGEX_HOST_THREAD_MAX_MS): T {
    const previous = currentJob;
    currentJob = fn;
    try {
        return runner.runInContext(sandbox, { timeout: budgetMs }) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            throw new RegexTimeoutError(pattern, budgetMs);
        }
        throw error;
    } finally {
        currentJob = previous;
    }
}
