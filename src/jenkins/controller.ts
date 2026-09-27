import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { t } from '../i18n';
import { abortable, JenkinsClientError, JenkinsTransportGuard, JenkinsClient, normalizeJenkinsServerUrl, validateJenkinsServerUrl } from './client';
import { JenkinsInventory, JenkinsInventoryResult } from './inventory';
import { jenkinsErrorLabel, jenkinsStatusLabel } from './messages';
import { JenkinsLogDocument } from './logDocument';
import { createJenkinsScope } from './lifecycle';
import { JenkinsGitError, readJenkinsGitContext, readJenkinsGitSnapshot } from './git';
import { aggregate, createRequest, normalizeRunStatus } from './model';
import { JenkinsStore } from './storage';
import { expireJenkinsRequest } from './shaTracking';
import { mapConcurrent, pollJenkinsRequest, safeJenkinsError, serverForUrl } from './tracking';
import { JenkinsJob, JenkinsJobProfile, JenkinsParameter, JenkinsRequest, JenkinsServer, JenkinsShaJob, TrackedJenkinsBuild, jenkinsLimits } from './types';
import { discoveryLabel, JenkinsTreeNode, JenkinsViewProvider } from '../providers/jenkinsViewProvider';

const COMMANDS = ['manageServers', 'run', 'trackSha', 'refresh', 'openRun', 'openLog', 'stopTracking', 'showRuns', 'clearResults'] as const;
const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('taskhub');

function numberSetting(key: string, fallback: number, min: number, max: number): number {
    try {
        const value = config().get<unknown>(key, fallback);
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
    } catch { return fallback; }
}

function quietMessage(show: () => Thenable<unknown>): void {
    try { void Promise.resolve(show()).catch(() => {}); } catch { /* The window may be closing. */ }
}

function errorMessage(error: unknown): string {
    if (error instanceof JenkinsGitError) {
        const messages: Record<JenkinsGitError['code'], string> = {
            notRepository: t('Git 저장소를 열어주세요.', 'Open a Git repository.'),
            detachedHead: t('브랜치를 체크아웃한 후 실행해주세요.', 'Check out a branch first.'),
            dirty: t('수정되었거나 추적되지 않은 파일이 있습니다. 빌드 요청 전 변경사항을 커밋·푸시하거나 보관하고, 불필요한 파일은 Git에서 제외해주세요.', 'Modified or untracked files exist. Before submitting a build, commit and push or stash changes, and ignore files that should not be tracked.'),
            noUpstream: t('브랜치의 upstream 원격을 설정하고 푸시해주세요.', 'Set an upstream remote and push the branch.'),
            notPushed: t('현재 SHA가 원격 브랜치와 다릅니다. 푸시 상태를 확인해주세요.', 'The current SHA differs from the remote branch. Check that it is pushed.'),
            remoteUnavailable: t('Git 원격 브랜치를 확인할 수 없습니다. 인증과 연결을 확인해주세요.', 'Cannot verify the remote Git branch. Check authentication and connectivity.'),
        };
        return messages[error.code];
    }
    return jenkinsErrorLabel(safeJenkinsError(error));
}

export function registerJenkins(context: vscode.ExtensionContext): vscode.Disposable {
    let controller: JenkinsController | undefined;
    const update = (): void => {
        const enabled = config().get<unknown>('experimental.jenkins.enabled', false) === true && vscode.workspace.isTrusted;
        if (enabled && !controller) {
            try { controller = new JenkinsController(context); }
            catch { quietMessage(() => vscode.window.showErrorMessage(t('Jenkins 기능을 초기화하지 못했습니다. 다른 TaskHub 기능은 계속 사용할 수 있습니다.', 'Jenkins could not be initialized. Other TaskHub features remain available.'))); }
        }
        if (!enabled && controller) { controller.dispose(); controller = undefined; }
    };
    const listener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('taskhub.experimental.jenkins.enabled')) { update(); }
    });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(update);
    update();
    return new vscode.Disposable(() => { listener.dispose(); trustListener.dispose(); controller?.dispose(); });
}

export class JenkinsController implements vscode.Disposable {
    private readonly store: JenkinsStore;
    private readonly requests: JenkinsRequest[];
    private readonly provider: JenkinsViewProvider;
    private readonly logDocument: JenkinsLogDocument;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly abort = new AbortController();
    private readonly inventory = new JenkinsInventory();
    private readonly guard = new JenkinsTransportGuard();
    private readonly tokenCache = new Map<string, Promise<string | undefined>>();
    private readonly requestAborts = new Map<string, AbortController>();
    private readonly busyCommands = new Set<string>();
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    private timer?: ReturnType<typeof setTimeout>;
    private polling?: Promise<void>;
    private disposed = false;
    private submitting = false;
    private lastDiscovery = 0;
    private pollRotation = 0;
    private httpWindow = { resetAt: 0, remaining: 0 };
    private pollFailureUntil = 0;
    constructor(context: vscode.ExtensionContext) {
        try {
            this.store = new JenkinsStore(context);
            const timeout = config().inspect<number>('jenkins.trackingTimeoutHours');
            const explicitTimeout = timeout?.workspaceFolderValue ?? timeout?.workspaceValue ?? timeout?.globalValue;
            this.requests = this.store.requests(explicitTimeout ?? 24);
            this.provider = new JenkinsViewProvider(() => this.requests, () => this.store.servers());
            this.disposables.push(this.provider);
            this.logDocument = new JenkinsLogDocument();
            this.disposables.push(this.logDocument, vscode.workspace.registerTextDocumentContentProvider('taskhub-jenkins-log', this.logDocument));
            this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => {
                if (document.uri.toString() === this.logDocument.uri.toString()) { this.logDocument.setContent(''); }
            }));
            this.disposables.push(vscode.window.createTreeView('mainView.jenkins', { treeDataProvider: this.provider, showCollapseAll: true }));
            this.disposables.push(context.secrets.onDidChange(() => { this.tokenCache.clear(); this.guard.reset(); this.inventory.clear(); }));
            for (const command of COMMANDS) {
                this.disposables.push(vscode.commands.registerCommand(`taskhub.jenkins.${command}`, async (node?: JenkinsTreeNode) => {
                    if (this.disposed || this.busyCommands.has(command)) { return; }
                    this.busyCommands.add(command);
                    try {
                        if (command === 'refresh') { await this.refreshManually(); }
                        else { await this[command](node); }
                    }
                    catch (error) { if (!this.disposed) { quietMessage(() => vscode.window.showErrorMessage(errorMessage(error))); } }
                    finally { this.busyCommands.delete(command); }
                }));
            }
            this.status.command = 'taskhub.jenkins.showRuns';
            this.status.name = t('Jenkins 테스트 결과', 'Jenkins test results');
            this.updateView();
            this.schedule(50);
        } catch (error) { this.dispose(); throw error; }
    }
    dispose(): void {
        this.disposed = true;
        if (this.timer) { clearTimeout(this.timer); }
        this.abort.abort();
        this.requestAborts.forEach(controller => controller.abort());
        this.tokenCache.clear();
        this.inventory.clear();
        this.status.dispose();
        this.disposables.forEach(item => item.dispose());
    }
    private schedule(delay?: number): void {
        if (this.disposed) { return; }
        if (this.timer) { clearTimeout(this.timer); }
        const active = this.requests.filter(request => !request.stopped && !request.settledAt && request.submission !== 'sending');
        if (!active.length) { return; }
        const next = Math.min(...active.map(request => Math.min(Math.max(request.nextPollAt ?? Date.now(), this.pollFailureUntil),
            request.deadlineAt ?? request.createdAt + jenkinsLimits.trackingTimeoutMs)));
        this.timer = setTimeout(() => { void this.refresh(); }, delay ?? Math.max(50, next - Date.now()));
    }
    private async client(server: JenkinsServer, signal = this.abort.signal, budget?: { remaining: number }): Promise<JenkinsClient> {
        if (this.disposed || signal.aborted) { throw new JenkinsClientError('CANCELLED'); }
        if (new URL(server.url).protocol === 'http:' && server.allowInsecureHttp !== true) { throw new JenkinsClientError('INSECURE_HTTP'); }
        const key = `${server.id}\n${server.url}\n${server.username}`;
        let pending = this.tokenCache.get(key);
        if (!pending) {
            pending = Promise.resolve(this.store.token(server));
            this.tokenCache.set(key, pending);
            void pending.catch(() => { this.tokenCache.delete(key); });
        }
        const tokenScope = createJenkinsScope([signal], 15000);
        let token: string | undefined;
        try { token = await abortable(pending, tokenScope.signal); } finally { tokenScope.dispose(); }
        if (!token) { throw new JenkinsClientError('INVALID_CREDENTIALS'); }
        return new JenkinsClient(server, { token, signal, guard: this.guard, budget, maxJobs: numberSetting('jenkins.discoveryJobLimit', 200, 20, 2000) });
    }
    private updateView(): void {
        if (this.disposed) { return; }
        this.provider.refresh();
        const active = this.requests.filter(request => !request.stopped && !request.settledAt).length;
        const failed = this.requests.filter(request => aggregate(request).observedResult === 'failed').length;
        const complete = this.requests.filter(request => request.settledAt).length;
        this.status.text = `$(beaker) Jenkins ${active}${failed ? ` · $(error) ${failed}` : ''}`;
        this.status.tooltip = t(`조회 중 ${active}개 · 실패 관측 ${failed}개 · 조회 종료 ${complete}개 · 클릭하여 결과 보기`,
            `${active} active · ${failed} with failures · ${complete} settled · click to view results`);
        this.status.accessibilityInformation = { label: this.status.tooltip };
        this.status.show();
    }
    private reserveRuns(count: number): boolean {
        let retained = this.requests.reduce((sum, request) => sum + request.runs.length, count);
        const oldest = this.requests.filter(request => request.stopped || request.settledAt).sort((a, b) => a.createdAt - b.createdAt);
        for (const request of oldest) {
            if (retained <= jenkinsLimits.maxRetainedRuns) { break; }
            retained -= request.runs.length;
            this.requests.splice(this.requests.indexOf(request), 1);
        }
        return retained <= jenkinsLimits.maxRetainedRuns;
    }
    private async persist(): Promise<void> {
        const limit = numberSetting('jenkins.historyLimit', 50, 10, 500);
        const active = this.requests.filter(request => !request.stopped && !request.settledAt);
        const history = this.requests.filter(request => request.stopped || request.settledAt).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        let runs = active.reduce((count, request) => count + request.runs.length, 0);
        const retained = history.filter(request => { runs += request.runs.length; return runs <= jenkinsLimits.maxRetainedRuns; });
        this.requests.splice(0, this.requests.length, ...[...active, ...retained].sort((a, b) => b.createdAt - a.createdAt));
        const snapshotIds = new Set(this.requests.map(request => request.id));
        const saved = await this.store.saveRequests(this.requests, limit);
        const savedIds = new Set(saved.map(request => request.id));
        for (let index = this.requests.length - 1; index >= 0; index--) {
            const request = this.requests[index];
            if (snapshotIds.has(request.id) && !savedIds.has(request.id)) { this.requests.splice(index, 1); continue; }
            const compacted = saved.find(item => item.id === request.id && item.error === 'JENKINS_STORAGE_LIMIT' && item.stopped);
            if (compacted) { Object.assign(request, compacted); }
        }
    }
    private async refreshManually(): Promise<void> {
        // Let the current round finish before releasing its limit marker. Automatic
        // refresh keeps the marker, and manual retry does not bypass transport backoff.
        if (this.polling) { await this.polling; }
        if (this.disposed) { return; }
        this.inventory.retryLimited();
        this.lastDiscovery = 0;
        await this.refresh();
        if (this.disposed) { return; }
        const active = this.requests.filter(request => !request.stopped && !request.settledAt && request.submission !== 'sending');
        const next = active.length ? Math.min(...active.map(request => Math.max(request.nextPollAt ?? Date.now(), this.pollFailureUntil))) : undefined;
        quietMessage(() => vscode.window.showInformationMessage(next === undefined
            ? t('저장된 결과를 갱신했습니다. 예약된 자동 조회가 없습니다.', 'Saved results refreshed. No automatic checks are scheduled.')
            : t(`결과를 갱신했습니다. 다음 자동 조회: ${new Date(next).toLocaleString()}`, `Results refreshed. Next automatic check: ${new Date(next).toLocaleString()}`)));
    }
    async refresh(): Promise<void> {
        if (this.disposed) { return; }
        if (this.polling) { return this.polling; }
        this.polling = this.poll().catch(async error => {
            if (!this.disposed) { this.pollFailureUntil = Date.now() + jenkinsLimits.pollIntervalMs; this.status.tooltip = errorMessage(error); }
        }).finally(() => { this.polling = undefined; this.schedule(); });
        return this.polling;
    }
    private async poll(): Promise<void> {
        const now = Date.now();
        // Expire before credentials, discovery or any HTTP. Restart/manual refresh cannot revive it.
        for (const request of [...this.requests]) {
            if (!request.stopped && !request.settledAt && expireJenkinsRequest(request, now)) { await this.notify(request); }
        }
        const due = this.requests.filter(request => !request.stopped && !request.settledAt && request.submission !== 'sending' && (request.nextPollAt ?? 0) <= now);
        if (!due.length) { await this.persist(); this.updateView(); return; }
        const start = this.pollRotation++ % due.length;
        const active = [...due.slice(start), ...due.slice(0, start)];
        if (now >= this.httpWindow.resetAt) {
            this.httpWindow = { resetAt: now + jenkinsLimits.pollIntervalMs, remaining: jenkinsLimits.pollHttpBudget };
        }
        const previousPolls = new Map(active.map(request => [request.id, request.nextPollAt]));
        for (const request of active) {
            request.nextPollAt = this.httpWindow.remaining > 0
                ? now + (now - request.createdAt >= 3600000 ? 2 : 1) * jenkinsLimits.pollIntervalMs : this.httpWindow.resetAt;
        }
        // Persist the cadence before I/O so reloading the window does not cause an extra burst.
        try { await this.persist(); }
        catch (error) {
            for (const request of active) { request.nextPollAt = previousPolls.get(request.id); }
            throw error;
        }
        this.pollFailureUntil = 0;
        const budget = this.httpWindow;
        if (budget.remaining <= 0) { this.updateView(); return; }
        const reads = new Map<string, Promise<unknown>>();
        const read = <T>(key: string, fetch: () => Promise<T>): Promise<T> => {
            const existing = reads.get(key);
            if (existing) {
                return (existing as Promise<T>).catch(error => {
                    // A peer's local quota/cancellation cannot consume this request's turn.
                    if (!(error instanceof JenkinsClientError) || !['REQUEST_LIMIT', 'CANCELLED'].includes(error.code)) { throw error; }
                    if (reads.get(key) === existing) { reads.delete(key); }
                    return read(key, fetch);
                });
            }
            if (!reads.has(key)) {
                const pending = fetch();
                reads.set(key, pending);
                void pending.catch(error => {
                    if (error instanceof JenkinsClientError && ['REQUEST_LIMIT', 'CANCELLED'].includes(error.code)
                        && reads.get(key) === pending) { reads.delete(key); }
                });
            }
            return reads.get(key)! as Promise<T>;
        };
        const legacy = active.filter(request => !request.shaTracking);
        const discover = legacy.some(request => request.root.buildUrl) && now - this.lastDiscovery >= numberSetting('jenkins.discoveryIntervalSeconds', 60, 15, 600) * 1000;
        let inventory: JenkinsInventoryResult | undefined;
        if (discover) {
            this.lastDiscovery = now;
            const scope = createJenkinsScope([this.abort.signal], jenkinsLimits.requestDeadlineMs);
            const inventoryBudget = { remaining: Math.min(40, budget.remaining) };
            const initialBudget = inventoryBudget.remaining;
            try {
                inventory = await this.inventory.collect({ servers: this.store.servers(), requests: legacy,
                    client: server => this.client(server, scope.signal, inventoryBudget), signal: scope.signal,
                    jobLimit: numberSetting('jenkins.discoveryJobLimit', 200, 20, 2000),
                    recentBuildLimit: numberSetting('jenkins.recentBuildLimit', 20, 5, 200) });
            } finally { budget.remaining -= initialBudget - inventoryBudget.remaining; scope.dispose(); }
        }
        // Share this controller's automatic HTTP window fairly across due observations.
        // Explicit job selection/baseline commands have their own bounded user-operation budget.
        const allowance = Math.max(1, Math.ceil(budget.remaining / active.length));
        await mapConcurrent(active, async request => {
            if (this.disposed || request.stopped || request.settledAt || !this.requests.includes(request)) { return; }
            if (expireJenkinsRequest(request)) { await this.notify(request); return; }
            const operation = new AbortController();
            this.requestAborts.set(request.id, operation);
            const scope = createJenkinsScope([this.abort.signal, operation.signal], Math.max(1, Math.min(jenkinsLimits.requestDeadlineMs,
                (request.deadlineAt ?? request.createdAt + jenkinsLimits.trackingTimeoutMs) - Date.now())));
            let remaining = allowance;
            let used = 0;
            const requestBudget = {
                get remaining(): number { return Math.min(remaining, budget.remaining); },
                set remaining(value: number) {
                    const spent = Math.max(0, this.remaining - value);
                    remaining -= spent; budget.remaining -= spent; used += spent;
                },
            };
            try {
                await pollJenkinsRequest(request, { servers: this.store.servers(), client: server => this.client(server, scope.signal, request.shaTracking ? requestBudget : budget), discover, signal: scope.signal, inventory, read,
                    reserveRuns: count => this.reserveRuns(count),
                    recentBuildLimit: numberSetting('jenkins.recentBuildLimit', 20, 5, 200),
                    manifestArtifact: config().get<string>('jenkins.manifestArtifact', 'taskhub-jenkins-runs.json') });
            } catch (error) {
                if (!this.disposed && !request.stopped) {
                    request.error = scope.signal.aborted ? 'JENKINS_POLL_DEADLINE' : safeJenkinsError(error);
                    request.discovery.complete = false;
                }
            } finally {
                if (request.shaTracking && !used && budget.remaining <= 0 && !request.stopped && !request.settledAt) {
                    request.nextPollAt = budget.resetAt;
                }
                scope.dispose(); this.requestAborts.delete(request.id);
            }
            if (!this.disposed && this.requests.includes(request)) {
                expireJenkinsRequest(request);
                if (request.settledAt || (!request.stopped && !scope.signal.aborted)) { await this.notify(request); }
            }
            this.updateView();
        }, 2);
        if (!this.disposed) { await this.persist(); this.updateView(); }
    }
    private async notify(request: JenkinsRequest): Promise<void> {
        const root = request.runs.find(run => run.correlation === 'root');
        const summary = aggregate(request);
        const key = request.settledAt ? 'complete' : root && !root.building && root.result && !root.error ? 'root' : undefined;
        if (!key || request.notified[key]) { return; }
        request.notified[key] = true;
        try { await this.persist(); } catch (error) { delete request.notified[key]; throw error; }
        const preference = config().get<string>('jenkins.notifications', 'all');
        const failed = request.outcome === 'timeout' || request.outcome === 'incomplete' || summary.observedResult === 'failed' || summary.observedResult === 'nonpass';
        if (preference === 'off' || (preference === 'failures' && !failed) || this.disposed) { return; }
        const label = key === 'complete' ? t('전체 테스트', 'All tracked tests') : t('Jenkins 대표 결과 (전체 범위 미확인)', 'Jenkins representative result (coverage unverified)');
        const resultStatus = summary.observedResult === 'failed' ? 'failed' : request.outcome === 'timeout' ? 'timedout' : request.outcome === 'incomplete' ? 'incomplete'
            : summary.allPassed ? 'passed' : summary.observedResult === 'passed' ? 'observedPassed' : 'nonpass';
        const expiredFailure = request.outcome === 'timeout' && resultStatus === 'failed' ? ` · ${jenkinsStatusLabel('timedout')}` : '';
        const message = `${request.branch}@${request.sha.slice(0, 8)} · ${label}: ${key === 'complete' ? jenkinsStatusLabel(resultStatus) + expiredFailure : jenkinsStatusLabel(root ? normalizeRunStatus(root, request.sha) : 'unknown')}`;
        const open = t('결과 보기', 'View results');
        const result = failed ? vscode.window.showWarningMessage(message, open) : vscode.window.showInformationMessage(message, open);
        void Promise.resolve(result).then(async choice => { if (choice === open && !this.disposed) { await this.openRun({ kind: 'request', label: '', request }); } }).catch(() => { /* A closed/disposed notification must not leak a rejected promise. */ });
    }
    async manageServers(): Promise<void> {
        const add = { label: t('$(add) 서버 추가', '$(add) Add server'), server: undefined as JenkinsServer | undefined };
        const selected = await vscode.window.showQuickPick([add, ...this.store.servers().map(server => ({ label: server.name, description: server.url, server }))], { title: t('Jenkins 서버 관리', 'Manage Jenkins servers') });
        if (!selected) { return; }
        if (!selected.server) { await this.editServer(); return; }
        const server = selected.server;
        const action = await vscode.window.showQuickPick([
            { label: t('연결 확인', 'Verify connection'), id: 'verify' },
            { label: t('주소·계정·토큰 수정', 'Edit URL, account and token'), id: 'edit' },
            { label: t('사내 CA 인증서 지정', 'Set company CA certificate'), id: 'ca' },
            { label: t('서버 삭제', 'Remove server'), id: 'remove' },
        ], { title: server.name });
        if (action?.id === 'verify') {
            const result = await this.withOperation(t('Jenkins 연결 확인 중', 'Verifying Jenkins connection'), async signal => (await this.client(server, signal)).verify());
            if (!result.authenticated) { throw new JenkinsClientError('AUTH_REQUIRED'); }
            quietMessage(() => vscode.window.showInformationMessage(t(`${server.name}: 연결되었습니다.`, `${server.name}: connected.`)));
        } else if (action?.id === 'edit') { await this.editServer(server); }
        else if (action?.id === 'ca') {
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: t('PEM 인증서 선택', 'Select PEM certificate'), filters: { PEM: ['pem', 'crt'] } });
            if (files?.[0]) { await this.store.saveServer({ ...server, caFile: files[0].fsPath }); }
        } else if (action?.id === 'remove') {
            const remove = t('삭제', 'Remove');
            if (await vscode.window.showWarningMessage(t(`${server.name} 연결 설정을 삭제할까요? 원격 빌드는 계속 실행됩니다.`, `Remove ${server.name}? Remote builds will keep running.`), { modal: true }, remove) === remove) {
                await this.store.removeServer(server.id);
                this.tokenCache.clear(); this.requestAborts.forEach(operation => operation.abort());
            }
        }
        this.updateView();
    }
    private async editServer(existing?: JenkinsServer): Promise<void> {
        const name = await vscode.window.showInputBox({ title: t('Jenkins 서버 이름', 'Jenkins server name'), value: existing?.name, ignoreFocusOut: true });
        if (!name?.trim()) { return; }
        const url = await vscode.window.showInputBox({ title: t('Jenkins 기본 URL', 'Jenkins base URL'), value: existing?.url,
            prompt: t('예: https://10.0.0.1:8443/jenkins/ · HTTP는 암호화되지 않습니다. HTTPS를 권장합니다.', 'Example: https://10.0.0.1:8443/jenkins/ · HTTP is unencrypted. HTTPS is recommended.'),
            ignoreFocusOut: true, validateInput: value => validateJenkinsServerUrl(value) ? t('유효한 HTTP(S) 기본 URL을 입력해주세요. 인증정보·쿼리는 제외합니다.', 'Enter an HTTP(S) base URL without credentials or a query.') : undefined });
        if (!url) { return; }
        const normalizedUrl = normalizeJenkinsServerUrl(url);
        const allowInsecureHttp = new URL(normalizedUrl).protocol === 'http:';
        if (allowInsecureHttp && !(existing?.url === normalizedUrl && existing.allowInsecureHttp === true)) {
            const allow = t('평문 전송 허용', 'Allow unencrypted transport');
            if (await vscode.window.showWarningMessage(t(
                `${normalizedUrl}에는 API 토큰과 테스트 데이터가 암호화 없이 전송됩니다. 사내 정책에서 허용하는 연결인지 확인해주세요. HTTPS 사용을 권장합니다.`,
                `${normalizedUrl} will receive your API token and test data without encryption. Confirm that company policy permits this connection. HTTPS is recommended.`), { modal: true }, allow) !== allow) { return; }
        }
        const username = await vscode.window.showInputBox({ title: t('Jenkins 사용자 이름', 'Jenkins username'), value: existing?.username, ignoreFocusOut: true });
        if (!username?.trim()) { return; }
        const keepToken = existing?.url === normalizedUrl && existing.username === username.trim();
        const token = await vscode.window.showInputBox({ title: t('Jenkins API 토큰', 'Jenkins API token'), password: true, ignoreFocusOut: true,
            prompt: keepToken ? t('빈 값으로 확인하면 기존 토큰을 유지합니다. Esc는 서버 수정을 취소합니다.', 'Submit an empty value to keep the existing token. Esc cancels server edits.')
                : t('VS Code 보안 저장소에 보관합니다. 새 서버·계정에는 토큰이 필요합니다.', 'Stored in VS Code SecretStorage. A new server or account requires a token.'),
            validateInput: value => !keepToken && !value ? t('API 토큰을 입력해주세요.', 'Enter an API token.') : undefined });
        if (token === undefined) {
            quietMessage(() => vscode.window.showInformationMessage(t('서버 수정을 취소했습니다. 변경사항은 저장하지 않았습니다.', 'Server edits cancelled. Changes were not saved.'))); return;
        }
        if (!token && !keepToken) { return; }
        const server = { id: existing?.id ?? randomUUID(), name: name.trim(), url: normalizedUrl, username: username.trim(), caFile: existing?.caFile, ...(allowInsecureHttp ? { allowInsecureHttp: true } : {}) };
        if (this.disposed) { return; }
        await this.store.saveServer(server, token || undefined);
        this.inventory.clear();
        this.tokenCache.clear(); this.guard.reset(server.url);
        this.requestAborts.forEach(operation => operation.abort());
        quietMessage(() => vscode.window.showInformationMessage(t('서버를 저장했습니다. 서버 관리에서 연결 확인 또는 CA 인증서 지정을 할 수 있습니다.', 'Server saved. Use Manage Servers to verify the connection or set a CA certificate.')));
    }
    private async withOperation<T>(title: string, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, cancellation) => {
            const operation = new AbortController();
            const subscription = cancellation.onCancellationRequested(() => operation.abort());
            const scope = createJenkinsScope([this.abort.signal, operation.signal, parent], 30000);
            if (cancellation.isCancellationRequested) { operation.abort(); }
            try { return await run(scope.signal); }
            catch (error) { if (scope.signal.aborted) { throw new JenkinsClientError('CANCELLED'); } throw error; }
            finally { subscription.dispose(); scope.dispose(); }
        });
    }
    async run(): Promise<void> {
        if (this.submitting) { return; }
        this.submitting = true;
        try { await this.submit(); } finally { this.submitting = false; }
    }
    private async submit(): Promise<void> {
        if (this.disposed) { return; }
        if (this.requests.filter(request => !request.stopped && !request.settledAt).length >= jenkinsLimits.maxActiveRequests) {
            quietMessage(() => vscode.window.showWarningMessage(t('동시에 추적할 수 있는 요청은 20개입니다. 기존 요청의 추적을 중지한 뒤 다시 실행해주세요.', 'Up to 20 requests can be tracked concurrently. Stop tracking an existing request first.'))); return;
        }
        const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
        if (folders.length === 0) {
            const open = t('폴더 열기', 'Open Folder');
            const selected = await vscode.window.showInformationMessage(t('테스트할 Git 프로젝트 폴더를 먼저 열어주세요.', 'Open the Git project folder you want to test first.'), open);
            if (selected === open && !this.disposed) { await vscode.commands.executeCommand('workbench.action.files.openFolder'); }
            return;
        }
        let servers = this.store.servers();
        if (servers.length === 0) {
            await this.editServer();
            servers = this.store.servers();
            if (servers.length === 0 || this.disposed) { return; }
        }
        const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, folder: item })), { title: t('Git 작업 폴더', 'Git workspace folder') }))?.folder;
        if (!folder) { return; }
        const server = (await vscode.window.showQuickPick(servers.map(item => ({ label: item.name, description: item.url, server: item })), { title: t('대표 빌드를 실행할 서버', 'Server for the representative build') }))?.server;
        if (!server) { return; }
        const snapshot = await this.withOperation(t('Git 브랜치와 원격 커밋 확인 중', 'Checking Git branch and remote commit'), signal => readJenkinsGitSnapshot(folder.uri.fsPath, signal));
        const client = await this.client(server);
        const jobs = await this.withOperation(t('Jenkins 작업 탐색 중', 'Discovering Jenkins jobs'), async signal => (await this.client(server, signal)).listJobs());
        if (!jobs.some(job => job.buildable)) {
            quietMessage(() => vscode.window.showInformationMessage(t('실행 가능한 작업이 없습니다. 서버의 job 설정과 조회 권한을 확인해주세요.', 'No buildable jobs found. Check the server’s job configuration and read permissions.'))); return;
        }
        const chosen = await vscode.window.showQuickPick(jobs.filter(job => job.buildable).map(job => ({ label: job.fullName || job.name, job })), { title: t('실행할 Jenkins 작업', 'Jenkins job to run'), matchOnDescription: true });
        if (!chosen) { return; }
        const job = await client.getJob(chosen.job.url);
        const profile = await this.parametersProfile(server, job);
        if (!profile) { return; }
        const testJobs = await this.selectTestJobs(profile, job);
        if (!testJobs) { return; }
        const remoteBranch = snapshot.remoteRef.slice('refs/heads/'.length);
        const request = createRequest({ ...snapshot, remoteBranch, root: { serverId: server.id, jobUrl: job.url }, shaParameter: profile.shaParameter, requestIdParameter: profile.requestIdParameter });
        request.shaTracking = { jobs: testJobs, cursor: 0, readOnly: false };
        const parameters: Record<string, string> = Object.create(null);
        for (const parameter of job.parameters ?? []) {
            const mapped = parameter.name === profile.branchParameter ? remoteBranch : parameter.name === profile.shaParameter ? snapshot.sha : parameter.name === profile.requestIdParameter ? request.id : undefined;
            const value = mapped ?? await this.parameterValue(parameter);
            if (value === undefined) { return; }
            if (parameter.choices && !parameter.choices.includes(value)) { throw new Error('JENKINS_PARAMETER_CHOICE'); }
            parameters[parameter.name] = value;
        }
        const start = t('테스트 요청', 'Start tests');
        const pin = profile.shaParameter ? t(`SHA 파라미터: ${profile.shaParameter}`, `SHA parameter: ${profile.shaParameter}`) : t('SHA 파라미터 없음: Jenkins SCM 설정에 따라 체크아웃됩니다.', 'No SHA parameter: checkout follows the Jenkins SCM configuration.');
        const scopeSummary = t(`조회 범위: 대표 작업 ${job.fullName} 포함 ${testJobs.length}개 · 최대 ${numberSetting('jenkins.trackingTimeoutHours', 2, 1, 168)}시간`,
            `Observation scope: ${testJobs.length} tests including representative job ${job.fullName} · up to ${numberSetting('jenkins.trackingTimeoutHours', 2, 1, 168)} hours`);
        if (await vscode.window.showInformationMessage(`${server.name} · ${job.fullName}\n${snapshot.branch}@${snapshot.sha}\n${t('전송할 원격 브랜치', 'Remote branch to submit')}: ${remoteBranch}\n${pin}\n${scopeSummary}`, { modal: true }, start) !== start) { return; }
        if (this.disposed) { return; }
        // Capture build counters before POST. Previous executions of the same SHA cannot
        // satisfy a newly submitted test request, even if the server clock differs.
        await this.withOperation(t('테스트 시작 전 빌드 번호 확인 중', 'Checking build numbers before submission'), async signal => {
            const budget = { remaining: 150 };
            for (const target of testJobs) {
                const targetServer = this.store.servers().find(item => item.id === target.serverId);
                if (!targetServer) { throw new JenkinsClientError('INVALID_PARAMETER'); }
                const builds = await (await this.client(targetServer, signal, budget)).listRecentBuilds(target.jobUrl, 1);
                target.afterBuild = Math.max(0, ...builds.map(build => build.number));
            }
        });
        // Recheck after dialogs and baseline reads, immediately before committing the request.
        const current = await this.withOperation(t('전송 전 Git 상태 재확인 중', 'Rechecking Git before submission'), signal => readJenkinsGitSnapshot(snapshot.repoPath, signal));
        if (current.branch !== snapshot.branch || current.sha !== snapshot.sha || current.remote !== snapshot.remote || current.remoteRef !== snapshot.remoteRef) { throw new JenkinsGitError('notPushed'); }
        if (this.disposed) { return; }
        this.startTracking(request);
        request.submission = 'sending';
        this.requests.unshift(request);
        const submission = new AbortController();
        this.requestAborts.set(request.id, submission);
        const retained = (): boolean => !this.disposed && this.requests.includes(request) && !request.stopped;
        try {
            try { await this.persist(); }
            catch (error) {
                const index = this.requests.indexOf(request);
                if (index >= 0) { this.requests.splice(index, 1); }
                throw error;
            }
            this.updateView();
            if (!retained()) { return; }
            try {
                const queued = await this.withOperation(t('Jenkins에 테스트 요청 전송 중 · 취소해도 빌드가 실행될 수 있습니다', 'Submitting tests to Jenkins · cancellation may not stop the build'), async signal => {
                    const sendingClient = await this.client(server, signal);
                    if (!retained() || signal.aborted) { throw new JenkinsClientError('CANCELLED'); }
                    return sendingClient.trigger(job.url, parameters);
                }, submission.signal);
                if (!retained()) { return; }
                request.root.queueUrl = queued.queueUrl;
                delete request.submission;
                delete request.error;
            } catch (error) {
                if (!retained()) { return; }
                request.submission = 'unconfirmed';
                request.error = `JENKINS_SUBMISSION_UNCONFIRMED_${safeJenkinsError(error)}`;
                quietMessage(() => vscode.window.showWarningMessage(t('요청 수락 여부를 확인할 수 없습니다. 빌드 요청은 재전송하지 않고 선택한 SHA의 결과 조회만 계속합니다. 다시 실행하기 전 Jenkins 대기열을 확인해주세요.', 'Build acceptance could not be confirmed. Only SHA result checks will continue; the build request will not be resent. Check the Jenkins queue before starting another build.')));
            }
            await this.persist(); this.updateView();
        } finally {
            if (this.requestAborts.get(request.id) === submission) { this.requestAborts.delete(request.id); }
            this.schedule();
        }
        if (retained()) { await this.refresh(); }
    }

    private startTracking(request: JenkinsRequest): void {
        request.createdAt = Date.now();
        request.deadlineAt = request.createdAt + numberSetting('jenkins.trackingTimeoutHours', 2, 1, 168) * 3600000;
        delete request.nextPollAt;
    }

    private async selectTestJobs(profile: JenkinsJobProfile, root?: JenkinsJob): Promise<JenkinsShaJob[] | undefined> {
        const servers = this.store.servers();
        let selected: JenkinsShaJob[] | undefined;
        if (profile.testJobs?.length && profile.testJobs.every(job => servers.some(server =>
            server.id === job.serverId && serverForUrl([server], job.jobUrl)))) {
            const reuse = await vscode.window.showQuickPick([
                { label: t(`저장된 테스트 ${profile.testJobs.length}개 사용`, `Use ${profile.testJobs.length} saved tests`), reuse: true },
                { label: t('테스트 목록 다시 선택', 'Select tests again'), reuse: false },
            ], { title: t('이번 SHA의 전체 테스트 범위', 'Complete test scope for this SHA') });
            if (!reuse) { return; }
            if (reuse.reuse) { selected = profile.testJobs; }
        }
        if (!selected) {
            const available = await this.withOperation(t('서버별 테스트 목록 조회 중', 'Loading tests from registered servers'), async signal => {
                const failures: string[] = [];
                // Every server gets its own share before discovery begins. A slow or
                // overly broad server cannot spend a healthy server's time or HTTP quota.
                const timeout = Math.min(15000, Math.floor(28000 / Math.ceil(servers.length / 4)));
                const batches = await mapConcurrent(servers, async server => {
                    const scope = createJenkinsScope([signal], timeout);
                    const budget = { remaining: Math.floor(150 / servers.length) };
                    try {
                        const inventory = await (await this.client(server, scope.signal, budget)).listJobs();
                        return inventory.filter(item => item.buildable).map(job => ({
                            label: `${server.name} · ${job.fullName}`, description: job.url,
                            job: { serverId: server.id, jobUrl: job.url, name: job.fullName } as JenkinsShaJob,
                            picked: profile.testJobs?.some(item => item.serverId === server.id && item.jobUrl === job.url)
                                ?? (profile.serverId === server.id && root?.url === job.url),
                        }));
                    } catch (error) {
                        if (signal.aborted) { throw error; }
                        failures.push(`${server.name}: ${jenkinsErrorLabel(scope.signal.aborted ? 'TIMEOUT' : safeJenkinsError(error))}`);
                        return [];
                    } finally { scope.dispose(); }
                }, 4, signal);
                if (failures.length) {
                    quietMessage(() => vscode.window.showWarningMessage(t(
                        `일부 서버의 테스트 목록을 조회하지 못했습니다. 조회된 서버에서 선택할 수 있습니다. ${failures.join(' · ')}`,
                        `Some test lists could not be loaded. You can select tests from the available servers. ${failures.join(' · ')}`)));
                }
                return batches.flat();
            });
            if (!available.length) { throw new JenkinsClientError('NOT_FOUND'); }
            const picks = await vscode.window.showQuickPick(available, { canPickMany: true,
                title: t('이번 SHA에서 실행할 테스트 전체 선택', 'Select all tests expected for this SHA'),
                placeHolder: t('선택한 목록 전체를 기준으로 완료를 판단합니다. 실행하지 않을 job은 제외하세요.', 'Completion is based on this entire selection. Exclude jobs that will not run.') });
            if (!picks?.length) { return; }
            selected = picks.map(item => item.job);
            const shaParameter = await vscode.window.showInputBox({ title: t('테스트 job의 SHA 파라미터 이름 (선택)', 'SHA parameter name on test jobs (optional)'),
                value: profile.shaParameter ?? profile.testJobs?.[0]?.shaParameter ?? '',
                prompt: t('Git checkout 정보가 없는 job에서 사용합니다. 모든 선택 job에 같은 이름이 전달될 때 입력하세요.', 'Used for jobs without Git checkout data. Enter it only when the same parameter name is passed to the selected jobs.'),
                validateInput: value => value.length > 256 ? t('256자 이내로 입력해주세요.', 'Use at most 256 characters.') : undefined });
            if (shaParameter === undefined) { return; }
            selected = selected.map(job => ({ ...job, shaParameter: shaParameter.trim() || undefined }));
        }
        selected = selected.map(job => ({ serverId: job.serverId, jobUrl: job.jobUrl, name: job.name, shaParameter: job.shaParameter }));
        if (root && !selected.some(job => job.serverId === profile.serverId && job.jobUrl === root.url)) {
            selected.unshift({ serverId: profile.serverId, jobUrl: root.url, name: root.fullName, shaParameter: profile.shaParameter });
        }
        if (selected.length > jenkinsLimits.maxSelectedJobs) { throw new JenkinsClientError('DISCOVERY_LIMIT'); }
        profile.testJobs = selected;
        await this.store.saveProfile(profile);
        return selected.map(job => ({ ...job }));
    }

    /** Explicit read-only observation, including a new attempt after completion or timeout. */
    async trackSha(node?: JenkinsTreeNode): Promise<void> {
        if (this.submitting || this.disposed) { return; }
        this.submitting = true;
        try {
            if (this.requests.filter(request => !request.stopped && !request.settledAt).length >= jenkinsLimits.maxActiveRequests) {
                throw new Error('JENKINS_ACTIVE_LIMIT');
            }
            const previous = node?.request && this.requests.includes(node.request) ? node.request : undefined;
            let snapshot: Pick<JenkinsRequest, 'repoPath' | 'repoRemote' | 'branch' | 'sha'>;
            if (previous) { snapshot = previous; }
            else {
                const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
                if (!folders.length) {
                    quietMessage(() => vscode.window.showInformationMessage(t('Git 프로젝트 폴더를 먼저 열어주세요.', 'Open a Git project folder first.'))); return;
                }
                const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder }))))?.folder;
                if (!folder) { return; }
                snapshot = await this.withOperation(t('Git 브랜치와 SHA 확인 중', 'Reading Git branch and SHA'), signal => readJenkinsGitContext(folder.uri.fsPath, signal));
                const sha = await vscode.window.showInputBox({ title: t('조회할 전체 커밋 SHA', 'Full commit SHA to observe'), value: snapshot.sha,
                    validateInput: value => /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? undefined : t('전체 SHA를 입력해주세요.', 'Enter the full commit SHA.') });
                if (!sha) { return; }
                snapshot = { ...snapshot, sha: sha.toLowerCase() };
            }
            if (!this.store.servers().length) { await this.editServer(); }
            if (!this.store.servers().length || this.disposed) { return; }
            const profile = previous?.shaTracking ? { serverId: '__sha__', jobUrl: snapshot.repoPath, testJobs: previous.shaTracking.jobs }
                : this.store.profile('__sha__', snapshot.repoPath) ?? { serverId: '__sha__', jobUrl: snapshot.repoPath };
            const jobs = await this.selectTestJobs(profile);
            if (!jobs || this.disposed) { return; }
            const request = createRequest({ repoPath: snapshot.repoPath, repoRemote: snapshot.repoRemote,
                branch: snapshot.branch, sha: snapshot.sha, root: { serverId: jobs[0].serverId, jobUrl: jobs[0].jobUrl } });
            request.shaTracking = { jobs, cursor: 0, readOnly: true };
            this.startTracking(request);
            this.requests.unshift(request);
            try { await this.persist(); } catch (error) { this.requests.splice(this.requests.indexOf(request), 1); throw error; }
            this.updateView();
            await this.refresh();
        } finally { this.submitting = false; }
    }

    async clearResults(node?: JenkinsTreeNode): Promise<void> {
        const targets = node?.request ? this.requests.filter(request => request === node.request) : [...this.requests];
        if (!targets.length) { return; }
        if (!node?.request) {
            const active = targets.filter(request => !request.stopped && !request.settledAt).length;
            const clear = t('전체 비우기', 'Clear all');
            if (await vscode.window.showWarningMessage(t(
                `Jenkins 결과 ${targets.length}개를 모두 지울까요? 진행 중인 조회 ${active}개도 중지합니다. Jenkins 빌드는 계속 실행됩니다.`,
                `Clear all ${targets.length} Jenkins results? This also stops ${active} active observations. Jenkins builds will continue running.`),
            { modal: true }, clear) !== clear) { return; }
        }
        for (const request of targets) { request.stopped = true; this.requestAborts.get(request.id)?.abort(); }
        // Finish in-flight persistence before deleting so late responses cannot resurrect rows.
        if (this.polling) { await this.polling; }
        if (this.disposed) { return; }
        const ids = new Set(targets.map(request => request.id));
        this.requests.splice(0, this.requests.length, ...this.requests.filter(request => !ids.has(request.id)));
        await this.persist(); this.updateView(); this.schedule();
    }
    private async parametersProfile(server: JenkinsServer, job: JenkinsJob): Promise<JenkinsJobProfile | undefined> {
        const parameters = job.parameters ?? [];
        if (parameters.some(parameter => !/(?:String|Text|Choice|Boolean)ParameterDefinition$/.test(parameter.type))) {
            quietMessage(() => vscode.window.showWarningMessage(t('이 작업에는 지원하지 않는 파라미터(파일·비밀번호 등)가 있습니다. Jenkins 웹에서 실행해주세요.', 'This job has unsupported parameters (such as files or passwords). Run it in Jenkins.')));
            return undefined;
        }
        const old = this.store.profile(server.id, job.url);
        if (old && [old.branchParameter, old.shaParameter, old.requestIdParameter].every(name =>
            !name || parameters.some(parameter => parameter.name === name))) {
            const use = await vscode.window.showQuickPick([
                { label: t('저장된 파라미터 연결 사용', 'Use saved parameter mapping'), id: 'reuse',
                    description: t(`브랜치: ${old.branchParameter ?? '—'} · SHA: ${old.shaParameter ?? '—'} · ID: ${old.requestIdParameter ?? '—'}`, `Branch: ${old.branchParameter ?? '—'} · SHA: ${old.shaParameter ?? '—'} · ID: ${old.requestIdParameter ?? '—'}`) },
                { label: t('파라미터 연결 다시 설정', 'Configure parameter mapping again'), id: 'configure' },
            ], { title: job.fullName });
            if (!use) { return undefined; }
            if (use.id === 'reuse') { return old; }
        }
        const profile: JenkinsJobProfile = { serverId: server.id, jobUrl: job.url };
        const assigned = new Set<string>();
        const mappings: Array<{ key: 'branchParameter' | 'shaParameter' | 'requestIdParameter'; title: string }> = [
            { key: 'branchParameter', title: t('브랜치 파라미터 선택 (이름은 작업마다 다름)', 'Select the branch parameter (job-specific name)') },
            { key: 'shaParameter', title: t('정확한 커밋 SHA 파라미터 선택', 'Select the exact commit SHA parameter') },
            { key: 'requestIdParameter', title: t('요청 ID 파라미터 (하위 작업에 전파되는 경우만)', 'Request ID parameter (only if propagated to child jobs)') },
        ];
        for (const mapping of mappings) {
            if (parameters.length === 0) { break; }
            const entries = parameters.filter(parameter => !assigned.has(parameter.name) && !parameter.type.endsWith('BooleanParameterDefinition')).map(parameter => ({
                label: parameter.name, name: parameter.name,
                description: t(`유형: ${parameter.type} · 기본값: ${String(parameter.defaultValue ?? '—').slice(0, 80)}`, `Type: ${parameter.type} · Default: ${String(parameter.defaultValue ?? '—').slice(0, 80)}`),
            }));
            const choices = [{ label: t('사용하지 않음', 'Not used'), name: '', description: '' }, ...entries];
            const previousIndex = choices.findIndex(choice => choice.name === old?.[mapping.key]);
            if (previousIndex > 0) { choices.unshift(...choices.splice(previousIndex, 1)); }
            const choice = await vscode.window.showQuickPick(choices, { title: mapping.title });
            if (!choice) { return undefined; }
            if (choice.name) { profile[mapping.key] = choice.name; assigned.add(choice.name); }
        }
        await this.store.saveProfile(profile);
        return profile;
    }
    private async parameterValue(parameter: JenkinsParameter): Promise<string | undefined> {
        if (parameter.choices) { return vscode.window.showQuickPick(parameter.choices, { title: parameter.name }); }
        if (parameter.type.endsWith('BooleanParameterDefinition')) { return vscode.window.showQuickPick(parameter.defaultValue === true ? ['true', 'false'] : ['false', 'true'], { title: parameter.name }); }
        return vscode.window.showInputBox({ title: parameter.name, value: parameter.defaultValue === undefined ? '' : String(parameter.defaultValue),
            prompt: t('이번 요청에만 사용하며 저장하지 않습니다.', 'Used only for this request and not saved.'), ignoreFocusOut: true });
    }
    private async pickRequest(node?: JenkinsTreeNode, activeOnly = false): Promise<JenkinsRequest | undefined> {
        if (node?.request && this.requests.includes(node.request)) { return node.request; }
        return (await vscode.window.showQuickPick(this.requests.filter(request => !activeOnly || (!request.stopped && !request.settledAt)).map(request => ({ label: `${request.branch}@${request.sha.slice(0, 8)}`,
            description: `${new Date(request.createdAt).toLocaleString()} · ${request.id.slice(0, 8)} · ${discoveryLabel(request)}`, request })), { title: t('테스트 요청 선택', 'Select a test request') }))?.request;
    }
    async showRuns(): Promise<void> { await vscode.commands.executeCommand('mainView.jenkins.focus'); }
    async openRun(node?: JenkinsTreeNode): Promise<void> {
        const request = await this.pickRequest(node);
        if (!request) { return; }
        if (node?.run && !request.runs.includes(node.run)) { throw new JenkinsClientError('INVALID_RUN'); }
        let run = node?.run;
        if (!run && request.runs.length > 0) {
            run = (await vscode.window.showQuickPick(request.runs.map(item => ({ label: item.fullDisplayName ?? `#${item.number}`,
                description: `${this.store.servers().find(server => server.id === item.serverId)?.name ?? item.serverId} · ${jenkinsStatusLabel(normalizeRunStatus(item, request.sha))}`, run: item })), { title: `${request.branch}@${request.sha.slice(0, 8)} · ${discoveryLabel(request)}` }))?.run;
        }
        if (!run) {
            const url = request.root.buildUrl ?? request.root.queueUrl;
            if (url) { await this.openTrustedUrl(url); }
            return;
        }
        await this.openTrustedUrl(run.url);
    }
    private async openTrustedUrl(url: string): Promise<void> {
        if (!serverForUrl(this.store.servers(), url)) { throw new JenkinsClientError('OUTSIDE_SERVER'); }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
    async openLog(node?: JenkinsTreeNode): Promise<void> {
        const request = await this.pickRequest(node);
        if (!request) { return; }
        if (node?.run && !request.runs.includes(node.run)) { throw new JenkinsClientError('INVALID_RUN'); }
        if (request.runs.length === 0) {
            quietMessage(() => vscode.window.showInformationMessage(t('아직 로그를 조회할 빌드가 없습니다. 대기열 또는 Jenkins에서 실행 상태를 확인해주세요.', 'No build log is available yet. Check the queue or Jenkins for execution status.')));
            return;
        }
        const run: TrackedJenkinsBuild | undefined = node?.run ?? (await vscode.window.showQuickPick(request.runs.map(item => ({ label: item.fullDisplayName ?? `#${item.number}`, run: item })), { title: t('로그를 볼 빌드', 'Build log to open') }))?.run;
        if (!run) { return; }
        const server = this.store.servers().find(item => item.id === run.serverId);
        if (!server) { return; }
        const log = await (await this.client(server)).getLog(run.url, 0);
        if (this.disposed) { return; }
        const suffix = log.truncated ? t('\n[크기 한도로 로그 앞부분만 표시합니다. 전체 로그는 Jenkins에서 확인하세요.]', '\n[Log size limit reached: showing the beginning only. Open Jenkins for the complete log.]') : log.more ? t('\n[부분 로그입니다. 전체 로그는 Jenkins에서 확인하세요.]', '\n[Partial log. Open Jenkins for the complete log.]') : '';
        this.logDocument.setContent(log.text + suffix);
        const document = await vscode.workspace.openTextDocument(this.logDocument.uri);
        if (!this.disposed) { await vscode.window.showTextDocument(document, { preview: true }); }
    }
    async stopTracking(node?: JenkinsTreeNode): Promise<void> {
        const request = await this.pickRequest(node, true);
        if (!request || request.stopped || request.settledAt) { return; }
        request.stopped = true;
        if (request.submission === 'sending') { request.submission = 'unconfirmed'; }
        this.requestAborts.get(request.id)?.abort();
        await this.persist(); this.updateView(); this.schedule();
        quietMessage(() => vscode.window.showInformationMessage(t('로컬 추적을 중지했습니다. Jenkins 빌드는 계속 실행됩니다.', 'Local tracking stopped. Jenkins builds continue running.')));
    }
}
