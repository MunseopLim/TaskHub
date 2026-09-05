import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RECOVERY_STATE_KEY, jsonPanelRegistry, openJsonEditorFile } from '../jsonEditor';

/**
 * JSON Editor의 **실제 진입점**을 실행하는 테스트 (0.6.47).
 *
 * 지금까지 JSON Editor 테스트는 순수 함수(`getWebviewContent`)만 부르거나,
 * `openJsonEditorWithPath` 의 **소스 텍스트를 정규식으로** 검사했다:
 *
 * ```
 * const openPath = editorSource.match(/async function openJsonEditorWithPath[\s\S]*?\n\}\s*\n/);
 * assert.ok(/baselineUnknownForWebview\s*=\s*true/.test(body), '...');
 * ```
 *
 * 그건 "코드에 이 문자열이 있는가" 를 볼 뿐이라 로직이 틀려도 통과한다.
 * 파일 읽기·크기 검사·복구 스냅샷 제안·dirty 처리가 전부 그 함수 안에 있는데,
 * 그 동작을 실제로 실행하는 테스트는 하나도 없었다. 여기서 실행한다.
 */
suite('JSON Editor 진입점 (openJsonEditorFile)', function () {
    this.timeout(20000);

    let tempDir: string;
    let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
    let originalShowError: typeof vscode.window.showErrorMessage;
    let originalShowInfo: typeof vscode.window.showInformationMessage;
    const shownErrors: string[] = [];
    const shownWarnings: string[] = [];
    let originalShowWarning: typeof vscode.window.showWarningMessage;
    const infoPrompts: { message: string; buttons: string[] }[] = [];
    /** 복구 프롬프트에서 누를 버튼의 인덱스. `undefined` 면 무시(닫기). */
    let infoAnswer: number | undefined;

    interface FakePanel {
        events: string[];
        panel: vscode.WebviewPanel;
        /** 호스트가 웹뷰로 보낸 메시지들 (payload 포함). */
        posted: any[];
        /** 현재 html 에 심긴 세션 번호. */
        sessionId(): number;
        /** `createWebviewPanel` 에 넘어간 옵션 — webview 가 무엇을 읽을 수 있는지. */
        panelOptions(): Record<string, unknown> | undefined;
        /** host 가 세팅한 webview html 전체. */
        html(): string;
        /** 호스트가 등록한 `onDidReceiveMessage` 콜백. 웹뷰 흉내에 쓴다. */
        send(message: Record<string, unknown>): Promise<void>;
        /**
         * 사용자가 패널을 닫는 것. host 의 `onDidDispose` 콜백을 실제로 부른다 —
         * 그 안에서 pending snapshot flush 가 일어나므로, "닫으면 복구본이
         * 남는가" 는 이걸 통해서만 검증할 수 있다.
         */
        disposePanel(): void;
    }

    function installFakePanel(): FakePanel {
        const events: string[] = [];
        const posted: any[] = [];
        let handler: ((message: unknown) => unknown) | undefined;
        let disposeHandler: (() => unknown) | undefined;
        let html = '';
        const panel = {
            title: '',
            webview: {
                get html() { return html; },
                set html(value: string) { html = value; events.push('set-html'); },
                postMessage: (message: unknown) => {
                    events.push('post-message');
                    posted.push(message);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage: (cb: (message: unknown) => unknown) => {
                    handler = cb;
                    return { dispose() { handler = undefined; } };
                },
                asWebviewUri: (uri: vscode.Uri) => uri,
                cspSource: 'vscode-webview:',
            },
            reveal: () => { events.push('reveal'); },
            onDidDispose: (cb: () => unknown) => {
                disposeHandler = cb;
                return { dispose() { disposeHandler = undefined; } };
            },
            onDidChangeViewState: () => ({ dispose() { /* no-op */ } }),
            dispose: () => { /* no-op */ },
        } as unknown as vscode.WebviewPanel;

        /** 패널 생성 옵션. webview 가 무엇을 읽을 수 있는지가 여기서 정해진다. */
        let panelOptions: Record<string, unknown> | undefined;
        (vscode.window as any).createWebviewPanel = (
            _type: string, _title: string, _col: unknown, options?: Record<string, unknown>
        ) => {
            events.push('create-panel');
            panelOptions = options;
            return panel;
        };
        /** 현재 html 에 심긴 세션 번호 — 실제 webview 가 읽는 것과 같은 값. */
        const sessionId = (): number => {
            const m = html.match(/const SESSION_ID = (\d+);/);
            assert.ok(m, 'webview html 에 SESSION_ID 가 없다');
            return Number(m![1]);
        };
        return {
            events,
            panel,
            posted,
            sessionId,
            panelOptions: () => panelOptions,
            html: () => html,
            async send(message: Record<string, unknown>) {
                assert.ok(handler, '호스트가 onDidReceiveMessage 를 등록하지 않았다');
                // 실제 webview 는 `postToHost` 로 세션을 붙여 보낸다. 테스트가
                // 명시로 덮어쓰면(다른 세션 흉내) 그 값이 우선한다.
                await handler!({ session: sessionId(), ...message });
            },
            disposePanel() {
                assert.ok(disposeHandler, '호스트가 onDidDispose 를 등록하지 않았다');
                disposeHandler!();
            },
        };
    }

    /**
     * workspaceState 를 메모리로 흉내 내는 컨텍스트. 복구 저장소가 여기 붙는다.
     *
     * `beforeUpdate` 는 `update` 앞에 끼워 넣는 훅이다. 저장 핸들러가 recovery
     * 엔트리를 지우며 `await` 하는 그 지점을 붙잡아 두고 다른 일을 끼워 넣는
     * (= 경합을 결정적으로 재현하는) 데 쓴다.
     */
    function makeContext(
        seed?: Record<string, unknown>,
        beforeUpdate?: () => Promise<void>
    ): vscode.ExtensionContext {
        const store = new Map<string, unknown>(Object.entries(seed ?? {}));
        const memento = {
            get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
            update: async (k: string, v: unknown) => {
                if (beforeUpdate) { await beforeUpdate(); }
                store.set(k, v);
            },
            keys: () => Array.from(store.keys()),
            setKeysForSync: () => { /* no-op */ },
        };
        return {
            extensionPath: tempDir,
            // webview 로직 번들의 URI 를 만드는 데 쓴다 (asWebviewUri 대상).
            extensionUri: vscode.Uri.file(tempDir),
            subscriptions: [],
            workspaceState: memento,
            globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-json-open-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-json-open-'));
        jsonPanelRegistry.clear();
        originalCreateWebviewPanel = vscode.window.createWebviewPanel;
        originalShowError = vscode.window.showErrorMessage;
        originalShowInfo = vscode.window.showInformationMessage;
        originalShowWarning = vscode.window.showWarningMessage;
        shownErrors.length = 0;
        shownWarnings.length = 0;
        infoPrompts.length = 0;
        infoAnswer = undefined;
        (vscode.window as any).showWarningMessage = (message: string) => {
            shownWarnings.push(message);
            return Promise.resolve(undefined);
        };
        (vscode.window as any).showErrorMessage = (message: string) => {
            shownErrors.push(message);
            return Promise.resolve(undefined);
        };
        (vscode.window as any).showInformationMessage = (message: string, ...rest: unknown[]) => {
            const buttons = rest.filter((r): r is string => typeof r === 'string');
            infoPrompts.push({ message, buttons });
            return Promise.resolve(infoAnswer === undefined ? undefined : buttons[infoAnswer]);
        };
    });

    teardown(() => {
        jsonPanelRegistry.clear();
        (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
        (vscode.window as any).showErrorMessage = originalShowError;
        (vscode.window as any).showInformationMessage = originalShowInfo;
        (vscode.window as any).showWarningMessage = originalShowWarning;
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function writeJson(name: string, data: unknown): string {
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return filePath;
    }

    /** workspaceState 에 남아 있는 복구 스냅샷 (없으면 undefined). */
    function readRecoveryEntry(ctx: vscode.ExtensionContext, filePath: string): unknown {
        const state = ctx.workspaceState.get<Record<string, unknown>>(RECOVERY_STATE_KEY, {});
        return state?.[filePath];
    }

    test('원문 열기는 현재 파일을 옆에서 열고 미저장 표와 디스크를 유지한다', async () => {
        const fake = installFakePanel();
        const filePath = writeJson('source.json', { rows: [] });
        const ctx = makeContext();
        await openJsonEditorFile(ctx, filePath);
        const edited = { rows: [{ name: 'draft' }] };
        await fake.send({ command: 'modified', value: true });
        await fake.send({ command: 'snapshot', data: edited });
        const originalOpen = vscode.workspace.openTextDocument;
        const originalShow = vscode.window.showTextDocument;
        const calls: unknown[] = [];
        const document = { uri: vscode.Uri.file(filePath) };
        try {
            (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
                calls.push(uri.fsPath);
                return document;
            };
            (vscode.window as any).showTextDocument = async (actual: unknown, options: unknown) => {
                calls.push(actual, options);
            };
            await fake.send({ command: 'openSource', filePath: '/tmp/untrusted-other.json', session: fake.sessionId() + 1 });
            assert.deepStrictEqual(calls, [], '다른 세션의 요청은 무시한다');
            await fake.send({ command: 'openSource', filePath: '/tmp/untrusted-other.json' });
            // VS Code URI는 Windows 드라이브 문자를 소문자로 정규화하므로 같은 API 기준으로 비교한다.
            assert.deepStrictEqual(calls, [document.uri.fsPath, document, { viewColumn: vscode.ViewColumn.Beside, preview: false }]);
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { rows: [] });
            fake.disposePanel();
            // dispose는 기존 debounce flush 경로로 스냅샷을 보존한다.
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.deepStrictEqual((readRecoveryEntry(ctx, filePath) as any)?.data, edited);
        } finally {
            (vscode.workspace as any).openTextDocument = originalOpen;
            (vscode.window as any).showTextDocument = originalShow;
        }
    });

    test('원문 열기 실패는 오류를 알리고 표의 dirty 상태를 바꾸지 않는다', async () => {
        const fake = installFakePanel();
        const filePath = writeJson('source-error.json', { rows: [] });
        await openJsonEditorFile(makeContext(), filePath);
        await fake.send({ command: 'modified', value: true });
        const originalOpen = vscode.workspace.openTextDocument;
        try {
            (vscode.workspace as any).openTextDocument = async () => { throw new Error('read denied'); };
            await fake.send({ command: 'openSource' });
            assert.ok(shownErrors.some(message => message.includes('read denied')));
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
        } finally {
            (vscode.workspace as any).openTextDocument = originalOpen;
        }
    });

    test('정상 JSON 을 열면 패널이 생기고 그 파일을 잡는다', async () => {
        const fake = installFakePanel();
        const filePath = writeJson('config.json', { alpha: [{ id: 1 }] });

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(fake.events.includes('create-panel'), `패널이 만들어지지 않았다: ${shownErrors.join(' / ')}`);
        assert.ok(jsonPanelRegistry.has(), '레지스트리가 패널을 잡고 있지 않다');
        assert.strictEqual(jsonPanelRegistry.getFilePath(), filePath);
        assert.ok((jsonPanelRegistry.getHtml() ?? '').length > 0, 'HTML 이 비어 있다');
    });

    /**
     * webview 로직 번들을 **실제로 가리키고 실제로 읽을 수 있는지.**
     *
     * 이 두 값이 host 쪽에서 유일하게 "어떤 URL 을 싣는가" 를 정한다. 나머지
     * webview 테스트는 전부 `getWebviewContent` 에 리터럴 URI 를 넘기므로 여기를
     * 덮지 못한다 — 파일명을 오타 내거나 `localResourceRoots` 를 비워도 전체
     * 스위트가 초록으로 통과하는 것을 확인했다. 그 경우 사용자는 툴바만 있는 빈
     * 화면을 본다.
     */
    test('패널이 로직 번들을 가리키고 그 디렉터리를 읽을 수 있다', async () => {
        const fake = installFakePanel();
        const filePath = writeJson('bundle.json', { alpha: [{ id: 1 }] });

        await openJsonEditorFile(makeContext(), filePath);

        // 기대 URI 는 extensionUri 에서 유도한다 — 리터럴로 적으면 소스와 함께
        // 틀려도 알 수 없다. 가짜 asWebviewUri 는 항등이다.
        const expected = vscode.Uri.file(path.join(tempDir, 'dist', 'jsonEditorWebview.js')).toString();
        assert.ok(
            fake.html().includes(`src="${expected}"`),
            `번들 script 태그가 ${expected} 를 가리키지 않는다`
        );

        const roots = fake.panelOptions()?.localResourceRoots as vscode.Uri[] | undefined;
        assert.ok(roots && roots.length > 0, 'localResourceRoots 가 비어 있으면 번들을 읽지 못한다');
        const expectedDist = path.resolve(tempDir, 'dist');
        assert.ok(
            roots!.some(root => path.relative(root.fsPath, expectedDist) === ''),
            `localResourceRoots 에 dist 가 없다: ${roots!.map(r => r.fsPath).join(', ')}`
        );
    });

    test('한도를 넘는 파일은 패널을 만들지 않고 오류만 알린다', async () => {
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'huge.json');
        const fd = fs.openSync(filePath, 'w');
        fs.ftruncateSync(fd, 11 * 1024 * 1024);   // 한도 10MB 초과
        fs.closeSync(fd);

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(!fake.events.includes('create-panel'), '한도를 넘겼는데 패널을 만들었다');
        assert.ok(shownErrors.length > 0, '사용자에게 아무것도 알리지 않았다');
        assert.ok(!jsonPanelRegistry.has());
    });

    test('깨진 JSON 은 오류를 알린다', async () => {
        installFakePanel();
        const filePath = path.join(tempDir, 'broken.json');
        fs.writeFileSync(filePath, '{ not valid');

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(shownErrors.length > 0, '파싱 실패를 알리지 않았다');
    });

    /**
     * 스칼라 루트도 유효한 JSON 이라 `JSON.parse` 를 통과한다. 걸러 내지 않으면
     * 그대로 webview 로 넘어가 `Object.keys(null)` 에서 TypeError 가 나는데,
     * **확장 호스트가 아니라 webview 안**이라 오류 알림조차 없이 화면만 텅 빈다.
     */
    test('루트가 `null` 이면 패널을 만들지 않고 그 이유를 알린다', async () => {
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'null-root.json');
        fs.writeFileSync(filePath, 'null');

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(!fake.events.includes('create-panel'), '스칼라 루트인데 패널을 만들었다');
        assert.ok(shownErrors.length > 0, '사용자에게 아무것도 알리지 않았다');
        assert.match(shownErrors[0], /객체나 배열|object or array/,
            `무엇이 잘못됐는지 알리지 않았다: ${shownErrors[0]}`);
        // **파싱은 성공했다.** "파싱 실패" 로 뭉뚱그리면 사용자가 있지도 않은
        // 문법 오류를 찾는다 — 이 부정 단정이 없으면 그 구분이 고정되지 않는다.
        assert.ok(!/파싱 실패|Failed to parse/.test(shownErrors[0]),
            `파싱 실패로 잘못 이름 붙였다: ${shownErrors[0]}`);
        assert.ok(!jsonPanelRegistry.has());
    });

    test('숫자·문자열 루트도 같은 이유로 거절한다', async () => {
        for (const [name, body] of [['number-root', '42'], ['string-root', '"text"']]) {
            const fake = installFakePanel();
            shownErrors.length = 0;
            const filePath = path.join(tempDir, `${name}.json`);
            fs.writeFileSync(filePath, body);

            await openJsonEditorFile(makeContext(), filePath);

            assert.ok(!fake.events.includes('create-panel'), `${name}: 패널을 만들었다`);
            assert.match(shownErrors[0] ?? '', /객체나 배열|object or array/, name);
        }
    });

    test('원시값이 든 배열은 정상으로 연다', async () => {
        // 막을 것은 **루트**뿐이다. 과하게 막으면 멀쩡한 파일이 안 열린다.
        const fake = installFakePanel();
        const filePath = path.join(tempDir, 'primitive-array.json');
        fs.writeFileSync(filePath, '[null, 1, "a"]');

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(fake.events.includes('create-panel'),
            `원시값 배열이 거절됐다: ${shownErrors.join(' / ')}`);
    });

    test('없는 파일은 오류를 알리고 패널을 만들지 않는다', async () => {
        const fake = installFakePanel();

        await openJsonEditorFile(makeContext(), path.join(tempDir, 'nope.json'));

        assert.ok(!fake.events.includes('create-panel'));
        assert.ok(shownErrors.length > 0);
    });

    /**
     * 세션이 바뀐 뒤 도착하는 host→webview 메시지.
     *
     * `saveResult` 만이 아니다. reload 와 외부 변경 watcher 도 recovery 정리에서
     * `await` 하므로, 그 사이 다른 파일이 열리면 **A 의 데이터가 담긴 loadData 가
     * B 의 화면으로** 간다. 그러면 B 화면이 A 데이터로 바뀐 뒤 clean 으로
     * 표시되고, 이어서 저장하면 B 파일까지 A 데이터가 된다.
     */
    suite('세션 전환 후 지연 메시지', () => {
        test('reload 의 loadData 가 새 파일의 webview 로 가지 않는다', async () => {
            const fake = installFakePanel();
            const fileA = writeJson('reload-a.json', { rows: [{ a: 'A-DATA' }] });
            const fileB = writeJson('reload-b.json', { rows: [{ b: 'B-DATA' }] });

            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let gateArmed = false;
            const ctx = makeContext(undefined, async () => {
                if (gateArmed) { gateArmed = false; await gate; }
            });

            await openJsonEditorFile(ctx, fileA);
            // reload 는 dirty 가 아니면 확인 없이 진행한다. recovery 정리에서
            // 멈추도록 게이트를 여기서 무장한다.
            gateArmed = true;
            const reloadPending = fake.send({ command: 'reload' });
            await openJsonEditorFile(ctx, fileB);
            release();
            await reloadPending;

            const loads = fake.posted.filter(m => m && m.command === 'loadData');
            const leaked = loads.filter(m => JSON.stringify(m.data).includes('A-DATA'));
            assert.deepStrictEqual(
                leaked, [],
                `A 의 데이터가 B 의 webview 로 배달됐다: ${JSON.stringify(leaked)}`
            );
        });

        test('폐기 확인창 뒤에 세션이 바뀌면 새 파일 상태를 건드리지 않는다', async () => {
            // reload 와 외부 변경 watcher 는 모달에서 `await` 한다. 그 사이 다른
            // 파일이 열리면 currentIsDirty 같은 **전역** 상태는 이미 새 파일의
            // 것이다 — 메시지 session 필터는 발신만 막을 뿐 이 변경을 막지 못한다.
            const fake = installFakePanel();
            const fileA = writeJson('confirm-a.json', { rows: [{ a: 1 }] });
            const fileB = writeJson('confirm-b.json', { rows: [{ b: 1 }] });
            const ctx = makeContext();

            await openJsonEditorFile(ctx, fileA);
            await fake.send({ command: 'modified', value: true });   // A 를 dirty 로

            // A 의 reload 를 폐기 확인창에서 붙잡는다.
            let answerPrompt: (() => void) | undefined;
            (vscode.window as any).showWarningMessage = (message: string, ...rest: unknown[]) => {
                shownWarnings.push(message);
                const labels = rest.filter((r): r is string => typeof r === 'string');
                // 첫 프롬프트만 붙잡는다. 이후 다른 경로의 경고까지 멈추면
                // 테스트가 그냥 타임아웃으로 죽어 원인이 안 보인다.
                if (answerPrompt) { return Promise.resolve(labels[0]); }
                return new Promise<string | undefined>(resolve => {
                    answerPrompt = () => resolve(labels[0]);
                });
            };
            const reloadPending = fake.send({ command: 'reload' });
            for (let i = 0; i < 50 && !answerPrompt; i++) {
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.ok(answerPrompt, '폐기 확인창이 뜨지 않았다');

            // 확인창이 열린 채로 B 로 전환하고 B 를 dirty 로 만든다.
            await openJsonEditorFile(ctx, fileB);
            await fake.send({ command: 'modified', value: true });
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);

            // 이제 A 의 확인창에 "버리기" 로 답한다 → A 의 콜백이 재개된다.
            answerPrompt();
            await reloadPending;

            assert.strictEqual(
                jsonPanelRegistry.isDirty(), true,
                'A 의 reload 콜백이 B 의 dirty 상태를 지웠다'
            );
            assert.strictEqual(jsonPanelRegistry.getFilePath(), fileB);
        });

        test('폐기 확인창 뒤에 패널이 닫히면 dirty 를 되살리지 않는다', async () => {
            // **닫는 것도 세션의 끝이다.** 파일 전환만 세션으로 보면, 확인창이
            // 떠 있는 사이 패널을 닫은 경우 옛 콜백이 그대로 재개되어 화면에도
            // 없는 파일 때문에 전역 dirty 를 다시 켠다 — 패널이 없는데 레지스트리
            // 는 "미저장 변경 있음" 이라고 답하는 상태가 남는다.
            const fake = installFakePanel();
            const filePath = writeJson('dispose-during-confirm.json', { rows: [{ a: 1 }] });
            const ctx = makeContext();

            await openJsonEditorFile(ctx, filePath);
            await fake.send({ command: 'modified', value: true });   // dirty 로

            let answerPrompt: (() => void) | undefined;
            (vscode.window as any).showWarningMessage = (message: string, ...rest: unknown[]) => {
                shownWarnings.push(message);
                const labels = rest.filter((r): r is string => typeof r === 'string');
                if (answerPrompt) { return Promise.resolve(labels[0]); }
                return new Promise<string | undefined>(resolve => {
                    answerPrompt = () => resolve(labels[0]);
                });
            };
            const reloadPending = fake.send({ command: 'reload' });
            for (let i = 0; i < 50 && !answerPrompt; i++) {
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.ok(answerPrompt, '폐기 확인창이 뜨지 않았다');

            // 확인창이 열린 채로 사용자가 패널을 닫는다.
            fake.disposePanel();
            assert.strictEqual(jsonPanelRegistry.isDirty(), false, 'dispose 가 dirty 를 내리지 않았다');

            // 그 사이 파일이 깨진다 → 재개된 reload 는 실패 경로(=dirty 로 되돌림)
            // 로 간다. 세션이 살아 있다고 판단하면 여기서 dirty 가 되살아난다.
            fs.writeFileSync(filePath, '{ broken');
            answerPrompt();
            await reloadPending;

            assert.strictEqual(
                jsonPanelRegistry.isDirty(), false,
                '닫힌 패널의 reload 콜백이 전역 dirty 를 되살렸다'
            );
        });

        test('host→webview 메시지에는 모두 session 이 실린다', async () => {
            // webview 가 남의 메시지를 걸러내려면 세션이 붙어 있어야 한다.
            const fake = installFakePanel();
            const filePath = writeJson('stamped.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            await fake.send({ command: 'reload' });

            const unstamped = fake.posted.filter(m => m && typeof m.session !== 'number');
            assert.deepStrictEqual(
                unstamped, [],
                `session 없이 나간 메시지가 있다: ${JSON.stringify(unstamped)}`
            );
        });
    });

    /**
     * 저장 응답의 seq 계약.
     *
     * 호스트는 파일을 쓴 뒤 recovery 엔트리를 지우는 동안(`await`) 이벤트 루프를
     * 놓아 준다. 그 사이 사용자는 계속 편집할 수 있으므로, 웹뷰가 응답 시점의
     * data 를 "저장된 것"으로 잡으면 디스크에 없는 편집이 clean 으로 표시된다
     * (디스크=A, 화면=B, dirty=false → 닫으면 B 소실). 웹뷰가 **보낸 것**을
     * baseline 으로 되찾으려면 호스트가 요청 번호를 그대로 돌려줘야 한다.
     */
    suite('저장 응답 (saveResult) 계약', () => {
        function lastSaveResult(fake: { posted: any[] }): any {
            const hits = fake.posted.filter(m => m && m.command === 'saveResult');
            assert.ok(hits.length > 0, 'saveResult 를 보내지 않았다');
            return hits[hits.length - 1];
        }

        test('성공 응답이 요청의 seq 를 그대로 돌려준다', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('save.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 7 });

            const result = lastSaveResult(fake);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.seq, 7, '요청 번호가 응답에 실려 오지 않았다');
            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(filePath, 'utf-8')),
                { rows: [{ a: 2 }] },
                '보낸 데이터가 디스크에 기록되지 않았다'
            );
        });

        test('연속 저장이 각자의 seq 로 응답된다', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('save-seq.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            await fake.send({ command: 'save', data: { rows: [{ a: 3 }] }, seq: 2 });

            const seqs = fake.posted.filter(m => m && m.command === 'saveResult').map(m => m.seq);
            assert.deepStrictEqual(seqs, [1, 2], `응답 seq 가 어긋난다: ${JSON.stringify(seqs)}`);
        });

        test('응답에 세션이 실리고, 파일을 바꿔 열면 세션이 바뀐다', async () => {
            const fake = installFakePanel();
            const fileA = writeJson('a.json', { rows: [{ a: 1 }] });
            const fileB = writeJson('b.json', { rows: [{ b: 1 }] });
            const ctx = makeContext();

            await openJsonEditorFile(ctx, fileA);
            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            const sessionA = lastSaveResult(fake).session;
            assert.strictEqual(typeof sessionA, 'number', '응답에 세션이 실리지 않았다');

            // 같은 패널을 재사용해 다른 파일을 연다 (host 의 currentPanel.reveal).
            await openJsonEditorFile(ctx, fileB);
            await fake.send({ command: 'save', data: { rows: [{ b: 2 }] }, seq: 1 });
            const sessionB = lastSaveResult(fake).session;

            assert.notStrictEqual(
                sessionB, sessionA,
                '파일을 바꿔 열었는데 세션이 그대로면 webview 가 남의 응답을 구분할 수 없다'
            );
        });

        test('세션이 바뀐 뒤 도착한 저장 결과는 아예 보내지 않는다', async () => {
            // 실제 경합: 파일을 쓴 뒤 recovery 엔트리를 지우는 await 사이에
            // 사용자가 다른 파일을 연다. 그 응답이 새 webview 로 가면 새 파일의
            // 미저장 편집이 남의 저장 결과로 clean 처리된다.
            const fake = installFakePanel();
            const fileA = writeJson('race-a.json', { rows: [{ a: 1 }] });
            const fileB = writeJson('race-b.json', { rows: [{ b: 1 }] });

            // workspaceState.update 를 붙잡아 두어 await 구간을 열어 둔다.
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let gateArmed = true;
            const ctx = makeContext(undefined, async () => {
                if (gateArmed) { gateArmed = false; await gate; }
            });

            await openJsonEditorFile(ctx, fileA);
            const postedBefore = fake.posted.length;

            // save 를 시작하되 기다리지 않는다 — setRecoveryEntry 에서 멈춘다.
            const savePending = fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            // 그 사이 다른 파일을 연다 (패널 재사용 → 새 세션).
            await openJsonEditorFile(ctx, fileB);
            release();
            await savePending;

            const saveResults = fake.posted
                .slice(postedBefore)
                .filter(m => m && m.command === 'saveResult');
            assert.deepStrictEqual(
                saveResults, [],
                `세션이 바뀐 뒤에는 저장 결과를 보내지 않아야 한다: ${JSON.stringify(saveResults)}`
            );
            // 파일 자체는 정상적으로 쓰였다 — 억제하는 것은 응답뿐이다.
            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(fileA, 'utf-8')),
                { rows: [{ a: 2 }] },
                '응답 억제가 저장 자체를 막으면 안 된다'
            );
        });

        test('예기치 않은 실패도 화면에 흔적을 남긴다', async () => {
            // 알려진 실패(쓰기 · stat · recovery 정리)는 각자의 메시지가 있다.
            // 그 바깥에서 던지는 것 — 여기서는 응답 전송 자체 — 은 우리가 모르는
            // 상태이고, 메시지 핸들러는 async 인데 VS Code 가 await 하지 않으므로
            // 그냥 던지면 확장 호스트 로그에만 남는다. 저장한 줄 아는 사용자에게
            // 아무 신호도 가지 않는 것이 문제였다.
            const fake = installFakePanel();
            const filePath = writeJson('save-boom.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            (fake.panel.webview as any).postMessage = () => { throw new Error('post-boom'); };

            await assert.rejects(
                fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 }),
                /post-boom/,
                '스택은 로그에 남도록 다시 던져야 한다'
            );

            assert.ok(
                shownErrors.some(m => m.includes('save-boom.json')),
                `사용자에게 아무것도 알리지 않았다: ${JSON.stringify(shownErrors)}`
            );
            // 바이트는 이미 디스크에 있다 — 그래서 "저장 실패" 라고 단정하지 않는다.
            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(filePath, 'utf-8')),
                { rows: [{ a: 2 }] },
                '응답 전송 실패가 저장 자체를 되돌리지는 않는다'
            );
        });

        test('저장만으로는 host dirty 가 내려가지 않는다 (ack 전 편집 보호)', async () => {
            // 리뷰가 짚은 흐름: A → B 편집 → 저장 → ack 를 기다리는 사이 B 를 C 로
            // 편집하거나 A 로 undo. 그 편집의 setModified(true) 는 값이 안 바뀌어
            // host 로 오지 않고, snapshot 도 dirty 를 올리지 않는다. host 가 저장
            // 직후 스스로 clean 이 되면 여기서 다른 파일을 열 때 확인창 없이
            // 편집이 사라진다.
            const fake = installFakePanel();
            const filePath = writeJson('ack.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'modified', value: true });
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            assert.strictEqual(
                jsonPanelRegistry.isDirty(), true,
                'ack 를 받기 전에 host 가 clean 이 되면 그 창에서 편집이 조용히 사라진다'
            );
            // ack 전의 clean 선언은 무시된다.
            await fake.send({ command: 'modified', value: false });
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);

            // 진짜 상태는 ack 에 실려 온다.
            await fake.send({ command: 'saveAck', seq: 1, dirty: false });
            assert.strictEqual(jsonPanelRegistry.isDirty(), false);
        });

        test('ack 전 편집이 있으면 webview 가 dirty 로 되돌려 host 가 계속 보호한다', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('ack-edit.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'modified', value: true });
            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            // 응답을 받은 webview 는 "저장 뒤에도 편집이 남았다" 를 알린다.
            await fake.send({ command: 'modified', value: true });

            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
        });

        test('디스크 쓰기 성공과 recovery 정리 실패를 구분한다', async () => {
            // 둘이 한 try 에 묶여 있던 시절에는 쓰기가 끝난 뒤 recovery 삭제만
            // 실패해도 success:false 가 나갔다. 그러면 webview 는 baseline 을
            // 옮기지 못한 채 **옛** baseline 과 비교하게 되고, 그 사이 사용자가
            // 옛 내용으로 undo 했다면 디스크와 다른데도 clean 으로 판정한다.
            const fake = installFakePanel();
            const filePath = writeJson('recovery-fail.json', { rows: [{ a: 1 }] });
            const ctx = makeContext(undefined, async () => {
                throw new Error('workspaceState is full');
            });
            await openJsonEditorFile(ctx, filePath);
            await fake.send({ command: 'modified', value: true });

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });

            const result = lastSaveResult(fake);
            assert.strictEqual(
                result.success, true,
                '디스크에는 들어갔으므로 저장은 성공이다 — 정리 실패가 그것을 뒤집으면 안 된다'
            );
            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(filePath, 'utf-8')),
                { rows: [{ a: 2 }] }
            );
            // 정리 실패는 조용히 넘기지 않는다.
            assert.ok(
                shownWarnings.some(w => /recovery snapshot|복구 스냅샷/.test(w)),
                `정리 실패를 알리지 않았다: ${JSON.stringify(shownWarnings)}`
            );
            // webview 가 아직 응답을 처리하지 않았으므로 host 는 dirty 로 남는다.
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
        });

        test('응답 전 undo 가 host 를 clean 으로 되돌리지 못한다', async () => {
            // A → B 편집 → B 저장 → **응답 전** A 로 undo.
            // webview 는 아직 옛 baseline(A) 과 비교하므로 "변경 없음" 이라고
            // 말하지만, 디스크에는 방금 쓴 B 가 있다. 그 clean 을 믿으면 파일을
            // 바꿀 때 확인창도 recovery 도 없이 A 가 사라진다.
            const fake = installFakePanel();
            const filePath = writeJson('undo-ack.json', { rows: [{ a: 'A' }] });

            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let gateArmed = true;
            const ctx = makeContext(undefined, async () => {
                if (gateArmed) { gateArmed = false; await gate; }
            });

            await openJsonEditorFile(ctx, filePath);
            await fake.send({ command: 'modified', value: true });

            // 저장을 시작하되 기다리지 않는다 — recovery 삭제에서 멈춰 ack 창이 열린다.
            const savePending = fake.send({ command: 'save', data: { rows: [{ a: 'B' }] }, seq: 1 });
            // 그 창에서 사용자가 A 로 undo → webview 는 옛 baseline 과 같다고 판단.
            await fake.send({ command: 'modified', value: false });

            assert.strictEqual(
                jsonPanelRegistry.isDirty(), true,
                '저장 응답을 기다리는 중의 clean 선언을 믿으면 undo 결과가 조용히 사라진다'
            );

            release();
            await savePending;

            // 응답을 처리한 webview 가 진짜 상태(디스크 B ≠ 화면 A → dirty)를 알린다.
            await fake.send({ command: 'modified', value: true });
            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
        });

        test('실제 webview 순서(saveAck 한 번)로 저장 후 clean 이 된다', async () => {
            // webview 는 saveResult 를 처리하며 dirty 를 **saveAck 에 실어**
            // 한 번에 알린다 (`setModifiedLocal` 은 host 로 보내지 않는다).
            // host 가 ack 에서 dirty 를 적용하지 않으면 정상 저장인데도 영원히
            // dirty 로 남아 파일을 바꿀 때마다 폐기 확인창이 뜬다.
            //
            // 예전 이 테스트는 webview 가 보내지도 않는 `modified:false` 를
            // 수동으로 끼워 넣어 "실제 순서" 라고 불렀다. 그 메시지가 clean 을
            // 만들어 주는 바람에, ack 만으로 clean 이 되는지는 검증되지 않았다.
            const fake = installFakePanel();
            const filePath = writeJson('real-order.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'modified', value: true });
            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            // ↓ 실제 순서 — 저장 응답 처리의 산출물은 이 한 메시지뿐이다.
            await fake.send({ command: 'saveAck', seq: 1, dirty: false });

            assert.strictEqual(
                jsonPanelRegistry.isDirty(), false,
                '정상 저장인데 host 가 dirty 로 남았다 — 전환할 때마다 폐기 확인창이 뜬다'
            );
        });

        test('응답 대기 중 친 입력의 draft 가 복구본으로 남는다', async () => {
            // P1 의 host 쪽 절반. webview 가 saveResult 를 처리하며 보내는 것은
            // (1) 미커밋 입력이 반영된 `snapshot` 과 (2) dirty 를 실은 `saveAck`
            // 다. host 는 저장하면서 recovery 를 비웠으므로, 그 snapshot 이
            // 복구본으로 다시 자리 잡아야 패널이 닫혀도 입력을 되찾는다.
            //
            // (webview 가 그 순간 **무엇을** 보내는지는
            // src/test/jsonEditorWebviewDraft.test.ts 가 실제 스크립트를 돌려서
            // 검증한다. 여기서는 host 가 그것을 잃지 않는지를 본다.)
            const fake = installFakePanel();
            const filePath = writeJson('draft-after-save.json', { rows: [{ a: 'A' }] });
            const ctx = makeContext();
            await openJsonEditorFile(ctx, filePath);

            await fake.send({ command: 'modified', value: true });
            await fake.send({ command: 'save', data: { rows: [{ a: 'B' }] }, seq: 1 });
            // 응답을 기다리는 사이 셀에 D 입력 → keystroke draft.
            await fake.send({ command: 'snapshot', data: { rows: [{ a: 'D' }] } });
            // 응답 처리: 같은 draft 를 다시 보내고 dirty 로 ack.
            await fake.send({ command: 'snapshot', data: { rows: [{ a: 'D' }] } });
            await fake.send({ command: 'saveAck', seq: 1, dirty: true });

            assert.strictEqual(jsonPanelRegistry.isDirty(), true, '미커밋 입력이 남았는데 clean 이 됐다');

            // commit 전에 패널을 닫는다 — dispose 는 pending snapshot 을 flush 한다.
            fake.disposePanel();
            await new Promise(resolve => setTimeout(resolve, 20));

            const entry = readRecoveryEntry(ctx, filePath);
            assert.ok(entry, '패널을 닫았는데 복구본이 없다 — 미커밋 입력을 되찾을 방법이 없다');
            assert.deepStrictEqual(
                (entry as any).data, { rows: [{ a: 'D' }] },
                '복구본이 저장된 B 로 덮였다 — 응답 대기 중 친 D 가 사라진다'
            );
        });

        test('저장이 끝난 뒤의 clean 선언은 정상적으로 받아들인다', async () => {
            // pending 가드가 정상 경로까지 막으면 저장해도 영원히 dirty 로 남는다.
            const fake = installFakePanel();
            const filePath = writeJson('clean-after.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'modified', value: true });
            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            await fake.send({ command: 'saveAck', seq: 1, dirty: false });

            assert.strictEqual(jsonPanelRegistry.isDirty(), false);
        });

        test('다른 세션의 save 는 이 파일에 쓰지 않는다', async () => {
            // 패널 재사용 중 옛 webview 가 보낸 save 가 새 핸들러에 도착하면,
            // 핸들러의 filePath 는 **새 파일**이라 그 파일에 옛 데이터를 쓴다.
            const fake = installFakePanel();
            const filePath = writeJson('wrong-session.json', { rows: [{ keep: true }] });
            await openJsonEditorFile(makeContext(), filePath);
            const before = fs.readFileSync(filePath, 'utf-8');

            await fake.send({
                command: 'save',
                data: { rows: [{ fromAnotherFile: true }] },
                seq: 1,
                session: fake.sessionId() + 999,
            });

            assert.strictEqual(
                fs.readFileSync(filePath, 'utf-8'), before,
                '남의 세션 save 가 이 파일을 덮어썼다'
            );
            assert.deepStrictEqual(
                fake.posted.filter(m => m && m.command === 'saveResult'), [],
                '남의 세션 save 에 응답까지 보내면 안 된다'
            );
        });

        test('이전 세션의 지연된 저장이 새 세션의 pending 카운터를 깎지 않는다', async () => {
            // 카운터가 모듈 전역이던 시절: B 를 열며 0 으로 초기화한 뒤 A 의
            // 지연된 저장이 finally 에서 한 번 더 내려 **음수**가 되고,
            // 그러면 B 의 첫 저장에서 ack 전 clean 방어가 통째로 꺼졌다.
            const fake = installFakePanel();
            const fileA = writeJson('ctr-a.json', { rows: [{ a: 1 }] });
            const fileB = writeJson('ctr-b.json', { rows: [{ b: 1 }] });

            // recovery 정리에서 멈추는 게이트. 여러 번 쓰므로 resolver 를 쌓아 둔다.
            let gateEnabled = false;
            const resolvers: Array<() => void> = [];
            const ctx = makeContext(undefined, async () => {
                if (!gateEnabled) { return; }
                await new Promise<void>(resolve => { resolvers.push(resolve); });
            });
            const waitForGate = async () => {
                for (let i = 0; i < 100 && resolvers.length === 0; i++) {
                    await new Promise(resolve => setImmediate(resolve));
                }
                assert.ok(resolvers.length > 0, '저장이 게이트에 도달하지 않았다');
            };

            await openJsonEditorFile(ctx, fileA);
            gateEnabled = true;
            const saveA = fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 1 });
            await waitForGate();

            // A 의 저장이 아직 진행 중인 상태에서 B 로 전환.
            gateEnabled = false;
            await openJsonEditorFile(ctx, fileB);
            gateEnabled = true;

            resolvers.shift()!();      // A 의 저장 마무리 → A 의 finally 가 돈다
            await saveA;

            // 이제 B 에서 저장하고, **그 ack 전에** clean 을 선언한다.
            await fake.send({ command: 'modified', value: true });
            const saveB = fake.send({ command: 'save', data: { rows: [{ b: 2 }] }, seq: 1 });
            await waitForGate();
            await fake.send({ command: 'modified', value: false });

            assert.strictEqual(
                jsonPanelRegistry.isDirty(), true,
                '카운터가 음수로 새어 B 의 ack 전 clean 방어가 꺼졌다'
            );

            resolvers.shift()!();
            await saveB;
        });

        test('다른 세션의 modified 는 host dirty 를 건드리지 않는다', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('wrong-session-modified.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            await fake.send({ command: 'modified', value: true });
            await fake.send({ command: 'modified', value: false, session: fake.sessionId() + 999 });

            assert.strictEqual(jsonPanelRegistry.isDirty(), true);
        });

        test('실패 응답에도 seq 가 실린다 (웹뷰의 pending 정리용)', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('save-fail.json', { rows: [{ a: 1 }] });
            await openJsonEditorFile(makeContext(), filePath);

            // 파일을 디렉터리로 바꿔 쓰기를 실패시킨다.
            fs.rmSync(filePath);
            fs.mkdirSync(filePath);

            await fake.send({ command: 'save', data: { rows: [{ a: 2 }] }, seq: 42 });

            const result = lastSaveResult(fake);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.seq, 42);
        });
    });

    /**
     * 복구 제안 경로 — 지금까지 **소스 정규식으로만** 검사되던 곳이다.
     *
     * 디스크 파일보다 나중에 저장된 스냅샷이 있으면 "복구하시겠습니까?" 를
     * 물어야 한다. 물어보는지, 그리고 대답에 따라 저장소가 어떻게 되는지를
     * 실제로 실행해서 본다.
     */
    suite('복구 스냅샷 제안', () => {
        function seedRecovery(filePath: string, data: unknown) {
            return {
                [RECOVERY_STATE_KEY]: {
                    [filePath]: {
                        // `shouldOfferRecovery` 는 **디스크가 그 뒤로 바뀌지
                        // 않았을 때만** 제안한다: 파일 mtime 과 크기가 스냅샷이
                        // 기록해 둔 값과 같아야 한다. 처음에 `savedAt` /
                        // `baselineMtimeMs` 같은 이름으로 넣었다가 조건을
                        // 통과하지 못해 제안 자체가 일어나지 않았다.
                        data,
                        isRootArray: false,
                        fileMtimeMs: fs.statSync(filePath).mtimeMs,
                        fileSize: fs.statSync(filePath).size,
                        capturedAt: Date.now(),
                    },
                },
            };
        }

        test('미저장 스냅샷이 있으면 복구를 제안한다', async () => {
            installFakePanel();
            const filePath = writeJson('recover.json', { rows: [{ a: 1 }] });
            const ctx = makeContext(seedRecovery(filePath, { rows: [{ a: 999 }] }));

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(infoPrompts.length, 1, `복구를 제안하지 않았다: ${JSON.stringify(infoPrompts)}`);
            assert.match(infoPrompts[0].message, /복구|Recover/);
            assert.strictEqual(infoPrompts[0].buttons.length, 2, '복구/버리기 두 선택지가 있어야 한다');
        });

        test('버리기를 고르면 스냅샷이 저장소에서 사라진다', async () => {
            installFakePanel();
            const filePath = writeJson('discard.json', { rows: [{ a: 1 }] });
            const ctx = makeContext(seedRecovery(filePath, { rows: [{ a: 999 }] }));
            infoAnswer = 1;   // '버리기'

            await openJsonEditorFile(ctx, filePath);

            const stored = ctx.workspaceState.get<Record<string, unknown>>(RECOVERY_STATE_KEY, {});
            assert.ok(
                !Object.prototype.hasOwnProperty.call(stored, filePath),
                '버렸는데 스냅샷이 남아 있다 — 다음에 열 때 또 제안된다'
            );
        });

        test('스냅샷이 없으면 아무것도 묻지 않는다', async () => {
            installFakePanel();
            const filePath = writeJson('clean.json', { rows: [] });

            await openJsonEditorFile(makeContext(), filePath);

            assert.strictEqual(infoPrompts.length, 0, `물어볼 것이 없는데 프롬프트가 떴다: ${JSON.stringify(infoPrompts)}`);
        });
    });

    /**
     * 디스크 단계가 실패해도 미저장 변경이 잠기지 않는다.
     *
     * dirty 상태로 닫은 뒤 파일에 사고가 나면(삭제 / 크기 폭증 / 깨진 JSON)
     * 여는 것 자체가 실패한다. 그때 **그냥 오류만 띄우고 끝내면** 사용자의
     * 미저장 변경이 복구 저장소에 있는 채로 영영 접근 불가가 된다. stat /
     * size / read / parse 네 단계의 실패를 하나의 fallback 으로 모아, 매칭되는
     * 복구본이 있으면 그것을 제안한다.
     *
     * 이 계약은 지금까지 **소스 텍스트를 정규식으로** 검사했다 —
     * `earlyError = {` 가 4번 나오는지 세고, `baselineUnknownForWebview = true`
     * 라는 문자열이 있는지 보는 식이다. 코드에 그 문자열이 있는지만 볼 뿐
     * 실제로 복구가 제안되는지는 확인하지 않는다. 여기서 실행해서 본다.
     */
    suite('디스크 단계 실패 시 복구 fallback', () => {
        /** 파일을 만들고 그것에 맞는 복구 스냅샷을 seed 한 뒤, 파일을 망가뜨린다. */
        function seedThenBreak(name: string, breakIt: (filePath: string) => void) {
            const filePath = writeJson(name, { rows: [{ a: 1 }] });
            const stat = fs.statSync(filePath);
            const seed = {
                [RECOVERY_STATE_KEY]: {
                    [filePath]: {
                        data: { rows: [{ a: 'unsaved work' }] },
                        isRootArray: false,
                        fileMtimeMs: stat.mtimeMs,
                        fileSize: stat.size,
                        capturedAt: Date.now(),
                    },
                },
            };
            breakIt(filePath);
            return { filePath, ctx: makeContext(seed) };
        }

        test('파일이 사라져도 복구를 제안한다 (stat 실패)', async () => {
            installFakePanel();
            const { filePath, ctx } = seedThenBreak('gone.json', p2 => fs.unlinkSync(p2));

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(
                infoPrompts.length, 1,
                `파일이 사라지자 미저장 변경이 잠겼다 — 복구 제안이 없다: ${shownErrors.join(' / ')}`
            );
        });

        /**
         * **mtime 과 크기를 원복하지 않는다.** 처음 이 테스트는 손상 후
         * `fs.utimesSync` 로 mtime 을 되돌리고 같은 길이로 덮어써서 신선도
         * 검사를 통과시켰다. 그런데 실전의 손상은 대개 외부 변경이라 mtime 이
         * 갱신되고 크기도 달라진다 — 즉 **테스트가 통과하는 조건 자체가
         * 실전에서 성립하지 않았고**, 그래서 fallback 이 한 번도 발동하지 못하는
         * 구조적 실패를 이 테스트가 가려 주고 있었다. 이제 평범하게 깨뜨린다.
         */
        test('JSON 이 깨져도 복구를 제안한다 (parse 실패, mtime·크기 변경됨)', async () => {
            installFakePanel();
            const { filePath, ctx } = seedThenBreak('corrupt.json', p2 => {
                // 길이도 mtime 도 그대로 두지 않는다 — 외부 편집의 실제 모양.
                fs.writeFileSync(p2, '{ "rows": [ { "a": ');
                const future = new Date(Date.now() + 60_000);
                fs.utimesSync(p2, future, future);
            });

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(
                infoPrompts.length, 1,
                `JSON 이 깨지자 미저장 변경이 잠겼다: ${shownErrors.join(' / ')}`
            );
        });

        test('크기 한도를 넘어간 파일도 복구를 제안한다', async () => {
            installFakePanel();
            // 0.6.47 이 명시적으로 노렸던 케이스인데, 크기가 달라지는 것이
            // 정의상 확실하므로 신선도 검사가 **항상** 어긋나 발동할 수 없었다.
            const { filePath, ctx } = seedThenBreak('oversize.json', p2 => {
                fs.writeFileSync(p2, `{"pad":"${'x'.repeat(11 * 1024 * 1024)}"}`);
            });

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(
                infoPrompts.length, 1,
                `크기 한도 초과에서 미저장 변경이 잠겼다: ${shownErrors.join(' / ')}`
            );
        });

        test('제안을 거절해도(Esc) 스냅샷은 남는다 — 신선도 불일치로 지우지 않는다', async () => {
            installFakePanel();
            const { filePath, ctx } = seedThenBreak('mismatch-keeps.json', p2 => {
                fs.writeFileSync(p2, '{ broken');
                const future = new Date(Date.now() + 60_000);
                fs.utimesSync(p2, future, future);
            });
            infoAnswer = undefined;

            await openJsonEditorFile(ctx, filePath);

            const state = ctx.workspaceState.get<Record<string, unknown>>(RECOVERY_STATE_KEY, {});
            assert.ok(
                state?.[filePath],
                '신선도가 어긋난다는 이유로 미저장 변경을 우리 판단으로 파기했다'
            );
        });

        test('복구본이 없으면 오류만 알리고 조용히 넘어가지 않는다', async () => {
            installFakePanel();
            const filePath = path.join(tempDir, 'no-recovery.json');
            fs.writeFileSync(filePath, '{ broken');

            await openJsonEditorFile(makeContext(), filePath);

            assert.strictEqual(infoPrompts.length, 0, '복구본이 없는데 제안했다');
            assert.ok(shownErrors.length > 0, '실패를 알리지도 않았다');
        });

        /**
         * 알림을 Esc/X 로 닫으면 `showInformationMessage` 는 `undefined` 를 준다.
         * 그것을 '버리기' 와 같이 처리하면 **결정을 미룬 것이 파기가 된다**.
         * 원본이 사라진 이 경로에서는 스냅샷이 유일한 복구본이라 되돌릴 수 없다.
         */
        test('제안을 Esc 로 닫아도 스냅샷은 남는다 (다음에 다시 제안)', async () => {
            installFakePanel();
            const { filePath, ctx } = seedThenBreak('dismiss-keeps.json', p2 => fs.unlinkSync(p2));
            infoAnswer = undefined;   // Esc/X — 아무 버튼도 누르지 않음

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(infoPrompts.length, 1, '복구 제안 자체가 뜨지 않았다');
            assert.ok(
                readRecoveryEntry(ctx, filePath),
                '알림을 닫았을 뿐인데 유일한 복구본이 삭제됐다 — 미저장 변경을 되찾을 방법이 없다'
            );

            // 스냅샷이 남아 있는 것만으로는 부족하다 — 다시 열었을 때 **실제로
            // 다시 제안되어야** 사용자가 되찾을 수 있다. 여기까지 봐야 이
            // 테스트가 제목대로 검증한다.
            await openJsonEditorFile(ctx, filePath);
            assert.strictEqual(
                infoPrompts.length, 2,
                '스냅샷은 남았는데 다시 열어도 제안하지 않는다 — 되찾을 경로가 없다'
            );
        });

        /**
         * 위 케이스는 원본이 사라진 `earlyError` 경로다. 정상 경로는 결과가
         * 다르다 — 편집기가 디스크 내용으로 **열리고**, 그 뒤에도 스냅샷이
         * 남아 있어야 한다. 여는 데 성공했다고 스냅샷을 정리해 버리면 안 된다.
         */
        test('정상 파일에서도 Esc 로 닫으면 패널은 열리고 스냅샷은 남는다', async () => {
            const fake = installFakePanel();
            const filePath = writeJson('dismiss-normal.json', { rows: [{ a: 1 }] });
            const stat = fs.statSync(filePath);
            const ctx = makeContext({
                [RECOVERY_STATE_KEY]: {
                    [filePath]: {
                        data: { rows: [{ a: 'unsaved work' }] },
                        isRootArray: false,
                        fileMtimeMs: stat.mtimeMs,
                        fileSize: stat.size,
                        capturedAt: Date.now(),
                    },
                },
            });
            infoAnswer = undefined;   // Esc/X

            await openJsonEditorFile(ctx, filePath);

            assert.ok(fake.events.includes('create-panel'), '복구를 거절했으면 디스크 내용으로 열려야 한다');
            assert.ok(readRecoveryEntry(ctx, filePath), '알림을 닫았을 뿐인데 스냅샷이 사라졌다');
        });

        /**
         * 위 수정이 반대쪽으로 넘어가지 않는지 고정한다 — 명시적 '버리기' 는
         * 계속 지워야 한다. 이 두 케이스가 짝이어야 판별력이 생긴다.
         */
        test('명시적 버리기는 스냅샷을 지운다', async () => {
            installFakePanel();
            const { filePath, ctx } = seedThenBreak('discard-clears.json', p2 => fs.unlinkSync(p2));
            infoAnswer = 1;   // '버리기'

            await openJsonEditorFile(ctx, filePath);

            assert.strictEqual(infoPrompts.length, 1, '복구 제안 자체가 뜨지 않았다');
            assert.strictEqual(
                readRecoveryEntry(ctx, filePath), undefined,
                "'버리기' 를 눌렀는데 스냅샷이 남았다 — 다음에 또 물어본다"
            );
        });

        test('복구를 고르면 패널이 열린다 (오류로 끝나지 않는다)', async () => {
            const fake = installFakePanel();
            const { filePath, ctx } = seedThenBreak('recover-open.json', p2 => fs.unlinkSync(p2));
            infoAnswer = 0;   // '복구'

            await openJsonEditorFile(ctx, filePath);

            assert.ok(
                fake.events.includes('create-panel'),
                '복구를 골랐는데 편집기가 열리지 않았다 — 미저장 변경에 접근할 수 없다'
            );
        });
    });
});
