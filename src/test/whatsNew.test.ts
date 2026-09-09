import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    buildWhatsNewMarkdown,
    getUnreadReleases,
    initializeWhatsNewState,
    markReleasesViewed,
    parseChangelog,
    registerWhatsNew,
    resolveChangelogUri,
    WHATS_NEW_COMMAND,
    WHATS_NEW_STORAGE_DIRECTORY,
} from '../whatsNew';

const changelog = `# Change Log
<!--
## [9.9.9] - 2099-01-01
### 가짜 제목
-->
## [1.0.10] - 2026-09-10
### 추가 — 열 번째 변경
- 열 번째 내용.
## [1.0.2] - 2026-09-09
### 추가 — 새 기능
- [사용법](docs/features.md#새-기능)
\`\`\`markdown
## [8.0.0] - 2099-01-01
### 코드 안 제목
\`\`\`
### 수정 — 오류 해결
- 자세한 내용.
## [1.0.1] - 2026-09-08
### 개선 — 첫 번째 변경
- 첫 번째 내용.
## [1.0.0] - 2026-09-07
### 추가 — 첫 릴리스
- 초기 기능.
`;

suite('업데이트 변경 내용', () => {
    test('변경 이력 경로는 소스·VSIX의 실제 대소문자를 보존하고 누락된 파일은 거부한다', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-changelog-case-'));
        try {
            for (const [folder, fileName] of [['source', 'CHANGELOG.md'], ['vsix', 'changelog.md']]) {
                const extensionRoot = path.join(directory, folder);
                fs.mkdirSync(extensionRoot);
                fs.writeFileSync(path.join(extensionRoot, fileName), changelog);
                const uri = await resolveChangelogUri(vscode.Uri.file(extensionRoot));
                assert.strictEqual(path.posix.basename(uri.path), fileName, '대소문자를 구분하지 않는 OS에서도 정확한 URI 철자를 검증한다');
                assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), changelog);
            }
            const missingRoot = path.join(directory, 'missing');
            fs.mkdirSync(path.join(missingRoot, 'changelog.md'), { recursive: true });
            await assert.rejects(
                resolveChangelogUri(vscode.Uri.file(missingRoot)),
                (error: unknown) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound'
            );
            await assert.rejects(
                resolveChangelogUri(vscode.Uri.file(path.join(directory, 'absent'))),
                (error: unknown) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound'
            );
        } finally {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });

    test('동봉하는 CHANGELOG에서 현재 패키지 버전과 요약 제목을 추출할 수 있다', () => {
        const root = path.resolve(__dirname, '..', '..');
        const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
        const releases = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
        const current = releases.find(release => release.version === version);
        assert.ok(current, `현재 버전 ${version}의 CHANGELOG가 필요하다`);
        assert.ok(current!.titles.length > 0, '현재 버전에는 런처에서 보여 줄 요약 제목이 필요하다');
    });

    test('코드·주석의 가짜 제목을 무시하고 여러 분류 제목과 원문을 보존한다', () => {
        const releases = parseChangelog(changelog.replace(/\n/g, '\r\n'));
        assert.deepStrictEqual(releases.map(release => release.version), ['1.0.10', '1.0.2', '1.0.1', '1.0.0']);
        assert.deepStrictEqual(releases[1].titles, ['추가 — 새 기능', '수정 — 오류 해결']);
        assert.ok(releases[1].markdown.includes('### 코드 안 제목'));
        assert.ok(!releases[1].markdown.includes('첫 번째 내용'));
        assert.strictEqual(releases[1].date, '2026-09-09');
    });

    test('긴 물결 코드 펜스·제목 없는 릴리스·미발행 구역·중복 버전을 처리한다', () => {
        const releases = parseChangelog(`## [1.0.2] - 2026-09-09
- 제목 없는 변경
~~~~markdown
~~~
## [7.0.0] - 2099-01-01
~~~~
## [Unreleased]
### 아직 발행하지 않음
## [1.0.1] - 2026-09-08
### 첫 제목
## [1.0.1] - 2026-09-08
### 중복 제목
`);
        assert.deepStrictEqual(releases.map(release => release.version), ['1.0.2', '1.0.1']);
        assert.deepStrictEqual(releases[0].titles, []);
        assert.ok(!releases[0].markdown.includes('아직 발행하지 않음'));
        assert.deepStrictEqual(releases[1].titles, ['첫 제목']);
        assert.deepStrictEqual(parseChangelog('not a changelog'), []);
    });

    test('최초 설치는 조용히 기준만 저장하고 건너뛴 업데이트를 누적한다', () => {
        const releases = parseChangelog(changelog);
        const first = initializeWhatsNewState(undefined, '1.0.0');
        assert.deepStrictEqual(getUnreadReleases(releases, first), []);
        const upgraded = initializeWhatsNewState(first, '1.0.2');
        assert.deepStrictEqual(getUnreadReleases(releases, upgraded).map(release => release.version), ['1.0.2', '1.0.1']);
        const reopened = initializeWhatsNewState(upgraded, '1.0.2');
        assert.deepStrictEqual(reopened, upgraded);
        const latest = initializeWhatsNewState(reopened, '1.0.10');
        assert.deepStrictEqual(getUnreadReleases(releases, latest).map(release => release.version), ['1.0.10', '1.0.2', '1.0.1']);
    });

    test('한 버전만 읽으면 나머지는 유지하고 전체 확인 뒤에도 최초 기준을 유지한다', () => {
        const releases = parseChangelog(changelog);
        const upgraded = initializeWhatsNewState(initializeWhatsNewState(undefined, '1.0.0'), '1.0.2');
        const partiallyRead = markReleasesViewed(upgraded, [releases[1]]);
        assert.strictEqual(partiallyRead.readThroughVersion, '1.0.0');
        assert.deepStrictEqual(getUnreadReleases(releases, partiallyRead).map(release => release.version), ['1.0.1']);
        const allRead = markReleasesViewed(partiallyRead, [releases[2]]);
        assert.strictEqual(allRead.readThroughVersion, '1.0.0');
        assert.deepStrictEqual(allRead.viewedVersions, ['1.0.2', '1.0.1']);
        assert.deepStrictEqual(getUnreadReleases(releases, allRead), []);
    });

    test('다운그레이드와 재업그레이드가 이미 읽은 상태를 되돌리지 않는다', () => {
        const releases = parseChangelog(changelog);
        const baseline = initializeWhatsNewState(undefined, '1.0.2');
        const downgraded = initializeWhatsNewState(baseline, '1.0.0');
        assert.deepStrictEqual(getUnreadReleases(releases, downgraded), []);
        assert.deepStrictEqual(getUnreadReleases(releases, initializeWhatsNewState(downgraded, '1.0.2')), []);
        const unread = initializeWhatsNewState(initializeWhatsNewState(undefined, '1.0.0'), '1.0.10');
        const partial = markReleasesViewed(unread, [releases[1]]);
        const lower = initializeWhatsNewState(partial, '1.0.1');
        assert.deepStrictEqual(getUnreadReleases(releases, lower).map(release => release.version), ['1.0.1']);
        assert.deepStrictEqual(getUnreadReleases(releases, initializeWhatsNewState(lower, '1.0.10'))
            .map(release => release.version), ['1.0.10', '1.0.1']);
    });

    test('상태 전환은 잘못된 버전과 중복 항목을 정규화한다', () => {
        assert.deepStrictEqual(initializeWhatsNewState({ readThroughVersion: 'bad', viewedVersions: 'oops' }, '1.0.2'), {
            installedVersion: '1.0.2', readThroughVersion: '1.0.2', viewedVersions: [],
        });
        const old = initializeWhatsNewState({ readThroughVersion: '1.0.0', viewedVersions: ['1.0.2', '1.0.2', 5, 'bad'] }, '1.0.2');
        assert.deepStrictEqual(old.viewedVersions, ['1.0.2']);
    });

    test('읽기 전용 상세의 상대 문서 링크가 확장 디렉터리를 기준으로 해석된다', () => {
        const extensionUri = vscode.Uri.file('/TaskHub extension');
        const release = parseChangelog(changelog)[1];
        const rendered = buildWhatsNewMarkdown([release], extensionUri);
        assert.ok(rendered.includes(vscode.Uri.joinPath(extensionUri, 'docs/features.md').with({ fragment: '새-기능' }).toString()));
        assert.ok(rendered.includes(release.titles[0]));
        assert.ok(rendered.includes('CHANGELOG'));
        assert.ok(!rendered.includes('열 번째 내용'));
    });

    test('선택 취소·표시 실패는 읽지 않은 상태를 유지하며 실제 표시한 버전만 읽음 처리한다', async () => {
        const originalRegisterCommand = vscode.commands.registerCommand;
        const originalExecuteCommand = vscode.commands.executeCommand;
        const originalRegisterProvider = vscode.workspace.registerTextDocumentContentProvider;
        const originalOpenTextDocument = vscode.workspace.openTextDocument;
        const originalShowTextDocument = vscode.window.showTextDocument;
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const originalShowWarningMessage = vscode.window.showWarningMessage;
        let handler: (() => Promise<void>) | undefined;
        let provider: vscode.TextDocumentContentProvider | undefined;
        let selection: 'cancel' | 'one' | 'all' = 'cancel';
        let displayFails = false;
        let previewAvailable = false;
        let sourceDisplays = 0;
        let shown = '';
        let errors = 0;
        const warnings: string[] = [];
        const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-whats-new-'));
        fs.writeFileSync(path.join(extensionDirectory, 'changelog.md'), changelog);
        const markerRoot = path.join(extensionDirectory, 'storage', WHATS_NEW_STORAGE_DIRECTORY);
        fs.mkdirSync(markerRoot, { recursive: true });
        fs.writeFileSync(path.join(markerRoot, 'baseline-1.0.0'), '');
        const context = {
            extension: { packageJSON: { version: '1.0.2' } },
            extensionUri: vscode.Uri.file(extensionDirectory),
            globalStorageUri: vscode.Uri.file(path.join(extensionDirectory, 'storage')),
            subscriptions: [],
            globalState: {
                get: () => undefined,
                update: async () => { throw new Error('What’s New must not rewrite the shared memento'); },
            },
        } as unknown as vscode.ExtensionContext;
        try {
            (vscode.commands as any).registerCommand = (id: string, callback: () => Promise<void>) => {
                assert.strictEqual(id, WHATS_NEW_COMMAND);
                handler = callback;
                return { dispose: () => undefined };
            };
            (vscode.workspace as any).registerTextDocumentContentProvider = (_scheme: string, value: vscode.TextDocumentContentProvider) => {
                provider = value;
                return { dispose: () => undefined };
            };
            (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => ({ uri });
            const readDocument = async (uri: vscode.Uri) => {
                const cancellation = new vscode.CancellationTokenSource();
                try {
                    shown = await provider!.provideTextDocumentContent(uri, cancellation.token) ?? '';
                } finally {
                    cancellation.dispose();
                }
            };
            (vscode.commands as any).executeCommand = async (id: string, uri: vscode.Uri) => {
                assert.strictEqual(id, 'markdown.showPreview');
                if (!previewAvailable) { throw new Error('Markdown preview unavailable'); }
                await readDocument(uri);
            };
            (vscode.window as any).showTextDocument = async (document: vscode.TextDocument) => {
                if (displayFails) { throw new Error('display failed'); }
                sourceDisplays++;
                await readDocument(document.uri);
                return {};
            };
            (vscode.window as any).showQuickPick = async (items: Array<{ releases: Array<{ version: string }> }>) => {
                if (selection === 'cancel') { return undefined; }
                if (selection === 'all') { return items[0]; }
                return items.find(item => item.releases.length === 1 && item.releases[0].version === '1.0.2');
            };
            (vscode.window as any).showErrorMessage = async () => { errors++; };
            (vscode.window as any).showWarningMessage = async (message: string) => { warnings.push(message); };
            const controller = registerWhatsNew(context);
            assert.ok(handler);
            await handler!();
            assert.strictEqual(controller.getUnreadCount(), 2);
            selection = 'one';
            displayFails = true;
            await handler!();
            assert.strictEqual(errors, 1);
            assert.strictEqual(controller.getUnreadCount(), 2);
            displayFails = false;
            await handler!();
            assert.ok(shown.includes('새 기능'));
            assert.ok(!shown.includes('첫 번째 내용'));
            assert.strictEqual(controller.getUnreadCount(), 1);
            selection = 'all';
            previewAvailable = true;
            await handler!();
            assert.ok(shown.includes('첫 번째 내용'));
            assert.strictEqual(sourceDisplays, 1, '미리 보기에 성공하면 원문 편집기를 추가로 열지 않는다');
            assert.strictEqual(controller.getUnreadCount(), 0);
            assert.deepStrictEqual(fs.readdirSync(path.join(context.globalStorageUri.fsPath, WHATS_NEW_STORAGE_DIRECTORY)).sort(), [
                'baseline-1.0.0', 'read-1.0.1', 'read-1.0.2',
            ]);
            await handler!();
            assert.ok(shown.includes('새 기능'), '읽은 뒤 수동으로 열면 현재 버전을 보여 준다');
            const storageDirectory = path.join(context.globalStorageUri.fsPath, WHATS_NEW_STORAGE_DIRECTORY);
            fs.renameSync(storageDirectory, `${storageDirectory}.backup`);
            fs.writeFileSync(storageDirectory, 'storage is unavailable');
            await handler!();
            assert.strictEqual(warnings.length, 1, '상세를 연 뒤 읽음 상태 저장이 실패하면 사용자에게 알린다');
            assert.ok(/읽음 상태|read status/.test(warnings[0]));
            assert.strictEqual(controller.getUnreadCount(), 0, '현재 창에서 읽은 사실은 유지한다');
            assert.strictEqual(errors, 1, '저장 실패를 상세 열기 실패로 잘못 알리지 않는다');
        } finally {
            context.subscriptions.forEach(disposable => disposable.dispose());
            (vscode.commands as any).registerCommand = originalRegisterCommand;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
            (vscode.workspace as any).registerTextDocumentContentProvider = originalRegisterProvider;
            (vscode.workspace as any).openTextDocument = originalOpenTextDocument;
            (vscode.window as any).showTextDocument = originalShowTextDocument;
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
            (vscode.window as any).showWarningMessage = originalShowWarningMessage;
            fs.rmSync(extensionDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });

    test('서로 다른 창의 동시 읽음 저장은 합쳐지고 재시작·다운그레이드 후에도 유지된다', async function () {
        this.timeout(15000);
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-whats-new-concurrent-'));
        const storageRoot = path.join(temporaryRoot, 'shared-storage');
        const markerDirectory = path.join(storageRoot, WHATS_NEW_STORAGE_DIRECTORY);
        const original = {
            register: vscode.commands.registerCommand,
            execute: vscode.commands.executeCommand,
            provider: vscode.workspace.registerTextDocumentContentProvider,
            open: vscode.workspace.openTextDocument,
            pick: vscode.window.showQuickPick,
            write: fs.promises.writeFile,
            read: fs.promises.readdir,
        };
        const handlers: Array<() => Promise<void>> = [];
        const contexts: vscode.ExtensionContext[] = [];
        const selections: Array<string | undefined> = [];
        let blockReceiptWrites = false;
        let writesBlocked = 0;
        let sharedMementoWrites = 0;
        let bothBlocked!: () => void;
        const blocked = new Promise<void>(resolve => { bothBlocked = resolve; });
        let releaseWrites!: () => void;
        const canWrite = new Promise<void>(resolve => { releaseWrites = resolve; });
        let pendingReads: Promise<void>[] = [];
        let timer: NodeJS.Timeout | undefined;
        let releaseInitialReads: (() => void) | undefined;
        const makeContext = (version: string, targetStorage = storageRoot): vscode.ExtensionContext => {
            const extensionRoot = path.join(temporaryRoot, `extension-${contexts.length}`);
            fs.mkdirSync(extensionRoot);
            fs.writeFileSync(path.join(extensionRoot, 'CHANGELOG.md'), changelog);
            // 실제 Extension Host처럼 각 창은 별도의 memento 스냅샷을 가진다.
            // 읽음 저장은 이 전체 스냅샷을 다시 쓰지 않아야 한다.
            const context = {
                extension: { packageJSON: { version } },
                extensionUri: vscode.Uri.file(extensionRoot),
                globalStorageUri: vscode.Uri.file(targetStorage),
                subscriptions: [],
                globalState: {
                    get: () => undefined,
                    update: async () => { sharedMementoWrites++; },
                },
            } as unknown as vscode.ExtensionContext;
            contexts.push(context);
            return context;
        };
        try {
            (vscode.commands as any).registerCommand = (_id: string, callback: () => Promise<void>) => {
                handlers.push(callback);
                return { dispose: () => undefined };
            };
            (vscode.workspace as any).registerTextDocumentContentProvider = () => ({ dispose: () => undefined });
            (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => ({ uri });
            (vscode.commands as any).executeCommand = async (id: string) => { assert.strictEqual(id, 'markdown.showPreview'); };
            (vscode.window as any).showQuickPick = async (items: Array<{ releases: Array<{ version: string }> }>) => {
                const selected = selections.shift();
                return selected === undefined ? undefined
                    : items.find(item => item.releases.length === 1 && item.releases[0].version === selected);
            };
            (fs.promises as any).writeFile = async (...args: Parameters<typeof fs.promises.writeFile>) => {
                const target = String(args[0]);
                if (blockReceiptWrites && path.dirname(target) === markerDirectory && path.basename(target).startsWith('read-')) {
                    writesBlocked++;
                    if (writesBlocked === 2) { bothBlocked(); }
                    await canWrite;
                }
                return original.write(...args);
            };
            fs.mkdirSync(markerDirectory, { recursive: true });
            fs.writeFileSync(path.join(markerDirectory, 'baseline-1.0.0'), '');
            const first = registerWhatsNew(makeContext('1.0.10'));
            const second = registerWhatsNew(makeContext('1.0.10'));
            await Promise.all(handlers.map(handler => handler()));
            assert.strictEqual(first.getUnreadCount(), 3);
            assert.strictEqual(second.getUnreadCount(), 3);

            blockReceiptWrites = true;
            selections.push('1.0.1', '1.0.2');
            pendingReads = handlers.map(handler => handler());
            await Promise.race([
                blocked,
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('concurrent receipt writes did not overlap')), 5000); }),
            ]);
            releaseWrites();
            await Promise.all(pendingReads);
            blockReceiptWrites = false;
            assert.deepStrictEqual(fs.readdirSync(markerDirectory).sort(), ['baseline-1.0.0', 'read-1.0.1', 'read-1.0.2']);
            fs.mkdirSync(path.join(markerDirectory, 'read-1.0.10'));
            fs.writeFileSync(path.join(markerDirectory, 'baseline-01.0.0'), '');
            fs.writeFileSync(path.join(markerDirectory, 'read-1.0.10.backup'), '');

            await handlers[0]();
            await handlers[1]();
            assert.strictEqual(first.getUnreadCount(), 1, '다른 창이 읽은 버전도 다음 목록 열기에서 반영한다');
            assert.strictEqual(second.getUnreadCount(), 1);
            const reopened = registerWhatsNew(makeContext('1.0.10'));
            await handlers[2]();
            assert.strictEqual(reopened.getUnreadCount(), 1, 'memento가 없어도 두 창의 읽음 표식이 모두 복원되어야 한다');
            const downgraded = registerWhatsNew(makeContext('1.0.1'));
            await handlers[3]();
            assert.strictEqual(downgraded.getUnreadCount(), 0);
            const upgraded = registerWhatsNew(makeContext('1.0.10'));
            await handlers[4]();
            assert.strictEqual(upgraded.getUnreadCount(), 1);
            assert.strictEqual(sharedMementoWrites, 0, '창별 전체 memento 스냅샷으로 읽음 상태를 덮어쓰지 않는다');

            const initialStorage = path.join(temporaryRoot, 'first-start');
            const initialMarkers = path.join(initialStorage, WHATS_NEW_STORAGE_DIRECTORY);
            let initialReads = 0;
            const initialSnapshots = new Promise<void>(resolve => { releaseInitialReads = resolve; });
            (fs.promises as any).readdir = async (directory: string, options: any) => {
                if (directory === initialMarkers && initialReads < 2) {
                    // 두 창 모두 처음 저장소가 비어 있는 것을 읽은 뒤에만 표식을 쓰게 한다.
                    initialReads++;
                    if (initialReads === 2) { releaseInitialReads!(); }
                    await initialSnapshots;
                    return [];
                }
                return original.read(directory, options);
            };
            const olderStart = registerWhatsNew(makeContext('1.0.1', initialStorage));
            const newerStart = registerWhatsNew(makeContext('1.0.2', initialStorage));
            await Promise.all([handlers[5](), handlers[6]()]);
            assert.deepStrictEqual(fs.readdirSync(initialMarkers).sort(), ['baseline-1.0.1', 'baseline-1.0.2']);
            assert.strictEqual(olderStart.getUnreadCount(), 0);
            await handlers[6]();
            assert.strictEqual(newerStart.getUnreadCount(), 1, '동시 최초 시작에서는 가장 오래된 기준 뒤 업데이트를 보존한다');

            const failedStorage = path.join(temporaryRoot, 'failed-storage');
            fs.mkdirSync(failedStorage);
            fs.writeFileSync(path.join(failedStorage, WHATS_NEW_STORAGE_DIRECTORY), 'not a directory');
            const failedStart = registerWhatsNew(makeContext('1.0.2', failedStorage));
            await handlers[7]();
            assert.strictEqual(failedStart.getUnreadCount(), 0, '초기 기준 저장 실패도 활성화와 변경 목록 열기를 막지 않는다');
        } finally {
            releaseWrites();
            releaseInitialReads?.();
            if (timer) { clearTimeout(timer); }
            await Promise.allSettled(pendingReads);
            for (const context of contexts) { context.subscriptions.forEach(disposable => disposable.dispose()); }
            vscode.commands.registerCommand = original.register;
            vscode.commands.executeCommand = original.execute;
            vscode.workspace.registerTextDocumentContentProvider = original.provider;
            vscode.workspace.openTextDocument = original.open;
            vscode.window.showQuickPick = original.pick;
            fs.promises.writeFile = original.write;
            fs.promises.readdir = original.read;
            fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });

    test('Markdown 미리 보기를 사용할 수 없으면 실제 읽기 전용 문서로 연다', async () => {
        const originalShowQuickPick = vscode.window.showQuickPick;
        const originalExecuteCommand = vscode.commands.executeCommand;
        let opened: vscode.TextEditor | undefined;
        try {
            (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => items[0];
            (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
                if (command === 'markdown.showPreview') { throw new Error('Markdown preview unavailable'); }
                return originalExecuteCommand(command, ...args);
            };
            await vscode.commands.executeCommand(WHATS_NEW_COMMAND);
            opened = vscode.window.activeTextEditor;
            assert.strictEqual(opened?.document.uri.scheme, 'taskhub-whats-new');
            const before = opened!.document.getText();
            assert.ok(before.includes('CHANGELOG'));
            // 확장 API의 TextEditor.edit는 읽기 전용 문서도 수정할 수 있다. 실제 사용자 입력 경로를 검사한다.
            await vscode.commands.executeCommand('default:type', { text: 'unexpected edit' });
            assert.strictEqual(opened!.document.getText(), before);
            assert.strictEqual(opened!.document.isDirty, false);
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            (vscode.commands as any).executeCommand = originalExecuteCommand;
            if (opened?.document.uri.scheme === 'taskhub-whats-new') {
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }
        }
    });

    test('기본 Markdown 확장이 가상 문서의 실제 미리 보기 탭을 연다', async function () {
        this.timeout(15000);
        const originalShowQuickPick = vscode.window.showQuickPick;
        const matchingTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
            .filter(tab => tab.input instanceof vscode.TabInputWebview
                && tab.input.viewType.includes('markdown') && /TaskHub-\d+\.\d+\.\d+/.test(tab.label));
        try {
            (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => items[0];
            await vscode.commands.executeCommand(WHATS_NEW_COMMAND);
            const preview = await new Promise<vscode.Tab>((resolve, reject) => {
                const check = () => {
                    const tab = matchingTabs()[0];
                    if (tab) {
                        clearTimeout(timer);
                        listener.dispose();
                        resolve(tab);
                    }
                };
                const listener = vscode.window.tabGroups.onDidChangeTabs(check);
                const timer = setTimeout(() => {
                    listener.dispose();
                    reject(new Error('새로운 기능의 Markdown 미리 보기 탭이 열리지 않았다'));
                }, 8000);
                check();
            });
            assert.ok(preview.isActive, '선택한 릴리스 미리 보기가 활성 탭이어야 한다');
            assert.ok(vscode.workspace.textDocuments.some(document => document.uri.scheme === 'taskhub-whats-new'
                && document.getText().includes('CHANGELOG')), '미리 보기는 동봉된 CHANGELOG 가상 문서를 읽어야 한다');
        } finally {
            (vscode.window as any).showQuickPick = originalShowQuickPick;
            const tabs = matchingTabs();
            if (tabs.length > 0) {
                assert.strictEqual(await vscode.window.tabGroups.close(tabs, true), true);
            }
        }
    });
});
