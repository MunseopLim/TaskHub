import { spawn, ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { t } from '../i18n';
import { AiRunResult, AiSchedule } from './model';
import { legacyAiScheduler } from './compatibility';

const promptLimit = 256 * 1024;
const outputLimit = 4 * 1024 * 1024;
const errorLimit = 256 * 1024;
// Include input snapshots and UTF-8 replacement characters in diagnostic reports.
const reportLimit = 16 * 1024 * 1024;
export const MIN_SUPPORTED_CLI_VERSION = '2.1.248';
export interface AiCliOptions {
    executable: string;
    model?: string;
    timeoutSeconds: number;
    /** Test fixtures can prepend a Node script without enabling arbitrary shell text. */
    prefixArgs?: readonly string[];
}
export type KillCliProcess = (child: ChildProcess) => Promise<boolean>;

interface CliInvocation {
    phase: 'version' | 'prompt';
    executable: string;
    args: string[];
    cwd: string;
    started: boolean;
    stdinStatus: 'notSent' | 'writing' | 'written' | 'failed';
    stdinBytes: number;
    stdinText?: string;
}

/** A display command for POSIX shells or PowerShell; the runner itself never uses a shell. */
export function formatCliCommand(executable: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
    const quote = (value: string): string => platform === 'win32'
        ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
    return (platform === 'win32' ? '& ' : '') + [executable, ...args].map(quote).join(' ');
}

function invocationDetails(invocations: CliInvocation[]): string {
    if (!invocations.length) {
        return t('CLI는 시작되지 않았고 요청문도 전송되지 않았습니다.', 'The CLI was not started and the prompt was not sent.');
    }
    const lines = [t('실행 상세', 'Execution details'), t(
        '요청문은 명령 인자가 아니라 stdin 파이프에 UTF-8로 씁니다. 아래 명령은 표시용이며 실제 실행은 shell: false입니다.',
        'The prompt is written to the stdin pipe as UTF-8, rather than passed as an argument. Commands below are for display; actual execution uses shell: false.'
    )];
    const inputStates = {
        notSent: t('전송하지 않음', 'Not sent'), writing: t('기록 중 종료됨 — 일부만 전달됐을 수 있음', 'Closed during writing — delivery may be partial'),
        written: t('stdin 파이프에 기록 완료', 'Written to the stdin pipe'), failed: t('전송 실패 — 일부만 전달됐을 수 있음', 'Delivery failed — may be partial'),
    };
    for (const invocation of invocations) {
        lines.push('', invocation.phase === 'version' ? t('버전 확인', 'Version check') : t('요청문 실행', 'Prompt execution'),
            process.platform === 'win32' ? t('명령 (PowerShell 표기):', 'Command (PowerShell syntax):') : t('명령 (POSIX 셸 표기):', 'Command (POSIX shell syntax):'),
            formatCliCommand(invocation.executable, invocation.args),
            t(`작업 폴더: ${invocation.cwd}`, `Working directory: ${invocation.cwd}`),
            invocation.started ? t('CLI 시작됨', 'CLI started') : t('CLI 시작되지 않음', 'CLI not started'),
            t(`stdin: ${inputStates[invocation.stdinStatus]} (${invocation.stdinBytes}바이트)`, `stdin: ${inputStates[invocation.stdinStatus]} (${invocation.stdinBytes} bytes)`));
        if (invocation.phase === 'prompt' && invocation.stdinText !== undefined) {
            lines.push(t('이 실행에서 stdin에 쓴 요청문 (UTF-8):', 'Prompt used for this stdin write (UTF-8):'), invocation.stdinText);
        }
    }
    lines.push('', t('실행 인자와 전송 상태 (JSON)', 'Invocation arguments and delivery status (JSON)'), '',
        JSON.stringify(invocations.map(invocation => ({ phase: invocation.phase, executable: invocation.executable,
            args: invocation.args, cwd: invocation.cwd, shell: false, started: invocation.started,
            stdinStatus: invocation.stdinStatus, stdinBytes: invocation.stdinBytes })), null, 4));
    return lines.join('\n');
}

/** A non-string result is re-indented and can outgrow the read limit; keep the head and every execution detail. */
function boundReportText(text: string, budget: number): string {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= budget) { return text; }
    const note = t(`\n\n[보고서 크기 한도를 넘어 결과 ${bytes.length}바이트 중 앞부분만 보관했습니다.]`,
        `\n\n[The result exceeded the report size limit; kept only the beginning of ${bytes.length} bytes.]`);
    if (budget < Buffer.byteLength(note, 'utf8') + 4) { return ''; }
    // A cut multibyte character decodes to one U+FFFD, at most 2 bytes longer than the cut.
    return bytes.subarray(0, budget - Buffer.byteLength(note, 'utf8') - 4).toString('utf8') + note;
}

export function aiCliArguments(job: AiSchedule, options: AiCliOptions): string[] {
    const bash = job.mode === 'edit' ? job.bashRules ?? [] : [];
    const tools = job.mode === 'edit' ? `Read,Glob,Grep,Edit,Write${bash.length ? ',Bash' : ''}` : 'Read,Glob,Grep';
    const allowed = ['Read(./**)', 'Glob', 'Grep', ...(job.mode === 'edit' ? ['Edit(./**)', ...bash] : [])];
    // Edit path rules also cover Write. Scoped Write rules are not consulted by Claude.
    const denied = ['mcp__*', ...['.git', '.claude', '.vscode'].flatMap(folder =>
        [`Edit(${folder})`, `Edit(${folder}/**)`, `Edit(**/${folder})`, `Edit(**/${folder}/**)`])];
    return [...(options.prefixArgs ?? []), '-p', '--restricted', '--output-format', 'json', '--permission-mode', 'dontAsk',
        '--tools', tools, '--allowedTools', ...allowed, '--disallowedTools', ...denied, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-session-persistence', ...(options.model ? ['--model', options.model] : [])];
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

/** The JSON result distinguishes CLI failures and permission denials from a completed answer. */
export function parseCliResult(stdout: string, exitCode: number | null): { success: boolean; text: string } {
    let result: Record<string, unknown>;
    try { result = JSON.parse(stdout); }
    catch { return { success: false, text: t('CLI가 올바른 JSON 결과를 반환하지 않았습니다.', 'The CLI did not return a valid JSON result.') + '\n' + stdout }; }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.type !== 'result') {
        return { success: false, text: t('CLI가 현재 실행기의 결과 형식(type: result)을 반환하지 않았습니다.', 'The CLI did not return the current runner\'s result format (type: result).') + '\n' + stdout };
    }
    const denied = Array.isArray(result.permission_denials) && result.permission_denials.length > 0;
    const success = exitCode === 0 && result.subtype === 'success' && result.is_error === false && !denied;
    let text = typeof result.result === 'string' ? result.result : stdout;
    if (typeof result.result !== 'string') {
        // Valid JSON can be too deeply nested to stringify; keep the original bounded output.
        try { text = JSON.stringify(result, null, 2); }
        catch { /* Original JSON remains readable and the run can complete. */ }
    }
    return { success, text: denied ? t('허용되지 않은 도구 요청이 있어 작업을 완료로 처리하지 않았습니다.', 'The run requested tools without permission and was not marked complete.') + '\n' + text : text };
}

async function invokeCli(job: AiSchedule, prompt: Buffer, options: AiCliOptions, signal: AbortSignal, kill: KillCliProcess,
    invocations: CliInvocation[], versionOnly = false): Promise<{ status: AiRunResult['status']; text: string }> {
    if (signal.aborted) { return { status: 'stopped', text: t('실행을 중지했습니다.', 'Run stopped.') }; }
    if (!options.executable || /[\r\n\0]/.test(options.executable) || /\.(?:cmd|bat)$/i.test(options.executable)) {
        throw new Error(t('CLI 실행 파일 경로를 확인하세요. Windows에서는 네이티브 실행 파일을 사용하세요.', 'Check the CLI executable path. On Windows, use a native executable.'));
    }
    const invocation: CliInvocation = { phase: versionOnly ? 'version' : 'prompt', executable: options.executable,
        args: versionOnly ? [...(options.prefixArgs ?? []), '--version'] : aiCliArguments(job, options), cwd: job.workspacePath,
        started: false, stdinStatus: 'notSent', stdinBytes: 0 };
    invocations.push(invocation);
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
            const parsed = versionOnly ? { success: exitCode === 0, text: output } : parseCliResult(output, exitCode);
            const errors = Buffer.concat(stderr).toString('utf8');
            if (/unknown option|unrecognized option|unsupported option/i.test(errors)) {
                reason = t(`선택한 CLI '${options.executable}'가 현재 실행기에 필요한 옵션을 지원하지 않습니다. CLI의 비대화형 실행·권한·결과 형식 호환성을 확인하세요.`,
                    `The selected CLI '${options.executable}' does not support options required by this runner. Check its non-interactive execution, permissions, and result format compatibility.`);
            }
            resolve({ status: signal.aborted ? 'stopped' : reason || !parsed.success ? 'failed' : 'success',
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
            child = spawn(invocation.executable, invocation.args, {
                cwd: invocation.cwd, shell: false, detached: process.platform !== 'win32',
                windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) { resolve({ status: 'failed', text: String(error) }); return; }
        child.once('spawn', () => {
            invocation.started = true;
            if (!signal.aborted && child.stdin) {
                invocation.stdinStatus = 'writing'; invocation.stdinBytes = prompt.length;
                invocation.stdinText = prompt.toString('utf8');
                child.stdin.end(prompt);
            }
        });
        child.once('error', error => {
            reason = t(`CLI '${options.executable}'를 시작하지 못했습니다: ${error.message}`, `Could not start CLI '${options.executable}': ${error.message}`);
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                reason += '\n' + t(
                    '실행 파일 또는 작업 폴더를 찾을 수 없습니다. 사용자 설정의 taskhub.aiScheduler.executable에 설치된 CLI의 절대 경로를 지정하고 작업 폴더가 존재하는지 확인하세요. 실행 파일 이름만 지정하면 VS Code 확장 호스트의 PATH에서 찾습니다.',
                    'The executable or working folder could not be found. Set taskhub.aiScheduler.executable in User settings to the installed CLI\'s absolute path and check that the working folder exists. A bare executable name is resolved using the VS Code extension host\'s PATH.'
                );
                if (versionOnly) {
                    reason += '\n' + t('버전 확인을 시작하지 못했으며 요청문은 아직 전달하지 않았습니다.', 'The version check could not start; the prompt has not been sent.');
                }
            }
        });
        child.once('close', code => { closed = true; exitCode = code; void finish(); });
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > outputLimit) { terminate(t('CLI 출력이 4MiB 한도를 초과했습니다.', 'CLI output exceeds the 4 MiB limit.')); }
            else { stdout.push(chunk); }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > errorLimit) { terminate(t('CLI 오류 출력이 256KiB 한도를 초과했습니다.', 'CLI error output exceeds the 256 KiB limit.')); }
            else { stderr.push(chunk); }
        });
        child.stdin?.on('error', error => {
            if (invocation.started) { invocation.stdinStatus = 'failed'; }
            if (!closed) { terminate(t(`요청문 전달 실패: ${error.message}`, `Could not send the prompt: ${error.message}`)); }
        });
        child.stdin?.once('finish', () => { if (invocation.stdinStatus === 'writing') { invocation.stdinStatus = 'written'; } });
        signal.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => terminate(t('CLI 실행 시간이 제한을 초과했습니다.', 'CLI run exceeded its time limit.')), (versionOnly ? 10 : options.timeoutSeconds) * 1000);
        if (signal.aborted) { abort(); }
    });
}

export function supportsCliVersion(text: string): boolean {
    const version = text.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
    if (!version) { return false; }
    const actual = version.slice(1).map(Number);
    const minimum = MIN_SUPPORTED_CLI_VERSION.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
        if (actual[index] !== minimum[index]) { return actual[index] > minimum[index]; }
    }
    return true;
}

export function aiReportDirectory(storage: string, jobId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) { throw new Error(t('예약 ID가 잘못되었습니다.', 'Invalid schedule ID.')); }
    return path.join(storage, 'ai-scheduler', 'reports', jobId);
}
/** Retain the shared lease namespace so an older window cannot run alongside an upgraded one. */
export function aiWorkspaceLeaseDirectory(storage: string, workspacePath: string): string {
    return path.join(storage, legacyAiScheduler.storageDirectory, 'locks', createHash('sha256').update(pathKey(workspacePath)).digest('hex'));
}
export async function readAiReport(storage: string, job: AiSchedule): Promise<string> {
    if (!job.lastRun?.report || !/^[a-f0-9-]{36}\.txt$/.test(job.lastRun.report)) { throw new Error(t('실행 보고서가 없습니다.', 'No run report.')); }
    const directory = aiReportDirectory(storage, job.id);
    try { return (await boundedRead(path.join(directory, job.lastRun.report), reportLimit)).toString('utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        return (await boundedRead(path.join(storage, legacyAiScheduler.storageDirectory, 'reports', job.id, job.lastRun.report), reportLimit)).toString('utf8');
    }
}

/** Bound disk use across removed jobs as well as active schedules. */
export async function pruneAiReports(storage: string, currentJobId: string, currentReport: string): Promise<void> {
    const reports: Array<{ file: string; jobId: string; name: string; time: number; size: number }> = [];
    for (const storageDirectory of ['ai-scheduler', legacyAiScheduler.storageDirectory]) {
        const root = path.join(storage, storageDirectory, 'reports');
        const folders = await fs.readdir(root, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
            throw error;
        });
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
export async function runScheduledAi(job: AiSchedule, signal: AbortSignal, scheduledAt: number | undefined,
    storage: string, workspacePaths: readonly string[], options: AiCliOptions, kill: KillCliProcess): Promise<AiRunResult> {
    const startedAt = Date.now();
    let release: (() => Promise<void>) | undefined;
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { abort.abort(); }
    let text = ''; let status: AiRunResult['status'] = 'failed';
    const invocations: CliInvocation[] = [];
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
        const lockDirectory = aiWorkspaceLeaseDirectory(storage, root);
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
        const probe = await invokeCli({ ...job, workspacePath: root }, Buffer.alloc(0), options, abort.signal, kill, invocations, true);
        if (probe.status !== 'success') { status = probe.status; throw new Error(probe.text); }
        if (!supportsCliVersion(probe.text)) {
            const observed = probe.text.trim().slice(0, 1000);
            throw new Error(t(
                `CLI '${options.executable}'의 --version 응답을 현재 실행기로 확인할 수 없습니다. 현재 실행기는 Claude Code ${MIN_SUPPORTED_CLI_VERSION} 이상을 기준으로 합니다. 실행 파일만 바꿔도 다른 CLI를 지원하는 것은 아니며, 해당 CLI의 실행 옵션과 결과 형식이 호환되어야 합니다. 요청문은 아직 전달하지 않았습니다.\n버전 응답: ${observed}`,
                `The --version response from CLI '${options.executable}' did not pass this runner's check. The current runner targets Claude Code ${MIN_SUPPORTED_CLI_VERSION} or later. Changing the executable alone does not add another CLI's execution options and result format. The prompt has not been sent.\nVersion response: ${observed}`
            ));
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
        const result = await invokeCli({ ...job, workspacePath: root }, prompt, options, abort.signal, kill, invocations);
        status = result.status; text = result.text;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        text = [text, message].filter(Boolean).join('\n\n');
        status = abort.signal.aborted ? 'stopped' : 'failed';
    } finally {
        signal.removeEventListener('abort', onAbort);
        try { await release?.(); } catch { status = 'failed'; text += '\n' + t('워크스페이스 잠금 해제 실패.', 'Workspace lease release failed.'); }
    }
    const finishedAt = Date.now();
    const directory = aiReportDirectory(storage, job.id);
    const report = `${randomUUID()}.txt`;
    await fs.mkdir(directory, { recursive: true });
    const statusLabel = status === 'success' ? t('완료', 'Completed') : status === 'stopped' ? t('중지', 'Stopped')
        : status === 'skipped' ? t('건너뜀', 'Skipped') : t('실패', 'Failed');
    const header = [job.name, `${new Date(startedAt).toISOString()} → ${new Date(finishedAt).toISOString()}`, statusLabel, ''].join('\n');
    const details = invocationDetails(invocations);
    const budget = reportLimit - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(details, 'utf8') - 3;
    await fs.writeFile(path.join(directory, report), [header, boundReportText(text, budget), '', details].join('\n'), { flag: 'wx', mode: 0o600 });
    await pruneAiReports(storage, job.id, report);
    return { status, startedAt, finishedAt, report };
}
