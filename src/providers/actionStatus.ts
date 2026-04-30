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
 * action terminates. `index` is 1-based (current task position),
 * `total` is the action's task count, and `taskId` is the id of the
 * task currently executing — used to render the "지금 어디" hint
 * `2/3 · link` in the Action TreeItem description.
 */
export interface ActionProgress {
    index: number;
    total: number;
    taskId: string;
}

export const actionStates = new Map<string, {
    state: ActionRunState;
    progress?: ActionProgress;
}>();
