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

    /**
     * `??` 체인을 오타로 잡던 회귀.
     *
     * 참조를 통째로 `.` 으로 쪼개면 `pickFile.path ?? pickFolder.path` 의 키가
     * `path ?? pickFolder.path` 로 읽혀, 멀쩡한 참조에 경고가 붙었다. 조건부
     * 태스크(`when`)를 쓰면 이 문법이 사실상 필수라 모든 분기 액션에 경고가 떴다.
     */
    test('?? 체인은 오탐하지 않는다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.coalesce',
                title: 'coalesce',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pickFile', type: 'fileDialog' },
                        { id: 'pickFolder', type: 'folderDialog' },
                        {
                            id: 'report', type: 'command', command: 'node',
                            args: ['${pickFile.path ?? pickFolder.path}']
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(!findings.some(f => f.code === 'variable.unresolved'),
            `?? 체인에 경고가 붙었다: ${codes(findings).join(',')}`);
    });

    /**
     * 같은 오탐의 **전방 참조 쪽 절반.**
     *
     * 위 테스트는 이미 시뮬레이션된 태스크를 가리키는 경우(`findTypoRefs`)만
     * 막았고, 아직 시뮬레이션되지 않은 태스크를 가리키는 경로
     * (`makeForwardRefTolerance`)는 여전히 참조 전체를 첫 `.` 으로 잘라
     * 키를 `"output ?? bB.output"` 으로 읽었다. `??` 는 병렬 분기의 결과를
     * 모으는 데 쓰는 문법이라 전방 참조가 오히려 흔한 형태다.
     *
     * 둘 다 `parallel: true` 여야 실제로 돌아가는 DAG 다 — sequential 인 뒤쪽
     * 태스크는 앞의 모든 태스크를 기다리는 암묵적 barrier 라 사이클이 된다.
     */
    test('전방 태스크를 가리키는 ?? 체인도 오탐하지 않는다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.coalesce.fwd',
                title: 'coalesce forward',
                action: {
                    description: 'd',
                    tasks: [
                        {
                            id: 'report', type: 'command', command: 'node', parallel: true,
                            args: ['${bA.output ?? bB.output}']
                        },
                        { id: 'bA', type: 'shell', command: 'make a', parallel: true, passTheResultToNextTask: true },
                        { id: 'bB', type: 'shell', command: 'make b', parallel: true, passTheResultToNextTask: true }
                    ]
                }
            }
        ])], v);
        assert.deepStrictEqual(codes(findings), [],
            `전방 ?? 체인에 경고가 붙었다: ${findings.map(f => f.message).join(' | ')}`);
    });

    /**
     * `??` 진단이 **사실대로** 말하는지. 0.6.52 의 "진단이 거짓말하면 안 된다"
     * 를 체인에도 적용한 자리다 — 리터럴로 남느냐 아니냐가 두 코드를 가른다.
     */
    suite('?? 체인 진단은 사실과 맞는다', () => {
        const chainAction = (tasks: any[]) => [{
            id: 'a.chain', title: 'chain', action: { description: 'd', tasks }
        }];

        test('미캡처 출력이 대안이어도 참조가 풀리면 리터럴이라고 하지 않는다', () => {
            // 예전에는 output.not-captured 가 "참조는 리터럴로 전달됩니다" 라고
            // 말했다. pick.value 가 풀리므로 그 문장은 거짓이다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'pick', type: 'quickPick', items: ['x'] },
                { id: 'b', type: 'shell', command: 'echo b' },
                { id: 'report', type: 'command', command: 'node', args: ['${pick.value ?? b.output}'] },
            ]))], v);
            assert.ok(!findings.some(f => f.code === 'output.not-captured'),
                `해석되는 체인에 output.not-captured 가 붙었다: ${codes(findings).join(',')}`);
            const dead = findings.filter(f => f.code === 'variable.dead-alternative');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes("passTheResultToNextTask"), dead[0].message);
            assert.ok(!dead[0].message.includes('literal'), dead[0].message);
        });

        test('대안이 전부 죽으면 이유를 모두 말한다 (하나가 묻히지 않는다)', () => {
            // 예전에는 output.not-captured 가 리터럴을 통째로 삼켜 `pick.nope`
            // 오타가 어디에도 나오지 않았다. 사용자는 b 를 고친 뒤 다시 돌려야
            // 두 번째 결함을 알 수 있었다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'pick', type: 'fileDialog' },
                { id: 'b', type: 'shell', command: 'echo b' },
                { id: 'report', type: 'command', command: 'node', args: ['${pick.nope ?? b.output}'] },
            ]))], v);
            const unresolved = findings.filter(f => f.code === 'variable.unresolved');
            assert.strictEqual(unresolved.length, 1, codes(findings).join(','));
            assert.ok(unresolved[0].message.includes("'pick.nope'"), unresolved[0].message);
            assert.ok(unresolved[0].message.includes("'b.output'"), unresolved[0].message);
            assert.ok(unresolved[0].message.includes('passTheResultToNextTask'), unresolved[0].message);
            // 전부 죽은 체인은 실제로 리터럴로 남는다 — 이때는 그렇게 말해야 한다.
            assert.ok(unresolved[0].message.includes('literal'), unresolved[0].message);
        });

        test('전방 대안의 키 오타도 잡는다 (선언 순서와 무관)', () => {
            // 0.7.6 까지 이 자리는 무경고였다. 관용이 "하나라도 풀리면" 이라
            // findUnresolved 로는 볼 수 없고, findTypoRefs 는 전방을 건너뛴다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'report', type: 'command', command: 'node', parallel: true, args: ['${bA.output ?? bB.nope}'] },
                { id: 'bA', type: 'shell', command: 'a', parallel: true, passTheResultToNextTask: true },
                { id: 'bB', type: 'shell', command: 'b', parallel: true, passTheResultToNextTask: true },
            ]))], v);
            const dead = findings.filter(f => f.code === 'variable.dead-alternative');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes("'bB.nope'"), dead[0].message);
        });

        test('이유를 종류별로 구분해 말한다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'pick', type: 'quickPick', items: ['x'] },
                { id: 'report', type: 'command', command: 'node', args: ['${pick.value ?? nosuch.x}', '${pick.value ?? report.output}'] },
            ]))], v);
            const joined = findings.filter(f => f.code === 'variable.dead-alternative').map(f => f.message).join(' | ');
            assert.ok(joined.includes("has no task 'nosuch'"), joined);
            assert.ok(joined.includes('refers to this task itself'), joined);
        });

        test('죽은 대안이 둘이면 둘 다, 복수형으로 말한다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'ok', type: 'quickPick', items: ['x'] },
                { id: 'a', type: 'inputBox', prompt: 'p' },
                { id: 'b', type: 'inputBox', prompt: 'p' },
                { id: 'report', type: 'command', command: 'node', args: ['${a.nope ?? b.nope2 ?? ok.value}'] },
            ]))], v);
            const dead = findings.filter(f => f.code === 'variable.dead-alternative');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes('2 alternatives are never used'), dead[0].message);
            assert.ok(dead[0].message.includes("'a.nope'") && dead[0].message.includes("'b.nope2'"), dead[0].message);
        });

        test('한국어 문구도 이유별로 채워진다', () => {
            // ko 번들이 비면 한국어 사용자에게 영어가 섞여 보일 뿐 아무 신호도
            // 나지 않는다 — 이유 종류마다 한 번씩 눌러 둔다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'ok', type: 'quickPick', items: ['x'] },
                { id: 'raw', type: 'shell', command: 'make' },
                {
                    id: 'report', type: 'command', command: 'node', args: [
                        '${ok.value ?? nosuch.x}',
                        '${ok.value ?? report.output}',
                        '${ok.value ?? ok.nope}',
                        '${ok.value ?? raw.output}',
                    ]
                },
            ]))], v);
            const ko = findings.filter(f => f.code === 'variable.dead-alternative')
                .map(f => f.messageKo ?? '').join(' | ');
            assert.ok(ko.includes("태스크 'nosuch' 가 없습니다"), ko);
            assert.ok(ko.includes('이 태스크 자신을 가리킵니다'), ko);
            assert.ok(ko.includes("'nope' 를 내지 않습니다"), ko);
            assert.ok(ko.includes('출력이 캡처되지 않습니다'), ko);
            assert.ok(!ko.includes('undefined'), ko);
        });

        test('체인을 막는 bare 대안은 미해결이다 (뒤 대안은 시도되지 않는다)', () => {
            // 런타임은 z 의 결과 **객체**를 받아 거기서 멈춘다 — 객체는 문자열이
            // 아니라 참조 전체가 리터럴로 남는다. "해석된다" 고 하면 거짓이다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'z', type: 'zip', source: '${workspaceFolder}/s', archive: '${workspaceFolder}/a.zip' },
                { id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true },
                { id: 'report', type: 'command', command: 'node', args: ['${z ?? build.output}'] },
            ]))], v);
            assert.ok(!findings.some(f => f.code === 'variable.dead-alternative'),
                `리터럴로 남는 체인을 "해석된다" 고 했다: ${findings.map(f => f.message).join(' | ')}`);
            const unresolved = findings.filter(f => f.code === 'variable.unresolved');
            assert.strictEqual(unresolved.length, 1, codes(findings).join(','));
            assert.ok(unresolved[0].message.includes('never tried'), unresolved[0].message);
        });

        test('itemsFromCommand 가 있으면 items 안의 체인은 보지 않는다', () => {
            // 런타임이 목록을 덮어쓰므로 실행되지 않는 참조다. 평범한 참조는
            // 이미 조용한데 체인만 잡히면 앞뒤가 안 맞는다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'pick', type: 'quickPick', itemsFromCommand: 'ls', items: ['${nosuch.a ?? nosuch2.b}'] },
                { id: 'run', type: 'command', command: 'node', args: ['${pick.value}'] },
            ]))], v);
            assert.deepStrictEqual(codes(findings), [], findings.map(f => f.message).join(' | '));
        });

        test('다른 OS branch 의 체인도 검사한다 (Doctor 는 파일 자체를 본다)', () => {
            // Preview 는 이 기계의 branch 만 보지만 Doctor 는 모든 branch 를 본다 —
            // Windows branch 의 깨진 참조는 그 OS 사용자에게 진짜 오류다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'ok', type: 'quickPick', items: ['x'] },
                {
                    id: 'run', type: 'command',
                    command: { windows: '${ok.value ?? nosuch.b}', macos: 'echo', linux: 'echo' }
                },
            ]))], v);
            assert.ok(findings.some(f => f.code === 'variable.dead-alternative'),
                `다른 OS branch 의 체인을 놓쳤다: ${codes(findings).join(',')}`);
        });

        test('멀쩡한 체인에는 아무 경고도 붙지 않는다', () => {
            // 가드가 과하지 않다는 대조군. 문서의 표준 분기 패턴이다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'pickFile', type: 'fileDialog' },
                { id: 'pickFolder', type: 'folderDialog' },
                { id: 'report', type: 'command', command: 'node', args: ['${pickFile.path ?? pickFolder.path}'] },
            ]))], v);
            assert.deepStrictEqual(codes(findings), [], findings.map(f => f.message).join(' | '));
        });

        test('평범한 참조는 예전 코드 그대로 간다', () => {
            // 체인만 새 경로를 탄다 — 대안이 하나뿐인 참조의 진단은 바뀌지 않는다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'b', type: 'shell', command: 'echo b' },
                { id: 'report', type: 'command', command: 'node', args: ['${b.output}', '${nosuch.x}'] },
            ]))], v);
            assert.ok(findings.some(f => f.code === 'output.not-captured'), codes(findings).join(','));
            assert.ok(findings.some(f => f.code === 'variable.unresolved'), codes(findings).join(','));
            assert.ok(!findings.some(f => f.code === 'variable.dead-alternative'), codes(findings).join(','));
        });

        test('bare 대안 하나로 풀리면 나머지 죽은 대안만 알린다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(chainAction([
                { id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true },
                { id: 'z', type: 'zip', source: '${workspaceFolder}/src', archive: '${workspaceFolder}/a.zip' },
                { id: 'report', type: 'command', command: 'node', args: ['${build ?? z}'] },
            ]))], v);
            const dead = findings.filter(f => f.code === 'variable.dead-alternative');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            // zip 은 archivePath 만 낸다 — bare 참조로는 풀리지 않는다.
            assert.ok(dead[0].message.includes("'z'"), dead[0].message);
            assert.ok(dead[0].message.includes('representative value'), dead[0].message);
        });
    });

    test('전방 ?? 체인도 대안이 전부 어긋나면 잡는다', () => {
        // 관용이 "대안 하나라도 풀리면" 이지 "?? 면 무조건" 이 아님을 고정한다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.coalesce.fwd.bad',
                title: 'coalesce forward bad',
                action: {
                    description: 'd',
                    tasks: [
                        {
                            id: 'report', type: 'command', command: 'node', parallel: true,
                            args: ['${bA.nope ?? bB.alsoNope}']
                        },
                        { id: 'bA', type: 'shell', command: 'make a', parallel: true, passTheResultToNextTask: true },
                        { id: 'bB', type: 'shell', command: 'make b', parallel: true, passTheResultToNextTask: true }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `전부 어긋난 전방 체인을 놓쳤다: ${codes(findings).join(',')}`);
    });

    test('?? 체인 안의 오타는 대안 하나만 틀려도 잡는다', () => {
        // ?? 는 어긋난 참조를 조용히 건너뛰고 다음 대안을 쓴다 — 동작이 멀쩡해
        // 보이므로 오히려 알려 줘야 한다.
        //
        // **다만 `variable.unresolved` 가 아니다.** 다른 대안이 풀리므로 이
        // 참조는 리터럴로 남지 않는다 — 0.7.5~0.7.7 은 그 사실과 반대되는 문구로
        // 알렸다("런타임에서는 리터럴로 전달됩니다"). 0.7.8 부터 전용 코드로
        // 나누고, 어느 대안이 왜 죽었는지까지 말한다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.coalesce.half',
                title: 'coalesce half',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pickFile', type: 'fileDialog' },
                        { id: 'pickFolder', type: 'folderDialog' },
                        {
                            id: 'report', type: 'command', command: 'node',
                            args: ['${pickFile.nope ?? pickFolder.path}', '${pickFile.path ?? pickFolder.alsoNope}']
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(!findings.some(f => f.code === 'variable.unresolved'),
            `해석되는 체인을 미해결로 보고했다: ${findings.map(f => f.message).join(' | ')}`);
        const reported = findings.filter(f => f.code === 'variable.dead-alternative');
        assert.strictEqual(reported.length, 2, `기대: 경고 2건, 실제: ${codes(findings).join(',')}`);
        const joined = reported.map(f => f.message).join(' | ');
        // 첫 대안의 오타도, **두 번째 대안**의 오타도 잡아야 한다 — 앞만 보면
        // 뒤쪽 오타가 ?? 뒤에 영영 숨는다.
        assert.ok(joined.includes("'pickFile.nope'"), joined);
        assert.ok(joined.includes("'pickFolder.alsoNope'"), joined);
        // 문구가 사실과 맞아야 한다 — 이 참조들은 리터럴로 남지 않는다.
        assert.ok(!joined.includes('literal'), `해석되는 참조에 "리터럴" 이라고 적었다: ${joined}`);
        for (const f of reported) {
            assert.ok(f.messageKo && !f.messageKo.includes('리터럴'), f.messageKo);
        }
    });

    test('?? 체인도 대안이 전부 어긋나면 잡는다 (가드가 과하지 않다)', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.coalesce.bad',
                title: 'coalesce bad',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pickFile', type: 'fileDialog' },
                        { id: 'pickFolder', type: 'folderDialog' },
                        {
                            id: 'report', type: 'command', command: 'node',
                            args: ['${pickFile.nope ?? pickFolder.alsoNope}']
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `전부 어긋난 체인을 놓쳤다: ${codes(findings).join(',')}`);
    });

    /**
     * `when` 은 0.7.4 가 낸 표면인데 참조 검사가 하나도 닿지 않았다 —
     * `when.var` 가 보간 대상 목록에 없어서, 유령을 가리켜도 findings 가 0건이고
     * 런타임에서는 그 분기가 조용히 굳었다.
     */
    suite('when 의 참조 검사', () => {
        const whenAction = (tasks: any[]) => [{
            id: 'a.when', title: 'when', action: { description: 'd', tasks }
        }];

        test('when.var 가 유령을 가리키면 잡는다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${ghost.output}', equals: 'a' } },
            ]))], v);
            assert.ok(findings.some(f => f.code === 'variable.unresolved'), codes(findings).join(','));
            const dead = findings.filter(f => f.code === 'when.dead-branch');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            // 중요한 것은 "리터럴로 전달됨" 이 아니라 그 **결과**다.
            assert.ok(dead[0].message.includes('never runs'), dead[0].message);
            assert.ok(dead[0].messageKo?.includes('영영 실행되지 않습니다'), dead[0].messageKo);
        });

        test('notEquals 면 반대로 항상 실행된다고 말한다', () => {
            // 같은 결함인데 결과가 정반대다 — "실행되지 않습니다" 로 뭉뚱그리면
            // 사용자는 조건이 걸린 줄 알고 엉뚱한 곳을 고친다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${ghost.output}', notEquals: 'a' } },
            ]))], v);
            const dead = findings.filter(f => f.code === 'when.dead-branch');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes('always runs'), dead[0].message);
        });

        test('전방 태스크를 가리키는 when.var 는 오탐하지 않는다', () => {
            // 참조가 곧 의존성이라 스케줄러가 producer 를 먼저 돌린다 — 시뮬레이션
            // 시점에만 리터럴이다. 미해결 판정과 같은 관용을 태워야 한다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', parallel: true, when: { var: '${later.output}', equals: 'a' } },
                { id: 'later', type: 'shell', command: 'make', parallel: true, passTheResultToNextTask: true },
            ]))], v);
            assert.deepStrictEqual(codes(findings), [], findings.map(f => f.message).join(' | '));
        });

        test('체인을 막는 전방 대안은 선언 순서와 무관하게 잡는다', () => {
            // 시뮬레이션 컨텍스트에는 전방 태스크가 없어 그 대안이 없는 것처럼
            // 보이고 뒤 대안이 이긴다 — 그래서 보간 결과만 보면 "풀렸다" 가 된다.
            // 런타임에서는 z 가 이미 돌아 있어 체인이 거기서 막힌다. 선언 순서만
            // 바꿔도 답이 갈리면 안 된다.
            const v = compileValidator();
            const forward = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', parallel: true, when: { var: '${z ?? pick.value}', equals: 'a' } },
                { id: 'pick', type: 'quickPick', items: ['a'], parallel: true },
                { id: 'z', type: 'zip', source: 's', archive: 'o.zip', parallel: true },
            ]))], v);
            const backward = runDoctor([makeInput(whenAction([
                { id: 'z', type: 'zip', source: 's', archive: 'o.zip', parallel: true },
                { id: 'pick', type: 'quickPick', items: ['a'], parallel: true },
                { id: 'run', type: 'shell', command: 'echo hi', parallel: true, when: { var: '${z ?? pick.value}', equals: 'a' } },
            ]))], v);
            assert.ok(forward.some(f => f.code === 'when.dead-branch'),
                `전방 선언에서 놓쳤다: ${codes(forward).join(',')}`);
            assert.deepStrictEqual(codes(forward), codes(backward), '선언 순서로 답이 갈린다');
        });

        test('in 목록이면 실행되지 않는다고 말한다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${ghost.output}', in: ['a', 'b'] } },
            ]))], v);
            const dead = findings.filter(f => f.code === 'when.dead-branch');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes('never runs'), dead[0].message);
        });

        test('matches 가 리터럴 글자에 맞으면 항상 실행된다고 말한다', () => {
            // 뜻밖이지만 사실이다 — 비교 대상이 `"${ghost.output}"` 이라는 **글자**라
            // 그 안에 `ghost` 가 들어 있다. "실행되지 않습니다" 로 뭉뚱그리면
            // 사용자는 반대 방향을 고치게 된다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${ghost.output}', matches: 'ghost' } },
            ]))], v);
            const dead = findings.filter(f => f.code === 'when.dead-branch');
            assert.strictEqual(dead.length, 1, codes(findings).join(','));
            assert.ok(dead[0].message.includes('always runs'), dead[0].message);
        });

        test('when.var 안의 ?? 체인도 대안 단위로 본다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'pick', type: 'quickPick', items: ['a'] },
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value ?? pick.nope}', equals: 'a' } },
            ]))], v);
            // 체인이 풀리므로 분기는 굳지 않는다 — 죽은 대안만 알린다.
            assert.ok(!findings.some(f => f.code === 'when.dead-branch'), codes(findings).join(','));
            assert.ok(findings.some(f => f.code === 'variable.dead-alternative'), codes(findings).join(','));
        });

        test('피연산자의 ${…} 는 보간되지 않으므로 잡는다', () => {
            // `evaluateTaskCondition` 은 equals/notEquals/matches/in 을 적힌 그대로
            // 비교한다 — 참조를 적으면 그 글자와 비교하게 되어 절대 안 맞는다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'pick', type: 'quickPick', items: ['a'] },
                { id: 'p2', type: 'quickPick', items: ['a'] },
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', equals: '${p2.value}' } },
            ]))], v);
            const lit = findings.filter(f => f.code === 'when.literal-operand');
            assert.strictEqual(lit.length, 1, codes(findings).join(','));
            assert.ok(lit[0].message.includes('${p2.value}'), lit[0].message);
        });

        test('in 목록 안의 참조도 잡는다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'pick', type: 'quickPick', items: ['a'] },
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', in: ['ok', '${pick.value}'] } },
            ]))], v);
            assert.ok(findings.some(f => f.code === 'when.literal-operand'), codes(findings).join(','));
        });

        test('notEquals 와 matches 피연산자도 본다', () => {
            // 검사 목록에서 하나만 빠져도 그 연산자를 쓰는 사용자에게는 기능이
            // 없는 것과 같다.
            const v = compileValidator();
            for (const when of [
                { var: '${pick.value}', notEquals: '${pick.value}' },
                { var: '${pick.value}', matches: '${pick.value}' },
            ]) {
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.literal-operand'),
                    `${JSON.stringify(when)} → ${codes(findings).join(',')}`);
            }
        });

        test('평범한 정규식 피연산자는 오탐하지 않는다', () => {
            // `$` 와 `{` 는 정규식에서도 쓰인다 — `${` 가 붙어야만 참조다.
            const v = compileValidator();
            for (const matches of ['^[a-z]+$', '^\\$[A-Z]+$', 'a{2,3}$']) {
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', matches } },
                ]))], v);
                assert.ok(!findings.some(f => f.code === 'when.literal-operand'),
                    `${matches} → ${findings.map(f => f.message).join(' | ')}`);
            }
        });

        test('평범한 when 에는 아무 경고도 붙지 않는다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'pick', type: 'quickPick', items: ['release', 'debug'] },
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', equals: 'release' } },
            ]))], v);
            assert.deepStrictEqual(codes(findings), [], findings.map(f => f.message).join(' | '));
        });
    });

    test('when 의 연산자가 여럿이면 잡는다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.when.ops',
                title: 'when ops',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'quickPick', items: ['a', 'b'] },
                        {
                            id: 'run', type: 'shell', command: 'echo hi',
                            when: { var: '${pick.value}', equals: 'a', notEquals: 'b' }
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'when.operators'),
            `expected when.operators, got ${codes(findings).join(',')}`);
    });

    test('when.matches 의 잘못된 정규식을 잡는다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.when.regex',
                title: 'when regex',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'pick', type: 'quickPick', items: ['a'] },
                        { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', matches: '[' } }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'when.regex'),
            `expected when.regex, got ${codes(findings).join(',')}`);
    });

    test('flags a forward reference to a capture the producer never declares', () => {
        // 전방 참조는 정상이지만(자동 추론이 순서를 뒤집는다) **키까지** 관용하면
        // `${producer.safe}` 오타가 앞쪽 producer 에 대해서만 조용히 지나간다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.fwd-typo',
                title: 'fwd typo',
                action: {
                    description: 'd',
                    // 둘 다 parallel 이어야 실제로 실행 가능한 전방 DAG 다.
                    // producer 가 sequential 이면 암묵적 barrier 때문에
                    // consumer → producer → consumer 사이클이 되어, 실행조차
                    // 못 하는 액션을 놓고 참조 해석을 검사하게 된다.
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${producer.safe}', passTheResultToNextTask: true },
                        {
                            id: 'producer', type: 'shell', parallel: true, command: 'make', passTheResultToNextTask: true,
                            output: { capture: { name: 'version', regex: 'v(\\d+)' } }
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved for the forward typo, got ${codes(findings).join(',')}`);
    });

    test('does not flag a forward reference to a declared capture', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.fwd-ok',
                title: 'fwd ok',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${producer.version}', passTheResultToNextTask: true },
                        {
                            id: 'producer', type: 'shell', parallel: true, command: 'make', passTheResultToNextTask: true,
                            output: { capture: { name: 'version', regex: 'v(\\d+)' } }
                        }
                    ]
                }
            }
        ])], v);
        assert.ok(!findings.some(f => f.code === 'variable.unresolved'),
            `declared forward capture must not be flagged, got ${codes(findings).join(',')}`);
        // fixture 자체가 실행 가능한 DAG 여야 의미가 있다.
        assert.ok(!findings.some(f => f.code === 'dependsOn.cycle'),
            `fixture must be a runnable DAG, got ${codes(findings).join(',')}`);
    });

    test('참조에 공백이 섞이면 런타임처럼 미해결로 본다', () => {
        // 런타임은 `expression.split('.')` 결과를 그대로 키로 쓴다 —
        // `${ producer.output}` 의 head 는 `" producer"` 라 어떤 태스크와도
        // 맞지 않아 리터럴로 남는다. Doctor 가 trim 하면 그 오타를 숨긴다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.space',
                title: 'space',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'consumer', type: 'shell', parallel: true, command: 'use ${ producer.output}', passTheResultToNextTask: true },
                        { id: 'producer', type: 'shell', parallel: true, command: 'make', passTheResultToNextTask: true }
                    ]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved for the spaced head, got ${codes(findings).join(',')}`);
    });

    test('prototype 오염 이름은 capture 이름으로 거부한다', () => {
        // 평범한 객체에 results['__proto__'] = v 를 하면 own property 가 만들어
        // 지지 않아 캡처가 조용히 사라진다 (결과가 {}).
        const v = compileValidator();
        for (const name of ['__proto__', 'constructor', 'prototype']) {
            const findings = runDoctor([makeInput([
                {
                    id: `a.proto.${name}`,
                    title: 'proto',
                    action: {
                        description: 'd',
                        tasks: [{
                            id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true,
                            output: { capture: { name, regex: '(.*)' } }
                        }]
                    }
                }
            ])], v);
            assert.ok(findings.some(f => f.code === 'capture.reserved'),
                `expected capture.reserved for '${name}', got ${codes(findings).join(',')}`);
        }
    });

    test('inputBox 의 prefix/suffix 안 참조도 검사한다', () => {
        // 런타임은 prefix/suffix 를 보간한다. 검사 목록에서 빠지면 그 안의
        // 오타가 무경고로 사용자 입력에 붙어 downstream 으로 나간다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.affix',
                title: 'affix',
                action: {
                    description: 'd',
                    tasks: [{ id: 'ask', type: 'inputBox', prompt: 'v?', prefix: '${ghost.output}-' }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved from prefix, got ${codes(findings).join(',')}`);
    });

    test('tool 안의 미해결 참조도 검사한다', () => {
        // 빠뜨리면 tool: "${ghost.output}" 이 무경고로 통과한 뒤 런타임에서
        // 리터럴 실행 파일로 실행을 시도한다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.tool',
                title: 'tool',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'z', type: 'zip', tool: '${ghost.output}',
                        source: '${workspaceFolder}/src', archive: '${workspaceFolder}/a.zip'
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved from tool, got ${codes(findings).join(',')}`);
    });

    test('OS별 tool 은 현재 플랫폼이 아닌 branch 도 검사한다', () => {
        // **Doctor 와 Preview Run 의 의도적인 차이**를 고정한다.
        //
        // Doctor 는 이 기계의 실행이 아니라 **설정 파일 자체**를 본다 —
        // windows branch 의 깨진 참조는 그 OS 사용자에게 진짜 오류이므로 여기서
        // 알려야 한다 (`command` 의 nested-interpreter 검사도 같은 이유로 branch
        // 전부를 훑는다). 반면 Preview Run 은 현재 플랫폼 branch 하나만 본다
        // (src/test/previewRun.test.ts 의 'OS별 tool' 스위트).
        //
        // 이 테스트가 없으면 "Preview 와 통일" 이라는 이유로 Doctor 를
        // selectPlatformValue 로 바꿔도 CI 가 통과하고, 다른 OS 진단이 조용히
        // 사라진다.
        const other = process.platform === 'win32' ? 'macos' : 'windows';
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.tool.os',
                title: 'os tool',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'z', type: 'zip',
                        tool: { [other]: '${ghost.output}' },
                        source: '${workspaceFolder}/src', archive: '${workspaceFolder}/a.zip'
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `다른 OS branch 의 깨진 참조를 놓쳤다: ${codes(findings).join(',')}`);
    });

    /**
     * 현재 플랫폼에서 **실행 자체가 불가능한** 설정은 따로 알린다.
     *
     * 다른 OS branch 의 참조까지 검사하는 정책(위 테스트)과는 별개다 — 참조가
     * 전부 해석돼도 이 기계에서 고를 branch 가 없으면 런타임은
     * `No tool path specified for the current platform` 으로 실패한다.
     */
    suite('tool.platform-missing', () => {
        const ACTIVE_OS = process.platform === 'win32' ? 'windows'
            : process.platform === 'darwin' ? 'macos' : 'linux';
        const INACTIVE_OS = ACTIVE_OS === 'windows' ? 'macos' : 'windows';

        function zipWithTool(id: string, tool: unknown) {
            return {
                id,
                title: 'os tool',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'z', type: 'zip', tool,
                        source: '${workspaceFolder}/src', archive: '${workspaceFolder}/a.zip'
                    }]
                }
            };
        }

        test('현재 플랫폼 branch 가 없으면 보고한다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                zipWithTool('a.tool.missing', { [INACTIVE_OS]: '/tools/other-7z' })
            ])], v);
            assert.ok(findings.some(f => f.code === 'tool.platform-missing'),
                `이 기계에서 실행할 수 없는 설정을 놓쳤다: ${codes(findings).join(',')}`);
        });

        test('현재 플랫폼 branch 가 있으면 보고하지 않는다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                zipWithTool('a.tool.present', { [ACTIVE_OS]: '/usr/bin/7z', [INACTIVE_OS]: '/tools/other-7z' })
            ])], v);
            assert.ok(!findings.some(f => f.code === 'tool.platform-missing'),
                `실행 가능한 설정을 막았다: ${codes(findings).join(',')}`);
        });

        test('문자열 tool 은 보고하지 않는다', () => {
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                zipWithTool('a.tool.string', '/usr/bin/7z')
            ])], v);
            assert.ok(!findings.some(f => f.code === 'tool.platform-missing'),
                `모든 플랫폼에서 쓰이는 문자열 tool 을 막았다: ${codes(findings).join(',')}`);
        });

        test('빈 문자열 tool 도 보고한다', () => {
            // OS별 객체는 아니지만 getToolCommand 가 똑같이 던지는 값이다.
            const v = compileValidator();
            const findings = runDoctor([makeInput([zipWithTool('a.tool.empty', '')])], v);
            assert.ok(findings.some(f => f.code === 'tool.platform-missing'),
                `실행할 수 없는 빈 tool 을 놓쳤다: ${codes(findings).join(',')}`);
        });

        test('unzip 태스크에서도 보고한다', () => {
            // 문서 표가 zip/unzip 둘 다 약속한다.
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.tool.unzip',
                    title: 'os tool',
                    action: {
                        description: 'd',
                        tasks: [{
                            id: 'u', type: 'unzip',
                            tool: { [INACTIVE_OS]: '/tools/other-7z' },
                            archive: '${workspaceFolder}/a.zip',
                            destination: '${workspaceFolder}/out'
                        }]
                    }
                }
            ])], v);
            assert.ok(findings.some(f => f.code === 'tool.platform-missing'),
                `unzip 의 OS별 tool 은 검사하지 않았다: ${codes(findings).join(',')}`);
        });

        test('zip/unzip 이 아닌 태스크에 달아도 보고한다', () => {
            // 이 검사에는 **타입 게이트가 없다**. `tool` 은 스키마에서 태스크 공통
            // 속성이라(`definitions/Task/properties`) shell 에 달아도 유효한
            // 설정이고, 런타임 `getToolCommand` 도 타입을 가리지 않는다.
            //
            // 문서 표는 이 동작을 "tool 을 가진 태스크(실질적으로 zip/unzip)" 로
            // 적고 있다. 나중에 zip/unzip 으로 **좁히고 싶어지면** 이 테스트가
            // 먼저 걸리므로, 그때 문서와 함께 의도적으로 바꾸게 된다.
            const v = compileValidator();
            const findings = runDoctor([makeInput([
                {
                    id: 'a.tool.shell',
                    title: 'os tool',
                    action: {
                        description: 'd',
                        tasks: [{
                            id: 's', type: 'shell', command: 'echo hi',
                            tool: { [INACTIVE_OS]: '/tools/other-7z' }
                        }]
                    }
                }
            ])], v);
            assert.ok(findings.some(f => f.code === 'tool.platform-missing'),
                `shell 태스크의 tool 은 검사하지 않았다: ${codes(findings).join(',')}`);
        });
    });

    test('output.content 안 참조도 검사한다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.content',
                title: 'content',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'w', type: 'shell', command: 'make', passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: '${workspaceFolder}/o.txt', content: 'v=${ghost.output}' }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'variable.unresolved'),
            `expected variable.unresolved from output.content, got ${codes(findings).join(',')}`);
    });

    test('capture 이름으로 stderr 를 쓰면 예약어로 거부한다', () => {
        // 캡처 결과는 결과 객체에 병합되므로, stdout 에서 뽑은 값이 진짜
        // stderr 를 덮고 그 stderr 를 읽는 진단까지 함께 오염된다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([
            {
                id: 'a.reserved',
                title: 'reserved',
                action: {
                    description: 'd',
                    tasks: [{
                        id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true,
                        output: { capture: { name: 'stderr', regex: '(.*)' } }
                    }]
                }
            }
        ])], v);
        assert.ok(findings.some(f => f.code === 'capture.reserved'),
            `expected capture.reserved for 'stderr', got ${codes(findings).join(',')}`);
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

    test('앞 대안이 이미 실행된 태스크여도 뒤쪽 전방 배열을 놓치지 않는다', () => {
        // 배열 판정기는 참조를 통째로 첫 `.` 으로 잘라 head 를 `chosen` 하나로
        // 읽었다. `chosen` 은 이미 시뮬레이션된 태스크라 "전방이 아니니 볼 것
        // 없다" 로 빠졌고, 실제로 값을 내는 뒤쪽 전방 대안(`pick.paths`)은
        // 판정에 들어오지도 못했다 — 런타임에서는 인자가 실제로 이어 붙는다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.forwardCoalesce', title: 'forward coalesce',
            action: {
                description: 'd',
                tasks: [
                    // `chosen` 에는 `paths` 가 없다 — 체인은 뒤 대안으로 넘어간다.
                    { id: 'chosen', type: 'quickPick', items: ['a', 'b'], parallel: true },
                    { id: 'run', type: 'command', command: 'py', args: ['--files=${chosen.paths ?? pick.paths}'], parallel: true },
                    { id: 'pick', type: 'fileDialog', options: { canSelectMany: true }, parallel: true }
                ]
            }
        }])], v);
        assert.ok(findings.some(f => f.code === 'args.array-joined'),
            `expected args.array-joined for the forward ?? chain, got ${codes(findings).join(',')}`);
    });

    test('앞 대안이 배열이 아니면 체인 전체도 배열이 아니다', () => {
        // `??` 는 먼저 풀리는 대안이 이긴다. 대안별로 "하나라도 배열이면" 으로
        // 보면, 실제로는 문자열 하나가 들어가는 자리에 경고가 붙는다.
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.forwardCoalesceStr', title: 'forward coalesce string',
            action: {
                description: 'd',
                tasks: [
                    { id: 'run', type: 'command', command: 'py', args: ['--files=${pickOne.path ?? pickMany.paths}'], parallel: true },
                    { id: 'pickOne', type: 'fileDialog', parallel: true },
                    { id: 'pickMany', type: 'fileDialog', options: { canSelectMany: true }, parallel: true }
                ]
            }
        }])], v);
        assert.ok(!findings.some(f => f.code === 'args.array-joined'),
            `문자열로 풀리는 체인에 경고가 붙었다: ${codes(findings).join(',')}`);
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
