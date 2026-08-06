import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { t } from './i18n';
import { coerceToUri } from './previewOpener';
import { shouldOfferRecovery, RecoveryEntry, RecoveryStore, makeRecoveryStore } from './jsonEditorUtils';
import { DIALOG_SCOPE, showOpenDialogWithMemory } from './dialogMemory';

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * 패널 레지스트리 — **테스트용으로 노출한다** (Memory Map 의 `panelRegistry`,
 * Hex Viewer 의 `hexPanelRegistry` 와 같은 형태).
 *
 * 이게 없어서 JSON Editor 테스트는 순수 함수(`getWebviewContent`)만 부를 수
 * 있었고, 실제 진입점인 `openJsonEditorFile` 은 **어느 테스트도 실행하지
 * 않았다**. 파일 읽기·크기 검사·복구 스냅샷 제안·dirty 처리가 모두 그 안에
 * 있는데, 그 경로는 함수의 **소스 텍스트를 정규식으로** 검사하고 있었다 —
 * 로직이 틀려도 통과하는 방식이다.
 */
export const jsonPanelRegistry = {
    has(): boolean { return currentPanel !== undefined; },
    getFilePath(): string | undefined { return currentFilePath; },
    getTitle(): string | undefined { return currentPanel?.title; },
    getHtml(): string | undefined { return currentPanel?.webview.html; },
    isDirty(): boolean { return currentIsDirty; },
    clear(): void {
        currentPanel = undefined;
        currentMessageDisposable?.dispose();
        currentMessageDisposable = undefined;
        currentIsDirty = false;
        currentFilePath = undefined;
        currentSessionId = NO_SESSION;
        currentFileWatcher?.dispose();
        currentFileWatcher = undefined;
        if (currentSnapshotTimer) { clearTimeout(currentSnapshotTimer); }
        currentSnapshotTimer = undefined;
        currentPendingSnapshot = undefined;
        // 복구 저장소는 **모듈 싱글턴**이라 첫 컨텍스트에 묶인다. 실전에서는
        // 컨텍스트가 하나뿐이라 문제가 없지만, 테스트는 케이스마다 새
        // workspaceState 를 주므로 여기서 놓아 주지 않으면 이전 케이스의
        // 저장소를 계속 본다.
        recoveryStoreInstance = undefined;
    },
};
let currentMessageDisposable: vscode.Disposable | undefined;
let currentIsDirty = false;
let currentFilePath: string | undefined;
/**
 * 패널이 지금 어느 "열기"에 묶여 있는지. `openJsonEditorWithPath` 는 파일을
 * 바꿔 열 때 **패널을 재사용**하므로(`currentPanel.reveal` + 새 html), 모듈
 * 전역인 `currentPanel` 만 보고 응답을 보내면 이전 파일의 in-flight 저장 결과가
 * 새 파일의 webview 로 배달된다. 열 때마다 증가하는 이 번호를 webview 에 심고
 * 응답에 함께 실어, 양쪽 모두 자기 세션이 아닌 메시지를 버린다.
 *
 * **패널이 닫히는 것도 세션의 끝이다.** dispose 후 이 값을 그대로 두면 옛
 * 세션의 지연 콜백이 `isCurrentSession()` 을 통과해, 화면에 없는 파일 때문에
 * `currentIsDirty` 같은 모듈 전역을 되살린다 — 패널이 없는데 dirty 로 남는다.
 * 그래서 dispose 와 registry.clear 에서 {@link NO_SESSION} 으로 되돌린다.
 */
let jsonEditorSessionCounter = 0;
/** 어떤 세션도 화면에 없음. 실제 세션 번호는 `++counter` 라 항상 1 이상이다. */
const NO_SESSION = 0;
let currentSessionId = NO_SESSION;
let currentFileWatcher: vscode.FileSystemWatcher | undefined;
let currentSnapshotTimer: NodeJS.Timeout | undefined;
let currentPendingSnapshot: unknown | undefined;
/**
 * webview가 가장 최근에 보낸 'snapshot' 페이로드. 패널 dispose 시 pending
 * snapshot을 flush하거나, 외부 변경 Keep 분기에서 새 mtime으로 즉시
 * recovery 엔트리를 갱신할 때 쓰인다.
 */
let currentLastReceivedSnapshot: unknown | undefined;
/**
 * 활성 패널의 pending snapshot을 디스크(workspaceState)로 즉시 flush하는
 * 클로저. 매 `openJsonEditorWithPath` 호출 때 재바인딩되며, 패널 dispose
 * 핸들러에서 호출해 debounce 창 안에 닫혀도 최신 변경이 유실되지 않게 한다.
 */
let currentFlushPendingSnapshot: (() => Promise<void>) | undefined;
/**
 * `fs.statSync(file).mtimeMs` of the on-disk file at the moment of the last
 * write performed by JSON Editor itself. Used by the file watcher to suppress
 * the change event we triggered ourselves.
 *
 * `currentLastWriteSize`는 같은 시점의 `stat.size`. mtime 만으로 suppress 하면
 * 외부 도구가 mtime 을 보존한 채 (예: `touch -r`, sync 도구) 내용을 바꿨을 때
 * watcher event 가 와도 "내가 쓴 변경" 으로 오인해 무시한다. 그러면 사용자는
 * stale data 위에서 편집하게 되고, 닫을 때 recovery 가 옛 baseline size 로
 * stamp 되어 reopen 시 size mismatch 로 폐기 — 편집본 손실. mtime+size 가
 * 모두 일치할 때만 suppress 한다.
 */
let currentLastWriteMtime: number | undefined;
let currentLastWriteSize: number | undefined;

/** workspaceState 안의 복구 스냅샷 키. 테스트가 같은 키로 seed 할 수 있게 노출한다. */
export const RECOVERY_STATE_KEY = 'taskhub.jsonEditor.recovery';
const SNAPSHOT_DEBOUNCE_MS = 300;

/**
 * 단일 모듈 인스턴스 — recovery 엔트리 update 를 단일 promise chain 으로
 * 직렬화해 save 와 in-flight snapshot write 의 read-modify-write race 를 닫는다.
 * 첫 호출 시에 lazy 생성되므로 비활성화 시 메모리에 머무르지 않는다.
 */
let recoveryStoreInstance: RecoveryStore | undefined;
function getRecoveryStore(context: vscode.ExtensionContext): RecoveryStore {
    if (!recoveryStoreInstance) {
        recoveryStoreInstance = makeRecoveryStore(context.workspaceState, RECOVERY_STATE_KEY);
    }
    return recoveryStoreInstance;
}

function getRecoveryEntry(context: vscode.ExtensionContext, filePath: string): RecoveryEntry | undefined {
    return getRecoveryStore(context).get(filePath);
}

function setRecoveryEntry(
    context: vscode.ExtensionContext,
    filePath: string,
    entry: RecoveryEntry | null
): Promise<void> {
    return getRecoveryStore(context).set(filePath, entry);
}

function clearSnapshotTimer(): void {
    if (currentSnapshotTimer) {
        clearTimeout(currentSnapshotTimer);
        currentSnapshotTimer = undefined;
    }
    currentPendingSnapshot = undefined;
}

function showMissingSaveDataError(fileName: string): void {
    vscode.window.showErrorMessage(t(
        `${fileName}: 저장할 데이터가 없어 저장을 중단했습니다.`,
        `${fileName}: save was aborted because no JSON data was provided.`
    ));
}

function showSaveSuccess(fileName: string): void {
    vscode.window.showInformationMessage(t(`JSON 저장 완료: ${fileName}`, `JSON saved: ${fileName}`));
}

function showSaveFailure(fileName: string, error: any): void {
    vscode.window.showErrorMessage(t(
        `JSON 저장 실패 (${fileName}): ${error.message}`,
        `Failed to save JSON (${fileName}): ${error.message}`
    ));
}

/**
 * 저장은 성공했지만 새 mtime/크기를 읽지 못했을 때. 파일은 정상이지만 watcher 가
 * 우리 쓰기를 외부 변경으로 볼 수 있으므로 알린다.
 */
function showSaveBaselineWarning(fileName: string, error: any): void {
    vscode.window.showWarningMessage(t(
        `${fileName}은(는) 저장됐지만 파일 정보를 읽지 못했습니다. 외부 변경 알림이 잘못 뜰 수 있습니다: ${error.message}`,
        `${fileName} was saved, but its file info could not be read. You may see a spurious external-change prompt: ${error.message}`
    ));
}

/**
 * 저장 핸들러가 **예상하지 못한 지점**에서 실패했을 때 (webview 로 응답을
 * 보내는 것 자체가 던지는 등). 알려진 실패는 각자의 전용 메시지가 있으므로,
 * 여기 오는 것은 우리가 모르는 상태다.
 *
 * 그래서 "저장 실패" 라고 단정하지 않는다 — 이 지점은 디스크 쓰기 **전후 모두**
 * 도달 가능해서, 파일이 이미 바뀌었을 수도 있고 아닐 수도 있다. 확실한 것은
 * 편집기 상태를 더 이상 믿을 수 없다는 것뿐이고, host 는 dirty 로 남으므로
 * 사용자가 다음에 닫거나 파일을 바꿀 때 폐기 확인창이 뜬다.
 */
function showSaveHandlerFailure(fileName: string, error: any): void {
    const detail = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(t(
        `${fileName} 저장 처리 중 예기치 않은 오류가 발생했습니다. 파일 내용을 확인하고 다시 열어 주세요: ${detail}`,
        `An unexpected error occurred while handling the save of ${fileName}. Check the file and reopen it: ${detail}`
    ));
}

/**
 * 저장 자체는 성공했지만 복구 스냅샷 정리에 실패했을 때. 손실이 아니므로
 * 오류가 아니라 경고로 알린다 — 그래도 조용히 넘기지는 않는다.
 */
function showRecoveryCleanupWarning(fileName: string, error: any): void {
    vscode.window.showWarningMessage(t(
        `${fileName}은(는) 저장됐지만 복구 스냅샷을 지우지 못했습니다: ${error.message}`,
        `${fileName} was saved, but its recovery snapshot could not be cleared: ${error.message}`
    ));
}

/**
 * 사용자가 명시적으로 *변경사항 버리기* 를 선택해 confirmDiscardIfDirty 를
 * 통과시킨 직후 호출. 이전 파일에 대한 pending snapshot, 호스트 측 메모리
 * 캐시, 그리고 workspaceState 의 recovery 엔트리를 함께 비워, 이어지는
 * `offerRecoveryIfAny()` 가 방금 버린 변경을 다시 제안하지 않게 한다.
 */
async function discardPriorRecoveryIfAny(
    context: vscode.ExtensionContext,
    filePath: string | undefined
): Promise<void> {
    if (!filePath) { return; }
    if (currentSnapshotTimer) {
        clearTimeout(currentSnapshotTimer);
        currentSnapshotTimer = undefined;
    }
    currentPendingSnapshot = undefined;
    currentLastReceivedSnapshot = undefined;
    await setRecoveryEntry(context, filePath, null);
}

function disposeFileWatcher(): void {
    currentFileWatcher?.dispose();
    currentFileWatcher = undefined;
}

/**
 * Dirty 상태에서 파일을 닫았을 때를 대비한 복구 스냅샷이 있으면 사용자에게
 * 복구 여부를 묻는다.
 *
 * **스냅샷은 사용자가 명시적으로 '버리기'를 누를 때만 지운다.** 예전에는
 * 신선도 검사(mtime/size)가 어긋나면 묻지도 않고 지웠는데, 그 판단은 두 가지를
 * 섞고 있었다 — "제안할 만한가" 와 "지워도 되는가" 는 다른 질문이다. 어긋난
 * 스냅샷은 제안하지 않는 것으로 충분하고, 저장소 상한이 어차피 오래된 것부터
 * 밀어낸다. 미저장 변경을 우리 판단으로 파기할 이유는 없다.
 *
 * `skipFreshnessCheck` 는 **디스크 단계가 실패한** 경로가 쓴다. 그때는 비교할
 * 현재 내용이 애초에 없고(파일이 사라졌거나 JSON 이 깨졌다) 스냅샷이 유일한
 * 데이터다 — 신선도를 요구하면 fallback 이 구조적으로 성공할 수 없다.
 */
async function offerRecoveryIfAny(
    context: vscode.ExtensionContext,
    filePath: string,
    fileMtimeMs: number,
    fileSize?: number,
    options: { skipFreshnessCheck?: boolean } = {}
): Promise<RecoveryEntry | null> {
    const entry = getRecoveryEntry(context, filePath);
    if (!entry) { return null; }
    if (!options.skipFreshnessCheck && !shouldOfferRecovery(entry, fileMtimeMs, fileSize)) {
        return null;
    }
    const fileName = path.basename(filePath);
    const recoverLabel = t('복구', 'Recover');
    const discardLabel = t('버리기', 'Discard');
    const choice = await vscode.window.showInformationMessage(
        t(
            `${fileName}에 이전 세션의 미저장 변경사항이 있습니다. 복구하시겠습니까?`,
            `${fileName} has unsaved changes from a previous session. Recover them?`
        ),
        recoverLabel,
        discardLabel
    );
    if (choice === recoverLabel) {
        return entry;
    }
    // **명시적으로 '버리기'를 누른 경우에만** 스냅샷을 지운다. 알림을 Esc/X 로
    // 닫으면 `choice` 는 `undefined` 인데, 그것을 '버리기'와 같이 처리하면
    // 사용자가 결정을 미룬 것을 파기로 해석하는 셈이다. 원본 파일이 사라졌거나
    // 깨진 fallback 경로(`earlyError`)에서는 이 스냅샷이 **유일한 복구본**이라,
    // 알림을 무심코 닫는 것만으로 미저장 변경이 영영 사라졌다.
    if (choice === discardLabel) {
        await setRecoveryEntry(context, filePath, null);
    }
    return null;
}

async function confirmDiscardIfDirty(fileName: string): Promise<boolean> {
    if (!currentIsDirty) { return true; }
    const discardLabel = t('변경사항 버리기', 'Discard changes');
    const choice = await vscode.window.showWarningMessage(
        t(
            `${fileName}에 저장하지 않은 변경사항이 있습니다. 계속하시겠습니까?`,
            `${fileName} has unsaved changes. Continue?`
        ),
        { modal: true },
        discardLabel
    );
    return choice === discardLabel;
}

/** JSON Editor에서 처리 가능한 최대 파일 크기 (10 MB) */
const JSON_EDITOR_MAX_FILE_SIZE = 10 * 1024 * 1024;

export interface JsonEditorOpenHistory {
    filePath: string;
    fileName: string;
}

export type JsonEditorHistoryRecorder = (entry: JsonEditorOpenHistory) => void;

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detectIndent(text: string): string | number {
    const match = text.match(/^[ \t]+/m);
    if (!match) {
        return 2;
    }
    const indent = match[0];
    if (indent.includes('\t')) {
        return '\t';
    }
    return indent.length;
}

export async function openJsonEditor(context: vscode.ExtensionContext, recordHistory?: JsonEditorHistoryRecorder) {
    const fileUris = await showOpenDialogWithMemory(DIALOG_SCOPE.jsonEditor, {
        canSelectMany: false,
        filters: { 'JSON Files': ['json'] },
        openLabel: t('JSON 파일 열기', 'Open JSON File')
    });

    if (!fileUris || fileUris.length === 0) {
        return;
    }

    const filePath = fileUris[0].fsPath;
    if (await openJsonEditorWithPath(context, filePath)) {
        recordHistory?.({ filePath, fileName: path.basename(filePath) });
    }
}

export async function openJsonEditorFromUri(context: vscode.ExtensionContext, arg?: unknown, recordHistory?: JsonEditorHistoryRecorder) {
    // VS Code가 컨텍스트 메뉴 표면별로 다른 형태를 넘긴다: explorer/editor는
    // `Uri`(혹은 `Uri[]`), scm/resourceState는 `{ resourceUri: Uri }`. previewOpener
    // 와 동일하게 `coerceToUri`로 정규화해 SCM 메뉴에서 `uri.fsPath`가 undefined가
    // 되어 터지는 것을 막는다.
    let uri = coerceToUri(arg);
    if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.json')) {
            uri = editor.document.uri;
        } else {
            return openJsonEditor(context, recordHistory);
        }
    }

    const filePath = uri.fsPath;
    if (await openJsonEditorWithPath(context, filePath)) {
        recordHistory?.({ filePath, fileName: path.basename(filePath) });
    }
}

/**
 * 히스토리에서 저장된 경로로 JSON Editor를 다시 연다. `taskhub.openToolFromHistory`
 * 핸들러가 사용하며, 패널이 실제로 열린 경우에만 새 히스토리 엔트리를 기록한다.
 */
export async function openJsonEditorFile(context: vscode.ExtensionContext, filePath: string, recordHistory?: JsonEditorHistoryRecorder) {
    if (await openJsonEditorWithPath(context, filePath)) {
        recordHistory?.({ filePath, fileName: path.basename(filePath) });
    }
}

export const ROOT_ARRAY_KEY = '_rootArray';

export function wrapIfArray(data: unknown): { wrapped: Record<string, unknown>; isRootArray: boolean } {
    if (Array.isArray(data)) {
        return { wrapped: { [ROOT_ARRAY_KEY]: data }, isRootArray: true };
    }
    return { wrapped: data as Record<string, unknown>, isRootArray: false };
}

export function unwrapIfRootArray(data: Record<string, unknown>, isRootArray: boolean): unknown {
    if (isRootArray && ROOT_ARRAY_KEY in data) {
        return data[ROOT_ARRAY_KEY];
    }
    return data;
}

async function openJsonEditorWithPath(context: vscode.ExtensionContext, filePath: string): Promise<boolean> {
    const fileName = filePath.split(/[\\/]/).pop() || 'JSON Editor';

    if (currentPanel && currentFilePath) {
        if (currentFilePath !== filePath) {
            const wasDirty = currentIsDirty;
            const prevFileName = currentFilePath.split(/[\\/]/).pop() || 'JSON Editor';
            if (!(await confirmDiscardIfDirty(prevFileName))) {
                currentPanel.reveal(vscode.ViewColumn.One);
                return false;
            }
            // 사용자가 *변경사항 버리기* 를 선택했다 → 이전 파일의 recovery
            // 엔트리와 in-flight snapshot 을 정리. 이렇게 하지 않으면 나중에
            // 그 파일을 다시 열었을 때 방금 버린 변경이 *복구 프롬프트* 로
            // 되살아난다.
            if (wasDirty) {
                await discardPriorRecoveryIfAny(context, currentFilePath);
            }
        } else if (currentIsDirty) {
            // Reopening the same file while dirty — confirm before we overwrite
            // the webview state with a fresh read from disk.
            if (!(await confirmDiscardIfDirty(fileName))) {
                currentPanel.reveal(vscode.ViewColumn.One);
                return false;
            }
            // 같은 파일 dirty reopen 에서도 동일하게 정리한다. 그래야 곧이은
            // offerRecoveryIfAny() 가 디스크와 일치하는 (방금 사용자가 버리려고
            // 했던) snapshot 을 다시 제안하지 않는다.
            await discardPriorRecoveryIfAny(context, currentFilePath);
        }
    }

    // 디스크 단계 (stat / size / read / parse) 의 어떤 실패든 earlyError 에 캡쳐.
    // 마지막에 매칭 recovery 가 있으면 그것으로 fallback — 옛 dirty close 의
    // 미저장 변경이 외부 사고 (파일 삭제 / 사이즈 폭증 / invalid JSON 등) 로
    // 영구히 잠기지 않도록 모든 early-return 을 단일 fallback 으로 라우팅한다.
    // `mtimeForRecovery` 는 두지 않는다 — fallback 이 신선도를 보지 않으므로
    // 읽는 곳이 없다. 남겨 두면 그 값이 무언가를 결정한다고 오해하게 된다.
    let earlyError: { msg: string } | null = null;

    let stat: fs.Stats | undefined;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        earlyError = {
            msg: t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`)
        };
    }

    if (!earlyError && stat && stat.size > JSON_EDITOR_MAX_FILE_SIZE) {
        earlyError = {
            msg: t(
                `파일 크기(${formatFileSize(stat.size)})가 JSON Editor 처리 한도(${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)})를 초과합니다. 대용량 JSON 파일은 텍스트 에디터에서 직접 편집해 주세요.`,
                `File size (${formatFileSize(stat.size)}) exceeds the JSON Editor limit (${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)}). Please edit large JSON files directly in a text editor.`
            )
        };
    }

    let jsonData!: Record<string, unknown>;
    let isRootArray = false;
    let detectedIndent: string | number = 2;
    let content: string | undefined;
    if (!earlyError) {
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (error: any) {
            earlyError = {
                msg: t(`파일 읽기 실패 (${fileName}): ${error.message}`, `Failed to read file (${fileName}): ${error.message}`)
            };
        }
    }

    let parseSucceeded = false;
    let diskDataIfValid: Record<string, unknown> | undefined;
    if (!earlyError && content !== undefined) {
        try {
            const parsed = JSON.parse(content);
            const result = wrapIfArray(parsed);
            jsonData = result.wrapped;
            isRootArray = result.isRootArray;
            detectedIndent = detectIndent(content);
            diskDataIfValid = jsonData;
            parseSucceeded = true;
        } catch (error: any) {
            earlyError = {
                msg: t(`JSON 파싱 실패 (${fileName}): ${error.message}`, `Failed to parse JSON (${fileName}): ${error.message}`)
            };
        }
    }

    // 외부 변경 감지 시 비교에 쓸 mtime — fallback 분기에서는 recovery 의
    // own mtime 또는 stat 으로부터 채운다.
    let baselineMtimeMs: number;
    // mtime 보존형 외부 변경(예: `touch -r`, 일부 sync 도구)을 잡기 위한 보조
    // fingerprint. recovery entry 와 함께 보관해 reopen 에서 size 가 바뀌었으면
    // mtime 이 같아도 stale 로 폐기한다. 디스크가 유효할 때만 채워진다.
    let baselineFileSize: number | undefined;
    let recovered: RecoveryEntry | null = null;
    let savedDataForWebview: Record<string, unknown> | undefined;
    // 디스크에 valid baseline 이 없는 disk-fail 경로면 webview 가 빈 문자열
    // sentinel 로 lastSavedSnapshot 을 잡아 항상 dirty 유지하도록 플래그를 켠다.
    // (이전에는 disk-fail fallback 에 빈 객체 sentinel 을 디스크 데이터로 보냈
    // 지만, 사용자가 실제로 빈 객체를 편집 중일 때 dirty=false 로 충돌하는
    // 데이터 손실 케이스가 있어 명시적 baseline-unknown 신호로 교체.)
    let baselineUnknownForWebview = false;

    if (earlyError) {
        // 디스크 단계 실패 — 매칭 recovery 가 있으면 사용자에게 제안.
        // getRecoveryEntry 로 entry 존재만 먼저 확인하고, 있으면 mtime 결정 후
        // offerRecoveryIfAny 로 prompt. (entry 가 없으면 prompt 도 띄우지 않고
        // 곧장 error 로 빠진다.)
        const entry = getRecoveryEntry(context, filePath);
        let fallback: RecoveryEntry | null = null;
        if (entry) {
            // **신선도를 요구하지 않는다.** 예전에는 `stat.mtimeMs`(현재 mtime)를
            // 넘겼는데, 손상의 원인이 대개 외부 변경이라 mtime 은 거의 항상
            // 갱신돼 있다 → 검사가 늘 어긋나 fallback 이 **한 번도 발동하지
            // 못했다**. 파일이 10MB 를 넘어간 경우도 같다. 검사를 통과시키려고
            // 테스트가 손상 후 mtime·size 를 인위적으로 원복하고 있었던 것이
            // 이 구조적 실패를 가렸다.
            //
            // 여기서 비교할 "현재 내용" 은 애초에 없다 — 읽지 못했거나 파싱하지
            // 못한 상태다. 스냅샷이 유일한 데이터이므로 그대로 제안한다.
            fallback = await offerRecoveryIfAny(
                context, filePath, entry.fileMtimeMs, entry.fileSize, { skipFreshnessCheck: true }
            );
        }
        if (!fallback) {
            vscode.window.showErrorMessage(earlyError.msg);
            return false;
        }
        jsonData = fallback.data as Record<string, unknown>;
        isRootArray = fallback.isRootArray;
        recovered = fallback;
        // 디스크에 valid baseline 이 없다 → webview 부팅 시 sentinel 로 baseline
        // unknown 표시. dirty=true 로 시작 → 사용자가 save 로 디스크를
        // 명시적으로 복구하거나 의식적으로 다른 결정을 내리게 된다.
        baselineUnknownForWebview = true;
        savedDataForWebview = undefined;
        // baselineMtimeMs: stat 가 있으면 그것을, 없으면 (파일 삭제) recovery
        // 의 own mtime 을 사용해 watcher / shouldOfferRecovery 가 일관된 값을
        // 본다.
        baselineMtimeMs = stat ? stat.mtimeMs : fallback.fileMtimeMs;
        baselineFileSize = stat ? stat.size : fallback.fileSize;
    } else {
        // 정상 경로: 디스크 데이터가 있고, 이전 세션 dirty close 의 recovery 가
        // 있으면 prompt.
        baselineMtimeMs = stat!.mtimeMs;
        baselineFileSize = stat!.size;
        recovered = await offerRecoveryIfAny(context, filePath, baselineMtimeMs, baselineFileSize);
        if (recovered) {
            jsonData = recovered.data as Record<string, unknown>;
            isRootArray = recovered.isRootArray;
        }
        savedDataForWebview = recovered ? diskDataIfValid : undefined;
    }

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'taskhub.jsonEditor',
            `JSON Editor: ${fileName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                // webview 로직 번들을 실을 수 있어야 한다. 기본값도 확장 설치
                // 디렉터리를 포함하지만, 읽는 사람이 "이 webview 가 디스크에서
                // 무엇을 불러오는지" 를 여기서 바로 알 수 있도록 명시한다.
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
            }
        );
        currentPanel.onDidDispose(() => {
            // Pending snapshot이 디바운스 창(300ms) 안에 머무는 동안 사용자가
            // 패널을 닫으면 timeout이 cancel되며 데이터가 유실될 수 있다.
            // 'edit → 즉시 X' 경로에서도 복구가 가능하도록 dispose 직전에
            // 동기적으로 flush 트리거. 실제 workspaceState.update는 비동기지만
            // VS Code가 호스트 종료 전 in-flight update를 기다린다.
            void currentFlushPendingSnapshot?.();
            currentPanel = undefined;
            currentMessageDisposable?.dispose();
            currentMessageDisposable = undefined;
            currentIsDirty = false;
            currentFilePath = undefined;
            // 닫힌 것도 세션의 끝이다. 이 줄이 없으면 모달·await 뒤에서 깨어난
            // 옛 콜백이 `isCurrentSession()` 을 통과해, 화면에 없는 파일 때문에
            // currentIsDirty 를 다시 켠다 (패널이 없는데 dirty 로 남는다).
            currentSessionId = NO_SESSION;
            currentFlushPendingSnapshot = undefined;
            currentLastReceivedSnapshot = undefined;
            disposeFileWatcher();
            clearSnapshotTimer();
        });
    }

    // 이 열기에 붙는 세션 번호. html 주입과 메시지 핸들러가 **같은 값**을 써야
    // 하므로 html 을 세팅하기 직전에 한 번만 뽑는다.
    const sessionId = ++jsonEditorSessionCounter;
    currentSessionId = sessionId;

    currentPanel.title = `JSON Editor: ${fileName}`;
    const logicScriptUri = currentPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'jsonEditorWebview.js')
    ).toString();
    currentPanel.webview.html = getWebviewContent(jsonData, savedDataForWebview, filePath, currentPanel.webview, baselineUnknownForWebview, sessionId, logicScriptUri);
    currentIsDirty = Boolean(recovered);
    currentFilePath = filePath;
    currentLastWriteMtime = baselineMtimeMs;
    currentLastWriteSize = baselineFileSize;
    clearSnapshotTimer();

    // 스냅샷 디바운스: 편집 중 webview가 보내는 'snapshot' 메시지를 모아 마지막
    // 값만 workspaceState에 기록한다. flushNow는 패널 dispose / 외부 변경 Keep
    // 분기에서 즉시 기록을 강제할 때 사용된다.
    const writeSnapshotEntry = (data: unknown): Promise<void> => {
        const entry: RecoveryEntry = {
            data,
            isRootArray,
            fileMtimeMs: baselineMtimeMs,
            fileSize: baselineFileSize,
            capturedAt: Date.now()
        };
        return Promise.resolve(setRecoveryEntry(context, filePath, entry));
    };
    const flushPendingSnapshot = async (): Promise<void> => {
        if (currentSnapshotTimer) {
            clearTimeout(currentSnapshotTimer);
            currentSnapshotTimer = undefined;
        }
        if (currentPendingSnapshot === undefined) { return; }
        const snapshot = currentPendingSnapshot;
        currentPendingSnapshot = undefined;
        await writeSnapshotEntry(snapshot);
    };
    currentFlushPendingSnapshot = flushPendingSnapshot;
    const scheduleSnapshotWrite = (snapshot: unknown) => {
        currentPendingSnapshot = snapshot;
        if (currentSnapshotTimer) { clearTimeout(currentSnapshotTimer); }
        currentSnapshotTimer = setTimeout(() => {
            const pending = currentPendingSnapshot;
            currentPendingSnapshot = undefined;
            currentSnapshotTimer = undefined;
            void writeSnapshotEntry(pending);
        }, SNAPSHOT_DEBOUNCE_MS);
    };

    /**
     * webview 로 가는 **모든** 메시지는 이 함수를 거친다.
     *
     * host 의 여러 경로(save / reload / 외부 변경 watcher)가 `await` 로 이벤트
     * 루프를 놓아 준다. 그 사이 사용자가 다른 파일을 열면 패널이 재사용되어
     * `currentPanel` 은 **새 파일의 webview** 를 가리킨다. 그대로 보내면
     *
     *   - `saveResult` 는 새 파일의 편집을 남의 저장 결과로 clean 처리하고,
     *   - `loadData` 는 **B 화면을 A 의 데이터로 갈아치운다** (그 뒤 저장하면
     *     B 파일까지 A 데이터가 된다).
     *
     * 세션이 바뀌었으면 보내지 않는다 — 그 메시지를 기다리는 webview 는 이미
     * 없다. 배달 자체도 비동기이므로 webview 도 `msg.session` 을 한 번 더
     * 확인한다.
     */
    const postToWebview = (message: Record<string, unknown>): void => {
        if (currentSessionId !== sessionId) { return; }
        void currentPanel?.webview.postMessage({ ...message, session: sessionId });
    };

    /**
     * `await` 뒤에 **이 세션이 아직 화면에 있는지**.
     *
     * 메시지에 세션을 붙이는 것만으로는 부족하다. 이 클로저의 콜백들(외부 변경
     * watcher, reload)은 모달을 띄우거나 recovery 를 정리하며 `await` 하는데,
     * 그 사이 다른 파일이 열리면 `currentIsDirty` · `currentLastReceivedSnapshot`
     * · snapshot timer 같은 **모듈 전역 상태는 이미 새 파일의 것**이다. 그것을
     * 옛 세션의 콜백이 계속 건드리면 새 파일의 미저장 편집이 clean 으로 바뀌거나
     * recovery 가 지워진다. 모든 `await` 뒤에서 확인한다.
     */
    const isCurrentSession = (): boolean => currentSessionId === sessionId;

    /**
     * @returns 실제로 보냈으면 true. 세션이 바뀌어 보내지 않았으면 false —
     *   그 응답을 기다릴 webview 가 없으므로 호출부가 대기 상태를 정리해야 한다.
     */
    const postSaveResult = (success: boolean, seq: unknown): boolean => {
        if (!isCurrentSession()) { return false; }
        postToWebview({ command: 'saveResult', success, seq });
        return true;
    };

    /**
     * 아직 webview 가 **처리를 마쳤다고 알려오지 않은** 저장 요청의 seq 들.
     *
     * 이 집합이 비어 있지 않은 동안 webview 의 clean 선언은 믿지 않는다 —
     * webview 는 그때까지 옛 baseline 과 비교하고 있어서, 저장 직후 그 baseline
     * 으로 undo 하면 "변경 없음" 이라고 말하지만 디스크에는 방금 쓴 다른 내용이
     * 들어 있다.
     *
     * **`saveResult` 를 보낸 시점이 아니라 webview 의 `saveAck` 를 받은 시점에
     * 비운다.** `postMessage` 는 배달 예약일 뿐 처리 완료가 아니라서, 보내자마자
     * 비우면 그 직전에 webview 가 보낸 `modified:false` 가 방어를 빠져나갈 수
     * 있다. 세션이 바뀌어 응답을 보내지 못한 경우에는 기다릴 webview 가 없으므로
     * 즉시 비운다.
     *
     * **세션 지역이다.** 모듈 전역이던 시절에는 이전 세션의 지연된 저장이
     * 새 세션의 카운터를 깎아 음수로 만들었다.
     */
    const awaitingSaveAck = new Set<unknown>();

    currentMessageDisposable?.dispose();
    currentMessageDisposable = currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            if (!message || typeof message !== 'object' || typeof message.command !== 'string') {
                return;
            }
            // **남의 세션 메시지는 여기서 끊는다.** 패널을 재사용해 다른 파일을
            // 열면 이 핸들러의 `filePath` 는 새 파일인데, 옛 webview 가 이미
            // 보내 놓은 메시지가 도착할 수 있다 — 그 'save' 를 처리하면 새 파일에
            // 옛 파일의 데이터를 쓴다. webview 는 모든 발신에 세션을 붙인다
            // (`postToHost`).
            if (message.session !== sessionId) {
                return;
            }
            switch (message.command) {
                case 'modified': {
                    const nextDirty = Boolean(message.value);
                    // 저장 응답을 기다리는 동안의 **clean 선언은 무시한다.**
                    // webview 는 아직 옛 baseline 과 비교하고 있어서, 저장 직후
                    // 그 baseline 으로 undo 하면 "변경 없음" 이라고 말한다. 그러나
                    // 디스크에는 방금 쓴 다른 내용이 있다. 응답을 처리한 webview 가
                    // 곧 진짜 상태를 `saveAck` 의 `dirty` 로 되돌려 주므로 여기서
                    // 무시해도 수렴한다. dirty 선언은 그대로 받아들인다 — 안전한
                    // 방향이고 미커밋 입력 보호에 필요하다.
                    if (!nextDirty && awaitingSaveAck.size > 0) {
                        break;
                    }
                    currentIsDirty = nextDirty;
                    if (!currentIsDirty) {
                        clearSnapshotTimer();
                        // recovery 엔트리를 비울 때는 마지막으로 받은 snapshot
                        // 캐시도 함께 비워야 한다. 그렇지 않으면 이후 사용자가
                        // json-edit invalid mid-edit 으로 dirty 만 다시 켜진
                        // 상태에서 외부 변경 *Keep current edits* 분기가
                        // currentLastReceivedSnapshot 의 stale 값을 새 mtime 으로
                        // recovery 에 써, cancelled draft 가 reopen 에서 부활한다.
                        currentLastReceivedSnapshot = undefined;
                        await setRecoveryEntry(context, filePath, null);
                    }
                    break;
                }
                case 'snapshot': {
                    currentLastReceivedSnapshot = message.data;
                    scheduleSnapshotWrite(message.data);
                    break;
                }
                case 'save': {
                    if (!Object.hasOwn(message, 'data')) {
                        showMissingSaveDataError(fileName);
                        return;
                    }
                    // webview 가 붙인 저장 요청 번호. 결과에 그대로 되돌려 주어야
                    // webview 가 "디스크에 들어간 것"을 baseline 으로 잡을 수 있다
                    // (아래 saveResult 주석 참조).
                    const saveSeq = message.seq;
                    // 이 저장이 webview 의 확인(`saveAck`)을 받을 때까지 clean
                    // 선언을 믿지 않는다 (`awaitingSaveAck` 주석 참조).
                    awaitingSaveAck.add(saveSeq);
                    /** 응답을 보냈으면 webview 의 ack 를 기다리고, 못 보냈으면 즉시 정리. */
                    const settle = (delivered: boolean) => {
                        if (!delivered) { awaitingSaveAck.delete(saveSeq); }
                    };
                    try {
                        try {
                            const saveData = unwrapIfRootArray(message.data, isRootArray);
                            fs.writeFileSync(filePath, JSON.stringify(saveData, null, detectedIndent) + '\n', 'utf-8');
                        } catch (error: any) {
                            // 디스크에 쓰지 못했다 — 진짜 저장 실패.
                            settle(postSaveResult(false, saveSeq));
                            showSaveFailure(fileName, error);
                            return;
                        }
                        // **여기부터는 바이트가 이미 디스크에 있다.** `statSync` 는
                        // 우리 쓰기를 watcher 가 외부 변경으로 오인하지 않게 하는
                        // 보조 정보일 뿐이므로, 실패해도 저장을 실패로 뒤집지 않는다.
                        // 다만 baseline 을 갱신하지 못하면 다음 watcher 이벤트가
                        // "외부에서 바뀌었다" 는 모달을 띄울 수 있다 — 데이터
                        // 손실은 없지만 조용히 넘기지는 않는다.
                        try {
                            const written = fs.statSync(filePath);
                            currentLastWriteMtime = written.mtimeMs;
                            currentLastWriteSize = written.size;
                            baselineMtimeMs = written.mtimeMs;
                            baselineFileSize = written.size;
                        } catch (statError: any) {
                            showSaveBaselineWarning(fileName, statError);
                        }
                        // **여기부터는 이미 디스크에 들어갔다.** 아래는 정리
                        // 작업이므로 실패해도 "저장 실패" 로 보고하지 않는다.
                        // 예전에는 한 try 에 묶여 있어, 쓰기가 끝난 뒤 recovery
                        // 삭제만 실패해도 `success: false` 가 나갔다. 그러면
                        // webview 는 baseline 을 옮기지 못한 채 옛 baseline 과
                        // 비교하게 되고, 그 사이 사용자가 옛 내용으로 undo 했다면
                        // 디스크(새 내용)와 다른데도 clean 으로 판정한다.
                        //
                        // recovery 엔트리가 남더라도 손실은 아니다 — `shouldOfferRecovery`
                        // 가 방금 갱신된 파일 mtime 과 비교해 stale 로 걸러낸다.
                        // 그래도 조용히 넘기지는 않고 경고로 알린다.
                        //
                        // **host 는 여기서 clean 으로 내려가지 않는다.**
                        //
                        // 디스크에 들어간 것은 webview 가 save 와 함께 보낸
                        // 스냅샷이고, 그 뒤로 사용자가 더 편집했는지는 webview 만
                        // 안다 — `setModified` 는 값이 **바뀔 때만** host 에
                        // 알리므로, 이미 dirty 이던 상태에서 이어진 편집이나
                        // undo 는 host 로 아무 메시지도 보내지 않는다
                        // ('snapshot' 도 dirty 를 올리지 않는다). 여기서 먼저
                        // clean 이 되면 그 창에서 다른 파일을 열 때
                        // `confirmDiscardIfDirty` 가 조용히 통과해 편집이 사라진다.
                        //
                        // 진짜 상태는 아래 `saveResult` 를 받은 webview 가
                        // `saveAck` 의 `dirty` 로 **항상** 되돌려 준다. 그때까지
                        // dirty 로 남는 쪽이 안전한 방향이다 — 최악이 불필요한
                        // 확인창 한 번이고, 반대 방향의 최악은 유실이다.
                        // recovery 삭제만 실패하는 경로에서도 이 순서 덕분에
                        // host 와 webview 가 어긋난 채 남지 않는다.
                        clearSnapshotTimer();
                        currentLastReceivedSnapshot = undefined;
                        try {
                            await setRecoveryEntry(context, filePath, null);
                        } catch (cleanupError: any) {
                            showRecoveryCleanupWarning(fileName, cleanupError);
                        }
                        settle(postSaveResult(true, saveSeq));
                        showSaveSuccess(fileName);
                    } catch (unexpected) {
                        // 예상치 못한 실패로 응답을 못 보냈다면 기다릴 webview 가
                        // 없다 — 여기서 정리하지 않으면 host 가 영원히 dirty 로
                        // 남아 매번 폐기 확인창이 뜬다.
                        awaitingSaveAck.delete(saveSeq);
                        // **사용자에게 반드시 알린다.** 이 핸들러는 async 인데
                        // VS Code 가 await 하지 않으므로, 그냥 던지면 확장 호스트
                        // 로그에만 남고 화면에는 아무 일도 일어나지 않는다 —
                        // 저장한 줄 알았던 사용자가 아무 신호도 못 받는다.
                        // 알린 뒤 다시 던져 스택은 로그에 남긴다.
                        showSaveHandlerFailure(fileName, unexpected);
                        throw unexpected;
                    }
                    break;
                }
                case 'saveAck': {
                    // webview 가 `saveResult` 처리를 마쳤다는 신호. **최종 dirty 를
                    // 함께 싣고 여기서 원자적으로 적용한다.**
                    //
                    // 별도의 'modified' 로 알리게 두면 순서가 어긋난다 — webview 는
                    // modified 를 먼저 보내는데 그때는 아직 ack 대기 중이라 위
                    // 가드가 그것을 버리고, 뒤이은 ack 는 대기만 풀고 dirty 를
                    // 복원하지 않아 **정상 저장인데도 host 가 영원히 dirty 로
                    // 남는다** (파일을 바꿀 때마다 폐기 확인창).
                    awaitingSaveAck.delete(message.seq);
                    currentIsDirty = Boolean(message.dirty);
                    if (!currentIsDirty) {
                        clearSnapshotTimer();
                        currentLastReceivedSnapshot = undefined;
                        await setRecoveryEntry(context, filePath, null);
                    }
                    break;
                }
                case 'reload': {
                    if (!(await confirmDiscardIfDirty(fileName))) {
                        break;
                    }
                    // 확인창이 떠 있는 동안 다른 파일이 열렸다면 이 reload 는
                    // 이미 화면에 없는 파일에 대한 것이다 — 그대로 진행하면
                    // 새 파일의 전역 dirty/baseline 상태를 덮어쓴다.
                    if (!isCurrentSession()) { break; }
                    // 실패 경로 헬퍼: 디스크 baseline 갱신 + webview baseline-unknown 으로
                    // dirty 전환. 옛 baselineMtimeMs 그대로 두면, 이후 사용자 편집의 recovery
                    // 가 옛 mtime 으로 stamp 되어 reopen 시 stale 로 폐기되거나, webview 의
                    // lastSavedSnapshot 이 옛 valid disk 데이터로 남아 사용자가 그것에 도달할
                    // 때 dirty=false 로 풀려 같은 데이터 손실 패턴이 발생한다. watcher 의
                    // auto-reload 실패 경로와 동일한 처치.
                    const handleReloadFailure = (statForBaseline?: fs.Stats) => {
                        if (statForBaseline) {
                            baselineMtimeMs = statForBaseline.mtimeMs;
                            baselineFileSize = statForBaseline.size;
                            currentLastWriteMtime = statForBaseline.mtimeMs;
                            currentLastWriteSize = statForBaseline.size;
                        }
                        currentIsDirty = true;
                        postToWebview({ command: 'markBaselineUnknown' });
                    };
                    // open 경로에 있는 size guard 와 동일하게 reload 도 디스크
                    // 사이즈를 확인. 외부에서 파일이 10MB 초과로 바뀌면
                    // readFileSync 가 메모리를 크게 잡아먹는다.
                    let preReadStat: fs.Stats | undefined;
                    try {
                        preReadStat = fs.statSync(filePath);
                        if (preReadStat.size > JSON_EDITOR_MAX_FILE_SIZE) {
                            handleReloadFailure(preReadStat);
                            vscode.window.showErrorMessage(t(
                                `파일 크기(${formatFileSize(preReadStat.size)})가 JSON Editor 처리 한도(${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)})를 초과합니다. 다시 읽기를 중단합니다.`,
                                `File size (${formatFileSize(preReadStat.size)}) exceeds the JSON Editor limit (${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)}). Aborting reload.`
                            ));
                            break;
                        }
                    } catch {
                        // stat 실패는 곧이은 readFileSync 도 실패할 것 — 같은 catch
                        // 에서 처리되므로 여기서는 별도 메시지 없이 통과.
                    }
                    try {
                        const reloadContent = fs.readFileSync(filePath, 'utf-8');
                        const parsed = JSON.parse(reloadContent);
                        const result = wrapIfArray(parsed);
                        isRootArray = result.isRootArray;
                        const reloadedStat = fs.statSync(filePath);
                        baselineMtimeMs = reloadedStat.mtimeMs;
                        baselineFileSize = reloadedStat.size;
                        currentLastWriteMtime = reloadedStat.mtimeMs;
                        currentLastWriteSize = reloadedStat.size;
                        currentIsDirty = false;
                        clearSnapshotTimer();
                        // recovery clear 시 last-received cache 도 함께 비움
                        // (자세한 사유는 case 'modified' 의 같은 라인 주석 참조).
                        currentLastReceivedSnapshot = undefined;
                        await setRecoveryEntry(context, filePath, null);
                        if (!isCurrentSession()) { break; }
                        postToWebview({ command: 'loadData', data: result.wrapped });
                    } catch (error: any) {
                        // 지연된 reject 로 여기 닿는 사이 다른 파일이 열렸을 수
                        // 있다. 아래는 전부 **전역** 상태 변경이라 그대로 두면
                        // 새 파일의 dirty/baseline 을 덮어쓴다.
                        if (!isCurrentSession()) { break; }
                        // 실패 경로에서는 fresh stat 으로 baseline 을 갱신해야 한다 —
                        // preReadStat 은 readFileSync 직전의 값이지만, 실제 실패 시점에 디스크
                        // 가 또 변했을 수 있다. fresh stat 이 실패(파일 사라짐)하면 preReadStat
                        // 으로 폴백, 그것도 없으면 baseline 갱신 없이 dirty 만 켠다.
                        let postFailStat: fs.Stats | undefined;
                        try {
                            postFailStat = fs.statSync(filePath);
                        } catch {
                            postFailStat = preReadStat;
                        }
                        handleReloadFailure(postFailStat);
                        if (error instanceof SyntaxError) {
                            vscode.window.showErrorMessage(t(
                                `JSON 파싱 실패 (${fileName}): 파일 내용이 올바른 JSON 형식이 아닙니다. ${error.message}`,
                                `Failed to parse JSON (${fileName}): file content is not valid JSON. ${error.message}`
                            ));
                        } else {
                            vscode.window.showErrorMessage(t(`파일 다시 읽기 실패 (${fileName}): ${error.message}`, `Failed to reload file (${fileName}): ${error.message}`));
                        }
                    }
                    break;
                }
            }
        }
    );

    // 외부 파일 변경 감시. 우리가 직접 쓴 변경은 mtime으로 식별해 무시한다.
    disposeFileWatcher();
    // RelativePattern 의 basename glob 은 minimatch 의 brace 확장 (`{a,b}` →
    // `a` 또는 `b`) 때문에, 파일명에 `{` `}` 가 들어 있으면 어떤 escape 도
    // 안전하게 동작하지 않는다 (예: `a{b,c}.json` 의 brace 를 character class
    // 로 escape 한 `a[{]b,c[}].json` 도 일부 minimatch 구현에서는 매치 실패).
    // 따라서 directory 의 모든 파일을 보는 `*` 패턴을 쓰고, 콜백에서 fsPath 비교로
    // target 만 골라낸다. 사이드이펙트는 같은 디렉터리의 다른 파일 변경이 콜백을
    // 깨우는 것뿐 — fsPath 비교는 O(1) 라 비용이 작다.
    //
    // 한계: minimatch 의 default `dot:false` 로 `.foo.json` 같은 dotfile 은
    // 패턴이 안 잡힐 수 있지만, JSON 편집 대상이 dotfile 인 경우는 드물고
    // 사용자가 수동 reload 로 우회 가능하다.
    const watchPattern = new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(filePath)),
        '*'
    );
    currentFileWatcher = vscode.workspace.createFileSystemWatcher(
        watchPattern,
        false,  // ignoreCreateEvents — atomic replace(temp → rename target)에서
                // delete + create 로 들어오는 외부 변경을 감지해야 stale data
                // 로 사용자가 무심코 외부 변경을 덮는 사고를 막는다.
        false,  // ignoreChangeEvents
        false   // ignoreDeleteEvents
    );
    // 파일명 normalization 으로 false positive (sibling 매치) 한 번 더 차단.
    const targetFsPath = path.normalize(filePath);
    const handleExternalChange = async (changedUri: vscode.Uri) => {
        if (currentFilePath !== filePath) { return; }
        if (path.normalize(changedUri.fsPath) !== targetFsPath) { return; }
        let changedStat: fs.Stats;
        try {
            changedStat = fs.statSync(changedUri.fsPath);
        } catch {
            return;
        }
        // JSON Editor가 방금 쓴 변경이면 무시. mtime 만으로는 mtime 보존형 외부
        // 변경 (예: `touch -r`, 일부 sync 도구) 이 self-write 로 오인되므로,
        // currentLastWriteSize 가 알려져 있고 changedStat.size 와 다르면
        // suppression 을 통과시켜 외부 변경 처리 경로로 흐르게 한다.
        if (currentLastWriteMtime !== undefined &&
            Math.abs(changedStat.mtimeMs - currentLastWriteMtime) < 1 &&
            (currentLastWriteSize === undefined || changedStat.size === currentLastWriteSize)) {
            return;
        }
        if (currentIsDirty) {
            const reloadLabel = t('다시 읽기 (변경사항 버리기)', 'Reload (discard edits)');
            const keepLabel = t('현재 편집 유지', 'Keep current edits');
            const choice = await vscode.window.showWarningMessage(
                t(
                    `${fileName} 파일이 외부에서 변경되었습니다. 다시 읽어들이면 현재 편집 내용이 손실됩니다.`,
                    `${fileName} was changed externally. Reloading will discard your current edits.`
                ),
                reloadLabel,
                keepLabel
            );
            // **모달이 떠 있는 동안 다른 파일이 열렸을 수 있다.** 그 뒤로
            // `currentIsDirty` · `currentLastReceivedSnapshot` · snapshot timer 는
            // 모두 **새 파일의 것**이므로, 옛 세션의 이 콜백이 계속 진행하면
            // 새 파일의 미저장 편집을 clean 으로 바꾸거나 recovery 를 지운다.
            // 메시지의 session 필터는 발신만 막을 뿐 이 전역 상태 변경을 막지
            // 못한다.
            if (!isCurrentSession()) { return; }
            if (choice !== reloadLabel) {
                // 사용자가 Keep을 선택했다. 디스크는 이제 새 외부 버전이지만
                // 사용자는 자기 편집을 유지하기로 했으므로 baselineMtime을 외부
                // 변경 후의 값으로 갱신해 둬야, 이후 close → reopen 시
                // shouldOfferRecovery가 stale로 폐기되지 않는다. 또한 webview가
                // 마지막으로 보낸 스냅샷이 있다면 새 mtime으로 즉시 recovery
                // 엔트리를 다시 써, 사용자가 즉시 닫는 경로에서도 편집이
                // 보존되게 한다.
                //
                // prompt 가 떠 있는 동안 파일이 한 번 더 외부에서 변경됐을 수
                // 있어, prompt 응답 직후 fresh stat 으로 mtime/size 를 다시
                // 잡는다. 그렇지 않으면 baseline/recovery 가 옛 mtime 으로
                // 남아 reopen 시 shouldOfferRecovery 가 stale 로 폐기해 사용자
                // 의 명시적 Keep 이 무시된다. fresh stat 이 실패(파일 사라짐)
                // 하면 changedStat 으로 폴백.
                let postPromptStat: fs.Stats;
                try {
                    postPromptStat = fs.statSync(filePath);
                } catch {
                    postPromptStat = changedStat;
                }
                baselineMtimeMs = postPromptStat.mtimeMs;
                baselineFileSize = postPromptStat.size;
                currentLastWriteMtime = postPromptStat.mtimeMs;
                currentLastWriteSize = postPromptStat.size;
                // webview 의 lastSavedSnapshot 도 새 디스크 content 로 갱신해야
                // dirty 비교가 디스크 reality 를 반영한다. 이걸 안 하면 사용자가
                // edit B 후 외부에서 C 로 변경 → Keep → undo 로 옛 baseline A 로
                // 돌아갈 때 webview 가 dirty=false 로 판단 → host 가 recovery 를
                // 비움 → 다음 save 가 *디스크의 외부 변경 C* 를 silent 하게 A 로
                // 덮어쓴다.
                //
                // 단, host 의 `isRootArray` 는 webview 가 들고 있는 **사용자
                // 편집본** 의 root shape 를 가리킨다 — Keep 은 user data 를
                // 안 바꾸므로 이것도 그대로 둔다. 외부 디스크가 array → object
                // 로 shape 가 바뀐 경우, 사용자가 array 형태 편집을 유지하는데
                // host 의 isRootArray 를 false 로 덮어쓰면 다음 save 에서
                // unwrapIfRootArray 가 array 를 unwrap 하지 못해 디스크에
                // `{"_rootArray":[...]}` object 로 저장된다.
                try {
                    const newDiskContent = fs.readFileSync(filePath, 'utf-8');
                    const newDiskParsed = JSON.parse(newDiskContent);
                    const newWrapped = wrapIfArray(newDiskParsed);
                    postToWebview({
                        command: 'setSavedBaseline',
                        data: newWrapped.wrapped
                    });
                } catch (e: any) {
                    // 디스크 read/parse 실패 (외부에서 invalid JSON 으로 깨졌거나
                    // 사라진 경우). 경고를 띄우되 webview 의 lastSavedSnapshot 이
                    // *옛* baseline 으로 남으면 안 된다 — 사용자가 undo / 수동
                    // revert 로 그 옛 데이터에 도달할 때 dirty 가 false 로 풀려
                    // host 가 recovery 를 비우고, 다음 save 가 invalid 디스크를
                    // silent 하게 덮어쓴다. markBaselineUnknown 으로 webview 가
                    // sentinel (빈 문자열 — JSON.stringify 결과와 절대 같지 않음)
                    // 을 baseline 으로 잡아 항상 dirty 유지. (이전에 데이터로
                    // `{}` 객체를 보냈을 때는 사용자가 실제로 빈 객체를 편집
                    // 중일 때 충돌했음.)
                    vscode.window.showWarningMessage(t(
                        `${fileName}: 현재 편집 유지 후 saved baseline 갱신 실패. 저장 전 외부 변경을 재확인해 주세요. (${e.message})`,
                        `${fileName}: failed to refresh saved baseline after Keep. Re-verify external changes before saving. (${e.message})`
                    ));
                    postToWebview({ command: 'markBaselineUnknown' });
                }
                if (currentLastReceivedSnapshot !== undefined) {
                    if (currentSnapshotTimer) {
                        clearTimeout(currentSnapshotTimer);
                        currentSnapshotTimer = undefined;
                    }
                    currentPendingSnapshot = undefined;
                    await writeSnapshotEntry(currentLastReceivedSnapshot);
                    if (!isCurrentSession()) { return; }
                }
                return;
            }
        }
        // open 경로의 size guard 와 동일하게, 외부 변경으로 파일이 10MB 초과로
        // 바뀐 경우 readFileSync 가 메모리를 크게 잡아먹지 않도록 사이즈 체크.
        // 사이즈 초과면 자동 reload 를 포기하되, parse-fail 과 동일한 정책으로
        // baseline mtime 을 갱신하고 webview 를 baseline-unknown 으로 dirty 전환
        // — 사용자가 의식적으로 save 또는 다른 결정을 내리도록.
        if (changedStat.size > JSON_EDITOR_MAX_FILE_SIZE) {
            baselineMtimeMs = changedStat.mtimeMs;
            baselineFileSize = changedStat.size;
            currentLastWriteMtime = changedStat.mtimeMs;
            currentLastWriteSize = changedStat.size;
            currentIsDirty = true;
            postToWebview({ command: 'markBaselineUnknown' });
            vscode.window.showWarningMessage(t(
                `${fileName}: 외부 변경 후 파일 크기(${formatFileSize(changedStat.size)})가 JSON Editor 처리 한도(${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)})를 초과해 자동 다시 읽기를 중단했습니다.`,
                `${fileName}: external file size (${formatFileSize(changedStat.size)}) now exceeds the JSON Editor limit (${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)}); auto-reload aborted.`
            ));
            return;
        }
        try {
            const reloadContent = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(reloadContent);
            const result = wrapIfArray(parsed);
            isRootArray = result.isRootArray;
            baselineMtimeMs = changedStat.mtimeMs;
            baselineFileSize = changedStat.size;
            currentLastWriteMtime = changedStat.mtimeMs;
            currentLastWriteSize = changedStat.size;
            currentIsDirty = false;
            clearSnapshotTimer();
            // recovery clear 시 last-received cache 도 함께 비움 (사유는
            // case 'modified' 의 같은 라인 주석 참조).
            currentLastReceivedSnapshot = undefined;
            await setRecoveryEntry(context, filePath, null);
            // recovery 정리를 기다리는 사이 다른 파일이 열렸다면 여기서 멈춘다 —
            // 아래 상태 변경과 상태바 메시지는 모두 이 파일에 대한 것이다.
            if (!isCurrentSession()) { return; }
            postToWebview({ command: 'loadData', data: result.wrapped });
            if (!currentIsDirty) {
                vscode.window.setStatusBarMessage(
                    t('JSON Editor: 외부 변경을 자동으로 다시 읽음', 'JSON Editor: auto-reloaded external change'),
                    3000
                );
            }
        } catch (e: any) {
            // 지연된 reject 로 여기 닿는 사이 다른 파일이 열렸을 수 있다.
            if (!isCurrentSession()) { return; }
            // 외부에서 디스크가 invalid JSON 등으로 깨졌다. 경고만 띄우고
            // baseline 을 옛 mtime 그대로 두면 (1) 이후 user 편집의 recovery
            // 가 옛 mtime 으로 stamp 되어, reopen 시 stat.mtimeMs (새 mtime) 와
            // 안 맞아 stale 로 폐기되고, (2) webview 의 lastSavedSnapshot 은
            // 옛 valid disk 데이터라 user 가 그것에 도달하면 dirty=false 로
            // 풀려 같은 문제가 발생한다. parse 실패도 외부 변경 버전으로
            // 인정해 mtime 을 갱신하고, webview 는 baseline-unknown 으로 dirty
            // 전환 — 사용자의 다음 save 가 invalid 디스크를 명시적으로 복구.
            baselineMtimeMs = changedStat.mtimeMs;
            baselineFileSize = changedStat.size;
            currentLastWriteMtime = changedStat.mtimeMs;
            currentLastWriteSize = changedStat.size;
            currentIsDirty = true;
            postToWebview({ command: 'markBaselineUnknown' });
            vscode.window.showWarningMessage(t(
                `외부 변경 감지 후 다시 읽기 실패 (${fileName}): ${e.message}`,
                `Failed to reload after external change (${fileName}): ${e.message}`
            ));
        }
    };
    currentFileWatcher.onDidChange(handleExternalChange);
    // atomic replace (rename(temp, target)) 또는 외부 도구가 delete + create 로
    // 갱신하는 경우, change 이벤트가 안 오고 create 만 온다. 같은 핸들러에 라우팅.
    currentFileWatcher.onDidCreate(handleExternalChange);
    currentFileWatcher.onDidDelete(() => {
        if (currentFilePath !== filePath) { return; }
        // atomic replace 의 delete + create 시퀀스에서는 곧이은 onDidCreate 가
        // 알맞은 reload prompt 를 띄운다. 여기서 곧바로 경고를 띄우면 사용자가
        // 같은 파일에 대해 두 번의 모달을 보게 되므로, 짧은 grace period 후
        // 파일이 정말로 사라졌는지 확인하고 그때만 경고한다.
        setTimeout(() => {
            if (currentFilePath !== filePath) { return; }
            try {
                fs.statSync(filePath);
                // 파일이 다시 생겨 있다 — atomic replace 였으므로 무시한다.
                return;
            } catch {
                vscode.window.showWarningMessage(t(
                    `${fileName} 파일이 삭제되었습니다. 저장하면 같은 경로에 다시 만들어집니다.`,
                    `${fileName} was deleted. Saving will recreate it at the same path.`
                ));
            }
        }, 250);
    });
    return true;
}

function generateNonce(): string {
    // CSP nonces are a security control; use a CSPRNG, not Math.random().
    return crypto.randomBytes(16).toString('base64');
}

// export 는 테스트(jsonEditorUtils.test.ts의 유니코드 round-trip 가드)용.
/**
 * Every user-facing string the JSON Editor webview renders.
 *
 * The webview is plain HTML built in the extension host, so the host resolves
 * the locale once with `t()` and injects the resolved bundle — the webview
 * script never sees a hardcoded English label. Split out (and exported) so a
 * test can assert both locales stay complete as strings are added.
 */
export function buildJsonEditorStrings(): Record<string, string> {
    return {
        save: t('저장', 'Save'),
        saveTitle: t('저장 (Ctrl+S)', 'Save (Ctrl+S)'),
        reload: t('다시 불러오기', 'Reload'),
        undo: t('실행 취소 (Ctrl+Z)', 'Undo (Ctrl+Z)'),
        redo: t('다시 실행 (Ctrl+Shift+Z / Ctrl+Y)', 'Redo (Ctrl+Shift+Z / Ctrl+Y)'),
        addRow: t('행 추가', 'Add Row'),
        modified: t('● 수정됨', '● Modified'),
        filePath: t('파일 경로', 'File path'),
        rootArrayTab: t('항목', 'Items'),
        emptyMessage: t('데이터가 없습니다. "행 추가"를 눌러 추가하세요.', 'No data. Click "Add Row" to add a row.'),
        rowNumberHeader: t('행 번호', 'Row number'),
        reorderHeader: t('순서 변경', 'Reorder'),
        actionsHeader: t('작업', 'Actions'),
        // {n} is substituted in the webview so the label names the row.
        moveRow: t('{n}번 행 이동 (Alt+위/아래)', 'Move row {n} (Alt+Up/Down)'),
        deleteRow: t('{n}번 행 삭제', 'Delete row {n}'),
        joinToString: t('배열 → 문자열 (쉼표로 연결)', 'Array → String (join with comma)'),
        splitToArray: t('문자열 → 배열 (쉼표로 분리)', 'String → Array (split by comma)'),
        toValueType: t('문자열 → 값 ({preview})', 'String → value ({preview})'),
        toStringType: t('값 → 문자열 ({preview})', 'Value → string ({preview})'),
        cellTypeChanged: t('{col} 을 {preview} 로 바꿨습니다.', 'Changed {col} to {preview}.'),
        addArrayItem: t('항목 추가', 'Add item'),
        removeArrayItem: t('{n}번째 항목 삭제', 'Remove item {n}'),
        arrayItemLabel: t('{col} {n}번째 항목', '{col} item {n}'),
        arrayItemAdded: t('항목을 추가했습니다. 총 {count}개입니다.', 'Item added. {count} total.'),
        arrayItemRemoved: t('{n}번째 항목을 삭제했습니다. {count}개 남았습니다.', 'Removed item {n}. {count} remaining.'),
        invalidJsonInCell: t('셀 [{col}]의 JSON이 올바르지 않습니다: {message}', 'Invalid JSON in cell [{col}]: {message}'),
        historyRestoreFailed: t('편집 기록 복원에 실패했습니다: {message}', 'History restore failed: {message}'),
        scriptError: t('스크립트 오류: {message} ({line}번째 줄)', 'JS Error: {message} (line {line})'),
        logicBundleMissing: t(
            '편집기 스크립트(jsonEditorWebview.js)를 불러오지 못했습니다. 확장을 다시 설치하거나 VS Code 를 재시작해 주세요.',
            'Failed to load the editor script (jsonEditorWebview.js). Try reinstalling the extension or restarting VS Code.'
        ),
        rowMoved: t('{n}번 위치로 이동했습니다.', 'Moved to position {n}.'),
    };
}

export function getWebviewContent(
    data: Record<string, unknown>,
    savedData: Record<string, unknown> | undefined,
    filePath: string,
    webview: vscode.Webview,
    /**
     * Disk 에 valid baseline 이 없는 경우 (parse fail / size exceeded / read fail
     * 후 recovery fallback) true 로 보낸다. webview 는 lastSavedSnapshot 을 빈
     * 문자열 sentinel 로 잡아 *어떤* user data 의 JSON.stringify 결과와도 같지
     * 않게 → 항상 dirty 유지. (이전에는 `{}` 객체를 sentinel 로 썼지만 사용자
     * 데이터가 우연히 `{}` 일 때 dirty=false 가 되어 충돌했다.)
     *
     * 뒤의 `sessionId` 가 필수이므로 이 자리도 생략할 수 없다 — 기본값을 두면
     * 아무도 쓸 수 없는 값이 시그니처에만 남는다.
     */
    baselineUnknown: boolean,
    /**
     * 이 webview 인스턴스의 세션 식별자. host 는 파일을 바꿔 열 때 **패널을
     * 재사용**하므로(`currentPanel.reveal`), 이전 파일의 in-flight 저장 응답이
     * 새 webview 로 배달될 수 있다. 응답에 실려 온 세션이 자기 것이 아니면
     * webview 는 그 응답을 무시한다 — 그러지 않으면 남의 저장 결과로 이 파일의
     * 미저장 편집이 clean 처리되어 조용히 사라진다.
     *
     * **기본값을 두지 않는다.** 세션 번호는 1부터 발급되므로 어떤 기본값을
     * 골라도 {@link NO_SESSION}(=0) 과 같거나 남의 세션과 겹친다. 전자는 오가는
     * 메시지를 **전부** 버리는 webview 를 만들고(귀도 입도 막힌다), 후자는 이
     * 검사가 막으려던 교차 배달을 그대로 허용한다. 빠뜨린 호출부는 컴파일러가
     * 잡게 두고, 살아 있는 세션이 아닌 값은 아래에서 거부한다.
     */
    sessionId: number,
    /**
     * `dist/jsonEditorWebview.js` 의 webview URI (`asWebviewUri` 를 거친 문자열).
     *
     * webview 스크립트가 쓰는 순수 로직의 단일 출처다 — 자세한 배경은
     * [src/webview/jsonEditorLogic.ts](./webview/jsonEditorLogic.ts) 참조.
     * 인라인 스크립트보다 **먼저** 로드되어 전역 하나를 올려 준다.
     *
     * 여기도 기본값을 두지 않는다. 이 값을 빠뜨린 webview 는 전역이 없어
     * 인라인 스크립트가 첫 줄에서 죽고 화면이 통째로 비므로, 컴파일러가 잡는
     * 편이 낫다.
     */
    logicScriptUri: string
): string {
    // 인자를 필수로 만든 것은 **생략**만 막는다. 살아 있는 세션이 없는 상태에서
    // 화면을 다시 그리는 **새 호출부**(예: dispose 뒤의 refresh)가 생기면
    // `NO_SESSION` 이 그대로 넘어오고, 그 webview 는 오가는 메시지를 전부 버린다.
    // 발급되는 번호는 언제나 1 이상이므로 그 밖의 값은 전부 거절한다 — 0 만
    // 막으면 NaN·음수처럼 똑같이 조용한 값이 남는다.
    if (!Number.isInteger(sessionId) || sessionId <= NO_SESSION) {
        throw new Error(`getWebviewContent: sessionId must be a live session id (positive integer), got ${sessionId}.`);
    }
    // sessionId 와 같은 정책을 실제로 같게 만든다. 인자를 필수로 만든 것은
    // **생략**만 막는데, 빈 문자열이 들어오면 `<script src="">` 가 되어 문서
    // 자신을 스크립트로 다시 요청하고 — 번들은 실리지 않은 채 화면만 빈다.
    if (!logicScriptUri) {
        throw new Error('getWebviewContent: logicScriptUri must be a non-empty webview URI.');
    }
    // Inject data as escaped JS literals (memoryMapViewer escapeForScript 패턴).
    // 이전의 base64 + atob() 경로는 atob()가 latin1 디코딩이라 멀티바이트 문자
    // (한글, "—", "≥" 등)가 mojibake 되고, Save 시 깨진 데이터가 그대로 디스크에
    // 기록되어 영구 손상됐다. JSON.stringify는 유니코드를 무손실 보존하며,
    // "<"를 유니코드 이스케이프(backslash-u003c)로 바꿔 "</script>" HTML 조기 종료를 막는다.
    // savedData가 주어지면(=복구 경로) webview의 saved baseline은 디스크 데이터로
    // 잡혀 modified 표시와 undo 동작이 올바르게 처리된다.
    const escapeForScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
    const jsonLiteral = escapeForScript(data);
    const strings = buildJsonEditorStrings();
    const stringsLiteral = escapeForScript(strings);
    const htmlLang = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
    // Static markup interpolates these, so escape for attribute/text context.
    const esc = (value: string) => value
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const savedLiteral = savedData !== undefined ? escapeForScript(savedData) : 'undefined';
    // src 속성 컨텍스트. asWebviewUri 결과에 따옴표가 들어갈 일은 없지만,
    // 속성으로 나가는 값은 예외 없이 이스케이프한다.
    const escapedLogicScriptUri = esc(logicScriptUri);
    const escapedPath = filePath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const nonce = generateNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;

    return /*html*/`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JSON Editor</title>
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --border: var(--vscode-panel-border, #444);
        --input-bg: var(--vscode-input-background);
        --input-fg: var(--vscode-input-foreground);
        --input-border: var(--vscode-input-border, #444);
        --btn-bg: var(--vscode-button-background);
        --btn-fg: var(--vscode-button-foreground);
        --btn-hover: var(--vscode-button-hoverBackground);
        --tab-active-bg: var(--vscode-tab-activeBackground, var(--bg));
        --tab-active-fg: var(--vscode-tab-activeForeground, var(--fg));
        --tab-inactive-bg: var(--vscode-tab-inactiveBackground, transparent);
        --tab-inactive-fg: var(--vscode-tab-inactiveForeground, #888);
        --tab-border: var(--vscode-tab-activeBorderTop, var(--btn-bg));
        --danger: var(--vscode-errorForeground, #f44);
        /* --danger 는 **전경용** 토큰이다 (다크 테마 #F48771). 그것을 버튼 배경으로
           쓰고 흰 글자를 올리면 약 2.5:1 로 WCAG 1.4.3(4.5:1) 에 못 미친다.
           배경으로 쓸 것은 배경으로 설계된 토큰에서 가져온다. */
        --danger-bg: var(--vscode-statusBarItem-errorBackground, #a1260d);
        --danger-fg: var(--vscode-statusBarItem-errorForeground, #ffffff);
        /* 최소 클릭·터치 타깃 (WCAG 2.2 SC 2.5.8 AA). 표가 답답하면 이 한 줄만
           줄이면 된다 — 아래 규칙들이 전부 이 값을 쓴다. */
        --touch-min: 24px;
        --badge-bg: var(--vscode-badge-background, #444);
        --badge-fg: var(--vscode-badge-foreground, #fff);
        --hover-bg: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--fg);
        background: var(--bg);
        padding: 12px;
    }
    .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        flex-wrap: wrap;
    }
    .toolbar .filepath {
        flex: 1;
        font-size: 11px;
        opacity: 0.6;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    button {
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        padding: 4px 12px;
        cursor: pointer;
        border-radius: 2px;
        font-size: 12px;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    button:disabled:hover { background: var(--btn-bg); }
    button.danger { background: var(--danger-bg); color: var(--danger-fg); }
    button.small {
        padding: 2px 6px;
        font-size: 11px;
        /* 글자는 작게 두되 **누를 수 있는 넓이**는 확보한다. inline-flex 로
           글리프를 가운데 두지 않으면 높이만 늘어나고 ✕ 가 위로 붙는다. */
        min-width: var(--touch-min);
        min-height: var(--touch-min);
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
        margin-bottom: 12px;
    }
    .tab {
        padding: 6px 16px;
        cursor: pointer;
        border: none;
        background: var(--tab-inactive-bg);
        color: var(--tab-inactive-fg);
        border-top: 2px solid transparent;
        font-size: 13px;
    }
    .tab.active {
        background: var(--tab-active-bg);
        color: var(--tab-active-fg);
        border-top-color: var(--tab-border);
    }
    .tab:hover:not(.active) {
        background: var(--hover-bg);
    }

    .table-wrapper {
        overflow-x: auto;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
    }
    th, td {
        border: 1px solid var(--border);
        padding: 4px 8px;
        text-align: left;
        vertical-align: top;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    th {
        background: var(--hover-bg);
        font-weight: 600;
        position: sticky;
        top: 0;
        white-space: nowrap;
    }
    th.row-num, td.row-num {
        width: 32px;
        text-align: center;
        color: var(--tab-inactive-fg);
        font-size: 11px;
    }
    td.actions-cell, th.actions-cell {
        width: 32px;
        text-align: center;
        border: none;
        padding: 4px 2px;
        overflow: visible;
        text-overflow: clip;
    }
    td.drag-handle, th.drag-handle {
        width: 28px;
        border: none;
    }
    tr:hover { background: var(--hover-bg); }

    /* Drag and drop */
    tr[draggable="true"] { cursor: grab; }
    tr[draggable="true"]:active { cursor: grabbing; }
    tr.dragging { opacity: 0.4; }
    tr.drag-over-top { border-top: 2px solid var(--btn-bg); }
    tr.drag-over-bottom { border-bottom: 2px solid var(--btn-bg); }
    td.drag-handle {
        text-align: center;
        cursor: grab;
        color: var(--tab-inactive-fg);
        font-size: 14px;
        user-select: none;
    }
    td.drag-handle:hover { color: var(--fg); }
    /* The grip is a real <button> so it can take keyboard focus (Alt+Up/Down
       reorder), but it must keep looking like the plain glyph it replaced. */
    button.drag-grip {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        font: inherit;
        cursor: grab;
    }
    /* 포커스 링은 **모든 초점 대상**에 준다. 예전에는 drag-grip 하나뿐이라,
       키보드로 표를 훑거나 ✕ / 변환 버튼을 누른 뒤 코드가 옮겨 놓은 포커스가
       어디 있는지 화면에 아무 표시도 나지 않았다.
       (마우스 클릭 뒤의 프로그램적 focus() 는 :focus-visible 에 걸리지 않는다 —
       이 규칙이 돕는 것은 키보드 경로다.) */
    button:focus-visible,
    .cell-view:focus-visible,
    [role="tab"]:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, var(--btn-bg));
        outline-offset: 1px;
    }

    /* Visible to screen readers only — column names for icon-only headers
       and the live region that announces row moves. */
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    /* Editable cell */
    .cell-view {
        cursor: pointer;
        min-height: 20px;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .cell-view:hover {
        outline: 1px solid var(--input-border);
        outline-offset: -1px;
    }
    .cell-edit {
        display: none;
        width: 100%;
    }
    .cell-edit input, .cell-edit textarea {
        width: 100%;
        background: var(--input-bg);
        color: var(--input-fg);
        border: 1px solid var(--input-border);
        padding: 2px 4px;
        font-family: inherit;
        font-size: inherit;
        resize: vertical;
    }
    .cell-edit textarea {
        min-height: 60px;
    }
    td.editing .cell-view { display: none; }
    td.editing .cell-edit { display: block; }

    /* Array tags */
    .array-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
    }
    .tag {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: var(--badge-bg);
        color: var(--badge-fg);
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 11px;
        max-width: 200px;
    }
    .tag span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .tag .remove-tag {
        cursor: pointer;
        opacity: 0.7;
        font-size: 13px;
        line-height: 1;
    }
    .tag .remove-tag:hover { opacity: 1; }

    .array-edit-area {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .array-edit-area .tag-row {
        display: flex;
        gap: 4px;
        align-items: center;
    }
    .array-edit-area input {
        flex: 1;
        background: var(--input-bg);
        color: var(--input-fg);
        border: 1px solid var(--input-border);
        padding: 2px 4px;
        font-family: inherit;
        font-size: inherit;
    }

    .convert-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: var(--touch-min);
        min-height: var(--touch-min);
        background: var(--badge-bg);
        color: var(--badge-fg);
        border: none;
        padding: 0 5px;
        border-radius: 2px;
        font-size: 10px;
        cursor: pointer;
        opacity: 0.7;
        margin-left: 4px;
        vertical-align: middle;
    }
    .convert-btn:hover { opacity: 1; background: var(--btn-bg); color: var(--btn-fg); }

    .modified-indicator {
        display: none;
        color: var(--danger);
        font-size: 11px;
        font-weight: bold;
    }
    .modified-indicator.show { display: inline; }

    .empty-msg {
        padding: 20px;
        text-align: center;
        opacity: 0.5;
    }
    .cell-object {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        opacity: 0.85;
        cursor: pointer;
    }
    .cell-edit textarea.json-edit {
        min-height: 120px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        white-space: pre;
        tab-size: 2;
    }
</style>
</head>
<body>
    <div class="toolbar">
        <button id="btnSave" title="${esc(strings.saveTitle)}">${esc(strings.save)}</button>
        <button id="btnReload">${esc(strings.reload)}</button>
        <button id="btnUndo" title="${esc(strings.undo)}" aria-label="${esc(strings.undo)}" disabled>↶</button>
        <button id="btnRedo" title="${esc(strings.redo)}" aria-label="${esc(strings.redo)}" disabled>↷</button>
        <button id="btnAddRow">+ ${esc(strings.addRow)}</button>
        <span class="modified-indicator" id="modifiedFlag" role="status" aria-live="polite">${esc(strings.modified)}</span>
        <span class="filepath" title="${escapedPath}" aria-label="${esc(strings.filePath)}: ${escapedPath}">${escapedPath}</span>
    </div>
    <div class="tabs" id="tabs" role="tablist"></div>
    <!-- 탭이 제어하는 대상. role=tabpanel이 없으면 role=tab이 가리키는 곳이
         없어, 스크린리더가 탭을 읽고도 어디로 이동했는지 알리지 못한다.
         aria-labelledby는 활성 탭을 따라 renderTabs가 갱신한다. -->
    <div class="table-wrapper" id="tableWrapper" role="tabpanel" tabindex="0"></div>
    <div id="errorMsg" role="alert" style="color:var(--danger);padding:12px;display:none;"></div>
    <div id="srStatus" class="sr-only" role="status" aria-live="polite"></div>

<!-- 순수 로직의 단일 출처. 아래 인라인 스크립트보다 **먼저** 로드되어야 한다 —
     인라인 쪽이 첫 줄에서 이 전역을 꺼내 쓴다. src/webview/jsonEditorLogic.ts 참조. -->
<script nonce="${nonce}" src="${escapedLogicScriptUri}"></script>
<script nonce="${nonce}">
(function() {
    // Locale-resolved labels injected by the host (buildJsonEditorStrings).
    // \`fmt\` fills {placeholders} so word order can differ per language.
    const S = ${stringsLiteral};
    function fmt(template, values) {
        return String(template).replace(/\\{(\\w+)\\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }
    const errorEl = document.getElementById('errorMsg');
    const srStatusEl = document.getElementById('srStatus');
    function showError(msg) {
        errorEl.style.display = 'block';
        errorEl.textContent = msg;
    }
    /** Announce a transient change (row moved, …) to screen readers only. */
    function announce(msg) {
        srStatusEl.textContent = msg;
    }
    window.onerror = function(msg, src, line, col, err) {
        showError(fmt(S.scriptError, { message: msg, line: line }));
    };

    // 번들이 올려 준 순수 로직. 예전에는 이 함수들의 사본이 이 문자열 안에 또
    // 있었고, src/jsonEditorUtils.ts 의 "미러" 와 어긋나지 않기를 주석으로만
    // 바라고 있었다. 이제 같은 것을 부른다.
    //
    // **화면에 남기고 나서 던진다.** \`<script src>\` 의 404 는 window.onerror 를
    // 발생시키지 않으므로(리소스 로드 실패는 window 로 버블링되지 않는다) 이
    // 자리가 유일한 발견 지점이다. 그냥 던지면 사용자는 툴바만 있는 빈 화면을
    // 영원히 보고, 아무 신호도 받지 못한다. showError 는 위에서 이미 준비됐다 —
    // 이 검사를 그 뒤에 두는 이유가 그것이다.
    if (typeof TaskHubJsonEditorLogic === 'undefined') {
        showError(S.logicBundleMissing);
        throw new Error('jsonEditorWebview.js did not load');
    }
    const {
        parseValue,
        coerceEditedCellValue,
        coerceEditedArrayItems,
        buildSheetMap,
        getRowsByPath,
        effectiveBaseline,
        decideSaveResult,
        buildDraftSnapshot,
        resolveActiveDraftState,
    } = TaskHubJsonEditorLogic;

    // 이 webview 인스턴스의 세션 번호. host 가 html 에 심어 준다.
    const SESSION_ID = ${sessionId};

    // **host 로 가는 모든 메시지에 세션을 붙인다.**
    //
    // host 는 파일을 바꿔 열 때 패널을 재사용하므로(같은 webview 객체에 새 html
    // 을 세팅), 옛 스크립트가 이미 보내 놓은 메시지가 새 파일의 핸들러에 도착할
    // 수 있다. 그 핸들러의 filePath 는 새 파일이므로, 예컨대 A 의 'save' 가 B 의
    // 핸들러에 닿으면 **B 파일에 A 의 데이터를 쓴다.**
    //
    // 개별 호출부에서 붙이지 않고 **API 를 감싼다** — 발신 지점이 열두 곳이라
    // 하나만 빠뜨려도 그 경로로 구멍이 남는다. 여기서는 우회할 자리가 없다.
    const vscode = (() => {
        const api = acquireVsCodeApi();
        return {
            postMessage: (message) => api.postMessage({ ...message, session: SESSION_ID }),
            getState: () => api.getState(),
            setState: (state) => api.setState(state),
        };
    })();
    let data = ${jsonLiteral};
    // host 가 disk-baseline-unknown 으로 부팅한 경우 (parse fail / size exceeded /
    // read fail 후 recovery fallback). lastSavedSnapshot 으로 빈 문자열 sentinel
    // 을 사용 — JSON.stringify 의 결과는 valid JSON 이라 절대 빈 문자열일 수
    // 없으므로, 어떤 user data 와도 같지 않아 항상 dirty 유지. (이전에 빈 객체
    // 를 sentinel 로 썼지만 사용자가 실제로 빈 객체를 편집 중일 때 dirty=false
    // 가 되어 recovery 가 비워지는 충돌이 있었다.)
    const BASELINE_UNKNOWN_SENTINEL = '';
    const baselineUnknown = ${baselineUnknown ? 'true' : 'false'};
    // 복구 경로에서 host가 디스크 데이터를 별도로 함께 보내면 그것을
    // saved baseline으로 사용한다. 복구가 아니면 빈 문자열 → 초기 데이터
    // 자체가 baseline이라는 신호.
    let savedSnapshot;
    const savedInit = ${savedLiteral};
    if (savedInit !== undefined) {
        savedSnapshot = JSON.stringify(savedInit);
    }
    // baselineUnknown 이 true 면 위 savedSnapshot 결정을 override 하고 sentinel 로
    // 잡는다. resetHistoryToCurrent 가 lastSavedSnapshot 을 sentinel 로 세팅 →
    // 어떤 data 도 sentinel 과 같지 않아 dirty=true 로 시작.
    if (baselineUnknown) {
        savedSnapshot = BASELINE_UNKNOWN_SENTINEL;
    }
    let sheetMap = [];
    let activeIdx = 0;
    let modified = false;

    // Undo/Redo 스냅샷 스택. 각 항목은 JSON.stringify(data) 결과 문자열.
    // - cap: 20 step / 16 MB 중 먼저 도달하는 쪽에서 가장 오래된 항목부터 evict
    // - 푸시 시점: cell commit 성공, addRow, deleteRow, drag drop, convert,
    //   array tag 추가/삭제 — 즉 사용자가 인지하는 한 번의 편집 단위마다 1개
    // - 편집 중 셀이 있을 때(td.editing 존재) Ctrl+Z/Y는 동작하지 않음:
    //   브라우저 기본 input undo가 우선
    const HISTORY_MAX_STEPS = 20;
    const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
    let historyStack = [];
    let historyIndex = -1;
    let lastSavedSnapshot = null;

    // In-flight 저장 요청: seq → 그 요청이 host 로 보낸 스냅샷 문자열.
    // host 의 saveResult 가 같은 seq 를 되돌려 주므로, 응답이 오는 사이에 편집이
    // 있었더라도 **디스크에 실제로 들어간 것**을 saved baseline 으로 잡을 수 있다.
    let saveSeq = 0;
    const pendingSaveSnapshots = new Map();
    const MAX_PENDING_SAVES = 8;

    // 활성 셀에서 **마지막으로 JSON 으로 표현 가능했던** draft.
    //
    // json-edit textarea 는 타이핑 도중 반드시 invalid 상태를 지난다
    // ({"a":1} → {"a":1 → {"a":12}). 그 순간 저장 응답이나 baseline 교체가
    // 도착하면 recovery 에 넣을 draft 를 만들 수 없는데, 그렇다고 커밋된 data 를
    // 보내면 **직전 keystroke 가 남긴 valid draft 를 옛 내용으로 덮는다**.
    // 마지막 valid draft 를 여기 들고 있다가 그때 대신 보낸다.
    //
    // 수명: 입력이 valid draft 를 만들 때 갱신, baseline 으로 되돌아오면(clean)
    // 해제, 표를 다시 그릴 때(commit / cancel / reload / 행 변경 = 그 셀의
    // 편집 맥락이 사라지는 모든 경로) 해제 — renderTable 한 곳에서 처리한다.
    let lastRecoverableDraft;

    function snapshotData() { return JSON.stringify(data); }

    /**
     * dirty 판정의 기준이 되는 "디스크에 있을 내용".
     *
     * 저장 응답을 기다리는 동안 디스크에 들어가는 것은 **가장 최근 저장 요청이
     * 보낸 스냅샷**이지 lastSavedSnapshot 이 아니다. 그것과 비교하면, 저장 직후
     * 옛 내용으로 undo 했을 때 "변경 없음" 이라는 잘못된 판정이 나온다 — 그러면
     * dirty 도 안 켜지고 recovery 스냅샷도 보내지 않아, host 가 저장과 함께 지운
     * recovery 가 빈 채로 남는다. 그 상태에서 패널을 닫으면 undo 결과를 되살릴
     * 방법이 없다.
     *
     * Map 은 삽입 순서를 지키므로 마지막 값이 가장 최근 요청이다.
     */

    // 번들의 effectiveBaseline 을 이 webview 의 현재 상태로 부르는 래퍼.
    // 이름을 달리 두는 이유는 둘이 다른 것이기 때문이다 — 이쪽은 인자가 없고
    // 전역(pendingSaveSnapshots · lastSavedSnapshot)을 읽는다.
    function currentBaseline() {
        return effectiveBaseline(pendingSaveSnapshots, lastSavedSnapshot);
    }

    function evictHistoryToCap() {
        let totalBytes = 0;
        for (const s of historyStack) { totalBytes += s.length; }
        while ((historyStack.length > HISTORY_MAX_STEPS || totalBytes > HISTORY_MAX_BYTES) &&
               historyStack.length > 1) {
            const dropped = historyStack.shift();
            totalBytes -= dropped.length;
            historyIndex--;
        }
    }

    function pushHistory() {
        const snap = snapshotData();
        // redo 분기 폐기
        if (historyIndex < historyStack.length - 1) {
            historyStack = historyStack.slice(0, historyIndex + 1);
        }
        historyStack.push(snap);
        historyIndex = historyStack.length - 1;
        evictHistoryToCap();
        updateUndoRedoButtons();
        // 데이터가 saved baseline과 동일해지면 dirty 해제(수동 revert: foo→bar→foo
        // 같은 케이스). dirty가 풀렸을 때는 snapshot을 보내지 않아 host가 비운
        // recovery 엔트리를 곧바로 clean 데이터로 다시 쓰는 것을 막는다. dirty와
        // snapshot 송신은 이 한 곳에서 결정되며, 개별 mutation 핸들러는
        // setModified를 직접 호출하지 않는다.
        const dirtyNow = snap !== currentBaseline();
        setModified(dirtyNow);
        if (dirtyNow) {
            vscode.postMessage({ command: 'snapshot', data: data });
        }
    }

    /**
     * 초기 boot 또는 loadData(reload/외부 변경) 직후 history를 현재 데이터를
     * 기준으로 새로 시작한다. host가 별도로 'savedSnapshot'(디스크 데이터)을
     * 같이 보낸 경우(=복구 경로) 그것을 saved baseline으로 잡아 modified 표시와
     * undo 비교가 올바르게 동작한다. 그 외에는 현재 데이터 = 디스크 데이터로
     * 간주.
     */
    function resetHistoryToCurrent() {
        const current = snapshotData();
        historyStack = [current];
        historyIndex = 0;
        lastSavedSnapshot = savedSnapshot !== undefined ? savedSnapshot : current;
        const dirtyNow = current !== lastSavedSnapshot;
        setModified(dirtyNow);
        updateUndoRedoButtons();
        if (dirtyNow) {
            // 복구 데이터로 boot한 경우 host 쪽 recovery entry를 그대로 유지
            // 하면서 mtime/data를 최신화하기 위해 한 번 보낸다.
            vscode.postMessage({ command: 'snapshot', data: data });
        }
    }

    function updateUndoRedoButtons() {
        const undoBtn = document.getElementById('btnUndo');
        const redoBtn = document.getElementById('btnRedo');
        if (undoBtn) { undoBtn.disabled = historyIndex <= 0; }
        if (redoBtn) { redoBtn.disabled = historyIndex >= historyStack.length - 1; }
    }

    function restoreFromHistoryIndex(idx) {
        if (idx < 0 || idx >= historyStack.length) { return; }
        try {
            data = JSON.parse(historyStack[idx]);
        } catch (e) {
            showError(fmt(S.historyRestoreFailed, { message: e.message }));
            return;
        }
        historyIndex = idx;
        rebuildSheetMap();
        if (activeIdx >= sheetMap.length) { activeIdx = 0; }
        renderTabs();
        renderTable();
        const dirtyNow = historyStack[idx] !== currentBaseline();
        setModified(dirtyNow);
        updateUndoRedoButtons();
        // saved 상태로 undo 한 경우 host가 modified=false 처리에서 recovery
        // 엔트리를 이미 비웠으므로 clean snapshot을 다시 보내면 안 된다(그러면
        // host가 즉시 clean 상태를 recovery로 쓰게 되어 다음 reopen에서
        // 의미 없는 복구 프롬프트가 뜬다).
        if (dirtyNow) {
            vscode.postMessage({ command: 'snapshot', data: data });
        }
    }

    // 툴바 ↶ / ↷.
    //
    // 편집 중인 셀이 있으면 **먼저 commit 한다.** 예전에는 그냥 return 했는데,
    // 배열 태그의 ✕ / + 는 셀을 편집 상태로 남기므로(그래야 연속으로 지울 수
    // 있다) 그 직후의 undo 가 조용히 아무것도 하지 않았다 — updateUndoRedoButtons
    // 는 historyIndex 만 보므로 버튼은 **활성인 채로** 눌리기만 하고, 방금 지운
    // 태그는 돌아오지 않는다. 되돌릴 수 없는 삭제 옆에서 특히 나쁘다.
    //
    // 키보드 Ctrl+Z 는 여기 오기 전에 자기 가드로 걸러진다 — 입력 중인 셀에서는
    // 브라우저 input 의 기본 undo 에 양보한다는 별도의 의도이므로 그대로 둔다.
    function undo() {
        if (!commitActiveCellOrAbort()) { return; }
        if (historyIndex <= 0) { return; }
        restoreFromHistoryIndex(historyIndex - 1);
    }

    function redo() {
        if (!commitActiveCellOrAbort()) { return; }
        if (historyIndex >= historyStack.length - 1) { return; }
        restoreFromHistoryIndex(historyIndex + 1);
    }

    // 행 인덱스를 변경시키는 mutation(행 삭제, 드래그 정렬, 행 추가) 직전에
    // 호출한다. 활성 편집 셀이 있으면 commit을 시도하고, invalid JSON 등으로
    // commit이 거부되면 false를 돌려 호출자가 mutation을 중단하게 한다.
    //
    // 이 가드가 없으면: blur 100ms timeout이 commit을 지연 실행하는 동안 사용자가
    // 다른 행을 삭제/드래그하면, 지연 commit이 stale td.dataset.row 로 새로
    // 정렬된 배열의 엉뚱한 행에 값을 쓰거나, 인덱스가 새 길이를 넘어
    // undefined 접근으로 터질 수 있다.
    function commitActiveCellOrAbort() {
        const editingTd = document.querySelector('td.editing');
        if (!editingTd) { return true; }
        return commitCell(editingTd);
    }

    // primitive array 셀에서 편집 중인 input[data-arr-idx] 값을 data 의 같은
    // arr 자리(in-place)에 반영해, 후속 mutation(태그 추가/삭제) 직전에 사용자가
    // 마지막으로 입력한 값이 유실되지 않도록 한다. arr 참조 자체는 보존하므로
    // getActiveRows()[rowIdx][col] 가 그대로 가리키고, 이후 splice/push 가 옳게
    // 동작한다. inputs 가 0 개면 (편집 중이 아닌 경우) 직접 arr 만 돌려준다.
    function syncEditingArrayCellToData(td) {
        if (!td) { return null; }
        const rowIdx = parseInt(td.dataset.row);
        const col = td.dataset.col;
        // 시트·행이 어긋나면 읽지 않는다. getActiveRows() 는 활성 시트가 없으면
        // null 을 돌려주고, 지연 commit 처럼 stale 한 dataset.row 는 새 길이를
        // 넘을 수 있다 — 그냥 읽으면 TypeError 로 스크립트 전체가 죽는다.
        //
        // 이 함수부터 막는 이유는 **이미 null 계약이 있어서**다: 두 호출부가
        // 돌려받은 값을 검사하고 있고, host 미러인 buildDraftSnapshot 도 같은
        // 어긋남을 skip 한다. 계약이 있는데 여기서만 지키지 않던 자리였다.
        // (data-convert · data-delete-row · commitCell 등 다른 getActiveRows()
        // 호출부에는 아직 이 가드가 없다. 그쪽은 돌려줄 계약이 없어 같은 방식으로
        // 고칠 수 없다 — 필요해지면 별도로 다룬다.)
        const rows = getActiveRows();
        if (!rows || !rows[rowIdx]) { return null; }
        const arr = rows[rowIdx][col];
        if (!Array.isArray(arr)) { return null; }
        const inputs = td.querySelectorAll('.cell-edit input[data-arr-idx]');
        if (inputs.length > 0) {
            const raws = [];
            inputs.forEach(input => { raws.push(input.value); });
            // 타입 보존은 **arr 를 비우기 전에** 계산해야 한다 (옛 항목이 기준).
            const newArr = coerceEditedArrayItems(raws, arr);
            arr.length = 0;
            for (const v of newArr) { arr.push(v); }
        }
        return arr;
    }

    // renderTable() 은 wrapper.innerHTML 을 통째로 갈아치우므로, 배열 항목을
    // 더하거나 지운 직후의 td 는 이미 DOM 에서 사라진 것이다. 같은 셀을 새 표
    // 에서 다시 찾는다.
    //
    // **셀렉터 문자열에 col 을 이어 붙이지 않는다.** 마크업은 escapeAttr 로
    // 쓰지만 브라우저가 &quot; 를 되돌려 놓으므로 dataset.col 에는 **진짜
    // 따옴표**가 들어 있을 수 있다(JSON 키에 따옴표가 있는 경우). 그대로 이어
    // 붙이면 querySelector 가 문법 오류로 던져 **그 클릭 핸들러가 거기서
    // 멈춘다** — 항목은 늘어나 있는데 포커스는 가지 않고 오류 배너만 뜬다.
    // 역슬래시는 던지지도 않는다: CSS 가 이스케이프 시작으로 읽어 조용히 다른
    // 값을 찾는다. rowIdx 는 숫자라 안전하니 행으로만 좁히고 col 은 값 비교로
    // 고른다 — CSS 이스케이프 규칙을 escapeAttr 과 따로 맞출 필요가 없어진다.
    function findCellByCol(rowIdx, col) {
        const cells = document.querySelectorAll('td[data-row="' + rowIdx + '"]');
        for (const cell of cells) {
            if (cell.dataset.col === col) { return cell; }
        }
        return null;
    }

    // 배열 항목을 더하거나 지운 뒤, 다시 그린 셀을 편집 상태로 되돌리고
    // itemSelector 가 가리키는 것들 중 idx 번째에 포커스를 준다. 이게 없으면
    // ✕ 를 누를 때마다 셀이 view 모드로 접히고 포커스가 body 로 떨어져, 태그
    // 세 개를 지우려면 셀을 세 번 다시 열어야 한다.
    //
    // **두 호출부가 서로 다른 것을 가리킨다.**
    //   + : 새로 생긴 빈 input. 방금 만든 칸에 바로 입력하는 것이 의도다.
    //   ✕ : 지운 자리로 올라온 항목의 **✕ 버튼**. input 에 포커스를 주면
    //       "버튼을 Enter 로 눌렀는데 텍스트 필드에 와 있는" 모드 전환이 되어,
    //       이어서 누르는 Enter 가 commitCell 로 가 셀이 접히고 포커스가 body
    //       로 떨어진다 — 이 함수가 없애려던 바로 그 상태다. 버튼에 두면
    //       Enter 를 계속 눌러 연속으로 지울 수 있다.
    function refocusArrayCell(rowIdx, col, idx, itemSelector) {
        const td = findCellByCol(rowIdx, col);
        if (!td) { return; }
        td.classList.add('editing');
        const items = td.querySelectorAll(itemSelector);
        if (items.length) {
            // 마지막 항목을 지웠으면 그 앞 칸으로 물러난다.
            items[Math.min(idx, items.length - 1)].focus();
            return;
        }
        // 항목이 하나도 남지 않으면 포커스를 줄 것이 없다. 편집 상태는 유지해
        // "+" 가 보이게 하고, 포커스를 그 버튼으로 넘긴다 — 그러지 않으면
        // 마지막 태그를 지운 순간 포커스가 body 로 떨어진다.
        const add = td.querySelector('[data-add-arr]');
        if (add) { add.focus(); }
    }

    // coerceEditedCellValue / coerceEditedArrayItems 는 번들에서 온다. 규칙만
    // 여기 적어 둔다 (구현과 단위테스트는 src/jsonEditorUtils.ts).
    //
    // 배열 셀은 항목마다 text input 을 그리므로 값이 전부 string 으로 돌아온다.
    // 그대로 모으면 [1, true, null] 이 담긴 셀을 열었다 나가기만 해도
    // ["1","true","null"] 이 된다 — 값을 바꾸지 않아도 그렇다. scalar 셀이
    // 이미 쓰는 규칙(옛 값이 string 이면 raw 유지, 아니면 parseValue)을 항목
    // 단위로 그대로 적용한다.

    // 빈 슬롯에는 보존할 타입이 없다. "+" 버튼이 새 항목을 '' 로 데이터에 밀어
    // 넣고 다시 그리므로, 그것을 문자열 항목으로 보면 숫자 배열에 항목 하나를
    // 더한 것만으로 [1, 2, "3"] 같은 혼합 배열이 디스크에 기록된다.

    // 번들의 buildSheetMap(data) 은 배열을 돌려준다. 이 래퍼가 전역에 꽂는다.
    function rebuildSheetMap() {
        sheetMap = buildSheetMap(data);
    }
    rebuildSheetMap();

    // 활성 시트의 행 배열. 시트가 없으면 null 이고, 경로가 배열에 닿지 못해도
    // null 이다 — 예전에는 경로를 검사 없이 따라가 **배열이 아닌 것도 그대로**
    // 돌려줬다. 그 경우가 특히 나빴던 것은 조용했기 때문이다: 종단이 문자열이면
    // \`"abc"[0][col]\` 이 undefined 로 읽히고 대입은 아무 일도 하지 않는다.
    // 이제는 이미 문서화돼 있던 null 계약과 같은 모양으로 실패한다.
    function getActiveRows() {
        const entry = sheetMap[activeIdx];
        if (!entry) { return null; }
        return getRowsByPath(data, entry.path);
    }

    function setModified(val) {
        const next = Boolean(val);
        if (modified !== next) {
            modified = next;
            vscode.postMessage({ command: 'modified', value: next });
        }
        document.getElementById('modifiedFlag').classList.toggle('show', next);
    }

    // decideSaveResult 자체는 번들에서 온다 (구현·단위테스트는
    // src/jsonEditorUtils.ts). 아래 주석은 그 판정이 지키는 invariant 다.
    //
    // 두 가지 invariant:
    //   1) 세션 귀속: host 는 파일을 바꿔 열 때 패널을 재사용하므로, 이전
    //      파일의 in-flight 저장 응답이 이 webview 로 배달될 수 있다. 세션이
    //      다르면 이 파일에 대해 아무것도 말해 주지 않는 메시지이므로 무시한다.
    //      그러지 않으면 남의 저장 결과로 이 파일의 미저장 편집이 clean 처리된다.
    //   2) 모르면 **무조건 dirty**: seq 를 못 찾으면 디스크에 어떤 스냅샷이
    //      들어갔는지 알 수 없다. 기존 baseline 과 비교하는 것으로는 부족하다 —
    //      사용자가 옛 baseline 으로 undo 해 두었다면 화면과 baseline 은 같지만
    //      디스크에는 그 사이의 다른 스냅샷이 들어가 있다.

    // host 에 알리지 않고 로컬 표시만 갱신한다. 저장 응답 처리에서 쓴다 —
    // 그쪽은 dirty 를 saveAck 에 실어 원자적으로 넘기므로, 여기서 따로 보내면
    // 순서가 어긋나 (아직 ack 대기 중이라) 버려진다.
    //
    // (예전에는 여기서 modified 를 항상 보내는 syncModifiedToHost 를 함께
    // 썼다. host 가 ack 대기 중에는 그 clean 선언을 버리므로 정상 저장인데도
    // dirty 가 남았고, 지금은 saveAck 하나가 그 역할을 다한다.)
    function setModifiedLocal(val) {
        const next = Boolean(val);
        modified = next;
        document.getElementById('modifiedFlag').classList.toggle('show', next);
    }

    function renderTabs() {
        const tabsEl = document.getElementById('tabs');
        tabsEl.innerHTML = '';
        // Hide tabs if there's only one sheet (e.g., root array)
        if (sheetMap.length <= 1) {
            tabsEl.style.display = 'none';
        } else {
            tabsEl.style.display = '';
        }
        sheetMap.forEach((entry, idx) => {
            const tab = document.createElement('div');
            tab.className = 'tab' + (idx === activeIdx ? ' active' : '');
            tab.textContent = entry.label === '_rootArray' ? S.rootArrayTab : entry.label;
            tab.id = 'sheet-tab-' + idx;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', idx === activeIdx ? 'true' : 'false');
            // 탭이 무엇을 제어하는지 연결한다. role=tab만 붙이고 대상을 알리지
            // 않으면 스크린리더가 "탭 1/N"까지만 읽고 그게 어느 영역을 바꾸는지
            // 전달하지 못한다.
            tab.setAttribute('aria-controls', 'tableWrapper');
            // Roving tabindex: 활성 탭 하나만 Tab 순서에 둔다. ARIA tablist는
            // "Tab으로 묶음에 진입, 화살표로 그 안을 이동"이 규약인데, 0.6.19는
            // 모든 탭에 tabIndex=0을 줘 화살표 이동 없이 Tab만 반복하게 했다 —
            // 스크린리더가 안내하는 조작법과 실제 동작이 어긋난 상태였다.
            tab.tabIndex = idx === activeIdx ? 0 : -1;
            tab.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    tab.click();
                    return;
                }
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (step === 0) { return; }
                e.preventDefault();
                // 양끝에서 순환한다 (WAI-ARIA tablist 권장 동작).
                //
                // click만 부른다 — 미리 focus()하지 않는다. 전환이 성공하면
                // onclick 끝의 포커스 복원이 새 활성 탭을 잡고, 셀 commit
                // 거부로 전환이 무산되면 포커스는 지금 탭에 그대로 남는다.
                // 예전처럼 focus 후 click하면 성공 시 renderTabs가 그 노드를
                // detach해 포커스가 body로 떨어졌고, 이후 화살표가 죽었다.
                const next = (idx + step + sheetMap.length) % sheetMap.length;
                const nextTab = tabsEl.children[next];
                if (nextTab) { nextTab.click(); }
            });
            tab.onclick = () => {
                // 탭 전환은 즉시 renderTable로 DOM을 갈아치워 활성 셀의 td를
                // detach시킨다. 가드 없이 들어가면 blur 100ms timeout이
                // isConnected에 막혀 commit이 스킵돼 입력이 유실된다.
                if (!commitActiveCellOrAbort()) { return; }
                activeIdx = idx;
                renderTabs();
                renderTable();
                // renderTabs가 탭 노드를 전부 새로 만들므로, 방금까지 포커스를
                // 갖고 있던 노드는 detach되고 포커스가 body로 떨어진다. 그
                // 상태에서는 화살표 키가 어디에도 닿지 않아 — roving tabindex
                // 라 Tab으로도 비활성 탭엔 못 간다 — 한 번 이동한 뒤 키보드
                // 탐색이 통째로 죽는다. 포커스가 실제로 떨어졌을 때만 새 활성
                // 탭으로 되돌린다 (셀 편집 중 마우스 클릭까지 뺏지 않도록).
                if (document.activeElement === document.body) {
                    const renewed = tabsEl.children[activeIdx];
                    if (renewed) { renewed.focus(); }
                }
            };
            tabsEl.appendChild(tab);
        });
        // 패널이 어느 탭에 속하는지 알린다. 활성 탭이 바뀔 때마다 갱신해야
        // 스크린리더가 읽는 패널 이름이 실제 내용과 어긋나지 않는다.
        const panel = document.getElementById('tableWrapper');
        if (panel) {
            if (sheetMap.length > 1) {
                panel.setAttribute('aria-labelledby', 'sheet-tab-' + activeIdx);
            } else {
                // 탭 줄이 숨겨져 있으면 가리킬 대상이 없다. 끊긴 참조를 남기면
                // 스크린리더가 이름 없는 패널로 읽는다.
                panel.removeAttribute('aria-labelledby');
            }
        }
    }

    function getDisplayValue(val) {
        if (val === null || val === undefined) { return ''; }
        if (Array.isArray(val)) { return val; }
        return String(val);
    }

    function detectMultiline(val) {
        return typeof val === 'string' && val.includes('\\n');
    }

    function renderTable() {
        // 표를 다시 그리면 편집 중이던 td 가 사라진다 (commit / cancel / reload /
        // 행 추가·삭제·정렬 / 탭 전환). 그 셀의 미커밋 입력은 이미 data 에
        // 들어갔거나 사용자가 버린 것이므로, 캐시해 둔 draft 도 함께 버린다 —
        // 남겨 두면 나중에 **다른 셀**의 invalid 입력에 옛 draft 가 recovery 로
        // 나갈 수 있다.
        lastRecoverableDraft = undefined;
        const wrapper = document.getElementById('tableWrapper');
        const rows = getActiveRows();
        if (!rows || !Array.isArray(rows) || rows.length === 0) {
            wrapper.innerHTML = '<div class="empty-msg">' + escapeHtml(S.emptyMessage) + '</div>';
            return;
        }

        const columns = [];
        const seen = new Set();
        rows.forEach(row => {
            Object.keys(row).forEach(k => {
                if (!seen.has(k)) { seen.add(k); columns.push(k); }
            });
        });

        let html = '<table><thead><tr>';
        html += '<th class="drag-handle" scope="col"><span class="sr-only">' + escapeHtml(S.reorderHeader) + '</span></th>';
        html += '<th class="row-num" scope="col"><span class="sr-only">' + escapeHtml(S.rowNumberHeader) + '</span>#</th>';
        columns.forEach(col => { html += '<th scope="col">' + escapeHtml(col) + '</th>'; });
        html += '<th class="actions-cell" scope="col"><span class="sr-only">' + escapeHtml(S.actionsHeader) + '</span></th>';
        html += '</tr></thead><tbody>';

        rows.forEach((row, rowIdx) => {
            const rowLabel = fmt(S.moveRow, { n: rowIdx + 1 });
            html += '<tr draggable="true" data-drag-row="' + rowIdx + '">';
            // The handle is a real button so the reorder affordance is
            // reachable by keyboard (Alt+Up/Down) — dragging was mouse-only.
            // draggable="true" on the button keeps the pointer path intact:
            // browsers don't start an ancestor's drag from an interactive
            // control, and dragstart bubbles up to the row's handler.
            html += '<td class="drag-handle"><button type="button" class="drag-grip" draggable="true" data-move-row="' + rowIdx
                + '" title="' + escapeAttr(rowLabel) + '" aria-label="' + escapeAttr(rowLabel) + '">⠿</button></td>';
            html += '<td class="row-num">' + (rowIdx + 1) + '</td>';
            columns.forEach((col, colIdx) => {
                const val = row[col];
                const isArray = Array.isArray(val);
                const isMultiline = detectMultiline(val);
                html += '<td data-row="' + rowIdx + '" data-col="' + escapeAttr(col) + '">';
                html += renderCellView(val, isArray, isMultiline);
                html += renderCellEdit(val, isArray, isMultiline, rowIdx, col);
                html += '</td>';
            });
            const deleteLabel = fmt(S.deleteRow, { n: rowIdx + 1 });
            html += '<td class="actions-cell"><button class="small danger" data-delete-row="' + rowIdx
                + '" title="' + escapeAttr(deleteLabel) + '" aria-label="' + escapeAttr(deleteLabel) + '">✕</button></td>';
            html += '</tr>';
        });

        html += '</tbody></table>';
        wrapper.innerHTML = html;
        attachCellEvents();
    }

    // scalar 셀의 타입을 사용자가 **의도적으로** 바꿀 수 있게 한다.
    //
    // 편집만으로는 빠져나올 수 없는 자리가 있었다: 숫자 칸에 문자열을 한 번
    // 넣으면 그 셀은 문자열이 되고, 이후 "옛 값이 문자열이면 raw 유지" 규칙
    // (coerceEditedCellValue) 때문에 숫자를 입력해도 계속 문자열로 남는다.
    // 그 규칙 자체는 "00123" · "true" 같은 값을 지키려는 것이라 옳지만, 한 번
    // 문자열이 된 칸을 숫자로 되돌릴 문이 아예 없었다 — 파일을 직접 고치는 수밖에.
    //
    // 바꿀 것이 없으면 null. 변환 결과가 null 일 수 있으므로 { value } 로 감싼다.
    function retypedScalar(val) {
        // null 도 문자열로 되돌릴 수 있어야 한다. 그러지 않으면 "null" → null 이
        // **또 하나의 일방통행**이 된다 — 이 기능이 없애려던 바로 그것이다.
        if (typeof val === 'number' || typeof val === 'boolean' || val === null) {
            return { value: String(val) };
        }
        if (typeof val === 'string') {
            const parsed = parseValue(val);
            // 'abc' 처럼 되돌려도 그대로인 값에는 버튼을 내지 않는다.
            // ('' 도 parseValue 가 '' 를 돌려주므로 여기서 함께 걸러진다.)
            if (typeof parsed === 'string') { return null; }
            // **2^53 을 넘는 정수는 바꾸지 않는다.** double 을 거치면서 값이
            // 조용히 달라진다 — "0xFFFFFFFFFFFFFFFF" 는 18446744073709551615 가
            // 아니라 …552000 이 된다. 이 확장의 영역이 임베디드라 64비트 마스크·
            // 주소가 실제로 이런 모양이고, tooltip 에 미리 보여 준다 해도 20자리
            // 중 끝 네 자리가 다른 것을 사람이 눈으로 걸러 내지는 못한다.
            // 저장하고 나면 원래 문자열은 사라진다.
            if (typeof parsed === 'number' && Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
                return null;
            }
            return { value: parsed };
        }
        return null;
    }

    function isPlainObject(val) {
        return val !== null && typeof val === 'object' && !Array.isArray(val);
    }

    function hasOnlyPrimitives(arr) {
        return arr.every(item => !isPlainObject(item) && !Array.isArray(item));
    }

    function summarizeObject(val) {
        const keys = Object.keys(val);
        if (keys.length === 0) { return '{ }'; }
        const parts = keys.slice(0, 3).map(k => k);
        return '{ ' + parts.join(', ') + (keys.length > 3 ? ', ...' : '') + ' }';
    }

    function renderCellView(val, isArray, isMultiline) {
        if (isPlainObject(val)) {
            const json = JSON.stringify(val, null, 2);
            return '<div class="cell-view cell-object" title="' + escapeAttr(json) + '">' + escapeHtml(summarizeObject(val)) + '</div>';
        }
        if (isArray) {
            const isPrimArr = hasOnlyPrimitives(val);
            let html = '<div class="cell-view"><div class="array-tags">';
            val.forEach(item => {
                if (isPlainObject(item)) {
                    html += '<span class="tag"><span>' + escapeHtml(summarizeObject(item)) + '</span></span>';
                } else {
                    html += '<span class="tag"><span>' + escapeHtml(String(item)) + '</span></span>';
                }
            });
            if (isPrimArr) {
                html += '<button class="convert-btn" data-convert="join" title="' + escapeAttr(S.joinToString)
                    + '" aria-label="' + escapeAttr(S.joinToString) + '">a→s</button>';
            }
            html += '</div></div>';
            return html;
        }
        let html = '<div class="cell-view">' + escapeHtml(String(val ?? ''));
        if (typeof val === 'string' && val.includes(',')) {
            html += '<button class="convert-btn" data-convert="split" title="' + escapeAttr(S.splitToArray)
                + '" aria-label="' + escapeAttr(S.splitToArray) + '">s→a</button>';
        }
        const retyped = retypedScalar(val);
        if (retyped) {
            // **결과를 미리 보여 준다.** "0x40013800" 은 숫자로도 읽히므로
            // (1073821696), 무엇이 될지 보이지 않으면 누르기 전에 알 수 없다.
            const toText = typeof val !== 'string';
            const title = fmt(toText ? S.toStringType : S.toValueType, { preview: JSON.stringify(retyped.value) });
            html += '<button class="convert-btn" data-convert="retype" title="' + escapeAttr(title)
                + '" aria-label="' + escapeAttr(title) + '">' + (toText ? '#→s' : 's→#') + '</button>';
        }
        html += '</div>';
        return html;
    }

    function renderCellEdit(val, isArray, isMultiline, rowIdx, col) {
        if (isPlainObject(val)) {
            return '<div class="cell-edit"><textarea class="json-edit">' + escapeHtml(JSON.stringify(val, null, 2)) + '</textarea></div>';
        }
        if (isArray) {
            if (!hasOnlyPrimitives(val)) {
                return '<div class="cell-edit"><textarea class="json-edit">' + escapeHtml(JSON.stringify(val, null, 2)) + '</textarea></div>';
            }
            let html = '<div class="cell-edit"><div class="array-edit-area">';
            val.forEach((item, i) => {
                html += '<div class="tag-row">';
                // 이름 없는 input 이었다. ✕ / + 는 이 칸으로 포커스를 옮기는
                // 것으로 결과를 알리는데, 이름이 없으면 스크린리더는 옆 항목의
                // 값만 읽어 줘 무슨 일이 일어났는지 알 수 없다.
                html += '<input type="text" value="' + escapeAttr(String(item))
                    + '" data-arr-idx="' + i + '" aria-label="'
                    + escapeAttr(fmt(S.arrayItemLabel, { col: col, n: i + 1 })) + '">';
                const removeLabel = fmt(S.removeArrayItem, { n: i + 1 });
                html += '<button class="small danger" data-remove-arr="' + i
                    + '" title="' + escapeAttr(removeLabel) + '" aria-label="' + escapeAttr(removeLabel) + '">✕</button>';
                html += '</div>';
            });
            html += '<button class="small" data-add-arr="true" aria-label="' + escapeAttr(S.addArrayItem) + '">+ '
                + escapeHtml(S.addArrayItem) + '</button>';
            html += '</div></div>';
            return html;
        }
        if (isMultiline) {
            return '<div class="cell-edit"><textarea>' + escapeHtml(String(val)) + '</textarea></div>';
        }
        return '<div class="cell-edit"><input type="text" value="' + escapeAttr(String(val ?? '')) + '"></div>';
    }

    // buildDraftSnapshot 은 번들에서 온다 (구현·단위테스트는
    // src/jsonEditorUtils.ts). 활성 셀의 미커밋 입력을 반영한 draft 를 만들고,
    // baseline 과 같으면 clean, 표현할 수 없으면 skip 을 돌려준다.

    // 활성 셀의 input/textarea 입력 이벤트 핸들러가 호출.
    //
    // - snapshot 결과: host 가 in-flight 미커밋 입력을 인지하도록 setModified(true)
    //   를 먼저 호출 (host 의 currentIsDirty 가 true 가 되어야 외부 파일 변경
    //   watcher 가 자동 reload 로 미커밋 입력을 폐기하지 않고 모달을 띄운다).
    //   그 다음 host 의 workspaceState recovery 엔트리를 snapshot 으로 갱신.
    // - clean 결과: 사용자가 입력값을 saved baseline 으로 되돌렸다는 뜻 →
    //   setModified(false) 로 host 가 recovery 엔트리를 비우게 한다. snapshot
    //   분기에서 setModified(true) 를 먼저 호출했기 때문에 이 false 전이는 항상
    //   메시지로 송신된다 (setModified 는 modified 변수의 변화에만 송신).
    // - skip 결과: 이전 draft 는 갱신하지 않지만 setModified(true) 는 호출. 가장
    //   흔한 skip 케이스는 json-edit textarea 의 mid-edit invalid JSON 인데,
    //   사용자는 활성 셀에 미커밋 입력을 들고 있는 상태이다. dirty 플래그를
    //   켜지 않으면 host 의 currentIsDirty 가 false 로 머물러 외부 변경이
    //   자동 reload 로 빠지거나(미커밋 입력 폐기) 다른 파일을 열 때
    //   confirmDiscardIfDirty 가 silent pass 되어 입력이 사라진다. recovery
    //   snapshot 자체는 invalid 라 쓸 수 없지만, dirty 표시로 reload/switch
    //   보호는 걸 수 있다.
    // 활성 편집 셀의 DOM 입력을 buildDraftSnapshot 인자 모양으로 읽어 온다.
    // 미커밋 입력을 DOM 에서 수집하는 곳은 **여기 한 곳뿐**이라, draft 를 만드는
    // 세 자리(keystroke 송신 / 저장 응답 / baseline 교체)가 항상 같은 것을 본다.
    //
    // NOTE: src/jsonEditorUtils.ts 의 ActiveCellEdit 와 같은 모양이어야 한다.
    function readActiveCellEdit(td) {
        if (!td || !td.classList || !td.classList.contains('editing')) { return null; }
        const sheetEntry = sheetMap[activeIdx];
        if (!sheetEntry) { return null; }
        const input = td.querySelector('.cell-edit input, .cell-edit textarea');
        if (!input) { return null; }
        // 배열 셀이면 **셀 전체**의 input 값을 모은다 — 하나만 넘기면 같은 셀의
        // 다른 미커밋 입력이 draft 에서 사라진다.
        // commitCell / syncEditingArrayCellToData 가 수집하는 것과 같은 집합이다.
        let arrValues;
        if (input.dataset && input.dataset.arrIdx !== undefined) {
            arrValues = [];
            td.querySelectorAll('.cell-edit input[data-arr-idx]').forEach(el => { arrValues.push(el.value); });
        }
        return {
            sheetPath: sheetEntry.path,
            rowIdx: parseInt(td.dataset.row),
            col: td.dataset.col,
            rawInputValue: input.value,
            arrValues: arrValues,
            isJsonEdit: !!(input.classList && input.classList.contains('json-edit'))
        };
    }

    // NOTE: src/jsonEditorUtils.ts 의 resolveActiveDraftState 와 동일해야 한다.
    // 한쪽만 수정하지 말 것 — 단위테스트는 그쪽에 있다.
    //
    // 저장 응답 / baseline 교체 시점의 **dirty 판정과 recovery 스냅샷을 하나의
    // 기준**으로 만든다. 커밋된 data 로 판정하면 (1) DOM 에 입력이 남아 있는데
    // clean 이 되어 host 가 recovery 를 비우고, (2) dirty 로 남기더라도 keystroke
    // 마다 보낸 draft 를 옛 커밋 데이터로 덮어써 패널을 닫는 순간 입력이 사라진다.
    // 반대로 "활성 셀이 있으면 무조건 dirty" 로 때우면, 값을 바꾸지 않고 셀을
    // 클릭만 해도 저장 뒤 영원히 dirty 로 남는다 (그 뒤 blur 는 값이 그대로면
    // commitCell 의 changed 분기를 타지 않아 dirty 를 다시 계산하지 않는다).
    // DOM 에서 활성 셀을 읽어 번들의 판정에 넘긴다. 판정 규칙 — 무엇을
    // recovery 로 보낼지, invalid 일 때 무엇을 지킬지 — 은 전부
    // resolveActiveDraftState 안에 있다. 예전에는 그 규칙이 여기에도 한 벌
    // 더 있었고, 두 벌이 어긋나지 않기를 주석으로만 바라고 있었다.
    function activeDraftState() {
        const active = readActiveCellEdit(document.querySelector('td.editing'));
        return resolveActiveDraftState(data, active, lastRecoverableDraft);
    }

    function sendDraftSnapshot(input) {
        if (!input) { return; }
        const td = input.closest && input.closest('td');
        const active = readActiveCellEdit(td);
        if (!active) { return; }

        const result = buildDraftSnapshot({
            data: data,
            sheetPath: active.sheetPath,
            rowIdx: active.rowIdx,
            col: active.col,
            rawInputValue: active.rawInputValue,
            arrValues: active.arrValues,
            isJsonEdit: active.isJsonEdit,
            lastSavedSnapshot: currentBaseline()
        });
        if (result.kind === 'snapshot') {
            // 이 셀에서 마지막으로 **표현 가능했던** 입력. 이어지는 keystroke 가
            // invalid JSON 을 만들어도 이것이 recovery 의 최선값으로 남는다.
            lastRecoverableDraft = result.data;
            setModified(true);
            vscode.postMessage({ command: 'snapshot', data: result.data });
        } else if (result.kind === 'clean') {
            // 입력이 baseline 으로 돌아왔다 — host 가 recovery 를 비우므로
            // 되돌려 보낼 draft 도 없다.
            lastRecoverableDraft = undefined;
            setModified(false);
        } else if (result.kind === 'skip') {
            // 표현할 수 없는 입력. **이전 valid draft 는 그대로 유지한다.**
            setModified(true);
        }
    }

    function attachCellEvents() {
        // Click to edit
        document.querySelectorAll('td[data-row]').forEach(td => {
            const view = td.querySelector('.cell-view');
            if (!view) { return; }
            const beginEdit = () => {
                // Close other editing cells. invalid JSON 등으로 commit이
                // 거부되면 그 셀은 editing 상태로 남으며, 새 셀로의 진입을
                // 막아 두 셀이 동시에 편집 상태가 되는 것을 방지한다.
                let allCommitted = true;
                document.querySelectorAll('td.editing').forEach(other => {
                    if (other !== td) {
                        if (!commitCell(other)) { allCommitted = false; }
                    }
                });
                if (!allCommitted) {
                    const failing = document.querySelector('td.editing');
                    if (failing) {
                        const failingInput = failing.querySelector('.cell-edit input, .cell-edit textarea');
                        if (failingInput) { failingInput.focus(); }
                    }
                    return;
                }
                td.classList.add('editing');
                const input = td.querySelector('.cell-edit input, .cell-edit textarea');
                if (input) { input.focus(); input.select && input.select(); }
            };
            view.addEventListener('click', beginEdit);
            // 편집 진입이 클릭 전용이었다. 셀 자체가 포커스를 받지 못해
            // 키보드만으로는 값을 고칠 방법이 아예 없었다 — 표를 읽을 수는
            // 있으나 편집기로는 쓸 수 없는 상태였다.
            //
            // 편집 중인 input 안에서 누른 Enter까지 여기로 올라오면 방금 연
            // 셀을 다시 여는 셈이 되므로, 편집 상태의 셀은 건너뛴다.
            view.setAttribute('tabindex', '0');
            view.setAttribute('role', 'button');
            view.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') { return; }
                if (td.classList.contains('editing')) { return; }
                // **셀 자신에서 시작한 키만 받는다.**
                //
                // 셀 안에는 변환 버튼(a→s / s→a)이 들어 있다. 그 버튼에 포커스를
                // 두고 Enter/Space 를 누르면 keydown 이 여기까지 버블링되는데,
                // 아래 preventDefault() 가 브라우저의 기본 동작(= click 합성)을
                // 취소해 **버튼이 영영 눌리지 않았다**. 대신 셀 편집이 열려서,
                // 키보드 사용자에게는 변환 기능이 아예 없는 것과 같았다.
                // 마우스 경로는 버튼의 click 핸들러가 stopPropagation 으로
                // 막고 있었지만 키보드 경로에는 대응이 없었다.
                if (e.target !== view) { return; }
                e.preventDefault();
                beginEdit();
            });
        });

        // Blur / Enter to commit for simple inputs
        document.querySelectorAll('.cell-edit input[type="text"]:not([data-arr-idx])').forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { commitCell(input.closest('td')); }
                if (e.key === 'Escape') { cancelCell(input.closest('td')); }
            });
            input.addEventListener('blur', (e) => {
                const td = input.closest('td');
                if (td && td.classList.contains('editing')) {
                    // td.isConnected: 다른 핸들러가 renderTable로 DOM을 갈아치우면
                    // 이 td는 detach된다. detach된 td에 commit하면 stale 인덱스로
                    // 엉뚱한 행에 쓸 수 있어 방어가 필요하다.
                    setTimeout(() => {
                        if (td.isConnected && td.classList.contains('editing')) {
                            commitCell(td);
                        }
                    }, 100);
                }
            });
        });

        // Textarea: Escape to cancel, Ctrl+Enter to commit
        document.querySelectorAll('.cell-edit textarea').forEach(ta => {
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.ctrlKey) { commitCell(ta.closest('td')); }
                if (e.key === 'Escape') { cancelCell(ta.closest('td')); }
            });
            ta.addEventListener('blur', (e) => {
                const td = ta.closest('td');
                if (td && td.classList.contains('editing')) {
                    setTimeout(() => {
                        if (td.isConnected && td.classList.contains('editing')) {
                            commitCell(td);
                        }
                    }, 100);
                }
            });
        });

        // Array item inputs
        document.querySelectorAll('.cell-edit input[data-arr-idx]').forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { commitCell(input.closest('td')); }
                if (e.key === 'Escape') { cancelCell(input.closest('td')); }
            });
        });

        // ✕ / + 에서도 Escape 로 셀을 빠져나온다. 마지막 태그를 지우고 나면
        // 포커스가 "+" 에 있는데 거기서 Escape 가 먹지 않아, 키보드만으로는
        // 편집을 취소할 방법이 아예 없었다 (Escape 는 input 에만 걸려 있었다).
        document.querySelectorAll('.cell-edit [data-remove-arr], .cell-edit [data-add-arr]').forEach(btn => {
            btn.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { cancelCell(btn.closest('td')); }
            });
        });

        // **셀 밖으로 나가면 commit 한다.** 단일 값 셀과 textarea 는 이미 이렇게
        // 동작하는데 배열 셀만 빠져 있어, 다른 곳을 클릭해도 편집 상태로 남았다 —
        // 화면 밖으로 스크롤되면 왜 그런지 알 방법도 없다.
        //
        // **input 뿐 아니라 ✕ / + 에도 건다.** 셀 안의 DOM 순서가
        // (input, ✕) × n → + 라, 앞으로 Tab 해서 나가는 사람은 언제나 버튼을
        // 거쳐 나간다. input 에만 걸면 그 경로가 통째로 빠진다.
        document.querySelectorAll(
            '.cell-edit input[data-arr-idx], .cell-edit [data-remove-arr], .cell-edit [data-add-arr]'
        ).forEach(el => {
            el.addEventListener('blur', () => {
                const td = el.closest('td');
                if (!td || !td.classList.contains('editing')) { return; }
                setTimeout(() => {
                    if (!td.isConnected || !td.classList.contains('editing')) { return; }
                    // 같은 셀 안으로 옮겨 간 포커스는 편집을 끝낸 것이 아니다.
                    // 태그 사이를 Tab 하거나 ✕ / + 를 누른 것까지 commit 으로
                    // 보면 셀이 접혀 버린다.
                    if (td.contains(document.activeElement)) { return; }
                    // commitCell 은 표를 다시 그린다. 그 사이 사용자가 옮겨 간
                    // 셀도 함께 사라지므로 어디였는지 기억했다가 돌려준다 —
                    // 그러지 않으면 Shift+Tab 으로 빠져나온 100ms 뒤에 포커스가
                    // 조용히 body 로 떨어져 다음 Tab 이 문서 맨 앞에서 다시
                    // 시작한다. (툴바처럼 표 밖으로 나간 포커스는 다시 그려도
                    // 살아 있으므로 건드리지 않는다.)
                    const moved = document.activeElement;
                    const movedTd = moved && moved.closest ? moved.closest('td[data-row]') : null;
                    const backRow = movedTd ? parseInt(movedTd.dataset.row) : null;
                    const backCol = movedTd ? movedTd.dataset.col : null;
                    commitCell(td);
                    if (backRow === null) { return; }
                    const back = findCellByCol(backRow, backCol);
                    if (!back) { return; }
                    const view = back.querySelector('.cell-view');
                    if (view) { view.focus(); }
                }, 100);
            });
        });

        // Draft snapshot 송신 — 사용자가 commit 전에 탭 전환/Reload/패널 close
        // 등으로 input이 detach 되어도 host의 recovery 엔트리에 마지막 입력이
        // 남아 reopen 시 복구할 수 있게 한다. JSON-edit textarea는 partial JSON
        // 이 invalid 라 sendDraftSnapshot 내부에서 제외된다.
        document.querySelectorAll('.cell-edit input, .cell-edit textarea').forEach(el => {
            el.addEventListener('input', () => sendDraftSnapshot(el));
        });

        // Remove array item
        document.querySelectorAll('[data-remove-arr]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.closest('td');
                // 편집 중인 input들의 latest value를 data로 sync한 뒤 splice.
                // 이렇게 하지 않으면 사용자가 한 input을 수정하다가 다른 태그의 ✕를
                // 누른 순간 입력값이 data에도 history에도 들어가지 못한 채 사라진다.
                const arr = syncEditingArrayCellToData(td);
                if (!arr) { return; }
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                const idx = parseInt(btn.dataset.removeArr);
                arr.splice(idx, 1);
                pushHistory();
                renderTable();
                // 포커스만으로는 무엇이 일어났는지 알 수 없다 — 값이 비슷한
                // 태그들(["debug", "debug-2"])에서는 다음 항목으로 옮겨 간
                // 포커스가 "지워졌다" 와 구별되지 않는다.
                announce(fmt(S.arrayItemRemoved, { n: idx + 1, count: arr.length }));
                refocusArrayCell(rowIdx, col, idx, '.cell-edit [data-remove-arr]');
            });
        });

        // Add array item
        document.querySelectorAll('[data-add-arr]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.closest('td');
                // sync first — 입력 중이던 태그 값이 사라지지 않도록.
                // dataset 을 읽는 것도 이 뒤다: 그러지 않으면 td 가 null 인
                // 순간 헬퍼의 null 계약에 닿기 전에 TypeError 로 죽어, ✕ 쪽과
                // 순서가 어긋난다.
                const arr = syncEditingArrayCellToData(td);
                if (!arr) { return; }
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                arr.push('');
                pushHistory();
                renderTable();
                // 이미 빈 칸에 있던 사용자에게는 "+" 가 아무 일도 하지 않은
                // 것과 구별되지 않는다.
                announce(fmt(S.arrayItemAdded, { count: arr.length }));
                refocusArrayCell(rowIdx, col, arr.length - 1, '.cell-edit input[data-arr-idx]');
            });
        });

        // Convert string <-> array
        document.querySelectorAll('[data-convert]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 다른 셀이 편집 중이면 먼저 commit. convert 는 cell 의 타입을
                // 바꾸기 때문에 renderTable 로 모든 td 를 갈아치우는데, blur 의
                // 100ms 지연 commit 은 detach 된 td 의 isConnected 가드로 skip
                // 되므로 — 이 가드가 없으면 사용자의 미커밋 입력이 사라진다.
                if (!commitActiveCellOrAbort()) { return; }
                const td = btn.closest('td[data-row]');
                if (!td) { return; }
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                // getActiveRows() 는 시트·행이 어긋나면 null 이다. 예전에는
                // 검사 없이 읽어 그 순간 스크립트가 죽었다.
                const rows = getActiveRows();
                if (!rows || !rows[rowIdx]) { return; }
                const val = rows[rowIdx][col];
                if (btn.dataset.convert === 'split') {
                    const str = String(val ?? '');
                    rows[rowIdx][col] = str.split(',').map(s => s.trim());
                } else if (btn.dataset.convert === 'retype') {
                    const retyped = retypedScalar(val);
                    // 렌더 시점과 지금 사이에 값이 바뀌었을 수 있다.
                    if (!retyped) { return; }
                    rows[rowIdx][col] = retyped.value;
                    // 표에서는 36 과 "36" 이 똑같이 보인다. 무엇으로 바뀌었는지
                    // 화면만으로는 알 수 없으므로 문구로 알린다.
                    announce(fmt(S.cellTypeChanged, { col: col, preview: JSON.stringify(retyped.value) }));
                } else {
                    rows[rowIdx][col] = Array.isArray(val) ? val.join(', ') : String(val);
                }
                pushHistory();
                renderTable();
                // 다시 그리면 이 버튼이 든 td 가 통째로 사라진다. 같은 셀의
                // 변환 버튼으로 포커스를 돌려 연속으로 누를 수 있게 하고,
                // 없으면 셀 자체로 — 그러지 않으면 포커스가 body 로 떨어져
                // 키보드 사용자는 문서 맨 앞으로 튕긴다.
                const again = findCellByCol(rowIdx, col);
                if (again) {
                    const target = again.querySelector('.convert-btn') || again.querySelector('.cell-view');
                    if (target) { target.focus(); }
                }
            });
        });

        // Delete row
        document.querySelectorAll('[data-delete-row]').forEach(btn => {
            btn.addEventListener('click', () => {
                // 다른 셀이 편집 중이면 먼저 commit. invalid JSON 으로 거부되면
                // 행 삭제도 중단해 stale 인덱스로 잘못된 행에 쓰는 사고를 막는다.
                if (!commitActiveCellOrAbort()) { return; }
                const rowIdx = parseInt(btn.dataset.deleteRow);
                // getActiveRows() 는 시트가 어긋나면 null 이다. 검사 없이 읽던 자리.
                const rows = getActiveRows();
                // **범위로 검사한다.** \`!rows[rowIdx]\` 로 두면 값이 0 · '' · false
                // 인 행이 falsy 라 삭제되지 않는다 — 루트가 [0, 1, 2] 인 파일에서
                // 첫 행의 ✕ 가 아무 반응 없이 먹통이 된다.
                if (!rows || rowIdx < 0 || rowIdx >= rows.length) { return; }
                rows.splice(rowIdx, 1);
                pushHistory();
                renderTable();
                // 지운 자리로 올라온 행의 ✕ 로 옮긴다. 마지막 행을 지웠으면 그
                // 앞으로, 하나도 남지 않으면 "행 추가" 로. 방금 사라진 버튼에
                // 있던 포커스를 두면 body 로 떨어진다.
                const remaining = document.querySelectorAll('[data-delete-row]');
                if (remaining.length) {
                    remaining[Math.min(rowIdx, remaining.length - 1)].focus();
                } else {
                    const addRow = document.getElementById('btnAddRow');
                    if (addRow) { addRow.focus(); }
                }
            });
        });

        // Keyboard reorder — Alt+Up/Down on the row grip, matching VS Code's
        // "move line" chord. Drag and drop below covers the pointer case; a
        // keyboard user previously had no way to reorder rows at all.
        document.querySelectorAll('button[data-move-row]').forEach(grip => {
            grip.addEventListener('keydown', (e) => {
                if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) { return; }
                e.preventDefault();
                if (!commitActiveCellOrAbort()) { return; }
                const rows = getActiveRows();
                const from = parseInt(grip.dataset.moveRow);
                const to = e.key === 'ArrowUp' ? from - 1 : from + 1;
                if (to < 0 || to >= rows.length) { return; }
                const item = rows.splice(from, 1)[0];
                rows.splice(to, 0, item);
                pushHistory();
                renderTable();
                // Re-rendering replaces the DOM, so follow the row the user
                // is moving — otherwise focus falls back to <body> and the
                // next Alt+Arrow goes nowhere.
                const moved = document.querySelector('button[data-move-row="' + to + '"]');
                if (moved) { moved.focus(); }
                announce(fmt(S.rowMoved, { n: to + 1 }));
            });
        });

        // Drag and drop reorder
        let dragSrcIdx = null;
        document.querySelectorAll('tr[data-drag-row]').forEach(tr => {
            tr.addEventListener('dragstart', (e) => {
                if (!commitActiveCellOrAbort()) {
                    e.preventDefault();
                    return;
                }
                dragSrcIdx = parseInt(tr.dataset.dragRow);
                tr.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            tr.addEventListener('dragend', () => {
                tr.classList.remove('dragging');
                document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
                    el.classList.remove('drag-over-top', 'drag-over-bottom');
                });
                dragSrcIdx = null;
            });
            tr.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = tr.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                tr.classList.remove('drag-over-top', 'drag-over-bottom');
                if (e.clientY < midY) {
                    tr.classList.add('drag-over-top');
                } else {
                    tr.classList.add('drag-over-bottom');
                }
            });
            tr.addEventListener('dragleave', () => {
                tr.classList.remove('drag-over-top', 'drag-over-bottom');
            });
            tr.addEventListener('drop', (e) => {
                e.preventDefault();
                const targetIdx = parseInt(tr.dataset.dragRow);
                if (dragSrcIdx === null || dragSrcIdx === targetIdx) { return; }
                const rows = getActiveRows();
                const rect = tr.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const insertBefore = e.clientY < midY;
                const item = rows.splice(dragSrcIdx, 1)[0];
                let newIdx = insertBefore ? targetIdx : targetIdx + 1;
                if (dragSrcIdx < targetIdx) { newIdx--; }
                rows.splice(newIdx, 0, item);
                pushHistory();
                renderTable();
            });
        });
    }

    /**
     * 편집 중 셀의 입력값을 data에 반영한다.
     * @returns true 면 commit 성공(실제 변경 여부와 무관), false 면 invalid
     *   JSON 등으로 commit이 거부되어 td.editing 상태가 유지됨.
     *   호출자(Save, Ctrl+S, click-to-edit)는 false 반환 시 후속 동작을
     *   중단해야 데이터가 stale 상태로 저장되거나 두 셀이 동시에 편집
     *   상태가 되는 것을 방지할 수 있다.
     */
    function commitCell(td) {
        if (!td || !td.classList.contains('editing')) { return true; }
        const rowIdx = parseInt(td.dataset.row);
        const col = td.dataset.col;
        const oldVal = getActiveRows()[rowIdx][col];
        let changed = false;

        if (Array.isArray(oldVal)) {
            const jsonTextarea = td.querySelector('.cell-edit textarea.json-edit');
            if (jsonTextarea) {
                try {
                    const newVal = JSON.parse(jsonTextarea.value);
                    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                        getActiveRows()[rowIdx][col] = newVal;
                        changed = true;
                    }
                } catch (e) {
                    showError(fmt(S.invalidJsonInCell, { col: col, message: e.message }));
                    return false;
                }
            } else {
                const inputs = td.querySelectorAll('.cell-edit input[data-arr-idx]');
                const raws = [];
                inputs.forEach(input => { raws.push(input.value); });
                // 항목마다 옛 값의 타입을 보존한다 — 그렇지 않으면 편집 없이
                // 셀을 열었다 나가는 것만으로 [1,true,null] 이 문자열 배열이 된다.
                const newArr = coerceEditedArrayItems(raws, oldVal);
                if (JSON.stringify(oldVal) !== JSON.stringify(newArr)) {
                    getActiveRows()[rowIdx][col] = newArr;
                    changed = true;
                }
            }
        } else {
            const jsonTextarea = td.querySelector('.cell-edit textarea.json-edit');
            if (jsonTextarea) {
                try {
                    const newVal = JSON.parse(jsonTextarea.value);
                    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                        getActiveRows()[rowIdx][col] = newVal;
                        changed = true;
                    }
                } catch (e) {
                    showError(fmt(S.invalidJsonInCell, { col: col, message: e.message }));
                    return false; // Don't close editing on invalid JSON
                }
            } else {
                const textarea = td.querySelector('.cell-edit textarea');
                const input = td.querySelector('.cell-edit input');
                let newVal;
                if (textarea) {
                    newVal = textarea.value;
                } else if (input) {
                    // 옛 값이 문자열이면 raw 를 그대로 둔다 — "00123" · "true" ·
                    // "null" 이 저장할 때 조용히 숫자/불리언/null 로 바뀌지 않도록.
                    // 규칙은 번들의 coerceEditedCellValue 한 곳에만 있다.
                    newVal = coerceEditedCellValue(input.value, oldVal);
                }
                const oldEmpty = oldVal === undefined || oldVal === null || oldVal === '';
                const newEmpty = newVal === undefined || newVal === null || newVal === '';
                if (oldEmpty && newEmpty) {
                    // No real change
                } else if (oldVal !== newVal) {
                    getActiveRows()[rowIdx][col] = newVal;
                    changed = true;
                }
            }
        }
        td.classList.remove('editing');
        if (changed) {
            pushHistory();
        }
        renderTable();
        return true;
    }

    function cancelCell(td) {
        if (!td) { return; }
        td.classList.remove('editing');
        renderTable();
        // 사용자가 명시적으로 입력을 취소했다. 입력 중 매 keystroke 마다
        // sendDraftSnapshot 이 host 에 보낸 draft snapshot / dirty 표시는 여기서
        // 정리해야 한다. 그렇지 않으면 (1) 패널을 닫고 reopen 시 사용자가
        // cancel 한 입력이 "복구하시겠습니까?" 로 되살아나거나, (2) data 는
        // saved baseline 과 같은데 modified 표시만 남는 false positive 가 생긴다.
        //
        // pushHistory / restoreFromHistoryIndex 와 동일한 정책: 현재 data 가
        // saved 와 같으면 setModified(false) 로 host 가 recovery 를 비우게
        // 하고, 다른 커밋된 변경이 남아 있으면 dirty 는 유지하되 host 의
        // recovery 를 cancelled draft 가 아닌 현재 data 로 덮어쓴다.
        const snap = snapshotData();
        const dirtyNow = snap !== currentBaseline();
        setModified(dirtyNow);
        if (dirtyNow) {
            vscode.postMessage({ command: 'snapshot', data: data });
        }
    }

    // Type-coercing input parser used only when the original cell had a
    // non-string primitive type. For string cells we keep the raw string to
    // avoid data loss (see commitCell above).
    // parseValue 는 여기 있었다. 지금은 번들이 올려 주는 것을 위에서 꺼내 쓴다
    // (src/webview/jsonEditorLogic.ts).

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 편집 중 셀이 있다면 commit을 먼저 시도하고, invalid JSON 등으로 commit이
    // 실패하면 save를 진행하지 않는다. 그래야 stale data가 디스크에 기록되거나
    // 사용자의 미저장 입력이 조용히 사라지는 사고가 발생하지 않는다.
    function saveAction() {
        const editingTd = document.querySelector('td.editing');
        if (editingTd && !commitCell(editingTd)) { return; }
        // **보낸 것**을 기억해 둔다. host 가 파일을 쓰고 recovery 엔트리를 비우는
        // 동안(비동기) 사용자는 계속 편집할 수 있으므로, 응답이 돌아왔을 때의
        // data 를 baseline 으로 잡으면 디스크에 없는 편집이 "저장됨"으로 표시된다
        // — 디스크=A, 화면=B, dirty=false 가 되어 닫으면 B 가 조용히 사라진다.
        // postMessage 는 이 시점의 data 를 구조적 복제로 넘기므로 스냅샷과 정확히
        // 같은 것이 host 로 간다.
        const seq = ++saveSeq;
        pendingSaveSnapshots.set(seq, snapshotData());
        // 패널이 응답 없이 사라지는 경우를 대비한 상한. 정상 흐름에서는 응답마다
        // 지워지므로 1~2개를 넘지 않는다.
        while (pendingSaveSnapshots.size > MAX_PENDING_SAVES) {
            pendingSaveSnapshots.delete(pendingSaveSnapshots.keys().next().value);
        }
        vscode.postMessage({ command: 'save', data: data, seq: seq });
        // modified flag is cleared only after host confirms successful write (see 'saveResult')
    }

    document.getElementById('btnSave').addEventListener('click', saveAction);

    document.getElementById('btnReload').addEventListener('click', () => {
        // Reload도 host의 confirmDiscardIfDirty를 거치지만, 활성 셀의 미커밋
        // 입력은 아직 data에 들어가지 않아 dirty 판정 자체가 거짓일 수 있다.
        // 먼저 commit을 시도해 입력을 보존하고, invalid이면 reload를 중단한다.
        if (!commitActiveCellOrAbort()) { return; }
        vscode.postMessage({ command: 'reload' });
    });

    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);

    document.getElementById('btnAddRow').addEventListener('click', () => {
        // 행 추가는 인덱스를 시프트시키지 않지만, 일관성과 사용자 의도(편집 중인
        // 셀의 변경을 잃지 않음)를 위해 같은 가드를 적용한다.
        if (!commitActiveCellOrAbort()) { return; }
        const rows = getActiveRows();
        if (!rows || !Array.isArray(rows)) { return; }
        const template = {};
        if (rows.length > 0) {
            Object.keys(rows[0]).forEach(k => {
                const sample = rows[0][k];
                if (Array.isArray(sample)) { template[k] = []; }
                else if (typeof sample === 'number') { template[k] = 0; }
                else { template[k] = ''; }
            });
        }
        rows.push(template);
        pushHistory();
        renderTable();
    });

    // Ctrl+S / Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) { return; }
        const key = (e.key || '').toLowerCase();
        if (key === 's') {
            e.preventDefault();
            saveAction();
            return;
        }
        // Undo/Redo는 셀 편집 중일 때 브라우저 input 기본 undo에 양보한다.
        if (document.querySelector('td.editing')) { return; }
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
            e.preventDefault();
            redo();
        }
    });

    // Messages from extension
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') { return; }
        // **남의 세션 메시지는 여기서 끊는다.** host 가 파일을 바꿔 열면 패널이
        // 재사용되므로, 이전 파일의 지연된 응답(save ack, reload 의 loadData,
        // 외부 변경 watcher 의 loadData)이 이 webview 로 배달될 수 있다.
        // 특히 loadData 는 **이 화면을 남의 파일 데이터로 갈아치우고** 그대로
        // clean 표시까지 하므로, 이어서 저장하면 이 파일에 남의 데이터가 쓰인다.
        if (msg.session !== SESSION_ID) { return; }
        if (msg.command === 'loadData') {
            data = msg.data;
            const oldLabel = sheetMap[activeIdx] ? sheetMap[activeIdx].label : '';
            rebuildSheetMap();
            const newIdx = sheetMap.findIndex(e => e.label === oldLabel);
            activeIdx = newIdx >= 0 ? newIdx : 0;
            renderTabs();
            renderTable();
            // **진행 중이던 저장 기록은 여기서 무효가 된다.** 디스크 내용은 이제
            // 우리가 쓴 것이 아니므로 그 pending 스냅샷들은 더 이상 "디스크에 있을
            // 내용" 이 아니다. setSavedBaseline / markBaselineUnknown 과 같은
            // 처치이고, 재로드 경로(host 의 reload · 외부 변경 자동 재읽기)에는
            // awaitingSaveAck 가드가 없어 저장 응답을 기다리는 사이에 이 메시지가
            // 도착할 수 있다. 남겨 두면 (1) effectiveBaseline 이 재로드된 디스크
            // 대신 옛 pending 을 기준으로 삼아, 사용자가 그 내용에 도달하면 clean 이
            // 되어 host 가 recovery 를 비우고, (2) 뒤늦게 오는 saveResult 가
            // baseline 을 그 옛 저장 내용으로 되돌린다. 비우면 그 응답은 "알 수 없는
            // seq" 로 떨어져 dirty 를 유지한다.
            pendingSaveSnapshots.clear();
            // 외부 변경/리로드 모두 새 디스크 데이터 = 현재 데이터 → 별도
            // savedSnapshot 없이 현재 상태를 baseline으로 잡는다.
            savedSnapshot = undefined;
            resetHistoryToCurrent();
        } else if (msg.command === 'saveResult') {
            // 편집 중인 셀의 입력은 아직 data 에 없다. 판정도, 다시 채워 넣을
            // recovery 도 **DOM 입력을 반영한 draft** 를 기준으로 해야 한다.
            const draft = activeDraftState();
            const decision = decideSaveResult({
                sessionId: SESSION_ID,
                message: msg,
                pendingSnapshots: pendingSaveSnapshots,
                currentSnapshot: draft.snapshot,
                lastSavedSnapshot: lastSavedSnapshot
            });
            // ignore = 남의 세션. pending 항목까지 남의 것이므로 지우지 않는다.
            if (decision.kind !== 'ignore') {
                pendingSaveSnapshots.delete(msg.seq);
                if (decision.kind === 'apply') {
                    lastSavedSnapshot = decision.lastSavedSnapshot;
                }
                // draft 로 표현할 수 없는 미커밋 입력(mid-edit invalid JSON)은
                // 비교할 방법이 없다. 그 상태에서 clean 으로 확정하면 host 가
                // recovery 를 비워 입력이 사라지므로 무조건 dirty 로 둔다.
                const ackDirty = decision.dirty || !draft.valid;
                // host 로는 아래 saveAck 하나로만 알린다 (원자적 적용).
                setModifiedLocal(ackDirty);
                if (ackDirty && draft.recoveryData !== undefined) {
                    // host 는 저장 처리 중에 recovery 엔트리를 비웠다. 아직
                    // 저장되지 않은 편집이 남았으므로 다시 채워 넣어야 패널이
                    // 강제로 닫혀도 복구된다. **미커밋 입력이 반영된 draft** 를
                    // 보낸다 — 커밋된 data 를 보내면 그 사이의 입력을 덮어쓴다.
                    // 표현 가능한 draft 가 하나도 없으면(처음부터 invalid) 아무
                    // 것도 보내지 않는다 — dirty 표시만으로 reload/전환은 막힌다.
                    vscode.postMessage({ command: 'snapshot', data: draft.recoveryData });
                }
                updateUndoRedoButtons();
                // **처리 완료 + 최종 dirty 를 한 메시지로** 알린다. host 는 이
                // 신호를 받아야 "저장 응답 대기 중" 을 풀고, 같은 메시지의 dirty
                // 를 그대로 적용한다. dirty 를 따로 보내면 그 메시지는 아직 대기
                // 중이라는 이유로 버려지고 ack 는 복원하지 않아, 정상 저장인데도
                // host 가 dirty 로 남는다.
                vscode.postMessage({ command: 'saveAck', seq: msg.seq, dirty: ackDirty });
            }
        } else if (msg.command === 'setSavedBaseline') {
            // 외부 변경 *Keep current edits* 분기에서 host 가 새 디스크 content
            // 를 알려준다. user 의 data 는 그대로 두고 lastSavedSnapshot 만 새
            // 디스크 baseline 으로 갱신. dirty 비교가 디스크 reality 를 반영하게
            // 되어, 이후 undo / 수동 revert 로 옛 baseline 데이터에 도달해도
            // dirty 가 false 로 떨어지지 않는다 (디스크 ≠ user data 라 여전히
            // 미저장 상태). pushHistory 와 동일한 정책으로 setModified + 분기
            // 안 snapshot 송신.
            // **진행 중이던 저장 기록은 여기서 무효가 된다.** 디스크는 이제
            // 외부 변경본이므로, 그 pending 스냅샷들은 더 이상 "디스크에 있을
            // 내용" 이 아니다. 남겨 두면 뒤늦게 도착한 saveResult 가 baseline 을
            // 옛 저장 내용으로 되돌려, 화면과 디스크가 다른데도 clean 이 된다.
            // 비워 두면 그 응답은 "알 수 없는 seq" 로 떨어져 dirty 를 유지한다.
            pendingSaveSnapshots.clear();
            lastSavedSnapshot = JSON.stringify(msg.data);
            // 활성 셀의 미커밋 입력까지 반영해 비교한다. 커밋된 data 로만 보면
            // 새 디스크 내용과 우연히 같을 때 clean 이 되어, 화면에 입력이 남아
            // 있는데도 host 가 recovery 를 지운다.
            const draft = activeDraftState();
            const dirtyNow = !draft.valid || draft.snapshot !== lastSavedSnapshot;
            setModified(dirtyNow);
            if (dirtyNow && draft.recoveryData !== undefined) {
                vscode.postMessage({ command: 'snapshot', data: draft.recoveryData });
            }
        } else if (msg.command === 'markBaselineUnknown') {
            // 디스크가 invalid / 사라짐 / 사이즈 초과 등으로 host 가 valid
            // baseline 을 모를 때. lastSavedSnapshot 을 빈 문자열 sentinel 로
            // 잡아 (JSON.stringify(data) 는 항상 valid JSON 이라 빈 문자열일
            // 수 없음 → 항상 dirty), 사용자가 save 로 디스크를 명시적으로
            // 복구하거나 의식적으로 다른 결정을 내리도록 유도. 이전에 데이터로
            // 빈 객체를 보냈을 때는 사용자가 실제로 빈 객체를 편집 중일 때
            // dirty=false 가 되어 recovery 가 비워지는 충돌이 있었다.
            // baseline 을 unknown 으로 만드는 것도 **디스크가 우리가 저장한 것이
            // 아니게 됐다**는 뜻이다. 진행 중이던 저장 기록을 남겨 두면 뒤늦게
            // 도착한 saveResult 가 baseline 을 그 저장 내용으로 되돌려, 화면과
            // 디스크가 다른데도 clean 이 될 수 있다. Keep 경로와 같은 처치.
            pendingSaveSnapshots.clear();
            lastSavedSnapshot = BASELINE_UNKNOWN_SENTINEL;
            setModified(true);
            // 여기도 미커밋 입력이 반영된 draft 를 보낸다 — 커밋된 data 를
            // 보내면 keystroke 마다 쌓아 둔 draft 를 옛 내용으로 덮어쓴다.
            const unknownDraft = activeDraftState();
            if (unknownDraft.recoveryData !== undefined) {
                vscode.postMessage({ command: 'snapshot', data: unknownDraft.recoveryData });
            }
        }
    });

    // Initial render & baseline history
    renderTabs();
    renderTable();
    resetHistoryToCurrent();
})();
</script>
</body>
</html>`;
}
