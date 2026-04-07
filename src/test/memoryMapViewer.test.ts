import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { openMemoryMapPanel, panelRegistry } from '../memoryMapViewer';

/**
 * Build a minimal ELF32 little-endian binary for testing.
 */
function buildMinimalElf32(): Buffer {
    const SHT_PROGBITS = 1;
    const SHF_ALLOC = 0x2;
    const SHF_EXECINSTR = 0x4;

    const sections = [
        { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0x08000000, size: 1024 },
    ];

    let strTab = '\0';
    const nameOffsets: number[] = [];
    for (const sec of sections) {
        nameOffsets.push(strTab.length);
        strTab += sec.name + '\0';
    }
    const shstrtabNameOffset = strTab.length;
    strTab += '.shstrtab\0';

    const strTabBuf = Buffer.from(strTab, 'ascii');
    const elfHeaderSize = 52;
    const shEntSize = 40;
    const totalSections = 1 + sections.length + 1;
    const strTabOffset = elfHeaderSize;
    const shOffset = elfHeaderSize + strTabBuf.length;
    const totalSize = shOffset + totalSections * shEntSize;

    const buf = Buffer.alloc(totalSize, 0);
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46;
    buf[4] = 1; buf[5] = 1; buf[6] = 1;
    buf.writeUInt16LE(2, 16);
    buf.writeUInt16LE(40, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(0x08000000, 24);
    buf.writeUInt32LE(shOffset, 32);
    buf.writeUInt16LE(elfHeaderSize, 40);
    buf.writeUInt16LE(shEntSize, 46);
    buf.writeUInt16LE(totalSections, 48);
    buf.writeUInt16LE(totalSections - 1, 50);

    strTabBuf.copy(buf, strTabOffset);

    for (let i = 0; i < sections.length; i++) {
        const base = shOffset + (i + 1) * shEntSize;
        buf.writeUInt32LE(nameOffsets[i], base);
        buf.writeUInt32LE(sections[i].type, base + 4);
        buf.writeUInt32LE(sections[i].flags, base + 8);
        buf.writeUInt32LE(sections[i].addr, base + 12);
        buf.writeUInt32LE(strTabOffset, base + 16);
        buf.writeUInt32LE(sections[i].size, base + 20);
    }

    const shstrtabBase = shOffset + (totalSections - 1) * shEntSize;
    buf.writeUInt32LE(shstrtabNameOffset, shstrtabBase);
    buf.writeUInt32LE(3, shstrtabBase + 4);
    buf.writeUInt32LE(0, shstrtabBase + 8);
    buf.writeUInt32LE(0, shstrtabBase + 12);
    buf.writeUInt32LE(strTabOffset, shstrtabBase + 16);
    buf.writeUInt32LE(strTabBuf.length, shstrtabBase + 20);

    return buf;
}

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
});
