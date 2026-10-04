import { spawn, ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { t } from '../i18n';
import { ClaudeRunResult, ClaudeSchedule } from './model';
import { ClaudeBudgetLimitError, reserveClaudeBudget, recordClaudeCost } from './budget';

const promptLimit = 256 * 1024;
const outputLimit = 4 * 1024 * 1024;
const errorLimit = 256 * 1024;
export const MIN_CLAUDE_CLI_VERSION = '2.1.248';
export interface ClaudeCliOptions {
    executable: string;
    model?: string;
    timeoutSeconds: number;
    maxTurns: number;
    maxBudgetUsd: number;
    maxDailyRuns?: number;
    maxDailyBudgetUsd?: number;
    /** Test fixtures can prepend a Node script without enabling arbitrary shell text. */
    prefixArgs?: readonly string[];
}
export type KillClaudeProcess = (child: ChildProcess) => Promise<boolean>;

export function claudeArguments(job: ClaudeSchedule, options: ClaudeCliOptions): string[] {
    const bash = job.mode === 'edit' ? job.bashRules ?? [] : [];
    const tools = job.mode === 'edit' ? `Read,Glob,Grep,Edit,Write${bash.length ? ',Bash' : ''}` : 'Read,Glob,Grep';
    const allowed = ['Read(./**)', 'Glob', 'Grep', ...(job.mode === 'edit' ? ['Edit(./**)', ...bash] : [])];
    // Edit path rules also cover Write. Scoped Write rules are not consulted by Claude.
    const denied = ['mcp__*', ...['.git', '.claude', '.vscode'].flatMap(folder =>
        [`Edit(${folder})`, `Edit(${folder}/**)`, `Edit(**/${folder})`, `Edit(**/${folder}/**)`])];
    return [...(options.prefixArgs ?? []), '-p', '--restricted', '--output-format', 'json', '--permission-mode', 'dontAsk',
        '--tools', tools, '--allowedTools', ...allowed, '--disallowedTools', ...denied, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-session-persistence', '--max-turns', String(options.maxTurns),
        '--max-budget-usd', String(options.maxBudgetUsd), ...(options.model ? ['--model', options.model] : [])];
}

function pathKey(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function boundedRead(file: string, limit: number): Promise<Buffer> {
    // Nonblocking open lets stat reject a FIFO without waiting for a writer.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > limit) { throw new Error(t('파일이 너무 크거나 일반 파일이 아닙니다.', 'File is too large or is not a regular file.')); }
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) { break; }
            size += bytesRead;
        }
        if (size > limit) { throw new Error(t('파일 읽기 한도를 초과했습니다.', 'File exceeds the read limit.')); }
        return buffer.subarray(0, size);
    } finally { await handle.close(); }
}

/** The JSON result distinguishes budget/turn/permission failures from a completed answer. */
export function parseClaudeResult(stdout: string, exitCode: number | null): { success: boolean; text: string; costUsd?: number } {
    let result: Record<string, unknown>;
    try { result = JSON.parse(stdout); }
    catch { return { success: false, text: t('Claude CLI가 올바른 JSON 결과를 반환하지 않았습니다.', 'Claude CLI did not return a valid JSON result.') + '\n' + stdout }; }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.type !== 'result') {
        return { success: false, text: t('Claude CLI 결과 형식을 확인할 수 없습니다.', 'Unrecognized Claude CLI result format.') + '\n' + stdout };
    }
    const denied = Array.isArray(result.permission_denials) && result.permission_denials.length > 0;
    const success = exitCode === 0 && result.subtype === 'success' && result.is_error === false && !denied;
    const text = typeof result.result === 'string' ? result.result : JSON.stringify(result, null, 2);
    const costUsd = typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : undefined;
    return { success, costUsd, text: denied ? t('허용되지 않은 도구 요청이 있어 작업을 완료로 처리하지 않았습니다.', 'The run requested tools without permission and was not marked complete.') + '\n' + text : text };
}

async function invokeClaude(job: ClaudeSchedule, prompt: Buffer, options: ClaudeCliOptions, signal: AbortSignal, kill: KillClaudeProcess,
    versionOnly = false): Promise<{ status: ClaudeRunResult['status']; text: string; costUsd?: number }> {
    if (signal.aborted) { return { status: 'stopped', text: t('실행을 중지했습니다.', 'Run stopped.') }; }
    if (!options.executable || /[\r\n\0]/.test(options.executable) || /\.(?:cmd|bat)$/i.test(options.executable)) {
        throw new Error(t('Claude 실행 파일 경로를 확인하세요. Windows에서는 네이티브 claude.exe를 사용하세요.', 'Check the Claude executable path. On Windows, use native claude.exe.'));
    }
    return new Promise(resolve => {
        let child: ChildProcess;
        let stdoutBytes = 0; let stderrBytes = 0;
        const stdout: Buffer[] = []; const stderr: Buffer[] = [];
        let reason: string | undefined;
        let termination: Promise<boolean> | undefined;
        let closed = false;
        let settled = false;
        let exitCode: number | null = null;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = async (): Promise<void> => {
            if (!closed || settled) { return; }
            settled = true;
            if (timeout) { clearTimeout(timeout); }
            signal.removeEventListener('abort', abort);
            await termination;
            const output = Buffer.concat(stdout).toString('utf8');
            const parsed = versionOnly ? { success: exitCode === 0, text: output } : parseClaudeResult(output, exitCode);
            const errors = Buffer.concat(stderr).toString('utf8');
            if (/unknown option|unrecognized option|unsupported option/i.test(errors)) {
                reason = t(`Claude Code CLI를 ${MIN_CLAUDE_CLI_VERSION} 이상으로 업데이트하세요. 필요한 옵션을 지원하지 않습니다.`,
                    `Update Claude Code CLI to ${MIN_CLAUDE_CLI_VERSION} or later. Required options are unsupported.`);
            }
            resolve({ status: signal.aborted ? 'stopped' : reason || !parsed.success ? 'failed' : 'success',
                costUsd: 'costUsd' in parsed ? parsed.costUsd : undefined,
                text: [reason, parsed.text, errors].filter(Boolean).join('\n\n') });
        };
        const terminate = (message: string): void => {
            reason ??= message;
            if (!termination) {
                termination = kill(child).catch(() => false);
                // Keep the workspace lease until close; a failed kill must not allow a second editor.
                void termination.then(() => finish());
            }
        };
        const abort = (): void => terminate(t('실행을 중지했습니다.', 'Run stopped.'));
        try {
            child = spawn(options.executable, versionOnly ? [...(options.prefixArgs ?? []), '--version'] : claudeArguments(job, options), {
                cwd: job.workspacePath, shell: false, detached: process.platform !== 'win32',
                windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) { resolve({ status: 'failed', text: String(error) }); return; }
        child.once('error', error => {
            reason = t(`Claude CLI를 시작하지 못했습니다: ${error.message}`, `Could not start Claude CLI: ${error.message}`);
        });
        child.once('close', code => { closed = true; exitCode = code; void finish(); });
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > outputLimit) { terminate(t('Claude 출력이 4MiB 한도를 초과했습니다.', 'Claude output exceeds the 4 MiB limit.')); }
            else { stdout.push(chunk); }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > errorLimit) { terminate(t('Claude 오류 출력이 256KiB 한도를 초과했습니다.', 'Claude error output exceeds the 256 KiB limit.')); }
            else { stderr.push(chunk); }
        });
        child.stdin?.on('error', error => { if (!closed) { terminate(t(`요청문 전달 실패: ${error.message}`, `Could not send the prompt: ${error.message}`)); } });
        signal.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => terminate(t('Claude 실행 시간이 제한을 초과했습니다.', 'Claude run exceeded its time limit.')), (versionOnly ? 10 : options.timeoutSeconds) * 1000);
        if (signal.aborted) { abort(); } else { child.stdin?.end(prompt); }
    });
}

export function supportsClaudeVersion(text: string): boolean {
    const version = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
    if (!version) { return false; }
    const actual = version.slice(1).map(Number);
    const minimum = MIN_CLAUDE_CLI_VERSION.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
        if (actual[index] !== minimum[index]) { return actual[index] > minimum[index]; }
    }
    return true;
}

export function claudeReportDirectory(storage: string, jobId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) { throw new Error(t('예약 ID가 잘못되었습니다.', 'Invalid schedule ID.')); }
    return path.join(storage, 'claude-scheduler', 'reports', jobId);
}
export async function readClaudeReport(storage: string, job: ClaudeSchedule): Promise<string> {
    if (!job.lastRun?.report || !/^[a-f0-9-]{36}\.txt$/.test(job.lastRun.report)) { throw new Error(t('실행 보고서가 없습니다.', 'No run report.')); }
    return (await boundedRead(path.join(claudeReportDirectory(storage, job.id), job.lastRun.report), outputLimit + errorLimit + 65536)).toString('utf8');
}

/** Bound disk use across removed jobs as well as active schedules. */
export async function pruneClaudeReports(storage: string, currentJobId: string, currentReport: string): Promise<void> {
    const root = path.join(storage, 'claude-scheduler', 'reports');
    const folders = await fs.readdir(root, { withFileTypes: true });
    const reports: Array<{ file: string; jobId: string; name: string; time: number; size: number }> = [];
    for (const folder of folders.filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))) {
        const directory = path.join(root, folder.name);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries.filter(file => file.isFile() && /^[a-f0-9-]{36}\.txt$/.test(file.name))) {
            const file = path.join(directory, entry.name);
            const stats = await fs.stat(file).catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
                throw error;
            });
            if (!stats) { continue; }
            reports.push({ file, jobId: folder.name, name: entry.name, time: stats.mtimeMs, size: stats.size });
        }
    }
    const counts = new Map<string, number>();
    let bytes = 0; let count = 0;
    // Preserve the report being attached to this run even if timestamps are equal.
    reports.sort((a, b) => Number(b.jobId === currentJobId && b.name === currentReport) - Number(a.jobId === currentJobId && a.name === currentReport) || b.time - a.time);
    for (const report of reports) {
        const jobCount = counts.get(report.jobId) ?? 0;
        if (jobCount >= 20 || count >= 100 || bytes + report.size > 64 * 1024 * 1024) {
            await fs.rm(report.file, { force: true });
        } else {
            counts.set(report.jobId, jobCount + 1); count++; bytes += report.size;
        }
    }
}

/** Workspace-wide lease also prevents two windows from running the same persisted slot. */
export async function runScheduledClaude(job: ClaudeSchedule, signal: AbortSignal, scheduledAt: number | undefined,
    storage: string, workspacePaths: readonly string[], options: ClaudeCliOptions, kill: KillClaudeProcess): Promise<ClaudeRunResult> {
    const startedAt = Date.now();
    let release: (() => Promise<void>) | undefined;
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { abort.abort(); }
    let text = ''; let status: ClaudeRunResult['status'] = 'failed'; let detail: string | undefined;
    try {
        const root = await fs.realpath(job.workspacePath);
        const openRoots = await Promise.all(workspacePaths.map(folder => fs.realpath(folder).catch(() => '')));
        if (!openRoots.some(folder => pathKey(folder) === pathKey(root))) {
            throw new Error(t('예약의 워크스페이스 폴더가 열려 있지 않습니다.', 'The schedule workspace folder is not open.'));
        }
        const promptPath = await fs.realpath(job.promptPath);
        if (!inside(root, promptPath)) { throw new Error(t('요청문 파일은 선택한 워크스페이스 안에 있어야 합니다.', 'The prompt file must be inside the selected workspace.')); }
        const prompt = await boundedRead(promptPath, promptLimit);
        if (!prompt.toString('utf8').replace(/^\uFEFF/, '').trim()) { throw new Error(t('요청문 파일이 비어 있습니다.', 'The prompt file is empty.')); }
        const lockDirectory = path.join(storage, 'claude-scheduler', 'locks', createHash('sha256').update(pathKey(root)).digest('hex'));
        await fs.mkdir(lockDirectory, { recursive: true });
        try {
            release = await lockfile.lock(lockDirectory, {
                realpath: false, retries: 0, stale: 120_000, update: 10_000,
                onCompromised: () => abort.abort(),
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ELOCKED') { return { status: 'skipped', startedAt, finishedAt: Date.now(), detail: t('다른 창에서 이 폴더를 실행 중입니다.', 'This folder is running in another window.') }; }
            throw error;
        }
        if (abort.signal.aborted) { return { status: 'stopped', startedAt, finishedAt: Date.now() }; }
        const probe = await invokeClaude({ ...job, workspacePath: root }, Buffer.alloc(0), options, abort.signal, kill, true);
        if (probe.status !== 'success') { status = probe.status; throw new Error(probe.text); }
        if (!supportsClaudeVersion(probe.text)) {
            throw new Error(t(`Claude Code CLI ${MIN_CLAUDE_CLI_VERSION} 이상이 필요합니다. CLI를 업데이트하세요.`,
                `Claude Code CLI ${MIN_CLAUDE_CLI_VERSION} or later is required. Update the CLI.`));
        }
        if (scheduledAt !== undefined) {
            const marker = path.join(lockDirectory, `${job.id}.json`);
            let previous = 0;
            try {
                previous = JSON.parse((await boundedRead(marker, 256)).toString('utf8'));
                if (!Number.isSafeInteger(previous) || previous < 0) { throw new Error(t('저장된 예약 실행 표지가 손상됐습니다.', 'Stored run marker is corrupt.')); }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            if (previous >= scheduledAt) { return { status: 'skipped', startedAt, finishedAt: Date.now(), detail: t('이 예약 시각은 다른 창에서 처리했습니다.', 'This scheduled slot was handled by another window.') }; }
            await fs.writeFile(marker, JSON.stringify(scheduledAt), { mode: 0o600 });
        }
        const reservation = await reserveClaudeBudget(lockDirectory, options.maxBudgetUsd, options.maxDailyRuns ?? 24, options.maxDailyBudgetUsd ?? 5);
        const result = await invokeClaude({ ...job, workspacePath: root }, prompt, options, abort.signal, kill);
        status = result.status; text = result.text;
        if (result.costUsd !== undefined) {
            try { await recordClaudeCost(lockDirectory, reservation, result.costUsd); }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(t(`Claude 비용 기록 실패: ${message}`, `Could not record Claude cost: ${message}`));
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        text = [text, message].filter(Boolean).join('\n\n');
        status = abort.signal.aborted ? 'stopped' : error instanceof ClaudeBudgetLimitError ? 'skipped' : 'failed';
        if (status === 'skipped') { detail = 'scheduler-budget'; }
    } finally {
        signal.removeEventListener('abort', onAbort);
        try { await release?.(); } catch { status = 'failed'; text += '\n' + t('워크스페이스 잠금 해제 실패.', 'Workspace lease release failed.'); }
    }
    const finishedAt = Date.now();
    const directory = claudeReportDirectory(storage, job.id);
    const report = `${randomUUID()}.txt`;
    await fs.mkdir(directory, { recursive: true });
    const statusLabel = status === 'success' ? t('완료', 'Completed') : status === 'stopped' ? t('중지', 'Stopped')
        : status === 'skipped' ? t('건너뜀', 'Skipped') : t('실패', 'Failed');
    await fs.writeFile(path.join(directory, report), [job.name, `${new Date(startedAt).toISOString()} → ${new Date(finishedAt).toISOString()}`, statusLabel, '', text].join('\n'), { flag: 'wx', mode: 0o600 });
    await pruneClaudeReports(storage, job.id, report);
    return { status, startedAt, finishedAt, report, ...(detail ? { detail } : {}) };
}
