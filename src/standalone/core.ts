import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActionsValidator, mergeActions, taskHubRoot, parseAndValidateActionsContent, traverseActionItems } from '../actionCatalog';
import { runDoctorPerSource } from '../doctor';
import { resolveWithinWorkspace } from '../pipelineUtils';
import { buildPreviewReport } from '../previewRun';
import type { Action, ActionItem } from '../schema';
import { listActionRunHistory, readActionRunLog, RunLogStore, RUN_LOG_DEFAULT_MAX_FILES, RUN_LOG_DEFAULT_MAX_TOTAL_BYTES,
    RUN_LOG_DEFAULT_RETENTION_DAYS } from '../runLogStore';
import { t } from './language';
import { TaskHubError } from './errors';
import type { Inputs } from './inputs';
import { executionIssues, runPipeline } from './runner';

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

    validate(id: string) {
        const item = this.action(id);
        const findings = runDoctorPerSource([{ rawText: JSON.stringify([item], null, 2), sourceLabel: id, filePath: id,
            workspaceFolder: this.root, workspaceRoots: [this.root], extensionPath: this.extensionPath }], getActionsValidator());
        const issues = executionIssues(item.action.tasks);
        return { actionId: id, valid: !issues.length && !findings.some(f => f.severity === 'error'), findings, issues };
    }

    requireTrust() {
        if (!this.options.trusted) {
            throw new TaskHubError(3, t('실행하려면 시작 옵션에 --trust를 지정하세요.', 'Execution requires --trust at launch.'));
        }
    }

    async run(id: string, inputs: Inputs, signal: AbortSignal) {
        this.requireTrust();
        const result = await runPipeline(this.action(id), this.root, this.extensionPath, inputs, signal, !!this.options.captureOutput);
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
