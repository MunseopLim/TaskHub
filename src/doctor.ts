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
import { interpolatePipelineVariables } from './pipelineUtils';
import {
    simulateTaskResult,
    findUnresolved,
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

/**
 * Mirror of the `RESERVED_CAPTURE_NAMES` set in `pipelineUtils.ts`. Capture
 * rules whose `name` matches one of these would shadow a built-in task
 * result key (`output`, `path`, …), and `applyOutputCapture` throws at
 * runtime. Keep the two lists in sync if either grows. Duplicated here on
 * purpose so doctor.ts does not depend on a non-exported symbol from
 * pipelineUtils.ts.
 */
const RESERVED_CAPTURE_NAMES: ReadonlySet<string> = new Set([
    'output', 'outputDir', 'path', 'dir', 'name', 'fileNameOnly', 'fileExt',
    'value', 'values', 'archivePath', 'confirmed'
]);

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
function findIdLine(text: string, id: string): DoctorFinding['range'] {
    const escaped = id.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const re = new RegExp(`"id"\\s*:\\s*"${escaped}"`);
    const m = re.exec(text);
    if (!m) {
        return { ...DEFAULT_RANGE };
    }
    return offsetToRange(text, m.index);
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
                        range: findIdLine(input.rawText, item.id),
                        severity: 'error',
                        code: 'duplicate.action.id',
                        message: `Duplicate action id '${item.id}' — every action in a single source must have a unique id.`,
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
                            range: findIdLine(input.rawText, task.id),
                            severity: 'error',
                            code: 'duplicate.task.id',
                            message: `Action '${item.id ?? '(unknown)'}' has duplicate task id '${task.id}'.`,
                        });
                    }
                    taskIds.set(task.id, count + 1);
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

                // `RESERVED_CAPTURE_NAMES` in pipelineUtils.ts. Doctor keeps
                // its own copy so this module stays free of pipelineUtils
                // private symbols; keep the two lists in sync if either
                // grows.
                if (typeof rule.name === 'string') {
                    if (RESERVED_CAPTURE_NAMES.has(rule.name)) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'error',
                            code: 'capture.reserved',
                            message: `Capture name '${rule.name}' in task '${item.id}.${task.id}' is reserved (it would shadow the built-in task result key). Pick a different name.`,
                        });
                    } else if (seenNames.has(rule.name)) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'error',
                            code: 'capture.duplicate',
                            message: `Duplicate capture name '${rule.name}' in task '${item.id}.${task.id}'. Each capture in one task must have a unique name.`,
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
                    re = new RegExp(rule.regex, rule.flags ?? '');
                } catch (e: any) {
                    findings.push({
                        filePath: input.filePath,
                        sourceLabel: input.sourceLabel,
                        range: findIdLine(input.rawText, task.id),
                        severity: 'error',
                        code: 'capture.regex',
                        message: `Task '${item.id}.${task.id}' capture '${rule.name}' has invalid regex: ${e.message ?? e}`,
                    });
                    continue;
                }

                // Detect when an explicit numeric `group` is out of range
                // for the compiled regex. Cheap probe: an always-empty
                // match exposes the capture count via `m.length - 1`.
                if (typeof rule.group === 'number') {
                    const probe = new RegExp(`(?:${rule.regex})|(?=)`, rule.flags ?? '').exec('');
                    const groupCount = probe ? probe.length - 1 : 0;
                    if (rule.group < 0 || rule.group > groupCount) {
                        findings.push({
                            filePath: input.filePath,
                            sourceLabel: input.sourceLabel,
                            range: findIdLine(input.rawText, task.id),
                            severity: 'warning',
                            code: 'capture.group',
                            message: `Capture '${rule.name}' in task '${item.id}.${task.id}' refers to group ${rule.group}, but the regex defines ${groupCount} capture group(s).`,
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

function analyzeActionTasks(
    item: ActionItem,
    tasks: Task[],
    input: DoctorInput,
    findings: DoctorFinding[]
): void {
    const allResults: Record<string, any> = {};
    // Match the runtime's fallback chain (`executeSingleTask` in
    // extension.ts): explicit per-action workspaceFolder → first workspace
    // root → empty. The bundled `media/actions.json` and any global preset
    // carry no workspaceFolder of their own, so without this fallback Doctor
    // would expand `${workspaceFolder}/out.txt` to `/out.txt` and then flag
    // it as path.outside-workspace — a false positive the runtime never
    // produces.
    const baseDir = input.workspaceFolder ?? input.workspaceRoots[0] ?? '';

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string') {
            continue;
        }
        const interpolationContext: any = {
            ...allResults,
            workspaceFolder: baseDir,
            extensionPath: input.extensionPath,
        };

        const interpolated: (string | undefined)[] = [];
        const visitString = (value: unknown): string | undefined => {
            if (typeof value !== 'string') {
                return undefined;
            }
            const out = interpolatePipelineVariables(value, interpolationContext);
            interpolated.push(out);
            return out;
        };

        // shell/command
        if (typeof task.command === 'string') {
            visitString(task.command);
        } else if (task.command && typeof task.command === 'object') {
            for (const v of Object.values(task.command)) {
                visitString(v);
            }
        }
        if (Array.isArray(task.args)) {
            for (const a of task.args) { visitString(a); }
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
        if (Array.isArray(task.source)) {
            for (const s of task.source) { visitString(s); }
        } else if (typeof task.source === 'string') {
            visitString(task.source);
        }
        if (Array.isArray(task.items)) {
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

        const unresolved = findUnresolved(interpolated);
        if (unresolved.length > 0) {
            findings.push({
                filePath: input.filePath,
                sourceLabel: input.sourceLabel,
                range: findIdLine(input.rawText, task.id),
                severity: 'warning',
                code: 'variable.unresolved',
                message: `Task '${item.id}.${task.id}' has unresolved variable(s) under simulated inputs: ${unresolved.join(', ')}. At runtime these pass through as literal '\${…}'.`,
            });
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
                });
            }
        }

        // Seed downstream context.
        const sim = simulateTaskResult(task);
        if (task.output?.capture) {
            const rules = Array.isArray(task.output.capture) ? task.output.capture : [task.output.capture];
            for (const r of rules) {
                if (r && typeof r.name === 'string') {
                    sim[r.name] = placeholder('capture', task.id, r.name);
                }
            }
        }
        allResults[task.id] = sim;
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
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') {
            validIds.add(t.id);
        }
    }

    const graph = new Map<string, string[]>();
    for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !Array.isArray(task.dependsOn)) {
            continue;
        }
        const deps: string[] = [];
        for (const dep of task.dependsOn) {
            if (typeof dep !== 'string') {
                continue;
            }
            if (dep === task.id) {
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, task.id),
                    severity: 'error',
                    code: 'dependsOn.self',
                    message: `Task '${item.id}.${task.id}' depends on itself.`,
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
                });
                continue;
            }
            deps.push(dep);
        }
        graph.set(task.id, deps);
    }

    // Cycle detection via DFS with three-color marks.
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const reportedCycle = new Set<string>();
    for (const id of graph.keys()) {
        color.set(id, WHITE);
    }
    const stack: string[] = [];

    const visit = (id: string): void => {
        const state = color.get(id) ?? WHITE;
        if (state === BLACK) {
            return;
        }
        if (state === GRAY) {
            const idx = stack.indexOf(id);
            const cycle = idx >= 0 ? [...stack.slice(idx), id] : [id, id];
            const key = [...cycle].sort().join('->');
            if (!reportedCycle.has(key)) {
                reportedCycle.add(key);
                findings.push({
                    filePath: input.filePath,
                    sourceLabel: input.sourceLabel,
                    range: findIdLine(input.rawText, id),
                    severity: 'error',
                    code: 'dependsOn.cycle',
                    message: `Task dependency cycle in action '${item.id}': ${cycle.join(' -> ')}.`,
                });
            }
            return;
        }
        color.set(id, GRAY);
        stack.push(id);
        for (const next of graph.get(id) ?? []) {
            visit(next);
        }
        stack.pop();
        color.set(id, BLACK);
    };
    for (const id of graph.keys()) {
        if ((color.get(id) ?? WHITE) === WHITE) {
            visit(id);
        }
    }
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
