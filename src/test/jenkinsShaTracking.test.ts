import * as assert from 'node:assert';
import * as http from 'node:http';
import { once } from 'node:events';
import * as vscode from 'vscode';
import { JenkinsClient, JenkinsClientError, JenkinsTransportGuard } from '../jenkins/client';
import { JenkinsController } from '../jenkins/controller';
import { createRequest, aggregate } from '../jenkins/model';
import { pollJenkinsRequest, safeJenkinsError, TrackingOptions } from '../jenkins/tracking';
import { jenkinsErrorLabel } from '../jenkins/messages';
import { JenkinsStore, JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY, jenkinsSecretKey } from '../jenkins/storage';
import { JenkinsRequest, JenkinsServer, jenkinsLimits } from '../jenkins/types';
import { matchesJenkinsSha } from '../jenkins/shaTracking';
import { discoveryLabel, JenkinsViewProvider } from '../providers/jenkinsViewProvider';

const sha = 'a'.repeat(40);
async function fixture(id: string) {
    const paths: string[] = [];
    const routes = new Map<string, { status: number; body: unknown }>();
    const held = new Map<string, { wait: Promise<void>; started(): void }>();
    const listener = http.createServer((req, res) => {
        assert.strictEqual(req.method, 'GET');
        const path = new URL(req.url!, 'http://localhost').pathname;
        paths.push(path);
        const send = () => {
            if (res.destroyed) { return; }
            const route = routes.get(path) ?? { status: 404, body: {} };
            res.writeHead(route.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(route.body));
        };
        const gate = held.get(path);
        if (gate) { gate.started(); void gate.wait.then(send); } else { send(); }
    });
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const address = listener.address(); assert.ok(address && typeof address !== 'string');
    const server: JenkinsServer = { id, name: id, username: 'test', url: `http://127.0.0.1:${address.port}/`, allowInsecureHttp: true };
    const job = { serverId: id, jobUrl: `${server.url}job/test/`, name: `${id}/test` };
    const build = (number: number, building = false, revision = sha) => ({ url: `${job.jobUrl}${number}/`, number, building,
        result: building ? null : 'SUCCESS', actions: [{ lastBuiltRevision: { SHA1: revision } }] });
    const reply = (path: string, body: unknown, status = 200) => routes.set(path, { body, status });
    const close = async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); };
    const hold = (path: string) => {
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        held.set(path, { wait: new Promise<void>(resolve => { release = resolve; }), started });
        return { release, ready };
    };
    return { server, job, build, reply, paths, close, hold };
}
function context(servers: JenkinsServer[], requests: JenkinsRequest[]) {
    const state = new Map<string, unknown>([[JENKINS_REQUESTS_KEY, requests], [JENKINS_SERVERS_KEY, servers]]);
    const memento = { get: <T>(key: string, fallback?: T): T => (state.get(key) ?? fallback) as T,
        update: async (key: string, value: unknown) => { state.set(key, JSON.parse(JSON.stringify(value))); }, keys: () => [...state.keys()] };
    return { state, context: { workspaceState: memento, globalState: memento, subscriptions: [], secrets: {
        get: async (key: string) => servers.some(server => jenkinsSecretKey(server) === key) ? 'token' : undefined,
        onDidChange: () => new vscode.Disposable(() => {}),
    } } as unknown as vscode.ExtensionContext };
}

suite('Jenkins SHA observations', function () {
    this.timeout(15000);
    let a: Awaited<ReturnType<typeof fixture>>;
    let b: Awaited<ReturnType<typeof fixture>>;
    let originalNow: typeof Date.now;
    let now: number;
    let originalMessage: typeof vscode.window.showInformationMessage;
    let originalWarning: typeof vscode.window.showWarningMessage;
    setup(async () => {
        originalNow = Date.now; now = originalNow(); Date.now = () => now;
        originalMessage = vscode.window.showInformationMessage; originalWarning = vscode.window.showWarningMessage;
        vscode.window.showInformationMessage = (async () => undefined) as typeof originalMessage;
        vscode.window.showWarningMessage = (async (_message: string, options: unknown, choice?: string) =>
            (options as vscode.MessageOptions)?.modal ? choice : undefined) as typeof originalWarning;
        a = await fixture('A'); b = await fixture('B');
    });
    teardown(async () => {
        Date.now = originalNow; vscode.window.showInformationMessage = originalMessage; vscode.window.showWarningMessage = originalWarning;
        await Promise.all([a.close(), b.close()]);
    });
    function request(): JenkinsRequest {
        const value = createRequest({ repoPath: '/firmware', branch: 'feature', sha, root: { serverId: a.server.id, jobUrl: a.job.jobUrl } });
        value.shaTracking = { jobs: [{ ...a.job }, { ...b.job }], cursor: 0, readOnly: true };
        return value;
    }
    function options(): TrackingOptions {
        return { servers: [a.server, b.server], client: async server => new JenkinsClient(server, { token: 'token' }),
            discover: true, recentBuildLimit: 20, manifestArtifact: 'taskhub-jenkins-runs.json' };
    }
    test('review regression: server discovery failure leaves healthy tests selectable and reports the failed server', async () => {
        a.reply('/api/json', {}, 403);
        b.reply('/api/json', { jobs: [{ name: 'test', fullName: 'test', url: b.job.jobUrl, buildable: true, _class: 'hudson.model.FreeStyleProject' }] });
        const data = context([a.server, b.server], []); const controller = new JenkinsController(data.context);
        const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox;
        const warnings: string[] = [];
        vscode.window.showWarningMessage = (async (message: string) => { warnings.push(message); }) as typeof originalWarning;
        vscode.window.showQuickPick = (async (items: unknown) => {
            const available = await items as Array<{ label: string }>;
            assert.strictEqual(available.length, 1); assert.ok(available[0].label.startsWith('B ·'));
            return available;
        }) as unknown as typeof pick;
        vscode.window.showInputBox = async () => '';
        try {
            const selected = await (controller as unknown as { selectTestJobs(profile: { serverId: string; jobUrl: string }): Promise<unknown[]> })
                .selectTestJobs({ serverId: '__sha__', jobUrl: '/repo' });
            assert.strictEqual(selected.length, 1);
            assert.ok(warnings.some(message => message.includes('A:') && message.includes('Access denied')));
            assert.strictEqual(a.paths.length, 1); assert.strictEqual(b.paths.length, 1);
        } finally { controller.dispose(); vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; }
    });
    test('review regression: legacy bounded discovery settles provisionally and never changes to a timeout', async () => {
        const value = request(); delete value.shaTracking; value.root.buildUrl = a.build(1).url;
        a.reply('/job/test/1/api/json', a.build(1));
        await pollJenkinsRequest(value, { ...options(), inventory: { candidates: [], failures: [], continuing: false, limited: false } });
        assert.ok(value.settledAt); assert.strictEqual(aggregate(value).observedResult, 'passed');
        assert.strictEqual(aggregate(value).allPassed, false); assert.strictEqual(value.discovery.complete, false);
        const calls = a.paths.length;
        now += 25 * 3600000;
        await pollJenkinsRequest(value, options());
        assert.strictEqual(value.outcome, 'complete'); assert.strictEqual(a.paths.length, calls);
    });
    test('review regression: legacy report deferral preserves the frozen core and its checkout SHA', async () => {
        const value = request(); delete value.shaTracking; value.root.buildUrl = a.build(1).url;
        a.reply('/job/test/1/api/json', a.build(1));
        const budget = { remaining: 1 };
        const settings = { ...options(), inventory: { candidates: [], failures: [], continuing: false, limited: false },
            client: async (server: JenkinsServer) => new JenkinsClient(server, { token: 'token', budget }) };
        await pollJenkinsRequest(value, settings);
        assert.ok(value.runs[0].coreCompletedAt); assert.strictEqual(value.runs[0].finalizedAt, undefined);
        assert.strictEqual(value.runs[0].reportErrors, undefined); assert.strictEqual(value.settledAt, undefined);
        budget.remaining = 2; await pollJenkinsRequest(value, settings);
        assert.strictEqual(value.runs[0].actualSha, sha); assert.ok(value.settledAt);
        assert.strictEqual(a.paths.filter(path => path === '/job/test/1/api/json').length, 1);
    });
    for (const status of [401, 403]) {
        test(`review regression: cached HTTP ${status} postpones reports without spending their quota`, async () => {
            const value = request(); value.shaTracking!.jobs = [{ ...a.job, buildUrl: a.build(1).url }];
            value.runs = [{ ...a.build(1), ...a.job, correlation: 'sha', coreCompletedAt: now, actualSha: sha }];
            const guard = new JenkinsTransportGuard(() => now, () => 0);
            const budget = { remaining: 10 };
            const client = new JenkinsClient(a.server, { token: 'token', guard, budget });
            const path = status === 401 ? '/whoAmI/api/json' : '/job/test/1/wfapi/describe';
            a.reply(path, {}, status);
            await assert.rejects(status === 401 ? client.verify() : client.getStages(a.build(1).url));
            await pollJenkinsRequest(value, { ...options(), client: async () => client });
            assert.strictEqual(value.runs[0].reportErrors, undefined); assert.strictEqual(value.settledAt, undefined);
            assert.strictEqual(budget.remaining, 9); assert.strictEqual(a.paths.length, 1);
            now += 600000; a.reply(path, {}, 404);
            await pollJenkinsRequest(value, { ...options(), client: async () => client });
            assert.ok(value.settledAt); assert.strictEqual(value.runs[0].actualSha, sha);
            assert.strictEqual(budget.remaining, 7);
        });
    }
    test('review regression: observed failure stays prominent after expiry and refresh explains its cadence', async () => {
        const value = request();
        a.reply('/job/test/api/json', { builds: [{ ...a.build(1), result: 'FAILURE' }] }); b.reply('/job/test/api/json', { builds: [] });
        const messages: string[] = [];
        vscode.window.showInformationMessage = (async (message: string) => { messages.push(message); }) as typeof originalMessage;
        vscode.window.showWarningMessage = (async (message: string) => { messages.push(message); }) as typeof originalWarning;
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            await vscode.commands.executeCommand('taskhub.jenkins.refresh');
            const calls = a.paths.length + b.paths.length;
            await vscode.commands.executeCommand('taskhub.jenkins.refresh');
            assert.strictEqual(a.paths.length + b.paths.length, calls);
            assert.ok(messages.some(message => message.includes('Next automatic check:')));
            now = value.deadlineAt!;
            await controller.refresh();
            assert.ok(messages.some(message => message.includes('FAIL') && message.includes('Observation timed out')));
            const internal = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            const provider = new JenkinsViewProvider(() => [internal], () => [a.server, b.server]);
            try {
                const shaNode = provider.getChildren(provider.getChildren()[0])[0];
                const node = provider.getChildren(shaNode)[0];
                assert.ok(node.label.startsWith('FAIL'));
                assert.match(node.description!, /Observation timed out/);
                assert.strictEqual((provider.getTreeItem(shaNode).iconPath as vscode.ThemeIcon).id, 'error');
                assert.strictEqual(provider.getTreeItem(node).contextValue, 'jenkinsRequest');
            } finally { provider.dispose(); }
        } finally { controller.dispose(); }
    });
    test('review regression: a local backoff defers unread reports without freezing a false failure', async () => {
        const value = request(); value.shaTracking!.jobs = [{ ...a.job }];
        a.reply('/job/test/api/json', { builds: [a.build(1)] });
        a.reply('/job/test/1/wfapi/describe', {}, 503);
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const budget = { remaining: 20 };
        const settings = { ...options(), client: async (server: JenkinsServer) => new JenkinsClient(server, { token: 'token', guard, budget }) };
        await pollJenkinsRequest(value, settings);
        assert.strictEqual(value.runs[0].reportErrors?.stages, 'HTTP_ERROR');
        assert.strictEqual(value.runs[0].reportErrors?.tests, undefined);
        assert.strictEqual(value.runs[0].finalizedAt, undefined);
        assert.strictEqual(value.settledAt, undefined);
        assert.strictEqual(budget.remaining, 18, 'Only the two actual HTTP attempts use the budget.');
        now += 600000;
        await pollJenkinsRequest(value, settings);
        assert.ok(value.settledAt && value.runs[0].finalizedAt);
        assert.strictEqual(a.paths.filter(path => path.endsWith('/wfapi/describe')).length, 1);
        assert.strictEqual(a.paths.filter(path => path.endsWith('/testReport/api/json')).length, 1);
        assert.strictEqual(a.paths.filter(path => path === '/job/test/api/json').length, 1);
    });
    test('review regression: exact checkout SHA survives SSH/Gerrit remote aliases and multiple checkouts', () => {
        const value = request(); value.repoRemote = 'ssh://git.example:29418/team/firmware';
        const build: import('../jenkins/types').JenkinsBuild = a.build(1);
        build.actions = [
            { lastBuiltRevision: { SHA1: 'b'.repeat(40) }, remoteUrls: ['https://git.example/tools'] },
            { lastBuiltRevision: { SHA1: sha }, remoteUrls: ['https://git.example/a/team/firmware'] },
        ];
        assert.strictEqual(matchesJenkinsSha(build, value, a.job), true);
    });
    test('review regression: expired queue identifies a coordinator by queue ID without SCM data', async () => {
        const value = request(); value.shaTracking = { jobs: [{ ...a.job, afterBuild: 1 }], cursor: 0, readOnly: false };
        value.root.queueUrl = `${a.server.url}queue/item/42/`;
        a.reply('/job/test/api/json', { builds: [{ ...a.build(2), actions: [], queueId: 42 }] });
        await pollJenkinsRequest(value, options());
        assert.strictEqual(value.root.buildUrl, a.build(2).url);
        assert.ok(value.settledAt);
        assert.strictEqual(aggregate(value).allPassed, true);
    });
    test('review regression: pending POST does not consume the first observation cadence', async () => {
        const value = request();
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            const internal = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            internal.submission = 'sending';
            await controller.refresh();
            assert.strictEqual(internal.nextPollAt, undefined);
            assert.strictEqual(a.paths.length + b.paths.length, 0);
            delete internal.submission;
            a.reply('/job/test/api/json', { builds: [a.build(1)] }); b.reply('/job/test/api/json', { builds: [b.build(1)] });
            await controller.refresh();
            assert.ok(internal.settledAt, 'The first GET round starts as soon as submission finishes.');
        } finally { controller.dispose(); }
    });
    test('review regression: expiry during a GET records exactly one completion notification', async () => {
        const value = request(); value.deadlineAt = now + 10000;
        const gate = a.hold('/job/test/api/json'); a.reply('/job/test/api/json', { builds: [a.build(1)] });
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            const pending = controller.refresh(); await gate.ready; now += 10001; gate.release(); await pending;
            const internal = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            assert.strictEqual(internal.outcome, 'timeout');
            assert.strictEqual(internal.notified.complete, true);
            await controller.refresh();
            assert.strictEqual(internal.notified.complete, true);
        } finally { gate.release(); controller.dispose(); }
    });
    test('review regression: stopping a completed request preserves its PASS', async () => {
        const value = request();
        a.reply('/job/test/api/json', { builds: [a.build(1)] }); b.reply('/job/test/api/json', { builds: [b.build(1)] });
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            await controller.refresh();
            const internal = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            assert.strictEqual(aggregate(internal).allPassed, true);
            await controller.stopTracking({ kind: 'request', label: '', request: internal });
            assert.strictEqual(aggregate(internal).allPassed, true);
        } finally { controller.dispose(); }
    });
    test('IT-264: two controllers match SHA, freeze build URLs, and never read completed executions again', async () => {
        const value = request();
        a.reply('/job/test/api/json', { builds: [a.build(9, false, 'b'.repeat(40)), a.build(1)] });
        b.reply('/job/test/api/json', { builds: [b.build(7, true)] });
        await pollJenkinsRequest(value, options());
        assert.strictEqual(value.runs.length, 2);
        assert.strictEqual(aggregate(value).counts.passed, 1);
        assert.strictEqual(value.settledAt, undefined);
        const countA = a.paths.length;
        b.reply('/job/test/api/json', { builds: [b.build(8)] }); // A newer execution must not replace #7.
        b.reply('/job/test/7/api/json', b.build(7));
        await pollJenkinsRequest(value, options());
        assert.strictEqual(a.paths.length, countA);
        assert.ok(value.runs.some(run => run.url === b.build(7).url));
        assert.ok(aggregate(value).allPassed);
        assert.ok(value.settledAt);
        const total = a.paths.length + b.paths.length;
        await pollJenkinsRequest(value, options());
        assert.strictEqual(a.paths.length + b.paths.length, total);
        assert.ok(!a.paths.includes('/api/json') && !b.paths.includes('/api/json'), 'Polling must not scan server inventory.');
    });
    test('IT-265: missing terminal reports end verification once and survive restart without retry', async () => {
        const value = request();
        a.reply('/job/test/api/json', { builds: [a.build(1)] }); b.reply('/job/test/api/json', { builds: [b.build(7)] });
        b.reply('/job/test/7/testReport/api/json', {}, 403);
        await pollJenkinsRequest(value, options());
        assert.strictEqual(value.outcome, 'incomplete'); assert.ok(value.settledAt);
        assert.strictEqual(aggregate(value).counts.passed, 2); assert.strictEqual(aggregate(value).allPassed, false);
        const data = context([a.server, b.server], [value]); const store = new JenkinsStore(data.context);
        await store.saveRequests([value], 50);
        const restored = store.requests()[0];
        assert.ok(restored.runs.every(run => run.finalizedAt));
        const before = a.paths.length + b.paths.length;
        await pollJenkinsRequest(restored, options());
        assert.strictEqual(a.paths.length + b.paths.length, before);
    });
    test('IT-266: 10/20 minute cadence, extended deadline, and expiry before any HTTP even after errors', async () => {
        const value = request(); value.deadlineAt = now + 3 * 3600000;
        a.reply('/job/test/api/json', { builds: [a.build(1, true)] });
        b.reply('/job/test/api/json', {}, 503);
        a.reply('/job/test/1/api/json', a.build(1, true));
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            await controller.refresh();
            const calls = a.paths.length + b.paths.length;
            now += 9 * 60000; await controller.refresh();
            assert.strictEqual(a.paths.length + b.paths.length, calls);
            now += 60000; await controller.refresh();
            assert.ok(a.paths.length + b.paths.length > calls);
            now = value.createdAt + 3600000; await controller.refresh();
            let saved = (data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0];
            assert.strictEqual(saved.nextPollAt, now + 20 * 60000);
            const atHour = a.paths.length + b.paths.length;
            now += 19 * 60000; await controller.refresh(); assert.strictEqual(a.paths.length + b.paths.length, atHour);
            now = value.createdAt + 2 * 3600000; await controller.refresh();
            saved = (data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0]; assert.strictEqual(saved.stopped, undefined);
            now = value.deadlineAt;
            const beforeExpiry = a.paths.length + b.paths.length;
            await controller.refresh(); await controller.refresh();
            saved = (data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0];
            assert.strictEqual(saved.outcome, 'timeout'); assert.ok(saved.stopped && saved.settledAt);
            assert.strictEqual(a.paths.length + b.paths.length, beforeExpiry);
        } finally { controller.dispose(); }
    });
    test('IT-267: clear one/all removes persisted rows and never cancels or rechecks Jenkins builds', async () => {
        const one = request(); const two = request(); two.sha = 'b'.repeat(40);
        a.reply('/job/test/api/json', { builds: [] }); b.reply('/job/test/api/json', { builds: [] });
        const data = context([a.server, b.server], [one, two]); const controller = new JenkinsController(data.context);
        try {
            await controller.refresh();
            const internal = (controller as unknown as { requests: JenkinsRequest[] }).requests;
            const id = internal[0].id;
            await controller.clearResults({ kind: 'request', label: '', request: internal[0] });
            let saved = data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.length, 1); assert.notStrictEqual(saved[0].id, id);
            await controller.clearResults();
            const before = a.paths.length + b.paths.length;
            now += 3600000; await controller.refresh();
            saved = data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.length, 0); assert.strictEqual(a.paths.length + b.paths.length, before);
        } finally { controller.dispose(); }
    });
    test('IT-268: shared HTTP budget bounds multiple SHAs and persisted cadence prevents reload bursts', async () => {
        const value = request();
        value.shaTracking!.jobs = Array.from({ length: 100 }, (_, i) => ({ ...a.job, jobUrl: `${a.server.url}job/test${i}/` }));
        for (let i = 0; i < 100; i++) { a.reply(`/job/test${i}/api/json`, { builds: [] }); }
        const second = structuredClone(value); second.id += '-second'; second.sha = 'b'.repeat(40);
        const data = context([a.server, b.server], [value, second]); let controller = new JenkinsController(data.context);
        try {
            await controller.refresh(); assert.strictEqual(a.paths.length, jenkinsLimits.pollHttpBudget);
            controller.dispose(); controller = new JenkinsController(data.context);
            await controller.refresh(); assert.strictEqual(a.paths.length, jenkinsLimits.pollHttpBudget);
            now += 10 * 60000; await controller.refresh();
            now += 10 * 60000; await controller.refresh();
            assert.ok(a.paths.includes('/job/test99/api/json'), 'Budget continuation must reach later jobs.');
            assert.ok(a.paths.length <= 3 * jenkinsLimits.pollHttpBudget);
        } finally { controller.dispose(); }
    });
    test('IT-269: submission baseline excludes old SHA runs and configured SHA parameters do not override a known mismatch', async () => {
        const value = request(); value.shaTracking!.jobs = [{ ...a.job, afterBuild: 7 }];
        a.reply('/job/test/api/json', { builds: [a.build(7)] });
        await pollJenkinsRequest(value, options()); assert.strictEqual(value.runs.length, 0);
        a.reply('/job/test/api/json', { builds: [a.build(8)] });
        await pollJenkinsRequest(value, options()); assert.strictEqual(value.runs[0].number, 8);
        const candidate = a.build(9, false, 'b'.repeat(40));
        assert.strictEqual(matchesJenkinsSha({ ...candidate, actions: [...candidate.actions, { parameters: [{ name: 'SHA', value: sha }] }] }, value, { ...a.job, shaParameter: 'SHA' }), false);
        assert.strictEqual(matchesJenkinsSha({ ...candidate, actions: [{ parameters: [{ name: 'SHA', value: sha }] }] }, value, { ...a.job, shaParameter: 'SHA' }), true);
    });
    test('IT-270: stopped observations preserve known pass evidence while timeout remains a distinct failure', () => {
        const value = request(); value.shaTracking!.jobs = [a.job];
        value.runs = [{ ...a.build(1), ...a.job, finalizedAt: now, correlation: 'sha' }];
        value.stopped = true;
        assert.strictEqual(aggregate(value).observedResult, 'passed');
        const provider = new JenkinsViewProvider(() => [value], () => [a.server]);
        try {
            const row = () => provider.getChildren(provider.getChildren(provider.getChildren()[0])[0])[0];
            assert.match(row().label, /Provisional pass/);
            value.outcome = 'timeout'; value.error = 'JENKINS_TRACKING_TIMEOUT';
            assert.match(row().label, /Observation timed out/);
            assert.match(row().description!, /1\/1/);
        } finally { provider.dispose(); }
    });
    test('IT-271: explicit recheck starts a separate read-only observation using the configured timeout', async () => {
        const old = request(); old.stopped = true; old.settledAt = now; old.outcome = 'timeout'; old.error = 'JENKINS_TRACKING_TIMEOUT';
        a.reply('/job/test/api/json', { builds: [a.build(1)] }); b.reply('/job/test/api/json', { builds: [b.build(7)] });
        const data = context([a.server, b.server], [old]); const controller = new JenkinsController(data.context);
        const originalPick = vscode.window.showQuickPick;
        const originalConfig = vscode.workspace.getConfiguration;
        try {
            vscode.window.showQuickPick = (async (input: unknown) => (await input as unknown[])[0]) as typeof originalPick;
            vscode.workspace.getConfiguration = ((section?: string, ...args: unknown[]) => {
                const actual = originalConfig.call(vscode.workspace, section, args[0] as vscode.ConfigurationScope);
                if (section !== 'taskhub') { return actual; }
                return { ...actual, get: (key: string, fallback: unknown) => key === 'jenkins.trackingTimeoutHours' ? 6 : actual.get(key, fallback) };
            }) as typeof originalConfig;
            const previous = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            await controller.refresh(); assert.strictEqual(a.paths.length + b.paths.length, 0);
            await controller.trackSha({ kind: 'request', label: '', request: previous });
            const saved = data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.length, 2);
            const latest = saved.find(item => item.id !== old.id)!;
            assert.strictEqual(latest.deadlineAt, latest.createdAt + 6 * 3600000);
            assert.ok(latest.shaTracking?.readOnly && latest.settledAt && aggregate(latest).allPassed);
            assert.strictEqual(saved.find(item => item.id === old.id)?.outcome, 'timeout');
        } finally { controller.dispose(); vscode.window.showQuickPick = originalPick; vscode.workspace.getConfiguration = originalConfig; }
    });
    test('review regression: rechecking a submitted request discards old baselines and finalized job URLs', async () => {
        const old = request(); old.stopped = true; old.settledAt = now; old.outcome = 'timeout'; old.error = 'JENKINS_TRACKING_TIMEOUT';
        old.shaTracking!.readOnly = false;
        old.shaTracking!.jobs = old.shaTracking!.jobs.map(job => ({ ...job, afterBuild: 500, buildUrl: job.jobUrl + '500/', finalizedAt: now, error: 'NOT_FOUND' }));
        a.reply('/job/test/api/json', { builds: [a.build(1)] }); b.reply('/job/test/api/json', { builds: [b.build(7)] });
        const data = context([a.server, b.server], [old]); const controller = new JenkinsController(data.context);
        const originalPick = vscode.window.showQuickPick;
        const originalConfig = vscode.workspace.getConfiguration;
        try {
            vscode.window.showQuickPick = (async (input: unknown) => (await input as unknown[])[0]) as typeof originalPick;
            vscode.workspace.getConfiguration = ((section?: string, ...args: unknown[]) => {
                const actual = originalConfig.call(vscode.workspace, section, args[0] as vscode.ConfigurationScope);
                if (section !== 'taskhub') { return actual; }
                return { ...actual, get: (key: string, fallback: unknown) => key === 'jenkins.trackingTimeoutHours' ? 6 : actual.get(key, fallback) };
            }) as typeof originalConfig;
            const previous = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            await controller.refresh(); assert.strictEqual(a.paths.length + b.paths.length, 0);
            await controller.trackSha({ kind: 'request', label: '', request: previous });
            const saved = data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(saved.length, 2);
            const latest = saved.find(item => item.id !== old.id)!;
            assert.ok(latest.shaTracking!.jobs.every(job => job.afterBuild === undefined && job.error === undefined && job.finalizedAt === undefined));
            assert.ok(latest.runs.every(run => run.number < 500));
            assert.strictEqual(latest.deadlineAt, latest.createdAt + 6 * 3600000);
            assert.ok(latest.shaTracking?.readOnly && latest.settledAt && aggregate(latest).allPassed);
            assert.strictEqual(saved.find(item => item.id === old.id)?.outcome, 'timeout');
        } finally { controller.dispose(); vscode.window.showQuickPick = originalPick; vscode.workspace.getConfiguration = originalConfig; }
    });
    test('IT-272: clearing an in-flight request aborts HTTP and a late response cannot resurrect history', async () => {
        const value = request(); const gate = a.hold('/job/test/api/json');
        a.reply('/job/test/api/json', { builds: [a.build(1)] });
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            const pending = controller.refresh(); await gate.ready;
            await controller.clearResults(); gate.release(); await pending;
            assert.deepStrictEqual(data.state.get(JENKINS_REQUESTS_KEY), []);
            assert.strictEqual(b.paths.length, 0);
            now += 3600000; await controller.refresh();
            assert.strictEqual(a.paths.length, 1);
            assert.deepStrictEqual(data.state.get(JENKINS_REQUESTS_KEY), []);
        } finally { gate.release(); controller.dispose(); }
    });
    test('IT-273: oversized selected scopes are reclaimed without a permanently failing save', async () => {
        const values = Array.from({ length: 20 }, () => {
            const value = request();
            value.shaTracking!.jobs = Array.from({ length: 100 }, (_, i) => ({ ...a.job,
                jobUrl: `${a.server.url}job/${'x'.repeat(3900)}${i}/`, name: 'n'.repeat(3900) }));
            return value;
        });
        const data = context([a.server], values); const store = new JenkinsStore(data.context);
        const saved = await store.saveRequests(values, 50);
        assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= jenkinsLimits.maxStoredBytes);
        assert.ok(saved.some(value => value.stopped && value.error === 'JENKINS_STORAGE_LIMIT' && !value.shaTracking));
        assert.ok(saved.every(value => !aggregate(value).allPassed));
        await store.saveRequests(saved, 50);
        assert.ok(store.requests().length > 0);
    });
    test('IT-274: cancellation defers reports across restart without re-querying a terminal core', async () => {
        const value = request(); value.shaTracking!.jobs = [a.job];
        assert.strictEqual(value.deadlineAt, value.createdAt + 2 * 3600000);
        a.reply('/job/test/api/json', { builds: [a.build(1)] });
        const abort = new AbortController();
        const client = new JenkinsClient(a.server, { token: 'token' });
        client.getStages = async () => { abort.abort(); throw new JenkinsClientError('CANCELLED'); };
        await pollJenkinsRequest(value, { ...options(), signal: abort.signal, client: async () => client });
        assert.ok(value.runs[0].coreCompletedAt); assert.strictEqual(value.runs[0].finalizedAt, undefined);
        assert.strictEqual(aggregate(value).allPassed, false);
        const data = context([a.server], [value]); const store = new JenkinsStore(data.context);
        await store.saveRequests([value]); const restored = store.requests()[0];
        a.reply('/job/test/1/testReport/api/json', {}, 403);
        const before = a.paths.length;
        await pollJenkinsRequest(restored, options());
        assert.strictEqual(restored.outcome, 'incomplete'); assert.ok(restored.settledAt);
        assert.strictEqual(aggregate(restored).allPassed, false);
        assert.deepStrictEqual(a.paths.slice(before), ['/job/test/1/wfapi/describe', '/job/test/1/testReport/api/json']);
        await pollJenkinsRequest(restored, options()); assert.strictEqual(a.paths.length, before + 2);
    });

    test('IT-275: queued, uncertain, and inaccessible root submissions cannot block another server', async () => {
        for (const state of ['queued', 'uncertain', 'credentials', 'removed'] as const) {
            const value = request(); value.shaTracking!.readOnly = false;
            value.shaTracking!.jobs.forEach(job => { job.afterBuild = 7; });
            if (state !== 'uncertain') { value.root.queueUrl = `${a.server.url}queue/item/42/`; }
            else { value.submission = 'unconfirmed'; }
            a.reply('/queue/item/42/api/json', { id: 42, why: 'Waiting for fixture' });
            a.reply('/job/test/api/json', { builds: [a.build(7)] });
            b.reply('/job/test/api/json', { builds: [b.build(8)] });
            const opts = options();
            if (state === 'removed') { opts.servers = [b.server]; }
            if (state === 'credentials') {
                opts.client = async server => {
                    if (server.id === a.server.id) { throw new JenkinsClientError('AUTH_REQUIRED'); }
                    return new JenkinsClient(server, { token: 'token' });
                };
            }
            await pollJenkinsRequest(value, opts);
            assert.ok(value.runs.some(run => run.serverId === b.server.id && run.finalizedAt), state);
            assert.ok(!value.runs.some(run => run.serverId === a.server.id), 'Old root SHA must never satisfy a new submission.');
            assert.strictEqual(discoveryLabel(value), '1/2 selected tests observed');
            if (state === 'removed') { assert.strictEqual(value.outcome, 'incomplete'); assert.ok(value.settledAt); }
            if (state === 'uncertain') {
                a.reply('/job/test/api/json', { builds: [a.build(8)] });
                await pollJenkinsRequest(value, opts);
                assert.ok(value.settledAt && aggregate(value).allPassed);
                assert.strictEqual(value.submission, undefined);
                assert.strictEqual(value.root.buildUrl, a.build(8).url);
            }
        }
    });

    test('IT-276: ACTIVE_LIMIT has its intended user-facing message', () => {
        const code = safeJenkinsError(new Error('JENKINS_ACTIVE_LIMIT'));
        assert.strictEqual(code, 'JENKINS_ACTIVE_LIMIT');
        assert.notStrictEqual(jenkinsErrorLabel(code), jenkinsErrorLabel('JENKINS_UNAVAILABLE'));
        assert.ok(!jenkinsErrorLabel(code).includes('JENKINS_'));
    });

    test('IT-277: legacy deadline migration retains 24 hours or the explicit 168-hour setting', async () => {
        const originalConfig = vscode.workspace.getConfiguration;
        try {
            for (const hours of [undefined, 168]) {
                const value = request(); value.createdAt = now - 3 * 3600000; delete value.deadlineAt;
                a.reply('/job/test/api/json', { builds: [] }); b.reply('/job/test/api/json', { builds: [] });
                vscode.workspace.getConfiguration = ((section?: string, ...args: unknown[]) => {
                    const actual = originalConfig.call(vscode.workspace, section, args[0] as vscode.ConfigurationScope);
                    return section !== 'taskhub' ? actual : { ...actual,
                        inspect: (key: string) => key === 'jenkins.trackingTimeoutHours'
                            ? { key, defaultValue: 2, globalValue: hours } : actual.inspect(key) };
                }) as typeof originalConfig;
                const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
                try {
                    await controller.refresh();
                    const saved = (data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0];
                    assert.strictEqual(saved.deadlineAt, value.createdAt + (hours ?? 24) * 3600000);
                    assert.strictEqual(saved.outcome, undefined);
                    assert.strictEqual(new JenkinsStore(data.context).requests(2)[0].deadlineAt, saved.deadlineAt);
                } finally { controller.dispose(); }
            }
        } finally { vscode.workspace.getConfiguration = originalConfig; }
    });

    test('IT-278: cancelling clear-all preserves active observations and history', async () => {
        const value = request(); value.nextPollAt = now + 600000;
        const data = context([a.server, b.server], [value]); const controller = new JenkinsController(data.context);
        try {
            let modal = false;
            vscode.window.showWarningMessage = (async (_message: string, options: vscode.MessageOptions) => {
                modal = options.modal === true; return undefined;
            }) as typeof originalWarning;
            await controller.clearResults();
            assert.ok(modal);
            const saved = (data.state.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0];
            assert.strictEqual(saved.id, value.id); assert.strictEqual(saved.stopped, undefined);
            assert.strictEqual(a.paths.length + b.paths.length, 0);
        } finally { controller.dispose(); }
    });

    test('IT-279: distinct scopes share the cap and an unserved old request waits only for the next budget window', async () => {
        const values = [request(), request()];
        values.forEach((value, n) => {
            value.createdAt = now - 3600000;
            value.shaTracking!.jobs = Array.from({ length: 100 }, (_, i) => ({ ...a.job, jobUrl: `${a.server.url}job/${n}-${i}/` }));
            for (let i = 0; i < 100; i++) { a.reply(`/job/${n}-${i}/api/json`, { builds: [] }); }
        });
        const data = context([a.server, b.server], values); const controller = new JenkinsController(data.context);
        try {
            await controller.refresh();
            assert.strictEqual(a.paths.length, jenkinsLimits.pollHttpBudget);
            assert.strictEqual(a.paths.filter(path => path.startsWith('/job/0-')).length, jenkinsLimits.pollHttpBudget / 2);
            assert.strictEqual(a.paths.filter(path => path.startsWith('/job/1-')).length, jenkinsLimits.pollHttpBudget / 2);
            const extra = request(); extra.createdAt = now - 3600000;
            (controller as unknown as { requests: JenkinsRequest[] }).requests.push(extra);
            await controller.refresh();
            assert.strictEqual(extra.nextPollAt, now + 600000);
            assert.strictEqual(a.paths.length, jenkinsLimits.pollHttpBudget);
            now += 600000; await controller.refresh();
            assert.ok(a.paths.includes('/job/test/api/json'));
        } finally { controller.dispose(); }
    });

    test('IT-280: exhausted report budget resumes only missing reports and preserves failed/incomplete distinction', async () => {
        const value = request(); value.shaTracking!.jobs = [a.job];
        a.reply('/job/test/api/json', { builds: [{ ...a.build(1), result: 'FAILURE' }] });
        a.reply('/job/test/1/testReport/api/json', {}, 403);
        const budget = { remaining: 2 };
        await pollJenkinsRequest(value, { ...options(), client: async server => new JenkinsClient(server, { token: 'token', budget }) });
        assert.ok(value.runs[0].coreCompletedAt); assert.strictEqual(value.runs[0].finalizedAt, undefined);
        assert.strictEqual(value.runs[0].stages, null);
        const before = a.paths.length;
        await pollJenkinsRequest(value, options());
        assert.deepStrictEqual(a.paths.slice(before), ['/job/test/1/testReport/api/json']);
        assert.strictEqual(value.outcome, 'incomplete'); assert.strictEqual(value.error, 'JENKINS_RESULTS_INCOMPLETE');
        assert.strictEqual(aggregate(value).observedResult, 'failed');
        assert.ok(value.settledAt); await pollJenkinsRequest(value, options());
        assert.strictEqual(a.paths.length, before + 1);
    });

    test('IT-281: a stalled core advances the cursor, while an exhausted budget retains the unserved job', async () => {
        const value = request(); const abort = new AbortController();
        const client = new JenkinsClient(a.server, { token: 'token' });
        client.listRecentBuilds = async () => { abort.abort(); throw new JenkinsClientError('CANCELLED'); };
        await pollJenkinsRequest(value, { ...options(), signal: abort.signal, client: async () => client });
        assert.strictEqual(value.shaTracking!.cursor, 1);
        b.reply('/job/test/api/json', { builds: [b.build(7)] });
        a.reply('/job/test/api/json', { builds: [a.build(1)] });
        const budget = { remaining: 3 };
        await pollJenkinsRequest(value, { ...options(), client: async server => new JenkinsClient(server, { token: 'token', budget }) });
        assert.ok(value.runs.find(run => run.serverId === b.server.id)?.finalizedAt);
        assert.strictEqual(value.shaTracking!.cursor, 0);
        await pollJenkinsRequest(value, options());
        assert.ok(value.settledAt && aggregate(value).allPassed);
    });

    test('IT-282: interrupted submissions resume GET-only observation only with complete pre-POST baselines', async () => {
        const value = request(); value.shaTracking!.readOnly = false; value.submission = 'sending';
        value.shaTracking!.jobs.forEach(job => { job.afterBuild = 7; });
        const data = context([a.server, b.server], [value]); const store = new JenkinsStore(data.context);
        const restored = store.requests()[0];
        assert.strictEqual(restored.submission, 'unconfirmed'); assert.strictEqual(restored.stopped, undefined);
        a.reply('/job/test/api/json', { builds: [a.build(8)] }); b.reply('/job/test/api/json', { builds: [b.build(8)] });
        await pollJenkinsRequest(restored, options());
        assert.ok(restored.settledAt && aggregate(restored).allPassed);
        delete value.shaTracking!.jobs[0].afterBuild;
        const unsafe = store.requests()[0];
        assert.strictEqual(unsafe.stopped, true);
        const before = a.paths.length + b.paths.length;
        await pollJenkinsRequest(unsafe, options()); assert.strictEqual(a.paths.length + b.paths.length, before);
    });

    test('IT-283: missing credentials for deferred reports preserve the terminal core and end automatic checks', async () => {
        const value = request(); value.shaTracking!.jobs = [{ ...a.job, buildUrl: a.build(1).url }];
        value.runs = [{ ...a.build(1), ...a.job, actualSha: sha, coreCompletedAt: now }];
        await pollJenkinsRequest(value, { ...options(), client: async () => { throw new JenkinsClientError('AUTH_REQUIRED'); } });
        assert.strictEqual(value.outcome, 'incomplete'); assert.ok(value.settledAt);
        assert.strictEqual(value.runs[0].error, undefined);
        assert.deepStrictEqual(value.runs[0].reportErrors, { stages: 'AUTH_REQUIRED', tests: 'AUTH_REQUIRED' });
        assert.strictEqual(aggregate(value).counts.passed, 1);
        await pollJenkinsRequest(value, options()); assert.strictEqual(a.paths.length + b.paths.length, 0);
    });
});
