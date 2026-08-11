/**
 * TaskHub Doctor — static analysis for `actions.json`.
 *
 * Bulk-lints every loaded actions.json source (workspace, presets, bundled)
 * and returns structured findings the extension layer can publish to the
 * VS Code Problems panel. Pure module: no `vscode`, no I/O — every input is
 * passed in and every output is a plain object, so it can be unit-tested
 * without booting the extension host.
 *
 * Checks (current scope):
 *   1. JSON parse failure
 *   2. JSON-schema violations (delegated to an externally supplied AJV
 *      validator so we stay vscode-free)
 *   3. Duplicate action ids (within a file) and duplicate task ids (within
 *      one action)
 *   4. `output.diagnostics` / `output.capture` regex compile errors, plus
 *      capture-group index validity (numeric out of range, named group
 *      missing)
 *   5. Unresolved `${...}` references after best-effort simulation
 *      (reuses Preview Run's `simulateTaskResult` + `interpolatePipelineVariables`)
 *   6. `writeFile` / `appendFile` / `output.file` paths that resolve
 *      outside the action's workspace folder
 *   7. `task.dependsOn` cycles and references to non-existent task ids
 *
 * Out of scope (roadmap follow-ups): `type: 'tool'` path existence,
 * `vscodeTask` label matching against `.vscode/tasks.json`.
 */

import type { ActionItem, Task, OutputCapture, DiagnosticPattern } from './schema';
import {
    interpolatePipelineVariables,
    expandArgTemplate,
    parseReferenceAlternatives,
    resolvePipelineReference,
    tokenizeCommandLine,
    RESERVED_CAPTURE_NAMES,
    INTERACTIVE_TASK_TYPES,
    buildTaskGraph,
    detectGraphCycle,
    formatCyclePath,
    evaluateTaskCondition,
    selectPlatformValue,
} from './pipelineUtils';
import {
    simulateTaskResult,
    simulateTaskResultWithCaptures,
    findUnresolved,
    findTypoRefs,
    findUncapturedOutputRefs,
    analyzeCoalesceRefs,
    deadAlternatives,
    describeDeadAlternative,
    detectFrozenCondition,
    makeForwardRefTolerance,
    isInsideWorkspace,
    placeholder,
    UNRESOLVED_VAR_RE,
} from './previewRun';
import { resolveDiagnosticMatcher } from './diagnosticMatcher';
import * as path from 'path';

/**
 * One issue surfaced by Doctor. The extension layer maps these to
 * `vscode.Diagnostic`. `range` is 1-based, mirroring the way `actions.json`
 * is shown in an editor; the extension subtracts 1 when converting.
 */
export interface DoctorFinding {
    filePath: string;
    sourceLabel: string;
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    messageKo?: string;
}

export interface DoctorInput {
    /** Absolute path to actions.json (or preset JSON). */
    filePath: string;
    /** Human-readable source label (used in findings & log lines). */
    sourceLabel: string;
    /** Raw file contents — Doctor parses internally so a malformed file
     *  still gets at least one finding instead of being silently dropped. */
    rawText: string;
    /** Workspace folder this source belongs to. Used to resolve
     *  `writeFile.path` and to decide whether a path is "inside workspace". */
    workspaceFolder?: string;
    /** All workspace roots — same semantics as Preview Run. */
    workspaceRoots: string[];
    /** Extension install path — feeds `${extensionPath}` interpolation. */
    extensionPath: string;
}

/**
 * Minimal validator contract Doctor needs. Designed to match AJV's
 * `ValidateFunction` shape so the extension layer can pass
 * `getActionsValidator()` straight through without an adapter.
 */
export interface DoctorValidator {
    (data: unknown): boolean;
    errors?: Array<{
        instancePath?: string;
        message?: string;
        keyword?: string;
        params?: any;
    }> | null;
}

const DEFAULT_RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

export function runDoctor(inputs: DoctorInput[], validator: DoctorValidator): DoctorFinding[] {
    const findings: DoctorFinding[] = [];
    for (const input of inputs) {
        findings.push(...analyzeFile(input, validator));
    }
    return findings;
}

/**
 * {@link runDoctor} 를 **소스마다 따로** 돌린다.
 *
 * 한 소스에서 분석기가 예외를 던져도 나머지 소스의 결과는 살아야 한다 — 한 번에
 * 감싸면 진단이 하나도 게시되지 않고, 이미 걸려 있던 진단이 stale 로 남는다.
 * 실패한 소스에는 그 사실 자체를 finding 으로 남긴다.
 *
 * @param onError 로깅 훅(호스트의 출력 채널). 분석 자체에는 영향이 없다.
 */
export function runDoctorPerSource(
    inputs: DoctorInput[],
    validator: DoctorValidator,
    onError?: (input: DoctorInput, error: unknown) => void
): DoctorFinding[] {
    const findings: DoctorFinding[] = [];
    for (const input of inputs) {
        try {
            findings.push(...analyzeFile(input, validator));
        } catch (e: any) {
            onError?.(input, e);
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 },
                severity: 'error',
                code: 'doctor.analysis-failed',
                message: `TaskHub Doctor could not finish analyzing this source: ${e?.message ?? e}`,
                messageKo: `TaskHub Doctor 가 이 소스를 끝까지 분석하지 못했습니다: ${e?.message ?? e}`,
            });
        }
    }
    return findings;
}

function analyzeFile(input: DoctorInput, validator: DoctorValidator): DoctorFinding[] {
    const findings: DoctorFinding[] = [];

    let parsed: any;
    try {
        parsed = JSON.parse(input.rawText);
    } catch (e: any) {
        findings.push({
            filePath: input.filePath,
            sourceLabel: input.sourceLabel,
            range: jsonParseErrorRange(input.rawText, e),
            severity: 'error',
            code: 'json.parse',
            message: `Invalid JSON: ${e.message ?? String(e)}`,
            messageKo: `JSON 파싱 실패: ${e.message ?? String(e)}`,
        });
        return findings;
    }

    const valid = validator(parsed);
    if (!valid) {
        for (const err of validator.errors ?? []) {
            findings.push(ajvErrorToFinding(input, parsed, err));
        }
    }

    if (!Array.isArray(parsed)) {
        return findings;
    }

    findings.push(...checkDuplicateIds(parsed, input));
    findings.push(...checkRegexAndCaptureGroups(parsed, input));
    findings.push(...checkUnresolvedAndOutsideWrites(parsed, input));
    findings.push(...checkDependsOn(parsed, input));
    findings.push(...checkParallelInteractive(parsed, input));

    return findings;
}

function jsonParseErrorRange(text: string, err: any): DoctorFinding['range'] {
    const msg = String(err?.message ?? '');
    const m = /at position (\d+)/i.exec(msg);
    if (m) {
        const offset = Number.parseInt(m[1], 10);
        if (Number.isFinite(offset)) {
            return offsetToRange(text, offset);
        }
    }
    const line = /line (\d+)/i.exec(msg);
    const col = /column (\d+)/i.exec(msg);
    if (line && col) {
        const l = Number.parseInt(line[1], 10);
        const c = Number.parseInt(col[1], 10);
        return { startLine: l, startColumn: c, endLine: l, endColumn: c + 1 };
    }
    return { ...DEFAULT_RANGE };
}

function offsetToRange(text: string, offset: number): DoctorFinding['range'] {
    let line = 1;
    let column = 1;
    const limit = Math.min(offset, text.length);
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 0x0A) {
            line++;
            column = 1;
        } else {
            column++;
        }
    }
    return { startLine: line, startColumn: column, endLine: line, endColumn: column + 1 };
}

function ajvErrorToFinding(
    input: DoctorInput,
    parsed: unknown,
    err: { instancePath?: string; message?: string; keyword?: string; params?: any }
): DoctorFinding {
    const pointer = err.instancePath ?? '';
    const range = locateJsonPointer(input.rawText, parsed, pointer);
    let detail = err.message ?? 'schema violation';
    if (err.keyword === 'required' && err.params?.missingProperty) {
        detail = `missing required property '${err.params.missingProperty}'`;
    } else if (err.keyword === 'enum' && Array.isArray(err.params?.allowedValues)) {
        detail = `${detail} (allowed: ${err.params.allowedValues.join(', ')})`;
    } else if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
        detail = `unknown property '${err.params.additionalProperty}'`;
    }
    const pathDisplay = pointer === '' ? '(root)' : pointer;
    return {
        filePath: input.filePath,
        sourceLabel: input.sourceLabel,
        range,
        severity: 'error',
        code: `schema.${err.keyword ?? 'invalid'}`,
        message: `Schema: ${pathDisplay} — ${detail}`,
        messageKo: `스키마 위반: ${pathDisplay} — ${detail}`,
    };
}

/**
 * Best-effort position lookup for an AJV `instancePath` (RFC 6901 JSON
 * Pointer like `/0/action/tasks/2/output/capture`). The strategy:
 *
 *   1. Resolve the pointer to a parsed value to know what we're aiming at.
 *   2. Walk the pointer one segment at a time across the raw source text,
 *      moving a search cursor forward at each step. For object keys we
 *      look for `"<key>":` after the current cursor; for array indices we
 *      step over `index` value-bearing tokens, respecting nested
 *      brackets/strings.
 *
 * The walker is intentionally lenient — if it can't pin down a deep
 * position it falls back to the deepest position it *did* reach, so the
 * user is still taken close to the offending node. Worst case is line 1.
 */
function locateJsonPointer(
    rawText: string,
    parsed: unknown,
    pointer: string
): DoctorFinding['range'] {
    if (!pointer || pointer === '/') {
        return { ...DEFAULT_RANGE };
    }
    const segments = pointer
        .split('/')
        .slice(1)
        .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));

    let cursor = 0;
    let currentValue: any = parsed;
    let bestOffset = 0;
    for (const seg of segments) {
        if (Array.isArray(currentValue)) {
            const idx = Number.parseInt(seg, 10);
            if (!Number.isFinite(idx) || idx < 0) {
                break;
            }
            const arrayOpen = findUnescaped(rawText, '[', cursor);
            if (arrayOpen < 0) {
                break;
            }
            cursor = arrayOpen + 1;
            for (let i = 0; i < idx; i++) {
                cursor = skipToTopLevelComma(rawText, cursor, ']');
                if (cursor < 0) {
                    break;
                }
                cursor++;
            }
            if (cursor < 0) {
                break;
            }
            cursor = skipWhitespace(rawText, cursor);
            bestOffset = cursor;
            currentValue = currentValue[idx];
        } else if (currentValue && typeof currentValue === 'object') {
            const keyOffset = findObjectKey(rawText, seg, cursor);
            if (keyOffset < 0) {
                break;
            }
            // Move cursor past `"key":` so subsequent segment search starts
            // at the value.
            const colon = rawText.indexOf(':', keyOffset);
            if (colon < 0) {
                break;
            }
            cursor = skipWhitespace(rawText, colon + 1);
            bestOffset = keyOffset;
            currentValue = (currentValue as any)[seg];
        } else {
            break;
        }
    }
    return offsetToRange(rawText, bestOffset);
}

function skipWhitespace(text: string, from: number): number {
    let i = from;
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) {
            i++;
        } else {
            break;
        }
    }
    return i;
}

/**
 * Locate the offset of `"<key>"` immediately followed by `:` searching
 * from `from`. Honors nested objects/arrays/strings so the cursor doesn't
 * dive into an unrelated `"<key>"` inside a string literal value. Returns
 * -1 on miss.
 */
function findObjectKey(text: string, key: string, from: number): number {
    let i = from;
    let depth = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const end = endOfJsonString(text, i);
            if (end < 0) {
                return -1;
            }
            // Candidate key when at depth 0 relative to our starting object.
            if (depth === 0) {
                const literal = text.slice(i + 1, end);
                const decoded = decodeJsonStringContent(literal);
                if (decoded === key) {
                    const afterStr = skipWhitespace(text, end + 1);
                    if (text[afterStr] === ':') {
                        return i;
                    }
                }
            }
            i = end + 1;
            continue;
        }
        if (c === '{' || c === '[') {
            depth++;
            i++;
            continue;
        }
        if (c === '}' || c === ']') {
            if (depth === 0) {
                return -1;
            }
            depth--;
            i++;
            continue;
        }
        i++;
    }
    return -1;
}

function endOfJsonString(text: string, openQuote: number): number {
    let i = openQuote + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '"') {
            return i;
        }
        i++;
    }
    return -1;
}

function decodeJsonStringContent(literal: string): string {
    try {
        return JSON.parse(`"${literal}"`);
    } catch {
        return literal;
    }
}

function findUnescaped(text: string, ch: string, from: number): number {
    let i = from;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const end = endOfJsonString(text, i);
            if (end < 0) {
                return -1;
            }
            i = end + 1;
            continue;
        }
        if (c === ch) {
            return i;
        }
        i++;
    }
    return -1;
}

/**
 * Advance past a top-level array element to the comma separating it from
 * the next one. Stops at the closing bracket `closeCh`. Returns -1 if the
 * array ends before another comma is found.
 */
function skipToTopLevelComma(text: string, from: number, closeCh: string): number {
    let i = from;
    let depth = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            const end = endOfJsonString(text, i);
            if (end < 0) {
                return -1;
            }
            i = end + 1;
            continue;
        }
        if (c === '{' || c === '[') {
            depth++;
            i++;
            continue;
        }
        if (c === '}' || c === ']') {
            if (depth === 0) {
                return -1;
            }
            depth--;
            i++;
            continue;
        }
        if (c === ',' && depth === 0) {
            return i;
        }
        if (c === closeCh && depth === 0) {
            return -1;
        }
        i++;
    }
    return -1;
}

/**
 * Locate the line + column of `"id": "<actionId>"` (or task id) in the
 * source — used by checks where we know the offending action/task by id
 * but cannot afford a full pointer walk. Falls back to {1,1} on miss.
 */
function findIdLine(text: string, id: string, occurrence = 0): DoctorFinding['range'] {
    const escaped = id.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const re = new RegExp(`"id"\\s*:\\s*"${escaped}"`, 'g');
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(text)) !== null) {
        if (seen === occurrence) {
            return offsetToRange(text, m.index);
        }
        seen++;
    }
    return { ...DEFAULT_RANGE };
}

function checkDuplicateIds(actions: ActionItem[], input: DoctorInput): DoctorFinding[] {
    const findings: DoctorFinding[] = [];
    const seenActionIds = new Map<string, number>();

    const walk = (items: ActionItem[]) => {
        for (const item of items) {
            if (item && typeof item === 'object' && typeof item.id === 'string') {
                const count = seenActionIds.get(item.id) ?? 0;
                if (count >= 1) {
                    findings.push({
                        filePath: input.filePath,
                        sourceLabel: input.sourceLabel,
                        range: findIdLine(input.rawText, item.id, count),
                        severity: 'error',
                        code: 'duplicate.action.id',
                        message: `Duplicate action id '${item.id}' — every action in a single source must have a unique id.`,
                        messageKo: `중복 action id '${item.id}' — 하나의 소스 안에서 모든 action id는 고유해야 합니다.`,
                    });
                }
                seenActionIds.set(item.id, count + 1);
            }

            if (item?.action?.tasks && Array.isArray(item.action.tasks)) {
                const taskIds = new Map<string, number>();
                for (const task of item.action.tasks) {
                    if (!task || typeof task.id !== 'string') {
                        continue;
                    }
                    const count = taskIds.get(task.id) ?? 0;
                    if (count >= 1) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id, count),
                            severity: 'error',
                            code: 'duplicate.task.id',
                            message: `Action '${item.id ?? '(unknown)'}' has duplicate task id '${task.id}'.`,
                            messageKo: `Action '${item.id ?? '(unknown)'}'에 중복 task id '${task.id}'가 있습니다.`,
                        });
                    }
                    taskIds.set(task.id, count + 1);

                    // `when` 은 연산자를 **정확히 하나** 써야 한다. 여럿을 쓰면
                    // 런타임은 정해진 순서로 첫 번째만 보고 나머지를 조용히
                    // 무시한다 — 사용자는 둘 다 걸리는 줄 안다.
                    const when = (task as { when?: Record<string, unknown> }).when;
                    if (when && typeof when === 'object') {
                        const used = ['equals', 'notEquals', 'matches', 'in']
                            .filter(op => when[op] !== undefined);
                        if (used.length !== 1) {
                            findings.push({
                                filePath: input.filePath,
                                sourceLabel: input.sourceLabel,
                                range: findIdLine(input.rawText, task.id),
                                severity: used.length === 0 ? 'warning' : 'error',
                                code: 'when.operators',
                                message: used.length === 0
                                    ? `Task '${item.id ?? '(unknown)'}.${task.id}' has a 'when' with no operator — the task always runs.`
                                    : `Task '${item.id ?? '(unknown)'}.${task.id}' has a 'when' with multiple operators (${used.join(', ')}); only the first is applied.`,
                                messageKo: used.length === 0
                                    ? `Task '${item.id ?? '(unknown)'}.${task.id}'의 'when'에 연산자가 없습니다 — 태스크는 항상 실행됩니다.`
                                    : `Task '${item.id ?? '(unknown)'}.${task.id}'의 'when'에 연산자가 여럿입니다(${used.join(', ')}). 첫 번째만 적용됩니다.`,
                            });
                        }
                        if (typeof when.matches === 'string') {
                            try {
                                new RegExp(when.matches);
                            } catch (e: any) {
                                // 런타임은 던지지 않고 "맞지 않음" 으로 보므로,
                                // 잡아 주지 않으면 그 분기가 영영 꺼진 채로 남는다.
                                findings.push({
                                    filePath: input.filePath,
                                    sourceLabel: input.sourceLabel,
                                    range: findIdLine(input.rawText, task.id),
                                    severity: 'error',
                                    code: 'when.regex',
                                    message: `Task '${item.id ?? '(unknown)'}.${task.id}' has an invalid 'when.matches' regex: ${e.message ?? e}`,
                                    messageKo: `Task '${item.id ?? '(unknown)'}.${task.id}'의 'when.matches' 정규식이 올바르지 않습니다: ${e.message ?? e}`,
                                });
                            }
                        }
                    }
                }
            }
            if (Array.isArray(item?.children) && item.children.length > 0) {
                walk(item.children);
            }
        }
    };
    walk(actions);
    return findings;
}

function checkRegexAndCaptureGroups(actions: ActionItem[], input: DoctorInput): DoctorFinding[] {
    const findings: DoctorFinding[] = [];

    forEachTask(actions, (item, task) => {
        const output = task?.output;
        if (!output) {
            return;
        }

        if (output.capture) {
            const rules: OutputCapture[] = Array.isArray(output.capture) ? output.capture : [output.capture];
            // Track which names we have seen inside this task so the
            // second (and later) occurrence is reported — mirrors
            // applyOutputCapture's behavior at pipelineUtils.ts.
            const seenNames = new Set<string>();
            for (const rule of rules) {
                if (!rule) {
                    continue;
                }

                if (typeof rule.name === 'string') {
                    if (RESERVED_CAPTURE_NAMES.has(rule.name)) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'error',
                            code: 'capture.reserved',
                            message: `Capture name '${rule.name}' in task '${item.id}.${task.id}' is reserved (it would shadow the built-in task result key). Pick a different name.`,
                            messageKo: `Task '${item.id}.${task.id}'의 capture name '${rule.name}'은 예약어입니다. 기본 task 결과 키를 가리므로 다른 이름을 사용하세요.`,
                        });
                    } else if (seenNames.has(rule.name)) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'error',
                            code: 'capture.duplicate',
                            message: `Duplicate capture name '${rule.name}' in task '${item.id}.${task.id}'. Each capture in one task must have a unique name.`,
                            messageKo: `Task '${item.id}.${task.id}'에 중복 capture name '${rule.name}'이 있습니다. 한 task 안의 capture 이름은 고유해야 합니다.`,
                        });
                    } else {
                        seenNames.add(rule.name);
                    }
                }

                if (typeof rule.regex !== 'string' || rule.regex.length === 0) {
                    continue;
                }
                let re: RegExp;
                try {
                    const flags = (rule.flags ?? '').replace(/g/g, '');
                    re = new RegExp(rule.regex, flags);
                } catch (e: any) {
                    findings.push({
                        filePath: input.filePath,
                        sourceLabel: input.sourceLabel,
                        range: findIdLine(input.rawText, task.id),
                        severity: 'error',
                        code: 'capture.regex',
                        message: `Task '${item.id}.${task.id}' capture '${rule.name}' has invalid regex: ${e.message ?? e}`,
                        messageKo: `Task '${item.id}.${task.id}' capture '${rule.name}'의 정규식이 올바르지 않습니다: ${e.message ?? e}`,
                    });
                    continue;
                }

                // Detect when an explicit numeric `group` is out of range
                // for the compiled regex. Cheap probe: an always-empty
                // match exposes the capture count via `m.length - 1`.
                if (typeof rule.group === 'number') {
                    const flags = (rule.flags ?? '').replace(/g/g, '');
                    const probe = new RegExp(`(?:${rule.regex})|(?=)`, flags).exec('');
                    const groupCount = probe ? probe.length - 1 : 0;
                    if (rule.group < 0 || rule.group > groupCount) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'warning',
                            code: 'capture.group',
                            message: `Capture '${rule.name}' in task '${item.id}.${task.id}' refers to group ${rule.group}, but the regex defines ${groupCount} capture group(s).`,
                            messageKo: `Task '${item.id}.${task.id}'의 capture '${rule.name}'이 그룹 ${rule.group}을 참조하지만, 정규식에는 capture group이 ${groupCount}개만 있습니다.`,
                        });
                    }
                }
            }
        }

        if (output.diagnostics !== undefined && output.diagnostics !== null) {
            const entries = Array.isArray(output.diagnostics) ? output.diagnostics : [output.diagnostics];
            for (const entry of entries) {
                let resolved: DiagnosticPattern;
                try {
                    resolved = resolveDiagnosticMatcher(entry as any);
                } catch (e: any) {
                    findings.push({
                        filePath: input.filePath,
                        sourceLabel: input.sourceLabel,
                        range: findIdLine(input.rawText, task.id),
                        severity: 'error',
                        code: 'diagnostics.preset',
                        message: `Task '${item.id}.${task.id}' diagnostics: ${e.message ?? e}`,
                        messageKo: `Task '${item.id}.${task.id}' diagnostics 설정 오류: ${e.message ?? e}`,
                    });
                    continue;
                }
                try {
                    // We strip `g` the same way the runtime engine does
                    // so the Doctor mirrors the actual compile path.
                    const flags = (resolved.flags ?? '').replace(/g/g, '');
                    const re = new RegExp(resolved.pattern, flags);
                    const probe = new RegExp(`(?:${resolved.pattern})|(?=)`, flags).exec('');
                    const groupCount = probe ? probe.length - 1 : 0;
                    const indexFields: Array<[keyof DiagnosticPattern, number | undefined]> = [
                        ['file', resolved.file],
                        ['line', resolved.line],
                        ['column', resolved.column],
                        ['endLine', resolved.endLine],
                        ['endColumn', resolved.endColumn],
                        ['severity', resolved.severity],
                        ['message', resolved.message],
                    ];
                    for (const [field, value] of indexFields) {
                        if (typeof value !== 'number') {
                            continue;
                        }
                        if (value > groupCount) {
                            findings.push({
                                filePath: input.filePath,
                                sourceLabel: input.sourceLabel,
                                range: findIdLine(input.rawText, task.id),
                                severity: 'warning',
                                code: 'diagnostics.group',
                                message: `Task '${item.id}.${task.id}' diagnostics: '${String(field)}' refers to group ${value}, but the regex defines ${groupCount} capture group(s).`,
                                messageKo: `Task '${item.id}.${task.id}' diagnostics의 '${String(field)}'가 그룹 ${value}을 참조하지만, 정규식에는 capture group이 ${groupCount}개만 있습니다.`,
                            });
                        }
                    }
                    void re;
                } catch (e: any) {
                    findings.push({
                        filePath: input.filePath,
                        sourceLabel: input.sourceLabel,
                        range: findIdLine(input.rawText, task.id),
                        severity: 'error',
                        code: 'diagnostics.regex',
                        message: `Task '${item.id}.${task.id}' diagnostics has invalid regex: ${e.message ?? e}`,
                        messageKo: `Task '${item.id}.${task.id}' diagnostics 정규식이 올바르지 않습니다: ${e.message ?? e}`,
                    });
                }
            }
        }
    });

    return findings;
}

function checkUnresolvedAndOutsideWrites(actions: ActionItem[], input: DoctorInput): DoctorFinding[] {
    const findings: DoctorFinding[] = [];

    const walkActions = (items: ActionItem[]) => {
        for (const item of items) {
            if (item?.action?.tasks && Array.isArray(item.action.tasks)) {
                analyzeActionTasks(item, item.action.tasks, input, findings);
            }
            if (Array.isArray(item?.children) && item.children.length > 0) {
                walkActions(item.children);
            }
        }
    };
    walkActions(actions);
    return findings;
}


/**
 * 셸 옵션 토큰 하나를 읽은 결과.
 *
 * `next` 는 이어서 볼 자리(현재 자리 기준 오프셋). 인자를 삼키는지 모르는
 * 옵션은 두 갈래를 모두 담는다.
 */
type ShellOptionStep = { enablesScript: boolean; next: number[] };

/** `--rcfile FILE` 처럼 **다음 argv** 를 삼키는 긴 옵션. */
const SH_LONG_TAKES_ARGUMENT = /^--(rcfile|init-file)$/;
/** 다음 argv 를 삼키지 않는 것이 확실한 긴 옵션. */
const SH_LONG_NO_ARGUMENT = /^--(posix|norc|noprofile|noediting|noline-editing|login|verbose|debug|help|version|restricted|protected)$/;

/**
 * POSIX 셸의 옵션 토큰 하나를 읽는다.
 *
 * **`-c` 는 다음 argv 를 삼키는 옵션이 아니다.** 셸은 옵션을 다 읽은 뒤
 * **첫 피연산자**를 command_string 으로 실행한다 — 그래서 `sh -cex -c '…'` ·
 * `bash -cx -O extglob '…'` 처럼 `-c` 와 스크립트 사이에 옵션이 더 끼어도
 * 스크립트는 실행된다(실제 `/bin/sh` · `bash` 로 확인). "스위치 바로 다음이
 * 스크립트" 로 보던 모델은 이런 형태를 절반 가까이 놓쳤다.
 *
 * 묶음(`-cex`)은 글자마다 읽되, `o`/`O` 를 만나면 거기서 멈춘다:
 *   - 묶음에 글자가 남아 있으면 그것이 `-o` 의 인자다 — `-oc` 의 `c` 는 옵션이
 *     아니라 옵션 **이름**이다(`bash -oc 'echo hi'` → `c: invalid option name`).
 *   - 묶음의 마지막이면 **다음 argv** 를 삼킨다(`-co nounset '…'`).
 */
function shellOptionStep(token: string): ShellOptionStep {
    const bundle = /^[-+]([A-Za-z]+)$/.exec(token);
    if (bundle) {
        const letters = bundle[1];
        let enablesScript = false;
        let consumed = 0;
        for (let k = 0; k < letters.length; k++) {
            const ch = letters[k];
            if (ch === 'c') { enablesScript = true; continue; }
            if (ch === 'o' || ch === 'O') {
                if (k === letters.length - 1) { consumed = 1; }
                break;
            }
        }
        return { enablesScript, next: [1 + consumed] };
    }
    if (SH_LONG_TAKES_ARGUMENT.test(token)) { return { enablesScript: false, next: [2] }; }
    if (SH_LONG_NO_ARGUMENT.test(token)) { return { enablesScript: false, next: [1] }; }
    return { enablesScript: false, next: [1, 2] };   // 모르는 옵션 — 두 갈래 모두
}

const PWSH_TAKES_ARGUMENT = /^-(executionpolicy|inputformat|outputformat|windowstyle|version|configurationname|psconsolefile|workingdirectory|settingsfile|custompipename)$/i;
const PWSH_NO_ARGUMENT = /^-(nop|noprofile|nologo|noni|noninteractive|noexit|mta|sta|login|interactive|help)$/i;

/**
 * PowerShell 은 매개변수 이름을 **접두사로** 맞춘다 — `-Co` · `-Com` · `-Comman`
 * 이 전부 `-Command` 이고 실제로 스크립트를 실행한다. 전체 이름만 보던 동안
 * `powershell -Com "echo ${ask.value}"` 가 무경고였다. (`PWSH_NO_ARGUMENT` 의
 * `nop` · `noni` 도 같은 규칙 덕에 유효한 축약이다.)
 */
function powerShellSwitch(...names: string[]): (token: string) => { inline?: string; ambiguous?: true } | undefined {
    return token => {
        if (!token.startsWith('-')) { return undefined; }
        const typed = token.slice(1).toLowerCase();
        if (typed.length === 0 || !names.some(name => name.startsWith(typed))) { return undefined; }
        // 축약이 **다른 매개변수와도** 맞으면 그 해석도 살아 있다(`-e` 는
        // `-EncodedCommand` 도 `-ExecutionPolicy` 도 된다). 정확히 하나로 풀리면
        // 그 자리에서 끝난다 — 그러지 않으면 `$args` 같은 뒤 인자에 과탐이 붙는다.
        const alternatives = PWSH_PARAMETERS.filter(name => name.startsWith(typed)).length;
        return alternatives > 1 ? { ambiguous: true } : {};
    };
}

/** 접두사 충돌을 세기 위한 PowerShell 매개변수 이름(별칭 포함). */
const PWSH_PARAMETERS = [
    'command', 'commandwithargs', 'cwa', 'encodedcommand', 'ec', 'file', 'executionpolicy',
    'inputformat', 'outputformat', 'windowstyle', 'version', 'configurationname',
    'psconsolefile', 'workingdirectory', 'settingsfile', 'custompipename',
    'noprofile', 'nologo', 'noninteractive', 'noexit', 'mta', 'sta', 'login', 'interactive', 'help',
];

/**
 * 인터프리터별 "이 뒤가 스크립트" 규칙. 셋의 문법이 서로 달라 **모델**로 나눈다.
 *
 *   - `posix-shell`: `-c` 는 모드 스위치이고, 스크립트는 옵션이 끝난 뒤의
 *     **첫 피연산자** 하나다. 그 뒤 토큰은 `$0` · `$1` … 로 들어간다 — 즉
 *     `sh -c 'printf %s "$1"' _ "${ask.value}"` 는 값이 스크립트가 아니라
 *     **인자**로 전달되는 안전한 형태이고, 우리가 권장하는 완화책이다.
 *   - `switch`: 스위치 토큰 뒤가 곧 스크립트다. `cmd /c` 와 PowerShell
 *     `-Command` 는 **나머지 전체**, `-EncodedCommand` 는 다음 하나.
 *
 * `--noprofile` · `/v:on` 처럼 스위치 앞에 끼는 플래그를 **위치로** 처리하므로,
 * 문자열 정규식으로 형태를 하나씩 쫓아다닐 필요가 없다.
 */
const NESTED_INTERPRETERS: {
    executable: RegExp;
    /** 이 인터프리터가 옵션으로 읽는 접두사. 그 밖의 토큰은 피연산자다. */
    optionPrefix: '-' | '/';
    /** `posix-shell` — 스크립트는 첫 피연산자. `switch` — 스위치 뒤가 스크립트. */
    model: 'posix-shell' | 'switch';
    /** 이 인터프리터가 스크립트를 읽는 문법. */
    dialect: ScriptDialect;
    /**
     * `-c` 가 없어도 첫 피연산자를 **명령 문자열**로 실행하는가.
     *
     * ksh 가 그렇다 — 이 기계의 AT&T ksh93u+ 은 `ksh 'printf x'` 를 그대로
     * 실행한다(`sh`·`zsh`·`dash` 는 파일 이름으로 읽고 실패한다). 구현마다
     * 갈리는 자리라 ksh 계열은 통째로 fail-closed 로 둔다.
     */
    operandIsScript?: true;
    /**
     * `switch` 모델에서 스크립트를 여는 토큰. 붙어 있는 스크립트는 `inline`,
     * 다른 매개변수로도 읽힐 수 있는 축약이면 `ambiguous` 로 알린다.
     */
    scriptSwitch?: (token: string) => { inline?: string; ambiguous?: true } | undefined;
    /** `switch` 모델이 스크립트로 삼키는 범위. */
    consumes?: 'one' | 'rest';
    /** 텍스트로 문법 위치를 따질 수 없는 스크립트(base64 등). */
    opaque?: true;
    /** 다음 argv 를 인자로 삼키는 옵션 — 그 인자는 피연산자가 아니다. */
    takesArgument?: RegExp;
    /** 다음 argv 를 삼키지 **않는** 것이 확실한 옵션 — 두 갈래로 나눌 필요가 없다. */
    noArgument?: RegExp;
    /** 옵션 처리를 끝내는 옵션(PowerShell `-File` 처럼 뒤가 전부 스크립트/인자). */
    endsOptions?: RegExp;
}[] = [
    {
        executable: /^cmd(\.exe)?$/i, model: 'switch', dialect: 'cmd',
        // `/r` 은 문서에 없지만 `/c` 의 별칭으로 알려져 있다 — 모르면 위험으로 본다.
        // **스크립트가 스위치에 붙어 올 수 있다**(`cmd /c"echo …"` → 토큰 하나로
        // `/cecho …`). 정확히 `/c` 인 토큰만 보던 동안 이 형태가 통째로 빠졌다.
        scriptSwitch: token => {
            const match = /^\/[ckr](.*)$/i.exec(token);
            return match ? { inline: match[1] } : undefined;
        },
        consumes: 'rest', optionPrefix: '/',
        // 문서화된 `cmd` 스위치는 값을 콜론 뒤에 붙인다(`/v:on`) — 다음 argv 를
        // 삼키지 않는다. 그 밖의 스위치는 모르는 것으로 두어 두 갈래로 본다.
        noArgument: /^\/([sqdaux]|[tef]:\S*|v:\S*)$/i,
    },
    // `.exe` 가 붙은 Git-Bash 의 `bash.exe` 도 같은 셸이다 — 접미사만으로 검사를
    // 통째로 비껴가던 구멍이 있었다.
    { executable: /^(sh|bash|zsh|dash|ash)(\.exe)?$/i, model: 'posix-shell', dialect: 'posix', optionPrefix: '-' },
    {
        executable: /^(m|pd)?ksh(88|93)?(u\+)?(\.exe)?$/i, model: 'posix-shell', dialect: 'posix', optionPrefix: '-',
        operandIsScript: true,
    },
    // `-EncodedCommand` 는 base64 인자 하나, `-Command` 는 나머지 전부.
    // `-CommandWithArgs`(7.5+, 별칭 `-cwa`)는 **첫 문자열만** 코드고 나머지는
    // `$args` 다 — `rest` 로 보면 과탐이 된다.
    {
        executable: /^(powershell|pwsh)(\.exe)?$/i, model: 'switch', dialect: 'powershell',
        scriptSwitch: powerShellSwitch('encodedcommand', 'ec'), consumes: 'one', optionPrefix: '-',
        // base64 는 문법 위치를 따질 수 없다 — 허용 문자와 디코딩된 코드의 의미가 무관하다.
        opaque: true,
        takesArgument: PWSH_TAKES_ARGUMENT,
        noArgument: PWSH_NO_ARGUMENT,
        endsOptions: /^-file$/i,
    },
    {
        executable: /^(powershell|pwsh)(\.exe)?$/i, model: 'switch', dialect: 'powershell',
        scriptSwitch: powerShellSwitch('command'), consumes: 'rest', optionPrefix: '-',
        takesArgument: PWSH_TAKES_ARGUMENT,
        noArgument: PWSH_NO_ARGUMENT,
        endsOptions: /^-file$/i,
    },
    {
        executable: /^pwsh(\.exe)?$/i, model: 'switch', dialect: 'powershell',
        scriptSwitch: powerShellSwitch('commandwithargs', 'cwa'), consumes: 'one', optionPrefix: '-',
        takesArgument: PWSH_TAKES_ARGUMENT,
        noArgument: PWSH_NO_ARGUMENT,
        endsOptions: /^-file$/i,
    },
];

/**
 * 투명 실행 래퍼를 벗긴다.
 *
 * `env sh -c "…"` · `busybox sh -c "…"` 는 뒤의 argv 를 그대로 실행하는데,
 * 첫 토큰만 보고 인터프리터를 찾던 동안 검사가 **통째로** 사라졌다
 * (`/usr/bin/env sh -c 'printf x'` 가 실행되는 것을 확인했다).
 *
 * 벗겨 낼 수 있다고 확신하는 것만 벗긴다 — 모르는 옵션이 끼면 그만둔다.
 */
function unwrapExecWrapper(argv: string[]): { wrapper: boolean; argv?: string[] } {
    const base = (argv[0].split(/[\\/]/).pop() ?? argv[0]).trim();
    if (/^busybox(\.exe)?$/i.test(base)) {
        return { wrapper: true, argv: argv.length > 1 ? argv.slice(1) : undefined };
    }
    if (!/^env(\.exe)?$/i.test(base)) { return { wrapper: false }; }
    let i = 1;
    while (i < argv.length) {
        const token = argv[i];
        if (token === '--') { i++; break; }
        if (/^(-i|--ignore-environment|-0|--null|-v|--debug)$/.test(token)) { i++; continue; }
        // 값이 붙어 오기도 하고(`-uPATH` · `-C/tmp`) 떨어져 오기도 한다.
        const withValue = /^(-[uCP]|--unset|--chdir)(=?)(.*)$/.exec(token);
        if (withValue) { i += withValue[3].length > 0 ? 1 : 2; continue; }
        // **`-S` 는 인자를 버리는 옵션이 아니다** — 그 문자열을 다시 쪼개 실행한다.
        const split = /^(-S|--split-string)(=?)(.*)$/.exec(token);
        if (split) {
            const script = split[3].length > 0 ? split[3] : argv[i + 1];
            if (script === undefined) { return { wrapper: true }; }
            const consumed = split[3].length > 0 ? i + 1 : i + 2;
            return { wrapper: true, argv: [...tokenizeCommandLine(script), ...argv.slice(consumed)] };
        }
        // 모르는 옵션. **래퍼인 것은 아는데 해석을 못 한다** — 조용히 포기하면
        // 뒤의 `sh -c` 가 통째로 사라지므로, 호출부가 fail-closed 로 처리한다.
        if (token.startsWith('-')) { return { wrapper: true }; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i++; continue; }    // NAME=value
        break;
    }
    return { wrapper: true, argv: i < argv.length ? argv.slice(i) : undefined };
}

/**
 * 인터프리터 판정 **전에** argv 를 실제로 올 수 있는 값들로 펼친다.
 *
 * 검사가 보간 전 템플릿을 보므로, 실행 파일이나 스크립트 스위치가 참조로
 * 적혀 있으면(`${which.value} -c "…"`) 이름이 `${which.value}` 라 어떤
 * 인터프리터와도 맞지 않아 **경고가 하나도 나지 않았다.** 런타임에서는 그것이
 * `sh` 가 되어 뒤 값이 스크립트로 흘러간다.
 *
 * 고정 `quickPick` 은 값 집합이 정적이므로 그대로 열거한다. 열거할 수 없는
 * 참조가 실행 파일이나 스위치 자리에 남으면 `dynamic` 로 알린다 — 무엇이
 * 실행될지 모른다는 사실 자체가 경고할 거리다.
 *
 * Exported for testing.
 */
export function enumerateArgvCandidates(
    argv: string[],
    tasks: Task[]
): { variants: string[][]; truncated: boolean } {
    /** 실행 파일 후보 상한 — 진단 한 건에 쓸 비용이 아니다. */
    const MAX_VARIANTS = 32;
    let truncated = false;

    const exact = /^\$\{([^}]+)\}$/.exec((argv[0] ?? '').trim());
    if (!exact) { return { variants: [argv], truncated: false }; }

    const values = new Set<string>();
    for (const alt of parseReferenceAlternatives(exact[1])) {
        const source = tasks.find(t => t.id === alt.head) as any;
        if (!source || source.type !== 'quickPick' || source.itemsFromCommand || !Array.isArray(source.items)) {
            return { variants: [argv], truncated: false };   // 열거 불가 — 그대로 두면 certain=false 로 잡힌다
        }
        for (const entry of source.items) {
            const label = typeof entry === 'string' ? entry : entry?.label;
            if (typeof label === 'string') { values.add(label); }
        }
    }

    // **실행 파일만 펼친다.** 스위치나 스크립트까지 펼치면 스크립트 자리의
    // `${pick.value}` 가 구체값으로 바뀌어 이후 참조 검사에 아무것도 남지 않고,
    // 메타문자가 든 quickPick 이 무경고로 지나간다. 스위치가 참조인 경우는
    // 펼치지 않고 `scriptCandidateTokens` 가 보수적으로 처리한다.
    const variants: string[][] = [];
    for (const head of values) {
        if (variants.length < MAX_VARIANTS) { variants.push([head, ...argv.slice(1)]); }
        else { truncated = true; }
    }
    return { variants: variants.length > 0 ? variants : [argv], truncated };
}

/**
 * 인터프리터가 실행할 **스크립트 텍스트 한 덩어리**.
 *
 * 토큰이 아니라 텍스트인 이유는, 참조가 그 문법에서 데이터 자리인지 명령 자리인지
 * 따지려면 앞뒤 문맥이 필요하기 때문이다.
 */
export type ScriptCandidate = {
    text: string;
    /** 이 텍스트를 읽는 문법. 인용·치환·변수 확장 규칙이 셋 다 다르다. */
    dialect: ScriptDialect;
    /** 텍스트로 문법을 따질 수 없는 자리(`-EncodedCommand` 의 base64 등). */
    opaque?: true;
};

/** 스크립트를 읽는 문법. `unknown` 은 셋 중 가장 엄한 판정을 쓴다. */
export type ScriptDialect = 'posix' | 'cmd' | 'powershell' | 'unknown';

/** 스크립트 위치를 확정하지 못했는가 — 무엇이 실행될지 모른다는 뜻이다. */
export function interpreterPositionIsDynamic(argv: string[]): boolean {
    const { tokens, certain } = scriptCandidateTokens(argv);
    return !certain && tokens.length > 0;
}


/**
 * argv 가 **인터프리터를 통해 값을 스크립트로 흘릴 수 있는가**를 본다.
 *
 * 네 라운드에 걸쳐 이 검사에 구멍이 반복해 났고, 원인은 매번 같았다 —
 * 셸의 옵션 파싱을 손으로 흉내 내면서 표에 없는 문법마다 **조용히 통과**시켰다
 * (`sh -xo nounset -c`, `cmd /k`, PowerShell 의 두 번째 설정, 동적 스위치 뒤의
 * 스크립트 …). 표를 계속 늘리는 대신 판정 방향을 뒤집는다:
 *
 *   **안전을 증명하지 못하면 위험으로 본다.**
 *
 * 증명이 되는 경우는 하나뿐이다 — 실행 파일이 **리터럴**이고, 옵션도 리터럴이라
 * 어느 토큰이 스크립트인지 확정할 수 있으며, 그 스크립트 토큰에 제약 없는 참조가
 * 없을 때. 그 밖에는(실행 파일이 참조, 스위치가 참조, 모르는 옵션이 끼어 스크립트
 * 위치를 확정할 수 없음) 뒤따르는 참조를 전부 스크립트에 놓일 수 있는 것으로 본다.
 *
 * argv 를 **(자리, 스크립트 모드) 상태**로 걷는다. POSIX 셸의 `-c` 는 다음 인자를
 * 삼키는 옵션이 아니라 모드 스위치이고, 스크립트는 옵션이 끝난 뒤의 첫 피연산자
 * 하나다 — 그래서 `sh -cex -c '…'` 처럼 `-c` 와 스크립트 사이에 옵션이 더 끼어도
 * 잡힌다. 인자를 삼키는지 모르는 옵션에서는 두 갈래로 갈라져 합집합을 취한다.
 *
 * 이 규칙은 문서가 권하는 안전한 형태(`sh -c '고정 스크립트' _ "${ask.value}"`)를
 * 계속 조용히 통과시킨다 — 값이 스크립트가 아니라 `$1` 로 들어가기 때문이다.
 *
 * 반환값은 "스크립트에 놓일 수 있는 토큰들". 비어 있으면 위험 없음.
 */
export function scriptCandidateTokens(argv: string[]): { tokens: string[]; certain: boolean } {
    const { candidates, certain } = scriptCandidates(argv);
    return { tokens: candidates.map(candidate => candidate.text), certain };
}

/**
 * {@link scriptCandidateTokens} 와 같은 판정이되, 후보를 **스크립트 텍스트**로
 * 돌려준다. 참조가 그 안에서 데이터 자리인지 명령 자리인지 따지려면 앞뒤 문맥이
 * 필요하기 때문이다 — `echo ok; ${v}` 의 `${v}` 는 문자 집합과 무관하게 명령이다.
 *
 * Exported for testing.
 */
export function scriptCandidates(argv: string[], depth = 0): { candidates: ScriptCandidate[]; certain: boolean } {
    if (argv.length === 0) { return { candidates: [], certain: true }; }
    const isRef = (token: string) => /\$\{[^}]+\}/.test(token);
    /** 스크립트 텍스트 하나로 묶는다 — 문맥이 있어야 자리를 따질 수 있다. */
    let dialect: ScriptDialect = 'unknown';
    const asScript = (parts: string[], opaque?: true): ScriptCandidate[] => {
        // 여러 argv 를 한 스크립트로 잇을 때는 **낱말 경계를 되살린다** —
        // 토크나이저가 인용을 벗겨 낸 뒤 공백으로 이으면
        // `if exist "C:\Program Files" ${v}` 가 세 낱말로 부서져, 경로 조각이
        // 고정 명령 이름으로 읽힌다. 토큰 하나짜리(스크립트 본문 자체)는 그대로 둔다.
        const text = parts.length === 1
            ? parts[0]
            : parts.map(part => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
        return isRef(text) ? [{ text, dialect, opaque }] : [];
    };

    // 실행 파일이 참조면 무엇이 실행될지 모른다 — 뒤 전부를 스크립트 후보로 본다.
    if (isRef(argv[0])) { return { candidates: asScript(argv.slice(1)), certain: false }; }

    const base = (argv[0].split(/[\\/]/).pop() ?? argv[0]).trim();
    const matching = NESTED_INTERPRETERS.filter(entry => entry.executable.test(base));
    if (matching.length === 0) {
        // `env sh -c …` 처럼 투명 래퍼를 거치는 형태는 래퍼를 벗기고 다시 본다.
        const unwrapped = depth < 4 ? unwrapExecWrapper(argv) : { wrapper: false };
        if (unwrapped.argv) { return scriptCandidates(unwrapped.argv, depth + 1); }
        // 래퍼인 것은 알지만 해석하지 못했다 — 뒤가 통째로 인터프리터일 수 있다.
        if (unwrapped.wrapper) { return { candidates: asScript(argv.slice(1)), certain: false }; }
        return { candidates: [], certain: true };   // 인터프리터가 아니다
    }
    dialect = matching[0].dialect;

    // **모르는 옵션은 두 갈래로 진행한다.** 표에 없다고 "여기서 피연산자가
    // 시작한다"고 단정하면 뒤의 `-c` 를 못 보고 조용히 통과시킨다. 표를 계속
    // 늘리는 대신, 삼키는 경우와 아닌 경우를 **둘 다** 따라가 합집합을 취한다.
    // 상태는 (자리, 스크립트 모드) 쌍이다 — POSIX 셸은 `-c` 를 본 뒤 옵션을 더
    // 읽을 수 있고, 스크립트는 그 다음 **첫 피연산자**이기 때문이다.
    const found: ScriptCandidate[] = [];
    const addScript = (parts: (string | undefined)[], opaque?: true) => {
        found.push(...asScript(parts.filter((part): part is string => part !== undefined), opaque));
    };
    // "이 자리부터 뒤는 전부 스크립트일 수 있다" 는 **수위선 하나**로 모은다.
    // 자리마다 `argv.slice(...)` 를 펼쳐 담던 동안 비용이 O(예산 × argv) 였고,
    // `push(...큰 배열)` 이 인자 상한을 넘겨 큰 명령줄에서 RangeError 로 죽었다 —
    // 진단 하나가 확장 호스트를 멈추면 안 된다.
    let openFrom = argv.length;
    const openAt = (at: number) => { openFrom = Math.min(openFrom, at); };
    let certain = true;
    const visited = new Set<string>();
    const queue: { at: number; scriptMode: boolean }[] = [{ at: 1, scriptMode: false }];
    const push = (at: number, scriptMode: boolean) => queue.push({ at, scriptMode });
    // 상태 폭발 방지. 방문한 상태는 다시 펴지 않으므로 갈래 수는 argv 길이에
    // 비례한다 — 현실적인 명령줄은 예산 안에서 **끝까지** 본다. 64 로 고정해
    // 두었을 때는 옵션이 65개만 돼도 예산이 끊겼다.
    let budget = Math.min(8192, argv.length * 4 + 16);

    while (queue.length > 0 && budget-- > 0) {
        const { at: i, scriptMode } = queue.shift()!;
        const key = `${i}:${scriptMode ? 1 : 0}`;
        if (i >= argv.length || visited.has(key)) { continue; }
        visited.add(key);
        const token = argv[i];

        const matched = matching.find(entry => entry.scriptSwitch?.(token));
        if (matched) {
            const match = matched.scriptSwitch!(token)!;
            // 스크립트가 스위치 토큰에 붙어 있을 수 있다(`cmd /c"echo …"`).
            const inline = match.inline;
            if (matched.consumes === 'rest') {
                // 붙어 있으면 그 조각과 나머지가 **한 스크립트**다. 따로 열면
                // 같은 참조가 문맥 없는 후보로 한 번 더 잡혀 과탐이 된다.
                if (inline) { addScript([inline, ...argv.slice(i + 1)]); }
                else { openAt(i + 1); }
                continue;                       // 뒤가 전부 스크립트다 — 더 볼 옵션이 없다
            }
            addScript([inline ? inline : argv[i + 1]], matched.opaque);
            // 축약이 다른 매개변수와도 맞을 때만 뒤를 계속 본다 — 그래야
            // `-e Bypass -Command …` 를 놓치지 않으면서, 정확한 스위치 뒤의
            // 인자(`-CommandWithArgs '…' $args`)에는 경고가 붙지 않는다.
            if (match.ambiguous) {
                push(i + 1, scriptMode);
                push(i + 2, scriptMode);
            }
            continue;
        }

        const prefix = matching[0].optionPrefix;
        const looksLikeOption = token.startsWith(prefix) || (prefix === '-' && token.startsWith('+'));
        // 스위치 자리에 참조가 있으면 그것이 `-c` 일 수 있다 — 다음 토큰부터가
        // 스크립트일 수 있으므로 뒤 전부를 후보로 본다. **옵션이 될 수 있는
        // 모양일 때만이다**: `echo ${ask.value}` 처럼 리터럴로 시작하는 토큰은
        // 값이 무엇이든 옵션이 아니라 피연산자다. 참조가 들어 있다는 이유만으로
        // 그것까지 동적 스위치로 보면, 정작 이 토큰 자신의 참조가 후보에서 빠졌다.
        if (isRef(token) && (looksLikeOption || token.trimStart().startsWith('${'))) {
            // 스크립트 모드라면 이 토큰이 옵션이 아니라 **첫 피연산자**, 즉
            // 스크립트 본문일 수도 있다 — 두 해석을 모두 담는다.
            if (scriptMode) { addScript([token]); }
            openAt(i + 1);
            certain = false;
            continue;
        }
        // `--` 뒤는 전부 피연산자다 — 첫 피연산자가 곧 스크립트 자리다.
        if (token === '--') {
            if (scriptMode || matching[0].operandIsScript) { addScript([argv[i + 1]]); }
            continue;
        }
        if (matching.some(entry => entry.endsOptions?.test(token))) { continue; }
        if (!looksLikeOption) {
            // 옵션이 끝났다. POSIX 셸에서 첫 피연산자는 `-c` 가 있으면
            // **스크립트 본문**, 없으면 스크립트 **파일 이름**이다 — 다만 ksh 는
            // `-c` 없이도 그것을 명령 문자열로 실행한다. 그 뒤 토큰은 `$0` ·
            // `$1` … 이라 어느 쪽이든 스크립트가 아니다.
            if (scriptMode || matching[0].operandIsScript) { addScript([token]); }
            continue;
        }
        if (matching[0].model === 'posix-shell') {
            const step = shellOptionStep(token);
            for (const offset of step.next) { push(i + offset, scriptMode || step.enablesScript); }
            continue;
        }
        if (matching.some(entry => entry.takesArgument?.test(token))) {
            push(i + 2, scriptMode);            // 인자를 삼키는 것이 확실하다
        } else if (matching.every(entry => entry.noArgument?.test(token) === true)) {
            // 삼키지 않는 것이 확실하다. 여기서도 두 갈래로 나가면 실행되지
            // 않는 값에 경고가 붙는다.
            push(i + 1, scriptMode);
        } else {
            push(i + 1, scriptMode);            // 모른다 — 두 갈래 모두
            push(i + 2, scriptMode);
        }
    }
    // **예산이 끊겨도 조용해지지 않는다.** `certain=false` 만 남기면 후보가 비어
    // 호출부가 "위험 없음" 으로 읽는다(`interpreterPositionIsDynamic` 도
    // `vulnerable` 판정도 후보가 있어야 참이다). 아직 펴 보지 못한 가장 이른
    // 자리부터 뒤의 참조를 전부 후보에 넣는다.
    if (queue.length > 0) {
        certain = false;
        openAt(queue.reduce((earliest, state) => Math.min(earliest, state.at), argv.length));
    }
    if (openFrom < argv.length) { addScript(argv.slice(openFrom)); }
    // 같은 텍스트를 두 갈래에서 담았을 수 있다.
    const seen = new Set<string>();
    return {
        candidates: found.filter(candidate => {
            const key = `${candidate.opaque ? 1 : 0}:${candidate.text}`;
            if (seen.has(key)) { return false; }
            seen.add(key);
            return true;
        }),
        certain,
    };
}
/** 셸·cmd 에서 문법적 의미를 갖는 문자를 담고 있는가. */
function containsShellMetacharacter(value: string): boolean {
    return /[;&|`$()<>*?!^%\n\r"'\\]/.test(value) || /\s/.test(value);
}

/**
 * 인자를 **다시 코드로 읽는** 명령. 값이 데이터 자리에 있어도 안전하지 않다.
 */
const REINTERPRETING_COMMANDS = new Set([
    // `trap 'CODE' EXIT` 의 첫 인자는 신호가 올 때 실행되는 **코드**다.
    'trap', 'eval', 'exec', 'source', '.', 'command', 'builtin', 'env', 'sudo', 'doas', 'xargs',
    'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'csh', 'tcsh', 'fish', 'busybox',
    'pwsh', 'powershell', 'cmd', 'start', 'call', 'iex', 'invoke-expression',
    'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'deno', 'bun', 'awk',
    'ssh', 'nohup', 'setsid', 'stdbuf', 'time', 'timeout', 'watch', 'nice',
    // `coproc [NAME] CMD` — 이름이 **선택적**이라 "다음 낱말이 명령" 으로 볼 수 없다.
    'coproc',
    // **대입 빌트인.** `export CMD=${v}; $CMD` 는 값이 다음 명령이 된다(실행 확인).
    // 명령 **앞**의 `TAG=${v}` 만 대입으로 보던 동안 이 형태가 평범한 인자로
    // 면제됐다 — "대입은 안전한 자리가 아니다" 라는 방침과 정면으로 어긋난다.
    // taint 분석 없이 닫으려면 이들의 인자를 코드로 보는 수밖에 없다.
    'export', 'declare', 'typeset', 'local', 'readonly', 'alias', 'set',
]);

/**
 * 뒤에 오는 낱말이 **명령**인 셸 예약어 — `if true; then ${v}; fi` 의 `${v}` 는
 * `;` 뒤가 아니라 `then` 뒤라서, 구분자만 보던 규칙이 데이터로 오인했다
 * (실제 `/bin/sh` 로 값이 실행되는 것을 확인했다).
 *
 * `for`·`case`·`in` 은 뒤가 낱말 목록이라 여기 넣지 않는다.
 *
 * **`time`·`coproc` 은 여기 없다.** 둘 다 명령 앞에 토큰이 더 올 수 있어서
 * (`time -p CMD` · `coproc NAME CMD`) "다음 낱말이 명령" 규칙이 그 토큰을 고정
 * 명령 이름으로 잡고 진짜 명령을 인자로 오인한다. 대신 {@link REINTERPRETING_COMMANDS}
 * 에 두어 뒤따르는 낱말을 전부 명령 자리로 본다 — 옵션과 선택적 coprocess 이름을
 * 따로 파싱하지 않고도 fail-closed 다.
 */
const COMMAND_INTRODUCING_KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!',
]);

/**
 * 리다이렉션 연산자 — 그 **대상 낱말**도 명령 이름이 아니다.
 *
 * 긴 연산자를 **먼저** 시도한다. `&?>>?` 를 앞에 두면 `>&` 에서 `>` 만 맞아
 * 낱말 길이와 어긋나고, "연산자 그 자체" 판정이 빗나가 대상 추적이 끊긴다.
 * 같은 이유로 `<>`(읽기·쓰기 열기)도 `<` 보다 앞에 둔다.
 */
const REDIRECTION_OPERATOR = /^[0-9]*(>>|<<|<>|>&|<&|>\||&>>?|>|<)/;

/**
 * 명령 **머리**가 무엇인가. 뒤따르는 값이 데이터인지는 여기서 갈린다.
 *
 *   - `safe`: 리터럴이고 재해석 명령이 아니다 — 뒤는 인자다.
 *   - `reinterpreting`: 리터럴인데 인자를 다시 코드로 읽는다(`eval` · `sh` · `trap` …).
 *   - `dynamic`: 실행 시점에 정해진다(`$CMD` · `%TOOL%`). 무엇이 될지 모르므로
 *     `eval` 일 수도 있다 — fail-closed 로 둔다.
 */
type CommandHeadKind = 'safe' | 'reinterpreting' | 'dynamic';

/**
 * 낱말에서 인용·이스케이프를 걷어 **셸이 실제로 보는 이름**을 낸다.
 *
 * 이 단계가 없으면 이름을 조금만 흩어 놓아도 목록 비교를 빠져나간다 —
 * `e\val` · `ev''al` · `tr\ap` 은 셸에게 전부 `eval` · `trap` 이다(실행 확인).
 * 예전 구현은 양 끝 따옴표 한 쌍만 떼고 `\` 를 **경로 구분자**로 갈랐는데,
 * POSIX 셸에서 `\` 는 경로가 아니라 이스케이프다 — `e\val` 이 `val` 로 잘려
 * `eval` 과 맞지 않았다.
 *
 * 인용 밖(또는 큰따옴표 안)에 살아 있는 확장이 남으면 `dynamic` 으로 알린다.
 */
function unquoteCommandWord(word: string, dialect: Exclude<ScriptDialect, 'unknown'>): { literal: string; dynamic: boolean } {
    const escape = dialect === 'cmd' ? '^' : (dialect === 'powershell' ? '`' : '\\');
    let literal = '';
    let dynamic = false;
    let single = false;
    let double = false;
    for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        // 이스케이프는 **다음 한 글자를 리터럴로** 만든다. `e\val` → `eval`.
        if (!single && ch === escape) {
            const next = word[i + 1];
            if (next === undefined) { continue; }
            // 이스케이프 + 개행은 글자를 남기지 않는 **행 잇기**다 — 셸은 두 줄을
            // 그냥 잇는다. 개행을 리터럴에 넣으면 `e\⏎val` 이 `eval` 과 맞지 않는다.
            // dialect 를 가리지 않는다: PowerShell 의 `` ` ``+개행도, cmd 의 `^`+개행도
            // 같은 행 잇기라 `i`⏎ex` · `c^⏎all` 이 똑같이 빠져나갔다.
            if (next === '\n' || next === '\r') {
                i++;
                if (next === '\r' && word[i + 1] === '\n') { i++; }
                continue;
            }
            literal += next;
            i++;
            continue;
        }
        if (!double && ch === "'" && dialect !== 'cmd') { single = !single; continue; }
        if (!single && ch === '"') { double = !double; continue; }
        if (single) { literal += ch; continue; }
        // 작은따옴표 밖에서는 확장이 살아 있다 — 큰따옴표 안이어도 마찬가지다.
        if (dialect === 'cmd' ? (ch === '%' || ch === '!') : ch === '$') { dynamic = true; }
        // brace expansion 과 glob 은 **이름 자체를 바꾼다** — `e{v,v}al` 도
        // `/bin/e*al` 도 셸에게는 `eval` 이다(실행 확인). 무엇으로 펼쳐질지
        // 증명할 수 없으므로 고정 리터럴로 보지 않는다. 인자 자리의 `*.txt` 는
        // 여기 오지 않는다 — 이 판정은 **머리 낱말**에만 쓴다.
        if (dialect === 'posix' && /[{}*?[]/.test(ch)) { dynamic = true; }
        literal += ch;
    }
    return { literal, dynamic };
}

/**
 * 실행 파일 경로에서 이름만 남겨 재해석 명령 목록과 맞춰 본다 —
 * `/usr/bin/env` 와 `env` 는 같은 명령이다.
 *
 * 경로 구분자는 dialect 마다 다르다. POSIX 에서 `\` 는 이스케이프이므로
 * {@link unquoteCommandWord} 가 이미 걷어 냈고, 여기서는 `/` 만 가른다.
 */
function classifyCommandHead(word: string, dialect: Exclude<ScriptDialect, 'unknown'>): { kind: CommandHeadKind; name: string } {
    const { literal, dynamic } = unquoteCommandWord(word, dialect);
    const separator = dialect === 'posix' ? /\// : /[\\/]/;
    const name = (literal.split(separator).pop() ?? literal).replace(/\.exe$/i, '').toLowerCase();
    if (dynamic) { return { kind: 'dynamic', name }; }
    return { kind: REINTERPRETING_COMMANDS.has(name) ? 'reinterpreting' : 'safe', name };
}

/**
 * 고정 명령이라도 **이 옵션 뒤부터는** 인자를 코드나 변수로 다시 읽는다.
 *
 * 머리가 리터럴이고 재해석 목록에 없으면 뒤를 전부 데이터로 보던 것이 증명되지
 * 않는 자리다 — 아래 둘은 값이 실제로 실행된다(확인).
 *
 *   - `find … -exec CMD …  \;` · `-execdir` · `-ok` · `-okdir` 의 피연산자는 **명령**이다.
 *   - `printf -v VAR FMT ARG` 는 결과를 **변수**에 넣는다(`printf -v CMD %s ${v}; $CMD`).
 *
 * 옵션을 만나면 그 세그먼트의 나머지를 명령 자리로 본다. 어디까지가 피연산자인지
 * (`\;` · `+`)까지 따라가지 않는 대신 넓게 잡는 fail-closed 다. 일반해는 taint
 * 분석이고 그건 이 함수의 범위가 아니다.
 */
const ARGUMENT_REINTERPRETING_OPTIONS = new Map<string, RegExp>([
    ['find', /^-(exec|execdir|ok|okdir)$/],
    ['printf', /^-v$/],
]);

/**
 * 스크립트 문법에서 이 참조가 어느 자리인가.
 *
 *   - `command`: 명령 **이름** 자리. 문자 집합이 아무리 좁아도 값이 곧 명령이다
 *     (`sh -c "echo ok; ${ask.value}"` 에 `whoami`).
 *   - `argument`: 고정된 명령의 인자. 데이터이긴 하지만 값이 `-` 로 시작하면
 *     **옵션**이 된다(`find … ${v} id \;` 에 `-exec`), 그래서 `--` 유무를 함께 본다.
 *
 * **대입(`TAG=${v}`)은 더 이상 안전한 자리로 보지 않는다.** 이 분석은 참조가
 * 놓인 **자리**만 보지 값이 그 뒤로 어떻게 흐르는지는 보지 않는다 —
 * `sh -c "CMD=${ask.value}; $CMD"` 는 대입 자체는 데이터지만 다음 줄에서 명령이
 * 된다. 흐름을 증명하려면 taint 분석이 필요하고 그건 이 함수의 범위가 아니므로,
 * 증명할 수 없는 쪽을 fail-closed 로 둔다.
 */
type ReferencePosition =
    | { kind: 'command' }
    /** 리다이렉션 **대상** — 실행되지는 않지만 임의의 파일을 덮어쓴다. */
    | { kind: 'redirection' }
    | { kind: 'argument'; afterDoubleDash: boolean };

/**
 * `cmd` 의 `%…%` · `!…!` 확장 **안쪽**인가.
 *
 * 이름의 일부만 보간해도(`%PRE${ask.value}%`) 확장된 값이 다시 해석되므로 참조
 * 바로 앞 글자만 봐서는 안 되고, 그렇다고 `%` 를 홀짝으로 세면 `%A`(FOR 변수) ·
 * `%1`(배치 인자) · `%%` 하나에 계산이 통째로 뒤집힌다.
 *
 * 그래서 짝짓기를 포기하고 **스크립트 전체의 첫 구분자와 마지막 구분자**만 본다
 * ({@link cmdExpansionMarks}) — 참조 앞에 여는 후보가 하나라도 있고 뒤에 닫는
 * 후보가 하나라도 있으면 확장 안으로 친다. **공백을 일부러 넘는다**: Windows
 * 환경변수 이름에는 공백이 들어갈 수 있어 `%PRE ${v}%` 도 확장이기 때문이다.
 * 대가는 `echo %PATH% ${v} %HOME%` 같은 형태의 과탐이고, 그것이 의도한 방향이다
 * (놓치는 쪽이 더 나쁘다).
 *
 * **"가장 가까운 구분자를 공백 안에서 찾는" 예전 방식으로 되돌리지 말 것** —
 * 위의 `%PRE ${v}%` 를 놓친다.
 */
function insideCmdExpansion(script: string, refStart: number, refEnd: number, marks: CmdExpansionMarks): boolean {
    return (marks.percent.first < refStart && marks.percent.last >= refEnd)
        || (marks.bang.first < refStart && marks.bang.last >= refEnd);
}

type CmdExpansionMarks = { percent: { first: number; last: number }; bang: { first: number; last: number } };

/**
 * `cmd` 확장 구분자(`%` · `!`)의 첫/마지막 위치.
 *
 * 공백에서 끊던 휴리스틱은 `%PRE ${v}%` 를 놓쳤다 — Windows 환경변수 이름에는
 * 공백이 들어갈 수 있고 확장은 닫는 구분자까지 읽는다. 그렇다고 짝을 지어 세면
 * `%A`(FOR 변수)가 앞 구분자와 짝지어져 정작 뒤의 진짜 확장을 놓친다 — cmd 의
 * 짝짓기는 명령줄과 배치 파일에서도 갈리는 자리다.
 *
 * 그래서 **모르는 쪽을 위험으로** 둔다: 참조 앞뒤에 구분자가 하나씩이라도 있으면
 * 확장 안으로 본다. `echo %PATH% ${v} %HOME%` 같은 형태에 경고가 붙지만, 놓치는
 * 것보다 낫다.
 *
 * **뒤 글자로 `%%`·`%<숫자>`·`%*` 를 알아보고 빼던 것은 틀렸다.** 그 `%` 가
 * 앞선 확장의 **닫는** 구분자일 수 있기 때문이다 — `%PRE${v}%1` 의 가운데 `%` 는
 * `%PRE…%` 를 닫는 자리인데 뒤의 `1` 때문에 `%1` 의 시작으로 보고 빼면 확장을
 * 통째로 놓친다(`%*` · `%%` · `!!` 도 같다). 구분자인지 배치 인자인지는 위치에
 * 달려 있으므로 미리 뺄 수 없다. 이제 `^` 이스케이프만 제외한다.
 */
function cmdExpansionMarks(script: string): CmdExpansionMarks {
    const scan = (mark: string) => {
        let first = Number.POSITIVE_INFINITY;
        let last = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < script.length; i++) {
            const ch = script[i];
            if (ch === '^') { i++; continue; }                       // `^%` · `^!`
            if (ch !== mark) { continue; }
            if (first === Number.POSITIVE_INFINITY) { first = i; }
            last = i;
        }
        return { first, last };
    };
    return { percent: scan('%'), bang: scan('!') };
}

/** `cmd` 의 `if` 조건 비교 연산자 (`if 1 EQU 1 …`). */
const CMD_COMPARISON = /^(equ|neq|lss|leq|gtr|geq)$/i;

/**
 * `cmd` 의 `if` 조건을 낱말 단위로 소비하는 작은 상태 기계.
 *
 * `if [/i] [not] {errorlevel N | exist FILE | defined VAR | cmdextversion N |
 * A==B | A EQU B}` 다음이 명령 자리다. **모르는 형태는 fail-closed** — 조건의
 * 일부를 고정 명령 이름으로 잡으면 그 뒤 보간값이 인자로 분류돼 조용해진다.
 */
function cmdIfConditionConsumer(): { feed(word: string): 'consumed' | 'done' | 'unknown' } {
    let state: 'flags' | 'operand' | 'value' | 'comparison' | 'right' = 'flags';
    return {
        feed(word) {
            switch (state) {
                case 'flags':
                    if (/^(\/i|not)$/i.test(word)) { return 'consumed'; }
                    if (/^(errorlevel|exist|defined|cmdextversion)$/i.test(word)) { state = 'value'; return 'consumed'; }
                    if (word.includes('==')) { return 'done'; }
                    state = 'comparison';
                    return 'consumed';                       // 비교의 왼쪽 피연산자
                case 'value':
                    return 'done';                           // `errorlevel N` 의 N
                case 'comparison':
                    if (!CMD_COMPARISON.test(word)) { return 'unknown'; }
                    state = 'right';
                    return 'consumed';
                case 'right':
                    return 'done';                           // 비교의 오른쪽 피연산자
                default:
                    return 'unknown';
            }
        },
    };
}

/**
 * 스크립트를 **왼쪽에서 오른쪽으로 한 번만** 훑으며 각 참조의 문법 자리를
 * 판정한다.
 *
 * 참조마다 처음부터 다시 훑던 동안 진단이 O(참조 수 × 길이) 였다 — 같은 값을
 * 여러 번 쓴 큰 명령줄에서 초 단위로 늘어졌고, 큰 명령줄에서 죽지 않게 고쳐 둔
 * 취지와 정면으로 어긋났다. 참조는 정렬돼 들어오므로 상태를 이어서 굴린다.
 *
 * 인용·이스케이프·`${…}`·명령 치환은 dialect 규칙대로 처리한다 —
 * `sh -c "echo \"x; ${v}\""` 의 `;` 는 데이터이지 명령 구분자가 아니다.
 */
function createPositionScanner(script: string, dialect: Exclude<ScriptDialect, 'unknown'>) {
    const escape = dialect === 'cmd' ? '^' : (dialect === 'powershell' ? '`' : '\\');
    let cursor = 0;
    let single = false;
    let double = false;
    /** 이 뒤로는 `}` 가 없다 — 닫히지 않은 `${` 를 만날 때마다 다시 찾지 않는다. */
    let braceCloseExhausted = false;
    // 확장 구분자는 스크립트당 한 번만 센다 — 참조마다 다시 훑으면 O(참조 × 길이) 다.
    const expansionMarks = dialect === 'cmd'
        ? cmdExpansionMarks(script)
        : { percent: { first: Infinity, last: -Infinity }, bang: { first: Infinity, last: -Infinity } };

    /** 진행 중인(아직 공백을 만나지 않은) 낱말. */
    let pending = '';
    /**
     * 진행 중인 낱말이 **명령 치환 결과를 품는다** — `e$(echo val)` 의 리터럴
     * 조각(`e`)만 봐서는 실제 이름을 알 수 없으므로 머리가 되면 `dynamic` 이다.
     */
    let pendingDynamic = false;
    let headFound = false;
    let headKind: CommandHeadKind = 'safe';
    /** 머리의 basename — 옵션 하나로 인자를 코드로 바꾸는 명령을 알아보는 데 쓴다. */
    let headName = '';
    let condition: ReturnType<typeof cmdIfConditionConsumer> | undefined;
    let conditionUnknown = false;
    let redirectionTargetPending = false;
    let doubleDashTrusted = false;
    let sawOptionAfterHead = false;

    /**
     * `substitution` 은 낱말을 **만드는** 것(`$(…)` · `` `…` ``), `group` 은 문법
     * 묶음일 뿐 낱말을 만들지 않는 것(`( … )` · `case` 패턴 · cmd `for … in (…)`).
     */
    type FrameKind = 'substitution' | 'group' | 'backtick';

    type SegmentState = {
        pending: string; pendingDynamic: boolean; headFound: boolean; headKind: CommandHeadKind;
        headName: string;
        condition: ReturnType<typeof cmdIfConditionConsumer> | undefined; conditionUnknown: boolean;
        redirectionTargetPending: boolean; doubleDashTrusted: boolean; sawOptionAfterHead: boolean;
    };

    /**
     * 치환·subshell 에 들어가기 전의 **바깥 세그먼트**. 닫히면 그 자리로 돌아간다.
     *
     * 플래그 하나로 "낱말 안에서 열렸다"만 기억하던 방식은 안쪽 `)`·백틱 하나에
     * 어긋났다 — `s$(echo $(echo h)) -c ${v}` 는 안쪽 치환이 닫히며 플래그를 지워
     * 바깥 낱말이 다시 리터럴로 읽혔다(실제로는 `sh -c` 가 되어 값이 실행된다).
     * 스택으로 두면 중첩이 몇 겹이든 짝이 맞고, 덤으로 `echo $(date) ${v}` 처럼
     * 치환이 **끝난 뒤** 바깥 명령이 이어지는 형태의 과탐도 사라진다(예전에는
     * 닫는 자리에서 세그먼트를 초기화해 뒤 값이 명령 자리로 보였다).
     */
    const substitutionStack: { outer: SegmentState | undefined; kind: FrameKind; single: boolean; double: boolean }[] = [];
    /**
     * 이 깊이를 넘으면 바깥 세그먼트를 **담지 않는다**. 프레임 자체는 계속 쌓아
     * 짝을 맞추되(열 때마다 하나), 되살릴 것이 없으니 닫을 때 fail-closed 다.
     * 병적으로 깊은 중첩(`$($($(…`)에서 상태 사본이 메모리를 갉아먹는 것을 막는다.
     */
    const MAX_CAPTURED_DEPTH = 128;

    const captureSegment = (): SegmentState => ({
        pending, pendingDynamic, headFound, headKind, headName,
        condition, conditionUnknown, redirectionTargetPending, doubleDashTrusted, sawOptionAfterHead,
    });
    const restoreSegment = (s: SegmentState) => {
        pending = s.pending; pendingDynamic = s.pendingDynamic;
        headFound = s.headFound; headKind = s.headKind; headName = s.headName;
        condition = s.condition; conditionUnknown = s.conditionUnknown;
        redirectionTargetPending = s.redirectionTargetPending;
        doubleDashTrusted = s.doubleDashTrusted; sawOptionAfterHead = s.sawOptionAfterHead;
    };

    const startSegment = () => {
        pending = '';
        pendingDynamic = false;
        headFound = false;
        headKind = 'safe';
        headName = '';
        condition = undefined;
        conditionUnknown = false;
        redirectionTargetPending = false;
        doubleDashTrusted = false;
        sawOptionAfterHead = false;
    };

    /** 치환이 닫힌 자리에서 뒤 글자가 같은 낱말을 잇는가. */
    const gluesForward = (at: number, to: number) =>
        at + 1 < to && !/[\s;&|()<>{}]/.test(script[at + 1]);

    /**
     * 치환·그룹을 연다 — 바깥 세그먼트를 밀어 두고 안쪽을 새로 시작한다.
     *
     * 진행 중인 낱말(`pending`)은 **일부러 flush 하지 않는다.** 치환이 낱말 안에서
     * 열렸으면(`e$(…)`) 그 조각은 아직 낱말의 일부이고, 밖에서 열렸으면 애초에
     * 비어 있다. 프레임이 그대로 안고 있다가 닫힐 때 되돌린다.
     *
     * 인용 상태도 프레임에 싣고 **안쪽은 인용 없이 새로 시작한다.** `$( … )` 안은
     * 독립된 스크립트라 바깥 `"` 가 미치지 않는다 — 이것을 안 하면
     * `echo "$( (true); eval ${v} )"` 에서 안쪽 `(true)` 의 `)` 가 바깥 `$(` 를
     * 닫은 것으로 오인돼 값이 면제되고(실행 확인), 반대로 안전한
     * `echo "$(printf %s ${v})"` 에는 과탐이 붙었다.
     */
    const openSubstitution = (kind: FrameKind) => {
        const outer = substitutionStack.length < MAX_CAPTURED_DEPTH ? captureSegment() : undefined;
        substitutionStack.push({ outer, kind, single, double });
        startSegment();
        single = false;
        double = false;
    };

    /**
     * 치환·그룹을 닫는다.
     *
     * **치환**(`$(…)` · `` `…` ``)은 낱말을 만든다 — 바깥 세그먼트로 돌아가고 그
     * 낱말을 동적으로 표시한다. **그룹**(`( … )`)은 낱말을 만들지 않으므로 되살리면
     * 안 된다: `for %f in (a b) do ${v}` 의 `do` 가 앞 명령의 인자로 읽혀 뒤가 통째로
     * 면제되고, `case x in (x) ${v};; esac` 도 같은 방식으로 빠져나간다(실행 확인).
     */
    const closeSubstitution = (kinds: readonly FrameKind[], at: number, to: number) => {
        endWord();                        // 치환 **안**의 마지막 낱말
        // **최상단 프레임만** 본다. 맞는 종류를 찾을 때까지 파고들면 그 사이의
        // 프레임이 조용히 버려져 바깥 상태가 어긋나고, 백틱마다 스택 전체를 훑던
        // 검사와 함께 O(중첩 깊이 × 길이) 를 만들었다(360KB 입력에 9.7초).
        const frame = substitutionStack[substitutionStack.length - 1];
        if (!frame || !kinds.includes(frame.kind)) { startSegment(); return; }
        substitutionStack.pop();
        single = frame.single;
        double = frame.double;
        // 그룹은 낱말을 만들지 않으므로 바깥 명령을 되살리지 않는다. 상한을 넘어
        // 담지 못한 프레임도 되살릴 것이 없다 — 둘 다 fail-closed.
        if (frame.kind === 'group' || !frame.outer) { startSegment(); return; }
        restoreSegment(frame.outer);
        pendingDynamic = true;
        if (!gluesForward(at, to)) { endWord(); }  // 낱말이 여기서 끝난다
    };

    const consumeWord = (word: string, dynamic: boolean) => {
        if (redirectionTargetPending) { redirectionTargetPending = false; return; }
        if (condition) {
            const verdict = condition.feed(word);
            if (verdict === 'consumed') { return; }
            if (verdict === 'done') { condition = undefined; return; }
            conditionUnknown = true;
            condition = undefined;
            return;
        }
        // 리다이렉션은 명령 이름 **앞뒤 어디서나** 온다 — `headFound` 분기 뒤로
        // 미루면 `echo ok > out/${v}` 의 `>` 가 그냥 인자로 삼켜져 대상 낱말을
        // 리다이렉션으로 판정할 기회 자체가 사라진다.
        const redirection = REDIRECTION_OPERATOR.exec(word);
        if (redirection) {
            // 낱말이 연산자 **그 자체**일 때만 다음 낱말이 대상이다.
            // `>file` 은 대상이 이미 붙어 있으므로 다음 낱말은 평범한 인자다.
            if (redirection[0].length === word.length) { redirectionTargetPending = true; }
            return;
        }
        if (headFound) {
            // 고정 명령이라도 이 옵션 뒤부터는 인자가 코드·변수다(`find -exec` ·
            // `printf -v`) — 그 세그먼트의 나머지를 명령 자리로 본다.
            const trigger = ARGUMENT_REINTERPRETING_OPTIONS.get(headName);
            if (trigger && trigger.test(word.toLowerCase())) { headKind = 'reinterpreting'; return; }
            // **`--` 앞에 옵션이 있으면 그 `--` 를 믿을 수 없다.** `curl -o -- ${v}`
            // 의 `--` 는 `-o` 가 삼킨 파일 이름이라 값은 여전히 옵션으로 읽힌다.
            if (word === '--' && !sawOptionAfterHead) { doubleDashTrusted = true; }
            else if (word.startsWith('-')) { sawOptionAfterHead = true; }
            return;
        }
        if (dialect === 'cmd' && word.toLowerCase() === 'if') {
            // `if` 뒤에는 **조건**이 오고 그 다음이 명령이다. 예약어처럼 한 낱말만
            // 건너뛰면 조건(`1==1` · `1 EQU 1`)을 고정 명령 이름으로 오인한다.
            condition = cmdIfConditionConsumer();
            return;
        }
        if (COMMAND_INTRODUCING_KEYWORDS.has(word.toLowerCase())) { return; }
        if (dialect === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { return; }   // 선행 대입
        headFound = true;
        const classified = classifyCommandHead(word, dialect);
        headName = classified.name;
        // 치환을 품은 머리(`$(echo ev)al` · `e$(echo val)`)는 무엇이 될지 알 수 없다.
        headKind = dynamic ? 'dynamic' : classified.kind;
    };

    function endWord() {
        if (pending.length === 0 && !pendingDynamic) { return; }
        consumeWord(pending, pendingDynamic);
        pending = '';
        pendingDynamic = false;
    }

    /** `to` 직전까지 읽는다. */
    const advanceTo = (to: number) => {
        for (; cursor < to; cursor++) {
            const ch = script[cursor];
            if (!single && ch === escape && cursor + 1 < to) {
                pending += ch + script[cursor + 1];
                cursor++;
                // **CRLF 행 잇기는 세 글자 한 덩어리다.** `\r` 만 먹고 `\n` 을 남기면
                // 그 개행이 아래에서 명령 구분자가 되어, 이어 붙어야 할 낱말이 갈린다
                // (`i` + `ex` 로 쪼개져 `iex` 를 놓쳤다).
                if (script[cursor] === '\r' && script[cursor + 1] === '\n' && cursor + 1 < to) {
                    pending += script[cursor + 1];
                    cursor++;
                }
                continue;
            }
            if (!double && ch === "'" && dialect !== 'cmd') { single = !single; pending += ch; continue; }
            if (!single && ch === '"') { double = !double; pending += ch; continue; }
            if (single) { pending += ch; continue; }
            // `${…}` 는 매개변수 확장이다 — 그 안의 `{`·`}` 는 명령 묶음이 아니다.
            if (ch === '$' && script[cursor + 1] === '{' && !braceCloseExhausted) {
                const close = script.indexOf('}', cursor + 2);
                // `}` 가 더 없다는 사실을 기억한다 — 닫히지 않은 `${` 가 많으면
                // 매번 끝까지 다시 훑어 O(n²) 가 된다(같은 함정을 토크나이저에서
                // 이미 한 번 밟았다).
                if (close === -1) { braceCloseExhausted = true; }
                if (close === -1 || close >= to) { pending += script.slice(cursor, to); cursor = to; break; }
                pending += script.slice(cursor, close + 1);
                cursor = close;
                continue;
            }
            // 명령 치환은 큰따옴표 안에서도 살아 있다.
            if (ch === '$' && script[cursor + 1] === '(') { openSubstitution('substitution'); cursor++; continue; }
            if (dialect === 'powershell' && ch === '@' && script[cursor + 1] === '(') { openSubstitution('substitution'); cursor++; continue; }
            if (dialect === 'posix' && ch === '`') {
                // 여는 백틱인지 닫는 백틱인지는 **최상단 프레임**으로 판별한다.
                // 스택 전체를 훑으면(`some`) 백틱마다 O(깊이) 라 깊은 중첩에서
                // 진단이 초 단위로 늘어졌다.
                const top = substitutionStack[substitutionStack.length - 1];
                if (top && top.kind === 'backtick') { closeSubstitution(['backtick'], cursor, to); }
                else { openSubstitution('backtick'); }
                continue;
            }
            if (double) { pending += ch; continue; }
            // `{`·`}` 는 POSIX 에서 **독립된 낱말일 때만** 그룹 경계다. 낱말 안에
            // 있으면 brace expansion 이라 `e{v,v}al` 은 셸에게 `eval` 이다(실행 확인)
            // — 무조건 끊으면 세 개의 고정 명령처럼 읽혀 뒤의 값이 인자로 빠져나갔고,
            // 반대로 `echo a{b,c} ${v}` 는 세그먼트가 초기화되는 바람에 값이
            // 명령으로 **오탐**됐다.
            //
            // **PowerShell 은 해당 없다.** 거기서 `{` 는 붙어 있어도 늘 스크립트
            // 블록을 열고 그 안은 코드다 — `{iex ${v}}` 를 낱말로 묶으면 바깥 명령이
            // 머리로 남아 값이 인자로 면제된다. **cmd 도 해당 없다** — 거기엔 중괄호
            // 문법 자체가 없어 평범한 글자다(무조건 경계로 두면 `echo {x} ${v}` 에
            // 과탐이 붙는다).
            if (dialect === 'posix' && (ch === '{' || ch === '}')) {
                if (pending.length === 0 && !pendingDynamic
                    && (cursor + 1 >= to || /[\s;&|()<>]/.test(script[cursor + 1]))) {
                    endWord(); startSegment(); continue;
                }
                pending += ch;
                continue;
            }
            if (dialect === 'cmd' && (ch === '{' || ch === '}')) { pending += ch; continue; }
            // 개행은 공백이기 **전에** 명령 구분자다 — 공백으로 먼저 걸러 내면
            // `echo ok\n${v}` 의 `${v}` 가 앞 명령의 인자로 읽힌다.
            // POSIX·cmd 의 맨 `(` 는 **그룹**이다(subshell · `for … in (a b)`) —
            // 낱말을 만들지 않으므로 닫힐 때 바깥 명령을 되살리면 안 된다. 프레임은
            // 그래도 밀어 두어야 중첩된 `$( ( ) )` 에서 안쪽 `)` 가 바깥 치환
            // 프레임을 잘못 꺼내지 않는다.
            //
            // PowerShell 의 `( … )` 는 **값을 내는 부분식**이라 `$( … )` 쪽에 가깝다 —
            // 그룹으로 보면 `Write-Output (Get-Date) ${v}` 에서 바깥 명령이 사라져
            // 과탐이 붙는다.
            if (ch === '(') { openSubstitution(dialect === 'powershell' ? 'substitution' : 'group'); continue; }
            if (ch === ')') { closeSubstitution(['substitution', 'group'], cursor, to); continue; }
            if (/[;&|{}\n\r]/.test(ch)) { endWord(); startSegment(); continue; }
            // 리다이렉션 연산자는 **공백 없이도** 낱말을 가른다 — 셸은
            // `echo prefix>out/x` 를 `echo prefix` 와 `>out/x` 로 읽어 `out/x` 에
            // 쓴다. 낱말의 시작만 보던 동안 이 형태가 인자로 분류돼, 값이
            // `../../target` 이면 의도한 디렉터리 밖 파일을 대상으로 삼을 수
            // 있었다. 여기서 앞 낱말을 끊고 연산자부터 다시 모으면 붙어 있는
            // 대상(`>out/${v}`)을 판정하던 경로가 그대로 쓰인다.
            if (ch === '>' || ch === '<') {
                // **연산자에 붙은 숫자는 IO number 다** — `2>out` 의 `2` 는 명령
                // 이름이 아니라 리다이렉션의 일부다. 여기서 무조건 낱말을 끊으면
                // `2` 가 고정 명령 머리로 확정되고, 뒤따르는 `${v}`(실제로 실행되는
                // 명령 이름)가 안전한 인자로 분류돼 면제됐다. POSIX 처럼 **낱말
                // 전체가 숫자**일 때만 붙여 둔다 — `prefix2>` 의 `prefix2` 는 셸도
                // IO number 로 읽지 않으므로 그대로 끊는다.
                if (!/^[0-9]+$/.test(pending)) { endWord(); }
                // 연산자는 **한 덩어리로** 모은다. 글자마다 끊으면 `>>` 의 두 번째
                // `>` 가 첫 번째의 **대상**으로 읽혀(`consumeWord` 가 대상 낱말을
                // 소비하고 플래그를 내린다) 추적이 그 자리에서 끊긴다.
                while (cursor < to && /[<>&|]/.test(script[cursor])) { pending += script[cursor]; cursor++; }
                cursor--;                                    // for 문의 `cursor++` 보정
                continue;
            }
            if (/\s/.test(ch)) { endWord(); continue; }
            pending += ch;
        }
    };

    return {
        /** 참조 하나의 자리. 참조는 **왼쪽에서 오른쪽 순서**로 물어야 한다. */
        positionAt(refStart: number, refEnd: number): ReferencePosition {
            advanceTo(refStart);
            // `cmd` 는 `%NAME%`(지연 확장이면 `!NAME!`)를 **치환한 뒤 다시 해석**한다.
            // 이름이 아무리 안전해도 그 값에 `&` 가 있으면 명령이 된다 — `envPick`
            // 을 면제하지 않는 것과 같은 위험이다.
            const inExpansion = dialect === 'cmd' && insideCmdExpansion(script, refStart, refEnd, expansionMarks);
            const glued = pending.length > 0;
            const answer = ((): ReferencePosition => {
                if (inExpansion) { return { kind: 'command' }; }
                if (conditionUnknown || condition) { return { kind: 'command' }; }   // 모르는 조건 — fail-closed
                // 명령 이름을 아직 못 만났으면 이 참조가 곧 명령 이름이다.
                // 선행 대입(`TAG=${v}`)도 여기 들어간다 — 자리만으로는 그 값이
                // 뒤에서 `$TAG` 로 실행되지 않는다는 것을 증명할 수 없다.
                if (!headFound) { return { kind: 'command' }; }
                // 재해석 명령이든 실행 시점에 정해지는 머리든 값이 코드가 될 수 있다.
                if (headKind !== 'safe') { return { kind: 'command' }; }
                // 리다이렉션 **대상**이면 임의의 파일을 읽고 쓴다.
                //   - 붙어 있는 경우(`>out/${v}`): 지금 낱말이 연산자로 시작한다.
                //   - 떨어져 있는 경우(`> out/${v}`): 직전 낱말이 연산자 **그 자체**라
                //     `redirectionTargetPending` 이 서 있다. **대상 낱말 어디에 있든**
                //     참조는 대상의 일부다 — 앞에 prefix 가 붙었는지(`out/`)는 상관없다.
                //     `>file ${v}` 처럼 대상이 이미 끝났으면 플래그가 내려가 인자가 된다.
                if (glued && REDIRECTION_OPERATOR.test(pending)) { return { kind: 'redirection' }; }
                if (redirectionTargetPending) { return { kind: 'redirection' }; }
                return { kind: 'argument', afterDoubleDash: doubleDashTrusted };
            })();
            // 참조 텍스트는 지금 낱말의 일부다(`pre${v}post`).
            pending += script.slice(refStart, refEnd);
            cursor = refEnd;
            return answer;
        },
    };
}

/**
 * 스크립트 문법에서 이 참조가 어느 자리인가. 참조 하나만 물을 때 쓴다 —
 * 여러 개면 {@link createPositionScanner} 로 한 번에 훑는다.
 */
function referencePosition(script: string, refStart: number, refEnd: number, dialect: ScriptDialect): ReferencePosition {
    if (dialect === 'unknown') {
        // 무엇으로 읽힐지 모르면 셋 중 **가장 엄한** 판정을 취한다.
        const all = (['posix', 'cmd', 'powershell'] as const)
            .map(d => createPositionScanner(script, d).positionAt(refStart, refEnd));
        return strictestPosition(all);
    }
    return createPositionScanner(script, dialect).positionAt(refStart, refEnd);
}

/** 여러 dialect 판정 중 가장 엄한 것. */
function strictestPosition(all: ReferencePosition[]): ReferencePosition {
    return all.find(p => p.kind === 'command')
        ?? all.find(p => p.kind === 'redirection')
        ?? all.find(p => p.kind === 'argument' && !p.afterDoubleDash)
        ?? all[0];
}


/**
 * 중첩 인터프리터 스크립트가 참조하는 값들이 **모양이 제약된 소스**에서만 오고,
 * 그 값이 스크립트 문법에서 **데이터 자리**에 놓이는가.
 *
 * 면제는 **런타임이 실제로 보장하는 것만** 인정해야 한다. 처음 구현은
 * `envPick` 을 무조건 면제했는데, 환경변수 **이름**이 안전해도 `cmd` 는
 * `%VAR%` 를 치환한 **뒤** 그 결과를 다시 해석하므로 값에 `&` 가 있으면
 * 그대로 뚫린다 — 우리 CHANGELOG 가 같은 이유로 번들 액션을 고쳐 놓고
 * Doctor 는 반대로 판정하고 있었다.
 */
function nestedInterpreterRefsAreConstrained(candidate: ScriptCandidate, tasksById: Map<string, Task>): boolean {
    // base64 처럼 텍스트로 문법을 따질 수 없는 자리는 면제하지 않는다 —
    // 허용 문자와 디코딩된 코드의 의미가 무관하다(`-EncodedCommand`).
    if (candidate.opaque) { return false; }
    const script = candidate.text;
    // 참조를 읽는 규칙은 한곳(`parseReferenceAlternatives`)에만 둔다. 여기서
    // 자체 정규식을 쓰던 동안 `??` 체인의 **첫 대안만** 보였다 —
    // `${safe.value ?? free.value}` 에서 `safe` 만 검사하고 통과시켰으므로,
    // 첫 대안이 제약된 inputBox 이기만 하면 뒤에 무엇이 오든 조용했다.
    // 어느 대안이 값을 낼지는 런타임에 갈리므로 **전부** 제약돼야 안전하다.
    const matches = [...script.matchAll(/\$\{([^}]+)\}/g)];
    // 스캐너는 스크립트를 **한 번만** 훑는다 — 참조마다 처음부터 다시 읽으면
    // 진단이 O(참조 수 × 길이) 가 된다. dialect 를 모르면 셋 다 굴려 가장 엄한
    // 판정을 취한다.
    const dialects: Exclude<ScriptDialect, 'unknown'>[] =
        candidate.dialect === 'unknown' ? ['posix', 'cmd', 'powershell'] : [candidate.dialect];
    const scanners = dialects.map(d => createPositionScanner(script, d));
    // **참조마다 자기 자리로 판정한다.** 자리를 한데 모아 하나의 플래그로 쓰면
    // `sh -c "TAG=${tag.value} echo ${arg.value}"` 처럼 대입 값과 인자가 섞인
    // 스크립트에서 한쪽 자리의 위험이 다른 쪽 값에 옮겨 붙는다.
    return matches.every(match => {
        const start = match.index ?? 0;
        const position = strictestPosition(
            scanners.map(scanner => scanner.positionAt(start, start + match[0].length))
        );
        // 값이 명령 자리에 놓이면 문자 집합이 아무리 좁아도 면제하지 않는다.
        // 리다이렉션 대상도 마찬가지다 — 실행되지는 않지만 임의의 파일을 덮어쓴다.
        if (position.kind === 'command' || position.kind === 'redirection') { return false; }
        // 인자 자리라도 값이 `-` 로 시작할 수 있으면 **옵션**이 되고, 옵션 하나가
        // 명령 실행으로 이어질 수 있다(`find … -exec id \;`). `--` 뒤라면 안전하다.
        const optionInjectable = position.kind === 'argument' && !position.afterDoubleDash;
        // **태스크를 가리키지 않는 참조도 안전하지 않다.** `${workspaceFolder}` 는
        // 사용자 폴더 이름이고 거기에 `;` 나 `&` 가 들어갈 수 있다.
        return parseReferenceAlternatives(match[1]).every(alt => {
            // 참조마다 태스크 배열을 훑던 동안 진단이 O(참조 수 × 태스크 수) 였다.
            const source = tasksById.get(alt.head) as any;
            if (!source) { return false; }
            // 검증 **이후에** 붙는 prefix/suffix 는 패턴이 보장하지 못한다.
            if (containsShellMetacharacter(String(source.prefix ?? '')) ||
                containsShellMetacharacter(String(source.suffix ?? ''))) {
                return false;
            }
            // prefix 가 붙으면 값의 **첫 글자**는 prefix 의 첫 글자다 — 옵션이
            // 되는지는 값이 아니라 prefix 로 갈린다.
            const prefixed = typeof source.prefix === 'string' && source.prefix.length > 0;
            const canLeadWithDash = (fromValue: boolean) => (prefixed ? String(source.prefix).startsWith('-') : fromValue);
            if (source.type === 'inputBox') {
                if (!patternMeaningfullyConstrains(source.validatePattern)) { return false; }
                return !optionInjectable || !canLeadWithDash(patternCanStartWithDash(source.validatePattern));
            }
            if (source.type === 'quickPick') {
                // 항목 자체에 메타문자가 있으면 고정 목록이라도 안전하지 않다.
                if (!Array.isArray(source.items) || source.itemsFromCommand) { return false; }
                return source.items.every((entry: any) => {
                    const label = typeof entry === 'string' ? entry : entry?.label;
                    if (typeof label !== 'string') { return false; }
                    if (optionInjectable && canLeadWithDash(label.startsWith('-'))) { return false; }
                    return !containsShellMetacharacter(label);
                });
            }
            // `envPick` 은 면제하지 않는다 — 위 주석 참조.
            return false;
        });
    });
}

/** `[…]` 안에서 `-` 를 매치할 수 있는가(리터럴이거나 범위에 걸리거나). */
function charClassIncludesDash(classBody: string): boolean {
    let i = 0;
    let previous: number | undefined;
    while (i < classBody.length) {
        if (classBody[i] === '\\' && (classBody[i + 1] === 'w' || classBody[i + 1] === 'd')) {
            i += 2; previous = undefined; continue;         // `\w` · `\d` 에는 `-` 가 없다
        }
        if (classBody[i] === '-' && previous !== undefined && i + 1 < classBody.length) {
            const right = readRegexLiteral(classBody, i + 1);
            if (right === undefined) { return true; }       // 못 읽었다 — 모르면 위험으로
            if (previous <= 0x2d && 0x2d <= right.code) { return true; }
            i = right.next; previous = undefined; continue;
        }
        const literal = readRegexLiteral(classBody, i);
        if (literal === undefined) { return true; }
        if (literal.code === 0x2d) { return true; }
        previous = literal.code;
        i = literal.next;
    }
    return false;
}

/** 짝이 맞는 `)` 의 인덱스. 클래스와 이스케이프는 건너뛴다. */
function matchingParenthesis(body: string, open: number): number | undefined {
    let depth = 0;
    for (let i = open; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') {
            const end = scanSafeCharClass(body, i);
            if (end === undefined) { return undefined; }
            i = end - 1;
            continue;
        }
        if (ch === '(') { depth++; }
        if (ch === ')' && --depth === 0) { return i; }
    }
    return undefined;
}

/** 맨 바깥 `|` 로 가른다. 클래스·그룹 안의 `|` 는 건드리지 않는다. */
function splitTopLevelAlternatives(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') {
            const end = scanSafeCharClass(body, i);
            if (end === undefined) { return [body]; }
            i = end - 1;
            continue;
        }
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth--; continue; }
        if (ch === '|' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
    }
    parts.push(body.slice(start));
    return parts;
}

/**
 * 이 패턴이 매치하는 값이 `-` 로 **시작할 수 있는가**. 모르면 `true`(위험).
 *
 * 문자 집합만 좁혀도 `-` 로 시작할 수 있으면 값이 인자가 아니라 **옵션**이 된다 —
 * `find … ${ask.value} id \;` 에 `-exec` 를 넣으면 명령이 실행된다. 그래서 권장
 * 패턴은 `^[A-Za-z0-9_][A-Za-z0-9_-]*$` 처럼 **첫 글자**를 막아야 한다.
 */
/** 원자 하나를 읽은 결과. `canBeEmpty` 가 없으면 빈 그룹으로 검사를 우회할 수 있다. */
type RegexAtom = { canStartWithDash: boolean; canBeEmpty: boolean; next: number };

/**
 * 원자 하나와 그 수량자를 읽는다.
 *
 * **`canBeEmpty` 를 따로 계산해야 한다.** 그룹이 빈 문자열도 매치하면
 * (`^(ok|)-exec$` · `^([a-z]*)-exec$`) 그 뒤 원자가 첫 글자가 되는데, 그룹이
 * `-` 로 시작하는지만 보던 동안 `-exec` 가 검사를 그대로 통과했다.
 */
function readRegexAtom(body: string, i: number): RegexAtom | undefined {
    let canStartWithDash: boolean;
    let canBeEmpty: boolean;
    let end: number;
    const ch = body[i];
    if (ch === '(') {
        const close = matchingParenthesis(body, i);
        if (close === undefined) { return undefined; }
        const inner = body.slice(body.startsWith('(?:', i) ? i + 3 : i + 1, close);
        const alternatives = splitTopLevelAlternatives(inner);
        canStartWithDash = alternatives.some(alt => sequenceCanStartWithDash(alt));
        canBeEmpty = alternatives.some(alt => sequenceCanBeEmpty(alt));
        end = close + 1;
    } else if (ch === '[') {
        const close = scanSafeCharClass(body, i);
        if (close === undefined) { return undefined; }
        canStartWithDash = charClassIncludesDash(body.slice(i + 1, close - 1));
        canBeEmpty = false;
        end = close;
    } else if (ch === '\\' && (body[i + 1] === 'w' || body[i + 1] === 'd')) {
        canStartWithDash = false;
        canBeEmpty = false;
        end = i + 2;
    } else {
        const literal = readRegexLiteral(body, i);
        if (literal === undefined) { return undefined; }
        canStartWithDash = literal.code === 0x2d;
        canBeEmpty = false;
        end = literal.next;
    }
    // 수량자를 **원자에 적용한다.** `{0}` 은 아예 나타나지 않으므로 `-` 로 시작할
    // 수 없고, `*` · `?` · `{0,n}` 은 없을 수도 있다. 뒤의 lazy 표시(`*?` · `{0,3}?`)
    // 까지 한 수량자로 삼킨다 — 남겨 두면 그 `?` 가 **다음 원자**로 읽혀
    // `^[a-z]*?-exec$` 가 "`-` 로 시작할 수 없다" 로 판정됐다.
    const quantifier = /^(\*|\+|\?|\{(\d+)(,(\d*))?\})\??/.exec(body.slice(end));
    if (quantifier) {
        const exact = quantifier[2] !== undefined ? Number(quantifier[2]) : undefined;
        const zeroAllowed = quantifier[1] === '*' || quantifier[1] === '?' || exact === 0;
        const neverAppears = exact === 0 && quantifier[3] === undefined;
        if (neverAppears) { canStartWithDash = false; }
        if (zeroAllowed) { canBeEmpty = true; }
        end += quantifier[0].length;
    }
    return { canStartWithDash, canBeEmpty, next: end };
}

function sequenceCanStartWithDash(body: string): boolean {
    let i = 0;
    while (i < body.length) {
        const atom = readRegexAtom(body, i);
        if (atom === undefined) { return true; }        // 못 읽었다 — 모르면 위험으로
        if (atom.canStartWithDash) { return true; }
        // 이 원자가 **없을 수도** 있으면 다음 원자가 첫 글자가 된다.
        if (!atom.canBeEmpty) { return false; }
        i = atom.next;
    }
    return false;   // 전부 비워질 수 있으면 빈 값이다 — `-` 로 시작하지 않는다
}

/** 이 시퀀스가 빈 문자열을 매치할 수 있는가. 모르면 `true`(위험한 쪽). */
function sequenceCanBeEmpty(body: string): boolean {
    let i = 0;
    while (i < body.length) {
        const atom = readRegexAtom(body, i);
        if (atom === undefined || !atom.canBeEmpty) { return atom === undefined; }
        i = atom.next;
    }
    return true;
}

/** {@link sequenceCanStartWithDash} 를 앵커 벗긴 패턴 본문에 적용한다. */
function patternCanStartWithDash(pattern: unknown): boolean {
    if (typeof pattern !== 'string' || pattern.length < 2) { return true; }
    return splitTopLevelAlternatives(pattern.slice(1, -1)).some(alt => sequenceCanStartWithDash(alt));
}

/** 셸·cmd 에서 문법적 의미가 없는 **평범한 글자**인가. */
function isSafeLiteralChar(ch: string): boolean {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) { return false; }   // 제어문자 — 분석 대상 밖
    return !containsShellMetacharacter(ch);
}

/** `from`~`to` 코드포인트 구간에 위험한 글자가 하나도 없는가. */
function codePointRangeIsSafe(from: number, to: number): boolean {
    if (to < from) { return false; }
    // 셸 메타문자는 전부 ASCII 다 — 0x7f 위는 검사할 것이 없다.
    for (let code = from; code <= Math.min(to, 0x7f); code++) {
        if (!isSafeLiteralChar(String.fromCodePoint(code))) { return false; }
    }
    return true;
}

/**
 * 문자 클래스 안에서 리터럴 한 글자를 읽는다.
 *
 * `\` 뒤가 영숫자면 클래스 축약(`\s` · `\W`)이나 제어·수치 이스케이프
 * (`\t` · `\x3b` = `;`)다 — 어느 쪽도 눈으로 읽히지 않으므로 분석 불가로 본다.
 */
function readRegexLiteral(source: string, i: number): { code: number; next: number } | undefined {
    const ch = source[i];
    if (ch === undefined) { return undefined; }
    if (ch !== '\\') {
        const code = source.codePointAt(i)!;
        return { code, next: i + (code > 0xffff ? 2 : 1) };
    }
    const escaped = source[i + 1];
    if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) { return undefined; }
    const code = source.codePointAt(i + 1)!;
    return { code, next: i + 1 + (code > 0xffff ? 2 : 1) };
}

/**
 * 문자 클래스(`[…]`)가 **안전한 글자만** 담고 있는가. 반환값은 `]` 다음 위치이고,
 * 분석할 수 없으면 `undefined`.
 */
function scanSafeCharClass(body: string, start: number): number | undefined {
    let i = start + 1;
    if (body[i] === '^') { return undefined; }   // 부정 클래스 — 무엇이든 들어올 수 있다
    /** 직전에 읽은 리터럴 — 범위(`a-z`)의 왼쪽 끝이 될 수 있는 것. */
    let previous: number | undefined;
    while (i < body.length) {
        const ch = body[i];
        if (ch === ']') { return i + 1; }
        if (ch === '-' && previous !== undefined && body[i + 1] !== ']' && i + 1 < body.length) {
            const right = readRegexLiteral(body, i + 1);
            if (right === undefined || !codePointRangeIsSafe(previous, right.code)) { return undefined; }
            i = right.next;
            previous = undefined;
            continue;
        }
        if (ch === '\\' && (body[i + 1] === 'w' || body[i + 1] === 'd')) {
            i += 2;                              // `[A-Za-z0-9_]` · `[0-9]` — 전부 안전한 글자다
            previous = undefined;
            continue;
        }
        const literal = readRegexLiteral(body, i);
        if (literal === undefined || !isSafeLiteralChar(String.fromCodePoint(literal.code))) { return undefined; }
        previous = literal.code;
        i = literal.next;
    }
    return undefined;   // 닫히지 않았다
}

/**
 * 정규식 본문이 **안전한 글자만** 매치시키는가.
 *
 * 표본 실행으로는 증명되지 않는다. 문자 몇 개를 넣어 보는 것은 "그 문자
 * **하나만으로는** 통과하지 못한다"는 뜻일 뿐이라, `^(ok|x;id)$` 도 `^.{4}$` 도
 * 표본을 전부 거부하면서 `x;id` 는 통과시킨다. 그래서 패턴을 **직접 읽는다** —
 * 분석할 수 있는 문법(리터럴 · 안전한 문자 클래스 · 그룹 · 선택 · 수량자)만
 * 인정하고, 그 밖(`.` · `\s` · 부정 클래스 · lookaround · 역참조 · 수치
 * 이스케이프)은 전부 "모른다" 로 본다. 모르면 면제하지 않는다.
 *
 * 이 규칙은 문서가 권하는 형태(`^[A-Za-z0-9_-]+$`)를 그대로 통과시킨다.
 */
function regexMatchesOnlySafeChars(body: string): boolean {
    let i = 0;
    /** 그룹 깊이 — 맨 바깥의 `|` 는 앵커를 갈라놓는다. */
    let depth = 0;
    while (i < body.length) {
        const ch = body[i];
        if (ch === '\\' && (body[i + 1] === 'w' || body[i + 1] === 'd')) { i += 2; continue; }
        if (ch === '[') {
            const end = scanSafeCharClass(body, i);
            if (end === undefined) { return false; }
            i = end;
            continue;
        }
        if (ch === '(') {
            // 캡처 그룹과 `(?:` 만 안다. lookaround · 이름 있는 그룹은 분석하지 않는다.
            if (body.startsWith('(?', i) && !body.startsWith('(?:', i)) { return false; }
            depth++;
            i += body.startsWith('(?:', i) ? 3 : 1;
            continue;
        }
        if (ch === ')') {
            if (--depth < 0) { return false; }
            i++;
            continue;
        }
        if (ch === '|') {
            // **맨 바깥의 `|` 는 앵커가 대안마다 붙지 않는다는 뜻이다.** `^a|b$` 는
            // "`a` 로 시작" **또는** "`b` 로 끝" 이라, `a; rm -rf /` 를 통과시킨다.
            // 그룹 안의 `|`(`^(a|b)$`)는 앵커가 전체를 감싸므로 그대로 본다.
            if (depth === 0) { return false; }
            i++;
            continue;
        }
        if (ch === '?' || ch === '*' || ch === '+') { i++; continue; }
        if (ch === '{') {
            const quantifier = /^\{\d+(,\d*)?\}/.exec(body.slice(i));
            if (!quantifier) { return false; }
            i += quantifier[0].length;
            continue;
        }
        // `.` 은 무엇이든 받고, 중간의 `^`·`$` 는 대안마다 앵커가 따로 있다는 뜻이다.
        if (ch === '.' || ch === '^' || ch === '$') { return false; }
        const literal = readRegexLiteral(body, i);
        if (literal === undefined || !isSafeLiteralChar(String.fromCodePoint(literal.code))) { return false; }
        i = literal.next;
    }
    return depth === 0;
}

/**
 * `validatePattern` 이 값의 모양을 **실제로** 좁히는가.
 *
 * `".*"` 처럼 무엇이든 통과시키는 패턴이나 컴파일되지 않는 패턴(`"["` — 런타임이
 * 검증을 건너뛴다)을 제약으로 인정하면, 면제가 곧 우회로가 된다.
 */
function patternMeaningfullyConstrains(pattern: unknown): boolean {
    if (typeof pattern !== 'string' || pattern.length < 2) { return false; }
    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch {
        return false;   // 런타임도 잘못된 패턴은 무시한다 → 제약이 없는 것과 같다
    }
    // 앵커가 없으면 부분 일치라 앞뒤에 무엇이든 붙일 수 있다.
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) { return false; }
    // 앵커(맨 앞 `^`, 맨 뒤 `$`)는 구조이므로 본문에서 뺀다. 마지막 `$` 가
    // 이스케이프된 리터럴이면(`^a\$`) 본문 끝에 `\` 만 남아 분석 불가가 된다.
    if (!regexMatchesOnlySafeChars(pattern.slice(1, -1))) { return false; }
    // 표본은 **증명이 아니라 거름망**이다 — 통과시키는 값을 찾으면 확실히
    // 위험하지만, 못 찾았다고 안전한 것은 아니다(그래서 위 분석이 본체다).
    // 파서에 구멍이 났을 때 마지막으로 걸리는 그물이라 남겨 둔다.
    const dangerous = [';', '&', '|', '`', '$', '(', ')', '<', '>', '*', '?', '!', '^', '%', '"', "'", '\\', ' ', '\n'];
    return dangerous.every(char => !re.test(`a${char}b`) && !re.test(char));
}

function analyzeActionTasks(
    item: ActionItem,
    tasks: Task[],
    input: DoctorInput,
    findings: DoctorFinding[]
): void {
    // null-prototype: 태스크 id 가 '__proto__' 여도 평범한 키가 되도록
    // (런타임의 stepResults 와 같은 처치).
    const allResults: Record<string, any> = Object.create(null);
    // Match the runtime's fallback chain (`executeSingleTask` in
    // extension.ts): explicit per-action workspaceFolder → first workspace
    // root → empty. The bundled `media/actions.json` and any global preset
    // carry no workspaceFolder of their own, so without this fallback Doctor
    // would expand `${workspaceFolder}/out.txt` to `/out.txt` and then flag
    // it as path.outside-workspace — a false positive the runtime never
    // produces.
    const baseDir = input.workspaceFolder ?? input.workspaceRoots[0] ?? '';

    // Doctor walks tasks in declaration order, but the runtime scheduler
    // honors `${id.x}` even when the referenced task appears later in the
    // array (auto-inferred dep flips the run order). Collect every valid
    // task id upfront so we can compute per-iteration "forward task ids"
    // (those not yet simulated into `allResults`) and tolerate refs to
    // them — that was the pre-0.4.42 false positive flagged in the
    // parallel-execution review.
    //
    // Toleration is *forward-only* on purpose: ids already in
    // `allResults` are kept un-tolerated so a `${alreadyRan.typoKey}`
    // typo against an existing capture/result key still surfaces as
    // `variable.unresolved`. Pre-fix this used the full task-id set
    // and silently swallowed those typos.
    const knownTaskIds = new Set<string>();
    const tasksById = new Map<string, Task>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') {
            knownTaskIds.add(t.id);
            tasksById.set(t.id, t);
        }
    }
    // 보간 문맥과 "아직 실행되지 않은 태스크" 집합은 **한 번만** 만들고 태스크를
    // 지날 때마다 갱신한다. 태스크마다 새로 만들면 둘 다 O(태스크 수²) 다.
    const sharedInterpolationContext: any = Object.assign(Object.create(null), {
        workspaceFolder: baseDir,
        extensionPath: input.extensionPath,
    });
    /**
     * 내장 참조는 **태스크 결과보다 세다.** 런타임은 태스크마다 문맥을 새로 만들며
     * `Object.assign(…, allResults, { workspaceFolder, extensionPath })` 로 내장 값을
     * 마지막에 덮는다(`extension.ts`). 여기서는 문맥을 한 번만 만들어 재사용하므로
     * `id: "workspaceFolder"` 태스크가 지나가면 내장 문자열이 결과 객체로 덮여
     * 뒤따르는 `${workspaceFolder}` 가 `variable.unresolved` 로 오진됐다 —
     * 런타임은 정상 해석하는데 진단만 경고하던 자리다.
     */
    const BUILTIN_CONTEXT_KEYS = new Set(['workspaceFolder', 'extensionPath']);
    const forwardTaskIds = new Set<string>(knownTaskIds);

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string') {
            continue;
        }
        // null-prototype — 런타임과 같은 규칙. 평범한 객체면 `${constructor.name}`
        // 같은 상속 키가 결과처럼 해석되어 진단이 런타임과 어긋난다.
        //
        // 태스크마다 `allResults` 를 **복사**하던 동안 진단이 O(태스크 수²) 였다
        // (태스크 4,000개에 2.2초). 문맥은 한 번만 만들고, 시뮬레이션 결과가
        // 나올 때마다 그 자리에 더한다 — 어차피 이전 태스크 결과만 보인다.
        const interpolationContext = sharedInterpolationContext;

        const interpolated: (string | undefined)[] = [];
        const visitString = (value: unknown): string | undefined => {
            if (typeof value !== 'string') {
                return undefined;
            }
            const out = interpolatePipelineVariables(value, interpolationContext);
            interpolated.push(out);
            return out;
        };

        /**
         * `args` 원소는 **런타임과 같은 규칙**으로 펼쳐서 검사한다.
         *
         * 원소가 정확히 배열 참조 하나면(`"${pick.paths}"`) 런타임은
         * `expandArgTemplate` 로 인자 여러 개를 만든다 — 리터럴 `${…}` 가
         * 남지 않는다. 그런데 여기서 `visitString`(단순 보간)으로 보면 배열
         * 값은 보간되지 않아 `${pick.paths}` 가 그대로 남고, 0.6.51 이
         * 문서(`docs/features.md` §fileDialog 다중 선택)에 적어 둔 정상
         * 예제가 `variable.unresolved` 경고를 받았다. 게다가 그 경고 문구는
         * "런타임에서는 리터럴로 전달됩니다"라며 **사실과 반대**를 말했고,
         * 같은 액션에 Preview Run 을 돌리면 "모두 해석됨"이 나와 두 진단이
         * 정면으로 어긋났다.
         *
         * 0.6.57 부터 배열은 문자열 자리에서 **공백으로 이어 붙는다**. 그래서
         * 접두사가 붙은 형태(`"--file=${pick.paths}"`)도 더는 리터럴이 아니지만,
         * 인자 **한 칸**에 경로 여러 개가 들어가므로 의도대로 동작할 리 없다 —
         * 미해결이 아니라 `args.array-joined` 로 따로 알린다.
         */
        const visitArgTemplate = (value: unknown): void => {
            if (typeof value !== 'string') { return; }
            for (const out of expandArgTemplate(value, interpolationContext)) {
                interpolated.push(out);
            }
        };

        /**
         * 참조가 가리키는 값이 배열인가.
         *
         * 누적된 컨텍스트만 보면 **전방 참조를 놓친다.** Doctor 는 선언 순서대로
         * 도는데 런타임 스케줄러는 `${pick.paths}` 를 보고 의존성을 자동 추론해
         * 순서를 뒤집으므로, 뒤에 선언된 `fileDialog` 를 앞 태스크가 참조하는
         * 액션은 정상 동작한다 — 그런데 그 시점의 컨텍스트에는 `pick` 이 없어
         * 배열인지 알 수 없고, 경고가 조용히 빠졌다. 아직 시뮬레이션되지 않은
         * 태스크는 여기서 따로 흉내 내어 **결과의 모양만** 본다.
         *
         * `??` 체인은 대안을 따로 보지 않고 **덧댄 컨텍스트에서 표현식 전체를
         * 한 번** 푼다. 먼저 풀리는 대안이 이기므로, 앞 대안이 문자열이면 뒤
         * 대안이 배열이어도 체인의 값은 배열이 아니다 — 대안별로 보면 그 순서를
         * 잃는다.
         */
        const referencesArray = (expression: string): boolean => {
            if (Array.isArray(resolvePipelineReference(expression, interpolationContext))) { return true; }
            const augmented = Object.assign(Object.create(null), interpolationContext);
            let addedForward = false;
            for (const { head } of parseReferenceAlternatives(expression)) {
                if (!head || Object.prototype.hasOwnProperty.call(allResults, head)) { continue; }
                // 내장 키는 여기서도 덮지 않는다 — 공유 문맥과 같은 규칙이다.
                if (BUILTIN_CONTEXT_KEYS.has(head)) { continue; }
                const forward = tasksById.get(head);
                if (!forward) { continue; }
                augmented[head] = simulateTaskResult(forward);
                addedForward = true;
            }
            // 덧댈 것이 없었으면 위에서 이미 답이 나온 것과 같은 컨텍스트다.
            return addedForward && Array.isArray(resolvePipelineReference(expression, augmented));
        };

        /**
         * `args.array-joined` — 배열 참조가 `args` 원소 안에 **다른 글자와 섞여**
         * 있는 경우 (`"--file=${pick.paths}"`).
         *
         * 런타임은 원소 **전체**가 참조 하나일 때만 인자 여러 개로 펼친다. 섞여
         * 있으면 배열이 공백으로 이어 붙어 **인자 한 칸**이 되고, 그 안에서
         * 경로 사이의 **경계가 사라진다**. argv 로 전달되므로 셸이 다시 쪼개
         * 주지도 않아, 스크립트는 여러 경로를 값 하나로 받는다 — 리터럴로 남는
         * 것과 달리 **조용히 잘못 도는** 자리라 짚어 준다.
         */
        const joinedArgRefs: string[] = [];
        if (Array.isArray(task.args)) {
            for (const a of task.args) {
                if (typeof a !== 'string' || /^\$\{[^}]+\}$/.test(a.trim())) { continue; }
                for (const m of a.matchAll(/\$\{([^}]+)\}/g)) {
                    if (referencesArray(m[1])) {
                        joinedArgRefs.push(m[0]);
                    }
                }
            }
        }

        // shell/command
        if (typeof task.command === 'string') {
            visitString(task.command);
        } else if (task.command && typeof task.command === 'object') {
            for (const v of Object.values(task.command)) {
                visitString(v);
            }
        }
        if (Array.isArray(task.args)) {
            for (const a of task.args) { visitArgTemplate(a); }
        }
        if (task.env) {
            for (const v of Object.values(task.env)) {
                visitString(v as any);
            }
        }
        visitString(task.cwd);
        visitString(task.prompt);
        visitString(task.value);
        visitString(task.placeHolder);
        visitString(task.message);
        visitString(task.input);
        visitString(task.archive);
        visitString(task.destination);
        // `tool` 안의 참조도 런타임에서 보간된다. 빼 두면 `tool: "${ghost.output}"`
        // 이 무경고로 통과한 뒤 리터럴 실행 파일로 실행을 시도한다.
        //
        // OS별 객체는 **모든 branch** 를 본다. Doctor 가 검사하는 것은 이 기계의
        // 실행이 아니라 **설정 파일 자체**여서, windows branch 의 깨진 참조는
        // 그 OS 사용자에게 진짜 오류다 (`command` 의 nested-interpreter 검사도
        // 같은 이유로 branch 전부를 훑는다). 현재 플랫폼 하나만 보여 주는 것은
        // Preview Run 의 몫이다 — 그쪽은 `selectPlatformValue` 로 고른 branch 만
        // 표시·검사한다.
        if (typeof task.tool === 'string') {
            visitString(task.tool);
        } else if (task.tool && typeof task.tool === 'object') {
            for (const branch of Object.values(task.tool as Record<string, unknown>)) {
                visitString(branch as any);
            }
        }
        // 참조 검사와 **별개로**, 지금 이 기계에서 쓸 값이 없다는 것은 따로
        // 알려야 한다 — 런타임은 그 경우 `No tool path specified for the current
        // platform` 으로 실패한다. 참조가 전부 해석돼도 실행은 안 되는 설정이라
        // unresolved 검사만으로는 절대 드러나지 않는다.
        //
        // 문자열 `tool` 도 같이 본다. `tool: ""` 는 OS별 객체가 아니지만
        // `getToolCommand` 가 falsy 검사로 똑같이 던지는 값이다.
        if (task.tool !== undefined && task.tool !== null && selectPlatformValue(task.tool) === undefined) {
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'tool.platform-missing',
                message: `Task '${item.id}.${task.id}' has no usable 'tool' entry for the current platform (${process.platform}), so it would fail at runtime on this machine. Other platforms' entries are still checked.`,
                messageKo: `Task '${item.id}.${task.id}'의 'tool'에 현재 플랫폼(${process.platform})에서 쓸 값이 없어 이 기계에서는 실행이 실패합니다. 다른 플랫폼 항목은 그대로 검사합니다.`,
            });
        }
        if (Array.isArray(task.source)) {
            for (const s of task.source) { visitString(s); }
        } else if (typeof task.source === 'string') {
            visitString(task.source);
        }
        // quickPick itemsFromCommand (string or per-platform object) — runtime
        // interpolates it just like `command`, so its ${...} refs must count
        // toward variable.unresolved too. When it is present the runtime
        // ignores static `items` (handleQuickPick overwrites the pick list),
        // so scanning the stale `items` here would raise a false
        // variable.unresolved for refs that never execute.
        const ifc = (task as any).itemsFromCommand;
        const hasItemsFromCommand = typeof ifc === 'string' ? ifc.length > 0 : !!ifc;
        if (typeof ifc === 'string') {
            visitString(ifc);
        } else if (ifc && typeof ifc === 'object') {
            for (const v of Object.values(ifc)) {
                visitString(v as any);
            }
        }
        if (!hasItemsFromCommand && Array.isArray(task.items)) {
            for (const it of task.items) {
                if (typeof it === 'string') {
                    visitString(it);
                } else if (it && typeof it === 'object') {
                    visitString((it as any).label);
                    visitString((it as any).description);
                }
            }
        }

        // writeFile / appendFile path + content
        const resolvedWritePath = visitString(task.path);
        visitString(task.content);

        // output.filePath
        const resolvedOutputPath = visitString(task.output?.filePath);
        // `output.content` 도 런타임에서 보간된다 (`executeSingleTask`). 빠뜨리면
        // 그 안의 `${ghost.output}` 이 무경고로 파일에 그대로 기록된다.
        visitString(task.output?.content);
        // inputBox 의 prefix/suffix 도 보간 대상이다.
        visitString(task.prefix);
        visitString(task.suffix);
        // `when.var` 도 런타임이 보간한다 (`conditionGate`). 빠뜨리면 조건이
        // 가리키는 참조의 오타가 **아무 진단도 없이** 지나가고, 런타임은 리터럴
        // 문자열을 비교하게 되어 그 분기가 영영 한쪽으로 굳는다.
        const resolvedWhenVar = visitString(task.when?.var);

        // 전방 집합은 위에서 한 번 만들고 태스크가 끝날 때마다 하나씩 뺀다.
        // 전방 태스크 참조는 **그 태스크가 실제로 낼 키에 한해** 관용한다.
        // head 만 보고 통과시키면 `${producer.safe}` 같은 오타가 앞쪽 producer
        // 를 가리킬 때만 조용히 넘어간다 (뒤쪽이면 findTypoRefs 가 잡는다).
        // `??` 체인은 **대안 단위로** 따로 판정한다. 체인은 하나만 풀려도
        // 리터럴로 남지 않으므로, 아래 세 pass 의 "런타임에서는 리터럴로
        // 전달됩니다" 가 체인에는 거짓이 될 수 있다 — 그 자리를 분리한다.
        const chains = analyzeCoalesceRefs(task, allResults, tasksById, task.id);
        const chainLiterals = new Set(chains.map(c => c.literal));
        const unresolved = findUnresolved(interpolated, makeForwardRefTolerance(forwardTaskIds, tasksById, task.id))
            .filter(r => !chainLiterals.has(r));
        const typos = findTypoRefs(task, allResults, task.id).filter(r => !chainLiterals.has(r));
        // 미캡처 shell/command 출력 참조는 전용 경고(output.not-captured)로
        // 따로 보고 — 일반 unresolved 목록에서 제외해 중복을 막는다(M9).
        const uncaptured = new Map(
            Array.from(findUncapturedOutputRefs(task, tasksById, task.id))
                .filter(([literal]) => !chainLiterals.has(literal))
        );

        /**
         * 이 문자열이 **런타임에서도** 안 풀리는가. `raw` 는 사용자가 쓴 원본,
         * `interpolatedValue` 는 시뮬레이션 보간 결과다.
         *
         * **체인은 보간 결과로 판정할 수 없다.** 시뮬레이션 컨텍스트에는 전방
         * 태스크가 없어서 그 대안이 `undefined` 로 보이고 뒤 대안이 이겨 버린다 —
         * 런타임에서는 그 전방 태스크가 이미 돌아 있어 체인이 거기서 막힌다
         * (`blocks-chain`). 그래서 선언 순서만 바꿔도 답이 갈렸다. 체인 판정은
         * 선언 순서와 무관하므로 **먼저** 본다.
         *
         * 나머지(평범한 참조)는 전방 참조 관용을 그대로 쓴다.
         */
        const isGenuinelyStuck = (raw: string, interpolatedValue: string): boolean => {
            if (chains.some(c => raw.includes(c.literal) && !c.resolves)) { return true; }
            // 체인이 여기까지 왔다면 이미 위에서 걸렸다 — 남는 것은 평범한 참조다.
            return findUnresolved(
                [interpolatedValue],
                makeForwardRefTolerance(forwardTaskIds, tasksById, task.id)
            ).length > 0;
        };

        // 미해결은 **한 findings 로 모은다.** 평범한 참조와 전부 죽은 체인이
        // 같은 태스크에 함께 있으면 같은 코드·같은 범위의 경고가 둘 붙는다.
        const unresolvedEn = Array.from(new Set([...unresolved, ...typos])).filter(r => !uncaptured.has(r));
        const unresolvedKo = [...unresolvedEn];
        for (const chain of chains) {
            const dead = deadAlternatives(chain);
            if (dead.length === 0 || chain.resolves) { continue; }
            // 대안이 전부 어긋났다 — 이때만 리터럴로 남는다. 어느 대안이 왜
            // 어긋났는지까지 말한다. 리터럴만 나열하면 사용자는 체인 전체를
            // 다시 훑어야 하고, 두 문제가 겹쳤을 때 하나가 묻힌다.
            unresolvedEn.push(`${chain.literal} (${dead.map(alt => describeDeadAlternative(alt).en).join('; ')})`);
            unresolvedKo.push(`${chain.literal} (${dead.map(alt => describeDeadAlternative(alt).ko).join('; ')})`);
        }
        if (unresolvedEn.length > 0) {
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'variable.unresolved',
                message: `Task '${item.id}.${task.id}' has unresolved variable(s) under simulated inputs: ${unresolvedEn.join(', ')}. At runtime these pass through as literal '\${…}'.`,
                messageKo: `Task '${item.id}.${task.id}'에 시뮬레이션 입력으로 해석되지 않는 변수 참조가 있습니다: ${unresolvedKo.join(', ')}. 런타임에서는 리터럴 '\${…}'로 전달됩니다.`,
            });
        }
        for (const chain of chains) {
            const dead = deadAlternatives(chain);
            if (dead.length === 0 || !chain.resolves) { continue; }
            // **리터럴로 남지 않는다.** 먼저 풀리는 대안이 있으므로 참조는
            // 동작한다 — 그런데도 알리는 이유는, 죽은 대안이 곧 사용자가
            // 의도한 분기가 영영 선택되지 않는다는 뜻이기 때문이다.
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'variable.dead-alternative',
                message: `Task '${item.id}.${task.id}': ${chain.literal} resolves, but ${dead.length === 1 ? 'one alternative is' : `${dead.length} alternatives are`} never used — ${dead.map(alt => describeDeadAlternative(alt).en).join('; ')}.`,
                messageKo: `Task '${item.id}.${task.id}': ${chain.literal} 는 해석되지만, 선택될 일이 없는 대안이 있습니다 — ${dead.map(alt => describeDeadAlternative(alt).ko).join('; ')}.`,
            });
        }
        // 조건이 **굳어 버린** 분기. `when.var` 가 해석되지 않으면 런타임은
        // 리터럴 문자열 그대로를 비교하므로 결과가 입력과 무관하게 하나로
        // 고정된다 — 태스크가 영영 돌지 않거나(equals/matches/in) 조건이 있는
        // 의미가 없어진다(notEquals). `variable.unresolved` 는 "리터럴로
        // 전달됩니다" 까지만 말하는데, 여기서 중요한 것은 그 **결과**다.
        if (task.when && typeof task.when.var === 'string' && resolvedWhenVar !== undefined) {
            // **보간 결과에 `${…}` 가 남았다는 것만으로는 부족하다.** 전방 태스크
            // 참조는 여기서 아직 리터럴이지만 런타임에서는 멀쩡히 풀린다 —
            // 참조가 곧 의존성이라 스케줄러가 producer 를 먼저 돌린다. 미해결
            // 판정과 **같은 관용 규칙**을 태워야 정상 분기를 죽었다고 하지 않는다.
            const frozen = detectFrozenCondition(
                task.when, resolvedWhenVar, isGenuinelyStuck(task.when.var, resolvedWhenVar)
            );
            // 컴파일되지 않는 정규식은 `when.regex`(error)가 이미 같은 사실을
            // 말한다 — 같은 줄에 같은 이야기를 둘 붙이지 않는다.
            if (frozen && frozen.cause !== 'invalid-regex') {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'warning',
                    code: 'when.dead-branch',
                    message: `Task '${item.id}.${task.id}' has a 'when' whose outcome never changes: ${frozen.en}. This task ${frozen.runs ? 'always runs, making the condition meaningless' : 'never runs'}.`,
                    messageKo: `Task '${item.id}.${task.id}'의 'when' 결과가 입력과 무관하게 고정됩니다: ${frozen.ko}. 이 태스크는 ${frozen.runs ? '항상 실행되어 조건이 의미가 없습니다' : '영영 실행되지 않습니다'}.`,
                });
            }
        }
        // `when` 의 **피연산자**는 보간되지 않는다 (`evaluateTaskCondition` 은
        // `equals`/`notEquals`/`matches`/`in` 을 적힌 그대로 비교한다). 참조를
        // 적으면 그 글자와 비교하게 되어 역시 결과가 굳는다.
        const literalOperands: string[] = [];
        if (task.when) {
            const operandStrings: string[] = [];
            for (const key of ['equals', 'notEquals', 'matches'] as const) {
                const v = task.when[key];
                if (typeof v === 'string') { operandStrings.push(v); }
            }
            if (Array.isArray(task.when.in)) {
                for (const v of task.when.in) {
                    if (typeof v === 'string') { operandStrings.push(v); }
                }
            }
            for (const v of operandStrings) {
                if (UNRESOLVED_VAR_RE.test(v)) { literalOperands.push(v); }
                UNRESOLVED_VAR_RE.lastIndex = 0;
            }
        }
        if (literalOperands.length > 0) {
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'when.literal-operand',
                message: `Task '${item.id}.${task.id}' puts a '\${…}' reference in a 'when' operand (${literalOperands.join(', ')}). Only 'when.var' is interpolated — the operand is compared verbatim, so the comparison is against the literal text and never matches a real value. The reference is not a dependency either (0.7.16) — it does not order this task after the one it names, so the comparison simply never matches.`,
                messageKo: `Task '${item.id}.${task.id}'의 'when' 피연산자에 '\${…}' 참조가 있습니다(${literalOperands.join(', ')}). 보간되는 것은 'when.var'뿐이며 피연산자는 적힌 그대로 비교되므로, 실제 값과는 결코 일치하지 않습니다. 이 참조는 의존성으로도 잡히지 않으므로(0.7.16) 실행 순서도 바뀌지 않습니다 — 비교가 그냥 영영 일치하지 않을 뿐입니다.`,
            });
        }
        if (joinedArgRefs.length > 0) {
            const refs = Array.from(new Set(joinedArgRefs)).join(', ');
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'args.array-joined',
                message: `Task '${item.id}.${task.id}' mixes an array reference (${refs}) with other text inside an 'args' element. Only an element that is exactly '\${…}' expands into one argument per item; here the array is joined with spaces into a single argument, so the boundaries between the items are lost and the program receives one value.`,
                messageKo: `Task '${item.id}.${task.id}'의 'args' 원소 안에서 배열 참조(${refs})가 다른 글자와 섞여 있습니다. 원소 전체가 '\${…}' 하나일 때만 항목 수만큼의 인자로 펼쳐집니다. 지금은 공백으로 이어 붙어 **인자 한 칸**이 되어, 항목 사이의 경계가 사라지고 프로그램이 값 하나로 받습니다.`,
            });
        }
        if (uncaptured.size > 0) {
            const refs = Array.from(uncaptured.keys()).join(', ');
            const heads = Array.from(new Set(uncaptured.values())).map(h => `'${h}'`).join(', ');
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'output.not-captured',
                message: `Task '${item.id}.${task.id}' references ${refs}, but task ${heads} does not set 'passTheResultToNextTask': true — its output is streamed, not captured, so the reference passes through as a literal '\${…}'.`,
                messageKo: `Task '${item.id}.${task.id}'가 ${refs}를 참조하지만, ${heads} 태스크에 'passTheResultToNextTask': true가 없어 출력이 캡처되지 않습니다. 참조는 리터럴 '\${…}'로 전달됩니다.`,
            });
        }

        // shell/command에서 passTheResultToNextTask 없이 정의된 output
        // mode/capture/diagnostics는 런타임이 조용히 무시한다(M9).
        if ((task.type === 'shell' || task.type === 'command') && !task.passTheResultToNextTask && task.output) {
            const dead: string[] = [];
            if (task.output.mode) { dead.push(`mode: '${task.output.mode}'`); }
            if (task.output.capture) { dead.push('capture'); }
            if (task.output.diagnostics) { dead.push('diagnostics'); }
            if (dead.length > 0) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'warning',
                    code: 'output.ignored',
                    message: `Task '${item.id}.${task.id}' defines output ${dead.join(', ')} but does not set 'passTheResultToNextTask': true — for 'shell'/'command' tasks the runtime silently ignores them.`,
                    messageKo: `Task '${item.id}.${task.id}'에 output ${dead.join(', ')}가 정의되어 있지만 'passTheResultToNextTask': true가 없습니다 — 'shell'/'command' 태스크에서 런타임이 조용히 무시합니다.`,
                });
            }
        }

        // `shell` 은 명령 문자열을 셸에 그대로 넘긴다(0.6.47). 그래서 그 안에
        // 보간된 값도 **셸 문법으로 해석된다** — `${ask.value}` 가
        // `x; rm -rf ~` 이면 뒤의 명령까지 실행된다. `command` 타입이나
        // `args` 배열은 토큰마다 인용하므로 같은 값이 인자 하나로 남는다.
        //
        // Workspace Trust 는 **액션 정의**의 신뢰이지 실행 중 흘러 들어오는
        // **값**의 신뢰가 아니므로, 신뢰된 워크스페이스에서도 유효한 경고다.
        if (task.type === 'shell') {
            const branches: string[] = typeof task.command === 'string'
                ? [task.command]
                : (task.command && typeof task.command === 'object'
                    ? Object.values(task.command).filter((v): v is string => typeof v === 'string')
                    : []);
            const interpolatedBranch = branches.find(branch => /\$\{[^}]+\}/.test(branch));
            if (interpolatedBranch) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'warning',
                    code: 'shell.interpolated-command',
                    message: `Task '${item.id}.${task.id}' is a 'shell' task that interpolates \${...} into the command string. 'shell' passes the string to a shell verbatim, so a value containing ';', '&&' or '$(...)' runs as a command. Pass such values through the 'args' array, or use type 'command' (argv, each token quoted).`,
                    messageKo: `Task '${item.id}.${task.id}'는 명령 문자열에 \${...}를 보간하는 'shell' 태스크입니다. 'shell'은 문자열을 셸에 그대로 넘기므로, 값에 ';'나 '&&', '$(...)'가 있으면 명령으로 실행됩니다. 그런 값은 'args' 배열로 넘기거나 'command' 타입(토큰마다 인용하는 argv)을 사용하세요.`,
                });
            }
        }

        // `command` 는 argv 로 실행하므로 셸이 없다 — 그런데 명령 **자체가**
        // 인터프리터면(`cmd /c`, `sh -c`, `powershell -Command`) 그 인터프리터가
        // 넘겨받은 문자열을 다시 파싱한다. 그래서 `command` 로 바꾸는 것만으로는
        // 닫히지 않는 경로가 남는다.
        //
        // **`args` 까지 합친 실효 argv 로 판정한다.** 처음 구현은 `task.command`
        // 문자열만 정규식으로 봤는데, 가장 흔한 형태가 바로
        // `command: "sh", args: ["-c", "... ${x} ..."]` 였다 — 그 형태를 통째로
        // 놓쳤다. 인용된 실행 파일(`"pwsh.exe"`)이나 스위치 앞에 낀 플래그
        // (`cmd /v:on /c`, `bash --noprofile -c`)도 문자열 정규식으로는 끝이 없다.
        if (task.type === 'command') {
            const commandBranches: string[] = typeof task.command === 'string'
                ? [task.command]
                : (task.command && typeof task.command === 'object'
                    ? Object.values(task.command).filter((v): v is string => typeof v === 'string')
                    : []);
            const extraArgs: string[] = Array.isArray(task.args)
                ? task.args.filter((a): a is string => typeof a === 'string')
                : [];
            // **모든 branch 를 본다** — 앞의 안전한 branch 가 뒤를 가리면 안 된다.
            // 각 branch 는 다시 **가능한 실제 argv 로 펼쳐** 본다: 실행 파일이나
            // 스위치가 참조로 적혀 있으면 템플릿 그대로는 어떤 인터프리터와도
            // 맞지 않아 검사를 통째로 비껴갔다.
            let dynamicInterpreter = false;
            // `some` 은 첫 참에서 멈춘다 — 뒤 branch 의 `dynamicInterpreter` 를
            // 보지 못해 플래그가 선언 순서에 따라 달라졌다. 전부 평가한 뒤 합친다.
            const vulnerable = commandBranches.map(branch => {
                const argv = [...tokenizeCommandLine(branch), ...extraArgs];
                const { variants, truncated } = enumerateArgvCandidates(argv, tasks);
                // **하나라도** 미지수면 경고한다. `every` 로 보면 후보에 안전한
                // 것이 섞여 있다는 이유로 위험한 변형이 묻힌다(`['node','sh']`).
                // 상한에 걸려 못 본 후보가 있어도 마찬가지다 — 잘린 쪽에 셸이
                // 있었을 수 있으므로 조용해지지 않는다.
                if (truncated || variants.some(variant => interpreterPositionIsDynamic(variant))) {
                    dynamicInterpreter = true;
                }
                return variants.some(variant => {
                    // 스크립트에 **놓일 수 있는** 참조를 전부 본다. 위치를 확정하지
                    // 못한 경우(동적 스위치·모르는 옵션)는 뒤따르는 참조가 모두
                    // 후보이므로, 그중 하나라도 제약이 없으면 경고한다.
                    const { candidates } = scriptCandidates(variant);
                    return candidates.some(candidate => !nestedInterpreterRefsAreConstrained(candidate, tasksById));
                });
            }).some(Boolean);
            if (dynamicInterpreter && !vulnerable) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'warning',
                    code: 'command.dynamic-interpreter',
                    message: `Task '${item.id}.${task.id}' decides its executable (or its script switch) from an interpolated \${...} value, so what actually runs cannot be determined here. If it resolves to a shell (\`sh -c\`, \`cmd /c\`, \`powershell -Command\`, …), other interpolated values in the same argv become script text and are re-parsed as syntax. Use a fixed executable, or pass values through 'env' so they never appear in the script text.`,
                    messageKo: `Task '${item.id}.${task.id}'는 실행 파일(또는 스크립트 스위치)을 보간값 \${...} 으로 정하므로, 무엇이 실행될지 여기서는 알 수 없습니다. 그것이 셸(\`sh -c\`, \`cmd /c\`, \`powershell -Command\` 등)로 풀리면 같은 argv 의 다른 보간값이 스크립트 텍스트가 되어 문법으로 다시 읽힙니다. 실행 파일을 고정하거나, 값을 'env' 로 넘겨 스크립트 문자열에 넣지 마세요.`,
                });
            }
            if (vulnerable) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'warning',
                    code: 'command.nested-interpreter',
                    message: `Task '${item.id}.${task.id}' is a 'command' task whose effective argv invokes another interpreter (\`cmd /c\`, \`sh -c\`, \`powershell -Command\`, …) with an interpolated \${...} value in the script it runs. argv quoting stops at that interpreter — it re-parses the script, so the value can still be read as syntax. Pass the value through the child's own argv, or hand it over via 'env' so it never appears in the script text.`,
                    messageKo: `Task '${item.id}.${task.id}'의 실효 argv 가 다른 인터프리터(\`cmd /c\`, \`sh -c\`, \`powershell -Command\` 등)를 호출하면서, 그 인터프리터가 실행할 스크립트에 \${...} 를 보간합니다. argv 인용은 그 인터프리터 앞에서 끝나고 인터프리터가 스크립트를 다시 파싱하므로 값이 문법으로 읽힐 수 있습니다. 값을 자식의 argv 로 직접 넘기거나, 'env' 로 전달해 스크립트 문자열에 아예 넣지 마세요.`,
                });
            }
        }

        // Outside-workspace write checks. Skip when the resolved string
        // still has unresolved variables — we can't decide safely.
        const candidates: Array<{ raw: string | undefined; kind: string }> = [
            { raw: (task.type === 'writeFile' || task.type === 'appendFile') ? resolvedWritePath : undefined, kind: `${task.type}.path` },
            { raw: task.output?.mode === 'file' ? resolvedOutputPath : undefined, kind: 'output.filePath' },
        ];
        for (const { raw, kind } of candidates) {
            if (!raw || UNRESOLVED_VAR_RE.test(raw)) {
                UNRESOLVED_VAR_RE.lastIndex = 0;
                continue;
            }
            UNRESOLVED_VAR_RE.lastIndex = 0;
            if (input.workspaceRoots.length === 0) {
                continue;
            }
            const resolved = path.isAbsolute(raw)
                ? path.resolve(raw)
                : path.resolve(baseDir || input.workspaceRoots[0], raw);
            if (!isInsideWorkspace(resolved, input.workspaceRoots)) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'error',
                    code: 'path.outside-workspace',
                    message: `Task '${item.id}.${task.id}' ${kind} resolves to '${resolved}', outside the workspace. The runtime will refuse to write here.`,
                    messageKo: `Task '${item.id}.${task.id}'의 ${kind}가 워크스페이스 밖 '${resolved}'로 해석됩니다. 런타임은 이 위치 쓰기를 거부합니다.`,
                });
            }
        }

        // Seed downstream context. capture 적용 조건(런타임은 문자열 `output` 이
        // 있을 때만 capture 를 돌린다)은 `simulateTaskResultWithCaptures` 한
        // 곳에만 두어 Preview / 전방 참조 판정과 같은 모델을 쓰게 한다.
        allResults[task.id] = simulateTaskResultWithCaptures(task);
        if (!BUILTIN_CONTEXT_KEYS.has(task.id)) {
            sharedInterpolationContext[task.id] = allResults[task.id];
        }
        forwardTaskIds.delete(task.id);
    }
}

function checkDependsOn(actions: ActionItem[], input: DoctorInput): DoctorFinding[] {
    const findings: DoctorFinding[] = [];

    const walk = (items: ActionItem[]) => {
        for (const item of items) {
            if (item?.action?.tasks && Array.isArray(item.action.tasks)) {
                analyzeDependsOn(item, item.action.tasks, input, findings);
            }
            if (Array.isArray(item?.children) && item.children.length > 0) {
                walk(item.children);
            }
        }
    };
    walk(actions);
    return findings;
}

function analyzeDependsOn(
    item: ActionItem,
    tasks: Task[],
    input: DoctorInput,
    findings: DoctorFinding[]
): void {
    // self / missing are reported against the *literal* dependsOn field
    // (a user-authored mistake at that spot). Cycle detection delegates
    // to the runtime's graph builder so that cycles created through
    // auto-inferred `${taskId.x}` deps are caught at lint time too — the
    // runtime and Doctor share one cycle definition (single source).
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') {
            validIds.add(t.id);
        }
    }

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !Array.isArray(task.dependsOn)) {
            continue;
        }
        for (const dep of task.dependsOn) {
            if (typeof dep !== 'string') { continue; }
            if (dep === task.id) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'error',
                    code: 'dependsOn.self',
                    message: `Task '${item.id}.${task.id}' depends on itself.`,
                    messageKo: `Task '${item.id}.${task.id}'가 자기 자신에 의존합니다.`,
                });
                continue;
            }
            if (!validIds.has(dep)) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'error',
                    code: 'dependsOn.missing',
                    message: `Task '${item.id}.${task.id}' depends on unknown task id '${dep}'.`,
                    messageKo: `Task '${item.id}.${task.id}'가 존재하지 않는 task id '${dep}'에 의존합니다.`,
                });
            }
        }
    }

    const graph = buildTaskGraph(tasks);
    const cycle = detectGraphCycle(graph);
    if (cycle) {
        const path = formatCyclePath(cycle);
        findings.push({
            filePath: input.filePath,
            sourceLabel: input.sourceLabel,
            range: findIdLine(input.rawText, cycle[0]),
            severity: 'error',
            code: 'dependsOn.cycle',
            message: `Task dependency cycle in action '${item.id}' (includes auto-inferred deps from \${id.x} references): ${path}.`,
            messageKo: `Action '${item.id}'에 task 의존성 순환이 있습니다(\${id.x} 참조에서 자동 추론된 의존성 포함): ${path}.`,
        });
    }
}

/**
 * Flags interactive task types (`inputBox`, `quickPick`, etc.) marked
 * `parallel: true`. The runtime still executes them but serializes
 * their prompts via a UI mutex — opting them into the parallel pool
 * doesn't actually buy concurrency for the dialog itself, only for
 * the post-prompt processing. Warning, not error, because the
 * configuration runs correctly; this is best-practice guidance.
 */
function checkParallelInteractive(actions: ActionItem[], input: DoctorInput): DoctorFinding[] {
    const findings: DoctorFinding[] = [];
    forEachTask(actions, (item, task) => {
        if (task.parallel !== true) { return; }
        if (!INTERACTIVE_TASK_TYPES.has(task.type)) { return; }
        findings.push({
            filePath: input.filePath,
            sourceLabel: input.sourceLabel,
            range: findIdLine(input.rawText, task.id),
            severity: 'warning',
            code: 'parallel.interactive',
            message: `Task '${item.id}.${task.id}' is '${task.type}' with 'parallel: true', but interactive prompts are serialized at runtime via a UI mutex — concurrent execution does not apply to the dialog itself. Remove 'parallel: true' or move the interactive prompt out of the parallel pool.`,
            messageKo: `Task '${item.id}.${task.id}'는 '${task.type}' 타입인데 'parallel: true'가 설정되어 있습니다. 런타임은 UI mutex로 interactive prompt를 직렬화하므로 대화상자 자체에는 병렬 실행이 적용되지 않습니다. 'parallel: true'를 제거하거나 interactive prompt를 병렬 구간 밖으로 옮기세요.`,
        });
    });
    return findings;
}

function forEachTask(
    actions: ActionItem[],
    visitor: (item: ActionItem, task: Task) => void
): void {
    const walk = (items: ActionItem[]) => {
        for (const item of items) {
            if (item?.action?.tasks && Array.isArray(item.action.tasks)) {
                for (const task of item.action.tasks) {
                    if (task && typeof task.id === 'string') {
                        visitor(item, task);
                    }
                }
            }
            if (Array.isArray(item?.children) && item.children.length > 0) {
                walk(item.children);
            }
        }
    };
    walk(actions);
}
