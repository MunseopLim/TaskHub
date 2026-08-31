import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseElf32, classifySections, computeMemoryUsage, computeSymbolUsage, autoDetectRegions, summarizeSections, generateTextReport, generateSummaryReport, formatSize, formatHex, MemoryRegion, MemoryUsage, ElfSection, SectionSummary, ElfFileRangeResolution, ElfSymbol } from './elfParser';
import { parseLinkerFile } from './linkerScriptParser';
import { ARM_LINK_MAX_ENTRIES, parseArmLinkList, toMemoryRegions, toElfSections, toAggregatedSummary, toMemoryUsage } from './armLinkListParser';
import { t } from './i18n';
import { DIALOG_SCOPE, showOpenDialogWithMemory, showSaveDialogWithMemory } from './dialogMemory';
import { openHexViewerFile } from './hexViewer';
import { coerceToUri } from './previewOpener';
import { filePathIdentityKey } from './pathIdentity';
import {
    DwarfLineUnsupportedFeature,
    DwarfSourceLocation,
    findDwarfSourceLocation,
    parseDwarfLineSection,
} from './dwarfLineParser';

/**
 * *Go to Symbol* Quick Pick 이 다루는 한 항목. 웹뷰 영역 표의 **한 행과 1:1로
 * 대응**한다 — 골랐을 때 이동할 대상이 실제로 그려져 있어야 하기 때문이다.
 * (`region` + `name` + `addr` 가 그 행을 찾는 열쇠다.)
 */
export interface PanelEntry {
    name: string;
    addr: number;
    size: number;
    type: string;
    region: string;
    /** `memoryUsage` 순번 = 웹뷰 `RD` 순번. 이름이 겹쳐도 영역이 갈리지 않게 한다. */
    regionIndex: number;
    /** 부모 섹션(ELF 심볼) 또는 오브젝트 파일(Listing). */
    object?: string;
    section?: string;
    func?: string;
}

interface PanelState {
    panel: vscode.WebviewPanel;
    /** 표시·History·Quick Pick에는 사용자가 연 경로 표기를 유지한다. */
    filePath: string;
    /** 이전 webview에서 늦게 도착한 target/message를 새 결과에 적용하지 않는다. */
    renderId: string;
    /** 심볼/섹션 행 — Quick Pick 의 첫 번째 묶음. 상한에 걸려 잘려 있을 수 있다. */
    entries: PanelEntry[];
    /**
     * 자르지 않은 전체 행. **이름으로 찾는 경로는 반드시 이쪽을 본다.**
     *
     * 상한(`MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS`)은 Quick Pick 이 5,000줄을 그리다
     * 멈추는 것을 막으려는 것이지 "이 심볼이 맵에 없다"는 판정 기준이 아니다.
     * 잘린 목록에서 찾으면 화면에 보이는 행을 두고 "없습니다" 라고 답하게 되고,
     * 하필 잘려 나가는 쪽이 작은 심볼 — 크기를 궁금해하는 바로 그 대상이다.
     */
    allEntries: PanelEntry[];
    /** 자르기 전 전체 행 수. 얼마나 가려졌는지를 Quick Pick 제목에 적는다. */
    entriesTotal: number;
    /** ELF 심볼 테이블에서 온 목록인가 (아니면 섹션·오브젝트 행이다). */
    hasSymbols: boolean;
    /** 메모리 영역 — Quick Pick 의 두 번째 묶음. */
    regions: { name: string; addr: number; info: string }[];
    /** 웹뷰에는 opaque ID만 보내고 실제 file offset은 extension host가 보관한다. */
    hexTargets: Map<string, MemoryMapHexTarget>;
    /** DWARF 경로·줄도 웹뷰에 싣지 않고 opaque ID 뒤의 extension host에만 둔다. */
    sourceTargets: Map<string, MemoryMapSourceTarget>;
    /** 같은 렌더 세션에서 사용자가 명시적으로 고른 DWARF 소스 후보. Refresh 때 폐기한다. */
    sourceSelections: Map<string, string>;
    /** 같은 패널에서 fingerprint가 그대로인 소스 후보의 MD5 비교 결과. */
    sourceChecksumCache: Map<string, DwarfSourceChecksumCacheEntry>;
    /** 같은 렌더 세션의 단일 후보 checksum 경고를 반복하지 않는다. */
    sourceWarningKeys: Set<string>;
    /** 맵을 만든 뒤 ELF가 교체되면 오래된 offset으로 다른 바이트를 열지 않는다. */
    sourceFingerprint?: { size: number; mtimeMs: number };
    /** 숨겨진 webview가 실패 메시지를 놓쳐도 ready handshake에서 다시 보낸다. */
    refreshFailure?: {
        renderId: string;
        refreshAttemptId: string;
        reason?: string;
        failedAt: number;
    };
    /** linker/scatter 재설정 결과도 새 webview의 ready 후 전달한다. */
    panelFeedback?: {
        renderId: string;
        feedbackId: string;
        kind: 'configure-success' | 'configure-failure';
        linkerName: string;
        reason?: string;
        at: number;
    };
    /** 열기 대화상자가 중복으로 열리거나 동기 분석이 겹치지 않게 한다. */
    configureInFlight: boolean;
    /** 소스 후보 검증/선택 Quick Pick을 한 패널에서 한 번만 연다. */
    sourceOpenInFlight: boolean;
    messageDisposable?: vscode.Disposable;
}

export interface MemoryMapHexTarget {
    id: string;
    label: string;
    fileRange: ElfFileRangeResolution;
}

export interface MemoryMapSourceTarget {
    id: string;
    label: string;
    location: DwarfSourceLocation;
}

const panels = new Map<string, PanelState>();
let lastActivePanel: string | undefined;

function compactMemoryMapTargetLabel(label: string): string {
    return label.length > 120 ? `${label.slice(0, 120)}…` : label;
}

/** Panel registry – exported for testing */
export const panelRegistry = {
    has(filePath: string): boolean { return panels.has(filePathIdentityKey(filePath)); },
    size(): number { return panels.size; },
    getLastActive(): string | undefined { return lastActivePanel; },
    getHtml(filePath: string): string | undefined {
        return panels.get(filePathIdentityKey(filePath))?.panel.webview.html;
    },
    /** Go to Symbol Quick Pick 이 다루는 목록(상한 적용). */
    getEntries(filePath: string): PanelEntry[] | undefined {
        return panels.get(filePathIdentityKey(filePath))?.entries;
    },
    /** 이름으로 찾는 경로가 보는 목록(상한 없음). */
    getAllEntries(filePath: string): PanelEntry[] | undefined {
        return panels.get(filePathIdentityKey(filePath))?.allEntries;
    },
    /** ELF file offset은 웹뷰가 아니라 호스트에만 남는다는 계약을 검증하기 위한 목록. */
    getHexTargets(filePath: string): MemoryMapHexTarget[] | undefined {
        const targets = panels.get(filePathIdentityKey(filePath))?.hexTargets;
        return targets ? Array.from(targets.values()) : undefined;
    },
    /** 컴파일 경로와 줄 번호가 웹뷰에 노출되지 않는다는 계약을 검증한다. */
    getSourceTargets(filePath: string): MemoryMapSourceTarget[] | undefined {
        const targets = panels.get(filePathIdentityKey(filePath))?.sourceTargets;
        return targets ? Array.from(targets.values()) : undefined;
    },
    /** Refresh·stale ELF가 소스 선택 세션을 함께 폐기하는지 검증하기 위한 내부 상태. */
    getSourceSessionState(filePath: string): Pick<
        PanelState,
        'sourceSelections' | 'sourceChecksumCache' | 'sourceWarningKeys'
    > | undefined {
        const state = panels.get(filePathIdentityKey(filePath));
        if (!state) { return undefined; }
        return {
            sourceSelections: state.sourceSelections,
            sourceChecksumCache: state.sourceChecksumCache,
            sourceWarningKeys: state.sourceWarningKeys,
        };
    },
    clear(): void { panels.clear(); lastActivePanel = undefined; },
};

/** Memory Map에서 처리 가능한 최대 ELF/Listing 파일 크기 (100 MB). Exported so tests can pin the boundary. */
export const MEMORY_MAP_MAX_FILE_SIZE = 100 * 1024 * 1024;
/** 링커/스캐터 파일은 텍스트 설정이므로 별도 10 MB 상한을 둔다. */
export const MEMORY_MAP_MAX_LINKER_FILE_SIZE = 10 * 1024 * 1024;
const ELF_SHF_COMPRESSED = 0x800;

/**
 * *Save as HTML* 로 저장할 수 있는 최대 문서 크기(문자 수).
 *
 * 웹뷰가 `document.documentElement.outerHTML` 로 **펼쳐진 DOM 전체**를 직렬화해
 * 호스트로 보낸다. region 을 모두 펼친 큰 맵이면 그 문자열 하나가 수백 MB 가
 * 될 수 있고, 이후 정규식 치환과 문자열 결합이 사본을 더 만든다.
 *
 * 64MB 는 실제 맵을 저장하기에 넉넉하면서(보통 수 MB) 병리적 경우를 막는 선이다.
 * 넘으면 **저장 대화상자를 띄우기 전에** 거부한다 — 경로를 고르고 나서 실패하면
 * 사용자가 두 번 헛수고한다.
 */
export const MEMORY_MAP_MAX_SAVE_HTML_CHARS = 64 * 1024 * 1024;

/** Standalone HTML에서 VS Code host가 있어야만 동작하는 결합과 컨트롤을 제거한다. */
export function stripMemoryMapHostBindings(rawHtml: string): string {
    return rawHtml.replace(
        /const vscode = acquireVsCodeApi\(\);?\s*|vscode\.postMessage\(\{[^}]*\}\);?\s*|<div id="memoryMapHostActions"[^>]*>[\s\S]*?<\/div>\s*|<span id="refreshControls"[^>]*>[\s\S]*?<\/span>\s*|<div id="refreshHint"[^>]*>[\s\S]*?<\/div>\s*|<div id="refreshFeedback"[^>]*>\s*<div id="refreshStatus"[^>]*>[\s\S]*?<\/div>\s*<button id="refreshDismiss"[^>]*>[\s\S]*?<\/button>\s*<\/div>\s*|<span id="noRegionConfigure"[^>]*>[\s\S]*?<\/span>\s*/g,
        ''
    );
}

/**
 * *Go to Symbol* Quick Pick 에 싣는 최대 항목 수.
 *
 * 파서는 심볼을 100만 개까지 허용한다([src/elfParser.ts](src/elfParser.ts)의
 * `ELF_MAX_SYMBOLS`). 그만큼을 Quick Pick 에 그대로 넣으면 목록을 여는 순간
 * UI 가 멈춘다 — 상한은 **표시 쪽**에서 잡아야 한다는 그 주석의 판단을 여기서
 * 이행한다. 넘칠 때는 **큰 항목부터** 남긴다. 메모리 맵에서 찾게 되는 것은
 * 자리를 많이 차지하는 쪽이고, 잘렸다는 사실은 Quick Pick 제목에 적는다.
 */
export const MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS = 5000;

/**
 * 저장 HTML 상한 초과 안내. 웹뷰가 직렬화 전에 거른 경우와 호스트가 받은 뒤
 * 거른 경우가 **같은 문구**를 쓰도록 한곳에 둔다.
 */
function showSaveHtmlTooLargeError(): void {
    const mb = Math.round(MEMORY_MAP_MAX_SAVE_HTML_CHARS / (1024 * 1024));
    vscode.window.showErrorMessage(t(
        `저장할 HTML이 너무 큽니다(${mb}MB 초과). HTML에는 접기·검색 상태와 무관하게 전체 맵 데이터가 포함됩니다. 더 작거나 분할된 맵을 열거나, 간략한 *Copy Report* 또는 전체 텍스트인 *Copy Full Dump* 를 사용하세요.`,
        `The HTML to save is too large (over ${mb} MB). HTML always contains the full map data regardless of collapse or search state. Open a smaller or split map, or use the compact *Copy Report* or the complete text *Copy Full Dump* instead.`
    ));
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface MemoryMapConfig {
    regions?: MemoryRegion[];
    /** 사용자가 선택한 GNU linker script / ARM scatter file. Refresh 때 다시 읽는다. */
    linkerFilePath?: string;
}

export interface MemoryMapOpenHistory {
    filePath: string;
    fileName: string;
    inputType: 'elf' | 'listing';
    config?: MemoryMapConfig;
}

export type MemoryMapHistoryRecorder = (entry: MemoryMapOpenHistory) => void;

interface MemoryMapRegionResolution {
    ok: boolean;
    regions: MemoryRegion[];
    reason?: string;
}

interface MemoryMapPanelOpenResult {
    opened: boolean;
    reason?: string;
}

type MemoryMapOpenMode = 'cold' | 'refresh';

class MemoryMapLinkerTooLargeError extends Error {
    constructor(readonly size: number) {
        super('Memory Map linker/scatter file size limit exceeded');
    }
}

function readMemoryMapLinkerFile(filePath: string): string {
    const stat = fs.statSync(filePath);
    if (stat.size > MEMORY_MAP_MAX_LINKER_FILE_SIZE) {
        throw new MemoryMapLinkerTooLargeError(stat.size);
    }
    return fs.readFileSync(filePath, 'utf-8');
}

function describeMemoryMapLinkerFailure(error: unknown, linkerName: string): string {
    if (error instanceof MemoryMapLinkerTooLargeError) {
        return t(
            `링커/스캐터 파일이 너무 큽니다 (${linkerName}, ${formatFileSize(error.size)}). ${formatFileSize(MEMORY_MAP_MAX_LINKER_FILE_SIZE)} 이하의 파일을 선택하세요.`,
            `The linker/scatter file is too large (${linkerName}, ${formatFileSize(error.size)}). Select a file no larger than ${formatFileSize(MEMORY_MAP_MAX_LINKER_FILE_SIZE)}.`
        );
    }
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
    if (code === 'ENOENT') {
        return t(
            `링커/스캐터 파일을 찾을 수 없습니다 (${linkerName}). 파일을 복원하거나 다른 링커 스크립트를 선택하세요.`,
            `The linker/scatter file was not found (${linkerName}). Restore it or select another linker script.`
        );
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return t(
            `링커/스캐터 파일을 읽을 권한이 없습니다 (${linkerName}). 파일 권한을 확인하거나 다른 링커 스크립트를 선택하세요.`,
            `Permission was denied for the linker/scatter file (${linkerName}). Check its permissions or select another linker script.`
        );
    }
    return t(
        `링커/스캐터 파일을 읽거나 해석하지 못했습니다 (${linkerName}). 파일 내용을 확인하거나 다른 링커 스크립트를 선택하세요.`,
        `The linker/scatter file could not be read or parsed (${linkerName}). Check the file or select another linker script.`
    );
}

/**
 * Refresh 실패 배너에는 Node의 raw errno/절대 경로를 싣지 않는다. 빌드가
 * 입력 파일을 교체하는 짧은 구간에 ENOENT가 나는 것이 흔하므로, 사용자가
 * 바로 취할 수 있는 복구 동작과 안전한 파일명만 남긴다.
 */
function describeMemoryMapInputFailure(error: unknown, fileName: string): string {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
    if (code === 'ENOENT') {
        return t(
            `입력 파일을 찾을 수 없습니다 (${fileName}). 파일을 복원하거나 다시 빌드한 뒤 다시 시도하세요.`,
            `The input file was not found (${fileName}). Restore or rebuild it, then try again.`
        );
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return t(
            `입력 파일을 읽을 권한이 없습니다 (${fileName}). 파일 권한을 확인한 뒤 다시 시도하세요.`,
            `Permission was denied for the input file (${fileName}). Check its permissions, then try again.`
        );
    }
    return t(
        `입력 파일을 읽지 못했습니다 (${fileName}). 파일을 복원하거나 다시 빌드한 뒤 다시 시도하세요.`,
        `The input file could not be read (${fileName}). Restore or rebuild it, then try again.`
    );
}

function describeUnexpectedMemoryMapRefreshFailure(fileName: string): string {
    return t(
        `Memory Map 새로 고침에 실패했습니다 (${fileName}). 입력 파일을 다시 빌드한 뒤 새로 고침을 다시 실행하세요.`,
        `Failed to refresh the Memory Map (${fileName}). Rebuild the input file, then run Refresh again.`
    );
}

function describeMemoryMapParseFailure(fileName: string, inputType: 'elf' | 'listing'): string {
    if (inputType === 'elf') {
        return t(
            `ELF 파일을 해석하지 못했습니다 (${fileName}). 지원되는 32비트 ELF인지 확인하거나 다시 빌드한 뒤 다시 시도하세요.`,
            `The ELF file could not be parsed (${fileName}). Verify that it is a supported 32-bit ELF, or rebuild it and try again.`
        );
    }
    return t(
        `Listing 파일을 해석하지 못했습니다 (${fileName}). ARM linker listing 형식인지 확인하거나 다시 생성한 뒤 다시 시도하세요.`,
        `The listing file could not be parsed (${fileName}). Verify that it is an ARM linker listing, or regenerate it and try again.`
    );
}

/**
 * 정적 `taskhub_types.json` region은 그대로 쓰고, 사용자가 골랐던 linker/scatter
 * 파일은 열기·Refresh마다 다시 읽는다. 파싱에 실패하면 caller가 기존 패널을
 * 건드리지 않을 수 있도록 명시적인 실패 결과를 반환한다.
 */
function resolveMemoryMapRegions(
    config: MemoryMapConfig | undefined,
    mode: MemoryMapOpenMode
): MemoryMapRegionResolution {
    if (!config?.linkerFilePath) {
        return { ok: true, regions: config?.regions ?? [] };
    }

    let linkerName = t('선택한 링커/스캐터 파일', 'selected linker/scatter file');
    try {
        if (typeof config.linkerFilePath !== 'string') {
            throw new TypeError('linkerFilePath must be a string');
        }
        linkerName = path.basename(config.linkerFilePath) || linkerName;
        const content = readMemoryMapLinkerFile(config.linkerFilePath);
        const regions = parseLinkerFile(content, config.linkerFilePath);
        if (regions.length === 0) {
            const reason = t(
                `링커/스캐터 파일에서 MEMORY 영역을 찾을 수 없습니다 (${linkerName}).`,
                `No MEMORY regions were found in the linker/scatter file (${linkerName}).`
            );
            if (mode === 'refresh') {
                const refreshReason = t(
                    `${reason} MEMORY 블록을 복원하거나 파일을 다시 선택한 뒤 다시 시도하세요.`,
                    `${reason} Restore the MEMORY block or select the file again, then try again.`
                );
                vscode.window.showWarningMessage(refreshReason);
                return { ok: false, regions: [], reason: refreshReason };
            }
            vscode.window.showWarningMessage(t(
                `${reason} 저장된 영역 또는 ELF 프로그램 헤더로 계속 엽니다.`,
                `${reason} Opening with saved regions or ELF program headers instead.`
            ));
            return { ok: true, regions: config.regions ?? [] };
        }
        return { ok: true, regions };
    } catch (e: unknown) {
        const reason = describeMemoryMapLinkerFailure(e, linkerName);
        if (mode === 'refresh') {
            vscode.window.showErrorMessage(reason);
            return { ok: false, regions: [], reason };
        }
        vscode.window.showWarningMessage(t(
            `${reason} 저장된 영역 또는 ELF 프로그램 헤더로 계속 엽니다.`,
            `${reason} Opening with saved regions or ELF program headers instead.`
        ));
        return { ok: true, regions: config.regions ?? [] };
    }
}

async function pickMemoryMapLinkerScript(): Promise<string | undefined> {
    const linkerScript = t('링커 스크립트', 'Linker Script');
    const linkerUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapLinkerScript, {
        canSelectMany: false,
        filters: { [linkerScript]: ['ld', 'lds', 'lcf', 'sct'] },
        openLabel: t('링커 스크립트 선택', 'Select Linker Script')
    });
    return linkerUri?.[0]?.fsPath;
}

/** 동기 ELF/Listing 분석 전에 renderer가 진행 표시를 그릴 기회를 준다. */
export function withMemoryMapAnalysisProgress<T>(
    filePath: string,
    analyze: () => T | Thenable<T>
): Thenable<T> {
    const fileName = path.basename(filePath) || 'Memory Map';
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: t(
            `Memory Map 분석 중: ${fileName}`,
            `Analyzing Memory Map: ${fileName}`
        ),
        cancellable: false,
    }, async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        return analyze();
    });
}

export async function showMemoryMap(context: vscode.ExtensionContext, config?: MemoryMapConfig, recordHistory?: MemoryMapHistoryRecorder) {
    const inputType = await vscode.window.showQuickPick([
        { label: t('AXF/ELF 파일', 'AXF/ELF File'), description: t('ARM 실행 바이너리 파싱', 'Parse ARM executable binary') },
        { label: 'ARM Linker Listing', description: t('armlink --list 출력 파일 파싱', 'Parse armlink --list output file') },
    ], { placeHolder: t('입력 파일 형식 선택', 'Select input file format') });
    if (!inputType) { return; }

    if (inputType.label === 'ARM Linker Listing') {
        const linkerListing = t('ARM 링커 Listing', 'ARM Linker Listing');
        const listUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapListing, {
            canSelectMany: false,
            filters: { [linkerListing]: ['txt'] },
            openLabel: t('Linker Listing 선택', 'Select Linker Listing')
        });
        if (!listUri || listUri.length === 0) { return; }
        const filePath = listUri[0].fsPath;
        if (await withMemoryMapAnalysisProgress(filePath, () => openMemoryMapFromListing(context, filePath))) {
            recordHistory?.({
                filePath,
                fileName: filePath.split(/[\\/]/).pop() || 'Memory Map',
                inputType: 'listing',
            });
        }
        return;
    }

    const armExecutable = t('ARM 실행 파일', 'ARM Executable');
    const fileUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapBinary, {
        canSelectMany: false,
        filters: { [armExecutable]: ['axf', 'elf', 'out'] },
        openLabel: t('AXF/ELF 파일 선택', 'Select AXF/ELF file')
    });
    if (!fileUri || fileUri.length === 0) { return; }

    // If no regions configured, ask for linker script
    let resolvedConfig = config;
    if (!resolvedConfig?.regions || resolvedConfig.regions.length === 0) {
        const selectLinkerLabel = t('링커 스크립트 선택 (.ld / .sct)', 'Select linker script (.ld / .sct)');
        const skipLabel = t('건너뛰기', 'Skip');
        const linkerChoice = await vscode.window.showQuickPick(
            [
                { label: selectLinkerLabel, description: t('메모리 영역 자동 감지', 'Auto-detect memory regions') },
                { label: skipLabel, description: t('섹션 정보만 표시', 'Show sections only') },
            ],
            { placeHolder: t('메모리 영역 크기를 위한 링커 스크립트를 제공하시겠습니까?', 'Provide a linker script for memory region sizes?') }
        );
        if (!linkerChoice) { return; }

        if (linkerChoice.label === selectLinkerLabel) {
            const linkerFilePath = await pickMemoryMapLinkerScript();
            if (!linkerFilePath) { return; }
            // 실제 읽기·크기 검사·파싱은 openMemoryMapPanelResult 한 곳에서만
            // 수행한다. 선택 직후와 패널 open에서 같은 파일을 두 번 읽지 않는다.
            resolvedConfig = { ...resolvedConfig, linkerFilePath };
        }
    }

    const filePath = fileUri[0].fsPath;
    if (await withMemoryMapAnalysisProgress(
        filePath,
        () => openMemoryMapPanel(context, filePath, resolvedConfig, recordHistory)
    )) {
        recordHistory?.({
            filePath,
            fileName: filePath.split(/[\\/]/).pop() || 'Memory Map',
            inputType: 'elf',
            config: resolvedConfig,
        });
    }
}

/** Explorer 컨텍스트 메뉴에서 선택한 ELF를 추가 질문 없이 바로 연다. */
export function openMemoryMapFromUri(
    context: vscode.ExtensionContext,
    arg?: unknown,
    config?: MemoryMapConfig,
    recordHistory?: MemoryMapHistoryRecorder
): boolean {
    const uri = coerceToUri(arg);
    // Remote extension hosts receive workspace resources as `file:` URIs whose
    // fsPath belongs to that host. A literal vscode-remote URI still carries a
    // UI-side authority that Node fs cannot preserve, so accepting it here
    // would silently read the same path on the wrong machine.
    if (uri && uri.scheme !== 'file') {
        vscode.window.showErrorMessage(t(
            `Memory Map은 ${uri.scheme}: URI를 직접 열 수 없습니다. 로컬 또는 현재 원격 확장 호스트에서 접근 가능한 파일을 선택해 주세요.`,
            `Memory Map cannot open ${uri.scheme}: URIs directly. Select a file accessible to the local or current remote extension host.`
        ));
        return false;
    }
    if (!uri || !/\.(?:elf|axf|out)$/i.test(uri.fsPath)) {
        vscode.window.showErrorMessage(t(
            'Memory Map으로 열 ELF 파일(.elf/.axf/.out)을 선택해 주세요.',
            'Select an ELF file (.elf/.axf/.out) to open with Memory Map.'
        ));
        return false;
    }

    const filePath = uri.fsPath;
    if (!openMemoryMapPanel(context, filePath, config, recordHistory)) {
        return false;
    }
    recordHistory?.({
        filePath,
        fileName: path.basename(filePath) || 'Memory Map',
        inputType: 'elf',
        config,
    });
    return true;
}

export function openMemoryMapPanel(
    context: vscode.ExtensionContext,
    filePath: string,
    config?: MemoryMapConfig,
    recordHistory?: MemoryMapHistoryRecorder
): boolean {
    return openMemoryMapPanelResult(context, filePath, config, 'cold', recordHistory).opened;
}

function openMemoryMapPanelResult(
    context: vscode.ExtensionContext,
    filePath: string,
    config: MemoryMapConfig | undefined,
    mode: MemoryMapOpenMode,
    recordHistory?: MemoryMapHistoryRecorder
): MemoryMapPanelOpenResult {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    const resolvedRegions = resolveMemoryMapRegions(config, mode);
    if (!resolvedRegions.ok) {
        return { opened: false, reason: resolvedRegions.reason };
    }

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: unknown) {
        const reason = describeMemoryMapInputFailure(e, fileName);
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        const reason = t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다. 한도 이하의 입력 파일을 사용하세요.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}). Use an input file within the limit.`
        );
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (e: unknown) {
        const reason = describeMemoryMapInputFailure(e, fileName);
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    if (buffer.length < 16) {
        const reason = t(
            `유효한 ELF 파일이 아닙니다 (${fileName}): 파일이 너무 작습니다 (${formatFileSize(buffer.length)}). 파일을 다시 빌드한 뒤 다시 시도하세요.`,
            `Not a valid ELF file (${fileName}): file is too small (${formatFileSize(buffer.length)}). Rebuild the file, then try again.`
        );
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    let parseResult;
    try {
        parseResult = parseElf32(buffer);
    } catch (_e: unknown) {
        const reason = describeMemoryMapParseFailure(fileName, 'elf');
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    const { sections, entryPoint, symbols, segments, isLittleEndian } = parseResult;
    const { flash, ram } = classifySections(sections);
    const sectionSummary = summarizeSections(sections, segments, buffer.length);

    // Auto-detect regions from program headers if no linker script provided
    let regions = resolvedRegions.regions;
    if (regions.length === 0 && segments.length > 0) {
        regions = autoDetectRegions(segments, sections);
    }

    // Use symbol-level detail when symbols available, otherwise section-level
    const memoryUsage = regions.length > 0
        ? (symbols.length > 0
            ? computeSymbolUsage(symbols, sections, regions, segments, buffer.length)
            : computeMemoryUsage(sections, regions, segments, buffer.length))
        : [];
    const flashTotal = flash.reduce((sum, s) => sum + s.size, 0);
    const ramTotal = ram.reduce((sum, s) => sum + s.size, 0);
    const textReport = generateTextReport(fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage);
    const summaryReport = generateSummaryReport(fileName, filePath, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions);
    const hasSymbols = symbols.length > 0;
    let sourceLocations: DwarfSourceLocation[] = [];
    const isCompressedDwarfSection = (sectionName: string): boolean => {
        const section = sections.find(candidate => candidate.name === sectionName);
        return section !== undefined && (section.flags & ELF_SHF_COMPRESSED) !== 0;
    };
    const readDwarfSection = (sectionName: string): Buffer | undefined => {
        const section = sections.find(candidate => candidate.name === sectionName);
        if (
            !section || section.offset === undefined || section.isNoBits
            || (section.flags & ELF_SHF_COMPRESSED) !== 0
        ) {
            return undefined;
        }
        const end = section.offset + section.size;
        if (
            !Number.isSafeInteger(section.offset) || section.offset < 0
            || !Number.isSafeInteger(end) || end > buffer.length
        ) {
            return undefined;
        }
        return buffer.subarray(section.offset, end);
    };
    const debugLine = sections.find(section => section.name === '.debug_line');
    if (debugLine && debugLine.offset !== undefined && !debugLine.isNoBits) {
        if ((debugLine.flags & ELF_SHF_COMPRESSED) !== 0) {
            vscode.window.showInformationMessage(t(
                `압축된 DWARF .debug_line은 아직 지원하지 않습니다 (${fileName}). Memory Map의 나머지 기능은 그대로 사용할 수 있습니다.`,
                `Compressed DWARF .debug_line is not supported yet (${fileName}). The rest of the Memory Map remains available.`
            ));
        } else {
            const debugLineEnd = debugLine.offset + debugLine.size;
            if (
                Number.isSafeInteger(debugLine.offset) && debugLine.offset >= 0
                && Number.isSafeInteger(debugLineEnd) && debugLineEnd <= buffer.length
            ) {
                try {
                    const dwarf = parseDwarfLineSection(
                        buffer.subarray(debugLine.offset, debugLineEnd),
                        isLittleEndian,
                        {
                            debugLineStr: readDwarfSection('.debug_line_str'),
                            debugStr: readDwarfSection('.debug_str'),
                            compressedDebugLineStr: isCompressedDwarfSection('.debug_line_str'),
                            compressedDebugStr: isCompressedDwarfSection('.debug_str'),
                        }
                    );
                    sourceLocations = dwarf.locations;
                    const hasUnsupportedUnitOnly = sourceLocations.length === 0
                        && (dwarf.unsupportedVersions.length > 0 || dwarf.skippedDwarf64Units > 0);
                    if (
                        hasUnsupportedUnitOnly
                        || dwarf.unsupportedFeatures.length > 0
                    ) {
                        const formats = dwarf.unsupportedVersions.map(version => `DWARF ${version}`);
                        if (dwarf.skippedDwarf64Units > 0) { formats.push('DWARF64'); }
                        const featureLabels: Record<DwarfLineUnsupportedFeature, string> = {
                            'compressed-debug-line-str': t('압축 .debug_line_str', 'compressed .debug_line_str'),
                            'compressed-debug-str': t('압축 .debug_str', 'compressed .debug_str'),
                            'indexed-path-forms': t('DWARF 5 strx 경로 form', 'DWARF 5 strx path forms'),
                            'supplementary-path-form': t(
                                'DWARF 5 strp_sup 경로 form',
                                'DWARF 5 strp_sup path form'
                            ),
                        };
                        formats.push(...dwarf.unsupportedFeatures.map(feature => featureLabels[feature]));
                        vscode.window.showInformationMessage(t(
                            `이 ELF의 소스 위치 정보(${formats.join(', ')})는 아직 지원하지 않습니다. Memory Map의 나머지 기능은 그대로 사용할 수 있습니다.`,
                            `Source locations in this ELF (${formats.join(', ')}) are not supported yet. The rest of the Memory Map remains available.`
                        ));
                    }
                } catch (e: any) {
                    vscode.window.showWarningMessage(t(
                        `DWARF 소스 위치를 읽지 못했습니다 (${fileName}). Memory Map은 계속 엽니다: ${e.message}`,
                        `Could not read DWARF source locations (${fileName}). The Memory Map will still open: ${e.message}`
                    ));
                }
            } else {
                vscode.window.showWarningMessage(t(
                    `DWARF .debug_line 범위가 ELF 파일을 벗어납니다 (${fileName}). Memory Map은 소스 이동 없이 계속 엽니다.`,
                    `The DWARF .debug_line range exceeds the ELF file (${fileName}). The Memory Map will continue without source navigation.`
                ));
            }
        }
    }

    showPanel(
        context, filePath, fileName, entryPoint, flashTotal, ramTotal,
        sectionSummary, memoryUsage, regions, textReport, summaryReport, hasSymbols,
        { size: stat.size, mtimeMs: stat.mtimeMs }, sourceLocations, symbols,
        () => openMemoryMapPanelResult(context, filePath, config, 'refresh', recordHistory),
        linkerFilePath => {
            const nextConfig = { ...config, linkerFilePath };
            const result = openMemoryMapPanelResult(
                context,
                filePath,
                nextConfig,
                'refresh',
                recordHistory
            );
            if (result.opened) {
                recordHistory?.({
                    filePath,
                    fileName,
                    inputType: 'elf',
                    config: nextConfig,
                });
            }
            return result;
        }
    );
    return { opened: true };
}

export function openMemoryMapFromListing(context: vscode.ExtensionContext, filePath: string): boolean {
    return openMemoryMapFromListingResult(context, filePath).opened;
}

function openMemoryMapFromListingResult(
    context: vscode.ExtensionContext,
    filePath: string
): MemoryMapPanelOpenResult {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: unknown) {
        const reason = describeMemoryMapInputFailure(e, fileName);
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        const reason = t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다. 한도 이하의 입력 파일을 사용하세요.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}). Use an input file within the limit.`
        );
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (e: unknown) {
        const reason = describeMemoryMapInputFailure(e, fileName);
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    if (content.trim().length === 0) {
        const reason = t(
            `Listing 파일이 비어 있습니다 (${fileName}). Listing을 다시 생성한 뒤 다시 시도하세요.`,
            `The listing file is empty (${fileName}). Regenerate it, then try again.`
        );
        vscode.window.showWarningMessage(reason);
        return { opened: false, reason };
    }

    let result;
    try {
        result = parseArmLinkList(content);
    } catch (_e: unknown) {
        const reason = describeMemoryMapParseFailure(fileName, 'listing');
        vscode.window.showErrorMessage(reason);
        return { opened: false, reason };
    }

    // 조용히 자르면 사용자가 불완전한 목록을 완전한 것으로 착각한다 —
    // "이 심볼이 왜 없지"가 링커 문제인지 뷰어 한계인지 알 수 없다.
    // 요약 수치(Total RO/RW/ROM)는 잘린 엔트리까지 포함해 계산되므로 정확하다.
    if (result.truncatedEntries > 0) {
        vscode.window.showWarningMessage(t(
            `엔트리가 너무 많아 ${ARM_LINK_MAX_ENTRIES.toLocaleString()}개까지만 표시합니다 (${result.truncatedEntries.toLocaleString()}개 생략, ${fileName}). 요약 수치는 전체 기준입니다.`,
            `Too many entries — showing the first ${ARM_LINK_MAX_ENTRIES.toLocaleString()} (${result.truncatedEntries.toLocaleString()} omitted, ${fileName}). Summary totals still cover the whole file.`
        ));
    }

    if (result.execRegions.length === 0) {
        const reason = t(
            `Execution Region을 찾을 수 없습니다 (${fileName}). ARM Linker Listing (armlink --list) 출력 파일인지 확인해 주세요.`,
            `No execution regions found (${fileName}). Please verify this is an ARM Linker Listing (armlink --list) output file.`
        );
        vscode.window.showWarningMessage(reason);
        return { opened: false, reason };
    }

    const sections = toElfSections(result);
    const regions = toMemoryRegions(result);
    const { flash, ram } = classifySections(sections);
    const sectionSummary = toAggregatedSummary(result);
    const memoryUsage = toMemoryUsage(result);
    const flashTotal = flash.reduce((sum, s) => sum + s.size, 0);
    const ramTotal = ram.reduce((sum, s) => sum + s.size, 0);
    const textReport = generateTextReport(fileName, result.entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage);
    const summaryReport = generateSummaryReport(fileName, filePath, result.entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions);

    showPanel(
        context, filePath, fileName, result.entryPoint, flashTotal, ramTotal,
        sectionSummary, memoryUsage, regions, textReport, summaryReport,
        undefined, undefined, [], [],
        () => openMemoryMapFromListingResult(context, filePath)
    );
    return { opened: true };
}

function ensureMemoryMapElfIsCurrent(
    filePath: string,
    fileName: string,
    fingerprint?: { size: number; mtimeMs: number },
    requestRefresh?: () => void
): boolean {
    if (!fingerprint) { return true; }
    let current: fs.Stats;
    try {
        current = fs.statSync(filePath);
    } catch (e: unknown) {
        vscode.window.showErrorMessage(describeMemoryMapInputFailure(e, fileName));
        return false;
    }
    if (current.size !== fingerprint.size || current.mtimeMs !== fingerprint.mtimeMs) {
        const message = t(
            `ELF 파일이 Memory Map을 연 뒤 변경되었습니다 (${fileName}). 최신 주소·파일 오프셋·소스 위치를 사용하려면 패널에서 새로 고침을 실행하세요.`,
            `The ELF file changed after the Memory Map was opened (${fileName}). Select Refresh in the panel to use current addresses, file offsets, and source locations.`
        );
        if (requestRefresh) {
            const refreshLabel = t('새로 고침', 'Refresh');
            void vscode.window.showWarningMessage(message, refreshLabel).then(selected => {
                if (selected === refreshLabel) { requestRefresh(); }
            });
        } else {
            vscode.window.showWarningMessage(message);
        }
        return false;
    }
    return true;
}

function postMemoryMapRefreshFailure(state: PanelState): void {
    const failure = state.refreshFailure;
    if (!failure || failure.renderId !== state.renderId) { return; }
    void state.panel.webview.postMessage({ command: 'refreshFailed', ...failure });
}

function postMemoryMapPanelFeedback(state: PanelState): void {
    const feedback = state.panelFeedback;
    if (!feedback || feedback.renderId !== state.renderId) { return; }
    void state.panel.webview.postMessage({ command: 'memoryMapPanelFeedback', ...feedback });
}

function memoryMapRefreshAttemptId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= 128
        ? value
        : undefined;
}

function showPanel(
    context: vscode.ExtensionContext,
    filePath: string,
    fileName: string,
    entryPoint: number,
    flashTotal: number,
    ramTotal: number,
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[],
    regions: MemoryRegion[],
    textReport: string,
    summaryReport: string,
    hasSymbols?: boolean,
    sourceFingerprint?: { size: number; mtimeMs: number },
    sourceLocations: DwarfSourceLocation[] = [],
    sourceSymbols: ElfSymbol[] = [],
    refresh?: () => MemoryMapPanelOpenResult,
    configureLinker?: (linkerFilePath: string) => MemoryMapPanelOpenResult
) {
    const panelKey = filePathIdentityKey(filePath);
    const existing = panels.get(panelKey);
    let panel: vscode.WebviewPanel;
    let created = false;
    if (existing) {
        panel = existing.panel;
        panel.reveal(vscode.ViewColumn.Active);
    } else {
        panel = vscode.window.createWebviewPanel(
            'taskhub.memoryMap',
            `Memory Map: ${fileName}`,
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );
        created = true;
        panel.onDidDispose(() => {
            const state = panels.get(panelKey);
            if (state?.panel !== panel) { return; }
            state?.messageDisposable?.dispose();
            panels.delete(panelKey);
            if (lastActivePanel && filePathIdentityKey(lastActivePanel) === panelKey) {
                lastActivePanel = undefined;
            }
        });
        panel.onDidChangeViewState(() => {
            const current = panels.get(panelKey);
            if (panel.active && current) { lastActivePanel = current.filePath; }
            if (panel.visible) {
                if (current) {
                    postMemoryMapRefreshFailure(current);
                    postMemoryMapPanelFeedback(current);
                }
            }
        });
    }

    let html: string;
    let state: PanelState;
    try {
        const renderId = generateMemoryMapNonce();
        const hexTargets = collectMemoryMapHexTargets(sectionSummary, memoryUsage);
        const sourceTargets = collectMemoryMapSourceTargets(memoryUsage, sourceSymbols, sourceLocations);
        html = getWebviewContent(
            fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions,
            hasSymbols, sourceTargets, panel.webview, refresh !== undefined,
            configureLinker !== undefined, renderId
        );
        const allEntries = collectPickEntries(memoryUsage);
        state = {
            panel,
            filePath,
            renderId,
            entries: limitSymbolPickEntries(allEntries),
            allEntries,
            entriesTotal: allEntries.length,
            // ELF 심볼 테이블만 심볼 단위 행을 만드는 것이 아니다 — ARM Listing 은
            // 함수 이름을 `func` 로 보존하므로 이름으로 찾을 수 있다.
            hasSymbols: hasSymbols === true || allEntries.some(entry => Boolean(entry.func)),
            regions: memoryUsage.map(usage => {
                const origin = regions.find(region => region.name === usage.region)?.origin ?? 0;
                return {
                    name: usage.region,
                    addr: origin,
                    info: `${formatSize(usage.used)} / ${formatSize(usage.total)}`,
                };
            }),
            hexTargets,
            sourceTargets,
            sourceSelections: new Map(),
            sourceChecksumCache: new Map(),
            sourceWarningKeys: new Set(),
            sourceFingerprint,
            configureInFlight: false,
            sourceOpenInFlight: false,
            messageDisposable: undefined,
        };
    } catch (e) {
        if (created) {
            panel.dispose();
        }
        throw e;
    }
    let nextMessageDisposable: vscode.Disposable | undefined;
    try {
        nextMessageDisposable = panel.webview.onDidReceiveMessage(async (message: any) => {
            if (panels.get(panelKey) !== state || message.renderId !== state.renderId) {
                return;
            }
            if (message.command === 'openHex') {
                const targetId = typeof message.targetId === 'string' && message.targetId.length <= 128
                    ? message.targetId
                    : '';
                const target = state.hexTargets.get(targetId);
                // 웹뷰 입력에서 offset/size를 받지 않는다. 렌더 당시 호스트가 만든 opaque
                // ID와 일치하지 않으면 아무 파일도 열지 않는다.
                if (!target) { return; }

                if (!ensureMemoryMapElfIsCurrent(
                    filePath,
                    fileName,
                    state.sourceFingerprint,
                    () => {
                        if (panels.get(panelKey) === state) {
                            void panel.webview.postMessage({ command: 'requestRefresh', renderId: state.renderId });
                        }
                    }
                )) {
                    clearMemoryMapSourceSession(state);
                    return;
                }

                const shownLabel = compactMemoryMapTargetLabel(target.label);
                if (target.fileRange.kind !== 'file') {
                    if (target.fileRange.reason === 'nobits' || target.fileRange.reason === 'zero-fill') {
                        vscode.window.showWarningMessage(t(
                            `'${shownLabel}'은 메모리에서만 존재하는 BSS/NOBITS 영역이라 ELF 파일에 표시할 바이트가 없습니다.`,
                            `'${shownLabel}' exists only in a BSS/NOBITS memory range, so the ELF file has no bytes to show.`
                        ));
                    } else {
                        vscode.window.showErrorMessage(t(
                            `'${shownLabel}'의 메모리 주소 범위를 ELF 파일 바이트로 변환할 수 없습니다. 파일이 손상되었거나 범위가 섹션 경계를 벗어났습니다.`,
                            `Cannot map the memory range for '${shownLabel}' to ELF file bytes. The file may be malformed or the range crosses a section boundary.`
                        ));
                    }
                    return;
                }

                openHexViewerFile(context, filePath, {
                    forceBinary: true,
                    initialSelection: {
                        startOffset: target.fileRange.offset,
                        endOffset: target.fileRange.offset + target.fileRange.size - 1,
                    },
                });
            } else if (message.command === 'openSource') {
                if (state.sourceOpenInFlight) { return; }
                const targetId = typeof message.targetId === 'string' && message.targetId.length <= 128
                    ? message.targetId
                    : '';
                const target = state.sourceTargets.get(targetId);
                if (!target) { return; }
                if (!ensureMemoryMapElfIsCurrent(
                    filePath,
                    fileName,
                    state.sourceFingerprint,
                    () => {
                        if (panels.get(panelKey) === state) {
                            void panel.webview.postMessage({ command: 'requestRefresh', renderId: state.renderId });
                        }
                    }
                )) {
                    clearMemoryMapSourceSession(state);
                    return;
                }
                state.sourceOpenInFlight = true;
                try {
                    await openMemoryMapSourceLocation(
                        target,
                        filePath,
                        state.sourceSelections,
                        state.sourceChecksumCache,
                        state.sourceWarningKeys
                    );
                } finally {
                    state.sourceOpenInFlight = false;
                }
            } else if (message.command === 'memoryMapReady') {
                postMemoryMapRefreshFailure(state);
                postMemoryMapPanelFeedback(state);
            } else if (message.command === 'refreshFailureAcknowledged') {
                const refreshAttemptId = memoryMapRefreshAttemptId(message.refreshAttemptId);
                const refreshFailure = state.refreshFailure;
                if (refreshAttemptId && refreshFailure && refreshFailure.renderId === message.renderId
                    && refreshFailure.refreshAttemptId === refreshAttemptId) {
                    state.refreshFailure = undefined;
                }
            } else if (message.command === 'memoryMapPanelFeedbackAcknowledged') {
                const feedbackId = memoryMapRefreshAttemptId(message.feedbackId);
                const feedback = state.panelFeedback;
                if (feedbackId && feedback && feedback.renderId === message.renderId
                    && feedback.feedbackId === feedbackId) {
                    state.panelFeedback = undefined;
                }
            } else if (message.command === 'refresh' && refresh) {
                const refreshAttemptId = memoryMapRefreshAttemptId(message.refreshAttemptId);
                if (!refreshAttemptId) { return; }
                state.refreshFailure = undefined;
                // 사용자가 고른 후보는 현재 분석 결과에만 유효하다. Refresh가 실패해
                // 이전 표를 계속 보여 주더라도 다음 소스 이동에서는 다시 검증한다.
                clearMemoryMapSourceSession(state);
                // 유효한 Refresh는 이전 linker 설정 결과보다 최신 사용자 작업이다.
                // 미확인 durable feedback을 남겨 두면 context 재생성의 ready 재전송이
                // 새 Refresh 실패 뒤에 옛 configure 문구를 덮어쓸 수 있다.
                state.panelFeedback = undefined;
                let result: MemoryMapPanelOpenResult = { opened: false };
                try {
                    result = refresh();
                } catch (_e: unknown) {
                    const reason = describeUnexpectedMemoryMapRefreshFailure(fileName);
                    vscode.window.showErrorMessage(reason);
                    result = { opened: false, reason };
                }
                if (!result.opened) {
                    state.refreshFailure = {
                        renderId: state.renderId,
                        refreshAttemptId,
                        reason: result.reason,
                        failedAt: Date.now(),
                    };
                    postMemoryMapRefreshFailure(state);
                }
            } else if (message.command === 'showMemoryMapSetup') {
                if (!configureLinker || state.configureInFlight) { return; }
                state.configureInFlight = true;
                try {
                    const linkerFilePath = await pickMemoryMapLinkerScript();
                    if (!linkerFilePath || panels.get(panelKey) !== state) { return; }
                    const linkerName = path.basename(linkerFilePath)
                        || t('선택한 링커/스캐터 파일', 'selected linker/scatter file');
                    let result: MemoryMapPanelOpenResult;
                    try {
                        result = configureLinker(linkerFilePath);
                    } catch (_e: unknown) {
                        result = {
                            opened: false,
                            reason: t(
                                `링커/스캐터 파일을 적용하지 못했습니다 (${linkerName}). 파일을 확인한 뒤 다시 선택하세요.`,
                                `The linker/scatter file could not be applied (${linkerName}). Check the file, then select it again.`
                            ),
                        };
                    }
                    const feedbackState = panels.get(panelKey);
                    if (!feedbackState) { return; }
                    feedbackState.panelFeedback = {
                        renderId: feedbackState.renderId,
                        feedbackId: generateMemoryMapNonce(),
                        kind: result.opened ? 'configure-success' : 'configure-failure',
                        linkerName,
                        reason: result.reason,
                        at: Date.now(),
                    };
                    postMemoryMapPanelFeedback(feedbackState);
                } finally {
                    state.configureInFlight = false;
                }
            } else if (message.command === 'copyReport') {
                // 리포트 본문은 이미 extension host가 보유한다. 웹뷰에 수 MB~수십 MB
                // 문자열을 심고 다시 postMessage 구조화 복제로 돌려받지 말고, 버튼은
                // 종류만 전달한다. 예상하지 못한 kind는 clipboard를 건드리지 않는다.
                const copyText = message.kind === 'summary'
                    ? summaryReport
                    : message.kind === 'full'
                        ? textReport
                        : undefined;
                if (copyText === undefined) { return; }
                await vscode.env.clipboard.writeText(copyText);
                vscode.window.showInformationMessage(t('메모리 맵 리포트가 클립보드에 복사되었습니다.', 'Memory map report copied to clipboard.'));
            } else if (message.command === 'saveHtmlTooLarge') {
                // 웹뷰가 **직렬화 전에** 걸러 낸 경우. 아래 호스트 검사와 같은
                // 안내를 쓴다 — 사용자에게는 같은 상황이다.
                showSaveHtmlTooLargeError();
            } else if (message.command === 'saveHtml') {
                const rawHtml = typeof message.html === 'string' ? message.html : '';
                // `outerHTML` 은 펼쳐진 DOM 전체를 직렬화한다. region 을 모두 펼친
                // 큰 맵이면 그 문자열 하나가 수백 MB 가 될 수 있는데, 이후 정규식
                // 치환과 문자열 결합이 매번 사본을 더 만든다. 저장 대화상자를
                // 띄우기 **전에** 막아, 사용자가 경로를 고르고 나서야 실패하는
                // 일이 없게 한다.
                if (rawHtml.length > MEMORY_MAP_MAX_SAVE_HTML_CHARS) {
                    showSaveHtmlTooLargeError();
                    return;
                }
                const uri = await showSaveDialogWithMemory(
                    DIALOG_SCOPE.memoryMapExport,
                    `${fileName.replace(/\.[^.]+$/, '')}_memory_map.html`,
                    { filters: { 'HTML': ['html'] }, defaultDir: path.dirname(filePath) }
                );
                if (uri) {
                    try {
                        // 정규식 두 번을 한 번으로 합친다 — 각 `replace` 가 문자열
                        // 사본을 하나씩 더 만들기 때문이다.
                        const html = stripMemoryMapHostBindings(rawHtml);
                        // DOCTYPE 을 템플릿 리터럴로 붙이면 전체 문자열이 한 벌 더
                        // 복제된다. 두 번 써서 그 사본을 없앤다.
                        fs.writeFileSync(uri.fsPath, '<!DOCTYPE html>\n', 'utf-8');
                        fs.appendFileSync(uri.fsPath, html, 'utf-8');
                        vscode.window.showInformationMessage(t('HTML 파일이 저장되었습니다.', 'HTML file saved.'));
                    } catch (e: any) {
                        vscode.window.showErrorMessage(t(
                            `HTML 파일 저장 실패: ${e.message}`,
                            `Failed to save HTML file: ${e.message}`
                        ));
                    }
                }
            }
        });
        panel.title = `Memory Map: ${fileName}`;
        panel.webview.html = html;
    } catch (e) {
        nextMessageDisposable?.dispose();
        if (created) {
            panel.dispose();
        }
        throw e;
    }

    state.messageDisposable = nextMessageDisposable;
    panels.set(panelKey, state);
    lastActivePanel = filePath;
    // 새 state를 먼저 커밋한다. 이전 listener 정리 자체가 실패해도 새 HTML과
    // registry가 서로 다른 세대를 가리키는 반쪽 교체로 돌아가면 안 된다.
    try {
        existing?.messageDisposable?.dispose();
    } catch { /* VS Code disposable 정리는 best effort이며 새 state를 롤백하지 않는다. */ }
}

function sectionHexTargetId(sectionIndex: number): string {
    return `section:${sectionIndex}`;
}

function entryHexTargetId(regionIndex: number, entryIndex: number): string {
    return `entry:${regionIndex}:${entryIndex}`;
}

function entrySourceTargetId(regionIndex: number, entryIndex: number): string {
    return `source:${regionIndex}:${entryIndex}`;
}

/**
 * Memory Map HTML에 넣을 opaque ID와 호스트 전용 file offset 표를 함께 만든다.
 * Listing은 `fileRange`가 없으므로 빈 맵이 되고 Hex 진입점도 렌더되지 않는다.
 */
export function collectMemoryMapHexTargets(
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[]
): Map<string, MemoryMapHexTarget> {
    const targets = new Map<string, MemoryMapHexTarget>();
    sectionSummary.forEach((section, sectionIndex) => {
        if (!section.fileRange) { return; }
        const id = sectionHexTargetId(sectionIndex);
        targets.set(id, { id, label: section.name, fileRange: section.fileRange });
    });
    memoryUsage.forEach((usage, regionIndex) => {
        usage.sections.forEach((entry, entryIndex) => {
            if (!entry.fileRange) { return; }
            const id = entryHexTargetId(regionIndex, entryIndex);
            targets.set(id, { id, label: entry.func || entry.name, fileRange: entry.fileRange });
        });
    });
    return targets;
}

function sourceSymbolKey(name: string, address: number, size: number): string {
    return `${address}:${size}:${name}`;
}

/** ELF FUNC 심볼 행만 DWARF 주소 범위에 연결하고 실제 경로는 host map에 보관한다. */
export function collectMemoryMapSourceTargets(
    memoryUsage: MemoryUsage[],
    symbols: ElfSymbol[],
    locations: DwarfSourceLocation[]
): Map<string, MemoryMapSourceTarget> {
    const targets = new Map<string, MemoryMapSourceTarget>();
    if (locations.length === 0 || symbols.length === 0) { return targets; }
    const functionSymbols = new Set(symbols
        .filter(symbol => symbol.type === 'FUNC')
        .map(symbol => sourceSymbolKey(symbol.name, symbol.addr, symbol.size)));
    memoryUsage.forEach((usage, regionIndex) => {
        usage.sections.forEach((entry, entryIndex) => {
            if (!functionSymbols.has(sourceSymbolKey(entry.name, entry.addr, entry.size))) { return; }
            const location = findDwarfSourceLocation(locations, entry.addr, entry.size);
            if (!location) { return; }
            const id = entrySourceTargetId(regionIndex, entryIndex);
            targets.set(id, { id, label: entry.name, location });
        });
    });
    return targets;
}

function isExistingFile(filePath: string): boolean {
    try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function nativeRecordedPath(recordedPath: string): string {
    return path.sep === '\\' ? recordedPath.replace(/\//g, '\\') : recordedPath.replace(/\\/g, '/');
}

function isPortableAbsolute(recordedPath: string): boolean {
    return path.isAbsolute(nativeRecordedPath(recordedPath))
        || /^[A-Za-z]:[\\/]/.test(recordedPath)
        || /^[/\\]{2}/.test(recordedPath);
}

/**
 * DWARF에 기록된 경로를 ELF 주변과 워크스페이스 suffix로 해석한다.
 * 파일 시스템 전체를 훑지 않고, 긴 suffix부터 실제 존재하는 후보만 고른다.
 */
export function resolveDwarfSourcePathCandidates(
    recordedPath: string,
    elfFilePath: string,
    workspaceRoots: string[],
    exists: (candidate: string) => boolean = isExistingFile
): string[] {
    if (!recordedPath || recordedPath.length > 4096) { return []; }
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (candidate: string): void => {
        const resolved = path.resolve(candidate);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (!seen.has(key) && exists(resolved)) {
            seen.add(key);
            candidates.push(resolved);
        }
    };

    const native = nativeRecordedPath(recordedPath);
    if (isPortableAbsolute(recordedPath)) {
        // A Windows absolute path cannot be resolved on POSIX, but suffix matching below
        // can still find its source in the current workspace.
        if (path.isAbsolute(native)) { add(native); }
    } else {
        // 의도적으로 ELF 디렉터리에 가두지 않는다. out/debug/app.elf에서
        // ../../src/main.c를 기록하는 빌드가 흔하고, 이 경로는 쓰기가 아니라
        // 사용자가 소스 열기를 눌렀을 때 존재하는 파일을 여는 읽기 전용 후보다.
        add(path.resolve(path.dirname(elfFilePath), native));
    }

    const portable = recordedPath.replace(/\\/g, '/');
    const segments = portable.split('/')
        .filter(segment => segment.length > 0 && segment !== '.' && !/^[A-Za-z]:$/.test(segment));
    for (const root of workspaceRoots) {
        for (let start = 0; start < segments.length; start++) {
            const suffix = segments.slice(start);
            if (suffix.includes('..')) { continue; }
            const candidate = path.resolve(root, ...suffix);
            const relative = path.relative(path.resolve(root), candidate);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { continue; }
            if (exists(candidate)) {
                add(candidate);
                // The first hit uses the longest matching suffix in this workspace root.
                break;
            }
        }
    }
    return candidates;
}

function escapeGlobSegment(value: string): string {
    return value.replace(/([*?{}[\]])/g, '[$1]');
}

function matchingSuffixSegments(recordedPath: string, candidatePath: string): number {
    const recorded = recordedPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const candidate = candidatePath.replace(/\\/g, '/').split('/').filter(Boolean);
    let count = 0;
    while (count < recorded.length && count < candidate.length) {
        const left = recorded[recorded.length - 1 - count];
        const right = candidate[candidate.length - 1 - count];
        const same = process.platform === 'win32'
            ? left.toLowerCase() === right.toLowerCase()
            : left === right;
        if (!same) { break; }
        count++;
    }
    return count;
}

export const DWARF_SOURCE_SEARCH_MAX_RESULTS = 101;
const DWARF_SOURCE_SEARCH_MAX_SUFFIX_SEGMENTS = 32;
/** 한 소스 후보의 checksum 비교에 읽을 수 있는 최대 바이트. */
export const DWARF_SOURCE_CHECKSUM_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 한 번의 소스 선택에서 모든 후보 checksum 비교에 읽을 수 있는 최대 바이트. */
export const DWARF_SOURCE_CHECKSUM_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export class DwarfSourceSearchLimitError extends Error { }

export function buildDwarfSourceSearchGlobs(recordedPath: string): string[] {
    const segments = recordedPath.replace(/\\/g, '/').split('/')
        .filter(segment => segment.length > 0
            && segment !== '.'
            && segment !== '..'
            && !/^[A-Za-z]:$/.test(segment))
        .slice(-DWARF_SOURCE_SEARCH_MAX_SUFFIX_SEGMENTS);
    const globs: string[] = [];
    for (let start = 0; start < segments.length; start++) {
        globs.push(`**/${segments.slice(start).map(escapeGlobSegment).join('/')}`);
    }
    return globs;
}

export function rankDwarfSourcePathMatches(recordedPath: string, candidatePaths: string[]): string[] {
    let bestScore = 0;
    const scored = candidatePaths.map(filePath => ({
        filePath,
        score: matchingSuffixSegments(recordedPath, filePath),
    }));
    for (const item of scored) { bestScore = Math.max(bestScore, item.score); }
    return scored.filter(item => item.score === bestScore && item.score > 0).map(item => item.filePath);
}

interface DwarfSourceSearchOptions {
    hasWorkspace?: boolean;
    findFiles?: (
        include: string,
        exclude: string,
        maxResults: number
    ) => Thenable<vscode.Uri[]>;
}

export async function findWorkspaceSourceBySuffix(
    recordedPath: string,
    options: DwarfSourceSearchOptions = {}
): Promise<string[]> {
    const searchGlobs = buildDwarfSourceSearchGlobs(recordedPath);
    const hasWorkspace = options.hasWorkspace ?? Boolean(vscode.workspace.workspaceFolders);
    if (searchGlobs.length === 0 || !hasWorkspace) { return []; }
    const findFiles = options.findFiles ?? ((include, exclude, maxResults) =>
        vscode.workspace.findFiles(include, exclude, maxResults));
    for (const searchGlob of searchGlobs) {
        const uris = await findFiles(
            searchGlob,
            '**/{.git,node_modules}/**',
            DWARF_SOURCE_SEARCH_MAX_RESULTS
        );
        if (uris.length >= DWARF_SOURCE_SEARCH_MAX_RESULTS) {
            throw new DwarfSourceSearchLimitError(searchGlob);
        }
        if (uris.length > 0) {
            return rankDwarfSourcePathMatches(recordedPath, uris.map(uri => uri.fsPath));
        }
    }
    return [];
}

export type DwarfSourceChecksumStatus = 'match' | 'mismatch' | 'unavailable';
export type DwarfSourceChecksumUnavailableReason =
    | 'unsaved-edits'
    | 'file-too-large'
    | 'total-limit'
    | 'read-failed'
    | 'file-changed'
    | 'invalid-record';

export interface DwarfSourceChecksumComparison {
    filePath: string;
    status: DwarfSourceChecksumStatus;
    reason?: DwarfSourceChecksumUnavailableReason;
}

interface DwarfSourceChecksumOptions {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    isDirty?: (filePath: string) => boolean;
    cancellationToken?: Pick<vscode.CancellationToken, 'isCancellationRequested'>;
    cache?: Map<string, DwarfSourceChecksumCacheEntry>;
}

interface DwarfSourceFileFingerprint {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

interface DwarfSourceChecksumCacheEntry {
    expectedMd5: string;
    fingerprint: DwarfSourceFileFingerprint;
    status: 'match' | 'mismatch';
}

function clearMemoryMapSourceSession(
    state: Pick<PanelState, 'sourceSelections' | 'sourceChecksumCache' | 'sourceWarningKeys'>
): void {
    state.sourceSelections.clear();
    state.sourceChecksumCache.clear();
    state.sourceWarningKeys.clear();
}

function isDirtyWorkspaceFile(filePath: string): boolean {
    const candidateKey = filePathIdentityKey(filePath);
    return vscode.workspace.textDocuments.some(document =>
        document.isDirty
        && document.uri.scheme === 'file'
        && filePathIdentityKey(document.uri.fsPath) === candidateKey
    );
}

async function md5FileWithStableSnapshot(
    filePath: string,
    expectedSize: number,
    cancellationToken?: Pick<vscode.CancellationToken, 'isCancellationRequested'>
): Promise<{ md5: string; changed: boolean; fingerprint?: DwarfSourceFileFingerprint }> {
    if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== expectedSize) {
            return { md5: '', changed: true };
        }
        const digest = crypto.createHash('md5');
        const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, expectedSize)));
        let offset = 0;
        while (offset < expectedSize) {
            if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
            const length = Math.min(chunk.length, expectedSize - offset);
            const { bytesRead } = await handle.read(chunk, 0, length, offset);
            if (bytesRead <= 0) {
                return { md5: '', changed: true };
            }
            digest.update(chunk.subarray(0, bytesRead));
            offset += bytesRead;
        }
        if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
        const after = await handle.stat();
        const changed = after.size !== before.size
            || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs;
        return {
            md5: changed ? '' : digest.digest('hex'),
            changed,
            fingerprint: changed ? undefined : {
                size: after.size,
                mtimeMs: after.mtimeMs,
                ctimeMs: after.ctimeMs,
            },
        };
    } finally {
        await handle.close();
    }
}

/**
 * DWARF 5 MD5와 현재 소스 후보를 bounded read로 비교한다.
 * 실패·미저장 편집·상한 초과 후보는 사용자가 직접 고를 수 있도록 unavailable로 남긴다.
 */
export async function compareDwarfSourceCandidates(
    expectedMd5: string,
    candidates: string[],
    options: DwarfSourceChecksumOptions = {}
): Promise<DwarfSourceChecksumComparison[]> {
    const normalizedMd5 = expectedMd5.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(normalizedMd5)) {
        return candidates.map(filePath => ({ filePath, status: 'unavailable', reason: 'invalid-record' }));
    }
    const maxFileBytes = options.maxFileBytes ?? DWARF_SOURCE_CHECKSUM_MAX_FILE_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? DWARF_SOURCE_CHECKSUM_MAX_TOTAL_BYTES;
    const isDirty = options.isDirty ?? isDirtyWorkspaceFile;
    const cancellationToken = options.cancellationToken;
    let reservedBytes = 0;
    const comparisons: DwarfSourceChecksumComparison[] = [];
    for (const filePath of candidates) {
        if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
        if (isDirty(filePath)) {
            comparisons.push({ filePath, status: 'unavailable', reason: 'unsaved-edits' });
            continue;
        }
        let fingerprint: DwarfSourceFileFingerprint;
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
                comparisons.push({ filePath, status: 'unavailable', reason: 'read-failed' });
                continue;
            }
            fingerprint = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        } catch {
            comparisons.push({ filePath, status: 'unavailable', reason: 'read-failed' });
            continue;
        }
        if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
        const cacheKey = filePathIdentityKey(filePath);
        const cached = options.cache?.get(cacheKey);
        if (cached
            && cached.expectedMd5 === normalizedMd5
            && cached.fingerprint.size === fingerprint.size
            && cached.fingerprint.mtimeMs === fingerprint.mtimeMs
            && cached.fingerprint.ctimeMs === fingerprint.ctimeMs) {
            comparisons.push({ filePath, status: cached.status });
            continue;
        }
        options.cache?.delete(cacheKey);
        const size = fingerprint.size;
        if (size > maxFileBytes) {
            comparisons.push({ filePath, status: 'unavailable', reason: 'file-too-large' });
            continue;
        }
        if (size > maxTotalBytes - reservedBytes) {
            comparisons.push({ filePath, status: 'unavailable', reason: 'total-limit' });
            continue;
        }
        reservedBytes += size;
        try {
            const result = await md5FileWithStableSnapshot(filePath, size, cancellationToken);
            if (result.changed) {
                comparisons.push({ filePath, status: 'unavailable', reason: 'file-changed' });
            } else {
                const status = result.md5 === normalizedMd5 ? 'match' : 'mismatch';
                comparisons.push({
                    filePath,
                    status,
                });
                if (result.fingerprint) {
                    options.cache?.set(cacheKey, {
                        expectedMd5: normalizedMd5,
                        fingerprint: result.fingerprint,
                        status,
                    });
                }
            }
        } catch (error: unknown) {
            if (error instanceof vscode.CancellationError) { throw error; }
            comparisons.push({ filePath, status: 'unavailable', reason: 'read-failed' });
        }
    }
    // 앞 후보를 읽은 뒤 다른 후보를 검사하는 동안 편집이 시작될 수 있다. 자동
    // 선택 직전에 한 번 더 확인해 디스크 digest를 dirty editor의 내용으로 오인하지 않는다.
    if (cancellationToken?.isCancellationRequested) { throw new vscode.CancellationError(); }
    return comparisons.map(comparison =>
        comparison.status !== 'unavailable' && isDirty(comparison.filePath)
            ? { filePath: comparison.filePath, status: 'unavailable', reason: 'unsaved-edits' }
            : comparison
    );
}

interface DwarfSourceQuickPickItem extends vscode.QuickPickItem {
    filePath: string;
}

interface DwarfSourceSelectionOptions {
    compareCandidates?: (
        expectedMd5: string,
        candidates: string[]
    ) => Promise<DwarfSourceChecksumComparison[]>;
    showQuickPick?: (
        items: DwarfSourceQuickPickItem[],
        options: vscode.QuickPickOptions
    ) => Thenable<DwarfSourceQuickPickItem | undefined>;
    showWarningMessage?: (message: string) => Thenable<unknown>;
    checksumCache?: Map<string, DwarfSourceChecksumCacheEntry>;
    shownWarningKeys?: Set<string>;
    /** P0 선호 소스 root가 구현되면 후보 정렬·초기 포커스와 이 기억 키에 함께 전달한다. */
    preferredSourceRoot?: string;
}

function dwarfSourceSelectionKey(
    recordedPath: string,
    candidates: string[],
    preferredSourceRoot?: string
): string {
    const identities = candidates.map(candidate => filePathIdentityKey(candidate)).sort();
    return crypto.createHash('sha256')
        .update(recordedPath)
        .update('\0')
        .update(preferredSourceRoot ? filePathIdentityKey(preferredSourceRoot) : '')
        .update('\0')
        .update(identities.join('\0'))
        .digest('hex');
}

function checksumUnavailableDetail(reason: DwarfSourceChecksumUnavailableReason | undefined): string {
    switch (reason) {
        case 'unsaved-edits':
            return t('저장되지 않은 편집 내용이 있어 비교하지 않았습니다.', 'Not compared because the file has unsaved edits.');
        case 'file-too-large':
            return t('파일별 checksum 읽기 상한을 초과했습니다.', 'The file exceeds the per-file checksum read limit.');
        case 'total-limit':
            return t('후보 전체 checksum 읽기 상한을 초과했습니다.', 'The candidates exceed the total checksum read limit.');
        case 'file-changed':
            return t('읽는 동안 파일이 변경되었습니다.', 'The file changed while it was being read.');
        case 'invalid-record':
            return t('ELF의 checksum 기록 형식이 올바르지 않습니다.', 'The ELF checksum record is invalid.');
        default:
            return t('파일을 읽을 수 없습니다.', 'The file could not be read.');
    }
}

/** 후보 집합과 세션 선택 기억을 적용해 실제로 열 소스 하나를 결정한다. */
export async function selectDwarfSourceCandidate(
    target: MemoryMapSourceTarget,
    candidates: string[],
    rememberedSelections: Map<string, string>,
    options: DwarfSourceSelectionOptions = {}
): Promise<string | undefined> {
    const uniqueCandidates = Array.from(new Map(
        candidates.map(candidate => [filePathIdentityKey(candidate), candidate])
    ).values());
    if (uniqueCandidates.length === 0) { return undefined; }
    const shownTargetLabel = compactMemoryMapTargetLabel(target.label);
    const selectionKey = dwarfSourceSelectionKey(
        target.location.filePath,
        uniqueCandidates,
        options.preferredSourceRoot
    );
    const rememberedPath = rememberedSelections.get(selectionKey);
    if (rememberedPath) {
        const rememberedKey = filePathIdentityKey(rememberedPath);
        const current = uniqueCandidates.find(candidate => filePathIdentityKey(candidate) === rememberedKey);
        if (current) { return current; }
        rememberedSelections.delete(selectionKey);
    }

    const expectedMd5 = target.location.md5?.toLowerCase();
    let comparisons: DwarfSourceChecksumComparison[] | undefined;
    let comparisonByPath: Map<string, DwarfSourceChecksumComparison> | undefined;
    if (expectedMd5 && /^[0-9a-f]{32}$/.test(expectedMd5)) {
        if (options.compareCandidates) {
            comparisons = await options.compareCandidates(expectedMd5, uniqueCandidates);
        } else {
            comparisons = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t(
                    `${shownTargetLabel} 소스 checksum 비교 중…`,
                    `Comparing source checksums for ${shownTargetLabel}…`
                ),
                cancellable: true,
            }, (_progress, cancellationToken) => compareDwarfSourceCandidates(
                expectedMd5,
                uniqueCandidates,
                { cancellationToken, cache: options.checksumCache }
            ));
        }
        comparisonByPath = new Map(
            comparisons.map(comparison => [filePathIdentityKey(comparison.filePath), comparison])
        );
        const complete = comparisonByPath.size === uniqueCandidates.length
            && uniqueCandidates.every(candidate =>
                comparisonByPath?.get(filePathIdentityKey(candidate))?.status !== 'unavailable'
                && comparisonByPath?.has(filePathIdentityKey(candidate)) === true
            );
        const matches = uniqueCandidates.filter(candidate =>
            comparisonByPath?.get(filePathIdentityKey(candidate))?.status === 'match'
        );
        if (complete && matches.length === 1) {
            return matches[0];
        }
        if (uniqueCandidates.length === 1) {
            const candidate = uniqueCandidates[0];
            const comparison = comparisonByPath.get(filePathIdentityKey(candidate));
            const warningKey = comparison
                ? `${selectionKey}\0${comparison.status}\0${comparison.reason ?? ''}`
                : undefined;
            const shouldWarn = warningKey !== undefined && !options.shownWarningKeys?.has(warningKey);
            if (shouldWarn && warningKey) {
                options.shownWarningKeys?.add(warningKey);
            }
            if (comparison?.status === 'mismatch') {
                if (shouldWarn) {
                    const showWarningMessage = options.showWarningMessage
                        ?? ((message: string) => vscode.window.showWarningMessage(message));
                    void Promise.resolve(showWarningMessage(t(
                        `유일한 소스 후보를 엽니다. ELF 기록과 내용이 달라 빌드 후 소스가 변경되었을 수 있습니다: ${path.basename(candidate)}`,
                        `Opening the only source candidate. Its contents differ from the ELF record and may have changed after the build: ${path.basename(candidate)}`
                    ))).catch(() => undefined);
                }
            } else if (comparison?.status === 'unavailable' && shouldWarn) {
                const reason = checksumUnavailableDetail(comparison.reason);
                const showWarningMessage = options.showWarningMessage
                    ?? ((message: string) => vscode.window.showWarningMessage(message));
                void Promise.resolve(showWarningMessage(t(
                    `유일한 소스 후보를 열지만 checksum을 확인하지 못했습니다: ${reason}`,
                    `Opening the only source candidate, but its checksum could not be verified: ${reason}`
                ))).catch(() => undefined);
            }
            return candidate;
        }
    } else if (uniqueCandidates.length === 1) {
        return uniqueCandidates[0];
    }

    const byPath = comparisonByPath ?? new Map<string, DwarfSourceChecksumComparison>();
    const items = uniqueCandidates.map(candidate => {
        const comparison = byPath.get(filePathIdentityKey(candidate));
        let description = path.dirname(candidate);
        let detail: string | undefined;
        if (comparison) {
            if (comparison.status === 'match') {
                description = t('ELF 기록과 일치', 'Matches ELF record');
            } else if (comparison.status === 'mismatch') {
                description = t('ELF 기록과 불일치', 'Does not match ELF record');
            } else {
                description = t('checksum 확인 불가', 'Checksum unavailable');
            }
            const reason = comparison.status === 'unavailable'
                ? checksumUnavailableDetail(comparison.reason)
                : undefined;
            detail = reason ? `${candidate} — ${reason}` : candidate;
        }
        const iconPath = comparison
            ? new vscode.ThemeIcon(
                comparison.status === 'match' ? 'check' : comparison.status === 'mismatch' ? 'warning' : 'question'
            )
            : undefined;
        return { label: path.basename(candidate), description, detail, iconPath, filePath: candidate };
    }).sort((a, b) => {
        const rank = (filePath: string): number => {
            const status = byPath.get(filePathIdentityKey(filePath))?.status;
            return status === 'match' ? 0 : status === 'unavailable' ? 1 : status === 'mismatch' ? 2 : 1;
        };
        return rank(a.filePath) - rank(b.filePath);
    });
    const showQuickPick = options.showQuickPick ?? ((pickItems, pickOptions) =>
        vscode.window.showQuickPick(pickItems, pickOptions));
    const allMismatch = comparisons?.length === uniqueCandidates.length
        && comparisons.every(comparison => comparison.status === 'mismatch');
    const noConfirmedMatch = comparisons !== undefined
        && !comparisons.some(comparison => comparison.status === 'match');
    const placeHolder = allMismatch
        ? t(
            'ELF 기록과 일치하는 후보가 없습니다. 빌드 후 소스가 변경되었을 수 있습니다. 열 파일을 선택하세요.',
            'No candidate matches the ELF record. The source may have changed after the build. Select a file to open.'
        )
        : noConfirmedMatch
            ? t(
                'ELF 기록과 일치하는 후보를 확인하지 못했습니다. 열 파일을 선택하세요.',
                'No candidate could be confirmed against the ELF record. Select a file to open.'
            )
            : t(
                `${shownTargetLabel}의 소스 파일을 선택하세요`,
                `Select the source file for ${shownTargetLabel}`
            );
    const selected = await showQuickPick(items, {
        placeHolder,
        matchOnDescription: comparisons === undefined,
        matchOnDetail: comparisons !== undefined,
    });
    if (!selected) { return undefined; }
    rememberedSelections.set(selectionKey, selected.filePath);
    return selected.filePath;
}

export async function openMemoryMapSourceLocation(
    target: MemoryMapSourceTarget,
    elfFilePath: string,
    rememberedSelections: Map<string, string>,
    checksumCache: Map<string, DwarfSourceChecksumCacheEntry>,
    shownWarningKeys: Set<string> = new Set()
): Promise<void> {
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    let candidates = resolveDwarfSourcePathCandidates(
        target.location.filePath,
        elfFilePath,
        workspaceRoots
    );
    if (candidates.length === 0) {
        try {
            candidates = await findWorkspaceSourceBySuffix(target.location.filePath);
        } catch (e: any) {
            if (e instanceof DwarfSourceSearchLimitError) {
                vscode.window.showWarningMessage(t(
                    `소스 후보가 100개를 초과해 자동으로 선택하지 않았습니다 (${target.location.filePath}). 워크스페이스 범위를 좁혀 다시 시도하세요.`,
                    `More than 100 source candidates matched, so none was selected automatically (${target.location.filePath}). Narrow the workspace and try again.`
                ));
                return;
            }
            vscode.window.showErrorMessage(t(
                `워크스페이스에서 소스 파일 검색 실패 (${target.location.filePath}): ${e.message}`,
                `Failed to search the workspace for the source file (${target.location.filePath}): ${e.message}`
            ));
            return;
        }
    }
    if (candidates.length === 0) {
        vscode.window.showWarningMessage(t(
            `소스 파일을 찾을 수 없습니다: ${target.location.filePath}:${target.location.line}`,
            `Source file not found: ${target.location.filePath}:${target.location.line}`
        ));
        return;
    }

    let selectedPath: string | undefined;
    try {
        selectedPath = await selectDwarfSourceCandidate(target, candidates, rememberedSelections, {
            checksumCache,
            shownWarningKeys,
        });
    } catch (error: unknown) {
        if (error instanceof vscode.CancellationError) {
            const selectManually = t('직접 선택', 'Select manually');
            const selected = await vscode.window.showInformationMessage(t(
                '소스 checksum 비교를 취소했습니다. 비교 없이 후보를 직접 선택할 수 있습니다.',
                'Source checksum comparison was canceled. You can select a candidate without verification.'
            ), selectManually);
            if (selected !== selectManually) { return; }
            const targetWithoutChecksum: MemoryMapSourceTarget = {
                ...target,
                location: { ...target.location, md5: undefined },
            };
            selectedPath = await selectDwarfSourceCandidate(
                targetWithoutChecksum,
                candidates,
                rememberedSelections
            );
            if (!selectedPath) { return; }
        } else {
            const reason = error instanceof Error ? error.message : String(error);
            const shownTargetLabel = compactMemoryMapTargetLabel(target.label);
            vscode.window.showErrorMessage(t(
                `소스 후보 확인 실패 (${shownTargetLabel}): ${reason}`,
                `Failed to verify source candidates (${shownTargetLabel}): ${reason}`
            ));
            return;
        }
    }
    if (!selectedPath) { return; }

    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selectedPath));
        const requestedLine = target.location.line - 1;
        const line = Math.max(0, Math.min(requestedLine, document.lineCount - 1));
        if (line !== requestedLine) {
            vscode.window.showWarningMessage(t(
                `기록된 ${target.location.line}행이 ${path.basename(selectedPath)}의 범위를 벗어나 가장 가까운 ${line + 1}행을 엽니다. ELF를 만든 뒤 소스가 변경되었을 수 있습니다.`,
                `Recorded line ${target.location.line} is outside ${path.basename(selectedPath)}. Opening the nearest line, ${line + 1}; the source may have changed since the ELF was built.`
            ));
        }
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        const textLine = document.lineAt(line);
        const requestedColumn = target.location.column > 0 ? target.location.column - 1 : 0;
        const column = Math.min(requestedColumn, textLine.text.length);
        const position = new vscode.Position(line, column);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(
            `소스 파일 열기 실패 (${selectedPath}): ${e.message}`,
            `Failed to open source file (${selectedPath}): ${e.message}`
        ));
    }
}

/**
 * Quick Pick 이 다룰 행을 모은다.
 *
 * `regionIndex` 는 `memoryUsage` 순번이고, 웹뷰의 `RD` 도 같은 배열에서 같은
 * 순서로 만들어진다([getWebviewContent](src/memoryMapViewer.ts)). 이름이 아니라
 * 이 순번으로 영역을 찾아야 이름이 겹치는 설정(`memoryMap.regions` 는 사용자가
 * 직접 쓰는 파일이라 중복을 막지 않는다)에서도 엉뚱한 카드로 가지 않는다.
 *
 * **크기 0 인 행은 뺀다.** 웹뷰가 같은 조건으로 걸러 표를 그리므로, 넣어 두면
 * 고르고 나서 아무 일도 일어나지 않는 항목이 된다.
 *
 * Exported for testing.
 */
export function collectPickEntries(memoryUsage: MemoryUsage[]): PanelEntry[] {
    const entries: PanelEntry[] = [];
    memoryUsage.forEach((u, regionIndex) => {
        for (const s of u.sections) {
            if (s.size <= 0) { continue; }
            entries.push({
                name: s.name, addr: s.addr, size: s.size, type: s.type,
                region: u.region, regionIndex, object: s.object, section: s.section, func: s.func,
            });
        }
    });
    return entries;
}

/**
 * Quick Pick 목록을 주소순으로 정렬하고 상한을 적용한다. 상한을 넘으면 큰 것부터
 * 남기되(무엇을 남길지의 근거는 `MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS` 참조) 화면
 * 순서는 다시 주소순으로 되돌린다 — 목록을 훑을 때는 맵과 같은 순서가 읽힌다.
 *
 * Exported for testing.
 */
export function limitSymbolPickEntries(
    entries: PanelEntry[],
    max: number = MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS
): PanelEntry[] {
    // 이름 비교는 localeCompare 가 아니라 부호 비교다 — 정렬 결과가 실행 환경의
    // 로케일에 따라 달라지면 안 된다(같은 파일이 기계마다 다른 순서로 보인다).
    const byAddr = (a: PanelEntry, b: PanelEntry) =>
        a.addr - b.addr || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.length <= max) { return entries.slice().sort(byAddr); }
    return entries.slice().sort((a, b) => b.size - a.size).slice(0, max).sort(byAddr);
}

/** Quick Pick 항목. 고른 뒤 어떤 메시지를 보낼지는 `entry` 유무로 갈린다. */
export interface GoToSymbolItem extends vscode.QuickPickItem {
    entry?: PanelEntry;
}

/**
 * Quick Pick 항목을 만든다. 심볼이 먼저다 — 명령 이름이 가리키는 것이고,
 * 목록을 열면 첫 항목이 선택된 상태로 뜨기 때문이다. 영역은 그 뒤에 둔다
 * (0.7.12까지 이 명령이 하던 일이라, 없애면 그때까지의 쓰임이 사라진다).
 *
 * Exported for testing.
 */
export function buildGoToSymbolItems(
    entries: PanelEntry[],
    regions: { name: string; addr: number; info: string }[],
    hasSymbols = false
): GoToSymbolItem[] {
    const items: GoToSymbolItem[] = [];
    if (entries.length > 0) {
        // 구분선은 목록에 실제로 든 것을 말해야 한다. stripped 바이너리나 Listing
        // 파일에서는 이 행들이 심볼이 아니라 섹션·오브젝트다.
        items.push({
            label: hasSymbols ? t('심볼', 'Symbols') : t('섹션', 'Sections'),
            kind: vscode.QuickPickItemKind.Separator,
        });
        for (const e of entries) {
            // Listing 파일은 이름 칸이 오브젝트(main.o)라 행마다 겹친다. 함수명이
            // 있으면 그것을 label 로 올려야 목록이 구분된다. ELF 심볼은 func 가
            // 비어 있어 name(=심볼명)이 그대로 label 이 된다.
            const label = e.func || e.name;
            const parts = [formatHex(e.addr), formatSize(e.size), e.type, e.region];
            if (e.name !== label) { parts.push(e.name); }
            // 부모 섹션(.text/.data)은 ELF 심볼에서 `object` 로 온다. 이것이 없으면
            // matchOnDescription 으로 ".text" 를 찾을 수 없다.
            for (const extra of [e.section, e.object]) {
                if (extra && !parts.includes(extra)) { parts.push(extra); }
            }
            items.push({ label, description: parts.join('  ·  '), entry: e });
        }
    }
    if (regions.length > 0) {
        items.push({ label: t('영역', 'Regions'), kind: vscode.QuickPickItemKind.Separator });
        for (const r of regions) {
            items.push({ label: r.name, description: `${formatHex(r.addr)}  ·  ${r.info}` });
        }
    }
    return items;
}

/**
 * 잘렸을 때만 붙는 Quick Pick 제목.
 *
 * 제목은 **한 줄로 가운데 정렬 후 말줄임** 되므로 (VS Code quick-input),
 * 문장을 길게 쓰면 잘려 나가는 쪽이 하필 뒤쪽 — 사용자가 할 일 — 이다. 그래서
 * 여기에는 숫자만 두고, 무엇을 하면 되는지는 placeHolder 가 말한다.
 * 전체 개수를 함께 적는 이유는 "5,000 / 12,400" 과 "5,000 / 940,000" 이 서로
 * 다른 판단을 부르기 때문이다.
 *
 * Exported for testing.
 */
export function buildGoToSymbolTitle(shown: number, total: number): string | undefined {
    if (total <= shown) { return undefined; }
    // 숫자 구분자는 UI 언어를 따른다 — OS 로케일을 따르면 한국어 문장 안에
    // 독일식 "5.000" 이 섞인다.
    const locale = vscode.env.language.startsWith('ko') ? 'ko-KR' : 'en-US';
    const n = (v: number) => v.toLocaleString(locale);
    // "크기순"이라고 쓰지 않는다 — 크기는 **무엇을 남길지**의 기준이고, 목록에
    // 보이는 순서는 주소순이다. 둘을 같은 말로 적으면 화면과 어긋난다.
    return t(
        `Memory Map — 큰 항목 ${n(shown)} / 전체 ${n(total)}`,
        `Memory Map — ${n(shown)} largest of ${n(total)}`
    );
}

/**
 * 호스트 → 웹뷰 이동 메시지. 웹뷰의 `revealEntry` 가 읽는 키와 **여기서 쓰는 키가
 * 같아야** 기능이 산다. 한곳에 모아 두고 테스트가 웹뷰 쪽 참조와 대조한다.
 *
 * Exported for testing.
 */
export function buildRevealEntryMessage(entry: PanelEntry) {
    return {
        command: 'revealEntry',
        regionIndex: entry.regionIndex,
        region: entry.region,
        name: entry.name,
        addr: entry.addr,
    };
}

/** 소스의 식별자 하나에 대응하는, 열려 있는 맵의 행. */
export interface SourceSymbolMatch {
    /** 이 행이 속한 Memory Map 패널의 파일 경로. */
    filePath: string;
    entry: PanelEntry;
    /** 이름이 그대로 맞았는가(아니면 mangled 이름 안에서 찾았는가). */
    exact: boolean;
}

/**
 * C++ mangled 이름 안에 이 식별자가 **한 성분으로** 들어 있는가.
 *
 * Itanium ABI 는 이름을 `<길이><이름>` 으로 잇는다 — `HAL_Init` 은
 * `_ZN3HAL8HAL_InitEv` 안에 `8HAL_Init` 로 나타난다. 디맹글링은 하지 않는다.
 * 여기서 필요한 것은 *찾기*이지 *복원*이 아니다.
 *
 * **성분을 왼쪽부터 따라간다.** 예전에는 `<길이><이름>` 을 문자열에서 검색하고
 * 접두사 앞이 숫자면 버렸는데, 그 규칙이 임베디드 C++ 의 가장 흔한 이름을
 * 통째로 떨어뜨렸다 — `CAN1::Init` 은 `_ZN4CAN14InitEv` 이고, `4Init` 앞 글자가
 * 클래스 이름의 끝자리 `1` 이라 매번 거부됐다(`I2C1` · `USART2` · `TIM2` ·
 * `Sha256` 전부 같다). 반대로 `Foo8HAL_Init::bar` 같은 이름은 통과시켰다.
 * 성분 경계를 실제로 따라가면 양쪽이 함께 풀린다.
 *
 * Exported for testing.
 */
/** `<길이><이름>` 하나를 읽는다. 길이가 남은 문자열을 넘으면 길이 숫자가 아니었던 것이다. */
function readSourceName(mangled: string, at: number): { name: string; next: number } | undefined {
    const digits = /^[1-9][0-9]*/.exec(mangled.slice(at));
    if (!digits) { return undefined; }
    const start = at + digits[0].length;
    const end = start + Number(digits[0]);
    if (end > mangled.length) { return undefined; }
    return { name: mangled.slice(start, end), next: end };
}

/**
 * `S…` 치환 토큰 하나를 건너뛴다 — `St`(=`::std::`) 같은 약어와 `S_` / `S3_`
 * 형태의 역참조. 한 글자씩 밀면 `S9_` 의 `9` 를 이름 길이로 읽어 버린다.
 */
function skipSubstitution(mangled: string, at: number): number {
    if (mangled[at] !== 'S') { return at; }
    if (/^S[abdiost]/.test(mangled.slice(at))) { return at + 2; }
    const backref = /^S[0-9A-Z]*_/.exec(mangled.slice(at));
    return at + (backref ? backref[0].length : 1);
}

/**
 * `L…E` 리터럴을 통째로 건너뛴다.
 *
 * 템플릿 인자의 정수 리터럴(`Foo<42>` = `ILi42EE`)이 여기 해당한다. 안쪽을
 * 성분으로 읽으려 들면 `42` 를 이름 길이로 보거나 리터럴을 닫는 `E` 를 템플릿
 * 인자의 끝으로 오인해, 그 뒤의 진짜 이름(`bar`)을 통째로 잃는다.
 */
function skipLiteral(mangled: string, at: number): number {
    const end = mangled.indexOf('E', at);
    return end < 0 ? mangled.length : end + 1;
}

/** 생성자 / 소멸자 토큰(`C1` `C2` `CI1` `D0` `D1` …). 뒤 숫자는 이름 길이가 아니다. */
function matchCtorDtor(mangled: string, at: number): number {
    const token = /^(?:C[I]?[0-9]|D[0-9])/.exec(mangled.slice(at));
    return token ? token[0].length : 0;
}

/**
 * `N…E` / `I…E` / `Z…E` 를 짝이 맞는 `E` 까지 건너뛰고 그 다음 위치를 준다.
 * 이름 payload 는 길이만큼 통째로 넘겨, 이름 안의 `E` 를 구분자로 오인하지 않는다.
 */
function skipToMatchingE(mangled: string, from: number): number {
    let depth = 0;
    for (let i = from; i < mangled.length;) {
        if (mangled[i] === 'S') {
            const next = skipSubstitution(mangled, i);
            if (next > i) { i = next; continue; }
        }
        if (mangled[i] === 'L') { i = skipLiteral(mangled, i); continue; }
        const source = readSourceName(mangled, i);
        if (source) { i = source.next; continue; }
        const ch = mangled[i];
        // `E` 로 닫히는 구조는 넷이다 — 중첩 이름(N) · 템플릿 인자(I) · local
        // name(Z) 에 더해 표현식(X, `Foo<1 + 2>`)과 인자 팩(J, `Foo<int, int>`).
        // 뒤 둘을 세지 않으면 그 안의 `E` 를 바깥 템플릿의 끝으로 오인해, 템플릿
        // 뒤에 오는 진짜 메서드 이름을 통째로 잃는다.
        if (ch === 'N' || ch === 'I' || ch === 'Z' || ch === 'X' || ch === 'J') { depth++; i++; continue; }
        if (ch === 'E') {
            if (depth === 0) { return i + 1; }
            depth--; i++; continue;
        }
        i++;
    }
    return -1;
}

/**
 * Itanium mangled 이름에서 **엔티티 이름 성분만** 뽑는다 (네임스페이스·클래스·함수).
 *
 * 매개변수 타입은 뽑지 않는다. `_Z3foo6Widget` 은 `foo(Widget)` 이고 `Widget` 은
 * 인자 타입일 뿐인데, 인코딩 전체에서 `<길이><이름>` 을 찾으면 그것까지 걸린다 —
 * 소스에서 타입 이름에 커서를 두면 그 타입을 받는 아무 함수로나 끌려간다.
 * 이름부(nested 는 `N…E`, 그 밖은 source-name 하나)에서 멈추면 그 뒤의
 * bare-function-type 은 애초에 보지 않는다. 템플릿 인자(`I…E`)도 타입이므로 건너뛴다.
 *
 * 디맹글링이 아니다 — 찾기에 필요한 만큼만 읽는다.
 *
 * Exported for testing.
 */
export function mangledEntityNames(candidate: string): string[] {
    if (!candidate.startsWith('_Z')) { return []; }
    let i = 2;
    if (candidate[i] === 'L') { i++; }   // 내부 링키지(static) 표시
    if (candidate[i] === 'Z') {
        // local name: `Z <바깥 함수 인코딩> E <이름>`. 바깥 인코딩에는 타입이
        // 섞여 있으므로 통째로 건너뛰고 그 뒤의 이름만 읽는다.
        const after = skipToMatchingE(candidate, i + 1);
        if (after < 0) { return []; }
        i = after;
        if (candidate[i] === 'L') { i++; }
    }

    const names: string[] = [];
    if (candidate[i] === 'N') {
        i++;
        while (i < candidate.length && /[rVKRO]/.test(candidate[i])) { i++; }   // CV/ref 한정자
        while (i < candidate.length && candidate[i] !== 'E') {
            const source = readSourceName(candidate, i);
            if (source) { names.push(source.name); i = source.next; continue; }
            if (candidate[i] === 'I') {
                const after = skipToMatchingE(candidate, i + 1);
                if (after < 0) { break; }
                i = after;
                continue;
            }
            if (candidate[i] === 'S') {
                const next = skipSubstitution(candidate, i);
                if (next > i) { i = next; continue; }
            }
            if (candidate[i] === 'L') { i = skipLiteral(candidate, i); continue; }
            // `Widget::Widget()` 은 `_ZN6WidgetC1Ev` 다. `C1` 을 그냥 두면 `1` 을
            // 길이로 읽어 `E` 라는 가짜 이름이 생기고, 소스의 `E` 에서 엉뚱한
            // 생성자로 이동하게 된다.
            //
            // 건너뛰는 것이 아니라 **여기서 이름부를 끝낸다.** 생성자/소멸자는
            // 이름부의 마지막 성분이고, 그 뒤에 오는 것은 이름이 아니다 — 상속
            // 생성자(`_ZN1DCI11BEv` = `D::D()`)는 토큰 뒤에 기반 클래스 타입
            // `1B` 를 달고 있어서, 계속 읽으면 그것이 엔티티 이름으로 섞인다.
            // 생성자의 이름은 바깥 클래스 이름이고 그것은 이미 담겨 있다.
            if (matchCtorDtor(candidate, i) > 0) { break; }
            // **모르는 토큰에서는 재동기화하지 않고 끝낸다.** 한 칸씩 밀며 다시
            // 맞춰 보면 이름이 아닌 것을 이름으로 만들어 내기 때문이다:
            //
            //   - ABI tag `B<source-name>` — `_ZN3Foo3barB5cxx11Ev` 는
            //     `Foo::bar[abi:cxx11]()` 인데 `cxx11` 이 이름으로 잡혔다.
            //   - 벤더 확장 `U…`, thunk, 특수 엔티티 — 같은 방식으로 샌다.
            //   - 깨진 길이 숫자 — `112abc…` 에서 꼬리 `12abc…` 를 새 길이로 읽었다.
            //
            // 이 파서는 흔한 이름 형태를 찾는 도구이지 디맹글러가 아니다. 모르는
            // 문법은 **못 찾는 쪽**으로 남긴다 — 엉뚱한 심볼로 이동하는 것보다 낫다.
            // 연산자 이름(`pl` `ix` …)처럼 여기서 멈춰도 잃을 이름이 없는 경우도
            // 많다: 이름부의 마지막 성분 자리이기 때문이다.
            break;
        }
        return names;
    }

    // unscoped name: 치환이 앞설 수 있고(`_ZSt9terminatev` = `std::terminate()`),
    // 그 뒤 source-name 하나로 끝난다 — 나머지는 전부 함수 타입이다.
    if (candidate[i] === 'S') { i = skipSubstitution(candidate, i); }
    const source = readSourceName(candidate, i);
    if (source) { names.push(source.name); }
    return names;
}

/**
 * C++ mangled 이름의 **엔티티 이름**에 이 식별자가 있는가.
 *
 * 소스의 `HAL_Init` 은 `_ZN3HAL8HAL_InitEv` 안에 성분으로 들어 있다. 성분 경계를
 * 따라가므로 `CAN1::Init`(`_ZN4CAN14InitEv`) 처럼 클래스 이름이 숫자로 끝나는
 * 경우도 찾고, `Foo8HAL_Init::bar` 처럼 이름 안에 우연히 들어 있는 것이나
 * `foo(Widget)` 의 인자 타입은 걸리지 않는다.
 *
 * Exported for testing.
 */
export function mangledNameContains(candidate: string, identifier: string): boolean {
    if (identifier.length === 0) { return false; }
    return mangledEntityNames(candidate).includes(identifier);
}

/**
 * GCC/Clang 이 최적화 중에 붙이는 clone 접미사를 뗀 이름.
 *
 * `-O2` 빌드에서 C 심볼은 `HAL_Init.constprop.0` · `foo.isra.0` · `bar.part.0`
 * 처럼 나타난다. 접미사를 모르면 최적화 빌드에서 이름이 하나도 맞지 않는다.
 * **아는 접미사만 뗀다** — 부분 일치를 하지 않는다는 규칙을 우회하지 않기 위해서다.
 *
 * Exported for testing.
 */
export function stripCloneSuffix(name: string): string {
    const match = /^(.+?)\.(?:constprop|isra|part|cold|clone|lto_priv|localalias|llvm)\.[0-9]+$/.exec(name);
    return match ? match[1] : name;
}

/**
 * 소스의 식별자와 맵의 한 행이 대응하는지 본다.
 *
 * 이름이 그대로 맞는 경우가 우선이고(`exact`), 그다음이 mangled 이름 안에서
 * 찾는 경우다. **부분문자열 검색은 하지 않는다** — `main` 으로 `main_init` 까지
 * 걸리면 후보가 늘어 고르라는 목록만 길어진다.
 *
 * Exported for testing.
 */
export function matchSourceIdentifier(entry: PanelEntry, identifier: string): 'exact' | 'mangled' | undefined {
    const names = [entry.func, entry.name].filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.some(n => n === identifier || stripCloneSuffix(n) === identifier)) { return 'exact'; }
    if (names.some(n => mangledNameContains(stripCloneSuffix(n), identifier))) { return 'mangled'; }
    return undefined;
}

/**
 * 열려 있는 모든 맵에서 식별자에 대응하는 행을 모은다. 정확히 맞은 것이 앞,
 * 그 안에서는 큰 것이 앞이다 — 같은 이름이 여러 맵에 있으면 보통 찾는 쪽은
 * 자리를 많이 차지하는 실체 쪽이다.
 *
 * Exported for testing.
 */
export function collectSourceSymbolMatches(
    panelEntries: { filePath: string; entries: PanelEntry[] }[],
    identifier: string,
    preferredPath?: string
): SourceSymbolMatch[] {
    const matches: SourceSymbolMatch[] = [];
    for (const panel of panelEntries) {
        for (const entry of panel.entries) {
            const kind = matchSourceIdentifier(entry, identifier);
            if (kind) { matches.push({ filePath: panel.filePath, entry, exact: kind === 'exact' }); }
        }
    }
    // 마지막으로 보던 맵을 앞에 둔다. 부트로더와 앱을 함께 열어 둔 경우, 크기만으로
    // 세우면 첫 항목(그대로 Enter 를 누르면 가는 곳)이 엉뚱한 빌드가 된다.
    const rank = (m: SourceSymbolMatch) => (preferredPath && m.filePath === preferredPath ? 1 : 0);
    return matches.sort((a, b) =>
        (rank(b) - rank(a))
        || (Number(b.exact) - Number(a.exact))
        || (b.entry.size - a.entry.size));
}

/**
 * 커서 아래 심볼을 열려 있는 Memory Map 에서 찾아 그 행으로 이동한다.
 *
 * 어느 바이너리인지는 **지금 열려 있는 패널**로 정한다 — 소스 ↔ 바이너리 매핑을
 * 설정으로 받는 길도 있지만, 맵을 열어 두고 소스를 보는 것이 이 기능을 쓰는
 * 상황 자체라 추가 설정 없이 맞는다. 후보가 여럿이면 고르게 한다.
 */
export async function revealSourceSymbolInMemoryMap(identifier: string): Promise<void> {
    const trimmed = identifier.trim();
    if (!trimmed) {
        vscode.window.showInformationMessage(t(
            '커서 위치에서 심볼 이름을 찾지 못했습니다.',
            'No symbol name found at the cursor position.'
        ));
        return;
    }

    if (panels.size === 0) {
        // 이 명령은 C/C++ 파일이면 항상 메뉴에 보이므로, 처음 써 보는 사람이
        // 만나는 화면이 대개 여기다. 안내로 끝내면 막다른 길이라 여는 길을 같이 준다.
        const openLabel = t('Memory Map 열기', 'Open Memory Map');
        const choice = await vscode.window.showInformationMessage(
            t(
                '열려 있는 Memory Map 이 없습니다. 먼저 .axf/.elf 또는 Linker Listing 파일로 Memory Map 을 열어 주세요.',
                'No Memory Map is open. Open one from an .axf/.elf or linker listing file first.'
            ),
            openLabel
        );
        if (choice === openLabel) {
            await vscode.commands.executeCommand('taskhub.showMemoryMap');
        }
        return;
    }

    // **자르지 않은 목록**을 본다 — 상한은 Quick Pick 렌더용이지 존재 판정 기준이 아니다.
    const panelEntries = Array.from(panels.values(), state => ({
        filePath: state.filePath,
        entries: state.allEntries,
    }));
    const matches = collectSourceSymbolMatches(panelEntries, trimmed, lastActivePanel);

    if (matches.length === 0) {
        // 열린 맵 중 심볼 단위 행을 가진 것이 하나도 없으면, 원인은 이 심볼이
        // 아니라 맵 자체다. 그 경우 "인라인됐을 수 있다" 는 매번 틀린 설명이 된다.
        const anySymbolic = Array.from(panels.values()).some(state => state.hasSymbols);
        vscode.window.showInformationMessage(anySymbolic
            ? t(
                `'${trimmed}' — 열려 있는 Memory Map 에서 찾지 못했습니다. 최적화로 인라인됐거나, 크기가 0이거나, 다른 바이너리의 심볼일 수 있습니다.`,
                `'${trimmed}' was not found in any open Memory Map. It may have been inlined, have zero size, or belong to a different binary.`
            )
            : t(
                '열려 있는 Memory Map 에 심볼 단위 행이 없습니다 — stripped 바이너리이거나, 함수 단위 섹션 없이 만든 Listing 입니다. 심볼 테이블이 있는 .axf/.elf 를 열거나 -ffunction-sections 로 빌드해 주세요.',
                'No open Memory Map has symbol-level rows — the binary is stripped, or the listing was built without per-function sections. Open an .axf/.elf that still has its symbol table, or build with -ffunction-sections.'
            ));
        return;
    }

    let picked = matches[0];
    if (matches.length > 1) {
        const items = matches.map(m => {
            const parts = [formatHex(m.entry.addr), formatSize(m.entry.size), m.entry.type, m.entry.region];
            // 같은 이름이 여러 파일에 있는 static 함수라면 주소만으로는 못 고른다.
            for (const extra of [m.entry.section, m.entry.object]) {
                if (extra && !parts.includes(extra)) { parts.push(extra); }
            }
            return {
                label: m.entry.func || m.entry.name,
                description: parts.join('  ·  '),
                // 맵이 여럿 열려 있으면 어느 바이너리인지가 가장 중요한 구분이다.
                // 파일명만 쓰면 build/debug/app.elf 와 build/release/app.elf 가
                // 같은 줄이 된다 — 흔한 배치인데 주소·크기까지 닮아 구별되지 않는다.
                // 워크스페이스 폴더명을 빼면(두 번째 인자 false) 멀티루트에서 다시
                // 겹친다 — bootloader/build/app.axf 와 application/build/app.axf 가
                // 둘 다 `build/app.axf` 가 된다. 기본값(폴더가 여럿이면 포함)을 쓴다.
                detail: vscode.workspace.asRelativePath(m.filePath),
                match: m,
            };
        });
        const selected = await vscode.window.showQuickPick(items, {
            title: t(`'${trimmed}' — Memory Map`, `'${trimmed}' — Memory Map`),
            placeHolder: t('이동할 위치 선택', 'Pick where to go'),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) { return; }
        picked = selected.match;
    }

    const state = panels.get(filePathIdentityKey(picked.filePath));
    if (!state) {
        // Quick Pick 을 띄워 둔 사이에 그 패널이 닫힌 경우.
        vscode.window.showInformationMessage(t(
            '선택한 Memory Map 패널이 닫혔습니다. 다시 열고 시도해 주세요.',
            'That Memory Map panel was closed. Reopen it and try again.'
        ));
        return;
    }
    lastActivePanel = picked.filePath;
    state.panel.reveal();
    state.panel.webview.postMessage(buildRevealEntryMessage(picked.entry));
}

export async function goToSymbol() {
    const active = lastActivePanel ? panels.get(filePathIdentityKey(lastActivePanel)) : undefined;
    if (!active) {
        // 조용히 끝내면 명령이 죽은 것으로 읽힌다 — 형제 명령(소스 → 맵)과 같은
        // 상황에서 같은 안내를 한다.
        vscode.window.showInformationMessage(t(
            '열려 있는 Memory Map 이 없습니다. 먼저 .axf/.elf 또는 Linker Listing 파일로 Memory Map 을 열어 주세요.',
            'No Memory Map is open. Open one from an .axf/.elf or linker listing file first.'
        ));
        return;
    }
    if (active.entries.length === 0 && active.regions.length === 0) {
        // 이 상태는 "영역이 정의되지 않음"이다 — 패널에는 All Sections 표가 그대로
        // 떠 있으므로, "아무것도 없다"고만 하면 화면과 어긋나 명령이 고장 난 것으로
        // 읽힌다. 패널 안내와 같은 다음 단계를 가리킨다.
        vscode.window.showInformationMessage(t(
            '이동할 목록이 없습니다. 메모리 영역이 정의되지 않았습니다 — 링커 스크립트(.ld/.sct)를 선택하거나 .vscode/taskhub_types.json 에 memoryMap.regions 를 추가하세요.',
            'Nothing to go to: no memory regions are defined. Pick a linker script (.ld/.sct), or add memoryMap.regions to .vscode/taskhub_types.json.'
        ));
        return;
    }

    const items = buildGoToSymbolItems(active.entries, active.regions, active.hasSymbols);
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: t(
            '심볼 또는 영역으로 이동… (이름·주소·크기·타입으로 검색)',
            'Go to a symbol or region… (search by name, address, size, or type)'
        ),
        matchOnDescription: true,
        title: buildGoToSymbolTitle(active.entries.length, active.entriesTotal),
    });

    if (!selected) { return; }
    active.panel.reveal();
    if (selected.entry) {
        active.panel.webview.postMessage(buildRevealEntryMessage(selected.entry));
    } else {
        active.panel.webview.postMessage({
            command: 'scrollToRegion',
            name: selected.label,
        });
    }
}

function generateMemoryMapNonce(): string {
    // CSP nonces are a security control; use a CSPRNG, not Math.random().
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Memory Map webview UI strings, resolved in the extension host.
 *
 * Scope note: the **report bodies** (`generateTextReport` /
 * `generateSummaryReport`, reachable via *Copy Report* / *Copy Full Dump*)
 * stay English on purpose. Those are artifacts users paste into issues,
 * commit messages, and docs shared with others, where a stable English
 * wording is worth more than matching the editor's UI language. Only the
 * surrounding chrome is localized.
 *
 * Region / section / type names come from the binary and are never
 * translated.
 */
export function buildMemoryMapStrings(): Record<string, string> {
    return {
        entryPoint: t('진입점', 'Entry Point'),
        copyReport: t('리포트 복사', 'Copy Report'),
        copyReportTitle: t('요약 리포트 복사 (마크다운, 약 50줄)', 'Copy summary report (markdown, ~50 lines)'),
        copyFullDump: t('전체 덤프 복사', 'Copy Full Dump'),
        copyFullDumpTitle: t('전체 텍스트 덤프 복사 (모든 섹션)', 'Copy full text dump (every section)'),
        saveHtml: t('HTML 저장', 'Save HTML'),
        saveHtmlTitle: t('HTML 파일로 저장', 'Save as HTML file'),
        refresh: t('새로 고침', 'Refresh'),
        refreshTitle: t(
            '현재 입력 파일 다시 읽기 (AXF/ELF는 선택한 링커/스캐터 파일 포함)',
            'Reload the current input (including the selected linker/scatter file for AXF/ELF)'
        ),
        refreshHint: t(
            '현재 입력을 다시 읽습니다. AXF/ELF는 선택한 링커/스캐터 파일도 포함하며, 파일 변경은 자동 감시하지 않습니다.',
            'Reloads the current input and includes the selected linker/scatter file for AXF/ELF. File changes are not watched automatically.'
        ),
        refreshing: t('새로 고치는 중…', 'Refreshing…'),
        refreshTakingLong: t(
            '새로 고침이 예상보다 오래 걸리고 있습니다. 분석이 끝날 때까지 기다려 주세요…',
            'Refresh is taking longer than expected. Wait for analysis to finish…'
        ),
        refreshSucceeded: t('{time}에 새로 고침 완료', 'Refreshed at {time}'),
        refreshFailedAt: t(
            '{time}에 새로 고침 실패 — {reason} 이전 결과를 표시 중입니다.',
            'Refresh failed at {time} — {reason} Showing previous results.'
        ),
        refreshUsageUnchanged: t('Flash/RAM 사용량 변화 없음', 'Flash/RAM usage unchanged'),
        refreshFlash: 'Flash',
        refreshRam: 'RAM',
        refreshInterrupted: t(
            '결과 응답을 받지 못했습니다.',
            'No result was received.'
        ),
        refreshStaleCompact: t(
            '{time}에 새로 고침 실패 · 이전 분석 결과 표시 중',
            'Refresh failed at {time} · Showing previous analysis'
        ),
        dismissRefreshDetails: t('새로 고침 실패 세부 정보 닫기', 'Dismiss refresh failure details'),
        showRefreshDetails: t('새로 고침 실패 세부 정보 보기', 'Show refresh failure details'),
        configureMemoryMap: t('링커 스크립트 선택…', 'Select linker script…'),
        configureMemoryMapTitle: t(
            '현재 ELF에 사용할 링커/스캐터 파일 선택',
            'Select a linker/scatter file for the current ELF'
        ),
        configureSucceededAt: t(
            '{time}에 링커/스캐터 파일 적용 완료 — {file}',
            'Linker/scatter file applied at {time} — {file}'
        ),
        configureFailedAt: t(
            '{time}에 링커/스캐터 파일 적용 실패 — {reason} 이전 결과를 표시 중입니다.',
            'Failed to apply the linker/scatter file at {time} — {reason} Showing previous results.'
        ),
        standaloneNotice: t(
            '저장된 Memory Map 스냅샷입니다. 검색·정렬·펼치기는 사용할 수 있으며 VS Code 전용 Hex/Source 열은 제외되었습니다.',
            'This is a saved Memory Map snapshot. Search, sorting, and folding remain available; VS Code-only Hex/Source columns were omitted.'
        ),
        searchPlaceholder: t('검색… (오브젝트, 섹션, 함수, 주소, 크기, 타입)', 'Search... (object, section, function, address, size, type)'),
        searchLabel: t('검색', 'Search'),
        searchPrev: t('이전 결과 (Shift+Enter)', 'Previous match (Shift+Enter)'),
        searchNext: t('다음 결과 (Enter)', 'Next match (Enter)'),
        memoryRegions: t('메모리 영역', 'Memory Regions'),
        regionDetails: t('영역 상세', 'Region Details'),
        // "무엇을" 펼치는지 이름에 넣는다. 이 버튼은 **영역만** 펼치고 그
        // 안의 Object Summary 는 접힌 채로 둔다 — "모두 펼치기"는 3단 구조에서
        // 지키지 못할 약속이었다.
        expandAll: t('영역 모두 펼치기', 'Expand all regions'),
        collapseAll: t('영역 모두 접기', 'Collapse all regions'),
        // 이 버튼의 title 은 라벨을 그대로 되풀이하고 있었다 — 지연만 있고 더
        // 알려 주는 것이 없는 툴팁이다. 이름을 바꾼 이유를 여기서 말한다.
        expandAllHint: t(
            '영역만 여닫습니다. 각 영역 안의 오브젝트 요약은 그대로 둡니다.',
            'Folds regions only. The Object Summary inside each region is left as is.'
        ),
        toggleFunctionColumn: t('Function 열 표시 전환', 'Toggle Function column'),
        allSections: t('전체 섹션', 'All Sections'),
        scrollTop: t('맨 위로', 'Back to top'),
        colRegion: t('영역', 'Region'),
        colBase: t('시작', 'Base'),
        colMax: t('최대', 'Max'),
        colUsed: t('사용', 'Used'),
        colFree: t('여유', 'Free'),
        colLinkerUsed: t('Linker 사용', 'Linker Used'),
        colCalcUsed: t('계산 사용', 'Calc Used'),
        colLinkerFree: t('Linker 여유', 'Linker Free'),
        colCalcFree: t('계산 여유', 'Calc Free'),
        colUsage: t('사용률', 'Usage'),
        colSection: t('섹션', 'Section'),
        colAddress: t('주소', 'Address'),
        colEnd: t('끝', 'End'),
        colSize: t('크기', 'Size'),
        colBytes: t('바이트', 'Bytes'),
        colType: t('타입', 'Type'),
        colHex: 'Hex',
        colSource: t('소스', 'Source'),
        viewHex: t('바이트 보기', 'View bytes'),
        viewHexFor: t('{name} 바이트 보기', 'View bytes for {name}'),
        viewHexTitle: t('ELF 원본 파일의 해당 바이트를 Hex Viewer에서 열기', 'Open these bytes from the original ELF file in Hex Viewer'),
        noFileBytes: t('파일 바이트 없음', 'No file bytes'),
        noFileBytesFor: t('{name}: 파일 바이트 없음', 'No file bytes for {name}'),
        noFileBytesTitle: t('이 메모리 범위에 대응하는 ELF 파일 바이트가 없는 이유 보기', 'Show why this memory range has no corresponding ELF file bytes'),
        viewSource: t('소스 열기', 'Open source'),
        viewSourceFor: t('{name} 소스 열기', 'Open source for {name}'),
        viewSourceTitle: t('DWARF가 가리키는 소스 파일과 줄 열기', 'Open the source file and line referenced by DWARF'),
        // {region}/{percent}/{used}/{total} filled in the webview.
        usageBarLabel: t('{region} 사용률 {percent}% ({used} / {total})', '{region} usage {percent}% ({used} of {total})'),
        sortAscending: t('오름차순 정렬', 'Sort ascending'),
        sortDescending: t('내림차순 정렬', 'Sort descending'),
        objectSummary: t('오브젝트 요약', 'Object Summary'),
        // 이 토글이 펼치는 것은 오브젝트 하나를 이루는 **섹션 행**이다. 라벨이
        // `Details`였을 때는 바로 위 `regionDetails`(영역 상세)와 구별되지 않아
        // "영역 상세를 다시 접었다 폈다 하는 버튼"으로 읽혔다.
        toggleObjectDetails: t('섹션 행 표시 전환', 'Toggle section rows'),
        objDetailRows: t('섹션 행', 'Section rows'),
        // 오브젝트가 몇 개 섹션으로 이뤄졌는지. 위 토글이 무엇을 펼치는지
        // 누르기 전에 알려 준다.
        objSectionsOne: t('섹션 {n}개', '{n} section'),
        objSectionsMany: t('섹션 {n}개', '{n} sections'),
        // 펼쳤는데 아무것도 없는 영역. 안내가 없으면 글리프만 뒤집히고 화면은
        // 그대로여서 고장으로 읽힌다.
        //
        // 이 자리에 닿는 경우는 사실상 하나다 — **크기가 0으로 잡힌 영역**.
        // 배치된 섹션이 없어도 크기가 있으면 분석기가 `[FREE]` 세그먼트를
        // 만들어 넣으므로 표가 그려진다. 그래서 문구도 원인을 짚어 준다:
        // 여기까지 온 사람은 설정을 고쳐야 하는 사람이다.
        emptyRegion: t(
            '이 영역은 크기가 0으로 정의되어 아무것도 배치할 수 없습니다. 영역 크기 설정을 확인하세요.',
            'This region is defined with a size of 0, so nothing can be placed in it. Check the region size in your settings.'
        ),
        colObject: t('오브젝트', 'Object'),
        colFunction: t('함수', 'Function'),
        colPercent: t('비율', 'Percent'),
        noMatches: t('결과 없음', 'No matches'),
        // Function 열 토글 버튼의 **본문**. `toggleFunctionColumn`(title/aria-label)은
        // 0.6.21에 번역됐지만 눈에 보이는 라벨은 영어로 남아 있었다. 번들에
        // `colFunction`이 이미 있었는데도 남은 이유는 0.6.26 탐지기가 이걸
        // "번들 값 `Function 열 표시 전환`에 포함된다"며 통과시켰기 때문이다
        // (0.6.27에서 그 마스킹을 제거).
        funcColumnToggle: t('함수 열', 'Function'),
        // 검색 결과 요약. live region으로 읽히므로 문구가 그대로 낭독된다.
        // 한국어는 복수형이 없어 {n}만 갈아끼우면 되지만 영어는 단/복수가
        // 갈리므로 두 벌을 둔다.
        regionsMatchedOne: t(' — {n}개 영역 일치', ' — {n} region matched'),
        regionsMatchedMany: t(' — {n}개 영역 일치', ' — {n} regions matched'),
        // 심볼 이동 결과. 같은 live region 으로 읽힌다 — 이동의 유일한 신호가
        // 행 배경색이면 스크린리더 사용자에게는 아무 일도 일어나지 않은 것과 같다.
        // 검색을 지운 경우를 따로 두는 이유: 사용자가 직접 친 검색어가 사라진
        // 것이므로 그 사실과 이유가 화면에 남아야 한다.
        revealed: t(' — {name} ({addr}) 으로 이동', ' — moved to {name} ({addr})'),
        revealedAfterClear: t(
            ' — 검색을 지우고 {name} ({addr}) 으로 이동',
            ' — cleared the search to reach {name} ({addr})'
        ),
        elfSectionInfo: t(
            'AXF/ELF 파일에서는 섹션 단위 정보만 제공됩니다. 오브젝트(.o) 단위 분석 및 Linker 보고값은 ARM Linker Listing 파일을 사용하세요.',
            'AXF/ELF files provide section-level information only. Use an ARM Linker Listing file for object-level analysis and linker-reported values.'
        ),
        elfSymbolInfo: t(
            'ELF 심볼 테이블에서 함수/변수 정보를 추출하여 표시합니다. 프로그램 헤더 기반 자동 리전 감지가 적용되었습니다.',
            'Function and variable details are extracted from the ELF symbol table. Program-header based automatic region detection was applied.'
        ),
        noRegionsIntro: t(
            '메모리 영역 크기가 설정되지 않았습니다. 사용량 막대를 보려면:',
            'Memory region sizes are not configured. To see usage bars:'
        ),
        noRegionsSetting: t(
            '{setting} 설정을 {file}에 추가하세요.',
            'Add {setting} to {file}.'
        ),
    };
}

function getWebviewContent(
    fileName: string,
    entryPoint: number,
    flashTotal: number,
    ramTotal: number,
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[],
    regions: MemoryRegion[],
    hasSymbols?: boolean,
    sourceTargets: Map<string, MemoryMapSourceTarget> = new Map(),
    webview?: vscode.Webview,
    canRefresh: boolean = false,
    canConfigureLinker: boolean = false,
    renderId: string = generateMemoryMapNonce()
): string {
    const nonce = generateMemoryMapNonce();
    const cspSource = webview?.cspSource ?? 'vscode-webview:';
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`;
    const S = buildMemoryMapStrings();
    const stringsLiteral = JSON.stringify(S).replace(/</g, '\\u003c');
    const noRegionsSettingHtml = esc(S.noRegionsSetting)
        .replace('{setting}', '<code>memoryMap.regions</code>')
        .replace('{file}', '<code>.vscode/taskhub_types.json</code>');
    const htmlLang = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
    const refreshControls = canRefresh || canConfigureLinker
        ? `<span id="refreshControls" class="refresh-controls">
        ${canRefresh ? `<button id="btnRefresh" data-action="refresh" title="${esc(S.refreshTitle)}" aria-label="${esc(S.refresh)}" aria-describedby="refreshHint" aria-disabled="false">${esc(S.refresh)}</button>` : ''}
        ${canConfigureLinker ? `<button id="btnConfigureMemoryMap" data-action="configure-memory-map" title="${esc(S.configureMemoryMapTitle)}">${esc(S.configureMemoryMap)}</button>` : ''}
        ${canRefresh ? `<small id="refreshHint" class="refresh-hint">${esc(S.refreshHint)}</small>` : ''}</span>`
        : '';
    const refreshStatus = canRefresh
        ? `<div id="refreshFeedback" class="refresh-feedback">
            <div id="refreshStatus" class="refresh-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false"></div>
            <button id="refreshDismiss" class="refresh-dismiss" data-action="dismiss-refresh" aria-controls="refreshStatus" aria-expanded="true" title="${esc(S.dismissRefreshDetails)}" aria-label="${esc(S.dismissRefreshDetails)}" hidden>×</button>
        </div>`
        : '';
    // Build JSON data for lazy WebView rendering
    const regionJsonData = memoryUsage.map((u, regionIndex) => {
        const pct = u.total > 0 ? (u.used / u.total * 100) : 0;
        const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--ok)';
        const regionOrigin = regions.find(r => r.name === u.region)?.origin ?? 0;

        const allSegments = [
            ...u.sections.map((s, entryIndex) => ({
                name: s.name, size: s.size, addr: s.addr, type: s.type,
                section: s.section || '', func: s.func || '',
                hexTargetId: s.fileRange ? entryHexTargetId(regionIndex, entryIndex) : '',
                hexAvailable: s.fileRange?.kind === 'file',
                sourceTargetId: sourceTargets.has(entrySourceTargetId(regionIndex, entryIndex))
                    ? entrySourceTargetId(regionIndex, entryIndex)
                    : '',
            })),
            ...u.freeSpaces.map(f => ({
                name: '[FREE]', size: f.size, addr: f.addr, type: 'FREE', section: '', func: '',
                hexTargetId: '', hexAvailable: false, sourceTargetId: '',
            })),
        ].sort((a, b) => a.addr - b.addr).filter(e => e.size > 0);

        const hasSectionInfo = u.sections.some(s => s.section);
        const hasFuncInfo = u.sections.some(s => s.func);

        const mapSegHtml = allSegments.map(e => {
            const cls = `seg-${e.type.toLowerCase()}`;
            return `<div class="map-seg ${cls}" style="flex:${e.size}" title="${esc(e.name)} @ ${formatHex(e.addr)} (${formatSize(e.size)})"></div>`;
        }).join('');

        const segments = allSegments.map(e => ({
            n: e.name, s: e.section, f: e.func, a: e.addr,
            ah: formatHex(e.addr), eh: formatHex(e.size > 0 ? e.addr + e.size - 1 : e.addr),
            sz: e.size, ss: formatSize(e.size), t: e.type, fr: e.type === 'FREE',
            hx: e.hexTargetId, ha: e.hexAvailable, sx: e.sourceTargetId,
        }));

        interface ObjGroup { totalSize: number; entries: { section: string; addr: number; size: number; type: string }[] }
        const objGroups = new Map<string, ObjGroup>();
        for (const s of u.sections) {
            let g = objGroups.get(s.name);
            if (!g) { g = { totalSize: 0, entries: [] }; objGroups.set(s.name, g); }
            g.totalSize += s.size;
            g.entries.push({ section: s.func || s.section || s.type, addr: s.addr, size: s.size, type: s.type });
        }
        const regionObjSummary = Array.from(objGroups).map(([name, g]) => ({ name, ...g })).sort((a, b) => b.totalSize - a.totalSize);
        const regionUsed = u.used;

        const objSummary = regionObjSummary.map(o => ({
            n: o.name, ts: o.totalSize, tss: formatSize(o.totalSize),
            p: regionUsed > 0 ? (o.totalSize / regionUsed * 100).toFixed(1) : '0.0',
            // 정렬용 원본 퍼센트. 화면에 쓰는 `p`는 `toFixed(1)`로 반올림돼
            // 크기가 가까운 객체들이 동률이 되고, 안정 정렬이 그 구간에
            // 직전 정렬 순서를 남긴다 — 표시값으로 정렬하면 안 되는 이유다.
            pv: regionUsed > 0 ? o.totalSize / regionUsed * 100 : 0,
            bw: regionUsed > 0 ? Math.max(1, o.totalSize / regionUsed * 100) : 0,
            entries: o.entries.sort((a, b) => a.addr - b.addr).map(e => ({
                s: e.section, ah: formatHex(e.addr),
                eh: formatHex(e.size > 0 ? e.addr + e.size - 1 : e.addr),
                sz: e.size, ss: formatSize(e.size), t: e.type
            }))
        }));

        const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
        const linkerFree = u.reportedUsed !== undefined ? u.total - u.reportedUsed : 0;

        return {
            name: u.region, pct, color, mapSegHtml,
            infoText: `${S.colUsed}: ${formatSize(u.used)} / ${formatSize(u.total)} (${pct.toFixed(1)}%) | ${S.colFree}: ${formatSize(calcFree)}`,
            linkerLine: u.reportedUsed !== undefined
                ? `Linker: Base=${formatHex(regionOrigin)} Used=${formatHex(u.reportedUsed)} (${formatSize(u.reportedUsed)}) Max=${formatHex(u.total)} (${formatSize(u.total)}) Free: ${formatSize(linkerFree)}`
                : '',
            segments, objSummary,
            hsi: hasSectionInfo, hfi: hasFuncInfo, hmo: regionObjSummary.length > 1,
            hhx: u.sections.some(s => s.fileRange !== undefined),
            hhs: u.sections.some((_s, entryIndex) => sourceTargets.has(entrySourceTargetId(regionIndex, entryIndex))),
        };
    });

    // Minimal region card HTML (details rendered lazily by JS).
    // Click handlers are attached via delegation in the nonced <script> block below
    // so the CSP does not need to allow inline event attributes.
    const regionCardsHtml = regionJsonData.map((rd: any, idx: number) => `
        <div class="region-card" id="region-${esc(rd.name)}" data-idx="${idx}">
            <!-- 영역 이름은 제목이다(h3). 접기 컨트롤을 제목이 감싸는 형태라야
                 제목 목록으로 영역 사이를 건너뛸 수 있다 — 컨트롤 자체를
                 제목으로 만들면 role="button"이 제목 역할을 덮어쓴다. h3의
                 내용 모델이 phrasing 이라 컨트롤은 span 이다. -->
            <h3 class="region-heading"><span class="region-header" data-action="toggle-region" role="button" tabindex="0" aria-expanded="false">
                <span class="fold-icon" aria-hidden="true">▶</span>
                <strong>${esc(rd.name)}</strong>
                <span class="region-info">${esc(rd.infoText)}</span>
            </span></h3>
            ${rd.linkerLine ? `<div class="region-linker">${esc(rd.linkerLine)}</div>` : ''}
            <!-- The same numbers are already spelled out in .region-info above,
                 so the bar is decorative: announcing it twice adds nothing. -->
            <!-- 막대도 카드를 여닫는다. 헤더 한 줄만 눌리던 탓에, 카드에서
                 가장 눈에 띄는 이 20px 띠를 눌러도 아무 일이 없었다. 키보드
                 경로는 헤더가 담당하므로 여기서는 마우스 편의만 더한다
                 (aria-hidden 이라 스크린리더에는 잡히지 않는다). -->
            <div class="bar-bg" data-action="toggle-region" aria-hidden="true"><div class="bar-fill" style="width:${Math.min(rd.pct, 100)}%;background:${rd.color}"></div></div>
            <div class="region-detail" style="display:none"></div>
        </div>`).join('');

    const hasRegions = memoryUsage.length > 0;
    const hasLinkerData = memoryUsage.some(u => u.reportedUsed !== undefined);
    const hasFuncData = memoryUsage.some(u => u.sections.some(s => s.func));
    // All Sections 표는 자기 데이터만 보고 열을 결정한다. 영역 상세의 Hex 열은
    // 각 영역의 `hhx`가 따로 제어하므로 두 데이터셋을 묶으면 빈 열이 생길 수 있다.
    const hasSectionHexTargets = sectionSummary.some(s => s.fileRange !== undefined);

    const regionOverviewRows = memoryUsage.map(u => {
        const pct = u.total > 0 ? (u.used / u.total * 100) : 0;
        const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
        const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--ok)';
        const origin = regions.find(r => r.name === u.region)?.origin ?? 0;
        const linkerUsed = u.reportedUsed !== undefined ? formatSize(u.reportedUsed) : '-';
        const linkerFree = u.reportedUsed !== undefined ? formatSize(u.total - u.reportedUsed) : '-';
        return `<tr class="overview-row" data-region="${esc(u.region)}">
            <td><strong>${esc(u.region)}</strong></td>
            <td class="num">${formatHex(origin)}</td>
            <td class="num">${formatSize(u.total)}</td>
            ${hasLinkerData ? `<td class="num">${linkerUsed}</td>` : ''}
            <td class="num">${formatSize(u.used)}</td>
            ${hasLinkerData ? `<td class="num">${linkerFree}</td>` : ''}
            <td class="num">${formatSize(calcFree)}</td>
            <td class="num">${pct.toFixed(1)}%</td>
            <td aria-hidden="true"><div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div></td>
        </tr>`;
    }).join('');

    const col = (label: string, numeric = true) => `<th class="${numeric ? 'num' : ''}" scope="col">${esc(label)}</th>`;
    const overviewHeaders = hasLinkerData
        ? `${col(S.colRegion, false)}${col(S.colBase)}${col(S.colMax)}${col(S.colLinkerUsed)}${col(S.colCalcUsed)}${col(S.colLinkerFree)}${col(S.colCalcFree)}${col(S.colUsage)}<th aria-hidden="true"></th>`
        : `${col(S.colRegion, false)}${col(S.colBase)}${col(S.colMax)}${col(S.colUsed)}${col(S.colFree)}${col(S.colUsage)}<th aria-hidden="true"></th>`;

    // 정렬값을 행 속성으로 싣는다. 헤더 키(name / addr / endAddr / size /
    // bytes / type)와 이름을 맞춰야 정렬기가 찾는다.
    //
    // 셀 텍스트로 정렬하면 표시 형식 때문에 순서가 뒤집힌다: 폴백 파서가
    // 숫자가 아닌 문자를 지우므로 `0x0000F000` → `0`(F 소실), `0x00001000`
    // → `1000` 이 되어 주소 정렬이 무너지고, `1.2 KB` → `1.2` vs `900 B`
    // → `900` 처럼 단위가 다른 크기도 역전된다. 0.6.34 가 Object Summary 만
    // 속성 기반으로 옮겼고 이 표는 남아 있었다.
    const sectionTableRows = sectionSummary.map((s, sectionIndex) =>
        `<tr data-sort-name="${esc(s.name)}" data-sort-addr="${s.addr}" data-sort-endaddr="${s.size > 0 ? s.endAddr - 1 : s.endAddr}" data-sort-size="${s.size}" data-sort-bytes="${s.size}" data-sort-type="${esc(s.type)}">
            <td>${esc(s.name)}</td>
            <td class="num">${formatHex(s.addr)}</td>
            <td class="num">${formatHex(s.size > 0 ? s.endAddr - 1 : s.endAddr)}</td>
            <td class="num">${formatSize(s.size)}</td>
            <td class="num">${s.size}</td>
            <td><span class="type-badge type-${s.type.toLowerCase()}">${s.type}</span></td>
            ${hasSectionHexTargets ? s.fileRange
                ? `<td class="memory-map-host-only"><button class="hex-link${s.fileRange.kind === 'file' ? '' : ' unavailable'}" data-action="open-hex" data-target-id="${sectionHexTargetId(sectionIndex)}" title="${esc(s.fileRange.kind === 'file' ? S.viewHexTitle : S.noFileBytesTitle)}" aria-label="${esc((s.fileRange.kind === 'file' ? S.viewHexFor : S.noFileBytesFor).replace('{name}', () => s.name))}">${esc(s.fileRange.kind === 'file' ? S.viewHex : S.noFileBytes)}</button></td>`
                : '<td class="memory-map-host-only"></td>' : ''}
        </tr>`
    ).join('');

    // Inject region data as a JSON-encoded JS literal.
    //   1. JSON.stringify handles all JS escaping (quotes, backslashes,
    //      control chars, line separators) and preserves Unicode losslessly —
    //      avoids the atob() mojibake we previously hit on "—" / "≥".
    //   2. .replace(/</g, '\\u003c') prevents HTML-parser early script
    //      termination if user-controlled input (filename, file path, region
    //      or section names) ever contains "</script>". The JS parser still
    //      decodes < back to "<", but the HTML parser doesn't see it.
    // Arrays/objects end up safely embeddable inside <script>...</script>
    // because every "<" is escaped — the JS parser still rebuilds the original
    // value, but the HTML parser cannot see "</script>" in the payload.
    //
    // textReport/summaryReport는 host의 copy handler가 직접 사용한다. 웹뷰에
    // 중복 삽입하면 Save HTML payload가 커지고 Copy Full Dump 때 같은 거대
    // 문자열이 다시 IPC로 복제되므로 의도적으로 여기에는 포함하지 않는다.
    const escapeForScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
    const regionDataJsLiteral = escapeForScript(regionJsonData);

    return /*html*/`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Memory Map</title>
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --border: var(--vscode-panel-border, #444);
        --ok: #4caf50;
        --warn: #ff9800;
        --danger: var(--vscode-errorForeground, #f44);
        --badge-bg: var(--vscode-badge-background, #444);
        --badge-fg: var(--vscode-badge-foreground, #fff);
        --hover-bg: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
        --btn-bg: var(--vscode-button-background);
        --btn-fg: var(--vscode-button-foreground);
        --btn-hover: var(--vscode-button-hoverBackground);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--fg);
        background: var(--bg);
        padding: 16px;
    }
    h1 { font-size: 16px; margin-bottom: 4px; }
    .header-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        flex-wrap: wrap;
        gap: 8px 12px;
        margin-bottom: 16px;
    }
    .header-left { flex: 1 1 220px; min-width: 0; }
    .header-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .subtitle { font-size: 11px; opacity: 0.6; }
    button {
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        padding: 4px 10px;
        min-width: 24px;
        min-height: 24px;
        cursor: pointer;
        border-radius: 2px;
        font-size: 11px;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled { opacity: 0.45; cursor: default; }
    button[aria-disabled="true"] {
        opacity: 1;
        cursor: default;
        color: var(--vscode-button-secondaryForeground, #ffffff);
        background: var(--vscode-button-secondaryBackground, #5f6a79);
    }
    button[aria-disabled="true"]:hover {
        background: var(--vscode-button-secondaryBackground, #5f6a79);
    }
    button.hex-link.unavailable {
        background: transparent;
        color: var(--vscode-descriptionForeground, var(--fg));
        border: 1px solid var(--border);
    }
    button.hex-link.unavailable:hover { background: var(--hover-bg); }
    .summary-row {
        display: flex;
        gap: 12px;
        margin-bottom: 16px;
    }
    .summary-card {
        flex: 1;
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 12px;
        text-align: center;
    }
    .summary-label { font-size: 11px; opacity: 0.7; margin-bottom: 4px; }
    .summary-value { font-size: 20px; font-weight: bold; }
    .summary-bytes { font-size: 10px; opacity: 0.5; margin-top: 2px; }
    .region-card {
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 12px;
    }
    .region-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        font-size: 13px;
    }
    .region-info {
        margin-left: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
    }
    .bar-bg {
        height: 20px;
        background: var(--hover-bg);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
        cursor: pointer;
    }
    /* 눌러서 카드를 여닫는 막대다. 커서 모양만으로는 신호가 약하고, 펼친
       카드에서는 12px 아래에 생김새가 비슷한 map-bar(누를 수 없다)가 붙는다 —
       테두리로 "이쪽이 눌리는 쪽"을 구분한다. 터치에는 커서가 없으므로 이게
       유일한 단서이기도 하다. */
    .bar-bg:hover { box-shadow: inset 0 0 0 1px var(--border); }
    .empty-region { font-size: 12px; opacity: 0.7; padding: 4px 0 8px; }
    .bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
    }
    th, td {
        border: 1px solid var(--border);
        padding: 3px 8px;
        text-align: left;
        font-size: 12px;
    }
    th {
        background: var(--hover-bg);
        font-weight: 600;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
    }
    .num { text-align: right; font-family: var(--vscode-editor-font-family, monospace); }
    tr:hover { background: var(--hover-bg); }
    .type-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 8px;
        font-size: 10px;
        font-weight: 600;
        background: var(--badge-bg);
        color: var(--badge-fg);
    }
    .type-code { background: #2196f3; }
    .type-data { background: #ff9800; }
    .type-rodata { background: #9c27b0; color: #fff; }
    .type-nobits { background: #607d8b; }
    .type-free { background: #37474f; }
    .map-bar {
        display: flex;
        gap: 1px;
        height: 14px;
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
        background: var(--hover-bg);
    }
    .map-seg {
        height: 100%;
        min-width: 0;
    }
    .map-seg:hover { opacity: 0.75; }
    .seg-code { background: #2196f3; }
    .seg-rodata { background: #9c27b0; }
    .seg-data { background: #ff9800; }
    .seg-nobits { background: #607d8b; }
    .seg-free { background: rgba(128,128,128,0.15); }
    .free-row { opacity: 0.55; font-style: italic; }
    .search-box {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
        margin-bottom: 8px;
        background: var(--bg);
        border-bottom: 1px solid var(--border);
    }
    .search-box input {
        flex: 1;
        background: var(--vscode-input-background, #333);
        color: var(--vscode-input-foreground, #fff);
        border: 1px solid var(--vscode-input-border, #555);
        padding: 4px 8px;
        border-radius: 2px;
        font-size: 12px;
        outline: none;
    }
    .search-box input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .search-count { font-size: 11px; opacity: 0.7; white-space: nowrap; min-width: 3.5em; text-align: right; }
    .search-count.no-match { color: var(--danger); opacity: 1; }
    .search-box button.nav-btn { padding: 2px 7px; line-height: 1.3; font-size: 10px; }
    .search-box button.nav-btn:disabled { opacity: 0.4; cursor: default; }
    .search-match { background: rgba(255, 213, 0, 0.12) !important; }
    mark.sm-hl {
        background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 213, 0, 0.5));
        color: inherit;
        border-radius: 2px;
        padding: 0 1px;
    }
    tr.current-match { background: var(--vscode-list-activeSelectionBackground, rgba(255, 170, 0, 0.22)) !important; }
    /* 배경만 바꾸고 글자색을 그대로 두면 밝은 테마에서 대비가 무너진다 —
       list.activeSelectionBackground 는 #0060C0 같은 진한 색이라 기본 전경색과
       3.4:1 밖에 되지 않아, 방금 이동한 행이 화면에서 가장 읽기 힘든 줄이 된다.
       배경과 짝을 이루는 전경색을 함께 쓴다(WCAG 1.4.3). */
    tr.current-match td { color: var(--vscode-list-activeSelectionForeground, inherit); }
    tr.current-match td:first-child { box-shadow: inset 3px 0 0 var(--vscode-focusBorder, #007acc); }
    /* 명령으로 이동한 행은 포커스를 받는다(tabindex=-1). 어디에 섰는지 보이게 한다. */
    tr.current-match:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px; }
    tr.current-match mark.sm-hl { background: var(--vscode-editor-findMatchBackground, #d18616); color: var(--vscode-editor-foreground, inherit); }
    /* 제목이 감싸도 카드 안에서의 생김새는 그대로여야 한다 — 크기·굵기·여백은
       카드가 정하고, h3 는 의미만 얹는다. */
    .region-heading { font-size: inherit; font-weight: inherit; margin: 0; }
    .region-header { display: block; cursor: pointer; }
    /* 투명도만 낮추던 종전 hover는 "누를 수 있는 줄"이라는 신호로 약했다.
       표 행(tr:hover)과 같은 배경을 써서 카드 전체에서 눌리는 영역이 어디인지
       한눈에 보이게 한다. */
    .region-header:hover { background: var(--hover-bg); }
    /* 두 접기 헤더는 tabindex=0인 <div>다. 포커스 표시가 없으면 키보드
       사용자는 지금 어디에 서 있는지 알 수 없다 — Enter를 눌러 보기 전에는. */
    .region-header:focus-visible,
    .obj-summary-header:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, #007acc);
        outline-offset: 2px;
    }
    .fold-icon {
        display: inline-block;
        width: 16px;
        font-size: 10px;
    }
    .region-detail { margin-top: 4px; }
    .overview-table { margin-bottom: 12px; }
    .overview-table td { padding: 4px 8px; }
    .overview-row { cursor: pointer; }
    .mini-bar {
        width: 80px;
        height: 10px;
        background: var(--hover-bg);
        border-radius: 2px;
        overflow: hidden;
        display: inline-block;
    }
    .mini-bar-fill { height: 100%; border-radius: 2px; }
    .region-linker {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        opacity: 0.6;
        margin-bottom: 4px;
    }
    .section-heading {
        font-size: 14px;
        font-weight: 600;
        margin: 16px 0 8px;
    }
    /* 제목 텍스트만 heading 요소로 감싼다 — 컨테이너를 통째로 제목으로 만들면
       그 안의 버튼("영역 모두 펼치기" 등)까지 제목 이름에 딸려 들어가, 제목
       목록으로 훑는 사람에게 잡음이 된다. 크기·굵기는 컨테이너에서 상속받는다. */
    .section-heading h2 { display: inline; font-size: inherit; font-weight: inherit; margin: 0; }
    .no-regions {
        padding: 12px;
        border: 1px dashed var(--border);
        border-radius: 4px;
        opacity: 0.6;
        font-size: 12px;
        margin-bottom: 16px;
        line-height: 1.6;
    }
    .no-regions .inline-action {
        display: inline;
        padding: 1px 5px;
        font-size: inherit;
        vertical-align: baseline;
    }
    .info-note {
        padding: 8px 12px;
        border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
        background: rgba(55, 148, 255, 0.06);
        font-size: 12px;
        opacity: 0.8;
        margin-bottom: 12px;
    }
    .scroll-top {
        position: fixed;
        bottom: 16px;
        right: 16px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        z-index: 100;
    }
    .scroll-top:hover { background: var(--btn-hover); }
    .scroll-top.visible { opacity: 1; pointer-events: auto; }
    .func-cell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
    .func-cell.hidden { display: none; }
    .obj-detail-row { display: none; font-size: 11px; opacity: 0.7; }
    .obj-summary-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .obj-summary-heading { font-size: inherit; font-weight: inherit; margin: 0; }
    .obj-summary-header { display: inline-block; font-size: 12px; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 3px; }
    .obj-summary-bar button { font-size: 11px; padding: 4px 10px; }
    .obj-summary-header:hover { background: var(--hover-bg); }
    .refresh-controls {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        min-width: 0;
        max-width: 520px;
    }
    .refresh-hint {
        flex: 1 1 260px;
        min-width: 180px;
        color: var(--vscode-descriptionForeground, var(--fg));
        font-size: 11px;
        line-height: 1.35;
    }
    .refresh-feedback { display: flex; align-items: flex-start; gap: 6px; }
    .refresh-status {
        border-radius: 3px;
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .refresh-status:empty { border: 0; margin: 0; padding: 0; }
    .refresh-status.is-busy,
    .refresh-status.is-success,
    .refresh-status.is-error {
        margin: 2px 0 12px;
        padding: 8px 10px;
    }
    .refresh-status.is-busy {
        border: 1px solid var(--vscode-editorInfo-foreground, #3794ff);
        background: var(--vscode-editorInfo-background, rgba(55, 148, 255, 0.08));
        color: var(--fg);
    }
    .refresh-status.is-success {
        border-left: 3px solid var(--ok);
        background: var(--vscode-editorInfo-background, rgba(76, 175, 80, 0.08));
        color: var(--fg);
    }
    .refresh-status.is-error {
        border: 1px solid var(--vscode-inputValidation-errorBorder, var(--danger));
        background: var(--vscode-inputValidation-errorBackground, rgba(190, 17, 0, 0.12));
        color: var(--vscode-inputValidation-errorForeground, var(--fg));
    }
    .refresh-status.is-compact { flex: 0 1 auto; font-size: 11px; padding: 4px 8px; }
    .refresh-dismiss { flex: 0 0 auto; margin-top: 2px; min-width: 28px; padding: 7px; }
    .refresh-dismiss[hidden] { display: none; }
    .standalone-notice {
        padding: 8px 12px;
        border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
        background: var(--vscode-editorInfo-background, rgba(55, 148, 255, 0.08));
        margin-bottom: 12px;
        font-size: 12px;
    }
    @media (max-width: 480px) {
        body { padding: 12px; }
        .header-left { flex-basis: 100%; }
        .header-actions { flex: 1 1 100%; justify-content: flex-start; }
        .header-actions button { flex: 1 1 auto; white-space: nowrap; }
        .refresh-controls { flex: 1 1 100%; max-width: none; }
        .refresh-hint { flex-basis: 100%; min-width: 0; }
    }
    /* 0.55는 기본 Dark+ 팔레트에서 4.34:1로 WCAG AA(4.5:1) 미달이다. 이 값이
       섹션 행 토글이 무엇을 펼칠지 알려 주는 유일한 자리라 읽혀야 한다. */
    .obj-sec-count { opacity: 0.7; font-size: 11px; font-weight: normal; }
    .obj-summary-table { margin-bottom: 10px; }
    .vt-viewport { position: relative; }
    .vt-viewport thead th { position: sticky; top: 0; z-index: 1; background: var(--bg); }
    .vt-viewport table { margin-top: 0; }
</style>
</head>
<body>
    <div class="header-row">
        <div class="header-left">
            <h1>${esc(fileName)}</h1>
            <div class="subtitle">${esc(S.entryPoint)}: ${formatHex(entryPoint)}</div>
        </div>
        <div id="memoryMapHostActions" class="header-actions">
            <button id="btnCopy" title="${esc(S.copyReportTitle)}">${esc(S.copyReport)}</button>
            <button id="btnCopyFull" title="${esc(S.copyFullDumpTitle)}">${esc(S.copyFullDump)}</button>
            <button id="btnSaveHtml" title="${esc(S.saveHtmlTitle)}">${esc(S.saveHtml)}</button>
            ${refreshControls}
        </div>
    </div>
    <div id="memoryMapStandaloneNotice" class="standalone-notice" hidden>${esc(S.standaloneNotice)}</div>
    ${refreshStatus}

    <div class="search-box">
        <input id="searchInput" type="text" placeholder="${esc(S.searchPlaceholder)}" aria-label="${esc(S.searchLabel)}">
        <span id="searchCount" class="search-count" role="status" aria-live="polite"></span>
        <button id="searchPrev" class="nav-btn" title="${esc(S.searchPrev)}" aria-label="${esc(S.searchPrev)}" disabled>◀</button>
        <button id="searchNext" class="nav-btn" title="${esc(S.searchNext)}" aria-label="${esc(S.searchNext)}" disabled>▶</button>
    </div>

    ${hasRegions ? `
        <div class="section-heading"><h2>${esc(S.memoryRegions)}</h2></div>
        <table class="overview-table"><thead><tr>${overviewHeaders}</tr></thead><tbody>${regionOverviewRows}</tbody></table>
        ${!hasLinkerData && !hasSymbols ? `<div class="info-note">${esc(S.elfSectionInfo)}</div>` : ''}
        ${hasSymbols ? `<div class="info-note">${esc(S.elfSymbolInfo)}</div>` : ''}
        <div class="section-heading"><h2>${esc(S.regionDetails)}</h2><span id="regMatchInfo" role="status" aria-live="polite"></span> <button data-action="toggle-all" id="toggleAllBtn" title="${esc(S.expandAllHint)}" aria-label="${esc(S.expandAll)}" aria-expanded="false">▶ ${esc(S.expandAll)}</button>${hasFuncData ? ` <button data-action="toggle-func-col" title="${esc(S.toggleFunctionColumn)}" aria-label="${esc(S.toggleFunctionColumn)}">${esc(S.funcColumnToggle)} ▶</button>` : ''}</div>
        ${regionCardsHtml}
    ` : `
        <div class="no-regions">
            ${esc(S.noRegionsIntro)}<br>
            ${canConfigureLinker ? `<span id="noRegionConfigure">- <button class="inline-action" data-action="configure-memory-map" title="${esc(S.configureMemoryMapTitle)}">${esc(S.configureMemoryMap)}</button><br></span>` : ''}
            - ${noRegionsSettingHtml}
        </div>
    `}

    <div class="section-heading"><h2>${esc(S.allSections)} (<span id="allSecCount">${sectionSummary.length}</span>)</h2></div>
    <table id="sectionTable" class="sortable-table">
        <thead>
            <tr>
                <th data-sort="name" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colSection)}</th>
                <th class="num" data-sort="addr" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colAddress)}</th>
                <th class="num" data-sort="endAddr" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colEnd)}</th>
                <th class="num" data-sort="size" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colSize)}</th>
                <th class="num" data-sort="bytes" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colBytes)}</th>
                <th data-sort="type" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colType)}</th>
                ${hasSectionHexTargets ? `<th class="memory-map-host-only" scope="col">${esc(S.colHex)}</th>` : ''}
            </tr>
        </thead>
        <tbody>${sectionTableRows}</tbody>
    </table>

<button id="scrollTop" class="scroll-top" title="${esc(S.scrollTop)}" aria-label="${esc(S.scrollTop)}">↑</button>

<script nonce="${nonce}">
const RD = ${regionDataJsLiteral};
const CURRENT_TOTALS = Object.freeze({ flash: ${flashTotal}, ram: ${ramTotal} });
(function() {
    const IS_STANDALONE = typeof acquireVsCodeApi !== 'function';
    const vscode = acquireVsCodeApi();
    // Locale-resolved UI labels from the host (buildMemoryMapStrings).
    const S = ${stringsLiteral};
    if (IS_STANDALONE) {
        document.querySelectorAll('.memory-map-host-only').forEach(function(cell) { cell.remove(); });
        const standaloneNotice = document.getElementById('memoryMapStandaloneNotice');
        if (standaloneNotice) { standaloneNotice.hidden = false; }

        // Save as HTML은 live outerHTML을 받으므로, 저장 순간에 펼쳐진 lazy DOM과
        // 검색 강조가 함께 직렬화될 수 있다. 새 문서의 rendered/vtMap은 비어
        // 있어 그 DOM을 그대로 두면 검색·스크롤이 보이는 표와 다른 상태를
        // 조작한다. canonical 데이터(RD)로 다시 만들 수 있도록 정적 시작 상태로
        // 정규화한다. 사용자는 곧바로 검색하거나 영역을 다시 펼칠 수 있다.
        const standaloneSearch = document.getElementById('searchInput');
        if (standaloneSearch) { standaloneSearch.value = ''; }
        document.querySelectorAll('.region-card').forEach(function(card) {
            card.style.display = '';
            const detail = card.querySelector('.region-detail');
            if (detail) {
                detail.innerHTML = '';
                detail.style.display = 'none';
            }
            const header = card.querySelector('.region-header');
            if (header) { header.setAttribute('aria-expanded', 'false'); }
            const icon = card.querySelector('.region-header .fold-icon');
            if (icon) { icon.textContent = '\u25B6'; }
        });
        document.querySelectorAll('mark.sm-hl').forEach(function(mark) {
            mark.replaceWith(mark.textContent || '');
        });
        document.querySelectorAll('#sectionTable tbody tr, .overview-table tbody tr').forEach(function(row) {
            row.style.display = '';
            row.classList.remove('search-match', 'current-match');
        });
        document.querySelectorAll('.current-match').forEach(function(row) {
            row.classList.remove('current-match');
        });
        document.querySelectorAll('.func-cell').forEach(function(cell) {
            cell.classList.add('hidden');
        });
        document.querySelectorAll('.sortable-table th[data-sort]').forEach(function(header) {
            header.textContent = header.textContent.replace(/ [\u25B2\u25BC]$/, '');
            header.setAttribute('aria-sort', 'none');
            header.setAttribute('title', S.sortAscending);
        });
    }
    // render ID는 이전 문서에서 늦게 도착한 host 메시지를 거르는 세대 값이다.
    // 화면 상태는 별도 필드로 저장해 성공한 Refresh의 새 세대에도 복원한다.
    const RENDER_ID = ${JSON.stringify(renderId)};
    let refreshInFlight = false;
    let refreshFeedbackGeneration = 0;
    let refreshLifecycleGeneration = 0;
    let refreshAttemptSequence = 0;
    let activeRefreshAttemptId;
    let pendingSnapshotScheduled = false;
    function readWebviewState() {
        if (typeof vscode === 'undefined' || typeof vscode.getState !== 'function') return {};
        const state = vscode.getState();
        return state && typeof state === 'object' ? state : {};
    }
    function persistWebviewState(patch) {
        if (typeof vscode === 'undefined' || typeof vscode.setState !== 'function') return;
        vscode.setState(Object.assign({}, readWebviewState(), patch, { memoryMapRenderId: RENDER_ID }));
    }
    function afterPaint(callback) {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function() { requestAnimationFrame(callback); });
        } else {
            callback();
        }
    }
    function refreshTime(timestamp) {
        const value = Number(timestamp);
        const date = Number.isFinite(value) ? new Date(value) : new Date();
        const locale = document.documentElement.lang || undefined;
        try {
            return new Intl.DateTimeFormat(locale, {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            }).format(date);
        } catch {
            try {
                return date.toLocaleTimeString(locale);
            } catch {
                return date.toLocaleTimeString();
            }
        }
    }
    function refreshSize(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) return '';
        if (value < 1024) return value + ' B';
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
        return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function refreshSuccessMessage(completedAt, previousTotals) {
        const base = fmt(S.refreshSucceeded, { time: refreshTime(completedAt) });
        if (!previousTotals || typeof previousTotals !== 'object') return base;
        const previousFlash = Number(previousTotals.flash);
        const previousRam = Number(previousTotals.ram);
        if (!Number.isFinite(previousFlash) || previousFlash < 0
            || !Number.isFinite(previousRam) || previousRam < 0) return base;
        const changes = [];
        if (previousFlash !== CURRENT_TOTALS.flash) {
            changes.push(S.refreshFlash + ' ' + refreshSize(previousFlash) + ' \u2192 ' + refreshSize(CURRENT_TOTALS.flash));
        }
        if (previousRam !== CURRENT_TOTALS.ram) {
            changes.push(S.refreshRam + ' ' + refreshSize(previousRam) + ' \u2192 ' + refreshSize(CURRENT_TOTALS.ram));
        }
        return base + ' \u00B7 ' + (changes.length > 0 ? changes.join(' \u00B7 ') : S.refreshUsageUnchanged);
    }
    function scheduleUiTimeout(callback, delayMs) {
        if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
            window.setTimeout(callback, delayMs);
        }
    }
    function scheduleSuccessCompaction() {
        const expectedGeneration = refreshFeedbackGeneration;
        scheduleUiTimeout(function() {
            if (expectedGeneration !== refreshFeedbackGeneration || refreshInFlight) return;
            const refreshStatus = document.getElementById('refreshStatus');
            if (refreshStatus && refreshStatus.classList.contains('is-success')) {
                refreshStatus.classList.add('is-compact');
            }
        }, 8000);
    }
    function setRefreshFeedback(kind, message, focusButton, detailsExpanded) {
        const refreshButton = document.getElementById('btnRefresh');
        const configureButton = document.getElementById('btnConfigureMemoryMap');
        const refreshStatus = document.getElementById('refreshStatus');
        const refreshDismiss = document.getElementById('refreshDismiss');
        if (!refreshButton || !refreshStatus) return;
        const feedbackGeneration = ++refreshFeedbackGeneration;
        refreshInFlight = kind === 'busy';
        refreshButton.setAttribute('aria-disabled', refreshInFlight ? 'true' : 'false');
        if (configureButton) {
            configureButton.setAttribute('aria-disabled', refreshInFlight ? 'true' : 'false');
        }
        refreshStatus.className = 'refresh-status' + (kind ? ' is-' + kind : '');
        refreshStatus.title = '';
        refreshStatus.textContent = message || '';
        // busy=true인 live region은 갱신 알림을 보류한다. 먼저 문구를 쓰고 현재
        // busy를 false로 풀어 알린 뒤, 진행 상태라면 다음 paint 이후에만 true로
        // 바꾼다. 그 사이 성공/실패가 도착하면 refreshInFlight guard가 stale
        // callback이 true를 되살리는 것도 막는다.
        refreshStatus.setAttribute('aria-busy', 'false');
        if (refreshInFlight) {
            afterPaint(function() {
                if (feedbackGeneration === refreshFeedbackGeneration && refreshInFlight) {
                    refreshStatus.setAttribute('aria-busy', 'true');
                }
            });
            // 동기 ELF 분석을 UI timer로 취소할 수는 없다. 버튼을 다시
            // 활성화해 중복 파싱을 허용하지 말고, 오래 걸린다는 상태만
            // 알린다. 이후 성공/실패가 오면 generation guard가 이 callback을 버린다.
            scheduleUiTimeout(function() {
                if (feedbackGeneration !== refreshFeedbackGeneration || !refreshInFlight) return;
                refreshStatus.setAttribute('aria-busy', 'false');
                refreshStatus.textContent = S.refreshTakingLong;
                afterPaint(function() {
                    if (feedbackGeneration === refreshFeedbackGeneration && refreshInFlight) {
                        refreshStatus.setAttribute('aria-busy', 'true');
                    }
                });
            }, 12000);
        }
        if (refreshDismiss) {
            const hasDetails = typeof detailsExpanded === 'boolean';
            refreshDismiss.hidden = !hasDetails;
            if (hasDetails) {
                const expanded = detailsExpanded === true;
                const label = expanded ? S.dismissRefreshDetails : S.showRefreshDetails;
                refreshDismiss.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                refreshDismiss.setAttribute('aria-label', label);
                refreshDismiss.setAttribute('title', label);
                refreshDismiss.textContent = expanded ? '×' : '…';
            }
        }
        if (focusButton) { afterPaint(function() { refreshButton.focus({ preventScroll: true }); }); }
    }
    function normalizeFeedbackReason(reason) {
        const rawReason = typeof reason === 'string' && reason.trim() ? reason.trim() : S.refreshInterrupted;
        return /[.!?…。！？](?:["'”’)}»›]*)$/u.test(rawReason)
            ? rawReason
            : rawReason + '.';
    }
    function renderRefreshFailure(reason, failedAt, focusButton, compact) {
        const safeReason = normalizeFeedbackReason(reason);
        const effectiveFailedAt = Number.isFinite(Number(failedAt)) ? Number(failedAt) : Date.now();
        const time = refreshTime(effectiveFailedAt);
        const fullMessage = fmt(S.refreshFailedAt, { time: time, reason: safeReason });
        const message = compact
            ? fmt(S.refreshStaleCompact, { time: time })
            : fullMessage;
        setRefreshFeedback(compact ? 'error is-compact' : 'error', message, focusButton, !compact);
        const refreshStatus = document.getElementById('refreshStatus');
        if (refreshStatus) { refreshStatus.title = compact ? fullMessage : ''; }
        persistWebviewState({
            refreshPending: false,
            refreshFailed: true,
            refreshFailureReason: safeReason,
            refreshFailedAt: effectiveFailedAt,
            refreshFailureDismissed: compact === true,
            refreshAttemptId: undefined
        });
    }
    function renderRefreshSuccess(completedAt, focusButton, previousTotals) {
        setRefreshFeedback('success', refreshSuccessMessage(completedAt, previousTotals), focusButton, undefined);
        scheduleSuccessCompaction();
        persistWebviewState({
            refreshPending: false,
            refreshFailed: false,
            refreshFailureReason: undefined,
            refreshFailedAt: undefined,
            refreshFailureDismissed: false,
            refreshAttemptId: undefined,
            refreshCompletedAt: completedAt || Date.now()
        });
    }
    function renderMemoryMapConfigurationFeedback(message) {
        const completedAt = Number.isFinite(Number(message.at)) ? Number(message.at) : Date.now();
        const time = refreshTime(completedAt);
        if (message.kind === 'configure-success') {
            setRefreshFeedback('success', fmt(S.configureSucceededAt, {
                time: time,
                file: typeof message.linkerName === 'string' ? message.linkerName : ''
            }), true, undefined);
            scheduleSuccessCompaction();
            return;
        }
        const reason = normalizeFeedbackReason(message.reason);
        setRefreshFeedback('error', fmt(S.configureFailedAt, {
            time: time,
            reason: reason
        }), true, undefined);
    }
    const savedWebviewState = readWebviewState();
    const sameRenderState = savedWebviewState.memoryMapRenderId === RENDER_ID;
    const savedRefreshAttemptId = typeof savedWebviewState.refreshAttemptId === 'string'
        && savedWebviewState.refreshAttemptId.length > 0
        && savedWebviewState.refreshAttemptId.length <= 128
        ? savedWebviewState.refreshAttemptId
        : undefined;
    const refreshStillPending = sameRenderState && savedWebviewState.refreshPending === true
        && savedRefreshAttemptId !== undefined;
    const refreshSucceededOnLoad = !sameRenderState && savedWebviewState.refreshPending === true;
    activeRefreshAttemptId = refreshStillPending ? savedRefreshAttemptId : undefined;
    const savedViewState = savedWebviewState.memoryMapViewState;
    const validViewState = savedViewState && savedViewState.version === 1
        && savedViewState.fromRenderId === savedWebviewState.memoryMapRenderId;
    const pendingViewState = validViewState && (
        sameRenderState || (refreshSucceededOnLoad && savedViewState.fromRenderId !== RENDER_ID)
    ) ? savedViewState : undefined;
    const restoredRefreshState = refreshStillPending
        ? { kind: 'busy' }
        : sameRenderState && savedWebviewState.refreshFailed === true
            ? {
            kind: 'failed',
            reason: savedWebviewState.refreshFailureReason,
            at: savedWebviewState.refreshFailedAt,
            compact: savedWebviewState.refreshFailureDismissed === true
            }
            : refreshSucceededOnLoad
                ? { kind: 'success', at: Date.now() }
                : undefined;
    persistWebviewState({
        refreshPending: refreshStillPending,
        refreshFailed: refreshStillPending || restoredRefreshState?.kind === 'failed',
        refreshFailureReason: refreshStillPending
            ? savedWebviewState.refreshFailureReason
            : restoredRefreshState?.kind === 'failed' ? restoredRefreshState.reason : undefined,
        refreshFailedAt: refreshStillPending
            ? savedWebviewState.refreshFailedAt
            : restoredRefreshState?.kind === 'failed' ? restoredRefreshState.at : undefined,
        refreshAttemptId: refreshStillPending ? activeRefreshAttemptId : undefined
    });
    // 저장 HTML 상한. 호스트와 **같은 값**을 쓴다 — 웹뷰가 먼저 걸러 내고,
    // 호스트 검사는 그대로 두어 최종 권위로 남는다.
    const SAVE_HTML_LIMIT = ${MEMORY_MAP_MAX_SAVE_HTML_CHARS};
    // {placeholder} 치환 — 언어별 어순 차이를 수용한다. JSON Editor / Hex
    // Viewer와 같은 구현.
    function fmt(template, values) {
        return String(template).replace(/\\{(\\w+)\\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }
    const VT_THRESH = 200, ROW_H = 24, BUFFER = 30, MAX_VP_H = 600;
    const rendered = new Set();
    const vtMap = new Map();
    const staticOrig = new WeakMap();   // original innerHTML of static-table rows we've highlighted, for restore
    const secTotal = ${sectionSummary.length};   // total rows in the All Sections table (for the "X / N" heading)
    let funcVis = false, curQ = '', searchAutoFunc = false, funcUserOverride = false, restoringView = false;
    // Ordered match list for ◀/▶ navigation. Entries are either { k:'el', el:<tr> }
    // (a live row) or { k:'vt', vi:regionIdx, r:rowIndex } (a row in a virtual
    // table that may not be in the DOM yet — resolved by scrolling the viewport).
    let matchList = [], curMatch = -1, currentMatchEl = null;
    // 지금 강조된 행을 **논리 좌표로도** 들고 있는다. 가상 스크롤 표는 스크롤할
    // 때마다 tbody 를 다시 그려 <tr> 참조와 클래스가 함께 사라지므로, 요소만
    // 기억해서는 조금 굴렸다 돌아온 사이에 강조가 지워진다 — 그 강조가 이동이
    // 일어났다는 유일한 표시일 때는 이동 자체를 못 본 것이 된다.
    let currentTarget = null;

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    /**
     * 정렬 가능한 표 머리글.
     *
     * 0.6.21은 정적 All Sections 표에만 tabindex / aria-sort를 붙였고, 여기서
     * 런타임에 조립되는 표들(region 상세, Object Summary)은 빠져 있었다. 실제로
     * 사용자가 오래 머무는 쪽이 이 표들인데 정렬이 마우스 전용이었고, 정렬
     * 방향도 ▲/▼ 글리프로만 표시돼 스크린리더에는 아무것도 전달되지 않았다.
     *
     * aria-sort의 초기값 none이 중요하다 — 속성이 아예 없으면 스크린리더가
     * 이 열을 정렬 가능한 것으로 안내하지 않는다.
     */
    function sortTh(sortKey, label, opts) {
        opts = opts || {};
        return '<th data-sort="' + sortKey + '"'
            + (opts.sortBy ? ' data-sort-by="' + opts.sortBy + '"' : '')
            + (opts.cls ? ' class="' + opts.cls + '"' : '')
            + ' scope="col" role="columnheader" tabindex="0" aria-sort="none">' + label + '</th>';
    }

    /** 정렬 불가 머리글 — tabindex를 주면 눌러도 아무 일이 없어 혼란만 준다. */
    function plainTh(label, cls) {
        return '<th' + (cls ? ' class="' + cls + '"' : '') + ' scope="col">' + label + '</th>';
    }

    // HTML-escape the text, wrapping every occurrence of the current search
    // query (curQ, already lowercased) in a mark element for visual highlight.
    // Operates on the raw string so the escaping stays correct regardless of
    // what the query contains. Returns esc(text) verbatim when no query is set.
    function hl(text) {
        text = (text == null) ? '' : String(text);
        if (!curQ) return esc(text);
        const lower = text.toLowerCase();
        if (lower.indexOf(curQ) === -1) return esc(text);
        let i = 0, pos, out = '';
        while ((pos = lower.indexOf(curQ, i)) !== -1) {
            out += esc(text.slice(i, pos)) + '<mark class="sm-hl">' + esc(text.slice(pos, pos + curQ.length)) + '</mark>';
            i = pos + curQ.length;
        }
        return out + esc(text.slice(i));
    }

    // Highlight occurrences of q in the live text nodes under the given node by
    // wrapping them in a mark.sm-hl element. Used for the server-rendered static
    // tables (overview, all-sections), where we can't simply re-run rowHtml.
    // Callers cache the row's original innerHTML beforehand so it can be restored.
    function markTextNodes(node, q) {
        const kids = node.childNodes;
        for (let i = kids.length - 1; i >= 0; i--) {
            const c = kids[i];
            if (c.nodeType === 3) {
                const txt = c.nodeValue, lower = txt.toLowerCase();
                if (lower.indexOf(q) === -1) { continue; }
                const frag = document.createDocumentFragment();
                let idx = 0, pos;
                while ((pos = lower.indexOf(q, idx)) !== -1) {
                    if (pos > idx) { frag.appendChild(document.createTextNode(txt.slice(idx, pos))); }
                    const m = document.createElement('mark');
                    m.className = 'sm-hl';
                    m.textContent = txt.slice(pos, pos + q.length);
                    frag.appendChild(m);
                    idx = pos + q.length;
                }
                if (idx < txt.length) { frag.appendChild(document.createTextNode(txt.slice(idx))); }
                node.replaceChild(frag, c);
            } else if (c.nodeType === 1 && c.nodeName !== 'MARK') {
                markTextNodes(c, q);
            }
        }
    }

    function rowHtml(e, hsi, hfi, hhx, hhs) {
        const rc = e.fr ? ' class="free-row"' : '';
        const sc = hsi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + hl(e.s) + '</td>' : '';
        const fc = hfi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + hl(e.f) + '</td>' : '';
        const hc = hhx && !IS_STANDALONE
            ? (e.hx
                ? '<td class="memory-map-host-only"><button class="hex-link' + (e.ha ? '' : ' unavailable') + '" data-action="open-hex" data-target-id="' + e.hx + '" title="' + esc(e.ha ? S.viewHexTitle : S.noFileBytesTitle) + '" aria-label="' + esc((e.ha ? S.viewHexFor : S.noFileBytesFor).replace('{name}', () => e.n)) + '">' + esc(e.ha ? S.viewHex : S.noFileBytes) + '</button></td>'
                : '<td class="memory-map-host-only"></td>')
            : '';
        const sourceCell = hhs && !IS_STANDALONE
            ? (e.sx
                ? '<td class="memory-map-host-only"><button class="source-link" data-action="open-source" data-target-id="' + e.sx + '" title="' + esc(S.viewSourceTitle) + '" aria-label="' + esc(S.viewSourceFor.replace('{name}', () => e.n)) + '">' + esc(S.viewSource) + '</button></td>'
                : '<td class="memory-map-host-only"></td>')
            : '';
        // 정렬값 원본. 이 표는 행 수에 따라 정렬 경로가 갈린다 — 가상 스크롤
        // (200행 초과)이면 rd.segments 를 직접 정렬하지만, 그 아래면
        // sortable-table 로 렌더돼 공용 정렬기가 셀 텍스트를 읽었다. 같은 표가
        // 크기에 따라 다르게 동작하던 셈이라, 속성으로 양쪽을 맞춘다.
        // 헤더 키(name/section/func/addr/end/size/bytes/type)와 이름을 맞춘다.
        const sv = ' data-sort-name="' + esc(e.n) + '"'
            + ' data-sort-section="' + esc(e.s) + '"'
            + ' data-sort-func="' + esc(e.f) + '"'
            + ' data-sort-addr="' + e.a + '"'
            + ' data-sort-end="' + (e.sz > 0 ? e.a + e.sz - 1 : e.a) + '"'
            + ' data-sort-size="' + e.sz + '"'
            + ' data-sort-bytes="' + e.sz + '"'
            + ' data-sort-type="' + esc(e.t) + '"';
        return '<tr' + rc + sv + '><td>' + hl(e.n) + '</td>' + sc + fc + '<td class="num">' + hl(e.ah) + '</td><td class="num">' + e.eh + '</td><td class="num">' + hl(e.ss) + '</td><td class="num">' + e.sz + '</td><td><span class="type-badge type-' + e.t.toLowerCase() + '">' + hl(e.t) + '</span></td>' + hc + sourceCell + '</tr>';
    }

    function matchSeg(e, q) {
        return (e.n + ' ' + e.s + ' ' + e.f + ' ' + e.ah + ' ' + e.ss + ' ' + e.t).toLowerCase().includes(q);
    }

    function renderDetail(idx) {
        if (rendered.has(idx)) return;
        rendered.add(idx);
        const rd = RD[idx];
        const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
        const detail = card.querySelector('.region-detail');
        let h = '';

        // Map bar
        if (rd.segments.length > 0) {
            h += '<div class="map-bar">' + rd.mapSegHtml + '</div>';
        }

        // Object summary
        if (rd.hmo) {
            const oRows = rd.objSummary.map(function(o) {
                const dRows = o.entries.map(function(e) {
                    return '<tr class="obj-detail-row"><td></td><td class="num">' + esc(e.s) + '</td><td class="num">' + e.ah + '</td><td class="num">' + e.eh + '</td><td class="num">' + e.ss + '</td><td class="num">' + e.sz + '</td><td><span class="type-badge type-' + e.t.toLowerCase() + '">' + e.t + '</span></td></tr>';
                }).join('');
                // 정렬값을 행 속성으로 싣는다. 이 표의 부모 행은 colspan=2
                // 때문에 <td>가 헤더보다 하나 적어서, 헤더 순번을
                // row.children[]에 그대로 쓰던 기존 정렬기가 엉뚱한 셀을
                // 읽었다 — Size/Bytes는 Percent 셀을, Percent는 mini-bar의
                // 빈 텍스트를 읽었다(그래서 Percent 정렬은 아무 일도 하지
                // 않았다). 속성으로 읽으면 셀 배치와 무관해진다.
                //
                // 그 colspan 은 이제 없다. 비어 있던 Section 칸에 섹션 개수를
                // 적으면서 Address 칸을 따로 두었고, 그 결과 부모 행의 칸 수가
                // 머리글과 같아졌다 — 스크린리더가 개수를 "Address" 로 읽던
                // 것도 함께 사라진다. 정렬은 계속 속성으로 읽는다.
                const cnt = fmt(o.entries.length === 1 ? S.objSectionsOne : S.objSectionsMany, { n: o.entries.length });
                return '<tr data-sort-name="' + esc(o.n) + '" data-sort-bytes="' + o.ts + '" data-sort-pct="' + o.pv + '">'
                    + '<td>' + esc(o.n) + '</td><td class="num obj-sec-count">' + esc(cnt) + '</td><td class="num"></td><td class="num"></td><td class="num">' + o.tss + '</td><td class="num">' + o.ts + '</td><td class="num">' + o.p + '%</td><td><div class="mini-bar"><div class="mini-bar-fill" style="width:' + o.bw + '%;background:var(--ok)"></div></div></td></tr>' + dRows;
            }).join('');
            // \uBC88\uB4E4 \uAC12\uB3C4 esc()\uB97C \uAC70\uCE5C\uB2E4. \uC9C0\uAE08 \uAC12\uC5D0\uB294 \uB530\uC634\uD45C\uAC00 \uC5C6\uC9C0\uB9CC, \uC18D\uC131\uC5D0
            // \uB123\uB294 \uBB38\uC790\uC5F4\uB9CC \uC774 \uC790\uB9AC\uC5D0\uC11C \uC608\uC678\uC600\uB358 \uAC83\uC740 \uC8FC\uBCC0 \uCF54\uB4DC\uC640 \uC5B4\uAE0B\uB09C\uB2E4 \u2014
            // \uBC88\uC5ED\uC774 \uD558\uB098 \uBC14\uB00C\uBA74 \uC18D\uC131\uC774 \uAE68\uC9C0\uB294 \uC885\uB958\uC758 \uC7A0\uBCF5 \uACB0\uD568\uC774\uB2E4.
            // \uC811\uAE30 \uD5E4\uB354\uC640 \uC139\uC158 \uD589 \uBC84\uD2BC\uC744 \uD615\uC81C\uB85C \uB454\uB2E4. 0.6.53\uAE4C\uC9C0\uB294 \uBC84\uD2BC\uC774
            // role=button \uD5E4\uB354 **\uC548\uC5D0** \uC788\uC5B4\uC11C (1) \uBC84\uD2BC \uC548\uC758 \uBC84\uD2BC\uC774\uB77C\uB294 \uC798\uBABB\uB41C
            // ARIA \uAD6C\uC870\uC600\uACE0, (2) \uAC19\uC740 \uC904\uC778\uB370 \uB20C\uB9AC\uB294 \uC9C0\uC810\uB9C8\uB2E4 \uB2E4\uB978 \uC77C\uC774 \uC77C\uC5B4\uB098
            // \uC5B4\uB514\uB97C \uB20C\uB7EC\uC57C \uD558\uB294\uC9C0 \uC54C \uC218 \uC5C6\uC5C8\uB2E4.
            const bodyId = 'objBody' + idx;
            // \uC81C\uBAA9(h4)\uC774 \uC811\uAE30 \uBC84\uD2BC\uC744 \uAC10\uC2F8\uB294 \uD615\uD0DC \u2014 \uC81C\uBAA9\uC73C\uB85C \uD6D1\uC5B4 3\uB2E8 \uAD6C\uC870
            // (\uC601\uC5ED \uC0C1\uC138 \u2192 \uC601\uC5ED \u2192 \uC624\uBE0C\uC81D\uD2B8 \uC694\uC57D)\uB97C \uC774\uB3D9\uD560 \uC218 \uC788\uAC8C \uD55C\uB2E4. \uC811\uAE30
            // \uCEE8\uD2B8\uB864 \uC790\uCCB4\uB97C \uC81C\uBAA9\uC73C\uB85C \uB9CC\uB4E4\uBA74(role=button \uC774 \uC81C\uBAA9 \uC5ED\uD560\uC744 \uB36E\uC5B4\uC4F4\uB2E4)
            // \uB458 \uC911 \uD558\uB098\uB97C \uC783\uB294\uB2E4. h4 \uC758 \uB0B4\uC6A9 \uBAA8\uB378\uC774 phrasing \uC774\uB77C span \uC744 \uC4F4\uB2E4.
            h += '<div class="obj-summary-bar">'
                // \uC774\uB984\uC5D0 \uC601\uC5ED\uC744 \uBD99\uC778\uB2E4 \u2014 \uCE74\uB4DC\uB97C \uC5EC\uB7FF \uD3BC\uCE58\uBA74 \uC81C\uBAA9 \uBAA9\uB85D\uC774 \uAC1C\uC218\uB9CC
                // \uB2E4\uB978 "\uC624\uBE0C\uC81D\uD2B8 \uC694\uC57D (12)"\uC73C\uB85C \uB298\uC5B4\uC11C \uC5B4\uB290 \uC601\uC5ED \uAC83\uC778\uC9C0 \uC54C \uC218
                // \uC5C6\uB2E4. \uD654\uBA74 \uBB38\uAD6C\uB97C \uADF8\uB300\uB85C \uD3EC\uD568\uD558\uBBC0\uB85C label-in-name \uC744 \uC9C0\uD0A8\uB2E4.
                + '<h4 class="obj-summary-heading"><span class="obj-summary-header" data-action="toggle-obj-summary" role="button" tabindex="0" aria-expanded="false" aria-controls="' + bodyId + '" aria-label="' + esc(S.objectSummary + ' (' + rd.objSummary.length + ') \u2014 ' + rd.name) + '"><span class="fold-icon" aria-hidden="true">\u25B6</span> ' + esc(S.objectSummary) + ' (' + rd.objSummary.length + ')</span></h4>'
                // \uC0C1\uD0DC\uB294 aria-pressed \uB85C \uB0B8\uB2E4. \uC774 \uBC84\uD2BC\uC774 \uC5EC\uB2EB\uB294 \uAC83\uC740 \uC694\uC57D \uBCF8\uBB38\uC774
                // \uC544\uB2C8\uB77C \uADF8 \uC548\uC758 \uD589\uC774\uBBC0\uB85C, \uD5E4\uB354\uC640 \uB098\uB780\uD788 aria-expanded \uB97C \uB2EC\uBA74
                // \uAC19\uC740 \uBCF8\uBB38\uC744 \uB450\uACE0 "\uD3BC\uCE68"(\uBC84\uD2BC)\uACFC "\uC811\uD798"(\uD5E4\uB354)\uC774 \uB3D9\uC2DC\uC5D0 \uC77D\uD788\uB294
                // \uC0C1\uD0DC\uAC00 \uC0DD\uAE34\uB2E4. aria-controls \uB294 \uAD00\uACC4 \uD45C\uC2DC\uB85C\uB9CC \uB0A8\uAE34\uB2E4.
                //
                // aria-label \uC5D0 \uC601\uC5ED \uC774\uB984\uC744 \uBD99\uC778\uB2E4 \u2014 \uCE74\uB4DC\uB97C \uC5EC\uB7FF \uD3BC\uCE58\uBA74 \uBC84\uD2BC
                // \uBAA9\uB85D\uC774 "\uC139\uC158 \uD589 \uD45C\uC2DC \uC804\uD658"\uC73C\uB85C\uB9CC \uB298\uC5B4\uC11C \uC5B4\uB290 \uC601\uC5ED \uAC83\uC778\uC9C0
                // \uAD6C\uBD84\uD560 \uC218 \uC5C6\uB2E4.
                + '<button data-action="toggle-obj-detail-rows" aria-controls="' + bodyId + '" aria-pressed="false" title="' + esc(S.toggleObjectDetails) + '" aria-label="' + esc(S.toggleObjectDetails + ' \u2014 ' + rd.name) + '">' + esc(S.objDetailRows) + ' \u25B6</button>'
                + '</div>';
            h += '<div class="obj-summary-body" id="' + bodyId + '" style="display:none"><table class="obj-summary-table sortable-table"><thead><tr>'
                + sortTh('name', S.colObject)
                + plainTh(S.colSection, 'num')
                + plainTh(S.colAddress, 'num')
                + plainTh(S.colEnd, 'num')
                + sortTh('size', S.colSize, { cls: 'num', sortBy: 'bytes' })
                + sortTh('bytes', S.colBytes, { cls: 'num' })
                + sortTh('pct', S.colPercent, { cls: 'num' })
                + '<th aria-hidden="true"></th></tr></thead><tbody>' + oRows + '</tbody></table></div>';
        }

        // Section table
        if (rd.segments.length > 0) {
            const funcCls = 'func-cell' + (funcVis ? '' : ' hidden');
            const thHtml = '<tr>' + sortTh('name', S.colObject) +
                (rd.hsi ? sortTh('section', S.colSection, { cls: funcCls }) : '') +
                (rd.hfi ? sortTh('func', S.colFunction, { cls: funcCls }) : '')
                + sortTh('addr', S.colAddress, { cls: 'num' })
                + sortTh('end', S.colEnd, { cls: 'num' })
                + sortTh('size', S.colSize, { cls: 'num', sortBy: 'bytes' })
                + sortTh('bytes', S.colBytes, { cls: 'num' })
                + sortTh('type', S.colType)
                + (rd.hhx && !IS_STANDALONE ? plainTh(S.colHex, 'memory-map-host-only') : '')
                + (rd.hhs && !IS_STANDALONE ? plainTh(S.colSource, 'memory-map-host-only') : '') + '</tr>';

            if (rd.segments.length > VT_THRESH) {
                const vpH = Math.min(rd.segments.length * ROW_H, MAX_VP_H);
                h += '<div class="vt-viewport" data-ridx="' + idx + '" style="max-height:' + vpH + 'px;overflow-y:auto"><table class="section-table"><thead>' + thHtml + '</thead><tbody></tbody></table></div>';
            } else {
                const data = curQ ? rd.segments.filter(function(e) { return matchSeg(e, curQ); }) : rd.segments;
                h += '<table class="section-table sortable-table"><thead>' + thHtml + '</thead><tbody>' + data.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi, rd.hhx, rd.hhs); }).join('') + '</tbody></table>';
            }
        }

        // 펼쳤는데 아무것도 없는 영역(크기 0으로 잡힌 영역 등)은 글리프만
        // 뒤집히고 화면이 그대로여서, 이 릴리스가 고친 무반응과 똑같이 읽힌다.
        if (h === '') { h = '<div class="empty-region">' + esc(S.emptyRegion) + '</div>'; }

        detail.innerHTML = h;

        // Initialize virtual table if needed
        if (rd.segments.length > VT_THRESH) {
            initVT(detail.querySelector('.vt-viewport'), idx);
        }

        // Initialize DOM-based sort on obj-summary sortable-tables
        initSort(detail);

        // 검색 도중 자동으로 펼쳐진 영역은 여기서 처음 그려진다 — 그 순간부터
        // 현재 검색어를 반영해야 한다.
        if (curQ) { syncObjSummary(card); }
    }

    function initVT(vp, idx) {
        const rd = RD[idx];
        const vt = {
            vp: vp, tb: vp.querySelector('tbody'),
            data: rd.segments,
            fd: curQ ? rd.segments.filter(function(e) { return matchSeg(e, curQ); }) : rd.segments,
            cc: 6 + (rd.hsi ? 1 : 0) + (rd.hfi ? 1 : 0)
                + (!IS_STANDALONE && rd.hhx ? 1 : 0) + (!IS_STANDALONE && rd.hhs ? 1 : 0),
            idx: idx, ls: -1, le: -1
        };
        vtMap.set(idx, vt);
        vp.addEventListener('scroll', function() { requestAnimationFrame(function() { renderVT(vt); }); });
        renderVT(vt);
    }

    function renderVT(vt) {
        const st = vt.vp.scrollTop, vh = vt.vp.clientHeight, total = vt.fd.length;
        const s = Math.max(0, Math.floor(st / ROW_H) - BUFFER);
        const e = Math.min(total, Math.ceil((st + vh) / ROW_H) + BUFFER);
        if (s === vt.ls && e === vt.le) return;
        vt.ls = s; vt.le = e;
        const rd = RD[vt.idx];
        const topH = s * ROW_H, botH = Math.max(0, (total - e) * ROW_H);
        let h = '';
        if (topH > 0) h += '<tr class="vt-sp"><td colspan="' + vt.cc + '" style="height:' + topH + 'px;padding:0;border:0"></td></tr>';
        for (let i = s; i < e; i++) h += rowHtml(vt.fd[i], rd.hsi, rd.hfi, rd.hhx, rd.hhs);
        if (botH > 0) h += '<tr class="vt-sp"><td colspan="' + vt.cc + '" style="height:' + botH + 'px;padding:0;border:0"></td></tr>';
        vt.tb.innerHTML = h;
        // 방금 innerHTML 로 날아간 강조를 되돌린다. currentTarget 이 논리 좌표라
        // 다시 그려진 행에도 그대로 붙는다.
        if (currentTarget && currentTarget.k === 'vt' && currentTarget.vi === vt.idx
            && currentTarget.r >= s && currentTarget.r < e) {
            const rows = vt.tb.querySelectorAll('tr:not(.vt-sp)');
            const row = rows[currentTarget.r - s];
            if (row) { row.classList.add('current-match'); currentMatchEl = row; }
        }
    }

    // --- Copy / Save ---
    // 본문은 extension host가 이미 보유한다. 웹뷰는 선택한 종류만 보내므로
    // Copy Full Dump도 거대한 report 문자열을 IPC로 다시 복제하지 않는다.
    document.getElementById('btnCopy')?.addEventListener('click', function() {
        vscode.postMessage({ command: 'copyReport', kind: 'summary', renderId: RENDER_ID });
    });
    document.getElementById('btnCopyFull')?.addEventListener('click', function() {
        vscode.postMessage({ command: 'copyReport', kind: 'full', renderId: RENDER_ID });
    });
    document.getElementById('btnSaveHtml')?.addEventListener('click', function() {
        // **직렬화 전에** 크기를 잰다. documentElement.outerHTML 은
        // 그 자체로 수백 MB 짜리 문자열을 한 번에 만들고, 그것이 구조화 복제로
        // 호스트에 한 벌 더 복사된 **뒤에야** 호스트의 상한 검사에 닿는다 —
        // 가장 위험한 두 순간을 지나고 나서 막는 셈이었다.
        //
        // DOM 을 순회하며 직렬화될 태그·속성·텍스트의 **상한**만 센다. 개별
        // outerHTML 도 만들지 않으므로 큰 중간 문자열이 없다. 특히 inline
        // script 의 RD 안에는 접혀 있거나 가상화로 아직 렌더되지 않은 행과
        // mapSegHtml 까지 모두 들어 있으므로, head + 현재 <tr> 만 세던 검사는
        // 이 데이터를 통째로 놓쳤다.
        function serializedHtmlExceedsLimit(root, limit) {
            var total = 0;
            var stack = [root];

            function add(chars) {
                total += chars;
                return total > limit;
            }

            // HTML serializer 가 text/attribute 의 특수문자를 entity 로 늘릴
            // 수 있는 만큼 더한다. 원문 길이를 먼저 더해 즉시 상한을 넘기면
            // 거대한 문자열을 끝까지 훑지 않는다. script/style 은 raw text라
            // entity 확장이 없고, 이 화면에서 가장 큰 RD payload도 이 경로다.
            function addEscapedString(value, attribute) {
                var text = value == null ? '' : String(value);
                if (add(text.length)) { return true; }
                for (var i = 0; i < text.length; i++) {
                    var ch = text.charCodeAt(i);
                    if (ch === 38) { // & -> &amp; (1 -> 5)
                        if (add(4)) { return true; }
                    } else if (ch === 160) { // NBSP -> &nbsp; (1 -> 6)
                        if (add(5)) { return true; }
                    } else if (ch === 60 || ch === 62) { // < or > -> &lt; / &gt;
                        if (add(3)) { return true; }
                    } else if (attribute && ch === 34) { // " -> &quot; (1 -> 6)
                        if (add(5)) { return true; }
                    }
                }
                return false;
            }

            function addCharacterData(node, attribute, rawText) {
                // CharacterData.length는 nodeValue 전체를 JS 문자열로 만들지
                // 않는다. 먼저 원문 길이만 더하면 대형 inline script/RD는
                // nodeValue에 접근하지 않고 즉시 거부할 수 있다.
                var length;
                if (typeof node.length === 'number') {
                    length = node.length;
                } else {
                    // 구형/가짜 DOM 폴백. 실제 Webview의 CharacterData에는 항상
                    // length와 substringData가 있다.
                    var fallback = node.nodeValue == null ? '' : String(node.nodeValue);
                    length = fallback.length;
                }
                if (add(length) || rawText) { return total > limit; }

                // 일반 text는 entity 확장분만 센다. substringData로 64KiB씩
                // 읽어 전체 text node를 한 번에 materialize하지 않는다.
                var chunkSize = 64 * 1024;
                for (var offset = 0; offset < length; offset += chunkSize) {
                    var count = Math.min(chunkSize, length - offset);
                    var chunk;
                    if (typeof node.substringData === 'function') {
                        chunk = node.substringData(offset, count);
                    } else {
                        var value = node.nodeValue == null ? '' : String(node.nodeValue);
                        chunk = value.slice(offset, offset + count);
                    }
                    for (var i = 0; i < chunk.length; i++) {
                        var ch = chunk.charCodeAt(i);
                        if (ch === 38) { // & -> &amp; (1 -> 5)
                            if (add(4)) { return true; }
                        } else if (ch === 160) { // NBSP -> &nbsp; (1 -> 6)
                            if (add(5)) { return true; }
                        } else if (ch === 60 || ch === 62) { // < or > -> &lt; / &gt;
                            if (add(3)) { return true; }
                        } else if (attribute && ch === 34) { // " -> &quot; (1 -> 6)
                            if (add(5)) { return true; }
                        }
                    }
                }
                return false;
            }

            while (stack.length > 0) {
                var node = stack.pop();
                if (!node) { continue; }

                if (node.nodeType === 1) { // Element
                    // tagName 은 namespace prefix까지 포함하므로 localName보다
                    // 직렬화될 이름에 가깝고, HTML 태그는 대소문자만 달라 길이는 같다.
                    var tag = String(node.tagName || node.localName || '').toLowerCase();
                    // <tag> + </tag>. Void element 에도 닫는 태그 길이를 더해
                    // 실제 outerHTML 보다 작아지지 않게 보수적으로 계산한다.
                    if (add(tag.length * 2 + 5)) { return true; }

                    var attrs = node.attributes || [];
                    for (var ai = 0; ai < attrs.length; ai++) {
                        var attr = attrs[ai] || (attrs.item && attrs.item(ai));
                        if (!attr) { continue; }
                        var name = String(attr.name || '');
                        // space + name + = + two quotes
                        if (add(name.length + 4) || addEscapedString(attr.value, true)) {
                            return true;
                        }
                    }

                    var children = node.childNodes || [];
                    // 마지막 자식부터 확인한다. 이 문서는 큰 inline script 가
                    // body 뒤쪽에 있어 병리적 payload를 빠르게 거부할 수 있다.
                    for (var ci = 0; ci < children.length; ci++) {
                        stack.push(children[ci] || (children.item && children.item(ci)));
                    }
                } else if (node.nodeType === 3) { // Text
                    var parent = node.parentElement || node.parentNode;
                    var parentTag = parent
                        ? String(parent.tagName || parent.localName || '').toLowerCase()
                        : '';
                    if (addCharacterData(node, false, parentTag === 'script' || parentTag === 'style')) {
                        return true;
                    }
                } else if (node.nodeType === 8) { // Comment: <!--value-->
                    if (add(7) || addCharacterData(node, false, true)) { return true; }
                } else if (
                    add(String(node.nodeName || '').length + 8)
                    || addEscapedString(node.nodeValue, true)
                ) {
                    // ProcessingInstruction 등 이 문서에 통상 없을 노드는 entity
                    // 확장과 구분자 여유까지 잡아 실제 직렬화보다 작게 추정하지 않는다.
                    return true;
                }
            }
            return false;
        }

        if (serializedHtmlExceedsLimit(document.documentElement, SAVE_HTML_LIMIT)) {
            vscode.postMessage({ command: 'saveHtmlTooLarge', renderId: RENDER_ID });
            return;
        }
        vscode.postMessage({ command: 'saveHtml', html: document.documentElement.outerHTML, renderId: RENDER_ID });
    });

    // --- Region fold/unfold with lazy rendering ---
    /**
     * region \uCE74\uB4DC\uC758 \uD3BC\uCE68 \uC0C1\uD0DC\uB97C \uBC14\uAFB8\uB294 \uC720\uC77C\uD55C \uACBD\uB85C.
     *
     * \uD654\uBA74(display), \uAE00\uB9AC\uD504(\u25B6/\u25BC), \uC811\uADFC\uC131 \uC0C1\uD0DC(aria-expanded), \uC9C0\uC5F0 \uB80C\uB354,
     * Expand All \uB77C\uBCA8\uC774 \uC804\uBD80 \uC5EC\uAE30\uC11C \uD568\uAED8 \uC6C0\uC9C1\uC778\uB2E4. 0.6.31\uC740 aria-expanded\uB97C
     * \uC9C1\uC811 \uD074\uB9AD \uACBD\uB85C(toggleRegion)\uC5D0\uB9CC \uB123\uC5B4\uC11C, Expand All \u00B7 \uAC80\uC0C9 \uC790\uB3D9 \uD655\uC7A5 \u00B7
     * Overview/\uBA85\uB839 \uC774\uB3D9\uC73C\uB85C \uD3BC\uCE5C \uCE74\uB4DC\uB97C \uC2A4\uD06C\uB9B0\uB9AC\uB354\uAC00 \uACC4\uC18D "\uC811\uD798"\uC73C\uB85C
     * \uC77D\uC5C8\uB2E4 \u2014 \uC0C1\uD0DC\uB97C \uBC14\uAFB8\uB294 \uACBD\uB85C\uAC00 \uB2E4\uC12F \uACF3\uC778\uB370 \uD55C \uACF3\uB9CC \uACE0\uCE5C \uACB0\uACFC\uB2E4.
     * \uC0C8 \uD3BC\uCE68 \uACBD\uB85C\uB97C \uCD94\uAC00\uD55C\uB2E4\uBA74 \uBC18\uB4DC\uC2DC \uC774 \uD568\uC218\uB97C \uAC70\uCE60 \uAC83.
     */
    function setRegionExpanded(card, expanded) {
        const detail = card.querySelector('.region-detail');
        if (!detail) { return; }
        detail.style.display = expanded ? '' : 'none';
        // \uD55C \uCE74\uB4DC \uC548\uC5D0 fold-icon \uC774 \uB458\uC774\uB2E4 \u2014 region \uD5E4\uB354\uC640, \uD3BC\uCCD0\uC9C4 \uC0C1\uC138 \uC548\uC758
        // Object Summary \uD5E4\uB354. \uBB38\uC11C \uC21C\uC11C\uC0C1 \uC55E\uC5D0 \uC788\uB294 \uAC83\uC744 \uC9D1\uC5B4 \uC6B0\uC5F0\uD788
        // \uB9DE\uACE0 \uC788\uC5C8\uB294\uB370, \uB458\uC744 \uAD6C\uBD84\uD558\uC9C0 \uC54A\uC73C\uBA74 \uB9C8\uD06C\uC5C5 \uC21C\uC11C\uAC00 \uBC14\uB014 \uB54C
        // region \uD1A0\uAE00\uC774 \uC5C9\uB6B1\uD55C \uAE00\uB9AC\uD504\uB97C \uB4A4\uC9D1\uB294\uB2E4.
        const icon = card.querySelector('.region-header .fold-icon');
        if (icon) { icon.textContent = expanded ? '\u25BC' : '\u25B6'; }
        // \u25B6/\u25BC \uAE00\uB9AC\uD504\uB294 \uC2A4\uD06C\uB9B0\uB9AC\uB354\uC5D0 \uC544\uBB34 \uC758\uBBF8\uB3C4 \uC804\uB2EC\uD558\uC9C0 \uC54A\uB294\uB2E4(aria-hidden).
        // \uD3BC\uCE68 \uC5EC\uBD80\uB294 aria-expanded\uB85C\uB9CC \uC54C \uC218 \uC788\uB2E4.
        const header = card.querySelector('.region-header');
        if (header) { header.setAttribute('aria-expanded', expanded ? 'true' : 'false'); }
        if (expanded) { renderDetail(parseInt(card.dataset.idx)); }   // rendered \uCE90\uC2DC\uB85C \uBA71\uB4F1
        if (window.syncToggleAllLabel) { window.syncToggleAllLabel(); }
    }

    window.toggleRegion = function(header) {
        const card = header.closest('.region-card');
        const detail = card.querySelector('.region-detail');
        setRegionExpanded(card, detail.style.display === 'none');
    };

    // --- Toggle-All: 라벨과 클릭 동작은 "전부 펼쳐졌을 때만 접기", 글리프는
    // 지금 상태를 가리킨다.
    /**
     * 영역들의 펼침 상태. any 는 글리프(= 지금 상태), all 은 라벨과 클릭
     * 동작(= 다음 동작)을 정한다. 두 곳에서 따로 세면 어긋나므로 한 곳에서 낸다.
     */
    function regionFoldState() {
        let any = false, all = true;
        const details = document.querySelectorAll('.region-card .region-detail');
        details.forEach(function(detail) {
            if (detail.style.display !== 'none') { any = true; } else { all = false; }
        });
        return { any: any, all: all && details.length > 0 };
    }

    window.syncToggleAllLabel = function() {
        const btn = document.getElementById('toggleAllBtn');
        if (!btn) return;
        const state = regionFoldState();
        // \uAE00\uB9AC\uD504\uB294 **\uC9C0\uAE08 \uC0C1\uD0DC**\uB97C \uAC00\uB9AC\uD0A8\uB2E4(\u25BC \uD558\uB098\uB77C\uB3C4 \uD3BC\uCCD0\uC9D0 / \u25B6 \uC804\uBD80 \uC811\uD798).
        // \uB77C\uBCA8\uC740 \uB2E4\uC74C \uB3D9\uC791\uC774\uB2E4. 0.6.54\uAE4C\uC9C0\uB294 \uAE00\uB9AC\uD504\uB3C4 \uB2E4\uC74C \uB3D9\uC791\uC744 \uAC00\uB9AC\uCF1C,
        // \uAC19\uC740 \uD654\uBA74\uC758 \uB2E4\uB978 \uAE00\uB9AC\uD504(\uC601\uC5ED \uD5E4\uB354 \u00B7 Object Summary \u00B7 Function \uC5F4)\uC640
        // \uC815\uD655\uD788 \uBC18\uB300\uC600\uACE0 \uC790\uAE30 \uC790\uC2E0\uC758 aria-expanded \uC640\uB3C4 \uC5B4\uAE0B\uB0AC\uB2E4 \u2014 \uC804\uBD80
        // \uC811\uD78C \uD654\uBA74\uC5D0\uC11C \uD5E4\uB354\uB294 \u25B6 \uC778\uB370 \uC774 \uBC84\uD2BC\uB9CC \u25BC \uC600\uB2E4.
        // \uAE00\uB9AC\uD504\uB294 textContent \uB85C \uB123\uC73C\uBBC0\uB85C \uC811\uADFC \uAC00\uB2A5\uD55C \uC774\uB984\uC5D0 \uADF8\uB300\uB85C \uC11E\uC778\uB2E4
        // ("\uAC80\uC740 \uC624\uB978\uCABD \uC0BC\uAC01\uD615 \uC601\uC5ED \uBAA8\uB450 \uD3BC\uCE58\uAE30"). \uC774\uB984\uC740 aria-label \uB85C \uB530\uB85C
        // \uC900\uB2E4 \u2014 \uD654\uBA74 \uBB38\uAD6C\uB97C \uD3EC\uD568\uD558\uBBC0\uB85C label-in-name \uB3C4 \uC9C0\uD0A8\uB2E4.
        // \uB77C\uBCA8\uC740 "\uC804\uBD80 \uD3BC\uCCD0\uC84C\uC744 \uB54C\uB9CC \uC811\uAE30"\uB2E4. \uD558\uB098\uB77C\uB3C4 \uC811\uD600 \uC788\uC73C\uBA74 \uB2E4\uC74C \uB3D9\uC791\uC740
        // \uB098\uBA38\uC9C0\uB97C \uB9C8\uC800 \uD3BC\uCE58\uB294 \uAC83 \u2014 \uC608\uC804\uC5D0\uB294 \uD558\uB098\uB9CC \uD3BC\uCCD0\uB3C4 \uB77C\uBCA8\uC774 "\uBAA8\uB450 \uC811\uAE30"\uB85C
        // \uBC14\uB00C\uC5B4, \uB098\uBA38\uC9C0\uB97C \uD3BC\uCE58\uB824\uBA74 \uC811\uC5C8\uB2E4\uAC00 \uB2E4\uC2DC \uD3BC\uCCD0\uC57C \uD588\uB2E4(\uB450 \uBC88 \uD074\uB9AD).
        const label = state.all ? S.collapseAll : S.expandAll;
        btn.textContent = (state.any ? '\u25BC ' : '\u25B6 ') + label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', S.expandAllHint);
        btn.setAttribute('aria-expanded', state.any ? 'true' : 'false');
    };

    window.toggleAll = function() {
        window.foldAll(regionFoldState().all);
        window.syncToggleAllLabel();
    };

    // --- Keyword search (data-driven for regions, DOM for static tables) ---
    const searchInput = document.getElementById('searchInput');
    const searchCount = document.getElementById('searchCount');
    const searchPrev = document.getElementById('searchPrev');
    const searchNext = document.getElementById('searchNext');
    const allSecCount = document.getElementById('allSecCount');
    const regMatchInfo = document.getElementById('regMatchInfo');
    let searchTimeout;
    // Incremental filter cache: when the new query extends the previous one,
    // we only have to filter the previous result set, not the full dataset.
    // lastSearch.fd[idx] holds the last filtered segments array per region index.
    let lastSearch = { q: '', fd: null };

    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(doSearch, 200);
    });
    searchPrev.addEventListener('click', function() { goToMatch(-1); });
    searchNext.addEventListener('click', function() { goToMatch(1); });

    // Ctrl/Cmd+F → focus + select search input. Esc inside the input clears
    // the query (and resets the search) on first press, blurs on second.
    // Enter / Shift+Enter step through matches.
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && typeof e.key === 'string' && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
            return;
        }
        if (e.key === 'Enter' && document.activeElement === searchInput) {
            e.preventDefault();
            goToMatch(e.shiftKey ? -1 : 1);
            return;
        }
        if (e.key === 'Escape' && document.activeElement === searchInput) {
            if (searchInput.value !== '') {
                e.preventDefault();
                searchInput.value = '';
                clearTimeout(searchTimeout);
                doSearch();
            } else {
                searchInput.blur();
            }
        }
    });

    // --- Match navigation (◀ ▶ / Enter / Shift+Enter) ---
    function updateNavUI() {
        const has = matchList.length > 0;
        searchPrev.disabled = !has;
        searchNext.disabled = !has;
        if (!curQ) {
            searchCount.textContent = '';
            searchCount.classList.remove('no-match');
        } else if (!has) {
            searchCount.textContent = S.noMatches;
            searchCount.classList.add('no-match');
        } else {
            searchCount.classList.remove('no-match');
            searchCount.textContent = (curMatch + 1) + ' / ' + matchList.length;
        }
    }

    function matchInView(el) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        return r.top >= 64 && r.bottom <= vh;
    }

    // Make sure region #idx is expanded (a matchList row may live inside a
    // .region-detail the user collapsed after the search; navigating to it must
    // re-open the region or the row would be hidden). No-op when already open.
    function ensureRegionExpanded(idx) {
        const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
        if (!card) { return; }
        const detail = card.querySelector('.region-detail');
        if (detail && detail.style.display === 'none') { setRegionExpanded(card, true); }
    }

    function revealMatch(i, force) {
        revealTarget(matchList[i], force);
    }

    // Reveal one target row: clear the previous current-match, expand its region
    // if collapsed, resolve the row (scrolling a virtual table's viewport if the
    // row isn't rendered yet), mark it current, and scroll the page to it.
    // force = always center; otherwise only scroll when the row isn't already
    // comfortably on screen.
    //
    // The target is either { k:'el', el } or { k:'vt', vi, r } — the same shape
    // matchList holds, so search navigation and the Go to Symbol command land on
    // a row through this one path.
    function revealTarget(m, force, focusRow) {
        if (currentMatchEl) { currentMatchEl.classList.remove('current-match'); currentMatchEl = null; }
        // matchList 항목을 그대로 들고 있지 않고 복사한다 — 아래에서 seg 를 달고,
        // 정렬 뒤에는 r 을 고쳐 쓰는데, 그것이 matchList 를 건드리면 안 된다.
        currentTarget = m ? { k: m.k, vi: m.vi, r: m.r, el: m.el } : null;
        if (!m) { updateNavUI(); return; }
        let el;
        if (m.k === 'el') {
            el = m.el;
            const rc = el && el.closest && el.closest('.region-card');
            if (!restoringView && rc && rc.dataset && rc.dataset.idx) { ensureRegionExpanded(parseInt(rc.dataset.idx)); }
        } else {
            if (!restoringView) { ensureRegionExpanded(m.vi); }   // expand first so the viewport has a real clientHeight
            const vt = vtMap.get(m.vi);
            if (!vt) { updateNavUI(); return; }
            // 행 **객체**도 함께 기억한다. 정렬은 이 배열을 제자리에서 재배열하므로
            // 번호만으로는 같은 심볼을 다시 찾을 수 없다.
            currentTarget.seg = vt.fd[m.r];
            if (!restoringView) {
                const maxTop = Math.max(0, vt.fd.length * ROW_H - vt.vp.clientHeight);
                vt.vp.scrollTop = Math.min(maxTop, Math.max(0, (m.r + 0.5) * ROW_H - vt.vp.clientHeight / 2));
            }
            vt.ls = -1;
            renderVT(vt);
            el = vt.tb.querySelectorAll('tr:not(.vt-sp)')[m.r - vt.ls];
        }
        if (!el) { updateNavUI(); return; }
        el.classList.add('current-match');
        currentMatchEl = el;
        if (focusRow && !restoringView) {
            // 스크롤은 아래에서 우리가 부드럽게 한다 — focus() 가 먼저 뛰게 두면
            // 화면이 두 번 튄다.
            el.setAttribute('tabindex', '-1');
            el.focus({ preventScroll: true });
        }
        if (restoringView) {
            updateNavUI();
        } else if (m.k === 'el') {
            if (force || !matchInView(el)) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        } else {
            // el lives inside a nested-scroll viewport we already positioned; scroll only the page.
            const r = el.getBoundingClientRect();
            const vh = window.innerHeight || document.documentElement.clientHeight;
            if (force || r.top < 64 || r.bottom > vh) {
                window.scrollTo({ top: Math.max(0, window.scrollY + r.top + r.height / 2 - vh / 2), behavior: 'smooth' });
            }
        }
        updateNavUI();
    }

    function goToMatch(delta) {
        if (matchList.length === 0) { return; }
        curMatch = (curMatch + delta + matchList.length) % matchList.length;
        revealMatch(curMatch, true);
    }

    // Rebuild matchList from the current (post-render) DOM + virtual-table state.
    // Document order: overview rows → region cards (in order) → All Sections rows.
    // Virtual-table regions contribute logical { vt } entries (one per filtered
    // row) since most of those rows aren't in the DOM at any given moment.
    function rebuildMatchList(q) {
        matchList = [];
        if (!q) { return; }
        document.querySelectorAll('.overview-table tbody tr.search-match').forEach(function(tr) { matchList.push({ k: 'el', el: tr }); });
        RD.forEach(function(rd, idx) {
            const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
            if (!card || card.style.display === 'none') { return; }
            const vt = vtMap.get(idx);
            if (vt) {
                for (let i = 0; i < vt.fd.length; i++) { matchList.push({ k: 'vt', vi: idx, r: i }); }
            } else {
                const tbody = card.querySelector('.section-table tbody');
                if (tbody) { tbody.querySelectorAll('tr').forEach(function(tr) { matchList.push({ k: 'el', el: tr }); }); }
            }
        });
        document.querySelectorAll('#sectionTable tbody tr.search-match').forEach(function(tr) { matchList.push({ k: 'el', el: tr }); });
    }

    function clearCurrentTarget() {
        if (currentMatchEl) { currentMatchEl.classList.remove('current-match'); }
        currentMatchEl = null;
        currentTarget = null;
    }

    /**
     * 정렬로 영역 #idx 의 행이 재배열된 직후, 강조 대상을 다시 붙인다.
     *
     * 가상 표의 대상은 행 **번호**로 기억되는데 정렬은 rd.segments 를 제자리에서
     * 재배열하므로, 그대로 두면 같은 번호에 **다른 심볼**이 앉아 강조가 엉뚱한
     * 행으로 옮겨 간다. 기억해 둔 행 객체로 새 번호를 찾고, 못 찾으면(검색에
     * 걸러졌다면) 강조를 놓는다 — 틀린 곳을 가리키느니 없는 편이 낫다.
     *
     * 일반 표는 tbody 를 통째로 다시 그려 <tr> 참조가 끊어지므로 그냥 놓는다.
     *
     * **renderVT 보다 먼저** 불러야 한다. 그 뒤면 이미 옛 번호로 칠한 뒤다.
     */
    function resyncCurrentTargetAfterSort(idx) {
        if (!currentTarget) { return; }
        if (currentTarget.k === 'vt') {
            if (currentTarget.vi !== idx) { return; }
            const vt = vtMap.get(idx);
            const r = (vt && currentTarget.seg) ? vt.fd.indexOf(currentTarget.seg) : -1;
            if (r >= 0) { currentTarget.r = r; return; }
        } else {
            const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
            if (!card || !currentTarget.el || !card.contains(currentTarget.el)) { return; }
        }
        clearCurrentTarget();
    }

    // Re-sync match navigation after a column sort reordered (or, for virtual
    // tables, re-rendered) rows behind matchList's back: stale <tr> references
    // and wrong document order would make ◀/▶ jump to the wrong place. Mirrors
    // the tail of doSearch — rebuild, jump to the first match, refresh the count.
    function resyncAfterReflow() {
        if (!curQ) { return; }
        document.querySelectorAll('.current-match').forEach(function(el) { el.classList.remove('current-match'); });
        currentMatchEl = null;
        currentTarget = null;   // 행 번호는 필터/정렬이 바뀌면 다른 행을 가리킨다
        rebuildMatchList(curQ);
        curMatch = matchList.length > 0 ? 0 : -1;
        updateNavUI();
        if (curMatch === 0 && !restoringView) { revealMatch(0, false); }
        schedulePendingSnapshotRefresh();
    }

    function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        curQ = q;
        let mr = 0;   // regions containing a match

        // Drop any stale current-match emphasis; matchList is rebuilt below.
        document.querySelectorAll('.current-match').forEach(function(el) { el.classList.remove('current-match'); });
        currentMatchEl = null;
        currentTarget = null;   // 행 번호는 필터/정렬이 바뀌면 다른 행을 가리킨다

        // matchSeg() also searches the Section/Function columns, but those live
        // inside .func-cell which is hidden by default — so a function-only query
        // would highlight an invisible <mark> and the scroll target would be a
        // zero-size node. Reveal those columns while a search is active, unless
        // the user explicitly toggled them off during this search session
        // (funcUserOverride). When the query is cleared we undo our own
        // auto-reveal and forget the override so the next search starts fresh.
        if (q) {
            if (!funcVis && !funcUserOverride) {
                funcVis = true;
                searchAutoFunc = true;
                document.querySelectorAll('.func-cell').forEach(function(el) { el.classList.remove('hidden'); });
                syncFuncBtn();
            }
        } else {
            if (searchAutoFunc) {
                funcVis = false;
                searchAutoFunc = false;
                document.querySelectorAll('.func-cell').forEach(function(el) { el.classList.add('hidden'); });
                syncFuncBtn();
            }
            funcUserOverride = false;
        }

        const canExtend = q && lastSearch.q && q.length > lastSearch.q.length && q.indexOf(lastSearch.q) === 0 && lastSearch.fd;
        const nextFd = [];

        RD.forEach(function(rd, idx) {
            const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
            let rm = 0;

            const src = canExtend ? lastSearch.fd[idx] : rd.segments;
            const filtered = q ? src.filter(function(seg) { return matchSeg(seg, q); }) : rd.segments;
            nextFd[idx] = filtered;
            if (q) { rm = filtered.length; }

            // Hide region cards with no match while a search is active.
            if (card) { card.style.display = (q && rm === 0) ? 'none' : ''; }

            // Update virtual tables
            const vt = vtMap.get(idx);
            if (vt) {
                vt.fd = filtered;
                vt.vp.scrollTop = 0;
                vt.ls = -1;
                renderVT(vt);
            } else if (rendered.has(idx)) {
                // Non-virtual rendered table: re-render tbody from data (reuse filtered array above)
                const tbody = card.querySelector('.section-table tbody');
                if (tbody) {
                    tbody.innerHTML = filtered.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi, rd.hhx, rd.hhs); }).join('');
                }
            }

            // Auto-expand matching regions
            if (q && rm > 0) {
                mr++;
                const detail = card.querySelector('.region-detail');
                if (detail && detail.style.display === 'none') { setRegionExpanded(card, true); }
            }

            // 요약 표도 같은 검색어를 따른다. 이게 없으면 한 카드 안에서
            // 섹션 표는 걸러진 결과를, 요약 표는 전체 목록을 보여 준다.
            if (rendered.has(idx)) { syncObjSummary(card); }
        });

        // Static tables (overview, all-sections): hide non-matches, highlight matches.
        document.querySelectorAll('#sectionTable tbody tr, .overview-table tbody tr').forEach(function(row) {
            // Undo a previous highlight first (only rows we touched carry the class).
            if (row.classList.contains('search-match')) {
                row.classList.remove('search-match');
                const orig = staticOrig.get(row);
                if (orig !== undefined) row.innerHTML = orig;
            }
            if (!q) { row.style.display = ''; return; }
            const text = row.textContent.toLowerCase();
            if (text.indexOf(q) !== -1) {
                row.style.display = '';
                row.classList.add('search-match');
                if (!staticOrig.has(row)) staticOrig.set(row, row.innerHTML);
                markTextNodes(row, q);
            } else {
                row.style.display = 'none';
            }
        });

        lastSearch = { q: q, fd: nextFd };
        if (window.syncToggleAllLabel) window.syncToggleAllLabel();

        // Heading match counts.
        if (allSecCount) {
            allSecCount.textContent = q
                ? (document.querySelectorAll('#sectionTable tbody tr.search-match').length + ' / ' + secTotal)
                : String(secTotal);
        }
        if (regMatchInfo) {
            regMatchInfo.textContent = q
                ? fmt(mr === 1 ? S.regionsMatchedOne : S.regionsMatchedMany, { n: mr })
                : '';
        }

        // Rebuild the navigable match list and jump to the first match.
        rebuildMatchList(q);
        curMatch = matchList.length > 0 ? 0 : -1;
        updateNavUI();
        if (curMatch === 0 && !restoringView) { revealMatch(0, false); }
    }

    // --- Expand All / Collapse All ---
    window.foldAll = function(collapse) {
        document.querySelectorAll('.region-card').forEach(function(card) {
            setRegionExpanded(card, !collapse);
        });
    };

    // --- Overview row click -> scroll to region card ---
    document.querySelectorAll('.overview-row').forEach(function(row) {
        row.addEventListener('click', function() {
            scrollToRegionCard(document.getElementById('region-' + row.getAttribute('data-region')));
        });
    });

    // 영역 카드로 이동 — Overview 클릭 · scrollToRegion · 행을 못 찾았을 때의
    // 되돌아갈 자리. 한 함수로 모아 세 경로가 같은 모습으로 착지하게 한다.
    function scrollToRegionCard(card) {
        if (!card) { return false; }
        const detail = card.querySelector('.region-detail');
        if (detail && detail.style.display === 'none') { setRegionExpanded(card, true); }
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.style.outline = '2px solid var(--vscode-focusBorder, #007acc)';
        setTimeout(function() { card.style.outline = ''; }, 2500);
        return true;
    }

    // 이동 결과를 한 문장으로 알린다. 지금까지 성공의 유일한 신호가 행 배경색
    // 이었는데, 그것은 스크린리더에 아무것도 전하지 못하고 검색을 지웠다는
    // 사실은 아무 데도 남지 않았다. #regMatchInfo 는 이미 role="status" 다.
    function announceReveal(text) {
        if (regMatchInfo) { regMatchInfo.textContent = text; }
    }

    // --- Jump to one symbol/section row (from the Go to Symbol command) ---
    // The picked row can be unreachable in three ways at once: its region is
    // collapsed (and its table not even rendered yet), an active search filters
    // it out, and — in a virtual table — the <tr> does not exist until the
    // viewport scrolls there. All three are handled here; the last step hands a
    // resolved target to revealTarget, the same path search navigation uses.
    function revealEntry(regionIndex, regionName, name, addr) {
        // 영역은 순번으로 찾는다. 이름은 사용자 설정에서 오므로 겹칠 수 있고,
        // 겹치면 두 번째 영역의 행이 첫 번째 카드로 가서 조용히 실패한다.
        // 순번이 어긋난 메시지(패널 재생성 등)만 이름으로 되짚는다.
        let idx = (typeof regionIndex === 'number' && RD[regionIndex]) ? regionIndex : -1;
        if (idx < 0 || (regionName && RD[idx].name !== regionName)) {
            idx = -1;
            for (let i = 0; i < RD.length; i++) {
                if (RD[i].name === regionName) { idx = i; break; }
            }
        }
        if (idx < 0) { return; }

        const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
        const rd = RD[idx];
        let seg = null;
        for (let i = 0; i < rd.segments.length; i++) {
            if (rd.segments[i].a === addr && rd.segments[i].n === name) { seg = rd.segments[i]; break; }
        }
        // 행을 못 찾으면 최소한 그 영역까지는 데려간다. 이 릴리스가 고친 것이
        // "눌러도 아무 일이 없다"인데, 그 증상으로 되돌아가지 않게 한다.
        if (!seg) { scrollToRegionCard(card); return; }

        // 검색이 이 행을 걸러 내고 있으면 먼저 검색을 비운다. 그러지 않으면
        // 카드째 숨겨져 있거나 표에 없는 행으로 이동해, 명령이 아무 일도 하지
        // 않은 것처럼 보인다. 걸리지 않는 검색은 그대로 둔다 — 사용자가 좁혀 둔
        // 화면을 명령 하나가 매번 되돌리지는 않는다.
        const cleared = Boolean(curQ) && !matchSeg(seg, curQ);
        if (cleared) {
            searchInput.value = '';
            doSearch();
        }

        ensureRegionExpanded(idx);   // 첫 펼침이면 여기서 상세 표가 렌더된다

        let target = null;
        const vt = vtMap.get(idx);
        if (vt) {
            const r = vt.fd.indexOf(seg);
            if (r >= 0) { target = { k: 'vt', vi: idx, r: r }; }
        } else {
            // 행 순서는 정렬로 바뀌므로 위치가 아니라 속성으로 찾는다.
            const rows = card ? card.querySelectorAll('.section-table tbody tr') : [];
            for (const tr of rows) {
                if (tr.getAttribute('data-sort-addr') === String(addr) && tr.getAttribute('data-sort-name') === name) {
                    target = { k: 'el', el: tr };
                    break;
                }
            }
        }
        if (!target) { scrollToRegionCard(card); return; }

        // 검색이 살아 있다면 이 행을 현재 위치로 잡아 준다 — 그러지 않으면 바로
        // 이어 누른 ◀/▶ 가 여기가 아니라 직전 위치의 다음 결과로 튄다.
        if (curQ) {
            for (let i = 0; i < matchList.length; i++) {
                const m = matchList[i];
                const same = target.k === 'vt'
                    ? (m.k === 'vt' && m.vi === target.vi && m.r === target.r)
                    : (m.k === 'el' && m.el === target.el);
                if (same) { curMatch = i; break; }
            }
        }
        // 키보드 사용자는 여기서 이어 가야 한다 — 포커스를 옮기지 않으면 Tab 이
        // 다시 맨 위 툴바부터 시작한다. 검색 이동(◀/▶)에서는 포커스를 옮기지
        // 않는다: 검색창에서 타이핑하던 손을 뺏게 된다.
        revealTarget(target, true, true);
        announceReveal(fmt(cleared ? S.revealedAfterClear : S.revealed, { name: seg.n, addr: seg.ah }));
    }

    // --- Scroll to region / row (from extension Ctrl+Shift+O command) ---
    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg.command === 'memoryMapPanelFeedback' && msg.renderId === RENDER_ID) {
            const feedbackId = typeof msg.feedbackId === 'string'
                && msg.feedbackId.length > 0
                && msg.feedbackId.length <= 128
                ? msg.feedbackId
                : undefined;
            if (!feedbackId) return;
            // 새 Refresh가 이미 시작됐다면 지연된 linker 결과가 busy를
            // 덮지 않게 표시는 건너뛴다. ack는 보내 host의 durable 복원이
            // 다음 context에서 이전 결과를 다시 살리지 않게 한다.
            if (!refreshInFlight) {
                refreshLifecycleGeneration++;
                renderMemoryMapConfigurationFeedback(msg);
            }
            vscode.postMessage({
                command: 'memoryMapPanelFeedbackAcknowledged',
                renderId: RENDER_ID,
                feedbackId: feedbackId
            });
            return;
        }
        if (msg.command === 'refreshFailed' && msg.renderId === RENDER_ID) {
            const failedAttemptId = typeof msg.refreshAttemptId === 'string'
                && msg.refreshAttemptId.length > 0
                && msg.refreshAttemptId.length <= 128
                ? msg.refreshAttemptId
                : undefined;
            // renderId는 HTML 세대만 구분한다. 같은 문서에서 실패 후 재시도한
            // 경우에는 이전 attempt의 지연/중복 실패가 새 busy를 취소하지 못하게
            // 요청별 ID까지 맞아야 한다.
            if (!failedAttemptId || failedAttemptId !== activeRefreshAttemptId) { return; }
            refreshLifecycleGeneration++;
            activeRefreshAttemptId = undefined;
            renderRefreshFailure(msg.reason, msg.failedAt, true, false);
            vscode.postMessage({
                command: 'refreshFailureAcknowledged',
                renderId: RENDER_ID,
                refreshAttemptId: failedAttemptId
            });
            return;
        }
        if (msg.command === 'requestRefresh' && msg.renderId === RENDER_ID) {
            beginRefresh();
            return;
        }
        if (msg.command === 'revealEntry') {
            revealEntry(msg.regionIndex, msg.region, msg.name, msg.addr);
            return;
        }
        if (msg.command === 'scrollToRegion') {
            const cards = document.querySelectorAll('.region-card');
            for (const card of cards) {
                const strong = card.querySelector('.region-header strong');
                if (strong && strong.textContent.trim() === msg.name) {
                    scrollToRegionCard(card);
                    return;
                }
            }
        }
    });

    // --- Column sort for sortable-table (obj summary, all-sections) ---
    function initSort(root) {
        const descFirst = new Set(['size', 'bytes', 'pct']);
        root.querySelectorAll('.sortable-table').forEach(function(tbl) {
            const ths = tbl.querySelectorAll('th[data-sort]');
            let sortCol = null, sortAsc = true;
            ths.forEach(function(th) {
                // Sorting was pointer-only. Headers carry tabindex in the
                // markup, so Enter/Space now triggers the same handler.
                th.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        th.click();
                    }
                });
                th.addEventListener('click', function() {
                    const col = th.dataset.sort;
                    if (sortCol === col) sortAsc = !sortAsc;
                    else { sortCol = col; sortAsc = !descFirst.has(col); }
                    const tbody = tbl.querySelector('tbody');
                    const sortByCol = th.dataset.sortBy || col;
                    const allThs = Array.from(th.parentElement.children);
                    const targetTh = allThs.find(function(h) { return h.dataset && h.dataset.sort === sortByCol; }) || th;
                    const valIdx = allThs.indexOf(targetTh);

                    // 부모 행과 그 뒤에 딸린 detail 행을 한 묶음으로 모은다.
                    // 예전에는 부모만 골라 재배치해서, Object Summary의
                    // Details를 펼친 상태로 정렬하면 section 행이 제자리에
                    // 남아 묶음이 통째로 어긋났다. detail 행은 독립 정렬
                    // 대상이 아니라 부모를 따라다니기만 한다.
                    //
                    // detail 행이 없는 표(All Sections, region 상세)에서는
                    // 모든 행이 1개짜리 그룹이 되어 종전과 동일하게 동작한다.
                    const groups = [];
                    Array.from(tbody.children).forEach(function(row) {
                        if (row.classList.contains('obj-detail-row') && groups.length > 0) {
                            groups[groups.length - 1].rows.push(row);
                        } else {
                            groups.push({ head: row, rows: [row] });
                        }
                    });

                    // 정렬값은 행 속성을 우선한다. colspan이 있는 행에서는
                    // 헤더 순번과 <td> 순번이 어긋나므로 셀 텍스트를 믿을 수
                    // 없고, 표시값(반올림된 퍼센트, "1.2 KB" 같은 문자열)은
                    // 애초에 정렬 기준으로 부정확하다. 속성이 없는 표는
                    // 종전대로 셀 텍스트를 읽는다.
                    function sortValueOf(row) {
                        const attr = row.getAttribute('data-sort-' + sortByCol);
                        if (attr !== null) { return { text: attr, fromAttr: true }; }
                        if (valIdx < 0 || valIdx >= row.children.length) { return { text: '', fromAttr: false }; }
                        return { text: row.children[valIdx].textContent.trim(), fromAttr: false };
                    }

                    // 속성 값은 프로그램이 넣은 원본이므로 문자 제거 없이
                    // Number()로 그대로 읽는다. 정규식 정리는 "1.2 KB" 같은
                    // 표시용 셀 텍스트에만 필요한데, 원본 값에 적용하면
                    // 아주 작은 퍼센트의 지수 표기(9e-7)에서 e를 지워
                    // 9-7 → 9로 읽는 오독이 생긴다. 이름처럼 숫자가 아닌
                    // 속성은 Number()가 NaN을 돌려줘 문자열 비교로 넘어간다 —
                    // stm32f4xx_hal.o가 324로 비교되던 셀 경로의 문제도 속성
                    // 행에서는 함께 사라진다.
                    function sortNumberOf(value) {
                        if (value.fromAttr) { return Number(value.text); }
                        // 셀 텍스트는 **숫자를 표현한 것일 때만** 수치로 읽는다.
                        //
                        // 예전에는 숫자가 아닌 문자를 모두 지운 뒤 parseFloat 했다.
                        // 그러면 이름도 숫자가 된다: stm32f4xx_hal.o → 324.
                        // → 324. 그래서 이름 열에서 stm32f1.o(321)와
                        // stm32f4.o(324)가 **문자열이 아니라 수치로** 비교됐고,
                        // 숫자가 없는 이름은 NaN 이라 문자열 비교로 빠져 같은
                        // 열 안에서 두 규칙이 섞였다.
                        //
                        // 표시용 숫자 셀(1.2 KB, 27.5%, 0x08000000)만
                        // 통과시킨다 — 선택적 부호/0x 접두사 + 숫자로 시작하고,
                        // 뒤에 단위나 기호가 붙는 형태. 이름처럼 문자로 시작하는
                        // 값은 NaN 이 되어 문자열 비교로 간다.
                        const text = value.text.trim();
                        const numeric = /^[-+]?(0[xX][0-9a-fA-F]+|[0-9][0-9,]*(\\.[0-9]+)?)/.exec(text);
                        if (!numeric) { return NaN; }
                        const token = numeric[0].replace(/,/g, '');
                        return /^[-+]?0[xX]/.test(token) ? Number(token) : parseFloat(token);
                    }

                    groups.sort(function(a, b) {
                        const aV = sortValueOf(a.head);
                        const bV = sortValueOf(b.head);
                        const aN = sortNumberOf(aV);
                        const bN = sortNumberOf(bV);
                        if (!isNaN(aN) && !isNaN(bN)) return sortAsc ? aN - bN : bN - aN;
                        return sortAsc ? aV.text.localeCompare(bV.text) : bV.text.localeCompare(aV.text);
                    });
                    groups.forEach(function(g) {
                        g.rows.forEach(function(row) { tbody.appendChild(row); });
                    });
                    ths.forEach(function(h) {
                        h.textContent = h.textContent.replace(/ [\u25B2\u25BC]$/, '');
                        // aria-sort is what a screen reader announces; the
                        // \u25B2/\u25BC glyph alone conveys nothing to it. The title
                        // resets with it \u2014 a column that is no longer sorted
                        // must not keep advertising "sort descending".
                        h.setAttribute('aria-sort', 'none');
                        h.setAttribute('title', S.sortAscending);
                    });
                    th.textContent += sortAsc ? ' \u25B2' : ' \u25BC';
                    th.setAttribute('aria-sort', sortAsc ? 'ascending' : 'descending');
                    th.setAttribute('title', sortAsc ? S.sortDescending : S.sortAscending);
                    // All Sections and non-virtual region tables feed matchList; keep nav in sync.
                    if (tbl.id === 'sectionTable' || tbl.classList.contains('section-table')) { resyncAfterReflow(); }
                });
            });
        });
    }

    // --- Data-driven sort for region section tables (including virtual) ---
    document.addEventListener('click', function(ev) {
        const th = ev.target.closest && ev.target.closest('.region-card .section-table th[data-sort]');
        sortRegionTable(th);
    });

    // 클릭 전용이던 정렬에 키보드 경로를 붙인다. initSort의 정적 표는
    // 0.6.21에 이 처리를 받았지만, 여기 region 표들은 빠져 있었다.
    document.addEventListener('keydown', function(ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') { return; }
        const th = ev.target.closest && ev.target.closest('.region-card .section-table th[data-sort]');
        if (!th) { return; }
        ev.preventDefault();   // Space의 기본 스크롤 억제
        sortRegionTable(th);
    });

    function sortRegionTable(th) {
        if (!th || th.closest('.sortable-table')) return;

        const card = th.closest('.region-card');
        const idx = parseInt(card.dataset.idx);
        const rd = RD[idx];
        const sortByCol = th.dataset.sortBy || th.dataset.sort;

        // 방향 상태를 **표(카드) 단위**로 둔다. 예전에는 헤더마다 th._sortAsc
        // 를 따로 들고 있어서, 같은 표가 행 수에 따라 다르게 동작했다:
        // 200행 이하면 sortable-table 경로가 테이블 하나의 sortCol 을 쓰므로
        // Name → Address → Name 이 Name 오름차순으로 재시작하는데, 200행
        // 초과면 이 경로가 각 헤더의 옛 상태를 기억해 Name 이 내림차순으로
        // 뒤집혔다. 두 경로가 같은 규칙(열이 바뀌면 방향 초기화)을 쓴다.
        if (card._sortCol === sortByCol) { card._sortAsc = !card._sortAsc; }
        else { card._sortCol = sortByCol; card._sortAsc = !(['size','bytes'].includes(sortByCol)); }
        const asc = card._sortAsc;

        rd.segments.sort(function(a, b) {
            let av, bv;
            switch(sortByCol) {
                case 'name': av = a.n; bv = b.n; break;
                case 'section': av = a.s; bv = b.s; break;
                case 'func': av = a.f; bv = b.f; break;
                case 'addr': av = a.a; bv = b.a; break;
                case 'end': av = a.a + a.sz; bv = b.a + b.sz; break;
                case 'bytes': case 'size': av = a.sz; bv = b.sz; break;
                case 'type': av = a.t; bv = b.t; break;
                default: return 0;
            }
            if (typeof av === 'number') return asc ? av - bv : bv - av;
            return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });

        const vt = vtMap.get(idx);
        if (vt) {
            vt.fd = curQ ? vt.data.filter(function(seg) { return matchSeg(seg, curQ); }) : vt.data;
            // renderVT 가 옛 행 번호로 강조를 다시 칠하기 **전에** 번호를 고친다.
            resyncCurrentTargetAfterSort(idx);
            vt.vp.scrollTop = 0;
            vt.ls = -1;
            renderVT(vt);
        } else {
            const tbody = card.querySelector('.section-table tbody');
            if (tbody) {
                resyncCurrentTargetAfterSort(idx);   // 곧 끊어질 <tr> 참조를 놓는다
                const data = curQ ? rd.segments.filter(function(seg) { return matchSeg(seg, curQ); }) : rd.segments;
                tbody.innerHTML = data.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi, rd.hhx, rd.hhs); }).join('');
            }
        }

        const ths = th.parentElement.querySelectorAll('th[data-sort]');
        ths.forEach(function(h) {
            h.textContent = h.textContent.replace(/ [\u25B2\u25BC]$/, '');
            // \uC815\uB82C \uAE30\uC900\uC774 \uC544\uB2CC \uC5F4\uC740 none\uC73C\uB85C \uB418\uB3CC\uB9B0\uB2E4. \uB0A8\uACA8 \uB450\uBA74 \uC2A4\uD06C\uB9B0\uB9AC\uB354\uAC00
            // \uC774\uC804 \uAE30\uC900 \uC5F4\uC744 \uACC4\uC18D \uC815\uB82C\uB41C \uAC83\uC73C\uB85C \uC548\uB0B4\uD55C\uB2E4.
            h.setAttribute('aria-sort', 'none');
            h.setAttribute('title', S.sortAscending);
        });
        th.textContent += asc ? ' \u25B2' : ' \u25BC';
        th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        th.setAttribute('title', asc ? S.sortDescending : S.sortAscending);
        resyncAfterReflow();   // a region section table feeds matchList; resync nav after re-render
    }

    // Initialize sort on static tables (overview, all-sections)
    initSort(document);

    // --- Toggle Function column ---
    function syncFuncBtn() {
        const fb = document.querySelector('[data-action="toggle-func-col"]');
        if (fb) { fb.textContent = S.funcColumnToggle + (funcVis ? ' ▼' : ' ▶'); }
    }
    window.toggleFuncCol = function() {
        funcVis = !funcVis;
        searchAutoFunc = false;                  // current state is now user-chosen, not search-driven
        if (curQ) { funcUserOverride = true; }   // ...and it overrides the search auto-reveal until the query is cleared
        document.querySelectorAll('.func-cell').forEach(function(el) {
            el.classList.toggle('hidden', !funcVis);
        });
        syncFuncBtn();
        // Re-render virtual tables to reflect column visibility
        vtMap.forEach(function(vt) { vt.ls = -1; renderVT(vt); });
    };
    syncFuncBtn();

    // --- Toggle Object Summary fold ---
    // \uD5E4\uB354\uC640 \uC139\uC158 \uD589 \uBC84\uD2BC\uC774 \uD615\uC81C\uB77C DOM \uC704\uCE58\uB85C \uBCF8\uBB38\uC744 \uCC3E\uC744 \uC218 \uC5C6\uB2E4. \uB458 \uB2E4
    // aria-controls\uB85C \uAC19\uC740 \uBCF8\uBB38\uC744 \uAC00\uB9AC\uD0A4\uBBC0\uB85C \uADF8\uAC83\uC73C\uB85C \uCC3E\uB294\uB2E4 \u2014 \uB9C8\uD06C\uC5C5\uC774 \uB610
    // \uBC14\uB00C\uC5B4\uB3C4 \uB530\uB77C \uAE68\uC9C0\uC9C0 \uC54A\uB294\uB2E4.
    function objSummaryBody(el) {
        const id = el.getAttribute('aria-controls');
        return id ? document.getElementById(id) : null;
    }

    /** \uD3BC\uCE68 \uC0C1\uD0DC\uB97C \uBC14\uAFB8\uB294 \uC720\uC77C\uD55C \uACBD\uB85C \u2014 setRegionExpanded \uC640 \uAC19\uC740 \uC774\uC720\uB2E4. */
    function setObjSummaryExpanded(header, expanded) {
        const body = objSummaryBody(header);
        if (!body) { return; }
        body.style.display = expanded ? '' : 'none';
        const icon = header.querySelector('.fold-icon');
        if (icon) { icon.textContent = expanded ? '\u25BC' : '\u25B6'; }
        header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (!expanded) { resetObjDetailRows(header, body); }
    }

    /**
     * \uC694\uC57D\uC744 \uC811\uC744 \uB54C \uC139\uC158 \uD589 \uBC84\uD2BC\uB3C4 \uB048 \uC0C1\uD0DC\uB85C \uB418\uB3CC\uB9B0\uB2E4.
     *
     * \uADF8\uB7EC\uC9C0 \uC54A\uC73C\uBA74 \uBC84\uD2BC\uC740 "\uCF1C\uC9D0"\uC774\uB77C \uB9D0\uD558\uB294\uB370 \uD654\uBA74\uC5D0\uB294 \uC544\uBB34\uAC83\uB3C4 \uC5C6\uACE0, \uADF8
     * \uC0C1\uD0DC\uC5D0\uC11C \uD55C \uBC88 \uB354 \uB204\uB974\uBA74 **\uBCF4\uC774\uC9C0 \uC54A\uB294 \uD589\uC744 \uC228\uAE30\uB294** \uC148\uC774\uB77C \uB610 \uC544\uBB34
     * \uBCC0\uD654\uAC00 \uC5C6\uB2E4 \u2014 \uC774\uBC88\uC5D0 \uACE0\uCE5C \uBB34\uBC18\uC751\uC774 \uBC29\uD5A5\uB9CC \uBC14\uB00C\uC5B4 \uB418\uC0B4\uC544\uB09C\uB2E4. \uC9C0\uCF1C\uC57C \uD560
     * \uBD88\uBCC0\uC2DD\uC740 \uD558\uB098\uB2E4: \uBC84\uD2BC\uC758 \uC0C1\uD0DC\uB294 \uB298 \uD654\uBA74\uC5D0 \uC2E4\uC81C\uB85C \uBCF4\uC774\uB294 \uAC83\uACFC \uAC19\uB2E4.
     */
    function resetObjDetailRows(header, body) {
        const bar = header.closest('.obj-summary-bar');
        const btn = bar && bar.querySelector('[data-action="toggle-obj-detail-rows"]');
        if (btn) {
            btn.setAttribute('aria-pressed', 'false');
            btn.textContent = S.objDetailRows + ' \u25B6';
        }
        syncObjSummary(body.closest('.region-card'));
    }

    window.toggleObjSummary = function(header) {
        const body = objSummaryBody(header);
        if (!body) { return; }
        setObjSummaryExpanded(header, body.style.display === 'none');
    };

    /**
     * 요약 표의 행 표시를 한 번에 맞춘다.
     *
     * 이 표의 행 하나에 조건이 둘 걸린다 — 섹션 행 토글이 켜졌는지, 그리고
     * 검색어에 걸리는지. 두 곳에서 각자 display 를 만지면 나중에 실행된 쪽이
     * 이기고, 그 순간부터 버튼 상태와 화면이 갈라진다(이 릴리스가 고친 결함이
     * 바로 그것이다). 그래서 **여기서만** 두 조건을 합쳐 계산한다.
     *
     * 오브젝트는 자기 이름이 걸리거나 **딸린 섹션 중 하나라도** 걸리면 남는다.
     * 검색 중에 이 표를 여는 이유가 "이 검색어가 어느 오브젝트에 있나"이기
     * 때문이다. 매치 개수(◀▶ 이동)에는 넣지 않는다 — 같은 바이트가 아래
     * 섹션 표에 이미 매치로 잡혀 있어 두 번 세게 된다.
     */
    function syncObjSummary(card) {
        const body = card && card.querySelector('.obj-summary-body');
        if (!body) { return; }
        const bar = card.querySelector('.obj-summary-bar');
        const btn = bar && bar.querySelector('[data-action="toggle-obj-detail-rows"]');
        const rowsOn = !!btn && btn.getAttribute('aria-pressed') === 'true';
        const q = curQ;

        const groups = [];
        body.querySelectorAll('tbody tr').forEach(function(row) {
            if (row.classList.contains('obj-detail-row')) {
                if (groups.length > 0) { groups[groups.length - 1].details.push(row); }
            } else {
                groups.push({ parent: row, details: [] });
            }
        });

        groups.forEach(function(g) {
            // 하이라이트를 걷어내고 원래 마크업으로 되돌린 뒤 다시 칠한다.
            // 처음 만지는 행은 이때 원본이 보관된다.
            restoreRowHtml(g.parent);
            g.details.forEach(restoreRowHtml);

            if (!q) {
                g.parent.style.display = '';
                g.details.forEach(function(r) { r.style.display = rowsOn ? 'table-row' : 'none'; });
                return;
            }

            const parentHit = g.parent.textContent.toLowerCase().indexOf(q) !== -1;
            const detailHit = g.details.map(function(r) { return r.textContent.toLowerCase().indexOf(q) !== -1; });
            const keep = parentHit || detailHit.indexOf(true) !== -1;

            g.parent.style.display = keep ? '' : 'none';
            if (parentHit) { markTextNodes(g.parent, q); }
            g.details.forEach(function(r, i) {
                // 오브젝트 이름이 걸린 경우엔 딸린 섹션을 모두 보여 준다 —
                // 그 오브젝트 전체가 결과이기 때문이다.
                const show = keep && rowsOn && (parentHit || detailHit[i]);
                r.style.display = show ? 'table-row' : 'none';
                if (show && detailHit[i]) { markTextNodes(r, q); }
            });
        });
    }

    /** 원본 마크업 보관/복원. 정적 표와 같은 WeakMap 을 쓴다. */
    function restoreRowHtml(row) {
        const orig = staticOrig.get(row);
        if (orig === undefined) { staticOrig.set(row, row.innerHTML); }
        else if (row.innerHTML !== orig) { row.innerHTML = orig; }
    }

    // --- Toggle detail rows in per-region object summary ---
    window.toggleObjDetailRows = function(btn) {
        const body = objSummaryBody(btn);
        if (!body) { return; }
        // \uC0C1\uD0DC\uB97C \uACC4\uC0B0\uB41C \uC2A4\uD0C0\uC77C\uC774 \uC544\uB2C8\uB77C \uBC84\uD2BC \uC790\uC2E0\uC5D0\uAC8C\uC11C \uC77D\uB294\uB2E4. \uD589\uC774 \uD558\uB098\uB3C4
        // \uC5C6\uB294 \uD45C\uC5D0\uC11C\uB294 \uC61B \uBC29\uC2DD\uC774 \uB298 "\uC774\uBBF8 \uBCF4\uC784"\uC73C\uB85C \uD310\uC815\uD574 \uC544\uBB34 \uC77C\uB3C4 \uD558\uC9C0
        // \uC54A\uC558\uACE0, \uBC84\uD2BC \uB77C\uBCA8\uACFC \uC2E4\uC81C \uC0C1\uD0DC\uAC00 \uAC08\uB77C\uC9C8 \uC790\uB9AC\uB3C4 \uC5C6\uC564\uB2E4.
        const show = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.textContent = S.objDetailRows + (show ? ' \u25BC' : ' \u25B6');
        // \uC2E4\uC81C \uD45C\uC2DC\uB294 syncObjSummary \uAC00 \uC815\uD55C\uB2E4 \u2014 \uAC80\uC0C9 \uD544\uD130\uC640 \uC774 \uD1A0\uAE00\uC774 \uAC19\uC740
        // \uD589\uC744 \uB450\uACE0 \uB2E4\uD22C\uC9C0 \uC54A\uB3C4\uB85D \uACC4\uC0B0\uC744 \uD55C \uACF3\uC5D0 \uBAA8\uC740\uB2E4.
        syncObjSummary(body.closest('.region-card'));

        // \uC811\uD78C \uC694\uC57D \uC548\uC758 \uD589\uC744 \uCF1C\uB294 \uAC83\uC740 **\uD654\uBA74\uC0C1 \uC544\uBB34 \uC77C\uB3C4 \uC77C\uC5B4\uB098\uC9C0 \uC54A\uB294**
        // \uC870\uC791\uC774\uC5C8\uB2E4. Object Summary\uB294 \uAE30\uBCF8\uC774 \uC811\uD798\uC774\uB77C \uC774 \uBC84\uD2BC\uC744 \uCC98\uC74C \uB204\uB974\uB294
        // \uC0AC\uB78C\uC740 \uC608\uC678 \uC5C6\uC774 \uADF8 \uC0C1\uD0DC\uB97C \uB9CC\uB09C\uB2E4 \u2014 \uB20C\uB7EC\uB3C4 \uADF8\uB300\uB85C\uB2C8 \uACE0\uC7A5\uC73C\uB85C \uC77D\uD78C\uB2E4.
        // \uCF1C\uB294 \uBC29\uD5A5\uC774\uBA74 \uC694\uC57D\uC744 \uD568\uAED8 \uD3BC\uCCD0 \uACB0\uACFC\uB97C \uBCF4\uC5EC \uC900\uB2E4.
        if (show) {
            const bar = btn.closest('.obj-summary-bar');
            const header = bar && bar.querySelector('.obj-summary-header');
            if (header && body.style.display === 'none') { setObjSummaryExpanded(header, true); }
        }
    };

    // --- Scroll to top button ---
    const scrollBtn = document.getElementById('scrollTop');
    window.addEventListener('scroll', function() {
        scrollBtn.classList.toggle('visible', window.scrollY > 200);
    });
    scrollBtn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    function capturedSort(table, kind, regionIndex) {
        if (!table) return null;
        const active = table.querySelector('th[data-sort][aria-sort="ascending"], th[data-sort][aria-sort="descending"]');
        if (!active) return null;
        return {
            kind: kind,
            regionIndex: regionIndex,
            regionName: regionIndex >= 0 && RD[regionIndex] ? RD[regionIndex].name : '',
            column: active.dataset.sort,
            ascending: active.getAttribute('aria-sort') === 'ascending'
        };
    }

    function searchMatchKey(match) {
        if (!match) return null;
        if (match.k === 'vt') {
            const vt = vtMap.get(match.vi);
            const seg = vt && vt.fd[match.r];
            return seg ? {
                kind: 'region', regionIndex: match.vi, regionName: RD[match.vi]?.name,
                name: seg.n, addr: seg.a,
                section: seg.s, func: seg.f, type: seg.t, size: seg.sz
            } : null;
        }
        const row = match.el;
        if (!row) return null;
        const overviewRegion = row.getAttribute('data-region');
        if (overviewRegion !== null) return { kind: 'overview', region: overviewRegion };
        const card = row.closest && row.closest('.region-card');
        return {
            kind: card ? 'region' : 'all',
            regionIndex: card ? parseInt(card.dataset.idx) : -1,
            regionName: card && RD[parseInt(card.dataset.idx)] ? RD[parseInt(card.dataset.idx)].name : '',
            name: row.getAttribute('data-sort-name'),
            addr: Number(row.getAttribute('data-sort-addr')),
            section: row.getAttribute('data-sort-section') || '',
            func: row.getAttribute('data-sort-func') || '',
            type: row.getAttribute('data-sort-type') || '',
            size: Number(row.getAttribute('data-sort-bytes'))
        };
    }

    function sameSearchMatch(match, key) {
        const candidate = searchMatchKey(match);
        if (!candidate || !key || candidate.kind !== key.kind) return false;
        if (candidate.kind === 'overview') return candidate.region === key.region;
        return candidate.regionIndex === key.regionIndex
            && candidate.regionName === key.regionName
            && candidate.name === key.name
            && candidate.addr === key.addr
            && candidate.section === key.section
            && candidate.func === key.func
            && candidate.type === key.type
            && candidate.size === key.size;
    }

    /** Refresh가 HTML을 교체하기 직전, 사용자가 보고 있던 문맥을 논리 상태로 저장한다. */
    function captureMemoryMapViewState() {
        const expandedRegions = [], objectSummaries = [], objectDetailRows = [], virtualScroll = [], sorts = [];
        const refreshFeedback = document.getElementById('refreshFeedback');
        const allSectionsSort = capturedSort(document.getElementById('sectionTable'), 'all', -1);
        if (allSectionsSort) sorts.push(allSectionsSort);
        document.querySelectorAll('.region-card').forEach(function(card) {
            const idx = parseInt(card.dataset.idx);
            const detail = card.querySelector('.region-detail');
            const regionRef = { index: idx, name: RD[idx]?.name };
            if (detail && detail.style.display !== 'none') expandedRegions.push(regionRef);
            const objHeader = card.querySelector('.obj-summary-header');
            if (objHeader && objHeader.getAttribute('aria-expanded') === 'true') objectSummaries.push(regionRef);
            const objRows = card.querySelector('[data-action="toggle-obj-detail-rows"]');
            if (objRows && objRows.getAttribute('aria-pressed') === 'true') objectDetailRows.push(regionRef);
            const sectionSort = capturedSort(card.querySelector('.section-table'), 'section', idx);
            const objectSort = capturedSort(card.querySelector('.obj-summary-table'), 'object', idx);
            if (sectionSort) sorts.push(sectionSort);
            if (objectSort) sorts.push(objectSort);
            const viewport = card.querySelector('.vt-viewport');
            if (viewport && viewport.scrollTop > 0) {
                virtualScroll.push({ regionIndex: idx, regionName: RD[idx]?.name, top: viewport.scrollTop });
            }
        });
        return {
            scrollY: window.scrollY,
            refreshFeedbackHeight: refreshFeedback ? refreshFeedback.getBoundingClientRect().height : 0,
            refreshFeedbackTop: refreshFeedback
                ? window.scrollY + refreshFeedback.getBoundingClientRect().top
                : 0,
            totals: { flash: CURRENT_TOTALS.flash, ram: CURRENT_TOTALS.ram },
            searchQuery: searchInput ? searchInput.value : '',
            currentMatch: curMatch,
            currentMatchKey: curMatch >= 0 && curMatch < matchList.length ? searchMatchKey(matchList[curMatch]) : null,
            funcVis: funcVis,
            searchAutoFunc: searchAutoFunc,
            funcUserOverride: funcUserOverride,
            expandedRegions: expandedRegions,
            objectSummaries: objectSummaries,
            objectDetailRows: objectDetailRows,
            virtualScroll: virtualScroll,
            sorts: sorts
        };
    }

    function applyCapturedSort(state) {
        if (!state || !['all', 'section', 'object'].includes(state.kind)) return;
        let table = null;
        if (state.kind === 'all') {
            table = document.getElementById('sectionTable');
        } else {
            const regionIndex = Number(state.regionIndex);
            if (!Number.isInteger(regionIndex) || regionIndex < 0 || regionIndex >= RD.length) return;
            if (typeof state.regionName === 'string' && state.regionName !== RD[regionIndex].name) return;
            const card = document.querySelector('.region-card[data-idx="' + regionIndex + '"]');
            table = card && card.querySelector(state.kind === 'object' ? '.obj-summary-table' : '.section-table');
        }
        if (!table || typeof state.column !== 'string') return;
        const headers = Array.from(table.querySelectorAll('th[data-sort]'));
        const header = headers.find(function(th) { return th.dataset.sort === state.column; });
        if (!header) return;
        header.click();
        if ((header.getAttribute('aria-sort') === 'ascending') !== (state.ascending === true)) {
            header.click();
        }
    }

    /** 새 render의 lazy DOM을 만든 뒤 저장된 문맥을 복원한다. */
    function restoreMemoryMapViewState(viewState, consumeSnapshot) {
        if (!viewState || typeof viewState !== 'object') return undefined;
        const previousRestoring = restoringView;
        let restoredScrollY;
        restoringView = true;
        try {
        function regionSet(value) {
            const result = new Set();
            if (!Array.isArray(value)) return result;
            value.slice(0, RD.length).forEach(function(ref) {
                const idx = typeof ref === 'number' ? ref : Number(ref && ref.index);
                const name = typeof ref === 'object' && ref ? ref.name : undefined;
                if (!Number.isInteger(idx) || idx < 0 || idx >= RD.length) return;
                if (typeof name === 'string' && name !== RD[idx].name) return;
                result.add(idx);
            });
            return result;
        }
        const expanded = regionSet(viewState.expandedRegions);
        const objExpanded = regionSet(viewState.objectSummaries);
        const objRowsOn = regionSet(viewState.objectDetailRows);
        const sorts = Array.isArray(viewState.sorts)
            ? viewState.sorts.filter(function(state) { return state && typeof state === 'object'; }).slice(0, RD.length * 2 + 1)
            : [];
        const virtualScroll = Array.isArray(viewState.virtualScroll)
            ? viewState.virtualScroll.filter(function(state) {
                const idx = Number(state && state.regionIndex);
                return Number.isInteger(idx) && idx >= 0 && idx < RD.length
                    && (typeof state.regionName !== 'string' || state.regionName === RD[idx].name)
                    && Number.isFinite(Number(state.top));
            }).slice(0, RD.length)
            : [];
        const needed = new Set();
        expanded.forEach(function(idx) { needed.add(idx); });
        objExpanded.forEach(function(idx) { needed.add(idx); });
        objRowsOn.forEach(function(idx) { needed.add(idx); });
        sorts.forEach(function(state) { if (state && state.regionIndex >= 0) needed.add(state.regionIndex); });
        virtualScroll.forEach(function(state) { if (state && state.regionIndex >= 0) needed.add(state.regionIndex); });
        if (viewState.currentMatchKey && viewState.currentMatchKey.kind === 'region') {
            needed.add(viewState.currentMatchKey.regionIndex);
        }

        funcVis = viewState.funcVis === true;
        funcUserOverride = viewState.funcUserOverride === true;
        searchAutoFunc = viewState.searchAutoFunc === true;
        syncFuncBtn();
        if (searchInput && typeof viewState.searchQuery === 'string') {
            searchInput.value = viewState.searchQuery;
            doSearch();
        }
        needed.forEach(function(idx) {
            if (Number.isInteger(idx) && RD[idx]) renderDetail(idx);
        });
        // 검색은 작은 region 표의 tbody를 다시 만들므로 정렬은 반드시 검색과
        // 모든 lazy render가 끝난 뒤 적용한다.
        sorts.forEach(applyCapturedSort);

        document.querySelectorAll('.region-card').forEach(function(card) {
            const idx = parseInt(card.dataset.idx);
            setRegionExpanded(card, expanded.has(idx));
            if (!rendered.has(idx)) return;
            const objHeader = card.querySelector('.obj-summary-header');
            if (objHeader) setObjSummaryExpanded(objHeader, objExpanded.has(idx));
            const objRows = card.querySelector('[data-action="toggle-obj-detail-rows"]');
            if (objRows && objRowsOn.has(idx)) {
                objRows.setAttribute('aria-pressed', 'true');
                objRows.textContent = S.objDetailRows + ' \u25BC';
                syncObjSummary(card);
            }
        });
        virtualScroll.forEach(function(state) {
            const vt = vtMap.get(state.regionIndex);
            if (vt && Number.isFinite(state.top)) {
                vt.vp.scrollTop = Math.max(0, state.top);
                vt.ls = -1;
                renderVT(vt);
            }
        });
        let targetMatch = -1;
        if (viewState.currentMatchKey) {
            targetMatch = matchList.findIndex(function(match) { return sameSearchMatch(match, viewState.currentMatchKey); });
        }
        if (targetMatch >= 0) {
            curMatch = targetMatch;
            revealMatch(curMatch, false);
        } else if (matchList.length > 0 && typeof viewState.currentMatch === 'number'
            && Number.isInteger(viewState.currentMatch)) {
            // 행의 주소·크기가 빌드로 바뀌어 stable key가 더는 일치하지 않아도,
            // 사용자가 보고 있던 검색 순번에 가장 가까운 결과를 유지한다.
            curMatch = Math.min(matchList.length - 1, Math.max(0, viewState.currentMatch));
            revealMatch(curMatch, false);
        } else {
            curMatch = matchList.length > 0 ? 0 : -1;
            updateNavUI();
        }
        const scrollY = Number(viewState.scrollY);
        if (Number.isFinite(scrollY)) {
            restoredScrollY = Math.max(0, scrollY);
        }
        } finally {
            restoringView = previousRestoring;
            // 새 render에서 한 번 소비한 snapshot이 이후 context 재생성 때 사용자의
            // 더 최신 조작을 덮어쓰지 않도록 제거한다.
            if (consumeSnapshot !== false) {
                persistWebviewState({ memoryMapViewState: undefined });
            }
        }
        return restoredScrollY;
    }

    function beginRefresh() {
        const refreshButton = document.getElementById('btnRefresh');
        const refreshStatus = document.getElementById('refreshStatus');
        if (!refreshButton || !refreshStatus || refreshInFlight || refreshButton.getAttribute('aria-disabled') === 'true') {
            return;
        }
        const requestedAt = Date.now();
        refreshLifecycleGeneration++;
        activeRefreshAttemptId = RENDER_ID + ':' + requestedAt.toString(36)
            + ':' + (++refreshAttemptSequence).toString(36);
        persistWebviewState({
            refreshPending: true,
            // webview context가 사라져 응답을 못 받더라도 이전 결과를 최신으로
            // 오인하지 않도록 요청 순간부터 보수적으로 stale 상태를 기록한다.
            refreshFailed: true,
            refreshFailureReason: S.refreshInterrupted,
            refreshFailedAt: requestedAt,
            refreshFailureDismissed: false,
            refreshAttemptId: activeRefreshAttemptId,
            memoryMapViewState: Object.assign({ version: 1, fromRenderId: RENDER_ID }, captureMemoryMapViewState())
        });
        setRefreshFeedback('busy', S.refreshing, false, undefined);
        vscode.postMessage({
            command: 'refresh',
            renderId: RENDER_ID,
            refreshAttemptId: activeRefreshAttemptId
        });
    }

    function schedulePendingSnapshotRefresh() {
        const shouldPersistViewState = function() {
            return refreshInFlight || readWebviewState().refreshFailed === true;
        };
        if (!shouldPersistViewState() || pendingSnapshotScheduled) return;
        pendingSnapshotScheduled = true;
        const saveLatestView = function() {
            pendingSnapshotScheduled = false;
            // 실패가 확정된 뒤에도 사용자는 이전 결과에서 검색·정렬·접기를
            // 계속 조작할 수 있다. 그 최신 상태를 저장하지 않으면 같은 render의
            // webview context가 재생성될 때 요청 시점 snapshot으로 되돌아간다.
            if (!shouldPersistViewState()) return;
            persistWebviewState({
                memoryMapViewState: Object.assign(
                    { version: 1, fromRenderId: RENDER_ID },
                    captureMemoryMapViewState()
                )
            });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(saveLatestView);
        } else {
            setTimeout(saveLatestView, 0);
        }
    }

    // --- Delegated click handlers (replaces inline onclick for CSP compliance) ---
    document.addEventListener('click', function(ev) {
        const target = ev.target;
        if (!target || target.nodeType !== 1) { return; }
        const actionEl = target.closest('[data-action]');
        if (!actionEl) { return; }
        runAction(actionEl);
    });

    // --- 키보드 경로. 접히는 헤더 두 곳(region-header / obj-summary-header)은
    // <div>라 Tab이 닿지 않고 Enter/Space도 먹지 않아, 마우스 없이는 region
    // 상세를 펼칠 방법이 아예 없었다. role=button + tabindex로 포커스를 받게
    // 하고 여기서 활성화를 처리한다.
    //
    // 진짜 <button>은 제외한다 — 브라우저가 Enter/Space에 click을 이미 합성하므로
    // 여기서 또 처리하면 토글이 두 번 일어나 아무 일도 안 한 것처럼 보인다.
    document.addEventListener('keydown', function(ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') { return; }
        const target = ev.target;
        if (!target || target.nodeType !== 1) { return; }
        if (target.tagName === 'BUTTON') { return; }
        const actionEl = target.closest('[data-action]');
        if (!actionEl || actionEl.tagName === 'BUTTON') { return; }
        // Space는 기본 동작이 스크롤이다. 막지 않으면 펼치면서 화면이 튄다.
        ev.preventDefault();
        runAction(actionEl);
    });

    function runAction(actionEl) {
        const action = actionEl.getAttribute('data-action');
        switch (action) {
            case 'toggle-region':
                window.toggleRegion(actionEl);
                break;
            case 'toggle-all':
                window.toggleAll();
                break;
            case 'toggle-func-col':
                window.toggleFuncCol();
                break;
            case 'toggle-obj-summary':
                window.toggleObjSummary(actionEl);
                break;
            case 'toggle-obj-detail-rows':
                // stopPropagation 은 버튼이 접기 헤더 **안에** 있던 시절의
                // 잔재다. 위임 처리기는 문서에 하나뿐이고 closest 가 버튼
                // 자신을 집으므로, 형제가 된 지금은 막을 것이 없다.
                window.toggleObjDetailRows(actionEl);
                break;
            case 'open-hex':
                vscode.postMessage({ command: 'openHex', targetId: actionEl.getAttribute('data-target-id'), renderId: RENDER_ID });
                break;
            case 'open-source':
                vscode.postMessage({ command: 'openSource', targetId: actionEl.getAttribute('data-target-id'), renderId: RENDER_ID });
                break;
            case 'configure-memory-map':
                if (actionEl.getAttribute('aria-disabled') === 'true' || refreshInFlight) break;
                vscode.postMessage({ command: 'showMemoryMapSetup', renderId: RENDER_ID });
                break;
            case 'dismiss-refresh': {
                const state = readWebviewState();
                const compact = actionEl.getAttribute('aria-expanded') === 'true';
                renderRefreshFailure(state.refreshFailureReason, state.refreshFailedAt, false, compact);
                afterPaint(function() { actionEl.focus({ preventScroll: true }); });
                break;
            }
            case 'refresh': {
                beginRefresh();
                break;
            }
        }
    }
    // 분석이 오래 걸리는 동안에도 검색·정렬·접기·스크롤은 조작할 수 있다.
    // 새 HTML이 요청 시점의 snapshot으로 되돌리지 않도록 마지막 조작을 한 frame에
    // 한 번만 다시 저장한다. scroll은 bubble하지 않으므로 capture phase로 듣는다.
    document.addEventListener('click', schedulePendingSnapshotRefresh);
    document.addEventListener('input', schedulePendingSnapshotRefresh);
    document.addEventListener('keydown', schedulePendingSnapshotRefresh);
    document.addEventListener('scroll', schedulePendingSnapshotRefresh, true);
    if (IS_STANDALONE) {
        // 정규화된 DOM에 검색 결과 수와 접기 버튼 라벨을 다시 맞춘다.
        doSearch();
    }
    const restoredScrollY = pendingViewState
        // 같은 render의 busy/failed 상태는 context가 여러 번 재생성될 수 있다.
        // 성공한 새 render만 snapshot을 소비하고, 이전 결과를 보는 동안에는
        // 검색·정렬·접기 상태를 다음 재생성에도 다시 쓸 수 있게 남긴다.
        ? restoreMemoryMapViewState(
            pendingViewState,
            restoredRefreshState?.kind !== 'busy' && restoredRefreshState?.kind !== 'failed'
        )
        : undefined;
    if (!pendingViewState && restoredRefreshState?.kind !== 'busy') {
        persistWebviewState({ memoryMapViewState: undefined });
    }
    const startupLifecycleGeneration = refreshLifecycleGeneration;
    function restoreFinalViewport(focusRefresh, expectedLifecycleGeneration, allowDurableFailureTransition) {
        afterPaint(function() {
            if (typeof expectedLifecycleGeneration === 'number') {
                const lifecycleStillCurrent = expectedLifecycleGeneration === refreshLifecycleGeneration;
                const matchingDurableFailure = allowDurableFailureTransition === true
                    && refreshLifecycleGeneration === expectedLifecycleGeneration + 1
                    && !refreshInFlight;
                if (!lifecycleStillCurrent && !matchingDurableFailure) { return; }
            }
            if (Number.isFinite(restoredScrollY)) {
                const previousHeight = Number(pendingViewState && pendingViewState.refreshFeedbackHeight);
                const previousTop = Number(pendingViewState && pendingViewState.refreshFeedbackTop);
                const refreshFeedback = document.getElementById('refreshFeedback');
                const currentHeight = refreshFeedback ? refreshFeedback.getBoundingClientRect().height : 0;
                const heightDelta = Number.isFinite(previousHeight) && previousHeight >= 0 && previousHeight <= 1000
                    && Number.isFinite(currentHeight) && currentHeight >= 0 && currentHeight <= 1000
                    && Number.isFinite(previousTop) && restoredScrollY > previousTop
                    ? currentHeight - previousHeight
                    : 0;
                window.scrollTo({ top: Math.max(0, restoredScrollY + heightDelta), behavior: 'auto' });
            }
            if (focusRefresh) {
                const refreshButton = document.getElementById('btnRefresh');
                if (refreshButton) { refreshButton.focus({ preventScroll: true }); }
            }
        });
    }
    if (restoredRefreshState?.kind === 'busy') {
        // live region 문구는 접근성 트리에 들어온 뒤 알리되, 중복 요청 가드는
        // 첫 frame부터 닫아 context 복원 직후의 빠른 클릭도 통과시키지 않는다.
        refreshInFlight = true;
        const refreshButton = document.getElementById('btnRefresh');
        if (refreshButton) { refreshButton.setAttribute('aria-disabled', 'true'); }
        const configureButton = document.getElementById('btnConfigureMemoryMap');
        if (configureButton) { configureButton.setAttribute('aria-disabled', 'true'); }
        afterPaint(function() {
            // ready handshake가 먼저 durable failure를 돌려주면 그 렌더가
            // refreshInFlight를 false로 바꾼다. 예약된 busy가 뒤늦게 실패를
            // 덮거나 이미 ack된 오류를 영구 busy로 만들지 않게 한다.
            const startupBusyStillCurrent = refreshLifecycleGeneration === startupLifecycleGeneration
                && refreshInFlight;
            const durableFailureArrived = refreshLifecycleGeneration === startupLifecycleGeneration + 1
                && !refreshInFlight;
            if (startupBusyStillCurrent) {
                setRefreshFeedback('busy', S.refreshing, false, undefined);
            }
            if (!startupBusyStillCurrent && !durableFailureArrived) { return; }
            // durable failure가 먼저 도착했다면 그 generation에서 한 번은 복원하되,
            // inner paint 전에 사용자가 재시도하면 이전 snapshot이 새 attempt의
            // scroll 상태를 덮지 못하게 호출 시점 generation을 고정한다.
            restoreFinalViewport(false, refreshLifecycleGeneration, true);
        });
    } else if (restoredRefreshState?.kind === 'failed') {
        afterPaint(function() {
            if (startupLifecycleGeneration !== refreshLifecycleGeneration || refreshInFlight) { return; }
            renderRefreshFailure(
                restoredRefreshState.reason,
                restoredRefreshState.at,
                false,
                restoredRefreshState.compact
            );
            // 배너가 차지할 공간이 확정된 다음 저장된 viewport를 복원한다.
            restoreFinalViewport(false, startupLifecycleGeneration);
        });
    } else if (restoredRefreshState?.kind === 'success') {
        afterPaint(function() {
            if (startupLifecycleGeneration !== refreshLifecycleGeneration || refreshInFlight) { return; }
            renderRefreshSuccess(restoredRefreshState.at, false, pendingViewState?.totals);
            restoreFinalViewport(true, startupLifecycleGeneration);
        });
    } else {
        setRefreshFeedback('', '', false, undefined);
        restoreFinalViewport(false, startupLifecycleGeneration);
    }
    vscode.postMessage({ command: 'memoryMapReady', renderId: RENDER_ID });
})();
</script>
</body>
</html>`;
}

function esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
