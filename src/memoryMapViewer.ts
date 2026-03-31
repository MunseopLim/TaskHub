import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseElf32, classifySections, computeMemoryUsage, summarizeSections, generateTextReport, formatSize, formatHex, MemoryRegion, MemoryUsage, ElfSection, SectionSummary } from './elfParser';
import { parseLinkerFile } from './linkerScriptParser';

let currentPanel: vscode.WebviewPanel | undefined;

export interface MemoryMapConfig {
    regions?: MemoryRegion[];
}

export async function showMemoryMap(context: vscode.ExtensionContext, config?: MemoryMapConfig) {
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

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'taskhub.memoryMap',
            `Memory Map: ${fileName}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        currentPanel.onDidDispose(() => { currentPanel = undefined; });
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
        const sectionRows = u.sections.map(s =>
            `<tr><td>${esc(s.name)}</td><td class="num">${formatSize(s.size)}</td><td class="num">${String(s.size)}</td></tr>`
        ).join('');
        return `
        <div class="region-card">
            <div class="region-header">
                <strong>${esc(u.region)}</strong>
                <span class="region-info">${formatHex(u.total > 0 ? regions.find(r => r.name === u.region)?.origin ?? 0 : 0)} | ${formatSize(u.used)} / ${formatSize(u.total)} (${pct.toFixed(1)}%)</span>
            </div>
            <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div>
            ${u.sections.length > 0 ? `<table class="section-table"><thead><tr><th>Section</th><th class="num">Size</th><th class="num">Bytes</th></tr></thead><tbody>${sectionRows}</tbody></table>` : ''}
        </div>`;
    }).join('');

    const hasRegions = memoryUsage.length > 0;

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
        justify-content: space-between;
        margin-bottom: 6px;
        font-size: 13px;
    }
    .region-info {
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

    <div class="summary-row">
        <div class="summary-card">
            <div class="summary-label">Flash (Code + RO Data)</div>
            <div class="summary-value">${formatSize(flashTotal)}</div>
            <div class="summary-bytes">${flashTotal.toLocaleString()} bytes</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">RAM (Data + BSS)</div>
            <div class="summary-value">${formatSize(ramTotal)}</div>
            <div class="summary-bytes">${ramTotal.toLocaleString()} bytes</div>
        </div>
    </div>

    ${hasRegions ? `
        <div class="section-heading">Memory Regions</div>
        ${usageBarsHtml}
    ` : `
        <div class="no-regions">
            Memory region sizes not configured. To see usage bars, either:<br>
            - Run this command again and select a linker script (.ld / .sct)<br>
            - Or add <code>memoryMap.regions</code> to <code>.vscode/taskhub_types.json</code>
        </div>
    `}

    <div class="section-heading">All Sections (${sectionSummary.length})</div>
    <table id="sectionTable">
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

    // Column sort
    const table = document.getElementById('sectionTable');
    const headers = table.querySelectorAll('th[data-sort]');
    let sortCol = null;
    let sortAsc = true;

    headers.forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (sortCol === col) { sortAsc = !sortAsc; }
            else { sortCol = col; sortAsc = true; }

            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const colIdx = Array.from(th.parentElement.children).indexOf(th);

            rows.sort((a, b) => {
                const aText = a.children[colIdx].textContent.trim();
                const bText = b.children[colIdx].textContent.trim();
                // Try numeric sort first
                const aNum = parseFloat(aText.replace(/[^0-9.\-]/g, ''));
                const bNum = parseFloat(bText.replace(/[^0-9.\-]/g, ''));
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return sortAsc ? aNum - bNum : bNum - aNum;
                }
                return sortAsc ? aText.localeCompare(bText) : bText.localeCompare(aText);
            });

            rows.forEach(row => tbody.appendChild(row));

            headers.forEach(h => h.textContent = h.textContent.replace(/ [▲▼]$/, ''));
            th.textContent += sortAsc ? ' ▲' : ' ▼';
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
