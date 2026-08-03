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

    /**
     * `command` 로 바꾸면 셸이 사라지지만, 명령 **자체가** 인터프리터면 그것이
     * 문자열을 다시 파싱한다 — 번들 예제의 `cmd /c echo %${…}%` 가 그 형태였다.
     */
    suite('command.nested-interpreter', () => {
        const withTasks = (tasks: any[]) => [{
            id: 'a', title: 'X', action: { description: 'd', tasks }
        }];
        const codes = (items: any) => runDoctor([makeInput(items)], compileValidator()).map(f => f.code);

        test('제약 없는 입력이 cmd /c 로 흘러가면 경고한다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'name?' },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
        });

        test('sh -c / powershell -Command 도 같이 잡는다', () => {
            for (const command of ['sh -c "echo ${ask.value}"', 'powershell -Command "echo ${ask.value}"']) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'name?' },
                        { id: 'run', type: 'command', command },
                    ])).includes('command.nested-interpreter'),
                    `놓쳤다: ${command}`
                );
            }
        });

        test('validatePattern 으로 제약된 입력은 경고하지 않는다', () => {
            // 이 면제가 없으면 올바른 완화책을 쓴 액션에도 경고가 붙어
            // 사용자가 룰 자체를 무시하게 된다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'name?', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
        });

        test('메타문자 없는 고정 items 를 가진 quickPick 은 면제한다', () => {
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'quickPick', items: ['dev', 'prod'] },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
        });

        test('items 에 메타문자가 있으면 고정 목록이라도 면제하지 않는다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'quickPick', items: ['ok', 'a;b'] },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
        });

        /**
         * **`envPick` 은 면제하지 않는다.** 처음에는 "셸이 실제로 노출하는 이름만
         * 나온다" 는 이유로 면제했는데, 이름이 안전해도 `cmd` 는 `%VAR%` 를
         * 치환한 **뒤** 그 결과를 다시 해석하므로 값에 `&` 가 있으면 뚫린다 —
         * 우리가 같은 이유로 번들 액션을 고쳐 놓고 Doctor 는 반대로 판정하고
         * 있었다. 그때 이 테스트가 그 false negative 를 **정상 계약으로 고정**해
         * 모순을 덮고 있었다.
         */
        test('envPick 은 면제하지 않는다 (값이 다시 해석된다)', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'envPick' },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
        });

        test('검증 뒤에 붙는 prefix/suffix 의 메타문자도 본다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'n?', validatePattern: '^[A-Za-z]+$', suffix: '; rm -rf x' },
                { id: 'run', type: 'command', command: 'sh -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'));
        });

        test('args 안의 스크립트도 검사한다 (가장 흔한 형태)', () => {
            // `command` 문자열만 보던 처음 구현이 통째로 놓치던 형태다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'n?' },
                { id: 'run', type: 'command', command: 'sh', args: ['-c', 'printf ${ask.value}'] },
            ])).includes('command.nested-interpreter'));
        });

        test('인용된 실행 파일과 스위치 앞 플래그도 위치로 처리한다', () => {
            for (const task of [
                { id: 'run', type: 'command', command: '"pwsh.exe" -Command "echo ${ask.value}"' },
                { id: 'run', type: 'command', command: 'cmd /v:on /c echo %${ask.value}%' },
                { id: 'run', type: 'command', command: 'bash --noprofile -c "echo ${ask.value}"' },
                { id: 'run', type: 'command', command: 'sh -o nounset -c "echo ${ask.value}"' },
            ]) {
                assert.ok(
                    codes(withTasks([{ id: 'ask', type: 'inputBox', prompt: 'n?' }, task]))
                        .includes('command.nested-interpreter'),
                    `놓쳤다: ${JSON.stringify(task.command)}`
                );
            }
        });

        test('인터프리터와 스위치 사이에 다른 플래그가 껴 있어도 잡는다', () => {
            // 처음 정규식은 둘이 붙어 있는 것만 봐서 이 형태를 모두 놓쳤다.
            for (const command of [
                'powershell -NoProfile -Command "echo ${ask.value}"',
                'cmd /d /c echo %${ask.value}%',
                'sh -lc "echo ${ask.value}"',
            ]) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'name?' },
                        { id: 'run', type: 'command', command },
                    ])).includes('command.nested-interpreter'),
                    `놓쳤다: ${command}`
                );
            }
        });

        test('태스크가 아닌 참조(${workspaceFolder})도 안전하지 않다', () => {
            // 폴더 이름에 `;` 나 `&` 가 들어갈 수 있다. "태스크 참조가 없으면
            // 안전" 으로 보던 처음 구현은 이 형태를 통째로 놓쳤다.
            assert.ok(codes(withTasks([
                { id: 'run', type: 'command', command: 'sh -c "ls ${workspaceFolder}"' },
            ])).includes('command.nested-interpreter'));
        });

        test('실질적으로 제약하지 않는 validatePattern 은 면제하지 않는다', () => {
            for (const validatePattern of ['.*', '[', 'abc', '^.*$']) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'name?', validatePattern },
                        { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
                    ])).includes('command.nested-interpreter'),
                    `면제가 우회로가 됐다: ${JSON.stringify(validatePattern)}`
                );
            }
        });

        test('OS별 객체에서 안전한 branch 뒤의 취약한 branch 도 잡는다', () => {
            // `find` 로 첫 일치만 검사하면 앞의 안전한 branch 가 뒤를 가린다.
            assert.ok(codes(withTasks([
                { id: 'safe', type: 'inputBox', prompt: 'n?', validatePattern: '^[A-Za-z_]+$' },
                { id: 'free', type: 'inputBox', prompt: 'n?' },
                {
                    id: 'run', type: 'command', command: {
                        windows: 'cmd /c echo %${safe.value}%',
                        macos: 'sh -c "echo ${free.value}"',
                        linux: 'sh -c "echo ${free.value}"',
                    }
                },
            ])).includes('command.nested-interpreter'));
        });

        test('중첩 인터프리터가 없으면 경고하지 않는다', () => {
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'name?' },
                { id: 'run', type: 'command', command: 'printenv ${ask.value}' },
            ])).includes('command.nested-interpreter'));
        });

        test('itemsFromCommand 는 값의 모양이 정해지지 않아 경고한다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'quickPick', itemsFromCommand: 'git branch' },
                { id: 'run', type: 'command', command: 'cmd /c echo %${ask.value}%' },
            ])).includes('command.nested-interpreter'));
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

    // 0.6.51 의 다중 선택 `args` 확장. Doctor 가 `args` 를 단순 보간으로만
    // 검사하던 동안, 문서(`docs/features.md` §fileDialog 다중 선택)가 정답으로
    // 제시한 형태가 그대로 경고를 받았고 문구는 "런타임에서는 리터럴로
    // 전달됩니다"라며 사실과 반대를 말했다 — 같은 액션의 Preview Run 은
    // "모두 해석됨"이라 두 진단이 정면으로 어긋났다.
    const multiSelectAction = (args: string[]) => ({
        id: 'a.multi',
        title: 'multi',
        action: {
            description: 'd',
            tasks: [
                { id: 'pick', type: 'fileDialog', options: { canSelectMany: true } },
                { id: 'run', type: 'command', command: 'py', args }
            ]
        }
    });
    const unresolvedCount = (findings: DoctorFinding[]) =>
        findings.filter(f => f.code === 'variable.unresolved').length;

    test('does not flag an exact array reference in `args` (runtime expands it)', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['-3', 'report.py', '${pick.paths}', '--out', 'o.html'])])], v);
        assert.strictEqual(unresolvedCount(findings), 0,
            `expected no unresolved finding, got ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
    });

    /**
     * `folderDialog` 도 다중 선택이 되고(0.6.57) 같은 세 키를 돌려준다.
     * 시뮬레이션이 fileDialog 만 채우면, 런타임은 멀쩡히 해석하는데 Doctor 만
     * "리터럴로 전달됩니다"라고 말하는 어긋남이 폴더 쪽에 생긴다.
     */
    const folderMultiAction = (args: string[]) => ({
        id: 'a.folder-multi',
        title: 'folder-multi',
        action: {
            description: 'd',
            tasks: [
                { id: 'pick', type: 'folderDialog', options: { canSelectMany: true } },
                { id: 'run', type: 'command', command: 'py', args }
            ]
        }
    });

    test('does not flag folderDialog paths/names/count', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([folderMultiAction(
            ['${pick.paths}', '--names', '${pick.names}', '--n', '${pick.count}']
        )])], v);
        assert.strictEqual(unresolvedCount(findings), 0,
            `expected no unresolved finding, got ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
    });

    test('folderDialog 단일 선택에서도 paths 가 해석된다', () => {
        // `handleFolderDialog` 은 `canSelectMany` 와 무관하게 세 키를 채운다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.folder-one', title: 'folder-one',
            action: {
                description: 'd',
                tasks: [
                    { id: 'pick', type: 'folderDialog' },
                    { id: 'run', type: 'command', command: 'py', args: ['${pick.paths}'] }
                ]
            }
        }])], v);
        assert.strictEqual(unresolvedCount(findings), 0, codes(findings).join(','));
    });

    test('does not flag an exact reference to the `names` array in `args`', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['${pick.names}'])])], v);
        assert.strictEqual(unresolvedCount(findings), 0,
            `expected no unresolved finding, got ${codes(findings).join(',')}`);
    });

    test('does not flag `paths` on a SINGLE-select fileDialog', () => {
        // `handleFileDialog` 은 `paths`/`names`/`count` 를 `canSelectMany` 와
        // 무관하게 **항상** 돌려준다(단일 선택이면 원소 하나). 시뮬레이션이
        // 다중 선택일 때만 채우면, 런타임은 멀쩡히 해석하는데 진단은
        // "리터럴로 전달됩니다" 라고 말하는 같은 종류의 거짓말이 남는다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.single',
                title: 'single',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'fileDialog' },
                        { id: 'run', type: 'command', command: 'py', args: ['${pick.paths}', '${pick.count}'] }
                    ]
                }
            }
        ])], v);
        assert.strictEqual(unresolvedCount(findings), 0,
            `expected no unresolved finding, got ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
    });

    test('flags an array reference with a literal prefix in `args` as joined', () => {
        // 런타임은 이 형태를 펼치지 않는다. 0.6.57부터 배열이 공백으로 이어
        // 붙으므로 리터럴은 아니지만, 경로 여러 개가 **인자 한 칸**에 들어가고
        // 항목 사이의 경계가 사라져 스크립트가 값 하나로 받는다 — argv 라
        // 셸이 다시 쪼개지지는 않지만, 조용히 잘못 도는 자리다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['--file=${pick.paths}'])])], v);
        assert.ok(findings.some(f => f.code === 'args.array-joined' && f.message.includes('${pick.paths}')),
            `expected args.array-joined for the prefixed form, got ${codes(findings).join(',')}`);
        assert.strictEqual(unresolvedCount(findings), 0,
            '이어 붙는 것이지 미해결이 아니다 — 두 경고가 같은 자리를 두고 다르게 말하면 안 된다');
    });

    test('전방 참조에서도 args.array-joined 를 잡는다', () => {
        // Doctor 는 선언 순서대로 돌지만 런타임 스케줄러는 `${pick.paths}` 를
        // 보고 의존성을 자동 추론해 순서를 뒤집는다 — 즉 이 액션은 실제로
        // 동작하고, 인자도 실제로 이어 붙는다. 누적 컨텍스트만 보면 그 시점에
        // `pick` 이 없어 경고가 조용히 빠졌다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.forward', title: 'forward',
            action: {
                description: 'd',
                tasks: [
                    // 순차 실행이면 barrier(뒤 태스크는 앞을 모두 기다린다) 와
                    // 자동 추론 의존성이 **순환**을 만들어 아예 돌지 않는다 —
                    // 그러면 "런타임은 도는데 경고만 빠졌다" 를 검증할 수 없다.
                    { id: 'run', type: 'command', command: 'py', args: ['--files=${pick.paths}'], parallel: true },
                    { id: 'pick', type: 'fileDialog', options: { canSelectMany: true }, parallel: true }
                ]
            }
        }])], v);
        assert.ok(findings.some(f => f.code === 'args.array-joined' && f.message.includes('${pick.paths}')),
            `expected args.array-joined for the forward reference, got ${codes(findings).join(',')}`);
        assert.ok(!findings.some(f => f.code === 'dependsOn.cycle'),
            '픽스처가 순환이면 이 액션은 애초에 돌지 않는다 — 전방 참조를 검증한 것이 아니다');
    });

    test('전방 참조라도 스칼라 참조에는 경고하지 않는다', () => {
        // `${pick.path}` 는 문자열이다 — 이어 붙을 것이 없다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.forward-scalar', title: 'forward-scalar',
            action: {
                description: 'd',
                tasks: [
                    { id: 'run', type: 'command', command: 'py', args: ['--file=${pick.path}'], parallel: true },
                    { id: 'pick', type: 'fileDialog', options: { canSelectMany: true }, parallel: true }
                ]
            }
        }])], v);
        assert.ok(!findings.some(f => f.code === 'args.array-joined'),
            `스칼라 참조에 경고가 붙었다: ${codes(findings).join(',')}`);
    });

    test('존재하지 않는 태스크 참조는 array-joined 로 보지 않는다', () => {
        // 그쪽은 `variable.unresolved` 의 몫이다 — 두 경고가 같은 자리를 두고
        // 다르게 말하면 안 된다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['--x=${nosuch.paths}'])])], v);
        assert.ok(!findings.some(f => f.code === 'args.array-joined'), codes(findings).join(','));
        assert.ok(findings.some(f => f.code === 'variable.unresolved'), codes(findings).join(','));
    });

    test('does not flag the bare array form in `args` as joined', () => {
        // 정확히 참조 하나인 원소는 인자 여러 개로 펼쳐진다 — 문서가 권하는 형태다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['${pick.paths}'])])], v);
        assert.ok(!findings.some(f => f.code === 'args.array-joined'),
            `권장 형태에 경고가 붙었다: ${codes(findings).join(',')}`);
    });

    test('still flags a typo against a multi-select task in `args`', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([multiSelectAction(['${pick.nosuchkey}'])])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved for the typo, got ${codes(findings).join(',')}`);
    });

    test('명령 문자열 안의 배열 참조는 이어 붙어 해석된다 (0.6.57)', () => {
        // 예전에는 리터럴 `${pick.paths}` 가 그대로 자식 프로세스로 가서
        // `variable.unresolved` 로 잡혔다. 이제 공백으로 이어 붙으므로 해석된
        // 것이 맞다 — 다만 경로에 공백이 있으면 셸이 다시 쪼개므로, 그 위험은
        // `shell.interpolated-command` / `command.nested-interpreter` 가 맡는다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.multi-cmd',
                title: 'multi-cmd',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'fileDialog', options: { canSelectMany: true } },
                        { id: 'run', type: 'command', command: 'py r.py ${pick.paths}' }
                    ]
                }
            }
        ])], v);
        assert.strictEqual(unresolvedCount(findings), 0,
            `해석되는 참조를 미해결로 보고했다: ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
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

/**
 * 다이얼로그 `options` 의 스키마 (0.6.57).
 *
 * `options` 는 `{"type":"object"}` 하나뿐이었다. 값은 런타임으로 잘 전달되고
 * 오류도 없지만, **에디터가 제안할 것이 없다** — `canSelectMany` 를 쓰려던
 * 사용자가 자동완성에 나오지 않아 그런 설정이 없는 줄 알았다는 보고가 이
 * 항목의 출발점이다. 스키마가 곧 문서인 자리다.
 */
suite('actions.schema.json — 다이얼로그 options', () => {
    const options: any = (actionSchema as any).definitions?.Task?.properties?.options;

    test('제안할 키들이 스키마에 있다', () => {
        assert.ok(options, 'options 스키마를 찾지 못했다 — 경로가 바뀌었으면 이 검사를 고칠 것');
        assert.ok(options.properties, 'properties 가 없으면 에디터가 아무것도 제안하지 못한다');
        for (const key of ['canSelectMany', 'openLabel', 'title', 'defaultUri', 'filters', 'canSelectFiles', 'canSelectFolders']) {
            assert.ok(options.properties[key], `${key} 가 스키마에 없다`);
            assert.ok(typeof options.properties[key].description === 'string' && options.properties[key].description.length > 0,
                `${key} 에 설명이 없다 — 제안 목록에 이름만 뜨면 무엇인지 알 수 없다`);
        }
    });

    test('canSelectMany 설명이 결과 참조까지 알려 준다', () => {
        const d: string = options.properties.canSelectMany.description;
        for (const ref of ['paths', 'names', 'count']) {
            assert.ok(d.includes(ref), `설명에 \${taskId.${ref}} 안내가 없다: ${d}`);
        }
    });

    test('알려지지 않은 키도 그대로 통과시킨다 (VS Code 옵션 전체를 열어 둔다)', () => {
        const v = compileValidator();
        const ok = v([{
            id: 'a.x', title: 'x',
            action: { description: 'd', tasks: [{ id: 'pick', type: 'fileDialog', options: { canSelectMany: true, someFutureVsCodeOption: 1 } }] }
        }]);
        assert.strictEqual(ok, true, JSON.stringify(v.errors));
    });

    test('실제 다중 선택 액션이 스키마를 통과한다', () => {
        const v = compileValidator();
        const ok = v([{
            id: 'a.multi', title: 'multi',
            action: {
                description: 'd',
                tasks: [
                    { id: 'pick', type: 'folderDialog', options: { canSelectMany: true, openLabel: 'Select output folders' } },
                    { id: 'run', type: 'command', command: 'py', args: ['r.py', '${pick.paths}'] }
                ]
            }
        }]);
        assert.strictEqual(ok, true, JSON.stringify(v.errors));
    });
});
