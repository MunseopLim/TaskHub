/**
 * The task-graph executor shared by the VS Code extension and the standalone CLI/MCP.
 *
 * It owns everything that decides *whether and when* a task runs and what its outcome means:
 * dependency scheduling and concurrency, `when` conditions and the skipping of tasks that
 * reference a skipped task, `timeoutSeconds`, `continueOnError`, the run-log lifecycle of each
 * task, the combined result limit and the collection of failures. A host supplies what differs
 * between environments — how a task body runs (VS Code terminals and dialogs, or a spawned
 * process and preset inputs), how a failure is described, and how in-flight work is stopped.
 *
 * This module must not import `vscode`.
 */
import { evaluateTaskCondition, interpolatePipelineVariables, referencesSkippedTask, TaskScheduler, withTaskTimeout,
    type TaskGraph } from './pipelineUtils';
import type { ActionRunLogCollector, TaskRunLogCompletion, TaskRunLogOutput } from './runLogStore';
import type { Task } from './schema';

export type PipelineTaskOutcome =
    | { taskId: string; kind: 'success'; result: unknown }
    /** Failed with `continueOnError`: later tasks still run. */
    | { taskId: string; kind: 'skipped'; error: Error }
    /** The task's `when` is false, or it references a task skipped that way. Not a failure. */
    | { taskId: string; kind: 'condition-skipped'; reason: string }
    | { taskId: string; kind: 'failed'; error: Error };

/** How a host describes a failed task. */
export interface PipelineTaskFailure {
    /** The error kept as the task's outcome, possibly a wrapped or public form of the raw error. */
    error: Error;
    /** False when `continueOnError` must not apply, for example after the user stopped the action. */
    continuable: boolean;
    /** Run-log fields of the failed task. */
    log: Omit<TaskRunLogCompletion, 'status' | 'finishedAt'>;
}

/** One launch of a task, carrying whatever per-task state the host needs. */
export interface PipelineTaskAttempt {
    /**
     * Runs the task body. `conditionFailure` is set when evaluating the task's condition threw; the host
     * rejects with that error from inside its own execution scope so the shared failure handling applies.
     */
    start(conditionFailure: { error: unknown } | undefined): Promise<unknown>;
    /** The task exceeded `timeoutSeconds`; stop its work. The body keeps running, but its result is discarded. */
    onTimeout(): void;
    /** The task succeeded. Returns its run-log output, if the engine should record one. */
    succeeded(result: unknown): TaskRunLogOutput | undefined;
    failed(error: Error): PipelineTaskFailure;
}

export interface PipelineEngineHost {
    readonly tasks: readonly Task[];
    readonly graph: TaskGraph;
    readonly maxConcurrency: number;
    readonly totalResultLimitBytes: number;
    /** Built-in variables; task results are layered on top for conditions. */
    readonly builtinVariables: Record<string, unknown>;
    readonly log?: ActionRunLogCollector;
    /**
     * The object the engine stores results in, when the host's task bodies read it directly.
     * It must have a null prototype (see `runPipelineEngine`). Defaults to a new one.
     */
    readonly stepResults?: Record<string, unknown>;
    /** Called before scheduling a task, including one later skipped by its condition. */
    prepare(task: Task): PipelineTaskAttempt;
    /** The reason logged when a task references a task skipped by its condition. */
    skippedReferenceReason(task: Task): string;
    /** The reason logged when a task's `when` is false. The resolved value may need redaction. */
    conditionNotMetReason(task: Task, gateContext: Record<string, unknown>): string;
    /** A task is about to run (after its condition passed). */
    taskStarted?(task: Task): void;
    /** A task settled and the engine updated its state. */
    taskSettled?(outcome: PipelineTaskOutcome, task: Task): void;
    /**
     * The engine is leaving early (the result limit, or an unexpected error) while tasks still run.
     * The host stops them and waits for them, as far as it can.
     */
    abortInFlight(inFlight: ReadonlyMap<string, Promise<PipelineTaskOutcome>>): Promise<void>;
    resultLimitError(limitBytes: number): Error;
    stalledError(): Error;
}

export interface PipelineEngineResult {
    /** Results by task id. A skipped or continued task holds `{}`. Null-prototype. */
    stepResults: Record<string, unknown>;
    /** Failed tasks in the order they settled. Empty when the action succeeded. */
    failures: { taskId: string; error: Error }[];
}

/**
 * Approximate byte size of a task result, for the combined result limit. A relative measure:
 * the heavy parts are captured strings, so string lengths are summed with bounded depth.
 */
export function approximateResultBytes(value: unknown, depth = 0): number {
    if (depth > 3 || value === null || value === undefined) { return 0; }
    if (typeof value === 'string') { return Buffer.byteLength(value, 'utf8'); }
    if (typeof value === 'number' || typeof value === 'boolean') { return 8; }
    if (Array.isArray(value)) {
        let sum = 0;
        for (const item of value) { sum += approximateResultBytes(item, depth + 1); }
        return sum;
    }
    if (typeof value === 'object') {
        let sum = 0;
        for (const item of Object.values(value as Record<string, unknown>)) {
            sum += approximateResultBytes(item, depth + 1);
        }
        return sum;
    }
    return 0;
}

/**
 * Runs the graph to completion. A task failure without `continueOnError` stops new tasks from
 * starting, lets tasks already running settle, and is returned in `failures`. The engine throws
 * only when it cannot finish the schedule (the result limit, a stalled scheduler, a host error),
 * after asking the host to stop the tasks still running.
 */
export async function runPipelineEngine(host: PipelineEngineHost): Promise<PipelineEngineResult> {
    const { graph, log } = host;
    // **Null prototype.** Task ids are user-defined and `__proto__` is not rejected by the schema;
    // on a plain object `stepResults['__proto__'] = result` would not create an own property and the
    // result would vanish silently. Without a prototype chain every id is an ordinary key.
    const stepResults: Record<string, unknown> = host.stepResults ?? Object.create(null);
    const taskById = new Map<string, Task>();
    for (const task of host.tasks) { taskById.set(task.id, task); }
    const scheduler = new TaskScheduler(graph, { maxConcurrency: host.maxConcurrency });
    const inFlight = new Map<string, Promise<PipelineTaskOutcome>>();
    const failures: { taskId: string; error: Error }[] = [];
    /** Tasks turned off by a condition. Tasks that reference their results are turned off too. */
    const conditionSkipped = new Set<string>();
    let accumulatedResultBytes = 0;

    /** Returns why the task must not run, or undefined when it should run. */
    const conditionGate = (task: Task): string | undefined => {
        if (!task.when && task.type !== 'switch' && conditionSkipped.size === 0) { return undefined; }
        const gateContext = Object.assign(Object.create(null), host.builtinVariables, stepResults);
        if (referencesSkippedTask(task, conditionSkipped, gateContext)) { return host.skippedReferenceReason(task); }
        if (!task.when) { return undefined; }
        const resolved = interpolatePipelineVariables(task.when.var, gateContext);
        return evaluateTaskCondition(task.when, resolved) ? undefined : host.conditionNotMetReason(task, gateContext);
    };

    const launchTask = (taskId: string): Promise<PipelineTaskOutcome> => {
        const task = taskById.get(taskId)!;
        const attempt = host.prepare(task);
        scheduler.markStarted(taskId);
        // Decide before announcing 'running': a task that never ran must not look as if it had.
        let skipReason: string | undefined;
        let conditionFailure: { error: unknown } | undefined;
        try {
            skipReason = conditionGate(task);
        } catch (error) {
            // A condition that cannot be evaluated fails the task through the shared policy below.
            conditionFailure = { error };
        }
        if (skipReason !== undefined) {
            conditionSkipped.add(taskId);
            log?.skipTask(taskId, skipReason, Date.now());
            return Promise.resolve({ taskId, kind: 'condition-skipped', reason: skipReason });
        }
        host.taskStarted?.(task);
        log?.startTask(taskId, Date.now());
        let underlying: Promise<unknown>;
        try {
            underlying = attempt.start(conditionFailure);
        } catch (error) {
            underlying = Promise.reject(error);
        }
        return withTaskTimeout(underlying, task.timeoutSeconds, taskId, () => attempt.onTimeout()).then(
            (result): PipelineTaskOutcome => {
                log?.finishTask(taskId, { status: 'success', finishedAt: Date.now(), output: attempt.succeeded(result) });
                return { taskId, kind: 'success', result };
            },
            (error: unknown): PipelineTaskOutcome => {
                const failure = attempt.failed(error instanceof Error ? error : new Error(String(error)));
                const continued = failure.continuable && !!task.continueOnError;
                log?.finishTask(taskId, { ...failure.log, status: continued ? 'continued' : 'failure', finishedAt: Date.now() });
                return { taskId, kind: continued ? 'skipped' : 'failed', error: failure.error };
            }
        );
    };

    try {
        while (!scheduler.isFinished()) {
            if (!scheduler.isAborted()) {
                for (const taskId of scheduler.nextReady()) {
                    inFlight.set(taskId, launchTask(taskId));
                }
            }
            // The graph validator should have ruled this out. Fail loudly rather than loop forever.
            if (inFlight.size === 0) { throw host.stalledError(); }

            const outcome = await Promise.race(inFlight.values());
            inFlight.delete(outcome.taskId);
            if (outcome.kind === 'success') {
                scheduler.markCompleted(outcome.taskId);
                stepResults[outcome.taskId] = outcome.result;
                // Measured after storing: this task completed normally; the limit stops the tasks after it.
                accumulatedResultBytes += approximateResultBytes(outcome.result);
                if (accumulatedResultBytes > host.totalResultLimitBytes) {
                    throw host.resultLimitError(host.totalResultLimitBytes);
                }
            } else if (outcome.kind === 'failed') {
                scheduler.markFailed(outcome.taskId);
                failures.push({ taskId: outcome.taskId, error: outcome.error });
            } else {
                // Same shape as an empty result: later `${task.*}` references stay literal.
                stepResults[outcome.taskId] = {};
                scheduler.markCompleted(outcome.taskId);
            }
            host.taskSettled?.(outcome, taskById.get(outcome.taskId)!);
        }
    } catch (error) {
        // Leaving mid-schedule must not orphan sibling tasks whose processes would keep running.
        if (inFlight.size > 0) {
            // A failing cleanup must not hide why the schedule stopped.
            try { await host.abortInFlight(inFlight); } catch { /* the original error is reported */ }
            inFlight.clear();
        }
        throw error;
    }
    return { stepResults, failures };
}
