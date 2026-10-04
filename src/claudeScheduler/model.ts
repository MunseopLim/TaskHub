export const CLAUDE_SCHEDULES_KEY = 'taskhub.claudeSchedules.v1';
export const MAX_CLAUDE_SCHEDULES = 50;
export class ClaudeSchedulerError extends Error {
    constructor(readonly code: 'invalidStorage' | 'invalidSchedule' | 'disposed' | 'running' | 'tooMany') { super(code); }
}

export type ClaudeCadence = { kind: 'interval'; minutes: number } | { kind: 'daily'; hour: number; minute: number };
export interface ClaudeRunResult {
    status: 'success' | 'failed' | 'stopped' | 'skipped' | 'queued' | 'running' | 'interrupted';
    startedAt: number;
    finishedAt?: number;
    report?: string;
    detail?: string;
}
export interface ClaudeSchedule {
    id: string;
    name: string;
    workspacePath: string;
    promptPath: string;
    mode: 'analysis' | 'edit';
    bashRules?: string[];
    cadence: ClaudeCadence;
    enabled: boolean;
    nextRunAt: number;
    lastRun?: ClaudeRunResult;
}
export interface ClaudeSchedulerState { version: 1; jobs: ClaudeSchedule[]; }

/** Memento values are JSON data; avoid structuredClone (unavailable in VS Code 1.75's Node 16). */
function copyData<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

const isInteger = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

export function validBashRules(value: unknown): value is string[] {
    return Array.isArray(value) && value.length <= 20 && value.every(rule => {
        if (typeof rule !== 'string' || rule.length > 500 || !/^Bash\([^\r\n\0,]+\)$/.test(rule)) { return false; }
        const command = rule.slice(5, -1).trim();
        // Legacy :* is a prefix wildcard, so an empty prefix would allow every command.
        const prefix = command.endsWith(':*') ? command.slice(0, -2).trim() : command;
        return prefix.length > 0 && !prefix.startsWith('*');
    });
}

function skipQueuedRun(job: ClaudeSchedule, now: number): void {
    if (job.lastRun?.status === 'queued') {
        job.lastRun = { ...job.lastRun, status: 'skipped', finishedAt: now, detail: 'scheduler-queued-cancelled' };
    }
}

export function validCadence(value: unknown): value is ClaudeCadence {
    if (!value || typeof value !== 'object') { return false; }
    const cadence = value as ClaudeCadence;
    return cadence.kind === 'interval' ? isInteger(cadence.minutes, 1, 10080)
        : cadence.kind === 'daily' && isInteger(cadence.hour, 0, 23) && isInteger(cadence.minute, 0, 59);
}

export function readSchedulerState(raw: unknown): ClaudeSchedulerState {
    if (raw === undefined) { return { version: 1, jobs: [] }; }
    const state = raw as ClaudeSchedulerState;
    if (!state || state.version !== 1 || !Array.isArray(state.jobs) || state.jobs.length > MAX_CLAUDE_SCHEDULES
        || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 1024 * 1024
        || !state.jobs.every(job => job && /^[a-f0-9-]{36}$/.test(job.id)
            && isText(job.name, 200) && isText(job.workspacePath, 4096) && isText(job.promptPath, 4096)
            && (job.mode === 'analysis' || job.mode === 'edit') && validCadence(job.cadence)
            && (job.bashRules === undefined || validBashRules(job.bashRules))
            && typeof job.enabled === 'boolean' && isInteger(job.nextRunAt, 0, 8_000_000_000_000_000)
            && (!job.lastRun || (['success', 'failed', 'stopped', 'skipped', 'queued', 'running', 'interrupted'].includes(job.lastRun.status)
                && isInteger(job.lastRun.startedAt, 0, 8_000_000_000_000_000)
                && (job.lastRun.finishedAt === undefined || isInteger(job.lastRun.finishedAt, 0, 8_000_000_000_000_000))
                && (job.lastRun.report === undefined || /^[a-f0-9-]{36}\.txt$/.test(job.lastRun.report))
                && (job.lastRun.detail === undefined || isText(job.lastRun.detail, 2000)))))
        || new Set(state.jobs.map(job => job.id)).size !== state.jobs.length) {
        throw new ClaudeSchedulerError('invalidStorage');
    }
    return copyData(state);
}

/** Daily times follow the extension host's local clock, including DST. */
export function nextClaudeRun(cadence: ClaudeCadence, after: number): number {
    if (!validCadence(cadence) || !Number.isFinite(after)) { throw new ClaudeSchedulerError('invalidSchedule'); }
    if (cadence.kind === 'interval') { return after + cadence.minutes * 60_000; }
    const next = new Date(after);
    next.setHours(cadence.hour, cadence.minute, 0, 0);
    if (next.getTime() <= after) {
        next.setDate(next.getDate() + 1);
        next.setHours(cadence.hour, cadence.minute, 0, 0);
    }
    return next.getTime();
}

/** Keep an interval's original clock grid when skipping a slot, also across windows. */
function skipClaudeRun(job: ClaudeSchedule, now: number): number {
    if (job.cadence.kind === 'daily') { return nextClaudeRun(job.cadence, now); }
    const interval = job.cadence.minutes * 60_000;
    return job.nextRunAt + (Math.floor(Math.max(0, now - job.nextRunAt) / interval) + 1) * interval;
}

export interface SchedulerDependencies {
    now(): number;
    schedule(callback: () => void, milliseconds: number): { dispose(): void };
    save(state: ClaudeSchedulerState): Promise<void>;
    run(job: ClaudeSchedule, signal: AbortSignal, scheduledAt?: number): Promise<ClaudeRunResult>;
    changed(): void;
    error(error: unknown): void;
}

/** One run at a time; reserve and persist a slot before dispatching the CLI. */
export class ClaudeScheduler {
    private state: ClaudeSchedulerState;
    private mutations: Promise<unknown> = Promise.resolve();
    private timer?: { dispose(): void };
    private active?: { id: string; abort: AbortController; done: Promise<void> };
    private pending: Array<{ id: string; scheduledAt: number }> = [];
    private ticking?: Promise<void>;
    private disposed = false;
    private initialized = false;
    constructor(raw: unknown, private readonly deps: SchedulerDependencies) { this.state = readSchedulerState(raw); }
    list(): ClaudeSchedule[] { return copyData(this.state.jobs); }
    get runningId(): string | undefined { return this.active?.id; }
    get queuedIds(): string[] { return this.pending.map(item => item.id); }

    private change(edit: (state: ClaudeSchedulerState) => void): Promise<void> {
        const next = this.mutations.then(async () => {
            const state = copyData(this.state);
            edit(state);
            readSchedulerState(state);
            await this.deps.save(state);
            this.state = state;
            if (!this.disposed) { this.deps.changed(); }
        });
        this.mutations = next.catch(() => undefined);
        return next;
    }

    async initialize(): Promise<void> {
        await this.change(state => {
            const now = this.deps.now();
            for (const job of state.jobs) {
                if (job.nextRunAt <= now) { job.nextRunAt = skipClaudeRun(job, now); }
                if (job.lastRun?.status === 'running') {
                    job.lastRun.status = 'interrupted';
                    job.enabled = false;
                } else { skipQueuedRun(job, now); }
            }
        });
        this.initialized = true;
        this.arm();
    }

    async put(job: ClaudeSchedule): Promise<void> {
        await this.change(state => {
            if (this.disposed) { throw new ClaudeSchedulerError('disposed'); }
            if (this.active?.id === job.id || this.pending.some(item => item.id === job.id)) { throw new ClaudeSchedulerError('running'); }
            const index = state.jobs.findIndex(item => item.id === job.id);
            if (index < 0 && state.jobs.length >= MAX_CLAUDE_SCHEDULES) { throw new ClaudeSchedulerError('tooMany'); }
            const saved = copyData(job);
            // A wizard may outlive a run or a pause. Merge only editable fields.
            if (index >= 0) {
                saved.enabled = state.jobs[index].enabled;
                saved.lastRun = state.jobs[index].lastRun;
            }
            saved.nextRunAt = nextClaudeRun(saved.cadence, this.deps.now());
            if (index < 0) { state.jobs.push(saved); } else { state.jobs[index] = saved; }
        });
        this.arm();
    }
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.change(state => {
            if (enabled && this.disposed) { throw new ClaudeSchedulerError('disposed'); }
            const job = state.jobs.find(item => item.id === id);
            if (!job) { return; }
            job.enabled = enabled;
            if (enabled) { job.nextRunAt = nextClaudeRun(job.cadence, this.deps.now()); }
            else if (job.lastRun?.status === 'queued') {
                job.lastRun = { status: 'stopped', startedAt: job.lastRun.startedAt, finishedAt: this.deps.now() };
            }
        });
        if (!enabled) { this.pending = this.pending.filter(item => item.id !== id); }
        this.arm();
    }
    async remove(id: string): Promise<void> {
        await this.change(state => {
            if (this.active?.id === id) { throw new ClaudeSchedulerError('running'); }
            state.jobs = state.jobs.filter(job => job.id !== id);
        });
        this.pending = this.pending.filter(item => item.id !== id);
        this.arm();
    }

    private arm(): void {
        this.timer?.dispose(); this.timer = undefined;
        if (this.disposed || !this.initialized) { return; }
        const times = this.state.jobs.filter(job => job.enabled).map(job => job.nextRunAt);
        if (!times.length) { return; }
        // Recheck wall-clock changes and sleep; never exceed Node's timer limit.
        const delay = Math.min(30_000, Math.max(1, Math.min(...times) - this.deps.now()));
        this.timer = this.deps.schedule(() => { void this.tick().catch(error => this.deps.error(error)); }, delay);
    }

    tick(): Promise<void> {
        if (!this.ticking) {
            this.ticking = this.tickDue().finally(() => { this.ticking = undefined; });
        }
        return this.ticking;
    }
    private async tickDue(): Promise<void> {
        if (this.disposed || !this.initialized) { return; }
        const now = this.deps.now();
        const due = this.state.jobs.filter(job => job.enabled && job.nextRunAt <= now).sort((a, b) => a.nextRunAt - b.nextRunAt);
        try {
            for (const job of due) {
                let enqueue = false;
                await this.change(state => {
                    const current = state.jobs.find(item => item.id === job.id);
                    if (current?.enabled && current.nextRunAt === job.nextRunAt) {
                        current.nextRunAt = skipClaudeRun(current, now);
                        if (this.active?.id === current.id || this.pending.some(item => item.id === current.id)) { return; }
                        if (now - job.nextRunAt < 60_000) {
                            current.lastRun = { status: 'queued', startedAt: job.nextRunAt };
                            enqueue = true;
                        } else {
                            current.lastRun = { status: 'skipped', startedAt: now, finishedAt: now, detail: 'scheduler-missed' };
                        }
                    }
                });
                if (enqueue) { this.pending.push({ id: job.id, scheduledAt: job.nextRunAt }); }
            }
        } catch (error) {
            for (const job of this.state.jobs) {
                job.enabled = false;
                if (job.lastRun?.status === 'queued') { job.lastRun.status = 'interrupted'; }
            }
            this.pending = [];
            this.deps.changed();
            throw error;
        } finally { this.drain(); this.arm(); }
    }

    private drain(): void {
        if (this.disposed || this.active) { return; }
        const next = this.pending.shift();
        if (next) { void this.start(next.id, next.scheduledAt).catch(error => this.deps.error(error)); }
    }

    async runNow(id: string): Promise<boolean> {
        if (this.disposed || !this.initialized || this.active || this.pending.length) { return false; }
        await this.start(id);
        return true;
    }
    private start(id: string, scheduledAt?: number): Promise<void> {
        if (this.disposed || this.active) { return Promise.resolve(); }
        const abort = new AbortController();
        // Assign before the first await so simultaneous timer/UI calls cannot overlap.
        const active = { id, abort, done: Promise.resolve() };
        this.active = active;
        active.done = (async () => {
            let snapshot: ClaudeSchedule | undefined;
            try {
                await this.change(state => {
                    const job = state.jobs.find(item => item.id === id);
                    if (!job || (scheduledAt !== undefined && (!job.enabled || job.lastRun?.status !== 'queued' || job.lastRun.startedAt !== scheduledAt))) { return; }
                    if (scheduledAt === undefined) { job.nextRunAt = nextClaudeRun(job.cadence, this.deps.now()); }
                    job.lastRun = { status: 'running', startedAt: this.deps.now() };
                    snapshot = copyData(job);
                });
                if (!snapshot) { return; }
                if (abort.signal.aborted || this.disposed) {
                    await this.change(state => {
                        const job = state.jobs.find(item => item.id === id);
                        if (job) { job.lastRun = { status: 'stopped', startedAt: snapshot!.lastRun!.startedAt, finishedAt: this.deps.now() }; job.enabled = false; }
                    });
                    return;
                }
                this.deps.changed();
                const result = await this.deps.run(snapshot, abort.signal, scheduledAt);
                await this.change(state => {
                    const job = state.jobs.find(item => item.id === id);
                    if (!job) { return; }
                    job.lastRun = result;
                    if (result.status === 'failed' || result.status === 'stopped') { job.enabled = false; }
                });
            } catch (error) {
                // Storage failures must not dispatch or silently reschedule a paid call.
                for (const job of this.state.jobs) {
                    job.enabled = false;
                    if (job.lastRun?.status === 'running' || job.lastRun?.status === 'queued') { job.lastRun.status = 'interrupted'; }
                }
                this.pending = [];
                throw error;
            } finally {
                if (this.active === active) { this.active = undefined; }
                if (!this.disposed) { this.deps.changed(); }
                this.drain();
                this.arm();
            }
        })();
        return active.done;
    }
    async stop(id: string): Promise<void> {
        const active = this.active;
        if (active?.id === id) { active.abort.abort(); }
        await this.setEnabled(id, false);
        if (active?.id === id) { await active.done; }
    }
    dispose(): void {
        this.disposed = true;
        this.timer?.dispose(); this.timer = undefined;
        this.active?.abort.abort();
    }
    async shutdown(): Promise<void> {
        this.dispose();
        await this.active?.done;
        await this.ticking?.catch(() => undefined);
        await this.mutations;
        // Unstarted slots are missed work; keep their future schedule enabled.
        if (this.pending.length) {
            await this.change(state => {
                for (const job of state.jobs) {
                    skipQueuedRun(job, this.deps.now());
                }
            });
            this.pending = [];
        }
    }
}
