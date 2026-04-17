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
}

export class HistoryItem extends vscode.TreeItem {
    constructor(private entry: HistoryEntry) {
        super(entry.actionTitle, vscode.TreeItemCollapsibleState.None);

        if (entry.status === 'success') {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        } else if (entry.status === 'failure') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }

        this.contextValue = entry.output ? 'historyItemWithOutput' : 'historyItem';

        const date = new Date(entry.timestamp);
        this.tooltip = `Executed at: ${date.toLocaleString()}`;

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
            return Promise.resolve(history.map(entry => new HistoryItem(entry)));
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

    updateHistoryStatus(actionId: string, timestamp: number, status: 'success' | 'failure', output?: string): void {
        const history = this.getHistory();
        const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
        if (entry) {
            entry.status = status;
            if (output !== undefined) {
                entry.output = output;
            }
            this.context.workspaceState.update(this.historyKey, history);
            this.refresh();
        }
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
