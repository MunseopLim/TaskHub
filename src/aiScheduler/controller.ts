import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { t } from '../i18n';
import { plainNotificationText } from '../notificationText';
import { AiSchedulesProvider, cadenceLabel } from '../providers/aiSchedulesProvider';
import { AI_SCHEDULES_KEY, AiCadence, AiSchedule, AiScheduleChanges, AiScheduler, AiSchedulerError, SchedulerDependencies, validBashRules } from './model';
import { AiCliOptions, KillCliProcess, runScheduledAi } from './runner';
import { AiReportDocuments } from './reportDocument';
import { aiScheduleSetting, aiSchedulesEnabled } from './settings';
import { legacyAiScheduler } from './compatibility';

const commands = ['add', 'edit', 'pause', 'resume', 'runNow', 'stop', 'remove', 'openReport', 'showSchedules', 'reset'] as const;
const enableSettings = ['aiScheduler.enabled', 'experimental.aiScheduler.enabled', legacyAiScheduler.enabledSetting];
function storedSchedules(context: vscode.ExtensionContext): unknown {
    const current = context.workspaceState.get(AI_SCHEDULES_KEY);
    return current === undefined ? context.workspaceState.get(legacyAiScheduler.stateKey) : current;
}
function showError(error: unknown): void {
    const messages: Record<AiSchedulerError['code'], string> = {
        invalidStorage: t('저장된 예약 데이터가 손상됐거나 지원하지 않는 형식입니다. 기존 데이터는 보존했습니다. "AI: 예약 데이터 초기화"로 백업 후 복구할 수 있습니다.', 'Stored schedules are corrupt or unsupported. Existing data was preserved. Use "AI: Reset Schedule Data" to back up and recover.'),
        invalidSchedule: t('예약 시각과 주기를 확인하세요.', 'Check the schedule time and cadence.'),
        disposed: t('예약 실행 기능이 꺼져 있습니다.', 'The scheduler is disabled.'),
        running: t('실행을 중지한 뒤 예약을 변경하세요.', 'Stop the run before changing its schedule.'),
        tooMany: t('예약은 최대 50개까지 등록할 수 있습니다.', 'You can register up to 50 schedules.'),
    };
    const detail = plainNotificationText(error instanceof AiSchedulerError ? messages[error.code] : error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(t(`AI 예약 실행: ${detail}`, `AI schedules: ${detail}`));
}
function numberSetting(key: 'timeoutSeconds', fallback: number, min: number, max: number): number {
    const value = aiScheduleSetting<unknown>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function cliOptions(): AiCliOptions {
    return {
        executable: aiScheduleSetting('executable', 'claude'),
        model: aiScheduleSetting('model', '').trim() || undefined,
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

export interface AiSchedulerRegistration extends vscode.Disposable {
    shutdown(): Promise<void>;
    hasRunning(): boolean;
}
/** Switching off aborts immediately; switching on waits for the retiring runner. */
export function registerAiScheduler(context: vscode.ExtensionContext, kill: KillCliProcess,
    create: () => AiSchedulerController = () => new AiSchedulerController(context, kill)): AiSchedulerRegistration {
    let controller: AiSchedulerController | undefined;
    let disposed = false;
    let retiring: Promise<void> = Promise.resolve();
    let retiringCount = 0;
    const update = (): void => {
        const enabled = !disposed && aiSchedulesEnabled() && vscode.workspace.isTrusted;
        void vscode.commands.executeCommand('setContext', 'taskhub.aiScheduler.enabled', enabled).then(undefined, showError);
        if (!enabled && controller) {
            const previous = controller; controller = undefined;
            previous.dispose();
            retiringCount++;
            retiring = retiring.then(() => previous.shutdown()).catch(showError).finally(() => { retiringCount--; });
        }
        if (enabled && !controller) {
            void retiring.then(() => {
                if (disposed || controller || !aiSchedulesEnabled() || !vscode.workspace.isTrusted) { return; }
                try { controller = create(); }
                catch (error) { showError(error); }
            });
        }
    };
    const listener = vscode.workspace.onDidChangeConfiguration(event => {
        if (enableSettings.some(key => event.affectsConfiguration(`taskhub.${key}`))) { update(); }
    });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(update);
    update();
    const registration = new vscode.Disposable(() => {
        disposed = true; listener.dispose(); trustListener.dispose(); update();
    }) as AiSchedulerRegistration;
    registration.shutdown = async () => { registration.dispose(); await retiring; };
    registration.hasRunning = () => !!controller?.engine.runningId || retiringCount > 0;
    return registration;
}

export class AiSchedulerController implements vscode.Disposable {
    readonly engine: AiScheduler;
    readonly ready: Promise<void>;
    private readonly provider: AiSchedulesProvider;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly busy = new Set<string>();
    private readonly reports: AiReportDocuments;
    private storageError?: unknown;
    private disposed = false;
    constructor(private readonly context: vscode.ExtensionContext, kill: KillCliProcess, options: () => AiCliOptions = cliOptions) {
        const dependencies: SchedulerDependencies = {
            now: Date.now,
            schedule: (callback, delay) => {
                const timer = setTimeout(callback, delay); timer.unref();
                return new vscode.Disposable(() => clearTimeout(timer));
            },
            save: async state => { await context.workspaceState.update(AI_SCHEDULES_KEY, state); },
            run: (job: AiSchedule, signal: AbortSignal, slot?: number) => runScheduledAi(job, signal, slot, context.globalStorageUri.fsPath,
                (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath), options(), kill),
            changed: () => this.provider?.refresh(),
            error: (error: unknown) => { if (!this.disposed) { showError(error); } },
        };
        try { this.engine = new AiScheduler(storedSchedules(context), dependencies); }
        catch (error) { this.storageError = error; this.engine = new AiScheduler(undefined, dependencies); }
        this.provider = new AiSchedulesProvider(() => this.engine.list(), () => this.engine.runningId, () => this.engine.queuedIds);
        this.reports = new AiReportDocuments(context.globalStorageUri.fsPath);
        try {
            this.disposables.push(this.provider, this.reports, vscode.workspace.registerTextDocumentContentProvider('taskhub-ai-report', this.reports),
                vscode.window.createTreeView('mainView.aiSchedules', { treeDataProvider: this.provider }));
            for (const command of commands) {
                const handler = async (node?: AiSchedule): Promise<void> => {
                    if (this.disposed) { return; }
                    if (this.busy.has(command)) {
                        void vscode.window.showInformationMessage(t('이 예약 명령을 이미 처리 중입니다.', 'This schedule command is already in progress.'));
                        return;
                    }
                    this.busy.add(command);
                    try { await this.ready; if (!this.disposed) { await this.execute(command, node); } }
                    catch (error) { if (!this.disposed) { showError(error); } }
                    finally { this.busy.delete(command); }
                };
                for (const prefix of ['taskhub.aiScheduler', legacyAiScheduler.commandPrefix]) {
                    this.disposables.push(vscode.commands.registerCommand(`${prefix}.${command}`, handler));
                }
            }
            this.disposables.push(vscode.commands.registerCommand(legacyAiScheduler.viewFocusCommand, () => this.execute('showSchedules')));
            this.ready = this.storageError ? Promise.resolve() : this.engine.initialize();
            if (this.storageError) { showError(this.storageError); }
            void this.ready.catch(error => { this.engine.dispose(); if (!this.disposed) { showError(error); } });
        } catch (error) { this.dispose(); throw error; }
    }
    private async select(node?: AiSchedule): Promise<AiSchedule | undefined> {
        const jobs = this.engine.list();
        if (node) { return jobs.find(job => job.id === node.id); }
        const picked = await vscode.window.showQuickPick(jobs.map(job => ({ label: job.name, description: cadenceLabel(job.cadence), job })),
            { placeHolder: t('AI 예약을 선택하세요.', 'Choose an AI schedule.') });
        return picked?.job;
    }
    private async execute(command: typeof commands[number], node?: AiSchedule): Promise<void> {
        if (command === 'showSchedules') {
            if (!vscode.workspace.getConfiguration('taskhub').get<boolean>('aiScheduler.showPanel', true)) {
                await vscode.commands.executeCommand('workbench.action.openSettings', '@id:taskhub.aiScheduler.showPanel');
            } else { await vscode.commands.executeCommand('mainView.aiSchedules.focus'); }
            return;
        }
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
            if (this.engine.runningId === job.id || this.engine.queuedIds.includes(job.id)) {
                throw new Error(t('실행 중이거나 대기 중인 예약은 편집할 수 없습니다. 실행이 끝나거나 중지한 뒤 편집하세요.',
                    'A running or queued schedule cannot be edited. Edit it after the run finishes or is stopped.'));
            }
            const changes = await this.editSchedule(job);
            if (changes && !this.disposed && !await this.engine.update(job.id, changes)) {
                throw new Error(t('이 예약은 이미 삭제됐습니다.', 'This schedule has already been deleted.'));
            }
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
        const backup = path.join(this.context.globalStorageUri.fsPath, 'ai-scheduler', `corrupt-schedules-${randomUUID()}.json`);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.writeFile(backup, JSON.stringify(storedSchedules(this.context)), { flag: 'wx', mode: 0o600 });
        await this.engine.initialize();
        this.storageError = undefined;
        void vscode.window.showInformationMessage(t(`예약 목록을 초기화했습니다. 백업: ${backup}`, `Schedules reset. Backup: ${backup}`));
    }
    private async choosePrompt(selected: vscode.Uri, workspacePath: string, existing?: AiSchedule): Promise<string | undefined> {
        const filters = { [t('요청문', 'Prompt')]: ['md', 'txt'] };
        let promptUri: vscode.Uri | undefined;
        if (!existing) {
            const source = await vscode.window.showQuickPick([
                {
                    label: t('예제 요청문 만들기', 'Create an example prompt'),
                    description: t('처음 사용할 때 추천', 'Recommended for your first schedule'),
                    detail: t('목표·범위·지시·결과 형식을 담은 코드 검토 예제를 엽니다. 수정하고 저장한 뒤 예약 추가에서 기존 요청문 파일을 선택하세요.',
                        'Open a code review example with a goal, scope, instructions, and output format. Edit and save it, then use Add schedule to choose the existing prompt file.'),
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
                    defaultUri: vscode.Uri.joinPath(selected, 'ai-schedule-prompt.md'),
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
                // Editing can outlast a notification toast. End Add here instead of holding its command lock.
                void vscode.window.showInformationMessage(t(
                    '예제 요청문을 열었습니다. 목표·범위·지시·결과 형식을 원하는 작업으로 수정하고 저장한 뒤, 예약 추가에서 "기존 요청문 파일 선택"을 고르세요. 아직 예약은 등록되지 않았습니다.',
                    'The example prompt is open. Edit its goal, scope, instructions, and output format, then save it. Use Add schedule and choose "Choose an existing prompt file" to register it. No schedule has been registered yet.'
                ));
                return;
            }
        }
        if (!promptUri) {
            const files = await vscode.window.showOpenDialog({
                title: t('반복할 작업을 작성한 요청문 파일 선택 (.md / .txt)', 'Select a prompt describing the recurring task (.md / .txt)'),
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                defaultUri: existing ? vscode.Uri.file(existing.promptPath) : selected,
                openLabel: t('요청문 파일 선택', 'Select prompt file'), filters,
            });
            promptUri = files?.[0];
        }
        if (!promptUri || promptUri.scheme !== 'file' || this.disposed) { return; }
        const promptPath = await fs.realpath(promptUri.fsPath);
        assertPromptInsideWorkspace(workspacePath, promptPath);
        return promptPath;
    }
    private async askName(value: string): Promise<string | undefined> {
        const name = await vscode.window.showInputBox({ value,
            prompt: t('예약 이름', 'Schedule name'), validateInput: value => value.trim() && value.trim().length <= 200 ? undefined : t('1~200자로 입력하세요.', 'Enter 1–200 characters.') });
        return name?.trim() || undefined;
    }
    private async askMode(current: AiSchedule['mode'] = 'analysis'): Promise<AiSchedule['mode'] | undefined> {
        const items = [
            { label: t('분석', 'Analysis'), description: t('코드를 읽고 결과 보고 — 파일 수정·명령 실행 없음', 'Read code and report findings — no file edits or commands'), mode: 'analysis' as const },
            { label: t('코드 수정', 'Code editing'), description: t('작업 폴더의 코드 수정 — 실행할 명령은 다음 단계에서 지정', 'Edit code in the working folder — choose allowed commands in the next step'), mode: 'edit' as const },
        ];
        if (current === 'edit') { items.reverse(); }
        return (await vscode.window.showQuickPick(items, { placeHolder: t('예약 실행에 허용할 도구를 선택하세요.', 'Choose the tools allowed for this schedule.') }))?.mode;
    }
    private async askBashRules(current: string[] = []): Promise<string[] | undefined> {
        const input = await vscode.window.showInputBox({ value: JSON.stringify(current),
            prompt: t('Bash 허용 규칙 JSON 배열 (예: ["Bash(git diff *)", "Bash(npm test)"]). []는 Bash 제외. 허용 명령·프로젝트 스크립트는 파일 도구의 경로 제한 밖에서도 동작할 수 있습니다.',
                'Bash allow rules as a JSON array (e.g. ["Bash(git diff *)", "Bash(npm test)"]). [] excludes Bash. Allowed commands and project scripts can act beyond file-tool path limits.'),
            validateInput: value => {
                try { if (validBashRules(JSON.parse(value))) { return undefined; } } catch { /* Validate below. */ }
                return t('Bash(...) 규칙 최대 20개를 JSON 배열로 입력하세요. 전체 Bash 허용은 지원하지 않습니다.', 'Enter up to 20 Bash(...) rules as a JSON array. Allowing all Bash commands is unsupported.');
            } });
        return input === undefined ? undefined : JSON.parse(input);
    }
    private async askCadence(current?: AiCadence): Promise<AiCadence | undefined> {
        const items = [
            { label: t('간격 반복', 'Repeat at intervals'), description: t('예: 60분마다 실행', 'For example, run every 60 minutes'), cadenceKind: 'interval' as const },
            { label: t('매일 지정 시각', 'Daily at a set time'), description: t('예: 매일 현지 시각 오전 9시', 'For example, daily at 9 AM local time'), cadenceKind: 'daily' as const },
        ];
        if (current?.kind === 'daily') { items.reverse(); }
        const kind = await vscode.window.showQuickPick(items, { placeHolder: current
            ? t('실행 주기를 변경하면 다음 예약 시각을 새 주기로 계산합니다.', 'Changing the cadence recalculates the next scheduled time.')
            : t('VS Code가 열려 있을 때 실행합니다. 첫 실행은 다음 예약 시각입니다.', 'Runs while VS Code is open. The first run is at the next scheduled time.') });
        if (!kind) { return; }
        let cadence: AiCadence;
        if (kind.cadenceKind === 'interval') {
            const minutes = await vscode.window.showInputBox({ value: current?.kind === 'interval' ? String(current.minutes) : '60',
                prompt: t('실행 간격 (분, 1~10080)', 'Interval in minutes (1–10080)'),
                validateInput: value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 10080 ? undefined : t('1~10080 사이의 정수를 입력하세요.', 'Enter an integer from 1 to 10080.') });
            if (!minutes) { return; }
            cadence = { kind: 'interval', minutes: Number(minutes) };
        } else {
            const daily = current?.kind === 'daily' ? current : undefined;
            const time = await vscode.window.showInputBox({ value: daily ? `${String(daily.hour).padStart(2, '0')}:${String(daily.minute).padStart(2, '0')}` : '09:00',
                prompt: t('매일 실행할 현지 시각 (HH:mm)', 'Daily local time (HH:mm)'),
                validateInput: value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : t('HH:mm 형식으로 입력하세요.', 'Enter a time in HH:mm format.') });
            if (!time) { return; }
            const [hour, minute] = time.split(':').map(Number);
            cadence = { kind: 'daily', hour, minute };
        }
        return cadence;
    }
    private async editSchedule(job: AiSchedule): Promise<AiScheduleChanges | undefined> {
        type Field = 'name' | 'promptContents' | 'promptFile' | 'workspace' | 'mode' | 'bashRules' | 'cadence';
        const items: Array<vscode.QuickPickItem & { field: Field }> = [
            { label: t('예약 이름', 'Schedule name'), description: job.name, field: 'name' },
            { label: t('요청문 내용 편집', 'Edit prompt contents'), description: path.basename(job.promptPath),
                detail: t('파일을 열어 수정하고 저장하면 다음 실행부터 사용합니다.', 'Edit and save the file to use the new content on the next run.'), field: 'promptContents' },
            { label: t('요청문 파일 변경', 'Change prompt file'), description: job.promptPath, field: 'promptFile' },
            { label: t('작업 폴더', 'Working folder'), description: job.workspacePath, field: 'workspace' },
            { label: t('허용 도구', 'Allowed tools'), description: job.mode === 'edit' ? t('코드 수정', 'Code editing') : t('분석', 'Analysis'), field: 'mode' },
            { label: t('실행 주기', 'Cadence'), description: cadenceLabel(job.cadence), field: 'cadence' },
        ];
        if (job.mode === 'edit') { items.push({ label: t('허용 명령', 'Allowed commands'), description: JSON.stringify(job.bashRules ?? []), field: 'bashRules' }); }
        const selected = await vscode.window.showQuickPick(items, {
            title: t(`AI 예약 편집 — ${plainNotificationText(job.name)}`, `Edit AI Schedule — ${plainNotificationText(job.name)}`),
            placeHolder: t('변경할 항목을 선택하세요. 다른 설정과 실행 상태는 유지합니다.', 'Choose a field to edit. Other settings and run state are preserved.'),
        });
        if (!selected || this.disposed) { return; }
        switch (selected.field) {
            case 'name': {
                const name = await this.askName(job.name);
                return name === undefined ? undefined : { name };
            }
            case 'promptContents': {
                const promptPath = await fs.realpath(job.promptPath);
                assertPromptInsideWorkspace(await fs.realpath(job.workspacePath), promptPath);
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(promptPath));
                if (!this.disposed) { await vscode.window.showTextDocument(document, { preview: false }); }
                return;
            }
            case 'promptFile': {
                const workspacePath = await fs.realpath(job.workspacePath);
                const promptPath = await this.choosePrompt(vscode.Uri.file(workspacePath), workspacePath, job);
                return promptPath === undefined ? undefined : { promptPath };
            }
            case 'workspace': {
                const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
                if (!folders.length) { throw new Error(t('로컬 워크스페이스 폴더를 열어주세요.', 'Open a local workspace folder.')); }
                // A missing folder must not block choosing one of the others.
                const choices = (await Promise.all(folders.map(async folder => ({ label: folder.name, description: folder.uri.fsPath,
                    folder, workspacePath: await fs.realpath(folder.uri.fsPath).catch(() => '') }))))
                    .filter(choice => choice.workspacePath);
                if (!choices.length) { throw new Error(t('로컬 워크스페이스 폴더를 열어주세요.', 'Open a local workspace folder.')); }
                choices.sort((a, b) => Number(b.workspacePath === job.workspacePath) - Number(a.workspacePath === job.workspacePath));
                const selectedFolder = await vscode.window.showQuickPick(choices, {
                    placeHolder: t('작업 폴더를 변경하면 해당 폴더 안의 요청문 파일을 선택합니다.', 'Choose a working folder, then select a prompt file inside it.'),
                });
                if (!selectedFolder || selectedFolder.workspacePath === job.workspacePath || this.disposed) { return; }
                const { folder, workspacePath } = selectedFolder;
                const promptPath = await this.choosePrompt(folder.uri, workspacePath, { ...job, promptPath: path.join(workspacePath, path.basename(job.promptPath)) });
                return promptPath === undefined ? undefined : { workspacePath, promptPath };
            }
            case 'mode': {
                const mode = await this.askMode(job.mode);
                if (!mode) { return; }
                const bashRules = mode === 'edit' ? await this.askBashRules(job.bashRules) : [];
                return bashRules === undefined ? undefined : { mode, bashRules };
            }
            case 'bashRules': {
                const bashRules = await this.askBashRules(job.bashRules);
                return bashRules === undefined ? undefined : { bashRules };
            }
            case 'cadence': {
                const cadence = await this.askCadence(job.cadence);
                return cadence === undefined ? undefined : { cadence };
            }
        }
    }
    private async wizard(): Promise<AiSchedule | undefined> {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        if (!folders.length) { throw new Error(t('로컬 워크스페이스 폴더를 열어주세요.', 'Open a local workspace folder.')); }
        const selected = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
            { placeHolder: t('AI 예약을 실행할 작업 폴더를 선택하세요.', 'Choose the working folder for the AI schedule.') }))?.folder;
        if (!selected) { return; }
        const workspacePath = await fs.realpath(selected.uri.fsPath);
        const promptPath = await this.choosePrompt(selected.uri, workspacePath);
        if (!promptPath || this.disposed) { return; }
        const name = await this.askName(path.basename(promptPath));
        if (!name) { return; }
        const mode = await this.askMode();
        if (!mode) { return; }
        const bashRules = mode === 'edit' ? await this.askBashRules() : [];
        if (!bashRules) { return; }
        const cadence = await this.askCadence();
        if (!cadence) { return; }
        return { id: randomUUID(), name, workspacePath, promptPath, mode, bashRules, cadence, enabled: true, nextRunAt: 0 };
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; this.engine.dispose();
        for (const disposable of this.disposables) { disposable.dispose(); }
    }
    async shutdown(): Promise<void> { this.dispose(); await this.ready.catch(() => undefined); await this.engine.shutdown(); }
}
