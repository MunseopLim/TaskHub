import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { openMemoryMapPanel, panelRegistry, MEMORY_MAP_MAX_FILE_SIZE } from '../memoryMapViewer';
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
