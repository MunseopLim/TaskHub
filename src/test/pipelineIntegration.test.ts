import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { executeActionPipeline } from '../extension';
import { Action as PipelineAction } from '../schema';

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
});
