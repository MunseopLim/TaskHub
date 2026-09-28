import * as assert from 'node:assert';
import * as vscode from 'vscode';
import * as http from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { JenkinsClientError, JenkinsClient } from '../jenkins/client';
import { JenkinsController } from '../jenkins/controller';
import { JenkinsLogDocument } from '../jenkins/logDocument';
import { createRequest } from '../jenkins/model';
import { jenkinsConnectionDiagnostic } from '../jenkins/messages';
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
    test('IT-284: connection verification presents and copies localized safe diagnostics from a real HTTP denial', async () => {
        const pick = vscode.window.showQuickPick;
        const showError = vscode.window.showErrorMessage;
        const showInfo = vscode.window.showInformationMessage;
        const clipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard')!;
        const language = Object.getOwnPropertyDescriptor(vscode.env, 'language')!;
        const sockets = new Set<Socket>();
        const requests: string[] = [];
        let authenticated = false;
        const endpoint = http.createServer((request, response) => {
            requests.push(`${request.method} ${request.url}`);
            if (authenticated) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ authenticated: true, name: 'developer' }));
                return;
            }
            response.writeHead(403, {
                'Content-Type': 'text/html', 'X-Jenkins': '2.500',
                'X-You-Are-Authenticated-As': 'anonymous', 'X-Required-Permission': 'hudson.model.Hudson.Read',
                'Set-Cookie': 'private-session=fixture-token', Location: 'https://sso.example/fixture-token',
            });
            response.end('<html>fixture-token and private server trace</html>');
        });
        endpoint.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        let controller: JenkinsController | undefined;
        try {
            endpoint.listen(0, '127.0.0.1');
            await once(endpoint, 'listening');
            const address = endpoint.address();
            assert.ok(address && typeof address !== 'string');
            const url = `http://127.0.0.1:${address.port}/jenkins/`;
            for (const locale of ['ko', 'en']) {
                authenticated = false;
                Object.defineProperty(vscode.env, 'language', { configurable: true, value: locale });
                const state = fixture();
                state.global.set(JENKINS_SERVERS_KEY, [{ ...server, url, allowInsecureHttp: true }]);
                const originalState = JSON.stringify([...state.global]);
                controller = new JenkinsController(state.context);
                const reports: string[] = [];
                const copies: string[] = [];
                let copy = true;
                vscode.window.showQuickPick = (async (items: any) => (await items).find((item: any) => item.server || item.id === 'verify')) as typeof pick;
                vscode.window.showErrorMessage = (async (_message: string, options: vscode.MessageOptions, ...items: string[]) => {
                    assert.strictEqual(options.modal, true);
                    assert.ok(options.detail);
                    reports.push(options.detail);
                    assert.strictEqual(items[0], locale === 'ko' ? '진단 정보 복사' : 'Copy diagnostics');
                    return copy ? items[0] : undefined;
                }) as typeof showError;
                Object.defineProperty(vscode.env, 'clipboard', {
                    configurable: true, value: { writeText: async (value: string) => { copies.push(value); } },
                });
                await vscode.commands.executeCommand('taskhub.jenkins.manageServers');
                assert.strictEqual(reports.length, 1);
                assert.deepStrictEqual(copies, reports);
                const report = reports[0];
                assert.ok(report.includes(`GET ${url}whoAmI/api/json`));
                assert.ok(report.includes('403') && report.includes('Overall/Read') && report.includes('HTML'));
                assert.ok(report.includes(locale === 'ko' ? '익명 사용자' : 'Reported as anonymous'));
                assert.ok(report.includes(locale === 'ko' ? 'Job 조회·빌드 권한은 검사하지 않습니다' : 'does not test job read or build permissions'));
                for (const secret of ['fixture-token', 'private-session', 'sso.example', 'private server trace',
                    Buffer.from('developer:fixture-token').toString('base64')]) {
                    assert.ok(!report.includes(secret), 'Diagnostic output must omit response and credential data.');
                }
                copy = false;
                const requestCount = requests.length;
                await vscode.commands.executeCommand('taskhub.jenkins.manageServers');
                assert.strictEqual(requests.length, requestCount, 'A cached denial must not dispatch again.');
                assert.strictEqual(copies.length, 1, 'Dismissing diagnostics must not modify the clipboard.');
                assert.ok(reports[1].includes(locale === 'ko' ? 'HTTP 전송 전에 중단' : 'stopped before HTTP dispatch'));
                assert.strictEqual(JSON.stringify([...state.global]), originalState, 'Verification must not change saved server data.');
                controller.dispose(); controller = undefined;
                authenticated = true;
                const information: string[] = [];
                vscode.window.showInformationMessage = (async (message: string) => { information.push(message); return undefined; }) as typeof showInfo;
                controller = new JenkinsController(state.context);
                await vscode.commands.executeCommand('taskhub.jenkins.manageServers');
                assert.strictEqual(reports.length, 2, 'Successful identity checks must not display an error.');
                assert.strictEqual(information.length, 1);
                assert.ok(information[0].includes(locale === 'ko' ? 'Job 조회·빌드 권한은 별도 확인' : 'Job read and build permissions need a separate check'));
                controller.dispose(); controller = undefined;
            }
            assert.deepStrictEqual(requests, Array(4).fill('GET /jenkins/whoAmI/api/json'));
        } finally {
            controller?.dispose();
            vscode.window.showQuickPick = pick;
            vscode.window.showErrorMessage = showError;
            vscode.window.showInformationMessage = showInfo;
            Object.defineProperty(vscode.env, 'clipboard', clipboard);
            Object.defineProperty(vscode.env, 'language', language);
            for (const socket of sockets) { socket.destroy(); }
            if (endpoint.listening) { await new Promise<void>(resolve => endpoint.close(() => resolve())); }
        }
    });

    test('connection diagnostics do not expose arbitrary exceptions or invalid stored URLs', () => {
        const secret = 'credential-secret';
        const report = jenkinsConnectionDiagnostic(`https://user:${secret}@ci.example/?token=${secret}`, new Error(secret));
        assert.ok(!report.includes(secret));
        assert.ok(!report.includes('user:'));
    });

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
            await assert.rejects(controller.openRun(node), (error: unknown) => error instanceof JenkinsClientError && error.code === 'INVALID_RUN');
            await assert.rejects(controller.openLog(node), (error: unknown) => error instanceof JenkinsClientError && error.code === 'INVALID_RUN');
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
