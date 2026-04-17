/**
 * Defines the structure for an item in the actions.json file.
 * This can be a clickable action, a separator, or a folder containing other items.
 */
export interface ActionItem {
    id: string;
    title: string;
    type?: 'separator' | 'folder';
    action?: Action;
    children?: ActionItem[];
}

/**
 * Represents a runnable action, which consists of a sequence of tasks.
 */
export interface Action {
    description: string;
    tasks: Task[];
    successMessage?: string;
    failMessage?: string;
}

/**
 * Represents a single task, the fundamental unit of execution.
 */
export interface Task {
    id: string;
    type: 'shell' | 'command' | 'fileDialog' | 'folderDialog' | 'unzip' | 'zip' | 'stringManipulation' | 'inputBox' | 'quickPick' | 'confirm';

    // Properties for 'shell' and 'command' types
    command?: string | {
        windows?: string;
        macos?: string;
        linux?: string;
    };
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    revealTerminal?: 'always' | 'silent' | 'never';

    // Properties for 'fileDialog' and 'folderDialog'
    // Corresponds to vscode.OpenDialogOptions - using partial interface for type safety
    options?: {
        canSelectMany?: boolean;
        canSelectFolders?: boolean;
        canSelectFiles?: boolean;
        openLabel?: string;
        defaultUri?: string;
        filters?: Record<string, string[]>;
        title?: string;
    };

    // Properties for 'inputBox'
    prompt?: string;
    value?: string;
    placeHolder?: string;
    password?: boolean;
    prefix?: string;
    suffix?: string;

    // Properties for 'quickPick'
    items?: string[] | QuickPickItem[];
    canPickMany?: boolean;

    // Properties for 'confirm'
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;

    // Properties for 'unzip' and 'zip'
    tool?: string | {
        windows?: string;
        macos?: string;
        linux?: string;
    };
    inputs?: Record<string, string>;

    // Properties for 'zip'
    source?: string | string[];
    archive?: string;

    // Properties for 'unzip'
    destination?: string;

    // Properties for 'stringManipulation'
    function?: string;
    input?: string;

    // Output handling
    output?: Output;

    // Execution behavior
    passTheResultToNextTask?: boolean;
    isOneShot?: boolean;
}

/**
 * Represents a quick pick item with label and optional description.
 */
export interface QuickPickItem {
    label: string;
    description?: string;
    detail?: string;
}

/**
 * Defines how the output of a task should be handled.
 */
export interface Output {
    mode?: 'editor' | 'terminal' | 'file';

    // Properties for 'editor' mode
    language?: string;

    // Properties for 'file' mode
    filePath?: string;
    content?: string;
    /**
     * Whether to overwrite the file if it already exists.
     * Can be a boolean or a string (e.g., "${someVar}") that will be interpolated.
     * String values are evaluated as "true" (case-insensitive) to enable overwrite.
     */
    overwrite?: boolean | string;

    /**
     * Optional rule(s) to extract named variables from the task's string output.
     * Each rule must specify a `name` (which becomes `${task_id.<name>}` for
     * downstream tasks). Rules are applied independently and never overwrite
     * the original `output` string — they only add new keys to the task result.
     * Only applies to task types that return a string output (shell, command,
     * stringManipulation) and requires `passTheResultToNextTask: true` for
     * shell/command tasks.
     */
    capture?: OutputCapture | OutputCapture[];
}

/**
 * A single capture rule that derives a named variable from a task's string output.
 *
 * Selector precedence (first matching wins):
 *   1. `regex`  — match against the output and take capture `group` (default 1).
 *                 If `flags` is provided, it is passed to the RegExp constructor.
 *   2. `line`   — select one line by 0-based index. Negative values count from
 *                 the end (`-1` = last line).
 *   3. neither  — use the full output as-is.
 *
 * Post-processing:
 *   - `trim: true` applies `.trim()` to the selected value.
 *
 * If the selector does not match (e.g. regex miss, line index out of range),
 * the capture is silently skipped and no variable is added.
 */
export interface OutputCapture {
    name: string;
    regex?: string;
    group?: number;
    flags?: string;
    line?: number;
    trim?: boolean;
}
