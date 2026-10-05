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
        invalidStorage: t('저장된 예약 데이터가 손상됐거나 지원하지 않는 형식입니다. 기존 데이터는 보존했습니다. "AI: 예약 데이터 초기화"로 백업 후 복구할 수 있습니다.', 'Stored schedules are corrupt or unsupported. Existing data was preserved. Use "AI: Reset Schedule Data" to back up and recover.'),
        invalidSchedule: t('예약 시각과 주기를 확인하세요.', 'Check the schedule time and cadence.'),
        disposed: t('예약 실행 기능이 꺼져 있습니다.', 'The scheduler is disabled.'),
        running: t('실행을 중지한 뒤 예약을 변경하세요.', 'Stop the run before changing its schedule.'),
        tooMany: t('예약은 최대 50개까지 등록할 수 있습니다.', 'You can register up to 50 schedules.'),
    };
    const detail = plainNotificationText(error instanceof ClaudeSchedulerError ? messages[error.code] : error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(t(`AI 예약 실행: ${detail}`, `AI schedules: ${detail}`));
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
    };
}

function assertPromptInsideWorkspace(workspacePath: string, promptPath: string): void {
    const relative = path.relative(workspacePath, promptPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(t('요청문 파일을 선택한 워크스페이스 안에 저장하세요.', 'Save the prompt file inside the selected workspace.'));
    }
}

function promptExample(): string {
    return t(`# 정기 코드 검토

## 목표
이 작업 폴더의 코드를 읽고 정확성 버그를 찾아 주세요.

## 범위
현재 작업 폴더의 소스 코드와 관련 테스트를 검토하세요.
프로젝트 지침을 따르고 생성된 파일과 외부 의존성은 제외하세요.

## 지시
- 실제 코드로 근거를 확인할 수 있는 문제만 보고하세요.
- 파일 수정, 명령 실행, 커밋, 푸시는 하지 마세요.

## 결과 형식
문제가 있으면 파일 위치, 문제의 원인, 수정 제안을 정리하세요.
문제가 없으면 검토한 범위와 함께 발견한 문제가 없다고 알려 주세요.
`, `# Recurring code review

## Goal
Read the code in this working folder and find correctness bugs.

## Scope
Review source code and related tests in the current working folder.
Follow the project instructions and exclude generated files and external dependencies.

## Instructions
- Report only issues supported by evidence in the code.
- Do not modify files, execute commands, commit, or push.

## Output format
For each issue, provide its file location, cause, and suggested fix.
If no issues are found, say so and describe the scope reviewed.
`);
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
                        void vscode.window.showInformationMessage(t('이 예약 명령을 이미 처리 중입니다.', 'This schedule command is already in progress.'));
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
            { placeHolder: t('AI 예약을 선택하세요.', 'Choose an AI schedule.') });
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
            void vscode.window.showInformationMessage(t('다른 AI 예약이 실행 중입니다.', 'Another AI schedule is running.'));
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
    private async choosePrompt(selected: vscode.WorkspaceFolder, workspacePath: string, existing?: ClaudeSchedule): Promise<string | undefined> {
        const filters = { [t('요청문', 'Prompt')]: ['md', 'txt'] };
        let promptUri: vscode.Uri | undefined;
        if (!existing) {
            const source = await vscode.window.showQuickPick([
                {
                    label: t('예제 요청문 만들기', 'Create an example prompt'),
                    description: t('처음 사용할 때 추천', 'Recommended for your first schedule'),
                    detail: t('목표·범위·지시·결과 형식을 담은 코드 검토 예제를 열어 수정합니다. 저장 후 예약 등록을 이어갑니다.',
                        'Edit a code review example with a goal, scope, instructions, and output format, then save and continue scheduling.'),
                    promptSource: 'example' as const,
                },
                {
                    label: t('기존 요청문 파일 선택', 'Choose an existing prompt file'),
                    description: t('워크스페이스 안의 .md 또는 .txt', '.md or .txt inside the workspace'),
                    detail: t('반복할 작업을 일반 문장으로 작성하세요. 매 실행마다 저장된 내용을 다시 읽습니다. 예약 주기는 다음 단계에서 지정합니다.',
                        'Describe the recurring task in plain language. Saved content is read on each run. Set the cadence in the next steps.'),
                    promptSource: 'file' as const,
                },
            ], {
                title: t('AI 예약 추가 — 요청문 준비', 'Add AI Schedule — Prepare a prompt'),
                placeHolder: t('어떤 작업을 반복할까요? 요청문에 목표·대상 파일·지시·원하는 결과를 적으세요. 현재 실행 엔진: Claude Code.',
                    'What should repeat? Describe the goal, target files, instructions, and desired output. Current engine: Claude Code.'),
            });
            if (!source || this.disposed) { return; }
            if (source.promptSource === 'example') {
                const savedUri = await vscode.window.showSaveDialog({
                    title: t('작업 폴더 안에 예제 요청문 저장', 'Save the example prompt inside the working folder'),
                    defaultUri: vscode.Uri.joinPath(selected.uri, 'ai-schedule-prompt.md'),
                    saveLabel: t('예제 요청문 만들기', 'Create example prompt'), filters,
                });
                if (!savedUri || this.disposed) { return; }
                if (savedUri.scheme !== 'file' || !/\.(?:md|txt)$/i.test(savedUri.fsPath)) {
                    throw new Error(t('.md 또는 .txt 파일로 저장하세요.', 'Save as an .md or .txt file.'));
                }
                // Canonicalize the parent before writing so a linked directory cannot escape the workspace.
                const promptPath = path.join(await fs.realpath(path.dirname(savedUri.fsPath)), path.basename(savedUri.fsPath));
                assertPromptInsideWorkspace(workspacePath, promptPath);
                try { await fs.writeFile(promptPath, promptExample(), { flag: 'wx' }); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                        throw new Error(t('같은 이름의 파일이 이미 있습니다. 기존 요청문 파일을 선택하거나 새 파일 이름을 사용하세요.',
                            'A file with this name already exists. Choose the existing prompt file or use a new filename.'));
                    }
                    throw error;
                }
                if (this.disposed) { return; }
                promptUri = vscode.Uri.file(promptPath);
                const document = await vscode.workspace.openTextDocument(promptUri);
                await vscode.window.showTextDocument(document, { preview: false });
                const continueLabel = t('저장하고 예약 계속', 'Save and continue scheduling');
                const choice = await vscode.window.showInformationMessage(t(
                    '예제의 목표·범위·지시·결과 형식을 원하는 작업으로 수정한 뒤 "저장하고 예약 계속"을 누르세요. 아직 예약은 등록되지 않았습니다.',
                    'Edit the example’s goal, scope, instructions, and output format, then choose "Save and continue scheduling". No schedule has been registered yet.'
                ), continueLabel);
                if (choice !== continueLabel || this.disposed) { return; }
                if (!await document.save()) {
                    throw new Error(t('요청문을 저장하지 못했습니다. 저장한 뒤 예약을 다시 추가하세요.', 'Could not save the prompt. Save it and add the schedule again.'));
                }
            }
        }
        if (!promptUri) {
            const files = await vscode.window.showOpenDialog({
                title: t('반복할 작업을 작성한 요청문 파일 선택 (.md / .txt)', 'Select a prompt describing the recurring task (.md / .txt)'),
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                defaultUri: existing ? vscode.Uri.file(existing.promptPath) : selected.uri,
                openLabel: t('요청문 파일 선택', 'Select prompt file'), filters,
            });
            promptUri = files?.[0];
        }
        if (!promptUri || promptUri.scheme !== 'file' || this.disposed) { return; }
        const promptPath = await fs.realpath(promptUri.fsPath);
        assertPromptInsideWorkspace(workspacePath, promptPath);
        return promptPath;
    }
    private async wizard(existing?: ClaudeSchedule): Promise<ClaudeSchedule | undefined> {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        if (!folders.length) { throw new Error(t('로컬 워크스페이스 폴더를 열어주세요.', 'Open a local workspace folder.')); }
        const selected = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
            { placeHolder: t('AI 예약을 실행할 작업 폴더를 선택하세요.', 'Choose the working folder for the AI schedule.') }))?.folder;
        if (!selected) { return; }
        const workspacePath = await fs.realpath(selected.uri.fsPath);
        const promptPath = await this.choosePrompt(selected, workspacePath, existing);
        if (!promptPath || this.disposed) { return; }
        const name = await vscode.window.showInputBox({ value: existing?.name ?? path.basename(promptPath),
            prompt: t('예약 이름', 'Schedule name'), validateInput: value => value.trim() && value.trim().length <= 200 ? undefined : t('1~200자로 입력하세요.', 'Enter 1–200 characters.') });
        if (!name?.trim()) { return; }
        const mode = await vscode.window.showQuickPick([
            { label: t('분석', 'Analysis'), description: t('코드를 읽고 결과 보고 — 파일 수정·명령 실행 없음', 'Read code and report findings — no file edits or commands'), mode: 'analysis' as const },
            { label: t('코드 수정', 'Code editing'), description: t('작업 폴더의 코드 수정 — 실행할 명령은 다음 단계에서 지정', 'Edit code in the working folder — choose allowed commands in the next step'), mode: 'edit' as const },
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
            { label: t('간격 반복', 'Repeat at intervals'), description: t('예: 60분마다 실행', 'For example, run every 60 minutes'), cadenceKind: 'interval' as const },
            { label: t('매일 지정 시각', 'Daily at a set time'), description: t('예: 매일 현지 시각 오전 9시', 'For example, daily at 9 AM local time'), cadenceKind: 'daily' as const },
        ], { placeHolder: t('VS Code가 열려 있을 때 실행합니다. 첫 실행은 다음 예약 시각입니다.', 'Runs while VS Code is open. The first run is at the next scheduled time.') });
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
