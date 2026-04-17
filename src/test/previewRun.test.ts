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
});
