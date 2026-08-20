/**
 * Actions view TreeDataProvider and its supporting TreeItems (Folder, Action).
 *
 * Extracted from `extension.ts` (phase 2 module split). `extension.ts` still
 * owns the full action-loading pipeline (`loadAllActions`), so this module
 * receives it via the `loadActions` callback passed to the constructor. The
 * shared action run-state map lives in `./actionStatus` to avoid circular
 * imports.
 *
 * `extension.ts` re-exports `MainViewProvider`, `Action`, and `Folder` so
 * existing callers that do `import { ... } from './extension'` (including
 * tests) keep working without modification.
 */

import * as vscode from 'vscode';
import { ActionItem, Action as PipelineAction } from '../schema';
import { t } from '../i18n';
import { actionStates, ActionProgress, ActionRunState } from './actionStatus';

type UiLanguage = 'ko' | 'en';

/**
 * Render the in-flight progress hint shown on a running Action TreeItem.
 * Exported so unit tests can pin the format without spinning up a tree.
 *
 *   - 1 task running  → `${index}/${total} · ${taskId}` (uses the task's
 *                        actual declaration position, so parallel runs
 *                        with out-of-order completion still label the
 *                        in-flight task correctly)
 *   - 2 tasks running → `${n} running · ${a}, ${b}`
 *   - 3+ running      → `${n} running · ${a}, ${b} + ${n-2}`
 *   - 0 running       → `${completed}/${total}` (transient gap between
 *                        sequential tasks; parallel pipelines rarely hit
 *                        this since something is usually in flight)
 *
 * Returns `undefined` when the progress is too thin to be useful — the
 * caller treats `undefined` as "no description".
 */
export function formatProgressDescription(progress: ActionProgress, lang: UiLanguage = 'en'): string | undefined {
    const { total, completed, running } = progress;
    if (total <= 1) { return undefined; }
    if (running.length === 0) {
        if (completed <= 0) { return undefined; }
        return `${completed}/${total}`;
    }
    if (running.length === 1) {
        return `${running[0].index}/${total} · ${running[0].taskId}`;
    }
    if (running.length === 2) {
        return lang === 'ko'
            ? `${running.length}개 실행 중 · ${running[0].taskId}, ${running[1].taskId}`
            : `${running.length} running · ${running[0].taskId}, ${running[1].taskId}`;
    }
    return lang === 'ko'
        ? `${running.length}개 실행 중 · ${running[0].taskId}, ${running[1].taskId} + ${running.length - 2}`
        : `${running.length} running · ${running[0].taskId}, ${running[1].taskId} + ${running.length - 2}`;
}

/**
 * TreeItem 아이콘의 색·회전만으로는 스크린 리더가 실행 상태를 알 수 없다.
 * 보이는 정보와 같은 상태·진행률을 접근 가능한 이름 한 줄로 합친다.
 */
export function buildActionAccessibilityLabel(
    label: string,
    state: ActionRunState | undefined,
    progress: ActionProgress | undefined,
    lang: UiLanguage = 'en',
    showTaskStatus: boolean = true
): string {
    if (!showTaskStatus || !state) {
        return label;
    }
    const stateText = state === 'running'
        ? (lang === 'ko' ? '실행 중' : 'running')
        : state === 'success'
            ? (lang === 'ko' ? '성공' : 'succeeded')
            : (lang === 'ko' ? '실패' : 'failed');
    const progressText = state === 'running' && progress
        ? formatProgressDescription(progress, lang)
        : undefined;
    return progressText ? `${label}, ${stateText}, ${progressText}` : `${label}, ${stateText}`;
}

export class Folder extends vscode.TreeItem {
    public children: any[];
    constructor(
        public readonly label: string,
        children: any[],
        private readonly context: vscode.ExtensionContext,
        public readonly id?: string
    ) {
        const isExpanded = context.workspaceState.get<boolean>(`folderState:${id}`);
        super(label, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.children = children;
        this.id = id;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'folder';
    }
}

/**
 * The icon an action carries when no run status is being shown — derived
 * from what the action *is* (pipeline / shell / dialog / other) rather than
 * from how it last ran. Used both before the first run and whenever
 * `taskhub.showTaskStatus` is off.
 */
function defaultActionIcon(action: PipelineAction | undefined): vscode.ThemeIcon {
    if (!action || !action.tasks || action.tasks.length === 0) {
        return new vscode.ThemeIcon('gear');
    }
    if (action.tasks.length > 1) {
        return new vscode.ThemeIcon('debug-alt');
    }
    switch (action.tasks[0].type) {
        case 'shell':
        case 'command':
            return new vscode.ThemeIcon('terminal');
        case 'fileDialog':
        case 'folderDialog':
        case 'pathDialog':
            return new vscode.ThemeIcon('folder-opened');
        default:
            return new vscode.ThemeIcon('gear');
    }
}

export class Action extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly action: PipelineAction,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly context: vscode.ExtensionContext,
        public readonly id?: string,
        /**
         * Whether run status (spinner / ✓ / ✗ icons and the in-flight
         * progress hint) may be rendered — i.e. `taskhub.showTaskStatus`.
         * The provider reads the setting once per render pass and passes it
         * down; defaults to `true` so direct constructions keep the old
         * behaviour.
         *
         * Note this gates *appearance only*. `contextValue` still reflects
         * the real run state below, because it drives capabilities rather
         * than looks: with status icons off, a running action must still
         * offer its inline Stop button.
         */
        showTaskStatus: boolean = true
    ) {
        super(label, collapsibleState);
        this.command = { command: 'taskhub.executeAction', title: t('액션 실행', 'Execute Action'), arguments: [this] };
        this.tooltip = action.description;
        const state = actionStates.get(this.id || '');
        const lang: UiLanguage = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
        this.accessibilityInformation = {
            label: buildActionAccessibilityLabel(label, state?.state, state?.progress, lang, showTaskStatus)
        };
        if (state && !showTaskStatus) {
            // Status display is off: keep the capability marker, drop every
            // visual trace of the run. Previously the icons came back on any
            // refresh triggered from elsewhere (folder expand, file watcher),
            // so the setting only appeared to work until the next redraw.
            this.contextValue = state.state === 'running'
                ? 'runningAction'
                : state.state === 'success' ? 'succeededAction' : 'failedAction';
            this.iconPath = defaultActionIcon(action);
        } else if (state) {
            switch (state.state) {
                case 'running':
                    this.iconPath = new vscode.ThemeIcon('sync~spin');
                    this.contextValue = 'runningAction';
                    // "지금 어디" in-flight hint — only meaningful for
                    // multi-task actions (single-task `1/1 · X` would be
                    // pure noise). The History panel covers retrospective
                    // info ("when ran / how long"); this description slot
                    // is exclusively for live progress and is cleared by
                    // `finalizeActionRun` once the action terminates.
                    //
                    // Sequential pipelines see at most one task running at
                    // a time → renders as the legacy `2/3 · link`.
                    // Parallel pipelines may have multiple in flight →
                    // switch to `2 running · A, B` (or `+ N` when more
                    // than two are active) so the description fits in
                    // the tree row without truncating.
                    if (state.progress && state.progress.total > 1) {
                        this.description = formatProgressDescription(state.progress, lang);
                    }
                    break;
                case 'success':
                    this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.blue'));
                    this.contextValue = 'succeededAction';
                    break;
                case 'failure':
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
                    this.contextValue = 'failedAction';
                    break;
            }
        } else {
            this.iconPath = defaultActionIcon(action);
            this.contextValue = 'action';
        }
    }
}

export class MainViewProvider implements vscode.TreeDataProvider<Action | Folder | vscode.TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void> =
        new vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Action | Folder | vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    private lastLoadErrorMessage: string | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private readonly loadActions: () => ActionItem[],
        private readonly loadSourceWarnings: () => readonly string[] = () => []
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: Action | Folder | vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Action | Folder | vscode.TreeItem): Thenable<(Action | Folder | vscode.TreeItem)[]> {
        if (element) {
            if (element instanceof Folder) {
                return Promise.resolve(this.createActionItems(element.children));
            }
            return Promise.resolve([]);
        }

        let actionsJson: ActionItem[] = [];
        let loadFailed = false;
        let failedPath: string | undefined;
        try {
            actionsJson = this.loadActions();
            this.lastLoadErrorMessage = undefined;
        } catch (error: any) {
            loadFailed = true;
            failedPath = typeof error?.filePath === 'string' && error.filePath.length > 0 && error.filePath !== '<import>'
                ? error.filePath
                : undefined;
            const message = error?.message ?? String(error);
            if (message !== this.lastLoadErrorMessage) {
                this.lastLoadErrorMessage = message;
                vscode.window.showErrorMessage(t(
                    `액션을 불러오지 못했습니다: ${message}`,
                    `Failed to load actions: ${message}`
                ));
            }
        }

        // A broken actions.json must not render as "no actions yet": the
        // `viewsWelcome` CTA ("create your first action") only appears when
        // this provider yields *nothing*, and telling a user with a
        // 200-action file to create their first one is worse than useless.
        // An explicit error row keeps the tree non-empty and puts the reason
        // one click away.
        if (loadFailed) {
            const errorItem = new vscode.TreeItem(t('액션을 불러오지 못했습니다', 'Failed to load actions'));
            errorItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            errorItem.description = this.lastLoadErrorMessage;
            errorItem.tooltip = this.lastLoadErrorMessage;
            errorItem.contextValue = 'actionsLoadError';
            // Open the file that actually failed. `taskhub.editActions`
            // re-asks which workspace folder to edit, so in a multi-root
            // setup it could open a healthy file and leave the broken one
            // hidden; fall back to it only when the error carries no path
            // (e.g. a cross-source duplicate-id check).
            errorItem.command = failedPath
                ? { command: 'vscode.open', title: t('actions.json 열기', 'Open actions.json'), arguments: [vscode.Uri.file(failedPath)] }
                : { command: 'taskhub.editActions', title: t('actions.json 열기', 'Open actions.json') };
            return Promise.resolve([errorItem]);
        }

        // The extension version used to sit here as the first row. It now
        // lives in the view's `description` slot (next to the "Actions"
        // title) — a permanent row cost the list its top line and, more
        // importantly, made the tree never empty, which suppressed the
        // welcome view entirely.
        const actionItems = this.createActionItems(actionsJson);
        const sourceWarnings = this.loadSourceWarnings();
        if (sourceWarnings.length === 0) {
            return Promise.resolve(actionItems);
        }

        const warningItem = new vscode.TreeItem(sourceWarnings.length === 1
            ? t('액션 ID 충돌 1개', '1 action ID conflict')
            : t(`액션 ID 충돌 ${sourceWarnings.length}개`, `${sourceWarnings.length} action ID conflicts`));
        warningItem.description = t('우선순위 적용 결과 확인', 'Review priority resolution');
        warningItem.tooltip = sourceWarnings.join('\n\n');
        warningItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        warningItem.contextValue = 'actionSourceConflicts';
        warningItem.command = {
            command: 'taskhub.showActionSourceConflicts',
            title: t('충돌 상세 보기', 'Show conflict details')
        };
        return Promise.resolve([warningItem, ...actionItems]);
    }

    /**
     * `taskhub.showTaskStatus`, read once per render pass rather than once
     * per row. Every construction path for `Action` funnels through
     * `createActionItems`, so this is the single gate for status appearance.
     */
    private isStatusVisible(): boolean {
        return vscode.workspace.getConfiguration('taskhub').get<boolean>('showTaskStatus', true) !== false;
    }

    private createActionItems(items: ActionItem[]): (Action | Folder | vscode.TreeItem)[] {
        const actionItems: (Action | Folder | vscode.TreeItem)[] = [];
        const showTaskStatus = this.isStatusVisible();
        items.forEach((item: ActionItem) => {
            if (item.type === 'folder') {
                actionItems.push(new Folder(item.title, item.children || [], this.context, item.id));
            } else if (item.type === 'separator') {
                const separatorItem = new vscode.TreeItem(item.title);
                separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                separatorItem.contextValue = 'separator';
                actionItems.push(separatorItem);
            } else if (item.action) {
                actionItems.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None, this.context, item.id, showTaskStatus));
            } else if (item.id) {
                console.warn(`Item '${item.title}' is not a valid folder, separator, or runnable action.`);
                const unknownItem = new vscode.TreeItem(item.title || t('알 수 없는 항목', 'Unknown Item'));
                unknownItem.tooltip = t(`잘못된 항목 정의: ${item.id}`, `Invalid item definition: ${item.id}`);
                actionItems.push(unknownItem);
            }
        });
        return actionItems;
    }
}
