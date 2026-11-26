/**
 * Converts a saved input profile into the inputs file of `taskhub run --inputs-file`.
 *
 * A profile stores each interactive task's *result* (as History does), while the CLI takes the value
 * a person would have entered or picked. This module maps one onto the other. It must not import `vscode`.
 */
import * as path from 'path';
import { inspectInputProfile, type NamedInputProfile } from './inputProfiles';
import type { Task } from './schema';

export type CliInputValue = string | string[] | boolean;

export interface ProfileCliInputs {
    /** Task id → CLI input value, ready to serialize as the inputs file. Null-prototype. */
    inputs: Record<string, CliInputValue>;
    /** Saved values that cannot be expressed as CLI input. The CLI asks for them as missing inputs. */
    skippedTaskIds: string[];
    /** Profile entries the current action no longer has in the same id and type. */
    staleTaskIds: string[];
    /** Interactive tasks added after the profile was saved, so it has no value for them. */
    promptTaskIds: string[];
    /** Password inputs. Profiles never store them, so they are always passed separately. */
    passwordTaskIds: string[];
}

function stringList(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string') ? value : undefined;
}

/** A path inside the workspace is written relative to it, so the file works from another checkout too. */
function portablePath(value: string, workspaceRoot: string | undefined): string {
    if (!workspaceRoot || !path.isAbsolute(value)) { return value; }
    const relative = path.relative(workspaceRoot, value);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) { return value; }
    return relative.split(path.sep).join('/');
}

function quickPickInput(task: Task, saved: Record<string, unknown>): CliInputValue | undefined {
    const labels = stringList(saved.labelList)
        ?? (typeof saved.label === 'string' ? [saved.label] : typeof saved.value === 'string' ? [saved.value] : undefined);
    if (!labels) { return undefined; }
    const itemIds = Array.isArray(saved._itemIds) ? saved._itemIds
        : typeof saved._itemId === 'string' ? [saved._itemId] : [];
    // The CLI matches a stable item id before a label, as the extension replays saved picks.
    const keys = labels.map((label, index) => {
        const itemId = itemIds[index];
        return typeof itemId === 'string' && itemId ? itemId : label;
    });
    if (task.canPickMany === true) { return keys; }
    return keys.length === 1 ? keys[0] : undefined;
}

function inputBoxInput(task: Task, saved: Record<string, unknown>): string | undefined {
    if (typeof saved.value !== 'string') { return undefined; }
    const prefix = typeof task.prefix === 'string' ? task.prefix : '';
    const suffix = typeof task.suffix === 'string' ? task.suffix : '';
    // A prefix or suffix built from other tasks is not known before the run, so the typed part cannot be recovered.
    if (prefix.includes('${') || suffix.includes('${')) { return undefined; }
    const value = saved.value;
    if (value.length < prefix.length + suffix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) {
        return undefined;
    }
    return value.slice(prefix.length, value.length - suffix.length);
}

function dialogInput(task: Task, saved: Record<string, unknown>, workspaceRoot: string | undefined): CliInputValue | undefined {
    const paths = stringList(saved.paths) ?? (typeof saved.path === 'string' && saved.path ? [saved.path] : undefined);
    if (!paths || paths.some(entry => !entry)) { return undefined; }
    const portable = paths.map(entry => portablePath(entry, workspaceRoot));
    if (task.options?.canSelectMany === true) { return portable; }
    return portable.length === 1 ? portable[0] : undefined;
}

function cliInput(task: Task, saved: unknown, workspaceRoot: string | undefined): CliInputValue | undefined {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) { return undefined; }
    const record = saved as Record<string, unknown>;
    switch (task.type) {
        case 'confirm':
            return record.confirmed === 'true' ? true : undefined;
        case 'inputBox':
            return task.password === true ? undefined : inputBoxInput(task, record);
        case 'envPick':
            return typeof record.value === 'string' && record.value ? record.value : undefined;
        case 'quickPick':
            return quickPickInput(task, record);
        case 'fileDialog':
        case 'folderDialog':
        case 'pathDialog':
            return dialogInput(task, record, workspaceRoot);
        default:
            return undefined;
    }
}

export function profileToCliInputs(profile: NamedInputProfile, tasks: Task[], workspaceRoot?: string): ProfileCliInputs {
    const inspection = inspectInputProfile(profile, tasks);
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const inputs: Record<string, CliInputValue> = Object.create(null);
    const skippedTaskIds: string[] = [];
    for (const [taskId, saved] of Object.entries(inspection.usableInputs)) {
        const task = taskById.get(taskId);
        const value = task ? cliInput(task, saved, workspaceRoot) : undefined;
        if (value === undefined) { skippedTaskIds.push(taskId); }
        else { inputs[taskId] = value; }
    }
    return { inputs, skippedTaskIds, staleTaskIds: inspection.staleTaskIds, promptTaskIds: inspection.promptTaskIds,
        passwordTaskIds: tasks.filter(task => task.type === 'inputBox' && task.password === true).map(task => task.id) };
}
