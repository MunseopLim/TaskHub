import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { JenkinsClient } from '../jenkins/client';
import { JenkinsController } from '../jenkins/controller';
import { JenkinsLogDocument } from '../jenkins/logDocument';
import { createRequest } from '../jenkins/model';
import { JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY } from '../jenkins/storage';
import { parseJenkinsManifest, serverForUrl } from '../jenkins/tracking';
import { JenkinsRequest, JenkinsServer } from '../jenkins/types';

const server: JenkinsServer = { id: 'main', name: 'CI', url: 'https://ci.example/jenkins/', username: 'developer' };
const buildUrl = `${server.url}job/root/1/`;
function request(): JenkinsRequest {
    const value = createRequest({ id: 'request-id', branch: 'main', sha: 'a'.repeat(40), repoPath: '/fixture',
        root: { serverId: server.id, jobUrl: `${server.url}job/root/`, buildUrl } });
    value.runs = [{ serverId: server.id, jobUrl: value.root.jobUrl, url: buildUrl, number: 1, building: false, result: 'SUCCESS' }];
    value.stopped = true;
    return value;
}
function fixture(): { context: vscode.ExtensionContext; global: Map<string, unknown>; secretReads: () => number } {
    const global = new Map<string, unknown>([[JENKINS_SERVERS_KEY, [server]]]);
    const workspace = new Map<string, unknown>([[JENKINS_REQUESTS_KEY, [request()]]]);
    const memento = (values: Map<string, unknown>): vscode.Memento => ({
        get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
        update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()],
    } as vscode.Memento);
    let reads = 0;
    return { global, secretReads: () => reads, context: {
        globalState: memento(global), workspaceState: memento(workspace), subscriptions: [],
        secrets: { get: async () => { reads++; return 'fixture-token'; }, store: async () => {}, delete: async () => {},
            onDidChange: () => new vscode.Disposable(() => {}) },
    } as unknown as vscode.ExtensionContext };
}

suite('Jenkins security boundaries', () => {
    test('IT-245: links and manifests reject encoded escapes and contradictory request identities', () => {
        assert.strictEqual(serverForUrl([server], `${server.url}job/feature%252Freset/1/`), server);
        for (const path of ['%252e%252e%252foutside/1/', 'job/%00evil/1/', 'job/%3b/1/',
            'job/%253fsecret/1/', '../outside/1/']) {
            const url = server.url + path;
            assert.strictEqual(serverForUrl([server], url), undefined, path);
            assert.throws(() => parseJenkinsManifest(Buffer.from(JSON.stringify({ schemaVersion: 1,
                rootBuildUrl: buildUrl, complete: true, runs: [{ buildUrl: url }] })), request(), [server]));
        }
        const manifest = { schemaVersion: 1, rootBuildUrl: `${server.url}job/other/2/`, requestId: 'request-id', complete: true, runs: [] };
        assert.throws(() => parseJenkinsManifest(Buffer.from(JSON.stringify(manifest)), request(), [server]), /INVALID_MANIFEST/);
        manifest.rootBuildUrl = buildUrl;
        assert.strictEqual(parseJenkinsManifest(Buffer.from(JSON.stringify(manifest)), request(), [server]).complete, true);
    });

    test('IT-246: forged build command arguments cannot open a browser or retrieve a log', async () => {
        const state = fixture();
        const controller = new JenkinsController(state.context);
        const originalExternal = vscode.env.openExternal;
        const originalLog = JenkinsClient.prototype.getLog;
        let sideEffects = 0;
        try {
            (vscode.env as { openExternal: typeof originalExternal }).openExternal = async () => { sideEffects++; return true; };
            JenkinsClient.prototype.getLog = async () => { sideEffects++; return { text: '', nextStart: 0, more: false }; };
            const live = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            const node = { kind: 'build' as const, label: 'forged', request: live, run: { ...live.runs[0], url: `${server.url}manage/` } };
            await assert.rejects(controller.openRun(node), /JENKINS_INVALID_RUN/);
            await assert.rejects(controller.openLog(node), /JENKINS_INVALID_RUN/);
            assert.strictEqual(sideEffects, 0);
            assert.strictEqual(state.secretReads(), 0);
        } finally {
            controller.dispose();
            (vscode.env as { openExternal: typeof originalExternal }).openExternal = originalExternal;
            JenkinsClient.prototype.getLog = originalLog;
        }
    });

    test('IT-247: logs open as bounded virtual documents without untitled backup or URI metadata', async () => {
        const provider = new JenkinsLogDocument();
        const registration = vscode.workspace.registerTextDocumentContentProvider(provider.uri.scheme, provider);
        try {
            provider.setContent('fixture confidential log');
            const document = await vscode.workspace.openTextDocument(provider.uri);
            assert.strictEqual(document.isUntitled, false);
            assert.notStrictEqual(document.uri.scheme, 'file');
            assert.strictEqual(document.getText(), 'fixture confidential log');
            assert.ok(!document.uri.toString().includes('ci.example'));
            assert.strictEqual(provider.provideTextDocumentContent(provider.uri.with({ path: '/unknown' })), '');
            assert.throws(() => provider.setContent('x'.repeat(3 * 1024 * 1024 + 1)), /JENKINS_LOG_LIMIT/);
            provider.dispose();
            assert.strictEqual(provider.provideTextDocumentContent(provider.uri), '');
        } finally { registration.dispose(); provider.dispose(); }
    });

    test('IT-248: HTTP enrollment requires confirmation before asking for or saving credentials', async () => {
        const state = fixture();
        const controller = new JenkinsController(state.context);
        const originalInput = vscode.window.showInputBox;
        const originalWarning = vscode.window.showWarningMessage;
        const originalInformation = vscode.window.showInformationMessage;
        let accepted = false;
        let inputs = 0;
        try {
            (vscode.window as { showInputBox: typeof originalInput }).showInputBox = async () => ['Lab', 'http://ci.internal/jenkins/', 'developer', 'fixture-token'][inputs++];
            (vscode.window as { showWarningMessage: typeof originalWarning }).showWarningMessage =
                (async (_message: string, options: vscode.MessageOptions, ...items: string[]) => { assert.strictEqual(options.modal, true); return accepted ? items[0] : undefined; }) as typeof originalWarning;
            (vscode.window as { showInformationMessage: typeof originalInformation }).showInformationMessage = async () => undefined;
            const edit = controller as unknown as { editServer(): Promise<void> };
            await edit.editServer();
            assert.strictEqual(inputs, 2);
            assert.strictEqual((state.global.get(JENKINS_SERVERS_KEY) as JenkinsServer[]).length, 1);
            accepted = true; inputs = 0;
            await edit.editServer();
            const saved = (state.global.get(JENKINS_SERVERS_KEY) as JenkinsServer[]).find(item => item.name === 'Lab');
            assert.strictEqual(saved?.allowInsecureHttp, true);
            assert.strictEqual(inputs, 4);
        } finally {
            controller.dispose();
            (vscode.window as { showInputBox: typeof originalInput }).showInputBox = originalInput;
            (vscode.window as { showWarningMessage: typeof originalWarning }).showWarningMessage = originalWarning;
            (vscode.window as { showInformationMessage: typeof originalInformation }).showInformationMessage = originalInformation;
        }
    });
});
