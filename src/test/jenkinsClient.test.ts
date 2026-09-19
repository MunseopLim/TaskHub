import * as assert from 'node:assert';
import { once } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createLocalhostTlsFixture } from './fixtures/jenkins/tls';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import {
    JenkinsClient, JenkinsClientError, JenkinsTransportGuard, jenkinsClientLimits, normalizeJenkinsServerUrl, validateJenkinsServerUrl,
} from '../jenkins/client';
import type { JenkinsServer } from '../jenkins/types';

suite('Jenkins REST client', () => {
    let server: http.Server;
    let configuration: JenkinsServer;
    let client: JenkinsClient;
    let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
    let requests: Array<{ url: string; authorization?: string; method?: string }>;
    let sockets: Set<Socket>;
    const token = 'fixture-token-must-never-appear-in-errors';

    function json(response: http.ServerResponse, value: unknown, status = 200): void {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
    }

    function errorCode(code: string, status?: number): (error: unknown) => boolean {
        return error => {
            assert.ok(error instanceof JenkinsClientError);
            assert.strictEqual(error.code, code);
            assert.strictEqual(error.status, status);
            assert.ok(!error.message.includes(token));
            assert.ok(!error.message.includes(Buffer.from(`developer:${token}`).toString('base64')));
            return true;
        };
    }

    setup(async () => {
        sockets = new Set();
        requests = [];
        handler = (_request, response) => json(response, { message: token }, 404);
        server = http.createServer((request, response) => {
            requests.push({ url: request.url ?? '', authorization: request.headers.authorization, method: request.method });
            handler(request, response);
        });
        server.on('connection', socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        configuration = {
            id: 'fixture', name: 'Jenkins fixture',
            allowInsecureHttp: true, url: `http://127.0.0.1:${address.port}/jenkins/`, username: 'developer',
        };
        client = new JenkinsClient(configuration, { token, timeoutMs: 1000 });
    });

    teardown(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        if (!server.listening) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    });

    test('normalizes an explicitly configured server and rejects URL credentials or query data', () => {
        assert.strictEqual(normalizeJenkinsServerUrl(' https://ci.example/jenkins '), 'https://ci.example/jenkins/');
        assert.strictEqual(normalizeJenkinsServerUrl('http://10.0.0.2:8080'), 'http://10.0.0.2:8080/');
        assert.strictEqual(validateJenkinsServerUrl(configuration.url), undefined);
        for (const value of ['file:///tmp/jenkins', 'https://user:secret@ci.example/',
            'https://ci.example/?token=secret', 'https://ci.example/#fragment', 'not a url']) {
            assert.strictEqual(validateJenkinsServerUrl(value), 'INVALID_URL');
            assert.throws(() => normalizeJenkinsServerUrl(value), errorCode('INVALID_URL'));
        }
    });

    test('HTTP authentication requires a literal explicit opt-in before any connection', () => {
        for (const allowInsecureHttp of [undefined, false, 'true']) {
            assert.throws(() => new JenkinsClient({ ...configuration, allowInsecureHttp } as JenkinsServer, { token }), errorCode('INSECURE_HTTP'));
        }
        assert.strictEqual(requests.length, 0);
    });

    test('artifact names cannot escape the artifact subtree through proxy decoding', async () => {
        for (const path of ['%2e%2e/secret', '%252e%252e%252fsecret', 'safe/%2e%2e/%2e%2e/secret',
            '%2f..%2f..%2fsecret', '%5c..%5c..%5csecret', 'safe%3b/secret', 'safe%00/file']) {
            await assert.rejects(client.getArtifact(`${configuration.url}job/test/1/`, path), errorCode('OUTSIDE_SERVER'));
        }
        assert.strictEqual(requests.length, 0, 'Invalid artifact paths must never receive credentials.');
    });

    test('verifies token authentication against the configured context path', async () => {
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        assert.deepStrictEqual(await client.verify(), { authenticated: true, name: 'developer' });
        assert.deepStrictEqual(requests, [{
            url: '/jenkins/whoAmI/api/json', method: 'GET',
            authorization: `Basic ${Buffer.from(`developer:${token}`).toString('base64')}`,
        }]);
        handler = (_request, response) => json(response, { authenticated: false, name: 'anonymous' });
        await assert.rejects(client.verify(), errorCode('AUTH_REQUIRED'));
    });

    test('discovers folders and multibranch jobs without losing encoded branch names', async () => {
        const folderUrl = `${configuration.url}job/firmware/`;
        const pipelineUrl = `${folderUrl}job/check/`;
        const branchUrl = `${pipelineUrl}job/feature%252Freset/`;
        handler = (request, response) => {
            const path = new URL(request.url!, configuration.url).pathname;
            if (path === '/jenkins/api/json') {
                json(response, { jobs: [{ name: 'firmware', url: folderUrl, _class: 'com.cloudbees.hudson.plugins.folder.Folder' }] });
            } else if (path === '/jenkins/job/firmware/api/json') {
                json(response, { jobs: [{ name: 'check', url: pipelineUrl, _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject' }] });
            } else {
                json(response, { jobs: [
                    { name: 'feature/reset', fullName: 'firmware/check/feature%2Freset', url: branchUrl,
                        buildable: true, _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob' },
                    { name: 'disabled', url: `${pipelineUrl}job/disabled/`, color: 'disabled', _class: 'hudson.model.FreeStyleProject' },
                ] });
            }
        };
        const jobs = await client.listJobs();
        assert.deepStrictEqual(jobs.map(job => [job.kind, job.buildable]),
            [['folder', false], ['multibranch', false], ['job', true], ['job', false]]);
        assert.strictEqual(jobs[1].fullName, 'firmware/check');
        assert.strictEqual(jobs[2].url, branchUrl);
        assert.strictEqual(requests.length, 3);
        await assert.rejects(new JenkinsClient(configuration, { token, maxJobs: 2 }).listJobs(), errorCode('DISCOVERY_LIMIT'));
    });

    test('oversized discovered job identities stop before recursive inventory growth', async () => {
        for (const oversized of [{ name: 'x'.repeat(1025) }, { fullName: 'x'.repeat(4097) }]) {
            handler = (_request, response) => json(response, { jobs: [{ name: 'folder', url: `${configuration.url}job/folder/`,
                _class: 'com.cloudbees.hudson.plugins.folder.Folder', ...oversized }] });
            const before = requests.length;
            await assert.rejects(client.listJobs(), errorCode('INVALID_RESPONSE'));
            assert.strictEqual(requests.length, before + 1);
        }
    });

    test('server-supplied resource queries cannot enter persisted job or queue identities', async () => {
        handler = (_request, response) => json(response, { jobs: [{ name: 'private', url: `${configuration.url}job/test/?token=${token}` }] });
        await assert.rejects(client.listJobs(), errorCode('OUTSIDE_SERVER'));
        handler = (_request, response) => { response.writeHead(201, { Location: `${configuration.url}queue/item/1/?token=${token}` }); response.end(); };
        await assert.rejects(client.trigger(`${configuration.url}job/test/`), errorCode('QUEUE_LOCATION_MISSING', 201));
    });

    test('normalizes pipeline and legacy parameter definitions', async () => {
        const jobUrl = `${configuration.url}job/firmware/`;
        handler = (_request, response) => json(response, {
            name: 'firmware', fullName: 'firmware', url: jobUrl, buildable: true,
            property: [{ parameterDefinitions: [
                { name: 'GIT_REF', type: 'StringParameterDefinition', defaultParameterValue: { value: 'main' } },
                { name: 'SUITE', _class: 'hudson.model.ChoiceParameterDefinition', description: 'Test suite',
                    choices: ['smoke', 'full'], defaultParameterValue: { value: 'smoke' } },
            ] }],
            actions: [{ parameterDefinitions: [
                { name: 'POWER_CYCLE', type: 'BooleanParameterDefinition', defaultParameterValue: { value: false } },
            ] }],
        });
        const job = await client.getJob(jobUrl);
        assert.deepStrictEqual(job.parameters, [
            { name: 'GIT_REF', type: 'StringParameterDefinition', defaultValue: 'main' },
            { name: 'SUITE', type: 'ChoiceParameterDefinition', description: 'Test suite', defaultValue: 'smoke', choices: ['smoke', 'full'] },
            { name: 'POWER_CYCLE', type: 'BooleanParameterDefinition', defaultValue: false },
        ]);
    });

    test('submits form parameters once and follows its queue into the exact build', async () => {
        const jobUrl = `${configuration.url}job/test/`;
        const buildUrl = `${jobUrl}47/`;
        let submittedBody = '';
        let queueChecks = 0;
        handler = (request, response) => {
            if (request.method === 'POST') {
                request.setEncoding('utf8');
                request.on('data', chunk => { submittedBody += chunk; });
                request.on('end', () => {
                    response.writeHead(201, { Location: '/jenkins/queue/item/31/' });
                    response.end();
                });
            } else if (request.url!.startsWith('/jenkins/queue/')) {
                json(response, ++queueChecks === 1 ? { id: 31, why: 'Waiting for an executor', executable: null } :
                    { id: 31, executable: { number: 47, url: buildUrl } });
            } else {
                json(response, { url: buildUrl, number: 47, building: true, result: null, queueId: 31,
                    actions: [{ parameters: [{ name: 'REQUEST_ID', value: 'request-1' }],
                        lastBuiltRevision: { SHA1: 'abcdef123456' }, remoteUrls: ['ssh://git/firmware'],
                        causes: [{ upstreamUrl: 'job/root/', upstreamBuild: 12 }] }] });
            }
        };
        const queued = await client.trigger(jobUrl, { GIT_REF: 'feature/한글 & reset', SHA: 'abcdef123456', ENABLED: true });
        assert.strictEqual(queued.queueUrl, `${configuration.url}queue/item/31/`);
        assert.strictEqual(new URLSearchParams(submittedBody).get('GIT_REF'), 'feature/한글 & reset');
        assert.strictEqual(new URLSearchParams(submittedBody).get('ENABLED'), 'true');
        assert.strictEqual((await client.getQueue(queued.queueUrl)).why, 'Waiting for an executor');
        const queue = await client.getQueue(queued.queueUrl);
        assert.deepStrictEqual(queue.executable, { number: 47, url: buildUrl });
        const build = await client.getBuild(queue.executable!.url);
        assert.strictEqual(build.queueId, 31);
        assert.strictEqual(build.actions![0].lastBuiltRevision!.SHA1, 'abcdef123456');
        assert.strictEqual(build.actions![0].causes![0].upstreamBuild, 12);
        assert.deepStrictEqual(requests.filter(request => request.method === 'POST').map(request => request.url),
            ['/jenkins/job/test/buildWithParameters']);
    });

    test('uses the plain build endpoint for jobs without parameters', async () => {
        handler = (_request, response) => {
            response.writeHead(201, { Location: '/jenkins/queue/item/1/' });
            response.end();
        };
        await client.trigger(`${configuration.url}job/plain/`);
        assert.strictEqual(requests[0].url, '/jenkins/job/plain/build');
    });

    test('reads stages, JUnit reports, and byte-based progressive logs', async () => {
        const buildUrl = `${configuration.url}job/test/47/`;
        handler = (request, response) => {
            if (request.url!.includes('/wfapi/')) {
                json(response, { status: 'SUCCESS', stages: [{ id: '7', name: 'NAND tests', status: 'SUCCESS' }] });
            } else if (request.url!.includes('/testReport/')) {
                json(response, { passCount: 12, failCount: 1, skipCount: 2,
                    suites: [{ name: 'reset', cases: [{ name: 'powerLoss', status: 'FAILED', errorDetails: 'timeout' }] }] });
            } else {
                response.writeHead(200, { 'X-Text-Size': '19', 'X-More-Data': 'true' });
                response.end('오류\n');
            }
        };
        assert.strictEqual((await client.getStages(buildUrl))!.stages![0].name, 'NAND tests');
        assert.strictEqual((await client.getTestReport(buildUrl))!.failCount, 1);
        assert.deepStrictEqual(await client.getLog(buildUrl, 12), { text: '오류\n', nextStart: 19, more: true });
        assert.ok(requests[2].url.endsWith('start=12'));
    });

    test('limits recent builds and downloads artifacts with encoded path segments', async () => {
        const jobUrl = `${configuration.url}job/test/`;
        const bytes = Buffer.from([0, 127, 128, 255]);
        handler = (request, response) => {
            if (request.url!.includes('/artifact/')) {
                response.end(bytes);
            } else {
                json(response, { builds: [1, 2].map(number => ({ url: `${jobUrl}${number}/`, number,
                    building: false, result: 'SUCCESS' })) });
            }
        };
        assert.strictEqual((await client.listRecentBuilds(jobUrl, 1)).length, 1);
        assert.ok(new URL(requests[0].url, configuration.url).searchParams.get('tree')!.endsWith('{0,1}'));
        assert.deepStrictEqual(await client.getArtifact(`${jobUrl}1/`, 'firmware files/dump.bin'), bytes);
        assert.strictEqual(requests[1].url, '/jenkins/job/test/1/artifact/firmware%20files/dump.bin');
        await assert.rejects(client.getArtifact(`${jobUrl}1/`, '../secrets'), errorCode('INVALID_PARAMETER'));
    });

    test('only optional 404 endpoints become null; permissions retain HTTP status without response secrets', async () => {
        const buildUrl = `${configuration.url}job/test/1/`;
        assert.strictEqual(await client.getStages(buildUrl), null);
        assert.strictEqual(await client.getTestReport(buildUrl), null);
        await assert.rejects(client.getBuild(buildUrl), errorCode('NOT_FOUND', 404));
        handler = (_request, response) => json(response, { token }, 403);
        await assert.rejects(client.getStages(buildUrl), errorCode('FORBIDDEN', 403));
        await assert.rejects(client.getTestReport(buildUrl), errorCode('FORBIDDEN', 403));
        await assert.rejects(client.trigger(`${configuration.url}job/test/`, { SHA: 'abc' }), errorCode('FORBIDDEN', 403));
        assert.strictEqual(requests.filter(request => request.method === 'POST').length, 1);
        handler = (_request, response) => json(response, { token }, 401);
        await assert.rejects(client.verify(), errorCode('AUTH_REQUIRED', 401));
    });

    test('does not follow redirects or send credentials to other origins or context paths', async () => {
        handler = (_request, response) => {
            response.writeHead(302, { Location: 'https://elsewhere.example/steal' });
            response.end(token);
        };
        await assert.rejects(client.verify(), errorCode('REDIRECT', 302));
        const before = requests.length;
        const origin = new URL(configuration.url).origin;
        for (const url of ['https://elsewhere.example/jenkins/job/test/', `${origin}/jenkins-other/job/test/`,
            `${origin}/other/job/test/`, `${configuration.url}%252e%252e%252foutside/`,
            `${configuration.url}job/test/#secret`, configuration.url.replace('://', '://user:secret@')]) {
            await assert.rejects(client.getBuild(url), errorCode('OUTSIDE_SERVER'));
        }
        assert.strictEqual(requests.length, before);
    });

    test('does not silently retry accepted builds with absent or off-server queue locations', async () => {
        for (const location of [undefined, 'https://elsewhere.example/queue/item/1/', '/outside/queue/item/1/']) {
            handler = (_request, response) => {
                response.writeHead(201, location ? { Location: location } : {});
                response.end();
            };
            await assert.rejects(client.trigger(`${configuration.url}job/test/`), errorCode('QUEUE_LOCATION_MISSING', 201));
        }
        assert.strictEqual(requests.length, 3);
    });

    test('bounds buffered responses both with and without Content-Length', async () => {
        const limited = new JenkinsClient(configuration, { token, maxResponseBytes: 32 });
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Length': 100 });
            response.end('x'.repeat(100));
        };
        await assert.rejects(limited.verify(), errorCode('RESPONSE_TOO_LARGE'));
        handler = (_request, response) => {
            response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
            response.write('x'.repeat(20));
            response.end('x'.repeat(20));
        };
        await assert.rejects(limited.verify(), errorCode('RESPONSE_TOO_LARGE'));
    });

    test('times out hanging requests and rejects malformed response data', async () => {
        handler = () => { /* Hold the fixture connection until the client deadline. */ };
        await assert.rejects(new JenkinsClient(configuration, { token, timeoutMs: 30 }).verify(), errorCode('TIMEOUT'));
        handler = (_request, response) => { response.end(`not JSON ${token}`); };
        await assert.rejects(client.verify(), errorCode('INVALID_RESPONSE'));
        handler = (_request, response) => json(response, { url: `${configuration.url}job/test/1/`, number: 1 });
        await assert.rejects(client.getBuild(`${configuration.url}job/test/1/`), errorCode('INVALID_RESPONSE'));
        handler = (_request, response) => { response.end('log without a byte cursor'); };
        await assert.rejects(client.getLog(`${configuration.url}job/test/1/`), errorCode('INVALID_RESPONSE'));
    });

    test('cancels active requests and never starts a request with an aborted signal', async () => {
        const controller = new AbortController();
        const cancellable = new JenkinsClient(configuration, { token, signal: controller.signal });
        handler = () => { /* Abort after the server has observed the connection. */ };
        const received = once(server, 'request');
        const pending = cancellable.verify();
        const rejected = assert.rejects(pending, errorCode('CANCELLED'));
        await received;
        controller.abort();
        await rejected;
        const count = requests.length;
        await assert.rejects(cancellable.verify(), errorCode('CANCELLED'));
        assert.strictEqual(requests.length, count);
    });

    test('rejects invalid credentials, client limits and missing CA files without leaking values', async () => {
        assert.throws(() => new JenkinsClient({ ...configuration, username: 'bad:name' }, { token }), errorCode('INVALID_CREDENTIALS'));
        assert.throws(() => new JenkinsClient(configuration, { token, timeoutMs: 0 }), errorCode('INVALID_OPTIONS'));
        await assert.rejects(new JenkinsClient({ ...configuration, caFile: `/missing/${token}.pem` }, { token }).verify(), errorCode('INVALID_CA'));
        assert.strictEqual(requests.length, 0);
    });
    test('isolates an offline server with backoff, honors Retry-After, and recovers after cooldown', async () => {
        let now = 1000;
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const guarded = new JenkinsClient(configuration, { token, guard });
        handler = (_request, response) => { response.writeHead(429, { 'Retry-After': '120' }); response.end(); };
        await assert.rejects(guarded.verify(), errorCode('HTTP_ERROR', 429));
        await assert.rejects(guarded.verify(), errorCode('BACKOFF'));
        assert.strictEqual(requests.length, 1);
        let otherServerVisited = false;
        await guard.run('other-controller', new AbortController().signal, async () => { otherServerVisited = true; });
        assert.strictEqual(otherServerVisited, true);
        now += 119999;
        await assert.rejects(guarded.verify(), errorCode('BACKOFF'));
        now++;
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        assert.strictEqual((await guarded.verify()).authenticated, true);
        assert.strictEqual(requests.length, 2);
    });

    test('a deadline closes a trickling response, applies backoff and leaves the event loop responsive', async () => {
        const guard = new JenkinsTransportGuard();
        const guarded = new JenkinsClient(configuration, { token, guard, timeoutMs: 60 });
        handler = (_request, response) => {
            response.writeHead(200); response.write('{');
            const timer = setInterval(() => response.write(' '), 5);
            response.on('close', () => clearInterval(timer));
        };
        let heartbeats = 0;
        const timer = setInterval(() => heartbeats++, 5);
        try {
            await assert.rejects(guarded.verify(), errorCode('TIMEOUT'));
            assert.ok(heartbeats >= 2, 'The extension host must keep scheduling work while the server hangs.');
            await assert.rejects(guarded.verify(), errorCode('BACKOFF'));
            assert.strictEqual(requests.length, 1);
        } finally { clearInterval(timer); }
    });

    test('resets and malformed nested payloads become typed failures instead of escaping into tree rendering', async () => {
        handler = request => request.socket.destroy();
        await assert.rejects(client.verify(), errorCode('NETWORK_ERROR'));
        const url = `${configuration.url}job/fw/1/`;
        const baseline = { url, number: 1, building: false, result: 'SUCCESS' };
        for (const extra of [{ actions: {} }, { actions: [null] }, { actions: [{ causes: {} }] },
            { actions: [{ remoteUrls: [null] }] }, { artifacts: [{}] }, { fullDisplayName: {} }]) {
            handler = (_request, response) => json(response, { ...baseline, ...extra });
            await assert.rejects(client.getBuild(url), errorCode('INVALID_RESPONSE'));
        }
        for (const suites of [{}, [null], [{ cases: {} }], [{ cases: [null] }], [{ cases: [{ name: 'case', status: {} }] }]]) {
            handler = (_request, response) => json(response, { passCount: 0, failCount: 1, skipCount: 0, suites });
            await assert.rejects(client.getTestReport(url), errorCode('INVALID_RESPONSE'));
        }
    });

    test('bounds retained test details without losing failure counts', async () => {
        handler = (_request, response) => json(response, { passCount: 0, failCount: 100, skipCount: 0,
            suites: [{ cases: Array.from({ length: 100 }, (_, i) => ({ name: `case-${i}`, status: 'FAILED', errorDetails: 'private stack' })) }] });
        const report = await client.getTestReport(`${configuration.url}job/fw/1/`);
        assert.strictEqual(report?.failCount, 100);
        assert.strictEqual(report?.suites?.[0].cases?.length, 50);
        assert.strictEqual(report?.detailsTruncated, true);
        assert.ok(!JSON.stringify(report).includes('private stack'));
    });

    test('bounds concurrent sockets per server and cancels every queued operation before it connects', async () => {
        const guard = new JenkinsTransportGuard();
        const abort = new AbortController();
        const guarded = new JenkinsClient(configuration, { token, guard, signal: abort.signal });
        handler = () => { /* Two connections are held while the rest wait in the local queue. */ };
        const ready = new Promise<void>(resolve => {
            const listener = (): void => { if (requests.length === 2) { server.off('request', listener); resolve(); } };
            server.on('request', listener);
        });
        const results = Promise.allSettled(Array.from({ length: 40 }, () => guarded.verify()));
        await ready;
        assert.strictEqual(requests.length, 2);
        abort.abort();
        const settled = await results;
        assert.ok(settled.every(result => result.status === 'rejected'));
        assert.ok(settled.some(result => result.status === 'rejected' && result.reason.code === 'BUSY'));
        assert.strictEqual(requests.length, 2);
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        assert.strictEqual((await new JenkinsClient(configuration, { token, guard }).verify()).authenticated, true);
    });

    test('an ambiguous failed POST is never retried during server recovery', async () => {
        let now = 0;
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const guarded = new JenkinsClient(configuration, { token, guard });
        handler = request => request.socket.destroy();
        await assert.rejects(guarded.trigger(`${configuration.url}job/fw/`, { SHA: 'a'.repeat(40) }), errorCode('NETWORK_ERROR'));
        now = 60000;
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        await guarded.verify();
        assert.strictEqual(requests.filter(request => request.method === 'POST').length, 1);
    });

    test('self-signed TLS is rejected by default and only a configured valid CA enables that connection', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'taskhub-jenkins-tls-'));
        const tlsSockets = new Set<{ destroy(): void }>();
        let secure: https.Server | undefined;
        try {
            const certificate = join(fixture, 'localhost-cert.pem');
            const identity = createLocalhostTlsFixture();
            await writeFile(certificate, identity.cert);
            let received = 0;
            secure = https.createServer(identity, (_request, response) => {
                received++; json(response, { authenticated: true, name: 'developer' });
            });
            secure.on('connection', socket => { tlsSockets.add(socket); socket.on('close', () => tlsSockets.delete(socket)); });
            secure.listen(0, '127.0.0.1');
            await once(secure, 'listening');
            const address = secure.address();
            assert.ok(address && typeof address !== 'string');
            const profile = { ...configuration, url: `https://127.0.0.1:${address.port}/jenkins/` };
            await assert.rejects(new JenkinsClient(profile, { token }).verify(), errorCode('NETWORK_ERROR'));
            assert.strictEqual(received, 0);
            assert.strictEqual((await new JenkinsClient({ ...profile, caFile: certificate }, { token }).verify()).authenticated, true);
            await assert.rejects(new JenkinsClient({ ...profile, caFile: join(__dirname, '../../package.json') }, { token }).verify(), errorCode('INVALID_CA'));
            assert.strictEqual(received, 1, 'Invalid CA data must never fall back to an unverified TLS connection.');
        } finally {
            for (const socket of tlsSockets) { socket.destroy(); }
            try { if (secure?.listening) { await new Promise<void>(resolve => secure!.close(() => resolve())); } }
            finally { await rm(fixture, { recursive: true, force: true }); }
        }
    });

    test('invalid Retry-After cannot disable backoff and shared request budgets stop extra HTTP work', async () => {
        const guard = new JenkinsTransportGuard(() => 0, () => 0);
        handler = (_request, response) => { response.writeHead(503, { 'Retry-After': 'not-a-date' }); response.end(); };
        const guarded = new JenkinsClient(configuration, { token, guard });
        await assert.rejects(guarded.verify(), errorCode('HTTP_ERROR', 503));
        await assert.rejects(guarded.verify(), errorCode('BACKOFF'));
        assert.strictEqual(requests.length, 1);
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        const budget = { remaining: 1 };
        await new JenkinsClient(configuration, { token, budget }).verify();
        await assert.rejects(new JenkinsClient(configuration, { token, budget }).verify(), errorCode('REQUEST_LIMIT'));
        assert.strictEqual(requests.length, 2);
    });

    test('rejects a proxy or restarted server returning a different job or build identity', async () => {
        const requested = `${configuration.url}job/firmware/`;
        const other = `${configuration.url}job/other/1/`;
        handler = (_request, response) => json(response, { url: other, number: 1, building: false, result: 'SUCCESS' });
        await assert.rejects(client.getBuild(`${requested}1/`), errorCode('INVALID_RESPONSE'));
        handler = (_request, response) => json(response, { builds: [{ url: other, number: 1, building: false, result: 'SUCCESS' }] });
        await assert.rejects(client.listRecentBuilds(requested), errorCode('INVALID_RESPONSE'));
    });


    test('completed 3 MiB logs return bounded prefixes for content-length and chunked responses without guard backoff', async () => {
        const payload = Buffer.from('가'.repeat(1024 * 1024));
        const guard = new JenkinsTransportGuard();
        const guarded = new JenkinsClient(configuration, { token, guard });
        for (const chunked of [false, true]) {
            handler = (request, response) => {
                if (request.url?.includes('whoAmI')) { json(response, { authenticated: true, name: 'developer' }); return; }
                response.setHeader('x-text-size', payload.length);
                response.setHeader('x-more-data', 'false');
                if (!chunked) { response.setHeader('content-length', payload.length); }
                response.write(payload.subarray(0, 1024 * 1024));
                response.end(payload.subarray(1024 * 1024));
            };
            const log = await guarded.getLog(`${configuration.url}job/test/1/`);
            assert.strictEqual(log.truncated, true);
            assert.strictEqual(log.more, true);
            assert.strictEqual(log.nextStart, 0, 'A prefix must not skip unread bytes using the remote end offset.');
            assert.strictEqual(log.text, '가'.repeat(Math.floor(2 * 1024 * 1024 / 3)));
            assert.ok(Buffer.byteLength(log.text) <= 2 * 1024 * 1024);
            await guarded.verify();
        }
    });

    test('a bounded log prefix closes a still-streaming response without waiting for its end', async () => {
        let closed!: Promise<void>;
        handler = (_request, response) => {
            closed = new Promise(resolve => response.once('close', resolve));
            response.setHeader('x-text-size', 3 * 1024 * 1024);
            response.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
            // Deliberately never end: the client must terminate this socket at its prefix cap.
        };
        const log = await client.getLog(`${configuration.url}job/test/1/`);
        await closed;
        assert.strictEqual(log.text.length, 2 * 1024 * 1024);
        assert.strictEqual(log.truncated, true);
    });

    test('log prefix mode retains cancellation, invalid-header, and strict JSON size checks', async () => {
        handler = (_request, response) => { response.setHeader('x-text-size', 'invalid'); response.end('small log'); };
        await assert.rejects(client.getLog(`${configuration.url}job/test/1/`), errorCode('INVALID_RESPONSE'));
        const abort = new AbortController();
        const pendingClient = new JenkinsClient(configuration, { token, signal: abort.signal });
        handler = (_request, response) => {
            response.setHeader('x-text-size', 100);
            response.write('partial');
            abort.abort();
        };
        await assert.rejects(pendingClient.getLog(`${configuration.url}job/test/1/`), errorCode('CANCELLED'));
        handler = (_request, response) => response.end(Buffer.alloc(3 * 1024 * 1024));
        await assert.rejects(client.verify(), errorCode('RESPONSE_TOO_LARGE'));
    });


    test('401 on distinct URLs suppresses server authentication retries and credential reset permits immediate recovery', async () => {
        let now = 1000;
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const guarded = new JenkinsClient(configuration, { token, guard });
        handler = (_request, response) => json(response, { private: token }, 401);
        for (let index = 0; index < 5; index++) {
            await assert.rejects(guarded.getBuild(`${configuration.url}job/build${index}/1/`), errorCode('AUTH_REQUIRED', 401));
        }
        assert.strictEqual(requests.length, 1);
        now += 59999;
        await assert.rejects(guarded.verify(), errorCode('AUTH_REQUIRED', 401));
        assert.strictEqual(requests.length, 1);
        now += 2;
        await assert.rejects(guarded.verify(), errorCode('AUTH_REQUIRED', 401));
        assert.strictEqual(requests.length, 2);
        guard.reset(configuration.url);
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        await guarded.verify();
        assert.strictEqual(requests.length, 3);
    });

    test('more than 256 denied HTTP report resources retain cooldown without blocking verification', async function () {
        this.timeout(15000);
        const guard = new JenkinsTransportGuard();
        const guarded = new JenkinsClient(configuration, { token, guard });
        handler = (_request, response) => json(response, {}, 403);
        for (let round = 0; round < 2; round++) {
            for (let index = 0; index < 300; index++) {
                await assert.rejects(guarded.getStages(`${configuration.url}job/build${index}/1/`), errorCode('FORBIDDEN', 403));
            }
            assert.strictEqual(requests.length, 300);
        }
        handler = (_request, response) => json(response, { authenticated: true, name: 'developer' });
        await guarded.verify();
        assert.strictEqual(requests.length, 301);
    });

    test('permission cache capacity never evicts a live denial; overflow pauses explicitly and expires or resets', async function () {
        this.timeout(15000);
        let now = 1000;
        let calls = 0;
        const guard = new JenkinsTransportGuard(() => now, () => 0);
        const signal = new AbortController().signal;
        const denied = async () => { calls++; throw new JenkinsClientError('FORBIDDEN', 403); };
        for (let index = 0; index <= jenkinsClientLimits.maxPermissionEntries; index++) {
            await assert.rejects(guard.run('ci', signal, denied, `report-${index}`), errorCode('FORBIDDEN', 403));
        }
        const filled = calls;
        await assert.rejects(guard.run('ci', signal, denied, 'report-0'), errorCode('FORBIDDEN', 403));
        await assert.rejects(guard.run('ci', signal, denied, 'new-report'), errorCode('PERMISSION_LIMIT'));
        assert.strictEqual(calls, filled, 'Neither an evicted old URL nor an overflow URL may retry immediately.');
        assert.strictEqual(await guard.run('other-ci', signal, async () => true), true);
        now += 60001;
        await assert.rejects(guard.run('ci', signal, denied, 'new-report'), errorCode('FORBIDDEN', 403));
        assert.strictEqual(calls, filled + 1);
        guard.reset('ci');
        assert.strictEqual(await guard.run('ci', signal, async () => true, 'new-report'), true);
    });


    test('late authentication failures from old credentials cannot reinstate a reset server backoff', async () => {
        const guard = new JenkinsTransportGuard();
        const signal = new AbortController().signal;
        let rejectOld!: (error: Error) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const old = guard.run('ci', signal, () => { started(); return new Promise<void>((_resolve, reject) => { rejectOld = reject; }); });
        const rejected = assert.rejects(old, errorCode('AUTH_REQUIRED', 401));
        await ready;
        guard.reset('ci');
        rejectOld(new JenkinsClientError('AUTH_REQUIRED', 401));
        await rejected;
        assert.strictEqual(await guard.run('ci', signal, async () => true), true);
    });


    test('network failures after authentication cooldown replace the authentication classification', async () => {
        for (const code of ['NETWORK_ERROR', 'TIMEOUT']) {
            let now = 1000;
            const guard = new JenkinsTransportGuard(() => now, () => 0);
            const guarded = new JenkinsClient(configuration, { token, guard, timeoutMs: 100 });
            handler = (_request, response) => json(response, {}, 401);
            await assert.rejects(guarded.verify(), errorCode('AUTH_REQUIRED', 401));
            now += 60001;
            handler = request => { if (code === 'NETWORK_ERROR') { request.socket.destroy(); } };
            await assert.rejects(guarded.verify(), errorCode(code));
            const count = requests.length;
            await assert.rejects(guarded.verify(), errorCode('BACKOFF'));
            assert.strictEqual(requests.length, count, 'Changing the displayed cause must retain retry suppression.');
        }
    });

});
