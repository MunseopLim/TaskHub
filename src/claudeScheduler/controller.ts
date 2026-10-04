import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { t } from '../i18n';
import { plainNotificationText } from '../notificationText';
import { ClaudeSchedulesProvider, cadenceLabel } from '../providers/claudeSchedulesProvider';
import { CLAUDE_SCHEDULES_KEY, ClaudeCadence, ClaudeSchedule, ClaudeScheduler, ClaudeSchedulerError, SchedulerDependencies, validBashRules } from './model';
import { ClaudeCliOptions, KillClaudeProcess, runScheduledClaude } from './runner';
import { ClaudeReportDocuments } from './reportDocument';

const commands = ['add', 'edit', 'pause', 'resume', 'runNow', 'stop', 'remove', 'openReport', 'showSchedules', 'reset'] as const;
const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('taskhub');
const featureKey = 'experimental.claudeScheduler.enabled';
function showError(error: unknown): void {
    const messages: Record<ClaudeSchedulerError['code'], string> = {
        invalidStorage: t('저장된 예약 데이터가 손상됐거나 지원하지 않는 형식입니다. 기존 데이터는 보존했습니다. "Claude: 예약 데이터 초기화"로 백업 후 복구할 수 있습니다.', 'Stored schedules are corrupt or unsupported. Existing data was preserved. Use "Claude: Reset Schedule Data" to back up and recover.'),
        invalidSchedule: t('예약 시각과 주기를 확인하세요.', 'Check the schedule time and cadence.'),
        disposed: t('예약 실행 기능이 꺼져 있습니다.', 'The scheduler is disabled.'),
        running: t('실행을 중지한 뒤 예약을 변경하세요.', 'Stop the run before changing its schedule.'),
        tooMany: t('예약은 최대 50개까지 등록할 수 있습니다.', 'You can register up to 50 schedules.'),
    };
    const detail = plainNotificationText(error instanceof ClaudeSchedulerError ? messages[error.code] : error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(t(`Claude 예약 실행: ${detail}`, `Claude schedules: ${detail}`));
}
function numberSetting(key: string, fallback: number, min: number, max: number): number {
    const value = config().get<unknown>(`claudeScheduler.${key}`, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function cliOptions(): ClaudeCliOptions {
    return {
        executable: config().get<string>('claudeScheduler.executable', 'claude'),
        model: config().get<string>('claudeScheduler.model', '').trim() || undefined,
        timeoutSeconds: Math.floor(numberSetting('timeoutSeconds', 600, 10, 3600)),
        maxTurns: Math.floor(numberSetting('maxTurns', 20, 1, 100)),
        maxBudgetUsd: numberSetting('maxBudgetUsd', 1, 0.01, 100),
        maxDailyRuns: Math.floor(numberSetting('maxDailyRuns', 24, 1, 1000)),
        maxDailyBudgetUsd: numberSetting('maxDailyBudgetUsd', 5, 0.01, 1000),
    };
}

export interface ClaudeSchedulerRegistration extends vscode.Disposable {
    shutdown(): Promise<void>;
    hasRunning(): boolean;
}
/** Switching off aborts immediately; switching on waits for the retiring runner. */
export function registerClaudeScheduler(context: vscode.ExtensionContext, kill: KillClaudeProcess,
    create: () => ClaudeSchedulerController = () => new ClaudeSchedulerController(context, kill)): ClaudeSchedulerRegistration {
    let controller: ClaudeSchedulerController | undefined;
    let disposed = false;
    let retiring: Promise<void> = Promise.resolve();
    let retiringCount = 0;
    const update = (): void => {
        const enabled = !disposed && config().get<unknown>(featureKey, false) === true && vscode.workspace.isTrusted;
        if (!enabled && controller) {
            const previous = controller; controller = undefined;
            previous.dispose();
            retiringCount++;
            retiring = retiring.then(() => previous.shutdown()).catch(showError).finally(() => { retiringCount--; });
        }
        if (enabled && !controller) {
            void retiring.then(() => {
                if (disposed || controller || config().get<unknown>(featureKey, false) !== true || !vscode.workspace.isTrusted) { return; }
                try { controller = create(); }
                catch (error) { showError(error); }
            });
        }
    };
    const listener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`taskhub.${featureKey}`)) { update(); }
    });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(update);
    update();
    const registration = new vscode.Disposable(() => {
        disposed = true; listener.dispose(); trustListener.dispose(); update();
    }) as ClaudeSchedulerRegistration;
    registration.shutdown = async () => { registration.dispose(); await retiring; };
    registration.hasRunning = () => !!controller?.engine.runningId || retiringCount > 0;
    return registration;
}

export class ClaudeSchedulerController implements vscode.Disposable {
    readonly engine: ClaudeScheduler;
    readonly ready: Promise<void>;
    private readonly provider: ClaudeSchedulesProvider;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly busy = new Set<string>();
    private readonly reports: ClaudeReportDocuments;
    private storageError?: unknown;
    private disposed = false;
    constructor(private readonly context: vscode.ExtensionContext, kill: KillClaudeProcess, options: () => ClaudeCliOptions = cliOptions) {
        const dependencies: SchedulerDependencies = {
            now: Date.now,
            schedule: (callback, delay) => {
                const timer = setTimeout(callback, delay); timer.unref();
                return new vscode.Disposable(() => clearTimeout(timer));
            },
            save: async state => { await context.workspaceState.update(CLAUDE_SCHEDULES_KEY, state); },
            run: (job: ClaudeSchedule, signal: AbortSignal, slot?: number) => runScheduledClaude(job, signal, slot, context.globalStorageUri.fsPath,
                (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath), options(), kill),
            changed: () => this.provider?.refresh(),
            error: (error: unknown) => { if (!this.disposed) { showError(error); } },
        };
        try { this.engine = new ClaudeScheduler(context.workspaceState.get(CLAUDE_SCHEDULES_KEY), dependencies); }
        catch (error) { this.storageError = error; this.engine = new ClaudeScheduler(undefined, dependencies); }
        this.provider = new ClaudeSchedulesProvider(() => this.engine.list(), () => this.engine.runningId, () => this.engine.queuedIds);
        this.reports = new ClaudeReportDocuments(context.globalStorageUri.fsPath);
        try {
            this.disposables.push(this.provider, this.reports, vscode.workspace.registerTextDocumentContentProvider('taskhub-claude-report', this.reports),
                vscode.window.createTreeView('mainView.claudeSchedules', { treeDataProvider: this.provider }));
            for (const command of commands) {
                this.disposables.push(vscode.commands.registerCommand(`taskhub.claudeScheduler.${command}`, async (node?: ClaudeSchedule) => {
                    if (this.disposed) { return; }
                    if (this.busy.has(command)) {
                        void vscode.window.showInformationMessage(t('이 Claude 예약 명령을 이미 처리 중입니다.', 'This Claude schedule command is already in progress.'));
                        return;
                    }
                    this.busy.add(command);
                    try { await this.ready; if (!this.disposed) { await this.execute(command, node); } }
                    catch (error) { if (!this.disposed) { showError(error); } }
                    finally { this.busy.delete(command); }
                }));
            }
            this.ready = this.storageError ? Promise.resolve() : this.engine.initialize();
            if (this.storageError) { showError(this.storageError); }
            void this.ready.catch(error => { this.engine.dispose(); if (!this.disposed) { showError(error); } });
        } catch (error) { this.dispose(); throw error; }
    }
    private async select(node?: ClaudeSchedule): Promise<ClaudeSchedule | undefined> {
        const jobs = this.engine.list();
        if (node) { return jobs.find(job => job.id === node.id); }
        const picked = await vscode.window.showQuickPick(jobs.map(job => ({ label: job.name, description: cadenceLabel(job.cadence), job })),
            { placeHolder: t('Claude 예약을 선택하세요.', 'Choose a Claude schedule.') });
        return picked?.job;
    }
    private async execute(command: typeof commands[number], node?: ClaudeSchedule): Promise<void> {
        if (command === 'showSchedules') { await vscode.commands.executeCommand('mainView.claudeSchedules.focus'); return; }
        if (command === 'reset') { await this.resetStorage(); return; }
        if (this.storageError) { throw this.storageError; }
        if (command === 'add') {
            const job = await this.wizard();
            if (job && !this.disposed) { await this.engine.put(job); }
            return;
        }
        const job = await this.select(node);
        if (!job || this.disposed) { return; }
        if (command === 'pause' || command === 'resume') { await this.engine.setEnabled(job.id, command === 'resume'); }
        if (command === 'stop') { await this.engine.stop(job.id); }
        if (command === 'runNow' && !await this.engine.runNow(job.id)) {
            void vscode.window.showInformationMessage(t('다른 Claude 예약이 실행 중입니다.', 'Another Claude schedule is running.'));
        }
        if (command === 'edit') {
            if (this.engine.runningId === job.id) { throw new Error(t('실행을 중지한 뒤 예약을 편집하세요.', 'Stop the run before editing its schedule.')); }
            const updated = await this.wizard(job);
            if (updated && !this.disposed) { await this.engine.put(updated); }
        }
        if (command === 'remove') {
            const yes = 'Yes';
            const name = plainNotificationText(job.name);
            const answer = await vscode.window.showWarningMessage(t(`예약 '${name}'을 삭제할까요?`, `Delete schedule '${name}'?`), { modal: true }, yes);
            if (answer === yes && !this.disposed) { await this.engine.remove(job.id); }
        }
        if (command === 'openReport') {
            if (!job.lastRun?.report) { void vscode.window.showInformationMessage(t('아직 실행 보고서가 없습니다.', 'No run report yet.')); return; }
            const document = await vscode.workspace.openTextDocument(this.reports.uri(job));
            if (!this.disposed) { await vscode.window.showTextDocument(document); }
        }
    }
    private async resetStorage(): Promise<void> {
        if (!this.storageError) {
            void vscode.window.showInformationMessage(t('예약 데이터가 정상입니다. 예약 삭제 메뉴를 사용하세요.', 'Schedule data is healthy. Use the delete schedule menu.'));
            return;
        }
        const answer = await vscode.window.showWarningMessage(t('손상된 예약 데이터를 백업하고 빈 예약 목록으로 초기화할까요?',
            'Back up corrupt schedule data and reset to an empty schedule list?'), { modal: true }, 'Yes');
        if (answer !== 'Yes' || this.disposed) { return; }
        const backup = path.join(this.context.globalStorageUri.fsPath, 'claude-scheduler', `corrupt-schedules-${randomUUID()}.json`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, JSON.stringify(this.context.workspaceState.get(CLAUDE_SCHEDULES_KEY)), { flag: 'wx', mode: 0o600 });
        await this.engine.initialize();
        this.storageError = undefined;
        void vscode.window.showInformationMessage(t(`예약 목록을 초기화했습니다. 백업: ${backup}`, `Schedules reset. Backup: ${backup}`));
    }
    private async wizard(existing?: ClaudeSchedule): Promise<ClaudeSchedule | undefined> {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        if (!folders.length) { throw new Error(t('로컬 워크스페이스 폴더를 열어주세요.', 'Open a local workspace folder.')); }
        const selected = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
            { placeHolder: t('Claude를 실행할 폴더를 선택하세요.', 'Choose the folder for Claude.') }))?.folder;
        if (!selected) { return; }
        const workspacePath = await fs.realpath(selected.uri.fsPath);
        const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            defaultUri: existing ? vscode.Uri.file(existing.promptPath) : selected.uri,
            openLabel: t('요청문 파일 선택', 'Select prompt file'), filters: { [t('요청문', 'Prompt')]: ['md', 'txt'] } });
        if (!files?.[0] || files[0].scheme !== 'file') { return; }
        const promptPath = await fs.realpath(files[0].fsPath);
        const relative = path.relative(workspacePath, promptPath);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(t('요청문 파일을 선택한 워크스페이스 안에 저장하세요.', 'Save the prompt file inside the selected workspace.'));
        }
        const name = await vscode.window.showInputBox({ value: existing?.name ?? path.basename(promptPath),
            prompt: t('예약 이름', 'Schedule name'), validateInput: value => value.trim() && value.trim().length <= 200 ? undefined : t('1~200자로 입력하세요.', 'Enter 1–200 characters.') });
        if (!name?.trim()) { return; }
        const mode = await vscode.window.showQuickPick([
            { label: t('분석', 'Analysis'), description: t('Read·Glob·Grep 도구 허용', 'Allow Read, Glob, Grep tools'), mode: 'analysis' as const },
            { label: t('코드 수정', 'Code editing'), description: t('워크스페이스의 코드 편집; Bash는 다음 단계에서 별도 지정', 'Edit workspace code; configure Bash separately in the next step'), mode: 'edit' as const },
        ], { placeHolder: t('예약 실행에 허용할 도구를 선택하세요.', 'Choose the tools allowed for this schedule.') });
        if (!mode) { return; }
        let bashRules: string[] = [];
        if (mode.mode === 'edit') {
            const input = await vscode.window.showInputBox({ value: JSON.stringify(existing?.bashRules ?? []),
                prompt: t('Bash 허용 규칙 JSON 배열 (예: ["Bash(git diff *)", "Bash(npm test)"]). []는 Bash 제외. 허용 명령·프로젝트 스크립트는 파일 도구의 경로 제한 밖에서도 동작할 수 있습니다.',
                    'Bash allow rules as a JSON array (e.g. ["Bash(git diff *)", "Bash(npm test)"]). [] excludes Bash. Allowed commands and project scripts can act beyond file-tool path limits.'),
                validateInput: value => {
                    try { if (validBashRules(JSON.parse(value))) { return undefined; } } catch { /* Validate below. */ }
                    return t('Bash(...) 규칙 최대 20개를 JSON 배열로 입력하세요. 전체 Bash 허용은 지원하지 않습니다.', 'Enter up to 20 Bash(...) rules as a JSON array. Allowing all Bash commands is unsupported.');
                } });
            if (input === undefined) { return; }
            bashRules = JSON.parse(input);
        }
        const kind = await vscode.window.showQuickPick([
            { label: t('간격 반복', 'Repeat at intervals'), cadenceKind: 'interval' as const },
            { label: t('매일 지정 시각', 'Daily at a set time'), cadenceKind: 'daily' as const },
        ], { placeHolder: t('예약 주기를 선택하세요.', 'Choose a schedule cadence.') });
        if (!kind) { return; }
        let cadence: ClaudeCadence;
        if (kind.cadenceKind === 'interval') {
            const minutes = await vscode.window.showInputBox({ value: existing?.cadence.kind === 'interval' ? String(existing.cadence.minutes) : '60',
                prompt: t('실행 간격 (분, 1~10080)', 'Interval in minutes (1–10080)'),
                validateInput: value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 10080 ? undefined : t('1~10080 사이의 정수를 입력하세요.', 'Enter an integer from 1 to 10080.') });
            if (!minutes) { return; }
            cadence = { kind: 'interval', minutes: Number(minutes) };
        } else {
            const daily = existing?.cadence.kind === 'daily' ? existing.cadence : undefined;
            const time = await vscode.window.showInputBox({ value: daily ? `${String(daily.hour).padStart(2, '0')}:${String(daily.minute).padStart(2, '0')}` : '09:00',
                prompt: t('매일 실행할 현지 시각 (HH:mm)', 'Daily local time (HH:mm)'),
                validateInput: value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : t('HH:mm 형식으로 입력하세요.', 'Enter a time in HH:mm format.') });
            if (!time) { return; }
            const [hour, minute] = time.split(':').map(Number);
            cadence = { kind: 'daily', hour, minute };
        }
        return { id: existing?.id ?? randomUUID(), name: name.trim(), workspacePath, promptPath, mode: mode.mode, bashRules,
            cadence, enabled: true, nextRunAt: 0 };
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; this.engine.dispose();
        for (const disposable of this.disposables) { disposable.dispose(); }
    }
    async shutdown(): Promise<void> { this.dispose(); await this.ready.catch(() => undefined); await this.engine.shutdown(); }
}
