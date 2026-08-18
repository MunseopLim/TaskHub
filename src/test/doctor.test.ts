import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import { runDoctor, runDoctorPerSource, DoctorInput, DoctorFinding, DoctorValidator, scriptCandidateTokens, enumerateArgvCandidates } from '../doctor';
import { detectFrozenCondition } from '../previewRun';
import { evaluateTaskCondition } from '../pipelineUtils';
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

    test('현재 에디터·환경 내장 참조를 task id 오타로 보고하지 않는다', () => {
        const v = compileValidator();
        const findings = runDoctor([makeInput([{
            id: 'a.builtin',
            title: 'Builtin',
            action: {
                description: 'ok',
                tasks: [{
                    id: 'run', type: 'command', command: 'tool',
                    args: [
                        '${file}', '${relativeFile}', '${fileDirname}', '${fileBasename}',
                        '${selectedText}', '${lineNumber}', '${columnNumber}', '${clipboard}',
                        '${env:PATH}',
                    ],
                }],
            },
        }])], v);
        assert.ok(!codes(findings).includes('variable.unresolved'), JSON.stringify(findings, null, 2));
    });

    test('환경변수 실제 값이 path 진단 문구에 노출되지 않는다', () => {
        const name = 'TASKHUB_DOCTOR_SECRET_PATH';
        const previous = process.env[name];
        process.env[name] = '/outside/doctor-secret';
        try {
            const findings = runDoctor([makeInput([{
                id: 'a.env-path', title: 'env path', action: {
                    description: 'd',
                    tasks: [{
                        id: 'write', type: 'writeFile',
                        path: `\${env:${name}}/out.txt`, content: 'x', allowSecretContent: true,
                    }],
                },
            }])], compileValidator());
            assert.ok(!JSON.stringify(findings).includes('/outside/doctor-secret'));
        } finally {
            if (previous === undefined) { delete process.env[name]; }
            else { process.env[name] = previous; }
        }
    });

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
     * password 파생 값의 파일 저장은 런타임이 **실행 중에** 거부한다. 그때는
     * 앞 태스크의 부수 효과가 이미 일어난 뒤이므로, 편집 시점에 잡는 값이 크다.
     */
    suite('secret.file-optin', () => {
        const secretAsk = { id: 'ask', type: 'inputBox', prompt: 'token?', password: true };
        function analyze(tasks: any[]): DoctorFinding[] {
            return runDoctor([makeInput([
                { id: 'a.secret', title: 'S', action: { description: 'd', tasks } },
            ])], compileValidator());
        }

        test('플래그 없는 writeFile 을 error 로 잡는다', () => {
            const findings = analyze([
                secretAsk,
                { id: 'w', type: 'writeFile', path: path.join(WS, 'c.txt'), content: '${ask.value}' },
            ]);
            const finding = findings.find(f => f.code === 'secret.file-optin');
            assert.ok(finding, `expected secret.file-optin, got ${codes(findings)}`);
            assert.strictEqual(finding!.severity, 'error');
            assert.ok(finding!.message.includes('a.secret.w'));
        });

        test('플래그 없는 output.mode file 도 같은 게이트를 지난다', () => {
            const findings = analyze([
                secretAsk,
                {
                    id: 'o', type: 'command', command: 'node',
                    args: ['-e', 'process.stdout.write(process.argv[1])', '${ask.value}'],
                    passTheResultToNextTask: true,
                    output: { mode: 'file', filePath: path.join(WS, 'o.txt'), overwrite: true },
                },
            ]);
            assert.ok(findings.some(f => f.code === 'secret.file-optin'));
        });

        test('오염은 런타임과 같이 전이된다 — 비밀을 거친 결과를 쓰는 태스크도 잡는다', () => {
            const findings = analyze([
                secretAsk,
                {
                    id: 'derive', type: 'command', command: 'node',
                    args: ['-e', 'process.stdout.write(process.argv[1])', '${ask.value}'],
                    passTheResultToNextTask: true,
                },
                { id: 'w', type: 'writeFile', path: path.join(WS, 'c.txt'), content: '${derive.output}' },
            ]);
            assert.ok(findings.some(f => f.code === 'secret.file-optin'));
        });

        test('선언했으면 잡지 않는다', () => {
            const findings = analyze([
                secretAsk,
                {
                    id: 'w', type: 'writeFile', path: path.join(WS, 'c.txt'),
                    content: '${ask.value}', allowSecretContent: true,
                },
            ]);
            assert.deepStrictEqual(codes(findings).filter(c => c.startsWith('secret.')), []);
        });

        test('비밀과 무관한 파일 쓰기는 건드리지 않는다', () => {
            const findings = analyze([
                { id: 'w', type: 'writeFile', path: path.join(WS, 'c.txt'), content: 'plain' },
            ]);
            assert.deepStrictEqual(codes(findings).filter(c => c.startsWith('secret.')), []);
        });

        test('아무것도 허용하지 않는 선언은 warning 으로 알린다', () => {
            const noWrite = analyze([
                { id: 'c', type: 'shell', command: 'echo hi', allowSecretContent: true },
            ]);
            const unusedOnShell = noWrite.find(f => f.code === 'secret.allow-unused');
            assert.ok(unusedOnShell, `expected secret.allow-unused, got ${codes(noWrite)}`);
            assert.strictEqual(unusedOnShell!.severity, 'warning');

            const notSecret = analyze([
                { id: 'w', type: 'writeFile', path: path.join(WS, 'c.txt'), content: 'plain', allowSecretContent: true },
            ]);
            assert.ok(notSecret.some(f => f.code === 'secret.allow-unused'));
        });
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

    suite('소스별 분석 격리', () => {
        const good = makeInput([{ id: 'a', title: 'X', action: { description: 'd', tasks: [] } }]);
        const bad = makeInput([{ id: 'b', title: 'Y', action: { description: 'd', tasks: [] } }], {
            sourceLabel: 'test:broken.json', filePath: path.join(WS, '.vscode', 'broken.json'),
        });

        test('한 소스가 던져도 다른 소스의 결과는 살아남는다', () => {
            const validator: any = (data: any) => {
                if (JSON.stringify(data).includes('"b"')) { throw new Error('boom'); }
                return true;
            };
            const findings = runDoctorPerSource([bad, good], validator);
            const failed = findings.filter(f => f.code === 'doctor.analysis-failed');
            assert.strictEqual(failed.length, 1, `분석 실패를 알리지 않았다: ${findings.map(f => f.code).join(', ')}`);
            assert.strictEqual(failed[0].sourceLabel, 'test:broken.json');
            assert.ok(failed[0].message.includes('boom'), '예외 내용을 싣지 않았다');
            // 정상 소스는 그대로 분석된다 — 실패가 다른 소스를 가리지 않는다.
            assert.ok(!findings.some(f => f.code !== 'doctor.analysis-failed' && f.sourceLabel === 'test:broken.json'));
        });

        test('예외가 없으면 runDoctor 와 같은 결과다', () => {
            const validator = compileValidator();
            const inputs = [good, bad];
            assert.deepStrictEqual(
                runDoctorPerSource(inputs, validator).map(f => f.code),
                runDoctor(inputs, validator).map(f => f.code)
            );
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

        test('forEach 지역 each는 동명 정적 task로 안전 판정하지 않는다', () => {
            assert.ok(codes(withTasks([
                { id: 'each', type: 'quickPick', items: ['safe'] },
                {
                    id: 'run', type: 'command', forEach: ['untrusted'],
                    command: 'sh -c "echo ${each.value}"',
                },
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
                { id: 'run', type: 'command', command: 'cmd /c echo ${ask.value}' },
            ])).includes('command.nested-interpreter'));
        });

        test('메타문자 없는 고정 items 를 가진 quickPick 은 면제한다', () => {
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'quickPick', items: ['dev', 'prod'] },
                { id: 'run', type: 'command', command: 'cmd /c echo ${ask.value}' },
            ])).includes('command.nested-interpreter'));
        });

        test('?? 체인은 대안 **전부**가 제약돼야 면제한다', () => {
            // 어느 대안이 값을 낼지는 런타임에 갈린다. 첫 대안만 보면
            // `${safe.value ?? free.value}` 가 통과해, 실제로 흘러가는 값이
            // 제약 없는 쪽일 때 아무 경고도 남지 않는다.
            assert.ok(codes(withTasks([
                { id: 'safe', type: 'inputBox', prompt: 'n?', validatePattern: '^[A-Za-z]+$' },
                { id: 'free', type: 'inputBox', prompt: 'n?' },
                { id: 'run', type: 'command', command: 'sh -c "echo ${safe.value ?? free.value}"' },
            ])).includes('command.nested-interpreter'), '뒤 대안이 제약 없는데 통과시켰다');

            assert.ok(!codes(withTasks([
                { id: 'safe', type: 'inputBox', prompt: 'n?', validatePattern: '^[A-Za-z]+$' },
                { id: 'alsoSafe', type: 'inputBox', prompt: 'n?', validatePattern: '^[0-9]+$' },
                { id: 'run', type: 'command', command: 'sh -c "echo ${safe.value ?? alsoSafe.value}"' },
            ])).includes('command.nested-interpreter'), '둘 다 제약됐는데 경고했다');
        });

        test('인용 없는 ?? 체인에서도 대안 전부를 본다', () => {
            // 인용이 없어도 참조 토큰은 토큰마다 따로 후보에 담기므로 스크립트
            // 텍스트 자체는 예전에도 온전했다. 여기서 검사하는 것은 그게 아니라
            // **첫 대안만 보던 것**이다 — 첫 대안을 제약해 두면 예전 코드는
            // 통과시킨다.
            assert.ok(codes(withTasks([
                { id: 'safe', type: 'inputBox', prompt: 'n?', validatePattern: '^[A-Za-z]+$' },
                { id: 'free', type: 'inputBox', prompt: 'n?' },
                { id: 'run', type: 'command', command: 'sh -c ${safe.value ?? free.value}' },
            ])).includes('command.nested-interpreter'));
        });

        test('실행 파일이 참조로 정해져도 인터프리터를 알아본다', () => {
            // 보간 전 템플릿만 보면 실행 파일 이름이 `${which.value}` 라 어떤
            // 인터프리터와도 맞지 않아 검사를 통째로 비껴갔다. 런타임에서는
            // `sh` 가 되어 ask.value 가 스크립트로 흘러간다.
            assert.ok(codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['sh'] },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: '${which.value} -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '고정 items 로 풀리는 실행 파일을 놓쳤다');
        });

        test('forEach 지역 each가 실행 파일이면 fail-closed로 진단한다', () => {
            const found = codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                {
                    id: 'run', type: 'command', forEach: ['sh'],
                    command: '${each.value}', args: ['-c', 'echo ${ask.value}'],
                },
            ]));
            assert.ok(
                found.includes('command.nested-interpreter') || found.includes('command.dynamic-interpreter'),
                `동적 반복 실행 파일이 진단을 우회했다: ${found.join(', ')}`
            );
        });

        /**
         * 항목의 `value` 매핑이 label 을 대신하므로, label 만 보는 판정은
         * **실행되지 않는 문자열**을 검사하게 된다. 보이는 문구는 얌전한데
         * 매핑에 `sh` 나 메타문자를 넣어 두면 그대로 뚫린다.
         */
        test('quickPick 은 label 이 아니라 치환되는 value 를 본다', () => {
            const enumerated = (items: any[]) =>
                enumerateArgvCandidates(['${which.value}', '-c', 'echo x'],
                    [{ id: 'which', type: 'quickPick', items }] as any)
                    .variants.map(v => v[0]);

            assert.deepStrictEqual(
                enumerated([{ label: 'POSIX shell', value: 'sh' }]), ['sh'],
                'label 을 실행 파일로 열거해 실제로 도는 인터프리터를 놓쳤다'
            );
            // 배열 매핑은 argv 여러 칸이라 실행 파일 하나로 열거할 수 없다 — fail-closed.
            assert.deepStrictEqual(
                enumerated([{ label: 'B', value: ['sh', '-x'] }]), ['${which.value}'],
                '열거할 수 없는 매핑을 펼쳤다'
            );

            // 셸 메타문자 면제도 같은 기준이어야 한다.
            assert.ok(codes(withTasks([
                { id: 'mode', type: 'quickPick', items: [{ label: 'Safe looking', value: 'x; id' }] },
                { id: 'run', type: 'command', command: 'sh -c "echo ${mode.value}"' },
            ])).includes('command.nested-interpreter'), '매핑에 숨은 메타문자가 면제됐다');
            assert.ok(!codes(withTasks([
                { id: 'mode', type: 'quickPick', items: [{ label: 'x; id', value: 'safe' }] },
                { id: 'run', type: 'command', command: 'sh -c "echo ${mode.value}"' },
            ])).includes('command.nested-interpreter'), '명령에 닿지도 않는 label 때문에 경고했다');
        });

        /**
         * **키마다 다른 문자열이 치환된다.** `${pick.value}` 는 매핑 값,
         * `${pick.label}` 은 표시 문구다. 판정이 키를 보지 않으면 얌전한 값을
         * 매핑해 두고 label 에 위험한 문구를 적는 것만으로 면제가 뚫린다 —
         * 매핑을 추가하면서 실제로 뚫렸던 자리라 양쪽을 함께 고정한다.
         */
        test('quickPick 판정은 참조한 키에 맞는 문자열을 본다', () => {
            const hostileLabel = [
                { id: 'mode', type: 'quickPick', items: [{ label: 'x; id', value: 'safe' }] },
            ];
            assert.ok(codes(withTasks([
                ...hostileLabel,
                { id: 'run', type: 'command', command: 'sh -c "echo ${mode.label}"' },
            ])).includes('command.nested-interpreter'), 'label 참조인데 매핑 값으로 면제했다');
            assert.ok(codes(withTasks([
                { id: 'mode', type: 'quickPick', canPickMany: true, items: [{ label: 'x; id', value: 'safe' }] },
                { id: 'run', type: 'command', command: 'sh -c "echo ${mode.labels}"' },
            ])).includes('command.nested-interpreter'), 'labels 참조인데 매핑 값으로 면제했다');
            // 반대 방향: label 이 얌전하면 label 참조는 그대로 면제된다.
            assert.ok(!codes(withTasks([
                { id: 'mode', type: 'quickPick', items: [{ label: 'safe', value: 'x; id' }] },
                { id: 'run', type: 'command', command: 'sh -c "echo ${mode.label}"' },
            ])).includes('command.nested-interpreter'), '치환되지 않는 매핑 값 때문에 경고했다');

            // 인터프리터 열거도 같은 기준이다 — label 참조를 매핑 값으로 열거하면
            // Doctor 가 `echo` 를 모형으로 삼고 런타임은 `sh` 를 실행한다.
            const enumerated = (ref: string) =>
                enumerateArgvCandidates([ref, '-c', 'echo x'],
                    [{ id: 'which', type: 'quickPick', items: [{ label: 'sh', value: 'echo' }] }] as any)
                    .variants.map(v => v[0]);
            assert.deepStrictEqual(enumerated('${which.label}'), ['sh'], 'label 자리를 매핑 값으로 열거했다');
            assert.deepStrictEqual(enumerated('${which.value}'), ['echo']);
        });

        /**
         * 항목의 `value` 도 런타임이 보간한다. 검사에서 빠지면 거기 적힌 오타가
         * `${bulid.output}` 리터럴 그대로 argv 에 도착하는데 아무 진단도 없다 —
         * 같은 오타가 `label` 에 있으면 잡히므로 자리에 따라 판정이 갈렸다.
         */
        /**
         * 배열 매핑을 쓰면 `${mode.value}` 도 **배열**이다. 시뮬레이션이 문자열로만
         * 흉내 내면 `"--x=${mode.value}"` 처럼 조용히 인자 한 칸으로 뭉치는 형태에
         * `args.array-joined` 가 붙지 않는다 — 그 경고가 있는 이유 자체가 사라진다.
         */
        test('배열 매핑은 시뮬레이션에서도 배열이라 array-joined 가 붙는다', () => {
            const arrayMapped = { id: 'mode', type: 'quickPick', items: [{ label: 'B', value: ['--option', 'b'] }] };
            assert.ok(codes(withTasks([
                arrayMapped,
                { id: 'run', type: 'command', command: 'tool', args: ['--x=${mode.value}'] },
            ])).includes('args.array-joined'), '배열 매핑이 문자열로 흉내 내져 경고가 빠졌다');
            // 원소 전체가 참조면 런타임이 펼치므로 경고 대상이 아니다.
            assert.ok(!codes(withTasks([
                arrayMapped,
                { id: 'run', type: 'command', command: 'tool', args: ['${mode.value}'] },
            ])).includes('args.array-joined'), '정상적으로 펼쳐지는 형태에 경고가 붙었다');
            // 문자열 매핑은 배열이 아니므로 섞여 있어도 이 경고 대상이 아니다.
            assert.ok(!codes(withTasks([
                { id: 'mode', type: 'quickPick', items: [{ label: 'A', value: '--with-option' }] },
                { id: 'run', type: 'command', command: 'tool', args: ['--x=${mode.value}'] },
            ])).includes('args.array-joined'));
        });


        test('항목 value 의 미해결 참조도 잡는다', () => {
            for (const item of [
                { label: 'ok', value: '${bulid.output}' },
                { label: 'ok', value: ['--f', '${bulid.output}'] },
            ]) {
                assert.ok(codes(withTasks([
                    { id: 'build', type: 'shell', command: 'make', passTheResultToNextTask: true },
                    { id: 'mode', type: 'quickPick', items: [item] },
                    { id: 'run', type: 'command', command: 'tool', args: ['${mode.value}'] },
                ])).includes('variable.unresolved'), `value 의 오타가 조용했다: ${JSON.stringify(item.value)}`);
            }
        });

        test('열거는 런타임이 **실제로 내는 키**일 때만 한다', () => {
            // `${which.typo}` 는 런타임에서 미해결 리터럴로 남아 실행 파일이 되지
            // 않는다. 키를 안 보고 항목을 펼치면 Doctor 가 그것을 `sh` 로 바꿔 놓고
            // 없는 위험을 만들어 낸다 — 옳은 `variable.unresolved` 위에
            // `command.nested-interpreter` 까지 얹혔다.
            const enumerated = (ref: string, extra: any = {}) =>
                enumerateArgvCandidates([ref, '-c', 'echo x'],
                    [{ id: 'which', type: 'quickPick', items: ['sh', 'node'], ...extra }] as any)
                    .variants.map(v => v[0]);

            assert.deepStrictEqual(enumerated('${which.value}'), ['sh', 'node'], '정상 키를 펼치지 않았다');
            assert.deepStrictEqual(enumerated('${which.typo}'), ['${which.typo}'], '없는 키를 펼쳤다');
            // bare quickPick은 대표 `value`의 축약이다.
            assert.deepStrictEqual(enumerated('${which}'), ['sh', 'node'], 'bare value 참조를 펼치지 않았다');
            // `values` 는 다중 선택일 때만 나온다.
            assert.deepStrictEqual(enumerated('${which.values}'), ['${which.values}'], '단일 선택의 `values` 를 펼쳤다');
            assert.deepStrictEqual(enumerated('${which.values}', { canPickMany: true }), ['sh', 'node']);

            // **풀릴 대안이 하나도 없으면 그 명령은 실행 자체가 안 된다.** 실행 파일
            // 이름이 리터럴로 남아 spawn 이 실패하므로 인터프리터 진단을 얹으면
            // 없는 위험을 지어내는 것이다. 값에 제약이 없어도 마찬가지다 —
            // 제약된 패턴으로만 검사하면 이 재현 조건이 가려진다.
            const unresolvableExe = codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['sh'] },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command: '${which.typo} -c "echo ${ask.value}"' },
            ]));
            assert.ok(unresolvableExe.includes('variable.unresolved'),
                `오타를 미해결로 알리지 않았다: ${unresolvableExe.join(', ')}`);
            assert.ok(!unresolvableExe.some(c => c.startsWith('command.')),
                `실행되지도 않는 명령에 인터프리터 진단을 얹었다: ${unresolvableExe.join(', ')}`);

            // 반대로 **풀리는** 자리는 그대로 경고한다 — fail-open 이 되면 안 된다.
            const live = (command: string) => codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['sh'] },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command },
            ]));
            assert.ok(live('${which.value} -c "echo ${ask.value}"').includes('command.nested-interpreter'),
                '정상 키인데 조용해졌다');
            assert.ok(live('${which} -c "echo ${ask.value}"').includes('command.nested-interpreter'),
                'bare value 축약인데 조용해졌다');
            // `??` 체인은 **하나라도** 풀리면 실행된다.
            assert.ok(live('${which.typo ?? which.value} -c "echo ${ask.value}"').includes('command.nested-interpreter'),
                '체인의 살아 있는 대안을 놓쳤다');
            // 열거할 수 없는 실행 파일은 종전대로 fail-closed 다.
            assert.ok(codes(withTasks([
                { id: 'pick', type: 'inputBox', prompt: 'exe?' },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command: '${pick.value} -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '열거 불가 실행 파일이 조용해졌다');

            const custom = codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['node'], allowCustom: true },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command: '${which.value} -c "echo ${ask.value}"' },
            ]));
            assert.ok(custom.some(code => code.startsWith('command.')),
                `직접 입력 가능한 quickPick을 고정 목록처럼 면제했다: ${custom.join(', ')}`);

            // bare 내장은 동명 태스크보다 세지만, 속성이 붙으면 기존 action 호환을
            // 위해 그 task 결과를 읽는다. 따라서 안전 진단도 실제 quickPick 값을
            // 펼쳐 보아야 한다.
            for (const builtin of ['workspaceFolder', 'extensionPath']) {
                const found = codes(withTasks([
                    { id: builtin, type: 'quickPick', items: ['sh'] },
                    { id: 'ask', type: 'inputBox', prompt: '?' },
                    { id: 'run', type: 'command', command: `\${${builtin}.value} -c "echo \${ask.value}"` },
                ]));
                assert.ok(found.includes('command.nested-interpreter'),
                    `동명 task의 속성 값을 펼치지 않았다 (${builtin}): ${found.join(', ')}`);
                assert.ok(!found.includes('variable.unresolved'), found.join(', '));
            }

            // 아예 없는 태스크를 가리키면 런타임에서 리터럴로 남아 spawn 이 실패한다.
            for (const command of [
                '${ghost.value} -c "echo ${ask.value}"',
                '${which.typo ?? ghost.value} -c "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'which', type: 'quickPick', items: ['sh'] },
                    { id: 'ask', type: 'inputBox', prompt: '?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(!found.some(c => c.startsWith('command.')),
                    `실행되지도 않는 명령에 인터프리터 진단을 얹었다: ${command} (${found.join(', ')})`);
                assert.ok(found.includes('variable.unresolved'), found.join(', '));
            }

            // **bare 내장은 항상 풀려 `??` 체인을 끝낸다** — 뒤 대안은 쓰이지 않으므로
            // 펼치면 있지도 않은 인터프리터를 지어낸다. 값 자체는 디렉터리 경로다.
            assert.ok(!codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['sh'] },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command: '${workspaceFolder ?? which.value} -c "echo ${ask.value}"' },
            ])).some(c => c.startsWith('command.')), 'bare 내장 뒤의 죽은 대안을 펼쳤다');

            // 반대로 `.value` 는 문자열의 없는 속성이라 풀리지 않으므로 **뒤 대안이
            // 살아 있다** — 그쪽은 그대로 경고해야 한다.
            assert.ok(codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['sh'] },
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command: '${workspaceFolder.value ?? which.value} -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '살아 있는 뒤 대안을 놓쳤다');
        });

        test('value mapping이 있는데 command가 label을 전달하면 실행값 사용법을 안내한다', () => {
            const findings = runDoctor([makeInput(withTasks([
                {
                    id: 'mode', type: 'quickPick',
                    items: [
                        { label: 'With option', value: '--release' },
                        { label: 'No option', value: [] },
                    ],
                },
                { id: 'run', type: 'command', command: 'tool', args: ['${mode.label}'] },
            ]))], compileValidator());
            const hint = findings.find(finding => finding.code === 'quickpick.label-as-argument');
            assert.ok(hint, `label/value 안내가 없다: ${findings.map(f => f.code).join(', ')}`);
            assert.strictEqual(hint!.severity, 'info');
            assert.match(hint!.message, /bare reference.*\.value.*omits the argument/);

            const usingValue = codes(withTasks([
                { id: 'mode', type: 'quickPick', items: [{ label: 'Release', value: '--release' }] },
                { id: 'run', type: 'command', command: 'tool', args: ['${mode}'] },
            ]));
            assert.ok(!usingValue.includes('quickpick.label-as-argument'));
            assert.ok(!usingValue.includes('variable.unresolved'));
        });

        test('`??` 체인은 **사라지지 않는 대안**에서만 끊는다', () => {
            // 태스크 결과가 사라지는 길은 여럿이다 — `when` · `continueOnError` 실패나
            // 취소 · 조건으로 꺼진 태스크를 참조한 전이적 skip. 그중 하나라도 빠뜨리고
            // "뒤 대안은 죽었다" 고 단정하면 그 자리가 fail-open 이 된다. 그래서 태스크
            // 대안은 체인을 끊지 않고 후보만 쌓는다(과탐을 감수한다). 끊을 수 있는 것은
            // 꺼지는 길이 없는 **예약 내장**과, 결과 객체 자체가 값이 되는 **bare 참조**뿐이다.
            const chain = (tasks: any[], command: string) => codes(withTasks([
                ...tasks,
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'run', type: 'command', command },
            ])).includes('command.nested-interpreter');

            const safe = { id: 'safe', type: 'quickPick', items: ['echo'] };
            const bad = { id: 'bad', type: 'quickPick', items: ['sh'] };

            // 앞이 살아 있으면 뒤 bare 내장이 진단을 끄지 못한다.
            assert.ok(chain([bad], '${bad.value ?? workspaceFolder} -c "echo ${ask.value}"'),
                '앞 대안이 살아 있는데 뒤 내장을 보고 진단을 껐다');
            // 죽은 대안은 건너뛰고 다음으로 넘어간다.
            assert.ok(chain([safe, bad], '${safe.typo ?? bad.value} -c "echo ${ask.value}"'),
                '죽은 대안 뒤의 살아 있는 대안을 놓쳤다');

            // **사라질 수 있는 앞 대안은 뒤를 가리지 못한다.** 세 가지 skip 경로를
            // 모두 고정한다 — 하나만 모델링하던 동안 나머지 둘이 fail-open 이었다.
            assert.ok(chain(
                [{ ...safe, when: { var: '${x}', equals: 'y' } }, bad],
                '${safe.value ?? bad.value} -c "echo ${ask.value}"',
            ), '`when` 으로 꺼질 수 있는 대안에서 체인을 끝냈다');
            assert.ok(chain(
                [{ ...safe, continueOnError: true }, bad],
                '${safe.value ?? bad.value} -c "echo ${ask.value}"',
            ), '`continueOnError` 로 사라질 수 있는 대안에서 체인을 끝냈다');
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?' },
                { id: 'gate', type: 'quickPick', items: ['g'], when: { var: '${ask.value}', equals: 'y' } },
                { ...safe, placeHolder: 'pick ${gate.value}' },     // gate 가 꺼지면 함께 skip 된다
                bad,
                { id: 'run', type: 'command', command: '${safe.value ?? bad.value} -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '전이적으로 skip 될 수 있는 대안에서 체인을 끝냈다');

            // bare QuickPick은 이제 `.value` 축약이므로 사라질 수 있는 일반 task
            // 대안과 같다. 뒤의 위험한 대안도 fail-closed로 검사한다.
            assert.ok(chain([safe, bad], '${safe ?? bad.value} -c "echo ${ask.value}"'),
                'bare QuickPick value 뒤의 대안을 놓쳤다');
            // 대표 결과가 없는 bare task는 결과 객체 자체로 체인을 끝낸다. 값은
            // 문자열 실행 파일이 아니므로 뒤 대안을 펼치면 없는 위험을 만든다.
            assert.ok(!chain([{ id: 'pick', type: 'fileDialog' }, bad],
                '${pick ?? bad.value} -c "echo ${ask.value}"'),
                '대표값 없는 bare 참조가 끊은 체인의 뒤 대안을 펼쳤다');

            // **자기 자신은 예외다.** 태스크가 도는 시점에 그 결과는 아직 문맥에 없어
            // bare 든 키든 풀리지 않고 다음 대안으로 넘어간다 — "존재하는 태스크" 라는
            // 이유로 체인을 끊으면 뒤의 진짜 인터프리터를 놓친다.
            for (const ref of ['${run ?? bad.value}', '${run.value ?? bad.value}']) {
                assert.ok(codes(withTasks([
                    bad,
                    { id: 'ask', type: 'inputBox', prompt: '?' },
                    { id: 'run', type: 'command', command: `${ref} -c "echo \${ask.value}"` },
                ])).includes('command.nested-interpreter'), `자기 참조에서 체인을 끊었다: ${ref}`);
            }
        });

        test('낼 수 없는 키는 시뮬레이션 한곳으로 판정한다', () => {
            // 키 목록을 열거 쪽에 따로 적어 두면 `variable.unresolved` 를 내는 판정과
            // 어긋난다 — `inputBox` 는 `value` 만 내므로 `${input.typo}` 는 절대 실행
            // 파일이 되지 않는데, "모르는 것" 으로 분류돼 fail-closed 경로를 타고
            // 가짜 인터프리터 경고가 됐다.
            for (const source of [
                { id: 'src', type: 'inputBox', prompt: '?' },
                { id: 'src', type: 'quickPick', itemsFromCommand: 'ls' },
                { id: 'src', type: 'confirm', message: '?' },
            ]) {
                const found = codes(withTasks([
                    source,
                    { id: 'ask', type: 'inputBox', prompt: '?' },
                    { id: 'run', type: 'command', command: '${src.typo} -c "echo ${ask.value}"' },
                ]));
                assert.ok(!found.some(c => c.startsWith('command.')),
                    `낼 수 없는 키에 인터프리터 진단을 얹었다 (${source.type}): ${found.join(', ')}`);
                assert.ok(found.includes('variable.unresolved'), found.join(', '));
            }

            // **낼 수 있는 키는 종전대로 fail-closed** — 열거만 못 할 뿐 값은 난다.
            for (const [source, key] of [
                [{ id: 'src', type: 'inputBox', prompt: '?' }, 'value'],
                [{ id: 'src', type: 'quickPick', itemsFromCommand: 'ls' }, 'value'],
            ] as Array<[any, string]>) {
                assert.ok(codes(withTasks([
                    source,
                    { id: 'ask', type: 'inputBox', prompt: '?' },
                    { id: 'run', type: 'command', command: `\${src.${key}} -c "echo \${ask.value}"` },
                ])).includes('command.nested-interpreter'), `낼 수 있는 키가 조용해졌다 (${source.type})`);
            }
        });

        test('스위치가 참조로 정해져도 알아본다', () => {
            assert.ok(codes(withTasks([
                { id: 'flag', type: 'quickPick', items: ['-c'] },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh ${flag.value} "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'));
        });

        test('열거할 수 없는 실행 파일 뒤의 참조는 스크립트 후보다', () => {
            // 무엇이 실행될지 모르면 뒤따르는 참조가 전부 스크립트에 놓일 수 있다 —
            // 제약이 없으면 구체적인 주입 경고가 붙는다.
            const found = codes(withTasks([
                { id: 'pick', type: 'inputBox', prompt: 'exe?' },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: '${pick.value} -c "echo ${ask.value}"' },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${found.join(', ')}`);
        });

        test('값이 제약돼 있어도 무엇이 실행될지 모르면 알린다', () => {
            // 값이 제약돼 주입 경고까지는 아니지만, 실행 파일이 미지수라는 사실은
            // 알린다 — 셸로 풀리면 그 값이 스크립트 텍스트가 되는 자리다.
            const found = codes(withTasks([
                { id: 'pick', type: 'inputBox', prompt: 'exe?' },
                { id: 'ask', type: 'inputBox', prompt: 'v?', validatePattern: '^[A-Za-z]+$' },
                { id: 'run', type: 'command', command: '${pick.value} -c "echo ${ask.value}"' },
            ]));
            assert.ok(found.includes('command.dynamic-interpreter'), `놓쳤다: ${found.join(', ')}`);
            assert.ok(!found.includes('command.nested-interpreter'), '제약된 값에 주입 경고까지 붙였다');
        });

        test('흘러들 값이 없으면 실행 파일이 미지수여도 조용하다', () => {
            const found = codes(withTasks([
                { id: 'pick', type: 'inputBox', prompt: 'exe?' },
                { id: 'run', type: 'command', command: '${pick.value} -c "echo fixed"' },
            ]));
            assert.ok(!found.some(c => c.startsWith('command.')), `과하게 경고했다: ${found.join(', ')}`);
        });

        test('고정 실행 파일이면 dynamic 경고를 붙이지 않는다', () => {
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'node -e "console.log(1)"', args: ['${ask.value}'] },
            ])).includes('command.dynamic-interpreter'));
        });

        test('sh -c 는 다음 인자 하나만 스크립트다 — 권장 완화책을 오진하지 않는다', () => {
            // `sh -c '스크립트' _ "$값"` 은 값이 **인자**로 전달되는 안전한 형태이고
            // 우리가 문서에서 권하는 회피책이다. 뒤를 전부 이어 붙이면 여기에
            // 경고가 붙어, 사용자가 올바로 고쳐도 경고가 사라지지 않는다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                {
                    id: 'run', type: 'command', command: 'sh',
                    args: ['-c', 'printf \'%s\\n\' "$1"', '_', '${ask.value}'],
                },
            ])).includes('command.nested-interpreter'), '안전한 argv 전달을 주입으로 봤다');

            // 값이 스크립트 자리에 있으면 여전히 경고한다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh', args: ['-c', 'echo ${ask.value}'] },
            ])).includes('command.nested-interpreter'));
        });

        test('cmd /c 는 나머지 전부가 스크립트다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'cmd', args: ['/c', 'echo', '${ask.value}'] },
            ])).includes('command.nested-interpreter'), 'cmd 는 뒤 인자도 명령줄로 재해석한다');
        });

        test('후보가 상한에 걸려 잘리면 조용해지지 않는다 (fail-closed)', () => {
            // 33번째 후보가 `sh` 인 경우. 비용 때문에 잘랐다는 이유로 경고가
            // 사라지면, 잘린 쪽에 셸이 있었을 때 그대로 뚫린다.
            const many = Array.from({ length: 32 }, (_, i) => `tool${i}`).concat('sh');
            const found = codes(withTasks([
                { id: 'which', type: 'quickPick', items: many },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: '${which.value} -c "echo ${ask.value}"' },
            ]));
            assert.ok(
                found.includes('command.dynamic-interpreter') || found.includes('command.nested-interpreter'),
                `상한에 걸려 조용해졌다: ${found.join(', ')}`
            );
        });

        test('안전한 후보가 섞여 있어도 위험한 후보를 묻지 않는다', () => {
            // `['node','sh']` 중 sh 로 풀리면 스위치가 미지수인 위험한 형태다.
            const found = codes(withTasks([
                { id: 'which', type: 'quickPick', items: ['node', 'sh'] },
                { id: 'flag', type: 'inputBox', prompt: 'flag?' },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: '${which.value} ${flag.value} "echo ${ask.value}"' },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `묻혔다: ${found.join(', ')}`);
        });

        test('플래그가 여럿 끼어 스위치가 뒤로 밀려도 본다', () => {
            const found = codes(withTasks([
                { id: 'flag', type: 'inputBox', prompt: 'flag?' },
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh -x -e -u ${flag.value} "echo ${ask.value}"' },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `앞자리만 봤다: ${found.join(', ')}`);
        });

        test('스크립트 파일 뒤의 -c 는 인터프리터 스위치가 아니다', () => {
            // `sh /dev/null -c "…"` 는 /dev/null 을 실행하고 `-c` 는 위치 인자다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh /dev/null -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '실행되지도 않는 문자열에 경고를 냈다');
        });

        test('인자를 받는 옵션(-o nounset) 뒤의 -c 는 여전히 스위치다', () => {
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh -o nounset -c "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'));
        });

        test('스크립트 자리의 참조는 펼치지 않는다 — 펼치면 경고가 사라진다', () => {
            // argv 전체를 펼치면 스크립트의 `${pick.value}` 가 구체값으로 바뀌어
            // `${…}` 검사를 통과하지 못하고, 메타문자가 든 quickPick 이 **무경고로**
            // 지나간다. 제어 토큰(실행 파일·옵션)만 펼쳐야 한다.
            const found = codes(withTasks([
                { id: 'pick', type: 'quickPick', items: ['echo ok', 'echo pwned; id'] },
                { id: 'run', type: 'command', command: 'sh -c ${pick.value}' },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `스크립트를 펼쳐 경고가 사라졌다: ${found.join(', ')}`);
        });

        test('데이터 토큰의 조합 폭발이 가짜 dynamic 경고를 만들지 않는다', () => {
            // 선택지 2개짜리 인자 6개 = 64조합. 실행 파일은 `node` 로 고정인데
            // 상한에 걸렸다는 이유로 "동적 인터프리터" 라고 하면 안 된다.
            const picks = Array.from({ length: 6 }, (_, i) => ({
                id: `p${i}`, type: 'quickPick', items: ['a', 'b'],
            }));
            const args = picks.map(p => `\${${p.id}.value}`);
            const found = codes(withTasks([
                ...picks,
                { id: 'run', type: 'command', command: 'node', args: ['-e', 'x', ...args] },
            ]));
            assert.ok(!found.includes('command.dynamic-interpreter'), `데이터 조합으로 오탐했다: ${found.join(', ')}`);
        });

        test('스크립트 파일 뒤의 위치 인자는 인터프리터 자리가 아니다', () => {
            const found = codes(withTasks([
                { id: 'arg', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh /dev/null ${arg.value}' },
            ]));
            assert.ok(!found.includes('command.dynamic-interpreter'), `위치 인자를 스위치로 봤다: ${found.join(', ')}`);
        });

        test('인자를 받는 옵션 여러 형태 뒤의 스위치를 찾는다', () => {
            for (const command of [
                'bash --rcfile /dev/null -c "echo ${ask.value}"',
                'bash -O extglob -c "echo ${ask.value}"',
                'sh +o nounset -c "echo ${ask.value}"',
                'powershell -ExecutionPolicy Bypass -Command "echo ${ask.value}"',
            ]) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'v?' },
                        { id: 'run', type: 'command', command },
                    ])).includes('command.nested-interpreter'),
                    `놓쳤다: ${command}`
                );
            }
        });

        test('동적 스위치 뒤의 스크립트 참조를 펼치지 않는다', () => {
            // 스위치가 참조면 그것이 `-c` 일 수 있고, 그러면 다음 토큰부터가
            // 스크립트다. 스위치를 열거하며 스크립트까지 구체화하면 이후 참조
            // 검사에 아무것도 남지 않아 무경고가 된다.
            for (const exe of ['sh', 'cmd', 'pwsh']) {
                const found = codes(withTasks([
                    { id: 'flag', type: 'quickPick', items: exe === 'cmd' ? ['/c'] : ['-c'] },
                    { id: 'script', type: 'quickPick', items: ['echo ok', 'echo pwned; id'] },
                    { id: 'run', type: 'command', command: `${exe} \${flag.value} \${script.value}` },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `${exe}: 놓쳤다 (${found.join(', ')})`);
            }
        });

        test('PowerShell 의 두 설정을 모두 본다', () => {
            // `-EncodedCommand` 와 `-Command` 는 별도 항목이라, 첫 항목만 보면
            // `-Command` 를 스위치로 알지 못하고 스크립트를 놓친다.
            const found = codes(withTasks([
                { id: 'pick', type: 'quickPick', items: ['Write-Output ok', 'Write-Output pwned; id'] },
                { id: 'run', type: 'command', command: 'powershell -Command ${pick.value}' },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${found.join(', ')}`);
        });

        test('표에 없는 옵션 문법에서도 조용해지지 않는다', () => {
            for (const command of [
                'sh -xo nounset -c "echo ${ask.value}"',
                'cmd /k echo ${ask.value}',
                'pwsh -WorkingDirectory /tmp -Command "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }
        });

        test('묶음 옵션 안의 `-c` 는 위치를 정확히 따진다', () => {
            // `^-[a-z]*c$` 로 보던 동안 `c` 가 마지막이 아닌 묶음을 통째로
            // 놓쳤다 — 실제 셸은 묶음 어디에 있든 `c` 를 옵션으로 읽는다.
            // (`sh -cx "…"` · `bash -cex "…"` 가 스크립트를 실행하는 것을
            // 확인했다.) `-co nounset "…"` 은 `o` 가 인자를 먼저 삼켜
            // 스크립트가 한 칸 밀린다.
            for (const command of [
                'sh -cx "echo ${ask.value}"',
                'bash -cex "echo ${ask.value}"',
                'sh -co nounset "echo ${ask.value}"',
                'bash -cO extglob "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }
        });

        test('`-c` 뒤에 옵션이 더 와도 첫 피연산자가 스크립트다', () => {
            // POSIX 셸의 `-c` 는 **다음 argv 를 삼키는 옵션이 아니다** — 옵션을
            // 다 읽은 뒤 첫 피연산자가 command_string 이다. "스위치 바로 다음이
            // 스크립트" 로 보면 아래 형태를 전부 놓친다 (넷 다 실제 `/bin/sh` ·
            // `bash` 에서 스크립트가 실행되는 것을 확인했다).
            for (const command of [
                'sh -cex -c "echo ${ask.value}"',
                'bash -cx -O extglob "echo ${ask.value}"',
                'sh -c -o nounset -e "echo ${ask.value}"',
                'bash -c -- "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }
        });

        test('스크립트 뒤의 위치 인자는 스크립트가 아니다', () => {
            // 권장 완화책(`sh -c '고정 스크립트' _ "${ask.value}"`)의 값은 `$1`
            // 이지 스크립트가 아니다. 피연산자 하나만 스크립트로 본다.
            assert.deepStrictEqual(
                scriptCandidateTokens(['sh', '-cx', 'printf %s "$1"', '_', '${ask.value}']),
                { tokens: [], certain: true }
            );
        });

        test('참조가 든 비옵션 토큰을 동적 스위치로 보지 않는다', () => {
            // `echo ${ask.value}` 는 값이 무엇이든 옵션이 아니라 피연산자다.
            // 그것을 "스위치일 수 있다"고 보면 **그 토큰 자신의 참조**가 후보에서
            // 빠져, `-cx` 처럼 스위치를 놓친 경우에 경고가 통째로 사라졌다.
            const { tokens, certain } = scriptCandidateTokens(['sh', '-cx', 'echo ${ask.value}']);
            assert.deepStrictEqual(tokens, ['echo ${ask.value}']);
            assert.strictEqual(certain, true);

            // 피연산자(스크립트 파일 이름) 뒤는 위치 인자다 — 그 뒤 참조를
            // 스크립트 후보로 끌어오면 안 된다.
            assert.deepStrictEqual(
                scriptCandidateTokens(['sh', 'run ${a.value}', '${b.value}']),
                { tokens: [], certain: true }
            );
        });

        test('제약된 값이라도 **명령 자리**면 면제하지 않는다', () => {
            // 문자 집합만 보는 면제의 근본 구멍이다 — 권장 패턴을 통과한
            // `whoami` 는 메타문자가 하나도 없지만, 자리가 명령이면 그대로
            // 실행된다(`sh -c 'echo ok; whoami'`).
            const SAFE = '^[A-Za-z0-9_][A-Za-z0-9_-]*$';
            for (const command of [
                'sh -c "echo ok; ${ask.value}"',
                'sh -c "echo ok && ${ask.value}"',
                'sh -c "true | ${ask.value}"',
                'sh -c "${ask.value}"',
                'sh -c "echo $(${ask.value})"',
                'sh -c "eval ${ask.value}"',
                'sh -c "cat > ${ask.value}"',
                // 대상이 붙어 와도 리다이렉션이다 — 임의의 파일을 읽고 쓴다.
                'sh -c "echo ok >out/${ask.value}"',
                'sh -c "cat <in/${ask.value}"',
                // 연산자가 **떨어져 있고** 대상 낱말에 prefix 가 붙은 형태. 대상은
                // 낱말 전체이므로 참조가 그 안 어디에 있든 리다이렉션이다.
                'sh -c "echo ok > out/${ask.value}"',
                'sh -c "cat < in/${ask.value}"',
                'sh -c "echo ok 2> logs/${ask.value}"',
                'sh -c "echo ok >> logs/${ask.value}"',
                'sh -c "echo ok > out/${ask.value}.log"',
                // 연산자 소비를 옮긴 것은 dialect 를 가리지 않는다.
                'cmd /c echo ok > out/${ask.value}',
                'pwsh -Command "Write-Output ok > out/${ask.value}"',
                // **낱말 중간에서 시작하는 리다이렉션.** 셸은 공백이 없어도 `>` 를
                // 연산자로 읽어 `echo prefix>out/x` 를 `out/x` 에 쓴다. 낱말의
                // 시작만 보던 동안 값이 `../../target` 이면 의도한 디렉터리 밖
                // 파일을 대상으로 삼을 수 있었다.
                'sh -c "echo prefix>out/${ask.value}"',
                'sh -c "echo prefix>>logs/${ask.value}"',
                'sh -c "echo prefix<in/${ask.value}"',
                'sh -c "echo prefix2>err/${ask.value}"',
                'sh -c "echo prefix>${ask.value}"',
                // 연산자를 글자마다 끊으면 `>>` 의 두 번째 `>` 가 첫 번째의
                // **대상**으로 읽혀 추적이 끊긴다. 한 덩어리로 모아야 한다.
                'sh -c "echo ok >> logs/${ask.value}"',
                'sh -c "echo ok >& ${ask.value}"',
                'sh -c "echo ok 2>&1 >> logs/${ask.value}"',
                // 참조가 연산자 **바로 뒤**에 붙는 경계.
                'sh -c "echo x>${ask.value}"',
                // `<>`(읽기·쓰기 열기)도 리다이렉션이다 — 표에 없어 놓쳤다.
                'sh -c "cat <> out/${ask.value}"',
                'sh -c "cat 3<>rw/${ask.value}"',
                // **선행 FD 리다이렉션 뒤는 명령 이름 자리다.** 연산자에 붙은 숫자는
                // IO number 라 낱말을 끊으면 안 된다 — `2` 를 고정 명령 머리로
                // 확정하면 실제로 실행되는 `${v}` 가 인자로 분류돼 면제된다.
                'sh -c "2>out ${ask.value}"',
                'sh -c "2>&1 ${ask.value}"',
                'sh -c "2> out ${ask.value}"',
                'sh -c "1>out ${ask.value}"',
                'sh -c "2>/dev/null ${ask.value}"',
                'sh -c "3<in ${ask.value}"',
                // 붙어 있는 연산자 뒤로 세그먼트가 이어져도 구분자는 살아 있다.
                'sh -c "echo x >out && ${ask.value}"',
                // **대입은 안전한 자리가 아니다.** 자리만으로는 그 값이 뒤에서
                // `$TAG` 로 실행되지 않는다는 것을 증명할 수 없다
                // (`sh -c "CMD=${v}; $CMD"` 는 실제로 실행된다).
                'sh -c "TAG=${ask.value}; echo done"',
                'sh -c "CMD=${ask.value}; $CMD"',
                'sh -c "A=1 B=${ask.value} echo ok"',
                // 인자를 코드로 읽는 명령·문법.
                'bash -c "trap ${ask.value} EXIT"',
                'bash -c "coproc ${ask.value}; wait"',
                // `time`·`coproc` 은 명령 **앞에 토큰이 더 올 수 있다**. "다음 낱말이
                // 명령" 규칙으로 보면 `-p`·`NAME` 을 고정 명령 이름으로 잡고 값을
                // 인자로 오인한다 — 둘 다 실제로 값이 실행되는 자리다.
                'sh -c "time -p ${ask.value}"',
                'bash -c "coproc NAME ${ask.value}"',
                'sh -c "time ${ask.value}"',
                'sh -c "time -p -- ${ask.value}"',
                // 예약어 뒤도 명령 자리다 — 구분자만 보면 데이터로 오인한다.
                'sh -c "if true; then ${ask.value}; fi"',
                'sh -c "for i in 1; do ${ask.value}; done"',
                // 명령 이름 앞에 오는 대입·리다이렉션을 명령으로 오인하면 안 된다.
                'sh -c "A=1 ${ask.value}"',
                'sh -c "> /tmp/out ${ask.value}"',
                'sh -c ">/tmp/out ${ask.value}"',
                // 경로가 붙어도 같은 명령이다 — 이름만 비교하면 놓친다.
                'sh -c "/usr/bin/env ${ask.value}"',
                // **이름을 흩어 놓아도 셸에게는 같은 명령이다.** 인용·이스케이프를
                // 걷어 내지 않으면 목록 비교를 그대로 빠져나간다. POSIX 에서 `\` 는
                // 경로 구분자가 아니라 이스케이프라, 경로처럼 자르면 `e\val` 이
                // `val` 이 되어 `eval` 과 맞지 않았다.
                'sh -c "e\\\\val ${ask.value}"',
                'sh -c "ev\'\'al ${ask.value}"',
                'sh -c "tr\\\\ap ${ask.value} EXIT"',
                'sh -c "\\"eval\\" ${ask.value}"',
                // 머리가 **실행 시점에 정해지면** 무엇이 될지 모른다 — `eval` 일 수도
                // 있으므로 고정 리터럴 명령으로 보면 안 된다(fail-closed).
                'sh -c "CMD=eval; $CMD ${ask.value}"',
                'sh -c "$TOOL ${ask.value}"',
                'cmd /c %TOOL% ${ask.value}',
                // 큰따옴표 안에서도 확장은 살아 있다.
                'sh -c "\\"$CMD\\" ${ask.value}"',
                // brace expansion · glob 도 이름을 바꾼다 — 셸에게는 전부 `eval` 이다.
                'bash -c "e{v,v}al ${ask.value}"',
                'sh -c "/bin/e*al ${ask.value}"',
                // `\\` + 개행은 글자를 남기지 않는 **행 잇기**다.
                'sh -c "e\\\nval ${ask.value}"',
                // 치환에 이어 붙은 조각도 이름의 일부다.
                'sh -c "$(echo ev)al ${ask.value}"',
                'sh -c "`echo ev`al ${ask.value}"',
                'sh -c "e$(echo val) ${ask.value}"',
                'sh -c "x$(echo hi) foo ${ask.value}"',
                'sh -c "x`echo hi` foo ${ask.value}"',
                // **중첩된 치환에서도 짝이 맞아야 한다.** 플래그 하나로 "낱말 안에서
                // 열렸다"만 기억하면 안쪽 `)`·백틱이 그것을 지워 바깥 낱말이 다시
                // 리터럴로 읽힌다 — 실제로는 `sh -c` 가 되어 값이 실행된다.
                'sh -c "s$(echo h) -c ${ask.value}"',
                'sh -c "s$(echo $(echo h)) -c ${ask.value}"',
                'sh -c "x$(echo `true`) foo ${ask.value}"',
                'sh -c "x$( (true) ) foo ${ask.value}"',
                // **그룹 `( … )` 은 낱말을 만들지 않는다.** 닫을 때 바깥 명령을
                // 되살리면 `do` 가 앞 명령의 인자로 읽혀 뒤가 통째로 면제된다.
                'cmd /c "for %f in (a b) do ${ask.value}"',
                'cmd /c "for %f in (a b) do call ${ask.value}"',
                'cmd /c "for /f %i in (list.txt) do ${ask.value}"',
                'sh -c "case x in (x) ${ask.value};; esac"',
                'sh -c "case x in x) ${ask.value};; esac"',
                // **`"$(…)"` 의 닫는 `)` 도 큰따옴표 안이다.** 거기서 프레임을 닫지
                // 않으면 바깥 머리(`eval`)를 되찾지 못하고, 남은 프레임을 나중의
                // 무관한 `)` 가 꺼내 엉뚱한 상태로 되돌린다.
                'sh -c "eval \\"$(true)\\" ${ask.value}"',
                'sh -c "case \\"$(uname)\\" in Darwin) ${ask.value};; esac"',
                'sh -c "echo \\"$(date)\\"; case x in x) ${ask.value};; esac"',
                'sh -c "eval $(true) ${ask.value}"',
                'sh -c "$(echo eval) ${ask.value}"',
                // **치환 안은 인용이 새로 시작한다.** 바깥 `"` 를 물려주면 안쪽
                // `(true)` 의 `)` 가 바깥 `$(` 를 닫은 것으로 오인돼, 그 뒤 `eval` 이
                // 사라지고 값이 면제된다.
                'sh -c "echo \\"$( (true); eval ${ask.value} )\\""',
                'sh -c "echo \\"$(eval ${ask.value})\\""',
                // 고정 명령이라도 **이 옵션 뒤부터는** 인자가 코드·변수다.
                'sh -c "find . -maxdepth 0 -exec ${ask.value} \\;"',
                'sh -c "find . -execdir ${ask.value} \\;"',
                'sh -c "find . -ok ${ask.value} \\;"',
                'bash -c "printf -v CMD %s ${ask.value}; $CMD"',
                // **CRLF 행 잇기**도 세 글자 한 덩어리다 — `\\r` 만 먹고 `\\n` 을
                // 남기면 그 개행이 명령 구분자가 되어 낱말이 갈린다.
                'pwsh -Command "i`\r\nex ${ask.value}"',
                'sh -c "e\\\r\nval ${ask.value}"',
                // PowerShell 의 이스케이프는 백틱이다 — `i`ex` 는 `iex` 다.
                'pwsh -Command "i`ex ${ask.value}"',
                // **PowerShell 의 `{` 는 붙어 있어도 스크립트 블록**이고 그 안은
                // 코드다. POSIX 의 brace expansion 규칙을 그대로 적용해 낱말로
                // 묶으면 바깥 명령이 머리로 남아 값이 인자로 면제된다.
                'pwsh -Command "Invoke-Command -ScriptBlock {iex ${ask.value}}"',
                'pwsh -Command "1..3 | ForEach-Object {iex ${ask.value}}"',
                'powershell -Command "if ($true) {Invoke-Expression ${ask.value}}"',
                // 행 잇기는 dialect 를 가리지 않는다 — 셸마다 이스케이프 글자만 다르다.
                'pwsh -Command "i`\nex ${ask.value}"',
                'cmd /c "c^\nall ${ask.value}"',
                // `.exe` 를 떼고 비교한다.
                'cmd /c C:\\Windows\\System32\\cmd.exe ${ask.value}',
                // **대입 빌트인**을 거친 값도 다음 명령이 된다.
                'sh -c "export CMD=${ask.value}; $CMD"',
                'bash -c "declare CMD=${ask.value}; $CMD"',
                'sh -c "readonly CMD=${ask.value}; $CMD"',
                'bash -c "typeset CMD=${ask.value}; $CMD"',
                'bash -c "local CMD=${ask.value}; $CMD"',
                'sh -c "set -- ${ask.value}"',
                // 독립된 `{` 는 그룹 경계가 맞다 — 그 뒤는 명령 자리다.
                'sh -c "{ ${ask.value}; }"',
                'pwsh -Command "Write-Output ok; ${ask.value}"',
                'cmd /c echo ok & ${ask.value}',
                // `cmd` 는 `%NAME%` 를 치환한 **뒤** 다시 해석한다 — 이름이
                // 안전해도 그 값에 `&` 가 있으면 명령이 된다(`envPick` 과 같은 위험).
                'cmd /c echo %${ask.value}%',
                'cmd /v:on /c echo !${ask.value}!',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: SAFE },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `명령 자리를 데이터로 봤다: ${command} (${found.join(', ')})`);
            }

            // 고정된 명령 이름 뒤의 **인자** 자리는 그대로 면제한다 — 그러지
            // 않으면 문서가 권하는 완화책에 경고가 붙는다.
            for (const command of [
                'sh -c "echo ${ask.value}"',
                'sh -c "git checkout ${ask.value}"',
                'cmd /c echo ${ask.value}',
                'pwsh -Command "Write-Output ${ask.value}"',
                'sh -c "if true; then echo ${ask.value}; fi"',
                'sh -c "echo x > /tmp/out ${ask.value}"',
                // 대상이 **붙어서** 이미 끝난 리다이렉션 뒤는 평범한 인자다.
                // 연산자 소비를 `headFound` 앞으로 옮기면서 깨지기 쉬운 자리다.
                'sh -c "echo x >/tmp/out ${ask.value}"',
                // 인용된 연산자는 데이터다 — 인용 안의 `>` 는 낱말을 가르지 않는다.
                'sh -c "echo \'>\' ${ask.value}"',
                'sh -c "echo \'a>b\' ${ask.value}"',
                'sh -c "echo \\"a>b\\" ${ask.value}"',
                // 이스케이프된 `\\b` 는 `b` 일 뿐 — 재해석 명령이 아니다.
                'sh -c "echo a\\\\bc ${ask.value}"',
                // 경로가 붙은 평범한 명령은 dialect 별 구분자로 갈라 이름만 본다.
                'sh -c "/usr/bin/git checkout ${ask.value}"',
                'cmd /c C:\\Windows\\System32\\find.exe ${ask.value}',
                // **POSIX 의 `\\` 는 경로 구분자가 아니라 이스케이프다.** 경로처럼
                // 자르면 `x\\eval` 의 끝 조각 `eval` 이 재해석 명령으로 읽힌다 —
                // 실제로는 `xeval` 이라는 다른 명령이다.
                'sh -c "x\\eval ${ask.value}"',
                // 작은따옴표·이스케이프는 확장을 죽인다 — 동적 머리가 아니다.
                'sh -c "\'$CMD\' ${ask.value}"',
                'sh -c "\\$CMD ${ask.value}"',
                // brace expansion 이 **인자**에 있으면 머리는 그대로 `echo` 다.
                // `{`·`}` 를 무조건 세그먼트 구분자로 보던 동안 여기서 세그먼트가
                // 초기화돼 값이 명령 자리로 **오탐**됐다.
                'sh -c "echo a{b,c} ${ask.value}"',
                'sh -c "echo a{b,c}d ${ask.value}"',
                'sh -c "ls *.txt ${ask.value}"',
                // 그룹 안이라도 고정 명령 뒤는 인자다.
                'sh -c "{ echo ${ask.value}; }"',
                // **치환이 끝나면 바깥 명령으로 돌아온다.** 닫는 자리에서 세그먼트를
                // 초기화하던 동안 `echo` 가 사라져 뒤의 값이 명령 자리로 오탐됐다.
                'sh -c "echo $(date +%Y) ${ask.value}"',
                'sh -c "echo `true` ${ask.value}"',
                'sh -c "echo $(basename $(pwd)) ${ask.value}"',
                // 가장 흔한 실제 형태 — 큰따옴표로 감싼 치환 뒤의 인자.
                'sh -c "echo \\"$(date)\\" ${ask.value}"',
                // 치환 **안**도 고정 명령 뒤면 인자다. 바깥 인용을 물려주면 여기에
                // 과탐이 붙는다(닫는 `)` 를 못 찾아 머리를 잃는다).
                'sh -c "echo \\"$(printf %s ${ask.value})\\""',
                // `find` 라도 `-exec` 류가 없으면 종전대로 인자다.
                'sh -c "find /tmp -maxdepth 0 -name ${ask.value}"',
                // `cmd` 에는 중괄호 문법이 없다 — 평범한 글자다.
                'cmd /c echo {x} ${ask.value}',
                // PowerShell 의 `( … )` 는 값을 내는 부분식이라 바깥 명령이 이어진다.
                'pwsh -Command "Write-Output (Get-Date) ${ask.value}"',
                // 리다이렉션 **대상**이 아니라 그 앞의 인자다.
                'sh -c "echo ${ask.value} > out"',
                // 인용된 구분자는 데이터다 — 인용 상태를 안 보면 여기에 경고가 붙는다.
                'sh -c "echo \\"x; ${ask.value}\\""',
                // 참조 **한쪽에만** 확장 구분자가 있으면 확장 안이 아니다.
                'cmd /c echo %PATH% ${ask.value}',
                'cmd /c echo ${ask.value} %PATH%',
                'cmd /v:on /c echo !PATH! ${ask.value}',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: SAFE },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(!found.includes('command.nested-interpreter'), `데이터 자리에 경고했다: ${command} (${found.join(', ')})`);
            }
        });

        test('인자 자리라도 값이 `-` 로 시작할 수 있으면 면제하지 않는다', () => {
            // `find … ${v} id \;` 에 `-exec` 를 넣으면 인자가 옵션이 되어 명령이
            // 실행된다. 문자 집합만 좁혀서는 막지 못한다.
            const command = 'sh -c "find /tmp -maxdepth 0 ${ask.value} id \\;"';
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_-]+$' },
                { id: 'run', type: 'command', command },
            ])).includes('command.nested-interpreter'), '선행 `-` 를 허용하는 패턴을 면제했다');

            // 첫 글자를 막은 패턴은 면제한다 — 문서가 권하는 형태다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_][A-Za-z0-9_-]*$' },
                { id: 'run', type: 'command', command },
            ])).includes('command.nested-interpreter'), '첫 글자를 막았는데 경고했다');

            // `--` 뒤라면 옵션으로 읽히지 않는다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_-]+$' },
                { id: 'run', type: 'command', command: 'sh -c "grep -- ${ask.value} file"' },
            ])).includes('command.nested-interpreter'), '`--` 뒤인데 경고했다');

            // **`--` 앞에 옵션이 있으면 그 `--` 를 믿을 수 없다.** `curl -o -- x` 는
            // `-o` 가 `--` 를 출력 파일 이름으로 삼켜, 값이 다시 옵션이 된다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^--version$' },
                { id: 'run', type: 'command', command: 'sh -c "curl -o -- ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '옵션이 삼킨 `--` 를 믿었다');

            // 고정 목록도 마찬가지다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'quickPick', items: ['ok', '--version'] },
                { id: 'run', type: 'command', command: 'sh -c "git tag ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '`-` 로 시작하는 항목을 면제했다');

            // **중괄호는 안전한 문자가 아니다.** PowerShell 에서 `{…}` 는 스크립트
            // 블록이라 그 안이 곧 코드다 — 고정 목록 quickPick 하나로 명령이 실행된다.
            for (const command of [
                'pwsh -Command "Invoke-Command -ScriptBlock ${ask.value}"',
                'pwsh -Command "Start-Job -ScriptBlock ${ask.value}"',
                'pwsh -Command "ForEach-Object ${ask.value}"',
                'pwsh -Command "Where-Object ${ask.value}"',
                // 목록에 없는 cmdlet 이라도 `-ScriptBlock` 류 매개변수 뒤는 코드다.
                'pwsh -Command "Register-ObjectEvent -Action ${ask.value}"',
                'pwsh -Command "Some-Cmdlet -ScriptBlock ${ask.value}"',
                // PowerShell 은 매개변수 이름을 접두사로 맞춘다.
                'pwsh -Command "Invoke-Command -Scr ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'quickPick', items: ['{whoami}'] },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'),
                    `ScriptBlock 주입을 데이터로 봤다: ${command} (${found.join(', ')})`);
            }

            // **이름 있는 매개변수의 값은 데이터다.** cmdlet 전체를 sink 로 두면
            // `-ComputerName ${host}` 같은 평범한 인자까지 경고가 붙는다.
            for (const command of [
                'pwsh -Command "Invoke-Command -ComputerName ${ask.value} -ScriptBlock { Get-Date }"',
                'pwsh -Command "Start-Job -Name ${ask.value} -ScriptBlock { Get-Date }"',
                'pwsh -Command "Write-Output ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'quickPick', items: ['server1'] },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(!found.includes('command.nested-interpreter'),
                    `데이터 매개변수에 경고했다: ${command} (${found.join(', ')})`);
            }

            // 데이터 매개변수가 앞에 와도 스크립트 자리는 그대로 잡는다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'quickPick', items: ['{whoami}'] },
                { id: 'run', type: 'command', command: 'pwsh -Command "Invoke-Command -ComputerName h -ScriptBlock ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '데이터 뒤의 스크립트 자리를 놓쳤다');

        });

        test('빈 문자열이 될 수 있는 그룹으로 첫 글자 검사를 우회하지 못한다', () => {
            // `^(ok|)-exec$` 는 `-exec` 를 통과시킨다 — 그룹이 `-` 로 시작하는지만
            // 보고 **그룹이 비워질 수 있는지**를 안 보면 그대로 새어 나간다.
            for (const validatePattern of [
                '^(ok|)-exec$', '^([a-z]*)-exec$', '^(a)?-exec$', '^[a-z]{0,3}-x$',
                // lazy 표시를 수량자와 함께 삼키지 않으면 그 `?` 가 다음 원자로
                // 읽혀 "`-` 로 시작할 수 없다" 가 된다.
                '^[a-z]*?-exec$', '^(ok|)??-exec$', '^[a-z]{0,3}?-exec$',
            ]) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: '?', validatePattern },
                        { id: 'run', type: 'command', command: 'sh -c "find /tmp -maxdepth 0 ${ask.value} id \\;"' },
                    ])).includes('command.nested-interpreter'),
                    `빈 그룹으로 우회했다: ${validatePattern}`
                );
            }

            // 반대로 절대 나타나지 않는 그룹(`{0}`)까지 위험으로 보지는 않는다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^(-x){0}[a-z]+$' },
                { id: 'run', type: 'command', command: 'sh -c "find /tmp -maxdepth 0 ${ask.value} id \\;"' },
            ])).includes('command.nested-interpreter'), '나타나지 않는 그룹을 위험으로 봤다');
        });

        test('cmd 의 `if` 조건 뒤는 명령 자리다', () => {
            for (const command of [
                'cmd /c if 1==1 ${ask.value}',
                'cmd /c if exist NUL ${ask.value}',
                'cmd /c if defined PATH ${ask.value}',
                'cmd /c if errorlevel 1 ${ask.value}',
                'cmd /c if not exist NUL ${ask.value}',
                'cmd /c if /i a==b ${ask.value}',
                // 비교 연산자 형태와 `cmdextversion`, 인용된 경로.
                'cmd /c if 1 EQU 1 ${ask.value}',
                'cmd /c if 1 NEQ 2 ${ask.value}',
                'cmd /c if not 1 LSS 2 ${ask.value}',
                'cmd /c if cmdextversion 1 ${ask.value}',
                'cmd /c if exist "C:\\Program Files" ${ask.value}',
                // 모르는 조건 형태는 fail-closed 다.
                'cmd /c if 1 ZZZ 2 ${ask.value}',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `조건을 명령 이름으로 봤다: ${command} (${found.join(', ')})`);
            }

            // 조건 뒤 명령의 **인자**는 그대로 데이터다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                { id: 'run', type: 'command', command: 'cmd /c if 1==1 echo ${ask.value}' },
            ])).includes('command.nested-interpreter'), '조건 뒤 인자에 경고했다');
        });

        test('cmd 환경변수 이름의 **일부**만 보간해도 2차 확장이다', () => {
            for (const command of [
                'cmd /c echo %PRE${ask.value}%',
                'cmd /v:on /c echo !PRE${ask.value}!',
                'cmd /c echo %VAR:~${ask.value}%',
                'cmd /c echo %${ask.value}SUFFIX%',
                // 앞선 `%A`(FOR 변수)·`%1`(배치 인자)에 홀짝 계산이 뒤집히면 안 된다.
                'cmd /c for %A in (1) do echo %PRE${ask.value}%',
                'cmd /c echo %1 %PRE${ask.value}%',
                'cmd /c echo 100%% %PRE${ask.value}%',
                // **닫는 구분자를 뒤 글자로 판별할 수 없다.** `%PREfoo%1` 의 가운데
                // `%` 는 `%PRE…%` 를 닫는 자리인데, 뒤의 `1` 을 보고 `%1`(배치 인자)
                // 시작으로 빼면 확장을 통째로 놓친다. `%*` · `%%` · `!!` 도 같다.
                'cmd /c echo %PRE${ask.value}%1',
                'cmd /c echo %PRE${ask.value}%*',
                'cmd /c echo %PRE${ask.value}%%',
                'cmd /v:on /c echo !PRE${ask.value}!!',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `확장 안쪽을 데이터로 봤다: ${command} (${found.join(', ')})`);
            }

            // `^` 이스케이프는 여전히 구분자가 아니다 — 참조 뒤에 유효한 구분자가
            // 없으면 확장 안쪽이 아니다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                { id: 'run', type: 'command', command: 'cmd /c echo %PATH% ${ask.value} ^%done' },
            ])).includes('command.nested-interpreter'), '`^%` 를 구분자로 셌다');
        });

        test('참조마다 자기 자리로 판정한다', () => {
            // 자리가 섞이면, 한쪽 자리의 위험이 다른 쪽 값에 옮겨 붙어 안전한
            // 참조에까지 경고가 났다. `--` 앞 참조는 옵션 주입 검사를 받고,
            // 뒤 참조는 받지 않는다.
            assert.ok(!codes(withTasks([
                { id: 'a', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_][A-Za-z0-9_-]*$' },
                { id: 'b', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_-]+$' },
                { id: 'run', type: 'command', command: 'sh -c "echo ${a.value} -- ${b.value}"' },
            ])).includes('command.nested-interpreter'), '`--` 뒤 참조에 앞 참조의 자리를 적용했다');

            // 한쪽만 위험해도 경고는 그대로 난다.
            assert.ok(codes(withTasks([
                { id: 'a', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_][A-Za-z0-9_-]*$' },
                { id: 'b', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_-]+$' },
                { id: 'run', type: 'command', command: 'sh -c "echo ${a.value} ${b.value}"' },
            ])).includes('command.nested-interpreter'), '인자 자리의 선행 `-` 를 놓쳤다');
        });

        test('PowerShell 7.5+ `-CommandWithArgs` 도 스크립트를 연다', () => {
            for (const command of [
                'pwsh -CommandWithArgs "echo ${ask.value}"',
                'pwsh -cwa "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }

            // `-CommandWithArgs` 는 **첫 문자열만** 코드다. 나머지는 `$args` 로
            // 들어가므로 `-Command` 처럼 rest 로 보면 과탐이 된다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'pwsh -CommandWithArgs "echo fixed" ${ask.value}' },
            ])).includes('command.nested-interpreter'), '$args 자리를 스크립트로 봤다');
        });

        test('ksh 는 `-c` 없이도 첫 피연산자를 실행한다', () => {
            // 이 기계의 AT&T ksh93u+ 은 `ksh 'printf x'` 를 그대로 실행한다 —
            // `sh`·`zsh`·`dash` 는 파일 이름으로 읽고 실패하는 자리다.
            for (const command of [
                'ksh "echo ${ask.value}"',
                'ksh -e "echo ${ask.value}"',
                'ksh93 "echo ${ask.value}"',
                'mksh "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }

            // 같은 형태라도 `sh` 는 파일 이름이라 경고하지 않는다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'sh "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), 'sh 의 스크립트 파일 이름을 코드로 봤다');
        });

        test('스크립트가 `cmd` 스위치에 붙어 있어도 본다', () => {
            for (const command of [
                'cmd /c"echo ${ask.value}"',
                'cmd /cecho ${ask.value}',
                'cmd /kecho ${ask.value}',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }
        });

        test('투명 래퍼(`env` · `busybox`)를 거쳐도 인터프리터를 찾는다', () => {
            for (const command of [
                'env sh -c "echo ${ask.value}"',
                '/usr/bin/env bash -c "echo ${ask.value}"',
                'env -i FOO=bar sh -c "echo ${ask.value}"',
                'env -u PATH sh -c "echo ${ask.value}"',
                'busybox sh -c "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }

            // 인터프리터가 아닌 것을 감싼 래퍼는 그대로 조용하다.
            assert.ok(!codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'env printenv ${ask.value}' },
            ])).includes('command.nested-interpreter'), '래퍼를 벗기다 아무 명령에나 경고했다');
        });

        test('`env` 의 옵션 문법을 모르면 fail-closed 로 둔다', () => {
            // 넷 다 실제 `/usr/bin/env` 에서 스크립트가 실행되는 것을 확인했다.
            // `-S` 는 인자를 버리는 옵션이 아니라 그 문자열을 다시 쪼개 실행한다.
            for (const command of [
                'env -S "sh -c \'echo ${ask.value}\'"',
                'env -P /bin sh -c "echo ${ask.value}"',
                'env -C/tmp sh -c "echo ${ask.value}"',
                'env -uPATH sh -c "echo ${ask.value}"',
                'env --unset=PATH sh -c "echo ${ask.value}"',
                // 모르는 옵션이면 "래퍼가 아니다" 가 아니라 **해석 불가**다.
                'env --zzz sh -c "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(
                    found.includes('command.nested-interpreter') || found.includes('command.dynamic-interpreter'),
                    `조용히 지나갔다: ${command} (${found.join(', ')})`
                );
            }
        });

        test('`.exe` 가 붙은 셸도 같은 셸이다', () => {
            // Git-Bash 의 `bash.exe` 는 Windows 에서 흔한 형태인데, 접미사만으로
            // 검사를 통째로 비껴갔다.
            for (const command of [
                'bash.exe -c "echo ${ask.value}"',
                'sh.exe -c "echo ${ask.value}"',
                '"C:\\Program Files\\Git\\bin\\bash.exe" -c "echo ${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }
        });

        test('PowerShell 의 축약 매개변수도 스크립트 스위치다', () => {
            // PowerShell 은 매개변수 이름을 접두사로 맞춘다 — `-Com` 은 `-Command`
            // 이고 실제로 스크립트를 실행한다. 전체 이름만 보면 통째로 놓친다.
            for (const command of [
                'powershell -Com "echo ${ask.value}"',
                'powershell -Comman "echo ${ask.value}"',
                'pwsh -NoProfile -Comm "echo ${ask.value}"',
                'powershell -ec ${b64.value}',
                'powershell -EncodedCommand ${b64.value}',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'b64', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(found.includes('command.nested-interpreter'), `놓쳤다: ${command} (${found.join(', ')})`);
            }

            // `-EncodedCommand` 는 **다음 하나**만 스크립트다. 축약이 다른
            // 매개변수와 겹칠 수 있으므로 뒤의 스위치도 계속 본다.
            assert.ok(codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: 'powershell -e Bypass -Command "echo ${ask.value}"' },
            ])).includes('command.nested-interpreter'), '축약 뒤의 -Command 를 놓쳤다');
        });

        test('`-File` 뒤는 스크립트가 아니라 인자다', () => {
            for (const command of [
                'pwsh -File a.ps1 ${ask.value}',
                'pwsh -NoProfile -File a.ps1 -c "${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(!found.includes('command.nested-interpreter'), `오탐했다: ${command} (${found.join(', ')})`);
            }
        });

        test('`-oc` 의 `c` 는 옵션이 아니라 `-o` 의 인자다', () => {
            // `bash -oc 'echo hi'` 는 `c: invalid option name` 으로 죽는다 —
            // 스크립트가 실행되지 않으므로 스위치로 보면 안 된다.
            assert.deepStrictEqual(
                scriptCandidateTokens(['bash', '-oc', 'echo ${ask.value}']),
                { tokens: [], certain: true }
            );
        });

        test('아주 긴 argv 에서도 죽지 않고 선형으로 끝난다', () => {
            // 자리마다 `argv.slice(...)` 를 펼쳐 담던 동안 O(예산 × argv) 였고,
            // 큰 명령줄에서는 spread 인자 상한을 넘겨 RangeError 로 죽었다.
            // 진단 하나가 확장 호스트를 멈추면 안 된다.
            const argv = ['sh', ...Array.from({ length: 200000 }, (_, i) => `\${a${i}.value}`)];
            const started = Date.now();
            const { tokens } = scriptCandidateTokens(argv);
            assert.ok(Date.now() - started < 5000, `너무 느리다: ${Date.now() - started}ms`);
            assert.ok(tokens.length > 0, '후보가 비었다');

            const wide = ['cmd', '/c', ...Array.from({ length: 200000 }, (_, i) => `\${a${i}.value}`)];
            assert.ok(scriptCandidateTokens(wide).tokens.length > 0);
        });

        test('참조가 많아도 스크립트를 한 번만 훑는다', () => {
            // 참조마다 처음부터 다시 훑던 동안 O(참조 수 × 길이) 였고, 참조마다
            // 태스크 배열을 훑어 O(참조 수 × 태스크 수) 이기도 했다 —
            // 12,000 참조에 6초, 8,000 태스크를 반복 참조하면 11초였다.
            // **마지막** 태스크를 참조해야 조회 경로가 드러난다.
            const measure = (count: number) => {
                const asks = Array.from({ length: count }, (_, i) => ({
                    id: `ask${i}`, type: 'inputBox', prompt: '?',
                    validatePattern: '^[A-Za-z0-9_][A-Za-z0-9_-]*$',
                }));
                const last = `\${ask${count - 1}.value}`;
                const command = 'cmd /c echo ' + Array.from({ length: count }, () => last).join(' ');
                const started = Date.now();
                codes(withTasks([...asks, { id: 'run', type: 'command', command }]));
                return Date.now() - started;
            };
            measure(500);                                   // 워밍업
            const small = Math.max(measure(2000), 1);
            const large = measure(8000);
            assert.ok(large < 4000, `너무 느리다: ${large}ms`);
            assert.ok(large / small < 12, `입력이 4배일 때 시간이 ${(large / small).toFixed(1)}배 — 선형이 아니다`);
        });

        test('중첩된 치환이 깊어도 선형이다', () => {
            // 닫는 구분자를 찾을 때 스택 전체를 훑으면(백틱마다 `some`, `)` 마다
            // "맞는 종류까지 pop") 중첩 깊이 × 길이가 되어 360KB 입력에 9.7초였다 —
            // extension host 를 그대로 막는다. 최상단 프레임만 본다.
            const measure = (n: number) => {
                const script = '$('.repeat(n) + '`x` '.repeat(n) + '${ask.value}';
                const started = Date.now();
                codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: '?', validatePattern: '^[A-Za-z0-9_-]+$' },
                    { id: 'run', type: 'command', command: `sh -c "${script}"` },
                ]));
                return Date.now() - started;
            };
            measure(2000);                                  // 워밍업
            const small = Math.max(measure(10000), 1);
            const large = measure(40000);
            assert.ok(large < 4000, `너무 느리다: ${large}ms`);
            assert.ok(large / small < 12, `입력이 4배일 때 시간이 ${(large / small).toFixed(1)}배 — 선형이 아니다`);
        });

        test('탐색 예산이 끊겨도 후보를 비우지 않는다', () => {
            // 예산 소진을 `certain=false` 로만 알리면 후보가 비어 호출부가
            // "위험 없음" 으로 읽는다 — 조용한 fail-open 이었다.
            const argv = ['sh', ...Array.from({ length: 6000 }, () => '--zzz'), '-c', 'echo ${ask.value}'];
            const { tokens, certain } = scriptCandidateTokens(argv);
            assert.strictEqual(certain, false, '다 못 봤는데 확정했다고 했다');
            assert.ok(tokens.some(text => text.includes('${ask.value}')), '예산이 끊기자 후보가 비었다');

            // 옵션 65개 정도는 예산 안에서 **끝까지** 본다 (예전 고정 예산 64).
            const many = `sh ${Array.from({ length: 65 }, () => '-x').join(' ')} -c "echo \${ask.value}"`;
            const found = codes(withTasks([
                { id: 'ask', type: 'inputBox', prompt: 'v?' },
                { id: 'run', type: 'command', command: many },
            ]));
            assert.ok(found.includes('command.nested-interpreter'), `예산이 끊겨 조용해졌다: ${found.join(', ')}`);
        });

        test('인자를 삼키지 않는 것이 확실한 옵션은 갈래를 나누지 않는다', () => {
            // `-x` 는 인자를 받지 않으므로 `/dev/null` 이 스크립트 파일이고
            // 뒤의 `-c` 와 값은 위치 인자일 뿐이다 — 실제로 실행되지 않는다.
            for (const command of [
                'sh -x /dev/null -c "${ask.value}"',
                'bash --noprofile /dev/null -c "${ask.value}"',
            ]) {
                const found = codes(withTasks([
                    { id: 'ask', type: 'inputBox', prompt: 'v?' },
                    { id: 'run', type: 'command', command },
                ]));
                assert.ok(!found.includes('command.nested-interpreter'), `오탐했다: ${command} (${found.join(', ')})`);
            }
        });

        test('표본 실행만으로 안전을 단정하지 않는다 (validatePattern)', () => {
            // 표본 실행은 "그 문자 **하나만으로는** 통과하지 못한다"는 뜻일
            // 뿐이다. 아래 패턴들은 표본을 전부 거부하면서 메타문자가 든 값을
            // 통과시킨다 — `^.{4}$` 는 `x;id`, `^(ok|x;id)$` 는 `x;id`,
            // `^[^a]+$` 는 무엇이든.
            for (const validatePattern of [
                '^.{4}$',
                '^(ok|x;id)$',
                '^(ok|x\\x3bid)$',       // 이스케이프로 감춘 메타문자
                '^[^a]+$',               // 부정 클래스
                '^\\w+\\s\\w+$',         // `\s` — 공백이 들어간다
                '^[a-~]+$',              // 메타문자를 지나는 범위
                '^(?=.*x)[a-z]+$',       // lookahead — 분석하지 않는다
                '^a|b$',                 // 맨 바깥 `|` — "a 로 시작" **또는** "b 로 끝"
                '^[a-z]+|.*$',
                '^[\\;]$',               // 이스케이프한 메타문자도 결국 그 글자다
                '^[^]$',                 // 부정 빈 클래스 — 무엇이든 통과한다
                '^[a-😀]$',              // `|` 를 지나는 범위 (코드포인트로 읽어도 잡힌다)
                '^[😀-\\uFFFF]$',        // 코드포인트/코드유닛이 어긋나 분석 불가
            ]) {
                assert.ok(
                    codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'v?', validatePattern },
                        { id: 'run', type: 'command', command: 'sh -c "echo ${ask.value}"' },
                    ])).includes('command.nested-interpreter'),
                    `면제가 우회로가 됐다: ${JSON.stringify(validatePattern)}`
                );
            }

            // 문서가 권하는 형태는 계속 면제한다. (`-` 로 **시작**할 수 있는
            // 패턴은 옵션 주입 때문에 별도 규칙이 막는다 — 아래 전용 테스트 참조.)
            for (const validatePattern of [
                '^[A-Za-z0-9_][A-Za-z0-9_-]*$',
                '^[A-Za-z_][A-Za-z0-9_]*$',
                '^(dev|prod)$',
                '^v\\d+\\.\\d+\\.\\d+$',
                '^[a-z]{2,8}$',
            ]) {
                assert.ok(
                    !codes(withTasks([
                        { id: 'ask', type: 'inputBox', prompt: 'v?', validatePattern },
                        { id: 'run', type: 'command', command: 'sh -c "echo ${ask.value}"' },
                    ])).includes('command.nested-interpreter'),
                    `올바른 완화책에 경고가 붙었다: ${JSON.stringify(validatePattern)}`
                );
            }
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

        /**
         * 조건이 굳는 경로는 넷이고 모두 같은 결함이다 — 실행해 봐도 오류가
         * 나지 않고 분기만 조용히 한쪽으로 붙어 있다.
         */
        suite('굳는 경로 네 가지', () => {
            test('in 이 빈 목록이면 어떤 값도 맞을 수 없다', () => {
                // `when.operators` 는 `in` 을 연산자 하나로 세므로 여기를 통과한다 —
                // 절대 실행되지 않는 태스크가 무경고로 남았다.
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', in: [] } },
                ]))], v);
                const dead = findings.filter(f => f.code === 'when.dead-branch');
                assert.strictEqual(dead.length, 1, codes(findings).join(','));
                assert.ok(dead[0].message.includes('empty list'), dead[0].message);
                assert.ok(dead[0].message.includes('never runs'), dead[0].message);
            });

            test('var 가 상수면 비교 결과가 처음부터 정해져 있다', () => {
                const v = compileValidator();
                const never = runDoctor([makeInput(whenAction([
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: 'release', equals: 'debug' } },
                ]))], v).filter(f => f.code === 'when.dead-branch');
                assert.strictEqual(never.length, 1);
                assert.ok(never[0].message.includes('never runs'), never[0].message);

                const always = runDoctor([makeInput(whenAction([
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: 'release', equals: 'release' } },
                ]))], v).filter(f => f.code === 'when.dead-branch');
                assert.strictEqual(always.length, 1);
                assert.ok(always[0].message.includes('always runs'), always[0].message);
            });

            test('빈 var 도 상수다 (조용히 실행되지 않던 자리)', () => {
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '', equals: 'a' } },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.dead-branch'), codes(findings).join(','));
            });

            test('컴파일 안 되는 정규식은 when.regex 만 낸다 (중복 금지)', () => {
                // 같은 사실을 두 코드가 말하면 같은 줄에 경고가 둘 붙는다.
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', matches: '(' } },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.regex'), codes(findings).join(','));
                assert.ok(!findings.some(f => f.code === 'when.dead-branch'), codes(findings).join(','));
            });

            test('연산자가 없으면 when.operators 만 낸다 (중복 금지)', () => {
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}' } },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.operators'), codes(findings).join(','));
                assert.ok(!findings.some(f => f.code === 'when.dead-branch'), codes(findings).join(','));
            });

            test('무시당하는 연산자를 보고 판정하지 않는다', () => {
                // 런타임은 처음 찾은 연산자 하나만 쓴다 — `{equals, in: []}` 는
                // `equals` 로 판정되므로 값이 맞으면 실행된다. 빈 `in` 을 보고
                // "절대 실행되지 않는다" 고 하면 런타임과 반대되는 말이 되고,
                // 같은 태스크에 붙은 when.operators 와도 모순된다.
                const v = compileValidator();
                for (const when of [
                    { var: '${pick.value}', equals: 'a', in: [] },
                    { var: '${pick.value}', equals: 'a', matches: '(' },
                ]) {
                    const findings = runDoctor([makeInput(whenAction([
                        { id: 'pick', type: 'quickPick', items: ['a'] },
                        { id: 'run', type: 'shell', command: 'echo hi', when },
                    ]))], v);
                    assert.ok(!findings.some(f => f.code === 'when.dead-branch'),
                        `${JSON.stringify(when)} → ${findings.map(f => f.message).join(' | ')}`);
                    assert.ok(findings.some(f => f.code === 'when.operators'), codes(findings).join(','));
                }
            });

            test('해석되지 않는 var 는 깨진 정규식보다 먼저 알린다', () => {
                // 정규식 원인은 Doctor 가 억누르므로(when.regex 몫), 그쪽이 이기면
                // "분기가 죽었다" 는 사실이 어디에도 남지 않는다.
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${ghost.output}', matches: '(' } },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.regex'), codes(findings).join(','));
                const dead = findings.filter(f => f.code === 'when.dead-branch');
                assert.strictEqual(dead.length, 1, codes(findings).join(','));
                assert.ok(dead[0].message.includes('never runs'), dead[0].message);
            });

            test('닫는 괄호를 빠뜨린 참조도 상수다', () => {
                // 런타임의 보간은 `${…}` 형태만 치환한다 — `${pick.value` 는 글자
                // 그대로 비교된다. `includes('${')` 로 보면 이 오타가 "참조가 있으니
                // 값이 변한다" 로 새어 나간다.
                const v = compileValidator();
                for (const varText of ['${pick.value', '${}']) {
                    const findings = runDoctor([makeInput(whenAction([
                        { id: 'pick', type: 'quickPick', items: ['a'] },
                        { id: 'run', type: 'shell', command: 'echo hi', when: { var: varText, equals: 'a' } },
                    ]))], v);
                    assert.ok(findings.some(f => f.code === 'when.dead-branch'),
                        `${varText} → ${codes(findings).join(',')}`);
                }
            });

            test('연산자 없는 상수 var 도 when.operators 만 낸다', () => {
                // `hasConditionOperator` 조기 반환이 없으면 상수 판정이 먼저 걸려
                // 같은 사실을 말하는 경고가 둘 붙는다.
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: 'release' } },
                ]))], v);
                assert.ok(findings.some(f => f.code === 'when.operators'), codes(findings).join(','));
                assert.ok(!findings.some(f => f.code === 'when.dead-branch'), codes(findings).join(','));
            });

            test('한국어 문구도 원인별로 채워진다', () => {
                const v = compileValidator();
                const ko = (when: any) => runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['a'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when },
                ]))], v).filter(f => f.code === 'when.dead-branch').map(f => f.messageKo ?? '').join(' ');
                assert.ok(ko({ var: '${pick.value}', in: [] }).includes('빈 목록'), 'empty-in');
                assert.ok(ko({ var: 'release', equals: 'debug' }).includes('상수'), 'constant-var');
                assert.ok(ko({ var: 'release', equals: 'debug' }).includes('영영 실행되지 않습니다'), 'runs');
            });

            /**
             * `frozen.runs` 가 **런타임이 실제로 낼 답**과 같은지 표로 대조한다.
             * 개별 케이스를 아무리 늘려도 판정 규칙이 갈리는 것 자체는 못 막는다 —
             * 이 검사가 연산자 우선순위를 무시하던 버그를 바로 잡아냈다.
             *
             * 원인에 따라 "고정" 의 뜻이 다르다.
             *
             * - `empty-in` · `invalid-regex`: 연산자가 **어떤 값에도** 같은 답을
             *   낸다 → 표본 전부에 대해 일치해야 한다.
             * - `constant-var` · `unresolved-var`: 비교되는 **값**이 하나로 정해진다
             *   → 그 값에 대해 일치해야 한다.
             */
            test('frozen 판정은 런타임 결과와 일치한다', () => {
                const samples = ['', 'a', 'release', 'debug', '${x}', '한글', 'ghost'];
                const shapes: any[] = [
                    { var: 'release', equals: 'release' },
                    { var: 'release', equals: 'debug' },
                    { var: 'release', notEquals: 'release' },
                    { var: '${p.v}', in: [] },
                    { var: '${p.v}', matches: '(' },
                    // 무시당하는 연산자 — 판정이 나오면 안 되는 형태들.
                    { var: '${p.v}', equals: 'a', in: [] },
                    { var: '${p.v}', equals: 'a', matches: '(' },
                    { var: '', equals: 'a' },
                    { var: 'x', matches: '^x$' },
                    { var: 'x', in: ['x', 'y'] },
                    { var: '${ghost.out}', equals: 'a' },
                    { var: '${ghost.out}', notEquals: 'a' },
                ];
                for (const when of shapes) {
                    const stuck = when.var.includes('ghost');
                    const frozen = detectFrozenCondition(when, when.var, stuck);
                    if (!frozen) { continue; }
                    const valueIndependent = frozen.cause === 'empty-in' || frozen.cause === 'invalid-regex';
                    const values = valueIndependent ? samples : [when.var];
                    for (const s of values) {
                        assert.strictEqual(
                            evaluateTaskCondition(when, s), frozen.runs,
                            `${JSON.stringify(when)} (${frozen.cause}) 가 '${s}' 에서 어긋난다`
                        );
                    }
                }
            });

            test('값이 풀리는 조건은 결과를 단정하지 않는다', () => {
                // 시뮬레이션 값은 자리표시자라 `equals` 와 맞지 않는다. 그것을
                // 근거로 "굳었다" 고 하면 사용자 입력과 무관하게 거짓을 말한다.
                const v = compileValidator();
                const findings = runDoctor([makeInput(whenAction([
                    { id: 'pick', type: 'quickPick', items: ['release'] },
                    { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', equals: 'release' } },
                ]))], v);
                assert.deepStrictEqual(codes(findings), [], findings.map(f => f.message).join(' | '));
            });
        });

        test('피연산자 경고는 의존성 간선까지 말한다', () => {
            // 참조가 맞지 않는 것만이 아니다 — `inferTaskDependencies` 는 `when`
            // 을 건너뛰지 않으므로 그 참조는 실행 순서를 바꾸고, 가리키는 태스크가
            // 꺼지면 이 태스크까지 함께 건너뛰어진다.
            const v = compileValidator();
            const findings = runDoctor([makeInput(whenAction([
                { id: 'pick', type: 'quickPick', items: ['a'] },
                { id: 'p2', type: 'quickPick', items: ['a'] },
                { id: 'run', type: 'shell', command: 'echo hi', when: { var: '${pick.value}', equals: '${p2.value}' } },
            ]))], v);
            const lit = findings.filter(f => f.code === 'when.literal-operand');
            assert.strictEqual(lit.length, 1, codes(findings).join(','));
            assert.ok(lit[0].message.includes('dependency'), lit[0].message);
            assert.ok(lit[0].messageKo?.includes('의존성'), lit[0].messageKo);
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

    test('새 QuickPick·forEach 결과 키도 capture로 덮을 수 없다', () => {
        const v = compileValidator();
        for (const name of ['labelList', 'custom', 'outputs', 'stderrs']) {
            const findings = runDoctor([makeInput([{
                id: `a.reserved.${name}`, title: 'reserved', action: {
                    description: 'd',
                    tasks: [{
                        id: 'build', type: 'shell', command: 'make',
                        passTheResultToNextTask: true,
                        output: { capture: { name, regex: '(.*)' } },
                    }],
                },
            }])], v);
            assert.ok(findings.some(f => f.code === 'capture.reserved'), name);
        }
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

    test('quickPick default와 detail 안의 미해결 참조도 잡는다', () => {
        const findings = runDoctor([makeInput([{
            id: 'a.quick-dynamic', title: 'quick',
            action: {
                description: 'd',
                tasks: [{
                    id: 'pick', type: 'quickPick', default: '${ghost.default}',
                    items: [{ label: 'A', detail: '${ghost.detail}', value: 'a' }],
                }],
            },
        }])], compileValidator());
        const unresolved = findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ');
        assert.ok(unresolved.includes('${ghost.default}'), unresolved);
        assert.ok(unresolved.includes('${ghost.detail}'), unresolved);
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

    /** 내장과 같은 이름의 기존 task는 bare/속성 참조를 모두 소유한다. */
    for (const builtin of ['workspaceFolder', 'extensionPath']) {
        test(`same-named task owns bare \${${builtin}}`, () => {
            const findings = runDoctor([makeInput([{
                id: 'a.shadow',
                title: 'shadow',
                action: {
                    description: 'd',
                    tasks: [
                        { id: builtin, type: 'stringManipulation', function: 'trim', input: 'task-result' },
                        { id: 'later', type: 'command', command: `echo \${${builtin}}` },
                    ],
                },
            }])], compileValidator());
            assert.strictEqual(findings.filter(f => f.code === 'variable.unresolved').length, 0,
                `동명 task 대표 결과가 풀리지 않았다: ${findings.filter(f => f.code === 'variable.unresolved').map(f => f.message).join(' | ')}`);
        });

        test(`\${${builtin}.value} resolves from a same-named task`, () => {
            const findings = runDoctor([makeInput([{
                id: 'a.shadow-value',
                title: 'shadow',
                action: {
                    description: 'd',
                    tasks: [
                        { id: builtin, type: 'inputBox', prompt: '?' },
                        { id: 'later', type: 'command', command: `echo \${${builtin}.value}` },
                    ],
                },
            }])], compileValidator());
            assert.ok(!findings.some(f => f.code === 'variable.unresolved'),
                `동명 task의 \`.value\` 를 해석하지 못했다: ${codes(findings).join(', ')}`);
        });
    }

    test('동명 self bare 참조는 민감 내장으로 떨어지지 않고 미해결로 남는다', () => {
        const findings = runDoctor([makeInput([{
            id: 'a.self-shadow',
            title: 'self shadow',
            action: {
                description: 'd',
                tasks: [{
                    id: 'selectedText', type: 'writeFile',
                    path: path.join(WS, 'out.txt'), content: '${selectedText}',
                }],
            },
        }])], compileValidator());
        assert.ok(findings.some(f => f.code === 'variable.unresolved'));
        assert.ok(!findings.some(f => f.code === 'secret.file-optin'));
    });

    test('전방 동명 task의 bare 참조를 내장값으로 오인하지 않는다', () => {
        const findings = runDoctor([makeInput([{
            id: 'a.forward-shadow',
            title: 'forward shadow',
            action: {
                description: 'd',
                tasks: [
                    { id: 'use', type: 'command', command: 'echo ${file}', parallel: true },
                    {
                        id: 'file', type: 'stringManipulation', function: 'trim',
                        input: 'task-result', parallel: true,
                    },
                ],
            },
        }])], compileValidator());
        assert.ok(!findings.some(f => f.code === 'variable.unresolved'),
            findings.map(f => `${f.code}: ${f.message}`).join('\n'));
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

    /**
     * `output` 검사는 **그래프 추론과 같은 생존 조건**을 따라야 한다. 어긋나면
     * 두 진단이 정면으로 맞선다 — 한쪽은 "이 output 은 무시된다"(`output.ignored`)고
     * 하면서 다른 쪽은 그 안의 참조를 미해결로 올리거나 경로를 에러로 막았다.
     */
    suite('output 검사의 생존 조건', () => {
        const codesOf = (task: any) => runDoctor([makeInput([
            { id: 'a.out', title: 'out', action: { description: 'd', tasks: [task] } },
        ])], compileValidator()).map(f => f.code);

        test('죽은 output 은 **모든 타입**에서 `output.ignored` 로 알린다', () => {
            // 게이트(`passTheResultToNextTask && output`)는 타입을 가리지 않는다.
            // 진단만 shell/command 로 좁혀 두면, 죽은 필드의 참조·경로 진단을 뺀 뒤로
            // 다른 타입은 **아무 진단도 남지 않아** Preview 만 "ignored" 라고 말한다.
            const cases: any[] = [
                { id: 'w', type: 'fileDialog' },
                { id: 'w', type: 'stringManipulation', function: 'trim', input: 'x' },
                { id: 'w', type: 'zip', source: 's', archivePath: 'a.zip' },
                { id: 'w', type: 'writeFile', path: 'p', content: 'c' },
                { id: 'w', type: 'shell', command: 'x' },
            ];
            for (const base of cases) {
                const found = codesOf({ ...base, output: { mode: 'file', filePath: 'f.txt', content: '${ghost.output}' } });
                assert.ok(found.includes('output.ignored'),
                    `${base.type} 의 죽은 output 에 아무 진단도 남지 않았다: ${found.join(', ') || '(none)'}`);
            }

            // 살아 있는 자리는 알리지 않는다.
            assert.ok(!codesOf({
                id: 'w', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'file', filePath: 'f.txt' },
            }).includes('output.ignored'), '살아 있는 file output 을 무시된다고 했다');
            // `capture` 는 게이트 **밖**이다 — 문자열 출력만 있으면 돈다.
            assert.ok(!codesOf({
                id: 'w', type: 'stringManipulation', function: 'trim', input: 'x',
                output: { capture: { name: 'v', pattern: '(a)' } },
            }).includes('output.ignored'), 'stringManipulation 의 capture 를 죽었다고 했다');
            assert.ok(codesOf({
                id: 'w', type: 'shell', command: 'x',
                output: { capture: { name: 'v', pattern: '(a)' } },
            }).includes('output.ignored'), '문자열 출력이 없는 capture 를 놓쳤다');

            // `language` 는 **에디터 문서를 열 때만** 쓰인다. 목록에서 빠져 있어
            // `output: { language }` 만 둔 태스크가 진단 0건이었다.
            assert.ok(codesOf({
                id: 'w', type: 'shell', command: 'x', output: { language: 'javascript' },
            }).includes('output.ignored'), '플래그 없는 language 를 놓쳤다');
            assert.ok(codesOf({
                id: 'w', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'file', filePath: 'f.txt', language: 'javascript' },
            }).includes('output.ignored'), "mode: 'file' 의 language 를 놓쳤다");
            assert.ok(!codesOf({
                id: 'w', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'editor', language: 'javascript' },
            }).includes('output.ignored'), "mode: 'editor' 의 살아 있는 language 를 죽었다고 했다");
        });

        test('꺼진 output 의 참조·경로는 진단하지 않는다', () => {
            const dead = codesOf({
                id: 'B', type: 'shell', command: 'x',
                output: { mode: 'file', filePath: 'f.txt', content: '${ghost.output}' },
            });
            assert.ok(!dead.includes('variable.unresolved'),
                `실행되지도 않는 output 의 참조를 미해결로 올렸다: ${dead.join(', ')}`);

            const deadPath = codesOf({
                id: 'B', type: 'shell', command: 'x',
                output: { mode: 'file', filePath: '/etc/passwd' },
            });
            assert.ok(!deadPath.includes('path.outside-workspace'),
                `실행되지도 않는 경로를 에러로 막았다: ${deadPath.join(', ')}`);
            // 대신 "이 output 은 무시된다" 는 진단은 그대로 나온다.
            assert.ok(deadPath.includes('output.ignored'), deadPath.join(', '));
        });

        test('살아 있는 output 은 `overwrite` 까지 본다', () => {
            // 조건을 맞추기 전에는 아무도 보지 않던 자리다.
            assert.ok(codesOf({
                id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'file', filePath: 'f.txt', overwrite: '${ghost.output}' },
            }).includes('variable.unresolved'), '살아 있는 `overwrite` 의 참조를 놓쳤다');

            assert.ok(codesOf({
                id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'file', filePath: 'f.txt', content: '${ghost.output}' },
            }).includes('variable.unresolved'), '살아 있는 `content` 의 참조를 놓쳤다');

            assert.ok(codesOf({
                id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'file', filePath: '/etc/passwd' },
            }).includes('path.outside-workspace'), '살아 있는 경로를 놓쳤다');

            // `mode` 가 `file` 이 아니면 `filePath` 는 쓰이지 않는다.
            assert.ok(!codesOf({
                id: 'B', type: 'shell', command: 'x', passTheResultToNextTask: true,
                output: { mode: 'editor', filePath: '/etc/passwd' },
            }).includes('path.outside-workspace'), '`mode: editor` 의 경로를 막았다');
        });
    });

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
        // 짧은 순환은 경로를 그대로 싣는다 — 접기가 평범한 경우를 건드리지 않는다.
        assert.ok(findings.find(f => f.code === 'dependsOn.cycle')!.message.includes('a -> b -> a'),
            '짧은 순환 경로를 접었다');
    });

    test('folds a pipeline-length cycle path instead of dumping every id', () => {
        // 순차 배리어가 사슬이라 순환 경로가 태스크 수만큼 길어질 수 있다.
        // 그대로 실으면 진단 하나가 수십 KB 라 Problems 패널을 덮는다.
        const N = 400;
        const tasks: any[] = [{ id: 'T0', type: 'shell', command: `echo \${T${N - 1}.output}` }];
        for (let i = 1; i < N; i++) { tasks.push({ id: `T${i}`, type: 'shell', command: `echo ${i}` }); }
        const findings = runDoctor([makeInput([
            { id: 'a.long-cyc', title: 'cyc', action: { description: 'd', tasks } }
        ])], compileValidator());

        const cycle = findings.find(f => f.code === 'dependsOn.cycle');
        assert.ok(cycle, `expected dependsOn.cycle, got ${codes(findings).join(',')}`);
        assert.ok(cycle!.message.includes('more)'), `경로를 접지 않았다: ${cycle!.message.slice(0, 200)}`);
        assert.ok(cycle!.message.length < 400, `메시지가 여전히 길다 (${cycle!.message.length}자)`);
        // 양 끝은 남는다 — 순환을 고치려면 닫히는 지점이 보여야 한다.
        assert.ok(cycle!.message.includes('T0 ->') && cycle!.message.includes('-> T0.'),
            `순환이 닫히는 지점을 잘라 냈다: ${cycle!.message.slice(0, 200)}`);
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

suite('actions.schema.json — quickPick 편의 옵션', () => {
    const taskSchema: any = (actionSchema as any).definitions?.Task;
    const properties: any = taskSchema?.properties;

    test('default·allowCustom·rememberLastSelection이 설명과 함께 제안된다', () => {
        for (const key of ['default', 'allowCustom', 'rememberLastSelection']) {
            assert.ok(properties?.[key], `${key} 가 스키마에 없다`);
            assert.ok(typeof properties[key].description === 'string' && properties[key].description.length > 0);
        }
    });

    test('기본값·직접 입력·기억 설정은 유효하고 custom 다중 선택은 거부한다', () => {
        const v = compileValidator();
        const wrap = (task: any) => [{
            id: 'a.quick', title: 'quick', action: { description: 'd', tasks: [task] },
        }];
        assert.strictEqual(v(wrap({
            id: 'pick', type: 'quickPick', items: ['a', 'b'],
            default: 'a', allowCustom: true, rememberLastSelection: true,
        })), true, JSON.stringify(v.errors));
        assert.strictEqual(v(wrap({
            id: 'pick', type: 'quickPick', items: ['a', 'b'],
            allowCustom: true, canPickMany: true,
        })), false, '런타임에서 지원하지 않는 custom 다중 선택이 스키마를 통과했다');
        assert.strictEqual(v(wrap({
            id: 'pick', type: 'quickPick', items: ['a', 'b'], default: ['a', 'b'],
        })), false, '다중 기본값이 단일 선택 설정을 통과했다');
    });
});

suite('forEach 설정과 Doctor', () => {
    const wrap = (task: any) => [{
        id: 'a.foreach', title: 'forEach', action: {
            description: 'd',
            tasks: [
                { id: 'files', type: 'fileDialog', options: { canSelectMany: true } },
                task,
            ],
        },
    }];

    test('배열 참조와 정적 배열은 스키마를 통과하고 interactive·one-shot은 거부한다', () => {
        const v = compileValidator();
        assert.strictEqual(v(wrap({
            id: 'run', type: 'command', forEach: '${files.paths}', command: 'tool', args: ['${each}'],
        })), true, JSON.stringify(v.errors));
        assert.strictEqual(v(wrap({
            id: 'run', type: 'command', forEach: ['a', 'b'], command: 'tool', args: ['${each.value}'],
        })), true, JSON.stringify(v.errors));
        assert.strictEqual(v(wrap({ id: 'ask', type: 'inputBox', forEach: ['a'], prompt: 'x' })), false);
        assert.strictEqual(v(wrap({
            id: 'run', type: 'command', forEach: ['a'], command: 'tool', isOneShot: true,
        })), false);
    });

    test('each의 정상 키는 unresolved가 아니고 오타는 잡는다', () => {
        const good = runDoctor([makeInput(wrap({
            id: 'run', type: 'command', forEach: '${files.paths}', command: 'tool',
            args: ['${each}', '${each.value}', '${each.index}', '${each.number}', '${each.count}'],
        }))], compileValidator());
        assert.ok(!codes(good).includes('variable.unresolved'), JSON.stringify(good, null, 2));

        const bad = runDoctor([makeInput(wrap({
            id: 'run', type: 'command', forEach: '${files.paths}', command: 'tool', args: ['${each.typo}'],
        }))], compileValidator());
        assert.ok(codes(bad).includes('variable.unresolved'));
    });

    test('when.var의 each 참조는 실행 전 오류로 진단한다', () => {
        const findings = runDoctor([makeInput(wrap({
            id: 'run', type: 'command', forEach: '${files.paths}', command: 'tool',
            args: ['${each}'], when: { var: '${each.value}', equals: 'a' },
        }))], compileValidator());
        assert.ok(codes(findings).includes('foreach.when-each'), JSON.stringify(findings, null, 2));
    });

    test('동명 each producer가 있으면 forEach 소스와 when은 그 task를 참조한다', () => {
        const items = [{
            id: 'a.foreach-producer', title: 'forEach producer', action: {
                description: 'd',
                tasks: [
                    { id: 'each', type: 'quickPick', items: ['yes'] },
                    { id: 'files', type: 'fileDialog', options: { canSelectMany: true } },
                    {
                        id: 'run', type: 'command', forEach: '${files.paths}',
                        command: 'tool', args: ['${each.value}'],
                        when: { var: '${each.value}', equals: 'yes' },
                    },
                ],
            },
        }];
        const findings = runDoctor([makeInput(items)], compileValidator());
        assert.ok(!codes(findings).includes('foreach.when-each'), JSON.stringify(findings, null, 2));
    });

    test('민감한 each producer를 forEach 소스로 쓴 파일 저장도 opt-in을 요구한다', () => {
        const items = [{
            id: 'a.foreach-secret', title: 'forEach secret', action: {
                description: 'd',
                tasks: [
                    { id: 'password', type: 'inputBox', password: true },
                    {
                        id: 'each', type: 'quickPick',
                        items: [{ label: 'secret', value: ['${password.value}'] }],
                    },
                    {
                        id: 'save', type: 'writeFile', forEach: '${each.valueList}',
                        path: '${workspaceFolder}/out.txt', content: '${each.value}',
                    },
                ],
            },
        }];
        const findings = runDoctor([makeInput(items)], compileValidator());
        assert.ok(codes(findings).includes('secret.file-optin'), JSON.stringify(findings, null, 2));
    });
});
