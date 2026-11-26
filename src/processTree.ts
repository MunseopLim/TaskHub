import { spawn } from 'node:child_process';

// Stop/timeout/출력 상한이 겹쳐도 종료를 공유한다. 확인된 종료도 기억해 PID 재사용 후 재신호하지 않는다.
const pendingProcessTreeKills = new WeakMap<ReturnType<typeof spawn>, Promise<boolean>>();

/**
 * spawn 한 프로세스와 같은 그룹의 자손을 종료한다.
 *
 * POSIX는 그룹에 SIGTERM을 보내 정리할 시간을 1초 주고, 남은 그룹만 SIGKILL로
 * 종료한다. 셸 래퍼가 먼저 종료돼도 자손의 정리를 기다린다. 그룹이 없으면 직접
 * child를 종료한다. Windows의 taskkill /T /F는 협력적 종료를 보장하지 않으므로
 * 기존 강제 트리 종료를 유지한다. 어느 경로든 전체 대기는 최대 2초다.
 */
export function terminateProcessTree(child: ReturnType<typeof spawn>, warn?: (message: string) => void): Promise<boolean> {
    if (!child || typeof child.pid !== 'number') {
        try { child?.kill(); } catch { /* ignore */ }
        return Promise.resolve(false);
    }
    const pending = pendingProcessTreeKills.get(child);
    if (pending) { return pending; }
    const pid = child.pid;
    // `child.killed`는 종료 여부가 아니라 시그널 전송 여부이므로 쓰지 않는다.
    const hasExited = () => child.exitCode !== null || child.signalCode !== null;
    if (hasExited() && (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)) {
        // 파이프까지 이미 닫힌 이전 실행의 PID는 더 이상 신호 대상으로 삼지 않는다.
        return Promise.resolve(false);
    }
    let groupGone = false;
    const killDirect = (signal: NodeJS.Signals) => {
        // 종료를 관찰한 child의 PID를 나중에 다시 사용하지 않는다.
        if (!hasExited()) { try { child.kill(signal); } catch { /* ignore */ } }
    };
    const termination = new Promise<boolean>(resolve => {
        let settled = false;
        let groupSignalled = false;
        let windowsRequestFinished = false;
        let windowsTreeKilled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let taskkill: ReturnType<typeof spawn> | undefined;

        const groupExists = () => {
            if (groupGone) { return false; }
            try { process.kill(-pid, 0); return true; } catch (error) {
                // 소멸을 한 번 관찰한 그룹 ID는 재사용될 수 있으므로 다시 신호를 보내지 않는다.
                groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
                return !groupGone;
            }
        };
        const finish = (treeKilled: boolean) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(deadline);
            if (graceTimer) { clearTimeout(graceTimer); }
            if (pollTimer) { clearInterval(pollTimer); }
            child.removeListener('exit', checkExited);
            child.removeListener('close', checkExited);
            resolve(treeKilled);
        };
        const checkExited = () => {
            if (settled) { return; }
            if (process.platform === 'win32') {
                if (windowsRequestFinished && hasExited()) { finish(windowsTreeKilled); }
            } else if (groupSignalled) {
                // 래퍼의 exit만으로 grace timer를 지우면 SIGTERM을 무시하는 자손이
                // 남는다. 그룹 소멸을 관찰하면 지연된 SIGKILL도 함께 취소한다.
                if (!groupExists() && hasExited()) { finish(true); }
            } else if (hasExited()) {
                finish(false);
            }
        };
        const deadline = setTimeout(() => {
            if (settled) { return; }
            warn?.(`[WARN] Process tree termination for pid ${pid} did not confirm within 2s; continuing.`);
            if (!groupGone) { killDirect('SIGKILL'); }
            // taskkill 자체가 멈췄어도 취소 처리는 상한 내에 끝나야 한다.
            if (taskkill && taskkill.exitCode === null && taskkill.signalCode === null) {
                try { taskkill.kill(); } catch { /* ignore */ }
            }
            finish(false);
        }, 2000);
        child.on('exit', checkExited);
        child.on('close', checkExited);

        if (process.platform === 'win32') {
            const completeRequest = (treeKilled: boolean) => {
                if (settled || windowsRequestFinished) { return; }
                windowsRequestFinished = true;
                windowsTreeKilled = treeKilled;
                if (!treeKilled) { killDirect('SIGKILL'); }
                checkExited();
            };
            try {
                taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
            } catch {
                completeRequest(false);
                return;
            }
            taskkill.on('error', () => completeRequest(false));
            taskkill.on('close', (code) => {
                if (settled || windowsRequestFinished) { return; }
                if (code !== 0) {
                    warn?.(`[WARN] taskkill /T /F on pid ${pid} exited with ${code}; falling back to direct kill.`);
                }
                completeRequest(code === 0);
            });
        } else {
            try {
                process.kill(-pid, 'SIGTERM');
                groupSignalled = true;
            } catch {
                // detached가 없는 프로세스 등: 같은 방식으로 직접 종료를 시도한다.
                killDirect('SIGTERM');
            }
            checkExited();
            if (settled) { return; }
            pollTimer = setInterval(checkExited, 25);
            graceTimer = setTimeout(() => {
                checkExited();
                if (settled) { return; }
                if (groupSignalled && groupExists()) {
                    try { process.kill(-pid, 'SIGKILL'); } catch { killDirect('SIGKILL'); }
                } else if (!groupSignalled) {
                    killDirect('SIGKILL');
                }
                checkExited();
            }, 1000);
        }
    }).then(treeKilled => {
        // 실패한 살아 있는 대상만 다음 Stop에서 재시도한다. WeakMap이므로 child와 함께 정리된다.
        if (!treeKilled && !groupGone) { pendingProcessTreeKills.delete(child); }
        return treeKilled;
    });
    pendingProcessTreeKills.set(child, termination);
    return termination;
}
