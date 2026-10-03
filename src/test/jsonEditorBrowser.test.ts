import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { jsonPanelRegistry, openJsonEditorFile, RECOVERY_STATE_KEY } from '../jsonEditor';

interface BrowserMessage {
    command: string;
    [key: string]: any;
}

/** 제품 진입점의 HTML·외부 번들·CSP·저장 핸들러는 그대로 두고 DOM 관찰만 추가한다. */
function observeHtml(html: string): string {
    const scriptTag = html.match(/<script nonce="([^"]+)"[^>]*>/);
    assert.ok(scriptTag, 'JSON Editor script nonce');
    const observer = `<script nonce="${scriptTag[1]}">
    (() => {
        const api = acquireVsCodeApi();
        window.acquireVsCodeApi = () => api;
        const required = selector => {
            const element = document.querySelector(selector);
            if (!element) { throw new Error('Missing element: ' + selector); }
            return element;
        };
        const requiredCell = operation => {
            const td = Array.from(document.querySelectorAll('td[data-row]'))
                .find(cell => Number(cell.dataset.row) === (operation.row ?? 0) && cell.dataset.col === operation.col);
            if (!td) { throw new Error('Missing editable cell: ' + operation.col); }
            return td;
        };
        const inspect = () => ({
            cells: Array.from(document.querySelectorAll('td[data-row]')).map(td => ({
                row: Number(td.dataset.row), col: td.dataset.col,
                label: td.querySelector('.cell-view').getAttribute('aria-label'),
                editing: td.classList.contains('editing'),
                input: td.querySelector('.cell-edit input, .cell-edit textarea')?.value,
            })),
            dirty: required('#modifiedFlag').classList.contains('show'),
            error: required('#errorMsg').textContent,
            errorVisible: getComputedStyle(required('#errorMsg')).display !== 'none',
            injected: Boolean(document.getElementById('unexpected-injection')),
            focused: (() => {
                const element = document.activeElement;
                if (!element) { return undefined; }
                if (element.matches?.('button[data-move-row]')) { return 'grip:' + element.dataset.moveRow; }
                if (element.matches?.('button[data-delete-row]')) { return 'delete:' + element.dataset.deleteRow; }
                if (element.matches?.('.convert-btn')) {
                    const owner = element.closest('td[data-row]');
                    return 'convert:' + owner.dataset.row + ':' + owner.dataset.col;
                }
                const td = element.closest?.('td[data-row]');
                if (td && element.classList.contains('cell-view')) { return 'cell:' + td.dataset.row + ':' + td.dataset.col; }
                return element.id || element.tagName;
            })(),
            focusedCell: (() => {
                const td = document.activeElement?.closest?.('td[data-row]');
                return td ? { row: Number(td.dataset.row), col: td.dataset.col } : undefined;
            })(),
            // 화면에 보이는 Tab 정지만 센다(편집 중이 아닌 셀의 입력 컨트롤은 숨겨져 있다).
            tableTabStops: Array.from(document.querySelectorAll('#tableWrapper tbody button, #tableWrapper tbody .cell-view'))
                .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0).length,
        });
        window.addEventListener('error', event => api.postMessage({ command: 'testError', error: event.message }));
        window.addEventListener('unhandledrejection', event => api.postMessage({ command: 'testError', error: String(event.reason) }));
        document.addEventListener('DOMContentLoaded', () => {
            api.postMessage({ command: 'testReady', ...inspect() });
        }, { once: true });
        window.addEventListener('message', event => {
            if (event.data?.command !== 'testOperate') { return; }
            try {
                const keyResults = [];
                for (const operation of event.data.operations) {
                    if (operation.kind === 'edit' || operation.kind === 'open' || operation.kind === 'pointerOpen') {
                        const view = requiredCell(operation).querySelector('.cell-view');
                        if (operation.kind === 'pointerOpen') {
                            view.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            // 합성 MouseEvent는 기본 포커스 이동을 하지 않는다. 실제
                            // 포인터처럼 blur를 먼저 발생시키고 같은 turn에서 클릭한다.
                            view.focus();
                            view.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        }
                        view.click();
                        // 다른 셀 commit으로 표가 교체되어도 현재 화면의 입력을 읽는다.
                        const input = requiredCell(operation).querySelector('.cell-edit input, .cell-edit textarea');
                        if (operation.kind === 'edit') {
                            input.value = operation.value;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    } else if (operation.kind === 'click') {
                        required('#' + operation.id).click();
                    } else if (operation.kind === 'key') {
                        const input = operation.selector ? required(operation.selector) : document.activeElement;
                        if (operation.selector) { input.focus(); }
                        const key = new KeyboardEvent('keydown', {
                            key: operation.key, ctrlKey: operation.ctrlKey, metaKey: operation.metaKey,
                            isComposing: operation.isComposing, bubbles: true, cancelable: true,
                        });
                        input.dispatchEvent(key);
                        keyResults.push({ prevented: key.defaultPrevented });
                    }
                }
                api.postMessage({ command: 'testResult', request: event.data.request, keyResults, ...inspect() });
            } catch (error) {
                api.postMessage({ command: 'testError', error: String(error) });
            }
        });
    })();
    </script>`;
    return html.replace(scriptTag[0], observer + scriptTag[0]);
}

async function withJsonBrowser(
    initial: unknown,
    body: (harness: {
        filePath: string;
        initialText: string;
        messages: BrowserMessage[];
        ready: BrowserMessage;
        reopen(): Promise<BrowserMessage>;
        operate(operations: Array<Record<string, unknown>>): Promise<BrowserMessage>;
        waitFor(command: string, after?: number): Promise<BrowserMessage>;
    }) => Promise<void>,
    options: {
        recoveryData?: unknown;
        expectedErrors?: RegExp[];
        beforeRecoveryUpdate?: () => Promise<void>;
        beforeHostPost?: (message: BrowserMessage) => Promise<void>;
    } = {},
): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-json-browser-'));
    const filePath = path.join(tempDir, '한글 설정.json');
    const initialText = JSON.stringify(initial, null, 4) + '\n';
    fs.writeFileSync(filePath, initialText, 'utf8');
    const originalCreate = vscode.window.createWebviewPanel;
    const originalInfo = vscode.window.showInformationMessage;
    const originalError = vscode.window.showErrorMessage;
    const errors: string[] = [];
    const messages: BrowserMessage[] = [];
    const listeners = new Set<() => void>();
    const disposables: vscode.Disposable[] = [];
    let panel: vscode.WebviewPanel | undefined;
    let request = 0;
    let browserError: Error | undefined;
    let acceptRecovery = false;
    jsonPanelRegistry.clear();

    const waitFor = (command: string, after = 0, requestId?: number): Promise<BrowserMessage> => new Promise((resolve, reject) => {
        const check = () => {
            const message = messages.slice(after).find(candidate => candidate.command === command
                && (requestId === undefined || candidate.request === requestId));
            if (browserError || message) {
                clearTimeout(timer);
                listeners.delete(check);
                if (browserError) { reject(browserError); } else { resolve(message!); }
            }
        };
        const timer = setTimeout(() => {
            listeners.delete(check);
            reject(new Error(`JSON browser ${command} timed out: ${messages.map(message => message.command).join(', ')}`));
        }, 20000);
        listeners.add(check);
        check();
    });

    try {
        (vscode.window as any).showInformationMessage = (_message: string, ...buttons: unknown[]) =>
            Promise.resolve(options.recoveryData === undefined && !acceptRecovery ? undefined : buttons.find(button => typeof button === 'string'));
        (vscode.window as any).showErrorMessage = (message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        };
        (vscode.window as any).createWebviewPanel = (...args: Parameters<typeof originalCreate>) => {
            panel = originalCreate(...args);
            disposables.push(panel.webview.onDidReceiveMessage((message: BrowserMessage) => {
                messages.push(message);
                if (message.command === 'testError') { browserError = new Error(message.error); }
                for (const listener of [...listeners]) { listener(); }
            }));
            const webview = new Proxy(panel.webview, {
                set(target, property, value) {
                    return Reflect.set(target, property, property === 'html' ? observeHtml(value) : value, target);
                },
                get(target, property) {
                    if (property === 'postMessage') {
                        return async (message: BrowserMessage) => {
                            await options.beforeHostPost?.(message);
                            const delivered = await target.postMessage(message);
                            messages.push({ ...message, command: 'host:' + message.command });
                            for (const listener of [...listeners]) { listener(); }
                            return delivered;
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            return new Proxy(panel, {
                set(target, property, value) {
                    return Reflect.set(target, property, value, target);
                },
                get(target, property) {
                    if (property === 'webview') { return webview; }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        };
        const store = new Map<string, unknown>();
        if (options.recoveryData !== undefined) {
            const stat = fs.statSync(filePath);
            store.set(RECOVERY_STATE_KEY, {
                [filePath]: { data: options.recoveryData, fileMtimeMs: stat.mtimeMs, fileSize: stat.size, capturedAt: Date.now(), isRootArray: false },
            });
        }
        const extensionPath = path.resolve(__dirname, '..', '..');
        const context = {
            extensionPath,
            extensionUri: vscode.Uri.file(extensionPath),
            subscriptions: disposables,
            workspaceState: {
                get: (key: string, fallback: unknown) => store.get(key) ?? fallback,
                update: async (key: string, value: unknown) => {
                    await options.beforeRecoveryUpdate?.();
                    store.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        await openJsonEditorFile(context, filePath);
        assert.ok(panel, `JSON Editor did not open: ${errors.join(', ')}`);
        const ready = await waitFor('testReady');
        assert.strictEqual(ready.errorVisible, false, ready.error);
        await body({
            filePath, initialText, messages, ready, waitFor,
            async reopen() {
                const after = messages.length;
                panel!.dispose();
                acceptRecovery = true;
                try { await openJsonEditorFile(context, filePath); }
                finally { acceptRecovery = false; }
                return waitFor('testReady', after);
            },
            async operate(operations) {
                const requestId = ++request;
                const after = messages.length;
                assert.strictEqual(await panel!.webview.postMessage({ command: 'testOperate', operations, request: requestId }), true);
                return waitFor('testResult', after, requestId);
            },
        });
        assert.strictEqual(browserError, undefined);
        const expectedErrors = options.expectedErrors ?? [];
        assert.strictEqual(errors.length, expectedErrors.length, `확장 호스트 저장 오류: ${errors.join(', ')}`);
        expectedErrors.forEach((pattern, index) => assert.match(errors[index], pattern));
    } finally {
        panel?.dispose();
        jsonPanelRegistry.clear();
        for (const disposable of disposables) { disposable.dispose(); }
        (vscode.window as any).createWebviewPanel = originalCreate;
        (vscode.window as any).showInformationMessage = originalInfo;
        (vscode.window as any).showErrorMessage = originalError;
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
}

suite('JSON Editor 실제 브라우저 편집과 저장', function () {
    this.timeout(30000);
    test('셀 blur 직후 클릭해 다른 열과 행으로 이어 편집하고 저장한다', async () => {
        await withJsonBrowser({ rows: [{ a: 'old', b: 'next' }, { a: 'other', b: 'last' }] }, async browser => {
            let state = await browser.operate([
                { kind: 'edit', col: 'a', value: 'first edit' },
                { kind: 'pointerOpen', col: 'b' },
            ]);
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'a').label, 'first edit');
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'a').editing, false);
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'b').editing, true);
            assert.deepStrictEqual(state.focusedCell, { row: 0, col: 'b' });
            assert.strictEqual(state.dirty, true);

            state = await browser.operate([
                { kind: 'edit', col: 'b', value: 'second edit' },
                { kind: 'pointerOpen', row: 1, col: 'a' },
            ]);
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'b').label, 'second edit');
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 1 && cell.col === 'a').editing, true);
            assert.deepStrictEqual(state.focusedCell, { row: 1, col: 'a' });

            const after = browser.messages.length;
            await browser.operate([
                { kind: 'edit', row: 1, col: 'a', value: 'third edit' },
                { kind: 'click', id: 'btnSave' },
            ]);
            assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                rows: [{ a: 'first edit', b: 'second edit' }, { a: 'third edit', b: 'last' }],
            });
        });
    });

    test('셀 blur 직후 Enter와 Space로 다른 셀을 열어 편집과 포커스를 이어 간다', async () => {
        await withJsonBrowser({ rows: [{ a: 'old', b: 'next' }, { a: 'other', b: 'last' }] }, async browser => {
            let state = await browser.operate([
                { kind: 'edit', col: 'a', value: 'first edit' },
                { kind: 'key', selector: 'td[data-row="0"][data-col="b"] .cell-view', key: 'Enter' },
            ]);
            assert.strictEqual(state.keyResults[0].prevented, true);
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'a').label, 'first edit');
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'b').editing, true);
            assert.deepStrictEqual(state.focusedCell, { row: 0, col: 'b' });

            state = await browser.operate([
                { kind: 'edit', col: 'b', value: 'second edit' },
                { kind: 'key', selector: 'td[data-row="1"][data-col="a"] .cell-view', key: ' ' },
            ]);
            assert.strictEqual(state.keyResults[0].prevented, true);
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 0 && cell.col === 'b').label, 'second edit');
            assert.strictEqual(state.cells.find((cell: any) => cell.row === 1 && cell.col === 'a').editing, true);
            assert.deepStrictEqual(state.focusedCell, { row: 1, col: 'a' });

            const after = browser.messages.length;
            await browser.operate([{ kind: 'click', id: 'btnSave' }]);
            assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                rows: [{ a: 'first edit', b: 'second edit' }, { a: 'other', b: 'last' }],
            });
        });
    });

    for (const activation of ['pointer', 'keyboard']) {
        test(`잘못된 JSON 셀에서 ${activation} 전환을 막고 수정 후 같은 동작으로 다음 셀을 연다`, async () => {
            await withJsonBrowser({ rows: [{ a: { nested: 1 }, b: 'next' }] }, async browser => {
                const openNext = activation === 'pointer'
                    ? { kind: 'pointerOpen', col: 'b' }
                    : { kind: 'key', selector: 'td[data-col="b"] .cell-view', key: 'Enter' };
                let state = await browser.operate([
                    { kind: 'edit', col: 'a', value: '{' },
                    openNext,
                ]);
                assert.strictEqual(state.cells.find((cell: any) => cell.col === 'a').editing, true);
                assert.strictEqual(state.cells.find((cell: any) => cell.col === 'a').input, '{');
                assert.strictEqual(state.cells.find((cell: any) => cell.col === 'b').editing, false);
                assert.deepStrictEqual(state.focusedCell, { row: 0, col: 'a' });
                assert.strictEqual(state.errorVisible, true);
                assert.strictEqual(state.dirty, true);
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), browser.initialText);

                state = await browser.operate([
                    { kind: 'edit', col: 'a', value: '{"nested":2}' },
                    openNext,
                ]);
                assert.strictEqual(state.cells.find((cell: any) => cell.col === 'a').editing, false);
                assert.deepStrictEqual(JSON.parse(state.cells.find((cell: any) => cell.col === 'a').input), { nested: 2 });
                assert.strictEqual(state.cells.find((cell: any) => cell.col === 'b').editing, true);
                assert.deepStrictEqual(state.focusedCell, { row: 0, col: 'b' });
                assert.strictEqual(state.errorVisible, false);

                const after = browser.messages.length;
                await browser.operate([
                    { kind: 'edit', col: 'b', value: 'continued edit' },
                    { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                    rows: [{ a: { nested: 2 }, b: 'continued edit' }],
                });
            });
        });
    }

    test('수정 없이 셀을 열고 확정해도 NUL·CR·CRLF·선행 LF와 배열 줄바꿈을 그대로 저장한다', async () => {
        const initial = { rows: [{
            nul: 'a\0b',
            cr: 'first\rsecond',
            crlf: 'first\r\nsecond',
            lf: '\nfirst\nsecond',
            tags: ['a\0b', 'second'],
            multilineTags: ['first\nsecond', 'first\r\nsecond', 'first\rsecond', 'a\0b', 1, true, null],
            object: { nested: 'a\0b' },
        }] };
        const cells = [
            { col: 'nul', value: initial.rows[0].nul, multiline: false },
            { col: 'cr', value: JSON.stringify(initial.rows[0].cr), multiline: true },
            { col: 'crlf', value: JSON.stringify(initial.rows[0].crlf), multiline: true },
            { col: 'lf', value: initial.rows[0].lf, multiline: true },
            { col: 'tags', value: initial.rows[0].tags[0], multiline: false },
            { col: 'multilineTags', value: JSON.stringify(initial.rows[0].multilineTags, null, 2), multiline: true },
            { col: 'object', value: JSON.stringify(initial.rows[0].object, null, 2), multiline: true },
        ];
        await withJsonBrowser(initial, async browser => {
            for (const cell of cells) {
                const opened = await browser.operate([{ kind: 'open', col: cell.col }]);
                assert.strictEqual(opened.cells.find((item: any) => item.col === cell.col).input, cell.value, cell.col);
                const selector = `td[data-col="${cell.col}"] .cell-edit ${cell.multiline ? 'textarea' : 'input'}`;
                const committed = await browser.operate([{ kind: 'key', selector, key: 'Enter', ctrlKey: cell.multiline }]);
                assert.strictEqual(committed.cells.find((item: any) => item.col === cell.col).editing, false, cell.col);
                assert.strictEqual(committed.dirty, false, `${cell.col}: 값을 수정하지 않으면 clean이어야 한다`);
            }
            const after = browser.messages.length;
            await browser.operate([{ kind: 'click', id: 'btnSave' }]);
            assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
            assert.deepStrictEqual(browser.messages.slice(after).find(message => message.command === 'save')?.data, initial);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), initial);
        });
    });

    test('NUL과 이스케이프된 줄바꿈 편집은 draft 복구·Undo/Redo·저장에서도 원문 문자를 유지한다', async () => {
        const initial = { rows: [{ value: 'old\0value', crlf: 'old\r\nvalue', tags: ['old\nvalue', 1, true, null] }] };
        const expected = { rows: [{ value: 'new\0value', crlf: 'new\r\nvalue', tags: ['new\nvalue', 'new\r\nvalue', 2, false, null] }] };
        await withJsonBrowser(initial, async browser => {
            await browser.operate([
                { kind: 'edit', col: 'value', value: expected.rows[0].value },
                { kind: 'key', selector: 'td[data-col="value"] input', key: 'Enter' },
                { kind: 'edit', col: 'tags', value: JSON.stringify(expected.rows[0].tags) },
                { kind: 'key', selector: 'td[data-col="tags"] textarea', key: 'Enter', ctrlKey: true },
                { kind: 'click', id: 'btnUndo' },
            ]);
            const undone = await browser.operate([{ kind: 'open', col: 'tags' }]);
            assert.deepStrictEqual(JSON.parse(undone.cells.find((cell: any) => cell.col === 'tags').input), initial.rows[0].tags);
            await browser.operate([
                { kind: 'key', selector: 'td[data-col="tags"] textarea', key: 'Escape' },
                { kind: 'click', id: 'btnRedo' },
                { kind: 'edit', col: 'crlf', value: JSON.stringify(expected.rows[0].crlf) },
            ]);
            const recovered = await browser.reopen();
            assert.strictEqual(recovered.dirty, true);
            assert.strictEqual(recovered.cells.find((cell: any) => cell.col === 'value').input, expected.rows[0].value);
            assert.strictEqual(JSON.parse(recovered.cells.find((cell: any) => cell.col === 'crlf').input), expected.rows[0].crlf);
            assert.deepStrictEqual(JSON.parse(recovered.cells.find((cell: any) => cell.col === 'tags').input), expected.rows[0].tags);
            const after = browser.messages.length;
            await browser.operate([{ kind: 'click', id: 'btnSave' }]);
            assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), expected);
        });
    });

    test('일반·배열·여러 줄·JSON 셀은 IME Enter/Escape 동안 입력을 유지하고 조합 종료 후 확정한다', async () => {
        const initial = { rows: [{ name: 'old', tags: ['old'], notes: 'old\nnotes', object: { nested: 1 } }] };
        const cells = [
            { col: 'name', selector: 'td[data-col="name"] input', value: '조합한 이름', multiline: false },
            { col: 'tags', selector: 'td[data-col="tags"] input', value: '조합한 항목', multiline: false },
            { col: 'notes', selector: 'td[data-col="notes"] textarea', value: '조합한\n메모', multiline: true },
            { col: 'object', selector: 'td[data-col="object"] textarea', value: '{"nested":2}', multiline: true },
        ];
        await withJsonBrowser(initial, async browser => {
            for (const cell of cells) {
                await browser.operate([{ kind: 'edit', col: cell.col, value: cell.value }]);
                for (const key of ['Enter', 'Escape']) {
                    const composing = await browser.operate([
                        { kind: 'key', selector: cell.selector, key, ctrlKey: cell.multiline, isComposing: true },
                    ]);
                    const actual = composing.cells.find((item: any) => item.col === cell.col);
                    assert.strictEqual(actual.editing, true, `${cell.col}: 조합 중 ${key}로 편집이 끝났다`);
                    assert.strictEqual(actual.input, cell.value, `${cell.col}: 조합 중 ${key}로 입력이 바뀌었다`);
                    assert.strictEqual(composing.keyResults[0].prevented, false);
                }
                const committed = await browser.operate([
                    { kind: 'key', selector: cell.selector, key: 'Enter', ctrlKey: cell.multiline },
                ]);
                assert.strictEqual(committed.cells.find((item: any) => item.col === cell.col).editing, false);
            }
            const after = browser.messages.length;
            await browser.operate([{ kind: 'click', id: 'btnSave' }]);
            assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                rows: [{ name: '조합한 이름', tags: ['조합한 항목'], notes: '조합한\n메모', object: { nested: 2 } }],
            });
        });
    });

    test('textarea는 Ctrl/Cmd+Enter로 확정하고 일반 Enter·IME 조합은 유지하며 잘못된 JSON은 막는다', async () => {
        await withJsonBrowser({ rows: [{ object: { nested: 1 }, notes: 'first\nsecond' }] }, async browser => {
            const selector = 'td[data-col="object"] textarea';
            let state = await browser.operate([
                { kind: 'edit', col: 'object', value: '{"nested":2}' },
                { kind: 'key', selector, key: 'Enter' },
            ]);
            assert.strictEqual(state.cells.find((cell: any) => cell.col === 'object').editing, true);
            assert.strictEqual(state.keyResults[0].prevented, false);
            state = await browser.operate([{ kind: 'key', selector, key: 'Enter', metaKey: true, isComposing: true }]);
            assert.strictEqual(state.cells.find((cell: any) => cell.col === 'object').editing, true);
            assert.strictEqual(state.keyResults[0].prevented, false);
            state = await browser.operate([{ kind: 'key', selector, key: 'Enter', metaKey: true }]);
            assert.strictEqual(state.cells.find((cell: any) => cell.col === 'object').editing, false);
            assert.strictEqual(state.keyResults[0].prevented, true);
            state = await browser.operate([
                { kind: 'edit', col: 'notes', value: 'changed\nnotes' },
                { kind: 'key', selector: 'td[data-col="notes"] textarea', key: 'Enter', ctrlKey: true },
            ]);
            assert.strictEqual(state.cells.find((cell: any) => cell.col === 'notes').editing, false);
            assert.strictEqual(state.keyResults[0].prevented, true);
            state = await browser.operate([
                { kind: 'edit', col: 'object', value: '{"nested":' },
                { kind: 'key', selector, key: 'Enter', metaKey: true },
            ]);
            assert.strictEqual(state.cells.find((cell: any) => cell.col === 'object').editing, true);
            assert.strictEqual(state.errorVisible, true);
            assert.strictEqual(state.keyResults[0].prevented, true);
            const after = browser.messages.length;
            await browser.operate([
                { kind: 'edit', col: 'object', value: '{"nested":3}' },
                { kind: 'key', selector, key: 'Enter', ctrlKey: true },
                { kind: 'click', id: 'btnSave' },
            ]);
            await browser.waitFor('saveAck', after);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                rows: [{ object: { nested: 3 }, notes: 'changed\nnotes' }],
            });
        });
    });

    test('다시 읽기의 복구 저장소 대기 중 입력한 활성 셀을 보존한다', async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let armed = false;
        try {
            await withJsonBrowser({ rows: [{ value: 'disk' }] }, async browser => {
                armed = true;
                await browser.operate([{ kind: 'click', id: 'btnReload' }]);
                await started;
                await browser.operate([{ kind: 'edit', col: 'value', value: 'new draft' }]);
                release();
                await browser.waitFor('host:loadData');
                const result = await browser.operate([]);
                assert.strictEqual(result.cells[0].input, 'new draft');
                assert.strictEqual(result.dirty, true);
                assert.strictEqual(jsonPanelRegistry.isDirty(), true);
                const recovered = await browser.reopen();
                assert.strictEqual(recovered.cells[0].label, 'new draft');
                assert.strictEqual(recovered.dirty, true);
                const after = browser.messages.length;
                await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                await browser.waitFor('saveAck', after);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: 'new draft' }] });
            }, { beforeRecoveryUpdate: async () => {
                if (armed) { armed = false; entered(); await gate; }
            } });
        } finally { release(); }
    });

    for (const trigger of ['toolbar', 'external'] as const) {
        test(`지연된 ${trigger} 다시 읽기를 거절하면 새 입력과 기존 루트 배열 형태를 보존한다`, async () => {
            const originalWatcher = vscode.workspace.createFileSystemWatcher;
            const originalWarning = vscode.window.showWarningMessage;
            let change!: (uri: vscode.Uri) => Promise<void>;
            const noEvent = () => new vscode.Disposable(() => {});
            vscode.workspace.createFileSystemWatcher = (() => ({
                onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
                onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
            })) as unknown as typeof originalWatcher;
            vscode.window.showWarningMessage = (async (_message: string, _options: unknown, overwrite: string) => overwrite) as typeof originalWarning;
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const started = new Promise<void>(resolve => { entered = resolve; });
            try {
                await withJsonBrowser([{ value: 'disk array' }], async browser => {
                    fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'external object' }] }));
                    if (trigger === 'toolbar') {
                        await browser.operate([{ kind: 'click', id: 'btnReload' }]);
                    } else {
                        await change(vscode.Uri.file(browser.filePath));
                    }
                    await started;
                    await browser.operate([{ kind: 'edit', col: 'value', value: 'kept array draft' }]);
                    release();
                    await browser.waitFor('host:loadData');
                    const ack = await browser.waitFor('loadAck');
                    assert.strictEqual(ack.accepted, false, '전송 중 생긴 입력 때문에 오래된 다시 읽기는 거절해야 한다');
                    const kept = await browser.operate([]);
                    assert.strictEqual(kept.cells[0].input, 'kept array draft');
                    assert.strictEqual(kept.dirty, true);
                    assert.strictEqual(jsonPanelRegistry.isDirty(), true);
                    const recovered = await browser.reopen();
                    assert.strictEqual(recovered.cells[0].label, 'kept array draft');
                    assert.strictEqual(recovered.dirty, true);
                    const after = browser.messages.length;
                    await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                    assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
                    assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), [{ value: 'kept array draft' }]);
                }, { beforeHostPost: async message => {
                    if (message.command === 'loadData') { entered(); await gate; }
                } });
            } finally {
                release();
                vscode.workspace.createFileSystemWatcher = originalWatcher;
                vscode.window.showWarningMessage = originalWarning;
            }
        });
    }

    test('다시 읽기 전송 중 연속된 invalid JSON 입력도 세대를 올려 원문 입력을 지킨다', async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        try {
            await withJsonBrowser({ rows: [{ value: { nested: 1 } }] }, async browser => {
                await browser.operate([{ kind: 'click', id: 'btnReload' }]);
                await started;
                await browser.operate([{ kind: 'edit', col: 'value', value: '{' }]);
                const before = browser.messages.length;
                await browser.operate([{ kind: 'edit', col: 'value', value: '{"nested":' }]);
                assert.ok(browser.messages.slice(before).some(message => message.command === 'editRevision'),
                    '이미 dirty이고 유효한 snapshot도 없는 입력을 호스트가 알아야 한다');
                release();
                assert.strictEqual((await browser.waitFor('loadAck')).accepted, false);
                const kept = await browser.operate([]);
                assert.strictEqual(kept.cells[0].input, '{"nested":');
                assert.strictEqual(kept.cells[0].editing, true);
                assert.strictEqual(kept.dirty, true);
                assert.strictEqual(jsonPanelRegistry.isDirty(), true);
                const savedAfter = browser.messages.length;
                await browser.operate([
                    { kind: 'edit', col: 'value', value: '{"nested":2}' }, { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual((await browser.waitFor('saveAck', savedAfter)).dirty, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: { nested: 2 } }] });
            }, { beforeHostPost: async message => {
                if (message.command === 'loadData') { entered(); await gate; }
            } });
        } finally { release(); }
    });

    test('외부 변경 안내 중 새 입력 후 다시 읽기를 선택해도 편집을 최신 파일 기준으로 복구한다', async () => {
        const originalWatcher = vscode.workspace.createFileSystemWatcher;
        const originalWarning = vscode.window.showWarningMessage;
        let change!: (uri: vscode.Uri) => Promise<void>;
        const noEvent = () => new vscode.Disposable(() => {});
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
            onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof originalWatcher;
        let answer!: () => void;
        let prompted!: () => void;
        const promptStarted = new Promise<void>(resolve => { prompted = resolve; });
        const warnings: string[] = [];
        vscode.window.showWarningMessage = ((_message: string, ...rest: unknown[]) => {
            warnings.push(_message);
            if (warnings.length > 1) { return Promise.resolve(rest.find(item => typeof item === 'string')); }
            prompted();
            return new Promise(resolve => { answer = () => resolve(rest.find(item => typeof item === 'string')); });
        }) as typeof originalWarning;
        try {
            await withJsonBrowser({ rows: [{ value: 'initial' }] }, async browser => {
                await browser.operate([{ kind: 'edit', col: 'value', value: 'before prompt' }]);
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'first external' }] }));
                const pending = change(vscode.Uri.file(browser.filePath));
                await promptStarted;
                await browser.operate([{ kind: 'edit', col: 'value', value: 'latest draft during prompt' }]);
                const latestDisk = JSON.stringify({ rows: [{ value: 'another external version while prompt is open' }] });
                fs.writeFileSync(browser.filePath, latestDisk);
                answer();
                await pending;
                assert.strictEqual((await browser.operate([])).cells[0].input, 'latest draft during prompt');
                assert.strictEqual(browser.messages.some(message => message.command === 'host:loadData'), false);
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), latestDisk);
                const recovered = await browser.reopen();
                assert.strictEqual(recovered.cells[0].label, 'latest draft during prompt');
                assert.strictEqual(recovered.dirty, true);
                assert.ok(warnings.slice(1).some(message => /편집 상태가 바뀌|editor state changed/.test(message)),
                    '편집 상태 변경 때문에 다시 읽기를 취소했다는 이유를 알려야 한다');
            });
        } finally {
            answer?.();
            vscode.workspace.createFileSystemWatcher = originalWatcher;
            vscode.window.showWarningMessage = originalWarning;
        }
    });

    test('미저장 상태에서 안내 뒤 다시 읽기를 고르면 안내 중 다시 바뀐 파일의 stat을 기준으로 삼아 이후 편집을 복구한다', async () => {
        const originalWatcher = vscode.workspace.createFileSystemWatcher;
        const originalWarning = vscode.window.showWarningMessage;
        const originalStatus = vscode.window.setStatusBarMessage;
        let change!: (uri: vscode.Uri) => Promise<void>;
        const noEvent = () => new vscode.Disposable(() => {});
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
            onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof originalWatcher;
        let answer!: () => void;
        let prompted!: () => void;
        const promptStarted = new Promise<void>(resolve => { prompted = resolve; });
        let promptCount = 0;
        vscode.window.showWarningMessage = ((_message: string, ...rest: unknown[]) => {
            if (++promptCount > 1) { return Promise.resolve(undefined); }
            prompted();
            // 첫 버튼이 "다시 읽기 (변경사항 버리기)"다.
            return new Promise(resolve => { answer = () => resolve(rest.find(item => typeof item === 'string')); });
        }) as typeof originalWarning;
        const statusMessages: string[] = [];
        vscode.window.setStatusBarMessage = ((text: string) => {
            statusMessages.push(text);
            return new vscode.Disposable(() => {});
        }) as typeof originalStatus;
        try {
            await withJsonBrowser({ rows: [{ value: 'initial' }] }, async browser => {
                await browser.operate([{ kind: 'edit', col: 'value', value: 'draft before external change' }]);
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'first external' }] }));
                const firstTime = new Date(Date.now() - 60_000);
                fs.utimesSync(browser.filePath, firstTime, firstTime);
                const pending = change(vscode.Uri.file(browser.filePath));
                await promptStarted;
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'second external, written while the prompt is open' }] }));
                const secondTime = new Date(Date.now() - 30_000);
                fs.utimesSync(browser.filePath, secondTime, secondTime);
                const loadedAfter = browser.messages.length;
                answer();
                await pending;
                await browser.waitFor('host:loadData', loadedAfter);
                const reloaded = await browser.operate([]);
                assert.strictEqual(reloaded.cells[0].label, 'second external, written while the prompt is open');
                assert.ok(!statusMessages.some(text => /자동|auto-reloaded/.test(text)),
                    '사용자가 직접 고른 다시 읽기를 자동 다시 읽기로 표시하지 않는다');

                await browser.operate([{ kind: 'edit', col: 'value', value: 'edit after reload' }]);
                const recovered = await browser.reopen();
                assert.strictEqual(recovered.cells[0].label, 'edit after reload',
                    '안내 전 stat으로 복구본을 찍으면 다시 열 때 오래된 것으로 버려진다');
                assert.strictEqual(recovered.dirty, true);
            });
        } finally {
            answer?.();
            vscode.workspace.createFileSystemWatcher = originalWatcher;
            vscode.window.showWarningMessage = originalWarning;
            vscode.window.setStatusBarMessage = originalStatus;
        }
    });

    test('외부 변경 안내 중 추가 입력 없이 저장한 뒤 다시 읽기를 선택해도 저장 상태를 유지하고 상태 변경으로 안내한다', async () => {
        const originalWatcher = vscode.workspace.createFileSystemWatcher;
        const originalWarning = vscode.window.showWarningMessage;
        let change!: (uri: vscode.Uri) => Promise<void>;
        const noEvent = () => new vscode.Disposable(() => {});
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
            onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof originalWatcher;
        let answer!: () => void;
        let prompted!: () => void;
        const promptStarted = new Promise<void>(resolve => { prompted = resolve; });
        const warnings: string[] = [];
        vscode.window.showWarningMessage = ((message: string, ...rest: unknown[]) => {
            warnings.push(message);
            if (warnings.length > 1) { return Promise.resolve(rest.find(item => typeof item === 'string')); }
            prompted();
            return new Promise(resolve => { answer = () => resolve(rest.find(item => typeof item === 'string')); });
        }) as typeof originalWarning;
        try {
            await withJsonBrowser({ rows: [{ value: 'initial' }] }, async browser => {
                await browser.operate([{ kind: 'edit', col: 'value', value: 'draft before prompt' }]);
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'external version' }] }));
                const pending = change(vscode.Uri.file(browser.filePath));
                await promptStarted;
                const after = browser.messages.length;
                const promptRevision = Math.max(...browser.messages.map(message => Number(message.revision) || 0));
                await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                const saved = await browser.waitFor('saveAck', after);
                assert.strictEqual(saved.dirty, false);
                assert.ok(saved.revision > promptRevision, '새 입력 없이 저장 처리만으로 revision이 바뀌어야 한다');
                assert.ok(browser.messages.slice(after).some(message => message.command === 'snapshot'));
                assert.ok(!browser.messages.slice(after).some(message => message.command === 'editRevision'),
                    '외부 변경 안내가 열린 뒤 추가 input 이벤트는 없어야 한다');
                answer();
                await pending;
                const result = await browser.operate([]);
                assert.strictEqual(result.cells[0].label, 'draft before prompt');
                assert.strictEqual(result.dirty, false);
                assert.strictEqual(browser.messages.some(message => message.command === 'host:loadData'), false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: 'draft before prompt' }] });
                const reopened = await browser.reopen();
                assert.strictEqual(reopened.cells[0].label, 'draft before prompt');
                assert.strictEqual(reopened.dirty, false);
                const notice = warnings.find(message => /편집 상태가 바뀌|editor state changed/.test(message));
                assert.ok(notice, '입력 대신 저장으로 바뀐 편집 상태도 사실에 맞게 안내해야 한다');
                assert.doesNotMatch(notice, /새 입력|new edits/);
            });
        } finally {
            answer?.();
            vscode.workspace.createFileSystemWatcher = originalWatcher;
            vscode.window.showWarningMessage = originalWarning;
        }
    });

    test('연속 외부 다시 읽기의 최신 제안이 거절되어도 새 편집을 최신 파일 기준으로 복구한다', async () => {
        const originalWatcher = vscode.workspace.createFileSystemWatcher;
        const originalWarning = vscode.window.showWarningMessage;
        let change!: (uri: vscode.Uri) => Promise<void>;
        const noEvent = () => new vscode.Disposable(() => {});
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
            onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof originalWatcher;
        vscode.window.showWarningMessage = (async (_message: string, ...rest: unknown[]) =>
            rest.find(item => typeof item === 'string')) as typeof originalWarning;
        const releases: Array<() => void> = [];
        let bothProposed!: () => void;
        const proposed = new Promise<void>(resolve => { bothProposed = resolve; });
        try {
            await withJsonBrowser({ rows: [{ value: 'initial' }] }, async browser => {
                await browser.operate([{ kind: 'edit', col: 'value', value: 'old draft' }]);
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'first external' }] }));
                await change(vscode.Uri.file(browser.filePath));
                fs.writeFileSync(browser.filePath, JSON.stringify({ rows: [{ value: 'second external with another size' }] }));
                await change(vscode.Uri.file(browser.filePath));
                await proposed;
                releases[0]();
                const first = await browser.waitFor('loadAck');
                assert.strictEqual(first.accepted, true);
                const after = browser.messages.length;
                releases[1]();
                const second = await browser.waitFor('loadAck', after);
                assert.strictEqual(second.accepted, false);
                await browser.operate([{ kind: 'edit', col: 'value', value: 'latest retained draft' }]);
                const recovered = await browser.reopen();
                assert.strictEqual(recovered.cells[0].label, 'latest retained draft');
                assert.strictEqual(recovered.dirty, true);
                const savedAfter = browser.messages.length;
                await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                assert.strictEqual((await browser.waitFor('saveAck', savedAfter)).dirty, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: 'latest retained draft' }] });
            }, { beforeHostPost: async message => {
                if (message.command !== 'loadData') { return; }
                await new Promise<void>(resolve => {
                    releases.push(resolve);
                    if (releases.length === 2) { bothProposed(); }
                });
            } });
        } finally {
            for (const release of releases) { release(); }
            vscode.workspace.createFileSystemWatcher = originalWatcher;
            vscode.window.showWarningMessage = originalWarning;
        }
    });

    test('승인된 외부 다시 읽기는 루트 형태와 저장 기준을 함께 바꾼다', async () => {
        const originalWatcher = vscode.workspace.createFileSystemWatcher;
        let change!: (uri: vscode.Uri) => Promise<void>;
        const noEvent = () => new vscode.Disposable(() => {});
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: (callback: typeof change) => { change = callback; return noEvent(); },
            onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof originalWatcher;
        try {
            await withJsonBrowser([{ value: 'original array' }], async browser => {
                const external = { rows: [{ value: 'loaded object' }] };
                fs.writeFileSync(browser.filePath, JSON.stringify(external));
                await change(vscode.Uri.file(browser.filePath));
                assert.strictEqual((await browser.waitFor('loadAck')).accepted, true);
                assert.strictEqual((await browser.operate([])).cells[0].label, 'loaded object');
                const after = browser.messages.length;
                await browser.operate([
                    { kind: 'edit', col: 'value', value: 'saved object' }, { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual((await browser.waitFor('saveAck', after)).dirty, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: 'saved object' }] });
            });
        } finally { vscode.workspace.createFileSystemWatcher = originalWatcher; }
    });

    test('외부 변경 덮어쓰기를 취소해도 표 편집과 dirty를 유지하고 재승인 후 저장한다', async () => {
        const watcher = vscode.workspace.createFileSystemWatcher;
        const warning = vscode.window.showWarningMessage;
        const noEvent = () => new vscode.Disposable(() => {});
        let approve = false;
        let confirmations = 0;
        vscode.workspace.createFileSystemWatcher = (() => ({
            onDidChange: noEvent, onDidCreate: noEvent, onDidDelete: noEvent, dispose() {},
        })) as unknown as typeof watcher;
        vscode.window.showWarningMessage = (async (_message: string, _options: unknown, overwrite: string) => {
            assert.match(overwrite, /외부 변경 덮어쓰기|Overwrite external change/);
            confirmations++;
            return approve ? overwrite : undefined;
        }) as typeof warning;
        try {
            await withJsonBrowser({ rows: [{ value: 'initial' }] }, async browser => {
                await browser.operate([{ kind: 'edit', col: 'value', value: 'table edit' }]);
                const external = JSON.stringify({ rows: [{ value: 'external' }] });
                fs.writeFileSync(browser.filePath, external);
                const first = browser.messages.length;
                await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                assert.strictEqual((await browser.waitFor('saveAck', first)).dirty, true);
                const kept = await browser.operate([]);
                assert.strictEqual(kept.dirty, true);
                assert.strictEqual(kept.cells[0].label, 'table edit');
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), external);
                approve = true;
                const retry = browser.messages.length;
                await browser.operate([{ kind: 'click', id: 'btnSave' }]);
                assert.strictEqual((await browser.waitFor('saveAck', retry)).dirty, false);
                assert.strictEqual((await browser.operate([])).dirty, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), { rows: [{ value: 'table edit' }] });
                assert.strictEqual(confirmations, 2);
            });
        } finally {
            vscode.workspace.createFileSystemWatcher = watcher;
            vscode.window.showWarningMessage = warning;
        }
    });


    test('표는 Tab 정지 하나로 들어오고 화살표·Home·End로 셀 사이를 이동한다', async () => {
        // 둘째 행의 a는 객체라 변환 버튼이 없다 — 행마다 항목 수가 달라도 ↑/↓는 열을 지켜야 한다.
        await withJsonBrowser({ rows: [{ a: 1, b: 2 }, { a: { k: 1 }, b: 4 }, { a: 5, b: 6 }] }, async browser => {
            const start = await browser.operate([]);
            assert.strictEqual(start.tableTabStops, 1, '셀마다 Tab 정지가 있으면 표를 지나가는 데만 수십 번을 눌러야 한다');
            const key = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'key', key: name, ...extra });
            let state = await browser.operate([{ kind: 'key', selector: 'td[data-row="0"][data-col="a"] .cell-view', key: 'ArrowRight' }]);
            assert.strictEqual(state.focused, 'convert:0:a', '셀 안의 변환 버튼도 화살표로 닿는다');
            assert.ok(state.keyResults[0].prevented, '화살표가 표를 스크롤하지 않고 이동만 한다');
            state = await browser.operate([key('ArrowRight')]);
            assert.strictEqual(state.focused, 'cell:0:b');
            state = await browser.operate([key('ArrowDown')]);
            assert.strictEqual(state.focused, 'cell:1:b');
            state = await browser.operate([key('ArrowRight'), key('ArrowRight')]);
            assert.strictEqual(state.focused, 'delete:1', '행의 마지막 항목은 ✕다');
            state = await browser.operate([key('Home')]);
            assert.strictEqual(state.focused, 'grip:1', '행의 첫 항목은 ⠿다');
            state = await browser.operate([key('End', { ctrlKey: true })]);
            assert.strictEqual(state.focused, 'delete:2');
            state = await browser.operate([key('Home', { ctrlKey: true })]);
            assert.strictEqual(state.focused, 'grip:0');
            assert.strictEqual(state.tableTabStops, 1, '이동한 위치가 다음 Tab 진입점이 된다');
            state = await browser.operate([key('ArrowDown')]);
            assert.strictEqual(state.focused, 'grip:1', '⠿에서는 ⠿끼리 이동한다');
            state = await browser.operate([{ kind: 'key', selector: 'td[data-row="0"][data-col="a"] .convert-btn', key: 'ArrowDown' }]);
            assert.strictEqual(state.focused, 'cell:1:a', '변환 버튼이 없는 행에서도 같은 열의 셀로 간다(✕가 아니다)');
            state = await browser.operate([{ kind: 'key', selector: 'td[data-row="0"][data-col="b"] .cell-view', key: 'ArrowUp' }]);
            assert.strictEqual(state.focused, 'cell:0:b', '첫 행에서 ↑는 제자리에 머문다');
            // 편집 중인 셀에서는 화살표가 입력 커서를 움직인다.
            state = await browser.operate([{ kind: 'open', col: 'a', row: 1 }, key('ArrowRight')]);
            assert.strictEqual(state.keyResults[0].prevented, false);
            assert.ok(state.cells.find((cell: { row: number; col: string; editing: boolean }) => cell.row === 1 && cell.col === "a")?.editing);
        });
    });

    test('IT-219: 실제 번들로 root 배열을 열고 활성 셀을 저장해 문자열·특수문자·들여쓰기를 보존한다', async () => {
        const specialKey = '키 "<&>';
        const specialValue = '</script><div id="unexpected-injection">한글 & "값" 😀</div>';
        const initial = [{ code: '001', count: 3, [specialKey]: specialValue, ['__proto__']: { role: 'admin' } }];
        await withJsonBrowser(initial, async browser => {
            assert.strictEqual(browser.ready.dirty, false);
            assert.strictEqual(browser.ready.injected, false, 'JSON 내용을 HTML로 실행하면 안 된다');
            assert.strictEqual(browser.ready.cells.length, 4);
            assert.ok(browser.ready.cells.some((cell: any) => cell.col === '__proto__'), '유효한 __proto__ 열을 잃으면 안 된다');
            assert.strictEqual(browser.ready.cells.find((cell: any) => cell.col === specialKey)?.label, specialValue);

            const after = browser.messages.length;
            await browser.operate([
                { kind: 'edit', col: 'code', value: '00042' },
                { kind: 'click', id: 'btnSave' },
            ]);
            const ack = await browser.waitFor('saveAck', after);
            assert.strictEqual(ack.dirty, false);
            const savedState = await browser.operate([]);
            assert.strictEqual(savedState.dirty, false);
            assert.strictEqual(jsonPanelRegistry.isDirty(), false);
            const expected = [{ ...initial[0], code: '00042' }];
            assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), JSON.stringify(expected, null, 4) + '\n');

            const undone = await browser.operate([{ kind: 'click', id: 'btnUndo' }]);
            assert.strictEqual(undone.cells.find((cell: any) => cell.col === 'code')?.label, '001');
            assert.strictEqual(undone.dirty, true);
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), expected, 'Undo는 디스크를 덮어쓰지 않는다');
            const redone = await browser.operate([{ kind: 'click', id: 'btnRedo' }]);
            assert.strictEqual(redone.cells.find((cell: any) => cell.col === 'code')?.label, '00042');
            assert.strictEqual(redone.dirty, false);
            assert.strictEqual(jsonPanelRegistry.isDirty(), false);
        });
    });

    test('IT-220: 실제 DOM의 잘못된 JSON 셀은 저장을 차단하고 수정 후 같은 패널에서 저장된다', async () => {
        for (const [original, updated] of [
            [{ enabled: true }, { enabled: false, count: 0 }],
            [[{ enabled: true }], [{ enabled: false, count: 0 }]],
        ]) {
            const initial = { rows: [{ config: original, name: '원본' }] };
            await withJsonBrowser(initial, async browser => {
                const after = browser.messages.length;
                const invalid = await browser.operate([
                    { kind: 'edit', col: 'config', value: '{"enabled":' },
                    { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual(invalid.dirty, true);
                assert.strictEqual(invalid.errorVisible, true);
                assert.match(invalid.error, /config/);
                assert.strictEqual(invalid.cells.find((cell: any) => cell.col === 'config')?.editing, true);
                assert.ok(!browser.messages.slice(after).some(message => message.command === 'save'));
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), browser.initialText);
                assert.strictEqual(jsonPanelRegistry.isDirty(), true);

                const retryStart = browser.messages.length;
                await browser.operate([
                    { kind: 'edit', col: 'config', value: JSON.stringify(updated) },
                    { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual((await browser.waitFor('saveAck', retryStart)).dirty, false);
                const saved = await browser.operate([]);
                assert.strictEqual(saved.dirty, false);
                assert.strictEqual(saved.errorVisible, false, '셀을 고쳐 저장한 뒤 이전 JSON 오류를 남기면 안 된다');
                assert.strictEqual(jsonPanelRegistry.isDirty(), false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), {
                    rows: [{ config: updated, name: '원본' }],
                });
            });
        }
    });

    test('IT-225: 지원 불가 숫자의 셀 입력은 원문을 보존하고 수정한 뒤 저장된다', async () => {
        const initial = { rows: [{ id: 1, config: { id: 1 }, values: [1], text: '9007199254740993' }] };
        await withJsonBrowser(initial, async browser => {
            for (const [col, invalidValue, corrected] of [
                ['id', '9007199254740993', '1'],
                ['id', '0.1234567890123456789', '1'],
                ['config', '{"id":1e400}', '{"id":1}'],
                ['values', '9007199254740993', '1'],
            ]) {
                const before = browser.messages.length;
                const invalid = await browser.operate([
                    { kind: 'edit', col, value: invalidValue }, { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual(invalid.errorVisible, true, col);
                assert.match(invalid.error, /정확하게 보존|preserved exactly/);
                assert.strictEqual(invalid.dirty, true);
                assert.ok(!browser.messages.slice(before).some(message => message.command === 'save'));
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), browser.initialText);
                const retry = browser.messages.length;
                await browser.operate([{ kind: 'edit', col, value: corrected }, { kind: 'click', id: 'btnSave' }]);
                assert.strictEqual((await browser.waitFor('saveAck', retry)).dirty, false);
                assert.strictEqual((await browser.operate([])).errorVisible, false);
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(browser.filePath, 'utf8')), initial);
            }
        });
    });

    test('IT-226: __proto__ 복구 baseline과 셀을 보존하여 편집과 저장을 왕복한다', async () => {
        const initial = JSON.parse('{"rows":[{"__proto__":{"role":"admin"},"name":"old"}]}');
        const recovered = JSON.parse('{"rows":[{"__proto__":{"role":"admin"},"name":"draft"}]}');
        await withJsonBrowser(initial, async browser => {
            assert.strictEqual(browser.ready.dirty, true);
            const reverted = await browser.operate([
                { kind: 'edit', col: 'name', value: 'old' }, { kind: 'click', id: 'btnAddField' },
            ]);
            assert.strictEqual(reverted.dirty, false, 'saved baseline의 __proto__ 키까지 같아야 clean이다');
            assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'), browser.initialText);
            const before = browser.messages.length;
            await browser.operate([
                { kind: 'edit', col: '__proto__', value: '{"role":"user","constructor":"literal"}' },
                { kind: 'click', id: 'btnSave' },
            ]);
            assert.strictEqual((await browser.waitFor('saveAck', before)).dirty, false);
            const saved = JSON.parse(fs.readFileSync(browser.filePath, 'utf8'));
            assert.strictEqual(Object.getPrototypeOf(saved.rows[0]), Object.prototype);
            assert.ok(Object.hasOwn(saved.rows[0], '__proto__'));
            assert.deepStrictEqual(saved.rows[0].__proto__, { role: 'user', constructor: 'literal' });
            assert.strictEqual(saved.rows[0].name, 'old');
        }, { recoveryData: recovered });
    });

    test('IT-228: 열린 파일이 10MB를 넘어도 크기를 늘리거나 줄이며 연속 저장된다', async function () {
        this.timeout(60000);
        const limit = 10 * 1024 * 1024;
        const initial = { rows: [{ label: 'base' }], padding: '' };
        const overhead = Buffer.byteLength(JSON.stringify(initial, null, 4) + '\n', 'utf8');
        // 표에 표시하지 않는 속성으로 실제 파일 크기를 경계 바로 아래에 둔다.
        initial.padding = 'a'.repeat(limit - overhead - 1);
        await withJsonBrowser(initial, async browser => {
            assert.strictEqual(fs.statSync(browser.filePath).size, limit - 1);
            const oversize = { ...initial, rows: [{ label: '한글' }] };
            const oversizeText = JSON.stringify(oversize, null, 4) + '\n';
            assert.ok(oversizeText.length < limit, 'UTF-8 바이트 수가 문자 수보다 큰 경계 사례');
            assert.strictEqual(Buffer.byteLength(oversizeText, 'utf8'), limit + 1);

            // 첫 저장으로 한도를 넘고, 큰 디스크 파일에 다시 저장한 뒤 한도 아래로 줄인다.
            for (const label of ['한글', '한글다음', 'x']) {
                const retry = browser.messages.length;
                await browser.operate([
                    { kind: 'edit', col: 'label', value: label }, { kind: 'click', id: 'btnSave' },
                ]);
                assert.strictEqual((await browser.waitFor('saveAck', retry)).dirty, false);
                const saved = await browser.operate([]);
                assert.strictEqual(saved.dirty, false);
                assert.strictEqual(jsonPanelRegistry.isDirty(), false);
                assert.strictEqual(saved.cells.find((cell: any) => cell.col === 'label')?.label, label);
                assert.strictEqual(fs.readFileSync(browser.filePath, 'utf8'),
                    JSON.stringify({ ...initial, rows: [{ label }] }, null, 4) + '\n');
                assert.strictEqual(fs.statSync(browser.filePath).size > limit, label !== 'x');
            }
        });
    });
});
