import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeQuickPickItems, quickPickProducesArgsResult, interpolatePipelineVariables } from '../pipelineUtils';
import { buildQuickPickResult, interpolateQuickPickItems, quickPickEntries } from '../quickPickValues';
import { runWithRegexBudget } from '../regexBudget';
import type { Task } from '../schema';
import { parsePathInfo } from '../taskValues';
import { TaskHubError } from './errors';
import { t } from './language';

export type Inputs = Record<string, string | string[] | boolean>;

export function parseInputs(value: unknown): Inputs {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(v => typeof v === 'string' || typeof v === 'boolean'
            || (Array.isArray(v) && v.every(entry => typeof entry === 'string')))) {
        return Object.assign(Object.create(null), value);
    }
    throw new TaskHubError(2, t('입력은 태스크 ID와 문자열·문자열 배열·불리언 값의 객체여야 합니다.',
        'Inputs must map task IDs to strings, string arrays or booleans.'));
}

export function missingInput(task: Task) {
    return new TaskHubError(2, t(`필수 입력이 없습니다: ${task.id}`, `Missing required input: ${task.id}`));
}

export function inputResult(task: Task, inputs: Inputs, context: Record<string, unknown>, root: string, dynamicItems?: unknown[]) {
    if (!Object.hasOwn(inputs, task.id)) { throw missingInput(task); }
    const value = inputs[task.id];
    const invalid = () => new TaskHubError(2, t(`입력 형식을 확인하세요: ${task.id}`, `Invalid input for task: ${task.id}`));
    const expand = (v: string) => interpolatePipelineVariables(v, context);
    switch (task.type) {
        case 'confirm':
            if (![true, false, 'true', 'false'].includes(value as boolean | string)) { throw invalid(); }
            if (value !== true && value !== 'true') { throw new TaskHubError(130, t('확인이 취소되었습니다.', 'Confirmation declined.')); }
            return { confirmed: 'true' };
        case 'inputBox':
            if (typeof value !== 'string') { throw invalid(); }
            if (task.validatePattern && !runWithRegexBudget(task.validatePattern, () => new RegExp(task.validatePattern!).test(value))) {
                throw invalid();
            }
            return { value: expand(task.prefix ?? '') + value + expand(task.suffix ?? '') };
        case 'envPick':
            if (typeof value !== 'string' || !Object.hasOwn(process.env, value)) { throw invalid(); }
            return { value };
        case 'quickPick': {
            const items = dynamicItems ?? interpolateQuickPickItems(normalizeQuickPickItems(task.items) ?? [], context);
            const entries = quickPickEntries(items, t);
            const selected = (Array.isArray(value) ? value : [value]).map(key => {
                if (typeof key !== 'string') { throw invalid(); }
                const byId = entries.find(entry => entry.taskHubItemId === key);
                if (byId) { return byId; }
                const matches = entries.filter(entry => entry.label === key);
                if (matches.length === 1) { return matches[0]; }
                if (!matches.length && key && task.allowCustom && !task.canPickMany) {
                    return { label: key, taskHubValue: key, taskHubCustom: true };
                }
                throw invalid();
            });
            if (!selected.length || (!task.canPickMany && selected.length !== 1)) { throw invalid(); }
            return buildQuickPickResult(selected, task.canPickMany === true, quickPickProducesArgsResult(task));
        }
        default: {
            const values = Array.isArray(value) ? value : [value];
            if (!values.length || (!task.options?.canSelectMany && values.length !== 1)) { throw invalid(); }
            const mode = task.type === 'pathDialog' ? expand(task.mode ?? '') : task.type === 'folderDialog' ? 'folder' : 'file';
            const paths = values.map(v => {
                if (typeof v !== 'string' || !v) { throw invalid(); }
                const absolute = path.resolve(root, v);
                const stat = fs.statSync(absolute, { throwIfNoEntry: false });
                const file = task.type === 'fileDialog' ? task.options?.canSelectFiles !== false : mode === 'file' || mode === 'both';
                const folder = task.type === 'fileDialog' ? task.options?.canSelectFolders === true : mode === 'folder' || mode === 'both';
                if (!(file && stat?.isFile()) && !(folder && stat?.isDirectory())) { throw invalid(); }
                return absolute;
            });
            return { ...parsePathInfo(paths[0]), paths, names: paths.map(p => path.basename(p)), count: paths.length };
        }
    }
}
