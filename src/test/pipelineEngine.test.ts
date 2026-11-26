import * as assert from 'node:assert/strict';
import { buildTaskGraph } from '../pipelineUtils';
import { approximateResultBytes, runPipelineEngine, type PipelineEngineHost, type PipelineTaskAttempt,
    type PipelineTaskOutcome } from '../pipelineEngine';
import { ActionRunLogCollector } from '../runLogStore';
import type { Task } from '../schema';

type Body = (task: Task, results: Record<string, unknown>) => Promise<unknown>;

/** A host whose task bodies come from `bodies`; it records what the engine asked of it. */
function makeHost(tasks: Task[], bodies: Record<string, Body>, overrides: Partial<PipelineEngineHost> = {}) {
    const events: string[] = [];
    const settled: PipelineTaskOutcome[] = [];
    const log = new ActionRunLogCollector('a', 'A', 0, tasks);
    const stepResults: Record<string, unknown> = Object.create(null);
    const host: PipelineEngineHost = {
        tasks, graph: buildTaskGraph(tasks), maxConcurrency: 4, totalResultLimitBytes: 1024 * 1024,
        builtinVariables: Object.create(null), log, stepResults,
        prepare(task): PipelineTaskAttempt {
            return {
                start: conditionFailure => {
                    if (conditionFailure) { return Promise.reject(conditionFailure.error); }
                    events.push('start:' + task.id);
                    return bodies[task.id](task, stepResults);
                },
                onTimeout: () => { events.push('timeout:' + task.id); },
                succeeded: () => undefined,
                failed: error => ({ error, continuable: !error.message.includes('stopped'), log: { error: error.message } }),
            };
        },
        skippedReferenceReason: () => 'skipped reference',
        conditionNotMetReason: () => 'condition not met',
        taskSettled: outcome => { settled.push(outcome); },
        abortInFlight: async inFlight => { events.push('abort:' + [...inFlight.keys()].join(',')); await Promise.allSettled(inFlight.values()); },
        resultLimitError: limit => new Error('limit ' + limit),
        stalledError: () => new Error('stalled'),
        ...overrides,
    };
    return { host, events, settled, log };
}

const value = (result: unknown): Body => async () => result;
const fail = (message: string): Body => async () => { throw new Error(message); };
const delay = (ms: number, result: unknown = {}): Body => () => new Promise(resolve => setTimeout(() => resolve(result), ms));
const statuses = (log: ActionRunLogCollector) =>
    Object.fromEntries(log.finish('success', 1).tasks.map(task => [task.taskId, task.status]));

suite('Shared pipeline engine', () => {
    test('passes results to dependants and keeps a __proto__ task id as an ordinary key', async () => {
        const tasks = [
            { id: '__proto__', type: 'stringManipulation' },
            { id: 'next', type: 'stringManipulation', input: '${__proto__.output}' },
        ] as Task[];
        let seen: unknown;
        const { host } = makeHost(tasks, {
            ['__proto__']: value({ output: 'first' }),
            next: async (_task, results) => { seen = (results['__proto__'] as { output: string }).output; return {}; },
        });
        const { stepResults, failures } = await runPipelineEngine(host);
        assert.deepEqual(failures, []);
        assert.equal(seen, 'first');
        assert.ok(Object.hasOwn(stepResults, '__proto__'));
    });

    test('skips a false condition and every task that references the skipped result', async () => {
        const tasks = [
            { id: 'flag', type: 'stringManipulation' },
            { id: 'gated', type: 'stringManipulation', when: { var: '${flag.output}', equals: 'yes' } },
            { id: 'dependent', type: 'writeFile', content: '${gated.output}' },
            { id: 'independent', type: 'writeFile', content: '${flag.output}' },
        ] as Task[];
        const { host, events, log } = makeHost(tasks, {
            flag: value({ output: 'no' }), gated: value({}), dependent: value({}), independent: value({}),
        });
        await runPipelineEngine(host);
        assert.deepEqual(events.filter(event => event.startsWith('start:')).sort(), ['start:flag', 'start:independent']);
        const finished = log.finish('success', 1).tasks;
        assert.deepEqual(finished.map(task => [task.taskId, task.status, task.error]), [
            ['flag', 'success', undefined],
            ['gated', 'condition-skipped', 'condition not met'],
            ['dependent', 'condition-skipped', 'skipped reference'],
            ['independent', 'success', undefined],
        ]);
    });

    test('continues after a continueOnError failure, but not after one the host marks as stopped', async () => {
        const tasks = [
            { id: 'soft', type: 'command', continueOnError: true },
            { id: 'after', type: 'command', dependsOn: ['soft'] },
        ] as Task[];
        const soft = makeHost(tasks, { soft: fail('boom'), after: value({}) });
        assert.deepEqual((await runPipelineEngine(soft.host)).failures, []);
        assert.deepEqual(statuses(soft.log), { soft: 'continued', after: 'success' });

        const stopped = makeHost(tasks, { soft: fail('stopped by user'), after: value({}) });
        const { failures } = await runPipelineEngine(stopped.host);
        assert.deepEqual(failures.map(failure => failure.taskId), ['soft']);
        assert.deepEqual(statuses(stopped.log), { soft: 'failure', after: 'not-run' });
    });

    test('a failure starts no new task but lets a running sibling finish', async () => {
        const tasks = [
            { id: 'fails', type: 'command', parallel: true },
            { id: 'slow', type: 'command', parallel: true },
            { id: 'after', type: 'command', dependsOn: ['fails', 'slow'] },
        ] as Task[];
        const { host, events, log } = makeHost(tasks, { fails: fail('boom'), slow: delay(50), after: value({}) });
        const { failures } = await runPipelineEngine(host);
        assert.deepEqual(failures.map(failure => failure.taskId), ['fails']);
        assert.deepEqual(statuses(log), { fails: 'failure', slow: 'success', after: 'not-run' });
        assert.ok(!events.some(event => event.startsWith('abort:')), 'an ordinary failure waits instead of aborting');
    });

    test('times out a task through the host and fails it without waiting for its body', async () => {
        const tasks = [{ id: 'long', type: 'command', timeoutSeconds: 0.05 }] as Task[];
        const { host, events } = makeHost(tasks, { long: delay(1_000) });
        const started = Date.now();
        const { failures } = await runPipelineEngine(host);
        assert.ok(Date.now() - started < 2_000);
        assert.equal(failures[0].error.name, 'TaskTimeoutError');
        assert.ok(events.includes('timeout:long'));
    });

    test('settles a timed-out task only after the work the host stops has finished', async () => {
        const tasks = [
            { id: 'long', type: 'command', timeoutSeconds: 0.02, continueOnError: true },
            { id: 'next', type: 'command', dependsOn: ['long'] },
        ] as Task[];
        let stopped = false;
        const { host, events } = makeHost(tasks, { long: delay(1_000), next: async () => { events.push('next saw stopped=' + stopped); return {}; } });
        const prepare = host.prepare;
        host.prepare = task => ({ ...prepare(task), onTimeout: () => new Promise<void>(resolve => setTimeout(() => { stopped = true; resolve(); }, 50)) });
        await runPipelineEngine(host);
        assert.ok(events.includes('next saw stopped=true'), events.join(','));
    });

    test('settles a timed-out task even when stopping its work fails', async () => {
        const tasks = [{ id: 'long', type: 'command', timeoutSeconds: 0.02 }] as Task[];
        const { host } = makeHost(tasks, { long: delay(1_000) });
        const prepare = host.prepare;
        host.prepare = task => ({ ...prepare(task), onTimeout: () => Promise.reject(new Error('cleanup failed')) });
        const { failures } = await runPipelineEngine(host);
        assert.equal(failures[0].error.name, 'TaskTimeoutError');
    });

    test('stops running siblings and throws when the combined result limit is exceeded', async () => {
        const tasks = [
            { id: 'big', type: 'command', parallel: true },
            { id: 'slow', type: 'command', parallel: true },
            { id: 'after', type: 'command', dependsOn: ['big', 'slow'] },
        ] as Task[];
        const { host, events, settled } = makeHost(tasks,
            { big: value({ output: 'x'.repeat(64) }), slow: delay(50), after: value({}) },
            { totalResultLimitBytes: 16 });
        await assert.rejects(runPipelineEngine(host), /limit 16/);
        assert.ok(events.includes('abort:slow'));
        assert.ok(!events.includes('start:after'));
        // The task over the limit completed but is not reported as settled, so no success transition is shown.
        assert.deepEqual(settled, []);
    });

    test('fails a task whose condition cannot be evaluated through the shared failure policy', async () => {
        const tasks = [{ id: 'bad', type: 'command', when: { var: 'x', equals: 'x' }, continueOnError: true }] as Task[];
        const { host, log } = makeHost(tasks, { bad: value({}) }, {
            conditionNotMetReason: () => 'unused',
            builtinVariables: new Proxy(Object.create(null), { ownKeys: () => { throw new Error('broken context'); } }),
        });
        const { failures } = await runPipelineEngine(host);
        assert.deepEqual(failures, []);
        assert.deepEqual(statuses(log), { bad: 'continued' });
    });

    test('respects maxConcurrency, reports failures in settle order and logs the host output', async () => {
        const tasks = ['a', 'b', 'c'].map(id => ({ id, type: 'command', parallel: true })) as Task[];
        let running = 0;
        let peak = 0;
        const body = (ms: number, error?: string): Body => async () => {
            peak = Math.max(peak, ++running);
            await new Promise(resolve => setTimeout(resolve, ms));
            running--;
            if (error) { throw new Error(error); }
            return { output: 'out' };
        };
        const { host, log } = makeHost(tasks, { a: body(60, 'late'), b: body(10, 'early'), c: body(5) }, { maxConcurrency: 2 });
        const prepare = host.prepare;
        host.prepare = task => ({ ...prepare(task), succeeded: () => ({ availability: 'captured', stdout: 'shown', stderr: '' }) });
        const { failures } = await runPipelineEngine(host);
        assert.equal(peak, 2);
        assert.deepEqual(failures.map(failure => failure.taskId), ['b', 'a']);
        const c = log.finish('failure', 1).tasks.find(task => task.taskId === 'c');
        // c starts only if a slot frees before the first failure stops new tasks.
        if (c?.status === 'success') { assert.equal(c.output.stdout, 'shown'); }
    });

    test('stops running tasks when the host throws, and keeps that error when cleanup fails', async () => {
        const tasks = [
            { id: 'slow', type: 'command', parallel: true },
            { id: 'quick', type: 'command', parallel: true },
        ] as Task[];
        const { host, events } = makeHost(tasks, { slow: delay(50), quick: value({}) }, {
            taskSettled: () => { throw new Error('host bug'); },
            abortInFlight: async inFlight => { events.push('abort:' + [...inFlight.keys()].join(',')); throw new Error('cleanup failed'); },
        });
        await assert.rejects(runPipelineEngine(host), /host bug/);
        assert.ok(events.includes('abort:slow'));

    });

    test('measures results by their captured strings', () => {
        assert.equal(approximateResultBytes({ output: 'abc', nested: { list: ['é'] }, count: 1 }), 3 + 2 + 8);
        assert.equal(approximateResultBytes({ a: { b: { c: { d: { e: 'deep' } } } } }), 0);
    });
});
