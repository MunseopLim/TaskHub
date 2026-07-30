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
    const infoPrompts: { message: string; buttons: string[] }[] = [];
    /** 복구 프롬프트에서 누를 버튼의 인덱스. `undefined` 면 무시(닫기). */
    let infoAnswer: number | undefined;

    interface FakePanel {
        events: string[];
        panel: vscode.WebviewPanel;
    }

    function installFakePanel(): FakePanel {
        const events: string[] = [];
        let html = '';
        const panel = {
            title: '',
            webview: {
                get html() { return html; },
                set html(value: string) { html = value; events.push('set-html'); },
                postMessage: () => { events.push('post-message'); return Promise.resolve(true); },
                onDidReceiveMessage: () => ({ dispose() { /* no-op */ } }),
                asWebviewUri: (uri: vscode.Uri) => uri,
                cspSource: 'vscode-webview:',
            },
            reveal: () => { events.push('reveal'); },
            onDidDispose: () => ({ dispose() { /* no-op */ } }),
            onDidChangeViewState: () => ({ dispose() { /* no-op */ } }),
            dispose: () => { /* no-op */ },
        } as unknown as vscode.WebviewPanel;

        (vscode.window as any).createWebviewPanel = () => {
            events.push('create-panel');
            return panel;
        };
        return { events, panel };
    }

    /** workspaceState 를 메모리로 흉내 내는 컨텍스트. 복구 저장소가 여기 붙는다. */
    function makeContext(seed?: Record<string, unknown>): vscode.ExtensionContext {
        const store = new Map<string, unknown>(Object.entries(seed ?? {}));
        const memento = {
            get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
            update: async (k: string, v: unknown) => { store.set(k, v); },
            keys: () => Array.from(store.keys()),
            setKeysForSync: () => { /* no-op */ },
        };
        return {
            extensionPath: tempDir,
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
        shownErrors.length = 0;
        infoPrompts.length = 0;
        infoAnswer = undefined;
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
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function writeJson(name: string, data: unknown): string {
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return filePath;
    }

    test('정상 JSON 을 열면 패널이 생기고 그 파일을 잡는다', async () => {
        const fake = installFakePanel();
        const filePath = writeJson('config.json', { alpha: [{ id: 1 }] });

        await openJsonEditorFile(makeContext(), filePath);

        assert.ok(fake.events.includes('create-panel'), `패널이 만들어지지 않았다: ${shownErrors.join(' / ')}`);
        assert.ok(jsonPanelRegistry.has(), '레지스트리가 패널을 잡고 있지 않다');
        assert.strictEqual(jsonPanelRegistry.getFilePath(), filePath);
        assert.ok((jsonPanelRegistry.getHtml() ?? '').length > 0, 'HTML 이 비어 있다');
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

    test('없는 파일은 오류를 알리고 패널을 만들지 않는다', async () => {
        const fake = installFakePanel();

        await openJsonEditorFile(makeContext(), path.join(tempDir, 'nope.json'));

        assert.ok(!fake.events.includes('create-panel'));
        assert.ok(shownErrors.length > 0);
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

        /** 컨텍스트에 남아 있는 복구 스냅샷을 읽는다 (없으면 undefined). */
        function readRecovery(ctx: vscode.ExtensionContext, filePath: string): unknown {
            const state = ctx.workspaceState.get<Record<string, unknown>>(RECOVERY_STATE_KEY, {});
            return state?.[filePath];
        }

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
                readRecovery(ctx, filePath),
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
            assert.ok(readRecovery(ctx, filePath), '알림을 닫았을 뿐인데 스냅샷이 사라졌다');
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
                readRecovery(ctx, filePath), undefined,
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
