import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GithubRelease, GithubUpdateError } from '../githubUpdate';
import { t } from '../i18n';
import { withUpdateInstallLock } from '../updateLock';
import {
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_LAST_CHECK_KEY,
    UPDATE_SKIPPED_VERSION_KEY,
    UpdateMode,
    UpdateService,
    UpdateServiceDependencies,
} from '../updateService';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

suite('GitHub update service', () => {
    let storage: string;
    let context: vscode.ExtensionContext;
    let state: Map<string, unknown>;
    let mode: UpdateMode;
    let now: number;
    let running: boolean;
    let release: GithubRelease | undefined;
    let fetches: number;
    let downloads: string[];
    let installs: string[];
    let logs: string[];
    let errors: string[];
    let messages: Array<{ message: string; items: string[] }>;
    let commands: string[];
    let externalUrls: string[];
    let timers: Array<{ callback: () => void; delay: number; disposed: boolean }>;
    let services: UpdateService[];
    let progressSources: vscode.CancellationTokenSource[];
    let respond: (message: string, items: string[]) => Promise<string | undefined>;
    let restore: () => void;

    const installLabel = (): string => t('업데이트 설치', 'Install Update');
    const reloadLabel = (): string => t('창 다시 로드', 'Reload Window');
    const skipLabel = (): string => t('이 버전 건너뛰기', 'Skip This Version');
    const newRelease = (version = '1.2.3'): GithubRelease => ({
        version,
        assetUrl: `https://github.com/MunseopLim/TaskHub/releases/download/v${version}/taskhub-${version}.vsix`,
        releaseUrl: `https://github.com/MunseopLim/TaskHub/releases/tag/v${version}`,
        sha256: 'a'.repeat(64),
        size: 100,
    });
    const chooseInstall = async (_message: string, items: string[]): Promise<string | undefined> =>
        items.includes(installLabel()) ? installLabel() : undefined;
    const activeTimers = (): typeof timers => timers.filter(timer => !timer.disposed);

    function makeService(overrides: Partial<UpdateServiceDependencies> = {}): UpdateService {
        const service = new UpdateService(context, {
            hasRunningActions: () => running,
            log: message => logs.push(message),
        }, {
            fetchLatest: async () => { fetches++; return release; },
            download: async (_release, destination) => {
                downloads.push(destination);
                await fs.writeFile(destination, 'verified VSIX fixture');
            },
            withInstallLock: withUpdateInstallLock,
            install: async destination => {
                assert.strictEqual(await fs.readFile(destination, 'utf8'), 'verified VSIX fixture');
                installs.push(destination);
            },
            getMode: () => mode,
            now: () => now,
            schedule: (callback, delay) => {
                const timer = { callback, delay, disposed: false };
                timers.push(timer);
                return new vscode.Disposable(() => { timer.disposed = true; });
            },
            ...overrides,
        });
        services.push(service);
        return service;
    }

    setup(async () => {
        storage = await fs.mkdtemp(path.join(os.tmpdir(), 'taskhub-update-service-'));
        state = new Map();
        mode = 'notify';
        now = 10 * UPDATE_CHECK_INTERVAL_MS;
        running = false;
        release = newRelease();
        fetches = 0;
        downloads = [];
        installs = [];
        logs = [];
        errors = [];
        messages = [];
        commands = [];
        externalUrls = [];
        timers = [];
        services = [];
        progressSources = [];
        respond = async () => undefined;
        context = {
            extensionMode: vscode.ExtensionMode.Production,
            extension: { packageJSON: { version: '1.2.2' } },
            globalStorageUri: vscode.Uri.file(storage),
            globalState: {
                get: (key: string, fallback?: unknown) => state.has(key) ? state.get(key) : fallback,
                update: async (key: string, value: unknown) => { state.set(key, value); },
            },
        } as unknown as vscode.ExtensionContext;
        const original = {
            information: vscode.window.showInformationMessage,
            error: vscode.window.showErrorMessage,
            progress: vscode.window.withProgress,
            execute: vscode.commands.executeCommand,
            external: vscode.env.openExternal,
        };
        restore = () => {
            vscode.window.showInformationMessage = original.information;
            vscode.window.showErrorMessage = original.error;
            vscode.window.withProgress = original.progress;
            vscode.commands.executeCommand = original.execute;
            vscode.env.openExternal = original.external;
        };
        (vscode.window as any).showInformationMessage = async (message: string, ...items: string[]) => {
            messages.push({ message, items });
            return respond(message, items);
        };
        (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); return undefined; };
        vscode.window.withProgress = async (_options, task) => {
            const source = new vscode.CancellationTokenSource();
            progressSources.push(source);
            try {
                return await task({ report: () => undefined }, source.token);
            } finally {
                source.dispose();
            }
        };
        (vscode.commands as any).executeCommand = async (command: string) => { commands.push(command); };
        vscode.env.openExternal = async uri => { externalUrls.push(uri.toString()); return true; };
    });

    teardown(async () => {
        for (const service of services) { service.dispose(); }
        for (const source of progressSources) { source.dispose(); }
        restore();
        assert.strictEqual(activeTimers().length, 0, '서비스 타이머를 남기면 안 된다');
        await fs.rm(storage, { recursive: true, force: true });
    });

    test('운영 활성화는 요청 없이 30초 뒤 확인을 예약하고 dispose가 타이머를 정리한다', () => {
        const service = makeService();
        service.start();
        assert.strictEqual(fetches, 0);
        assert.strictEqual(activeTimers().length, 1);
        assert.strictEqual(activeTimers()[0].delay, 30_000);
        service.start();
        assert.strictEqual(timers[0].disposed, true);
        assert.strictEqual(activeTimers().length, 1);
        service.dispose();
        assert.strictEqual(activeTimers().length, 0);
        timers.at(-1)!.callback();
        assert.strictEqual(fetches, 0);
    });

    test('개발·테스트 호스트에서는 자동 확인을 예약하거나 실행하지 않는다', async () => {
        for (const extensionMode of [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test]) {
            context = { ...context, extensionMode };
            const service = makeService();
            service.start();
            await service.check(false);
        }
        assert.strictEqual(activeTimers().length, 0);
        assert.strictEqual(fetches, 0);
        assert.strictEqual(messages.length, 0);
    });

    test('off 전환은 예약과 진행 중 자동 확인을 취소하여 늦은 응답을 무시한다', async () => {
        const response = deferred<GithubRelease | undefined>();
        const started = deferred<AbortSignal>();
        const service = makeService({ fetchLatest: async signal => { started.resolve(signal); return response.promise; } });
        service.start();
        mode = 'off';
        service.configurationChanged();
        assert.strictEqual(activeTimers().length, 0);
        mode = 'auto';
        service.configurationChanged();
        const checking = service.check(false);
        const signal = await started.promise;
        try {
            mode = 'off';
            service.configurationChanged();
            assert.strictEqual(signal.aborted, true);
        } finally {
            response.resolve(release);
            await checking;
        }
        assert.strictEqual(downloads.length, 0);
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(activeTimers().length, 0);
    });

    test('하루 간격을 유지하되 미래 시각이나 유효하지 않은 확인 기록으로 막히지 않는다', async () => {
        const service = makeService();
        state.set(UPDATE_LAST_CHECK_KEY, now - 2 * 60 * 60 * 1000);
        service.start();
        assert.strictEqual(activeTimers()[0].delay, 22 * 60 * 60 * 1000);
        await service.check(false);
        assert.strictEqual(fetches, 0);
        now += UPDATE_CHECK_INTERVAL_MS;
        await service.check(false);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(state.get(UPDATE_LAST_CHECK_KEY), now);
        assert.strictEqual(activeTimers()[0].delay, UPDATE_CHECK_INTERVAL_MS);
        for (const invalid of [now + 1, NaN, Infinity, -1, 'yesterday']) {
            state.set(UPDATE_LAST_CHECK_KEY, invalid);
            await service.check(false);
        }
        assert.strictEqual(fetches, 6);
    });

    test('오프라인 자동 확인도 시각을 기록하고 오류 팝업 없이 다음 날로 미룬다', async () => {
        const service = makeService({ fetchLatest: async () => { throw new GithubUpdateError('network'); } });
        await service.check(false);
        assert.strictEqual(state.get(UPDATE_LAST_CHECK_KEY), now);
        assert.strictEqual(activeTimers()[0].delay, UPDATE_CHECK_INTERVAL_MS);
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(logs.length, 1);
    });

    test('수동 확인은 off·건너뛴 버전·일일 제한·개발 호스트에서도 설치할 수 있다', async () => {
        mode = 'off';
        context = { ...context, extensionMode: vscode.ExtensionMode.Development };
        state.set(UPDATE_LAST_CHECK_KEY, now);
        state.set(UPDATE_SKIPPED_VERSION_KEY, release!.version);
        respond = chooseInstall;
        await makeService().check();
        assert.strictEqual(fetches, 1);
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(commands.length, 0, '설치 후 사용자의 선택 없이 다시 로드하지 않는다');
        assert.strictEqual(activeTimers().length, 0);
    });

    test('notify에서 건너뛴 버전은 자동 알림을 생략하고 auto 전환 후에는 설치한다', async () => {
        respond = async (_message, items) => items.includes(skipLabel()) ? skipLabel() : undefined;
        const service = makeService();
        await service.check();
        assert.strictEqual(state.get(UPDATE_SKIPPED_VERSION_KEY), release!.version);
        messages = [];
        now += UPDATE_CHECK_INTERVAL_MS;
        await service.check(false);
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(downloads.length, 0);
        mode = 'auto';
        now += UPDATE_CHECK_INTERVAL_MS;
        await service.check(false);
        assert.strictEqual(installs.length, 1);
        assert.ok(messages.every(message => !message.items.includes(installLabel())));
    });

    test('현재 버전 이하 또는 릴리스 없음은 설치 제안을 만들지 않는다', async () => {
        for (const candidate of [undefined, newRelease('1.2.2'), newRelease('1.2.1')]) {
            release = candidate;
            await makeService().check();
        }
        assert.strictEqual(messages.length, 3);
        assert.ok(messages.every(message => message.items.length === 0));
        assert.strictEqual(downloads.length, 0);
    });

    test('최신 버전 안내를 닫지 않아도 다음 수동 확인을 실행할 수 있다', async () => {
        release = undefined;
        const dismissed = deferred<string | undefined>();
        respond = async () => dismissed.promise;
        const service = makeService();
        try {
            await service.check();
            await service.check();
            assert.strictEqual(fetches, 2, '단순 안내가 진행 중 작업으로 남으면 안 된다');
            assert.strictEqual(messages.length, 2);
            assert.ok(messages.every(message => message.items.length === 0));
            assert.strictEqual(activeTimers().length, 1);
        } finally {
            dismissed.resolve(undefined);
        }
    });

    test('실패 안내를 닫지 않아도 다음 수동 확인이 다시 조회할 수 있다', async () => {
        const dismissed = deferred<string | undefined>();
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            return dismissed.promise;
        };
        const service = makeService({ fetchLatest: async () => {
            fetches++;
            if (fetches === 1) { throw new GithubUpdateError('network'); }
            return undefined;
        } });
        try {
            await service.check();
            assert.strictEqual(errors.length, 1);
            await service.check();
            assert.strictEqual(fetches, 2, '오류 알림이 다음 재시도를 막으면 안 된다');
            assert.strictEqual(messages.length, 1);
            assert.strictEqual(activeTimers().length, 1);
        } finally {
            dismissed.resolve(undefined);
        }
    });

    test('다운로드 검증 완료 전 설치하지 않고 성공 후 임시 파일을 정리한다', async () => {
        respond = chooseInstall;
        const started = deferred<{ destination: string; signal: AbortSignal }>();
        const verified = deferred<void>();
        const service = makeService({ download: async (_release, destination, version, signal) => {
            assert.strictEqual(version, vscode.version);
            started.resolve({ destination, signal });
            await verified.promise;
            await fs.writeFile(destination, 'verified VSIX fixture');
        } });
        const checking = service.check();
        const { destination, signal } = await started.promise;
        try {
            assert.strictEqual(signal.aborted, false);
            assert.strictEqual(installs.length, 0);
            assert.ok(destination.startsWith(path.join(storage, 'updates', 'download-')));
        } finally {
            verified.resolve();
            await checking;
        }
        assert.deepStrictEqual(installs, [destination]);
        assert.deepStrictEqual(await fs.readdir(path.join(storage, 'updates')), ['installed.json']);
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(storage, 'updates', 'installed.json'), 'utf8')), '1.2.3');
        assert.strictEqual(errors.length, 0);
    });

    test('검증 실패는 설치하지 않고 임시 파일을 지운 뒤 사용자에게 알린다', async () => {
        respond = chooseInstall;
        const service = makeService({ download: async (_release, destination) => {
            await fs.writeFile(destination, 'corrupt fixture');
            throw new GithubUpdateError('digestMismatch');
        } });
        await service.check();
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(errors.length, 1);
        assert.ok(errors[0].includes('SHA-256'));
        assert.deepStrictEqual(await fs.readdir(path.join(storage, 'updates')), []);
        assert.ok(!messages.some(message => message.items.includes(reloadLabel())));
    });

    test('자동 notify 알림에서 설치를 선택한 사용자는 설치 오류를 확인할 수 있다', async () => {
        respond = chooseInstall;
        await makeService({ download: async () => { throw new GithubUpdateError('invalidVsix'); } }).check(false);
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(installs.length, 0);
    });

    test('확인 진행창 취소 후 늦은 릴리스를 받아도 알림이나 설치를 하지 않는다', async () => {
        const response = deferred<GithubRelease | undefined>();
        const started = deferred<AbortSignal>();
        const service = makeService({ fetchLatest: async signal => { started.resolve(signal); return response.promise; } });
        const checking = service.check();
        const signal = await started.promise;
        try {
            progressSources[0].cancel();
            assert.strictEqual(signal.aborted, true);
        } finally {
            response.resolve(release);
            await checking;
        }
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(installs.length, 0);
    });

    test('dispose 이후 진행 중 확인의 늦은 응답과 재예약을 무시한다', async () => {
        const response = deferred<GithubRelease | undefined>();
        const started = deferred<AbortSignal>();
        const service = makeService({ fetchLatest: async signal => { started.resolve(signal); return response.promise; } });
        const checking = service.check(false);
        const signal = await started.promise;
        service.dispose();
        assert.strictEqual(signal.aborted, true);
        response.resolve(release);
        await checking;
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(activeTimers().length, 0);
    });

    test('알림이 열린 동안 dispose되면 늦게 누른 설치 버튼을 무시한다', async () => {
        const choice = deferred<string | undefined>();
        const opened = deferred<void>();
        respond = async () => { opened.resolve(); return choice.promise; };
        const service = makeService();
        const checking = service.check();
        await opened.promise;
        service.dispose();
        await checking;
        choice.resolve(installLabel());
        assert.strictEqual(downloads.length, 0);
        assert.strictEqual(messages.length, 1);
    });

    test('notify 알림이 열린 중 off 전환도 확인을 해제하여 새 수동 요청을 허용한다', async () => {
        const choice = deferred<string | undefined>();
        const opened = deferred<void>();
        respond = async () => { opened.resolve(); return choice.promise; };
        const service = makeService();
        const checking = service.check(false);
        await opened.promise;
        mode = 'off';
        service.configurationChanged();
        await checking;
        assert.strictEqual(activeTimers().length, 0);
        respond = chooseInstall;
        await service.check();
        choice.resolve(installLabel());
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(fetches, 2);
    });

    test('설치 진행창 취소는 검증 함수가 늦게 완료되어도 설치하지 않는다', async () => {
        respond = chooseInstall;
        const finished = deferred<void>();
        const started = deferred<AbortSignal>();
        const service = makeService({ download: async (_release, _destination, _version, signal) => {
            started.resolve(signal);
            await finished.promise;
        } });
        const checking = service.check();
        const signal = await started.promise;
        progressSources.at(-1)!.cancel();
        assert.strictEqual(signal.aborted, true);
        finished.resolve();
        await checking;
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(errors.length, 0);
        assert.deepStrictEqual(await fs.readdir(path.join(storage, 'updates')), []);
        assert.ok(!messages.some(message => message.items.includes(reloadLabel())));
    });

    test('다운로드 중 auto를 notify로 바꾸면 자동 설치 권한을 철회한다', async () => {
        mode = 'auto';
        const finished = deferred<void>();
        const started = deferred<AbortSignal>();
        const service = makeService({ download: async (_release, _destination, _version, signal) => {
            started.resolve(signal);
            await finished.promise;
        } });
        const checking = service.check(false);
        const signal = await started.promise;
        mode = 'notify';
        service.configurationChanged();
        assert.strictEqual(signal.aborted, true);
        finished.resolve();
        await checking;
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(messages.length, 0);
    });

    test('다른 창이 설치 잠금을 보유하면 다운로드 없이 수동 요청에 안내한다', async () => {
        respond = chooseInstall;
        await withUpdateInstallLock(path.join(storage, 'updates'), async () => {
            await makeService().check();
        });
        assert.strictEqual(downloads.length, 0);
        assert.strictEqual(messages.length, 2);
        assert.strictEqual(messages[1].items.length, 0);
        assert.strictEqual(errors.length, 0);
    });

    test('자동 설치는 액션 종료까지 60초씩 미루고 같은 릴리스를 다시 조회하지 않는다', async () => {
        mode = 'auto';
        running = true;
        const service = makeService();
        await service.check(false);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(downloads.length, 0);
        assert.strictEqual(messages.length, 0);
        assert.strictEqual(activeTimers()[0].delay, 60_000);
        now += 60_000;
        await service.check(false);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(downloads.length, 0);
        running = false;
        now += 60_000;
        await service.check(false);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(installs.length, 1);
    });

    test('다운로드 도중 액션이 시작되어도 설치 직전에 미루고 임시 파일을 정리한다', async () => {
        mode = 'auto';
        const started = deferred<void>();
        const finished = deferred<void>();
        const service = makeService({ download: async (_release, destination) => {
            downloads.push(destination);
            started.resolve();
            await finished.promise;
            await fs.writeFile(destination, 'verified VSIX fixture');
        } });
        const checking = service.check(false);
        await started.promise;
        running = true;
        finished.resolve();
        await checking;
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(activeTimers()[0].delay, 60_000);
        assert.deepStrictEqual(await fs.readdir(path.join(storage, 'updates')), []);
        running = false;
        now += 60_000;
        await service.check(false);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(downloads.length, 2);
        assert.strictEqual(installs.length, 1);
    });

    test('다른 창의 성공 표식은 자동 재설치를 막고 명시적 수동 복구는 허용한다', async () => {
        mode = 'auto';
        await makeService().check(false);
        assert.strictEqual(installs.length, 1);
        now += UPDATE_CHECK_INTERVAL_MS;
        const second = makeService();
        messages = [];
        await second.check(false);
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(messages.length, 0);
        respond = chooseInstall;
        await second.check();
        assert.strictEqual(installs.length, 2);
    });

    test('오래 열린 설치 알림은 다른 창이 설치한 더 높은 버전을 다운그레이드하지 않는다', async () => {
        const choice = deferred<string | undefined>();
        const opened = deferred<void>();
        respond = async (_message, items) => {
            if (items.includes(installLabel())) {
                opened.resolve();
                return choice.promise;
            }
            return undefined;
        };
        const checking = makeService().check();
        await opened.promise;
        try {
            // 사용자가 이전 릴리스 알림을 읽는 동안 다른 창에서 설치를 마친 상황.
            await withUpdateInstallLock(path.join(storage, 'updates'), async installState => {
                await installState.markInstalled('1.2.4');
            });
        } finally {
            choice.resolve(installLabel());
            await checking;
        }
        assert.strictEqual(downloads.length, 0);
        assert.strictEqual(installs.length, 0);
        assert.strictEqual(commands.length, 0);
        assert.deepStrictEqual(messages.at(-1)!.items, [reloadLabel()]);
        assert.ok(messages.at(-1)!.message.includes('1.2.4'));
        assert.strictEqual(JSON.parse(await fs.readFile(path.join(storage, 'updates', 'installed.json'), 'utf8')), '1.2.4');
    });

    test('같은 창은 설치한 버전을 재설치하지 않고 더 높은 새 릴리스만 설치한다', async () => {
        respond = chooseInstall;
        const service = makeService();
        await service.check();
        messages = [];
        await service.check();
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(messages[0].items, [reloadLabel()]);
        release = newRelease('1.2.4');
        await service.check();
        assert.strictEqual(installs.length, 2);
    });

    test('설치 완료 알림을 닫지 않아도 다음 확인을 예약하고 더 높은 버전을 설치한다', async () => {
        mode = 'auto';
        const firstReload = deferred<string | undefined>();
        const secondReload = deferred<string | undefined>();
        respond = async (message, items) => items.includes(reloadLabel())
            ? (message.includes('1.2.3') ? firstReload.promise : secondReload.promise) : undefined;
        const service = makeService();
        try {
            await service.check(false);
            assert.strictEqual(installs.length, 1);
            assert.strictEqual(activeTimers()[0].delay, UPDATE_CHECK_INTERVAL_MS);
            release = newRelease('1.2.4');
            now += UPDATE_CHECK_INTERVAL_MS;
            await service.check(false);
            assert.strictEqual(fetches, 2);
            assert.strictEqual(installs.length, 2);
            firstReload.resolve(reloadLabel());
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(commands.length, 0, '더 높은 버전의 안내가 이전 다시 로드 버튼을 무효화한다');
            secondReload.resolve(reloadLabel());
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.deepStrictEqual(commands, ['workbench.action.reloadWindow']);
        } finally {
            firstReload.resolve(undefined);
            secondReload.resolve(undefined);
        }
    });

    test('설치가 완료된 후 dispose되면 남아 있는 다시 로드 알림의 클릭을 무시한다', async () => {
        const reload = deferred<string | undefined>();
        respond = async (_message, items) => items.includes(installLabel()) ? installLabel() : reload.promise;
        const service = makeService();
        try {
            await service.check();
            assert.strictEqual(installs.length, 1);
            await service.check();
            assert.strictEqual(fetches, 2, '완료 안내가 다음 수동 확인을 막으면 안 된다');
            service.dispose();
            reload.resolve(reloadLabel());
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(commands.length, 0);
        } finally {
            reload.resolve(undefined);
        }
    });

    test('설치 완료 안내에서 다시 로드 명령이 실패해도 오류를 처리한다', async () => {
        respond = async (_message, items) => items.includes(installLabel()) ? installLabel() : reloadLabel();
        vscode.commands.executeCommand = async () => { throw new Error('reload failed'); };
        await makeService().check();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(errors.length, 1);
    });

    test('다시 로드 버튼을 누른 시점에 실행 액션을 확인하고 명시적 선택만 실행한다', async () => {
        const busyNotice = deferred<void>();
        respond = async (_message, items) => {
            if (items.includes(installLabel())) { return installLabel(); }
            if (items.includes(reloadLabel())) { running = true; return reloadLabel(); }
            busyNotice.resolve();
            return undefined;
        };
        const service = makeService();
        await service.check();
        await busyNotice.promise;
        assert.strictEqual(installs.length, 1);
        assert.strictEqual(commands.length, 0);
        assert.strictEqual(messages.at(-1)!.items.length, 0);
        running = false;
        const reloaded = deferred<void>();
        (vscode.commands as any).executeCommand = async (command: string) => {
            commands.push(command);
            reloaded.resolve();
        };
        respond = async (_message, items) => items.includes(reloadLabel()) ? reloadLabel() : undefined;
        await service.check();
        await reloaded.promise;
        assert.deepStrictEqual(commands, ['workbench.action.reloadWindow']);
        assert.strictEqual(installs.length, 1);
    });

    test('릴리스 보기를 선택하면 해당 릴리스만 열고 설치하지 않는다', async () => {
        respond = async (_message, items) => items.includes(t('릴리스 보기', 'View Release'))
            ? t('릴리스 보기', 'View Release') : undefined;
        await makeService().check();
        assert.deepStrictEqual(externalUrls, [release!.releaseUrl]);
        assert.strictEqual(downloads.length, 0);
    });

    test('알 수 없는 실패의 경로·URL·응답 내용을 오류 안내와 로그에 노출하지 않는다', async () => {
        const secret = 'https://example.invalid/?token=private-value /private/user/file';
        await makeService({ fetchLatest: async () => { throw new Error(secret); } }).check();
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(logs.length, 1);
        assert.ok([...errors, ...logs].every(message => !message.includes('private-value')));
    });
});
