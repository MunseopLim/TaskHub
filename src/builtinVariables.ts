import * as path from 'path';

/**
 * TaskHub가 `${...}` 안에서 직접 제공하는 값들.
 *
 * 이 목록은 런타임 예약 이름, Preview/Doctor 모형, 자동완성이 함께 쓴다.
 * 새 이름을 더할 때 어느 한 표면만 갱신되어 "실행은 되는데 제안되지 않음" 또는
 * "Preview에서는 되는데 실행은 안 됨" 상태가 생기지 않게 단일 출처로 둔다.
 */
export const BUILTIN_VARIABLE_NAMES = [
    'workspaceFolder',
    'extensionPath',
    'file',
    'relativeFile',
    'relativeFileDirname',
    'fileBasename',
    'fileBasenameNoExtension',
    'fileExtname',
    'fileDirname',
    'fileWorkspaceFolder',
    'selectedText',
    'lineNumber',
    'columnNumber',
    'clipboard',
] as const;

export type BuiltinVariableName = typeof BUILTIN_VARIABLE_NAMES[number];

/** 활성 에디터에서 한 번 읽어 둔 값. line/column은 사용자에게 보이는 1-based 값이다. */
export interface ActiveEditorVariableSnapshot {
    file?: string;
    fileWorkspaceFolder?: string;
    selectedText?: string;
    lineNumber?: number;
    columnNumber?: number;
}

export interface BuiltinVariableContextOptions {
    workspaceFolder: string;
    extensionPath: string;
    editor?: ActiveEditorVariableSnapshot;
    /** 읽기에 실패했으면 생략한다. 빈 클립보드는 정상 값 `""`이다. */
    clipboard?: string;
    environment?: NodeJS.ProcessEnv;
    /** 런타임에서만 true. 없는 현재 파일/환경변수를 리터럴로 넘기지 않고 실패시킨다. */
    strict?: boolean;
}

export interface EnvironmentVariableSnapshot {
    readonly values: Readonly<Record<string, string>>;
    readonly caseInsensitive: boolean;
}

/**
 * 일반 문자열 키를 쓰면 같은 이름의 task id가 내부 상태를 덮을 수 있다.
 * 심볼은 사용자가 JSON에서 만들 수 없고 Object.assign/spread에도 보존된다.
 */
export const PIPELINE_ENVIRONMENT = Symbol('taskhub.pipeline.environment');
export const PIPELINE_STRICT_BUILTINS = Symbol('taskhub.pipeline.strictBuiltins');
export const PIPELINE_BUILTIN_VALUES = Symbol('taskhub.pipeline.builtinValues');
export const PIPELINE_TASK_IDS = Symbol('taskhub.pipeline.taskIds');

export type BuiltinVariableContext = Record<string, unknown> & {
    [PIPELINE_ENVIRONMENT]: EnvironmentVariableSnapshot;
    [PIPELINE_STRICT_BUILTINS]: boolean;
    [PIPELINE_BUILTIN_VALUES]: Readonly<Record<BuiltinVariableName, unknown>>;
    [PIPELINE_TASK_IDS]?: ReadonlySet<string>;
};

/** 동명 task가 bare 내장보다 우선하도록 action 전체 id 집합을 문맥에 붙인다. */
export function attachPipelineTaskIds<T extends Record<string, unknown>>(
    context: T,
    taskIds: Iterable<string>
): T {
    (context as BuiltinVariableContext)[PIPELINE_TASK_IDS] = new Set(taskIds);
    return context;
}

export function contextDeclaresTaskId(context: unknown, taskId: string): boolean {
    return !!context
        && typeof context === 'object'
        && (context as BuiltinVariableContext)[PIPELINE_TASK_IDS]?.has(taskId) === true;
}

function snapshotEnvironment(
    environment: NodeJS.ProcessEnv,
    caseInsensitive = process.platform === 'win32'
): EnvironmentVariableSnapshot {
    const values: Record<string, string> = Object.create(null);
    for (const [rawName, value] of Object.entries(environment)) {
        if (typeof value !== 'string') { continue; }
        values[caseInsensitive ? rawName.toLocaleLowerCase('en-US') : rawName] = value;
    }
    return { values, caseInsensitive };
}

/**
 * 한 실행에서 계속 재사용할 내장 변수 문맥을 만든다.
 *
 * 모든 예약 키를 own property로 먼저 만들어 둔다. 동시에 같은 값을 심볼 아래에도
 * 보관한다. 합쳐진 실행 문맥에서는 동명 task 결과가 문자열 키를 덮을 수 있어야
 * `${file.path}`와 bare `${file}` 같은 기존 task 참조가 유지된다. 내장값은 동명
 * task가 없을 때만 해석하되, 민감정보 가림처럼 실제 내장 스냅샷이 필요한 코드는
 * 심볼 아래 값을 읽는다.
 */
export function buildBuiltinVariableContext(options: BuiltinVariableContextOptions): BuiltinVariableContext {
    const result: Record<string | symbol, unknown> = Object.create(null);
    for (const name of BUILTIN_VARIABLE_NAMES) {
        result[name] = undefined;
    }

    result.workspaceFolder = options.workspaceFolder;
    result.extensionPath = options.extensionPath;

    const editor = options.editor;
    if (editor?.file) {
        const file = path.resolve(editor.file);
        const extname = path.extname(file);

        result.file = file;
        result.fileBasename = path.basename(file);
        result.fileBasenameNoExtension = path.basename(file, extname);
        result.fileExtname = extname;
        result.fileDirname = path.dirname(file);
        // 워크스페이스 밖의 활성 파일에 액션 워크스페이스를 억지로 붙이지 않는다.
        // 그러면 `relativeFile`이 `../outside/...`가 되고 `fileWorkspaceFolder`는
        // 실제로 그 파일을 포함하지 않는 폴더를 가리킨다. VS Code가 소속 폴더를
        // 알려 준 경우에만 workspace-relative 계열을 만든다.
        if (editor.fileWorkspaceFolder) {
            const fileWorkspaceFolder = path.resolve(editor.fileWorkspaceFolder);
            const relativeFile = path.relative(fileWorkspaceFolder, file);
            result.relativeFile = relativeFile;
            result.relativeFileDirname = path.dirname(relativeFile);
            result.fileWorkspaceFolder = fileWorkspaceFolder;
        }
    }
    if (editor?.selectedText !== undefined) { result.selectedText = editor.selectedText; }
    if (editor?.lineNumber !== undefined) { result.lineNumber = editor.lineNumber; }
    if (editor?.columnNumber !== undefined) { result.columnNumber = editor.columnNumber; }
    if (options.clipboard !== undefined) { result.clipboard = options.clipboard; }

    const builtinValues: Record<string, unknown> = Object.create(null);
    for (const name of BUILTIN_VARIABLE_NAMES) { builtinValues[name] = result[name]; }
    result[PIPELINE_BUILTIN_VALUES] = builtinValues;
    result[PIPELINE_ENVIRONMENT] = snapshotEnvironment(options.environment ?? process.env);
    result[PIPELINE_STRICT_BUILTINS] = options.strict === true;
    return result as BuiltinVariableContext;
}

export function lookupBuiltinVariable(context: unknown, name: BuiltinVariableName): unknown {
    if (!context || typeof context !== 'object') { return undefined; }
    return (context as BuiltinVariableContext)[PIPELINE_BUILTIN_VALUES]?.[name];
}

export function hasBuiltinVariableSnapshot(context: unknown): boolean {
    return !!context
        && typeof context === 'object'
        && !!(context as BuiltinVariableContext)[PIPELINE_BUILTIN_VALUES];
}

export function lookupEnvironmentVariable(context: unknown, name: string): string | undefined {
    if (!context || typeof context !== 'object') { return undefined; }
    const snapshot = (context as BuiltinVariableContext)[PIPELINE_ENVIRONMENT];
    if (!snapshot) { return undefined; }
    const key = snapshot.caseInsensitive ? name.toLocaleLowerCase('en-US') : name;
    return Object.prototype.hasOwnProperty.call(snapshot.values, key) ? snapshot.values[key] : undefined;
}

export function hasEnvironmentSnapshot(context: unknown): boolean {
    return !!context
        && typeof context === 'object'
        && !!(context as BuiltinVariableContext)[PIPELINE_ENVIRONMENT];
}

export function usesStrictBuiltinVariables(context: unknown): boolean {
    return !!context
        && typeof context === 'object'
        && (context as BuiltinVariableContext)[PIPELINE_STRICT_BUILTINS] === true;
}

/** `${env:NAME}` 또는 `${clipboard}`가 기록 표면에 원문으로 남지 않게 만든 사본. */
export function redactSensitiveBuiltinVariables<T extends Record<string, any>>(
    context: T,
    placeholder: string
): T {
    const builtinValues = (context as BuiltinVariableContext)[PIPELINE_BUILTIN_VALUES];
    const selectedText = builtinValues?.selectedText;
    const clipboard = builtinValues?.clipboard;
    // 합쳐진 문맥의 문자열 키는 동명 task 결과일 수 있다. 그 객체를 비밀값으로
    // 오인해 덮지 않고, 실제 내장값과 같은 경우에만 최상위 키도 가린다.
    const topLevelSelectedTextIsBuiltin = Object.prototype.hasOwnProperty.call(context, 'selectedText')
        && context.selectedText === selectedText;
    const topLevelClipboardIsBuiltin = Object.prototype.hasOwnProperty.call(context, 'clipboard')
        && context.clipboard === clipboard;
    const environment = (context as BuiltinVariableContext)[PIPELINE_ENVIRONMENT];
    if (selectedText === undefined && clipboard === undefined && !environment) { return context; }

    const redacted: Record<string | symbol, unknown> = { ...context };
    if (builtinValues) {
        redacted[PIPELINE_BUILTIN_VALUES] = {
            ...builtinValues,
            ...(selectedText !== undefined ? { selectedText: placeholder } : {}),
            ...(clipboard !== undefined ? { clipboard: placeholder } : {}),
        };
    }
    if (topLevelSelectedTextIsBuiltin && selectedText !== undefined) { redacted.selectedText = placeholder; }
    if (topLevelClipboardIsBuiltin && clipboard !== undefined) { redacted.clipboard = placeholder; }
    if (environment) {
        const values: Record<string, string> = Object.create(null);
        for (const key of Object.keys(environment.values)) { values[key] = placeholder; }
        redacted[PIPELINE_ENVIRONMENT] = { ...environment, values };
    }
    return redacted as T;
}
