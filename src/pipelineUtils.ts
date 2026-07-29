/**
 * Pure utilities extracted from `extension.ts` for pipeline execution:
 *   - variable interpolation (with sanitation)
 *   - workspace-relative path resolution
 *   - command-line tokenization / shell-argument quoting
 *   - PowerShell / POSIX invocation builders
 *
 * This module has no dependency on the `vscode` API, which makes the helpers
 * easy to unit-test and re-use. Keep anything that needs `vscode.workspace`,
 * `vscode.window`, etc. in `extension.ts`.
 *
 * `extension.ts` re-exports everything here so that existing
 * `import { ... } from './extension'` call sites (including tests) continue to
 * work unchanged.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { OutputCapture, Task } from './schema';

/** Maximum allowed length of a single interpolated value. */
export const INTERPOLATED_VALUE_MAX_LENGTH = 32 * 1024;

/**
 * Predicate used by `executeShellCommand` to decide whether a newly arrived
 * chunk would push the total captured output past the user-configured limit.
 *
 * Pulled out as a standalone helper so that the off-by-one boundary
 * (`currentBytes + chunkBytes > limitBytes`) can be exercised by unit tests
 * without spawning a real subprocess. Keeping it pure also guards against an
 * accidental `>=` → `>` / `>` → `>=` swap during future edits.
 */
export function wouldExceedCaptureLimit(currentBytes: number, chunkBytes: number, limitBytes: number): boolean {
    return currentBytes + chunkBytes > limitBytes;
}

/**
 * Reserved capture names that would shadow built-in task result properties.
 * Exported so Doctor (`src/doctor.ts`) can validate `output.capture.name`
 * against the *same* list the runtime uses — keeping the two in sync
 * automatically instead of through a mirror copy.
 */
export const RESERVED_CAPTURE_NAMES: ReadonlySet<string> = new Set([
    'output', 'outputDir', 'path', 'dir', 'name', 'fileNameOnly', 'fileExt',
    'value', 'values', 'archivePath', 'confirmed'
]);

/**
 * Task types whose execution shows VS Code modal / quick-pick UI
 * (`inputBox`, `quickPick`, `envPick`, `confirm`, `fileDialog`,
 * `folderDialog`). The runtime serializes these via a prompt mutex
 * when running in a parallel pipeline so two dialogs never race;
 * Doctor warns when one is set to `parallel: true`. Centralized here
 * so the executor and the linter agree on the boundary.
 */
export const INTERACTIVE_TASK_TYPES: ReadonlySet<string> = new Set([
    'inputBox',
    'quickPick',
    'envPick',
    'fileDialog',
    'folderDialog',
    'confirm',
]);

/**
 * Apply one or more capture rules to a task's string output and return a map
 * of `{ name: value }` pairs to be merged into the task's result object.
 *
 * This is a pure function — no I/O, no `vscode` dependency — so it can be
 * unit-tested directly. Silently skips rules whose selector does not match
 * and throws only on configuration errors (e.g. missing `name`, invalid
 * regex, reserved name, duplicate name).
 */
export function applyOutputCapture(
    output: string,
    capture: OutputCapture | OutputCapture[] | undefined
): Record<string, string> {
    if (!capture) { return {}; }
    const rules = Array.isArray(capture) ? capture : [capture];
    const results: Record<string, string> = {};

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            throw new Error('Each capture rule must be an object.');
        }
        const name = rule.name;
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error("Capture rule is missing a non-empty 'name'.");
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`Capture name '${name}' must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
        }
        if (RESERVED_CAPTURE_NAMES.has(name)) {
            throw new Error(`Capture name '${name}' is reserved and cannot be used.`);
        }
        if (Object.prototype.hasOwnProperty.call(results, name)) {
            throw new Error(`Duplicate capture name '${name}'.`);
        }

        let selected: string | undefined;

        if (typeof rule.regex === 'string' && rule.regex.length > 0) {
            let re: RegExp;
            try {
                const flags = (rule.flags ?? '').replace(/g/g, '');
                re = new RegExp(rule.regex, flags);
            } catch (e: any) {
                throw new Error(`Capture '${name}' has invalid regex: ${e.message}`);
            }
            const m = output.match(re);
            if (m) {
                // Default group: 1 if the pattern has capture groups, otherwise 0
                // (full match). Explicit out-of-range group is silently skipped.
                const defaultGroup = m.length > 1 ? 1 : 0;
                const group = rule.group ?? defaultGroup;
                if (group < 0 || group >= m.length) {
                    selected = undefined;
                } else {
                    selected = m[group];
                }
            }
        } else if (typeof rule.line === 'number' && Number.isInteger(rule.line)) {
            const lines = output.split(/\r?\n/);
            const idx = rule.line < 0 ? lines.length + rule.line : rule.line;
            if (idx >= 0 && idx < lines.length) {
                selected = lines[idx];
            }
        } else {
            selected = output;
        }

        if (selected === undefined) { continue; }
        if (rule.trim) { selected = selected.trim(); }
        results[name] = selected;
    }

    return results;
}

/**
 * Windows 예약 디바이스 이름. 경로 세그먼트로 등장하면 (확장자가 붙어도)
 * 파일이 아니라 디바이스로 해석된다 — `CON`, `NUL.txt` 등.
 */
const WINDOWS_RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;

/**
 * Canonicalize `p` for containment checks: resolve symlinks on the deepest
 * EXISTING ancestor, then re-append the not-yet-existing remainder. The
 * target itself may not exist (about to be written), so a plain realpath
 * would throw — walk up instead.
 */
function canonicalizeForContainment(p: string): string {
    let existing = p;
    const tail: string[] = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) { break; } // filesystem root
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    let canonical: string;
    try {
        canonical = fs.realpathSync.native(existing);
    } catch {
        canonical = existing; // 권한 등으로 실패 시 어휘적 경로 유지
    }
    return tail.length > 0 ? path.join(canonical, ...tail) : canonical;
}

/**
 * Resolve `targetPath` and ensure it lands inside one of the provided workspace roots.
 *
 * Security contract:
 *   - null-byte in the path is rejected.
 *   - Relative paths are resolved against `baseDir` (typically the action's
 *     workspace folder) — NOT `process.cwd()`. This keeps behaviour stable
 *     regardless of how VS Code was launched.
 *   - The final resolved path must be inside at least one `workspaceRoots`
 *     entry, otherwise throws. Containment is judged on symlink-resolved
 *     (realpath) canonical paths, so a symlink/junction inside the workspace
 *     that points outside cannot bypass the check (M10).
 *   - On Windows, reserved device names (`CON`, `NUL`, `COM1`…) in any path
 *     segment are rejected.
 *
 * Known limits: the realpath check is check-time (TOCTOU) — a symlink swapped
 * in after validation but before the write is not detected. 8.3 short names
 * are normalized by `realpathSync.native` only for existing path components.
 *
 * @returns The lexically resolved path (not the canonical one) — callers
 *          write through the path the user configured.
 */
export function resolveWithinWorkspace(
    targetPath: string,
    workspaceRoots: string[],
    baseDir?: string
): string {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('A file path is required.');
    }
    if (/\x00/.test(targetPath)) {
        throw new Error('File path contains a null byte, which is not allowed.');
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        throw new Error('No workspace folder is available to validate the path.');
    }
    // Relative paths must resolve against the action's workspace, NOT process.cwd().
    // Configs with "filePath": "report.txt" would otherwise land in an arbitrary
    // directory determined by how VS Code was launched.
    let resolved: string;
    if (path.isAbsolute(targetPath)) {
        resolved = path.resolve(targetPath);
    } else {
        const base = baseDir && baseDir.length > 0 ? path.resolve(baseDir) : normalizedRoots[0];
        resolved = path.resolve(base, targetPath);
    }
    if (process.platform === 'win32') {
        for (const segment of resolved.split(path.sep)) {
            if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
                throw new Error(
                    `Refusing to access '${resolved}' because it contains the reserved device name '${segment}'.`
                );
            }
        }
    }
    if (!isInsideWorkspaceRoots(resolved, normalizedRoots)) {
        throw new Error(
            `Refusing to access '${resolved}' because it is outside the current workspace folder(s).`
        );
    }
    return resolved;
}

/**
 * `resolveWithinWorkspace`의 수용 여부 판정만 떼어낸 dry-run 술어. Preview와
 * Doctor가 런타임과 동일한 규칙(null byte·빈 경로 거부, realpath 정규화,
 * Windows 예약 디바이스명)으로 검사하도록 공유한다 — 규칙이 하나라도 빠지면
 * 그 경로가 Preview에서 안전해 보이다가 런타임에서 거부되는 거짓 음성이 생긴다.
 */
export function isInsideWorkspaceRoots(resolvedPath: string, workspaceRoots: string[]): boolean {
    // 런타임(resolveWithinWorkspace 상단 가드)이 무조건 거부하는 입력
    if (!resolvedPath || typeof resolvedPath !== 'string' || /\x00/.test(resolvedPath)) {
        return false;
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        return false;
    }
    const resolved = path.resolve(resolvedPath);
    if (process.platform === 'win32') {
        for (const segment of resolved.split(path.sep)) {
            if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
                return false;
            }
        }
    }
    const canonicalResolved = canonicalizeForContainment(resolved);
    return normalizedRoots.some(root => {
        const canonicalRoot = canonicalizeForContainment(root);
        const rel = path.relative(canonicalRoot, canonicalResolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

/**
 * Validate and coerce a value about to be substituted into a shell template.
 * Returns `undefined` for null/undefined/objects/arrays (caller should keep
 * the literal `${...}` placeholder). Throws on null byte or length overflow.
 */
export function sanitizeInterpolatedValue(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    let stringValue: string;
    if (typeof value === 'string') {
        stringValue = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        stringValue = String(value);
    } else {
        return undefined;
    }
    if (stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH) {
        throw new Error(
            `Interpolated value exceeds maximum length (${INTERPOLATED_VALUE_MAX_LENGTH} chars).`
        );
    }
    if (/\x00/.test(stringValue)) {
        throw new Error('Interpolated value contains a null byte, which is not allowed.');
    }
    return stringValue;
}

/**
 * Replace `${stepId.property}` / `${stepId}` / `${name}` occurrences in `template`
 * using values from `context`, running each value through `sanitizeInterpolatedValue`.
 * Unknown references are left untouched.
 */
export function interpolatePipelineVariables(template: string, context: any): string {
    if (typeof template !== 'string') { return template; }
    const regex = /\${([^}]+)}/g;
    return template.replace(regex, (match, expression) => {
        let foundValue: any;
        const parts = expression.split('.');
        const stepId = parts[0];
        const property = parts.slice(1).join('.');
        if (context[stepId] && property && context[stepId][property] !== undefined) { foundValue = context[stepId][property]; }
        else if (context[stepId] && context[stepId].output !== undefined) { foundValue = context[stepId].output; }
        else if (context[stepId] && context[stepId].outputDir !== undefined) { foundValue = context[stepId].outputDir; }
        else if (context[expression] !== undefined) { foundValue = context[expression]; }
        const sanitized = sanitizeInterpolatedValue(foundValue);
        if (sanitized !== undefined) { return sanitized; }
        return match;
    });
}

// ============================================================================
// Task graph utilities (roadmap §4 — Parallel Execution / Task DAG)
//
// These helpers are pure (no `vscode`, no I/O) so the scheduler decisions
// can be tested independently of the executor. The runtime scheduler in
// `extension.ts` consumes `buildTaskGraph` + `TaskScheduler`; TaskHub
// Doctor can later reuse `inferTaskDependencies` for an info-level
// "implicit dep" warning.
// ============================================================================

/**
 * Extract the head identifier from every `${...}` reference in `text`.
 * For `${buildA.output}` returns `"buildA"`. The pattern mirrors
 * `interpolatePipelineVariables`, so what the runtime substitutes and
 * what the graph treats as a dependency stay in sync automatically.
 */
export function extractVariableHeads(text: string): string[] {
    if (typeof text !== 'string' || text.length === 0) { return []; }
    const heads: string[] = [];
    const re = /\${([^}]+)}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const expr = m[1];
        if (!expr) { continue; }
        const head = expr.split('.')[0].trim();
        if (head.length > 0) { heads.push(head); }
    }
    return heads;
}

// `output.capture` and `output.diagnostics` contain regex patterns
// rather than interpolated text — skip those subtrees during the
// string walk so a `${...}` literal inside a regex is not mistaken
// for a task reference.
const TASK_INFER_SKIP_KEYS: ReadonlySet<string> = new Set(['capture', 'diagnostics']);

/**
 * Variable heads that are reserved by the runtime's interpolation
 * context and therefore must NOT be auto-inferred as task dependencies,
 * even if a task happens to be named the same. Without this filter, a
 * task named `workspaceFolder` would steal every `${workspaceFolder}`
 * reference and could create false-positive cycles (sequential task
 * after such a task auto-inferring it as a dep while the task itself
 * was barriered against the rest of the action).
 *
 * Colon-prefixed namespaces (`env:VAR`, `input:foo`) are handled
 * separately in `inferTaskDependencies` because `extractVariableHeads`
 * preserves the colon in the head.
 */
const RESERVED_VARIABLE_HEADS: ReadonlySet<string> = new Set([
    'workspaceFolder',
    'extensionPath',
]);

/**
 * Variable head prefixes reserved by VS Code-style namespaced
 * built-ins. References whose head starts with one of these are
 * skipped during dependency inference, even if a same-named task
 * happens to exist. Intentionally specific (NOT a blanket
 * `head.includes(':')`) — the schema does not forbid colons in task
 * ids, so a user-defined `id: 'build:fw'` referenced via
 * `${build:fw.output}` must still be auto-inferred as a dep.
 * Otherwise a `parallel: true` consumer would race its producer.
 */
const RESERVED_HEAD_PREFIXES: ReadonlyArray<string> = ['env:', 'input:'];

/** Task object keys whose value can be a per-platform `{windows,macos,linux}` object. */
const PLATFORM_BRANCH_KEYS: ReadonlySet<string> = new Set(['command', 'tool', 'itemsFromCommand']);

function pickPlatformBranch(
    obj: Record<string, unknown>,
    platform: NodeJS.Platform
): unknown {
    if (platform === 'win32') { return obj.windows; }
    if (platform === 'darwin') { return obj.macos; }
    if (platform === 'linux') { return obj.linux; }
    return undefined;
}

/**
 * Return a shallow projection of `task` where each platform-branched
 * field (currently `command` / `tool` / `itemsFromCommand`) is replaced by the value of the
 * active platform's branch — mirroring what `getCommandString` /
 * `getToolCommand` actually execute. Non-active branches are dropped,
 * so a `${A.output}` reference that only appears in (say) the linux
 * branch is no longer scanned on Windows. Without this projection, a
 * cross-platform action with each platform referring to a different
 * sibling could trip `validateTaskGraph` on a cycle that doesn't exist
 * for the current platform.
 *
 * The projection is shallow on purpose: only top-level `command` /
 * `tool` / `itemsFromCommand` are platform-branched in the schema, so we
 * don't recurse into sub-objects (e.g. `output.*` fields are not
 * platform-keyed).
 */
function projectActivePlatformBranches(task: unknown, platform: NodeJS.Platform): unknown {
    if (!task || typeof task !== 'object' || Array.isArray(task)) { return task; }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(task as Record<string, unknown>)) {
        if (PLATFORM_BRANCH_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
            const branch = pickPlatformBranch(v as Record<string, unknown>, platform);
            // `undefined` (no entry for this platform) drops the field
            // from the inference view — there is no command/tool to run
            // on this platform, so no string refs to scan.
            if (branch !== undefined) { result[k] = branch; }
        } else {
            result[k] = v;
        }
    }
    // When `itemsFromCommand` is present, static `items` never executes at
    // runtime: either the command populates the pick list (items ignored), or
    // — for a per-platform object with no branch for the active platform — the
    // dispatcher's `getCommandString` throws, same as `command` (there is NO
    // fallback to static `items`). Either way `items` is dead, so drop it from
    // the inference view so stale `${...}` refs in `items` can't fabricate
    // deps/cycles. Checked against the *original* task, not the projected one,
    // because the object form may have just been projected away above.
    const ifc = (task as Record<string, unknown>).itemsFromCommand;
    const hasItemsFromCommand = typeof ifc === 'string' ? ifc.length > 0 : (!!ifc && typeof ifc === 'object');
    if (hasItemsFromCommand) {
        delete result.items;
    }
    return result;
}

function* walkStrings(value: unknown, skipKeys: ReadonlySet<string>): Generator<string> {
    if (typeof value === 'string') { yield value; return; }
    if (value === null || typeof value !== 'object') { return; }
    if (Array.isArray(value)) {
        for (const item of value) { yield* walkStrings(item, skipKeys); }
        return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (skipKeys.has(k)) { continue; }
        yield* walkStrings(v, skipKeys);
    }
}

export interface InferTaskDependenciesOptions {
    /**
     * Platform used to resolve `command` / `tool` per-platform branches.
     * Defaults to `process.platform`. Tests can override to assert
     * deterministic per-platform inference.
     */
    platform?: NodeJS.Platform;
}

/**
 * Infer dependencies for a task from `${taskId.x}` references in its
 * interpolatable string fields. Returns the set of task ids (subset of
 * `validTaskIds`) that this task references. Self-references are
 * excluded.
 *
 * Filtered out *before* the `validTaskIds` lookup:
 *  - `RESERVED_VARIABLE_HEADS` (`workspaceFolder`, `extensionPath`) —
 *    these are runtime built-ins; if a task happens to share the name,
 *    we must not redirect the built-in reference into a fake dep.
 *  - Heads starting with `RESERVED_HEAD_PREFIXES` (`env:`, `input:`) —
 *    VS Code-style namespaced built-ins. The check is on the prefix,
 *    NOT on whether the head merely contains a colon: the schema does
 *    not forbid colons in task ids, so a user-defined id like
 *    `build:fw` referenced via `${build:fw.output}` must still be
 *    auto-inferred as a dep. A blanket `head.includes(':')` filter
 *    would silently drop that dep and let parallel consumers race
 *    their producer.
 *
 * Platform-aware scan: `command` and `tool` may be `{windows, macos,
 * linux}` objects, but the runtime only executes the active branch.
 * The inference walk uses the active branch only, so a `${A.output}`
 * sitting in a non-current platform branch is not mistaken for a real
 * dependency. This avoids cross-platform false-positive cycles where
 * each platform separately resolves to a valid DAG but the union does
 * not.
 *
 * The scan walks all string-valued leaves of the projected task except
 * subtrees keyed by `capture` / `diagnostics`.
 *
 * Bare-id refs in `task.inputs`: `handleUnzip` reads `task.inputs.archive`
 * / `inputs.file` / `inputs.destination` as raw task ids (no `${...}`
 * wrapping) and looks them up in `allResults`. Without inferring those,
 * a `parallel: true` unzip following a zip can be scheduled before the
 * zip populates `allResults`, causing "requires an archive path" at
 * runtime. We inspect every `inputs` value across task types — matching
 * by `validTaskIds` keeps unrelated strings (paths, format names, …)
 * from being misread as deps. `inputs` is not platform-branched, so
 * the projection does not affect this path.
 */
export function inferTaskDependencies(
    task: Task,
    validTaskIds: ReadonlySet<string>,
    options: InferTaskDependenciesOptions = {}
): Set<string> {
    const deps = new Set<string>();
    if (!task || typeof task !== 'object') { return deps; }
    const platform = options.platform ?? process.platform;
    const projected = projectActivePlatformBranches(task, platform);
    for (const str of walkStrings(projected, TASK_INFER_SKIP_KEYS)) {
        for (const head of extractVariableHeads(str)) {
            if (head === task.id) { continue; }
            if (RESERVED_VARIABLE_HEADS.has(head)) { continue; }
            if (RESERVED_HEAD_PREFIXES.some(p => head.startsWith(p))) { continue; }
            if (validTaskIds.has(head)) { deps.add(head); }
        }
    }
    const inputs = (task as unknown as { inputs?: unknown }).inputs;
    if (inputs && typeof inputs === 'object') {
        for (const value of Object.values(inputs as Record<string, unknown>)) {
            if (typeof value !== 'string') { continue; }
            if (value === task.id) { continue; }
            if (validTaskIds.has(value)) { deps.add(value); }
        }
    }
    return deps;
}

/**
 * A node in the runtime task graph. `allDeps` is the union of
 * explicit `dependsOn`, dependencies inferred from variable
 * references, and the implicit "all previous tasks" barrier applied
 * when `parallel` is false/omitted (Option 2 semantics — `parallel`
 * is opt-in concurrency, not opt-out ordering).
 */
export interface TaskGraphNode {
    id: string;
    index: number;
    parallel: boolean;
    explicitDeps: ReadonlySet<string>;
    inferredDeps: ReadonlySet<string>;
    barrierDeps: ReadonlySet<string>;
    allDeps: ReadonlySet<string>;
}

export interface TaskGraph {
    nodes: ReadonlyMap<string, TaskGraphNode>;
    order: readonly string[];
}

export interface TaskGraphBuildOptions {
    /**
     * If true, `dependsOn` entries that reference a missing task id
     * are silently dropped from the node's `explicitDeps` set
     * instead of being preserved. Used by Preview Run / linter
     * paths where the graph is built tolerantly; the executor
     * leaves this false so a runtime mismatch surfaces clearly.
     */
    dropMissingDeps?: boolean;
    /**
     * Platform forwarded to `inferTaskDependencies` so that
     * platform-branched fields (`command` / `tool`) only contribute
     * dependencies from the active branch. Defaults to
     * `process.platform`. Tests set this explicitly to assert
     * deterministic per-platform behavior.
     */
    platform?: NodeJS.Platform;
}

export function buildTaskGraph(
    tasks: ReadonlyArray<Task>,
    options: TaskGraphBuildOptions = {}
): TaskGraph {
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') { validIds.add(t.id); }
    }

    const nodes = new Map<string, TaskGraphNode>();
    const order: string[] = [];
    const previousIds: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!task || typeof task.id !== 'string') { continue; }
        const id = task.id;
        const parallel = task.parallel === true;

        const explicit = new Set<string>();
        for (const dep of task.dependsOn ?? []) {
            if (typeof dep !== 'string' || dep === id) { continue; }
            if (options.dropMissingDeps && !validIds.has(dep)) { continue; }
            explicit.add(dep);
        }

        const inferred = inferTaskDependencies(task, validIds, { platform: options.platform });

        const barrier = new Set<string>();
        if (!parallel) {
            for (const prev of previousIds) { barrier.add(prev); }
        }

        const all = new Set<string>([...explicit, ...inferred, ...barrier]);
        all.delete(id);

        nodes.set(id, {
            id,
            index: i,
            parallel,
            explicitDeps: explicit,
            inferredDeps: inferred,
            barrierDeps: barrier,
            allDeps: all,
        });
        order.push(id);
        previousIds.push(id);
    }

    return { nodes, order };
}

/**
 * Promise-chain mutex that serializes entry into interactive task
 * handlers (modal dialogs, quick-picks) so two `parallel: true`
 * interactive tasks cannot show modal UI concurrently. Each caller's
 * `fn` runs only after the previous holder's promise settles — a
 * failing holder doesn't poison the chain because we swallow the
 * rejection on the wait side; rejections of `fn` itself still
 * propagate out to the caller. Sequential pipelines never contend.
 *
 * Scope: the chain is module-global, so two *different* actions
 * running concurrently with `parallel: true` interactive tasks also
 * serialize their prompts across actions. This is intentional —
 * VS Code only renders one modal dialog at a time, so cross-action
 * serialization matches the platform's actual constraint.
 *
 * Invariant: the lock is held until `fn()`'s returned promise
 * settles, *regardless* of what the caller does with the Promise
 * this function returns. Callers that wrap our return value in a
 * separate timeout race (e.g. `withTaskTimeout`) do not release the
 * lock when the outer race rejects — only the underlying `fn`
 * settling does. This matters because VS Code modal dialogs can't
 * be programmatically dismissed: releasing on outer timeout would
 * let the next interactive task open a second dialog on top of the
 * still-visible first one.
 */
let interactivePromptChain: Promise<void> = Promise.resolve();
export function withInteractivePromptLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = interactivePromptChain;
    let release!: () => void;
    interactivePromptChain = new Promise<void>(resolve => { release = resolve; });
    return previous
        .catch(() => { /* previous holder's failure must not poison the chain */ })
        .then(fn)
        .finally(() => { release(); });
}

/**
 * True when an action contains at least one task marked
 * `parallel: true`. The executor uses this to decide whether to
 * isolate streamed-task terminal groups and `output.mode: 'terminal'`
 * terminal keys per-task; sequential actions keep the historical
 * shared-terminal behavior.
 */
export function actionUsesParallelTasks(action: { tasks: ReadonlyArray<Task> }): boolean {
    if (!action || !Array.isArray(action.tasks)) { return false; }
    for (const t of action.tasks) {
        if (t && t.parallel === true) { return true; }
    }
    return false;
}

/**
 * Issues that make a `TaskGraph` unsafe to execute. Surfaced by
 * `validateTaskGraph`; the runtime turns them into a clear pipeline
 * failure instead of waiting on a dependency that will never
 * complete.
 *
 * - `self-dependency`: a task lists itself in `dependsOn`.
 *   `buildTaskGraph` already drops the entry so the in-memory graph
 *   stays sound, but the original config is still wrong and the
 *   user should hear about it.
 * - `missing-dependency`: a `dependsOn` entry references a task id
 *   that doesn't exist in the same action. `buildTaskGraph` preserves
 *   the entry in `explicitDeps` so the executor can deadlock-detect
 *   here instead of stalling silently.
 * - `cycle`: a directed cycle in the union of explicit / inferred /
 *   barrier dependencies. Includes auto-inferred deps so two tasks
 *   that reference each other's output are caught.
 */
export type TaskGraphIssue =
    | { kind: 'self-dependency'; taskId: string }
    | { kind: 'missing-dependency'; taskId: string; missingId: string }
    | { kind: 'cycle'; cycle: string[] };

/**
 * Returns every reason the graph is unsafe to execute, in a fixed
 * order: self-deps and missing-deps in declaration order, then a
 * single cycle if one exists. Empty array means the graph is a DAG
 * with no dangling references. Pure — callers pass it the same
 * `tasks` array used to build the graph.
 */
export function validateTaskGraph(tasks: ReadonlyArray<Task>, graph: TaskGraph): TaskGraphIssue[] {
    const issues: TaskGraphIssue[] = [];
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') { validIds.add(t.id); }
    }

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string') { continue; }
        if (!Array.isArray(task.dependsOn)) { continue; }
        for (const dep of task.dependsOn) {
            if (typeof dep !== 'string') { continue; }
            if (dep === task.id) {
                issues.push({ kind: 'self-dependency', taskId: task.id });
                continue;
            }
            if (!validIds.has(dep)) {
                issues.push({ kind: 'missing-dependency', taskId: task.id, missingId: dep });
            }
        }
    }

    const cycle = detectGraphCycle(graph);
    if (cycle) { issues.push({ kind: 'cycle', cycle }); }
    return issues;
}

/**
 * Single-source human-readable formatter for `TaskGraphIssue` so the
 * runtime executor (`extension.ts`) and Preview Run share one
 * phrasing. Doctor uses its own per-issue formatting (because it needs
 * to prefix with the action id), but the underlying classification
 * comes from the same `validateTaskGraph` call.
 */
export function formatGraphIssue(issue: TaskGraphIssue): string {
    switch (issue.kind) {
        case 'self-dependency':
            return `task '${issue.taskId}' depends on itself`;
        case 'missing-dependency':
            return `task '${issue.taskId}' depends on unknown task '${issue.missingId}'`;
        case 'cycle':
            return `dependency cycle: ${issue.cycle.join(' -> ')}`;
    }
}

/**
 * Detect cycles in the graph. Returns null if the graph is a DAG,
 * or a sample cycle (sequence of node ids that loops back on itself)
 * if a cycle exists. Uses three-color DFS for parity with
 * `src/doctor.ts` `dependsOn.cycle` so the runtime and the linter
 * agree on cycle structure.
 */
export function detectGraphCycle(graph: TaskGraph): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of graph.nodes.keys()) { color.set(id, WHITE); }
    const stack: string[] = [];
    let found: string[] | null = null;

    const visit = (id: string): void => {
        if (found) { return; }
        const state = color.get(id) ?? WHITE;
        if (state === BLACK) { return; }
        if (state === GRAY) {
            const idx = stack.indexOf(id);
            // `idx < 0` should be unreachable: GRAY means we entered the
            // node and pushed it onto `stack` higher up in the DFS, so
            // the id MUST be present. The `[id, id]` fallback is a
            // defensive escape — if it ever fires, the resulting "A -> A"
            // message is unmistakable enough to flag the broken invariant.
            found = idx >= 0 ? [...stack.slice(idx), id] : [id, id];
            return;
        }
        color.set(id, GRAY);
        stack.push(id);
        for (const next of graph.nodes.get(id)?.allDeps ?? []) { visit(next); }
        stack.pop();
        color.set(id, BLACK);
    };
    for (const id of graph.nodes.keys()) {
        if (found) { break; }
        if ((color.get(id) ?? WHITE) === WHITE) { visit(id); }
    }
    return found;
}

export interface TaskSchedulerOptions {
    maxConcurrency: number;
}

/**
 * Stateful scheduler for executing a `TaskGraph` with bounded
 * concurrency. Pure (no I/O / `vscode` deps) so the scheduling
 * decisions can be unit-tested independently of the executor.
 *
 * Lifecycle:
 *   1. `nextReady()` returns the next batch of task ids that may
 *      start immediately, capped at `maxConcurrency - running`.
 *      Returned in original declaration order for determinism.
 *   2. Caller `markStarted(id)` before spawning, then on completion
 *      either `markCompleted(id)` (success OR continueOnError skip
 *      — both unblock dependents per existing pipeline behavior)
 *      or `markFailed(id)` (stops new scheduling; in-flight tasks
 *      must still be awaited by the caller).
 *   3. Loop while `isFinished()` is false.
 */
export class TaskScheduler {
    private readonly graph: TaskGraph;
    private readonly maxConcurrency: number;
    private readonly remainingDeps = new Map<string, Set<string>>();
    private readonly status = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
    private running = 0;
    private aborted = false;

    constructor(graph: TaskGraph, options: TaskSchedulerOptions) {
        if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency < 1) {
            throw new Error(`maxConcurrency must be >= 1, got ${options.maxConcurrency}`);
        }
        this.graph = graph;
        this.maxConcurrency = Math.floor(options.maxConcurrency);
        for (const [id, node] of graph.nodes) {
            this.remainingDeps.set(id, new Set(node.allDeps));
            this.status.set(id, 'pending');
        }
    }

    nextReady(): string[] {
        if (this.aborted) { return []; }
        const slots = this.maxConcurrency - this.running;
        if (slots <= 0) { return []; }
        const ready: string[] = [];
        for (const id of this.graph.order) {
            if (ready.length >= slots) { break; }
            if (this.status.get(id) !== 'pending') { continue; }
            const remaining = this.remainingDeps.get(id);
            if (remaining && remaining.size === 0) { ready.push(id); }
        }
        return ready;
    }

    markStarted(id: string): void {
        const current = this.status.get(id);
        if (current !== 'pending') {
            throw new Error(`Cannot start task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'running');
        this.running++;
    }

    markCompleted(id: string): void {
        const current = this.status.get(id);
        if (current !== 'running') {
            throw new Error(`Cannot complete task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'done');
        this.running--;
        for (const deps of this.remainingDeps.values()) { deps.delete(id); }
    }

    markFailed(id: string): void {
        const current = this.status.get(id);
        if (current !== 'running') {
            throw new Error(`Cannot fail task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'failed');
        this.running--;
        this.aborted = true;
    }

    runningCount(): number { return this.running; }
    isAborted(): boolean { return this.aborted; }

    isFinished(): boolean {
        if (this.aborted) { return this.running === 0; }
        for (const s of this.status.values()) {
            if (s === 'pending' || s === 'running') { return false; }
        }
        return true;
    }
}

/**
 * Resolve a `command` value which may be a raw string or a per-platform object
 * (`{ windows, macos, linux }`) to a single string for the current platform.
 */
export function getCommandString(command: any): string {
    if (typeof command === 'string') { return command; }
    if (typeof command === 'object' && command !== null) {
        const platform = process.platform;
        if (platform === 'win32' && command.windows) { return command.windows; }
        else if (platform === 'darwin' && command.macos) { return command.macos; }
        else if (platform === 'linux' && command.linux) { return command.linux; }
    }
    throw new Error(`Invalid or unsupported 'command' property for the current platform (${process.platform}). Provide a string or an object with platform-specific entries.`);
}

/**
 * Resolve a `tool` value (string or per-platform object) to a shell-safe command
 * fragment. Adds surrounding double quotes only if the path contains spaces.
 */
export function getToolCommand(tool: any): string {
    let toolCommand: string | undefined;
    if (typeof tool === 'string') {
        toolCommand = tool;
    } else if (typeof tool === 'object' && tool !== null) {
        const platform = process.platform;
        if (platform === 'win32' && tool.windows) { toolCommand = tool.windows; }
        else if (platform === 'darwin' && tool.macos) { toolCommand = tool.macos; }
        else if (platform === 'linux' && tool.linux) { toolCommand = tool.linux; }
    }

    if (!toolCommand) {
        throw new Error(`No tool path specified for the current platform (${process.platform}) in actions.json`);
    }

    // Quote the command if it contains spaces to handle paths like "C:\Program Files\..."
    if (toolCommand.includes(' ') && !toolCommand.startsWith('"')) {
        toolCommand = `"${toolCommand}"`;
    }
    return toolCommand;
}

/**
 * Split a shell-like command string into tokens, respecting single/double
 * quotes. Double-quoted strings support `\"` and `\\` escapes. Note that this
 * is intentionally minimal — it does NOT understand backticks, variable
 * expansion, or operators like `&&`, `|`. It is only used to separate
 * `executable` from `args`; final shell metacharacter handling is deferred to
 * the per-platform quoting helpers below.
 */
export function tokenizeCommandLine(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: string | null = null;

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quoteChar) {
            if (char === quoteChar) {
                quoteChar = null;
            } else if (char === '\\' && quoteChar === '"' && i + 1 < command.length) {
                const next = command[i + 1];
                if (next === '"' || next === '\\') {
                    current += next;
                    i++;
                } else {
                    current += char;
                }
            } else {
                current += char;
            }
        } else if (char === '"' || char === '\'') {
            quoteChar = char;
        } else if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

/**
 * Take a raw command string and extra args, and return the executable as a
 * separate token from the (combined) arg list.
 */
export function mergeCommandAndArgs(command: string, extraArgs: string[]): { executable: string; args: string[] } {
    const baseTokens = tokenizeCommandLine(command.trim());
    if (baseTokens.length === 0) {
        throw new Error('Cannot execute an empty command.');
    }
    const executable = baseTokens[0];
    const initialArgs = baseTokens.slice(1);
    const combinedArgs = [...initialArgs, ...(extraArgs || [])];
    return { executable, args: combinedArgs };
}

/**
 * Single-quote an argument for PowerShell. Inside PowerShell single quotes,
 * everything is literal except another single quote, which is escaped as `''`.
 */
export function quotePowerShellArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote one Windows process argument using the CommandLineToArgvW-compatible
 * backslash / double-quote rules. This is for APIs that accept one command-line
 * string (for example ProcessStartInfo.Arguments), not for PowerShell parsing.
 */
export function quoteWindowsCommandLineArgument(value: string): string {
    if (value.length > 0 && !/[\s"]/u.test(value)) {
        return value;
    }
    let result = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === '\\') {
            backslashes++;
            continue;
        }
        if (char === '"') {
            result += '\\'.repeat(backslashes * 2 + 1);
            result += '"';
            backslashes = 0;
            continue;
        }
        if (backslashes > 0) {
            result += '\\'.repeat(backslashes);
            backslashes = 0;
        }
        result += char;
    }
    if (backslashes > 0) {
        result += '\\'.repeat(backslashes * 2);
    }
    result += '"';
    return result;
}

function displayCommandPart(value: string): string {
    return /^[A-Za-z0-9_./\\:-]+$/.test(value)
        ? value
        : quoteWindowsCommandLineArgument(value);
}

// cmd.exe builtins / common PowerShell aliases that have no backing `.exe` —
// these must stay on the PowerShell path (`& 'echo' ...` resolves the alias).
const WINDOWS_SHELL_COMMANDS = new Set([
    'cat', 'cd', 'chdir', 'cls', 'copy', 'cp', 'del', 'dir', 'echo', 'erase',
    'ls', 'md', 'mkdir', 'move', 'mv', 'popd', 'pushd', 'pwd', 'rd', 'ren',
    'rename', 'rm', 'rmdir', 'set', 'sleep', 'start', 'type'
]);

// Extensions the OS process loader can start directly (`spawn(file)` without a
// shell). `.cmd` / `.bat` / `.ps1` / `.js` / `.py` / … are scripts or shims
// that need a shell or interpreter, so those stay on the PowerShell path.
const WINDOWS_DIRECT_LAUNCH_EXTENSIONS = ['.exe', '.com'];

/**
 * Injectable filesystem/environment view used by {@link windowsCommandIsDirectlyLaunchable}
 * so PATH resolution can be unit-tested deterministically.
 */
export interface WindowsExecutableLookup {
    env: NodeJS.ProcessEnv;
    isFile: (filePath: string) => boolean;
}

const defaultWindowsExecutableLookup: WindowsExecutableLookup = {
    env: process.env,
    isFile: (filePath: string): boolean => {
        try {
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    },
};

/**
 * Whether a Windows command can be launched as a native process
 * (`spawn(file, argvArray)` / `vscode.ProcessExecution`) instead of going
 * through PowerShell. Native launch is preferred because the argv array is
 * passed straight to the child, side-stepping Windows PowerShell 5.1's legacy
 * quote-mangling for arguments containing `"`.
 *
 *   - explicit `.exe` / `.com` extension                → yes (no lookup)
 *   - explicit other extension (`.cmd`, `.bat`, `.ps1`,
 *     `.js`, …)                                          → no  (scripts/shims)
 *   - shell builtin / alias (`echo`, `dir`, `cd`, …)     → no
 *   - extensionless name: search PATH for `name.exe` /
 *     `name.com` (also checks `name` when it carries a
 *     path separator)                                    → yes iff found
 *
 * A name that exists only as a `.cmd` shim (`npm` → `npm.cmd`, also `npx` /
 * `pnpm` / `yarn`) therefore stays on the PowerShell path, where `&` performs
 * the PATHEXT resolution. The lookup is only invoked on Windows (the POSIX path
 * uses `sh -c`), so its cost is Windows-only and runs once per task launch.
 *
 * `lookup` may override `env` and/or `isFile`; whatever isn't supplied falls
 * back to `process.env` / a real `fs.statSync`. Callers MUST pass the **task's
 * effective env** (`{ ...process.env, ...envOverrides }` — i.e. the same env the
 * child will run with) so a `PATH` extended via `task.env.PATH` is honoured here
 * too; otherwise a toolchain `.exe` could be misjudged and routed through
 * PowerShell (re-triggering the very quote bug this avoids).
 */
export function windowsCommandIsDirectlyLaunchable(
    command: string,
    args: string[] = [],
    lookup: Partial<WindowsExecutableLookup> = {}
): boolean {
    const env = lookup.env ?? defaultWindowsExecutableLookup.env;
    const isFile = lookup.isFile ?? defaultWindowsExecutableLookup.isFile;
    const { executable } = mergeCommandAndArgs(command, args);
    const base = (executable.split(/[\\/]/).pop() || executable).toLowerCase();
    const dotIndex = base.lastIndexOf('.');
    if (dotIndex > 0) {
        return WINDOWS_DIRECT_LAUNCH_EXTENSIONS.includes(base.slice(dotIndex));
    }
    if (WINDOWS_SHELL_COMMANDS.has(base)) {
        return false;
    }
    const hasSeparator = /[\\/]/.test(executable);
    const searchDirs = hasSeparator ? [''] : (env.PATH ?? env.Path ?? '').split(';');
    for (const dir of searchDirs) {
        for (const ext of WINDOWS_DIRECT_LAUNCH_EXTENSIONS) {
            const candidate = hasSeparator
                ? executable + ext
                : (dir ? path.win32.join(dir, executable + ext) : executable + ext);
            if (isFile(candidate)) {
                return true;
            }
        }
    }
    return false;
}

export interface NativeCommandInvocation {
    executable: string;
    args: string[];
    display: string;
}

export function buildNativeCommandInvocation(command: string, args: string[]): NativeCommandInvocation {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    return {
        executable,
        args: combinedArgs,
        display: [executable, ...combinedArgs].map(displayCommandPart).join(' '),
    };
}

/**
 * Build a PowerShell invocation script (`& 'exe' 'arg1' 'arg2'`) plus a
 * display string for logs. When `enforceUtf8Console` is true, the script
 * prepends a `[Console]::OutputEncoding = UTF8` directive.
 */
export function buildPowerShellInvocation(command: string, args: string[], enforceUtf8Console: boolean): { script: string; display: string } {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const quotedExe = quotePowerShellArgument(executable);
    const quotedArgs = combinedArgs.map(arg => quotePowerShellArgument(arg));
    const invocation = `& ${quotedExe}${quotedArgs.length ? ' ' + quotedArgs.join(' ') : ''}`;
    const prefix = enforceUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
    const script = `${prefix}${invocation}`;
    return { script, display: invocation };
}

/** Encode a PowerShell script as UTF-16 LE Base64, suitable for `-EncodedCommand`. */
export function encodePowerShellScript(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Single-quote an argument for POSIX shells (sh/bash/zsh). Inside single
 * quotes, everything is literal except another single quote, which is escaped
 * via the `'\''` idiom.
 */
export function quotePosixArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a POSIX-shell command line (`exe 'arg1' 'arg2'`). The executable is
 * only quoted if it contains a character outside the safe set — keeping
 * pathless names like `npm` readable in logs.
 */
/**
 * `shell` 타입의 실행 문자열 (0.6.47).
 *
 * `command` 문자열을 **셸에 그대로** 넘긴다 — `&&`, `|`, `>`, `$VAR` 가 모두
 * 셸 문법으로 동작한다. `buildPosixCommandLine` 은 반대로 토큰마다 인용해
 * argv 로 만든다(그쪽이 `command` 타입의 계약이다).
 *
 * `args` 는 뒤에 **인용해서** 붙인다. 공백이 든 경로를 안전하게 넘기는 통로가
 * 그대로 필요하기 때문이다 — raw 문자열 안에 그런 값을 보간하면 셸이 쪼갠다.
 */
export function buildRawShellCommandLine(command: string, args: string[]): string {
    const trimmed = command.trim();
    if (!args || args.length === 0) { return trimmed; }
    return `${trimmed} ${args.map(arg => quotePosixArgument(arg)).join(' ')}`;
}

/** {@link buildRawShellCommandLine} 의 PowerShell 판. */
export function buildRawPowerShellCommandLine(command: string, args: string[]): string {
    const trimmed = command.trim();
    if (!args || args.length === 0) { return trimmed; }
    return `${trimmed} ${args.map(arg => quotePowerShellArgument(arg)).join(' ')}`;
}

export function buildPosixCommandLine(command: string, args: string[]): string {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const commandPart = /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : quotePosixArgument(executable);
    const parts = [commandPart, ...combinedArgs.map(arg => quotePosixArgument(arg))];
    return parts.join(' ');
}

/**
 * Scheme allowlist for external link opening. `command:` / `file:` / `vscode:`
 * and arbitrary custom schemes are rejected so a malicious links.json cannot
 * invoke VS Code commands or launch OS-registered handlers.
 */
export const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

export type LinkSchemeValidation =
    | { ok: true; scheme: string; url: string }
    | { ok: false; reason: 'empty' | 'invalid' }
    | { ok: false; reason: 'scheme'; scheme: string };

/**
 * Validate a raw URL string against {@link ALLOWED_LINK_SCHEMES}. Kept free of
 * any `vscode` dependency so it can be unit-tested directly.
 */
export function validateLinkScheme(rawUrl: unknown): LinkSchemeValidation {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return { ok: false, reason: 'empty' };
    }
    // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    const match = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rawUrl);
    if (!match) {
        return { ok: false, reason: 'invalid' };
    }
    const scheme = match[1].toLowerCase();
    if (!ALLOWED_LINK_SCHEMES.has(scheme)) {
        return { ok: false, reason: 'scheme', scheme };
    }
    return { ok: true, scheme, url: rawUrl };
}

export type LinkUrlSaveValidation =
    | { ok: true }
    | { ok: false; reason: 'empty' | 'invalid' }
    | { ok: false; reason: 'scheme'; scheme: string };

/**
 * Save-time URL gate used by both `taskhub.addLink` and the workspace link
 * edit flow. Combines two checks:
 *
 *   1. {@link validateLinkScheme} — only http/https/mailto are allowed.
 *   2. WHATWG `new URL()` parsing — catches inputs that the regex-only
 *      scheme check would let through, notably bare scheme-only strings
 *      like `https://` / `http://` and an unterminated IPv6 literal like
 *      `https://[invalidIPv6`. Without (2) the prior v0.4.32 patch claimed
 *      to block "format errors" but in practice those strings still
 *      slipped past the InputBox validator and the user got an "Invalid
 *      URL format" toast at click time instead.
 *
 * Known WHATWG limitations the gate does *not* catch (so callers still
 * have a click-time fail-safe via `vscode.Uri.parse(..., true)`):
 *
 *   - `https:///path` — WHATWG normalizes consecutive slashes after the
 *     scheme, so this becomes `https://path/` (host = 'path', pathname =
 *     '/'). The user's intent ("hostless URL with /path") is silently
 *     reinterpreted into a request to the host literally named `path`.
 *     The gate accepts the input because `new URL()` does not throw.
 *   - `mailto:` (empty), `mailto:not-an-email` — `new URL` does not
 *     validate the local-part / domain. Accepted; the mail client will
 *     reject on send.
 *
 * Returns a tagged result so the caller can localize messages itself —
 * keeping this function vscode-free preserves the unit-test seam.
 */
export function validateLinkUrlForSave(rawUrl: unknown): LinkUrlSaveValidation {
    const scheme = validateLinkScheme(rawUrl);
    if (!scheme.ok) {
        if (scheme.reason === 'scheme') {
            return { ok: false, reason: 'scheme', scheme: scheme.scheme };
        }
        return { ok: false, reason: scheme.reason };
    }
    try {
        new URL(scheme.url);
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    return { ok: true };
}

/**
 * Resolve a favorite entry's path to an absolute path that is guaranteed to
 * live inside one of the current workspace roots. Throws (via
 * {@link resolveWithinWorkspace}) when the path escapes the workspace — even
 * if the user hand-crafted `.vscode/favorites.json` with `../` traversal or
 * an absolute path to elsewhere on disk.
 */
export function resolveFavoriteFilePath(
    rawPath: string,
    workspaceFolderPath: string,
    workspaceRoots: string[]
): string {
    const interpolated = rawPath.replace('${workspaceFolder}', workspaceFolderPath || '');
    return resolveWithinWorkspace(interpolated, workspaceRoots, workspaceFolderPath || undefined);
}

/**
 * Convert an absolute file path to a `${workspaceFolder}`-relative form when
 * the file lives inside the given workspace root. Returns the original path
 * otherwise. Used so that favorites / links stored in `.vscode/*.json` stay
 * portable across machines (the schema already documents this as the
 * preferred form; see favorites_example.json).
 *
 * Output always uses POSIX-style separators (`/`) to keep the serialized
 * JSON stable across Windows/macOS/Linux collaborators.
 */
export function toWorkspaceRelativePath(absolutePath: string, workspaceFolderPath: string | undefined): string {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
        return absolutePath;
    }
    if (!workspaceFolderPath) {
        return absolutePath;
    }
    const normalizedRoot = path.resolve(workspaceFolderPath);
    const normalizedTarget = path.resolve(absolutePath);
    const rel = path.relative(normalizedRoot, normalizedTarget);
    if (rel === '' ) {
        return '${workspaceFolder}';
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return absolutePath;
    }
    return '${workspaceFolder}/' + rel.split(path.sep).join('/');
}

/**
 * Normalize line endings of `content` according to `eol`.
 *   - `lf`   : every CRLF becomes LF (lone CRs are left alone).
 *   - `crlf` : every LF becomes CRLF. Existing CRLF sequences are preserved
 *              (we collapse to LF first so we never emit CRCRLF).
 *   - `keep` : content is returned unchanged.
 * Anything else is treated as `keep`.
 */
export function normalizeEol(content: string, eol: 'lf' | 'crlf' | 'keep' | undefined): string {
    if (eol === 'lf') { return content.replace(/\r\n/g, '\n'); }
    if (eol === 'crlf') { return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
    return content;
}

/**
 * Encode `content` into a Buffer for `writeFile` / `appendFile`.
 *   - `utf8`    : plain UTF-8 bytes, no BOM.
 *   - `utf8bom` : UTF-8 bytes prefixed with the 3-byte BOM (EF BB BF). When
 *                 `includeBom` is false (e.g. append to an existing file) the
 *                 BOM is omitted so we do not plant a BOM mid-file.
 *   - `ascii`   : Node's `ascii` encoding; non-ASCII characters get replaced
 *                 by `?` — callers should validate inputs if that matters.
 */
export function encodeFileContent(
    content: string,
    encoding: 'utf8' | 'utf8bom' | 'ascii' | undefined,
    includeBom: boolean = true
): Buffer {
    if (encoding === 'ascii') {
        return Buffer.from(content, 'ascii');
    }
    if (encoding === 'utf8bom') {
        const utf8 = Buffer.from(content, 'utf8');
        return includeBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8;
    }
    return Buffer.from(content, 'utf8');
}

/**
 * Race `promise` against a timer of `timeoutSeconds`. On timeout, rejects with
 * an Error whose message includes `taskId`. When the timer fires, `onTimeout`
 * is invoked so the caller can kick off side-effect cleanup (e.g. terminate a
 * running child process); the original `promise` still runs to completion but
 * its eventual result is discarded. A non-positive or undefined
 * `timeoutSeconds` disables the timeout entirely and returns `promise` as-is.
 *
 * This helper is intentionally free of `vscode` dependencies so it can be
 * unit-tested in isolation. It does NOT silence unhandled rejections from the
 * original promise — callers should attach a catch handler if the task is
 * expected to reject after the timeout.
 */
export function withTaskTimeout<T>(
    promise: Promise<T>,
    timeoutSeconds: number | undefined,
    taskId: string,
    onTimeout?: () => void
): Promise<T> {
    if (!timeoutSeconds || timeoutSeconds <= 0 || !Number.isFinite(timeoutSeconds)) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) { return; }
            settled = true;
            try { onTimeout?.(); } catch { /* swallow — best effort */ }
            const timeoutError = new Error(`Task '${taskId}' timed out after ${timeoutSeconds}s.`);
            // 호출부가 실패 원인을 **분류**해야 한다(비밀을 쓰는 태스크는 상세
            // 출력을 가리는 대신 단계만 보여 준다). 메시지 문자열 매칭은 문구가
            // 바뀌면 조용히 깨지므로 이름을 남긴다.
            timeoutError.name = 'TaskTimeoutError';
            reject(timeoutError);
        }, timeoutSeconds * 1000);
        promise.then(
            value => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
        // Swallow unhandled rejection if the task settles *after* a timeout.
        // We already surfaced the timeout error above; the original error is
        // just noise at that point.
        promise.catch(() => { /* already reported via timeout */ });
    });
}
