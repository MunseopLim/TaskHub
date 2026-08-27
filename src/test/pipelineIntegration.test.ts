import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    executeAction,
    executeActionPipeline,
    __testHook_flushBackgroundCompletions,
    __testHook_resetShellEnvNamesCache,
} from '../extension';
import { initDialogMemory } from '../dialogMemory';
import { actionStates } from '../providers/actionStatus';
import { HistoryEntry, HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem, Action as PipelineAction } from '../schema';
import { buildInputProfileDraft, InputProfileStore, inspectInputProfile } from '../inputProfiles';
import { ActionRunLogCollector, RunLogStore } from '../runLogStore';
import { buildBuiltinVariableContext } from '../builtinVariables';

/**
 * Integration test scenarios for TaskHub pipelines.
 *
 * Canonical index and intent for each scenario lives in
 * `docs/integration-tests.md`. Keep that document and this file in sync —
 * the table there is the spec, this file is the executable proof.
 *
 * Each test creates/tears down a disposable workspace directory so runs are
 * hermetic and survive reruns.
 */
suite('Pipeline integration', function () {
    this.timeout(15000);

    let tempWorkspace: string;

    function normalizeWindowsPathForAssert(value: string): string {
        return process.platform === 'win32'
            ? value.replace(/\b([a-z]):\\/g, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
            : value;
    }

    setup(() => {
        tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-pipeline-workspace-'));
    });

    teardown(() => {
        actionStates.clear();
        if (tempWorkspace && fs.existsSync(tempWorkspace)) {
            // On Windows a just-killed child process can briefly keep a handle
            // on its working directory; rmSync then fails with EBUSY. Retry a
            // few times, then fall back to best-effort: a leftover temp dir
            // under os.tmpdir() is harmless and must not fail the suite.
            try {
                fs.rmSync(tempWorkspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (err: any) {
                console.warn(`teardown: could not remove ${tempWorkspace} (${err?.code ?? err?.message ?? err}); leaving for OS temp cleanup`);
            }
        }
    });

    /** Run a pipeline against the current `tempWorkspace`. */
    function run(action: PipelineAction, id = 'integration.pipeline'): Promise<void> {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        return executeActionPipeline(
            action,
            { extensionPath: extensionRoot } as vscode.ExtensionContext,
            id,
            tempWorkspace,
            [tempWorkspace]
        );
    }

    async function withCreatedQuickPick<T>(
        interact: (picker: any, controls: { type(value: string): void; accept(): void }) => void,
        fn: () => Promise<T>
    ): Promise<T> {
        const original = vscode.window.createQuickPick;
        const acceptListeners: Array<() => void> = [];
        const hideListeners: Array<() => void> = [];
        const valueListeners: Array<(value: string) => void> = [];
        const event = <TListener extends (...args: any[]) => void>(listeners: TListener[]) =>
            (listener: TListener) => {
                listeners.push(listener);
                return { dispose: () => {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) { listeners.splice(index, 1); }
                } };
            };
        const picker: any = {
            items: [], selectedItems: [], activeItems: [], value: '', canSelectMany: false,
            onDidAccept: event(acceptListeners),
            onDidHide: event(hideListeners),
            onDidChangeValue: event(valueListeners),
            show: () => queueMicrotask(() => interact(picker, {
                type: (value: string) => {
                    picker.value = value;
                    for (const listener of [...valueListeners]) { listener(value); }
                },
                accept: () => { for (const listener of [...acceptListeners]) { listener(); } },
            })),
            hide: () => { for (const listener of [...hideListeners]) { listener(); } },
            dispose: () => undefined,
        };
        (vscode.window as any).createQuickPick = () => picker;
        try {
            return await fn();
        } finally {
            (vscode.window as any).createQuickPick = original;
        }
    }

    /**
     * In-memory context for the dialog-location store. The bundled extension
     * (`dist/`) and this test file (`out/`) are separate module instances, so
     * the host's `initDialogMemory(context)` from activation is not visible
     * here — tests that exercise remembered locations install their own.
     */
    function makeDialogMemoryContext(): vscode.ExtensionContext {
        const makeMemento = (store: Map<string, unknown>) => ({
            keys: () => Array.from(store.keys()),
            get: <T>(key: string, defaultValue?: T) => (store.has(key) ? store.get(key) as T : defaultValue),
            update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
            setKeysForSync: () => undefined,
        });
        return {
            workspaceState: makeMemento(new Map()),
            globalState: makeMemento(new Map()),
        } as unknown as vscode.ExtensionContext;
    }

    /** Cross-platform printf of a single line (no trailing newline). */
    function echoOneLine(text: string) {
        return {
            windows: `cmd /c echo ${text}`,
            macos: `printf ${text}`,
            linux: `printf ${text}`,
        };
    }

    /**
     * Cross-platform multi-line output via node. We pass the JS source as a
     * second arg to `node -e` so the shell never has to quote embedded
     * newlines — JSON.stringify handles all escaping.
     */
    function nodeMultilineArgs(lines: string[]): string[] {
        return ['-e', `process.stdout.write(${JSON.stringify(lines.join('\n'))})`];
    }

    test('IT-169: 현재 파일·환경 문맥은 실행에 전달되고 기록에서는 민감 값이 가려진다', async () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const resultPath = path.join(tempWorkspace, 'it169.json');
        const activeFile = path.join(tempWorkspace, 'src', 'main file.c');
        const recordCommands: Record<string, string> = Object.create(null);
        const builtinVariables = buildBuiltinVariableContext({
            workspaceFolder: tempWorkspace,
            extensionPath: extensionRoot,
            editor: {
                file: activeFile,
                fileWorkspaceFolder: tempWorkspace,
                selectedText: 'selected secret',
                lineNumber: 7,
                columnNumber: 3,
            },
            clipboard: 'clipboard secret',
            environment: { TASKHUB_CONTEXT_TOKEN: 'environment secret' },
            strict: true,
        });
        const action: PipelineAction = {
            description: 'IT-169',
            tasks: [
                {
                    id: 'run', type: 'command', command: 'node',
                    args: [
                        '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
                        '${file}', '${relativeFile}', '${selectedText}', '${clipboard}',
                        '${env:TASKHUB_CONTEXT_TOKEN}', '${lineNumber}', '${columnNumber}',
                    ],
                    passTheResultToNextTask: true,
                },
                {
                    id: 'save', type: 'writeFile', path: resultPath,
                    content: '${run.output}', allowSecretContent: true,
                },
            ],
        };

        await executeActionPipeline(
            action,
            { extensionPath: extensionRoot } as vscode.ExtensionContext,
            'it169',
            tempWorkspace,
            [tempWorkspace],
            { builtinVariables, recordCommands }
        );

        assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), [
            activeFile,
            path.join('src', 'main file.c'),
            'selected secret',
            'clipboard secret',
            'environment secret',
            '7',
            '3',
        ]);
        assert.ok(recordCommands.run.includes(activeFile), '파일 경로까지 가리면 실행 기록의 효용이 사라진다');
        for (const secret of ['selected secret', 'clipboard secret', 'environment secret']) {
            assert.ok(!recordCommands.run.includes(secret), `실행 기록에 민감 문맥이 남았다: ${secret}`);
        }
        assert.ok(recordCommands.run.includes('***'), recordCommands.run);
    });

    test('IT-170: 실행 시작 시 활성 에디터의 파일·선택·커서를 자동 스냅샷한다', async () => {
        const activeFile = path.join(tempWorkspace, 'src', 'active file.txt');
        const resultPath = path.join(tempWorkspace, 'it170.txt');
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        fs.writeFileSync(activeFile, 'alpha beta gamma', 'utf8');
        const document = await vscode.workspace.openTextDocument(activeFile);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        editor.selection = new vscode.Selection(0, 6, 0, 10);

        try {
            await run({
                description: 'IT-170',
                tasks: [{
                    id: 'save', type: 'writeFile', path: resultPath,
                    content: '${file}|${relativeFile}|${selectedText}|${lineNumber}|${columnNumber}',
                    allowSecretContent: true,
                }],
            }, 'it170');
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        assert.strictEqual(
            normalizeWindowsPathForAssert(fs.readFileSync(resultPath, 'utf8')),
            normalizeWindowsPathForAssert(
                `${activeFile}|${path.join('src', 'active file.txt')}|beta|1|11`
            )
        );
    });

    test('IT-179: 명시 workspaceRoots 밖의 창 파일에는 상대 경로를 만들지 않는다', async () => {
        const windowWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(windowWorkspace, '테스트 호스트 workspace가 필요하다');
        const activeFile = path.join(windowWorkspace, 'actions.schema.json');
        const resultPath = path.join(tempWorkspace, 'it179.txt');
        const document = await vscode.workspace.openTextDocument(activeFile);
        await vscode.window.showTextDocument(document, { preview: false });

        try {
            await run({
                description: 'IT-179',
                tasks: [{
                    id: 'save', type: 'writeFile', path: resultPath,
                    content: '${relativeFile ?? workspaceFolder}',
                }],
            }, 'it179');
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), tempWorkspace);
    });

    test('IT-176: 민감 내장값은 중간 결과·cwd·History 입력까지 전이되어 가려진다', async () => {
        const extensionRoot = path.resolve(__dirname, '..', '..');
        const secret = 'taskhub-sensitive-builtin-value';
        const recordCommands: Record<string, string> = Object.create(null);
        const recordInputs: Record<string, unknown> = Object.create(null);
        const collector = new ActionRunLogCollector('it176', 'IT-176', Date.now(), [
            { id: 'derive', type: 'stringManipulation' },
            { id: 'use', type: 'command' },
            { id: 'confirmValue', type: 'inputBox' },
        ]);
        const builtinVariables = buildBuiltinVariableContext({
            workspaceFolder: tempWorkspace,
            extensionPath: extensionRoot,
            editor: { selectedText: secret },
            environment: { TASKHUB_SECRET_CWD: tempWorkspace },
            strict: true,
        });
        const originalInput = vscode.window.showInputBox;
        (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => options.value;
        try {
            await executeActionPipeline({
                description: 'IT-176',
                tasks: [
                    { id: 'derive', type: 'stringManipulation', function: 'trim', input: '${selectedText}' },
                    {
                        id: 'use', type: 'command', command: 'node',
                        args: ['-e', 'process.stdout.write(process.argv[1])', '${derive.output}'],
                        cwd: '${env:TASKHUB_SECRET_CWD}', passTheResultToNextTask: true,
                    },
                    { id: 'confirmValue', type: 'inputBox', value: '${derive.output}' },
                ],
            }, { extensionPath: extensionRoot } as vscode.ExtensionContext,
            'it176', tempWorkspace, [tempWorkspace], {
                builtinVariables, recordCommands, recordInputs, runLogCollector: collector,
            });
        } finally {
            (vscode.window as any).showInputBox = originalInput;
        }

        assert.ok(!recordCommands.use.includes(secret), recordCommands.use);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(recordInputs, 'confirmValue'), false);
        const log = collector.finish('success', Date.now());
        const use = log.tasks.find(task => task.taskId === 'use')!;
        assert.strictEqual(use.cwd, '***');
        assert.strictEqual(use.output.availability, 'redacted');
        assert.ok(!JSON.stringify(log).includes(secret));
    });

    suite('Output Capture + Pipeline Chaining', () => {

        test('IT-001: shell capture → stringManipulation 체인 → 파일 쓰기', async () => {
            const resultPath = path.join(tempWorkspace, 'it001.txt');
            const action: PipelineAction = {
                description: 'IT-001',
                tasks: [
                    {
                        id: 'discover',
                        type: 'shell',
                        command: echoOneLine('artifact=firmware.bin'),
                        passTheResultToNextTask: true,
                        output: {
                            capture: {
                                name: 'artifact',
                                regex: 'artifact=(.+)',
                                group: 1,
                                trim: true
                            }
                        }
                    },
                    {
                        id: 'basename',
                        type: 'stringManipulation',
                        function: 'basenameWithoutExtension',
                        input: '${discover.artifact}',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'uppercase',
                        type: 'stringManipulation',
                        function: 'toUpperCase',
                        input: '${basename.output}',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'writeReport',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'artifact=${uppercase.output}\nsource=${discover.artifact}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'artifact=FIRMWARE\nsource=firmware.bin'
            );
        });

        test('IT-002: 여러 capture 규칙 (array)', async () => {
            const resultPath = path.join(tempWorkspace, 'it002.txt');
            const action: PipelineAction = {
                description: 'IT-002',
                tasks: [
                    {
                        id: 'info',
                        type: 'shell',
                        command: 'node',
                        args: nodeMultilineArgs([
                            'commit abc1234',
                            'Author:    Jane Doe   ',
                            'version 1.2.3'
                        ]),
                        passTheResultToNextTask: true,
                        output: {
                            capture: [
                                { name: 'sha', regex: 'commit ([a-f0-9]+)' },
                                { name: 'author', regex: 'Author:(.+)', trim: true },
                                { name: 'ver', regex: 'version (\\d+\\.\\d+\\.\\d+)' }
                            ]
                        }
                    },
                    {
                        id: 'report',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'sha=${info.sha};author=${info.author};ver=${info.ver}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'sha=abc1234;author=Jane Doe;ver=1.2.3'
            );
        });

        test('IT-003: line 인덱스 capture (음수 인덱스)', async () => {
            const resultPath = path.join(tempWorkspace, 'it003.txt');
            const action: PipelineAction = {
                description: 'IT-003',
                tasks: [
                    {
                        id: 'log',
                        type: 'shell',
                        command: 'node',
                        args: nodeMultilineArgs(['first', 'middle', 'tail-here']),
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'last', line: -1 } }
                    },
                    {
                        id: 'w',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'last=${log.last}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'last=tail-here');
        });

        test('IT-004: stringManipulation 출력에서 capture', async () => {
            const resultPath = path.join(tempWorkspace, 'it004.txt');
            const action: PipelineAction = {
                description: 'IT-004',
                tasks: [
                    {
                        id: 'norm',
                        type: 'stringManipulation',
                        function: 'toUpperCase',
                        input: 'version 1.2.3-rc',
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'ver', regex: 'VERSION (\\S+)' }
                        }
                    },
                    {
                        id: 'w',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'ver=${norm.ver}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'ver=1.2.3-RC');
        });

        test('IT-005: capture miss는 실행을 막지 않음', async () => {
            const resultPath = path.join(tempWorkspace, 'it005.txt');
            const action: PipelineAction = {
                description: 'IT-005',
                tasks: [
                    {
                        id: 'src',
                        type: 'shell',
                        command: echoOneLine('single-line-output'),
                        passTheResultToNextTask: true,
                        output: {
                            capture: [
                                { name: 'hit', regex: '(single)' },
                                { name: 'third', line: 5 } // miss — only 1 line exists
                            ]
                        }
                    },
                    {
                        id: 'w',
                        type: 'stringManipulation',
                        function: 'trim',
                        // **매칭에 실패한 capture 도 downstream 에서 참조한다.**
                        // 예전에는 miss 한 `third` 를 아무도 쓰지 않아서, 그것이
                        // 리터럴로 남는지 아니면 producer 의 stdout 전체로
                        // 조용히 치환되는지가 이 테스트로 드러나지 않았다.
                        // 문서(features.md 의 capture 실패 정책)가 약속하는 것은
                        // "미해결 placeholder 로 남음" 이다.
                        input: 'hit=${src.hit} miss=${src.third}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'hit=single miss=${src.third}',
                '매칭 실패한 capture 는 리터럴로 남아야 한다 (stdout 전체로 대체되면 안 된다)'
            );
        });

        test('IT-005b: capture miss가 shell 인자로 들어가도 stdout으로 치환되지 않는다', async () => {
            // 셸로 넘어가는 자리에서 특히 중요하다 — 정규식으로 좁힌 값을 받는다고
            // 믿는 자리에 검증되지 않은 출력 전체가 들어가면 안 된다.
            const resultPath = path.join(tempWorkspace, 'it005b.txt');
            const action: PipelineAction = {
                description: 'IT-005b',
                tasks: [
                    {
                        id: 'src',
                        type: 'shell',
                        command: echoOneLine('DANGEROUS-FULL-OUTPUT'),
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'safe', regex: 'v(\\d+)' } }   // miss
                    },
                    {
                        id: 'use',
                        type: 'command',
                        command: 'node',
                        args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', resultPath, '${src.safe}'],
                        passTheResultToNextTask: true
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                '${src.safe}',
                'capture 실패가 producer 의 stdout 전체로 대체됐다'
            );
        });

        test('IT-006: captured 값을 다음 태스크의 output.filePath에 사용', async () => {
            const action: PipelineAction = {
                description: 'IT-006',
                tasks: [
                    {
                        id: 'discover',
                        type: 'shell',
                        command: echoOneLine('name=report'),
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'baseName', regex: 'name=(\\S+)', trim: true }
                        }
                    },
                    {
                        id: 'w',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'content',
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'file',
                            filePath: path.join(tempWorkspace, '${discover.baseName}.txt'),
                            overwrite: true
                        }
                    }
                ]
            };
            await run(action);
            const expected = path.join(tempWorkspace, 'report.txt');
            assert.ok(fs.existsSync(expected), `expected ${expected} to exist`);
            assert.strictEqual(fs.readFileSync(expected, 'utf8'), 'content');
        });

        test('IT-007: 예약된 capture name은 실행 시 에러', async () => {
            const action: PipelineAction = {
                description: 'IT-007',
                tasks: [{
                    id: 't',
                    type: 'shell',
                    command: echoOneLine('x'),
                    passTheResultToNextTask: true,
                    output: { capture: { name: 'output' } }
                }]
            };
            await assert.rejects(
                () => run(action),
                /Task 't' capture failed: .*reserved/
            );
        });

        test('IT-008: 잘못된 정규식은 실행 시 에러', async () => {
            const action: PipelineAction = {
                description: 'IT-008',
                tasks: [{
                    id: 't',
                    type: 'shell',
                    command: echoOneLine('x'),
                    passTheResultToNextTask: true,
                    output: { capture: { name: 'v', regex: '(' } }
                }]
            };
            await assert.rejects(
                () => run(action),
                /Task 't' capture failed: Capture 'v' has invalid regex/
            );
        });
    });

    suite('Command Execution + Workspace Safety', () => {
        test('IT-009: command args/cwd/env interpolation이 함께 동작', async () => {
            const workDir = path.join(tempWorkspace, 'work dir');
            fs.mkdirSync(workDir);
            const resultPath = path.join(tempWorkspace, 'it009.txt');
            const action: PipelineAction = {
                description: 'IT-009',
                tasks: [
                    {
                        id: 'discover',
                        type: 'shell',
                        command: echoOneLine('target=release'),
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'target', regex: 'target=(\\S+)' } }
                    },
                    {
                        id: 'nodeTask',
                        type: 'shell',
                        command: 'node',
                        args: [
                            '-e',
                            "const path=require('path'); process.stdout.write([path.basename(process.cwd()), process.env.TASKHUB_TARGET, process.env.TASKHUB_FLAG].join('|'));"
                        ],
                        cwd: workDir,
                        env: {
                            TASKHUB_TARGET: '${discover.target}',
                            TASKHUB_FLAG: 'flag-${discover.target}'
                        },
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };

            await run(action);

            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'work dir|release|flag-release'
            );
        });

        test('IT-010: workspace 밖 file output은 거부', async () => {
            const outside = path.join(os.tmpdir(), `taskhub-outside-${process.pid}-${Date.now()}.txt`);
            const action: PipelineAction = {
                description: 'IT-010',
                tasks: [{
                    id: 'writeOutside',
                    type: 'stringManipulation',
                    function: 'trim',
                    input: 'nope',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: outside, overwrite: true }
                }]
            };

            await assert.rejects(
                () => run(action),
                /outside the current workspace/
            );
            assert.strictEqual(fs.existsSync(outside), false);
        });

        test('IT-011: 기존 파일은 overwrite 없이는 덮어쓰지 않음', async () => {
            const resultPath = path.join(tempWorkspace, 'existing.txt');
            fs.writeFileSync(resultPath, 'old');
            const action: PipelineAction = {
                description: 'IT-011',
                tasks: [{
                    id: 'writeExisting',
                    type: 'stringManipulation',
                    function: 'trim',
                    input: 'new',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: resultPath }
                }]
            };

            await assert.rejects(
                () => run(action),
                /attempted to write/
            );
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'old');
        });

        test('IT-012: overwrite 문자열 변수는 boolean으로 평가됨', async () => {
            const resultPath = path.join(tempWorkspace, 'overwrite.txt');
            fs.writeFileSync(resultPath, 'old');
            const action: PipelineAction = {
                description: 'IT-012',
                tasks: [
                    {
                        id: 'allow',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'TRUE',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'write',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'new',
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'file',
                            filePath: resultPath,
                            overwrite: '${allow.output}'
                        }
                    }
                ]
            };

            await run(action);

            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'new');
        });

        test('IT-013: 실패한 shell task는 downstream 실행을 중단', async () => {
            const markerPath = path.join(tempWorkspace, 'should-not-exist.txt');
            const action: PipelineAction = {
                description: 'IT-013',
                tasks: [
                    {
                        id: 'fail',
                        type: 'shell',
                        command: 'node',
                        args: ['-e', 'process.stderr.write("boom"); process.exit(7);'],
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'after',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'should not run',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: markerPath, overwrite: true }
                    }
                ]
            };

            await assert.rejects(
                () => run(action),
                /boom/
            );
            assert.strictEqual(fs.existsSync(markerPath), false);
        });

        test('IT-014: relative filePath는 workspace 기준으로 해석', async () => {
            const action: PipelineAction = {
                description: 'IT-014',
                tasks: [{
                    id: 'writeRelative',
                    type: 'stringManipulation',
                    function: 'trim',
                    input: 'relative-output',
                    passTheResultToNextTask: true,
                    output: {
                        mode: 'file',
                        filePath: path.join('nested', 'out.txt'),
                        overwrite: true
                    }
                }]
            };

            await run(action);

            assert.strictEqual(
                fs.readFileSync(path.join(tempWorkspace, 'nested', 'out.txt'), 'utf8'),
                'relative-output'
            );
        });
    });

    suite('Interactive Task Pipeline', () => {
        test('IT-015: quickPick 결과가 inputBox prefix/prompt와 downstream에 전달', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowInputBox = vscode.window.showInputBox;
            const resultPath = path.join(tempWorkspace, 'it015.txt');
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
                    return items.find(item => item.label === 'prod');
                };
                (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => {
                    assert.strictEqual(options.prompt, 'Deploy to prod');
                    return 'deploy';
                };

                const action: PipelineAction = {
                    description: 'IT-015',
                    tasks: [
                        {
                            id: 'env',
                            type: 'quickPick',
                            items: [
                                { label: 'dev', description: 'Development' },
                                { label: 'prod', description: 'Production' }
                            ]
                        },
                        {
                            id: 'target',
                            type: 'inputBox',
                            prompt: 'Deploy to ${env.value}',
                            prefix: '${env.value}:',
                            suffix: ':done'
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'target=${target.value}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                await run(action);

                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'target=prod:deploy:done');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-016: quickPick 다중 선택 value/values가 downstream에 전달', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const resultPath = path.join(tempWorkspace, 'it016.txt');
            try {
                (vscode.window as any).showQuickPick = async (
                    items: vscode.QuickPickItem[],
                    options: vscode.QuickPickOptions
                ) => {
                    assert.strictEqual(options.canPickMany, true);
                    return [items[0], items[2]];
                };

                const action: PipelineAction = {
                    description: 'IT-016',
                    tasks: [
                        {
                            id: 'features',
                            type: 'quickPick',
                            items: ['feature-a', 'feature-b', 'feature-c'],
                            canPickMany: true
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'first=${features.value};all=${features.values}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                await run(action);

                assert.strictEqual(
                    fs.readFileSync(resultPath, 'utf8'),
                    'first=feature-a;all=feature-a,feature-c'
                );
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });

        test('IT-171: quickPick default는 앞 task 값으로 정해지고 매핑 value가 전달된다', async () => {
            const resultPath = path.join(tempWorkspace, 'it171.txt');
            await withCreatedQuickPick((picker, controls) => {
                assert.strictEqual(picker.activeItems[0]?.label, 'Release');
                picker.selectedItems = [...picker.activeItems];
                controls.accept();
            }, () => run({
                description: 'IT-171',
                tasks: [
                    {
                        id: 'suggested', type: 'command', command: 'node',
                        args: ['-e', "process.stdout.write('Release')"],
                        passTheResultToNextTask: true,
                    },
                    {
                        id: 'mode', type: 'quickPick', default: '${suggested.output}',
                        items: [
                            { label: 'Debug', value: '--debug' },
                            { label: 'Release', value: '--release' },
                        ],
                    },
                    { id: 'save', type: 'writeFile', path: resultPath, content: '${mode.value}' },
                ],
            }, 'it171'));
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), '--release');
        });

        test('QuickPick 하나가 흐름 value와 command args를 동시에 전달한다', async () => {
            const script = path.join(tempWorkspace, 'quick-args.js');
            const resultPath = path.join(tempWorkspace, 'quick-args.json');
            fs.writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))');

            await withCreatedQuickPick((picker, controls) => {
                const folder = picker.items.find((item: any) => item.label === 'Folder');
                assert.ok(folder);
                picker.activeItems = [folder];
                picker.selectedItems = [folder];
                controls.accept();
            }, () => run({
                description: 'quickPick separate args',
                tasks: [
                    {
                        id: 'kind', type: 'quickPick',
                        default: 'Folder',
                        items: {
                            File: { value: 'file', args: '--input-file' },
                            Folder: { value: 'folder', args: ['--input-dir', '--recursive'] },
                        },
                    },
                    {
                        id: 'run', type: 'command', command: 'node',
                        args: [script, resultPath, '${kind.value}', '${kind.args}'],
                    },
                ],
            }, 'quick-args'));

            assert.deepStrictEqual(
                JSON.parse(fs.readFileSync(resultPath, 'utf8')),
                ['folder', '--input-dir', '--recursive']
            );
        });

        test('IT-172: quickPick 직접 입력값이 다음 command의 실제 argv로 전달된다', async () => {
            const script = path.join(tempWorkspace, 'it172-argv.js');
            const resultPath = path.join(tempWorkspace, 'it172.json');
            fs.writeFileSync(script, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))');

            await withCreatedQuickPick((picker, controls) => {
                controls.type('feature/new-flow');
                picker.selectedItems = [...picker.activeItems];
                controls.accept();
            }, () => run({
                description: 'IT-172',
                tasks: [
                    { id: 'branch', type: 'quickPick', allowCustom: true, items: ['main', 'develop'] },
                    {
                        id: 'run', type: 'command', command: 'node',
                        args: [script, resultPath, '${branch.value}'],
                    },
                ],
            }, 'it172'));

            assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), ['feature/new-flow']);
        });

        test('IT-108: quickPick itemsFromCommand populates list, itemsExclude filters, selection flows downstream', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const resultPath = path.join(tempWorkspace, 'it108.txt');
            // The command reads this file from the workspace cwd. The bare
            // `origin` line mimics how `git for-each-ref %(refname:short)`
            // shortens the symbolic refs/remotes/origin/HEAD — so itemsExclude
            // must drop both `origin` and `origin/HEAD` (array form).
            fs.writeFileSync(
                path.join(tempWorkspace, 'branches.txt'),
                'origin\norigin/main\norigin/dev\norigin/HEAD\n'
            );
            let seenItems: readonly vscode.QuickPickItem[] = [];
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
                    seenItems = items;
                    return items.find(i => i.label === 'origin/dev');
                };

                const action: PipelineAction = {
                    description: 'IT-108',
                    tasks: [
                        {
                            id: 'branch',
                            type: 'quickPick',
                            placeHolder: 'pick branch',
                            itemsFromCommand: {
                                macos: 'cat branches.txt',
                                linux: 'cat branches.txt',
                                windows: 'type branches.txt'
                            },
                            itemsExclude: ['origin', 'origin/HEAD']
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'branch=${branch.value}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                await run(action);

                const labels = seenItems.map(i => i.label);
                assert.deepStrictEqual(labels, ['origin/main', 'origin/dev'],
                    'itemsFromCommand lines become items and itemsExclude drops origin/HEAD');
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'branch=origin/dev');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });

        test('IT-179: jsonl itemsFromCommand의 표시 정보와 value·args가 실제 argv로 전달된다', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const choicesPath = path.join(tempWorkspace, 'targets.jsonl');
            const scriptPath = path.join(tempWorkspace, 'it179-argv.js');
            const resultPath = path.join(tempWorkspace, 'it179.json');
            fs.writeFileSync(choicesPath, [
                JSON.stringify({ id: 'skip', label: 'Skip me', value: '--skip' }),
                JSON.stringify({
                    id: 'release', label: 'Release build', description: 'optimized',
                    detail: 'deployment target', value: ['--mode', 'release'],
                    args: '--target=production',
                }),
            ].join('\n'));
            fs.writeFileSync(
                scriptPath,
                'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))'
            );
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
                    assert.deepStrictEqual(items.map(item => item.label), ['Release build']);
                    assert.strictEqual(items[0].description, 'optimized');
                    assert.strictEqual(items[0].detail, 'deployment target');
                    assert.strictEqual((items[0] as any).taskHubItemId, 'release');
                    return items[0];
                };
                await run({
                    description: 'IT-179',
                    tasks: [
                        {
                            id: 'target', type: 'quickPick',
                            itemsFromCommand: {
                                macos: 'cat targets.jsonl',
                                linux: 'cat targets.jsonl',
                                windows: 'type targets.jsonl',
                            },
                            itemsFromCommandFormat: 'jsonl',
                            itemsExclude: 'skip',
                            items: { Broken: 5 } as any,
                        },
                        {
                            id: 'run', type: 'command', command: 'node',
                            args: [scriptPath, resultPath, '${target}', '${target.args}'],
                        },
                    ],
                }, 'it179');
                assert.deepStrictEqual(
                    JSON.parse(fs.readFileSync(resultPath, 'utf8')),
                    ['--mode', 'release', '--target=production']
                );
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });

        test('IT-109: inputBox extractPattern prefills default and validatePattern guards input', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowInputBox = vscode.window.showInputBox;
            const resultPath = path.join(tempWorkspace, 'it109.txt');
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) =>
                    items.find(i => i.label === 'origin/feature/ABCTEST-123-foo');
                (vscode.window as any).showInputBox = async (options: vscode.InputBoxOptions) => {
                    // extractPattern pulled the Jira key out of the branch name.
                    assert.strictEqual(options.value, 'ABCTEST-123');
                    // validatePattern rejects malformed keys and accepts good ones.
                    assert.ok(options.validateInput, 'validateInput should be set');
                    assert.strictEqual(await options.validateInput!('ABCTEST-123'), undefined);
                    assert.ok(await options.validateInput!('not a ticket'),
                        'malformed ticket should return an error message');
                    return options.value;
                };

                const action: PipelineAction = {
                    description: 'IT-109',
                    tasks: [
                        {
                            id: 'branch',
                            type: 'quickPick',
                            items: ['origin/main', 'origin/feature/ABCTEST-123-foo']
                        },
                        {
                            id: 'ticket',
                            type: 'inputBox',
                            prompt: 'Jira ticket',
                            value: '${branch.value}',
                            extractPattern: '[A-Z][A-Z0-9]+-\\d+',
                            validatePattern: '^[A-Z][A-Z0-9]+-\\d+$',
                            validateMessage: 'bad ticket'
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'ticket=${ticket.value}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                await run(action);

                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'ticket=ABCTEST-123');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-033: envPick lists shell-accessible names and passes selection downstream', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalEnv = process.env.TASKHUB_ENVPICK_SENTINEL;
            const resultPath = path.join(tempWorkspace, 'it033.txt');
            try {
                process.env.TASKHUB_ENVPICK_SENTINEL = 'marker';
                process.env.VSCODE_TEST_EXTHOST_ONLY = 'should-be-filtered';
                // Stub the shell-env cache so the sentinel is treated as
                // shell-accessible. The VSCODE_*-prefixed var is intentionally
                // excluded to verify exthost-only names get filtered out.
                __testHook_resetShellEnvNamesCache(new Set([
                    'TASKHUB_ENVPICK_SENTINEL',
                    'PATH',
                    'HOME'
                ]));

                let seenItems: readonly vscode.QuickPickItem[] = [];
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
                    seenItems = items;
                    return items.find(i => i.label === 'TASKHUB_ENVPICK_SENTINEL');
                };

                const action: PipelineAction = {
                    description: 'IT-033',
                    tasks: [
                        { id: 'pick', type: 'envPick', placeHolder: 'pick one' },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'name=${pick.value}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                await run(action);

                assert.ok(seenItems.length > 0, 'envPick should present at least one env var');
                const labels = seenItems.map(i => i.label);
                assert.ok(labels.includes('TASKHUB_ENVPICK_SENTINEL'), 'sentinel var should appear');
                assert.ok(!labels.includes('VSCODE_TEST_EXTHOST_ONLY'),
                    'extension-host-only vars (not in shell env) must be filtered out');
                const sorted = [...labels].sort();
                assert.deepStrictEqual(labels, sorted, 'env names should be sorted');
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'name=TASKHUB_ENVPICK_SENTINEL');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                if (originalEnv === undefined) { delete process.env.TASKHUB_ENVPICK_SENTINEL; }
                else { process.env.TASKHUB_ENVPICK_SENTINEL = originalEnv; }
                delete process.env.VSCODE_TEST_EXTHOST_ONLY;
                __testHook_resetShellEnvNamesCache();
            }
        });

        test('IT-033b: envPick real probe filters extension-host-only vars (no stub)', async function () {
            // 실제 getShellAccessibleEnvNames() 를 호출해서, 확장 호스트의
            // process.env 에 들어 있는 VSCODE_*-prefixed leak marker 가
            // picker 에 노출되지 않는지 회귀 검증한다. spawn() 의 기본 env
            // 상속을 막지 않으면 marker 가 그대로 probe 셸로 새어 들어가
            // `env` 출력에 포함되고 필터를 통과하게 된다.
            this.timeout(15000);
            const originalShowQuickPick = vscode.window.showQuickPick;
            const leakName = 'VSCODE_TASKHUB_PROBE_LEAK_MARKER';
            const userVarName = 'TASKHUB_PROBE_USER_MARKER';
            const originalLeak = process.env[leakName];
            const originalUser = process.env[userVarName];
            try {
                process.env[leakName] = 'should-be-filtered';
                process.env[userVarName] = 'should-pass-through';
                __testHook_resetShellEnvNamesCache();   // force real probe

                let seenItems: readonly vscode.QuickPickItem[] = [];
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
                    seenItems = items;
                    // cancel — we only care about the items shown
                    return undefined;
                };

                const action: PipelineAction = {
                    description: 'IT-033b',
                    tasks: [{ id: 'pick', type: 'envPick' }]
                };

                await assert.rejects(() => run(action));

                const labels = seenItems.map(i => i.label);
                assert.ok(seenItems.length > 0, 'real probe should yield at least one env var');
                assert.ok(!labels.includes(leakName),
                    `VSCODE_*-prefixed leak marker must not appear in picker even when set in process.env (got: ${labels.filter(l => l.includes('TASKHUB_PROBE')).join(',') || '<none>'})`);
                // sanity — non-VSCODE-prefixed marker should be visible
                // (only when probe succeeded; if probe fell back to blocklist,
                // user-set vars in process.env still pass through since they're
                // not in the blocklist).
                assert.ok(labels.includes(userVarName),
                    'user-set non-blocked var should still appear in picker');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                if (originalLeak === undefined) { delete process.env[leakName]; }
                else { process.env[leakName] = originalLeak; }
                if (originalUser === undefined) { delete process.env[userVarName]; }
                else { process.env[userVarName] = originalUser; }
                __testHook_resetShellEnvNamesCache();
            }
        });

        test('IT-034: envPick cancellation aborts the pipeline', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const markerPath = path.join(tempWorkspace, 'envpick-should-not-run.txt');
            try {
                __testHook_resetShellEnvNamesCache(new Set(['PATH', 'HOME']));
                (vscode.window as any).showQuickPick = async () => undefined;

                const action: PipelineAction = {
                    description: 'IT-034',
                    tasks: [
                        { id: 'pick', type: 'envPick' },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'ran=true',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: markerPath, overwrite: true }
                        }
                    ]
                };

                await assert.rejects(() => run(action));
                assert.ok(!fs.existsSync(markerPath), 'downstream task must not run after cancellation');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                __testHook_resetShellEnvNamesCache();
            }
        });

        test('IT-017: confirm 취소는 pipeline을 중단', async () => {
            const originalShowWarningMessage = vscode.window.showWarningMessage;
            const markerPath = path.join(tempWorkspace, 'confirm-should-not-run.txt');
            try {
                (vscode.window as any).showWarningMessage = async () => 'No';

                const action: PipelineAction = {
                    description: 'IT-017',
                    tasks: [
                        {
                            id: 'confirm',
                            type: 'confirm',
                            message: 'Continue?',
                            confirmLabel: 'Proceed',
                            cancelLabel: 'No'
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'confirmed=${confirm.confirmed}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: markerPath, overwrite: true }
                        }
                    ]
                };

                await assert.rejects(
                    () => run(action),
                    /canceled/
                );
                assert.strictEqual(fs.existsSync(markerPath), false);
            } finally {
                (vscode.window as any).showWarningMessage = originalShowWarningMessage;
            }
        });
    });

    suite('조건부 태스크 (when)', () => {

        /**
         * 요청받은 그림 그대로: quickPick 으로 파일/폴더를 고르게 하고, 고른 쪽
         * 다이얼로그만 띄운 뒤, **하나의 소비자**가 어느 쪽 결과든 받는다.
         */
        async function runBranching(choice: '파일' | '폴더') {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const pickedFile = path.join(tempWorkspace, 'firmware.hex');
            const pickedFolder = path.join(tempWorkspace, 'artifacts');
            fs.writeFileSync(pickedFile, 'x');
            fs.mkdirSync(pickedFolder, { recursive: true });
            const outPath = path.join(tempWorkspace, 'chosen.txt');
            /** 어떤 다이얼로그가 실제로 떴는지 — 꺼진 분기는 뜨면 안 된다. */
            const opened: string[] = [];
            try {
                (vscode.window as any).showQuickPick = async () => ({ label: choice });
                (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                    if (options.canSelectFolders) {
                        opened.push('folder');
                        return [vscode.Uri.file(pickedFolder)];
                    }
                    opened.push('file');
                    return [vscode.Uri.file(pickedFile)];
                };
                await run({
                    description: 'when-branching',
                    tasks: [
                        { id: 'kind', type: 'quickPick', items: ['파일', '폴더'] },
                        {
                            id: 'pickFile', type: 'fileDialog',
                            when: { var: '${kind.value}', equals: '파일' }
                        },
                        {
                            id: 'pickFolder', type: 'folderDialog',
                            options: { canSelectFolders: true, canSelectFiles: false },
                            when: { var: '${kind.value}', equals: '폴더' }
                        },
                        {
                            id: 'write', type: 'writeFile',
                            path: outPath,
                            content: '${pickFile.path ?? pickFolder.path}'
                        }
                    ]
                });
                return { opened, written: fs.readFileSync(outPath, 'utf8') };
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        }

        test('파일을 고르면 파일 다이얼로그만 뜨고 그 경로가 넘어간다', async () => {
            const { opened, written } = await runBranching('파일');
            assert.deepStrictEqual(opened, ['file'], '꺼진 분기의 다이얼로그가 떴다');
            assert.strictEqual(
                normalizeWindowsPathForAssert(written),
                normalizeWindowsPathForAssert(path.join(tempWorkspace, 'firmware.hex'))
            );
        });

        test('폴더를 고르면 폴더 다이얼로그만 뜨고 그 경로가 넘어간다', async () => {
            const { opened, written } = await runBranching('폴더');
            assert.deepStrictEqual(opened, ['folder'], '꺼진 분기의 다이얼로그가 떴다');
            assert.strictEqual(
                normalizeWindowsPathForAssert(written),
                normalizeWindowsPathForAssert(path.join(tempWorkspace, 'artifacts'))
            );
        });

        test('IT-180: pathDialog는 QuickPick mode 하나로 파일/폴더 분기를 합친다', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const pickedFile = path.join(tempWorkspace, 'unified.hex');
            const pickedFolder = path.join(tempWorkspace, 'unified-out');
            fs.writeFileSync(pickedFile, 'x');
            fs.mkdirSync(pickedFolder, { recursive: true });
            try {
                for (const scenario of [
                    { label: '파일', mode: 'file', picked: pickedFile },
                    { label: '폴더', mode: 'folder', picked: pickedFolder },
                ]) {
                    const outPath = path.join(tempWorkspace, `unified-${scenario.mode}.txt`);
                    (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) =>
                        items.find(item => item.label === scenario.label);
                    (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                        assert.strictEqual(options.canSelectFiles, scenario.mode === 'file');
                        assert.strictEqual(options.canSelectFolders, scenario.mode === 'folder');
                        return [vscode.Uri.file(scenario.picked)];
                    };
                    await run({
                        description: 'pathDialog-branching',
                        tasks: [
                            {
                                id: 'kind', type: 'quickPick', items: [
                                    { label: '파일', value: 'file' },
                                    { label: '폴더', value: 'folder' },
                                ],
                            },
                            { id: 'target', type: 'pathDialog', mode: '${kind}' },
                            { id: 'write', type: 'writeFile', path: outPath, content: '${target.path}' },
                        ],
                    }, `it180-${scenario.mode}`);
                    assert.strictEqual(
                        normalizeWindowsPathForAssert(fs.readFileSync(outPath, 'utf8')),
                        normalizeWindowsPathForAssert(scenario.picked)
                    );
                }
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        /**
         * 꺼진 분기를 **평범하게** 참조하는 소비자는 함께 꺼진다.
         *
         * 그러지 않으면 미해결 리터럴 `"${pickFile.path}"` 가 그대로 경로가 되어
         * 워크스페이스에 그런 이름의 파일이 생긴다.
         */
        test('꺼진 태스크를 평범하게 참조하는 소비자는 함께 꺼진다', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const outPath = path.join(tempWorkspace, 'never.txt');
            try {
                (vscode.window as any).showQuickPick = async () => ({ label: '폴더' });
                (vscode.window as any).showOpenDialog = async () => [vscode.Uri.file(tempWorkspace)];
                await run({
                    description: 'when-propagation',
                    tasks: [
                        { id: 'kind', type: 'quickPick', items: ['파일', '폴더'] },
                        { id: 'pickFile', type: 'fileDialog', when: { var: '${kind.value}', equals: '파일' } },
                        { id: 'write', type: 'writeFile', path: outPath, content: '${pickFile.path}' }
                    ]
                });
                assert.ok(!fs.existsSync(outPath), '꺼진 분기의 소비자가 실행됐다');
                const literal = path.join(tempWorkspace, '${pickFile.path}');
                assert.ok(!fs.existsSync(literal), '미해결 리터럴이 경로로 쓰였다');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('조건이 참이면 평소대로 실행된다 (가드가 과하지 않다)', async () => {
            const outPath = path.join(tempWorkspace, 'ran.txt');
            await run({
                description: 'when-true',
                tasks: [
                    { id: 'seed', type: 'stringManipulation', function: 'trim', input: '  go  ' },
                    {
                        id: 'write', type: 'writeFile', path: outPath, content: 'ok',
                        when: { var: '${seed.output}', equals: 'go' }
                    }
                ]
            });
            assert.strictEqual(fs.readFileSync(outPath, 'utf8'), 'ok');
        });
    });

    suite('Dialog + Output Mode Pipeline', () => {
        test('IT-018: fileDialog → folderDialog → stringManipulation → 파일 쓰기', async () => {
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const sourceDir = path.join(tempWorkspace, 'src');
            const outputDir = path.join(tempWorkspace, 'artifacts');
            const pickedFile = path.join(sourceDir, 'firmware.hex');
            fs.mkdirSync(sourceDir, { recursive: true });
            fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(pickedFile, ':00000001FF\n');

            try {
                (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                    if (options.canSelectFolders) {
                        assert.strictEqual(options.canSelectFiles, false);
                        assert.strictEqual(options.title, 'Pick output folder');
                        return [vscode.Uri.file(outputDir)];
                    }
                    assert.strictEqual(options.openLabel, 'Pick HEX');
                    return [vscode.Uri.file(pickedFile)];
                };

                const action: PipelineAction = {
                    description: 'IT-018',
                    tasks: [
                        {
                            id: 'file',
                            type: 'fileDialog',
                            options: {
                                canSelectFiles: true,
                                openLabel: 'Pick HEX'
                            }
                        },
                        {
                            id: 'folder',
                            type: 'folderDialog',
                            options: {
                                title: 'Pick output folder'
                            }
                        },
                        {
                            id: 'base',
                            type: 'stringManipulation',
                            function: 'basenameWithoutExtension',
                            input: '${file.name}',
                            passTheResultToNextTask: true
                        },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: [
                                'base=${base.output}',
                                'fileNameOnly=${file.fileNameOnly}',
                                'ext=${file.fileExt}',
                                'fileDir=${file.dir}',
                                'folder=${folder.path}'
                            ].join('\n'),
                            passTheResultToNextTask: true,
                            output: {
                                mode: 'file',
                                filePath: path.join('dialog', 'selection.txt'),
                                overwrite: true
                            }
                        }
                    ]
                };

                await run(action);

                assert.strictEqual(
                    normalizeWindowsPathForAssert(fs.readFileSync(path.join(tempWorkspace, 'dialog', 'selection.txt'), 'utf8')),
                    normalizeWindowsPathForAssert([
                        'base=firmware',
                        'fileNameOnly=firmware',
                        'ext=hex',
                        `fileDir=${sourceDir}`,
                        `folder=${outputDir}`
                    ].join('\n'))
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-019: editor output mode는 language와 content interpolation을 적용', async () => {
            const action: PipelineAction = {
                description: 'IT-019',
                tasks: [
                    {
                        id: 'raw',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: '  alpha  ',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'render',
                        type: 'stringManipulation',
                        function: 'toUpperCase',
                        input: '${raw.output}',
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'editor',
                            language: 'markdown',
                            content: '# ${raw.output}'
                        }
                    }
                ]
            };

            await run(action);

            const activeEditor = vscode.window.activeTextEditor;
            assert.ok(activeEditor, 'expected output editor to be opened');
            assert.strictEqual(activeEditor.document.getText(), '# alpha');
            assert.strictEqual(activeEditor.document.languageId, 'markdown');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        });

        test('IT-020: command task의 platform command와 output.content override가 함께 동작', async () => {
            const resultPath = path.join(tempWorkspace, 'it020.txt');
            const action: PipelineAction = {
                description: 'IT-020',
                tasks: [
                    {
                        id: 'seed',
                        type: 'shell',
                        command: echoOneLine('release=R1'),
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'release', regex: 'release=(\\S+)' }
                        }
                    },
                    {
                        id: 'cmd',
                        type: 'command',
                        command: {
                            windows: 'node',
                            macos: 'node',
                            linux: 'node'
                        },
                        args: ['-e', 'process.stdout.write("stdout-that-should-not-be-written");'],
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'file',
                            filePath: resultPath,
                            content: 'release=${seed.release};raw=${seed.output}',
                            overwrite: true
                        }
                    }
                ]
            };

            await run(action);

            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'release=R1;raw=release=R1'
            );
        });
    });

    suite('Archive Task Pipeline', () => {
        /**
         * Write a fake 7z-compatible launcher that understands only the
         * argument shapes our pipeline emits (`a <archive> <sources...>` and
         * `x <archive> -o<destDir> -aoa`). The tool serializes a JSON manifest
         * as the "archive" and round-trips it on extraction, so tests can
         * assert end-to-end wiring without depending on a real 7z binary.
         */
        function writeFake7zLauncher(dir: string): string {
            const jsPath = path.join(dir, 'fake7z.js');
            fs.writeFileSync(jsPath, `const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const cmd = argv[0];
try {
    if (cmd === 'a') {
        const archive = argv[1];
        const sources = argv.slice(2);
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        fs.writeFileSync(archive, JSON.stringify({ kind: 'fake7z-archive', sources: sources }));
        process.stdout.write('archived ' + sources.length + ' sources');
    } else if (cmd === 'x') {
        const archive = argv[1];
        const outArg = argv[2] || '';
        const outDir = outArg.startsWith('-o') ? outArg.slice(2) : outArg;
        const manifest = JSON.parse(fs.readFileSync(archive, 'utf8'));
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        process.stdout.write('extracted to ' + outDir);
    } else {
        process.stderr.write('unknown command: ' + cmd);
        process.exit(2);
    }
} catch (e) {
    process.stderr.write(String(e && e.message || e));
    process.exit(3);
}
`);
            if (process.platform === 'win32') {
                const launcher = path.join(dir, 'fake7z.cmd');
                fs.writeFileSync(launcher, `@echo off\r\nnode "${jsPath}" %*\r\n`);
                return launcher;
            }
            const launcher = path.join(dir, 'fake7z.sh');
            fs.writeFileSync(launcher, `#!/bin/sh\nexec node "${jsPath}" "$@"\n`);
            fs.chmodSync(launcher, 0o755);
            return launcher;
        }

        test('IT-024: zip → unzip 왕복으로 source manifest가 복원됨', async () => {
            const launcher = writeFake7zLauncher(tempWorkspace);
            const archivePath = path.join(tempWorkspace, 'artifacts', 'bundle.fake7z');
            const extractDir = path.join(tempWorkspace, 'extracted');
            const srcA = path.join(tempWorkspace, 'a.txt');
            const srcB = path.join(tempWorkspace, 'b.txt');
            fs.writeFileSync(srcA, 'alpha');
            fs.writeFileSync(srcB, 'beta');

            const action: PipelineAction = {
                description: 'IT-024',
                tasks: [
                    {
                        id: 'pack',
                        type: 'zip',
                        tool: launcher,
                        archive: archivePath,
                        source: [srcA, srcB]
                    },
                    {
                        id: 'unpack',
                        type: 'unzip',
                        tool: launcher,
                        archive: archivePath,
                        destination: extractDir
                    }
                ]
            };

            await run(action);

            assert.ok(fs.existsSync(archivePath), 'archive should be written');
            const archiveJson = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
            assert.strictEqual(archiveJson.kind, 'fake7z-archive');
            assert.deepStrictEqual(archiveJson.sources, [srcA, srcB]);

            const manifestPath = path.join(extractDir, 'manifest.json');
            assert.ok(fs.existsSync(manifestPath), 'manifest should be extracted');
            const extracted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.deepStrictEqual(extracted.sources, [srcA, srcB]);
        });

        test('IT-153: OS별 tool 객체가 현재 플랫폼 branch 로 보간되어 실행된다', async () => {
            // 실행 경로 전체를 탄다: executeSingleTask 가 `interpolateToolValue` 로
            // **현재 플랫폼 branch 를 고르고 보간** → handleZip/handleUnzip 의
            // `getToolCommand` 가 그것을 실행. 지금까지 이 연결은 소스 정규식으로만
            // 고정돼 있어서, 보간 결과를 버리고 원본을 넘겨도 통과했다.
            const launcher = writeFake7zLauncher(tempWorkspace);
            const activeKey = process.platform === 'win32' ? 'windows'
                : process.platform === 'darwin' ? 'macos' : 'linux';
            const inactiveKey = activeKey === 'windows' ? 'macos' : 'windows';
            // 활성 branch 는 보간이 필요한 값, 비활성 branch 는 해석되지 않는 참조.
            // 후자가 실행에 영향을 주면 이 액션은 돌지 않는다.
            const tool: Record<string, string> = {
                [activeKey]: '${workspaceFolder}/' + path.basename(launcher),
                [inactiveKey]: '${ghost.output}',
            };
            const archivePath = path.join(tempWorkspace, 'os-tool.fake7z');
            const extractDir = path.join(tempWorkspace, 'os-tool-extracted');
            const srcA = path.join(tempWorkspace, 'os-a.txt');
            fs.writeFileSync(srcA, 'alpha');

            const action: PipelineAction = {
                description: 'IT-153',
                tasks: [
                    { id: 'pack', type: 'zip', tool, archive: archivePath, source: [srcA] },
                    { id: 'unpack', type: 'unzip', tool, archive: archivePath, destination: extractDir },
                ]
            };

            await run(action);

            assert.ok(
                fs.existsSync(archivePath),
                'OS별 tool 이 보간되지 않았다 — ${workspaceFolder} 가 리터럴로 실행에 들어갔다'
            );
            const extracted = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8'));
            assert.deepStrictEqual(extracted.sources, [srcA]);
        });

        test('IT-144: 외부 tool 경로도 해석된 절대 경로를 downstream 에 넘긴다', async () => {
            // 자식 프로세스는 자기 cwd 로 상대 경로를 풀지만, 우리가
            // `${pack.archivePath}` 로 넘겨주는 값이 상대 경로로 남으면 그것을
            // 받은 다음 태스크가 자기 기준으로 다시 푼다 — `tool` 만 지우면
            // 통과하고 붙이면 `Archive not found` 로 실패하는 상태였다.
            const launcher = writeFake7zLauncher(tempWorkspace);
            const base = path.join(tempWorkspace, 'build');
            fs.mkdirSync(base, { recursive: true });
            const srcA = path.join(tempWorkspace, 'a.txt');
            fs.writeFileSync(srcA, 'alpha');

            const action: PipelineAction = {
                description: 'IT-144',
                tasks: [
                    { id: 'pack', type: 'zip', tool: launcher, cwd: base, archive: 'bundle.fake7z', source: [srcA] },
                    { id: 'unpack', type: 'unzip', tool: launcher, archive: '${pack.archivePath}', destination: path.join(tempWorkspace, 'extracted') },
                ]
            };

            await run(action);

            assert.ok(
                fs.existsSync(path.join(base, 'bundle.fake7z')),
                'tool 이 cwd 기준으로 아카이브를 만들지 않았다'
            );
            assert.ok(
                fs.existsSync(path.join(tempWorkspace, 'extracted', 'manifest.json')),
                'archivePath 가 상대 경로로 새어 나가 downstream 이 다른 파일을 가리켰다'
            );
        });

        test('IT-142: 내장 엔진의 상대 archive 경로가 워크스페이스 기준으로 풀린다', async () => {
            // 0.6.52 이전에는 `path.resolve` 가 extension host 의 `process.cwd()`
            // (= VS Code 를 띄운 위치)를 기준으로 삼아, 아카이브가 워크스페이스가
            // 아니라 엉뚱한 곳에 생겼다. 외부 tool 경로는 자식 프로세스의 cwd 를
            // 쓰므로 **같은 태스크가 `tool` 하나로 다른 위치에 파일을 만들었다.**
            const srcDir = path.join(tempWorkspace, 'src');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'a.txt'), 'alpha');

            const action: PipelineAction = {
                description: 'IT-142',
                tasks: [
                    { id: 'pack', type: 'zip', archive: 'out/bundle.zip', source: [srcDir] },
                    // 앞 태스크가 돌려준 경로를 그대로 받는다 — 상대 경로가 새어
                    // 나가면 여기서 자기 기준으로 다시 풀려 다른 파일을 가리킨다.
                    { id: 'unpack', type: 'unzip', archive: '${pack.archivePath}', destination: 'out/extracted' },
                ]
            };

            await run(action);

            assert.ok(
                fs.existsSync(path.join(tempWorkspace, 'out', 'bundle.zip')),
                '상대 archive 경로가 워크스페이스 기준으로 풀리지 않았다'
            );
            assert.ok(
                fs.existsSync(path.join(tempWorkspace, 'out', 'extracted', 'src', 'a.txt')),
                '상대 destination 경로가 워크스페이스 기준으로 풀리지 않았거나 archivePath 가 상대 경로로 새어 나갔다'
            );
        });

        test('IT-143: 내장 엔진이 task.cwd 를 상대 경로의 기준으로 쓴다', async () => {
            // 스키마의 `cwd` 설명("Defaults to ${workspaceFolder}")과 맞춘다.
            // `unzip` 은 0.6.52 이전에 `cwd` 를 아예 무시해, 같은 설정이 zip 에서만
            // 듣는 비대칭이 있었다.
            const base = path.join(tempWorkspace, 'build');
            const srcDir = path.join(base, 'src');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'a.txt'), 'alpha');

            const action: PipelineAction = {
                description: 'IT-143',
                tasks: [
                    { id: 'pack', type: 'zip', cwd: base, archive: 'bundle.zip', source: ['src'] },
                    { id: 'unpack', type: 'unzip', cwd: base, archive: 'bundle.zip', destination: 'extracted' },
                ]
            };

            await run(action);

            assert.ok(fs.existsSync(path.join(base, 'bundle.zip')), 'zip 이 cwd 를 기준으로 쓰지 않았다');
            assert.ok(
                fs.existsSync(path.join(base, 'extracted', 'src', 'a.txt')),
                'unzip 이 cwd 를 무시했다 — zip 과 비대칭이면 같은 설정이 한쪽에서만 듣는다'
            );
        });

        test('IT-146: 외부 tool unzip 도 task.cwd 를 쓴다', async () => {
            // `unzip` 은 0.6.52 이전에 `cwd` 를 아예 무시했다. 내장 엔진만
            // 고치면 같은 설정이 `tool` 유무로 다르게 듣는 비대칭이 남는다.
            const launcher = writeFake7zLauncher(tempWorkspace);
            const base = path.join(tempWorkspace, 'build');
            fs.mkdirSync(base, { recursive: true });
            const srcA = path.join(tempWorkspace, 'a.txt');
            fs.writeFileSync(srcA, 'alpha');

            const action: PipelineAction = {
                description: 'IT-146',
                tasks: [
                    { id: 'pack', type: 'zip', tool: launcher, cwd: base, archive: 'bundle.fake7z', source: [srcA] },
                    { id: 'unpack', type: 'unzip', tool: launcher, cwd: base, archive: 'bundle.fake7z', destination: 'extracted' },
                ]
            };

            await run(action);

            assert.ok(
                fs.existsSync(path.join(base, 'extracted', 'manifest.json')),
                '외부 tool unzip 이 cwd 를 무시했다 — 상대 archive/destination 이 워크스페이스 루트로 풀렸다'
            );
        });

        test('IT-154: zip 의 ${extensionPath} 가 런타임에서도 해석된다', async () => {
            // `handleZip` 은 자기 보간 컨텍스트를 만드는데 거기에 `extensionPath`
            // 가 없어 `${extensionPath}` 가 **리터럴로 남았다** — Preview 와
            // Doctor 는 둘 다 해석하므로 진단만 정상이라고 말하는 자리였다.
            // `tool` 은 `executeSingleTask` 가 미리 보간해 넘기므로 해석됐고,
            // 그래서 같은 태스크 안에서 필드마다 규칙이 갈려 있었다.
            const action: PipelineAction = {
                description: 'IT-154',
                tasks: [
                    { id: 'pack', type: 'zip', archive: 'out/ext.zip', source: ['${extensionPath}/package.json'] },
                    { id: 'unpack', type: 'unzip', archive: '${pack.archivePath}', destination: 'out/extracted' },
                ]
            };

            await run(action);

            assert.ok(
                fs.existsSync(path.join(tempWorkspace, 'out', 'extracted', 'package.json')),
                '${extensionPath} 가 source 에서 해석되지 않았다 — 리터럴 경로를 압축하려 했다'
            );
        });

        test('IT-025: 빌트인 엔진은 .zip이 아닌 아카이브를 거부', async () => {
            const action: PipelineAction = {
                description: 'IT-025',
                tasks: [
                    {
                        id: 'pack',
                        type: 'zip',
                        archive: path.join(tempWorkspace, 'nope.7z'),
                        source: [path.join(tempWorkspace, 'missing.txt')]
                    }
                ]
            };

            await assert.rejects(
                () => run(action),
                /Built-in engine only supports \.zip archives/
            );
        });

        test('IT-035: 빌트인 zip → 빌트인 unzip 왕복', async () => {
            const archivePath = path.join(tempWorkspace, 'out', 'bundle.zip');
            const extractDir = path.join(tempWorkspace, 'extracted');
            const srcA = path.join(tempWorkspace, 'a.txt');
            const srcB = path.join(tempWorkspace, 'b.txt');
            fs.writeFileSync(srcA, 'alpha-content');
            fs.writeFileSync(srcB, 'beta-content');

            const action: PipelineAction = {
                description: 'IT-035',
                tasks: [
                    {
                        id: 'pack',
                        type: 'zip',
                        archive: archivePath,
                        source: [srcA, srcB]
                    },
                    {
                        id: 'unpack',
                        type: 'unzip',
                        archive: archivePath,
                        destination: extractDir
                    }
                ]
            };

            await run(action);

            assert.ok(fs.existsSync(archivePath), 'archive should be written');
            assert.strictEqual(
                fs.readFileSync(path.join(extractDir, 'a.txt'), 'utf8'),
                'alpha-content'
            );
            assert.strictEqual(
                fs.readFileSync(path.join(extractDir, 'b.txt'), 'utf8'),
                'beta-content'
            );
        });

        test('IT-036: 빌트인 zip에 디렉터리 source가 재귀적으로 포함됨', async () => {
            const archivePath = path.join(tempWorkspace, 'pkg.zip');
            const extractDir = path.join(tempWorkspace, 'out');
            const srcDir = path.join(tempWorkspace, 'src');
            const nested = path.join(srcDir, 'sub');
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'root.txt'), 'root');
            fs.writeFileSync(path.join(nested, 'leaf.txt'), 'leaf');

            const action: PipelineAction = {
                description: 'IT-036',
                tasks: [
                    { id: 'pack', type: 'zip', archive: archivePath, source: [srcDir] },
                    { id: 'unpack', type: 'unzip', archive: archivePath, destination: extractDir }
                ]
            };

            await run(action);

            assert.strictEqual(fs.readFileSync(path.join(extractDir, 'src', 'root.txt'), 'utf8'), 'root');
            assert.strictEqual(fs.readFileSync(path.join(extractDir, 'src', 'sub', 'leaf.txt'), 'utf8'), 'leaf');
        });

        test('IT-037: 빌트인 unzip은 zip-slip 경로 탈출을 차단', async () => {
            const AdmZip = require('adm-zip');
            const archivePath = path.join(tempWorkspace, 'evil.zip');
            const zip = new AdmZip();
            // `addFile('../outside.txt', ...)` is sanitized by adm-zip at add time,
            // so we add a normal entry and then rewrite its stored name to an
            // escape path — this is how real attackers craft zip-slip archives.
            zip.addFile('placeholder.txt', Buffer.from('malicious payload'));
            zip.getEntries()[0].entryName = '../outside.txt';
            zip.writeZip(archivePath);

            const extractDir = path.join(tempWorkspace, 'extract');
            const action: PipelineAction = {
                description: 'IT-037',
                tasks: [
                    {
                        id: 'unpack',
                        type: 'unzip',
                        archive: archivePath,
                        destination: extractDir
                    }
                ]
            };

            await assert.rejects(
                () => run(action),
                /Blocked path traversal/
            );

            // Confirm the escape target was not written outside the destination.
            assert.strictEqual(
                fs.existsSync(path.join(tempWorkspace, 'outside.txt')),
                false,
                'entry outside destination must not be created'
            );
        });

        test('IT-038: 빌트인 엔진으로 pipeline 변수 치환이 적용됨', async () => {
            const srcDir = path.join(tempWorkspace, 'payload');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'note.txt'), 'hello');

            const action: PipelineAction = {
                description: 'IT-038',
                tasks: [
                    {
                        id: 'name',
                        type: 'stringManipulation',
                        function: 'toLowerCase',
                        input: 'BUNDLE',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'pack',
                        type: 'zip',
                        archive: '${workspaceFolder}/${name.output}.zip',
                        source: [srcDir]
                    }
                ]
            };

            await run(action);

            const expected = path.join(tempWorkspace, 'bundle.zip');
            assert.ok(fs.existsSync(expected), `expected archive at ${expected}`);
        });
    });

    suite('Terminal Output Mode', () => {
        test('IT-026: terminal mode는 터미널을 만들고 같은 actionId에서 재사용', async () => {
            const originalCreateTerminal = vscode.window.createTerminal;
            let createCount = 0;
            const capturedText: string[] = [];
            const fakeTerminal = {
                name: 'fake',
                exitStatus: undefined,
                show: () => { /* no-op */ },
                dispose: () => { /* no-op */ }
            } as unknown as vscode.Terminal;
            (vscode.window as any).createTerminal = (options: vscode.ExtensionTerminalOptions) => {
                createCount += 1;
                // M1 회귀 가드: output.mode 'terminal'은 셸 없는 읽기 전용
                // Pseudoterminal로 열려야 한다. 실제 셸 터미널에 sendText로
                // 본문을 보내면 개행이 Enter로 해석되어 임의 라인이 실행된다.
                assert.ok(
                    options && typeof options === 'object' && 'pty' in options,
                    'output terminal must be created with a pseudoterminal (no shell)'
                );
                options.pty.onDidWrite!((text: string) => capturedText.push(text));
                options.pty.open(undefined);
                return fakeTerminal;
            };
            // Unique id keeps us isolated from the module-level actionTerminals cache.
            const actionId = `it026-${process.pid}-${Date.now()}`;
            try {
                const action: PipelineAction = {
                    description: 'IT-026',
                    tasks: [
                        {
                            id: 'seed',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'release=R9',
                            passTheResultToNextTask: true,
                            output: { capture: { name: 'release', regex: 'release=(\\S+)' } }
                        },
                        {
                            id: 'firstPrint',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'raw-one',
                            passTheResultToNextTask: true,
                            output: { mode: 'terminal', content: 'release=${seed.release}' }
                        },
                        {
                            id: 'secondPrint',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'raw-two',
                            passTheResultToNextTask: true,
                            output: { mode: 'terminal', content: 'again=${seed.release}' }
                        }
                    ]
                };
                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    actionId,
                    tempWorkspace,
                    [tempWorkspace]
                );

                assert.strictEqual(createCount, 1, 'terminal should be created once and reused');
                // Each terminal output writes a header line followed by the content line.
                assert.strictEqual(capturedText.length, 4);
                assert.ok(capturedText[0].includes('firstPrint'));
                assert.strictEqual(capturedText[1], 'release=R9');
                assert.ok(capturedText[2].includes('secondPrint'));
                assert.strictEqual(capturedText[3], 'again=R9');
            } finally {
                (vscode.window as any).createTerminal = originalCreateTerminal;
            }
        });
    });

    suite('Action Lifecycle Messaging', () => {
        function makeFakeContext(): vscode.ExtensionContext {
            const workspaceState = new Map<string, unknown>();
            return {
                extensionPath: path.resolve(__dirname, '..', '..'),
                subscriptions: [],
                workspaceState: {
                    get: <T>(key: string, def?: T) =>
                        workspaceState.has(key) ? (workspaceState.get(key) as T) : def,
                    update: (key: string, val: unknown) => {
                        workspaceState.set(key, val);
                        return Promise.resolve();
                    },
                    keys: () => Array.from(workspaceState.keys())
                },
                globalState: {
                    get: <T>(_k: string, d?: T) => d,
                    update: () => Promise.resolve(),
                    keys: () => [],
                    setKeysForSync: () => { /* no-op */ }
                },
                extensionMode: vscode.ExtensionMode.Test,
                extension: { packageJSON: { version: '9.9.9-test' } }
            } as unknown as vscode.ExtensionContext;
        }

        test('IT-027: 성공 경로에서 successMessage와 history success 기록', async () => {
            const originalShowInfo = vscode.window.showInformationMessage;
            const shownInfo: string[] = [];
            (vscode.window as any).showInformationMessage = async (msg: string) => {
                shownInfo.push(msg);
                return undefined;
            };
            try {
                const context = makeFakeContext();
                const actionItem: ActionItem = {
                    id: 'it027',
                    title: 'IT-027 Lifecycle Success',
                    action: {
                        description: 'IT-027',
                        successMessage: 'Build completed',
                        tasks: [
                            {
                                id: 'stamp',
                                type: 'stringManipulation',
                                function: 'trim',
                                input: 'done'
                            }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await executeAction(actionItem, context, mainView, history);

                assert.ok(
                    shownInfo.includes('Build completed'),
                    `expected 'Build completed' among ${JSON.stringify(shownInfo)}`
                );
                const entries: HistoryEntry[] = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(entries[0].actionId, 'it027');
                assert.strictEqual(entries[0].status, 'success');
                assert.strictEqual(actionStates.get('it027')?.state, 'success');
            } finally {
                (vscode.window as any).showInformationMessage = originalShowInfo;
            }
        });

        test('IT-028: 실패 경로에서 failMessage와 history failure 기록', async () => {
            const originalShowError = vscode.window.showErrorMessage;
            const shownErrors: string[] = [];
            (vscode.window as any).showErrorMessage = async (msg: string) => {
                shownErrors.push(msg);
                return undefined;
            };
            try {
                const context = makeFakeContext();
                const actionItem: ActionItem = {
                    id: 'it028',
                    title: 'IT-028 Lifecycle Failure',
                    action: {
                        description: 'IT-028',
                        failMessage: 'Build broken',
                        tasks: [
                            {
                                id: 'boom',
                                type: 'stringManipulation',
                                function: 'trim',
                                input: 'x',
                                passTheResultToNextTask: true,
                                output: {
                                    capture: { name: 'v', regex: '(' }
                                }
                            }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await assert.rejects(
                    () => executeAction(actionItem, context, mainView, history),
                    /capture failed/
                );

                assert.ok(
                    shownErrors.some(m => m.startsWith('Build broken: ')),
                    `expected failMessage formatted error among ${JSON.stringify(shownErrors)}`
                );
                const entries: HistoryEntry[] = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.strictEqual(entries[0].actionId, 'it028');
                assert.strictEqual(entries[0].status, 'failure');
                assert.ok(
                    typeof entries[0].output === 'string' && entries[0].output.includes('capture failed'),
                    `history output should include capture failure, got: ${entries[0].output}`
                );
                assert.strictEqual(actionStates.get('it028')?.state, 'failure');
            } finally {
                (vscode.window as any).showErrorMessage = originalShowError;
            }
        });

        test('IT-155: 장시간 성공은 묶고 실패는 원인이 있는 개별 알림을 보존한다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const settingKeys = [
                'showTaskStatus',
                'backgroundCompletion.thresholdSeconds',
                'backgroundCompletion.notificationMode',
                'backgroundCompletion.outcomes',
            ] as const;
            const previous = new Map(settingKeys.map(key => [key, config.inspect(key)?.globalValue]));
            const originalShowInfo = vscode.window.showInformationMessage;
            const originalShowError = vscode.window.showErrorMessage;
            const originalSetStatus = vscode.window.setStatusBarMessage;
            const shownInfo: string[] = [];
            const shownErrors: string[] = [];
            const shownStatus: string[] = [];
            (vscode.window as any).showInformationMessage = async (message: string) => {
                shownInfo.push(message);
                return undefined;
            };
            (vscode.window as any).showErrorMessage = async (message: string) => {
                shownErrors.push(message);
                return undefined;
            };
            (vscode.window as any).setStatusBarMessage = (message: string) => {
                shownStatus.push(message);
                return { dispose: () => undefined };
            };

            try {
                await config.update('showTaskStatus', true, vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.thresholdSeconds', 0, vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.notificationMode', 'always', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.outcomes', ['success', 'failure'], vscode.ConfigurationTarget.Global);

                const context = makeFakeContext();
                const success: ActionItem = {
                    id: 'it155.success',
                    title: 'IT-155 Success',
                    action: {
                        description: 'batched success',
                        successMessage: 'Success detail',
                        tasks: [{ id: 'ok', type: 'stringManipulation', function: 'trim', input: 'ok' }],
                    },
                };
                const failure: ActionItem = {
                    id: 'it155.failure',
                    title: 'IT-155 Failure',
                    action: {
                        description: 'batched failure',
                        failMessage: 'Failure detail',
                        tasks: [{
                            id: 'fail',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'x',
                            passTheResultToNextTask: true,
                            output: { capture: { name: 'bad', regex: '(' } },
                        }],
                    },
                };
                const success2: ActionItem = {
                    id: 'it155.success2',
                    title: 'IT-155 Success 2',
                    action: {
                        description: 'second batched success',
                        successMessage: 'Second success detail',
                        tasks: [{ id: 'ok', type: 'stringManipulation', function: 'trim', input: 'ok' }],
                    },
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [success, success2, failure]);

                await executeAction(success, context, mainView, history);
                await executeAction(success2, context, mainView, history);
                await assert.rejects(() => executeAction(failure, context, mainView, history), /capture failed/);
                assert.deepStrictEqual(shownInfo, [], '개별 successMessage가 묶음 알림보다 먼저 중복 표시됐다');
                assert.strictEqual(shownErrors.length, 1, '실패 상세는 배치 flush 전에 개별 알림으로 남아야 한다');
                assert.match(shownErrors[0], /^Failure detail: .*capture failed/);

                __testHook_flushBackgroundCompletions();

                assert.strictEqual(shownErrors.length, 1, '배치가 원인 없는 두 번째 실패 알림을 만들면 안 된다');
                assert.strictEqual(shownInfo.length, 1, '성공 두 건은 정보 알림 하나로 묶여야 한다');
                assert.match(shownInfo[0], /(액션 2개 종료|2 actions finished)/);
                assert.match(shownInfo[0], /(성공 2|2 succeeded)/);
                assert.strictEqual(shownStatus.length, 1, '상태 표시줄도 묶음 하나여야 한다');
                assert.match(shownStatus[0], /(액션 3개 종료|3 actions finished)/);
                assert.match(shownStatus[0], /(성공 2|2 succeeded)/);
                assert.match(shownStatus[0], /(실패 1|1 failed)/);
            } finally {
                __testHook_flushBackgroundCompletions();
                (vscode.window as any).showInformationMessage = originalShowInfo;
                (vscode.window as any).showErrorMessage = originalShowError;
                (vscode.window as any).setStatusBarMessage = originalSetStatus;
                for (const key of settingKeys) {
                    await config.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
                }
            }
        });

        test('IT-193a: Actions 상태를 숨겨도 실행 알림을 독립적으로 켤 수 있다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const settingKeys = [
                'showTaskStatus',
                'executionNotifications',
                'backgroundCompletion.thresholdSeconds',
                'backgroundCompletion.notificationMode',
                'backgroundCompletion.outcomes',
            ] as const;
            const previous = new Map(settingKeys.map(key => [key, config.inspect(key)?.globalValue]));
            const originalShowInfo = vscode.window.showInformationMessage;
            const originalSetStatus = vscode.window.setStatusBarMessage;
            const shownInfo: string[] = [];
            const shownStatus: string[] = [];
            (vscode.window as any).showInformationMessage = async (message: string) => {
                shownInfo.push(message);
                return undefined;
            };
            (vscode.window as any).setStatusBarMessage = (message: string) => {
                shownStatus.push(message);
                return { dispose: () => undefined };
            };

            const actionItem: ActionItem = {
                id: 'it193a',
                title: 'IT-193 Hidden Status',
                action: {
                    description: 'notification without tree status',
                    successMessage: 'Independent completion',
                    tasks: [{ id: 'ok', type: 'stringManipulation', function: 'trim', input: 'ok' }],
                },
            };

            try {
                await config.update('showTaskStatus', false, vscode.ConfigurationTarget.Global);
                await config.update('executionNotifications', 'on', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.thresholdSeconds', 0, vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.notificationMode', 'always', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.outcomes', ['success'], vscode.ConfigurationTarget.Global);

                const context = makeFakeContext();
                const mainView = new MainViewProvider(context, () => [actionItem]);
                await executeAction(actionItem, context, mainView, new HistoryProvider(context));
                __testHook_flushBackgroundCompletions();

                assert.strictEqual(shownInfo.length, 1, '알림 on이 Actions 상태 설정에 다시 묶이면 안 된다');
                assert.match(shownInfo[0], /^Independent completion/);
                assert.strictEqual(shownStatus.length, 1, '장시간 완료 상태도 실행 알림 정책을 따라야 한다');
                const rendered = (await mainView.getChildren())[0];
                assert.strictEqual((rendered.iconPath as vscode.ThemeIcon).id, 'gear',
                    '알림을 켰다고 숨긴 Actions 성공 아이콘이 되살아나면 안 된다');
                assert.strictEqual(rendered.accessibilityInformation?.label, actionItem.title);
            } finally {
                __testHook_flushBackgroundCompletions();
                (vscode.window as any).showInformationMessage = originalShowInfo;
                (vscode.window as any).setStatusBarMessage = originalSetStatus;
                for (const key of settingKeys) {
                    await config.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
                }
            }
        });

        test('IT-193b: Actions 상태를 유지하면서 실행 알림만 끌 수 있다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const settingKeys = [
                'showTaskStatus',
                'executionNotifications',
                'backgroundCompletion.thresholdSeconds',
                'backgroundCompletion.notificationMode',
                'backgroundCompletion.outcomes',
            ] as const;
            const previous = new Map(settingKeys.map(key => [key, config.inspect(key)?.globalValue]));
            const originalShowError = vscode.window.showErrorMessage;
            const originalSetStatus = vscode.window.setStatusBarMessage;
            const shownErrors: string[] = [];
            const shownStatus: string[] = [];
            (vscode.window as any).showErrorMessage = async (message: string) => {
                shownErrors.push(message);
                return undefined;
            };
            (vscode.window as any).setStatusBarMessage = (message: string) => {
                shownStatus.push(message);
                return { dispose: () => undefined };
            };

            const actionItem: ActionItem = {
                id: 'it193b',
                title: 'IT-193 Silent Failure',
                action: {
                    description: 'tree status without notification',
                    failMessage: 'Hidden failure notification',
                    tasks: [{
                        id: 'fail',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'x',
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'bad', regex: '(' } },
                    }],
                },
            };

            try {
                await config.update('showTaskStatus', true, vscode.ConfigurationTarget.Global);
                await config.update('executionNotifications', 'off', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.thresholdSeconds', 0, vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.notificationMode', 'always', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.outcomes', ['failure'], vscode.ConfigurationTarget.Global);

                const context = makeFakeContext();
                const mainView = new MainViewProvider(context, () => [actionItem]);
                await assert.rejects(
                    () => executeAction(actionItem, context, mainView, new HistoryProvider(context)),
                    /capture failed/
                );
                __testHook_flushBackgroundCompletions();

                assert.deepStrictEqual(shownErrors, [], '알림 off인데 상세 실패 토스트가 남으면 안 된다');
                assert.deepStrictEqual(shownStatus, [], '알림 off인데 장시간 완료 상태가 남으면 안 된다');
                const rendered = (await mainView.getChildren())[0];
                assert.strictEqual((rendered.iconPath as vscode.ThemeIcon).id, 'error',
                    '알림을 껐다고 Actions 실패 상태까지 숨기면 안 된다');
                assert.match(rendered.accessibilityInformation?.label ?? '', /(실패|failed)/);
            } finally {
                __testHook_flushBackgroundCompletions();
                (vscode.window as any).showErrorMessage = originalShowError;
                (vscode.window as any).setStatusBarMessage = originalSetStatus;
                for (const key of settingKeys) {
                    await config.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
                }
            }
        });

        test('IT-193d: 실행 중 바꾼 상태 설정을 완료 알림과 트리 capability에 반영한다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const settingKeys = [
                'showTaskStatus',
                'executionNotifications',
                'backgroundCompletion.outcomes',
            ] as const;
            const previous = new Map(settingKeys.map(key => [key, config.inspect(key)?.globalValue]));
            const originalShowInfo = vscode.window.showInformationMessage;
            const originalShowInputBox = vscode.window.showInputBox;
            const shownInfo: string[] = [];
            let resolveOpened!: () => void;
            const opened = new Promise<void>(resolve => { resolveOpened = resolve; });
            let resolveInput: ((value: string | undefined) => void) | undefined;
            (vscode.window as any).showInformationMessage = async (message: string) => {
                shownInfo.push(message);
                return undefined;
            };
            (vscode.window as any).showInputBox = () => {
                resolveOpened();
                return new Promise<string | undefined>(resolve => { resolveInput = resolve; });
            };

            const actionItem: ActionItem = {
                id: 'it193d',
                title: 'IT-193 Dynamic Feedback',
                action: {
                    description: 'change feedback policy while prompt is open',
                    successMessage: 'Dynamic completion',
                    tasks: [{ id: 'ask', type: 'inputBox', prompt: 'value?' }],
                },
            };
            let run: Promise<void> | undefined;
            let changeCount = 0;
            let changeSubscription: vscode.Disposable | undefined;

            try {
                await config.update('showTaskStatus', false, vscode.ConfigurationTarget.Global);
                await config.update('executionNotifications', 'followStatus', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.outcomes', [], vscode.ConfigurationTarget.Global);

                const context = makeFakeContext();
                const mainView = new MainViewProvider(context, () => [actionItem]);
                changeSubscription = mainView.onDidChangeTreeData(() => { changeCount++; });
                run = executeAction(actionItem, context, mainView, new HistoryProvider(context));
                await opened;

                assert.ok(changeCount >= 1,
                    '상태 아이콘을 숨겨도 runningAction capability를 위한 시작 refresh가 필요하다');
                const running = (await mainView.getChildren())[0];
                assert.strictEqual(running.contextValue, 'runningAction');
                assert.strictEqual((running.iconPath as vscode.ThemeIcon).id, 'gear');

                await config.update('showTaskStatus', true, vscode.ConfigurationTarget.Global);
                resolveInput?.('done');
                await run;

                assert.ok(shownInfo.includes('Dynamic completion'),
                    'followStatus가 시작 시점 false에 고정되면 완료 시 켠 알림이 나오지 않는다');
                const completed = (await mainView.getChildren())[0];
                assert.strictEqual((completed.iconPath as vscode.ThemeIcon).id, 'check');
                assert.strictEqual(completed.contextValue, 'succeededAction');
                assert.ok(changeCount >= 3,
                    '시작·태스크 종료·최종화 refresh가 있어야 설정 전환 뒤 상태가 정체되지 않는다');
            } finally {
                resolveInput?.(undefined);
                await run?.catch(() => undefined);
                changeSubscription?.dispose();
                (vscode.window as any).showInformationMessage = originalShowInfo;
                (vscode.window as any).showInputBox = originalShowInputBox;
                for (const key of settingKeys) {
                    await config.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
                }
            }
        });

        test('IT-193e: explicit off만 detached one-shot 실패 알림을 숨긴다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const settingKeys = [
                'showTaskStatus',
                'executionNotifications',
                'backgroundCompletion.outcomes',
            ] as const;
            const previous = new Map(settingKeys.map(key => [key, config.inspect(key)?.globalValue]));
            const originalShowError = vscode.window.showErrorMessage;
            const originalExecuteTask = vscode.tasks.executeTask;
            const shownErrors: string[] = [];
            let executeTaskCalls = 0;
            let resolveFirstFailure!: () => void;
            const firstFailure = new Promise<void>(resolve => { resolveFirstFailure = resolve; });
            (vscode.window as any).showErrorMessage = async (message: string) => {
                shownErrors.push(message);
                resolveFirstFailure();
                return undefined;
            };
            (vscode.tasks as any).executeTask = async () => {
                executeTaskCalls++;
                throw new Error('detached launch failed');
            };

            const runOneShot = async (id: string): Promise<void> => {
                const actionItem: ActionItem = {
                    id,
                    title: id,
                    action: {
                        description: 'detached one-shot failure policy',
                        tasks: [{ id: 'background', type: 'command', command: 'node', isOneShot: true }],
                    },
                };
                const context = makeFakeContext();
                await executeAction(actionItem, context, new MainViewProvider(context, () => [actionItem]));
            };

            try {
                await config.update('showTaskStatus', false, vscode.ConfigurationTarget.Global);
                await config.update('executionNotifications', 'followStatus', vscode.ConfigurationTarget.Global);
                await config.update('backgroundCompletion.outcomes', [], vscode.ConfigurationTarget.Global);

                await runOneShot('it193e.follow');
                await Promise.race([
                    firstFailure,
                    new Promise<never>((_, reject) => setTimeout(
                        () => reject(new Error('followStatus one-shot failure notification timeout')),
                        2000
                    )),
                ]);
                assert.strictEqual(shownErrors.length, 1,
                    'followStatus는 showTaskStatus=false에서도 기존 one-shot 실패 알림을 보존한다');

                shownErrors.length = 0;
                await config.update('executionNotifications', 'off', vscode.ConfigurationTarget.Global);
                await runOneShot('it193e.off');
                const deadline = Date.now() + 2000;
                while (executeTaskCalls < 2 && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                await new Promise(resolve => setTimeout(resolve, 25));
                assert.strictEqual(executeTaskCalls, 2);
                assert.deepStrictEqual(shownErrors, [],
                    'explicit off인데 detached one-shot 실패가 설정을 우회하면 안 된다');
            } finally {
                (vscode.window as any).showErrorMessage = originalShowError;
                (vscode.tasks as any).executeTask = originalExecuteTask;
                for (const key of settingKeys) {
                    await config.update(key, previous.get(key), vscode.ConfigurationTarget.Global);
                }
            }
        });
    });

    suite('History Input Replay', () => {
        // These tests pin history input replay: capturing interactive task results into
        // the history entry's `inputs` map and replaying them on rerun so
        // dialogs do not reopen. The accumulator is mutated in-place by the
        // pipeline; the lifecycle wrapper (`executeAction`) is what attaches
        // it to the history entry, so we cover both layers.
        function makeFakeContext(): vscode.ExtensionContext {
            const workspaceState = new Map<string, unknown>();
            return {
                extensionPath: path.resolve(__dirname, '..', '..'),
                subscriptions: [],
                workspaceState: {
                    get: <T>(key: string, def?: T) =>
                        workspaceState.has(key) ? (workspaceState.get(key) as T) : def,
                    update: (key: string, val: unknown) => {
                        workspaceState.set(key, val);
                        return Promise.resolve();
                    },
                    keys: () => Array.from(workspaceState.keys())
                },
                globalState: {
                    get: <T>(_k: string, d?: T) => d,
                    update: () => Promise.resolve(),
                    keys: () => [],
                    setKeysForSync: () => { /* no-op */ }
                },
                extensionMode: vscode.ExtensionMode.Test,
                extension: { packageJSON: { version: '9.9.9-test' } }
            } as unknown as vscode.ExtensionContext;
        }

        test('IT-063: 인터랙티브 task 결과가 history entry.inputs에 누적', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowInputBox = vscode.window.showInputBox;
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) =>
                    items.find(i => i.label === 'staging');
                (vscode.window as any).showInputBox = async () => 'release-1';

                const context = makeFakeContext();
                const actionItem: ActionItem = {
                    id: 'it043',
                    title: 'IT-063 Capture Inputs',
                    action: {
                        description: 'IT-063',
                        tasks: [
                            { id: 'env', type: 'quickPick', items: ['dev', 'staging', 'prod'] },
                            { id: 'tag', type: 'inputBox', prompt: 'tag' },
                            // shell task is non-interactive — must NOT appear in inputs
                            {
                                id: 'noop',
                                type: 'stringManipulation',
                                function: 'trim',
                                input: '${env.value}-${tag.value}'
                            }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await executeAction(actionItem, context, mainView, history);

                const entries: HistoryEntry[] = history.getHistory();
                assert.strictEqual(entries.length, 1);
                assert.deepStrictEqual(entries[0].inputs, {
                    // quickPick 은 `label`(표시 문구) 과 `valueList`(인자 확장용)
                    // 도 함께 남긴다 — 재실행이 label 로 선택지 유효성을 본다.
                    env: {
                        value: 'staging', label: 'staging', labelList: ['staging'],
                        valueList: ['staging'], custom: false,
                    },
                    tag: { value: 'release-1' }
                });
                assert.deepStrictEqual(entries[0].inputTaskTypes, {
                    env: 'quickPick',
                    tag: 'inputBox'
                });
                // Non-interactive task id is absent.
                assert.ok(!(entries[0].inputs as any).noop);
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-064: presetInputs로 재실행하면 다이얼로그를 열지 않고 저장값을 사용', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowInputBox = vscode.window.showInputBox;
            const resultPath = path.join(tempWorkspace, 'it044.txt');
            let dialogOpened = 0;
            try {
                (vscode.window as any).showQuickPick = async () => {
                    dialogOpened++;
                    throw new Error('quickPick must not open during replay');
                };
                (vscode.window as any).showInputBox = async () => {
                    dialogOpened++;
                    throw new Error('inputBox must not open during replay');
                };

                const action: PipelineAction = {
                    description: 'IT-064',
                    tasks: [
                        { id: 'env', type: 'quickPick', items: ['dev', 'prod'] },
                        { id: 'tag', type: 'inputBox', prompt: 'tag' },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'env=${env.value};tag=${tag.value}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };

                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it044',
                    tempWorkspace,
                    [tempWorkspace],
                    {
                        presetInputs: {
                            env: { value: 'prod' },
                            tag: { value: 'r-2' }
                        }
                    }
                );

                assert.strictEqual(dialogOpened, 0, 'no dialog should open when presetInputs supplies the values');
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'env=prod;tag=r-2');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-157: workspace 입력 프로필을 다시 읽어 대화상자 없이 실행한다', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalShowInputBox = vscode.window.showInputBox;
            const resultPath = path.join(tempWorkspace, 'it157.txt');
            let dialogOpened = 0;
            try {
                (vscode.window as any).showQuickPick = async () => { dialogOpened++; return undefined; };
                (vscode.window as any).showInputBox = async () => { dialogOpened++; return undefined; };
                const action: PipelineAction = {
                    description: 'IT-157',
                    tasks: [
                        { id: 'env', type: 'quickPick', items: ['dev', 'prod'] },
                        { id: 'tag', type: 'inputBox', validatePattern: '^r-\\d+$' },
                        {
                            id: 'write', type: 'stringManipulation', function: 'trim',
                            input: '${env.value}:${tag.value}', passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true }
                        }
                    ]
                };
                const profileContext = makeDialogMemoryContext();
                const store = new InputProfileStore(profileContext.workspaceState);
                await store.save(buildInputProfileDraft(
                    'deploy', 'Release', action.tasks,
                    { env: { value: 'prod' }, tag: { value: 'r-7' } },
                    { env: 'quickPick', tag: 'inputBox' }
                ));
                const profile = store.list('deploy')[0];
                const inspected = inspectInputProfile(profile, action.tasks);

                await executeActionPipeline(
                    action,
                    { extensionPath: path.resolve(__dirname, '..', '..') } as vscode.ExtensionContext,
                    'it157', tempWorkspace, [tempWorkspace],
                    { presetInputs: inspected.usableInputs }
                );

                assert.strictEqual(dialogOpened, 0);
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'prod:r-7');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-110: recordCommands에 ${...} 치환이 끝난 실행 명령줄이 task별로 기록된다', async () => {
            // The picked directory flows from an interactive folderDialog
            // (here supplied via presetInputs) into the command's args. The
            // recorded command must contain the resolved path so "실행한
            // 명령 보기" can show exactly what ran without re-prompting.
            const picked = path.join(tempWorkspace, 'picked-dir');
            const action: PipelineAction = {
                description: 'IT-110',
                tasks: [
                    { id: 'dir', type: 'folderDialog' },
                    {
                        id: 'build',
                        type: 'shell',
                        command: 'node',
                        args: ['-e', 'process.exit(0)', '${dir.path}'],
                        passTheResultToNextTask: true
                    }
                ]
            };

            const recordCommands: Record<string, string> = {};
            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it110',
                tempWorkspace,
                [tempWorkspace],
                {
                    presetInputs: { dir: { path: picked, dir: tempWorkspace, name: 'picked-dir', fileNameOnly: 'picked-dir', fileExt: '' } },
                    recordCommands
                }
            );

            assert.ok(recordCommands['build'], 'command/shell task must be recorded');
            assert.ok(
                recordCommands['build'].includes(picked),
                `recorded command should contain the resolved picked dir, got: ${recordCommands['build']}`
            );
            assert.ok(
                !Object.prototype.hasOwnProperty.call(recordCommands, 'dir'),
                'interactive (non-command) task must not be recorded as a command'
            );
        });

        test('IT-111: executeAction이 실행한 명령줄을 history entry.commands에 영속화한다', async () => {
            const context = makeFakeContext();
            const actionItem: ActionItem = {
                id: 'it111',
                title: 'IT-111',
                action: {
                    description: 'IT-111',
                    tasks: [{
                        id: 'run',
                        type: 'shell',
                        command: 'node',
                        args: ['-e', 'process.exit(0)', 'marker-arg'],
                        passTheResultToNextTask: true
                    }]
                }
            };
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            await executeAction(actionItem, context, mainView, history);

            const entry = history.getHistory()[0];
            assert.strictEqual(entry.status, 'success');
            assert.ok(entry.commands, 'history entry must carry recorded commands');
            assert.ok(entry.commands!['run'], 'the shell task must be recorded under its task id');
            assert.ok(
                entry.commands!['run'].includes('node') && entry.commands!['run'].includes('marker-arg'),
                `recorded command should contain the command and its args, got: ${entry.commands!['run']}`
            );
        });

        test('IT-112: 저장된 folderDialog 입력으로 재실행하면 dir 다이얼로그를 다시 열지 않고 선택값을 재사용한다', async () => {
            // The user's exact scenario: a history rerun must reuse the
            // previously picked directory instead of re-prompting. The 5th
            // `executeAction` arg here is precisely what
            // `taskhub.rerunFromHistoryWithInputs` forwards from `entry.inputs`
            // (it used to pass `undefined`, which forced the dialog open —
            // the regression this guards against).
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            let dialogOpened = 0;
            const context = makeFakeContext();
            const picked = path.join(tempWorkspace, 'saved-dir');
            try {
                (vscode.window as any).showOpenDialog = async () => {
                    dialogOpened++;
                    // Return a deliberately wrong path so a regression that
                    // re-opens the dialog would surface as a content mismatch
                    // too, not just the counter.
                    return [vscode.Uri.file(path.join(tempWorkspace, 'WRONG-dir'))];
                };

                const actionItem: ActionItem = {
                    id: 'it112',
                    title: 'IT-112',
                    action: {
                        description: 'IT-112',
                        tasks: [
                            { id: 'dir', type: 'folderDialog' },
                            {
                                id: 'use',
                                type: 'shell',
                                command: 'node',
                                args: ['-e', 'process.exit(0)', '${dir.path}'],
                                passTheResultToNextTask: true
                            }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                const savedInputs = {
                    dir: { path: picked, dir: tempWorkspace, name: 'saved-dir', fileNameOnly: 'saved-dir', fileExt: '' }
                };
                await executeAction(actionItem, context, mainView, history, savedInputs);

                assert.strictEqual(dialogOpened, 0, 'folder dialog must not reopen when saved inputs are supplied');
                const entry = history.getHistory()[0];
                assert.strictEqual(entry.status, 'success');
                assert.ok(
                    entry.commands!['use'].includes(picked),
                    `command must use the saved dir, got: ${entry.commands!['use']}`
                );
                assert.ok(
                    !entry.commands!['use'].includes('WRONG-dir'),
                    'the re-prompted (wrong) dir must never reach the command'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-113: 여러 command/shell task가 각자의 id로 모두 기록된다 (command 타입 포함)', async () => {
            const action: PipelineAction = {
                description: 'IT-113',
                tasks: [
                    { id: 'first', type: 'shell', command: 'node', args: ['-e', 'process.exit(0)', 'ARG-A'], passTheResultToNextTask: true },
                    { id: 'second', type: 'command', command: 'node', args: ['-e', 'process.exit(0)', 'ARG-B'], passTheResultToNextTask: true }
                ]
            };
            const recordCommands: Record<string, string> = {};
            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it113',
                tempWorkspace,
                [tempWorkspace],
                { recordCommands }
            );
            assert.strictEqual(Object.keys(recordCommands).length, 2, 'both command-bearing tasks must be recorded');
            assert.ok(recordCommands['first'].includes('ARG-A'), `got: ${recordCommands['first']}`);
            assert.ok(recordCommands['second'].includes('ARG-B'), `got: ${recordCommands['second']}`);
        });

        test('IT-114: command/shell task가 없으면 executeAction이 history entry.commands를 남기지 않는다', async () => {
            // Guards the "no spurious terminal icon" promise: a pure
            // stringManipulation action must not advertise a command view.
            const context = makeFakeContext();
            const actionItem: ActionItem = {
                id: 'it114',
                title: 'IT-114',
                action: {
                    description: 'IT-114',
                    tasks: [{ id: 't', type: 'stringManipulation', function: 'trim', input: '  x  ' }]
                }
            };
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            await executeAction(actionItem, context, mainView, history);

            const entry = history.getHistory()[0];
            assert.strictEqual(entry.status, 'success');
            assert.strictEqual(entry.commands, undefined, 'no command/shell task ran → commands field must stay absent');
        });

        test('IT-115: command task가 실패해도 실행한 명령줄은 기록되고 failure 경로에서 영속화된다', async () => {
            // Recording happens before execution, so a non-zero exit must not
            // lose the command. The failure persistence path must also flush
            // it to the history entry.
            const originalShowError = vscode.window.showErrorMessage;
            (vscode.window as any).showErrorMessage = async () => undefined;
            try {
                const context = makeFakeContext();
                const actionItem: ActionItem = {
                    id: 'it115',
                    title: 'IT-115',
                    action: {
                        description: 'IT-115',
                        tasks: [{
                            id: 'boom',
                            type: 'shell',
                            command: 'node',
                            args: ['-e', 'process.exit(3)', 'FAIL-MARKER'],
                            passTheResultToNextTask: true
                        }]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await assert.rejects(() => executeAction(actionItem, context, mainView, history));

                const entry = history.getHistory()[0];
                assert.strictEqual(entry.status, 'failure');
                assert.ok(entry.commands, 'commands must survive the failure path');
                assert.ok(
                    entry.commands!['boom'].includes('FAIL-MARKER'),
                    `failed task's command must still be recorded, got: ${entry.commands!['boom']}`
                );
            } finally {
                (vscode.window as any).showErrorMessage = originalShowError;
            }
        });

        test('IT-116: 저장된 입력이 없으면 folderDialog가 정상적으로 열린다 (IT-112 대조군)', async () => {
            // Without this, IT-112's `dialogOpened === 0` could pass even if
            // the dialog were unconditionally suppressed. Here, with no preset,
            // the dialog must open exactly once and its pick must flow through.
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            let dialogOpened = 0;
            const context = makeFakeContext();
            const chosen = path.join(tempWorkspace, 'fresh-dir');
            try {
                (vscode.window as any).showOpenDialog = async () => {
                    dialogOpened++;
                    return [vscode.Uri.file(chosen)];
                };
                const actionItem: ActionItem = {
                    id: 'it116',
                    title: 'IT-116',
                    action: {
                        description: 'IT-116',
                        tasks: [
                            { id: 'dir', type: 'folderDialog' },
                            {
                                id: 'use',
                                type: 'shell',
                                command: 'node',
                                args: ['-e', 'process.exit(0)', '${dir.path}'],
                                passTheResultToNextTask: true
                            }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await executeAction(actionItem, context, mainView, history); // no presetInputs

                assert.strictEqual(dialogOpened, 1, 'dialog must open exactly once when no saved input is supplied');
                assert.ok(
                    history.getHistory()[0].commands!['use'].includes('fresh-dir'),
                    'the freshly picked dir must flow into the recorded command'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-117: 같은 task id를 쓰는 서로 다른 액션이 다이얼로그 위치를 공유하지 않는다', async () => {
            // 0.6.11이 다이얼로그 위치를 "액션 id + 태스크 id" 단위로 기억한다고
            // 문서화했지만, 실행기는 `actionId`를 별도 인자로 받으면서 dialog
            // 분기에는 원본 task만 넘겨 scope가 `task.fileDialog:/pick`이 됐다.
            // 0.6.17에서 마법사 템플릿이 selectFile / selectFolder라는 고정 id를
            // 쓰기 시작하면서, 마법사로 만든 액션들끼리 위치가 섞였다.
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const previousContext = initDialogMemory(makeDialogMemoryContext());
            const dirA = path.join(tempWorkspace, 'proj-a');
            const dirB = path.join(tempWorkspace, 'proj-b');
            fs.mkdirSync(dirA, { recursive: true });
            fs.mkdirSync(dirB, { recursive: true });
            fs.writeFileSync(path.join(dirA, 'a.hex'), 'a');
            fs.writeFileSync(path.join(dirB, 'b.hex'), 'b');

            const seenDefaults: Array<string | undefined> = [];
            try {
                let nextPick = path.join(dirA, 'a.hex');
                (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                    seenDefaults.push(options.defaultUri?.fsPath);
                    return [vscode.Uri.file(nextPick)];
                };

                const pickAction = (id: string): PipelineAction => ({
                    description: id,
                    tasks: [{ id: 'pick', type: 'fileDialog' }],
                });

                // 액션 A는 proj-a에서, 액션 B는 proj-b에서 파일을 고른다.
                await run(pickAction('act.a'), 'act.a');
                nextPick = path.join(dirB, 'b.hex');
                await run(pickAction('act.b'), 'act.b');

                // 다시 A를 실행하면 A가 마지막으로 쓰던 proj-a에서 열려야 한다.
                seenDefaults.length = 0;
                nextPick = path.join(dirA, 'a.hex');
                await run(pickAction('act.a'), 'act.a');

                assert.strictEqual(seenDefaults.length, 1);
                assert.strictEqual(
                    normalizeWindowsPathForAssert(seenDefaults[0] ?? ''),
                    normalizeWindowsPathForAssert(dirA),
                    'B가 고른 위치가 A로 새어 들어오면 액션별 scope 배선이 빠진 것'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
                initDialogMemory(previousContext);
            }
        });

        /**
         * 다중 선택이 실제 파이프라인을 타는지 (IT-151 / IT-152).
         *
         * 단위 검사는 조각별로만 본다 — 다이얼로그가 배열을 돌려주는지,
         * `expandArgTemplate` 가 펼치는지, 보간이 이어 붙이는지. 그 사이를
         * 잇는 실행 경로(핸들러 → 결과 컨텍스트 → argv)는 아무도 보지
         * 않았다. 여기서 처음부터 끝까지 한 번 돌린다.
         */
        test('IT-151: fileDialog 다중 선택이 다음 command 의 argv 로 각각 전달된다', async () => {
            const files = ['a.bin', 'b b.bin', 'c.bin']
                .map(name => path.join(tempWorkspace, name));
            files.forEach(f => fs.writeFileSync(f, 'x'));
            const resultPath = path.join(tempWorkspace, 'it151.json');
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            try {
                (vscode.window as any).showOpenDialog = async () => files.map(f => vscode.Uri.file(f));

                const action: PipelineAction = {
                    description: 'IT-151',
                    tasks: [
                        { id: 'pick', type: 'fileDialog', options: { canSelectMany: true } },
                        {
                            id: 'run',
                            type: 'command',
                            command: 'node',
                            // 받은 인자를 그대로 JSON 으로 적는다 — argv 경계가
                            // 유지됐는지 보려면 실제 프로세스가 본 것을 봐야 한다.
                            args: [
                                '-e',
                                `require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))`,
                                resultPath,
                                '${pick.paths}',
                            ],
                            passTheResultToNextTask: true,
                        },
                    ],
                };

                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it151',
                    tempWorkspace,
                    [tempWorkspace]
                );

                assert.deepStrictEqual(
                    (JSON.parse(fs.readFileSync(resultPath, 'utf8')) as string[]).map(normalizeWindowsPathForAssert),
                    files.map(normalizeWindowsPathForAssert),
                    '공백이 든 경로까지 인자 하나씩 그대로 도착해야 한다'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-152: folderDialog 다중 선택도 같은 경로를 탄다', async () => {
            const dirs = ['out-1', 'out 2'].map(name => path.join(tempWorkspace, name));
            dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));
            const resultPath = path.join(tempWorkspace, 'it152.txt');
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            try {
                (vscode.window as any).showOpenDialog = async () => dirs.map(d => vscode.Uri.file(d));

                const action: PipelineAction = {
                    description: 'IT-152',
                    tasks: [
                        { id: 'pick', type: 'folderDialog', options: { canSelectMany: true } },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'n=${pick.count};names=${pick.names}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true },
                        },
                    ],
                };

                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it152',
                    tempWorkspace,
                    [tempWorkspace]
                );

                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'n=2;names=out-1 out 2');
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        /**
         * 0.6.57 이전 History 항목으로 재실행 (IT-150).
         *
         * 저장된 입력이 있으면 다이얼로그 핸들러를 **건너뛴다.** 옛 기록에는
         * `paths`/`names`/`count` 가 없으므로, 보정하지 않으면 새로 문서화한
         * `${dir.paths}` 가 **재실행에서만** 리터럴로 남는다. 단위 검사는
         * 보정 함수 자체만 보므로 호출부가 빠져도 통과한다 — 여기서 실제
         * 파이프라인을 돌려 값이 흘러가는지 본다.
         */
        test('IT-150: 배열 필드가 없는 옛 저장 입력으로 재실행해도 paths 가 해석된다', async () => {
            const picked = path.join(tempWorkspace, 'legacy-dir');
            fs.mkdirSync(picked, { recursive: true });
            const resultPath = path.join(tempWorkspace, 'it150.txt');
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            let dialogOpened = 0;
            try {
                (vscode.window as any).showOpenDialog = async () => {
                    dialogOpened++;
                    throw new Error('folderDialog must not open during replay');
                };

                const action: PipelineAction = {
                    description: 'IT-150',
                    tasks: [
                        { id: 'dir', type: 'folderDialog' },
                        {
                            id: 'write',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'n=${dir.count};paths=${dir.paths};names=${dir.names}',
                            passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: resultPath, overwrite: true },
                        },
                    ],
                };

                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it150',
                    tempWorkspace,
                    [tempWorkspace],
                    // 0.6.57 이전 형식: 단일 필드뿐이다.
                    { presetInputs: { dir: { path: picked, dir: tempWorkspace, name: 'legacy-dir', fileNameOnly: 'legacy-dir', fileExt: '' } } }
                );

                assert.strictEqual(dialogOpened, 0, '저장된 입력이 있으면 다이얼로그를 열지 않는다');
                assert.strictEqual(
                    fs.readFileSync(resultPath, 'utf8'),
                    `n=1;paths=${picked};names=legacy-dir`,
                    '옛 기록을 보정하지 않으면 ${dir.paths} 가 리터럴로 남는다'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-118: 같은 액션 안의 file / folder 다이얼로그도 위치를 공유하지 않는다', async () => {
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            const previousContext = initDialogMemory(makeDialogMemoryContext());
            const fileDir = path.join(tempWorkspace, 'src-dir');
            const outDir = path.join(tempWorkspace, 'out-dir');
            fs.mkdirSync(fileDir, { recursive: true });
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(fileDir, 'fw.hex'), 'x');

            const seenDefaults: Array<{ folder: boolean; dir: string | undefined }> = [];
            try {
                (vscode.window as any).showOpenDialog = async (options: vscode.OpenDialogOptions) => {
                    const isFolder = options.canSelectFolders === true && options.canSelectFiles !== true;
                    seenDefaults.push({ folder: isFolder, dir: options.defaultUri?.fsPath });
                    return [vscode.Uri.file(isFolder ? outDir : path.join(fileDir, 'fw.hex'))];
                };

                const action: PipelineAction = {
                    description: 'IT-118',
                    tasks: [
                        { id: 'selectFile', type: 'fileDialog' },
                        { id: 'selectFolder', type: 'folderDialog' },
                    ],
                };
                await run(action, 'act.mixed');

                seenDefaults.length = 0;
                await run(action, 'act.mixed');

                const filePrompt = seenDefaults.find(entry => !entry.folder);
                const folderPrompt = seenDefaults.find(entry => entry.folder);
                assert.strictEqual(
                    normalizeWindowsPathForAssert(filePrompt?.dir ?? ''),
                    normalizeWindowsPathForAssert(fileDir),
                    '파일 다이얼로그는 직전에 파일을 고른 폴더에서 열려야 한다'
                );
                assert.strictEqual(
                    normalizeWindowsPathForAssert(folderPrompt?.dir ?? ''),
                    normalizeWindowsPathForAssert(outDir),
                    '폴더 다이얼로그는 직전에 고른 폴더 자체에서 열려야 한다'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
                initDialogMemory(previousContext);
            }
        });

        test('IT-073: executeAction이 종료 후 actionStates.progress를 비운다', async () => {
            // The progress hint is mid-run only — finalizeActionRun must
            // clear it so a freshly-completed action doesn't keep showing
            // "2/3 · link" forever.
            const context = makeFakeContext();
            const actionItem: ActionItem = {
                id: 'it073',
                title: 'IT-073',
                action: {
                    description: 'IT-073',
                    tasks: [
                        { id: 'a', type: 'stringManipulation', function: 'trim', input: 'a' },
                        { id: 'b', type: 'stringManipulation', function: 'trim', input: 'b' }
                    ]
                }
            };
            const history = new HistoryProvider(context);
            const mainView = new MainViewProvider(context, () => [actionItem]);

            await executeAction(actionItem, context, mainView, history);

            const finalState = actionStates.get('it073');
            assert.ok(finalState, 'state entry should remain so future runs see last status');
            assert.strictEqual(finalState!.state, 'success');
            assert.strictEqual(finalState!.progress, undefined,
                'progress must be cleared by finalizeActionRun once the action terminates');
        });

        test('IT-067: executeAction은 success/failure 모두 history entry에 durationMs를 기록한다', async () => {
            // Pins last-run badge data scope: every terminal transition surfaced by
            // `executeAction` must include a non-negative duration so each
            // HistoryItem can render "14:30 · 1.2s" badges in its
            // description slot (status is conveyed by the icon, not the
            // badge text). Actions panel intentionally does NOT render
            // this badge — see IT-068b.
            const originalShowError = vscode.window.showErrorMessage;
            (vscode.window as any).showErrorMessage = async () => undefined;
            try {
                const context = makeFakeContext();

                // Success path
                const okItem: ActionItem = {
                    id: 'it067-ok',
                    title: 'IT-067 ok',
                    action: {
                        description: 'IT-067 ok',
                        tasks: [{ id: 't', type: 'stringManipulation', function: 'trim', input: 'x' }]
                    }
                };
                const okHistory = new HistoryProvider(context);
                const okMain = new MainViewProvider(context, () => [okItem]);
                await executeAction(okItem, context, okMain, okHistory);
                const okEntry = okHistory.getHistory()[0];
                assert.strictEqual(okEntry.status, 'success');
                assert.strictEqual(typeof okEntry.durationMs, 'number',
                    'success entry must record durationMs');
                assert.ok(okEntry.durationMs! >= 0, `non-negative duration expected, got ${okEntry.durationMs}`);

                // Failure path (capture failure → executeAction rethrows)
                const failItem: ActionItem = {
                    id: 'it067-fail',
                    title: 'IT-067 fail',
                    action: {
                        description: 'IT-067 fail',
                        tasks: [{
                            id: 'boom',
                            type: 'stringManipulation',
                            function: 'trim',
                            input: 'x',
                            passTheResultToNextTask: true,
                            output: { capture: { name: 'v', regex: '(' } }
                        }]
                    }
                };
                const failHistory = new HistoryProvider(context);
                const failMain = new MainViewProvider(context, () => [failItem]);
                await assert.rejects(() => executeAction(failItem, context, failMain, failHistory));
                const failEntry = failHistory.getHistory()[0];
                assert.strictEqual(failEntry.status, 'failure');
                assert.strictEqual(typeof failEntry.durationMs, 'number',
                    'failure entry must record durationMs');
                assert.ok(failEntry.durationMs! >= 0, `non-negative duration expected, got ${failEntry.durationMs}`);
            } finally {
                (vscode.window as any).showErrorMessage = originalShowError;
            }
        });

        test('IT-066: 재실행 시에도 인터랙티브 task의 output.mode=file 후처리가 실행됨', async () => {
            // Regression guard for the silent skip the reviewer flagged: when
            // a preset short-circuited the type-specific dispatch, the
            // shared `passTheResultToNextTask && output` block was never
            // reached, so an inputBox/quickPick task with
            // `output: { mode: 'file' }` would write the file on a normal
            // run but not on replay. We inject a saved value via
            // presetInputs and assert the output file is still produced.
            const originalShowInputBox = vscode.window.showInputBox;
            const resultPath = path.join(tempWorkspace, 'it066.txt');
            try {
                (vscode.window as any).showInputBox = async () => {
                    throw new Error('inputBox must not open during replay');
                };

                // The inputBox task carries a static `output.content` so we
                // can assert the post-processing block fired without
                // depending on self-referential interpolation (a task's own
                // result is not available to its own `output.content` —
                // interpolationContext is built before the handler runs,
                // both for normal flow and replay).
                const action: PipelineAction = {
                    description: 'IT-066',
                    tasks: [
                        {
                            id: 'tag',
                            type: 'inputBox',
                            prompt: 'tag',
                            passTheResultToNextTask: true,
                            output: {
                                mode: 'file',
                                filePath: resultPath,
                                content: 'post-processing fired',
                                overwrite: true
                            }
                        }
                    ]
                };

                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it066',
                    tempWorkspace,
                    [tempWorkspace],
                    {
                        presetInputs: { tag: { value: 'replayed' } }
                    }
                );

                // Before the fix, executeSingleTask was bypassed entirely
                // when presetInputs short-circuited an interactive task —
                // the file write block never ran, so this assertion would
                // fail with "no such file" on replay.
                assert.ok(fs.existsSync(resultPath), 'output.mode=file post-processing must fire on replay');
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'post-processing fired');
            } finally {
                (vscode.window as any).showInputBox = originalShowInputBox;
            }
        });

        test('IT-065: inputBox password=true는 entry.inputs에 저장되지 않는다', async () => {
            const originalShowInputBox = vscode.window.showInputBox;
            const originalShowQuickPick = vscode.window.showQuickPick;
            try {
                (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) =>
                    items.find(i => i.label === 'visible');
                (vscode.window as any).showInputBox = async (opts: vscode.InputBoxOptions) => {
                    // Both prompts run; password one returns a secret.
                    return opts.password ? 'topsecret' : 'public-tag';
                };

                const context = makeFakeContext();
                const actionItem: ActionItem = {
                    id: 'it045',
                    title: 'IT-065 Password Excluded',
                    action: {
                        description: 'IT-065',
                        tasks: [
                            { id: 'env', type: 'quickPick', items: ['visible', 'other'] },
                            { id: 'token', type: 'inputBox', prompt: 'token', password: true },
                            { id: 'tag', type: 'inputBox', prompt: 'tag' }
                        ]
                    }
                };
                const history = new HistoryProvider(context);
                const mainView = new MainViewProvider(context, () => [actionItem]);

                await executeAction(actionItem, context, mainView, history);

                const entry: HistoryEntry = history.getHistory()[0];
                assert.deepStrictEqual(entry.inputs, {
                    env: {
                        value: 'visible', label: 'visible', labelList: ['visible'],
                        valueList: ['visible'], custom: false,
                    },
                    tag: { value: 'public-tag' }
                });
                assert.ok(!(entry.inputs as any).token, 'password input must not be persisted');
                // Sanity: no field anywhere contains the secret literal.
                const serialized = JSON.stringify(entry);
                assert.ok(!serialized.includes('topsecret'), 'secret leaked into history entry');
            } finally {
                (vscode.window as any).showInputBox = originalShowInputBox;
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });
    });

    suite('Structured Run Logs', () => {
        test('IT-158: 캡처·진단·파일 결과는 저장하고 password 파생 값은 디스크에 남기지 않는다', async () => {
            const secret = 'it158-super-secret';
            const sourcePath = path.join(tempWorkspace, 'main.c');
            const artifactPath = path.join(tempWorkspace, 'build', 'report.txt');
            fs.writeFileSync(sourcePath, 'int main(void) { return 0; }\n');
            const visibleOutput = `${sourcePath}:3:2: warning: visible-warning`;
            const action: PipelineAction = {
                description: 'IT-158',
                tasks: [
                    {
                        id: 'visible',
                        type: 'command',
                        command: 'node',
                        args: ['-e', `process.stdout.write(${JSON.stringify(visibleOutput)})`],
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' },
                    },
                    { id: 'token', type: 'inputBox', prompt: 'token', password: true },
                    {
                        id: 'secretEcho',
                        type: 'command',
                        command: 'node',
                        args: ['-e', 'process.stdout.write(process.argv[1])', '${token.value}'],
                        passTheResultToNextTask: true,
                    },
                    {
                        id: 'artifact',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'report',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: artifactPath, overwrite: true },
                    },
                ],
            };
            const startedAt = Date.now();
            const collector = new ActionRunLogCollector(
                'it158',
                'IT-158 Structured Run Log',
                startedAt,
                action.tasks
            );
            const extensionRoot = path.resolve(__dirname, '..', '..');

            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it158',
                tempWorkspace,
                [tempWorkspace],
                {
                    presetInputs: { token: { value: secret } },
                    runLogCollector: collector,
                }
            );

            const store = new RunLogStore(tempWorkspace);
            const result = await store.write(collector.finish('success', Date.now()), {
                maxFiles: 10,
                retentionDays: 30,
                maxTotalBytes: 8 * 1024 * 1024,
            });
            const serialized = fs.readFileSync(result.absolutePath, 'utf8');
            const parsed = JSON.parse(serialized) as import('../runLogStore').ActionRunLog;
            const visible = parsed.tasks.find(task => task.taskId === 'visible');
            const secretEcho = parsed.tasks.find(task => task.taskId === 'secretEcho');
            const artifact = parsed.tasks.find(task => task.taskId === 'artifact');

            assert.strictEqual(visible?.output.availability, 'captured');
            assert.strictEqual(visible?.output.stdout, visibleOutput);
            assert.deepStrictEqual(visible?.diagnostics, { error: 0, warning: 1, info: 0, hint: 0 });
            assert.deepStrictEqual(artifact?.artifacts, [artifactPath]);
            assert.strictEqual(fs.readFileSync(artifactPath, 'utf8'), 'report');
            assert.strictEqual(secretEcho?.output.availability, 'redacted');
            assert.ok(secretEcho?.command?.includes('***'));
            assert.ok(!serialized.includes(secret), 'password-derived value leaked into the persisted run log');
        });

        test('IT-159: 실패한 태스크의 진단도 수집하고 비밀 파생 파일 경로는 마스킹한다', async () => {
            const secret = 'it159-super-secret';
            const sourcePath = path.join(tempWorkspace, 'broken.c');
            fs.writeFileSync(sourcePath, 'int main(void) { return; }\n');
            const artifactPath = path.join(tempWorkspace, 'out', 'plain.txt');
            const secretArtifactPath = path.join(tempWorkspace, 'out', 'secret.txt');
            const failingOutput = `${sourcePath}:1:18: error: it159-broken`;
            const action: PipelineAction = {
                description: 'IT-159',
                tasks: [
                    {
                        // 진단 수집의 존재 이유인 "오류를 내며 실패한 빌드".
                        // 성공 경로와 실패 경로는 서로 다른 코드가 처리한다.
                        id: 'compileFail',
                        type: 'command',
                        command: 'node',
                        args: ['-e', `process.stderr.write(${JSON.stringify(failingOutput)}); process.exit(1);`],
                        continueOnError: true,
                        // 진단은 캡처 모드를 전제로 한다 (features.md §12).
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' },
                    },
                    {
                        id: 'plainWrite',
                        type: 'writeFile',
                        path: artifactPath,
                        content: 'plain',
                    },
                    { id: 'token', type: 'inputBox', prompt: 'token', password: true },
                    {
                        id: 'secretWrite',
                        type: 'writeFile',
                        path: secretArtifactPath,
                        content: '${token.value}',
                        // 비밀을 디스크에 남기는 것은 태스크가 선언해야 한다.
                        allowSecretContent: true,
                    },
                ],
            };
            const collector = new ActionRunLogCollector('it159', 'IT-159 Failure Diagnostics', Date.now(), action.tasks);
            const extensionRoot = path.resolve(__dirname, '..', '..');

            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it159',
                tempWorkspace,
                [tempWorkspace],
                {
                    presetInputs: { token: { value: secret } },
                    runLogCollector: collector,
                }
            );

            const store = new RunLogStore(tempWorkspace);
            const result = await store.write(collector.finish('failure', Date.now(), 'compile failed'), {
                maxFiles: 10,
                retentionDays: 30,
                maxTotalBytes: 8 * 1024 * 1024,
            });
            const serialized = fs.readFileSync(result.absolutePath, 'utf8');
            const parsed = JSON.parse(serialized) as import('../runLogStore').ActionRunLog;
            const failed = parsed.tasks.find(task => task.taskId === 'compileFail');
            const plain = parsed.tasks.find(task => task.taskId === 'plainWrite');
            const secretWrite = parsed.tasks.find(task => task.taskId === 'secretWrite');

            assert.strictEqual(failed?.status, 'continued');
            assert.strictEqual(failed?.output.availability, 'captured');
            assert.strictEqual(failed?.exitCode, 1);
            assert.deepStrictEqual(failed?.diagnostics, { error: 1, warning: 0, info: 0, hint: 0 });
            // writeFile 이 확정한 경로가 보고서의 파일 결과로 남는다.
            assert.deepStrictEqual(plain?.artifacts, [artifactPath]);
            // 비밀 파생 태스크는 경로 자체도 남기지 않는다.
            assert.deepStrictEqual(secretWrite?.artifacts, ['***']);
            assert.ok(!serialized.includes(secretArtifactPath), 'secret-derived artifact path leaked into the run log');
            assert.ok(!serialized.includes(secret), 'password-derived value leaked into the persisted run log');
            assert.strictEqual(fs.readFileSync(secretArtifactPath, 'utf8'), secret);
        });
    });

    suite('Task Transition Events', () => {
        // Pins task transition emission: each task in the pipeline
        // surfaces a `running` transition before it starts and a matching
        // terminal transition (`success` / `failure` / `skipped`) after.
        // The Actions panel reads these to render `2/3 · taskId` progress
        // hints. Tests below capture the full event sequence per scenario.

        test('IT-069: 모든 task 성공 시 running → success 쌍이 순서대로 발사', async () => {
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-069',
                tasks: [
                    { id: 'a', type: 'stringManipulation', function: 'trim', input: ' a ' },
                    { id: 'b', type: 'stringManipulation', function: 'trim', input: ' b ' },
                    { id: 'c', type: 'stringManipulation', function: 'trim', input: ' c ' }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it069',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: e => events.push(e) }
            );

            assert.deepStrictEqual(
                events,
                [
                    { taskId: 'a', index: 1, total: 3, state: 'running' },
                    { taskId: 'a', index: 1, total: 3, state: 'success' },
                    { taskId: 'b', index: 2, total: 3, state: 'running' },
                    { taskId: 'b', index: 2, total: 3, state: 'success' },
                    { taskId: 'c', index: 3, total: 3, state: 'running' },
                    { taskId: 'c', index: 3, total: 3, state: 'success' }
                ]
            );
        });

        test('IT-070: continueOnError로 실패한 task는 skipped, 정상 task는 success', async () => {
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-070',
                tasks: [
                    { id: 'first', type: 'stringManipulation', function: 'trim', input: 'a' },
                    {
                        id: 'boom',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'x',
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'v', regex: '(' } },
                        continueOnError: true
                    },
                    { id: 'after', type: 'stringManipulation', function: 'trim', input: 'b' }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it070',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: e => events.push(e) }
            );

            assert.deepStrictEqual(
                events,
                [
                    { taskId: 'first', index: 1, total: 3, state: 'running' },
                    { taskId: 'first', index: 1, total: 3, state: 'success' },
                    { taskId: 'boom', index: 2, total: 3, state: 'running' },
                    { taskId: 'boom', index: 2, total: 3, state: 'skipped' },
                    { taskId: 'after', index: 3, total: 3, state: 'running' },
                    { taskId: 'after', index: 3, total: 3, state: 'success' }
                ]
            );
        });

        test('IT-074: throwing onTaskTransition은 success 경로의 결과를 바꾸지 않는다', async () => {
            // The progress callback is a side channel — a buggy or slow
            // UI hook must NOT cause a successful task to be reported
            // as failed. Reviewer Medium finding: previously the callback
            // was invoked directly so a throw on the `success` transition
            // would propagate up and reject the whole pipeline.
            const seen: string[] = [];
            const throwing = (e: import('../extension').TaskTransitionEvent) => {
                seen.push(`${e.taskId}:${e.state}`);
                throw new Error(`forced ${e.state}`);
            };

            const action: PipelineAction = {
                description: 'IT-074',
                tasks: [
                    { id: 'a', type: 'stringManipulation', function: 'trim', input: 'a' },
                    { id: 'b', type: 'stringManipulation', function: 'trim', input: 'b' }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            // Must resolve cleanly despite every callback throwing.
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it074',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: throwing }
            );

            // All transitions still attempted (helper swallowed each throw)
            assert.deepStrictEqual(seen, [
                'a:running', 'a:success',
                'b:running', 'b:success'
            ]);
        });

        test('IT-074b: throwing onTaskTransition은 failure 경로의 원본 에러를 가리지 않는다', async () => {
            // When a real task fails AND the transition callback also
            // throws on the failure event, the rejection must carry the
            // task's original error — not "callback boom". Otherwise
            // history.output would point at the wrong cause.
            const action: PipelineAction = {
                description: 'IT-074b',
                tasks: [
                    {
                        id: 'fail',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'x',
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'v', regex: '(' } }
                    }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await assert.rejects(
                () => executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it074b',
                    tempWorkspace,
                    [tempWorkspace],
                    {
                        onTaskTransition: () => {
                            throw new Error('callback boom');
                        }
                    }
                ),
                /capture failed/  // task's original error, NOT 'callback boom'
            );
        });

        test('IT-071: 실패 task(continueOnError 없음)는 failure 이벤트 후 파이프라인 중단', async () => {
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-071',
                tasks: [
                    { id: 'ok', type: 'stringManipulation', function: 'trim', input: 'a' },
                    {
                        id: 'fail',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'x',
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'v', regex: '(' } }
                    },
                    { id: 'never', type: 'stringManipulation', function: 'trim', input: 'b' }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await assert.rejects(() => executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it071',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: e => events.push(e) }
            ));

            assert.deepStrictEqual(
                events,
                [
                    { taskId: 'ok', index: 1, total: 3, state: 'running' },
                    { taskId: 'ok', index: 1, total: 3, state: 'success' },
                    { taskId: 'fail', index: 2, total: 3, state: 'running' },
                    { taskId: 'fail', index: 2, total: 3, state: 'failure' }
                    // 'never' task must NOT emit any transition — pipeline
                    // bails on failure when continueOnError is unset.
                ]
            );
        });

        test('IT-075: parallel 다중 실패는 AggregateError로 묶여 모든 cause를 노출', async () => {
            // Two parallel tasks both fail (bad capture regex). The pipeline
            // must throw an AggregateError that carries every cause, not
            // just the first — pre-fix the second failure was only logged
            // via verbose so the user couldn't tell why the second build
            // had also broken. Single-failure callers still see the
            // original error unchanged (covered by IT-074b / IT-071).
            const action: PipelineAction = {
                description: 'IT-075',
                tasks: [
                    {
                        id: 'failA',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'x',
                        parallel: true,
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'va', regex: '(' } }
                    },
                    {
                        id: 'failB',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'y',
                        parallel: true,
                        passTheResultToNextTask: true,
                        output: { capture: { name: 'vb', regex: '(' } }
                    }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            const err: unknown = await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it075',
                tempWorkspace,
                [tempWorkspace]
            ).then(
                () => { throw new Error('expected pipeline to reject for multi-failure'); },
                (e: unknown) => e
            );

            assert.ok(err instanceof Error, 'expected an Error');
            assert.ok(
                err instanceof AggregateError,
                'multi-failure must throw AggregateError, got ' + (err as Error).constructor.name
            );
            const agg = err as AggregateError;
            // Both task ids are mentioned in the summary message.
            assert.match(agg.message, /failA/);
            assert.match(agg.message, /failB/);
            assert.match(agg.message, /it075/);
            // Both causes are preserved on .errors so callers can drill in.
            assert.strictEqual(agg.errors.length, 2);
            for (const cause of agg.errors) {
                assert.ok(cause instanceof Error);
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Parallel execution end-to-end coverage. Pre-existing parallel tests
    // were scheduler unit tests + sync stringManipulation failure cases —
    // none exercised concurrent in-flight scheduling, the maxParallelTasks=1
    // escape hatch, ${producer.output} auto-dep wait, or in-flight drain
    // after a sibling failure. These IT-076..079
    // pin those behaviors against the real scheduler + spawned processes.
    // ─────────────────────────────────────────────────────────────────────
    suite('Parallel Execution (end-to-end)', function () {
        // Each of these spawns a `node -e` process that sleeps; raise the
        // suite-level timeout so a slow CI box still has headroom.
        this.timeout(30000);

        /**
         * Returns a node script that sleeps `ms` milliseconds, prints a
         * unique sentinel, then exits 0. The sentinel lets us anchor
         * downstream `${producer.output}` references in capture tests.
         */
        function sleepAndPrint(ms: number, sentinel: string): string[] {
            return [
                '-e',
                `setTimeout(() => process.stdout.write(${JSON.stringify(sentinel)}), ${ms})`
            ];
        }

        async function withMaxParallelTasks<T>(value: number, body: () => Promise<T>): Promise<T> {
            const cfg = vscode.workspace.getConfiguration('taskhub');
            const previous = cfg.get<number>('pipeline.maxParallelTasks');
            await cfg.update('pipeline.maxParallelTasks', value, vscode.ConfigurationTarget.Global);
            try {
                return await body();
            } finally {
                await cfg.update('pipeline.maxParallelTasks', previous, vscode.ConfigurationTarget.Global);
            }
        }

        test('IT-076: parallel commands both enter in-flight before any terminal event', async () => {
            // Wall-clock thresholds are noisy on Windows process launch.
            // The scheduler invariant is stricter and cheaper to assert:
            // both ready parallel tasks must emit `running` before either
            // task emits a terminal transition.
            const sleepMs = 800;
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-076',
                tasks: [
                    {
                        id: 'a',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: sleepAndPrint(sleepMs, 'A-done'),
                        parallel: true
                    },
                    {
                        id: 'b',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: sleepAndPrint(sleepMs, 'B-done'),
                        parallel: true
                    }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await withMaxParallelTasks(4, () => executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it076',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: e => events.push(e) }
            ));

            const firstTerminalIndex = events.findIndex(e => e.state !== 'running');
            const aRunningIndex = events.findIndex(e => e.taskId === 'a' && e.state === 'running');
            const bRunningIndex = events.findIndex(e => e.taskId === 'b' && e.state === 'running');
            const summary = events.map(e => `${e.taskId}:${e.state}`).join(', ');
            assert.ok(firstTerminalIndex !== -1, `expected terminal transitions, got ${summary}`);
            assert.ok(aRunningIndex !== -1, `expected a:running, got ${summary}`);
            assert.ok(bRunningIndex !== -1, `expected b:running, got ${summary}`);
            assert.ok(
                aRunningIndex < firstTerminalIndex && bRunningIndex < firstTerminalIndex,
                `parallel tasks should both be in-flight before completion; got ${summary}`
            );
        });

        test('IT-077: maxParallelTasks=1 설정 시 parallel: true도 직렬화', async () => {
            // The user knob `taskhub.pipeline.maxParallelTasks` lets a
            // resource-constrained machine force fully sequential
            // execution even when tasks opt into `parallel: true`. The
            // scheduler caps concurrency at 1, so two 600ms sleepers
            // should add up to roughly 1200ms instead of overlapping.
            const cfg = vscode.workspace.getConfiguration('taskhub');
            const previous = cfg.get<number>('pipeline.maxParallelTasks');
            await cfg.update('pipeline.maxParallelTasks', 1, vscode.ConfigurationTarget.Global);
            try {
                const sleepMs = 600;
                const action: PipelineAction = {
                    description: 'IT-077',
                    tasks: [
                        {
                            id: 'a', type: 'command',
                            command: { windows: 'node', macos: 'node', linux: 'node' },
                            args: sleepAndPrint(sleepMs, 'A-done'),
                            parallel: true
                        },
                        {
                            id: 'b', type: 'command',
                            command: { windows: 'node', macos: 'node', linux: 'node' },
                            args: sleepAndPrint(sleepMs, 'B-done'),
                            parallel: true
                        }
                    ]
                };
                const startedAt = Date.now();
                await run(action, 'it077');
                const elapsed = Date.now() - startedAt;

                assert.ok(
                    elapsed >= sleepMs * 2 - 200,
                    `maxParallelTasks=1 should serialize; got ${elapsed}ms (expected ≥ ${sleepMs * 2 - 200}ms)`
                );
            } finally {
                await cfg.update('pipeline.maxParallelTasks', previous, vscode.ConfigurationTarget.Global);
            }
        });

        test('IT-078: ${producer.output} auto-dep makes consumer wait for producer', async () => {
            // `consumer` is parallel: true with a `${producer.output}`
            // ref; auto-inference must add producer as a dep so the
            // consumer cannot start while producer is still sleeping.
            // We assert both the transition order and the substituted
            // value that the consumer echoes into a file.
            const resultPath = path.join(tempWorkspace, 'it078.txt');
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-078',
                tasks: [
                    {
                        id: 'producer',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: sleepAndPrint(500, 'PROD-OK'),
                        parallel: true,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'consumer',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        // Echo the producer's stdout so the test can
                        // verify the value was actually substituted.
                        args: ['-e', 'process.stdout.write(process.argv[1])', '${producer.output}'],
                        parallel: true,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'verify',
                        type: 'writeFile',
                        path: resultPath,
                        content: '${consumer.output}'
                    }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it078',
                tempWorkspace,
                [tempWorkspace],
                { onTaskTransition: e => events.push(e) }
            );

            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'PROD-OK');
            const producerSuccessIndex = events.findIndex(e => e.taskId === 'producer' && e.state === 'success');
            const consumerRunningIndex = events.findIndex(e => e.taskId === 'consumer' && e.state === 'running');
            const summary = events.map(e => `${e.taskId}:${e.state}`).join(', ');
            assert.ok(producerSuccessIndex !== -1, `expected producer:success, got ${summary}`);
            assert.ok(consumerRunningIndex !== -1, `expected consumer:running, got ${summary}`);
            assert.ok(
                producerSuccessIndex < consumerRunningIndex,
                `consumer must wait for producer output before starting; got ${summary}`
            );
        });

        test('IT-079: failed sibling still waits for every in-flight sibling to drain', async () => {
            // Three parallel tasks: `quickFail` fails fast (~100ms),
            // `slow` runs ~700ms, `medium` runs ~400ms. After quickFail
            // aborts new scheduling, every in-flight sibling must be
            // awaited; the pipeline cannot resolve until they drain.
            // We assert the elapsed time is at least slow's duration —
            // pre-fix a buggy abort path could have rejected as soon as
            // quickFail threw, leaving the two siblings dangling.
            const slowMs = 700;
            const events: import('../extension').TaskTransitionEvent[] = [];
            const action: PipelineAction = {
                description: 'IT-079',
                tasks: [
                    {
                        id: 'quickFail',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        // Exit 1 quickly so it becomes the abort trigger.
                        args: ['-e', 'setTimeout(() => process.exit(1), 100)'],
                        parallel: true
                    },
                    {
                        id: 'slow',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: sleepAndPrint(slowMs, 'SLOW-OK'),
                        parallel: true
                    },
                    {
                        id: 'medium',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: sleepAndPrint(400, 'MED-OK'),
                        parallel: true
                    }
                ]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            let elapsed = 0;
            const err: unknown = await withMaxParallelTasks(4, async () => {
                const startedAt = Date.now();
                const caught = await executeActionPipeline(
                    action,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it079',
                    tempWorkspace,
                    [tempWorkspace],
                    { onTaskTransition: e => events.push(e) }
                ).then(() => null, (e: unknown) => e);
                elapsed = Date.now() - startedAt;
                return caught;
            });

            assert.ok(err instanceof Error, 'pipeline must reject when a non-continueOnError task fails');
            assert.ok(
                elapsed >= slowMs - 100,
                `pipeline must drain in-flight siblings; rejected after ${elapsed}ms but slow needs ~${slowMs}ms`
            );

            // Every started task must emit a terminal event — we
            // expect 3 running + at least 1 failure + ≥ 1 success/failure
            // for each of slow & medium (timing-dependent which terminal
            // state exactly, but they must NOT remain in `running`).
            const terminalCount = events.filter(e =>
                e.state === 'success' || e.state === 'failure' || e.state === 'skipped'
            ).length;
            const runningCount = events.filter(e => e.state === 'running').length;
            assert.strictEqual(terminalCount, runningCount,
                `every running task must reach a terminal state; running=${runningCount} terminal=${terminalCount}`);
        });
    });

    suite('Problem Matcher / Diagnostics', () => {
        // Pins problem matcher diagnostics: shell task output is parsed by configured matcher
        // patterns, and the resulting diagnostics show up in the VS Code
        // Problems panel via `vscode.languages.getDiagnostics(uri)`.

        function makeFakeContextForDiagnostics(): vscode.ExtensionContext {
            const workspaceState = new Map<string, unknown>();
            return {
                extensionPath: path.resolve(__dirname, '..', '..'),
                subscriptions: [],
                workspaceState: {
                    get: <T>(key: string, def?: T) =>
                        workspaceState.has(key) ? (workspaceState.get(key) as T) : def,
                    update: (key: string, val: unknown) => {
                        workspaceState.set(key, val);
                        return Promise.resolve();
                    },
                    keys: () => Array.from(workspaceState.keys())
                },
                globalState: {
                    get: <T>(_k: string, d?: T) => d,
                    update: () => Promise.resolve(),
                    keys: () => [],
                    setKeysForSync: () => { /* no-op */ }
                },
                extensionMode: vscode.ExtensionMode.Test,
                extension: { packageJSON: { version: '9.9.9-test' } }
            } as unknown as vscode.ExtensionContext;
        }

        /** Emit a multi-line gcc-style stdout via `node -e`, then capture it. */
        function gccStyleAction(actionId: string, lines: string[], opts?: { cwd?: string }): ActionItem {
            return {
                id: actionId,
                title: actionId,
                action: {
                    description: actionId,
                    tasks: [{
                        id: 'compile',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: nodeMultilineArgs(lines),
                        cwd: opts?.cwd,
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' }
                    }]
                }
            };
        }

        test('IT-075: shell task의 $gcc 매처가 Problems 패널에 진단을 등록', async () => {
            // Create real files in tempWorkspace so resolved URIs point at
            // existing inodes — VS Code Problems UI doesn't care, but it
            // makes the test more lifelike.
            const mainCAbsPath = path.join(tempWorkspace, 'src', 'main.c');
            fs.mkdirSync(path.dirname(mainCAbsPath), { recursive: true });
            fs.writeFileSync(mainCAbsPath, 'int main() { return 0; }\n');

            const ctx = makeFakeContextForDiagnostics();
            const item = gccStyleAction('it075', [
                `${mainCAbsPath}:42:5: error: 'foo' undeclared`,
                `${mainCAbsPath}:73:12: warning: unused variable 'tmp'`
            ], { cwd: tempWorkspace });
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            await executeAction(item, ctx, mainView, history);

            const uri = vscode.Uri.file(mainCAbsPath);
            const diags = vscode.languages.getDiagnostics(uri);
            // Filter to ONLY the diagnostics owned by this action (other
            // tests in the same VS Code session may have left their own).
            const taskhubDiags = diags.filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(taskhubDiags.length, 2,
                `expected 2 diagnostics on ${uri.fsPath}, got ${taskhubDiags.length}`);

            const errorDiag = taskhubDiags.find(d => d.severity === vscode.DiagnosticSeverity.Error);
            assert.ok(errorDiag);
            assert.strictEqual(errorDiag!.range.start.line, 41);   // 42 - 1 (0-based)
            assert.strictEqual(errorDiag!.range.start.character, 4); // 5 - 1
            assert.ok(errorDiag!.message.includes("'foo' undeclared"));

            const warnDiag = taskhubDiags.find(d => d.severity === vscode.DiagnosticSeverity.Warning);
            assert.ok(warnDiag);
            assert.strictEqual(warnDiag!.range.start.line, 72);
        });

        test('IT-076: 같은 액션 재실행 시 이전 진단이 자동 clear', async () => {
            const mainCAbsPath = path.join(tempWorkspace, 'src', 'rerun.c');
            fs.mkdirSync(path.dirname(mainCAbsPath), { recursive: true });
            fs.writeFileSync(mainCAbsPath, 'int main(){}');

            const ctx = makeFakeContextForDiagnostics();
            const history = new HistoryProvider(ctx);

            // First run: produce one error
            const failItem = gccStyleAction('it076', [
                `${mainCAbsPath}:10:1: error: oops`
            ], { cwd: tempWorkspace });
            const mainView1 = new MainViewProvider(ctx, () => [failItem]);
            await executeAction(failItem, ctx, mainView1, history);

            const uri = vscode.Uri.file(mainCAbsPath);
            const before = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(before.length, 1, 'first run should produce 1 diagnostic');

            // Second run: produce zero errors — collection should clear.
            const cleanItem = gccStyleAction('it076', [
                'build complete (no errors)'
            ], { cwd: tempWorkspace });
            const mainView2 = new MainViewProvider(ctx, () => [cleanItem]);
            await executeAction(cleanItem, ctx, mainView2, history);

            const after = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(after.length, 0,
                `second clean run must clear the prior diagnostic, got ${after.length}: ${JSON.stringify(after.map(d => d.message))}`);
        });

        test('IT-077: 상대 경로 진단은 task의 cwd 기준으로 절대 경로 해석', async () => {
            // Create file at <tempWorkspace>/sub/relpath.c
            const subDir = path.join(tempWorkspace, 'sub');
            fs.mkdirSync(subDir, { recursive: true });
            const relFile = path.join(subDir, 'relpath.c');
            fs.writeFileSync(relFile, '');

            const ctx = makeFakeContextForDiagnostics();
            // Compiler emits a *relative* path "relpath.c" with cwd set to subDir.
            // Must resolve to <tempWorkspace>/sub/relpath.c, NOT <tempWorkspace>/relpath.c.
            const item = gccStyleAction('it077', [
                'relpath.c:7:3: error: relative-path test'
            ], { cwd: subDir });
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            await executeAction(item, ctx, mainView, history);

            const expectedUri = vscode.Uri.file(relFile);
            const diags = vscode.languages.getDiagnostics(expectedUri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(diags.length, 1,
                `expected diagnostic at ${expectedUri.fsPath}, got ${diags.length}`);

            // And NOT at the wrong (workspace-root) path.
            const wrongUri = vscode.Uri.file(path.join(tempWorkspace, 'relpath.c'));
            const wrongDiags = vscode.languages.getDiagnostics(wrongUri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(wrongDiags.length, 0,
                'relative path must not resolve against the workspace root when task.cwd is set');
        });

        test('IT-079: gcc 같은 non-zero exit 빌드 실패에서도 진단이 등록되어야 한다 (1차 리뷰 High)', async () => {
            // 가장 흔한 빌드 실패 케이스: 컴파일러가 stderr에 진단을 쓰고
            // exit code 1로 종료. 이전 구현은 `await handleCommand`가 throw
            // 되면 그 자리에서 catch가 못 잡아 post-processing 진단 블록까지
            // 도달 못 했음 — 정작 진단이 가장 필요한 케이스를 놓쳤음. 이제는
            // ShellCommandError가 stdout/stderr를 보존하고, shell/command
            // 분기의 try/catch가 매처를 적용한 뒤 원본 에러를 re-throw 한다.
            const targetFile = path.join(tempWorkspace, 'broken.c');
            fs.writeFileSync(targetFile, 'int main() { return undefined; }\n');

            const ctx = makeFakeContextForDiagnostics();
            // node로 stderr에 gcc-style 출력을 찍고 exit code 1로 종료.
            const errorScript = `
                process.stderr.write(${JSON.stringify(`${targetFile}:1:14: error: 'undefined' undeclared\n`)});
                process.exit(1);
            `.trim();
            const item: ActionItem = {
                id: 'it079',
                title: 'IT-079',
                action: {
                    description: 'IT-079',
                    failMessage: 'IT-079 failed',
                    tasks: [{
                        id: 'failing-build',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: ['-e', errorScript],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' }
                    }]
                }
            };
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            // executeAction은 실패를 throw하지만, 실패하기 전에 진단은 등록되어야 함.
            // showErrorMessage 모킹해 spurious dialog 방지.
            const originalShowError = vscode.window.showErrorMessage;
            (vscode.window as any).showErrorMessage = async () => undefined;
            try {
                await assert.rejects(() => executeAction(item, ctx, mainView, history));
            } finally {
                (vscode.window as any).showErrorMessage = originalShowError;
            }

            // history도 failure로 기록되어야 함 — 원본 의미 보존 확인.
            const entries = history.getHistory();
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].status, 'failure',
                'task의 non-zero exit는 그대로 action failure로 기록되어야 함');

            // 진단은 등록되어야 함 — 핵심 회귀 가드.
            const uri = vscode.Uri.file(targetFile);
            const diags = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(diags.length, 1,
                `non-zero exit 후에도 진단이 등록되어야 함 — got ${diags.length}`);
            assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Error);
            assert.ok(diags[0].message.includes("'undefined' undeclared"));
        });

        test('IT-081: exit 0 빌드가 stderr에 warning을 쓰면 진단이 등록된다 (2차 리뷰 Medium)', async () => {
            // gcc/clang이 warning만 있을 때 흔한 패턴: exit 0으로 정상 종료
            // 하면서도 stderr에 진단을 출력. 초기 구현은 성공 경로에서
            // executeShellCommand가 stdout만 resolve해서 stderr가 매처에
            // 닿지 않았음 — IT-079(failure 경로)와의 비대칭. 이제는
            // executeShellCommand가 {stdout, stderr} 튜플을 resolve하고
            // handleCommand가 둘 다 result로 노출, post-processing 진단
            // 블록이 두 스트림을 합쳐 매처에 통과시킴.
            const targetFile = path.join(tempWorkspace, 'warn.c');
            fs.writeFileSync(targetFile, 'int x;\n');

            const ctx = makeFakeContextForDiagnostics();
            // node로 stdout에는 빌드 OK, stderr에는 gcc-style warning을
            // 찍고 exit 0으로 정상 종료.
            const successWithWarningScript = `
                process.stdout.write('compile finished');
                process.stderr.write(${JSON.stringify(`${targetFile}:1:5: warning: unused variable 'x' [-Wunused-variable]\n`)});
                process.exit(0);
            `.trim();
            const item: ActionItem = {
                id: 'it081',
                title: 'IT-081',
                action: {
                    description: 'IT-081',
                    tasks: [{
                        id: 'build-with-warn',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: ['-e', successWithWarningScript],
                        cwd: tempWorkspace,
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$gcc' }
                    }]
                }
            };
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            await executeAction(item, ctx, mainView, history);

            // action은 성공으로 기록 (exit 0이므로).
            const entries = history.getHistory();
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].status, 'success');

            // 진단은 stderr에서 추출되어 등록되어야 함 — 핵심 회귀 가드.
            const uri = vscode.Uri.file(targetFile);
            const diags = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(diags.length, 1,
                `exit 0 + stderr warning에서 진단이 등록되어야 함 — got ${diags.length}`);
            assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
            assert.ok(diags[0].message.includes("unused variable 'x'"));
        });

        test('IT-082: 같은 액션의 여러 task가 같은 파일에 진단을 내면 모두 보존 (3차 리뷰 Medium)', async () => {
            // collection.set(uri, ...)는 해당 URI의 기존 entry 전체를
            // *replace*하는 의미이므로, 같은 액션 안에서 두 번째 task가
            // 같은 파일에 진단을 내면 첫 번째 task의 진단이 덮여 사라짐.
            // applyDiagnosticsToCollection이 collection.get(uri)을 먼저
            // 읽어 merge한 뒤 set 하도록 수정. 액션 시작의 clear는 이전
            // run의 진단만 비우므로, 이번 run에서 누적된 sibling 진단은
            // 그대로 보존됨.
            const targetFile = path.join(tempWorkspace, 'shared.c');
            fs.writeFileSync(targetFile, '');

            const ctx = makeFakeContextForDiagnostics();
            const item: ActionItem = {
                id: 'it082',
                title: 'IT-082',
                action: {
                    description: 'IT-082',
                    tasks: [
                        {
                            id: 'compile',
                            type: 'command',
                            command: { windows: 'node', macos: 'node', linux: 'node' },
                            args: nodeMultilineArgs([`${targetFile}:42:5: warning: from compile task`]),
                            cwd: tempWorkspace,
                            passTheResultToNextTask: true,
                            output: { diagnostics: '$gcc' }
                        },
                        {
                            id: 'lint',
                            type: 'command',
                            command: { windows: 'node', macos: 'node', linux: 'node' },
                            args: nodeMultilineArgs([`${targetFile}:73:12: error: from lint task`]),
                            cwd: tempWorkspace,
                            passTheResultToNextTask: true,
                            output: { diagnostics: '$gcc' }
                        }
                    ]
                }
            };
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            await executeAction(item, ctx, mainView, history);

            const uri = vscode.Uri.file(targetFile);
            const diags = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(diags.length, 2,
                `compile + lint 두 task의 진단이 모두 보존되어야 함 — got ${diags.length}: ${JSON.stringify(diags.map(d => d.message))}`);

            const warning = diags.find(d => d.severity === vscode.DiagnosticSeverity.Warning);
            const error = diags.find(d => d.severity === vscode.DiagnosticSeverity.Error);
            assert.ok(warning, 'compile task의 warning이 보존되어야 함');
            assert.ok(warning!.message.includes('from compile task'));
            assert.ok(error, 'lint task의 error가 보존되어야 함');
            assert.ok(error!.message.includes('from lint task'));
        });

        test('IT-080: 진단 cwd는 interpolated된 cwd를 사용한다 (1차 리뷰 Medium)', async () => {
            // task.cwd에 ${workspaceFolder} 같은 변수가 들어가면 실제 명령은
            // interpolated된 경로에서 실행됨. 진단의 상대 경로 해석도 같은
            // (interpolated된) 경로 기준이어야 한다 — 이전 구현은 raw task.cwd
            // 를 그대로 읽어 잘못된 위치로 resolve 됐음.
            //
            // 이 테스트는 executeActionPipeline을 직접 호출 — executeAction은
            // workspaceFolder를 actionWorkspaceFolderMap을 통해 받는데 그
            // map은 모듈 private이라 테스트에서 명시적으로 주입할 수 없음.
            const subDir = path.join(tempWorkspace, 'subdir');
            fs.mkdirSync(subDir, { recursive: true });
            const relFile = path.join(subDir, 'interp.c');
            fs.writeFileSync(relFile, '');

            const action: PipelineAction = {
                description: 'IT-080',
                tasks: [{
                    id: 'compile',
                    type: 'command',
                    command: { windows: 'node', macos: 'node', linux: 'node' },
                    args: nodeMultilineArgs(['interp.c:5:1: error: interpolation test']),
                    // 변수 치환을 통해 cwd를 동적으로 결정 — pipeline 내부에서
                    // ${workspaceFolder}는 호출 시 전달한 workspaceFolderPath
                    // (= tempWorkspace)로 resolve.
                    cwd: '${workspaceFolder}/subdir',
                    passTheResultToNextTask: true,
                    output: { diagnostics: '$gcc' }
                }]
            };

            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                action,
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it080',
                tempWorkspace,
                [tempWorkspace]
            );

            // 정확한 위치(<workspace>/subdir/interp.c)에 진단 등록 — interpolated
            // cwd(<tempWorkspace>/subdir)가 상대 경로 'interp.c'의 base가 됨.
            const correctUri = vscode.Uri.file(relFile);
            const correctDiags = vscode.languages.getDiagnostics(correctUri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(correctDiags.length, 1,
                `interpolated cwd(${subDir}) 기준으로 진단이 등록되어야 함`);

            // 잘못된 workspace 루트에는 등록 안 됨.
            const wrongUri = vscode.Uri.file(path.join(tempWorkspace, 'interp.c'));
            const wrongDiags = vscode.languages.getDiagnostics(wrongUri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(wrongDiags.length, 0,
                'raw task.cwd("${workspaceFolder}/subdir")가 그대로 사용되면 안 됨 (interpolated 경로여야 함)');
        });

        test('IT-078: passTheResultToNextTask: false에서는 진단 emission이 silent skip', async () => {
            // The shell stream path doesn't capture output, so diagnostics
            // can't be parsed. Should be a silent skip (verbose log warning
            // only) — no crash, no spurious diagnostics.
            const noEmitFile = path.join(tempWorkspace, 'never.c');
            fs.writeFileSync(noEmitFile, '');

            const ctx = makeFakeContextForDiagnostics();
            const item: ActionItem = {
                id: 'it078',
                title: 'IT-078',
                action: {
                    description: 'IT-078',
                    tasks: [{
                        id: 'streamed',
                        type: 'command',
                        command: { windows: 'node', macos: 'node', linux: 'node' },
                        args: nodeMultilineArgs([`${noEmitFile}:1:1: error: should-not-appear`]),
                        cwd: tempWorkspace,
                        passTheResultToNextTask: false,                  // streamed, not captured
                        output: { diagnostics: '$gcc' } as any           // diagnostics declared but unreachable
                    }]
                }
            };
            const history = new HistoryProvider(ctx);
            const mainView = new MainViewProvider(ctx, () => [item]);

            await executeAction(item, ctx, mainView, history);

            const uri = vscode.Uri.file(noEmitFile);
            const diags = vscode.languages.getDiagnostics(uri).filter(d => d.source && d.source.startsWith('gcc'));
            assert.strictEqual(diags.length, 0,
                'streamed task must not produce diagnostics — silent skip');
        });
    });

    suite('Task Output Flow', () => {
        test('IT-029: passTheResultToNextTask=false는 downstream에서 output을 보이지 않음', async () => {
            const resultPath = path.join(tempWorkspace, 'it029.txt');
            const action: PipelineAction = {
                description: 'IT-029',
                tasks: [
                    {
                        id: 'silent',
                        type: 'shell',
                        command: echoOneLine('released=R42'),
                        passTheResultToNextTask: false
                    },
                    {
                        id: 'probe',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: 'got=${silent.output};raw=${silent.raw}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                'got=${silent.output};raw=${silent.raw}'
            );
        });

        test('IT-030: stringManipulation 경로 연산 전체 체인', async () => {
            const resultPath = path.join(tempWorkspace, 'it030.txt');
            const input = '/tmp/project/assets/logo.final.png';
            const action: PipelineAction = {
                description: 'IT-030',
                tasks: [
                    {
                        id: 'base',
                        type: 'stringManipulation',
                        function: 'basename',
                        input,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'stem',
                        type: 'stringManipulation',
                        function: 'basenameWithoutExtension',
                        input: '${base.output}',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'stripped',
                        type: 'stringManipulation',
                        function: 'stripExtension',
                        input,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'dir',
                        type: 'stringManipulation',
                        function: 'dirname',
                        input,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'ext',
                        type: 'stringManipulation',
                        function: 'extension',
                        input,
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'write',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: [
                            'base=${base.output}',
                            'stem=${stem.output}',
                            'stripped=${stripped.output}',
                            'dir=${dir.output}',
                            'ext=${ext.output}'
                        ].join('\n'),
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                [
                    'base=logo.final.png',
                    'stem=logo.final',
                    'stripped=/tmp/project/assets/logo.final',
                    'dir=/tmp/project/assets',
                    'ext=png'
                ].join('\n')
            );
        });
    });

    suite('Pipeline Error Handling', () => {
        test('IT-031: 지원하지 않는 task type은 실행 시 에러', async () => {
            const action = {
                description: 'IT-031',
                tasks: [
                    {
                        id: 'bogus',
                        type: 'nonexistent-type'
                    }
                ]
            } as unknown as PipelineAction;
            await assert.rejects(
                () => run(action),
                /Unsupported task type: nonexistent-type/
            );
        });

        test('IT-032: shell task에 command가 없으면 실행 시 에러', async () => {
            const action = {
                description: 'IT-032',
                tasks: [
                    {
                        id: 'missing',
                        type: 'shell'
                    }
                ]
            } as unknown as PipelineAction;
            await assert.rejects(
                () => run(action),
                /Task missing of type 'shell' requires a 'command'/
            );
        });
    });

    suite('writeFile / appendFile', () => {
        test('IT-043: writeFile은 변수 치환된 content를 정확히 기록한다', async () => {
            const target = path.join(tempWorkspace, 'reports', 'version.txt');
            const action: PipelineAction = {
                description: 'IT-043',
                tasks: [
                    {
                        id: 'tag',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: '  v1.2.3  ',
                        passTheResultToNextTask: true
                    },
                    {
                        id: 'write',
                        type: 'writeFile',
                        path: 'reports/version.txt',
                        content: 'release=${tag.output}\nbuilt=ok\n'
                    }
                ]
            };
            await run(action);
            assert.ok(fs.existsSync(target), 'target file should exist');
            assert.strictEqual(
                fs.readFileSync(target, 'utf8'),
                'release=v1.2.3\nbuilt=ok\n'
            );
        });

        test('IT-044: writeFile은 워크스페이스 외부 경로를 거부한다', async () => {
            const action: PipelineAction = {
                description: 'IT-044',
                tasks: [
                    {
                        id: 'escape',
                        type: 'writeFile',
                        path: '../escape.txt',
                        content: 'nope'
                    }
                ]
            };
            await assert.rejects(() => run(action), /outside the current workspace/);
        });

        test('IT-045: writeFile + overwrite=false는 기존 파일을 덮어쓰지 않고 실패한다', async () => {
            const target = path.join(tempWorkspace, 'lock.txt');
            fs.writeFileSync(target, 'original');
            const action: PipelineAction = {
                description: 'IT-045',
                tasks: [
                    {
                        id: 'no-clobber',
                        type: 'writeFile',
                        path: 'lock.txt',
                        content: 'replaced',
                        overwrite: false
                    }
                ]
            };
            await assert.rejects(() => run(action), /refused to overwrite/);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'original');
        });

        test('IT-046: writeFile + overwrite=true(기본값)는 기존 파일을 덮어쓴다', async () => {
            const target = path.join(tempWorkspace, 'replace.txt');
            fs.writeFileSync(target, 'old');
            const action: PipelineAction = {
                description: 'IT-046',
                tasks: [
                    {
                        id: 'clobber',
                        type: 'writeFile',
                        path: 'replace.txt',
                        content: 'new'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
        });

        test('IT-047: writeFile은 mkdirs=true(기본값)일 때 상위 디렉터리를 자동 생성한다', async () => {
            const target = path.join(tempWorkspace, 'a', 'b', 'c', 'leaf.txt');
            const action: PipelineAction = {
                description: 'IT-047',
                tasks: [
                    {
                        id: 'deep',
                        type: 'writeFile',
                        path: 'a/b/c/leaf.txt',
                        content: 'x'
                    }
                ]
            };
            await run(action);
            assert.ok(fs.existsSync(target));
        });

        test('IT-048: writeFile + mkdirs=false는 상위 디렉터리가 없으면 실패한다', async () => {
            const action: PipelineAction = {
                description: 'IT-048',
                tasks: [
                    {
                        id: 'strict',
                        type: 'writeFile',
                        path: 'no/such/dir/file.txt',
                        content: 'x',
                        mkdirs: false
                    }
                ]
            };
            await assert.rejects(() => run(action), /parent directory does not exist/);
        });

        test('IT-049: writeFile은 EOL 정규화를 적용한다 (lf, crlf)', async () => {
            const lfPath = path.join(tempWorkspace, 'eol-lf.txt');
            const crlfPath = path.join(tempWorkspace, 'eol-crlf.txt');
            const action: PipelineAction = {
                description: 'IT-049',
                tasks: [
                    {
                        id: 'lf',
                        type: 'writeFile',
                        path: 'eol-lf.txt',
                        content: 'a\r\nb\r\nc',
                        eol: 'lf'
                    },
                    {
                        id: 'crlf',
                        type: 'writeFile',
                        path: 'eol-crlf.txt',
                        content: 'a\nb\nc',
                        eol: 'crlf'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(lfPath, 'utf8'), 'a\nb\nc');
            assert.strictEqual(fs.readFileSync(crlfPath, 'utf8'), 'a\r\nb\r\nc');
        });

        test('IT-050: writeFile + utf8bom은 BOM(0xEF 0xBB 0xBF)을 선두에 기록한다', async () => {
            const target = path.join(tempWorkspace, 'with-bom.txt');
            const action: PipelineAction = {
                description: 'IT-050',
                tasks: [
                    {
                        id: 'bom',
                        type: 'writeFile',
                        path: 'with-bom.txt',
                        content: 'hi',
                        encoding: 'utf8bom'
                    }
                ]
            };
            await run(action);
            const buf = fs.readFileSync(target);
            assert.strictEqual(buf[0], 0xef);
            assert.strictEqual(buf[1], 0xbb);
            assert.strictEqual(buf[2], 0xbf);
            assert.strictEqual(buf.slice(3).toString('utf8'), 'hi');
        });

        test('IT-051: appendFile은 기존 파일에 이어서 쓴다', async () => {
            const target = path.join(tempWorkspace, 'log.txt');
            fs.writeFileSync(target, 'line1\n');
            const action: PipelineAction = {
                description: 'IT-051',
                tasks: [
                    {
                        id: 'add',
                        type: 'appendFile',
                        path: 'log.txt',
                        content: 'line2\n'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'line1\nline2\n');
        });

        test('IT-052: appendFile은 파일이 없으면 새 파일을 만든다 (utf8bom 포함)', async () => {
            const target = path.join(tempWorkspace, 'fresh-log.txt');
            const action: PipelineAction = {
                description: 'IT-052',
                tasks: [
                    {
                        id: 'first',
                        type: 'appendFile',
                        path: 'fresh-log.txt',
                        content: 'header',
                        encoding: 'utf8bom'
                    }
                ]
            };
            await run(action);
            const buf = fs.readFileSync(target);
            assert.strictEqual(buf[0], 0xef, 'first appendFile to a missing file should plant BOM');
            assert.strictEqual(buf.slice(3).toString('utf8'), 'header');
        });

        test('IT-053: appendFile + utf8bom은 기존 파일 중간에 BOM을 삽입하지 않는다', async () => {
            const target = path.join(tempWorkspace, 'no-mid-bom.txt');
            fs.writeFileSync(target, 'pre');
            const action: PipelineAction = {
                description: 'IT-053',
                tasks: [
                    {
                        id: 'append',
                        type: 'appendFile',
                        path: 'no-mid-bom.txt',
                        content: 'post',
                        encoding: 'utf8bom'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'prepost');
        });

        test('IT-054: writeFile 결과 ${task.path}는 downstream에서 사용 가능', async () => {
            const action: PipelineAction = {
                description: 'IT-054',
                tasks: [
                    {
                        id: 'write',
                        type: 'writeFile',
                        path: 'output.json',
                        content: '{"ok":true}'
                    },
                    {
                        id: 'rename',
                        type: 'stringManipulation',
                        function: 'basename',
                        input: '${write.path}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: 'name.txt', overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(
                fs.readFileSync(path.join(tempWorkspace, 'name.txt'), 'utf8'),
                'output.json'
            );
        });

        test('IT-055: writeFile은 path 누락 시 즉시 에러', async () => {
            const action = {
                description: 'IT-055',
                tasks: [
                    { id: 'broken', type: 'writeFile', content: 'x' }
                ]
            } as unknown as PipelineAction;
            await assert.rejects(() => run(action), /requires a non-empty 'path' property/);
        });

        test('IT-056: writeFile은 content 누락 시 즉시 에러', async () => {
            const action = {
                description: 'IT-056',
                tasks: [
                    { id: 'broken', type: 'writeFile', path: 'x.txt' }
                ]
            } as unknown as PipelineAction;
            await assert.rejects(() => run(action), /requires a 'content' property/);
        });
    });

    suite('continueOnError', () => {
        test('IT-057: 실패한 task에 continueOnError=true이면 다음 task 실행', async () => {
            const target = path.join(tempWorkspace, 'after.txt');
            const action: PipelineAction = {
                description: 'IT-057',
                tasks: [
                    {
                        id: 'oops',
                        type: 'writeFile',
                        path: '../escape.txt', // workspace escape → fail
                        content: 'nope',
                        continueOnError: true
                    },
                    {
                        id: 'after',
                        type: 'writeFile',
                        path: 'after.txt',
                        content: 'survived'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'survived');
        });

        test('IT-058: continueOnError로 스킵된 task의 ${task.path}는 unresolved literal로 남는다', async () => {
            const target = path.join(tempWorkspace, 'downstream.txt');
            const action: PipelineAction = {
                description: 'IT-058',
                tasks: [
                    {
                        id: 'skipped',
                        type: 'writeFile',
                        path: '../bad.txt',
                        content: 'x',
                        continueOnError: true
                    },
                    {
                        id: 'downstream',
                        type: 'writeFile',
                        path: 'downstream.txt',
                        content: 'ref=${skipped.path}'
                    }
                ]
            };
            await run(action);
            // The skipped task's result is `{}`, so the literal `${skipped.path}`
            // survives interpolation.
            assert.strictEqual(
                fs.readFileSync(target, 'utf8'),
                'ref=${skipped.path}'
            );
        });

        test('IT-059: continueOnError가 false(기본값)이면 첫 실패에서 중단', async () => {
            const target = path.join(tempWorkspace, 'never.txt');
            const action: PipelineAction = {
                description: 'IT-059',
                tasks: [
                    {
                        id: 'oops',
                        type: 'writeFile',
                        path: '../escape.txt',
                        content: 'x'
                    },
                    {
                        id: 'never',
                        type: 'writeFile',
                        path: 'never.txt',
                        content: 'should-not-run'
                    }
                ]
            };
            await assert.rejects(() => run(action), /outside the current workspace/);
            assert.ok(!fs.existsSync(target), 'second task should never have executed');
        });
    });

    suite('timeoutSeconds', () => {
        // We exercise timeoutSeconds against a real long-running shell process
        // (sleep / Start-Sleep). writeFile-only pipelines wouldn't work here
        // because the handler's body is synchronous (fs.writeFileSync), and
        // microtasks beat the setTimeout macrotask, so the race is rigged.
        function sleepCmd(seconds: number) {
            return {
                windows: `powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}"`,
                macos: `sleep ${seconds}`,
                linux: `sleep ${seconds}`,
            };
        }

        test('IT-060: 짧은 timeoutSeconds는 실행 중인 shell process를 종료시킨다', async function () {
            this.timeout(10000);
            const action: PipelineAction = {
                description: 'IT-060',
                tasks: [
                    {
                        id: 'slow',
                        type: 'shell',
                        command: sleepCmd(10),
                        passTheResultToNextTask: true,
                        timeoutSeconds: 0.5
                    }
                ]
            };
            const start = Date.now();
            await assert.rejects(() => run(action), /timed out after 0\.5s/);
            const elapsed = Date.now() - start;
            // Should be terminated quickly — well under the 10-second sleep.
            assert.ok(
                elapsed < 5000,
                `expected to terminate quickly, took ${elapsed}ms`
            );
        });

        test('IT-061: 충분한 timeoutSeconds는 task를 정상 완료시킨다', async () => {
            const target = path.join(tempWorkspace, 'within-budget.txt');
            const action: PipelineAction = {
                description: 'IT-061',
                tasks: [
                    {
                        id: 'fast',
                        type: 'writeFile',
                        path: 'within-budget.txt',
                        content: 'done',
                        timeoutSeconds: 30
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'done');
        });

        test('IT-062: timeout + continueOnError이면 다음 task가 실행된다', async function () {
            this.timeout(10000);
            const target = path.join(tempWorkspace, 'after-timeout.txt');
            const action: PipelineAction = {
                description: 'IT-062',
                tasks: [
                    {
                        id: 'slow',
                        type: 'shell',
                        command: sleepCmd(10),
                        passTheResultToNextTask: true,
                        timeoutSeconds: 0.5,
                        continueOnError: true
                    },
                    {
                        id: 'after',
                        type: 'writeFile',
                        path: 'after-timeout.txt',
                        content: 'survived'
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), 'survived');
        });
    });

    /**
     * `quickPick` 의 `value` 매핑과 배열 확장을 **실제 프로세스가 본 argv** 로
     * 확인한다 (0.7.31).
     *
     * 단위 테스트는 문자열 조립까지만 본다. 여기서 보려는 것은 그 문자열이
     * 실제 spawn 을 거친 뒤에도 같은 경계로 도착하는가다 — 사용자가 신고한
     * 증상(`"파일명 파일명"` 인자 한 칸)이 정확히 조립과 실행 사이에서 났다.
     */
    suite('quickPick value 매핑과 배열 확장', () => {
        /** 받은 인자를 JSON 으로 적는 스크립트. 경계를 보려면 프로세스가 본 것을 봐야 한다. */
        function writeArgvProbe(): { script: string; out: string } {
            const script = path.join(tempWorkspace, 'argv-probe.js');
            fs.writeFileSync(
                script,
                "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n"
            );
            // Windows 에서도 `/` 를 쓰면 명령 문자열의 역슬래시 escape 를 피할 수 있다.
            const forward = (p: string) => p.split(path.sep).join('/');
            return { script: forward(script), out: forward(path.join(tempWorkspace, 'argv-probe.json')) };
        }

        function readArgv(): string[] {
            return JSON.parse(fs.readFileSync(path.join(tempWorkspace, 'argv-probe.json'), 'utf8'));
        }

        async function pickAndRun(label: string, items: any[], task: any, id: string): Promise<void> {
            const originalShowQuickPick = vscode.window.showQuickPick;
            try {
                // VS Code 는 **넘긴 항목 객체 그대로** 돌려준다.
                (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) =>
                    entries.find(entry => entry.label === label);
                await run({
                    description: id,
                    tasks: [{ id: 'mode', type: 'quickPick', items }, task],
                }, id);
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        }

        /** 요청받은 그림 그대로: 선택지마다 옵션을 붙이거나·붙이지 않거나·다른 옵션을 붙인다. */
        const modeItems = [
            { label: 'Label-A', value: '--with-option' },
            { label: 'Label-B', value: [] },
            { label: 'Label-C', value: ['--option', 'b'] },
            { label: 'Label-D' },
        ];

        test('IT-160: command 문자열의 quickPick value 가 실제 argv 경계를 만든다', async () => {
            const { script, out } = writeArgvProbe();
            const cases: [string, string[]][] = [
                ['Label-A', ['--with-option', 'in.c']],
                // 빈 배열은 **아무 인자도 만들지 않는다** — 빈 인자로 남으면
                // 도구가 빈 문자열을 값으로 받아 조용히 다르게 돈다.
                ['Label-B', ['in.c']],
                ['Label-C', ['--option', 'b', 'in.c']],
                // 매핑이 없으면 label 이 그대로 값이다 (기존 액션 동작).
                ['Label-D', ['Label-D', 'in.c']],
            ];
            for (const [label, expected] of cases) {
                await pickAndRun(label, modeItems, {
                    id: 'run',
                    type: 'command',
                    command: `node "${script}" "${out}" \${mode.value} in.c`,
                    passTheResultToNextTask: true,
                }, 'it160');
                assert.deepStrictEqual(readArgv(), expected, `${label} 에서 argv 가 어긋났다`);
            }
        });

        test('IT-161: command args 자리도 같은 결과를 낸다', async () => {
            // 같은 참조가 자리에 따라 다르게 동작하면 안 된다 — 0.7.31 이전에는
            // `args` 만 펼치고 `command` 는 인자 한 칸으로 뭉쳤다.
            const { script, out } = writeArgvProbe();
            for (const [label, expected] of [
                ['Label-A', ['--with-option', 'in.c']],
                ['Label-B', ['in.c']],
                ['Label-C', ['--option', 'b', 'in.c']],
            ] as [string, string[]][]) {
                await pickAndRun(label, modeItems, {
                    id: 'run',
                    type: 'command',
                    command: 'node',
                    args: [script, out, '${mode.value}', 'in.c'],
                    passTheResultToNextTask: true,
                }, 'it161');
                assert.deepStrictEqual(readArgv(), expected, `${label} 에서 args 확장이 어긋났다`);
            }
        });

        test('IT-162: 여러 파일을 고르면 command 문자열에서도 인자 여러 개가 된다', async () => {
            // 신고된 증상 그대로: `fileDialog` 다중 선택 → 다음 태스크가
            // `"파일명 파일명"` 이라는 **인자 한 칸**을 받았다.
            const { script, out } = writeArgvProbe();
            const files = [
                path.join(tempWorkspace, 'one.bin'),
                path.join(tempWorkspace, 'two space.bin'),
            ];
            files.forEach(f => fs.writeFileSync(f, 'x'));
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            try {
                (vscode.window as any).showOpenDialog = async () => files.map(f => vscode.Uri.file(f));
                await run({
                    description: 'IT-162',
                    tasks: [
                        { id: 'pick', type: 'fileDialog', options: { canSelectMany: true } },
                        {
                            id: 'run',
                            type: 'command',
                            command: `node "${script}" "${out}" \${pick.paths}`,
                            passTheResultToNextTask: true,
                        },
                    ],
                }, 'it162');
                assert.deepStrictEqual(
                    readArgv().map(normalizeWindowsPathForAssert),
                    files.map(normalizeWindowsPathForAssert),
                    '공백이 든 경로까지 인자 하나씩 도착해야 한다 — 따옴표로 묶인 한 칸이 아니라'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-163: 폴더 다중 선택도 같은 규칙이다', async () => {
            const { script, out } = writeArgvProbe();
            const folders = [
                path.join(tempWorkspace, 'alpha'),
                path.join(tempWorkspace, 'beta dir'),
            ];
            folders.forEach(f => fs.mkdirSync(f, { recursive: true }));
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            try {
                (vscode.window as any).showOpenDialog = async () => folders.map(f => vscode.Uri.file(f));
                await run({
                    description: 'IT-163',
                    tasks: [
                        { id: 'pick', type: 'folderDialog', options: { canSelectMany: true } },
                        {
                            id: 'run',
                            type: 'command',
                            command: `node "${script}" "${out}" \${pick.paths}`,
                            passTheResultToNextTask: true,
                        },
                    ],
                }, 'it163');
                assert.deepStrictEqual(
                    readArgv().map(normalizeWindowsPathForAssert),
                    folders.map(normalizeWindowsPathForAssert),
                    '폴더 쪽만 인자 한 칸으로 뭉쳤다'
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }
        });

        test('IT-164: shell 타입에서는 값이 문자열로 이어 붙고 셸이 쪼갠다', async () => {
            // `shell` 은 문자열을 셸에 그대로 넘기는 계약이라 argv 경계라는
            // 개념이 없다. 배열은 공백으로 이어 붙고, 그 뒤 **셸이** 쪼갠다 —
            // 결과 argv 는 같아 보이지만 경로에 공백이 있으면 갈린다는 점이
            // `command` 와의 차이다. 그 계약을 여기서 고정한다.
            const { script, out } = writeArgvProbe();
            for (const [label, expected] of [
                ['Label-A', ['--with-option', 'in.c']],
                ['Label-B', ['in.c']],
                ['Label-C', ['--option', 'b', 'in.c']],
            ] as [string, string[]][]) {
                await pickAndRun(label, modeItems, {
                    id: 'run',
                    type: 'shell',
                    command: `node "${script}" "${out}" \${mode.value} in.c`,
                    passTheResultToNextTask: true,
                }, 'it164');
                assert.deepStrictEqual(readArgv(), expected, `${label} 에서 shell 결과가 어긋났다`);
            }
        });

        test('IT-165: value·label 이 다른 태스크 타입에서도 그대로 쓰인다', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const notePath = path.join(tempWorkspace, 'it165-note.txt');
            const derivedPath = path.join(tempWorkspace, 'it165-derived.txt');
            const gatedPath = path.join(tempWorkspace, 'it165-gated.txt');
            const skippedPath = path.join(tempWorkspace, 'it165-skipped.txt');
            try {
                (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) =>
                    entries.find(entry => entry.label === 'Label-A');
                await run({
                    description: 'IT-165',
                    tasks: [
                        { id: 'mode', type: 'quickPick', items: modeItems },
                        // writeFile 내용: 표시 문구와 명령 값이 각각 제 자리에 온다.
                        {
                            id: 'note', type: 'writeFile', path: notePath,
                            content: 'label=${mode.label};value=${mode.value}',
                        },
                        // stringManipulation 입력.
                        {
                            id: 'derived', type: 'stringManipulation', function: 'trim',
                            input: '  ${mode.value}  ', passTheResultToNextTask: true,
                            output: { mode: 'file', filePath: derivedPath, overwrite: true },
                        },
                        // when 조건은 **label 이 아니라 value** 로 판정된다.
                        {
                            id: 'gated', type: 'writeFile', path: gatedPath, content: 'ran',
                            when: { var: '${mode.value}', equals: '--with-option' },
                        },
                        {
                            id: 'skipped', type: 'writeFile', path: skippedPath, content: 'ran',
                            when: { var: '${mode.value}', equals: 'Label-A' },
                        },
                    ],
                }, 'it165');

                assert.strictEqual(
                    fs.readFileSync(notePath, 'utf8'), 'label=Label-A;value=--with-option',
                    'writeFile 에서 label 과 value 가 갈리지 않았다'
                );
                assert.strictEqual(fs.readFileSync(derivedPath, 'utf8'), '--with-option');
                assert.ok(fs.existsSync(gatedPath), 'when 이 매핑된 value 로 판정하지 않았다');
                assert.ok(!fs.existsSync(skippedPath), 'when 이 label 로 판정해 엉뚱한 태스크가 돌았다');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });

        /**
         * 저장된 입력은 "무엇을 골랐는가" 이지 "그것이 어떤 값인가" 가 아니다.
         * 매핑을 추가·수정한 뒤의 재실행이 저장된 옛 값을 그대로 넘기면, 사용자는
         * 아무 신호 없이 **표시 문구를 인자로** 받는다.
         */
        test('IT-167: 매핑을 바꾼 뒤 재실행하면 지금 정의의 값이 간다', async () => {
            const { script, out } = writeArgvProbe();
            const runWith = (items: any[], preset?: Record<string, unknown>) => {
                const extensionRoot = path.resolve(__dirname, '..', '..');
                return executeActionPipeline(
                    {
                        description: 'IT-167',
                        tasks: [
                            { id: 'mode', type: 'quickPick', items },
                            {
                                id: 'run', type: 'command',
                                command: `node "${script}" "${out}" \${mode.value}`,
                                passTheResultToNextTask: true,
                            },
                        ],
                    } as PipelineAction,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it167', tempWorkspace, [tempWorkspace],
                    preset ? { presetInputs: preset } : undefined
                );
            };

            const originalShowQuickPick = vscode.window.showQuickPick;
            const recorded: Record<string, unknown> = {};
            try {
                (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) =>
                    entries.find(entry => entry.label === 'Release');
                // v1: 매핑이 없다 — 저장되는 값은 표시 문구 그대로다.
                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    {
                        description: 'IT-167',
                        tasks: [
                            { id: 'mode', type: 'quickPick', items: ['Release', 'Debug'] },
                            {
                                id: 'run', type: 'command',
                                command: `node "${script}" "${out}" \${mode.value}`,
                                passTheResultToNextTask: true,
                            },
                        ],
                    } as PipelineAction,
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it167', tempWorkspace, [tempWorkspace],
                    { recordInputs: recorded }
                );
                assert.deepStrictEqual(readArgv(), ['Release'], 'v1 의 전제가 깨졌다');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }

            // v2: 작성자가 같은 선택지에 매핑을 붙였다. 저장된 입력으로 재실행하면
            // 대화상자는 뜨지 않아야 하고, 값은 **새 매핑**이어야 한다.
            const dialogOpened = { count: 0 };
            const original2 = vscode.window.showQuickPick;
            try {
                (vscode.window as any).showQuickPick = async () => {
                    dialogOpened.count++;
                    throw new Error('quickPick must not open during replay');
                };
                await runWith(
                    [{ label: 'Release', value: '--release' }, { label: 'Debug', value: '--debug' }],
                    recorded
                );
            } finally {
                (vscode.window as any).showQuickPick = original2;
            }
            assert.strictEqual(dialogOpened.count, 0, '저장된 입력이 있는데 다시 물었다');
            assert.deepStrictEqual(
                readArgv(), ['--release'],
                '재실행이 저장된 옛 값(표시 문구)을 명령에 넘겼다'
            );
        });

        /**
         * 항목의 `value` 안 참조는 **디스패치가** 보간한다. 빠뜨리면 같은 참조가
         * 표시 문구에서는 풀리고 명령에서는 리터럴로 남는다 — 실행해 봐야 드러난다.
         */
        test('IT-168: 항목 value 안의 참조도 실행 시점에 보간된다', async () => {
            const { script, out } = writeArgvProbe();
            const originalShowQuickPick = vscode.window.showQuickPick;
            for (const [label, expected] of [
                ['string', ['--tag=v9']],
                ['array', ['--f', 'v9']],
            ] as [string, string[]][]) {
                try {
                    (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) =>
                        entries.find(entry => entry.label === label);
                    await run({
                        description: 'IT-168',
                        tasks: [
                            {
                                id: 'build', type: 'command', command: 'node',
                                args: ['-e', "process.stdout.write('v9')"],
                                passTheResultToNextTask: true,
                            },
                            {
                                id: 'mode', type: 'quickPick',
                                items: [
                                    { label: 'string', value: '--tag=${build.output}' },
                                    { label: 'array', value: ['--f', '${build.output}'] },
                                ],
                            },
                            {
                                id: 'run', type: 'command',
                                command: `node "${script}" "${out}" \${mode.value}`,
                                passTheResultToNextTask: true,
                            },
                        ],
                    }, 'it168');
                } finally {
                    (vscode.window as any).showQuickPick = originalShowQuickPick;
                }
                assert.deepStrictEqual(readArgv(), expected, `${label} 에서 value 의 참조가 리터럴로 남았다`);
            }
        });


        test('IT-166: 다중 선택은 valueList 로 인자 여러 개가 된다', async () => {
            const { script, out } = writeArgvProbe();
            const originalShowQuickPick = vscode.window.showQuickPick;
            try {
                (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) =>
                    entries.filter(entry => entry.label === 'Label-A' || entry.label === 'Label-C');
                await run({
                    description: 'IT-166',
                    tasks: [
                        { id: 'mode', type: 'quickPick', canPickMany: true, items: modeItems },
                        {
                            id: 'run', type: 'command',
                            command: `node "${script}" "${out}" \${mode.valueList} in.c`,
                            passTheResultToNextTask: true,
                        },
                        {
                            id: 'note', type: 'writeFile',
                            path: path.join(tempWorkspace, 'it166-note.txt'),
                            content: 'labels=${mode.labels};values=${mode.values}',
                        },
                    ],
                }, 'it166');
                assert.deepStrictEqual(
                    readArgv(), ['--with-option', '--option', 'b', 'in.c'],
                    '다중 선택의 매핑 값이 평평하게 펴져 인자로 가지 않았다'
                );
                assert.strictEqual(
                    fs.readFileSync(path.join(tempWorkspace, 'it166-note.txt'), 'utf8'),
                    'labels=Label-A,Label-C;values=--with-option,--option,b',
                    'labels 는 표시 문구, values 는 매핑된 값이어야 한다'
                );
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
        });
    });

    suite('forEach 반복 실행', () => {
        test('IT-173: 여러 파일을 파일마다 command 한 번으로 실행하고 실제 명령을 모두 기록한다', async () => {
            const files = [
                path.join(tempWorkspace, 'one.bin'),
                path.join(tempWorkspace, 'two space.bin'),
            ];
            files.forEach(file => fs.writeFileSync(file, 'x'));
            const probe = path.join(tempWorkspace, 'foreach-probe.js');
            const calls = path.join(tempWorkspace, 'foreach-calls.log');
            const summary = path.join(tempWorkspace, 'foreach-summary.txt');
            fs.writeFileSync(
                probe,
                "const fs=require('fs'); const a=process.argv.slice(2); fs.appendFileSync(a[0], JSON.stringify(a.slice(1))+'\\n'); process.stdout.write(a[1]);"
            );
            const commands: Record<string, string> = Object.create(null);
            const originalShowOpenDialog = vscode.window.showOpenDialog;
            try {
                (vscode.window as any).showOpenDialog = async () => files.map(file => vscode.Uri.file(file));
                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    {
                        description: 'IT-173',
                        tasks: [
                            { id: 'files', type: 'fileDialog', options: { canSelectMany: true } },
                            {
                                id: 'inspect', type: 'command', forEach: '${files.paths}',
                                command: 'node',
                                args: [probe, calls, '${each}', '${each.index}', '${each.number}', '${each.count}'],
                                passTheResultToNextTask: true,
                            },
                            {
                                id: 'summary', type: 'writeFile', path: summary,
                                content: 'count=${inspect.count}\n${inspect.output}',
                            },
                        ],
                    },
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it173', tempWorkspace, [tempWorkspace], { recordCommands: commands }
                );
            } finally {
                (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            }

            const actual = fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
            assert.deepStrictEqual(
                actual.map((row: string[]) => [normalizeWindowsPathForAssert(row[0]), ...row.slice(1)]),
                [
                    [normalizeWindowsPathForAssert(files[0]), '0', '1', '2'],
                    [normalizeWindowsPathForAssert(files[1]), '1', '2', '2'],
                ]
            );
            assert.strictEqual(
                normalizeWindowsPathForAssert(fs.readFileSync(summary, 'utf8')),
                normalizeWindowsPathForAssert(`count=2\n${files[0]}\n${files[1]}`)
            );
            assert.strictEqual(commands.inspect.split(/\r?\n/).length, 2, '반복 명령이 History에 모두 남지 않았다');
            const normalizedCommands = normalizeWindowsPathForAssert(commands.inspect);
            assert.ok(
                normalizedCommands.includes(normalizeWindowsPathForAssert(files[0]))
                && normalizedCommands.includes(normalizeWindowsPathForAssert(files[1]))
            );
        });

        test('IT-174: 반복 실패는 위치를 밝히고 남은 항목을 실행하지 않는다', async () => {
            const probe = path.join(tempWorkspace, 'foreach-fail.js');
            const calls = path.join(tempWorkspace, 'foreach-fail.log');
            fs.writeFileSync(
                probe,
                "const fs=require('fs'); const [out,v]=process.argv.slice(2); fs.appendFileSync(out,v+'\\n'); if(v==='bad') process.exit(7);"
            );
            await assert.rejects(
                () => run({
                    description: 'IT-174',
                    tasks: [{
                        id: 'run', type: 'command', forEach: ['good', 'bad', 'never'],
                        command: 'node', args: [probe, calls, '${each}'],
                        passTheResultToNextTask: true,
                    }],
                }, 'it174'),
                /forEach iteration 2\/3 failed/
            );
            assert.deepStrictEqual(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['good', 'bad']);
        });

        test('IT-175: password 파생 반복값은 실제 실행에만 전달하고 명령 기록에서는 가린다', async () => {
            const probe = path.join(tempWorkspace, 'foreach-secret.js');
            const calls = path.join(tempWorkspace, 'foreach-secret.log');
            fs.writeFileSync(
                probe,
                "const fs=require('fs'); fs.appendFileSync(process.argv[2],process.argv[3]+'\\n');"
            );
            const commands: Record<string, string> = Object.create(null);
            const originalShowQuickPick = vscode.window.showQuickPick;
            try {
                (vscode.window as any).showQuickPick = async (entries: vscode.QuickPickItem[]) => entries[0];
                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    {
                        description: 'IT-175',
                        tasks: [
                            { id: 'token', type: 'inputBox', password: true },
                            {
                                id: 'values', type: 'quickPick',
                                items: [{ label: 'both', value: ['${token.value}', 'visible'] }],
                            },
                            {
                                id: 'run', type: 'command', forEach: '${values.valueList}',
                                command: 'node', args: [probe, calls, '${each}'],
                                passTheResultToNextTask: true,
                            },
                        ],
                    },
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it175', tempWorkspace, [tempWorkspace], {
                        presetInputs: { token: { value: 'TOP-SECRET' } },
                        recordCommands: commands,
                    }
                );
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
            }
            assert.deepStrictEqual(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/), ['TOP-SECRET', 'visible']);
            assert.ok(!commands.run.includes('TOP-SECRET'), '비밀 반복값이 History 명령에 남았다');
            assert.ok(commands.run.split(/\r?\n/).every(line => line.includes('***')), commands.run);
        });

        test('IT-186: 내장 민감값 반복은 첫 명령부터 History와 Run Report에서 가린다', async () => {
            const secret = 'TOP-SECRET-FIRST-ITERATION';
            const probe = path.join(tempWorkspace, 'foreach-builtin-secret.js');
            const calls = path.join(tempWorkspace, 'foreach-builtin-secret.log');
            fs.writeFileSync(
                probe,
                "const fs=require('fs'); fs.appendFileSync(process.argv[2],process.argv[3]+'\\n');"
            );
            const tasks = [{
                id: 'run', type: 'command',
                forEach: ['${env:TASKHUB_FOREACH_SECRET}', 'visible'],
                command: 'node', args: [probe, calls, '${each}'],
                passTheResultToNextTask: true,
            }] as any[];
            const commands: Record<string, string> = Object.create(null);
            const collector = new ActionRunLogCollector('it186', 'IT-186', Date.now(), tasks);
            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                { description: 'IT-186', tasks },
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it186', tempWorkspace, [tempWorkspace], {
                    recordCommands: commands,
                    runLogCollector: collector,
                    builtinVariables: buildBuiltinVariableContext({
                        workspaceFolder: tempWorkspace,
                        extensionPath: extensionRoot,
                        environment: { TASKHUB_FOREACH_SECRET: secret },
                        strict: true,
                    }),
                }
            );

            assert.deepStrictEqual(
                fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/),
                [secret, 'visible'],
                '실제 프로세스에는 원문 반복값이 전달되어야 한다'
            );
            assert.ok(!commands.run.includes(secret), '첫 반복의 내장 민감값이 History 명령에 남았다');
            assert.ok(commands.run.split(/\r?\n/).every(line => line.includes('***')), commands.run);
            const report = JSON.stringify(collector.finish('success', Date.now()));
            assert.ok(!report.includes(secret), '첫 반복의 내장 민감값이 Run Report에 남았다');
            assert.ok(report.includes('***'));
        });

        test('IT-187: 첫 반복의 민감 파생 파일 경로를 알림에서 가린다', async () => {
            const secret = 'TOP-SECRET-PATH';
            const warnings: string[] = [];
            const originalWarning = vscode.window.showWarningMessage;
            try {
                (vscode.window as any).showWarningMessage = async (message: string) => {
                    warnings.push(message);
                    return undefined;
                };
                const extensionRoot = path.resolve(__dirname, '..', '..');
                await executeActionPipeline(
                    {
                        description: 'IT-187',
                        tasks: [{
                            id: 'write', type: 'writeFile',
                            forEach: ['${env:TASKHUB_FOREACH_PATH}'],
                            path: '${workspaceFolder}/${each}.txt',
                            content: 'sensitive',
                            allowSecretContent: true,
                        }],
                    },
                    { extensionPath: extensionRoot } as vscode.ExtensionContext,
                    'it187', tempWorkspace, [tempWorkspace], {
                        builtinVariables: buildBuiltinVariableContext({
                            workspaceFolder: tempWorkspace,
                            extensionPath: extensionRoot,
                            environment: { TASKHUB_FOREACH_PATH: secret },
                            strict: true,
                        }),
                    }
                );
            } finally {
                (vscode.window as any).showWarningMessage = originalWarning;
            }

            assert.strictEqual(fs.existsSync(path.join(tempWorkspace, `${secret}.txt`)), true);
            assert.ok(warnings.length > 0, '민감 파생 파일 저장 알림이 나타나지 않았다');
            assert.ok(!warnings.join('\n').includes(secret), '첫 반복의 민감 경로가 알림에 노출됐다');
            assert.ok(warnings.join('\n').includes('***'));
        });

        test('IT-188: 다른 필드만 민감하면 리터럴 each는 실행 기록에 남긴다', async () => {
            const secret = 'TOP-SECRET-UNRELATED-ENV';
            const probe = path.join(tempWorkspace, 'foreach-visible-each.js');
            const calls = path.join(tempWorkspace, 'foreach-visible-each.log');
            fs.writeFileSync(
                probe,
                "const fs=require('fs'); fs.appendFileSync(process.argv[2],process.argv[3]+'\\n'); process.stdout.write(process.env.TASKHUB_CHILD_SECRET || '');"
            );
            const tasks = [{
                id: 'run', type: 'command', forEach: ['debug', 'release'],
                command: 'node', args: [probe, calls, '${each}'],
                env: { TASKHUB_CHILD_SECRET: '${env:TASKHUB_FOREACH_UNRELATED_SECRET}' },
                passTheResultToNextTask: true,
            }] as any[];
            const commands: Record<string, string> = Object.create(null);
            const collector = new ActionRunLogCollector('it188', 'IT-188', Date.now(), tasks);
            const extensionRoot = path.resolve(__dirname, '..', '..');
            await executeActionPipeline(
                { description: 'IT-188', tasks },
                { extensionPath: extensionRoot } as vscode.ExtensionContext,
                'it188', tempWorkspace, [tempWorkspace], {
                    recordCommands: commands,
                    runLogCollector: collector,
                    builtinVariables: buildBuiltinVariableContext({
                        workspaceFolder: tempWorkspace,
                        extensionPath: extensionRoot,
                        environment: { TASKHUB_FOREACH_UNRELATED_SECRET: secret },
                        strict: true,
                    }),
                }
            );

            assert.deepStrictEqual(
                fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/),
                ['debug', 'release']
            );
            assert.ok(commands.run.includes('debug') && commands.run.includes('release'), commands.run);
            assert.ok(!commands.run.includes('***'), `리터럴 each가 불필요하게 가려졌다: ${commands.run}`);
            const report = JSON.stringify(collector.finish('success', Date.now()));
            assert.ok(report.includes('debug') && report.includes('release'), report);
            assert.ok(!report.includes(secret), '다른 필드의 민감값이 Run Report에 노출됐다');
        });

        test('IT-177: forEach timeout은 중단된 반복 위치를 밝힌다', async () => {
            await assert.rejects(
                () => run({
                    description: 'IT-177',
                    tasks: [{
                        id: 'slow', type: 'command', forEach: ['first', 'second'],
                        command: 'node',
                        args: ['-e', 'setTimeout(() => {}, 1000)'],
                        timeoutSeconds: 0.05,
                        passTheResultToNextTask: true,
                    }],
                }, 'it177'),
                /forEach iteration 1\/2 failed/
            );
        });

        test('IT-178: forEach 결과 합계가 action 상한을 넘기 전에 중단한다', async () => {
            const config = vscode.workspace.getConfiguration('taskhub');
            const previousTotal = config.get<number>('pipeline.totalOutputLimitMb');
            const previousCapture = config.get<number>('pipeline.outputCaptureLimitMb');
            try {
                await config.update('pipeline.totalOutputLimitMb', 1, vscode.ConfigurationTarget.Global);
                await config.update('pipeline.outputCaptureLimitMb', 1, vscode.ConfigurationTarget.Global);
                await assert.rejects(
                    () => run({
                        description: 'IT-178',
                        tasks: [{
                            id: 'bulk', type: 'command', forEach: ['a', 'b'],
                            command: 'node',
                            args: ['-e', 'process.stdout.write("x".repeat(600 * 1024))'],
                            passTheResultToNextTask: true,
                        }],
                    }, 'it178'),
                    /forEach results exceeded the 1 MB combined result limit/
                );
            } finally {
                await config.update('pipeline.totalOutputLimitMb', previousTotal, vscode.ConfigurationTarget.Global);
                await config.update('pipeline.outputCaptureLimitMb', previousCapture, vscode.ConfigurationTarget.Global);
            }
        });
    });

    suite('switch 선택 태스크', () => {
        test('IT-181: 선택된 command case의 결과와 선택 메타데이터를 이어서 쓴다', async () => {
            const summary = path.join(tempWorkspace, 'switch-command.txt');
            await run({
                description: 'IT-181',
                tasks: [
                    { id: 'mode', type: 'stringManipulation', function: 'trim', input: 'run' },
                    {
                        id: 'optional', type: 'switch', on: '${mode.output}',
                        passTheResultToNextTask: true,
                        cases: {
                            run: {
                                type: 'command', command: 'node',
                                args: ['-e', 'process.stdout.write("branch-output")'],
                            },
                        },
                    },
                    {
                        id: 'save', type: 'writeFile', path: summary,
                        content: '${optional.output}|${optional.matched}|${optional.selected}',
                    },
                ],
            }, 'it181');
            assert.strictEqual(fs.readFileSync(summary, 'utf8'), 'branch-output|true|run');
        });

        test('IT-182: 일치하지 않는 선택은 실패 없이 건너뛰고 false를 돌려준다', async () => {
            const marker = path.join(tempWorkspace, 'must-not-exist.txt');
            const summary = path.join(tempWorkspace, 'switch-skipped.txt');
            await run({
                description: 'IT-182',
                tasks: [
                    {
                        id: 'optional', type: 'switch', on: 'skip', cases: {
                            run: { type: 'writeFile', path: marker, content: 'ran' },
                        },
                    },
                    {
                        id: 'save', type: 'writeFile', path: summary,
                        content: '${optional.matched}|${optional.selected}',
                    },
                ],
            }, 'it182');
            assert.strictEqual(fs.existsSync(marker), false);
            assert.strictEqual(fs.readFileSync(summary, 'utf8'), 'false|skip');
        });

        test('IT-183: 같은 switch에서 서로 다른 태스크 타입을 선택할 수 있다', async () => {
            const selectedFile = path.join(tempWorkspace, 'switch-write.txt');
            const summary = path.join(tempWorkspace, 'switch-write-result.txt');
            await run({
                description: 'IT-183',
                tasks: [
                    {
                        id: 'work', type: 'switch', on: 'save', cases: {
                            run: { type: 'command', command: 'node', args: ['-e', 'process.exit(9)'] },
                            save: { type: 'writeFile', path: selectedFile, content: 'saved' },
                        },
                    },
                    { id: 'summary', type: 'writeFile', path: summary, content: '${work.path}' },
                ],
            }, 'it183');
            assert.strictEqual(fs.readFileSync(selectedFile, 'utf8'), 'saved');
            assert.strictEqual(fs.readFileSync(summary, 'utf8'), selectedFile);
        });

        test('IT-184: defaultCase를 실행하고 잘못된 branch 타입은 선택값을 노출하지 않고 거부한다', async () => {
            const fallback = path.join(tempWorkspace, 'switch-default.txt');
            await run({
                description: 'IT-184 default',
                tasks: [{
                    id: 'fallback', type: 'switch', on: 'unknown', cases: {
                        run: { type: 'writeFile', path: 'unused.txt', content: 'unused' },
                    },
                    defaultCase: { type: 'writeFile', path: fallback, content: 'default' },
                }],
            }, 'it184-default');
            assert.strictEqual(fs.readFileSync(fallback, 'utf8'), 'default');

            const secretSelector = 'selector-must-not-appear';
            await assert.rejects(
                () => run({
                    description: 'IT-184 invalid',
                    tasks: [{
                        id: 'bad', type: 'switch', on: secretSelector,
                        cases: { [secretSelector]: { type: 'fileDialog' } as any },
                    }],
                }, 'it184-invalid'),
                (error: any) => {
                    assert.match(String(error?.message), /case type must be one of/);
                    assert.ok(!String(error?.message).includes(secretSelector));
                    return true;
                }
            );
        });

        test('IT-185: 조건으로 꺼진 의존성은 그것을 쓰는 case를 골랐을 때만 switch를 건너뛴다', async () => {
            const safe = path.join(tempWorkspace, 'switch-safe.txt');
            const blocked = path.join(tempWorkspace, 'switch-blocked.txt');
            await run({
                description: 'IT-185',
                tasks: [
                    {
                        id: 'optionalInput', type: 'writeFile', path: 'unused-input.txt', content: 'x',
                        when: { var: 'off', equals: 'on' },
                    },
                    {
                        id: 'safeChoice', type: 'switch', on: 'safe', cases: {
                            blocked: { type: 'writeFile', path: blocked, content: '${optionalInput.path}' },
                            safe: { type: 'writeFile', path: safe, content: 'safe' },
                        },
                    },
                    {
                        id: 'blockedChoice', type: 'switch', on: 'blocked', cases: {
                            blocked: { type: 'writeFile', path: blocked, content: '${optionalInput.path}' },
                        },
                    },
                ],
            }, 'it185');
            assert.strictEqual(fs.readFileSync(safe, 'utf8'), 'safe');
            assert.strictEqual(fs.existsSync(blocked), false);
        });
    });

    suite('browser 태스크', () => {
        test('IT-196: 생성 파일 결과를 내장 브라우저에 전달하고 URI·경로 결과를 이어 쓴다', async () => {
            const htmlPath = path.join(tempWorkspace, 'reports', 'generated report-한글.html');
            const resultPath = path.join(tempWorkspace, 'browser-result.txt');
            const calls: Array<{ command: string; args: unknown[] }> = [];
            const originalExecuteCommand = vscode.commands.executeCommand;
            const originalGetCommands = vscode.commands.getCommands;
            (vscode.commands as any).getCommands = async () => ['workbench.action.browser.open'];
            (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
                if (command === 'workbench.action.browser.open') {
                    calls.push({ command, args });
                    return undefined;
                }
                return originalExecuteCommand(command, ...args);
            };
            try {
                await run({
                    description: 'IT-196',
                    tasks: [
                        {
                            id: 'generate', type: 'writeFile', path: htmlPath,
                            content: '<!doctype html><title>TaskHub browser test</title>',
                        },
                        { id: 'preview', type: 'browser', url: '${generate.path}' },
                        {
                            id: 'save', type: 'writeFile', path: resultPath,
                            content: '${preview.url}\n${preview.path}',
                        },
                    ],
                }, 'it196');
            } finally {
                (vscode.commands as any).executeCommand = originalExecuteCommand;
                (vscode.commands as any).getCommands = originalGetCommands;
            }

            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].command, 'workbench.action.browser.open');
            const openedUrl = String(calls[0].args[0]);
            assert.match(openedUrl, /\/reports\/generated%20report-%ED%95%9C%EA%B8%80\.html$/);
            assert.ok(!openedUrl.includes(' '));
            assert.ok(!openedUrl.includes('한글'));
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), `${openedUrl}\n${htmlPath}`);
        });

        test('IT-197: browser forEach는 탭을 열기 전에 거부한다', async () => {
            const htmlPath = path.join(tempWorkspace, 'report.html');
            fs.writeFileSync(htmlPath, '<title>report</title>');
            await assert.rejects(
                () => run({
                    description: 'IT-197',
                    tasks: [{
                        id: 'preview', type: 'browser', url: '${each}',
                        forEach: [htmlPath, htmlPath],
                    }],
                }, 'it197'),
                /cannot use 'forEach' with type 'browser'/
            );
        });

        test('IT-198: switch가 선택한 browser case도 결과와 메타데이터를 돌려준다', async () => {
            const htmlPath = path.join(tempWorkspace, 'switch-report.html');
            const resultPath = path.join(tempWorkspace, 'switch-browser-result.txt');
            fs.writeFileSync(htmlPath, '<title>switch report</title>');
            const calls: string[] = [];
            const originalExecuteCommand = vscode.commands.executeCommand;
            const originalGetCommands = vscode.commands.getCommands;
            (vscode.commands as any).getCommands = async () => ['workbench.action.browser.open'];
            (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
                if (command === 'workbench.action.browser.open') {
                    calls.push(String(args[0]));
                    return undefined;
                }
                return originalExecuteCommand(command, ...args);
            };
            try {
                await run({
                    description: 'IT-198',
                    tasks: [
                        {
                            id: 'open', type: 'switch', on: 'preview', cases: {
                                preview: { type: 'browser', url: htmlPath },
                            },
                        },
                        {
                            id: 'save', type: 'writeFile', path: resultPath,
                            content: '${open.url}|${open.path}|${open.matched}|${open.selected}',
                        },
                    ],
                }, 'it198');
            } finally {
                (vscode.commands as any).executeCommand = originalExecuteCommand;
                (vscode.commands as any).getCommands = originalGetCommands;
            }
            const expectedUrl = vscode.Uri.file(htmlPath).toString();
            assert.deepStrictEqual(calls, [expectedUrl]);
            assert.strictEqual(
                fs.readFileSync(resultPath, 'utf8'),
                `${expectedUrl}|${htmlPath}|true|preview`
            );
        });
    });
});
