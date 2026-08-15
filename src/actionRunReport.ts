import { t } from './i18n';
import { formatDuration } from './providers/historyProvider';
import type {
    ActionRunLog,
    TaskRunLogDiagnostics,
    TaskRunLogOutput,
    TaskRunLogRecord,
    TaskRunLogStatus,
} from './runLogStore';

const REPORT_STREAM_CHAR_LIMIT = 200_000;

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function outcomeLabel(outcome: ActionRunLog['outcome']): string {
    switch (outcome) {
        case 'success': return t('성공', 'Succeeded');
        case 'failure': return t('실패', 'Failed');
        case 'stopped': return t('사용자 중지', 'Stopped by user');
        case 'cancelled': return t('취소됨', 'Canceled');
    }
}

/** 결말마다 사유 제목이 달라야 "실행 사유"라는 무의미한 제목을 피할 수 있다. */
function reasonHeading(outcome: ActionRunLog['outcome']): string {
    switch (outcome) {
        case 'stopped': return t('중지 사유', 'Stop reason');
        case 'cancelled': return t('취소 사유', 'Cancellation reason');
        case 'success': return t('메모', 'Note');
        case 'failure': return t('실패 사유', 'Failure reason');
    }
}

/**
 * TaskHub가 만든 사유는 코드로 저장되므로 **읽는 시점의 UI 언어로** 옮긴다.
 * 코드가 없으면 도구가 낸 원문이므로 번역하지 않고 그대로 보여 준다.
 */
function actionReasonText(log: ActionRunLog): string | undefined {
    switch (log.errorCode) {
        case 'stopped-by-user':
            return t('사용자가 실행을 중지했습니다.', 'The action was stopped by the user.');
        case 'sensitive-hidden':
            return t(
                'password 입력에서 파생된 실패라 상세를 숨겼습니다.',
                'Failure details are hidden because a task used a password input.'
            );
        default:
            return log.error;
    }
}

function taskReasonText(task: TaskRunLogRecord): string | undefined {
    if (task.errorCode === 'sensitive-hidden') {
        return t(
            'password 입력을 사용한 태스크라 상세를 숨겼습니다.',
            'Details are hidden because this task used a password input.'
        );
    }
    return task.error;
}

function taskStatusLabel(status: TaskRunLogStatus): string {
    switch (status) {
        case 'not-run': return t('실행 안 됨', 'Not run');
        case 'running': return t('실행 중', 'Running');
        case 'success': return t('성공', 'Succeeded');
        case 'failure': return t('실패', 'Failed');
        case 'continued': return t('실패 후 계속', 'Failed, continued');
        case 'condition-skipped': return t('조건으로 건너뜀', 'Skipped by condition');
        case 'unfinished': return t('완료되지 않음', 'Unfinished');
    }
}

/** 색만으로 상태를 알리지 않도록 표의 상태 칸에 붙이는 글리프. */
function taskStatusGlyph(status: TaskRunLogStatus): string {
    switch (status) {
        case 'success': return '✓';
        case 'failure': return '✕';
        case 'continued': return '✕';
        case 'unfinished': return '⧗';
        case 'running': return '⧗';
        default: return '·';
    }
}

function outputAvailabilityLabel(task: TaskRunLogRecord): string {
    switch (task.output.availability) {
        case 'captured': return t('캡처됨', 'Captured');
        case 'redacted': return t('비밀번호 파생 값 때문에 숨김', 'Hidden because it used a password-derived value');
        case 'terminal': return t('터미널로 스트림되어 저장되지 않음', 'Streamed to a terminal and not stored');
        case 'background-one-shot': return t('백그라운드 one-shot이라 저장되지 않음', 'Not stored for a background one-shot');
        case 'capture-truncated': return t('캡처 상한을 넘어 저장되지 않음', 'Not stored because the capture limit was exceeded');
        case 'not-applicable': return t('해당 없음', 'Not applicable');
    }
}

function isFailedStatus(status: TaskRunLogStatus): boolean {
    return status === 'failure' || status === 'continued';
}

function diagnosticsTotals(tasks: readonly TaskRunLogRecord[]): TaskRunLogDiagnostics {
    return tasks.reduce<TaskRunLogDiagnostics>((sum, task) => {
        const d = task.diagnostics;
        return d
            ? {
                error: sum.error + d.error,
                warning: sum.warning + d.warning,
                info: sum.info + d.info,
                hint: sum.hint + d.hint,
            }
            : sum;
    }, { error: 0, warning: 0, info: 0, hint: 0 });
}

/**
 * 합계 하나(`15개`)는 행동으로 이어지지 않는다 — 오류 3인지 경고 15인지에 따라
 * 사용자가 할 일이 다르다. 0인 심각도는 줄에서 빼서 신호를 흐리지 않는다.
 */
function diagnosticsText(d: TaskRunLogDiagnostics): string {
    const parts: string[] = [];
    if (d.error > 0) { parts.push(t(`오류 ${d.error}`, `${d.error} error(s)`)); }
    if (d.warning > 0) { parts.push(t(`경고 ${d.warning}`, `${d.warning} warning(s)`)); }
    if (d.info > 0) { parts.push(t(`정보 ${d.info}`, `${d.info} info`)); }
    if (d.hint > 0) { parts.push(t(`힌트 ${d.hint}`, `${d.hint} hint(s)`)); }
    return parts.length > 0 ? parts.join(' · ') : t('없음', 'None');
}

function tableCell(value: unknown, className?: string): string {
    const classAttr = className ? ` class="${className}"` : '';
    return `<td${classAttr}>${escapeHtml(value)}</td>`;
}

/**
 * 종료 칸. **`exitCode` 는 `null` 일 수 있다** — 프로세스가 시그널로 죽으면
 * Node 가 `code: null, signal: 'SIGTERM'` 을 주기 때문이다(Stop 액션·강제 종료
 * 경로). `!== undefined` 만 보면 그 자리에 문자열 `"null"` 이 찍히고 시그널은
 * 어디에도 남지 않는다.
 */
function exitText(task: TaskRunLogRecord): string {
    if (task.exitCode !== undefined && task.exitCode !== null) {
        return String(task.exitCode);
    }
    return task.signal ? task.signal : '—';
}

function taskSummaryTable(tasks: readonly TaskRunLogRecord[]): string {
    const rows = tasks.map(task => {
        const duration = task.durationMs !== undefined ? formatDuration(task.durationMs) : '—';
        return `<tr>
            ${tableCell(task.index)}
            ${tableCell(task.taskId, 'mono')}
            ${tableCell(task.type, 'mono')}
            ${tableCell(`${taskStatusGlyph(task.status)} ${taskStatusLabel(task.status)}`, `status-${task.status}`)}
            ${tableCell(duration)}
            ${tableCell(exitText(task), 'mono')}
        </tr>`;
    }).join('\n');
    // 표를 `display:block` 으로 바꾸면 Chromium 에서 table role 이 사라져
    // 행·열 연결이 없어진다. 표는 그대로 두고 감싼 쪽을 스크롤시킨다.
    // `tabindex="0"` 은 키보드만 쓰는 사용자가 가로 스크롤에 닿게 한다.
    return `<div class="table-scroll" role="region" tabindex="0" aria-label="${escapeHtml(t('태스크 요약 표', 'Task summary table'))}">
    <table>
        <thead><tr>
            <th scope="col"><span class="sr-only">${escapeHtml(t('순서', 'Order'))}</span><span aria-hidden="true">#</span></th>
            <th scope="col">${escapeHtml(t('태스크', 'Task'))}</th>
            <th scope="col">${escapeHtml(t('종류', 'Type'))}</th>
            <th scope="col">${escapeHtml(t('상태', 'Status'))}</th>
            <th scope="col">${escapeHtml(t('소요 시간', 'Duration'))}</th>
            <th scope="col">${escapeHtml(t('종료', 'Exit'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>
    </div>`;
}

function notice(text: string): string {
    return `<p class="notice">${escapeHtml(text)}</p>`;
}

/**
 * 캡처 스트림 한 벌을 그린다.
 *
 * **뒤를 남긴다.** 빌드 출력에서 사람이 찾는 오류는 거의 항상 끝에 있으므로,
 * 앞 200k자를 남기면 큰 로그일수록 가장 쓸모없는 부분만 보여 주게 된다.
 */
function renderStream(label: string, value: string | undefined, output: TaskRunLogOutput): string {
    const sourceTruncated = output.truncated === true;
    if (!value) {
        // `truncated` 는 stdout/stderr 가 공유하는 플래그다. 애초에 비어 있던
        // 스트림(`undefined`)까지 "상한 때문에 저장 안 됨" 이라고 말하면 안
        // 된다 — 직렬화기는 **버린 스트림만** 빈 문자열로 바꿔 놓으므로,
        // `''` + `truncated` 조합만 실제로 버려진 경우다. 여기서 조용히
        // 빠지면 "출력: 캡처됨" 이라고 적힌 상세가 텅 빈 채로 남는다.
        if (value !== '' || !sourceTruncated) { return ''; }
        return `<h3>${escapeHtml(label)}</h3>${notice(t(
            `로그 파일 크기 상한 때문에 이 출력은 저장되지 않았습니다${output.originalBytes !== undefined
                ? ` (원본 ${output.originalBytes.toLocaleString()}바이트)` : ''}.`,
            `This output was not stored because of the log file size limit${output.originalBytes !== undefined
                ? ` (${output.originalBytes.toLocaleString()} original bytes)` : ''}.`
        ))}`;
    }
    const hiddenChars = Math.max(0, value.length - REPORT_STREAM_CHAR_LIMIT);
    const display = hiddenChars > 0 ? value.slice(value.length - REPORT_STREAM_CHAR_LIMIT) : value;
    const head = hiddenChars > 0
        ? notice(t(
            `보고서 표시 한도 때문에 앞부분 ${hiddenChars.toLocaleString()}자를 숨겼습니다. 원본 로그 파일에는 남아 있습니다.`,
            `${hiddenChars.toLocaleString()} leading character(s) are hidden by the report display limit. They remain in the log file.`
        ))
        : sourceTruncated
            ? notice(t(
                '로그 파일 크기 상한 때문에 원래 출력의 일부만 저장되었습니다.',
                'Only part of the original output was stored because of the log file size limit.'
            ))
            : '';
    return `<h3>${escapeHtml(label)}</h3>${head}<pre>${escapeHtml(display)}</pre>`;
}

function taskDetails(task: TaskRunLogRecord): string {
    const metadata: string[] = [];
    if (task.command) {
        metadata.push(`<dt>${escapeHtml(t('명령', 'Command'))}</dt><dd><code>${escapeHtml(task.command)}</code></dd>`);
    }
    if (task.cwd) {
        metadata.push(`<dt>${escapeHtml(t('작업 폴더', 'Working directory'))}</dt><dd><code>${escapeHtml(task.cwd)}</code></dd>`);
    }
    const reason = taskReasonText(task);
    if (reason) {
        metadata.push(`<dt>${escapeHtml(t('사유', 'Reason'))}</dt><dd class="error-text">${escapeHtml(reason)}</dd>`);
    }
    if (task.diagnostics) {
        metadata.push(`<dt>${escapeHtml(t('진단', 'Diagnostics'))}</dt><dd>${escapeHtml(diagnosticsText(task.diagnostics))}</dd>`);
    }
    if (task.artifacts && task.artifacts.length > 0) {
        const files = task.artifacts.map(file => `<li><code>${escapeHtml(file)}</code></li>`).join('');
        metadata.push(`<dt>${escapeHtml(t('파일 결과', 'File results'))}</dt><dd><ul>${files}</ul></dd>`);
    }
    metadata.push(`<dt>${escapeHtml(t('출력', 'Output'))}</dt><dd>${escapeHtml(outputAvailabilityLabel(task))}</dd>`);

    const streams = task.output.availability === 'captured'
        ? renderStream('stdout', task.output.stdout, task.output)
            + renderStream('stderr', task.output.stderr, task.output)
        : '';
    const open = isFailedStatus(task.status) ? ' open' : '';
    return `<details class="task"${open}>
        <summary><code>${escapeHtml(task.taskId)}</code> · ${escapeHtml(taskStatusLabel(task.status))}</summary>
        <dl>${metadata.join('')}</dl>
        ${streams}
    </details>`;
}

/** 스크립트 없이 동작하는 읽기 전용 실행 보고서 HTML. */
export function buildActionRunReportHtml(log: ActionRunLog, styleNonce: string): string {
    const succeeded = log.tasks.filter(task => task.status === 'success').length;
    const failedTasks = log.tasks.filter(task => isFailedStatus(task.status));
    const failed = failedTasks.length;
    const skipped = log.tasks.filter(task => task.status === 'condition-skipped' || task.status === 'not-run').length;
    const unfinished = Math.max(0, log.tasks.length - succeeded - failed - skipped);
    const diagnostics = diagnosticsTotals(log.tasks);
    const artifacts = Array.from(new Set(log.tasks.flatMap(task => task.artifacts ?? [])));
    const taskSummary = t(
        `전체 ${log.tasks.length} · 성공 ${succeeded} · 실패 ${failed} · 미실행/건너뜀 ${skipped}${unfinished > 0 ? ` · 미완료 ${unfinished}` : ''}`,
        `${log.tasks.length} total · ${succeeded} succeeded · ${failed} failed · ${skipped} not run/skipped${unfinished > 0 ? ` · ${unfinished} unfinished` : ''}`
    );
    // 어느 태스크에서 멈췄는지는 보고서를 여는 첫 번째 이유다. 사유 문장이
    // 태스크 이름을 담고 있으리라는 보장이 없으므로 요약에 직접 적는다.
    const failedNames = failedTasks.map(task => task.taskId).join(', ');
    const failedRow = failed > 0
        ? `<dt>${escapeHtml(t('실패한 태스크', 'Failed task(s)'))}</dt><dd class="error-text mono">${escapeHtml(failedNames)}</dd>`
        : '';
    const artifactList = artifacts.length > 0
        ? `<section><h2>${escapeHtml(t('파일 결과', 'File results'))}</h2><ul>${artifacts
            .map(file => `<li><code>${escapeHtml(file)}</code></li>`).join('')}</ul></section>`
        : '';
    const reason = actionReasonText(log);
    const error = reason
        ? `<section class="reason"><h2>${escapeHtml(reasonHeading(log.outcome))}</h2><p class="error-text">${escapeHtml(reason)}</p></section>`
        : '';
    const truncation = log.truncated
        ? notice(t(
            '로그 파일 크기 상한 때문에 일부 stdout/stderr가 잘렸습니다.',
            'Some stdout/stderr was truncated because of the log file size limit.'
        ))
        : '';
    // 성공한 실행에서는 상세가 소음이지만, 실패·중지에서는 그것이 보고서를
    // 연 이유다. 접힌 채로 두면 `details.task` 의 자동 펼침도 함께 죽는다.
    const detailsOpen = log.outcome === 'success' ? '' : ' open';
    const detailsLabel = failed > 0
        ? t(`태스크 상세 ${log.tasks.length} — 실패 ${failed}`, `${log.tasks.length} task details — ${failed} failed`)
        : t(`태스크 상세 ${log.tasks.length}`, `${log.tasks.length} task details`);

    return `<!DOCTYPE html>
<html lang="${escapeHtml(t('ko', 'en'))}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(styleNonce)}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(t('액션 실행 보고서', 'Action Run Report'))}</title>
    <style nonce="${escapeHtml(styleNonce)}">
        body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0 auto; max-width: 1080px; padding: 28px 32px 56px; line-height: 1.5; }
        h1 { margin: 0; font-size: 1.7rem; } h2 { margin-top: 1.6rem; font-size: 1.1rem; } h3 { margin: 14px 0 4px; font-size: .95rem; }
        .eyebrow { color: var(--vscode-descriptionForeground); font-size: .85rem; margin-bottom: 4px; letter-spacing: .04em; }
        .outcome { display: inline-block; margin: 12px 0 4px; border-radius: 999px; padding: 3px 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .outcome-failure { background: var(--vscode-inputValidation-errorBackground, var(--vscode-badge-background)); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
        .outcome-stopped, .outcome-cancelled { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-descriptionForeground); }
        .meta { display: grid; grid-template-columns: max-content 1fr; gap: 5px 18px; margin-top: 18px; }
        dt { color: var(--vscode-descriptionForeground); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
        .table-scroll { overflow-x: auto; margin: 12px 0; }
        .table-scroll:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 10px; text-align: left; white-space: nowrap; }
        th { color: var(--vscode-descriptionForeground); font-weight: 600; }
        td.status-failure, td.status-continued { color: var(--vscode-errorForeground); }
        td.status-success { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, inherit)); }
        td.status-unfinished, td.status-running { color: var(--vscode-editorWarning-foreground); }
        td.status-not-run, td.status-condition-skipped { color: var(--vscode-descriptionForeground); }
        code, .mono { font-family: var(--vscode-editor-font-family); }
        pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); overflow: auto; padding: 12px; white-space: pre-wrap; word-break: break-word; max-height: 45vh; margin: 0; }
        details { border-top: 1px solid var(--vscode-panel-border); padding: 9px 0; } details > summary { cursor: pointer; font-weight: 600; }
        summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
        details.tasks > summary { font-size: 1.05rem; } details.task { margin-left: 14px; }
        details.task dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 16px; }
        .error-text { color: var(--vscode-errorForeground); }
        .notice { color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-editorWarning-foreground); padding-left: 10px; }
        ul { margin-top: 4px; padding-left: 22px; }
        .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        @media (max-width: 680px) { body { padding: 20px 16px 40px; } details.task { margin-left: 0; } }
    </style>
</head>
<body>
    <div class="eyebrow">TaskHub · ${escapeHtml(t('액션 실행 보고서', 'Action Run Report'))}</div>
    <h1>${escapeHtml(log.actionTitle)}</h1>
    <div class="outcome outcome-${escapeHtml(log.outcome)}">${escapeHtml(outcomeLabel(log.outcome))}</div>
    <dl class="meta">
        <dt>${escapeHtml(t('시작', 'Started'))}</dt><dd>${escapeHtml(new Date(log.startedAt).toLocaleString())}</dd>
        <dt>${escapeHtml(t('종료', 'Finished'))}</dt><dd>${escapeHtml(new Date(log.finishedAt).toLocaleString())}</dd>
        <dt>${escapeHtml(t('소요 시간', 'Duration'))}</dt><dd>${escapeHtml(formatDuration(log.durationMs))}</dd>
        <dt>${escapeHtml(t('태스크', 'Tasks'))}</dt><dd>${escapeHtml(taskSummary)}</dd>
        ${failedRow}
        <dt>${escapeHtml(t('진단', 'Diagnostics'))}</dt><dd>${escapeHtml(diagnosticsText(diagnostics))}</dd>
    </dl>
    ${error}
    ${artifactList}
    ${truncation}
    <section>
        ${taskSummaryTable(log.tasks)}
        <details class="tasks"${detailsOpen}>
            <summary>${escapeHtml(detailsLabel)}</summary>
            ${log.tasks.map(taskDetails).join('\n')}
        </details>
    </section>
</body>
</html>`;
}
