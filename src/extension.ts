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
import { openJsonEditor, openJsonEditorFromUri, openJsonEditorFile, JsonEditorOpenHistory } from './jsonEditor';
import { openMarkdownPreview, openHtmlInBrowser } from './previewOpener';
import {
    showMemoryMap,
    MemoryMapConfig,
    MemoryMapOpenHistory,
    goToSymbol,
    revealSourceSymbolInMemoryMap,
    openMemoryMapPanel,
    openMemoryMapFromListing,
} from './memoryMapViewer';
import { showHexViewer, HexEditorProvider, HexViewerOpenHistory, openHexViewerFile } from './hexViewer';
import { t } from './i18n';
import { buildPreviewReport } from './previewRun';
import { runDoctor, runDoctorPerSource, DoctorFinding, DoctorInput } from './doctor';
import { createZipArchive, extractZipArchive } from './archiveUtils';
import { DIALOG_SCOPE, coerceDefaultUri, initDialogMemory, showOpenDialogWithMemory, showSaveDialogWithMemory, taskDialogScope } from './dialogMemory';
import { collectVariableCompletions, referencePrefixAt, type VariableCompletionDetail } from './variableCompletions';

/**
 * 자동완성 항목의 `detail` 문구. **i18n 경계다.**
 *
 * `variableCompletions` 는 `previewRun` · `doctor` 와 같이 `vscode` 를 import 하지
 * 않는 순수 모듈이라 `t()` 를 쓸 수 없다(`t` 는 `vscode.env.language` 를 본다).
 * 그래서 그쪽은 종류만 돌려주고 문구는 여기서 만든다 — 그러지 않으면 한국어
 * 사용자의 자동완성 위젯에 영어가 그대로 보인다.
 *
 * 타입 이름(`fileDialog` 등)은 사용자가 `actions.json` 에 적는 식별자 그대로이므로
 * 번역하지 않는다 (CLAUDE.md 의 "짧은 영어 식별자" 예외).
 */
export function describeVariableCompletion(detail: VariableCompletionDetail): string {
    switch (detail.kind) {
        case 'task':
            return detail.taskType
                ? t(`${detail.taskType} 태스크`, `${detail.taskType} task`)
                : t('태스크', 'task');
        case 'builtin':
            return detail.ref === 'workspaceFolder'
                ? t('워크스페이스 폴더 경로', 'workspace folder path')
                : t('TaskHub 설치 경로', 'TaskHub install path');
        case 'result':
            return t(`${detail.taskType} 결과`, `${detail.taskType} result`);
        case 'capture':
            return t(`'${detail.taskId}' 에서 캡처한 값`, `captured from '${detail.taskId}'`);
    }
}

// Compile the actions JSON-schema validator once and reuse it. Re-compiling on
// every load path (activation + every view refresh + every executeAction) was
// a noticeable chunk of the activation cost.
let cachedActionsValidator: import('ajv').ValidateFunction<ActionItem[]> | undefined;
export function getActionsValidator(): import('ajv').ValidateFunction<ActionItem[]> {
    if (!cachedActionsValidator) {
        const ajv = new Ajv({ allErrors: true });
        cachedActionsValidator = ajv.compile<ActionItem[]>(actionSchema);
    }
    return cachedActionsValidator;
}

/**
 * Error carrying the file that actually failed to load.
 *
 * The Actions view renders a "failed to load" row whose click target used to
 * be the generic `taskhub.editActions` command — which re-asks which
 * workspace folder to edit, so in a multi-root setup it could open a
 * perfectly healthy file while the broken one stayed hidden. Attaching the
 * path lets the row open the offending file directly.
 */
export interface ActionsLoadError extends Error {
    filePath?: string;
}

export function getActionsLoadErrorPath(error: unknown): string | undefined {
    const filePath = (error as ActionsLoadError | undefined)?.filePath;
    return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

function actionsLoadError(filePath: string, message: string): ActionsLoadError {
    const error = new Error(message) as ActionsLoadError;
    error.filePath = filePath;
    return error;
}

function loadAndValidateActions(filePath: string, options?: { sourceLabel?: string }): ActionItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const validate = getActionsValidator();
    let fileContent: string;
    try { fileContent = fs.readFileSync(filePath, 'utf-8'); } catch (e: any) { throw actionsLoadError(filePath, `Error reading file ${filePath}: ${e.message}`); }
    let parsedJson: any;
    try { parsedJson = JSON.parse(fileContent); } catch (e: any) { throw actionsLoadError(filePath, `Error parsing JSON in ${path.basename(filePath)}: ${e.message}`); }
    if (validate(parsedJson)) { const sourceLabel = options?.sourceLabel ?? filePath; performAdditionalActionValidation(parsedJson, { sourceLabel, filePath }); return parsedJson; } else { const errors = validate.errors?.map(error => `  - path: '${error.instancePath}' - message: ${error.message}`).join('\n'); throw actionsLoadError(filePath, `Validation failed for ${path.basename(filePath)}:\n${errors}`); }
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
        throw actionsLoadError(
            context.filePath,
            `Additional validation failed for ${context.sourceLabel}:\n${uniqueIssues.map(issue => `  - ${issue}`).join('\n')}`
        );
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
    /** The target folder's own array — mutated in place, then written back. */
    workspaceActions: ActionItem[];
    /**
     * Every *other* live source (bundled examples when shown, the selected
     * preset, other workspace folders). Only their ids matter to the wizard:
     * a new action must not collide with them.
     */
    otherSources: ActionSource[];
    workspaceActionsPath: string;
    workspaceFolder: vscode.WorkspaceFolder;
}

interface TaskExecutionSetup {
    vsCodeTask: vscode.Task;
    displayCommand: string;
    actionKey: string;
    cwd: string;
}

export interface GroupedTaskPresentationOptionsExtra {
    /** Task id used to split the shared-terminal group when isolating parallel tasks. */
    taskId?: string;
    /**
     * If true, the action this task belongs to contains at least one
     * `parallel: true` task; the executor isolates terminal groups
     * per-task so concurrent streamed builds don't interleave in a
     * single VS Code terminal. Sequential actions keep the historical
     * shared-terminal grouping for backward compatibility.
     */
    isParallel?: boolean;
}

export function createGroupedTaskPresentationOptions(
    actionKey: string,
    revealSetting?: 'always' | 'silent' | 'never',
    extra?: GroupedTaskPresentationOptionsExtra
): GroupableTaskPresentationOptions {
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
    const splitGroup =
        extra?.isParallel === true &&
        typeof extra.taskId === 'string' &&
        extra.taskId.length > 0;
    const group = splitGroup ? `${actionKey}:${extra!.taskId}` : actionKey;
    return {
        reveal: revealKind,
        panel: vscode.TaskPanelKind.Shared,
        showReuseMessage: true,
        clear: false,
        group
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

export function mergeActions(
    existing: ActionItem[],
    preset: ActionItem[],
    strategy: 'keep-existing' | 'use-preset' | 'keep-both'
): ActionItem[] {
    const collectIds = (items: ActionItem[], target: Set<string>) => {
        for (const item of items) {
            if (item.id) {
                target.add(item.id);
            }
            if (item.children) {
                collectIds(item.children, target);
            }
        }
    };

    const existingIds = new Set<string>();
    collectIds(existing, existingIds);

    if (strategy === 'keep-both') {
        // Drop preset items whose IDs conflict with existing to prevent validation failures.
        const filteredPreset = filterConflictingItems(preset, existingIds);
        return [...existing, ...filteredPreset];
    }

    if (strategy === 'keep-existing') {
        const filteredPreset = filterConflictingItems(preset, existingIds);
        return [...existing, ...filteredPreset];
    }

    // strategy === 'use-preset' — preset wins on conflicts, so drop conflicting items from existing.
    const presetIds = new Set<string>();
    collectIds(preset, presetIds);
    const filteredExisting = filterConflictingItems(existing, presetIds);
    return [...preset, ...filteredExisting];
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

// Cached result of the last loadAllActions() call. Invalidated by
// invalidateActionsCache() whenever workspace/preset/config changes fire.
let cachedAllActions: ActionItem[] | undefined;

export function invalidateActionsCache(): void {
    cachedAllActions = undefined;
}

// Dynamic command registrations keyed by action id. Each entry exposes the
// action as `taskhub.runAction.<encoded id>` so users can bind a key to it
// from VS Code's Keyboard Shortcuts UI. Mutated only by `syncActionCommands`.
const actionCommandRegistrations = new Map<string, vscode.Disposable>();

// Encodes an action id into the suffix of its `taskhub.runAction.<...>`
// command. The mapping is *bijective*: distinct ids always produce distinct
// command ids. This matters because action ids may legally contain spaces,
// slashes, colons, and Unicode (the schema only requires `string`), and a
// lossy sanitizer (e.g. `[^A-Za-z0-9_.-]/g → _`) would silently collapse
// `a/b` and `a:b` onto the same command — letting "Assign Shortcut" run the
// wrong action when both exist.
//
// Strategy: keep the safe alphabet `[A-Za-z0-9_.-]` (which is also what VS
// Code's Keyboard Shortcuts UI displays cleanly), and percent-encode every
// other byte of the id's UTF-8 representation as `%HH` (uppercase hex). `%`
// itself is encoded too, so the scheme is unambiguously reversible.
//
// For the common case of dotted/underscore/hyphen ids (e.g. `fw.build`,
// `defaultButton.showEnv`) this leaves the suffix untouched, so users see
// readable command ids in keybindings.json and the search box.
export function buildActionCommandId(actionId: string): string {
    const safe = /[A-Za-z0-9_.-]/;
    let suffix = '';
    const bytes = Buffer.from(actionId, 'utf-8');
    for (const b of bytes) {
        const ch = String.fromCharCode(b);
        if (b < 128 && safe.test(ch)) {
            suffix += ch;
        } else {
            suffix += '%' + b.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return `taskhub.runAction.${suffix}`;
}

// Diff-syncs `actionCommandRegistrations` against the current `actions.json`
// tree. Called from every site that already invalidates the actions cache.
// Failure mode: if `loadAllActions` throws (e.g. mid-edit save with invalid
// JSON) we deliberately leave existing registrations untouched so previously
// bound user keybindings keep working until the file becomes valid again.
export function syncActionCommands(context: vscode.ExtensionContext): void {
    let allActions: ActionItem[];
    try {
        allActions = loadAllActions(context);
    } catch {
        return;
    }
    syncActionCommandsFromActions(allActions);
}

// Test seam: same diff-sync logic without the `loadAllActions` (and therefore
// without the workspace + media JSON I/O), so unit tests can exercise the
// register/dispose path against a literal `ActionItem[]` instead of staging
// real workspace folders. Production code paths go through the wrapper above.
//
// `registry` is parameterized so test suites can pass their own Map and avoid
// stomping on the activated extension's registrations (which live in the
// default module-level map). Default callers always use the module map.
export function syncActionCommandsFromActions(
    allActions: ActionItem[],
    registry: Map<string, vscode.Disposable> = actionCommandRegistrations
): void {
    const desired = new Map<string, string>(); // command id -> action id
    traverseActionItems(allActions, (item) => {
        if (!item.id || !item.action) { return; }
        const commandId = buildActionCommandId(item.id);
        // Action ids are already guaranteed globally unique by
        // `validateUniqueActionIdsAcrossSources`, and `buildActionCommandId`
        // is bijective, so we should never see a duplicate command id here.
        // The `set` call is therefore safe; no skip / warning path needed.
        desired.set(commandId, item.id);
    });

    // Dispose registrations whose command id is no longer desired.
    for (const [commandId, disposable] of registry) {
        if (!desired.has(commandId)) {
            disposable.dispose();
            registry.delete(commandId);
        }
    }
    // Register any newly desired command ids.
    for (const [commandId, actionId] of desired) {
        if (registry.has(commandId)) { continue; }
        const disposable = vscode.commands.registerCommand(commandId, () =>
            vscode.commands.executeCommand('taskhub.executeActionById', { id: actionId })
        );
        registry.set(commandId, disposable);
    }
}

export function disposeAllActionCommands(): void {
    for (const disposable of actionCommandRegistrations.values()) {
        disposable.dispose();
    }
    actionCommandRegistrations.clear();
}

// Pure data shape for `taskhub.runAnyAction`'s QuickPick. Kept separate from
// `vscode.QuickPickItem` so the build/MRU helpers can be unit-tested without a
// running VS Code host.
export interface RunAnyActionPick {
    actionId: string;
    title: string;
    folderPath: string; // breadcrumb without the leaf title, joined by ' / '
    recent: boolean;    // true if entry came from the MRU section
}

// Pure description of one QuickPick row in the palette. The handler converts
// `kind: 'separator'` to `vscode.QuickPickItemKind.Separator` and the rest to
// regular items; keeping the structure pure lets us pin separator suppression
// (recentLimit=0 ⇒ no leading heading) without a running VS Code host.
export interface RunAnyPaletteItem {
    kind: 'separator' | 'pick';
    label: string;
    description?: string;
    /** Second line — carries the last-run badge on "Recently used" rows. */
    detail?: string;
    actionId?: string;             // present only when kind === 'pick'
    section: 'recent' | 'rest';
}

/**
 * Orphaned `globalState` key from the palette's own MRU list, which was
 * replaced by History-derived recency (see `deriveRecentActionRuns`). The
 * old list was global (leaking action ids across projects) and only ever
 * written when the user picked *from the palette*, so it disagreed with
 * every other way of running an action. Activation clears the key once so
 * the stale array doesn't sit in global storage forever.
 */
export const RUN_ANY_ACTION_MRU_KEY = 'taskhub.runAnyAction.mru';
// Default for `taskhub.runAnyAction.recentLimit`. The setting (1–20) overrides
// this at runtime; the constant is also the cap upper bound used by tests and
// by `updateRunAnyActionMru` callers that don't pass an explicit max.
export const RUN_ANY_ACTION_MRU_DEFAULT_LIMIT = 5;
export const RUN_ANY_ACTION_MRU_MAX_LIMIT = 20;

// Flatten the action tree into pick entries, splitting them into the recently
// used section (MRU id order) and the remainder (tree order). MRU ids that no
// longer resolve to a runnable action are dropped silently — surfacing a stale
// entry would let a user "execute" something that doesn't exist anymore.
//
// Folder/separator items have no `action`, so they are skipped: the palette is
// for *running* things, not navigating the tree.
//
// `recentLimit` caps the recent section *after* stale filtering. The order
// matters: filtering before slicing keeps the user's last N runnable actions
// visible even when storage has accumulated stale ids at the front (e.g. user
// deleted several actions). Slicing first would let a head full of stale ids
// crowd the valid recent ones out of the cap entirely. `recentLimit <= 0`
// disables the section.
export function buildRunAnyActionPicks(
    actions: ActionItem[],
    mru: readonly string[],
    recentLimit: number = RUN_ANY_ACTION_MRU_DEFAULT_LIMIT
): { recent: RunAnyActionPick[]; rest: RunAnyActionPick[] } {
    const all = new Map<string, RunAnyActionPick>();
    traverseActionItems(actions, (item, pathParts) => {
        if (!item.id || !item.action) { return; }
        // pathParts ends with the leaf title; the folder path is the prefix.
        const folderPath = pathParts.slice(0, -1).join(' / ');
        all.set(item.id, {
            actionId: item.id,
            title: item.title || item.id,
            folderPath,
            recent: false
        });
    });

    const recent: RunAnyActionPick[] = [];
    const seen = new Set<string>();
    if (recentLimit > 0) {
        for (const id of mru) {
            if (recent.length >= recentLimit) { break; }
            if (seen.has(id)) { continue; }
            const pick = all.get(id);
            if (!pick) { continue; }
            seen.add(id);
            recent.push({ ...pick, recent: true });
        }
    }

    const rest: RunAnyActionPick[] = [];
    for (const [id, pick] of all) {
        if (seen.has(id)) { continue; }
        rest.push(pick);
    }

    return { recent, rest };
}

// What the palette command should do next, based on a load attempt + the
// History-derived recent ids + the current `recentLimit` setting. Splitting
// this from the handler lets us pin the broken-actions.json path (load throws
// → user-facing error, no palette opens) without spinning up VS Code's
// QuickPick or workspace I/O.
export type RunAnyActionOutcome =
    | { kind: 'load-error'; errorMessage: string }
    | { kind: 'empty' }
    | { kind: 'show-palette'; items: RunAnyPaletteItem[]; limit: number; recentIds: string[] };

// Compute the palette outcome. Pure (no VS Code calls) — the handler converts
// the outcome into UI: `load-error` → showErrorMessage + log, `empty` →
// showInformationMessage, `show-palette` → showQuickPick. `recentIds` is
// returned alongside the items so callers see the already filtered+capped
// list rather than the raw recency input.
//
// `recentDetails` maps action id → last-run badge ("14:30 · 1.2s"). Passing it
// is optional so the pure tests can exercise ordering without a clock; the
// handler always supplies it from the same History entries that produced
// `recentIds`.
export function planRunAnyAction(
    loadActions: () => ActionItem[],
    recentActionIds: readonly string[],
    rawLimitSetting: number | undefined,
    labels: { recent: string; rest: string },
    recentDetails?: ReadonlyMap<string, string>
): RunAnyActionOutcome {
    let allActions: ActionItem[];
    try {
        allActions = loadActions();
    } catch (error: any) {
        // Broken actions.json (JSON parse / schema validation) bubbles up as
        // an Error from `loadAndValidateActions`. Surface its message so the
        // user knows which file failed and why — empty palettes are worse.
        return { kind: 'load-error', errorMessage: error?.message ?? String(error) };
    }

    // Defensive clamp: settings.json could be hand-edited past the schema
    // bounds (0–20). NaN / undefined fall back to the default.
    const rawLimit = rawLimitSetting ?? RUN_ANY_ACTION_MRU_DEFAULT_LIMIT;
    const limit = Math.max(0, Math.min(
        RUN_ANY_ACTION_MRU_MAX_LIMIT,
        Number.isFinite(rawLimit) ? Math.floor(rawLimit) : RUN_ANY_ACTION_MRU_DEFAULT_LIMIT
    ));

    const { recent, rest } = buildRunAnyActionPicks(allActions, recentActionIds, limit);
    if (recent.length === 0 && rest.length === 0) {
        return { kind: 'empty' };
    }

    const items = buildRunAnyActionPaletteItems(recent, rest, labels, recentDetails);
    const recentIds = recent.map(p => p.actionId);
    return { kind: 'show-palette', items, limit, recentIds };
}

// Assemble the ordered palette rows from the recent/rest split. The "All
// actions" separator is intentionally suppressed when `recent` is empty: with
// no Recently used section above, a leading separator would render as a
// heading with nothing to disambiguate from — and contradict the docs claim
// that `recentLimit=0` collapses the palette to a single flat list.
export function buildRunAnyActionPaletteItems(
    recent: readonly RunAnyActionPick[],
    rest: readonly RunAnyActionPick[],
    labels: { recent: string; rest: string },
    recentDetails?: ReadonlyMap<string, string>
): RunAnyPaletteItem[] {
    const items: RunAnyPaletteItem[] = [];
    if (recent.length > 0) {
        items.push({ kind: 'separator', label: labels.recent, section: 'recent' });
        for (const pick of recent) {
            items.push({
                kind: 'pick',
                label: pick.title,
                description: pick.folderPath || undefined,
                // The badge goes on `detail` rather than into `description`
                // so that `matchOnDescription` keeps matching folder paths
                // only — typing "3" shouldn't hit every action run 3분 전.
                detail: recentDetails?.get(pick.actionId),
                actionId: pick.actionId,
                section: 'recent'
            });
        }
    }
    if (rest.length > 0) {
        if (recent.length > 0) {
            items.push({ kind: 'separator', label: labels.rest, section: 'rest' });
        }
        for (const pick of rest) {
            items.push({
                kind: 'pick',
                label: pick.title,
                description: pick.folderPath || undefined,
                actionId: pick.actionId,
                section: 'rest'
            });
        }
    }
    return items;
}

// Combines the three steps every actions.json change site needs: drop the
// cache, re-sync dynamic command registrations, refresh the tree.
function refreshActionsAndCommands(context: vscode.ExtensionContext, mainViewProvider: MainViewProvider): void {
    invalidateActionsCache();
    syncActionCommands(context);
    mainViewProvider.refresh();
}

function loadAllActions(context: vscode.ExtensionContext): ActionItem[] {
    if (cachedAllActions) {
        return cachedAllActions;
    }
    const result = loadAllActionsUncached(context);
    cachedAllActions = result;
    return result;
}

export type BuiltinActionsMode = 'auto' | 'always' | 'never';

/**
 * Whether the extension's bundled example actions (`media/actions.json`,
 * the `defaultButton.*` entries) join the merged list.
 *
 * Historically they were merged unconditionally, so every project — however
 * complete its own `actions.json` — carried TaskHub's demo buttons in the
 * middle of its real build/flash actions, with no way to turn them off.
 *
 * 0.6.14 made `auto` inject them while the project had nothing of its own,
 * on the theory that they double as onboarding. 0.6.15 then added the
 * `viewsWelcome` CTA — which VS Code only renders when the tree yields
 * *nothing*. The two collided: in exactly the empty-project state where the
 * CTA earns its keep, the injected examples kept the tree non-empty and
 * suppressed it. Since the CTA itself offers a *Browse Examples* button,
 * the examples lose nothing by staying out of the list, and the user gets
 * an actionable next step instead of two demo buttons.
 *
 * So `auto` no longer injects. It still differs from `never`: `auto` shows
 * the *Browse Examples* button in the CTA (see `viewsWelcome` in
 * package.json), `never` hides even that. `always` keeps the pre-0.6.14
 * behaviour for anyone who actually used the demo buttons.
 *
 * The decision therefore depends on the mode alone. An earlier signature
 * also took the other sources (`hasWorkspaceActions` / `hasPresetActions`)
 * because `auto` used to consult them; it was kept "in case a future mode
 * needs it again", which only signalled to readers that those inputs still
 * mattered — and made the caller compute them for nothing. Removed; add it
 * back with a real use if one appears.
 */
export function shouldIncludeBuiltinActions(mode: BuiltinActionsMode): boolean {
    return mode === 'always';
}

function getBuiltinActionsMode(): BuiltinActionsMode {
    const raw = vscode.workspace.getConfiguration('taskhub').get<string>('builtinActions', 'auto');
    return raw === 'always' || raw === 'never' ? raw : 'auto';
}

/** One actions.json source that contributes to the merged list. */
interface ActionSource {
    sourceLabel: string;
    actions: ActionItem[];
    /** Only set for workspace-folder sources. */
    workspaceFolderPath?: string;
}

/**
 * Everything that ends up in the merged action list, split by origin.
 *
 * This is the **single definition of "what is actually live"**. Before it
 * existed, the tree loader and the creation wizard each answered that
 * question their own way and disagreed: the wizard always read the bundled
 * examples (even when `taskhub.builtinActions` hid them, so their ids stayed
 * reserved for no reason) and never looked at the selected preset or at the
 * *other* workspace folders — so it would happily mint an id that a preset
 * already used. Nothing failed loudly, because cross-source duplicates are
 * only a warning; the new action simply got shadowed by, or shadowed, the
 * other one, and `taskhub.runAction.<id>` could fire the wrong action.
 */
interface EffectiveActionSources {
    /** Empty when `taskhub.builtinActions` keeps the examples out. */
    bundled: ActionSource;
    /** Absent when no preset is selected, or the selected one failed to load. */
    preset?: ActionSource;
    /** One per workspace folder, in workspace order. */
    workspaces: (ActionSource & { workspaceFolderPath: string })[];
}

/**
 * Resolve the sources above. Ordered lowest-priority first (bundled →
 * preset → workspace), matching how `loadAllActionsUncached` merges them.
 *
 * Throws whatever `loadAndValidateActions` throws for a *workspace* file —
 * a broken `.vscode/actions.json` must surface, and both callers want that.
 * A broken preset or bundled file only warns: neither is the user's to fix
 * from here, and losing them shouldn't block the workspace's own actions.
 */
function collectEffectiveActionSources(context: vscode.ExtensionContext): EffectiveActionSources {
    const extensionLabel = 'extension media/actions.json';

    // Load selected preset from settings
    const presetId = getSelectedPresetId();
    let preset: ActionSource | undefined;

    if (presetId) {
        const presets = discoverPresets(context);
        const found = presets.find(p => p.id === presetId || p.name === presetId);

        if (found) {
            try {
                const sourceLabel = `preset: ${found.name}`;
                preset = {
                    sourceLabel,
                    actions: loadAndValidateActions(found.filePath, { sourceLabel }),
                };
            } catch (error: any) {
                outputChannel.appendLine(`[Preset Warning] Failed to load preset '${presetId}': ${error.message}`);
            }
        } else {
            outputChannel.appendLine(`[Preset Warning] Preset '${presetId}' not found. Available presets: ${presets.map(p => p.id).join(', ')}`);
        }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const workspaces = workspaceFolders.map(folder => {
        const workspaceJsonPath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
        const sourceLabel = `${folder.name}:.vscode/actions.json`;
        return {
            sourceLabel,
            actions: loadAndValidateActions(workspaceJsonPath, { sourceLabel }),
            workspaceFolderPath: folder.uri.fsPath,
        };
    });

    // Bundled examples are read only when they will actually be shown: an
    // excluded source must not contribute id-collision errors either (a user
    // action named `defaultButton.showEnv` is their business once the demo
    // buttons are hidden).
    const mediaJsonPath = path.join(context.extensionPath, 'media', 'actions.json');
    let bundledActions: ActionItem[] = [];
    if (shouldIncludeBuiltinActions(getBuiltinActionsMode())) {
        try {
            bundledActions = loadAndValidateActions(mediaJsonPath, { sourceLabel: extensionLabel });
        } catch (error: any) {
            outputChannel.appendLine(`[Builtin Warning] Failed to load bundled examples: ${error.message}`);
        }
    }

    return { bundled: { sourceLabel: extensionLabel, actions: bundledActions }, preset, workspaces };
}

/** Every source in merge order, dropping the empty ones. */
function orderedActionSources(sources: EffectiveActionSources): ActionSource[] {
    return [sources.bundled, ...(sources.preset ? [sources.preset] : []), ...sources.workspaces]
        .filter(source => source.actions.length > 0);
}

/**
 * 워크스페이스 폴더들의 액션을 병합하면서 **각 액션이 어느 폴더 것인지도 함께**
 * 정한다. 액션과 출처를 한 번에 확정하는 것이 이 함수의 존재 이유다.
 *
 * **둘을 나누면 반드시 어긋나고, 실제로 어긋나 있었다.** 병합은
 * `mergeActions(ws, merged, 'keep-existing')` 로 **뒤쪽** 폴더를 택하는데
 * 매핑은 역순 덮어쓰기로 **앞쪽** 폴더를 택했다. 같은 id 를 두 폴더가 정의하면
 * B 폴더의 명령이 A 폴더의 cwd 와 `${workspaceFolder}` 로 돌았고, 중복 id 는
 * 경고만 찍고 통과하므로(`validateUniqueActionIdsAcrossSources`) 아무도 막지 않았다.
 *
 * 승자 규칙은 병합 쪽을 그대로 따른다: **같은 id 를 마지막으로 정의한 폴더.**
 * 트리에 보이고 실제로 실행되는 액션이 무엇인지는 바꾸지 않고, 어긋나 있던
 * 폴더 매핑만 그쪽에 맞춘 것이다.
 *
 * 모듈 전역(`actionWorkspaceFolderMap`)을 건드리지 않고 결과만 돌려주므로
 * 단위 테스트가 두 승자의 일치를 직접 확인할 수 있다.
 */
export function resolveWorkspaceActions(
    base: ActionItem[],
    workspaceSources: { actions: ActionItem[]; workspaceFolderPath: string | undefined }[]
): { merged: ActionItem[]; folderById: Map<string, string | undefined> } {
    let merged = base;
    const folderById = new Map<string, string | undefined>();

    for (const wsSource of workspaceSources) {
        if (wsSource.actions.length === 0) { continue; }
        merged = mergeActions(wsSource.actions, merged, 'keep-existing');
        traverseActionItems(wsSource.actions, (item) => {
            if (item.id) {
                folderById.set(item.id, wsSource.workspaceFolderPath);
            }
        });
    }

    return { merged, folderById };
}

function loadAllActionsUncached(context: vscode.ExtensionContext): ActionItem[] {
    const effective = collectEffectiveActionSources(context);
    const extensionActions = effective.bundled.actions;
    const presetActions = effective.preset?.actions ?? [];

    // Merge with priority: workspace > preset > extension
    let mergedActions = extensionActions;

    // Apply preset (if any)
    if (presetActions.length > 0) {
        mergedActions = mergeActions(presetActions, mergedActions, 'keep-existing');
    }

    // Apply workspace actions (highest priority).
    const resolved = resolveWorkspaceActions(mergedActions, effective.workspaces);
    mergedActions = resolved.merged;

    actionWorkspaceFolderMap.clear();
    for (const [id, folderPath] of resolved.folderById) {
        actionWorkspaceFolderMap.set(id, folderPath);
    }

    const sources = orderedActionSources(effective);
    if (sources.length > 1) {
        validateUniqueActionIdsAcrossSources(sources.map(({ sourceLabel, actions }) => ({ sourceLabel, actions })));
    }

    return mergedActions;
}

/**
 * Gather every actions.json source TaskHub would normally merge (bundled,
 * selected preset, every workspace folder) so {@link runDoctor} can lint
 * them without going through {@link loadAllActions} — the latter throws on
 * the first schema violation, which is the very case Doctor exists to
 * surface. Missing files are skipped silently.
 */
function collectDoctorInputs(context: vscode.ExtensionContext): DoctorInput[] {
    const inputs: DoctorInput[] = [];
    const workspaceRoots = getWorkspaceRoots();

    const tryRead = (filePath: string): string | undefined => {
        if (!fs.existsSync(filePath)) {
            return undefined;
        }
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch (e: any) {
            outputChannel.appendLine(`[Doctor] Failed to read ${filePath}: ${e?.message ?? e}`);
            return undefined;
        }
    };

    const bundledPath = path.join(context.extensionPath, 'media', 'actions.json');
    const bundledText = tryRead(bundledPath);
    if (bundledText !== undefined) {
        inputs.push({
            filePath: bundledPath,
            sourceLabel: 'extension media/actions.json',
            rawText: bundledText,
            workspaceRoots,
            extensionPath: context.extensionPath,
        });
    }

    const presetId = getSelectedPresetId();
    if (presetId) {
        const preset = discoverPresets(context).find(p => p.id === presetId || p.name === presetId);
        if (preset) {
            const presetText = tryRead(preset.filePath);
            if (presetText !== undefined) {
                inputs.push({
                    filePath: preset.filePath,
                    sourceLabel: `preset: ${preset.name}`,
                    rawText: presetText,
                    workspaceRoots,
                    extensionPath: context.extensionPath,
                });
            }
        }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
        const wsActionsPath = path.join(folder.uri.fsPath, '.vscode', 'actions.json');
        const text = tryRead(wsActionsPath);
        if (text === undefined) {
            continue;
        }
        inputs.push({
            filePath: wsActionsPath,
            sourceLabel: `${folder.name}:.vscode/actions.json`,
            rawText: text,
            workspaceFolder: folder.uri.fsPath,
            workspaceRoots,
            extensionPath: context.extensionPath,
        });
    }

    return inputs;
}

function publishDoctorDiagnostics(findings: DoctorFinding[]): void {
    const collection = getDoctorDiagnosticCollection();
    collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const f of findings) {
        const start = new vscode.Position(Math.max(0, f.range.startLine - 1), Math.max(0, f.range.startColumn - 1));
        const end = new vscode.Position(Math.max(0, f.range.endLine - 1), Math.max(0, f.range.endColumn - 1));
        const severity = f.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : (f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
        const diag = new vscode.Diagnostic(new vscode.Range(start, end), t(f.messageKo ?? f.message, f.message), severity);
        diag.code = f.code;
        diag.source = 'TaskHub Doctor';
        const arr = byFile.get(f.filePath) ?? [];
        arr.push(diag);
        byFile.set(f.filePath, arr);
    }
    for (const [filePath, diags] of byFile) {
        collection.set(vscode.Uri.file(filePath), diags);
    }
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

/**
 * Locate an action by id and return its breadcrumb path (folder titles +
 * action title). Used at history-write time so HistoryItem labels can
 * disambiguate `Firmware/Build` from `Bootloader/Build` when the bare
 * title collides. Returns `undefined` when the id is not found anywhere
 * in the tree (caller falls back to the bare action title).
 */
export function findActionPathById(actions: ActionItem[], id: string): string[] | undefined {
    const walk = (items: ActionItem[], breadcrumbs: string[]): string[] | undefined => {
        for (const item of items) {
            const label = item.title || item.id || '(unnamed)';
            const currentParts = [...breadcrumbs, label];
            if (item.id === id) {
                return currentParts;
            }
            if (item.children && item.children.length > 0) {
                const found = walk(item.children, currentParts);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    };
    return walk(actions, []);
}

// Pure utilities (no vscode dependency) live in ./pipelineUtils.
// They are re-exported so that existing callers — including unit tests — can keep
// importing them from './extension' unchanged.
import {
    INTERPOLATED_VALUE_MAX_LENGTH,
    wouldExceedCaptureLimit,
    resolveWithinWorkspace,
    resolveArchiveTaskPath,
    resolveFavoriteFilePath,
    toWorkspaceRelativePath,
    validateLinkScheme,
    validateLinkUrlForSave,
    sanitizeInterpolatedValue,
    interpolatePipelineVariables,
    applyOutputCapture,
    getCommandString,
    getToolCommand,
    interpolateToolValue,
    tokenizeCommandLine,
    mergeCommandAndArgs,
    quotePowerShellArgument,
    quoteWindowsCommandLineArgument,
    buildPowerShellInvocation,
    buildNativeCommandInvocation,
    windowsCommandIsDirectlyLaunchable,
    encodePowerShellScript,
    quotePosixArgument,
    buildPosixCommandLine,
    buildRawPowerShellCommandLine,
    buildRawShellCommandLine,
    selectWindowsRawShell,
    resolvePwshPath,
    rawCommandUsesChainOperators,
    windowsSpawnStrategy,
    buildRawOneShotWindowsScript,
    withPowerShellExitCode,
    interpolateCommandPreservingTokens,
    quoteForCommandTokenizer,
    expandArgTemplate,
    resolvePipelineReference,
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
    extractVariableHeads,
    extractVariableReferences,
    evaluateTaskCondition,
    shouldSkipForSkippedDependencies,
    inferTaskDependencies,
    buildTaskGraph,
    detectGraphCycle,
    validateTaskGraph,
    formatGraphIssue,
    actionUsesParallelTasks,
    withInteractivePromptLock,
    INTERACTIVE_TASK_TYPES,
    TaskScheduler,
} from './pipelineUtils';
import type {
    TaskGraph,
    TaskGraphNode,
    TaskGraphBuildOptions,
    TaskGraphIssue,
    TaskSchedulerOptions,
} from './pipelineUtils';
import {
    applyDiagnosticMatchers,
    type ParsedDiagnostic,
} from './diagnosticMatcher';
export {
    INTERPOLATED_VALUE_MAX_LENGTH,
    wouldExceedCaptureLimit,
    resolveWithinWorkspace,
    resolveArchiveTaskPath,
    toWorkspaceRelativePath,
    sanitizeInterpolatedValue,
    interpolatePipelineVariables,
    applyOutputCapture,
    getCommandString,
    getToolCommand,
    tokenizeCommandLine,
    mergeCommandAndArgs,
    quotePowerShellArgument,
    quoteWindowsCommandLineArgument,
    buildPowerShellInvocation,
    buildNativeCommandInvocation,
    windowsCommandIsDirectlyLaunchable,
    selectWindowsRawShell,
    resolvePwshPath,
    rawCommandUsesChainOperators,
    windowsSpawnStrategy,
    buildRawOneShotWindowsScript,
    withPowerShellExitCode,
    interpolateCommandPreservingTokens,
    quoteForCommandTokenizer,
    expandArgTemplate,
    resolvePipelineReference,
    encodePowerShellScript,
    quotePosixArgument,
    buildPosixCommandLine,
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
    extractVariableHeads,
    interpolateToolValue,
    inferTaskDependencies,
    buildTaskGraph,
    detectGraphCycle,
    validateTaskGraph,
    formatGraphIssue,
    actionUsesParallelTasks,
    TaskScheduler,
};
export type {
    TaskGraph,
    TaskGraphNode,
    TaskGraphBuildOptions,
    TaskGraphIssue,
    TaskSchedulerOptions,
};

function getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

async function openExternalLinkSafely(rawUrl: unknown): Promise<void> {
    const result = validateLinkScheme(rawUrl);
    if (!result.ok) {
        if (result.reason === 'scheme') {
            const blockedScheme = result.scheme;
            vscode.window.showErrorMessage(t(
                `허용되지 않은 URL scheme '${blockedScheme}'. http/https/mailto만 지원합니다.`,
                `URL scheme '${blockedScheme}' is not allowed. Only http/https/mailto are supported.`
            ));
        } else if (result.reason === 'empty') {
            vscode.window.showErrorMessage(t('링크 URL이 비어 있습니다.', 'Link URL is empty.'));
        } else {
            vscode.window.showErrorMessage(t('올바르지 않은 URL 형식입니다.', 'Invalid URL format.'));
        }
        return;
    }
    let uri: vscode.Uri;
    try {
        uri = vscode.Uri.parse(result.url, true);
    } catch {
        vscode.window.showErrorMessage(t('올바르지 않은 URL 형식입니다.', 'Invalid URL format.'));
        return;
    }
    await vscode.env.openExternal(uri);
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

class WizardCancelledError extends Error {
    constructor() {
        super('Action creation cancelled by user.');
    }
}

export interface ActionTemplateDefinition {
    id: string;
    label: string;
    description: string;
    /** Used as the `description` field of the auto-built PipelineAction. */
    defaultDescription: string;
    /**
     * Assembles the task array from already-collected answers. Pure — no
     * VS Code calls — so the emitted JSON shape can be pinned by unit tests
     * without driving the prompt chain.
     */
    buildTasks(inputs: any): any[];
    /**
     * Prompts the user for the *minimum* template-specific inputs only, then
     * hands them to `buildTasks`. Task ids, cwd, revealTerminal, dialog
     * `openLabel`s, and success/fail messages are intentionally not prompted
     * here — they default to safe values and the user can edit them in
     * actions.json afterwards. This mirrors the wizard's "ask for what's
     * essential, default the rest" goal so first-time creation is 3-4
     * prompts instead of 8-10.
     */
    promptForTasks(): Promise<any[]>;
}

/**
 * Upper bound on the steps the multi-step template will collect. The loop
 * ends when the user submits an empty command; the cap is only a guard
 * against an accidental endless prompt chain. Longer pipelines are a
 * job for the JSON editor, not a wizard.
 */
export const MAX_PIPELINE_TEMPLATE_STEPS = 10;

type DestinationPickItem = vscode.QuickPickItem & { folderRef?: ActionItem };

/**
 * 셸에 넘기지 않으면 **의미가 달라지는** 문자들. argv 실행에서는 전부 리터럴
 * 인자가 되므로, 마법사가 `command` 로 저장하기 전에 이것이 들어 있으면
 * 사용자에게 알린다 — 조용히 다르게 동작하는 것이 가장 나쁜 결과다.
 *
 * `$` 는 넣지 않는다. TaskHub 자신의 `${task.value}` 보간이 흔하고, 그것은
 * 셸이 아니라 파이프라인이 처리하므로 argv 에서도 정상 동작한다.
 */
const SHELL_OPERATOR_PATTERN = /(\|\||&&|[|<>;`]|\$\(|(^|\s)>|(^|\s)<)/;

export function commandNeedsShellSyntax(command: string): boolean {
    return SHELL_OPERATOR_PATTERN.test(command);
}

/**
 * Wizard starting points, ordered simplest first.
 *
 * **모든 템플릿은 `command` 타입을 낸다** (0.6.49). 0.6.47 이 `shell` 을 raw
 * 셸 실행으로 바꾸면서, 보간값을 명령 문자열에 끼워 넣는 이 템플릿들이
 * 그대로 명령 주입 통로가 됐다 — `${selectFile.path}` 가 `x; rm -rf ~` 이면
 * 뒤의 명령까지 실행된다. `command` 는 토큰마다 인용해 argv 로 실행하므로
 * 보간값이 어떤 문자를 담고 있어도 인자 하나로 남는다.
 *
 * 셸 연산자가 필요하면 사용자가 actions.json 에서 `shell` 로 바꾸면 된다.
 * 마법사가 기본으로 그것을 만들지는 않는다 — 안전한 쪽이 기본값이어야 한다.
 *
 * Every template here produces a *structurally different* action. Variants
 * that would differ only by the command string (a "Build" template next to
 * a "Test" template, both emitting one `shell` task) are deliberately absent
 * — they would pad the picker without teaching anything, and the command
 * placeholder already carries those examples. What the list is really for is
 * exposing the interactive task types (`fileDialog` / `folderDialog` /
 * `inputBox` / `quickPick`) and multi-task pipelines, which a first-time
 * user has no other way to discover short of reading the docs.
 */
export const ACTION_TEMPLATES: ActionTemplateDefinition[] = [
    {
        id: 'single-shell',
        label: t('단일 쉘 명령어', 'Single Shell Command'),
        description: t('하나의 쉘 명령어를 실행하고 공유 터미널에 출력을 스트리밍합니다.', 'Run one shell command and stream its output to the shared terminal.'),
        defaultDescription: t('쉘 명령어를 실행합니다.', 'Run a shell command.'),
        buildTasks({ command }: { command: string }) {
            return [{
                id: 'run',
                type: 'command' as const,
                command
            }];
        },
        async promptForTasks() {
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                placeHolder: 'e.g. npm run build, make flash, ctest'
            });
            return this.buildTasks({ command });
        }
    },
    {
        id: 'file-dialog-shell',
        label: t('파일 선택 + 쉘', 'File Picker + Shell'),
        description: t('사용자에게 파일을 선택하게 한 후, 선택된 경로를 받는 쉘 명령어를 실행합니다.', 'Ask the user to pick a file, then run a shell command that receives the selected path.'),
        defaultDescription: t('파일을 선택하고 해당 파일로 명령어를 실행합니다.', 'Pick a file and run a command with the selection.'),
        buildTasks({ command }: { command: string }) {
            return [
                {
                    id: 'selectFile',
                    type: 'fileDialog' as const,
                    options: {
                        openLabel: t('파일 선택', 'Select file')
                    }
                },
                {
                    id: 'run',
                    type: 'command' as const,
                    command
                }
            ];
        },
        async promptForTasks() {
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                value: 'echo Selected file: ${selectFile.path}',
                placeHolder: t('선택한 파일을 참조하려면 ${selectFile.path}를 사용하세요', 'Use ${selectFile.path} to reference the selected file')
            });
            return this.buildTasks({ command });
        }
    },
    {
        id: 'folder-dialog-shell',
        label: t('폴더 선택 + 쉘', 'Folder Picker + Shell'),
        description: t('사용자에게 폴더를 선택하게 한 후, 선택된 경로를 받는 쉘 명령어를 실행합니다.', 'Ask the user to pick a folder, then run a shell command that receives the selected path.'),
        defaultDescription: t('폴더를 선택하고 해당 폴더로 명령어를 실행합니다.', 'Pick a folder and run a command with the selection.'),
        buildTasks({ command }: { command: string }) {
            return [
                {
                    id: 'selectFolder',
                    type: 'folderDialog' as const,
                    options: {
                        openLabel: t('폴더 선택', 'Select folder')
                    }
                },
                {
                    id: 'run',
                    type: 'command' as const,
                    command
                }
            ];
        },
        async promptForTasks() {
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                value: 'echo Selected folder: ${selectFolder.path}',
                placeHolder: t('선택한 폴더를 참조하려면 ${selectFolder.path}를 사용하세요', 'Use ${selectFolder.path} to reference the selected folder')
            });
            return this.buildTasks({ command });
        }
    },
    {
        id: 'input-box-shell',
        label: t('값 입력 + 쉘', 'Text Input + Shell'),
        description: t('실행 전에 값을 입력받아 명령어에 끼워 넣습니다 (예: 버전 태그, 대상 이름).', 'Ask for a value before running and splice it into the command (e.g. a version tag or target name).'),
        defaultDescription: t('입력받은 값으로 명령어를 실행합니다.', 'Run a command with a value entered at run time.'),
        buildTasks({ inputPrompt, command }: { inputPrompt: string; command: string }) {
            return [
                {
                    id: 'input',
                    type: 'inputBox' as const,
                    prompt: inputPrompt
                },
                {
                    id: 'run',
                    type: 'command' as const,
                    command
                }
            ];
        },
        async promptForTasks() {
            const inputPrompt = await promptForRequiredInput({
                prompt: t('실행 시 사용자에게 무엇을 물어볼까요?', 'What should the user be asked for at run time?'),
                placeHolder: t('예: 릴리스 태그를 입력하세요', 'e.g. Enter the release tag')
            });
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                value: 'echo ${input.value}',
                placeHolder: t('입력값을 참조하려면 ${input.value}를 사용하세요', 'Use ${input.value} to reference the entered value')
            });
            return this.buildTasks({ inputPrompt, command });
        }
    },
    {
        id: 'quick-pick-shell',
        label: t('선택지 + 쉘', 'Choice List + Shell'),
        description: t('미리 정한 목록에서 하나를 고르게 한 뒤 명령어를 실행합니다 (예: 타겟 보드).', 'Let the user pick from a fixed list, then run a command (e.g. a target board).'),
        defaultDescription: t('선택한 항목으로 명령어를 실행합니다.', 'Run a command with the selected item.'),
        buildTasks({ items, command }: { items: string[]; command: string }) {
            return [
                {
                    id: 'choice',
                    type: 'quickPick' as const,
                    items,
                    placeHolder: t('항목을 선택하세요', 'Select an item')
                },
                {
                    id: 'run',
                    type: 'command' as const,
                    command
                }
            ];
        },
        async promptForTasks() {
            const raw = await promptForRequiredInput({
                prompt: t('선택지를 쉼표로 구분해 입력하세요', 'Enter the choices, separated by commas'),
                placeHolder: 'e.g. stm32f4, stm32f7, nrf52'
            });
            const items = parseTemplateChoiceList(raw);
            if (items.length === 0) {
                throw new Error(t('선택지를 하나 이상 입력해야 합니다.', 'At least one choice is required.'));
            }
            const command = await promptForRequiredInput({
                prompt: t('실행할 쉘 명령어를 입력하세요', 'Enter the shell command to execute'),
                value: 'echo ${choice.value}',
                placeHolder: t('선택한 항목을 참조하려면 ${choice.value}를 사용하세요', 'Use ${choice.value} to reference the selected item')
            });
            return this.buildTasks({ items, command });
        }
    },
    {
        id: 'multi-step-shell',
        label: t('다단계 파이프라인', 'Multi-step Pipeline'),
        description: t('여러 쉘 명령어를 순서대로 실행합니다. 앞 단계가 실패하면 뒤 단계는 실행되지 않습니다.', 'Run several shell commands in order. A failing step stops the ones after it.'),
        defaultDescription: t('여러 단계를 순서대로 실행합니다.', 'Run several steps in order.'),
        buildTasks({ commands }: { commands: string[] }) {
            return commands.map((command, index) => ({
                id: `step${index + 1}`,
                type: 'command' as const,
                command
            }));
        },
        async promptForTasks() {
            const commands: string[] = [];
            // 각 단계에 마지막으로 입력한 값. 뒤로 갔다 다시 오면 이 값이
            // 다시 채워진다 — 되돌아가서 한 글자 고치는 것이 목적인데 빈
            // 칸이 나오면 그 목적이 무너진다.
            const drafts: string[] = [];
            while (commands.length < MAX_PIPELINE_TEMPLATE_STEPS) {
                const step = commands.length + 1;
                try {
                    // Step 1 is required; from step 2 on, an empty submit ends the
                    // chain (Escape still cancels the whole wizard).
                    // 2단계부터는 Back 을 단다 — 1단계에서 뒤로 갈 곳은 없다.
                    const command = step === 1
                        ? await promptForRequiredInput({
                            prompt: t(`${step}단계 명령어를 입력하세요`, `Enter the command for step ${step}`),
                            placeHolder: 'e.g. make clean',
                            value: drafts[step - 1]
                        })
                        : await promptForOptionalInput({
                            prompt: t(`${step}단계 명령어 (비워 두면 완료)`, `Command for step ${step} (leave empty to finish)`),
                            placeHolder: t('비워 두고 Enter를 누르면 여기까지 저장합니다', 'Press Enter on an empty box to stop here'),
                            value: drafts[step - 1],
                            canGoBack: true
                        });
                    if (!command) {
                        break;
                    }
                    drafts[step - 1] = command;
                    commands.push(command);
                } catch (error) {
                    if (!(error instanceof WizardBackError)) { throw error; }
                    // 직전 단계를 다시 연다. `drafts` 는 남겨 두므로 그 값이
                    // 그대로 채워지고, 앞으로 다시 나아갈 때도 유지된다.
                    commands.pop();
                }
            }
            return this.buildTasks({ commands });
        }
    }
];

/**
 * Split the comma-separated answer of the choice-list template into
 * `quickPick` items: trim each entry, drop empties (trailing comma, double
 * comma) and duplicates while keeping the order the user typed.
 */
export function parseTemplateChoiceList(raw: string): string[] {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (!trimmed || seen.has(trimmed)) { continue; }
        seen.add(trimmed);
        items.push(trimmed);
    }
    return items;
}

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

/** 사용자가 마법사에서 **이전 단계로** 돌아갔다. 취소와 구분해야 한다. */
class WizardBackError extends Error {
    constructor() {
        super('Wizard step went back');
        this.name = 'WizardBackError';
    }
}

/**
 * 마법사용 입력 상자.
 *
 * `showInputBox` 대신 `createInputBox` 를 쓴다 — 전자는 **Back 버튼을 달 수
 * 없다**. 10단계까지 받는 다단계 템플릿에서 8단계의 오타를 고치려면 Escape 로
 * 전부 버리고 처음부터 다시 입력해야 했다.
 *
 * 돌아온 단계에는 이전에 입력한 값을 다시 채워 준다(`value`) — 되돌아가서
 * 한 글자만 고치는 것이 목적인데 빈 칸이 나오면 그 목적이 무너진다.
 */
function showWizardInput(options: {
    prompt: string;
    value?: string;
    placeHolder?: string;
    required: boolean;
    canGoBack?: boolean;
}): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
        const input = vscode.window.createInputBox();
        input.prompt = options.prompt;
        input.value = options.value ?? '';
        input.placeholder = options.placeHolder;
        input.ignoreFocusOut = true;
        input.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];

        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) { return; }
            settled = true;
            fn();
            input.dispose();
        };

        input.onDidTriggerButton(button => {
            if (button === vscode.QuickInputButtons.Back) {
                finish(() => reject(new WizardBackError()));
            }
        });
        // 입력이 바뀌면 경고를 지운다. 남겨 두면 고친 뒤에도 빨간 문구가
        // 붙어 있어 아직 잘못된 줄 안다.
        input.onDidChangeValue(() => { input.validationMessage = undefined; });
        input.onDidAccept(() => {
            const trimmed = input.value.trim();
            if (options.required && !trimmed) {
                input.validationMessage = t('값을 입력해야 합니다.', 'Value is required.');
                return;
            }
            finish(() => resolve(trimmed.length > 0 ? trimmed : undefined));
        });
        // Escape 나 포커스 이탈. `finish` 가 이미 돌았다면 무시된다.
        input.onDidHide(() => { finish(() => reject(new WizardCancelledError())); });

        input.show();
    });
}

async function promptForRequiredInput(options: { prompt: string; value?: string; placeHolder?: string; canGoBack?: boolean }): Promise<string> {
    const result = await showWizardInput({ ...options, required: true });
    // `required: true` 면 빈 값으로는 accept 되지 않는다.
    return result ?? '';
}

/**
 * Prompt whose empty submit is a valid "nothing more" answer (returns
 * `undefined`) rather than a validation error. Escape still throws
 * `WizardCancelledError`, so "done" and "cancelled" stay distinguishable —
 * the multi-step template relies on that split to end its chain.
 */
async function promptForOptionalInput(options: { prompt: string; value?: string; placeHolder?: string; canGoBack?: boolean }): Promise<string | undefined> {
    return showWizardInput({ ...options, required: false });
}

/**
 * Derive a valid action id from a human-readable title. The id only needs to
 * match `[A-Za-z0-9._-]+` (the actions.json validator) and be unique within
 * the existing id pool, so we lower-case the title and collapse runs of
 * non-alphanumerics into a single hyphen. On collision we append `-2`,
 * `-3`, … so two actions sharing a title can co-exist. This replaces the
 * old "ask the user for an id first" prompt so the wizard's first user
 * input is the human-meaningful title; the machine id is computed.
 */
export function deriveActionIdFromTitle(title: string, existingIds: Set<string>): string {
    // Unicode letters/digits survive (`\p{L}\p{N}`), so a Korean or accented
    // title yields a meaningful id instead of collapsing to `action`,
    // `action-2`, … — which is what an ASCII-only class produced, leaving
    // every non-Latin project with numbered placeholder ids in actions.json,
    // Doctor messages and `dependsOn` references.
    //
    // Nothing downstream requires ASCII: the schema puts no pattern on `id`,
    // runtime validation only checks uniqueness, and `buildActionCommandId`
    // percent-encodes every non-`[A-Za-z0-9_.-]` byte, so the keybinding
    // command id stays valid (just encoded) for any input.
    const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    const base = slug.length > 0 ? slug : 'action';
    if (!existingIds.has(base)) {
        return base;
    }
    for (let i = 2; i < 10000; i++) {
        const candidate = `${base}-${i}`;
        if (!existingIds.has(candidate)) {
            return candidate;
        }
    }
    return `${base}-${Date.now()}`;
}

/**
 * Ids that are already live anywhere in the merged list, so the wizard can
 * avoid minting a duplicate.
 *
 * "Anywhere" is the point. Until 0.6.32 the wizard only looked at the target
 * folder's own file plus the bundled examples, which was wrong in both
 * directions: it reserved bundled ids even when `taskhub.builtinActions`
 * hides them, and it ignored the selected preset and every *other* workspace
 * folder. A collision with those didn't fail loudly — cross-source
 * duplicates are only a warning in the output channel — it just meant the
 * new action shadowed (or was shadowed by) the other one, and
 * `taskhub.runAction.<id>` could fire whichever the traversal reached first.
 */
export function collectTakenActionIds(sources: readonly { actions: ActionItem[] }[]): Set<string> {
    return collectActionIds(sources.flatMap(source => source.actions));
}

/**
 * The id set the wizard checks against: the target folder's own actions plus
 * every other live source.
 *
 * Both halves matter and they fail differently. A duplicate *inside* the
 * target file is a hard load error the user sees immediately; a duplicate
 * *across* sources is only an output-channel warning, so it slips through
 * and quietly shadows one of the two actions.
 *
 * Split out from the wizard body so the wiring itself is testable — the two
 * arguments are exactly what 0.6.31 and earlier got wrong, and a pure test
 * of `collectTakenActionIds` alone would not notice them being dropped.
 */
export function wizardTakenActionIds(sources: {
    workspaceActions: ActionItem[];
    otherSources: readonly { actions: ActionItem[] }[];
}): Set<string> {
    return collectTakenActionIds([
        { actions: sources.workspaceActions },
        ...sources.otherSources,
    ]);
}

function loadWizardActionSources(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder): WizardActionSources {
    const workspaceActionsPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'actions.json');

    // Same resolver the tree loader uses, so "what already exists" cannot
    // drift between the two views again.
    let effective: EffectiveActionSources;
    try {
        effective = collectEffectiveActionSources(context);
    } catch (error: any) {
        throw new Error(`Could not load ${workspaceActionsPath}: ${error.message}`);
    }

    // The target folder's array is the one the wizard mutates and writes
    // back, so it must be the *same object* the resolver produced — building
    // a second copy would let the two disagree about what is being saved.
    const target = effective.workspaces.find(source => source.workspaceFolderPath === workspaceFolder.uri.fsPath);
    const workspaceActions = target?.actions ?? [];

    return {
        workspaceActions,
        otherSources: orderedActionSources(effective).filter(source => source !== target),
        workspaceActionsPath,
        workspaceFolder,
    };
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

/**
 * Build the destination QuickPick. The "Root" item's description was
 * previously "Add at the top of actions.json", but `insertActionIntoDestination`
 * actually appends to the end of `workspaceActions`. The mismatch is fixed
 * here by describing the *level* (top-level, outside folders) rather than
 * the *position* in the file. When the actions.json has no folders, the
 * picker would show only this single Root item — we skip the prompt
 * entirely in that case so the wizard doesn't make the user click through
 * a one-option menu.
 */
export function buildDestinationPickItems(workspaceActions: ActionItem[]): DestinationPickItem[] {
    return [
        {
            label: t('$(root-folder) 루트 (최상위)', '$(root-folder) Root (top level)'),
            description: t('폴더 밖 최상위에 추가', 'Add at top level (outside folders)')
        },
        ...collectFolderDestinations(workspaceActions)
    ];
}

async function promptForActionDestination(workspaceActions: ActionItem[]): Promise<DestinationPickItem> {
    const destinationPickItems = buildDestinationPickItems(workspaceActions);
    if (destinationPickItems.length === 1) {
        return destinationPickItems[0];
    }
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

/** Max rows the pre-save review lists before collapsing to a count. */
export const WIZARD_REVIEW_LIST_LIMIT = 8;

/**
 * Validate an action id typed into the pre-save review's *Change id* prompt.
 * Returns an error message, or `undefined` when the value is acceptable.
 *
 * Deliberately permissive about the character set — the schema puts no
 * pattern on `id` and `buildActionCommandId` encodes anything — but rejects
 * what actually breaks: emptiness, surrounding/embedded whitespace (ids show
 * up in `dependsOn` lists and log lines where a space is unreadable), and
 * collisions with an id that already exists.
 */
export function validateActionIdInput(value: string, existingIds: Set<string>): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return t('ID를 입력해야 합니다.', 'An id is required.');
    }
    if (/\s/.test(trimmed)) {
        return t('ID에는 공백을 쓸 수 없습니다.', 'An id cannot contain whitespace.');
    }
    if (existingIds.has(trimmed)) {
        return t(`이미 '${trimmed}' ID를 쓰는 액션이 있습니다.`, `An action with the id '${trimmed}' already exists.`);
    }
    return undefined;
}

/**
 * Findings introduced by the pending action, i.e. present in `after` beyond
 * what `before` already had.
 *
 * Doctor lints a whole file, so running it on the prospective content would
 * also surface problems the user's existing actions already had — blaming
 * the new action for them turns the review step into noise. Matching is by
 * (code, message) with multiplicity, not by source range: inserting an
 * action shifts every later line, so ranges of untouched findings change
 * even though the findings themselves did not.
 */
export function diffDoctorFindings(before: DoctorFinding[], after: DoctorFinding[]): DoctorFinding[] {
    const remaining = new Map<string, number>();
    for (const finding of before) {
        const key = `${finding.code}|${finding.message}`;
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const introduced: DoctorFinding[] = [];
    for (const finding of after) {
        const key = `${finding.code}|${finding.message}`;
        const count = remaining.get(key) ?? 0;
        if (count > 0) {
            remaining.set(key, count - 1);
            continue;
        }
        introduced.push(finding);
    }
    return introduced;
}

function describeTaskLine(task: any, index: number): string {
    const id = typeof task?.id === 'string' ? task.id : `#${index + 1}`;
    const type = typeof task?.type === 'string' ? task.type : '?';
    const command = typeof task?.command === 'string'
        ? task.command
        : typeof task?.prompt === 'string'
            ? task.prompt
            : Array.isArray(task?.items)
                ? task.items.join(', ')
                : '';
    const suffix = command ? ` — ${command}` : '';
    return `${index + 1}. ${id} (${type})${suffix}`;
}

function formatFindingLine(finding: DoctorFinding, lang: 'ko' | 'en'): string {
    const message = lang === 'ko' ? (finding.messageKo ?? finding.message) : finding.message;
    const mark = finding.severity === 'error' ? '✗' : finding.severity === 'warning' ? '⚠' : 'ℹ';
    return `${mark} [${finding.code}] ${message}`;
}

function collapseList(lines: string[], limit: number, lang: 'ko' | 'en'): string[] {
    if (lines.length <= limit) { return lines; }
    const shown = lines.slice(0, limit);
    const overflow = lines.length - limit;
    shown.push(lang === 'ko' ? `… 외 ${overflow}개` : `… and ${overflow} more`);
    return shown;
}

/**
 * Body of the pre-save confirmation modal.
 *
 * The wizard used to write straight to disk once the last prompt was
 * answered, which hid two things worth a glance: the **derived action id**
 * (it becomes the `taskhub.runAction.<id>` command name that lands in the
 * user's keybindings.json, and renaming it later breaks those bindings) and
 * any problem the new action introduces. Pure so both are pinned by tests.
 */
export function buildWizardReviewDetail(
    action: ActionItem,
    destinationLabel: string,
    findings: DoctorFinding[],
    lang: 'ko' | 'en' = 'ko'
): string {
    const tasks: any[] = action.action?.tasks ?? [];
    const lines: string[] = [
        lang === 'ko' ? `ID: ${action.id}` : `Id: ${action.id}`,
    ];

    // 0.6.25가 유니코드 id를 허용하면서 이 화면의 전제가 반쯤 깨졌다. 확인
    // 단계의 근거는 "이 값이 keybindings.json에 노출되는 커맨드 이름"인데,
    // `buildActionCommandId`가 non-ASCII를 percent-encoding하므로 한글 id는
    // 여기 보이는 것과 전혀 다른 문자열로 나타난다
    // (`펌웨어-빌드` → `taskhub.runAction.%ED%8E%8C…`).
    // 달라질 때만 한 줄 더 보여 준다 — 대부분의 ASCII id에서는 잡음이다.
    const commandId = buildActionCommandId(String(action.id ?? ''));
    if (commandId !== `taskhub.runAction.${action.id}`) {
        lines.push(lang === 'ko' ? `단축키 커맨드: ${commandId}` : `Keybinding command: ${commandId}`);
    }

    lines.push(
        lang === 'ko' ? `위치: ${destinationLabel}` : `Location: ${destinationLabel}`,
        '',
        lang === 'ko' ? `Task ${tasks.length}개` : `${tasks.length} task(s)`,
        ...collapseList(tasks.map(describeTaskLine), WIZARD_REVIEW_LIST_LIMIT, lang),
    );

    if (findings.length > 0) {
        const errors = findings.filter(f => f.severity === 'error').length;
        const warnings = findings.filter(f => f.severity === 'warning').length;
        lines.push('');
        lines.push(lang === 'ko'
            ? `점검 결과 — 오류 ${errors}건, 경고 ${warnings}건`
            : `Checks — ${errors} error(s), ${warnings} warning(s)`);
        lines.push(...collapseList(findings.map(f => formatFindingLine(f, lang)), WIZARD_REVIEW_LIST_LIMIT, lang));
    }

    return lines.join('\n');
}

/**
 * Full text opened in an untitled document when the user asks to inspect the
 * pending action. Carries what the modal cannot hold: the exact JSON that
 * will be written and the complete Preview Run simulation.
 */
export function buildWizardReviewDocument(
    action: ActionItem,
    findings: DoctorFinding[],
    previewReport: string,
    lang: 'ko' | 'en' = 'ko'
): string {
    const sections: string[] = [];
    sections.push(lang === 'ko'
        ? `// 저장 예정 액션 — '${action.title}' (${action.id})\n// 이 문서는 미리보기입니다. 닫아도 저장에는 영향이 없습니다.`
        : `// Pending action — '${action.title}' (${action.id})\n// This document is a preview; closing it does not affect saving.`);
    sections.push(JSON.stringify(action, null, 2));

    if (findings.length > 0) {
        sections.push([
            lang === 'ko' ? '// ── 점검 결과 ──' : '// ── Checks ──',
            ...findings.map(f => `// ${formatFindingLine(f, lang)}`),
        ].join('\n'));
    }

    sections.push(previewReport);
    return sections.join('\n\n');
}

function persistWorkspaceActions(workspaceFolder: string, workspaceActionsPath: string, workspaceActions: ActionItem[]): void {
    const vscodeDir = path.join(workspaceFolder, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(workspaceActionsPath, JSON.stringify(workspaceActions, null, 2) + '\n');
}

/**
 * Pre-save review. Runs the same two checkers the user can invoke manually
 * — Doctor and Preview Run — against the *prospective* file and reports only
 * what the new action introduces. Returns `true` when the user confirms.
 *
 * Doctor needs the whole file (id collisions are cross-action), so it lints
 * the serialized prospective array and diffs against the current one.
 */
/**
 * 확인 관문의 결말.
 *
 *  - `save`      — 저장한다.
 *  - `cancelled` — modal 에서 **명시적으로** 취소했다 (Cancel/Escape).
 *  - `dismissed` — 비modal 알림이 지워졌다. X 나 *Clear All Notifications* 로
 *                  실수로 닫히는 표면이라, 호출자가 초안을 살린 채 되묻는다.
 */
type WizardConfirmOutcome = 'save' | 'cancelled' | 'dismissed';

async function confirmWizardAction(input: {
    action: ActionItem;
    destinationLabel: string;
    prospectiveActions: ActionItem[];
    workspaceActionsPath: string;
    workspaceFolder: string;
    extensionPath: string;
    /** Ids already in use, excluding the pending action itself. */
    existingIds: Set<string>;
    /**
     * 검토 문서를 이미 연 상태인가. **호출자가 들고 있어야 한다** — 이 값이
     * 함수 지역 변수였을 때, 취소 후 *다시 검토* 로 재진입하면 `false` 로
     * 리셋돼 **열려 있는 검토 문서 위에 modal 이 다시 떴다.** 아래 주석이
     * 굳이 피하려던 바로 그 상태이고, 하필 그 경로를 밟는 사람이 *Inspect*
     * 를 눌러 문서를 읽고 있던 사용자다.
     */
    state: { inspected: boolean };
}): Promise<WizardConfirmOutcome> {
    const lang: 'ko' | 'en' = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
    const workspaceRoots = getWorkspaceRoots();

    // Recomputed whenever the id changes: `id.duplicate` and friends depend
    // on it, so a stale finding list would describe the previous id.
    const collectFindings = (): DoctorFinding[] => {
        try {
            const validator = getActionsValidator() as unknown as (data: unknown) => boolean;
            const doctorInput = (rawText: string): DoctorInput => ({
                filePath: input.workspaceActionsPath,
                sourceLabel: 'workspace',
                rawText,
                workspaceFolder: input.workspaceFolder,
                workspaceRoots,
                extensionPath: input.extensionPath,
            });
            const existingText = fs.existsSync(input.workspaceActionsPath)
                ? fs.readFileSync(input.workspaceActionsPath, 'utf-8')
                : '[]';
            const before = runDoctor([doctorInput(existingText)], validator as any);
            const after = runDoctor([doctorInput(JSON.stringify(input.prospectiveActions, null, 2) + '\n')], validator as any);
            return diffDoctorFindings(before, after);
        } catch (error: any) {
            // A checker crash must not block creation — the wizard's job is
            // to write the action, and the review is advisory.
            outputChannel.appendLine(`[Wizard] Doctor check skipped: ${error?.message ?? error}`);
            return [];
        }
    };

    let introduced = collectFindings();
    const saveLabel = t('저장', 'Save');
    const inspectLabel = t('자세히 보기', 'Inspect');
    const editIdLabel = t('ID 변경', 'Change id');

    const openReviewDocument = async (): Promise<void> => {
        let previewReport: string;
        try {
            previewReport = buildPreviewReport(input.action, {
                workspaceFolder: input.workspaceFolder,
                extensionPath: input.extensionPath,
                workspaceRoots,
            });
        } catch (error: any) {
            previewReport = `(preview unavailable: ${error?.message ?? error})`;
        }
        const document = await vscode.workspace.openTextDocument({
            content: buildWizardReviewDocument(input.action, introduced, previewReport, lang),
            language: 'jsonc',
        });
        await vscode.window.showTextDocument(document, { preview: true });
    };

    // A VS Code modal dims the whole workbench and captures input, so a modal
    // re-shown on top of the review document makes that document impossible
    // to scroll or select — the user could only read the few lines visible
    // around the dialog, and dismissing it to read properly cancelled the
    // wizard. Once the document is open it *is* the review surface (it holds
    // strictly more than the modal `detail`), so the prompt drops to a
    // notification. Notifications carrying buttons stay until acted on.
    // Loop so "Inspect" / "Change id" can act and come back to the same
    // decision instead of silently ending the wizard.
    for (;;) {
        const question = t(
            `'${input.action.title}' 액션을 저장할까요?`,
            `Save the action '${input.action.title}'?`
        );
        const choice = input.state.inspected
            ? await vscode.window.showInformationMessage(
                t(
                    `${question} 열린 검토 문서를 확인한 뒤 선택하세요.`,
                    `${question} Review the opened document, then choose.`
                ),
                saveLabel,
                editIdLabel,
                inspectLabel
            )
            : await vscode.window.showInformationMessage(
                question,
                {
                    modal: true,
                    detail: buildWizardReviewDetail(input.action, input.destinationLabel, introduced, lang),
                },
                saveLabel,
                editIdLabel,
                inspectLabel
            );

        if (choice === saveLabel) {
            return 'save';
        }
        if (choice === editIdLabel) {
            // The id becomes the `taskhub.runAction.<id>` command name and is
            // referenced by `dependsOn`; renaming it after the fact silently
            // breaks user keybindings, so this is the cheap moment to fix it.
            const edited = await vscode.window.showInputBox({
                prompt: t('액션 ID를 입력하세요', 'Enter the action id'),
                value: input.action.id,
                ignoreFocusOut: true,
                validateInput: (value) => validateActionIdInput(value, input.existingIds),
            });
            if (edited !== undefined) {
                // Mutates the object already inserted into `prospectiveActions`,
                // so the serialized preview and Doctor rerun both see the new id.
                input.action.id = edited.trim();
                introduced = collectFindings();
                // The open document still shows the previous id — refresh it,
                // or the surface the user is now deciding from is stale.
                if (input.state.inspected) {
                    await openReviewDocument();
                }
            }
            continue;
        }
        if (choice !== inspectLabel) {
            // **어느 표면에서 취소됐는지**를 구분해 돌려준다. modal 의 Cancel /
            // Escape 는 명시적인 의사표시이므로 한 번에 끝나야 하고, 알림이
            // 지워진 것은 실수일 수 있으므로 호출자가 한 번 되묻는다. 예전에는
            // 둘 다 `false` 라, 일부러 취소한 사용자까지 두 번 닫아야 했다.
            return input.state.inspected ? 'dismissed' : 'cancelled';
        }

        await openReviewDocument();
        input.state.inspected = true;
    }
}

async function handlePostCreationChoice(created: { id: string; title: string }, workspaceActionsPath: string): Promise<void> {
    const openOption = t('actions.json 열기', 'Open actions.json');
    const runOption = t('바로 실행', 'Run now');
    // The wizard skips cwd / revealTerminal / success·fail messages (and the
    // file picker's openLabel for the file-dialog template) to keep the
    // first-time path short. Surface their existence here so users who
    // didn't know those options exist still discover them — the *Open
    // actions.json* button is the entry point for actually setting them.
    const choice = await vscode.window.showInformationMessage(
        t(
            `'${created.title}' 액션이 actions.json에 추가되었습니다. cwd, revealTerminal, 성공/실패 메시지 등 추가 설정이 필요하면 actions.json을 편집하세요.`,
            `Action '${created.title}' was added to actions.json. Edit it to configure additional options like cwd, revealTerminal, or success/fail messages.`
        ),
        openOption,
        runOption
    );
    if (choice === openOption) {
        const document = await vscode.workspace.openTextDocument(workspaceActionsPath);
        await vscode.window.showTextDocument(document, { preview: false });
    } else if (choice === runOption) {
        vscode.commands.executeCommand('taskhub.executeActionById', { id: created.id });
    }
}

/**
 * Action creation wizard. Re-ordered so the user reaches the *essential*
 * input (the shell command / file picker) as fast as possible:
 *
 *   1. Pick workspace folder (auto-skipped if there's only one)
 *   2. Pick template
 *   3. Title
 *   4. Template-specific prompts — a single shell command for both bundled
 *      templates (File Picker + Shell prefills `${selectFile.path}`)
 *   5. Pick destination (auto-skipped if no folders exist in actions.json)
 *   6. Save + post-creation choice (Open actions.json / Run now)
 *
 * Action id, task ids, description, success/fail message, cwd, terminal
 * reveal mode are all auto-filled to safe defaults — power users can edit
 * them via "Open actions.json" right after creation. This trims the
 * first-run path from ~10 prompts to 3-4. Broken `.vscode/actions.json`
 * surfaces an error toast with an explicit "Open actions.json" recovery
 * action so the user has a next step instead of a dead-end notification.
 */
async function runActionCreationWizard(context: vscode.ExtensionContext, mainViewProvider: MainViewProvider): Promise<void> {
    const targetFolder = await pickWorkspaceFolderForCommand(t('actions.json을 업데이트할 워크스페이스 폴더를 선택하세요', 'Select the workspace folder whose actions.json should be updated'));
    if (!targetFolder) {
        return;
    }

    const workspaceActionsPath = path.join(targetFolder.uri.fsPath, '.vscode', 'actions.json');

    let sources: WizardActionSources;
    try {
        sources = loadWizardActionSources(context, targetFolder);
    } catch (error: any) {
        const openLabel = t('actions.json 열기', 'Open actions.json');
        const choice = await vscode.window.showErrorMessage(
            t(
                `액션 소스를 불러오지 못했습니다: ${error.message}`,
                `Failed to load action sources: ${error.message}`
            ),
            openLabel
        );
        if (choice === openLabel && fs.existsSync(workspaceActionsPath)) {
            const document = await vscode.workspace.openTextDocument(workspaceActionsPath);
            await vscode.window.showTextDocument(document, { preview: false });
        }
        return;
    }

    const template = await promptForActionTemplate();
    if (!template) {
        return;
    }

    try {
        const title = await promptForRequiredInput({
            prompt: t('TaskHub에 표시될 제목을 입력하세요', 'Enter the title displayed in TaskHub'),
            placeHolder: 'e.g. Build Project'
        });
        const tasks = await template.promptForTasks();

        // 마법사는 `command`(argv) 로 저장한다. 사용자가 터미널에서 쓰던 것을
        // 그대로 붙여 넣으면 `&&` 나 `|` 가 리터럴 인자가 되어 **오류 없이**
        // 다르게 동작하므로, 저장하기 전에 그 사실을 알린다.
        const shellSyntaxCommands = tasks
            .filter((task: any) => typeof task?.command === 'string' && commandNeedsShellSyntax(task.command))
            .map((task: any) => task.command as string);
        if (shellSyntaxCommands.length > 0) {
            const continueLabel = t('그대로 만들기', 'Create anyway');
            const choice = await vscode.window.showWarningMessage(
                t(
                    `명령어에 셸 연산자(\`&&\`, \`|\`, \`>\` 등)가 있습니다. 마법사는 안전을 위해 \`command\` 타입으로 저장하며, 이 타입은 연산자를 **리터럴 인자로** 넘깁니다 — 연산자가 동작하지 않습니다. 셸 해석이 필요하면 만든 뒤 actions.json 에서 타입을 \`shell\` 로 바꾸세요. 다만 \`shell\` 에서는 \${...} 로 들어온 값도 셸 문법으로 해석되므로, 사용자 입력이나 파일 경로는 \`args\` 배열로 넘기세요.`,
                    `The command contains shell operators (\`&&\`, \`|\`, \`>\`, …). The wizard saves a \`command\` task for safety, and that type passes operators as **literal arguments** — they will not work. If you need shell interpretation, change the type to \`shell\` in actions.json afterwards. Note that in \`shell\`, interpolated \${...} values are also parsed as shell syntax, so pass user input and file paths through the \`args\` array instead.`
                ),
                { modal: true },
                continueLabel
            );
            if (choice !== continueLabel) {
                return;
            }
        }

        const existingIds = wizardTakenActionIds(sources);

        const destination = await promptForActionDestination(sources.workspaceActions);

        // The derived id is deliberately *not* kept in a local: the review
        // step below can rewrite `newAction.id`, and a second copy of the
        // value is exactly what let the post-creation "Run now" fire with an
        // id that no longer existed. `newAction` is the only source of truth.
        const newAction: ActionItem = {
            id: deriveActionIdFromTitle(title, existingIds),
            title,
            action: {
                description: template.defaultDescription,
                tasks
            }
        };

        insertActionIntoDestination(sources.workspaceActions, destination, newAction);

        // Last gate before touching disk. `insertActionIntoDestination`
        // mutates the in-memory array only, so bailing out here leaves the
        // file untouched.
        const confirmInput = {
            action: newAction,
            destinationLabel: destination.label,
            prospectiveActions: sources.workspaceActions,
            workspaceActionsPath: sources.workspaceActionsPath,
            workspaceFolder: targetFolder.uri.fsPath,
            extensionPath: context.extensionPath,
            existingIds,
            // 재진입해도 검토 문서를 연 사실이 유지된다 — 리셋되면 열린 문서
            // 위에 modal 이 다시 뜬다.
            state: { inspected: false },
        };
        // **말없이 끝내지 않는다.** 이 관문은 *Inspect* 를 누른 뒤 비modal
        // 알림으로 내려가는데, 그 알림은 X 나 "Clear All Notifications" 로
        // **실수로** 닫힌다. 그러면 최대 10단계까지 입력한 내용이 통째로
        // 사라지면서 화면에는 아무 변화도 없어, 저장된 건지 취소된 건지조차
        // 알 수 없었다. 0.6.46 이 Back 과 초안 보존을 넣은 이유가 바로 이
        // 손실인데 마지막 관문만 그 보호 밖에 있었다.
        //
        // **초안은 아직 살아 있다.** `newAction` 은 완성된 상태로 여기 있고
        // `persistWorkspaceActions` 는 아직 돌지 않았다. 그러니 "처음부터 다시"가
        // 아니라 **방금 그 확인 화면으로 되돌아가는 것**이 옳다.
        //
        // 되묻는 것은 **알림이 지워졌을 때뿐**이다. modal 의 Cancel 은 명시적인
        // 의사표시라 한 번에 끝낸다 — 일부러 취소한 사람까지 붙잡으면 그것대로
        // 성가시다. 되물을 때는 *버리기* 를 **라벨 있는 버튼**으로 준다:
        // 초안을 버리는 동작이 이름 없는 X 제스처뿐이면, 그 파괴적인 선택이
        // 가장 눈에 안 띄는 자리에 놓인다.
        let outcome = await confirmWizardAction(confirmInput);
        while (outcome === 'dismissed') {
            const reviewAgain = t('다시 검토', 'Review again');
            const discard = t('버리기', 'Discard');
            const choice = await vscode.window.showInformationMessage(
                t(
                    `'${newAction.title}' 액션을 아직 저장하지 않았습니다. 입력한 내용은 그대로 남아 있습니다.`,
                    `'${newAction.title}' has not been saved yet. Your input is still here.`
                ),
                reviewAgain,
                discard
            );
            // 이 알림마저 지워졌다면 더 붙잡지 않는다 — 한 번이면 충분하다.
            if (choice !== reviewAgain) { return; }
            outcome = await confirmWizardAction(confirmInput);
        }
        if (outcome !== 'save') {
            return;
        }

        persistWorkspaceActions(targetFolder.uri.fsPath, sources.workspaceActionsPath, sources.workspaceActions);
        refreshActionsAndCommands(context, mainViewProvider);
        // `newAction.id` rather than the derived `id`: the review step's
        // *Change id* button rewrites the action in place, and passing the
        // stale value here sent "Run now" to `executeActionById` with an id
        // that no longer exists — the user got "action not found" for the
        // action they had just created.
        await handlePostCreationChoice({ id: newAction.id, title }, sources.workspaceActionsPath);
    } catch (error) {
        if (error instanceof WizardCancelledError) {
            return;
        }
        vscode.window.showErrorMessage(t(`새 액션 생성에 실패했습니다: ${(error as Error).message}`, `Failed to create a new action: ${(error as Error).message}`));
    }
}

// MainViewProvider, Folder, Action classes live in ./providers/mainViewProvider.
// They are re-exported below so existing callers (including tests) can keep
// `import { ... } from './extension'` unchanged.
import { MainViewProvider, Folder, Action } from './providers/mainViewProvider';
import { actionStates, ActionProgress, ActionRunState } from './providers/actionStatus';
export { MainViewProvider, Folder, Action };

// Per-action, per-run-generation, per-task tracking. Both maps are keyed by
// actionId at the outer layer and an opaque generation+task key inside, so a
// late event from an abandoned run cannot overwrite/delete a newer run's slot.
// Parallel siblings can still be timed-out / stopped independently.
// Legacy spawn callers that don't carry a taskId use the empty string '' as
// a sentinel slot — task ids are required non-empty by the schema, so no
// real task collides with it.
interface ActiveTaskExecution {
    readonly taskId: string;
    readonly execution: vscode.TaskExecution;
    readonly generation: number;
}

const activeTasks = new Map<string, Map<string, ActiveTaskExecution>>();
const manuallyTerminatedActions = new Set<string>();

interface SensitiveDebugCapture {
    readonly taskId: string;
    /** Whether this task type has a stdout/stderr channel we can capture. */
    readonly captureSupported: boolean;
    readonly outputUnavailableReason?: 'detached-one-shot';
    stdout: string;
    stderr: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    outcome: 'running' | 'launched' | 'success' | 'failure';
    /** Safe metadata only; never the original Error/cause. */
    detail?: SensitiveFailureDetail;
    /**
     * Explicitly consented debug runs may retain the raw message string in
     * memory. Never retain the Error object/cause or copy this into logs,
     * Problems, History, or notifications.
     */
    rawErrorMessage?: string;
    rawErrorMessageTruncated?: boolean;
}

/**
 * Cancellation and sensitive-data state for one concrete execution.
 *
 * The action id is deliberately NOT the identity of a run. A total-output
 * abort can stop waiting after its drain deadline while a native dialog is
 * still open. The user may then start the same action id again. Every late
 * continuation must keep consulting the old object it captured, never the new
 * run that happens to have the same id.
 */
interface ActionRunContext {
    readonly id: string;
    readonly generation: number;
    readonly cancellation: vscode.CancellationTokenSource;
    /** The scheduler stopped supervising unresolved work after its drain cap. */
    abandoned: boolean;
    /** The owning executeAction / detached pipeline has returned. */
    closed: boolean;
    /** Results that contain or were derived from a password input. */
    readonly secretTaskIds: Set<string>;
    /** AbortControllers owned by currently running built-in archive tasks. */
    readonly taskAbortControllers: Map<string, Set<AbortController>>;
    /**
     * 이 **한 번의 실행**에서만 원본 출력을 사용자에게 보여 준다.
     *
     * 사용자가 실패 알림에서 명시적으로 요청하고 모달로 동의했을 때만 선다.
     * 영구 설정으로 두지 않는 것이 핵심이다 — 켜 놓고 잊으면 그 뒤의 모든
     * 실행에서 비밀이 새기 때문이다. 실행이 끝나면 컨텍스트와 함께 사라진다.
     */
    sensitiveDebug: boolean;
    /** 민감 디버그 실행에서 붙잡아 둔 원본 출력 (어디에도 저장하지 않는다). */
    readonly sensitiveDebugCaptures: Map<string, SensitiveDebugCapture>;
    /** Raw debug bytes retained across all tasks in this run. */
    sensitiveDebugCapturedBytes: number;
}

let nextActionRunGeneration = 1;
const currentActionRuns = new Map<string, ActionRunContext>();

/**
 * Kept as the current-run token index for the public `isActionCancelled`
 * helper and existing tests. Runtime continuations never look themselves up
 * through this map; they capture an {@link ActionRunContext} instead.
 */
const actionCancellations = new Map<string, vscode.CancellationTokenSource>();

function createActionRunContext(id: string): ActionRunContext {
    return {
        id,
        generation: nextActionRunGeneration++,
        cancellation: new vscode.CancellationTokenSource(),
        abandoned: false,
        closed: false,
        secretTaskIds: new Set<string>(),
        taskAbortControllers: new Map<string, Set<AbortController>>(),
        // 다음 실행이 이 플래그를 물려받으면 안 된다. 요청한 그 실행에서만
        // `beginActionCancellation` 직후에 세운다.
        sensitiveDebug: false,
        sensitiveDebugCaptures: new Map<string, SensitiveDebugCapture>(),
        sensitiveDebugCapturedBytes: 0,
    };
}

/** Register a new UI-visible run and return the exact object tasks capture. */
function beginActionCancellation(id: string): ActionRunContext {
    const previous = currentActionRuns.get(id);
    if (previous) {
        // Defensive only: the duplicate-run guard normally makes this
        // unreachable. If state ever drifts, do not let the stale run continue.
        previous.abandoned = true;
        previous.cancellation.cancel();
    }
    // A run generation never inherits the previous generation's manual-stop
    // classification, even if defensive recovery allowed the new run before
    // the stale owner reached its finalizer.
    manuallyTerminatedActions.delete(id);
    const run = createActionRunContext(id);
    currentActionRuns.set(id, run);
    actionCancellations.set(id, run.cancellation);
    return run;
}

/**
 * Close only this generation. A stale run must never delete a newer run's
 * cancellation source or secret metadata.
 */
function endActionCancellation(run: ActionRunContext): void {
    run.closed = true;
    // `dispose()` alone does not notify token-aware prompts. Cancellation is
    // required so any late inputBox/quickPick owned by this generation closes
    // instead of surviving after its action has returned.
    if (!run.cancellation.token.isCancellationRequested) {
        run.cancellation.cancel();
    }
    for (const controllers of run.taskAbortControllers.values()) {
        for (const controller of controllers) { controller.abort(); }
    }
    run.taskAbortControllers.clear();
    run.cancellation.dispose();
    if (currentActionRuns.get(run.id) === run) {
        currentActionRuns.delete(run.id);
    }
    if (actionCancellations.get(run.id) === run.cancellation) {
        actionCancellations.delete(run.id);
    }
}

/** The captured run's token, never a token belonging to a later generation. */
function actionCancellationToken(run: ActionRunContext): vscode.CancellationToken {
    return run.cancellation.token;
}

/**
 * 내장 아카이브 작업이 **취소로** 끝났는가.
 *
 * `archiveUtils` 는 `vscode` 를 모르므로 `ActionStoppedError` 를 던질 수 없고,
 * `pipeline({ signal })` 의 중단과 같은 `AbortError` 로 통일해 던진다. 여기서
 * 그것을 이 모듈의 중지 표현으로 옮긴다 — 실패로 포장하면 사용자가 누른
 * Stop 이 오류 메시지로 보인다.
 */
function isArchiveAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) { return false; }
    // 두 경로가 있다. 우리가 직접 던지는 쪽은 `name` 을 `AbortError` 로 두고,
    // `pipeline({ signal })` 의 중단은 `name: 'AbortError'` + `code:
    // 'ABORT_ERR'` 로 온다 — 실측으로 확인했다. `name === 'ABORT_ERR'` 을
    // 보는 것은 죽은 조건이라(그건 `code` 다) `code` 를 본다.
    return error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR';
}

/**
 * 액션의 취소 토큰을 표준 `AbortSignal` 로 잇는다.
 *
 * `archiveUtils` 는 `vscode` 를 import 하지 않으므로(순수 node 자식
 * 프로세스에서도 require 할 수 있어야 한다) 토큰을 그대로 넘길 수 없다.
 *
 * 반환된 `dispose` 를 **반드시** 부른다. 토큰 리스너를 걸어 두면 액션이
 * 끝날 때까지 남는데, 한 액션이 zip 태스크를 여러 번 돌리면 그만큼 쌓인다.
 */
function abortSignalForAction(
    run: ActionRunContext,
    taskId: string
): { signal: AbortSignal; abort: () => void; dispose: () => void } {
    const token = actionCancellationToken(run);
    const controller = new AbortController();
    let controllers = run.taskAbortControllers.get(taskId);
    if (!controllers) {
        controllers = new Set<AbortController>();
        run.taskAbortControllers.set(taskId, controllers);
    }
    controllers.add(controller);

    if (token.isCancellationRequested || run.abandoned || run.closed) {
        controller.abort();
        return {
            signal: controller.signal,
            abort: () => controller.abort(),
            dispose: () => {
                controllers!.delete(controller);
                if (controllers!.size === 0) { run.taskAbortControllers.delete(taskId); }
            },
        };
    }
    const sub = token.onCancellationRequested(() => controller.abort());
    return {
        signal: controller.signal,
        abort: () => controller.abort(),
        dispose: () => {
            sub.dispose();
            controllers!.delete(controller);
            if (controllers!.size === 0) { run.taskAbortControllers.delete(taskId); }
        },
    };
}

function abortTaskOperations(run: ActionRunContext, taskId: string): void {
    for (const controller of run.taskAbortControllers.get(taskId) ?? []) {
        controller.abort();
    }
}

interface TaskExecutionScope {
    readonly run: ActionRunContext;
    readonly taskId: string;
    readonly cancellation: vscode.CancellationTokenSource;
    readonly runCancellationSubscription: vscode.Disposable;
    timedOut: boolean;
}

function createTaskExecutionScope(run: ActionRunContext, taskId: string): TaskExecutionScope {
    const cancellation = new vscode.CancellationTokenSource();
    if (run.cancellation.token.isCancellationRequested || run.abandoned || run.closed) {
        cancellation.cancel();
    }
    const runCancellationSubscription = run.cancellation.token.onCancellationRequested(() => {
        if (!cancellation.token.isCancellationRequested) { cancellation.cancel(); }
    });
    return { run, taskId, cancellation, runCancellationSubscription, timedOut: false };
}

function timeoutTaskExecution(scope: TaskExecutionScope): void {
    scope.timedOut = true;
    if (!scope.cancellation.token.isCancellationRequested) {
        scope.cancellation.cancel();
    }
}

function disposeTaskExecutionScope(scope: TaskExecutionScope): void {
    scope.runCancellationSubscription.dispose();
    scope.cancellation.dispose();
}

function throwIfTaskInactive(scope: TaskExecutionScope): void {
    throwIfActionCancelled(scope.run);
    if (scope.timedOut) {
        throw new Error(`Task '${scope.taskId}' resumed after its timeout and was discarded.`);
    }
}

/**
 * Whether a stop was requested for this action. Checked after every await on
 * something that cannot itself be cancelled (native dialogs), so the run ends
 * at the next safe point rather than continuing to the following task.
 */
export function isActionCancelled(id: string, sources: ReadonlyMap<string, vscode.CancellationTokenSource> = actionCancellations): boolean {
    return sources.get(id)?.token.isCancellationRequested === true;
}

function markTaskResultSecret(run: ActionRunContext, taskId: string): void {
    run.secretTaskIds.add(taskId);
}

/**
 * Conservatively propagate password taint through the task graph without ever
 * retaining the password value itself. `${secretTask.*}` references anywhere
 * in a task make its result sensitive; bare ids in `inputs` are handled too.
 */
function taskReferencesSecret(task: import('./schema').Task, run: ActionRunContext): boolean {
    if (run.secretTaskIds.size === 0) { return false; }
    // Reuse the graph's platform-aware scanner. Besides avoiding drift with
    // scheduling semantics, this prevents a secret reference in an inactive
    // Windows/macOS/Linux branch from unnecessarily tainting the branch that
    // actually runs on this host. Bare task ids in `inputs` are covered too.
    return inferTaskDependencies(task, run.secretTaskIds).size > 0;
}

/** 표시·기록용 보간 컨텍스트. 비밀 태스크의 결과를 자리표시자로 바꾼다. */
function redactSecretsInContext(run: ActionRunContext, context: Record<string, any>): Record<string, any> {
    if (run.secretTaskIds.size === 0) { return context; }

    const redactValue = (value: unknown): unknown => {
        if (Array.isArray(value)) { return value.map(redactValue); }
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = redactValue(v);
            }
            return out;
        }
        // Password presets enter as `unknown`, so do not assume every secret
        // leaf is a string. Numbers/booleans would otherwise be converted to
        // text by interpolation and leak into the display command.
        return SECRET_PLACEHOLDER;
    };

    const redacted = { ...context };
    for (const id of run.secretTaskIds) {
        if (Object.prototype.hasOwnProperty.call(redacted, id)) {
            redacted[id] = redactValue(redacted[id]);
        }
    }
    return redacted;
}

/**
 * 이력·로그에 보여 줄 명령줄. 비밀 태스크의 결과 자리에 자리표시자가 들어간다.
 *
 * 실행에 쓰는 명령줄과 **다른 문자열**이다 — 실행에는 진짜 값이 필요하고,
 * 보여 줄 때는 가려야 한다. 비밀이 없으면 원래 명령줄과 같다.
 */
function buildRedactedDisplayCommand(
    run: ActionRunContext,
    task: import('./schema').Task,
    interpolationContext: Record<string, any>,
    interpolatedCommand: string,
    interpolatedArgs: string[]
): string {
    const shown = redactSecretsInContext(run, interpolationContext);
    if (shown === interpolationContext) {
        return buildNativeCommandInvocation(interpolatedCommand, interpolatedArgs).display;
    }
    // Resolve the raw platform branch first, then interpolate the redacted
    // context. Reusing `interpolatedCommand` for an object would reuse the
    // already-expanded password value.
    // `command` 타입은 **토큰마다** 보간해야 실제 실행과 같은 argv 가 된다.
    // 통짜로 보간하면 값 안의 공백이 인자를 쪼개, 실제로는 인자 하나로 간
    // 경로가 기록에는 둘로 남는다 — 비밀은 가려도 이력이 실행을 잘못 설명한다.
    const selected = getCommandString(task.command);
    const source = task.type === 'command'
        ? interpolateCommandPreservingTokens(selected, value => interpolatePipelineVariables(value, shown))
        : interpolatePipelineVariables(selected, shown);
    const args = task.args ? task.args.flatMap((arg: string) => expandArgTemplate(arg, shown)) : [];
    return buildNativeCommandInvocation(source, args).display;
}

function buildRedactedDisplayValue(
    run: ActionRunContext,
    interpolationContext: Record<string, any>,
    template: string | undefined,
    actual: string | undefined
): string | undefined {
    if (!template || actual === undefined || run.secretTaskIds.size === 0) { return actual; }
    return interpolatePipelineVariables(template, redactSecretsInContext(run, interpolationContext));
}

/** 이력·로그에 남기는 자리표시자. 값 길이를 짐작하게 하지 않는다. */
const SECRET_PLACEHOLDER = '***';

/** Raised when a run ends because the user pressed stop, not because it failed. */
export class ActionStoppedError extends Error {
    constructor() {
        super('Action stopped by user');
        this.name = 'ActionStoppedError';
    }
}

/**
 * 사용자가 대화형 태스크의 프롬프트를 **의도적으로 닫았을 때** 던진다
 * (`fileDialog`/`folderDialog`/`inputBox`/`quickPick`/`envPick`/`confirm` 에서
 * Escape 또는 Cancel).
 *
 * **태스크 수준에서는 여전히 실패다.** 그래야 `continueOnError: true` 가 문서에
 * 적힌 대로("취소를 허용하려면 continueOnError") 계속 동작한다. 바뀌는 것은
 * **액션 수준의 마감 처리**다 — 예전에는 여기까지 올라온 취소가 빨간 오류
 * 토스트 + History `failure` + 트리의 ✗ 로 끝났다. 사용자가 방금 "됐어요"라고
 * 말한 것을 시스템 오류로 되돌려주는 셈이었고, 메시지도 한국어 UI 에 영어로
 * 섞여 나왔다.
 *
 * Stop 버튼(0.6.46 에서 `cancelled` 로 분리)과 같은 부류이므로 같은 마감을
 * 쓴다. 문자열 매칭이 아니라 `name` 으로 분류한다 — 문구가 바뀌면 조용히
 * 깨지는 판정을 만들지 않기 위해서다(`TaskTimeoutError` 와 같은 이유).
 */
export class PromptCancelledError extends Error {
    /**
     * 어느 태스크의 프롬프트였는지. **생성 시점에는 비어 있고** 파이프라인이
     * 태스크 경계에서 채운다 — 핸들러 11곳에 태스크 id 를 따로 넘기는 것보다,
     * 이미 id 를 아는 자리 한 곳에서 붙이는 편이 어긋날 여지가 없다.
     *
     * 출력 채널의 취소 한 줄에 쓴다. 태스크가 여덟 개인 파이프라인에 프롬프트가
     * 여럿이면, "왜 중간에 멈췄지" 를 답하라고 남긴 그 줄이 정작 **어느**
     * 프롬프트였는지 말해 주지 않는다.
     */
    taskId?: string;

    constructor(message: string) {
        super(message);
        this.name = 'PromptCancelledError';
    }
}

/** 이 오류가 담고 있는 프롬프트 취소들의 태스크 id (선언 순서, 중복 제거). */
export function promptCancellationTaskIds(error: unknown, seen = new Set<unknown>()): string[] {
    if (!error || typeof error !== 'object' || seen.has(error)) { return []; }
    seen.add(error);
    const errors = (error as AggregateError).errors;
    if (Array.isArray(errors)) {
        const ids: string[] = [];
        for (const inner of errors) {
            for (const id of promptCancellationTaskIds(inner, seen)) {
                if (!ids.includes(id)) { ids.push(id); }
            }
        }
        return ids;
    }
    return error instanceof PromptCancelledError && error.taskId ? [error.taskId] : [];
}

/**
 * 이 오류가 **오직 프롬프트 취소로만** 이루어져 있는가.
 *
 * 병렬 파이프라인은 실패들을 `AggregateError` 로 묶으므로, 취소 하나와 진짜
 * 실패 하나가 함께 올라올 수 있다. 그럴 때는 실패로 보고해야 한다 — 취소가
 * 섞였다는 이유로 진짜 오류를 조용히 삼키면 안 된다. 그래서 "하나라도
 * 취소인가"가 아니라 "전부 취소인가"를 묻는다.
 *
 * `containsSensitiveTaskError` 와 같은 순환 방어(`seen`)를 쓴다.
 */
/**
 * 이 오류가 담고 있는 **프롬프트 취소의 개수**.
 *
 * "이미 실행된 태스크가 몇 개인가" 를 셀 때 필요하다. 진행도 카운터
 * (`ActionProgress.completed`)는 `running` 이 아닌 **모든** 종료 전이에서
 * 올라가므로 — 취소된 프롬프트도 `failure` 전이를 내보낸다 — 그 값을 그대로
 * 쓰면 아무것도 실행되지 않았는데 "1개 실행됨" 이 된다. 실측: 태스크가
 * `fileDialog` 하나뿐인 액션에서 Escape 를 눌러도 안내가 떴고, 번들 예제는
 * 대부분 프롬프트가 첫 태스크라 이것이 기본 경험이었다.
 *
 * `isOnlyPromptCancellation` 과 같은 순환 방어를 쓴다.
 */
export function countPromptCancellations(error: unknown, seen = new Set<unknown>()): number {
    if (!error || typeof error !== 'object' || seen.has(error)) { return 0; }
    seen.add(error);
    const errors = (error as AggregateError).errors;
    if (Array.isArray(errors)) {
        let total = 0;
        for (const inner of errors) { total += countPromptCancellations(inner, seen); }
        return total;
    }
    return error instanceof PromptCancelledError ? 1 : 0;
}

export function isOnlyPromptCancellation(error: unknown, seen = new Set<unknown>()): boolean {
    if (!error || typeof error !== 'object' || seen.has(error)) { return false; }
    seen.add(error);
    const errors = (error as AggregateError).errors;
    if (Array.isArray(errors)) {
        // 빈 AggregateError 는 취소라고 단정할 근거가 없다.
        return errors.length > 0 && errors.every(inner => isOnlyPromptCancellation(inner, seen));
    }
    return error instanceof PromptCancelledError;
}

/**
 * 비밀을 쓰는 태스크의 실패에서 **안전하게 보여 줄 수 있는** 부분.
 *
 * 원본 stdout/stderr 은 여기 담지 않는다 — 비밀번호가 출력에서 변형되거나
 * 인코딩되어 나올 수 있어(base64, URL 인코딩, 셸이 다시 인용한 형태 등)
 * 문자열 치환만으로는 가릴 수 없기 때문이다.
 */
interface SensitiveFailureDetail {
    stage: 'start' | 'exit' | 'timeout' | 'capture-limit' | 'unknown';
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    /** 이미 마스킹된 명령줄. */
    command?: string;
}

/** 실패 원인 중 **가릴 필요가 없는** 부분만 추려 낸다. */
function describeSensitiveFailure(raw: Error, maskedCommand?: string): SensitiveFailureDetail {
    if (raw instanceof ShellCommandError) {
        return { stage: 'exit', exitCode: raw.exitCode, signal: raw.signal, command: maskedCommand };
    }
    if (raw.name === 'TaskTimeoutError') {
        return { stage: 'timeout', command: maskedCommand };
    }
    if (raw.name === 'CaptureLimitError') {
        return { stage: 'capture-limit', command: maskedCommand };
    }
    // spawn 자체가 실패한 경우(ENOENT/EACCES 등). errno 코드는 경로나 비밀을
    // 담지 않는다.
    const code = (raw as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.length > 0) {
        return { stage: 'start', command: maskedCommand };
    }
    return { stage: 'unknown', command: maskedCommand };
}

function taskSupportsSensitiveDebugCapture(task: import('./schema').Task): boolean {
    return ((task.type === 'command' || task.type === 'shell') && task.isOneShot !== true) ||
        ((task.type === 'zip' || task.type === 'unzip') && task.tool !== undefined && task.tool !== null);
}

function ensureSensitiveDebugCapture(
    run: ActionRunContext,
    taskId: string,
    captureSupported: boolean,
    outputUnavailableReason?: SensitiveDebugCapture['outputUnavailableReason']
): SensitiveDebugCapture | undefined {
    if (!run.sensitiveDebug) { return undefined; }
    let capture = run.sensitiveDebugCaptures.get(taskId);
    if (!capture) {
        capture = {
            taskId,
            captureSupported,
            outputUnavailableReason,
            stdout: '',
            stderr: '',
            outcome: 'running',
        };
        run.sensitiveDebugCaptures.set(taskId, capture);
    }
    return capture;
}

/**
 * Keep raw output only in the one-run in-memory debug context. The callback is
 * never installed during an ordinary run, so no new persistence/log surface is
 * created for password-derived output.
 */
function sensitiveDebugOutputObserver(
    run: ActionRunContext,
    taskId: string
): ((target: 'stdout' | 'stderr', chunk: string) => void) | undefined {
    const capture = run.sensitiveDebugCaptures.get(taskId);
    if (!run.sensitiveDebug || !capture?.captureSupported) { return undefined; }
    return (target, chunk) => {
        const remaining = SENSITIVE_DEBUG_DISPLAY_LIMIT_BYTES - run.sensitiveDebugCapturedBytes;
        const part = takeSensitiveDebugPrefix(chunk, remaining);
        run.sensitiveDebugCapturedBytes += part.bytes;
        if (target === 'stdout') {
            capture.stdout += part.text;
            if (part.truncated) { capture.stdoutTruncated = true; }
        } else {
            capture.stderr += part.text;
            if (part.truncated) { capture.stderrTruncated = true; }
        }
    };
}

function finishSensitiveDebugCapture(
    run: ActionRunContext,
    taskId: string,
    outcome: 'launched' | 'success' | 'failure',
    detail?: SensitiveFailureDetail,
    rawErrorMessage?: string
): void {
    const capture = run.sensitiveDebugCaptures.get(taskId);
    if (!capture) { return; }
    capture.outcome = outcome;
    capture.detail = detail;
    if (rawErrorMessage) {
        const remaining = SENSITIVE_DEBUG_DISPLAY_LIMIT_BYTES - run.sensitiveDebugCapturedBytes;
        const part = takeSensitiveDebugPrefix(rawErrorMessage, remaining);
        capture.rawErrorMessage = part.text;
        capture.rawErrorMessageTruncated = part.truncated;
        run.sensitiveDebugCapturedBytes += part.bytes;
    }
}

/** AggregateError may contain a mix of sensitive and ordinary failures. */
function containsSensitiveTaskError(error: unknown, seen = new Set<unknown>()): boolean {
    if (error instanceof SensitiveTaskError) { return true; }
    if (!(error instanceof AggregateError) || seen.has(error)) { return false; }
    seen.add(error);
    return Array.from(error.errors as Iterable<unknown>).some(item => containsSensitiveTaskError(item, seen));
}

function sensitiveStageLabel(stage: SensitiveFailureDetail['stage']): string {
    switch (stage) {
        case 'start': return t('실행 시작 실패', 'failed to start');
        case 'exit': return t('비정상 종료', 'exited with a failure');
        case 'timeout': return t('시간 초과', 'timed out');
        case 'capture-limit': return t('출력 한도 초과', 'exceeded the output limit');
        default: return t('실패', 'failed');
    }
}

class SensitiveTaskError extends Error {
    constructor(taskId: string, public readonly detail: SensitiveFailureDetail) {
        // Do not retain the original error as `cause`: stderr and spawn errors
        // can themselves contain the secret, and callers may serialize the
        // complete Error object rather than just `.message`.
        //
        // 원인을 통째로 숨기면 비밀번호를 쓰는 flash/deploy 가 실패했을 때
        // 사용자가 **아무 단서도 없이** 막힌다. 그래서 가려도 안전한 것만
        // 골라 남긴다: 어느 단계에서 실패했는지, 종료 코드와 시그널, 이미
        // 마스킹된 명령. 원본 출력은 일회성 "민감 디버그" 재실행으로만 본다.
        const parts: string[] = [`Task '${taskId}' ${sensitiveStageLabel(detail.stage)}`];
        if (detail.stage === 'exit') {
            if (typeof detail.exitCode === 'number') {
                parts.push(t(`종료 코드 ${detail.exitCode}`, `exit code ${detail.exitCode}`));
            }
            if (detail.signal) {
                parts.push(t(`시그널 ${detail.signal}`, `signal ${detail.signal}`));
            }
        }
        if (detail.command) {
            parts.push(t(`명령: ${detail.command}`, `command: ${detail.command}`));
        }
        parts.push(t(
            'password 입력을 사용해 상세 출력은 숨겼습니다',
            'detailed output is hidden because the task used a password input'
        ));
        super(parts.join(' — '));
        this.name = 'SensitiveTaskError';
    }
}

function logSuppressedSensitiveDiagnostics(taskId: string): void {
    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
    if (showVerboseLogs) {
        outputChannel.appendLine(
            `[INFO] Diagnostics for task '${taskId}' were suppressed because the task used a password input.`
        );
    }
}

/** Check the exact run captured before an uncancellable await. */
function throwIfActionCancelled(run: ActionRunContext): void {
    if (run.cancellation.token.isCancellationRequested || run.abandoned || run.closed) {
        throw new ActionStoppedError();
    }
}
const outputChannel = vscode.window.createOutputChannel('TaskHub');
let previewOutputChannel: vscode.OutputChannel | undefined;
function getPreviewOutputChannel(): vscode.OutputChannel {
    if (!previewOutputChannel) {
        previewOutputChannel = vscode.window.createOutputChannel('TaskHub Preview');
    }
    return previewOutputChannel;
}
// `output.mode: 'terminal'`용 읽기 전용 터미널 핸들. 실제 셸 터미널에
// sendText()로 본문을 보내면 본문 속 개행이 Enter로 해석되어 임의 라인이
// 셸에서 실행될 수 있으므로(예: 빌드 출력의 `del ...` 라인), 셸 없는
// Pseudoterminal에 출력만 렌더링한다.
interface OutputTerminalHandle {
    terminal: vscode.Terminal;
    write: (text: string) => void;
}

/**
 * `pty.open()` 이전에 버퍼링할 최대 크기.
 *
 * `open()` 은 터미널 UI 가 붙은 뒤 비동기로 불리므로 그 전의 write 는 유실된다.
 * 그래서 버퍼링하는데, **상한이 없었다** — 터미널이 열리기 전에 대량 출력을
 * 쏟는 태스크(빌드 로그 등)가 있으면 그 전량이 문자열 하나로 쌓인다.
 *
 * 1MB 면 터미널이 뜨기 전 몇 초 분량의 로그로 충분하고, 넘치는 경우에도
 * **최근 것을 남긴다** — 사용자가 보려는 것은 대개 마지막 상태다.
 */
const PTY_PENDING_MAX_BYTES = 1024 * 1024;

function createReadonlyOutputTerminal(name: string): OutputTerminalHandle {
    const writeEmitter = new vscode.EventEmitter<string>();
    // pty.open()은 createTerminal 직후가 아니라 터미널 UI가 붙은 뒤 비동기로
    // 호출된다. open 이전의 write는 유실되므로 버퍼링했다가 open 시 flush.
    let opened = false;
    let pending = '';
    let droppedBytes = 0;
    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
            opened = true;
            if (pending.length > 0) {
                // 잘렸다면 그 사실을 화면에 남긴다. 조용히 버리면 사용자가
                // 로그 앞부분이 왜 없는지 알 수 없다.
                const notice = droppedBytes > 0
                    ? t(
                        `[TaskHub] 터미널이 열리기 전 출력 ${Math.round(droppedBytes / 1024)}KB 를 생략했습니다.\r\n`,
                        `[TaskHub] Omitted ${Math.round(droppedBytes / 1024)} KB of output produced before the terminal opened.\r\n`
                    )
                    : '';
                writeEmitter.fire(notice + pending);
                pending = '';
                droppedBytes = 0;
            }
        },
        close: () => {
            writeEmitter.dispose();
        }
        // handleInput 미구현 → 사용자 입력이 어디에도 전달되지 않는 읽기 전용 터미널
    };
    const terminal = vscode.window.createTerminal({ name, pty });
    const write = (text: string) => {
        // xterm은 LF만으로는 캐리지 리턴하지 않으므로 CRLF로 정규화
        const normalized = text.replace(/\r?\n/g, '\r\n');
        if (opened) {
            writeEmitter.fire(normalized);
            return;
        }
        pending += normalized;
        // 상한을 넘으면 **앞쪽을 버린다**. 터미널이 열리기 전 대량 출력을
        // 쏟는 태스크가 있으면 그 전량이 문자열 하나로 쌓이던 자리다.
        // 사용자가 보려는 것은 대개 마지막 상태이므로 최근 것을 남긴다.
        if (pending.length > PTY_PENDING_MAX_BYTES) {
            const overflow = pending.length - PTY_PENDING_MAX_BYTES;
            droppedBytes += overflow;
            pending = pending.slice(overflow);
        }
    };
    return { terminal, write };
}

const actionTerminals = new Map<string, OutputTerminalHandle>();
const actionWorkspaceFolderMap = new Map<string, string | undefined>();

// Refcount of in-flight parallel-capable runs per actionId. While the
// count is > 0, the executor isolates streamed-task terminal groups
// and `output.mode: 'terminal'` terminal keys per-task so concurrent
// task output does not interleave. Sequential actions are not tracked
// and keep the historical shared-terminal grouping (backward compat).
//
// A refcount (rather than `Set<string>`) future-proofs against any
// scenario where the same actionId could enter `executeActionPipeline`
// re-entrantly: today the duplicate-run guard in `markActionAsRunning`
// prevents that, but if a future code path bypasses the guard (e.g. a
// nested re-run), an inner `finally` must not strip the outer caller's
// membership.
const parallelActionRefs = new Map<string, number>();

function enterParallelAction(id: string): void {
    parallelActionRefs.set(id, (parallelActionRefs.get(id) ?? 0) + 1);
}

function exitParallelAction(id: string): void {
    const current = parallelActionRefs.get(id) ?? 0;
    if (current <= 1) {
        parallelActionRefs.delete(id);
    } else {
        parallelActionRefs.set(id, current - 1);
    }
}

function isParallelActionActive(id: string): boolean {
    return parallelActionRefs.has(id);
}

interface ChildProcessBucket {
    readonly taskId: string;
    readonly generation: number | undefined;
    readonly processes: Set<ReturnType<typeof spawn>>;
}

const actionChildProcesses = new Map<string, Map<string, ChildProcessBucket>>();

/**
 * Test seam: 지금 이 액션에 대해 *Stop All* 이 볼 수 있는 자식 프로세스들.
 *
 * 추적 해제 규칙("죽은 것이 확인된 뒤에만 뺀다")은 registry 를 들여다보지
 * 않으면 검증할 수 없다. 상태를 **읽기만** 하고 아무것도 보관하지 않으므로
 * 프로덕션 메모리에 영향이 없다 — 0.6.47 의 `postedMessages` 처럼 관찰용
 * 사본을 호스트에 쌓지 않는다.
 */
export function __testHook_trackedChildProcesses(actionId: string): ReturnType<typeof spawn>[] {
    const perAction = actionChildProcesses.get(actionId);
    if (!perAction) { return []; }
    const found: ReturnType<typeof spawn>[] = [];
    for (const bucket of perAction.values()) {
        for (const child of bucket.processes) { found.push(child); }
    }
    return found;
}

function taskGenerationBucketKey(taskId: string, generation?: number): string {
    return `${generation ?? 'legacy'}\u0000${taskId}`;
}

function setActiveTaskExecution(
    actionId: string,
    taskId: string,
    execution: vscode.TaskExecution,
    generation: number
): void {
    if (!taskId) {
        // Defensive guard: schema enforces non-empty `task.id`, and the only
        // call site already pre-checks `task.id`. Fail loudly if an internal
        // caller ever violates that invariant.
        throw new Error(`setActiveTaskExecution called with empty taskId for action '${actionId}'.`);
    }
    let perAction = activeTasks.get(actionId);
    if (!perAction) {
        perAction = new Map();
        activeTasks.set(actionId, perAction);
    }
    perAction.set(taskGenerationBucketKey(taskId, generation), { taskId, execution, generation });
}

function deleteActiveTaskExecution(
    actionId: string,
    taskId: string,
    generation: number,
    expectedExecution?: vscode.TaskExecution
): void {
    const perAction = activeTasks.get(actionId);
    if (!perAction) { return; }
    const key = taskGenerationBucketKey(taskId, generation);
    const current = perAction.get(key);
    if (!current) { return; }
    if (expectedExecution && current.execution !== expectedExecution) { return; }
    perAction.delete(key);
    if (perAction.size === 0) { activeTasks.delete(actionId); }
}

function getActiveTaskExecution(actionId: string, taskId: string, generation: number): vscode.TaskExecution | undefined {
    return activeTasks.get(actionId)?.get(taskGenerationBucketKey(taskId, generation))?.execution;
}
const actionStartTimestamps = new Map<string, number>();

/**
 * Error thrown by `executeShellCommand` when the spawned process exits
 * with a non-zero code. Carries the captured `stdout` / `stderr` strings
 * so callers (notably `executeSingleTask` for `output.diagnostics`) can
 * still parse compiler errors out of a *failed* build — the case where
 * Problems-panel navigation matters most. The `message` mirrors the
 * historical reject value (stderr or a synthetic "exit code N") so
 * existing failure-message UX (history.output, action failure toast) is
 * preserved verbatim.
 */
export class ShellCommandError extends Error {
    constructor(
        message: string,
        public readonly stdout: string,
        public readonly stderr: string,
        public readonly exitCode: number | null,
        /**
         * 종료 시그널. 프로세스가 죽어서 끝난 경우 `exitCode` 는 `null` 이라
         * 그것만으로는 "왜 끝났는지"를 알 수 없다 — 비밀번호를 쓰는 태스크는
         * 상세 출력을 가리므로, 이 값이 사용자에게 남는 몇 안 되는 단서다.
         */
        public readonly signal: NodeJS.Signals | null = null
    ) {
        super(message);
        this.name = 'ShellCommandError';
    }
}

/**
 * Per-action `DiagnosticCollection` registry. Each action owns its own
 * collection so a re-run can clear *its* diagnostics without disturbing
 * unrelated actions that happen to surface diagnostics for the same file.
 * The collection is created lazily on first emission and reused across
 * re-runs. Disposed in `deactivate()` (per-collection dispose) so language
 * features release their underlying resources.
 */
const actionDiagnosticCollections = new Map<string, vscode.DiagnosticCollection>();

/**
 * Shared `DiagnosticCollection` for TaskHub Doctor (`taskhub.doctor`).
 * Kept separate from per-action collections so a Doctor re-run can clear
 * its own findings without disturbing diagnostics emitted by a running
 * action's Problem Matcher.
 */
let doctorDiagnosticCollection: vscode.DiagnosticCollection | undefined;
function getDoctorDiagnosticCollection(): vscode.DiagnosticCollection {
    if (!doctorDiagnosticCollection) {
        doctorDiagnosticCollection = vscode.languages.createDiagnosticCollection('taskhub-doctor');
    }
    return doctorDiagnosticCollection;
}

function getOrCreateActionDiagnostics(actionId: string): vscode.DiagnosticCollection {
    let col = actionDiagnosticCollections.get(actionId);
    if (!col) {
        col = vscode.languages.createDiagnosticCollection(`taskhub:${actionId}`);
        actionDiagnosticCollections.set(actionId, col);
    }
    return col;
}

/**
 * Clear all diagnostics this action previously emitted. Called at the
 * start of every action run so stale errors from a prior failing build
 * don't linger after the user fixes them and re-runs.
 */
function clearActionDiagnostics(actionId: string): void {
    actionDiagnosticCollections.get(actionId)?.clear();
}

/**
 * Combine stdout and stderr into a single string for diagnostic matching.
 * Empty fields are skipped (no leading/trailing newline) so per-line
 * regexes don't see spurious blank lines. Used by both the success path
 * (in the post-processing block) and the failure path (in the
 * `ShellCommandError` catch) so warnings and errors get the same
 * treatment regardless of which stream the toolchain wrote them on.
 */
function combineStdoutStderrForDiagnostics(stdout: string, stderr: string): string {
    if (!stdout) {
        return stderr;
    }
    if (!stderr) {
        return stdout;
    }
    return stdout + '\n' + stderr;
}

function severityToVscode(s: ParsedDiagnostic['severity']): vscode.DiagnosticSeverity {
    switch (s) {
        case 'error':   return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'info':    return vscode.DiagnosticSeverity.Information;
        case 'hint':    return vscode.DiagnosticSeverity.Hint;
    }
}

/**
 * Resolve a (possibly relative) path from compiler output into an absolute
 * URI suitable for `DiagnosticCollection.set(uri, ...)`. Relative paths
 * resolve against the task's cwd so the same action works regardless of
 * where VS Code was launched.
 */
function resolveDiagnosticUri(file: string, baseCwd: string): vscode.Uri {
    const abs = path.isAbsolute(file) ? file : path.resolve(baseCwd, file);
    return vscode.Uri.file(abs);
}

/**
 * Convert `ParsedDiagnostic` records into `vscode.Diagnostic` objects and
 * push them to the action's collection grouped by URI. Multiple records
 * for the same file are coalesced into a single `set(uri, [...])` call so
 * VS Code does one render per file.
 *
 * Pure function in spirit — extension-side glue between the deterministic
 * matcher and the VS Code Diagnostic API. Throws on configuration errors
 * (invalid regex / unknown preset / missing required group) bubbled up
 * from `applyDiagnosticMatchers`.
 */
function applyDiagnosticsToCollection(
    output: string,
    config: import('./schema').DiagnosticConfig,
    task: any,
    actionId: string,
    baseCwd: string
): void {
    const parsed = applyDiagnosticMatchers(output, config);
    if (parsed.length === 0) {
        return;
    }
    const collection = getOrCreateActionDiagnostics(actionId);
    const byUri = new Map<string, vscode.Diagnostic[]>();
    for (const d of parsed) {
        const uri = resolveDiagnosticUri(d.file, baseCwd);
        const startLine = Math.max(0, d.line - 1);
        const startCol = Math.max(0, (d.column ?? 1) - 1);
        const endLine = d.endLine !== undefined ? Math.max(0, d.endLine - 1) : startLine;
        const endCol = d.endColumn !== undefined ? Math.max(0, d.endColumn - 1) : startCol + 1;
        const range = new vscode.Range(startLine, startCol, endLine, endCol);
        const diag = new vscode.Diagnostic(range, d.message, severityToVscode(d.severity));
        diag.source = d.source ?? `taskhub:${task.id}`;
        const list = byUri.get(uri.toString()) ?? [];
        list.push(diag);
        byUri.set(uri.toString(), list);
    }
    // Group writes per URI. `collection.set(uri, ...)` REPLACES all existing
    // entries for that URI within this collection, so a later task that
    // emits diagnostics for the same file would overwrite an earlier
    // task's contribution within the same action run. To keep both, we
    // read the current entries via `collection.get(uri)` and concat
    // before writing. The action-start `clearActionDiagnostics(id)`
    // already wiped any prior-run state, so anything we read here was
    // emitted earlier in the *current* run by a sibling task — exactly
    // what we want to preserve. Regression guard: IT-082.
    for (const [uriStr, diags] of byUri) {
        const uri = vscode.Uri.parse(uriStr);
        const existing = collection.get(uri) ?? [];
        collection.set(uri, [...existing, ...diags]);
    }
}

/**
 * spawn 한 프로세스와 **그 자손까지** 종료한다.
 *
 * `child.kill()` 은 우리가 띄운 셸 래퍼(`cmd.exe /c …`, `sh -l -c …`)만
 * 죽인다. Windows 의 `TerminateProcess` 는 트리를 따라가지 않으므로 래퍼가
 * 사라진 뒤에도 그 아래 실제 명령이 고아로 남아 계속 돈다. POSIX 도 자식이
 * 다른 프로세스 그룹을 만들었으면 마찬가지다.
 *
 * Windows 는 `taskkill /T /F` 로 트리를 지우고, POSIX 는 프로세스 그룹 전체에
 * 시그널을 보낸다(`process.kill(-pid)`). 어느 쪽이든 실패하면 최소한 래퍼는
 * 죽도록 `child.kill()` 로 폴백한다 — 아무것도 안 죽는 것보다 낫다.
 */
export function killProcessTree(child: ReturnType<typeof spawn>): Promise<boolean> {
    // `child.killed` 로 미리 빠져나가지 않는다 — 그 값은 "죽었다"가 아니라
    // "시그널을 보냈다"는 뜻이다. 출력 상한 같은 다른 경로가 먼저
    // `child.kill()` 을 불렀다면 래퍼에만 시그널이 갔을 뿐 자손은 그대로이므로,
    // 트리 종료는 여전히 필요하다.
    if (!child || typeof child.pid !== 'number') {
        try { child?.kill(); } catch { /* ignore */ }
        return Promise.resolve(false);
    }
    const pid = child.pid;

    // 실제 종료를 기다린다. `taskkill` 이 성공했다고 보고해도 프로세스가
    // 즉시 사라지는 것은 아니고, 호출부(취소 경로)는 종료를 확인한 뒤
    // reject 해야 "중지했는데 아직 돌더라" 를 만들지 않는다.
    const exited = new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('close', () => resolve());
        child.once('exit', () => resolve());
    });
    const fallbackKill = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };

    const requested = new Promise<boolean>(resolve => {
        if (process.platform === 'win32') {
            let tk: ReturnType<typeof spawn>;
            try {
                tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
            } catch {
                fallbackKill();
                resolve(false);
                return;
            }
            tk.on('error', () => { fallbackKill(); resolve(false); });
            // exit code 를 확인한다. `taskkill` 이 정상 실행되고도 실패하는
            // 경우(권한 부족, 이미 종료됨 등)가 있는데 예전에는 `error`
            // 이벤트만 봐서 그 실패가 조용히 묻혔다.
            tk.on('close', (code) => {
                if (code !== 0) {
                    outputChannel.appendLine(`[WARN] taskkill /T /F on pid ${pid} exited with ${code}; falling back to direct kill.`);
                    fallbackKill();
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        } else {
            try {
                // `detached: true` 로 띄운 자식은 pid 가 곧 프로세스 그룹 id 다.
                process.kill(-pid, 'SIGKILL');
                resolve(true);
            } catch {
                // 그룹이 없다(detached 누락 등) — 최소한 래퍼는 죽인다.
                fallbackKill();
                resolve(false);
            }
        }
    });

    // 상한은 **전체**를 덮어야 한다. 예전에는 `requested` 가 끝난 *뒤에야*
    // 2초 race 로 들어가서, `taskkill` 자체가 멈추면(디스크 IO 지연, 권한
    // 프롬프트 등) 이 함수와 그것을 기다리는 취소 처리가 무한정 걸렸다.
    const deadline = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2000));
    const whole = requested.then(async (treeKilled) => {
        await exited;
        return treeKilled;
    });
    return Promise.race([whole, deadline]).then(result => {
        if (result === 'timeout') {
            outputChannel.appendLine(`[WARN] Process tree termination for pid ${pid} did not confirm within 2s; continuing.`);
            fallbackKill();
            return false;
        }
        return result;
    });
}

/**
 * 종료를 시도한 자식을 registry 에서 빼도 되는가.
 *
 * 기준은 "시그널을 보냈다"가 아니라 **"끝났다"** 이다. `killProcessTree` 는
 * timeout·권한 문제·`ESRCH` 로 실패해도 resolve 하므로, 그 반환값이나 호출
 * 사실만으로 지우면 아직 살아 있는 프로세스가 *Stop All* 의 시야에서 사라진다.
 *
 * `child.killed` 도 쓰지 않는다 — 그 값 역시 "시그널 전송됨"일 뿐이다.
 */
export function shouldUntrackTerminatedChild(
    child: { exitCode: number | null; signalCode: NodeJS.Signals | null }
): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function terminateChildProcesses(actionId: string, taskId?: string, generation?: number): boolean {
    const perAction = actionChildProcesses.get(actionId);
    if (!perAction || perAction.size === 0) {
        return false;
    }

    const killSet = (set: Set<ReturnType<typeof spawn>>, label: string): boolean => {
        if (set.size === 0) { return false; }
        for (const child of set) {
            try {
                // 트리 종료 — 셸 래퍼만 죽이면 그 아래 빌드/플래시 명령이
                // 고아로 남아 계속 돈다 (0.6.36 이전의 동작).
                //
                // `child.killed` 로 건너뛰지 않는다: 그 값은 "시그널 전송됨"일
                // 뿐이라, 다른 경로가 래퍼에만 kill 을 보낸 상태에서도 자손은
                // 살아 있을 수 있다.
                //
                // 이 함수는 동기 계약(호출부가 boolean 을 즉시 쓴다)이라
                // 완료를 기다리지 않는다. 대신 **종료가 확인된 뒤에**
                // registry 에서 뺀다 — 곧바로 지우면 종료가 실패하거나 늦은
                // 프로세스를 *Stop All* 로 다시 찾을 수 없고, 이전 프로세스가
                // 살아 있는 채로 같은 액션을 재실행하게 된다.
                void killProcessTree(child)
                    .then(() => {
                        // **실제로 죽었을 때만** 등록을 해제한다.
                        //
                        // `killProcessTree` 는 timeout·권한 문제·`ESRCH` 로
                        // 실패해도 resolve 한다. 반환값을 무시하고 지우면 아직
                        // 살아 있는 프로세스가 registry 에서 사라져 *Stop All*
                        // 이 다시 찾지 못하고, 사용자는 첫 Stop 이 실패한 것을
                        // 알 방법도 없다. `collectTargets` 가 상태 맵 대신 세
                        // 소스를 합집합하는 것도 같은 이유다(바로 위 주석).
                        //
                        // boolean 대신 프로세스 상태를 직접 본다 — "시그널을
                        // 보냈다"가 아니라 "끝났다"가 판단 기준이다. 남겨 둔
                        // 항목은 나중에 프로세스가 죽을 때 `close` 핸들러의
                        // `cleanupChildTracking` 이 정리하므로 새지 않는다.
                        if (shouldUntrackTerminatedChild(child)) {
                            set.delete(child);
                            return;
                        }
                        outputChannel.appendLine(
                            `[WARN] Process ${child.pid} for ${label} did not exit after the termination attempt; ` +
                            'keeping it tracked so *Stop All Actions* can retry.'
                        );
                    })
                    .catch(() => { /* 종료를 확인하지 못했다 — 남겨 두고 재시도에 맡긴다 */ });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[ERROR] Failed to terminate child process for ${label}: ${msg}`);
                set.delete(child);
            }
        }
        return true;
    };

    // registry 는 `killSet` 이 프로세스별 종료를 확인하며 비운다. 여기서
    // 통째로 지우면 아직 살아 있는 프로세스를 추적할 방법이 사라진다.
    // 비워진 슬롯만 정리한다.
    const sweepEmpty = () => {
        for (const [key, bucket] of Array.from(perAction)) {
            if (bucket.processes.size === 0) { perAction.delete(key); }
        }
        if (perAction.size === 0) { actionChildProcesses.delete(actionId); }
    };

    if (taskId !== undefined) {
        const buckets = generation === undefined
            ? Array.from(perAction.values()).filter(bucket => bucket.taskId === taskId)
            : [perAction.get(taskGenerationBucketKey(taskId, generation))].filter(
                (bucket): bucket is ChildProcessBucket => bucket !== undefined
            );
        let killed = false;
        for (const bucket of buckets) {
            if (killSet(bucket.processes, `action '${actionId}' task '${taskId}'`)) { killed = true; }
        }
        sweepEmpty();
        return killed;
    }

    let terminatedAny = false;
    for (const bucket of perAction.values()) {
        if (killSet(bucket.processes, `action '${actionId}' task '${bucket.taskId}'`)) { terminatedAny = true; }
    }
    sweepEmpty();
    return terminatedAny;
}
import {
    LinkEntry,
    Link,
    LinkViewProvider,
    loadLinksFromDisk,
    readLinksFromDisk,
    mergeInvalidJsonEntries,
    InvalidJsonEntry,
} from './providers/linkViewProvider';

import {
    FavoriteEntry,
    Favorite,
    FavoriteViewProvider,
    loadFavoritesFromDisk,
    readFavoritesFromDisk,
    removeFavoriteByIdentity,
} from './providers/favoriteViewProvider';

import {
    createToolHistoryEntry,
    deriveRecentActionRuns,
    formatRecentRunDetail,
    HistoryEntry,
    HistoryItem,
    HistoryProvider,
    isToolHistoryEntry,
    startHistoryAutoRefresh,
} from './providers/historyProvider';

import { normalizeLineNumber } from './providers/normalization';

function cloneMemoryMapHistoryConfig(config?: MemoryMapConfig): MemoryMapConfig | undefined {
    if (!config?.regions || config.regions.length === 0) {
        return undefined;
    }
    return {
        regions: config.regions.map(region => ({
            name: region.name,
            origin: region.origin,
            size: region.size,
        })),
    };
}

function recordMemoryMapHistory(historyProvider: HistoryProvider, entry: MemoryMapOpenHistory): void {
    historyProvider.addHistoryEntry(createToolHistoryEntry({
        kind: 'memoryMap',
        filePath: entry.filePath,
        fileName: entry.fileName,
        memoryMapInputType: entry.inputType,
        memoryMapConfig: cloneMemoryMapHistoryConfig(entry.config),
    }));
}

function recordHexViewerHistory(historyProvider: HistoryProvider, entry: HexViewerOpenHistory): void {
    historyProvider.addHistoryEntry(createToolHistoryEntry({
        kind: 'hexEditor',
        filePath: entry.filePath,
        fileName: entry.fileName,
    }));
}

function recordJsonEditorHistory(historyProvider: HistoryProvider, entry: JsonEditorOpenHistory): void {
    historyProvider.addHistoryEntry(createToolHistoryEntry({
        kind: 'jsonEditor',
        filePath: entry.filePath,
        fileName: entry.fileName,
    }));
}

async function openToolHistoryEntry(
    context: vscode.ExtensionContext,
    historyProvider: HistoryProvider,
    entry: HistoryEntry
): Promise<void> {
    if (!isToolHistoryEntry(entry)) {
        vscode.window.showErrorMessage(t('유효하지 않은 기록 항목입니다.', 'Invalid history entry.'));
        return;
    }

    const tool = entry.tool;
    if (tool.kind === 'memoryMap') {
        const inputType = tool.memoryMapInputType ?? 'elf';
        const opened = inputType === 'listing'
            ? openMemoryMapFromListing(context, tool.filePath)
            : openMemoryMapPanel(context, tool.filePath, tool.memoryMapConfig);
        if (opened) {
            recordMemoryMapHistory(historyProvider, {
                filePath: tool.filePath,
                fileName: tool.fileName,
                inputType,
                config: tool.memoryMapConfig,
            });
        }
        return;
    }

    if (tool.kind === 'jsonEditor') {
        await openJsonEditorFile(context, tool.filePath, entry => recordJsonEditorHistory(historyProvider, entry));
        return;
    }

    if (openHexViewerFile(context, tool.filePath)) {
        recordHexViewerHistory(historyProvider, {
            filePath: tool.filePath,
            fileName: tool.fileName,
        });
    }
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
        return applyKnownFieldsToRaw(entry, payload, ['title', 'path', 'line', 'group', 'tags']);
    });
}

/**
 * 디스크 원본(`raw`)과 우리가 조립한 알려진 필드(`payload`)를 합친다.
 *
 *   - `raw` 가 없다 (Add 가 만든 새 항목)        → `payload` 그대로.
 *   - `raw` 는 있고 편집하지 않았다              → **`raw` 그대로.** 정규화에서
 *     걸러진 값(`group: 42`)과 확장 속성을 우리가 없앨 권한이 없다.
 *   - `raw` 가 있고 편집했다                     → `raw` 위에 알려진 필드만
 *     덮어쓴다. 사용자가 고친 값이 반영되면서 `custom` 같은 속성은 남는다.
 *     편집으로 비운 필드는 지운다.
 *
 * 세 번째 갈래가 없던 동안, 편집 경로가 기존 항목을 spread 해 `raw` 를 함께
 * 복사했고 직렬화가 그 `raw` 를 그대로 되써서 **편집이 조용히 버려졌다**.
 */
function applyKnownFieldsToRaw(
    entry: { raw?: unknown; edited?: true },
    payload: Record<string, any>,
    knownKeys: string[]
): any {
    if (entry.raw === undefined || typeof entry.raw !== 'object' || entry.raw === null) {
        return payload;
    }
    if (!entry.edited) { return entry.raw; }
    const merged: Record<string, any> = { ...(entry.raw as Record<string, any>) };
    for (const key of knownKeys) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            merged[key] = payload[key];
        } else {
            delete merged[key];
        }
    }
    return merged;
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
        // 위 `serializeFavorites` 와 같은 규약 — `LinkEntry.raw` / `edited` 주석 참조.
        return applyKnownFieldsToRaw(entry, payload, ['title', 'link', 'group', 'tags']);
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

export function removeLinkByIdentity(entries: LinkEntry[], target: LinkEntry): LinkEntry[] {
    let removed = false;
    const targetTags = JSON.stringify(target.tags ?? []);
    return entries.filter(entry => {
        if (removed) {
            return true;
        }
        const sameTitle = entry.title === target.title;
        const sameLink = entry.link === target.link;
        const sameGroup = (entry.group ?? null) === (target.group ?? null);
        const sameTags = JSON.stringify(entry.tags ?? []) === targetTags;
        if (sameTitle && sameLink && sameGroup && sameTags) {
            removed = true;
            return false;
        }
        return true;
    });
}

/**
 * Modal confirm for `taskhub.deleteHistoryItem`. Returns true only when the
 * user explicitly clicked 'Yes'; Cancel / Esc / dismiss all map to false.
 *
 * Extracted so the prompt copy and the *only-explicit-Yes-deletes* contract
 * can be verified without booting the full registerCommand wrapper. The
 * confirm exists because `Delete Favorite` / `Delete Link` / `Clear All
 * History` all guard with a modal — single-row history delete was the only
 * outlier and a single click on the inline trash icon would silently lose
 * a row otherwise.
 */
export async function confirmDeleteHistoryItem(actionTitle: string): Promise<boolean> {
    const confirm = await vscode.window.showWarningMessage(
        t(
            `'${actionTitle}' 기록 항목을 삭제하시겠습니까?`,
            `Are you sure you want to delete the '${actionTitle}' history item?`
        ),
        { modal: true },
        'Yes'
    );
    return confirm === 'Yes';
}

export type ApplyPresetBackupChoice = 'backup' | 'cancel';

/**
 * Modal warning shown by `taskhub.applyPreset` when the existing
 * `actions.json` fails JSON parse / schema validation. Returns 'backup'
 * only when the user explicitly clicked the *backup* label; everything
 * else (Cancel, Esc, dismiss) maps to 'cancel'. The caller is responsible
 * for the actual `.bak` write — keeping disk I/O out of this helper makes
 * it pure-prompt and so unit-testable via the same monkey-patch pattern as
 * `handleConfirm`.
 */
export async function confirmApplyPresetBackup(
    actionsPath: string,
    invalidReason: string
): Promise<ApplyPresetBackupChoice> {
    const backupPath = `${actionsPath}.bak`;
    const backupLabel = t('손상된 파일 백업 후 계속', 'Back up corrupt file and continue');
    const cancelLabel = t('취소', 'Cancel');
    const choice = await vscode.window.showWarningMessage(
        t(
            `기존 actions.json이 유효하지 않아 프리셋 적용을 안전하게 진행할 수 없습니다 (${invalidReason}). 원본을 ${path.basename(backupPath)}로 백업하고 계속할까요?`,
            `The existing actions.json is invalid, so applying the preset cannot proceed safely (${invalidReason}). Back up the original to ${path.basename(backupPath)} and continue?`
        ),
        { modal: true },
        backupLabel,
        cancelLabel
    );
    return choice === backupLabel ? 'backup' : 'cancel';
}

export type SavePresetOverwriteChoice = 'overwrite' | 'open-existing' | 'cancel';

/**
 * Modal warning shown by `taskhub.saveAsPreset` when a preset file at
 * `targetPath` already exists in the Workspace / Extension save locations
 * (the Custom location uses `showSaveDialog`, which delegates the
 * overwrite prompt to the OS — that branch never calls this helper).
 * Returns a tagged choice so the caller can branch on overwrite vs.
 * opening the existing file vs. cancel without re-parsing label strings.
 */
export async function confirmSavePresetOverwrite(targetPath: string): Promise<SavePresetOverwriteChoice> {
    const overwriteLabel = t('덮어쓰기', 'Overwrite');
    const openExistingLabel = t('기존 파일 열기', 'Open existing file');
    const choice = await vscode.window.showWarningMessage(
        t(
            `프리셋 ${path.basename(targetPath)}이(가) 이미 존재합니다. 어떻게 할까요?`,
            `Preset ${path.basename(targetPath)} already exists. What would you like to do?`
        ),
        { modal: true },
        overwriteLabel,
        openExistingLabel
    );
    if (choice === overwriteLabel) {
        return 'overwrite';
    }
    if (choice === openExistingLabel) {
        return 'open-existing';
    }
    return 'cancel';
}

/**
 * Add a favorite entry while rejecting duplicates. Identity matches
 * {@link removeFavoriteByIdentity} (path + line + title + group) so a fresh
 * Add followed by Delete on the same row is symmetric — without this
 * guard, the multi-file Add path would create N copies on repeated drops
 * and Delete would then sweep them all in a single click, surprising the
 * user. Mirrors {@link addLinkEntry}'s tagged result so call sites can
 * surface the duplicate via a *favorites.json 열기* recovery toast.
 */
export function addFavoriteEntry(
    entries: FavoriteEntry[],
    newEntry: FavoriteEntry
): { entries: FavoriteEntry[]; added: boolean } {
    const targetLine = normalizeLineNumber(newEntry.line);
    const duplicate = entries.some(f => {
        const line = normalizeLineNumber(f.line);
        const samePath = f.path === newEntry.path;
        const sameLine = (line ?? null) === (targetLine ?? null);
        const sameTitle = f.title === newEntry.title;
        const sameGroup = (f.group ?? null) === (newEntry.group ?? null);
        return samePath && sameLine && sameTitle && sameGroup;
    });
    if (duplicate) {
        return { entries, added: false };
    }
    return { entries: [...entries, newEntry], added: true };
}

/**
 * Localize a {@link validateLinkUrlForSave} result into the message string
 * expected by `vscode.InputBox.validateInput` (`null` = pass, otherwise
 * shown red under the input). Shared by `taskhub.addLink` and the
 * workspace link edit flow so Add and Edit go through the *same* save-time
 * gate — previously Add blocked unsupported schemes while Edit only
 * checked non-empty, and Add's "format check" was actually scheme-only so
 * `https://` slipped through to the click-time error toast.
 */
function linkUrlValidateInputMessage(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return t('URL을 입력하세요', 'Enter a URL');
    }
    const result = validateLinkUrlForSave(trimmed);
    if (result.ok) {
        return null;
    }
    if (result.reason === 'scheme') {
        return t(
            `허용되지 않은 URL scheme '${result.scheme}'. http/https/mailto만 지원합니다.`,
            `URL scheme '${result.scheme}' is not allowed. Only http/https/mailto are supported.`
        );
    }
    return t('올바르지 않은 URL 형식입니다.', 'Invalid URL format.');
}

/**
 * Derive a human-friendly default title from a URL. Used as the prefilled
 * value for the "title for the link" prompt so the user can hit Enter to
 * accept (e.g. "github.com") instead of typing a label from scratch.
 *
 * Strategy: prefer the URL's host (`new URL(...).host`); strip a leading
 * `www.` for readability. If parsing fails (e.g. user typed a non-URL
 * string in the URL prompt — that case will be blocked by save-time
 * `validateLinkUrlForSave`, but we still need a non-empty default while
 * the user is mid-typing), fall back to the trimmed input itself.
 */
export function deriveLinkTitleFromUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) {
        return '';
    }
    try {
        const host = new URL(trimmed).host;
        if (host.length > 0) {
            return host.replace(/^www\./i, '');
        }
    } catch {
        // fall through
    }
    return trimmed;
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
        // Same save-time gate as taskhub.addLink (v0.4.32 follow-up):
        // scheme allowlist + WHATWG URL parse. Edit was previously
        // checking only non-empty so `javascript:` / `file:` / `https://`
        // could be saved here even though Add blocked them.
        validateInput: linkUrlValidateInputMessage
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
    const loadResult = readLinksFromDisk(entryToEdit.sourceFile);
    if (!loadResult.ok) {
        const openLabel = t('links.json 열기', 'Open links.json');
        const choice = await vscode.window.showErrorMessage(
            t(
                `links.json 파싱에 실패해 변경 사항을 저장할 수 없습니다: ${loadResult.error}`,
                `Cannot save — failed to parse links.json: ${loadResult.error}`
            ),
            openLabel
        );
        if (choice === openLabel && fs.existsSync(entryToEdit.sourceFile)) {
            const document = await vscode.workspace.openTextDocument(entryToEdit.sourceFile);
            await vscode.window.showTextDocument(document, { preview: false });
        }
        return;
    }
    const links = loadResult.entries;
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
        sourceFile: entryToEdit.sourceFile,
        // **필수.** spread 가 `raw` 를 함께 복사하므로, 편집했다는 표시가 없으면
        // 직렬화가 `raw` 를 그대로 되써서 이 편집이 버려진다.
        edited: true
    };
    links[targetIndex] = updated;

    const serialized = mergeInvalidJsonEntries(serializeLinks(links), loadResult.invalid);
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

function markActionAsRunning(
    actionItem: ActionItem,
    id: string,
    showTaskStatus: boolean,
    mainViewProvider: MainViewProvider
): ActionRunContext | undefined {
    // The duplicate-run guard is intentionally independent of `showTaskStatus`,
    // which only controls visual state indicators in the tree. Running the same
    // action concurrently would collide in activeTasks and is always wrong.
    const currentState = actionStates.get(id);
    if (currentState?.state === 'running') {
        vscode.window.showInformationMessage(t(`'${actionItem.title}' 액션이 이미 실행 중입니다.`, `Action '${actionItem.title}' is already running.`));
        return undefined;
    }

    actionStates.set(id, { state: 'running' });
    // Opened here rather than at the first prompt: the stop button becomes
    // visible the moment the state flips to `running`, so the scope it acts
    // on has to exist from that same moment.
    const run = beginActionCancellation(id);
    // 요청을 **소비**한다. 남겨 두면 그 뒤의 평범한 실행까지 원본을 노출한다.
    if (pendingSensitiveDebugActionIds.delete(id)) {
        run.sensitiveDebug = true;
    }
    syncRunningActionsContext();
    if (showTaskStatus) {
        mainViewProvider.refresh();
    }
    return run;
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

/**
 * Optional pipeline-execution side channels for replay/record support.
 *
 *   - `presetInputs`: when a key matches a task id, the matching interactive
 *     task (inputBox / quickPick / envPick / fileDialog / folderDialog /
 *     confirm) is short-circuited and the saved value becomes its result —
 *     no dialog is opened. Other task types ignore this map. Used by
 *     `taskhub.rerunFromHistoryWithInputs`.
 *   - `recordInputs`: when provided, the pipeline writes the result of every
 *     interactive task into this object keyed by task id. The caller can
 *     then attach the accumulated inputs to a history entry. `inputBox`
 *     with `password: true` is deliberately omitted to avoid persisting
 *     secrets. The accumulator is mutated in place even if the pipeline
 *     fails midway, so partial runs still surface their captured inputs.
 *   - `recordCommands`: when provided, each `command` / `shell` task writes
 *     its resolved (post-interpolation) command line into this object keyed
 *     by task id, so the caller can attach "what actually ran" to a history
 *     entry. Mutated in place so partial runs still surface their commands.
 *   - `onTaskTransition`: per-task lifecycle callback used to surface
 *     "지금 어디" progress on the Actions panel. Fires on `running`
 *     before each task starts, then on the matching terminal state
 *     (`success` / `failure` / `skipped`). `index` is 1-based.
 */
export interface PipelineExecutionOptions {
    presetInputs?: Record<string, unknown>;
    recordInputs?: Record<string, unknown>;
    recordCommands?: Record<string, string>;
    onTaskTransition?: (event: TaskTransitionEvent) => void;
    /** Test/embedding override; production uses the 5s drain ceiling. */
    abortDrainTimeoutMs?: number;
}

export interface TaskTransitionEvent {
    taskId: string;
    /** 1-based position of this task in the action's tasks array. */
    index: number;
    /** Total number of tasks in the action. */
    total: number;
    /** `running` fires before each task starts; the others fire after it ends. */
    state: 'running' | 'success' | 'failure' | 'skipped';
}

// INTERACTIVE_TASK_TYPES lives in pipelineUtils as the single source of
// truth shared between the runtime (this file) and the linter
// (`src/doctor.ts`). Imported above with the other `pipelineUtils`
// re-exports.

/**
 * Returns true when a task's result should be saved into `recordInputs` for
 * replay. `inputBox` with `password: true` opts out, so secret prompts never
 * reach `workspaceState`.
 */
export function shouldRecordTaskInput(task: import('./schema').Task): boolean {
    if (!INTERACTIVE_TASK_TYPES.has(task.type)) {
        return false;
    }
    if (task.type === 'inputBox' && task.password === true) {
        return false;
    }
    return true;
}

// `formatGraphIssue` lives in pipelineUtils so previewRun.ts shares
// the exact phrasing with the runtime executor.

function resolveMaxParallelTasks(): number {
    const cfg = vscode.workspace.getConfiguration('taskhub');
    const raw = cfg.get<number>('pipeline.maxParallelTasks', 4);
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 4;
    return Math.max(1, Math.min(32, value));
}

type InFlightOutcome =
    | { taskId: string; kind: 'success'; result: unknown }
    | { taskId: string; kind: 'skipped'; error: Error }
    /**
     * 조건(`when`)이 거짓이거나, 조건으로 꺼진 태스크를 참조해서 함께 꺼진 것.
     * **실패가 아니다** — `continueOnError` 의 skipped 와 달리 error 가 없다.
     */
    | { taskId: string; kind: 'condition-skipped'; reason: string }
    | { taskId: string; kind: 'failed'; error: Error };

// `withInteractivePromptLock` lives in pipelineUtils as a pure async
// primitive so the serialization can be unit-tested without booting
// vscode. The executor below acquires the lock before entering any
// `INTERACTIVE_TASK_TYPES` task so parallel pipelines never show
// concurrent modal UI.

export async function executeActionPipeline(
    action: PipelineAction,
    context: vscode.ExtensionContext,
    id: string,
    workspaceFolderPath?: string,
    workspaceRoots?: string[],
    options?: PipelineExecutionOptions
): Promise<void> {
    // Direct callers do not own UI-visible cancellation state, but still get
    // an isolated generation so timeout/late-continuation behavior is exactly
    // the same as executeAction's registered runs.
    const run = createActionRunContext(id);
    try {
        await executeActionPipelineForRun(
            action,
            context,
            id,
            workspaceFolderPath,
            workspaceRoots,
            options,
            run
        );
    } finally {
        endActionCancellation(run);
    }
}

async function executeActionPipelineForRun(
    action: PipelineAction,
    context: vscode.ExtensionContext,
    id: string,
    workspaceFolderPath: string | undefined,
    workspaceRoots: string[] | undefined,
    options: PipelineExecutionOptions | undefined,
    executionRun: ActionRunContext
): Promise<void> {
    // **null-prototype.** 태스크 id 는 사용자가 정하고 스키마가 `__proto__` 를
    // 막지 않는데, 평범한 객체에 `stepResults['__proto__'] = result` 를 하면
    // own property 가 만들어지지 않아 그 태스크의 결과가 조용히 사라진다
    // (downstream 의 `${__proto__.output}` 이 리터럴로 남는다). 프로토타입
    // 체인이 없으면 어떤 id 든 평범한 키가 된다.
    const stepResults: Record<string, unknown> = Object.create(null);
    const presetInputs = options?.presetInputs;
    const recordInputs = options?.recordInputs;
    const recordCommands = options?.recordCommands;
    const onTaskTransition = options?.onTaskTransition;
    const total = action.tasks.length;

    // Build + validate the task graph. Issues (cycle / missing / self
    // dep) become a clean pipeline failure rather than a runtime
    // deadlock on a never-completing dependency.
    const graph = buildTaskGraph(action.tasks);
    const issues = validateTaskGraph(action.tasks, graph);
    if (issues.length > 0) {
        const lines = issues.map(formatGraphIssue).map(m => `  - ${m}`).join('\n');
        throw new Error(`Action '${id}' has invalid task graph:\n${lines}`);
    }

    const maxConcurrency = resolveMaxParallelTasks();
    const scheduler = new TaskScheduler(graph, { maxConcurrency });
    // Mark the action as parallel-capable while it runs so that the
    // streamed-task terminal grouping and `output.mode: 'terminal'`
    // terminal keys split per-task. Removed in the `finally` below
    // so a subsequent re-run starts from a clean slate.
    const isParallelAction = actionUsesParallelTasks(action);
    if (isParallelAction) { enterParallelAction(id); }

    // Side-channel callback for progress UI. A throwing callback must
    // never alter the pipeline's success/failure outcome — the
    // pipeline's job is to run tasks, not to depend on a UI hook
    // succeeding. Regression guard: IT-074 / IT-074b.
    const emitTransition = (
        taskId: string,
        state: TaskTransitionEvent['state']
    ): void => {
        if (!onTaskTransition) { return; }
        const node = graph.nodes.get(taskId);
        const index = node ? node.index + 1 : 0;
        try {
            onTaskTransition({ taskId, index, total, state });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(
                `[WARN] onTaskTransition callback threw for task '${taskId}' (${state}): ${msg}`
            );
        }
    };

    const taskById = new Map<string, import('./schema').Task>();
    for (const t of action.tasks) { taskById.set(t.id, t); }

    const inFlight = new Map<string, Promise<InFlightOutcome>>();
    // Collect every failure so multi-failure runs (two parallel builds
    // failing simultaneously) surface every cause rather than silently
    // dropping the second through verbose-only logging. Single failures
    // throw the original error unchanged (preserving stack + `instanceof`
    // equality for callers like `handleActionFailure`); multi-failures
    // are wrapped in an AggregateError with a one-line summary so the
    // user sees every failed task at a glance.
    const failures: { taskId: string; error: Error }[] = [];

    // 태스크 결과 총량. 개별 태스크 출력은 `outputCaptureLimitMb` 로 막혀
    // 있었지만 합계에는 제한이 없어, 그 설정을 크게 올린 환경에서 태스크
    // 몇 개만으로 GB 단위가 될 수 있었다.
    const totalResultLimit = getTotalResultLimitBytes();
    let accumulatedResultBytes = 0;

    /**
     * 스케줄러 루프를 **중간에서 던지고 나갈 때** 아직 도는 형제 태스크를
     * 실제로 멈춘다.
     *
     * 평범한 태스크 실패는 이 함수가 필요 없다 — 스케줄러가 abort 상태로
     * 가고 루프가 `inFlight` 를 끝까지 drain 한 뒤에 나간다. 문제는 총량
     * 한도처럼 루프 **한가운데서 throw** 하는 경로다. 그때는 `finally` 가
     * `exitParallelAction` 만 하고 끝나므로, 형제 태스크의 Promise 는 주인을
     * 잃고 그 아래 프로세스는 **계속 돈다**. 사용자 눈에는 액션이 실패로
     * 끝나고 재실행까지 가능한데, 실제로는 이전 빌드·플래싱이 여전히
     * 파일을 쓰고 있는 상태다.
     *
     * 순서가 중요하다: (1) 취소 토큰을 세워 프롬프트를 닫고 뒤이어 뜨려던
     * 것을 막고, (2) 프로세스와 터미널 태스크를 실제로 종료하고, (3) 전부
     * settle 될 때까지 기다린다. 기다리지 않으면 "멈췄다"고 보고한 뒤에도
     * 정리가 진행 중인 상태로 호출부에 돌아간다.
     *
     * **drain 에는 시간 제한이 필요하다.** 정상 실패 경로의 drain 이 무제한
     * 이니 여기도 그래도 된다고 생각했는데, 두 경우는 대칭이 아니다. 정상
     * drain 중에는 형제가 **살아 있어서** 사용자가 Stop 을 누르면 그것들을
     * 찾아 죽일 수 있다. 여기서는 이미 죽인 뒤라 `stopRunningAction` 이
     * 아무것도 찾지 못하고(자식 없음, 토큰은 이미 취소됨) *"활성 태스크를
     * 찾을 수 없습니다"* 를 띄우며 `false` 를 돌려준다 — 기다리는 동안
     * **Stop 이 동작하지 않는 상태**가 된다.
     *
     * 그리고 취소가 닿지 않는 태스크가 실제로 있다. 네이티브 파일/폴더
     * 다이얼로그와 `confirm` 모달은 토큰을 받지 않아 프로그램으로 닫을 수
     * 없고(모듈 상단 `actionCancellations` 주석 참조), 태스크 timeout 도
     * `timeoutSeconds` 를 지정해야만 걸린다. 그런 형제가 하나라도 떠 있으면
     * 무제한 drain 은 **사람이 다이얼로그에 답할 때까지** 액션을 붙잡는다.
     *
     * 그래서 상한을 둔다. 프로세스를 죽인 뒤 settle 은 보통 수십 ms 면
     * 끝나므로 이 상한에 걸리는 것은 사실상 "취소가 닿지 않는 태스크"뿐이고,
     * 그것들은 프로세스를 갖지 않아 남겨 두어도 빌드가 계속 도는 상황이
     * 되지 않는다 — 이 수정이 막으려던 피해와는 성격이 다르다.
     */
    const ABORT_DRAIN_TIMEOUT_MS = options?.abortDrainTimeoutMs ?? 5000;
    const abortInFlightTasks = async (): Promise<void> => {
        if (inFlight.size === 0) { return; }
        if (!executionRun.cancellation.token.isCancellationRequested) {
            executionRun.cancellation.cancel();
        }
        for (const taskId of inFlight.keys()) {
            terminateChildProcesses(id, taskId, executionRun.generation);
            const exec = getActiveTaskExecution(id, taskId, executionRun.generation);
            if (exec) {
                try { exec.terminate(); } catch { /* ignore */ }
            }
        }
        // `launchTask` 의 Promise 는 거부하지 않고 `InFlightOutcome` 으로
        // 접히지만, 그래도 `allSettled` 를 쓴다 — 앞으로 거부하는 경로가
        // 생겨도 여기서 unhandled rejection 이 되지 않게.
        const drained = Promise.allSettled(inFlight.values()).then(() => true);
        const deadline = new Promise<boolean>(resolve =>
            setTimeout(() => resolve(false), ABORT_DRAIN_TIMEOUT_MS));
        if (!await Promise.race([drained, deadline])) {
            // 취소 소스는 곧 폐기되지만 이 표시는 남는다 — 뒤늦게 이어지는
            // 태스크가 "취소된 적 없음"으로 보여 계속 진행하는 것을 막는다.
            executionRun.abandoned = true;
            outputChannel.appendLine(
                `[WARN] Action '${id}': ${inFlight.size} task(s) did not settle within ` +
                `${ABORT_DRAIN_TIMEOUT_MS}ms after abort; continuing. ` +
                `A prompt or native dialog that cannot be dismissed programmatically may still be open.`
            );
        }
        inFlight.clear();
    };

    /**
     * 이미 마스킹된 명령줄. `recordCommands` 는 태스크를 **실행하기 전에**
     * 채워지므로 실패 시점에도 남아 있고, 그 값은 비밀이 이미 자리표시자로
     * 바뀐 표시용 문자열이다 — 그대로 보여 줘도 안전하다.
     */
    const maskedCommandForTask = (taskId: string): string | undefined => recordCommands?.[taskId];

    /**
     * 조건으로 꺼진 태스크 id. 그 결과를 참조하는 태스크도 함께 꺼진다.
     * `stepResults` 로는 구별할 수 없다 — 조건으로 꺼진 것도, 값을 안 만드는
     * 태스크도 똑같이 `{}` 이기 때문이다.
     */
    const conditionSkipped = new Set<string>();

    /**
     * 실행 전에 이 태스크를 꺼야 하는지 본다. 끌 이유가 없으면 undefined.
     *
     * 두 가지를 본다: 자기 `when` 이 거짓인가, 그리고 조건으로 꺼진 태스크를
     * 참조하는가. 후자가 없으면 미해결 리터럴 `"${pickFile.path}"` 가 경로나
     * 인자로 그대로 넘어간다.
     */
    const conditionGate = (task: import('./schema').Task): string | undefined => {
        if (shouldSkipForSkippedDependencies(task, conditionSkipped)) {
            return t('조건으로 꺼진 태스크의 결과를 참조합니다.', 'References a task skipped by its condition.');
        }
        if (!task.when) { return undefined; }
        const gateContext = Object.assign(Object.create(null), stepResults, {
            workspaceFolder: workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            extensionPath: context.extensionPath,
        });
        const resolved = interpolatePipelineVariables(task.when.var, gateContext);
        if (evaluateTaskCondition(task.when, resolved)) { return undefined; }
        // **판정에 쓴 값과 보여 줄 값은 다른 문자열이다.** 이 사유는 그대로
        // 출력 채널에 실리므로(`condition-skipped` 분기), 비밀을 참조하는 조건이
        // 실패하면 평문 비밀번호가 로그에 남는다. 명령줄·cwd·출력이 이미 거치는
        // 그 마스킹을 여기서도 태운다.
        //
        // 컨텍스트를 다시 만드는 이유는 `redactSecretsInContext` 가 전개하면서
        // null 프로토타입을 잃기 때문이다. 탐색은 `ownValue` 가 own property 만
        // 보므로 안전하지만, 두 컨텍스트의 모양을 굳이 어긋나게 둘 이유가 없다.
        const shown = interpolatePipelineVariables(
            task.when.var,
            Object.assign(Object.create(null), redactSecretsInContext(executionRun, gateContext))
        );
        return t(`조건이 맞지 않습니다 (${shown}).`, `Condition not met (${shown}).`);
    };

    const launchTask = (taskId: string): Promise<InFlightOutcome> => {
        const task = taskById.get(taskId)!;
        const taskUsesSecret = taskReferencesSecret(task, executionRun);
        if (taskUsesSecret && executionRun.sensitiveDebug) {
            // Create the record before dispatch. Timeout/spawn failures can
            // happen before a single byte is emitted; the user still deserves
            // a concrete outcome explaining why no raw output exists.
            ensureSensitiveDebugCapture(
                executionRun,
                taskId,
                taskSupportsSensitiveDebugCapture(task),
                task.isOneShot && (task.type === 'command' || task.type === 'shell')
                    ? 'detached-one-shot'
                    : undefined
            );
        }
        scheduler.markStarted(taskId);
        // **'running' 을 알리기 전에 판정한다.** 돌지 않은 태스크가 화면과
        // 히스토리에 "실행됨" 으로 잠깐이라도 보이면 안 된다. markStarted 는
        // 스케줄러 상태 기계가 markCompleted 전에 요구하므로 그대로 둔다.
        const skipReason = conditionGate(task);
        if (skipReason !== undefined) {
            conditionSkipped.add(taskId);
            return Promise.resolve({ taskId, kind: 'condition-skipped' as const, reason: skipReason });
        }
        emitTransition(taskId, 'running');

        const usePreset =
            !!presetInputs &&
            INTERACTIVE_TASK_TYPES.has(task.type) &&
            Object.prototype.hasOwnProperty.call(presetInputs, taskId);
        const isInteractive = INTERACTIVE_TASK_TYPES.has(task.type);
        const presetValue = usePreset ? presetInputs![taskId] : undefined;
        const taskScope = createTaskExecutionScope(executionRun, taskId);
        // Preset values flow through `presetResult` so that
        // `executeSingleTask`'s shared post-processing (capture +
        // `passTheResultToNextTask` output) still runs on replay.
        //
        // Interactive tasks bind the prompt mutex around
        // `executeSingleTask` itself — *not* around the
        // `withTaskTimeout` wrapper — so that a fired timeout reports
        // the failure to the pipeline without releasing the lock. VS
        // Code modal dialogs can't be programmatically dismissed: if
        // we released the mutex on timeout, the next interactive task
        // could open a second dialog on top of the still-visible
        // first one. Holding the lock until the original dialog
        // promise settles keeps the "no two concurrent prompts"
        // guarantee even across a timed-out task.
        const startTask = async (): Promise<unknown> => {
            // 대기열을 빠져나온 시점에 다시 확인한다. 인터랙티브 태스크는
            // 프롬프트 뮤텍스 뒤에 줄을 서므로, 앞 액션의 대화상자가 열려 있는
            // 동안 이 액션이 중지될 수 있다. 여기서 안 막으면 이미 중지된
            // 액션의 modal 이 한참 뒤에 새로 뜨고, itemsFromCommand 라면
            // 취소된 명령을 잠깐이라도 실행하게 된다.
            try {
                throwIfTaskInactive(taskScope);
                return await executeSingleTask(
                    task,
                    stepResults,
                    context,
                    id,
                    workspaceFolderPath,
                    workspaceRoots,
                    presetValue,
                    recordCommands,
                    taskScope,
                    taskUsesSecret
                );
            } finally {
                disposeTaskExecutionScope(taskScope);
            }
        };
        const underlying: Promise<unknown> = isInteractive
            ? withInteractivePromptLock(startTask)
            : startTask();
        // On timeout, kill only this task's child processes and
        // terminate its streamed vscode Task slot. Sibling tasks
        // running in parallel keep going; the failure policy below
        // decides whether the action as a whole aborts.
        const wrapped = withTaskTimeout(underlying, task.timeoutSeconds, taskId, () => {
            timeoutTaskExecution(taskScope);
            terminateChildProcesses(id, taskId, executionRun.generation);
            abortTaskOperations(executionRun, taskId);
            const exec = getActiveTaskExecution(id, taskId, executionRun.generation);
            if (exec) {
                try { exec.terminate(); } catch { /* ignore */ }
            }
        });

        return wrapped.then(
            (result): InFlightOutcome => {
                if (taskUsesSecret) {
                    finishSensitiveDebugCapture(
                        executionRun,
                        taskId,
                        task.isOneShot && (task.type === 'command' || task.type === 'shell')
                            ? 'launched'
                            : 'success'
                    );
                }
                return { taskId, kind: 'success', result };
            },
            (error): InFlightOutcome => {
                const raw = error instanceof Error ? error : new Error(String(error));
                if (taskUsesSecret && executionRun.sensitiveDebug) {
                    finishSensitiveDebugCapture(
                        executionRun,
                        taskId,
                        'failure',
                        describeSensitiveFailure(raw, maskedCommandForTask(taskId)),
                        raw instanceof ShellCommandError ? undefined : raw.message
                    );
                }
                // 어느 태스크의 프롬프트였는지는 여기서만 확실히 안다.
                if (raw instanceof PromptCancelledError && raw.taskId === undefined) {
                    raw.taskId = taskId;
                }
                // 취소는 중지와 마찬가지로 **비밀 실패가 아니다.** 감싸 버리면
                // 상세가 가려지고 "민감 디버그로 다시 실행" 제안까지 뜬다 —
                // 사용자는 그냥 다이얼로그를 닫았을 뿐인데.
                const e = taskUsesSecret && !(raw instanceof ActionStoppedError) && !(raw instanceof PromptCancelledError)
                    ? new SensitiveTaskError(taskId, describeSensitiveFailure(raw, maskedCommandForTask(taskId)))
                    : raw;
                // 사용자 중지는 `continueOnError` 보다 우선한다. 그 설정의 뜻은
                // "이 태스크가 실패해도 나머지는 계속"이지 "사용자가 멈추라고
                // 해도 계속"이 아니다. 구분하지 않으면 중지가 `skipped` 로
                // 바뀌어 뒤 태스크가 실행되고, 액션이 성공으로 마감되면서
                // 방금 기록한 "Action stopped by user" 를 덮는다 — 0.6.29 와
                // 0.6.35 가 고친 증상이 이 설정 한 줄로 되살아나던 경로다.
                if (executionRun.cancellation.token.isCancellationRequested || executionRun.abandoned || executionRun.closed) {
                    return { taskId, kind: 'failed', error: e };
                }
                return task.continueOnError
                    ? { taskId, kind: 'skipped', error: e }
                    : { taskId, kind: 'failed', error: e };
            }
        );
    };

    try {
    // Main scheduling loop. Each iteration: (1) launch every newly
    // ready task subject to `maxConcurrency`; (2) await the next
    // outcome via `Promise.race`; (3) update scheduler state and
    // stepResults. Continues until the scheduler reports finished —
    // either every task settled, or a hard failure aborted new
    // scheduling and all in-flight tasks have drained.
    while (!scheduler.isFinished()) {
        if (!scheduler.isAborted()) {
            for (const tid of scheduler.nextReady()) {
                inFlight.set(tid, launchTask(tid));
            }
        }

        if (inFlight.size === 0) {
            // Validator should have caught any case where this is
            // reachable. Fail loudly rather than infinite-loop.
            throw new Error(`Pipeline scheduler stalled in action '${id}'.`);
        }

        const outcome = await Promise.race(inFlight.values());
        inFlight.delete(outcome.taskId);

        if (outcome.kind === 'success') {
            scheduler.markCompleted(outcome.taskId);
            stepResults[outcome.taskId] = outcome.result;
            // 담은 **뒤에** 잰다. 결과를 버리고 실패시키는 것보다, 이 태스크까지는
            // 정상으로 두고 다음 태스크를 띄우지 않는 편이 상태가 일관된다.
            accumulatedResultBytes += approximateResultBytes(outcome.result);
            if (accumulatedResultBytes > totalResultLimit) {
                const limitMb = Math.round(totalResultLimit / (1024 * 1024));
                const limitError = new Error(t(
                    `태스크 결과 총량이 ${limitMb}MB 한도를 초과했습니다. \`taskhub.pipeline.totalOutputLimitMb\` 설정을 높이거나, 큰 출력을 캡처하지 않도록 태스크를 나누세요.`,
                    `Combined task output exceeded the ${limitMb} MB limit. Raise \`taskhub.pipeline.totalOutputLimitMb\`, or split the task so the large output is not captured.`
                ));
                // 던지기 **전에** 형제를 멈춘다. 그냥 던지면 액션은 실패로
                // 끝나는데 병렬 형제의 빌드·플래싱은 계속 돈다.
                await abortInFlightTasks();
                throw limitError;
            }
            if (recordInputs) {
                const t = taskById.get(outcome.taskId);
                if (t && shouldRecordTaskInput(t) && !executionRun.secretTaskIds.has(outcome.taskId)) {
                    recordInputs[outcome.taskId] = outcome.result;
                }
            }
            emitTransition(outcome.taskId, 'success');
        } else if (outcome.kind === 'condition-skipped') {
            const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
            if (showVerboseLogs) {
                outputChannel.appendLine(`[INFO] Task '${outcome.taskId}' skipped — ${outcome.reason}`);
            }
            // `continueOnError` 의 skip 과 같은 모양으로 둔다: 뒤 태스크의
            // `${task.*}` 참조가 "못 찾음 → 리터럴" 경로를 타게 된다.
            stepResults[outcome.taskId] = {};
            scheduler.markCompleted(outcome.taskId);
            emitTransition(outcome.taskId, 'skipped');
        } else if (outcome.kind === 'skipped') {
            const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
            if (showVerboseLogs) {
                outputChannel.appendLine(
                    `[WARN] Task '${outcome.taskId}' failed but 'continueOnError' is true — continuing: ${outcome.error.message}`
                );
            }
            // Empty object matches the sequential behavior so downstream
            // `${task.*}` references fall through to the "unmatched →
            // literal" path in `interpolatePipelineVariables`.
            stepResults[outcome.taskId] = {};
            scheduler.markCompleted(outcome.taskId);
            emitTransition(outcome.taskId, 'skipped');
        } else {
            scheduler.markFailed(outcome.taskId);
            emitTransition(outcome.taskId, 'failure');
            failures.push({ taskId: outcome.taskId, error: outcome.error });
        }
    }

    if (failures.length === 1) {
        // Single failure — throw the original error unchanged so the
        // existing error.message / stack / `instanceof` checks in
        // `handleActionFailure` and test assertions keep working.
        throw failures[0].error;
    }
    if (failures.length > 1) {
        const summary = failures.map(f => `${f.taskId}: ${f.error.message}`).join('; ');
        throw new AggregateError(
            failures.map(f => f.error),
            `Action '${id}' had ${failures.length} task failures — ${summary}`
        );
    }
    } finally {
        if (isParallelAction) { exitParallelAction(id); }
    }
}

function handleActionSuccess(id: string, action: PipelineAction, showTaskStatus: boolean): void {
    // State transitions are always tracked so that the duplicate-run guard in
    // markActionAsRunning() stays accurate regardless of the `showTaskStatus` setting.
    actionStates.set(id, { state: 'success' });
    if (showTaskStatus && action.successMessage) {
        vscode.window.showInformationMessage(action.successMessage);
    }
}

/**
 * 민감 디버그 재실행을 **한 번** 요청받아 수행한다.
 *
 * 정책은 "기본은 안전한 메타데이터만, 필요할 때 사용자가 명시적으로 승인한
 * 단일 실행에서만 상세 출력"이다. 그래서:
 *
 *   - 모달로 경고하고 동의를 받는다(액션이 **다시 실행된다**는 것도 함께).
 *   - 플래그는 그 실행의 컨텍스트에만 서고, 끝나면 컨텍스트와 함께 사라진다.
 *   - 원본은 읽기 전용 임시 webview 로 한 번 보여 준다 — dirty untitled
 *     문서가 아니므로 hot-exit/자동 백업 대상이 아니며, History·Problems·
 *     출력 채널에도 넣지 않는다.
 *   - 영구 설정으로 켜 두는 방법은 두지 않는다.
 */
async function offerSensitiveDebugRerun(
    actionItem: ActionItem,
    context: vscode.ExtensionContext,
    mainViewProvider: MainViewProvider,
    historyProvider: HistoryProvider | undefined,
    failureMessage: string
): Promise<void> {
    const debugLabel = t('민감 디버그로 한 번 다시 실행', 'Re-run once with sensitive debug');
    const picked = await vscode.window.showErrorMessage(failureMessage, debugLabel);
    if (picked !== debugLabel) { return; }

    const proceed = t('다시 실행', 'Re-run');
    const confirmed = await vscode.window.showWarningMessage(
        t(
            `'${actionItem.title}' 액션을 다시 실행하고, 이번 실행에 한해 숨겨진 출력을 그대로 보여 줍니다.\n\n` +
            '출력에 비밀번호가 그대로 또는 변형된 형태로 들어 있을 수 있습니다. ' +
            '액션이 실제로 다시 수행되므로 빌드·플래시 같은 부수 효과도 다시 일어납니다.',
            `This re-runs '${actionItem.title}' and, for this run only, shows the output that is normally hidden.\n\n` +
            'That output may contain the password verbatim or in an encoded form. ' +
            'The action really runs again, so side effects such as building or flashing happen again.'
        ),
        { modal: true },
        proceed
    );
    if (confirmed !== proceed) { return; }

    pendingSensitiveDebugActionIds.add(actionItem.id);
    try {
        await executeAction(actionItem, context, mainViewProvider, historyProvider);
    } catch {
        // 재실행의 실패는 평소 경로가 이미 알린다. 여기서 또 띄우지 않는다.
    } finally {
        // 사용자가 취소해 실행이 시작조차 못 한 경우를 대비해 확실히 지운다.
        pendingSensitiveDebugActionIds.delete(actionItem.id);
    }
}

function escapeSensitiveDebugHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sensitiveDebugEmptyReason(capture: SensitiveDebugCapture): string {
    if (capture.outputUnavailableReason === 'detached-one-shot') {
        return t(
            'detached one-shot 출력은 터미널 노출과 extension host 종속을 피하기 위해 의도적으로 폐기했습니다.',
            'Detached one-shot output was intentionally discarded to avoid terminal exposure and extension-host coupling.'
        );
    }
    if (!capture.captureSupported) {
        return t(
            '이 태스크 유형은 stdout/stderr 스트림을 제공하지 않습니다.',
            'This task type does not expose stdout/stderr streams.'
        );
    }
    switch (capture.detail?.stage) {
        case 'start':
            return t('프로세스가 시작되지 않아 출력이 없습니다.', 'The process did not start, so no output was produced.');
        case 'timeout':
            return t('시간 초과 전에 받은 출력이 없습니다.', 'No output was received before the timeout.');
        case 'capture-limit':
            return t('출력 한도에 도달하기 전에 보존된 출력이 없습니다.', 'No output was retained before the capture limit was reached.');
        default:
            return t('태스크가 stdout/stderr를 출력하지 않았습니다.', 'The task produced no stdout/stderr output.');
    }
}

const SENSITIVE_DEBUG_DISPLAY_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Take a UTF-8-bounded prefix without first materializing a Buffer for the
 * entire value. outputCaptureLimitMb can be configured up to 1 GiB; copying
 * that whole string into HTML and then escaping it would create several
 * simultaneous GiB-sized allocations.
 */
function takeSensitiveDebugPrefix(
    value: string,
    maxBytes: number
): { text: string; bytes: number; truncated: boolean } {
    if (value.length === 0) { return { text: '', bytes: 0, truncated: false }; }
    if (maxBytes <= 0) { return { text: '', bytes: 0, truncated: true }; }

    const pieces: string[] = [];
    let offset = 0;
    let bytes = 0;
    const chunkCharacters = 64 * 1024;
    while (offset < value.length && bytes < maxBytes) {
        const end = Math.min(value.length, offset + chunkCharacters);
        const chunk = value.slice(offset, end);
        const chunkBytes = Buffer.byteLength(chunk, 'utf8');
        if (chunkBytes <= maxBytes - bytes) {
            pieces.push(chunk);
            bytes += chunkBytes;
            offset = end;
            continue;
        }

        let low = 0;
        let high = chunk.length;
        const remaining = maxBytes - bytes;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (Buffer.byteLength(chunk.slice(0, mid), 'utf8') <= remaining) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        // Avoid ending the displayed prefix with an unmatched high surrogate.
        if (low > 0 && /[\uD800-\uDBFF]/.test(chunk.charAt(low - 1))) { low--; }
        const prefix = chunk.slice(0, low);
        pieces.push(prefix);
        bytes += Buffer.byteLength(prefix, 'utf8');
        offset += low;
        break;
    }
    return { text: pieces.join(''), bytes, truncated: offset < value.length };
}

/**
 * 원본 출력을 읽기 전용 임시 webview 로 한 번 보여 준다.
 *
 * Webview serializer를 등록하지 않으므로 창을 닫거나 VS Code를 다시 열면
 * 복원되지 않는다. enableScripts/localResourceRoots도 막아 원본이 다른 표면으로
 * 이동할 경로를 두지 않는다.
 */
function showSensitiveDebugOutput(
    actionTitle: string,
    captures: Iterable<SensitiveDebugCapture>
): void {
    const header = t(
        `민감 디버그 — '${actionTitle}'\n` +
        '이 읽기 전용 화면은 저장·자동 백업되지 않습니다. 비밀번호가 포함돼 있을 수 있으니 공유 전에 확인하세요.',
        `Sensitive debug — '${actionTitle}'\n` +
        'This read-only view is not persisted or automatically backed up. It may contain the password — check before sharing.'
    );
    const rows = Array.from(captures);
    let remainingRawBytes = SENSITIVE_DEBUG_DISPLAY_LIMIT_BYTES;
    const omittedNotice = t(
        '[... 민감 디버그 표시 한도 4MiB를 넘어 나머지 출력을 생략했습니다 ...]',
        '[... remaining output omitted: sensitive debug display is capped at 4 MiB ...]'
    );
    /**
     * `alreadyTruncated` 를 반드시 함께 본다.
     *
     * 원본은 **수집 단계에서 이미** 표시 한도로 잘린다. 그래서 여기서 다시
     * 자를 것이 없고, 이 함수의 `part.truncated` 만 보면 잘렸다는 사실이
     * 화면에서 사라진다 — 사용자는 5MiB 중 4MiB만 보면서 그것이 전부라고
     * 읽는다. 수집 단계가 남긴 플래그가 그 정보를 들고 있다.
     */
    const takeRaw = (value: string, alreadyTruncated?: boolean): string => {
        const part = takeSensitiveDebugPrefix(value, remainingRawBytes);
        remainingRawBytes -= part.bytes;
        return part.text + (part.truncated || alreadyTruncated ? `\n${omittedNotice}` : '');
    };
    const sections = rows.length > 0
        ? rows.map(capture => {
            const detail = capture.detail
                ? `${sensitiveStageLabel(capture.detail.stage)}` +
                    (typeof capture.detail.exitCode === 'number' ? ` (${t('종료 코드', 'exit code')} ${capture.detail.exitCode})` : '')
                : '';
            const outcome = capture.outcome === 'success'
                ? t('성공', 'success')
                : capture.outcome === 'failure'
                    ? t('실패', 'failure')
                    : capture.outcome === 'launched' ? t('시작됨', 'launched') : t('실행 중', 'running');
            const noOutput = capture.stdout.length === 0 && capture.stderr.length === 0 && !capture.rawErrorMessage
                ? `\n${sensitiveDebugEmptyReason(capture)}\n`
                : '';
            const rawError = capture.rawErrorMessage
                ? `\n--- ${t('원본 실패 메시지', 'raw failure message')} ---\n${takeRaw(capture.rawErrorMessage, capture.rawErrorMessageTruncated)}\n`
                : '';
            const stdout = takeRaw(capture.stdout, capture.stdoutTruncated);
            const stderr = takeRaw(capture.stderr, capture.stderrTruncated);
            return `## ${t('태스크', 'Task')} '${capture.taskId}' — ${outcome}${detail ? ` / ${detail}` : ''}` +
                `${noOutput}${rawError}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
        }).join('\n')
        : t(
            '비밀번호에서 파생된 태스크가 이번 재실행에서는 실행되지 않아 표시할 출력이 없습니다.',
            'No password-derived task ran during this re-run, so there is no output to display.'
        );
    const text = `${header}\n\n${sections}`;
    const panel = vscode.window.createWebviewPanel(
        'taskhubSensitiveDebug',
        t('TaskHub 민감 디버그', 'TaskHub Sensitive Debug'),
        vscode.ViewColumn.Active,
        {
            enableScripts: false,
            retainContextWhenHidden: false,
            localResourceRoots: [],
        }
    );
    panel.webview.html = '<!DOCTYPE html><html><head>' +
        '<meta charset="UTF-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';">' +
        '</head><body><pre>' + escapeSensitiveDebugHtml(text) + '</pre></body></html>';
}

/**
 * 다음 실행에서 민감 디버그를 켤 액션 id.
 *
 * `executeAction` 이 실행 컨텍스트를 만든 직후 소비하고 **즉시 지운다** —
 * 남겨 두면 그 뒤의 평범한 실행까지 원본을 노출한다.
 */
const pendingSensitiveDebugActionIds = new Set<string>();

/**
 * 테스트 전용 — 다음 실행 하나에만 민감 디버그를 건다.
 *
 * 실제 경로는 알림 → 모달 동의를 거치는데, 그 UI 를 테스트에서 몰아가는 것은
 * 검증하려는 것(플래그가 **한 번만** 쓰이는가)과 무관한 배선이다.
 */
export function __testHook_requestSensitiveDebug(actionId: string): void {
    pendingSensitiveDebugActionIds.add(actionId);
}

function handleActionFailure(id: string, actionItem: ActionItem, action: PipelineAction, error: Error, showTaskStatus: boolean): void {
    actionStates.set(id, { state: 'failure' });
    if (!showTaskStatus) {
        return;
    }
    if (action.failMessage) {
        vscode.window.showErrorMessage(`${action.failMessage}: ${error.message}`);
    } else {
        vscode.window.showErrorMessage(t(`'${actionItem.title}' 액션 실패: ${error.message}`, `Action '${actionItem.title}' failed: ${error.message}`));
    }
}

/**
 * Ids of actions currently in flight. Single source for both the
 * `taskhub.hasRunningActions` context key (which gates the *Stop All
 * Actions* title-bar button) and the stop-all target list, so the button
 * can never be visible with nothing to stop.
 *
 * Deliberately independent of `taskhub.showTaskStatus`: that setting hides
 * status *icons*, but a user who turned icons off still needs a way to stop
 * a runaway build.
 */
export function collectRunningActionIds(
    states: ReadonlyMap<string, { state: ActionRunState; progress?: ActionProgress }> = actionStates
): string[] {
    const ids: string[] = [];
    for (const [id, value] of states) {
        if (value.state === 'running') { ids.push(id); }
    }
    return ids;
}

/** Max action titles listed in the stop-all confirmation before collapsing to a count. */
export const STOP_ALL_CONFIRM_TITLE_LIMIT = 5;

/**
 * Body text for the stop-all confirmation. The user clicked a bulk
 * destructive button, so the dialog names *what* is about to die rather
 * than asking an abstract "are you sure?" — a forgotten long-running build
 * in the list is exactly the case this guard exists for.
 *
 * Long lists collapse after `STOP_ALL_CONFIRM_TITLE_LIMIT` entries so the
 * modal can't grow past the screen.
 */
export function formatStopAllConfirmMessage(titles: readonly string[], lang: 'ko' | 'en' = 'ko'): string {
    const shown = titles.slice(0, STOP_ALL_CONFIRM_TITLE_LIMIT);
    const overflow = titles.length - shown.length;
    const lines = shown.map(title => `· ${title}`);
    if (overflow > 0) {
        lines.push(lang === 'ko' ? `· 외 ${overflow}개` : `· and ${overflow} more`);
    }
    const header = lang === 'ko'
        ? `실행 중인 액션 ${titles.length}개를 중지할까요?`
        : `Stop ${titles.length} running action(s)?`;
    return `${header}\n\n${lines.join('\n')}`;
}

export type StopAllOutcome = 'none' | 'cancelled' | 'stopped' | 'failed' | 'already-finished';

/**
 * Everything {@link runStopAllActions} is allowed to touch.
 *
 * Note what is *absent*: nothing here can clear `manuallyTerminatedActions`.
 * The active generation owns that flag until `finalizeActionRun` (a later
 * generation may defensively discard stale state at startup). 0.6.13 shipped
 * a bulk-stop path that deleted
 * it synchronously right after `terminate()`. Task termination lands
 * asynchronously, so by the time `executeAction`'s catch checked the flag it
 * was gone: the user got a spurious failure toast, the freshly written
 * "Action stopped by user" history entry was overwritten by the termination
 * error, and the ✗ icon stuck around. Keeping flag ownership out of this
 * interface makes that class of regression unrepresentable.
 */
export interface StopAllActionsDeps {
    /** Ids worth stopping: running states ∪ active tasks ∪ live child processes. */
    collectTargets(): string[];
    /** Display name for a target id; falls back to the id itself. */
    titleOf(id: string): string;
    /** Modal confirmation. Only consulted when more than one action would die. */
    confirm(titles: string[]): Promise<boolean>;
    /** Terminate one action. `true` when something was actually stopped. */
    stop(id: string): boolean;
    /** Close out the stopped action's history entry. */
    recordStop(id: string): void;
    /** Refresh the tree / context key once the batch is done. */
    afterStop(): void;
    /** User-facing result. */
    report(outcome: StopAllOutcome, stoppedTitles: string[]): void;
}

/**
 * Stop-all orchestration, isolated from VS Code so the confirm / cancel /
 * partial-failure paths are unit-testable.
 */
export async function runStopAllActions(deps: StopAllActionsDeps): Promise<StopAllOutcome> {
    const targets = deps.collectTargets();
    if (targets.length === 0) {
        deps.report('none', []);
        return 'none';
    }

    if (targets.length > 1) {
        const confirmed = await deps.confirm(targets.map(id => deps.titleOf(id)));
        if (!confirmed) {
            deps.report('cancelled', []);
            return 'cancelled';
        }
    }

    const stopped: string[] = [];
    for (const id of targets) {
        if (deps.stop(id)) {
            deps.recordStop(id);
            stopped.push(id);
        }
    }
    deps.afterStop();

    // Nothing stopped has two very different causes. The targets may have
    // finished on their own while the confirmation modal was up — a benign
    // race, and warning "no active tasks could be stopped" for it reads like
    // something went wrong. Re-collecting distinguishes them: an empty list
    // now means they simply ended.
    let outcome: StopAllOutcome;
    if (stopped.length > 0) {
        outcome = 'stopped';
    } else {
        outcome = deps.collectTargets().length === 0 ? 'already-finished' : 'failed';
    }
    deps.report(outcome, stopped.map(id => deps.titleOf(id)));
    return outcome;
}

/**
 * Push the running/idle state into a `when`-clause context key. Fire and
 * forget: `setContext` is a UI hint, and a failure must never break the
 * execution path that called us.
 */
function syncRunningActionsContext(): void {
    void vscode.commands.executeCommand(
        'setContext',
        'taskhub.hasRunningActions',
        collectRunningActionIds().length > 0
    );
}

/**
 * Terminate one action's tasks and child processes. Shared by
 * `taskhub.stopAction` (single row) and `taskhub.stopAllActions` (bulk) so
 * both paths mark `manuallyTerminatedActions` identically — that flag is
 * what tells `executeAction`'s catch to skip the failure toast.
 *
 * Exported for tests: the bundled extension (`dist/`) and the compiled tests
 * (`out/`) are separate module instances, so driving this through
 * `vscode.commands.executeCommand` would act on the *bundle's* registries
 * while the test's `executeAction` populated the test module's. Calling it
 * directly keeps both sides in one instance.
 */
export function stopRunningAction(id: string): boolean {
    let stopped = false;
    const markCurrentRunStopped = () => {
        // Detached/one-shot leftovers may still be present after their owning
        // action finalized. There is no executeAction catch left to consume a
        // manual-stop flag for those, so do not poison the next run.
        if (currentActionRuns.has(id)) { manuallyTerminatedActions.add(id); }
    };
    const perAction = activeTasks.get(id);
    if (perAction && perAction.size > 0) {
        markCurrentRunStopped();
        for (const active of perAction.values()) {
            try { active.execution.terminate(); } catch { /* ignore */ }
        }
        stopped = true;
    }
    if (terminateChildProcesses(id)) {
        markCurrentRunStopped();
        stopped = true;
    }
    // An action waiting on a prompt has no task and no child process, so the
    // two branches above find nothing — yet it is running and the user asked
    // it to stop. Cancelling the token dismisses `inputBox` / `quickPick`
    // outright; for a native file dialog it records the request so the run
    // aborts the moment the dialog returns.
    const cancellation = actionCancellations.get(id);
    if (cancellation && !cancellation.token.isCancellationRequested) {
        markCurrentRunStopped();
        cancellation.cancel();
        stopped = true;
    }
    return stopped;
}

/**
 * Close out the history entry of a manually stopped action.
 *
 * `executeAction` skips its own history finalize for manually terminated
 * ids (the failure there isn't the action's fault), so without this the
 * entry would stay `running` forever — a permanent spinner in the History
 * panel and a permanent "실행 중" badge in the Run Any Action palette.
 */
function recordManualStopInHistory(provider: HistoryProvider | undefined, id: string): void {
    const timestamp = actionStartTimestamps.get(id);
    if (!provider || !timestamp) { return; }
    const durationMs = Math.max(0, Date.now() - timestamp);
    // History 의 이유 문구는 우클릭 → View Output 으로 **사용자에게 보인다**.
    // 프롬프트 취소 쪽을 지역화하면서 이쪽만 영어로 남으면, 같은 회색 아이콘
    // 아래 한국어와 영어가 섞인다.
    provider.updateHistoryStatus(
        id, timestamp, 'cancelled',
        t('사용자가 실행을 중지했습니다.', 'Action stopped by the user.'),
        durationMs, 'stopped'
    );
}

function isCurrentActionRun(run: ActionRunContext): boolean {
    return currentActionRuns.get(run.id) === run;
}

function finalizeActionRun(run: ActionRunContext, showTaskStatus: boolean, mainViewProvider: MainViewProvider): void {
    const id = run.id;
    const ownsCurrentState = isCurrentActionRun(run);
    // Owned by the run, so it dies with the run. Leaving a cancelled source
    // behind would make the *next* run of the same action abort on its first
    // token check.
    endActionCancellation(run);
    if (!ownsCurrentState) {
        return;
    }
    actionStartTimestamps.delete(id);
    if (manuallyTerminatedActions.has(id)) {
        actionStates.delete(id);
        manuallyTerminatedActions.delete(id);
    } else {
        // Action ran to completion (success / failure). Clear the
        // mid-run progress hint so the description doesn't keep
        // showing "2/3 · link" after the action terminates — the
        // iconPath (✓/✗) is the appropriate post-run signal.
        const state = actionStates.get(id);
        if (state && state.progress) {
            actionStates.set(id, { state: state.state });
        }
    }
    syncRunningActionsContext();
    if (showTaskStatus) {
        mainViewProvider.refresh();
    }
}

export async function executeAction(
    actionItem: ActionItem,
    context: vscode.ExtensionContext,
    mainViewProvider: MainViewProvider,
    historyProvider?: HistoryProvider,
    presetInputs?: Record<string, unknown>,
    actionPathParts?: string[]
) {
    const resolved = resolveActionDefinition(actionItem);
    if (!resolved) {
        return;
    }

    const { action, id } = resolved;
    const actionWorkspaceFolder = id ? actionWorkspaceFolderMap.get(id) : undefined;
    const showTaskStatus = vscode.workspace.getConfiguration('taskhub').get('showTaskStatus', true);

    const run = markActionAsRunning(actionItem, id, showTaskStatus, mainViewProvider);
    if (!run) {
        return;
    }

    // Clear diagnostics this action emitted on a previous run so stale
    // compiler errors / warnings don't linger in the Problems panel. New
    // diagnostics from this run are emitted by `output.diagnostics` matchers
    // inside `executeSingleTask`.
    clearActionDiagnostics(id);

    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
    logActionStart(showVerboseLogs, actionItem.title, action.description);

    // Add history entry
    const timestamp = Date.now();
    actionStartTimestamps.set(id, timestamp);
    if (historyProvider) {
        // Resolve breadcrumb path so HistoryItem can disambiguate same-title
        // actions in different folders. Caller-supplied `actionPathParts`
        // wins (cheap when caller already iterated the action tree); the
        // fallback re-loads the action tree once. Both branches may yield
        // `undefined` for actions sitting at the root — that's fine, the
        // History panel only adds the prefix when there's an actual title
        // collision so root-level actions render bare either way.
        let resolvedPath = actionPathParts;
        if (!resolvedPath) {
            try {
                resolvedPath = findActionPathById(loadAllActions(context), id);
            } catch {
                // loadAllActions can throw on validation errors. Disambiguation
                // is a nice-to-have — never block execution over it.
                resolvedPath = undefined;
            }
        }
        historyProvider.addHistoryEntry({
            actionId: id,
            actionTitle: actionItem.title,
            timestamp: timestamp,
            status: 'running',
            actionPath: resolvedPath
        });
    }

    // Accumulator for interactive task inputs — attached to the history
    // entry below so a later "Re-run with saved inputs" can replay them.
    const recordInputs: Record<string, unknown> = {};

    // Accumulator for resolved command lines — attached to the history entry
    // below so "실행한 명령 보기" can show what ran without re-executing.
    const recordCommands: Record<string, string> = {};

    try {
        await executeActionPipelineForRun(action, context, id, actionWorkspaceFolder, undefined, {
            presetInputs,
            recordInputs,
            recordCommands,
            // Surface "지금 어디" progress on the Actions panel. We only
            // mutate the existing actionStates entry (markActionAsRunning
            // already set state='running') and refresh the tree.
            // Single-task actions intentionally skip the description so
            // "1/1" noise never shows up — see Action TreeItem render
            // logic.
            //
            // Multi-track update (0.4.43): running events push the task
            // into `progress.running`; terminal events (success/failure/
            // skipped) pop it back out and bump `completed`. Parallel
            // pipelines see multiple ids in flight at once — the tree
            // renderer picks the right format per running.length.
            onTaskTransition: (event) => {
                if (!showTaskStatus || !isCurrentActionRun(run)) {
                    return;
                }
                const current = actionStates.get(id);
                if (!current) {
                    return;
                }
                const previous = current.progress;
                const total = event.total > 0 ? event.total : (previous?.total ?? 0);
                const running = previous ? [...previous.running] : [];
                let completed = previous?.completed ?? 0;
                if (event.state === 'running') {
                    if (!running.some(entry => entry.taskId === event.taskId)) {
                        running.push({ taskId: event.taskId, index: event.index });
                    }
                } else {
                    const at = running.findIndex(entry => entry.taskId === event.taskId);
                    if (at !== -1) { running.splice(at, 1); }
                    completed++;
                }
                actionStates.set(id, {
                    state: current.state,
                    progress: { total, completed, running }
                });
                mainViewProvider.refresh();
            }
        }, run);
        if (!isCurrentActionRun(run)) {
            throw new ActionStoppedError();
        }
        // 사용자가 중지를 눌렀는데 파이프라인이 그래도 완주한 경우가 있다.
        // 취소 신호를 받지 않는 작업(내장 ZIP/Unzip 등)이 마지막 태스크이거나
        // 유일한 태스크면, 중지 이후에도 그 작업이 끝까지 돌고 여기로 온다.
        // 그대로 두면 방금 기록한 "Action stopped by user" 를 **성공이
        // 덮어써서** 사용자는 중지가 무시된 것도 모른 채 성공했다고 읽는다.
        // 실패 경로에는 예전부터 같은 가드가 있었다(아래 catch).
        if (manuallyTerminatedActions.has(id)) {
            throw new ActionStoppedError();
        }

        // A debug re-run that succeeds is just as useful as one that fails:
        // deploy/flash tools often print the decisive clue and still return 0.
        // Always show a report, including an explicit no-output explanation.
        if (run.sensitiveDebug) {
            showSensitiveDebugOutput(actionItem.title, run.sensitiveDebugCaptures.values());
        }

        handleActionSuccess(id, action, showTaskStatus);

        // Update history to success — `Math.max(0, ...)` defends against
        // wall-clock skew (NTP backward correction) producing a negative
        // duration that would persist into workspaceState. Display-side
        // also handles negatives (formatDuration → "0ms"), but clamping
        // here keeps the stored data clean for any future consumer.
        if (historyProvider) {
            const durationMs = Math.max(0, Date.now() - timestamp);
            historyProvider.updateHistoryStatus(id, timestamp, 'success', undefined, durationMs);
            historyProvider.setHistoryInputs(id, timestamp, recordInputs);
            historyProvider.setHistoryCommands(id, timestamp, recordCommands);
        }
    } catch (error: any) {
        const ownsCurrentState = isCurrentActionRun(run);
        const manuallyStopped = ownsCurrentState && manuallyTerminatedActions.has(id);
        // 대화형 프롬프트를 사용자가 닫아서 끝난 실행은 **실패가 아니다.**
        // Stop 버튼과 같은 부류이므로 같은 마감을 쓴다 — `PromptCancelledError`
        // 주석 참조. (태스크 수준에서는 여전히 실패라 `continueOnError` 는
        // 그대로 동작한다. 여기까지 올라왔다는 것은 그 설정이 없었다는 뜻이다.)
        const promptCancelled = !manuallyStopped && isOnlyPromptCancellation(error);
        if (!manuallyStopped && !promptCancelled) {
            // 민감 디버그 실행이었다면 결과 종류와 무관하게 보고서를 한 번
            // 보여 준다. timeout/spawn 실패처럼 출력이 없어도 이유가 표시된다.
            if (run.sensitiveDebug) {
                showSensitiveDebugOutput(actionItem.title, run.sensitiveDebugCaptures.values());
            }
            if (ownsCurrentState) {
                // The debug offer below is asynchronous and can immediately
                // start the same action again when UI APIs are mocked/resolved.
                // Transition first so the duplicate-run guard never sees the
                // failed generation as still running.
                actionStates.set(id, { state: 'failure' });
                // 비밀을 쓰는 태스크의 실패는 상세가 가려져 있다. 그대로 두면
                // 사용자가 원인에 접근할 방법이 없으므로, 일회성 재실행을
                // 제안한다 (이미 민감 디버그로 돌린 실행에는 제안하지 않는다).
                if (containsSensitiveTaskError(error) && !run.sensitiveDebug && showTaskStatus) {
                    void offerSensitiveDebugRerun(
                        actionItem, context, mainViewProvider, historyProvider,
                        t(`'${actionItem.title}' 액션 실패: ${error.message}`,
                          `Action '${actionItem.title}' failed: ${error.message}`)
                    );
                } else {
                    handleActionFailure(id, actionItem, action, error, showTaskStatus);
                }
            }

            // Update history to failure
            if (historyProvider) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const durationMs = Math.max(0, Date.now() - timestamp);
                historyProvider.updateHistoryStatus(id, timestamp, 'failure', errorMessage, durationMs);
                // Persist whatever inputs were captured before the failure
                // — partial replay is still useful when a later task fails.
                historyProvider.setHistoryInputs(id, timestamp, recordInputs);
                historyProvider.setHistoryCommands(id, timestamp, recordCommands);
            }

            throw error;
        } else if (promptCancelled) {
            // 사용자가 프롬프트를 닫았다. 오류 토스트를 띄우지 않고 History 에
            // `cancelled` 로 남긴다.
            //
            // 진행 상황은 상태를 지우기 **전에** 붙잡아 둔다 — 아래에서 "이미
            // 몇 개가 실행됐는가" 로 안내 여부를 가르는 근거다.
            const progressSnapshot = actionStates.get(id)?.progress;
            if (ownsCurrentState) {
                // `finalizeActionRun` 은 `manuallyTerminatedActions` 에 있는
                // 액션만 상태를 지운다. 이쪽은 그 집합에 넣지 않으므로(중지가
                // 아니라 프로세스를 죽일 것도 없다) 여기서 직접 지운다 —
                // 안 지우면 상태가 `running` 인 채로 남아 트리에 스피너가
                // 영원히 돈다.
                actionStates.delete(id);
            }
            const reason = error instanceof Error ? error.message : String(error);
            // **흔적은 남긴다.** 예전에는 이 오류가 위로 던져져 명령 래퍼가
            // `[ERROR] Execution failed for action …` 을 출력 채널에 적었다.
            // 이제 던지지 않으므로 그 줄도 사라졌는데, 그러면 "왜 배포가
            // 중간에 멈췄지?" 를 확인할 곳이 History 우클릭밖에 없다.
            const cancelledTaskIds = promptCancellationTaskIds(error);
            const atPart = cancelledTaskIds.length > 0 ? ` at task '${cancelledTaskIds.join("', '")}'` : '';
            outputChannel.appendLine(`[INFO] Action '${actionItem.title}' was canceled${atPart}: ${reason}`);
            // 아직 아무 태스크도 끝나지 않았다면 조용히 끝내는 것이 맞다 —
            // 사용자가 방금 닫은 다이얼로그가 그 액션의 전부였다. 하지만
            // **이미 실행된 태스크가 있으면** 부작용(파일 생성·빌드·업로드)이
            // 남은 채 나머지가 실행되지 않은 것이므로, 그 사실은 알려야 한다.
            // 오류가 아니므로 오류 토스트는 쓰지 않는다.
            //
            // 진행도 카운터를 **그대로 쓰면 안 된다.** 그것은 종료 전이마다
            // 올라가므로 방금 취소된 프롬프트까지 "실행됨"으로 세고, 그러면
            // 프롬프트 하나뿐인 액션에서도 안내가 뜬다 —
            // `countPromptCancellations` 주석 참조.
            const ranBefore = Math.max(0, (progressSnapshot?.completed ?? 0) - countPromptCancellations(error));
            if (ownsCurrentState && showTaskStatus && ranBefore > 0) {
                // 전체 개수만 함께 보여 준다. "실행됨 N개 + 남은 M개 = 전체"
                // 형태로 쓰면 취소된 프롬프트가 어느 쪽에도 없어 합이 맞지 않는다.
                const total = progressSnapshot?.total ?? 0;
                vscode.window.showInformationMessage(t(
                    `'${actionItem.title}' 실행을 취소했습니다. 전체 ${total}개 중 이미 실행된 ${ranBefore}개의 결과는 되돌리지 않습니다.`,
                    `Cancelled '${actionItem.title}'. ${ranBefore} of ${total} tasks had already run; their effects are not undone.`
                ));
            }
            if (historyProvider) {
                const durationMs = Math.max(0, Date.now() - timestamp);
                historyProvider.updateHistoryStatus(id, timestamp, 'cancelled', reason, durationMs, 'prompt');
                historyProvider.setHistoryInputs(id, timestamp, recordInputs);
                historyProvider.setHistoryCommands(id, timestamp, recordCommands);
            }
        } else {
            // Action was manually stopped
            if (historyProvider) {
                const durationMs = Math.max(0, Date.now() - timestamp);
                historyProvider.updateHistoryStatus(
                    id, timestamp, 'cancelled',
                    t('사용자가 실행을 중지했습니다.', 'Action stopped by the user.'),
                    durationMs, 'stopped'
                );
                historyProvider.setHistoryInputs(id, timestamp, recordInputs);
                historyProvider.setHistoryCommands(id, timestamp, recordCommands);
            }
        }
    } finally {
        finalizeActionRun(run, showTaskStatus, mainViewProvider);
    }
}

/**
 * 저장된 입력(History 재실행 / 프리셋)이 **현재 정의된 제약**을 여전히 만족하는가.
 *
 * `validatePattern` 은 입력 상자에서만 걸리므로, 재실행 경로가 그것을 건너뛰면
 * 패턴은 "그 순간의 UI 안내" 일 뿐 값에 대한 보장이 아니게 된다. Doctor 가
 * 이 패턴을 근거로 주입 경고를 면제하는 이상, 재실행에서도 같은 제약이
 * 적용돼야 그 면제가 정당해진다.
 *
 * 잘못된 정규식은 입력 시점과 **같게** 무시한다 — 두 경로가 다른 판정을 하면
 * 그것대로 혼란스럽다.
 */
/**
 * 0.6.57 이전 History 에 저장된 다이얼로그 결과에는 `paths` / `names` / `count`
 * 가 없다 (`path` · `dir` · `name` … 뿐). 그대로 재사용하면 재실행에서
 * `${pick.paths}` 가 리터럴로 남는다 — 저장된 입력이 있으면 핸들러 자체를
 * 건너뛰기 때문이다.
 *
 * **단일 선택만 보정한다.** 고른 것이 하나였다면 남아 있는 `path` 로 배열을
 * 그대로 복원할 수 있다. 다중 선택이었다면 첫 항목밖에 남아 있지 않아 복원이
 * 불가능하므로, 보정하지 않고 {@link savedInputStillValid} 가 다시 고르게 한다 —
 * 조용히 하나만 처리하면 "여러 개를 골랐던 실행"이 소리 없이 다른 일을 한다.
 */
export function backfillDialogArrays(task: any, saved: any): any {
    if (task?.type !== 'fileDialog' && task?.type !== 'folderDialog') { return saved; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) { return saved; }
    if (Array.isArray(saved.paths)) { return saved; }
    if (typeof saved.path !== 'string' || saved.path.length === 0) { return saved; }
    return {
        ...saved,
        paths: [saved.path],
        names: [typeof saved.name === 'string' && saved.name.length > 0 ? saved.name : path.basename(saved.path)],
        count: 1,
    };
}

export function savedInputStillValid(task: any, saved: any): boolean {
    // 옛 형식이면서 다중 선택인 다이얼로그는 복원할 수 없다 ({@link backfillDialogArrays}).
    // `value` 검사보다 앞에 둔다 — 다이얼로그 결과에는 `value` 가 없어서
    // 아래 조기 반환에 걸리면 이 검사에 닿지 못한다.
    if ((task?.type === 'fileDialog' || task?.type === 'folderDialog') && task?.options?.canSelectMany === true) {
        if (!saved || typeof saved !== 'object' || !Array.isArray((saved as any).paths)) { return false; }
    }
    const value = saved && typeof saved === 'object' ? saved.value : undefined;
    if (typeof value !== 'string') { return true; }
    if (task.type === 'inputBox' && typeof task.validatePattern === 'string' && task.validatePattern.length > 0) {
        let re: RegExp;
        try {
            re = new RegExp(task.validatePattern);
        } catch {
            return true;
        }
        // prefix/suffix 는 검증 뒤에 붙으므로 검증 대상에서 뺀다 (입력 시점과 동일).
        const prefix = typeof task.prefix === 'string' ? task.prefix : '';
        const suffix = typeof task.suffix === 'string' ? task.suffix : '';
        const core = value.startsWith(prefix) && value.endsWith(suffix)
            ? value.slice(prefix.length, value.length - (suffix.length || 0) || undefined)
            : value;
        return re.test(core);
    }
    if (task.type === 'quickPick' && Array.isArray(task.items) && !task.itemsFromCommand) {
        const labels = task.items.map((entry: any) => (typeof entry === 'string' ? entry : entry?.label));
        // 다중 선택은 저장된 값이 쉼표로 이어진 형태라 그대로 비교할 수 없다.
        if (task.canPickMany === true) { return true; }
        return labels.includes(value);
    }
    return true;
}

async function executeSingleTask(
    task: import('./schema').Task,
    allResults: any,
    context: vscode.ExtensionContext,
    actionId: string,
    workspaceFolderPath?: string,
    workspaceRoots?: string[],
    presetResult?: unknown,
    recordCommands?: Record<string, string>,
    scope?: TaskExecutionScope,
    taskUsesSecret = false
): Promise<any> {
    // The scheduler always supplies its captured generation. Never fall back
    // to the current action-id map here: this function resumes after native
    // dialogs and must not accidentally adopt a newer run of the same id.
    if (!scope) { throw new Error(`Task '${task.id}' is missing its execution scope.`); }
    const executionRun = scope.run;
    // `taskUsesSecret` 은 **앞선** 비밀 태스크를 참조하는지만 본다. 비밀을
    // 직접 만드는 태스크 자신은 `markTaskResultSecret` 이 이 함수 끝에서야
    // 표시하므로, 그때까지는 두 플래그 모두 false 다 — 그 사이에 있는
    // `output.mode` 처리가 비밀번호를 그대로 내보냈다. 출력 가드가 쓸 수
    // 있도록 여기서 미리 계산한다.
    const taskProducesSecret = task.type === 'inputBox' && task.password === true;
    const defaultWorkspace = workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    // null-prototype: 평범한 객체 리터럴로 만들면 `${constructor.name}` 같은
    // **상속 키**가 태스크 결과처럼 해석되어 셸 명령에 들어간다.
    const interpolationContext = Object.assign(Object.create(null), allResults, {
        workspaceFolder: defaultWorkspace,
        extensionPath: context.extensionPath,
    });
    let result: any;
    // Captured by the shell/command branch after `${workspaceFolder}` etc.
    // are resolved. Used by the diagnostic post-processing so relative
    // paths in compiler output resolve against the SAME directory the
    // command actually ran in (regression: previously read raw `task.cwd`).
    let interpolatedCwd: string | undefined;

    // Replay path: when a saved input is provided for this task (only honored
    // for interactive types — see INTERACTIVE_TASK_TYPES), skip the
    // type-specific dispatch and use the saved value as the raw result. The
    // shared post-processing block below (capture + `passTheResultToNextTask`
    // output handling) still runs, so an interactive task with
    // `output: { mode: 'file' }` writes its file on replay just like on a
    // normal run.
    //
    // **저장된 값도 현재 제약을 통과해야 한다.** 예전에는 저장된 값을 그대로
    // 썼는데, 그러면 `validatePattern` 이 "이 태스크의 값은 이 모양뿐" 이라는
    // 보장을 하지 못한다 — 패턴을 나중에 조인 경우나 프리셋 파일을 손으로 고친
    // 경우, 재실행이 검증을 통째로 건너뛴다. Doctor 가 이 패턴을 근거로
    // 주입 경고를 면제하므로, 그 근거가 실제로 참이어야 한다.
    //
    // 통과하지 못하면 저장된 값을 **버리고 정상 흐름으로 떨어진다** — 사용자가
    // 그 자리에서 다시 입력한다(이전 값이 기본값으로 채워진다). 조용히 옛 값을
    // 쓰거나 액션을 실패시키는 것보다 낫다.
    const presetAcceptable = presetResult === undefined || savedInputStillValid(task, presetResult);
    const usingPresetResult = presetResult !== undefined
        && INTERACTIVE_TASK_TYPES.has(task.type)
        && presetAcceptable;
    if (presetResult !== undefined && INTERACTIVE_TASK_TYPES.has(task.type) && !presetAcceptable) {
        outputChannel.appendLine(
            `[WARN] Saved input for task '${task.id}' no longer satisfies its constraints; asking again.`
        );
    }
    if (usingPresetResult) {
        // 옛 History 항목에는 배열 필드가 없다 — 보정하지 않으면 재실행에서만
        // `${pick.paths}` 가 리터럴로 남는다.
        result = backfillDialogArrays(task, presetResult);
    }

    if (!usingPresetResult) { switch (task.type) {
        // `actionId` rides along so the dialog's remembered location is scoped
        // per action, not just per task id — the shell branch does the same a
        // few cases below. Without it every action that reuses a task id (the
        // wizard templates all emit `selectFile` / `selectFolder`) would share
        // one remembered folder.
        // Native OS dialogs take no CancellationToken and cannot be dismissed
        // from here, so a stop pressed while one is open can only take effect
        // once it returns. `throwIfActionCancelled` is that follow-up: without
        // it the run would pick a file the user no longer wants and carry on
        // into the remaining tasks.
        case 'fileDialog':
            result = await handleFileDialog({ ...task, actionId });
            throwIfTaskInactive(scope);
            break;
        case 'folderDialog':
            result = await handleFolderDialog({ ...task, actionId });
            throwIfTaskInactive(scope);
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
            result = await handleInputBox(interpolatedTask, scope.cancellation.token);
            break;
        case 'quickPick':
            // **죽은 필드는 보간하지 않는다.** `itemsFromCommand` 가 있으면 런타임이
            // 목록을 덮어쓰므로 정적 `items` 는 실행되지 않는데, 그 안의 값 하나가
            // NUL·길이 상한에 걸리면 **쓰이지도 않는 필드 때문에** 태스크가 실패한다.
            // (의존성 추론·Preview 는 이미 같은 규칙으로 이 필드를 건너뛴다 —
            // `projectActivePlatformBranches` 참조.)
            const itemsAreDead = typeof task.itemsFromCommand === 'string'
                ? task.itemsFromCommand.length > 0
                : Boolean(task.itemsFromCommand);
            const interpolatedItems = itemsAreDead ? task.items : task.items?.map((item: any) => {
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
            // Resolve `itemsFromCommand` (string or OS-specific object) to a
            // single interpolated command string, mirroring the shell branch.
            // 여기도 **고른 뒤 보간**한다 — 위 command 와 같은 이유다.
            let interpolatedItemsFromCommand: string | undefined;
            if (typeof task.itemsFromCommand === 'string'
                || (task.itemsFromCommand && typeof task.itemsFromCommand === 'object')) {
                interpolatedItemsFromCommand = interpolatePipelineVariables(
                    getCommandString(task.itemsFromCommand), interpolationContext
                );
            }
            const interpolatedQuickPickTask = {
                ...task,
                items: interpolatedItems,
                itemsFromCommand: interpolatedItemsFromCommand,
                cwd: task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined
            };
            result = await handleQuickPick(interpolatedQuickPickTask, defaultWorkspace, scope.cancellation.token);
            break;
        case 'unzip':
            const interpolatedUnzipTask: any = { ...task };
            // `tool` 이 있으면 **현재 플랫폼 branch 를 골라** 보간한다
            // (`interpolateToolValue`). truthy 검사 대신 `undefined`/`null` 만
            // 보는 것은 **`handleUnzip` 의 내장 엔진 판정과 같은 조건**이기
            // 때문이다 — 거기서도 `tool: ""` 는 내장 엔진이 아니라 외부 도구
            // 경로로 가서 `getToolCommand` 가 던진다. 두 곳의 조건이 갈리면
            // 빈 문자열이 여기서는 "도구 없음", 저기서는 "도구 있음" 이 된다.
            // 쓸 값이 없으면 `interpolateToolValue` 가 `getToolCommand` 와 같은
            // 문구로 던지므로 실패 지점만 앞당겨진다.
            if (task.tool !== undefined && task.tool !== null) {
                interpolatedUnzipTask.tool = interpolateToolValue(task.tool, interpolationContext);
            }
            if (typeof task.archive === 'string') {
                interpolatedUnzipTask.archive = interpolatePipelineVariables(task.archive, interpolationContext);
            }
            if (typeof task.destination === 'string') {
                interpolatedUnzipTask.destination = interpolatePipelineVariables(task.destination, interpolationContext);
            }
            // `cwd` 는 여기서 빠져 있었다 — `handleUnzip` 이 그것을 아예 쓰지
            // 않았기 때문이다. 이제 `zip` 과 마찬가지로 상대 경로의 기준이자
            // 외부 tool 의 작업 디렉터리로 쓰므로 보간해서 넘긴다.
            if (typeof task.cwd === 'string') {
                interpolatedUnzipTask.cwd = interpolatePipelineVariables(task.cwd, interpolationContext);
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
            result = await handleUnzip(interpolatedUnzipTask, allResults, defaultWorkspace, executionRun, taskUsesSecret);
            break;
        case 'zip': {
            // `tool` 을 보간해서 넘긴다 — `unzip` 분기가 이미 그렇게 하고
            // Preview 도 보간된 값을 보여 준다. `zip` 만 원본을 쓰고 있어서
            // `${workspaceFolder}/bin/7z` 같은 값이 Preview 에서는 해석되고
            // 실제 실행만 실패했다. 조건은 unzip 과 같은 이유로 명시적 검사다.
            const interpolatedZipTask: any = { ...task };
            if (task.tool !== undefined && task.tool !== null) {
                interpolatedZipTask.tool = interpolateToolValue(task.tool, interpolationContext);
            }
            result = await handleZip(interpolatedZipTask, allResults, defaultWorkspace, executionRun, taskUsesSecret, context.extensionPath);
            break;
        }
        case 'stringManipulation':
            const interpolatedInput = interpolatePipelineVariables(task.input || '', interpolationContext);
            result = await handleStringManipulation({ ...task, input: interpolatedInput });
            break;
        case 'envPick':
            const interpolatedEnvPickTask = {
                ...task,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined
            };
            result = await handleEnvPick(interpolatedEnvPickTask, scope.cancellation.token);
            break;
        case 'confirm':
            const interpolatedMessage = task.message ? interpolatePipelineVariables(task.message, interpolationContext) : undefined;
            result = await handleConfirm({ ...task, message: interpolatedMessage });
            // Modal은 CancellationToken을 받지 않아 프로그램적으로 닫을 수
            // 없다 — 네이티브 파일 대화상자와 같은 부류다. 중지 요청은
            // 기록만 되고, 사용자가 Yes를 눌러 modal이 닫히는 순간 여기서
            // 파이프라인을 중단시킨다. 이 검사가 없으면 "중지됨" 히스토리를
            // 남긴 실행이 계속 진행돼 성공 기록으로 덮어쓴다.
            throwIfTaskInactive(scope);
            break;
        case 'writeFile':
        case 'appendFile':
            result = await handleWriteFile(
                task,
                interpolationContext,
                workspaceRoots ?? getWorkspaceRoots(),
                defaultWorkspace,
                task.type === 'appendFile'
            );
            break;
        case 'command':
        case 'shell':
            // `command`(argv) 는 **토큰 경계를 보존하며** 보간한다 — 보간값의
            // 공백이 새 인자를 만들지 못하게(옵션 주입·경로 분리 차단).
            // `shell`(raw) 은 문자열을 셸에 그대로 넘기는 계약이라 그대로 둔다.
            // 자세한 이유는 `interpolateCommandPreservingTokens` 주석 참조.
            const interpolateCommandString = (template: string): string =>
                task.type === 'command'
                    ? interpolateCommandPreservingTokens(
                        template, value => interpolatePipelineVariables(value, interpolationContext)
                    )
                    : interpolatePipelineVariables(template, interpolationContext);

            // **고르는 것이 먼저다.** 모든 branch 를 보간한 뒤 고르면, 이 기계에서
            // 절대 실행되지 않을 branch 의 값 하나 때문에 태스크 전체가 실패한다 —
            // 보간은 NUL 바이트나 길이 초과에서 throw 하기 때문이다(예: macOS 에서
            // 도는 액션의 windows branch 에 `${pick.value}` 가 있고 사용자가 32KB 를
            // 붙여 넣은 경우). `interpolateToolValue` 가 같은 이유로 이미 이 순서다.
            let command: string | undefined;
            if (typeof task.command === 'string' || (task.command && typeof task.command === 'object')) {
                command = interpolateCommandString(getCommandString(task.command));
            }

            // 배열 값을 가리키는 원소는 **인자 여러 개**로 펼친다
            // (`"${pick.paths}"` → 고른 파일 수만큼). `expandArgTemplate` 주석 참조.
            const args = task.args
                ? task.args.flatMap((arg: string) => expandArgTemplate(arg, interpolationContext))
                : [];
            interpolatedCwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined;
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
            // Record the resolved command line (post-interpolation) so history
            // can show exactly what ran — including the dir picked from a
            // dialog — without re-executing. Uses the native-invocation display
            // form (`exe arg arg`) for readability across platforms.
            if (recordCommands) {
                // **다시 보간한다.** 이미 보간된 `command` 를 그대로 기록하면
                // password 값이 평문으로 이력에 남는다. 값 문자열을 찾아
                // 지우는 대신, 비밀 태스크의 결과를 자리표시자로 바꾼
                // 컨텍스트로 처음부터 다시 만든다.
                recordCommands[task.id] = buildRedactedDisplayCommand(executionRun, task, interpolationContext, command, args);
            }
            // 같은 가림을 **로그에도** 적용해야 한다. verbose 로그는 보간이
            // 끝난 명령줄을 그대로 찍으므로, 이걸 넘기지 않으면 이력에서 가린
            // 값이 로그로 그대로 샌다.
            const redactedDisplay = buildRedactedDisplayCommand(executionRun, task, interpolationContext, command, args);
            const redactedCwd = buildRedactedDisplayValue(executionRun, interpolationContext, task.cwd, interpolatedCwd);
            const handlerTask = {
                ...task,
                command,
                args,
                cwd: interpolatedCwd,
                env,
                actionId,
                runGeneration: executionRun.generation,
                executionScope: scope,
                redactedDisplay,
                redactedCwd,
                redactOutput: taskUsesSecret,
                sensitiveDebugOutputObserver: taskUsesSecret
                    ? sensitiveDebugOutputObserver(executionRun, task.id)
                    : undefined,
                discardCapturedOutput: taskUsesSecret && !task.passTheResultToNextTask && !executionRun.sensitiveDebug,
            };

            if (task.passTheResultToNextTask || (taskUsesSecret && !task.isOneShot)) {
                try {
                    const capturedResult = await handleCommand(handlerTask, context, defaultWorkspace);
                    // Password-derived tasks must not stream into VS Code's
                    // ordinary terminal without consent. Capture them through
                    // the same bounded process path even when downstream tasks
                    // do not consume the result, then discard the value.
                    result = task.passTheResultToNextTask ? capturedResult : {};
                } catch (err) {
                    // A task timeout rejects the scheduler-facing wrapper but
                    // cannot make every underlying promise disappear. Do not
                    // let a late process completion mutate diagnostics.
                    throwIfTaskInactive(scope);
                    // Real-world gcc/clang reject with non-zero exit AND
                    // emit diagnostics on stderr. Apply matchers to the
                    // captured output before re-throwing so the user gets
                    // Problems navigation even on a failed build — the
                    // case where they need it most. Without this branch the
                    // post-processing block below is unreachable on failure
                    // (regression caught by IT-079).
                    if (err instanceof ShellCommandError && task.output?.diagnostics && !taskUsesSecret) {
                        const failedOutput = combineStdoutStderrForDiagnostics(err.stdout, err.stderr);
                        try {
                            applyDiagnosticsToCollection(
                                failedOutput,
                                task.output.diagnostics,
                                task,
                                actionId,
                                interpolatedCwd ?? defaultWorkspace
                            );
                        } catch (diagErr) {
                            // Don't mask the original failure — log only.
                            const msg = diagErr instanceof Error ? diagErr.message : String(diagErr);
                            outputChannel.appendLine(
                                `[Warning] Task '${task.id}' diagnostic emission on failure itself failed: ${msg}`
                            );
                        }
                    } else if (err instanceof ShellCommandError && task.output?.diagnostics && taskUsesSecret) {
                        // Diagnostic messages and their resolved file URIs are
                        // another persistent display surface. Raw stdout,
                        // stderr, or a secret-derived cwd must not reach it.
                        logSuppressedSensitiveDiagnostics(task.id);
                    }
                    throw err;
                }
            } else {
                if (task.isOneShot) {
                    if (taskUsesSecret) {
                        executeSensitiveDetachedOneShot(handlerTask, defaultWorkspace);
                    } else {
                        executeStreamedTask(handlerTask, defaultWorkspace).catch(error => {
                            const msg = error instanceof Error ? error.message : String(error);
                            outputChannel.appendLine(`[ERROR] One-shot task ${task.id} failed: ${msg}`);
                            vscode.window.showErrorMessage(t(`원샷 태스크 '${task.id}' 시작 실패: ${msg}`, `One-shot task '${task.id}' failed to start: ${msg}`));
                        });
                    }
                } else {
                    await executeStreamedTask(handlerTask, defaultWorkspace);
                }
                result = {};
            }
            break;
        default:
            throw new Error(`Unsupported task type: ${task.type}`);
    } }

    // The timeout wrapper may already have reported this task as failed while
    // an uncancellable native dialog was still open. All common post-processing
    // and output modes are side effects, so fence them with the task identity.
    throwIfTaskInactive(scope);

    // Apply capture rules (if any) to derive named variables from a string
    // output. Capture only makes sense when the result carries a string
    // `output` property (shell/command with `passTheResultToNextTask: true`,
    // or `stringManipulation`). In all other cases we silently skip — a
    // warning is surfaced through the output channel in verbose mode.
    if (task.output && task.output.capture) {
        if (result && typeof result.output === 'string') {
            try {
                const captured = applyOutputCapture(result.output, task.output.capture);
                result = { ...result, ...captured };
            } catch (error: any) {
                throw new Error(`Task '${task.id}' capture failed: ${error.message}`);
            }
        } else {
            const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
            if (showVerboseLogs) {
                outputChannel.appendLine(
                    `[Warning] Task '${task.id}' has 'output.capture' but no string output is available. ` +
                    `For 'shell'/'command' tasks, set 'passTheResultToNextTask': true.`
                );
            }
        }
    }

    // Apply `output.diagnostics` matchers — same string-output constraint as
    // `capture` (shell/command tasks must set `passTheResultToNextTask: true`,
    // stringManipulation always returns a string). Resulting `ParsedDiagnostic`
    // records are converted to `vscode.Diagnostic` objects here (where we
    // can resolve relative paths against the task's cwd) and pushed to the
    // action's per-action collection.
    if (task.output && task.output.diagnostics) {
        if (taskUsesSecret) {
            logSuppressedSensitiveDiagnostics(task.id);
        } else if (result && typeof result.output === 'string') {
            try {
                // shell/command tasks expose stderr alongside stdout via
                // `result.stderr`; toolchains routinely write warnings to
                // stderr while exiting 0, so we match across both streams
                // (regression: IT-081). Other task types (stringManipulation)
                // have no stderr — `?? ''` collapses to stdout-only.
                const combined = combineStdoutStderrForDiagnostics(
                    result.output,
                    typeof result.stderr === 'string' ? result.stderr : ''
                );
                applyDiagnosticsToCollection(
                    combined,
                    task.output.diagnostics,
                    task,
                    actionId,
                    interpolatedCwd ?? defaultWorkspace
                );
            } catch (error: any) {
                throw new Error(`Task '${task.id}' diagnostics failed: ${error.message}`);
            }
        } else {
            const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
            if (showVerboseLogs) {
                outputChannel.appendLine(
                    `[Warning] Task '${task.id}' has 'output.diagnostics' but no string output is available. ` +
                    `For 'shell'/'command' tasks, set 'passTheResultToNextTask': true.`
                );
            }
        }
    }

    if (task.passTheResultToNextTask && task.output) {
        const outputContent = task.output.content ? interpolatePipelineVariables(task.output.content, interpolationContext) : (typeof result?.output === 'string' ? result.output : JSON.stringify(result, null, 2));

        // `filePath` · `overwrite` 는 `mode: 'file'` 에서만 쓰인다. 다른 모드에서
        // 보간하면 결과가 버려질 뿐이지만, 값이 NUL·길이 상한에 걸리면 **쓰이지도
        // 않는 필드 때문에** 태스크가 실패한다.
        const writesFile = task.output.mode === 'file';

        let overwriteValue: boolean | undefined;
        if (typeof task.output.overwrite === 'boolean') {
            overwriteValue = task.output.overwrite;
        } else if (writesFile && typeof task.output.overwrite === 'string') {
            const interpolated = interpolatePipelineVariables(task.output.overwrite, interpolationContext);
            overwriteValue = interpolated.trim().toLowerCase() === 'true';
        }

        const interpolatedOutput = {
            ...task.output,
            filePath: (writesFile && task.output.filePath)
                ? interpolatePipelineVariables(task.output.filePath, interpolationContext)
                : undefined,
            content: outputContent,
            overwrite: overwriteValue
        };

        switch (interpolatedOutput.mode) {
            case 'editor':
                if (taskUsesSecret || taskProducesSecret) {
                    // An untitled editor participates in VS Code hot-exit
                    // backup. Treat it as persistence, not as an ephemeral
                    // preview, and require the explicit sensitive-debug flow
                    // instead of placing raw password-derived output there.
                    //
                    // `taskProducesSecret` covers the password inputBox itself:
                    // with `passTheResultToNextTask` its own output IS the
                    // password, and it is not yet in `secretTaskIds` here.
                    vscode.window.showWarningMessage(t(
                        `태스크 '${task.id}'의 에디터 출력을 숨겼습니다. password 입력에서 파생된 출력은 민감 디버그 재실행에서만 볼 수 있습니다.`,
                        `Editor output for task '${task.id}' was hidden. Password-derived output is only available through a sensitive-debug re-run.`
                    ));
                    break;
                }
                throwIfTaskInactive(scope);
                const doc = await vscode.workspace.openTextDocument({ content: interpolatedOutput.content, language: interpolatedOutput.language || 'plaintext' });
                throwIfTaskInactive(scope);
                await vscode.window.showTextDocument(doc, { preview: false });
                break;
            case 'file':
                // `mode: file` names a concrete workspace path in actions.json
                // and is therefore an explicit persistent-output policy, unlike
                // editor hot-exit or a shared terminal. Preserve that declared
                // behavior (including for password-derived data); users can
                // audit the destination in configuration and workspace VCS.
                throwIfTaskInactive(scope);
                if (!interpolatedOutput.filePath) { throw new Error(`Task '${task.id}' has output mode 'file' but 'filePath' is not defined.`); }
                const safeOutputPath = resolveWithinWorkspace(
                    interpolatedOutput.filePath,
                    workspaceRoots ?? getWorkspaceRoots(),
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
                    if (taskUsesSecret || taskProducesSecret) {
                        vscode.window.showWarningMessage(t(
                            `태스크 '${task.id}'의 터미널 출력을 숨겼습니다. password 입력에서 파생된 출력은 민감 디버그 재실행에서만 볼 수 있습니다.`,
                            `Terminal output for task '${task.id}' was hidden. Password-derived output is only available through a sensitive-debug re-run.`
                        ));
                        break;
                    }
                    throwIfTaskInactive(scope);
                    // Sequential actions share one TaskHub terminal per
                    // actionId so consecutive tasks reuse it (backward
                    // compat). Parallel actions split per-task so two
                    // concurrent `output.mode: 'terminal'` tasks do not
                    // dump into the same terminal.
                    const actionKey = actionId || 'default';
                    const useTaskKey = isParallelActionActive(actionKey) && typeof task.id === 'string' && task.id.length > 0;
                    const terminalKey = useTaskKey ? `${actionKey}:${task.id}` : actionKey;
                    let handle = actionTerminals.get(terminalKey);
                    if (!handle || handle.terminal.exitStatus) {
                        handle = createReadonlyOutputTerminal(`TaskHub: ${terminalKey}`);
                        actionTerminals.set(terminalKey, handle);
                    }
                    handle.terminal.show();
                    handle.write(`\n# ----- Output for task: ${task.id} ----- #\n`);
                    handle.write(interpolatedOutput.content);
                }
                break;
        }
    }
    throwIfTaskInactive(scope);
    if (taskUsesSecret || taskProducesSecret) {
        markTaskResultSecret(executionRun, task.id);
    }
    return result;
}

function toProcessExecutionOptions(options: vscode.ShellExecutionOptions): vscode.ProcessExecutionOptions {
    const processOptions: vscode.ProcessExecutionOptions = {};
    if (options.cwd !== undefined) {
        processOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
        processOptions.env = options.env;
    }
    return processOptions;
}

/**
 * raw `shell` 을 실행할 Windows 인터프리터를 고른다. 고를 수 없으면 원인과
 * 해결책을 담아 던진다.
 *
 * Windows PowerShell 5.1 에 `&&` 를 넘기면 *"The token '&&' is not a valid
 * statement separator"* 라는 파스 오류만 나온다 — 사용자는 자기 명령이 틀렸다고
 * 읽지, 인터프리터가 그 문법을 모른다고 읽지 않는다.
 *
 * **`command` 만 넘긴다** (`args` 를 붙인 완성된 줄이 아니다). `args` 는 우리가
 * 항상 인용하므로 그 안의 `&&` 는 연산자가 될 수 없는데, 완성된 줄을 스캔하면
 * 그것까지 걸려 정상 명령이 거부된다.
 */
/** 인터프리터를 고르지 못했을 때의 오류 이름. 상세를 가리는 경로에서도 노출한다. */
export const RAW_SHELL_UNSUPPORTED_ERROR = 'RawShellUnsupportedError';

export function resolveRawShellExecutable(
    command: string,
    lookup: Partial<import('./pipelineUtils').WindowsExecutableLookup> = {}
): string {
    // POSIX 에서는 PATH 를 `;` 로 쪼개는 Windows 조회가 의미 없다 — 호출부가
    // 모두 win32 가드 안에 있지만, 미래의 호출자가 엉뚱한 오류를 보지 않도록
    // 여기서도 막는다.
    if (process.platform !== 'win32') { return 'powershell.exe'; }
    const needsChain = rawCommandUsesChainOperators(command);
    const executable = selectWindowsRawShell(needsChain, needsChain ? resolvePwshPath(lookup) : undefined);
    if (!executable) {
        // 이름을 붙여 둔다 — 민감 one-shot 처럼 실패 상세를 일부러 가리는
        // 경로에서도 이 메시지만은 그대로 보여야 한다. 명령 텍스트나 비밀을
        // 담지 않으므로 노출해도 안전하다.
        const error = new Error(t(
            `이 명령은 \`&&\` 또는 \`||\` 를 사용하는데, Windows PowerShell 5.1(\`powershell.exe\`)은 이 연산자를 지원하지 않습니다 — PowerShell 7(\`pwsh.exe\`)부터 도입됐습니다. PowerShell 7 을 설치하거나(PATH 에 있으면 자동으로 사용합니다), 태스크를 둘로 나누세요. 파이프라인은 앞 단계가 실패하면 뒤 단계를 실행하지 않으므로 \`&&\` 와 의미가 같고, 어느 단계가 실패했는지도 드러납니다.`,
            `This command uses \`&&\` or \`||\`, which Windows PowerShell 5.1 (\`powershell.exe\`) does not support — those operators arrived in PowerShell 7 (\`pwsh.exe\`). Install PowerShell 7 (it is used automatically when on PATH), or split the task in two. A pipeline already stops at the first failing step, so it means the same thing as \`&&\` and also shows which step failed.`
        ));
        error.name = RAW_SHELL_UNSUPPORTED_ERROR;
        throw error;
    }
    return executable;
}

export function createShellExecution(
    command: string,
    args: string[],
    options: vscode.ShellExecutionOptions,
    useUtf8Console: boolean,
    raw = false,
    lookup: Partial<import('./pipelineUtils').WindowsExecutableLookup> = {}
): { shellExecution: vscode.ShellExecution | vscode.ProcessExecution; displayCommand: string; usesNativeExecution?: boolean } {
    // `shell` 타입은 문자열을 셸에 그대로 넘긴다 (0.6.47). Windows 에서도
    // 네이티브 직접 실행 경로를 타지 않는다 — 그건 argv 실행이라 `&&` 나
    // 리다이렉션이 다시 리터럴이 되어 버린다.
    if (raw) {
        if (process.platform === 'win32') {
            const line = buildRawPowerShellCommandLine(command, args);
            const shell = resolveRawShellExecutable(command, { env: { ...process.env, ...(options.env ?? {}) }, ...lookup });
            const utf8Prefix = useUtf8Console ? '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n' : '';
            const encoded = encodePowerShellScript(withPowerShellExitCode(`${utf8Prefix}${line}`));
            return {
                shellExecution: new vscode.ShellExecution(shell, ['-NoProfile', '-EncodedCommand', encoded], options),
                displayCommand: line
            };
        }
        const line = buildRawShellCommandLine(command, args);
        return { shellExecution: new vscode.ShellExecution(line, options), displayCommand: line };
    }

    if (process.platform === 'win32') {
        // VS Code merges `options.env` onto the parent environment for the
        // spawned task, so the child's effective PATH is `options.env.PATH ??
        // process.env.PATH` — judge launchability against that.
        const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
        if (windowsCommandIsDirectlyLaunchable(command, args, { env: effectiveEnv })) {
            const native = buildNativeCommandInvocation(command, args);
            return {
                shellExecution: new vscode.ProcessExecution(native.executable, native.args, toProcessExecutionOptions(options)),
                displayCommand: native.display,
                usesNativeExecution: true
            };
        }
        const invocation = buildPowerShellInvocation(command, args, useUtf8Console);
        const encoded = encodePowerShellScript(withPowerShellExitCode(invocation.script));
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

export function wrapCommandForOneShot(
    command: string,
    args: string[],
    cwd: string | undefined,
    useUtf8Console: boolean,
    env: NodeJS.ProcessEnv = process.env,
    raw = false,
    lookup: Partial<import('./pipelineUtils').WindowsExecutableLookup> = {}
): { commandLine: string; displayCommand: string; isPowerShellScript: boolean } {
    if (raw && process.platform !== 'win32') {
        // **명령을 `sh -c` 로 감싼다.** 예전에는 raw 문자열을 `nohup … >/dev/null
        // 2>&1 &` 사이에 그대로 끼워 넣었는데, 그러면 두 가지가 깨진다:
        //   - `echo hi > out.txt` → 우리 `>/dev/null` 이 뒤에 붙어 사용자의
        //     리다이렉션을 덮어쓴다 (실측: out.txt 가 0바이트로 생성됐다).
        //   - `sleep 3; touch m` → `&` 는 and-or 리스트 **전체**를 끝내므로 첫
        //     `;` 앞이 **포그라운드**에서 돌고, one-shot 이 detach 되지 않은 채
        //     파이프라인을 3초 붙잡았다.
        // `sh -c` 로 그룹을 만들면 사용자의 리다이렉션은 안쪽에 남고 `&` 는
        // 래퍼 하나에만 걸린다. Windows 쪽을 `-EncodedCommand` 로 감싼 것과
        // 같은 이유(그룹 보존)다.
        const line = buildRawShellCommandLine(command, args);
        const wrapped = `nohup sh -c ${quotePosixArgument(line)} >/dev/null 2>&1 &`;
        return { commandLine: wrapped, displayCommand: line, isPowerShellScript: false };
    }
    if (raw && process.platform === 'win32') {
        // Windows 에서는 `raw` 를 **무시하고** 아래 argv 경로(`Start-Process` /
        // `ProcessStartInfo`)로 갔다. one-shot 은 첫 토큰을 실행 파일로 잡으므로
        // `&&` 뒤는 인자가 되고, 리다이렉션도 사라진다 — 같은 액션이
        // `isOneShot` 하나로 의미가 달라졌다.
        //
        // 셸에 그대로 넘기되 백그라운드로 띄운다. `Start-Process` 로 인터프리터
        // 자체를 떼어 내고, 명령 문자열은 `-EncodedCommand` 로 넘겨 인용을
        // 거치지 않는다. `-WindowStyle Hidden` 은 콘솔 창이 뜨지 않게 한다.
        const line = buildRawPowerShellCommandLine(command, args);
        const shell = resolveRawShellExecutable(command, { env, ...lookup });
        const utf8Prefix = useUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
        const encoded = encodePowerShellScript(`${utf8Prefix}${line}`);
        const script = buildRawOneShotWindowsScript(shell, encoded, cwd);
        return { commandLine: script, displayCommand: line, isPowerShellScript: true };
    }

    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    if (process.platform === 'win32') {
        const utf8Prefix = useUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
        if (windowsCommandIsDirectlyLaunchable(command, args, { env })) {
            // Directly-launchable executable: start it via ProcessStartInfo with
            // UseShellExecute=$false so we control arg quoting precisely
            // (CommandLineToArgvW rules), preserving embedded `"`.
            const argLine = combinedArgs.map(arg => quoteWindowsCommandLineArgument(arg)).join(' ');
            const lines = [
                '$psi = New-Object System.Diagnostics.ProcessStartInfo',
                `$psi.FileName = ${quotePowerShellArgument(executable)}`,
                `$psi.UseShellExecute = $false`,
            ];
            if (argLine.length > 0) {
                lines.push(`$psi.Arguments = ${quotePowerShellArgument(argLine)}`);
            }
            if (cwd) {
                lines.push(`$psi.WorkingDirectory = ${quotePowerShellArgument(cwd)}`);
            }
            lines.push('[System.Diagnostics.Process]::Start($psi) | Out-Null');
            const script = `${utf8Prefix}${lines.join('\n')}`;
            return { commandLine: script, displayCommand: script, isPowerShellScript: true };
        }
        // Shims (`npm` → `npm.cmd`), scripts (`.js`), and shell builtins can't be
        // started via UseShellExecute=$false — use Start-Process, which resolves
        // PATHEXT / file associations the way a shell would.
        const filePath = quotePowerShellArgument(executable);
        const argList = combinedArgs.map(arg => quotePowerShellArgument(arg));
        const argumentListPart = argList.length > 0 ? ` -ArgumentList @(${argList.join(', ')})` : '';
        const workingDirectoryPart = cwd ? ` -WorkingDirectory ${quotePowerShellArgument(cwd)}` : '';
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

    let shellExecution: vscode.ShellExecution | vscode.ProcessExecution;
    let displayCommand: string;

    if (isOneShot) {
        // Effective env the one-shot child runs with (VS Code merges options.env
        // onto the parent env) — used so `task.env.PATH` extensions are honoured
        // when judging launchability.
        const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
        const wrapped = wrapCommandForOneShot(command, taskArgs, options.cwd, useUtf8Console, effectiveEnv, task.type === 'shell');
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
        // `shell` 은 raw, `command` 는 argv (0.6.47).
        const result = createShellExecution(execCommand, execArgs, options, useUtf8Console, task.type === 'shell');
        shellExecution = result.shellExecution;
        displayCommand = result.displayCommand;
    }

    // 로그·표시에는 가린 명령줄을 쓴다 (실행에는 위에서 만든 진짜 것을 쓴다).
    if (typeof task.redactedDisplay === 'string') {
        displayCommand = task.redactedDisplay;
    }

    const taskDefinition: vscode.TaskDefinition = { type: 'shell', actionId: actionKey };
    const taskName = `TaskHub: ${actionKey}`;
    const vsCodeTask = new vscode.Task(taskDefinition, vscode.TaskScope.Workspace, taskName, 'taskhub', shellExecution);
    vsCodeTask.presentationOptions = createGroupedTaskPresentationOptions(
        actionKey,
        revealTerminal,
        { taskId: task.id, isParallel: isParallelActionActive(actionKey) }
    );
    if (task.redactOutput === true) {
        // VS Code normally echoes the exact ShellExecution command into the
        // terminal. The audit display above is redacted, but the execution
        // object must retain the real value, so disable that second echo.
        vsCodeTask.presentationOptions.echo = false;
    }

    return {
        vsCodeTask,
        displayCommand,
        actionKey,
        cwd: typeof task.redactedCwd === 'string' ? task.redactedCwd : (options.cwd || '')
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
                if (task.actionId && task.id) {
                    deleteActiveTaskExecution(task.actionId, task.id, task.runGeneration, taskExecution);
                }
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
            // One-shot explicitly means detached from the pipeline lifetime:
            // executeSingleTask reports success as soon as launch is requested,
            // so the owning run may already be closed by the time VS Code
            // returns its TaskExecution. Applying the stale-run fence here
            // would immediately kill the very background job one-shot asked
            // us to keep. Ordinary streamed tasks remain fenced below.
            if (task.executionScope && task.isOneShot !== true) {
                try {
                    throwIfTaskInactive(task.executionScope as TaskExecutionScope);
                } catch (error) {
                    // executeTask itself may resolve only after the timeout or
                    // action-drain deadline. In that case the earlier timeout
                    // callback could not see an execution to terminate yet.
                    try { taskExecution.terminate(); } catch { /* ignore */ }
                    disposable.dispose();
                    reject(error);
                    return;
                }
            }
            // A one-shot is deliberately detached from the action lifecycle.
            // Registering a late-resolving launch here would recreate an
            // activeTasks bucket after the owning pipeline had finalized,
            // leaving a phantom Stop All target until VS Code happened to
            // report process end. Ordinary streamed tasks remain stoppable.
            if (task.isOneShot !== true && task.actionId && task.id && taskExecution) {
                setActiveTaskExecution(task.actionId, task.id, taskExecution, task.runGeneration);
            }
        } catch (error) {
            disposable.dispose();
            reject(error);
        }
    });
}

/**
 * Launch a password-derived one-shot without creating a terminal or tying the
 * child to the extension-host lifecycle. stdio:'ignore' prevents raw output
 * from reaching VS Code, while detached+unref preserves one-shot's contract
 * that the process may outlive the action (and the extension host).
 */
function executeSensitiveDetachedOneShot(task: any, workspaceFolderPath?: string): void {
    // `shell` 타입은 문자열을 셸에 그대로 넘긴다 (0.6.47).
    const raw = task.type === 'shell';
    const command = getCommandString(task.command);
    const args = Array.isArray(task.args) ? task.args : [];
    const { envOverrides, useUtf8Console } = resolveExecutionSettings(task.env);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
    const workingDirectory = task.cwd || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined;
    const shownWorkingDirectory = task.redactedCwd ?? workingDirectory ?? '';
    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
    let failureReported = false;
    const reportFailure = () => {
        if (failureReported) { return; }
        failureReported = true;
        const message = t(
            `민감 원샷 태스크 '${task.id}' 실행에 실패했습니다. 상세는 password 입력을 사용해 숨겼습니다.`,
            `Sensitive one-shot task '${task.id}' failed. Details were hidden because it used a password input.`
        );
        outputChannel.appendLine(`[ERROR] ${message}`);
        vscode.window.showErrorMessage(message);
    };

    try {
        let child: ReturnType<typeof spawn>;
        if (process.platform === 'win32') {
            // PowerShell resolves .cmd/.bat shims and scripts consistently;
            // the encoded script keeps argument quoting identical to captured
            // commands without exposing it in a command-line audit surface.
            const utf8Prefix = raw && useUtf8Console
                ? '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n'
                : '';
            const invocation = raw
                ? (() => {
                    const line = buildRawPowerShellCommandLine(command, args);
                    return { script: `${utf8Prefix}${line}`, display: line };
                })()
                : buildPowerShellInvocation(command, args, useUtf8Console);
            // raw 는 여기서도 인터프리터를 골라야 한다 — 이 경로는 stdio:'ignore'
            // 이고 실패 안내가 일부러 무내용("상세는 숨겼습니다")이라, 5.1 의
            // `&&` 파스 오류가 나면 사용자에게 **아무 진단 단서도 남지 않는다**.
            const shell = raw ? resolveRawShellExecutable(command, { env: childEnv }) : 'powershell.exe';
            // powershell.exe does not reliably propagate an external program's
            // exit code unless the script exits explicitly with LASTEXITCODE.
            const script = withPowerShellExitCode(invocation.script);
            child = spawn(
                shell,
                ['-NoProfile', '-EncodedCommand', encodePowerShellScript(script)],
                {
                    cwd: workingDirectory,
                    env: childEnv,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                }
            );
        } else {
            child = spawn(raw ? buildRawShellCommandLine(command, args) : buildPosixCommandLine(command, args), [], {
                cwd: workingDirectory,
                env: childEnv,
                detached: true,
                stdio: 'ignore',
                shell: true,
            });
        }

        child.once('error', reportFailure);
        child.once('exit', code => {
            if (code !== 0) { reportFailure(); }
        });
        child.unref();
        if (showVerboseLogs) {
            outputChannel.appendLine(
                `[INFO] Launched detached sensitive one-shot: ${task.redactedDisplay ?? '[command hidden: uses password input]'} ` +
                `in ${shownWorkingDirectory}`
            );
        }
    } catch (error) {
        // 인터프리터를 고를 수 없다는 것은 **설정의 문제**이고 그 메시지에는
        // 명령도 비밀도 담기지 않는다. 여기서 무내용 안내로 덮으면 이 경로는
        // stdio 도 없어 사용자가 원인을 알 방법이 사라진다.
        if (error instanceof Error && error.name === RAW_SHELL_UNSUPPORTED_ERROR) {
            failureReported = true;
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(error.message);
            return;
        }
        reportFailure();
    }
}

async function handleCommand(task: any, context: vscode.ExtensionContext, workspaceFolderPath?: string): Promise<{ output: string; stderr: string }> {
    const { args, cwd } = task;
    const command = getCommandString(task.command);
    const captured = await executeShellCommand(
        command,
        args || [],
        cwd,
        task.env,
        workspaceFolderPath,
        task.actionId,
        task.id,
        task.redactedDisplay,
        task.redactedCwd,
        task.redactOutput === true,
        task.runGeneration,
        task.sensitiveDebugOutputObserver,
        task.discardCapturedOutput === true,
        // `shell` 은 raw, `command` 는 argv (0.6.47).
        task.type === 'shell'
    );
    // `output` keeps its historical meaning (= stdout only) so existing
    // `output.capture` rules and `${task.output}` interpolation behave
    // exactly as before. `stderr` is exposed alongside so the diagnostic
    // post-processing block can match warning lines that the toolchain
    // emitted on stderr while still exiting 0 (gcc/clang are common
    // examples — regression caught by IT-081).
    return { output: captured.stdout.trim(), stderr: captured.stderr.trim() };
}

/** `fileDialog` 결과. 단일 필드는 첫 파일, 배열 필드는 고른 전체. */
export interface FileDialogResult {
    path: string; dir: string; name: string; fileNameOnly: string; fileExt: string;
    /** 고른 파일 전체의 절대 경로. `args` 에서 참조하면 인자 여러 개로 펼쳐진다. */
    paths: string[];
    /** 각 파일의 이름(확장자 포함). */
    names: string[];
    /** 고른 파일 개수. */
    count: number;
}

export function parsePathInfo(fullPath: string): { path: string, dir: string, name: string, fileNameOnly: string, fileExt: string } {
    const baseName = path.basename(fullPath);
    const extension = path.extname(baseName);
    return { path: fullPath, dir: path.dirname(fullPath), name: baseName, fileNameOnly: path.basename(baseName, extension), fileExt: extension.startsWith('.') ? extension.substring(1) : extension };
}

export async function handleFileDialog(task: any): Promise<FileDialogResult> {
    // `defaultUri`는 액션 JSON에서 문자열로 오므로 Uri로 승격한다 — 그대로
    // 넘기면 VS Code가 무시해 다이얼로그가 엉뚱한 위치에서 열린다. 명시하지
    // 않았다면 이 태스크가 마지막으로 고른 폴더에서 연다.
    const options: vscode.OpenDialogOptions = { ...(task.options || {}), defaultUri: coerceDefaultUri(task.options?.defaultUri) };
    const fileUri = await showOpenDialogWithMemory(taskDialogScope('file', task), options);
    if (!fileUri || !fileUri[0]) { throw new PromptCancelledError(t('파일 선택을 취소했습니다.', 'File selection was canceled.')); }
    // `options.canSelectMany` 는 예전부터 VS Code 로 그대로 전달됐지만, 결과는
    // 첫 파일만 쓰고 **나머지를 조용히 버렸다** — 사용자는 여러 개를 골랐는데
    // 하나만 처리되는 상태였다. 이제 전부 돌려준다. `path` 등 단일 필드는
    // 첫 파일을 그대로 가리켜 기존 액션이 그대로 동작한다.
    return {
        ...parsePathInfo(fileUri[0].fsPath),
        paths: fileUri.map(uri => uri.fsPath),
        names: fileUri.map(uri => path.basename(uri.fsPath)),
        count: fileUri.length,
    };
}

export async function handleFolderDialog(task: any): Promise<FileDialogResult> {
    const options: vscode.OpenDialogOptions = { ...(task.options || {}), defaultUri: coerceDefaultUri(task.options?.defaultUri) };
    options.canSelectFiles = false; options.canSelectFolders = true;
    const folderUri = await showOpenDialogWithMemory(taskDialogScope('folder', task), options);
    if (!folderUri || !folderUri[0]) { throw new PromptCancelledError(t('폴더 선택을 취소했습니다.', 'Folder selection was canceled.')); }
    // `fileDialog` 와 같은 모양으로 돌려준다. `canSelectMany` 는 예전부터 VS Code
    // 로 전달돼 폴더도 여러 개 고를 수 있었지만 결과는 첫 폴더만 쓰고 나머지를
    // 조용히 버렸다 — 0.6.51 이전의 `fileDialog` 와 같은 결함이 폴더 쪽에만
    // 남아 있었다. `path` 등 단일 필드는 첫 폴더를 가리키므로 기존 액션은
    // 그대로 동작한다. `names` 는 폴더 이름이다.
    return {
        ...parsePathInfo(folderUri[0].fsPath),
        paths: folderUri.map(uri => uri.fsPath),
        names: folderUri.map(uri => path.basename(uri.fsPath)),
        count: folderUri.length,
    };
}

async function handleInputBox(task: any, token?: vscode.CancellationToken): Promise<{ value: string }> {
    // `extractPattern`: derive the prefilled default from the (already
    // interpolated) `value` — e.g. pull a Jira key out of a branch name. On a
    // match use capture group 1 if present, else the whole match; on no match
    // (or an invalid regex) prefill empty so the user types fresh.
    let initialValue = task.value;
    if (typeof task.extractPattern === 'string' && task.extractPattern.length > 0) {
        // Extraction was requested: default the prefill to empty so a raw,
        // unsuitable value (e.g. a full branch name) never lands in the box.
        // Only a successful match overrides it. An invalid pattern also stays
        // empty — matching the documented behavior.
        initialValue = '';
        let extractRe: RegExp | undefined;
        try {
            extractRe = new RegExp(task.extractPattern);
        } catch {
            extractRe = undefined;
        }
        if (extractRe && typeof task.value === 'string') {
            const match = task.value.match(extractRe);
            if (match) {
                initialValue = match[1] !== undefined ? match[1] : match[0];
            }
        }
    }

    const options: vscode.InputBoxOptions = {
        prompt: task.prompt,
        value: initialValue,
        placeHolder: task.placeHolder,
        password: task.password || false
    };

    // `validatePattern`: reject non-matching input live. An invalid regex is
    // ignored (no validation) so a bad pattern never blocks input entirely.
    if (typeof task.validatePattern === 'string' && task.validatePattern.length > 0) {
        let validateRe: RegExp | undefined;
        try {
            validateRe = new RegExp(task.validatePattern);
        } catch {
            validateRe = undefined;
        }
        if (validateRe) {
            const invalidMessage = typeof task.validateMessage === 'string' && task.validateMessage.length > 0
                ? task.validateMessage
                : t('입력 형식이 올바르지 않습니다.', 'Input does not match the required format.');
            options.validateInput = (input: string) => (validateRe!.test(input) ? undefined : invalidMessage);
        }
    }

    // The token is what makes *Stop Action* work while this box is open —
    // VS Code dismisses the prompt and resolves `undefined`, which falls into
    // the existing cancel branch below.
    const userInput = await vscode.window.showInputBox(options, token);
    if (userInput !== undefined) {
        const prefix = task.prefix || '';
        const suffix = task.suffix || '';
        const finalValue = prefix + userInput + suffix;
        return { value: finalValue };
    } else {
        throw new PromptCancelledError(t('입력을 취소했습니다.', 'Input was canceled.'));
    }
}

/**
 * Run a shell command and return its stdout split into trimmed, non-empty
 * lines. Used by `quickPick`'s `itemsFromCommand` to populate the pick list
 * dynamically (e.g. from `git for-each-ref ... refs/remotes/origin`). Spawns
 * the user's login shell so PATH-resolved tools like `git` are found, mirroring
 * the `envPick` probe. Rejects on non-zero exit, spawn error, timeout, or
 * oversized output.
 */
export function runCommandCaptureLines(command: string, cwd: string | undefined, timeoutMs = 15000, token?: vscode.CancellationToken): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        // spawn **전에** 검사한다. 이미 중지된 액션의 항목 생성 명령을 잠깐이라도
        // 실행하면 안 된다 — 사용자가 취소한 임의 명령이 부수 효과를 남길 수 있다.
        // (예전에는 spawn 뒤에 확인해, 죽이기 전까지 명령이 돌았다.)
        if (token?.isCancellationRequested) {
            reject(new PromptCancelledError(t('목록에서 선택하기를 취소했습니다.', 'Quick pick selection was canceled.')));
            return;
        }

        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
        const args = isWindows ? ['/c', command] : ['-l', '-c', command];

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, args, {
                cwd: cwd && cwd.length > 0 ? cwd : undefined,
                stdio: ['ignore', 'pipe', 'pipe'],
                // POSIX 에서 자기 프로세스 그룹을 갖게 해, 취소 시 그룹 전체에
                // 시그널을 보낼 수 있게 한다 (killProcessTree 참조).
                detached: !isWindows
            });
        } catch (e: any) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) { return; }
            settled = true;
            fn();
        };

        // 우리가 죽인 경우의 사유. 트리를 종료하면 `close` 가 비정상 종료
        // 코드와 함께 먼저 도착하는데, 그대로 두면 "exit code 1" 이 사용자
        // 눈에 보이는 오류가 되어 취소·timeout 이라는 진짜 이유를 덮는다.
        let abortReason: Error | undefined;
        const abortWith = (reason: Error) => {
            // **동기 가드**. `killProcessTree` 는 비동기라 종료가 확정되기까지
            // stdout/stderr 이벤트가 계속 들어오는데, 가드가 없으면 출력 상한
            // 검사가 chunk 마다 다시 abort 를 불러 `taskkill` 프로세스·Promise·
            // 리스너·2초 타이머가 폭증한다 — OOM 을 막으려는 코드가 OOM 을
            // 만드는 셈이다. 첫 abort 만 통과시킨다.
            if (abortReason) { return; }
            abortReason = reason;
            clearTimeout(timer);
            cancelSub?.dispose();
            // 종료를 **기다린 뒤** reject 한다. 기다리지 않으면 호출부는
            // "중지됨"을 받았는데 명령은 아직 돌고 있는 상태가 된다.
            void killProcessTree(child).then(() => finish(() => reject(reason)));
        };

        // 셸 래퍼가 아니라 그 아래 실제 명령까지 죽여야 한다 — 세 종료 경로
        // (취소 / timeout / 출력 상한) 모두 `abortWith` 를 거친다. 예전에는
        // 전부 child.kill() 이라 Windows 에서 래퍼만 사라지고 명령이 고아로
        // 남았다.
        const timer = setTimeout(() => {
            abortWith(new Error(t('명령 실행이 시간 내에 완료되지 않았습니다.', 'Command timed out.')));
        }, timeoutMs);

        // *Stop Action* 은 이 spawn 을 activeTasks 로도 child-process registry
        // 로도 볼 수 없다 — 항목 생성 명령은 태스크 실행 이전의 준비 단계라
        // 어느 쪽에도 등록되지 않는다. 취소 토큰이 유일한 연결 고리이고,
        // 이게 없으면 중지를 눌러도 프로세스가 timeout(기본 15초)까지 돌며
        // 그동안 중지가 무반응으로 보인다.
        const cancelSub = token?.onCancellationRequested(() => {
            abortWith(new PromptCancelledError(t('목록에서 선택하기를 취소했습니다.', 'Quick pick selection was canceled.')));
        });

        // Cap stdout+stderr *combined*: a failing command can spew unbounded
        // stderr, and at the quickPick stage that would balloon extension-host
        // memory. Kill once either stream pushes the total past the limit.
        const MAX_CAPTURE_BYTES = 1024 * 1024;
        const enforceCaptureLimit = () => {
            if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > MAX_CAPTURE_BYTES) {
                abortWith(new Error(t('명령 출력이 너무 큽니다.', 'Command output is too large.')));
            }
        };
        // abort 이후의 chunk 는 **버린다**. 종료가 확정되기 전까지 파이프에
        // 남아 있던 출력이 계속 도착하는데, 그걸 계속 이어 붙이면 상한을
        // 넘긴 뒤에도 메모리가 자란다 — 상한의 의미가 없어진다.
        child.stdout?.on('data', (chunk: Buffer) => {
            if (abortReason) { return; }
            stdout += chunk.toString('utf8');
            enforceCaptureLimit();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (abortReason) { return; }
            stderr += chunk.toString('utf8');
            enforceCaptureLimit();
        });
        child.on('error', (e: Error) => {
            clearTimeout(timer);
            cancelSub?.dispose();
            finish(() => reject(e));
        });
        // Resolve on `close`, not `exit`: `exit` can fire before the stdout
        // stream has flushed its final chunk, dropping the last line for large
        // or slow output. `close` fires only after all stdio streams are done.
        child.on('close', (code: number | null) => {
            clearTimeout(timer);
            cancelSub?.dispose();
            // 우리가 죽여서 닫힌 것이면 그 사유가 우선이다. 트리 종료 뒤에는
            // `close` 가 비정상 코드로 먼저 도착하는데, 그대로 두면 사용자가
            // "exit code 1" 을 보게 되어 취소·timeout 이라는 진짜 이유가
            // 묻힌다 (`abortWith` 의 reject 는 `finish` 가 한 번만 통과시킨다).
            if (abortReason) {
                const reason = abortReason;
                finish(() => reject(reason));
                return;
            }
            if (code !== 0) {
                const detail = stderr.trim() || `exit code ${code}`;
                finish(() => reject(new Error(detail)));
                return;
            }
            const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            finish(() => resolve(lines));
        });
    });
}

export async function handleQuickPick(task: any, defaultWorkspace?: string, token?: vscode.CancellationToken): Promise<{ value: string; values?: string }> {
    // When `itemsFromCommand` is set, build the pick list from the command's
    // stdout (one item per non-empty line). The command is already interpolated
    // and reduced to a single OS-specific string by the dispatcher.
    let pickItems: any = task.items;
    if (typeof task.itemsFromCommand === 'string' && task.itemsFromCommand.length > 0) {
        const runCwd = task.cwd || defaultWorkspace || '(none)';
        let lines: string[];
        try {
            lines = await runCommandCaptureLines(task.itemsFromCommand, task.cwd || defaultWorkspace, undefined, token);
        } catch (e: any) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(t(
                `Task '${task.id}'의 'itemsFromCommand' 실행에 실패했습니다 (cwd: ${runCwd}): ${message}`,
                `Task '${task.id}' failed to run 'itemsFromCommand' (cwd: ${runCwd}): ${message}`
            ));
        }
        const excludeList = Array.isArray(task.itemsExclude)
            ? task.itemsExclude
            : (typeof task.itemsExclude === 'string' ? [task.itemsExclude] : []);
        const exclude = new Set(excludeList.map((s: any) => String(s).trim()));
        pickItems = lines.filter(line => !exclude.has(line));
        if (pickItems.length === 0) {
            // Include cwd and the raw line count so an empty pick list is
            // debuggable: most often the command ran in a folder without the
            // expected refs (e.g. no `origin` remote-tracking branches), or
            // everything was filtered out by `itemsExclude`.
            throw new Error(t(
                `Task '${task.id}'의 'itemsFromCommand'가 선택할 항목을 반환하지 않았습니다 (cwd: ${runCwd}, 출력 ${lines.length}줄, 제외 후 0개).`,
                `Task '${task.id}' got no items from 'itemsFromCommand' (cwd: ${runCwd}, ${lines.length} line(s) before exclude, 0 after).`
            ));
        }
    }

    if (!pickItems || !Array.isArray(pickItems) || pickItems.length === 0) {
        throw new Error(`Task '${task.id}' of type 'quickPick' requires a non-empty 'items' array or an 'itemsFromCommand'.`);
    }
    task = { ...task, items: pickItems };

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

    // As with `handleInputBox`, the token is what lets *Stop Action* dismiss
    // an open pick list instead of leaving it on screen.
    if (task.canPickMany) {
        const selected = await vscode.window.showQuickPick(items, { ...options, canPickMany: true }, token);
        if (selected && selected.length > 0) {
            const labels = selected.map(item => item.label);
            return { value: labels[0], values: labels.join(',') };
        } else {
            throw new PromptCancelledError(t('목록에서 선택하기를 취소했습니다.', 'Quick pick selection was canceled.'));
        }
    } else {
        const selected = await vscode.window.showQuickPick(items, options, token);
        if (selected) {
            return { value: selected.label };
        } else {
            throw new PromptCancelledError(t('목록에서 선택하기를 취소했습니다.', 'Quick pick selection was canceled.'));
        }
    }
}

// VS Code / Electron 가 확장 호스트 프로세스에 주입하는 환경변수들의 prefix.
// 이 변수들은 사용자 셸 (`zsh -l`, `cmd.exe`) 환경에는 보통 존재하지 않으므로
// envPick 의 후속 셸 태스크에서 `printenv` 하면 실패한다. 폴백 필터로 사용.
const EXTHOST_ONLY_ENV_PREFIXES = ['VSCODE_', 'ELECTRON_'];
const EXTHOST_ONLY_ENV_NAMES = new Set([
    'APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL',
    'CHROME_DESKTOP',
    'GIO_LAUNCHED_DESKTOP_FILE',
    'GIO_LAUNCHED_DESKTOP_FILE_PID',
    'ORIGINAL_XDG_CURRENT_DESKTOP'
]);

function isExtensionHostOnlyEnvName(name: string): boolean {
    if (EXTHOST_ONLY_ENV_NAMES.has(name)) { return true; }
    return EXTHOST_ONLY_ENV_PREFIXES.some(p => name.startsWith(p));
}

let cachedShellEnvNamesPromise: Promise<Set<string> | null> | null = null;

export function __testHook_resetShellEnvNamesCache(override?: Set<string> | null): void {
    if (override === undefined) {
        cachedShellEnvNamesPromise = null;
    } else {
        cachedShellEnvNamesPromise = Promise.resolve(override);
    }
}

/**
 * Spawn the user's default login shell (or `cmd.exe` on Windows) and capture
 * the list of environment variable names it actually exposes. Used by
 * `envPick` to avoid showing extension-host-only vars (e.g. `VSCODE_*`,
 * `ELECTRON_RUN_AS_NODE`) that would fail when the downstream `printenv`
 * shell task tries to read them. Result is cached for the extension host
 * lifetime; returns null on timeout / spawn failure so the caller can fall
 * back to a hardcoded blocklist.
 */
function getShellAccessibleEnvNames(): Promise<Set<string> | null> {
    if (cachedShellEnvNamesPromise) {
        return cachedShellEnvNamesPromise;
    }
    cachedShellEnvNamesPromise = new Promise<Set<string> | null>((resolve) => {
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
        const args = isWindows ? ['/c', 'set'] : ['-l', '-c', 'env'];

        // 핵심: spawn 의 기본 env 상속을 막아야 한다. 그렇게 두면 확장 호스트가
        // 들고 있는 VSCODE_* / ELECTRON_* 변수가 probe 셸로 새어 들어가서
        // `env` 출력에 포함되고, 결과적으로 "셸이 본다" 로 잘못 분류된다.
        // 그래서 probe 에 넘기는 env 에서 알려진 확장 호스트 전용 이름들을
        // 미리 제거한다. 이 sanitize 만으로는 VS Code 가 task runner 안에서
        // 추가로 거르는 변수들을 100% 재현할 수 없으므로, 호출부에서
        // hardcoded blocklist 를 한 번 더 적용한다 (belt-and-suspenders).
        const probeEnv: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && !isExtensionHostOnlyEnvName(key)) {
                probeEnv[key] = value;
            }
        }

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, args, {
                stdio: ['ignore', 'pipe', 'ignore'],
                env: probeEnv,
                // POSIX 에서 자기 프로세스 그룹을 갖게 해, 중단 시 그룹 전체를
                // 종료할 수 있게 한다. 로그인 셸(`-l`)은 프로필 스크립트가
                // 자손을 띄울 수 있어 래퍼만 죽이면 그것들이 남는다.
                detached: !isWindows
            });
        } catch {
            resolve(null);
            return;
        }

        let stdout = '';
        let settled = false;
        const finish = (value: Set<string> | null) => {
            if (settled) { return; }
            settled = true;
            resolve(value);
        };

        const timer = setTimeout(() => {
            finish(null);
            // 트리 종료 — 로그인 셸이 띄운 자손까지 정리한다.
            void killProcessTree(child);
        }, 5000);

        // `settled` 는 resolve 를 한 번만 하도록 막을 뿐, **리스너를 멈추지는
        // 않는다**. 가드가 없으면 상한을 넘겨 중단한 뒤에도 파이프에 남은
        // 출력이 계속 이어 붙어 상한이 사실상 없는 것과 같았다.
        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) { return; }
            stdout += chunk.toString('utf8');
            // 1MB 이상이면 비정상으로 간주하고 중단
            if (stdout.length > 1024 * 1024) {
                clearTimeout(timer);
                finish(null);
                stdout = '';   // 더 이상 쓰지 않는다 — 즉시 회수되게 놓아준다
                void killProcessTree(child);
            }
        });
        child.on('error', () => {
            clearTimeout(timer);
            finish(null);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                finish(null);
                return;
            }
            const names = new Set<string>();
            for (const rawLine of stdout.split(/\r?\n/)) {
                const eq = rawLine.indexOf('=');
                if (eq > 0) {
                    names.add(rawLine.slice(0, eq));
                }
            }
            finish(names.size > 0 ? names : null);
        });
    });
    return cachedShellEnvNamesPromise;
}

export async function handleEnvPick(task: any, token?: vscode.CancellationToken): Promise<{ value: string }> {
    const allNames = Object.keys(process.env);
    // 셸 probe 는 최대 5초가 걸리는데 결과가 확장 호스트 수명 동안 캐시되므로
    // 죽이면 안 된다 — 다음 envPick 이 다시 5초를 문다. 대신 토큰과 race 해서
    // **이 액션만** 즉시 빠져나온다. probe 는 백그라운드에서 계속 돌아 캐시를
    // 채운다. 이 구간을 놓치면 중지 후에도 최대 5초 뒤에 목록이 새로 뜬다.
    const shellNames = await Promise.race([
        getShellAccessibleEnvNames(),
        new Promise<null>((_, rejectRace) => {
            if (!token) { return; }
            if (token.isCancellationRequested) {
                rejectRace(new PromptCancelledError(t('환경 변수 선택을 취소했습니다.', 'Environment variable selection was canceled.')));
                return;
            }
            token.onCancellationRequested(() =>
                rejectRace(new PromptCancelledError(t('환경 변수 선택을 취소했습니다.', 'Environment variable selection was canceled.'))));
        })
    ]);

    let names: string[];
    if (shellNames) {
        // 셸이 실제로 보는 변수만 노출. 확장 호스트가 동적으로 추가했지만
        // 셸에는 없는 변수(VSCODE_*, ELECTRON_RUN_AS_NODE 등)를 자동 제외.
        // probe 의 env sanitize 만으로는 VS Code task runner 가 추가로
        // 거르는 변수를 완벽 재현할 수 없으므로 blocklist 도 함께 적용한다.
        names = allNames
            .filter(n => shellNames.has(n) && !isExtensionHostOnlyEnvName(n))
            .sort();
    } else {
        // 셸 호출 실패 시 fallback: 알려진 확장 호스트 전용 prefix 만 차단.
        names = allNames.filter(n => !isExtensionHostOnlyEnvName(n)).sort();
    }

    if (names.length === 0) {
        throw new Error(`Task '${task.id}' of type 'envPick' found no environment variables.`);
    }

    const items: vscode.QuickPickItem[] = names.map(name => ({ label: name }));
    // 토큰이 *Stop Action*을 실제로 동작하게 한다 — inputBox/quickPick과 같은
    // 계약인데 0.6.29가 이 타입만 빠뜨려, 중지 후에도 목록이 열린 채 남았고
    // 사용자가 값을 고르면 뒤 태스크가 계속 실행됐다.
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: task.placeHolder || t(
            '환경변수 이름을 선택하세요',
            'Select an environment variable name'
        )
    }, token);

    if (!selected) {
        throw new PromptCancelledError(t('환경 변수 선택을 취소했습니다.', 'Environment variable selection was canceled.'));
    }

    return { value: selected.label };
}

async function handleWriteFile(
    task: import('./schema').Task,
    interpolationContext: any,
    workspaceRoots: string[],
    defaultWorkspace: string,
    append: boolean
): Promise<{ path: string }> {
    if (typeof task.path !== 'string' || task.path.length === 0) {
        throw new Error(`Task '${task.id}' of type '${task.type}' requires a non-empty 'path' property.`);
    }
    if (typeof task.content !== 'string') {
        throw new Error(`Task '${task.id}' of type '${task.type}' requires a 'content' property (string).`);
    }

    const rawPath = interpolatePipelineVariables(task.path, interpolationContext);
    const content = interpolatePipelineVariables(task.content, interpolationContext);
    const safePath = resolveWithinWorkspace(rawPath, workspaceRoots, defaultWorkspace);

    const mkdirs = task.mkdirs !== false;
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
        if (mkdirs) {
            fs.mkdirSync(dir, { recursive: true });
        } else {
            throw new Error(`Task '${task.id}' cannot write to '${safePath}': parent directory does not exist and 'mkdirs' is false.`);
        }
    }

    const targetExists = fs.existsSync(safePath);
    if (!append && task.overwrite === false && targetExists) {
        throw new Error(`Task '${task.id}' refused to overwrite existing file '${safePath}' (overwrite: false).`);
    }

    const normalized = normalizeEol(content, task.eol);
    // For appendFile on an existing file, suppress the BOM — planting a BOM
    // mid-file would corrupt the stream for UTF-8-aware readers. A fresh
    // appendFile (target absent) still gets the BOM when requested.
    const includeBom = !(append && targetExists);
    const buffer = encodeFileContent(normalized, task.encoding, includeBom);

    if (append) {
        fs.appendFileSync(safePath, buffer);
    } else {
        fs.writeFileSync(safePath, buffer);
    }

    return { path: safePath };
}

async function handleUnzip(
    task: any,
    allResults: any,
    workspaceFolderPath: string | undefined,
    run: ActionRunContext,
    redactOutput: boolean
): Promise<{ outputDir: string }> {
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

    // `zip` 과 같은 기준점. 예전에는 `handleUnzip` 이 `cwd` 를 아예 무시해,
    // 같은 설정이 zip 에서는 듣고 unzip 에서는 안 듣는 비대칭이 있었다.
    const archiveBase = (typeof task.cwd === 'string' && task.cwd.length > 0 ? task.cwd : undefined)
        || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // When `tool` is omitted, use the bundled zip engine. Only .zip archives
    // are supported by the built-in path; anything else requires an explicit
    // tool (e.g. 7z) since adm-zip cannot read those formats.
    if (task.tool === undefined || task.tool === null) {
        if (path.extname(archivePath).toLowerCase() !== '.zip') {
            throw new Error(`Built-in engine only supports .zip archives. For '${path.basename(archivePath)}', specify a 'tool' (e.g. 7z).`);
        }
        // 상대 경로는 `cwd` → 워크스페이스 기준이다. 내장 엔진은 cwd 개념이
        // 없어 `path.resolve` 가 extension host 의 `process.cwd()` 를 쓰는데,
        // 그건 VS Code 를 띄운 위치일 뿐이다 — 외부 tool 경로(자식 프로세스의
        // cwd 가 기준)와 결과가 갈렸다. `resolveArchiveTaskPath` 주석 참조.
        const resolvedArchive = resolveArchiveTaskPath(archivePath, archiveBase);
        const resolvedOutputDir = resolveArchiveTaskPath(outputDir, archiveBase);
        // 내장 엔진은 우리 코드라 취소를 실제로 받을 수 있다. 외부 tool
        // 경로는 `executeShellCommand` 가 자식 프로세스를 종료해 처리한다.
        const abort = abortSignalForAction(run, task.id);
        try {
            await extractZipArchive(resolvedArchive, resolvedOutputDir, { signal: abort.signal });
            // 다음 태스크가 `${unzip.outputDir}` 로 참조하는 값이므로 해석된
            // 절대 경로를 돌려준다 — 상대 경로를 그대로 넘기면 그 태스크가
            // 또 자기 기준으로 풀어 서로 다른 곳을 가리킨다.
            return { outputDir: resolvedOutputDir };
        } catch (error: any) {
            // 중지로 끝난 것을 "실패"로 포장하면 사용자가 누른 Stop 이
            // 오류처럼 보이고, 파이프라인의 중지 처리도 타지 않는다.
            if (isArchiveAbortError(error)) { throw new ActionStoppedError(); }
            throw new Error(`Failed to unzip file: ${error.message}`);
        } finally {
            abort.dispose();
        }
    }

    const toolCommand = getToolCommand(task.tool);
    const args = ['x', archivePath, `-o${outputDir}`, '-aoa'];
    try {
        await executeShellCommand(
            toolCommand,
            args,
            typeof task.cwd === 'string' && task.cwd.length > 0 ? task.cwd : undefined,
            task.env,
            workspaceFolderPath,
            run.id,
            task.id,
            redactOutput ? '[command hidden: uses password input]' : undefined,
            redactOutput ? SECRET_PLACEHOLDER : undefined,
            redactOutput,
            run.generation,
            redactOutput ? sensitiveDebugOutputObserver(run, task.id) : undefined
        );
        // 자식 프로세스는 자기 cwd 로 상대 경로를 풀지만, 우리가
        // `${unzip.outputDir}` 로 넘겨주는 값이 상대 경로로 남으면 그것을 받은
        // **다음 태스크**가 자기 기준으로 다시 푼다. 내장 엔진과 같은 절대
        // 경로를 돌려줘 `tool` 유무로 downstream 이 갈리지 않게 한다.
        return { outputDir: resolveArchiveTaskPath(outputDir, archiveBase) };
    } catch (error: any) {
        throw new Error(`Failed to unzip file: ${error.message}`);
    }
}

async function handleZip(
    task: import('./schema').Task,
    allResults: any,
    workspaceFolderPath: string | undefined,
    run: ActionRunContext,
    redactOutput: boolean,
    /**
     * `${extensionPath}` 를 해석하기 위해 받는다.
     *
     * `unzip` 은 `archive` · `destination` · `cwd` · `env` 를 `executeSingleTask`
     * 에서 **미리** 보간해 넘기므로 그쪽 컨텍스트(=`extensionPath` 포함)를 쓴다.
     * `zip` 만 `tool` 을 뺀 나머지를 여기서 직접 보간하는데, 이 컨텍스트에는
     * `extensionPath` 가 없어 `${extensionPath}` 가 **리터럴로 남았다** — Preview
     * 와 Doctor 는 둘 다 해석하므로 진단만 정상이라고 말하는 자리였다. 게다가
     * `tool` 은 미리 보간되어 해석되므로, 같은 태스크 안에서 `tool` 과
     * `archive` 가 서로 다른 규칙을 따르고 있었다.
     */
    extensionPath: string
): Promise<{ archivePath: string }> {
    const interpolationContext = Object.assign(Object.create(null), allResults, {
        workspaceFolder: workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        extensionPath,
    });

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

    // 외부 tool 경로가 자식 프로세스의 cwd 로 쓰는 값과 **같은 기준점**이다
    // (스키마: `cwd` 는 "Defaults to ${workspaceFolder}"). 내장 엔진도 이걸
    // 상대 경로의 기준으로 써야 `tool` 유무로 결과가 갈리지 않는다.
    const interpolatedCwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined;
    const archiveBase = interpolatedCwd || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    // When `tool` is omitted, use the bundled zip engine. Only .zip output is
    // supported; other formats still require an external tool.
    if (task.tool === undefined || task.tool === null) {
        if (path.extname(archive).toLowerCase() !== '.zip') {
            throw new Error(`Built-in engine only supports .zip archives. For '${path.basename(archive)}', specify a 'tool' (e.g. 7z).`);
        }
        // `resolveArchiveTaskPath` 주석 참조 — 내장 엔진의 `path.resolve` 는
        // extension host 의 `process.cwd()` 를 기준으로 삼는다.
        const resolvedArchive = resolveArchiveTaskPath(archive, archiveBase);
        const resolvedSources = sourcePaths.map(source => resolveArchiveTaskPath(source, archiveBase));
        const abort = abortSignalForAction(run, task.id);
        try {
            // 소스 밖을 가리키는 심볼릭 링크는 아카이브에 담지 않는다. 조용히
            // 빼면 "왜 이 파일이 zip 에 없지?" 가 되므로 반드시 알린다.
            const skippedLinks: string[] = [];
            let skippedLinkCount = 0;
            await createZipArchive(resolvedArchive, resolvedSources, {
                signal: abort.signal,
                onSkippedSymlink: ({ sourcePath, resolvedTarget }) => {
                    skippedLinkCount++;
                    if (!redactOutput) {
                        skippedLinks.push(sourcePath);
                        outputChannel.appendLine(
                            `[WARN] Skipped symlink '${sourcePath}' -> '${resolvedTarget}': it resolves outside the source folder and was not added to the archive.`
                        );
                    }
                },
            });
            if (skippedLinkCount > 0) {
                if (redactOutput) {
                    outputChannel.appendLine(
                        `[WARN] Password-derived zip task '${task.id}' excluded ${skippedLinkCount} symlink(s) pointing outside the source folder; path details hidden.`
                    );
                    vscode.window.showWarningMessage(t(
                        `password 입력에서 파생된 ZIP 태스크가 소스 폴더 밖을 가리키는 심볼릭 링크 ${skippedLinkCount}개를 제외했습니다. 경로 상세는 숨겼습니다.`,
                        `A password-derived ZIP task excluded ${skippedLinkCount} symlink(s) pointing outside the source folder. Path details were hidden.`
                    ));
                } else {
                    const shown = skippedLinks.slice(0, 3).map(p => path.basename(p)).join(', ');
                    const more = skippedLinkCount > 3 ? ` 외 ${skippedLinkCount - 3}개` : '';
                    const moreEn = skippedLinkCount > 3 ? ` and ${skippedLinkCount - 3} more` : '';
                    vscode.window.showWarningMessage(t(
                        `소스 폴더 밖을 가리키는 심볼릭 링크 ${skippedLinkCount}개를 아카이브에서 제외했습니다 (${shown}${more}). 자세한 내용은 TaskHub 출력 채널을 보세요.`,
                        `Excluded ${skippedLinkCount} symlink(s) pointing outside the source folder (${shown}${moreEn}). See the TaskHub output channel for details.`
                    ));
                }
            }
            // 다음 태스크가 `${zip.archivePath}` 로 받는 값이므로 해석된 절대
            // 경로를 돌려준다 — 상대 경로를 그대로 넘기면 그 태스크가 또 자기
            // 기준으로 풀어 서로 다른 파일을 가리킨다.
            return { archivePath: resolvedArchive };
        } catch (error: any) {
            if (isArchiveAbortError(error)) { throw new ActionStoppedError(); }
            throw new Error(`Failed to zip files for task '${task.id}': ${error.message}`);
        } finally {
            abort.dispose();
        }
    }

    const toolCommand = getToolCommand(task.tool);
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
            interpolatedCwd,
            envOverrides,
            workspaceFolderPath,
            run.id,
            task.id,
            redactOutput ? '[command hidden: uses password input]' : undefined,
            redactOutput ? SECRET_PLACEHOLDER : undefined,
            redactOutput,
            run.generation,
            redactOutput ? sensitiveDebugOutputObserver(run, task.id) : undefined
        );
        // 내장 엔진과 같은 절대 경로를 돌려준다 — 위 unzip 주석 참조.
        return { archivePath: resolveArchiveTaskPath(archive, archiveBase) };
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
    // Defaults are localized; `task.message`/`task.confirmLabel`/`task.cancelLabel`
    // are user-provided strings from the JSON config and are therefore NOT wrapped with t().
    const message = task.message || t('계속 진행하시겠습니까?', 'Are you sure you want to continue?');
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
    throw new PromptCancelledError(t('사용자가 확인을 취소했습니다.', 'Confirmation was canceled by the user.'));
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

    // Validate using the shared cached schema compiler.
    const validate = getActionsValidator();
    if (!validate(rawActions)) {
        const schemaErrors = validate.errors?.map(error =>
            `  - path: '${error.instancePath}' - ${error.message}`
        ).join('\n');
        errors.push(`Schema validation failed:\n${schemaErrors}`);
        return { actions: [], errors };
    }

    // Apply the same additional validation used when loading actions from disk,
    // so imported files cannot pass schema validation and then break action loading
    // (e.g. duplicate action IDs or duplicate task IDs inside a single action).
    try {
        performAdditionalActionValidation(rawActions, { sourceLabel: 'imported file', filePath: '<import>' });
    } catch (e: any) {
        errors.push(e.message);
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

    const gatherIds = (item: ActionItem, ids: string[]) => {
        if (item.id) { ids.push(item.id); }
        if (item.children) {
            for (const child of item.children) { gatherIds(child, ids); }
        }
    };

    const skipped: string[] = [];
    const newActions: ActionItem[] = [];
    for (const item of imported) {
        const ids: string[] = [];
        gatherIds(item, ids);
        const conflicts = ids.filter(id => existingIds.has(id));
        if (conflicts.length > 0) {
            skipped.push(...conflicts);
        } else {
            newActions.push(item);
            for (const id of ids) { existingIds.add(id); }
        }
    }

    return { merged: [...existing, ...newActions], skipped };
}

const DEFAULT_CAPTURE_LIMIT_MB = 10;
const CAPTURE_LIMIT_MIN_MB = 1;
const CAPTURE_LIMIT_MAX_MB = 1024;

const DEFAULT_TOTAL_RESULT_LIMIT_MB = 32;
const TOTAL_RESULT_LIMIT_MIN_MB = 1;
const TOTAL_RESULT_LIMIT_MAX_MB = 4096;

/**
 * 한 액션이 메모리에 들고 있을 수 있는 **태스크 결과 총량**.
 *
 * `stepResults` 는 뒤 태스크가 `${앞태스크.stdout}` 을 참조할 수 있어야 해서
 * 액션이 끝날 때까지 모든 결과를 들고 있는다. 태스크 하나의 출력은
 * `pipeline.outputCaptureLimitMb` 로 막혀 있었지만 **합계에는 제한이 없었다** —
 * 기본값(10MB)에서는 태스크가 수십 개여야 문제가 되지만, 로그가 잘려서 그
 * 설정을 1024MB 로 올린 사용자는 태스크 서넛만으로 GB 단위가 된다.
 *
 * **태스크 상한보다 작을 수 없다.** 사용자가 "이 태스크 출력 100MB 를 받겠다"고
 * 설정해 놓고 총량이 32MB 라 곧바로 실패하면, 두 설정이 서로를 부정하는 꼴이다.
 * 그래서 실효 총량은 둘 중 큰 값이다 — 태스크 상한을 올리면 총량도 최소한 그
 * 하나는 담을 수 있게 따라 올라간다.
 */
export function getTotalResultLimitBytes(
    configuredTotalMb?: number,
    perTaskLimitBytes?: number
): number {
    const raw = configuredTotalMb ?? vscode.workspace.getConfiguration('taskhub')
        .get<number>('pipeline.totalOutputLimitMb', DEFAULT_TOTAL_RESULT_LIMIT_MB);
    const clamped = Math.min(
        Math.max(Number(raw) || DEFAULT_TOTAL_RESULT_LIMIT_MB, TOTAL_RESULT_LIMIT_MIN_MB),
        TOTAL_RESULT_LIMIT_MAX_MB
    );
    const total = clamped * 1024 * 1024;
    const perTask = perTaskLimitBytes ?? getCaptureLimitBytes();
    return Math.max(total, perTask);
}

/**
 * 태스크 결과의 대략적인 바이트 크기.
 *
 * 정확한 힙 사용량이 아니라 **상대 비교용**이다. 무거운 것은 shell 태스크의
 * `stdout`/`stderr` 문자열이므로 문자열 길이를 더한다. 깊이를 제한해, 예상치
 * 못한 중첩 구조에서 이 계산 자체가 비싸지지 않게 한다.
 */
export function approximateResultBytes(value: unknown, depth = 0): number {
    if (depth > 3 || value === null || value === undefined) { return 0; }
    if (typeof value === 'string') { return Buffer.byteLength(value, 'utf8'); }
    if (typeof value === 'number' || typeof value === 'boolean') { return 8; }
    if (Array.isArray(value)) {
        let sum = 0;
        for (const item of value) { sum += approximateResultBytes(item, depth + 1); }
        return sum;
    }
    if (typeof value === 'object') {
        let sum = 0;
        for (const item of Object.values(value as Record<string, unknown>)) {
            sum += approximateResultBytes(item, depth + 1);
        }
        return sum;
    }
    return 0;
}

function getCaptureLimitBytes(): number {
    const configured = vscode.workspace.getConfiguration('taskhub').get<number>('pipeline.outputCaptureLimitMb', DEFAULT_CAPTURE_LIMIT_MB);
    const clamped = Math.min(Math.max(Number(configured) || DEFAULT_CAPTURE_LIMIT_MB, CAPTURE_LIMIT_MIN_MB), CAPTURE_LIMIT_MAX_MB);
    return clamped * 1024 * 1024;
}

export function __testHook_hasManuallyTerminated(id: string): boolean {
    return manuallyTerminatedActions.has(id);
}

/**
 * Spawn a shell command and capture both stdout AND stderr. On success
 * (exit 0) resolves with `{ stdout, stderr }` so callers that need stderr
 * (notably `output.diagnostics` for warnings) can access it; on failure
 * rejects with `ShellCommandError` carrying the same fields plus the
 * exit code. Callers that only care about stdout should read `.stdout`
 * from the resolved value.
 */
export function executeShellCommand(
    command: string,
    args: string[],
    cwd?: string,
    taskEnv?: Record<string, string>,
    workspaceFolderPath?: string,
    actionKey?: string,
    taskKey?: string,
    displayOverride?: string,
    workingDirectoryDisplayOverride?: string,
    redactCapturedOutput = false,
    runGeneration?: number,
    rawOutputObserver?: (target: 'stdout' | 'stderr', chunk: string) => void,
    discardCapturedOutput = false,
    /**
     * `shell` 타입 — 명령 문자열을 셸에 그대로 넘긴다 (0.6.47). `command`
     * 타입은 false 로 두어 토큰마다 인용하는 argv 실행을 유지한다.
     */
    raw = false
): Promise<{ stdout: string; stderr: string }> {

    const showVerboseLogs = vscode.workspace.getConfiguration('taskhub').get('pipeline.showVerboseLogs', false);
    const captureLimitBytes = getCaptureLimitBytes();

    return new Promise((resolve, reject) => {

        const { envOverrides, useUtf8Console } = resolveExecutionSettings(taskEnv);
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const [key, value] of Object.entries(envOverrides)) {
            childEnv[key] = value;
        }
        // Use undefined instead of empty string to let Node.js use process.cwd() as fallback
        const workingDirectory = cwd || workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || undefined;
        const shownWorkingDirectory = workingDirectoryDisplayOverride ?? workingDirectory;
        let childProcess: ReturnType<typeof spawn>;
        let displayCommand = '';
        let settled = false;

        // taskKey is empty-string for legacy callers that only carry an
        // actionKey (e.g. tests). Real callers from `executeSingleTask`
        // always pass `task.id`, so the per-task bucket gets used and
        // `terminateChildProcesses(actionId, taskId)` can target just
        // this task's children without affecting siblings.
        const effectiveTaskKey = taskKey ?? '';
        const effectiveBucketKey = taskGenerationBucketKey(effectiveTaskKey, runGeneration);
        // Prefix verbose log lines with the task id so parallel runs are
        // distinguishable in the OutputChannel. Legacy callers (no taskKey)
        // keep the unprefixed format to avoid churn in existing log tooling.
        // Multiline stdout/stderr is split so every continuation line carries
        // the prefix — otherwise only the first line is identifiable when two
        // tasks' output blocks land back-to-back.
        const taskLogPrefix = effectiveTaskKey ? `[task:${effectiveTaskKey}] ` : '';
        const appendVerboseLine = (line: string) => {
            if (!line.includes('\n') && !line.includes('\r')) {
                outputChannel.appendLine(`${taskLogPrefix}${line}`);
                return;
            }
            // Split on every line break form: `\r\n` (Windows) is matched
            // before a bare `\r` so a CRLF pair is consumed once, and bare
            // `\r` (terminal progress lines like `foo\rbar`) gets prefixed
            // too — otherwise progress output stays as one prefix-less blob.
            const parts = line.split(/\r\n|\r|\n/);
            if (parts.length > 0 && parts[parts.length - 1] === '') {
                parts.pop();
            }
            for (const part of parts) {
                outputChannel.appendLine(`${taskLogPrefix}${part}`);
            }
        };

        const trackChildProcess = () => {
            if (!actionKey) { return; }
            let perAction = actionChildProcesses.get(actionKey);
            if (!perAction) {
                perAction = new Map();
                actionChildProcesses.set(actionKey, perAction);
            }
            let bucket = perAction.get(effectiveBucketKey);
            if (!bucket) {
                bucket = {
                    taskId: effectiveTaskKey,
                    generation: runGeneration,
                    processes: new Set<ReturnType<typeof spawn>>(),
                };
                perAction.set(effectiveBucketKey, bucket);
            }
            bucket.processes.add(childProcess);
        };

        const cleanupChildTracking = (target: ReturnType<typeof spawn>) => {
            if (!actionKey) { return; }
            const perAction = actionChildProcesses.get(actionKey);
            if (!perAction) { return; }
            const bucket = perAction.get(effectiveBucketKey);
            if (!bucket) { return; }
            bucket.processes.delete(target);
            if (bucket.processes.size === 0) {
                perAction.delete(effectiveBucketKey);
                if (perAction.size === 0) {
                    actionChildProcesses.delete(actionKey);
                }
            }
        };

        let stdout = '';
        let stderr = '';
        let capturedBytes = 0;
        let captureOverflowed = false;

        const appendCapture = (target: 'stdout' | 'stderr', chunk: string) => {
            // Password-derived pass-through-disabled tasks use pipes only to
            // drain the child safely. Ordinary runs neither retain bytes nor
            // apply the capture limit; explicit sensitive-debug runs install
            // an observer and use the normal bounded capture path instead.
            if (discardCapturedOutput) { return; }
            if (captureOverflowed) { return; }
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            if (wouldExceedCaptureLimit(capturedBytes, chunkBytes, captureLimitBytes)) {
                if (rawOutputObserver) {
                    try { rawOutputObserver(target, chunk); } catch { /* debug UI must not alter execution */ }
                }
                // Mark overflow but do NOT add to manuallyTerminatedActions —
                // this is an action *failure*, not a user-initiated stop. The
                // close handler below converts this into a rejected promise so
                // executeAction() reports it through the normal failure path
                // (history 'failure' with the real error message, not
                // "Action stopped by user").
                captureOverflowed = true;
                // 트리를 종료한다. 래퍼만 죽이면 무한히 뿜던 자손이 stdout
                // 파이프를 계속 붙잡아 `close` 가 오지 않고, 액션이 영영
                // 끝나지 않는다 — OOM 은 막았지만 그보다 나쁜 상태가 된다.
                void killProcessTree(childProcess);
                return;
            }
            capturedBytes += chunkBytes;
            if (target === 'stdout') { stdout += chunk; } else { stderr += chunk; }
            if (rawOutputObserver) {
                try { rawOutputObserver(target, chunk); } catch { /* debug UI must not alter execution */ }
            }
        };

        const startPowerShellFallback = (reason?: Error) => {
            const invocation = raw
                ? (() => {
                    const line = buildRawPowerShellCommandLine(command, args || []);
                    // 다른 두 경로와 달리 raw 캡처는 UTF-8 프리픽스를 붙이지
                    // 않고 있었다. PowerShell 이 OEM 코드페이지로 파이프에 쓰는데
                    // 우리는 `setEncoding('utf8')` 로 읽으므로, 비-ASCII 출력이
                    // 깨진 채 캡처됐다.
                    const utf8Prefix = useUtf8Console
                        ? '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n'
                        : '';
                    return { script: `${utf8Prefix}${line}`, display: line };
                })()
                : buildPowerShellInvocation(command, args || [], useUtf8Console);
            const encoded = encodePowerShellScript(withPowerShellExitCode(invocation.script));
            displayCommand = invocation.display;
            // raw 만 셸을 고른다. 비-raw 경로는 우리가 조립한 PowerShell
            // 스크립트라 5.1 에서도 그대로 돌고, 여기서 바꾸면 검증되지 않은
            // 실행 경로가 하나 더 생긴다. 스캔 대상은 `command` 다 — `args` 는
            // 우리가 인용하므로 그 안의 `&&` 는 연산자가 아니다.
            const shell = raw
                ? resolveRawShellExecutable(command, { env: childEnv })
                : 'powershell.exe';
            if (showVerboseLogs && reason) {
                appendVerboseLine(redactCapturedOutput
                    ? '[WARN] Native Windows process start failed (details hidden); retrying through PowerShell.'
                    : `[WARN] Native Windows process start failed (${reason.message}); retrying through PowerShell.`);
            }
            childProcess = spawn(shell, ['-NoProfile', '-EncodedCommand', encoded], {
                cwd: workingDirectory,
                env: childEnv
            });
            attachChildHandlers(false);
        };

        const attachChildHandlers = (allowPowerShellFallback: boolean) => {
            const attachedChild = childProcess;
            trackChildProcess();
            // Node 는 'error' 를 두 가지 상황에서 낸다: **spawn 실패**(프로세스가
            // 아예 없다)와 **kill 신호 전달 실패**(프로세스는 살아 있다). 후자에서
            // 추적을 해제하면 살아남은 flash/deploy 프로세스를 *Stop All* 이
            // 다시 찾지 못한다 — `killProcessTree` 결과를 보고서야 해제하는
            // 위쪽 계약과 정확히 같은 이유다. 'spawn' 이 온 뒤의 error 는
            // 추적을 유지하고, 실제 종료는 'close' 가 정리한다.
            let spawnConfirmed = false;
            attachedChild.on('spawn', () => { spawnConfirmed = true; });
            // 비밀이 보간된 명령은 가린 것으로 찍는다 — 로그 파일은 공유되기
            // 쉽고, 이력에서 가린 값이 여기로 새면 의미가 없다.
            if (showVerboseLogs) {
                appendVerboseLine(`[INFO] Executing command: ${displayOverride ?? displayCommand} in ${shownWorkingDirectory}`);
            }

            attachedChild.stdout?.setEncoding('utf8');
            attachedChild.stderr?.setEncoding('utf8');

            attachedChild.stdout?.on('data', (data) => { appendCapture('stdout', typeof data === 'string' ? data : String(data)); });
            attachedChild.stderr?.on('data', (data) => { appendCapture('stderr', typeof data === 'string' ? data : String(data)); });

            attachedChild.on('close', (code, signal) => {
                cleanupChildTracking(attachedChild);
                if (attachedChild !== childProcess || settled) {
                    return;
                }

                if (showVerboseLogs) {
                    if (redactCapturedOutput) {
                        appendVerboseLine('[INFO] STDOUT: [REDACTED: task used a password input]');
                        appendVerboseLine('[INFO] STDERR: [REDACTED: task used a password input]');
                    } else {
                        appendVerboseLine(`[INFO] STDOUT: ${stdout}`);
                        appendVerboseLine(`[INFO] STDERR: ${stderr}`);
                    }
                    appendVerboseLine(`[INFO] Command finished with exit code ${code}.`);
                }

                if (captureOverflowed) {
                    settled = true;
                    const limitMb = Math.round(captureLimitBytes / (1024 * 1024));
                    const limitError = new Error(t(
                        `캡처된 출력이 ${limitMb}MB 한도를 초과하여 명령을 중단했습니다. \`taskhub.pipeline.outputCaptureLimitMb\` 설정을 높이거나, 캡처가 필요 없다면 \`passTheResultToNextTask\` 를 꺼서 터미널로 흘려보내세요.`,
                        `Captured output exceeded the ${limitMb} MB limit and the command was aborted. Raise \`taskhub.pipeline.outputCaptureLimitMb\`, or turn off \`passTheResultToNextTask\` so the output streams to the terminal instead of being captured.`
                    ));
                    limitError.name = 'CaptureLimitError';
                    reject(limitError);
                    return;
                }

                settled = true;
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    // Carry the captured stdout/stderr on the error so callers
                    // can still parse diagnostics out of the failed build (gcc /
                    // clang emit errors on stderr AND exit non-zero).
                    reject(new ShellCommandError(
                        stderr || (signal
                            ? `Command terminated by signal ${signal}`
                            : `Command failed with exit code ${code}`),
                        stdout,
                        stderr,
                        code,
                        signal
                    ));
                }
            });

            attachedChild.on('error', (err) => {
                if (!spawnConfirmed) {
                    // spawn 자체가 실패했다 — 프로세스가 없으므로 추적에 남길
                    // 이유가 없고, 남기면 Stop All 이 죽은 항목을 붙잡는다.
                    cleanupChildTracking(attachedChild);
                }
                if (attachedChild !== childProcess || settled) {
                    return;
                }
                // Native `spawn(file, args)` on Windows can only launch real
                // executables. A `.cmd` / `.bat` shim surfaces as EINVAL (Node's
                // CVE-2024-27980 guard), an extensionless name that only exists
                // as `name.cmd` surfaces as ENOENT, and a script file (`.js`,
                // `.ps1`, …) or permission quirk surfaces as EINVAL / EACCES.
                // For any of these, retry through PowerShell, which resolves the
                // command the way a shell would.
                const errCode = (err as NodeJS.ErrnoException).code;
                if (allowPowerShellFallback && (errCode === 'ENOENT' || errCode === 'EINVAL' || errCode === 'EACCES')) {
                    stdout = '';
                    stderr = '';
                    capturedBytes = 0;
                    captureOverflowed = false;
                    if (rawOutputObserver) {
                        // The failed native attempt's output is intentionally
                        // retained in the consented report; do not erase it.
                    }
                    startPowerShellFallback(err);
                    return;
                }
                settled = true;
                if (showVerboseLogs) {
                    appendVerboseLine(redactCapturedOutput
                        ? '[ERROR] Failed to start command; details hidden because the task used a password input.'
                        : `[ERROR] Failed to start command: ${err.message}`);
                }
                reject(err);
            });
        };

        // `raw` 는 native 보다 **먼저** 갈린다 — 그 순서가 계약이다
        // (`windowsSpawnStrategy` 주석 참조). 예전에는 이 분기가 `raw` 를 보지
        // 않아 캡처 모드에서만 `&&` 가 리터럴 인자가 됐다.
        // `!raw &&` 로 짧게 끊는다 — raw 면 native 자격을 볼 필요가 없고, 그
        // 조회는 PATH 항목마다 `statSync` 를 도는 실제 I/O 다.
        const windowsStrategy = process.platform === 'win32'
            ? windowsSpawnStrategy(raw, !raw && windowsCommandIsDirectlyLaunchable(command, args || [], { env: childEnv }))
            : undefined;
        if (windowsStrategy === 'native') {
            const native = buildNativeCommandInvocation(command, args || []);
            displayCommand = native.display;
            // Windows 는 `taskkill /T` 가 pid 로 트리를 잡으므로 detached 가
            // 필요 없다 (POSIX 만 프로세스 그룹이 필요하다).
            childProcess = spawn(native.executable, native.args, {
                cwd: workingDirectory,
                env: childEnv
            });
            attachChildHandlers(true);
        } else if (windowsStrategy) {
            startPowerShellFallback();
        } else {
            const commandLine = raw
                ? buildRawShellCommandLine(command, args || [])
                : buildPosixCommandLine(command, args || []);
            displayCommand = commandLine;
            childProcess = spawn(commandLine, [], {
                cwd: workingDirectory,
                env: childEnv,
                shell: true,
                // 자기 프로세스 그룹을 갖게 해야 중지가 셸 아래의 실제 명령까지
                // 죽인다 (killProcessTree 의 `process.kill(-pid)`). 이게 없으면
                // 그룹 종료가 ESRCH 로 실패하고 래퍼만 죽어, 컴파일러·플래셔
                // 같은 자손이 계속 돈다 — Linux/macOS 에서 중지가 사실상
                // 동작하지 않던 원인이다.
                detached: true
            });
            attachChildHandlers(false);
        }

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

/**
 * Build the read-only document shown by `taskhub.viewHistoryCommand` — a
 * header (action title + run time) followed by one `[taskId]` section per
 * recorded command, in insertion order. Pure so the formatting is
 * unit-testable. Returns `null` when the entry has no recorded commands, so
 * the caller can surface the "nothing to show" notice instead.
 */
export function formatExecutedCommandsDocument(entry: HistoryEntry): string | null {
    if (!entry.commands || Object.keys(entry.commands).length === 0) {
        return null;
    }
    const header = t(
        `# 실행한 명령 — ${entry.actionTitle}\n# ${new Date(entry.timestamp).toLocaleString()}\n`,
        `# Executed commands — ${entry.actionTitle}\n# ${new Date(entry.timestamp).toLocaleString()}\n`
    );
    const body = Object.entries(entry.commands)
        .map(([taskId, command]) => `[${taskId}]\n${command}`)
        .join('\n\n');
    return `${header}\n${body}\n`;
}

export function activate(context: vscode.ExtensionContext) {
    // 파일/폴더 다이얼로그의 마지막 위치 저장소. 등록 전에 열린 다이얼로그는
    // 기억 없이 워크스페이스 폴더에서 열리므로 activate 최상단에서 연결한다.
    initDialogMemory(context);
    context.subscriptions.push(new vscode.Disposable(() => initDialogMemory(undefined)));
    // One-shot cleanup of the palette's retired private MRU list. `undefined`
    // removes the key; on an install that never had it this is a no-op.
    if (context.globalState.get(RUN_ANY_ACTION_MRU_KEY) !== undefined) {
        void context.globalState.update(RUN_ANY_ACTION_MRU_KEY, undefined);
    }
    // Publish the initial (idle) value so the *Stop All Actions* button is
    // hidden from the first render rather than on the first state change.
    syncRunningActionsContext();
    const terminalDisposable = vscode.window.onDidCloseTerminal(terminal => {
        for (const [key, actionTerminal] of actionTerminals.entries()) {
            if (actionTerminal.terminal === terminal) {
                actionTerminals.delete(key);
                break;
            }
        }
    });
    context.subscriptions.push(terminalDisposable);


    const mainViewProvider = new MainViewProvider(context, () => loadAllActions(context));
    // Register `taskhub.runAction.<id>` commands at activation so the user's
    // `keybindings.json` resolves to live commands as soon as the extension
    // loads. Cost: one `loadAllActions` JSON pass — comparable to the lazy
    // first `getChildren` call the TreeView would do anyway. Single context
    // subscription disposes every entry on deactivate, regardless of partial
    // state in the map.
    syncActionCommands(context);
    context.subscriptions.push(new vscode.Disposable(() => disposeAllActionCommands()));
    const workspaceLinkViewProvider = new LinkViewProvider();
    const favoriteViewProvider = new FavoriteViewProvider(context);
    const historyProvider = new HistoryProvider(context);
    context.subscriptions.push(
        mainViewProvider,
        workspaceLinkViewProvider,
        favoriteViewProvider,
        historyProvider,
        outputChannel,
        new vscode.Disposable(() => {
            previewOutputChannel?.dispose();
            previewOutputChannel = undefined;
        })
    );
    const mainView = vscode.window.createTreeView('mainView.main', { treeDataProvider: mainViewProvider });
    // Version moved out of the tree (it used to be the first row, which kept
    // the tree permanently non-empty and so suppressed the welcome view).
    // The description slot renders it muted next to the "Actions" title.
    mainView.description = context.extension.packageJSON.version;
    context.subscriptions.push(mainView);
    context.subscriptions.push(
        mainView.onDidExpandElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, true); } }),
        mainView.onDidCollapseElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, false); } })
    );
    workspaceLinkViewProvider.view = vscode.window.createTreeView('mainView.linkWorkspace', { treeDataProvider: workspaceLinkViewProvider });
    favoriteViewProvider.view = vscode.window.createTreeView('mainView.favorite', { treeDataProvider: favoriteViewProvider });
    historyProvider.view = vscode.window.createTreeView('mainView.history', { treeDataProvider: historyProvider });
    // Intentionally NOT calling refresh() here. Tree providers now load lazily
    // on first getChildren() (i.e. when the TaskHub sidebar is first opened),
    // so activation triggered by onLanguage:c / onLanguage:cpp stays cheap and
    // does not drag in JSON reads for links/favorites/history.
    context.subscriptions.push(workspaceLinkViewProvider.view, favoriteViewProvider.view, historyProvider.view);

    // History last-run badges contain a relative-day reference
    // (`HH:mm` / `어제 HH:mm` / `MM/DD`) and TreeItem.description does not
    // auto-refresh, so a session that spans midnight would otherwise keep
    // showing yesterday's `23:30` as today's. Two complementary refresh
    // hooks fix that:
    //   1. Hourly background tick — covers users who keep the History
    //      panel visible 24/7.
    //   2. onDidChangeVisibility — covers users who switch sidebar views
    //      and come back; ensures fresh time the moment they look.
    context.subscriptions.push(startHistoryAutoRefresh(historyProvider, 60 * 60 * 1000));
    context.subscriptions.push(historyProvider.view.onDidChangeVisibility(e => {
        if (e.visible) { historyProvider.refresh(); }
    }));

    // `${…}` 참조 자동완성.
    //
    // 스키마는 옵션 **키**까지만 제안한다. `${pick.paths}` 는 값 문자열 안에
    // 있고 무엇이 유효한지가 같은 액션의 다른 태스크 타입에 달렸으므로 스키마로는
    // 표현할 자리가 없다 — `canSelectMany` 는 제안되는데 정작 그 결과인 `.paths`
    // 는 아무 데서도 보이지 않아 "그런 것이 없는 줄 알았다"는 보고가 나왔다.
    //
    // **문구는 여기서 만든다.** `variableCompletions` 는 `previewRun` · `doctor` 와
    // 같이 `vscode` 에 의존하지 않는 순수 모듈이라 `t()` 를 쓸 수 없다.
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            [
                { scheme: 'file', pattern: '**/.vscode/actions.json' },
                { scheme: 'file', pattern: '**/.vscode/presets/*.json' },
                { scheme: 'file', pattern: '**/media/actions*.json' },
            ],
            {
                provideCompletionItems(document, position) {
                    const text = document.getText();
                    const offset = document.offsetAt(position);
                    const ref = referencePrefixAt(text, offset);
                    if (!ref) { return undefined; }
                    // 이미 입력한 부분을 함께 대체한다 — 그러지 않으면
                    // `${pick.` 뒤에 `pick.paths` 가 덧붙는다.
                    //
                    // **두 범위를 준다.** 하나만 주면 VS Code 는 두 모드에 같은
                    // 범위를 쓰므로 `editor.suggest.insertMode` 설정과 무관하게
                    // 커서 뒤가 그대로 남는다 — `${ask.va|lue}` 에서 항목을 고르면
                    // `${ask.valuelue}` 가 됐다.
                    //
                    // `ref.end` 는 **상한**이지 대체 범위가 아니다. 실제 범위는
                    // 아래에서 항목마다 정한다.
                    const start = document.positionAt(ref.start);
                    const inserting = new vscode.Range(start, position);
                    // 대안 끝까지 — 후보가 커서 뒤 글자와 이어지지 않을 때 쓰는 상한.
                    const toAlternativeEnd = new vscode.Range(start, document.positionAt(ref.end));
                    /**
                     * 지금 치고 있는 **id 구간**의 끝. 태스크 id 후보에만 쓴다.
                     *
                     * 커서 앞에 `.` 이 없다면 사용자는 id 를 치는 중이고, 뒤따르는
                     * `.key` 는 그 id 의 일부가 아니다(런타임도 첫 `.` 에서 자른다).
                     * 전역 참조는 `.key` 를 갖지 않으므로 이 좁히기를 적용하지 않는다.
                     * 찾지 못하면 `-1` — 호출부가 상한으로 폴백한다.
                     */
                    /**
                     * 지금 커서가 **태스크 id 를 치는 자리**이고 이 후보가 그 id 인가.
                     *
                     * 이 자리에서만 뒤따르는 `.key` 가 후보의 것이 아니라 사용자가
                     * 쓰던 키다. 전역 참조는 키를 갖지 않고, 결과 키 후보
                     * (`ask.value`)는 이미 키까지 품고 있다.
                     */
                    const isTaskIdPosition = (detail: VariableCompletionDetail): boolean =>
                        detail.kind === 'task' && !ref.prefix.includes('.');
                    const idSegmentEndFor = (detail: VariableCompletionDetail): number => {
                        if (!isTaskIdPosition(detail)) { return -1; }
                        const dot = text.indexOf('.', offset);
                        return dot >= 0 && dot < ref.end ? dot : -1;
                    };
                    /**
                     * 후보가 문서의 이 자리를 **정확히** 차지하고 있는가.
                     *
                     * 길이만 맞추면 안 된다 — 후보가 **기존 토큰의 접두사**일 때
                     * 그만큼만 지워서 고른 것과 다른 참조가 남는다.
                     * `${as|ky.value}` 에서 `ask` 를 고르면 `${asky.value}` 가 됐고,
                     * `${ask.va|luetail}` 에서 `ask.value` 를 고르면 `${ask.valuetail}`,
                     * `${ask|tail}` 에서 `ask` 를 고르면 `${asktail}` 이 됐다.
                     * 셋 다 오류 없이 **사용자가 고르지 않은 것**을 가리킨다.
                     *
                     * 그래서 뒤가 경계인지 본다: 대안이 거기서 끝나거나(`ref.end`),
                     * **id 를 치는 자리에서** 키 구분자 `.` 이 이어질 때만 인정한다.
                     *
                     * `.` 을 무조건 경계로 보면 반대쪽이 깨진다 — 남긴 `.key` 를
                     * 받아 줄 후보가 아니기 때문이다. 실제로 그랬다:
                     * `${workspaceFol|der.foo}` 에서 `workspaceFolder` 를 고르면
                     * `${workspaceFolder.foo}`, `${ask.va|lue.extra}` 에서
                     * `ask.value` 를 고르면 `${ask.value.extra}` 가 됐고, **런타임은
                     * 둘 다 해석하지 못해 리터럴로 남긴다.** 전역 참조는 키를 갖지
                     * 않고, 결과 키 후보는 이미 키까지 품고 있다.
                     */
                    const exactMatchEnd = (name: string, detail: VariableCompletionDetail): number => {
                        if (!text.startsWith(name, ref.start)) { return -1; }
                        const end = ref.start + name.length;
                        if (end === ref.end) { return end; }
                        return isTaskIdPosition(detail) && text[end] === '.' ? end : -1;
                    };
                    return collectVariableCompletions(text, offset).map(entry => {
                        const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Variable);
                        item.detail = describeVariableCompletion(entry.detail);
                        // **대체 범위는 항목마다 다르다.** 후보가 커서 뒤 글자와
                        // 그대로 이어지면 딱 그만큼만 덮는다. 대안 끝까지 일률로
                        // 덮으면 넣는 글자와 지우는 글자가 어긋나 두 가지가 깨졌다.
                        //
                        // - `${as|k.value}` 에서 `ask` 를 고르면 `${ask}` 가 됐다.
                        //   `insertText` 는 맨 id 인데 범위는 `ask.value` 였다.
                        //   결과가 유효한 참조 모양이라 오류도 안 나고, bare 참조는
                        //   `output`/`outputDir` 폴백을 타 **다른 값을 가리킨다.**
                        // - `${my| task.value}` 에서 `my task`(공백 든 id — 스키마가
                        //   막지 않고 런타임도 해석한다) 를 고르면 범위는 `my` 뿐인데
                        //   `my task` 를 넣어 `${my task task.value}` 가 됐다. 이쪽은
                        //   `insert` 모드에서도 걸리던, range 를 쪼개기 전부터 있던 것이다.
                        //
                        // 커서에 못 미치는 일치는 버린다 — VS Code 는 대체 범위가
                        // 삽입 범위를 품기를 요구하므로(`${asktail|}` 에 후보 `ask`),
                        // 어기면 항목이 조용히 사라진다.
                        //
                        // 정확히 이어지지 않는 후보도 **id 를 치고 있는 자리에서는**
                        // 뒤따르는 `.key` 를 건드리면 안 된다. 형제 id 가 그 자리다 —
                        // `ask` 와 `asky` 가 있을 때 `${as|k.value}` 에서 `asky` 를
                        // 고르면 `${asky}` 가 되어 위와 똑같이 `.value` 가 사라진다.
                        // 반면 전역 참조(`workspaceFolder`)는 `.key` 를 갖지 않으므로
                        // 표현식 전체를 대체하는 것이 맞다. 그래서 후보의 종류로 가른다.
                        const exact = exactMatchEnd(entry.name, entry.detail);
                        const exactEnd = exact >= 0 ? exact : idSegmentEndFor(entry.detail);
                        item.range = {
                            inserting,
                            replacing: exactEnd >= offset
                                ? new vscode.Range(start, document.positionAt(exactEnd))
                                : toAlternativeEnd,
                        };
                        item.insertText = entry.name;
                        return item;
                    });
                },
            },
            '{', '.'
        )
    );

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

    // Bundled media/*.json files inside the installed extension cannot change
    // at runtime for end users, so we only watch them during development.
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        const mediaActionsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, 'media/actions.json'));
        const debouncedMediaActionsRefresh = debounce(() => refreshActionsAndCommands(context, mainViewProvider), 200);
        mediaActionsWatcher.onDidChange(debouncedMediaActionsRefresh.run);
        mediaActionsWatcher.onDidCreate(debouncedMediaActionsRefresh.run);
        mediaActionsWatcher.onDidDelete(debouncedMediaActionsRefresh.run);
        context.subscriptions.push(new vscode.Disposable(() => { debouncedMediaActionsRefresh.cancel(); mediaActionsWatcher.dispose(); }));
    }
    const workspaceActionsWatchers = registerWorkspaceFileWatchers('.vscode/actions.json', () => refreshActionsAndCommands(context, mainViewProvider));
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
            const workspaceRoots = getWorkspaceRoots();
            if (workspaceRoots.length === 0) {
                vscode.window.showErrorMessage(t('즐겨찾기 파일을 열 워크스페이스가 없습니다.', 'No workspace is open to resolve the favorite file.'));
                return;
            }
            let resolvedPath: string;
            try {
                resolvedPath = resolveFavoriteFilePath(target.path, workspaceFolderPath, workspaceRoots);
            } catch {
                vscode.window.showErrorMessage(t(
                    `즐겨찾기 파일이 워크스페이스 밖에 있어 열 수 없습니다: ${target.path}`,
                    `Favorite file is outside the workspace and cannot be opened: ${target.path}`
                ));
                return;
            }
            if (!fs.existsSync(resolvedPath)) {
                const removeLabel = t('즐겨찾기에서 제거', 'Remove from Favorites');
                const choice = await vscode.window.showErrorMessage(
                    t(
                        `즐겨찾기 파일을 찾을 수 없습니다: ${target.path}`,
                        `Favorite file not found: ${target.path}`
                    ),
                    removeLabel
                );
                if (choice === removeLabel && target.sourceFile && fs.existsSync(target.sourceFile)) {
                    const sourceFile = target.sourceFile;
                    const loadResult = readFavoritesFromDisk(sourceFile, target.workspaceFolder);
                    if (!loadResult.ok) {
                        const openLabel = t('favorites.json 열기', 'Open favorites.json');
                        const repairChoice = await vscode.window.showErrorMessage(
                            t(
                                `favorites.json 파싱에 실패해 항목을 제거할 수 없습니다: ${loadResult.error}`,
                                `Could not remove the entry — failed to parse favorites.json: ${loadResult.error}`
                            ),
                            openLabel
                        );
                        if (repairChoice === openLabel) {
                            const document = await vscode.workspace.openTextDocument(sourceFile);
                            await vscode.window.showTextDocument(document, { preview: false });
                        }
                    } else {
                        const filtered = removeFavoriteByIdentity(loadResult.entries, target);
                        if (filtered.length !== loadResult.entries.length) {
                            const serialized = mergeInvalidJsonEntries(serializeFavorites(filtered), loadResult.invalid);
                            fs.writeFileSync(sourceFile, JSON.stringify(serialized, null, 2) + '\n');
                            favoriteViewProvider.refresh();
                        }
                    }
                }
                return;
            }
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
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openLink', async (url: string) => { await openExternalLinkSafely(url); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.copyLink', async (item: Link) => { await vscode.env.clipboard.writeText(item.getLink()); vscode.window.showInformationMessage(t('링크가 클립보드에 복사되었습니다.', 'Link copied to clipboard.')); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.goToLink', async (item: Link) => { await openExternalLinkSafely(item.getLink()); }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.executeAction', async (actionItem: Action) => {
        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(t(`액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action: ${error.message}`));
            return;
        }

        const actionId = actionItem.id;
        if (!actionId) {
            return;
        }
        const fullActionItem = findActionById(allActions, actionId);
        if (fullActionItem) {
            const pathParts = findActionPathById(allActions, actionId);
            try {
                await executeAction(fullActionItem, context, mainViewProvider, historyProvider, undefined, pathParts);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[ERROR] Execution failed for action '${actionId}': ${msg}`);
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
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(t(`ID로 액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action by ID: ${error.message}`));
            return;
        }
        const actionItem = findActionById(allActions, args.id);
        if (actionItem && actionItem.action) {
            const pathParts = findActionPathById(allActions, args.id);
            // Mirror `taskhub.executeAction`'s catch (line ~3162): pipeline
            // failures already surface via `handleActionFailure`'s user
            // notification — re-throwing here would let VS Code show a
            // second generic "command failed" toast on top of it. The
            // keybinding entry point goes through this command, so the
            // catch is essential for that path.
            try {
                await executeAction(actionItem, context, mainViewProvider, historyProvider, undefined, pathParts);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[ERROR] Execution failed for action '${args.id}': ${msg}`);
            }
        } else {
            vscode.window.showErrorMessage(t(`ID '${args.id}'인 액션을 찾을 수 없거나 'action' 속성이 없습니다.`, `Action with ID '${args.id}' not found or it has no 'action' property.`));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.runAnyAction', async () => {
        const rawLimit = vscode.workspace.getConfiguration()
            .get<number>('taskhub.runAnyAction.recentLimit', RUN_ANY_ACTION_MRU_DEFAULT_LIMIT);
        // Recency comes from the History panel, not from a palette-private
        // list: running an action from the tree, a keybinding, or a history
        // re-run all land here. History is workspace-scoped, so the recent
        // section no longer leaks action ids between projects either.
        //
        // Ceiling note: History keeps at most `taskhub.history.maxItems`
        // entries, so a recentLimit larger than that simply shows fewer rows.
        const lang: 'ko' | 'en' = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
        const now = Date.now();
        const recentRuns = deriveRecentActionRuns(historyProvider.getHistory());
        const recentDetails = new Map<string, string>();
        for (const run of recentRuns) {
            const detail = formatRecentRunDetail(run, now, lang);
            if (detail) { recentDetails.set(run.actionId, detail); }
        }
        const outcome = planRunAnyAction(
            () => loadAllActions(context),
            recentRuns.map(run => run.actionId),
            rawLimit,
            { recent: t('최근 실행', 'Recently used'), rest: t('모든 액션', 'All actions') },
            recentDetails
        );

        if (outcome.kind === 'load-error') {
            // Broken actions.json — same surface as the tree view's load
            // failure: error toast + Output channel entry. Empty palettes
            // would silently hide the problem.
            outputChannel.appendLine(`[ERROR] ${outcome.errorMessage}`);
            vscode.window.showErrorMessage(t(
                `액션 목록을 불러올 수 없습니다: ${outcome.errorMessage}`,
                `Could not load actions: ${outcome.errorMessage}`
            ));
            return;
        }

        if (outcome.kind === 'empty') {
            vscode.window.showInformationMessage(t(
                '실행 가능한 액션이 없습니다.',
                'No runnable actions found.'
            ));
            return;
        }

        type RunAnyPickItem = vscode.QuickPickItem & { actionId?: string };
        const items: RunAnyPickItem[] = outcome.items.map(p => p.kind === 'separator'
            ? { label: p.label, kind: vscode.QuickPickItemKind.Separator }
            : { label: p.label, description: p.description, detail: p.detail, actionId: p.actionId });

        const selection = await vscode.window.showQuickPick(items, {
            placeHolder: t('실행할 액션을 검색하세요…', 'Search for an action to run…'),
            matchOnDescription: true,
            ignoreFocusOut: false
        });
        if (!selection || !selection.actionId) {
            return;
        }

        // No MRU write: `executeActionById` → `executeAction` records the run
        // in History, which is what the recent section reads on next open.
        await vscode.commands.executeCommand('taskhub.executeActionById', { id: selection.actionId });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.assignShortcut', async (actionItem: Action) => {
        const actionId = actionItem?.id;
        if (!actionId) {
            vscode.window.showWarningMessage(t('이 액션에는 ID가 없어 단축키를 지정할 수 없습니다.', 'This action has no id; cannot assign a shortcut.'));
            return;
        }
        const commandId = buildActionCommandId(actionId);
        // The string argument is consumed by VS Code's Keyboard Shortcuts UI
        // as a search-box prefilter, so the user lands directly on the row
        // for this action's command. We never write to keybindings.json
        // ourselves — the user assigns the key in the native UI.
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', commandId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.previewAction', async (actionItem: Action) => {
        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(t(`액션을 미리 볼 수 없습니다: ${error.message}`, `Could not preview action: ${error.message}`));
            return;
        }
        const actionId = actionItem?.id;
        if (!actionId) {
            vscode.window.showWarningMessage(t('미리 보려는 액션을 선택하세요.', 'Select an action to preview.'));
            return;
        }
        const fullActionItem = findActionById(allActions, actionId);
        if (!fullActionItem || !fullActionItem.action) {
            vscode.window.showErrorMessage(t(
                `ID '${actionId}'에 대한 액션 정의를 찾을 수 없습니다.`,
                `Could not find action definition for ID '${actionId}'.`
            ));
            return;
        }
        const workspaceFolder = actionWorkspaceFolderMap.get(actionId)
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ?? '';
        const report = buildPreviewReport(fullActionItem, {
            workspaceFolder,
            extensionPath: context.extensionPath,
            workspaceRoots: getWorkspaceRoots(),
        });
        const channel = getPreviewOutputChannel();
        channel.appendLine(report);
        channel.appendLine('');
        channel.show(true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.doctor', async () => {
        const inputs: DoctorInput[] = collectDoctorInputs(context);
        if (inputs.length === 0) {
            vscode.window.showInformationMessage(t(
                'TaskHub Doctor: 점검할 actions.json 소스를 찾을 수 없습니다.',
                'TaskHub Doctor: no actions.json sources were found to lint.'
            ));
            return;
        }
        const validator = getActionsValidator() as unknown as (data: unknown) => boolean;
        // AJV's ValidateFunction exposes `.errors` as a property on the
        // function object; cast through unknown to satisfy DoctorValidator.
        //
        // **한 소스의 예외가 나머지 소스의 결과까지 지우지 않게 한다.** Doctor 는
        // 임의의 사용자 JSON 을 정적 분석하므로 분석기 하나가 예외를 던지면
        // (예전에는 아주 긴 명령줄이 `RangeError` 를 냈다) 진단이 하나도 게시되지
        // 않고 이유도 보이지 않았다. 소스마다 따로 돌려 실패한 소스에는 그 사실을
        // finding 으로 남긴다 — 그래야 나머지 진단이 살고, 이전 진단도 갱신된다.
        const findings = runDoctorPerSource(inputs, validator as any, (input, error: any) => {
            outputChannel.appendLine(`[Doctor] analysis failed for ${input.sourceLabel}: ${error?.stack ?? error}`);
        });
        publishDoctorDiagnostics(findings);

        const errorCount = findings.filter(f => f.severity === 'error').length;
        const warningCount = findings.filter(f => f.severity === 'warning').length;
        if (findings.length === 0) {
            vscode.window.showInformationMessage(t(
                `TaskHub Doctor: ${inputs.length}개 소스 점검 완료 — 문제 없음.`,
                `TaskHub Doctor: scanned ${inputs.length} source(s) — no issues found.`
            ));
        } else {
            const action = await vscode.window.showWarningMessage(
                t(
                    `TaskHub Doctor: ${findings.length}개 문제 발견 (오류 ${errorCount}, 경고 ${warningCount}). Problems 패널 확인.`,
                    `TaskHub Doctor: ${findings.length} issue(s) found (errors: ${errorCount}, warnings: ${warningCount}). See the Problems panel.`
                ),
                t('Problems 열기', 'Open Problems')
            );
            if (action) {
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            }
        }
        outputChannel.appendLine(`[Doctor] scanned ${inputs.length} source(s); ${findings.length} finding(s) (errors=${errorCount}, warnings=${warningCount}).`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.stopAction', (actionItem: Action) => {
        const id = actionItem.id || actionItem.label;
        if (!id) {
            return;
        }
        if (!stopRunningAction(id)) {
            manuallyTerminatedActions.delete(id);
            vscode.window.showWarningMessage(t(`'${actionItem.label}'에 대한 활성 태스크를 찾을 수 없습니다.`, `Could not find active task for '${actionItem.label}'.`));
            return;
        }
        recordManualStopInHistory(historyProvider, id);
        syncRunningActionsContext();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showVersion', () => {
        const version = context.extension.packageJSON.version;
        vscode.window.showInformationMessage(t(`TaskHub 버전: ${version}`, `TaskHub Version: ${version}`));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showChangelog', async () => {
        const changelogPath = path.join(context.extensionPath, 'CHANGELOG.md');
        if (fs.existsSync(changelogPath)) {
            const doc = await vscode.workspace.openTextDocument(changelogPath);
            await vscode.window.showTextDocument(doc, { preview: true });
        } else {
            vscode.window.showWarningMessage(t('CHANGELOG.md 파일을 찾을 수 없습니다.', 'CHANGELOG.md not found.'));
        }
    }));
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
        // Simplified flow (v0.4.32): URL → title (host-default) → save.
        // Group / tags are no longer prompted — the post-creation toast
        // points the user at *links.json 열기* if they want to add metadata.
        // Save-time scheme validation is wired in here so a typo (e.g.
        // `localhost:3000` without scheme) is caught immediately, not at
        // first click as before. Broken links.json refuses to save and
        // shows an *Open links.json* recovery button instead of silently
        // overwriting the corrupt file with a single-entry array.
        const folder = await pickWorkspaceFolderForCommand(t('링크를 추가할 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to add the link to'));
        if (!folder) {
            return;
        }

        const url = await vscode.window.showInputBox({
            prompt: t('열 URL', 'URL to open'),
            placeHolder: 'https://example.com',
            ignoreFocusOut: true,
            validateInput: linkUrlValidateInputMessage
        });
        if (!url) {
            return;
        }

        const title = await vscode.window.showInputBox({
            prompt: t('링크 제목', 'Title for the link'),
            value: deriveLinkTitleFromUrl(url),
            placeHolder: 'e.g. Project Dashboard',
            ignoreFocusOut: true,
            validateInput: value => value.trim().length === 0 ? t('제목을 입력하세요', 'Enter a title') : null
        });
        if (!title) {
            return;
        }

        const linksPath = path.join(folder.uri.fsPath, '.vscode', 'links.json');
        const loadResult = readLinksFromDisk(linksPath);
        if (!loadResult.ok) {
            const openLabel = t('links.json 열기', 'Open links.json');
            const choice = await vscode.window.showErrorMessage(
                t(
                    `links.json 파싱에 실패해 변경 사항을 저장할 수 없습니다: ${loadResult.error}`,
                    `Cannot save — failed to parse links.json: ${loadResult.error}`
                ),
                openLabel
            );
            if (choice === openLabel && fs.existsSync(linksPath)) {
                const document = await vscode.workspace.openTextDocument(linksPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }

        const { entries: updatedLinks, added } = addLinkEntry(loadResult.entries, {
            title,
            link: url,
            sourceFile: linksPath
        });
        if (!added) {
            const openLabel = t('links.json 열기', 'Open links.json');
            const choice = await vscode.window.showInformationMessage(
                t('이 링크는 links.json에 이미 존재합니다.', 'This link already exists in links.json.'),
                openLabel
            );
            if (choice === openLabel && fs.existsSync(linksPath)) {
                const document = await vscode.workspace.openTextDocument(linksPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }

        const serialized = mergeInvalidJsonEntries(serializeLinks(updatedLinks), loadResult.invalid);
        if (!fs.existsSync(path.dirname(linksPath))) {
            fs.mkdirSync(path.dirname(linksPath), { recursive: true });
        }
        fs.writeFileSync(linksPath, JSON.stringify(serialized, null, 2) + '\n');
        workspaceLinkViewProvider.refresh();

        const openLabel = t('links.json 열기', 'Open links.json');
        const choice = await vscode.window.showInformationMessage(
            t(
                `'${title}' 링크가 links.json에 추가되었습니다. 그룹/태그 등 추가 설정이 필요하면 links.json을 편집하세요.`,
                `Link '${title}' was added to links.json. Edit it to configure group, tags, or other metadata.`
            ),
            openLabel
        );
        if (choice === openLabel) {
            const document = await vscode.workspace.openTextDocument(linksPath);
            await vscode.window.showTextDocument(document, { preview: false });
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.searchFavorites', async () => {
        await promptFavoriteSearch(favoriteViewProvider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.addFavoriteFile', async (uri?: vscode.Uri) => {
        // Simplified flow (v0.4.32): pick files → save with basename as
        // title and relative path. No per-file title / line / group / tag
        // prompts — the post-creation toast points the user at
        // *favorites.json 열기* if they want to add metadata afterwards.
        // The dialog opens at the folder the user last added favorites from;
        // on the first use it falls back to the active editor's workspace
        // folder (instead of always folder[0]) so multi-root users land in
        // the folder they're working in.
        let fileUris: vscode.Uri[] | undefined;
        if (uri) {
            fileUris = [uri];
        } else {
            fileUris = await showOpenDialogWithMemory(DIALOG_SCOPE.favoriteFile, {
                canSelectMany: true,
                openLabel: t('즐겨찾기에 추가', 'Add to Favorites')
            });
        }

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const favoritesByPath = new Map<string, FavoriteEntry[]>();
        const invalidByPath = new Map<string, InvalidJsonEntry[]>();
        const failedLoads = new Map<string, string>();
        const pathsWithAdditions = new Set<string>();
        let addedCount = 0;
        let skippedCount = 0;
        let duplicateCount = 0;
        let lastFavoritesPath: string | undefined;

        for (const fileUri of fileUris) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (!workspaceFolder) {
                vscode.window.showWarningMessage(t(
                    `${fileUri.fsPath}은(는) 현재 워크스페이스에 포함되어 있지 않아 건너뜁니다.`,
                    `Skipping ${fileUri.fsPath} because it is not part of the current workspace.`
                ));
                skippedCount++;
                continue;
            }
            const favoritesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'favorites.json');
            if (failedLoads.has(favoritesPath)) {
                skippedCount++;
                continue;
            }
            if (!favoritesByPath.has(favoritesPath)) {
                const loadResult = readFavoritesFromDisk(favoritesPath, workspaceFolder.uri.fsPath);
                if (!loadResult.ok) {
                    failedLoads.set(favoritesPath, loadResult.error);
                    skippedCount++;
                    continue;
                }
                favoritesByPath.set(favoritesPath, loadResult.entries);
                // 이 배치는 파일 여러 개를 돌므로 무효 항목도 파일별로 들고 간다
                // — 되쓸 때 각자의 원본 항목을 다시 끼워 넣어야 한다.
                invalidByPath.set(favoritesPath, loadResult.invalid);
            }
            const favorites = favoritesByPath.get(favoritesPath)!;
            const { entries: updatedFavorites, added } = addFavoriteEntry(favorites, {
                title: path.basename(fileUri.fsPath),
                path: toWorkspaceRelativePath(fileUri.fsPath, workspaceFolder.uri.fsPath),
                sourceFile: favoritesPath,
                workspaceFolder: workspaceFolder.uri.fsPath
            });
            if (!added) {
                duplicateCount++;
                continue;
            }
            // Replace the cached array so subsequent dups in the same batch
            // see the new entry too — `addFavoriteEntry` returns a new array
            // rather than mutating, mirroring `addLinkEntry`.
            favoritesByPath.set(favoritesPath, updatedFavorites);
            pathsWithAdditions.add(favoritesPath);
            addedCount++;
            lastFavoritesPath = favoritesPath;
        }

        // Only rewrite favorites.json files that actually grew. Without
        // this guard, an all-duplicate drop would still re-serialize each
        // touched file (no content change but unnecessary disk churn +
        // mtime bump that would also trigger a JSON Editor *external
        // change* prompt for an unrelated open editor — see 0.4.30).
        for (const favoritesPath of pathsWithAdditions) {
            const favorites = favoritesByPath.get(favoritesPath)!;
            const serialized = mergeInvalidJsonEntries(serializeFavorites(favorites), invalidByPath.get(favoritesPath) ?? []);
            if (!fs.existsSync(path.dirname(favoritesPath))) {
                fs.mkdirSync(path.dirname(favoritesPath), { recursive: true });
            }
            fs.writeFileSync(favoritesPath, JSON.stringify(serialized, null, 2) + '\n');
        }

        if (pathsWithAdditions.size > 0) {
            favoriteViewProvider.refresh();
        }

        // Recovery surface for any favorites.json that failed to parse —
        // we refused to write to it (P1 data-loss fix), so let the user
        // inspect/fix it here. One toast per broken path so the surface
        // matches the granularity of the failure.
        for (const [failedPath, errorMessage] of failedLoads.entries()) {
            const openLabel = t('favorites.json 열기', 'Open favorites.json');
            const choice = await vscode.window.showErrorMessage(
                t(
                    `${path.basename(failedPath)} 파싱에 실패해 일부 즐겨찾기를 저장하지 못했습니다: ${errorMessage}`,
                    `Could not save some favorites — failed to parse ${path.basename(failedPath)}: ${errorMessage}`
                ),
                openLabel
            );
            if (choice === openLabel && fs.existsSync(failedPath)) {
                const document = await vscode.workspace.openTextDocument(failedPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
        }

        if (addedCount > 0) {
            // Combine skipped (workspace mismatch / broken parse) and
            // duplicate counts into a single tail clause so the toast does
            // not need to grow another line for each new failure mode.
            const tailKo: string[] = [];
            const tailEn: string[] = [];
            if (duplicateCount > 0) {
                tailKo.push(`${duplicateCount}개 중복 건너뜀`);
                tailEn.push(`${duplicateCount} duplicate(s) skipped`);
            }
            if (skippedCount > 0) {
                tailKo.push(`${skippedCount}개 건너뜀`);
                tailEn.push(`${skippedCount} skipped`);
            }
            const tail = tailKo.length > 0
                ? t(` (${tailKo.join(', ')})`, ` (${tailEn.join(', ')})`)
                : '';
            const summary = t(
                `${addedCount}개의 즐겨찾기가 favorites.json에 추가되었습니다${tail}. 제목/그룹/태그/줄 번호 등 추가 설정이 필요하면 favorites.json을 편집하세요.`,
                `Added ${addedCount} favorite(s) to favorites.json${tail}. Edit favorites.json to configure title, group, tags, or line number.`
            );
            const openLabel = t('favorites.json 열기', 'Open favorites.json');
            const choice = await vscode.window.showInformationMessage(summary, openLabel);
            if (choice === openLabel && lastFavoritesPath && fs.existsSync(lastFavoritesPath)) {
                const document = await vscode.workspace.openTextDocument(lastFavoritesPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
        } else if (duplicateCount > 0) {
            // No new entries written — the user dropped only files that
            // were already favorited. Surface this as the same recovery
            // path the link side uses (*links.json 열기*) so they can
            // verify or remove the existing rows.
            const openLabel = t('favorites.json 열기', 'Open favorites.json');
            const summary = duplicateCount === 1
                ? t(
                    '이 즐겨찾기는 favorites.json에 이미 존재합니다.',
                    'This favorite already exists in favorites.json.'
                )
                : t(
                    `${duplicateCount}개의 즐겨찾기가 이미 favorites.json에 존재합니다.`,
                    `${duplicateCount} favorites already exist in favorites.json.`
                );
            const lastDuplicatePath = lastFavoritesPath ?? Array.from(favoritesByPath.keys())[0];
            const choice = await vscode.window.showInformationMessage(summary, openLabel);
            if (choice === openLabel && lastDuplicatePath && fs.existsSync(lastDuplicatePath)) {
                const document = await vscode.workspace.openTextDocument(lastDuplicatePath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
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
        const loadResult = readFavoritesFromDisk(sourceFile, target.workspaceFolder);
        if (!loadResult.ok) {
            const openLabel = t('favorites.json 열기', 'Open favorites.json');
            const choice = await vscode.window.showErrorMessage(
                t(
                    `favorites.json 파싱에 실패해 항목을 삭제할 수 없습니다: ${loadResult.error}`,
                    `Cannot delete — failed to parse favorites.json: ${loadResult.error}`
                ),
                openLabel
            );
            if (choice === openLabel) {
                const document = await vscode.workspace.openTextDocument(sourceFile);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }
        const filtered = removeFavoriteByIdentity(loadResult.entries, target);
        if (filtered.length === loadResult.entries.length) {
            return;
        }
        const serialized = mergeInvalidJsonEntries(serializeFavorites(filtered), loadResult.invalid);
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
        const loadResult = readLinksFromDisk(sourceFile);
        if (!loadResult.ok) {
            const openLabel = t('links.json 열기', 'Open links.json');
            const choice = await vscode.window.showErrorMessage(
                t(
                    `links.json 파싱에 실패해 항목을 삭제할 수 없습니다: ${loadResult.error}`,
                    `Cannot delete — failed to parse links.json: ${loadResult.error}`
                ),
                openLabel
            );
            if (choice === openLabel) {
                const document = await vscode.workspace.openTextDocument(sourceFile);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }
        const links = loadResult.entries;
        const filtered = removeLinkByIdentity(links, target);
        if (filtered.length === links.length) {
            return;
        }
        const serialized = mergeInvalidJsonEntries(serializeLinks(filtered), loadResult.invalid);
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
        // Simplified flow (v0.4.32): zero prompts. The user clicked the
        // *Add Open File to Favorites* button → save THIS file at the
        // current cursor line with basename as title. Group / tags /
        // custom title go in via the post-creation toast's *Open
        // favorites.json* button. Broken favorites.json refuses to save
        // and shows the same recovery surface.
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(t('활성 편집기를 찾을 수 없습니다.', 'No active editor found.'));
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage(t('활성 파일이 열린 워크스페이스 폴더에 속하지 않습니다.', 'The active file does not belong to an open workspace folder.'));
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const favoritesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'favorites.json');
        const loadResult = readFavoritesFromDisk(favoritesPath, workspaceFolder.uri.fsPath);
        if (!loadResult.ok) {
            const openLabel = t('favorites.json 열기', 'Open favorites.json');
            const choice = await vscode.window.showErrorMessage(
                t(
                    `favorites.json 파싱에 실패해 변경 사항을 저장할 수 없습니다: ${loadResult.error}`,
                    `Cannot save — failed to parse favorites.json: ${loadResult.error}`
                ),
                openLabel
            );
            if (choice === openLabel && fs.existsSync(favoritesPath)) {
                const document = await vscode.workspace.openTextDocument(favoritesPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }

        const title = path.basename(filePath);
        const line = editor.selection.active.line + 1;
        const favorite: FavoriteEntry = {
            title,
            path: toWorkspaceRelativePath(filePath, workspaceFolder.uri.fsPath),
            line,
            sourceFile: favoritesPath,
            workspaceFolder: workspaceFolder.uri.fsPath
        };
        const { entries: updatedFavorites, added } = addFavoriteEntry(loadResult.entries, favorite);
        const openLabel = t('favorites.json 열기', 'Open favorites.json');

        if (!added) {
            // Same line of the same file already favorited. Mirror the
            // Add Link duplicate path so the user gets a recovery toast
            // instead of a confusing "saved" message followed by the row
            // not appearing twice in the tree.
            const choice = await vscode.window.showInformationMessage(
                t(
                    `'${title}' (줄 ${line})는 favorites.json에 이미 존재합니다.`,
                    `'${title}' (line ${line}) already exists in favorites.json.`
                ),
                openLabel
            );
            if (choice === openLabel && fs.existsSync(favoritesPath)) {
                const document = await vscode.workspace.openTextDocument(favoritesPath);
                await vscode.window.showTextDocument(document, { preview: false });
            }
            return;
        }

        const serialized = mergeInvalidJsonEntries(serializeFavorites(updatedFavorites), loadResult.invalid);
        if (!fs.existsSync(path.dirname(favoritesPath))) {
            fs.mkdirSync(path.dirname(favoritesPath), { recursive: true });
        }
        fs.writeFileSync(favoritesPath, JSON.stringify(serialized, null, 2) + '\n');
        favoriteViewProvider.refresh();

        const choice = await vscode.window.showInformationMessage(
            t(
                `'${title}' (줄 ${line})가 favorites.json에 추가되었습니다. 제목/그룹/태그 등 추가 설정이 필요하면 favorites.json을 편집하세요.`,
                `'${title}' (line ${line}) was added to favorites.json. Edit favorites.json to configure title, group, or tags.`
            ),
            openLabel
        );
        if (choice === openLabel) {
            const document = await vscode.workspace.openTextDocument(favoritesPath);
            await vscode.window.showTextDocument(document, { preview: false });
        }
    }));
    /**
     * Stop every running action — and *only* that. Closing terminals was
     * folded into the old `terminateAllActions`, which meant the user lost
     * the output they were reading as the price of stopping a build.
     * Terminals now have their own command.
     */
    const stopAllRunningActions = (): Promise<StopAllOutcome> => runStopAllActions({
        collectTargets: () => Array.from(new Set([
            // Child processes can outlive their action's `running` state in
            // edge cases (task finished, spawned process lingering), so union
            // the three sources rather than trusting the state map alone.
            ...collectRunningActionIds(),
            ...activeTasks.keys(),
            ...actionChildProcesses.keys(),
        ])),
        titleOf: (id) => {
            try {
                return findActionById(loadAllActions(context), id)?.title || id;
            } catch {
                // actions.json may have broken mid-run; a raw id is a fine
                // label and must not stop us from killing the process.
                return id;
            }
        },
        confirm: async (titles) => {
            const stopLabel = t('중지', 'Stop');
            const choice = await vscode.window.showWarningMessage(
                formatStopAllConfirmMessage(titles, vscode.env.language.startsWith('ko') ? 'ko' : 'en'),
                { modal: true },
                stopLabel
            );
            return choice === stopLabel;
        },
        stop: stopRunningAction,
        recordStop: (id) => recordManualStopInHistory(historyProvider, id),
        afterStop: () => {
            // `manuallyTerminatedActions` and `actionStates` are deliberately
            // left alone: `finalizeActionRun` clears both when the action's
            // own promise settles, and clearing the flag here would make
            // `executeAction`'s catch mistake a user-requested stop for a
            // genuine failure.
            syncRunningActionsContext();
            mainViewProvider.refresh();
        },
        report: (outcome, stoppedTitles) => {
            if (outcome === 'none') {
                vscode.window.showInformationMessage(t('실행 중인 액션이 없습니다.', 'No actions are running.'));
            } else if (outcome === 'already-finished') {
                // Confirmed the stop, but everything ended on its own in the
                // meantime. Nothing went wrong — say so plainly.
                vscode.window.showInformationMessage(t(
                    '대상 액션이 이미 모두 끝났습니다.',
                    'The actions had already finished.'
                ));
            } else if (outcome === 'failed') {
                vscode.window.showWarningMessage(t(
                    '중지할 활성 태스크를 찾지 못했습니다.',
                    'No active tasks could be stopped.'
                ));
            } else if (outcome === 'stopped' && stoppedTitles.length === 1) {
                vscode.window.showInformationMessage(t(
                    `'${stoppedTitles[0]}' 실행을 중지했습니다.`,
                    `Stopped '${stoppedTitles[0]}'.`
                ));
            } else if (outcome === 'stopped') {
                vscode.window.showInformationMessage(t(
                    `액션 ${stoppedTitles.length}개를 중지했습니다.`,
                    `Stopped ${stoppedTitles.length} actions.`
                ));
            }
            // 'cancelled' stays silent — the user just dismissed a dialog.
        },
    });

    const closeAllTaskHubTerminals = (): number => {
        const terminals = vscode.window.terminals.filter(terminal => terminal.name.startsWith('TaskHub: '));
        terminals.forEach(terminal => terminal.dispose());
        return terminals.length;
    };

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.stopAllActions', () => stopAllRunningActions()));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.closeAllTerminals', () => {
        const closed = closeAllTaskHubTerminals();
        if (closed === 0) {
            vscode.window.showInformationMessage(t('닫을 TaskHub 터미널이 없습니다.', 'No TaskHub terminals to close.'));
            return;
        }
        vscode.window.showInformationMessage(t(
            `TaskHub 터미널 ${closed}개를 닫았습니다.`,
            `Closed ${closed} TaskHub terminal(s).`
        ));
    }));

    // Deprecated compat alias for the pre-0.6.13 combined behaviour (stop
    // everything + close terminals). Kept registered so existing user
    // `keybindings.json` entries keep working; hidden from the palette and
    // the view title bar, where the two split commands took over.
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.terminateAllActions', async () => {
        const outcome = await stopAllRunningActions();
        if (outcome === 'cancelled') {
            // Dismissing the "stop 3 actions?" dialog must not go on to close
            // the terminals the user was reading — cancel means cancel.
            return;
        }
        closeAllTaskHubTerminals();
    }));

    // History commands
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openToolFromHistory', async (itemOrEntry: HistoryItem | HistoryEntry | undefined) => {
        const maybeItem = itemOrEntry as HistoryItem | undefined;
        const entry = typeof maybeItem?.getEntry === 'function'
            ? maybeItem.getEntry()
            : itemOrEntry as HistoryEntry | undefined;
        if (!entry) {
            vscode.window.showErrorMessage(t('유효하지 않은 기록 항목입니다.', 'Invalid history entry.'));
            return;
        }
        await openToolHistoryEntry(context, historyProvider, entry);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.rerunFromHistory', async (entry: HistoryEntry) => {
        if (!entry || !entry.actionId) {
            vscode.window.showErrorMessage(t('유효하지 않은 기록 항목입니다.', 'Invalid history entry.'));
            return;
        }
        if (isToolHistoryEntry(entry)) {
            await openToolHistoryEntry(context, historyProvider, entry);
            return;
        }

        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(t(`액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action: ${error.message}`));
            return;
        }

        const fullActionItem = findActionById(allActions, entry.actionId);
        if (fullActionItem) {
            const pathParts = findActionPathById(allActions, entry.actionId);
            try {
                // 기본 클릭 재실행은 직전에 선택한 입력(예: dir 선택 dialog 결과)을
                // 그대로 재사용한다. presetInputs는 taskId가 일치하는 interactive
                // task에만 적용되므로, 저장된 입력이 없으면 평소처럼 다시 묻는다.
                await executeAction(fullActionItem, context, mainViewProvider, historyProvider, entry.inputs, pathParts);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[ERROR] Execution failed for action '${entry.actionId}': ${msg}`);
            }
        } else {
            vscode.window.showErrorMessage(t(`ID '${entry.actionId}'에 대한 액션 정의를 찾을 수 없습니다.`, `Could not find action definition for ID '${entry.actionId}'.`));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.rerunFromHistoryWithInputs', async (item: HistoryItem) => {
        const entry = item?.getEntry?.();
        if (!entry || !entry.actionId) {
            vscode.window.showErrorMessage(t('유효하지 않은 기록 항목입니다.', 'Invalid history entry.'));
            return;
        }
        if (!entry.inputs || Object.keys(entry.inputs).length === 0) {
            vscode.window.showInformationMessage(t(
                '이 기록 항목에는 저장된 입력값이 없습니다.',
                'No saved inputs are available for this history entry.'
            ));
            return;
        }

        let allActions: ActionItem[];
        try {
            allActions = loadAllActions(context);
        } catch (error: any) {
            outputChannel.appendLine(`[ERROR] ${error.message}`);
            vscode.window.showErrorMessage(t(`액션을 실행할 수 없습니다: ${error.message}`, `Could not execute action: ${error.message}`));
            return;
        }

        const fullActionItem = findActionById(allActions, entry.actionId);
        if (!fullActionItem) {
            vscode.window.showErrorMessage(t(`ID '${entry.actionId}'에 대한 액션 정의를 찾을 수 없습니다.`, `Could not find action definition for ID '${entry.actionId}'.`));
            return;
        }
        const pathParts = findActionPathById(allActions, entry.actionId);
        try {
            await executeAction(fullActionItem, context, mainViewProvider, historyProvider, entry.inputs, pathParts);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`[ERROR] Execution failed for action '${entry.actionId}' (with saved inputs): ${msg}`);
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

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.viewHistoryCommand', async (item: HistoryItem) => {
        const entry = item?.getEntry?.();
        const content = entry ? formatExecutedCommandsDocument(entry) : null;
        if (!content) {
            vscode.window.showInformationMessage(t(
                '이 기록 항목에는 실행한 명령 정보가 없습니다.',
                'No executed command is recorded for this history item.'
            ));
            return;
        }

        const doc = await vscode.workspace.openTextDocument({
            content,
            language: 'shellscript'
        });
        await vscode.window.showTextDocument(doc);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.deleteHistoryItem', async (item: HistoryItem) => {
        const entry = item.getEntry();
        if (!await confirmDeleteHistoryItem(entry.actionTitle)) {
            return;
        }
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
                // Pre-flight: validate existing actions.json *before* the
                // Replace/Merge prompt so a broken file is surfaced once and
                // the same .bak guard covers both branches. Previously the
                // Replace path went straight to write — silently overwriting
                // a broken file with no backup — and the Merge path threw a
                // generic "프리셋 적용 실패" toast from `loadAndValidateActions`.
                // Mirrors the importActions guard so users have a uniform
                // recovery affordance.
                let existingActions: ActionItem[] = [];
                let existingContent: string;
                try {
                    existingContent = fs.readFileSync(actionsPath, 'utf-8');
                } catch (e: any) {
                    vscode.window.showErrorMessage(t(
                        `기존 actions.json을 읽을 수 없어 프리셋 적용을 중단합니다: ${e.message}`,
                        `Apply preset aborted: cannot read existing actions.json: ${e.message}`
                    ));
                    return;
                }
                let existingInvalidReason: string | undefined;
                try {
                    existingActions = loadAndValidateActions(actionsPath, { sourceLabel: 'workspace' });
                } catch (e: any) {
                    existingInvalidReason = e.message;
                }
                if (existingInvalidReason) {
                    const choice = await confirmApplyPresetBackup(actionsPath, existingInvalidReason);
                    if (choice !== 'backup') {
                        return;
                    }
                    const backupPath = `${actionsPath}.bak`;
                    try {
                        fs.writeFileSync(backupPath, existingContent, 'utf-8');
                    } catch (backupErr: any) {
                        vscode.window.showErrorMessage(t(
                            `백업 파일 작성에 실패하여 프리셋 적용을 중단합니다: ${backupErr.message}`,
                            `Apply preset aborted: failed to write backup file: ${backupErr.message}`
                        ));
                        return;
                    }
                    existingActions = [];
                }

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
                    // Merge: check for conflicts. `existingActions` is the
                    // pre-flight result above — re-loading would just throw
                    // again on the same broken file we already backed up.
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
            refreshActionsAndCommands(context, mainViewProvider);
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
            // Whether the chosen save location *already* asked the user to
            // confirm overwrite. The Custom branch uses `showSaveDialog`,
            // which delegates the overwrite prompt to the OS file picker;
            // the Workspace / Extension branches construct `targetPath`
            // deterministically from `presetId` and so need an explicit
            // confirm — without it, picking the same id twice silently
            // overwrote the prior preset.
            let overwriteAlreadyConfirmed = false;

            if (saveLocation.label === workspaceLabel) {
                const presetsDir = path.join(folder.uri.fsPath, '.vscode', 'presets');
                fs.mkdirSync(presetsDir, { recursive: true });
                targetPath = path.join(presetsDir, fileName);
            } else if (saveLocation.label === extensionLabel) {
                const presetsDir = path.join(context.extensionPath, 'presets');
                fs.mkdirSync(presetsDir, { recursive: true });
                targetPath = path.join(presetsDir, fileName);
            } else {
                const fileUri = await showSaveDialogWithMemory(DIALOG_SCOPE.presetSave, fileName, {
                    filters: { 'JSON': ['json'] },
                    defaultDir: folder.uri.fsPath
                });
                if (!fileUri) {
                    return;
                }
                targetPath = fileUri.fsPath;
                overwriteAlreadyConfirmed = true;
            }

            if (!overwriteAlreadyConfirmed && fs.existsSync(targetPath)) {
                const choice = await confirmSavePresetOverwrite(targetPath);
                if (choice === 'open-existing') {
                    const doc = await vscode.workspace.openTextDocument(targetPath);
                    await vscode.window.showTextDocument(doc);
                    return;
                }
                if (choice !== 'overwrite') {
                    return;
                }
            }

            // Step 5: Save
            fs.writeFileSync(targetPath, JSON.stringify(actions, null, 2) + '\n');

            // If the newly-written preset happens to be the currently selected
            // one (or could become so on reload), drop the cached merged action
            // list so downstream callers see the fresh file.
            refreshActionsAndCommands(context, mainViewProvider);

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
            if (event.affectsConfiguration('taskhub.showTaskStatus')) {
                // Status icons are rendered per row from this setting, so the
                // tree has to redraw for the change to take effect at all —
                // otherwise it only applied to rows drawn after the next
                // unrelated refresh.
                mainViewProvider.refresh();
            }
            if (event.affectsConfiguration('taskhub.builtinActions')) {
                // The merged list gains/loses the bundled examples — the
                // cached action tree and the dynamic `taskhub.runAction.<id>`
                // registrations both have to follow.
                refreshActionsAndCommands(context, mainViewProvider);
            }
            if (event.affectsConfiguration('taskhub.preset.selected')) {
                const presetId = getSelectedPresetId();
                refreshActionsAndCommands(context, mainViewProvider);
                outputChannel.appendLine(`[Preset] Settings changed to: ${presetId || 'none'}`);

                if (presetId) {
                    vscode.window.showInformationMessage(t(`프리셋 "${presetId}"이(가) 적용되었습니다. 액션이 다시 로드되었습니다.`, `Preset "${presetId}" applied. Actions reloaded.`));
                } else {
                    vscode.window.showInformationMessage(t('프리셋이 해제되었습니다. 워크스페이스 액션만 사용합니다.', 'Preset cleared. Using workspace actions only.'));
                }
            }
        })
    );
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openJsonEditor', () => openJsonEditor(context, entry => recordJsonEditorHistory(historyProvider, entry))));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openJsonEditorFromUri', (arg?: unknown) => openJsonEditorFromUri(context, arg, entry => recordJsonEditorHistory(historyProvider, entry))));
    // Context-menu surfaces (explorer, editor/title, scm/resourceState) each
    // pass a different first-arg shape; coerceToUri() inside the handlers
    // normalizes them, so we accept `unknown` here.
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openMarkdownPreview', (arg?: unknown) => openMarkdownPreview(arg)));
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.openHtmlInBrowser', (arg?: unknown) => openHtmlInBrowser(arg)));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.exportActions', async () => {
        const folder = await pickWorkspaceFolderForCommand(
            t('내보낼 액션이 있는 워크스페이스 폴더를 선택하세요', 'Select the workspace folder to export actions from')
        );
        if (!folder) { return; }
        const workspaceFolder = folder.uri.fsPath;
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
        const saveUri = await showSaveDialogWithMemory(DIALOG_SCOPE.actionsExport, 'actions.taskhub', {
            filters: { 'TaskHub Export': ['taskhub'], 'JSON': ['json'] },
            defaultDir: workspaceFolder
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
        const workspaceFolder = actionWorkspaceFolderMap.get(treeItem.id)
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        const saveUri = await showSaveDialogWithMemory(DIALOG_SCOPE.actionsExport, defaultName, {
            filters: { 'TaskHub Export': ['taskhub'], 'JSON': ['json'] },
            defaultDir: workspaceFolder
        });
        if (!saveUri) { return; }
        const exportContent = serializeExportData([actionItem]);
        fs.writeFileSync(saveUri.fsPath, exportContent, 'utf-8');
        const itemCount = actionItem.children ? countActionItems(actionItem) : 1;
        vscode.window.showInformationMessage(t(`'${actionItem.title}' (${itemCount}개 항목)을 ${path.basename(saveUri.fsPath)}로 내보냈습니다.`, `Exported '${actionItem.title}' (${itemCount} item(s)) to ${path.basename(saveUri.fsPath)}`));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.importActions', async () => {
        const targetFolder = await pickWorkspaceFolderForCommand(
            t('액션을 가져올 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to import actions into')
        );
        if (!targetFolder) { return; }
        const workspaceFolder = targetFolder.uri.fsPath;
        const fileUri = await showOpenDialogWithMemory(DIALOG_SCOPE.actionsImport, {
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
            let existingContent: string;
            try {
                existingContent = fs.readFileSync(actionsPath, 'utf-8');
            } catch (e: any) {
                vscode.window.showErrorMessage(t(
                    `기존 actions.json을 읽을 수 없어 가져오기를 중단합니다: ${e.message}`,
                    `Import aborted: cannot read existing actions.json: ${e.message}`
                ));
                return;
            }
            // Validate the existing actions.json through the full normal-load
            // pipeline (schema + additional validation such as duplicate task
            // IDs). An array that only parses as JSON but fails TaskHub's
            // schema would otherwise be merged as-is, re-saved, and then break
            // the next load — exactly the "silent data-loss" class the import
            // guard is meant to prevent.
            let existingInvalidReason: string | undefined;
            try {
                existingActions = loadAndValidateActions(actionsPath, { sourceLabel: 'workspace' });
            } catch (e: any) {
                existingInvalidReason = e.message;
            }
            if (existingInvalidReason) {
                const backupPath = `${actionsPath}.bak`;
                const backupLabel = t('손상된 파일 백업 후 계속', 'Back up corrupt file and continue');
                const cancelLabel = t('취소', 'Cancel');
                const choice = await vscode.window.showWarningMessage(
                    t(
                        `기존 actions.json이 유효하지 않아 가져오기를 안전하게 진행할 수 없습니다 (${existingInvalidReason}). 원본을 ${path.basename(backupPath)}로 백업하고 가져온 액션만 저장할까요?`,
                        `The existing actions.json is invalid, so import cannot proceed safely (${existingInvalidReason}). Back up the original to ${path.basename(backupPath)} and save only the imported actions?`
                    ),
                    { modal: true },
                    backupLabel,
                    cancelLabel
                );
                if (choice !== backupLabel) {
                    return;
                }
                try {
                    fs.writeFileSync(backupPath, existingContent, 'utf-8');
                } catch (backupErr: any) {
                    vscode.window.showErrorMessage(t(
                        `백업 파일 작성에 실패하여 가져오기를 중단합니다: ${backupErr.message}`,
                        `Import aborted: failed to write backup file: ${backupErr.message}`
                    ));
                    return;
                }
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
        refreshActionsAndCommands(context, mainViewProvider);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showMemoryMap', async () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        let workspaceFolder: string | undefined;
        if (folders.length === 1) {
            workspaceFolder = folders[0].uri.fsPath;
        } else if (folders.length > 1) {
            const foldersWithConfig = folders.filter(f =>
                fs.existsSync(path.join(f.uri.fsPath, '.vscode', 'taskhub_types.json'))
            );
            if (foldersWithConfig.length === 1) {
                workspaceFolder = foldersWithConfig[0].uri.fsPath;
            } else {
                const picked = await pickWorkspaceFolderForCommand(
                    t('메모리 맵을 볼 워크스페이스 폴더를 선택하세요', 'Select a workspace folder to view the memory map for')
                );
                workspaceFolder = picked?.uri.fsPath;
                if (!workspaceFolder) { return; }
            }
        }
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
        await showMemoryMap(context, memConfig, entry => recordMemoryMapHistory(historyProvider, entry));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.memoryMapGoToSymbol', () => {
        goToSymbol();
    }));

    // 소스 → 맵 점프. 선택 영역이 있으면 그것을, 없으면 커서 아래 낱말을 쓴다
    // (편집기의 Go to Definition 과 같은 규칙이라 따로 배울 것이 없다).
    context.subscriptions.push(vscode.commands.registerCommand('taskhub.revealSymbolInMemoryMap', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(t(
                '열려 있는 편집기가 없습니다. 소스 파일에서 심볼 위에 커서를 두고 다시 실행해 주세요.',
                'No active editor. Put the cursor on a symbol in a source file and run this again.'
            ));
            return;
        }
        const selection = editor.selection;
        // 선택 영역이 식별자 하나일 때만 그것을 쓴다. `HAL_Init(&h);` 이나 파일
        // 전체를 선택한 채 우클릭하는 것은 흔한 몸짓인데, 그 덩어리를 그대로
        // 심볼로 취급하면 "찾지 못했습니다" 안내에 수 KB 문자열이 실린다.
        const selected = selection.isEmpty ? '' : editor.document.getText(selection).trim();
        // `getText(undefined)` 는 **문서 전체**를 준다. 낱말 범위가 없을 때
        // 그대로 넘기면 파일 하나가 통째로 심볼 이름이 되므로 반드시 거른다.
        const wordRange = editor.document.getWordRangeAtPosition(selection.active);
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(selected)
            ? selected
            : (wordRange ? editor.document.getText(wordRange) : '');
        await revealSourceSymbolInMemoryMap(identifier);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('taskhub.showHexViewer', async () => {
        await showHexViewer(context, entry => recordHexViewerHistory(historyProvider, entry));
    }));

    context.subscriptions.push(vscode.window.registerCustomEditorProvider(
        'taskhub.hexEditor',
        new HexEditorProvider(context, entry => recordHexViewerHistory(historyProvider, entry)),
        { supportsMultipleEditorsPerDocument: true }
    ));
}

export function deactivate() {
    for (const run of Array.from(currentActionRuns.values())) {
        run.abandoned = true;
        if (!run.cancellation.token.isCancellationRequested) {
            run.cancellation.cancel();
        }
        endActionCancellation(run);
    }
    currentActionRuns.clear();
    actionCancellations.clear();
    actionStates.clear();
    activeTasks.clear();
    manuallyTerminatedActions.clear();
    actionTerminals.clear();
    actionWorkspaceFolderMap.clear();
    actionChildProcesses.clear();
    actionStartTimestamps.clear();
    // Dispose per-action diagnostic collections so VS Code releases the
    // underlying resources cleanly.
    for (const col of actionDiagnosticCollections.values()) {
        col.dispose();
    }
    actionDiagnosticCollections.clear();
    doctorDiagnosticCollection?.dispose();
    doctorDiagnosticCollection = undefined;
    outputChannel.dispose();
    previewOutputChannel?.dispose();
    previewOutputChannel = undefined;
}
