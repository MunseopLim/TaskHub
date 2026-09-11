import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildHexViewerHtml, buildHexViewerStrings, HexViewerPreferences, postHexViewerData } from '../hexViewer';
import { HexParseResult, parseBinary, parseIntelHex, parseSrec } from '../hexParser';

interface BrowserLoadingPhase {
    defaults?: HexViewerPreferences;
    expectedPreferences?: HexViewerPreferences;
    expectedCells?: string[];
    change?: { preferences: HexViewerPreferences; expectedCells: string[] };
}

/**
 * HTML을 실제 Chromium 웹뷰에 넣는다. 문자열을 VM에서 곧바로 실행하면
 * HTML tokenizer의 NUL → U+FFFD 치환으로 생기는 스크립트 구문 오류를 놓친다.
 * 관찰용 스크립트만 앞에 추가하며 제품의 HTML·CSP·스크립트는 그대로 실행한다.
 */
async function checkBrowserLoading(
    fileName: string,
    result: HexParseResult,
    phases: BrowserLoadingPhase[] = [{}],
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'taskhub.test.hexLoading', 'Hex loading regression', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    let subscription: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        for (const [phaseIndex, phase] of phases.entries()) {
            const commands: string[] = [];
            const preferenceMessages: unknown[] = [];
            const expectedPreferences = phase.expectedPreferences ?? phase.defaults
                ?? { unitSize: 1, endian: 'little', findMode: 'value' };
            const expectedCells = phase.expectedCells ?? ['DE', 'AD', 'BE', 'EF'];
            const deliveryId = `browser-loading-regression-${phaseIndex}`;
            const html = buildHexViewerHtml(fileName, result, panel.webview, deliveryId, phase.defaults);
            const scriptTag = html.match(/<script nonce="[^"]+">/)?.[0];
            assert.ok(scriptTag, 'Hex Viewer script tag');
            const observer = `${scriptTag}
            (() => {
                const api = acquireVsCodeApi();
                // API는 문서당 한 번만 획득할 수 있다. 제품에는 같은 실제 API를 넘긴다.
                window.acquireVsCodeApi = () => api;
                window.addEventListener('error', event => {
                    api.postMessage({ command: 'testError', error: event.message });
                });
                window.addEventListener('unhandledrejection', event => {
                    api.postMessage({ command: 'testError', error: String(event.reason) });
                });
                window.addEventListener('message', event => {
                    if (!['testInspect', 'testChangePreferences'].includes(event.data?.command)) { return; }
                    if (event.data.command === 'testChangePreferences') {
                        for (const id of ['unitSize', 'endian', 'findMode']) {
                            const select = document.getElementById(id);
                            select.value = String(event.data.preferences[id]);
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                    const loading = document.getElementById('hexLoading');
                    api.postMessage({
                        command: 'testState', stage: event.data.stage,
                        loadingDisplay: getComputedStyle(loading).display,
                        loadingText: loading.textContent,
                        cells: Array.from(document.querySelectorAll('#hexBody .hex-cell[data-offset]'))
                            .map(cell => cell.textContent),
                        address: document.querySelector('#hexBody .addr-cell')?.textContent,
                        preferences: {
                            unitSize: Number(document.getElementById('unitSize').value),
                            endian: document.getElementById('endian').value,
                            findMode: document.getElementById('findMode').value,
                        },
                        savedState: api.getState(),
                    });
                });
            })();
            </script>`;
            await new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(
                    `Hex Viewer browser initialization timed out (${fileName}, phase ${phaseIndex}): ${commands.join(', ')}`
                )), 20000);
                subscription = panel.webview.onDidReceiveMessage(message => {
                    commands.push(message.command);
                    try {
                        if (message.command === 'testError') {
                            throw new Error(`Hex Viewer browser script failed (${fileName}): ${message.error}`);
                        }
                        if (message.command === 'ready') {
                            void panel.webview.postMessage({ command: 'testInspect', stage: 'before' });
                        } else if (message.command === 'testState' && message.stage === 'before') {
                            assert.notStrictEqual(message.loadingDisplay, 'none');
                            assert.strictEqual(message.loadingText, buildHexViewerStrings().loading);
                            assert.deepStrictEqual(message.cells, []);
                            postHexViewerData(panel.webview, result, undefined, deliveryId);
                        } else if (message.command === 'dataReceived') {
                            assert.strictEqual(message.deliveryId, deliveryId);
                            void panel.webview.postMessage({ command: 'testInspect', stage: 'after' });
                        } else if (message.command === 'testState' && message.stage === 'after') {
                            assert.strictEqual(message.loadingDisplay, 'none');
                            assert.deepStrictEqual(message.cells, expectedCells);
                            assert.strictEqual(message.address, '0x00000000');
                            assert.deepStrictEqual(message.preferences, expectedPreferences);
                            assert.deepStrictEqual(message.savedState, expectedPreferences);
                            assert.deepStrictEqual(commands, ['ready', 'testState', 'dataReceived', 'testState']);
                            if (phase.change) {
                                void panel.webview.postMessage({
                                    command: 'testChangePreferences', stage: 'changed', preferences: phase.change.preferences,
                                });
                            } else {
                                resolve();
                            }
                        } else if (message.command === 'updatePreferences') {
                            preferenceMessages.push(message);
                        } else if (message.command === 'testState' && message.stage === 'changed') {
                            assert.ok(phase.change, 'Preference changes must belong to the current phase');
                            const changedPreferences = phase.change.preferences;
                            assert.strictEqual(message.loadingDisplay, 'none');
                            assert.deepStrictEqual(message.cells, phase.change.expectedCells);
                            assert.deepStrictEqual(message.preferences, changedPreferences);
                            assert.deepStrictEqual(message.savedState, changedPreferences);
                            assert.deepStrictEqual(preferenceMessages, [
                                { command: 'updatePreferences', ...expectedPreferences, unitSize: changedPreferences.unitSize },
                                { command: 'updatePreferences', ...expectedPreferences,
                                    unitSize: changedPreferences.unitSize, endian: changedPreferences.endian },
                                { command: 'updatePreferences', ...changedPreferences },
                            ]);
                            assert.deepStrictEqual(commands, [
                                'ready', 'testState', 'dataReceived', 'testState',
                                'updatePreferences', 'updatePreferences', 'updatePreferences', 'testState',
                            ]);
                            resolve();
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
                // observer도 원래 CSP의 nonce를 사용하고, 구독 뒤 HTML을 설정한다.
                panel.webview.html = html.replace(scriptTag, observer + scriptTag);
            });
            clearTimeout(timer);
            subscription?.dispose();
        }
    } finally {
        clearTimeout(timer);
        subscription?.dispose();
        panel.dispose();
    }
}

suite('Hex Viewer 실제 브라우저 초기화', () => {
    test('IT-216: BIN·HEX·SREC 웹뷰가 ready 이후 데이터를 받아 Loading을 닫고 바이트를 표시한다', async function () {
        this.timeout(70000);
        for (const [fileName, result] of [
            ['sample.bin', parseBinary(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]))],
            ['sample.hex', parseIntelHex(':04000000DEADBEEFC4\n:00000001FF')],
            ['sample.srec', parseSrec('S1070000DEADBEEFC0\nS9030000FC')],
        ] as const) {
            assert.strictEqual(result.byteCount, 4, fileName);
            await checkBrowserLoading(fileName, result);
        }
    });

    test('IT-217: 마지막 설정을 실제 웹뷰 첫 렌더와 탭 상태에 적용한다', async function () {
        this.timeout(25000);
        await checkBrowserLoading(
            'preferences.bin', parseBinary(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])),
            [{ defaults: { unitSize: 2, endian: 'big', findMode: 'ascii' }, expectedCells: ['DEAD', 'BEEF'] }],
        );
    });

    test('IT-218: 실제 UI 설정 변경을 저장하고 같은 탭 재로드 시 새 기본값보다 우선 복원한다', async function () {
        this.timeout(45000);
        const tabPreferences: HexViewerPreferences = { unitSize: 2, endian: 'big', findMode: 'ascii' };
        await checkBrowserLoading(
            'preferences-reload.bin', parseBinary(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])),
            [
                { change: { preferences: tabPreferences, expectedCells: ['DEAD', 'BEEF'] } },
                {
                    defaults: { unitSize: 4, endian: 'little', findMode: 'bytes' },
                    expectedPreferences: tabPreferences,
                    expectedCells: ['DEAD', 'BEEF'],
                },
            ],
        );
    });
});
