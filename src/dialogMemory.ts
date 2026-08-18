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
 *   3. scope 를 가리지 않고 **가장 최근에 사용한** 다이얼로그 위치
 *   4. 활성 에디터가 속한 워크스페이스 폴더, 없으면 첫 워크스페이스 폴더
 *   5. 위 후보가 모두 없으면 `defaultUri` 없이 (= VS Code 기본 동작)
 *
 * 저장은 `workspaceState` 와 `globalState` 양쪽에 한다. 프로젝트별로 다른
 * 위치를 기억하되(workspaceState 우선), 그 프로젝트에서 처음 여는 다이얼로그는
 * 다른 창에서 쓰던 같은 용도의 위치를 물려받도록(globalState) 하기 위함이다.
 * 예외는 3번({@link LAST_USED_SCOPE})으로, 창을 넘지 않는다 — 물려받기의 근거가
 * "같은 용도"인데 그 값에는 용도가 없기 때문이다.
 */

/**
 * 0.6.11~0.6.32 의 저장 형식: scope 하나당 키 하나 (`dialogLocation:<scope>`).
 *
 * `fileDialog` / `folderDialog` / `pathDialog` 태스크의 scope 는 액션 id 와 태스크 id 로
 * 만들어지므로(`taskDialogScope`), 액션 이름을 바꾸거나 지울 때마다 옛 키가
 * 남았다. 정리 경로가 없어 **globalState 에 영구히 쌓였고**, 0.6.23 의 키 형식
 * 변경(액션 id 가 빠져 있던 버그 수정)으로 이미 한 세대가 고아가 됐다.
 *
 * 마이그레이션 대상으로만 남긴다. {@link migrateLegacyDialogLocations} 참조.
 */
const LEGACY_STATE_PREFIX = 'dialogLocation:';

/** 현재 저장 형식: scope → 위치를 담은 맵 하나. */
const STATE_KEY = 'taskhub.dialogLocations';

/**
 * 맵에 담아 둘 scope 최대 개수.
 *
 * 고정 scope 는 10개 남짓이고 나머지는 경로 선택 다이얼로그 태스크
 * 단위로 생긴다. 100개면 실제 사용에서 넘길 일이 거의 없으면서, 액션을
 * 반복해서 만들고 지우는 프로젝트에서도 저장소가 무한히 자라지 않는다.
 */
export const DIALOG_MEMORY_MAX_ENTRIES = 100;

/**
 * scope 를 가리지 않는 "가장 최근에 사용한 위치"가 담기는 예약 키.
 *
 * scope 별 기억은 **같은 용도를 반복할 때** 잘 맞지만, 그 scope 를 처음 쓰는
 * 순간에는 아무것도 없어 워크스페이스 루트로 떨어졌다. 한 액션이 "펌웨어 파일을
 * 고르고 → 출력 폴더를 고른다" 처럼 이어질 때, 두 번째 다이얼로그가 방금 다녀온
 * 폴더와 무관한 곳에서 열리는 것이 그 증상이다. 이 값은 그 빈자리에만 쓰인다 —
 * scope 기억이 있으면 언제나 그쪽이 이긴다.
 *
 * `*` 로 시작해 실제 scope 이름({@link DIALOG_SCOPE} 의 값, `taskDialogScope`
 * 의 `task.` 접두사)과 겹치지 않는다. 저장 맵의 한 칸을 차지하지만
 * {@link pruneDialogLocations} 가 축출 대상에서 뺀다.
 */
export const LAST_USED_SCOPE = '*last';

interface DialogLocationEntry {
    /** 기억된 디렉터리. */
    dir: string;
    /** 마지막으로 **기록된** 시각 (ms). 축출 순서를 정한다. */
    at: number;
}

type DialogLocationMap = Record<string, DialogLocationEntry>;

/**
 * 오래된 항목부터 버려 `max` 개로 줄인다.
 *
 * 기준은 "마지막 접근"이 아니라 **"마지막 기록"**이다. `remember` 는 사용자가
 * 실제로 무언가를 고른 직후에만 불리므로 둘이 사실상 같고, 읽을 때마다 쓰기를
 * 일으키지 않아도 된다 — 다이얼로그를 열 때마다 globalState 를 갱신하는 것은
 * 얻는 것에 비해 비싸다.
 *
 * 순수 함수로 둬서 축출 순서를 시계 없이 검증할 수 있다.
 */
export function pruneDialogLocations(map: DialogLocationMap, max: number = DIALOG_MEMORY_MAX_ENTRIES): DialogLocationMap {
    const entries = Object.entries(map);
    if (entries.length <= max) { return map; }
    // 예약 키를 남기는 아래 분기가 `max` 를 넘기지 않도록 경계를 먼저 끊는다.
    if (max <= 0) { return {}; }
    // `at` 이 같으면 scope 이름으로 갈라 결과가 결정적이게 한다.
    entries.sort((a, b) => (b[1].at - a[1].at) || a[0].localeCompare(b[0]));
    // {@link LAST_USED_SCOPE} 는 축출 대상에서 뺀다. 기록될 때마다 가장 새로운
    // `at` 을 받으므로 보통은 어차피 살아남지만, 시계가 뒤로 간 뒤(또는 미래
    // 시각이 적힌 저장소를 만나) 밀려나면 "직전 위치 이어받기"가 오래 쓴
    // 프로젝트에서만 조용히 사라진다 — 재현하기 어려운 종류의 결함이다.
    const reserved = map[LAST_USED_SCOPE];
    const kept = entries
        .filter(([scope]) => scope !== LAST_USED_SCOPE)
        .slice(0, reserved ? max - 1 : max);
    return Object.fromEntries(reserved ? [[LAST_USED_SCOPE, reserved], ...kept] : kept);
}

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
 * `fileDialog` / `folderDialog` / `pathDialog` 태스크용 scope. 한 액션 안에서도 태스크마다
 * 고르는 대상이 다르므로(펌웨어 파일 vs 출력 폴더) 태스크 단위로 분리한다.
 */
export function taskDialogScope(kind: 'file' | 'folder' | 'path', task: { id?: unknown, actionId?: unknown }): string {
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
    if (context) {
        migrateLegacyDialogLocations(context.workspaceState);
        migrateLegacyDialogLocations(context.globalState);
    }
    return previous;
}

/**
 * scope 당 키 하나였던 옛 형식을 맵 하나로 흡수하고 옛 키를 지운다.
 *
 * **한 번만 도는 작업이 아니라 멱등해야 한다** — 활성화마다 불리고, 옛 키가
 * 하나도 없으면 아무것도 하지 않는다.
 *
 * 흡수한 항목의 `at` 은 `0` 이다. 옛 형식에 시각이 없어 복원할 수 없고, 축출이
 * 필요해지면 **이번 세션에서 실제로 쓴 것보다 먼저** 버리는 편이 맞다.
 *
 * 리뷰에서 나온 대안 — "현재 워크스페이스의 액션 id 와 대조해 고아 키를
 * 지운다" — 은 쓰지 않았다. globalState 는 창 사이에 공유되므로, 지금 열린
 * 프로젝트에 없는 scope 가 곧 죽은 scope 인 것은 아니다. 그 방식은 다른
 * 프로젝트가 물려받아 쓰는 위치를 지워, 이 모듈이 의도한 "다른 창에서 쓰던
 * 위치를 이어받는다"는 동작을 깨뜨린다. 대신 총량만 제한한다.
 */
function migrateLegacyDialogLocations(memento: vscode.Memento): void {
    let legacyKeys: readonly string[];
    try {
        legacyKeys = memento.keys().filter(key => key.startsWith(LEGACY_STATE_PREFIX));
    } catch {
        return;   // keys() 미지원 환경(구버전 API)에서는 조용히 넘어간다.
    }
    if (legacyKeys.length === 0) { return; }

    const map = readLocationMap(memento);
    for (const key of legacyKeys) {
        const scope = key.slice(LEGACY_STATE_PREFIX.length);
        const dir = memento.get<unknown>(key);
        // 새 형식에 이미 값이 있으면 그쪽이 최신이다 — 덮어쓰지 않는다.
        if (typeof dir === 'string' && dir.length > 0 && !map[scope]) {
            map[scope] = { dir, at: 0 };
        }
        void Promise.resolve(memento.update(key, undefined)).then(undefined, () => undefined);
    }
    writeLocationMap(memento, pruneDialogLocations(map));
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
    /**
     * `scope` 의 위치를 기록한다. 구현은 {@link LAST_USED_SCOPE} 에도 같은 값을
     * **반드시 함께** 기록해야 한다 — 다른 용도의 다이얼로그가 자기 기억이 없을
     * 때 폴백으로 읽어 가기 때문이다. 두 항목은 한 번의 쓰기로 함께 갱신한다.
     *
     * {@link isEnabled} 가 거짓이면 **아무것도 기록하지 않는다.** 호출부는 설정을
     * 확인하지 않고 부르므로, 그 판단은 이 구현 안에 있다.
     */
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

function readLocationMap(memento: vscode.Memento): DialogLocationMap {
    const raw = memento.get<unknown>(STATE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return {}; }
    // 저장소가 손상됐거나 형식이 바뀐 경우를 걸러 낸다 — 잘못된 항목 하나로
    // 다이얼로그가 실패하지 않도록.
    const map: DialogLocationMap = {};
    for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') { continue; }
        const { dir, at } = value as Partial<DialogLocationEntry>;
        if (typeof dir === 'string' && dir.length > 0) {
            map[scope] = { dir, at: typeof at === 'number' ? at : 0 };
        }
    }
    return map;
}

/** 저장 실패(저장소 손상 등)로 다이얼로그 흐름이 깨지지 않도록 삼킨다. */
function writeLocationMap(memento: vscode.Memento, map: DialogLocationMap): void {
    void Promise.resolve(memento.update(STATE_KEY, map)).then(undefined, () => undefined);
}

function defaultRecall(scope: string): string | undefined {
    if (!memoryContext || !isMemoryEnabled()) { return undefined; }
    const fromWorkspace = readLocationMap(memoryContext.workspaceState)[scope]?.dir;
    // 예약 키는 **창 안에서만** 산다. globalState 로 내려가면 다른 창에서 방금
    // 다녀온 폴더가 이 프로젝트의 다이얼로그 시작 위치가 되는데, 그건 이 모듈이
    // 없애려던 바로 그 증상이다. scope 별 기억이 창을 넘어 물려지는 근거는
    // "같은 용도"인데, 예약 키에는 용도가 없다.
    if (scope === LAST_USED_SCOPE) { return fromWorkspace; }
    return fromWorkspace ?? readLocationMap(memoryContext.globalState)[scope]?.dir;
}

function defaultRemember(scope: string, dir: string): void {
    if (!memoryContext || !isMemoryEnabled()) { return; }
    const at = Date.now();
    for (const memento of [memoryContext.workspaceState, memoryContext.globalState]) {
        const map = readLocationMap(memento);
        map[scope] = { dir, at };
        // 예약 키는 창 로컬이므로 workspaceState 에만 쓴다 ({@link defaultRecall}
        // 참조). scope 기억과 같은 읽기-쓰기 안에서 처리해 저장소 왕복을 늘리지
        // 않는다.
        if (memento === memoryContext.workspaceState) {
            map[LAST_USED_SCOPE] = { dir, at };
        }
        writeLocationMap(memento, pruneDialogLocations(map));
    }
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
    //
    // `file` 이 아닌 scheme(원격/가상 파일시스템의 `vscode-remote://`,
    // `vscode-vfs://` 등)은 존재 확인 없이 그대로 넘긴다. node `fs` 로는 stat 할
    // 수 없어 검사하면 무조건 실패하고, 그러면 작성자가 적어 둔 원격 경로가
    // 조용히 버려진다. 잘못된 값이면 VS Code 가 알아서 기본 위치로 연다.
    if (caller && (caller.scheme !== 'file' || deps.exists(caller.fsPath))) {
        effective.defaultUri = caller;
    } else if (!deps.isEnabled()) {
        // 설정이 꺼졌으면 TaskHub는 시작 위치를 일절 지정하지 않는다. 그래야
        // VS Code 자체의 최근 경로가 쓰인다 — 설정 설명이 약속하는 동작이다.
        delete effective.defaultUri;
    } else {
        // scope 기억 → 가장 최근에 쓴 위치 → 워크스페이스. 가운데 후보가 하는
        // 일은 "이 용도로는 처음 여는 다이얼로그"를 직전에 다녀온 폴더에
        // 붙여 주는 것뿐이다 ({@link LAST_USED_SCOPE}).
        const startDir = firstUsableDir([deps.recall(scope), deps.recall(LAST_USED_SCOPE), deps.workspaceFallbackDir()], deps);
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
    // 시작 디렉터리를 확보했을 때만 defaultUri를 지정한다.
    //
    // 0.6.30은 설정이 꺼졌을 때 "폴더는 비우고 파일명만 제안"하려고
    // Uri.file(suggestedName)을 넘겼는데, 상대 경로 Uri는 파일시스템 루트로
    // 해석된다(Windows `\actions.taskhub`, POSIX `/actions.taskhub`) — 결국
    // TaskHub가 가장 이상한 위치를 지정한 셈이고, "시작 위치를 일절 지정하지
    // 않는다"는 설정 약속과도 어긋났다. VS Code API에는 파일명만 제안하는
    // 수단이 없으므로(defaultUri 하나뿐), 꺼진 상태에서는 파일명 제안을
    // 포기하는 것이 정직한 선택이다. defaultUri가 없으면 VS Code가 자기
    // 최근 경로에서 연다.
    // `defaultDir` 는 호출자가 이 저장에 대해 아는 사실(분석 중인 바이너리가 있던
    // 폴더 등)이므로, scope 를 가리지 않는 최근 위치보다 앞에 둔다.
    const startDir = deps.isEnabled()
        ? firstUsableDir([deps.recall(scope), defaultDir, deps.recall(LAST_USED_SCOPE), deps.workspaceFallbackDir()], deps)
        : undefined;
    if (startDir) {
        effective.defaultUri = vscode.Uri.file(path.join(startDir, suggestedName));
    }

    const picked = await deps.showSaveDialog(effective);
    if (picked && picked.scheme === 'file') {
        deps.remember(scope, path.dirname(picked.fsPath));
    }
    return picked;
}
