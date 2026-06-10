import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { buildPreviewReport } from '../previewRun';
import type { ActionItem } from '../schema';

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
