import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NamedInputProfile } from '../inputProfiles';
import { profileToCliInputs } from '../profileCliInputs';
import type { Task } from '../schema';
import { inputResult, parseInputs } from '../standalone/inputs';

function profile(inputs: Record<string, unknown>, tasks: Task[]): NamedInputProfile {
    const taskTypes = Object.fromEntries(tasks.filter(task => Object.hasOwn(inputs, task.id)).map(task => [task.id, task.type]));
    return { id: 'p', actionId: 'build', name: 'daily', inputs, taskTypes, createdAt: 0, updatedAt: 0 };
}

suite('Input profile export for the CLI', () => {
    let root: string;
    setup(() => {
        root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-profile-')));
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src', 'main.c'), '');
        fs.writeFileSync(path.join(root, 'src', 'util.c'), '');
    });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('exported values reproduce the saved results through the CLI input builder', () => {
        const tasks = [
            { id: 'target', type: 'quickPick', items: [{ id: 'dbg', label: 'Debug', value: 'debug' }, 'Release'] },
            { id: 'flags', type: 'quickPick', canPickMany: true, items: ['-O2', '-g', '-Wall'] },
            { id: 'name', type: 'inputBox', prefix: 'v', suffix: '-rc' },
            { id: 'file', type: 'fileDialog' },
            { id: 'files', type: 'fileDialog', options: { canSelectMany: true } },
            { id: 'folder', type: 'folderDialog' },
            { id: 'ok', type: 'confirm' },
        ] as Task[];
        const raw = {
            target: 'dbg', flags: ['-g', '-Wall'], name: '1.2', file: 'src/main.c',
            files: ['src/main.c', 'src/util.c'], folder: 'src', ok: true,
        };
        const results = (inputs: Record<string, unknown>) => Object.fromEntries(tasks.map(task =>
            [task.id, inputResult(task, parseInputs(inputs), Object.create(null), root)]));
        const saved = results(raw);

        const exported = profileToCliInputs(profile(saved, tasks), tasks, root);
        assert.deepEqual(exported.skippedTaskIds, []);
        assert.deepEqual({ ...exported.inputs }, raw, 'workspace paths are written relative to the workspace');
        assert.deepEqual(results(JSON.parse(JSON.stringify(exported.inputs))), saved);
    });

    test('uses item ids where saved, labels otherwise, and skips a selection the task can no longer hold', () => {
        const tasks = [
            { id: 'mixed', type: 'quickPick', canPickMany: true, items: [{ id: 'a', label: 'A' }, 'B'] },
            { id: 'single', type: 'quickPick', items: ['x', 'y'] },
        ] as Task[];
        const exported = profileToCliInputs(profile({
            mixed: { value: 'A', label: 'A', labelList: ['A', 'B'], _itemIds: ['a', null] },
            // Saved while `single` still allowed several picks.
            single: { value: 'x', label: 'x', labelList: ['x', 'y'] },
        }, tasks), tasks, root);
        assert.deepEqual(exported.inputs.mixed, ['a', 'B']);
        assert.deepEqual(exported.skippedTaskIds, ['single']);
    });

    test('keeps paths outside the workspace absolute', () => {
        const tasks = [{ id: 'file', type: 'fileDialog' }] as Task[];
        const outside = path.join(os.tmpdir(), 'elsewhere.bin');
        const exported = profileToCliInputs(profile({ file: { path: outside, paths: [outside] } }, tasks), tasks, root);
        assert.equal(exported.inputs.file, outside);
    });

    test('reports values the CLI cannot reproduce and entries the action no longer has', () => {
        const tasks = [
            { id: 'tagged', type: 'inputBox', prefix: '${target.value}-' },
            { id: 'pick', type: 'quickPick', items: ['a'] },
            { id: 'mismatch', type: 'inputBox', prefix: 'v' },
            { id: 'pw', type: 'inputBox', password: true },
            { id: 'added', type: 'confirm' },
        ] as Task[];
        const saved = profile({
            tagged: { value: 'debug-1' },
            pick: { value: 'a', label: 'a' },
            mismatch: { value: 'x1' },
            removed: { value: 'gone' },
        }, [...tasks.slice(0, 3), { id: 'removed', type: 'inputBox' } as Task]);
        const exported = profileToCliInputs(saved, tasks, root);
        assert.deepEqual({ ...exported.inputs }, { pick: 'a' });
        assert.deepEqual(exported.skippedTaskIds.sort(), ['mismatch', 'tagged']);
        assert.deepEqual(exported.staleTaskIds, ['removed']);
        // Passwords are never saved and new tasks have no saved value; the CLI still needs both.
        assert.deepEqual(exported.promptTaskIds, ['added']);
        assert.deepEqual(exported.passwordTaskIds, ['pw']);
    });
});
