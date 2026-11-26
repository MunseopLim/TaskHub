const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

assert.ok(process.env.npm_execpath, 'Run this through `npm run test:cli-package` so npm_execpath is set.');

const root = path.resolve(__dirname, '../..');
const { version } = require('../../package.json');
const archive = path.join(root, 'dist', `taskhub-cli-${version}.tgz`);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub package 한글 '));
const prefix = path.join(workspace, 'install');
const windows = process.platform === 'win32';
const env = { ...process.env, NODE_PATH: '' };

try {
    const installArgs = [process.env.npm_execpath, 'install', '--global', '--prefix', prefix,
        '--offline', '--cache', path.join(workspace, 'cache'), '--ignore-scripts', '--no-audit', '--no-fund', archive];
    execFileSync(process.execPath, installArgs, { cwd: workspace, env, stdio: 'inherit' });

    fs.mkdirSync(path.join(workspace, '.vscode'));
    const action = { id: 'installed', title: 'Installed CLI', action: { description: 'Smoke test', tasks: [] } };
    fs.writeFileSync(path.join(workspace, '.vscode', 'actions.json'), JSON.stringify([action]));
    const options = { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 };
    // Exercise npm's generated launcher with the native shell and a workspace path containing spaces.
    const launcher = windows
        ? { command: process.env.ComSpec, args: ['/d', '/c', '.\\install\\taskhub.cmd'] }
        : { command: path.join(prefix, 'bin', 'taskhub'), args: [] };
    const stdout = execFileSync(launcher.command, [...launcher.args, 'list', '--json'], options);
    assert.deepEqual(JSON.parse(stdout).actions.map(item => item.id), [action.id]);

    // MCP clients start the server through the same launcher; stdout must carry only JSON-RPC frames.
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } } };
    const served = spawnSync(launcher.command, [...launcher.args, 'mcp'], { ...options, input: JSON.stringify(initialize) + '\n' });
    assert.ifError(served.error);
    assert.equal(served.status, 0, served.stderr);
    const frames = served.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.equal(frames.length, 1, served.stdout);
    assert.equal(frames[0].id, initialize.id);
    assert.equal(frames[0].result.protocolVersion, initialize.params.protocolVersion);

    const installed = path.join(windows ? prefix : path.join(prefix, 'lib'), 'node_modules', 'taskhub-cli');
    const manifest = require(path.join(installed, 'package.json'));
    assert.equal(manifest.version, version);
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
    assert.match(fs.readFileSync(path.join(installed, 'README.md'), 'utf8'), /taskhub run/);
    const license = directory => fs.readFileSync(path.join(directory, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(license(installed), license(root));
    assert.match(fs.readFileSync(path.join(installed, 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /@modelcontextprotocol\/sdk /);
    const cli = path.resolve(installed, manifest.bin.taskhub);
    const tests = ['standalone.test.js', 'standaloneExecution.test.js'].map(file => path.join(root, 'out', 'test', file));
    execFileSync(process.execPath, [require.resolve('mocha/bin/mocha.js'), '--ui', 'tdd', ...tests],
        { cwd: workspace, env: { ...env, TASKHUB_TEST_CLI: cli }, stdio: 'inherit', timeout: 240_000 });
} finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
}
