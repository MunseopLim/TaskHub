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
 * 인터프리터별 "이 뒤가 스크립트" 스위치.
 *
 * `cmd` 는 `/c` 뒤 **나머지 전체**를 명령줄로 읽고, `sh`/`bash` 계열은 `-c`
 * 바로 다음 인자를, PowerShell 은 `-Command` 뒤를 읽는다. 어느 쪽이든 뒤를
 * 통째로 이어 붙여 보면 놓치는 형태가 없다.
 *
 * `-lc` · `-ec` 처럼 묶어 쓰는 형태, `--noprofile` · `/v:on` 처럼 스위치 앞에
 * 끼는 플래그를 **위치로** 처리하므로, 문자열 정규식으로 형태를 하나씩
 * 쫓아다닐 필요가 없다.
 */
const NESTED_INTERPRETERS: { executable: RegExp; scriptSwitch: RegExp }[] = [
    { executable: /^cmd(\.exe)?$/i, scriptSwitch: /^\/c$/i },
    { executable: /^(sh|bash|zsh|dash|ksh|ash)$/i, scriptSwitch: /^-[a-z]*c$/i },
    { executable: /^(powershell|pwsh)(\.exe)?$/i, scriptSwitch: /^-(c|command|encodedcommand)$/i },
];

/**
 * 실효 argv 가 중첩 인터프리터를 호출한다면, 그 인터프리터가 실행할 스크립트
 * 텍스트를 돌려준다. 아니면 `undefined`.
 */
export function nestedInterpreterScript(argv: string[]): string | undefined {
    if (argv.length === 0) { return undefined; }
    const base = (argv[0].split(/[\\/]/).pop() ?? argv[0]).trim();
    const interpreter = NESTED_INTERPRETERS.find(entry => entry.executable.test(base));
    if (!interpreter) { return undefined; }
    const switchIndex = argv.findIndex((token, i) => i > 0 && interpreter.scriptSwitch.test(token));
    if (switchIndex === -1) { return undefined; }
    const script = argv.slice(switchIndex + 1).join(' ');
    return script.length > 0 ? script : undefined;
}

/** 셸·cmd 에서 문법적 의미를 갖는 문자를 담고 있는가. */
function containsShellMetacharacter(value: string): boolean {
    return /[;&|`$()<>*?!^%\n\r"'\\]/.test(value) || /\s/.test(value);
}

/**
 * 중첩 인터프리터 스크립트가 참조하는 값들이 **모양이 제약된 소스**에서만 오는가.
 *
 * 면제는 **런타임이 실제로 보장하는 것만** 인정해야 한다. 처음 구현은
 * `envPick` 을 무조건 면제했는데, 환경변수 **이름**이 안전해도 `cmd` 는
 * `%VAR%` 를 치환한 **뒤** 그 결과를 다시 해석하므로 값에 `&` 가 있으면
 * 그대로 뚫린다 — 우리 CHANGELOG 가 같은 이유로 번들 액션을 고쳐 놓고
 * Doctor 는 반대로 판정하고 있었다.
 */
function nestedInterpreterRefsAreConstrained(script: string, tasks: Task[]): boolean {
    const refs = [...script.matchAll(/\$\{([^}.]+)(?:\.[^}]*)?\}/g)].map(m => m[1]);
    if (refs.length === 0) { return true; }
    // **태스크를 가리키지 않는 참조도 안전하지 않다.** `${workspaceFolder}` 는
    // 사용자 폴더 이름이고 거기에 `;` 나 `&` 가 들어갈 수 있다.
    return refs.every(ref => {
        const source = tasks.find(t => t.id === ref) as any;
        if (!source) { return false; }
        // 검증 **이후에** 붙는 prefix/suffix 는 패턴이 보장하지 못한다.
        if (containsShellMetacharacter(String(source.prefix ?? '')) ||
            containsShellMetacharacter(String(source.suffix ?? ''))) {
            return false;
        }
        if (source.type === 'inputBox') { return patternMeaningfullyConstrains(source.validatePattern); }
        if (source.type === 'quickPick') {
            // 항목 자체에 메타문자가 있으면 고정 목록이라도 안전하지 않다.
            if (!Array.isArray(source.items) || source.itemsFromCommand) { return false; }
            return source.items.every((entry: any) => {
                const label = typeof entry === 'string' ? entry : entry?.label;
                return typeof label === 'string' && !containsShellMetacharacter(label);
            });
        }
        // `envPick` 은 면제하지 않는다 — 위 주석 참조.
        return false;
    });
}

/**
 * `validatePattern` 이 값의 모양을 **실제로** 좁히는가.
 *
 * `".*"` 처럼 무엇이든 통과시키는 패턴이나 컴파일되지 않는 패턴(`"["` — 런타임이
 * 검증을 건너뛴다)을 제약으로 인정하면, 면제가 곧 우회로가 된다. 셸·cmd 에서
 * 의미를 갖는 문자를 **하나라도** 통과시키면 제약으로 보지 않는다.
 */
function patternMeaningfullyConstrains(pattern: unknown): boolean {
    if (typeof pattern !== 'string' || pattern.length === 0) { return false; }
    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch {
        return false;   // 런타임도 잘못된 패턴은 무시한다 → 제약이 없는 것과 같다
    }
    // 앵커가 없으면 부분 일치라 앞뒤에 무엇이든 붙일 수 있다.
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) { return false; }
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

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string') {
            continue;
        }
        // null-prototype — 런타임과 같은 규칙. 평범한 객체면 `${constructor.name}`
        // 같은 상속 키가 결과처럼 해석되어 진단이 런타임과 어긋난다.
        const interpolationContext: any = Object.assign(Object.create(null), allResults, {
            workspaceFolder: baseDir,
            extensionPath: input.extensionPath,
        });

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

        const forwardTaskIds = new Set<string>();
        for (const id of knownTaskIds) {
            if (!Object.prototype.hasOwnProperty.call(allResults, id)) {
                forwardTaskIds.add(id);
            }
        }
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
            const vulnerable = commandBranches.some(branch => {
                const script = nestedInterpreterScript([...tokenizeCommandLine(branch), ...extraArgs]);
                return script !== undefined
                    && /\$\{[^}]+\}/.test(script)
                    && !nestedInterpreterRefsAreConstrained(script, tasks);
            });
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
        findings.push({
            filePath: input.filePath,
            sourceLabel: input.sourceLabel,
            range: findIdLine(input.rawText, cycle[0]),
            severity: 'error',
            code: 'dependsOn.cycle',
            message: `Task dependency cycle in action '${item.id}' (includes auto-inferred deps from \${id.x} references): ${cycle.join(' -> ')}.`,
            messageKo: `Action '${item.id}'에 task 의존성 순환이 있습니다(\${id.x} 참조에서 자동 추론된 의존성 포함): ${cycle.join(' -> ')}.`,
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
