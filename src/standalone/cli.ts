import { createReadStream } from 'node:fs';
import { addAbortSignal } from 'node:stream';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Workspace } from './core';
import { TaskHubError } from './errors';
import { parseInputs, type Inputs } from './inputs';
import { t } from './language';

const usage = `taskhub <list | doctor [ACTION] | preview ACTION | run ACTION | history | logs RUN_ID | mcp>
  [--workspace DIR] [--actions FILE] [--preset FILE] [--json]
  run: [--trust] [--input TASK_ID=VALUE]... [--inputs-file FILE|-] [--non-interactive] [--capture-output]
  history: [--limit N]
  mcp: [--trust] [--capture-output]`;

/**
 * `--input TASK_ID=VALUE`를 입력 객체에 더한다. 같은 ID를 반복하면 배열이 되고(다중 선택),
 * 입력 파일의 같은 키보다 우선한다. 오류에 원문을 담지 않는다 — 값이 비밀번호일 수 있다.
 */
function applyInputPairs(base: Inputs, pairs: readonly string[] | undefined): Inputs {
    if (!pairs?.length) { return base; }
    const flags: Record<string, string | string[]> = Object.create(null);
    for (const pair of pairs) {
        const at = pair.indexOf('=');
        if (at <= 0) { throw new TaskHubError(2, t('--input은 TASK_ID=VALUE 형식이어야 합니다.', '--input must be TASK_ID=VALUE.')); }
        const key = pair.slice(0, at);
        const previous = flags[key];
        flags[key] = previous === undefined ? pair.slice(at + 1) : [previous].flat().concat(pair.slice(at + 1));
    }
    return parseInputs(Object.assign(Object.create(null), base, flags));
}

function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined) { return undefined; }
    if (!/^[1-9]\d{0,5}$/.test(value)) { throw new TaskHubError(2, t('--limit에는 1 이상의 정수가 필요합니다.', '--limit requires a positive integer.')); }
    return Number(value);
}

/** The human-readable result of `run`: labeled lines that stand out after live command output. */
function formatRunSummary(result: { actionId: string; outcome: string; error?: string; runId: string | null; warning?: string;
    skipped: { taskId: string; reason: string }[]; continued: { taskId: string; error: string }[] }): string {
    const cancelled = result.outcome === 'cancelled';
    const outcome = result.outcome === 'success' ? t('성공', 'success') : cancelled ? t('취소됨', 'cancelled') : t('실패', 'failure');
    return [
        `== ${result.actionId}: ${outcome} ==`,
        ...result.continued.map(entry => t(`실패 후 계속: ${entry.taskId} — ${entry.error}`, `Continued after failure: ${entry.taskId} — ${entry.error}`)),
        ...result.skipped.map(entry => t(`건너뜀: ${entry.taskId} — ${entry.reason}`, `Skipped: ${entry.taskId} — ${entry.reason}`)),
        // The heading already says the run was cancelled.
        !cancelled && result.error && t(`오류: ${result.error}`, `Error: ${result.error}`),
        result.runId && t(`실행 로그: ${result.runId}`, `Run log: ${result.runId}`),
        result.warning && t(`경고: ${result.warning}`, `Warning: ${result.warning}`),
    ].filter(Boolean).join('\n');
}

async function readInputs(file: string | undefined, signal: AbortSignal) {
    if (!file) { return parseInputs({}); }
    const chunks: Buffer[] = [];
    try {
        const stream = file === '-' ? process.stdin : createReadStream(file);
        let bytes = 0;
        for await (const chunk of addAbortSignal(signal, stream)) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 8 * 1024 * 1024) {
                throw new TaskHubError(2, t('입력 데이터가 8 MiB를 초과합니다.', 'Input data exceeds 8 MiB.'));
            }
            chunks.push(buffer);
        }
    } catch (error) {
        if (signal.aborted) { throw new TaskHubError(130, t('실행 취소', 'Cancelled')); }
        if (error instanceof TaskHubError) { throw error; }
        throw new TaskHubError(2, t('입력 데이터를 읽을 수 없습니다.', 'Cannot read input data.'));
    }
    let value: unknown;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new TaskHubError(2, t('입력 데이터가 올바른 JSON이 아닙니다.', 'Input data is not valid JSON.'));
    }
    return parseInputs(value);
}

async function main(argv: string[]): Promise<void> {
    let json = argv.includes('--json');
    let serving = argv.includes('mcp');
    const abort = new AbortController();
    const stop = () => abort.abort();
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    if (process.platform !== 'win32') { signals.push('SIGHUP'); }
    for (const signal of signals) { process.on(signal, stop); }
    try {
        let args;
        try {
            args = parseArgs({ args: argv, allowPositionals: true, options: {
                workspace: { type: 'string', short: 'w' }, actions: { type: 'string' }, preset: { type: 'string' },
                json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, trust: { type: 'boolean' },
                'inputs-file': { type: 'string' }, input: { type: 'string', multiple: true }, limit: { type: 'string' },
                'non-interactive': { type: 'boolean' }, 'capture-output': { type: 'boolean' },
            } });
        } catch { throw new TaskHubError(2, usage); }
        const { values, positionals } = args;
        const [command, id] = positionals;
        serving = command === 'mcp';
        json = values.json === true;
        if (values.help) { process.stdout.write(usage + '\n'); return; }
        if (!['list', 'doctor', 'preview', 'run', 'history', 'logs', 'mcp'].includes(command) ||
            (command === 'doctor' ? positionals.length > 2 : positionals.length !== (['run', 'preview', 'logs'].includes(command) ? 2 : 1)) ||
            ((values['inputs-file'] !== undefined || values.input !== undefined) && command !== 'run') ||
            (values.limit !== undefined && command !== 'history')) {
            throw new TaskHubError(2, usage);
        }
        const workspace = new Workspace(values.workspace ?? process.cwd(), { trusted: values.trust, actionsFile: values.actions,
            preset: values.preset, captureOutput: values['capture-output'] });
        let result;
        let display: string | undefined;
        switch (command) {
            case 'list': {
                const actions = workspace.list();
                result = { actions };
                display = actions.map(action => `${action.id}\t${action.title}`).join('\n') || t('등록된 액션이 없습니다.', 'No actions.');
                break;
            }
            case 'doctor': {
                const validation = id === undefined ? undefined : workspace.validate(id);
                const findings = validation?.findings ?? workspace.doctor();
                result = validation ?? { findings };
                // Execution constraints (or why the whole file is shown) come first, before the findings they explain.
                display = [...(validation?.issues ?? []),
                    ...findings.map(f => `${f.sourceLabel}:${f.range.startLine}:${f.range.startColumn} ${f.severity} ${t(f.messageKo ?? f.message, f.message)}`)]
                    .join('\n') || t('문제가 없습니다.', 'No findings.');
                if (validation?.valid === false || findings.some(f => f.severity === 'error')) { process.exitCode = 2; }
                break;
            }
            case 'preview':
                result = workspace.preview(id);
                display = result.report;
                break;
            case 'run':
                workspace.requireTrust();
                // Command output is shown live as in the extension's terminal; `--json` keeps stdout to one JSON document.
                // A reader that closes early (`| head`, a stopped pager) must not crash the run mid-way:
                // the command would keep running detached and no run log would be written.
                const closed = new Set<NodeJS.WriteStream>();
                for (const stream of [process.stdout, process.stderr]) { stream.on('error', () => { closed.add(stream); }); }
                // Each line carries its task, on the stream it was printed to, so interleaved parallel output
                // and separately saved stdout/stderr both keep their origin (as docker compose does).
                const atLineStart = new Map<NodeJS.WriteStream, boolean>([[process.stdout, true], [process.stderr, true]]);
                const lastTask = new Map<NodeJS.WriteStream, string>();
                const endsLine = new Map<NodeJS.WriteStream, boolean>([[process.stdout, true], [process.stderr, true]]);
                const endsWithReturn = new Map<NodeJS.WriteStream, boolean>();
                const write = (stream: NodeJS.WriteStream, text: string) => {
                    if (closed.has(stream) || !text) { return; }
                    stream.write(text);
                    atLineStart.set(stream, /[\r\n]$/.test(text));
                    endsLine.set(stream, text.endsWith('\n'));
                    endsWithReturn.set(stream, text.endsWith('\r'));
                };
                result = await workspace.run(id, applyInputPairs(await readInputs(values['inputs-file'], abort.signal), values.input), abort.signal,
                    json ? undefined : (text, stream, taskId) => {
                        const target = stream === 'stdout' ? process.stdout : process.stderr;
                        const prefix = `[${taskId}] `;
                        // Another task's unfinished line ends here, so this task's output starts on a line of its own.
                        if (!atLineStart.get(target) && lastTask.get(target) !== taskId) { write(target, '\n'); }
                        lastTask.set(target, taskId);
                        // A carriage return starts a redrawn progress line, which keeps its prefix too. A `\n`
                        // arriving right after a released `\r` only ends that line and gets no prefix of its own.
                        const continuesLine = endsWithReturn.get(target) === true && text.startsWith('\n');
                        const lines = text.split(/(?<=\n|\r(?!\n))/);
                        write(target, lines.map((line, index) =>
                            index === 0 && (continuesLine || !atLineStart.get(target)) ? line : prefix + line).join(''));
                    });
                // Close lines left open on either stream so the summary starts on its own line.
                // A progress line ended by `\r` is kept rather than overwritten by the summary.
                for (const stream of [process.stdout, process.stderr]) {
                    if (!endsLine.get(stream)) { write(stream, '\n'); }
                }
                process.exitCode = result.exitCode;
                display = formatRunSummary(result);
                break;
            case 'history': {
                result = await workspace.history(parseLimit(values.limit));
                const { runs, skippedLogs } = result;
                display = runs.map(run => `${new Date(run.startedAt).toISOString()}\t${run.outcome}\t${run.actionId}\t${run.runId}`).join('\n')
                    || t('실행 이력이 없습니다.', 'No run history.');
                if (!json && skippedLogs) {
                    process.stderr.write(t(
                        `읽을 수 없는 실행 로그 ${skippedLogs}개를 건너뛰었습니다.\n`,
                        `Skipped ${skippedLogs} unreadable, invalid or oversized run log entries.\n`
                    ));
                }
                break;
            }
            case 'logs':
                result = await workspace.log(id);
                break;
            case 'mcp': {
                const { serve } = require('./mcp.mjs') as typeof import('./mcp.mjs', { with: { 'resolution-mode': 'import' } });
                const { version } = require(path.join(workspace.extensionPath, 'package.json')) as { version: string };
                await serve(workspace, abort.signal, version);
                return;
            }
        }
        process.stdout.write((json ? JSON.stringify(result) : display ?? JSON.stringify(result, null, 2)) + '\n');
    } catch (error) {
        const exitCode = error instanceof TaskHubError ? error.exitCode : 1;
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = exitCode;
        if (json && !serving) { process.stdout.write(JSON.stringify({ error: message, exitCode }) + '\n'); }
        else { process.stderr.write(message + '\n'); }
    } finally {
        for (const signal of signals) { process.off(signal, stop); }
    }
}
void main(process.argv.slice(2));
