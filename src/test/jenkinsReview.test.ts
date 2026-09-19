import * as assert from 'node:assert';
import * as http from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import * as vscode from 'vscode';
import { JenkinsController } from '../jenkins/controller';
import { JenkinsClient } from '../jenkins/client';
import { JenkinsInventory } from '../jenkins/inventory';
import { createRequest, aggregate } from '../jenkins/model';
import { jenkinsErrorLabel, jenkinsStatusLabel } from '../jenkins/messages';
import { pollJenkinsRequest } from '../jenkins/tracking';
import { JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY, jenkinsSecretKey } from '../jenkins/storage';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild } from '../jenkins/types';
import { JenkinsViewProvider, discoveryLabel } from '../providers/jenkinsViewProvider';
import * as git from '../jenkins/git';

const base: JenkinsServer = { id: 'ci', name: 'CI', url: 'https://ci.example/jenkins/', username: 'developer' };
function request(server = base, number = 1): JenkinsRequest {
    return createRequest({ id: `request-${number}`, branch: 'main', sha: 'a'.repeat(40), repoPath: '/fixture',
        root: { serverId: server.id, jobUrl: `${server.url}job/root/`, buildUrl: `${server.url}job/root/${number}/` } });
}
function fixture(servers: JenkinsServer[], requests: JenkinsRequest[] = []) {
    const global = new Map<string, unknown>([[JENKINS_SERVERS_KEY, servers]]);
    const workspace = new Map<string, unknown>([[JENKINS_REQUESTS_KEY, requests]]);
    const secrets = new Map(servers.map(server => [jenkinsSecretKey(server), 'fixture-token']));
    const state = (values: Map<string, unknown>): vscode.Memento => ({
        get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
        update: async (key: string, value: unknown) => { values.set(key, JSON.parse(JSON.stringify(value))); }, keys: () => [...values.keys()],
    } as vscode.Memento);
    return { global, workspace, secrets, context: {
        globalState: state(global), workspaceState: state(workspace), subscriptions: [],
        secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); }, onDidChange: () => new vscode.Disposable(() => {}) },
    } as unknown as vscode.ExtensionContext };
}

async function withHttp(handler: (path: string, response: http.ServerResponse, server: JenkinsServer) => void,
    work: (server: JenkinsServer) => Promise<void>): Promise<void> {
    let configuration: JenkinsServer;
    const sockets = new Set<Socket>();
    const server = http.createServer((request, response) => handler(new URL(request.url!, configuration.url).pathname, response, configuration));
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    configuration = { ...base, url: `http://127.0.0.1:${address.port}/jenkins/`, allowInsecureHttp: true };
    try { await work(configuration); }
    finally { for (const socket of sockets) { socket.destroy(); } await new Promise<void>(resolve => server.close(() => resolve())); }
}

suite('Jenkins review regressions', function () {
    this.timeout(20000);

    test('IT-249: two active requests share a 200-job HTTP scan and resume beyond the first-round budget', async () => {
        const sockets = new Set<Socket>();
        const paths: string[] = [];
        let configuration: JenkinsServer;
        const server = http.createServer((incoming, response) => {
            const path = new URL(incoming.url!, configuration.url).pathname;
            paths.push(path);
            assert.strictEqual(incoming.method, 'GET');
            assert.strictEqual(incoming.headers.authorization, `Basic ${Buffer.from('developer:fixture-token').toString('base64')}`);
            const child = { url: `${configuration.url}job/suite199/1/`, number: 1, building: false, result: 'SUCCESS',
                actions: [{ causes: [1, 2].map(upstreamBuild => ({ upstreamUrl: 'job/root/', upstreamBuild })) }] };
            let body: unknown;
            if (path === '/jenkins/api/json') { body = { jobs: Array.from({ length: 200 }, (_, index) => ({ name: `suite${index}`,
                url: `${configuration.url}job/suite${index}/`, buildable: true, _class: 'hudson.model.FreeStyleProject' })) }; }
            else if (/\/job\/suite\d+\/api\/json$/.test(path)) { body = { builds: path.includes('suite199/') ? [child] : [] }; }
            else if (path === '/jenkins/job/suite199/1/api/json') { body = child; }
            else if (/\/job\/root\/[12]\/api\/json$/.test(path)) { const number = Number(path.split('/')[4]); body = { url: `${configuration.url}job/root/${number}/`, number, building: false, result: 'SUCCESS' }; }
            else { response.writeHead(404); response.end(); return; }
            response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));
        });
        server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        configuration = { ...base, url: `http://127.0.0.1:${address.port}/jenkins/`, allowInsecureHttp: true };
        const data = fixture([configuration], [request(configuration, 1), request(configuration, 2)]);
        const originalMessage = vscode.window.showInformationMessage;
        let controller: JenkinsController | undefined;
        try {
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = async () => undefined;
            controller = new JenkinsController(data.context);
            await controller.refresh();
            let saved = data.workspace.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.ok(saved.every(value => value.discovery.message === 'discoveryInProgress'));
            assert.ok(saved.every(value => !value.error));
            assert.strictEqual(paths.filter(path => path === '/jenkins/api/json').length, 1);
            assert.strictEqual(paths.filter(path => /\/suite\d+\/api\/json$/.test(path)).length, 149);
            (controller as unknown as { lastDiscovery: number }).lastDiscovery = 0;
            await controller.refresh();
            saved = data.workspace.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(paths.filter(path => path === '/jenkins/api/json').length, 1, 'No repeated inventory for the second request or second batch.');
            assert.strictEqual(paths.filter(path => /\/suite\d+\/api\/json$/.test(path)).length, 200);
            assert.ok(saved.every(value => value.runs.some(build => build.url.includes('suite199'))));
            assert.ok(saved.every(value => value.discovery.message === 'discoveryBounded' && !value.error));
            assert.ok(saved.every(value => !aggregate(value).allPassed), 'Scanning still does not certify complete coverage.');
        } finally {
            controller?.dispose();
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = originalMessage;
            for (const socket of sockets) { socket.destroy(); }
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test('IT-250: graph overflow is a discovery limit, not an authentication or connection failure', async () => {
        const value = request();
        const root: TrackedJenkinsBuild = { serverId: base.id, jobUrl: value.root.jobUrl, url: value.root.buildUrl!, number: 1, result: 'SUCCESS', building: false };
        const excessive = { ...root, actions: [{ causes: Array.from({ length: 10001 }, () => ({ upstreamUrl: 'job/root/', upstreamBuild: 1 })) }] };
        const client = { getBuild: async () => root, getStages: async () => null, getTestReport: async () => null } as unknown as JenkinsClient;
        await pollJenkinsRequest(value, { servers: [base], client: async () => client, discover: true, recentBuildLimit: 20,
            manifestArtifact: 'taskhub-jenkins-runs.json', inventory: { candidates: [excessive], continuing: false, limited: false, failures: [] } });
        assert.strictEqual(value.discovery.message, 'discoveryLimited');
        assert.strictEqual(value.error, undefined);
        assert.strictEqual(aggregate(value).allPassed, false);
    });

    test('IT-251: an empty window explains the missing folder before Git or server enrollment', async () => {
        const folders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders')!;
        const originalMessage = vscode.window.showInformationMessage;
        const originalSnapshot = git.readJenkinsGitSnapshot;
        const data = fixture([]);
        const controller = new JenkinsController(data.context);
        let message = '';
        let snapshots = 0;
        try {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { value: undefined, configurable: true });
            (git as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = async () => { snapshots++; throw new Error('Unexpected Git'); };
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = (async (value: string) => { message = value; return undefined; }) as typeof originalMessage;
            await controller.run();
            assert.match(message, /folder|폴더/);
            assert.strictEqual(snapshots, 0);
        } finally {
            controller.dispose(); Object.defineProperty(vscode.workspace, 'workspaceFolders', folders);
            (git as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = originalSnapshot;
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = originalMessage;
        }
    });

    test('IT-252: a blank token keeps credentials when editing a name but cannot move them to another destination', async () => {
        const data = fixture([base]);
        const controller = new JenkinsController(data.context);
        const originalInput = vscode.window.showInputBox;
        const originalMessage = vscode.window.showInformationMessage;
        let inputs = ['Renamed', base.url, base.username, ''];
        try {
            (vscode.window as { showInputBox: typeof originalInput }).showInputBox = async () => inputs.shift();
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = async () => undefined;
            const edit = controller as unknown as { editServer(server: JenkinsServer): Promise<void> };
            await edit.editServer(base);
            assert.strictEqual((data.global.get(JENKINS_SERVERS_KEY) as JenkinsServer[])[0].name, 'Renamed');
            assert.strictEqual(data.secrets.get(jenkinsSecretKey(base)), 'fixture-token');
            inputs = ['Unsafe move', 'https://other.example/', base.username, ''];
            await edit.editServer(base);
            assert.strictEqual((data.global.get(JENKINS_SERVERS_KEY) as JenkinsServer[])[0].url, base.url);
            assert.strictEqual(data.secrets.size, 1);
        } finally {
            controller.dispose();
            (vscode.window as { showInputBox: typeof originalInput }).showInputBox = originalInput;
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = originalMessage;
        }
    });

    test('IT-253: Korean status labels, root failure counts, submitting state and expand-only nodes agree', () => {
        const language = Object.getOwnPropertyDescriptor(vscode.env, 'language')!;
        const value = request();
        value.discovery.complete = true;
        value.runs = [1, 2, 3].map(number => ({ serverId: base.id, jobUrl: value.root.jobUrl,
            url: `${base.url}job/root/${number}/`, number, building: false, result: number === 1 ? 'FAILURE' : 'SUCCESS', correlation: number === 1 ? 'root' : 'manifest' }));
        const provider = new JenkinsViewProvider(() => [value], () => [base]);
        const node = () => provider.getChildren(provider.getChildren(provider.getChildren()[0])[0])[0];
        try {
            Object.defineProperty(vscode.env, 'language', { value: 'ko', configurable: true });
            assert.match(node().label, /^실패/);
            assert.match(node().description!, /2\/3/);
            assert.strictEqual(provider.getTreeItem(node()).command, undefined);
            assert.ok(provider.getTreeItem(node()).accessibilityInformation?.label.includes('실패'));
            const icons = new Set<string>();
            for (const [status, result, error] of [['queued', 'QUEUED'], ['running', 'RUNNING'], ['aborted', 'ABORTED'], ['skipped', 'NOT_BUILT'], ['unreachable', 'SUCCESS', 'TIMEOUT']]) {
                value.runs[0].result = result; value.runs[0].error = error;
                const build = provider.getChildren(node()).find(item => item.kind === 'build')!;
                assert.ok(build.label.startsWith(jenkinsStatusLabel(status)));
                const icon = provider.getTreeItem(build).iconPath as vscode.ThemeIcon;
                assert.ok(icon.color); icons.add(icon.id);
            }
            assert.strictEqual(icons.size, 5);
            value.runs = []; delete value.root.buildUrl; value.submission = 'sending'; delete value.error;
            assert.match(node().label, /^요청 전송 중/);
            assert.ok(!provider.getChildren(node()).some(item => item.label.includes('오류')));
            for (const code of ['REDIRECT', 'BACKOFF', 'BUSY', 'DISCOVERY_LIMIT']) {
                assert.match(jenkinsErrorLabel(code), /[가-힣]/);
                assert.ok(!jenkinsErrorLabel(code).includes(code));
            }
        } finally { provider.dispose(); Object.defineProperty(vscode.env, 'language', language); }
    });

    test('IT-254: first server enrollment resumes the same command before Git preflight', async () => {
        const data = fixture([]);
        const controller = new JenkinsController(data.context);
        const originalSnapshot = git.readJenkinsGitSnapshot;
        const originalPick = vscode.window.showQuickPick;
        let enrolled = false;
        let snapshots = 0;
        try {
            (controller as unknown as { editServer(): Promise<void> }).editServer = async () => {
                assert.strictEqual(snapshots, 0);
                data.global.set(JENKINS_SERVERS_KEY, [base]); enrolled = true;
            };
            (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = (async (items: unknown) => (await items as unknown[])[0]) as typeof originalPick;
            (git as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = async () => {
                snapshots++; assert.strictEqual(enrolled, true); throw new git.JenkinsGitError('dirty');
            };
            await assert.rejects(controller.run(), { code: 'dirty' });
            assert.strictEqual(snapshots, 1, 'Enrollment must continue into preflight without asking the user to restart.');
        } finally {
            controller.dispose();
            (git as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = originalSnapshot;
            (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = originalPick;
        }
    });

    test('a failed job does not starve later jobs in the resumed inventory', async () => {
        const inventory = new JenkinsInventory();
        const calls: string[] = [];
        const options = { servers: [base], requests: [request()], recentBuildLimit: 20,
            client: async () => ({ listJobsPage: async () => [{ url: 'missing', buildable: true }, { url: 'healthy', buildable: true }],
                listRecentBuilds: async (url: string) => { calls.push(url); if (url === 'missing') { throw new Error('deleted job'); } return []; },
            }) as unknown as JenkinsClient };
        const first = await inventory.collect(options);
        assert.deepStrictEqual(first.failures, [base.id]);
        assert.strictEqual(first.continuing, true);
        const next = await inventory.collect(options);
        assert.deepStrictEqual(calls, ['missing', 'healthy']);
        assert.deepStrictEqual(next.failures, []);
        assert.strictEqual(next.continuing, false);
    });

    test('inventory failure does not discard another server’s results or send parameter secrets to history', async () => {
        const inventory = new JenkinsInventory();
        const first = { ...base, id: 'failed' };
        const value = request(); value.requestIdParameter = 'TRACE';
        const result = await inventory.collect({ servers: [first, base], requests: [value], recentBuildLimit: 20,
            client: async server => ({ listJobsPage: async () => { if (server.id === 'failed') { throw new Error('offline'); }
                return [{ url: `${base.url}job/child/`, buildable: true }]; }, listRecentBuilds: async () => [{
                    url: `${base.url}job/child/1/`, number: 1, building: false, result: 'SUCCESS',
                    actions: [{ parameters: [{ name: 'TRACE', value: value.id }, { name: 'PASSWORD', value: 'never-retain' }] }],
                }] }) as unknown as JenkinsClient });
        assert.deepStrictEqual(result.failures, ['failed']);
        assert.strictEqual(result.candidates.length, 1);
        assert.ok(!JSON.stringify(result).includes('never-retain'));
        assert.ok(JSON.stringify(result).includes(value.id));
    });
    test('IT-256: a completed 3 MiB HTTP log opens a bounded read-only document with a partial preview notice', async () => {
        await withHttp((_path, response) => {
            const body = 'line\n'.repeat(Math.ceil(3 * 1024 * 1024 / 5));
            response.writeHead(200, { 'x-text-size': Buffer.byteLength(body), 'x-more-data': 'false', 'content-length': Buffer.byteLength(body) });
            response.end(body);
        }, async server => {
            const value = request(server);
            value.runs = [{ serverId: server.id, jobUrl: value.root.jobUrl, url: value.root.buildUrl!, number: 1, building: false, result: 'SUCCESS' }];
            const controller = new JenkinsController(fixture([server], [value]).context);
            const stored = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
            const originalShow = vscode.window.showTextDocument;
            let shown: vscode.TextDocument | undefined;
            try {
                (vscode.window as { showTextDocument: typeof originalShow }).showTextDocument = (async (document: vscode.TextDocument) => {
                    shown = document; return undefined;
                }) as unknown as typeof originalShow;
                await controller.openLog({ kind: 'build', label: 'log', request: stored, run: stored.runs[0] });
                assert.ok(shown);
                assert.strictEqual(shown.uri.scheme, 'taskhub-jenkins-log');
                assert.strictEqual(shown.isUntitled, false);
                const text = shown.getText();
                assert.ok(text.startsWith('line\n'));
                assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
                assert.ok(Buffer.byteLength(text) < 2 * 1024 * 1024 + 512);
                assert.match(text, /size limit reached|크기 한도/);
            } finally { (vscode.window as { showTextDocument: typeof originalShow }).showTextDocument = originalShow; controller.dispose(); }
        });
    });

    test('IT-257: HTTP-limited folder scans resume at the exact folder and eventually reach late jobs', async () => {
        const paths: string[] = [];
        await withHttp((path, response, server) => {
            paths.push(path);
            const folders = Array.from({ length: 180 }, (_, index) => ({ name: `f${index}`, url: `${server.url}job/f${index}/`, _class: 'com.cloudbees.hudson.plugins.folder.Folder' }));
            const body = path === '/jenkins/api/json' ? { jobs: folders }
                : path === '/jenkins/job/f179/api/json' ? { jobs: [{ name: 'late', url: `${server.url}job/late/`, buildable: true }] }
                : path === '/jenkins/job/late/api/json' ? { builds: [{ url: `${server.url}job/late/1/`, number: 1, building: false, result: 'SUCCESS' }] }
                : { jobs: [] };
            response.end(JSON.stringify(body));
        }, async server => {
            const inventory = new JenkinsInventory();
            const collect = (limit: number) => {
                const budget = { remaining: limit };
                return inventory.collect({ servers: [server], requests: [request(server)], recentBuildLimit: 20,
                    maxOperations: 1000,
                    client: async () => new JenkinsClient(server, { token: 'fixture', budget }) });
            };
            const first = await collect(150);
            assert.strictEqual(paths.length, 150);
            assert.strictEqual(first.continuing, true);
            assert.deepStrictEqual(first.failures, []);
            const second = await collect(150);
            assert.strictEqual(second.continuing, false);
            assert.deepStrictEqual(second.failures, []);
            assert.strictEqual(paths.length, 182);
            assert.strictEqual(new Set(paths).size, 182, 'No restart or skipped folder at the exhausted budget.');
            assert.strictEqual(second.candidates.length, 1);
            assert.ok(second.candidates[0].url.endsWith('/job/late/1/'));
        });
    });

    test('IT-258: timeout is stopped, inventory coverage is stable, and report errors retain the known result', () => {
        const value = request();
        const provider = new JenkinsViewProvider(() => [value], () => [base]);
        const node = () => provider.getChildren(provider.getChildren(provider.getChildren()[0])[0])[0];
        try {
            value.error = 'JENKINS_TRACKING_TIMEOUT'; value.stopped = true;
            assert.ok(node().label.startsWith(jenkinsStatusLabel('stopped')));
            delete value.error; delete value.stopped;
            value.discovery.message = 'discoveryInProgress';
            const inProgress = discoveryLabel(value);
            assert.ok(provider.getChildren(node()).some(child => /continues next round|다음 회차/.test(child.label)));
            value.discovery.message = 'discoveryBounded';
            assert.strictEqual(discoveryLabel(value), inProgress);
            value.discovery.complete = true;
            value.runs = [{ serverId: base.id, jobUrl: value.root.jobUrl, url: value.root.buildUrl!, number: 1,
                building: false, result: 'SUCCESS', reportErrors: { tests: 'FORBIDDEN' } }];
            assert.ok(node().label.startsWith(jenkinsStatusLabel('partial')));
            const build = provider.getChildren(node()).find(child => child.kind === 'build')!;
            assert.ok(build.label.startsWith(jenkinsStatusLabel('passed')));
            assert.ok(build.label.includes(jenkinsStatusLabel('partial')));
            assert.ok(provider.getChildren(build).some(child => child.label.includes(jenkinsErrorLabel('FORBIDDEN'))));
            assert.strictEqual(aggregate(value).allPassed, false);
        } finally { provider.dispose(); }
    });

    test('IT-259: opening a log before any build exists explains the state without an empty picker', async () => {
        const controller = new JenkinsController(fixture([base], [request()]).context);
        const stored = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
        const originalPick = vscode.window.showQuickPick;
        const originalMessage = vscode.window.showInformationMessage;
        let message = '';
        try {
            (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = async () => { assert.fail('No empty picker'); };
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = (async (text: string) => {
                message = text; return undefined;
            }) as typeof originalMessage;
            await controller.openLog({ kind: 'request', label: 'request', request: stored });
            assert.match(message, /No build log|로그를 조회할 빌드가 없습니다/);
        } finally {
            (vscode.window as { showQuickPick: typeof originalPick }).showQuickPick = originalPick;
            (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = originalMessage;
            controller.dispose();
        }
    });


    test('IT-261: a discovery-limited server stops rescanning until settings change while another server continues', async () => {
        const paths: string[] = [];
        await withHttp((path, response, server) => {
            paths.push(path);
            const body = path === '/healthy/api/json' ? { jobs: [] }
                : path === '/jenkins/api/json' ? { jobs: [{ name: 'folder', url: `${server.url}job/folder/`, _class: 'com.cloudbees.hudson.plugins.folder.Folder' }] }
                : path === '/jenkins/job/folder/api/json' ? { jobs: [1, 2].map(index => ({ name: `child${index}`, url: `${server.url}job/child${index}/`, buildable: true })) }
                : { builds: [] };
            response.end(JSON.stringify(body));
        }, async server => {
            const healthy = { ...server, id: 'healthy', url: new URL('/healthy/', server.url).href };
            const inventory = new JenkinsInventory();
            const collect = (jobLimit: number) => inventory.collect({ servers: [server, healthy], requests: [request(server)], recentBuildLimit: 20,
                jobLimit, client: async target => new JenkinsClient(target, { token: 'fixture', maxJobs: jobLimit }) });
            assert.strictEqual((await collect(2)).limited, true);
            for (let index = 0; index < 3; index++) { assert.strictEqual((await collect(2)).limited, true); }
            assert.strictEqual(paths.filter(path => path.startsWith('/jenkins/')).length, 2);
            assert.strictEqual(paths.filter(path => path.startsWith('/healthy/')).length, 4);
            const resumed = await collect(3);
            assert.strictEqual(resumed.limited, false);
            assert.strictEqual(resumed.continuing, false);
            assert.strictEqual(paths.filter(path => path.startsWith('/jenkins/')).length, 6);
            inventory.clear();
            assert.strictEqual((await collect(2)).limited, true, 'Explicit reset must allow a fresh scan.');
        });
    });

    test('incremental cursor byte accounting stays bounded and releases memory after limit, completion and server removal', async () => {
        const inventory = new JenkinsInventory();
        let huge = true;
        const options = { servers: [base], requests: [request()], recentBuildLimit: 20, jobLimit: 2000,
            client: async () => ({ listJobsPage: async () => Array.from({ length: huge ? 1500 : 2 }, (_, index) => ({
                name: `job${index}`, kind: 'job', fullName: `job${index}`, buildable: true,
                url: `${base.url}job/${'x'.repeat(huge ? 7000 : 10)}${index}/`,
            })), listRecentBuilds: async () => [] }) as unknown as JenkinsClient };
        assert.strictEqual((await inventory.collect(options)).limited, true);
        const bytes = () => (inventory as unknown as { cursorBytes: number }).cursorBytes;
        assert.strictEqual(bytes(), 0, 'Limit cleanup must release all prior charges.');
        huge = false;
        inventory.clear();
        assert.strictEqual((await inventory.collect({ ...options, maxOperations: 1 })).continuing, true);
        assert.ok(bytes() > 0 && bytes() < 8 * 1024 * 1024);
        await inventory.collect(options);
        assert.strictEqual(bytes(), 0, 'Completion must release the cursor.');
        await inventory.collect({ ...options, maxOperations: 1 });
        await inventory.collect({ ...options, servers: [] });
        assert.strictEqual(bytes(), 0, 'Removing a server must release its cursor.');
    });


    test('clearing inventory during a folder request cannot restore obsolete cursors or byte charges', async () => {
        for (const fail of [false, true]) {
            const inventory = new JenkinsInventory();
            let finish!: () => void;
            let started!: () => void;
            const ready = new Promise<void>(resolve => { started = resolve; });
            const pending = inventory.collect({ servers: [base], requests: [request()], recentBuildLimit: 20,
                client: async () => ({ listJobsPage: async () => {
                    started(); await new Promise<void>((resolve, reject) => {
                        finish = () => fail ? reject(new Error('old request failed')) : resolve();
                    }); return [];
                } }) as unknown as JenkinsClient });
            await ready;
            inventory.clear();
            finish();
            await pending;
            const state = inventory as unknown as { cursorBytes: number; cursors: Map<string, unknown> };
            assert.strictEqual(state.cursorBytes, 0);
            assert.strictEqual(state.cursors.size, 0);
        }
    });


    test('IT-262: explicit refresh retries a depth-limited server while automatic polling stays paused', async () => {
        let deep = true;
        const folderPaths: string[] = [];
        await withHttp((path, response, server) => {
            if (path === '/jenkins/job/root/1/api/json') {
                response.end(JSON.stringify({ url: `${server.url}job/root/1/`, number: 1, result: 'SUCCESS', building: false })); return;
            }
            if (path === '/jenkins/api/json' || /\/job\/f\d+\/api\/json$/.test(path)) {
                folderPaths.push(path);
                const index = path === '/jenkins/api/json' ? 0 : Number(/\/f(\d+)\//.exec(path)![1]) + 1;
                response.end(JSON.stringify({ jobs: deep ? [{ name: `f${index}`, url: `${server.url}job/f${index}/`,
                    _class: 'com.cloudbees.hudson.plugins.folder.Folder' }] : [] })); return;
            }
            response.writeHead(404); response.end();
        }, async server => {
            const data = fixture([server], [request(server)]);
            const controller = new JenkinsController(data.context);
            const originalMessage = vscode.window.showInformationMessage;
            try {
                (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = async () => undefined;
                await controller.refresh();
                const saved = () => (data.workspace.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[])[0];
                assert.strictEqual(saved().discovery.message, 'discoveryLimited');
                const calls = folderPaths.length;
                (controller as unknown as { lastDiscovery: number }).lastDiscovery = 0;
                await controller.refresh();
                assert.strictEqual(folderPaths.length, calls, 'Automatic refresh must not restart the same over-limit scan.');
                deep = false; // An administrator has reduced the folder nesting on Jenkins.
                await vscode.commands.executeCommand('taskhub.jenkins.refresh');
                assert.strictEqual(folderPaths.length, calls + 1);
                assert.strictEqual(saved().discovery.message, 'discoveryBounded');
                assert.strictEqual(saved().error, undefined);
                assert.strictEqual(aggregate(saved()).allPassed, false);
            } finally {
                controller.dispose();
                (vscode.window as { showInformationMessage: typeof originalMessage }).showInformationMessage = originalMessage;
            }
        });
    });

    test('visited and queued folder indexes deduplicate cycles across resumed scans without losing healthy progress', async () => {
        const inventory = new JenkinsInventory();
        const calls: string[] = [];
        const folder = (name: string) => ({ name, fullName: name, url: name, kind: 'folder', buildable: false });
        const options = { servers: [base], requests: [request()], recentBuildLimit: 20,
            client: async () => ({ listJobsPage: async (url: string) => {
                calls.push(url);
                if (url === base.url) { return [folder('a'), folder('b'), folder('a')]; }
                if (url === 'a' || url === 'b') { return [folder('a'), folder('c'), folder('c')]; }
                return [folder(base.url)];
            } }) as unknown as JenkinsClient };
        assert.strictEqual((await inventory.collect({ ...options, maxOperations: 2 })).continuing, true);
        inventory.retryLimited();
        assert.strictEqual((await inventory.collect(options)).continuing, false);
        assert.deepStrictEqual(calls, [base.url, 'a', 'b', 'c']);
        assert.strictEqual((inventory as unknown as { cursorBytes: number }).cursorBytes, 0);
    });

    test('folder-count limit can be retried explicitly without changing settings or restarting the extension', async () => {
        const inventory = new JenkinsInventory();
        let tooMany = true;
        let calls = 0;
        const options = { servers: [base], requests: [request()], jobLimit: 2000, recentBuildLimit: 20, maxOperations: 1200,
            client: async () => ({ listJobsPage: async (url: string) => {
                calls++;
                return tooMany && url === base.url ? Array.from({ length: 1000 }, (_, index) => ({ name: `f${index}`, fullName: `f${index}`,
                    url: `${base.url}job/f${index}/`, kind: 'folder', buildable: false })) : [];
            } }) as unknown as JenkinsClient };
        assert.strictEqual((await inventory.collect(options)).limited, true);
        assert.strictEqual(calls, 1000);
        assert.strictEqual((await inventory.collect(options)).limited, true);
        assert.strictEqual(calls, 1000);
        tooMany = false;
        inventory.retryLimited();
        assert.strictEqual((await inventory.collect(options)).limited, false);
        assert.strictEqual(calls, 1001);
    });

});
