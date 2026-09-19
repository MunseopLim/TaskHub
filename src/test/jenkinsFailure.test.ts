import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { abortable, JenkinsClient } from '../jenkins/client';
import { JenkinsController, registerJenkins } from '../jenkins/controller';
import { createRequest } from '../jenkins/model';
import { JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY } from '../jenkins/storage';
import { JenkinsRequest, JenkinsServer } from '../jenkins/types';

suite('Jenkins failure containment in the extension host', () => {
    const servers: JenkinsServer[] = ['slow', 'healthy'].map(id => ({ id, name: id, url: `https://${id}.example/`, username: 'fixture' }));
    let controller: JenkinsController | undefined;
    const originalQueue = JenkinsClient.prototype.getQueue;
    const originalPick = vscode.window.showQuickPick;
    function fixture(): { context: vscode.ExtensionContext; values: Map<string, unknown>; secrets: vscode.EventEmitter<vscode.SecretStorageChangeEvent> } {
        const values = new Map<string, unknown>();
        const requests = servers.map(server => createRequest({ id: server.id, branch: 'firmware', sha: 'a'.repeat(40), repoPath: '/fixture',
            root: { serverId: server.id, jobUrl: `${server.url}job/fw/`, queueUrl: `${server.url}queue/item/1/` } }));
        values.set(JENKINS_REQUESTS_KEY, requests);
        const secrets = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
        const context = {
            subscriptions: [],
            globalState: { get: (key: string, fallback: unknown) => key === JENKINS_SERVERS_KEY ? servers : fallback, update: async () => {}, keys: () => [] },
            workspaceState: { get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
                update: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))); }, keys: () => [...values.keys()] },
            secrets: { get: async () => 'local-fixture-token', store: async () => {}, delete: async () => {}, onDidChange: secrets.event },
        } as unknown as vscode.ExtensionContext;
        return { context, values, secrets };
    }
    teardown(() => {
        controller?.dispose(); controller = undefined;
        JenkinsClient.prototype.getQueue = originalQueue;
        (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = originalPick;
    });

    test('IT-241: a hung controller does not block healthy polling and stopping tracking aborts its in-flight request', async () => {
        const data = fixture();
        let reached!: () => void;
        const healthyReached = new Promise<void>(resolve => { reached = resolve; });
        let slowCancelled = false;
        JenkinsClient.prototype.getQueue = async function (url) {
            if (url.includes('healthy.example')) { reached(); return { why: 'Healthy queue remains available' }; }
            const signal = (this as unknown as { signal: AbortSignal }).signal;
            try { return await abortable(new Promise<never>(() => {}), signal); }
            finally { slowCancelled = signal.aborted; }
        };
        (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = (async (items: unknown) =>
            (await items as Array<{ request?: JenkinsRequest }>).find(item => item.request?.id === 'slow')) as typeof originalPick;
        try {
            controller = new JenkinsController(data.context);
            const pending = controller.refresh();
            await healthyReached;
            await controller.stopTracking();
            await pending;
            assert.strictEqual(slowCancelled, true);
            const saved = data.values.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.find(request => request.id === 'slow')?.stopped, true);
            assert.strictEqual(saved.find(request => request.id === 'healthy')?.queueReason, 'Healthy queue remains available');
        } finally { data.secrets.dispose(); }
    });

    test('IT-242: persistence failure and one bad server stay local and a later refresh can recover', async () => {
        const data = fixture();
        const update = data.context.workspaceState.update.bind(data.context.workspaceState);
        let failStorage = true;
        data.context.workspaceState.update = async (key, value) => {
            if (failStorage) { throw new Error('fixture storage unavailable'); }
            await update(key, value);
        };
        JenkinsClient.prototype.getQueue = async url => {
            if (url.includes('slow.example')) { throw new Error('unexpected adapter error'); }
            return { why: 'Still healthy' };
        };
        const unhandled: unknown[] = [];
        const listener = (reason: unknown): void => { unhandled.push(reason); };
        process.on('unhandledRejection', listener);
        try {
            controller = new JenkinsController(data.context);
            await controller.refresh();
            failStorage = false;
            await controller.refresh();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepStrictEqual(unhandled, []);
            const saved = data.values.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.find(request => request.id === 'healthy')?.queueReason, 'Still healthy');
            assert.strictEqual(saved.find(request => request.id === 'slow')?.error, 'JENKINS_UNAVAILABLE');
        } finally { process.off('unhandledRejection', listener); data.secrets.dispose(); }
    });

    test('IT-243: disabling the controller interrupts a hung credential store without starting HTTP', async () => {
        const data = fixture();
        data.context.secrets.get = () => new Promise<string | undefined>(() => {});
        let calls = 0;
        JenkinsClient.prototype.getQueue = async () => { calls++; return {}; };
        try {
            controller = new JenkinsController(data.context);
            const pending = controller.refresh();
            controller.dispose();
            await pending;
            assert.strictEqual(calls, 0);
            await controller.refresh();
            assert.strictEqual(calls, 0);
        } finally { data.secrets.dispose(); }
    });

    test('IT-244: corrupt storage at activation is contained and does not prevent other extension commands', async () => {
        const data = fixture();
        const originalConfig = vscode.workspace.getConfiguration;
        const originalError = vscode.window.showErrorMessage;
        let registration: vscode.Disposable | undefined;
        let failures = 0;
        const unrelated = vscode.commands.registerCommand('taskhub.test.unrelatedJenkinsFailure', () => 42);
        try {
            (vscode.workspace as { getConfiguration: typeof originalConfig }).getConfiguration = ((section: string) => section === 'taskhub'
                ? { get: (key: string, fallback: unknown) => key === 'experimental.jenkins.enabled' ? true : fallback }
                : originalConfig(section)) as typeof originalConfig;
            (vscode.window as { showErrorMessage: typeof originalError }).showErrorMessage = (async () => { failures++; return undefined; }) as typeof originalError;
            data.context.workspaceState.get = () => { throw new Error('fixture corrupt database'); };
            assert.doesNotThrow(() => { registration = registerJenkins(data.context); });
            assert.strictEqual(failures, 1);
            assert.strictEqual(await vscode.commands.executeCommand('taskhub.test.unrelatedJenkinsFailure'), 42);
        } finally {
            registration?.dispose(); unrelated.dispose(); data.secrets.dispose();
            (vscode.workspace as { getConfiguration: typeof originalConfig }).getConfiguration = originalConfig;
            (vscode.window as { showErrorMessage: typeof originalError }).showErrorMessage = originalError;
        }
    });
});
