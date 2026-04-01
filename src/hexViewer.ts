/**
 * Hex Viewer WebView panel for TaskHub.
 * Supports Intel HEX, Motorola SREC, and raw binary files.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { detectFormat, parseIntelHex, parseSrec, parseBinary, toFlatArray, HexParseResult } from './hexParser';

let currentPanel: vscode.WebviewPanel | undefined;

export async function showHexViewer(context: vscode.ExtensionContext) {
    const fileUri = await vscode.window.showOpenDialog({
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
    const fileName = path.basename(filePath);
    const result = parseFile(filePath);

    if (result.byteCount === 0) {
        vscode.window.showWarningMessage('No data found in the selected file.');
        return;
    }

    openPanel(context, fileName, result);
}

export function buildHexViewerHtml(fileName: string, result: HexParseResult): string {
    const totalSize = result.maxAddress - result.minAddress + 1;
    const flatData = toFlatArray(result, result.minAddress, totalSize);
    const dataBase64 = Buffer.from(flatData).toString('base64');

    const gapBitmap = new Uint8Array(Math.ceil(totalSize / 8));
    for (let i = 0; i < totalSize; i++) {
        if (result.data.has(result.minAddress + i)) {
            gapBitmap[Math.floor(i / 8)] |= (1 << (i % 8));
        }
    }
    const gapBase64 = Buffer.from(gapBitmap).toString('base64');

    return getWebviewContent(
        fileName, result.format, result.minAddress, result.maxAddress,
        result.byteCount, result.entryPoint, dataBase64, gapBase64
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

function setupWebviewMessageHandler(webview: vscode.Webview, disposables: vscode.Disposable[]) {
    webview.onDidReceiveMessage(message => {
        if (message.command === 'copySelection') {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('Copied to clipboard.');
        }
    }, undefined, disposables);
}

function openPanel(context: vscode.ExtensionContext, fileName: string, result: HexParseResult) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'taskhub.hexViewer',
            `Hex: ${fileName}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        currentPanel.onDidDispose(() => { currentPanel = undefined; });
    }

    currentPanel.title = `Hex: ${fileName}`;
    currentPanel.webview.html = buildHexViewerHtml(fileName, result);
    setupWebviewMessageHandler(currentPanel.webview, context.subscriptions);
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getWebviewContent(
    fileName: string,
    format: string,
    minAddress: number,
    maxAddress: number,
    byteCount: number,
    entryPoint: number | undefined,
    dataBase64: string,
    gapBase64: string
): string {
    const formatLabel = format === 'intel' ? 'Intel HEX' : format === 'srec' ? 'Motorola SREC' : 'Binary';
    const entryStr = entryPoint !== undefined ? `0x${entryPoint.toString(16).toUpperCase().padStart(8, '0')}` : 'N/A';

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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

    /* Hex content */
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
            <span class="meta">Format: ${formatLabel}</span>
            <span class="meta">Size: ${byteCount.toLocaleString()} bytes</span>
            <span class="meta">Range: 0x${minAddress.toString(16).toUpperCase().padStart(8, '0')} – 0x${maxAddress.toString(16).toUpperCase().padStart(8, '0')}</span>
            <span class="meta">Entry: ${entryStr}</span>
        </div>
    </div>
    <div class="toolbar">
        <label>Unit:</label>
        <select id="unitSize">
            <option value="1" selected>1 Byte</option>
            <option value="2">2 Bytes (16-bit)</option>
            <option value="4">4 Bytes (32-bit)</option>
            <option value="8">8 Bytes (64-bit)</option>
        </select>
        <label>Endian:</label>
        <select id="endian">
            <option value="little" selected>Little-Endian</option>
            <option value="big">Big-Endian</option>
        </select>
        <div class="sep"></div>
        <label>Go to:</label>
        <input type="text" id="gotoInput" class="goto-input" placeholder="0x08000000">
        <button id="gotoBtn">Go</button>
        <div class="sep"></div>
        <button id="findBtn">Find (Ctrl+F)</button>
    </div>
    <div class="find-bar" id="findBar">
        <select id="findMode">
            <option value="bytes">Bytes</option>
            <option value="value" selected>Value</option>
            <option value="ascii">ASCII</option>
        </select>
        <input type="text" id="findHexInput" placeholder="20020000">
        <button id="findPrev">◀ Prev</button>
        <button id="findNext">Next ▶</button>
        <span class="find-info" id="findInfo"></span>
        <button id="findClose">✕</button>
    </div>
    <div class="hex-container" id="hexContainer">
        <table class="hex-table" id="hexTable">
            <thead id="hexHead"></thead>
            <tbody id="hexBody"></tbody>
        </table>
    </div>
    <div class="status-bar" id="statusBar">
        <span>Click a byte to inspect</span>
    </div>

<script>
(function() {
    const vscode = acquireVsCodeApi();
    const BASE_ADDR = ${minAddress};
    const TOTAL_SIZE = ${maxAddress - minAddress + 1};

    // Decode data
    const raw = atob('${dataBase64}');
    const DATA = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) { DATA[i] = raw.charCodeAt(i); }

    // Decode gap bitmap
    const gapRaw = atob('${gapBase64}');
    const GAP_BITMAP = new Uint8Array(gapRaw.length);
    for (let i = 0; i < gapRaw.length; i++) { GAP_BITMAP[i] = gapRaw.charCodeAt(i); }

    function hasData(offset) {
        return (GAP_BITMAP[Math.floor(offset / 8)] & (1 << (offset % 8))) !== 0;
    }

    let unitSize = 1;
    let endian = 'little';
    let selectedOffset = -1;
    let selectedEndOffset = -1;
    let findMatches = [];
    let findCurrentIdx = -1;

    const BYTES_PER_ROW = 16;

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

    function readUnit(offset, size, le) {
        if (offset + size > TOTAL_SIZE) { return null; }
        let val = 0n;
        for (let i = 0; i < size; i++) {
            const b = BigInt(DATA[offset + (le ? i : size - 1 - i)]);
            val = val | (b << BigInt(i * 8));
        }
        return val;
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
        // Group every 4 units when unitSize=1, every 2 when unitSize=2, every 1 when unitSize>=4
        if (unitSize === 1) { return 4; }
        if (unitSize === 2) { return 2; }
        return 1;
    }

    function buildHeader() {
        const upr = unitsPerRow();
        const ge = groupEvery();
        let html = '<tr><th class="addr-header">Address</th>';
        for (let i = 0; i < upr; i++) {
            if (i > 0 && i % ge === 0) {
                html += '<th class="group-sep"></th>';
            }
            const offsetLabel = formatHex(i * unitSize, 2);
            html += '<th>' + offsetLabel + '</th>';
        }
        html += '<th class="ascii-sep"></th>';
        html += '<th class="ascii-header">ASCII</th></tr>';
        hexHead.innerHTML = html;
    }

    function buildBody() {
        const upr = unitsPerRow();
        const ge = groupEvery();
        const digits = unitHexDigits();
        const le = endian === 'little';
        const rowCount = Math.ceil(TOTAL_SIZE / BYTES_PER_ROW);

        // Use DocumentFragment for performance
        const frag = document.createDocumentFragment();

        for (let row = 0; row < rowCount; row++) {
            const rowOffset = row * BYTES_PER_ROW;
            const rowAddr = BASE_ADDR + rowOffset;

            const tr = document.createElement('tr');
            tr.className = 'hex-row';

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

                if (byteOffset + unitSize <= TOTAL_SIZE) {
                    const val = readUnit(byteOffset, unitSize, le);
                    td.textContent = val !== null ? formatHex(Number(val & BigInt('0x' + 'F'.repeat(digits))), digits) : '';
                    td.dataset.offset = String(byteOffset);

                    // Check if any byte in this unit is a gap
                    let isGap = true;
                    for (let b = 0; b < unitSize; b++) {
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

            frag.appendChild(tr);
        }

        hexBody.innerHTML = '';
        hexBody.appendChild(frag);
    }

    function render() {
        buildHeader();
        buildBody();
        updateSelection();
        applyFindHighlights();
    }

    function updateSelection() {
        // Clear previous
        document.querySelectorAll('.hex-cell.selected, .ascii-cell.selected').forEach(el => el.classList.remove('selected'));

        if (selectedOffset < 0) { return; }
        const endOff = selectedEndOffset >= 0 ? selectedEndOffset : selectedOffset;
        const minOff = Math.min(selectedOffset, endOff);
        const maxOff = Math.max(selectedOffset, endOff);

        document.querySelectorAll('.hex-cell[data-offset]').forEach(el => {
            const off = parseInt(el.dataset.offset, 10);
            if (off >= minOff && off <= maxOff) {
                el.classList.add('selected');
            }
        });

        // Update status bar
        updateStatusBar(minOff, maxOff);
    }

    function updateStatusBar(minOff, maxOff) {
        const le = endian === 'little';
        const addr = BASE_ADDR + minOff;
        const selSize = maxOff - minOff + unitSize;
        let html = '<span>Offset: 0x' + formatHex(minOff, 8) + '</span>';
        html += '<span>Address: ' + formatAddr(addr) + '</span>';

        if (selSize === 1) {
            const b = DATA[minOff];
            html += '<span>Value: 0x' + formatHex(b, 2) + ' (' + b + ')</span>';
        }
        if (selSize >= 1) {
            const u8 = DATA[minOff];
            html += '<span>u8: ' + u8 + '</span>';
        }
        if (selSize >= 2 && minOff + 2 <= TOTAL_SIZE) {
            const v = Number(readUnit(minOff, 2, le));
            html += '<span>u16: 0x' + formatHex(v, 4) + ' (' + v + ')</span>';
        }
        if (selSize >= 4 && minOff + 4 <= TOTAL_SIZE) {
            const v = Number(readUnit(minOff, 4, le));
            html += '<span>u32: 0x' + formatHex(v, 8) + ' (' + v + ')</span>';
        }
        if (selSize > unitSize) {
            html += '<span>Selected: ' + selSize + ' bytes</span>';
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
    function goToAddress() {
        const val = gotoInput.value.trim();
        let addr = parseInt(val, 16);
        if (val.startsWith('0x') || val.startsWith('0X')) {
            addr = parseInt(val.substring(2), 16);
        }
        if (isNaN(addr)) { return; }
        const offset = addr - BASE_ADDR;
        if (offset < 0 || offset >= TOTAL_SIZE) {
            return;
        }
        const rowIndex = Math.floor(offset / BYTES_PER_ROW);
        const rows = hexBody.querySelectorAll('.hex-row');
        if (rows[rowIndex]) {
            rows[rowIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            selectedOffset = offset;
            selectedEndOffset = offset;
            updateSelection();
        }
    }

    document.getElementById('gotoBtn').addEventListener('click', goToAddress);
    gotoInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { goToAddress(); }
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
        // Parse as big-endian hex value, then convert to byte array respecting endian setting
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substring(i, i + 2), 16));
        }
        // bytes is now big-endian (MSB first, as user typed)
        // For little-endian memory, reverse the byte order
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

    function doFind() {
        findMatches = [];
        findCurrentIdx = -1;
        const bytes = getFindBytes();
        if (!bytes || bytes.length === 0) {
            findInfo.textContent = '';
            applyFindHighlights();
            return;
        }
        for (let i = 0; i <= TOTAL_SIZE - bytes.length; i++) {
            let match = true;
            for (let j = 0; j < bytes.length; j++) {
                if (DATA[i + j] !== bytes[j]) { match = false; break; }
            }
            if (match) { findMatches.push(i); }
        }
        if (findMatches.length > 0) {
            findCurrentIdx = 0;
            findInfo.textContent = '1 / ' + findMatches.length;
            goToFindMatch();
        } else {
            findInfo.textContent = 'No matches';
        }
        applyFindHighlights();
    }

    function goToFindMatch() {
        if (findCurrentIdx < 0 || findCurrentIdx >= findMatches.length) { return; }
        const offset = findMatches[findCurrentIdx];
        const rowIndex = Math.floor(offset / BYTES_PER_ROW);
        const rows = hexBody.querySelectorAll('.hex-row');
        if (rows[rowIndex]) {
            rows[rowIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        selectedOffset = offset;
        selectedEndOffset = offset;
        updateSelection();
        findInfo.textContent = (findCurrentIdx + 1) + ' / ' + findMatches.length;
        applyFindHighlights();
    }

    function applyFindHighlights() {
        document.querySelectorAll('.hex-cell.find-highlight, .hex-cell.find-current').forEach(el => {
            el.classList.remove('find-highlight', 'find-current');
        });
        if (findMatches.length === 0) { return; }

        const bytes = getFindBytes();
        if (!bytes) { return; }

        // Only highlight visible matches for performance
        const matchSet = new Set();
        const currentSet = new Set();
        for (let mi = 0; mi < findMatches.length; mi++) {
            for (let j = 0; j < bytes.length; j++) {
                const off = findMatches[mi] + j;
                // Align to unit boundary
                const unitOff = Math.floor(off / unitSize) * unitSize;
                matchSet.add(unitOff);
                if (mi === findCurrentIdx) { currentSet.add(unitOff); }
            }
        }

        document.querySelectorAll('.hex-cell[data-offset]').forEach(el => {
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
        applyFindHighlights();
    });
    findHexInput.addEventListener('input', doFind);
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
        const upr = unitsPerRow();
        const parts = [];
        for (let off = minOff; off < maxOff && off < TOTAL_SIZE; off += unitSize) {
            const val = readUnit(off, unitSize, le);
            if (val !== null) {
                parts.push(formatHex(Number(val & BigInt('0x' + 'F'.repeat(digits))), digits));
            }
        }
        return parts.join(' ');
    }

    // Intercept copy to format properly (no tabs)
    document.addEventListener('copy', (e) => {
        // If hex cells are selected via click, use that range
        if (selectedOffset >= 0) {
            const endOff = selectedEndOffset >= 0 ? selectedEndOffset : selectedOffset;
            const minOff = Math.min(selectedOffset, endOff);
            const maxOff = Math.max(selectedOffset, endOff) + unitSize;
            e.clipboardData.setData('text/plain', buildCopyText(minOff, maxOff));
            e.preventDefault();
            return;
        }
        // For browser text selection (drag), clean up the tab-separated output
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

    // Initial render
    render();
})();
</script>
</body>
</html>`;
}

export class HexEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private context: vscode.ExtensionContext) {}

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
        const result = parseFile(filePath);

        if (result.byteCount === 0) {
            webviewPanel.webview.html = '<html><body><p>No data found in this file.</p></body></html>';
            return;
        }

        webviewPanel.webview.html = buildHexViewerHtml(fileName, result);
        setupWebviewMessageHandler(webviewPanel.webview, this.context.subscriptions);
    }
}
