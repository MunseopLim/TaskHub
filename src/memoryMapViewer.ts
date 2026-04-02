import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseElf32, classifySections, computeMemoryUsage, summarizeSections, generateTextReport, formatSize, formatHex, MemoryRegion, MemoryUsage, ElfSection, SectionSummary } from './elfParser';
import { parseLinkerFile } from './linkerScriptParser';
import { parseArmLinkList, toMemoryRegions, toElfSections, toAggregatedSummary, toMemoryUsage } from './armLinkListParser';

let currentPanel: vscode.WebviewPanel | undefined;
let currentSymbols: { name: string; addr: number; type: string }[] = [];

export interface MemoryMapConfig {
    regions?: MemoryRegion[];
}

export async function showMemoryMap(context: vscode.ExtensionContext, config?: MemoryMapConfig) {
    const inputType = await vscode.window.showQuickPick([
        { label: 'AXF/ELF 파일', description: 'ARM 실행 바이너리 파싱' },
        { label: 'ARM Linker Listing', description: 'armlink --list 출력 파일 파싱' },
    ], { placeHolder: '입력 파일 형식 선택' });
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
                { label: 'Select linker script (.ld / .sct)', description: 'Auto-detect memory regions' },
                { label: 'Skip', description: 'Show sections only' },
            ],
            { placeHolder: 'Provide a linker script for memory region sizes?' }
        );

        if (linkerChoice && linkerChoice.label !== 'Skip') {
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
                        vscode.window.showWarningMessage('No memory regions found in linker script. Showing sections only.');
                    }
                } catch (e: any) {
                    vscode.window.showWarningMessage(`Failed to parse linker script: ${e.message}`);
                }
            }
        }
    }

    openMemoryMapPanel(context, fileUri[0].fsPath, resolvedConfig);
}

export function openMemoryMapPanel(context: vscode.ExtensionContext, filePath: string, config?: MemoryMapConfig) {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to read file: ${e.message}`);
        return;
    }

    let parseResult;
    try {
        parseResult = parseElf32(buffer);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to parse ELF: ${e.message}`);
        return;
    }

    const { sections, entryPoint } = parseResult;
    const { flash, ram } = classifySections(sections);
    const sectionSummary = summarizeSections(sections);
    const regions = config?.regions || [];
    const memoryUsage = regions.length > 0 ? computeMemoryUsage(sections, regions) : [];
    const flashTotal = flash.reduce((sum, s) => sum + s.size, 0);
    const ramTotal = ram.reduce((sum, s) => sum + s.size, 0);
    const textReport = generateTextReport(fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage);

    showPanel(context, fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport);
}

function openMemoryMapFromListing(context: vscode.ExtensionContext, filePath: string) {
    const fileName = filePath.split(/[\\/]/).pop() || 'Memory Map';

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to read file: ${e.message}`);
        return;
    }

    let result;
    try {
        result = parseArmLinkList(content);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to parse listing: ${e.message}`);
        return;
    }

    if (result.execRegions.length === 0) {
        vscode.window.showWarningMessage('No execution regions found in listing file.');
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
    textReport: string
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
        currentPanel.onDidDispose(() => { currentPanel = undefined; currentSymbols = []; });
    }

    currentPanel.webview.onDidReceiveMessage(message => {
        if (message.command === 'copyReport') {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('Memory map report copied to clipboard.');
        }
    }, undefined, context.subscriptions);

    currentPanel.title = `Memory Map: ${fileName}`;
    currentPanel.webview.html = getWebviewContent(
        fileName, entryPoint, flashTotal, ramTotal, sectionSummary, memoryUsage, regions, textReport
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
        placeHolder: 'Go to region...',
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
    textReport: string
): string {
    const usageBarsHtml = memoryUsage.map(u => {
        const pct = u.total > 0 ? (u.used / u.total * 100) : 0;
        const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warn)' : 'var(--ok)';
        const freeTotal = u.total - u.used;
        const regionOrigin = regions.find(r => r.name === u.region)?.origin ?? 0;

        // Segmented memory layout bar (address-ordered)
        const allSegments = [
            ...u.sections.map(s => ({ name: s.name, size: s.size, addr: s.addr, type: s.type })),
            ...u.freeSpaces.map(f => ({ name: '[FREE]', size: f.size, addr: f.addr, type: 'FREE' })),
        ].sort((a, b) => a.addr - b.addr);

        const mapSegHtml = allSegments
            .filter(e => e.size > 0)
            .map(e => {
                const cls = `seg-${e.type.toLowerCase()}`;
                return `<div class="map-seg ${cls}" style="flex:${e.size}" title="${esc(e.name)} @ ${formatHex(e.addr)} (${formatSize(e.size)})"></div>`;
            }).join('');

        // Table rows (address-ordered, sections + free spaces)
        const tableRows = allSegments
            .filter(e => e.size > 0)
            .map(e => {
                const rowCls = e.type === 'FREE' ? ' class="free-row"' : '';
                return `<tr${rowCls}><td>${esc(e.name)}</td><td class="num">${formatHex(e.addr)}</td><td class="num">${formatSize(e.size)}</td><td class="num">${String(e.size)}</td><td><span class="type-badge type-${e.type.toLowerCase()}">${e.type}</span></td></tr>`;
            }).join('');

        const linkerFree = u.reportedUsed !== undefined ? u.total - u.reportedUsed : 0;
        const calcFree = u.freeSpaces.reduce((sum, f) => sum + f.size, 0);
        const linkerLine = u.reportedUsed !== undefined
            ? `<div class="region-linker">Linker: Base=${formatHex(regionOrigin)} Used=${formatHex(u.reportedUsed)} (${formatSize(u.reportedUsed)}) Max=${formatHex(u.total)} (${formatSize(u.total)}) Free: ${formatSize(linkerFree)}</div>`
            : '';
        const infoText = `Used: ${formatSize(u.used)} / ${formatSize(u.total)} (${pct.toFixed(1)}%) | Free: ${formatSize(calcFree)}`;

        return `
        <div class="region-card" id="region-${esc(u.region)}">
            <div class="region-header" onclick="toggleRegion(this)">
                <span class="fold-icon">▶</span>
                <strong>${esc(u.region)}</strong>
                <span class="region-info">${infoText}</span>
            </div>
            ${linkerLine}
            <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
            <div class="region-detail" style="display:none">
                ${allSegments.length > 0 ? `<div class="map-bar">${mapSegHtml}</div>` : ''}
                ${allSegments.length > 0 ? `<table class="section-table sortable-table"><thead><tr><th data-sort="name">Section</th><th class="num" data-sort="addr">Address</th><th class="num" data-sort="size">Size</th><th class="num" data-sort="bytes">Bytes</th><th data-sort="type">Type</th></tr></thead><tbody>${tableRows}</tbody></table>` : ''}
            </div>
        </div>`;
    }).join('');

    const hasRegions = memoryUsage.length > 0;

    const hasLinkerData = memoryUsage.some(u => u.reportedUsed !== undefined);

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
            <td class="num">${formatHex(s.endAddr)}</td>
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
        height: 14px;
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
        background: var(--hover-bg);
    }
    .map-seg {
        height: 100%;
        min-width: 1px;
        border-right: 1px solid var(--bg);
    }
    .map-seg:last-child { border-right: none; }
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
</style>
</head>
<body>
    <div class="header-row">
        <div class="header-left">
            <h2>${esc(fileName)}</h2>
            <div class="subtitle">Entry Point: ${formatHex(entryPoint)}</div>
        </div>
        <button id="btnCopy" title="Copy as text report">Copy Report</button>
    </div>

    <div class="search-box">
        <input id="searchInput" type="text" placeholder="Search sections... (name, address, type)">
        <span id="searchCount" class="search-count"></span>
    </div>

    ${hasRegions ? `
        <div class="section-heading">Memory Regions</div>
        <table class="overview-table"><thead><tr>${overviewHeaders}</tr></thead><tbody>${regionOverviewRows}</tbody></table>
        ${!hasLinkerData ? '<div class="info-note">AXF/ELF 파일에서는 섹션 단위 정보만 제공됩니다. 오브젝트(.o) 단위 분석 및 Linker 보고값은 ARM Linker Listing 파일을 사용하세요.</div>' : ''}
        <div class="section-heading">Region Details <button onclick="foldAll(false)" title="Expand All">▼ Expand All</button> <button onclick="foldAll(true)" title="Collapse All">▶ Collapse All</button></div>
        ${usageBarsHtml}
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

<script>
(function() {
    const vscode = acquireVsCodeApi();
    const report = atob('${reportBase64}');

    document.getElementById('btnCopy').addEventListener('click', () => {
        vscode.postMessage({ command: 'copyReport', text: report });
    });

    // --- Region fold/unfold ---
    window.toggleRegion = function(header) {
        const card = header.closest('.region-card');
        const detail = card.querySelector('.region-detail');
        const icon = header.querySelector('.fold-icon');
        if (detail.style.display === 'none') {
            detail.style.display = '';
            icon.textContent = '▼';
        } else {
            detail.style.display = 'none';
            icon.textContent = '▶';
        }
    };

    // --- Keyword search ---
    const searchInput = document.getElementById('searchInput');
    const searchCount = document.getElementById('searchCount');
    let searchTimeout;

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(doSearch, 200);
    });

    function doSearch() {
        const query = searchInput.value.trim().toLowerCase();
        let matchCount = 0;

        document.querySelectorAll('tbody tr').forEach(row => {
            row.classList.remove('search-match');
            if (!query) {
                row.style.display = '';
                return;
            }
            const text = row.textContent.toLowerCase();
            if (text.includes(query)) {
                row.style.display = '';
                row.classList.add('search-match');
                matchCount++;
                // Auto-expand collapsed parent region
                const regionCard = row.closest('.region-card');
                if (regionCard) {
                    const detail = regionCard.querySelector('.region-detail');
                    const icon = regionCard.querySelector('.fold-icon');
                    if (detail && detail.style.display === 'none') {
                        detail.style.display = '';
                        if (icon) { icon.textContent = '▼'; }
                    }
                }
            } else {
                row.style.display = 'none';
            }
        });

        searchCount.textContent = query ? matchCount + ' matches' : '';
    }

    // --- Expand All / Collapse All ---
    window.foldAll = function(collapse) {
        document.querySelectorAll('.region-card').forEach(card => {
            const detail = card.querySelector('.region-detail');
            const icon = card.querySelector('.fold-icon');
            if (detail) { detail.style.display = collapse ? 'none' : ''; }
            if (icon) { icon.textContent = collapse ? '▶' : '▼'; }
        });
    };

    // --- Overview row click → scroll to region card ---
    document.querySelectorAll('.overview-row').forEach(row => {
        row.addEventListener('click', () => {
            const name = row.getAttribute('data-region');
            const card = document.getElementById('region-' + name);
            if (!card) { return; }
            const detail = card.querySelector('.region-detail');
            const icon = card.querySelector('.fold-icon');
            if (detail && detail.style.display === 'none') {
                detail.style.display = '';
                if (icon) { icon.textContent = '▼'; }
            }
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.style.outline = '2px solid var(--vscode-focusBorder, #007acc)';
            setTimeout(() => card.style.outline = '', 2500);
        });
    });

    // --- Scroll to region (from extension Ctrl+Shift+O command) ---
    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'scrollToRegion') {
            const name = msg.name;
            const cards = document.querySelectorAll('.region-card');
            for (const card of cards) {
                const strong = card.querySelector('.region-header strong');
                if (strong && strong.textContent.trim() === name) {
                    const detail = card.querySelector('.region-detail');
                    const icon = card.querySelector('.fold-icon');
                    if (detail && detail.style.display === 'none') {
                        detail.style.display = '';
                        if (icon) { icon.textContent = '▼'; }
                    }
                    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    card.style.outline = '2px solid var(--vscode-focusBorder, #007acc)';
                    setTimeout(() => card.style.outline = '', 2500);
                    return;
                }
            }
        }
    });

    // --- Column sort (all sortable tables) ---
    document.querySelectorAll('.sortable-table').forEach(tbl => {
        const ths = tbl.querySelectorAll('th[data-sort]');
        let sortCol = null;
        let sortAsc = true;

        ths.forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.sort;
                if (sortCol === col) { sortAsc = !sortAsc; }
                else { sortCol = col; sortAsc = true; }

                const tbody = tbl.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));
                const colIdx = Array.from(th.parentElement.children).indexOf(th);

                rows.sort((a, b) => {
                    const aText = a.children[colIdx].textContent.trim();
                    const bText = b.children[colIdx].textContent.trim();
                    const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''));
                    const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''));
                    if (!isNaN(aNum) && !isNaN(bNum)) {
                        return sortAsc ? aNum - bNum : bNum - aNum;
                    }
                    return sortAsc ? aText.localeCompare(bText) : bText.localeCompare(aText);
                });

                rows.forEach(row => tbody.appendChild(row));
                ths.forEach(h => h.textContent = h.textContent.replace(/ [▲▼]$/, ''));
                th.textContent += sortAsc ? ' ▲' : ' ▼';
            });
        });
    });
})();
</script>
</body>
</html>`;
}

function esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
