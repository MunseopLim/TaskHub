import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseElf32, classifySections, computeMemoryUsage, computeSymbolUsage, autoDetectRegions, summarizeSections, generateTextReport, formatSize, formatHex, MemoryRegion, MemoryUsage, ElfSection, SectionSummary } from './elfParser';
import { parseLinkerFile } from './linkerScriptParser';
import { parseArmLinkList, toMemoryRegions, toElfSections, toAggregatedSummary, toMemoryUsage } from './armLinkListParser';
import { t } from './i18n';

let currentPanel: vscode.WebviewPanel | undefined;
let currentSymbols: { name: string; addr: number; type: string }[] = [];
let currentMessageDisposable: vscode.Disposable | undefined;

/** Memory Map에서 처리 가능한 최대 ELF/Listing 파일 크기 (100 MB) */
const MEMORY_MAP_MAX_FILE_SIZE = 100 * 1024 * 1024;

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface MemoryMapConfig {
    regions?: MemoryRegion[];
}

export async function showMemoryMap(context: vscode.ExtensionContext, config?: MemoryMapConfig) {
    const inputType = await vscode.window.showQuickPick([
        { label: t('AXF/ELF 파일', 'AXF/ELF File'), description: t('ARM 실행 바이너리 파싱', 'Parse ARM executable binary') },
        { label: 'ARM Linker Listing', description: t('armlink --list 출력 파일 파싱', 'Parse armlink --list output file') },
    ], { placeHolder: t('입력 파일 형식 선택', 'Select input file format') });
    if (!inputType) { return; }

    if (inputType.label === 'ARM Linker Listing') {
        const listUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'ARM Linker Listing': ['txt'] },
            openLabel: 'Select Linker Listing'
        });
        if (!listUri || listUri.length === 0) { return; }
        openMemoryMapFromListing(context, listUri[0].fsPath);
        return;
    }

    const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'ARM Executable': ['axf', 'elf', 'out'] },
        openLabel: 'Select AXF/ELF file'
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
            const linkerUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Linker Script': ['ld', 'lds', 'lcf', 'sct'] },
                openLabel: 'Select Linker Script'
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

    openMemoryMapPanel(context, fileUri[0].fsPath, resolvedConfig);
}

export function openMemoryMapPanel(context: vscode.ExtensionContext, filePath: string, config?: MemoryMapConfig) {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`));
        return;
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}).`
        ));
        return;
    }

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일 읽기 실패 (${fileName}): ${e.message}`, `Failed to read file (${fileName}): ${e.message}`));
        return;
    }

    if (buffer.length < 16) {
        vscode.window.showErrorMessage(t(
            `유효한 ELF 파일이 아닙니다 (${fileName}): 파일이 너무 작습니다 (${formatFileSize(buffer.length)}).`,
            `Not a valid ELF file (${fileName}): file is too small (${formatFileSize(buffer.length)}).`
        ));
        return;
    }

    let parseResult;
    try {
        parseResult = parseElf32(buffer);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`ELF 파싱 실패 (${fileName}): ${e.message}`, `Failed to parse ELF (${fileName}): ${e.message}`));
        return;
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
    const hasSymbols = symbols.length > 0;

    showPanel(context, fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport, hasSymbols);
}

function openMemoryMapFromListing(context: vscode.ExtensionContext, filePath: string) {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`));
        return;
    }

    if (stat.size > MEMORY_MAP_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 Memory Map 처리 한도(${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)})를 초과합니다.`,
            `File size (${formatFileSize(stat.size)}) exceeds the Memory Map limit (${formatFileSize(MEMORY_MAP_MAX_FILE_SIZE)}).`
        ));
        return;
    }

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일 읽기 실패 (${fileName}): ${e.message}`, `Failed to read file (${fileName}): ${e.message}`));
        return;
    }

    if (content.trim().length === 0) {
        vscode.window.showWarningMessage(t(`Listing 파일이 비어 있습니다: ${fileName}`, `Listing file is empty: ${fileName}`));
        return;
    }

    let result;
    try {
        result = parseArmLinkList(content);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`Listing 파싱 실패 (${fileName}): ${e.message}`, `Failed to parse listing (${fileName}): ${e.message}`));
        return;
    }

    if (result.execRegions.length === 0) {
        vscode.window.showWarningMessage(t(
            `Execution Region을 찾을 수 없습니다 (${fileName}). ARM Linker Listing (armlink --list) 출력 파일인지 확인해 주세요.`,
            `No execution regions found (${fileName}). Please verify this is an ARM Linker Listing (armlink --list) output file.`
        ));
        return;
    }

    const sections = toElfSections(result);
    const regions = toMemoryRegions(result);
    const { flash, ram } = classifySections(sections);
    const sectionSummary = toAggregatedSummary(result);
    const memoryUsage = toMemoryUsage(result);
    const flashTotal = flash.reduce((sum, s) => sum + s.size, 0);
    const ramTotal = ram.reduce((sum, s) => sum + s.size, 0);
    const textReport = generateTextReport(fileName, result.entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage);

    showPanel(context, fileName, result.entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport);
}

function showPanel(
    context: vscode.ExtensionContext,
    fileName: string,
    entryPoint: number,
    flashTotal: number,
    ramTotal: number,
    sectionSummary: SectionSummary[],
    memoryUsage: MemoryUsage[],
    regions: MemoryRegion[],
    textReport: string,
    hasSymbols?: boolean
) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'taskhub.memoryMap',
            `Memory Map: ${fileName}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        currentPanel.onDidDispose(() => { currentPanel = undefined; currentSymbols = []; currentMessageDisposable?.dispose(); currentMessageDisposable = undefined; });
    }

    currentMessageDisposable?.dispose();
    currentMessageDisposable = currentPanel.webview.onDidReceiveMessage(async message => {
        if (message.command === 'copyReport') {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage(t('메모리 맵 리포트가 클립보드에 복사되었습니다.', 'Memory map report copied to clipboard.'));
        } else if (message.command === 'saveHtml') {
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`${fileName.replace(/\.[^.]+$/, '')}_memory_map.html`),
                filters: { 'HTML': ['html'] },
            });
            if (uri) {
                // Remove VS Code API script calls and make standalone
                let html = message.html as string;
                html = html.replace(/const vscode = acquireVsCodeApi\(\);?\s*/g, '');
                html = html.replace(/vscode\.postMessage\(\{[^}]*\}\);?\s*/g, '');
                fs.writeFileSync(uri.fsPath, `<!DOCTYPE html>\n${html}`, 'utf-8');
                vscode.window.showInformationMessage(t('HTML 파일이 저장되었습니다.', 'HTML file saved.'));
            }
        }
    });

    currentPanel.title = `Memory Map: ${fileName}`;
    currentPanel.webview.html = getWebviewContent(
        fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport, hasSymbols
    );

    // Store region symbols for Go to Symbol command
    currentSymbols = memoryUsage.map(u => {
        const origin = regions.find(r => r.name === u.region)?.origin ?? 0;
        return { name: u.region, addr: origin, type: `${formatSize(u.used)} / ${formatSize(u.total)}` };
    });
}

export async function goToSymbol() {
    if (!currentPanel || currentSymbols.length === 0) { return; }

    const items = currentSymbols.map(s => ({
        label: s.name,
        description: `${formatHex(s.addr)} | ${s.type}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: t('영역으로 이동...', 'Go to region...'),
        matchOnDescription: true,
    });

    if (selected) {
        currentPanel.reveal();
        currentPanel.webview.postMessage({
            command: 'scrollToRegion',
            name: selected.label,
        });
    }
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
    hasSymbols?: boolean
): string {
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
            infoText: `Used: ${formatSize(u.used)} / ${formatSize(u.total)} (${pct.toFixed(1)}%) | Free: ${formatSize(calcFree)}`,
            linkerLine: u.reportedUsed !== undefined
                ? `Linker: Base=${formatHex(regionOrigin)} Used=${formatHex(u.reportedUsed)} (${formatSize(u.reportedUsed)}) Max=${formatHex(u.total)} (${formatSize(u.total)}) Free: ${formatSize(linkerFree)}`
                : '',
            segments, objSummary,
            hsi: hasSectionInfo, hfi: hasFuncInfo, hmo: regionObjSummary.length > 1,
        };
    });

    // Minimal region card HTML (details rendered lazily by JS)
    const regionCardsHtml = regionJsonData.map((rd: any, idx: number) => `
        <div class="region-card" id="region-${esc(rd.name)}" data-idx="${idx}">
            <div class="region-header" onclick="toggleRegion(this)">
                <span class="fold-icon">▶</span>
                <strong>${esc(rd.name)}</strong>
                <span class="region-info">${esc(rd.infoText)}</span>
            </div>
            ${rd.linkerLine ? `<div class="region-linker">${esc(rd.linkerLine)}</div>` : ''}
            <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(rd.pct, 100)}%;background:${rd.color}"></div></div>
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
            <td><div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div></td>
        </tr>`;
    }).join('');

    const overviewHeaders = hasLinkerData
        ? '<th>Region</th><th class="num">Base</th><th class="num">Max</th><th class="num">Linker Used</th><th class="num">Calc Used</th><th class="num">Linker Free</th><th class="num">Calc Free</th><th class="num">Usage</th><th></th>'
        : '<th>Region</th><th class="num">Base</th><th class="num">Max</th><th class="num">Used</th><th class="num">Free</th><th class="num">Usage</th><th></th>';

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

    const reportBase64 = Buffer.from(textReport, 'utf-8').toString('base64');

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
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
    .search-count { font-size: 11px; opacity: 0.6; white-space: nowrap; }
    .search-match { background: rgba(255, 213, 0, 0.15) !important; }
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
            <div class="subtitle">Entry Point: ${formatHex(entryPoint)}</div>
        </div>
        <button id="btnCopy" title="Copy as text report">Copy Report</button>
        <span style="width:8px;display:inline-block"></span>
        <button id="btnSaveHtml" title="Save as HTML file">Save HTML</button>
    </div>

    <div class="search-box">
        <input id="searchInput" type="text" placeholder="Search sections... (name, address, type)">
        <span id="searchCount" class="search-count"></span>
    </div>

    ${hasRegions ? `
        <div class="section-heading">Memory Regions</div>
        <table class="overview-table"><thead><tr>${overviewHeaders}</tr></thead><tbody>${regionOverviewRows}</tbody></table>
        ${!hasLinkerData && !hasSymbols ? '<div class="info-note">AXF/ELF 파일에서는 섹션 단위 정보만 제공됩니다. 오브젝트(.o) 단위 분석 및 Linker 보고값은 ARM Linker Listing 파일을 사용하세요.</div>' : ''}
        ${hasSymbols ? '<div class="info-note">ELF 심볼 테이블에서 함수/변수 정보를 추출하여 표시합니다. 프로그램 헤더 기반 자동 리전 감지가 적용되었습니다.</div>' : ''}
        <div class="section-heading">Region Details <button onclick="foldAll(false)" title="Expand All">▼ Expand All</button> <button onclick="foldAll(true)" title="Collapse All">▶ Collapse All</button>${hasFuncData ? ' <button onclick="toggleFuncCol()" title="Toggle Function column">Function ▶</button>' : ''}</div>
        ${regionCardsHtml}
    ` : `
        <div class="no-regions">
            Memory region sizes not configured. To see usage bars, either:<br>
            - Run this command again and select a linker script (.ld / .sct)<br>
            - Or add <code>memoryMap.regions</code> to <code>.vscode/taskhub_types.json</code>
        </div>
    `}

    <div class="section-heading">All Sections (${sectionSummary.length})</div>
    <table id="sectionTable" class="sortable-table">
        <thead>
            <tr>
                <th data-sort="name">Section</th>
                <th class="num" data-sort="addr">Address</th>
                <th class="num" data-sort="endAddr">End</th>
                <th class="num" data-sort="size">Size</th>
                <th class="num" data-sort="bytes">Bytes</th>
                <th data-sort="type">Type</th>
            </tr>
        </thead>
        <tbody>${sectionTableRows}</tbody>
    </table>

<button id="scrollTop" class="scroll-top" title="맨 위로">↑</button>

<script>
const RD = ${JSON.stringify(regionJsonData)};
(function() {
    const vscode = acquireVsCodeApi();
    const report = atob('${reportBase64}');
    const VT_THRESH = 200, ROW_H = 24, BUFFER = 30, MAX_VP_H = 600;
    const rendered = new Set();
    const vtMap = new Map();
    let funcVis = false, curQ = '';

    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function rowHtml(e, hsi, hfi) {
        const rc = e.fr ? ' class="free-row"' : '';
        const sc = hsi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + esc(e.s) + '</td>' : '';
        const fc = hfi ? '<td class="func-cell' + (funcVis ? '' : ' hidden') + '">' + esc(e.f) + '</td>' : '';
        return '<tr' + rc + '><td>' + esc(e.n) + '</td>' + sc + fc + '<td class="num">' + e.ah + '</td><td class="num">' + e.eh + '</td><td class="num">' + e.ss + '</td><td class="num">' + e.sz + '</td><td><span class="type-badge type-' + e.t.toLowerCase() + '">' + e.t + '</span></td></tr>';
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
            h += '<div class="obj-summary-header" onclick="toggleObjSummary(this)"><span class="fold-icon">\u25B6</span> Object Summary (' + rd.objSummary.length + ') <button onclick="event.stopPropagation();toggleObjDetailRows(this)" title="Toggle section details">Details \u25B6</button></div>';
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
    document.getElementById('btnCopy').addEventListener('click', function() {
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
    };

    // --- Keyword search (data-driven for regions, DOM for static tables) ---
    const searchInput = document.getElementById('searchInput');
    const searchCount = document.getElementById('searchCount');
    let searchTimeout;

    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(doSearch, 200);
    });

    function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        curQ = q;
        let mc = 0;

        RD.forEach(function(rd, idx) {
            const card = document.querySelector('.region-card[data-idx="' + idx + '"]');
            let rm = 0;

            if (q) {
                rd.segments.forEach(function(seg) { if (matchSeg(seg, q)) rm++; });
                mc += rm;
            }

            // Update virtual tables
            const vt = vtMap.get(idx);
            if (vt) {
                vt.fd = q ? vt.data.filter(function(e) { return matchSeg(e, q); }) : vt.data;
                vt.vp.scrollTop = 0;
                vt.ls = -1;
                renderVT(vt);
            } else if (rendered.has(idx)) {
                // Non-virtual rendered table: re-render tbody from data
                const tbody = card.querySelector('.section-table tbody');
                if (tbody) {
                    const data = q ? rd.segments.filter(function(e) { return matchSeg(e, q); }) : rd.segments;
                    tbody.innerHTML = data.map(function(e) { return rowHtml(e, rd.hsi, rd.hfi); }).join('');
                }
            }

            // Auto-expand matching regions
            if (q && rm > 0) {
                const detail = card.querySelector('.region-detail');
                const icon = card.querySelector('.fold-icon');
                if (detail && detail.style.display === 'none') {
                    detail.style.display = '';
                    if (icon) icon.textContent = '\u25BC';
                    renderDetail(idx);
                }
            }
        });

        // Static tables (overview, all-sections)
        document.querySelectorAll('#sectionTable tbody tr, .overview-table tbody tr').forEach(function(row) {
            row.classList.remove('search-match');
            if (!q) { row.style.display = ''; return; }
            const text = row.textContent.toLowerCase();
            if (text.includes(q)) {
                row.style.display = '';
                row.classList.add('search-match');
                mc++;
            } else {
                row.style.display = 'none';
            }
        });

        searchCount.textContent = q ? mc + ' matches' : '';
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
                    ths.forEach(function(h) { h.textContent = h.textContent.replace(/ [\u25B2\u25BC]$/, ''); });
                    th.textContent += sortAsc ? ' \u25B2' : ' \u25BC';
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
    });

    // Initialize sort on static tables (overview, all-sections)
    initSort(document);

    // --- Toggle Function column ---
    window.toggleFuncCol = function() {
        funcVis = !funcVis;
        document.querySelectorAll('.func-cell').forEach(function(el) {
            el.classList.toggle('hidden', !funcVis);
        });
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
})();
</script>
</body>
</html>`;
}

function esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
