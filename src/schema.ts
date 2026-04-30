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
    type: 'shell' | 'command' | 'fileDialog' | 'folderDialog' | 'unzip' | 'zip' | 'stringManipulation' | 'inputBox' | 'quickPick' | 'envPick' | 'confirm' | 'writeFile' | 'appendFile';

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

    // Properties for 'writeFile' and 'appendFile'
    /**
     * Destination file path for `writeFile` / `appendFile`. Supports variable
     * interpolation. Relative paths resolve against the action's workspace
     * folder. Paths outside the workspace are rejected.
     */
    path?: string;
    /**
     * Content to write for `writeFile` / `appendFile`. Supports variable
     * interpolation. May be empty (""), but must be a string.
     */
    content?: string;
    /**
     * File encoding for `writeFile` / `appendFile`. Defaults to `utf8`.
     *  - `utf8`: UTF-8 without BOM.
     *  - `utf8bom`: UTF-8 with leading BOM (on `appendFile` the BOM is only
     *    added when the target file does not already exist).
     *  - `ascii`: 7-bit ASCII; non-ASCII characters are replaced by `?`.
     */
    encoding?: 'utf8' | 'utf8bom' | 'ascii';
    /**
     * Line-ending normalization for `writeFile` / `appendFile`. Defaults to
     * `keep` (pass content through unchanged).
     */
    eol?: 'lf' | 'crlf' | 'keep';
    /**
     * For `writeFile`: if false, the task fails when the target file already
     * exists. Defaults to true. Ignored for `appendFile`.
     */
    overwrite?: boolean;
    /**
     * For `writeFile` / `appendFile`: if true (default), missing parent
     * directories are created automatically. If false, the task fails when
     * the parent directory does not exist.
     */
    mkdirs?: boolean;

    // Output handling
    output?: Output;

    // Execution behavior
    passTheResultToNextTask?: boolean;
    isOneShot?: boolean;

    /**
     * Task-level timeout in seconds. If the task does not complete within
     * `timeoutSeconds`, it is canceled and the pipeline fails with a timeout
     * error (subject to `continueOnError`). Running shell processes for the
     * action are terminated on a best-effort basis. A value of 0 or omitted
     * means no timeout. Applies to every task type, including interactive
     * ones (dialog, inputBox, quickPick, confirm, envPick).
     */
    timeoutSeconds?: number;
    /**
     * If true, the pipeline continues to the next task when this task fails
     * (including timeouts and user-canceled dialogs). The failing task's
     * result becomes `{}`, so downstream `${task.output}`-style references
     * to the skipped task remain unresolved literals. Defaults to false.
     */
    continueOnError?: boolean;
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

    /**
     * Optional matcher(s) that scan the task's string output for compiler
     * errors / warnings and surface them in the VS Code Problems panel.
     * Each entry can be either an inline `DiagnosticPattern` object or a
     * preset shorthand string (e.g. `"$gcc"`, `"$tsc"`). Only applies to
     * task types that return a string output (shell, command,
     * stringManipulation) and requires `passTheResultToNextTask: true`
     * for shell/command tasks — same constraint as `capture`. Diagnostics
     * are scoped to the action: a re-run clears the action's previous
     * diagnostics before emitting new ones.
     */
    diagnostics?: DiagnosticConfig;
}

/**
 * One matcher rule that converts shell output lines into VS Code diagnostics.
 * The `pattern` is a regex applied per output line (with the `g` flag implicitly
 * removed — we iterate lines ourselves). Numeric fields are 1-based capture
 * group indices that select which group provides the file path / line number /
 * etc.
 *
 * Severity handling: when `severity` is set, the matched group's text is
 * normalized via `normalizeSeverity` (case-insensitive, supports `error` /
 * `warning` / `info` / `hint` / `note` / `fatal`). Unrecognized text falls
 * back to `defaultSeverity` (or `error` if absent).
 */
export interface DiagnosticPattern {
    /** Regex pattern matched against each output line. */
    pattern: string;
    /** Optional regex flags (e.g. `"i"` for case-insensitive, `"m"` for multiline). The `g` flag is silently stripped — the engine iterates output lines on its own and `g` would interfere with `String.prototype.match` group capture. */
    flags?: string;
    /** 1-based capture group index for the file path. Required. */
    file: number;
    /** 1-based capture group index for the (1-based) line number. Required. */
    line: number;
    /** 1-based capture group index for the column number. Optional. */
    column?: number;
    /** 1-based capture group index for the end-line number. Optional. */
    endLine?: number;
    /** 1-based capture group index for the end-column number. Optional. */
    endColumn?: number;
    /** 1-based capture group index for the severity text. Optional. */
    severity?: number;
    /** 1-based capture group index for the message text. Required. */
    message: number;
    /** Severity to use when `severity` group is missing or unrecognized. Defaults to `error`. */
    defaultSeverity?: 'error' | 'warning' | 'info' | 'hint';
    /** Label shown next to the message in Problems panel. Defaults to `taskhub`. */
    source?: string;
}

/**
 * `output.diagnostics` accepts a single matcher, an array of matchers, a
 * preset shorthand string (e.g. `"$gcc"`), or an array mixing inline
 * matchers and preset strings.
 */
export type DiagnosticConfig =
    | DiagnosticPattern
    | string
    | Array<DiagnosticPattern | string>;

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
