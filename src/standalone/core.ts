import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActionsValidator, mergeActions, taskHubRoot, parseAndValidateActionsContent, traverseActionItems } from '../actionCatalog';
import { locateJsonPointer, runDoctorPerSource } from '../doctor';
import { resolveWithinWorkspace } from '../pipelineUtils';
import { buildPreviewReport } from '../previewRun';
import type { Action, ActionItem } from '../schema';
import { listActionRunHistory, readActionRunLog, RunLogStore, RUN_LOG_DEFAULT_MAX_FILES, RUN_LOG_DEFAULT_MAX_TOTAL_BYTES,
    RUN_LOG_DEFAULT_RETENTION_DAYS } from '../runLogStore';
import { t } from './language';
import { TaskHubError } from './errors';
import type { Inputs } from './inputs';
import type { OutputListener } from './process';
import { executionIssues, runPipeline } from './runner';

/** Offset just past the JSON value that starts at `start` (an object or array), or -1. */
function valueEnd(text: string, start: number): number {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            for (index++; index < text.length && text[index] !== '"'; index++) {
                if (text[index] === '\\') { index++; }
            }
        } else if (char === '{' || char === '[') {
            depth++;
        } else if (char === '}' || char === ']') {
            if (--depth === 0) { return index + 1; }
        }
    }
    return -1;
}

/**
 * The actions file reduced to one action, with every other character blanked so lines and columns
 * stay those of the original file. Doctor then reports only this action's findings at their real
 * positions — filtering whole-file findings by position would not work, because Doctor places a
 * task's finding at the first `"id"` with that task id in the file, which may belong to another action.
 */
export function isolateAction(rawText: string, id: string): string | undefined {
    const text = rawText.replace(/^\uFEFF/, '');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return undefined; }
    let pointer: string | undefined;
    const walk = (items: unknown, base: string) => {
        if (!Array.isArray(items)) { return; }
        items.forEach((item: { id?: unknown; action?: unknown; children?: unknown } | null, index) => {
            if (pointer !== undefined || !item || typeof item !== 'object') { return; }
            if (item.id === id && item.action) { pointer = `${base}/${index}`; return; }
            walk(item.children, `${base}/${index}/children`);
        });
    };
    walk(parsed, '');
    if (pointer === undefined) { return undefined; }
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') { lineStarts.push(index + 1); }
    }
    const location = locateJsonPointer(text, parsed, pointer);
    const start = lineStarts[location.startLine - 1] + location.startColumn - 1;
    const end = valueEnd(text, start);
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    if (end < 0 || open < 0 || close < end) { return undefined; }
    let isolated = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const kept = (index >= start && index < end) || index === open || index === close || char === '\n' || char === '\r';
        isolated += kept ? char : ' ';
    }
    return isolated;
}

interface WorkspaceOptions {
    trusted?: boolean;
    actionsFile?: string;
    preset?: string;
    captureOutput?: boolean;
}

export class Workspace {
    readonly root: string;
    readonly extensionPath = taskHubRoot;
    private readonly logs: RunLogStore;
    constructor(directory: string, private readonly options: WorkspaceOptions = {}) {
        try {
            // The native realpath also expands Windows 8.3 short names (RUNNER~1), so every
            // later workspace-boundary check compares the same canonical spelling.
            this.root = fs.realpathSync.native(directory);
            if (!fs.statSync(this.root).isDirectory()) { throw new Error(); }
        } catch {
            throw new TaskHubError(2, t('워크스페이스 디렉터리를 열 수 없습니다.', 'Cannot open workspace directory.'));
        }
        this.logs = new RunLogStore(this.root);
    }

    private source(name: string, optional: boolean) {
        const filePath = path.resolve(this.root, name);
        try {
            // An absolute source is an explicit launcher setting, never a tool parameter.
            if (!path.isAbsolute(name)) { resolveWithinWorkspace(filePath, [this.root], this.root); }
            const stat = fs.statSync(filePath, { throwIfNoEntry: false });
            if (!stat && optional) { return []; }
            if (!stat?.isFile()) { throw new Error(); }
            return [{ filePath, rawText: fs.readFileSync(filePath, 'utf8'), sourceLabel: name,
                workspaceFolder: this.root, workspaceRoots: [this.root], extensionPath: this.extensionPath }];
        } catch {
            throw new TaskHubError(2, t(`액션 파일을 열 수 없습니다: ${name}`, `Cannot read action file: ${name}`));
        }
    }

    private sources() {
        const workspace = this.source(this.options.actionsFile ?? '.vscode/actions.json', !!this.options.preset && !this.options.actionsFile);
        return [...workspace, ...(this.options.preset ? this.source(this.options.preset, false) : [])];
    }

    doctor() {
        return runDoctorPerSource(this.sources(), getActionsValidator());
    }

    private actions() {
        const sources = this.sources();
        const actions = new Map<string, ActionItem & { action: Action }>();
        try {
            const items = sources.reduce<ActionItem[]>((existing, source) =>
                mergeActions(existing, parseAndValidateActionsContent(source.rawText, source.filePath), 'keep-existing'), []);
            traverseActionItems(items, item => {
                if (!item.type && item.action) { actions.set(item.id, { ...item, action: item.action }); }
            });
        } catch {
            throw new TaskHubError(2, t('actions.json 오류를 doctor로 확인하세요.', 'Invalid actions.json. Run doctor for diagnostics.'));
        }
        return actions;
    }

    list() {
        return Array.from(this.actions().values(), ({ id, title, action }) => ({ id, title, description: action.description }));
    }

    action(id: string) {
        const item = this.actions().get(id);
        if (!item) { throw new TaskHubError(2, t(`액션을 찾을 수 없습니다: ${id}`, `Action not found: ${id}`)); }
        return item;
    }

    preview(id: string) {
        return { actionId: id, report: buildPreviewReport(this.action(id), {
            workspaceFolder: this.root, workspaceRoots: [this.root], extensionPath: this.extensionPath,
        }) };
    }

    /** Doctor findings inside the action's definition, with their positions in the actions file. */
    validate(id: string) {
        const item = this.action(id);
        // Like the merged catalog, the first source that defines the id provides the action.
        const source = this.sources().map(candidate => ({ candidate, isolated: isolateAction(candidate.rawText, id) }))
            .find(entry => entry.isolated !== undefined);
        const findings = source ? runDoctorPerSource([{ ...source.candidate, rawText: source.isolated! }], getActionsValidator()) : [];
        const issues = executionIssues(item.action.tasks);
        return { actionId: id, valid: !issues.length && !findings.some(f => f.severity === 'error'), findings, issues };
    }

    requireTrust() {
        if (!this.options.trusted) {
            throw new TaskHubError(3, t('실행하려면 시작 옵션에 --trust를 지정하세요.', 'Execution requires --trust at launch.'));
        }
    }

    /** `onOutput` shows command output while it runs; the run log still follows `captureOutput`. */
    async run(id: string, inputs: Inputs, signal: AbortSignal, onOutput?: OutputListener) {
        this.requireTrust();
        const result = await runPipeline(this.action(id), this.root, this.extensionPath, inputs, signal, !!this.options.captureOutput, onOutput);
        const { actionId, startedAt, finishedAt, outcome, error } = result.log;
        const summary = { actionId, startedAt, finishedAt, outcome, exitCode: result.exitCode, error };
        try {
            const saved = await this.logs.write(result.log, { maxFiles: RUN_LOG_DEFAULT_MAX_FILES,
                retentionDays: RUN_LOG_DEFAULT_RETENTION_DAYS, maxTotalBytes: RUN_LOG_DEFAULT_MAX_TOTAL_BYTES });
            return { ...summary, runId: saved.workspaceRelativePath,
                warning: saved.rotationWarning ? t('이전 로그 정리에 실패했습니다.', 'Log rotation failed.') : undefined };
        } catch {
            return { ...summary, runId: null, warning: t('실행 로그 저장에 실패했습니다.', 'Could not save the run log.') };
        }
    }

    /** 최신 실행부터 반환한다. `limit`은 건너뛴 로그 수에 영향을 주지 않는다. */
    async history(limit?: number) {
        const history = await listActionRunHistory(this.root);
        return limit === undefined ? history : { ...history, runs: history.runs.slice(0, limit) };
    }

    async log(runId: string) {
        try { return await readActionRunLog(this.root, runId); }
        catch { throw new TaskHubError(2, t('실행 로그를 읽을 수 없습니다.', 'Cannot read the requested run log.')); }
    }
}
