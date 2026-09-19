import { JenkinsClient, JenkinsClientError, normalizeJenkinsServerUrl, scopedJenkinsUrl } from './client';
import { JenkinsInventory, JenkinsInventoryResult } from './inventory';
import { aggregate, buildKey, discoverMatchingBuilds, extractActualSha, normalizeRunStatus } from './model';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild, jenkinsLimits } from './types';

export interface TrackingOptions {
    signal?: AbortSignal;
    inventory?: JenkinsInventoryResult;
    reserveRuns?(count: number): boolean;
    servers: JenkinsServer[];
    client(server: JenkinsServer): Promise<JenkinsClient>;
    discover: boolean;
    recentBuildLimit: number;
    manifestArtifact: string;
}

export function serverForUrl(servers: JenkinsServer[], value: string): JenkinsServer | undefined {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash) { return undefined; }
        return servers.filter(server => {
            try { scopedJenkinsUrl(new URL(normalizeJenkinsServerUrl(server.url)), value); return true; }
            catch { return false; }
        }).sort((a, b) => b.url.length - a.url.length)[0];
    } catch { return undefined; }
}

export function safeJenkinsError(error: unknown): string {
    if (error instanceof JenkinsClientError) { return error.code; }
    if (error instanceof Error && /^JENKINS_(?:STORAGE_LIMIT|RUN_LIMIT|SERVER_LIMIT|NEW_DESTINATION_REQUIRES_TOKEN|PARAMETER_CHOICE)$/.test(error.message)) { return error.message; }
    return 'JENKINS_UNAVAILABLE';
}

export async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 4, signal?: AbortSignal): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
            if (signal?.aborted) { throw new JenkinsClientError('CANCELLED'); }
            const current = index++;
            results[current] = await fn(items[current]);
        }
    }));
    const failure = workers.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') { throw failure.reason; }
    return results;
}

function jobFromBuild(url: string): string {
    const parsed = new URL(url);
    if (!/\/\d+\/$/.test(parsed.pathname)) { throw new Error('JENKINS_INVALID_BUILD_URL'); }
    parsed.pathname = parsed.pathname.replace(/\d+\/$/, '');
    return parsed.href;
}

export interface JenkinsManifest { complete: boolean; runs: Array<{ buildUrl: string }>; }

export function parseJenkinsManifest(data: Buffer, request: JenkinsRequest, servers: JenkinsServer[]): JenkinsManifest {
    const manifest = JSON.parse(data.toString('utf8'));
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.complete !== 'boolean'
        || !Array.isArray(manifest.runs) || manifest.runs.length > 1000
        || (manifest.rootBuildUrl !== undefined && manifest.rootBuildUrl !== request.root.buildUrl)
        || (manifest.requestId !== undefined && manifest.requestId !== request.id)
        || (manifest.rootBuildUrl !== request.root.buildUrl && manifest.requestId !== request.id)) {
        throw new Error('JENKINS_INVALID_MANIFEST');
    }
    for (const run of manifest.runs) {
        if (!run || typeof run.buildUrl !== 'string' || !serverForUrl(servers, run.buildUrl)) {
            throw new Error('JENKINS_MANIFEST_UNKNOWN_SERVER');
        }
        jobFromBuild(run.buildUrl);
    }
    return { complete: manifest.complete, runs: manifest.runs.map((run: { buildUrl: string }) => ({ buildUrl: run.buildUrl })) };
}

/** Each tick is idempotent and GET-only. Triggering builds belongs to the explicit Run command. */
export async function pollJenkinsRequest(request: JenkinsRequest, options: TrackingOptions): Promise<void> {
    if (request.stopped || request.settledAt || request.submission === 'sending' || options.signal?.aborted) { return; }
    if (request.runs.length > jenkinsLimits.maxRunsPerRequest) { request.error = 'JENKINS_RUN_LIMIT'; request.stopped = true; return; }
    const rootServer = options.servers.find(server => server.id === request.root.serverId);
    if (!rootServer) { request.error = 'JENKINS_SERVER_REMOVED'; return; }
    const clients = new Map<string, Promise<JenkinsClient>>();
    const clientFor = (server: JenkinsServer): Promise<JenkinsClient> => {
        if (!clients.has(server.id)) { clients.set(server.id, options.client(server)); }
        return clients.get(server.id)!;
    };
    let rootClient: JenkinsClient;
    try { rootClient = await clientFor(rootServer); }
    catch (error) { request.error = safeJenkinsError(error); return; }

    if (!request.root.buildUrl) {
        if (!request.root.queueUrl) { return; } // An uncertain POST must never be automatically resubmitted.
        try {
            const queue = await rootClient.getQueue(request.root.queueUrl);
            request.queueReason = queue.why;
            if (queue.cancelled) { request.error = 'JENKINS_QUEUE_CANCELLED'; request.stopped = true; return; }
            if (queue.executable) {
                if (buildKey(rootServer.id, jobFromBuild(queue.executable.url)) !== buildKey(rootServer.id, request.root.jobUrl)) {
                    throw new JenkinsClientError('INVALID_RESPONSE');
                }
                request.root.buildUrl = queue.executable.url;
            }
            delete request.error;
        } catch (error) {
            // Queue items expire. Recover only by the exact queue ID in this job, never lastBuild.
            const id = /\/queue\/item\/(\d+)\/?$/.exec(request.root.queueUrl)?.[1];
            if (error instanceof JenkinsClientError && error.status === 404 && id) {
                try {
                    const builds = await rootClient.listRecentBuilds(request.root.jobUrl, options.recentBuildLimit);
                    const match = builds.find(build => build.queueId === Number(id));
                    if (match) { request.root.buildUrl = match.url; delete request.error; }
                    else { request.error = 'JENKINS_QUEUE_EXPIRED'; }
                } catch (fallbackError) { request.error = safeJenkinsError(fallbackError); }
            } else { request.error = safeJenkinsError(error); }
        }
        if (!request.root.buildUrl) { return; }
    }
    const rootKey = buildKey(rootServer.id, request.root.buildUrl);
    if (!request.runs.some(run => buildKey(run.serverId, run.url) === rootKey)) {
        if (options.reserveRuns && !options.reserveRuns(1)) { request.error = 'JENKINS_RUN_LIMIT'; request.stopped = true; return; }
        request.runs.push({ serverId: rootServer.id, jobUrl: request.root.jobUrl, url: request.root.buildUrl,
            number: Number(/\/(\d+)\/?$/.exec(request.root.buildUrl)?.[1] ?? 0), building: true, result: null, correlation: 'root' });
    }
    const refresh = async (run: TrackedJenkinsBuild): Promise<TrackedJenkinsBuild> => {
        if (options.signal?.aborted || request.stopped) { throw new JenkinsClientError('CANCELLED'); }
        if (run.correlation !== 'root' && !run.error && !run.reportErrors && !run.building && ['passed', 'failed', 'aborted', 'skipped', 'sha_mismatch'].includes(normalizeRunStatus(run, request.sha))
            && run.tests !== undefined && run.stages !== undefined) { return run; }
        const server = options.servers.find(item => item.id === run.serverId);
        if (!server) { return { ...run, error: 'JENKINS_SERVER_REMOVED' }; }
        try {
            const client = await clientFor(server);
            const build = await client.getBuild(run.url);
            const result: TrackedJenkinsBuild = { ...run, ...build, serverId: run.serverId, jobUrl: run.jobUrl,
                correlation: run.correlation, actualSha: extractActualSha(build, request.repoRemote), error: undefined,
                actions: undefined, artifacts: run.correlation === 'root' ? build.artifacts : undefined };
            const [stages, tests] = await Promise.allSettled([client.getStages(run.url), client.getTestReport(run.url)]);
            delete result.reportErrors;
            if (stages.status === 'fulfilled') { result.stages = stages.value; }
            else { delete result.stages; result.reportErrors = { stages: safeJenkinsError(stages.reason) }; }
            if (tests.status === 'fulfilled') { result.tests = tests.value; }
            else { delete result.tests; result.reportErrors = { ...result.reportErrors, tests: safeJenkinsError(tests.reason) }; }
            return result;
        } catch (error) { return { ...run, error: safeJenkinsError(error) }; }
    };
    await mapConcurrent(request.runs.map((run, index) => ({ run, index })), async ({ run, index }) => {
        request.runs[index] = await refresh(run);
    }, 4, options.signal);
    if (options.signal?.aborted || request.stopped) { throw new JenkinsClientError('CANCELLED'); }
    const root = request.runs.find(run => buildKey(run.serverId, run.url) === rootKey)!;
    request.error = root.error;
    if (root.error) { return; }

    const artifact = root.artifacts?.find(item => item.relativePath === options.manifestArtifact);
    if (artifact) {
        try {
            const manifest = parseJenkinsManifest(await rootClient.getArtifact(root.url, artifact.relativePath), request, options.servers);
            const existing = new Map(request.runs.map(run => [buildKey(run.serverId, run.url), run]));
            const added = manifest.runs.flatMap(entry => {
                const server = serverForUrl(options.servers, entry.buildUrl)!;
                const key = buildKey(server.id, entry.buildUrl);
                if (existing.has(key)) { return []; }
                const run: TrackedJenkinsBuild = { serverId: server.id, jobUrl: jobFromBuild(entry.buildUrl), url: entry.buildUrl,
                    number: Number(/\/(\d+)\/$/.exec(new URL(entry.buildUrl).pathname)?.[1]), building: true, result: null, correlation: 'manifest' };
                existing.set(key, run);
                return [run];
            });
            if (request.runs.length + added.length > jenkinsLimits.maxRunsPerRequest || (options.reserveRuns && !options.reserveRuns(added.length))) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
            const start = request.runs.length;
            request.runs.push(...added);
            await mapConcurrent(added.map((run, index) => ({ run, index })), async ({ run, index }) => {
                request.runs[start + index] = await refresh(run);
            }, 4, options.signal);
            if (options.signal?.aborted || request.stopped) { throw new JenkinsClientError('CANCELLED'); }
            request.discovery = { complete: manifest.complete && !root.building, checkedAt: Date.now(), message: 'manifest' };
        } catch {
            request.discovery = { complete: false, checkedAt: Date.now(), message: 'manifestInvalid' };
        }
    } else if (options.discover) {
        const inventory = options.inventory ?? await new JenkinsInventory().collect({
            servers: options.servers, requests: [request], client: clientFor,
            recentBuildLimit: options.recentBuildLimit, signal: options.signal,
        });
        let matches: TrackedJenkinsBuild[];
        try { matches = discoverMatchingBuilds(request, inventory.candidates, { servers: options.servers }); }
        catch (error) {
            if (error instanceof JenkinsClientError && error.code === 'DISCOVERY_LIMIT') {
                request.discovery = { complete: false, checkedAt: Date.now(), message: 'discoveryLimited' }; return;
            }
            throw error;
        }
        const existing = new Set(request.runs.map(run => buildKey(run.serverId, run.url)));
        const added = matches.filter(run => !existing.has(buildKey(run.serverId, run.url)));
        if (request.runs.length + added.length > jenkinsLimits.maxRunsPerRequest || (options.reserveRuns && !options.reserveRuns(added.length))) {
            request.discovery = { complete: false, message: 'discoveryPartial' };
            request.error = 'JENKINS_RUN_LIMIT'; request.stopped = true; return;
        }
        const start = request.runs.length;
        request.runs.push(...added);
        await mapConcurrent(added.map((run, index) => ({ run, index })), async ({ run, index }) => {
            request.runs[start + index] = await refresh(run);
        }, 4, options.signal);
        request.discovery = { complete: false, checkedAt: Date.now(), message: inventory.failures.length > 0 ? 'discoveryPartial' : inventory.limited ? 'discoveryLimited' : inventory.continuing ? 'discoveryInProgress' : 'discoveryBounded' };
    }
    if (options.signal?.aborted || request.stopped) { throw new JenkinsClientError('CANCELLED'); }
    const summary = aggregate(request);
    if (summary.phase === 'complete' && request.runs.length > 0 && request.runs.every(run =>
        !run.reportErrors && ['passed', 'failed', 'aborted', 'skipped', 'sha_mismatch'].includes(normalizeRunStatus(run, request.sha)))) {
        request.settledAt = Date.now();
    }
}
