import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { valid } from 'semver';

const markerLimitBytes = 4096;

export interface UpdateInstallState {
    readonly installedVersion?: string;
    /** 임대 갱신 실패 시 중단된다. 다운로드에 연결하고 설치 명령 직전에 확인한다. */
    readonly signal: AbortSignal;
    markInstalled(version: string): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

function isVersion(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 256 && valid(value) !== null;
}

async function readInstalledVersion(markerPath: string): Promise<string | undefined> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(markerPath, 'r');
    } catch (error) {
        if (hasCode(error, 'ENOENT')) {
            return undefined;
        }
        throw error;
    }

    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > markerLimitBytes) {
            return undefined;
        }
        // stat 이후 파일이 늘어나도 읽기 상한을 넘지 않는다.
        const buffer = Buffer.alloc(markerLimitBytes + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (bytesRead === 0) {
                break;
            }
            size += bytesRead;
        }
        if (size > markerLimitBytes) {
            return undefined;
        }
        let value: unknown;
        try {
            value = JSON.parse(buffer.toString('utf8', 0, size));
        } catch (error) {
            if (error instanceof SyntaxError) {
                return undefined;
            }
            throw error;
        }
        return isVersion(value) ? value : undefined;
    } finally {
        await handle.close();
    }
}

/**
 * 같은 저장소를 공유하는 확장 창/프로세스의 다운로드·설치를 하나로 제한한다.
 * callback은 사용자 입력을 기다리지 않고, 취소 신호를 설치 직전에도 확인해야 한다.
 */
export async function withUpdateInstallLock<T>(
    storageDirectory: string,
    callback: (state: UpdateInstallState) => Promise<T>
): Promise<{ acquired: false } | { acquired: true; value: T }> {
    await fs.mkdir(storageDirectory, { recursive: true });
    const controller = new AbortController();
    let release: () => Promise<void>;
    try {
        release = await lockfile.lock(storageDirectory, {
            realpath: false,
            lockfilePath: path.join(storageDirectory, 'install.lock'),
            retries: 0,
            stale: 120_000,
            update: 10_000,
            onCompromised: error => controller.abort(error),
        });
    } catch (error) {
        if (hasCode(error, 'ELOCKED')) {
            return { acquired: false };
        }
        throw error;
    }

    let active = true;
    let failed = false;
    try {
        const markerPath = path.join(storageDirectory, 'installed.json');
        let installedVersion = await readInstalledVersion(markerPath);
        const checkLock = (): void => {
            if (controller.signal.aborted) {
                throw controller.signal.reason ?? new Error('Update installation lock was cancelled.');
            }
            if (!active) {
                throw new Error('Update installation lock has been released.');
            }
        };
        checkLock();
        const state: UpdateInstallState = {
            get installedVersion() { return installedVersion; },
            signal: controller.signal,
            async markInstalled(version) {
                checkLock();
                if (!isVersion(version)) {
                    throw new Error('Invalid installed extension version.');
                }
                const temporaryPath = path.join(storageDirectory, `installed-${randomUUID()}.tmp`);
                try {
                    await fs.writeFile(temporaryPath, JSON.stringify(version), { flag: 'wx', mode: 0o600 });
                    checkLock();
                    await fs.rename(temporaryPath, markerPath);
                    installedVersion = version;
                } finally {
                    await fs.rm(temporaryPath, { force: true });
                }
            },
        };
        const value = await callback(state);
        checkLock();
        return { acquired: true, value };
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        active = false;
        try {
            await release();
        } catch (error) {
            // 갱신 실패로 해제된 잠금의 ERELEASED가 원래 실패 원인을 덮지 않게 한다.
            if (!failed) {
                throw error;
            }
        }
    }
}
