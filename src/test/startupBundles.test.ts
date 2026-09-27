import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import Ajv from 'ajv';

suite('초기 로딩과 배포 번들', () => {
    const root = path.resolve(__dirname, '..', '..');
    const bundle = path.join(root, 'dist', 'extension.js');

    test('확장 로드와 에디터 등록은 웹뷰 번들을 읽지 않고 첫 문서에서만 읽는다', () => {
        const nativeRequire = createRequire(bundle);
        const loaded: string[] = [];
        // 복제 번들의 최상위 초기화는 실제 호스트에 두 번째 채널을 만들지 않는다.
        // spread는 미사용 proposed API의 getter까지 읽으므로 descriptor를 복제한다.
        const isolatedWindow = Object.create(vscode.window, {
            createOutputChannel: {
                value: () => ({
                    append() {}, appendLine() {}, clear() {}, show() {}, hide() {}, dispose() {},
                }),
            },
        });
        const isolatedVscode = Object.create(Object.getPrototypeOf(vscode), {
            ...Object.getOwnPropertyDescriptors(vscode),
            window: { value: isolatedWindow, enumerable: true },
        });
        const trackedRequire = (id: string) => {
            loaded.push(id);
            return id === 'vscode' ? isolatedVscode : nativeRequire(id);
        };
        const module = { exports: {} };
        new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(bundle, 'utf8'))(
            trackedRequire, module, module.exports, path.dirname(bundle)
        );
        const extension = module.exports as typeof import('../extension');
        const features = /(?:jsonEditor|memoryMapViewer|hexViewer|hexConverter|actionRunReport)\.js$/;
        assert.deepStrictEqual(loaded.filter(id => features.test(id)), []);
        const provider = extension.createLazyHexEditorProvider({} as vscode.ExtensionContext, () => undefined);
        assert.deepStrictEqual(loaded.filter(id => features.test(id)), [], 'provider 등록도 지연 경계를 유지한다');
        const uri = vscode.Uri.file(path.join(root, 'examples', 'sample_binary.bin'));
        const cancellation = new vscode.CancellationTokenSource();
        let document: vscode.CustomDocument | undefined;
        try {
            document = provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, cancellation.token) as vscode.CustomDocument;
            assert.strictEqual(document.uri.toString(), uri.toString());
            assert.deepStrictEqual(loaded.filter(id => features.test(id)), ['./hexViewer.js']);
            assert.strictEqual(extension.getActionsValidator()([]), true);
            assert.strictEqual(extension.getActionsValidator()({}), false);
        } finally {
            document?.dispose();
            cancellation.dispose();
        }
    });

    test('사전 생성 검증기는 같은 빌드 옵션의 상세 오류와 기존 사용자 표시 오류를 보존한다', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'actions.schema.json'), 'utf8'));
        const reference = new Ajv({ allErrors: true, inlineRefs: false }).compile(schema);
        const previous = new Ajv({ allErrors: true }).compile(schema);
        const generated = require(path.join(root, 'dist', 'actionsValidator.js')) as typeof reference;
        const samples: unknown[] = [null, {}, [], [null], [{ id: 'bad id', title: 1 }],
            [{ id: 'ok', title: '한글', action: { description: 'test', tasks: [{ id: 'build', type: 'command', command: 'echo', args: ['ok'] }] } }],
            [{ id: 'invalid', title: 'x', action: { tasks: [{ id: 1, type: 'unknown', when: { var: 'x', equals: 'y', matches: '(' } }] } }],
        ];
        for (const directory of ['presets', 'examples']) {
            for (const name of fs.readdirSync(path.join(root, directory))) {
                if (!name.endsWith('.json')) { continue; }
                try { samples.push(JSON.parse(fs.readFileSync(path.join(root, directory, name), 'utf8'))); } catch { /* JSONC 등은 별도 파서의 범위다. */ }
            }
        }
        for (const sample of samples) {
            assert.strictEqual(generated(sample), reference(sample));
            assert.deepStrictEqual(generated.errors, reference.errors, JSON.stringify(sample).slice(0, 200));
            assert.strictEqual(generated(sample), previous(sample));
            // inlineRefs:false는 참조 내부 schemaPath만 상대화한다. 입력 경로,
            // keyword, params, message와 오류 순서는 이전 표시 동작과 같아야 한다.
            const visibleErrors = (errors: typeof reference.errors) => errors?.map(({ schemaPath: _schemaPath, ...error }) => error);
            assert.deepStrictEqual(visibleErrors(generated.errors), visibleErrors(previous.errors), JSON.stringify(sample).slice(0, 200));
        }
    });

    test('별도 기능 번들도 초기화된 파일 열기 위치 기억을 공유한다', async () => {
        const dialogs = require(path.join(root, 'dist', 'dialogMemory.js')) as typeof import('../dialogMemory');
        const editor = require(path.join(root, 'dist', 'jsonEditor.js')) as typeof import('../jsonEditor');
        const remembered = path.join(root, 'presets');
        const state = {
            keys: () => [],
            get: (key: string, fallback: unknown) => key === 'taskhub.dialogLocations'
                ? { jsonEditor: { dir: remembered, at: Date.now() } } : fallback,
            update: async () => undefined,
        };
        const context = { workspaceState: state, globalState: state } as unknown as vscode.ExtensionContext;
        const previous = dialogs.initDialogMemory(context);
        const originalDialog = vscode.window.showOpenDialog;
        const originalConfiguration = vscode.workspace.getConfiguration;
        let defaultUri: vscode.Uri | undefined;
        (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
            defaultUri = options.defaultUri;
            return undefined;
        };
        (vscode.workspace as any).getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
        try {
            await editor.openJsonEditor(context);
            assert.strictEqual(defaultUri?.fsPath, remembered);
        } finally {
            dialogs.initDialogMemory(previous);
            (vscode.window as any).showOpenDialog = originalDialog;
            (vscode.workspace as any).getConfiguration = originalConfiguration;
        }
    });
});
