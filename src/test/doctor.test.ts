import * as assert from 'assert';
import * as fs from 'fs';
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

    /**
     * `shell` 은 명령 문자열을 셸에 그대로 넘긴다(0.6.47). 그래서 보간된 값도
     * 셸 문법으로 해석되어, 값에 `;` 나 `$(...)` 가 있으면 뒤의 명령이 실행된다.
     * 0.6.47 은 이 위험을 문서로만 알렸다 — Doctor 가 사용자 액션에서 잡는다.
     */
    suite('shell.interpolated-command', () => {
        const shellTask = (task: any) => [{
            id: 'a', title: 'X', action: { description: 'd', tasks: [task] }
        }];

        test('shell 태스크의 command 보간을 경고한다', () => {
            const findings = runDoctor([makeInput(shellTask(
                { id: 'run', type: 'shell', command: 'echo ${ask.value}' }
            ))], compileValidator());
            assert.ok(
                findings.some(f => f.code === 'shell.interpolated-command'),
                `주입 통로를 놓쳤다: ${JSON.stringify(findings.map(f => f.code))}`
            );
        });

        test('OS별 객체는 한 branch에만 있어도 잡는다', () => {
            const findings = runDoctor([makeInput(shellTask({
                id: 'run',
                type: 'shell',
                command: { windows: 'echo hi', macos: 'printenv ${ask.value}', linux: 'echo hi' },
            }))], compileValidator());
            assert.ok(findings.some(f => f.code === 'shell.interpolated-command'));
        });

        test('command 타입은 경고하지 않는다 (argv 라 인용된다)', () => {
            // 여기서 경고하면 우리가 권하는 안전한 형태에 경고가 붙어,
            // 사용자가 룰 자체를 무시하게 된다.
            const findings = runDoctor([makeInput(shellTask(
                { id: 'run', type: 'command', command: 'printenv ${ask.value}' }
            ))], compileValidator());
            assert.ok(!findings.some(f => f.code === 'shell.interpolated-command'));
        });

        test('보간이 없는 shell 은 경고하지 않는다', () => {
            const findings = runDoctor([makeInput(shellTask(
                { id: 'run', type: 'shell', command: 'make clean && make' }
            ))], compileValidator());
            assert.ok(!findings.some(f => f.code === 'shell.interpolated-command'));
        });
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

    test('flags unresolved ${...} inside quickPick itemsFromCommand', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.ifc',
                title: 'ifc',
                action: {
                    description: 'd',
                    tasks: [{ id: 'branch', type: 'quickPick', itemsFromCommand: 'list ${typo.value}' }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved from itemsFromCommand, got ${codes(findings).join(',')}`);
    });

    test('does not flag stale ${...} in quickPick `items` when itemsFromCommand is set', () => {
        // Runtime ignores `items` once itemsFromCommand populates the list, so
        // a leftover ${typo.value} in `items` must not raise variable.unresolved.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.ifc-stale',
                title: 'ifc-stale',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'branch',
                        type: 'quickPick',
                        items: ['${typo.value}'],
                        itemsFromCommand: 'git for-each-ref'
                    }]
                }
            }
        ])], v);
        assert.strictEqual(findings.filter(f => f.code === 'variable.unresolved').length, 0,
            `expected no unresolved finding, got ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
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

    test('does not flag a forward reference to a later task in the same action', () => {
        // The runtime's auto-inferred dep flips B → A at execution time, so
        // Doctor must not emit a `variable.unresolved` for the legitimate
        // `${B.output}` reference even though Doctor itself walks tasks in
        // declaration order. Both tasks must be `parallel: true`; with B
        // sequential, B.barrierDeps={A} pairs with A.inferredDeps={B} into
        // a real cycle that `dependsOn.cycle` would (correctly) flag.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.fwdref',
                title: 'forward ref',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'A', type: 'shell', command: 'echo ${B.output}', parallel: true },
                        { id: 'B', type: 'shell', command: 'make build', parallel: true }
                    ]
                }
            }
        ])], v);
        const unresolved = findings.filter(f => f.code === 'variable.unresolved');
        assert.deepStrictEqual(unresolved, [],
            `forward task ref should not raise unresolved; got ${unresolved.map(f => f.message).join(' | ')}`);
        const cycles = findings.filter(f => f.code === 'dependsOn.cycle');
        assert.deepStrictEqual(cycles, [],
            `valid forward-ref DAG must not raise dependsOn.cycle; got ${cycles.map(f => f.message).join(' | ')}`);
    });

    test('flags ${past.typoKey} on a task type whose simulated result lacks output/outputDir fallback', () => {
        // For task types like fileDialog (no `output` / `outputDir` keys
        // in the simulated result), `${past.typoKey}` survives
        // interpolation. Pre-fix Doctor's `findUnresolved` was given the
        // full set of action task ids as `toleratedHeads` so the typo's
        // head matched and was suppressed. Post-fix toleration covers
        // only forward (not-yet-simulated) task ids, so past-task typos
        // surface as `variable.unresolved`.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.past-typo',
                title: 'past typo',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'fileDialog' },
                        { id: 'use', type: 'shell', command: 'echo ${pick.typoKey}' }
                    ]
                }
            }
        ])], v);
        const unresolved = findings.filter(f => f.code === 'variable.unresolved');
        assert.ok(unresolved.length > 0,
            `expected variable.unresolved for past-task typo, got ${codes(findings).join(',')}`);
        assert.ok(unresolved.some(f => /\$\{pick\.typoKey\}/.test(f.message)),
            `expected the typoed reference in the message; got ${unresolved.map(f => f.message).join(' | ')}`);
    });

    test('flags ${past.typoKey} even when interpolation falls back to output', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.output-fallback-typo',
                title: 'output fallback typo',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'build', type: 'shell', command: 'make' },
                        { id: 'use', type: 'shell', command: 'echo ${build.typoKey}' }
                    ]
                }
            }
        ])], v);
        const unresolved = findings.filter(f => f.code === 'variable.unresolved');
        assert.ok(unresolved.some(f => /\$\{build\.typoKey\}/.test(f.message)),
            `expected the typoed shell output reference in the message; got ${unresolved.map(f => f.message).join(' | ')}`);
    });

    test('still flags unresolved when the head is not a sibling task id', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.unknownhead',
                title: 'unknown head',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'A', type: 'shell', command: 'echo ${notATask.value}' },
                        { id: 'B', type: 'shell', command: 'make build' }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved for unknown head, got ${codes(findings).join(',')}`);
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

    test('flags parallel: true on an interactive task (parallel.interactive)', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.interactive-par',
                title: 'par',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'ask', type: 'inputBox', prompt: 'name?', parallel: true },
                        { id: 'echo', type: 'shell', command: 'echo ${ask.value}' }
                    ]
                }
            }
        ])], v);
        const hit = findings.find(f => f.code === 'parallel.interactive');
        assert.ok(hit, `expected parallel.interactive, got ${codes(findings).join(',')}`);
        assert.strictEqual(hit!.severity, 'warning');
    });

    test('flags dependsOn cycle introduced solely by ${taskId.x} auto-inference', () => {
        // No explicit dependsOn — the cycle exists only because A and B
        // each reference the other's output. Pre-refactor Doctor missed
        // this; the runtime would still reject via validateTaskGraph, so
        // Doctor must agree.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.inferred-cycle',
                title: 'inferred',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'A', type: 'shell', command: 'echo ${B.output}', parallel: true },
                        { id: 'B', type: 'shell', command: 'echo ${A.output}', parallel: true }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'dependsOn.cycle'),
            `expected dependsOn.cycle from inferred deps, got ${codes(findings).join(',')}`);
    });

    test('does NOT flag parallel: true on shell tasks', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.shell-par',
                title: 'par',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'a', type: 'shell', command: 'echo a' },
                        { id: 'b', type: 'shell', command: 'echo b', parallel: true }
                    ]
                }
            }
        ])], v);
        assert.ok(!findings.some(f => f.code === 'parallel.interactive'),
            `expected no parallel.interactive on shell tasks, got ${codes(findings).join(',')}`);
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

    suite('path.outside-workspace symlink escape (M10 후속)', () => {
        test('writeFile through an outward symlink raises path.outside-workspace', function () {
            // 런타임 resolveWithinWorkspace는 realpath 정규화로 거부하는 경로를
            // Doctor가 어휘적 비교로 통과시키던 거짓 음성 회귀 가드.
            if (process.platform === 'win32') { this.skip(); }
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-doctor-m10-'));
            try {
                const root = path.join(base, 'ws');
                const outside = path.join(base, 'outside');
                fs.mkdirSync(root, { recursive: true });
                fs.mkdirSync(outside, { recursive: true });
                fs.symlinkSync(outside, path.join(root, 'escape'));

                const v = compileValidator();
                const findings = runDoctor([makeInput([
                    {
                        id: 'a.m10',
                        title: 'X',
                        action: {
                            description: 'd',
                            tasks: [
                                { id: 'w', type: 'writeFile', path: 'escape/x.txt', content: 'hi' }
                            ]
                        }
                    }
                ], { workspaceFolder: root, workspaceRoots: [root] })], v);
                assert.ok(
                    codes(findings).includes('path.outside-workspace'),
                    `expected path.outside-workspace, got: ${codes(findings).join(', ')}`
                );
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        });
    });

    suite('output.not-captured / output.ignored (M9)', () => {
        // 런타임은 shell/command에서 passTheResultToNextTask가 falsy면 빈
        // 결과를 넘긴다(출력 스트리밍·capture 생략). 이전 시뮬레이션은
        // 무조건 output을 만들어 가장 흔한 설정 실수를 검출하지 못했다.

        test('flags ${A.output} when A does not pass its result (dedicated code, no duplicate unresolved)', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.m9',
                    title: 'X',
                    action: {
                        description: 'd',
                        tasks: [
                            { id: 'build', type: 'shell', command: 'make all' },
                            { id: 'deploy', type: 'shell', command: 'deploy ${build.output}', passTheResultToNextTask: true }
                        ]
                    }
                }
            ])], v);
            const targeted = findings.filter(f => f.code === 'output.not-captured');
            assert.strictEqual(targeted.length, 1);
            assert.strictEqual(targeted[0].severity, 'warning');
            assert.ok(targeted[0].message.includes("'build'"));
            assert.ok(targeted[0].messageKo?.includes('passTheResultToNextTask'));
            // 전용 경고로 대체 — 같은 참조를 variable.unresolved 로 중복 보고하지 않는다
            assert.ok(!codes(findings).includes('variable.unresolved'));
        });

        test('flags forward reference to an uncaptured task', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.m9fwd',
                    title: 'X',
                    action: {
                        description: 'd',
                        tasks: [
                            { id: 'use', type: 'shell', command: 'echo ${later.output}', passTheResultToNextTask: true },
                            { id: 'later', type: 'shell', command: 'make' }
                        ]
                    }
                }
            ])], v);
            assert.ok(codes(findings).includes('output.not-captured'),
                `expected output.not-captured, got: ${codes(findings).join(', ')}`);
        });

        test('does not flag when the producer passes its result', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.m9ok',
                    title: 'X',
                    action: {
                        description: 'd',
                        tasks: [
                            { id: 'build', type: 'shell', command: 'make all', passTheResultToNextTask: true },
                            { id: 'deploy', type: 'shell', command: 'deploy ${build.output}', passTheResultToNextTask: true }
                        ]
                    }
                }
            ])], v);
            // 이 suite 가 보는 것은 M9(출력 전달) 계열뿐이다. 같은 fixture 는
            // `shell` 에 `${build.output}` 을 보간하므로 주입 룰에는 정당하게
            // 걸린다 — "아무 finding 도 없다" 로 고정하면 새 룰이 추가될 때마다
            // 이 테스트가 무관하게 깨지고, 룰을 약화시키는 압력이 된다.
            assert.deepStrictEqual(
                findings.filter(f => f.code.startsWith('output.')), []
            );
        });

        test('warns when output mode/capture/diagnostics are dead without passTheResultToNextTask', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.m9dead',
                    title: 'X',
                    action: {
                        description: 'd',
                        tasks: [
                            {
                                id: 'build', type: 'shell', command: 'make all',
                                output: { mode: 'editor', capture: { name: 'ver', regex: 'v(\\d+)' } }
                            }
                        ]
                    }
                }
            ])], v);
            const ignored = findings.filter(f => f.code === 'output.ignored');
            assert.strictEqual(ignored.length, 1);
            assert.ok(ignored[0].message.includes("mode: 'editor'"));
            assert.ok(ignored[0].message.includes('capture'));
        });

        test('capture-name refs of an uncaptured task are flagged', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.m9cap',
                    title: 'X',
                    action: {
                        description: 'd',
                        tasks: [
                            {
                                id: 'build', type: 'shell', command: 'make all',
                                output: { capture: { name: 'ver', regex: 'v(\\d+)' } }
                            },
                            { id: 'tag', type: 'shell', command: 'git tag ${build.ver}', passTheResultToNextTask: true }
                        ]
                    }
                }
            ])], v);
            const found = codes(findings);
            assert.ok(found.includes('output.not-captured'), `expected output.not-captured, got: ${found.join(', ')}`);
            assert.ok(found.includes('output.ignored'), `expected output.ignored, got: ${found.join(', ')}`);
        });
    });
});
