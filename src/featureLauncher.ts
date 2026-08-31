import * as vscode from 'vscode';
import { t } from './i18n';
import { DIALOG_SCOPE, showOpenDialogWithMemory } from './dialogMemory';

export const FEATURE_LAUNCHER_COMMAND = 'taskhub.showFeatureLauncher';
export const FEATURE_LAUNCHER_STATUS_ID = 'taskhub.featureLauncher';
export const FEATURE_LAUNCHER_RECENT_KEY = 'taskhub.featureLauncher.recent';
export const FEATURE_LAUNCHER_RECENT_LIMIT = 3;

const FEATURE_IDS = [
    'taskhubView',
    'runAnyAction',
    'openJsonEditor',
    'doctor',
    'memoryMap',
    'hexViewer',
    'hexConverter',
    'markdownPreview',
    'htmlBrowser',
    'settings',
] as const;

export type FeatureLauncherFeatureId = typeof FEATURE_IDS[number];
type FeatureLauncherGroup = 'taskhub' | 'actions' | 'embedded' | 'preview';
type FeatureLauncherFilePicker = 'markdown' | 'html';

interface FeatureLauncherDefinition {
    id: FeatureLauncherFeatureId;
    command: string;
    group: FeatureLauncherGroup;
    label: string;
    description: string;
    filePicker?: FeatureLauncherFilePicker;
}

export interface FeatureLauncherItem extends vscode.QuickPickItem {
    featureId?: FeatureLauncherFeatureId;
    command?: string;
    filePicker?: FeatureLauncherFilePicker;
}

const FEATURE_ID_SET = new Set<string>(FEATURE_IDS);

function buildFeatureLauncherDefinitions(): readonly FeatureLauncherDefinition[] {
    return [
        {
            id: 'taskhubView',
            command: 'workbench.view.extension.mainView',
            group: 'taskhub',
            label: `$(home) ${t('TaskHub 사이드바 열기', 'Open TaskHub sidebar')}`,
            description: t('Actions, Links, Favorites와 History를 엽니다.', 'Open Actions, Links, Favorites, and History.'),
        },
        {
            id: 'settings',
            command: 'taskhub.openSettings',
            group: 'taskhub',
            label: `$(gear) ${t('TaskHub 설정', 'TaskHub settings')}`,
            description: t('TaskHub 설정만 필터링해 엽니다.', 'Open Settings filtered to TaskHub.'),
        },
        {
            id: 'runAnyAction',
            command: 'taskhub.runAnyAction',
            group: 'actions',
            label: `$(play) ${t('액션 실행', 'Run an action')}`,
            description: t('저장된 액션을 검색해 실행합니다.', 'Search for and run a saved action.'),
        },
        {
            id: 'openJsonEditor',
            command: 'taskhub.openJsonEditor',
            group: 'actions',
            label: `$(edit) ${t('JSON Editor 열기', 'Open JSON Editor')}`,
            description: t('JSON 파일을 표 형태로 열고 편집합니다.', 'Open and edit a JSON file as a table.'),
        },
        {
            id: 'doctor',
            command: 'taskhub.doctor',
            group: 'actions',
            label: `$(checklist) ${t('TaskHub Doctor 실행', 'Run TaskHub Doctor')}`,
            description: t('액션 정의의 문제를 검사합니다.', 'Check action definitions for problems.'),
        },
        {
            id: 'memoryMap',
            command: 'taskhub.showMemoryMap',
            group: 'embedded',
            label: '$(symbol-structure) Memory Map',
            description: t('ELF 또는 Listing의 메모리 사용량을 분석합니다.', 'Analyze memory usage from an ELF or listing file.'),
        },
        {
            id: 'hexViewer',
            command: 'taskhub.showHexViewer',
            group: 'embedded',
            label: '$(file-binary) Hex Viewer',
            description: t('펌웨어 파일을 주소·Hex·ASCII로 엽니다.', 'Open firmware as addresses, Hex, and ASCII.'),
        },
        {
            id: 'hexConverter',
            command: 'taskhub.showHexConverter',
            group: 'embedded',
            label: t('$(replace-all) Hex/Text 변환기', '$(replace-all) Hex/Text Converter'),
            description: t('문자열과 Hex 바이트를 실시간 변환합니다.', 'Convert text and Hex bytes instantly.'),
        },
        {
            id: 'markdownPreview',
            command: 'taskhub.openMarkdownPreview',
            group: 'preview',
            label: `$(markdown) ${t('Markdown 미리 보기', 'Markdown preview')}`,
            description: t('Markdown 파일을 VS Code 미리 보기로 엽니다.', 'Open a Markdown file in VS Code Preview.'),
            filePicker: 'markdown',
        },
        {
            id: 'htmlBrowser',
            command: 'taskhub.openHtmlInBrowser',
            group: 'preview',
            label: `$(globe) ${t('HTML을 기본 브라우저에서 열기', 'Open HTML in default browser')}`,
            description: t('HTML 파일을 운영체제 기본 브라우저로 엽니다.', 'Open an HTML file in the operating system browser.'),
            filePicker: 'html',
        },
    ];
}

function groupLabel(group: FeatureLauncherGroup): string {
    switch (group) {
        case 'taskhub': return 'TaskHub';
        case 'actions': return t('액션 도구', 'Action tools');
        case 'embedded': return t('임베디드 도구', 'Embedded tools');
        case 'preview': return t('미리 보기', 'Preview');
    }
}

export function normalizeFeatureLauncherRecent(value: unknown): FeatureLauncherFeatureId[] {
    if (!Array.isArray(value)) { return []; }
    const result: FeatureLauncherFeatureId[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || !FEATURE_ID_SET.has(item)) { continue; }
        const id = item as FeatureLauncherFeatureId;
        if (!result.includes(id)) { result.push(id); }
        if (result.length >= FEATURE_LAUNCHER_RECENT_LIMIT) { break; }
    }
    return result;
}

function toQuickPickItem(definition: FeatureLauncherDefinition): FeatureLauncherItem {
    return {
        label: definition.label,
        description: definition.description,
        featureId: definition.id,
        command: definition.command,
        filePicker: definition.filePicker,
    };
}

export function buildFeatureLauncherItems(recentValue: unknown): FeatureLauncherItem[] {
    const definitions = buildFeatureLauncherDefinitions();
    const byId = new Map(definitions.map(definition => [definition.id, definition]));
    const recent = normalizeFeatureLauncherRecent(recentValue);
    const items: FeatureLauncherItem[] = [];

    if (recent.length > 0) {
        // 설정·편집기처럼 실행이 아닌 기능도 포함하므로 여기서는 "최근 사용"이다.
        // History에서 실제 실행을 모으는 Quick Action Palette의 "최근 실행"과 구분한다.
        items.push({ label: t('최근 사용', 'Recently used'), kind: vscode.QuickPickItemKind.Separator });
        for (const id of recent) {
            const definition = byId.get(id);
            if (definition) { items.push(toQuickPickItem(definition)); }
        }
    }

    const groupOrder: readonly FeatureLauncherGroup[] = ['taskhub', 'actions', 'embedded', 'preview'];
    const recentIds = new Set(recent);
    for (const group of groupOrder) {
        items.push({ label: groupLabel(group), kind: vscode.QuickPickItemKind.Separator });
        for (const definition of definitions) {
            if (definition.group === group && !recentIds.has(definition.id)) {
                items.push(toQuickPickItem(definition));
            }
        }
    }
    return items;
}

async function rememberFeature(context: vscode.ExtensionContext, id: FeatureLauncherFeatureId): Promise<void> {
    const current = normalizeFeatureLauncherRecent(context.globalState.get(FEATURE_LAUNCHER_RECENT_KEY));
    const next = [id, ...current.filter(item => item !== id)].slice(0, FEATURE_LAUNCHER_RECENT_LIMIT);
    try {
        await context.globalState.update(FEATURE_LAUNCHER_RECENT_KEY, next);
    } catch {
        // 최근 목록 저장 실패가 사용자가 고른 실제 기능 실행을 막아서는 안 된다.
    }
}

function previewOpenDialogOptions(filePicker: FeatureLauncherFilePicker): vscode.OpenDialogOptions {
    if (filePicker === 'markdown') {
        return {
            title: t('미리 볼 Markdown 파일 선택', 'Select a Markdown file to preview'),
            openLabel: t('미리 보기', 'Preview'),
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { Markdown: ['md', 'markdown'] },
        };
    }
    return {
        title: t('브라우저에서 열 HTML 파일 선택', 'Select an HTML file to open in the browser'),
        openLabel: t('브라우저에서 열기', 'Open in browser'),
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { HTML: ['html', 'htm'] },
    };
}

async function resolveFeatureArguments(item: FeatureLauncherItem): Promise<unknown[] | undefined> {
    if (!item.filePicker) { return []; }
    const scope = item.filePicker === 'markdown' ? DIALOG_SCOPE.previewMarkdown : DIALOG_SCOPE.previewHtml;
    const selectedFiles = await showOpenDialogWithMemory(scope, previewOpenDialogOptions(item.filePicker));
    if (!selectedFiles?.[0]) { return undefined; }
    return [selectedFiles[0]];
}

function featureExecutionError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) { return error.message.trim(); }
    const detail = String(error).trim();
    return detail && detail !== '[object Object]' ? detail : t('알 수 없는 오류', 'Unknown error');
}

function featureDisplayName(item: FeatureLauncherItem): string {
    return item.label.replace(/^\$\([^)]+\)\s*/, '');
}

export async function showFeatureLauncher(context: vscode.ExtensionContext): Promise<void> {
    const selected = await vscode.window.showQuickPick(
        buildFeatureLauncherItems(context.globalState.get(FEATURE_LAUNCHER_RECENT_KEY)),
        {
            placeHolder: t('실행할 TaskHub 기능을 검색하세요…', 'Search for a TaskHub feature to run…'),
            matchOnDescription: true,
            ignoreFocusOut: false,
        }
    );
    if (!selected?.featureId || !selected.command) { return; }
    try {
        const args = await resolveFeatureArguments(selected);
        if (!args) { return; }
        await rememberFeature(context, selected.featureId);
        await vscode.commands.executeCommand(selected.command, ...args);
    } catch (error) {
        const name = featureDisplayName(selected);
        const reason = featureExecutionError(error);
        await vscode.window.showErrorMessage(t(
            `TaskHub의 '${name}' 기능을 실행하지 못했습니다: ${reason}`,
            `Failed to run TaskHub feature '${name}': ${reason}`
        ));
    }
}

export function registerFeatureLauncher(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand(FEATURE_LAUNCHER_COMMAND, () => showFeatureLauncher(context));
    const status = vscode.window.createStatusBarItem(
        FEATURE_LAUNCHER_STATUS_ID,
        vscode.StatusBarAlignment.Left,
        10
    );
    status.name = t('TaskHub 기능', 'TaskHub Features');
    status.text = '$(tools) TaskHub';
    status.tooltip = t('TaskHub 기능 선택', 'Choose a TaskHub feature');
    status.command = FEATURE_LAUNCHER_COMMAND;
    status.accessibilityInformation = {
        label: t('TaskHub 기능 메뉴 열기', 'Open the TaskHub feature menu'),
    };
    status.show();
    context.subscriptions.push(command, status);
}
