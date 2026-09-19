import * as assert from 'node:assert';
import { once } from 'node:events';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { JenkinsClient, JenkinsTransportGuard } from '../jenkins/client';
import { aggregate, createRequest } from '../jenkins/model';
import { pollJenkinsRequest, TrackingOptions } from '../jenkins/tracking';
import { JenkinsBuild, JenkinsRequest, JenkinsServer } from '../jenkins/types';

interface ResponseFixture { status: number; body: unknown; }
interface ReceivedRequest { method?: string; pathname: string; query: URLSearchParams; authorization?: string; }

/** Real HTTP responses exercise the transport, discovery, and aggregate boundaries together. */
class JenkinsFixture {
    readonly routes = new Map<string, ResponseFixture>();
    readonly requests: ReceivedRequest[] = [];
    private readonly sockets = new Set<Socket>();
    private readonly server: http.Server;
    configuration!: JenkinsServer;

    constructor(readonly id: string, readonly token = `token-${id}`) {
        this.server = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', this.configuration.url);
            this.requests.push({ method: request.method, pathname: url.pathname, query: url.searchParams,
                authorization: request.headers.authorization });
            const route = this.routes.get(url.pathname) ?? { status: 404, body: {} };
            response.writeHead(route.status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(route.body));
        });
        this.server.on('connection', socket => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
    }

    async start(): Promise<this> {
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        const address = this.server.address();
        assert.ok(address && typeof address !== 'string');
        this.configuration = { id: this.id, name: this.id, username: `user-${this.id}`,
            allowInsecureHttp: true, url: `http://127.0.0.1:${address.port}/jenkins/` };
        return this;
    }

    async close(): Promise<void> {
        for (const socket of this.sockets) { socket.destroy(); }
        await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    }

    url(path: string): string { return new URL(path, this.configuration.url).href; }

    reply(path: string, body: unknown, status = 200): void {
        this.routes.set(new URL(path, this.configuration.url).pathname, { status, body });
    }

    build(job: string, number: number, changes: Partial<JenkinsBuild> = {}): JenkinsBuild {
        const value: JenkinsBuild = { url: this.url(`job/${job}/${number}/`), number, building: false,
            result: 'SUCCESS', actions: [{ lastBuiltRevision: { SHA1: 'a'.repeat(40) } }], ...changes };
        this.reply(`job/${job}/${number}/api/json`, value);
        return value;
    }

    inventory(jobs: Array<{ name: string; builds: JenkinsBuild[] }>): void {
        this.reply('api/json', { jobs: jobs.map(job => ({ name: job.name,
            url: this.url(`job/${job.name}/`), buildable: true, _class: 'hudson.model.FreeStyleProject' })) });
        for (const job of jobs) { this.reply(`job/${job.name}/api/json`, { builds: job.builds }); }
    }
}

suite('Jenkins request tracking over HTTP', function () {
    this.timeout(10_000);
    let fixtures: JenkinsFixture[];
    let first: JenkinsFixture;
    let second: JenkinsFixture;

    setup(async () => {
        fixtures = [];
        first = await addFixture('host');
        second = await addFixture('ftl');
    });

    teardown(async () => {
        await Promise.all(fixtures.map(fixture => fixture.close()));
    });

    async function addFixture(id: string): Promise<JenkinsFixture> {
        const fixture = await new JenkinsFixture(id).start();
        fixtures.push(fixture);
        return fixture;
    }

    function request(buildUrl?: string): JenkinsRequest {
        return createRequest({ id: 'request-unique-1', createdAt: 1000, repoPath: '/workspace/fw',
            branch: 'feature/ftl-gc', sha: 'a'.repeat(40),
            root: { serverId: first.id, jobUrl: first.url('job/root/'),
                queueUrl: first.url('queue/item/81/'), buildUrl } });
    }

    function options(changes: Partial<TrackingOptions> = {}, maxJobs = 200): TrackingOptions {
        return {
            servers: [first.configuration, second.configuration], discover: true, recentBuildLimit: 20,
            manifestArtifact: 'taskhub-jenkins-runs.json',
            client: async server => new JenkinsClient(server, {
                token: fixtures.find(fixture => fixture.id === server.id)!.token,
                timeoutMs: 1000, maxJobs,
            }), ...changes,
        };
    }

    function publishManifest(root: JenkinsBuild, runs: string[], complete = true): void {
        root.artifacts = [{ fileName: 'taskhub-jenkins-runs.json', relativePath: 'taskhub-jenkins-runs.json' }];
        first.reply('job/root/42/api/json', root);
        first.reply('job/root/42/artifact/taskhub-jenkins-runs.json', {
            schemaVersion: 1, rootBuildUrl: root.url, complete,
            runs: runs.map(buildUrl => ({ buildUrl })),
        });
    }

    test('IT-229: queue → 두 서버의 24개 테스트를 같은 요청으로 추적하고 서버별 인증을 분리한다', async () => {
        const tracked = request();
        first.reply('queue/item/81/api/json', { id: 81, why: 'Waiting for an executor', executable: null });
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.root.buildUrl, undefined);
        assert.strictEqual(tracked.queueReason, 'Waiting for an executor');
        assert.strictEqual(tracked.runs.length, 0);
        assert.strictEqual(second.requests.length, 0);

        const root = first.build('root', 42, { building: true, result: null });
        const children = Array.from({ length: 24 }, (_, index) => {
            const fixture = index < 12 ? first : second;
            return fixture.build(`test-${index}`, index + 1,
                index === 23 ? { building: true, result: null } : {});
        });
        publishManifest(root, [...children.map(build => build.url), children[0].url]);
        first.reply('queue/item/81/api/json', { id: 81, executable: { url: root.url, number: 42 } });
        second.reply('job/test-23/24/wfapi/describe', { stages: [{ id: 'verify', name: 'Verify recovery', status: 'IN_PROGRESS' }] });

        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.root.buildUrl, root.url);
        assert.strictEqual(tracked.runs.length, 25, '중복 manifest URL은 실행 개수를 늘리지 않는다');
        assert.strictEqual(aggregate(tracked).counts.total, 25);
        assert.strictEqual(aggregate(tracked).counts.running, 2);
        assert.strictEqual(aggregate(tracked).phase, 'active');
        assert.strictEqual(tracked.discovery.complete, false, '대표 빌드 실행 중에는 manifest가 있어도 목록을 확정하지 않는다');
        assert.strictEqual(tracked.runs.find(run => run.url === children[23].url)?.stages?.stages?.[0].status, 'IN_PROGRESS');

        root.building = false;
        root.result = 'FAILURE';
        publishManifest(root, children.map(build => build.url));
        second.build('test-23', 24, { result: 'FAILURE' });
        second.reply('job/test-23/24/wfapi/describe', { stages: [{ id: 'verify', name: 'Verify recovery', status: 'FAILED' }] });
        second.reply('job/test-23/24/testReport/api/json', { passCount: 2, failCount: 1, skipCount: 0,
            suites: [{ cases: [{ name: 'recover_mapping', status: 'FAILED', errorDetails: 'fixture assertion' }] }] });

        await pollJenkinsRequest(tracked, options());
        const summary = aggregate(tracked);
        assert.strictEqual(summary.phase, 'complete');
        assert.strictEqual(summary.counts.total, 25);
        assert.strictEqual(summary.counts.passed, 23);
        assert.strictEqual(summary.counts.failed, 2);
        assert.strictEqual(summary.observedResult, 'failed');
        assert.strictEqual(summary.allPassed, false);
        assert.ok(tracked.settledAt);
        assert.strictEqual(tracked.runs.find(run => run.url === children[23].url)?.tests?.suites?.[0].cases?.[0].name, 'recover_mapping');

        for (const fixture of fixtures) {
            assert.ok(fixture.requests.length > 0);
            const expected = `Basic ${Buffer.from(`${fixture.configuration.username}:${fixture.token}`).toString('base64')}`;
            assert.ok(fixture.requests.every(received => received.authorization === expected), fixture.id);
            assert.ok(fixture.requests.every(received => received.method === 'GET'), 'polling 중 빌드를 재요청하면 안 된다');
        }
    });

    test('IT-229b: 성공한 대표 빌드도 manifest 목록이 완성된 뒤에만 전체 PASS로 확정한다', async () => {
        const root = first.build('root', 42);
        const child = second.build('ftl', 1);
        publishManifest(root, [child.url], false);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(aggregate(tracked).observedResult, 'passed');
        assert.strictEqual(aggregate(tracked).allPassed, false);
        assert.strictEqual(tracked.settledAt, undefined);

        publishManifest(root, [child.url], true);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(aggregate(tracked).phase, 'complete');
        assert.strictEqual(aggregate(tracked).allPassed, true);
        assert.strictEqual(aggregate(tracked).counts.total, 2);
        assert.ok(tracked.settledAt);
        assert.strictEqual(tracked.runs.find(run => run.url === child.url)?.tests, null, '보고서의 404는 미지원으로 허용한다');
        assert.strictEqual(tracked.runs.find(run => run.url === child.url)?.stages, null);
    });

    test('IT-230: manifest의 미등록 서버는 조회하지 않고 전체 결과를 확정하지 않는다', async () => {
        const unregistered = await addFixture('unregistered');
        const root = first.build('root', 42);
        const validChild = second.build('ftl', 1);
        publishManifest(root, [validChild.url, unregistered.url('job/secret/1/')]);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.discovery.complete, false);
        assert.strictEqual(tracked.discovery.message, 'manifestInvalid');
        assert.strictEqual(tracked.runs.length, 1, '전체 manifest 검증 전에 일부 항목을 조회하면 안 된다');
        assert.strictEqual(second.requests.length, 0);
        assert.strictEqual(unregistered.requests.length, 0, '등록하지 않은 origin에는 인증과 조회 모두 보내지 않는다');
        assert.strictEqual(aggregate(tracked).allPassed, false);
        assert.strictEqual(tracked.settledAt, undefined);
    });

    test('IT-231: job 탐색 한도를 넘으면 대표 SUCCESS를 전체 PASS로 오인하지 않는다', async () => {
        const root = first.build('root', 42);
        first.inventory([{ name: 'root', builds: [root] }, { name: 'hidden', builds: [] }]);
        second.inventory([]);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options({}, 1));
        assert.strictEqual(tracked.discovery.message, 'discoveryLimited');
        assert.strictEqual(tracked.discovery.complete, false);
        assert.strictEqual(aggregate(tracked).observedResult, 'passed');
        assert.strictEqual(aggregate(tracked).allPassed, false);
        assert.strictEqual(tracked.settledAt, undefined);
        assert.ok(!first.requests.some(received => received.pathname === '/jenkins/job/hidden/api/json'));
    });

    test('IT-231b: 최근 빌드 범위 밖의 실행을 찾았다고 표시하지 않는다', async () => {
        const root = first.build('root', 42);
        const unrelated = first.build('child', 3);
        const oldMatch = first.build('child', 2, { actions: [{ causes: [{ upstreamUrl: 'job/root/', upstreamBuild: 42 }] }] });
        first.inventory([{ name: 'child', builds: [unrelated, oldMatch] }]);
        second.inventory([]);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options({ recentBuildLimit: 1 }));
        assert.strictEqual(tracked.runs.length, 1);
        assert.strictEqual(tracked.discovery.message, 'discoveryBounded');
        assert.strictEqual(aggregate(tracked).allPassed, false);
        const inventory = first.requests.find(received => received.pathname === '/jenkins/job/child/api/json');
        assert.ok(inventory?.query.get('tree')?.endsWith('{0,1}'));
        assert.ok(!first.requests.some(received => received.pathname === '/jenkins/job/child/2/api/json'));
    });

    test('IT-232: 같은 브랜치·SHA·빌드 번호도 정확한 upstream 또는 요청 ID 없이는 연결하지 않는다', async () => {
        const root = first.build('root', 42);
        const matching = first.build('child', 7, { actions: [{ causes: [{ upstreamUrl: 'job/root/', upstreamBuild: 42 }] }] });
        const wrongParent = first.build('child', 8, { actions: [{ causes: [{ upstreamUrl: 'job/root/', upstreamBuild: 41 }] }] });
        const sameSha = first.build('child', 9, { actions: [{ parameters: [
            { name: 'BRANCH', value: 'feature/ftl-gc' }, { name: 'SHA', value: 'a'.repeat(40) },
        ], lastBuiltRevision: { SHA1: 'a'.repeat(40) } }] });
        const sameNumberOtherServer = second.build('child', 7, { actions: [{ causes: [{ upstreamUrl: 'job/root/', upstreamBuild: 42 }] }] });
        const explicitId = second.build('child', 8, { actions: [{ parameters: [{ name: 'REQUEST_ID', value: 'request-unique-1' }] }] });
        first.inventory([{ name: 'child', builds: [sameSha, wrongParent, matching] }]);
        second.inventory([{ name: 'child', builds: [explicitId, sameNumberOtherServer] }]);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.deepStrictEqual(tracked.runs.map(run => run.url).sort(), [root.url, matching.url].sort());
        assert.strictEqual(tracked.runs.find(run => run.url === matching.url)?.correlation, 'upstream');

        tracked.requestIdParameter = 'REQUEST_ID';
        await pollJenkinsRequest(tracked, options());
        assert.deepStrictEqual(tracked.runs.map(run => run.url).sort(), [root.url, matching.url, explicitId.url].sort());
        assert.strictEqual(tracked.runs.find(run => run.url === explicitId.url)?.correlation, 'requestId');
        assert.ok(!second.requests.some(received => received.pathname === '/jenkins/job/child/7/api/json'));
        assert.strictEqual(aggregate(tracked).allPassed, false, '자동 탐색은 목록 완전성을 증명하지 않는다');
    });

    test('IT-233: 중지·완료한 요청은 서버 인증이나 GET을 다시 시작하지 않는다', async () => {
        for (const state of [{ stopped: true }, { settledAt: 2000 }]) {
            const tracked = { ...request(), ...state };
            let createdClients = 0;
            await pollJenkinsRequest(tracked, options({ client: async server => {
                createdClients++;
                return new JenkinsClient(server, { token: 'unused-token' });
            } }));
            assert.strictEqual(createdClients, 0);
        }
        assert.ok(fixtures.every(fixture => fixture.requests.length === 0));
    });

    test('IT-234: 만료된 queue는 최근 빌드가 아니라 정확한 queueId로 복구한다', async () => {
        const unrelated = first.build('root', 44, { queueId: 82 });
        const actual = first.build('root', 42, { queueId: 81 });
        first.inventory([{ name: 'root', builds: [unrelated, actual] }]);
        const tracked = request();
        await pollJenkinsRequest(tracked, options({ discover: false }));
        assert.strictEqual(tracked.root.buildUrl, actual.url);
        assert.strictEqual(tracked.error, undefined);
        assert.strictEqual(tracked.runs[0].number, 42);
        assert.ok(!first.requests.some(received => received.pathname === '/jenkins/job/root/44/api/json'));
        assert.ok(!first.requests.some(received => received.pathname.includes('lastBuild')));
    });

    test('IT-234b: 만료된 queue의 정확한 실행을 찾지 못하면 다른 빌드를 가져오거나 재실행하지 않는다', async () => {
        first.inventory([{ name: 'root', builds: [first.build('root', 44, { queueId: 82 })] }]);
        const tracked = request();
        await pollJenkinsRequest(tracked, options({ discover: false }));
        assert.strictEqual(tracked.root.buildUrl, undefined);
        assert.strictEqual(tracked.error, 'JENKINS_QUEUE_EXPIRED');
        assert.deepStrictEqual(tracked.runs, []);
        assert.ok(first.requests.every(received => received.method === 'GET'));
        assert.strictEqual(aggregate(tracked).allPassed, false);
    });

    test('IT-235: 테스트 보고서 권한 오류를 미지원으로 숨기거나 전체 PASS로 확정하지 않는다', async () => {
        const root = first.build('root', 42);
        publishManifest(root, []);
        first.reply('job/root/42/testReport/api/json', { error: 'private fixture response' }, 403);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.runs[0].reportErrors?.tests, 'FORBIDDEN', '403 must remain a report permission error');
        assert.strictEqual(tracked.runs[0].error, undefined);
        assert.strictEqual(aggregate(tracked).allPassed, false);
        assert.strictEqual(tracked.settledAt, undefined);
        assert.ok(!JSON.stringify(tracked).includes('private fixture response'));
    });

    test('IT-235b: SUCCESS 빌드에 게시된 테스트 실패가 있으면 전체 테스트 PASS로 표시하지 않는다', async () => {
        const root = first.build('root', 42);
        const child = second.build('ftl', 1);
        publishManifest(root, [child.url]);
        second.reply('job/ftl/1/testReport/api/json', { passCount: 10, failCount: 1, skipCount: 0 });
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.runs.find(run => run.url === child.url)?.result, 'SUCCESS', '원본 빌드 결과는 보존한다');
        assert.strictEqual(tracked.runs.find(run => run.url === child.url)?.tests?.failCount, 1);
        assert.strictEqual(aggregate(tracked).allPassed, false, '보고서에 실패한 테스트가 있으면 전체 PASS일 수 없다');
        assert.strictEqual(aggregate(tracked).observedResult, 'failed');
    });

    test('IT-235c: 실행 플래그가 꺼져도 결과가 미정이면 추적을 종료하지 않고 이후 확정 결과를 읽는다', async () => {
        const root = first.build('root', 42);
        const child = second.build('ftl', 1, { building: false, result: null });
        publishManifest(root, [child.url]);
        const tracked = request(root.url);
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.discovery.complete, true, '목록이 완전해도 결과는 아직 없을 수 있다');
        assert.strictEqual(tracked.settledAt, undefined);
        assert.strictEqual(aggregate(tracked).counts.unknown, 1);
        assert.strictEqual(aggregate(tracked).allPassed, false);

        second.build('ftl', 1, { building: false, result: 'UNRECOGNIZED_RESULT' });
        await pollJenkinsRequest(tracked, options());
        assert.strictEqual(tracked.settledAt, undefined, '알 수 없는 결과도 완료로 확정하지 않는다');
        assert.strictEqual(aggregate(tracked).counts.unknown, 1);

        second.build('ftl', 1);
        await pollJenkinsRequest(tracked, options());
        assert.ok(tracked.settledAt);
        assert.strictEqual(aggregate(tracked).allPassed, true);
    });

    test('IT-255: shared guard isolates optional report permissions over three HTTP polls and recovers after cooldown', async () => {
        let now = 1000;
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const client = new JenkinsClient(first.configuration, { token: first.token, guard, timeoutMs: 1000 });
        const root = first.build('root', 42);
        publishManifest(root, []);
        first.reply('job/root/42/testReport/api/json', { private: 'never-display' }, 403);
        first.reply('whoAmI/api/json', { authenticated: true, name: 'developer' });
        const tracked = request(root.url);
        first.requests.length = 0;
        const settings = options({ client: async () => client, discover: false });
        for (let index = 0; index < 3; index++) {
            const before = first.requests.length;
            await pollJenkinsRequest(tracked, settings);
            assert.ok(first.requests.length > before, 'Every round must still read the root build.');
            assert.strictEqual(tracked.error, undefined);
            assert.strictEqual(tracked.runs[0].error, undefined);
            assert.strictEqual(tracked.runs[0].result, 'SUCCESS');
            assert.strictEqual(tracked.runs[0].reportErrors?.tests, 'FORBIDDEN');
            assert.strictEqual(aggregate(tracked).rootStatus, 'passed');
            assert.strictEqual(aggregate(tracked).allPassed, false);
            assert.strictEqual(tracked.settledAt, undefined);
            await client.verify();
        }
        assert.strictEqual(first.requests.filter(entry => entry.pathname.endsWith('/testReport/api/json')).length, 1);
        const other = first.build('other', 1);
        first.reply('job/other/1/testReport/api/json', { passCount: 1, failCount: 0, skipCount: 0 });
        assert.strictEqual((await client.getTestReport(other.url))?.passCount, 1);
        first.reply('job/root/42/testReport/api/json', { passCount: 2, failCount: 0, skipCount: 0 });
        now += 60001;
        await pollJenkinsRequest(tracked, settings);
        assert.strictEqual(tracked.runs[0].reportErrors, undefined);
        assert.strictEqual(aggregate(tracked).allPassed, true);
        assert.ok(tracked.settledAt);
        assert.ok(!JSON.stringify(tracked).includes('never-display'));
    });


    test('IT-260: expired credentials on 100 tracked builds cause at most two in-flight HTTP failures, not a polling storm', async () => {
        const root = first.build('root', 42);
        const tracked = request(root.url);
        const builds = [root, ...Array.from({ length: 99 }, (_, index) => first.build(`child${index}`, 1))];
        tracked.runs = builds.map((build, index) => ({ ...build, jobUrl: build.url.replace(/\d+\/$/, ''),
            serverId: first.id, correlation: index === 0 ? 'root' : 'manifest' }));
        for (const build of builds) { first.reply(new URL('api/json', build.url).href, {}, 401); }
        const guard = new JenkinsTransportGuard(() => 1000, () => 0);
        const settings = options({ discover: false, client: async server => new JenkinsClient(server, {
            token: server.id === first.id ? first.token : second.token, guard,
        }) });
        await pollJenkinsRequest(tracked, settings);
        assert.ok(first.requests.length >= 1 && first.requests.length <= 2);
        const initial = first.requests.length;
        assert.ok(tracked.runs.every(run => run.error === 'AUTH_REQUIRED'));
        for (let index = 0; index < 3; index++) { await pollJenkinsRequest(tracked, settings); }
        assert.strictEqual(first.requests.length, initial);
        assert.strictEqual(tracked.error, 'AUTH_REQUIRED');
        assert.strictEqual(aggregate(tracked).allPassed, false);
        second.reply('whoAmI/api/json', { authenticated: true, name: 'developer' });
        await (await settings.client(second.configuration)).verify();
        assert.strictEqual(second.requests.length, 1);
    });

});
