import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActionsValidator, mergeActions, taskHubRoot, parseAndValidateActionsContent, traverseActionItems } from '../actionCatalog';
import { locateActionSpans, runDoctorPerSource } from '../doctor';
import { resolveWithinWorkspace } from '../pipelineUtils';
import { buildPreviewReport } from '../previewRun';
import type { Action, ActionItem } from '../schema';
import { listActionRunHistory, readActionRunLog, RunLogStore, RUN_LOG_DEFAULT_MAX_FILES, RUN_LOG_DEFAULT_MAX_TOTAL_BYTES,
    RUN_LOG_DEFAULT_RETENTION_DAYS } from '../runLogStore';
import { t } from './language';
import { TaskHubError } from './errors';
import type { Inputs } from './inputs';
import { executionIssues, runPipeline, type ConsoleListener } from './runner';

/**
 * The actions file reduced to one action, with every other character blanked so lines and columns
 * stay those of the original file. Doctor then reports only this action's findings, at their real positions.
 */
export function isolateAction(rawText: string, id: string): string | undefined {
    const text = rawText.replace(/^\uFEFF/, '');
    const span = locateActionSpans(text).get(id);
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    if (!span || open < 0 || open > span.start || close < span.end) { return undefined; }
    let isolated = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const kept = (index >= span.start && index < span.end) || index === open || index === close || char === '\n' || char === '\r';
        isolated += kept ? char : ' ';
    }
    return isolated;
}

/** The action files exist but cannot be parsed or fail the schema. */
class InvalidActionsError extends TaskHubError {}

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
            throw new InvalidActionsError(2, t('actions.json 오류를 doctor로 확인하세요.', 'Invalid actions.json. Run doctor for diagnostics.'));
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
        let item;
        try {
            item = this.action(id);
        } catch (error) {
            if (!(error instanceof InvalidActionsError)) { throw error; }
            // Without a valid file the action cannot be isolated; the whole-file findings explain why.
            return { actionId: id, valid: false, findings: this.doctor(), issues: [t(
                'actions.json에 오류가 있어 액션을 읽지 못했습니다. 파일 전체 진단을 표시합니다.',
                'Could not read the action because actions.json has errors. Showing the diagnostics of the whole file.'
            )] };
        }
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
    async run(id: string, inputs: Inputs, signal: AbortSignal, onOutput?: ConsoleListener) {
        this.requireTrust();
        const result = await runPipeline(this.action(id), this.root, this.extensionPath, inputs, signal, !!this.options.captureOutput, onOutput);
        const { actionId, startedAt, finishedAt, outcome, error } = result.log;
        // Tasks a condition turned off, with the (already redacted) reason, so a skipped step is visible without the log.
        const skipped = result.log.tasks.filter(task => task.status === 'condition-skipped')
            .map(task => ({ taskId: task.taskId, reason: task.error ?? '' }));
        // Failures `continueOnError` carried past; without them a successful summary would hide a broken step.
        const continued = result.log.tasks.filter(task => task.status === 'continued')
            .map(task => ({ taskId: task.taskId, error: task.error ?? '' }));
        const summary = { actionId, startedAt, finishedAt, outcome, exitCode: result.exitCode, error, skipped, continued };
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
