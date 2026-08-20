/**
 * History view TreeDataProvider and its supporting TreeItem (HistoryItem),
 * plus the `HistoryEntry` shape persisted in workspace state.
 *
 * Extracted from `extension.ts` (phase 2 module split). `extension.ts`
 * re-exports everything here so existing callers (including tests) can keep
 * `import { ... } from './extension'` unchanged.
 */

import * as vscode from 'vscode';
import { t } from '../i18n';

export type HistoryEntryType = 'action' | 'tool';
export type HistoryToolKind = 'memoryMap' | 'hexEditor' | 'jsonEditor';
export type MemoryMapHistoryInputType = 'elf' | 'listing';

export interface HistoryToolMemoryRegion {
    name: string;
    origin: number;
    size: number;
}

export interface HistoryToolMetadata {
    kind: HistoryToolKind;
    filePath: string;
    fileName: string;
    memoryMapInputType?: MemoryMapHistoryInputType;
    memoryMapConfig?: { regions?: HistoryToolMemoryRegion[] };
}

export interface ToolHistoryEntryOptions {
    kind: HistoryToolKind;
    filePath: string;
    fileName?: string;
    timestamp?: number;
    memoryMapInputType?: MemoryMapHistoryInputType;
    memoryMapConfig?: { regions?: HistoryToolMemoryRegion[] };
}

export interface HistoryRunLogReference {
    /** 실행 당시 로그를 저장한 workspace folder의 file URI. */
    workspaceFolderUri: string;
    /** 위 폴더 기준 `.taskhub/logs/.../*.log` 상대 경로. */
    relativePath: string;
}

export interface HistoryEntry {
    /**
     * Legacy entries omit this field and are treated as action entries.
     * Tool entries reuse the same History panel persistence but open a
     * viewer/editor instead of rerunning an action.
     */
    entryType?: HistoryEntryType;
    actionId: string;
    actionTitle: string;
    timestamp: number;
    /**
     * `cancelled` 는 **사용자가 중지한** 실행이다 (0.6.46).
     *
     * 예전에는 중지도 `failure` 로 적어서, 의도적으로 멈춘 것이 빨간 오류
     * 아이콘으로 쌓였다 — 진짜 실패와 눈으로 구분되지 않아 History 를 훑을 때
     * 노이즈가 된다. 0.6.46 **이전에 기록된** 중지는 `failure` 로 남아 있고
     * 마이그레이션하지 않는다: 판별 근거가 오류 메시지 문자열뿐이라 그것에
     * 기대면 문구가 바뀔 때 조용히 깨진다.
     */
    status: 'success' | 'failure' | 'running' | 'cancelled';
    /**
     * `cancelled` 안에서 **무엇이 멈췄는지**를 가른다.
     *
     *  - `stopped` — 사용자가 Stop 버튼을 눌러 실행 중인 것을 끊었다.
     *  - `prompt`  — 대화형 태스크의 프롬프트를 사용자가 닫았다(Escape/Cancel).
     *
     * 0.6.52 이전에는 둘 다 `cancelled` 하나였고 화면에는 **"중지됨 / Stopped"**
     * 로만 나왔다. 다이얼로그를 닫은 것을 "중지됨"이라고 부르는 것은 사실과
     * 다르고, 스크린 리더에는 그 한 단어가 **유일한** 설명이라 더 나쁘다.
     * 0.6.46 이 `cancelled` 를 `failure` 에서 떼어낸 것과 같은 이유로 한 번 더
     * 가른다.
     *
     * 없으면 `stopped` 로 읽는다 — 이 필드가 생기기 전의 기록은 전부 Stop
     * 이었다. 기존 기록을 마이그레이션하지 않으므로 안전한 기본값이다.
     */
    cancelKind?: 'stopped' | 'prompt';
    output?: string;
    tool?: HistoryToolMetadata;
    /**
     * Per-task captured input values from interactive tasks (inputBox /
     * quickPick / envPick / fileDialog / folderDialog / pathDialog / confirm), keyed by
     * task id. Replay-with-saved-inputs (`taskhub.rerunFromHistoryWithInputs`)
     * uses these values as preset task results so the dialogs are skipped.
     * Absent for entries written before this field existed and for actions
     * that have no interactive tasks. `password: true` inputBoxes are
     * deliberately omitted to avoid persisting secrets.
     */
    inputs?: Record<string, unknown>;
    /**
     * `inputs`가 수집될 당시의 task type. Named Input Profile이 같은 id를
     * 다른 interactive type의 값으로 오인하지 않도록 함께 저장한다.
     * 0.7.27 이전 History에는 없으며, 그 값은 프로필 저장 시 검증 불가로 본다.
     */
    inputTaskTypes?: Record<string, string>;
    /**
     * Per-task resolved command lines for `command` / `shell` tasks, keyed by
     * task id. Captured at execution time AFTER `${...}` interpolation, so the
     * stored string is exactly what ran — including the directory the user
     * picked from a dialog. Used by `taskhub.viewHistoryCommand` to show the
     * command without re-running it. Absent for entries written before this
     * field existed and for actions with no command/shell tasks.
     */
    commands?: Record<string, string>;
    /**
     * Wall-clock execution time in milliseconds. Set when the entry
     * transitions from `running` to a terminal status. Absent for entries
     * still in flight and for entries written before this field existed.
     * Used to render the "last run" badge on each `HistoryItem`.
     */
    durationMs?: number;
    /**
     * 큰 로그 본문은 workspaceState에 넣지 않고 워크스페이스 파일을 가리킨다.
     * 회전·수동 삭제 뒤에는 참조가 남을 수 있으며, 보고서 UI가 이를 정상적인
     * "더 이상 보관되지 않음" 상태로 처리한다.
     */
    runLog?: HistoryRunLogReference;
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

/** 사용자 정의 task id(`__proto__` 포함)를 own property로 보존하는 일반 객체 복사. */
function copyTaskRecord<T>(source: Record<string, T>): Record<string, T> {
    const target: Record<string, T> = {};
    for (const key of Object.keys(source)) {
        Object.defineProperty(target, key, {
            value: source[key],
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return target;
}

export function isToolHistoryEntry(entry: HistoryEntry | undefined): entry is HistoryEntry & { entryType: 'tool'; tool: HistoryToolMetadata } {
    return entry?.entryType === 'tool' && !!entry.tool;
}

function toolDisplayName(kind: HistoryToolKind): string {
    switch (kind) {
        case 'memoryMap': return 'Memory Map';
        case 'hexEditor': return 'Hex Editor';
        case 'jsonEditor': return 'JSON Editor';
    }
}

function basename(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

export function createToolHistoryEntry(options: ToolHistoryEntryOptions): HistoryEntry {
    const fileName = options.fileName || basename(options.filePath);
    const label = toolDisplayName(options.kind);
    return {
        entryType: 'tool',
        actionId: `taskhub.tool.${options.kind}:${options.memoryMapInputType ?? 'file'}:${options.filePath}`,
        actionTitle: `${label}: ${fileName}`,
        timestamp: options.timestamp ?? Date.now(),
        status: 'success',
        actionPath: [label, options.filePath],
        tool: {
            kind: options.kind,
            filePath: options.filePath,
            fileName,
            memoryMapInputType: options.memoryMapInputType,
            memoryMapConfig: options.memoryMapConfig,
        },
    };
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
 * Status (success/failure) is conveyed by the colored TreeItem icon
 * (`pass`/`error`); the badge carries only time + duration to avoid
 * doubling up the same signal in two places.
 *
 * Sample outputs (lang='ko'):
 *   - "14:30 · 1.2s"
 *   - "어제 09:15 · 45ms"
 *   - "12/15"  (older entry without a recorded duration)
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
    const timeText = formatHistoryTimestamp(entry.timestamp, now, lang);
    if (entry.durationMs !== undefined) {
        return `${timeText} · ${formatDuration(entry.durationMs)}`;
    }
    return timeText;
}

/**
 * Collapse the history into "the most recent run of each action", newest
 * first. This is the single source of truth for *recency* across TaskHub:
 * the History panel renders every run, and `taskhub.runAnyAction`'s
 * "Recently used" section is derived from the same list, so an action run
 * from the tree, a keybinding, a history re-run, or the palette itself all
 * feed one ordering.
 *
 * Relies on `HistoryProvider.addHistoryEntry` unshifting (newest first) —
 * the same invariant the History panel already renders on, so no sort here.
 *
 * Tool entries (Memory Map / Hex / JSON viewer) are skipped: they record an
 * "opened file" event, not a runnable action, and their synthetic
 * `taskhub.tool.*` ids never resolve against the action tree.
 *
 * `running` entries are kept — an action still in flight is unambiguously
 * recent, and the caller renders it as such.
 */
export function deriveRecentActionRuns(history: readonly HistoryEntry[]): HistoryEntry[] {
    const seen = new Set<string>();
    const runs: HistoryEntry[] = [];
    for (const entry of history) {
        if (!entry || !entry.actionId) { continue; }
        if (isToolHistoryEntry(entry)) { continue; }
        if (seen.has(entry.actionId)) { continue; }
        seen.add(entry.actionId);
        runs.push(entry);
    }
    return runs;
}

/**
 * The `detail` line shown under a "Recently used" row in the Run Any Action
 * palette. Unlike the History panel — where a colored icon carries
 * success/failure — the palette row has no status icon, so the failure case
 * folds the word in as text; success stays icon-free-but-unambiguous by
 * omission, matching how `formatLastRunBadge` reads in the tree.
 *
 *   success  → "14:30 · 1.2s"
 *   failure  → "실패 · 14:30 · 1.2s" / "Failed · 14:30 · 1.2s"
 *   running  → "실행 중" / "Running"
 */
export function formatRecentRunDetail(
    entry: HistoryEntry | undefined,
    now: number,
    lang: 'ko' | 'en' = 'ko'
): string | undefined {
    if (!entry) { return undefined; }
    if (entry.status === 'running') {
        return lang === 'ko' ? '실행 중' : 'Running';
    }
    const badge = formatLastRunBadge(entry, now, lang);
    if (!badge) { return undefined; }
    if (entry.status === 'failure') {
        return `${lang === 'ko' ? '실패' : 'Failed'} · ${badge}`;
    }
    if (entry.status === 'cancelled') {
        // 프롬프트를 닫은 것을 "중지됨"이라고 부르지 않는다 — `cancelKind` 주석 참조.
        const word = entry.cancelKind === 'prompt'
            ? (lang === 'ko' ? '취소됨' : 'Canceled')
            : (lang === 'ko' ? '중지됨' : 'Stopped');
        return `${word} · ${badge}`;
    }
    return badge;
}

/**
 * Build the ARIA label for a `HistoryItem`. The visible row uses
 * `iconPath` (color) for status and `description` for time + duration,
 * neither of which a screen reader can resolve into a status word — so
 * the accessibility label folds the status back in as text:
 *
 *   ko: "Build, 성공, 14:30 · 1.2s"     en: "Build, succeeded, 14:30 · 1.2s"
 *   ko: "Build, 실행 중, 14:30"          en: "Build, running, 14:30"
 *
 * Tool entries (Memory Map / Hex / JSON viewer) always carry
 * `status: 'success'` because they record an "opened" event, not a
 * pass/fail run; their aria label says "opened" rather than "succeeded"
 * so screen readers don't announce a misleading verdict.
 *
 * Pure (no vscode dependency) so unit tests can pin `now` and `lang`.
 */
export function buildHistoryItemAriaLabel(
    entry: HistoryEntry,
    displayLabel: string,
    now: number,
    lang: 'ko' | 'en' = 'ko'
): string {
    const timeText = formatHistoryTimestamp(entry.timestamp, now, lang);
    if (isToolHistoryEntry(entry)) {
        const opened = lang === 'ko' ? '열림' : 'opened';
        return `${displayLabel}, ${opened} ${timeText}`;
    }
    const statusWord = entry.status === 'success'
        ? (lang === 'ko' ? '성공' : 'succeeded')
        : entry.status === 'failure'
            ? (lang === 'ko' ? '실패' : 'failed')
            : entry.status === 'cancelled'
                ? (entry.cancelKind === 'prompt'
                    ? (lang === 'ko' ? '취소됨' : 'canceled')
                    : (lang === 'ko' ? '중지됨' : 'stopped'))
                : (lang === 'ko' ? '실행 중' : 'running');
    const durationPart = entry.durationMs !== undefined
        ? ` · ${formatDuration(entry.durationMs)}`
        : '';
    return `${displayLabel}, ${statusWord}, ${timeText}${durationPart}`;
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
    intervalMs: number,
    timers: {
        setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
        clearInterval(handle: ReturnType<typeof setInterval>): void;
    } = {
        setInterval: (callback, delayMs) => setInterval(callback, delayMs),
        clearInterval: handle => clearInterval(handle),
    }
): vscode.Disposable {
    const handle = timers.setInterval(() => target.refresh(), intervalMs);
    return { dispose: () => timers.clearInterval(handle) };
}

export class HistoryItem extends vscode.TreeItem {
    constructor(private entry: HistoryEntry, displayLabel?: string) {
        // `displayLabel` is supplied by `HistoryProvider.getChildren` when a
        // same-title collision is detected across history; otherwise it falls
        // back to the bare action title so root-level / non-colliding entries
        // stay terse.
        super(displayLabel ?? entry.actionTitle, vscode.TreeItemCollapsibleState.None);

        const isToolEntry = isToolHistoryEntry(entry);
        if (isToolEntry && entry.tool.kind === 'memoryMap') {
            this.iconPath = new vscode.ThemeIcon('graph');
        } else if (isToolEntry && entry.tool.kind === 'hexEditor') {
            this.iconPath = new vscode.ThemeIcon('file-binary');
        } else if (isToolEntry && entry.tool.kind === 'jsonEditor') {
            this.iconPath = new vscode.ThemeIcon('json');
        } else if (entry.status === 'success') {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        } else if (entry.status === 'failure') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        } else if (entry.status === 'cancelled') {
            // 사용자가 의도해서 멈춘 것이므로 오류색을 쓰지 않는다.
            this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }

        // Composable flag suffixes (`.inputs` / `.output` / `.commands`) so
        // menu `when` clauses can match each capability independently with a
        // regex (`viewItem =~ /\.commands\b/`) instead of enumerating every
        // 2^3 combination as a distinct contextValue string.
        const hasInputs = !!(entry.inputs && Object.keys(entry.inputs).length > 0);
        const hasCommands = !!(entry.commands && Object.keys(entry.commands).length > 0);
        const flags: string[] = [];
        if (hasInputs) { flags.push('inputs'); }
        if (entry.output) { flags.push('output'); }
        if (hasCommands) { flags.push('commands'); }
        const baseContext = isToolEntry ? 'historyToolItem' : 'historyItem';
        this.contextValue = flags.length > 0 ? `${baseContext}.${flags.join('.')}` : baseContext;

        const date = new Date(entry.timestamp);
        // Surface the full breadcrumb in the tooltip whenever it's available
        // so users can confirm "which Build did I run?" even when the label
        // shows the bare title (no collision detected). When the panel has
        // already disambiguated this entry (path collision → `(actionId)`
        // suffix), prefer the disambiguated text so the tooltip's first
        // line matches the row label exactly.
        const pathSource = isToolEntry
            ? (displayLabel ?? entry.tool.filePath)
            : displayLabel ?? (
                entry.actionPath && entry.actionPath.length > 1
                    ? entry.actionPath.join(' > ')
                    : undefined
            );
        const pathLine = pathSource ? `${pathSource}\n` : '';
        // 이 파일의 나머지(배지·aria 라벨)는 이미 지역화돼 있는데 tooltip 만
        // 영어로 남아 있었다. 한국어 사용자에게는 여기만 영어로 보인다.
        // `cancelled` 는 회색 `circle-slash` 아이콘 **하나로만** 표현되는데,
        // 0.6.52 부터 그 아이콘이 서로 다른 두 결말(Stop / 프롬프트 취소)을
        // 덮는다. 배지와 aria 라벨에는 단어가 들어가지만 배지는 Run Any Action
        // 팔레트 쪽이고 트리 행에는 상태 단어가 없어서, **스크린 리더 사용자는
        // 듣는 구분을 시각 사용자는 못 보는** 역전이 생겼다. 툴팁에 한 줄 더해
        // 그 역전을 없앤다 (행을 더 어지럽히지 않는 자리다).
        const cancelLine = entry.status === 'cancelled'
            ? (entry.cancelKind === 'prompt'
                ? t('취소됨 (프롬프트를 닫았습니다)\n', 'Cancelled (a prompt was dismissed)\n')
                : t('중지됨 (Stop)\n', 'Stopped (Stop button)\n'))
            : '';
        this.tooltip = `${pathLine}${cancelLine}${isToolEntry
            ? t(`연 시각: ${date.toLocaleString()}`, `Opened at: ${date.toLocaleString()}`)
            : t(`실행 시각: ${date.toLocaleString()}`, `Executed at: ${date.toLocaleString()}`)}`;

        // Last-run badge: time + how-long, rendered in the muted
        // TreeItem.description slot next to actionTitle. Status is
        // conveyed by `iconPath` above (green pass / red error), so the
        // badge text deliberately omits a ✓/✗ prefix — same signal on
        // one row twice was noisy. The tooltip carries the full
        // timestamp; description is the glance form. Running entries
        // return `undefined` so the spinner-equivalent iconPath above
        // is the only visible signal.
        //
        // accessibilityInformation.label folds the status word back in
        // as text so screen readers — which can't resolve icon color
        // into "succeeded" / "failed" — still receive parity with what
        // sighted users see.
        const lang: 'ko' | 'en' = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
        const now = Date.now();
        const badge = formatLastRunBadge(entry, now, lang);
        if (badge) {
            this.description = badge;
        }
        this.accessibilityInformation = {
            label: buildHistoryItemAriaLabel(entry, displayLabel ?? entry.actionTitle, now, lang)
        };

        // History is primarily an inspection surface. A click on an action
        // row only selects it; it must never repeat a build/deploy/file-write
        // as a side effect of trying to inspect the record. Explicit inline
        // and context commands provide fresh-input and saved-input reruns.
        // Tool entries are different: their recorded operation is opening a
        // viewer, so clicking continues to reopen that viewer.
        if (isToolEntry) {
            this.command = {
                command: 'taskhub.openToolFromHistory',
                title: t('다시 열기', 'Open again'),
                arguments: [this.entry]
            };
        }
    }

    getEntry(): HistoryEntry {
        return this.entry;
    }
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | null | void> = new vscode.EventEmitter<HistoryItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<HistoryItem> | undefined;
    private historyKey = 'taskhub.actionHistory';

    constructor(
        private context: vscode.ExtensionContext,
        private readonly options: { getMaxItems?: () => number } = {}
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    private updateTitle(): void {
        if (this.view) {
            const history = this.getHistory();
            this.view.title = t(`실행 기록 (${history.length})`, `History (${history.length})`);
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

    private getMaxItems(): number {
        return this.options.getMaxItems?.()
            ?? vscode.workspace.getConfiguration('taskhub.history').get<number>('maxItems', 10);
    }

    addHistoryEntry(entry: HistoryEntry): void {
        const maxItems = this.getMaxItems();
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
        status: 'success' | 'failure' | 'cancelled',
        output?: string,
        durationMs?: number,
        cancelKind?: 'stopped' | 'prompt'
    ): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (entry) {
            entry.status = status;
            // 재실행이 같은 항목을 갱신할 수 있으므로 `cancelled` 가 아닌
            // 상태로 바뀌면 반드시 지운다 — 남으면 성공 항목이 취소 종류를
            // 달고 다닌다.
            entry.cancelKind = status === 'cancelled' ? (cancelKind ?? 'stopped') : undefined;
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
    setHistoryInputs(
        actionId: string,
        timestamp: number,
        inputs: Record<string, unknown>,
        inputTaskTypes?: Record<string, string>
    ): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (!entry) {
            return;
        }
        if (Object.keys(inputs).length === 0) {
            delete entry.inputs;
            delete entry.inputTaskTypes;
        } else {
            entry.inputs = copyTaskRecord(inputs);
            if (inputTaskTypes && Object.keys(inputTaskTypes).length > 0) {
                entry.inputTaskTypes = copyTaskRecord(inputTaskTypes);
            } else {
                delete entry.inputTaskTypes;
            }
        }
        this.context.workspaceState.update(this.historyKey, history);
        this.refresh();
    }

    /**
     * Attach resolved command lines to an existing entry matched by
     * `(actionId, timestamp)`. Empty input (no command/shell tasks ran)
     * clears the field so the "view command" affordance only appears when
     * there is something to show. Unknown `(actionId, timestamp)` is a silent
     * no-op (mirrors `setHistoryInputs`).
     */
    setHistoryCommands(actionId: string, timestamp: number, commands: Record<string, string>): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (!entry) {
            return;
        }
        if (Object.keys(commands).length === 0) {
            delete entry.commands;
        } else {
            entry.commands = copyTaskRecord(commands);
        }
        this.context.workspaceState.update(this.historyKey, history);
        this.refresh();
    }

    /** 성공적으로 저장된 영속 로그의 작은 참조만 History 항목에 붙인다. */
    setHistoryRunLog(actionId: string, timestamp: number, runLog: HistoryRunLogReference): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (!entry) {
            return;
        }
        entry.runLog = {
            workspaceFolderUri: runLog.workspaceFolderUri,
            relativePath: runLog.relativePath,
        };
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
        const maxItems = this.getMaxItems();
        const history = this.getHistory();
        if (history.length > maxItems) {
            history.splice(maxItems);
            this.context.workspaceState.update(this.historyKey, history);
            this.refresh();
        }
    }
}
