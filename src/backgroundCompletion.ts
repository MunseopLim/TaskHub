/**
 * Long-running action completion policy and batching.
 *
 * This module deliberately has no VS Code dependency. The extension host
 * supplies the current focus state and renders the resulting batch; keeping
 * the threshold/policy/batching rules pure makes the attention boundary easy
 * to test without sleeping or opening notifications.
 */

export type BackgroundCompletionOutcome = 'success' | 'failure' | 'stopped';
export type BackgroundCompletionNotificationMode = 'whenUnfocused' | 'always' | 'never';

export interface BackgroundCompletionPolicy {
    thresholdMs: number;
    outcomes: ReadonlySet<BackgroundCompletionOutcome>;
    notificationMode: BackgroundCompletionNotificationMode;
}

export interface BackgroundCompletionEvent {
    title: string;
    outcome: BackgroundCompletionOutcome;
    durationMs: number;
    /** Existing action-specific/generic completion text, already safe to display. */
    message?: string;
    /** False still contributes to the short status display, but not to a toast. */
    showNotification: boolean;
}

export type BackgroundCompletionSeverity = 'info' | 'warning' | 'error';

export interface BackgroundCompletionPresentation {
    severity: BackgroundCompletionSeverity;
    statusText: string;
    notificationText: string;
}

export function isBackgroundCompletionOutcome(value: unknown): value is BackgroundCompletionOutcome {
    return value === 'success' || value === 'failure' || value === 'stopped';
}

export function isBackgroundCompletionNotificationMode(
    value: unknown
): value is BackgroundCompletionNotificationMode {
    return value === 'whenUnfocused' || value === 'always' || value === 'never';
}

/** Whether this run is long enough and has an enabled terminal outcome. */
export function shouldSurfaceBackgroundCompletion(
    durationMs: number,
    outcome: BackgroundCompletionOutcome,
    policy: BackgroundCompletionPolicy
): boolean {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return false;
    }
    const thresholdMs = Number.isFinite(policy.thresholdMs)
        ? Math.max(0, policy.thresholdMs)
        : 0;
    return durationMs >= thresholdMs && policy.outcomes.has(outcome);
}

/**
 * Focus is sampled when the action ends. A later focus change must not turn a
 * completion that happened in the foreground into a background notification.
 */
export function shouldShowBackgroundCompletionNotification(
    mode: BackgroundCompletionNotificationMode,
    windowFocused: boolean
): boolean {
    return mode === 'always' || (mode === 'whenUnfocused' && !windowFocused);
}

function durationText(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
    }
    if (ms < 3_600_000) {
        const minutes = Math.floor(ms / 60_000);
        const seconds = Math.floor((ms % 60_000) / 1000);
        return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
    }
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function severityOf(events: readonly BackgroundCompletionEvent[]): BackgroundCompletionSeverity {
    if (events.some(event => event.outcome === 'failure')) {
        return 'error';
    }
    if (events.some(event => event.outcome === 'stopped')) {
        return 'warning';
    }
    return 'info';
}

function iconOf(severity: BackgroundCompletionSeverity): string {
    switch (severity) {
        case 'error': return '$(error)';
        case 'warning': return '$(debug-stop)';
        default: return '$(check)';
    }
}

function outcomeText(outcome: BackgroundCompletionOutcome, lang: 'ko' | 'en'): string {
    if (lang === 'ko') {
        switch (outcome) {
            case 'success': return '성공';
            case 'failure': return '실패';
            case 'stopped': return '중지';
        }
    }
    switch (outcome) {
        case 'success': return 'succeeded';
        case 'failure': return 'failed';
        case 'stopped': return 'stopped';
    }
}

/** Format either one completion or a collapsed multi-action summary. */
export function formatBackgroundCompletionPresentation(
    events: readonly BackgroundCompletionEvent[],
    lang: 'ko' | 'en'
): BackgroundCompletionPresentation | undefined {
    if (events.length === 0) {
        return undefined;
    }
    const severity = severityOf(events);
    const icon = iconOf(severity);

    if (events.length === 1) {
        const event = events[0];
        const duration = durationText(event.durationMs);
        const outcome = outcomeText(event.outcome, lang);
        const statusText = `${icon} TaskHub: ${event.title} — ${outcome} (${duration})`;
        const generic = lang === 'ko'
            ? `TaskHub: '${event.title}' 액션 ${outcome} (${duration}).`
            : `TaskHub: Action '${event.title}' ${outcome} (${duration}).`;
        return {
            severity,
            statusText,
            notificationText: event.message ? `${event.message} (${duration})` : generic,
        };
    }

    const count = (outcome: BackgroundCompletionOutcome) =>
        events.filter(event => event.outcome === outcome).length;
    const succeeded = count('success');
    const failed = count('failure');
    const stopped = count('stopped');
    const parts = lang === 'ko'
        ? [succeeded > 0 ? `성공 ${succeeded}` : '', failed > 0 ? `실패 ${failed}` : '', stopped > 0 ? `중지 ${stopped}` : ''].filter(Boolean)
        : [succeeded > 0 ? `${succeeded} succeeded` : '', failed > 0 ? `${failed} failed` : '', stopped > 0 ? `${stopped} stopped` : ''].filter(Boolean);
    const summary = lang === 'ko'
        ? `TaskHub: 액션 ${events.length}개 종료 — ${parts.join(', ')}.`
        : `TaskHub: ${events.length} actions finished — ${parts.join(', ')}.`;
    return { severity, statusText: `${icon} ${summary}`, notificationText: summary };
}

export interface BackgroundCompletionTimer {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
}

const defaultTimer: BackgroundCompletionTimer = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Groups completions in one fixed window starting at the first event. The
 * timer is intentionally not reset for later events, so a steady stream of
 * finishes cannot postpone feedback indefinitely.
 */
export class BackgroundCompletionBatcher {
    private readonly pending: BackgroundCompletionEvent[] = [];
    private timerHandle: unknown;
    private disposed = false;

    constructor(
        private readonly onFlush: (events: readonly BackgroundCompletionEvent[]) => void,
        private readonly delayMs: number = 750,
        private readonly timer: BackgroundCompletionTimer = defaultTimer
    ) {}

    enqueue(event: BackgroundCompletionEvent): void {
        if (this.disposed) {
            return;
        }
        this.pending.push(event);
        if (this.timerHandle === undefined) {
            this.timerHandle = this.timer.set(() => this.flush(), this.delayMs);
        }
    }

    flush(): void {
        if (this.timerHandle !== undefined) {
            this.timer.clear(this.timerHandle);
            this.timerHandle = undefined;
        }
        if (this.pending.length === 0) {
            return;
        }
        const events = this.pending.splice(0, this.pending.length);
        this.onFlush(events);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timerHandle !== undefined) {
            this.timer.clear(this.timerHandle);
            this.timerHandle = undefined;
        }
        this.pending.length = 0;
    }
}
