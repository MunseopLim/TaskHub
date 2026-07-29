import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { openMemoryMapPanel, panelRegistry, MEMORY_MAP_MAX_FILE_SIZE, MEMORY_MAP_MAX_SAVE_HTML_CHARS } from '../memoryMapViewer';
import { buildMinimalElf32 } from './fixtures/elfFixtures';

/**
 * Build a minimal ELF32 little-endian binary for testing.
 */

suite('Memory Map Viewer Test Suite', () => {
    const tmpDir = os.tmpdir();
    const elfBuf = buildMinimalElf32();
    let tmpFiles: string[] = [];

    setup(() => {
        panelRegistry.clear();
    });

    teardown(() => {
        panelRegistry.clear();
        for (const f of tmpFiles) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
        tmpFiles = [];
    });

    function createTempElf(subDir: string, fileName: string): string {
        const dir = path.join(tmpDir, 'taskhub-test', subDir);
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, elfBuf);
        tmpFiles.push(filePath);
        return filePath;
    }

    test('should open multiple panels for different file paths', () => {
        const file1 = createTempElf('project-a', 'firmware.axf');
        const file2 = createTempElf('project-b', 'firmware.axf');

        const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        openMemoryMapPanel(ctx, file1);
        openMemoryMapPanel(ctx, file2);

        assert.strictEqual(panelRegistry.size(), 2, 'should have 2 separate panels');
        assert.ok(panelRegistry.has(file1), 'panel for file1 should exist');
        assert.ok(panelRegistry.has(file2), 'panel for file2 should exist');
    });

    test('should reuse panel when opening the same file path', () => {
        const file1 = createTempElf('project-c', 'app.axf');

        const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        openMemoryMapPanel(ctx, file1);
        openMemoryMapPanel(ctx, file1);

        assert.strictEqual(panelRegistry.size(), 1, 'should still have 1 panel');
    });

    test('should track last active panel', () => {
        const file1 = createTempElf('project-d', 'a.axf');
        const file2 = createTempElf('project-e', 'b.axf');

        const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        openMemoryMapPanel(ctx, file1);
        openMemoryMapPanel(ctx, file2);

        assert.strictEqual(panelRegistry.getLastActive(), file2, 'last active should be file2');
    });

    suite('webview HTML — search UX', () => {
        // The search highlighting / sticky bar / auto-scroll behaviour lives in
        // the webview's inline CSS+JS, which isn't reachable from the extension
        // host. These tests pin the generated HTML so the helpers and styles
        // can't silently disappear (a broken template literal would also drop
        // the whole <script>, failing these assertions).

        test('search box is sticky, has match-nav controls, and a match-highlight style', () => {
            const file = createTempElf('search-ux-a', 'fw.axf');
            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, file);
            const html = panelRegistry.getHtml(file);
            assert.ok(html, 'panel HTML should be available');
            assert.ok(/\.search-box\s*\{[^}]*position:\s*sticky/.test(html!), '.search-box should be position: sticky');
            assert.ok(html!.includes('mark.sm-hl'), 'mark.sm-hl highlight style should be present');
            assert.ok(html!.includes('tr.current-match'), 'current-match style should be present');
            assert.ok(html!.includes('.search-count.no-match'), 'no-match count style should be present');
            assert.ok(html!.includes('id="searchPrev"') && html!.includes('id="searchNext"'), 'prev/next match buttons should be present');
            assert.ok(html!.includes('id="allSecCount"'), 'All Sections heading should carry a match-count span');
            assert.ok(/placeholder="Search\.\.\..*function.*"/.test(html!), 'search placeholder should mention the function column');
        });

        test('webview script exposes the highlight + match-navigation helpers', () => {
            const file = createTempElf('search-ux-b', 'fw.axf');
            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, file);
            const html = panelRegistry.getHtml(file)!;
            assert.ok(html.includes('function hl(text)'), 'hl() escape+highlight helper should be present');
            assert.ok(html.includes('function markTextNodes('), 'markTextNodes() helper should be present');
            assert.ok(html.includes('function goToMatch(') && html.includes('function revealMatch('), 'match-navigation helpers should be present');
            assert.ok(html.includes('rebuildMatchList'), 'match list should be rebuilt on each search');
            assert.ok(html.includes('resyncAfterReflow'), 'a column sort should re-sync match navigation');
            assert.ok(html.includes('ensureRegionExpanded'), 'navigating to a match should re-open a collapsed region');
            assert.ok(html.includes("scrollIntoView({ behavior: 'smooth', block: 'center' })"), 'navigating should center the match');
            // 0.6.26: 문구가 로케일 번들(S.noMatches)로 옮겨졌다. 검증 대상은
            // 문구 자체가 아니라 "결과 없음 상태를 표시한다"는 사실이다.
            assert.ok(html.includes('S.noMatches'), 'empty-result message should be present');
            assert.ok(html.includes("(curMatch + 1) + ' / ' + matchList.length"), 'count should show the current/total position');
            assert.ok(html.includes('searchAutoFunc'), 'search should auto-reveal the hidden func/section columns');
            assert.ok(html.includes('funcUserOverride'), 'a manual func-column toggle during search should suppress re-auto-reveal');
        });
    });

    suite('openMemoryMapPanel failure paths', () => {
        // Each failure test asserts that the panel was not created and the
        // registry wasn't touched. The user-visible error is routed through
        // vscode.window.showErrorMessage, which the test host swallows.

        test('non-existent file: panel is not created', () => {
            const missing = path.join(tmpDir, 'taskhub-test', 'missing', 'does-not-exist.axf');
            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, missing);
            assert.strictEqual(panelRegistry.has(missing), false);
            assert.strictEqual(panelRegistry.size(), 0);
        });

        test('file one byte over MEMORY_MAP_MAX_FILE_SIZE: panel is not created', () => {
            // Create a sparse file just above the limit. truncate allocates no
            // real blocks on APFS / ext4, so this stays fast and low-disk.
            const dir = path.join(tmpDir, 'taskhub-test', 'oversize');
            fs.mkdirSync(dir, { recursive: true });
            const oversize = path.join(dir, 'too-big.axf');
            const fd = fs.openSync(oversize, 'w');
            try {
                fs.ftruncateSync(fd, MEMORY_MAP_MAX_FILE_SIZE + 1);
            } finally {
                fs.closeSync(fd);
            }
            tmpFiles.push(oversize);
            const stat = fs.statSync(oversize);
            assert.strictEqual(stat.size, MEMORY_MAP_MAX_FILE_SIZE + 1, 'sparse-file size boundary setup');

            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, oversize);
            assert.strictEqual(panelRegistry.has(oversize), false);
            assert.strictEqual(panelRegistry.size(), 0);
        });

        test('file smaller than ELF header (<16 bytes): panel is not created', () => {
            const dir = path.join(tmpDir, 'taskhub-test', 'tooSmall');
            fs.mkdirSync(dir, { recursive: true });
            const tooSmall = path.join(dir, 'tiny.axf');
            fs.writeFileSync(tooSmall, Buffer.alloc(15, 0));
            tmpFiles.push(tooSmall);

            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, tooSmall);
            assert.strictEqual(panelRegistry.has(tooSmall), false);
            assert.strictEqual(panelRegistry.size(), 0);
        });

        test('buffer with wrong ELF magic: panel is not created (parseElf32 throws)', () => {
            const dir = path.join(tmpDir, 'taskhub-test', 'badMagic');
            fs.mkdirSync(dir, { recursive: true });
            const badMagic = path.join(dir, 'bad.axf');
            // 64 bytes, but the first 4 are not 0x7F 'E' 'L' 'F', so parseElf32 rejects.
            const buf = Buffer.alloc(64, 0);
            buf[0] = 0xFF; buf[1] = 0xFF; buf[2] = 0xFF; buf[3] = 0xFF;
            fs.writeFileSync(badMagic, buf);
            tmpFiles.push(badMagic);

            const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
            openMemoryMapPanel(ctx, badMagic);
            assert.strictEqual(panelRegistry.has(badMagic), false);
            assert.strictEqual(panelRegistry.size(), 0);
        });
    });
});

/**
 * Save HTML 상한을 **직렬화 전에** 적용하는가 (0.6.46).
 *
 * 예전에는 웹뷰가 `document.documentElement.outerHTML` 로 DOM 전체를 먼저
 * 문자열로 만들고, 그것이 구조화 복제로 호스트에 한 벌 더 복사된 **뒤에야**
 * 호스트가 크기를 검사했다. 즉 상한은 그 이후의 정규식 치환과 파일 쓰기만
 * 막았을 뿐, 가장 위험한 두 순간(직렬화·IPC 복제)은 이미 지난 뒤였다.
 *
 * 웹뷰 스크립트를 **실제로 실행해** 확인한다. 정규식으로 "코드가 있는지"만
 * 보면 로직이 틀려도 통과한다.
 */
suite('Memory Map Save HTML 상한 (직렬화 이전)', () => {
    let filePath: string;
    let handlerSource: string;
    let webviewHtml: string;

    suiteSetup(() => {
        panelRegistry.clear();
        filePath = path.join(os.tmpdir(), `taskhub-mm-save-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildMinimalElf32());
        const ctx = { extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapPanel(ctx, filePath, { regions: [] }));
        webviewHtml = panelRegistry.getHtml(filePath) ?? '';

        // 주입된 핸들러 본문을 그대로 꺼내 실행한다.
        const marker = "document.getElementById('btnSaveHtml').addEventListener('click', function() {";
        const start = webviewHtml.indexOf(marker);
        assert.ok(start >= 0, 'btnSaveHtml 핸들러를 찾지 못했다 — 마커가 바뀌었는지 확인이 필요하다');
        const bodyStart = start + marker.length;
        const end = webviewHtml.indexOf('\n    });', bodyStart);
        assert.ok(end > bodyStart, '핸들러 본문의 끝을 찾지 못했다');
        handlerSource = webviewHtml.slice(bodyStart, end);
        assert.ok(
            handlerSource.includes('SAVE_HTML_LIMIT'),
            '핸들러가 상한을 참조하지 않는다 — 직렬화 전 검사가 없다'
        );
    });

    suiteTeardown(() => {
        panelRegistry.clear();
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    });

    interface FakeNode {
        nodeType: number;
        localName?: string;
        nodeValue?: string;
        length?: number;
        substringData?: (offset: number, count: number) => string;
        parentNode?: FakeNode;
        parentElement?: FakeNode;
        attributes?: { name: string; value: string }[];
        childNodes?: FakeNode[];
        outerHTML?: string;
    }

    function textNode(value: string): FakeNode {
        return {
            nodeType: 3,
            length: value.length,
            substringData: (offset, count) => value.slice(offset, offset + count),
        };
    }

    function element(name: string, children: FakeNode[] = [], attributes: { name: string; value: string }[] = []): FakeNode {
        const node: FakeNode = { nodeType: 1, localName: name, attributes, childNodes: children };
        for (const child of children) {
            child.parentNode = node;
            child.parentElement = node;
        }
        return node;
    }

    /** 행과 inline script 크기를 지정해 가짜 DOM 을 만들고 핸들러를 돌린다. */
    function runHandler(
        rowCount: number,
        rowBytes: number,
        options: { scriptNode?: FakeNode; limit?: number; rowText?: string } = {}
    ): { posted: any[]; serialized: boolean } {
        const posted: any[] = [];
        let serialized = false;
        const rowHtml = options.rowText ?? 'x'.repeat(rowBytes);
        const rows = Array.from({ length: rowCount }, () => element('tr', [textNode(rowHtml)]));
        const head = element('head');
        const script = element('script', [options.scriptNode ?? textNode('')]);
        const body = element('body', [...rows, script]);
        const root = element('html', [head, body]);
        Object.defineProperty(root, 'outerHTML', {
            get() {
                serialized = true;
                return 'y'.repeat(Math.min(rowCount * rowBytes, 1024));
            },
        });

        const fakeDocument = {
            documentElement: root,
        };
        const fakeVscode = { postMessage: (m: any) => { posted.push(m); } };

        const fn = new Function('document', 'vscode', 'SAVE_HTML_LIMIT', handlerSource);
        fn(fakeDocument, fakeVscode, options.limit ?? MEMORY_MAP_MAX_SAVE_HTML_CHARS);
        return { posted, serialized };
    }

    test('상한 안이면 평소대로 HTML 을 보낸다', () => {
        const { posted, serialized } = runHandler(10, 100);
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].command, 'saveHtml');
        assert.ok(serialized, '상한 안에서는 직렬화가 일어나야 정상 동작이다');
    });

    test('리포트 본문을 웹뷰에 중복 삽입하거나 copy IPC payload로 보내지 않는다', () => {
        assert.ok(
            webviewHtml.includes("vscode.postMessage({ command: 'copyReport', kind: 'summary' });"),
            '요약 복사 버튼은 본문 대신 종류만 보내야 한다'
        );
        assert.ok(
            webviewHtml.includes("vscode.postMessage({ command: 'copyReport', kind: 'full' });"),
            '전체 덤프 버튼은 본문 대신 종류만 보내야 한다'
        );
        assert.ok(
            !/vscode\.postMessage\(\{\s*command:\s*['"]copyReport['"][^}]*\btext\s*:/.test(webviewHtml),
            '리포트 본문이 postMessage payload에 남아 있다'
        );
        assert.ok(!webviewHtml.includes('const report ='), '전체 덤프 문자열이 inline script에 남아 있다');
        assert.ok(!webviewHtml.includes('const summary ='), '요약 리포트 문자열이 inline script에 남아 있다');
    });

    test('상한을 넘으면 직렬화하지 않고 거부한다', () => {
        // 행 1024개 x 128KB = 128MB > 64MB 상한.
        const { posted, serialized } = runHandler(1024, 128 * 1024);
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(
            posted[0].command,
            'saveHtmlTooLarge',
            '상한을 넘겼는데 HTML 을 그대로 보냈다'
        );
        assert.strictEqual(
            serialized,
            false,
            'documentElement.outerHTML 이 호출됐다 — 막으려던 바로 그 직렬화가 일어났다'
        );
        assert.ok(
            !('html' in posted[0]),
            '거부 메시지에 HTML 이 실려 있다 — IPC 복제 비용을 그대로 치른다'
        );
    });

    test('행이 적어도 대형 RD/report inline script를 직렬화 전에 거부한다', () => {
        // 기존 head + <tr>.outerHTML 휴리스틱은 작은 행 두 개만 보고 통과한 뒤
        // 대형 RD/report/summary/mapSegHtml 이 든 script까지 outerHTML로 만들었다.
        // 작은 테스트 상한을 주어 같은 결함을 적은 메모리로 재현한다.
        let materialized = false;
        const scriptNode: FakeNode = { nodeType: 3, length: 4096 };
        Object.defineProperty(scriptNode, 'nodeValue', {
            get() {
                materialized = true;
                throw new Error('대형 script nodeValue를 materialize하면 안 된다');
            },
        });
        scriptNode.substringData = () => {
            materialized = true;
            throw new Error('raw script는 substringData도 읽으면 안 된다');
        };
        const { posted, serialized } = runHandler(2, 16, { scriptNode, limit: 1024 });

        assert.deepStrictEqual(posted, [{ command: 'saveHtmlTooLarge' }]);
        assert.strictEqual(
            serialized,
            false,
            '대형 inline script를 놓쳐 documentElement.outerHTML을 직렬화했다'
        );
        assert.strictEqual(materialized, false, 'script text를 length 검사 전에 materialize했다');
    });

    test('일반 텍스트의 NBSP entity 확장까지 상한에 반영한다', () => {
        // 원문은 100자뿐이지만 HTML fragment serialization에서는 각 문자가
        // &nbsp; 6자로 늘어난다. 이전 estimator는 원문 길이만 더해 300자
        // 상한을 통과한 뒤 전체 outerHTML을 만들었다.
        const { posted, serialized } = runHandler(1, 0, {
            rowText: '\u00a0'.repeat(100),
            limit: 300,
        });

        assert.deepStrictEqual(posted, [{ command: 'saveHtmlTooLarge' }]);
        assert.strictEqual(serialized, false, 'NBSP 확장을 과소계산해 전체 HTML을 직렬화했다');
    });

    test('상한을 넘으면 끝까지 세지 않고 즉시 멈춘다', () => {
        // 초과를 확인한 뒤에도 남은 행을 계속 훑으면, 큰 화면에서 거부 자체가
        // 오래 걸린다. 접근된 행 수로 조기 종료를 확인한다.
        let touched = 0;
        const posted: any[] = [];
        const rows = Array.from({ length: 5000 }, () => {
            const text: FakeNode = {
                nodeType: 3,
                length: 128 * 1024,
                substringData: (_offset, count) => {
                    touched++;
                    return 'x'.repeat(count);
                },
            };
            Object.defineProperty(text, 'nodeValue', {
                get() { throw new Error('일반 text도 전체 nodeValue를 읽으면 안 된다'); },
            });
            return element('tr', [text]);
        });
        const body = element('body', rows);
        const root = element('html', [element('head'), body]);
        const fakeDocument = { documentElement: root };
        const fn = new Function('document', 'vscode', 'SAVE_HTML_LIMIT', handlerSource);
        fn(fakeDocument, { postMessage: (m: any) => posted.push(m) }, MEMORY_MAP_MAX_SAVE_HTML_CHARS);

        assert.strictEqual(posted[0].command, 'saveHtmlTooLarge');
        assert.ok(touched < 5000, `행 ${touched}개를 전부 훑었다 — 조기 종료가 없다`);
    });
});
