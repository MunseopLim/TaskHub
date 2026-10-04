import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { CLAUDE_SCHEDULES_KEY, ClaudeRunResult, ClaudeSchedule, ClaudeScheduler, ClaudeSchedulerState, nextClaudeRun, readSchedulerState } from '../claudeScheduler/model';
import { ClaudeSchedulerController, registerClaudeScheduler } from '../claudeScheduler/controller';
import { ClaudeCliOptions, claudeArguments, claudeReportDirectory, parseClaudeResult, pruneClaudeReports, readClaudeReport, runScheduledClaude, supportsClaudeVersion } from '../claudeScheduler/runner';
import { ClaudeBudgetLimitError, reserveClaudeBudget, recordClaudeCost } from '../claudeScheduler/budget';
import { ClaudeSchedulesProvider } from '../providers/claudeSchedulesProvider';
import { killProcessTree } from '../extension';
import { buildFeatureLauncherItems } from '../featureLauncher';

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
        failSave: () => { failSave = true; }, runner: (value: typeof run) => { run = value; } };
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
            if(args.includes('--version')){console.log(scenario==='old'?'2.1.247 (Claude Code)':'2.1.248 (Claude Code)');process.exit(0);}
            let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
                if(scenario==='hang'){fs.writeFileSync(args[1],String(process.pid));setInterval(()=>{},1000);return;}
                if(scenario==='large'){process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);return;}
                if(scenario==='edit'||scenario==='cost-error'){fs.writeFileSync(args[1],'modified by fixture');}
                if(scenario==='cost-error'){fs.writeFileSync(args[2],'{corrupt');}
                const result={type:'result',subtype:scenario==='budget'?'error_max_budget_usd':'success',is_error:scenario==='fail',
                    total_cost_usd:scenario==='hourly'?0.4:0.1,result:JSON.stringify({prompt,args,cwd:process.cwd()}),permission_denials:scenario==='denied'?[{tool_name:'Bash'}]:[]};
                console.log(JSON.stringify(result));if(scenario==='fail'){process.exitCode=1;}
            });`);
        options = { executable: 'node', prefixArgs: [script, 'success'], timeoutSeconds: 5, maxTurns: 20, maxBudgetUsd: 1 };
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
    test('CLI version preflight rejects unsupported versions before a paid edit', async () => {
        const output = path.join(directory, 'not-edited.txt');
        options.prefixArgs = [script, 'old', output];
        const result = await run(item, options, storage); item.lastRun = result;
        assert.strictEqual(result.status, 'failed');
        assert.match(await readClaudeReport(storage, item), /2\.1\.248/);
        await assert.rejects(fs.stat(output));
        for (const version of ['2.1.248 (Claude Code)', '2.2.0 (Claude Code)', '3.0.0']) { assert.strictEqual(supportsClaudeVersion(version), true); }
        for (const version of ['2.1.247 (Claude Code)', '2.0.999', '2.1.248-beta', 'invalid']) { assert.strictEqual(supportsClaudeVersion(version), false); }
    });
    test('rolling daily run and budget limits survive retries and actual costs release unused budget', async () => {
        await fs.mkdir(storage, { recursive: true });
        const first = await reserveClaudeBudget(storage, 1, 2, 1, 1000);
        await assert.rejects(reserveClaudeBudget(storage, 1, 2, 1, 2000), ClaudeBudgetLimitError);
        await recordClaudeCost(storage, first, 0.1);
        await reserveClaudeBudget(storage, 0.5, 2, 1, 2000);
        await assert.rejects(reserveClaudeBudget(storage, 0.1, 2, 1, 3000), ClaudeBudgetLimitError);
        await reserveClaudeBudget(storage, 1, 2, 1, 2000 + 24 * 60 * 60000);
        await fs.writeFile(path.join(storage, 'usage.json'), '{corrupt');
        await assert.rejects(reserveClaudeBudget(storage, 1, 2, 1), error => error instanceof Error && !(error instanceof ClaudeBudgetLimitError));
        assert.strictEqual(await fs.readFile(path.join(storage, 'usage.json'), 'utf8'), '{corrupt');
    });
    test('daily limits skip both manual and scheduled model calls before a child can edit', async () => {
        const output = path.join(directory, 'edited.txt');
        options.maxDailyRuns = 1; options.prefixArgs = [script, 'edit', output];
        assert.strictEqual((await run(item, options, storage)).status, 'success');
        await fs.rm(output);
        for (const slot of [60000, undefined]) {
            const result = await run(item, options, storage, undefined, slot);
            assert.strictEqual(result.status, 'skipped');
            assert.strictEqual(result.detail, 'scheduler-budget');
            item.lastRun = result;
            assert.match(await readClaudeReport(storage, item), /Skipped|건너뜀/);
        }
        await assert.rejects(fs.stat(output));
    });
    test('count and cost limits keep the schedule enabled and retry at the next slot after capacity recovers', async () => {
        const output = path.join(directory, 'edited.txt');
        const root = await fs.realpath(directory);
        const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
        options.prefixArgs = [script, 'edit', output];
        for (const limits of [{ maxDailyRuns: 1 }, { maxDailyBudgetUsd: 1 }]) {
            const runStorage = path.join(storage, randomUUID());
            const f = fixtureEngine([item]);
            f.runner((current, signal, slot) => run(current, { ...options, ...limits }, runStorage, signal, slot));
            try {
                await f.engine.initialize();
                await f.engine.runNow(item.id);
                assert.strictEqual(f.engine.list()[0].lastRun?.status, 'success');
                await fs.rm(output);
                await f.engine.runNow(item.id);
                assert.strictEqual(f.engine.list()[0].lastRun?.status, 'skipped');
                assert.strictEqual(f.engine.list()[0].enabled, true);
                await assert.rejects(fs.stat(output));
                const ledgerPath = path.join(runStorage, 'claude-scheduler', 'locks', createHash('sha256').update(key).digest('hex'), 'usage.json');
                const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
                ledger.runs[0].at = Date.now() - 24 * 60 * 60000;
                await fs.writeFile(ledgerPath, JSON.stringify(ledger));
                f.now(60000); await f.engine.tick();
                await until(() => f.engine.list()[0].lastRun?.status === 'success');
                assert.strictEqual(f.calls.length, 3);
                assert.strictEqual(f.calls[2].slot, 60000);
                assert.strictEqual(f.engine.list()[0].enabled, true);
                assert.strictEqual(await fs.readFile(output, 'utf8'), 'modified by fixture');
            } finally { await f.engine.shutdown(); }
        }
    });
    test('cost-recording errors preserve the actual Claude output and completed workspace edits', async () => {
        const root = await fs.realpath(directory);
        const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
        const ledger = path.join(storage, 'claude-scheduler', 'locks', createHash('sha256').update(key).digest('hex'), 'usage.json');
        const output = path.join(directory, 'edited.txt');
        item.mode = 'edit'; options.prefixArgs = [script, 'cost-error', output, ledger];
        item.lastRun = await run(item, options, storage);
        assert.strictEqual(item.lastRun.status, 'failed');
        assert.strictEqual(await fs.readFile(output, 'utf8'), 'modified by fixture');
        const report = await readClaudeReport(storage, item);
        assert.ok(report.includes('cost-error'), 'The original Claude result must remain in the report');
        assert.match(report, /usage is corrupt|사용량 기록이 손상/);
    });
    test('hourly runs costing 0.40 USD skip after eleven completions without pausing at the default daily budget', async () => {
        item.cadence = { kind: 'interval', minutes: 60 }; item.nextRunAt = 3600000;
        options.prefixArgs = [script, 'hourly'];
        const f = fixtureEngine([item]);
        f.runner((current, signal, slot) => run(current, options, storage, signal, slot));
        try {
            await f.engine.initialize();
            for (let hour = 1; hour <= 12; hour++) {
                f.now(hour * 3600000); await f.engine.tick();
                await until(() => !f.engine.runningId && f.engine.list()[0].lastRun?.status !== 'queued');
                assert.strictEqual(f.engine.list()[0].lastRun?.status, hour <= 11 ? 'success' : 'skipped');
                assert.strictEqual(f.engine.list()[0].enabled, true);
            }
            assert.strictEqual(f.engine.list()[0].lastRun?.detail, 'scheduler-budget');
            assert.strictEqual(f.engine.list()[0].nextRunAt, 13 * 3600000);
        } finally { await f.engine.shutdown(); }
    });
    for (const scenario of ['fail', 'budget', 'denied']) {
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
                const choices = await items as Array<{ mode?: string; label: string }>;
                return choices.find(choice => choice.mode === 'edit') ?? choices[0];
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
    test('an edit wizard cannot erase a result or re-enable a schedule that failed while it was open', async () => {
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

suite('Claude experimental feature gate', () => {
    test('disabled by default, runtime toggles wait for cancellation, and dispose removes listeners', async () => {
        const get = vscode.workspace.getConfiguration; const onChange = vscode.workspace.onDidChangeConfiguration;
        const onTrust = vscode.workspace.onDidGrantWorkspaceTrust;
        const mutableWorkspace = vscode.workspace as unknown as { onDidChangeConfiguration: typeof onChange; onDidGrantWorkspaceTrust: typeof onTrust };
        let enabled = false; let changes!: (event: vscode.ConfigurationChangeEvent) => void;
        let created = 0; let disposed = 0; let listenersDisposed = 0; let finish!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        let registration: ReturnType<typeof registerClaudeScheduler> | undefined;
        try {
            vscode.workspace.getConfiguration = (() => ({ get: () => enabled })) as unknown as typeof get;
            mutableWorkspace.onDidChangeConfiguration = ((listener: typeof changes) => { changes = listener; return new vscode.Disposable(() => { listenersDisposed++; }); }) as typeof onChange;
            mutableWorkspace.onDidGrantWorkspaceTrust = (() => new vscode.Disposable(() => { listenersDisposed++; })) as typeof onTrust;
            registration = registerClaudeScheduler({} as vscode.ExtensionContext, killProcessTree, () => {
                created++;
                return { engine: { runningId: 'fixture' }, dispose: () => { disposed++; }, shutdown: () => gate } as unknown as ClaudeSchedulerController;
            });
            await Promise.resolve(); assert.strictEqual(created, 0);
            enabled = true; changes({ affectsConfiguration: () => true } as vscode.ConfigurationChangeEvent);
            await until(() => created === 1); assert.strictEqual(registration.hasRunning(), true);
            enabled = false; changes({ affectsConfiguration: () => true } as vscode.ConfigurationChangeEvent); assert.strictEqual(disposed, 1);
            enabled = true; changes({ affectsConfiguration: () => true } as vscode.ConfigurationChangeEvent);
            await Promise.resolve(); assert.strictEqual(created, 1);
            finish(); await until(() => created === 2);
            await registration.shutdown(); assert.strictEqual(listenersDisposed, 2); assert.strictEqual(disposed, 2);
        } finally {
            finish(); await registration?.shutdown(); vscode.workspace.getConfiguration = get;
            mutableWorkspace.onDidChangeConfiguration = onChange; mutableWorkspace.onDidGrantWorkspaceTrust = onTrust;
        }
    });
    test('launcher exposes enable setting when off and opens schedules when on', () => {
        const disabled = buildFeatureLauncherItems([], 0, false).find(item => item.featureId === 'claudeScheduler');
        assert.strictEqual(disabled?.command, 'workbench.action.openSettings');
        assert.deepStrictEqual(disabled?.commandArgs, ['@id:taskhub.experimental.claudeScheduler.enabled']);
        const enabled = buildFeatureLauncherItems(['claudeScheduler'], 0, true).filter(item => item.featureId === 'claudeScheduler');
        assert.strictEqual(enabled.length, 1); assert.strictEqual(enabled[0].command, 'taskhub.claudeScheduler.showSchedules');
    });
});
