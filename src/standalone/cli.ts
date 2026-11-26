import { createReadStream } from 'node:fs';
import { addAbortSignal } from 'node:stream';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Workspace } from './core';
import { TaskHubError } from './errors';
import { parseInputs } from './inputs';
import { t } from './language';

const usage = `taskhub <list | doctor [ACTION] | preview ACTION | run ACTION | history | logs RUN_ID | mcp>
  [--workspace DIR] [--actions FILE] [--preset FILE] [--json]
  run: [--trust] [--inputs-file FILE|-] [--non-interactive] [--capture-output]
  mcp: [--trust] [--capture-output]`;

async function readInputs(file: string | undefined, signal: AbortSignal) {
    if (!file) { return parseInputs({}); }
    try {
        const stream = file === '-' ? process.stdin : createReadStream(file);
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of addAbortSignal(signal, stream)) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 8 * 1024 * 1024) { throw new Error(); }
            chunks.push(buffer);
        }
        return parseInputs(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
    } catch {
        if (signal.aborted) { throw new TaskHubError(130, t('실행 취소', 'Cancelled')); }
        throw new TaskHubError(2, t('입력 파일에 8 MiB 이하의 JSON 객체가 필요합니다.', 'Expected a JSON input object of at most 8 MiB.'));
    }
}

async function main(argv: string[]): Promise<void> {
    let json = argv.includes('--json');
    let serving = argv.includes('mcp');
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        let args;
        try {
            args = parseArgs({ args: argv, allowPositionals: true, options: {
                workspace: { type: 'string', short: 'w' }, actions: { type: 'string' }, preset: { type: 'string' },
                json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, trust: { type: 'boolean' },
                'inputs-file': { type: 'string' }, 'non-interactive': { type: 'boolean' }, 'capture-output': { type: 'boolean' },
            } });
        } catch { throw new TaskHubError(2, usage); }
        const { values, positionals } = args;
        const [command, id] = positionals;
        serving = command === 'mcp';
        json = values.json === true;
        if (values.help) { process.stdout.write(usage + '\n'); return; }
        if (!['list', 'doctor', 'preview', 'run', 'history', 'logs', 'mcp'].includes(command) ||
            (command === 'doctor' ? positionals.length > 2 : positionals.length !== (['run', 'preview', 'logs'].includes(command) ? 2 : 1)) ||
            (values['inputs-file'] !== undefined && command !== 'run')) {
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
                display = [...findings.map(f => `${f.sourceLabel}:${f.range.startLine}:${f.range.startColumn} ${f.severity} ${t(f.messageKo ?? f.message, f.message)}`),
                    ...(validation?.issues ?? [])].join('\n') || t('문제가 없습니다.', 'No findings.');
                if (validation?.valid === false || findings.some(f => f.severity === 'error')) { process.exitCode = 2; }
                break;
            }
            case 'preview':
                result = workspace.preview(id);
                display = result.report;
                break;
            case 'run':
                workspace.requireTrust();
                result = await workspace.run(id, await readInputs(values['inputs-file'], abort.signal), abort.signal);
                process.exitCode = result.exitCode;
                display = [result.actionId, result.outcome, result.error, result.runId, result.warning].filter(Boolean).join('\n');
                break;
            case 'history': {
                const runs = await workspace.history();
                result = { runs };
                display = runs.map(run => `${new Date(run.startedAt).toISOString()}\t${run.outcome}\t${run.actionId}\t${run.runId}`).join('\n')
                    || t('실행 이력이 없습니다.', 'No run history.');
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
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
void main(process.argv.slice(2));
