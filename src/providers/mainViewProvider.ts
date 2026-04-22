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
import { actionStates } from './actionStatus';

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

export class Action extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly action: PipelineAction,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly context: vscode.ExtensionContext,
        public readonly id?: string
    ) {
        super(label, collapsibleState);
        this.command = { command: 'taskhub.executeAction', title: 'Execute Action', arguments: [this] };
        this.tooltip = action.description;
        const state = actionStates.get(this.id || '');
        if (state) {
            switch (state.state) {
                case 'running':
                    this.iconPath = new vscode.ThemeIcon('sync~spin');
                    this.contextValue = 'runningAction';
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
            if (action && action.tasks) {
                if (action.tasks.length > 1) {
                    this.iconPath = new vscode.ThemeIcon('debug-alt');
                } else if (action.tasks.length === 1) {
                    switch (action.tasks[0].type) {
                        case 'shell':
                        case 'command':
                            this.iconPath = new vscode.ThemeIcon('terminal');
                            break;
                        case 'fileDialog':
                        case 'folderDialog':
                            this.iconPath = new vscode.ThemeIcon('folder-opened');
                            break;
                        default:
                            this.iconPath = new vscode.ThemeIcon('gear');
                            break;
                    }
                } else {
                    this.iconPath = new vscode.ThemeIcon('gear');
                }
            } else {
                this.iconPath = new vscode.ThemeIcon('gear');
            }
            this.contextValue = 'action';
        }
    }
}

export class MainViewProvider implements vscode.TreeDataProvider<Action | Folder | vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void> =
        new vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Action | Folder | vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(
        private context: vscode.ExtensionContext,
        private readonly loadActions: () => ActionItem[]
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
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
        try {
            actionsJson = this.loadActions();
        } catch (error: any) {
            vscode.window.showErrorMessage(t(
                `액션을 불러오지 못했습니다: ${error.message}`,
                `Failed to load actions: ${error.message}`
            ));
        }
        const version = this.context.extension.packageJSON.version;
        const versionItem = new vscode.TreeItem(version);
        versionItem.iconPath = new vscode.ThemeIcon('info');
        versionItem.tooltip = `Extension Version: ${version}`;
        versionItem.contextValue = 'versionItem';
        versionItem.command = { command: 'taskhub.showChangelog', title: 'Show Changelog' };
        const items: (Action | Folder | vscode.TreeItem)[] = [versionItem, ...this.createActionItems(actionsJson)];
        return Promise.resolve(items);
    }

    private createActionItems(items: ActionItem[]): (Action | Folder | vscode.TreeItem)[] {
        const actionItems: (Action | Folder | vscode.TreeItem)[] = [];
        items.forEach((item: ActionItem) => {
            if (item.type === 'folder') {
                actionItems.push(new Folder(item.title, item.children || [], this.context, item.id));
            } else if (item.type === 'separator') {
                const separatorItem = new vscode.TreeItem(item.title);
                separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                separatorItem.contextValue = 'separator';
                actionItems.push(separatorItem);
            } else if (item.action) {
                actionItems.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None, this.context, item.id));
            } else if (item.id) {
                console.warn(`Item '${item.title}' is not a valid folder, separator, or runnable action.`);
                const unknownItem = new vscode.TreeItem(item.title || 'Unknown Item');
                unknownItem.tooltip = `Invalid item definition: ${item.id}`;
                actionItems.push(unknownItem);
            }
        });
        return actionItems;
    }
}
