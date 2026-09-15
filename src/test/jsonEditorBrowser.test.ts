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
        });
        window.addEventListener('error', event => api.postMessage({ command: 'testError', error: event.message }));
        window.addEventListener('unhandledrejection', event => api.postMessage({ command: 'testError', error: String(event.reason) }));
        document.addEventListener('DOMContentLoaded', () => {
            api.postMessage({ command: 'testReady', ...inspect() });
        }, { once: true });
        window.addEventListener('message', event => {
            if (event.data?.command !== 'testOperate') { return; }
            try {
                for (const operation of event.data.operations) {
                    if (operation.kind === 'edit') {
                        const td = Array.from(document.querySelectorAll('td[data-row]'))
                            .find(cell => Number(cell.dataset.row) === (operation.row ?? 0) && cell.dataset.col === operation.col);
                        if (!td) { throw new Error('Missing editable cell: ' + operation.col); }
                        td.querySelector('.cell-view').click();
                        const input = td.querySelector('.cell-edit input, .cell-edit textarea');
                        input.value = operation.value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (operation.kind === 'click') {
                        required('#' + operation.id).click();
                    }
                }
                api.postMessage({ command: 'testResult', request: event.data.request, ...inspect() });
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
        operate(operations: Array<Record<string, unknown>>): Promise<BrowserMessage>;
        waitFor(command: string, after?: number): Promise<BrowserMessage>;
    }) => Promise<void>,
    options: { recoveryData?: unknown; expectedErrors?: RegExp[] } = {},
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
            Promise.resolve(options.recoveryData === undefined ? undefined : buttons.find(button => typeof button === 'string'));
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
                update: async (key: string, value: unknown) => { store.set(key, value); },
            },
        } as unknown as vscode.ExtensionContext;
        await openJsonEditorFile(context, filePath);
        assert.ok(panel, `JSON Editor did not open: ${errors.join(', ')}`);
        const ready = await waitFor('testReady');
        assert.strictEqual(ready.errorVisible, false, ready.error);
        await body({
            filePath, initialText, messages, ready, waitFor,
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
