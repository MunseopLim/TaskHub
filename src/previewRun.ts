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
    resolveArchiveTaskPath,
    interpolateCommandPreservingTokens,
    expandArgTemplate,
    buildNativeCommandInvocation,
    getCommandString,
    selectPlatformValue,
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
    // 대부분의 값은 문자열 자리표시자지만, 다중 선택 `fileDialog` 의 `paths` /
    // `names` 는 **배열**이고 `count` 는 숫자다 — `args` 배열 확장을 미리보기가
    // 실제와 같은 개수로 보여 주려면 그 형태를 그대로 흉내 내야 한다.
    [key: string]: string | string[] | number;
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
        case 'folderDialog': {
            const base: SimulatedResult = {
                path: placeholder(task.type, task.id, 'path'),
                dir: placeholder(task.type, task.id, 'dir'),
                name: placeholder(task.type, task.id, 'name'),
                fileNameOnly: placeholder(task.type, task.id, 'fileNameOnly'),
                fileExt: placeholder(task.type, task.id, 'fileExt'),
            };
            // `paths` 를 **배열로** 흉내 내야 `args` 확장이 미리보기에서도
            // 실제와 같은 개수로 보인다.
            //
            // **`canSelectMany` 와 무관하게 항상 채운다.** `handleFileDialog` 은
            // 이 세 키를 조건 없이 돌려주는데(단일 선택이면 원소 하나), 시뮬레이션만
            // 다중 선택일 때 채우면 단일 선택 `fileDialog` 에 `${pick.paths}` 를
            // 쓴 액션이 Doctor 에서 `variable.unresolved` 로 잡힌다 — 런타임은
            // 멀쩡히 해석하는데 진단은 "리터럴로 전달됩니다" 라고 말하는,
            // 0.6.52 가 `args` 쪽에서 막 고친 것과 **똑같은 종류의 거짓말**이다.
            //
            // 다중 선택일 때만 원소를 둘로 둔다. 하나면 확장이 일어나는지
            // 드러나지 않고, 셋 이상은 리포트만 길어진다.
            //
            // `folderDialog` 도 같이 채운다 — 0.6.57 부터 폴더도 여러 개 고를 수
            // 있고 `handleFolderDialog` 이 같은 세 키를 돌려준다. 여기만 빠지면
            // 폴더 쪽 `${pick.paths}` 가 Doctor 에서 미해결로 잡힌다.
            const many = (task as any).options?.canSelectMany === true;
            const count = many ? 2 : 1;
            base.paths = Array.from({ length: count }, (_, i) => placeholder(task.type, task.id, `paths[${i}]`));
            base.names = Array.from({ length: count }, (_, i) => placeholder(task.type, task.id, `names[${i}]`));
            base.count = count;
            return base;
        }
        case 'inputBox':
            return { value: placeholder('inputBox', task.id, 'value') };
        case 'quickPick': {
            // `values` 는 **다중 선택일 때만** 나온다 — `handleQuickPick` 의
            // `canPickMany` 분기만 그 키를 돌려준다. 무조건 채우면 단일 선택
            // quickPick 의 `${pick.values}` 가 Preview 에서 해석된 것처럼
            // 보이지만 런타임에서는 리터럴로 남는다.
            const base: SimulatedResult = { value: placeholder('quickPick', task.id, 'value') };
            if ((task as any).canPickMany) {
                base.values = placeholder('quickPick', task.id, 'values');
            }
            return base;
        }
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
            //
            // 캡처 모드에서는 `stderr` 도 함께 넘어간다 (`handleShell` /
            // `handleCommand` 의 반환 형태). 빠뜨리면 `${build.stderr}` 라는
            // **정상 참조**를 미해결로 보고하게 된다.
            return task.passTheResultToNextTask
                ? {
                    output: placeholder(task.type, task.id, 'stdout'),
                    stderr: placeholder(task.type, task.id, 'stderr'),
                }
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
 * a key the task did not produce.
 *
 * `resolvePipelineReference` no longer falls back to `.output` for
 * property-qualified refs, so such a ref does survive interpolation and
 * `findUnresolved` would also see it. This pass is still the better
 * report: it runs on the *raw* leaves, so it names the exact `${...}`
 * literal the user wrote and attributes it to a known producer id
 * instead of lumping it in with forward refs and built-ins.
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
    // **trim 하지 않는다** — `resolvePipelineReference` 는 `expression.split('.')`
    // 의 결과를 그대로 키로 쓴다. `${ producer.output}` 의 head 는 `" producer"`
    // 이고 어떤 태스크 id 와도 맞지 않아 런타임에서는 리터럴로 남는다. 여기서
    // 다듬으면 그 오타가 정상 참조로 보인다.
    return dotIdx === -1 ? expr : expr.slice(0, dotIdx);
}

/**
 * `${expr}` 에서 head 뒤의 속성 경로를 꺼낸다. **점이 없으면 `undefined`**
 * (bare 참조). 점이 있으면 그 뒤 전부가 키다.
 *
 * 두 가지를 일부러 지킨다.
 *
 * - **`''` 와 `undefined` 를 구분한다.** `${producer.}` 는 점이 있으므로 bare 가
 *   아니고, 런타임(`resolvePipelineReference`)도 bare 로 보지 않아 리터럴로
 *   남긴다. 둘을 같은 값으로 뭉개면 이 오타가 Preview·Doctor 에서 조용히
 *   정상 참조로 통과한다.
 * - **trim 하지 않는다.** 런타임은 키를 다듬지 않으므로 `${producer. output}` 의
 *   키는 `" output"` 이고 어떤 결과 키와도 맞지 않는다. 여기서 trim 하면
 *   런타임이 리터럴로 남길 오타를 해석되는 것처럼 보여 준다.
 */
function extractRefKey(match: string): string | undefined {
    if (!match.startsWith('${') || !match.endsWith('}') || match.length < 4) {
        return undefined;
    }
    const expr = match.slice(2, -1);
    const dotIdx = expr.indexOf('.');
    return dotIdx === -1 ? undefined : expr.slice(dotIdx + 1);
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
    tolerate?: ReadonlySet<string> | RefTolerance
): string[] {
    const accept: RefTolerance = typeof tolerate === 'function'
        ? tolerate
        : (_literal, head) => tolerate !== undefined && tolerate.has(head);
    const seen = new Set<string>();
    for (const v of values) {
        if (typeof v !== 'string') { continue; }
        const matches = v.match(UNRESOLVED_VAR_RE);
        if (matches) {
            for (const m of matches) {
                if (accept(m, extractRefHead(m))) { continue; }
                seen.add(m);
            }
        }
    }
    return Array.from(seen);
}

/**
 * `${…}` 리터럴 하나를 "보고하지 않아도 되는가"로 판정한다. `true` 면 관용.
 */
export type RefTolerance = (literal: string, head: string) => boolean;

/**
 * 시뮬레이션 결과에 **capture 로 파생되는 이름까지** 얹은 것. downstream
 * 컨텍스트를 채우는 모든 곳(Preview, Doctor, 전방 참조 판정)이 이 하나를 쓴다.
 *
 * capture 적용 조건은 런타임 그대로다 — `executeSingleTask` 는 결과에 **문자열
 * `output` 이 있을 때만** capture 를 돌린다. 타입 이름으로 가르면
 * (`shell`/`command` 만 제외) `fileDialog` 에 `output.capture` 를 적어 둔 액션에서
 * 존재하지 않는 파생 변수가 해석되는 것처럼 보인다.
 */
export function simulateTaskResultWithCaptures(task: Task): SimulatedResult {
    const sim = simulateTaskResult(task);
    if (task.output?.capture && typeof sim.output === 'string') {
        const rules = Array.isArray(task.output.capture) ? task.output.capture : [task.output.capture];
        for (const r of rules) {
            if (r && typeof r.name === 'string') {
                sim[r.name] = placeholder('capture', task.id, r.name);
            }
        }
    }
    return sim;
}

/** 태스크가 실제로 내놓는 결과 키 집합. */
export function simulatedResultKeys(task: Task): Set<string> {
    return new Set(Object.keys(simulateTaskResultWithCaptures(task)));
}

/**
 * 전방(아직 시뮬레이션되지 않은) 태스크를 가리키는 참조를 **그 태스크가 실제로
 * 낼 키에 한해서만** 관용하는 판정기.
 *
 * 예전에는 head 가 전방 태스크이기만 하면 어떤 키든 통과시켰다. 자동 추론된
 * 의존성이 실행 순서를 뒤집으므로 전방 참조 자체는 정상이지만, 그 관용이
 * **키까지** 덮어 버려서 `${producer.safe}` 처럼 존재하지 않는 capture 를
 * 가리키는 오타가 Preview 에서는 "모두 해석됨", Doctor 에서는 무경고로 보이고
 * 런타임에서만 리터럴로 남았다. 이미 시뮬레이션된 태스크에 대해서는
 * `findTypoRefs` 가 같은 일을 한다 — 이 판정기가 그 대칭을 앞쪽에도 채운다.
 */
export function makeForwardRefTolerance(
    forwardTaskIds: ReadonlySet<string>,
    tasksById: ReadonlyMap<string, Task>,
    /**
     * 지금 검사 중인 태스크의 id. 이 태스크는 아직 `allResults` 에 없으므로
     * `forwardTaskIds` 에 들어 있지만, 런타임 컨텍스트에는 **자기 자신이 없다** —
     * `${self.output}` 은 리터럴로 남는다. 관용 대상에서 빼지 않으면 자기
     * 참조가 정상으로 보인다.
     */
    selfId?: string
): RefTolerance {
    const resultCache = new Map<string, SimulatedResult>();
    const resultFor = (head: string, task: Task): SimulatedResult => {
        let sim = resultCache.get(head);
        if (!sim) {
            sim = simulateTaskResultWithCaptures(task);
            resultCache.set(head, sim);
        }
        return sim;
    };
    return (literal, head) => {
        if (head === selfId) { return false; }
        if (!forwardTaskIds.has(head)) { return false; }
        const task = tasksById.get(head);
        // id 는 알지만 태스크 본체를 못 찾는 경우는 판단 근거가 없다 → 관용.
        if (!task) { return true; }
        const sim = resultFor(head, task);
        const key = extractRefKey(literal);
        if (key === undefined) {
            // bare `${id}` 는 대표 결과를 뜻한다. 런타임은 `output` 또는
            // `outputDir` 이 있을 때만 해석하고(`resolvePipelineReference`),
            // 그 외에는 결과 객체가 문자열이 아니라 sanitize 에서 걸려 리터럴로
            // 남는다 — `zip` 처럼 `archivePath` 만 내는 태스크가 그렇다.
            return sim.output !== undefined || sim.outputDir !== undefined;
        }
        return Object.prototype.hasOwnProperty.call(sim, key);
    };
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

    // null-prototype: 태스크 id 가 '__proto__' 여도 평범한 키가 되도록 (런타임의
    // stepResults 와 같은 처치). 일반 객체면 그 id 의 결과가 조용히 사라져
    // Preview 는 "모두 해석됨", 런타임은 리터럴이 되는 불일치가 생긴다.
    const allResults: Record<string, SimulatedResult> = Object.create(null);
    const totalUnresolved = new Set<string>();

    /**
     * 참조는 전부 해석되는데 **실행은 못 하는** 자리들.
     *
     * 미해결 참조와는 다른 종류의 실패다. `${...}` 가 하나도 남지 않아도
     * 현재 플랫폼의 `tool` 이 없거나 경로가 워크스페이스 밖이면 런타임은
     * 거부한다. 인라인 경고만 남기면 **요약만 읽는 사용자**에게는 `all ${...}
     * references resolve` 만 보여, 실행하면 실패할 액션이 정상으로 안내된다.
     */
    const runtimeBlockers: string[] = [];

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
        // null-prototype — 런타임과 같은 규칙 (상속 키가 결과로 새지 않도록).
        const interpolationContext: any = Object.assign(Object.create(null), allResults, {
            workspaceFolder: options.workspaceFolder,
            extensionPath: options.extensionPath,
        });

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
                // 실행과 **같은 규칙**으로 펼친다 — 배열 참조는 인자 여러 개가
                // 된다. 미리보기가 실제와 다른 개수를 보여 주면 안 된다.
                const args = (task.args ?? []).flatMap(a => expandArgTemplate(a, interpolationContext));
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
                // prefix/suffix 도 런타임에서 보간된다 (`executeSingleTask` 의
                // inputBox 분기). 표시만 하고 검사 목록에서 빼면 그 안의
                // `${ghost.output}` 이 미해결로 보고되지 않는다.
                const prefix = task.prefix ? interpolatePipelineVariables(task.prefix, interpolationContext) : undefined;
                const suffix = task.suffix ? interpolatePipelineVariables(task.suffix, interpolationContext) : undefined;
                if (prefix) { lines.push(`  prefix:      ${prefix}`); }
                if (suffix) { lines.push(`  suffix:      ${suffix}`); }
                interpolated.push(prompt, value, placeHolder, prefix, suffix);
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
                // OS별 객체는 **현재 플랫폼이 고를 branch 하나**만 본다 —
                // Preview 는 "지금 이 기계에서 실행하면" 을 보여 주는 자리이고,
                // 런타임의 `getToolCommand` 도 그 하나만 고른다. 모든 branch 를
                // 훑으면 이 기계에서 절대 실행되지 않을 windows branch 의
                // `${ghost.output}` 이 미해결로 보고되어 정상 설정이 막히고,
                // 반대로 현재 플랫폼 branch 가 없는 객체는 런타임에서 실패하는데도
                // "모두 해석됨" 이 된다. (설정 자체의 오류는 Doctor 가 모든
                // branch 를 훑어 잡는다 — 그쪽은 다른 OS 사용자까지 본다.)
                //
                // 보간은 고른 문자열에 **문자열 단위로** 적용한다 — JSON 을
                // 거치면 Windows 경로의 역슬래시가 escape 로 재해석되어 조용히
                // 다른 경로가 된다 (`interpolateToolValue` 주석 참조).
                const hasTool = task.tool !== undefined && task.tool !== null;
                const toolForPlatform = hasTool ? selectPlatformValue(task.tool) : undefined;
                const tool = toolForPlatform !== undefined
                    ? interpolatePipelineVariables(toolForPlatform, interpolationContext)
                    : undefined;
                const archive = task.archive ? interpolatePipelineVariables(task.archive, interpolationContext) : undefined;
                const destination = task.destination ? interpolatePipelineVariables(task.destination, interpolationContext) : undefined;
                if (!hasTool) {
                    lines.push(`  tool: (built-in engine — .zip only)`);
                } else if (tool === undefined) {
                    // 런타임의 `getToolCommand` 가 여기서 던진다. 표시만 하고
                    // 넘어가면 "모두 해석됨" 요약과 함께 정상처럼 보인다.
                    lines.push(`  tool: (none for this platform)`);
                    lines.push(`    ⚠️  no 'tool' entry for ${process.platform} — this task would fail at runtime`);
                    runtimeBlockers.push(`task '${task.id}': no 'tool' entry for ${process.platform}`);
                } else {
                    lines.push(`  tool: ${tool}`);
                }
                // 상대 경로가 **어디에** 떨어지는지 보여 준다. Preview 의 목적이
                // 그것인데, `writeFile` 만 `→ resolves to:` 를 달고 있었다 —
                // 아카이브 경로는 0.6.52 에서 기준점이 `task.cwd` → 워크스페이스로
                // 바뀐 자리라 더더욱 눈으로 확인할 수 있어야 한다. 여기는
                // 워크스페이스 격리 대상이 아니므로(다이얼로그로 고른 위치를
                // 다루는 것이 설계다) 격리 판정은 붙이지 않는다.
                const cwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined;
                const base = cwd || options.workspaceFolder || options.workspaceRoots[0] || '';
                const showPath = (label: string, value: string) => {
                    lines.push(`  ${label} ${value}`);
                    // `UNRESOLVED_VAR_RE` 는 global 플래그라 `.test()` 가
                    // `lastIndex` 를 들고 다닌다 — 같은 입력에 대해 호출마다
                    // 다른 답을 낸다. 여기서는 매칭만 필요하므로 새 정규식을 쓴다.
                    if (/\$\{[^}]+\}/.test(value)) { return; }   // 미해석 참조는 판단 불가
                    // 시뮬레이션 자리표시자(`<zip:pack:archivePath>`)도 판단 불가다.
                    // 런타임에 그 자리에 오는 값은 **이미 해석된 절대 경로**라
                    // 기준점이 적용되지 않는데, 여기서 붙여 버리면 미리보기가
                    // 실제와 다른 경로를 자신 있게 보여 준다.
                    if (/<[A-Za-z]+:[^>]*>/.test(value)) { return; }
                    const resolved = resolveArchiveTaskPath(value, base);
                    if (resolved !== value) { lines.push(`    → resolves to: ${resolved}`); }
                };
                if (archive) { showPath('archive:    ', archive); }
                if (destination) { showPath('destination:', destination); }
                // `source` 는 `handleZip` 이 원소마다 보간하는 값이다. 표시도
                // 검사도 하지 않으면 `source: ["${ghost.output}"]` 이 "모두
                // 해석됨" 으로 요약된 뒤 런타임에서 리터럴 경로를 압축하려 든다
                // — `tool` 에서 막 고친 것과 같은 종류의 사각지대이고, Doctor 는
                // 이미 보고 있어 두 진단이 같은 파일을 두고 어긋나 있었다.
                const sources = Array.isArray(task.source)
                    ? task.source.map(s => interpolatePipelineVariables(s, interpolationContext))
                    : typeof task.source === 'string'
                        ? [interpolatePipelineVariables(task.source, interpolationContext)]
                        : [];
                for (const s of sources) { showPath('source:     ', s); }
                if (task.inputs) {
                    lines.push(`  inputs: ${JSON.stringify(task.inputs)}`);
                }
                // `tool` 도 검사 대상이다 — 표시만 하고 빼 두면 그 안의
                // `${ghost.output}` 이 "모두 해석됨" 으로 요약된 뒤 런타임에서
                // 리터럴 실행 파일로 실행을 시도한다. 검사하는 것은 위에서 고른
                // **현재 플랫폼 branch** 하나다.
                if (tool !== undefined) { interpolated.push(tool); }
                interpolated.push(archive, destination, ...sources);
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
                        runtimeBlockers.push(`task '${task.id}': path outside workspace — ${resolved}`);
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
            if (task.output.content) {
                // `content` 는 런타임에서 보간된 뒤 파일/에디터로 나간다. 검사
                // 목록에 넣지 않으면 그 안의 `${ghost.output}` 이 미해결로
                // 보고되지 않은 채 그대로 기록된다.
                const resolvedContent = interpolatePipelineVariables(task.output.content, interpolationContext);
                lines.push(`    content: ${resolvedContent}`);
                interpolated.push(resolvedContent);
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
                        runtimeBlockers.push(`task '${task.id}': output path outside workspace — ${resolved}`);
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
        //     unknown heads (`${notATask.x}`) and forward refs whose key the
        //     forward task will not produce.
        //  2. `findTypoRefs` walks PRE-interpolation strings to catch typos
        //     against ALREADY-simulated tasks, naming the exact literal the
        //     user wrote and attributing it to a known producer.
        const unresolved = findUnresolved(interpolated, makeForwardRefTolerance(forwardTaskIds, tasksById, task.id));
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

        // capture 적용 조건은 `simulateTaskResultWithCaptures` 한 곳에만 둔다 —
        // 전방 참조 판정도 같은 함수를 쓰므로 앞뒤가 같은 모델을 본다.
        allResults[task.id] = simulateTaskResultWithCaptures(task);

        lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════════════');
    if (graphIssues.length > 0) {
        // Graph issues are listed in detail at the top — repeat the
        // headline here so a user scanning only the summary doesn't
        // miss that the action would never start.
        lines.push(`Summary: action would FAIL at start — ${graphIssues.length} graph issue(s) above.`);
    } else {
        // 미해결 참조와 실행 차단은 **서로 독립**이므로 둘 다 낸다. 앞의 것만
        // 보고 멈추면, 참조가 하나 미해결인 액션의 "실행 자체가 불가능하다" 는
        // 사실이 요약에서 빠진다.
        if (totalUnresolved.size > 0) {
            lines.push(`Summary: ${totalUnresolved.size} unresolved variable(s) — fix before running:`);
            for (const u of totalUnresolved) {
                lines.push(`  - ${u}`);
            }
            lines.push('(These will be passed through as literal "${...}" at runtime.)');
        }
        if (runtimeBlockers.length > 0) {
            lines.push(`Summary: ${runtimeBlockers.length} task(s) would FAIL at runtime even though references resolve:`);
            for (const b of runtimeBlockers) {
                lines.push(`  - ${b}`);
            }
        }
        if (totalUnresolved.size === 0 && runtimeBlockers.length === 0) {
            lines.push('Summary: all ${...} references resolve under simulated inputs.');
            lines.push('(Placeholder values like <fileDialog:id:path> become real values at runtime.)');
        }
    }
    lines.push('═══════════════════════════════════════════════════════════════════');

    return lines.join('\n');
}
