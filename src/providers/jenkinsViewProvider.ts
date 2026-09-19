import * as vscode from 'vscode';
import { t } from '../i18n';
import { jenkinsErrorLabel, jenkinsStatusLabel } from '../jenkins/messages';
import { aggregate, normalizeRunStatus } from '../jenkins/model';
import { JenkinsRequest, JenkinsServer, TrackedJenkinsBuild } from '../jenkins/types';

export interface JenkinsTreeNode { kind: 'branch' | 'sha' | 'request' | 'build' | 'detail'; label: string; requests?: JenkinsRequest[]; request?: JenkinsRequest; run?: TrackedJenkinsBuild; description?: string; children?: JenkinsTreeNode[]; }

export function discoveryLabel(request: JenkinsRequest): string {
    if (request.stopped) { return t('추적 중지', 'Tracking stopped'); }
    if (request.discovery.complete) { return t('전체 목록 확인됨', 'Complete inventory'); }
    if (request.discovery.message === 'manifestInvalid') { return t('목록 파일 확인 필요', 'Invalid or unresolved manifest'); }
    if (request.discovery.message === 'discoveryLimited') { return t('탐색 한도 도달 · 전체 범위 미확인', 'Discovery limit reached · coverage unverified'); }
    if (request.discovery.message === 'discoveryPartial') { return t('일부 서버 탐색 실패 · 전체 범위 미확인', 'Partial discovery failure · coverage unverified'); }
    return t('전체 범위 미확인', 'Coverage unverified');
}

function requestStatus(request: JenkinsRequest): string {
    const summary = aggregate(request);
    if (request.submission === 'sending') { return 'sending'; }
    if (request.submission === 'unconfirmed') { return 'unconfirmed'; }
    if (summary.observedResult === 'failed') { return 'failed'; }
    if (request.stopped) { return 'stopped'; }
    if (request.error || request.runs.some(run => run.error)) { return 'unreachable'; }
    if (request.runs.some(run => run.reportErrors)) { return 'partial'; }
    if (summary.allPassed) { return 'passed'; }
    if (summary.phase === 'active') { return request.root.buildUrl ? 'running' : 'queued'; }
    return summary.observedResult === 'nonpass' ? 'nonpass' : 'unknown';
}

function statusIcon(status: string): vscode.ThemeIcon {
    const icons: Record<string, [string, string]> = {
        partial: ['warning', 'list.warningForeground'],
        passed: ['pass', 'testing.iconPassed'], failed: ['error', 'testing.iconFailed'],
        sha_mismatch: ['error', 'list.warningForeground'], unreachable: ['debug-disconnect', 'list.errorForeground'],
        running: ['sync~spin', 'progressBar.background'], sending: ['cloud-upload', 'progressBar.background'],
        queued: ['clock', 'descriptionForeground'], aborted: ['circle-slash', 'testing.iconFailed'],
        skipped: ['debug-step-over', 'descriptionForeground'], stopped: ['debug-pause', 'descriptionForeground'],
        unconfirmed: ['question', 'list.warningForeground'], nonpass: ['warning', 'list.warningForeground'],
    };
    const [icon, color] = icons[status] ?? ['question', 'descriptionForeground'];
    return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

export class JenkinsViewProvider implements vscode.TreeDataProvider<JenkinsTreeNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<JenkinsTreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    constructor(private readonly requests: () => JenkinsRequest[], private readonly servers: () => JenkinsServer[]) {}
    refresh(): void { this.emitter.fire(undefined); }
    dispose(): void { this.emitter.dispose(); }
    getTreeItem(node: JenkinsTreeNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, node.kind === 'detail' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.description;
        item.contextValue = node.kind === 'request' ? 'jenkinsRequest' : node.kind === 'build' ? 'jenkinsBuild' : 'jenkinsDetail';
        if (node.kind === 'request' || node.kind === 'build') {
            const status = node.run ? normalizeRunStatus(node.run, node.request?.sha) : node.request ? requestStatus(node.request) : 'unknown';
            item.iconPath = statusIcon(node.run?.reportErrors && status === 'passed' ? 'partial' : status);
            item.accessibilityInformation = { label: `${node.label} · ${node.description ?? ''}` };
            item.tooltip = node.run ? `${node.run.url}\n${t('요청 SHA', 'Requested SHA')}: ${node.request?.sha}\n${t('실제 SHA', 'Actual SHA')}: ${node.run.actualSha ?? t('미확인', 'Unverified')}` : `${node.request?.id}\n${node.request?.sha}`;
        }
        return item;
    }
    getChildren(node?: JenkinsTreeNode): JenkinsTreeNode[] {
        if (!node) {
            const branches = new Map<string, JenkinsRequest[]>();
            for (const request of this.requests()) {
                const key = `${request.repoPath}\n${request.branch}`;
                branches.set(key, [...(branches.get(key) ?? []), request]);
            }
            return [...branches.values()].map(requests => ({ kind: 'branch', label: requests[0].branch, description: requests[0].repoPath, requests }));
        }
        if (node.kind === 'branch') {
            const shas = new Map<string, JenkinsRequest[]>();
            for (const request of node.requests ?? []) { shas.set(request.sha, [...(shas.get(request.sha) ?? []), request]); }
            return [...shas].map(([sha, requests]) => ({ kind: 'sha', label: sha.slice(0, 12), description: t(`${requests.length}회 요청`, `${requests.length} requests`), requests }));
        }
        if (node.kind === 'sha') {
            return (node.requests ?? []).map(request => {
                const summary = aggregate(request);
                const overall = jenkinsStatusLabel(requestStatus(request));
                return { kind: 'request', label: `${overall} · ${new Date(request.createdAt).toLocaleString()} · ${request.id.slice(0, 8)}`, request,
                    description: `${overall} · ${summary.counts.passed}/${summary.counts.total} · ${discoveryLabel(request)}` };
            });
        }
        if (node.kind === 'request' && node.request) {
            const request = node.request;
            const details: JenkinsTreeNode[] = [{ kind: 'detail', label: discoveryLabel(request) }];
            if (request.discovery.message === 'discoveryInProgress') { details.push({ kind: 'detail', label: t('탐색 진행 중 · 다음 회차에 계속', 'Discovery in progress · continues next round') }); }
            if (request.remoteBranch && request.remoteBranch !== request.branch) {
                details.push({ kind: 'detail', label: t(`전송한 원격 브랜치: ${request.remoteBranch}`, `Submitted remote branch: ${request.remoteBranch}`) });
            }
            if (request.error) { details.push({ kind: 'detail', label: jenkinsErrorLabel(request.error) }); }
            if (request.submission === 'sending') { details.push({ kind: 'detail', label: jenkinsStatusLabel('sending') }); }
            if (!request.root.buildUrl && request.submission !== 'sending') { details.push({ kind: 'detail', label: request.queueReason ?? t('Jenkins 대기열 확인 중', 'Checking Jenkins queue') }); }
            return [...details, ...request.runs.map(run => ({ kind: 'build' as const, request, run,
                label: `${jenkinsStatusLabel(normalizeRunStatus(run, request.sha))}${run.reportErrors ? ' · ' + jenkinsStatusLabel('partial') : ''} · ${this.servers().find(server => server.id === run.serverId)?.name ?? run.serverId} · ${run.fullDisplayName ?? `#${run.number}`}`,
                description: `${run.correlation === 'root' ? t('대표 결과', 'Representative result') + ' · ' : ''}${jenkinsStatusLabel(normalizeRunStatus(run, request.sha))}` }))];
        }
        if (node.kind === 'build' && node.run) {
            const run = node.run;
            const children: JenkinsTreeNode[] = [{ kind: 'detail', label: t(`실제 SHA: ${run.actualSha ?? '미확인'}`, `Actual SHA: ${run.actualSha ?? 'Unverified'}`) }];
            for (const [kind, error] of Object.entries(run.reportErrors ?? {})) {
                children.push({ kind: 'detail', label: `${kind === 'tests' ? 'JUnit' : t('단계 보고서', 'Stage report')}: ${jenkinsErrorLabel(error)}` });
            }
            for (const stage of run.stages?.stages ?? []) { children.push({ kind: 'detail', label: `${stage.name} · ${stage.status}` }); }
            if (run.stages?.detailsTruncated) { children.push({ kind: 'detail', label: t('단계 목록 일부 표시 · 전체 목록은 Jenkins에서 확인', 'Partial stage list · open Jenkins for all stages') }); }
            if (run.tests) {
                children.push({ kind: 'detail', label: t(`JUnit · 통과 ${run.tests.passCount} / 실패 ${run.tests.failCount} / 건너뜀 ${run.tests.skipCount}`, `JUnit · PASS ${run.tests.passCount} / FAIL ${run.tests.failCount} / SKIP ${run.tests.skipCount}`) });
                const cases = (run.tests.suites ?? []).flatMap(suite => suite.cases ?? []);
                const nonPassingCases = cases.filter(item => item.status !== 'PASSED' && item.status !== 'FIXED');
                for (const test of nonPassingCases.slice(0, 200)) {
                    children.push({ kind: 'detail', label: `${test.className ? test.className + '.' : ''}${test.name} · ${test.status}` });
                }
                if (run.tests.detailsTruncated || nonPassingCases.length > 200) { children.push({ kind: 'detail', label: t('나머지 테스트는 Jenkins에서 확인', 'Open Jenkins for remaining tests') }); }
            } else { children.push({ kind: 'detail', label: t('JUnit 보고서 없음 또는 접근 불가', 'JUnit report unavailable or inaccessible') }); }
            return children;
        }
        return node.children ?? [];
    }
}
