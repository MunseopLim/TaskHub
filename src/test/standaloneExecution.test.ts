import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { listActionRunHistory, RUN_LOG_MAX_FILE_BYTES } from '../runLogStore';
import { Workspace } from '../standalone/core';
import { parseInputs } from '../standalone/inputs';
import { launchPlan } from '../standalone/process';
import { executionIssues } from '../standalone/runner';
import type { Task } from '../schema';

const cli = process.env.TASKHUB_TEST_CLI ?? path.resolve(__dirname, '../../bin/taskhub.cjs');
const arg = '두 단어 & $NAME | >';
const secret = 'synthetic-private-input';
const env = { ...process.env, LC_ALL: 'en' };
const pipeline: Task[] = [
    { id: 'slot', type: 'quickPick', items: [{ id: 'debug', label: 'Debug', value: ['--debug', arg] }] },
    { id: 'probe', type: 'command', command: 'node', args: ['probe.cjs', '${slot}'], passTheResultToNextTask: true },
    { id: 'save', type: 'writeFile', path: 'result', content: '${probe.output}' },
];

function action(id: string, tasks: Task[]) { return { id, title: id, action: { description: id, tasks } }; }

async function until(test: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 12_000;
    while (!await test()) {
        if (Date.now() >= deadline) { assert.fail('Timed out waiting for observed state'); }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

suite('Standalone Core, CLI and stdio MCP', function () {
    this.timeout(30_000);
    let root: string;
    let config: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub standalone 한글 '));
        fs.mkdirSync(path.join(root, '.vscode'));
        config = path.join(root, '.vscode/actions.json');
        fs.writeFileSync(config, JSON.stringify([action('build', pipeline)]));
        fs.writeFileSync(path.join(root, 'probe.cjs'), "console.error('diagnostic'); console.log(JSON.stringify(process.argv.slice(2)));");
    });
    teardown(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

    function invoke(args: string[], inputs?: object, extraEnv?: NodeJS.ProcessEnv) {
        const result = spawnSync('node', [cli, ...args, ...(inputs ? ['--inputs-file', '-'] : []), '--workspace', root, '--json'],
            { encoding: 'utf8', input: inputs && JSON.stringify(inputs), timeout: 15_000, env: { ...env, ...extraEnv } });
        assert.ifError(result.error);
        assert.equal(result.stderr, '');
        return { code: result.status, data: JSON.parse(result.stdout), stdout: result.stdout };
    }

    function mcp(...args: string[]) {
        const child = spawn('node', [cli, 'mcp', '--workspace', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env });
        const closed = once(child, 'close');
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        const send = (method: string, params?: object, id?: number) =>
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
        let seq = 0;
        const response = async (id: number) => {
            const line = await lines.next();
            assert.equal(line.done, false, 'Server closed unexpectedly');
            const message = JSON.parse(line.value!);
            assert.equal(message.jsonrpc, '2.0');
            assert.equal(message.id, id);
            return message;
        };
        const request = async (method: string, params?: object) => {
            const id = ++seq;
            send(method, params, id);
            return await response(id);
        };
        return { child, send, request, closed,
            async init() {
                const reply = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tests', version: '1' } });
                assert.equal(reply.result.protocolVersion, '2025-11-25');
                assert.ok(reply.result.capabilities.tools);
                send('notifications/initialized');
            },
            async call(name: string, args: object = {}) {
                const reply = await request('tools/call', { name, arguments: args });
                assert.ok(reply.result, JSON.stringify(reply.error));
                return { error: reply.result.isError, data: JSON.parse(reply.result.content[0].text) };
            },
            async close() {
                child.stdin.end();
                assert.deepEqual(await closed, [0, null]);
                assert.equal((await lines.next()).done, true, 'Unexpected trailing stdout');
            },
        };
    }

    test('validates input shapes, graph constraints and Windows/POSIX argv boundaries', () => {
        for (const value of [null, [], 1, { key: { value: secret } }, { key: [true] }]) { assert.throws(() => parseInputs(value)); }
        assert.equal(Object.getPrototypeOf(parseInputs(JSON.parse('{"__proto__":"safe"}'))), null);
        const tasks: Task[] = [{ id: 'bad', type: 'command', command: 'node', dependsOn: ['absent'] }];
        assert.ok(executionIssues(tasks).length);
        assert.deepEqual(launchPlan(false, 'node', ['probe.cjs', arg], root, {}, 'linux'), { executable: 'node', args: ['probe.cjs', arg] });
        const winFolder = 'C:\\tools';
        const plan = launchPlan(false, 'node', ['probe.cjs', arg], winFolder, { PATH: winFolder }, 'win32',
            file => file === path.win32.join(winFolder, 'node.exe'));
        assert.deepEqual(plan.args, ['probe.cjs', arg]);
    });

    test('trust and required inputs are checked before starting unconditional work', () => {
        fs.writeFileSync(config, JSON.stringify([action('build', [
            { id: 'marker', type: 'writeFile', path: 'started', content: 'yes' }, ...pipeline,
        ])]));
        assert.equal(invoke(['run', 'build']).code, 3);
        assert.equal(invoke(['run', 'build', '--trust']).code, 2);
        assert.equal(invoke(['run', 'build', '--trust'], { typo: true }).code, 2);
        assert.equal(fs.existsSync(path.join(root, 'started')), false);
        assert.equal(fs.existsSync(path.join(root, '.taskhub')), false);
        assert.equal(invoke(['logs', '../.vscode/actions.json']).code, 2);
    });

    test('reads a standalone preset with workspace precedence; rejects UI-dependent tasks before side effects', () => {
        fs.writeFileSync(path.join(root, 'preset.json'), JSON.stringify([action('build', []), action('extra', [])]));
        assert.deepEqual(invoke(['list', '--preset', 'preset.json']).data.actions.map((x: { id: string }) => x.id), ['build', 'extra']);
        assert.match(invoke(['preview', 'build', '--preset', 'preset.json']).data.report, /probe/);
        fs.writeFileSync(config, JSON.stringify([action('ui', [
            { id: 'write', type: 'writeFile', path: 'marker', content: '' }, { id: 'open', type: 'browser', url: 'page.html' },
        ])]));
        assert.equal(invoke(['doctor', 'ui']).data.valid, false);
        assert.equal(invoke(['run', 'ui', '--trust']).code, 2);
        assert.equal(fs.existsSync(path.join(root, 'marker')), false);
    });

    test('resolves explicit actions and preset-only workspaces for both clients', async () => {
        const custom = '사내 actions.json';
        fs.renameSync(config, path.join(root, custom));
        assert.equal(invoke(['list']).code, 2);
        const expected = invoke(['list', '--actions', custom]);
        assert.equal(expected.code, 0);
        assert.equal(expected.data.actions[0].id, 'build');
        assert.deepEqual(invoke(['list', '--preset', path.join(root, custom)]).data, expected.data);
        assert.equal(invoke(['list', '--actions', 'absent.json', '--preset', custom]).code, 2);
        const client = mcp('--actions', custom);
        try {
            await client.init();
            assert.deepEqual((await client.call('list_actions')).data, expected.data);
        } finally { await client.close(); }
    });

    test('reads BOM and 8 MiB input files and rejects unreadable, malformed and oversized files before execution', () => {
        const file = path.join(root, '빌드 입력.json');
        const args = ['run', 'build', '--trust', '--non-interactive', '--inputs-file', file];
        const limit = 8 * 1024 * 1024;
        const valid = JSON.stringify({ slot: 'debug' });
        const missing = invoke(args);
        assert.equal(missing.code, 2);
        assert.match(missing.data.error, /Cannot read input data/);
        assert.ok(!missing.data.error.includes(file));
        // The oversized file is otherwise valid, so only the size limit can reject it.
        for (const [content, message] of [
            ['{', /not valid JSON/],
            ['{"slot":123}', /Inputs must map task IDs/],
            [valid + ' '.repeat(limit + 1 - valid.length), /exceeds 8 MiB/],
        ] as const) {
            fs.writeFileSync(file, content);
            const result = invoke(args);
            assert.equal(result.code, 2);
            assert.match(result.data.error, message);
        }
        assert.equal(fs.existsSync(path.join(root, '.taskhub')), false);
        fs.writeFileSync(file, valid + ' '.repeat(limit - valid.length));
        assert.equal(invoke(args).code, 0);
        fs.writeFileSync(file, '\uFEFF' + valid);
        assert.equal(invoke(args).code, 0);
        assert.equal(fs.readFileSync(path.join(root, 'result'), 'utf8'), JSON.stringify(['--debug', arg]));
    });

    test('ignores invalid validation regex syntax and still rejects input that fails a valid pattern', async () => {
        const input = { id: 'name', type: 'inputBox', validatePattern: '[' } as const;
        const write: Task = { id: 'save', type: 'writeFile', path: 'chosen', content: '${name.value}' };
        fs.writeFileSync(config, JSON.stringify([action('validate', [input, write])]));
        const params = { actionId: 'validate', inputs: { name: 'alpha' } };
        assert.equal(invoke(['run', 'validate', '--trust'], params.inputs).code, 0);
        assert.equal(fs.readFileSync(path.join(root, 'chosen'), 'utf8'), 'alpha');
        fs.unlinkSync(path.join(root, 'chosen'));

        const client = mcp('--trust');
        try {
            await client.init();
            assert.equal((await client.call('run_action', params)).data.outcome, 'success');
            assert.equal(fs.readFileSync(path.join(root, 'chosen'), 'utf8'), 'alpha');
            fs.unlinkSync(path.join(root, 'chosen'));
            fs.writeFileSync(config, JSON.stringify([action('validate', [{ ...input, validatePattern: '^\\d+$' }, write])]));
            const mismatch = await client.call('run_action', params);
            assert.equal(mismatch.error, true);
            assert.equal(mismatch.data.exitCode, 2);
            assert.equal(fs.existsSync(path.join(root, 'chosen')), false);
            assert.equal(invoke(['run', 'validate', '--trust'], { name: '42' }).code, 0);
            assert.equal(fs.readFileSync(path.join(root, 'chosen'), 'utf8'), '42');
        } finally { await client.close(); }
    });

    test('keeps intact history visible in CLI and MCP when another log is invalid or oversized', async () => {
        const run = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        assert.equal(run.code, 0);
        const directory = path.posix.dirname(run.data.runId);
        const invalid = directory + '/invalid.log';
        const oversized = directory + '/oversized.log';
        fs.writeFileSync(path.join(root, invalid), '{bad');
        fs.writeFileSync(path.join(root, oversized), '{}');
        fs.truncateSync(path.join(root, oversized), RUN_LOG_MAX_FILE_BYTES + 1);

        const history = invoke(['history']);
        assert.equal(history.code, 0);
        assert.equal(history.data.skippedLogs, 2);
        assert.deepEqual(history.data.runs.map((entry: { runId: string }) => entry.runId), [run.data.runId]);
        const human = spawnSync('node', [cli, 'history', '--workspace', root], { encoding: 'utf8', timeout: 10_000, env });
        assert.ifError(human.error);
        assert.equal(human.status, 0);
        assert.ok(human.stdout.includes(run.data.runId));
        assert.match(human.stderr, /Skipped 2 .* run log entries/);
        assert.equal(invoke(['logs', invalid]).code, 2);
        assert.equal(invoke(['logs', oversized]).code, 2);

        const client = mcp();
        try {
            await client.init();
            const listing = await client.call('list_run_history');
            assert.equal(listing.error, false);
            assert.deepEqual(listing.data, history.data);
            assert.equal((await client.call('get_run_log', { runId: invalid })).data.exitCode, 2);
        } finally { await client.close(); }
    });

    test('skips run logs and action folders without read permission in CLI and MCP history', async function () {
        // Windows ACLs and root bypass POSIX mode bits, so the denial cannot be staged there.
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const run = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        assert.equal(run.code, 0);
        const source = path.join(root, run.data.runId);
        const deniedFile = path.join(path.dirname(source), 'denied.log');
        // A first `sudo` run of another action leaves a 0700 folder owned by root.
        const deniedFolder = path.join(path.dirname(path.dirname(source)), 'other-0000000000000000');
        fs.copyFileSync(source, deniedFile);
        fs.mkdirSync(deniedFolder);
        fs.copyFileSync(source, path.join(deniedFolder, path.basename(source)));
        fs.chmodSync(deniedFile, 0o000);
        fs.chmodSync(deniedFolder, 0o000);
        try {
            const history = invoke(['history']);
            assert.equal(history.code, 0);
            assert.equal(history.data.skippedLogs, 2);
            assert.deepEqual(history.data.runs.map((entry: { runId: string }) => entry.runId), [run.data.runId]);
            assert.ok(!history.stdout.includes(root), history.stdout);

            const human = spawnSync('node', [cli, 'history', '--workspace', root], { encoding: 'utf8', timeout: 10_000, env });
            assert.ifError(human.error);
            assert.equal(human.status, 0);
            assert.ok(human.stdout.includes(run.data.runId));
            assert.match(human.stderr, /Skipped 2 unreadable, invalid or oversized run log entries/);

            const client = mcp();
            try {
                await client.init();
                const listing = await client.call('list_run_history');
                assert.equal(listing.error, false);
                assert.deepEqual(listing.data, history.data);
            } finally { await client.close(); }
        } finally {
            fs.chmodSync(deniedFolder, 0o700);
            fs.chmodSync(deniedFile, 0o600);
        }
    });

    test('keeps history when a log or action folder disappears while it is listed', async () => {
        // Rotation and concurrent runs remove entries between the directory listing and the stat.
        const run = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        assert.equal(run.code, 0);
        const logs = path.join(root, path.posix.dirname(path.posix.dirname(run.data.runId)));
        fs.writeFileSync(path.join(root, path.posix.dirname(run.data.runId), 'vanished.log'), '{}');
        fs.mkdirSync(path.join(logs, 'gone-0000000000000000'));
        const promises = fs.promises as { lstat: typeof fs.promises.lstat; readdir: typeof fs.promises.readdir };
        const { lstat, readdir } = promises;
        const vanished = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        promises.lstat = (async (target: fs.PathLike, ...rest: unknown[]) => {
            if (String(target).endsWith('vanished.log')) { throw vanished(); }
            return (lstat as (...args: unknown[]) => unknown)(target, ...rest);
        }) as typeof lstat;
        promises.readdir = (async (target: fs.PathLike, ...rest: unknown[]) => {
            if (String(target).endsWith('gone-0000000000000000')) { throw vanished(); }
            return (readdir as (...args: unknown[]) => unknown)(target, ...rest);
        }) as typeof readdir;
        try {
            assert.deepEqual((await listActionRunHistory(root)).runs.map(entry => entry.runId), [run.data.runId]);
        } finally {
            promises.lstat = lstat;
            promises.readdir = readdir;
        }
    });

    test('limits history in CLI and MCP and rejects an invalid limit', async () => {
        const first = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        const second = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        assert.equal(first.code, 0);
        assert.equal(second.code, 0);
        const limited = invoke(['history', '--limit', '1']);
        assert.equal(limited.code, 0);
        assert.deepEqual(limited.data.runs.map((entry: { runId: string }) => entry.runId), [second.data.runId]);
        assert.equal(invoke(['history']).data.runs.length, 2);
        for (const value of ['0', '-1', 'x', '1.5']) {
            assert.equal(spawnSync('node', [cli, 'history', '--limit', value, '--workspace', root, '--json'], { encoding: 'utf8', env }).status, 2, value);
        }
        assert.equal(spawnSync('node', [cli, 'list', '--limit', '1', '--workspace', root], { encoding: 'utf8', env }).status, 2);
        const client = mcp();
        try {
            await client.init();
            const listing = await client.call('list_run_history', { limit: 1 });
            assert.equal(listing.error, false);
            assert.deepEqual(listing.data, limited.data);
            for (const limit of [0, 1.5, '1']) {
                const rejected = await client.request('tools/call', { name: 'list_run_history', arguments: { limit } });
                assert.equal(rejected.error?.code, -32602, JSON.stringify(rejected));
            }
        } finally { await client.close(); }
    });

    test('accepts --input pairs, repeated keys as lists, and keeps values out of errors', () => {
        fs.writeFileSync(config, JSON.stringify([action('pairs', [
            { id: 'name', type: 'inputBox' },
            { id: 'many', type: 'quickPick', canPickMany: true, items: ['a', 'b', 'c'] },
            { id: 'save', type: 'writeFile', path: 'pairs.txt', content: '${name.value}|${many.values}' },
        ])]));
        const run = (...pairs: string[]) => spawnSync('node', [cli, 'run', 'pairs', '--trust', '--json', '--workspace', root,
            ...pairs.flatMap(pair => ['--input', pair])], { encoding: 'utf8', env });
        const ok = run('name=x=y', 'many=a', 'many=c');
        assert.equal(ok.status, 0, ok.stdout);
        assert.equal(fs.readFileSync(path.join(root, 'pairs.txt'), 'utf8'), 'x=y|a,c');
        const malformed = run(secret);
        assert.equal(malformed.status, 2);
        assert.ok(!malformed.stdout.includes(secret), malformed.stdout);
        assert.equal(run('=x').status, 2);
        // --input wins over the same key from --inputs-file.
        const overridden = spawnSync('node', [cli, 'run', 'pairs', '--trust', '--json', '--workspace', root, '--inputs-file', '-',
            '--input', 'name=flag'], { encoding: 'utf8', env, input: JSON.stringify({ name: 'file', many: ['b'] }) });
        assert.equal(overridden.status, 0, overridden.stdout);
        assert.equal(fs.readFileSync(path.join(root, 'pairs.txt'), 'utf8'), 'flag|b');
        assert.equal(spawnSync('node', [cli, 'preview', 'pairs', '--input', 'name=x', '--workspace', root], { encoding: 'utf8', env }).status, 2);
    });

    test('shows command output live without --json and keeps --json stdout to one document', () => {
        fs.writeFileSync(config, JSON.stringify([action('show', [
            { id: 'say', type: 'command', command: 'node', args: ['probe.cjs', 'live'] },
        ])]));
        const plain = spawnSync('node', [cli, 'run', 'show', '--trust', '--workspace', root], { encoding: 'utf8', env });
        assert.equal(plain.status, 0, plain.stderr);
        assert.ok(plain.stdout.startsWith('["live"]'), plain.stdout);
        assert.match(plain.stdout, /\nshow\nsuccess\n/);
        assert.equal(plain.stderr, 'diagnostic\n');
        fs.writeFileSync(path.join(root, 'tail.cjs'), "process.stdout.write('no-newline');");
        fs.writeFileSync(config, JSON.stringify([action('show', [
            { id: 'say', type: 'command', command: 'node', args: ['tail.cjs'] },
        ])]));
        const tail = spawnSync('node', [cli, 'run', 'show', '--trust', '--workspace', root], { encoding: 'utf8', env });
        assert.ok(tail.stdout.startsWith('no-newline\nshow\n'), tail.stdout);
        const json = invoke(['run', 'show', '--trust']);
        assert.equal(json.code, 0);
        assert.equal(json.stdout.trim().split('\n').length, 1, json.stdout);
    });

    test('reports Doctor findings of one action at their positions in the actions file', () => {
        // Both actions use the task id `build`; Doctor must still attribute each finding to its own action.
        const actions = [
            action('other', [{ id: 'build', type: 'writeFile', path: 'o.txt', content: 'fine' }]),
            action('target', [{ id: 'build', type: 'writeFile', path: 't.txt', content: '${absent.output}' }]),
        ];
        const text = JSON.stringify(actions, null, 4);
        fs.writeFileSync(config, text);
        const lines = text.split('\n');
        const targetStart = lines.findIndex(line => line.includes('"target"'));
        const targetBuild = lines.findIndex((line, index) => index > targetStart && line.includes('"build"')) + 1;
        type Finding = { range: { startLine: number }; code: string };
        const unresolved = (findings: Finding[]) => findings.filter(finding => finding.code === 'variable.unresolved')
            .map(finding => finding.range.startLine);
        assert.deepEqual(unresolved(invoke(['doctor', 'other']).data.findings), []);
        assert.deepEqual(unresolved(invoke(['doctor', 'target']).data.findings), [targetBuild]);
        const display = spawnSync('node', [cli, 'doctor', 'target', '--workspace', root], { encoding: 'utf8', env });
        assert.ok(display.stdout.includes(`.vscode/actions.json:${targetBuild}:`), display.stdout);

        // An error-level finding decides the exit code of the action it belongs to only.
        actions[1].action.tasks[0] = { id: 'build', type: 'command', command: 'node', passTheResultToNextTask: true, output: { capture: { name: 'x', regex: '(' } } } as Task;
        fs.writeFileSync(config, JSON.stringify(actions, null, 4));
        assert.equal(invoke(['doctor', 'other']).code, 0);
        assert.equal(invoke(['doctor', 'target']).code, 2);
    });

    test('keeps running and writes the log when the reader of live output closes early', async () => {
        fs.writeFileSync(path.join(root, 'chatty.cjs'),
            "console.log('first'); setTimeout(() => { for (let i = 0; i < 2000; i++) { console.log('line ' + i); } }, 300);");
        fs.writeFileSync(config, JSON.stringify([action('chatty', [
            { id: 'talk', type: 'command', command: 'node', args: ['chatty.cjs'] },
        ])]));
        const child = spawn('node', [cli, 'run', 'chatty', '--trust', '--workspace', root], { stdio: ['ignore', 'pipe', 'pipe'], env });
        const closed = once(child, 'close');
        child.stdout.once('data', () => child.stdout.destroy());
        const [code] = await closed;
        assert.equal(code, 0);
        assert.equal(invoke(['history']).data.runs[0].outcome, 'success');
    });

    test('logs why a condition skipped a task without its secret value', async () => {
        fs.writeFileSync(config, JSON.stringify([action('gate', [
            { id: 'pw', type: 'inputBox', password: true },
            { id: 'plain', type: 'inputBox' },
            { id: 'secretGate', type: 'writeFile', path: 'a.txt', content: 'x', when: { var: '${pw.value}', equals: 'other' } },
            { id: 'plainGate', type: 'writeFile', path: 'b.txt', content: 'x', when: { var: '${plain.value}', equals: 'other' } },
            { id: 'derived', type: 'stringManipulation', function: 'trim', input: '${pw.value}' },
            { id: 'derivedGate', type: 'writeFile', path: 'c.txt', content: 'x', when: { var: '${derived.output}', equals: 'other' } },
            { id: 'envGate', type: 'writeFile', path: 'd.txt', content: 'x', when: { var: '${env:TASKHUB_TEST_TOKEN}', equals: 'other' } },
        ])]));
        const run = invoke(['run', 'gate', '--trust'], { pw: secret, plain: 'shown' }, { TASKHUB_TEST_TOKEN: 'synthetic-env-token' });
        assert.equal(run.code, 0, run.stdout);
        const log = await new Workspace(root).log(run.data.runId);
        const reasons = Object.fromEntries(log.tasks.map(task => [task.taskId, task.error]));
        assert.match(reasons.secretGate!, /\(\*\*\*\)/);
        assert.match(reasons.plainGate!, /\(shown\)/);
        assert.match(reasons.derivedGate!, /\(\*\*\*\)/);
        assert.match(reasons.envGate!, /\(\*\*\*\)/);
        assert.ok(!JSON.stringify(log).includes(secret));
        assert.ok(!JSON.stringify(log).includes('synthetic-env-token'));
    });

    test('runs a Windows workspace opened through a subst drive and a UNC path', function () {
        if (process.platform !== 'win32') { this.skip(); }
        fs.writeFileSync(config, JSON.stringify([action('drive', [
            { id: 'save', type: 'writeFile', path: 'drive.txt', content: 'x', overwrite: true },
        ])]));
        const canonical = fs.realpathSync.native(root);
        const run = (workspace: string) => {
            fs.rmSync(path.join(root, 'drive.txt'), { force: true });
            const result = spawnSync('node', [cli, 'run', 'drive', '--trust', '--json', '--workspace', workspace], { encoding: 'utf8', env });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            // The workspace boundary check accepts the drive's own files, wherever the drive points.
            assert.ok(fs.existsSync(path.join(root, 'drive.txt')));
            const history = spawnSync('node', [cli, 'history', '--json', '--workspace', workspace], { encoding: 'utf8', env });
            assert.equal(history.status, 0, history.stdout);
            assert.ok(JSON.parse(history.stdout).runs.length > 0);
        };
        const used = new Set(spawnSync('cmd.exe', ['/d', '/c', 'subst'], { encoding: 'utf8' }).stdout.match(/^[A-Z]:/gm) ?? []);
        const letter = 'TUVWXYZ'.split('').map(l => l + ':').find(l => !used.has(l) && !fs.existsSync(l + '\\'));
        assert.ok(letter, 'no free drive letter');
        assert.equal(spawnSync('cmd.exe', ['/d', '/c', 'subst', letter, root]).status, 0);
        try { run(letter + '\\'); }
        finally { spawnSync('cmd.exe', ['/d', '/c', 'subst', letter, '/d']); }
        // The administrative share exists on hosted runners; elsewhere the UNC half is not checked.
        const unc = '\\\\localhost\\' + canonical[0] + '$' + canonical.slice(2);
        if (fs.existsSync(unc)) { run(unc); }
    });

    test('names an IDE-only built-in variable that standalone execution cannot provide', () => {
        fs.writeFileSync(config, JSON.stringify([action('editor', [
            { id: 'open', type: 'command', command: 'node', args: ['probe.cjs', '${file}'] },
        ])]));
        const run = invoke(['run', 'editor', '--trust']);
        assert.equal(run.code, 2);
        assert.match(run.data.error, /\$\{file\}/);
    });

    test('redacts a credential that forEach iterations print in parts', () => {
        // A multi-line credential printed one line per iteration only appears once the iterations are joined.
        fs.writeFileSync(path.join(root, 'print.cjs'), 'console.log(process.argv[2]);');
        fs.writeFileSync(config, JSON.stringify([action('parts', [{
            id: 'part', type: 'command', command: 'node', args: ['print.cjs', '${each.value}'],
            forEach: ['first-half', 'second-half'], env: { SERVICE_TOKEN: 'first-half\nsecond-half' },
        }])]));
        const run = invoke(['run', 'parts', '--trust', '--capture-output']);
        assert.equal(run.code, 0);
        const log = invoke(['logs', run.data.runId]);
        assert.equal(log.data.tasks[0].output.availability, 'redacted');
        assert.ok(!log.stdout.includes('second-half'));
    });

    test('marks a credential split across forEach iterations before later tasks use it, without capture', () => {
        // The default run logs nothing, but the joined iteration results still reach later tasks.
        fs.writeFileSync(path.join(root, 'print.cjs'), 'console.log(process.argv[2]);');
        fs.writeFileSync(config, JSON.stringify([action('parts', [
            { id: 'part', type: 'command', command: 'node', args: ['print.cjs', '${each.value}'], passTheResultToNextTask: true,
                forEach: ['first-half', 'second-half'], env: { SERVICE_TOKEN: 'first-half\nsecond-half' } },
            { id: 'save', type: 'writeFile', path: 'joined.txt', content: '${part.output}' },
        ])]));
        const run = invoke(['run', 'parts', '--trust']);
        assert.equal(run.code, 2, JSON.stringify(run.data));
        assert.match(run.data.error, /allowSecretContent/);
        assert.equal(fs.existsSync(path.join(root, 'joined.txt')), false);
    });

    test('records diagnostics of a failed command only when its output was collected', () => {
        fs.writeFileSync(path.join(root, 'cc.cjs'), 'console.error("main.c:3:1: error: boom"); process.exit(2);');
        const build: Task = { id: 'build', type: 'command', command: 'node', args: ['cc.cjs'], output: { diagnostics: '$gcc' } } as Task;
        fs.writeFileSync(config, JSON.stringify([action('build', [build])]));
        const quiet = invoke(['run', 'build', '--trust']);
        assert.equal(quiet.code, 1);
        assert.equal(invoke(['logs', quiet.data.runId]).data.tasks[0].diagnostics, undefined);
        const captured = invoke(['run', 'build', '--trust', '--capture-output']);
        assert.deepEqual(invoke(['logs', captured.data.runId]).data.tasks[0].diagnostics, { error: 1, warning: 0, info: 0, hint: 0 });
    });

    test('reports a truncated capture when forEach output exceeds the log limit', function () {
        this.timeout(60_000);
        fs.writeFileSync(path.join(root, 'big.cjs'), 'process.stdout.write("x".repeat(7 * 1024 * 1024));');
        fs.writeFileSync(config, JSON.stringify([action('big', [{
            id: 'big', type: 'command', command: 'node', args: ['big.cjs', '${each.value}'], forEach: ['1', '2', '3', '4', '5'],
        }])]));
        const run = invoke(['run', 'big', '--trust', '--capture-output']);
        assert.equal(run.code, 0);
        assert.deepEqual(invoke(['logs', run.data.runId]).data.tasks[0].output, { availability: 'capture-truncated', truncated: true });
    });

    test('canonicalizes the workspace root with the native realpath', () => {
        // On Windows runners the temp directory is an 8.3 short name that only the native realpath expands.
        assert.equal(new Workspace(root).root, fs.realpathSync.native(root));
        const alias = root + ' alias';
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        try { assert.equal(new Workspace(alias).root, fs.realpathSync.native(root)); }
        finally { fs.unlinkSync(alias); }
    });

    test('lists history through a non-canonical workspace path', async () => {
        // Windows runners expose temp as an 8.3 short name (RUNNER~1) that only the native realpath
        // expands; a junction or symlink to the workspace reproduces the same mismatch on every OS.
        const run = invoke(['run', 'build', '--trust'], { slot: 'debug' });
        assert.equal(run.code, 0);
        const alias = root + ' link';
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        try {
            const history = await listActionRunHistory(alias);
            assert.deepEqual(history.runs.map(entry => entry.runId), [run.data.runId]);
        } finally { fs.unlinkSync(alias); }
    });

    test('returns cancellation code 130 and records a declined confirmation', () => {
        fs.writeFileSync(config, JSON.stringify([action('deploy', [
            { id: 'accept', type: 'confirm', message: 'Continue?' },
            { id: 'save', type: 'writeFile', dependsOn: ['accept'], path: 'deployed', content: 'yes' },
        ])]));
        const run = invoke(['run', 'deploy', '--trust'], { accept: false });
        assert.equal(run.code, 130, run.stdout);
        assert.equal(run.data.outcome, 'cancelled');
        assert.equal(invoke(['logs', run.data.runId]).data.outcome, 'cancelled');
        assert.equal(fs.existsSync(path.join(root, 'deployed')), false);
    });

    test('keeps MCP stdout empty when its workspace cannot be opened', () => {
        const failed = spawnSync('node', [cli, 'mcp', '--workspace', path.join(root, 'absent'), '--json'],
            { encoding: 'utf8', timeout: 10_000 });
        assert.ifError(failed.error);
        assert.equal(failed.status, 2);
        assert.equal(failed.stdout, '');
        assert.ok(failed.stderr.trim());
    });

    test('uses the same definitions, argv, outputs, history and logs through both processes', async () => {
        const client = mcp('--trust', '--capture-output');
        try {
            await client.init();
            const tools = (await client.request('tools/list')).result.tools;
            assert.deepEqual(tools.map((v: { name: string }) => v.name).sort(),
                ['get_run_log', 'list_actions', 'list_run_history', 'preview_action', 'run_action', 'validate_action']);
            assert.deepEqual((await client.call('list_actions')).data, invoke(['list']).data);
            assert.deepEqual((await client.call('preview_action', { actionId: 'build' })).data, invoke(['preview', 'build']).data);
            assert.equal((await client.call('validate_action', { actionId: 'build' })).data.valid, true);
            const first = invoke(['run', 'build', '--trust', '--capture-output', '--non-interactive'], { slot: 'debug' });
            assert.equal(first.code, 0, first.stdout);
            const expected = JSON.stringify(['--debug', arg]);
            assert.equal(fs.readFileSync(path.join(root, 'result'), 'utf8'), expected);
            fs.unlinkSync(path.join(root, 'result'));
            const second = await client.call('run_action', { actionId: 'build', inputs: { slot: 'debug' } });
            assert.equal(second.error, false);
            assert.equal(second.data.outcome, first.data.outcome);
            assert.equal(fs.readFileSync(path.join(root, 'result'), 'utf8'), expected);
            for (const runId of [first.data.runId, second.data.runId]) {
                const log = (await client.call('get_run_log', { runId })).data;
                assert.deepEqual(log, invoke(['logs', runId]).data);
                assert.deepEqual(log.tasks[1].output, { availability: 'captured', stdout: expected, stderr: 'diagnostic' });
            }
            assert.deepEqual((await client.call('list_run_history')).data, invoke(['history']).data);
            fs.writeFileSync(config, JSON.stringify([action('renamed', [])]));
            assert.equal((await client.call('list_actions')).data.actions[0].id, 'renamed');
        } finally { await client.close(); }
    });

    test('keeps MCP launch policy immutable and handles unknown tools and invalid arguments', async () => {
        const client = mcp();
        try {
            assert.ok((await client.request('tools/list')).error);
            await client.init();
            assert.equal((await client.call('run_action', { actionId: 'build' })).data.exitCode, 3);
            for (const [name, args] of [['unknown', {}], ['run_action', { actionId: 'build', trusted: true }],
                ['list_actions', { workspace: '..' }], ['run_action', { actionId: 'build', inputs: { slot: {} } }]]) {
                assert.equal((await client.request('tools/call', { name, arguments: args })).error.code, -32602);
            }
            assert.equal(fs.existsSync(path.join(root, '.taskhub')), false);
        } finally { await client.close(); }
    });

    test('redacts password, environment and transitive outputs and blocks implicit secret persistence', () => {
        const tasks: Task[] = [
            { id: 'pw', type: 'inputBox', password: true },
            { id: 'echo', type: 'command', command: 'node', args: ['probe.cjs', '${pw}', '${env:PATH}'], passTheResultToNextTask: true },
            { id: 'copy', type: 'stringManipulation', function: 'trim', input: '${echo.output}',
                passTheResultToNextTask: true, output: { mode: 'terminal' } },
            { id: 'write', type: 'writeFile', path: 'secret-file', content: '${copy.output}' },
        ];
        fs.writeFileSync(config, JSON.stringify([action('secret', tasks)]));
        const result = invoke(['run', 'secret', '--trust', '--capture-output'], { pw: secret });
        assert.equal(result.code, 2);
        assert.equal(fs.existsSync(path.join(root, 'secret-file')), false);
        const log = invoke(['logs', result.data.runId]);
        assert.equal(log.data.tasks[1].output.availability, 'redacted');
        assert.equal(log.stdout.includes(secret), false);
        assert.equal(log.stdout.includes(process.env.PATH!), false);
        assert.equal(result.stdout.includes(secret), false);
    });

    test('hides incidental credential output and its derived values even with capture enabled', () => {
        fs.writeFileSync(path.join(root, 'secret.cjs'), "process.stdout.write(process.env.DEMO_TOKEN);");
        fs.writeFileSync(config, JSON.stringify([action('echo', [
            { id: 'raw', type: 'command', command: 'node', args: ['secret.cjs'], env: { DEMO_TOKEN: secret }, passTheResultToNextTask: true },
            { id: 'save', type: 'writeFile', path: 'implicit', content: '${raw.output}' },
        ])]));
        const result = invoke(['run', 'echo', '--trust', '--capture-output']);
        assert.equal(result.code, 2);
        const log = invoke(['logs', result.data.runId]);
        assert.equal(log.data.tasks[0].output.availability, 'redacted');
        assert.equal(log.stdout.includes(secret), false);
        assert.equal(fs.existsSync(path.join(root, 'implicit')), false);
    });

    test('captures failed command output for CLI and MCP while redacting credentials', async () => {
        fs.writeFileSync(path.join(root, 'fail.cjs'), `
            console.log('build output');
            console.error(process.env.DEMO_TOKEN || 'build diagnostic');
            process.exitCode = 7;
        `);
        const command: Task = { id: 'command', type: 'command', command: 'node', args: ['fail.cjs'] };
        fs.writeFileSync(config, JSON.stringify([
            action('fail', [command]),
            action('private', [{ ...command, env: { DEMO_TOKEN: secret } }]),
        ]));
        const run = invoke(['run', 'fail', '--trust', '--capture-output']);
        assert.equal(run.code, 1);
        // A failed command's log keeps its streams as printed, matching the extension.
        const expected = { availability: 'captured', stdout: 'build output\n', stderr: 'build diagnostic\n' };
        const logged = invoke(['logs', run.data.runId]).data.tasks[0];
        assert.equal(logged.exitCode, 7);
        assert.deepEqual(logged.output, expected);
        const uncaptured = invoke(['run', 'fail', '--trust']);
        assert.ok(!invoke(['logs', uncaptured.data.runId]).stdout.includes('build diagnostic'));

        const client = mcp('--trust', '--capture-output');
        try {
            await client.init();
            const failed = await client.call('run_action', { actionId: 'fail' });
            assert.equal(failed.error, true);
            const failedLog = await client.call('get_run_log', { runId: failed.data.runId });
            assert.deepEqual(failedLog.data.tasks[0].output, expected);
            const privateRun = await client.call('run_action', { actionId: 'private' });
            assert.equal(privateRun.error, true);
            const privateLog = invoke(['logs', privateRun.data.runId]);
            assert.equal(privateLog.data.tasks[0].output.availability, 'redacted');
            assert.ok(!privateLog.stdout.includes(secret));
            assert.ok(!JSON.stringify(privateRun.data).includes(secret));
        } finally { await client.close(); }
    });

    test('reports a missing task working directory without exposing its path', () => {
        const cwd = 'missing-private-directory';
        fs.writeFileSync(config, JSON.stringify([action('broken', [{ id: 'command', type: 'command', command: 'node', cwd }])]));
        const run = invoke(['run', 'broken', '--trust']);
        assert.equal(run.code, 1);
        assert.match(run.data.error, /Cannot open the task working directory/);
        assert.ok(!run.stdout.includes(cwd));
    });

    test('reports a POSIX spawn ENOENT without exposing the executable name', function () {
        if (process.platform === 'win32') { this.skip(); }
        const command = 'taskhub-test-absent-executable';
        fs.writeFileSync(config, JSON.stringify([action('broken', [{ id: 'command', type: 'command', command }])]));
        const run = invoke(['run', 'broken', '--trust']);
        assert.equal(run.code, 1);
        assert.match(run.data.error, /Executable not found/);
        assert.ok(!run.stdout.includes(command));
    });

    test('dispatches selected branches, iterations, path inputs and ZIP using existing result fields', () => {
        fs.writeFileSync(path.join(root, 'source.txt'), 'payload');
        fs.writeFileSync(config, JSON.stringify([action('flow', [
            { id: 'file', type: 'fileDialog' },
            { id: 'disabled', type: 'stringManipulation', function: 'trim', input: 'never', when: { var: 'off', equals: 'on' } },
            { id: 'choose', type: 'switch', on: 'live', cases: {
                dead: { type: 'stringManipulation', input: '${disabled.output}', function: 'trim' },
                live: { type: 'stringManipulation', input: '${file.name}', function: 'toUpperCase' },
            } },
            { id: 'loop', type: 'appendFile', forEach: ['A', 'B'], path: 'each.txt', content: '${each}:${choose.output}\n' },
            { id: 'pack', type: 'zip', source: ['${file.path}', 'each.txt'], archive: 'example.zip' },
            { id: 'extract', type: 'unzip', inputs: { archive: 'pack' }, destination: 'unpacked' },
        ])]));
        const result = invoke(['run', 'flow', '--trust'], { file: 'source.txt' });
        assert.equal(result.code, 0, result.stdout);
        assert.equal(fs.readFileSync(path.join(root, 'unpacked/source.txt'), 'utf8'), 'payload');
        assert.equal(fs.readFileSync(path.join(root, 'unpacked/each.txt'), 'utf8'), 'A:SOURCE.TXT\nB:SOURCE.TXT\n');
    });

    function longAction(timeoutSeconds?: number) {
        fs.writeFileSync(path.join(root, 'parent.cjs'), `
            require('node:fs').writeFileSync('parent-pid', String(process.pid));
            const child = require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], { stdio: 'inherit' });
            const fallback = setTimeout(() => {}, 20000);
            process.once('SIGTERM', () => child.once('exit', () => clearTimeout(fallback)));
        `);
        fs.writeFileSync(path.join(root, 'grandchild.cjs'), `require('node:fs').writeFileSync('pid', String(process.pid)); setTimeout(()=>{}, 20000);`);
        fs.writeFileSync(config, JSON.stringify([action('long', [
            { id: 'long', type: 'command', command: 'node', args: ['parent.cjs'], timeoutSeconds },
            { id: 'after', type: 'writeFile', path: 'after', content: 'bad' },
        ])]));
    }
    function pidFrom(file: string) {
        const marker = path.join(root, file);
        return fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
    }
    function childGone(file = 'pid') {
        const pid = pidFrom(file);
        if (!pid) { return false; }
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }

    test('timeout terminates descendants and records failure', async () => {
        longAction(2);
        const result = invoke(['run', 'long', '--trust']);
        assert.equal(result.code, 1, result.stdout);
        assert.equal(result.data.outcome, 'failure');
        // The run ends only after the timed-out command's process tree is gone.
        if (process.platform !== 'win32') { assert.ok(childGone(), 'the CLI returned while the timed-out process was still running'); }
        await until(childGone);
        assert.equal(fs.existsSync(path.join(root, 'after')), false);
    });

    for (const signal of ['SIGINT', 'SIGHUP'] as const) {
        test(`stops the CLI process tree on ${signal}`, async function () {
            if (process.platform === 'win32') { this.skip(); }
            longAction();
            const child = spawn('node', [cli, 'run', 'long', '--trust', '--workspace', root, '--json'],
                { stdio: ['ignore', 'pipe', 'pipe'], env });
            const closed = once(child, 'close');
            let stdout = '';
            child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
            const deadline = setTimeout(() => child.kill('SIGKILL'), 16_000);
            let treeStopped = false;
            try {
                await until(() => pidFrom('pid') > 0);
                assert.ok(child.kill(signal));
                assert.deepEqual(await closed, [130, null]);
                await until(() => childGone() && childGone('parent-pid'));
                treeStopped = true;
                assert.equal(JSON.parse(stdout).outcome, 'cancelled');
                assert.equal(invoke(['history']).data.runs[0].outcome, 'cancelled');
                assert.equal(fs.existsSync(path.join(root, 'after')), false);
            } finally {
                clearTimeout(deadline);
                if (!treeStopped) {
                    const parent = pidFrom('parent-pid');
                    if (parent) {
                        try { process.kill(-parent, 'SIGKILL'); }
                        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') { throw err; } }
                    }
                    child.kill('SIGKILL');
                    await closed;
                }
            }
        });
    }

    for (const mode of ['cancel', 'eof']) {
        test('stops the process tree on MCP ' + mode, async () => {
            longAction();
            const client = mcp('--trust');
            try {
                await client.init();
                client.send('tools/call', { name: 'run_action', arguments: { actionId: 'long' } }, 70);
                await until(() => pidFrom('pid') > 0);
                if (mode === 'cancel') {
                    client.send('notifications/cancelled', { requestId: 70 });
                    await until(async () => (await client.call('list_run_history')).data.runs.length === 1);
                }
            } finally { await client.close(); }
            await until(childGone);
            assert.equal(invoke(['history']).data.runs[0].outcome, 'cancelled');
            assert.equal(fs.existsSync(path.join(root, 'after')), false);
        });
    }
});
