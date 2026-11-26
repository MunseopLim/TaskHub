import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { parseInputs } from '../standalone/inputs';
import { launchPlan } from '../standalone/process';
import { executionIssues } from '../standalone/runner';
import type { Task } from '../schema';

const cli = process.env.TASKHUB_TEST_CLI ?? path.resolve(__dirname, '../../bin/taskhub.cjs');
const arg = '두 단어 & $NAME | >';
const secret = 'synthetic-private-input';
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

    function invoke(args: string[], inputs?: object) {
        const result = spawnSync('node', [cli, ...args, ...(inputs ? ['--inputs-file', '-'] : []), '--workspace', root, '--json'],
            { encoding: 'utf8', input: inputs && JSON.stringify(inputs), timeout: 15_000 });
        assert.ifError(result.error);
        assert.equal(result.stderr, '');
        return { code: result.status, data: JSON.parse(result.stdout), stdout: result.stdout };
    }

    function mcp(...args: string[]) {
        const child = spawn('node', [cli, 'mcp', '--workspace', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
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

    test('reads BOM input files and rejects unreadable, malformed and oversized files before execution', () => {
        const file = path.join(root, '빌드 입력.json');
        const args = ['run', 'build', '--trust', '--non-interactive', '--inputs-file', file];
        assert.equal(invoke(args).code, 2);
        for (const content of ['{', JSON.stringify({ slot: 'x'.repeat(8 * 1024 * 1024) })]) {
            fs.writeFileSync(file, content);
            assert.equal(invoke(args).code, 2);
        }
        assert.equal(fs.existsSync(path.join(root, '.taskhub')), false);
        fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ slot: 'debug' }));
        assert.equal(invoke(args).code, 0);
        assert.equal(fs.readFileSync(path.join(root, 'result'), 'utf8'), JSON.stringify(['--debug', arg]));
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
        fs.writeFileSync(path.join(root, 'parent.cjs'), `require('node:child_process').spawn(process.execPath, ['grandchild.cjs'], {stdio:'inherit'}); setTimeout(()=>{}, 20000);`);
        fs.writeFileSync(path.join(root, 'grandchild.cjs'), `require('node:fs').writeFileSync('pid', String(process.pid)); setTimeout(()=>{}, 20000);`);
        fs.writeFileSync(config, JSON.stringify([action('long', [
            { id: 'long', type: 'command', command: 'node', args: ['parent.cjs'], timeoutSeconds },
            { id: 'after', type: 'writeFile', path: 'after', content: 'bad' },
        ])]));
    }
    function childGone() {
        const pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }

    test('timeout terminates descendants and records failure', async () => {
        longAction(2);
        const result = invoke(['run', 'long', '--trust']);
        assert.equal(result.code, 1, result.stdout);
        assert.equal(result.data.outcome, 'failure');
        await until(childGone);
        assert.equal(fs.existsSync(path.join(root, 'after')), false);
    });

    for (const mode of ['cancel', 'eof']) {
        test('stops the process tree on MCP ' + mode, async () => {
            longAction();
            const client = mcp('--trust');
            try {
                await client.init();
                client.send('tools/call', { name: 'run_action', arguments: { actionId: 'long' } }, 70);
                await until(() => fs.existsSync(path.join(root, 'pid')) && Number(fs.readFileSync(path.join(root, 'pid'), 'utf8')) > 0);
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
