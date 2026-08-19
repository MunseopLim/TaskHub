import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildPreviewReport,
    findTypoRefs,
    findUncapturedOutputRefs,
    analyzeCoalesceRefs,
    simulateTaskResult,
    simulateTaskResultWithCaptures,
} from '../previewRun';
import { interpolatePipelineVariables } from '../pipelineUtils';
import { buildBuiltinVariableContext } from '../builtinVariables';
import type { ActionItem, Task } from '../schema';

const WS = path.resolve(os.tmpdir(), 'taskhub-preview-ws');

function baseOptions() {
    return {
        workspaceFolder: WS,
        extensionPath: '/ext',
        workspaceRoots: [WS],
    };
}

/** 지금 플랫폼의 branch 키 하나를 담은 객체. */
function currentBranch(value: string): Record<string, string> {
    const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    return { [key]: value };
}

suite('buildPreviewReport', () => {
    test('switch의 case와 불일치 no-op을 보여 주고 branch 결과 키를 합친다', () => {
        const task: Task = {
            id: 'optional', type: 'switch', on: 'skip',
            cases: {
                run: { type: 'command', command: 'node', passTheResultToNextTask: true },
                save: { type: 'writeFile', path: 'out.txt', content: 'ok' },
            },
        };
        const simulated = simulateTaskResult(task);
        assert.deepStrictEqual(
            new Set(Object.keys(simulated)),
            new Set(['output', 'stderr', 'path', 'matched', 'selected'])
        );
        const report = buildPreviewReport({
            id: 'a.switch', title: 'Switch', action: { description: 'd', tasks: [task] },
        }, baseOptions());
        assert.match(report, /"run" → command/);
        assert.match(report, /"save" → writeFile/);
        assert.match(report, /no match — succeeds without running a branch/);
    });

    test('현재 파일은 반영하되 환경변수·선택 텍스트 원문은 Preview에서 가린다', () => {
        const file = path.join(WS, 'src', 'main.c');
        const options = baseOptions();
        const item: ActionItem = {
            id: 'a.builtin',
            title: 'builtin',
            action: {
                description: 'x',
                tasks: [{
                    id: 'run', type: 'command', command: 'tool',
                    args: ['${relativeFile}', '${env:TASKHUB_PREVIEW_ENV}', '${selectedText}'],
                }],
            },
        };
        const report = buildPreviewReport(item, {
            ...options,
            builtinVariables: buildBuiltinVariableContext({
                workspaceFolder: WS,
                extensionPath: '/ext',
                editor: { file, fileWorkspaceFolder: WS, selectedText: 'preview-selection-secret' },
                clipboard: '<builtin:clipboard>',
                environment: { TASKHUB_PREVIEW_ENV: 'preview-value' },
            }),
        });
        // Preview renders argv as JSON. On Windows a path separator is therefore
        // displayed as `\\`, so compare against the same JSON representation
        // instead of treating the raw platform path as a regular expression.
        assert.ok(report.includes(JSON.stringify(path.join('src', 'main.c'))), report);
        assert.doesNotMatch(report, /preview-value|preview-selection-secret/);
        assert.match(report, /<builtin:sensitive>/);
        assert.doesNotMatch(report, /unresolved variables/);
    });

    test('활성 파일이 없는 Preview는 ${file}을 해석된 것처럼 꾸미지 않는다', () => {
        const item: ActionItem = {
            id: 'a.no-editor',
            title: 'no editor',
            action: {
                description: 'x',
                tasks: [{ id: 'run', type: 'command', command: 'tool', args: ['${file}'] }],
            },
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /unresolved variables:.*\$\{file\}/);
    });

    test('전방 동명 task의 bare 참조를 활성 파일 내장으로 바꾸지 않는다', () => {
        const activeFile = path.join(WS, 'active.c');
        const item: ActionItem = {
            id: 'a.forward-shadow',
            title: 'forward shadow',
            action: {
                description: 'x',
                tasks: [
                    { id: 'use', type: 'command', command: 'tool', args: ['${file}'], parallel: true },
                    {
                        id: 'file', type: 'stringManipulation', function: 'trim',
                        input: 'producer-value', parallel: true,
                    },
                ],
            },
        };
        const report = buildPreviewReport(item, {
            ...baseOptions(),
            builtinVariables: buildBuiltinVariableContext({
                workspaceFolder: WS,
                extensionPath: '/ext',
                editor: { file: activeFile, fileWorkspaceFolder: WS },
                environment: {},
            }),
        });
        assert.doesNotMatch(report, new RegExp(activeFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(report, /stringManipulation:file:output|\$\{file\}/);
    });

    test('includes How to read legend with placeholder/unresolved explanations', () => {
        const item: ActionItem = {
            id: 'a.0',
            title: 'legend',
            action: { description: 'x', tasks: [{ id: 't', type: 'shell', command: 'echo hi' }] }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /How to read this report/);
        assert.match(report, /<taskType:id:key>/);
        assert.match(report, /<capture:id:name>/);
        assert.match(report, /\$\{id\.key\}\s+UNRESOLVED/);
        assert.match(report, /→ resolves to/);
    });

    /**
     * Preview 는 **실제로 실행될 것**을 보여 줘야 한다. 런타임이 `command`
     * 타입에서 토큰 경계를 보존하며 보간하도록 바뀌었는데(0.6.50) Preview 가
     * 옛 방식으로 만들면 서로 다른 argv 를 보여 주게 된다 — 미리 보기의 존재
     * 이유가 사라진다.
     */
    test('command 타입 미리보기가 런타임과 같은 토큰 경계를 쓴다', () => {
        const item: ActionItem = {
            id: 'a.tokens',
            title: 'tokens',
            action: {
                description: 'x',
                tasks: [
                    { id: 'pick', type: 'fileDialog' },
                    { id: 'run', type: 'command', command: 'cat ${pick.path}' },
                ]
            }
        } as unknown as ActionItem;
        const report = buildPreviewReport(item, baseOptions());
        // 자리표시자에 공백이 없더라도, 렌더가 토큰 단위 인용을 거친 뒤
        // 다시 토큰화되어 **하나의 인자**로 보여야 한다.
        assert.match(report, /cat\s+\S*<fileDialog:pick:path>/);
    });

    test('비활성 OS branch 의 오타를 오탐하지 않는다', () => {
        // Preview 는 **이 기계에서 실제로 실행될 것**을 보여 준다. 다른 OS
        // branch 의 참조까지 검사하면 고칠 수 없는 경고가 붙는다 — Doctor 는
        // 설정 파일 전체를 보는 것이 목적이라 그쪽에서 검사하는 것이 맞다.
        const other = process.platform === 'win32' ? 'macos' : 'windows';
        const item: ActionItem = {
            id: 'a.branch', title: 'branch',
            action: {
                description: 'x',
                tasks: [
                    { id: 'pick', type: 'fileDialog' },
                    { id: 'run', type: 'command', command: { [other]: 'echo ${pick.typo}', ...currentBranch('echo ok') } },
                ]
            }
        } as unknown as ActionItem;
        const report = buildPreviewReport(item, baseOptions());
        assert.ok(!/unresolved variables:.*pick\.typo/.test(report),
            `비활성 branch 의 참조를 미해결로 보고했다:\n${report}`);
    });

    test('보간하지 않는 필드의 참조를 오탐하지 않는다', () => {
        // `confirmLabel` 은 런타임이 보간하지 않는다 — 그 안의 `${…}` 는
        // 리터럴로 남는 것이 정상이므로 경고할 것이 없다.
        const item: ActionItem = {
            id: 'a.label', title: 'label',
            action: {
                description: 'x',
                tasks: [
                    { id: 'pick', type: 'fileDialog' },
                    { id: 'ask', type: 'confirm', message: 'go?', confirmLabel: '${pick.typo}' },
                ]
            }
        } as unknown as ActionItem;
        const report = buildPreviewReport(item, baseOptions());
        // 리포트가 필드 값을 그대로 **보여 주는** 것은 정상이다. 검사 대상은
        // 그것을 **미해결 참조로 보고하는가** 이다.
        assert.ok(!/unresolved variables:.*pick\.typo/.test(report),
            `보간하지 않는 필드를 미해결로 보고했다:\n${report}`);
        assert.ok(!/fix before running/i.test(report),
            `고칠 것이 없는데 수정을 요구했다:\n${report}`);
    });

    test('summary has helpful hint about runtime behavior', () => {
        const item: ActionItem = {
            id: 'a.0b',
            title: 'ok',
            action: { description: 'x', tasks: [{ id: 't', type: 'shell', command: 'echo ok' }] }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /Placeholder values like <fileDialog:id:path> become real values at runtime/);
    });

    test('unresolved summary lists fix-before-running guidance', () => {
        const item: ActionItem = {
            id: 'a.0c',
            title: 'bad',
            action: { description: 'x', tasks: [{ id: 't', type: 'shell', command: 'echo ${typo.bad}' }] }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /fix before running/);
        assert.match(report, /passed through as literal/);
    });

    test('reports tasks count and description', () => {
        const item: ActionItem = {
            id: 'a.1',
            title: 'My Action',
            action: {
                description: 'does a thing',
                tasks: [
                    { id: 't1', type: 'shell', command: 'echo hi' }
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /My Action/);
        assert.match(report, /a\.1/);
        assert.match(report, /Description: does a thing/);
        assert.match(report, /Tasks: 1/);
        assert.match(report, /command: echo hi/);
    });

    test('handles empty tasks array', () => {
        const item: ActionItem = {
            id: 'a.2',
            title: 'Empty',
            action: { description: 'x', tasks: [] }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /no executable action or empty tasks array/);
    });

    test('interpolates ${workspaceFolder} in command', () => {
        const item: ActionItem = {
            id: 'a.3',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 's', type: 'shell', command: 'ls ${workspaceFolder}' }]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.ok(report.includes(`ls ${WS}`), `report should contain resolved path, got: ${report}`);
    });

    test('flags unresolved variables in summary', () => {
        const item: ActionItem = {
            id: 'a.4',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 's', type: 'shell', command: 'run ${missing.value}' }]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /unresolved/i);
        assert.match(report, /\$\{missing\.value\}/);
    });

    test('upstream task output flows to downstream via simulated placeholder', () => {
        const item: ActionItem = {
            id: 'a.5',
            title: 'T',
            action: {
                description: 'x',
                tasks: [
                    { id: 'pick', type: 'fileDialog' } as any,
                    { id: 'run', type: 'shell', command: 'process ${pick.path}' }
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /process <fileDialog:pick:path>/);
        assert.doesNotMatch(report.split('Summary:')[1], /\$\{pick/);
    });

    test('envPick value flows to downstream via simulated placeholder', () => {
        const item: ActionItem = {
            id: 'a.env',
            title: 'T',
            action: {
                description: 'x',
                tasks: [
                    { id: 'pickEnv', type: 'envPick', placeHolder: 'pick env' },
                    { id: 'run', type: 'shell', command: 'echo ${pickEnv.value}' }
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /placeHolder: pick env/);
        assert.match(report, /echo <envPick:pickEnv:value>/);
        assert.doesNotMatch(report.split('Summary:')[1], /\$\{pickEnv/);
    });

    test('quickPick itemsFromCommand is rendered and interpolated (string form)', () => {
        const item: ActionItem = {
            id: 'a.ifc',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'branch',
                    type: 'quickPick',
                    itemsFromCommand: 'git for-each-ref ${workspaceFolder}'
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /itemsFromCommand: git for-each-ref/);
        // ${workspaceFolder} inside itemsFromCommand must be interpolated.
        assert.ok(report.includes(`git for-each-ref ${WS}`), `expected resolved path, got: ${report}`);
        assert.match(report, /itemsFromCommandFormat: lines/);
        assert.match(report, /items will be populated from this command/);
        // The static items(N) listing must not appear for a dynamic source.
        assert.doesNotMatch(report, /items \(\d+\):/);
    });

    test('quickPick 구조화 동적 목록 형식을 미리보기에 표시한다', () => {
        const item: ActionItem = {
            id: 'a.ifc-jsonl', title: 'T', action: {
                description: 'x', tasks: [{
                    id: 'target', type: 'quickPick',
                    itemsFromCommand: 'list-targets --jsonl',
                    itemsFromCommandFormat: 'jsonl',
                } as any],
            },
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /itemsFromCommandFormat: jsonl/);
    });

    test('quickPick args 결과는 활성 목록 소스만 보고 시뮬레이션한다', () => {
        const lines = simulateTaskResult({
            id: 'pick', type: 'quickPick',
            items: [{ label: 'Stale', args: ['--stale'] }],
            itemsFromCommand: 'list', itemsFromCommandFormat: 'lines',
        } as any);
        const jsonl = simulateTaskResult({
            id: 'pick', type: 'quickPick',
            itemsFromCommand: 'list', itemsFromCommandFormat: 'jsonl',
        } as any);
        const emptyCommand = simulateTaskResult({
            id: 'pick', type: 'quickPick', itemsFromCommand: '',
            items: [{ label: 'Static', args: ['--static'] }],
        } as any);
        assert.ok(!Object.prototype.hasOwnProperty.call(lines, 'args'));
        assert.ok(Array.isArray(jsonl.args));
        assert.ok(Array.isArray(emptyCommand.args), '빈 command가 정적 args mapping을 죽였다');
    });

    test('quickPick itemsFromCommand surfaces unresolved variables in summary', () => {
        const item: ActionItem = {
            id: 'a.ifc2',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'branch',
                    type: 'quickPick',
                    itemsFromCommand: 'list ${missing.value}'
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /unresolved/i);
        assert.match(report, /\$\{missing\.value\}/);
    });

    test('pathDialog의 동적 mode와 결과 키를 미리보기에 반영한다', () => {
        const item: ActionItem = {
            id: 'a.path-dialog', title: 'T', action: {
                description: 'x', tasks: [
                    { id: 'kind', type: 'quickPick', items: ['file', 'folder'] },
                    { id: 'target', type: 'pathDialog', mode: '${kind.value}' } as any,
                    { id: 'run', type: 'command', command: 'tool', args: ['${target.path}', '${target.paths}'] },
                ],
            },
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /mode:\s+<quickPick:kind:value>/);
        assert.doesNotMatch(report.split('Summary:')[1], /\$\{target\.(?:path|paths)\}/);
    });

    test('quickPick 기본값·직접 입력·선택 기억 설정을 리포트에 보여 준다', () => {
        const options = baseOptions();
        const report = buildPreviewReport({
            id: 'quick-options', title: 'Quick options',
            action: {
                description: 'd',
                tasks: [{
                    id: 'mode', type: 'quickPick', items: ['Debug', 'Release'],
                    default: '${workspaceFolder}', allowCustom: true, rememberLastSelection: true,
                }],
            },
        }, options);
        assert.ok(report.includes(`default: ${options.workspaceFolder}`));
        assert.match(report, /allowCustom: true/);
        assert.match(report, /rememberLastSelection: true/);
    });

    test('quickPick의 동적 label·detail·value·args를 표시하고 미해결도 센다', () => {
        const report = buildPreviewReport({
            id: 'quick-mapping', title: 'Quick mapping',
            action: {
                description: 'd',
                tasks: [{
                    id: 'mode', type: 'quickPick',
                    items: [{
                        label: 'Mode ${ghost.label}',
                        detail: 'detail ${ghost.detail}',
                        value: ['--mode', '${ghost.value}'],
                        args: ['--target', '${ghost.args}'],
                    }],
                }],
            },
        }, baseOptions());
        assert.match(report, /→ \["--mode","\$\{ghost\.value\}"\]/);
        assert.match(report, /args: \["--target","\$\{ghost\.args\}"\]/);
        for (const ref of ['${ghost.label}', '${ghost.detail}', '${ghost.value}', '${ghost.args}']) {
            assert.ok(report.includes(ref), `${ref}가 Preview에서 사라졌다`);
        }
        assert.match(report, /unresolved/i);
    });

    test('quickPick의 별도 args 결과가 후속 command에서 argv로 펼쳐진다', () => {
        const report = buildPreviewReport({
            id: 'quick-args', title: 'Quick args',
            action: {
                description: 'd',
                tasks: [
                    {
                        id: 'kind', type: 'quickPick',
                        items: [{ label: 'File', value: 'file', args: ['--input-file'] }],
                    },
                    { id: 'run', type: 'command', command: 'tool', args: ['${kind.args}', 'target.zip'] },
                ],
            },
        }, baseOptions());
        assert.match(report, /args:\s+\["<quickPick:kind:args\[0\]>", "target\.zip"\]/);
        assert.doesNotMatch(report.split('Summary:')[1], /\$\{kind\.args\}/);
    });

    test('quickPick label-keyed 축약형과 단일 args를 기존 항목처럼 표시한다', () => {
        const report = buildPreviewReport({
            id: 'quick-compact', title: 'Quick compact', action: {
                description: 'd',
                tasks: [
                    {
                        id: 'kind', type: 'quickPick',
                        items: {
                            'ZIP 파일': { value: 'file', args: '--input-file' },
                            '폴더': { value: 'folder', args: ['--input-dir'] },
                        },
                    },
                    { id: 'run', type: 'command', command: 'tool', args: ['${kind.args}'] },
                ],
            },
        }, baseOptions());
        assert.match(report, /ZIP 파일\s+→ file\s+args: \["--input-file"\]/);
        assert.match(report, /폴더\s+→ folder\s+args: \["--input-dir"\]/);
        assert.match(report, /args:\s+\["<quickPick:kind:args\[0\]>"\]/);
    });

    test('forEach의 반복 횟수와 each 보간 결과를 보여 준다', () => {
        const report = buildPreviewReport({
            id: 'foreach-preview', title: 'For each',
            action: {
                description: 'd',
                tasks: [
                    { id: 'files', type: 'fileDialog', options: { canSelectMany: true } },
                    {
                        id: 'inspect', type: 'command', forEach: '${files.paths}',
                        command: 'tool', args: ['${each}', '${each.number}/${each.count}'],
                    },
                ],
            },
        }, baseOptions());
        assert.match(report, /forEach: \$\{files\.paths\}/);
        assert.match(report, /repeats 2 time\(s\) sequentially/);
        assert.match(report, /<fileDialog:files:paths\[0\]>/);
        assert.match(report, /1\/2/);
        assert.doesNotMatch(report, /unresolved variable\(s\).*each/i);
    });

    test('when에서 each를 쓰면 실행 전 차단을 미리 알린다', () => {
        const report = buildPreviewReport({
            id: 'foreach-when', title: 'For each when',
            action: {
                description: 'd',
                tasks: [{
                    id: 'run', type: 'command', forEach: ['a'], command: 'tool',
                    when: { var: '${each.value}', equals: 'a' },
                }],
            },
        }, baseOptions());
        assert.match(report, /evaluated before 'forEach'/);
        assert.match(report, /would FAIL at runtime/i);
    });

    test('lists capture rules and references downstream', () => {
        const item: ActionItem = {
            id: 'a.6',
            title: 'T',
            action: {
                description: 'x',
                tasks: [
                    {
                        id: 'git',
                        type: 'shell',
                        command: 'git rev-parse HEAD',
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'sha', regex: '([a-f0-9]{7})' }
                        }
                    } as any,
                    { id: 'use', type: 'shell', command: 'tag ${git.sha}' }
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /capture \(1\)/);
        assert.match(report, /\$\{git\.sha\}/);
        assert.match(report, /tag <capture:git:sha>/);
    });

    test('warns when capture is defined without passTheResultToNextTask', () => {
        const item: ActionItem = {
            id: 'a.7',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'sh', type: 'shell', command: 'echo 1',
                    output: { capture: { name: 'v' } }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /captures will be skipped/);
        // shell/command 에는 어떻게 고치는지까지 말해 준다.
        assert.match(report, /passTheResultToNextTask/);

        // **타입으로 가르지 않는다.** 조건은 "문자열 결과가 나는가" 이므로 애초에
        // 문자열을 내지 않는 타입의 capture 도 알려야 한다 — `(shell|command)` 로
        // 좁혀 두던 동안 이쪽은 아무 말 없이 지나갔다.
        const dialogCapture: ActionItem = {
            id: 'a.7b', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'pick', type: 'fileDialog', output: { capture: { name: 'v' } } } as any],
            },
        };
        assert.match(buildPreviewReport(dialogCapture, baseOptions()), /captures will be skipped/);

        // 문자열 결과를 내는 태스크의 capture 는 skip 되지 않는다.
        const live: ActionItem = {
            id: 'a.7c', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'norm', type: 'stringManipulation', function: 'trim', input: 'x',
                          output: { capture: { name: 'v' } } } as any],
            },
        };
        assert.doesNotMatch(buildPreviewReport(live, baseOptions()), /captures will be skipped/);
    });

    test('flags file write outside workspace', () => {
        const outside = path.resolve(os.tmpdir(), 'some-other-place', 'out.txt');
        const item: ActionItem = {
            id: 'a.8',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'w', type: 'shell', command: 'echo 1',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: outside }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /OUTSIDE WORKSPACE/);
    });

    test('file write inside workspace is not flagged', () => {
        const item: ActionItem = {
            id: 'a.9',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'w', type: 'shell', command: 'echo 1',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: 'out.txt' }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.doesNotMatch(report, /OUTSIDE WORKSPACE/);
    });

    test('file mode without overwrite shows default false with explanation', () => {
        const item: ActionItem = {
            id: 'a.11',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'w', type: 'shell', command: 'echo 1',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: 'out.txt' }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /overwrite: false \(default/);
    });

    test('file mode with explicit overwrite: true shows boolean as-is', () => {
        const item: ActionItem = {
            id: 'a.12',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'w', type: 'shell', command: 'echo 1',
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: 'out.txt', overwrite: true }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /overwrite: true/);
        assert.doesNotMatch(report, /overwrite:.*\(default/);
    });

    test('string overwrite interpolates and shows effective boolean', () => {
        const item: ActionItem = {
            id: 'a.13',
            title: 'T',
            action: {
                description: 'x',
                tasks: [
                    { id: 'ask', type: 'confirm', message: 'yes?' } as any,
                    {
                        id: 'w', type: 'shell', command: 'echo 1',
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'file',
                            filePath: 'out.txt',
                            overwrite: '${ask.confirmed}'
                        }
                    } as any
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /"\$\{ask\.confirmed\}"/);
        assert.match(report, /→  true/);
    });

    test('non-file mode without overwrite does not show default', () => {
        const item: ActionItem = {
            id: 'a.14',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{
                    id: 'w', type: 'shell', command: 'echo 1',
                    passTheResultToNextTask: true,
                    output: { mode: 'editor' }
                } as any]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.doesNotMatch(report, /overwrite/);
    });

    test('summary: all resolved when no unresolved refs', () => {
        const item: ActionItem = {
            id: 'a.10',
            title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'run', type: 'shell', command: 'echo ok' }]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /all \$\{\.\.\.\} references resolve/);
    });

    test('does not flag forward reference to a later task in the same action', () => {
        // Auto-inferred dep flips the runtime order to B → A; the linear
        // simulation must not raise a spurious "unresolved" for ${B.output}.
        // Both tasks must be `parallel: true` so the runtime can actually
        // reorder — pre-fix this fixture had B sequential, which produces
        // a real cycle (A→B inferred + B→A barrier) the runtime rejects.
        // B must capture its output (passTheResultToNextTask: true) — without
        // it the M9 check correctly flags ${B.output} as never captured.
        const item: ActionItem = {
            id: 'a.fwdref',
            title: 'forward ref',
            action: {
                description: 'x',
                tasks: [
                    { id: 'A', type: 'shell', command: 'echo ${B.output}', parallel: true } as any,
                    { id: 'B', type: 'shell', command: 'make build', parallel: true, passTheResultToNextTask: true } as any,
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.doesNotMatch(report, /unresolved variables/i,
            `forward task ref should not be reported as unresolved; got: ${report}`);
        assert.doesNotMatch(report, /Graph issues/i,
            `valid forward-ref must not raise graph issues; got: ${report}`);
        assert.match(report, /all \$\{\.\.\.\} references resolve/);
    });

    test('reports cycle when parallel forward-ref + sequential barrier form a cycle', () => {
        // A is parallel and references B's output (A.inferredDeps={B}).
        // B is sequential after A so B.barrierDeps={A}. Union → cycle.
        // Pre-fix the linear simulator showed this as "all resolved" by
        // tolerating every forward ref; runtime would refuse to schedule.
        const item: ActionItem = {
            id: 'a.cycle.parallel-vs-barrier',
            title: 'parallel-barrier cycle',
            action: {
                description: 'x',
                tasks: [
                    { id: 'A', type: 'shell', command: 'echo ${B.output}', parallel: true } as any,
                    { id: 'B', type: 'shell', command: 'make build' } as any,
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /Graph issues/);
        assert.match(report, /dependency cycle/);
        assert.match(report, /Summary: action would FAIL at start/);
    });

    test('죽은 output 필드를 실행되는 것처럼 검사하지 않는다', () => {
        // Preview 만 조건을 빼면 Doctor 는 `output.ignored` 만 내는 설정에
        // "fix before running" · "OUTSIDE WORKSPACE" 를 띄워 두 진단이 어긋난다.
        const dead: ActionItem = {
            id: 'a.deadout', title: 'dead output',
            action: {
                description: 'x',
                tasks: [{
                    id: 'B', type: 'shell', command: 'x',
                    output: { mode: 'file', filePath: '/etc/passwd', content: '${ghost.output}' },
                } as any],
            },
        };
        const report = buildPreviewReport(dead, baseOptions());
        assert.doesNotMatch(report, /OUTSIDE WORKSPACE/, '꺼진 output 의 경로를 실행 차단으로 표시했다');
        assert.doesNotMatch(report, /fix before running/, '꺼진 output 의 참조를 미해결로 올렸다');
        assert.match(report, /ignored/, '왜 무시되는지 알려 주지 않았다');

        // `mode` 가 `file` 이 아니면 `filePath`·`overwrite` 는 죽은 필드다.
        const editorMode: ActionItem = {
            id: 'a.editorout', title: 'editor output',
            action: {
                description: 'x',
                tasks: [{
                    id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                    output: { mode: 'editor', filePath: '/etc/passwd', overwrite: '${ghost.output}' },
                } as any],
            },
        };
        const editorReport = buildPreviewReport(editorMode, baseOptions());
        assert.doesNotMatch(editorReport, /OUTSIDE WORKSPACE/, "mode: editor 의 filePath 를 검사했다");
        assert.doesNotMatch(editorReport, /fix before running/, 'mode: editor 의 overwrite 를 검사했다');
    });

    test('무시 사유는 실제로 무시되는 필드만 가리킨다', () => {
        // `capture` · `diagnostics` 는 이 조건 **밖**이다 — 런타임은 결과에 문자열
        // `output` 이 있으면 돌리고, `stringManipulation` 은 플래그 없이도 해당한다.
        // "블록 전체가 무시된다" 고 적으면 같은 리포트가 downstream 에서 그 capture
        // 를 정상 해석하며 스스로 모순된다.
        const item: ActionItem = {
            id: 'a.cap', title: 'capture without flag',
            action: {
                description: 'x',
                tasks: [
                    { id: 'norm', type: 'stringManipulation', function: 'trim', input: 'x',
                      output: { mode: 'editor', capture: { name: 'ver', pattern: '(\\d+)' } } } as any,
                    { id: 'use', type: 'shell', command: 'echo ${norm.ver}' } as any,
                ],
            },
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.doesNotMatch(report, /block is ignored/, 'capture 가 도는데 블록 전체가 무시된다고 했다');
        assert.match(report, /are ignored/, '무시되는 필드를 알려 주지 않았다');
        // downstream 의 capture 참조는 정상 해석된다 — 위 문구와 어긋나면 안 된다.
        assert.doesNotMatch(report, /fix before running/, 'capture 참조를 미해결로 올렸다');
    });

    test('capture / diagnostics 안내가 같은 리포트 안에서 어긋나지 않는다', () => {
        // 머리말이 "영향 없음" 이라고 하면서 몇 줄 뒤에서 "skip 된다" 고 말하던 자리다.
        const shellNoFlag: ActionItem = {
            id: 'a.capshell', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'b', type: 'shell', command: 'x',
                          output: { mode: 'editor', capture: { name: 'v', pattern: '(a)' } } } as any],
            },
        };
        const report = buildPreviewReport(shellNoFlag, baseOptions());
        assert.doesNotMatch(report, /capture \/ diagnostics are not affected/, '영향 없다고 해 놓고 아래에서 skip 된다고 했다');
        assert.match(report, /capture \/ diagnostics are skipped/, 'skip 사실을 머리말에서 알리지 않았다');

        // 문자열 결과를 내면 반대로 "따로 돈다" 고 말한다.
        const live: ActionItem = {
            id: 'a.caplive', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'norm', type: 'stringManipulation', function: 'trim', input: 'x',
                          output: { mode: 'editor', capture: { name: 'v', pattern: '(a)' } } } as any],
            },
        };
        assert.match(buildPreviewReport(live, baseOptions()), /capture \/ diagnostics run separately/);
    });

    test('쓰이지 않는 `language` 에도 사유를 적는다', () => {
        // 런타임은 `mode: 'editor'` 에서만 language 를 쓴다.
        const dead: ActionItem = {
            id: 'a.lang', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'b', type: 'shell', command: 'x', passTheResultToNextTask: true,
                          output: { mode: 'file', filePath: 'f.txt', language: 'javascript' } } as any],
            },
        };
        const line = buildPreviewReport(dead, baseOptions()).split('\n').find(l => l.includes('language:'));
        assert.ok(line && /not used/.test(line), `죽은 language 에 사유가 없다: ${line?.trim()}`);

        const live: ActionItem = {
            id: 'a.lang2', title: 'T',
            action: {
                description: 'x',
                tasks: [{ id: 'b', type: 'shell', command: 'x', passTheResultToNextTask: true,
                          output: { mode: 'editor', language: 'javascript' } } as any],
            },
        };
        const liveLine = buildPreviewReport(live, baseOptions()).split('\n').find(l => l.includes('language:'));
        assert.ok(liveLine && !/not used/.test(liveLine), `살아 있는 language 에 사유를 붙였다: ${liveLine?.trim()}`);
    });

    test('쓰이지 않는 boolean `overwrite` 에도 사유를 적는다', () => {
        // 문자열에만 사유를 붙이면 `overwrite: true` 가 살아 있는 것처럼 보인다.
        const item: ActionItem = {
            id: 'a.ow', title: 'dead overwrite',
            action: {
                description: 'x',
                tasks: [{ id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                          output: { mode: 'editor', overwrite: true } } as any],
            },
        };
        const line = buildPreviewReport(item, baseOptions()).split('\n').find(l => l.includes('overwrite:'));
        assert.ok(line, 'overwrite 줄이 없다');
        assert.match(line!, /not used/, `죽은 boolean overwrite 에 사유가 없다: ${line!.trim()}`);

        // `mode: 'file'` 이면 사유 없이 그대로 보여 준다.
        const live: ActionItem = {
            id: 'a.ow2', title: 'live overwrite',
            action: {
                description: 'x',
                tasks: [{ id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                          output: { mode: 'file', filePath: 'f.txt', overwrite: true } } as any],
            },
        };
        const liveLine = buildPreviewReport(live, baseOptions()).split('\n').find(l => l.includes('overwrite:'));
        assert.doesNotMatch(liveLine!, /not used/, `살아 있는 overwrite 에 사유를 붙였다: ${liveLine!.trim()}`);
    });

    test('살아 있는 output 은 종전대로 검사한다', () => {
        // 위 제외가 넓어지면 이번엔 진짜 문제가 조용해진다 — 양쪽을 함께 고정한다.
        const live: ActionItem = {
            id: 'a.liveout', title: 'live output',
            action: {
                description: 'x',
                tasks: [{
                    id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: '/etc/passwd', content: '${ghost.output}' },
                } as any],
            },
        };
        const report = buildPreviewReport(live, baseOptions());
        assert.match(report, /OUTSIDE WORKSPACE/, '살아 있는 경로를 놓쳤다');
        assert.match(report, /fix before running/, '살아 있는 참조를 놓쳤다');
    });

    test('folds a pipeline-length cycle path in the report', () => {
        // Preview 도 Doctor·실행과 같은 `formatCyclePath` 를 쓴다 — 한 곳만 접으면
        // 12,000개 순환에서 보고서 한 줄이 10만 자를 넘는다.
        const N = 2000;
        const tasks: any[] = [{ id: 'T0', type: 'shell', command: `echo \${T${N - 1}.output}` }];
        for (let i = 1; i < N; i++) { tasks.push({ id: `T${i}`, type: 'shell', command: `echo ${i}` }); }
        const item: ActionItem = {
            id: 'a.longcycle', title: 'long cycle',
            action: { description: 'x', tasks },
        };
        const report = buildPreviewReport(item, baseOptions());
        const line = report.split('\n').find(l => l.includes('dependency cycle'));
        assert.ok(line, `순환 줄을 찾지 못했다`);
        assert.ok(line!.length < 300, `Preview 줄이 여전히 길다 (${line!.length}자)`);
        assert.ok(line!.includes('more)'), `경로를 접지 않았다: ${line!.slice(0, 160)}`);
        // Preview 는 유니코드 화살표를 쓴다 — 공용 함수를 쓰되 표기는 유지한다.
        assert.ok(line!.includes(' → '), `Preview 의 화살표 표기가 사라졌다: ${line!.slice(0, 160)}`);
    });

    test('reports missing-dependency from `dependsOn` referencing an unknown task', () => {
        const item: ActionItem = {
            id: 'a.missingdep',
            title: 'missing dep',
            action: {
                description: 'x',
                tasks: [
                    { id: 'A', type: 'shell', command: 'make', dependsOn: ['ghost'] } as any,
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /Graph issues/);
        assert.match(report, /unknown task 'ghost'/);
    });

    test('still flags ${alreadyRan.typoKey} after the producer has been simulated', () => {
        // `producer` runs first and exposes `output` / `outputDir`.
        // `consumer` references `${producer.typoKey}` which is NOT a
        // captured / built-in result key — pre-fix the head check
        // suppressed every `${producer.*}` ref because `producer` was a
        // valid task id, masking the typo. Post-fix `producer` is no
        // longer in the forward-id set by the time `consumer` runs, so
        // the typo surfaces as unresolved.
        const item: ActionItem = {
            id: 'a.typo.aftersim',
            title: 'typo after sim',
            action: {
                description: 'x',
                tasks: [
                    { id: 'producer', type: 'shell', command: 'make build', passTheResultToNextTask: true } as any,
                    { id: 'consumer', type: 'shell', command: 'echo ${producer.typoKey}' } as any,
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /unresolved/i);
        assert.match(report, /\$\{producer\.typoKey\}/);
    });

    test('still flags unresolved when head is not a task id in this action', () => {
        const item: ActionItem = {
            id: 'a.unknownhead',
            title: 'unknown head',
            action: {
                description: 'x',
                tasks: [
                    { id: 'A', type: 'shell', command: 'echo ${notATask.output}' } as any,
                    { id: 'B', type: 'shell', command: 'make build' } as any,
                ]
            }
        };
        const report = buildPreviewReport(item, baseOptions());
        assert.match(report, /unresolved/i);
        assert.match(report, /\$\{notATask\.output\}/);
    });

    suite('zip/unzip built-in engine preview', () => {
        // 0.6.52: 아카이브 경로의 상대 기준점이 `task.cwd` → 워크스페이스로
        // 바뀐 자리다. Preview 의 목적이 "어디에 떨어지는가" 를 보여 주는 것인데
        // `writeFile` 만 `→ resolves to:` 를 달고 있었다.
        test('상대 archive/destination 이 어디로 풀리는지 보여 준다', () => {
            const item: ActionItem = {
                id: 'a.zip.rel',
                title: 'relative',
                action: {
                    description: 'relative paths',
                    tasks: [{ id: 'pack', type: 'zip', archive: 'out/bundle.zip', source: ['src'] }]
                }
            } as unknown as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.ok(
                report.includes(`→ resolves to: ${path.join(WS, 'out', 'bundle.zip')}`),
                `상대 archive 의 해석 결과가 보이지 않는다:\n${report}`
            );
        });

        test('task.cwd 가 있으면 그 기준으로 보여 준다', () => {
            const item: ActionItem = {
                id: 'a.zip.cwd',
                title: 'cwd base',
                action: {
                    description: 'cwd base',
                    tasks: [{ id: 'pack', type: 'zip', cwd: `${WS}/build`, archive: 'bundle.zip', source: ['src'] }]
                }
            } as unknown as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.ok(
                report.includes(`→ resolves to: ${path.join(WS, 'build', 'bundle.zip')}`),
                `cwd 기준 해석 결과가 보이지 않는다:\n${report}`
            );
        });

        test('시뮬레이션 자리표시자에는 해석 결과를 붙이지 않는다', () => {
            // 런타임에 `${pack.archivePath}` 자리에 오는 값은 **이미 해석된 절대
            // 경로**라 기준점이 적용되지 않는다. 여기서 붙이면 미리보기가 실제와
            // 다른 경로를 자신 있게 보여 준다.
            const item: ActionItem = {
                id: 'a.zip.ph',
                title: 'placeholder',
                action: {
                    description: 'chained',
                    tasks: [
                        { id: 'pack', type: 'zip', archive: `${WS}/out.zip`, source: ['src'] },
                        { id: 'unpack', type: 'unzip', archive: '${pack.archivePath}', destination: `${WS}/x` },
                    ]
                }
            } as unknown as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.ok(
                !/resolves to:.*<zip:pack:archivePath>/.test(report),
                `자리표시자에 해석 결과를 붙였다:\n${report}`
            );
        });

        test('zip task without tool reports built-in engine', () => {
            const item: ActionItem = {
                id: 'a.zip.builtin',
                title: 'Built-in zip',
                action: {
                    description: 'bundled engine',
                    tasks: [
                        {
                            id: 'pack',
                            type: 'zip',
                            archive: '${workspaceFolder}/out.zip',
                            source: ['${workspaceFolder}/a.txt']
                        }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /tool: \(built-in engine — \.zip only\)/);
            assert.match(report, /archive:\s+.*out\.zip/);
        });

        test('unzip task without tool reports built-in engine', () => {
            const item: ActionItem = {
                id: 'a.unzip.builtin',
                title: 'Built-in unzip',
                action: {
                    description: 'bundled engine',
                    tasks: [
                        {
                            id: 'unpack',
                            type: 'unzip',
                            archive: '${workspaceFolder}/in.zip',
                            destination: '${workspaceFolder}/extracted'
                        }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /tool: \(built-in engine — \.zip only\)/);
            assert.match(report, /archive:\s+.*in\.zip/);
            assert.match(report, /destination:\s+.*extracted/);
        });

        test('zip task with tool still shows tool path', () => {
            const item: ActionItem = {
                id: 'a.zip.external',
                title: 'External zip',
                action: {
                    description: '7z tool',
                    tasks: [
                        {
                            id: 'pack',
                            type: 'zip',
                            tool: '/usr/local/bin/7z',
                            archive: '${workspaceFolder}/out.7z',
                            source: ['${workspaceFolder}/a.txt']
                        }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /tool: \/usr\/local\/bin\/7z/);
            assert.doesNotMatch(report, /built-in engine/);
        });

        /**
         * OS별 `tool` 객체는 **현재 플랫폼이 고를 branch 하나**만 본다.
         *
         * Preview 는 "지금 이 기계에서 실행하면" 을 보여 주는 자리이고, 런타임의
         * `getToolCommand` 도 그 하나만 고른다. 모든 branch 를 훑던 시절에는
         * 정상 설정이 미해결로 막히고(다른 OS branch 의 참조), 반대로 현재
         * 플랫폼 branch 가 없는 객체는 런타임에서 던지는데도 "모두 해석됨" 이
         * 나왔다. (설정 자체의 오류는 Doctor 가 모든 branch 를 훑어 잡는다.)
         */
        suite('OS별 tool', () => {
            const ACTIVE_OS = process.platform === 'win32' ? 'windows'
                : process.platform === 'darwin' ? 'macos' : 'linux';
            const INACTIVE_OS = ACTIVE_OS === 'windows' ? 'macos' : 'windows';

            function zipWithTool(id: string, tool: unknown): ActionItem {
                return {
                    id,
                    title: 'os tool',
                    action: {
                        description: 'per-platform tool',
                        tasks: [
                            {
                                id: 'pack',
                                type: 'zip',
                                tool,
                                archive: '${workspaceFolder}/out.7z',
                                source: ['${workspaceFolder}/a.txt']
                            }
                        ]
                    }
                } as unknown as ActionItem;
            }

            test('현재 플랫폼 branch 만 표시한다', () => {
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os', { [ACTIVE_OS]: '/tools/active-7z', [INACTIVE_OS]: '/tools/other-7z' }),
                    baseOptions()
                );
                assert.match(report, /tool: \/tools\/active-7z/);
                assert.ok(
                    !report.includes('/tools/other-7z'),
                    `실행되지 않을 branch 까지 보여 주면 무엇이 돌지 헷갈린다:\n${report}`
                );
            });

            test('비활성 branch 의 미해결 참조는 보고하지 않는다', () => {
                // 이 기계에서는 정상 실행 가능한 설정이다. 막으면 안 된다.
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os.ghost', { [ACTIVE_OS]: '/usr/bin/7z', [INACTIVE_OS]: '${ghost.output}' }),
                    baseOptions()
                );
                assert.ok(
                    !report.includes('${ghost.output}'),
                    `현재 플랫폼에서 실행되지 않는 branch 때문에 정상 설정이 막혔다:\n${report}`
                );
                assert.match(report, /all \$\{\.\.\.\} references resolve/);
            });

            test('현재 플랫폼 branch 의 미해결 참조는 그대로 보고한다', () => {
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os.active-ghost', { [ACTIVE_OS]: '${ghost.output}' }),
                    baseOptions()
                );
                assert.match(report, /unresolved/i);
                assert.ok(report.includes('${ghost.output}'), `실제로 실행될 참조를 놓쳤다:\n${report}`);
            });

            test('현재 플랫폼 branch 가 없으면 실패를 경고한다', () => {
                // 런타임의 `getToolCommand` 가 던지는 설정이다.
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os.missing', { [INACTIVE_OS]: '/tools/other-7z' }),
                    baseOptions()
                );
                assert.match(report, /tool: \(none for this platform\)/);
                assert.match(report, new RegExp(`no 'tool' entry for ${process.platform}`));
                assert.doesNotMatch(report, /built-in engine/, 'tool 을 지정했는데 내장 엔진처럼 보이면 안 된다');
            });

            /**
             * 인라인 경고만으로는 부족하다. Preview 리포트는 길어서 **요약만
             * 읽는** 사용법이 정상인데, 참조가 전부 해석되면 요약은 `all ${...}
             * references resolve` 였다 — 실행하면 실패할 액션을 정상이라고
             * 안내하는 셈이다. 미해결 참조와는 독립된 종류의 실패다.
             */
            test('요약이 "모두 해석됨" 이라고 말하지 않는다', () => {
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os.missing-summary', { [INACTIVE_OS]: '/tools/other-7z' }),
                    baseOptions()
                );
                assert.doesNotMatch(report, /Summary: all \$\{\.\.\.\} references resolve/,
                    `실행 불가인데 요약이 정상이라고 말한다:\n${report}`);
                assert.match(report, /Summary: 1 task\(s\) would FAIL at runtime/);
                assert.ok(report.includes(`task 'pack': no 'tool' entry for ${process.platform}`),
                    `요약에 어느 태스크인지 없다:\n${report}`);
            });

            /**
             * `source` 는 `handleZip` 이 원소마다 보간하는 값인데 Preview 만
             * 보지 않았다 — Doctor 는 이미 검사하고 있어, 같은 파일을 두고 두
             * 진단이 어긋나 있었다.
             */
            test('zip 의 source 참조도 검사한다', () => {
                const item = {
                    id: 'a.zip.source',
                    title: 'zip source',
                    action: {
                        description: 'source refs',
                        tasks: [{
                            id: 'pack',
                            type: 'zip',
                            archive: '${workspaceFolder}/out.zip',
                            source: ['${ghost.output}']
                        }]
                    }
                } as unknown as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.ok(report.includes('${ghost.output}'),
                    `source 안의 미해결 참조를 놓쳤다:\n${report}`);
                assert.doesNotMatch(report, /Summary: all \$\{\.\.\.\} references resolve/);
            });

            test('해석되는 source 는 경로로 보여 준다', () => {
                // 과탐 방지 + Preview 의 목적(어디에 떨어지는지) 확인.
                const item = {
                    id: 'a.zip.source.ok',
                    title: 'zip source ok',
                    action: {
                        description: 'source refs',
                        tasks: [{
                            id: 'pack',
                            type: 'zip',
                            archive: '${workspaceFolder}/out.zip',
                            source: ['${workspaceFolder}/a.txt']
                        }]
                    }
                } as unknown as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.match(report, /source:/, `source 를 표시하지 않는다:\n${report}`);
                assert.match(report, /Summary: all \$\{\.\.\.\} references resolve/);
            });

            test('현재 플랫폼 branch 가 있으면 요약은 종전대로 정상이다', () => {
                // 과탐 방지 — 차단 요약이 정상 설정에까지 붙으면 안 된다.
                const report = buildPreviewReport(
                    zipWithTool('a.zip.os.ok-summary', { [ACTIVE_OS]: '/tools/7z' }),
                    baseOptions()
                );
                assert.match(report, /Summary: all \$\{\.\.\.\} references resolve/);
                assert.doesNotMatch(report, /would FAIL at runtime/);
            });
        });
    });

    suite('symlink escape detection (M10 후속 회귀 가드)', () => {
        test('writeFile through an outward symlink is flagged OUTSIDE WORKSPACE', function () {
            // 런타임 resolveWithinWorkspace는 realpath 정규화로 심링크 escape를
            // 거부하는데, Preview가 어휘적 비교만 쓰면 같은 경로가 안전해
            // 보이다가 런타임에서 실패한다 — 판정 규칙을 공유해야 한다.
            if (process.platform === 'win32') { this.skip(); }
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-preview-m10-'));
            try {
                const root = path.join(base, 'ws');
                const outside = path.join(base, 'outside');
                fs.mkdirSync(root, { recursive: true });
                fs.mkdirSync(outside, { recursive: true });
                fs.symlinkSync(outside, path.join(root, 'escape'));

                const item: ActionItem = {
                    id: 'a.m10',
                    title: 'symlink escape',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'w', type: 'writeFile', path: 'escape/x.txt', content: 'hi' }
                        ]
                    }
                };
                const report = buildPreviewReport(item, {
                    workspaceFolder: root,
                    extensionPath: '/ext',
                    workspaceRoots: [root],
                });
                assert.match(report, /OUTSIDE WORKSPACE/);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        });
    });

    /**
     * 전방(뒤에 선언된) 태스크 참조의 **키**까지 검증한다.
     *
     * 자동 추론된 의존성이 실행 순서를 뒤집으므로 전방 참조 자체는 정상이다.
     * 그런데 그 관용이 head 단위라 키까지 덮어 버려서, 존재하지 않는 capture 를
     * 가리키는 오타가 앞쪽에서는 무경고로 지나갔다 — 뒤쪽 producer 에 대해서는
     * `findTypoRefs` 가 잡던 것과 비대칭이었다.
     */
    suite('전방 참조의 키 검증', () => {
        /**
         * **producer 도 `parallel: true` 여야 한다.** sequential 인 뒤쪽 태스크는
         * 앞의 모든 태스크를 기다리는 암묵적 barrier 라, 앞의 consumer 가 그것을
         * 참조하면 `consumer → producer → consumer` 사이클이 된다. 그러면
         * 실행조차 불가능한 액션을 놓고 참조 해석을 검사하는 셈이다.
         * 둘 다 parallel 이어야 실제로 돌아가는 전방 DAG 다.
         */
        function actionWithForwardRef(key: string, capture?: unknown): ActionItem {
            return {
                id: 'a.fwd',
                title: 'forward',
                action: {
                    description: 'x',
                    tasks: [
                        {
                            id: 'consumer', type: 'shell', parallel: true,
                            command: `use \${producer.${key}}`, passTheResultToNextTask: true
                        },
                        {
                            id: 'producer', type: 'shell', parallel: true,
                            command: 'make', passTheResultToNextTask: true,
                            ...(capture ? { output: { capture } } : {})
                        }
                    ]
                }
            } as ActionItem;
        }

        test("task id 가 '__proto__' 여도 결과가 정상으로 흐른다", () => {
            // 평범한 객체에 allResults['__proto__'] = sim 을 하면 own property 가
            // 만들어지지 않는다. 그러면 런타임(null-prototype)과 Preview 가 서로
            // 다른 답을 내놓는다 — Preview 는 "모두 해석됨" 인데 실행하면 리터럴.
            const item: ActionItem = {
                id: 'a.proto',
                title: 'proto id',
                action: {
                    description: 'x',
                    tasks: [
                        { id: '__proto__', type: 'shell', command: 'make', passTheResultToNextTask: true },
                        { id: 'use', type: 'shell', command: 'echo ${__proto__.output}', passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /echo <shell:__proto__:stdout>/);
            assert.doesNotMatch(report, /unresolved variables:/);
        });

        test('fixture 자체가 실행 가능한 DAG 다 (사이클이 아니다)', () => {
            // 이 검사가 없으면 아래 테스트들이 "사이클이라 실행 불가" 인 액션을
            // 놓고 참조 해석을 논하게 된다.
            const report = buildPreviewReport(actionWithForwardRef('output'), baseOptions());
            assert.doesNotMatch(report, /dependency cycle/);
        });

        test('전방 producer 가 내지 않는 capture 이름은 미해결로 보고한다', () => {
            const report = buildPreviewReport(
                actionWithForwardRef('safe', { name: 'version', regex: 'v(\\d+)' }),
                baseOptions()
            );
            assert.match(report, /unresolved variables:.*\$\{producer\.safe\}/);
        });

        test('선언된 capture 이름은 그대로 관용한다', () => {
            const report = buildPreviewReport(
                actionWithForwardRef('version', { name: 'version', regex: 'v(\\d+)' }),
                baseOptions()
            );
            assert.doesNotMatch(report, /unresolved variables:.*\$\{producer\.version\}/);
        });

        test('전방 producer 의 실제 결과 키(output)는 관용한다', () => {
            const report = buildPreviewReport(actionWithForwardRef('output'), baseOptions());
            assert.doesNotMatch(report, /unresolved variables:.*\$\{producer\.output\}/);
        });

        test('bare 전방 참조는 키 검증 대상이 아니다', () => {
            const item: ActionItem = {
                id: 'a.fwdbare',
                title: 'forward bare',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${producer}', passTheResultToNextTask: true },
                        { id: 'producer', type: 'shell', parallel: true, command: 'make', passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /unresolved variables:.*\$\{producer\}/);
        });

        test('점 뒤가 빈 참조는 관용하지 않는다', () => {
            // 런타임은 `${producer.}` 를 bare 로 보지 않아 리터럴로 남긴다.
            const report = buildPreviewReport(actionWithForwardRef(''), baseOptions());
            assert.match(report, /unresolved variables:.*\$\{producer\.\}/);
        });

        test('키에 공백이 섞인 오타는 trim 으로 가려지지 않는다', () => {
            // 런타임은 키를 다듬지 않으므로 `${producer. output}` 의 키는
            // `" output"` 이고 어떤 결과 키와도 맞지 않는다.
            const report = buildPreviewReport(actionWithForwardRef(' output'), baseOptions());
            assert.match(report, /unresolved variables:/);
        });

        test('findTypoRefs 도 키의 공백을 다듬지 않는다', () => {
            // 위 테스트의 뒤쪽 절반. 전방 참조는 `findUnresolved` 가, 이미
            // 시뮬레이션된 참조는 `findTypoRefs` 가 본다 — 후자가 키를 다듬으면
            // `" path"` 가 `path` 로 읽혀 런타임이 리터럴로 남길 오타가 이 pass
            // 를 통과한다. 리포트 문자열로는 두 pass 를 구별할 수 없어(둘 다
            // `unresolved variables:` 로 합쳐진다) 함수를 직접 부른다.
            const task = { id: 'use', type: 'shell', command: 'echo ${pick. path}' } as Task;
            assert.deepStrictEqual(
                findTypoRefs(task, { pick: { path: 'P' } }, 'use'),
                ['${pick. path}']
            );
        });

        test('findUncapturedOutputRefs 도 키의 공백을 다듬지 않는다', () => {
            // `${build. output}` 은 런타임에서 어떤 키와도 맞지 않는다.
            // 다듬어 `output` 으로 읽으면 "패스 설정을 켜라" 는 처방을 내놓지만
            // 켜도 해결되지 않는다.
            const consumer = { id: 'use', type: 'shell', command: 'echo ${build. output}' } as Task;
            const build = { id: 'build', type: 'shell', command: 'make' } as Task;
            assert.strictEqual(
                findUncapturedOutputRefs(consumer, new Map([['build', build]]), 'use').size,
                0
            );
        });

        test('자기 자신을 가리키는 참조는 관용하지 않는다', () => {
            // 아직 시뮬레이션되지 않았다는 이유로 forwardTaskIds 에 들어가지만,
            // 런타임 컨텍스트에는 자기 자신이 없다.
            const item: ActionItem = {
                id: 'a.self',
                title: 'self',
                action: {
                    description: 'x',
                    tasks: [{ id: 'self', type: 'shell', command: 'echo ${self.output}', passTheResultToNextTask: true }]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /unresolved variables:.*\$\{self\.output\}/);
        });

        test('bare 전방 참조는 output / outputDir / value가 있을 때만 관용한다', () => {
            // `zip` 은 archivePath 만 낸다 — 런타임의 bare 참조는 결과 객체를
            // 문자열로 바꾸지 못해 리터럴로 남는다.
            const item: ActionItem = {
                id: 'a.barezip',
                title: 'bare zip',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${z}', passTheResultToNextTask: true },
                        { id: 'z', type: 'zip', parallel: true, source: '${workspaceFolder}/src', archive: '${workspaceFolder}/a.zip' }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /unresolved variables:.*\$\{z\}/);
        });

        test('전방 quickPick의 bare 참조는 value 축약으로 해석한다', () => {
            const item: ActionItem = {
                id: 'a.barepick',
                title: 'bare pick',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'consumer', type: 'command', parallel: true, command: 'tool', args: ['${mode}'] },
                        { id: 'mode', type: 'quickPick', parallel: true, items: ['debug', 'release'] },
                    ],
                },
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /unresolved variables:.*\$\{mode\}/);
        });

        test('캡처 모드 shell 의 stderr 는 정상 참조다', () => {
            // 런타임의 handleShell / handleCommand 는 { output, stderr } 를 낸다.
            // 시뮬레이션에 stderr 가 없으면 멀쩡한 참조를 미해결로 보고한다.
            const report = buildPreviewReport(actionWithForwardRef('stderr'), baseOptions());
            assert.doesNotMatch(report, /unresolved variables:.*\$\{producer\.stderr\}/);
        });

        test('단일 선택 quickPick 의 values 는 런타임에 없다', () => {
            const item: ActionItem = {
                id: 'a.qp1',
                title: 'single pick',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'pick', type: 'quickPick', items: ['a', 'b'] },
                        { id: 'use', type: 'shell', command: 'echo ${pick.values}', passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /unresolved variables:.*\$\{pick\.values\}/);
        });

        test('다중 선택 quickPick 의 values 는 정상 참조다', () => {
            const item: ActionItem = {
                id: 'a.qpN',
                title: 'multi pick',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'pick', type: 'quickPick', items: ['a', 'b'], canPickMany: true },
                        { id: 'use', type: 'shell', command: 'echo ${pick.values}', passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /unresolved variables:/);
        });

        test('문자열 output 이 없는 태스크의 capture 이름은 인정하지 않는다', () => {
            // 런타임은 결과에 문자열 output 이 있을 때만 capture 를 돌린다.
            const item: ActionItem = {
                id: 'a.dlgcap',
                title: 'dialog capture',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'pick', type: 'fileDialog', output: { capture: { name: 'ver', regex: 'v(\\d+)' } } },
                        { id: 'use', type: 'shell', command: 'echo ${pick.ver}', passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /unresolved variables:.*\$\{pick\.ver\}/);
        });

        /**
         * `??` 체인의 전방 참조. 관용 판정이 참조를 통째로 첫 `.` 으로 자르면
         * `${producer.output ?? other.output}` 의 키가 `"output ?? other.output"`
         * 이 되어 어떤 결과 키와도 맞지 않고, 멀쩡한 체인이 미해결로 보고됐다.
         */
        suite('?? 체인의 전방 참조', () => {
            function forwardChain(expr: string): ActionItem {
                return {
                    id: 'a.fwdcoalesce',
                    title: 'forward coalesce',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'consumer', type: 'shell', parallel: true, command: `use ${expr}`, passTheResultToNextTask: true },
                            { id: 'bA', type: 'shell', parallel: true, command: 'make a', passTheResultToNextTask: true },
                            { id: 'bB', type: 'shell', parallel: true, command: 'make b', passTheResultToNextTask: true }
                        ]
                    }
                } as ActionItem;
            }

            test('대안이 모두 실재하는 키면 관용한다', () => {
                const report = buildPreviewReport(forwardChain('${bA.output ?? bB.output}'), baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('앞 대안 하나만 풀려도 관용한다', () => {
                // 런타임은 먼저 풀리는 대안을 쓴다 — 리터럴로 남지 않으므로
                // "리터럴로 전달됩니다" 는 거짓이 된다.
                const report = buildPreviewReport(forwardChain('${bA.output ?? nosuch.value}'), baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('뒤 대안 하나만 풀려도 관용한다', () => {
                const report = buildPreviewReport(forwardChain('${nosuch.value ?? bB.output}'), baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('대안이 전부 어긋나면 보고한다', () => {
                const report = buildPreviewReport(forwardChain('${bA.nope ?? bB.alsoNope}'), baseOptions());
                assert.match(report, /unresolved variables:.*\$\{bA\.nope \?\? bB\.alsoNope\}/);
            });

            test('?? 체인은 대안 주위의 공백을 다듬는다', () => {
                // 사람이 손으로 쓰는 연산자라 `a.x ?? b.y` 처럼 띄어 쓰는 것이
                // 자연스럽다. 런타임(`splitCoalesceAlternatives`)도 다듬는다.
                const report = buildPreviewReport(forwardChain('${  bA.output   ??   bB.output  }'), baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('bare 대안도 output 이 있으면 관용한다', () => {
                const report = buildPreviewReport(forwardChain('${bA ?? bB.nope}'), baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('뒤쪽 대안이 전방이어도 앞쪽 대안의 오타는 잡는다', () => {
                // 전방 대안 하나가 멀쩡하다고 해서 오타가 덮이면 안 된다.
                // 다만 **미해결이 아니다** — 참조는 풀린다. 죽은 대안으로 알린다.
                const item: ActionItem = {
                    id: 'a.mixchain',
                    title: 'mixed chain',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'back', type: 'fileDialog', parallel: true },
                            { id: 'consumer', type: 'shell', parallel: true, command: 'use ${back.nope ?? fwd.output}', passTheResultToNextTask: true },
                            { id: 'fwd', type: 'shell', parallel: true, command: 'make', passTheResultToNextTask: true }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
                assert.match(report, /dead alternative\(s\).*'back\.nope'.*does not produce 'nope'/);
            });

            /**
             * 리포트가 **한 화면 안에서 자기모순**이던 자리.
             *
             * `args: ["<quickPick:pick:value>"]` 로 값이 풀린 것을 보여 주고는,
             * 두 줄 밑에서 같은 참조를 `unresolved variables:` 로 세고 요약에
             * "리터럴 ${...} 로 전달됩니다" 라고 적었다. 둘 다 사용자가 같은
             * 화면에서 본다.
             */
            test('풀리는 체인은 미해결로 세지 않는다 (요약까지)', () => {
                const item: ActionItem = {
                    id: 'a.deadalt',
                    title: 'dead alt',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'pick', type: 'quickPick', items: ['a'] },
                            { id: 'pick2', type: 'quickPick', items: ['b'] },
                            { id: 'run', type: 'command', command: 'node', args: ['${pick.value ?? pick2.nope}'] }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                // 값은 실제로 풀린다.
                assert.match(report, /<quickPick:pick:value>/);
                // 그러므로 미해결로 세면 안 되고, "리터럴로 전달" 문구도 안 된다.
                assert.doesNotMatch(report, /unresolved variables:/);
                assert.doesNotMatch(report, /unresolved variable\(s\) — fix before running/);
                assert.doesNotMatch(report, /passed through as literal/);
                // 대신 죽은 대안을 따로 알린다 — 요약에서도 별도 항목이다.
                assert.match(report, /dead alternative\(s\).*'pick2\.nope'/);
                assert.match(report, /Summary: 1 '\?\?' reference\(s\) resolve, but contain an alternative that is never used/);
                // "모두 해석됨" 으로 끝내서도 안 된다 — 결함이 있는 액션이다.
                assert.doesNotMatch(report, /all \$\{\.\.\.\} references resolve/);
            });

            test('미캡처 대안도 풀리는 체인에서는 리터럴이라 하지 않는다', () => {
                const item: ActionItem = {
                    id: 'a.deadcap',
                    title: 'dead capture',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'pick', type: 'quickPick', items: ['a'] },
                            { id: 'b', type: 'shell', command: 'echo b' },
                            { id: 'run', type: 'command', command: 'node', args: ['${pick.value ?? b.output}'] }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.doesNotMatch(report, /stays a literal at runtime/);
                assert.match(report, /dead alternative\(s\).*'b\.output'.*passTheResultToNextTask/);
            });

            /**
             * **판정기와 런타임을 직접 맞대 본다.**
             *
             * `analyzeCoalesceRefs` 는 "이 체인이 런타임에서 리터럴로 남는가" 를
             * 단언한다 — 그 단언이 틀리면 진단이 거짓말을 한다. 개별 케이스를
             * 아무리 늘려도 규칙이 갈리는 것 자체는 못 막으므로, 보간 함수의
             * 답과 표로 대조한다.
             */
            test('resolves 판정이 런타임 보간과 일치한다', () => {
                const fixture: Task[] = [
                    { id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true },
                    { id: 'raw', type: 'shell', command: 'make' },
                    { id: 'z', type: 'zip', source: 's', archive: 'a.zip' },
                    { id: 'uz', type: 'unzip', archive: 'a.zip', destination: 'd' },
                    { id: 'pick', type: 'fileDialog' },
                ] as Task[];
                const tasksById = new Map(fixture.map(t => [t.id, t]));
                const results: Record<string, any> = Object.create(null);
                for (const t of fixture) { results[t.id] = simulateTaskResultWithCaptures(t); }
                const ctx = Object.assign(Object.create(null), results, {
                    workspaceFolder: '/ws', extensionPath: '/ext',
                });
                const exprs = [
                    'build.output ?? pick.path',
                    'pick.nope ?? build.output',
                    'build.output ?? pick.nope',
                    // bare 대안이 체인을 **막는** 형태 — 뒤 대안은 시도되지 않는다.
                    'z ?? build.output',
                    'pick ?? build.output',
                    'raw ?? build.output',
                    // bare 여도 대표 결과가 있으면 풀린다.
                    'build ?? z',
                    'uz ?? build.output',
                    // 컨텍스트에 아예 없는 head 는 undefined 라 넘어간다.
                    'nosuch ?? build.output',
                    'nosuch.x ?? build.output',
                    // 내장 참조.
                    'workspaceFolder ?? build.output',
                    'workspaceFolder.x ?? build.output',
                    'z.nope ?? uz.nope',
                    'raw.output ?? build.output',
                ];
                for (const expr of exprs) {
                    const literal = '${' + expr + '}';
                    const consumer = { id: 'consumer', type: 'command', command: 'x', args: [literal] } as Task;
                    const [analyzed] = analyzeCoalesceRefs(consumer, results, tasksById, 'consumer');
                    assert.ok(analyzed, `체인으로 인식되지 않았다: ${literal}`);
                    assert.strictEqual(
                        analyzed.resolves,
                        interpolatePipelineVariables(literal, ctx) !== literal,
                        `런타임과 판정이 어긋났다: ${literal}`
                    );
                }
            });

            test('체인을 막는 bare 대안은 미해결로 보고한다', () => {
                // `${z ?? build.output}` — 런타임은 z 의 **결과 객체**를 받아
                // 거기서 멈추고, 객체는 문자열이 아니라 리터럴로 남는다.
                // build.output 은 시도조차 되지 않는다.
                const item: ActionItem = {
                    id: 'a.block',
                    title: 'blocking bare',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'z', type: 'zip', source: '${workspaceFolder}/s', archive: '${workspaceFolder}/a.zip' },
                            { id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true },
                            { id: 'run', type: 'command', command: 'node', args: ['${z ?? build.output}'] }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.match(report, /unresolved variables:.*\$\{z \?\? build\.output\}/);
                assert.match(report, /never tried/);
                assert.doesNotMatch(report, /reference\(s\) resolve, but contain/);
            });

            test('itemsFromCommand 가 있으면 items 안의 체인은 보지 않는다', () => {
                // 런타임이 목록을 덮어쓰므로 그 참조는 실행되지 않는다. 평범한
                // 참조는 이미 조용한데 체인만 경고가 붙으면 앞뒤가 안 맞는다.
                const item: ActionItem = {
                    id: 'a.ifc',
                    title: 'itemsFromCommand',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'pick', type: 'quickPick', itemsFromCommand: 'ls', items: ['${nosuch.a ?? nosuch2.b}'] },
                            { id: 'run', type: 'shell', command: 'echo ${pick.value}' }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
                assert.doesNotMatch(report, /dead alternative/);
            });

            test('내장 참조는 태스크가 아니라고 하지 않는다', () => {
                const item: ActionItem = {
                    id: 'a.builtin',
                    title: 'builtin',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'pick', type: 'quickPick', items: ['a'] },
                            { id: 'run', type: 'command', command: 'node', args: ['${pick.value ?? workspaceFolder}'] }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.doesNotMatch(report, /dead alternative/);
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('내장 참조에 속성을 붙이면 죽은 대안이다', () => {
                // `${workspaceFolder}` 는 문자열이다 — 속성을 붙이면 런타임에서
                // 어떤 값과도 맞지 않는다.
                const item: ActionItem = {
                    id: 'a.builtin2',
                    title: 'builtin key',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'pick', type: 'quickPick', items: ['a'] },
                            { id: 'run', type: 'command', command: 'node', args: ['${workspaceFolder.x ?? pick.value}'] }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.match(report, /dead alternative\(s\).*'workspaceFolder\.x'/);
            });

            test('이미 실행된 태스크의 bare 참조는 오탐하지 않는다', () => {
                // `visitTaskRefs` 가 bare 대안까지 넘기게 되면서 `findTypoRefs` 의
                // `key === undefined` 가드가 비로소 부하를 받는다. 빠지면
                // `${producer}` 가 뒤쪽 태스크에서 미해결로 잡힌다.
                const item: ActionItem = {
                    id: 'a.barebwd',
                    title: 'backward bare',
                    action: {
                        description: 'x',
                        tasks: [
                            { id: 'producer', type: 'shell', command: 'make', passTheResultToNextTask: true },
                            { id: 'use', type: 'shell', command: 'echo ${producer}', passTheResultToNextTask: true }
                        ]
                    }
                } as ActionItem;
                const report = buildPreviewReport(item, baseOptions());
                assert.doesNotMatch(report, /unresolved variables:/);
            });

            test('자기 자신은 체인 안에서도 관용하지 않는다', () => {
                // 런타임 컨텍스트에는 자기 자신이 없다. 대안 하나가 자기 참조면
                // 그 대안은 절대 풀리지 않는다.
                const report = buildPreviewReport(forwardChain('${consumer.output ?? bB.nope}'), baseOptions());
                assert.match(report, /unresolved variables:/);
            });
        });

        test('전방 dialog 태스크의 실제 키도 관용한다 (회귀 방지)', () => {
            const item: ActionItem = {
                id: 'a.fwddlg',
                title: 'forward dialog',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${pick.path} ${pick.dir}', passTheResultToNextTask: true },
                        { id: 'pick', type: 'fileDialog', parallel: true }
                    ]
                }
            } as ActionItem;
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /unresolved variables:/);
        });
    });

    /**
     * 조건부 태스크(0.7.4)는 Preview 에 한 줄도 남지 않았다 — 분기 파이프라인을
     * dry-run 해도 **분기 자체가 보이지 않았다.**
     */
    suite('when 은 리포트에 보인다', () => {
        const whenItem = (when: any, extra: any[] = []): ActionItem => ({
            id: 'a.when',
            title: 'when',
            action: {
                description: 'x',
                tasks: [...extra, { id: 'run', type: 'shell', command: 'echo hi', when }]
            }
        } as ActionItem);

        test('조건과 시뮬레이션 값을 보여 준다', () => {
            const report = buildPreviewReport(
                whenItem({ var: '${pick.value}', equals: 'release' }, [{ id: 'pick', type: 'quickPick', items: ['release'] }]),
                baseOptions()
            );
            assert.match(report, /when: \$\{pick\.value\} equals "release"/);
            assert.match(report, /simulated value: <quickPick:pick:value>/);
        });

        test('결과를 단정하지 않는다 (실행 시점의 입력에 달렸다)', () => {
            // 시뮬레이션 값은 자리표시자라 `equals` 와 맞지 않는다. 그것을 근거로
            // "건너뜁니다" 라고 하면 사용자 입력과 무관하게 거짓을 말하는 셈이다.
            const report = buildPreviewReport(
                whenItem({ var: '${pick.value}', equals: 'release' }, [{ id: 'pick', type: 'quickPick', items: ['release'] }]),
                baseOptions()
            );
            assert.doesNotMatch(report, /NEVER runs|ALWAYS runs/);
            assert.match(report, /depends on the input at runtime/);
        });

        test('굳은 분기는 어느 쪽으로 굳었는지 말한다', () => {
            const off = buildPreviewReport(whenItem({ var: '${ghost.output}', equals: 'a' }), baseOptions());
            assert.match(off, /NEVER runs/);
            const on = buildPreviewReport(whenItem({ var: '${ghost.output}', notEquals: 'a' }), baseOptions());
            assert.match(on, /ALWAYS runs/);
        });

        test('전방 참조를 굳었다고 하지 않는다', () => {
            const report = buildPreviewReport({
                id: 'a.whenfwd',
                title: 'when forward',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'run', type: 'shell', command: 'echo hi', parallel: true, when: { var: '${later.output}', equals: 'a' } },
                        { id: 'later', type: 'shell', command: 'make', parallel: true, passTheResultToNextTask: true }
                    ]
                }
            } as ActionItem, baseOptions());
            assert.doesNotMatch(report, /NEVER runs|ALWAYS runs/);
            assert.doesNotMatch(report, /unresolved variables:/);
            assert.match(report, /scheduler runs first/);
        });

        test('연산자가 없으면 그대로 적는다', () => {
            const report = buildPreviewReport(whenItem({ var: '${workspaceFolder}' }), baseOptions());
            assert.match(report, /no operator — the task always runs/);
        });

        test('정적으로 정해지는 조건은 결과를 말한다', () => {
            // 예전에는 이 셋 모두 "the real branch depends on the input" 이라고
            // 적었는데, 셋 다 입력과 무관하게 결과가 정해져 있다.
            const emptyIn = buildPreviewReport(whenItem({ var: '${workspaceFolder}', in: [] }), baseOptions());
            assert.match(emptyIn, /empty list.*NEVER runs/);
            const badRegex = buildPreviewReport(whenItem({ var: '${workspaceFolder}', matches: '(' }), baseOptions());
            assert.match(badRegex, /not a valid regular expression.*NEVER runs/);
            const constant = buildPreviewReport(whenItem({ var: 'release', equals: 'debug' }), baseOptions());
            assert.match(constant, /constant "release".*NEVER runs/);
            for (const report of [emptyIn, badRegex, constant]) {
                assert.doesNotMatch(report, /depends on the input at runtime/);
                // 참조는 멀쩡히 풀리므로 미해결 집계에는 아무것도 안 들어간다 —
                // 요약에 따로 남기지 않으면 "모두 해석됨" 으로 끝난다. 돌지 않는
                // 태스크를 품은 액션인데도.
                assert.doesNotMatch(report, /all \$\{\.\.\.\} references resolve/);
                assert.match(report, /Summary: 1 task\(s\) have a 'when' whose outcome never changes/);
            }
        });

        test('항상 실행되는 쪽도 말한다', () => {
            const report = buildPreviewReport(whenItem({ var: 'release', equals: 'release' }), baseOptions());
            assert.match(report, /ALWAYS runs \(the condition does nothing\)/);
            assert.match(report, /Summary: 1 task\(s\) have a 'when' whose outcome never changes/);
        });

        test('무시당하는 연산자를 보고 단정하지 않는다', () => {
            // 런타임은 `equals` 를 적용한다 — 빈 `in` 은 쳐다보지도 않는다.
            const report = buildPreviewReport(
                whenItem({ var: '${workspaceFolder}', equals: 'a', in: [] }),
                baseOptions()
            );
            assert.doesNotMatch(report, /NEVER runs|ALWAYS runs/);
            assert.match(report, /when: .* equals "a"/);
        });

        test('matches 와 in 도 읽을 수 있게 적는다', () => {
            const m = buildPreviewReport(whenItem({ var: '${workspaceFolder}', matches: '^v[0-9]+$' }), baseOptions());
            assert.match(m, /matches \/\^v\[0-9\]\+\$\//);
            const i = buildPreviewReport(whenItem({ var: '${workspaceFolder}', in: ['a', 'b'] }), baseOptions());
            assert.match(i, /in \["a", "b"\]/);
        });

        test('연산자가 여럿이면 런타임이 실제로 쓰는 것을 보여 준다', () => {
            // `evaluateTaskCondition` 은 정해진 순서로 **첫 번째만** 적용한다.
            // 리포트가 다른 것을 보여 주면, 사용자는 적용되지도 않는 조건을 놓고
            // 디버깅하게 된다 (연산자가 여럿인 것 자체는 when.operators 가 잡는다).
            const report = buildPreviewReport(
                whenItem({ var: '${workspaceFolder}', equals: 'a', notEquals: 'b' }),
                baseOptions()
            );
            assert.match(report, /when: .* equals "a"/);
            assert.doesNotMatch(report, /!= "b"/);
        });

        test('굳은 분기는 요약에서도 미해결로 센다', () => {
            // 인라인 ⚠️ 만 남기고 요약에서 빠지면, 요약만 읽는 사용자에게
            // "모두 해석됨" 으로 보인다 — 분기가 죽은 액션인데도.
            const report = buildPreviewReport(whenItem({ var: '${ghost.output}', equals: 'a' }), baseOptions());
            assert.match(report, /Summary: 1 unresolved variable\(s\)/);
            assert.match(report, /\$\{ghost\.output\}/);
            assert.doesNotMatch(report, /all \$\{\.\.\.\} references resolve/);
        });

        test('체인을 막는 전방 대안은 선언 순서와 무관하게 굳었다고 말한다', () => {
            const tasks = (order: 'forward' | 'backward') => {
                const z = { id: 'z', type: 'zip', source: 's', archive: 'o.zip', parallel: true };
                const pick = { id: 'pick', type: 'quickPick', items: ['a'], parallel: true };
                const run = {
                    id: 'run', type: 'shell', command: 'echo hi', parallel: true,
                    when: { var: '${z ?? pick.value}', equals: 'a' }
                };
                return order === 'forward' ? [run, pick, z] : [z, pick, run];
            };
            for (const order of ['forward', 'backward'] as const) {
                const report = buildPreviewReport({
                    id: 'a.whenchain', title: 'when chain',
                    action: { description: 'x', tasks: tasks(order) }
                } as ActionItem, baseOptions());
                assert.match(report, /NEVER runs/, order);
                // 같은 참조를 두고 "스케줄러가 먼저 돌린다" 와 "미해결" 을 함께
                // 말하면 한 화면 안에서 자기모순이다.
                assert.doesNotMatch(report, /scheduler runs first/, order);
            }
        });
    });

    suite('uncaptured output refs (M9 회귀 가드)', () => {
        // 런타임은 shell/command에서 passTheResultToNextTask가 falsy면 빈
        // 결과를 넘기므로 `${id.output}`이 리터럴로 셸에 들어간다. 이전
        // 시뮬레이션은 무조건 output을 만들어 이 실수를 검출하지 못했다.

        test('flags ${A.output} when A does not pass its result', () => {
            const item: ActionItem = {
                id: 'a.m9',
                title: 'uncaptured',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'build', type: 'shell', command: 'make all' },
                        { id: 'deploy', type: 'shell', command: 'deploy ${build.output}', passTheResultToNextTask: true }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /\$\{build\.output\}.*'build' does not set 'passTheResultToNextTask'/);
            assert.match(report, /fix before running/);
        });

        test('키에 공백이 섞이면 미캡처가 아니라 미해결로 본다', () => {
            // 런타임은 키를 다듬지 않으므로 `${build. output}` 의 키는 `" output"`
            // 이고, 그 태스크가 결과를 넘겼든 아니든 어떤 키와도 맞지 않는다.
            // 여기서 다듬어 `output` 으로 읽으면 "패스 설정을 켜라" 는 엉뚱한
            // 처방을 내놓는다 — 켜도 해결되지 않는다.
            const item: ActionItem = {
                id: 'a.m9ws',
                title: 'uncaptured whitespace',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'build', type: 'shell', command: 'make all' },
                        { id: 'deploy', type: 'shell', command: 'deploy ${build. output}', passTheResultToNextTask: true }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /does not set 'passTheResultToNextTask'/);
            assert.match(report, /unresolved variables:.*\$\{build\. output\}/);
        });

        test('flags forward reference to an uncaptured task', () => {
            const item: ActionItem = {
                id: 'a.m9fwd',
                title: 'forward uncaptured',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'use', type: 'shell', command: 'echo ${later.output}', passTheResultToNextTask: true },
                        { id: 'later', type: 'shell', command: 'make' }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /\$\{later\.output\}.*'later' does not set 'passTheResultToNextTask'/);
        });

        test('does not flag when the producer passes its result', () => {
            const item: ActionItem = {
                id: 'a.m9ok',
                title: 'captured',
                action: {
                    description: 'x',
                    tasks: [
                        { id: 'build', type: 'shell', command: 'make all', passTheResultToNextTask: true },
                        { id: 'deploy', type: 'shell', command: 'deploy ${build.output}', passTheResultToNextTask: true }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.doesNotMatch(report, /does not set 'passTheResultToNextTask'/);
            assert.doesNotMatch(report, /unresolved variables/);
        });

        test('capture-name refs of an uncaptured task are flagged too', () => {
            const item: ActionItem = {
                id: 'a.m9cap',
                title: 'capture skipped',
                action: {
                    description: 'x',
                    tasks: [
                        {
                            id: 'build', type: 'shell', command: 'make all',
                            output: { capture: { name: 'ver', regex: 'v(\\d+)' } }
                        },
                        { id: 'tag', type: 'shell', command: 'git tag ${build.ver}', passTheResultToNextTask: true }
                    ]
                }
            };
            const report = buildPreviewReport(item, baseOptions());
            assert.match(report, /\$\{build\.ver\}.*'build' does not set 'passTheResultToNextTask'/);
        });
    });
});
