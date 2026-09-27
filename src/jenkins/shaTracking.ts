import { isDeferredJenkinsError, JenkinsClientError } from './client';
import { buildKey, extractActualSha, isTerminalJenkinsBuild } from './model';
import type { TrackingOptions } from './tracking';
import { JenkinsBuild, JenkinsRequest, JenkinsShaJob, jenkinsLimits } from './types';

export function expireJenkinsRequest(request: JenkinsRequest, now = Date.now()): boolean {
    if (request.stopped || request.settledAt) { return true; }
    const deadline = request.deadlineAt ?? request.createdAt + jenkinsLimits.trackingTimeoutMs;
    if (now < deadline) { return false; }
    request.stopped = true;
    request.settledAt = now;
    request.outcome = 'timeout';
    request.error = 'JENKINS_TRACKING_TIMEOUT';
    return true;
}

function errorCode(error: unknown): string {
    return error instanceof JenkinsClientError ? error.code : 'JENKINS_UNAVAILABLE';
}

export function matchesJenkinsSha(build: JenkinsBuild, request: JenkinsRequest, job: JenkinsShaJob): boolean {
    const actual = extractActualSha(build, request.repoRemote);
    if (actual) { return actual === request.sha.toLowerCase(); }
    if (matchingCheckoutSha(build, request.sha)) { return true; }
    // An explicitly configured parameter can identify the tested firmware even when the
    // job only downloads an image. It is not presented as proof of a Git checkout.
    return Boolean(job.shaParameter && build.actions?.some(action => action.parameters?.some(parameter =>
        parameter.name === job.shaParameter && typeof parameter.value === 'string'
        && parameter.value.toLowerCase() === request.sha.toLowerCase())));
}

function matchingCheckoutSha(build: JenkinsBuild, sha: string): string | undefined {
    // A full checkout hash is positive evidence even when SSH/HTTPS/Gerrit URLs
    // differ. Remote identity is still used above to reject a known mismatch.
    return build.actions?.some(action => (!action._class || action._class === 'hudson.plugins.git.util.BuildData')
        && action.lastBuiltRevision?.SHA1?.toLowerCase() === sha.toLowerCase()) ? sha.toLowerCase() : undefined;
}

/** Only the frozen job scope is queried; no server-wide scan and no POST happen here. */
export async function pollJenkinsSha(request: JenkinsRequest, options: TrackingOptions): Promise<void> {
    const scope = request.shaTracking!;
    if (expireJenkinsRequest(request) || options.signal?.aborted) { return; }
    const read = options.read ?? (async <T>(_key: string, fetch: () => Promise<T>): Promise<T> => fetch());
    const start = scope.cursor % scope.jobs.length;
    for (let offset = 0; offset < scope.jobs.length; offset++) {
        if (options.signal?.aborted || expireJenkinsRequest(request)) { return; }
        const index = (start + offset) % scope.jobs.length;
        const job = scope.jobs[index];
        scope.cursor = index;
        let run = request.runs.find(item => item.serverId === job.serverId && item.jobUrl === job.jobUrl);
        if (run?.finalizedAt || job.finalizedAt) { continue; }
        const server = options.servers.find(item => item.id === job.serverId);
        if (!server) { job.error = 'JENKINS_SERVER_REMOVED'; job.finalizedAt = Date.now(); continue; }
        let retainCursor = false;
        try {
            const client = await options.client(server);
            const root = job.serverId === request.root.serverId && job.jobUrl === request.root.jobUrl;
            if (!run?.coreCompletedAt) {
                let build: JenkinsBuild;
                if (!job.buildUrl && root && !scope.readOnly) {
                    if (!request.root.buildUrl && request.root.queueUrl) {
                        try {
                            const queue = await read(`${server.id}\nqueue\n${request.root.queueUrl}`, () => client.getQueue(request.root.queueUrl!));
                            request.queueReason = queue.why;
                            if (queue.cancelled) { job.error = 'JENKINS_QUEUE_CANCELLED'; job.finalizedAt = Date.now(); continue; }
                            if (queue.executable) {
                                if (queue.executable.url.replace(/\d+\/$/, '') !== job.jobUrl) { throw new JenkinsClientError('INVALID_RESPONSE'); }
                                request.root.buildUrl = queue.executable.url;
                            }
                        } catch (error) {
                            if (isDeferredJenkinsError(error)) { throw error; }
                            // Queue expiry, credentials or a busy root never block other servers.
                            request.queueReason = undefined;
                        }
                    }
                    job.buildUrl = request.root.buildUrl;
                }
                if (!job.buildUrl) {
                    // Submitted scopes must have a baseline, including the root job.
                    if (!scope.readOnly && job.afterBuild === undefined) { job.error = 'JENKINS_RESULTS_INCOMPLETE'; job.finalizedAt = Date.now(); continue; }
                    const recent = await read(`${server.id}\nrecent\n${job.jobUrl}`, () => client.listRecentBuilds(job.jobUrl, options.recentBuildLimit));
                    const queueId = root && !scope.readOnly ? /\/queue\/item\/(\d+)\/?$/.exec(request.root.queueUrl ?? '')?.[1] : undefined;
                    const match = recent.filter(item => item.number > (job.afterBuild ?? 0)
                        && (queueId ? item.queueId === Number(queueId) : matchesJenkinsSha(item, request, job)))
                        .sort((a, b) => b.number - a.number)[0];
                    if (!match) { delete job.error; continue; }
                    job.buildUrl = match.url;
                    build = match;
                } else {
                    build = await read(`${server.id}\nbuild\n${job.buildUrl}`, () => client.getBuild(job.buildUrl!));
                }
                if (options.signal?.aborted || expireJenkinsRequest(request)) { return; }
                if (root && !scope.readOnly) { request.root.buildUrl = job.buildUrl; delete request.submission; }
                if (!run) {
                    if (options.reserveRuns && !options.reserveRuns(1)) {
                        request.error = 'JENKINS_RUN_LIMIT'; request.stopped = true; return;
                    }
                    run = { ...build, serverId: server.id, jobUrl: job.jobUrl, correlation: root && !scope.readOnly ? 'root' : 'sha' };
                    request.runs.push(run);
                }
                Object.assign(run, build, { actualSha: extractActualSha(build, request.repoRemote) ?? matchingCheckoutSha(build, request.sha), error: undefined });
                delete run.actions; delete run.artifacts; delete job.error;
                if (!isTerminalJenkinsBuild(build)) { continue; }
                // Freeze the terminal core immediately; deferred reports never refetch it.
                run.coreCompletedAt = Date.now();
            }
            for (const kind of ['stages', 'tests'] as const) {
                if (run[kind] !== undefined || run.reportErrors?.[kind]) { continue; }
                if (options.signal?.aborted || expireJenkinsRequest(request)) { return; }
                try {
                    if (kind === 'stages') { run.stages = await read(`${server.id}\nstages\n${run.url}`, () => client.getStages(run!.url)); }
                    else { run.tests = await read(`${server.id}\ntests\n${run.url}`, () => client.getTestReport(run!.url)); }
                } catch (error) {
                    // Local scheduling interruption is not a failed report. Actual HTTP
                    // errors are recorded once and are never retried automatically.
                    if (options.signal?.aborted || isDeferredJenkinsError(error)) { throw error; }
                    run.reportErrors = { ...run.reportErrors, [kind]: errorCode(error) };
                }
            }
            if (options.signal?.aborted || expireJenkinsRequest(request)) { return; }
            run.finalizedAt = Date.now();
            delete run.error;
            delete job.error;
        } catch (error) {
            const code = errorCode(error);
            if (options.signal?.aborted || isDeferredJenkinsError(error)) {
                retainCursor = code === 'REQUEST_LIMIT';
                if (options.signal?.aborted || code === 'REQUEST_LIMIT' || code === 'CANCELLED') { return; }
                continue; // A guarded server must not block independent servers.
            }
            if (run?.coreCompletedAt) {
                // Credential/client setup can fail before a deferred report starts.
                // Preserve the frozen core and close the reports with that failure too.
                for (const kind of ['stages', 'tests'] as const) {
                    if (run[kind] === undefined && !run.reportErrors?.[kind]) { run.reportErrors = { ...run.reportErrors, [kind]: code }; }
                }
                run.finalizedAt = Date.now();
                delete run.error; delete job.error;
            } else {
                job.error = code;
                if (run) { run.error = code; }
            }
        } finally {
            // Budget exhaustion keeps the unserved job. A stalled core advances the
            // cursor so the same slow server cannot consume every future round.
            if (!retainCursor && (!run?.coreCompletedAt || run.finalizedAt)) { scope.cursor = (index + 1) % scope.jobs.length; }
        }
    }
    if (request.stopped || options.signal?.aborted) { return; }
    const completed = scope.jobs.every(job => job.finalizedAt || request.runs.some(run =>
        buildKey(run.serverId, run.url) === buildKey(job.serverId, job.buildUrl ?? '') && run.finalizedAt));
    request.discovery = { complete: completed && !scope.jobs.some(job => job.error), message: 'selectedJobs', checkedAt: Date.now() };
    if (completed) {
        request.settledAt = Date.now();
        delete request.submission;
        const incomplete = scope.jobs.some(job => job.error) || request.runs.some(run => run.error || run.reportErrors);
        request.outcome = incomplete ? 'incomplete' : 'complete';
        request.error = incomplete ? 'JENKINS_RESULTS_INCOMPLETE' : undefined;
    } else {
        request.error = undefined;
    }
}
