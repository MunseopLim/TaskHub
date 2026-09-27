import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { JenkinsClient, JenkinsClientError } from '../jenkins/client';
import { JenkinsController, registerJenkins } from '../jenkins/controller';
import * as jenkinsGit from '../jenkins/git';
import { createRequest } from '../jenkins/model';
import { JenkinsStore, JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY, jenkinsSecretKey } from '../jenkins/storage';
import type { JenkinsJob, JenkinsRequest, JenkinsServer, TrackedJenkinsBuild } from '../jenkins/types';
import { discoveryLabel, JenkinsTreeNode, JenkinsViewProvider } from '../providers/jenkinsViewProvider';

const commandIds = ['manageServers', 'run', 'trackSha', 'refresh', 'openRun', 'openLog', 'stopTracking', 'showRuns', 'clearResults']
    .map(command => `taskhub.jenkins.${command}`);
const requestedSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const servers: JenkinsServer[] = [
    { id: 'main', name: 'Main controller', url: 'https://main.example/jenkins/', username: 'developer' },
    { id: 'nand', name: 'NAND controller', url: 'https://nand.example/jenkins/', username: 'developer' },
];

function memoryState(): { memento: vscode.Memento; values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    const memento = {
        get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, JSON.parse(JSON.stringify(value)));
            }
        },
        keys: () => [...values.keys()],
    } as vscode.Memento;
    return { memento, values };
}

function makeRequest(overrides: Partial<JenkinsRequest> = {}): JenkinsRequest {
    return {
        ...createRequest({
            id: 'request-001', createdAt: Date.UTC(2026, 8, 19, 12),
            branch: 'ftl/gc-fix', sha: requestedSha, repoPath: '/fixture/firmware',
            root: { serverId: 'main', jobUrl: `${servers[0].url}job/root/` },
        }),
        ...overrides,
    };
}

function makeRun(overrides: Partial<TrackedJenkinsBuild> = {}): TrackedJenkinsBuild {
    return {
        serverId: 'main', jobUrl: `${servers[0].url}job/root/`,
        url: `${servers[0].url}job/root/31/`, number: 31,
        fullDisplayName: 'root #31', building: false, result: 'SUCCESS',
        correlation: 'root', actualSha: requestedSha,
        ...overrides,
    };
}

function requestNode(provider: JenkinsViewProvider): JenkinsTreeNode {
    return provider.getChildren(provider.getChildren(provider.getChildren()[0])[0])[0];
}

function iconId(item: vscode.TreeItem): string | undefined {
    return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
}

suite('Jenkins controller and results tree', () => {
    for (const stage of ['persist', 'token', 'post'] as const) {
        for (const action of (stage === 'persist' ? ['stop', 'clear'] : ['stop', 'clear', 'fail']) as Array<'stop' | 'clear' | 'fail'>) {
            test(`review regression: ${action} while awaiting ${stage === 'post' ? 'dispatched POST' : 'pre-POST ' + stage} preserves dispatch evidence without resurrection`, async () => {
                const state = memoryState(); state.values.set(JENKINS_SERVERS_KEY, [servers[0]]);
                const snapshot = jenkinsGit.readJenkinsGitSnapshot;
                const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox;
                const info = vscode.window.showInformationMessage;
                const warning = vscode.window.showWarningMessage;
                const list = JenkinsClient.prototype.listJobs; const get = JenkinsClient.prototype.getJob;
                const recent = JenkinsClient.prototype.listRecentBuilds; const trigger = JenkinsClient.prototype.trigger;
                const job: JenkinsJob = { name: 'test', fullName: 'test', url: `${servers[0].url}job/test/`, kind: 'job', buildable: true, parameters: [] };
                let ready!: () => void; let release!: () => void;
                const waiting = new Promise<void>(resolve => { ready = resolve; });
                const gate = new Promise<void>(resolve => { release = resolve; });
                let pause = false; let calls = 0;
                const messages: string[] = [];
                const context = { globalState: state.memento, workspaceState: state.memento, subscriptions: [], secrets: {
                    get: async () => {
                        if (pause && stage === 'token') {
                            ready(); await gate;
                            if (action === 'fail') { throw new JenkinsClientError('TIMEOUT', undefined, undefined, true); }
                        }
                        return 'fixture-token';
                    },
                    onDidChange: () => new vscode.Disposable(() => {}),
                } } as unknown as vscode.ExtensionContext;
                let controller: JenkinsController | undefined;
                let running: Promise<void> | undefined;
                try {
                    (jenkinsGit as { readJenkinsGitSnapshot: typeof snapshot }).readJenkinsGitSnapshot = async () => ({
                        repoPath: vscode.workspace.workspaceFolders![0].uri.fsPath, branch: 'main', sha: requestedSha,
                        remote: 'origin', remoteRef: 'refs/heads/main',
                    });
                    vscode.window.showQuickPick = (async (items: unknown, options?: vscode.QuickPickOptions) => {
                        const values = await items as unknown[]; return options?.canPickMany ? values : values[0];
                    }) as typeof pick;
                    vscode.window.showInputBox = async () => '';
                    vscode.window.showInformationMessage = (async (message: string, _options: unknown, item?: string) => { messages.push(message); return item; }) as typeof info;
                    vscode.window.showWarningMessage = (async (message: string) => { messages.push(message); }) as typeof warning;
                    JenkinsClient.prototype.listJobs = async () => [job];
                    JenkinsClient.prototype.getJob = async () => job;
                    JenkinsClient.prototype.listRecentBuilds = async () => [];
                    JenkinsClient.prototype.trigger = async (_url, _parameters, onDispatch) => {
                        calls++; onDispatch?.();
                        if (stage === 'post') {
                            ready(); await gate;
                            if (action === 'fail') { throw new JenkinsClientError('TIMEOUT'); }
                        }
                        return { queueUrl: `${servers[0].url}queue/item/1/` };
                    };
                    const update = state.memento.update;
                    state.memento.update = async (key, value) => {
                        await update(key, value);
                        if (key === JENKINS_REQUESTS_KEY && !pause && (value as JenkinsRequest[])?.some(request => request.submission === 'sending')) {
                            pause = true;
                            if (stage === 'persist') { ready(); await gate; }
                            else if (stage === 'token') { (controller as unknown as { tokenCache: Map<string, unknown> }).tokenCache.clear(); }
                        }
                    };
                    controller = new JenkinsController(context);
                    running = controller.run();
                    await waiting;
                    const request = (controller as unknown as { requests: JenkinsRequest[] }).requests[0];
                    const stopping = action === 'stop' ? controller.stopTracking({ kind: 'request', label: '', request })
                        : action === 'clear' ? controller.clearResults({ kind: 'request', label: '', request }) : Promise.resolve();
                    await new Promise<void>(resolve => setImmediate(resolve));
                    release();
                    await Promise.all([running, stopping]);
                    assert.strictEqual(calls, stage === 'post' ? 1 : 0);
                    const saved = state.values.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
                    if (action === 'clear') { assert.deepStrictEqual(saved, []); }
                    else {
                        const stopped = action !== 'fail' || stage !== 'post';
                        assert.strictEqual(saved.length, 1); assert.strictEqual(!!saved[0].stopped, stopped);
                        assert.strictEqual(saved[0].submission, stage === 'post' ? 'unconfirmed' : 'notSent');
                        assert.strictEqual(messages.some(message => message.includes('No build was requested')), stage !== 'post');
                        assert.ok(messages.every(message => !message.includes('builds continue running')));
                        const restored = new JenkinsStore(context).requests()[0];
                        assert.strictEqual(restored.submission, saved[0].submission); assert.strictEqual(!!restored.stopped, stopped);
                        const provider = new JenkinsViewProvider(() => [restored], () => servers);
                        try {
                            const node = requestNode(provider);
                            assert.strictEqual(node.label.startsWith('Not submitted'), stage !== 'post');
                            assert.strictEqual(provider.getChildren(node).some(item => item.label === 'No build was requested.'), stage !== 'post');
                            assert.strictEqual(provider.getChildren(node).some(item => item.label.includes('Submission could not be confirmed')), stage === 'post');
                            if (action === 'fail' && stage === 'token') {
                                assert.ok(provider.getChildren(node).some(item => item.label.startsWith('Build submission preparation timed out.')));
                                assert.ok(provider.getChildren(node).every(item => !item.label.includes('server response timed out')));
                            }
                            if (stopped) { assert.ok(provider.getChildren(node).every(item => !item.label.includes('Checking Jenkins queue'))); }
                        } finally { provider.dispose(); }
                    }
                } finally {
                    release(); controller?.dispose(); await running;
                    (jenkinsGit as { readJenkinsGitSnapshot: typeof snapshot }).readJenkinsGitSnapshot = snapshot;
                    vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; vscode.window.showInformationMessage = info;
                    vscode.window.showWarningMessage = warning;
                    JenkinsClient.prototype.listJobs = list; JenkinsClient.prototype.getJob = get;
                    JenkinsClient.prototype.listRecentBuilds = recent; JenkinsClient.prototype.trigger = trigger;
                }
            });
        }
    }
    test('IT-236: experimental gate registers real host commands and disposes them without changing global settings', async () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
        const originalRegisterCommand = vscode.commands.registerCommand;
        const realConfiguration = originalGetConfiguration.call(vscode.workspace, 'taskhub');
        const before = realConfiguration.inspect<boolean>('experimental.jenkins.enabled');
        assert.strictEqual(before?.defaultValue, false);
        assert.strictEqual(vscode.workspace.isTrusted, true, 'The extension-host fixture must be trusted.');

        const globalState = memoryState();
        const workspaceState = memoryState();
        const secretValues = new Map<string, string>();
        const secretsChanged = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
        const context = {
            subscriptions: [], globalState: globalState.memento, workspaceState: workspaceState.memento,
            secrets: {
                get: async (key: string) => secretValues.get(key),
                store: async (key: string, value: string) => { secretValues.set(key, value); },
                delete: async (key: string) => { secretValues.delete(key); },
                onDidChange: secretsChanged.event,
            },
        } as unknown as vscode.ExtensionContext;
        const configurationChanged = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
        const registrations: Array<{ id: string; disposed: boolean }> = [];
        let enabled = false;
        let registration: vscode.Disposable | undefined;
        try {
            // The controller uses real command/status/tree APIs. Only its configuration source is
            // isolated, so this test cannot enable the already activated extension or alter settings.
            (vscode.workspace as unknown as { getConfiguration: typeof originalGetConfiguration }).getConfiguration =
                (section, scope) => {
                    const actual = originalGetConfiguration.call(vscode.workspace, section, scope);
                    if (section !== 'taskhub') {
                        return actual;
                    }
                    return {
                        ...actual,
                        get: (key: string, fallback?: unknown) => key === 'experimental.jenkins.enabled' ?
                            enabled : actual.get(key, fallback),
                    } as vscode.WorkspaceConfiguration;
                };
            (vscode.workspace as unknown as { onDidChangeConfiguration: typeof originalOnDidChangeConfiguration })
                .onDidChangeConfiguration = configurationChanged.event;
            (vscode.commands as unknown as { registerCommand: typeof originalRegisterCommand }).registerCommand =
                (command, callback, thisArg) => {
                    const disposable = originalRegisterCommand.call(vscode.commands, command, callback, thisArg);
                    const tracked = { id: command, disposed: false };
                    registrations.push(tracked);
                    return new vscode.Disposable(() => { tracked.disposed = true; disposable.dispose(); });
                };

            registration = registerJenkins(context);
            assert.strictEqual(registrations.length, 0, 'Disabled Jenkins must not register handlers.');
            enabled = true;
            configurationChanged.fire({ affectsConfiguration: section => section === 'taskhub.experimental.jenkins.enabled' });
            assert.deepStrictEqual(registrations.map(item => item.id), commandIds);
            const commands = new Set(await vscode.commands.getCommands(true));
            assert.ok(commandIds.every(command => commands.has(command)));
            await vscode.commands.executeCommand('taskhub.jenkins.refresh');
            assert.deepStrictEqual(workspaceState.values.get(JENKINS_REQUESTS_KEY), [],
                'Executing the real command must reach the isolated controller store.');

            enabled = false;
            configurationChanged.fire({ affectsConfiguration: section => section === 'taskhub.experimental.jenkins.enabled' });
            assert.ok(registrations.every(item => item.disposed), 'Disabling the feature must remove every handler.');
            enabled = true;
            configurationChanged.fire({ affectsConfiguration: section => section === 'taskhub.experimental.jenkins.enabled' });
            assert.strictEqual(registrations.length, commandIds.length * 2, 'Re-enabling creates one new controller.');
            registration.dispose();
            registration = undefined;
            assert.ok(registrations.every(item => item.disposed));
            configurationChanged.fire({ affectsConfiguration: () => true });
            assert.strictEqual(registrations.length, commandIds.length * 2, 'Disposal also removes the configuration listener.');
            assert.strictEqual(globalState.values.size, 0);
            assert.strictEqual(secretValues.size, 0);
        } finally {
            registration?.dispose();
            configurationChanged.dispose();
            secretsChanged.dispose();
            (vscode.commands as unknown as { registerCommand: typeof originalRegisterCommand }).registerCommand = originalRegisterCommand;
            (vscode.workspace as unknown as { onDidChangeConfiguration: typeof originalOnDidChangeConfiguration })
                .onDidChangeConfiguration = originalOnDidChangeConfiguration;
            (vscode.workspace as unknown as { getConfiguration: typeof originalGetConfiguration }).getConfiguration = originalGetConfiguration;
        }
        const after = originalGetConfiguration.call(vscode.workspace, 'taskhub').inspect<boolean>('experimental.jenkins.enabled');
        assert.deepStrictEqual(after, before, 'The test must restore every real configuration scope unchanged.');
    });

    test('IT-237: groups repository and branch, exact SHA, and repeated requests without merging servers or builds', () => {
        const first = makeRequest({ id: 'request-first' });
        const retry = makeRequest({ id: 'request-retry', createdAt: first.createdAt + 60_000 });
        const nextCommit = makeRequest({ id: 'request-next', sha: otherSha });
        const otherRepository = makeRequest({ id: 'request-repository', repoPath: '/fixture/another-firmware' });
        const otherBranch = makeRequest({ id: 'request-branch', branch: 'nvme/reset-fix' });
        first.runs = [
            makeRun(),
            makeRun({ serverId: 'nand', correlation: 'requestId', jobUrl: `${servers[1].url}job/nand/`,
                url: `${servers[1].url}job/nand/31/`, fullDisplayName: 'nand #31' }),
        ];
        const provider = new JenkinsViewProvider(() => [first, retry, nextCommit, otherRepository, otherBranch], () => servers);
        try {
            const branches = provider.getChildren();
            assert.strictEqual(branches.length, 3);
            assert.strictEqual(branches.filter(branch => branch.label === 'ftl/gc-fix').length, 2);
            assert.notStrictEqual(branches[0].description, branches[1].description);
            const commits = provider.getChildren(branches[0]);
            assert.strictEqual(commits.length, 2);
            assert.strictEqual(commits[0].label, requestedSha.slice(0, 12));
            const retries = provider.getChildren(commits[0]);
            assert.deepStrictEqual(retries.map(node => node.request?.id), ['request-first', 'request-retry']);
            assert.notStrictEqual(retries[0].label, retries[1].label);
            const builds = provider.getChildren(retries[0]).filter(node => node.kind === 'build');
            assert.strictEqual(builds.length, 2);
            assert.ok(builds[0].label.includes('Main controller'));
            assert.ok(builds[1].label.includes('NAND controller'));
            assert.notStrictEqual(builds[0].run?.url, builds[1].run?.url);
        } finally {
            provider.dispose();
        }
    });

    test('IT-238: representative success never displays overall PASS while coverage is unverified', () => {
        const request = makeRequest();
        request.runs = [makeRun()];
        request.root.buildUrl = request.runs[0].url;
        const provider = new JenkinsViewProvider(() => [request], () => servers);
        try {
            let node = requestNode(provider);
            assert.ok(!node.description?.includes('PASS'));
            assert.ok(node.description?.includes(discoveryLabel(request)));
            assert.notStrictEqual(iconId(provider.getTreeItem(node)), 'pass');

            request.discovery.complete = true;
            node = requestNode(provider);
            assert.ok(node.label.startsWith('PASS'));
            assert.strictEqual(iconId(provider.getTreeItem(node)), 'pass');

            request.runs[0].actualSha = otherSha;
            node = requestNode(provider);
            assert.ok(!node.label.startsWith('PASS'));
            assert.notStrictEqual(iconId(provider.getTreeItem(node)), 'pass');
            let build = provider.getChildren(node).find(child => child.kind === 'build')!;
            assert.ok(build.description?.includes('Checkout SHA mismatch'));
            assert.strictEqual(iconId(provider.getTreeItem(build)), 'git-compare');
            assert.ok(String(provider.getTreeItem(build).tooltip).includes(otherSha));

            request.runs[0].actualSha = requestedSha;
            request.runs[0].error = 'HTTP_403';
            node = requestNode(provider);
            assert.ok(!node.label.startsWith('PASS'));
            build = provider.getChildren(node).find(child => child.kind === 'build')!;
            assert.ok(build.description?.includes('Unavailable'));
            assert.notStrictEqual(iconId(provider.getTreeItem(build)), 'pass');
        } finally {
            provider.dispose();
        }
    });

    test('IT-239: tree commands retain exact request and build identities and expose stage and JUnit details', () => {
        const request = makeRequest();
        const run = makeRun({ result: 'UNSTABLE', stages: { stages: [{ id: '5', name: 'NVMe reset', status: 'FAILED' }] },
            tests: { passCount: 2, failCount: 1, skipCount: 1, suites: [{ cases: [
                { name: 'queueReset', className: 'Nvme', status: 'FAILED', errorDetails: 'Timeout' },
                { name: 'basicRead', status: 'PASSED' },
                { name: 'optionalPowerCycle', status: 'SKIPPED' },
            ] }] } });
        request.runs = [run];
        request.root.buildUrl = run.url;
        const provider = new JenkinsViewProvider(() => [request], () => servers);
        try {
            const node = requestNode(provider);
            const requestItem = provider.getTreeItem(node);
            assert.strictEqual(requestItem.contextValue, 'jenkinsRequestActive');
            assert.strictEqual(requestItem.command, undefined, 'Expanding a request must not open the browser.');
            assert.strictEqual(node.request, request);

            const build = provider.getChildren(node).find(child => child.kind === 'build')!;
            const buildItem = provider.getTreeItem(build);
            assert.strictEqual(buildItem.contextValue, 'jenkinsBuild');
            assert.strictEqual(buildItem.command, undefined, 'Expanding a build must not open the browser.');
            assert.strictEqual(build.run, run);
            assert.strictEqual(build.request, request);
            assert.ok(String(buildItem.tooltip).includes(run.url));
            const details = provider.getChildren(build);
            assert.ok(details.some(detail => detail.label === 'NVMe reset · FAILED'));
            assert.ok(details.some(detail => detail.label === 'JUnit · PASS 2 / FAIL 1 / SKIP 1'));
            assert.ok(details.some(detail => detail.label === 'Nvme.queueReset · FAILED'));
            assert.ok(details.some(detail => detail.label === 'optionalPowerCycle · SKIPPED'));
            assert.ok(!details.some(detail => detail.label.includes('basicRead')));
            for (const detail of details) {
                const item = provider.getTreeItem(detail);
                assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
                assert.strictEqual(item.command, undefined);
            }
        } finally {
            provider.dispose();
        }
    });

    test('IT-240: submitting maps declared parameters and persists one exact queue across duplicate clicks and refresh', async () => {
        const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === 'file');
        assert.ok(folder, 'The extension-host fixture must have a local workspace folder.');
        const snapshot: jenkinsGit.JenkinsGitSnapshot = {
            repoPath: folder.uri.fsPath, branch: 'ftl/gc-fix', sha: requestedSha,
            remote: 'origin', remoteRef: 'refs/heads/validation/firmware', repoRemote: 'ssh://git.example/firmware.git',
        };
        const job: JenkinsJob = {
            name: 'qualification', fullName: 'firmware/qualification',
            url: `${servers[0].url}job/firmware/job/qualification/`, buildable: true, kind: 'job',
            parameters: [
                { name: 'TARGET_BRANCH', type: 'StringParameterDefinition' },
                { name: 'COMMIT_HASH', type: 'StringParameterDefinition' },
                { name: 'TRACE_ID', type: 'StringParameterDefinition' },
                { name: 'SUITE', type: 'ChoiceParameterDefinition', choices: ['smoke', 'full'] },
                { name: 'NOTE', type: 'StringParameterDefinition', defaultValue: 'default note' },
                { name: '__proto__', type: 'StringParameterDefinition' },
            ],
        };
        const queueUrl = `${servers[0].url}queue/item/713/`;
        const globalState = memoryState();
        const workspaceState = memoryState();
        globalState.values.set(JENKINS_SERVERS_KEY, [servers[0]]);
        const secretsChanged = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
        const context = {
            subscriptions: [], globalState: globalState.memento, workspaceState: workspaceState.memento,
            secrets: {
                get: async (key: string) => key === jenkinsSecretKey(servers[0]) ? 'fixture-token' : undefined,
                store: async () => { throw new Error('The submit flow must not save credentials.'); },
                delete: async () => { throw new Error('The submit flow must not delete credentials.'); },
                onDidChange: secretsChanged.event,
            },
        } as unknown as vscode.ExtensionContext;
        const originalSnapshot = jenkinsGit.readJenkinsGitSnapshot;
        const originalQuickPick = vscode.window.showQuickPick;
        const originalInputBox = vscode.window.showInputBox;
        const originalInformationMessage = vscode.window.showInformationMessage;
        const originalListJobs = JenkinsClient.prototype.listJobs;
        const originalGetJob = JenkinsClient.prototype.getJob;
        const originalTrigger = JenkinsClient.prototype.trigger;
        const originalRecent = JenkinsClient.prototype.listRecentBuilds;
        const originalProgress = vscode.window.withProgress;
        const progressTitles: string[] = [];
        const originalGetQueue = JenkinsClient.prototype.getQueue;
        let controller: JenkinsController | undefined;
        let snapshots = 0;
        let mappingIndex = 0;
        let queueReads = 0;
        const submissions: Array<{ url: string; parameters: Record<string, string | number | boolean> }> = [];
        try {
            (jenkinsGit as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = async cwd => {
                assert.strictEqual(cwd, folder.uri.fsPath);
                snapshots++;
                return { ...snapshot };
            };
            (vscode.window as { withProgress: typeof originalProgress }).withProgress = (options, task) => {
                progressTitles.push(options.title ?? '');
                return originalProgress.call(vscode.window, options, task) as ReturnType<typeof task>;
            };
            // Dialog choices are deterministic; the real controller constructs and validates their contents.
            (vscode.window as { showQuickPick: typeof originalQuickPick }).showQuickPick = (async (input: unknown, options?: vscode.QuickPickOptions) => {
                const items = await input as Array<Record<string, unknown> | string>;
                assert.ok(items.length > 0);
                if (typeof items[0] === 'string') {
                    assert.deepStrictEqual(items, ['smoke', 'full']);
                    return 'full';
                }
                const records = items as Array<Record<string, unknown>>;
                if (options?.canPickMany) { return [records[0]]; }
                if ('reuse' in records[0]) { return records[0]; }
                if ('folder' in records[0] || 'server' in records[0] || 'job' in records[0]) {
                    return records[0];
                }
                if (records[0].id === 'reuse') { return records[0]; }
                const parameter = ['TARGET_BRANCH', 'COMMIT_HASH', 'TRACE_ID'][mappingIndex++];
                const selected = records.find(item => item.name === parameter);
                assert.ok(selected, `Missing declared parameter ${parameter}.`);
                return selected;
            }) as unknown as typeof originalQuickPick;
            (vscode.window as { showInputBox: typeof originalInputBox }).showInputBox = async options => {
                if (options?.title?.startsWith('SHA parameter name')) { return 'COMMIT_HASH'; }
                assert.ok(options?.title === 'NOTE' || options?.title === '__proto__');
                return 'ephemeral-run-note';
            };
            (vscode.window as { showInformationMessage: typeof originalInformationMessage }).showInformationMessage =
                (async (_message: string, _options: vscode.MessageOptions, ...items: string[]) => items[0]) as typeof originalInformationMessage;
            JenkinsClient.prototype.listJobs = async () => [job];
            JenkinsClient.prototype.listRecentBuilds = async () => [];
            JenkinsClient.prototype.getJob = async url => {
                assert.strictEqual(url, job.url);
                return job;
            };
            JenkinsClient.prototype.trigger = async (url, parameters = {}) => {
                submissions.push({ url, parameters: { ...parameters } });
                return { queueUrl };
            };
            JenkinsClient.prototype.getQueue = async url => {
                assert.strictEqual(url, queueUrl);
                queueReads++;
                return { id: 713, why: 'Waiting for NAND fixture' };
            };

            controller = new JenkinsController(context);
            await Promise.all([controller.run(), controller.run()]);
            assert.strictEqual(submissions.length, 1, 'Concurrent clicks must not submit duplicate builds.');
            assert.strictEqual(snapshots, 2, 'The source must be checked again after parameter dialogs.');
            assert.strictEqual(progressTitles.filter(title => title.includes('Git')).length, 2);
            assert.ok(progressTitles.some(title => title.includes('Submitting')));
            assert.strictEqual(mappingIndex, 3);
            assert.strictEqual(submissions[0].url, job.url);
            const stored = workspaceState.values.get(JENKINS_REQUESTS_KEY) as JenkinsRequest[];
            assert.strictEqual(stored.length, 1);
            assert.strictEqual(stored[0].root.queueUrl, queueUrl);
            assert.strictEqual(stored[0].root.buildUrl, undefined);
            assert.strictEqual(stored[0].shaTracking?.jobs[0].afterBuild, 0, 'Root job must also capture a pre-POST baseline.');
            assert.strictEqual(stored[0].sha, requestedSha);
            assert.strictEqual(stored[0].branch, snapshot.branch);
            assert.strictEqual(stored[0].remoteBranch, 'validation/firmware');
            assert.strictEqual(stored[0].shaParameter, 'COMMIT_HASH');
            assert.strictEqual(stored[0].requestIdParameter, 'TRACE_ID');
            assert.deepStrictEqual(submissions[0].parameters, {
                TARGET_BRANCH: 'validation/firmware', COMMIT_HASH: requestedSha, TRACE_ID: stored[0].id,
                SUITE: 'full', NOTE: 'ephemeral-run-note', ['__proto__']: 'ephemeral-run-note',
            });
            assert.strictEqual(stored[0].queueReason, 'Waiting for NAND fixture');
            assert.ok(queueReads >= 1);
            await controller.refresh();
            assert.strictEqual(submissions.length, 1, 'Refresh must only read the queued execution.');
            assert.ok(!JSON.stringify([...workspaceState.values]).includes('ephemeral-run-note'));
            assert.ok(!JSON.stringify([...workspaceState.values]).includes('fixture-token'));
            workspaceState.memento.update = async () => { throw new Error('fixture disk full'); };
            await assert.rejects(controller.run(), /fixture disk full/);
            assert.strictEqual(submissions.length, 1, 'A persistence failure before submission must prevent the POST.');
        } finally {
            controller?.dispose();
            (jenkinsGit as { readJenkinsGitSnapshot: typeof originalSnapshot }).readJenkinsGitSnapshot = originalSnapshot;
            (vscode.window as { showQuickPick: typeof originalQuickPick }).showQuickPick = originalQuickPick;
            (vscode.window as { showInputBox: typeof originalInputBox }).showInputBox = originalInputBox;
            (vscode.window as { showInformationMessage: typeof originalInformationMessage }).showInformationMessage = originalInformationMessage;
            JenkinsClient.prototype.listJobs = originalListJobs;
            JenkinsClient.prototype.getJob = originalGetJob;
            JenkinsClient.prototype.trigger = originalTrigger;
            JenkinsClient.prototype.listRecentBuilds = originalRecent;
            (vscode.window as { withProgress: typeof originalProgress }).withProgress = originalProgress;
            JenkinsClient.prototype.getQueue = originalGetQueue;
            secretsChanged.dispose();
        }
    });
});
