import * as assert from 'assert';
import {
    aggregate, buildKey, createRequest, discoverMatchingBuilds, extractActualSha, normalizeRunStatus,
} from '../jenkins/model';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild } from '../jenkins/types';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const servers: JenkinsServer[] = [
    { id: 'main', name: 'Main', url: 'https://ci.example/jenkins/', username: 'developer' },
    { id: 'lab', name: 'Lab', url: 'https://lab.example/', username: 'developer' },
];

function makeRun(overrides: Partial<TrackedJenkinsBuild> = {}): TrackedJenkinsBuild {
    return {
        serverId: 'main', jobUrl: 'https://ci.example/jenkins/job/firmware/',
        url: 'https://ci.example/jenkins/job/firmware/10/', number: 10,
        fullDisplayName: 'firmware #10', building: false, result: 'SUCCESS', ...overrides,
    };
}

function makeRequest(overrides: Partial<JenkinsRequest> = {}): JenkinsRequest {
    return {
        ...createRequest({
            id: 'request-a', createdAt: 1234, branch: 'feature/test', sha: SHA, repoPath: '/repo',
            root: {
                serverId: 'main', jobUrl: 'https://ci.example/jenkins/job/firmware/',
                buildUrl: 'https://ci.example/jenkins/job/firmware/10/',
            },
        }),
        ...overrides,
    };
}

function child(overrides: Partial<TrackedJenkinsBuild> = {}): TrackedJenkinsBuild {
    return makeRun({
        jobUrl: 'https://ci.example/jenkins/job/tests/', url: 'https://ci.example/jenkins/job/tests/42/',
        number: 42, fullDisplayName: 'tests #42',
        actions: [{ causes: [{ upstreamUrl: 'job/firmware/', upstreamBuild: 10 }] }],
        ...overrides,
    });
}

suite('Jenkins request model', () => {
    test('identical branch and SHA requests have independent identities and state', () => {
        const input = {
            branch: 'main', sha: SHA, repoPath: '/repo',
            root: { serverId: 'main', jobUrl: 'https://ci.example/job/firmware/' },
        };
        const first = createRequest(input);
        const second = createRequest(input);
        assert.notStrictEqual(first.id, second.id);
        assert.deepStrictEqual(first.discovery, { complete: false });
        first.runs.push(makeRun());
        first.root.queueUrl = 'https://ci.example/queue/item/1/';
        first.notified.completed = true;
        assert.deepStrictEqual(second.runs, []);
        assert.deepStrictEqual(second.notified, {});
        assert.strictEqual(second.root.queueUrl, undefined);
        assert.strictEqual(input.root.jobUrl, first.root.jobUrl);
    });

    test('build keys normalize URL spelling but preserve server and build identity', () => {
        assert.strictEqual(buildKey('main', 'https://CI.EXAMPLE:443/job/test/1?x=2#log'),
            buildKey('main', 'https://ci.example/job/test/1/'));
        assert.notStrictEqual(buildKey('main', 'https://ci.example/job/test/1/'),
            buildKey('lab', 'https://ci.example/job/test/1/'));
        assert.notStrictEqual(buildKey('main', 'https://ci.example/job/test/1/'),
            buildKey('main', 'https://ci.example/job/test/11/'));
    });

    test('preserves aborted, skipped, unstable, unavailable and unknown outcomes', () => {
        const outcomes = [
            ['SUCCESS', 'passed'], ['FAILURE', 'failed'], ['UNSTABLE', 'failed'],
            ['ABORTED', 'aborted'], ['NOT_BUILT', 'skipped'], ['unrecognized', 'unknown'],
        ] as const;
        for (const [result, expected] of outcomes) {
            assert.strictEqual(normalizeRunStatus(makeRun({ result })), expected);
        }
        assert.strictEqual(normalizeRunStatus(makeRun({ building: true, result: null })), 'running');
        assert.strictEqual(normalizeRunStatus(makeRun({ building: false, result: null })), 'unknown');
        assert.strictEqual(normalizeRunStatus(makeRun({ error: 'Timeout' })), 'unreachable');
    });

    test('actual checkout mismatch remains distinct from a Jenkins test failure', () => {
        assert.strictEqual(normalizeRunStatus(makeRun({ actualSha: OTHER_SHA }), SHA), 'sha_mismatch');
        assert.strictEqual(normalizeRunStatus(makeRun({ actualSha: SHA.toUpperCase() }), SHA), 'passed');
        assert.strictEqual(normalizeRunStatus(makeRun(), SHA), 'passed');
        assert.strictEqual(normalizeRunStatus(makeRun({ actualSha: SHA.slice(0, 7) }), SHA), 'sha_mismatch');
    });

    test('a known failure does not hide another running job or report completion', () => {
        const request = makeRequest({
            runs: [makeRun({ correlation: 'root', building: true, result: null }), child({ result: 'FAILURE' }),
                child({ url: 'https://ci.example/jenkins/job/tests/43/', number: 43, building: true, result: null })],
            discovery: { complete: true },
        });
        const summary = aggregate(request);
        assert.strictEqual(summary.phase, 'active');
        assert.strictEqual(summary.observedResult, 'failed');
        assert.strictEqual(summary.allPassed, false);
        assert.strictEqual(summary.counts.total, 3);
        assert.strictEqual(summary.counts.failed, 1);
        assert.strictEqual(summary.counts.running, 2);
        assert.strictEqual(summary.rootStatus, 'running');
    });

    test('all observed passes remain provisional while downstream discovery is incomplete', () => {
        const request = makeRequest({ runs: [makeRun({ correlation: 'root' }), child()] });
        const pending = aggregate(request);
        assert.strictEqual(pending.phase, 'discovering');
        assert.strictEqual(pending.observedResult, 'passed');
        assert.strictEqual(pending.allPassed, false);
        request.discovery.complete = true;
        const completed = aggregate(request);
        assert.strictEqual(completed.phase, 'complete');
        assert.strictEqual(completed.allPassed, true);
        assert.strictEqual(completed.counts.total, 2);
        assert.strictEqual(completed.counts.passed, 2);
    });

    test('a running or failed orchestrator cannot become overall success from passed children', () => {
        const request = makeRequest({
            runs: [makeRun({ correlation: 'root', building: true, result: null }), child()],
            discovery: { complete: true },
        });
        assert.strictEqual(aggregate(request).allPassed, false);
        assert.strictEqual(aggregate(request).phase, 'active');
        request.runs[0] = makeRun({ correlation: 'root', result: 'FAILURE' });
        assert.strictEqual(aggregate(request).observedResult, 'failed');
        assert.strictEqual(aggregate(request).allPassed, false);
        assert.strictEqual(aggregate(request).counts.passed, 1);
    });

    test('root-only jobs are counted once, and refreshed copies are not double counted', () => {
        const request = makeRequest({
            runs: [makeRun({ correlation: 'root', building: true, result: null }),
                makeRun({ correlation: 'root', url: 'https://ci.example/jenkins/job/firmware/10' })],
            discovery: { complete: true },
        });
        const summary = aggregate(request);
        assert.strictEqual(summary.counts.total, 1);
        assert.strictEqual(summary.counts.passed, 1);
        assert.strictEqual(summary.allPassed, true);
    });

    test('missing root evidence and empty requests never count as all passed', () => {
        assert.strictEqual(aggregate(makeRequest({ discovery: { complete: true } })).allPassed, false);
        assert.strictEqual(aggregate(makeRequest({
            runs: [child()], discovery: { complete: true },
        })).allPassed, false);
        const queued = createRequest({
            branch: 'main', sha: SHA, repoPath: '/repo',
            root: { serverId: 'main', jobUrl: 'https://ci.example/job/firmware/', queueUrl: 'https://ci.example/queue/item/1/' },
        });
        assert.strictEqual(aggregate(queued).phase, 'active');
        assert.strictEqual(aggregate(queued).allPassed, false);
    });

    test('aborted, skipped, unreachable and mismatched builds prevent overall success', () => {
        const cases: Partial<TrackedJenkinsBuild>[] = [
            { result: 'ABORTED' }, { result: 'NOT_BUILT' }, { error: 'Server unavailable' }, { actualSha: OTHER_SHA },
        ];
        for (const entry of cases) {
            const summary = aggregate(makeRequest({
                runs: [makeRun({ correlation: 'root' }), child(entry)], discovery: { complete: true },
            }));
            assert.strictEqual(summary.allPassed, false);
            assert.strictEqual(summary.observedResult, 'nonpass');
        }
    });

    test('running SHA mismatches preserve progress and report the mismatch immediately', () => {
        const summary = aggregate(makeRequest({
            runs: [makeRun({ correlation: 'root' }), child({ building: true, result: null, actualSha: OTHER_SHA })],
        }));
        assert.strictEqual(summary.phase, 'active');
        assert.strictEqual(summary.counts.running, 1);
        assert.strictEqual(summary.shaMismatches.length, 1);
        assert.strictEqual(summary.observedResult, 'nonpass');
    });

    test('published test failures prevent all-passed when the Pipeline catches failures and returns SUCCESS', () => {
        const failedTests = child({ result: 'SUCCESS', tests: { passCount: 5, failCount: 1, skipCount: 0 } });
        assert.strictEqual(normalizeRunStatus(failedTests), 'failed');
        const summary = aggregate(makeRequest({
            runs: [makeRun({ correlation: 'root' }), failedTests], discovery: { complete: true },
        }));
        assert.strictEqual(summary.counts.failed, 1);
        assert.strictEqual(summary.observedResult, 'failed');
        assert.strictEqual(summary.allPassed, false);
        assert.strictEqual(summary.rootStatus, 'passed');
        assert.strictEqual(normalizeRunStatus({ ...failedTests, building: true, result: null }), 'running');
    });
});

suite('Jenkins downstream correlation', () => {
    test('links the exact upstream build in a Jenkins context path', () => {
        const request = makeRequest();
        const candidate = child();
        const matches = discoverMatchingBuilds(request, [candidate], { servers });
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].correlation, 'upstream');
        assert.strictEqual(candidate.correlation, undefined);
        assert.deepStrictEqual(request.runs, []);
    });

    test('same branch or SHA and a different upstream build never merge requests', () => {
        const request = makeRequest();
        const unrelated = child({
            actualSha: SHA,
            actions: [{
                causes: [{ upstreamUrl: 'job/firmware/', upstreamBuild: 11 }],
                parameters: [{ name: 'BRANCH', value: request.branch }, { name: 'GIT_COMMIT', value: SHA }],
            }],
        });
        assert.deepStrictEqual(discoverMatchingBuilds(request, [unrelated], { servers }), []);
        assert.deepStrictEqual(discoverMatchingBuilds(request, [child({ actions: [], actualSha: SHA })], { servers }), []);
    });

    test('follows multi-level descendants even when grandchildren are listed first', () => {
        const grandchild = child({
            jobUrl: 'https://ci.example/jenkins/job/device/', url: 'https://ci.example/jenkins/job/device/2/', number: 2,
            actions: [{ causes: [{ upstreamUrl: 'job/tests/', upstreamBuild: 42 }] }],
        });
        const matches = discoverMatchingBuilds(makeRequest(), [grandchild, child()], { servers });
        assert.deepStrictEqual(matches.map(run => run.number), [42, 2]);
        assert.ok(matches.every(run => run.correlation === 'upstream'));
    });

    test('walks a 2000-build newest-first chain once and rejects excessive relationship graphs', function () {
        this.timeout(10000);
        const chain = Array.from({ length: 2000 }, (_, index) => child({
            url: `https://ci.example/jenkins/job/chain/${index + 1}/`, number: index + 1,
            actions: [{ causes: [{ upstreamUrl: index === 0 ? 'job/firmware/' : 'job/chain/', upstreamBuild: index === 0 ? 10 : index }] }],
        })).reverse();
        const matches = discoverMatchingBuilds(makeRequest(), chain, { servers });
        assert.strictEqual(matches.length, 2000);
        assert.strictEqual(matches[0].number, 1);
        assert.strictEqual(matches[1999].number, 2000);
        const excessive = child({ actions: [{ causes: Array.from({ length: 10001 }, () => ({ upstreamUrl: 'job/firmware/', upstreamBuild: 10 })) }] });
        assert.throws(() => discoverMatchingBuilds(makeRequest(), [excessive], { servers }), { code: 'DISCOVERY_LIMIT' });
    });

    test('same job path and number on another server are not upstream proof', () => {
        const otherServer = { ...servers[0], id: 'replica' };
        assert.deepStrictEqual(discoverMatchingBuilds(makeRequest(), [child({ serverId: 'replica' })], {
            servers: [...servers, otherServer],
        }), []);
        const foreignCause = child({
            serverId: 'lab', jobUrl: 'https://lab.example/job/tests/', url: 'https://lab.example/job/tests/1/',
            actions: [{ causes: [{ upstreamUrl: 'https://ci.example/jenkins/job/firmware/', upstreamBuild: 10 }] }],
        });
        assert.deepStrictEqual(discoverMatchingBuilds(makeRequest(), [foreignCause], { servers }), []);
    });

    test('cross-server request ID needs an explicitly configured exact parameter', () => {
        const request = makeRequest();
        const candidate = child({
            serverId: 'lab', url: 'https://lab.example/job/tests/42/', jobUrl: 'https://lab.example/job/tests/',
            actions: [{ parameters: [{ name: 'TASKHUB_REQUEST_ID', value: request.id }] }],
        });
        assert.deepStrictEqual(discoverMatchingBuilds(request, [candidate], { servers }), []);
        const options = { servers, requestIdParameters: ['TASKHUB_REQUEST_ID'] };
        assert.strictEqual(discoverMatchingBuilds(request, [candidate], options)[0].correlation, 'requestId');
        const repeatedRequest = makeRequest({ id: 'request-b' });
        assert.deepStrictEqual(discoverMatchingBuilds(repeatedRequest, [candidate], options), []);
        assert.strictEqual(discoverMatchingBuilds({ ...request, requestIdParameter: 'TASKHUB_REQUEST_ID' },
            [candidate], { servers }).length, 1);
    });

    test('request ID matching is exact and does not accept unknown servers', () => {
        const request = makeRequest({ requestIdParameter: 'REQUEST_ID' });
        const candidate = child({ actions: [{ parameters: [{ name: 'REQUEST_ID', value: 'request-a-suffix' }] }] });
        assert.deepStrictEqual(discoverMatchingBuilds(request, [candidate], { servers }), []);
        candidate.actions = [{ parameters: [{ name: 'REQUEST_ID', value: request.id }] }];
        candidate.serverId = 'unconfigured';
        assert.deepStrictEqual(discoverMatchingBuilds(request, [candidate], { servers }), []);
    });

    test('refreshes known builds without erasing their correlation and deduplicates snapshots', () => {
        const known = child({ correlation: 'upstream', building: true, result: null });
        const request = makeRequest({ runs: [known] });
        const refreshed = child({ actions: [], result: 'SUCCESS' });
        const matches = discoverMatchingBuilds(request, [known, refreshed, makeRun()], { servers });
        assert.strictEqual(matches.length, 2);
        assert.strictEqual(matches[0].result, 'SUCCESS');
        assert.strictEqual(matches[0].correlation, 'upstream');
        assert.strictEqual(matches[1].correlation, 'root');
    });

    test('rejects malformed causes, partial job names and paths outside the configured Jenkins context', () => {
        const causes = [
            { upstreamUrl: 'job/firmware/', upstreamBuild: -1 },
            { upstreamUrl: 'job/firmware/', upstreamBuild: 10.5 },
            { upstreamUrl: 'job/firmware-copy/', upstreamBuild: 10 },
            { upstreamUrl: '../job/firmware/', upstreamBuild: 10 },
            { upstreamUrl: '//elsewhere.example/jenkins/job/firmware/', upstreamBuild: 10 },
        ];
        for (const cause of causes) {
            assert.deepStrictEqual(discoverMatchingBuilds(makeRequest(), [child({ actions: [{ causes: [cause] }] })],
                { servers }), []);
        }
    });
});

suite('Jenkins actual checkout revision', () => {
    test('reads SCM checkout data and does not infer checkout from a requested parameter', () => {
        assert.strictEqual(extractActualSha(makeRun({
            actions: [{ parameters: [{ name: 'GIT_COMMIT', value: SHA }] }],
        })), undefined);
        assert.strictEqual(extractActualSha(makeRun({ actions: [{
            _class: 'hudson.plugins.git.util.BuildData', lastBuiltRevision: { SHA1: SHA.toUpperCase() },
        }] })), SHA);
    });

    test('multiple different repository revisions are ambiguous unless the intended remote matches', () => {
        const build = makeRun({ actions: [
            { lastBuiltRevision: { SHA1: SHA }, remoteUrls: ['git@github.example:firmware/controller.git'] },
            { lastBuiltRevision: { SHA1: OTHER_SHA }, remoteUrls: ['https://github.example/firmware/tools.git'] },
        ] });
        assert.strictEqual(extractActualSha(build), undefined);
        assert.strictEqual(extractActualSha(build, 'https://github.example/firmware/controller'), SHA);
        assert.strictEqual(extractActualSha(build, 'ssh://git@github.example/firmware/tools.git'), OTHER_SHA);
        assert.strictEqual(extractActualSha(build, 'https://github.example/firmware/missing.git'), undefined);
    });

    test('duplicate SCM records for the same revision are unambiguous but invalid revision values are ignored', () => {
        assert.strictEqual(extractActualSha(makeRun({ actions: [
            { lastBuiltRevision: { SHA1: SHA } }, { lastBuiltRevision: { SHA1: SHA.toUpperCase() } },
        ] })), SHA);
        assert.strictEqual(extractActualSha(makeRun({ actions: [
            { lastBuiltRevision: { SHA1: 'not-a-commit' } },
            { _class: 'example.ParametersAction', lastBuiltRevision: { SHA1: SHA } },
        ] })), undefined);
    });
});
