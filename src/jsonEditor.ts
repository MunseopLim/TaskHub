import * as vscode from 'vscode';
import * as fs from 'fs';
import { t } from './i18n';

let currentPanel: vscode.WebviewPanel | undefined;
let currentMessageDisposable: vscode.Disposable | undefined;

/** JSON Editor에서 처리 가능한 최대 파일 크기 (10 MB) */
const JSON_EDITOR_MAX_FILE_SIZE = 10 * 1024 * 1024;

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

export async function openJsonEditor(context: vscode.ExtensionContext) {
    const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'JSON Files': ['json'] },
        openLabel: 'Open JSON File'
    });

    if (!fileUris || fileUris.length === 0) {
        return;
    }

    openJsonEditorWithPath(context, fileUris[0].fsPath);
}

export async function openJsonEditorFromUri(context: vscode.ExtensionContext, uri?: vscode.Uri) {
    if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.json')) {
            uri = editor.document.uri;
        } else {
            return openJsonEditor(context);
        }
    }

    openJsonEditorWithPath(context, uri.fsPath);
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

function openJsonEditorWithPath(context: vscode.ExtensionContext, filePath: string) {
    const fileName = filePath.split(/[\\/]/).pop() || 'JSON Editor';

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (e: any) {
        vscode.window.showErrorMessage(t(`파일을 읽을 수 없습니다 (${fileName}): ${e.message}`, `Cannot read file (${fileName}): ${e.message}`));
        return;
    }

    if (stat.size > JSON_EDITOR_MAX_FILE_SIZE) {
        vscode.window.showErrorMessage(t(
            `파일 크기(${formatFileSize(stat.size)})가 JSON Editor 처리 한도(${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)})를 초과합니다. 대용량 JSON 파일은 텍스트 에디터에서 직접 편집해 주세요.`,
            `File size (${formatFileSize(stat.size)}) exceeds the JSON Editor limit (${formatFileSize(JSON_EDITOR_MAX_FILE_SIZE)}). Please edit large JSON files directly in a text editor.`
        ));
        return;
    }

    let jsonData: Record<string, unknown>;
    let isRootArray = false;
    let detectedIndent: string | number = 2;
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (error: any) {
        vscode.window.showErrorMessage(t(`파일 읽기 실패 (${fileName}): ${error.message}`, `Failed to read file (${fileName}): ${error.message}`));
        return;
    }

    try {
        const parsed = JSON.parse(content);
        const result = wrapIfArray(parsed);
        jsonData = result.wrapped;
        isRootArray = result.isRootArray;
        detectedIndent = detectIndent(content);
    } catch (error: any) {
        vscode.window.showErrorMessage(t(`JSON 파싱 실패 (${fileName}): ${error.message}`, `Failed to parse JSON (${fileName}): ${error.message}`));
        return;
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
                retainContextWhenHidden: true
            }
        );
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            currentMessageDisposable?.dispose();
            currentMessageDisposable = undefined;
        });
    }

    currentPanel.title = `JSON Editor: ${fileName}`;
    currentPanel.webview.html = getWebviewContent(jsonData, filePath);

    currentMessageDisposable?.dispose();
    currentMessageDisposable = currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.command) {
                case 'save': {
                    try {
                        const saveData = unwrapIfRootArray(message.data, isRootArray);
                        fs.writeFileSync(filePath, JSON.stringify(saveData, null, detectedIndent) + '\n', 'utf-8');
                        vscode.window.showInformationMessage(t(`JSON 저장 완료: ${fileName}`, `JSON saved: ${fileName}`));
                    } catch (error: any) {
                        vscode.window.showErrorMessage(t(`JSON 저장 실패 (${fileName}): ${error.message}`, `Failed to save JSON (${fileName}): ${error.message}`));
                    }
                    break;
                }
                case 'reload': {
                    try {
                        const reloadContent = fs.readFileSync(filePath, 'utf-8');
                        const parsed = JSON.parse(reloadContent);
                        const result = wrapIfArray(parsed);
                        isRootArray = result.isRootArray;
                        currentPanel?.webview.postMessage({ command: 'loadData', data: result.wrapped });
                    } catch (error: any) {
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
}

function getWebviewContent(data: Record<string, unknown>, filePath: string): string {
    // Encode data as base64 to avoid any HTML/JS parsing issues with special characters
    const jsonBase64 = Buffer.from(JSON.stringify(data), 'utf-8').toString('base64');
    const escapedPath = filePath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
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
        <button id="btnSave" title="Save (Ctrl+S)">Save</button>
        <button id="btnReload">Reload</button>
        <button id="btnAddRow">+ Row</button>
        <span class="modified-indicator" id="modifiedFlag">● Modified</span>
        <span class="filepath" title="${escapedPath}">${escapedPath}</span>
    </div>
    <div class="tabs" id="tabs"></div>
    <div class="table-wrapper" id="tableWrapper"></div>
    <div id="errorMsg" style="color:var(--danger);padding:12px;display:none;"></div>

<script>
(function() {
    const errorEl = document.getElementById('errorMsg');
    function showError(msg) {
        errorEl.style.display = 'block';
        errorEl.textContent = msg;
    }
    window.onerror = function(msg, src, line, col, err) {
        showError('JS Error: ' + msg + ' (line ' + line + ')');
    };
    const vscode = acquireVsCodeApi();
    let data;
    try {
        data = JSON.parse(atob('${jsonBase64}'));
    } catch(e) {
        showError('Failed to parse JSON data: ' + e.message);
        return;
    }
    let sheetMap = [];
    let activeIdx = 0;
    let modified = false;

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
        modified = val;
        document.getElementById('modifiedFlag').classList.toggle('show', val);
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
            tab.textContent = entry.label === '_rootArray' ? 'Items' : entry.label;
            tab.onclick = () => { activeIdx = idx; renderTabs(); renderTable(); };
            tabsEl.appendChild(tab);
        });
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
            wrapper.innerHTML = '<div class="empty-msg">No data. Click "+ Row" to add a row.</div>';
            return;
        }

        const columns = [];
        const seen = new Set();
        rows.forEach(row => {
            Object.keys(row).forEach(k => {
                if (!seen.has(k)) { seen.add(k); columns.push(k); }
            });
        });

        let html = '<table><thead><tr><th class="drag-handle"></th><th class="row-num">#</th>';
        columns.forEach(col => { html += '<th>' + escapeHtml(col) + '</th>'; });
        html += '<th class="actions-cell"></th></tr></thead><tbody>';

        rows.forEach((row, rowIdx) => {
            html += '<tr draggable="true" data-drag-row="' + rowIdx + '">';
            html += '<td class="drag-handle" title="Drag to reorder">⠿</td>';
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
            html += '<td class="actions-cell"><button class="small danger" data-delete-row="' + rowIdx + '" title="Delete row">✕</button></td>';
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
                html += '<button class="convert-btn" data-convert="join" title="Array → String (join with comma)">a→s</button>';
            }
            html += '</div></div>';
            return html;
        }
        let html = '<div class="cell-view">' + escapeHtml(String(val ?? ''));
        if (typeof val === 'string' && val.includes(',')) {
            html += '<button class="convert-btn" data-convert="split" title="String → Array (split by comma)">s→a</button>';
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
                html += '<button class="small danger" data-remove-arr="' + i + '">✕</button>';
                html += '</div>';
            });
            html += '<button class="small" data-add-arr="true">+ Add</button>';
            html += '</div></div>';
            return html;
        }
        if (isMultiline) {
            return '<div class="cell-edit"><textarea>' + escapeHtml(String(val)) + '</textarea></div>';
        }
        return '<div class="cell-edit"><input type="text" value="' + escapeAttr(String(val ?? '')) + '"></div>';
    }

    function attachCellEvents() {
        // Click to edit
        document.querySelectorAll('td[data-row]').forEach(td => {
            const view = td.querySelector('.cell-view');
            if (!view) { return; }
            view.addEventListener('click', () => {
                // Close other editing cells
                document.querySelectorAll('td.editing').forEach(other => {
                    if (other !== td) { commitCell(other); }
                });
                td.classList.add('editing');
                const input = td.querySelector('.cell-edit input, .cell-edit textarea');
                if (input) { input.focus(); input.select && input.select(); }
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
                    setTimeout(() => { if (td.classList.contains('editing')) { commitCell(td); } }, 100);
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
                    setTimeout(() => { if (td.classList.contains('editing')) { commitCell(td); } }, 100);
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

        // Remove array item
        document.querySelectorAll('[data-remove-arr]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.closest('td');
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                const idx = parseInt(btn.dataset.removeArr);
                const arr = getActiveRows()[rowIdx][col];
                if (Array.isArray(arr)) {
                    arr.splice(idx, 1);
                    setModified(true);
                    renderTable();
                }
            });
        });

        // Add array item
        document.querySelectorAll('[data-add-arr]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const td = btn.closest('td');
                const rowIdx = parseInt(td.dataset.row);
                const col = td.dataset.col;
                const arr = getActiveRows()[rowIdx][col];
                if (Array.isArray(arr)) {
                    arr.push('');
                    setModified(true);
                    renderTable();
                    // Focus last input
                    const newTd = document.querySelector('td[data-row="' + rowIdx + '"][data-col="' + col + '"]');
                    if (newTd) {
                        newTd.classList.add('editing');
                        const inputs = newTd.querySelectorAll('.cell-edit input[data-arr-idx]');
                        if (inputs.length) { inputs[inputs.length - 1].focus(); }
                    }
                }
            });
        });

        // Convert string <-> array
        document.querySelectorAll('[data-convert]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
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
                setModified(true);
                renderTable();
            });
        });

        // Delete row
        document.querySelectorAll('[data-delete-row]').forEach(btn => {
            btn.addEventListener('click', () => {
                const rowIdx = parseInt(btn.dataset.deleteRow);
                getActiveRows().splice(rowIdx, 1);
                setModified(true);
                renderTable();
            });
        });

        // Drag and drop reorder
        let dragSrcIdx = null;
        document.querySelectorAll('tr[data-drag-row]').forEach(tr => {
            tr.addEventListener('dragstart', (e) => {
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
                setModified(true);
                renderTable();
            });
        });
    }

    function commitCell(td) {
        if (!td || !td.classList.contains('editing')) { return; }
        const rowIdx = parseInt(td.dataset.row);
        const col = td.dataset.col;
        const oldVal = getActiveRows()[rowIdx][col];

        if (Array.isArray(oldVal)) {
            const jsonTextarea = td.querySelector('.cell-edit textarea.json-edit');
            if (jsonTextarea) {
                try {
                    const newVal = JSON.parse(jsonTextarea.value);
                    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                        getActiveRows()[rowIdx][col] = newVal;
                        setModified(true);
                    }
                } catch (e) {
                    showError('Invalid JSON in cell [' + col + ']: ' + e.message);
                    return;
                }
            } else {
                const inputs = td.querySelectorAll('.cell-edit input[data-arr-idx]');
                const newArr = [];
                inputs.forEach(input => { newArr.push(input.value); });
                getActiveRows()[rowIdx][col] = newArr;
                if (JSON.stringify(oldVal) !== JSON.stringify(newArr)) { setModified(true); }
            }
        } else {
            const jsonTextarea = td.querySelector('.cell-edit textarea.json-edit');
            if (jsonTextarea) {
                try {
                    const newVal = JSON.parse(jsonTextarea.value);
                    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                        getActiveRows()[rowIdx][col] = newVal;
                        setModified(true);
                    }
                } catch (e) {
                    showError('Invalid JSON in cell [' + col + ']: ' + e.message);
                    return; // Don't close editing on invalid JSON
                }
            } else {
                const textarea = td.querySelector('.cell-edit textarea');
                const input = td.querySelector('.cell-edit input');
                let newVal;
                if (textarea) {
                    newVal = textarea.value;
                } else if (input) {
                    newVal = parseValue(input.value);
                }
                const oldEmpty = oldVal === undefined || oldVal === null || oldVal === '';
                const newEmpty = newVal === undefined || newVal === null || newVal === '';
                if (oldEmpty && newEmpty) {
                    // No real change
                } else if (oldVal !== newVal) {
                    getActiveRows()[rowIdx][col] = newVal;
                    setModified(true);
                }
            }
        }
        td.classList.remove('editing');
        renderTable();
    }

    function cancelCell(td) {
        if (!td) { return; }
        td.classList.remove('editing');
        renderTable();
    }

    function parseValue(str) {
        if (str === '') { return ''; }
        if (str === 'null') { return null; }
        if (str === 'true') { return true; }
        if (str === 'false') { return false; }
        const num = Number(str);
        if (!isNaN(num) && str.trim() !== '') { return num; }
        return str;
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Toolbar buttons
    document.getElementById('btnSave').addEventListener('click', () => {
        const editingTd = document.querySelector('td.editing');
        if (editingTd) { commitCell(editingTd); }
        vscode.postMessage({ command: 'save', data: data });
        setModified(false);
    });

    document.getElementById('btnReload').addEventListener('click', () => {
        vscode.postMessage({ command: 'reload' });
    });

    document.getElementById('btnAddRow').addEventListener('click', () => {
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
        setModified(true);
        renderTable();
    });

    // Ctrl+S to save
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            const editingTd = document.querySelector('td.editing');
            if (editingTd) { commitCell(editingTd); }
            document.getElementById('btnSave').click();
        }
    });

    // Messages from extension
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.command === 'loadData') {
            data = msg.data;
            const oldLabel = sheetMap[activeIdx] ? sheetMap[activeIdx].label : '';
            buildSheetMap();
            const newIdx = sheetMap.findIndex(e => e.label === oldLabel);
            activeIdx = newIdx >= 0 ? newIdx : 0;
            setModified(false);
            renderTabs();
            renderTable();
        }
    });

    // Initial render
    renderTabs();
    renderTable();
})();
</script>
</body>
</html>`;
}
