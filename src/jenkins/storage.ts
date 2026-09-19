import type * as vscode from 'vscode';
import { createHash } from 'crypto';
import { JenkinsJobProfile, JenkinsRequest, JenkinsServer, TrackedJenkinsBuild, jenkinsLimits } from './types';
import { sanitizeJenkinsGitRemote } from './git';

export const JENKINS_SERVERS_KEY = 'taskhub.jenkins.servers.v1';
export const JENKINS_REQUESTS_KEY = 'taskhub.jenkins.requests.v1';
const PROFILES_KEY = 'taskhub.jenkins.jobs.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRun(value: unknown): value is TrackedJenkinsBuild {
    return isRecord(value) && ['serverId', 'jobUrl', 'url'].every(key => typeof value[key] === 'string')
        && Number.isSafeInteger(value.number) && (value.number as number) > 0 && typeof value.building === 'boolean'
        && (value.result === null || typeof value.result === 'string')
        && ['actualSha', 'error', 'correlation', 'fullDisplayName'].every(key => value[key] === undefined || typeof value[key] === 'string')
        && (value.reportErrors === undefined || (isRecord(value.reportErrors)
            && ['stages', 'tests'].every(key => (value.reportErrors as Record<string, unknown>)[key] === undefined || typeof (value.reportErrors as Record<string, unknown>)[key] === 'string')))
        && (value.tests === undefined || value.tests === null || (isRecord(value.tests)
            && ['passCount', 'failCount', 'skipCount'].every(key => Number.isSafeInteger((value.tests as Record<string, unknown>)[key]) && ((value.tests as Record<string, number>)[key]) >= 0)))
        && (value.stages === undefined || value.stages === null || (isRecord(value.stages)
            && (value.stages.stages === undefined || Array.isArray(value.stages.stages))));
}

function persistableRequest(request: JenkinsRequest): JenkinsRequest {
    return {
        id: request.id, createdAt: request.createdAt, branch: request.branch, remoteBranch: request.remoteBranch, sha: request.sha,
        repoPath: request.repoPath,
        repoRemote: typeof request.repoRemote === 'string' ? sanitizeJenkinsGitRemote(request.repoRemote) : undefined,
        root: {
            serverId: request.root.serverId, jobUrl: request.root.jobUrl,
            queueUrl: request.root.queueUrl, buildUrl: request.root.buildUrl,
        },
        discovery: {
            complete: request.discovery.complete, message: request.discovery.message,
            checkedAt: request.discovery.checkedAt,
        },
        requestIdParameter: request.requestIdParameter, shaParameter: request.shaParameter,
        submission: request.submission, queueReason: request.queueReason, error: request.error, stopped: request.stopped,
        settledAt: request.settledAt,
        notified: Object.fromEntries(Object.entries(request.notified).filter(([, value]) => typeof value === 'boolean')),
        runs: request.runs.map(run => ({
            serverId: run.serverId, jobUrl: run.jobUrl, url: run.url, number: run.number,
            fullDisplayName: run.fullDisplayName, building: run.building, result: run.result,
            timestamp: run.timestamp, duration: run.duration, queueId: run.queueId,
            correlation: run.correlation, actualSha: run.actualSha, error: run.error,
            reportErrors: run.reportErrors ? { stages: run.reportErrors.stages, tests: run.reportErrors.tests } : undefined,
            stages: run.stages ? {
                status: run.stages.status, detailsTruncated: run.stages.detailsTruncated,
                stages: Array.isArray(run.stages.stages) ? run.stages.stages.slice(0, 50)
                    .filter(stage => stage && typeof stage.id === 'string' && typeof stage.name === 'string'
                        && typeof stage.status === 'string')
                    .map(stage => ({ id: stage.id, name: stage.name, status: stage.status, durationMillis: stage.durationMillis })) : undefined,
            } : run.stages,
            tests: run.tests ? { ...(run.tests.detailsTruncated === undefined ? {} : { detailsTruncated: run.tests.detailsTruncated }), passCount: run.tests.passCount, failCount: run.tests.failCount, skipCount: run.tests.skipCount } : run.tests,
        })),
    };
}

function isProfile(value: unknown): value is JenkinsJobProfile {
    return isRecord(value) && typeof value.serverId === 'string' && typeof value.jobUrl === 'string';
}

export function jenkinsSecretKey(server: JenkinsServer): string {
    const identity = createHash('sha256').update(`${server.url}\n${server.username}`).digest('hex');
    return `taskhub.jenkins.token.${server.id}.${identity}`;
}

export class JenkinsStore {
    constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState' | 'secrets'>) {}

    servers(): JenkinsServer[] {
        const value = this.context.globalState.get<unknown>(JENKINS_SERVERS_KEY, []);
        if (!Array.isArray(value)) { return []; }
        return value.slice(0, jenkinsLimits.maxServers).filter((entry): entry is JenkinsServer => !!entry && typeof entry === 'object'
            && ['id', 'name', 'url', 'username'].every(key => typeof entry[key] === 'string'))
            .map(({ id, name, url, username, caFile, allowInsecureHttp }) => ({ id, name, url, username, ...(allowInsecureHttp === true ? { allowInsecureHttp: true } : {}), ...(typeof caFile === 'string' ? { caFile } : {}) }));
    }

    async saveServer(server: JenkinsServer, token?: string): Promise<void> {
        const existing = this.servers();
        const old = existing.find(item => item.id === server.id);
        if (!old && existing.length >= jenkinsLimits.maxServers) { throw new Error('JENKINS_SERVER_LIMIT'); }
        // Credentials are bound to URL and account, so editing a destination cannot send an old token elsewhere.
        if (old && jenkinsSecretKey(old) !== jenkinsSecretKey(server)) {
            if (!token) { throw new Error('JENKINS_NEW_DESTINATION_REQUIRES_TOKEN'); }
        }
        if (token !== undefined) { await this.context.secrets.store(jenkinsSecretKey(server), token); }
        const safe = { id: server.id, name: server.name, url: server.url, username: server.username, caFile: server.caFile, ...(server.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}) };
        await this.context.globalState.update(JENKINS_SERVERS_KEY, [...existing.filter(item => item.id !== server.id), safe]);
        if (old && jenkinsSecretKey(old) !== jenkinsSecretKey(server)) { await this.context.secrets.delete(jenkinsSecretKey(old)); }
    }

    async removeServer(id: string): Promise<void> {
        const server = this.servers().find(item => item.id === id);
        await this.context.globalState.update(JENKINS_SERVERS_KEY, this.servers().filter(item => item.id !== id));
        if (server) { await this.context.secrets.delete(jenkinsSecretKey(server)); }
    }

    token(server: JenkinsServer): Thenable<string | undefined> { return this.context.secrets.get(jenkinsSecretKey(server)); }

    requests(): JenkinsRequest[] {
        const value = this.context.workspaceState.get<unknown>(JENKINS_REQUESTS_KEY, []);
        if (!Array.isArray(value)) { return []; }
        const restored = value.slice(0, 520).filter((r): r is JenkinsRequest => isRecord(r) && typeof r.id === 'string' && typeof r.branch === 'string'
            && typeof r.sha === 'string' && typeof r.repoPath === 'string' && Number.isFinite(r.createdAt)
            && isRecord(r.root) && typeof r.root.serverId === 'string' && typeof r.root.jobUrl === 'string'
            && Array.isArray(r.runs) && r.runs.length <= jenkinsLimits.maxRunsPerRequest && r.runs.every(isRun) && isRecord(r.discovery)
            && typeof r.discovery.complete === 'boolean' && isRecord(r.notified)).map(persistableRequest);
        let runs = 0;
        let active = 0;
        for (const request of restored) {
            if (!request.root.queueUrl && !request.root.buildUrl
                && (request.submission === 'sending' || request.error === 'JENKINS_SUBMITTING')) {
                request.submission = 'unconfirmed'; request.stopped = true;
                request.error = 'JENKINS_SUBMISSION_UNCONFIRMED'; request.discovery.complete = false;
                delete request.settledAt;
            }
            if (!request.stopped && !request.settledAt) { active++; }
            if (active > jenkinsLimits.maxActiveRequests || runs + request.runs.length > jenkinsLimits.maxRetainedRuns) {
                request.runs = []; request.stopped = true; request.error = 'JENKINS_RESTORE_LIMIT';
                request.discovery.complete = false; delete request.settledAt;
            }
            runs += request.runs.length;
        }
        return restored;
    }

    async saveRequests(requests: JenkinsRequest[], historyLimit = 50): Promise<JenkinsRequest[]> {
        const limit = Number.isFinite(historyLimit) ? Math.max(0, Math.min(500, Math.floor(historyLimit))) : 50;
        const active = requests.filter(r => !r.stopped && r.settledAt === undefined);
        const history = requests.filter(r => r.stopped || r.settledAt !== undefined).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        // Network action/parameter payloads and logs may contain secrets. Only allowlisted display data is persisted.
        const safe = [...active, ...history].sort((a, b) => b.createdAt - a.createdAt).map(request => {
            if (request.runs.length > jenkinsLimits.maxRunsPerRequest) { throw new Error('JENKINS_STORAGE_LIMIT'); }
            return persistableRequest(request);
        });
        const size = (request: JenkinsRequest): number => Buffer.byteLength(JSON.stringify(request), 'utf8') + 1;
        const sizes = new Map(safe.map(request => [request, size(request)]));
        let bytes = 2 + [...sizes.values()].reduce((sum, value) => sum + value, 0);
        // Reclaim completed history first, then optional detail. Preserve active result evidence.
        for (let index = safe.length - 1; index >= 0 && bytes > jenkinsLimits.maxStoredBytes; index--) {
            const request = safe[index];
            if (request.stopped || request.settledAt) { bytes -= sizes.get(request)!; safe.splice(index, 1); }
        }
        for (const request of [...safe].reverse()) {
            if (bytes <= jenkinsLimits.maxStoredBytes) { break; }
            const before = sizes.get(request)!;
            delete request.queueReason;
            for (const run of request.runs) {
                delete run.fullDisplayName;
                if (run.stages?.stages?.length) { run.stages = { status: run.stages.status, stages: [], detailsTruncated: true }; }
            }
            const after = size(request); sizes.set(request, after); bytes += after - before;
        }
        // If even identity/result records cannot fit, stop explicitly rather than certify a
        // truncated set of children or leave every future persistence attempt broken.
        for (const request of [...safe].reverse()) {
            if (bytes <= jenkinsLimits.maxStoredBytes) { break; }
            const before = sizes.get(request)!;
            request.runs = []; request.stopped = true; delete request.settledAt;
            request.discovery = { complete: false }; request.error = 'JENKINS_STORAGE_LIMIT';
            bytes += size(request) - before;
        }
        if (bytes > jenkinsLimits.maxStoredBytes) { throw new Error('JENKINS_STORAGE_LIMIT'); }
        await this.context.workspaceState.update(JENKINS_REQUESTS_KEY, safe);
        return safe;
    }

    profile(serverId: string, jobUrl: string): JenkinsJobProfile | undefined {
        const profiles = this.context.workspaceState.get<JenkinsJobProfile[]>(PROFILES_KEY, []);
        return Array.isArray(profiles) ? profiles.filter(isProfile)
            .find(profile => profile.serverId === serverId && profile.jobUrl === jobUrl) : undefined;
    }

    async saveProfile(profile: JenkinsJobProfile): Promise<void> {
        const current = this.context.workspaceState.get<JenkinsJobProfile[]>(PROFILES_KEY, []);
        const profiles = Array.isArray(current) ? current.filter(isProfile) : [];
        const safe = {
            serverId: profile.serverId, jobUrl: profile.jobUrl, branchParameter: profile.branchParameter,
            shaParameter: profile.shaParameter, requestIdParameter: profile.requestIdParameter,
        };
        await this.context.workspaceState.update(PROFILES_KEY, [...profiles.filter(p => p.serverId !== profile.serverId || p.jobUrl !== profile.jobUrl), safe].slice(-100));
    }
}
