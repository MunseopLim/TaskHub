import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

suite('Standalone CLI', function () {
    this.timeout(30_000);
    let root: string;
    let config: string;
    const cli = process.env.TASKHUB_TEST_CLI ?? path.resolve(__dirname, '../../bin/taskhub.cjs');
    const invoke = (...args: string[]) => spawnSync('node', [cli, ...args, '--workspace', root, '--json'],
        { encoding: 'utf8', timeout: 10_000 });
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub CLI 한글 '));
        fs.mkdirSync(path.join(root, '.vscode'));
        config = path.join(root, '.vscode', 'actions.json');
        fs.writeFileSync(config, '\uFEFF' + JSON.stringify([{ id: 'folder', title: 'Folder', type: 'folder', children: [
            { id: 'build', title: 'Build', action: { description: 'Demo', tasks: [
                { id: 'write', type: 'writeFile', path: 'marker', content: 'ok' },
            ] } },
        ] }]));
    });
    teardown(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }); });

    test('lists nested actions and previews a BOM configuration without side effects', () => {
        const list = invoke('list');
        assert.equal(list.status, 0, list.stderr);
        assert.deepEqual(JSON.parse(list.stdout).actions, [{ id: 'build', title: 'Build', description: 'Demo' }]);
        const preview = invoke('preview', 'build');
        assert.equal(preview.status, 0);
        assert.match(JSON.parse(preview.stdout).report, /marker/);
        assert.equal(invoke('doctor').status, 0);
        assert.equal(fs.existsSync(path.join(root, 'marker')), false);
    });
    test('invalid arguments, unknown IDs and malformed config have machine-readable errors', () => {
        for (const args of [['preview'], ['preview', 'missing'], ['list', 'extra'], ['--unknown']]) {
            const result = invoke(...args);
            assert.equal(result.status, 2);
            assert.equal(JSON.parse(result.stdout).exitCode, 2);
        }
        fs.writeFileSync(config, '{');
        const result = invoke('doctor');
        assert.equal(result.status, 2);
        assert.equal(JSON.parse(result.stdout).findings[0].code, 'json.parse');
    });
});
