import * as fs from 'fs';
import * as path from 'path';
import type { ActionItem } from './schema';
import { stripUtf8Bom } from './jsonEditorUtils';

export const taskHubRoot = path.resolve(__dirname, '..');

/** 빌드 때 생성한 검증기를 재사용한다. 활성화 중 Ajv 컴파일을 하지 않는다. */
export function getActionsValidator(): import('ajv').ValidateFunction<ActionItem[]> {
    return require(path.join(taskHubRoot, 'dist', 'actionsValidator.js'));
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

export function parseAndValidateActionsContent(
    fileContent: string,
    filePath: string,
    options?: { sourceLabel?: string }
): ActionItem[] {
    const validate = getActionsValidator();
    let parsedJson: any;
    try { parsedJson = JSON.parse(stripUtf8Bom(fileContent)); } catch (e: any) { throw actionsLoadError(filePath, `Error parsing JSON in ${path.basename(filePath)}: ${e.message}`); }
    if (validate(parsedJson)) { const sourceLabel = options?.sourceLabel ?? filePath; performAdditionalActionValidation(parsedJson, { sourceLabel, filePath }); return parsedJson; } else { const errors = validate.errors?.map(error => `  - path: '${error.instancePath}' - message: ${error.message}`).join('\n'); throw actionsLoadError(filePath, `Validation failed for ${path.basename(filePath)}:\n${errors}`); }
}

export function loadAndValidateActions(filePath: string, options?: { sourceLabel?: string }): ActionItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    let fileContent: string;
    try { fileContent = fs.readFileSync(filePath, 'utf-8'); } catch (e: any) { throw actionsLoadError(filePath, `Error reading file ${filePath}: ${e.message}`); }
    return parseAndValidateActionsContent(fileContent, filePath, options);
}

interface ActionValidationContext {
    sourceLabel: string;
    filePath: string;
}

export function formatActionPath(parts: string[]): string {
    return parts.length > 0 ? parts.join(' > ') : '(root)';
}

export function performAdditionalActionValidation(actions: ActionItem[], context: ActionValidationContext): void {
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

export function traverseActionItems(items: ActionItem[], visitor: (item: ActionItem, pathParts: string[]) => void, breadcrumbs: string[] = []): void {
    for (const item of items) {
        const label = item.title || item.id || '(unnamed)';
        const currentParts = [...breadcrumbs, label];
        visitor(item, currentParts);
        if (item.children && item.children.length > 0) {
            traverseActionItems(item.children, visitor, currentParts);
        }
    }
}

export function mergeActions(
    existing: ActionItem[],
    preset: ActionItem[],
    strategy: 'keep-existing' | 'use-preset'
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
