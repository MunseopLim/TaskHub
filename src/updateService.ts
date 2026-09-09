import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
    downloadAndVerifyRelease,
    fetchLatestRelease,
    GithubRelease,
    GithubUpdateError,
    isNewerVersion,
} from './githubUpdate';
import { withUpdateInstallLock } from './updateLock';
import { t } from './i18n';

export const UPDATE_CHECK_COMMAND = 'taskhub.checkForUpdates';
export const UPDATE_LAST_CHECK_KEY = 'taskhub.updates.lastCheck';
export const UPDATE_SKIPPED_VERSION_KEY = 'taskhub.updates.skippedVersion';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30_000;
const BUSY_RETRY_DELAY_MS = 60_000;

export type UpdateMode = 'off' | 'notify' | 'auto';

export interface UpdateServiceOptions {
    hasRunningActions(): boolean;
    log(message: string): void;
}

/** Side effects are injectable so tests never contact GitHub or install an extension. */
export interface UpdateServiceDependencies {
    fetchLatest: typeof fetchLatestRelease;
    download: typeof downloadAndVerifyRelease;
    withInstallLock: typeof withUpdateInstallLock;
    install(vsixPath: string): Promise<void>;
    getMode(): UpdateMode;
    now(): number;
    schedule(callback: () => void, delay: number): vscode.Disposable;
}

const defaultDependencies: UpdateServiceDependencies = {
    fetchLatest: fetchLatestRelease,
    download: downloadAndVerifyRelease,
    withInstallLock: withUpdateInstallLock,
    install: async vsixPath => {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    },
    getMode: () => {
        const mode = vscode.workspace.getConfiguration('taskhub').get<string>('updates.mode');
        return mode === 'off' || mode === 'auto' ? mode : 'notify';
    },
    now: Date.now,
    schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return new vscode.Disposable(() => clearTimeout(timer));
    },
};

/** VS Code notifications cannot be dismissed by API; cancellation must still release our operation. */
function cancellableChoice<T>(choice: Thenable<T>, signal: AbortSignal): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            resolve(undefined);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
        Promise.resolve(choice).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Informational notifications must not keep the update operation busy until they are dismissed. */
function showUpdateInformation(message: string): void {
    void vscode.window.showInformationMessage(message).then(undefined, () => { /* No response is required. */ });
}

/** No network request occurs during activation. All timers and requests belong to this instance. */
export class UpdateService implements vscode.Disposable {
    private readonly deps: UpdateServiceDependencies;
    private timer: vscode.Disposable | undefined;
    private operation: Promise<void> | undefined;
    private controller: AbortController | undefined;
    private reloadController: AbortController | undefined;
    private automaticOperation = false;
    private reportOperationErrors = false;
    private disposed = false;
    private installedVersion: string | undefined;
    private pendingRelease: GithubRelease | undefined;
    private retryAfter = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly options: UpdateServiceOptions,
        dependencies: Partial<UpdateServiceDependencies> = {},
    ) {
        this.deps = { ...defaultDependencies, ...dependencies };
    }

    start(): void {
        this.scheduleNext();
    }

    configurationChanged(): void {
        // A change to notify/off also withdraws permission for an in-flight automatic install.
        if (this.automaticOperation) {
            this.controller?.abort();
        }
        this.pendingRelease = undefined;
        this.scheduleNext();
    }

    dispose(): void {
        this.disposed = true;
        this.timer?.dispose();
        this.timer = undefined;
        this.controller?.abort();
        this.reloadController?.abort();
    }

    async check(manual = true): Promise<void> {
        if (this.disposed || (!manual && !this.canCheckAutomatically())) {
            return;
        }
        if (this.operation) {
            if (manual) {
                showUpdateInformation(t(
                    'TaskHub 업데이트를 확인하거나 설치하고 있습니다.',
                    'A TaskHub update check or installation is already in progress.',
                ));
            }
            return;
        }
        if (!manual && this.remainingDelay() > 0) {
            this.scheduleNext();
            return;
        }

        this.timer?.dispose();
        this.timer = undefined;
        const controller = new AbortController();
        this.controller = controller;
        this.automaticOperation = !manual;
        this.reportOperationErrors = manual;
        const operation = this.performCheck(manual, controller).catch(error => {
            this.reportError(error, controller.signal, this.reportOperationErrors);
        });
        this.operation = operation;
        try {
            await operation;
        } finally {
            this.operation = undefined;
            this.controller = undefined;
            this.automaticOperation = false;
            this.scheduleNext();
        }
    }

    private canCheckAutomatically(): boolean {
        return this.context.extensionMode === vscode.ExtensionMode.Production && this.deps.getMode() !== 'off';
    }

    private remainingDelay(): number {
        if (this.pendingRelease) {
            return Math.max(0, this.retryAfter - this.deps.now());
        }
        const lastCheck = this.context.globalState.get<unknown>(UPDATE_LAST_CHECK_KEY);
        const now = this.deps.now();
        if (typeof lastCheck !== 'number' || !Number.isFinite(lastCheck) || lastCheck < 0 || lastCheck > now) {
            return 0;
        }
        return Math.max(0, UPDATE_CHECK_INTERVAL_MS - (now - lastCheck));
    }

    private scheduleNext(): void {
        this.timer?.dispose();
        this.timer = undefined;
        if (this.disposed || this.operation || !this.canCheckAutomatically()) {
            return;
        }
        this.timer = this.deps.schedule(() => { void this.check(false); }, Math.max(STARTUP_DELAY_MS, this.remainingDelay()));
    }

    private async performCheck(manual: boolean, controller: AbortController): Promise<void> {
        let release = !manual ? this.pendingRelease : undefined;
        this.pendingRelease = undefined;
        if (!release) {
            // Persist attempts too: offline/rate-limited machines must not retry on every new window.
            await this.context.globalState.update(UPDATE_LAST_CHECK_KEY, this.deps.now());
            if (this.cancelled(controller.signal)) { return; }
            release = manual
                ? await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('TaskHub 업데이트 확인 중…', 'Checking for TaskHub updates…'),
                    cancellable: true,
                }, async (_progress, token) => {
                    const subscription = token.onCancellationRequested(() => controller.abort());
                    try {
                        if (token.isCancellationRequested) { controller.abort(); }
                        return await this.deps.fetchLatest(controller.signal);
                    } finally {
                        subscription.dispose();
                    }
                })
                : await this.deps.fetchLatest(controller.signal);
        }
        if (this.cancelled(controller.signal)) { return; }

        const currentVersion: string = this.context.extension.packageJSON.version;
        if (!release || !isNewerVersion(release.version, currentVersion)) {
            if (manual) {
                showUpdateInformation(t(
                    '현재 TaskHub보다 새로운 정식 릴리스가 없습니다.',
                    'No newer stable TaskHub release is available.',
                ));
            }
            return;
        }
        if (this.installedVersion && !isNewerVersion(release.version, this.installedVersion)) {
            if (manual) { this.offerReload(this.installedVersion); }
            return;
        }
        const mode = this.deps.getMode();
        if (!manual && (mode === 'off' || (mode === 'notify'
            && this.context.globalState.get(UPDATE_SKIPPED_VERSION_KEY) === release.version))) {
            return;
        }

        if (manual || mode === 'notify') {
            const installLabel = t('업데이트 설치', 'Install Update');
            const notesLabel = t('릴리스 보기', 'View Release');
            const skipLabel = t('이 버전 건너뛰기', 'Skip This Version');
            const choice = await cancellableChoice(vscode.window.showInformationMessage(t(
                `TaskHub ${release.version} 버전을 사용할 수 있습니다. (현재 ${currentVersion})`,
                `TaskHub ${release.version} is available. (Current: ${currentVersion})`,
            ), installLabel, notesLabel, skipLabel), controller.signal);
            if (this.cancelled(controller.signal)) { return; }
            if (choice === skipLabel) {
                await this.context.globalState.update(UPDATE_SKIPPED_VERSION_KEY, release.version);
                return;
            }
            if (choice === notesLabel) {
                await vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
                return;
            }
            if (choice !== installLabel) { return; }
            this.reportOperationErrors = true;
        }

        if (this.deferWhileBusy(release, manual, controller.signal)) { return; }
        const installed = await this.installRelease(release, manual, controller);
        if (installed && !this.cancelled(controller.signal)) {
            this.offerReload(installed);
        }
    }

    private reportError(error: unknown, signal: AbortSignal, report: boolean): void {
        if (this.cancelled(signal)) { return; }
        const detail = updateErrorMessage(error);
        this.options.log(t(`업데이트: ${detail}`, `Update: ${detail}`));
        if (report) {
            void vscode.window.showErrorMessage(t(
                `TaskHub 업데이트 실패: ${detail}`,
                `TaskHub update failed: ${detail}`,
            )).then(undefined, () => { /* No response is required. */ });
        }
    }

    private cancelled(signal: AbortSignal): boolean {
        return this.disposed || signal.aborted;
    }

    private deferWhileBusy(release: GithubRelease, manual: boolean, signal: AbortSignal): boolean {
        if (this.cancelled(signal)) { return true; }
        if (!this.options.hasRunningActions()) { return false; }
        if (!manual && this.deps.getMode() === 'auto') {
            this.pendingRelease = release;
            this.retryAfter = this.deps.now() + BUSY_RETRY_DELAY_MS;
        } else if (this.reportOperationErrors) {
            // This can run while holding the install lock. Do not wait for notification dismissal.
            showUpdateInformation(t(
                'TaskHub 액션이 실행 중입니다. 작업을 마친 뒤 업데이트 확인을 다시 실행하세요.',
                'TaskHub actions are still running. Check for updates again after they finish.',
            ));
        }
        return true;
    }

    private async installRelease(release: GithubRelease, manual: boolean, controller: AbortController): Promise<string | undefined> {
        const directory = path.join(this.context.globalStorageUri.fsPath, 'updates');
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t(`TaskHub ${release.version} 업데이트 설치 중…`, `Installing TaskHub ${release.version}…`),
            cancellable: true,
        }, async (progress, token) => {
            const subscription = token.onCancellationRequested(() => controller.abort());
            try {
                if (token.isCancellationRequested) { controller.abort(); }
                if (this.cancelled(controller.signal)) { return undefined; }
                const result = await this.deps.withInstallLock(directory, async state => {
                    if (this.cancelled(controller.signal) || state.signal.aborted) { return undefined; }
                    // An old notification in another window must never replace a newer installed release.
                    if (state.installedVersion && isNewerVersion(state.installedVersion, release.version)) {
                        this.installedVersion = state.installedVersion;
                        return manual ? state.installedVersion : undefined;
                    }
                    // Explicit manual installation of the same version can recover from a downgrade.
                    if (!manual && state.installedVersion && !isNewerVersion(release.version, state.installedVersion)) {
                        return undefined;
                    }
                    const abort = () => controller.abort();
                    state.signal.addEventListener('abort', abort, { once: true });
                    let temporaryDirectory: string | undefined;
                    try {
                        temporaryDirectory = await fs.mkdtemp(path.join(directory, 'download-'));
                        const vsixPath = path.join(temporaryDirectory, `taskhub-${release.version}.vsix`);
                        progress.report({ message: t('다운로드 및 검증 중…', 'Downloading and verifying…') });
                        await this.deps.download(release, vsixPath, vscode.version, controller.signal);
                        if (this.cancelled(controller.signal) || state.signal.aborted) { return undefined; }
                        if (this.deferWhileBusy(release, manual, controller.signal)) { return undefined; }
                        if (this.cancelled(controller.signal) || state.signal.aborted) { return undefined; }
                        progress.report({ message: t('VS Code에 설치 중…', 'Installing in VS Code…') });
                        await this.deps.install(vsixPath);
                        // Once VS Code accepts installation, cancellation cannot undo that operation.
                        this.installedVersion = release.version;
                        try {
                            await state.markInstalled(release.version);
                        } catch {
                            this.options.log(t('업데이트는 설치되었지만 설치 버전 기록을 저장하지 못했습니다.', 'The update was installed, but its version record could not be saved.'));
                        }
                        return release.version;
                    } finally {
                        state.signal.removeEventListener('abort', abort);
                        if (temporaryDirectory) {
                            try {
                                await fs.rm(temporaryDirectory, { recursive: true, force: true });
                            } catch {
                                this.options.log(t('업데이트 임시 파일을 정리하지 못했습니다.', 'Could not clean up update temporary files.'));
                            }
                        }
                    }
                });
                if (!result.acquired) {
                    if (this.reportOperationErrors && !this.cancelled(controller.signal)) {
                        showUpdateInformation(t(
                            '다른 VS Code 창에서 TaskHub 업데이트를 설치하고 있습니다. 잠시 후 다시 확인하세요.',
                            'Another VS Code window is installing a TaskHub update. Please check again shortly.',
                        ));
                    }
                    return undefined;
                }
                return result.value;
            } finally {
                subscription.dispose();
            }
        });
    }

    private offerReload(version: string): void {
        if (this.disposed) { return; }
        // A completed install must release the check even if its notification stays in the center.
        this.reloadController?.abort();
        const controller = new AbortController();
        this.reloadController = controller;
        void this.awaitReloadChoice(version, controller.signal).catch(error => {
            this.reportError(error, controller.signal, true);
        }).finally(() => {
            if (this.reloadController === controller) { this.reloadController = undefined; }
        });
    }

    private async awaitReloadChoice(version: string, signal: AbortSignal): Promise<void> {
        if (this.disposed) { return; }
        const reloadLabel = t('창 다시 로드', 'Reload Window');
        const choice = await cancellableChoice(vscode.window.showInformationMessage(t(
            `TaskHub ${version} 설치가 완료되었습니다. 작업을 마친 뒤 창을 다시 로드하면 적용됩니다.`,
            `TaskHub ${version} is installed. Reload the window after finishing your work to apply it.`,
        ), reloadLabel), signal);
        if (this.cancelled(signal) || choice !== reloadLabel) { return; }
        // Re-check when the user clicks: a task may have started while the notification was open.
        if (this.options.hasRunningActions()) {
            showUpdateInformation(t(
                'TaskHub 액션이 실행 중입니다. 작업을 마친 뒤 창을 다시 로드하세요.',
                'TaskHub actions are still running. Reload the window after they finish.',
            ));
            return;
        }
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** User-visible errors intentionally exclude response bodies, URLs and local filesystem details. */
export function updateErrorMessage(error: unknown): string {
    if (error instanceof GithubUpdateError) {
        switch (error.code) {
            case 'cancelled': return t('업데이트가 취소되었습니다.', 'The update was cancelled.');
            case 'timeout': return t('GitHub 응답 시간이 초과되었습니다.', 'The GitHub request timed out.');
            case 'network': return t('GitHub에 연결할 수 없습니다. 네트워크 또는 API 사용 한도를 확인하세요.', 'Could not reach GitHub. Check your network or API rate limit.');
            case 'invalidMetadata': return t('릴리스의 VSIX 또는 SHA-256 정보가 없거나 올바르지 않습니다.', 'The release VSIX or SHA-256 metadata is missing or invalid.');
            case 'invalidUrl': return t('허용되지 않은 업데이트 다운로드 주소입니다.', 'The update download URL is not allowed.');
            case 'tooLarge': return t('업데이트 파일 또는 응답이 허용 크기를 초과했습니다.', 'The update file or response exceeds the size limit.');
            case 'digestMismatch': return t('업데이트 파일의 SHA-256 검증에 실패했습니다.', 'The update file failed SHA-256 verification.');
            case 'invalidVsix': return t('TaskHub 확장 ID 또는 버전이 일치하는 올바른 VSIX가 아닙니다.', 'The VSIX is invalid or its TaskHub extension ID or version does not match.');
            case 'incompatibleVscode': return t('이 TaskHub 릴리스는 현재 VS Code 버전과 호환되지 않습니다.', 'This TaskHub release is not compatible with your VS Code version.');
            case 'fileSystem': return t('업데이트 임시 파일을 읽거나 쓸 수 없습니다.', 'Could not read or write update temporary files.');
        }
    }
    return t('업데이트를 완료하지 못했습니다. 잠시 후 다시 시도하세요.', 'The update could not be completed. Please try again later.');
}

export function registerUpdateService(context: vscode.ExtensionContext, options: UpdateServiceOptions): void {
    const service = new UpdateService(context, options);
    context.subscriptions.push(
        service,
        vscode.commands.registerCommand(UPDATE_CHECK_COMMAND, () => service.check()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('taskhub.updates.mode')) { service.configurationChanged(); }
        }),
    );
    service.start();
}
