/**
 * History view TreeDataProvider and its supporting TreeItem (HistoryItem),
 * plus the `HistoryEntry` shape persisted in workspace state.
 *
 * Extracted from `extension.ts` (phase 2 module split). `extension.ts`
 * re-exports everything here so existing callers (including tests) can keep
 * `import { ... } from './extension'` unchanged.
 */

import * as vscode from 'vscode';

export interface HistoryEntry {
    actionId: string;
    actionTitle: string;
    timestamp: number;
    status: 'success' | 'failure' | 'running';
    output?: string;
    /**
     * Per-task captured input values from interactive tasks (inputBox /
     * quickPick / envPick / fileDialog / folderDialog / confirm), keyed by
     * task id. Replay-with-saved-inputs (`taskhub.rerunFromHistoryWithInputs`)
     * uses these values as preset task results so the dialogs are skipped.
     * Absent for entries written before this field existed and for actions
     * that have no interactive tasks. `password: true` inputBoxes are
     * deliberately omitted to avoid persisting secrets.
     */
    inputs?: Record<string, unknown>;
    /**
     * Wall-clock execution time in milliseconds. Set when the entry
     * transitions from `running` to a terminal status. Absent for entries
     * still in flight and for entries written before this field existed.
     * Used to render the "last run" badge on each `HistoryItem`.
     */
    durationMs?: number;
    /**
     * Full breadcrumb path (folder titles + action title) at the moment of
     * execution. Used to disambiguate `HistoryItem` labels when two actions
     * share the same title (e.g. `Firmware/Build` vs `Bootloader/Build`,
     * or two root-level `Build` actions). Frozen at write time so
     * renaming/deleting the action later doesn't corrupt history. Absent
     * for legacy entries (written before this field existed) and for
     * entries written when the action couldn't be located in the loaded
     * tree. Root-level actions are stored as a single-element path
     * (`['Build']`); the breadcrumb swap requires length > 1, so root
     * entries fall through to `computeDisambiguatedHistoryLabels`'s
     * `Title (actionId)` collision-fallback when their bare title clashes
     * with another action.
     */
    actionPath?: string[];
}

/**
 * Format a wall-clock duration in milliseconds for the HistoryItem badge.
 * Tuned for compact display in TreeItem.description.
 *   - <1000ms     → "Nms"
 *   - <60s        → "N.Ns" (one decimal)
 *   - <60min      → "Nm Ms"
 *   - >=1 hour    → "Hh Mm"
 * Negative or non-finite inputs return "0ms" (defensive — wall clock
 * can briefly skew under NTP correction).
 */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return '0ms';
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    if (ms < 60_000) {
        // Truncate (not round) so 59999ms stays as "59.9s" instead of
        // crossing into "60.0s" — the next branch already covers ≥1min.
        return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
    }
    if (ms < 3_600_000) {
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return s === 0 ? `${m}m` : `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Format a history entry timestamp relative to "now" for the HistoryItem
 * badge. Absolute time is preferred over relative (e.g. "5분 전") because
 * TreeItem descriptions don't auto-refresh, so relative text would silently
 * grow stale.
 *   - same calendar day  → "HH:mm"
 *   - previous day       → "어제 HH:mm" / "Yest HH:mm"
 *   - older              → "MM/DD"
 * `now` is injected so the formatter is fully deterministic and unit-testable.
 */
export function formatHistoryTimestamp(timestamp: number, now: number, lang: 'ko' | 'en' = 'ko'): string {
    const t = new Date(timestamp);
    const n = new Date(now);
    const sameYMD = t.getFullYear() === n.getFullYear()
        && t.getMonth() === n.getMonth()
        && t.getDate() === n.getDate();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    if (sameYMD) {
        return `${hh}:${mm}`;
    }
    // Yesterday: subtract one day from `now` (handles month/year boundaries).
    const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    const isYesterday = t.getFullYear() === yesterday.getFullYear()
        && t.getMonth() === yesterday.getMonth()
        && t.getDate() === yesterday.getDate();
    if (isYesterday) {
        const prefix = lang === 'ko' ? '어제' : 'Yest';
        return `${prefix} ${hh}:${mm}`;
    }
    const month = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return `${month}/${day}`;
}

/**
 * Build the "last run" badge string for a HistoryItem's `description`.
 * Actions panel does NOT render this badge — the data lives on the
 * history entry, so the History panel is the single home (regression
 * guard: `IT-068b`).
 *
 * Returns `undefined` when no badge should be rendered:
 *   - no entry available
 *   - entry is still `running` (the iconPath spinner is louder than text)
 *
 * Sample outputs (lang='ko'):
 *   - "✓ 14:30 · 1.2s"
 *   - "✗ 어제 09:15 · 45ms"
 *   - "✓ 12/15"  (older entry without a recorded duration)
 *
 * `executeAction` clamps `durationMs` with `Math.max(0, ...)` at write time
 * so a clock-skew negative never reaches storage, but if one slips through
 * (legacy entry from a hypothetical buggy writer), `formatDuration`
 * collapses it to `"0ms"` rather than silently dropping the duration —
 * surfacing "ran instantly" is more truthful than hiding the field.
 */
export function formatLastRunBadge(
    entry: HistoryEntry | undefined,
    now: number,
    lang: 'ko' | 'en' = 'ko'
): string | undefined {
    if (!entry || entry.status === 'running') {
        return undefined;
    }
    const status = entry.status === 'success' ? '✓' : '✗';
    const timeText = formatHistoryTimestamp(entry.timestamp, now, lang);
    if (entry.durationMs !== undefined) {
        return `${status} ${timeText} · ${formatDuration(entry.durationMs)}`;
    }
    return `${status} ${timeText}`;
}

/**
 * Compute a display label per history entry, swapping in the full
 * breadcrumb path (`Firmware > Build`) for entries whose bare title
 * collides with a different action elsewhere in the history.
 *
 * Collision is "two distinct actionIds share the same actionTitle" — the
 * same action run repeatedly does NOT count, so `Build` stays bare when
 * there's only one Build in the panel even if it ran ten times.
 *
 * On collision, the resolution depends on what's recorded for the entry:
 *   - **Folder + title path available** (`actionPath.length > 1`): swap
 *     to `Firmware > Build`. This is the common, informative case.
 *   - **No usable path** (root-level action whose stored path is just
 *     the title, or a legacy entry that lacks the field entirely):
 *     fall back to `Build (actionId)`. The id suffix is the only signal
 *     left when the breadcrumb itself can't disambiguate.
 *
 * After the path swap, a SECOND pass guards against distinct actionIds
 * that ended up with identical path-joined labels — possible when the
 * action tree has duplicate folder structures, or when a legacy entry
 * stored a path that now matches a renamed action's current path. Such
 * entries get an `(actionId)` suffix so the panel never shows two
 * visually identical rows that point at different actions. Same-id
 * repeated runs sharing the same path do NOT get the suffix.
 *
 * Invariant: distinct actionIds in the history never share a final
 * display label (label is either undefined, in which case
 * `HistoryItem` falls back to the bare title — only safe when the
 * bare title is itself unambiguous, or carries enough disambiguation
 * to identify which action this row belongs to).
 *
 * Returned array is index-aligned with `history` so callers can pass
 * `labels[i]` straight to the corresponding `HistoryItem` constructor.
 */
export function computeDisambiguatedHistoryLabels(history: HistoryEntry[]): (string | undefined)[] {
    // Step 1: title-based collision → swap in full breadcrumb path, or
    // fall back to `Title (actionId)` when there's no usable path.
    const titleToActionIds = new Map<string, Set<string>>();
    for (const entry of history) {
        let set = titleToActionIds.get(entry.actionTitle);
        if (!set) {
            set = new Set();
            titleToActionIds.set(entry.actionTitle, set);
        }
        set.add(entry.actionId);
    }
    const pathLabels: (string | undefined)[] = history.map(entry => {
        const collides = (titleToActionIds.get(entry.actionTitle)?.size ?? 0) > 1;
        if (!collides) {
            return undefined;  // HistoryItem falls back to entry.actionTitle
        }
        if (entry.actionPath && entry.actionPath.length > 1) {
            return entry.actionPath.join(' > ');
        }
        // Title collision but no usable path (root-level action, or
        // legacy entry without actionPath). The breadcrumb can't help —
        // attach actionId so distinct ids never share a row label.
        return `${entry.actionTitle} (${entry.actionId})`;
    });

    // Step 2: path-based collision → append `(actionId)` suffix when two
    // distinct actionIds resolve to the same path-joined label. Step 1's
    // `Title (actionId)` fallback is already id-tagged, so it never
    // participates in further collisions here.
    const labelToActionIds = new Map<string, Set<string>>();
    for (let i = 0; i < pathLabels.length; i++) {
        const label = pathLabels[i];
        if (!label) {
            continue;
        }
        let set = labelToActionIds.get(label);
        if (!set) {
            set = new Set();
            labelToActionIds.set(label, set);
        }
        set.add(history[i].actionId);
    }
    return pathLabels.map((label, i) => {
        if (!label) {
            return undefined;
        }
        const ids = labelToActionIds.get(label);
        if (ids && ids.size > 1) {
            return `${label} (${history[i].actionId})`;
        }
        return label;
    });
}

/**
 * Periodic auto-refresh for the history view so badges that contain a
 * relative-day reference (`HH:mm` → `어제 HH:mm` → `MM/DD`) don't go stale
 * when VS Code stays open across midnight.
 *
 * Implementation note: TreeItem.description is computed inside the
 * `HistoryItem` constructor, which only runs when `getChildren()` is
 * called. Firing `historyProvider.refresh()` here re-emits the
 * `onDidChangeTreeData` event; VS Code calls `getChildren()` again only
 * if the view is visible, so the cost while hidden is essentially nil
 * (one event emission per `intervalMs`).
 *
 * Returns a `Disposable` so the caller can attach it to
 * `context.subscriptions` and ensure the timer stops on extension
 * deactivate.
 */
export function startHistoryAutoRefresh(
    target: { refresh(): void },
    intervalMs: number
): vscode.Disposable {
    const handle = setInterval(() => target.refresh(), intervalMs);
    return { dispose: () => clearInterval(handle) };
}

export class HistoryItem extends vscode.TreeItem {
    constructor(private entry: HistoryEntry, displayLabel?: string) {
        // `displayLabel` is supplied by `HistoryProvider.getChildren` when a
        // same-title collision is detected across history; otherwise it falls
        // back to the bare action title so root-level / non-colliding entries
        // stay terse.
        super(displayLabel ?? entry.actionTitle, vscode.TreeItemCollapsibleState.None);

        if (entry.status === 'success') {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        } else if (entry.status === 'failure') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }

        const hasInputs = !!(entry.inputs && Object.keys(entry.inputs).length > 0);
        if (entry.output && hasInputs) {
            this.contextValue = 'historyItemWithOutputAndInputs';
        } else if (entry.output) {
            this.contextValue = 'historyItemWithOutput';
        } else if (hasInputs) {
            this.contextValue = 'historyItemWithInputs';
        } else {
            this.contextValue = 'historyItem';
        }

        const date = new Date(entry.timestamp);
        // Surface the full breadcrumb in the tooltip whenever it's available
        // so users can confirm "which Build did I run?" even when the label
        // shows the bare title (no collision detected). When the panel has
        // already disambiguated this entry (path collision → `(actionId)`
        // suffix), prefer the disambiguated text so the tooltip's first
        // line matches the row label exactly.
        const pathSource = displayLabel ?? (
            entry.actionPath && entry.actionPath.length > 1
                ? entry.actionPath.join(' > ')
                : undefined
        );
        const pathLine = pathSource ? `${pathSource}\n` : '';
        this.tooltip = `${pathLine}Executed at: ${date.toLocaleString()}`;

        // Last-run badge: status + when + how-long, rendered in the
        // muted TreeItem.description slot next to actionTitle. The
        // tooltip above carries the full timestamp; description is the
        // glance form. Running entries return `undefined` so the
        // spinner-equivalent iconPath above is the only signal.
        const lang: 'ko' | 'en' = vscode.env.language === 'ko' ? 'ko' : 'en';
        const badge = formatLastRunBadge(entry, Date.now(), lang);
        if (badge) {
            this.description = badge;
        }

        this.command = {
            command: 'taskhub.rerunFromHistory',
            title: 'Re-run Action',
            arguments: [this.entry]
        };
    }

    getEntry(): HistoryEntry {
        return this.entry;
    }
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | null | void> = new vscode.EventEmitter<HistoryItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<HistoryItem> | undefined;
    private historyKey = 'taskhub.actionHistory';

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    private updateTitle(): void {
        if (this.view) {
            const history = this.getHistory();
            this.view.title = `History (${history.length})`;
        }
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (!element) {
            const history = this.getHistory();
            // Refresh the view title (count) lazily — activation no longer
            // calls refresh(), so we update here on the first render.
            this.updateTitle();
            const labels = computeDisambiguatedHistoryLabels(history);
            return Promise.resolve(history.map((entry, idx) => new HistoryItem(entry, labels[idx])));
        }
        return Promise.resolve([]);
    }

    getHistory(): HistoryEntry[] {
        return this.context.workspaceState.get<HistoryEntry[]>(this.historyKey, []);
    }

    addHistoryEntry(entry: HistoryEntry): void {
        const maxItems = vscode.workspace.getConfiguration('taskhub.history').get<number>('maxItems', 10);
        const history = this.getHistory();

        history.unshift(entry);

        if (history.length > maxItems) {
            history.splice(maxItems);
        }

        this.context.workspaceState.update(this.historyKey, history);
        this.refresh();
    }

    updateHistoryStatus(
        actionId: string,
        timestamp: number,
        status: 'success' | 'failure',
        output?: string,
        durationMs?: number
    ): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (entry) {
            entry.status = status;
            if (output !== undefined) {
                entry.output = output;
            }
            if (durationMs !== undefined) {
                entry.durationMs = durationMs;
            }
            this.context.workspaceState.update(this.historyKey, history);
            this.refresh();
        }
    }

    /**
     * Attach captured task inputs to an existing entry matched by
     * `(actionId, timestamp)`. An empty `inputs` object (no interactive
     * tasks ran) clears the field rather than persisting a noise entry, so
     * the rerun-with-inputs context menu only shows up when there is
     * something to replay. Unknown `(actionId, timestamp)` is a silent
     * no-op (mirrors `updateHistoryStatus`).
     */
    setHistoryInputs(actionId: string, timestamp: number, inputs: Record<string, unknown>): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (!entry) {
            return;
        }
        if (Object.keys(inputs).length === 0) {
            delete entry.inputs;
        } else {
            entry.inputs = inputs;
        }
        this.context.workspaceState.update(this.historyKey, history);
        this.refresh();
    }

    deleteHistoryItem(entry: HistoryEntry): void {
        const history = this.getHistory();
        const index = history.findIndex(e => e.actionId === entry.actionId && e.timestamp === entry.timestamp);
        if (index !== -1) {
            history.splice(index, 1);
            this.context.workspaceState.update(this.historyKey, history);
            this.refresh();
        }
    }

    clearAllHistory(): void {
        this.context.workspaceState.update(this.historyKey, []);
        this.refresh();
    }

    trimHistoryToMax(): void {
        const maxItems = vscode.workspace.getConfiguration('taskhub.history').get<number>('maxItems', 10);
        const history = this.getHistory();
        if (history.length > maxItems) {
            history.splice(maxItems);
            this.context.workspaceState.update(this.historyKey, history);
            this.refresh();
        }
    }
}
