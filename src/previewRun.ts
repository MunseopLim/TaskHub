/**
 * Dry-run / Preview simulation for TaskHub action pipelines.
 *
 * Walks an action's task list without executing any shell commands or opening
 * dialogs, and produces a human-readable report that shows:
 *   - how each task's variables resolve under simulated upstream results
 *   - the final command/cwd/env shape for shell & command tasks
 *   - output mode + file-write target (with workspace-boundary warnings)
 *   - capture rules that would run
 *   - any ${...} references that remain unresolved after interpolation
 *
 * This module is intentionally pure: it has no dependency on `vscode` or the
 * filesystem so it can be unit-tested directly.
 */

import * as path from 'path';
import type { Action, ActionItem, Task, OutputCapture } from './schema';
import {
    interpolatePipelineVariables,
    interpolateCommandPreservingTokens,
    buildNativeCommandInvocation,
    getCommandString,
    buildTaskGraph,
    validateTaskGraph,
    isInsideWorkspaceRoots,
} from './pipelineUtils';

export interface PreviewOptions {
    workspaceFolder: string;
    extensionPath: string;
    /** Workspace root list used to detect file writes outside the workspace. */
    workspaceRoots: string[];
}

export interface SimulatedResult {
    [key: string]: string;
}

/**
 * Placeholder value for a key in a simulated task result. Kept in a distinct
 * shape (`<type:taskId:key>`) so a human reader can spot them in the report.
 */
export function placeholder(type: string, id: string, key?: string): string {
    return key ? `<${type}:${id}:${key}>` : `<${type}:${id}>`;
}

/**
 * Build a best-effort simulated result for a single task, used only to feed
 * downstream tasks' interpolation context during preview / Doctor lint.
 */
export function simulateTaskResult(task: Task): SimulatedResult {
    switch (task.type) {
        case 'fileDialog':
        case 'folderDialog':
            return {
                path: placeholder(task.type, task.id, 'path'),
                dir: placeholder(task.type, task.id, 'dir'),
                name: placeholder(task.type, task.id, 'name'),
                fileNameOnly: placeholder(task.type, task.id, 'fileNameOnly'),
                fileExt: placeholder(task.type, task.id, 'fileExt'),
            };
        case 'inputBox':
            return { value: placeholder('inputBox', task.id, 'value') };
        case 'quickPick':
            return {
                value: placeholder('quickPick', task.id, 'value'),
                values: placeholder('quickPick', task.id, 'values'),
            };
        case 'envPick':
            return { value: placeholder('envPick', task.id, 'value') };
        case 'unzip':
            return { outputDir: placeholder('unzip', task.id, 'outputDir') };
        case 'zip':
            return { archivePath: placeholder('zip', task.id, 'archivePath') };
        case 'stringManipulation':
            return { output: placeholder('stringManipulation', task.id, 'output') };
        case 'confirm':
            return { confirmed: 'true' };
        case 'shell':
        case 'command':
            // 런타임(executeSingleTask)은 passTheResultToNextTask가 falsy면
            // 출력을 스트리밍만 하고 빈 결과를 넘긴다. 시뮬레이션이 무조건
            // output을 만들면 다운스트림 `${id.output}` 참조가 늘 해석되는
            // 것처럼 보여 가장 흔한 설정 실수를 놓친다(M9).
            return task.passTheResultToNextTask
                ? { output: placeholder(task.type, task.id, 'stdout') }
                : {};
        case 'writeFile':
        case 'appendFile':
            return { path: placeholder(task.type, task.id, 'path') };
        default:
            return {};
    }
}

/** Regex to find ${...} references that survived interpolation. */
export const UNRESOLVED_VAR_RE = /\$\{[^}]+\}/g;

/**
 * Walk raw (pre-interpolation) string leaves of a task and report
 * `${id.key}` references that point at an already-simulated task but
 * a key the task did not produce. The runtime's
 * `interpolatePipelineVariables` silently falls back to `.output`
 * when the requested property is missing, which masks typos like
 * `${producer.typoKey}` in post-interpolation strings — so
 * `findUnresolved` alone cannot catch them. This pass runs *before*
 * the fallback would fire and surfaces the original `${...}` literal
 * so the user sees the exact typo to fix.
 *
 * `task.output.capture` and `task.output.diagnostics` subtrees are
 * skipped — their `${...}` literals are regex content, not refs.
 */
export function findTypoRefs(
    task: Task,
    allResults: Record<string, SimulatedResult>,
    selfId: string
): string[] {
    const found = new Set<string>();
    visitTaskRefs(task, (literal, head, key) => {
        if (head === selfId || key === '') { return; }
        const result = allResults[head];
        if (!result) { return; } // forward ref / built-in / unknown
        if (!Object.prototype.hasOwnProperty.call(result, key)) {
            found.add(literal);
        }
    });
    return Array.from(found);
}

/**
 * Walk a task's raw (pre-interpolation) string leaves and invoke `onRef` for
 * every dotted `${head.key}` reference. Bare `${id}` short-forms are skipped.
 * `task.output.capture` / `task.output.diagnostics` / `dependsOn` subtrees
 * are skipped — their `${...}` literals are regex content, not refs.
 * Shared traversal for `findTypoRefs` / `findUncapturedOutputRefs`.
 */
function visitTaskRefs(
    task: Task,
    onRef: (literal: string, head: string, key: string) => void
): void {
    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
                const expr = m[1];
                const dotIdx = expr.indexOf('.');
                if (dotIdx === -1) { continue; } // bare `${id}` short-form
                onRef(m[0], expr.slice(0, dotIdx).trim(), expr.slice(dotIdx + 1).trim());
            }
            return;
        }
        if (value === null || typeof value !== 'object') { return; }
        if (Array.isArray(value)) {
            for (const item of value) { visit(item); }
            return;
        }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === 'capture' || k === 'diagnostics' || k === 'dependsOn') { continue; }
            visit(v);
        }
    };
    visit(task);
}

/**
 * Find `${head.key}` references whose head is a shell/command task that does
 * NOT set `passTheResultToNextTask: true` (M9). 런타임에서 그런 태스크는
 * 출력을 터미널로 스트리밍만 하고 빈 결과를 넘기므로 `.output`도 capture
 * 이름도 존재하지 않아 참조가 리터럴 '${…}'로 셸에 들어간다 — 가장 흔한
 * 파이프라인 설정 실수. 선언 순서와 무관하게(전방 참조 포함) 검출한다.
 *
 * `.output`과 head 태스크의 capture 이름 참조만 보고한다 — 그 외 키는
 * findTypoRefs / findUnresolved 몫.
 *
 * @returns ref literal → head task id
 */
export function findUncapturedOutputRefs(
    task: Task,
    tasksById: Map<string, Task>,
    selfId: string
): Map<string, string> {
    const found = new Map<string, string>();
    visitTaskRefs(task, (literal, head, key) => {
        if (head === selfId || key === '') { return; }
        const headTask = tasksById.get(head);
        if (!headTask || (headTask.type !== 'shell' && headTask.type !== 'command')) { return; }
        if (headTask.passTheResultToNextTask) { return; }
        const captureNames = new Set<string>();
        if (headTask.output?.capture) {
            const rules = Array.isArray(headTask.output.capture) ? headTask.output.capture : [headTask.output.capture];
            for (const r of rules) {
                if (r && typeof r.name === 'string') { captureNames.add(r.name); }
            }
        }
        if (key === 'output' || captureNames.has(key)) {
            found.set(literal, head);
        }
    });
    return found;
}

/**
 * Pull the head identifier out of a matched `${expr}` literal. Mirrors
 * `interpolatePipelineVariables`'s split on `.` so the same head the
 * runtime would look up in the context is what we test for tolerance.
 * Returns `''` if the match is malformed.
 */
function extractRefHead(match: string): string {
    if (!match.startsWith('${') || !match.endsWith('}') || match.length < 4) {
        return '';
    }
    const expr = match.slice(2, -1);
    const dotIdx = expr.indexOf('.');
    return (dotIdx === -1 ? expr : expr.slice(0, dotIdx)).trim();
}

/**
 * Collect every `${...}` reference that survived interpolation across the
 * given values. When `toleratedHeads` is provided, references whose head
 * (the `id` in `${id.key}`) belongs to that set are suppressed — used by
 * Doctor and Preview Run to silence *future-task* false positives where a
 * task in declaration order references a sibling that's only present in
 * the simulated context after it. The runtime's graph scheduler honors
 * the real dep, so the warning was misleading.
 *
 * Caller responsibility: pass ONLY the forward task ids (those not yet
 * simulated / not yet in `allResults`). If you also pass already-executed
 * ids, you suppress `${alreadyRan.typoKey}` style typos: at that point
 * the runtime has a real result for `alreadyRan`, the typoed key is
 * genuinely missing, and the user should hear about it. Doctor /
 * Preview compute `forwardTaskIds` per iteration to honor this.
 */
export function findUnresolved(
    values: (string | undefined)[],
    toleratedHeads?: ReadonlySet<string>
): string[] {
    const seen = new Set<string>();
    for (const v of values) {
        if (typeof v !== 'string') { continue; }
        const matches = v.match(UNRESOLVED_VAR_RE);
        if (matches) {
            for (const m of matches) {
                if (toleratedHeads && toleratedHeads.has(extractRefHead(m))) { continue; }
                seen.add(m);
            }
        }
    }
    return Array.from(seen);
}

function formatCaptureRule(rule: OutputCapture): string {
    const parts: string[] = [`name=${rule.name}`];
    if (rule.regex !== undefined) { parts.push(`regex=${JSON.stringify(rule.regex)}`); }
    if (rule.group !== undefined) { parts.push(`group=${rule.group}`); }
    if (rule.flags !== undefined) { parts.push(`flags=${JSON.stringify(rule.flags)}`); }
    if (rule.line !== undefined) { parts.push(`line=${rule.line}`); }
    if (rule.trim) { parts.push('trim=true'); }
    return `{ ${parts.join(', ')} }`;
}

/**
 * 런타임 `resolveWithinWorkspace`와 동일한 규칙(realpath 정규화, Windows
 * 예약 디바이스명)으로 판정하는 dry-run. 어휘적 비교만 쓰면 워크스페이스
 * 내부의 외부 지향 심링크 경로가 Preview/Doctor에서 안전해 보이다가
 * 런타임에서 거부되는 거짓 음성이 생긴다 (M10 후속).
 */
export function isInsideWorkspace(resolved: string, workspaceRoots: string[]): boolean {
    return isInsideWorkspaceRoots(resolved, workspaceRoots);
}

export function resolveFilePathForPreview(
    filePath: string,
    baseDir: string,
    workspaceRoots: string[]
): { resolved: string; outsideWorkspace: boolean } {
    let resolved: string;
    if (path.isAbsolute(filePath)) {
        resolved = path.resolve(filePath);
    } else {
        const base = baseDir && baseDir.length > 0 ? path.resolve(baseDir) : (workspaceRoots[0] ?? '');
        resolved = path.resolve(base, filePath);
    }
    return {
        resolved,
        outsideWorkspace: workspaceRoots.length > 0 && !isInsideWorkspace(resolved, workspaceRoots),
    };
}

/**
 * Build a preview report for a single action. Returns a multi-line string
 * intended for display in an OutputChannel.
 */
export function buildPreviewReport(item: ActionItem, options: PreviewOptions): string {
    const lines: string[] = [];
    const action: Action | undefined = item.action;

    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push(`TaskHub Preview — ${item.title} (${item.id})`);
    lines.push('═══════════════════════════════════════════════════════════════════');

    if (!action || !Array.isArray(action.tasks) || action.tasks.length === 0) {
        lines.push('(this item has no executable action or empty tasks array)');
        return lines.join('\n');
    }

    if (action.description) {
        lines.push(`Description: ${action.description}`);
    }
    lines.push(`Tasks: ${action.tasks.length}`);
    lines.push('');
    lines.push('How to read this report');
    lines.push('───────────────────────');
    lines.push('Simulation only — nothing runs, no files written, no dialogs opened.');
    lines.push('');
    lines.push('Legend:');
    lines.push('  <taskType:id:key>    Simulated upstream task result; replaced at runtime');
    lines.push('                       (e.g. <fileDialog:pick:path>, <shell:run:stdout>).');
    lines.push('  <capture:id:name>    Simulated captured variable from an output.capture rule.');
    lines.push('  ${id.key}            UNRESOLVED — target task/key not found. Usually a typo');
    lines.push('                       or a missing upstream task; at runtime the literal');
    lines.push('                       "${id.key}" will be passed through as-is.');
    lines.push('  → resolves to: ...   Final absolute path after interpolation + workspace check.');
    lines.push('  ⚠️  ...               Warning — review before running.');
    lines.push('');

    const allResults: Record<string, SimulatedResult> = {};
    const totalUnresolved = new Set<string>();

    // Surface graph issues (cycle / missing dep / self dep) up front so
    // Preview Run reflects what the runtime would refuse to schedule.
    // Without this, a cycle like A(parallel)→B + B(barrier)→A could
    // simulate cleanly under the linear walk and report "all resolved",
    // while `executeActionPipeline` would throw at the first task.
    // `dropMissingDeps: true` keeps the rest of the report renderable
    // even when one entry references an unknown id — the issue list
    // still calls it out.
    const previewGraph = buildTaskGraph(action.tasks, { dropMissingDeps: true });
    const graphIssues = validateTaskGraph(action.tasks, previewGraph);
    if (graphIssues.length > 0) {
        lines.push('Graph issues — runtime would reject this action:');
        for (const issue of graphIssues) {
            switch (issue.kind) {
                case 'self-dependency':
                    lines.push(`  ✗ task '${issue.taskId}' depends on itself`);
                    break;
                case 'missing-dependency':
                    lines.push(`  ✗ task '${issue.taskId}' depends on unknown task '${issue.missingId}'`);
                    break;
                case 'cycle':
                    lines.push(`  ✗ dependency cycle: ${issue.cycle.join(' → ')}`);
                    break;
            }
        }
        lines.push('');
    }

    // Forward task ids: ids declared *after* the current iteration in
    // declaration order. The runtime's auto-inference may reorder a
    // declared-later task to run first, so referencing one shouldn't
    // be flagged as unresolved during this linear walk. Updated each
    // loop iteration as `allResults` grows; never includes tasks that
    // have already been simulated, so `${alreadyRan.typoKey}` keeps
    // being reported.
    const knownTaskIds = new Set<string>();
    const tasksById = new Map<string, Task>();
    for (const t of action.tasks) {
        if (t && typeof t.id === 'string') {
            knownTaskIds.add(t.id);
            tasksById.set(t.id, t);
        }
    }

    for (let i = 0; i < action.tasks.length; i++) {
        const task = action.tasks[i];
        const interpolationContext: any = {
            ...allResults,
            workspaceFolder: options.workspaceFolder,
            extensionPath: options.extensionPath,
        };

        // Preview Run simulates tasks in declaration order even though the
        // runtime may schedule `parallel: true` tasks concurrently. The
        // `[parallel]` marker tells the reader which steps the executor
        // can launch alongside their siblings (still subject to
        // `dependsOn` and `${taskId.x}` auto-inferred deps).
        const parallelMarker = task.parallel === true ? ' [parallel]' : '';
        lines.push('───────────────────────────────────────────────────────────────────');
        lines.push(`[${i + 1}/${action.tasks.length}] ${task.id}  (type: ${task.type})${parallelMarker}`);
        lines.push('───────────────────────────────────────────────────────────────────');

        const interpolated: (string | undefined)[] = [];

        switch (task.type) {
            case 'shell':
            case 'command': {
                // 런타임과 **같은 규칙**으로 보간해야 한다 — `command` 는 토큰
                // 경계를 보존하며 보간하고 `shell` 은 문자열을 그대로 넘긴다
                // (0.6.50). 여기서 옛 방식으로 만들면 Preview 가 실제로 실행될
                // argv 와 **다른 것을 보여 준다** — 미리 보기의 존재 이유가
                // 사라진다.
                //
                // 다만 **표시는 읽을 수 있어야 한다.** 토큰 보존 형태는 모든
                // 토큰을 인용하므로(`"cat" "<...>"`) 그대로 찍으면 읽기 나쁘다.
                // 다시 토큰화해 필요한 곳만 인용하는 display 형태로 되돌린다 —
                // 경계는 그대로 드러나고(공백 든 값은 인용된 채 남는다) 사람이
                // 읽기도 좋다.
                const interpolateCommandString = (template: string): string => {
                    if (task.type !== 'command') {
                        return interpolatePipelineVariables(template, interpolationContext);
                    }
                    const preserved = interpolateCommandPreservingTokens(
                        template, value => interpolatePipelineVariables(value, interpolationContext)
                    );
                    return buildNativeCommandInvocation(preserved, []).display;
                };
                let command: string | undefined;
                if (typeof task.command === 'string') {
                    command = interpolateCommandString(task.command);
                } else if (task.command && typeof task.command === 'object') {
                    const cloned: any = JSON.parse(JSON.stringify(task.command));
                    for (const os of Object.keys(cloned)) {
                        cloned[os] = interpolateCommandString(cloned[os]);
                    }
                    try {
                        command = getCommandString(cloned);
                    } catch {
                        command = '(no command for current platform)';
                    }
                }
                const args = (task.args ?? []).map(a => interpolatePipelineVariables(a, interpolationContext));
                const cwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : '(defaults to workspace folder)';
                const env: Record<string, string> = {};
                if (task.env) {
                    for (const [k, v] of Object.entries(task.env)) {
                        if (typeof v === 'string') {
                            env[k] = interpolatePipelineVariables(v, interpolationContext);
                        }
                    }
                }
                lines.push(`  command: ${command ?? '(missing)'}`);
                if (args.length) { lines.push(`  args:    [${args.map(a => JSON.stringify(a)).join(', ')}]`); }
                lines.push(`  cwd:     ${cwd}`);
                if (Object.keys(env).length) {
                    lines.push(`  env:`);
                    for (const [k, v] of Object.entries(env)) {
                        lines.push(`    ${k}=${v}`);
                    }
                }
                lines.push(`  passTheResultToNextTask: ${task.passTheResultToNextTask ? 'true' : 'false'}`);
                if (task.isOneShot) { lines.push(`  isOneShot: true`); }
                interpolated.push(command ?? '', ...args, cwd, ...Object.values(env));
                break;
            }
            case 'inputBox': {
                const prompt = task.prompt ? interpolatePipelineVariables(task.prompt, interpolationContext) : undefined;
                const value = task.value ? interpolatePipelineVariables(task.value, interpolationContext) : undefined;
                const placeHolder = task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined;
                if (prompt) { lines.push(`  prompt:      ${prompt}`); }
                if (value) { lines.push(`  defaultVal:  ${value}`); }
                if (placeHolder) { lines.push(`  placeHolder: ${placeHolder}`); }
                if (task.prefix) { lines.push(`  prefix:      ${task.prefix}`); }
                if (task.suffix) { lines.push(`  suffix:      ${task.suffix}`); }
                interpolated.push(prompt, value, placeHolder);
                break;
            }
            case 'quickPick': {
                const placeHolder = task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined;
                // Dynamic source: items come from a command's stdout at runtime.
                // Resolve it like `command` (string or per-platform object) so
                // its ${...} refs are surfaced in the interpolation check.
                let itemsFromCommand: string | undefined;
                if (typeof task.itemsFromCommand === 'string') {
                    itemsFromCommand = interpolatePipelineVariables(task.itemsFromCommand, interpolationContext);
                } else if (task.itemsFromCommand && typeof task.itemsFromCommand === 'object') {
                    const cloned: any = JSON.parse(JSON.stringify(task.itemsFromCommand));
                    for (const os of Object.keys(cloned)) {
                        cloned[os] = interpolatePipelineVariables(cloned[os], interpolationContext);
                    }
                    try {
                        itemsFromCommand = getCommandString(cloned);
                    } catch {
                        itemsFromCommand = '(no command for current platform)';
                    }
                }
                if (itemsFromCommand !== undefined) {
                    const cwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : '(defaults to workspace folder)';
                    lines.push(`  itemsFromCommand: ${itemsFromCommand}`);
                    lines.push(`  cwd:     ${cwd}`);
                    lines.push(`  (items will be populated from this command's output at runtime)`);
                    interpolated.push(itemsFromCommand, cwd);
                } else {
                    const items = Array.isArray(task.items) ? task.items : [];
                    lines.push(`  items (${items.length}):`);
                    for (const it of items) {
                        if (typeof it === 'string') {
                            lines.push(`    - ${interpolatePipelineVariables(it, interpolationContext)}`);
                        } else if (it && typeof it === 'object') {
                            const label = it.label ? interpolatePipelineVariables(it.label, interpolationContext) : '(missing label)';
                            const desc = it.description ? interpolatePipelineVariables(it.description, interpolationContext) : '';
                            lines.push(`    - ${label}${desc ? `  (${desc})` : ''}`);
                        }
                    }
                }
                if (placeHolder) { lines.push(`  placeHolder: ${placeHolder}`); }
                if (task.canPickMany) { lines.push(`  canPickMany: true`); }
                interpolated.push(placeHolder);
                break;
            }
            case 'envPick': {
                const placeHolder = task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined;
                if (placeHolder) { lines.push(`  placeHolder: ${placeHolder}`); }
                lines.push(`  (user will pick an environment variable at runtime)`);
                interpolated.push(placeHolder);
                break;
            }
            case 'confirm': {
                const message = task.message ? interpolatePipelineVariables(task.message, interpolationContext) : '(no message)';
                lines.push(`  message: ${message}`);
                if (task.confirmLabel) { lines.push(`  confirmLabel: ${task.confirmLabel}`); }
                if (task.cancelLabel) { lines.push(`  cancelLabel:  ${task.cancelLabel}`); }
                interpolated.push(message);
                break;
            }
            case 'fileDialog':
            case 'folderDialog': {
                const title = task.options?.title;
                const openLabel = task.options?.openLabel;
                if (title) { lines.push(`  title:     ${title}`); }
                if (openLabel) { lines.push(`  openLabel: ${openLabel}`); }
                lines.push(`  (user will pick a ${task.type === 'folderDialog' ? 'folder' : 'file'} at runtime)`);
                break;
            }
            case 'zip':
            case 'unzip': {
                const tool = (() => {
                    try { return task.tool ? JSON.parse(interpolatePipelineVariables(JSON.stringify(task.tool), interpolationContext)) : undefined; }
                    catch { return task.tool; }
                })();
                const archive = task.archive ? interpolatePipelineVariables(task.archive, interpolationContext) : undefined;
                const destination = task.destination ? interpolatePipelineVariables(task.destination, interpolationContext) : undefined;
                if (tool === undefined || tool === null) {
                    lines.push(`  tool: (built-in engine — .zip only)`);
                } else {
                    lines.push(`  tool: ${typeof tool === 'string' ? tool : JSON.stringify(tool)}`);
                }
                if (archive) { lines.push(`  archive:     ${archive}`); }
                if (destination) { lines.push(`  destination: ${destination}`); }
                if (task.inputs) {
                    lines.push(`  inputs: ${JSON.stringify(task.inputs)}`);
                }
                interpolated.push(archive, destination);
                break;
            }
            case 'stringManipulation': {
                const input = task.input ? interpolatePipelineVariables(task.input, interpolationContext) : '(missing)';
                lines.push(`  function: ${task.function ?? '(missing)'}`);
                lines.push(`  input:    ${input}`);
                interpolated.push(input);
                break;
            }
            case 'writeFile':
            case 'appendFile': {
                const rawPath = task.path ? interpolatePipelineVariables(task.path, interpolationContext) : '(missing)';
                const content = task.content !== undefined ? interpolatePipelineVariables(task.content, interpolationContext) : '(missing)';
                lines.push(`  path:    ${rawPath}`);
                if (task.path && !UNRESOLVED_VAR_RE.test(rawPath)) {
                    UNRESOLVED_VAR_RE.lastIndex = 0;
                    const { resolved, outsideWorkspace } = resolveFilePathForPreview(
                        rawPath,
                        options.workspaceFolder,
                        options.workspaceRoots
                    );
                    lines.push(`    → resolves to: ${resolved}`);
                    if (outsideWorkspace) {
                        lines.push(`    ⚠️  OUTSIDE WORKSPACE — execution will be refused`);
                    }
                }
                UNRESOLVED_VAR_RE.lastIndex = 0;
                const contentDisplay = content.length > 120
                    ? `${content.slice(0, 120)}… (${content.length} chars)`
                    : content;
                lines.push(`  content: ${JSON.stringify(contentDisplay)}`);
                if (task.encoding) { lines.push(`  encoding: ${task.encoding}`); }
                if (task.eol) { lines.push(`  eol: ${task.eol}`); }
                if (task.type === 'writeFile') {
                    const overwriteEffective = task.overwrite !== false;
                    lines.push(`  overwrite: ${overwriteEffective}${task.overwrite === undefined ? ' (default)' : ''}`);
                }
                if (task.mkdirs === false) { lines.push(`  mkdirs: false (parent dir must already exist)`); }
                interpolated.push(rawPath, content);
                break;
            }
            default:
                lines.push(`  (unknown task type — no preview)`);
        }

        if (typeof task.timeoutSeconds === 'number' && task.timeoutSeconds > 0) {
            lines.push(`  timeoutSeconds: ${task.timeoutSeconds}`);
        }
        if (task.continueOnError) {
            lines.push(`  continueOnError: true (failures won't stop the pipeline)`);
        }

        if (task.output) {
            lines.push(`  output:`);
            if (task.output.mode) {
                lines.push(`    mode: ${task.output.mode}`);
            }
            if (task.output.language) {
                lines.push(`    language: ${task.output.language}`);
            }
            if (task.output.filePath) {
                const resolvedPath = interpolatePipelineVariables(task.output.filePath, interpolationContext);
                lines.push(`    filePath: ${resolvedPath}`);
                interpolated.push(resolvedPath);
                if (!UNRESOLVED_VAR_RE.test(resolvedPath)) {
                    UNRESOLVED_VAR_RE.lastIndex = 0;
                    const { resolved, outsideWorkspace } = resolveFilePathForPreview(
                        resolvedPath,
                        options.workspaceFolder,
                        options.workspaceRoots
                    );
                    lines.push(`      → resolves to: ${resolved}`);
                    if (outsideWorkspace) {
                        lines.push(`      ⚠️  OUTSIDE WORKSPACE — execution will be refused`);
                    }
                }
                UNRESOLVED_VAR_RE.lastIndex = 0;
            }
            if (task.output.overwrite !== undefined) {
                if (typeof task.output.overwrite === 'string') {
                    const resolved = interpolatePipelineVariables(task.output.overwrite, interpolationContext);
                    const effective = resolved.trim().toLowerCase() === 'true';
                    lines.push(`    overwrite: ${JSON.stringify(task.output.overwrite)}  →  ${effective} (string, matches "true" case-insensitively when enabled)`);
                    interpolated.push(resolved);
                } else {
                    lines.push(`    overwrite: ${JSON.stringify(task.output.overwrite)}`);
                }
            } else if (task.output.mode === 'file') {
                lines.push(`    overwrite: false (default — write fails if target already exists)`);
            }
            if (task.output.capture) {
                const rules = Array.isArray(task.output.capture) ? task.output.capture : [task.output.capture];
                lines.push(`    capture (${rules.length}):`);
                for (const r of rules) {
                    lines.push(`      - ${formatCaptureRule(r)}  →  \${${task.id}.${r.name}}`);
                }
                if ((task.type === 'shell' || task.type === 'command') && !task.passTheResultToNextTask) {
                    lines.push(`      ⚠️  capture is defined but 'passTheResultToNextTask' is false — captures will be skipped`);
                }
            }
        }

        const forwardTaskIds = new Set<string>();
        for (const id of knownTaskIds) {
            if (!Object.prototype.hasOwnProperty.call(allResults, id)) {
                forwardTaskIds.add(id);
            }
        }
        // Two complementary passes:
        //  1. `findUnresolved` on POST-interpolation strings catches refs to
        //     unknown heads (`${notATask.x}`) and forward refs whose head is
        //     not (yet) tolerated.
        //  2. `findTypoRefs` walks PRE-interpolation strings to catch typos
        //     against ALREADY-simulated tasks — these are masked from pass (1)
        //     because `interpolatePipelineVariables` silently falls back to
        //     `.output` when the requested property is missing.
        const unresolved = findUnresolved(interpolated, forwardTaskIds);
        const typos = findTypoRefs(task, allResults, task.id);
        // 미캡처 shell/command 출력 참조는 전용 경고로 따로 표시 — 일반
        // unresolved 목록에서 제외해 중복 보고를 막는다(M9).
        const uncaptured = findUncapturedOutputRefs(task, tasksById, task.id);
        const merged = Array.from(new Set([...unresolved, ...typos])).filter(r => !uncaptured.has(r));
        if (merged.length > 0) {
            lines.push(`  unresolved variables: ${merged.join(', ')}`);
            for (const u of merged) { totalUnresolved.add(u); }
        }
        for (const [ref, head] of uncaptured) {
            lines.push(`  ⚠️  ${ref} — task '${head}' does not set 'passTheResultToNextTask': true, so its output is not captured and this stays a literal at runtime`);
            totalUnresolved.add(ref);
        }

        const sim = simulateTaskResult(task);
        // 런타임은 shell/command에서 passTheResultToNextTask가 falsy면
        // capture도 건너뛴다 — 시뮬레이션 컨텍스트도 동일하게(M9).
        const captureSkippedAtRuntime =
            (task.type === 'shell' || task.type === 'command') && !task.passTheResultToNextTask;
        if (task.output?.capture && !captureSkippedAtRuntime) {
            const rules = Array.isArray(task.output.capture) ? task.output.capture : [task.output.capture];
            for (const r of rules) {
                if (r && typeof r.name === 'string') {
                    sim[r.name] = placeholder('capture', task.id, r.name);
                }
            }
        }
        allResults[task.id] = sim;

        lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════════════');
    if (graphIssues.length > 0) {
        // Graph issues are listed in detail at the top — repeat the
        // headline here so a user scanning only the summary doesn't
        // miss that the action would never start.
        lines.push(`Summary: action would FAIL at start — ${graphIssues.length} graph issue(s) above.`);
    } else if (totalUnresolved.size > 0) {
        lines.push(`Summary: ${totalUnresolved.size} unresolved variable(s) — fix before running:`);
        for (const u of totalUnresolved) {
            lines.push(`  - ${u}`);
        }
        lines.push('(These will be passed through as literal "${...}" at runtime.)');
    } else {
        lines.push('Summary: all ${...} references resolve under simulated inputs.');
        lines.push('(Placeholder values like <fileDialog:id:path> become real values at runtime.)');
    }
    lines.push('═══════════════════════════════════════════════════════════════════');

    return lines.join('\n');
}
