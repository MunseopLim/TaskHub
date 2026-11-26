const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    const stdout = windows
        ? execFileSync(process.env.ComSpec, ['/d', '/c', '.\\install\\taskhub.cmd', 'list', '--json'], options)
        : execFileSync(path.join(prefix, 'bin', 'taskhub'), ['list', '--json'], options);
    assert.deepEqual(JSON.parse(stdout).actions.map(item => item.id), [action.id]);

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
