import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    MEMORY_MAP_MAX_LINKER_FILE_SIZE,
    MemoryMapOpenHistory,
    openMemoryMapFromListing,
    openMemoryMapFromUri,
    panelRegistry,
    stripMemoryMapHostBindings,
} from '../memoryMapViewer';
import {
    cloneMemoryMapHistoryConfig,
    loadMemoryMapConfigForResource,
} from '../extension';
import { filePathIdentityKey } from '../pathIdentity';
import { buildElf32WithSymbols, buildMinimalElf32 } from './fixtures/elfFixtures';

type MessageHandler = (message: any) => Promise<void> | void;

function assertSameFilePath(actual: string | undefined, expected: string): void {
    assert.ok(actual, '기록된 경로가 있어야 한다');
    assert.strictEqual(filePathIdentityKey(actual), filePathIdentityKey(expected));
}

interface FakePanelHarness {
    createCount: number;
    revealCount: number;
    posted: any[];
    failNextHtmlWrite(): void;
    renderId(): string;
    send(message: any): Promise<void>;
}

function buildElf32WithLoadSegment(memorySize: number): Buffer {
    const elf = buildMinimalElf32();
    const programHeaderOffset = elf.length;
    const result = Buffer.concat([elf, Buffer.alloc(32)]);

    result.writeUInt32LE(programHeaderOffset, 28); // e_phoff
    result.writeUInt16LE(32, 42);                  // e_phentsize
    result.writeUInt16LE(1, 44);                   // e_phnum
    result.writeUInt32LE(1, programHeaderOffset);      // PT_LOAD
    result.writeUInt32LE(52, programHeaderOffset + 4); // p_offset: ELF header 뒤 .text payload
    result.writeUInt32LE(0x08000000, programHeaderOffset + 8);  // p_vaddr
    result.writeUInt32LE(0x08000000, programHeaderOffset + 12); // p_paddr
    result.writeUInt32LE(1024, programHeaderOffset + 16);       // p_filesz
    result.writeUInt32LE(memorySize, programHeaderOffset + 20); // p_memsz
    result.writeUInt32LE(0x5, programHeaderOffset + 24);        // PF_R | PF_X
    result.writeUInt32LE(0x1000, programHeaderOffset + 28);     // p_align
    return result;
}

function assertRefreshFailed(message: any, renderId: string): void {
    assert.strictEqual(message?.command, 'refreshFailed');
    assert.strictEqual(message?.renderId, renderId);
    assert.strictEqual(typeof message?.refreshAttemptId, 'string');
    assert.ok(message.refreshAttemptId.length > 0 && message.refreshAttemptId.length <= 128);
    assert.strictEqual(typeof message?.reason, 'string');
    assert.ok(message.reason.length > 0, 'Refresh 실패 이유가 비어 있으면 안 된다');
    assert.ok(Number.isFinite(message?.failedAt), 'Refresh 실패 시각이 유효한 숫자여야 한다');
}

function installFakeMemoryMapPanel(): {
    harness: FakePanelHarness;
    restore(): void;
} {
    const originalCreate = vscode.window.createWebviewPanel;
    const handlers = new Set<MessageHandler>();
    let createCount = 0;
    let revealCount = 0;
    let shouldFailNextHtmlWrite = false;
    let currentHtml = '';
    let refreshAttemptSequence = 0;
    const posted: any[] = [];

    (vscode.window as any).createWebviewPanel = (_viewType: string, title: string) => {
        createCount++;
        let html = '';
        return {
            title,
            active: true,
            webview: {
                get html() { return html; },
                set html(value: string) {
                    if (shouldFailNextHtmlWrite) {
                        shouldFailNextHtmlWrite = false;
                        throw new Error('injected webview HTML write failure');
                    }
                    html = value;
                    currentHtml = value;
                },
                cspSource: 'vscode-webview:',
                postMessage(message: any) {
                    posted.push(message);
                    return Promise.resolve(true);
                },
                onDidReceiveMessage(nextHandler: MessageHandler) {
                    handlers.add(nextHandler);
                    return {
                        dispose() {
                            handlers.delete(nextHandler);
                        },
                    };
                },
            },
            reveal() { revealCount++; },
            dispose() { handlers.clear(); },
            onDidDispose() { return { dispose() { /* no-op */ } }; },
            onDidChangeViewState() { return { dispose() { /* no-op */ } }; },
        } as unknown as vscode.WebviewPanel;
    };

    return {
        harness: {
            get createCount() { return createCount; },
            get revealCount() { return revealCount; },
            posted,
            failNextHtmlWrite() { shouldFailNextHtmlWrite = true; },
            renderId() {
                const match = currentHtml.match(/const RENDER_ID = ("[^"]+");/);
                assert.ok(match, '현재 Memory Map render ID를 찾지 못했다');
                return JSON.parse(match![1]);
            },
            async send(message: any): Promise<void> {
                assert.strictEqual(handlers.size, 1, '활성 Memory Map handler는 정확히 하나여야 한다');
                let withRender = Object.prototype.hasOwnProperty.call(message, 'renderId')
                    ? message
                    : { ...message, renderId: this.renderId() };
                if (withRender.command === 'refresh'
                    && !Object.prototype.hasOwnProperty.call(withRender, 'refreshAttemptId')) {
                    withRender = {
                        ...withRender,
                        refreshAttemptId: `test-refresh-attempt-${++refreshAttemptSequence}`,
                    };
                }
                await Array.from(handlers)[0](withRender);
            },
        },
        restore() {
            (vscode.window as any).createWebviewPanel = originalCreate;
        },
    };
}

suite('Memory Map 빠른 열기 · Refresh', () => {
    let tempDir: string;
    let fake: ReturnType<typeof installFakeMemoryMapPanel>;
    let originalError: typeof vscode.window.showErrorMessage;
    let originalWarning: typeof vscode.window.showWarningMessage;
    let errors: string[];
    let warnings: string[];

    setup(() => {
        panelRegistry.clear();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-mm-refresh-'));
        fake = installFakeMemoryMapPanel();
        originalError = vscode.window.showErrorMessage;
        originalWarning = vscode.window.showWarningMessage;
        errors = [];
        warnings = [];
        (vscode.window as any).showErrorMessage = (message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        };
        (vscode.window as any).showWarningMessage = (message: string) => {
            warnings.push(message);
            return Promise.resolve(undefined);
        };
    });

    teardown(() => {
        panelRegistry.clear();
        fake.restore();
        (vscode.window as any).showErrorMessage = originalError;
        (vscode.window as any).showWarningMessage = originalWarning;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('Explorer URI를 대화상자 없이 열고 History를 한 번 기록한다', () => {
        const filePath = path.join(tempDir, 'FIRMWARE.ELF');
        fs.writeFileSync(filePath, buildMinimalElf32());
        const history: MemoryMapOpenHistory[] = [];
        const originalQuickPick = vscode.window.showQuickPick;
        const originalOpenDialog = vscode.window.showOpenDialog;
        let promptCount = 0;
        try {
            (vscode.window as any).showQuickPick = () => {
                promptCount++;
                throw new Error('빠른 열기는 Quick Pick을 열면 안 된다');
            };
            (vscode.window as any).showOpenDialog = () => {
                promptCount++;
                throw new Error('빠른 열기는 파일 대화상자를 열면 안 된다');
            };

            assert.strictEqual(openMemoryMapFromUri(
                { subscriptions: [] } as unknown as vscode.ExtensionContext,
                vscode.Uri.file(filePath),
                { regions: [{ name: 'FLASH', origin: 0x08000000, size: 64 * 1024 }] },
                entry => history.push(entry)
            ), true);
        } finally {
            (vscode.window as any).showQuickPick = originalQuickPick;
            (vscode.window as any).showOpenDialog = originalOpenDialog;
        }

        assert.strictEqual(promptCount, 0);
        assert.strictEqual(fake.harness.createCount, 1);
        assert.ok(panelRegistry.has(filePath));
        assert.strictEqual(history.length, 1);
        assertSameFilePath(history[0].filePath, filePath);
        assert.strictEqual(history[0].inputType, 'elf');
    });

    test('ELF 계열이 아닌 URI는 패널이나 History를 만들지 않는다', () => {
        const filePath = path.join(tempDir, 'firmware.txt');
        fs.writeFileSync(filePath, buildMinimalElf32());
        const history: MemoryMapOpenHistory[] = [];

        assert.strictEqual(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath),
            undefined,
            entry => history.push(entry)
        ), false);

        assert.strictEqual(fake.harness.createCount, 0);
        assert.strictEqual(panelRegistry.size(), 0);
        assert.deepStrictEqual(history, []);
        assert.ok(errors.some(message => /\.elf|\.axf|\.out/.test(message)));
    });

    test('파일시스템이 아닌 URI는 ELF 확장자여도 열지 않는다', () => {
        const history: MemoryMapOpenHistory[] = [];
        assert.strictEqual(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.parse('https://example.com/firmware.elf'),
            undefined,
            entry => history.push(entry)
        ), false);
        assert.strictEqual(fake.harness.createCount, 0);
        assert.deepStrictEqual(history, []);
    });

    test('ELF 교체 후 같은 패널을 새로 고치며 실패하면 이전 결과를 보존한다', async () => {
        const filePath = path.join(tempDir, 'firmware.axf');
        fs.writeFileSync(filePath, buildElf32WithSymbols());
        const history: MemoryMapOpenHistory[] = [];
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const config = {
            regions: [
                { name: 'FLASH', origin: 0x08000000, size: 64 * 1024 },
                { name: 'RAM', origin: 0x20000000, size: 32 * 1024 },
            ],
        };
        assert.ok(openMemoryMapFromUri(
            context,
            vscode.Uri.file(filePath),
            config,
            entry => history.push(entry)
        ));

        const firstHtml = panelRegistry.getHtml(filePath) ?? '';
        const firstRenderId = fake.harness.renderId();
        assert.ok(firstHtml.includes('id="btnRefresh"'));
        assert.ok(firstHtml.includes('memoryMapRenderId'));
        assert.ok(firstHtml.includes('vscode.getState()'));
        assert.ok(firstHtml.includes('vscode.setState('));
        assert.strictEqual(history.length, 1);

        const changed = buildElf32WithSymbols();
        changed.writeUInt32LE(0x08001234, 24);
        fs.writeFileSync(filePath, changed);
        await fake.harness.send({ command: 'refresh' });

        const refreshedHtml = panelRegistry.getHtml(filePath) ?? '';
        const refreshedRenderId = fake.harness.renderId();
        assert.ok(refreshedHtml.includes('0x08001234'), '새 ELF entry point가 렌더되어야 한다');
        assert.notStrictEqual(refreshedRenderId, firstRenderId);
        assert.strictEqual(fake.harness.createCount, 1, '새 탭을 만들면 안 된다');
        assert.strictEqual(fake.harness.revealCount, 1, '기존 탭을 다시 드러내야 한다');
        assert.strictEqual(panelRegistry.size(), 1);
        assert.strictEqual(history.length, 1, 'Refresh는 History를 추가하면 안 된다');

        await fake.harness.send({ command: 'refresh', renderId: firstRenderId });
        assert.strictEqual(panelRegistry.getHtml(filePath), refreshedHtml,
            '이전 webview에서 늦게 도착한 Refresh는 무시해야 한다');

        const stableHtml = refreshedHtml;
        const stableEntries = panelRegistry.getAllEntries(filePath);
        const stableHexTargets = panelRegistry.getHexTargets(filePath);
        fs.writeFileSync(filePath, Buffer.alloc(64));
        await fake.harness.send({ command: 'refresh' });

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml);
        assert.deepStrictEqual(panelRegistry.getAllEntries(filePath), stableEntries);
        assert.deepStrictEqual(panelRegistry.getHexTargets(filePath), stableHexTargets);
        assertRefreshFailed(fake.harness.posted.at(-1), refreshedRenderId);
        const durableFailure = fake.harness.posted.at(-1);
        assert.match(durableFailure.reason, /32비트|32-bit/i,
            '손상된 ELF는 지원 형식을 확인하도록 안내해야 한다');
        assert.match(durableFailure.reason, /빌드|rebuild/i,
            '손상된 ELF는 다시 빌드하는 복구 방법을 안내해야 한다');
        assert.doesNotMatch(durableFailure.reason, /Invalid ELF magic|ENOENT|no such file|taskhub-mm-refresh-/i,
            '파서 내부 오류나 raw errno를 실패 배너에 노출하면 안 된다');
        fake.harness.posted.length = 0;
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.deepStrictEqual(fake.harness.posted, [durableFailure],
            '숨겨진 webview가 놓친 실패는 ready handshake에서 다시 보내야 한다');
        fake.harness.posted.length = 0;
        await fake.harness.send({
            command: 'refreshFailureAcknowledged',
            refreshAttemptId: durableFailure.refreshAttemptId,
        });
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.deepStrictEqual(fake.harness.posted, [], '확인된 실패를 다시 보내면 안 된다');
        assert.ok(errors.some(message => /ELF|Memory Map/.test(message)));
        assert.strictEqual(history.length, 1);

        const recovered = buildElf32WithSymbols();
        recovered.writeUInt32LE(0x08005678, 24);
        fs.writeFileSync(filePath, recovered);
        fake.harness.failNextHtmlWrite();
        await fake.harness.send({ command: 'refresh' });
        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml,
            '렌더 commit 실패도 이전 HTML을 유지해야 한다');
        assert.deepStrictEqual(panelRegistry.getAllEntries(filePath), stableEntries);
        assert.deepStrictEqual(panelRegistry.getHexTargets(filePath), stableHexTargets);
        const commitFailure = fake.harness.posted.at(-1) as { reason: string } | undefined;
        assert.ok(commitFailure);
        assertRefreshFailed(commitFailure, refreshedRenderId);
        assert.doesNotMatch(commitFailure.reason, /injected webview HTML write failure/i,
            '예상 밖 Refresh 예외도 내부 메시지를 배너에 그대로 노출하면 안 된다');
        assert.match(commitFailure.reason, /빌드|새로 고침|rebuild|refresh/i);

        await fake.harness.send({ command: 'refresh' });
        assert.ok((panelRegistry.getHtml(filePath) ?? '').includes('0x08005678'));
        assert.strictEqual(fake.harness.createCount, 1);
    });

    test('같은 render의 이전 Refresh 확인이 최신 실패 상태를 지우지 않는다', async () => {
        const filePath = path.join(tempDir, 'refresh-attempt-race.elf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));

        const renderId = fake.harness.renderId();
        fs.writeFileSync(filePath, Buffer.alloc(64));
        await fake.harness.send({ command: 'refresh', refreshAttemptId: 'attempt-1' });
        const firstFailure = fake.harness.posted.at(-1);
        assertRefreshFailed(firstFailure, renderId);
        assert.strictEqual(firstFailure.refreshAttemptId, 'attempt-1');

        await fake.harness.send({ command: 'refresh', refreshAttemptId: 'attempt-2' });
        const secondFailure = fake.harness.posted.at(-1);
        assertRefreshFailed(secondFailure, renderId);
        assert.strictEqual(secondFailure.refreshAttemptId, 'attempt-2');

        fake.harness.posted.length = 0;
        await fake.harness.send({
            command: 'refreshFailureAcknowledged',
            refreshAttemptId: firstFailure.refreshAttemptId,
        });
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.deepStrictEqual(fake.harness.posted, [secondFailure],
            '이전 attempt의 늦은 ack가 최신 durable failure를 지우면 안 된다');

        fake.harness.posted.length = 0;
        await fake.harness.send({
            command: 'refreshFailureAcknowledged',
            refreshAttemptId: secondFailure.refreshAttemptId,
        });
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.deepStrictEqual(fake.harness.posted, [],
            '최신 attempt의 ack만 durable failure를 해제해야 한다');
    });

    test('잘못된 Refresh attempt ID는 host 재분석을 시작하지 않는다', async () => {
        const filePath = path.join(tempDir, 'invalid-refresh-attempt.elf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath),
            { regions: [{ name: 'FLASH', origin: 0x08000000, size: 64 * 1024 }] }
        ));

        const stableHtml = panelRegistry.getHtml(filePath);
        const stableRenderId = fake.harness.renderId();
        const invalidAttempts: { label: string; value: unknown }[] = [
            { label: 'undefined', value: undefined },
            { label: 'empty', value: '' },
            { label: 'object', value: { attempt: 'invalid' } },
            { label: 'too-long', value: 'a'.repeat(129) },
        ];

        for (const invalid of invalidAttempts) {
            await fake.harness.send({
                command: 'refresh',
                // own property를 명시해 fake harness의 정상 ID 자동 주입을 우회한다.
                refreshAttemptId: invalid.value,
            });
            assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml,
                `${invalid.label} attempt가 HTML을 다시 렌더하면 안 된다`);
            assert.strictEqual(fake.harness.renderId(), stableRenderId,
                `${invalid.label} attempt가 render ID를 바꾸면 안 된다`);
            assert.strictEqual(fake.harness.revealCount, 0,
                `${invalid.label} attempt가 패널 Refresh를 실행하면 안 된다`);
            assert.deepStrictEqual(fake.harness.posted, [],
                `${invalid.label} attempt에 host 응답을 보내면 안 된다`);
        }

        const changed = buildMinimalElf32();
        changed.writeUInt32LE(0x08004321, 24);
        fs.writeFileSync(filePath, changed);
        await fake.harness.send({ command: 'refresh', refreshAttemptId: 'valid-attempt' });
        assert.notStrictEqual(fake.harness.renderId(), stableRenderId,
            '유효한 attempt는 실제로 새 render를 만들어야 한다');
        assert.ok((panelRegistry.getHtml(filePath) ?? '').includes('0x08004321'));
        assert.strictEqual(fake.harness.revealCount, 1,
            '대조군의 유효한 Refresh가 실행되지 않았다');
    });

    test('Refresh 중 사라진 ELF는 raw errno 없이 복구 방법을 안내한다', async () => {
        const filePath = path.join(tempDir, 'removed-input.elf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const stableHtml = panelRegistry.getHtml(filePath);
        const renderId = fake.harness.renderId();

        fs.unlinkSync(filePath);
        await fake.harness.send({ command: 'refresh' });

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml);
        const failure = fake.harness.posted.at(-1);
        assertRefreshFailed(failure, renderId);
        assert.ok(failure.reason.includes(path.basename(filePath)));
        assert.match(failure.reason, /복원|빌드|restore|rebuild/i);
        assert.doesNotMatch(failure.reason, /ENOENT|no such file|taskhub-mm-refresh-/i);
    });

    test('Refresh 중 사라진 Listing도 raw errno 없이 복구 방법을 안내한다', async () => {
        const filePath = path.join(tempDir, 'removed-input.txt');
        fs.copyFileSync(
            path.resolve(__dirname, '..', '..', 'examples', 'sample_armlink.txt'),
            filePath
        );
        assert.ok(openMemoryMapFromListing(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            filePath
        ));
        const stableHtml = panelRegistry.getHtml(filePath);
        const renderId = fake.harness.renderId();

        fs.unlinkSync(filePath);
        await fake.harness.send({ command: 'refresh' });

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml);
        const failure = fake.harness.posted.at(-1);
        assertRefreshFailed(failure, renderId);
        assert.ok(failure.reason.includes(path.basename(filePath)));
        assert.match(failure.reason, /복원|빌드|restore|rebuild/i);
        assert.doesNotMatch(failure.reason, /ENOENT|no such file|taskhub-mm-refresh-/i);
    });

    test('선택한 linker 파일을 다시 읽고 파싱 실패 시 이전 영역을 유지한다', async () => {
        const filePath = path.join(tempDir, 'firmware.out');
        const linkerPath = path.join(tempDir, 'memory.ld');
        fs.writeFileSync(filePath, buildMinimalElf32());
        fs.writeFileSync(linkerPath, 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K }');

        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath), { linkerFilePath: linkerPath }));
        assert.ok((panelRegistry.getHtml(filePath) ?? '').includes('64.0 KB'));

        fs.writeFileSync(linkerPath, 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 128K }');
        await fake.harness.send({ command: 'refresh' });
        const refreshedHtml = panelRegistry.getHtml(filePath) ?? '';
        assert.ok(refreshedHtml.includes('128.0 KB'), '링커 파일의 최신 크기를 사용해야 한다');

        fs.writeFileSync(linkerPath, 'MEMORY { /* invalidated while panel is open */ }');
        await fake.harness.send({ command: 'refresh' });
        assert.strictEqual(panelRegistry.getHtml(filePath), refreshedHtml);
        assertRefreshFailed(fake.harness.posted.at(-1), fake.harness.renderId());
        assert.ok(warnings.some(message => /MEMORY|영역/.test(message)));

        fs.writeFileSync(linkerPath, 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 256K }');
        await fake.harness.send({ command: 'refresh' });
        assert.ok((panelRegistry.getHtml(filePath) ?? '').includes('256.0 KB'));
        assert.strictEqual(fake.harness.createCount, 1);
    });

    test('사라진 linker의 cold open은 저장 영역을 쓰고 Refresh 실패는 이전 결과를 유지한다', async () => {
        const filePath = path.join(tempDir, 'missing-linker.axf');
        const linkerPath = path.join(tempDir, 'missing.ld');
        fs.writeFileSync(filePath, buildMinimalElf32());

        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath), {
            regions: [{ name: 'FLASH', origin: 0x08000000, size: 80 * 1024 }],
            linkerFilePath: linkerPath,
        }), '저장된 영역이 있으면 linker 파일이 사라져도 cold open이 성공해야 한다');

        const stableHtml = panelRegistry.getHtml(filePath) ?? '';
        const stableRenderId = fake.harness.renderId();
        assert.ok(stableHtml.includes('80.0 KB'), 'cold open은 저장된 영역 크기를 사용해야 한다');

        await fake.harness.send({ command: 'refresh' });

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml,
            '사라진 linker로 Refresh에 실패하면 기존 HTML을 보존해야 한다');
        const failure = fake.harness.posted.at(-1);
        assertRefreshFailed(failure, stableRenderId);
        assert.ok(failure.reason.includes(path.basename(linkerPath)));
        assert.ok(/복원|restore|선택|select/i.test(failure.reason), '실패 뒤 다음 단계가 있어야 한다');
        assert.doesNotMatch(failure.reason, /ENOENT|no such file|taskhub-mm-refresh-/i,
            '배너에는 raw errno나 절대 임시 경로를 노출하면 안 된다');
        assert.ok([...errors, ...warnings].some(message => message.includes(path.basename(linkerPath))));
    });

    test('비정상 linker 설정과 과대 파일이 예외를 누출하지 않는다', async () => {
        const filePath = path.join(tempDir, 'defensive-linker.elf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        assert.doesNotThrow(() => {
            assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath), {
                linkerFilePath: {} as unknown as string,
            }));
        }, 'persisted config가 손상돼도 path.basename TypeError가 밖으로 새면 안 된다');

        const linkerPath = path.join(tempDir, 'oversized.ld');
        fs.writeFileSync(linkerPath, '');
        fs.truncateSync(linkerPath, MEMORY_MAP_MAX_LINKER_FILE_SIZE + 1);
        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath), {
            regions: [{ name: 'FLASH', origin: 0x08000000, size: 64 * 1024 }],
            linkerFilePath: linkerPath,
        }), 'cold open은 저장 영역으로 계속 열어야 한다');
        const stableHtml = panelRegistry.getHtml(filePath);
        await fake.harness.send({ command: 'refresh' });
        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml);
        const failure = fake.harness.posted.at(-1);
        assertRefreshFailed(failure, fake.harness.renderId());
        assert.ok(/10\.0 MB|10 MB/.test(failure.reason), `링커 상한을 설명하지 않는다: ${failure.reason}`);
    });

    test('파싱할 수 없는 linker의 cold open은 PT_LOAD를 쓰고 Refresh 실패는 이전 결과를 유지한다', async () => {
        const filePath = path.join(tempDir, 'invalid-linker.elf');
        const linkerPath = path.join(tempDir, 'invalid.ld');
        fs.writeFileSync(filePath, buildElf32WithLoadSegment(96 * 1024));
        fs.writeFileSync(linkerPath, 'MEMORY { /* no valid regions */ }');

        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath), {
            linkerFilePath: linkerPath,
        }), 'PT_LOAD가 있으면 linker 파싱 실패에도 cold open이 성공해야 한다');

        const stableHtml = panelRegistry.getHtml(filePath) ?? '';
        const stableRenderId = fake.harness.renderId();
        assert.ok(stableHtml.includes('96.0 KB'), 'cold open은 PT_LOAD의 메모리 크기를 사용해야 한다');

        await fake.harness.send({ command: 'refresh' });

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml,
            '파싱할 수 없는 linker로 Refresh에 실패하면 기존 HTML을 보존해야 한다');
        assertRefreshFailed(fake.harness.posted.at(-1), stableRenderId);
        assert.ok([...errors, ...warnings].some(message => message.includes(path.basename(linkerPath))));
    });

    test('History가 linker 경로를 보존해 다시 연 패널도 같은 파일을 Refresh한다', () => {
        const linkerPath = path.join(tempDir, 'history.ld');
        const config = {
            regions: [{ name: 'FLASH', origin: 0x08000000, size: 64 * 1024 }],
            linkerFilePath: linkerPath,
        };
        assert.deepStrictEqual(cloneMemoryMapHistoryConfig(config), config);
        assert.deepStrictEqual(cloneMemoryMapHistoryConfig({ linkerFilePath: linkerPath }), {
            linkerFilePath: linkerPath,
        });
    });

    test('빠른 열기는 선택한 URI가 속한 workspace folder의 영역 설정을 쓴다', () => {
        const folderA = path.join(tempDir, 'workspace-a');
        const folderB = path.join(tempDir, 'workspace-b');
        const targetPath = path.join(folderB, 'build', 'firmware.elf');
        for (const [folder, size] of [[folderA, 64 * 1024], [folderB, 256 * 1024]] as const) {
            fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
            fs.writeFileSync(path.join(folder, '.vscode', 'taskhub_types.json'), JSON.stringify({
                memoryMap: { regions: [{ name: 'FLASH', origin: 0x08000000, size }] },
            }));
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, buildMinimalElf32());
        const targetUri = vscode.Uri.file(targetPath);

        const config = loadMemoryMapConfigForResource(targetUri, uri => {
            assert.strictEqual(uri.fsPath, targetUri.fsPath);
            return {
                uri: vscode.Uri.file(folderB),
                name: 'workspace-b',
                index: 1,
            };
        });

        assert.deepStrictEqual(config?.regions, [
            { name: 'FLASH', origin: 0x08000000, size: 256 * 1024 },
        ]);
    });

    test('영역 없음 복구는 현재 ELF를 유지하고 linker 파일만 한 번 고른다', async () => {
        const filePath = path.join(tempDir, 'configure-current.elf');
        const linkerPath = path.join(tempDir, 'configure-current.ld');
        fs.writeFileSync(filePath, buildMinimalElf32());
        fs.writeFileSync(linkerPath, 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K }');
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const recorded: MemoryMapOpenHistory[] = [];
        assert.ok(openMemoryMapFromUri(
            context,
            vscode.Uri.file(filePath),
            undefined,
            entry => recorded.push(entry)
        ));
        const initialHtml = panelRegistry.getHtml(filePath) ?? '';
        assert.ok(initialHtml.includes('class="no-regions"'));
        assert.ok(initialHtml.includes('id="btnConfigureMemoryMap"'),
            '영역 유무와 무관하게 ELF 툴바에서 linker를 다시 선택할 수 있어야 한다');

        const originalOpenDialog = vscode.window.showOpenDialog;
        const originalQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        let linkerDialogCount = 0;
        let quickPickCount = 0;
        let executeCommandCount = 0;
        try {
            (vscode.window as any).showOpenDialog = (options: vscode.OpenDialogOptions) => {
                linkerDialogCount++;
                assert.deepStrictEqual(options.filters, { 'Linker Script': ['ld', 'lds', 'lcf', 'sct'] });
                return Promise.resolve([vscode.Uri.file(linkerPath)]);
            };
            (vscode.window as any).showQuickPick = () => {
                quickPickCount++;
                return Promise.resolve(undefined);
            };
            (vscode.commands as any).executeCommand = () => {
                executeCommandCount++;
                return Promise.resolve(undefined);
            };

            await fake.harness.send({ command: 'showMemoryMapSetup' });
        } finally {
            (vscode.window as any).showOpenDialog = originalOpenDialog;
            (vscode.window as any).showQuickPick = originalQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
        }

        const configuredHtml = panelRegistry.getHtml(filePath) ?? '';
        assert.strictEqual(linkerDialogCount, 1);
        assert.strictEqual(quickPickCount, 0, '입력 형식 Quick Pick을 다시 열면 안 된다');
        assert.strictEqual(executeCommandCount, 0, '전체 Memory Map 마법사를 재실행하면 안 된다');
        assert.strictEqual(fake.harness.createCount, 1, '현재 패널을 재사용해야 한다');
        assert.strictEqual(fake.harness.revealCount, 1);
        assert.ok(!configuredHtml.includes('class="no-regions"'));
        assert.ok(configuredHtml.includes('64.0 KB'));
        assert.strictEqual(recorded.length, 2, '최초 open과 성공한 linker 재설정을 각각 기록해야 한다');
        assertSameFilePath(recorded[1].config?.linkerFilePath, linkerPath);
        const feedback = fake.harness.posted.at(-1);
        assert.strictEqual(feedback?.command, 'memoryMapPanelFeedback');
        assert.strictEqual(feedback?.kind, 'configure-success');
        assert.strictEqual(feedback?.linkerName, path.basename(linkerPath));
        assert.strictEqual(feedback?.renderId, fake.harness.renderId());
        fake.harness.posted.length = 0;
        await fake.harness.send({
            command: 'memoryMapPanelFeedbackAcknowledged',
            feedbackId: feedback?.feedbackId,
        });
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.deepStrictEqual(fake.harness.posted, [],
            '확인한 linker 적용 피드백을 ready 때 다시 보내면 안 된다');
    });

    test('영역이 남아 있는 linker 실패도 재선택 버튼과 패널 피드백을 제공한다', async () => {
        const filePath = path.join(tempDir, 'configure-existing.elf');
        const originalLinker = path.join(tempDir, 'configure-existing.ld');
        const missingReplacement = path.join(tempDir, 'missing-replacement.ld');
        fs.writeFileSync(filePath, buildMinimalElf32());
        fs.writeFileSync(originalLinker, 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K }');
        const recorded: MemoryMapOpenHistory[] = [];
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath),
            { linkerFilePath: originalLinker },
            entry => recorded.push(entry)
        ));

        const stableHtml = panelRegistry.getHtml(filePath) ?? '';
        assert.ok(stableHtml.includes('id="btnConfigureMemoryMap"'));
        fs.unlinkSync(originalLinker);
        await fake.harness.send({ command: 'refresh' });
        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml);
        assertRefreshFailed(fake.harness.posted.at(-1), fake.harness.renderId());

        const originalOpenDialog = vscode.window.showOpenDialog;
        try {
            (vscode.window as any).showOpenDialog = () => Promise.resolve([vscode.Uri.file(missingReplacement)]);
            await fake.harness.send({ command: 'showMemoryMapSetup' });
        } finally {
            (vscode.window as any).showOpenDialog = originalOpenDialog;
        }

        assert.strictEqual(panelRegistry.getHtml(filePath), stableHtml,
            '적용 실패는 이전 분석 HTML을 교체하면 안 된다');
        assert.strictEqual(recorded.length, 1, '실패한 linker 설정은 History에 기록하면 안 된다');
        const feedback = fake.harness.posted.at(-1);
        assert.strictEqual(feedback?.command, 'memoryMapPanelFeedback');
        assert.strictEqual(feedback?.kind, 'configure-failure');
        assert.strictEqual(feedback?.linkerName, path.basename(missingReplacement));
        assert.match(String(feedback?.reason), /복원|선택|restore|select/i);

        // configure feedback을 ack하지 않은 채 더 최신 Refresh를 수락한다. 이전
        // feedback이 durable state에 남으면 ready가 새 실패 뒤에 옛 문구를 다시
        // 보내 웹뷰의 최신 상태를 덮는다.
        fake.harness.posted.length = 0;
        await fake.harness.send({ command: 'refresh' });
        assert.strictEqual(fake.harness.posted.length, 1);
        assertRefreshFailed(fake.harness.posted[0], fake.harness.renderId());

        fake.harness.posted.length = 0;
        await fake.harness.send({ command: 'memoryMapReady' });
        assert.strictEqual(fake.harness.posted.length, 1);
        assertRefreshFailed(fake.harness.posted[0], fake.harness.renderId());
        assert.ok(!fake.harness.posted.some(message => message.command === 'memoryMapPanelFeedback'),
            '더 최신 Refresh 뒤에는 미확인 configure feedback을 ready에서 되살리면 안 된다');
    });

    test('linker picker가 열린 동안 중복 설정 요청을 무시하고 종료 뒤 다시 허용한다', async () => {
        const filePath = path.join(tempDir, 'configure-reentry.elf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));

        const originalOpenDialog = vscode.window.showOpenDialog;
        let dialogCount = 0;
        let resolveFirst!: (value: vscode.Uri[] | undefined) => void;
        try {
            (vscode.window as any).showOpenDialog = () => {
                dialogCount++;
                if (dialogCount === 1) {
                    return new Promise<vscode.Uri[] | undefined>(resolve => {
                        resolveFirst = resolve;
                    });
                }
                return Promise.resolve(undefined);
            };

            const firstRequest = fake.harness.send({ command: 'showMemoryMapSetup' });
            await Promise.resolve();
            assert.strictEqual(dialogCount, 1, '첫 설정 요청은 picker를 열어야 한다');

            await fake.harness.send({ command: 'showMemoryMapSetup' });
            assert.strictEqual(dialogCount, 1, 'picker 대기 중 중복 요청은 새 picker를 열면 안 된다');

            resolveFirst(undefined);
            await firstRequest;
            await fake.harness.send({ command: 'showMemoryMapSetup' });
            assert.strictEqual(dialogCount, 2, 'picker 종료 뒤에는 설정 요청을 다시 받아야 한다');
        } finally {
            (vscode.window as any).showOpenDialog = originalOpenDialog;
        }
    });

    test('standalone HTML에서는 동작할 수 없는 Refresh 컨트롤을 제거한다', () => {
        const filePath = path.join(tempDir, 'standalone.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath),
            { regions: [{ name: 'FLASH', origin: 0x08000000, size: 64 * 1024 }] }
        ));
        const webviewHtml = panelRegistry.getHtml(filePath) ?? '';
        // live DOM의 boolean attribute는 outerHTML에서 hidden=""로 직렬화된다.
        // 특정 문자열 치환에 기대지 않고 standalone 런타임이 안내를 열어야 한다.
        const serializedWebviewHtml = webviewHtml.replace(
            'id="memoryMapStandaloneNotice" class="standalone-notice" hidden>',
            'id="memoryMapStandaloneNotice" class="standalone-notice" hidden="">'
        );
        assert.notStrictEqual(serializedWebviewHtml, webviewHtml, 'live outerHTML 형태의 픽스처를 만들지 못했다');
        const standalone = stripMemoryMapHostBindings(serializedWebviewHtml);
        assert.ok(webviewHtml.includes('id="refreshControls"'));
        assert.ok(webviewHtml.includes('id="refreshStatus"'));
        assert.ok(!standalone.includes('id="refreshControls"'));
        assert.ok(!standalone.includes('id="refreshStatus"'),
            '저장 HTML에는 다시 시도할 수 없는 Refresh 상태 배너가 남으면 안 된다');
        assert.ok(!standalone.includes('id="refreshDismiss"'));
        assert.ok(!standalone.includes('id="memoryMapHostActions"'),
            '저장 HTML에는 동작하지 않는 host 전용 툴바가 남으면 안 된다');
        assert.ok(!standalone.includes('const vscode = acquireVsCodeApi()'));
        assert.doesNotMatch(standalone, /\bvscode\s*\.\s*postMessage\s*\(/,
            '저장 HTML에는 동작하지 않는 host postMessage 호출이 남으면 안 된다');
        assert.ok(standalone.includes('id="memoryMapStandaloneNotice" class="standalone-notice"'),
            '저장본임을 알리는 안내가 있어야 한다');
        assert.ok(standalone.includes('id="searchInput"'), '브라우저에서 동작하는 검색은 유지해야 한다');
        assert.ok(standalone.includes('data-action="toggle-all"'), '브라우저에서 동작하는 접기는 유지해야 한다');

        const standaloneInitStart = standalone.indexOf('    const IS_STANDALONE = ');
        const standaloneInitEnd = standalone.indexOf('    // render ID', standaloneInitStart);
        assert.ok(standaloneInitStart >= 0 && standaloneInitEnd > standaloneInitStart,
            'standalone 초기화 블록을 찾지 못했다');
        const removedCells: string[] = [];
        const notice = { hidden: true };
        const searchInput = { value: 'HAL_' };
        const detail = { innerHTML: '<table>stale live DOM</table>', style: { display: '' } };
        const headerAttributes = new Map<string, string>();
        const header = { setAttribute: (name: string, value: string) => headerAttributes.set(name, value) };
        const icon = { textContent: '▼' };
        const card = {
            style: { display: 'none' },
            querySelector: (selector: string) => selector === '.region-detail'
                ? detail
                : selector === '.region-header'
                    ? header
                    : selector === '.region-header .fold-icon'
                        ? icon
                        : null,
        };
        const restoredMarks: string[] = [];
        const mark = { textContent: 'HAL', replaceWith: (value: string) => restoredMarks.push(value) };
        const removedRowClasses: string[] = [];
        const staticRow = {
            style: { display: 'none' },
            classList: { remove: (...names: string[]) => removedRowClasses.push(...names) },
        };
        const currentRowClasses: string[] = [];
        const currentRow = { classList: { remove: (...names: string[]) => currentRowClasses.push(...names) } };
        const funcClasses: string[] = [];
        const funcCell = { classList: { add: (name: string) => funcClasses.push(name) } };
        const sortAttributes = new Map<string, string>();
        const sortHeader = {
            textContent: 'Size ▼',
            setAttribute: (name: string, value: string) => sortAttributes.set(name, value),
        };
        const runStandaloneInit = new Function(
            'document',
            'acquireVsCodeApi',
            standalone.slice(standaloneInitStart, standaloneInitEnd)
        ) as (...args: any[]) => void;
        runStandaloneInit({
            querySelectorAll: (selector: string) => {
                if (selector === '.memory-map-host-only') {
                    return [
                        { remove: () => removedCells.push('hex') },
                        { remove: () => removedCells.push('source') },
                    ];
                }
                if (selector === '.region-card') { return [card]; }
                if (selector === 'mark.sm-hl') { return [mark]; }
                if (selector === '#sectionTable tbody tr, .overview-table tbody tr') { return [staticRow]; }
                if (selector === '.current-match') { return [currentRow]; }
                if (selector === '.func-cell') { return [funcCell]; }
                if (selector === '.sortable-table th[data-sort]') { return [sortHeader]; }
                throw new Error(`예상하지 못한 selector: ${selector}`);
            },
            getElementById: (id: string) => id === 'memoryMapStandaloneNotice'
                ? notice
                : id === 'searchInput'
                    ? searchInput
                    : null,
        }, undefined);
        assert.deepStrictEqual(removedCells, ['hex', 'source'],
            '이미 렌더된 Hex/Source 셀을 standalone 시작 시 제거해야 한다');
        assert.strictEqual(notice.hidden, false, 'live outerHTML의 hidden 속성을 런타임에 해제해야 한다');
        assert.strictEqual(searchInput.value, '');
        assert.strictEqual(card.style.display, '');
        assert.strictEqual(detail.innerHTML, '', '직렬화된 lazy DOM은 canonical RD에서 다시 만들어야 한다');
        assert.strictEqual(detail.style.display, 'none');
        assert.strictEqual(headerAttributes.get('aria-expanded'), 'false');
        assert.strictEqual(icon.textContent, '▶');
        assert.deepStrictEqual(restoredMarks, ['HAL']);
        assert.strictEqual(staticRow.style.display, '');
        assert.deepStrictEqual(removedRowClasses, ['search-match', 'current-match']);
        assert.deepStrictEqual(currentRowClasses, ['current-match']);
        assert.deepStrictEqual(funcClasses, ['hidden']);
        assert.strictEqual(sortHeader.textContent, 'Size');
        assert.strictEqual(sortAttributes.get('aria-sort'), 'none');

        const rowStart = standalone.indexOf('    function rowHtml(');
        const rowEnd = standalone.indexOf('    function matchSeg(', rowStart);
        assert.ok(rowStart >= 0 && rowEnd > rowStart, '동적 region 행 생성기를 찾지 못했다');
        const runRowHtml = new Function(
            'IS_STANDALONE', 'funcVis', 'hl', 'esc', 'S', 'entry',
            `${standalone.slice(rowStart, rowEnd)}\nreturn rowHtml(entry, true, true, true, true);`
        ) as (...args: any[]) => string;
        const rowEntry = {
            fr: false, n: 'main.o', s: '.text', f: 'main', a: 0x08000000,
            ah: '0x08000000', eh: '0x08000003', sz: 4, ss: '4 B', t: 'CODE',
            hx: 'hex:1', ha: true, sx: 'source:1',
        };
        const rowStrings = {
            viewHexTitle: 'View bytes', noFileBytesTitle: 'No bytes', viewHex: 'View bytes',
            noFileBytes: 'No bytes', viewSourceTitle: 'Open source', viewSource: 'Open source',
        };
        const identity = (value: unknown) => String(value ?? '');
        const hostRow = runRowHtml(false, false, identity, identity, rowStrings, rowEntry);
        const standaloneRow = runRowHtml(true, false, identity, identity, rowStrings, rowEntry);
        assert.match(hostRow, /data-action="open-hex"/);
        assert.match(hostRow, /data-action="open-source"/);
        assert.doesNotMatch(standaloneRow, /open-(?:hex|source)/,
            'lazy/virtual 재렌더 후 host 전용 버튼이 다시 생기면 안 된다');

        const copyStart = standalone.indexOf('    // --- Copy / Save ---');
        const copyEnd = standalone.indexOf('    // --- Region fold/unfold', copyStart);
        assert.ok(copyStart >= 0 && copyEnd > copyStart, 'Copy/Save 초기화 블록을 찾지 못했다');
        assert.doesNotThrow(() => {
            const runCopyInit = new Function('document', standalone.slice(copyStart, copyEnd));
            runCopyInit({ getElementById: () => null });
        }, 'host 툴바가 제거된 저장 HTML에서 null 역참조가 나면 안 된다');

        const scriptBlocks = Array.from(
            standalone.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
        ).map(match => match[1]);
        assert.ok(scriptBlocks.length > 0, '저장 HTML에서 스크립트 블록을 찾지 못했다');
        scriptBlocks.forEach((source, index) => {
            assert.doesNotThrow(
                () => new Function(source),
                `저장 HTML의 ${index}번 스크립트 블록에 문법 오류가 있다`
            );
        });

        const failedHtml = webviewHtml.replace(
            /(<div id="refreshStatus"[^>]*>)[^<]*(<\/div>)/,
            '$1stale result$2'
        );
        assert.ok(failedHtml.includes('stale result'), '실패 상태 HTML 픽스처를 만들지 못했다');
        assert.ok(!stripMemoryMapHostBindings(failedHtml).includes('stale result'),
            '실패 뒤 저장한 HTML에 다시 시도할 수 없는 실패 배너가 남으면 안 된다');
    });

    test('같은 render는 실패 상태를 유지하고 pending의 새 render는 성공으로 전환한다', () => {
        const filePath = path.join(tempDir, 'webview-state.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath)));

        type StoredState = {
            [key: string]: unknown;
            memoryMapRenderId?: string;
            refreshPending?: boolean;
            refreshFailed?: boolean;
            refreshAttemptId?: string;
        };
        let storedState: StoredState = {};
        const runStatePrelude = (html: string) => {
            const start = html.indexOf('const RENDER_ID = ');
            const end = html.indexOf('    // 저장 HTML 상한.', start);
            assert.ok(start >= 0 && end > start, 'Refresh state prelude를 찾지 못했다');
            const api = {
                getState: () => storedState,
                setState: (state: StoredState) => { storedState = state; },
            };
            const source = html.slice(start, end)
                + '\nreturn { sameRenderState, refreshStillPending, refreshSucceededOnLoad, pendingViewState, restoredRefreshState, activeRefreshAttemptId };';
            const run = new Function('vscode', source) as (apiArg: {
                getState: () => StoredState;
                setState: (state: StoredState) => void;
            }) => {
                sameRenderState: boolean;
                refreshStillPending: boolean;
                refreshSucceededOnLoad: boolean;
                pendingViewState?: StoredState;
                restoredRefreshState?: { kind: string; reason?: string; at?: number; compact?: boolean };
                activeRefreshAttemptId?: string;
            };
            return run(api);
        };

        const firstHtml = panelRegistry.getHtml(filePath) ?? '';
        const first = runStatePrelude(firstHtml);
        assert.strictEqual(first.sameRenderState, false);
        assert.strictEqual(first.refreshStillPending, false);
        assert.strictEqual(first.refreshSucceededOnLoad, false);
        assert.strictEqual(first.restoredRefreshState, undefined);
        const firstRenderId = storedState.memoryMapRenderId;
        assert.ok(firstRenderId);

        storedState = {
            memoryMapRenderId: firstRenderId,
            refreshFailed: true,
            refreshFailureReason: 'linker parse failed',
            refreshFailedAt: 1234,
            refreshFailureDismissed: true,
        };
        const restored = runStatePrelude(firstHtml);
        assert.strictEqual(restored.sameRenderState, true);
        assert.deepStrictEqual(restored.restoredRefreshState, {
            kind: 'failed',
            reason: 'linker parse failed',
            at: 1234,
            compact: true,
        });

        const viewState = { version: 1, fromRenderId: firstRenderId, scrollY: 400 };
        storedState = {
            ...storedState,
            refreshPending: true,
            refreshAttemptId: 'pending-attempt',
            memoryMapViewState: viewState,
        };
        const pending = runStatePrelude(firstHtml);
        assert.strictEqual(pending.sameRenderState, true);
        assert.strictEqual(pending.refreshStillPending, true);
        assert.strictEqual(pending.restoredRefreshState?.kind, 'busy');
        assert.strictEqual(pending.activeRefreshAttemptId, 'pending-attempt');
        assert.strictEqual(storedState.refreshPending, true,
            '같은 render의 context 재생성이 진행 중 Refresh를 종료하면 안 된다');
        assert.deepStrictEqual(storedState.memoryMapViewState, viewState,
            '새 render가 도착하기 전에 snapshot을 소비하면 안 된다');

        storedState = {
            memoryMapRenderId: firstRenderId,
            refreshPending: true,
            refreshAttemptId: 'wrong-snapshot-attempt',
            memoryMapViewState: { ...viewState, fromRenderId: 'different-render' },
        };
        const mismatchedSnapshot = runStatePrelude(firstHtml);
        assert.strictEqual(mismatchedSnapshot.pendingViewState, undefined,
            'fromRenderId가 다른 snapshot을 같은 render에 붙이면 안 된다');

        storedState = {
            memoryMapRenderId: firstRenderId,
            refreshPending: true,
            refreshAttemptId: 'pending-attempt',
            memoryMapViewState: viewState,
        };

        assert.ok(openMemoryMapFromUri(context, vscode.Uri.file(filePath)));
        const nextHtml = panelRegistry.getHtml(filePath) ?? '';
        const refreshed = runStatePrelude(nextHtml);
        assert.strictEqual(refreshed.sameRenderState, false);
        assert.strictEqual(refreshed.refreshSucceededOnLoad, true);
        assert.deepStrictEqual(refreshed.pendingViewState, viewState);
        assert.strictEqual(refreshed.restoredRefreshState?.kind, 'success');
        assert.notStrictEqual(storedState.memoryMapRenderId, firstRenderId);
        assert.strictEqual(storedState.refreshFailed, false);
        assert.strictEqual(storedState.refreshAttemptId, undefined);
    });

    test('startup 하단이 복원 판정에 맞는 Refresh UI 전이를 실행한다', () => {
        const filePath = path.join(tempDir, 'webview-startup-render.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';
        const start = html.indexOf('    const restoredScrollY = pendingViewState');
        const end = html.indexOf('\n})();', start);
        assert.ok(start >= 0 && end > start, 'startup Refresh 렌더 블록을 찾지 못했다');

        type RestoredRefreshState = {
            kind: 'busy' | 'failed' | 'success';
            reason?: string;
            at?: number;
            compact?: boolean;
        };
        const runStartupRender = (
            pendingViewState: Record<string, unknown> | undefined,
            restoredRefreshState: RestoredRefreshState | undefined,
            deferPaint = false
        ) => {
            const calls = {
                restored: [] as unknown[],
                persisted: [] as unknown[],
                failed: [] as unknown[][],
                succeeded: [] as unknown[][],
                feedback: [] as unknown[][],
                scroll: [] as unknown[],
                focus: [] as unknown[],
                attributes: [] as unknown[],
                posted: [] as unknown[],
            };
            const paintQueue: Array<() => void> = [];
            const source = html.slice(start, end);
            const run = new Function(
                'pendingViewState',
                'restoredRefreshState',
                'restoreMemoryMapViewState',
                'persistWebviewState',
                'afterPaint',
                'renderRefreshFailure',
                'renderRefreshSuccess',
                'setRefreshFeedback',
                'window',
                'document',
                'S',
                'refreshInFlight',
                'refreshLifecycleGeneration',
                'vscode',
                'RENDER_ID',
                `${source}\nreturn {`
                    + ' setRefreshInFlight: function(value) { refreshInFlight = value; },'
                    + ' receiveDurableFailure: function() { refreshLifecycleGeneration++; refreshInFlight = false; },'
                    + ' beginNewRefresh: function() { refreshLifecycleGeneration++; refreshInFlight = true; }'
                    + ' };'
            ) as (...args: any[]) => {
                setRefreshInFlight(value: boolean): void;
                receiveDurableFailure(): void;
                beginNewRefresh(): void;
            };
            const controller = run(
                pendingViewState,
                restoredRefreshState,
                (state: Record<string, unknown>, consumeSnapshot: boolean) => {
                    calls.restored.push([state, consumeSnapshot]);
                    return Number(state.scrollY);
                },
                (patch: Record<string, unknown>) => calls.persisted.push(patch),
                (callback: () => void) => {
                    if (deferPaint) { paintQueue.push(callback); } else { callback(); }
                },
                (...args: unknown[]) => calls.failed.push(args),
                (...args: unknown[]) => calls.succeeded.push(args),
                (...args: unknown[]) => calls.feedback.push(args),
                { scrollTo: (options: unknown) => calls.scroll.push(options) },
                {
                    getElementById: (id: string) => id === 'btnRefresh'
                        ? {
                            focus: (options: unknown) => calls.focus.push(options),
                            setAttribute: (name: string, value: string) => calls.attributes.push([id, name, value]),
                        }
                        : id === 'refreshStatus'
                            ? { setAttribute: (name: string, value: string) => calls.attributes.push([id, name, value]) }
                            : undefined,
                },
                { refreshing: 'refreshing' },
                false,
                0,
                { postMessage: (message: unknown) => calls.posted.push(message) },
                'current-render'
            );
            return Object.assign(calls, {
                setRefreshInFlight: controller.setRefreshInFlight,
                receiveDurableFailure: controller.receiveDurableFailure,
                beginNewRefresh: controller.beginNewRefresh,
                flushNextPaint: () => paintQueue.shift()?.(),
                flushPaint: () => {
                    while (paintQueue.length > 0) {
                        paintQueue.shift()!();
                    }
                },
            });
        };

        const idle = runStartupRender(undefined, undefined);
        assert.deepStrictEqual(idle.feedback, [['', '', false, undefined]]);
        assert.deepStrictEqual(idle.persisted, [{ memoryMapViewState: undefined }]);
        assert.deepStrictEqual(idle.failed, []);
        assert.deepStrictEqual(idle.succeeded, []);
        assert.deepStrictEqual(idle.posted, [{ command: 'memoryMapReady', renderId: 'current-render' }]);

        const failed = runStartupRender(undefined, {
            kind: 'failed', reason: 'linker parse failed', at: 1234, compact: true,
        });
        assert.deepStrictEqual(failed.failed, [['linker parse failed', 1234, false, true]]);
        assert.deepStrictEqual(failed.feedback, [], '실패 복원은 idle 상태로 다시 지우면 안 된다');
        assert.deepStrictEqual(failed.succeeded, []);
        assert.deepStrictEqual(failed.posted, [{ command: 'memoryMapReady', renderId: 'current-render' }]);

        const viewState = {
            version: 1,
            fromRenderId: 'old-render',
            scrollY: 400,
            refreshFeedbackHeight: 20,
            refreshFeedbackTop: 80,
            totals: { flash: 100, ram: 200 },
        };
        const failedWithView = runStartupRender(viewState, {
            kind: 'failed', reason: 'linker parse failed', at: 1234, compact: false,
        });
        assert.deepStrictEqual(failedWithView.restored, [[viewState, false]],
            '같은 render의 실패 snapshot은 context가 다시 생겨도 소비하면 안 된다');
        assert.deepStrictEqual(failedWithView.failed, [['linker parse failed', 1234, false, false]]);

        const failedWithViewAgain = runStartupRender(viewState, {
            kind: 'failed', reason: 'linker parse failed', at: 1234, compact: false,
        });
        assert.deepStrictEqual(failedWithViewAgain.restored, [[viewState, false]],
            '같은 실패 snapshot으로 context가 두 번째 재생성돼도 다시 복원해야 한다');

        const succeeded = runStartupRender(viewState, { kind: 'success', at: 5678 });
        assert.deepStrictEqual(succeeded.restored, [[viewState, true]]);
        assert.deepStrictEqual(succeeded.succeeded, [[5678, false, viewState.totals]]);
        assert.deepStrictEqual(succeeded.feedback, []);
        assert.deepStrictEqual(succeeded.scroll, [{ top: 380, behavior: 'auto' }]);
        assert.deepStrictEqual(succeeded.focus, [{ preventScroll: true }]);
        assert.deepStrictEqual(succeeded.posted, [{ command: 'memoryMapReady', renderId: 'current-render' }]);

        const busy = runStartupRender(viewState, { kind: 'busy' });
        assert.deepStrictEqual(busy.restored, [[viewState, false]],
            '진행 중 context 재생성은 snapshot을 복원하되 소비하지 않아야 한다');
        assert.deepStrictEqual(busy.feedback, [['busy', 'refreshing', false, undefined]]);
        assert.deepStrictEqual(busy.attributes, [
            ['btnRefresh', 'aria-disabled', 'true'],
        ]);
        assert.deepStrictEqual(busy.failed, []);
        assert.deepStrictEqual(busy.succeeded, []);
        assert.deepStrictEqual(busy.posted, [{ command: 'memoryMapReady', renderId: 'current-render' }]);

        const raced = runStartupRender(viewState, { kind: 'busy' }, true);
        assert.deepStrictEqual(raced.posted, [{ command: 'memoryMapReady', renderId: 'current-render' }]);
        // ready 응답으로 durable failure가 먼저 렌더된 상황을 재현한다.
        raced.receiveDurableFailure();
        raced.flushPaint();
        assert.deepStrictEqual(raced.feedback, [],
            'ready 응답의 실패 뒤 예약된 startup busy가 다시 덮으면 안 된다');
        assert.deepStrictEqual(raced.scroll, [{ top: 380, behavior: 'auto' }],
            'busy 전이를 건너뛰어도 viewport 복원은 실행해야 한다');

        const failedBetweenPaints = runStartupRender(viewState, { kind: 'busy' }, true);
        failedBetweenPaints.flushNextPaint();
        failedBetweenPaints.receiveDurableFailure();
        failedBetweenPaints.flushPaint();
        assert.deepStrictEqual(failedBetweenPaints.scroll, [{ top: 380, behavior: 'auto' }],
            'startup busy와 viewport paint 사이에 실패가 와도 저장된 위치를 복원해야 한다');

        const retriedBeforeViewport = runStartupRender(viewState, { kind: 'busy' }, true);
        retriedBeforeViewport.receiveDurableFailure();
        retriedBeforeViewport.flushNextPaint();
        retriedBeforeViewport.beginNewRefresh();
        retriedBeforeViewport.flushPaint();
        assert.deepStrictEqual(retriedBeforeViewport.scroll, [],
            'durable failure 뒤 시작한 새 Refresh를 이전 startup viewport가 덮으면 안 된다');

        const retriedBeforeStartup = runStartupRender(viewState, { kind: 'busy' }, true);
        retriedBeforeStartup.receiveDurableFailure();
        retriedBeforeStartup.beginNewRefresh();
        retriedBeforeStartup.flushPaint();
        assert.deepStrictEqual(retriedBeforeStartup.feedback, [],
            '새 attempt의 busy를 startup의 이전 pending으로 오인하면 안 된다');
        assert.deepStrictEqual(retriedBeforeStartup.scroll, [],
            'startup callback 전에 재시도한 경우에도 이전 viewport를 적용하면 안 된다');

        const delayedFailure = runStartupRender(undefined, {
            kind: 'failed', reason: 'old failure', at: 1234, compact: false,
        }, true);
        delayedFailure.beginNewRefresh();
        delayedFailure.flushPaint();
        assert.deepStrictEqual(delayedFailure.failed, [],
            '새 Refresh 뒤 startup의 이전 실패를 다시 표시하면 안 된다');

        const delayedSuccess = runStartupRender(viewState, { kind: 'success', at: 5678 }, true);
        delayedSuccess.beginNewRefresh();
        delayedSuccess.flushPaint();
        assert.deepStrictEqual(delayedSuccess.succeeded, [],
            '새 Refresh 뒤 startup의 이전 성공을 다시 표시하면 안 된다');
        assert.deepStrictEqual(delayedSuccess.scroll, [],
            '이전 startup 상태가 새 Refresh 중 viewport를 되돌리면 안 된다');
        assert.deepStrictEqual(delayedSuccess.focus, [],
            '이전 startup 상태가 새 Refresh 중 포커스를 가져가면 안 된다');
    });

    test('Refresh live region 순서·로케일·실패 disclosure를 실제 함수로 검증한다', () => {
        const filePath = path.join(tempDir, 'webview-refresh-feedback.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';

        const timeStart = html.indexOf('    function refreshTime(');
        const timeEnd = html.indexOf('    function refreshSize(', timeStart);
        assert.ok(timeStart >= 0 && timeEnd > timeStart, 'refreshTime을 찾지 못했다');
        const locales: unknown[] = [];
        const fakeIntl = {
            DateTimeFormat: class {
                constructor(locale: unknown) { locales.push(locale); }
                format() { return 'localized-time'; }
            },
        };
        const runTime = new Function(
            'Intl', 'document',
            `${html.slice(timeStart, timeEnd)}\nreturn refreshTime(1234);`
        ) as (...args: any[]) => string;
        assert.strictEqual(runTime(fakeIntl, { documentElement: { lang: 'ko' } }), 'localized-time');
        assert.deepStrictEqual(locales, ['ko'], 'OS locale 대신 webview lang을 사용해야 한다');

        const feedbackStart = html.indexOf('    function scheduleUiTimeout(');
        const feedbackEnd = html.indexOf('    function renderRefreshSuccess(', feedbackStart);
        assert.ok(feedbackStart >= 0 && feedbackEnd > feedbackStart, 'Refresh feedback 함수를 찾지 못했다');
        const events: string[] = [];
        const queued: Array<() => void> = [];
        const timers: Array<{ callback: () => void; delay: number }> = [];
        const persisted: Record<string, unknown>[] = [];
        let statusText = '';
        const status = {
            className: '',
            title: '',
            get textContent() { return statusText; },
            set textContent(value: string) { statusText = value; events.push(`text:${value}`); },
            setAttribute(name: string, value: string) { events.push(`${name}:${value}`); },
            classList: {
                contains(name: string) { return status.className.split(/\s+/).includes(name); },
                add(name: string) {
                    if (!status.classList.contains(name)) { status.className += ` ${name}`; }
                },
            },
        };
        const refreshButton = {
            setAttribute(name: string, value: string) { events.push(`button:${name}:${value}`); },
            focus() { events.push('refresh-focus'); },
        };
        const dismissAttributes = new Map<string, string>();
        const dismiss = {
            hidden: true,
            textContent: '',
            setAttribute(name: string, value: string) { dismissAttributes.set(name, value); },
        };
        const runFeedback = new Function(
            'window', 'document', 'afterPaint', 'S', 'refreshTime', 'fmt', 'persistWebviewState',
            `let refreshInFlight = false, refreshFeedbackGeneration = 0;\n${html.slice(feedbackStart, feedbackEnd)}\n`
                + 'return { setRefreshFeedback, renderRefreshFailure, scheduleSuccessCompaction };'
        ) as (...args: any[]) => {
            setRefreshFeedback: (kind: string, message: string, focus: boolean, expanded?: boolean) => void;
            renderRefreshFailure: (reason: string, at: number, focus: boolean, compact: boolean) => void;
            scheduleSuccessCompaction: () => void;
        };
        const feedback = runFeedback(
            { setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }) },
            { getElementById: (id: string) => id === 'btnRefresh' ? refreshButton : id === 'refreshStatus' ? status : dismiss },
            (callback: () => void) => queued.push(callback),
            {
                refreshInterrupted: 'interrupted',
                dismissRefreshDetails: 'dismiss details',
                showRefreshDetails: 'show details',
                refreshStaleCompact: '{time} compact',
                refreshFailedAt: '{time} failed: {reason}',
                refreshTakingLong: 'taking longer',
            },
            () => 'LOCAL-TIME',
            (template: string, values: Record<string, unknown>) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key])),
            (state: Record<string, unknown>) => persisted.push(state)
        );

        feedback.setRefreshFeedback('busy', 'refreshing', false, undefined);
        const textIndex = events.indexOf('text:refreshing');
        const busyFalseIndex = events.indexOf('aria-busy:false');
        assert.ok(textIndex >= 0 && busyFalseIndex > textIndex,
            `busy 문구가 aria-busy보다 먼저 기록되어야 한다: ${events.join(', ')}`);
        assert.ok(!events.includes('aria-busy:true'), '같은 접근성 frame에서 busy=true를 먼저 걸면 안 된다');
        queued.splice(0).forEach(callback => callback());
        assert.ok(events.includes('aria-busy:true'), '문구를 알린 다음 frame에는 busy 상태를 표시해야 한다');
        assert.strictEqual(timers[0]?.delay, 12000);
        timers.shift()!.callback();
        assert.strictEqual(statusText, 'taking longer', '오래 걸리는 분석은 중복 실행 대신 진행 안내를 바꿔야 한다');
        queued.splice(0).forEach(callback => callback());

        feedback.setRefreshFeedback('busy', 'refreshing-again', false, undefined);
        const staleLongRunningTimer = timers.at(-1)!;
        feedback.setRefreshFeedback('success', 'done', false, undefined);
        staleLongRunningTimer.callback();
        assert.strictEqual(statusText, 'done', '완료 뒤 stale 장기 실행 timer가 busy 문구를 되살리면 안 된다');
        queued.splice(0).forEach(callback => callback());
        assert.strictEqual(events.at(-1), 'aria-busy:false',
            '완료 뒤 stale callback이 aria-busy=true를 되살리면 안 된다');

        const trueCountBeforeSameMessageRace = events.filter(event => event === 'aria-busy:true').length;
        feedback.setRefreshFeedback('busy', 'same-message', false, undefined);
        const staleBusy = queued.shift();
        feedback.setRefreshFeedback('success', 'done-again', false, undefined);
        feedback.setRefreshFeedback('busy', 'same-message', false, undefined);
        const currentBusy = queued.shift();
        assert.ok(staleBusy && currentBusy);
        staleBusy();
        assert.strictEqual(
            events.filter(event => event === 'aria-busy:true').length,
            trueCountBeforeSameMessageRace,
            '같은 문구의 이전 busy callback도 generation으로 무효화해야 한다'
        );
        currentBusy();
        assert.strictEqual(
            events.filter(event => event === 'aria-busy:true').length,
            trueCountBeforeSameMessageRace + 1,
            '현재 generation의 busy callback은 적용해야 한다'
        );

        feedback.setRefreshFeedback('success', 'compact me', false, undefined);
        feedback.scheduleSuccessCompaction();
        const compactTimer = timers.find(timer => timer.delay === 8000);
        assert.ok(compactTimer, '성공 배너 축소 timer가 없다');
        compactTimer!.callback();
        assert.ok(status.classList.contains('is-compact'), '성공 피드백은 시각을 남기고 축소해야 한다');

        feedback.renderRefreshFailure('linker missing', 1234, false, true);
        assert.strictEqual(dismiss.hidden, false, 'compact 상태에서도 disclosure를 없애면 안 된다');
        assert.strictEqual(dismissAttributes.get('aria-expanded'), 'false');
        assert.strictEqual(dismissAttributes.get('aria-label'), 'show details');
        assert.strictEqual(statusText, 'LOCAL-TIME compact');
        assert.strictEqual(status.title, 'LOCAL-TIME failed: linker missing.',
            '접힌 상태 title에는 종결 부호를 보정한 실패 이유가 남아야 한다');

        feedback.renderRefreshFailure('linker missing', 1234, false, false);
        assert.strictEqual(dismissAttributes.get('aria-expanded'), 'true');
        assert.strictEqual(dismissAttributes.get('aria-label'), 'dismiss details');
        assert.strictEqual(statusText, 'LOCAL-TIME failed: linker missing.');
        assert.strictEqual(status.title, '');
        assert.ok(persisted.some(state => state.refreshFailureDismissed === true));
        assert.ok(persisted.some(state => state.refreshFailureDismissed === false));
        assert.ok(persisted.some(state => state.refreshFailureReason === 'linker missing.'),
            '복원할 reason도 같은 종결 부호를 보존해야 한다');

        feedback.renderRefreshFailure('already complete!', 1234, false, false);
        assert.strictEqual(statusText, 'LOCAL-TIME failed: already complete!',
            '이미 있는 종결 부호를 중복하면 안 된다');

        const actionStart = html.indexOf('    function runAction(actionEl)');
        const actionEnd = html.indexOf('    // 분석이 오래 걸리는 동안에도', actionStart);
        assert.ok(actionStart >= 0 && actionEnd > actionStart, 'dismiss action을 찾지 못했다');
        let focused = false;
        let compactArg: boolean | undefined;
        const action = {
            getAttribute: (name: string) => name === 'data-action' ? 'dismiss-refresh' : 'true',
            focus: () => { focused = true; },
        };
        const runAction = new Function(
            'window', 'vscode', 'RENDER_ID', 'readWebviewState', 'renderRefreshFailure', 'afterPaint',
            `${html.slice(actionStart, actionEnd)}\nreturn runAction;`
        ) as (...args: any[]) => (actionEl: any) => void;
        runAction(
            {}, { postMessage() { /* no-op */ } }, 'render',
            () => ({ refreshFailureReason: 'reason', refreshFailedAt: 1 }),
            (_reason: string, _at: number, _focus: boolean, compact: boolean) => { compactArg = compact; },
            (callback: () => void) => callback()
        )(action);
        assert.strictEqual(compactArg, true);
        assert.strictEqual(focused, true, '접은 뒤 같은 disclosure 버튼으로 포커스를 복원해야 한다');
    });

    test('같은 render의 이전 Refresh 실패 메시지가 최신 busy를 취소하지 않는다', () => {
        const filePath = path.join(tempDir, 'webview-refresh-attempt-race.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';
        const listenerStart = html.indexOf("    window.addEventListener('message', function(event) {");
        const listenerEnd = html.indexOf('    // --- Column sort', listenerStart);
        assert.ok(listenerStart >= 0 && listenerEnd > listenerStart,
            'Refresh 실패 message listener를 찾지 못했다');

        let messageHandler: ((event: { data: Record<string, unknown> }) => void) | undefined;
        const rendered: unknown[][] = [];
        const configured: unknown[][] = [];
        const posted: unknown[] = [];
        const runListener = new Function(
            'window', 'vscode', 'RENDER_ID', 'renderRefreshFailure', 'beginRefresh',
            'revealEntry', 'document', 'scrollToRegionCard', 'renderMemoryMapConfigurationFeedback',
            `let activeRefreshAttemptId = 'attempt-2';\n`
                + 'let refreshInFlight = false;\n'
                + 'let refreshLifecycleGeneration = 0;\n'
                + html.slice(listenerStart, listenerEnd)
                + '\nreturn {'
                + ' active: function() { return activeRefreshAttemptId; },'
                + ' generation: function() { return refreshLifecycleGeneration; },'
                + ' setInFlight: function(value) { refreshInFlight = value; }'
                + ' };'
        ) as (...args: any[]) => {
            active(): string | undefined;
            generation(): number;
            setInFlight(value: boolean): void;
        };
        const controller = runListener(
            {
                addEventListener: (_type: string, handler: typeof messageHandler) => {
                    messageHandler = handler;
                },
            },
            { postMessage: (message: unknown) => posted.push(message) },
            'current-render',
            (...args: unknown[]) => rendered.push(args),
            () => { throw new Error('requestRefresh branch should not run'); },
            () => { throw new Error('revealEntry branch should not run'); },
            { querySelectorAll: () => [] },
            () => { throw new Error('scrollToRegion branch should not run'); },
            (...args: unknown[]) => configured.push(args)
        );
        assert.ok(messageHandler, 'message listener가 등록되지 않았다');

        messageHandler!({ data: {
            command: 'refreshFailed',
            renderId: 'current-render',
            refreshAttemptId: 'attempt-1',
            reason: 'old failure',
            failedAt: 1,
        } });
        assert.deepStrictEqual(rendered, [], '이전 attempt 실패를 렌더하면 안 된다');
        assert.deepStrictEqual(posted, [], '이전 attempt 실패를 ack하면 안 된다');
        assert.strictEqual(controller.active(), 'attempt-2');
        assert.strictEqual(controller.generation(), 0);

        messageHandler!({ data: {
            command: 'refreshFailed',
            renderId: 'current-render',
            refreshAttemptId: 'attempt-2',
            reason: 'current failure',
            failedAt: 2,
        } });
        assert.deepStrictEqual(rendered, [['current failure', 2, true, false]]);
        assert.deepStrictEqual(posted, [{
            command: 'refreshFailureAcknowledged',
            renderId: 'current-render',
            refreshAttemptId: 'attempt-2',
        }]);
        assert.strictEqual(controller.active(), undefined);
        assert.strictEqual(controller.generation(), 1);

        posted.length = 0;
        const configureMessage = {
            command: 'memoryMapPanelFeedback',
            renderId: 'current-render',
            feedbackId: 'configure-feedback-1',
            kind: 'configure-success',
            linkerName: 'memory.ld',
            at: 3,
        };
        messageHandler!({ data: configureMessage });
        assert.deepStrictEqual(configured, [[configureMessage]]);
        assert.deepStrictEqual(posted, [{
            command: 'memoryMapPanelFeedbackAcknowledged',
            renderId: 'current-render',
            feedbackId: 'configure-feedback-1',
        }]);
        assert.strictEqual(controller.generation(), 2);

        controller.setInFlight(true);
        posted.length = 0;
        messageHandler!({ data: {
            ...configureMessage,
            feedbackId: 'stale-configure-feedback',
        } });
        assert.strictEqual(configured.length, 1, '지연된 linker 결과가 최신 Refresh busy를 덮으면 안 된다');
        assert.deepStrictEqual(posted, [{
            command: 'memoryMapPanelFeedbackAcknowledged',
            renderId: 'current-render',
            feedbackId: 'stale-configure-feedback',
        }]);
        assert.strictEqual(controller.generation(), 2);
    });

    test('실제 beginRefresh가 generation과 동일한 attempt ID를 저장·전송한다', () => {
        const filePath = path.join(tempDir, 'webview-begin-refresh.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';
        const beginStart = html.indexOf('    function beginRefresh()');
        const beginEnd = html.indexOf('    function schedulePendingSnapshotRefresh()', beginStart);
        assert.ok(beginStart >= 0 && beginEnd > beginStart, 'beginRefresh 함수를 찾지 못했다');

        const persisted: Record<string, any>[] = [];
        const feedback: unknown[][] = [];
        const posted: Record<string, any>[] = [];
        let refreshButtonAriaDisabled = 'false';
        const runBeginRefresh = new Function(
            'document', 'Date', 'persistWebviewState', 'S', 'captureMemoryMapViewState',
            'setRefreshFeedback', 'vscode', 'RENDER_ID',
            'let refreshInFlight = false;\n'
                + 'let refreshLifecycleGeneration = 0;\n'
                + 'let activeRefreshAttemptId;\n'
                + 'let refreshAttemptSequence = 0;\n'
                + html.slice(beginStart, beginEnd)
                + '\nreturn {'
                + ' beginRefresh: beginRefresh,'
                + ' generation: function() { return refreshLifecycleGeneration; },'
                + ' active: function() { return activeRefreshAttemptId; },'
                + ' sequence: function() { return refreshAttemptSequence; },'
                + ' setInFlight: function(value) { refreshInFlight = value; }'
                + ' };'
        ) as (...args: any[]) => {
            beginRefresh(): void;
            generation(): number;
            active(): string | undefined;
            sequence(): number;
            setInFlight(value: boolean): void;
        };
        const controller = runBeginRefresh(
            {
                getElementById: (id: string) => id === 'btnRefresh'
                    ? { getAttribute: () => refreshButtonAriaDisabled }
                    : id === 'refreshStatus' ? {} : undefined,
            },
            { now: () => 1234 },
            (patch: Record<string, any>) => persisted.push(patch),
            { refreshInterrupted: 'interrupted', refreshing: 'refreshing' },
            () => ({ searchQuery: 'main', scrollY: 400 }),
            (...args: unknown[]) => feedback.push(args),
            { postMessage: (message: Record<string, any>) => posted.push(message) },
            'current-render'
        );

        controller.setInFlight(true);
        controller.beginRefresh();
        assert.strictEqual(controller.generation(), 0,
            '진행 중 재진입이 lifecycle generation을 바꾸면 안 된다');
        assert.strictEqual(controller.sequence(), 0,
            '진행 중 재진입이 attempt sequence를 소비하면 안 된다');
        assert.strictEqual(controller.active(), undefined);
        assert.strictEqual(persisted.length, 0);
        assert.strictEqual(posted.length, 0);
        assert.strictEqual(feedback.length, 0);

        controller.setInFlight(false);
        refreshButtonAriaDisabled = 'true';
        controller.beginRefresh();
        assert.strictEqual(controller.generation(), 0,
            'aria-disabled 재진입이 lifecycle generation을 바꾸면 안 된다');
        assert.strictEqual(controller.sequence(), 0,
            'aria-disabled 재진입이 attempt sequence를 소비하면 안 된다');
        assert.strictEqual(controller.active(), undefined);
        assert.strictEqual(persisted.length, 0);
        assert.strictEqual(posted.length, 0);
        assert.strictEqual(feedback.length, 0);

        refreshButtonAriaDisabled = 'false';
        controller.beginRefresh();
        assert.strictEqual(controller.generation(), 1,
            '실제 beginRefresh가 lifecycle generation을 올려야 한다');
        assert.strictEqual(controller.sequence(), 1);
        assert.strictEqual(controller.active(), 'current-render:ya:1');
        assert.strictEqual(persisted.length, 1);
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(persisted[0].refreshAttemptId, controller.active());
        assert.strictEqual(posted[0].refreshAttemptId, controller.active(),
            '저장한 attempt와 host에 보낸 attempt가 다르면 안 된다');
        assert.deepStrictEqual(persisted[0].memoryMapViewState, {
            version: 1,
            fromRenderId: 'current-render',
            searchQuery: 'main',
            scrollY: 400,
        });
        assert.deepStrictEqual(posted[0], {
            command: 'refresh',
            renderId: 'current-render',
            refreshAttemptId: 'current-render:ya:1',
        });
        assert.deepStrictEqual(feedback, [['busy', 'refreshing', false, undefined]]);
    });

    test('Refresh 실패 뒤 사용자 조작도 같은 render의 복원 snapshot에 반영한다', () => {
        const filePath = path.join(tempDir, 'webview-failed-snapshot.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';
        const scheduleStart = html.indexOf('    function schedulePendingSnapshotRefresh()');
        const scheduleEnd = html.indexOf('    // --- Delegated click handlers', scheduleStart);
        assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart,
            'snapshot 갱신 함수를 찾지 못했다');

        let storedRefreshState: Record<string, unknown> = { refreshFailed: true };
        const queued: Array<() => void> = [];
        const persisted: Record<string, any>[] = [];
        const runScheduler = new Function(
            'readWebviewState', 'persistWebviewState', 'captureMemoryMapViewState',
            'requestAnimationFrame', 'setTimeout', 'RENDER_ID',
            'let refreshInFlight = false;\n'
                + 'let pendingSnapshotScheduled = false;\n'
                + html.slice(scheduleStart, scheduleEnd)
                + '\nreturn {'
                + ' schedule: schedulePendingSnapshotRefresh,'
                + ' setRefreshInFlight: function(value) { refreshInFlight = value; }'
                + ' };'
        ) as (...args: any[]) => {
            schedule(): void;
            setRefreshInFlight(value: boolean): void;
        };
        const controller = runScheduler(
            () => storedRefreshState,
            (patch: Record<string, any>) => {
                persisted.push(patch);
                storedRefreshState = { ...storedRefreshState, ...patch };
            },
            () => ({ searchQuery: 'after-failure', scrollY: 520 }),
            (callback: () => void) => queued.push(callback),
            (callback: () => void) => queued.push(callback),
            'current-render'
        );

        controller.schedule();
        assert.strictEqual(queued.length, 1,
            '실패 상태에서도 다음 frame에 최신 뷰를 저장해야 한다');
        queued.shift()!();
        assert.deepStrictEqual(persisted, [{
            memoryMapViewState: {
                version: 1,
                fromRenderId: 'current-render',
                searchQuery: 'after-failure',
                scrollY: 520,
            },
        }]);

        storedRefreshState = { refreshFailed: false };
        controller.schedule();
        assert.strictEqual(queued.length, 0,
            '평상시 조작까지 불필요하게 snapshot으로 계속 저장하면 안 된다');

        controller.setRefreshInFlight(true);
        controller.schedule();
        assert.strictEqual(queued.length, 1,
            '진행 중 조작을 저장하던 기존 경로도 유지해야 한다');
    });

    test('Refresh snapshot 함수가 검색·접기·정렬·스크롤 문맥을 실제로 저장·복원한다', () => {
        const filePath = path.join(tempDir, 'webview-view-state.axf');
        fs.writeFileSync(filePath, buildMinimalElf32());
        assert.ok(openMemoryMapFromUri(
            { subscriptions: [] } as unknown as vscode.ExtensionContext,
            vscode.Uri.file(filePath)
        ));
        const html = panelRegistry.getHtml(filePath) ?? '';
        const captureStart = html.indexOf('function captureMemoryMapViewState()');
        const restoreStart = html.indexOf('function restoreMemoryMapViewState(viewState, consumeSnapshot)');
        const refreshStart = html.indexOf('function beginRefresh()');
        assert.ok(captureStart >= 0 && restoreStart > captureStart && refreshStart > restoreStart);
        const capture = html.slice(captureStart, restoreStart);
        const restore = html.slice(restoreStart, refreshStart);

        for (const field of [
            'scrollY', 'refreshFeedbackHeight', 'refreshFeedbackTop', 'totals', 'searchQuery', 'currentMatchKey',
            'funcVis', 'expandedRegions', 'objectSummaries', 'objectDetailRows', 'virtualScroll', 'sorts',
        ]) {
            assert.ok(capture.includes(field), `Refresh snapshot에 ${field}가 없다`);
        }
        assert.ok(restore.includes('doSearch()'), '검색어를 다시 적용하지 않는다');
        assert.ok(restore.includes('sorts.forEach(applyCapturedSort)'), '정렬 상태를 다시 적용하지 않는다');
        assert.ok(restore.includes('setRegionExpanded'), '영역 접기 상태를 다시 적용하지 않는다');
        assert.ok(restore.includes('setObjSummaryExpanded'), 'Object Summary 접기 상태를 다시 적용하지 않는다');
        assert.ok(restore.includes('sameSearchMatch'), '현재 검색 위치를 stable key로 복원하지 않는다');
        assert.ok(restore.includes('viewState.currentMatch'), '변경된 결과에서 검색 순번 fallback이 없다');
        assert.ok(restore.indexOf('doSearch()') < restore.indexOf('sorts.forEach(applyCapturedSort)'),
            '검색이 표를 다시 그린 뒤 정렬을 복원해야 한다');
        assert.ok(html.includes('refreshSuccessMessage'), '성공 시각과 사용량 변화를 만드는 경로가 없다');
        assert.ok(html.includes('S.refreshUsageUnchanged'), '사용량이 같은 성공도 명시적으로 확인하지 않는다');

        const allHeader = {
            dataset: { sort: 'size' },
            sort: 'ascending',
            clicks: 0,
            getAttribute(name: string) { return name === 'aria-sort' ? this.sort : null; },
            click() {
                this.clicks++;
                this.sort = this.sort === 'descending' ? 'ascending' : 'descending';
            },
        };
        const sectionHeader = {
            dataset: { sort: 'addr' },
            sort: 'descending',
            getAttribute(name: string) { return name === 'aria-sort' ? this.sort : null; },
            click() { this.sort = this.sort === 'descending' ? 'ascending' : 'descending'; },
        };
        const table = (header: typeof allHeader | typeof sectionHeader | undefined) => ({
            querySelector: () => header,
            querySelectorAll: () => header ? [header] : [],
        });
        const allTable = table(allHeader);
        const sectionTable = table(sectionHeader);
        const detail = { style: { display: '' } };
        const objHeader = {
            expanded: 'true',
            getAttribute(name: string) { return name === 'aria-expanded' ? this.expanded : null; },
        };
        const objRows = {
            pressed: 'true',
            textContent: '',
            getAttribute(name: string) { return name === 'aria-pressed' ? this.pressed : null; },
            setAttribute(name: string, value: string) { if (name === 'aria-pressed') { this.pressed = value; } },
        };
        const viewport = { scrollTop: 42 };
        const card = {
            dataset: { idx: '0' },
            querySelector(selector: string) {
                if (selector === '.region-detail') { return detail; }
                if (selector === '.obj-summary-header') { return objHeader; }
                if (selector === '[data-action="toggle-obj-detail-rows"]') { return objRows; }
                if (selector === '.section-table') { return sectionTable; }
                if (selector === '.obj-summary-table') { return undefined; }
                if (selector === '.vt-viewport') { return viewport; }
                return undefined;
            },
        };
        const feedback = { getBoundingClientRect: () => ({ height: 20, top: 80 }) };
        const overviewRow = {
            getAttribute: (name: string) => name === 'data-region' ? 'FLASH' : null,
        };
        const documentMock = {
            getElementById: (id: string) => id === 'refreshFeedback' ? feedback : id === 'sectionTable' ? allTable : undefined,
            querySelectorAll: (selector: string) => selector === '.region-card' ? [card] : [],
            querySelector: (selector: string) => selector.includes('.region-card') ? card : undefined,
        };
        const captureBundle = new Function(
            'document', 'RD', 'window', 'CURRENT_TOTALS', 'searchInput', 'curMatch', 'matchList',
            'funcVis', 'searchAutoFunc', 'funcUserOverride', 'vtMap',
            `${html.slice(html.indexOf('    function capturedSort('), restoreStart)}\n`
                + 'return { captureMemoryMapViewState, applyCapturedSort, sameSearchMatch };'
        ) as (...args: any[]) => {
            captureMemoryMapViewState: () => Record<string, any>;
            applyCapturedSort: (state: Record<string, unknown>) => void;
            sameSearchMatch: (match: unknown, key: unknown) => boolean;
        };
        const captureRuntime = captureBundle(
            documentMock,
            [{ name: 'FLASH' }],
            { scrollY: 345 },
            { flash: 100, ram: 200 },
            { value: 'HAL_' },
            0,
            [{ k: 'el', el: overviewRow }],
            true,
            false,
            true,
            new Map()
        );
        const captured = captureRuntime.captureMemoryMapViewState();
        assert.strictEqual(captured.scrollY, 345);
        assert.strictEqual(captured.searchQuery, 'HAL_');
        assert.strictEqual(captured.currentMatch, 0);
        assert.deepStrictEqual(captured.currentMatchKey, { kind: 'overview', region: 'FLASH' });
        assert.strictEqual(captured.funcVis, true);
        assert.deepStrictEqual(captured.expandedRegions, [{ index: 0, name: 'FLASH' }]);
        assert.deepStrictEqual(captured.objectSummaries, [{ index: 0, name: 'FLASH' }]);
        assert.deepStrictEqual(captured.objectDetailRows, [{ index: 0, name: 'FLASH' }]);
        assert.deepStrictEqual(captured.virtualScroll, [{ regionIndex: 0, regionName: 'FLASH', top: 42 }]);
        assert.deepStrictEqual(captured.sorts.map((state: any) => [state.kind, state.column, state.ascending]), [
            ['all', 'size', true],
            ['section', 'addr', false],
        ]);
        const regionAttributes: Record<string, string> = {
            'data-sort-name': 'HAL_Init',
            'data-sort-addr': String(0x08000100),
            'data-sort-section': '.text',
            'data-sort-func': 'HAL_Init',
            'data-sort-type': 'CODE',
            'data-sort-bytes': '32',
        };
        const regionRow = {
            getAttribute: (name: string) => regionAttributes[name] ?? null,
            closest: () => card,
        };
        const regionKey = {
            kind: 'region', regionIndex: 0, regionName: 'FLASH', name: 'HAL_Init',
            addr: 0x08000100, section: '.text', func: 'HAL_Init', type: 'CODE', size: 32,
        };
        assert.strictEqual(captureRuntime.sameSearchMatch({ k: 'el', el: regionRow }, regionKey), true);
        assert.strictEqual(captureRuntime.sameSearchMatch(
            { k: 'el', el: regionRow },
            { ...regionKey, addr: regionKey.addr + 4 }
        ), false, '주소가 바뀐 다른 region 행을 현재 검색 위치로 오인하면 안 된다');

        allHeader.sort = 'none';
        allHeader.clicks = 0;
        captureRuntime.applyCapturedSort(captured.sorts[0]);
        assert.strictEqual(allHeader.sort, 'ascending', '저장한 오름차순을 실제 header에 복원해야 한다');
        assert.strictEqual(allHeader.clicks, 2,
            'Size 열의 기본 내림차순을 거쳐 오름차순까지 한 번 더 전환해야 한다');

        const restoreCalls = {
            syncFunc: 0,
            search: 0,
            rendered: [] as number[],
            regionExpanded: [] as boolean[],
            objectExpanded: [] as boolean[],
            objectSynced: 0,
            virtualRendered: 0,
            revealed: [] as number[],
            persisted: [] as Record<string, unknown>[],
        };
        const rendered = new Set<number>();
        const vt = { vp: { scrollTop: 0 }, ls: 0 };
        const restoreSearchInput = { value: '' };
        objRows.pressed = 'false';
        allHeader.sort = 'none';
        allHeader.clicks = 0;
        sectionHeader.sort = 'none';
        const restoreBundle = new Function(
            'document', 'RD', 'searchInput', 'syncFuncBtn', 'doSearch', 'renderDetail', 'applyCapturedSort',
            'rendered', 'setRegionExpanded', 'setObjSummaryExpanded', 'S', 'syncObjSummary', 'vtMap',
            'renderVT', 'matchList', 'sameSearchMatch', 'revealMatch', 'updateNavUI', 'persistWebviewState',
            `let restoringView = false, funcVis = false, funcUserOverride = false, searchAutoFunc = false, curMatch = -1;\n`
                + `${html.slice(restoreStart, refreshStart)}\n`
                + 'return { restoreMemoryMapViewState, values: () => ({ funcVis, funcUserOverride, searchAutoFunc, curMatch }) };'
        ) as (...args: any[]) => {
            restoreMemoryMapViewState: (state: Record<string, unknown>, consume: boolean) => number;
            values: () => Record<string, unknown>;
        };
        const restoreRuntime = restoreBundle(
            documentMock,
            [{ name: 'FLASH' }],
            restoreSearchInput,
            () => { restoreCalls.syncFunc++; },
            () => { restoreCalls.search++; },
            (idx: number) => { rendered.add(idx); restoreCalls.rendered.push(idx); },
            captureRuntime.applyCapturedSort,
            rendered,
            (_card: unknown, expanded: boolean) => { restoreCalls.regionExpanded.push(expanded); },
            (_header: unknown, expanded: boolean) => { restoreCalls.objectExpanded.push(expanded); },
            { objDetailRows: 'Section rows' },
            () => { restoreCalls.objectSynced++; },
            new Map([[0, vt]]),
            () => { restoreCalls.virtualRendered++; },
            [{ k: 'el', el: overviewRow }],
            captureRuntime.sameSearchMatch,
            (idx: number) => { restoreCalls.revealed.push(idx); },
            () => { throw new Error('검색 결과가 있으므로 updateNavUI fallback이면 안 된다'); },
            (state: Record<string, unknown>) => { restoreCalls.persisted.push(state); }
        );
        const restoredScroll = restoreRuntime.restoreMemoryMapViewState(captured, true);
        assert.strictEqual(restoredScroll, 345);
        assert.deepStrictEqual(restoreRuntime.values(), {
            funcVis: true,
            funcUserOverride: true,
            searchAutoFunc: false,
            curMatch: 0,
        });
        assert.strictEqual(restoreCalls.syncFunc, 1);
        assert.strictEqual(restoreCalls.search, 1);
        assert.strictEqual(restoreSearchInput.value, 'HAL_');
        assert.deepStrictEqual(restoreCalls.rendered, [0]);
        assert.deepStrictEqual(restoreCalls.regionExpanded, [true]);
        assert.deepStrictEqual(restoreCalls.objectExpanded, [true]);
        assert.strictEqual(objRows.pressed, 'true');
        assert.strictEqual(restoreCalls.objectSynced, 1);
        assert.strictEqual(vt.vp.scrollTop, 42);
        assert.strictEqual(restoreCalls.virtualRendered, 1);
        assert.deepStrictEqual(restoreCalls.revealed, [0]);
        assert.deepStrictEqual(restoreCalls.persisted, [{ memoryMapViewState: undefined }]);
        assert.strictEqual(allHeader.sort, 'ascending');
        assert.strictEqual(sectionHeader.sort, 'descending');

        const persistedBeforePendingRestore = restoreCalls.persisted.length;
        restoreRuntime.restoreMemoryMapViewState(captured, false);
        restoreRuntime.restoreMemoryMapViewState(captured, false);
        assert.strictEqual(restoreCalls.persisted.length, persistedBeforePendingRestore,
            'busy/failed 같은 render는 여러 번 복원해도 snapshot을 소비하면 안 된다');
    });

    test('manifest가 빠른 열기를 Explorer에만 노출한다', () => {
        const manifestPath = path.resolve(__dirname, '..', '..', 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const commands = manifest.contributes.commands as Array<{ command: string }>;
        const menus = manifest.contributes.menus as Record<string, Array<{
            command: string;
            when?: string;
            group?: string;
        }>>;

        assert.ok(commands.some(item => item.command === 'taskhub.openMemoryMapFromUri'));
        assert.ok(menus.commandPalette.some(item =>
            item.command === 'taskhub.openMemoryMapFromUri' && item.when === 'false'
        ));
        const explorerItem = menus['explorer/context'].find(item =>
            item.command === 'taskhub.openMemoryMapFromUri'
        );
        assert.deepStrictEqual(explorerItem, {
            command: 'taskhub.openMemoryMapFromUri',
            when: 'resourceFilename =~ /\\.(elf|axf|out)$/i',
            group: 'navigation@10',
        });
        for (const [surface, items] of Object.entries(menus)) {
            if (surface === 'commandPalette' || surface === 'explorer/context') { continue; }
            assert.ok(!items.some(item => item.command === 'taskhub.openMemoryMapFromUri'),
                `${surface}에는 빠른 열기 명령을 노출하면 안 된다`);
        }
    });
});
