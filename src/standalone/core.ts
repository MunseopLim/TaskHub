import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActionsValidator, parseAndValidateActionsContent, traverseActionItems } from '../actionCatalog';
import { runDoctorPerSource } from '../doctor';
import { resolveWithinWorkspace } from '../pipelineUtils';
import { buildPreviewReport } from '../previewRun';
import type { Action, ActionItem } from '../schema';
import { t } from './language';

export class TaskHubError extends Error {
    constructor(readonly exitCode: number, message: string) { super(message); }
}

export class Workspace {
    readonly root: string;
    readonly extensionPath = path.resolve(__dirname, '..');
    constructor(directory: string) {
        try {
            this.root = fs.realpathSync(directory);
            if (!fs.statSync(this.root).isDirectory()) { throw new Error(); }
        } catch {
            throw new TaskHubError(2, t('워크스페이스 디렉터리를 열 수 없습니다.', 'Cannot open workspace directory.'));
        }
    }

    private source() {
        const filePath = path.join(this.root, '.vscode', 'actions.json');
        try {
            resolveWithinWorkspace(filePath, [this.root], this.root);
            if (!fs.statSync(filePath).isFile()) { throw new Error(); }
            return { filePath, rawText: fs.readFileSync(filePath, 'utf8'), sourceLabel: '.vscode/actions.json',
                workspaceFolder: this.root, workspaceRoots: [this.root], extensionPath: this.extensionPath };
        } catch {
            throw new TaskHubError(2, t('워크스페이스의 .vscode/actions.json 파일을 읽을 수 없습니다.',
                'Cannot read .vscode/actions.json in this workspace.'));
        }
    }

    doctor() {
        return runDoctorPerSource([this.source()], getActionsValidator());
    }

    private actions() {
        const source = this.source();
        const actions = new Map<string, ActionItem & { action: Action }>();
        try {
            const items = parseAndValidateActionsContent(source.rawText, source.filePath);
            traverseActionItems(items, item => {
                if (!item.type && item.action) { actions.set(item.id, { ...item, action: item.action }); }
            });
        } catch {
            throw new TaskHubError(2, t('actions.json 오류를 doctor로 확인하세요.', 'Invalid actions.json. Run doctor for diagnostics.'));
        }
        return actions;
    }

    list() {
        return Array.from(this.actions().values(), ({ id, title, action }) => ({ id, title, description: action.description }));
    }

    action(id: string) {
        const item = this.actions().get(id);
        if (!item) { throw new TaskHubError(2, t(`액션을 찾을 수 없습니다: ${id}`, `Action not found: ${id}`)); }
        return item;
    }

    preview(id: string) {
        return { actionId: id, report: buildPreviewReport(this.action(id), {
            workspaceFolder: this.root, workspaceRoots: [this.root], extensionPath: this.extensionPath,
        }) };
    }
}
