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

export const actionStates = new Map<string, { state: ActionRunState }>();
