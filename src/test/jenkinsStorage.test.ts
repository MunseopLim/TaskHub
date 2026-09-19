import * as assert from 'assert';
import type * as vscode from 'vscode';
import { aggregate, createRequest } from '../jenkins/model';
import {
    JENKINS_REQUESTS_KEY, JENKINS_SERVERS_KEY, JenkinsStore, jenkinsSecretKey,
} from '../jenkins/storage';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild } from '../jenkins/types';

class MemoryState implements vscode.Memento {
    private readonly values = new Map<string, unknown>();
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }
    keys(): readonly string[] { return [...this.values.keys()]; }
    setKeysForSync(_keys: readonly string[]): void {}
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) { this.values.delete(key); }
        else { this.values.set(key, JSON.parse(JSON.stringify(value))); }
    }
}

class MemorySecrets implements vscode.SecretStorage {
    readonly values = new Map<string, string>();
    failWrites = false;
    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({ dispose() {} });
    async keys(): Promise<string[]> { return [...this.values.keys()]; }
    async get(key: string): Promise<string | undefined> { return this.values.get(key); }
    async store(key: string, value: string): Promise<void> {
        if (this.failWrites) { throw new Error('Secret storage unavailable'); }
        this.values.set(key, value);
    }
    async delete(key: string): Promise<void> { this.values.delete(key); }
}

const server: JenkinsServer = {
    id: 'main', name: 'Firmware CI', url: 'https://ci.example/jenkins/', username: 'developer',
};

function request(id: string, createdAt: number): JenkinsRequest {
    return createRequest({
        id, createdAt, branch: 'main', sha: 'a'.repeat(40), repoPath: '/repository',
        root: { serverId: server.id, jobUrl: `${server.url}job/firmware/`, buildUrl: `${server.url}job/firmware/1/` },
    });
}

function run(): TrackedJenkinsBuild {
    return {
        serverId: server.id, jobUrl: `${server.url}job/firmware/`, url: `${server.url}job/firmware/1/`,
        number: 1, building: false, result: 'SUCCESS', correlation: 'root',
    };
}

suite('Jenkins persistent state and credentials', () => {
    let globalState: MemoryState;
    let workspaceState: MemoryState;
    let secrets: MemorySecrets;
    let store: JenkinsStore;

    setup(() => {
        globalState = new MemoryState();
        workspaceState = new MemoryState();
        secrets = new MemorySecrets();
        store = new JenkinsStore({ globalState, workspaceState, secrets });
    });

    test('negative report counts and build numbers cannot restore a successful request', async () => {
        for (const bad of [{ ...run(), number: -1 }, { ...run(), tests: { passCount: 10, failCount: -1, skipCount: 0 } }]) {
            const value = request('corrupted', 1);
            value.discovery.complete = true;
            value.runs = [bad];
            await workspaceState.update(JENKINS_REQUESTS_KEY, [value]);
            assert.deepStrictEqual(store.requests(), []);
        }
    });

    test('server metadata round trips without storing tokens outside SecretStorage', async () => {
        const supplied = { ...server, token: 'private-token', password: 'private-password' };
        await store.saveServer(supplied, 'private-token');
        assert.deepStrictEqual(store.servers(), [server]);
        assert.strictEqual(await store.token(server), 'private-token');
        assert.ok(!JSON.stringify(globalState.get(JENKINS_SERVERS_KEY)).includes('private-'));
        assert.deepStrictEqual(workspaceState.keys(), []);
        const renamed = { ...server, name: 'Renamed server' };
        await store.saveServer(renamed);
        assert.strictEqual(await store.token(renamed), 'private-token');
        assert.strictEqual(store.servers().length, 1);
    });

    test('changing a destination or username requires new credentials and removes the old secret', async () => {
        await store.saveServer(server, 'old-token');
        const changed = { ...server, url: 'https://replacement.example/', username: 'other-user' };
        await assert.rejects(store.saveServer(changed), /JENKINS_NEW_DESTINATION_REQUIRES_TOKEN/);
        assert.deepStrictEqual(store.servers(), [server]);
        assert.strictEqual(await store.token(server), 'old-token');
        assert.strictEqual(await store.token(changed), undefined);
        await store.saveServer(changed, 'replacement-token');
        assert.deepStrictEqual(store.servers(), [changed]);
        assert.strictEqual(await store.token(server), undefined);
        assert.strictEqual(await store.token(changed), 'replacement-token');
        assert.notStrictEqual(jenkinsSecretKey(server), jenkinsSecretKey({ ...server, username: 'other-user' }));
    });

    test('a secret storage failure cannot publish the new server destination', async () => {
        await store.saveServer(server, 'old-token');
        secrets.failWrites = true;
        const changed = { ...server, url: 'https://replacement.example/' };
        await assert.rejects(store.saveServer(changed, 'new-token'), /Secret storage unavailable/);
        assert.deepStrictEqual(store.servers(), [server]);
        assert.strictEqual(await store.token(server), 'old-token');
    });

    test('removing one server removes only its credentials', async () => {
        const second = { ...server, id: 'lab', url: 'https://lab.example/' };
        await store.saveServer(server, 'main-token');
        await store.saveServer(second, 'lab-token');
        await store.removeServer(server.id);
        assert.deepStrictEqual(store.servers(), [second]);
        assert.strictEqual(await store.token(server), undefined);
        assert.strictEqual(await store.token(second), 'lab-token');
    });

    test('request history preserves every active request and only the newest completed requests', async () => {
        const active = request('active', 1);
        active.runs = [run()];
        active.discovery.complete = false;
        active.notified.failure = true;
        const old = { ...request('old', 2), settledAt: 20 };
        const newer = { ...request('newer', 3), stopped: true };
        const newest = { ...request('newest', 4), settledAt: 40 };
        await store.saveRequests([old, active, newest, newer], 2);
        const restored = new JenkinsStore({ globalState, workspaceState, secrets }).requests();
        assert.deepStrictEqual(restored.map(item => item.id), ['newest', 'newer', 'active']);
        assert.strictEqual(restored[2].notified.failure, true);
        assert.strictEqual(aggregate(restored[2]).allPassed, false);
        assert.deepStrictEqual(globalState.keys(), []);
    });

    test('zero history limits keep active requests and reject negative limit semantics', async () => {
        const active = request('active', 1);
        const completedAtEpoch = { ...request('done', 2), settledAt: 0 };
        await store.saveRequests([active, completedAtEpoch], 0);
        assert.deepStrictEqual(store.requests().map(item => item.id), ['active']);
        await store.saveRequests([active, completedAtEpoch], -1);
        assert.deepStrictEqual(store.requests().map(item => item.id), ['active']);
    });

    test('only display fields persist from requests, network actions, stage payloads and testcase diagnostics', async () => {
        const tracked = request('safe', 1);
        tracked.repoRemote = 'https://username:url-secret@example.com/firmware.git?token=query-secret';
        Object.assign(tracked, { authorization: 'top-level-secret' });
        Object.assign(tracked.root, { token: 'root-secret' });
        Object.assign(tracked.discovery, { responseBody: 'discovery-secret' });
        const build = run();
        build.actions = [{ parameters: [{ name: 'TOKEN', value: 'action-secret' }] }];
        build.stages = { stages: [Object.assign({ id: '1', name: 'Tests', status: 'SUCCESS' }, { logs: 'stage-secret' })] };
        build.tests = {
            passCount: 1, failCount: 0, skipCount: 0,
            suites: [{ cases: [{ name: 'test', status: 'PASSED', errorDetails: 'test-secret' }] }],
        };
        tracked.runs = [build];
        await store.saveRequests([tracked]);
        const serialized = JSON.stringify(workspaceState.get(JENKINS_REQUESTS_KEY));
        assert.ok(!serialized.includes('-secret'), serialized);
        const restored = store.requests()[0];
        assert.strictEqual(restored.repoRemote, 'https://example.com/firmware.git');
        assert.deepStrictEqual(restored.runs[0].tests, { passCount: 1, failCount: 0, skipCount: 0 });
        assert.deepStrictEqual(restored.runs[0].stages?.stages, [{ id: '1', name: 'Tests', status: 'SUCCESS', durationMillis: undefined }]);
        assert.strictEqual(restored.runs[0].actions, undefined);
        assert.strictEqual(build.actions?.length, 1, 'saving must not mutate the live result');
    });

    test('restoring malformed persisted data does not crash or silently drop a corrupt child into success', async () => {
        await globalState.update(JENKINS_SERVERS_KEY, [null, 1, { id: 'broken' }, server]);
        assert.deepStrictEqual(store.servers(), [server]);
        const badRequest = { ...request('bad', 1), discovery: { complete: true }, runs: [run(), null] };
        await workspaceState.update(JENKINS_REQUESTS_KEY, [null, 123, badRequest, request('valid', 2)]);
        assert.deepStrictEqual(store.requests().map(item => item.id), ['valid']);
        await workspaceState.update(JENKINS_REQUESTS_KEY, { invalid: true });
        assert.deepStrictEqual(store.requests(), []);
    });

    test('workspace requests are isolated while credentials and servers can be shared', async () => {
        await store.saveServer(server, 'shared-token');
        await store.saveRequests([request('workspace-one', 1)]);
        const second = new JenkinsStore({ globalState, workspaceState: new MemoryState(), secrets });
        assert.deepStrictEqual(second.requests(), []);
        assert.deepStrictEqual(second.servers(), [server]);
        assert.strictEqual(await second.token(server), 'shared-token');
    });

    test('profiles are keyed by server and job, tolerate corrupt entries, and replace previous choices', async () => {
        await workspaceState.update('taskhub.jenkins.jobs.v1', [null, { invalid: true }]);
        assert.strictEqual(store.profile('main', '/job/test/'), undefined);
        await store.saveProfile({ serverId: 'main', jobUrl: '/job/test/', branchParameter: 'BRANCH' });
        await store.saveProfile({ serverId: 'lab', jobUrl: '/job/test/', branchParameter: 'LAB_BRANCH' });
        await store.saveProfile({ serverId: 'main', jobUrl: '/job/test/', branchParameter: 'GIT_BRANCH', shaParameter: 'SHA' });
        assert.strictEqual(store.profile('main', '/job/test/')?.branchParameter, 'GIT_BRANCH');
        assert.strictEqual(store.profile('main', '/job/test/')?.shaParameter, 'SHA');
        assert.strictEqual(store.profile('lab', '/job/test/')?.branchParameter, 'LAB_BRANCH');
        assert.strictEqual(store.profile('main', '/job/other/'), undefined);
    });
    test('oversized optional display data is reclaimed and damaged nested summaries are not restored as success', async () => {
        await store.saveRequests([request('valid', 1)]);
        const oversized = request('oversized', 2);
        oversized.queueReason = 'x'.repeat(8 * 1024 * 1024);
        await store.saveRequests([oversized]);
        assert.strictEqual(store.requests()[0].id, 'oversized');
        assert.strictEqual(store.requests()[0].queueReason, undefined);
        const malformed = request('malformed', 3);
        malformed.runs = [Object.assign(run(), { actualSha: { malformed: true } })];
        await workspaceState.update(JENKINS_REQUESTS_KEY, [malformed]);
        assert.deepStrictEqual(store.requests(), []);
    });

    test('stage-heavy active history recovers below the byte limit and saves later failures', async () => {
        const values = [request('first', 1), request('second', 2)];
        for (const value of values) {
            value.discovery.complete = true;
            value.runs = Array.from({ length: 1000 }, (_, index) => ({ ...run(), number: index + 1,
                url: `${server.url}job/firmware/${index + 1}/`, correlation: index === 0 ? 'root' as const : 'manifest' as const,
                stages: { stages: Array.from({ length: 50 }, () => ({ id: 'x'.repeat(128), name: 'y'.repeat(128), status: 'SUCCESS' })) } }));
        }
        assert.ok(Buffer.byteLength(JSON.stringify(values)) > 8 * 1024 * 1024);
        const compacted = await store.saveRequests(values);
        assert.strictEqual(compacted.reduce((sum, value) => sum + value.runs.length, 0), 2000);
        assert.ok(compacted.some(value => value.runs.some(build => build.stages?.detailsTruncated)));
        assert.ok(Buffer.byteLength(JSON.stringify(workspaceState.get(JENKINS_REQUESTS_KEY))) <= 8 * 1024 * 1024);
        values[0].runs[1].result = 'FAILURE';
        await store.saveRequests(values);
        const saved = store.requests().find(value => value.id === 'first')!;
        assert.strictEqual(saved.runs.length, 1000);
        assert.strictEqual(aggregate(saved).observedResult, 'failed');
    });

    test('interrupted new and legacy submissions restore stopped without holding an active slot', async () => {
        for (const legacy of [false, true]) {
            const interrupted = request('interrupted', 1);
            delete interrupted.root.buildUrl;
            if (legacy) { interrupted.error = 'JENKINS_SUBMITTING'; }
            else { interrupted.submission = 'sending'; }
            await store.saveRequests([interrupted]);
            const restored = store.requests()[0];
            assert.strictEqual(restored.stopped, true);
            assert.strictEqual(restored.submission, 'unconfirmed');
            assert.strictEqual(restored.error, 'JENKINS_SUBMISSION_UNCONFIRMED');
            assert.strictEqual(restored.discovery.complete, false);
            assert.strictEqual(restored.root.queueUrl, undefined);
        }
    });

    test('restoring too many active requests stops excess tracking instead of starting unlimited background work', async () => {
        await store.saveRequests(Array.from({ length: 21 }, (_, index) => request(`request-${index}`, index)));
        const restored = store.requests();
        assert.strictEqual(restored.filter(item => !item.stopped).length, 20);
        assert.strictEqual(restored.filter(item => item.error === 'JENKINS_RESTORE_LIMIT').length, 1);
    });


    test('byte reclamation removes oldest active details first and preserves report uncertainty across restore', async () => {
        const older = request('older', 1);
        const newer = request('newer', 2);
        for (const value of [older, newer]) {
            value.discovery.complete = true;
            value.runs = Array.from({ length: 300 }, (_, index) => ({ ...run(), number: index + 1,
                reportErrors: { tests: 'FORBIDDEN' },
                stages: { stages: Array.from({ length: 50 }, () => ({ id: 'x'.repeat(128), name: 'y'.repeat(128), status: 'SUCCESS' })) } }));
        }
        assert.ok(Buffer.byteLength(JSON.stringify([older, newer])) > 8 * 1024 * 1024);
        await store.saveRequests([newer, older]);
        const restored = store.requests();
        const old = restored.find(value => value.id === 'older')!;
        const latest = restored.find(value => value.id === 'newer')!;
        assert.strictEqual(old.runs[0].stages?.detailsTruncated, true);
        assert.strictEqual(latest.runs[0].stages?.stages?.length, 50);
        assert.strictEqual(old.runs[0].reportErrors?.tests, 'FORBIDDEN');
        assert.strictEqual(aggregate(old).allPassed, false);
    });

    test('oversized minimal result history stops oldest active requests before newer requests', async () => {
        const older = request('older', 1);
        const newer = request('newer', 2);
        for (const value of [older, newer]) {
            value.runs = Array.from({ length: 1000 }, (_, index) => ({ ...run(), number: index + 1,
                url: `${server.url}job/${'x'.repeat(2500)}/${index + 1}/`, jobUrl: `${server.url}job/${'x'.repeat(2500)}/` }));
        }
        await store.saveRequests([newer, older]);
        const restored = store.requests();
        assert.strictEqual(restored.find(value => value.id === 'older')?.error, 'JENKINS_STORAGE_LIMIT');
        assert.strictEqual(restored.find(value => value.id === 'newer')?.runs.length, 1000);
        assert.strictEqual(restored.find(value => value.id === 'newer')?.stopped, undefined);
    });

});
