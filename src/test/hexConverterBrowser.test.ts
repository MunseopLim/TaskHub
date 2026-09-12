import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    buildHexConverterHtml,
    buildHexConverterStrings,
    hexConverterPanelRegistry,
    HexConverterPreferences,
    normalizeHexConverterSavedValues,
    showHexConverter,
} from '../hexConverter';

interface ConverterBrowserAction {
    selector: string;
    value?: string;
    event?: 'input' | 'change' | 'blur';
    click?: boolean;
}

/** 실제 패널·HTML·CSP·메시지 핸들러를 연결하고 외부 저장소와 클립보드만 격리한다. */
async function withConverterBrowser(body: (browser: {
    act(actions: ConverterBrowserAction[], responseCommand?: string): Promise<any>;
    reload(preferences?: HexConverterPreferences): Promise<any>;
    copied: string[];
    persisted: Map<string, unknown>;
    failClipboard: () => void;
    failStorage: (fail: boolean) => void;
}) => Promise<void>): Promise<void> {
    hexConverterPanelRegistry.clear();
    const originalCreate = vscode.window.createWebviewPanel;
    const originalClipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
    assert.ok(originalClipboard, '클립보드 속성을 복원할 수 있어야 한다');
    const copied: string[] = [];
    const persisted = new Map<string, unknown>();
    let clipboardFails = false;
    let storageFails = false;
    let panel: vscode.WebviewPanel | undefined;
    let subscription: vscode.Disposable | undefined;
    let nextStage = 0;
    let browserError: Error | undefined;
    const pending = new Map<string, {
        resolve: (state: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const waitFor = (stage: string): Promise<any> => new Promise((resolve, reject) => {
        if (browserError) { reject(browserError); return; }
        const timer = setTimeout(() => {
            pending.delete(stage);
            reject(new Error(`Hex Converter browser timed out: ${stage}`));
        }, 15000);
        pending.set(stage, { resolve, reject, timer });
    });
    function instrument(html: string, stage: string): string {
        const scriptTag = html.match(/<script nonce="[^"]+">/)?.[0];
        assert.ok(scriptTag, 'Hex Converter script tag');
        // 관찰자도 제품 CSP의 nonce를 사용한다. 제품 스크립트나 API를 대체하지 않는다.
        return html.replace(scriptTag, `${scriptTag}
        (() => {
            const api = acquireVsCodeApi();
            window.acquireVsCodeApi = () => api;
            let awaitingResponse;
            const report = stage => {
                const element = id => document.getElementById(id);
                api.postMessage({ command: 'testConverterState', stage, state: {
                    values: Object.fromEntries([
                        'textInput', 'hexInput', 'encoding', 'hexGroup', 'bytesPerRow', 'endian',
                        'bitwiseExpression', 'bitwiseWidth',
                    ].map(id => [id, element(id).value])),
                    disabled: Object.fromEntries([
                        'copyText', 'copyHex', 'saveText', 'saveHex', 'copyBitwiseDecimal',
                    ].map(id => [id, element(id).disabled])),
                    status: element('statusText').textContent,
                    error: element('status').classList.contains('is-error'),
                    bitwiseStatus: element('bitwiseStatus').textContent,
                    bitwiseDecimal: element('bitwiseDecimal').textContent,
                    offsets: element('hexOffsets').textContent,
                    previews: Array.from(document.querySelectorAll('.saved-preview')).map(item => item.textContent),
                    savedMarkupCount: document.querySelectorAll('#savedList img, #savedList script').length,
                    savedState: api.getState(),
                } });
            };
            const fail = error => api.postMessage({ command: 'testConverterError', error: String(error) });
            window.addEventListener('error', event => fail(event.message));
            window.addEventListener('unhandledrejection', event => fail(event.reason));
            window.addEventListener('message', event => {
                const message = event.data;
                if (message?.command === 'testConverterAction') {
                    try {
                        awaitingResponse = message.responseCommand ? message : undefined;
                        for (const action of message.actions) {
                            const target = document.querySelector(action.selector);
                            if (!target) { throw new Error('Missing control: ' + action.selector); }
                            if (action.value !== undefined) { target.value = action.value; }
                            if (action.event) { target.dispatchEvent(new Event(action.event, { bubbles: true })); }
                            if (action.click) { target.click(); }
                        }
                        if (!message.responseCommand) { report(message.stage); }
                    } catch (error) { fail(error); }
                } else if (awaitingResponse?.responseCommand === message?.command) {
                    const stage = awaitingResponse.stage;
                    awaitingResponse = undefined;
                    // 제품의 host 응답 리스너가 DOM을 갱신한 뒤 결과를 읽는다.
                    setTimeout(() => report(stage), 0);
                }
            });
            document.addEventListener('DOMContentLoaded', () => report(${JSON.stringify(stage)}), { once: true });
        })();
        </script>${scriptTag}`);
    }
    try {
        Object.defineProperty(vscode.env, 'clipboard', {
            configurable: true,
            value: { writeText: async (value: string) => {
                if (clipboardFails) { throw new Error('clipboard unavailable'); }
                copied.push(value);
            } },
        });
        (vscode.window as any).createWebviewPanel = (...args: Parameters<typeof originalCreate>) => {
            panel = originalCreate(...args);
            return panel;
        };
        const context = {
            globalState: {
                get(key: string, fallback: unknown) { return persisted.has(key) ? persisted.get(key) : fallback; },
                async update(key: string, value: unknown) {
                    if (storageFails) { throw new Error('storage unavailable'); }
                    persisted.set(key, JSON.parse(JSON.stringify(value)));
                },
            },
        } as unknown as vscode.ExtensionContext;
        showHexConverter(context);
        (vscode.window as any).createWebviewPanel = originalCreate;
        assert.ok(panel, '실제 Hex Converter 패널을 만들지 않았다');
        const webview = panel.webview;
        subscription = webview.onDidReceiveMessage(message => {
            if (message.command === 'testConverterError') {
                browserError = new Error(`Hex Converter browser script failed: ${message.error}`);
                for (const request of pending.values()) {
                    clearTimeout(request.timer);
                    request.reject(browserError);
                }
                pending.clear();
            } else if (message.command === 'testConverterState') {
                const request = pending.get(message.stage);
                if (!request) { return; }
                clearTimeout(request.timer);
                pending.delete(message.stage);
                request.resolve(message.state);
            }
        });
        const initialStage = `initial-${nextStage++}`;
        const initial = waitFor(initialStage);
        webview.html = instrument(webview.html, initialStage);
        await initial;
        await body({
            async act(actions, responseCommand) {
                const stage = `action-${nextStage++}`;
                const result = waitFor(stage);
                void webview.postMessage({ command: 'testConverterAction', stage, actions, responseCommand });
                return result;
            },
            async reload(preferences) {
                const stage = `reload-${nextStage++}`;
                const result = waitFor(stage);
                webview.html = instrument(buildHexConverterHtml(
                    webview,
                    normalizeHexConverterSavedValues(persisted.get('taskhub.hexConverter.savedValues.v1')),
                    preferences,
                ), stage);
                return result;
            },
            copied,
            persisted,
            failClipboard: () => { clipboardFails = true; },
            failStorage: fail => { storageFails = fail; },
        });
        if (browserError) { throw browserError; }
    } finally {
        for (const request of pending.values()) { clearTimeout(request.timer); }
        pending.clear();
        subscription?.dispose();
        hexConverterPanelRegistry.clear();
        panel?.dispose();
        (vscode.window as any).createWebviewPanel = originalCreate;
        Object.defineProperty(vscode.env, 'clipboard', originalClipboard);
    }
}

suite('Hex/Text 변환기 실제 브라우저', () => {
    test('IT-221: 실제 입력·64비트 복사·실패 응답과 탭 재로드가 변환값을 보존한다', async function () {
        this.timeout(45000);
        const strings = buildHexConverterStrings();
        await withConverterBrowser(async browser => {
            const text = '가🙂\nA';
            const hex = Array.from(Buffer.from(text), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            let state = await browser.act([{ selector: '#textInput', value: text, event: 'input' }]);
            assert.strictEqual(state.values.hexInput, hex, '실제 UTF-8 변환값');
            assert.strictEqual(state.disabled.copyHex, false);
            state = await browser.act([{ selector: '#copyHex', click: true }], 'copyResult');
            assert.deepStrictEqual(browser.copied, [hex]);
            assert.strictEqual(state.status, strings.copiedHex);
            assert.strictEqual(state.error, false);

            state = await browser.act([{ selector: '#hexInput', value: 'FF', event: 'input' }]);
            assert.strictEqual(state.values.textInput, '');
            assert.strictEqual(state.disabled.copyText, true);
            assert.strictEqual(state.error, true);
            assert.strictEqual(state.status, strings.invalidUtf8);

            state = await browser.act([
                { selector: '#hexInput', value: '41 42 43 44 45', event: 'input' },
                { selector: '#hexGroup', value: '4', event: 'change' },
                { selector: '#bytesPerRow', value: '8', event: 'change' },
                { selector: '#endian', value: 'big', event: 'change' },
                { selector: '#bitwiseWidth', value: '64', event: 'change' },
                { selector: '#bitwiseExpression', value: '~0', event: 'input' },
            ]);
            assert.strictEqual(state.values.hexInput, '41424344 45');
            assert.strictEqual(state.values.textInput, 'ABCDE');
            assert.strictEqual(state.bitwiseDecimal, '18446744073709551615');
            state = await browser.act([{ selector: '#copyBitwiseDecimal', click: true }], 'bitwiseCopyResult');
            assert.strictEqual(browser.copied.at(-1), '18446744073709551615');
            assert.strictEqual(state.bitwiseStatus, strings.bitwiseCopied);

            const savedState = state.savedState;
            state = await browser.reload({ encoding: 'ascii', hexGroup: 1, endian: 'little' });
            assert.deepStrictEqual(state.savedState, savedState, '실제 탭 상태가 새 기본값보다 우선해야 한다');
            assert.strictEqual(state.values.hexInput, '41424344 45');
            assert.strictEqual(state.values.textInput, 'ABCDE');
            assert.strictEqual(state.bitwiseDecimal, '18446744073709551615');
            assert.strictEqual(state.offsets, '0x00000000');
            browser.failClipboard();
            state = await browser.act([{ selector: '#copyText', click: true }], 'copyResult');
            assert.strictEqual(state.status, strings.copyFailed);
            assert.strictEqual(state.error, true);
            assert.strictEqual(state.values.textInput, 'ABCDE');
            assert.deepStrictEqual(browser.copied, [hex, '18446744073709551615']);
        });
    });

    test('IT-222: 저장값의 HTML 문자는 실제 DOM에서 텍스트로 복원되고 저장 실패 후 재시도가 동작한다', async function () {
        this.timeout(45000);
        const strings = buildHexConverterStrings();
        const key = 'taskhub.hexConverter.savedValues.v1';
        const value = '</script><img src=x onerror="alert(1)"> & \'quoted\'';
        await withConverterBrowser(async browser => {
            await browser.act([{ selector: '#textInput', value, event: 'input' }]);
            browser.failStorage(true);
            let state = await browser.act([{ selector: '#saveText', click: true }], 'saveResult');
            assert.strictEqual(state.status, strings.saveFailed);
            assert.strictEqual(state.error, true);
            assert.deepStrictEqual(state.previews, []);
            assert.strictEqual(browser.persisted.has(key), false);
            assert.strictEqual(state.values.textInput, value);

            browser.failStorage(false);
            state = await browser.act([{ selector: '#saveText', click: true }], 'savedValues');
            assert.strictEqual(state.status, strings.saved);
            const savedValues = normalizeHexConverterSavedValues(browser.persisted.get(key));
            assert.strictEqual(savedValues.length, 1);
            assert.strictEqual(savedValues[0].value, value);
            assert.strictEqual(savedValues[0].byteCount, Buffer.byteLength(value));
            assert.strictEqual(state.savedMarkupCount, 0);
            assert.deepStrictEqual(state.previews, [JSON.stringify(value).slice(1, -1)]);

            await browser.act([{ selector: '#clearButton', click: true }]);
            state = await browser.reload();
            assert.strictEqual(state.values.textInput, '');
            assert.strictEqual(state.savedMarkupCount, 0, '초기 JSON과 innerHTML 어느 쪽에서도 태그가 생성되면 안 된다');
            assert.deepStrictEqual(state.previews, [JSON.stringify(value).slice(1, -1)]);
            // 버튼의 자식 클릭도 실제 DOM 이벤트 버블링과 closest를 거쳐 불러와야 한다.
            state = await browser.act([{ selector: '.saved-preview', click: true }]);
            assert.strictEqual(state.status, strings.loaded);
            assert.strictEqual(state.values.textInput, value);
            assert.strictEqual(Buffer.from(state.values.hexInput.replace(/\s/g, ''), 'hex').toString('utf8'), value);

            browser.failStorage(true);
            state = await browser.act([{ selector: '.saved-delete', click: true }], 'saveResult');
            assert.strictEqual(state.error, true);
            assert.strictEqual(state.previews.length, 1, '삭제 저장 실패 시 목록을 먼저 지우면 안 된다');
            assert.deepStrictEqual(browser.persisted.get(key), savedValues);
            browser.failStorage(false);
            state = await browser.act([{ selector: '.saved-delete', click: true }], 'savedValues');
            assert.strictEqual(state.status, strings.deleted);
            assert.strictEqual(state.error, false);
            assert.deepStrictEqual(state.previews, []);
            assert.deepStrictEqual(browser.persisted.get(key), []);
        });
    });
});
