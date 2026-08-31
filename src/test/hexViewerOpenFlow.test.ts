import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HEX_READY_FALLBACK_MS, HexEditorProvider, hexPanelRegistry, openHexViewerFile, validateHexViewerSelection } from '../hexViewer';

/**
 * Hex Viewer의 **실제 진입점**을 실행하는 테스트 (0.6.47).
 *
 * 지금까지 Hex Viewer 테스트는 순수 함수(`buildHexViewerHtml`)만 불렀다.
 * `openHexViewerFile` — 파일 크기 검사, 패널 생성, HTML 주입, 데이터 전송이
 * 모두 그 안에 있다 — 은 **어느 테스트도 실행하지 않았다**. Memory Map 만
 * `panelRegistry` 라는 seam 을 갖고 실제 진입점을 돌리고 있었다.
 *
 * 그 공백 때문에 "HTML 설정 직후 postMessage" 구간의 결함은 재현할 하네스
 * 자체가 없었다. 여기서 그 구간을 실제로 지난다.
 */
suite('Hex Viewer 진입점 (openHexViewerFile)', () => {
    let tempDir: string;
    let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
    let originalShowError: typeof vscode.window.showErrorMessage;
    const shownErrors: string[] = [];

    /** 호스트가 무엇을 언제 했는지 순서대로 기록하는 가짜 패널. */
    interface FakePanel {
        events: string[];
        posted: any[];
        revealPreserveFocus: Array<boolean | undefined>;
        panel: vscode.WebviewPanel;
        /** 웹뷰가 리스너를 건 뒤 보내는 신호를 흉내 낸다. */
        sendReady: () => void;
        /** 웹뷰가 임의 메시지를 보내는 동작을 흉내 낸다. */
        sendMessage: (message: any) => void;
        /** 다음 reveal 호출에서 던질 오류를 지정한다. */
        setRevealError: (error: Error | undefined) => void;
        /** 사용자가 탭을 닫는 동작을 흉내 낸다. */
        dispose: () => void;
    }

    function createFakePanel(): FakePanel {
        const events: string[] = [];
        const posted: any[] = [];
        const revealPreserveFocus: Array<boolean | undefined> = [];
        let html = '';
        const messageHandlers = new Set<(m: any) => void>();
        let disposeHandler: (() => void) | undefined;
        let disposed = false;
        let revealError: Error | undefined;
        const sendMessage = (message: any) => {
            for (const handler of Array.from(messageHandlers)) {
                handler(message);
            }
        };
        const panel = {
            title: '',
            webview: {
                get html() { return html; },
                set html(value: string) {
                    html = value;
                    // 실제 VS Code 는 여기서 문서를 새로 띄운다 — 웹뷰의
                    // 스크립트가 아직 리스너를 걸기 전이라는 뜻이다.
                    events.push('set-html');
                },
                postMessage: (message: any) => {
                    events.push('post-message');
                    posted.push(message);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage: (handler: (m: any) => void) => {
                    messageHandlers.add(handler);
                    events.push('handler-installed');
                    return {
                        dispose() {
                            messageHandlers.delete(handler);
                            events.push('handler-disposed');
                        }
                    };
                },
                asWebviewUri: (uri: vscode.Uri) => uri,
                cspSource: 'vscode-webview:',
            },
            reveal: (_viewColumn?: vscode.ViewColumn, preserveFocus?: boolean) => {
                events.push('reveal');
                revealPreserveFocus.push(preserveFocus);
                if (revealError) { throw revealError; }
            },
            onDidDispose: (handler: () => void) => {
                disposeHandler = handler;
                return {
                    dispose() {
                        if (disposeHandler === handler) { disposeHandler = undefined; }
                    }
                };
            },
            dispose: () => {
                if (disposed) { return; }
                disposed = true;
                events.push('dispose-panel');
                disposeHandler?.();
            },
        } as unknown as vscode.WebviewPanel;

        return {
            events,
            posted,
            revealPreserveFocus,
            panel,
            sendReady: () => sendMessage({ command: 'ready' }),
            sendMessage,
            setRevealError: error => { revealError = error; },
            dispose: () => panel.dispose(),
        };
    }

    function installFakePanel(): FakePanel {
        const fake = createFakePanel();
        (vscode.window as any).createWebviewPanel = (_viewType: string, title: string) => {
            fake.events.push('create-panel');
            fake.panel.title = title;
            return fake.panel;
        };
        return fake;
    }

    function installFakePanelFactory(): FakePanel[] {
        const created: FakePanel[] = [];
        (vscode.window as any).createWebviewPanel = (_viewType: string, title: string) => {
            const fake = createFakePanel();
            fake.events.push('create-panel');
            fake.panel.title = title;
            created.push(fake);
            return fake.panel;
        };
        return created;
    }

    function writeIntelHex(name: string): string {
        // 최소한의 유효한 Intel HEX — 0x0000 에 4바이트, 그리고 EOF 레코드.
        // 체크섬은 레코드 바이트 합의 2의 보수다 (04+00+00+00+DE+AD+BE+EF → C4).
        // 처음에 임의의 값을 넣었다가 파서가 조용히 거부해 패널이 만들어지지
        // 않았다 — 전제가 깨지면 테스트가 결함과 무관하게 실패한다.
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, ':04000000DEADBEEFC4\n:00000001FF\n');
        return filePath;
    }

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-hex-open-'));
        hexPanelRegistry.clear();
        originalCreateWebviewPanel = vscode.window.createWebviewPanel;
        originalShowError = vscode.window.showErrorMessage;
        shownErrors.length = 0;
        (vscode.window as any).showErrorMessage = (message: string) => {
            shownErrors.push(message);
            return Promise.resolve(undefined);
        };
    });

    teardown(() => {
        hexPanelRegistry.clear();
        (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
        (vscode.window as any).showErrorMessage = originalShowError;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('파일을 열면 패널이 생기고 HTML 과 데이터가 모두 전달된다', () => {
        const fake = installFakePanel();
        const filePath = writeIntelHex('sample.hex');

        const ok = openHexViewerFile({ extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext, filePath);

        assert.strictEqual(ok, true, `열기에 실패했다: ${shownErrors.join(' / ')}`);
        assert.ok(fake.events.includes('create-panel'), '패널이 만들어지지 않았다');
        assert.ok(hexPanelRegistry.has(filePath), '레지스트리가 패널을 잡고 있지 않다');
        assert.ok(
            hexPanelRegistry.has(vscode.Uri.file(filePath).fsPath),
            'VS Code URI가 정규화한 Windows drive-case에서도 같은 패널을 찾아야 한다'
        );
        assert.match(hexPanelRegistry.getTitle(filePath) ?? '', /sample\.hex/);
        assert.ok((hexPanelRegistry.getHtml(filePath) ?? '').length > 0, 'HTML 이 비어 있다');
        // 이제 데이터는 웹뷰가 `ready` 를 보낸 **뒤에** 간다.
        assert.strictEqual(fake.posted.length, 0, 'ready 전에 데이터를 보냈다 — 유실될 수 있는 순서다');
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 1, 'ready 이후에도 데이터가 오지 않았다');
        assert.strictEqual(fake.posted[0].command, 'hexData');
        assert.ok(typeof fake.posted[0].deliveryId === 'string' && fake.posted[0].deliveryId.length > 0);
        const firstDeliveryId = fake.posted[0].deliveryId;
        assert.ok(
            (hexPanelRegistry.getHtml(filePath) ?? '').includes(`const EXPECTED_DELIVERY_ID = ${JSON.stringify(firstDeliveryId)}`),
            '웹뷰가 현재 렌더의 delivery ID를 고정하지 않았다'
        );

        // 다른 렌더의 ACK는 현재 payload를 해제하지 않아야 한다. 아직 수신되지
        // 않았다고 보고 ready가 다시 오면 복구용으로 재전송한다.
        fake.sendMessage({ command: 'dataReceived', deliveryId: 'stale-delivery' });
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 2, '잘못된 ACK가 현재 payload를 해제했다');

        // 실제 ACK 뒤에는 큰 파싱 결과를 호스트에서 놓는다. 이후 ready는 단순
        // 중복이 아니라 웹뷰 문서 재로드로 보고 파일을 다시 읽어 새 HTML과 ID를
        // 만든다. 이전 렌더의 늦은 ACK가 새 payload를 지우면 안 된다.
        fake.sendMessage({ command: 'dataReceived', deliveryId: firstDeliveryId });
        fs.writeFileSync(filePath, ':01000000BB44\n:00000001FF\n');
        const htmlSetCount = fake.events.filter(event => event === 'set-html').length;
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 2, '새 문서가 ready를 보내기 전에 payload를 보냈다');
        assert.strictEqual(
            fake.events.filter(event => event === 'set-html').length,
            htmlSetCount + 1,
            'ACK 뒤 웹뷰 재로드에 파일을 다시 렌더하지 않았다'
        );
        assert.deepStrictEqual(
            fake.revealPreserveFocus,
            [true],
            '웹뷰 재로드 복구가 다른 탭에서 포커스를 가져가면 안 된다'
        );
        fake.sendMessage({ command: 'dataReceived', deliveryId: firstDeliveryId });
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 3, '재로드된 웹뷰에 데이터를 보내지 않았다');
        assert.notStrictEqual(fake.posted[2].deliveryId, firstDeliveryId, '재로드가 이전 delivery ID를 재사용했다');
        assert.deepStrictEqual(Array.from(fake.posted[2].data), [0xbb], '재로드가 파일의 최신 내용을 읽지 않았다');
    });

    test('웹뷰 재로드 중 파일이 사라지면 무한 loading 대신 복구 안내를 표시한다', () => {
        const fake = installFakePanel();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const filePath = path.join(tempDir, 'deleted-during-reload.bin');
        fs.writeFileSync(filePath, Buffer.from([0x41, 0x42]));

        assert.ok(openHexViewerFile(ctx, filePath, { forceBinary: true }));
        fake.sendReady();
        fake.sendMessage({ command: 'dataReceived', deliveryId: fake.posted[0].deliveryId });
        fs.unlinkSync(filePath);

        const htmlSetCount = fake.events.filter(event => event === 'set-html').length;
        fake.sendReady();

        const failureHtml = hexPanelRegistry.getHtml(filePath) ?? '';
        assert.strictEqual(
            fake.events.filter(event => event === 'set-html').length,
            htmlSetCount + 1,
            '실패한 재로드 문서를 안내 HTML로 교체하지 않았다'
        );
        assert.match(failureHtml, /reload|다시 불러오지/);
        assert.ok(failureHtml.includes(path.basename(filePath)));
        assert.ok(!failureHtml.includes('const EXPECTED_DELIVERY_ID'), '데이터를 기다리는 웹뷰를 그대로 남겼다');
        assert.deepStrictEqual(fake.revealPreserveFocus, [], '파일 검사 실패 전에 포커스를 옮기면 안 된다');
        assert.strictEqual(
            fake.events.filter(event => event === 'handler-disposed').length,
            1,
            '실패한 재로드의 메시지 핸들러를 해제하지 않았다'
        );
        const postedCount = fake.posted.length;
        fake.sendReady();
        assert.strictEqual(fake.posted.length, postedCount, '실패 안내 뒤에도 옛 payload를 전송했다');
    });

    test('ELF 원본을 binary로 열고 요청한 파일 offset 범위를 처음 선택한다', () => {
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'firmware.elf');
        fs.writeFileSync(filePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xaa, 0xbb, 0xcc, 0xdd]));

        const ok = openHexViewerFile(
            { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext,
            filePath,
            { forceBinary: true, initialSelection: { startOffset: 4, endOffset: 6 } }
        );

        assert.strictEqual(ok, true, `열기에 실패했다: ${shownErrors.join(' / ')}`);
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 1);
        assert.deepStrictEqual(fake.posted[0].initialSelection, { startOffset: 4, endOffset: 6 });
        assert.deepStrictEqual(Array.from(fake.posted[0].data), [0x7f, 0x45, 0x4c, 0x46, 0xaa, 0xbb, 0xcc, 0xdd]);
        const html = hexPanelRegistry.getHtml(filePath) ?? '';
        assert.ok(html.includes('jumpToOffset(initial.startOffset)'), '기존 Go-to 경로로 처음 선택 위치를 열어야 한다');
        assert.ok(html.includes('selectedEndOffset = initial.endOffset'), '선택 끝점이 보존되어야 한다');
    });

    test('처음 선택 범위가 파일 밖이면 패널을 만들지 않는다', () => {
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'short.bin');
        fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));

        const ok = openHexViewerFile(
            { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext,
            filePath,
            { forceBinary: true, initialSelection: { startOffset: 2, endOffset: 4 } }
        );

        assert.strictEqual(ok, false);
        assert.ok(shownErrors.some(message => /selection|선택/.test(message)));
        assert.ok(!fake.events.includes('create-panel'), '잘못된 선택으로 빈 패널을 만들면 안 된다');
    });

    test('처음 선택 범위는 raw binary 모드 없이 사용할 수 없다', () => {
        const fake = installFakePanel();
        const filePath = writeIntelHex('selection-without-binary.hex');

        // JavaScript나 any가 판별 유니온을 우회해도 HEX 주소 공간을 원본 파일
        // offset으로 오인하지 않는다.
        const ok = openHexViewerFile(
            { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext,
            filePath,
            { initialSelection: { startOffset: 0, endOffset: 1 } } as any
        );

        assert.strictEqual(ok, false);
        assert.ok(shownErrors.some(message => /binary|바이너리/.test(message)));
        assert.ok(!fake.events.includes('create-panel'), '잘못된 옵션 조합으로 패널을 만들면 안 된다');
    });

    test('selection validator는 inclusive 정수 범위만 받는다', () => {
        assert.deepStrictEqual(validateHexViewerSelection({ startOffset: 1, endOffset: 3 }, 4), { startOffset: 1, endOffset: 3 });
        assert.strictEqual(validateHexViewerSelection({ startOffset: -1, endOffset: 1 }, 4), undefined);
        assert.strictEqual(validateHexViewerSelection({ startOffset: 2, endOffset: 1 }, 4), undefined);
        assert.strictEqual(validateHexViewerSelection({ startOffset: 1, endOffset: 4 }, 4), undefined);
        assert.strictEqual(validateHexViewerSelection({ startOffset: 1.5, endOffset: 2 }, 4), undefined);
    });

    /**
     * **이 순서가 결함이었다** (0.6.47 에서 고침).
     *
     * `webview.html` 을 설정하면 웹뷰 문서가 새로 로드된다. 예전에는 그
     * **직후에** 데이터를 보냈는데, 그 시점에 새 문서의 스크립트가 아직 리스너를
     * 걸지 않았을 수 있다. 그러면 데이터가 유실된 채 15초 뒤 "불러오지
     * 못했습니다" 만 남았다 — 재시도도 없었다. 코드 주석은 "VS Code 가
     * 큐잉하므로 유실되지 않는다" 고 단언했지만 API 문서는 그 보장을 하지 않는다.
     *
     * 이제 웹뷰가 리스너를 건 뒤 `ready` 를 보내고, 호스트는 그것을 받은 뒤에
     * 데이터를 보낸다. 핸들러는 HTML 보다 **먼저** 걸어야 한다 — 그렇지 않으면
     * `ready` 자체를 놓친다.
     */
    test('데이터는 웹뷰가 ready 를 보낸 뒤에 간다', () => {
        const fake = installFakePanel();
        openHexViewerFile({ extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext, writeIntelHex('order.hex'));

        const handlerAt = fake.events.indexOf('handler-installed');
        const htmlAt = fake.events.indexOf('set-html');
        assert.ok(handlerAt >= 0 && htmlAt >= 0, `두 단계가 모두 일어나야 한다: ${fake.events.join(' → ')}`);
        assert.ok(
            handlerAt < htmlAt,
            `핸들러를 HTML 뒤에 걸었다 — ready 를 놓친다: ${fake.events.join(' → ')}`
        );
        assert.strictEqual(fake.posted.length, 0, 'ready 를 기다리지 않고 보냈다');

        fake.sendReady();
        assert.strictEqual(fake.posted.length, 1, 'ready 를 받고도 보내지 않았다');
    });

    /**
     * 핸드셰이크가 어떤 이유로든 실패했을 때 **아무것도 안 보내는** 것이 가장
     * 나쁘다. `ready` 가 끝내 오지 않으면 시한 뒤에 그냥 보낸다.
     */
    test('ready 가 오지 않아도 시한 뒤에는 데이터를 보낸다', async function () {
        this.timeout(20000);
        const fake = installFakePanel();
        openHexViewerFile({ extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext, writeIntelHex('fallback.hex'));

        assert.strictEqual(fake.posted.length, 0, '아직은 보내지 않아야 한다');
        await new Promise(resolve => setTimeout(resolve, 3500));
        assert.strictEqual(
            fake.posted.length,
            1,
            'ready 가 오지 않자 데이터가 영영 가지 않았다 — 화면이 "불러오는 중" 에 갇힌다'
        );
        const deliveryId = fake.posted[0].deliveryId;
        const htmlSetCount = fake.events.filter(event => event === 'set-html').length;
        // fallback 데이터가 먼저 도착하면 ACK가 원래 ready보다 앞설 수 있다.
        // 이 ACK만 보고 원본을 놓으면 늦은 ready를 새 문서로 오인해 HTML을
        // 갈아 버린다. ready까지 본 뒤 같은 payload를 한 번 더 보내야 한다.
        fake.sendMessage({ command: 'dataReceived', deliveryId });
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 2, '폴백이 유실됐을 때 늦은 ready로 복구할 수 없다');
        assert.strictEqual(
            fake.events.filter(event => event === 'set-html').length,
            htmlSetCount,
            'fallback ACK 뒤의 늦은 ready를 웹뷰 재로드로 오인했다'
        );
        fake.sendMessage({ command: 'dataReceived', deliveryId });
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 2, '재로드 문서의 ready 전에 폴백 payload를 다시 보냈다');
    });

    test('서로 다른 파일은 이름이 같아도 독립된 패널과 데이터 흐름을 갖는다', () => {
        const created = installFakePanelFactory();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const firstPath = path.join(tempDir, 'first', 'same.bin');
        const secondPath = path.join(tempDir, 'second', 'same.bin');
        fs.mkdirSync(path.dirname(firstPath), { recursive: true });
        fs.mkdirSync(path.dirname(secondPath), { recursive: true });
        fs.writeFileSync(firstPath, Buffer.from([0x11]));
        fs.writeFileSync(secondPath, Buffer.from([0x22]));

        assert.ok(openHexViewerFile(ctx, firstPath, { forceBinary: true }));
        assert.ok(openHexViewerFile(ctx, secondPath, { forceBinary: true }));

        assert.strictEqual(created.length, 2, '서로 다른 경로가 하나의 패널을 공유했다');
        assert.strictEqual(hexPanelRegistry.size(), 2);
        assert.ok(hexPanelRegistry.has(firstPath));
        assert.ok(hexPanelRegistry.has(secondPath));

        // B를 연 뒤에도 A의 핸들러가 살아 있어야 한다. 전역 disposable을
        // 공유하면 두 번째 열기가 첫 번째 핸들러를 끊어 이 단언이 실패한다.
        created[0].sendReady();
        assert.deepStrictEqual(Array.from(created[0].posted[0].data), [0x11]);
        assert.strictEqual(created[1].posted.length, 0, 'A의 ready가 B 패널에 데이터를 보냈다');

        created[1].sendReady();
        assert.deepStrictEqual(Array.from(created[1].posted[0].data), [0x22]);
        assert.strictEqual(created[0].posted.length, 1, 'B의 ready가 A 패널을 다시 갱신했다');
    });

    test('같은 파일을 다시 열면 기존 패널을 reveal하고 최신 내용으로 교체한다', () => {
        const created = installFakePanelFactory();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const filePath = path.join(tempDir, 'same-file.bin');
        fs.writeFileSync(filePath, Buffer.from([0x11, 0x12, 0x13]));

        assert.ok(openHexViewerFile(ctx, filePath, {
            forceBinary: true,
            initialSelection: { startOffset: 0, endOffset: 0 },
        }));
        created[0].sendReady();
        fs.writeFileSync(filePath, Buffer.from([0x21, 0x22, 0x23]));
        assert.ok(openHexViewerFile(ctx, filePath, {
            forceBinary: true,
            initialSelection: { startOffset: 1, endOffset: 2 },
        }));
        created[0].sendReady();

        assert.strictEqual(created.length, 1, '같은 파일에 새 패널을 만들었다');
        assert.ok(created[0].events.includes('reveal'), '기존 파일 패널을 다시 보여 주지 않았다');
        assert.deepStrictEqual(
            created[0].revealPreserveFocus,
            [false],
            '사용자가 직접 다시 연 탭은 기존대로 포커스를 받아야 한다'
        );
        assert.strictEqual(
            created[0].events.filter(event => event === 'handler-disposed').length,
            1,
            '같은 파일을 다시 열 때 이전 메시지 핸들러를 해제하지 않았다'
        );
        assert.strictEqual(hexPanelRegistry.size(), 1);
        assert.deepStrictEqual(Array.from(created[0].posted[1].data), [0x21, 0x22, 0x23]);
        assert.deepStrictEqual(
            created[0].posted[1].initialSelection,
            { startOffset: 1, endOffset: 2 },
            '같은 ELF에서 다른 심볼을 열 때 최신 선택 범위로 갱신해야 한다'
        );
    });

    test('기존 패널 reveal 실패를 처리하고 현재 패널 상태를 보존한다', () => {
        const fake = installFakePanel();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const filePath = path.join(tempDir, 'reveal-failure.bin');
        fs.writeFileSync(filePath, Buffer.from([0x31, 0x32]));

        assert.ok(openHexViewerFile(ctx, filePath, { forceBinary: true }));
        fake.sendReady();
        fake.sendMessage({ command: 'dataReceived', deliveryId: fake.posted[0].deliveryId });
        const previousHtml = hexPanelRegistry.getHtml(filePath);
        fake.setRevealError(new Error('panel is unavailable'));

        assert.strictEqual(openHexViewerFile(ctx, filePath, { forceBinary: true }), false);
        assert.strictEqual(hexPanelRegistry.size(), 1, 'reveal 실패가 기존 패널 상태를 지웠다');
        assert.strictEqual(hexPanelRegistry.getHtml(filePath), previousHtml, 'reveal 실패가 기존 화면을 덮었다');
        assert.ok(shownErrors.some(message => /panel is unavailable/.test(message)), 'reveal 실패 이유를 알리지 않았다');
        assert.strictEqual(
            fake.events.filter(event => event === 'handler-disposed').length,
            0,
            '렌더를 시작하지 않았는데 기존 메시지 핸들러를 끊었다'
        );
    });

    test('재렌더 실패 뒤 패널 종료가 해제된 메시지 구독을 다시 해제하지 않는다', () => {
        const fake = installFakePanel();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const filePath = path.join(tempDir, 'render-failure.hex');
        fs.writeFileSync(filePath, ':01000000AA55\n:00000001FF\n');

        assert.ok(openHexViewerFile(ctx, filePath));
        fake.sendReady();
        fake.sendMessage({ command: 'dataReceived', deliveryId: fake.posted[0].deliveryId });

        // 주소 0과 0x10000000의 두 바이트만 선언해 메모리를 크게 할당하지 않고
        // 128MB 표시 span guard를 실행한다.
        fs.writeFileSync(filePath, ':01000000AA55\n:020000041000EA\n:01000000BB44\n:00000001FF\n');
        assert.strictEqual(openHexViewerFile(ctx, filePath), false);
        assert.ok(shownErrors.some(message => /address span|표시/.test(message)));
        const disposedBeforeClose = fake.events.filter(event => event === 'handler-disposed').length;
        assert.strictEqual(disposedBeforeClose, 2, '이전 구독과 실패한 새 구독을 각각 한 번 해제해야 한다');

        fake.dispose();
        assert.strictEqual(
            fake.events.filter(event => event === 'handler-disposed').length,
            disposedBeforeClose,
            '패널 종료가 이미 해제된 구독을 다시 dispose했다'
        );
    });

    test('한 파일의 패널을 닫아도 다른 파일의 패널과 핸들러는 유지된다', () => {
        const created = installFakePanelFactory();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const firstPath = path.join(tempDir, 'dispose-first.bin');
        const secondPath = path.join(tempDir, 'dispose-second.bin');
        fs.writeFileSync(firstPath, Buffer.from([0x11]));
        fs.writeFileSync(secondPath, Buffer.from([0x22]));

        assert.ok(openHexViewerFile(ctx, firstPath, { forceBinary: true }));
        assert.ok(openHexViewerFile(ctx, secondPath, { forceBinary: true }));
        created[0].dispose();

        assert.strictEqual(hexPanelRegistry.size(), 1);
        assert.ok(!hexPanelRegistry.has(firstPath), '닫은 패널이 레지스트리에 남았다');
        assert.ok(hexPanelRegistry.has(secondPath), '다른 파일의 패널까지 제거했다');
        created[0].sendReady();
        assert.strictEqual(created[0].posted.length, 0, '닫힌 패널의 ready 핸들러가 살아 있다');
        created[1].sendReady();
        assert.deepStrictEqual(Array.from(created[1].posted[0].data), [0x22]);
    });

    test('이전 패널의 지연 dispose가 같은 경로의 새 패널을 제거하지 않는다', () => {
        const created = installFakePanelFactory();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
        const filePath = path.join(tempDir, 'recreated.bin');
        fs.writeFileSync(filePath, Buffer.from([0x33]));

        assert.ok(openHexViewerFile(ctx, filePath, { forceBinary: true }));
        hexPanelRegistry.clear();
        assert.ok(openHexViewerFile(ctx, filePath, { forceBinary: true }));
        assert.strictEqual(created.length, 2, '레지스트리 초기화 뒤 새 패널이 만들어지지 않았다');

        created[0].dispose();
        assert.strictEqual(hexPanelRegistry.size(), 1);
        assert.ok(hexPanelRegistry.has(filePath), '옛 dispose가 새 패널의 상태를 지웠다');
        created[1].sendReady();
        assert.deepStrictEqual(Array.from(created[1].posted[0].data), [0x33]);
    });

    test('한도를 넘는 파일은 패널을 만들지 않고 오류만 알린다', () => {
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'huge.bin');
        // 한도(수십 MB)를 실제로 만들지 않고 sparse 파일로 크기만 키운다.
        const fd = fs.openSync(filePath, 'w');
        fs.ftruncateSync(fd, 512 * 1024 * 1024);
        fs.closeSync(fd);

        const ok = openHexViewerFile({ extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext, filePath);

        assert.strictEqual(ok, false, '한도를 넘는 파일을 열었다');
        assert.ok(!fake.events.includes('create-panel'), '거부했는데 패널을 만들었다');
        assert.ok(shownErrors.length > 0, '사용자에게 아무것도 알리지 않았다');
    });

    test('읽을 수 없는 경로는 패널을 만들지 않는다', () => {
        const fake = installFakePanel();

        const ok = openHexViewerFile(
            { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext,
            path.join(tempDir, 'does-not-exist.hex')
        );

        assert.strictEqual(ok, false);
        assert.ok(!fake.events.includes('create-panel'), '없는 파일에 패널을 만들었다');
        assert.ok(shownErrors.length > 0);
    });

    /**
     * Custom Editor(`.hex` 파일을 직접 열 때 뜨는 편집기)는 0.6.47 의
     * handshake 수정을 받지 못했다 — 여전히 `html` 을 넣은 **직후** 데이터를
     * 보내고 핸들러는 그 뒤에 걸었다. standalone 패널에서 고친 것과 정확히
     * 같은 데이터 유실이 남아 있었다.
     */
    suite('Custom Editor 진입점 (resolveCustomEditor)', function () {
        // 폴백 시한(3초)을 실제로 기다리는 케이스가 둘 있다.
        this.timeout(20000);

        async function resolve(filePath: string, fake: FakePanel): Promise<void> {
            const provider = new HexEditorProvider(
                { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext
            );
            await provider.resolveCustomEditor(
                { uri: vscode.Uri.file(filePath), dispose() { /* no-op */ } } as vscode.CustomDocument,
                fake.panel
            );
        }

        test('핸들러를 HTML 보다 먼저 걸고, ready 를 받은 뒤에 보낸다', async () => {
            const fake = installFakePanel();
            const filePath = writeIntelHex('custom-editor.hex');

            await resolve(filePath, fake);

            // 이것이 결함의 핵심이다. 순서가 뒤집히면 웹뷰가 리스너를 걸기 전에
            // 데이터가 도착해 유실되고, 화면이 "불러오는 중" 에 갇힌다.
            assert.ok(
                fake.events.indexOf('handler-installed') < fake.events.indexOf('set-html'),
                `핸들러가 HTML 뒤에 걸렸다: ${fake.events.join(' → ')}`
            );
            assert.strictEqual(
                fake.posted.length, 0,
                'ready 를 받기 전에 데이터를 보냈다 — 그 메시지는 유실될 수 있다'
            );

            fake.sendReady();

            assert.strictEqual(fake.posted.length, 1, 'ready 를 받고도 데이터를 보내지 않았다');
            assert.strictEqual(fake.posted[0].command, 'hexData');
        });

        test('ready 가 오지 않아도 폴백으로 보낸다', async () => {
            const fake = installFakePanel();
            await resolve(writeIntelHex('custom-editor-fallback.hex'), fake);

            assert.strictEqual(fake.posted.length, 0);
            // 핸드셰이크가 깨졌을 때 **아무것도 안 보내는** 것이 가장 나쁘다.
            await new Promise(resolve => setTimeout(resolve, HEX_READY_FALLBACK_MS + 300));

            assert.strictEqual(fake.posted.length, 1, '폴백 전송이 없다 — 화면이 영영 비어 있다');
            assert.strictEqual(fake.posted[0].command, 'hexData');
        });

        test('한 에디터의 ready 가 다른 에디터의 폴백을 잘라먹지 않는다', async () => {
            // `readyReceived` 를 모듈 전역으로 두면 이렇게 새어 나간다. Custom
            // Editor 는 문서마다 인스턴스가 생기므로 상태도 인스턴스별이어야 한다.
            const first = installFakePanel();
            await resolve(writeIntelHex('leak-a.hex'), first);
            const second = installFakePanel();
            await resolve(writeIntelHex('leak-b.hex'), second);

            first.sendReady();
            assert.strictEqual(first.posted.length, 1, '첫 에디터가 ready 후에도 못 받았다');

            await new Promise(resolve => setTimeout(resolve, HEX_READY_FALLBACK_MS + 300));

            assert.strictEqual(
                second.posted.length, 1,
                '다른 에디터의 ready 가 이 에디터의 폴백을 취소했다 — 이 화면은 영영 비어 있다'
            );
        });
    });

    /**
     * 폴백 타이머가 dispose 를 넘어 살아남던 문제 (0.6.50).
     *
     * `dispose()` 가 구독만 해제하고 `setTimeout` 을 남기면 두 가지가 일어난다.
     * 아래 두 케이스가 각각 그 하나씩을 본다.
     */
    suite('폴백 타이머는 dispose 와 함께 취소된다', function () {
        this.timeout(20000);

        test('ready 전에 같은 파일을 다시 열면 이전 데이터가 새 화면에 오지 않는다', async () => {
            const fake = installFakePanel();
            const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;
            const filePath = path.join(tempDir, 'stale.bin');

            // 첫 내용을 열고 **ready 를 보내지 않는다** — 타이머가 살아 있는 상태.
            fs.writeFileSync(filePath, Buffer.from([0xaa]));
            openHexViewerFile(ctx, filePath, { forceBinary: true });
            // 같은 파일을 새 내용으로 다시 연다. 패널 객체만 비교하면 첫 렌더의
            // 지연 fallback도 최신으로 오인할 수 있다.
            fs.writeFileSync(filePath, Buffer.from([0xbb]));
            openHexViewerFile(ctx, filePath, { forceBinary: true });
            fake.sendReady();

            const afterReady = fake.posted.length;
            assert.strictEqual(afterReady, 1, '최신 데이터가 한 번 가야 한다');
            assert.deepStrictEqual(Array.from(fake.posted[0].data), [0xbb]);

            // 첫 렌더의 타이머 시한을 넘겨 기다린다.
            await new Promise(resolve => setTimeout(resolve, HEX_READY_FALLBACK_MS + 500));

            assert.strictEqual(
                fake.posted.length, afterReady,
                '이전 렌더의 폴백 타이머가 새 화면에 옛 바이트를 보냈다'
            );
        });

        test('Custom Editor 를 닫으면 폴백이 페이로드를 다시 만들지 않는다', async () => {
            const fake = installFakePanel();
            let disposeHandler: (() => void) | undefined;
            (fake.panel as any).onDidDispose = (handler: () => void) => {
                disposeHandler = handler;
                return { dispose() { /* no-op */ } };
            };

            const resolving = new HexEditorProvider({ extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext)
                .resolveCustomEditor(
                    { uri: vscode.Uri.file(writeIntelHex('closed.hex')), dispose() { /* no-op */ } } as vscode.CustomDocument,
                    fake.panel
                );

            assert.ok(disposeHandler, '비동기 분석 전에 onDidDispose를 걸어야 한다');
            disposeHandler!();   // progress가 첫 tick을 양보한 사이 사용자가 닫는다
            await resolving;

            await new Promise(resolve => setTimeout(resolve, HEX_READY_FALLBACK_MS + 500));

            assert.strictEqual(
                fake.posted.length, 0,
                '닫힌 에디터의 폴백이 그대로 돌았다 — 최대 128MB 페이로드를 보낼 곳도 없이 다시 만든다'
            );
            assert.ok(!fake.events.includes('set-html'), '닫힌 Custom Editor를 뒤늦게 파싱·렌더했다');
        });
    });

    /**
     * 0.6.47 은 전송 순서를 보려고 호스트에 `postedMessages` 배열을 두고
     * `getPostedMessages()` 로 노출했다. 그런데 그 push 는 프로덕션 경로에서도
     * 실행돼, 파일당 최대 128MB 페이로드가 패널을 닫아도 남았다(0.6.48 에서 제거).
     *
     * 관찰은 **테스트가 주입한 가짜 패널의 `postMessage`** 가 한다 — 위 케이스들이
     * 그렇게 순서를 검사한다. 호스트에 관찰용 사본을 다시 만들면 같은 누수가
     * 조용히 돌아오므로, 레지스트리의 표면을 여기서 고정한다.
     */
    test('레지스트리는 상태를 읽기만 하고 보낸 데이터를 보관하지 않는다', () => {
        assert.deepStrictEqual(
            Object.keys(hexPanelRegistry).sort(),
            ['clear', 'getHtml', 'getTitle', 'has', 'size'],
            '레지스트리에 새 표면이 생겼다 — 페이로드를 호스트에 쌓는 관찰자가 아닌지 확인하라'
        );
    });
});
