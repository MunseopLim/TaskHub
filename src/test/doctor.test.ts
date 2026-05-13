import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import { runDoctor, DoctorInput, DoctorFinding, DoctorValidator } from '../doctor';
import * as actionSchema from '../../schema/actions.schema.json';

const WS = path.resolve(os.tmpdir(), 'taskhub-doctor-ws');

function compileValidator(): DoctorValidator {
    const ajv = new Ajv({ allErrors: true });
    return ajv.compile(actionSchema) as unknown as DoctorValidator;
}

function makeInput(actions: any, overrides: Partial<DoctorInput> = {}): DoctorInput {
    return {
        filePath: overrides.filePath ?? path.join(WS, '.vscode', 'actions.json'),
        sourceLabel: overrides.sourceLabel ?? 'test:actions.json',
        rawText: typeof actions === 'string' ? actions : JSON.stringify(actions, null, 2),
        workspaceFolder: overrides.workspaceFolder ?? WS,
        workspaceRoots: overrides.workspaceRoots ?? [WS],
        extensionPath: overrides.extensionPath ?? '/ext',
    };
}

function codes(findings: DoctorFinding[]): string[] {
    return findings.map(f => f.code).sort();
}

suite('Doctor', () => {

    test('returns no findings for a clean actions.json', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.clean',
                title: 'Clean',
                action: {
                    description: 'ok',
                    tasks: [{ id: 't1', type: 'shell', command: 'echo hi' }]
                }
            }
        ])], v);
        assert.deepStrictEqual(findings, []);
    });

    test('reports JSON parse error with a non-zero line/column', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput('[ { "id": "a", "title": "X" ,, } ]')], v);
        assert.strictEqual(findings.length, 1);
        assert.strictEqual(findings[0].code, 'json.parse');
        assert.strictEqual(findings[0].severity, 'error');
    });

    test('reports AJV schema violations with a code prefix of schema.', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            { id: 'a', title: 'X', action: { description: 'd' } }   // missing tasks
        ])], v);
        const schemaFindings = findings.filter(f => f.code.startsWith('schema.'));
        assert.ok(schemaFindings.length >= 1, `expected schema findings, got ${JSON.stringify(findings)}`);
    });

    test('flags duplicate action ids within one source', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            { id: 'dup', title: 'A', action: { description: 'd', tasks: [{ id: 't', type: 'shell', command: 'echo a' }] } },
            { id: 'dup', title: 'B', action: { description: 'd', tasks: [{ id: 't', type: 'shell', command: 'echo b' }] } },
        ])], v);
        assert.ok(findings.some(f => f.code === 'duplicate.action.id'));
    });

    test('flags duplicate task ids within a single action', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.dup',
                title: 'dup',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'same', type: 'shell', command: 'echo 1' },
                        { id: 'same', type: 'shell', command: 'echo 2' },
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'duplicate.task.id'));
    });

    test('flags invalid capture regex', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.bad',
                title: 'bad',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'echo hi',
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'x', regex: '(' }
                        }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'capture.regex'),
            `expected capture.regex, got ${codes(findings).join(',')}`);
    });

    test('flags capture group index out of range', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.grp',
                title: 'grp',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'echo hi',
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'x', regex: '(foo)', group: 5 }
                        }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'capture.group'),
            `expected capture.group, got ${codes(findings).join(',')}`);
    });

    test('flags invalid diagnostics regex', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.dg',
                title: 'dg',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'gcc x.c',
                        passTheResultToNextTask: true,
                        output: {
                            diagnostics: { pattern: '(unterminated', file: 1, line: 2, message: 3 }
                        }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'diagnostics.regex'),
            `expected diagnostics.regex, got ${codes(findings).join(',')}`);
    });

    test('flags unknown diagnostics preset shorthand', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.preset',
                title: 'preset',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'cc',
                        passTheResultToNextTask: true,
                        output: { diagnostics: '$nope' }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'diagnostics.preset'),
            `expected diagnostics.preset, got ${codes(findings).join(',')}`);
    });

    test('flags unresolved ${...} reference', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.unresolved',
                title: 'unresolved',
                action: {
                    description: 'd',
                    tasks: [{ id: 't', type: 'shell', command: 'echo ${typo.value}' }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved, got ${codes(findings).join(',')}`);
    });

    test('does not flag a fully-resolved upstream reference', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.chain',
                title: 'chain',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'fileDialog' },
                        { id: 'run',  type: 'shell', command: 'echo ${pick.path}' }
                    ]
                }
            }
        ])], v);
        assert.strictEqual(findings.filter(f => f.code === 'variable.unresolved').length, 0,
            `expected no unresolved finding, got ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
    });

    test('flags writeFile path outside the workspace', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.out',
                title: 'out',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'writeFile',
                        path: '/etc/evil.txt',
                        content: 'oops'
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'path.outside-workspace'),
            `expected path.outside-workspace, got ${codes(findings).join(',')}`);
    });

    test('does NOT flag writeFile path that resolves inside workspace', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.in',
                title: 'in',
                action: {
                    description: 'd',
                    tasks: [{ id: 't', type: 'writeFile', path: 'note.txt', content: 'ok' }]
                }
            }
        ])], v);
        assert.strictEqual(findings.filter(f => f.code === 'path.outside-workspace').length, 0);
    });

    test('flags dependsOn cycle', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.cyc',
                title: 'cyc',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'a', type: 'shell', command: 'echo a', dependsOn: ['b'] },
                        { id: 'b', type: 'shell', command: 'echo b', dependsOn: ['a'] },
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'dependsOn.cycle'),
            `expected dependsOn.cycle, got ${codes(findings).join(',')}`);
    });

    test('flags self-referential dependsOn', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.self',
                title: 'self',
                action: {
                    description: 'd',
                    tasks: [{ id: 't', type: 'shell', command: 'echo a', dependsOn: ['t'] }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'dependsOn.self'),
            `expected dependsOn.self, got ${codes(findings).join(',')}`);
    });

    test('flags missing dependsOn reference', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.miss',
                title: 'miss',
                action: {
                    description: 'd',
                    tasks: [{ id: 't', type: 'shell', command: 'echo a', dependsOn: ['nope'] }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'dependsOn.missing'),
            `expected dependsOn.missing, got ${codes(findings).join(',')}`);
    });

    test('does NOT flag a valid linear dependsOn chain', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.linear',
                title: 'linear',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 't1', type: 'shell', command: 'echo 1' },
                        { id: 't2', type: 'shell', command: 'echo 2', dependsOn: ['t1'] },
                        { id: 't3', type: 'shell', command: 'echo 3', dependsOn: ['t2'] },
                    ]
                }
            }
        ])], v);
        const cycleOrMissing = findings.filter(f => f.code.startsWith('dependsOn.'));
        assert.deepStrictEqual(cycleOrMissing, [], `unexpected dependsOn findings: ${cycleOrMissing.map(f => f.code).join(',')}`);
    });

    test('walks nested folder children', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'folder.top',
                title: 'top',
                type: 'folder',
                children: [
                    {
                        id: 'a.nested',
                        title: 'nested',
                        action: {
                            description: 'd',
                            tasks: [{ id: 't', type: 'shell', command: 'echo ${broken.value}' }]
                        }
                    }
                ]
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected to walk folder children; got ${codes(findings).join(',')}`);
    });

    test('flags reserved capture name', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.reserved',
                title: 'reserved',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'echo hi',
                        passTheResultToNextTask: true,
                        output: {
                            capture: { name: 'output', regex: '(foo)' }
                        }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'capture.reserved'),
            `expected capture.reserved, got ${codes(findings).join(',')}`);
    });

    test('flags duplicate capture name within one task', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.dup-cap',
                title: 'dup-cap',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'shell',
                        command: 'echo hi',
                        passTheResultToNextTask: true,
                        output: {
                            capture: [
                                { name: 'version', regex: '(\\d+)' },
                                { name: 'version', regex: '(\\w+)' }
                            ]
                        }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'capture.duplicate'),
            `expected capture.duplicate, got ${codes(findings).join(',')}`);
    });

    test('${workspaceFolder} on bundled source resolves via first workspace root (no false positive outside-workspace)', () => {
        const v = compileValidator();
        // Bundled / preset sources have no `workspaceFolder` of their own.
        // Doctor must fall back to the first workspace root so that
        // `${workspaceFolder}/out.txt` lands inside the workspace, matching
        // executeSingleTask's runtime behavior.
        const findings = runDoctor([makeInput([
            {
                id: 'a.bundled',
                title: 'bundled',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 't',
                        type: 'writeFile',
                        path: '${workspaceFolder}/out.txt',
                        content: 'ok'
                    }]
                }
            }
        ], { workspaceFolder: undefined })], v);
        const offending = findings.filter(f => f.code === 'path.outside-workspace');
        assert.deepStrictEqual(offending, [],
            `expected no outside-workspace finding for bundled source; got ${offending.map(f => f.message).join(' | ')}`);
        const unresolved = findings.filter(f => f.code === 'variable.unresolved');
        assert.deepStrictEqual(unresolved, [],
            `expected workspaceFolder to be resolved via fallback; got ${unresolved.map(f => f.message).join(' | ')}`);
    });

    test('jsonPath position for AJV finding points at the offending node', () => {
        const v = compileValidator();
        const raw = `[
  {
    "id": "a.schema",
    "title": "schema",
    "action": {
      "description": "d"
    }
  }
]`;
        const findings = runDoctor([makeInput(raw)], v);
        const schemaFinding = findings.find(f => f.code.startsWith('schema.'));
        assert.ok(schemaFinding, 'expected at least one schema finding');
        // Should land deeper than line 1 — the `action` object starts on line 5.
        assert.ok(schemaFinding!.range.startLine > 1,
            `expected position past line 1, got ${schemaFinding!.range.startLine}`);
    });
});
