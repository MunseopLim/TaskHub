import * as assert from 'assert';
import * as vscode from 'vscode';

suite('최소 지원 VS Code 호환성', () => {
    test('IT-308: 실제 배포 번들이 활성화되고 핵심 명령과 예제 문서를 제공한다', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension('Munseop.taskhub');
        assert.ok(extension, 'TaskHub must be installed in the test host');
        await extension.activate();
        assert.strictEqual(extension.isActive, true);
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['taskhub.stopAllActions', 'taskhub.showExampleJson', 'taskhub.openJsonEditor',
            'taskhub.showMemoryMap', 'taskhub.showHexViewer', 'taskhub.showWhatsNew']) {
            assert.ok(commands.includes(command), `Missing command: ${command}`);
        }
        await vscode.commands.executeCommand('taskhub.stopAllActions');
        await vscode.commands.executeCommand('taskhub.showExampleJson', 'actions');
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, 'The example command must open a real document');
        assert.ok(document.getText().includes('tasks'), 'The document must contain the bundled action example');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
});
