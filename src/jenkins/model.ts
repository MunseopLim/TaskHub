import { randomUUID } from 'crypto';
import { JenkinsClientError } from './client';
import {
    JenkinsBuild, JenkinsCause, JenkinsRequest, JenkinsServer, TrackedJenkinsBuild,
} from './types';

export type JenkinsRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'aborted'
    | 'skipped' | 'unknown' | 'unreachable' | 'sha_mismatch';

export interface JenkinsAggregate {
    phase: 'active' | 'discovering' | 'complete';
    observedResult: 'passed' | 'failed' | 'nonpass' | 'unknown';
    allPassed: boolean;
    counts: Record<JenkinsRunStatus, number> & { total: number };
    shaMismatches: TrackedJenkinsBuild[];
    rootStatus?: JenkinsRunStatus;
}

export interface CreateJenkinsRequest {
    id?: string;
    createdAt?: number;
    branch: string;
    remoteBranch?: string;
    sha: string;
    repoPath: string;
    repoRemote?: string;
    root: JenkinsRequest['root'];
    requestIdParameter?: string;
    shaParameter?: string;
}

export interface JenkinsDiscoveryOptions {
    servers: JenkinsServer[];
    requestIdParameters?: string[];
}

export function createRequest(input: CreateJenkinsRequest): JenkinsRequest {
    return {
        id: input.id ?? randomUUID(),
        createdAt: input.createdAt ?? Date.now(),
        branch: input.branch,
        remoteBranch: input.remoteBranch,
        sha: input.sha,
        repoPath: input.repoPath,
        repoRemote: input.repoRemote,
        root: { ...input.root },
        runs: [],
        discovery: { complete: false },
        requestIdParameter: input.requestIdParameter,
        shaParameter: input.shaParameter,
        notified: {},
    };
}

function canonicalUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
            return undefined;
        }
        url.search = '';
        url.hash = '';
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
        return url.href;
    } catch {
        return undefined;
    }
}

/** Server identity remains explicit, even when two configured servers have similar paths. */
export function buildKey(serverId: string, buildUrl: string): string {
    return JSON.stringify([serverId, canonicalUrl(buildUrl) ?? buildUrl]);
}

function hasShaMismatch(run: TrackedJenkinsBuild, expectedSha?: string): boolean {
    return Boolean(expectedSha?.trim() && run.actualSha?.trim()
        && expectedSha.trim().toLowerCase() !== run.actualSha.trim().toLowerCase());
}

export function normalizeRunStatus(run: TrackedJenkinsBuild, expectedSha?: string): JenkinsRunStatus {
    if (run.error) {
        return 'unreachable';
    }
    if (run.building) {
        return 'running';
    }
    if (hasShaMismatch(run, expectedSha)) {
        return 'sha_mismatch';
    }
    if (run.tests && run.tests.failCount > 0) {
        return 'failed';
    }
    switch (run.result?.toUpperCase()) {
        case 'SUCCESS': return 'passed';
        case 'FAILURE':
        case 'UNSTABLE': return 'failed';
        case 'ABORTED': return 'aborted';
        case 'NOT_BUILT':
        case 'SKIPPED': return 'skipped';
        case 'QUEUED': return 'queued';
        case 'IN_PROGRESS':
        case 'RUNNING': return 'running';
        default: return 'unknown';
    }
}

function isRoot(request: JenkinsRequest, run: TrackedJenkinsBuild): boolean {
    return run.correlation === 'root' || Boolean(request.root.buildUrl
        && buildKey(run.serverId, run.url) === buildKey(request.root.serverId, request.root.buildUrl));
}

export function aggregate(request: JenkinsRequest): JenkinsAggregate {
    const unique = new Map(request.runs.map(run => [buildKey(run.serverId, run.url), run]));
    const runs = [...unique.values()];
    const roots = runs.filter(run => isRoot(request, run));
    const countedRuns = runs;
    const counts: JenkinsAggregate['counts'] = {
        total: countedRuns.length, queued: 0, running: 0, passed: 0, failed: 0,
        aborted: 0, skipped: 0, unknown: 0, unreachable: 0, sha_mismatch: 0,
    };
    for (const run of countedRuns) {
        counts[normalizeRunStatus(run, request.sha)]++;
    }

    const statuses = runs.map(run => normalizeRunStatus(run, request.sha));
    const shaMismatches = runs.filter(run => hasShaMismatch(run, request.sha));
    const hasActive = runs.some(run => run.building)
        || statuses.some(status => status === 'queued' || status === 'running')
        || (!request.root.buildUrl && roots.length === 0 && !request.error && !request.stopped);
    const phase = hasActive ? 'active' : request.discovery.complete ? 'complete' : 'discovering';
    let observedResult: JenkinsAggregate['observedResult'];
    if (statuses.includes('failed')) {
        observedResult = 'failed';
    } else if (shaMismatches.length > 0 || request.error || request.stopped
        || statuses.some(status => ['aborted', 'skipped', 'unreachable', 'sha_mismatch'].includes(status))) {
        observedResult = 'nonpass';
    } else if (roots.length === 0 || runs.some(run => run.reportErrors) || statuses.some(status => status !== 'passed')) {
        observedResult = 'unknown';
    } else {
        observedResult = 'passed';
    }

    return {
        phase,
        observedResult,
        allPassed: phase === 'complete' && observedResult === 'passed',
        counts,
        shaMismatches,
        rootStatus: roots.length > 0 ? normalizeRunStatus(roots[0], request.sha) : undefined,
    };
}

function upstreamBuildUrl(cause: JenkinsCause, server: JenkinsServer): string | undefined {
    if (!cause.upstreamUrl || !Number.isSafeInteger(cause.upstreamBuild)
        || (cause.upstreamBuild ?? 0) < 1) {
        return undefined;
    }
    const base = canonicalUrl(server.url);
    if (!base) {
        return undefined;
    }
    try {
        const baseUrl = new URL(base);
        const job = new URL(cause.upstreamUrl, base);
        if (job.origin !== baseUrl.origin || !job.pathname.startsWith(baseUrl.pathname)
            || job.search || job.hash || job.username || job.password) {
            return undefined;
        }
        const jobUrl = canonicalUrl(job.href);
        return jobUrl ? new URL(`${cause.upstreamBuild}/`, jobUrl).href : undefined;
    } catch {
        return undefined;
    }
}

/** Correlates evidence only: branch names, commit parameters and commit SHAs never identify a request. */
export function discoverMatchingBuilds(
    request: JenkinsRequest,
    candidates: TrackedJenkinsBuild[],
    options: JenkinsDiscoveryOptions,
): TrackedJenkinsBuild[] {
    const servers = new Map(options.servers.map(server => [server.id, server]));
    const known = new Map(request.runs.map(run => [buildKey(run.serverId, run.url), run.correlation]));
    if (request.root.buildUrl) {
        known.set(buildKey(request.root.serverId, request.root.buildUrl), 'root');
    }
    const parameterNames = new Set([
        ...(options.requestIdParameters ?? []), ...(request.requestIdParameter ? [request.requestIdParameter] : []),
    ].filter(name => name.length > 0));
    const pending = new Map(candidates.map(run => [buildKey(run.serverId, run.url), run]));
    const matches: TrackedJenkinsBuild[] = [];

    // Index edges once: newest-first chains must not repeatedly scan the whole inventory.
    const downstream = new Map<string, Set<string>>();
    const requestIdSeeds: string[] = [];
    let edges = 0;
    for (const [key, run] of pending) {
        const server = servers.get(run.serverId);
        if (!server || !canonicalUrl(run.url)) { pending.delete(key); continue; }
        for (const action of run.actions ?? []) {
            for (const cause of action.causes ?? []) {
                if (++edges > 10000) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
                const url = upstreamBuildUrl(cause, server);
                if (!url) { continue; }
                const parent = buildKey(run.serverId, url);
                if (!downstream.has(parent)) { downstream.set(parent, new Set()); }
                downstream.get(parent)!.add(key);
            }
            if (action.parameters?.some(parameter => parameterNames.has(parameter.name) && parameter.value === request.id)) {
                requestIdSeeds.push(key);
            }
        }
    }
    const queue = [...known.keys()];
    const append = (key: string, correlation: TrackedJenkinsBuild['correlation']): void => {
        const run = pending.get(key);
        if (!run) { return; }
        matches.push({ ...run, correlation }); pending.delete(key);
        if (!known.has(key)) { known.set(key, correlation); queue.push(key); }
    };
    for (const [key, correlation] of known) { append(key, correlation); }
    let position = 0;
    const visit = (): void => {
        while (position < queue.length) {
            for (const child of downstream.get(queue[position++]) ?? []) { append(child, 'upstream'); }
        }
    };
    visit();
    for (const key of requestIdSeeds) { append(key, 'requestId'); }
    visit();
    return matches;
}

function remoteKey(remote: string): string {
    const value = remote.trim();
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
    const normalized = scp && !value.includes('://') && !/^[A-Za-z]:[\\/]/.test(value)
        ? `ssh://${scp[1]}/${scp[2]}` : value;
    try {
        const url = new URL(normalized);
        return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`
            + url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    } catch {
        return value.replace(/\/+$/, '').replace(/\.git$/, '');
    }
}

/** Requested parameters are not proof of checkout; only an unambiguous SCM revision is returned. */
export function extractActualSha(build: JenkinsBuild, repoRemote?: string): string | undefined {
    const revisions = new Set<string>();
    const expectedRemote = repoRemote ? remoteKey(repoRemote) : undefined;
    for (const action of build.actions ?? []) {
        if (action._class && action._class !== 'hudson.plugins.git.util.BuildData') {
            continue;
        }
        if (expectedRemote && !action.remoteUrls?.some(remote => remoteKey(remote) === expectedRemote)) {
            continue;
        }
        const revision = action.lastBuiltRevision?.SHA1;
        if (typeof revision === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(revision)) {
            revisions.add(revision.toLowerCase());
        }
    }
    return revisions.size === 1 ? [...revisions][0] : undefined;
}
