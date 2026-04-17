// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Ajv from 'ajv';
import { ActionItem, Action as PipelineAction } from './schema';
import * as actionSchema from '../schema/actions.schema.json';
import { NumberBaseHoverProvider } from './numberBaseHoverProvider';
import { openJsonEditor, openJsonEditorFromUri } from './jsonEditor';
import { showMemoryMap, MemoryMapConfig, goToSymbol } from './memoryMapViewer';
import { showHexViewer, HexEditorProvider } from './hexViewer';
import { t } from './i18n';


function loadAndValidateActions(filePath: string, options?: { sourceLabel?: string }): ActionItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile<ActionItem[]>(actionSchema);
    let fileContent: string;
    try { fileContent = fs.readFileSync(filePath, 'utf-8'); } catch (e: any) { throw new Error(`Error reading file ${filePath}: ${e.message}`); }
    let parsedJson: any;
    try { parsedJson = JSON.parse(fileContent); } catch (e: any) { throw new Error(`Error parsing JSON in ${path.basename(filePath)}: ${e.message}`); }
    if (validate(parsedJson)) { const sourceLabel = options?.sourceLabel ?? filePath; performAdditionalActionValidation(parsedJson, { sourceLabel, filePath }); return parsedJson; } else { const errors = validate.errors?.map(error => `  - path: '${error.instancePath}' - message: ${error.message}`).join('\n'); throw new Error(`Validation failed for ${path.basename(filePath)}:\n${errors}`); }
}

interface ActionValidationContext {
    sourceLabel: string;
    filePath: string;
}

export function formatActionPath(parts: string[]): string {
    return parts.length > 0 ? parts.join(' > ') : '(root)';
}

function performAdditionalActionValidation(actions: ActionItem[], context: ActionValidationContext): void {
    const issues: string[] = [];
    const idLocations = new Map<string, string>();

    const traverse = (items: ActionItem[], breadcrumbs: string[]) => {
        for (const item of items) {
            const currentLabel = item.title || item.id || '(unnamed)';
            const currentPathParts = [...breadcrumbs, currentLabel];
            const currentPath = formatActionPath(currentPathParts);

            if (item.id) {
                if (idLocations.has(item.id)) {
                    const existingPath = idLocations.get(item.id)!;
                    issues.push(`Duplicate action id '${item.id}' found at '${existingPath}' and '${currentPath}' in ${context.sourceLabel}.`);
                } else {
                    idLocations.set(item.id, currentPath);
                }
            }

            if (item.action?.tasks) {
                const taskIds = new Map<string, number>();
                for (const task of item.action.tasks) {
                    if (!task?.id) {
                        continue;
                    }
                    if (taskIds.has(task.id)) {
                        issues.push(`Action '${item.id}' (${currentPath}) in ${context.sourceLabel} has duplicate task id '${task.id}'.`);
                    } else {
                        taskIds.set(task.id, 1);
                    }
                }
            }

            if (item.children && item.children.length > 0) {
                traverse(item.children, currentPathParts);
            }
        }
    };

    traverse(actions, []);

    if (issues.length > 0) {
        const uniqueIssues = Array.from(new Set(issues));
        throw new Error(`Additional validation failed for ${context.sourceLabel}:\n${uniqueIssues.map(issue => `  - ${issue}`).join('\n')}`);
    }
}

function traverseActionItems(items: ActionItem[], visitor: (item: ActionItem, pathParts: string[]) => void, breadcrumbs: string[] = []): void {
    for (const item of items) {
        const label = item.title || item.id || '(unnamed)';
        const currentParts = [...breadcrumbs, label];
        visitor(item, currentParts);
        if (item.children && item.children.length > 0) {
            traverseActionItems(item.children, visitor, currentParts);
        }
    }
}

function validateUniqueActionIdsAcrossSources(sources: { sourceLabel: string; actions: ActionItem[] }[]): void {
    const issues: string[] = [];
    const idLocations = new Map<string, { sourceLabel: string; path: string }>();

    for (const source of sources) {
        traverseActionItems(source.actions, (item, pathParts) => {
            if (!item.id) {
                return;
            }
            const currentPath = formatActionPath(pathParts);
            if (idLocations.has(item.id)) {
                const existing = idLocations.get(item.id)!;
                issues.push(`Action id '${item.id}' defined in both ${existing.sourceLabel} (${existing.path}) and ${source.sourceLabel} (${currentPath}).`);
            } else {
                idLocations.set(item.id, { sourceLabel: source.sourceLabel, path: currentPath });
            }
        });
    }

    if (issues.length > 0) {
        const uniqueIssues = Array.from(new Set(issues));
        outputChannel.appendLine(`[Warning] Duplicate action IDs across sources (higher-priority source wins):\n${uniqueIssues.map(issue => `  - ${issue}`).join('\n')}`);
    }
}

interface GroupableTaskPresentationOptions extends vscode.TaskPresentationOptions {
    group?: string;
}

interface WizardActionSources {
    workspaceActions: ActionItem[];
    bundledActions: ActionItem[];
    workspaceActionsPath: string;
    workspaceFolder: vscode.WorkspaceFolder;
}

interface TaskExecutionSetup {
    vsCodeTask: vscode.Task;
    displayCommand: string;
    actionKey: string;
    cwd: string;
}

export function createGroupedTaskPresentationOptions(actionKey: string, revealSetting?: 'always' | 'silent' | 'never'): GroupableTaskPresentationOptions {
    const revealPreference = revealSetting ?? 'always';
    let revealKind: vscode.TaskRevealKind;
    switch (revealPreference) {
        case 'silent':
            revealKind = vscode.TaskRevealKind.Silent;
            break;
        case 'never':
            revealKind = vscode.TaskRevealKind.Never;
            break;
        case 'always':
        default:
            revealKind = vscode.TaskRevealKind.Always;
            break;
    }
    return {
        reveal: revealKind,
        panel: vscode.TaskPanelKind.Shared,
        showReuseMessage: true,
        clear: false,
        group: actionKey
    };
}

// ============================================================================
// Preset Management
// ============================================================================

interface PresetInfo {
    id: string;
    name: string;
    source: 'extension' | 'workspace';
    filePath: string;
    workspaceName?: string;
}

function discoverPresets(context: vscode.ExtensionContext): PresetInfo[] {
    const presets: PresetInfo[] = [];

    // Scan extension presets
    const extPresetsDir = path.join(context.extensionPath, 'presets');
    if (fs.existsSync(extPresetsDir)) {
        const files = fs.readdirSync(extPresetsDir).filter(f => f.startsWith('preset-') && f.endsWith('.json'));
        for (const file of files) {
            const id = file.replace('preset-', '').replace('.json', '');
            presets.push({
                id,
                name: id,
                source: 'extension',
                filePath: path.join(extPresetsDir, file)
            });
        }
    }

    // Scan workspace presets
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
        const wsPresetsDir = path.join(folder.uri.fsPath, '.vscode', 'presets');
        if (fs.existsSync(wsPresetsDir)) {
            const files = fs.readdirSync(wsPresetsDir).filter(f => f.startsWith('preset-') && f.endsWith('.json'));
            for (const file of files) {
                const id = `${folder.name}:${file.replace('preset-', '').replace('.json', '')}`;
                presets.push({
                    id,
                    name: `${folder.name}: ${file.replace('preset-', '').replace('.json', '')}`,
                    source: 'workspace',
                    workspaceName: folder.name,
                    filePath: path.join(wsPresetsDir, file)
                });
            }
        }
    }

    return presets;
}

function mergeActions(
    existing: ActionItem[],
    preset: ActionItem[],
    strategy: 'keep-existing' | 'use-preset' | 'keep-both'
): ActionItem[] {
    const existingIds = new Set<string>();

    function collectIds(items: ActionItem[]) {
        for (const item of items) {
            if (item.id) {
                existingIds.add(item.id);
            }
            if (item.children) {
                collectIds(item.children);
            }
        }
    }
    collectIds(existing);

    if (strategy === 'keep-both') {
        // Filter out preset items with conflicting IDs to prevent validation failures
        const filteredPreset = filterConflictingItems(preset, existingIds);
        return [...existing, ...filteredPreset];
    }

    const filtered = preset.filter(item => !item.id || !existingIds.has(item.id));

    return strategy === 'keep-existing'
        ? [...existing, ...filtered]
        : [...filtered, ...existing];
}

/**
 * Recursively filter out items with IDs that conflict with existing IDs
 * @param items Items to filter
 * @param existingIds Set of existing IDs to check against
 * @returns Filtered items without conflicting IDs
 */
export function filterConflictingItems(items: ActionItem[], existingIds: Set<string>): ActionItem[] {
    const result: ActionItem[] = [];

    for (const item of items) {
        // Skip items with conflicting IDs
        if (item.id && existingIds.has(item.id)) {
            continue;
        }

        // Clone the item to avoid mutating the original
        const clonedItem: ActionItem = { ...item };

        // Recursively filter children if present
        if (clonedItem.children && clonedItem.children.length > 0) {
            clonedItem.children = filterConflictingItems(clonedItem.children, existingIds);
        }

        result.push(clonedItem);
    }

    return result;
}

export function findConflictingIds(actions1: ActionItem[], actions2: ActionItem[]): string[] {
    const ids1 = new Set<string>();

    function collectIds(items: ActionItem[]) {
        for (const item of items) {
            if (item.id) {
                ids1.add(item.id);
            }
            if (item.children) {
                collectIds(item.children);
            }
        }
    }
    collectIds(actions1);

    const conflicts: string[] = [];

    function checkConflicts(items: ActionItem[]) {
        for (const item of items) {
            if (item.id && ids1.has(item.id)) {
                conflicts.push(item.id);
            }
            if (item.children) {
                checkConflicts(item.children);
            }
        }
    }
    checkConflicts(actions2);

    return conflicts;
}

// ============================================================================
// Actions Loading
// ============================================================================

function getSelectedPresetId(): string | null {
    const config = vscode.workspace.getConfiguration('taskhub');
    const selected = config.get<string>('preset.selected', 'none');
    return selected === 'none' ? null : selected;
}

function loadAllActions(context: vscode.ExtensionContext): ActionItem[] {
    const extensionLabel = 'extension media/actions.json';
    const mediaJsonPath = path.join(context.extensionPath, 'media', 'actions.json');
    const extensionActions = loadAndValidateActions(mediaJsonPath, { sourceLabel: extensionLabel });

    // Load selected preset from settings
    const presetId = getSelectedPresetId();
    let presetActions: ActionItem[] = [];
    let presetLabel: string | null = null;

    if (presetId) {
        const presets = discoverPresets(context);
        const preset = presets.find(p => p.id === presetId || p.name === presetId);

        if (preset) {
            try {
                presetActions = loadAndValidateActions(preset.filePath, {
                    sourceLabel: `preset: ${preset.name}`
                });
                presetLabel = `preset: ${preset.name}`;
            } catch (error: any) {
                outputChannel.appendLine(`[Preset Warning] Failed to load preset '${presetId}': ${error.message}`);
            }
        } else {
            outputChannel.appendLine(`[Preset Warning] Preset '${presetId}' not found. Available presets: ${presets.map(p => p.id).join(', ')}`);
        }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaceSources = workspaceFolders.map(folder => {
        const workspaceJsonPath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
        const workspaceLabel = `${folder.name}:.vscode/actions.json`;
        const actions = loadAndValidateActions(workspaceJsonPath, { sourceLabel: workspaceLabel });
        return { sourceLabel: workspaceLabel, actions, workspaceFolderPath: folder.uri.fsPath };
    });

    // Merge with priority: workspace > preset > extension
    let mergedActions = extensionActions;

    // Apply preset (if any)
    if (presetActions.length > 0) {
        mergedActions = mergeActions(presetActions, mergedActions, 'keep-existing');
    }

    // Apply workspace actions (highest priority)
    for (const wsSource of workspaceSources) {
        if (wsSource.actions.length > 0) {
            mergedActions = mergeActions(wsSource.actions, mergedActions, 'keep-existing');
        }
    }

    // Build sources list for validation and workspace folder mapping
    const sources = [
        { sourceLabel: extensionLabel, actions: extensionActions, workspaceFolderPath: undefined as string | undefined },
        ...(presetActions.length > 0 && presetLabel ? [{
            sourceLabel: presetLabel,
            actions: presetActions,
            workspaceFolderPath: undefined as string | undefined
        }] : []),
        ...workspaceSources
    ].filter(source => source.actions.length > 0);

    if (sources.length > 1) {
        validateUniqueActionIdsAcrossSources(sources.map(({ sourceLabel, actions }) => ({ sourceLabel, actions })));
    }

    actionWorkspaceFolderMap.clear();

    // Map actions to workspace folders (workspace actions have priority)
    for (const source of [...workspaceSources].reverse()) {
        traverseActionItems(source.actions, (item) => {
            if (item.id) {
                actionWorkspaceFolderMap.set(item.id, source.workspaceFolderPath);
            }
        });
    }

    return mergedActions;
}

export function countActionItems(item: ActionItem): number {
    if (!item.children) { return 1; }
    let count = 0;
    for (const child of item.children) {
        count += countActionItems(child);
    }
    return count;
}

export function findActionById(actions: ActionItem[], id: string): ActionItem | undefined {
    for (const action of actions) {
        if (action.id === id) {
            return action;
        }
        if (action.children) {
            const match = findActionById(action.children, id);
            if (match) {
                return match;
            }
        }
    }
    return undefined;
}

const INTERPOLATED_VALUE_MAX_LENGTH = 32 * 1024;

export function resolveWithinWorkspace(
    targetPath: string,
    workspaceRoots: string[],
    baseDir?: string
): string {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('A file path is required.');
    }
    if (/\x00/.test(targetPath)) {
        throw new Error('File path contains a null byte, which is not allowed.');
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        throw new Error('No workspace folder is available to validate the path.');
    }
    // Relative paths must resolve against the action's workspace, NOT process.cwd().
    // Configs with "filePath": "report.txt" would otherwise land in an arbitrary
    // directory determined by how VS Code was launched.
    let resolved: string;
    if (path.isAbsolute(targetPath)) {
        resolved = path.resolve(targetPath);
    } else {
        const base = baseDir && baseDir.length > 0 ? path.resolve(baseDir) : normalizedRoots[0];
        resolved = path.resolve(base, targetPath);
    }
    const isInside = normalizedRoots.some(root => {
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!isInside) {
        throw new Error(
            `Refusing to access '${resolved}' because it is outside the current workspace folder(s).`
        );
    }
    return resolved;
}

function getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

export function sanitizeInterpolatedValue(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    let stringValue: string;
    if (typeof value === 'string') {
        stringValue = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        stringValue = String(value);
    } else {
        return undefined;
    }
    if (stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH) {
        throw new Error(
            `Interpolated value exceeds maximum length (${INTERPOLATED_VALUE_MAX_LENGTH} chars).`
        );
    }
    if (/\x00/.test(stringValue)) {
        throw new Error('Interpolated value contains a null byte, which is not allowed.');
    }
    return stringValue;
}

export function interpolatePipelineVariables(template: string, context: any): string {
    if (typeof template !== 'string') { return template; }
    const regex = /\${([^}]+)}/g;
    return template.replace(regex, (match, expression) => {
        let foundValue: any;
        const parts = expression.split('.');
        const stepId = parts[0];
        const property = parts.slice(1).join('.');
        if (context[stepId] && property && context[stepId][property] !== undefined) { foundValue = context[stepId][property]; }
        else if (context[stepId] && context[stepId].output !== undefined) { foundValue = context[stepId].output; }
        else if (context[stepId] && context[stepId].outputDir !== undefined) { foundValue = context[stepId].outputDir; }
        else if (context[expression] !== undefined) { foundValue = context[expression]; }
        const sanitized = sanitizeInterpolatedValue(foundValue);
        if (sanitized !== undefined) { return sanitized; }
        return match;
    });
}

export function getCommandString(command: any): string {
    if (typeof command === 'string') { return command; }
    if (typeof command === 'object' && command !== null) {
        const platform = process.platform;
        if (platform === 'win32' && command.windows) { return command.windows; }
        else if (platform === 'darwin' && command.macos) { return command.macos; }
        else if (platform === 'linux' && command.linux) { return command.linux; }
    }
    throw new Error(`Invalid or unsupported 'command' property for the current platform (${process.platform}). Provide a string or an object with platform-specific entries.`);
}

export function getToolCommand(tool: any): string {
    let toolCommand: string | undefined;
    if (typeof tool === 'string') {
        toolCommand = tool;
    } else if (typeof tool === 'object' && tool !== null) {
        const platform = process.platform;
        if (platform === 'win32' && tool.windows) { toolCommand = tool.windows; }
        else if (platform === 'darwin' && tool.macos) { toolCommand = tool.macos; }
        else if (platform === 'linux' && tool.linux) { toolCommand = tool.linux; }
    }

    if (!toolCommand) {
        throw new Error(`No tool path specified for the current platform (${process.platform}) in actions.json`);
    }

    // Quote the command if it contains spaces to handle paths like "C:\Program Files\..."
    if (toolCommand.includes(' ') && !toolCommand.startsWith('"')) {
        toolCommand = `"${toolCommand}"`;
    }
    return toolCommand;
}

export function tokenizeCommandLine(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: string | null = null;

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quoteChar) {
            if (char === quoteChar) {
                quoteChar = null;
            } else if (char === '\\' && quoteChar === '"' && i + 1 < command.length) {
                const next = command[i + 1];
                if (next === '"' || next === '\\') {
                    current += next;
                    i++;
                } else {
                    current += char;
                }
            } else {
                current += char;
            }
        } else if (char === '"' || char === '\'') {
            quoteChar = char;
        } else if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

export function mergeCommandAndArgs(command: string, extraArgs: string[]): { executable: string; args: string[] } {
    const baseTokens = tokenizeCommandLine(command.trim());
    if (baseTokens.length === 0) {
        throw new Error('Cannot execute an empty command.');
    }
    const executable = baseTokens[0];
    const initialArgs = baseTokens.slice(1);
    const combinedArgs = [...initialArgs, ...(extraArgs || [])];
    return { executable, args: combinedArgs };
}

export function quotePowerShellArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "''")}'`;
}

export function buildPowerShellInvocation(command: string, args: string[], enforceUtf8Console: boolean): { script: string; display: string } {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const quotedExe = quotePowerShellArgument(executable);
    const quotedArgs = combinedArgs.map(arg => quotePowerShellArgument(arg));
    const invocation = `& ${quotedExe}${quotedArgs.length ? ' ' + quotedArgs.join(' ') : ''}`;
    const prefix = enforceUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
    const script = `${prefix}${invocation}`;
    return { script, display: invocation };
}

export function encodePowerShellScript(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

function resolveExecutionSettings(customEnv?: Record<string, string>): { envOverrides: Record<string, string>; useUtf8Console: boolean } {
    const configuration = vscode.workspace.getConfiguration('taskhub');
    const pythonIoEncodingSetting = configuration.get<string>('pipeline.pythonIoEncoding', 'utf-8') || '';
    const pythonIoEncoding = pythonIoEncodingSetting.trim();

    const envOverrides: Record<string, string> = {};

    if (pythonIoEncoding.length > 0) {
        envOverrides.PYTHONIOENCODING = pythonIoEncoding;
    }

    if (customEnv) {
        for (const [key, value] of Object.entries(customEnv)) {
            if (typeof value === 'string') {
                envOverrides[key] = value;
            }
        }
    }

    let useUtf8Console = true;
    if (process.platform === 'win32') {
        const encodingPreference = configuration.get<'utf8' | 'system'>('pipeline.windowsPowerShellEncoding', 'utf8');
        useUtf8Console = encodingPreference === 'utf8';
    }

    return { envOverrides, useUtf8Console };
}

export function quotePosixArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPosixCommandLine(command: string, args: string[]): string {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const commandPart = /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : quotePosixArgument(executable);
    const parts = [commandPart, ...combinedArgs.map(arg => quotePosixArgument(arg))];
    return parts.join(' ');
}

class WizardCancelledError extends Error {
    constructor() {
        super('Action creation cancelled by user.');
    }
}

interface BaseActionInfo {
    id: string;
    title: string;
    description: string;
    successMessage?: string;
    failMessage?: string;
}

interface ActionTemplateDefinition {
    id: string;
    label: string;
    description: string;
    defaultDescription?: string;
    build(baseInfo: BaseActionInfo): Promise<PipelineAction>;
}

type DestinationPickItem = vscode.QuickPickItem & { folderRef?: ActionItem };
type RevealPickItem = vscode.QuickPickItem & { value: 'always' | 'silent' | 'never' };

const ACTION_TEMPLATES: ActionTemplateDefinition[] = [
    {
        id: 'single-shell',
        label: t('단일 쉘 명령어', 'Single Shell Command'),
        description: t('하나의 쉘 명령어를 실행하고 공유 터미널에 출력을 스트리밍합니다.', 'Run one shell command and stream its output to the shared terminal.'),
        defaultDescription: t('쉘 명령어를 실행합니다.', 'Run a shell command.'),
        async build(baseInfo) {
            const usedTaskIds = new Set<string>();
            const taskId = await promptForTaskId(usedTaskIds, 'run');
            usedTaskIds.add(taskId);
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                placeHolder: 'e.g. npm run build'
            });
            const cwd = await promptForOptionalInput({
                prompt: t('작업 디렉터리 (선택사항)', 'Working directory (optional)'),
                placeHolder: t('비워두면 워크스페이스 루트를 사용합니다', 'Leave empty to use the workspace root')
            });
            const reveal = await promptForRevealSelection('always');
            const task: any = {
                id: taskId,
                type: 'shell' as const,
                command,
                revealTerminal: reveal
            };
            if (cwd) {
                task.cwd = cwd;
            }
            const action: PipelineAction = {
                description: baseInfo.description,
                tasks: [task]
            };
            if (baseInfo.successMessage) {
                action.successMessage = baseInfo.successMessage;
            }
            if (baseInfo.failMessage) {
                action.failMessage = baseInfo.failMessage;
            }
            return action;
        }
    },
    {
        id: 'file-dialog-shell',
        label: t('파일 선택 + 쉘', 'File Picker + Shell'),
        description: t('사용자에게 파일을 선택하게 한 후, 선택된 경로를 받는 쉘 명령어를 실행합니다.', 'Ask the user to pick a file, then run a shell command that receives the selected path.'),
        defaultDescription: t('파일을 선택하고 해당 파일로 명령어를 실행합니다.', 'Pick a file and run a command with the selection.'),
        async build(baseInfo) {
            const usedTaskIds = new Set<string>();
            const dialogTaskId = await promptForTaskId(usedTaskIds, 'selectFile');
            usedTaskIds.add(dialogTaskId);
            const openLabel = await promptForOptionalInput({
                prompt: t('파일 선택 버튼 레이블 (선택사항)', 'File picker button label (optional)'),
                placeHolder: t('"파일 선택"이 기본값입니다', 'Defaults to "Select file"')
            });
            const shellTaskId = await promptForTaskId(usedTaskIds, 'run');
            usedTaskIds.add(shellTaskId);
            const defaultCommand = `echo Selected file: \${${dialogTaskId}.path}`;
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                value: defaultCommand,
                placeHolder: t(`선택한 파일을 참조하려면 \${${dialogTaskId}.path}를 사용하세요`, `Use \${${dialogTaskId}.path} to reference the selected file`)
            });
            const reveal = await promptForRevealSelection('always');
            const fileTask: any = {
                id: dialogTaskId,
                type: 'fileDialog' as const,
                options: {
                    openLabel: openLabel || t('파일 선택', 'Select file')
                }
            };
            const shellTask: any = {
                id: shellTaskId,
                type: 'shell' as const,
                command,
                revealTerminal: reveal
            };
            const action: PipelineAction = {
                description: baseInfo.description,
                tasks: [fileTask, shellTask]
            };
            if (baseInfo.successMessage) {
                action.successMessage = baseInfo.successMessage;
            }
            if (baseInfo.failMessage) {
                action.failMessage = baseInfo.failMessage;
            }
            return action;
        }
    }
];

function collectActionIds(items: ActionItem[]): Set<string> {
    const ids = new Set<string>();
    const visit = (nodes: ActionItem[]) => {
        for (const node of nodes) {
            ids.add(node.id);
            if (Array.isArray(node.children) && node.children.length > 0) {
                visit(node.children);
            }
        }
    };
    visit(items);
    return ids;
}

function collectFolderDestinations(items: ActionItem[]): DestinationPickItem[] {
    const destinations: DestinationPickItem[] = [];
    const traverse = (nodes: ActionItem[], ancestors: string[]) => {
        for (const node of nodes) {
            if (node.type === 'folder') {
                const titlePath = ancestors.length > 0 ? `${ancestors.join(' / ')} / ${node.title}` : node.title;
                destinations.push({
                    label: titlePath,
                    description: node.id,
                    folderRef: node
                });
                if (Array.isArray(node.children) && node.children.length > 0) {
                    traverse(node.children, [...ancestors, node.title]);
                }
            }
        }
    };
    traverse(items, []);
    return destinations;
}

async function promptForRequiredInput(options: { prompt: string; value?: string; placeHolder?: string }): Promise<string> {
    const result = await vscode.window.showInputBox({
        prompt: options.prompt,
        value: options.value,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true,
        validateInput: input => {
            const trimmed = input.trim();
            if (!trimmed) {
                return t('값을 입력해야 합니다.', 'Value is required.');
            }
            return undefined;
        }
    });
    if (result === undefined) {
        throw new WizardCancelledError();
    }
    return result.trim();
}

async function promptForOptionalInput(options: { prompt: string; value?: string; placeHolder?: string }): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({
        prompt: options.prompt,
        value: options.value,
        placeHolder: options.placeHolder,
        ignoreFocusOut: true
    });
    if (result === undefined) {
        throw new WizardCancelledError();
    }
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

async function promptForActionId(existingIds: Set<string>): Promise<string> {
    const idPattern = /^[A-Za-z0-9._-]+$/;
    const result = await vscode.window.showInputBox({
        prompt: t('고유한 액션 ID를 입력하세요', 'Enter a unique action id'),
        placeHolder: 'e.g. button.buildProject',
        ignoreFocusOut: true,
        validateInput: input => {
            const trimmed = input.trim();
            if (!trimmed) {
                return t('액션 ID는 필수입니다.', 'Action id is required.');
            }
            if (!idPattern.test(trimmed)) {
                return t('영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.', 'Use letters, numbers, dots, underscores, or hyphens.');
            }
            if (existingIds.has(trimmed)) {
                return t('이 ID를 가진 액션 또는 폴더가 이미 존재합니다.', 'An action or folder with this id already exists.');
            }
            return undefined;
        }
    });
    if (result === undefined) {
        throw new WizardCancelledError();
    }
    return result.trim();
}

async function promptForTaskId(usedTaskIds: Set<string>, suggestion: string): Promise<string> {
    const idPattern = /^[A-Za-z0-9._-]+$/;
    const result = await vscode.window.showInputBox({
        prompt: t('태스크 ID를 입력하세요', 'Enter a task id'),
        value: suggestion,
        placeHolder: t('이후 단계에서 태스크 출력을 참조하는 데 사용됩니다', 'Used to reference the task output in later steps'),
        ignoreFocusOut: true,
        validateInput: input => {
            const trimmed = input.trim();
            if (!trimmed) {
                return t('태스크 ID는 필수입니다.', 'Task id is required.');
            }
            if (!idPattern.test(trimmed)) {
                return t('영문, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.', 'Use letters, numbers, dots, underscores, or hyphens.');
            }
            if (usedTaskIds.has(trimmed)) {
                return t('이 태스크 ID는 이미 이 액션에서 사용 중입니다.', 'Task id already used in this action.');
            }
            return undefined;
        }
    });
    if (result === undefined) {
        throw new WizardCancelledError();
    }
    return result.trim();
}

async function promptForRevealSelection(defaultValue: 'always' | 'silent' | 'never'): Promise<'always' | 'silent' | 'never'> {
    const picks: RevealPickItem[] = [
        {
            label: defaultValue === 'always' ? t('항상 (기본값)', 'Always (default)') : t('항상', 'Always'),
            description: t('태스크 실행 시 터미널을 표시합니다.', 'Reveal the terminal when the task runs.'),
            value: 'always'
        },
        {
            label: defaultValue === 'silent' ? t('조용히 (기본값)', 'Silent (default)') : t('조용히', 'Silent'),
            description: t('터미널이 이미 보이지 않는 한 표시하지 않고 실행합니다.', 'Run without revealing unless the terminal is already visible.'),
            value: 'silent'
        },
        {
            label: defaultValue === 'never' ? t('표시 안 함 (기본값)', 'Never (default)') : t('표시 안 함', 'Never'),
            description: t('태스크 실행 중 터미널을 숨긴 상태로 유지합니다.', 'Keep the terminal hidden while the task runs.'),
            value: 'never'
        }
    ];
    const selection = await vscode.window.showQuickPick(picks, {
        placeHolder: t('태스크 터미널 동작 방식을 선택하세요.', 'Choose how the Task terminal should behave.'),
        ignoreFocusOut: true
    });
    if (!selection) {
        throw new WizardCancelledError();
    }
    return selection.value;
}

async function collectBaseActionInfo(template: ActionTemplateDefinition, existingIds: Set<string>): Promise<BaseActionInfo> {
    const id = await promptForActionId(existingIds);
    existingIds.add(id);
    const title = await promptForRequiredInput({
        prompt: t('TaskHub에 표시될 제목을 입력하세요', 'Enter the title displayed in TaskHub')
    });
    const description = await promptForRequiredInput({
        prompt: t('이 액션에 대한 짧은 설명을 입력하세요', 'Enter a short description for this action'),
        value: template.defaultDescription
    });
    const successMessage = await promptForOptionalInput({
        prompt: t('성공 메시지 (선택사항)', 'Success message (optional)'),
        placeHolder: t('모든 태스크가 성공하면 표시됩니다', 'Shown when all tasks succeed')
    });
    const failMessage = await promptForOptionalInput({
        prompt: t('실패 메시지 (선택사항)', 'Failure message (optional)'),
        placeHolder: t('태스크가 실패하면 표시됩니다', 'Shown when any task fails')
    });
    return {
        id,
        title,
        description,
        successMessage,
        failMessage
    };
}

function loadWizardActionSources(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): WizardActionSources {
    const workspaceActionsPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'actions.json');
    let workspaceActions: ActionItem[] = [];
    const workspaceLabel = `${workspaceFolder.name}:.vscode/actions.json`;
    try {
        workspaceActions = loadAndValidateActions(workspaceActionsPath, { sourceLabel: workspaceLabel });
    } catch (error: any) {
        throw new Error(`Could not load ${workspaceActionsPath}: ${error.message}`);
    }

    let bundledActions: ActionItem[] = [];
    try {
        const bundledPath = path.join(context.extensionPath, 'media', 'actions.json');
        bundledActions = loadAndValidateActions(bundledPath, { sourceLabel: 'extension media/actions.json' });
    } catch (error) {
        bundledActions = [];
    }

    try {
        validateUniqueActionIdsAcrossSources([
            { sourceLabel: 'extension media/actions.json', actions: bundledActions },
            { sourceLabel: workspaceLabel, actions: workspaceActions }
        ]);
    } catch (error: any) {
        throw error;
    }

    return { workspaceActions, bundledActions, workspaceActionsPath, workspaceFolder };
}

async function promptForActionTemplate(): Promise<ActionTemplateDefinition | undefined> {
    const templatePickItems = ACTION_TEMPLATES.map(template => ({
        label: template.label,
        description: template.description,
        templateId: template.id
    }));
    const templatePick = await vscode.window.showQuickPick(templatePickItems, {
        placeHolder: t('새 액션의 시작 템플릿을 선택하세요', 'Select a starting template for the new action'),
        ignoreFocusOut: true
    });
    if (!templatePick) {
        return undefined;
    }
    const template = ACTION_TEMPLATES.find(t => t.id === templatePick.templateId);
    if (!template) {
        vscode.window.showErrorMessage(t('선택한 템플릿을 찾을 수 없습니다.', 'Selected template was not found.'));
        return undefined;
    }
    return template;
}

async function promptForActionDestination(workspaceActions: ActionItem[]): Promise<DestinationPickItem> {
    const destinationPickItems: DestinationPickItem[] = [
        {
            label: t('$(root-folder) 루트 (최상위)', '$(root-folder) Root (top level)'),
            description: t('actions.json 최상단에 추가', 'Add at the top of actions.json')
        },
        ...collectFolderDestinations(workspaceActions)
    ];
    const destination = await vscode.window.showQuickPick(destinationPickItems, {
        placeHolder: t('새 액션을 배치할 위치를 선택하세요', 'Choose where to place the new action'),
        ignoreFocusOut: true
    });
    if (!destination) {
        throw new WizardCancelledError();
    }
    return destination;
}

export function insertActionIntoDestination(workspaceActions: ActionItem[], destination: DestinationPickItem, newAction: ActionItem): void {
    if (destination.folderRef) {
        if (!Array.isArray(destination.folderRef.children)) {
            destination.folderRef.children = [];
        }
        destination.folderRef.children.push(newAction);
    } else {
        workspaceActions.push(newAction);
    }
}

function persistWorkspaceActions(workspaceFolder: string, workspaceActionsPath: string, workspaceActions: ActionItem[]): void {
    const vscodeDir = path.join(workspaceFolder, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(workspaceActionsPath, JSON.stringify(workspaceActions, null, 2) + '\n');
}

async function handlePostCreationChoice(baseInfo: BaseActionInfo, workspaceActionsPath: string): Promise<void> {
    const openOption = t('actions.json 열기', 'Open actions.json');
    const runOption = t('바로 실행', 'Run now');
    const choice = await vscode.window.showInformationMessage(t(`'${baseInfo.title}' 액션이 actions.json에 추가되었습니다.`, `Action '${baseInfo.title}' was added to actions.json.`), openOption, runOption);
    if (choice === openOption) {
        const document = await vscode.workspace.openTextDocument(workspaceActionsPath);
        await vscode.window.showTextDocument(document, { preview: false });
    } else if (choice === runOption) {
        vscode.commands.executeCommand('taskhub.executeActionById', { id: baseInfo.id });
    }
}

async function runActionCreationWizard(context: vscode.ExtensionContext, mainViewProvider: MainViewProvider): Promise<void> {
    const targetFolder = await pickWorkspaceFolderForCommand(t('actions.json을 업데이트할 워크스페이스 폴더를 선택하세요', 'Select the workspace folder whose actions.json should be updated'));
    if (!targetFolder) {
        return;
    }

    let sources: WizardActionSources;
    try {
        sources = loadWizardActionSources(context, targetFolder);
    } catch (error: any) {
        vscode.window.showErrorMessage(error.message);
        return;
    }

    const template = await promptForActionTemplate();
    if (!template) {
        return;
    }

    const existingIds = collectActionIds([...sources.bundledActions, ...sources.workspaceActions]);

    try {
        const baseInfo = await collectBaseActionInfo(template, existingIds);
        const destination = await promptForActionDestination(sources.workspaceActions);
        const actionDefinition = await template.build(baseInfo);
        const newAction: ActionItem = {
            id: baseInfo.id,
            title: baseInfo.title,
            action: actionDefinition
        };

        insertActionIntoDestination(sources.workspaceActions, destination, newAction);
        persistWorkspaceActions(targetFolder.uri.fsPath, sources.workspaceActionsPath, sources.workspaceActions);
        mainViewProvider.refresh();
        await handlePostCreationChoice(baseInfo, sources.workspaceActionsPath);
    } catch (error) {
        if (error instanceof WizardCancelledError) {
            return;
        }
        vscode.window.showErrorMessage(t(`새 액션 생성에 실패했습니다: ${(error as Error).message}`, `Failed to create a new action: ${(error as Error).message}`));
    }
}

class MainViewProvider implements vscode.TreeDataProvider<Action | Folder | vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Action | Folder | vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  constructor(private context: vscode.ExtensionContext) {}  refresh(): void { this._onDidChangeTreeData.fire(); }  getTreeItem(element: Action | Folder | vscode.TreeItem): vscode.TreeItem { return element; }  getChildren(element?: Action | Folder | vscode.TreeItem): Thenable<(Action | Folder | vscode.TreeItem)[]> {
    if (element) { 
      if (element instanceof Folder) { return Promise.resolve(this.createActionItems(element.children)); }
      return Promise.resolve([]);
    } else { 
        let actionsJson: ActionItem[] = [];
        try {
            actionsJson = loadAllActions(this.context);
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message);
        }
        const packageJsonPath = path.join(this.context.extensionPath, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const versionItem = new vscode.TreeItem(packageJson.version);
        versionItem.iconPath = new vscode.ThemeIcon('info');
        versionItem.tooltip = `Extension Version: ${packageJson.version}`;
        versionItem.contextValue = 'versionItem';
        versionItem.command = { command: 'taskhub.showChangelog', title: 'Show Changelog' };
        const items: (Action | Folder | vscode.TreeItem)[] = [versionItem, ...this.createActionItems(actionsJson)];
        return Promise.resolve(items);
    }
  }
  private createActionItems(items: ActionItem[]): (Action | Folder | vscode.TreeItem)[] {
    const actionItems: (Action | Folder | vscode.TreeItem)[] = [];
    items.forEach((item: ActionItem) => {
      if (item.type === 'folder') { actionItems.push(new Folder(item.title, item.children || [], this.context, item.id)); } 
      else if (item.type === 'separator') { const separatorItem = new vscode.TreeItem(item.title); separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None; separatorItem.contextValue = 'separator'; actionItems.push(separatorItem); }
      else if (item.action) { actionItems.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None, this.context, item.id)); } 
      else if (item.id) { console.warn(`Item '${item.title}' is not a valid folder, separator, or runnable action.`); const unknownItem = new vscode.TreeItem(item.title || 'Unknown Item'); unknownItem.tooltip = `Invalid item definition: ${item.id}`; actionItems.push(unknownItem); }
    });
    return actionItems;
  }
}
const actionStates = new Map<string, { state: 'running' | 'success' | 'failure' }>();
const activeTasks = new Map<string, vscode.TaskExecution>();
const manuallyTerminatedActions = new Set<string>();
const outputChannel = vscode.window.createOutputChannel('TaskHub');
const actionTerminals = new Map<string, vscode.Terminal>();
const actionWorkspaceFolderMap = new Map<string, string | undefined>();
const actionChildProcesses = new Map<string, Set<ReturnType<typeof spawn>>>();
const actionStartTimestamps = new Map<string, number>();

function terminateChildProcesses(actionId: string): boolean {
    const processes = actionChildProcesses.get(actionId);
    if (!processes || processes.size === 0) {
        return false;
    }
    for (const child of processes) {
        try {
            if (!child.killed) {
                child.kill();
            }
        } catch (error) {
            console.error(`Failed to terminate child process for action '${actionId}':`, error);
        }
    }
    actionChildProcesses.delete(actionId);
    return true;
}
class Folder extends vscode.TreeItem {
  public children: any[];
  constructor(public readonly label: string, children: any[], private readonly context: vscode.ExtensionContext, public readonly id?: string) {
    const isExpanded = context.workspaceState.get<boolean>(`folderState:${id}`);
    super(label, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.children = children; this.id = id; this.iconPath = new vscode.ThemeIcon('folder'); this.contextValue = 'folder';
  }
}
class Action extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly action: import('./schema').Action, public readonly collapsibleState: vscode.TreeItemCollapsibleState, public readonly context: vscode.ExtensionContext, public readonly id?: string) {
    super(label, collapsibleState);
    this.command = { command: 'taskhub.executeAction', title: 'Execute Action', arguments: [this] };
    this.tooltip = action.description;
    const state = actionStates.get(this.id || '');
    if (state) {
      switch (state.state) {
        case 'running': this.iconPath = new vscode.ThemeIcon('sync~spin'); this.contextValue = 'runningAction'; break;
        case 'success': this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.blue')); this.contextValue = 'succeededAction'; break;
        case 'failure': this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')); this.contextValue = 'failedAction'; break;
      }
    } else {
        if (action && action.tasks) {
            if (action.tasks.length > 1) { this.iconPath = new vscode.ThemeIcon('debug-alt'); }
            else if (action.tasks.length === 1) {
                switch (action.tasks[0].type) {
                    case 'shell': case 'command': this.iconPath = new vscode.ThemeIcon('terminal'); break;
                    case 'fileDialog': case 'folderDialog': this.iconPath = new vscode.ThemeIcon('folder-opened'); break;
                    default: this.iconPath = new vscode.ThemeIcon('gear'); break;
                }
            } else { this.iconPath = new vscode.ThemeIcon('gear'); }
        } else { this.iconPath = new vscode.ThemeIcon('gear'); }
        this.contextValue = 'action';
    }
  }
}
interface LinkEntry {
    title: string;
    link: string;
    group?: string;
    tags?: string[];
    sourceFile?: string;
}

interface FavoriteEntry {
    title: string;
    path: string;
    line?: number;
    group?: string;
    tags?: string[];
    sourceFile?: string;
    workspaceFolder?: string;
}

interface HistoryEntry {
    actionId: string;
    actionTitle: string;
    timestamp: number;
    status: 'success' | 'failure' | 'running';
    output?: string;
}

export function normalizeTags(rawTags: unknown): string[] | undefined {
    if (!Array.isArray(rawTags)) {
        return undefined;
    }
    const cleaned = rawTags
        .map(tag => typeof tag === 'string' ? tag.trim() : '')
        .filter(tag => tag.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
}

export function parseTagInput(input: string | undefined): string[] | undefined {
    if (!input) {
        return undefined;
    }
    const parts = input
        .split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0);
    return parts.length > 0 ? parts : undefined;
}

/**
 * Returns a debounced handle with `run` and `cancel` methods.
 * `run` delays execution of fn until delay ms have elapsed since the last call.
 * `cancel` clears any pending timer so fn will not be invoked.
 * Useful for batching rapid file-system events and clean watcher disposal.
 */
export function debounce(fn: () => void, delay: number): { run: () => void; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        run: () => {
            if (timer !== undefined) { clearTimeout(timer); }
            timer = setTimeout(fn, delay);
        },
        cancel: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}

export function normalizeLineNumber(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const value = Math.floor(raw);
        return value > 0 ? value : undefined;
    }
    if (typeof raw === 'string') {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}

export function serializeFavorites(entries: FavoriteEntry[]): any[] {
    return entries.map(entry => {
        const payload: any = { title: entry.title, path: entry.path };
        const line = normalizeLineNumber(entry.line);
        if (line !== undefined) {
            payload.line = line;
        }
        if (entry.group) {
            payload.group = entry.group;
        }
        if (entry.tags && entry.tags.length > 0) {
            payload.tags = entry.tags;
        }
        return payload;
    });
}

export function serializeLinks(entries: LinkEntry[]): any[] {
    return entries.map(entry => {
        const payload: any = { title: entry.title, link: entry.link };
        if (entry.group) {
            payload.group = entry.group;
        }
        if (entry.tags && entry.tags.length > 0) {
            payload.tags = entry.tags;
        }
        return payload;
    });
}

export function addLinkEntry(entries: LinkEntry[], newEntry: LinkEntry): { entries: LinkEntry[]; added: boolean } {
    const trimmedTitle = newEntry.title.trim();
    const trimmedLink = newEntry.link.trim();
    const duplicate = entries.some(entry => entry.title === trimmedTitle && entry.link === trimmedLink);
    if (duplicate) {
        return { entries, added: false };
    }
    const normalized: LinkEntry = { ...newEntry, title: trimmedTitle, link: trimmedLink };
    return { entries: [...entries, normalized], added: true };
}

function loadFavoritesFromDisk(filePath: string, reportErrors: boolean, workspaceFolderPath?: string): FavoriteEntry[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.reduce<FavoriteEntry[]>((acc, item) => {
            if (item && typeof item.title === 'string' && typeof item.path === 'string') {
                const entry: FavoriteEntry = {
                    title: item.title,
                    path: item.path
                };
                const line = normalizeLineNumber(item.line);
                if (line !== undefined) {
                    entry.line = line;
                }
                const group = typeof item.group === 'string' ? item.group.trim() : '';
                if (group.length > 0) {
                    entry.group = group;
                }
                const tags = normalizeTags(item.tags);
                if (tags) {
                    entry.tags = tags;
                }
                entry.sourceFile = filePath;
                if (workspaceFolderPath) {
                    entry.workspaceFolder = workspaceFolderPath;
                }
                acc.push(entry);
            }
            return acc;
        }, []);
    } catch (error: any) {
        console.error(`Error parsing ${filePath}: ${error.message}`);
        if (reportErrors) {
            vscode.window.showErrorMessage(t(`${path.basename(filePath)} 파싱 오류: ${error.message}`, `Error parsing ${path.basename(filePath)}: ${error.message}`));
        }
        return [];
    }
}

function loadLinksFromDisk(filePath: string, reportErrors: boolean): LinkEntry[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.reduce<LinkEntry[]>((acc, item) => {
            if (item && typeof item.title === 'string' && typeof item.link === 'string') {
                const entry: LinkEntry = {
                    title: item.title,
                    link: item.link,
                    group: typeof item.group === 'string' && item.group.trim().length > 0 ? item.group.trim() : undefined,
                    tags: normalizeTags(item.tags),
                    sourceFile: filePath
                };
                acc.push(entry);
            }
            return acc;
        }, []);
    } catch (error: any) {
        console.error(`Error parsing ${filePath}: ${error.message}`);
        if (reportErrors) {
            vscode.window.showErrorMessage(t(`${path.basename(filePath)} 파싱 오류: ${error.message}`, `Error parsing ${path.basename(filePath)}: ${error.message}`));
        }
        return [];
    }
}

type LinkTreeNode = Link | LinkGroup;

class LinkGroup extends vscode.TreeItem {
    constructor(public readonly groupName: string, private readonly entries: LinkEntry[]) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${entries.length}`;
        this.contextValue = 'linkGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }

    getEntries(): LinkEntry[] {
        return this.entries;
    }
}

class Link extends vscode.TreeItem {
    constructor(private readonly entry: LinkEntry) {
        super(entry.title, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${entry.title} - ${entry.link}`;
        this.description = entry.tags && entry.tags.length > 0 ? entry.tags.join(', ') : undefined;
        this.command = { command: 'taskhub.openLink', title: 'Open Link', arguments: [entry.link] };
        this.contextValue = 'linkItem';
        this.iconPath = new vscode.ThemeIcon('link');
    }

    getLink(): string {
        return this.entry.link;
    }

    getEntry(): LinkEntry {
        return this.entry;
    }
}

class LinkViewProvider implements vscode.TreeDataProvider<LinkTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<LinkTreeNode | undefined | null | void> = new vscode.EventEmitter<LinkTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LinkTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<LinkTreeNode> | undefined;
    private cachedEntries: LinkEntry[] = [];

    constructor(private context: vscode.ExtensionContext, private readonly mode: 'builtin' | 'workspace') {
        this.cachedEntries = this.loadLinks();
    }

    refresh(): void {
        this.cachedEntries = this.loadLinks();
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    private updateTitle(): void {
        if (this.view) {
            const count = this.cachedEntries.length;
            const label = this.mode === 'builtin' ? 'Built-in Links' : 'Workspace Links';
            this.view.title = `${label} (${count})`;
        }
    }

    private loadLinks(): LinkEntry[] {
        const results: LinkEntry[] = [];
        if (this.mode === 'builtin') {
            const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'links.json');
            results.push(...loadLinksFromDisk(mediaJsonPath, false));
        } else {
            const folders = vscode.workspace.workspaceFolders ?? [];
            for (const folder of folders) {
                const workspaceLinksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
                results.push(...loadLinksFromDisk(workspaceLinksPath, true));
            }
        }
        return results;
    }

    private ensureCache(): void {
        if (this.cachedEntries.length === 0) {
            this.cachedEntries = this.loadLinks();
        }
    }

    private sortEntries(entries: LinkEntry[]): LinkEntry[] {
        return [...entries].sort((a, b) => a.title.localeCompare(b.title));
    }

    private buildRootNodes(): LinkTreeNode[] {
        this.ensureCache();
        const grouped = new Map<string, LinkEntry[]>();
        const ungrouped: LinkEntry[] = [];

        for (const entry of this.cachedEntries) {
            const groupName = entry.group;
            if (groupName) {
                const bucket = grouped.get(groupName) ?? [];
                bucket.push(entry);
                grouped.set(groupName, bucket);
            } else {
                ungrouped.push(entry);
            }
        }

        const nodes: LinkTreeNode[] = [];
        const sortedGroupNames = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroupNames) {
            const entries = this.sortEntries(grouped.get(name)!);
            nodes.push(new LinkGroup(name, entries));
        }
        const sortedUngrouped = this.sortEntries(ungrouped);
        for (const entry of sortedUngrouped) {
            nodes.push(new Link(entry));
        }
        return nodes;
    }

    getTreeItem(element: LinkTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: LinkTreeNode): Thenable<LinkTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.buildRootNodes());
        }

        if (element instanceof LinkGroup) {
            const children = element.getEntries().map(entry => new Link(entry));
            return Promise.resolve(children);
        }

        return Promise.resolve([]);
    }

    public getAllEntries(): LinkEntry[] {
        this.ensureCache();
        return [...this.cachedEntries];
    }
}

type FavoriteTreeNode = Favorite | FavoriteGroup;

class FavoriteGroup extends vscode.TreeItem {
    constructor(public readonly groupName: string, private readonly entries: FavoriteEntry[]) {
        super(groupName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${entries.length}`;
        this.contextValue = 'favoriteGroup';
        this.iconPath = new vscode.ThemeIcon('folder');
    }

    getEntries(): FavoriteEntry[] {
        return this.entries;
    }
}

class Favorite extends vscode.TreeItem {
    constructor(private readonly entry: FavoriteEntry) {
        super(entry.title, vscode.TreeItemCollapsibleState.None);
        const line = normalizeLineNumber(entry.line);
        const location = line !== undefined ? `${entry.path}:${line}` : entry.path;
        const descriptionParts: string[] = [];
        if (line !== undefined) {
            descriptionParts.push(`line ${line}`);
        }
        if (entry.tags && entry.tags.length > 0) {
            descriptionParts.push(entry.tags.join(', '));
        }
        this.tooltip = `${entry.title} - ${location}`;
        this.description = descriptionParts.length > 0 ? descriptionParts.join(' • ') : undefined;
        this.command = { command: 'taskhub.openFavoriteFile', title: 'Open Favorite File', arguments: [entry] };
        this.contextValue = 'favoriteItem';
        this.iconPath = new vscode.ThemeIcon('star');
    }

    getFilePath(): string {
        return this.entry.path;
    }

    getLine(): number | undefined {
        return this.entry.line;
    }

    getEntry(): FavoriteEntry {
        return this.entry;
    }

    getSourceFile(): string | undefined {
        return this.entry.sourceFile;
    }
}

class FavoriteViewProvider implements vscode.TreeDataProvider<FavoriteTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<FavoriteTreeNode | undefined | null | void> = new vscode.EventEmitter<FavoriteTreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<FavoriteTreeNode | undefined | null | void> = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<FavoriteTreeNode> | undefined;
    private cachedFavorites: FavoriteEntry[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.cachedFavorites = this.loadFavorites();
    }

    refresh(): void {
        this.cachedFavorites = this.loadFavorites();
        this._onDidChangeTreeData.fire();
        this.updateTitle();
    }

    private updateTitle(): void {
        if (this.view) {
            this.view.title = `Favorite Files (${this.cachedFavorites.length})`;
        }
    }

    private loadFavorites(): FavoriteEntry[] {
        const entries: FavoriteEntry[] = [];
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            const favoritesPath = path.join(folder.uri.fsPath, '.vscode', 'favorites.json');
            entries.push(...loadFavoritesFromDisk(favoritesPath, true, folder.uri.fsPath));
        }
        return entries;
    }

    private ensureCache(): void {
        if (this.cachedFavorites.length === 0) {
            this.cachedFavorites = this.loadFavorites();
        }
    }

    private sortEntries(entries: FavoriteEntry[]): FavoriteEntry[] {
        return [...entries].sort((a, b) => {
            const titleCompare = a.title.localeCompare(b.title);
            if (titleCompare !== 0) {
                return titleCompare;
            }
            const lineA = normalizeLineNumber(a.line) || 0;
            const lineB = normalizeLineNumber(b.line) || 0;
            return lineA - lineB;
        });
    }

    private buildRootNodes(): FavoriteTreeNode[] {
        this.ensureCache();
        const grouped = new Map<string, FavoriteEntry[]>();
        const ungrouped: FavoriteEntry[] = [];

        for (const entry of this.cachedFavorites) {
            const groupName = entry.group;
            if (groupName) {
                const bucket = grouped.get(groupName) ?? [];
                bucket.push(entry);
                grouped.set(groupName, bucket);
            } else {
                ungrouped.push(entry);
            }
        }

        const nodes: FavoriteTreeNode[] = [];
        const sortedGroupNames = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
        for (const name of sortedGroupNames) {
            const entries = this.sortEntries(grouped.get(name)!);
            nodes.push(new FavoriteGroup(name, entries));
        }

        const sortedUngrouped = this.sortEntries(ungrouped);
        for (const entry of sortedUngrouped) {
            nodes.push(new Favorite(entry));
        }

        return nodes;
    }

    getTreeItem(element: FavoriteTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FavoriteTreeNode): Thenable<FavoriteTreeNode[]> {
        if (!element) {
            return Promise.resolve(this.buildRootNodes());
        }

        if (element instanceof FavoriteGroup) {
            const children = element.getEntries().map(entry => new Favorite(entry));
            return Promise.resolve(children);
        }

        return Promise.resolve([]);
    }

    public getAllEntries(): FavoriteEntry[] {
        this.ensureCache();
        return [...this.cachedFavorites];
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(private entry: HistoryEntry) {
        super(entry.actionTitle, vscode.TreeItemCollapsibleState.None);

        // Set icon based on status using ThemeIcon (consistent with Action items)
        if (entry.status === 'success') {
            this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        } else if (entry.status === 'failure') {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }

        // Set contextValue based on whether output exists
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

class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
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

type LinkQuickPickItem = vscode.QuickPickItem & { entry: LinkEntry };
type FavoriteQuickPickItem = vscode.QuickPickItem & { entry: FavoriteEntry };

async function promptLinkSearch(linkViewProvider: LinkViewProvider): Promise<void> {
    const entries = linkViewProvider.getAllEntries();
    if (entries.length === 0) {
        vscode.window.showInformationMessage(t('TaskHub에 사용 가능한 링크가 없습니다.', 'No links available in TaskHub.'));
        return;
    }

    const sorted = [...entries].sort((a, b) => {
        const groupA = a.group || '';
        const groupB = b.group || '';
        if (groupA !== groupB) {
            return groupA.localeCompare(groupB);
        }
        return a.title.localeCompare(b.title);
    });

    const items: LinkQuickPickItem[] = sorted.map(entry => ({
        label: entry.title,
        description: entry.group ? `[${entry.group}] ${entry.link}` : entry.link,
        detail: entry.tags && entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : undefined,
        entry
    }));

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t('제목, 그룹 또는 태그로 링크 검색', 'Search links by title, group, or tag'),
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
    });

    if (pick) {
        vscode.commands.executeCommand('taskhub.openLink', pick.entry.link);
    }
}

async function promptWorkspaceLinkEdit(linkViewProvider: LinkViewProvider, target?: Link): Promise<void> {
    const entries = linkViewProvider.getAllEntries().filter(entry => entry.sourceFile);
    if (entries.length === 0) {
        vscode.window.showInformationMessage(t('편집할 워크스페이스 링크가 없습니다.', 'No workspace links available to edit.'));
        return;
    }

    let entryToEdit: LinkEntry | undefined;
    if (target) {
        entryToEdit = target.getEntry();
    } else {
        const items: LinkQuickPickItem[] = entries.map(entry => ({
            label: entry.title,
            description: entry.group ? `[${entry.group}] ${entry.link}` : entry.link,
            detail: entry.tags && entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : undefined,
            entry
        }));
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: t('편집할 워크스페이스 링크를 선택하세요', 'Select a workspace link to edit'),
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (!pick) {
            return;
        }
        entryToEdit = pick.entry;
    }

    if (!entryToEdit?.sourceFile) {
        vscode.window.showInformationMessage(t('이 링크는 읽기 전용이며 여기서 편집할 수 없습니다.', 'This link is read-only and cannot be edited here.'));
        return;
    }

    const titleInput = await vscode.window.showInputBox({
        prompt: t('링크 제목', 'Title for the link'),
        value: entryToEdit.title,
        ignoreFocusOut: true,
        validateInput: value => value.trim().length === 0 ? t('제목을 입력하세요', 'Enter a title') : null
    });
    if (!titleInput) {
        return;
    }

    const urlInput = await vscode.window.showInputBox({
        prompt: t('열 URL', 'URL to open'),
        value: entryToEdit.link,
        ignoreFocusOut: true,
        validateInput: value => value.trim().length === 0 ? t('URL을 입력하세요', 'Enter a URL') : null
    });
    if (!urlInput) {
        return;
    }

    const groupInput = await vscode.window.showInputBox({
        prompt: t('그룹 레이블 (선택사항)', 'Group label (optional)'),
        value: entryToEdit.group ?? '',
        ignoreFocusOut: true
    });
    if (groupInput === undefined) {
        return;
    }
    const group = groupInput.trim().length > 0 ? groupInput.trim() : undefined;

    const tagsInput = await vscode.window.showInputBox({
        prompt: t('태그 (선택사항, 쉼표로 구분)', 'Tags (optional, comma-separated)'),
        value: entryToEdit.tags?.join(', ') ?? '',
        ignoreFocusOut: true
    });
    if (tagsInput === undefined) {
        return;
    }
    const tags = parseTagInput(tagsInput);

    const trimmedTitle = titleInput.trim();
    const trimmedUrl = urlInput.trim();
    const links = loadLinksFromDisk(entryToEdit.sourceFile, true);
    const targetIndex = links.findIndex(link => link.title === entryToEdit.title && link.link === entryToEdit.link);
    if (targetIndex === -1) {
        vscode.window.showInformationMessage(t('links.json에서 선택한 링크를 찾을 수 없습니다.', 'Could not find the selected link in links.json.'));
        return;
    }

    const duplicate = links.some((link, index) => index !== targetIndex && link.title === trimmedTitle && link.link === trimmedUrl);
    if (duplicate) {
        vscode.window.showInformationMessage(t('같은 제목과 URL을 가진 다른 링크가 이미 존재합니다.', 'Another link with the same title and URL already exists.'));
        return;
    }

    const updated: LinkEntry = {
        ...links[targetIndex],
        title: trimmedTitle,
        link: trimmedUrl,
        group,
        tags,
        sourceFile: entryToEdit.sourceFile
    };
    links[targetIndex] = updated;

    const serialized = serializeLinks(links);
    fs.writeFileSync(entryToEdit.sourceFile, JSON.stringify(serialized, null, 2) + '\n');
    linkViewProvider.refresh();
}

async function promptFavoriteSearch(favoriteViewProvider: FavoriteViewProvider): Promise<void> {
    const entries = favoriteViewProvider.getAllEntries();
    if (entries.length === 0) {
        vscode.window.showInformationMessage(t('TaskHub에 저장된 즐겨찾기가 없습니다.', 'No favorites stored in TaskHub.'));
        return;
    }

    const sorted = [...entries].sort((a, b) => {
        const groupA = a.group || '';
        const groupB = b.group || '';
        if (groupA !== groupB) {
            return groupA.localeCompare(groupB);
        }
        const titleCompare = a.title.localeCompare(b.title);
        if (titleCompare !== 0) {
            return titleCompare;
        }
        const lineA = normalizeLineNumber(a.line) || 0;
        const lineB = normalizeLineNumber(b.line) || 0;
        return lineA - lineB;
    });

    const items: FavoriteQuickPickItem[] = sorted.map(entry => {
        const line = normalizeLineNumber(entry.line);
        const location = line !== undefined ? `${entry.path}:${line}` : entry.path;
        return {
            label: entry.title,
            description: entry.group ? `[${entry.group}] ${location}` : location,
            detail: entry.tags && entry.tags.length > 0 ? `Tags: ${entry.tags.join(', ')}` : undefined,
            entry
        };
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t('제목, 그룹, 줄 번호 또는 태그로 즐겨찾기 검색', 'Search favorites by title, group, line, or tag'),
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
    });

    if (pick) {
        vscode.commands.executeCommand('taskhub.openFavoriteFile', pick.entry);
    }
}

async function promptFavoriteLineNumber(promptLabel: string, initialLine?: number): Promise<number | undefined | 'cancel'> {
    const input = await vscode.window.showInputBox({
        prompt: promptLabel,
        placeHolder: t('비워두면 파일 맨 위에서 엽니다', 'Leave empty to open at the top of the file'),
        value: initialLine !== undefined ? `${initialLine}` : undefined,
        ignoreFocusOut: true,
        validateInput: text => {
            if (text.trim().length === 0) {
                return null;
            }
            return normalizeLineNumber(text) ? null : t('양수 줄 번호를 입력하세요', 'Enter a positive line number');
        }
    });

    if (input === undefined) {
        return 'cancel';
    }

    return normalizeLineNumber(input);
}

function resolveActionDefinition(actionItem: ActionItem): { action: PipelineAction; id: string } | undefined {
    const action = actionItem.action;
    if (!action || !action.tasks) {
        vscode.window.showErrorMessage(t(`'${actionItem.title}' 액션에 실행할 태스크가 없습니다.`, `Action '${actionItem.title}' has no tasks to run.`));
        return undefined;
    }
    return { action, id: actionItem.id };
}

function markActionAsRunning(actionItem: ActionItem, id: string, showTaskStatus: boolean, mainViewProvider: MainViewProvider): boolean {
    if (!showTaskStatus) {
        return true;
    }

    const currentState = actionStates.get(id);
    if (currentState?.state === 'running') {
        vscode.window.showInformationMessage(t(`'${actionItem.title}' 액션이 이미 실행 중입니다.`, `Action '${actionItem.title}' is already running.`));
        return false;
    }

    actionStates.set(id, { state: 'running' });
    mainViewProvider.refresh();
    return true;
}

function logActionStart(showVerboseLogs: boolean, title: string, description?: string): void {
    if (!showVerboseLogs) {
        return;
    }
    outputChannel.show(true);
    if (description) {
        outputChannel.appendLine(`[INFO] Running action '${title}': ${description}`);
    } else {
        outputChannel.appendLine(`[INFO] Running action '${title}'.`);
    }
}

async function runActionTasks(action: PipelineAction, context: vscode.ExtensionContext, id: string, workspaceFolderPath?: string): Promise<void> {
    const stepResults: Record<string, unknown> = {};
    for (const task of action.tasks) {
        const result = await executeSingleTask(task, stepResults, context, id, workspaceFolderPath);
        stepResults[task.id] = result;
    }
}

function handleActionSuccess(id: string, action: PipelineAction, showTaskStatus: boolean): void {
    if (!showTaskStatus) {
        return;
    }
    actionStates.set(id, { state: 'success' });
    if (action.successMessage) {
        vscode.window.showInformationMessage(action.successMessage);
    }
}

function handleActionFailure(id: string, actionItem: ActionItem, action: PipelineAction, error: Error, showTaskStatus: boolean): void {
    if (!showTaskStatus) {
        return;
    }
    actionStates.set(id, { state: 'failure' });
    if (action.failMessage) {
        vscode.window.showErrorMessage(`${action.failMessage}: ${error.message}`);
    } else {
        vscode.window.showErrorMessage(t(`'${actionItem.title}' 액션 실패: ${error.message}`, `Action '${actionItem.title}' failed: ${error.message}`));
    }
}

function finalizeActionRun(id: string, showTaskStatus: boolean, mainViewProvider: MainViewProvider): void {
    activeTasks.delete(id);
    if (manuallyTerminatedActions.has(id)) {
        actionStates.delete(id);
        manuallyTerminatedActions.delete(id);
    }
    if (showTaskStatus) {
        mainViewProvider.refresh();
    }
}

async function executeAction(actionItem: ActionItem, context: vscode.ExtensionContext, mainViewProvider: MainViewProvider, historyProvider?: HistoryProvider) {
    const resolved = resolveActionDefinition(actionItem);
    if (!resolved) {
        return;
    }

    const { action, id } = resolved;
    const actionWorkspaceFolder = id ? actionWorkspaceFolderMap.get(id) : undefined;
    const showTaskStatus = vscode.workspace.getConfiguration('taskhub').get('showTaskStatus', true);

    if (!markActionAsRunning(actionItem, id, showTaskStatus, mainViewProvider)) {
        return;
    }

    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
    logActionStart(showVerboseLogs, actionItem.title, action.description);

    // Add history entry
    const timestamp = Date.now();
    actionStartTimestamps.set(id, timestamp);
    if (historyProvider) {
        historyProvider.addHistoryEntry({
            actionId: id,
            actionTitle: actionItem.title,
            timestamp: timestamp,
            status: 'running'
        });
    }

    try {
        await runActionTasks(action, context, id, actionWorkspaceFolder);
        handleActionSuccess(id, action, showTaskStatus);

        // Update history to success
        if (historyProvider) {
            historyProvider.updateHistoryStatus(id, timestamp, 'success');
        }
    } catch (error: any) {
        if (!manuallyTerminatedActions.has(id)) {
            handleActionFailure(id, actionItem, action, error, showTaskStatus);

            // Update history to failure
            if (historyProvider) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                historyProvider.updateHistoryStatus(id, timestamp, 'failure', errorMessage);
            }

            throw error;
        } else {
            // Action was manually stopped
            if (historyProvider) {
                historyProvider.updateHistoryStatus(id, timestamp, 'failure', 'Action stopped by user');
            }
        }
    } finally {
        finalizeActionRun(id, showTaskStatus, mainViewProvider);
        actionStartTimestamps.delete(id);
    }
}

async function executeSingleTask(task: import('./schema').Task, allResults: any, context: vscode.ExtensionContext, actionId: string, workspaceFolderPath?: string): Promise<any> {
    const defaultWorkspace = workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const interpolationContext = { ...allResults, workspaceFolder: defaultWorkspace, extensionPath: context.extensionPath };
    let result: any;

    switch (task.type) {
        case 'fileDialog':
            result = await handleFileDialog(task);
            break;
        case 'folderDialog':
            result = await handleFolderDialog(task);
            break;
        case 'inputBox':
            // Interpolate prompt, value, placeHolder, prefix, suffix
            const interpolatedTask = {
                ...task,
                prompt: task.prompt ? interpolatePipelineVariables(task.prompt, interpolationContext) : undefined,
                value: task.value ? interpolatePipelineVariables(task.value, interpolationContext) : undefined,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined,
                prefix: task.prefix ? interpolatePipelineVariables(task.prefix, interpolationContext) : undefined,
                suffix: task.suffix ? interpolatePipelineVariables(task.suffix, interpolationContext) : undefined
            };
            result = await handleInputBox(interpolatedTask);
            break;
        case 'quickPick':
            // Interpolate items if they're strings or contain interpolatable properties
            const interpolatedItems = task.items?.map((item: any) => {
                if (typeof item === 'string') {
                    return interpolatePipelineVariables(item, interpolationContext);
                } else {
                    return {
                        label: item.label ? interpolatePipelineVariables(item.label, interpolationContext) : item.label,
                        description: item.description ? interpolatePipelineVariables(item.description, interpolationContext) : item.description,
                        detail: item.detail ? interpolatePipelineVariables(item.detail, interpolationContext) : item.detail
                    };
                }
            });
            const interpolatedQuickPickTask = {
                ...task,
                items: interpolatedItems,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined
            };
            result = await handleQuickPick(interpolatedQuickPickTask);
            break;
        case 'unzip':
            const interpolatedUnzipTask: any = { ...task };
            if (task.tool) {
                interpolatedUnzipTask.tool = JSON.parse(interpolatePipelineVariables(JSON.stringify(task.tool), interpolationContext));
            }
            if (typeof task.archive === 'string') {
                interpolatedUnzipTask.archive = interpolatePipelineVariables(task.archive, interpolationContext);
            }
            if (typeof task.destination === 'string') {
                interpolatedUnzipTask.destination = interpolatePipelineVariables(task.destination, interpolationContext);
            }
            if (task.env && typeof task.env === 'object') {
                const interpolatedEnv: Record<string, string> = {};
                for (const [key, value] of Object.entries(task.env)) {
                    if (typeof value === 'string') {
                        interpolatedEnv[key] = interpolatePipelineVariables(value, interpolationContext);
                    }
                }
                interpolatedUnzipTask.env = interpolatedEnv;
            }
            result = await handleUnzip(interpolatedUnzipTask, allResults, defaultWorkspace, actionId);
            break;
        case 'zip':
            result = await handleZip(task, allResults, defaultWorkspace, actionId);
            break;
        case 'stringManipulation':
            const interpolatedInput = interpolatePipelineVariables(task.input || '', interpolationContext);
            result = await handleStringManipulation({ ...task, input: interpolatedInput });
            break;
        case 'confirm':
            const interpolatedMessage = task.message ? interpolatePipelineVariables(task.message, interpolationContext) : undefined;
            result = await handleConfirm({ ...task, message: interpolatedMessage });
            break;
        case 'command':
        case 'shell':
            let command: string | undefined;
            if (typeof task.command === 'string') {
                command = interpolatePipelineVariables(task.command, interpolationContext);
            } else if (typeof task.command === 'object') {
                const interpolatedCmdObj = JSON.parse(JSON.stringify(task.command));
                for (const os in interpolatedCmdObj) {
                    if (Object.prototype.hasOwnProperty.call(interpolatedCmdObj, os)) {
                        interpolatedCmdObj[os] = interpolatePipelineVariables(interpolatedCmdObj[os], interpolationContext);
                    }
                }
                command = getCommandString(interpolatedCmdObj);
            }

            const args = task.args ? task.args.map(arg => interpolatePipelineVariables(arg, interpolationContext)) : [];
            const cwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined;
            let env: Record<string, string> | undefined;
            if (task.env && typeof task.env === 'object') {
                env = {};
                for (const [key, value] of Object.entries(task.env)) {
                    if (typeof value === 'string') {
                        env[key] = interpolatePipelineVariables(value, interpolationContext);
                    }
                }
            }

            if (!command) { throw new Error(`Task ${task.id} of type '${task.type}' requires a 'command' property.`); }            
            const handlerTask = { ...task, command, args, cwd, env, actionId };

            if (task.passTheResultToNextTask) {
                result = await handleCommand(handlerTask, context, defaultWorkspace);
            } else {
                if (task.isOneShot) {
                    executeStreamedTask(handlerTask, defaultWorkspace).catch(error => {
                        console.error(`One-shot task ${task.id} failed:`, error);
                        vscode.window.showErrorMessage(t(`원샷 태스크 '${task.id}' 시작 실패: ${error.message}`, `One-shot task '${task.id}' failed to start: ${error.message}`));
                    });
                } else {
                    await executeStreamedTask(handlerTask, defaultWorkspace);
                }
                result = {};
            }
            break;
        default:
            throw new Error(`Unsupported task type: ${task.type}`);
    }

    if (task.passTheResultToNextTask && task.output) {
        const outputContent = task.output.content ? interpolatePipelineVariables(task.output.content, interpolationContext) : (typeof result?.output === 'string' ? result.output : JSON.stringify(result, null, 2));

        let overwriteValue: boolean | undefined;
        if (typeof task.output.overwrite === 'boolean') {
            overwriteValue = task.output.overwrite;
        } else if (typeof task.output.overwrite === 'string') {
            const interpolated = interpolatePipelineVariables(task.output.overwrite, interpolationContext);
            overwriteValue = interpolated.trim().toLowerCase() === 'true';
        }

        const interpolatedOutput = {
            ...task.output,
            filePath: task.output.filePath ? interpolatePipelineVariables(task.output.filePath, interpolationContext) : undefined,
            content: outputContent,
            overwrite: overwriteValue
        };

        switch (interpolatedOutput.mode) {
            case 'editor':
                const doc = await vscode.workspace.openTextDocument({ content: interpolatedOutput.content, language: interpolatedOutput.language || 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: false });
                break;
            case 'file':
                if (!interpolatedOutput.filePath) { throw new Error(`Task '${task.id}' has output mode 'file' but 'filePath' is not defined.`); }
                const safeOutputPath = resolveWithinWorkspace(
                    interpolatedOutput.filePath,
                    getWorkspaceRoots(),
                    defaultWorkspace
                );
                const dir = path.dirname(safeOutputPath);
                if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                if (interpolatedOutput.overwrite !== true && fs.existsSync(safeOutputPath)) {
                    throw new Error(`Task '${task.id}' attempted to write to '${safeOutputPath}', but the file already exists. Set 'overwrite': true to replace it.`);
                }
                fs.writeFileSync(safeOutputPath, interpolatedOutput.content);
                break;
            case 'terminal':
                {
                    const terminalKey = actionId || 'default';
                    let terminal = actionTerminals.get(terminalKey);
                    if (!terminal || terminal.exitStatus) {
                        terminal = vscode.window.createTerminal(`TaskHub: ${terminalKey}`);
                        actionTerminals.set(terminalKey, terminal);
                    }
                    terminal.show();
                    const header = `\n# ----- Output for task: ${task.id} ----- #\n`;
                    terminal.sendText(header, false);
                    terminal.sendText(interpolatedOutput.content, false);
                }
                break;
        }
    }
    return result;
}

export function createShellExecution(command: string, args: string[], options: vscode.ShellExecutionOptions, useUtf8Console: boolean): { shellExecution: vscode.ShellExecution; displayCommand: string } {
    if (process.platform === 'win32') {
        const invocation = buildPowerShellInvocation(command, args, useUtf8Console);
        const encoded = encodePowerShellScript(invocation.script);
        return {
            shellExecution: new vscode.ShellExecution('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], options),
            displayCommand: invocation.display
        };
    }

    const commandLine = buildPosixCommandLine(command, args);
    return {
        shellExecution: new vscode.ShellExecution(commandLine, options),
        displayCommand: commandLine
    };
}

export function wrapCommandForOneShot(command: string, args: string[], cwd: string | undefined, useUtf8Console: boolean): { commandLine: string; displayCommand: string; isPowerShellScript: boolean } {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    if (process.platform === 'win32') {
        const filePath = quotePowerShellArgument(executable);
        const argList = combinedArgs.map(arg => quotePowerShellArgument(arg));
        const argumentListPart = argList.length > 0 ? ` -ArgumentList @(${argList.join(', ')})` : '';
        const workingDirectoryPart = cwd ? ` -WorkingDirectory ${quotePowerShellArgument(cwd)}` : '';
        const utf8Prefix = useUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
        const script = `${utf8Prefix}Start-Process -FilePath ${filePath}${argumentListPart}${workingDirectoryPart}`;
        return { commandLine: script, displayCommand: script, isPowerShellScript: true };
    }

    const baseCommandLine = buildPosixCommandLine(command, args);
    const wrapped = `nohup ${baseCommandLine} >/dev/null 2>&1 &`;
    return { commandLine: wrapped, displayCommand: wrapped, isPowerShellScript: false };
}

function prepareTaskExecution(task: any, workspaceFolderPath?: string): TaskExecutionSetup {
    const { command, args, cwd, id, actionId, revealTerminal, env: taskEnv, isOneShot } = task;
    if (typeof command !== 'string') {
        throw new Error(`Task ${id} requires a string 'command' property.`);
    }

    const actionKey = actionId || id;
    const options: vscode.ShellExecutionOptions = {
        cwd: cwd || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    };
    const { envOverrides, useUtf8Console } = resolveExecutionSettings(taskEnv);
    if (Object.keys(envOverrides).length > 0) {
        options.env = envOverrides;
    }

    const taskArgs = args || [];

    let shellExecution: vscode.ShellExecution;
    let displayCommand: string;

    if (isOneShot) {
        const wrapped = wrapCommandForOneShot(command, taskArgs, options.cwd, useUtf8Console);
        if (wrapped.isPowerShellScript) {
            const encoded = encodePowerShellScript(wrapped.commandLine);
            shellExecution = new vscode.ShellExecution('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], options);
        } else {
            shellExecution = new vscode.ShellExecution(wrapped.commandLine, options);
        }
        displayCommand = wrapped.displayCommand;
    } else {
        const execCommand = command;
        const execArgs = taskArgs;
        const result = createShellExecution(execCommand, execArgs, options, useUtf8Console);
        shellExecution = result.shellExecution;
        displayCommand = result.displayCommand;
    }

    const taskDefinition: vscode.TaskDefinition = { type: 'shell', actionId: actionKey };
    const taskName = `TaskHub: ${actionKey}`;
    const vsCodeTask = new vscode.Task(taskDefinition, vscode.TaskScope.Workspace, taskName, 'taskhub', shellExecution);
    vsCodeTask.presentationOptions = createGroupedTaskPresentationOptions(actionKey, revealTerminal);

    return {
        vsCodeTask,
        displayCommand,
        actionKey,
        cwd: options.cwd || ''
    };
}

async function executeStreamedTask(task: any, workspaceFolderPath?: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        let setup: TaskExecutionSetup;
        try {
            setup = prepareTaskExecution(task, workspaceFolderPath);
        } catch (error) {
            reject(error);
            return;
        }

        const { vsCodeTask, displayCommand, actionKey, cwd } = setup;
        let taskExecution: vscode.TaskExecution | undefined;
        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
            if (taskExecution && e.execution === taskExecution) {
                disposable.dispose();
                if (e.exitCode === 0) {
                    resolve();
                } else {
                    reject(new Error(`Task ${task.id} failed with exit code ${e.exitCode}.`));
                }
            }
        });

        try {
            const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
            if (showVerboseLogs) {
                outputChannel.appendLine(`[INFO] Executing task via vscode.tasks: ${displayCommand} in ${cwd}`);
            }
            taskExecution = await vscode.tasks.executeTask(vsCodeTask);
            if (task.actionId && taskExecution) {
                activeTasks.set(task.actionId, taskExecution);
            }
        } catch (error) {
            disposable.dispose();
            reject(error);
        }
    });
}

async function handleCommand(task: any, context: vscode.ExtensionContext, workspaceFolderPath?: string): Promise<{ output: string }> {
    const { args, cwd } = task;
    const command = getCommandString(task.command);
    const commandOutput = await executeShellCommand(command, args || [], cwd, task.env, workspaceFolderPath, task.actionId);
    return { output: commandOutput.trim() };
}

export function parsePathInfo(fullPath: string): { path: string, dir: string, name: string, fileNameOnly: string, fileExt: string } {
    const baseName = path.basename(fullPath);
    const extension = path.extname(baseName);
    return { path: fullPath, dir: path.dirname(fullPath), name: baseName, fileNameOnly: path.basename(baseName, extension), fileExt: extension.startsWith('.') ? extension.substring(1) : extension };
}

async function handleFileDialog(task: any): Promise<{ path: string, dir: string, name: string, fileNameOnly: string, fileExt: string }> {
    const options: vscode.OpenDialogOptions = task.options || {};
    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) { return parsePathInfo(fileUri[0].fsPath); }
    else { throw new Error('File selection was canceled.'); }
}

async function handleFolderDialog(task: any): Promise<{ path: string, dir: string, name: string, fileNameOnly: string, fileExt: string }> {
    const options: vscode.OpenDialogOptions = task.options || {};
    options.canSelectFiles = false; options.canSelectFolders = true;
    const folderUri = await vscode.window.showOpenDialog(options);
    if (folderUri && folderUri[0]) { return parsePathInfo(folderUri[0].fsPath); }
    else { throw new Error('Folder selection was canceled.'); }
}

async function handleInputBox(task: any): Promise<{ value: string }> {
    const options: vscode.InputBoxOptions = {
        prompt: task.prompt,
        value: task.value,
        placeHolder: task.placeHolder,
        password: task.password || false
    };
    const userInput = await vscode.window.showInputBox(options);
    if (userInput !== undefined) {
        const prefix = task.prefix || '';
        const suffix = task.suffix || '';
        const finalValue = prefix + userInput + suffix;
        return { value: finalValue };
    } else {
        throw new Error('Input was canceled.');
    }
}

async function handleQuickPick(task: any): Promise<{ value: string; values?: string }> {
    if (!task.items || !Array.isArray(task.items) || task.items.length === 0) {
        throw new Error(`Task '${task.id}' of type 'quickPick' requires a non-empty 'items' array.`);
    }

    const options: vscode.QuickPickOptions = {
        placeHolder: task.placeHolder,
        canPickMany: task.canPickMany || false
    };

    // Convert string items to QuickPickItem format
    const items: vscode.QuickPickItem[] = task.items.map((item: any) => {
        if (typeof item === 'string') {
            return { label: item };
        } else {
            return {
                label: item.label,
                description: item.description,
                detail: item.detail
            };
        }
    });

    if (task.canPickMany) {
        const selected = await vscode.window.showQuickPick(items, { ...options, canPickMany: true });
        if (selected && selected.length > 0) {
            const labels = selected.map(item => item.label);
            return { value: labels[0], values: labels.join(',') };
        } else {
            throw new Error('Quick pick selection was canceled.');
        }
    } else {
        const selected = await vscode.window.showQuickPick(items, options);
        if (selected) {
            return { value: selected.label };
        } else {
            throw new Error('Quick pick selection was canceled.');
        }
    }
}

async function handleUnzip(task: any, allResults: any, workspaceFolderPath?: string, actionId?: string): Promise<{ outputDir: string }> {
    const inputs = task.inputs || {};

    const resolveValue = (value: any, preferredKeys: string[]): string | undefined => {
        if (!value) { return undefined; }
        if (typeof value === 'string') { return value; }
        for (const key of preferredKeys) {
            if (typeof value[key] === 'string') { return value[key]; }
        }
        if (typeof value.output === 'string') { return value.output; }
        if (value.output && typeof value.output === 'object') {
            for (const key of preferredKeys) {
                if (typeof value.output[key] === 'string') { return value.output[key]; }
            }
        }
        return undefined;
    };

    const archiveSourceId = inputs.archive || inputs.file;
    const archiveSource = archiveSourceId ? allResults[archiveSourceId] : undefined;
    let archivePath = typeof task.archive === 'string' ? task.archive : undefined;
    if (!archivePath) {
        archivePath = resolveValue(archiveSource, ['path', 'archivePath']);
    }
    if (!archivePath) {
        throw new Error(`Unzip task '${task.id}' requires an archive path via 'inputs.archive', 'inputs.file', or the 'archive' property.`);
    }

    const destinationSourceId = inputs.destination;
    const destinationSource = destinationSourceId ? allResults[destinationSourceId] : undefined;
    let outputDir = typeof task.destination === 'string' ? task.destination : undefined;
    if (!outputDir) {
        outputDir = resolveValue(destinationSource, ['path', 'outputDir']);
    }
    if (!outputDir) {
        outputDir = resolveValue(archiveSource, ['dir']);
    }
    if (!outputDir) {
        outputDir = path.dirname(archivePath);
    }

    const toolCommand = getToolCommand(task.tool);
    const args = ['x', archivePath, `-o${outputDir}`, '-aoa'];
    try {
        await executeShellCommand(toolCommand, args, undefined, task.env, workspaceFolderPath, actionId);
        return { outputDir: outputDir };
    } catch (error: any) {
        throw new Error(`Failed to unzip file: ${error.message}`);
    }
}

async function handleZip(task: import('./schema').Task, allResults: any, workspaceFolderPath?: string, actionId?: string): Promise<{ archivePath: string }> {
    const interpolationContext = { ...allResults, workspaceFolder: workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '' };
    
    const toolCommand = getToolCommand(task.tool);
    const archive = task.archive ? interpolatePipelineVariables(task.archive, interpolationContext) : undefined;
    if (!archive) { throw new Error(`Zip task '${task.id}' is missing the 'archive' property.`); }

    let sourcePaths: string[] = [];
    if (Array.isArray(task.source)) {
        sourcePaths = task.source.map(s => interpolatePipelineVariables(s, interpolationContext));
    } else if (typeof task.source === 'string') {
        sourcePaths = [interpolatePipelineVariables(task.source, interpolationContext)];
    }

    if (sourcePaths.length === 0) {
        throw new Error(`Zip task '${task.id}' has no 'source' files or directories specified.`);
    }

    const args = ['a', archive, ...sourcePaths];
    let envOverrides: Record<string, string> | undefined;
    if (task.env && typeof task.env === 'object') {
        envOverrides = {};
        for (const [key, value] of Object.entries(task.env)) {
            if (typeof value === 'string') {
                envOverrides[key] = interpolatePipelineVariables(value, interpolationContext);
            }
        }
    }
    try {
        await executeShellCommand(
            toolCommand,
            args,
            task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined,
            envOverrides,
            workspaceFolderPath,
            actionId
        );
        return { archivePath: archive };
    } catch (error: any) {
        throw new Error(`Failed to zip files for task '${task.id}': ${error.message}`);
    }
}

export async function handleStringManipulation(task: any): Promise<{ output: string }> {
    const { function: func, input } = task;
    if (typeof input !== 'string') { throw new Error(`String manipulation task '${task.id}' requires the 'input' property to be a string.`); }

    const value = input;
    let output: string;
    switch (func) {
        case 'stripExtension': {
            const ext = path.extname(value);
            output = ext ? value.slice(0, -ext.length) : value;
            break;
        }
        case 'basename':
            output = path.basename(value);
            break;
        case 'basenameWithoutExtension':
            output = path.parse(value).name;
            break;
        case 'dirname':
            output = path.dirname(value);
            break;
        case 'extension': {
            const ext = path.extname(value);
            output = ext.startsWith('.') ? ext.substring(1) : ext;
            break;
        }
        case 'toLowerCase':
            output = value.toLowerCase();
            break;
        case 'toUpperCase':
            output = value.toUpperCase();
            break;
        case 'trim':
            output = value.trim();
            break;
        default:
            throw new Error(`Unsupported string manipulation function: ${func}`);
    }
    return { output };
}

export async function handleConfirm(task: any): Promise<{ confirmed: string }> {
    const message = task.message || 'Are you sure you want to continue?';
    const confirmLabel = task.confirmLabel || 'Yes';
    const cancelLabel = task.cancelLabel || 'No';

    const selected = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel,
        cancelLabel
    );

    if (selected === confirmLabel) {
        return { confirmed: 'true' };
    }
    throw new Error('Action was canceled by user.');
}

export interface TaskHubExportData {
    version: number;
    exportedAt: string;
    actions: ActionItem[];
}

export function serializeExportData(actions: ActionItem[]): string {
    const data: TaskHubExportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        actions
    };
    return JSON.stringify(data, null, 2);
}

export function parseImportData(content: string): { actions: ActionItem[]; errors: string[] } {
    const errors: string[] = [];
    let parsed: any;
    try {
        parsed = JSON.parse(content);
    } catch {
        return { actions: [], errors: ['Invalid JSON format.'] };
    }

    // Support both .taskhub format (with wrapper) and raw actions.json array
    let rawActions: any;
    if (Array.isArray(parsed)) {
        rawActions = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.actions)) {
        if (typeof parsed.version === 'number' && parsed.version > 1) {
            errors.push(`Unsupported export version: ${parsed.version}. This version of TaskHub supports version 1.`);
            return { actions: [], errors };
        }
        rawActions = parsed.actions;
    } else {
        return { actions: [], errors: ['File must contain a JSON array or a TaskHub export object with an "actions" array.'] };
    }

    // Validate using the schema
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile<ActionItem[]>(actionSchema);
    if (!validate(rawActions)) {
        const schemaErrors = validate.errors?.map(error =>
            `  - path: '${error.instancePath}' - ${error.message}`
        ).join('\n');
        errors.push(`Schema validation failed:\n${schemaErrors}`);
        return { actions: [], errors };
    }

    // Check for duplicate IDs within the imported file
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    const collectDuplicates = (items: ActionItem[]) => {
        for (const item of items) {
            if (item.id) {
                if (seenIds.has(item.id)) {
                    duplicateIds.push(item.id);
                } else {
                    seenIds.add(item.id);
                }
            }
            if (item.children) { collectDuplicates(item.children); }
        }
    };
    collectDuplicates(rawActions);
    if (duplicateIds.length > 0) {
        errors.push(`Duplicate action IDs found in imported file: ${duplicateIds.join(', ')}`);
        return { actions: [], errors };
    }

    return { actions: rawActions, errors: [] };
}

export function mergeImportedActions(existing: ActionItem[], imported: ActionItem[]): { merged: ActionItem[]; skipped: string[] } {
    const existingIds = new Set<string>();
    const collectIds = (items: ActionItem[]) => {
        for (const item of items) {
            if (item.id) { existingIds.add(item.id); }
            if (item.children) { collectIds(item.children); }
        }
    };
    collectIds(existing);

    const skipped: string[] = [];
    const newActions: ActionItem[] = [];
    for (const item of imported) {
        if (item.id && existingIds.has(item.id)) {
            skipped.push(item.id);
        } else {
            newActions.push(item);
        }
    }

    return { merged: [...existing, ...newActions], skipped };
}

function executeShellCommand(command: string, args: string[], cwd?: string, taskEnv?: Record<string, string>, workspaceFolderPath?: string, actionKey?: string): Promise<string> {

    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);

    return new Promise((resolve, reject) => {

        const { envOverrides, useUtf8Console } = resolveExecutionSettings(taskEnv);
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const [key, value] of Object.entries(envOverrides)) {
            childEnv[key] = value;
        }
        // Use undefined instead of empty string to let Node.js use process.cwd() as fallback
        const workingDirectory = cwd || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined;
        let childProcess: ReturnType<typeof spawn>;
        let displayCommand: string;

        if (process.platform === 'win32') {
            const invocation = buildPowerShellInvocation(command, args || [], useUtf8Console);
            const encoded = encodePowerShellScript(invocation.script);
            displayCommand = invocation.display;
            childProcess = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
                cwd: workingDirectory,
                env: childEnv
            });
        } else {
            const commandLine = buildPosixCommandLine(command, args || []);
            displayCommand = commandLine;
            childProcess = spawn(commandLine, [], {
                cwd: workingDirectory,
                env: childEnv,
                shell: true
            });
        }

        if (actionKey) {
            const processes = actionChildProcesses.get(actionKey) ?? new Set<ReturnType<typeof spawn>>();
            processes.add(childProcess);
            actionChildProcesses.set(actionKey, processes);
        }

        const cleanupChildTracking = () => {
            if (!actionKey) {
                return;
            }
            const processes = actionChildProcesses.get(actionKey);
            if (processes) {
                processes.delete(childProcess);
                if (processes.size === 0) {
                    actionChildProcesses.delete(actionKey);
                }
            }
        };



        if (showVerboseLogs) { outputChannel.appendLine(`[INFO] Executing command: ${displayCommand} in ${workingDirectory}`); }



        let stdout = '';

        let stderr = '';

        

        childProcess.stdout?.setEncoding('utf8');

        childProcess.stderr?.setEncoding('utf8');



        childProcess.stdout?.on('data', (data) => { stdout += data; });

        childProcess.stderr?.on('data', (data) => { stderr += data; });



        childProcess.on('close', (code) => {
            cleanupChildTracking();

            if (showVerboseLogs) { outputChannel.appendLine(`[INFO] STDOUT: ${stdout}`); outputChannel.appendLine(`[INFO] STDERR: ${stderr}`); outputChannel.appendLine(`[INFO] Command finished with exit code ${code}.`); }

            if (code === 0) { resolve(stdout); } else { reject(new Error(stderr || `Command failed with exit code ${code}`)); }

        });

        childProcess.on('error', (err) => { cleanupChildTracking(); if (showVerboseLogs) { outputChannel.appendLine(`[ERROR] Failed to start command: ${err.message}`); } reject(err); });

    });

}

function registerWorkspaceFileWatchers(relativePath: string, callback: () => void): vscode.Disposable {
    const watchers: vscode.FileSystemWatcher[] = [];
    const debouncedCallback = debounce(callback, 200);

    const resetWatchers = () => {
        // Dispose existing watchers *before* creating new ones to prevent overlap/leak
        while (watchers.length > 0) {
            watchers.pop()?.dispose();
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            const pattern = new vscode.RelativePattern(folder, relativePath);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(debouncedCallback.run);
            watcher.onDidCreate(debouncedCallback.run);
            watcher.onDidDelete(debouncedCallback.run);
            watchers.push(watcher);
        }
    };

    // Collapse rapid workspace-folder changes into a single reset.
    // VS Code emits multiple events when adding/removing several folders at once.
    const debouncedReset = debounce(() => {
        resetWatchers();
        callback();
    }, 150);

    resetWatchers();
    const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(debouncedReset.run);

    return new vscode.Disposable(() => {
        debouncedCallback.cancel();
        debouncedReset.cancel();
        workspaceSubscription.dispose();
        while (watchers.length > 0) {
            watchers.pop()?.dispose();
        }
    });
}

async function pickWorkspaceFolderForCommand(placeHolder: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(t('이 기능을 사용하려면 워크스페이스 폴더를 열어야 합니다.', 'Open a workspace folder to use this feature.'));
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder });
}

export function activate(context: vscode.ExtensionContext) {
    // DEBUG: i18n 로케일 확인 (문제 해결 후 제거)
    console.log(`[TaskHub] vscode.env.language = "${vscode.env.language}"`);

    const terminalDisposable = vscode.window.onDidCloseTerminal(terminal => {
        for (const [key, actionTerminal] of actionTerminals.entries()) {
            if (actionTerminal === terminal) {
                actionTerminals.delete(key);
                break;
            }
        }
    });
    context.subscriptions.push(terminalDisposable);


    const mainViewProvider = new MainViewProvider(context);
    const builtInLinkViewProvider = new LinkViewProvider(context, 'builtin');
    const workspaceLinkViewProvider = new LinkViewProvider(context, 'workspace');
    const favoriteViewProvider = new FavoriteViewProvider(context);
    const historyProvider = new HistoryProvider(context);
    const mainView = vscode.window.createTreeView('mainView.main', { treeDataProvider: mainViewProvider });
    context.subscriptions.push(mainView);
    mainView.onDidExpandElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, true); } });
    mainView.onDidCollapseElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, false); } });
    builtInLinkViewProvider.view = vscode.window.createTreeView('mainView.linkBuiltin', { treeDataProvider: builtInLinkViewProvider });
    workspaceLinkViewProvider.view = vscode.window.createTreeView('mainView.linkWorkspace', { treeDataProvider: workspaceLinkViewProvider });
    favoriteViewProvider.view = vscode.window.createTreeView('mainView.favorite', { treeDataProvider: favoriteViewProvider });
    historyProvider.view = vscode.window.createTreeView('mainView.history', { treeDataProvider: historyProvider });
    builtInLinkViewProvider.refresh();
    workspaceLinkViewProvider.refresh();
    favoriteViewProvider.refresh();
    historyProvider.refresh();
    context.subscriptions.push(builtInLinkViewProvider.view, workspaceLinkViewProvider.view, favoriteViewProvider.view, historyProvider.view);

    // Register hover provider for number base conversion and SFR bit fields in C/C++ files
    const numberBaseHoverProvider = new NumberBaseHoverProvider();
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            [
                { scheme: 'file', language: 'c' },
                { scheme: 'file', language: 'cpp' },
                { scheme: 'file', pattern: '**/*.{h,hpp,hh,hxx,h++}' }
            ],
            numberBaseHoverProvider
        )
    );

    const mediaActionsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, 'media/actions.json'));
    const debouncedMediaActionsRefresh = debounce(() => mainViewProvider.refresh(), 200);
    mediaActionsWatcher.onDidChange(debouncedMediaActionsRefresh.run);
    mediaActionsWatcher.onDidCreate(debouncedMediaActionsRefresh.run);
    mediaActionsWatcher.onDidDelete(debouncedMediaActionsRefresh.run);
    context.subscriptions.push(new vscode.Disposable(() => { debouncedMediaActionsRefresh.cancel(); mediaActionsWatcher.dispose(); }));
    const mediaLinksWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, 'media/links.json'));
    const debouncedMediaLinksRefresh = debounce(() => builtInLinkViewProvider.refresh(), 200);
    mediaLinksWatcher.onDidChange(debouncedMediaLinksRefresh.run);
    mediaLinksWatcher.onDidCreate(debouncedMediaLinksRefresh.run);
    mediaLinksWatcher.onDidDelete(debouncedMediaLinksRefresh.run);
    context.subscriptions.push(new vscode.Disposable(() => { debouncedMediaLinksRefresh.cancel(); mediaLinksWatcher.dispose(); }));
    const workspaceActionsWatchers = registerWorkspaceFileWatchers('.vscode/actions.json', () => mainViewProvider.refresh());
    const workspaceLinksWatchers = registerWorkspaceFileWatchers('.vscode/links.json', () => workspaceLinkViewProvider.refresh());
    const workspaceFavoritesWatchers = registerWorkspaceFileWatchers('.vscode/favorites.json', () => favoriteViewProvider.refresh());
    context.subscriptions.push(workspaceActionsWatchers, workspaceLinksWatchers, workspaceFavoritesWatchers);
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.createAction', async () => {
        await runActionCreationWizard(context, mainViewProvider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openFavoriteFile', async (favorite: FavoriteEntry | string) => {
        try {
            const target: FavoriteEntry = typeof favorite === 'string' ? { title: path.basename(favorite), path: favorite } : favorite;
            const workspaceFolderPath = target.workspaceFolder
                || vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.path))?.uri.fsPath
                || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                || '';
            const resolvedPath = target.path.replace('${workspaceFolder}', workspaceFolderPath || '');
            const uri = vscode.Uri.file(resolvedPath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);
            const line = normalizeLineNumber(target.line);
            if (line !== undefined) {
                const position = new vscode.Position(Math.max(line - 1, 0), 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(t(`파일을 열 수 없습니다: ${error.message}`, `Could not open file: ${error.message}`));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openLink', (url: string) => { vscode.env.openExternal(vscode.Uri.parse(url)); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.copyLink', (item: Link) => { vscode.env.clipboard.writeText(item.getLink()); vscode.window.showInformationMessage(t('링크가 클립보드에 복사되었습니다.', 'Link copied to clipboard.')); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.goToLink', (item: Link) => { vscode.env.openExternal(vscode.Uri.parse(item.getLink())); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.executeAction', async (actionItem: Action) => {
        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            console.error(error.message);
            vscode.window.showErrorMessage(t(`액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action: ${error.message}`));
            return;
        }

        const actionId = actionItem.id;
        if (!actionId) {
            return;
        }
        const fullActionItem = findActionById(allActions, actionId);
        if (fullActionItem) {
            try {
                await executeAction(fullActionItem, context, mainViewProvider, historyProvider);
            } catch (error) {
                console.error(`Execution failed for action '${actionId}':`, error);
            }
        } else {
            vscode.window.showErrorMessage(t(`ID '${actionId}'에 대한 액션 정의를 찾을 수 없습니다.`, `Could not find action definition for ID '${actionId}'.`));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.executeActionById', async (args: { id: string }) => {
        if (!args || !args.id) {
            vscode.window.showErrorMessage(t('이 명령어에는 액션 ID가 필요합니다.', 'Action ID is required for this command.'));
            return;
        }
        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            console.error(error.message);
            vscode.window.showErrorMessage(t(`ID로 액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action by ID: ${error.message}`));
            return;
        }
        const actionItem = findActionById(allActions, args.id);
        if (actionItem && actionItem.action) {
            await executeAction(actionItem, context, mainViewProvider, historyProvider);
        } else {
            vscode.window.showErrorMessage(t(`ID '${args.id}'인 액션을 찾을 수 없거나 'action' 속성이 없습니다.`, `Action with ID '${args.id}' not found or it has no 'action' property.`));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.stopAction', (actionItem: Action) => {
        const id = actionItem.id || actionItem.label;
        if (!id) {
            return;
        }
        let stopped = false;
        const task = activeTasks.get(id);
        if (task) {
            manuallyTerminatedActions.add(id);
            task.terminate();
            stopped = true;
        }
        if (terminateChildProcesses(id)) {
            manuallyTerminatedActions.add(id);
            stopped = true;
        }
        if (!stopped) {
            manuallyTerminatedActions.delete(id);
            vscode.window.showWarningMessage(t(`'${actionItem.label}'에 대한 활성 태스크를 찾을 수 없습니다.`, `Could not find active task for '${actionItem.label}'.`));
        } else {
            // Update history status to failure when manually stopped
            const timestamp = actionStartTimestamps.get(id);
            if (historyProvider && timestamp) {
                historyProvider.updateHistoryStatus(id, timestamp, 'failure', 'Action stopped by user');
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showVersion', () => { const packageJson = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf-8')); vscode.window.showInformationMessage(t(`TaskHub 버전: ${packageJson.version}`, `TaskHub Version: ${packageJson.version}`)); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showChangelog', async () => {
        const changelogPath = path.join(context.extensionPath, 'CHANGELOG.md');
        if (fs.existsSync(changelogPath)) {
            const doc = await vscode.workspace.openTextDocument(changelogPath);
            await vscode.window.showTextDocument(doc, { preview: true });
        } else {
            vscode.window.showWarningMessage(t('CHANGELOG.md 파일을 찾을 수 없습니다.', 'CHANGELOG.md not found.'));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showFilePicker', async (action: any) => { /* Obsolete */ }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.editFavorites', async () => {
        const folder = await pickWorkspaceFolderForCommand(t('즐겨찾기를 편집할 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to edit favorites for'));
        if (!folder) {
            return;
        }
        const filePath = path.join(folder.uri.fsPath, '.vscode', 'favorites.json');
        if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
        if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.editLinks', async () => {
        const folder = await pickWorkspaceFolderForCommand(t('링크를 편집할 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to edit links for'));
        if (!folder) {
            return;
        }
        const filePath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
        if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
        if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.editActions', async () => {
        const folder = await pickWorkspaceFolderForCommand(t('액션을 편집할 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to edit actions for'));
        if (!folder) {
            return;
        }
        const filePath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
        if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
        if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); }
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.searchLinks', async () => {
        await promptLinkSearch(workspaceLinkViewProvider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.editWorkspaceLink', async (item?: Link) => {
        await promptWorkspaceLinkEdit(workspaceLinkViewProvider, item);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.addLink', async () => {
        const folder = await pickWorkspaceFolderForCommand(t('링크를 추가할 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to add the link to'));
        if (!folder) {
            return;
        }

        const title = await vscode.window.showInputBox({
            prompt: t('링크 제목', 'Title for the link'),
            placeHolder: 'e.g. Project Dashboard',
            ignoreFocusOut: true,
            validateInput: value => value.trim().length === 0 ? t('제목을 입력하세요', 'Enter a title') : null
        });
        if (!title) {
            return;
        }

        const url = await vscode.window.showInputBox({
            prompt: t('열 URL', 'URL to open'),
            placeHolder: 'https://example.com',
            ignoreFocusOut: true,
            validateInput: value => value.trim().length === 0 ? t('URL을 입력하세요', 'Enter a URL') : null
        });
        if (!url) {
            return;
        }

        const groupInput = await vscode.window.showInputBox({
            prompt: t('그룹 레이블 (선택사항)', 'Group label (optional)'),
            placeHolder: 'e.g. Documentation',
            ignoreFocusOut: true
        });
        if (groupInput === undefined) {
            return;
        }
        const group = groupInput.trim().length > 0 ? groupInput.trim() : undefined;

        const tagsInput = await vscode.window.showInputBox({
            prompt: t('태그 (선택사항, 쉼표로 구분)', 'Tags (optional, comma-separated)'),
            placeHolder: 'e.g. docs, api',
            ignoreFocusOut: true
        });
        if (tagsInput === undefined) {
            return;
        }
        const tags = parseTagInput(tagsInput);

        const linksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
        const links = loadLinksFromDisk(linksPath, true);
        const { entries: updatedLinks, added } = addLinkEntry(links, {
            title,
            link: url,
            group,
            tags,
            sourceFile: linksPath
        });
        if (!added) {
            vscode.window.showInformationMessage(t('이 링크는 links.json에 이미 존재합니다.', 'This link already exists in links.json.'));
            return;
        }

        const serialized = serializeLinks(updatedLinks);
        if (!fs.existsSync(path.dirname(linksPath))) {
            fs.mkdirSync(path.dirname(linksPath), { recursive: true });
        }
        fs.writeFileSync(linksPath, JSON.stringify(serialized, null, 2) + '\n');
        workspaceLinkViewProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.searchFavorites', async () => {
        await promptFavoriteSearch(favoriteViewProvider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.addFavoriteFile', async (uri?: vscode.Uri) => {
        let fileUris: vscode.Uri[] | undefined;
        if (uri) {
            fileUris = [uri];
        } else {
            fileUris = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: t('즐겨찾기에 추가', 'Add to Favorites'),
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
            });
        }

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const groupInput = await vscode.window.showInputBox({
            prompt: t('그룹 레이블 (선택사항)', 'Group label (optional)'),
            placeHolder: 'e.g. Backend Services',
            ignoreFocusOut: true
        });
        if (groupInput === undefined) {
            return;
        }
        const group = groupInput.trim().length > 0 ? groupInput.trim() : undefined;

        const tagsInput = await vscode.window.showInputBox({
            prompt: t('태그 (선택사항, 쉼표로 구분)', 'Tags (optional, comma-separated)'),
            placeHolder: 'e.g. api, critical',
            ignoreFocusOut: true
        });
        if (tagsInput === undefined) {
            return;
        }
        const defaultTags = parseTagInput(tagsInput);

        const favoritesByPath = new Map<string, FavoriteEntry[]>();

        for (const fileUri of fileUris) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (!workspaceFolder) {
                vscode.window.showWarningMessage(t(`${fileUri.fsPath}은(는) 현재 워크스페이스에 포함되어 있지 않아 건너뜁니다.`, `Skipping ${fileUri.fsPath} because it is not part of the current workspace.`));
                continue;
            }
            const favoritesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'favorites.json');
            if (!favoritesByPath.has(favoritesPath)) {
                favoritesByPath.set(favoritesPath, loadFavoritesFromDisk(favoritesPath, true, workspaceFolder.uri.fsPath));
            }
            const favorites = favoritesByPath.get(favoritesPath)!;
            const title = await vscode.window.showInputBox({
                prompt: t(`${path.basename(fileUri.fsPath)}의 제목을 입력하세요`, `Enter a title for ${path.basename(fileUri.fsPath)}`),
                value: path.basename(fileUri.fsPath),
                ignoreFocusOut: true
            });
            if (!title) {
                continue;
            }
            const line = await promptFavoriteLineNumber(t(`${path.basename(fileUri.fsPath)}의 줄 번호 (선택사항)`, `Line number for ${path.basename(fileUri.fsPath)} (optional)`));
            if (line === 'cancel') {
                return;
            }
            const favorite: FavoriteEntry = {
                title,
                path: fileUri.fsPath,
                sourceFile: favoritesPath,
                workspaceFolder: workspaceFolder.uri.fsPath
            };
            if (group) {
                favorite.group = group;
            }
            if (defaultTags) {
                favorite.tags = defaultTags;
            }
            if (line !== undefined) {
                favorite.line = line;
            }
            favorites.push(favorite);
        }

        for (const [favoritesPath, favorites] of favoritesByPath.entries()) {
            const serialized = serializeFavorites(favorites);
            if (!fs.existsSync(path.dirname(favoritesPath))) {
                fs.mkdirSync(path.dirname(favoritesPath), { recursive: true });
            }
            fs.writeFileSync(favoritesPath, JSON.stringify(serialized, null, 2) + '\n');
        }

        if (favoritesByPath.size > 0) {
            favoriteViewProvider.refresh();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.deleteFavorite', async (item: Favorite) => {
        const confirm = await vscode.window.showWarningMessage(t(`${item.label}을(를) 삭제하시겠습니까?`, `Are you sure you want to delete ${item.label}?`), { modal: true }, 'Yes');
        if (confirm !== 'Yes') {
            return;
        }
        const sourceFile = item.getSourceFile();
        if (!sourceFile) {
            vscode.window.showInformationMessage(t('이 즐겨찾기는 읽기 전용입니다.', 'This favorite is read-only.'));
            return;
        }
        if (!fs.existsSync(sourceFile)) {
            return;
        }
        const target = item.getEntry();
        const targetLine = normalizeLineNumber(target.line);
        const favorites = loadFavoritesFromDisk(sourceFile, true, target.workspaceFolder);
        const filtered = favorites.filter(f => {
            const line = normalizeLineNumber(f.line);
            const samePath = f.path === target.path;
            const sameLine = (line ?? null) === (targetLine ?? null);
            const sameTitle = f.title === target.title;
            const sameGroup = (f.group ?? null) === (target.group ?? null);
            return !(samePath && sameLine && sameTitle && sameGroup);
        });
        if (filtered.length === favorites.length) {
            return;
        }
        const serialized = serializeFavorites(filtered);
        fs.writeFileSync(sourceFile, JSON.stringify(serialized, null, 2) + '\n');
        favoriteViewProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.deleteLink', async (item: Link) => {
        const confirm = await vscode.window.showWarningMessage(t(`${item.label}을(를) 삭제하시겠습니까?`, `Are you sure you want to delete ${item.label}?`), { modal: true }, 'Yes');
        if (confirm !== 'Yes') {
            return;
        }
        const sourceFile = item.getEntry().sourceFile;
        if (!sourceFile) {
            vscode.window.showInformationMessage(t('이 링크는 확장 프로그램에서 제공하며 여기서 삭제할 수 없습니다.', 'This link is provided by the extension and cannot be deleted here.'));
            return;
        }
        const belongsToWorkspace = (vscode.workspace.workspaceFolders ?? []).some(folder => sourceFile.startsWith(folder.uri.fsPath + path.sep));
        if (!belongsToWorkspace) {
            vscode.window.showInformationMessage(t('이 링크는 확장 프로그램에서 제공하며 여기서 삭제할 수 없습니다.', 'This link is provided by the extension and cannot be deleted here.'));
            return;
        }
        if (!fs.existsSync(sourceFile)) {
            return;
        }
        const target = item.getEntry();
        const links = loadLinksFromDisk(sourceFile, true);
        const filtered = links.filter(link => !(link.title === target.title && link.link === target.link));
        if (filtered.length === links.length) {
            return;
        }
        const serialized = serializeLinks(filtered);
        fs.writeFileSync(sourceFile, JSON.stringify(serialized, null, 2) + '\n');
        workspaceLinkViewProvider.refresh();
    }));
      const showExampleJsonCommand = vscode.commands.registerCommand('taskhub.showExampleJson', async (jsonType: string) => {
    let exampleContent = '';
    let fileName = '';

    try {
      switch (jsonType) {
        case 'actions':
          fileName = 'actions_example.json';
          const actionsExamplePath = path.join(context.extensionPath, 'media', 'actions_example.json');
          exampleContent = fs.readFileSync(actionsExamplePath, 'utf-8');
          break;
        case 'links':
          fileName = 'links_example.json';
          const linksExamplePath = path.join(context.extensionPath, 'media', 'links_example.json');
          exampleContent = fs.readFileSync(linksExamplePath, 'utf-8');
          break;
        case 'favorites':
          fileName = 'favorites_example.json';
          const favoritesExamplePath = path.join(context.extensionPath, 'media', 'favorites_example.json');
          exampleContent = fs.readFileSync(favoritesExamplePath, 'utf-8');
          break;
        default:
          vscode.window.showErrorMessage(t(`알 수 없는 JSON 타입: ${jsonType}`, `Unknown JSON type: ${jsonType}`));
          return;
      }

      const document = await vscode.workspace.openTextDocument({
        content: exampleContent,
        language: 'jsonc' // Use jsonc for comments in examples
      });
      await vscode.window.showTextDocument(document, { preview: true });
      vscode.window.showInformationMessage(t(`예제 ${fileName}이(가) 열렸습니다.`, `Example ${fileName} opened.`));

    } catch (error: any) {
      vscode.window.showErrorMessage(t(`예제 ${fileName} 열기 실패: ${error.message}`, `Failed to open example ${fileName}: ${error.message}`));
    }
  });
    context.subscriptions.push(showExampleJsonCommand);
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showExampleJsonQuickPick', async () => { const pick = await vscode.window.showQuickPick([ { label: t('actions.json 예제', 'actions.json Example'), description: t('actions.json 예제 내용 보기', 'Show example content for actions.json'), type: 'actions' }, { label: t('links.json 예제', 'links.json Example'), description: t('links.json 예제 내용 보기', 'Show example content for links.json'), type: 'links' }, { label: t('favorites.json 예제', 'favorites.json Example'), description: t('favorites.json 예제 내용 보기', 'Show example content for favorites.json'), type: 'favorites' }, ], { placeHolder: t('표시할 예제 JSON을 선택하세요', 'Select which example JSON to display') }); if (pick) { vscode.commands.executeCommand('taskhub.showExampleJson', pick.type); } }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.addOpenFileToFavorites', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(t('활성 편집기를 찾을 수 없습니다.', 'No active editor found.'));
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const title = await vscode.window.showInputBox({
            prompt: t(`${path.basename(filePath)}의 제목을 입력하세요`, `Enter a title for ${path.basename(filePath)}`),
            value: path.basename(filePath),
            ignoreFocusOut: true
        });
        if (!title) {
            return;
        }

        const groupInput = await vscode.window.showInputBox({
            prompt: t('그룹 레이블 (선택사항)', 'Group label (optional)'),
            placeHolder: 'e.g. Documentation',
            ignoreFocusOut: true
        });
        if (groupInput === undefined) {
            return;
        }
        const group = groupInput.trim().length > 0 ? groupInput.trim() : undefined;

        const tagsInput = await vscode.window.showInputBox({
            prompt: t('태그 (선택사항, 쉼표로 구분)', 'Tags (optional, comma-separated)'),
            placeHolder: 'e.g. notes, reference',
            ignoreFocusOut: true
        });
        if (tagsInput === undefined) {
            return;
        }
        const tags = parseTagInput(tagsInput);
        const defaultLine = editor.selection.active.line + 1;
        const line = await promptFavoriteLineNumber(t('이 즐겨찾기의 줄 번호 (선택사항)', 'Line number for this favorite (optional)'), defaultLine);
        if (line === 'cancel') {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(t('활성 파일이 열린 워크스페이스 폴더에 속하지 않습니다.', 'The active file does not belong to an open workspace folder.'));
            return;
        }
        const favoritesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'favorites.json');
        const favorites = loadFavoritesFromDisk(favoritesPath, true, workspaceFolder.uri.fsPath);
        const favorite: FavoriteEntry = {
            title,
            path: filePath,
            sourceFile: favoritesPath,
            workspaceFolder: workspaceFolder.uri.fsPath
        };
        if (group) {
            favorite.group = group;
        }
        if (tags) {
            favorite.tags = tags;
        }
        if (line !== undefined) {
            favorite.line = line;
        }
        favorites.push(favorite);

        const serialized = serializeFavorites(favorites);
        if (!fs.existsSync(path.dirname(favoritesPath))) {
            fs.mkdirSync(path.dirname(favoritesPath), { recursive: true });
        }
        fs.writeFileSync(favoritesPath, JSON.stringify(serialized, null, 2) + '\n');
        favoriteViewProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.terminateAllActions', async () => {
        // Flag and terminate all running actions
        for (const [actionId, execution] of activeTasks.entries()) {
            manuallyTerminatedActions.add(actionId);
            execution.terminate();
        }
        for (const actionId of Array.from(actionChildProcesses.keys())) {
            manuallyTerminatedActions.add(actionId);
            terminateChildProcesses(actionId);
        }

        // Close all terminals associated with the extension
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith('TaskHub: ')) {
                terminal.dispose();
            }
        });

        // Clear all visual states and refresh
        actionStates.clear();
        mainViewProvider.refresh();

        vscode.window.showInformationMessage(t('모든 TaskHub 터미널이 닫혔습니다.', 'All TaskHub terminals have been closed.'));
    }));

    // History commands
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.rerunFromHistory', async (entry: HistoryEntry) => {
        if (!entry || !entry.actionId) {
            vscode.window.showErrorMessage(t('유효하지 않은 기록 항목입니다.', 'Invalid history entry.'));
            return;
        }

        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            console.error(error.message);
            vscode.window.showErrorMessage(t(`액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action: ${error.message}`));
            return;
        }

        const fullActionItem = findActionById(allActions, entry.actionId);
        if (fullActionItem) {
            try {
                await executeAction(fullActionItem, context, mainViewProvider, historyProvider);
            } catch (error) {
                console.error(`Execution failed for action '${entry.actionId}':`, error);
            }
        } else {
            vscode.window.showErrorMessage(t(`ID '${entry.actionId}'에 대한 액션 정의를 찾을 수 없습니다.`, `Could not find action definition for ID '${entry.actionId}'.`));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.viewHistoryOutput', async (item: HistoryItem) => {
        const entry = item.getEntry();
        if (!entry.output) {
            vscode.window.showInformationMessage(t('이 기록 항목에 사용 가능한 출력이 없습니다.', 'No output available for this history item.'));
            return;
        }

        const doc = await vscode.workspace.openTextDocument({
            content: entry.output,
            language: 'text'
        });
        await vscode.window.showTextDocument(doc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.deleteHistoryItem', async (item: HistoryItem) => {
        const entry = item.getEntry();
        historyProvider.deleteHistoryItem(entry);
        vscode.window.showInformationMessage(t('기록 항목이 삭제되었습니다.', 'History item deleted.'));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.clearAllHistory', async () => {
        const clearAllLabel = t('모두 삭제', 'Clear All');
        const confirm = await vscode.window.showWarningMessage(
            t('모든 기록을 삭제하시겠습니까?', 'Are you sure you want to clear all history?'),
            { modal: true },
            clearAllLabel
        );
        if (confirm === clearAllLabel) {
            historyProvider.clearAllHistory();
            vscode.window.showInformationMessage(t('모든 기록이 삭제되었습니다.', 'All history cleared.'));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.toggleHistoryPanel', async () => {
        const config = vscode.workspace.getConfiguration('taskhub.history');
        const currentValue = config.get<boolean>('showPanel', true);
        await config.update('showPanel', !currentValue, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(t(`기록 패널이 ${!currentValue ? '표시' : '숨김'}되었습니다.`, `History panel ${!currentValue ? 'shown' : 'hidden'}.`));
    }));

    // Watch for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('taskhub.history.maxItems')) {
            historyProvider.trimHistoryToMax();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openSettings', () => { vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Munseop.taskhub'); }));

    // ========================================================================
    // Preset Commands
    // ========================================================================

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.applyPreset', async () => {
        try {
            // Step 1: Select workspace folder
            const folder = await pickWorkspaceFolderForCommand(t('프리셋을 적용할 워크스페이스를 선택하세요', 'Select workspace to apply preset to'));
            if (!folder) {
                return;
            }

            const actionsPath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
            const hasExisting = fs.existsSync(actionsPath);

            // Step 2: Discover and select preset
            const presets = discoverPresets(context);
            if (presets.length === 0) {
                vscode.window.showWarningMessage(t('프리셋을 찾을 수 없습니다. "프리셋으로 저장"으로 생성하세요.', 'No presets found. Create one with "Save as Preset".'));
                return;
            }

            const selected = await vscode.window.showQuickPick(
                presets.map(p => ({
                    label: p.name,
                    description: p.source === 'extension' ? 'built-in' : `workspace: ${p.workspaceName}`,
                    preset: p
                })),
                { placeHolder: t('적용할 프리셋을 선택하세요', 'Select a preset to apply') }
            );

            if (!selected) {
                return;
            }

            // Step 3: Load preset
            const presetActions = loadAndValidateActions(selected.preset.filePath, {
                sourceLabel: `preset: ${selected.preset.name}`
            });

            // Step 4: Determine how to apply
            let finalActions: ActionItem[];

            if (!hasExisting) {
                // No existing actions.json - create new
                finalActions = presetActions;
            } else {
                // Existing actions.json - ask how to apply
                const replaceLabel = t('교체', 'Replace');
                const mergeLabel = t('병합', 'Merge');
                const applyMode = await vscode.window.showQuickPick([
                    { label: replaceLabel, description: t('기존 액션을 프리셋으로 교체', 'Replace existing actions with preset') },
                    { label: mergeLabel, description: t('프리셋을 기존 액션과 병합', 'Merge preset with existing actions') }
                ], { placeHolder: t('프리셋을 어떻게 적용할까요?', 'How to apply preset?') });

                if (!applyMode) {
                    return;
                }

                if (applyMode.label === replaceLabel) {
                    finalActions = presetActions;
                } else {
                    // Merge: check for conflicts
                    const existingActions = loadAndValidateActions(actionsPath, {
                        sourceLabel: 'workspace'
                    });
                    const conflicts = findConflictingIds(existingActions, presetActions);

                    let mergeStrategy: 'keep-existing' | 'use-preset' | 'keep-both';

                    if (conflicts.length > 0) {
                        const keepExistingLabel = t('기존 유지', 'Keep existing');
                        const usePresetLabel = t('프리셋 사용', 'Use preset');
                        const keepBothLabel = t('모두 유지', 'Keep both');
                        const choice = await vscode.window.showQuickPick([
                            {
                                label: keepExistingLabel,
                                description: t(`기존 ${conflicts.length}개 액션을 유지하고 프리셋에서 충돌하지 않는 항목 추가`, `Keep your ${conflicts.length} actions, add non-conflicting from preset`)
                            },
                            {
                                label: usePresetLabel,
                                description: t(`프리셋의 ${conflicts.length}개 액션을 사용하고 충돌하지 않는 기존 항목 유지`, `Use preset's ${conflicts.length} actions, keep non-conflicting from yours`)
                            },
                            {
                                label: keepBothLabel,
                                description: t('모든 액션 유지 (충돌하는 프리셋 액션은 제외)', 'Keep all actions (conflicting preset actions are dropped)')
                            }
                        ], {
                            placeHolder: t(`${conflicts.length}개의 충돌하는 액션 ID를 찾았습니다. 어떻게 해결할까요?`, `Found ${conflicts.length} conflicting action IDs. How to resolve?`)
                        });

                        if (!choice) {
                            return;
                        }

                        mergeStrategy = choice.label === keepExistingLabel
                            ? 'keep-existing'
                            : choice.label === usePresetLabel
                                ? 'use-preset'
                                : 'keep-both';
                    } else {
                        mergeStrategy = 'keep-both';
                    }

                    finalActions = mergeActions(existingActions, presetActions, mergeStrategy);
                }
            }

            // Step 5: Save
            const vscodeDir = path.dirname(actionsPath);
            fs.mkdirSync(vscodeDir, { recursive: true });
            fs.writeFileSync(actionsPath, JSON.stringify(finalActions, null, 2) + '\n');

            // Step 6: Refresh UI and notify
            mainViewProvider.refresh();
            const openActionsLabel = t('actions.json 열기', 'Open actions.json');
            const result = await vscode.window.showInformationMessage(
                t(`프리셋 "${selected.preset.name}"이(가) 성공적으로 적용되었습니다!`, `Preset "${selected.preset.name}" applied successfully!`),
                openActionsLabel
            );

            if (result === openActionsLabel) {
                const doc = await vscode.workspace.openTextDocument(actionsPath);
                await vscode.window.showTextDocument(doc);
            }

        } catch (error: any) {
            vscode.window.showErrorMessage(t(`프리셋 적용 실패: ${error.message}`, `Failed to apply preset: ${error.message}`));
            outputChannel.appendLine(`[Preset Error] ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.saveAsPreset', async () => {
        try {
            // Step 1: Select workspace folder
            const folder = await pickWorkspaceFolderForCommand(t('프리셋을 저장할 워크스페이스를 선택하세요', 'Select workspace to save preset from'));
            if (!folder) {
                return;
            }

            const actionsPath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
            if (!fs.existsSync(actionsPath)) {
                vscode.window.showErrorMessage(t('actions.json을 찾을 수 없습니다. 먼저 액션을 생성하세요.', 'No actions.json found. Create actions first.'));
                return;
            }

            // Step 2: Load actions
            const actions = loadAndValidateActions(actionsPath, {
                sourceLabel: 'workspace'
            });

            // Step 3: Get preset ID
            const presetId = await vscode.window.showInputBox({
                prompt: t('프리셋 ID를 입력하세요 (예: integration, hil)', 'Enter preset ID (e.g., integration, hil)'),
                placeHolder: 'integration',
                validateInput: (value) => {
                    if (!value || !/^[a-z0-9-_]+$/.test(value)) {
                        return t('소문자, 숫자, 하이픈, 밑줄만 사용할 수 있습니다', 'Use lowercase letters, numbers, hyphens, and underscores only');
                    }
                    return null;
                }
            });

            if (!presetId) {
                return;
            }

            // Step 4: Choose save location
            const workspaceLabel = t('워크스페이스', 'Workspace');
            const extensionLabel = t('확장 프로그램', 'Extension');
            const customLabel = t('사용자 지정 위치', 'Custom location');
            const saveLocation = await vscode.window.showQuickPick([
                { label: workspaceLabel, description: t('.vscode/presets/에 저장 (Git으로 공유)', 'Save to .vscode/presets/ (shared via Git)') },
                { label: extensionLabel, description: t('확장 프로그램 presets/ 폴더에 저장', 'Save to extension presets/ folder') },
                { label: customLabel, description: t('파일 위치 직접 선택', 'Choose a file location') }
            ], { placeHolder: t('프리셋을 어디에 저장할까요?', 'Where to save this preset?') });

            if (!saveLocation) {
                return;
            }

            const fileName = `preset-${presetId}.json`;
            let targetPath: string;

            if (saveLocation.label === workspaceLabel) {
                const presetsDir = path.join(folder.uri.fsPath, '.vscode', 'presets');
                fs.mkdirSync(presetsDir, { recursive: true });
                targetPath = path.join(presetsDir, fileName);
            } else if (saveLocation.label === extensionLabel) {
                const presetsDir = path.join(context.extensionPath, 'presets');
                fs.mkdirSync(presetsDir, { recursive: true });
                targetPath = path.join(presetsDir, fileName);
            } else {
                const fileUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(fileName),
                    filters: { 'JSON': ['json'] }
                });
                if (!fileUri) {
                    return;
                }
                targetPath = fileUri.fsPath;
            }

            // Step 5: Save
            fs.writeFileSync(targetPath, JSON.stringify(actions, null, 2) + '\n');

            // Step 6: Notify
            const openLabel = t('열기', 'Open');
            const revealLabel = t('탐색기에서 보기', 'Reveal');
            const result = await vscode.window.showInformationMessage(
                t(`프리셋 저장됨: ${path.basename(targetPath)}`, `Preset saved: ${path.basename(targetPath)}`),
                openLabel, revealLabel
            );

            if (result === openLabel) {
                const doc = await vscode.workspace.openTextDocument(targetPath);
                await vscode.window.showTextDocument(doc);
            } else if (result === revealLabel) {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetPath));
            }

        } catch (error: any) {
            vscode.window.showErrorMessage(t(`프리셋 저장 실패: ${error.message}`, `Failed to save preset: ${error.message}`));
            outputChannel.appendLine(`[Preset Error] ${error.message}`);
        }
    }));

    // ========================================================================
    // Preset Settings Listener
    // ========================================================================

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('taskhub.preset.selected')) {
                const presetId = getSelectedPresetId();
                mainViewProvider.refresh();
                outputChannel.appendLine(`[Preset] Settings changed to: ${presetId || 'none'}`);

                if (presetId) {
                    vscode.window.showInformationMessage(t(`프리셋 "${presetId}"이(가) 적용되었습니다. 액션이 다시 로드되었습니다.`, `Preset "${presetId}" applied. Actions reloaded.`));
                } else {
                    vscode.window.showInformationMessage(t('프리셋이 해제되었습니다. 워크스페이스 액션만 사용합니다.', 'Preset cleared. Using workspace actions only.'));
                }
            }
        })
    );
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openJsonEditor', () => openJsonEditor(context)));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openJsonEditorFromUri', (uri?: vscode.Uri) => openJsonEditorFromUri(context, uri)));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.exportActions', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(t('열린 워크스페이스 폴더가 없습니다.', 'No workspace folder is open.'));
            return;
        }
        const actionsPath = path.join(workspaceFolder, '.vscode', 'actions.json');
        if (!fs.existsSync(actionsPath)) {
            vscode.window.showErrorMessage(t('현재 워크스페이스에서 .vscode/actions.json을 찾을 수 없습니다.', 'No .vscode/actions.json found in the current workspace.'));
            return;
        }
        let actions: ActionItem[];
        try {
            actions = loadAndValidateActions(actionsPath, { sourceLabel: 'workspace' });
        } catch (e: any) {
            vscode.window.showErrorMessage(t(`액션 로드 실패: ${e.message}`, `Failed to load actions: ${e.message}`));
            return;
        }
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workspaceFolder, 'actions.taskhub')),
            filters: { 'TaskHub Export': ['taskhub'], 'JSON': ['json'] }
        });
        if (!saveUri) { return; }
        const exportContent = serializeExportData(actions);
        fs.writeFileSync(saveUri.fsPath, exportContent, 'utf-8');
        vscode.window.showInformationMessage(t(`${actions.length}개 액션을 ${path.basename(saveUri.fsPath)}로 내보냈습니다.`, `Exported ${actions.length} action(s) to ${path.basename(saveUri.fsPath)}`));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.exportActionItem', async (treeItem?: Action | Folder) => {
        if (!treeItem || !treeItem.id) {
            vscode.window.showErrorMessage(t('선택된 액션 또는 폴더가 없습니다.', 'No action or folder selected.'));
            return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(t('열린 워크스페이스 폴더가 없습니다.', 'No workspace folder is open.'));
            return;
        }
        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (e: any) {
            vscode.window.showErrorMessage(t(`액션 로드 실패: ${e.message}`, `Failed to load actions: ${e.message}`));
            return;
        }
        const actionItem = findActionById(allActions, treeItem.id);
        if (!actionItem) {
            vscode.window.showErrorMessage(t(`액션 '${treeItem.id}'을(를) 찾을 수 없습니다.`, `Action '${treeItem.id}' not found.`));
            return;
        }
        const defaultName = `${treeItem.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.taskhub`;
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workspaceFolder, defaultName)),
            filters: { 'TaskHub Export': ['taskhub'], 'JSON': ['json'] }
        });
        if (!saveUri) { return; }
        const exportContent = serializeExportData([actionItem]);
        fs.writeFileSync(saveUri.fsPath, exportContent, 'utf-8');
        const itemCount = actionItem.children ? countActionItems(actionItem) : 1;
        vscode.window.showInformationMessage(t(`'${actionItem.title}' (${itemCount}개 항목)을 ${path.basename(saveUri.fsPath)}로 내보냈습니다.`, `Exported '${actionItem.title}' (${itemCount} item(s)) to ${path.basename(saveUri.fsPath)}`));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.importActions', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(t('열린 워크스페이스 폴더가 없습니다.', 'No workspace folder is open.'));
            return;
        }
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'TaskHub Export': ['taskhub', 'json'] }
        });
        if (!fileUri || fileUri.length === 0) { return; }
        const content = fs.readFileSync(fileUri[0].fsPath, 'utf-8');
        const { actions: importedActions, errors } = parseImportData(content);
        if (errors.length > 0) {
            vscode.window.showErrorMessage(t(`가져오기 실패: ${errors.join('\n')}`, `Import failed: ${errors.join('\n')}`));
            return;
        }
        if (importedActions.length === 0) {
            vscode.window.showWarningMessage(t('가져온 파일에서 액션을 찾을 수 없습니다.', 'No actions found in the imported file.'));
            return;
        }

        const actionsPath = path.join(workspaceFolder, '.vscode', 'actions.json');
        let existingActions: ActionItem[] = [];
        if (fs.existsSync(actionsPath)) {
            try {
                existingActions = JSON.parse(fs.readFileSync(actionsPath, 'utf-8'));
            } catch {
                existingActions = [];
            }
        }

        const { merged, skipped } = mergeImportedActions(existingActions, importedActions);
        const vscodeDir = path.join(workspaceFolder, '.vscode');
        if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
        fs.writeFileSync(actionsPath, JSON.stringify(merged, null, 2), 'utf-8');

        const addedCount = importedActions.length - skipped.length;
        let msg = t(`${addedCount}개 액션을 가져왔습니다.`, `Imported ${addedCount} action(s).`);
        if (skipped.length > 0) {
            msg += t(` ${skipped.length}개 중복 건너뜀: ${skipped.join(', ')}`, ` Skipped ${skipped.length} duplicate(s): ${skipped.join(', ')}`);
        }
        vscode.window.showInformationMessage(msg);
        mainViewProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showMemoryMap', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let memConfig: MemoryMapConfig | undefined;
        if (workspaceFolder) {
            const typesPath = path.join(workspaceFolder, '.vscode', 'taskhub_types.json');
            if (fs.existsSync(typesPath)) {
                try {
                    const typesData = JSON.parse(fs.readFileSync(typesPath, 'utf-8'));
                    if (typesData.memoryMap?.regions) {
                        memConfig = { regions: typesData.memoryMap.regions };
                    }
                } catch { /* ignore parse errors */ }
            }
        }
        await showMemoryMap(context, memConfig);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.memoryMapGoToSymbol', () => {
        goToSymbol();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showHexViewer', async () => {
        await showHexViewer(context);
    }));

    context.subscriptions.push(vscode.window.registerCustomEditorProvider(
        'taskhub.hexEditor',
        new HexEditorProvider(context),
        { supportsMultipleEditorsPerDocument: true }
    ));
}

export function deactivate() {
    actionStates.clear();
    activeTasks.clear();
    manuallyTerminatedActions.clear();
    actionTerminals.clear();
    actionWorkspaceFolderMap.clear();
    actionChildProcesses.clear();
    actionStartTimestamps.clear();
}
