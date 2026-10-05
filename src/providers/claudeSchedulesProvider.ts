import * as vscode from 'vscode';
import { t } from '../i18n';
import { ClaudeCadence, ClaudeSchedule, ClaudeRunResult } from '../claudeScheduler/model';

export function cadenceLabel(cadence: ClaudeCadence): string {
    if (cadence.kind === 'interval') { return t(`${cadence.minutes}분마다`, cadence.minutes === 1 ? 'Every minute' : `Every ${cadence.minutes} minutes`); }
    const time = `${String(cadence.hour).padStart(2, '0')}:${String(cadence.minute).padStart(2, '0')}`;
    return t(`매일 ${time} (현지 시각)`, `Daily at ${time} (local time)`);
}
export function claudeStatusLabel(status: ClaudeRunResult['status']): string {
    switch (status) {
        case 'success': return t('완료', 'Completed');
        case 'failed': return t('실패', 'Failed');
        case 'stopped': return t('중지', 'Stopped');
        case 'skipped': return t('건너뜀', 'Skipped');
        case 'running': return t('실행 중', 'Running');
        case 'queued': return t('실행 대기', 'Queued');
        case 'interrupted': return t('추적 중단', 'Tracking interrupted');
    }
}

export class ClaudeSchedulesProvider implements vscode.TreeDataProvider<ClaudeSchedule>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<ClaudeSchedule | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    constructor(private readonly jobs: () => ClaudeSchedule[], private readonly runningId: () => string | undefined,
        private readonly queuedIds: () => string[] = () => []) {}
    refresh(): void { this.emitter.fire(undefined); }
    dispose(): void { this.emitter.dispose(); }
    getChildren(): ClaudeSchedule[] { return this.jobs(); }
    getTreeItem(job: ClaudeSchedule): vscode.TreeItem {
        const item = new vscode.TreeItem(job.name);
        const running = job.id === this.runningId();
        const queued = this.queuedIds().includes(job.id);
        // Old failed/stopped runs recorded their finish time before pause timestamps were stored.
        const pausedAt = job.pausedAt ?? (job.lastRun?.status === 'failed' || job.lastRun?.status === 'stopped' ? job.lastRun.finishedAt : undefined);
        item.id = job.id;
        item.contextValue = running ? 'claudeScheduleRunning' : queued ? 'claudeScheduleQueued' : job.enabled ? 'claudeScheduleEnabled' : 'claudeSchedulePaused';
        item.iconPath = new vscode.ThemeIcon(running ? 'sync~spin' : queued ? 'watch' : job.enabled ? 'clock' : 'debug-pause');
        item.description = running ? t('실행 중', 'Running') : queued ? t('실행 대기', 'Queued') : job.enabled
            ? t(`다음: ${new Date(job.nextRunAt).toLocaleString()}`, `Next: ${new Date(job.nextRunAt).toLocaleString()}`)
            : pausedAt !== undefined ? t(`정지: ${new Date(pausedAt).toLocaleString()}`, `Paused: ${new Date(pausedAt).toLocaleString()}`)
                : t('일시 정지', 'Paused');
        if (!running && !queued && job.lastRun) { item.description += ` · ${claudeStatusLabel(job.lastRun.status)}`; }
        item.description = `${cadenceLabel(job.cadence)} · ${item.description}`;
        const detail = job.lastRun?.detail === 'scheduler-busy' ? t('다른 예약 실행과 겹쳐 건너뛰었습니다.', 'Skipped because another schedule was running.')
            : job.lastRun?.detail === 'scheduler-missed' ? t('놓친 예약 시각을 건너뛰었습니다.', 'Skipped a missed scheduled time.')
            : job.lastRun?.detail === 'scheduler-queued-cancelled' ? t('실행 대기 중 종료되어 건너뛰었습니다. 다음 예약은 유지합니다.', 'Skipped because the scheduler closed while queued. Future runs remain scheduled.')
            // Older releases saved a cost-limit reason; omit it from the current UI.
            : job.lastRun?.detail === 'scheduler-budget' ? undefined : job.lastRun?.detail;
        item.tooltip = [item.description, job.workspacePath, job.promptPath,
            job.mode === 'edit' ? t('코드 수정 허용', 'Code editing allowed') : t('분석 도구만 허용', 'Analysis tools only'),
            job.lastRun ? claudeStatusLabel(job.lastRun.status) : t('아직 실행하지 않음', 'No runs yet'), detail].filter(Boolean).join('\n');
        if (job.lastRun?.report) {
            item.command = { command: 'taskhub.claudeScheduler.openReport', title: t('실행 보고서 열기', 'Open run report'), arguments: [job] };
        }
        return item;
    }
}
