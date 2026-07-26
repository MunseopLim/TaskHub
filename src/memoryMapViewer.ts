import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseElf32, classifySections, computeMemoryUsage, computeSymbolUsage, autoDetectRegions, summarizeSections, generateTextReport, generateSummaryReport, formatSize, formatHex, MemoryRegion, MemoryUsage, ElfSection, SectionSummary } from './elfParser';
import { parseLinkerFile } from './linkerScriptParser';
import { parseArmLinkList, toMemoryRegions, toElfSections, toAggregatedSummary, toMemoryUsage } from './armLinkListParser';
import { t } from './i18n';
import { DIALOG_SCOPE, showOpenDialogWithMemory, showSaveDialogWithMemory } from './dialogMemory';

interface PanelState {
    panel: vscode.WebviewPanel;
    symbols: { name: string; addr: number; type: string }[];
    messageDisposable?: vscode.Disposable;
}

const panels = new Map<string, PanelState>();
let lastActivePanel: string | undefined;

/** Panel registry – exported for testing */
export const panelRegistry = {
    has(filePath: string): boolean { return panels.has(filePath); },
    size(): number { return panels.size; },
    getLastActive(): string | undefined { return lastActivePanel; },
    getHtml(filePath: string): string | undefined { return panels.get(filePath)?.panel.webview.html; },
    clear(): void { panels.clear(); lastActivePanel = undefined; },
};

/** Memory Map에서 처리 가능한 최대 ELF/Listing 파일 크기 (100 MB). Exported so tests can pin the boundary. */
export const MEMORY_MAP_MAX_FILE_SIZE = 100 * 1024 * 1024;

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface MemoryMapConfig {
    regions?: MemoryRegion[];
}

export interface MemoryMapOpenHistory {
    filePath: string;
    fileName: string;
    inputType: 'elf' | 'listing';
    config?: MemoryMapConfig;
}

export type MemoryMapHistoryRecorder = (entry: MemoryMapOpenHistory) => void;

export async function showMemoryMap(context: vscode.ExtensionContext, config?: MemoryMapConfig, recordHistory?: MemoryMapHistoryRecorder) {
    const inputType = await vscode.window.showQuickPick([
        { label: t('AXF/ELF 파일', 'AXF/ELF File'), description: t('ARM 실행 바이너리 파싱', 'Parse ARM executable binary') },
        { label: 'ARM Linker Listing', description: t('armlink --list 출력 파일 파싱', 'Parse armlink --list output file') },
    ], { placeHolder: t('입력 파일 형식 선택', 'Select input file format') });
    if (!inputType) { return; }

    if (inputType.label === 'ARM Linker Listing') {
        const listUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapListing, {
            canSelectMany: false,
            filters: { 'ARM Linker Listing': ['txt'] },
            openLabel: t('Linker Listing 선택', 'Select Linker Listing')
        });
        if (!listUri || listUri.length === 0) { return; }
        const filePath = listUri[0].fsPath;
        if (openMemoryMapFromListing(context, filePath)) {
            recordHistory?.({
                filePath,
                fileName: filePath.split(/[\\/]/).pop() || 'Memory Map',
                inputType: 'listing',
            });
        }
        return;
    }

    const fileUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapBinary, {
        canSelectMany: false,
        filters: { 'ARM Executable': ['axf', 'elf', 'out'] },
        openLabel: t('AXF/ELF 파일 선택', 'Select AXF/ELF file')
    });
    if (!fileUri || fileUri.length === 0) { return; }

    // If no regions configured, ask for linker script
    let resolvedConfig = config;
    if (!resolvedConfig?.regions || resolvedConfig.regions.length === 0) {
        const linkerChoice = await vscode.window.showQuickPick(
            [
                { label: t('링커 스크립트 선택 (.ld / .sct)', 'Select linker script (.ld / .sct)'), description: t('메모리 영역 자동 감지', 'Auto-detect memory regions') },
                { label: t('건너뛰기', 'Skip'), description: t('섹션 정보만 표시', 'Show sections only') },
            ],
            { placeHolder: t('메모리 영역 크기를 위한 링커 스크립트를 제공하시겠습니까?', 'Provide a linker script for memory region sizes?') }
        );

        if (linkerChoice && linkerChoice.label !== t('건너뛰기', 'Skip')) {
            const linkerUri = await showOpenDialogWithMemory(DIALOG_SCOPE.memoryMapLinkerScript, {
                canSelectMany: false,
                filters: { 'Linker Script': ['ld', 'lds', 'lcf', 'sct'] },
                openLabel: t('링커 스크립트 선택', 'Select Linker Script')
            });
            if (linkerUri && linkerUri.length > 0) {
                try {
                    const content = fs.readFileSync(linkerUri[0].fsPath, 'utf-8');
                    const regions = parseLinkerFile(content, linkerUri[0].fsPath);
                    if (regions.length > 0) {
                        resolvedConfig = { regions };
                    } else {
                        vscode.window.showWarningMessage(t('링커 스크립트에서 MEMORY 영역을 찾을 수 없습니다. 섹션 정보만 표시합니다.', 'No memory regions found in linker script. Showing sections only.'));
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(t(`링커 스크립트 파싱 실패: ${e.message}`, `Failed to parse linker script: ${e.message}`));
                }
            }
        }
    }

    const filePath = fileUri[0].fsPath;
    if (openMemoryMapPanel(context, filePath, resolvedConfig)) {
        recordHistory?.({
            filePath,
            fileName: filePath.split(/[\\/]/).pop() || 'Memory Map',
            inputType: 'elf',
            config: resolvedConfig,
        });
    }
}

export function openMemoryMapPanel(context: vscode.ExtensionContext, filePath: string, config?: MemoryMapConfig): boolean {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`));
        return false;
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}).`
        ));
        return false;
    }

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일 읽기 실패 (${fileName}): ${e.message}`, `Failed to read file (${fileName}): ${e.message}`));
        return false;
    }

    if (buffer.length < 16) {
        vscode.window.showErrorMessage(t(
            `유효한 ELF 파일이 아닙니다 (${fileName}): 파일이 너무 작습니다 (${formatFileSize(buffer.length)}).`,
            `Not a valid ELF file (${fileName}): file is too small (${formatFileSize(buffer.length)}).`
        ));
        return false;
    }

    let parseResult;
    try {
        parseResult = parseElf32(buffer);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`ELF 파싱 실패 (${fileName}): ${e.message}`, `Failed to parse ELF (${fileName}): ${e.message}`));
        return false;
    }

    const { sections, entryPoint, symbols, segments } = parseResult;
    const { flash, ram } = classifySections(sections);
    const sectionSummary = summarizeSections(sections);

    // Auto-detect regions from program headers if no linker script provided
    let regions = config?.regions || [];
    if (regions.length === 0 && segments.length > 0) {
        regions = autoDetectRegions(segments, sections);
    }

    // Use symbol-level detail when symbols available, otherwise section-level
    const memoryUsage = regions.length > 0
        ? (symbols.length > 0
            ? computeSymbolUsage(symbols, sections, regions)
            : computeMemoryUsage(sections, regions))
        : [];
    const flashTotal = flash.reduce((sum, s) => sum + s.size, 0);
    const ramTotal = ram.reduce((sum, s) => sum + s.size, 0);
    const textReport = generateTextReport(fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage);
    const summaryReport = generateSummaryReport(fileName, filePath, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions);
    const hasSymbols = symbols.length > 0;

    showPanel(context, filePath, fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport, summaryReport, hasSymbols);
    return true;
}

export function openMemoryMapFromListing(context: vscode.ExtensionContext, filePath: string): boolean {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`));
        return false;
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}).`
        ));
        return false;
    }

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일 읽기 실패 (${fileName}): ${e.message}`, `Failed to read file (${fileName}): ${e.message}`));
        return false;
    }

    if (content.trim().length === 0) {
        vscode.window.showWarningMessage(t(`Listing 파일이 비어 있습니다: ${fileName}`, `Listing file is empty: ${fileName}`));
        return false;
    }

    let result;
    try {
        result = parseArmLinkList(content);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`Listing 파싱 실패 (${fileName}): ${e.message}`, `Failed to parse listing (${fileName}): ${e.message}`));
        return false;
    }

    if (result.execRegions.length === 0) {
        vscode.window.showWarningMessage(t(
            `Execution Region을 찾을 수 없습니다 (${fileName}). ARM Linker Listing (armlink --list) 출력 파일인지 확인해 주세요.`,
            `No execution regions found (${fileName}). Please verify this is an ARM Linker Listing (armlink --list) output file.`
        ));
        return false;
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

    showPanel(context, filePath, fileName, result.entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport, summaryReport);
    return true;
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
    hasSymbols?: boolean
) {
    const existing = panels.get(filePath);
    let panel: vscode.WebviewPanel;
    if (existing) {
        panel = existing.panel;
        panel.reveal(vscode.ViewColumn.Active);
        existing.messageDisposable?.dispose();
    } else {
        panel = vscode.window.createWebviewPanel(
            'taskhub.memoryMap',
            `Memory Map: ${fileName}`,
            vscode.ViewColumn.Active,
            { enableScripts: true }
        );
        panel.onDidDispose(() => {
            const state = panels.get(filePath);
            state?.messageDisposable?.dispose();
            panels.delete(filePath);
            if (lastActivePanel === filePath) { lastActivePanel = undefined; }
        });
        panel.onDidChangeViewState(() => {
            if (panel.active) { lastActivePanel = filePath; }
        });
    }

    lastActivePanel = filePath;
    const state: PanelState = { panel, symbols: [], messageDisposable: undefined };
    state.messageDisposable = panel.webview.onDidReceiveMessage(async (message: any) => {
        if (message.command === 'copyReport') {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage(t('메모리 맵 리포트가 클립보드에 복사되었습니다.', 'Memory map report copied to clipboard.'));
        } else if (message.command === 'saveHtml') {
            const uri = await showSaveDialogWithMemory(
                DIALOG_SCOPE.memoryMapExport,
                `${fileName.replace(/\.[^.]+$/, '')}_memory_map.html`,
                { filters: { 'HTML': ['html'] }, defaultDir: path.dirname(filePath) }
            );
            if (uri) {
                try {
                    // Remove VS Code API script calls and make standalone
                    let html = typeof message.html === 'string' ? message.html : '';
                    html = html.replace(/const vscode = acquireVsCodeApi\(\);?\s*/g, '');
                    html = html.replace(/vscode\.postMessage\(\{[^}]*\}\);?\s*/g, '');
                    fs.writeFileSync(uri.fsPath, `<!DOCTYPE html>\n${html}`, 'utf-8');
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
    panel.webview.html = getWebviewContent(
        fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport, summaryReport, hasSymbols, panel.webview
    );

    // Store region symbols for Go to Symbol command
    state.symbols = memoryUsage.map(u => {
        const origin = regions.find(r => r.name === u.region)?.origin ?? 0;
        return { name: u.region, addr: origin, type: `${formatSize(u.used)} / ${formatSize(u.total)}` };
    });
    panels.set(filePath, state);
}

export async function goToSymbol() {
    const active = lastActivePanel ? panels.get(lastActivePanel) : undefined;
    if (!active || active.symbols.length === 0) { return; }

    const items = active.symbols.map(s => ({
        label: s.name,
        description: `${formatHex(s.addr)} | ${s.type}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: t('영역으로 이동...', 'Go to region...'),
        matchOnDescription: true,
    });

    if (selected) {
        active.panel.reveal();
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
        searchPlaceholder: t('검색… (오브젝트, 섹션, 함수, 주소, 크기, 타입)', 'Search... (object, section, function, address, size, type)'),
        searchLabel: t('검색', 'Search'),
        searchPrev: t('이전 결과 (Shift+Enter)', 'Previous match (Shift+Enter)'),
        searchNext: t('다음 결과 (Enter)', 'Next match (Enter)'),
        memoryRegions: t('메모리 영역', 'Memory Regions'),
        regionDetails: t('영역 상세', 'Region Details'),
        expandAll: t('모두 펼치기', 'Expand All'),
        collapseAll: t('모두 접기', 'Collapse All'),
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
        // {region}/{percent}/{used}/{total} filled in the webview.
        usageBarLabel: t('{region} 사용률 {percent}% ({used} / {total})', '{region} usage {percent}% ({used} of {total})'),
        sortAscending: t('오름차순 정렬', 'Sort ascending'),
        sortDescending: t('내림차순 정렬', 'Sort descending'),
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
    textReport: string,
    summaryReport: string,
    hasSymbols?: boolean,
    webview?: vscode.Webview
): string {
    const nonce = generateMemoryMapNonce();
    const cspSource = webview?.cspSource ?? 'vscode-webview:';
    const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};`;
    const S = buildMemoryMapStrings();
    const stringsLiteral = JSON.stringify(S).replace(/</g, '\\u003c');
    const htmlLang = vscode.env.language.startsWith('ko') ? 'ko' : 'en';
    // Build JSON data for lazy WebView rendering
    const regionJsonData = memoryUsage.map(u => {
        const pct = u.total > 0 ? (u.used / u.total * 100) : 0;
        const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--ok)';
        const regionOrigin = regions.find(r => r.name === u.region)?.origin ?? 0;

        const allSegments = [
            ...u.sections.map(s => ({ name: s.name, size: s.size, addr: s.addr, type: s.type, section: s.section || '', func: s.func || '' })),
            ...u.freeSpaces.map(f => ({ name: '[FREE]', size: f.size, addr: f.addr, type: 'FREE', section: '', func: '' })),
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
            sz: e.size, ss: formatSize(e.size), t: e.type, fr: e.type === 'FREE'
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
        };
    });

    // Minimal region card HTML (details rendered lazily by JS).
    // Click handlers are attached via delegation in the nonced <script> block below
    // so the CSP does not need to allow inline event attributes.
    const regionCardsHtml = regionJsonData.map((rd: any, idx: number) => `
        <div class="region-card" id="region-${esc(rd.name)}" data-idx="${idx}">
            <div class="region-header" data-action="toggle-region">
                <span class="fold-icon">▶</span>
                <strong>${esc(rd.name)}</strong>
                <span class="region-info">${esc(rd.infoText)}</span>
            </div>
            ${rd.linkerLine ? `<div class="region-linker">${esc(rd.linkerLine)}</div>` : ''}
            <!-- The same numbers are already spelled out in .region-info above,
                 so the bar is decorative: announcing it twice adds nothing. -->
            <div class="bar-bg" aria-hidden="true"><div class="bar-fill" style="width:${Math.min(rd.pct, 100)}%;background:${rd.color}"></div></div>
            <div class="region-detail" style="display:none"></div>
        </div>`).join('');

    const hasRegions = memoryUsage.length > 0;
    const hasLinkerData = memoryUsage.some(u => u.reportedUsed !== undefined);
    const hasFuncData = memoryUsage.some(u => u.sections.some(s => s.func));

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

    const sectionTableRows = sectionSummary.map(s =>
        `<tr>
            <td>${esc(s.name)}</td>
            <td class="num">${formatHex(s.addr)}</td>
            <td class="num">${formatHex(s.size > 0 ? s.endAddr - 1 : s.endAddr)}</td>
            <td class="num">${formatSize(s.size)}</td>
            <td class="num">${s.size}</td>
            <td><span class="type-badge type-${s.type.toLowerCase()}">${s.type}</span></td>
        </tr>`
    ).join('');

    // Inject reports as JSON-encoded JS string literals.
    //   1. JSON.stringify handles all JS escaping (quotes, backslashes,
    //      control chars, line separators) and preserves Unicode losslessly —
    //      avoids the atob() mojibake we previously hit on "—" / "≥".
    //   2. .replace(/</g, '\\u003c') prevents HTML-parser early script
    //      termination if user-controlled input (filename, file path, region
    //      or section names) ever contains "</script>". The JS parser still
    //      decodes < back to "<", but the HTML parser doesn't see it.
    // Accepts any JSON-serializable value (string OR object). Strings come out
    // as JS string literals; objects/arrays as object/array literals. Both end
    // up safely embeddable inside <script>...</script> because every "<" is
    // escaped to "<" — the JS parser still rebuilds the original value,
    // but the HTML parser cannot see "</script>" in the payload.
    const escapeForScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
    const reportJsLiteral = escapeForScript(textReport);
    const summaryJsLiteral = escapeForScript(summaryReport);
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
    h2 { font-size: 16px; margin-bottom: 4px; }
    .header-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 16px;
    }
    .header-left { flex: 1; }
    .subtitle { font-size: 11px; opacity: 0.6; }
    button {
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        padding: 4px 10px;
        cursor: pointer;
        border-radius: 2px;
        font-size: 11px;
    }
    button:hover { background: var(--btn-hover); }
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
    }
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
    tr.current-match td:first-child { box-shadow: inset 3px 0 0 var(--vscode-focusBorder, #007acc); }
    tr.current-match mark.sm-hl { background: var(--vscode-editor-findMatchBackground, #d18616); color: var(--vscode-editor-foreground, inherit); }
    .region-header { cursor: pointer; }
    .region-header:hover { opacity: 0.85; }
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
    .no-regions {
        padding: 12px;
        border: 1px dashed var(--border);
        border-radius: 4px;
        opacity: 0.6;
        font-size: 12px;
        margin-bottom: 16px;
        line-height: 1.6;
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
    .obj-summary-header { font-size: 12px; font-weight: 600; margin-bottom: 4px; cursor: pointer; }
    .obj-summary-header button { font-size: 11px; padding: 4px 10px; }
    .obj-summary-header:hover { opacity: 0.85; }
    .obj-summary-table { margin-bottom: 10px; }
    .vt-viewport { position: relative; }
    .vt-viewport thead th { position: sticky; top: 0; z-index: 1; background: var(--bg); }
    .vt-viewport table { margin-top: 0; }
</style>
</head>
<body>
    <div class="header-row">
        <div class="header-left">
            <h2>${esc(fileName)}</h2>
            <div class="subtitle">${esc(S.entryPoint)}: ${formatHex(entryPoint)}</div>
        </div>
        <button id="btnCopy" title="${esc(S.copyReportTitle)}">${esc(S.copyReport)}</button>
        <span style="width:8px;display:inline-block"></span>
        <button id="btnCopyFull" title="${esc(S.copyFullDumpTitle)}">${esc(S.copyFullDump)}</button>
        <span style="width:8px;display:inline-block"></span>
        <button id="btnSaveHtml" title="${esc(S.saveHtmlTitle)}">${esc(S.saveHtml)}</button>
    </div>

    <div class="search-box">
        <input id="searchInput" type="text" placeholder="${esc(S.searchPlaceholder)}" aria-label="${esc(S.searchLabel)}">
        <span id="searchCount" class="search-count" role="status" aria-live="polite"></span>
        <button id="searchPrev" class="nav-btn" title="${esc(S.searchPrev)}" aria-label="${esc(S.searchPrev)}" disabled>◀</button>
        <button id="searchNext" class="nav-btn" title="${esc(S.searchNext)}" aria-label="${esc(S.searchNext)}" disabled>▶</button>
    </div>

    ${hasRegions ? `
        <div class="section-heading">${esc(S.memoryRegions)}</div>
        <table class="overview-table"><thead><tr>${overviewHeaders}</tr></thead><tbody>${regionOverviewRows}</tbody></table>
        ${!hasLinkerData && !hasSymbols ? `<div class="info-note">${t('AXF/ELF 파일에서는 섹션 단위 정보만 제공됩니다. 오브젝트(.o) 단위 분석 및 Linker 보고값은 ARM Linker Listing 파일을 사용하세요.', 'AXF/ELF files provide section-level information only. Use an ARM Linker Listing file for object-level analysis and linker-reported values.')}</div>` : ''}
        ${hasSymbols ? `<div class="info-note">${t('ELF 심볼 테이블에서 함수/변수 정보를 추출하여 표시합니다. 프로그램 헤더 기반 자동 리전 감지가 적용되었습니다.', 'Function and variable details are extracted from the ELF symbol table. Program-header based automatic region detection was applied.')}</div>` : ''}
        <div class="section-heading">${esc(S.regionDetails)}<span id="regMatchInfo" role="status" aria-live="polite"></span> <button data-action="toggle-all" id="toggleAllBtn" title="${esc(S.expandAll)}" aria-expanded="false">▼ ${esc(S.expandAll)}</button>${hasFuncData ? ` <button data-action="toggle-func-col" title="${esc(S.toggleFunctionColumn)}" aria-label="${esc(S.toggleFunctionColumn)}">Function ▶</button>` : ''}</div>
        ${regionCardsHtml}
    ` : `
        <div class="no-regions">
            ${t('메모리 영역 크기가 설정되지 않았습니다. 사용량 막대를 보려면:', 'Memory region sizes are not configured. To see usage bars:')}<br>
            - ${t('이 명령을 다시 실행하고 링커 스크립트(.ld / .sct)를 선택하세요', 'Run this command again and select a linker script (.ld / .sct)')}<br>
            - ${t('또는', 'Or add')} <code>memoryMap.regions</code> ${t('설정을', 'to')} <code>.vscode/taskhub_types.json</code>${t('에 추가하세요', '')}
        </div>
    `}

    <div class="section-heading">${esc(S.allSections)} (<span id="allSecCount">${sectionSummary.length}</span>)</div>
    <table id="sectionTable" class="sortable-table">
        <thead>
            <tr>
                <th data-sort="name" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colSection)}</th>
                <th class="num" data-sort="addr" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colAddress)}</th>
                <th class="num" data-sort="endAddr" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colEnd)}</th>
                <th class="num" data-sort="size" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colSize)}</th>
                <th class="num" data-sort="bytes" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colBytes)}</th>
                <th data-sort="type" scope="col" tabindex="0" role="columnheader" aria-sort="none">${esc(S.colType)}</th>
            </tr>
        </thead>
        <tbody>${sectionTableRows}</tbody>
    </table>

<button id="scrollTop" class="scroll-top" title="${esc(S.scrollTop)}" aria-label="${esc(S.scrollTop)}">↑</button>

<script nonce="${nonce}">
const RD = ${regionDataJsLiteral};
(function() {
    const vscode = acquireVsCodeApi();
    // Locale-resolved UI labels from the host (buildMemoryMapStrings).
    // Report bodies below stay English by design — they are shared artifacts.
    const S = ${stringsLiteral};
    const report = ${reportJsLiteral};
    const summary = ${summaryJsLiteral};
    const VT_THRESH = 200, ROW_H = 24, BUFFER = 30, MAX_VP_H = 600;
    const rendered = new Set();
    const vtMap = new Map();
    const staticOrig = new WeakMap();   // original innerHTML of static-table rows we've highlighted, for restore
    const secTotal = ${sectionSummary.length};   // total rows in the All Sections table (for the "X / N" heading)
    let funcVis = false, curQ = '', searchAutoFunc = false, funcUserOverride = false;
    // Ordered match list for ◀/▶ navigation. Entries are either { k:'el', el:<tr> }
    // (a live row) or { k:'vt', vi:regionIdx, r:rowIndex } (a row in a virtual
    // table that may not be in the DOM yet — resolved by scrolling the viewport).
    let matchList = [], curMatch = -1, currentMatchEl = null;

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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

    function rowHtml(e, hsi, hfi) {
        const rc = e.fr ? ' class="free-row"' : '';
        const sc = hsi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + hl(e.s) + '</td>' : '';
        const fc = hfi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + hl(e.f) + '</td>' : '';
        return '<tr' + rc + '><td>' + hl(e.n) + '</td>' + sc + fc + '<td class="num">' + hl(e.ah) + '</td><td class="num">' + e.eh + '</td><td class="num">' + hl(e.ss) + '</td><td class="num">' + e.sz + '</td><td><span class="type-badge type-' + e.t.toLowerCase() + '">' + hl(e.t) + '</span></td></tr>';
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
                return '<tr><td>' + esc(o.n) + '</td><td class="num" colspan="2"></td><td class="num"></td><td class="num">' + o.tss + '</td><td class="num">' + o.ts + '</td><td class="num">' + o.p + '%</td><td><div class="mini-bar"><div class="mini-bar-fill" style="width:' + o.bw + '%;background:var(--ok)"></div></div></td></tr>' + dRows;
            }).join('');
            h += '<div class="obj-summary-header" data-action="toggle-obj-summary"><span class="fold-icon">\u25B6</span> Object Summary (' + rd.objSummary.length + ') <button data-action="toggle-obj-detail-rows" title="Toggle section details">Details \u25B6</button></div>';
            h += '<div class="obj-summary-body" style="display:none"><table class="obj-summary-table sortable-table"><thead><tr><th data-sort="name">Object</th><th class="num">Section</th><th class="num">Address</th><th class="num">End</th><th class="num" data-sort="size" data-sort-by="bytes">Size</th><th class="num" data-sort="bytes">Bytes</th><th class="num" data-sort="pct">%</th><th></th></tr></thead><tbody>' + oRows + '</tbody></table></div>';
        }

        // Section table
        if (rd.segments.length > 0) {
            const thHtml = '<tr><th data-sort="name">Object</th>' +
                (rd.hsi ? '<th data-sort="section" class="func-cell' + (funcVis ? '' : ' hidden') + '">Section</th>' : '') +
                (rd.hfi ? '<th data-sort="func" class="func-cell' + (funcVis ? '' : ' hidden') + '">Function</th>' : '') +
                '<th class="num" data-sort="addr">Address</th><th class="num" data-sort="end">End</th><th class="num" data-sort="size" data-sort-by="bytes">Size</th><th class="num" data-sort="bytes">Bytes</th><th data-sort="type">Type</th></tr>';

            if (rd.segments.length > VT_THRESH) {
                const vpH = Math.min(rd.segments.length * ROW_H, MAX_VP_H);
                h += '<div class="vt-viewport" data-ridx="' + idx + '" style="max-height:' + vpH + 'px;overflow-y:auto"><table class="section-table"><thead>' + thHtml + '</thead><tbody></tbody></table></div>';
            } else {
                const data = curQ ? rd.segments.filter(function(e) { return matchSeg(e, curQ); }) : rd.segments;
                h += '<table class="section-table sortable-table"><thead>' + thHtml + '</thead><tbody>' + data.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi); }).join('') + '</tbody></table>';
            }
        }

        detail.innerHTML = h;

        // Initialize virtual table if needed
        if (rd.segments.length > VT_THRESH) {
            initVT(detail.querySelector('.vt-viewport'), idx);
        }

        // Initialize DOM-based sort on obj-summary sortable-tables
        initSort(detail);
    }

    function initVT(vp, idx) {
        const rd = RD[idx];
        const vt = {
            vp: vp, tb: vp.querySelector('tbody'),
            data: rd.segments,
            fd: curQ ? rd.segments.filter(function(e) { return matchSeg(e, curQ); }) : rd.segments,
            cc: 5 + (rd.hsi ? 1 : 0) + (rd.hfi ? 1 : 0),
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
        for (let i = s; i < e; i++) h += rowHtml(vt.fd[i], rd.hsi, rd.hfi);
        if (botH > 0) h += '<tr class="vt-sp"><td colspan="' + vt.cc + '" style="height:' + botH + 'px;padding:0;border:0"></td></tr>';
        vt.tb.innerHTML = h;
    }

    // --- Copy / Save ---
    // Copy Report = curated markdown summary (regions, top sections, highlights).
    // Copy Full Dump = legacy monospace text with every section. Both go through
    // the same message so the extension can show one toast for either.
    document.getElementById('btnCopy').addEventListener('click', function() {
        vscode.postMessage({ command: 'copyReport', text: summary });
    });
    document.getElementById('btnCopyFull').addEventListener('click', function() {
        vscode.postMessage({ command: 'copyReport', text: report });
    });
    document.getElementById('btnSaveHtml').addEventListener('click', function() {
        vscode.postMessage({ command: 'saveHtml', html: document.documentElement.outerHTML });
    });

    // --- Region fold/unfold with lazy rendering ---
    window.toggleRegion = function(header) {
        const card = header.closest('.region-card');
        const detail = card.querySelector('.region-detail');
        const icon = header.querySelector('.fold-icon');
        const idx = parseInt(card.dataset.idx);
        if (detail.style.display === 'none') {
            detail.style.display = '';
            icon.textContent = '\u25BC';
            renderDetail(idx);
        } else {
            detail.style.display = 'none';
            icon.textContent = '\u25B6';
        }
        window.syncToggleAllLabel();
    };

    // --- Toggle-All button label reflects the next action: if any region is
    // expanded, clicking will collapse all; otherwise it will expand all.
    window.syncToggleAllLabel = function() {
        const btn = document.getElementById('toggleAllBtn');
        if (!btn) return;
        let anyExpanded = false;
        document.querySelectorAll('.region-card .region-detail').forEach(function(detail) {
            if (detail.style.display !== 'none') anyExpanded = true;
        });
        if (anyExpanded) {
            btn.textContent = '\u25B6 ' + S.collapseAll;
            btn.setAttribute('title', S.collapseAll);
            btn.setAttribute('aria-expanded', 'true');
        } else {
            btn.textContent = '\u25BC ' + S.expandAll;
            btn.setAttribute('title', S.expandAll);
            btn.setAttribute('aria-expanded', 'false');
        }
    };

    window.toggleAll = function() {
        let anyExpanded = false;
        document.querySelectorAll('.region-card .region-detail').forEach(function(detail) {
            if (detail.style.display !== 'none') anyExpanded = true;
        });
        window.foldAll(anyExpanded);
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
            searchCount.textContent = 'No matches';
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
        if (detail && detail.style.display === 'none') {
            detail.style.display = '';
            const icon = card.querySelector('.fold-icon');
            if (icon) { icon.textContent = '▼'; }
            renderDetail(idx);
            if (window.syncToggleAllLabel) { window.syncToggleAllLabel(); }
        }
    }

    // Reveal match #i: clear the previous current-match, expand its region if
    // collapsed, resolve the target row (scrolling a virtual table's viewport if
    // the row isn't rendered yet), mark it current, and scroll the page to it.
    // force = always center; otherwise only scroll when the row isn't already
    // comfortably on screen.
    function revealMatch(i, force) {
        if (currentMatchEl) { currentMatchEl.classList.remove('current-match'); currentMatchEl = null; }
        const m = matchList[i];
        if (!m) { updateNavUI(); return; }
        let el;
        if (m.k === 'el') {
            el = m.el;
            const rc = el && el.closest && el.closest('.region-card');
            if (rc && rc.dataset && rc.dataset.idx) { ensureRegionExpanded(parseInt(rc.dataset.idx)); }
        } else {
            ensureRegionExpanded(m.vi);   // expand first so the viewport has a real clientHeight
            const vt = vtMap.get(m.vi);
            if (!vt) { updateNavUI(); return; }
            const maxTop = Math.max(0, vt.fd.length * ROW_H - vt.vp.clientHeight);
            vt.vp.scrollTop = Math.min(maxTop, Math.max(0, (m.r + 0.5) * ROW_H - vt.vp.clientHeight / 2));
            vt.ls = -1;
            renderVT(vt);
            el = vt.tb.querySelectorAll('tr:not(.vt-sp)')[m.r - vt.ls];
        }
        if (!el) { updateNavUI(); return; }
        el.classList.add('current-match');
        currentMatchEl = el;
        if (m.k === 'el') {
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

    // Re-sync match navigation after a column sort reordered (or, for virtual
    // tables, re-rendered) rows behind matchList's back: stale <tr> references
    // and wrong document order would make ◀/▶ jump to the wrong place. Mirrors
    // the tail of doSearch — rebuild, jump to the first match, refresh the count.
    function resyncAfterReflow() {
        if (!curQ) { return; }
        document.querySelectorAll('.current-match').forEach(function(el) { el.classList.remove('current-match'); });
        currentMatchEl = null;
        rebuildMatchList(curQ);
        curMatch = matchList.length > 0 ? 0 : -1;
        updateNavUI();
        if (curMatch === 0) { revealMatch(0, false); }
    }

    function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        curQ = q;
        let mr = 0;   // regions containing a match

        // Drop any stale current-match emphasis; matchList is rebuilt below.
        document.querySelectorAll('.current-match').forEach(function(el) { el.classList.remove('current-match'); });
        currentMatchEl = null;

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
                    tbody.innerHTML = filtered.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi); }).join('');
                }
            }

            // Auto-expand matching regions
            if (q && rm > 0) {
                mr++;
                const detail = card.querySelector('.region-detail');
                const icon = card.querySelector('.fold-icon');
                if (detail && detail.style.display === 'none') {
                    detail.style.display = '';
                    if (icon) icon.textContent = '\u25BC';
                    renderDetail(idx);
                }
            }
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
            regMatchInfo.textContent = q ? (' — ' + mr + (mr === 1 ? ' region' : ' regions') + ' matched') : '';
        }

        // Rebuild the navigable match list and jump to the first match.
        rebuildMatchList(q);
        curMatch = matchList.length > 0 ? 0 : -1;
        updateNavUI();
        if (curMatch === 0) { revealMatch(0, false); }
    }

    // --- Expand All / Collapse All ---
    window.foldAll = function(collapse) {
        document.querySelectorAll('.region-card').forEach(function(card) {
            const detail = card.querySelector('.region-detail');
            const icon = card.querySelector('.fold-icon');
            const idx = parseInt(card.dataset.idx);
            if (detail) {
                if (collapse) {
                    detail.style.display = 'none';
                } else {
                    detail.style.display = '';
                    renderDetail(idx);
                }
            }
            if (icon) icon.textContent = collapse ? '\u25B6' : '\u25BC';
        });
    };

    // --- Overview row click -> scroll to region card ---
    document.querySelectorAll('.overview-row').forEach(function(row) {
        row.addEventListener('click', function() {
            const name = row.getAttribute('data-region');
            const card = document.getElementById('region-' + name);
            if (!card) return;
            const detail = card.querySelector('.region-detail');
            const icon = card.querySelector('.fold-icon');
            const idx = parseInt(card.dataset.idx);
            if (detail && detail.style.display === 'none') {
                detail.style.display = '';
                if (icon) icon.textContent = '\u25BC';
                renderDetail(idx);
                if (window.syncToggleAllLabel) window.syncToggleAllLabel();
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.style.outline = '2px solid var(--vscode-focusBorder, #007acc)';
            setTimeout(function() { card.style.outline = ''; }, 2500);
        });
    });

    // --- Scroll to region (from extension Ctrl+Shift+O command) ---
    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg.command === 'scrollToRegion') {
            const cards = document.querySelectorAll('.region-card');
            for (const card of cards) {
                const strong = card.querySelector('.region-header strong');
                if (strong && strong.textContent.trim() === msg.name) {
                    const detail = card.querySelector('.region-detail');
                    const icon = card.querySelector('.fold-icon');
                    const idx = parseInt(card.dataset.idx);
                    if (detail && detail.style.display === 'none') {
                        detail.style.display = '';
                        if (icon) icon.textContent = '\u25BC';
                        renderDetail(idx);
                        if (window.syncToggleAllLabel) window.syncToggleAllLabel();
                    }
                    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    card.style.outline = '2px solid var(--vscode-focusBorder, #007acc)';
                    setTimeout(function() { card.style.outline = ''; }, 2500);
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
                    const rows = Array.from(tbody.querySelectorAll('tr:not(.obj-detail-row)'));
                    const sortByCol = th.dataset.sortBy || col;
                    const allThs = Array.from(th.parentElement.children);
                    const targetTh = allThs.find(function(h) { return h.dataset && h.dataset.sort === sortByCol; }) || th;
                    const valIdx = allThs.indexOf(targetTh);
                    rows.sort(function(a, b) {
                        if (valIdx >= a.children.length || valIdx >= b.children.length) return 0;
                        const aT = a.children[valIdx].textContent.trim();
                        const bT = b.children[valIdx].textContent.trim();
                        const aN = parseFloat(aT.replace(/[^0-9.\-]/g, ''));
                        const bN = parseFloat(bT.replace(/[^0-9.\-]/g, ''));
                        if (!isNaN(aN) && !isNaN(bN)) return sortAsc ? aN - bN : bN - aN;
                        return sortAsc ? aT.localeCompare(bT) : bT.localeCompare(aT);
                    });
                    rows.forEach(function(row) { tbody.appendChild(row); });
                    ths.forEach(function(h) {
                        h.textContent = h.textContent.replace(/ [\u25B2\u25BC]$/, '');
                        // aria-sort is what a screen reader announces; the
                        // \u25B2/\u25BC glyph alone conveys nothing to it.
                        h.setAttribute('aria-sort', 'none');
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
        if (!th || th.closest('.sortable-table')) return;

        const card = th.closest('.region-card');
        const idx = parseInt(card.dataset.idx);
        const rd = RD[idx];
        const sortByCol = th.dataset.sortBy || th.dataset.sort;

        if (th._lastCol === sortByCol) { th._sortAsc = !th._sortAsc; }
        else { th._lastCol = sortByCol; th._sortAsc = !(['size','bytes'].includes(sortByCol)); }
        const asc = th._sortAsc;

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
            vt.vp.scrollTop = 0;
            vt.ls = -1;
            renderVT(vt);
        } else {
            const tbody = card.querySelector('.section-table tbody');
            if (tbody) {
                const data = curQ ? rd.segments.filter(function(seg) { return matchSeg(seg, curQ); }) : rd.segments;
                tbody.innerHTML = data.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi); }).join('');
            }
        }

        const ths = th.parentElement.querySelectorAll('th[data-sort]');
        ths.forEach(function(h) { h.textContent = h.textContent.replace(/ [\u25B2\u25BC]$/, ''); });
        th.textContent += asc ? ' \u25B2' : ' \u25BC';
        resyncAfterReflow();   // a region section table feeds matchList; resync nav after re-render
    });

    // Initialize sort on static tables (overview, all-sections)
    initSort(document);

    // --- Toggle Function column ---
    function syncFuncBtn() {
        const fb = document.querySelector('[data-action="toggle-func-col"]');
        if (fb) { fb.textContent = funcVis ? 'Function ▼' : 'Function ▶'; }
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

    // --- Toggle Object Summary fold ---
    window.toggleObjSummary = function(header) {
        const body = header.nextElementSibling;
        const icon = header.querySelector('.fold-icon');
        if (body && body.classList.contains('obj-summary-body')) {
            if (body.style.display === 'none') {
                body.style.display = '';
                if (icon) { icon.textContent = '\u25BC'; }
            } else {
                body.style.display = 'none';
                if (icon) { icon.textContent = '\u25B6'; }
            }
        }
    };

    // --- Toggle detail rows in per-region object summary ---
    window.toggleObjDetailRows = function(btn) {
        const body = btn.closest('.obj-summary-header')?.nextElementSibling;
        if (!body) { return; }
        const rows = body.querySelectorAll('.obj-detail-row');
        const isHidden = rows.length > 0 && getComputedStyle(rows[0]).display === 'none';
        rows.forEach(function(el) { el.style.display = isHidden ? 'table-row' : 'none'; });
    };

    // --- Scroll to top button ---
    const scrollBtn = document.getElementById('scrollTop');
    window.addEventListener('scroll', function() {
        scrollBtn.classList.toggle('visible', window.scrollY > 200);
    });
    scrollBtn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // --- Delegated click handlers (replaces inline onclick for CSP compliance) ---
    document.addEventListener('click', function(ev) {
        const target = ev.target;
        if (!target || target.nodeType !== 1) { return; }
        const actionEl = target.closest('[data-action]');
        if (!actionEl) { return; }
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
                ev.stopPropagation();
                window.toggleObjDetailRows(actionEl);
                break;
        }
    });
})();
</script>
</body>
</html>`;
}

function esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
