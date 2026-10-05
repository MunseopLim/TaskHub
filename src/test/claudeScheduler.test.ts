import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { CLAUDE_SCHEDULES_KEY, ClaudeRunResult, ClaudeSchedule, ClaudeScheduler, ClaudeSchedulerState, nextClaudeRun, readSchedulerState } from '../claudeScheduler/model';
import { ClaudeSchedulerController, registerClaudeScheduler } from '../claudeScheduler/controller';
import { ClaudeCliOptions, claudeArguments, claudeReportDirectory, formatClaudeCommand, parseClaudeResult, pruneClaudeReports, readClaudeReport, runScheduledClaude, supportsClaudeVersion } from '../claudeScheduler/runner';
import { ClaudeSchedulesProvider } from '../providers/claudeSchedulesProvider';
import { killProcessTree } from '../extension';
import { buildFeatureLauncherItems } from '../featureLauncher';
import { aiScheduleSetting, aiSchedulesEnabled } from '../claudeScheduler/settings';

function job(overrides: Partial<ClaudeSchedule> = {}): ClaudeSchedule {
    return { id: randomUUID(), name: '정기 점검', workspacePath: path.resolve('/workspace'), promptPath: path.resolve('/workspace/prompt.md'),
        mode: 'analysis', cadence: { kind: 'interval', minutes: 1 }, enabled: true, nextRunAt: 60000, ...overrides };
}
function success(now = 60000): ClaudeRunResult { return { status: 'success', startedAt: now, finishedAt: now + 1 }; }
function flagValues(args: string[], flag: string): string[] {
    const start = args.indexOf(flag) + 1;
    const end = args.findIndex((value, index) => index >= start && value.startsWith('--'));
    return args.slice(start, end < 0 ? args.length : end);
}
function reportInvocations(report: string): Array<{ phase: string; executable: string; args: string[]; cwd: string;
    shell: boolean; started: boolean; stdinStatus: string; stdinBytes: number }> {
    return JSON.parse(report.slice(report.lastIndexOf('\n\n') + 2));
}
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!await condition()) {
        if (Date.now() > deadline) { throw new Error('Condition did not become true.'); }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
function fixtureEngine(jobs: ClaudeSchedule[] = []) {
    let now = 0;
    let saved: ClaudeSchedulerState | undefined;
    let failSave = false;
    let run: (job: ClaudeSchedule, signal: AbortSignal, slot?: number) => Promise<ClaudeRunResult> = async () => success(now);
    const calls: Array<{ job: ClaudeSchedule; slot?: number }> = [];
    const errors: unknown[] = [];
    const timers = new Set<{ delay: number; fire(): void; dispose(): void }>();
    const engine = new ClaudeScheduler({ version: 1, jobs }, {
        now: () => now,
        schedule: (_callback, delay) => {
            const timer = { delay, fire: _callback, dispose: () => { timers.delete(timer); } }; timers.add(timer); return timer;
        },
        save: async state => { if (failSave) { throw new Error('injected storage failure'); } saved = structuredClone(state); },
        run: (item, signal, slot) => { calls.push({ job: item, slot }); return run(item, signal, slot); },
        changed: () => {}, error: error => { errors.push(error); },
    });
    return { engine, calls, timers, errors, now: (value: number) => { now = value; }, saved: () => saved,
        failSave: (value = true) => { failSave = value; }, runner: (value: typeof run) => { run = value; } };
}

suite('Claude scheduler clock, persistence and lifecycle', () => {
    test('interval boundaries and local daily rollover always produce a future time', () => {
        assert.strictEqual(nextClaudeRun({ kind: 'interval', minutes: 1 }, 100), 60100);
        const before = new Date(2026, 9, 4, 8, 59).getTime();
        const at = new Date(2026, 9, 4, 9, 0).getTime();
        assert.strictEqual(nextClaudeRun({ kind: 'daily', hour: 9, minute: 0 }, before), at);
        assert.strictEqual(nextClaudeRun({ kind: 'daily', hour: 9, minute: 0 }, at), new Date(2026, 9, 5, 9, 0).getTime());
        assert.throws(() => nextClaudeRun({ kind: 'interval', minutes: 0 }, 0));
        assert.throws(() => nextClaudeRun({ kind: 'daily', hour: 24, minute: 0 }, 0));
    });
    test('daily scheduling skips the second DST fold and advances a missing spring time', () => {
        const script = `const {nextClaudeRun}=require(${JSON.stringify(path.resolve(__dirname, '../claudeScheduler/model.js'))});
            const spring=nextClaudeRun({kind:'daily',hour:2,minute:30},new Date('2026-03-08T06:00:00Z').getTime());
            const fold=nextClaudeRun({kind:'daily',hour:1,minute:30},new Date('2026-11-01T05:30:00Z').getTime());
            console.log(JSON.stringify([new Date(spring).toISOString(),new Date(fold).toISOString()]));`;
        const values = JSON.parse(execFileSync('node', ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
        assert.deepStrictEqual(values, ['2026-03-08T07:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    });
    test('corrupt, duplicate, oversized and unsafe persisted definitions are rejected without overwriting', () => {
        const item = job();
        for (const raw of [null, {}, { version: 2, jobs: [] }, { version: 1, jobs: [item, item] },
            { version: 1, jobs: [job({ mode: 'bypass' as 'edit' })] }, { version: 1, jobs: [job({ id: '../escape' })] },
            { version: 1, jobs: [job({ lastRun: { ...success(), report: '../token.txt' } })] },
            { version: 1, jobs: Array.from({ length: 51 }, () => job()) }]) {
            assert.throws(() => readSchedulerState(raw));
        }
        for (const bashRules of [['Bash'], ['Bash(*)'], ['Bash(* *)'], ['Bash(:*)'], ['Bash( :*)'], ['Bash( )'], ['Read(./**)'], ['Bash(echo ok)\nBash(rm *)']]) {
            assert.throws(() => readSchedulerState({ version: 1, jobs: [job({ bashRules })] }));
        }
        const bashRules = ['Bash(git diff *)', 'Bash(git diff:*)', 'Bash(npm test)'];
        assert.deepStrictEqual(readSchedulerState({ version: 1, jobs: [job({ bashRules })] }).jobs[0].bashRules, bashRules);
        const state = { version: 1 as const, jobs: [item] };
        const copy = readSchedulerState(state); copy.jobs[0].name = 'changed';
        assert.strictEqual(state.jobs[0].name, item.name);
    });
    test('restart skips missed times and pauses interrupted work instead of reporting completion', async () => {
        const f = fixtureEngine([job({ nextRunAt: 0, lastRun: { status: 'running', startedAt: 0 } }), job({ nextRunAt: 0 })]);
        f.now(120000); await f.engine.initialize();
        assert.strictEqual(f.engine.list()[0].enabled, false);
        assert.strictEqual(f.engine.list()[0].lastRun?.status, 'interrupted');
        assert.strictEqual(f.engine.list()[1].nextRunAt, 180000);
        await f.engine.tick(); assert.strictEqual(f.calls.length, 0);
        await f.engine.shutdown(); assert.strictEqual(f.timers.size, 0);
    });
    test('different window wake times keep the same interval grid after a missed run', async () => {
        const a = fixtureEngine([job()]); const b = fixtureEngine(a.engine.list());
        a.now(121001); b.now(125501);
        await a.engine.initialize(); await b.engine.initialize();
        assert.strictEqual(a.engine.list()[0].nextRunAt, 180000);
        assert.strictEqual(b.engine.list()[0].nextRunAt, 180000);
        await a.engine.shutdown(); await b.engine.shutdown();
    });
    test('slot reservation is durable before dispatch and results remain in storage', async () => {
        const item = job(); const f = fixtureEngine([item]); await f.engine.initialize();
        f.runner(async (_job, _signal, slot) => {
            assert.strictEqual(slot, 60000); assert.strictEqual(f.saved()?.jobs[0].nextRunAt, 120000);
            assert.strictEqual(f.saved()?.jobs[0].lastRun?.status, 'running'); return success();
        });
        f.now(60000); await f.engine.tick(); await until(() => f.engine.runningId === undefined && f.calls.length === 1);
        assert.strictEqual(f.saved()?.jobs[0].lastRun?.status, 'success');
        await f.engine.shutdown();
    });
    test('same-time schedules run in FIFO order with one pending slot each, including daily jobs', async () => {
        for (const cadence of [{ kind: 'interval' as const, minutes: 60 }, { kind: 'daily' as const, hour: 9, minute: 0 }]) {
            const due = cadence.kind === 'daily' ? new Date(2026, 9, 4, 9).getTime() : 60 * 60000;
            const a = job({ cadence, nextRunAt: due }); const b = job({ cadence, nextRunAt: due });
            const f = fixtureEngine([a, b]); f.now(due - 1); await f.engine.initialize();
            const releases: Array<(result: ClaudeRunResult) => void> = [];
            f.runner(() => new Promise(resolve => { releases.push(resolve); }));
            f.now(due); await Promise.all([f.engine.tick(), f.engine.tick()]); await until(() => f.calls.length === 1);
            assert.deepStrictEqual(f.engine.queuedIds, [b.id]);
            assert.strictEqual(f.engine.list()[1].lastRun?.status, 'queued');
            assert.strictEqual(await f.engine.runNow(b.id), false);
            f.now(due + 24 * 60 * 60000); await f.engine.tick();
            assert.deepStrictEqual(f.engine.queuedIds, [b.id]);
            releases[0](success(due)); await until(() => f.calls.length === 2);
            assert.deepStrictEqual(f.calls.map(call => call.job.id), [a.id, b.id]);
            assert.deepStrictEqual(f.calls.map(call => call.slot), [due, due]);
            releases[1](success(due)); await until(() => !f.engine.runningId);
            await f.engine.shutdown();
        }
    });
    test('pausing a queued job cancels its slot and sleep does not create catch-up requests', async () => {
        const a = job(); const b = job(); const f = fixtureEngine([a, b]); await f.engine.initialize();
        let release!: (result: ClaudeRunResult) => void;
        f.runner(() => new Promise(resolve => { release = resolve; }));
        f.now(60000); await f.engine.tick(); await until(() => f.calls.length === 1);
        assert.strictEqual(await f.engine.runNow(b.id), false);
        assert.strictEqual(f.engine.list().find(item => item.id === b.id)?.lastRun?.status, 'queued');
        await f.engine.setEnabled(b.id, false);
        assert.deepStrictEqual(f.engine.queuedIds, []);
        f.now(120000); await f.engine.tick(); assert.strictEqual(f.calls.length, 1);
        release(success()); await until(() => !f.engine.runningId);
        f.now(600000); await f.engine.tick(); assert.strictEqual(f.calls.length, 1);
        assert.strictEqual(f.engine.list()[0].nextRunAt, 660000);
        assert.strictEqual(f.engine.list()[0].lastRun?.detail, 'scheduler-missed');
        assert.strictEqual(f.calls.length, 1);
        await f.engine.shutdown();
    });
    test('editing a stale wizard snapshot preserves the latest failure, report and pause', async () => {
        const item = job(); const f = fixtureEngine([item]); await f.engine.initialize();
        const stale = f.engine.list()[0];
        f.runner(async () => ({ ...success(), status: 'failed', report: `${randomUUID()}.txt` }));
        await f.engine.runNow(item.id);
        const latest = f.engine.list()[0];
        await f.engine.put({ ...stale, name: 'edited name' });
        assert.strictEqual(f.engine.list()[0].name, 'edited name');
        assert.strictEqual(f.engine.list()[0].enabled, false);
        assert.deepStrictEqual(f.engine.list()[0].lastRun, latest.lastRun);
        await f.engine.shutdown();
    });
    test('field edits preserve the original clock, while a changed cadence starts a new clock', async () => {
        const item = job({ mode: 'edit', bashRules: ['Bash(npm test)'] });
        const f = fixtureEngine([item]);
        try {
            await f.engine.initialize(); f.now(59000);
            await f.engine.update(item.id, { name: 'renamed' });
            await f.engine.update(item.id, { cadence: { kind: 'interval', minutes: 1 } });
            assert.strictEqual(f.engine.list()[0].nextRunAt, 60000);
            assert.deepStrictEqual(f.engine.list()[0], { ...item, name: 'renamed' });
            f.now(60000); await f.engine.tick(); await until(() => !f.engine.runningId && f.calls.length === 1);
            assert.strictEqual(f.calls[0].slot, 60000);
            const latest = f.engine.list()[0];
            f.now(70000); await f.engine.update(item.id, { cadence: { kind: 'interval', minutes: 2 } });
            assert.deepStrictEqual(f.engine.list()[0], { ...latest, cadence: { kind: 'interval', minutes: 2 }, nextRunAt: 190000 });
            const daily = { kind: 'daily' as const, hour: 9, minute: 30 };
            await f.engine.update(item.id, { cadence: daily });
            assert.strictEqual(f.engine.list()[0].nextRunAt, nextClaudeRun(daily, 70000));
            const due = f.engine.list()[0].nextRunAt;
            f.now(80000); await f.engine.update(item.id, { cadence: { ...daily } });
            assert.strictEqual(f.engine.list()[0].nextRunAt, due);
        } finally { await f.engine.shutdown(); }
    });
    test('edits apply to current fields and never recreate a deleted schedule or dispatch after invalid input', async () => {
        const item = job(); const f = fixtureEngine([item]);
        try {
            await f.engine.initialize();
            await f.engine.update(item.id, { name: 'latest name' });
            await f.engine.update(item.id, { promptPath: path.resolve('/workspace/new.md') });
            const latest = f.engine.list()[0]; assert.strictEqual(latest.name, 'latest name');
            for (const changes of [{ cadence: { kind: 'interval' as const, minutes: 0 } }, { bashRules: ['Bash(*)'] }]) {
                await assert.rejects(f.engine.update(item.id, changes));
                assert.deepStrictEqual(f.engine.list()[0], latest);
                assert.deepStrictEqual(f.saved()?.jobs[0], latest);
            }
            await f.engine.remove(item.id);
            assert.strictEqual(await f.engine.update(item.id, { name: 'must not return' }), false);
            assert.deepStrictEqual(f.engine.list(), []); assert.deepStrictEqual(f.saved()?.jobs, []);
        } finally { await f.engine.shutdown(); }
    });
    test('active and queued schedules reject field edits, and save failures leave edits unapplied', async () => {
        const a = job(); const b = job(); const f = fixtureEngine([a, b]);
        let release: ((result: ClaudeRunResult) => void) | undefined;
        try {
            await f.engine.initialize(); f.runner(() => new Promise(resolve => { release = resolve; }));
            f.now(60000); await f.engine.tick(); await until(() => f.calls.length === 1);
            for (const id of [a.id, b.id]) {
                await assert.rejects(f.engine.update(id, { name: 'blocked' }), { code: 'running' });
            }
            await f.engine.setEnabled(b.id, false);
            const latest = f.engine.list(); f.failSave();
            await assert.rejects(f.engine.update(b.id, { name: 'not saved' }), /storage failure/);
            assert.deepStrictEqual(f.engine.list(), latest);
        } finally { f.failSave(false); release?.(success()); await f.engine.shutdown(); }
    });
    test('manual pause timestamps persist across edits and restart, and resume clears them', async () => {
        const item = job({ lastRun: success(10) }); const f = fixtureEngine([item]);
        try {
            await f.engine.initialize(); f.now(20000); await f.engine.setEnabled(item.id, false);
            assert.strictEqual(f.engine.list()[0].pausedAt, 20000);
            f.now(30000); await f.engine.setEnabled(item.id, false); await f.engine.update(item.id, { name: 'paused name' });
            assert.strictEqual(f.saved()?.jobs[0].pausedAt, 20000);
            assert.deepStrictEqual(f.engine.list()[0].lastRun, item.lastRun);
            const restarted = fixtureEngine(f.saved()?.jobs);
            try {
                restarted.now(40000); await restarted.engine.initialize();
                assert.strictEqual(restarted.engine.list()[0].pausedAt, 20000);
                await restarted.engine.setEnabled(item.id, true);
                assert.strictEqual(restarted.engine.list()[0].pausedAt, undefined);
                assert.strictEqual(restarted.engine.list()[0].nextRunAt, 100000);
                assert.strictEqual(restarted.saved()?.jobs[0].enabled, true);
            } finally { await restarted.engine.shutdown(); }
            // A cadence edit while paused keeps the pause; resume schedules from the new cadence.
            f.now(45000); await f.engine.update(item.id, { cadence: { kind: 'interval', minutes: 2 } });
            assert.strictEqual(f.engine.list()[0].enabled, false); assert.strictEqual(f.engine.list()[0].pausedAt, 20000);
            f.now(50000); await f.engine.setEnabled(item.id, true);
            assert.strictEqual(f.engine.list()[0].nextRunAt, 170000);
        } finally { await f.engine.shutdown(); }
    });
    test('failure and interrupted restart record the actual pause time, while queued shutdown stays enabled', async () => {
        const item = job(); const f = fixtureEngine([item]);
        try {
            await f.engine.initialize();
            f.runner(async () => { f.now(25000); return { ...success(10000), status: 'failed' }; });
            f.now(10000); await f.engine.runNow(item.id);
            assert.strictEqual(f.saved()?.jobs[0].pausedAt, 25000);
            await f.engine.update(item.id, { name: 'failed name' });
            assert.strictEqual(f.engine.list()[0].pausedAt, 25000);
        } finally { await f.engine.shutdown(); }
        const interrupted = job({ lastRun: { status: 'running', startedAt: 10 } });
        const queued = job({ lastRun: { status: 'queued', startedAt: 10 } });
        const restarted = fixtureEngine([interrupted, queued]);
        try {
            restarted.now(50000); await restarted.engine.initialize();
            assert.strictEqual(restarted.saved()?.jobs[0].pausedAt, 50000);
            assert.strictEqual(restarted.saved()?.jobs[0].lastRun?.status, 'interrupted');
            assert.strictEqual(restarted.saved()?.jobs[1].pausedAt, undefined);
            assert.strictEqual(restarted.saved()?.jobs[1].enabled, true);
        } finally { await restarted.engine.shutdown(); }
        // Legacy paused jobs have no known pause time; later pauses and failures must not invent one.
        const legacy = job({ enabled: false, lastRun: success(10) });
        const legacyFailed = job({ enabled: false });
        const old = fixtureEngine([legacy, legacyFailed]);
        try {
            old.now(60000); await old.engine.initialize();
            await old.engine.setEnabled(legacy.id, false);
            assert.strictEqual(old.saved()?.jobs[0].pausedAt, undefined);
            old.runner(async () => ({ ...success(60000), status: 'failed', finishedAt: 61000 }));
            await old.engine.runNow(legacyFailed.id);
            assert.strictEqual(old.saved()?.jobs[1].pausedAt, undefined);
            assert.strictEqual(old.saved()?.jobs[1].lastRun?.finishedAt, 61000);
        } finally { await old.engine.shutdown(); }
        for (const pausedAt of [-1, NaN, 'yesterday']) {
            assert.throws(() => readSchedulerState({ version: 1, jobs: [{ ...item, pausedAt }] }));
        }
        assert.strictEqual(readSchedulerState({ version: 1, jobs: [{ ...item, enabled: false }] }).jobs[0].pausedAt, undefined);
    });
    test('shutdown skips never-started slots and keeps queued schedules enabled on restart', async () => {
        const a = job(); const b = job(); const f = fixtureEngine([a, b]); await f.engine.initialize();
        f.runner((_job, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ ...success(), status: 'stopped' }), { once: true })));
        f.now(60000); await f.engine.tick(); await until(() => f.calls.length === 1);
        await f.engine.shutdown();
        assert.strictEqual(f.calls.length, 1);
        assert.strictEqual(f.saved()?.jobs[0].enabled, false);
        assert.strictEqual(f.saved()?.jobs[1].lastRun?.status, 'skipped');
        assert.strictEqual(f.saved()?.jobs[1].lastRun?.detail, 'scheduler-queued-cancelled');
        assert.strictEqual(f.saved()?.jobs[1].enabled, true);
        for (const pending of [f.saved()!.jobs[1], job({ lastRun: { status: 'queued', startedAt: 0 } })]) {
            const restarted = fixtureEngine([pending]);
            try {
                restarted.now(120000); await restarted.engine.initialize();
                assert.strictEqual(restarted.engine.list()[0].enabled, true);
                assert.strictEqual(restarted.engine.list()[0].lastRun?.status, 'skipped');
                assert.strictEqual(restarted.calls.length, 0);
                restarted.now(180000); await restarted.engine.tick();
                await until(() => restarted.engine.list()[0].lastRun?.status === 'success');
                assert.strictEqual(restarted.calls.length, 1);
                assert.strictEqual(restarted.calls[0].slot, 180000);
            } finally { await restarted.engine.shutdown(); }
        }
    });
    test('save failure prevents a paid call and disables automatic retries in the session', async () => {
        const f = fixtureEngine([job()]); await f.engine.initialize(); f.failSave(); f.now(60000);
        f.timers.values().next().value!.fire(); await until(() => f.errors.length === 1);
        assert.strictEqual(f.calls.length, 0); assert.strictEqual(f.engine.list()[0].enabled, false);
        await f.engine.shutdown();
    });
    test('failed run pauses the schedule and resume starts with a new future slot', async () => {
        const item = job(); const f = fixtureEngine([item]); await f.engine.initialize();
        f.runner(async () => ({ ...success(), status: 'failed' }));
        await f.engine.runNow(item.id); assert.strictEqual(f.engine.list()[0].enabled, false);
        f.now(200000); await f.engine.setEnabled(item.id, true);
        assert.strictEqual(f.engine.list()[0].nextRunAt, 260000);
        await f.engine.shutdown();
    });
    test('stop and shutdown wait for cancellation and persist the stopped result', async () => {
        const item = job(); const f = fixtureEngine([item]); await f.engine.initialize();
        f.runner((_job, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ ...success(), status: 'stopped' }), { once: true })));
        const running = f.engine.runNow(item.id); await until(() => f.calls.length === 1);
        await f.engine.stop(item.id); await running;
        assert.strictEqual(f.saved()?.jobs[0].lastRun?.status, 'stopped');
        assert.strictEqual(f.engine.list()[0].enabled, false);
        await f.engine.shutdown(); assert.strictEqual(f.timers.size, 0);
    });
    test('cancel during a pending reservation never dispatches later or leaves a running record', async () => {
        let stored: ClaudeSchedulerState | undefined; let pause = false; let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const item = job(); let calls = 0;
        const engine = new ClaudeScheduler({ version: 1, jobs: [item] }, {
            now: () => 0, schedule: () => ({ dispose() {} }), changed: () => {}, error: () => {},
            save: async state => { stored = structuredClone(state); if (pause) { await gate; } },
            run: async () => { calls++; return success(); },
        });
        await engine.initialize(); pause = true;
        const running = engine.runNow(item.id); await until(() => stored?.jobs[0].lastRun?.status === 'running');
        const shutdown = engine.shutdown(); release(); await shutdown; await running;
        assert.strictEqual(calls, 0); assert.strictEqual(stored?.jobs[0].lastRun?.status, 'stopped');
    });
});

suite('Claude CLI execution and UI integration', function () {
    this.timeout(15000);
    let directory: string; let storage: string; let script: string; let item: ClaudeSchedule; let options: ClaudeCliOptions;
    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskhub-claude 한글 '));
        storage = path.join(directory, 'storage'); script = path.join(directory, 'fake claude.cjs');
        item = job({ workspacePath: directory, promptPath: path.join(directory, 'prompt.md') });
        await fs.writeFile(item.promptPath, '한글 요청 "quoted"\n$(touch injected) & | % ! `echo x`');
        await fs.writeFile(script, `const fs=require('fs'); const args=process.argv.slice(2); const scenario=args[0];
            if(args.includes('--version')){
                let probePrompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>probePrompt+=c);process.stdin.on('end',()=>{
                    if(scenario==='company-version'){fs.writeFileSync(args[1],JSON.stringify({args,prompt:probePrompt}));}
                    console.log(scenario==='company-version'?'Company CLI 0.9.0':scenario==='old'?'2.1.247 (Claude Code)':'2.1.248 (Claude Code)');process.exit(0);
                });
            }else{
            let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
                if(scenario==='hang'){fs.writeFileSync(args[1],String(process.pid));setInterval(()=>{},1000);return;}
                if(scenario==='large'){process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);return;}
                if(scenario==='edit'){fs.writeFileSync(args[1],'modified by fixture');}
                if(scenario==='full-result'){fs.writeFileSync(args[1],JSON.stringify({prompt,args,cwd:process.cwd()}));process.stderr.write('w'.repeat(256*1024));}
                const result={type:'result',subtype:scenario==='external-failure'?'error_external':'success',is_error:scenario==='fail',
                    total_cost_usd:scenario==='no-cost'?undefined:1000,result:scenario==='full-result'?'R'.repeat(4*1024*1024-4096):scenario==='expanding-result'?Array.from({length:900000},()=>[0]):scenario==='expanding-unicode-result'?Array.from({length:300000},()=>[[['한']]]):JSON.stringify({prompt,args,cwd:process.cwd()}),permission_denials:scenario==='denied'?[{tool_name:'Bash'}]:[]};
                console.log(JSON.stringify(result));if(scenario==='fail'){process.exitCode=1;}
            });}`);
        options = { executable: 'node', prefixArgs: [script, 'success'], timeoutSeconds: 5 };
    });
    teardown(async () => { await fs.rm(directory, { recursive: true, force: true }); });
    const run = (item: ClaudeSchedule, options: ClaudeCliOptions, storage: string, signal = new AbortController().signal, slot?: number) =>
        runScheduledClaude(item, signal, slot, storage, [item.workspacePath], options, killProcessTree);

    test('native argv and stdin preserve hostile-looking multiline prompts and save the actual result', async () => {
        const result = await run(item, options, storage, undefined, 60000);
        assert.strictEqual(result.status, 'success'); item.lastRun = result;
        const report = await readClaudeReport(storage, item);
        const payload = JSON.parse(report.split('\n\n')[1]);
        assert.strictEqual(payload.prompt, await fs.readFile(item.promptPath, 'utf8'));
        assert.strictEqual(await fs.realpath(payload.cwd), await fs.realpath(directory));
        assert.ok(payload.args.includes('--no-session-persistence'));
        assert.ok(payload.args.includes('--restricted'));
        const denied = flagValues(payload.args, '--disallowedTools');
        for (const rule of ['mcp__*', 'Edit(.git/**)', 'Edit(.claude/**)', 'Edit(.vscode/**)', 'Edit(**/.git/**)', 'Edit(**/.vscode/**)']) { assert.ok(denied.includes(rule)); }
        assert.ok(!payload.args.includes('--dangerously-skip-permissions'));
        assert.deepStrictEqual(flagValues(payload.args, '--allowedTools'), ['Read(./**)', 'Glob', 'Grep']);
        await assert.rejects(fs.stat(path.join(directory, 'injected')));
    });
    test('reports record actual argv and stdin snapshots and do not reconstruct them after settings or file changes', async () => {
        const prompt = await fs.readFile(item.promptPath, 'utf8');
        options.model = 'original model with "quotes" and $literal';
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'success');
        const original = await readClaudeReport(storage, item);
        const received = JSON.parse(original.split('\n\n')[1]);
        const recorded = reportInvocations(original);
        assert.deepStrictEqual(recorded.map(entry => entry.phase), ['version', 'prompt']);
        assert.deepStrictEqual(recorded[0].args, [script, 'success', '--version']);
        assert.deepStrictEqual(recorded[1].args, [script, ...received.args]);
        for (const entry of recorded) {
            assert.strictEqual(entry.executable, 'node'); assert.strictEqual(entry.cwd, await fs.realpath(directory));
            assert.strictEqual(entry.shell, false); assert.strictEqual(entry.started, true); assert.strictEqual(entry.stdinStatus, 'written');
            assert.ok(original.includes(formatClaudeCommand(entry.executable, entry.args)));
        }
        assert.strictEqual(recorded[0].stdinBytes, 0);
        assert.strictEqual(recorded[1].stdinBytes, Buffer.byteLength(received.prompt, 'utf8'));
        assert.strictEqual(received.prompt, prompt);
        assert.ok(!recorded[1].args.includes(prompt)); assert.ok(original.includes(`\n${prompt}\n`));
        await fs.writeFile(item.promptPath, 'replacement prompt');
        options.model = 'replacement-model'; options.executable = 'replacement-cli';
        assert.strictEqual(await readClaudeReport(storage, item), original);
        assert.ok(!original.includes('replacement prompt')); assert.ok(!original.includes('replacement-model')); assert.ok(!original.includes('replacement-cli'));
        await assert.rejects(fs.stat(path.join(directory, 'injected')));
    });
    test('full input plus bounded output remains readable, while oversized diagnostic reports are refused', async () => {
        const prefix = '# Full input\r\n한글 "quoted"\r\n';
        const prompt = prefix + 'p'.repeat(256 * 1024 - Buffer.byteLength(prefix, 'utf8'));
        await fs.writeFile(item.promptPath, prompt);
        const receivedFile = path.join(directory, 'received.json');
        options.prefixArgs = [script, 'full-result', receivedFile];
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'success');
        const received = JSON.parse(await fs.readFile(receivedFile, 'utf8'));
        assert.strictEqual(received.prompt, prompt);
        const report = await readClaudeReport(storage, item);
        assert.ok(Buffer.byteLength(report, 'utf8') > 4 * 1024 * 1024 + 256 * 1024 + 65536);
        assert.ok(report.includes(`\n${prompt}\n`));
        assert.strictEqual(reportInvocations(report)[1].stdinBytes, 256 * 1024);
        assert.deepStrictEqual(reportInvocations(report)[1].args, [script, ...received.args]);
        await fs.appendFile(path.join(claudeReportDirectory(storage, item.id), item.lastRun.report!), Buffer.alloc(16 * 1024 * 1024));
        await assert.rejects(readClaudeReport(storage, item), /too large|너무 크/);
    });
    for (const scenario of ['expanding-result', 'expanding-unicode-result']) {
        test(`${scenario} is truncated so the report stays readable with full execution details`, async () => {
            options.prefixArgs = [script, scenario];
            item.lastRun = await run(item, options, storage);
            assert.strictEqual(item.lastRun.status, 'success');
            const report = await readClaudeReport(storage, item);
            // Truncation keeps as much as fits: the head of the result, the header and the full details.
            assert.ok(Buffer.byteLength(report, 'utf8') > 16 * 1024 * 1024 - 1024);
            assert.ok(Buffer.byteLength(report, 'utf8') <= 16 * 1024 * 1024);
            assert.ok(report.startsWith(`${item.name}\n`));
            assert.ok(report.includes('\n\n{\n  "type": "result"'));
            assert.match(report, /보고서 크기 한도|report size limit/);
            assert.ok(report.includes(`\n${await fs.readFile(item.promptPath, 'utf8')}\n`));
            assert.deepStrictEqual(reportInvocations(report).map(entry => entry.phase), ['version', 'prompt']);
        });
    }
    test('a deeply nested JSON result falls back to the original output without losing result status', () => {
        const nested = '['.repeat(10000) + '0' + ']'.repeat(10000);
        const stdout = `{"type":"result","subtype":"success","is_error":false,"result":${nested}}`;
        assert.deepStrictEqual(parseClaudeResult(stdout, 0), { success: true, text: stdout });
        assert.deepStrictEqual(parseClaudeResult(stdout, 1), { success: false, text: stdout });
        const denied = `{"type":"result","subtype":"success","is_error":false,"permission_denials":[{"tool_name":"Edit"}],"result":${nested}}`;
        const result = parseClaudeResult(denied, 0);
        assert.strictEqual(result.success, false);
        assert.ok(result.text.endsWith(denied));
        assert.match(result.text, /without permission|허용되지 않은/);
    });
    test('display command quoting preserves POSIX argument boundaries without expanding shell-looking values', function () {
        if (process.platform === 'win32') { this.skip(); }
        const marker = path.join(directory, 'display-command-injected');
        const args = [script, 'success', '', '한글 with spaces', 'single\'quote', 'double"quote', `$(touch "${marker}")`, `\`touch "${marker}"\``, 'two\nlines'];
        const command = formatClaudeCommand('node', args, 'linux');
        const output = execFileSync('sh', ['-c', command], { input: 'stdin fixture', encoding: 'utf8' });
        const received = JSON.parse(JSON.parse(output).result);
        assert.deepStrictEqual(received.args, args.slice(1)); assert.strictEqual(received.prompt, 'stdin fixture');
        assert.strictEqual(require('fs').existsSync(marker), false);
    });
    test('edit mode allows explicit editing tools and changes reach the workspace through the child process', async () => {
        const output = path.join(directory, 'edited.txt');
        item.mode = 'edit'; options.prefixArgs = [script, 'edit', output];
        assert.strictEqual(await run(item, options, storage).then(result => result.status), 'success');
        assert.strictEqual(await fs.readFile(output, 'utf8'), 'modified by fixture');
        const args = claudeArguments(item, options);
        assert.deepStrictEqual(flagValues(args, '--allowedTools'), ['Read(./**)', 'Glob', 'Grep', 'Edit(./**)']);
        assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
        item.bashRules = ['Bash(git diff *)', 'Bash(npm test)'];
        const configured = claudeArguments(item, options);
        assert.deepStrictEqual(flagValues(configured, '--allowedTools'), ['Read(./**)', 'Glob', 'Grep', 'Edit(./**)', 'Bash(git diff *)', 'Bash(npm test)']);
        assert.ok(configured[configured.indexOf('--tools') + 1].includes('Bash'));
        const analysis = claudeArguments({ ...item, mode: 'analysis' }, options);
        assert.ok(!analysis[analysis.indexOf('--tools') + 1].includes('Bash'));
    });
    test('model and per-schedule tool parameters reach the CLI unchanged and changes apply on the next run', async () => {
        item.mode = 'edit'; item.bashRules = ['Bash(git diff *)', 'Bash(npm test)'];
        options.model = 'company model $(echo literal)';
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'success');
        const first = JSON.parse((await readClaudeReport(storage, item)).split('\n\n')[1]);
        assert.strictEqual(first.args[first.args.indexOf('--model') + 1], options.model);
        assert.deepStrictEqual(flagValues(first.args, '--allowedTools'), ['Read(./**)', 'Glob', 'Grep', 'Edit(./**)', ...item.bashRules]);
        assert.strictEqual(first.args[first.args.indexOf('--permission-mode') + 1], 'dontAsk');
        options.model = 'second-model'; item.mode = 'analysis';
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'success');
        const second = JSON.parse((await readClaudeReport(storage, item)).split('\n\n')[1]);
        assert.strictEqual(second.args[second.args.indexOf('--model') + 1], 'second-model');
        assert.strictEqual(second.args[second.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
        assert.deepStrictEqual(flagValues(second.args, '--allowedTools'), ['Read(./**)', 'Glob', 'Grep']);
        delete options.model;
        assert.ok(!claudeArguments(item, options).includes('--model'));
    });
    test('CLI version preflight rejects unsupported versions before an edit', async () => {
        const output = path.join(directory, 'not-edited.txt');
        options.prefixArgs = [script, 'old', output];
        const result = await run(item, options, storage); item.lastRun = result;
        assert.strictEqual(result.status, 'failed');
        assert.match(await readClaudeReport(storage, item), /2\.1\.248/);
        await assert.rejects(fs.stat(output));
        for (const version of ['2.1.248 (Claude Code)', '2.2.0 (Claude Code)', '3.0.0']) { assert.strictEqual(supportsClaudeVersion(version), true); }
        for (const version of ['2.1.247 (Claude Code)', '2.0.999', '2.1.248-beta', 'invalid']) { assert.strictEqual(supportsClaudeVersion(version), false); }
    });
    test('another CLI version fails at preflight and reports its response before sending the prompt', async () => {
        const probe = path.join(directory, 'version-probe.json');
        options.prefixArgs = [script, 'company-version', probe];
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'failed');
        const received = JSON.parse(await fs.readFile(probe, 'utf8'));
        assert.ok(received.args.includes('--version'));
        assert.strictEqual(received.prompt, '');
        const report = await readClaudeReport(storage, item);
        assert.ok(report.includes('Company CLI 0.9.0'));
        assert.ok(report.includes(options.executable));
        assert.match(report, /prompt has not been sent|요청문은 아직 전달하지 않았습니다/);
        assert.ok(!report.includes('Update the CLI.'));
        assert.ok(!report.includes(await fs.readFile(item.promptPath, 'utf8')));
        assert.deepStrictEqual(reportInvocations(report).map(entry => entry.phase), ['version']);
        assert.strictEqual(reportInvocations(report)[0].stdinBytes, 0);
    });
    test('a missing executable reports the selected path, User setting and failed stage without sending the prompt', async () => {
        const executable = path.join(directory, `missing-cli-${randomUUID()}`);
        item.lastRun = await run(item, { executable, timeoutSeconds: 5 }, storage);
        assert.strictEqual(item.lastRun.status, 'failed');
        const report = await readClaudeReport(storage, item);
        assert.ok(report.includes(executable)); assert.match(report, /ENOENT/);
        assert.ok(report.includes('taskhub.aiScheduler.executable')); assert.ok(report.includes('PATH'));
        assert.match(report, /prompt has not been sent|요청문은 아직 전달하지 않았습니다/);
        assert.ok(!report.includes(await fs.readFile(item.promptPath, 'utf8')));
        const recorded = reportInvocations(report);
        assert.deepStrictEqual(recorded.map(entry => entry.phase), ['version']);
        assert.strictEqual(recorded[0].executable, executable); assert.strictEqual(recorded[0].started, false);
        assert.strictEqual(recorded[0].stdinBytes, 0); assert.strictEqual(recorded[0].stdinStatus, 'notSent');
    });
    test('the controller reads the general executable setting and reports that executable\'s real preflight output', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `ai-cli-setting-${randomUUID()}.md`);
        const initial = job({ workspacePath: folder.uri.fsPath, promptPath: prompt, nextRunAt: Date.now() + 600000 });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const original = vscode.workspace.getConfiguration;
        let controller: ClaudeSchedulerController | undefined;
        try {
            await fs.writeFile(prompt, 'Only the version probe should run.');
            vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
                const configuration = original(section, scope);
                return { ...configuration, inspect: (key: string) => section === 'taskhub' && key === 'aiScheduler.executable'
                    ? { key, globalValue: 'node' } : configuration.inspect(key) };
            }) as typeof original;
            controller = new ClaudeSchedulerController(context, killProcessTree);
            await controller.ready;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', initial);
            const completed = controller.engine.list()[0];
            assert.strictEqual(completed.lastRun?.status, 'failed');
            const report = await readClaudeReport(storage, completed);
            assert.ok(report.includes("'node'"));
            assert.ok(report.includes(execFileSync('node', ['--version'], { encoding: 'utf8' }).trim()));
            assert.match(report, /prompt has not been sent|요청문은 아직 전달하지 않았습니다/);
            assert.ok(!report.includes(await fs.readFile(prompt, 'utf8')));
        } finally {
            await controller?.shutdown(); vscode.workspace.getConfiguration = original;
            await fs.rm(prompt, { force: true });
        }
    });
    test('runs need no cost metadata, send no quota flags, and ignore legacy usage records', async () => {
        const root = await fs.realpath(directory);
        const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
        for (const scenario of ['success', 'no-cost']) {
            const runStorage = path.join(storage, scenario);
            const ledger = path.join(runStorage, 'claude-scheduler', 'locks', createHash('sha256').update(key).digest('hex'), 'usage.json');
            const legacyOptions = { ...options, prefixArgs: [script, scenario], maxTurns: 1, maxBudgetUsd: 0.01, maxDailyRuns: 1, maxDailyBudgetUsd: 0.01 };
            item.lastRun = await run(item, legacyOptions, runStorage, undefined, 60000);
            assert.strictEqual(item.lastRun.status, 'success');
            const payload = JSON.parse((await readClaudeReport(runStorage, item)).split('\n\n')[1]);
            assert.ok(!payload.args.includes('--max-budget-usd'));
            assert.ok(!payload.args.includes('--max-turns'));
            await assert.rejects(fs.stat(ledger), { code: 'ENOENT' });

            // An old, corrupt ledger must neither block a new run nor be updated.
            await fs.writeFile(ledger, '{corrupt legacy usage');
            item.lastRun = await run(item, legacyOptions, runStorage);
            assert.strictEqual(item.lastRun.status, 'success');
            assert.strictEqual(await fs.readFile(ledger, 'utf8'), '{corrupt legacy usage');
        }
    });
    test('recurring runs continue past the former daily count cap', async function () {
        this.timeout(30000);
        const f = fixtureEngine([item]);
        f.runner((current, signal, slot) => run(current, options, storage, signal, slot));
        try {
            await f.engine.initialize();
            for (let minute = 1; minute <= 26; minute++) {
                f.now(minute * 60000); await f.engine.tick();
                await until(() => !f.engine.runningId && f.engine.list()[0].lastRun?.status === 'success');
                assert.strictEqual(f.engine.list()[0].enabled, true);
            }
            assert.strictEqual(f.calls.length, 26);
            assert.strictEqual(f.engine.list()[0].nextRunAt, 27 * 60000);
        } finally { await f.engine.shutdown(); }
    });
    for (const scenario of ['fail', 'external-failure', 'denied']) {
        test(`${scenario} result is a failed run even when the CLI can exit zero`, async () => {
            options.prefixArgs = [script, scenario];
            const result = await run(item, options, storage);
            assert.strictEqual(result.status, 'failed'); assert.ok(result.report);
        });
    }
    test('non-JSON and missing result metadata cannot silently become success', () => {
        for (const data of ['null', '[]', 'invalid', '{}', '{"type":"result","subtype":"success"}']) {
            assert.strictEqual(parseClaudeResult(data, 0).success, false);
        }
    });
    test('prompt changes are read on each run and missing or empty prompts fail before spawning', async () => {
        await fs.writeFile(item.promptPath, 'updated request');
        const result = await run(item, options, storage); item.lastRun = result;
        assert.ok((await readClaudeReport(storage, item)).includes('updated request'));
        await fs.writeFile(item.promptPath, '   ');
        assert.strictEqual((await run(item, options, storage)).status, 'failed');
        await fs.rm(item.promptPath);
        assert.strictEqual((await run(item, options, storage)).status, 'failed');
    });
    test('outside-workspace prompts, unopened folders, oversized prompts and batch executables are refused', async () => {
        const outside = path.join(os.tmpdir(), `taskhub-outside-${randomUUID()}.md`);
        try {
            await fs.writeFile(outside, 'outside');
            assert.strictEqual((await run({ ...item, promptPath: outside }, options, storage)).status, 'failed');
            assert.strictEqual((await runScheduledClaude(item, new AbortController().signal, undefined, storage, [], options, killProcessTree)).status, 'failed');
            await fs.writeFile(item.promptPath, 'x'.repeat(256 * 1024 + 1));
            assert.strictEqual((await run(item, options, storage)).status, 'failed');
            await fs.writeFile(item.promptPath, 'request');
            assert.strictEqual((await run(item, { ...options, executable: 'claude.cmd' }, storage)).status, 'failed');
        } finally { await fs.rm(outside, { force: true }); }
    });
    test('a FIFO prompt is rejected without blocking scheduler cancellation', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const pipe = path.join(directory, 'prompt-pipe.md');
        execFileSync('mkfifo', [pipe]);
        const result = await run({ ...item, promptPath: pipe }, options, storage);
        assert.strictEqual(result.status, 'failed');
        item.lastRun = result;
        const report = await readClaudeReport(storage, item);
        assert.ok(report.includes('regular file') || report.includes('일반 파일'));
    });
    test('timeout, cancellation and excessive output terminate the CLI and leave readable failure reports', async () => {
        const marker = path.join(directory, 'pid');
        options.prefixArgs = [script, 'hang', marker]; options.timeoutSeconds = 0.2;
        const timed = await run(item, options, storage); assert.strictEqual(timed.status, 'failed');
        options.timeoutSeconds = 5; const abort = new AbortController();
        await fs.rm(marker, { force: true });
        const pending = run(item, options, storage, abort.signal);
        await until(async () => fs.stat(marker).then(() => true, () => false)); abort.abort();
        assert.strictEqual((await pending).status, 'stopped');
        options.prefixArgs = [script, 'large'];
        const large = await run(item, options, storage); assert.strictEqual(large.status, 'failed');
        item.lastRun = large; assert.ok((await readClaudeReport(storage, item)).length < 5 * 1024 * 1024);
    });
    test('workspace leases and durable slots prevent overlapping windows and post-completion duplicates', async () => {
        const marker = path.join(directory, 'pid'); options.prefixArgs = [script, 'hang', marker];
        const abort = new AbortController(); const pending = run(item, options, storage, abort.signal, 60000);
        try {
            await until(async () => fs.stat(marker).then(() => true, () => false));
            assert.strictEqual((await run(job({ ...item, id: randomUUID() }), options, storage)).status, 'skipped');
        } finally { abort.abort(); await pending; }
        options.prefixArgs = [script, 'success'];
        assert.strictEqual((await run(item, options, storage, undefined, 60000)).status, 'skipped');
        assert.strictEqual((await run(item, options, storage, undefined, 120000)).status, 'success');
    });
    test('tree displays enabled, running, failed and interrupted results with stable identities', () => {
        const provider = new ClaudeSchedulesProvider(() => [item], () => item.id);
        try {
            assert.strictEqual(provider.getTreeItem(item).contextValue, 'claudeScheduleRunning');
            const idle = new ClaudeSchedulesProvider(() => [item], () => undefined);
            try {
                item.enabled = false; item.lastRun = { ...success(), status: 'interrupted' };
                const tree = idle.getTreeItem(item);
                assert.strictEqual(tree.id, item.id); assert.strictEqual(tree.contextValue, 'claudeSchedulePaused');
                assert.ok(String(tree.tooltip).includes('interrupted') || String(tree.tooltip).includes('추적 중단'));
                item.enabled = true;
                for (const detail of ['scheduler-budget', 'scheduler-queued-cancelled']) {
                    item.lastRun = { ...success(), status: 'skipped', detail };
                    const skipped = idle.getTreeItem(item);
                    assert.strictEqual(skipped.contextValue, 'claudeScheduleEnabled');
                    assert.ok(!String(skipped.tooltip).includes(detail), 'The skip reason must be localized for users');
                    assert.match(String(skipped.description), /Skipped|건너뜀/);
                    assert.ok(!String(skipped.description).includes('Paused'));
                }
            } finally { idle.dispose(); }
        } finally { provider.dispose(); }
    });
    test('schedule rows show cadence before times and preserve it while running, queued or paused', () => {
        const ko = vscode.env.language.startsWith('ko');
        const pausedAt = new Date(2026, 9, 5, 18, 30).getTime();
        const cadences = [
            { cadence: { kind: 'interval' as const, minutes: 1 }, text: ko ? '1분마다' : 'Every minute' },
            { cadence: { kind: 'interval' as const, minutes: 60 }, text: ko ? '60분마다' : 'Every 60 minutes' },
            { cadence: { kind: 'interval' as const, minutes: 10080 }, text: ko ? '10080분마다' : 'Every 10080 minutes' },
            { cadence: { kind: 'daily' as const, hour: 9, minute: 5 }, text: ko ? '매일 09:05 (현지 시각)' : 'Daily at 09:05 (local time)' },
        ];
        for (const { cadence, text } of cadences) {
            for (const state of ['enabled', 'running', 'queued', 'paused'] as const) {
                const scheduled = job({ cadence, enabled: state !== 'paused', pausedAt: state === 'paused' ? pausedAt : undefined,
                    nextRunAt: pausedAt + 60000, lastRun: { ...success(), report: `${randomUUID()}.txt` } });
                const before = structuredClone(scheduled);
                const provider = new ClaudeSchedulesProvider(() => [scheduled], () => state === 'running' ? scheduled.id : undefined,
                    () => state === 'queued' ? [scheduled.id] : []);
                try {
                    const tree = provider.getTreeItem(scheduled);
                    const description = String(tree.description);
                    assert.ok(description.startsWith(`${text} · `), description);
                    assert.strictEqual(tree.label, scheduled.name); assert.strictEqual(tree.id, scheduled.id);
                    assert.strictEqual(tree.command?.command, 'taskhub.claudeScheduler.openReport');
                    if (state === 'enabled') { assert.ok(description.includes(new Date(scheduled.nextRunAt).toLocaleString())); }
                    if (state === 'paused') { assert.ok(description.includes(new Date(pausedAt).toLocaleString())); }
                    if (state === 'running') { assert.match(description, /Running|실행 중/); }
                    if (state === 'queued') { assert.match(description, /Queued|실행 대기/); }
                    assert.strictEqual(String(tree.tooltip).split(text).length - 1, 1, 'The tooltip must not repeat the cadence.');
                    assert.deepStrictEqual(scheduled, before, 'Displaying a cadence must not alter the schedule.');
                } finally { provider.dispose(); }
            }
        }
    });
    test('paused rows put local pause time before the outcome, keep explicit pauses, and support old records', () => {
        const provider = new ClaudeSchedulesProvider(() => [item], () => undefined);
        try {
            const pausedAt = new Date(2026, 9, 5, 17, 48, 30).getTime();
            item.enabled = false; item.pausedAt = pausedAt; item.lastRun = { ...success(pausedAt - 1000), status: 'failed' };
            const description = String(provider.getTreeItem(item).description);
            assert.ok(description.includes(new Date(pausedAt).toLocaleString()));
            assert.ok(description.indexOf(new Date(pausedAt).toLocaleString()) < description.search(/Failed|실패/));
            assert.ok(!/schedule paused|예약 일시 정지/.test(description));
            assert.ok(String(provider.getTreeItem(item).tooltip).includes(new Date(pausedAt).toLocaleString()));
            item.lastRun = success(pausedAt + 10000);
            assert.ok(String(provider.getTreeItem(item).description).includes(new Date(pausedAt).toLocaleString()), 'Manual pause time must not be replaced by a later run finish.');
            delete item.pausedAt;
            item.lastRun = { status: 'failed', startedAt: pausedAt - 1, finishedAt: pausedAt };
            assert.ok(String(provider.getTreeItem(item).description).includes(new Date(pausedAt).toLocaleString()));
            item.lastRun = undefined;
            assert.match(String(provider.getTreeItem(item).description), /Paused|일시 정지/);
            assert.ok(!String(provider.getTreeItem(item).description).includes(new Date(pausedAt).toLocaleString()));
            item.pausedAt = 0;
            assert.ok(String(provider.getTreeItem(item).description).includes(new Date(0).toLocaleString()));
            item.enabled = true;
            assert.match(String(provider.getTreeItem(item).description), /Next:|다음:/);
        } finally { provider.dispose(); }
    });
    test('retention bounds old/deleted jobs globally and per job while preserving the current report', async () => {
        const currentDirectory = claudeReportDirectory(storage, item.id);
        await fs.mkdir(currentDirectory, { recursive: true });
        const current = `${randomUUID()}.txt`;
        await fs.writeFile(path.join(currentDirectory, current), 'current result');
        await fs.utimes(path.join(currentDirectory, current), 1, 1);
        for (let index = 0; index < 25; index++) { await fs.writeFile(path.join(currentDirectory, `${randomUUID()}.txt`), 'old'); }
        const otherDirectory = claudeReportDirectory(storage, randomUUID());
        await fs.mkdir(otherDirectory, { recursive: true });
        // Large deleted-job reports exercise the global byte limit, as well as counts.
        for (let index = 0; index < 20; index++) { await fs.writeFile(path.join(otherDirectory, `${randomUUID()}.txt`), Buffer.alloc(4 * 1024 * 1024)); }
        const untouched = path.join(currentDirectory, 'unrelated.txt'); await fs.writeFile(untouched, 'preserve');
        await pruneClaudeReports(storage, item.id, current);
        assert.strictEqual(await fs.readFile(path.join(currentDirectory, current), 'utf8'), 'current result');
        assert.strictEqual(await fs.readFile(untouched, 'utf8'), 'preserve');
        assert.ok((await fs.readdir(currentDirectory)).filter(file => file !== 'unrelated.txt').length <= 20);
        let bytes = 0;
        for (const folder of [currentDirectory, otherDirectory]) {
            for (const file of await fs.readdir(folder)) { bytes += (await fs.stat(path.join(folder, file))).size; }
        }
        assert.ok(bytes <= 64 * 1024 * 1024 + 8);
    });
    test('UI add, command execution, persisted result, report document and re-created controller stay connected', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `claude-test-${randomUUID()}.md`);
        const edited = path.join(directory, 'ui-edited.txt');
        const values = new Map<string, unknown>();
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key),
            update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox; const open = vscode.window.showOpenDialog;
        const show = vscode.window.showTextDocument;
        let controller: ClaudeSchedulerController | undefined;
        try {
            await fs.writeFile(prompt, 'modify this project');
            options.prefixArgs = [script, 'edit', edited];
            vscode.window.showQuickPick = (async (items: unknown) => {
                const choices = await items as Array<{ mode?: string; promptSource?: string; label: string }>;
                return choices.find(choice => choice.promptSource === 'file' || choice.mode === 'edit') ?? choices[0];
            }) as unknown as typeof pick;
            let count = 0; vscode.window.showInputBox = async () => ['CLI UI integration', '["Bash(npm test)"]', '60'][count++];
            vscode.window.showOpenDialog = async () => [vscode.Uri.file(prompt)];
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options);
            await controller.ready;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            const saved = values.get(CLAUDE_SCHEDULES_KEY) as ClaudeSchedulerState;
            assert.strictEqual(saved.jobs.length, 1); assert.strictEqual(saved.jobs[0].mode, 'edit'); assert.strictEqual(saved.jobs[0].enabled, true);
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', saved.jobs[0]);
            assert.strictEqual(await fs.readFile(edited, 'utf8'), 'modified by fixture');
            const completed = controller.engine.list()[0]; assert.strictEqual(completed.lastRun?.status, 'success');
            let document: vscode.TextDocument | undefined;
            vscode.window.showTextDocument = (async (value: vscode.TextDocument) => { document = value; return vscode.window.activeTextEditor; }) as unknown as typeof show;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.openReport', completed);
            assert.ok(document?.getText().includes('modify this project'));
            const recorded = reportInvocations(document!.getText());
            assert.ok(document!.getText().includes('\nmodify this project\n'));
            assert.ok(recorded[1].args.includes('Bash(npm test)'));
            assert.strictEqual(recorded[1].stdinStatus, 'written');
            assert.strictEqual(document?.uri.scheme, 'taskhub-claude-report');
            assert.strictEqual(document?.isUntitled, false); assert.strictEqual(document?.isDirty, false);
            await vscode.commands.executeCommand('taskhub.claudeScheduler.pause', completed);
            assert.strictEqual(controller.engine.list()[0].enabled, false);
            await controller.shutdown(); controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            assert.strictEqual(controller.engine.list()[0].lastRun?.status, 'success'); assert.strictEqual(controller.engine.list()[0].enabled, false);
        } finally {
            await controller?.shutdown(); vscode.window.showQuickPick = pick; vscode.window.showInputBox = input;
            vscode.window.showOpenDialog = open; vscode.window.showTextDocument = show;
            await fs.rm(prompt, { force: true });
        }
    });
    test('default registration runs jobs while the panel is hidden and routes Show Schedules to visibility settings', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `ai-visibility-${randomUUID()}.md`);
        const initial = job({ workspacePath: await fs.realpath(folder.uri.fsPath), promptPath: prompt });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const get = vscode.workspace.getConfiguration; const execute = vscode.commands.executeCommand;
        let visible = true; let created = 0; let controller: ClaudeSchedulerController | undefined;
        let registration: ReturnType<typeof registerClaudeScheduler> | undefined;
        const opened: Array<{ command: string; args: unknown[] }> = [];
        try {
            await fs.writeFile(prompt, 'hidden panel input fixture');
            vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
                const configuration = get(section, scope);
                if (section !== 'taskhub') { return configuration; }
                return { ...configuration,
                    inspect: (key: string) => ['aiScheduler.enabled', 'experimental.aiScheduler.enabled', 'experimental.claudeScheduler.enabled'].includes(key)
                        ? { defaultValue: key === 'aiScheduler.enabled' } : configuration.inspect(key),
                    get: (key: string, fallback: unknown) => key === 'aiScheduler.showPanel' ? visible : configuration.get(key, fallback),
                };
            }) as unknown as typeof get;
            vscode.commands.executeCommand = (async (command: string, ...args: unknown[]) => {
                if (command === 'mainView.claudeSchedules.focus' || command === 'workbench.action.openSettings') { opened.push({ command, args }); return; }
                return execute(command, ...args);
            }) as typeof execute;
            registration = registerClaudeScheduler(context, killProcessTree, () => {
                created++; controller = new ClaudeSchedulerController(context, killProcessTree, () => options); return controller;
            });
            await until(() => !!controller); await controller!.ready;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.showSchedules');
            visible = false;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.showSchedules');
            assert.deepStrictEqual(opened, [{ command: 'mainView.claudeSchedules.focus', args: [] },
                { command: 'workbench.action.openSettings', args: ['@id:taskhub.aiScheduler.showPanel'] }]);
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', initial);
            const completed = controller!.engine.list()[0];
            assert.strictEqual(created, 1); assert.strictEqual(completed.enabled, true); assert.strictEqual(completed.lastRun?.status, 'success');
            const report = await readClaudeReport(storage, completed);
            assert.strictEqual(JSON.parse(report.split('\n\n')[1]).prompt, 'hidden panel input fixture');
            assert.strictEqual((values.get(CLAUDE_SCHEDULES_KEY) as ClaudeSchedulerState).jobs[0].lastRun?.status, 'success');
        } finally {
            await registration?.shutdown(); vscode.workspace.getConfiguration = get; vscode.commands.executeCommand = execute;
            await fs.rm(prompt, { force: true });
        }
    });
    test('example editing releases Add while its notification remains unanswered; Add can register the saved prompt', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `ai-example-${randomUUID()}.md`);
        const values = new Map<string, unknown>();
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox;
        const save = vscode.window.showSaveDialog; const open = vscode.window.showOpenDialog;
        const show = vscode.window.showTextDocument; const information = vscode.window.showInformationMessage;
        const history = vscode.workspace.getConfiguration('workbench.localHistory', folder.uri);
        const historyEnabled = history.inspect<boolean>('enabled')?.globalValue;
        let controller: ClaudeSchedulerController | undefined;
        let document: vscode.TextDocument | undefined;
        let preparing: Thenable<unknown> | undefined;
        let chooseExisting = false;
        let cancelFilePick = true;
        let notified = false;
        const messages: string[] = [];
        let finishNotification!: () => void;
        const notification = new Promise<undefined>(resolve => { finishNotification = () => resolve(undefined); });
        const customPrompt = '# My recurring task\n\nReview parser edge cases and report file locations.\n';
        try {
            // The test removes its saved file; keep asynchronous local-history copies from racing cleanup.
            await history.update('enabled', false, vscode.ConfigurationTarget.Global);
            vscode.window.showQuickPick = (async (items: any, options: vscode.QuickPickOptions) => {
                const choices = await items;
                if (choices.some((choice: any) => choice.promptSource)) {
                    assert.match(options.title ?? '', /AI/);
                    assert.ok(choices.every((choice: any) => choice.detail));
                }
                return chooseExisting ? choices.find((choice: any) => choice.promptSource === 'file') ?? choices[0] : choices[0];
            }) as typeof pick;
            let count = 0; vscode.window.showInputBox = async () => ['Example schedule', '60'][count++];
            vscode.window.showSaveDialog = async options => {
                assert.strictEqual(options?.defaultUri?.fsPath, vscode.Uri.joinPath(folder.uri, 'ai-schedule-prompt.md').fsPath);
                return vscode.Uri.file(prompt);
            };
            vscode.window.showOpenDialog = async () => {
                assert.strictEqual(chooseExisting, true, 'Creating an example must end before asking for a prompt file.');
                return cancelFilePick ? undefined : [vscode.Uri.file(prompt)];
            };
            vscode.window.showTextDocument = (async (value: vscode.TextDocument, options: vscode.TextDocumentShowOptions) => {
                document = value;
                assert.strictEqual(options.preview, false);
                assert.strictEqual(value.languageId, 'markdown');
                assert.strictEqual((value.getText().match(/^## /gm) ?? []).length, 4);
                assert.strictEqual(controller?.engine.list().length, 0);
                return {} as vscode.TextEditor;
            }) as unknown as typeof show;
            vscode.window.showInformationMessage = ((message: string) => {
                assert.ok(document);
                messages.push(message);
                notified = true;
                return notification;
            }) as unknown as typeof information;
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            preparing = vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            await until(() => notified);
            assert.ok(document, 'The example must be opened in the editor.');
            assert.deepStrictEqual(values.get(CLAUDE_SCHEDULES_KEY), { version: 1, jobs: [] });
            assert.strictEqual(await fs.readFile(prompt, 'utf8'), document.getText());
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), customPrompt);
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(await document.save(), true);
            chooseExisting = true;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            assert.strictEqual(controller.engine.list().length, 0, 'Cancelling file selection must leave the example unscheduled.');
            cancelFilePick = false;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            assert.strictEqual(controller.engine.list().length, 1, 'An unanswered example notification must not block Add.');
            await preparing;
            assert.strictEqual(messages.length, 1, 'Add must not produce an already-in-progress notification.');
            assert.strictEqual(document.isDirty, false);
            assert.strictEqual(await fs.readFile(prompt, 'utf8'), customPrompt);
            const scheduled = controller.engine.list()[0];
            assert.strictEqual(scheduled.mode, 'analysis');
            assert.strictEqual(scheduled.promptPath, await fs.realpath(prompt));
            assert.strictEqual(scheduled.lastRun, undefined, 'Registering a schedule must not run it immediately.');
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', scheduled);
            const completed = controller.engine.list()[0];
            assert.strictEqual(completed.lastRun?.status, 'success');
            assert.ok((await readClaudeReport(storage, completed)).includes('Review parser edge cases'));
        } finally {
            finishNotification(); await preparing;
            await controller?.shutdown();
            vscode.window.showQuickPick = pick; vscode.window.showInputBox = input;
            vscode.window.showSaveDialog = save; vscode.window.showOpenDialog = open;
            vscode.window.showTextDocument = show; vscode.window.showInformationMessage = information;
            if (document?.isDirty) { await document.save(); }
            await fs.rm(prompt, { force: true });
            await history.update('enabled', historyEnabled, vscode.ConfigurationTarget.Global);
        }
    });
    for (const destination of ['existing', 'outside', 'linked-parent'] as const) {
        test(`example prompt creation preserves files and workspace boundaries: ${destination}`, async () => {
            const folder = vscode.workspace.workspaceFolders![0];
            const name = `ai-boundary-${randomUUID()}.md`;
            const linkedParent = path.join(folder.uri.fsPath, `ai-link-${randomUUID()}`);
            const prompt = destination === 'existing' ? path.join(folder.uri.fsPath, name) : path.join(directory, name);
            const savePath = destination === 'linked-parent' ? path.join(linkedParent, name) : prompt;
            const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
                get: () => undefined, update: async (_key: string, value: unknown) => { assert.deepStrictEqual(value, { version: 1, jobs: [] }); },
            } } as unknown as vscode.ExtensionContext;
            const pick = vscode.window.showQuickPick; const save = vscode.window.showSaveDialog;
            const show = vscode.window.showTextDocument; const error = vscode.window.showErrorMessage;
            const errors: string[] = [];
            let controller: ClaudeSchedulerController | undefined;
            try {
                if (destination === 'existing') { await fs.writeFile(prompt, 'Preserve my existing prompt.'); }
                if (destination === 'linked-parent') { await fs.symlink(directory, linkedParent, process.platform === 'win32' ? 'junction' : 'dir'); }
                vscode.window.showQuickPick = (async (items: any) => (await items)[0]) as typeof pick;
                vscode.window.showSaveDialog = async () => vscode.Uri.file(savePath);
                vscode.window.showTextDocument = (async () => { throw new Error('Rejected files must not be opened.'); }) as typeof show;
                vscode.window.showErrorMessage = (async (message: string) => { errors.push(message); }) as typeof error;
                controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
                await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
                assert.strictEqual(controller.engine.list().length, 0);
                assert.strictEqual(errors.length, 1);
                assert.match(errors[0], destination === 'existing' ? /already exists|이미 있습니다/ : /inside the selected workspace|워크스페이스 안/);
                if (destination === 'existing') { assert.strictEqual(await fs.readFile(prompt, 'utf8'), 'Preserve my existing prompt.'); }
                else { await assert.rejects(fs.stat(prompt), { code: 'ENOENT' }); }
            } finally {
                await controller?.shutdown(); vscode.window.showQuickPick = pick; vscode.window.showSaveDialog = save;
                vscode.window.showTextDocument = show; vscode.window.showErrorMessage = error;
                await fs.rm(prompt, { force: true });
                if (destination === 'linked-parent') { await fs.unlink(linkedParent); }
            }
        });
    }
    test('cancelling the prompt guidance does not open a file dialog or register a schedule', async () => {
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: () => undefined, update: async (_key: string, value: unknown) => { assert.deepStrictEqual(value, { version: 1, jobs: [] }); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const open = vscode.window.showOpenDialog; const save = vscode.window.showSaveDialog;
        let controller: ClaudeSchedulerController | undefined;
        try {
            vscode.window.showQuickPick = (async () => undefined) as typeof pick;
            vscode.window.showOpenDialog = async () => { throw new Error('No file dialog before choosing a prompt source.'); };
            vscode.window.showSaveDialog = async () => { throw new Error('No save dialog before choosing a prompt source.'); };
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            assert.strictEqual(controller.engine.list().length, 0);
        } finally {
            await controller?.shutdown(); vscode.window.showQuickPick = pick; vscode.window.showOpenDialog = open; vscode.window.showSaveDialog = save;
        }
    });
    for (const field of ['name', 'cadence', 'mode', 'bashRules', 'promptFile', 'promptContents', 'cancel'] as const) {
        test(`editing only ${field} keeps other fields, pause time and original due time`, async () => {
            const folder = vscode.workspace.workspaceFolders![0];
            const prompt = path.join(folder.uri.fsPath, `ai-edit-${randomUUID()}.md`);
            const alternate = path.join(folder.uri.fsPath, `ai-edit-${randomUUID()}.txt`);
            const initial = job({ workspacePath: await fs.realpath(folder.uri.fsPath), promptPath: prompt, mode: 'edit',
                bashRules: ['Bash(npm test)'], cadence: { kind: 'daily', hour: 7, minute: 15 },
                enabled: false, pausedAt: Date.now() - 12345, nextRunAt: Date.now() + 600000, lastRun: success() });
            const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
            const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
                get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
            } } as unknown as vscode.ExtensionContext;
            const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox;
            const open = vscode.window.showOpenDialog; const show = vscode.window.showTextDocument;
            let controller: ClaudeSchedulerController | undefined; let prompts = 0; let picks = 0; let opened = 0;
            try {
                await fs.writeFile(prompt, 'original prompt'); await fs.writeFile(alternate, 'new prompt');
                vscode.window.showQuickPick = (async (items: any) => {
                    const choices = await items; picks++;
                    if (choices.some((choice: any) => choice.field)) {
                        assert.ok(choices.some((choice: any) => choice.description === initial.name));
                        return field === 'cancel' ? undefined : choices.find((choice: any) => choice.field === field);
                    }
                    if (field === 'cadence') { assert.strictEqual(choices[0].cadenceKind, 'daily'); return choices[0]; }
                    if (field === 'mode') { assert.strictEqual(choices[0].mode, 'edit'); return choices.find((choice: any) => choice.mode === 'analysis'); }
                    assert.fail('Editing one field must not run the full registration wizard.');
                }) as typeof pick;
                vscode.window.showInputBox = async options => {
                    prompts++;
                    if (field === 'name') { assert.strictEqual(options?.value, initial.name); return 'renamed schedule'; }
                    if (field === 'cadence') { assert.strictEqual(options?.value, '07:15'); return '07:15'; }
                    if (field === 'bashRules') { assert.strictEqual(options?.value, JSON.stringify(initial.bashRules)); return '["Bash(git diff *)"]'; }
                    assert.fail('Unselected fields must not ask for input.');
                };
                vscode.window.showOpenDialog = async options => {
                    assert.strictEqual(field, 'promptFile'); assert.strictEqual(options?.defaultUri?.fsPath, prompt);
                    return [vscode.Uri.file(alternate)];
                };
                vscode.window.showTextDocument = (async (document: vscode.TextDocument | vscode.Uri, options?: vscode.TextDocumentShowOptions | vscode.ViewColumn) => {
                    assert.ok('getText' in document);
                    // VS Code file URIs normalize Windows drive letters; realpath preserves their case.
                    assert.strictEqual(field, 'promptContents'); assert.strictEqual(document.uri.fsPath, vscode.Uri.file(await fs.realpath(prompt)).fsPath);
                    assert.strictEqual(document.getText(), 'original prompt'); assert.strictEqual((options as vscode.TextDocumentShowOptions).preview, false); opened++;
                    return {} as vscode.TextEditor;
                }) as typeof show;
                controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
                const before = controller.engine.list()[0];
                await vscode.commands.executeCommand('taskhub.claudeScheduler.edit', before);
                const expected = { ...before };
                if (field === 'name') { expected.name = 'renamed schedule'; }
                if (field === 'bashRules') { expected.bashRules = ['Bash(git diff *)']; }
                if (field === 'mode') { expected.mode = 'analysis'; expected.bashRules = []; }
                if (field === 'promptFile') { expected.promptPath = await fs.realpath(alternate); }
                assert.deepStrictEqual(controller.engine.list()[0], expected);
                assert.deepStrictEqual((values.get(CLAUDE_SCHEDULES_KEY) as ClaudeSchedulerState).jobs[0], expected);
                assert.strictEqual(prompts, ['name', 'cadence', 'bashRules'].includes(field) ? 1 : 0);
                assert.strictEqual(picks, field === 'cadence' || field === 'mode' ? 2 : 1);
                assert.strictEqual(opened, field === 'promptContents' ? 1 : 0);
            } finally {
                await controller?.shutdown(); vscode.window.showQuickPick = pick; vscode.window.showInputBox = input;
                vscode.window.showOpenDialog = open; vscode.window.showTextDocument = show;
                await fs.rm(prompt, { force: true }); await fs.rm(alternate, { force: true });
            }
        });
    }
    test('changing a working folder commits its prompt together and cancelling leaves the old schedule intact', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const initial = job({ workspacePath: await fs.realpath(folder.uri.fsPath), promptPath: path.join(folder.uri.fsPath, 'old.md'), nextRunAt: Date.now() + 600000 });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const open = vscode.window.showOpenDialog;
        const folders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders')!;
        let controller: ClaudeSchedulerController | undefined; let cancel = true;
        try {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [folder,
                { name: 'new folder', index: 1, uri: vscode.Uri.file(directory) }] });
            vscode.window.showQuickPick = (async (items: any) => {
                const choices = await items;
                if (choices[0].field) { return choices.find((choice: any) => choice.field === 'workspace'); }
                assert.strictEqual(choices[0].workspacePath, initial.workspacePath);
                return choices.find((choice: any) => choice.folder.index === 1);
            }) as typeof pick;
            vscode.window.showOpenDialog = async options => {
                assert.strictEqual(options?.defaultUri?.fsPath, vscode.Uri.file(path.join(await fs.realpath(directory), 'old.md')).fsPath);
                return cancel ? undefined : [vscode.Uri.file(item.promptPath)];
            };
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            const before = controller.engine.list()[0];
            await vscode.commands.executeCommand('taskhub.claudeScheduler.edit', before);
            assert.deepStrictEqual(controller.engine.list()[0], before);
            cancel = false; await vscode.commands.executeCommand('taskhub.claudeScheduler.edit', before);
            assert.deepStrictEqual(controller.engine.list()[0], { ...before, workspacePath: await fs.realpath(directory), promptPath: await fs.realpath(item.promptPath) });
        } finally {
            await controller?.shutdown(); vscode.window.showQuickPick = pick; vscode.window.showOpenDialog = open;
            Object.defineProperty(vscode.workspace, 'workspaceFolders', folders);
        }
    });
    test('deleting during field input cannot recreate a schedule when editing finishes', async () => {
        const initial = job({ nextRunAt: Date.now() + 600000 });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox; const error = vscode.window.showErrorMessage;
        let controller: ClaudeSchedulerController | undefined; let release: ((name: string) => void) | undefined;
        const messages: string[] = []; let editing: Thenable<unknown> | undefined;
        try {
            vscode.window.showQuickPick = (async (items: any) => (await items).find((choice: any) => choice.field === 'name')) as typeof pick;
            vscode.window.showInputBox = async () => new Promise(resolve => { release = resolve; });
            vscode.window.showErrorMessage = (async (message: string) => { messages.push(message); return undefined; }) as typeof error;
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            editing = vscode.commands.executeCommand('taskhub.claudeScheduler.edit', initial); await until(() => !!release);
            await controller.engine.remove(initial.id); release!('deleted name'); await editing;
            assert.deepStrictEqual(controller.engine.list(), []);
            assert.match(messages.join('\n'), /already been deleted|이미 삭제/);
        } finally {
            release?.('cancelled'); await editing; await controller?.shutdown();
            vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; vscode.window.showErrorMessage = error;
        }
    });
    test('field editing cannot erase a result or re-enable a schedule that failed while it was open', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `claude-wizard-${randomUUID()}.md`);
        const initial = job({ workspacePath: folder.uri.fsPath, promptPath: prompt, nextRunAt: Date.now() + 600000 });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [initial] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const pick = vscode.window.showQuickPick; const input = vscode.window.showInputBox; const open = vscode.window.showOpenDialog;
        let controller: ClaudeSchedulerController | undefined;
        let release!: (name: string) => void;
        let entered = false;
        try {
            await fs.writeFile(prompt, 'review'); options.prefixArgs = [script, 'fail'];
            vscode.window.showQuickPick = (async (items: any) => (await items)[0]) as typeof pick;
            vscode.window.showOpenDialog = async () => [vscode.Uri.file(prompt)];
            let count = 0;
            vscode.window.showInputBox = async () => count++ === 0 ? new Promise<string>(resolve => { entered = true; release = resolve; }) : '60';
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            const editing = vscode.commands.executeCommand('taskhub.claudeScheduler.edit', controller.engine.list()[0]);
            await until(() => entered);
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', initial);
            const latest = controller.engine.list()[0]; assert.strictEqual(latest.lastRun?.status, 'failed');
            release('updated name'); await editing;
            const edited = controller.engine.list()[0];
            assert.strictEqual(edited.name, 'updated name'); assert.strictEqual(edited.enabled, false);
            assert.deepStrictEqual(edited.lastRun, latest.lastRun);
            assert.strictEqual(edited.nextRunAt, latest.nextRunAt); assert.strictEqual(edited.pausedAt, latest.pausedAt);
        } finally {
            release?.('cancelled'); await controller?.shutdown();
            vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; vscode.window.showOpenDialog = open;
            await fs.rm(prompt, { force: true });
        }
    });
    test('a second manual command gives feedback instead of silently disappearing during a run', async () => {
        const folder = vscode.workspace.workspaceFolders![0];
        const prompt = path.join(folder.uri.fsPath, `claude-busy-${randomUUID()}.md`);
        const a = job({ workspacePath: folder.uri.fsPath, promptPath: prompt, nextRunAt: Date.now() + 600000 });
        const b = job({ ...a, id: randomUUID() });
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, { version: 1, jobs: [a, b] }]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const information = vscode.window.showInformationMessage; const messages: string[] = [];
        let controller: ClaudeSchedulerController | undefined; let running: Thenable<unknown> | undefined;
        try {
            await fs.writeFile(prompt, 'review'); const marker = path.join(directory, 'busy-pid'); options.prefixArgs = [script, 'hang', marker];
            vscode.window.showInformationMessage = (async (message: string) => { messages.push(message); }) as typeof information;
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            running = vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', a);
            await until(async () => fs.stat(marker).then(() => true, () => false));
            await vscode.commands.executeCommand('taskhub.claudeScheduler.runNow', b);
            assert.ok(messages.some(message => /in progress|이미 처리/.test(message)));
            await vscode.commands.executeCommand('taskhub.claudeScheduler.stop', a); await running;
            assert.strictEqual(controller.engine.list()[1].lastRun, undefined);
        } finally {
            await controller?.shutdown(); await running; vscode.window.showInformationMessage = information;
            await fs.rm(prompt, { force: true });
        }
    });
    test('corrupt storage keeps commands available and reset backs up before replacing it', async () => {
        const corrupt = { version: 99, jobs: ['broken'] };
        const values = new Map<string, unknown>([[CLAUDE_SCHEDULES_KEY, corrupt]]);
        const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: {
            get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
        } } as unknown as vscode.ExtensionContext;
        const error = vscode.window.showErrorMessage; const warning = vscode.window.showWarningMessage; const info = vscode.window.showInformationMessage;
        const errors: string[] = [];
        let controller: ClaudeSchedulerController | undefined;
        try {
            vscode.window.showErrorMessage = (async (message: string) => { errors.push(message); }) as typeof error;
            vscode.window.showWarningMessage = (async () => 'Yes') as typeof warning;
            vscode.window.showInformationMessage = (async () => undefined) as typeof info;
            controller = new ClaudeSchedulerController(context, killProcessTree, () => options); await controller.ready;
            assert.ok((await vscode.commands.getCommands(true)).includes('taskhub.claudeScheduler.add'));
            await vscode.commands.executeCommand('taskhub.claudeScheduler.add');
            assert.ok(errors.some(message => /Reset Schedule Data|예약 데이터 초기화/.test(message)));
            assert.deepStrictEqual(values.get(CLAUDE_SCHEDULES_KEY), corrupt);
            await vscode.commands.executeCommand('taskhub.claudeScheduler.reset');
            assert.deepStrictEqual(values.get(CLAUDE_SCHEDULES_KEY), { version: 1, jobs: [] });
            const backups = (await fs.readdir(path.join(storage, 'claude-scheduler'))).filter(file => file.startsWith('corrupt-schedules-'));
            assert.strictEqual(backups.length, 1);
            assert.deepStrictEqual(JSON.parse(await fs.readFile(path.join(storage, 'claude-scheduler', backups[0]), 'utf8')), corrupt);
            await controller.engine.put(item);
            assert.strictEqual(controller.engine.list().length, 1);
        } finally {
            await controller?.shutdown(); vscode.window.showErrorMessage = error; vscode.window.showWarningMessage = warning; vscode.window.showInformationMessage = info;
        }
    });
    test('manifest menus follow enabled/paused state and the title has a recovery action', () => {
        const manifest = JSON.parse(require('fs').readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
        const configurations = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
        const properties = Object.assign({}, ...configurations.map((configuration: any) => configuration.properties));
        for (const suffix of ['maxTurns', 'maxBudgetUsd', 'maxDailyRuns', 'maxDailyBudgetUsd']) {
            assert.ok(!Object.prototype.hasOwnProperty.call(properties, `taskhub.claudeScheduler.${suffix}`));
        }
        const menus = manifest.contributes.menus;
        const title = menus['view/title'].filter((entry: any) => entry.when.includes('mainView.claudeSchedules'));
        assert.ok(title.some((entry: any) => entry.command.endsWith('.reset')));
        assert.ok(!title.some((entry: any) => entry.command.endsWith('.showSchedules')));
        for (const [command, state] of [['pause', 'Enabled'], ['resume', 'Paused']]) {
            assert.ok(menus['view/item/context'].some((entry: any) => entry.command === `taskhub.claudeScheduler.${command}` && entry.when.includes(`claudeSchedule${state}`)));
        }
        const provider = new ClaudeSchedulesProvider(() => [item], () => undefined, () => [item.id]);
        try { assert.strictEqual(provider.getTreeItem(item).contextValue, 'claudeScheduleQueued'); }
        finally { provider.dispose(); }
    });
});

suite('AI schedule settings and feature visibility', () => {
    test('stable settings are enabled and shown by default, with hidden legacy keys and localized titles', async () => {
        const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../..', 'package.json'), 'utf8'));
        const properties = manifest.contributes.configuration.properties;
        for (const key of ['experimental.aiScheduler.enabled', 'experimental.claudeScheduler.enabled', 'claudeScheduler.executable', 'claudeScheduler.model', 'claudeScheduler.timeoutSeconds']) {
            assert.strictEqual(properties[`taskhub.${key}`].included, false);
        }
        for (const current of ['aiScheduler.enabled', 'aiScheduler.executable', 'aiScheduler.model', 'aiScheduler.timeoutSeconds']) {
            assert.notStrictEqual(properties[`taskhub.${current}`].included, false);
            assert.strictEqual(properties[`taskhub.${current}`].scope, 'machine');
        }
        assert.strictEqual(properties['taskhub.aiScheduler.enabled'].default, true);
        assert.strictEqual(properties['taskhub.aiScheduler.showPanel'].default, true);
        assert.notStrictEqual(properties['taskhub.aiScheduler.showPanel'].included, false);
        const view = manifest.contributes.views.mainView.find((entry: any) => entry.id === 'mainView.claudeSchedules');
        assert.strictEqual(view.when, 'taskhub.aiScheduler.enabled && config.taskhub.aiScheduler.showPanel');
        for (const bundle of ['package.nls.json', 'package.nls.ko.json']) {
            const strings = JSON.parse(await fs.readFile(path.resolve(__dirname, '../..', bundle), 'utf8'));
            assert.doesNotMatch(strings['view.claudeSchedules'], /experimental|실험적/i);
            assert.doesNotMatch(strings['setting.aiSchedulerEnabled'], /experimental|실험적/i);
            assert.ok(strings['setting.aiSchedulerShowPanel']);
        }
    });
    test('new user settings take precedence including false and empty values; legacy user settings still work', () => {
        const original = vscode.workspace.getConfiguration;
        const user = new Map<string, unknown>([
            ['experimental.claudeScheduler.enabled', true], ['claudeScheduler.executable', '/company/assistant'],
            ['claudeScheduler.model', 'old-model'], ['claudeScheduler.timeoutSeconds', 120],
        ]);
        try {
            vscode.workspace.getConfiguration = (() => ({ inspect: (key: string) => ({ globalValue: user.get(key) }) })) as unknown as typeof original;
            assert.strictEqual(aiSchedulesEnabled(), true);
            assert.strictEqual(aiScheduleSetting('executable', 'claude'), '/company/assistant');
            assert.strictEqual(aiScheduleSetting('model', ''), 'old-model');
            assert.strictEqual(aiScheduleSetting('timeoutSeconds', 600), 120);
            user.set('experimental.aiScheduler.enabled', false);
            assert.strictEqual(aiSchedulesEnabled(), false);
            user.set('aiScheduler.enabled', true);
            assert.strictEqual(aiSchedulesEnabled(), true);
            user.set('aiScheduler.enabled', false);
            user.set('aiScheduler.executable', '/new/assistant');
            user.set('aiScheduler.model', '');
            user.set('aiScheduler.timeoutSeconds', 90);
            assert.strictEqual(aiSchedulesEnabled(), false);
            assert.strictEqual(aiScheduleSetting('executable', 'claude'), '/new/assistant');
            assert.strictEqual(aiScheduleSetting('model', ''), '');
            assert.strictEqual(aiScheduleSetting('timeoutSeconds', 600), 90);
            user.clear();
            assert.strictEqual(aiSchedulesEnabled(), true);
            assert.strictEqual(aiScheduleSetting('executable', 'claude'), 'claude');
        } finally { vscode.workspace.getConfiguration = original; }
    });
    test('only explicit legacy user enable values override the stable default', () => {
        const original = vscode.workspace.getConfiguration;
        const user = new Map<string, boolean>();
        try {
            vscode.workspace.getConfiguration = (() => ({ inspect: (key: string) => ({ globalValue: user.get(key),
                defaultValue: key === 'aiScheduler.enabled', workspaceValue: false, workspaceFolderValue: false }) })) as unknown as typeof original;
            assert.strictEqual(aiSchedulesEnabled(), true);
            user.set('experimental.claudeScheduler.enabled', false);
            assert.strictEqual(aiSchedulesEnabled(), false);
            user.set('experimental.aiScheduler.enabled', true);
            assert.strictEqual(aiSchedulesEnabled(), true);
            user.set('aiScheduler.enabled', false);
            assert.strictEqual(aiSchedulesEnabled(), false);
            user.set('aiScheduler.enabled', true); user.set('experimental.aiScheduler.enabled', false);
            assert.strictEqual(aiSchedulesEnabled(), true);
        } finally { vscode.workspace.getConfiguration = original; }
    });
    test('workspace and folder settings cannot choose the executable through new or legacy keys', () => {
        const original = vscode.workspace.getConfiguration;
        try {
            vscode.workspace.getConfiguration = (() => ({ inspect: () => ({ workspaceValue: 'unsafe', workspaceFolderValue: 'unsafe' }) })) as unknown as typeof original;
            assert.strictEqual(aiScheduleSetting('executable', 'claude'), 'claude');
            assert.strictEqual(aiSchedulesEnabled(), true);
        } finally { vscode.workspace.getConfiguration = original; }
    });
    for (const setting of ['aiScheduler.enabled', 'experimental.aiScheduler.enabled', 'experimental.claudeScheduler.enabled']) {
        test(`default activation and ${setting} toggles preserve cancellation and ignore panel visibility`, async () => {
            const get = vscode.workspace.getConfiguration; const onChange = vscode.workspace.onDidChangeConfiguration;
            const onTrust = vscode.workspace.onDidGrantWorkspaceTrust;
            const mutableWorkspace = vscode.workspace as unknown as { onDidChangeConfiguration: typeof onChange; onDidGrantWorkspaceTrust: typeof onTrust };
            let enabled: boolean | undefined; let changes!: (event: vscode.ConfigurationChangeEvent) => void;
            let created = 0; let disposed = 0; let listenersDisposed = 0; let finish!: () => void;
            const gate = new Promise<void>(resolve => { finish = resolve; });
            let registration: ReturnType<typeof registerClaudeScheduler> | undefined;
            try {
                vscode.workspace.getConfiguration = (() => ({ inspect: (key: string) => key === setting ? { globalValue: enabled } : undefined })) as unknown as typeof get;
                mutableWorkspace.onDidChangeConfiguration = ((listener: typeof changes) => { changes = listener; return new vscode.Disposable(() => { listenersDisposed++; }); }) as typeof onChange;
                mutableWorkspace.onDidGrantWorkspaceTrust = (() => new vscode.Disposable(() => { listenersDisposed++; })) as typeof onTrust;
                registration = registerClaudeScheduler({} as vscode.ExtensionContext, killProcessTree, () => {
                    created++;
                    return { engine: { runningId: 'fixture' }, dispose: () => { disposed++; }, shutdown: () => gate } as unknown as ClaudeSchedulerController;
                });
                await until(() => created === 1); assert.strictEqual(registration.hasRunning(), true);
                changes({ affectsConfiguration: key => key === 'taskhub.aiScheduler.showPanel' } as vscode.ConfigurationChangeEvent);
                await Promise.resolve(); assert.strictEqual(created, 1); assert.strictEqual(disposed, 0);
                enabled = false; changes({ affectsConfiguration: key => key === `taskhub.${setting}` } as vscode.ConfigurationChangeEvent);
                assert.strictEqual(disposed, 1); assert.strictEqual(registration.hasRunning(), true);
                enabled = true; changes({ affectsConfiguration: key => key === `taskhub.${setting}` } as vscode.ConfigurationChangeEvent);
                await Promise.resolve(); assert.strictEqual(created, 1);
                finish(); await until(() => created === 2);
                await registration.shutdown(); assert.strictEqual(listenersDisposed, 2); assert.strictEqual(disposed, 2);
            } finally {
                finish(); await registration?.shutdown(); vscode.workspace.getConfiguration = get;
                mutableWorkspace.onDidChangeConfiguration = onChange; mutableWorkspace.onDidGrantWorkspaceTrust = onTrust;
            }
        });
    }
    test('default activation waits for workspace trust', async () => {
        const get = vscode.workspace.getConfiguration; const onChange = vscode.workspace.onDidChangeConfiguration;
        const onTrust = vscode.workspace.onDidGrantWorkspaceTrust;
        const trusted = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted')!;
        const mutableWorkspace = vscode.workspace as unknown as { onDidChangeConfiguration: typeof onChange; onDidGrantWorkspaceTrust: typeof onTrust };
        let isTrusted = false; let grant!: () => void; let created = 0; let disposed = 0;
        let registration: ReturnType<typeof registerClaudeScheduler> | undefined;
        try {
            vscode.workspace.getConfiguration = (() => ({ inspect: () => undefined })) as unknown as typeof get;
            Object.defineProperty(vscode.workspace, 'isTrusted', { configurable: true, get: () => isTrusted });
            mutableWorkspace.onDidChangeConfiguration = (() => new vscode.Disposable(() => {})) as typeof onChange;
            mutableWorkspace.onDidGrantWorkspaceTrust = ((listener: () => void) => { grant = listener; return new vscode.Disposable(() => {}); }) as typeof onTrust;
            registration = registerClaudeScheduler({} as vscode.ExtensionContext, killProcessTree, () => {
                created++;
                return { engine: {}, dispose: () => { disposed++; }, shutdown: async () => {} } as unknown as ClaudeSchedulerController;
            });
            await Promise.resolve(); assert.strictEqual(created, 0);
            isTrusted = true; grant(); await until(() => created === 1);
            await registration.shutdown(); assert.strictEqual(disposed, 1);
        } finally {
            await registration?.shutdown(); vscode.workspace.getConfiguration = get;
            mutableWorkspace.onDidChangeConfiguration = onChange; mutableWorkspace.onDidGrantWorkspaceTrust = onTrust;
            Object.defineProperty(vscode.workspace, 'isTrusted', trusted);
        }
    });
    test('launcher exposes enable setting when off and opens schedules when on', () => {
        const disabled = buildFeatureLauncherItems([], 0, false, true).find(item => item.featureId === 'claudeScheduler');
        assert.strictEqual(disabled?.command, 'workbench.action.openSettings');
        assert.match(disabled?.label ?? '', /AI/);
        assert.deepStrictEqual(disabled?.commandArgs, ['@id:taskhub.aiScheduler.enabled']);
        assert.doesNotMatch(disabled?.label ?? '', /experimental|실험적/i);
        const enabled = buildFeatureLauncherItems(['claudeScheduler'], 0, true, true).filter(item => item.featureId === 'claudeScheduler');
        assert.strictEqual(enabled.length, 1); assert.strictEqual(enabled[0].command, 'taskhub.claudeScheduler.showSchedules');
        assert.match(enabled[0].label, /AI/);
        assert.doesNotMatch(enabled[0].label, /experimental|실험적/i);
        const hidden = buildFeatureLauncherItems(['claudeScheduler'], 0, true, false).filter(item => item.featureId === 'claudeScheduler');
        assert.strictEqual(hidden.length, 1); assert.strictEqual(hidden[0].command, 'workbench.action.openSettings');
        assert.deepStrictEqual(hidden[0].commandArgs, ['@id:taskhub.aiScheduler.showPanel']);
        assert.doesNotMatch(hidden[0].label, /experimental|실험적/i);
        const offAndHidden = buildFeatureLauncherItems([], 0, false, false).find(item => item.featureId === 'claudeScheduler');
        assert.deepStrictEqual(offAndHidden?.commandArgs, ['@id:taskhub.aiScheduler.enabled']);
    });
});
