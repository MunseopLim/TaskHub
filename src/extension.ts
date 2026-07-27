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
    openMemoryMapPanel,
    openMemoryMapFromListing,
} from './memoryMapViewer';
import { showHexViewer, HexEditorProvider, HexViewerOpenHistory, openHexViewerFile } from './hexViewer';
import { t } from './i18n';
import { buildPreviewReport } from './previewRun';
import { runDoctor, DoctorFinding, DoctorInput } from './doctor';
import { createZipArchive, extractZipArchive } from './archiveUtils';
import { DIALOG_SCOPE, coerceDefaultUri, initDialogMemory, showOpenDialogWithMemory, showSaveDialogWithMemory, taskDialogScope } from './dialogMemory';

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
 * `sources` no longer affects the outcome but stays in the signature: the
 * caller has the information, and a future mode may need it again.
 */
export function shouldIncludeBuiltinActions(
    mode: BuiltinActionsMode,
    _sources: { hasWorkspaceActions: boolean; hasPresetActions: boolean }
): boolean {
    return mode === 'always';
}

function getBuiltinActionsMode(): BuiltinActionsMode {
    const raw = vscode.workspace.getConfiguration('taskhub').get<string>('builtinActions', 'auto');
    return raw === 'always' || raw === 'never' ? raw : 'auto';
}

function loadAllActionsUncached(context: vscode.ExtensionContext): ActionItem[] {
    const extensionLabel = 'extension media/actions.json';

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

    // Bundled examples are read only when they will actually be shown: an
    // excluded source must not contribute id-collision errors either (a user
    // action named `defaultButton.showEnv` is their business once the demo
    // buttons are hidden).
    const includeBuiltin = shouldIncludeBuiltinActions(getBuiltinActionsMode(), {
        hasWorkspaceActions: workspaceSources.some(source => source.actions.length > 0),
        hasPresetActions: presetActions.length > 0,
    });
    const mediaJsonPath = path.join(context.extensionPath, 'media', 'actions.json');
    const extensionActions = includeBuiltin
        ? loadAndValidateActions(mediaJsonPath, { sourceLabel: extensionLabel })
        : [];

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
    resolveFavoriteFilePath,
    toWorkspaceRelativePath,
    validateLinkScheme,
    validateLinkUrlForSave,
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
    encodePowerShellScript,
    quotePosixArgument,
    buildPosixCommandLine,
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
    extractVariableHeads,
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
    encodePowerShellScript,
    quotePosixArgument,
    buildPosixCommandLine,
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
    extractVariableHeads,
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
 * Wizard starting points, ordered simplest first.
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
                type: 'shell' as const,
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
                    type: 'shell' as const,
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
                    type: 'shell' as const,
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
                    type: 'shell' as const,
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
                    type: 'shell' as const,
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
                type: 'shell' as const,
                command
            }));
        },
        async promptForTasks() {
            const commands: string[] = [];
            while (commands.length < MAX_PIPELINE_TEMPLATE_STEPS) {
                const step = commands.length + 1;
                // Step 1 is required; from step 2 on, an empty submit ends the
                // chain (Escape still cancels the whole wizard).
                const command = step === 1
                    ? await promptForRequiredInput({
                        prompt: t(`${step}단계 명령어를 입력하세요`, `Enter the command for step ${step}`),
                        placeHolder: 'e.g. make clean'
                    })
                    : await promptForOptionalInput({
                        prompt: t(`${step}단계 명령어 (비워 두면 완료)`, `Command for step ${step} (leave empty to finish)`),
                        placeHolder: t('비워 두고 Enter를 누르면 여기까지 저장합니다', 'Press Enter on an empty box to stop here')
                    });
                if (!command) {
                    break;
                }
                commands.push(command);
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

/**
 * Prompt whose empty submit is a valid "nothing more" answer (returns
 * `undefined`) rather than a validation error. Escape still throws
 * `WizardCancelledError`, so "done" and "cancelled" stay distinguishable —
 * the multi-step template relies on that split to end its chain.
 */
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
        lang === 'ko' ? `위치: ${destinationLabel}` : `Location: ${destinationLabel}`,
        '',
        lang === 'ko' ? `Task ${tasks.length}개` : `${tasks.length} task(s)`,
        ...collapseList(tasks.map(describeTaskLine), WIZARD_REVIEW_LIST_LIMIT, lang),
    ];

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
async function confirmWizardAction(input: {
    action: ActionItem;
    destinationLabel: string;
    prospectiveActions: ActionItem[];
    workspaceActionsPath: string;
    workspaceFolder: string;
    extensionPath: string;
    /** Ids already in use, excluding the pending action itself. */
    existingIds: Set<string>;
}): Promise<boolean> {
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
    let inspected = false;

    // Loop so "Inspect" / "Change id" can act and come back to the same
    // decision instead of silently ending the wizard.
    for (;;) {
        const question = t(
            `'${input.action.title}' 액션을 저장할까요?`,
            `Save the action '${input.action.title}'?`
        );
        const choice = inspected
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
            return true;
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
                if (inspected) {
                    await openReviewDocument();
                }
            }
            continue;
        }
        if (choice !== inspectLabel) {
            return false;
        }

        await openReviewDocument();
        inspected = true;
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

        const existingIds = collectActionIds([...sources.bundledActions, ...sources.workspaceActions]);

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
        const confirmed = await confirmWizardAction({
            action: newAction,
            destinationLabel: destination.label,
            prospectiveActions: sources.workspaceActions,
            workspaceActionsPath: sources.workspaceActionsPath,
            workspaceFolder: targetFolder.uri.fsPath,
            extensionPath: context.extensionPath,
            existingIds,
        });
        if (!confirmed) {
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

// Per-action, per-task tracking. Both maps are keyed by actionId at the
// outer layer and taskId at the inner layer so parallel tasks (roadmap §4)
// can be timed-out / stopped independently without affecting siblings.
// Legacy spawn callers that don't carry a taskId use the empty string '' as
// a sentinel slot — task ids are required non-empty by the schema, so no
// real task collides with it.
const activeTasks = new Map<string, Map<string, vscode.TaskExecution>>();
const manuallyTerminatedActions = new Set<string>();

/**
 * Per-action cancellation, keyed by action id.
 *
 * `activeTasks` and `actionChildProcesses` only cover work that has a process
 * behind it. An action sitting on an `inputBox` / `quickPick` / `fileDialog`
 * prompt has neither, yet it is unambiguously *running* — the tree shows the
 * spinner and offers the inline stop button. Stop then found nothing to
 * terminate and told the user *"활성 태스크를 찾을 수 없습니다"* while the
 * prompt stayed on screen: a stop button that does not stop.
 *
 * The token is handed to `showInputBox` / `showQuickPick`, which VS Code
 * dismisses on cancellation, so those prompts really do close. Native file
 * dialogs take no token and cannot be dismissed programmatically; for them
 * the cancellation is *recorded* and the pipeline aborts as soon as the
 * dialog returns, instead of marching on through the rest of the tasks.
 */
const actionCancellations = new Map<string, vscode.CancellationTokenSource>();

/**
 * Start (or restart) the cancellation scope for an action run. Any source
 * left over from a previous run is disposed so a stale cancelled token can
 * never make a fresh run abort immediately.
 */
function beginActionCancellation(id: string): void {
    actionCancellations.get(id)?.dispose();
    actionCancellations.set(id, new vscode.CancellationTokenSource());
}

function endActionCancellation(id: string): void {
    actionCancellations.get(id)?.dispose();
    actionCancellations.delete(id);
}

/** The running action's token, or `undefined` when it has no live scope. */
function actionCancellationToken(id: string): vscode.CancellationToken | undefined {
    return actionCancellations.get(id)?.token;
}

/**
 * Whether a stop was requested for this action. Checked after every await on
 * something that cannot itself be cancelled (native dialogs), so the run ends
 * at the next safe point rather than continuing to the following task.
 */
export function isActionCancelled(id: string, sources: ReadonlyMap<string, vscode.CancellationTokenSource> = actionCancellations): boolean {
    return sources.get(id)?.token.isCancellationRequested === true;
}

/** Raised when a run ends because the user pressed stop, not because it failed. */
export class ActionStoppedError extends Error {
    constructor() {
        super('Action stopped by user');
        this.name = 'ActionStoppedError';
    }
}

/**
 * Abort the run if a stop was requested. Called after awaiting anything that
 * cannot carry a cancellation token itself — currently the native file/folder
 * dialogs.
 */
function throwIfActionCancelled(id: string): void {
    if (isActionCancelled(id)) {
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

function createReadonlyOutputTerminal(name: string): OutputTerminalHandle {
    const writeEmitter = new vscode.EventEmitter<string>();
    // pty.open()은 createTerminal 직후가 아니라 터미널 UI가 붙은 뒤 비동기로
    // 호출된다. open 이전의 write는 유실되므로 버퍼링했다가 open 시 flush.
    let opened = false;
    let pending = '';
    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
            opened = true;
            if (pending.length > 0) {
                writeEmitter.fire(pending);
                pending = '';
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
        } else {
            pending += normalized;
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

const actionChildProcesses = new Map<string, Map<string, Set<ReturnType<typeof spawn>>>>();

function setActiveTaskExecution(actionId: string, taskId: string, execution: vscode.TaskExecution): void {
    if (!taskId) {
        // Defensive guard: schema enforces non-empty `task.id`, and the only
        // call site already pre-checks `task.id`. An empty taskId here would
        // collide with the legacy '' sentinel used by `actionChildProcesses`
        // for unrelated callers — fail loudly instead of corrupting state.
        throw new Error(`setActiveTaskExecution called with empty taskId for action '${actionId}'.`);
    }
    let perAction = activeTasks.get(actionId);
    if (!perAction) {
        perAction = new Map();
        activeTasks.set(actionId, perAction);
    }
    perAction.set(taskId, execution);
}

function deleteActiveTaskExecution(actionId: string, taskId: string): void {
    const perAction = activeTasks.get(actionId);
    if (!perAction) { return; }
    perAction.delete(taskId);
    if (perAction.size === 0) { activeTasks.delete(actionId); }
}

function getActiveTaskExecution(actionId: string, taskId: string): vscode.TaskExecution | undefined {
    return activeTasks.get(actionId)?.get(taskId);
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
        public readonly exitCode: number | null
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

function terminateChildProcesses(actionId: string, taskId?: string): boolean {
    const perAction = actionChildProcesses.get(actionId);
    if (!perAction || perAction.size === 0) {
        return false;
    }

    const killSet = (set: Set<ReturnType<typeof spawn>>, label: string): boolean => {
        if (set.size === 0) { return false; }
        for (const child of set) {
            try {
                if (!child.killed) { child.kill(); }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`[ERROR] Failed to terminate child process for ${label}: ${msg}`);
            }
        }
        return true;
    };

    if (taskId !== undefined) {
        const set = perAction.get(taskId);
        if (!set) { return false; }
        const killed = killSet(set, `action '${actionId}' task '${taskId}'`);
        perAction.delete(taskId);
        if (perAction.size === 0) { actionChildProcesses.delete(actionId); }
        return killed;
    }

    let terminatedAny = false;
    for (const [tid, set] of perAction) {
        if (killSet(set, `action '${actionId}' task '${tid}'`)) { terminatedAny = true; }
    }
    actionChildProcesses.delete(actionId);
    return terminatedAny;
}
import {
    LinkEntry,
    Link,
    LinkViewProvider,
    loadLinksFromDisk,
    readLinksFromDisk,
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
    // The duplicate-run guard is intentionally independent of `showTaskStatus`,
    // which only controls visual state indicators in the tree. Running the same
    // action concurrently would collide in activeTasks and is always wrong.
    const currentState = actionStates.get(id);
    if (currentState?.state === 'running') {
        vscode.window.showInformationMessage(t(`'${actionItem.title}' 액션이 이미 실행 중입니다.`, `Action '${actionItem.title}' is already running.`));
        return false;
    }

    actionStates.set(id, { state: 'running' });
    // Opened here rather than at the first prompt: the stop button becomes
    // visible the moment the state flips to `running`, so the scope it acts
    // on has to exist from that same moment.
    beginActionCancellation(id);
    syncRunningActionsContext();
    if (showTaskStatus) {
        mainViewProvider.refresh();
    }
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
    const stepResults: Record<string, unknown> = {};
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

    const launchTask = (taskId: string): Promise<InFlightOutcome> => {
        const task = taskById.get(taskId)!;
        scheduler.markStarted(taskId);
        emitTransition(taskId, 'running');

        const usePreset =
            !!presetInputs &&
            INTERACTIVE_TASK_TYPES.has(task.type) &&
            Object.prototype.hasOwnProperty.call(presetInputs, taskId);
        const isInteractive = INTERACTIVE_TASK_TYPES.has(task.type);
        const presetValue = usePreset ? presetInputs![taskId] : undefined;
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
        const startTask = (): Promise<unknown> => executeSingleTask(
            task,
            stepResults,
            context,
            id,
            workspaceFolderPath,
            workspaceRoots,
            presetValue,
            recordCommands
        );
        const underlying: Promise<unknown> = isInteractive
            ? withInteractivePromptLock(startTask)
            : startTask();
        // On timeout, kill only this task's child processes and
        // terminate its streamed vscode Task slot. Sibling tasks
        // running in parallel keep going; the failure policy below
        // decides whether the action as a whole aborts.
        const wrapped = withTaskTimeout(underlying, task.timeoutSeconds, taskId, () => {
            terminateChildProcesses(id, taskId);
            const exec = getActiveTaskExecution(id, taskId);
            if (exec) {
                try { exec.terminate(); } catch { /* ignore */ }
            }
        });

        return wrapped.then(
            (result): InFlightOutcome => ({ taskId, kind: 'success', result }),
            (error): InFlightOutcome => {
                const e = error instanceof Error ? error : new Error(String(error));
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
            if (recordInputs) {
                const t = taskById.get(outcome.taskId);
                if (t && shouldRecordTaskInput(t)) {
                    recordInputs[outcome.taskId] = outcome.result;
                }
            }
            emitTransition(outcome.taskId, 'success');
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
 * That flag has exactly one consumer — `finalizeActionRun`, running in the
 * action's own `finally` — and 0.6.13 shipped a bulk-stop path that deleted
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
    const perAction = activeTasks.get(id);
    if (perAction && perAction.size > 0) {
        manuallyTerminatedActions.add(id);
        for (const exec of perAction.values()) {
            try { exec.terminate(); } catch { /* ignore */ }
        }
        stopped = true;
    }
    if (terminateChildProcesses(id)) {
        manuallyTerminatedActions.add(id);
        stopped = true;
    }
    // An action waiting on a prompt has no task and no child process, so the
    // two branches above find nothing — yet it is running and the user asked
    // it to stop. Cancelling the token dismisses `inputBox` / `quickPick`
    // outright; for a native file dialog it records the request so the run
    // aborts the moment the dialog returns.
    const cancellation = actionCancellations.get(id);
    if (cancellation && !cancellation.token.isCancellationRequested) {
        manuallyTerminatedActions.add(id);
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
    provider.updateHistoryStatus(id, timestamp, 'failure', 'Action stopped by user', durationMs);
}

function finalizeActionRun(id: string, showTaskStatus: boolean, mainViewProvider: MainViewProvider): void {
    activeTasks.delete(id);
    // Owned by the run, so it dies with the run. Leaving a cancelled source
    // behind would make the *next* run of the same action abort on its first
    // token check.
    endActionCancellation(id);
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

    if (!markActionAsRunning(actionItem, id, showTaskStatus, mainViewProvider)) {
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
        await executeActionPipeline(action, context, id, actionWorkspaceFolder, undefined, {
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
                if (!showTaskStatus) {
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
        });
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
        if (!manuallyTerminatedActions.has(id)) {
            handleActionFailure(id, actionItem, action, error, showTaskStatus);

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
        } else {
            // Action was manually stopped
            if (historyProvider) {
                const durationMs = Math.max(0, Date.now() - timestamp);
                historyProvider.updateHistoryStatus(id, timestamp, 'failure', 'Action stopped by user', durationMs);
                historyProvider.setHistoryInputs(id, timestamp, recordInputs);
                historyProvider.setHistoryCommands(id, timestamp, recordCommands);
            }
        }
    } finally {
        finalizeActionRun(id, showTaskStatus, mainViewProvider);
        actionStartTimestamps.delete(id);
    }
}

async function executeSingleTask(
    task: import('./schema').Task,
    allResults: any,
    context: vscode.ExtensionContext,
    actionId: string,
    workspaceFolderPath?: string,
    workspaceRoots?: string[],
    presetResult?: unknown,
    recordCommands?: Record<string, string>
): Promise<any> {
    const defaultWorkspace = workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const interpolationContext = { ...allResults, workspaceFolder: defaultWorkspace, extensionPath: context.extensionPath };
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
    const usingPresetResult = presetResult !== undefined && INTERACTIVE_TASK_TYPES.has(task.type);
    if (usingPresetResult) {
        result = presetResult;
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
            throwIfActionCancelled(actionId);
            break;
        case 'folderDialog':
            result = await handleFolderDialog({ ...task, actionId });
            throwIfActionCancelled(actionId);
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
            result = await handleInputBox(interpolatedTask, actionCancellationToken(actionId));
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
            // Resolve `itemsFromCommand` (string or OS-specific object) to a
            // single interpolated command string, mirroring the shell branch.
            let interpolatedItemsFromCommand: string | undefined;
            if (typeof task.itemsFromCommand === 'string') {
                interpolatedItemsFromCommand = interpolatePipelineVariables(task.itemsFromCommand, interpolationContext);
            } else if (task.itemsFromCommand && typeof task.itemsFromCommand === 'object') {
                const cmdObj = JSON.parse(JSON.stringify(task.itemsFromCommand));
                for (const os in cmdObj) {
                    if (Object.prototype.hasOwnProperty.call(cmdObj, os)) {
                        cmdObj[os] = interpolatePipelineVariables(cmdObj[os], interpolationContext);
                    }
                }
                interpolatedItemsFromCommand = getCommandString(cmdObj);
            }
            const interpolatedQuickPickTask = {
                ...task,
                items: interpolatedItems,
                itemsFromCommand: interpolatedItemsFromCommand,
                cwd: task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined
            };
            result = await handleQuickPick(interpolatedQuickPickTask, defaultWorkspace, actionCancellationToken(actionId));
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
        case 'envPick':
            const interpolatedEnvPickTask = {
                ...task,
                placeHolder: task.placeHolder ? interpolatePipelineVariables(task.placeHolder, interpolationContext) : undefined
            };
            result = await handleEnvPick(interpolatedEnvPickTask);
            break;
        case 'confirm':
            const interpolatedMessage = task.message ? interpolatePipelineVariables(task.message, interpolationContext) : undefined;
            result = await handleConfirm({ ...task, message: interpolatedMessage });
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
                recordCommands[task.id] = buildNativeCommandInvocation(command, args).display;
            }
            const handlerTask = { ...task, command, args, cwd: interpolatedCwd, env, actionId };

            if (task.passTheResultToNextTask) {
                try {
                    result = await handleCommand(handlerTask, context, defaultWorkspace);
                } catch (err) {
                    // Real-world gcc/clang reject with non-zero exit AND
                    // emit diagnostics on stderr. Apply matchers to the
                    // captured output before re-throwing so the user gets
                    // Problems navigation even on a failed build — the
                    // case where they need it most. Without this branch the
                    // post-processing block below is unreachable on failure
                    // (regression caught by IT-079).
                    if (err instanceof ShellCommandError && task.output?.diagnostics) {
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
                    }
                    throw err;
                }
            } else {
                if (task.isOneShot) {
                    executeStreamedTask(handlerTask, defaultWorkspace).catch(error => {
                        const msg = error instanceof Error ? error.message : String(error);
                        outputChannel.appendLine(`[ERROR] One-shot task ${task.id} failed: ${msg}`);
                        vscode.window.showErrorMessage(t(`원샷 태스크 '${task.id}' 시작 실패: ${msg}`, `One-shot task '${task.id}' failed to start: ${msg}`));
                    });
                } else {
                    await executeStreamedTask(handlerTask, defaultWorkspace);
                }
                result = {};
            }
            break;
        default:
            throw new Error(`Unsupported task type: ${task.type}`);
    } }

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
        if (result && typeof result.output === 'string') {
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

export function createShellExecution(command: string, args: string[], options: vscode.ShellExecutionOptions, useUtf8Console: boolean): { shellExecution: vscode.ShellExecution | vscode.ProcessExecution; displayCommand: string; usesNativeExecution?: boolean } {
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

export function wrapCommandForOneShot(command: string, args: string[], cwd: string | undefined, useUtf8Console: boolean, env: NodeJS.ProcessEnv = process.env): { commandLine: string; displayCommand: string; isPowerShellScript: boolean } {
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
        const wrapped = wrapCommandForOneShot(command, taskArgs, options.cwd, useUtf8Console, effectiveEnv);
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
    vsCodeTask.presentationOptions = createGroupedTaskPresentationOptions(
        actionKey,
        revealTerminal,
        { taskId: task.id, isParallel: isParallelActionActive(actionKey) }
    );

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
                if (task.actionId && task.id) {
                    deleteActiveTaskExecution(task.actionId, task.id);
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
            if (task.actionId && task.id && taskExecution) {
                setActiveTaskExecution(task.actionId, task.id, taskExecution);
            }
        } catch (error) {
            disposable.dispose();
            reject(error);
        }
    });
}

async function handleCommand(task: any, context: vscode.ExtensionContext, workspaceFolderPath?: string): Promise<{ output: string; stderr: string }> {
    const { args, cwd } = task;
    const command = getCommandString(task.command);
    const captured = await executeShellCommand(command, args || [], cwd, task.env, workspaceFolderPath, task.actionId, task.id);
    // `output` keeps its historical meaning (= stdout only) so existing
    // `output.capture` rules and `${task.output}` interpolation behave
    // exactly as before. `stderr` is exposed alongside so the diagnostic
    // post-processing block can match warning lines that the toolchain
    // emitted on stderr while still exiting 0 (gcc/clang are common
    // examples — regression caught by IT-081).
    return { output: captured.stdout.trim(), stderr: captured.stderr.trim() };
}

export function parsePathInfo(fullPath: string): { path: string, dir: string, name: string, fileNameOnly: string, fileExt: string } {
    const baseName = path.basename(fullPath);
    const extension = path.extname(baseName);
    return { path: fullPath, dir: path.dirname(fullPath), name: baseName, fileNameOnly: path.basename(baseName, extension), fileExt: extension.startsWith('.') ? extension.substring(1) : extension };
}

async function handleFileDialog(task: any): Promise<{ path: string, dir: string, name: string, fileNameOnly: string, fileExt: string }> {
    // `defaultUri`는 액션 JSON에서 문자열로 오므로 Uri로 승격한다 — 그대로
    // 넘기면 VS Code가 무시해 다이얼로그가 엉뚱한 위치에서 열린다. 명시하지
    // 않았다면 이 태스크가 마지막으로 고른 폴더에서 연다.
    const options: vscode.OpenDialogOptions = { ...(task.options || {}), defaultUri: coerceDefaultUri(task.options?.defaultUri) };
    const fileUri = await showOpenDialogWithMemory(taskDialogScope('file', task), options);
    if (fileUri && fileUri[0]) { return parsePathInfo(fileUri[0].fsPath); }
    else { throw new Error('File selection was canceled.'); }
}

async function handleFolderDialog(task: any): Promise<{ path: string, dir: string, name: string, fileNameOnly: string, fileExt: string }> {
    const options: vscode.OpenDialogOptions = { ...(task.options || {}), defaultUri: coerceDefaultUri(task.options?.defaultUri) };
    options.canSelectFiles = false; options.canSelectFolders = true;
    const folderUri = await showOpenDialogWithMemory(taskDialogScope('folder', task), options);
    if (folderUri && folderUri[0]) { return parsePathInfo(folderUri[0].fsPath); }
    else { throw new Error('Folder selection was canceled.'); }
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
        throw new Error('Input was canceled.');
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
function runCommandCaptureLines(command: string, cwd: string | undefined, timeoutMs = 15000): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
        const args = isWindows ? ['/c', command] : ['-l', '-c', command];

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, args, {
                cwd: cwd && cwd.length > 0 ? cwd : undefined,
                stdio: ['ignore', 'pipe', 'pipe']
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

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            finish(() => reject(new Error(t('명령 실행이 시간 내에 완료되지 않았습니다.', 'Command timed out.'))));
        }, timeoutMs);

        // Cap stdout+stderr *combined*: a failing command can spew unbounded
        // stderr, and at the quickPick stage that would balloon extension-host
        // memory. Kill once either stream pushes the total past the limit.
        const MAX_CAPTURE_BYTES = 1024 * 1024;
        const enforceCaptureLimit = () => {
            if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > MAX_CAPTURE_BYTES) {
                try { child.kill(); } catch { /* ignore */ }
                clearTimeout(timer);
                finish(() => reject(new Error(t('명령 출력이 너무 큽니다.', 'Command output is too large.'))));
            }
        };
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
            enforceCaptureLimit();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
            enforceCaptureLimit();
        });
        child.on('error', (e: Error) => {
            clearTimeout(timer);
            finish(() => reject(e));
        });
        // Resolve on `close`, not `exit`: `exit` can fire before the stdout
        // stream has flushed its final chunk, dropping the last line for large
        // or slow output. `close` fires only after all stdio streams are done.
        child.on('close', (code: number | null) => {
            clearTimeout(timer);
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

async function handleQuickPick(task: any, defaultWorkspace?: string, token?: vscode.CancellationToken): Promise<{ value: string; values?: string }> {
    // When `itemsFromCommand` is set, build the pick list from the command's
    // stdout (one item per non-empty line). The command is already interpolated
    // and reduced to a single OS-specific string by the dispatcher.
    let pickItems: any = task.items;
    if (typeof task.itemsFromCommand === 'string' && task.itemsFromCommand.length > 0) {
        const runCwd = task.cwd || defaultWorkspace || '(none)';
        let lines: string[];
        try {
            lines = await runCommandCaptureLines(task.itemsFromCommand, task.cwd || defaultWorkspace);
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
            throw new Error('Quick pick selection was canceled.');
        }
    } else {
        const selected = await vscode.window.showQuickPick(items, options, token);
        if (selected) {
            return { value: selected.label };
        } else {
            throw new Error('Quick pick selection was canceled.');
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
                env: probeEnv
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
            try { child.kill(); } catch { /* ignore */ }
            finish(null);
        }, 5000);

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
            // 1MB 이상이면 비정상으로 간주하고 중단
            if (stdout.length > 1024 * 1024) {
                try { child.kill(); } catch { /* ignore */ }
                clearTimeout(timer);
                finish(null);
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

async function handleEnvPick(task: any): Promise<{ value: string }> {
    const allNames = Object.keys(process.env);
    const shellNames = await getShellAccessibleEnvNames();

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
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: task.placeHolder || t(
            '환경변수 이름을 선택하세요',
            'Select an environment variable name'
        )
    });

    if (!selected) {
        throw new Error('Environment variable selection was canceled.');
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

    // When `tool` is omitted, use the bundled zip engine. Only .zip archives
    // are supported by the built-in path; anything else requires an explicit
    // tool (e.g. 7z) since adm-zip cannot read those formats.
    if (task.tool === undefined || task.tool === null) {
        if (path.extname(archivePath).toLowerCase() !== '.zip') {
            throw new Error(`Built-in engine only supports .zip archives. For '${path.basename(archivePath)}', specify a 'tool' (e.g. 7z).`);
        }
        try {
            await extractZipArchive(archivePath, outputDir);
            return { outputDir: outputDir };
        } catch (error: any) {
            throw new Error(`Failed to unzip file: ${error.message}`);
        }
    }

    const toolCommand = getToolCommand(task.tool);
    const args = ['x', archivePath, `-o${outputDir}`, '-aoa'];
    try {
        await executeShellCommand(toolCommand, args, undefined, task.env, workspaceFolderPath, actionId, task.id);
        return { outputDir: outputDir };
    } catch (error: any) {
        throw new Error(`Failed to unzip file: ${error.message}`);
    }
}

async function handleZip(task: import('./schema').Task, allResults: any, workspaceFolderPath?: string, actionId?: string): Promise<{ archivePath: string }> {
    const interpolationContext = { ...allResults, workspaceFolder: workspaceFolderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '' };

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

    // When `tool` is omitted, use the bundled zip engine. Only .zip output is
    // supported; other formats still require an external tool.
    if (task.tool === undefined || task.tool === null) {
        if (path.extname(archive).toLowerCase() !== '.zip') {
            throw new Error(`Built-in engine only supports .zip archives. For '${path.basename(archive)}', specify a 'tool' (e.g. 7z).`);
        }
        try {
            await createZipArchive(archive, sourcePaths);
            return { archivePath: archive };
        } catch (error: any) {
            throw new Error(`Failed to zip files for task '${task.id}': ${error.message}`);
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
            task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined,
            envOverrides,
            workspaceFolderPath,
            actionId,
            task.id
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
export function executeShellCommand(command: string, args: string[], cwd?: string, taskEnv?: Record<string, string>, workspaceFolderPath?: string, actionKey?: string, taskKey?: string): Promise<{ stdout: string; stderr: string }> {

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
        let childProcess: ReturnType<typeof spawn>;
        let displayCommand = '';
        let settled = false;

        // taskKey is empty-string for legacy callers that only carry an
        // actionKey (e.g. tests). Real callers from `executeSingleTask`
        // always pass `task.id`, so the per-task bucket gets used and
        // `terminateChildProcesses(actionId, taskId)` can target just
        // this task's children without affecting siblings.
        const effectiveTaskKey = taskKey ?? '';
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
            let set = perAction.get(effectiveTaskKey);
            if (!set) {
                set = new Set<ReturnType<typeof spawn>>();
                perAction.set(effectiveTaskKey, set);
            }
            set.add(childProcess);
        };

        const cleanupChildTracking = (target: ReturnType<typeof spawn>) => {
            if (!actionKey) { return; }
            const perAction = actionChildProcesses.get(actionKey);
            if (!perAction) { return; }
            const set = perAction.get(effectiveTaskKey);
            if (!set) { return; }
            set.delete(target);
            if (set.size === 0) {
                perAction.delete(effectiveTaskKey);
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
            if (captureOverflowed) { return; }
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            if (wouldExceedCaptureLimit(capturedBytes, chunkBytes, captureLimitBytes)) {
                // Mark overflow but do NOT add to manuallyTerminatedActions —
                // this is an action *failure*, not a user-initiated stop. The
                // close handler below converts this into a rejected promise so
                // executeAction() reports it through the normal failure path
                // (history 'failure' with the real error message, not
                // "Action stopped by user").
                captureOverflowed = true;
                try { childProcess.kill(); } catch { /* already exited */ }
                return;
            }
            capturedBytes += chunkBytes;
            if (target === 'stdout') { stdout += chunk; } else { stderr += chunk; }
        };

        const startPowerShellFallback = (reason?: Error) => {
            const invocation = buildPowerShellInvocation(command, args || [], useUtf8Console);
            const encoded = encodePowerShellScript(invocation.script);
            displayCommand = invocation.display;
            if (showVerboseLogs && reason) {
                appendVerboseLine(`[WARN] Native Windows process start failed (${reason.message}); retrying through PowerShell.`);
            }
            childProcess = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
                cwd: workingDirectory,
                env: childEnv
            });
            attachChildHandlers(false);
        };

        const attachChildHandlers = (allowPowerShellFallback: boolean) => {
            const attachedChild = childProcess;
            trackChildProcess();
            if (showVerboseLogs) { appendVerboseLine(`[INFO] Executing command: ${displayCommand} in ${workingDirectory}`); }

            attachedChild.stdout?.setEncoding('utf8');
            attachedChild.stderr?.setEncoding('utf8');

            attachedChild.stdout?.on('data', (data) => { appendCapture('stdout', typeof data === 'string' ? data : String(data)); });
            attachedChild.stderr?.on('data', (data) => { appendCapture('stderr', typeof data === 'string' ? data : String(data)); });

            attachedChild.on('close', (code) => {
                cleanupChildTracking(attachedChild);
                if (attachedChild !== childProcess || settled) {
                    return;
                }

                if (showVerboseLogs) { appendVerboseLine(`[INFO] STDOUT: ${stdout}`); appendVerboseLine(`[INFO] STDERR: ${stderr}`); appendVerboseLine(`[INFO] Command finished with exit code ${code}.`); }

                if (captureOverflowed) {
                    settled = true;
                    const limitMb = Math.round(captureLimitBytes / (1024 * 1024));
                    reject(new Error(t(
                        `캡처된 출력이 ${limitMb}MB 한도를 초과하여 명령을 중단했습니다. \`taskhub.pipeline.outputCaptureLimitMb\` 설정을 높이거나 파이프에 '> file' 리다이렉션을 사용하세요.`,
                        `Captured output exceeded the ${limitMb} MB limit and the command was aborted. Raise \`taskhub.pipeline.outputCaptureLimitMb\` or redirect output with '> file'.`
                    )));
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
                        stderr || `Command failed with exit code ${code}`,
                        stdout,
                        stderr,
                        code
                    ));
                }
            });

            attachedChild.on('error', (err) => {
                cleanupChildTracking(attachedChild);
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
                    startPowerShellFallback(err);
                    return;
                }
                settled = true;
                if (showVerboseLogs) { appendVerboseLine(`[ERROR] Failed to start command: ${err.message}`); }
                reject(err);
            });
        };

        if (process.platform === 'win32' && windowsCommandIsDirectlyLaunchable(command, args || [], { env: childEnv })) {
            const native = buildNativeCommandInvocation(command, args || []);
            displayCommand = native.display;
            childProcess = spawn(native.executable, native.args, {
                cwd: workingDirectory,
                env: childEnv
            });
            attachChildHandlers(true);
        } else if (process.platform === 'win32') {
            startPowerShellFallback();
        } else {
            const commandLine = buildPosixCommandLine(command, args || []);
            displayCommand = commandLine;
            childProcess = spawn(commandLine, [], {
                cwd: workingDirectory,
                env: childEnv,
                shell: true
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
                            const serialized = serializeFavorites(filtered);
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
        const findings = runDoctor(inputs, validator as any);
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

        const serialized = serializeLinks(updatedLinks);
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
            const serialized = serializeFavorites(favorites);
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

        const serialized = serializeFavorites(updatedFavorites);
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
