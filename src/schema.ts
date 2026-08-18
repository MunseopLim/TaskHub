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
/**
 * 태스크를 실행할지 정하는 조건 (`Task.when`).
 *
 * `var` 는 보간을 거친 뒤 **문자열로** 비교된다. 참조가 풀리지 않으면 리터럴이
 * 그대로 남으므로 `equals` 는 거의 항상 거짓이 되고, 그 분기는 꺼진다 — 앞선
 * 태스크가 조건으로 꺼졌을 때 그 뒤 분기까지 자연스럽게 함께 꺼지는 이유다.
 *
 * 연산자는 **정확히 하나**만 쓴다. 여러 개를 쓰면 Doctor 가 잡는다.
 */
export interface TaskCondition {
    /** 비교 대상. 보통 `${pick.value}` 같은 참조. */
    var: string;
    /** 문자열 완전 일치. */
    equals?: string;
    /** 문자열 완전 불일치. */
    notEquals?: string;
    /** 정규식(RegExp source) 부분 일치. 잘못된 패턴은 Doctor 가 잡고 런타임은 거짓으로 본다. */
    matches?: string;
    /** 목록 중 하나와 일치. */
    in?: string[];
}

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
    /**
     * For `inputBox`: a regex (RegExp source) the user input must match.
     * While the input box is open, non-matching text is rejected live and
     * `validateMessage` (or a generic fallback) is shown. An invalid
     * `validatePattern` is ignored (no validation applied). Useful for
     * enforcing formats like a Jira ticket key (`^[A-Z][A-Z0-9]+-\\d+$`).
     */
    validatePattern?: string;
    /**
     * For `inputBox`: the message shown under the input box when the value
     * fails `validatePattern`. Defaults to a generic "invalid format" string.
     */
    validateMessage?: string;
    /**
     * For `inputBox`: a regex (RegExp source) applied to the interpolated
     * `value` to derive the prefilled default. If capture group 1 is present
     * it is used; otherwise the whole match is used. If the pattern does not
     * match (or is invalid), the prefill is left empty so the user types
     * fresh. Useful for extracting a Jira ticket key from a branch name like
     * `feature/ABCTEST-123-foo` (`[A-Z][A-Z0-9]+-\\d+`). `prefix`/`suffix`
     * are still applied to the final user input.
     */
    extractPattern?: string;

    // Properties for 'quickPick'
    items?: string[] | QuickPickItem[];
    canPickMany?: boolean;
    /** 처음 활성화/선택할 항목의 label. 다중 선택이면 label 배열을 쓴다. */
    default?: string | string[];
    /** 단일 선택 QuickPick에서 목록에 없는 문자열도 직접 입력해 값으로 사용할 수 있다. */
    allowCustom?: boolean;
    /** 같은 workspace의 같은 action/task에서 마지막으로 고른 label을 다음 실행에 복원한다. */
    rememberLastSelection?: boolean;
    /**
     * For `quickPick`: a shell command whose stdout becomes the pick list —
     * each non-empty line (trimmed) is one item. Runs in `cwd` (or the
     * action's workspace folder) via the user's login shell. Supports
     * variable interpolation and the same OS-specific object form as
     * `command`. When present, `items` is ignored. Example: populate origin
     * branches with `git for-each-ref --format='%(refname:short)' refs/remotes/origin`.
     */
    itemsFromCommand?: string | {
        windows?: string;
        macos?: string;
        linux?: string;
    };
    /**
     * For `quickPick` with `itemsFromCommand`: exact line(s) to drop from the
     * command output (e.g. `origin/HEAD`). Accepts a single string or an
     * array. Ignored when `itemsFromCommand` is not set.
     */
    itemsExclude?: string | string[];

    /**
     * 이 태스크를 배열 항목마다 순차 실행한다. `${pick.valueList}` / `${files.paths}`
     * 같은 배열 참조 하나 또는 정적 문자열 배열을 쓴다. 반복 안에서는 현재 값을
     * `${each}` / `${each.value}`, 0-based 위치를 `${each.index}`, 1-based 위치를
     * `${each.number}`, 전체 개수를 `${each.count}`로 참조한다.
     */
    forEach?: string | string[];

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
    /**
     * Opt-in required to persist `password`-derived content to disk.
     *
     * `writeFile` / `appendFile` / `output.mode: 'file'` refuse to write a
     * value derived from a `password: true` input unless the task declares
     * this flag. The capability itself is legitimate (generating `.netrc`,
     * `.env`, a signing config), but interpolating `${token.value}` into
     * `content` must not silently grant it — the intent has to be visible in
     * `actions.json` where it can be reviewed. Files written under this flag
     * are created with owner-only permissions (`0600`, no effect on Windows).
     */
    allowSecretContent?: boolean;

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

    /**
     * IDs of earlier tasks (within the same action) that must complete
     * before this task. Combined with `parallel` and auto-inferred
     * dependencies from `${taskId.x}` variable references to build the
     * runtime task graph. TaskHub Doctor flags cycles, missing
     * references, and self-dependencies.
     */
    dependsOn?: string[];

    /**
     * If true, this task is exempt from the implicit "wait for every
     * preceding task in the array" barrier and may run concurrently
     * with its siblings. It still waits for any task listed in
     * `dependsOn` and any task whose output it references via
     * `${taskId.x}` (auto-inferred). Defaults to false.
     *
     * `parallel: true` is *not* fire-and-forget. A later task with
     * `parallel: false` (or omitted) is a sync barrier and still
     * waits for this task to finish — sequential ordering is the
     * default and `parallel` only opts a task out of the implicit
     * "wait for everything before me" rule. For detached execution
     * put the work in a separate action.
     *
     * Interactive task types (`inputBox`, `quickPick`, `envPick`,
     * `confirm`, `fileDialog`, `folderDialog`) are flagged by TaskHub
     * Doctor when set to `parallel: true`; the runtime still
     * executes them but serializes their prompts via a UI mutex so
     * two modal dialogs never race.
     */
    parallel?: boolean;

    /**
     * 이 태스크를 실행할 조건. 거짓이면 태스크는 **실패가 아니라 건너뜀**으로
     * 끝나고, 액션은 계속 진행된다.
     *
     * 조건 안의 `${…}` 참조는 다른 태스크 참조와 똑같이 의존성으로 추론되므로,
     * 조건이 보는 태스크가 먼저 끝난 뒤에 평가된다.
     *
     * **꺼진 분기는 소비자까지 데려간다.** 조건으로 꺼진 태스크를 평범하게
     * 참조하는(`${pickFile.path}`) 태스크도 함께 건너뛴다 — 그러지 않으면
     * 미해결 리터럴 `"${pickFile.path}"` 가 경로 인자로 넘어간다. 어느 쪽 분기가
     * 돌았든 하나의 소비자가 받게 하려면 `??` 를 쓴다
     * (`${pickFile.path ?? pickFolder.path}`) — 그 체인은 **대안이 전부** 꺼졌을
     * 때만 함께 꺼진다.
     */
    when?: TaskCondition;
}

/**
 * Represents a quick pick item with label and optional description.
 */
export interface QuickPickItem {
    label: string;
    description?: string;
    detail?: string;
    /**
     * 이 항목을 골랐을 때 `${taskId.value}` 가 되는 값. 적지 않으면 `label` 이
     * 그대로 값이 되므로 기존 액션의 동작은 바뀌지 않는다.
     *
     * 배열이면 `args` 원소나 `command` 토큰 자리에서 **인자 여러 개**로
     * 펼쳐진다 — `["--option", "b"]` 는 인자 둘, `[]` 는 아무 인자도 만들지
     * 않는다("이 선택지에서는 옵션을 붙이지 않는다").
     */
    value?: string | string[];
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
 *                 If `flags` is provided, it is passed to the RegExp constructor
 *                 after stripping `g` so capture groups remain available.
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
