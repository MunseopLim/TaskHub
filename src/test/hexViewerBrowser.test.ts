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

async function checkBrowserNavigation(compact = false): Promise<void> {
    const tailOffset = 64 * 1024;
    const bytes = Buffer.alloc(tailOffset + 3);
    bytes.set([0xDE, 0xAD, 0xBE], tailOffset);
    const result = parseBinary(bytes);
    const panel = vscode.window.createWebviewPanel(
        'taskhub.test.hexNavigation', 'Hex navigation regression', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    let subscription: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const deliveryId = 'browser-navigation';
        let html = buildHexViewerHtml('navigation.bin', result, panel.webview, deliveryId, {
            unitSize: 4, endian: 'little', findMode: 'bytes',
        });
        if (compact) {
            // Windows CI의 좁은 창과 실제 행 높이를 모든 OS에서 재현한다.
            // 제품 스크립트·CSP는 유지하고, 테스트 문서의 크기·글꼴·스크롤바만 고정한다.
            html = html.replace('</head>', `<style>
                body { width: 464px; height: 388px; font-size: 14px; font-family: monospace; }
                #hexContainer::-webkit-scrollbar { width: 15px; height: 15px; }
                #hexContainer::-webkit-scrollbar-thumb { background: #808080; }
            </style></head>`);
        }
        const scriptTag = html.match(/<script nonce="[^"]+">/)?.[0];
        assert.ok(scriptTag);
        const observer = `${scriptTag}
        (() => {
            const api = acquireVsCodeApi();
            window.acquireVsCodeApi = () => api;
            window.addEventListener('error', event => api.postMessage({ command: 'testError', error: event.message }));
            window.addEventListener('unhandledrejection', event => api.postMessage({ command: 'testError', error: String(event.reason) }));
            const report = stage => requestAnimationFrame(() => requestAnimationFrame(() => {
                const container = document.getElementById('hexContainer');
                const cell = document.querySelector('#hexBody .hex-cell[data-offset="${tailOffset}"]');
                const bounds = cell?.getBoundingClientRect();
                const viewport = container.getBoundingClientRect();
                const contentTop = viewport.top + container.clientTop;
                const contentBottom = contentTop + container.clientHeight;
                container.focus();
                const clipboardData = new DataTransfer();
                const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
                container.dispatchEvent(event);
                api.postMessage({
                    command: 'testNavigationState', stage,
                    tailText: cell?.textContent.trim(), selected: cell?.classList.contains('selected'),
                    currentMatch: cell?.classList.contains('find-current'),
                    // clientHeight/scrollTop 반올림으로 생기는 1 CSS px 미만의 경계 차이만 허용한다.
                    visible: !!bounds && bounds.height > 0
                        && bounds.top >= Math.floor(contentTop) && bounds.bottom <= Math.ceil(contentBottom),
                    bounds: bounds?.toJSON(), viewport: viewport.toJSON(),
                    contentTop, contentBottom,
                    scrollTop: container.scrollTop, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight,
                    clientWidth: container.clientWidth, scrollWidth: container.scrollWidth,
                    bodyBounds: document.body.getBoundingClientRect().toJSON(),
                    fontSize: getComputedStyle(document.body).fontSize,
                    windowHeight: window.innerHeight,
                    renderedRows: document.querySelectorAll('#hexBody .hex-row').length,
                    status: document.getElementById('statusBar').textContent,
                    findInfo: document.getElementById('findInfo').textContent,
                    copied: clipboardData.getData('text/plain'), copyPrevented: event.defaultPrevented,
                });
            }));
            window.addEventListener('message', event => {
                if (event.data?.command !== 'testNavigate') { return; }
                const stage = event.data.stage;
                const container = document.getElementById('hexContainer');
                if (stage === 'end') {
                    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
                } else if (stage === 'search') {
                    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
                    const info = document.getElementById('findInfo');
                    const searchObserver = new MutationObserver(() => {
                        if (info.textContent !== '1 / 1') { return; }
                        searchObserver.disconnect();
                        report(stage);
                    });
                    searchObserver.observe(info, { childList: true, characterData: true, subtree: true });
                    document.getElementById('findBtn').click();
                    const input = document.getElementById('findHexInput');
                    input.value = 'DE AD BE';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return;
                }
                report(stage);
            });
        })();
        </script>`;
        await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Hex Viewer browser navigation timed out')), 20000);
            subscription = panel.webview.onDidReceiveMessage(message => {
                try {
                    if (message.command === 'testError') { throw new Error(message.error); }
                    if (message.command === 'ready') {
                        postHexViewerData(panel.webview, result, undefined, deliveryId);
                    } else if (message.command === 'dataReceived') {
                        void panel.webview.postMessage({ command: 'testNavigate', stage: 'initial' });
                    } else if (message.command === 'testNavigationState') {
                        if (compact) {
                            assert.strictEqual(message.bodyBounds.width, 464);
                            assert.strictEqual(message.bodyBounds.height, 388);
                            assert.strictEqual(message.fontSize, '14px');
                            assert.ok(message.scrollWidth > message.clientWidth, '좁은 창은 가로 스크롤이 생겨야 한다');
                            assert.ok(message.viewport.bottom - message.contentBottom >= 14,
                                '가로 스크롤바가 실제 콘텐츠 높이를 줄이는 조건을 재현해야 한다');
                        }
                        assert.ok(message.renderedRows > 0 && message.renderedRows < 4097,
                            '전체 행을 만들어 가상 스크롤 경계를 우회하면 안 된다');
                        if (message.stage === 'initial') {
                            assert.strictEqual(message.tailText, undefined, '처음에는 마지막 셀이 가상 DOM 밖에 있어야 한다');
                            void panel.webview.postMessage({ command: 'testNavigate', stage: 'end' });
                            return;
                        }
                        assert.strictEqual(message.tailText, 'BEADDE');
                        assert.strictEqual(message.selected, true);
                        assert.strictEqual(message.visible, true,
                            '선택된 마지막 셀이 실제 뷰포트 안에 있어야 한다: ' + JSON.stringify(message));
                        assert.match(message.status, /0x00010000/);
                        assert.strictEqual(message.copied, 'BEADDE', '없는 네 번째 바이트를 채우거나 끝 세 바이트를 누락하면 안 된다');
                        assert.strictEqual(message.copyPrevented, true);
                        if (message.stage === 'end') {
                            void panel.webview.postMessage({ command: 'testNavigate', stage: 'search' });
                        } else {
                            assert.strictEqual(message.stage, 'search');
                            assert.strictEqual(message.findInfo, '1 / 1');
                            assert.strictEqual(message.currentMatch, true);
                            resolve();
                        }
                    }
                } catch (error) { reject(error); }
            });
            panel.webview.html = html.replace(scriptTag, observer + scriptTag);
        });
    } finally {
        clearTimeout(timer);
        subscription?.dispose();
        panel.dispose();
    }
}

suite('Hex Viewer 실제 브라우저 초기화', () => {
    test('IT-223: 가상 스크롤 끝의 불완전 단위를 키보드·검색으로 표시하고 실제 바이트만 복사한다', async function () {
        this.timeout(25000);
        await checkBrowserNavigation();
    });

    test('IT-224: 좁은 창의 가로 스크롤바 위에 마지막 선택·검색 셀 전체를 표시한다', async function () {
        this.timeout(25000);
        await checkBrowserNavigation(true);
    });

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
