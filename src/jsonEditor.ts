import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { t } from './i18n';
import { coerceToUri } from './previewOpener';
import { shouldOfferRecovery, RecoveryEntry, RecoveryStore, makeRecoveryStore } from './jsonEditorUtils';
import { DIALOG_SCOPE, showOpenDialogWithMemory } from './dialogMemory';

let currentPanel: vscode.WebviewPanel | undefined;
let currentMessageDisposable: vscode.Disposable | undefined;
let currentIsDirty = false;
let currentFilePath: string | undefined;
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

const RECOVERY_STATE_KEY = 'taskhub.jsonEditor.recovery';
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
 * 복구 여부를 묻는다. 파일이 외부에서 변경된 경우(스냅샷 기록 시점의 mtime과
 * 현재 파일 mtime이 다른 경우) 스냅샷은 자동으로 폐기한다.
 */
async function offerRecoveryIfAny(
    context: vscode.ExtensionContext,
    filePath: string,
    fileMtimeMs: number,
    fileSize?: number
): Promise<RecoveryEntry | null> {
    const entry = getRecoveryEntry(context, filePath);
    if (!entry) { return null; }
    if (!shouldOfferRecovery(entry, fileMtimeMs, fileSize)) {
        await setRecoveryEntry(context, filePath, null);
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
    await setRecoveryEntry(context, filePath, null);
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
    let earlyError: { msg: string; mtimeForRecovery: number | undefined } | null = null;

    let stat: fs.Stats | undefined;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        earlyError = {
            msg: t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`),
            // stat 실패 — currentFileMtimeMs 를 알 수 없다. recovery 의 own
            // mtime 을 그대로 쓰면 shouldOfferRecovery 가 "캡처 이후 외부 변경
            // 없음" 으로 보고 제안한다 (파일이 사라진 케이스에 적절한 의미).
            mtimeForRecovery: undefined
        };
    }

    if (!earlyError && stat && stat.size > JSON_EDITOR_MAX_FILE_SIZE) {
        earlyError = {
            msg: t(
                `파일 크기(${formatFileSize(stat.size)})가 JSON Editor 처리 한도(${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)})를 초과합니다. 대용량 JSON 파일은 텍스트 에디터에서 직접 편집해 주세요.`,
                `File size (${formatFileSize(stat.size)}) exceeds the JSON Editor limit (${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)}). Please edit large JSON files directly in a text editor.`
            ),
            mtimeForRecovery: stat.mtimeMs
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
                msg: t(`파일 읽기 실패 (${fileName}): ${error.message}`, `Failed to read file (${fileName}): ${error.message}`),
                mtimeForRecovery: stat!.mtimeMs
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
                msg: t(`JSON 파싱 실패 (${fileName}): ${error.message}`, `Failed to parse JSON (${fileName}): ${error.message}`),
                mtimeForRecovery: stat!.mtimeMs
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
            const mtime = earlyError.mtimeForRecovery ?? entry.fileMtimeMs;
            // size: stat 이 있으면 그것을 기준으로, 없으면 entry 의 own size 를
            // 그대로 흘려 size 검사가 spurious mismatch 를 일으키지 않게 한다.
            const sizeForRecovery = stat ? stat.size : entry.fileSize;
            fallback = await offerRecoveryIfAny(context, filePath, mtime, sizeForRecovery);
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
                retainContextWhenHidden: true
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
            currentFlushPendingSnapshot = undefined;
            currentLastReceivedSnapshot = undefined;
            disposeFileWatcher();
            clearSnapshotTimer();
        });
    }

    currentPanel.title = `JSON Editor: ${fileName}`;
    currentPanel.webview.html = getWebviewContent(jsonData, savedDataForWebview, filePath, currentPanel.webview, baselineUnknownForWebview);
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

    currentMessageDisposable?.dispose();
    currentMessageDisposable = currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            if (!message || typeof message !== 'object' || typeof message.command !== 'string') {
                return;
            }
            switch (message.command) {
                case 'modified': {
                    currentIsDirty = Boolean(message.value);
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
                    try {
                        const saveData = unwrapIfRootArray(message.data, isRootArray);
                        fs.writeFileSync(filePath, JSON.stringify(saveData, null, detectedIndent) + '\n', 'utf-8');
                        const written = fs.statSync(filePath);
                        currentLastWriteMtime = written.mtimeMs;
                        currentLastWriteSize = written.size;
                        baselineMtimeMs = written.mtimeMs;
                        baselineFileSize = written.size;
                        currentIsDirty = false;
                        clearSnapshotTimer();
                        currentLastReceivedSnapshot = undefined;
                        await setRecoveryEntry(context, filePath, null);
                        currentPanel?.webview.postMessage({ command: 'saveResult', success: true });
                        showSaveSuccess(fileName);
                    } catch (error: any) {
                        currentPanel?.webview.postMessage({ command: 'saveResult', success: false });
                        showSaveFailure(fileName, error);
                    }
                    break;
                }
                case 'reload': {
                    if (!(await confirmDiscardIfDirty(fileName))) {
                        break;
                    }
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
                        currentPanel?.webview.postMessage({ command: 'markBaselineUnknown' });
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
                        currentPanel?.webview.postMessage({ command: 'loadData', data: result.wrapped });
                    } catch (error: any) {
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
                    currentPanel?.webview.postMessage({
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
                    currentPanel?.webview.postMessage({ command: 'markBaselineUnknown' });
                }
                if (currentLastReceivedSnapshot !== undefined) {
                    if (currentSnapshotTimer) {
                        clearTimeout(currentSnapshotTimer);
                        currentSnapshotTimer = undefined;
                    }
                    currentPendingSnapshot = undefined;
                    await writeSnapshotEntry(currentLastReceivedSnapshot);
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
            currentPanel?.webview.postMessage({ command: 'markBaselineUnknown' });
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
            currentPanel?.webview.postMessage({ command: 'loadData', data: result.wrapped });
            if (!currentIsDirty) {
                vscode.window.setStatusBarMessage(
                    t('JSON Editor: 외부 변경을 자동으로 다시 읽음', 'JSON Editor: auto-reloaded external change'),
                    3000
                );
            }
        } catch (e: any) {
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
            currentPanel?.webview.postMessage({ command: 'markBaselineUnknown' });
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
        addArrayItem: t('항목 추가', 'Add item'),
        removeArrayItem: t('{n}번째 항목 삭제', 'Remove item {n}'),
        invalidJsonInCell: t('셀 [{col}]의 JSON이 올바르지 않습니다: {message}', 'Invalid JSON in cell [{col}]: {message}'),
        historyRestoreFailed: t('편집 기록 복원에 실패했습니다: {message}', 'History restore failed: {message}'),
        scriptError: t('스크립트 오류: {message} ({line}번째 줄)', 'JS Error: {message} (line {line})'),
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
     */
    baselineUnknown: boolean = false
): string {
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
    button.danger { background: var(--danger); }
    button.small {
        padding: 2px 6px;
        font-size: 11px;
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
    button.drag-grip:focus-visible {
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
        display: inline-block;
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
    const vscode = acquireVsCodeApi();
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

    function snapshotData() { return JSON.stringify(data); }

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
        const dirtyNow = snap !== lastSavedSnapshot;
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
        buildSheetMap();
        if (activeIdx >= sheetMap.length) { activeIdx = 0; }
        renderTabs();
        renderTable();
        const dirtyNow = historyStack[idx] !== lastSavedSnapshot;
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

    function undo() {
        if (document.querySelector('td.editing')) { return; }
        if (historyIndex <= 0) { return; }
        restoreFromHistoryIndex(historyIndex - 1);
    }

    function redo() {
        if (document.querySelector('td.editing')) { return; }
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
        const arr = getActiveRows()[rowIdx][col];
        if (!Array.isArray(arr)) { return null; }
        const inputs = td.querySelectorAll('.cell-edit input[data-arr-idx]');
        if (inputs.length > 0) {
            const newArr = [];
            inputs.forEach(input => { newArr.push(input.value); });
            arr.length = 0;
            for (const v of newArr) { arr.push(v); }
        }
        return arr;
    }

    // NOTE: 아래 buildSheetMap / getActiveRows 로직은 src/jsonEditorUtils.ts 의
    // buildSheetMap / getRowsByPath 와 동일해야 한다. 한쪽만 수정하지 말 것.
    function buildSheetMap() {
        sheetMap = [];
        Object.keys(data).forEach(key => {
            const val = data[key];
            if (Array.isArray(val)) {
                sheetMap.push({ label: key, path: [key] });
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                Object.keys(val).forEach(subKey => {
                    if (Array.isArray(val[subKey])) {
                        sheetMap.push({ label: key + ' > ' + subKey, path: [key, subKey] });
                    }
                });
            }
        });
    }
    buildSheetMap();

    function getActiveRows() {
        const entry = sheetMap[activeIdx];
        if (!entry) { return null; }
        let ref = data;
        for (const k of entry.path) { ref = ref[k]; }
        return ref;
    }

    function setModified(val) {
        const next = Boolean(val);
        if (modified !== next) {
            modified = next;
            vscode.postMessage({ command: 'modified', value: next });
        }
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
                const next = (idx + step + sheetMap.length) % sheetMap.length;
                const nextTab = tabsEl.children[next];
                if (nextTab) { nextTab.focus(); nextTab.click(); }
            });
            tab.onclick = () => {
                // 탭 전환은 즉시 renderTable로 DOM을 갈아치워 활성 셀의 td를
                // detach시킨다. 가드 없이 들어가면 blur 100ms timeout이
                // isConnected에 막혀 commit이 스킵돼 입력이 유실된다.
                if (!commitActiveCellOrAbort()) { return; }
                activeIdx = idx;
                renderTabs();
                renderTable();
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
                html += '<input type="text" value="' + escapeAttr(String(item)) + '" data-arr-idx="' + i + '">';
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

    // 활성 편집 셀에서 사용자가 타이핑 중일 때, input.value를 data 의 클론에
    // 적용한 *draft snapshot* 을 host로 송신한다. host는 이 스냅샷을
    // workspaceState recovery 엔트리에 기록하므로, 사용자가 commit 전에
    // 패널을 강제로 닫더라도 reopen 시 마지막 키스트로크까지 복구할 수 있다.
    //
    // 핵심 로직(타입 보존 / JSON-edit valid 캡처 / clean revert 인식)은
    // jsonEditorUtils.ts 의 buildDraftSnapshot 과 동일하며, 단위테스트는 그쪽에
    // 있다. webview 는 IIFE 로 외부 모듈을 import 할 수 없어 동일 로직을 여기에
    // 인라인으로 둔다 — 한쪽만 수정하면 mirror sync regex 가드가 실패한다.
    //
    // 세 가지 invariant:
    //   1) plain (non-array) 셀은 commitCell 과 동일하게 oldVal 의 타입을 보고
    //      raw 또는 parseValue(raw) 를 적용. 그렇지 않으면 숫자/불리언/null 셀의
    //      미커밋 draft 가 string 으로 굳어 복구 후 저장 시 디스크에 string 이
    //      기록된다.
    //   2) json-edit textarea 는 raw 가 valid JSON 일 때만 parsed 값을 적용,
    //      invalid 면 skip (이전 valid draft 가 남는다).
    //   3) draft 가 lastSavedSnapshot 과 같으면 clean → setModified(false) 로
    //      host 가 recovery 엔트리를 비우게 한다(의미 없는 복구 프롬프트 차단).
    function buildDraftSnapshot(args) {
        const data = args.data;
        const sheetPath = args.sheetPath;
        const rowIdx = args.rowIdx;
        const col = args.col;
        const rawInputValue = args.rawInputValue;
        const arrIdx = args.arrIdx;
        const isJsonEdit = args.isJsonEdit;
        const lastSavedSnapshot = args.lastSavedSnapshot;

        if (!data || typeof data !== 'object') { return { kind: 'skip' }; }
        // col 은 string 타입만 검증 — JSON 은 빈 문자열 key 도 허용하므로 falsy
        // 검사로는 안 된다. typeof 로 string 인지 확인 (mirror 와 동일 정책).
        if (!Array.isArray(sheetPath) || typeof col !== 'string') { return { kind: 'skip' }; }
        if (typeof rowIdx !== 'number' || Number.isNaN(rowIdx) || rowIdx < 0) { return { kind: 'skip' }; }

        let draft;
        try {
            draft = JSON.parse(JSON.stringify(data));
        } catch (e) {
            return { kind: 'skip' };
        }

        let ref = draft;
        for (let i = 0; i < sheetPath.length; i++) {
            if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { return { kind: 'skip' }; }
            ref = ref[sheetPath[i]];
        }
        if (!Array.isArray(ref)) { return { kind: 'skip' }; }
        const row = ref[rowIdx];
        if (!row || typeof row !== 'object' || Array.isArray(row)) { return { kind: 'skip' }; }
        const oldVal = row[col];

        if (typeof arrIdx === 'number' && !Number.isNaN(arrIdx)) {
            const arr = row[col];
            if (!Array.isArray(arr) || arrIdx < 0 || arrIdx >= arr.length) { return { kind: 'skip' }; }
            arr[arrIdx] = rawInputValue;
        } else if (isJsonEdit) {
            let parsed;
            try {
                parsed = JSON.parse(rawInputValue);
            } catch (e) {
                return { kind: 'skip' };
            }
            row[col] = parsed;
        } else {
            row[col] = (typeof oldVal === 'string') ? rawInputValue : parseValue(rawInputValue);
        }

        if (lastSavedSnapshot !== null && lastSavedSnapshot !== undefined) {
            if (JSON.stringify(draft) === lastSavedSnapshot) {
                return { kind: 'clean' };
            }
        }
        return { kind: 'snapshot', data: draft };
    }

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
    function sendDraftSnapshot(input) {
        if (!input) { return; }
        const td = input.closest && input.closest('td');
        if (!td || !td.classList.contains('editing')) { return; }
        const rowIdx = parseInt(td.dataset.row);
        const col = td.dataset.col;
        const sheetEntry = sheetMap[activeIdx];
        if (!sheetEntry) { return; }
        const isJsonEdit = !!(input.classList && input.classList.contains('json-edit'));
        const arrIdxAttr = input.dataset ? input.dataset.arrIdx : undefined;
        let arrIdx;
        if (arrIdxAttr !== undefined) {
            const parsedArrIdx = parseInt(arrIdxAttr);
            if (Number.isNaN(parsedArrIdx)) { return; }
            arrIdx = parsedArrIdx;
        }

        const result = buildDraftSnapshot({
            data: data,
            sheetPath: sheetEntry.path,
            rowIdx: rowIdx,
            col: col,
            rawInputValue: input.value,
            arrIdx: arrIdx,
            isJsonEdit: isJsonEdit,
            lastSavedSnapshot: lastSavedSnapshot
        });
        if (result.kind === 'snapshot') {
            setModified(true);
            vscode.postMessage({ command: 'snapshot', data: result.data });
        } else if (result.kind === 'clean') {
            setModified(false);
        } else if (result.kind === 'skip') {
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
                const idx = parseInt(btn.dataset.removeArr);
                arr.splice(idx, 1);
                pushHistory();
                renderTable();
            });
        });

        // Add array item
        document.querySelectorAll('[data-add-arr]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.closest('td');
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                // sync first — 입력 중이던 태그 값이 사라지지 않도록.
                const arr = syncEditingArrayCellToData(td);
                if (!arr) { return; }
                arr.push('');
                pushHistory();
                renderTable();
                // Focus last input
                const newTd = document.querySelector('td[data-row="' + rowIdx + '"][data-col="' + col + '"]');
                if (newTd) {
                    newTd.classList.add('editing');
                    const inputs = newTd.querySelectorAll('.cell-edit input[data-arr-idx]');
                    if (inputs.length) { inputs[inputs.length - 1].focus(); }
                }
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
                const val = getActiveRows()[rowIdx][col];
                if (btn.dataset.convert === 'split') {
                    const str = String(val ?? '');
                    getActiveRows()[rowIdx][col] = str.split(',').map(s => s.trim());
                } else {
                    getActiveRows()[rowIdx][col] = Array.isArray(val) ? val.join(', ') : String(val);
                }
                pushHistory();
                renderTable();
            });
        });

        // Delete row
        document.querySelectorAll('[data-delete-row]').forEach(btn => {
            btn.addEventListener('click', () => {
                // 다른 셀이 편집 중이면 먼저 commit. invalid JSON 으로 거부되면
                // 행 삭제도 중단해 stale 인덱스로 잘못된 행에 쓰는 사고를 막는다.
                if (!commitActiveCellOrAbort()) { return; }
                const rowIdx = parseInt(btn.dataset.deleteRow);
                getActiveRows().splice(rowIdx, 1);
                pushHistory();
                renderTable();
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
                const newArr = [];
                inputs.forEach(input => { newArr.push(input.value); });
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
                    // Preserve string type when the original cell was a string,
                    // so values like "00123", "true", "false", or "null" are not
                    // silently coerced to number/boolean/null on save.
                    newVal = typeof oldVal === 'string' ? input.value : parseValue(input.value);
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
        const dirtyNow = snap !== lastSavedSnapshot;
        setModified(dirtyNow);
        if (dirtyNow) {
            vscode.postMessage({ command: 'snapshot', data: data });
        }
    }

    // Type-coercing input parser used only when the original cell had a
    // non-string primitive type. For string cells we keep the raw string to
    // avoid data loss (see commitCell above).
    function parseValue(str) {
        if (str === '') { return ''; }
        if (str === 'null') { return null; }
        if (str === 'true') { return true; }
        if (str === 'false') { return false; }
        const num = Number(str);
        if (Number.isFinite(num) && str.trim() !== '') { return num; }
        return str;
    }

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
        vscode.postMessage({ command: 'save', data: data });
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
        if (msg.command === 'loadData') {
            data = msg.data;
            const oldLabel = sheetMap[activeIdx] ? sheetMap[activeIdx].label : '';
            buildSheetMap();
            const newIdx = sheetMap.findIndex(e => e.label === oldLabel);
            activeIdx = newIdx >= 0 ? newIdx : 0;
            renderTabs();
            renderTable();
            // 외부 변경/리로드 모두 새 디스크 데이터 = 현재 데이터 → 별도
            // savedSnapshot 없이 현재 상태를 baseline으로 잡는다.
            savedSnapshot = undefined;
            resetHistoryToCurrent();
        } else if (msg.command === 'saveResult') {
            if (msg.success) {
                setModified(false);
                lastSavedSnapshot = snapshotData();
                updateUndoRedoButtons();
            }
        } else if (msg.command === 'setSavedBaseline') {
            // 외부 변경 *Keep current edits* 분기에서 host 가 새 디스크 content
            // 를 알려준다. user 의 data 는 그대로 두고 lastSavedSnapshot 만 새
            // 디스크 baseline 으로 갱신. dirty 비교가 디스크 reality 를 반영하게
            // 되어, 이후 undo / 수동 revert 로 옛 baseline 데이터에 도달해도
            // dirty 가 false 로 떨어지지 않는다 (디스크 ≠ user data 라 여전히
            // 미저장 상태). pushHistory 와 동일한 정책으로 setModified + 분기
            // 안 snapshot 송신.
            lastSavedSnapshot = JSON.stringify(msg.data);
            const dirtyNow = snapshotData() !== lastSavedSnapshot;
            setModified(dirtyNow);
            if (dirtyNow) {
                vscode.postMessage({ command: 'snapshot', data: data });
            }
        } else if (msg.command === 'markBaselineUnknown') {
            // 디스크가 invalid / 사라짐 / 사이즈 초과 등으로 host 가 valid
            // baseline 을 모를 때. lastSavedSnapshot 을 빈 문자열 sentinel 로
            // 잡아 (JSON.stringify(data) 는 항상 valid JSON 이라 빈 문자열일
            // 수 없음 → 항상 dirty), 사용자가 save 로 디스크를 명시적으로
            // 복구하거나 의식적으로 다른 결정을 내리도록 유도. 이전에 데이터로
            // 빈 객체를 보냈을 때는 사용자가 실제로 빈 객체를 편집 중일 때
            // dirty=false 가 되어 recovery 가 비워지는 충돌이 있었다.
            lastSavedSnapshot = BASELINE_UNKNOWN_SENTINEL;
            setModified(true);
            vscode.postMessage({ command: 'snapshot', data: data });
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
