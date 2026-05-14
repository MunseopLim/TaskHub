/**
 * Shared runtime state for action execution status.
 *
 * Split out from `extension.ts` so that the `Action` TreeItem (under
 * `./providers/mainViewProvider.ts`) can read the current run state without
 * pulling in the full `extension.ts` module (which would create a circular
 * import).
 *
 * `extension.ts` continues to own execution-related maps such as
 * `activeTasks` and `manuallyTerminatedActions`; only the state consumed by
 * tree rendering lives here.
 */

export type ActionRunState = 'running' | 'success' | 'failure';

/**
 * Per-action progress within a multi-task pipeline. Only populated while
 * `state === 'running'` and the pipeline has more than one task; cleared
 * by `finalizeActionRun` so the description doesn't go stale after the
 * action terminates.
 *
 * Multi-track design: `running` is the list of tasks currently in flight,
 * ordered by start time. Each entry carries the task's 1-based declaration
 * position (`index`) alongside its id so the single-running render form
 * (`2/3 · link`) reports the task's real position — *not* `completed + 1`,
 * which can lie under out-of-order parallel completions (e.g. task 1 still
 * running while task 2 already finished would otherwise render `2/3 · 1`).
 *
 * Sequential pipelines keep at most one entry (renders as `2/3 · link`);
 * parallel pipelines can hold multiple simultaneously and render as
 * `2 running · A, B` or `3 running · A, B + 1` when the list overflows
 * two names. `total` is the action's task count and `completed` counts
 * every terminal transition (success / failure / skipped) emitted so far.
 */
export interface RunningTaskEntry {
    taskId: string;
    /** 1-based position in the action's `tasks` array. */
    index: number;
}

export interface ActionProgress {
    total: number;
    completed: number;
    running: RunningTaskEntry[];
}

export const actionStates = new Map<string, {
    state: ActionRunState;
    progress?: ActionProgress;
}>();
