/**
 * Hex Viewer WebView panel for TaskHub.
 * Supports Intel HEX, Motorola SREC, and raw binary files.
 * Uses virtual scrolling for large files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { detectFormat, parseIntelHex, parseSrec, parseBinary, toFlatArray, HexParseResult } from './hexParser';
import { t } from './i18n';
import { DIALOG_SCOPE, showOpenDialogWithMemory } from './dialogMemory';

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * 패널 레지스트리 — **테스트용으로 노출한다** (Memory Map 의 `panelRegistry`
 * 와 같은 형태).
 *
 * 이게 없어서 Hex Viewer 테스트는 순수 함수(`buildHexViewerHtml`)만 부를 수
 * 있었고, 실제 진입점인 `openHexViewerFile` 은 **어느 테스트도 실행하지
 * 않았다**. 패널 생성과 데이터 전송이 그 안에 있어서, 그 구간의 결함은
 * 재현할 하네스 자체가 없었다.
 */
export const hexPanelRegistry = {
    has(): boolean { return currentPanel !== undefined; },
    getTitle(): string | undefined { return currentPanel?.title; },
    getHtml(): string | undefined { return currentPanel?.webview.html; },
    /** 호스트가 웹뷰로 보낸 메시지들 (테스트가 주입한 가짜 패널에서만 채워진다). */
    getPostedMessages(): unknown[] { return postedMessages.slice(); },
    clear(): void {
        currentPanel = undefined;
        currentMessageDisposable?.dispose();
        currentMessageDisposable = undefined;
        postedMessages.length = 0;
    },
};

/** `postHexViewerData` 가 보낸 메시지 기록. 테스트가 순서를 검사한다. */
const postedMessages: unknown[] = [];
// standalone 패널(단일 인스턴스) 전용 메시지 disposable. Custom Editor
// (HexEditorProvider)는 인스턴스가 여러 개일 수 있으므로 resolveCustomEditor
// 지역에서 자체 관리한다 — 전역 하나를 공유하면 패널/에디터를 오갈 때
// 남의 핸들러를 dispose 해 메시지가 끊겼다(M7).
let currentMessageDisposable: vscode.Disposable | undefined;

/** Hex Viewer에서 처리 가능한 최대 파일 크기 (50 MB) */
/**
 * Hex Viewer 가 여는 파일 크기 상한. 넘으면 오류를 띄우고 열지 않는다.
 *
 * 파서의 `HEX_MAX_BYTE_ENTRIES` 와 짝이다 — 이 값이 커지면 HEX/SREC 가 만들 수
 * 있는 entry 수도 함께 커지므로, 둘의 관계를 `hexParserLimits.test.ts` 가
 * 고정한다. export 하는 이유도 그 테스트 때문이다.
 */
export const HEX_VIEWER_MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface HexViewerOpenHistory {
    filePath: string;
    fileName: string;
}

export type HexViewerHistoryRecorder = (entry: HexViewerOpenHistory) => void;

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function showHexViewer(context: vscode.ExtensionContext, recordHistory?: HexViewerHistoryRecorder) {
    const fileUri = await showOpenDialogWithMemory(DIALOG_SCOPE.hexViewer, {
        canSelectMany: false,
        filters: {
            'Supported Files': ['hex', 'ihex', 'srec', 's19', 's28', 's37', 'bin', 'dat'],
            'Hex Files': ['hex', 'ihex'],
            'SREC Files': ['srec', 's19', 's28', 's37'],
            'Binary Files': ['bin', 'dat'],
            'All Files': ['*']
        }
    });
    if (!fileUri || fileUri.length === 0) { return; }

    const filePath = fileUri[0].fsPath;
    if (openHexViewerFile(context, filePath)) {
        recordHistory?.({ filePath, fileName: path.basename(filePath) });
    }
}

export function openHexViewerFile(context: vscode.ExtensionContext, filePath: string): boolean {
    const fileName = path.basename(filePath);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(
            `파일을 읽을 수 없습니다: ${filePath}\n${e.message}`,
            `Cannot read file: ${filePath}\n${e.message}`
        ));
        return false;
    }

    if (stat.size > HEX_VIEWER_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 Hex Viewer 처리 한도(${formatFileSize(HEX_VIEWER_MAX_FILE_SIZE)})를 초과합니다. 대용량 파일은 외부 Hex Editor를 사용해 주세요.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Hex Viewer limit (${formatFileSize(HEX_VIEWER_MAX_FILE_SIZE)}). Please use an external hex editor for large files.`
        ));
        return false;
    }

    let result: HexParseResult;
    try {
        result = parseFile(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(
            `파일 파싱 실패 (${fileName}): ${e.message}`,
            `Failed to parse file (${fileName}): ${e.message}`
        ));
        return false;
    }

    if (result.byteCount === 0) {
        vscode.window.showWarningMessage(t(
            `선택한 파일에 유효한 데이터가 없습니다: ${fileName}`,
            `No valid data found in the selected file: ${fileName}`
        ));
        return false;
    }

    return openPanel(context, fileName, result);
}

function generateHexNonce(): string {
    // CSP nonces are a security control; use a CSPRNG, not Math.random().
    return crypto.randomBytes(16).toString('base64');
}

function buildErrorHtml(webview: vscode.Webview, message: string, tone: 'error' | 'info' = 'error'): string {
    const nonce = generateHexNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const style = tone === 'error'
        ? 'color:var(--vscode-errorForeground,#f44);padding:16px;'
        : 'padding:16px;opacity:0.7;';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><p style="${style}">${esc(message)}</p></body></html>`;
}

/**
 * Maximum address span (inclusive) the Hex Viewer is willing to render.
 * A sparse file with two bytes far apart — e.g. 0x00000000 and 0xFFFFFFFF — passes
 * the per-entry cap in `hexParser` because data.size is small, but would otherwise
 * force a multi-gigabyte flat array + gap bitmap here. Cap at 128 MB of display span.
 */
export const HEX_VIEWER_MAX_SPAN = 128 * 1024 * 1024;

/**
 * Pure guard that throws when the requested address span would exceed
 * `HEX_VIEWER_MAX_SPAN`. Pulled out of `buildHexViewerHtml` so the boundary
 * (`totalSize > HEX_VIEWER_MAX_SPAN`) can be covered by unit tests without
 * allocating the 128 MB flat buffer + bitmap the renderer would otherwise
 * build for a successful span of that size.
 */
export function assertWithinHexViewerSpan(totalSize: number): void {
    if (!Number.isFinite(totalSize) || totalSize < 0 || totalSize > HEX_VIEWER_MAX_SPAN) {
        throw new Error(
            `Hex Viewer address span (${totalSize} bytes) exceeds the display limit (${HEX_VIEWER_MAX_SPAN}).`
            + ` This usually means the file declares a very small number of bytes at widely separated addresses.`
        );
    }
}

/**
 * 가상 스크롤 컨테이너의 단일 element 높이 cap (Chromium ~33,554,400 px).
 * 50MB 파일은 row*ROW_HEIGHT = ~65M px 가 필요해 cap 에 걸려 후반부 row 로 점프가 막힌다.
 * 30M px 는 안전 마진을 두고 cap 미만으로 잡은 값.
 */
export const HEX_VIEWER_SAFE_MAX_HEIGHT = 30_000_000;

/**
 * 전체 가상 컨텐츠 높이 (rowCount * ROW_HEIGHT) 가 `safeMaxHeight` 를 넘으면 1 미만의 비율을
 * 돌려준다. webview 는 이 비율로 spacer height 와 scrollTop ↔ row 매핑을 모두 축소해
 * 브라우저 cap 안에 들어오게 한다. 작은 파일은 1 그대로.
 */
export function computeHexViewerScrollScale(totalContentHeight: number, safeMaxHeight: number): number {
    if (!Number.isFinite(totalContentHeight) || totalContentHeight <= 0) {
        return 1;
    }
    if (!Number.isFinite(safeMaxHeight) || safeMaxHeight <= 0) {
        return 1;
    }
    if (totalContentHeight <= safeMaxHeight) {
        return 1;
    }
    return safeMaxHeight / totalContentHeight;
}

/**
 * 4-byte/8-byte unit 모드에서 hex-cell 의 `data-offset` 은 unit-aligned (0, 4, 8, …) 만
 * 가지므로, 사용자가 unaligned offset (예: Goto 0x123) 으로 selection 한 경우 단순한
 * `cellOffset === selectedOffset` 비교로는 셀이 매칭되지 않는다. 셀의 byte range
 * `[cellOffset, cellOffset + unitSize - 1]` 와 selection range `[selMin, selMax]` 가
 * 겹치는지 판정한다.
 */
export function hexCellOverlapsSelection(
    cellOffset: number,
    unitSize: number,
    selMin: number,
    selMax: number
): boolean {
    const cellEnd = cellOffset + unitSize - 1;
    return cellEnd >= selMin && cellOffset <= selMax;
}

/**
 * Hex Viewer "Go to" 입력 파싱 결과.
 *
 * - `ok`: 입력이 유효하고 표시 범위 안에 들어옴.
 * - `invalid-format`: 10진수 / 16진수 (`0x...`, `...h`) 어느 쪽으로도 해석 못 함, 또는
 *   `Number.MAX_SAFE_INTEGER` 를 넘어 정밀도 손실 가능. 비어있는 입력도 여기로 분류된다.
 * - `out-of-range`: 형식은 맞지만 파일의 마지막 offset (= `totalSize - 1`) 을 벗어남.
 *   `maxOffset` 은 마지막 byte offset, `maxAddress` 는 그 절대주소.
 */
export type HexViewerGoToParseResult =
    | { kind: 'ok'; offset: number }
    | { kind: 'invalid-format' }
    | { kind: 'out-of-range'; maxOffset: number; maxAddress: number };

/**
 * Parse a Hex Viewer "Go to" input.
 *
 * - `0x...` / `...h` are treated as absolute hexadecimal addresses.
 * - bare digits are decimal. They are first accepted as an absolute address
 *   when that falls inside the rendered range, otherwise as a file offset.
 */
export function parseHexViewerGoToOffset(input: string, baseAddress: number, totalSize: number): HexViewerGoToParseResult {
    const value = input.trim().replace(/_/g, '');
    if (!Number.isFinite(baseAddress) || !Number.isFinite(totalSize) || totalSize <= 0) {
        return { kind: 'invalid-format' };
    }
    if (!value) {
        return { kind: 'invalid-format' };
    }

    let parsed: number;
    let allowOffsetFallback = false;
    if (/^0x[0-9a-f]+$/i.test(value)) {
        parsed = Number.parseInt(value.slice(2), 16);
    } else if (/^[0-9a-f]+h$/i.test(value)) {
        parsed = Number.parseInt(value.slice(0, -1), 16);
    } else if (/^[0-9]+$/.test(value)) {
        parsed = Number.parseInt(value, 10);
        allowOffsetFallback = true;
    } else {
        return { kind: 'invalid-format' };
    }

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return { kind: 'invalid-format' };
    }

    const absoluteOffset = parsed - baseAddress;
    if (absoluteOffset >= 0 && absoluteOffset < totalSize) {
        return { kind: 'ok', offset: absoluteOffset };
    }
    if (allowOffsetFallback && parsed < totalSize) {
        return { kind: 'ok', offset: parsed };
    }
    return { kind: 'out-of-range', maxOffset: totalSize - 1, maxAddress: baseAddress + totalSize - 1 };
}

/**
 * 웹뷰로 보낼 바이트 payload. Base64 를 거치지 않는다.
 *
 * 예전에는 이 데이터를 Base64 로 만들어 **HTML 문자열 안에 인라인**했다.
 * 그 경로는 같은 내용을 네 번 복제한다:
 *
 *   1. dense `Uint8Array` (원본)
 *   2. Base64 문자열 (원본의 1.33배)
 *   3. 그 문자열이 박힌 HTML (또 한 벌)
 *   4. 웹뷰의 `atob()` 결과 문자열 → 다시 `Uint8Array`
 *
 * 50MB 파일이면 peak 가 수백 MB 다. `postMessage` 는 구조화 복제로
 * `Uint8Array` 를 그대로 보내므로 2~4가 전부 사라지고, Base64 인코딩과
 * `atob` 디코딩 비용도 함께 없어진다 — 메모리뿐 아니라 속도에서도 이득이다.
 */
export interface HexViewerPayload {
    /** 주소 순서대로 채운 dense 바이트 배열. */
    data: Uint8Array;
    /**
     * 비트당 1바이트: 해당 offset 에 실제 데이터가 있는지.
     * binary 포맷은 전 구간이 채워져 있어 `undefined` 다.
     */
    gap?: Uint8Array;
}

export function buildHexViewerPayload(result: HexParseResult): HexViewerPayload {
    const totalSize = result.maxAddress - result.minAddress + 1;
    assertWithinHexViewerSpan(totalSize);
    const data = toFlatArray(result, result.minAddress, totalSize);

    if (result.rawBuffer) {
        // Binary format: all bytes have data, no gap bitmap needed
        return { data };
    }
    const gap = new Uint8Array(Math.ceil(totalSize / 8));
    for (let i = 0; i < totalSize; i++) {
        if (result.data.has(result.minAddress + i)) {
            gap[Math.floor(i / 8)] |= (1 << (i % 8));
        }
    }
    return { data, gap };
}

/**
 * 데이터를 웹뷰로 보낸다. HTML 을 세팅한 **직후** 불러야 한다.
 *
 * 웹뷰 스크립트는 이 메시지를 받을 때까지 "불러오는 중"을 표시하고, 받은 뒤에
 * 첫 렌더를 한다. HTML 에 데이터가 박혀 있던 예전과 달리 한 프레임 늦지만,
 * Base64 인코딩·`atob`·거대한 HTML 파싱이 사라져 전체 시간은 오히려 줄어든다.
 */
export function postHexViewerData(webview: vscode.Webview, result: HexParseResult): void {
    const payload = buildHexViewerPayload(result);
    const message = { command: 'hexData', data: payload.data, gap: payload.gap };
    postedMessages.push(message);
    void webview.postMessage(message);
}

export function buildHexViewerHtml(fileName: string, result: HexParseResult, webview?: vscode.Webview): string {
    const totalSize = result.maxAddress - result.minAddress + 1;
    assertWithinHexViewerSpan(totalSize);

    return getWebviewContent(
        fileName, result.format, result.minAddress, result.maxAddress,
        result.byteCount, result.entryPoint, !!result.rawBuffer, webview
    );
}

export function parseFile(filePath: string): HexParseResult {
    const rawContent = fs.readFileSync(filePath);
    const textContent = rawContent.toString('utf-8');
    const format = detectFormat(textContent);

    switch (format) {
        case 'intel': return parseIntelHex(textContent);
        case 'srec': return parseSrec(textContent);
        default: return parseBinary(rawContent);
    }
}

/**
 * 호스트 측 메시지 핸들러를 구독하고 disposable을 돌려준다. 호출자가
 * webview/panel 단위로 수명을 관리한다 (standalone 패널은 모듈 전역 1개,
 * custom editor는 resolveCustomEditor 지역 + onDidDispose).
 */
/** `ready` 가 오지 않을 때 그냥 보내 버리는 시한. */
const HEX_READY_FALLBACK_MS = 3000;

/** 이번 패널에서 `ready` 를 받았는가 — 폴백 중복 전송을 막는다. */
let readyReceived = false;

function setupWebviewMessageHandler(webview: vscode.Webview, onReady?: () => void): vscode.Disposable {
    readyReceived = false;
    return webview.onDidReceiveMessage(message => {
        if (message.command === 'ready') {
            readyReceived = true;
            onReady?.();
            return;
        }
        if (message.command === 'copySelection') {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage(t('클립보드에 복사되었습니다.', 'Copied to clipboard.'));
            return;
        }
        if (message.command === 'gotoError') {
            const rawInput = typeof message.input === 'string' ? message.input : '';
            // notification 에 표시할 입력값은 길이를 제한해 UI 가 무너지지 않도록 한다.
            const inputPreview = rawInput.length > 64 ? rawInput.slice(0, 64) + '…' : rawInput;
            if (message.reason === 'invalid-format') {
                vscode.window.showErrorMessage(t(
                    `Go to: 입력 형식이 올바르지 않습니다. 10진수(예: 1024) 또는 16진수(예: 0x400, 400h) 만 허용됩니다. (입력값: "${inputPreview}")`,
                    `Go to: invalid input format. Use decimal (e.g. 1024) or hex (e.g. 0x400, 400h). (got: "${inputPreview}")`
                ));
            } else if (message.reason === 'out-of-range') {
                const maxOffset = typeof message.maxOffset === 'number' ? message.maxOffset : 0;
                const maxAddress = typeof message.maxAddress === 'number' ? message.maxAddress : maxOffset;
                const maxOffsetHex = '0x' + maxOffset.toString(16).toUpperCase();
                const maxAddressHex = '0x' + maxAddress.toString(16).toUpperCase();
                vscode.window.showErrorMessage(t(
                    `Go to: 입력값이 파일 범위를 벗어납니다. 마지막 offset: ${maxOffset} (${maxOffsetHex}), 마지막 주소: ${maxAddressHex}. (입력값: "${inputPreview}")`,
                    `Go to: input is past the end of file. Last offset: ${maxOffset} (${maxOffsetHex}), last address: ${maxAddressHex}. (got: "${inputPreview}")`
                ));
            }
        }
    });
}

function openPanel(context: vscode.ExtensionContext, fileName: string, result: HexParseResult): boolean {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'taskhub.hexViewer',
            `Hex: ${fileName}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        currentPanel.onDidDispose(() => { currentPanel = undefined; currentMessageDisposable?.dispose(); currentMessageDisposable = undefined; });
    }

    currentPanel.title = `Hex: ${fileName}`;
    try {
        // **핸들러를 HTML 보다 먼저 건다.** 웹뷰가 리스너를 등록한 뒤 보내는
        // `ready` 를 받아야 데이터를 보내는데, 그 신호가 핸들러보다 먼저
        // 도착하면 놓친다.
        currentMessageDisposable?.dispose();
        currentMessageDisposable = setupWebviewMessageHandler(currentPanel.webview, () => {
            if (currentPanel) { postHexViewerData(currentPanel.webview, result); }
        });
        currentPanel.webview.html = buildHexViewerHtml(fileName, result, currentPanel.webview);

        // 폴백: `ready` 가 끝내 오지 않아도 데이터는 보낸다. 핸드셰이크가
        // 어떤 이유로든 실패했을 때 **아무것도 안 보내는** 것이 가장 나쁘다.
        // 웹뷰는 같은 데이터를 두 번 받아도 다시 렌더할 뿐이다.
        const panelAtSchedule = currentPanel;
        setTimeout(() => {
            if (currentPanel === panelAtSchedule && !readyReceived) {
                postHexViewerData(panelAtSchedule.webview, result);
            }
        }, HEX_READY_FALLBACK_MS);
    } catch (e: any) {
        const msg = t(
            `Hex Viewer 렌더링 실패 (${fileName}): ${e.message}`,
            `Failed to render Hex Viewer (${fileName}): ${e.message}`
        );
        currentPanel.webview.html = buildErrorHtml(currentPanel.webview, msg, 'error');
        vscode.window.showErrorMessage(msg);
        return false;
    }
    return true;
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Every user-facing string the Hex Viewer webview renders, resolved once in
 * the extension host. Same contract as the JSON Editor bundle: the webview
 * script never holds an English literal, and `{placeholder}` tokens let word
 * order differ per language. Exported for the completeness test.
 *
 * Deliberately absent: example inputs (`20020000`, `Hello`) and short
 * technical identifiers (`u8`, `ASCII`, `Little-Endian`) — per the project's
 * i18n rules those stay as-is in both locales.
 */
export function buildHexViewerStrings(): Record<string, string> {
    return {
        formatLabel: t('형식', 'Format'),
        sizeLabel: t('크기', 'Size'),
        bytesUnit: t('바이트', 'bytes'),
        rangeLabel: t('범위', 'Range'),
        entryLabel: t('진입점', 'Entry'),
        unitLabel: t('단위', 'Unit'),
        unit1: t('1 바이트', '1 Byte'),
        unit2: t('2 바이트 (16비트)', '2 Bytes (16-bit)'),
        unit4: t('4 바이트 (32비트)', '4 Bytes (32-bit)'),
        unit8: t('8 바이트 (64비트)', '8 Bytes (64-bit)'),
        endianLabel: t('엔디안', 'Endian'),
        gotoLabel: t('이동', 'Go to'),
        gotoTitle: t(
            '0x... 또는 ...h: 16진 주소. 숫자만 입력하면 10진수 — 범위 안이면 절대 주소, 아니면 파일 오프셋입니다.',
            '0x... or ...h: hex address. Bare digits: decimal (absolute address inside range, otherwise file offset).'
        ),
        gotoButton: t('이동', 'Go'),
        findButton: t('찾기 (Ctrl+F)', 'Find (Ctrl+F)'),
        findModeLabel: t('찾기 방식', 'Search mode'),
        findModeBytes: t('바이트열', 'Bytes'),
        findModeValue: t('값', 'Value'),
        findInputLabel: t('찾을 내용', 'Search term'),
        findPrev: t('이전 결과', 'Previous match'),
        findNext: t('다음 결과', 'Next match'),
        findClose: t('찾기 닫기', 'Close find'),
        findNoMatches: t('결과 없음', 'No matches'),
        addressHeader: t('주소', 'Address'),
        statusHint: t('바이트를 클릭하면 값을 확인할 수 있습니다', 'Click a byte to inspect'),
        loading: t('불러오는 중…', 'Loading…'),
        loadFailed: t('데이터를 불러오지 못했습니다. 파일을 다시 열어 주세요.', 'Failed to load data. Please reopen the file.'),
        gridLabel: t('16진수 바이트 표 — 화살표 키로 이동, Shift와 함께 누르면 범위 선택', 'Hex byte grid — arrow keys to move, hold Shift to extend the selection'),
        // 상태 표시줄의 첫 항목. 바로 옆 `statusAddress`는 번들에 있는데 이것만
        // 하드코딩돼 있었다 — 정적 마크업이 아니라 innerHTML로 조립되는 자리라
        // 0.6.26 탐지기의 검사 범위 밖이었다.
        statusOffset: t('오프셋', 'Offset'),
        statusAddress: t('주소', 'Address'),
        statusValue: t('값', 'Value'),
        statusNoData: t('데이터 없음', 'no data'),
        statusSelected: t('선택 {n} 바이트', 'Selected: {n} bytes'),
    };
}

function getWebviewContent(
    fileName: string,
    format: string,
    minAddress: number,
    maxAddress: number,
    byteCount: number,
    entryPoint: number | undefined,
    isBinaryFormat: boolean,
    webview?: vscode.Webview
): string {
    const formatLabel = format === 'intel' ? 'Intel HEX' : format === 'srec' ? 'Motorola SREC' : 'Binary';
    const entryStr = entryPoint !== undefined ? `0x${entryPoint.toString(16).toUpperCase().padStart(8, '0')}` : 'N/A';
    const S = buildHexViewerStrings();
    const stringsLiteral = JSON.stringify(S).replace(/</g, '\\u003c');
    const htmlLang = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
    const nonce = generateHexNonce();
    const cspSource = webview?.cspSource ?? 'vscode-webview:';
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`;

    return /*html*/`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hex Viewer</title>
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --border: var(--vscode-panel-border, #444);
        --header-bg: var(--vscode-sideBar-background, #252526);
        --hover: var(--vscode-list-hoverBackground, #2a2d2e);
        --select: var(--vscode-editor-selectionBackground, #264f78);
        --addr-color: var(--vscode-editorLineNumber-foreground, #858585);
        --gap-color: var(--vscode-editorWhitespace-foreground, #3b3b3b);
        --ascii-color: var(--vscode-terminal-ansiGreen, #6a9955);
        --col-header: var(--vscode-editorLineNumber-foreground, #858585);
        --find-bg: var(--vscode-input-background, #3c3c3c);
        --find-border: var(--vscode-input-border, #555);
        --focus-border: var(--vscode-focusBorder, #007fd4);
        --button-bg: var(--vscode-button-background, #0e639c);
        --button-fg: var(--vscode-button-foreground, #fff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        background: var(--bg); color: var(--fg);
        font-family: var(--vscode-editor-font-family, 'Consolas, Courier New, monospace');
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.4;
        overflow: hidden; height: 100vh; display: flex; flex-direction: column;
    }

    /* Header */
    .header {
        padding: 8px 12px; background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    }
    .header .file-info { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .header .file-info span { white-space: nowrap; }
    .header .file-name { font-weight: bold; }
    .header .meta { color: var(--addr-color); font-size: 0.9em; }

    /* Toolbar */
    .toolbar {
        padding: 4px 12px; background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .toolbar label { color: var(--addr-color); font-size: 0.85em; white-space: nowrap; }
    .toolbar select, .toolbar input {
        background: var(--find-bg); color: var(--fg);
        border: 1px solid var(--find-border); border-radius: 3px;
        padding: 2px 6px; font-family: inherit; font-size: inherit;
    }
    .toolbar select:focus, .toolbar input:focus { outline: none; border-color: var(--focus-border); }
    .toolbar input.goto-input { width: 100px; }
    .toolbar button {
        background: var(--button-bg); color: var(--button-fg);
        border: none; border-radius: 3px; padding: 3px 10px; cursor: pointer;
        font-family: inherit; font-size: 0.85em;
    }
    .toolbar button:hover { opacity: 0.85; }
    .toolbar .sep { width: 1px; height: 18px; background: var(--border); }

    /* Find bar */
    .find-bar {
        padding: 4px 12px; background: var(--header-bg);
        border-bottom: 1px solid var(--border);
        display: none; align-items: center; gap: 8px;
    }
    .find-bar.visible { display: flex; }
    .find-bar input { width: 200px; }
    .find-bar .find-info { color: var(--addr-color); font-size: 0.85em; min-width: 100px; }

    /* Hex content - virtual scrolling */
    .hex-container {
        flex: 1; overflow-y: auto; overflow-x: auto;
        padding: 0;
    }
    .hex-table {
        border-collapse: collapse; width: max-content;
    }
    .hex-table thead th {
        position: sticky; top: 0; z-index: 2;
        background: var(--header-bg);
        padding: 4px 0; text-align: center;
        color: var(--col-header); font-weight: normal;
        border-bottom: 1px solid var(--border);
        font-size: 0.85em;
    }
    .hex-table thead th.addr-header { text-align: right; padding-right: 12px; }
    .hex-table thead th.ascii-header { text-align: left; padding-left: 12px; }
    .hex-table thead th.group-sep { width: 6px; }

    .hex-row { cursor: default; }
    .hex-row:hover .hex-cell, .hex-row:hover .ascii-cell, .hex-row:hover .addr-cell {
        background: var(--hover);
    }
    .addr-cell {
        color: var(--addr-color); text-align: right;
        padding: 1px 12px 1px 8px; user-select: none; white-space: nowrap;
    }
    .hex-cell {
        text-align: center; padding: 1px 2px;
        cursor: pointer; white-space: nowrap;
        min-width: 22px;
    }
    .hex-cell.gap { color: var(--gap-color); }
    /* 파일 끝에서 unit 을 다 채우지 못한 셀. 값은 정확하되 자리수가 짧으므로
       흐리게 표시해 "여기가 끝" 임을 알린다. */
    .hex-cell.partial-unit { opacity: 0.75; font-style: italic; }
    .hex-cell.selected { background: var(--select); border-radius: 2px; }
    .hex-cell.find-highlight { background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); border-radius: 2px; }
    .hex-cell.find-current { background: var(--vscode-editor-findMatchBackground, #515c6a); border-radius: 2px; }

    .group-sep-cell { width: 6px; }

    .ascii-cell {
        padding: 1px 2px; cursor: pointer; white-space: pre;
        color: var(--ascii-color);
    }
    .ascii-cell.gap { color: var(--gap-color); }
    .ascii-cell.selected { background: var(--select); border-radius: 2px; }
    .ascii-sep { width: 12px; border-left: 1px solid var(--border); }

    /* Status bar */
    .status-bar {
        padding: 4px 12px; background: var(--header-bg);
        border-top: 1px solid var(--border);
        display: flex; gap: 16px; font-size: 0.85em; color: var(--addr-color);
        flex-wrap: wrap;
    }
    .status-bar span { white-space: nowrap; }
</style>
</head>
<body>
    <div class="header">
        <div class="file-info">
            <span class="file-name">${esc(fileName)}</span>
            <span class="meta">${esc(S.formatLabel)}: ${formatLabel}</span>
            <span class="meta">${esc(S.sizeLabel)}: ${byteCount.toLocaleString()} ${esc(S.bytesUnit)}</span>
            <span class="meta">${esc(S.rangeLabel)}: 0x${minAddress.toString(16).toUpperCase().padStart(8, '0')} – 0x${maxAddress.toString(16).toUpperCase().padStart(8, '0')}</span>
            <span class="meta">${esc(S.entryLabel)}: ${entryStr}</span>
        </div>
    </div>
    <div class="toolbar">
        <label for="unitSize">${esc(S.unitLabel)}:</label>
        <select id="unitSize">
            <option value="1" selected>${esc(S.unit1)}</option>
            <option value="2">${esc(S.unit2)}</option>
            <option value="4">${esc(S.unit4)}</option>
            <option value="8">${esc(S.unit8)}</option>
        </select>
        <label for="endian">${esc(S.endianLabel)}:</label>
        <select id="endian">
            <option value="little" selected>Little-Endian</option>
            <option value="big">Big-Endian</option>
        </select>
        <div class="sep"></div>
        <label for="gotoInput">${esc(S.gotoLabel)}:</label>
        <input type="text" id="gotoInput" class="goto-input" placeholder="0x08000000 / 1024" title="${esc(S.gotoTitle)}">
        <button id="gotoBtn">${esc(S.gotoButton)}</button>
        <div class="sep"></div>
        <button id="findBtn">${esc(S.findButton)}</button>
    </div>
    <div class="find-bar" id="findBar">
        <select id="findMode" aria-label="${esc(S.findModeLabel)}">
            <option value="bytes">${esc(S.findModeBytes)}</option>
            <option value="value" selected>${esc(S.findModeValue)}</option>
            <option value="ascii">ASCII</option>
        </select>
        <input type="text" id="findHexInput" placeholder="20020000" aria-label="${esc(S.findInputLabel)}">
        <button id="findPrev" aria-label="${esc(S.findPrev)}" title="${esc(S.findPrev)}">◀</button>
        <button id="findNext" aria-label="${esc(S.findNext)}" title="${esc(S.findNext)}">▶</button>
        <span class="find-info" id="findInfo" role="status" aria-live="polite"></span>
        <button id="findClose" aria-label="${esc(S.findClose)}" title="${esc(S.findClose)}">✕</button>
    </div>
    <!-- 단일 tab stop + 화살표 이동. 행이 가상 스크롤로 만들어졌다 사라지므로
         셀마다 tabindex를 주면 Tab stop이 수천 개 생기고, 스크롤 밖으로 나간
         셀에 포커스가 남아 사라지는 문제도 생긴다. 격자에는 "Tab으로 진입,
         화살표로 내부 이동"이 표준 패턴이다. -->
    <!-- 데이터가 postMessage 로 도착하기 전까지 표시. 빈 표를 그대로 두면
         사용자가 "파일이 비었나"로 읽는다. role=status 라 스크린리더에도 전달된다. -->
    <div id="hexLoading" role="status" aria-live="polite"
         style="padding:16px;opacity:0.7">${esc(S.loading)}</div>
    <div class="hex-container" id="hexContainer" tabindex="0" role="grid"
         aria-label="${esc(S.gridLabel)}">
        <table class="hex-table" id="hexTable">
            <thead id="hexHead"></thead>
            <tbody id="hexBody"></tbody>
        </table>
    </div>
    <div class="status-bar" id="statusBar" role="status" aria-live="polite">
        <span>${esc(S.statusHint)}</span>
    </div>

<script nonce="${nonce}">
(function() {
    const vscode = acquireVsCodeApi();
    // Locale-resolved labels from the host (buildHexViewerStrings).
    const S = ${stringsLiteral};
    function fmt(template, values) {
        return String(template).replace(/\\{(\\w+)\\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }
    const BASE_ADDR = ${minAddress};
    const TOTAL_SIZE = ${maxAddress - minAddress + 1};
    const IS_BINARY = ${isBinaryFormat};

    // 데이터는 HTML 에 박혀 오지 않고 postMessage 로 도착한다 —
    // Base64 인코딩 / atob / 거대한 HTML 파싱을 모두 없애기 위해서다
    // (buildHexViewerPayload 주석 참조). 도착 전까지는 빈 배열이라
    // 어떤 렌더 함수가 먼저 불려도 예외 없이 빈 화면을 그린다.
    let DATA = new Uint8Array(0);
    let GAP_BITMAP = null;

    function hasData(offset) {
        if (IS_BINARY) { return offset >= 0 && offset < TOTAL_SIZE; }
        if (!GAP_BITMAP) { return false; }
        return (GAP_BITMAP[Math.floor(offset / 8)] & (1 << (offset % 8))) !== 0;
    }

    function hasDataRange(offset, size) {
        if (offset < 0 || offset + size > TOTAL_SIZE) { return false; }
        for (let i = 0; i < size; i++) {
            if (!hasData(offset + i)) { return false; }
        }
        return true;
    }

    let unitSize = 1;
    let endian = 'little';
    let selectedOffset = -1;
    let selectedEndOffset = -1;
    let findMatches = [];
    let findCurrentIdx = -1;

    const BYTES_PER_ROW = 16;
    const ROW_HEIGHT = 20; // px, approximate height of one row
    const BUFFER_ROWS = 20; // extra rows to render above/below viewport
    // 브라우저 single-element max height (~33M px) 를 안전하게 피하기 위한 cap.
    // 큰 파일에서는 spacer height 와 scrollTop↔row 매핑을 이 비율로 축소한다.
    const SAFE_MAX_HEIGHT = ${HEX_VIEWER_SAFE_MAX_HEIGHT};

    const hexContainer = document.getElementById('hexContainer');
    const hexHead = document.getElementById('hexHead');
    const hexBody = document.getElementById('hexBody');
    const statusBar = document.getElementById('statusBar');
    const unitSelect = document.getElementById('unitSize');
    const endianSelect = document.getElementById('endian');
    const gotoInput = document.getElementById('gotoInput');
    const findBar = document.getElementById('findBar');
    const findHexInput = document.getElementById('findHexInput');
    const findInfo = document.getElementById('findInfo');

    const totalRowCount = Math.ceil(TOTAL_SIZE / BYTES_PER_ROW);

    // 가상 스크롤 좌표계 — 큰 파일에서는 scaled space, 작은 파일에서는 1:1 (real space).
    const totalContentHeight = totalRowCount * ROW_HEIGHT;
    const scrollScale = totalContentHeight > SAFE_MAX_HEIGHT && SAFE_MAX_HEIGHT > 0
        ? SAFE_MAX_HEIGHT / totalContentHeight
        : 1;
    const scaledRowHeight = ROW_HEIGHT * scrollScale;
    function rowToScrollTop(rowIndex) { return rowIndex * scaledRowHeight; }
    function scrollTopToRow(scrollTop) {
        if (scaledRowHeight <= 0) { return 0; }
        return Math.floor(scrollTop / scaledRowHeight);
    }

    // Virtual scrolling state
    let visibleStartRow = 0;
    let visibleEndRow = 0;
    let renderedStartRow = -1;
    let renderedEndRow = -1;

    function readUnit(offset, size, le) {
        if (offset + size > TOTAL_SIZE) { return null; }
        let val = 0n;
        for (let i = 0; i < size; i++) {
            const b = BigInt(DATA[offset + (le ? i : size - 1 - i)]);
            val = val | (b << BigInt(i * 8));
        }
        return val;
    }

    /** 이 offset 에서 파일 끝까지 남은 바이트 수 (unit 보다 작을 수 있다). */
    function unitBytesAt(offset) {
        return Math.max(0, Math.min(unitSize, TOTAL_SIZE - offset));
    }

    function formatHex(val, digits) {
        return val.toString(16).toUpperCase().padStart(digits, '0');
    }

    function formatAddr(addr) {
        return '0x' + formatHex(addr, 8);
    }

    function unitHexDigits() { return unitSize * 2; }

    function unitsPerRow() { return BYTES_PER_ROW / unitSize; }

    function groupEvery() {
        if (unitSize === 1) { return 4; }
        if (unitSize === 2) { return 2; }
        return 1;
    }

    function buildHeader() {
        const upr = unitsPerRow();
        const ge = groupEvery();
        let html = '<tr><th class="addr-header" scope="col">' + S.addressHeader + '</th>';
        for (let i = 0; i < upr; i++) {
            if (i > 0 && i % ge === 0) {
                html += '<th class="group-sep" aria-hidden="true"></th>';
            }
            const offsetLabel = formatHex(i * unitSize, 2);
            html += '<th scope="col">' + offsetLabel + '</th>';
        }
        html += '<th class="ascii-sep" aria-hidden="true"></th>';
        html += '<th class="ascii-header" scope="col">ASCII</th></tr>';
        hexHead.innerHTML = html;
    }

    function buildRow(row) {
        const upr = unitsPerRow();
        const ge = groupEvery();
        const digits = unitHexDigits();
        const le = endian === 'little';
        const rowOffset = row * BYTES_PER_ROW;
        const rowAddr = BASE_ADDR + rowOffset;

        const tr = document.createElement('tr');
        tr.className = 'hex-row';
        tr.dataset.row = String(row);

        // Address cell
        const addrTd = document.createElement('td');
        addrTd.className = 'addr-cell';
        addrTd.textContent = formatAddr(rowAddr);
        tr.appendChild(addrTd);

        // Hex cells
        for (let i = 0; i < upr; i++) {
            if (i > 0 && i % ge === 0) {
                const sepTd = document.createElement('td');
                sepTd.className = 'group-sep-cell';
                tr.appendChild(sepTd);
            }

            const byteOffset = rowOffset + i * unitSize;
            const td = document.createElement('td');
            td.className = 'hex-cell';

            // 파일 끝의 **불완전한 unit 도 렌더**한다. 예전에는 완전한 unit
            // 에만 셀을 만들어, 18바이트 파일의 4-byte 모드에서 offset 16 이
            // 화면에 없었다. 그 결과 Go to / Find / 키보드가 존재하지 않는
            // 셀을 가리켰고, 이를 clamp 로 막으면 이번엔 요청한 주소를 조용히
            // 다른 주소로 바꾸게 된다. 표현할 수 있는 것을 표현하는 편이
            // 어느 쪽보다 정직하다.
            const availableBytes = unitBytesAt(byteOffset);
            if (availableBytes > 0) {
                // 남은 바이트만으로 읽는다. 완전한 unit 이면 종전과 동일.
                const val = readUnit(byteOffset, availableBytes, le);
                const shownDigits = availableBytes * 2;
                // BigInt 그대로 포맷 — Number() 변환은 8-byte unit에서 2^53
                // 초과 값의 정밀도를 깨뜨린다(M5). toString(16)은 BigInt에서도 동작.
                const text = val !== null
                    ? formatHex(val & BigInt('0x' + 'F'.repeat(shownDigits)), shownDigits)
                    : '';
                // 자리수를 unit 폭에 맞춰 앞을 비운다 — 열 정렬이 흐트러지지
                // 않으면서 "여기는 unit 이 덜 찼다"가 눈에 보인다.
                td.textContent = text.padStart(digits, ' ');
                td.dataset.offset = String(byteOffset);
                if (availableBytes < unitSize) { td.classList.add('partial-unit'); }

                let isGap = true;
                for (let b = 0; b < availableBytes; b++) {
                    if (hasData(byteOffset + b)) { isGap = false; break; }
                }
                if (isGap) { td.classList.add('gap'); }
            } else {
                td.textContent = ' '.repeat(digits);
            }
            tr.appendChild(td);
        }

        // ASCII separator
        const sepTd = document.createElement('td');
        sepTd.className = 'ascii-sep';
        tr.appendChild(sepTd);

        // ASCII cell
        const asciiTd = document.createElement('td');
        asciiTd.className = 'ascii-cell';
        let asciiText = '';
        for (let b = 0; b < BYTES_PER_ROW; b++) {
            const off = rowOffset + b;
            if (off < TOTAL_SIZE) {
                const byte = DATA[off];
                if (!hasData(off)) {
                    asciiText += '·';
                } else if (byte >= 0x20 && byte <= 0x7e) {
                    asciiText += String.fromCharCode(byte);
                } else {
                    asciiText += '.';
                }
            }
        }
        asciiTd.textContent = asciiText;
        asciiTd.dataset.rowOffset = String(rowOffset);
        tr.appendChild(asciiTd);

        return tr;
    }

    function calcVisibleRange() {
        const scrollTop = hexContainer.scrollTop;
        const clientHeight = hexContainer.clientHeight;
        // scaled space → real row 변환. visible row 갯수는 viewport 의 실제 픽셀
        // (clientHeight) 에 맞춰 ROW_HEIGHT 단위로 잡는다 — scaled 일 때 viewport 가
        // scaled space 에서 cover 하는 row 갯수가 늘어나도, DOM 에 그릴 rows 는
        // 실제 화면에 들어오는 만큼만으로 충분.
        const topRow = scrollTopToRow(scrollTop);
        const visibleRowsInViewport = Math.ceil(clientHeight / ROW_HEIGHT);
        const startRow = Math.max(0, topRow - BUFFER_ROWS);
        const endRow = Math.min(totalRowCount, topRow + visibleRowsInViewport + BUFFER_ROWS);
        return { startRow, endRow };
    }

    function renderVisibleRows() {
        const { startRow, endRow } = calcVisibleRange();

        if (startRow === renderedStartRow && endRow === renderedEndRow) { return; }

        visibleStartRow = startRow;
        visibleEndRow = endRow;

        const frag = document.createDocumentFragment();

        // Top spacer row — scaled space (scrollScale=1 인 작은 파일에서는 real space 와 동일).
        if (startRow > 0) {
            const topSpacer = document.createElement('tr');
            const topTd = document.createElement('td');
            topTd.style.height = (startRow * scaledRowHeight) + 'px';
            topTd.style.padding = '0';
            topTd.style.border = 'none';
            topSpacer.appendChild(topTd);
            frag.appendChild(topSpacer);
        }

        // Visible rows
        for (let row = startRow; row < endRow; row++) {
            frag.appendChild(buildRow(row));
        }

        // Bottom spacer row — scaled space.
        const bottomRows = totalRowCount - endRow;
        if (bottomRows > 0) {
            const bottomSpacer = document.createElement('tr');
            const bottomTd = document.createElement('td');
            bottomTd.style.height = (bottomRows * scaledRowHeight) + 'px';
            bottomTd.style.padding = '0';
            bottomTd.style.border = 'none';
            bottomSpacer.appendChild(bottomTd);
            frag.appendChild(bottomSpacer);
        }

        hexBody.innerHTML = '';
        hexBody.appendChild(frag);

        renderedStartRow = startRow;
        renderedEndRow = endRow;

        applySelectionToVisible();
        applyFindHighlightsToVisible();
    }

    function render() {
        buildHeader();
        renderedStartRow = -1;
        renderedEndRow = -1;
        renderVisibleRows();
    }

    let scrollRaf = 0;
    hexContainer.addEventListener('scroll', () => {
        if (scrollRaf) { return; }
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            renderVisibleRows();
        });
    });

    function applySelectionToVisible() {
        if (selectedOffset < 0) { return; }
        const endOff = selectedEndOffset >= 0 ? selectedEndOffset : selectedOffset;
        const minOff = Math.min(selectedOffset, endOff);
        const maxOff = Math.max(selectedOffset, endOff);

        // unit > 1 일 때 셀의 data-offset 은 unit-aligned 이고 셀 하나가 unitSize bytes 를
        // 표현하므로, [cellOffset, cellOffset+unitSize-1] vs [minOff, maxOff] overlap 판정.
        // hexCellOverlapsSelection (TS export) 와 동일 로직 — 단위 테스트로 보증됨.
        hexBody.querySelectorAll('.hex-cell[data-offset]').forEach(el => {
            const off = parseInt(el.dataset.offset, 10);
            const cellEnd = off + unitSize - 1;
            if (cellEnd >= minOff && off <= maxOff) {
                el.classList.add('selected');
            }
        });
    }

    function updateSelection() {
        document.querySelectorAll('.hex-cell.selected, .ascii-cell.selected').forEach(el => el.classList.remove('selected'));
        if (selectedOffset < 0) { return; }
        applySelectionToVisible();
        const endOff = selectedEndOffset >= 0 ? selectedEndOffset : selectedOffset;
        updateStatusBar(Math.min(selectedOffset, endOff), Math.max(selectedOffset, endOff));
    }

    function updateStatusBar(minOff, maxOff) {
        const le = endian === 'little';
        const addr = BASE_ADDR + minOff;
        // 마지막 unit 은 덜 찼을 수 있으므로 파일 끝을 넘겨 세지 않는다.
        // 더하기 unitSize 로 고정하면 18바이트 파일에서 "선택 20 바이트" 처럼
        // 실제 파일보다 큰 값이 표시됐다.
        const selSize = Math.min(maxOff - minOff + unitSize, Math.max(0, TOTAL_SIZE - minOff));
        const dataSpan = selSize;
        const selectionHasData = dataSpan > 0 && hasDataRange(minOff, dataSpan);
        let html = '<span>' + S.statusOffset + ': 0x' + formatHex(minOff, 8) + '</span>';
        html += '<span>' + S.statusAddress + ': ' + formatAddr(addr) + '</span>';

        if (!selectionHasData) {
            html += '<span>' + S.statusValue + ': ' + S.statusNoData + '</span>';
        } else {
            if (selSize === 1) {
                const b = DATA[minOff];
                html += '<span>' + S.statusValue + ': 0x' + formatHex(b, 2) + ' (' + b + ')</span>';
            }
            if (selSize >= 1 && hasDataRange(minOff, 1)) {
                const u8 = DATA[minOff];
                html += '<span>u8: ' + u8 + '</span>';
            }
            if (selSize >= 2 && minOff + 2 <= TOTAL_SIZE && hasDataRange(minOff, 2)) {
                const v = Number(readUnit(minOff, 2, le));
                html += '<span>u16: 0x' + formatHex(v, 4) + ' (' + v + ')</span>';
            }
            if (selSize >= 4 && minOff + 4 <= TOTAL_SIZE && hasDataRange(minOff, 4)) {
                const v = Number(readUnit(minOff, 4, le));
                html += '<span>u32: 0x' + formatHex(v, 8) + ' (' + v + ')</span>';
            }
        }
        if (selSize > unitSize) {
            html += '<span>' + fmt(S.statusSelected, { n: selSize }) + '</span>';
        }
        statusBar.innerHTML = html;
    }

    // Click handler on hex cells
    hexBody.addEventListener('click', (e) => {
        const cell = e.target.closest('.hex-cell[data-offset]');
        if (!cell) { return; }
        const off = parseInt(cell.dataset.offset, 10);
        if (e.shiftKey && selectedOffset >= 0) {
            selectedEndOffset = off;
        } else {
            selectedOffset = off;
            selectedEndOffset = off;
        }
        updateSelection();
    });

    // 키보드 선택. 클릭 전용이라 마우스 없이는 어떤 바이트도 검사할 수 없었다
    // — 표를 읽을 수는 있으나 뷰어의 본래 용도인 "값 확인"이 불가능했다.
    hexContainer.addEventListener('keydown', (e) => {
        // Go to 입력 등 컨테이너 안의 폼 요소에서 누른 키는 그쪽 것이다.
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { return; }

        const perRow = BYTES_PER_ROW;
        let delta = 0;
        switch (e.key) {
            case 'ArrowLeft':  delta = -unitSize; break;
            case 'ArrowRight': delta = unitSize; break;
            case 'ArrowUp':    delta = -perRow; break;
            case 'ArrowDown':  delta = perRow; break;
            case 'PageUp':     delta = -perRow * 16; break;
            case 'PageDown':   delta = perRow * 16; break;
            case 'Home':
            case 'End':
                break;
            default:
                return;
        }
        e.preventDefault();

        // 경계는 jumpToOffset 과 같은 규칙을 쓴다 (lastSelectableOffset).
        // 파일이 unit 하나보다 작으면 고를 수 있는 셀 자체가 없다.
        const lastUnitStart = lastSelectableOffset();
        if (lastUnitStart < 0) { return; }

        // 아직 아무것도 고르지 않았으면 첫 바이트에서 시작한다.
        const current = selectedEndOffset >= 0 ? selectedEndOffset
            : (selectedOffset >= 0 ? selectedOffset : 0);
        let next;
        if (e.key === 'Home') {
            next = 0;
        } else if (e.key === 'End') {
            next = lastUnitStart;
        } else {
            next = current + delta;
        }
        next = Math.max(0, Math.min(next, lastUnitStart));
        next = Math.floor(next / unitSize) * unitSize;

        if (e.shiftKey && selectedOffset >= 0) {
            // 시작점을 고정한 채 끝점만 옮긴다 — Shift+클릭과 같은 의미.
            selectedEndOffset = next;
            updateSelection();
            const cell = hexBody.querySelector('.hex-cell[data-offset="' + next + '"]');
            if (cell && typeof cell.scrollIntoView === 'function') {
                cell.scrollIntoView({ block: 'nearest' });
            } else {
                scrollToRow(Math.floor(next / perRow));
            }
        } else {
            // jumpToOffset이 선택 갱신 · 스크롤 · 재렌더를 모두 처리한다.
            jumpToOffset(next);
        }
    });

    // Unit size change
    unitSelect.addEventListener('change', () => {
        unitSize = parseInt(unitSelect.value, 10);
        selectedOffset = -1;
        selectedEndOffset = -1;
        render();
    });

    // Endian change
    endianSelect.addEventListener('change', () => {
        endian = endianSelect.value;
        render();
    });

    // Go to address
    function scrollToRow(rowIndex) {
        // scaled space 의 좌표로 환산해 scrollTop 을 잡는다 (작은 파일은 scale=1 이라 그대로).
        const targetTop = rowToScrollTop(rowIndex);
        const containerHeight = hexContainer.clientHeight;
        hexContainer.scrollTop = Math.max(0, targetTop - containerHeight / 2);
        renderVisibleRows();
    }

    /**
     * 선택 가능한 마지막 offset — 마지막 unit 셀의 시작.
     *
     * 이제 불완전한 unit 도 렌더하므로(unitBytesAt 참조) 파일 안의 모든
     * unit 경계에 셀이 존재한다. 따라서 이 값은 "화면에 없는 곳"을 걸러내는
     * 용도가 아니라, 키보드 이동이 파일 끝을 넘지 않게 하는 상한일 뿐이다.
     *
     * 0.6.36 초안에서는 여기서 **마지막 완전한 unit** 을 돌려주고
     * jumpToOffset 이 입력을 그 값으로 clamp 했는데, 그러면 "Go to 17" 이
     * 조용히 12 로 바뀌고 Find 도 같은 함수를 타므로 끝부분 검색 결과가 엉뚱한
     * 위치를 가리켰다 — 존재하지 않는 셀을 고르는 것보다 나쁜 동작이었다.
     */
    function lastSelectableOffset() {
        if (TOTAL_SIZE <= 0) { return -1; }
        return Math.floor((TOTAL_SIZE - 1) / unitSize) * unitSize;
    }

    function jumpToOffset(offset) {
        if (typeof offset !== 'number' || offset < 0 || offset >= TOTAL_SIZE) { return; }
        // 요청한 주소를 바꾸지 않는다. 파일 안의 주소면 그 주소를 담은 unit
        // 셀이 반드시 존재하므로(불완전한 unit 도 렌더된다) 정렬만 하면 된다.
        const rowIndex = Math.floor(offset / BYTES_PER_ROW);
        selectedOffset = offset;
        selectedEndOffset = offset;
        // scrollToRow 가 scrollTop 을 중앙으로 맞추고 renderVisibleRows() 까지 호출한다.
        scrollToRow(rowIndex);
        // 다음 frame: scrollIntoView 로 미세 보정(block: 'nearest' 라 이미 중앙인 row 는 안 움직임) →
        // 그 결과 scroll 위치 변화를 반영해 마지막에 render/select/highlight 를 한 번 더 실행.
        requestAnimationFrame(() => {
            // unit-aligned 좌표만 cell 의 data-offset 으로 존재 — Goto 0x123 + 4-byte unit 처럼
            // unaligned 입력일 때 그 byte 를 포함하는 셀(0x120) 을 찾도록 정렬해서 조회한다.
            const alignedOffset = Math.floor(offset / unitSize) * unitSize;
            const cell = hexBody.querySelector('.hex-cell[data-offset="' + alignedOffset + '"]');
            if (cell && typeof cell.scrollIntoView === 'function') {
                cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
            renderVisibleRows();
            updateSelection();
            applyFindHighlightsToVisible();
        });
    }

    // src/hexViewer.ts 의 parseHexViewerGoToOffset 를 그대로 주입해 단일 출처를 유지한다.
    // (TS 함수가 외부 식별자에 의존하지 않는 self-contained pure 함수라는 전제를 깨면 webview 가 깨진다.)
    const parseGoToOffset = (${parseHexViewerGoToOffset.toString()});

    function goToAddress() {
        const rawInput = gotoInput.value;
        // 빈 입력은 사용자가 의도하지 않은 키누름일 수 있어 silent 무시 — 오류는 띄우지 않는다.
        if (!rawInput.trim()) { return; }
        const result = parseGoToOffset(rawInput, BASE_ADDR, TOTAL_SIZE);
        if (result.kind === 'ok') {
            jumpToOffset(result.offset);
            return;
        }
        if (result.kind === 'invalid-format') {
            vscode.postMessage({ command: 'gotoError', reason: 'invalid-format', input: rawInput });
        } else if (result.kind === 'out-of-range') {
            vscode.postMessage({
                command: 'gotoError',
                reason: 'out-of-range',
                input: rawInput,
                maxOffset: result.maxOffset,
                maxAddress: result.maxAddress
            });
        }
    }

    document.getElementById('gotoBtn').addEventListener('click', goToAddress);
    gotoInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            goToAddress();
        }
    });

    // Find
    function toggleFind() {
        findBar.classList.toggle('visible');
        if (findBar.classList.contains('visible')) {
            findHexInput.focus();
        }
    }

    function parseFindBytes(input) {
        const clean = input.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length === 0 || clean.length % 2 !== 0) { return null; }
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substring(i, i + 2), 16));
        }
        return bytes;
    }

    function parseFindValue(input) {
        const clean = input.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length === 0 || clean.length % 2 !== 0) { return null; }
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substring(i, i + 2), 16));
        }
        if (endian === 'little') {
            bytes.reverse();
        }
        return bytes;
    }

    function parseFindAscii(input) {
        if (input.length === 0) { return null; }
        const bytes = [];
        for (let i = 0; i < input.length; i++) {
            bytes.push(input.charCodeAt(i) & 0xFF);
        }
        return bytes;
    }

    function getFindBytes() {
        const mode = document.getElementById('findMode').value;
        if (mode === 'value') {
            return parseFindValue(findHexInput.value);
        }
        if (mode === 'ascii') {
            return parseFindAscii(findHexInput.value);
        }
        return parseFindBytes(findHexInput.value);
    }

    // 매치 수 상한 — 무제한 수집은 한 바이트 패턴 검색 등에서 수백만 개의
    // 매치를 만들고 하이라이트 루프까지 함께 무너뜨린다(M11).
    const FIND_MAX_MATCHES = 10000;

    function findCountLabel() {
        return findMatches.length >= FIND_MAX_MATCHES
            ? FIND_MAX_MATCHES.toLocaleString() + '+'
            : String(findMatches.length);
    }

    function doFind() {
        findMatches = [];
        findCurrentIdx = -1;
        const bytes = getFindBytes();
        if (!bytes || bytes.length === 0) {
            findInfo.textContent = '';
            applyFindHighlightsToVisible();
            return;
        }
        for (let i = 0; i <= TOTAL_SIZE - bytes.length; i++) {
            let match = true;
            for (let j = 0; j < bytes.length; j++) {
                if (DATA[i + j] !== bytes[j]) { match = false; break; }
            }
            if (match) {
                findMatches.push(i);
                if (findMatches.length >= FIND_MAX_MATCHES) { break; }
            }
        }
        if (findMatches.length > 0) {
            findCurrentIdx = 0;
            goToFindMatch();
        } else {
            findInfo.textContent = S.findNoMatches;
        }
        applyFindHighlightsToVisible();
    }

    function goToFindMatch() {
        if (findCurrentIdx < 0 || findCurrentIdx >= findMatches.length) { return; }
        const offset = findMatches[findCurrentIdx];
        findInfo.textContent = (findCurrentIdx + 1) + ' / ' + findCountLabel();
        jumpToOffset(offset);
    }

    function applyFindHighlightsToVisible() {
        document.querySelectorAll('.hex-cell.find-highlight, .hex-cell.find-current').forEach(el => {
            el.classList.remove('find-highlight', 'find-current');
        });
        if (findMatches.length === 0) { return; }

        const bytes = getFindBytes();
        if (!bytes) { return; }

        // Build sets only for visible range
        const visStartOff = visibleStartRow * BYTES_PER_ROW;
        const visEndOff = visibleEndRow * BYTES_PER_ROW;

        const matchSet = new Set();
        const currentSet = new Set();
        for (let mi = 0; mi < findMatches.length; mi++) {
            const mOff = findMatches[mi];
            if (mOff + bytes.length < visStartOff || mOff > visEndOff + BYTES_PER_ROW) { continue; }
            for (let j = 0; j < bytes.length; j++) {
                const off = mOff + j;
                const unitOff = Math.floor(off / unitSize) * unitSize;
                matchSet.add(unitOff);
                if (mi === findCurrentIdx) { currentSet.add(unitOff); }
            }
        }

        hexBody.querySelectorAll('.hex-cell[data-offset]').forEach(el => {
            const off = parseInt(el.dataset.offset, 10);
            if (currentSet.has(off)) {
                el.classList.add('find-current');
            } else if (matchSet.has(off)) {
                el.classList.add('find-highlight');
            }
        });
    }

    document.getElementById('findBtn').addEventListener('click', toggleFind);
    document.getElementById('findClose').addEventListener('click', () => {
        findBar.classList.remove('visible');
        findMatches = [];
        findCurrentIdx = -1;
        findInfo.textContent = '';
        applyFindHighlightsToVisible();
    });
    // 키 입력마다 전체 데이터를 스캔하면 대용량 파일에서 웹뷰가 수 초씩
    // 멈춘다(M11) — memoryMapViewer의 searchTimeout 패턴과 동일한 디바운스.
    let findDebounceTimer;
    findHexInput.addEventListener('input', () => {
        clearTimeout(findDebounceTimer);
        findDebounceTimer = setTimeout(doFind, 250);
    });
    document.getElementById('findMode').addEventListener('change', () => {
        const mode = document.getElementById('findMode').value;
        findHexInput.placeholder = mode === 'ascii' ? 'Hello' : mode === 'value' ? '20020000' : '00 00 02 20';
        doFind();
    });
    document.getElementById('findNext').addEventListener('click', () => {
        if (findMatches.length === 0) { return; }
        findCurrentIdx = (findCurrentIdx + 1) % findMatches.length;
        goToFindMatch();
    });
    document.getElementById('findPrev').addEventListener('click', () => {
        if (findMatches.length === 0) { return; }
        findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length;
        goToFindMatch();
    });

    function buildCopyText(minOff, maxOff) {
        const le = endian === 'little';
        const digits = unitHexDigits();
        const parts = [];
        for (let off = minOff; off < maxOff && off < TOTAL_SIZE; off += unitSize) {
            // 남은 바이트만 읽는다. 완전한 unit 을 고집하면 파일 끝의 1~7
            // 바이트가 readUnit 의 null 로 빠져 **복사 결과에서 통째로
            // 사라졌다** — 화면에는 보이는데 복사하면 없는 상태였다.
            const available = unitBytesAt(off);
            if (available <= 0) { break; }
            const val = readUnit(off, available, le);
            if (val !== null) {
                const shownDigits = available * 2;
                // BigInt 그대로 포맷 — Number() 변환은 2^53 초과 값을 깨뜨린다(M5)
                parts.push(formatHex(val & BigInt('0x' + 'F'.repeat(shownDigits)), shownDigits));
            }
        }
        return parts.join(' ');
    }

    // Intercept copy to format properly
    document.addEventListener('copy', (e) => {
        if (selectedOffset >= 0) {
            const endOff = selectedEndOffset >= 0 ? selectedEndOffset : selectedOffset;
            const minOff = Math.min(selectedOffset, endOff);
            const maxOff = Math.max(selectedOffset, endOff) + unitSize;
            e.clipboardData.setData('text/plain', buildCopyText(minOff, maxOff));
            e.preventDefault();
            return;
        }
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) {
            const cleaned = sel.toString()
                .replace(/\t+/g, ' ')
                .replace(/ {2,}/g, ' ');
            e.clipboardData.setData('text/plain', cleaned);
            e.preventDefault();
        }
    });

    // Ctrl+F
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            toggleFind();
        }
    });

    // --- 데이터 도착을 기다린다 ---
    //
    // HTML 에 Base64 로 박아 넣던 것을 postMessage 로 바꿨으므로, 첫 렌더는
    // 데이터가 온 뒤에 한다. 그 사이에는 "불러오는 중"을 보여 준다 — 빈 표를
    // 그대로 두면 사용자가 "파일이 비었나"로 읽는다.
    const loadingEl = document.getElementById('hexLoading');
    let dataArrived = false;

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.command !== 'hexData') { return; }
        // 구조화 복제로 온 Uint8Array 를 그대로 쓴다 — 복사하지 않는다.
        DATA = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
        if (msg.gap) {
            GAP_BITMAP = msg.gap instanceof Uint8Array ? msg.gap : new Uint8Array(msg.gap);
        }
        dataArrived = true;
        if (loadingEl) { loadingEl.style.display = 'none'; }
        render();
    });

    // **리스너를 건 뒤에** 준비됐다고 알린다 (0.6.47).
    //
    // 예전에는 호스트가 HTML 을 넣자마자 데이터를 보냈다. 그 시점에는 이
    // 문서의 스크립트가 아직 돌지 않았을 수 있고, 그러면 메시지가 유실된 채
    // 15초 뒤 "불러오지 못했습니다" 만 남았다 — 재시도도 없었다. 코드 주석은
    // "VS Code 가 큐잉하므로 유실되지 않는다" 고 단언했지만 API 문서는 그런
    // 보장을 하지 않는다. 이제 이 신호를 받은 뒤에 보낸다.
    vscode.postMessage({ command: 'ready' });

    // 데이터가 끝내 오지 않는 경우(호스트 오류 등) 무한 "불러오는 중"에
    // 갇히지 않도록, 잠시 뒤 안내 문구를 바꾼다.
    setTimeout(() => {
        if (!dataArrived && loadingEl) { loadingEl.textContent = S.loadFailed; }
    }, 15000);
})();
</script>
</body>
</html>`;
}

export class HexEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private context: vscode.ExtensionContext, private recordHistory?: HexViewerHistoryRecorder) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose() {} };
    }

    resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel
    ): void {
        webviewPanel.webview.options = { enableScripts: true };
        const filePath = document.uri.fsPath;
        const fileName = path.basename(filePath);

        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch (e: any) {
            const msg = t(`파일을 읽을 수 없습니다: ${e.message}`, `Cannot read file: ${e.message}`);
            webviewPanel.webview.html = buildErrorHtml(webviewPanel.webview, msg, 'error');
            vscode.window.showErrorMessage(msg);
            return;
        }

        if (stat.size > HEX_VIEWER_MAX_FILE_SIZE) {
            const msg = t(
                `파일 크기(${formatFileSize(stat.size)})가 Hex Viewer 처리 한도(${formatFileSize(HEX_VIEWER_MAX_FILE_SIZE)})를 초과합니다. 대용량 파일은 외부 Hex Editor를 사용해 주세요.`,
                `File size (${formatFileSize(stat.size)}) exceeds the Hex Viewer limit (${formatFileSize(HEX_VIEWER_MAX_FILE_SIZE)}). Please use an external hex editor for large files.`
            );
            webviewPanel.webview.html = buildErrorHtml(webviewPanel.webview, msg, 'error');
            vscode.window.showErrorMessage(msg);
            return;
        }

        let result: HexParseResult;
        try {
            result = parseFile(filePath);
        } catch (e: any) {
            const msg = t(`파일 파싱 실패 (${fileName}): ${e.message}`, `Failed to parse file (${fileName}): ${e.message}`);
            webviewPanel.webview.html = buildErrorHtml(webviewPanel.webview, msg, 'error');
            vscode.window.showErrorMessage(msg);
            return;
        }

        if (result.byteCount === 0) {
            const msg = t(`선택한 파일에 유효한 데이터가 없습니다: ${fileName}`, `No valid data found in the selected file: ${fileName}`);
            webviewPanel.webview.html = buildErrorHtml(webviewPanel.webview, msg, 'info');
            vscode.window.showWarningMessage(msg);
            return;
        }

        try {
            webviewPanel.webview.html = buildHexViewerHtml(fileName, result, webviewPanel.webview);
            postHexViewerData(webviewPanel.webview, result);
        } catch (e: any) {
            const msg = t(
                `Hex Viewer 렌더링 실패 (${fileName}): ${e.message}`,
                `Failed to render Hex Viewer (${fileName}): ${e.message}`
            );
            webviewPanel.webview.html = buildErrorHtml(webviewPanel.webview, msg, 'error');
            vscode.window.showErrorMessage(msg);
            return;
        }
        // 에디터 인스턴스별 disposable — 전역 공유 시 다른 패널/에디터의
        // 핸들러를 dispose 하는 cross-talk이 있었다(M7).
        const messageDisposable = setupWebviewMessageHandler(webviewPanel.webview);
        webviewPanel.onDidDispose(() => messageDisposable.dispose());
        this.recordHistory?.({ filePath, fileName });
    }
}
