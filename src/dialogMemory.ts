import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 파일/폴더 다이얼로그의 "마지막으로 사용한 위치"를 기억하는 모듈.
 *
 * VS Code 는 `defaultUri` 를 주지 않은 다이얼로그를 자신의 전역 최근 경로에서
 * 여는데, 그 값은 창(workspace)과 확장 프로그램을 가리지 않고 공유되므로
 * TaskHub 의 Hex 열기가 방금 다른 프로젝트에서 편집하던 파일 폴더에서 열리는
 * 식의 부자연스러운 동작이 나온다. 여기서는 다이얼로그의 *용도*(scope)별로
 * 마지막 위치를 따로 저장해 다음 순서로 시작 위치를 정한다.
 *
 *   1. 호출자(또는 액션 JSON)가 명시한 `defaultUri` — 실제로 존재할 때만
 *   2. 같은 scope 로 마지막에 선택했던 디렉터리 (workspace → global 순)
 *   3. 활성 에디터가 속한 워크스페이스 폴더, 없으면 첫 워크스페이스 폴더
 *   4. 위 후보가 모두 없으면 `defaultUri` 없이 (= VS Code 기본 동작)
 *
 * 저장은 `workspaceState` 와 `globalState` 양쪽에 한다. 프로젝트별로 다른
 * 위치를 기억하되(workspaceState 우선), 그 프로젝트에서 처음 여는 다이얼로그는
 * 다른 창에서 쓰던 같은 용도의 위치를 물려받도록(globalState) 하기 위함이다.
 */

const STATE_PREFIX = 'dialogLocation:';

/** 다이얼로그 용도 식별자. 같은 값을 쓰는 다이얼로그끼리만 위치를 공유한다. */
export const DIALOG_SCOPE = {
    hexViewer: 'hexViewer',
    jsonEditor: 'jsonEditor',
    memoryMapBinary: 'memoryMap.binary',
    memoryMapListing: 'memoryMap.listing',
    memoryMapLinkerScript: 'memoryMap.linkerScript',
    memoryMapExport: 'memoryMap.export',
    favoriteFile: 'favoriteFile',
    actionsExport: 'actions.export',
    actionsImport: 'actions.import',
    presetSave: 'preset.save',
} as const;

/**
 * `fileDialog` / `folderDialog` 태스크용 scope. 한 액션 안에서도 태스크마다
 * 고르는 대상이 다르므로(펌웨어 파일 vs 출력 폴더) 태스크 단위로 분리한다.
 */
export function taskDialogScope(kind: 'file' | 'folder', task: { id?: unknown, actionId?: unknown }): string {
    const actionId = typeof task.actionId === 'string' ? task.actionId : '';
    const taskId = typeof task.id === 'string' ? task.id : '';
    return `task.${kind}Dialog:${actionId}/${taskId}`;
}

let memoryContext: vscode.ExtensionContext | undefined;

/**
 * 활성화 시점에 저장소로 쓸 컨텍스트를 등록한다. 이전 컨텍스트를 돌려주므로
 * 테스트가 교체 후 복원할 수 있다.
 */
export function initDialogMemory(context: vscode.ExtensionContext | undefined): vscode.ExtensionContext | undefined {
    const previous = memoryContext;
    memoryContext = context;
    return previous;
}

function isMemoryEnabled(): boolean {
    return vscode.workspace.getConfiguration('taskhub').get<boolean>('dialog.rememberLastLocation', true) !== false;
}

/** 주입 가능한 의존성 — 단위 테스트가 실제 다이얼로그/디스크 없이 검증하기 위한 seam. */
export interface DialogMemoryDeps {
    showOpenDialog(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
    showSaveDialog(options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
    /** 경로가 실제 디렉터리인지 — 삭제된 옛 위치를 되살리지 않기 위해 매번 확인한다. */
    isDirectory(dirPath: string): boolean;
    /** 경로가 파일이든 디렉터리든 존재하는지 (호출자 `defaultUri` 검증용). */
    exists(targetPath: string): boolean;
    recall(scope: string): string | undefined;
    remember(scope: string, dir: string): void;
    workspaceFallbackDir(): string | undefined;
    /**
     * `taskhub.dialog.rememberLastLocation`.
     *
     * 이전에는 이 설정이 `recall`/`remember` 안쪽에서만 확인돼, 꺼도
     * `workspaceFallbackDir()`는 그대로 적용됐다. 즉 TaskHub가 여전히
     * `defaultUri`를 지정하고 있어서 "VS Code 자체의 최근 경로를 쓴다"는
     * 설명과 실제 동작이 달랐다. 시작 위치 결정 전체를 이 값으로 가른다.
     */
    isEnabled(): boolean;
}

function defaultRecall(scope: string): string | undefined {
    if (!memoryContext || !isMemoryEnabled()) { return undefined; }
    const key = STATE_PREFIX + scope;
    return memoryContext.workspaceState.get<string>(key)
        ?? memoryContext.globalState.get<string>(key);
}

function defaultRemember(scope: string, dir: string): void {
    if (!memoryContext || !isMemoryEnabled()) { return; }
    const key = STATE_PREFIX + scope;
    // 저장 실패(예: 저장소 손상)로 다이얼로그 흐름이 깨지지 않도록 삼킨다.
    void Promise.resolve(memoryContext.workspaceState.update(key, dir)).then(undefined, () => undefined);
    void Promise.resolve(memoryContext.globalState.update(key, dir)).then(undefined, () => undefined);
}

function defaultWorkspaceFallbackDir(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    return (activeFolder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

export function defaultDialogMemoryDeps(): DialogMemoryDeps {
    return {
        showOpenDialog: (options) => vscode.window.showOpenDialog(options),
        showSaveDialog: (options) => vscode.window.showSaveDialog(options),
        isDirectory: (dirPath) => {
            try {
                return fs.statSync(dirPath).isDirectory();
            } catch {
                return false;
            }
        },
        exists: (targetPath) => {
            try {
                fs.statSync(targetPath);
                return true;
            } catch {
                return false;
            }
        },
        recall: defaultRecall,
        remember: defaultRemember,
        workspaceFallbackDir: defaultWorkspaceFallbackDir,
        isEnabled: isMemoryEnabled,
    };
}

/**
 * 액션 JSON 의 `options.defaultUri` 는 문자열로 오지만 VS Code API 는 `Uri` 를
 * 요구한다. 문자열이면 파일 경로로 해석해 `Uri` 로 승격하고, 그 외 형태는
 * 무시한다 (잘못된 값 하나로 다이얼로그 자체가 실패하지 않도록).
 */
export function coerceDefaultUri(value: unknown): vscode.Uri | undefined {
    if (!value) { return undefined; }
    if (value instanceof vscode.Uri) { return value; }
    if (typeof value === 'string') {
        try {
            return value.includes('://') ? vscode.Uri.parse(value, true) : vscode.Uri.file(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function firstUsableDir(candidates: Array<string | undefined>, deps: DialogMemoryDeps): string | undefined {
    for (const candidate of candidates) {
        if (candidate && path.isAbsolute(candidate) && deps.isDirectory(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * 선택 결과로부터 "다음 번에 열 디렉터리"를 만든다. 폴더 선택 다이얼로그는
 * 고른 폴더 자체를(같은 출력 폴더를 반복해 고르는 경우가 많다), 파일 선택은
 * 그 파일이 있던 폴더를 기억한다.
 */
export function directoryToRemember(picked: vscode.Uri, isFolderPick: boolean): string | undefined {
    if (picked.scheme !== 'file') { return undefined; }
    return isFolderPick ? picked.fsPath : path.dirname(picked.fsPath);
}

/**
 * `vscode.window.showOpenDialog` 래퍼. `scope` 의 마지막 위치에서 열고,
 * 선택이 이뤄지면 그 위치를 다시 저장한다.
 */
export async function showOpenDialogWithMemory(
    scope: string,
    options: vscode.OpenDialogOptions = {},
    deps: DialogMemoryDeps = defaultDialogMemoryDeps()
): Promise<vscode.Uri[] | undefined> {
    const effective: vscode.OpenDialogOptions = { ...options };
    const caller = coerceDefaultUri(options.defaultUri);
    // 호출자가 명시한 위치가 실제로 존재하면 그대로 존중한다 — 액션 작성자가
    // 의도한 시작 위치를 기억된 값이 덮어쓰지 않도록. 설정을 꺼도 이건 남는다:
    // 액션 JSON의 `defaultUri`는 TaskHub의 추측이 아니라 작성자의 지시다.
    if (caller && caller.scheme === 'file' && deps.exists(caller.fsPath)) {
        effective.defaultUri = caller;
    } else if (!deps.isEnabled()) {
        // 설정이 꺼졌으면 TaskHub는 시작 위치를 일절 지정하지 않는다. 그래야
        // VS Code 자체의 최근 경로가 쓰인다 — 설정 설명이 약속하는 동작이다.
        delete effective.defaultUri;
    } else {
        const startDir = firstUsableDir([deps.recall(scope), deps.workspaceFallbackDir()], deps);
        if (startDir) {
            effective.defaultUri = vscode.Uri.file(startDir);
        } else {
            delete effective.defaultUri;
        }
    }

    const picked = await deps.showOpenDialog(effective);
    if (picked && picked.length > 0) {
        const isFolderPick = effective.canSelectFolders === true && effective.canSelectFiles !== true;
        const dir = directoryToRemember(picked[0], isFolderPick);
        if (dir) { deps.remember(scope, dir); }
    }
    return picked;
}

export interface SaveDialogWithMemoryOptions extends Omit<vscode.SaveDialogOptions, 'defaultUri'> {
    /** 기억된 위치가 없을 때 사용할 디렉터리 (보통 워크스페이스 폴더). */
    defaultDir?: string;
}

/**
 * `vscode.window.showSaveDialog` 래퍼. 파일명은 호출자가 제안하고, 폴더는
 * `scope` 의 마지막 저장 위치를 우선한다 — 같은 종류의 파일을 늘 같은 폴더에
 * 내보내는 흐름에서 매번 폴더를 다시 찾아가지 않도록.
 */
export async function showSaveDialogWithMemory(
    scope: string,
    suggestedName: string,
    options: SaveDialogWithMemoryOptions = {},
    deps: DialogMemoryDeps = defaultDialogMemoryDeps()
): Promise<vscode.Uri | undefined> {
    const { defaultDir, ...rest } = options;
    const effective: vscode.SaveDialogOptions = { ...rest };
    // 꺼져 있으면 폴더는 비우고 파일명만 제안한다 — VS Code가 자기 최근 경로에
    // 그 이름으로 대화상자를 연다. 파일명까지 버리면 저장 대화상자가 이름 없이
    // 떠서 설정과 무관하게 쓰기 불편해진다.
    const startDir = deps.isEnabled()
        ? firstUsableDir([deps.recall(scope), defaultDir, deps.workspaceFallbackDir()], deps)
        : undefined;
    effective.defaultUri = vscode.Uri.file(startDir ? path.join(startDir, suggestedName) : suggestedName);

    const picked = await deps.showSaveDialog(effective);
    if (picked && picked.scheme === 'file') {
        deps.remember(scope, path.dirname(picked.fsPath));
    }
    return picked;
}
