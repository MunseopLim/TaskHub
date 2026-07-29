import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { hexPanelRegistry, openHexViewerFile } from '../hexViewer';

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
        panel: vscode.WebviewPanel;
        /** 웹뷰가 리스너를 건 뒤 보내는 신호를 흉내 낸다. */
        sendReady: () => void;
    }

    function installFakePanel(): FakePanel {
        const events: string[] = [];
        const posted: any[] = [];
        let html = '';
        let messageHandler: ((m: any) => void) | undefined;
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
                    messageHandler = handler;
                    events.push('handler-installed');
                    return { dispose() { /* no-op */ } };
                },
                asWebviewUri: (uri: vscode.Uri) => uri,
                cspSource: 'vscode-webview:',
            },
            reveal: () => { events.push('reveal'); },
            onDidDispose: () => ({ dispose() { /* no-op */ } }),
            dispose: () => { /* no-op */ },
        } as unknown as vscode.WebviewPanel;

        (vscode.window as any).createWebviewPanel = () => {
            events.push('create-panel');
            return panel;
        };
        return { events, posted, panel, sendReady: () => messageHandler?.({ command: 'ready' }) };
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
        assert.ok(hexPanelRegistry.has(), '레지스트리가 패널을 잡고 있지 않다');
        assert.match(hexPanelRegistry.getTitle() ?? '', /sample\.hex/);
        assert.ok((hexPanelRegistry.getHtml() ?? '').length > 0, 'HTML 이 비어 있다');
        // 이제 데이터는 웹뷰가 `ready` 를 보낸 **뒤에** 간다.
        assert.strictEqual(fake.posted.length, 0, 'ready 전에 데이터를 보냈다 — 유실될 수 있는 순서다');
        fake.sendReady();
        assert.strictEqual(fake.posted.length, 1, 'ready 이후에도 데이터가 오지 않았다');
        assert.strictEqual(fake.posted[0].command, 'hexData');
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
    });

    test('같은 패널에 다른 파일을 열면 제목과 데이터가 교체된다', () => {
        const fake = installFakePanel();
        const ctx = { extensionPath: tempDir, subscriptions: [] } as unknown as vscode.ExtensionContext;

        openHexViewerFile(ctx, writeIntelHex('first.hex'));
        fake.sendReady();
        openHexViewerFile(ctx, writeIntelHex('second.hex'));
        fake.sendReady();

        assert.strictEqual(
            fake.events.filter(e => e === 'create-panel').length,
            1,
            '두 번째 열기가 패널을 새로 만들었다 — 기존 패널을 재사용해야 한다'
        );
        assert.ok(fake.events.includes('reveal'), '기존 패널을 다시 보여 주지 않았다');
        assert.match(hexPanelRegistry.getTitle() ?? '', /second\.hex/);
        assert.strictEqual(fake.posted.length, 2, '새 파일의 데이터가 다시 전달되지 않았다');
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
            ['clear', 'getHtml', 'getTitle', 'has'],
            '레지스트리에 새 표면이 생겼다 — 페이로드를 호스트에 쌓는 관찰자가 아닌지 확인하라'
        );
    });
});
