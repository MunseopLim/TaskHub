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
    getCommandString,
} from './pipelineUtils';

export interface PreviewOptions {
    workspaceFolder: string;
    extensionPath: string;
    /** Workspace root list used to detect file writes outside the workspace. */
    workspaceRoots: string[];
}

interface SimulatedResult {
    [key: string]: string;
}

/**
 * Placeholder value for a key in a simulated task result. Kept in a distinct
 * shape (`<type:taskId:key>`) so a human reader can spot them in the report.
 */
function placeholder(type: string, id: string, key?: string): string {
    return key ? `<${type}:${id}:${key}>` : `<${type}:${id}>`;
}

/**
 * Build a best-effort simulated result for a single task, used only to feed
 * downstream tasks' interpolation context during preview.
 */
function simulateTaskResult(task: Task): SimulatedResult {
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
            return { output: placeholder(task.type, task.id, 'stdout') };
        default:
            return {};
    }
}

/** Regex to find ${...} references that survived interpolation. */
const UNRESOLVED_VAR_RE = /\$\{[^}]+\}/g;

function findUnresolved(values: (string | undefined)[]): string[] {
    const seen = new Set<string>();
    for (const v of values) {
        if (typeof v !== 'string') { continue; }
        const matches = v.match(UNRESOLVED_VAR_RE);
        if (matches) {
            for (const m of matches) { seen.add(m); }
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

function isInsideWorkspace(resolved: string, workspaceRoots: string[]): boolean {
    const normalized = path.resolve(resolved);
    return workspaceRoots.some(root => {
        const rel = path.relative(path.resolve(root), normalized);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

function resolveFilePathForPreview(
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

    for (let i = 0; i < action.tasks.length; i++) {
        const task = action.tasks[i];
        const interpolationContext: any = {
            ...allResults,
            workspaceFolder: options.workspaceFolder,
            extensionPath: options.extensionPath,
        };

        lines.push('───────────────────────────────────────────────────────────────────');
        lines.push(`[${i + 1}/${action.tasks.length}] ${task.id}  (type: ${task.type})`);
        lines.push('───────────────────────────────────────────────────────────────────');

        const interpolated: (string | undefined)[] = [];

        switch (task.type) {
            case 'shell':
            case 'command': {
                let command: string | undefined;
                if (typeof task.command === 'string') {
                    command = interpolatePipelineVariables(task.command, interpolationContext);
                } else if (task.command && typeof task.command === 'object') {
                    const cloned: any = JSON.parse(JSON.stringify(task.command));
                    for (const os of Object.keys(cloned)) {
                        cloned[os] = interpolatePipelineVariables(cloned[os], interpolationContext);
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
                const items = Array.isArray(task.items) ? task.items : [];
                const placeHolder = task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined;
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
                if (placeHolder) { lines.push(`  placeHolder: ${placeHolder}`); }
                if (task.canPickMany) { lines.push(`  canPickMany: true`); }
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
                lines.push(`  tool: ${typeof tool === 'string' ? tool : JSON.stringify(tool)}`);
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
            default:
                lines.push(`  (unknown task type — no preview)`);
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

        const unresolved = findUnresolved(interpolated);
        if (unresolved.length > 0) {
            lines.push(`  unresolved variables: ${unresolved.join(', ')}`);
            for (const u of unresolved) { totalUnresolved.add(u); }
        }

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

        lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════════════');
    if (totalUnresolved.size > 0) {
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
