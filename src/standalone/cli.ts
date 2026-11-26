import { parseArgs } from 'node:util';
import { TaskHubError, Workspace } from './core';
import { t } from './language';

const usage = 'taskhub <list | doctor | preview ACTION> [--workspace DIR] [--json]';

async function main(argv: string[]): Promise<void> {
    let json = argv.includes('--json');
    try {
        let args;
        try {
            args = parseArgs({ args: argv, allowPositionals: true, options: {
                workspace: { type: 'string', short: 'w' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
            } });
        } catch { throw new TaskHubError(2, usage); }
        const { values, positionals } = args;
        json = values.json === true;
        if (values.help) { process.stdout.write(usage + '\n'); return; }
        const [command, id] = positionals;
        if (!['list', 'doctor', 'preview'].includes(command) || positionals.length !== (command === 'preview' ? 2 : 1)) {
            throw new TaskHubError(2, usage);
        }
        const workspace = new Workspace(values.workspace ?? process.cwd());
        let result: unknown;
        let display: string;
        if (command === 'list') {
            const actions = workspace.list();
            result = { actions };
            display = actions.map(action => `${action.id}\t${action.title}`).join('\n') || t('등록된 액션이 없습니다.', 'No actions.');
        } else if (command === 'doctor') {
            const findings = workspace.doctor();
            result = { findings };
            display = findings.map(f => `${f.range.startLine}:${f.range.startColumn} ${f.severity} ${f.code} ${t(f.messageKo ?? f.message, f.message)}`).join('\n')
                || t('문제가 없습니다.', 'No findings.');
            if (findings.some(f => f.severity === 'error')) { process.exitCode = 2; }
        } else {
            const preview = workspace.preview(id);
            result = preview;
            display = preview.report;
        }
        process.stdout.write((json ? JSON.stringify(result) : display) + '\n');
    } catch (error) {
        const exitCode = error instanceof TaskHubError ? error.exitCode : 1;
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = exitCode;
        if (json) { process.stdout.write(JSON.stringify({ error: message, exitCode }) + '\n'); }
        else { process.stderr.write(message + '\n'); }
    }
}

void main(process.argv.slice(2));
