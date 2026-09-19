import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { t } from '../i18n';
import { abortable, JenkinsClientError, JenkinsTransportGuard, JenkinsClient, normalizeJenkinsServerUrl, validateJenkinsServerUrl } from './client';
import { JenkinsInventory, JenkinsInventoryResult } from './inventory';
import { jenkinsErrorLabel, jenkinsStatusLabel } from './messages';
import { JenkinsLogDocument } from './logDocument';
import { createJenkinsScope } from './lifecycle';
import { JenkinsGitError, readJenkinsGitSnapshot } from './git';
import { aggregate, createRequest, normalizeRunStatus } from './model';
import { JenkinsStore } from './storage';
import { mapConcurrent, pollJenkinsRequest, safeJenkinsError, serverForUrl } from './tracking';
import { JenkinsJob, JenkinsJobProfile, JenkinsParameter, JenkinsRequest, JenkinsServer, TrackedJenkinsBuild, jenkinsLimits } from './types';
import { discoveryLabel, JenkinsTreeNode, JenkinsViewProvider } from '../providers/jenkinsViewProvider';

const COMMANDS = ['manageServers', 'run', 'refresh', 'openRun', 'openLog', 'stopTracking', 'showRuns'] as const;
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
            dirty: t('변경 내용을 커밋하고 원격에 푸시한 후 실행해주세요.', 'Commit and push your changes before running tests.'),
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
    constructor(context: vscode.ExtensionContext) {
        try {
            this.store = new JenkinsStore(context);
            this.requests = this.store.requests();
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
        this.timer = setTimeout(() => { void this.refresh(); }, delay ?? numberSetting('jenkins.pollIntervalSeconds', 15, 5, 300) * 1000);
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
        this.status.text = `$(beaker) Jenkins ${active}`;
        this.status.tooltip = t(`추적 중인 요청 ${active}개 · 클릭하여 결과 보기`, `${active} tracked requests · click to view results`);
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
    }
    async refresh(): Promise<void> {
        if (this.disposed) { return; }
        if (this.polling) { return this.polling; }
        this.polling = this.poll().catch(async error => {
            if (!this.disposed) { this.status.tooltip = errorMessage(error); }
        }).finally(() => { this.polling = undefined; this.schedule(); });
        return this.polling;
    }
    private async poll(): Promise<void> {
        const now = Date.now();
        const active = this.requests.filter(request => !request.stopped && !request.settledAt);
        const discover = active.some(request => request.root.buildUrl) && now - this.lastDiscovery >= numberSetting('jenkins.discoveryIntervalSeconds', 60, 15, 600) * 1000;
        let inventory: JenkinsInventoryResult | undefined;
        if (discover) {
            this.lastDiscovery = now;
            const budget = { remaining: 150 };
            const scope = createJenkinsScope([this.abort.signal], jenkinsLimits.requestDeadlineMs);
            try {
                inventory = await this.inventory.collect({ servers: this.store.servers(), requests: active,
                    client: server => this.client(server, scope.signal, budget), signal: scope.signal,
                    jobLimit: numberSetting('jenkins.discoveryJobLimit', 200, 20, 2000),
                    recentBuildLimit: numberSetting('jenkins.recentBuildLimit', 20, 5, 200) });
            } finally { scope.dispose(); }
        }
        await mapConcurrent([...this.requests], async request => {
            if (this.disposed || request.stopped || request.settledAt) { return; }
            if (now - request.createdAt > numberSetting('jenkins.trackingTimeoutHours', 24, 1, 168) * 3600000) {
                request.stopped = true; request.error = 'JENKINS_TRACKING_TIMEOUT'; return;
            }
            const operation = new AbortController();
            this.requestAborts.set(request.id, operation);
            const scope = createJenkinsScope([this.abort.signal, operation.signal]);
            const signal = scope.signal;
            const timer = setTimeout(() => operation.abort(), jenkinsLimits.requestDeadlineMs);
            const budget = { remaining: 150 };
            try {
                await pollJenkinsRequest(request, { servers: this.store.servers(), client: server => this.client(server, signal, budget), discover, signal, inventory,
                    reserveRuns: count => this.reserveRuns(count),
                    recentBuildLimit: numberSetting('jenkins.recentBuildLimit', 20, 5, 200),
                    manifestArtifact: config().get<string>('jenkins.manifestArtifact', 'taskhub-jenkins-runs.json') });
                if (!this.disposed && !request.stopped && !signal.aborted) { await this.notify(request); }
            } catch (error) {
                if (!this.disposed && !request.stopped) {
                    request.error = signal.aborted ? 'JENKINS_POLL_DEADLINE' : safeJenkinsError(error);
                    request.discovery.complete = false;
                }
            } finally { clearTimeout(timer); scope.dispose(); this.requestAborts.delete(request.id); }
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
        const failed = summary.observedResult === 'failed' || summary.observedResult === 'nonpass';
        if (preference === 'off' || (preference === 'failures' && !failed) || this.disposed) { return; }
        const label = key === 'complete' ? t('전체 테스트', 'All tracked tests') : t('Jenkins 대표 결과 (전체 범위 미확인)', 'Jenkins representative result (coverage unverified)');
        const message = `${request.branch}@${request.sha.slice(0, 8)} · ${label}: ${key === 'complete' ? jenkinsStatusLabel(summary.allPassed ? 'passed' : summary.observedResult === 'failed' ? 'failed' : 'nonpass') : jenkinsStatusLabel(root ? normalizeRunStatus(root, request.sha) : 'unknown')}`;
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
            const result = await (await this.client(server)).verify();
            if (!result.authenticated) { throw new Error('JENKINS_AUTH_REQUIRED'); }
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
    private async withOperation<T>(title: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, cancellation) => {
            const operation = new AbortController();
            const subscription = cancellation.onCancellationRequested(() => operation.abort());
            const scope = createJenkinsScope([this.abort.signal, operation.signal], 30000);
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
        const remoteBranch = snapshot.remoteRef.slice('refs/heads/'.length);
        const request = createRequest({ ...snapshot, remoteBranch, root: { serverId: server.id, jobUrl: job.url }, shaParameter: profile.shaParameter, requestIdParameter: profile.requestIdParameter });
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
        if (await vscode.window.showInformationMessage(`${server.name} · ${job.fullName}\n${snapshot.branch}@${snapshot.sha}\n${t('전송할 원격 브랜치', 'Remote branch to submit')}: ${remoteBranch}\n${pin}`, { modal: true }, start) !== start) { return; }
        // Recheck after dialogs: branch/HEAD/remote may have changed while the user chose parameters.
        const current = await this.withOperation(t('전송 전 Git 상태 재확인 중', 'Rechecking Git before submission'), signal => readJenkinsGitSnapshot(snapshot.repoPath, signal));
        if (current.branch !== snapshot.branch || current.sha !== snapshot.sha || current.remote !== snapshot.remote || current.remoteRef !== snapshot.remoteRef) { throw new JenkinsGitError('notPushed'); }
        if (this.disposed) { return; }
        request.submission = 'sending';
        this.requests.unshift(request);
        try { await this.persist(); } catch (error) { this.requests.splice(this.requests.indexOf(request), 1); throw error; }
        this.updateView();
        try {
            if (this.disposed) { throw new JenkinsClientError('CANCELLED'); }
            const queued = await this.withOperation(t('Jenkins에 테스트 요청 전송 중 · 취소해도 빌드가 실행될 수 있습니다', 'Submitting tests to Jenkins · cancellation may not stop the build'), async signal => (await this.client(server, signal)).trigger(job.url, parameters));
            request.root.queueUrl = queued.queueUrl;
            delete request.submission;
            delete request.error;
        } catch (error) {
            request.submission = 'unconfirmed';
            request.error = `JENKINS_SUBMISSION_UNCONFIRMED_${safeJenkinsError(error)}`;
            request.stopped = true;
            await this.persist(); this.updateView();
            quietMessage(() => vscode.window.showWarningMessage(t('요청 수락 여부를 확인할 수 없습니다. 중복 실행을 피하려면 Jenkins 대기열을 먼저 확인해주세요. 자동 재시도하지 않습니다.', 'Build acceptance could not be confirmed. Check the Jenkins queue before retrying to avoid duplicates. This request will not be retried automatically.')));
            return;
        }
        await this.persist(); this.updateView();
        await this.refresh();
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
            const entries = parameters.filter(parameter => !assigned.has(parameter.name) && !parameter.type.endsWith('BooleanParameterDefinition')).map(parameter => ({ label: parameter.name, name: parameter.name, picked: old?.[mapping.key] === parameter.name }));
            const choice = await vscode.window.showQuickPick([{ label: t('사용하지 않음', 'Not used'), name: '', picked: !old?.[mapping.key] }, ...entries], { title: mapping.title });
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
    private async pickRequest(node?: JenkinsTreeNode): Promise<JenkinsRequest | undefined> {
        if (node?.request && this.requests.includes(node.request)) { return node.request; }
        return (await vscode.window.showQuickPick(this.requests.map(request => ({ label: `${request.branch}@${request.sha.slice(0, 8)}`,
            description: `${new Date(request.createdAt).toLocaleString()} · ${request.id.slice(0, 8)} · ${discoveryLabel(request)}`, request })), { title: t('테스트 요청 선택', 'Select a test request') }))?.request;
    }
    async showRuns(): Promise<void> { await vscode.commands.executeCommand('mainView.jenkins.focus'); }
    async openRun(node?: JenkinsTreeNode): Promise<void> {
        const request = await this.pickRequest(node);
        if (!request) { return; }
        if (node?.run && !request.runs.includes(node.run)) { throw new Error('JENKINS_INVALID_RUN'); }
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
        if (!serverForUrl(this.store.servers(), url)) { throw new Error('JENKINS_OUTSIDE_SERVER'); }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
    async openLog(node?: JenkinsTreeNode): Promise<void> {
        const request = await this.pickRequest(node);
        if (!request) { return; }
        if (node?.run && !request.runs.includes(node.run)) { throw new Error('JENKINS_INVALID_RUN'); }
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
        const request = await this.pickRequest(node);
        if (!request) { return; }
        request.stopped = true;
        this.requestAborts.get(request.id)?.abort();
        await this.persist(); this.updateView();
        quietMessage(() => vscode.window.showInformationMessage(t('로컬 추적을 중지했습니다. Jenkins 빌드는 계속 실행됩니다.', 'Local tracking stopped. Jenkins builds continue running.')));
    }
}
