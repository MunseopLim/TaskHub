import { JenkinsClient, JenkinsClientError, jenkinsClientLimits } from './client';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild, jenkinsLimits } from './types';

export interface JenkinsInventoryResult {
    candidates: TrackedJenkinsBuild[];
    continuing: boolean;
    limited: boolean;
    failures: string[];
}
interface Folder { url: string; parent: string; depth: number; }
const maxCursorBytes = 8 * 1024 * 1024;
// Charge only newly retained entries, including a conservative per-entry overhead.
function entryBytes(value: string | Folder): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') + 32; }
interface Cursor {
    identity: string; jobs: string[]; next: number;
    folders: Folder[]; queued: Set<string>; visited: Set<string>; jobCount: number; bytes: number;
}
interface InventoryOptions {
    servers: JenkinsServer[];
    requests: JenkinsRequest[];
    client(server: JenkinsServer): Promise<JenkinsClient>;
    recentBuildLimit: number;
    signal?: AbortSignal;
    maxOperations?: number;
    jobLimit?: number;
}

/** A controller-owned scan cursor; candidates are shared only for one polling round. */
export class JenkinsInventory {
    private readonly cursors = new Map<string, Cursor>();
    private readonly limited = new Map<string, string>();
    private cursorBytes = 0;
    private generation = 0;
    private rotation = 0;
    clear(): void { this.generation++; this.cursors.clear(); this.limited.clear(); this.cursorBytes = 0; }
    /** Explicit user refresh retries limited servers without discarding healthy scan progress. */
    retryLimited(): void { this.limited.clear(); }
    private dropCursor(id: string): void {
        const cursor = this.cursors.get(id);
        if (cursor) { this.cursorBytes -= cursor.bytes; this.cursors.delete(id); }
    }
    private charge(cursor: Cursor, delta: number): void {
        if (this.cursorBytes + delta > maxCursorBytes) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
        cursor.bytes += delta;
        this.cursorBytes += delta;
    }
    private removeFolder(cursor: Cursor): Folder | undefined {
        const folder = cursor.folders.shift();
        if (folder) { cursor.queued.delete(folder.url); this.charge(cursor, -entryBytes(folder) - 32); }
        return folder;
    }

    async collect(options: InventoryOptions): Promise<JenkinsInventoryResult> {
        const generation = this.generation;
        const checkActive = (): void => {
            if (generation !== this.generation || options.signal?.aborted) { throw new JenkinsClientError('CANCELLED'); }
        };
        const result: JenkinsInventoryResult = { candidates: [], continuing: false, limited: false, failures: [] };
        const wanted = new Map<string, Set<string>>();
        for (const request of options.requests) {
            if (request.requestIdParameter) {
                if (!wanted.has(request.requestIdParameter)) { wanted.set(request.requestIdParameter, new Set()); }
                wanted.get(request.requestIdParameter)!.add(request.id);
            }
        }
        const ids = new Set(options.servers.map(server => server.id));
        for (const id of this.cursors.keys()) { if (!ids.has(id)) { this.dropCursor(id); } }
        for (const id of this.limited.keys()) { if (!ids.has(id)) { this.limited.delete(id); } }
        const start = this.rotation++ % Math.max(1, options.servers.length);
        const servers = [...options.servers.slice(start), ...options.servers.slice(0, start)];
        const clients = new Map<string, Promise<JenkinsClient>>();
        const done = new Set<string>();
        const jobLimit = options.jobLimit ?? jenkinsClientLimits.defaultMaxJobs;
        const identities = new Map(servers.map(server => [server.id,
            JSON.stringify([server.url, server.username, server.caFile, server.allowInsecureHttp, jobLimit])]));
        // A permanent limit must not consume the shared HTTP budget every round.
        for (const server of servers) {
            if (this.limited.get(server.id) === identities.get(server.id)) { done.add(server.id); result.limited = true; }
            else { this.limited.delete(server.id); }
        }
        let remaining = options.maxOperations ?? 150;
        let bytes = 0;
        let reserved = 0;
        const step = async (server: JenkinsServer): Promise<void> => {
            if (done.has(server.id) || options.signal?.aborted || remaining <= 0
                || result.candidates.length + reserved + options.recentBuildLimit > jenkinsLimits.maxCandidates) { return; }
            remaining--;
            reserved += options.recentBuildLimit;
            let queried: Cursor | undefined;
            let queriedFolder = false;
            try {
                if (!clients.has(server.id)) { clients.set(server.id, options.client(server)); }
                const client = await clients.get(server.id)!;
                checkActive();
                const identity = identities.get(server.id)!;
                let cursor = this.cursors.get(server.id);
                if (!cursor || cursor.identity !== identity) {
                    this.dropCursor(server.id);
                    const folder = { url: server.url, parent: '', depth: 0 };
                    cursor = { identity, jobs: [], next: 0, folders: [folder], queued: new Set([folder.url]), visited: new Set(), jobCount: 0, bytes: 0 };
                    this.cursors.set(server.id, cursor);
                    this.charge(cursor, entryBytes(identity) + entryBytes(folder) + 32 + 128);
                }
                queried = cursor;
                if (cursor.folders.length > 0) {
                    queriedFolder = true;
                    const folder = cursor.folders[0];
                    if (folder.depth > jenkinsClientLimits.maxFolderDepth || cursor.visited.size >= jenkinsClientLimits.maxFolders) {
                        throw new JenkinsClientError('DISCOVERY_LIMIT');
                    }
                    const jobs = await client.listJobsPage(folder.url, folder.parent);
                    checkActive();
                    if (cursor.jobCount + jobs.length > jobLimit) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
                    cursor.jobCount += jobs.length;
                    this.removeFolder(cursor);
                    this.charge(cursor, entryBytes(folder.url));
                    cursor.visited.add(folder.url);
                    for (const job of jobs) {
                        if (job.buildable) { this.charge(cursor, entryBytes(job.url)); cursor.jobs.push(job.url); }
                        else if (job.kind !== 'job' && !cursor.visited.has(job.url) && !cursor.queued.has(job.url)) {
                            const nextFolder = { url: job.url, parent: job.fullName, depth: folder.depth + 1 };
                            this.charge(cursor, entryBytes(nextFolder) + 32);
                            cursor.queued.add(job.url);
                            cursor.folders.push(nextFolder);
                        }
                    }
                } else if (cursor.next < cursor.jobs.length) {
                    const jobUrl = cursor.jobs[cursor.next];
                    const recent = await client.listRecentBuilds(jobUrl, options.recentBuildLimit);
                    checkActive();
                    for (const build of recent) {
                        const candidate: TrackedJenkinsBuild = {
                            url: build.url, number: build.number, result: build.result, building: build.building,
                            serverId: server.id, jobUrl,
                            actions: build.actions?.map(action => ({ causes: action.causes,
                                parameters: action.parameters?.filter(parameter => typeof parameter.value === 'string'
                                    && wanted.get(parameter.name)?.has(parameter.value)) })),
                        };
                        const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
                        if (bytes + size > 4 * 1024 * 1024) { result.limited = true; continue; }
                        bytes += size;
                        result.candidates.push(candidate);
                    }
                    cursor.next++;
                }
                if (cursor.folders.length === 0 && cursor.next >= cursor.jobs.length) { this.dropCursor(server.id); done.add(server.id); }
            } catch (error) {
                if (generation !== this.generation) {
                    remaining = 0; result.continuing = true; done.add(server.id); return;
                }
                // A deleted/inaccessible job must not starve every later job on this server.
                // Keep cancellation at the same position; retry failed jobs on the next full scan.
                const code = error instanceof JenkinsClientError ? error.code : undefined;
                if (code === 'REQUEST_LIMIT' || code === 'CANCELLED' || options.signal?.aborted) {
                    remaining = 0;
                    result.continuing = true;
                } else if (code === 'DISCOVERY_LIMIT') {
                    result.limited = true;
                    this.limited.set(server.id, identities.get(server.id)!);
                    this.dropCursor(server.id);
                } else {
                    if (queried) {
                        if (queriedFolder) { this.removeFolder(queried); }
                        else { queried.next++; }
                        if (queried.folders.length === 0 && queried.next >= queried.jobs.length) { this.dropCursor(server.id); }
                    }
                    result.failures.push(server.id);
                }
                done.add(server.id);
            } finally { reserved -= options.recentBuildLimit; }
        };
        // Round-robin controllers, at most two in flight. A failed controller does not
        // consume every following round; its cursor is retained for a later retry.
        while (done.size < servers.length && remaining > 0 && !options.signal?.aborted
            && result.candidates.length + options.recentBuildLimit <= jenkinsLimits.maxCandidates) {
            for (let index = 0; index < servers.length; index += 2) {
                await Promise.all(servers.slice(index, index + 2).map(step));
            }
        }
        result.continuing ||= this.cursors.size > 0 || options.signal?.aborted === true;
        return result;
    }
}
