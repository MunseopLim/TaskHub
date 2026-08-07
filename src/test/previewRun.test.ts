import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildPreviewReport,
    findTypoRefs,
    findUncapturedOutputRefs,
    analyzeCoalesceRefs,
    simulateTaskResultWithCaptures,
} from '../previewRun';
import { interpolatePipelineVariables } from '../pipelineUtils';
import type { ActionItem, Task } from '../schema';

const WS = path.resolve(os.tmpdir(), 'taskhub-preview-ws');

function baseOptions() {
    return {
        workspaceFolder: WS,
        extensionPath: '/ext',
        workspaceRoots: [WS],
    };
}

suite('buildPreviewReport', () => {
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
        assert.match(report, /items will be populated from this command/);
        // The static items(N) listing must not appear for a dynamic source.
        assert.doesNotMatch(report, /items \(\d+\):/);
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
        assert.match(report, /passTheResultToNextTask' is false/);
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

        test('bare 전방 참조도 output / outputDir 이 있을 때만 관용한다', () => {
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
