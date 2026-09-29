import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter, once } from 'events';
import { killProcessTree } from '../extension';

suite('프로세스 트리 정상 정리 유예', function () {
    this.timeout(10000);
    let workspace: string;
    const children: ChildProcess[] = [];

    setup(function () {
        if (process.platform === 'win32') { this.skip(); }
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-process-tree-'));
    });

    teardown(async () => {
        for (const child of children.splice(0)) {
            const exited = child.exitCode !== null || child.signalCode !== null;
            const pipesClosed = (!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed);
            if (child.pid && (!exited || !pipesClosed)) {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited or not detached. */ }
            }
            if (child.exitCode === null && child.signalCode === null) {
                const closed = once(child, 'close');
                child.kill('SIGKILL');
                await closed;
            }
        }
        if (workspace) { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    });

    function start(source: string, detached = true): ChildProcess {
        const script = path.join(workspace, `parent-${children.length}.cjs`);
        fs.writeFileSync(script, source);
        const child = spawn('node', [script], { cwd: workspace, detached, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.resume();
        child.stderr?.resume();
        children.push(child);
        return child;
    }

    async function waitForFile(name: string): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(workspace, name)) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(fs.existsSync(path.join(workspace, name)), `Child did not create ${name}.`);
    }

    test('부모와 자손의 SIGTERM 정리가 끝난 뒤 반환하고 중복 Stop은 같은 종료를 기다린다', async () => {
        fs.writeFileSync(path.join(workspace, 'descendant.cjs'), `
            const fs = require('fs');
            process.on('SIGTERM', () => setTimeout(() => {
                fs.writeFileSync('descendant.cleaned', 'done'); process.exit(0);
            }, 100));
            process.stdout.write('ready');
            setInterval(() => {}, 1000);
        `);
        const child = start(`
            const fs = require('fs');
            const sub = require('child_process').spawn('node', ['descendant.cjs']);
            let cleaned = false, subClosed = false;
            const finish = () => { if (cleaned && subClosed) { process.exit(0); } };
            sub.stdout.once('data', () => fs.writeFileSync('ready', 'ready'));
            sub.on('close', () => { subClosed = true; finish(); });
            process.on('SIGTERM', () => setTimeout(() => {
                fs.writeFileSync('parent.cleaned', 'done'); cleaned = true; finish();
            }, 50));
        `);
        await waitForFile('ready');
        const exitListeners = child.listenerCount('exit');
        const closeListeners = child.listenerCount('close');
        const termination = killProcessTree(child);
        assert.strictEqual(killProcessTree(child), termination, 'Overlapping stop paths must share one termination attempt.');
        assert.strictEqual(await termination, true);
        assert.strictEqual(fs.readFileSync(path.join(workspace, 'parent.cleaned'), 'utf8'), 'done');
        assert.strictEqual(fs.readFileSync(path.join(workspace, 'descendant.cleaned'), 'utf8'), 'done');
        assert.strictEqual(child.exitCode, 0);
        assert.strictEqual(child.listenerCount('exit'), exitListeners);
        assert.strictEqual(child.listenerCount('close'), closeListeners);
        assert.throws(() => process.kill(-child.pid!, 0), /ESRCH/);
        assert.strictEqual(killProcessTree(child), termination, 'A completed tree termination must not signal the old PID again.');
    });

    test('셸 역할의 부모가 먼저 종료돼도 SIGTERM을 무시한 자손을 유예 후 종료한다', async () => {
        fs.writeFileSync(path.join(workspace, 'descendant.cjs'), `
            const fs = require('fs');
            process.on('SIGTERM', () => fs.writeFileSync('term.received', 'received'));
            fs.writeFileSync('descendant.pid', String(process.pid));
            setInterval(() => {}, 1000);
        `);
        const child = start(`
            require('child_process').spawn('node', ['descendant.cjs'], { stdio: 'inherit' });
            setInterval(() => {}, 1000);
        `);
        await waitForFile('descendant.pid');
        const closed = once(child, 'close');
        const started = Date.now();
        await killProcessTree(child);
        await closed;
        assert.strictEqual(fs.readFileSync(path.join(workspace, 'term.received'), 'utf8'), 'received');
        assert.ok(Date.now() - started >= 900, 'The descendant must get its grace period before SIGKILL.');
        assert.strictEqual(child.signalCode, 'SIGTERM', 'The parent should exit before the forced descendant cleanup.');
        // close는 자손이 상속한 stdout/stderr까지 닫혀야 도착한다.
        assert.strictEqual(child.stdout?.destroyed, true);
        assert.strictEqual(child.stderr?.destroyed, true);
    });

    test('프로세스 그룹이 없는 자식도 강제 종료 전에 SIGTERM 정리 기회를 받는다', async () => {
        const child = start(`
            const fs = require('fs');
            process.on('SIGTERM', () => setTimeout(() => {
                fs.writeFileSync('cleaned', 'done'); process.exit(0);
            }, 50));
            fs.writeFileSync('ready', 'ready');
            setInterval(() => {}, 1000);
        `, false);
        await waitForFile('ready');
        assert.strictEqual(await killProcessTree(child), false, 'A direct-child fallback cannot claim the whole tree was signalled.');
        assert.strictEqual(child.exitCode, 0);
        assert.strictEqual(fs.readFileSync(path.join(workspace, 'cleaned'), 'utf8'), 'done');
    });


    test('이미 종료되고 파이프까지 닫힌 child의 첫 Stop도 이전 PID에 신호를 보내지 않는다', async () => {
        const child = start('process.exit(0);');
        await once(child, 'close');
        const originalKill = process.kill;
        process.kill = (() => { assert.fail('A fully closed child must not signal its old process group.'); }) as typeof process.kill;
        try {
            assert.strictEqual(await killProcessTree(child), false);
        } finally {
            process.kill = originalKill;
        }
    });

    test('그룹 소멸을 확인한 뒤에는 유예 타이머가 재사용된 그룹 ID에 신호를 보내지 않는다', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 2147483646, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
            kill: () => { assert.fail('A disappeared group must not receive a delayed direct signal.'); },
        }) as unknown as ChildProcess;
        const originalKill = process.kill;
        const signals: Array<NodeJS.Signals | number | undefined> = [];
        let groupProbes = 0;
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid !== -child.pid!) { return originalKill(pid, signal); }
            signals.push(signal);
            if (signal === 0 && groupProbes++ === 0) {
                throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            }
            return true;
        }) as typeof process.kill;
        try {
            const termination = killProcessTree(child);
            // exit 전달이 늦어져 유예 타이머가 먼저 돌아도 이미 사라진 그룹에는 보내지 않는다.
            await new Promise(resolve => setTimeout(resolve, 1100));
            Object.assign(child, { exitCode: 0 });
            child.emit('exit', 0, null);
            assert.strictEqual(await termination, true);
            assert.deepStrictEqual(signals, ['SIGTERM', 0]);
            assert.strictEqual(child.listenerCount('exit'), 0);
            assert.strictEqual(child.listenerCount('close'), 0);
        } finally {
            process.kill = originalKill;
        }
    });
});
