import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exportInputProfileForCli } from '../extension';
import type { NamedInputProfile } from '../inputProfiles';
import type { ActionItem } from '../schema';

suite('Input profile export command', () => {
    const window = vscode.window as unknown as Record<string, unknown>;
    const originals = { save: window.showSaveDialog, info: window.showInformationMessage, error: window.showErrorMessage };
    let directory: string;
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub export ')); });
    teardown(() => {
        window.showSaveDialog = originals.save;
        window.showInformationMessage = originals.info;
        window.showErrorMessage = originals.error;
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const action: ActionItem = { id: 'deploy', title: 'Deploy', action: { description: 'd', tasks: [
        { id: 'target', type: 'quickPick', items: ['dev', 'prod'] },
        { id: 'pw', type: 'inputBox', password: true },
        { id: 'added', type: 'confirm' },
    ] } } as ActionItem;
    const profile: NamedInputProfile = { id: 'p', actionId: 'deploy', name: 'prod run', createdAt: 0, updatedAt: 0,
        inputs: { target: { value: 'prod', label: 'prod' } }, taskTypes: { target: 'quickPick' } };

    test('saves the inputs file, names what still needs input and copies a runnable command', async () => {
        const target = path.join(directory, 'prod inputs.json');
        let offered: string | undefined;
        window.showSaveDialog = async () => vscode.Uri.file(target);
        window.showInformationMessage = async (message: string, ...items: string[]) => { offered = message; return items[0]; };
        await vscode.env.clipboard.writeText('');
        await exportInputProfileForCli(profile, action, true);

        assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { target: 'prod' });
        assert.ok(offered, 'a result message is shown');
        // The action is not from a workspace actions.json here, so the command asks for the preset file.
        assert.match(offered!, /--preset/);
        assert.match(offered!, /added/);
        assert.match(offered!, /pw/);
        const command = await vscode.env.clipboard.readText();
        assert.match(command, /^taskhub run deploy --preset .+ --trust --inputs-file /);
        // A path with a space is single-quoted, which neither PowerShell nor a POSIX shell expands.
        // VS Code reports the path in its own spelling (a lowercase drive letter on Windows).
        assert.ok(command.endsWith(`'${vscode.Uri.file(target).fsPath}'`), command);
    });

    test('explains why nothing is exported when actions.json could not be loaded', async () => {
        let error: string | undefined;
        window.showErrorMessage = async (message: string) => { error = message; return undefined; };
        await exportInputProfileForCli(profile, undefined, false);
        assert.match(error!, /actions\.json/);
    });
});
