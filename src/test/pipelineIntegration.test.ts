import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { executeAction, executeActionPipeline } from '../extension';
import { actionStates } from '../providers/actionStatus';
import { HistoryEntry, HistoryProvider } from '../providers/historyProvider';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem, Action as PipelineAction } from '../schema';

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

    setup(() => {
        tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-pipeline-workspace-'));
    });

    teardown(() => {
        actionStates.clear();
        if (tempWorkspace && fs.existsSync(tempWorkspace)) {
            fs.rmSync(tempWorkspace, { recursive: true, force: true });
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
                        input: 'hit=${src.hit}',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: resultPath, overwrite: true }
                    }
                ]
            };
            await run(action);
            assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'hit=single');
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

        test('IT-033: envPick lists process.env names and passes selection downstream', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const originalEnv = process.env.TASKHUB_ENVPICK_SENTINEL;
            const resultPath = path.join(tempWorkspace, 'it033.txt');
            try {
                process.env.TASKHUB_ENVPICK_SENTINEL = 'marker';
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
                const sorted = [...labels].sort();
                assert.deepStrictEqual(labels, sorted, 'env names should be sorted');
                assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'name=TASKHUB_ENVPICK_SENTINEL');
            } finally {
                (vscode.window as any).showQuickPick = originalShowQuickPick;
                if (originalEnv === undefined) { delete process.env.TASKHUB_ENVPICK_SENTINEL; }
                else { process.env.TASKHUB_ENVPICK_SENTINEL = originalEnv; }
            }
        });

        test('IT-034: envPick cancellation aborts the pipeline', async () => {
            const originalShowQuickPick = vscode.window.showQuickPick;
            const markerPath = path.join(tempWorkspace, 'envpick-should-not-run.txt');
            try {
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
                    fs.readFileSync(path.join(tempWorkspace, 'dialog', 'selection.txt'), 'utf8'),
                    [
                        'base=firmware',
                        'fileNameOnly=firmware',
                        'ext=hex',
                        `fileDir=${sourceDir}`,
                        `folder=${outputDir}`
                    ].join('\n')
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
                sendText: (text: string) => { capturedText.push(text); },
                dispose: () => { /* no-op */ }
            } as unknown as vscode.Terminal;
            (vscode.window as any).createTerminal = (..._args: any[]) => {
                createCount += 1;
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
    });

    suite('History Input Replay', () => {
        // These tests pin TODO §5.3: capturing interactive task results into
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
                    env: { value: 'staging' },
                    tag: { value: 'release-1' }
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
            // Pins TODO §5.4 scope: every terminal transition surfaced by
            // `executeAction` must include a non-negative duration so each
            // HistoryItem can render "✓ 14:30 · 1.2s" badges in its
            // description slot. Actions panel intentionally does NOT
            // render this badge — see IT-068b.
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
                    env: { value: 'visible' },
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

    suite('Task Transition Events', () => {
        // Pins TODO §5.4 → 5.2 progression: each task in the pipeline
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
    });

    suite('Problem Matcher / Diagnostics', () => {
        // Pins TODO §3.1: shell task output is parsed by configured matcher
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
});
