import * as fs from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';
import {
    JenkinsBuild, JenkinsJob, JenkinsParameter, JenkinsQueue, JenkinsServer,
    JenkinsStages, JenkinsTestReport,
} from './types';

const defaultTimeoutMs = 15_000;
const defaultMaxResponseBytes = 2 * 1024 * 1024;
export const jenkinsClientLimits = {
    defaultTimeoutMs,
    defaultMaxResponseBytes,
    defaultMaxJobs: 200,
    maxFolderDepth: 16,
    maxFolders: 1000,
    maxPermissionEntries: 8192,
} as const;
const buildTree = 'url,number,fullDisplayName,building,result,timestamp,duration,queueId,' +
    'actions[_class,parameters[name,value],causes[upstreamUrl,upstreamProject,upstreamBuild,' +
    'upstreamCauses[upstreamUrl,upstreamProject,upstreamBuild]],lastBuiltRevision[SHA1],remoteUrls],' +
    'artifacts[fileName,relativePath]';

const errorMessages: Record<string, string> = {
    INVALID_URL: 'Invalid Jenkins server URL.',
    OUTSIDE_SERVER: 'The requested URL is outside the configured Jenkins server.',
    INVALID_CREDENTIALS: 'Jenkins username and API token are required.',
    INVALID_OPTIONS: 'Invalid Jenkins client limits.',
    INVALID_CA: 'The configured Jenkins CA certificate could not be loaded.',
    AUTH_REQUIRED: 'Jenkins authentication failed.',
    FORBIDDEN: 'Jenkins denied this request.',
    NOT_FOUND: 'The Jenkins resource was not found.',
    REDIRECT: 'Jenkins redirects are not followed.',
    HTTP_ERROR: 'Jenkins returned an unsuccessful HTTP status.',
    TIMEOUT: 'The Jenkins request timed out. A submitted build may still be queued.',
    RESPONSE_TOO_LARGE: 'The Jenkins response exceeded the configured size limit.',
    INVALID_RESPONSE: 'Jenkins returned an invalid response.',
    NETWORK_ERROR: 'The Jenkins connection failed. A submitted build may still be queued.',
    QUEUE_LOCATION_MISSING: 'Jenkins accepted the request without a usable queue location.',
    INVALID_PARAMETER: 'A Jenkins request parameter is invalid.',
    DISCOVERY_LIMIT: 'Jenkins job discovery exceeded its limit; the list is incomplete.',
    CANCELLED: 'The Jenkins request was cancelled. A submitted build may still be queued.',
};

/** Only fixed descriptions and HTTP status are exposed; never server bodies or credentials. */
export class JenkinsClientError extends Error {
    constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterMs?: number) {
        super(`${errorMessages[code] ?? 'Jenkins request failed.'}${status === undefined ? '' : ` (HTTP ${status})`}`);
        this.name = 'JenkinsClientError';
    }
}

/** The configured URL is the only origin and context path allowed to receive credentials. */
export function normalizeJenkinsServerUrl(input: string): string {
    try {
        const value = input.trim();
        const url = new URL(value);
        if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value) ||
            !['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
            url.search || url.hash || value.includes('?') || value.includes('#') ||
            /^[a-z][a-z\d+.-]*:\/\/[^/]*@/iu.test(value)) {
            throw new Error();
        }
        if (!url.pathname.endsWith('/')) {
            url.pathname += '/';
        }
        return url.href;
    } catch {
        throw new JenkinsClientError('INVALID_URL');
    }
}

/** Shared credential, manifest, artifact and browser-link boundary. */
export function scopedJenkinsUrl(baseUrl: URL, input: string): URL {
    try {
        if (typeof input !== 'string' || input.length > 8192 || /[\u0000-\u001f\u007f]/u.test(input)) { throw new Error(); }
        const url = new URL(input, baseUrl);
        if (url.origin !== baseUrl.origin || url.username || url.password || url.hash ||
            !url.pathname.startsWith(baseUrl.pathname)) {
            throw new Error();
        }
        // Check decoded paths as well: a proxy must not turn an encoded traversal into an
        // authenticated request outside the Jenkins context. Encoded branch slashes remain valid.
        let pathname = url.pathname;
        let basePathname = baseUrl.pathname;
        for (let pass = 0; pass < 5; pass++) {
            const next = decodeURIComponent(pathname);
            const nextBase = decodeURIComponent(basePathname);
            if (/[\u0000-\u001f\u007f;?#]/u.test(next)) { throw new Error(); }
            const decoded = new URL(next.replace(/\\/gu, '/'), baseUrl.origin);
            if (decoded.origin !== baseUrl.origin) { throw new Error(); }
            const normalized = decoded.pathname;
            const normalizedBase = new URL(nextBase.replace(/\\/gu, '/'), baseUrl.origin).pathname;
            if (!normalized.startsWith(normalizedBase)) {
                throw new Error();
            }
            if (next === pathname && nextBase === basePathname) {
                return url;
            }
            pathname = next;
            basePathname = nextBase;
        }
        throw new Error();
    } catch {
        throw new JenkinsClientError('OUTSIDE_SERVER');
    }
}

/** Returns a stable error code for localized input validation, or undefined when valid. */
export function validateJenkinsServerUrl(input: string): string | undefined {
    try {
        normalizeJenkinsServerUrl(input);
        return undefined;
    } catch {
        return 'INVALID_URL';
    }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): JsonRecord {
    if (!isRecord(value)) {
        throw new JenkinsClientError('INVALID_RESPONSE');
    }
    return value;
}

function positiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function jobKind(value: JsonRecord): string {
    const className = typeof value._class === 'string' ? value._class : '';
    if (className.includes('MultiBranchProject')) {
        return 'multibranch';
    }
    if (className.includes('Folder')) {
        return 'folder';
    }
    return 'job';
}

export interface JenkinsClientOptions {
    token: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxJobs?: number;
    signal?: AbortSignal;
    guard?: JenkinsTransportGuard;
    budget?: { remaining: number };
}

interface HttpResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
    truncated?: boolean;
}

/** Rejects promptly on cancellation even if a platform API (keychain/filesystem) is still pending. */
export function abortable<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = (): void => { cleanup(); reject(new JenkinsClientError('CANCELLED')); };
        const cleanup = (): void => signal.removeEventListener('abort', cancel);
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve(value).then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
        if (signal.aborted) { cancel(); }
    });
}

/** Per-controller limits: no unbounded socket queue, server failures never block other servers. */
export class JenkinsTransportGuard {
    private active = 0;
    private generation = 0;
    private readonly serverGenerations = new Map<string, number>();
    private readonly activeServers = new Map<string, number>();
    private readonly failures = new Map<string, { count: number; until: number; authentication?: boolean }>();
    private readonly permissions = new Map<string, { server: string; until: number }>();
    private readonly permissionOverflow = new Map<string, number>();
    private readonly waiting = new Set<() => void>();
    constructor(private readonly now = Date.now, private readonly random = Math.random) {}
    reset(serverUrl?: string): void {
        if (serverUrl) { this.serverGenerations.set(serverUrl, (this.serverGenerations.get(serverUrl) ?? 0) + 1); }
        else { this.generation++; this.serverGenerations.clear(); }
        if (serverUrl) { this.failures.delete(serverUrl); this.permissionOverflow.delete(serverUrl); }
        else { this.failures.clear(); this.permissionOverflow.clear(); }
        for (const [key, entry] of this.permissions) {
            if (!serverUrl || entry.server === serverUrl) { this.permissions.delete(key); }
        }
    }
    private check(server: string, resource: string): void {
        const failure = this.failures.get(server);
        if (failure && failure.until > this.now()) {
            throw new JenkinsClientError(failure.authentication ? 'AUTH_REQUIRED' : 'BACKOFF', failure.authentication ? 401 : undefined);
        }
        const permission = this.permissions.get(resource);
        if (permission && permission.until > this.now()) { throw new JenkinsClientError('FORBIDDEN', 403); }
        if ((this.permissionOverflow.get(server) ?? 0) > this.now()) { throw new JenkinsClientError('PERMISSION_LIMIT'); }
    }
    private acquire(server: string, signal: AbortSignal, resource: string): Promise<() => void> {
        if (this.waiting.size >= 32) { return Promise.reject(new JenkinsClientError('BUSY')); }
        return new Promise((resolve, reject) => {
            const cleanup = (): void => { this.waiting.delete(attempt); signal.removeEventListener('abort', cancel); };
            const cancel = (): void => { cleanup(); reject(new JenkinsClientError('CANCELLED')); };
            const attempt = (): void => {
                if (signal.aborted) { cancel(); return; }
                try { this.check(server, resource); } catch (error) { cleanup(); reject(error); return; }
                if (this.active >= 4 || (this.activeServers.get(server) ?? 0) >= 2) { return; }
                cleanup(); this.active++; this.activeServers.set(server, (this.activeServers.get(server) ?? 0) + 1);
                resolve(() => {
                    this.active--; this.activeServers.set(server, (this.activeServers.get(server) ?? 1) - 1);
                    for (const wake of [...this.waiting]) { wake(); }
                });
            };
            this.waiting.add(attempt); signal.addEventListener('abort', cancel, { once: true }); attempt();
        });
    }
    async run<T>(server: string, signal: AbortSignal, task: () => Promise<T>, resourceUrl = server): Promise<T> {
        // Fixed-size identities keep long job URLs from multiplying cache memory.
        const resource = createHash('sha256').update(JSON.stringify([server, resourceUrl])).digest('hex');
        const generation = this.generation;
        const serverGeneration = this.serverGenerations.get(server);
        const current = (): boolean => generation === this.generation && serverGeneration === this.serverGenerations.get(server);
        const release = await this.acquire(server, signal, resource);
        const permissionBefore = this.permissions.get(resource);
        const before = this.failures.get(server);
        try {
            if (!current()) { throw new JenkinsClientError('CANCELLED'); }
            const result = await task();
            if (!current()) { return result; }
            if (this.permissions.get(resource) === permissionBefore) { this.permissions.delete(resource); }
            if (this.failures.get(server) === before) { this.failures.delete(server); }
            return result;
        } catch (error) {
            if (!current()) { throw error; }
            if (error instanceof JenkinsClientError && error.code === 'FORBIDDEN') {
                // Reclaim only expired entries; FIFO eviction would let denied URLs retry immediately.
                if (this.permissions.size >= jenkinsClientLimits.maxPermissionEntries) {
                    for (const [key, entry] of this.permissions) {
                        if (entry.until <= this.now()) { this.permissions.delete(key); }
                        else { break; } // Expiry order follows insertion; never scan the whole active cache.
                    }
                }
                if (!this.permissions.has(resource) && this.permissions.size >= jenkinsClientLimits.maxPermissionEntries) {
                    // Supported retained builds fit in the cache. At overflow, stop admitting
                    // calls to this server briefly and expose an explicit capacity error.
                    this.permissionOverflow.set(server, this.now() + 60000);
                } else {
                    this.permissions.delete(resource); // Renewed entries belong at the end of the expiry order.
                    this.permissions.set(resource, { server, until: this.now() + 60000 });
                }
            } else if (error instanceof JenkinsClientError && (['NETWORK_ERROR', 'TIMEOUT', 'INVALID_CA', 'AUTH_REQUIRED'].includes(error.code)
                || error.status === 429 || (error.status ?? 0) >= 500 || (error.code === 'CANCELLED' && !signal.aborted))) {
                const count = Math.min(8, (this.failures.get(server)?.count ?? 0) + 1);
                const retryDelay = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs!) : 0;
                const authentication = error.code === 'AUTH_REQUIRED';
                const wait = Math.max(5000 * 2 ** (count - 1) * (1 + this.random() * 0.2), retryDelay, authentication ? 60000 : 0);
                this.failures.set(server, { count, until: this.now() + Math.min(300000, wait), authentication });
            }
            throw error;
        } finally { release(); }
    }
}

// At most one CA filesystem operation runs at a time. A disconnected filesystem
// cannot consume the entire extension host libuv pool through repeated polling.
let certificateTail = Promise.resolve();
const pendingCertificates = new Map<string, Promise<Array<string | Buffer>>>();
function loadCertificate(path: string): Promise<Array<string | Buffer>> {
    const existing = pendingCertificates.get(path);
    if (existing) { return existing; }
    if (pendingCertificates.size >= 32) { return Promise.reject(new JenkinsClientError('BUSY')); }
    const pending = certificateTail.then(async () => {
        let file: fs.promises.FileHandle | undefined;
        try {
            file = await fs.promises.open(path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
            const stats = await file.stat();
            if (!stats.isFile() || stats.size === 0 || stats.size > 65536) { throw new Error(); }
            const buffer = Buffer.alloc(65537);
            let length = 0;
            while (length < buffer.length) {
                const result = await file.read(buffer, length, buffer.length - length, length);
                if (result.bytesRead === 0) { break; }
                length += result.bytesRead;
            }
            if (length === 0 || length > 65536) { throw new Error(); }
            const certificate = buffer.subarray(0, length);
            const certificates = certificate.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
            if (!certificates?.length) { throw new Error(); }
            certificates.forEach(value => new X509Certificate(value));
            tls.createSecureContext({ ca: certificate });
            return [...tls.rootCertificates, certificate];
        } catch { throw new JenkinsClientError('INVALID_CA'); }
        finally { await file?.close(); }
    });
    certificateTail = pending.then(() => {}, () => {});
    pendingCertificates.set(path, pending);
    void pending.then(() => pendingCertificates.delete(path), () => pendingCertificates.delete(path));
    return pending;
}

export class JenkinsClient {
    private readonly baseUrl: URL;
    private readonly authorization: string;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly maxJobs: number;
    private readonly signal?: AbortSignal;
    private readonly caFile?: string;
    private ca?: Promise<Array<string | Buffer>>;
    private readonly guard?: JenkinsTransportGuard;
    private readonly budget?: { remaining: number };

    constructor(server: JenkinsServer, options: JenkinsClientOptions) {
        this.baseUrl = new URL(normalizeJenkinsServerUrl(server.url));
        if (this.baseUrl.protocol === 'http:' && server.allowInsecureHttp !== true) { throw new JenkinsClientError('INSECURE_HTTP'); }
        if (!server.username || !options.token || server.username.length > 1024 || options.token.length > 16384 || /[:\r\n]/u.test(server.username) || /[\r\n]/u.test(options.token)) {
            throw new JenkinsClientError('INVALID_CREDENTIALS');
        }
        this.authorization = `Basic ${Buffer.from(`${server.username}:${options.token}`, 'utf8').toString('base64')}`;
        this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
        this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
        this.maxJobs = options.maxJobs ?? jenkinsClientLimits.defaultMaxJobs;
        this.signal = options.signal;
        if (!positiveInteger(this.timeoutMs) || !positiveInteger(this.maxResponseBytes) || !positiveInteger(this.maxJobs)) {
            throw new JenkinsClientError('INVALID_OPTIONS');
        }
        this.caFile = server.caFile;
        this.guard = options.guard;
        this.budget = options.budget;
    }

    private async certificate(): Promise<Array<string | Buffer> | undefined> {
        if (!this.caFile) { return undefined; }
        this.ca ??= loadCertificate(this.caFile);
        return this.ca;
    }

    async verify(): Promise<{ authenticated: boolean; name: string }> {
        const value = requireRecord(await this.json(this.endpoint(this.baseUrl.href, 'whoAmI/api/json')));
        if (value.authenticated !== true || typeof value.name !== 'string') {
            throw new JenkinsClientError('AUTH_REQUIRED');
        }
        return { authenticated: true, name: value.name };
    }

    async listJobs(): Promise<JenkinsJob[]> {
        const jobs: JenkinsJob[] = [];
        const pending = [{ url: this.baseUrl.href, parent: '', depth: 0 }];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const folder = pending.shift()!;
            if (visited.has(folder.url)) {
                continue;
            }
            visited.add(folder.url);
            if (folder.depth > jenkinsClientLimits.maxFolderDepth || visited.size > jenkinsClientLimits.maxFolders) {
                throw new JenkinsClientError('DISCOVERY_LIMIT');
            }
            for (const job of await this.listJobsPage(folder.url, folder.parent)) {
                jobs.push(job);
                if (jobs.length > this.maxJobs) {
                    throw new JenkinsClientError('DISCOVERY_LIMIT');
                }
                if (job.kind !== 'job') {
                    pending.push({ url: job.url, parent: job.fullName, depth: folder.depth + 1 });
                }
            }
        }
        return jobs;
    }

    /** One HTTP request; callers can retain their own bounded folder cursor. */
    async listJobsPage(url = this.baseUrl.href, parent = ''): Promise<JenkinsJob[]> {
        const value = requireRecord(await this.json(this.api(url, 'jobs[name,fullName,url,buildable,color,_class]')));
        if (!Array.isArray(value.jobs)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        if (value.jobs.length > this.maxJobs) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
        return value.jobs.map(raw => this.parseJob(requireRecord(raw), parent));
    }

    async getJob(url: string): Promise<JenkinsJob> {
        const parameterTree = 'parameterDefinitions[name,type,_class,description,choices,defaultParameterValue[value]]';
        const value = requireRecord(await this.json(this.api(url,
            `name,fullName,url,buildable,color,_class,property[${parameterTree}],actions[${parameterTree}]`)));
        const job = this.parseJob(value);
        const parameters = new Map<string, JenkinsParameter>();
        for (const entry of [...(Array.isArray(value.property) ? value.property : []),
            ...(Array.isArray(value.actions) ? value.actions : [])]) {
            if (!isRecord(entry) || !Array.isArray(entry.parameterDefinitions)) {
                continue;
            }
            for (const definition of entry.parameterDefinitions) {
                if (!isRecord(definition) || typeof definition.name !== 'string') {
                    continue;
                }
                const parameter: JenkinsParameter = {
                    name: definition.name,
                    type: typeof definition.type === 'string' ? definition.type :
                        typeof definition._class === 'string' ? definition._class.split('.').pop()! : 'unknown',
                };
                if (typeof definition.description === 'string') {
                    parameter.description = definition.description;
                }
                if (isRecord(definition.defaultParameterValue)) {
                    parameter.defaultValue = definition.defaultParameterValue.value;
                }
                if (Array.isArray(definition.choices) && definition.choices.every(choice => typeof choice === 'string')) {
                    parameter.choices = definition.choices;
                }
                parameters.set(parameter.name, parameter);
            }
        }
        if (parameters.size > 100) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        job.parameters = [...parameters.values()];
        return job;
    }

    async trigger(url: string, parameters: Record<string, string | number | boolean> = {}): Promise<{ queueUrl: string }> {
        const entries = Object.entries(parameters);
        const body = new URLSearchParams();
        for (const [name, value] of entries) {
            if (!name || !['string', 'number', 'boolean'].includes(typeof value) ||
                (typeof value === 'number' && !Number.isFinite(value))) {
                throw new JenkinsClientError('INVALID_PARAMETER');
            }
            body.append(name, String(value));
        }
        const endpoint = this.endpoint(url, entries.length > 0 ? 'buildWithParameters' : 'build');
        // Never retry a POST automatically: a lost response may still represent a queued build.
        const response = await this.request(endpoint, 'POST', Buffer.from(body.toString(), 'utf8'));
        const location = response.headers.location;
        if (!location) {
            throw new JenkinsClientError('QUEUE_LOCATION_MISSING', response.status);
        }
        let queueUrl: URL;
        try {
            queueUrl = this.scopedUrl(new URL(location, endpoint).href);
        } catch {
            throw new JenkinsClientError('QUEUE_LOCATION_MISSING', response.status);
        }
        if (!queueUrl.pathname.startsWith(`${this.baseUrl.pathname}queue/item/`) ||
            !/\/queue\/item\/\d+\/?$/u.test(queueUrl.pathname)) {
            throw new JenkinsClientError('QUEUE_LOCATION_MISSING', response.status);
        }
        return { queueUrl: queueUrl.href };
    }

    async getQueue(url: string): Promise<JenkinsQueue> {
        const value = requireRecord(await this.json(this.api(url,
            'id,why,cancelled,blocked,buildable,stuck,executable[number,url]')));
        if (value.executable === null) {
            delete value.executable;
        } else if (value.executable !== undefined) {
            const executable = requireRecord(value.executable);
            if (typeof executable.url !== 'string' || !positiveInteger(executable.number)) {
                throw new JenkinsClientError('INVALID_RESPONSE');
            }
            executable.url = this.scopedUrl(executable.url).href;
        }
        if (value.why !== undefined && typeof value.why !== 'string') { throw new JenkinsClientError('INVALID_RESPONSE'); }
        if (value.cancelled !== undefined && typeof value.cancelled !== 'boolean') { throw new JenkinsClientError('INVALID_RESPONSE'); }
        if (typeof value.why === 'string') { value.why = value.why.slice(0, 1024); }
        return value as JenkinsQueue;
    }

    async getBuild(url: string): Promise<JenkinsBuild> {
        const build = this.parseBuild(await this.json(this.api(url, buildTree)));
        const expected = this.scopedUrl(url); expected.search = '';
        if (build.url.replace(/\/+$/, '') !== expected.href.replace(/\/+$/, '')
            || !new URL(build.url).pathname.endsWith(`/${build.number}/`)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        return build;
    }

    async getStages(buildUrl: string): Promise<JenkinsStages | null> {
        const value = await this.optionalJson(this.endpoint(buildUrl, 'wfapi/describe'));
        if (value === null) {
            return null;
        }
        const result = requireRecord(value);
        if (result.stages !== undefined && (!Array.isArray(result.stages) ||
            result.stages.length > 500 || !result.stages.every(stage => isRecord(stage) && typeof stage.id === 'string' &&
                typeof stage.name === 'string' && typeof stage.status === 'string'))) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        const stages = (result.stages ?? []) as Array<{ id: string; name: string; status: string; durationMillis?: number }>;
        return { status: typeof result.status === 'string' ? result.status.slice(0, 64) : undefined,
            detailsTruncated: stages.length > 50, stages: stages.slice(0, 50).map(stage => ({
                id: stage.id.slice(0, 128), name: stage.name.slice(0, 128), status: stage.status.slice(0, 64),
                durationMillis: typeof stage.durationMillis === 'number' ? stage.durationMillis : undefined,
            })) };
    }

    async getTestReport(buildUrl: string): Promise<JenkinsTestReport | null> {
        const value = await this.optionalJson(this.api(this.endpoint(buildUrl, 'testReport/').href,
            'passCount,failCount,skipCount,suites[name,cases[name,className,status]]'));
        if (value === null) {
            return null;
        }
        const result = requireRecord(value);
        if (!['passCount', 'failCount', 'skipCount'].every(key =>
            typeof result[key] === 'number' && Number.isSafeInteger(result[key]) && (result[key] as number) >= 0)) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        if (result.suites !== undefined && !Array.isArray(result.suites)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        const report: JenkinsTestReport = { passCount: result.passCount as number, failCount: result.failCount as number, skipCount: result.skipCount as number, suites: [] };
        let retained = 0;
        for (const suite of (result.suites ?? []) as unknown[]) {
            if (!isRecord(suite) || !Array.isArray(suite.cases)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
            const cases: NonNullable<JenkinsTestReport['suites']>[number]['cases'] = [];
            for (const item of suite.cases) {
                if (!isRecord(item) || typeof item.name !== 'string' || typeof item.status !== 'string'
                    || (item.className !== undefined && typeof item.className !== 'string')) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                if (!['PASSED', 'FIXED'].includes(item.status) && retained < 50) {
                    cases.push({ name: item.name.slice(0, 128), status: item.status.slice(0, 64), className: typeof item.className === 'string' ? item.className.slice(0, 128) : undefined });
                    retained++;
                }
            }
            if (cases.length > 0) { report.suites!.push({ cases }); }
        }
        report.detailsTruncated = report.failCount + report.skipCount > retained;
        return report;
    }

    async getLog(buildUrl: string, start = 0): Promise<{ text: string; nextStart: number; more: boolean; truncated?: boolean }> {
        if (!Number.isSafeInteger(start) || start < 0) {
            throw new JenkinsClientError('INVALID_PARAMETER');
        }
        const url = this.endpoint(buildUrl, 'logText/progressiveText');
        url.searchParams.set('start', String(start));
        const response = await this.request(url, 'GET', undefined, true);
        const sizeHeader = response.headers['x-text-size'];
        const nextStart = typeof sizeHeader === 'string' && /^\d+$/u.test(sizeHeader) ? Number(sizeHeader) : NaN;
        if (!Number.isSafeInteger(nextStart) || nextStart < start) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        // A prefix preview is not a resumable chunk: Jenkins' x-text-size may point
        // past unread bytes. Keep the original offset and direct the user to Jenkins.
        const decoder = new StringDecoder('utf8');
        let text = response.truncated ? decoder.write(response.body) : decoder.end(response.body);
        let truncated = response.truncated === true;
        // Invalid UTF-8 replacement characters can expand when encoded for the editor.
        if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
            text = new StringDecoder('utf8').write(Buffer.from(text).subarray(0, this.maxResponseBytes));
            truncated = true;
        }
        return { text, nextStart: truncated ? start : nextStart,
            more: truncated || response.headers['x-more-data'] === 'true',
            ...(truncated ? { truncated: true } : {}) };

    }

    async listRecentBuilds(jobUrl: string, limit = 20): Promise<JenkinsBuild[]> {
        if (!positiveInteger(limit) || limit > 1000) {
            throw new JenkinsClientError('INVALID_PARAMETER');
        }
        const value = requireRecord(await this.json(this.api(jobUrl, `builds[${buildTree}]{0,${limit}}`)));
        if (!Array.isArray(value.builds)) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        const prefix = this.endpoint(jobUrl, '').href;
        return value.builds.slice(0, limit).map(value => {
            const build = this.parseBuild(value);
            if (build.url !== `${prefix}${build.number}/`) { throw new JenkinsClientError('INVALID_RESPONSE'); }
            return build;
        });
    }

    async getArtifact(buildUrl: string, path: string): Promise<Buffer> {
        if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path) ||
            path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
            throw new JenkinsClientError('INVALID_PARAMETER');
        }
        const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
        const root = this.endpoint(buildUrl, 'artifact/');
        const target = scopedJenkinsUrl(root, new URL(encoded, root).href);
        return (await this.request(target)).body;
    }

    private parseJob(value: JsonRecord, parent = ''): JenkinsJob {
        if (typeof value.name !== 'string' || value.name.length > 1024 || typeof value.url !== 'string'
            || (value.fullName !== undefined && (typeof value.fullName !== 'string' || value.fullName.length > 4096))) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        const kind = jobKind(value);
        const fullName = typeof value.fullName === 'string' ? value.fullName : `${parent ? `${parent}/` : ''}${value.name}`;
        if (fullName.length > 4096) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        return {
            name: value.name,
            fullName,
            url: this.scopedUrl(value.url).href,
            buildable: kind === 'job' && (typeof value.buildable === 'boolean' ? value.buildable :
                value.color !== 'disabled' && value.color !== 'disabled_anime'),
            kind,
        };
    }

    private parseBuild(value: unknown): JenkinsBuild {
        const result = requireRecord(value);
        if (typeof result.url !== 'string' || !positiveInteger(result.number) ||
            typeof result.building !== 'boolean' || !(result.result === null || typeof result.result === 'string')) {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
        if (result.actions !== undefined) {
            if (!Array.isArray(result.actions) || result.actions.length > 200) { throw new JenkinsClientError('INVALID_RESPONSE'); }
            for (const action of result.actions) {
                if (!isRecord(action)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                for (const key of ['causes', 'parameters', 'remoteUrls']) {
                    if (action[key] !== undefined && (!Array.isArray(action[key]) || (action[key] as unknown[]).length > 200)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                }
                if (Array.isArray(action.causes) && !action.causes.every(cause => isRecord(cause)
                    && (cause.upstreamUrl === undefined || typeof cause.upstreamUrl === 'string')
                    && (cause.upstreamBuild === undefined || positiveInteger(cause.upstreamBuild)))) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                if (Array.isArray(action.parameters) && !action.parameters.every(parameter => isRecord(parameter) && typeof parameter.name === 'string')) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                if (Array.isArray(action.remoteUrls) && !action.remoteUrls.every(remote => typeof remote === 'string')) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                if (action.lastBuiltRevision !== undefined && !isRecord(action.lastBuiltRevision)) { throw new JenkinsClientError('INVALID_RESPONSE'); }
            }
        }
        if (result.artifacts !== undefined && (!Array.isArray(result.artifacts) || result.artifacts.length > 1000
            || !result.artifacts.every(artifact => isRecord(artifact) && typeof artifact.fileName === 'string' && typeof artifact.relativePath === 'string'))) { throw new JenkinsClientError('INVALID_RESPONSE'); }
        if (result.fullDisplayName !== undefined && typeof result.fullDisplayName !== 'string') { throw new JenkinsClientError('INVALID_RESPONSE'); }
        result.url = this.scopedUrl(result.url).href;
        return {
            url: result.url as string, number: result.number as number, building: result.building as boolean, result: result.result as string | null,
            fullDisplayName: typeof result.fullDisplayName === 'string' ? result.fullDisplayName.slice(0, 1024) : undefined,
            timestamp: typeof result.timestamp === 'number' ? result.timestamp : undefined,
            duration: typeof result.duration === 'number' ? result.duration : undefined,
            queueId: typeof result.queueId === 'number' ? result.queueId : undefined,
            actions: result.actions as JenkinsBuild['actions'], artifacts: result.artifacts as JenkinsBuild['artifacts'],
        };
    }

    private scopedUrl(input: string): URL {
        const url = scopedJenkinsUrl(this.baseUrl, input);
        // Resource identities are persisted: only locally constructed API requests may have queries.
        if (url.search || input.includes('?')) { throw new JenkinsClientError('OUTSIDE_SERVER'); }
        return url;
    }

    private endpoint(input: string, path: string): URL {
        const url = this.scopedUrl(input);
        url.search = '';
        if (!url.pathname.endsWith('/')) {
            url.pathname += '/';
        }
        return this.scopedUrl(new URL(path, url).href);
    }

    private api(input: string, tree?: string): URL {
        const url = this.endpoint(input, 'api/json');
        if (tree) {
            url.searchParams.set('tree', tree);
        }
        return url;
    }

    private async json(url: URL): Promise<unknown> {
        const response = await this.request(url);
        try {
            return JSON.parse(response.body.toString('utf8')) as unknown;
        } catch {
            throw new JenkinsClientError('INVALID_RESPONSE');
        }
    }

    private async optionalJson(url: URL): Promise<unknown | null> {
        try {
            return await this.json(url);
        } catch (error) {
            if (error instanceof JenkinsClientError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    private async request(input: URL, method = 'GET', body?: Buffer, allowPrefix = false): Promise<HttpResponse> {
        if (this.budget && this.budget.remaining-- <= 0) { throw new JenkinsClientError('REQUEST_LIMIT'); }
        const operation = new AbortController();
        const cancel = (): void => operation.abort();
        this.signal?.addEventListener('abort', cancel, { once: true });
        if (this.signal?.aborted) { cancel(); }
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; operation.abort(); }, this.timeoutMs);
        const signal = operation.signal;
        const run = async (): Promise<HttpResponse> => {
            try {
                const ca = await abortable(this.certificate(), signal);
                return await this.sendRequest(input, method, body, ca, signal, allowPrefix);
            } catch (error) { if (timedOut) { throw new JenkinsClientError('TIMEOUT'); } throw error; }
        };
        try {
            return await (this.guard ? this.guard.run(this.baseUrl.href, signal, run, `${method} ${input.origin}${input.pathname}`) : run());
        } catch (error) {
            if (timedOut) { throw new JenkinsClientError('TIMEOUT'); }
            throw error;
        } finally { clearTimeout(timer); this.signal?.removeEventListener('abort', cancel); }
    }

    private sendRequest(input: URL, method: string, body: Buffer | undefined, ca: Array<string | Buffer> | undefined, signal: AbortSignal, allowPrefix: boolean): Promise<HttpResponse> {
        const url = scopedJenkinsUrl(this.baseUrl, input.href);
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let request: http.ClientRequest | undefined;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
            };
            const fail = (error: JenkinsClientError) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(error);
                }
            };
            const cancel = () => {
                fail(new JenkinsClientError('CANCELLED'));
                request?.destroy();
            };
            if (signal?.aborted) {
                cancel();
                return;
            }
            signal?.addEventListener('abort', cancel, { once: true });
            const options: https.RequestOptions = {
                method,
                agent: false,
                headers: {
                    Authorization: this.authorization,
                    Accept: 'application/json, text/plain, application/octet-stream',
                    'Accept-Encoding': 'identity',
                    ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                        'Content-Length': body.length } : {}),
                },
                ...(url.protocol === 'https:' ? { ca, rejectUnauthorized: true } : {}),
            };
            try {
                const transport = url.protocol === 'https:' ? https : http;
                request = transport.request(url, options, response => {
                    const status = response.statusCode ?? 0;
                    if (status < 200 || status >= 300) {
                        const code = status >= 300 && status < 400 ? 'REDIRECT' :
                            status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' :
                                status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
                        const retryAfter = response.headers['retry-after'];
                        const seconds = typeof retryAfter === 'string' ? Number(retryAfter) : NaN;
                        const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : typeof retryAfter === 'string' ? Date.parse(retryAfter) - Date.now() : undefined;
                        fail(new JenkinsClientError(code, status, retryAfterMs));
                        response.destroy();
                        return;
                    }
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                        fail(new JenkinsClientError('INVALID_RESPONSE')); response.destroy(); return;
                    }
                    const contentLength = Number(response.headers['content-length']);
                    if (!allowPrefix && Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
                        fail(new JenkinsClientError('RESPONSE_TOO_LARGE'));
                        response.destroy();
                        return;
                    }
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    const finish = (truncated = false): void => {
                        if (settled) { return; }
                        settled = true;
                        cleanup();
                        resolve({ status, headers: response.headers, body: Buffer.concat(chunks, bytes),
                            ...(truncated ? { truncated: true } : {}) });
                    };
                    response.on('data', (chunk: Buffer) => {
                        if (settled) { return; }
                        const available = this.maxResponseBytes - bytes;
                        if (chunk.length > available || (allowPrefix && chunk.length === available && contentLength > this.maxResponseBytes)) {
                            if (allowPrefix) {
                                // Copy the slice so the retained buffer cannot keep a larger chunk alive.
                                chunks.push(Buffer.from(chunk.subarray(0, available)));
                                bytes += Math.min(chunk.length, available);
                                finish(true);
                            } else { fail(new JenkinsClientError('RESPONSE_TOO_LARGE')); }
                            response.destroy();
                            request?.destroy();
                            return;
                        }
                        bytes += chunk.length;
                        chunks.push(chunk);
                    });
                    response.on('end', () => finish());
                    response.on('error', () => fail(new JenkinsClientError('NETWORK_ERROR')));
                    response.on('aborted', () => fail(new JenkinsClientError('NETWORK_ERROR')));
                });
                request.on('error', () => fail(new JenkinsClientError('NETWORK_ERROR')));
                timer = setTimeout(() => {
                    fail(new JenkinsClientError('TIMEOUT'));
                    request?.destroy();
                }, this.timeoutMs);
                request.end(body);
            } catch {
                fail(new JenkinsClientError('NETWORK_ERROR'));
            }
        });
    }
}
