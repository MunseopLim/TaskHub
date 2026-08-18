import * as assert from 'assert';
import { collectVariableCompletions, referencePrefixAt } from '../variableCompletions';
import { parseReferenceAlternatives } from '../pipelineUtils';

/**
 * `${…}` 참조 자동완성 (0.6.57).
 *
 * 사용자 보고: `canSelectMany` 는 자동완성에 뜨는데 정작 그 결과인
 * `${pick.paths}` 는 아무 데서도 보이지 않아 "그런 것이 없는 줄 알았다".
 * 스키마는 **키**만 제안할 수 있고, 이 참조는 값 문자열 **안**에 있으면서
 * 무엇이 유효한지가 같은 액션의 다른 태스크 타입에 달렸다 — 스키마로는
 * 표현할 자리가 없어 별도 provider 가 필요하다.
 *
 * 편집 중인 파일은 대개 유효한 JSON 이 아니므로(따옴표를 막 연 상태 등)
 * 아래 픽스처 일부는 **일부러 닫히지 않은** 형태로 둔다.
 */
suite('variableCompletions', () => {

    /** `|` 위치를 커서로 삼는다. */
    function at(fixture: string): { text: string; offset: number } {
        const offset = fixture.indexOf('|');
        assert.ok(offset >= 0, '픽스처에 커서(|)가 없다');
        return { text: fixture.slice(0, offset) + fixture.slice(offset + 1), offset };
    }
    const names = (fixture: string) => {
        const { text, offset } = at(fixture);
        return collectVariableCompletions(text, offset).map(c => c.name);
    };

    const doc = (body: string) => `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog", "options": { "canSelectMany": true } },
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        ${body}
      ]
    }
  }
]`;

    /**
     * `detail` 은 **문구가 아니라 종류**다. 이 모듈은 `vscode` 를 import 하지
     * 않아 `t()` 를 쓸 수 없으므로, 여기서 문장을 만들면 한국어 사용자에게
     * 영어가 그대로 보인다. 문구는 extension.ts 의 `describeVariableCompletion`
     * 이 만든다.
     */
    suite('detail 은 종류만 담는다', () => {
        const details = (fixture: string) => {
            const { text, offset } = at(fixture);
            return collectVariableCompletions(text, offset).map(c => c.detail);
        };

        test('태스크 id 와 전역 참조', () => {
            const got = details(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${|"] }`));
            assert.deepStrictEqual(
                got.find(d => d.kind === 'builtin' && d.ref === 'workspaceFolder'),
                { kind: 'builtin', ref: 'workspaceFolder' }
            );
            assert.deepStrictEqual(
                got.find(d => d.kind === 'task' && d.taskType === 'fileDialog'),
                { kind: 'task', taskType: 'fileDialog' }
            );
        });

        test('현재 파일 내장과 환경변수 네임스페이스도 종류를 구분한다', () => {
            const got = details(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${|"] }`));
            assert.deepStrictEqual(
                got.find(d => d.kind === 'builtin' && d.ref === 'file'),
                { kind: 'builtin', ref: 'file' }
            );
            assert.deepStrictEqual(
                got.find(d => d.kind === 'environment' && d.variable === undefined),
                { kind: 'environment' }
            );
        });

        test('결과 키는 타입을, 캡처 이름은 태스크 id 를 싣는다', () => {
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "build", "type": "shell", "command": "make", "passTheResultToNextTask": true,
      "output": { "capture": { "name": "version", "regex": "v(\\\\d+)" } } },
    { "id": "tag", "type": "shell", "command": "git tag \${build.|" }
  ] } }
]`;
            const { text, offset } = at(fixture);
            const entries = collectVariableCompletions(text, offset);
            assert.deepStrictEqual(
                entries.find(e => e.name === 'build.version')?.detail,
                { kind: 'capture', taskId: 'build' }
            );
            assert.deepStrictEqual(
                entries.find(e => e.name === 'build.output')?.detail,
                { kind: 'result', taskType: 'shell' }
            );
        });
    });

    suite('내장 문맥 변수', () => {
        test('현재 파일·선택 영역·클립보드를 최상위에서 제안한다', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${|"] }`));
            for (const expected of [
                'file', 'relativeFile', 'fileDirname', 'fileBasename',
                'selectedText', 'lineNumber', 'columnNumber', 'clipboard', 'env:',
            ]) {
                assert.ok(got.includes(expected), `${expected} 누락: ${got.join(',')}`);
            }
        });

        test('env: 뒤에는 실제 환경변수 이름과 값이 아닌 이름만 제안한다', () => {
            const { text, offset } = at(doc(
                `{ "id": "run", "type": "command", "command": "py", "args": ["\${env:PA|"] }`
            ));
            const got = collectVariableCompletions(text, offset, {
                PATH: '/secret/path',
                PATHEXT: '.EXE',
                TOKEN: 'must-not-appear',
            });
            assert.deepStrictEqual(got.map(entry => entry.name), ['env:PATH', 'env:PATHEXT', 'env:TOKEN']);
            assert.ok(got.every(entry => !entry.name.includes('/secret/path') && !entry.name.includes('must-not-appear')));
            assert.deepStrictEqual(got[0].detail, { kind: 'environment', variable: 'PATH' });
        });
    });

    suite('referencePrefixAt', () => {
        test('`${` 안이면 그 사이 글자를 돌려준다', () => {
            const { text, offset } = at('"cmd ${pick.pa|"');
            assert.deepStrictEqual(referencePrefixAt(text, offset)?.prefix, 'pick.pa');
        });

        test('참조 자리가 아니면 아무것도 아니다', () => {
            for (const fixture of ['"plain text|"', '"${done} |"', '"${a\n|"']) {
                const { text, offset } = at(fixture);
                assert.strictEqual(referencePrefixAt(text, offset), undefined, fixture);
            }
        });

        test('여는 `${` 가 없으면 undefined', () => {
            assert.strictEqual(referencePrefixAt('no refs here', 5), undefined);
        });

        /**
         * `??` 체인에서는 **마지막 대안**이 지금 입력 중인 참조다. `start` 는
         * 자동완성이 대체할 범위의 시작점이라, 여기가 틀리면 항목을 고르는
         * 순간 앞선 대안이 지워진다.
         */
        suite('?? 체인', () => {
            test('마지막 `??` 뒤부터가 지금 입력 중인 참조다', () => {
                const { text, offset } = at('"cmd ${pickFile.path ?? pickFolder.pa|"');
                assert.deepStrictEqual(referencePrefixAt(text, offset), {
                    prefix: 'pickFolder.pa',
                    start: text.indexOf('pickFolder'),
                    end: offset,   // 뒤에 이어지는 글자가 없다
                });
            });

            test('대안 앞의 공백은 대체 범위에 넣지 않는다', () => {
                // 넣으면 항목을 고를 때마다 `a.x ??b.y` 로 눌러붙는다.
                const { text, offset } = at('"cmd ${a.x ??   b.|"');
                const ref = referencePrefixAt(text, offset)!;
                assert.strictEqual(ref.prefix, 'b.');
                assert.strictEqual(text.slice(ref.start, offset), 'b.');
            });

            test('대안이 셋이면 마지막 것만 본다', () => {
                const { text, offset } = at('"cmd ${a.x ?? b.y ?? c.|"');
                const ref = referencePrefixAt(text, offset)!;
                assert.strictEqual(ref.prefix, 'c.');
                assert.strictEqual(text.slice(ref.start, offset), 'c.');
            });

            test('`??` 바로 뒤 (아직 아무것도 안 친 자리)', () => {
                const { text, offset } = at('"cmd ${a.x ?? |"');
                const ref = referencePrefixAt(text, offset)!;
                assert.strictEqual(ref.prefix, '');
                assert.strictEqual(ref.start, offset, '대체할 것이 없으므로 범위는 비어 있어야 한다');
            });

            test('물음표 하나는 구분자가 아니다', () => {
                const { text, offset } = at('"cmd ${a.x?|"');
                assert.strictEqual(referencePrefixAt(text, offset)?.prefix, 'a.x?');
            });

            test('커서가 앞 대안 안에 있으면 그 대안만 본다', () => {
                // 뒤에 이미 다른 대안이 적혀 있어도 커서 앞쪽만이 지금 치고 있는
                // 것이다. `${…}` 전체를 쪼갠 뒤 마지막을 집으면 `start` 가 커서보다
                // **뒤**로 가고, Range 가 뒤집힌 채 정규화되어 ` ?? ` 를 덮는다 —
                // 수락하면 `${pick.pick.paths ask.value}` 가 된다.
                const { text, offset } = at('"cmd ${pick.| ?? ask.value}"');
                const ref = referencePrefixAt(text, offset)!;
                assert.strictEqual(ref.prefix, 'pick.');
                assert.strictEqual(text.slice(ref.start, offset), 'pick.');
            });

            test('`??` 로 시작하는 표현식 (빈 첫 대안)', () => {
                // 런타임은 빈 대안을 버린다. 경계에서 `lastSep <= 0` 처럼 막으면
                // 이 자리에서 제안이 통째로 사라진다.
                const { text, offset } = at('"cmd ${?? a.pa|"');
                const ref = referencePrefixAt(text, offset)!;
                assert.strictEqual(ref.prefix, 'a.pa');
                assert.strictEqual(text.slice(ref.start, offset), 'a.pa');
            });

            test('물음표가 셋이면 런타임과 같게 쪼갠다', () => {
                // 런타임의 `split('??')` 은 `a ??? b.x` 를 `["a", "? b.x"]` 로 읽어
                // 뒤 대안이 영영 안 풀린다. 뒤에서 `??` 를 찾으면 `b.x` 가 멀쩡한
                // 참조로 보여 **해석되지 않을 것을 제안**하게 된다.
                const { text, offset } = at('"cmd ${a ??? b.|"');
                assert.strictEqual(referencePrefixAt(text, offset)?.prefix, '? b.');
            });

            test('커서가 `??` **안**이면 아무것도 제안하지 않는다', () => {
                // 이 자리에서는 앞쪽 `split('??')` 도 뒤쪽 경계 검사도 연산자를
                // 보지 못한다. prefix 가 `a.b ?` 로 읽히므로 무엇을 고르든 대체
                // 범위가 `??` 를 삼켜 **체인이 통째로 리터럴이 된다**.
                for (const fixture of ['"cmd ${a.b ?|? c.d}"', '"cmd ${a.b ??|? c.d}"']) {
                    const { text, offset } = at(fixture);
                    assert.strictEqual(referencePrefixAt(text, offset), undefined, fixture);
                }
            });

            test('`??` 밖의 물음표 하나는 여전히 참조 자리다', () => {
                // 가드가 넓으면 `${a.x?` 같은 평범한 오타 자리에서 제안이 사라진다.
                const { text, offset } = at('"cmd ${a.x?|"');
                assert.strictEqual(referencePrefixAt(text, offset)?.prefix, 'a.x?');
            });

            /**
             * 낱말 중간에서 자동완성을 받을 때 대체할 범위. 없으면 꼬리가 남아
             * `${ask.valuelue}` 가 된다.
             */
            suite('end — 커서 뒤 대안의 끝', () => {
                const endOf = (fixture: string) => {
                    const { text, offset } = at(fixture);
                    const ref = referencePrefixAt(text, offset)!;
                    return { ref, offset, text, tail: text.slice(ref.start, ref.end) };
                };

                test('낱말 중간이면 뒤쪽 글자까지 덮는다', () => {
                    assert.strictEqual(endOf('"cmd ${ask.va|lue}"').tail, 'ask.value');
                });

                test('`}` 에서 멈춘다', () => {
                    assert.strictEqual(endOf('"cmd ${a.b|c} tail"').tail, 'a.bc');
                });

                test('다음 대안(`??`)은 건드리지 않는다', () => {
                    assert.strictEqual(endOf('"cmd ${a.b|c ?? d.e}"').tail, 'a.bc');
                });

                test('`??` 앞의 공백은 덮지 않는다', () => {
                    // 넣으면 항목을 고를 때마다 `a.bc ??d.e` 로 눌러붙는다.
                    assert.strictEqual(endOf('"cmd ${a.b|c   ?? d.e}"').tail, 'a.bc');
                });

                test('문자열이 닫히지 않아도(편집 중) 따옴표·줄바꿈에서 멈춘다', () => {
                    assert.strictEqual(endOf('"cmd ${a.b|c"').tail, 'a.bc');
                    // JSON 문자열 안에 날 줄바꿈이 있다는 것은 문자열이 닫히지
                    // 않았다는 뜻이므로, 줄바꿈도 확신 있는 종결자다.
                    assert.strictEqual(endOf('"cmd ${a.b|c\nnext').tail, 'a.bc');
                    assert.strictEqual(endOf('"cmd ${a.b|c\r\nnext').tail, 'a.bc');
                });

                test('확신 있는 종결자 없이 문서가 끝나면 커서로 죈다', () => {
                    // 커서 뒤 `c` 가 참조의 미완성 속성인지 누락된 `}` 뒤의
                    // 사용자 인자인지 알 방법이 없다. 덮으면 잃고, 죄면 꼬리가
                    // 붙어 남을 뿐이다 — 되돌릴 수 있는 쪽을 고른다.
                    assert.strictEqual(endOf('"cmd ${a.b|c').tail, 'a.b');
                });

                test('**공백에서 멈춘다** — 뒤따르는 명령 인자를 삼키지 않는다', () => {
                    // 편집 중인 참조는 닫혀 있지 않은 것이 보통이다(JSON 문자열
                    // 안에서는 `${` 가 자동으로 닫히지 않는다). 공백을 넘어가면
                    // 대체 범위가 문자열 끝까지 가서, replace 모드 사용자는
                    // 항목을 고르는 순간 인자를 통째로 잃는다.
                    assert.strictEqual(endOf('"cp ${pick.| dist/out.txt"').tail, 'pick.');
                    assert.strictEqual(endOf('"cp ${pick.pa| --force /tmp/x"').tail, 'pick.pa');
                });

                test('탭과 비-ASCII 공백도 공백이다', () => {
                    // `??` 앞에 IME 가 넣은 U+00A0 를 넘기면 `a.value?? d.e` 로
                    // 눌러붙는다.
                    assert.strictEqual(endOf('"cmd ${a.b|c\t\t?? d.e}"').tail, 'a.bc');
                    assert.strictEqual(endOf('"cmd ${a.b|c ?? d.e}"').tail, 'a.bc');
                });

                test('물음표 하나 뒤는 대안 경계가 아니므로 죈다', () => {
                    // `?` 하나는 구분자가 아니라 오타 자리다 — 런타임은
                    // `a.bc ? d.e` 전체를 대안 하나로 보고 리터럴로 남긴다.
                    // 확신할 수 없으니 커서로 죈다. 꼬리가 남아도 손해가 없다.
                    assert.strictEqual(endOf('"cmd ${a.b|c ? d.e}"').tail, 'a.b');
                });

                test('공백 뒤가 `??` 면 대안이 거기서 끝나는 것이 확실하다', () => {
                    // 죄는 규칙의 예외다. 이것을 빼면 `??` 체인 낱말 중간 편집이
                    // 통째로 후퇴한다 — `}` 가 `??` 뒤에 있어 스캔이 공백에서
                    // 먼저 멈추기 때문이다.
                    assert.strictEqual(endOf('"cmd ${a.b|c ?? d.e}"').tail, 'a.bc');
                    assert.strictEqual(endOf('"cmd ${a.b|c   ?? d.e}"').tail, 'a.bc');
                });

                test('**사용자 인자를 삼키지 않는다** — 닫히지 않은 참조의 꼬리', () => {
                    // `report.html` 이 참조의 속성인지 누락된 `}` 뒤의 인자인지
                    // 판별할 정보가 없다. 덮으면 `"cp ${gen.outputDir dist/"` 가
                    // 되어 사용자가 무엇을 잃었는지도 모른다.
                    assert.strictEqual(endOf('"cp ${gen.|report.html dist/"').tail, 'gen.');
                });

                test('커서가 아직 `${` 를 지나지 않았으면 참조 자리가 아니다', () => {
                    // 막지 않으면 시작점이 커서보다 뒤가 되어 두 범위의 시작이
                    // 어긋나고 VS Code 가 항목을 조용히 버린다.
                    for (const fixture of ['"echo |${a.b}"', '"echo $|{a.b}"']) {
                        const { text, offset } = at(fixture);
                        assert.strictEqual(referencePrefixAt(text, offset), undefined, fixture);
                    }
                });

                test('end 는 커서보다 앞설 수 없다', () => {
                    // VS Code 는 대체 범위가 삽입 범위를 품고 커서를 포함하기를
                    // 요구한다 — 어기면 항목이 조용히 무시된다.
                    for (const fixture of ['"${a.b|   }"', '"${a.b|  ?? c.d}"', '"${a.b|"']) {
                        const { ref, offset } = endOf(fixture);
                        assert.ok(ref.end >= offset, `${fixture} → end=${ref.end}, cursor=${offset}`);
                        assert.ok(ref.start <= offset, fixture);
                    }
                });
            });

            test('돌려준 대안은 런타임이 읽는 대안과 같다', () => {
                // 이 모듈은 오프셋 때문에 따로 쪼갠다 — 쪼개는 규칙이 갈리면
                // 수락한 텍스트가 런타임에서 리터럴로 남는다. 왕복으로 묶어 둔다.
                for (const fixture of [
                    '"${a.x ?? b.|"',
                    '"${a.x ??b.|"',
                    '"${a.x ?? b.y ?? c.|"',
                    '"${?? a.|"',
                ]) {
                    const { text, offset } = at(fixture);
                    const ref = referencePrefixAt(text, offset)!;
                    const accepted = text.slice(0, ref.start) + ref.prefix + 'value';
                    const expr = accepted.slice(accepted.indexOf('${') + 2);
                    assert.ok(
                        parseReferenceAlternatives(expr).some(alt => alt.text === ref.prefix + 'value'),
                        `${fixture} → 런타임은 '${ref.prefix}value' 를 대안으로 보지 않는다: ` +
                        JSON.stringify(parseReferenceAlternatives(expr))
                    );
                }
            });
        });
    });

    suite('태스크 id 제안', () => {
        test('같은 액션의 다른 태스크 id 를 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${|"] }`));
            assert.ok(got.includes('pick'), got.join(','));
            assert.ok(got.includes('ask'), got.join(','));
        });

        test('자기 자신은 제안하지 않는다 (참조할 수 없다)', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${|"] }`));
            assert.ok(!got.includes('run'), got.join(','));
        });

        test('전역 참조도 함께 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "shell", "command": "echo \${|" }`));
            assert.ok(got.includes('workspaceFolder') && got.includes('extensionPath'), got.join(','));
        });
    });

    suite('결과 키 제안', () => {
        test('fileDialog 는 paths / names / count 까지 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${pick.|"] }`));
            for (const key of ['pick.paths', 'pick.names', 'pick.count', 'pick.path', 'pick.dir']) {
                assert.ok(got.includes(key), `${key} 가 없다: ${got.join(',')}`);
            }
        });

        test('타입마다 다른 키를 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${ask.|"] }`));
            assert.deepStrictEqual(got, ['ask.value']);
        });

        test('알 수 없는 태스크 id 에는 아무것도 내지 않는다', () => {
            assert.deepStrictEqual(names(doc(`{ "id": "run", "type": "shell", "command": "echo \${nosuch.|" }`)), []);
        });

        /**
         * `??` 체인 안에서는 **커서가 놓인 대안**의 태스크를 봐야 한다. 체인
         * 전체를 참조 하나로 읽으면 첫 대안의 태스크 키가 뜨고, 정작 사용자가
         * 치고 있는 태스크의 키는 목록에 없다.
         */
        test('?? 체인에서는 커서가 놓인 대안의 키를 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "command", "command": "py", "args": ["\${pick.path ?? ask.|"] }`));
            assert.deepStrictEqual(got, ['ask.value']);
        });

        test('?? 뒤의 알 수 없는 id 에는 아무것도 내지 않는다', () => {
            // 앞 대안이 멀쩡하다고 해서 그 태스크의 키를 대신 내놓으면 안 된다.
            assert.deepStrictEqual(
                names(doc(`{ "id": "run", "type": "shell", "command": "echo \${pick.path ?? nosuch.|" }`)),
                []
            );
        });

        test('커서가 앞 대안 안에 있으면 그 대안의 키를 낸다', () => {
            // 뒤에 이미 `ask.value` 가 적혀 있어도 커서는 앞 대안 안이다.
            const got = names(doc(`{ "id": "run", "type": "shell", "command": "echo \${pick.| ?? ask.value}" }`));
            assert.ok(got.includes('pick.paths'), got.join(','));
            assert.ok(!got.some(n => n.startsWith('ask.')), `뒤 대안의 키를 제안했다: ${got.join(',')}`);
        });

        test('?? 뒤에서 점을 아직 안 쳤으면 태스크 id 를 낸다', () => {
            const got = names(doc(`{ "id": "run", "type": "shell", "command": "echo \${pick.path ?? |" }`));
            assert.ok(got.includes('ask'), got.join(','));
            assert.ok(!got.includes('run'), `자기 자신을 제안했다: ${got.join(',')}`);
        });

        /**
         * `canPickMany` 는 **task 최상위 필드**다 (다이얼로그의 `canSelectMany`
         * 는 `options` 안이다). 최상위를 보지 않으면 다중 선택 quickPick 에서
         * `${id.values}` 가 영영 제안되지 않는다 — 시뮬레이션은 그 필드만 보고
         * 그 키를 만들기 때문이다. 자리를 하나로 넘겨 두면 아무 오류 없이
         * "그런 참조는 없다" 로 보인다.
         */
        const quickPickDoc = (extra: string) => `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "pick", "type": "quickPick", "items": ["x", "y"]${extra} },
    { "id": "run", "type": "shell", "command": "echo \${pick.|" }
  ] } }
]`;

        test('다중 선택 quickPick 은 values 를 제안한다', () => {
            const got = names(quickPickDoc(', "canPickMany": true'));
            assert.ok(got.includes('pick.values'), `values 가 없다: ${got.join(',')}`);
            assert.ok(got.includes('pick.value'), got.join(','));
        });

        test('단일 선택 quickPick 은 values 를 제안하지 않는다', () => {
            // 런타임이 만들지 않는 키다 — 제안하면 Preview 만 해석하고 실행에서는
            // 리터럴로 남는 참조를 우리가 권하는 셈이 된다. `label` · `valueList`
            // 는 선택 수와 무관하게 런타임이 늘 내므로 함께 제안한다.
            assert.deepStrictEqual(names(quickPickDoc('')), ['pick.value', 'pick.label', 'pick.valueList']);
        });

        test('output.capture 이름도 함께 낸다', () => {
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "build", "type": "shell", "command": "make", "passTheResultToNextTask": true,
      "output": { "capture": { "name": "version", "regex": "v(\\\\d+)" } } },
    { "id": "tag", "type": "shell", "command": "git tag \${build.|" }
  ] } }
]`;
            const got = names(fixture);
            assert.ok(got.includes('build.version'), got.join(','));
            assert.ok(got.includes('build.output'), `기본 결과 키도 함께 나와야 한다: ${got.join(',')}`);
        });

        test('캡처하지 않는 shell 의 output 은 제안하지 않는다', () => {
            // `passTheResultToNextTask` 가 없으면 런타임이 출력을 흘려보내고
            // `${id.output}` 은 해석되지 않는다 — Doctor 의 `output.not-captured`
            // 가 잡는 가장 흔한 설정 실수다. 그 참조를 제안하면 우리가 실수를
            // 권하는 셈이 된다.
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "build", "type": "shell", "command": "make" },
    { "id": "tag", "type": "shell", "command": "git tag \${build.|" }
  ] } }
]`;
            assert.deepStrictEqual(names(fixture), []);
        });

        /**
         * 캡처는 **결과에 문자열 `output` 이 있을 때만** 적용된다 (0.6.57).
         *
         * 런타임(`executeSingleTask`)은 `result.output` 이 문자열일 때만
         * `applyOutputCapture` 를 부른다. 타입 이름으로 가르면 그 규칙이 두
         * 곳에 생기고, 실제로 `fileDialog` 에 `output.capture` 를 적어 둔
         * 액션에서 만들어지지도 않는 `${pick.version}` 이 제안됐다.
         */
        test('문자열 출력이 없는 타입의 capture 이름은 제안하지 않는다', () => {
            for (const type of ['fileDialog', 'folderDialog']) {
                const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "pick", "type": "${type}",
      "output": { "capture": { "name": "version", "regex": "v(\\\\d+)" } } },
    { "id": "run", "type": "shell", "command": "echo \${pick.|" }
  ] } }
]`;
                const got = names(fixture);
                assert.ok(!got.includes('pick.version'),
                    `${type}: 런타임이 만들지 않는 변수를 제안했다 — ${got.join(',')}`);
                assert.ok(got.includes('pick.path'), `${type}: 정상 결과 키까지 사라졌다 — ${got.join(',')}`);
            }
        });

        test('stringManipulation 의 capture 이름은 제안한다', () => {
            // 이쪽은 `passTheResultToNextTask` 없이도 문자열 output 을 낸다.
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "slug", "type": "stringManipulation", "function": "trim", "input": "x",
      "output": { "capture": { "name": "ticket", "regex": "([A-Z]+-\\\\d+)" } } },
    { "id": "run", "type": "shell", "command": "echo \${slug.|" }
  ] } }
]`;
            const got = names(fixture);
            assert.ok(got.includes('slug.ticket'), got.join(','));
            assert.ok(got.includes('slug.output'), got.join(','));
        });

        test('캡처하지 않는 shell 은 capture 이름도 제안하지 않는다', () => {
            // 키 목록이 비어도 capture 이름을 무조건 덧붙이면 `${build.version}`
            // 이 제안된다 — 런타임에서는 리터럴로 남는 참조다.
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "build", "type": "shell", "command": "make",
      "output": { "capture": { "name": "version", "regex": "v(\\\\d+)" } } },
    { "id": "tag", "type": "shell", "command": "git tag \${build.|" }
  ] } }
]`;
            assert.deepStrictEqual(names(fixture), []);
        });
    });

    suite('편집 중인(깨진) 문서', () => {
        test('닫히지 않은 괄호가 있어도 제안한다', () => {
            // 자동완성은 사용자가 **입력하는 도중**에 불린다 — 그 순간의 문서는
            // 거의 항상 유효한 JSON 이 아니다. JSON.parse 에 기대면 정작
            // 필요한 순간에 아무것도 나오지 않는다.
            const fixture = `[
  { "id": "a", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "pick", "type": "folderDialog", "options": { "canSelectMany": true } },
    { "id": "run", "type": "command", "command": "py", "args": ["\${pick.|`;
            const got = names(fixture);
            assert.ok(got.includes('pick.paths'), got.join(','));
        });

        test('다른 액션의 태스크는 섞이지 않는다', () => {
            const fixture = `[
  { "id": "a1", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "otherTask", "type": "inputBox", "prompt": "x" }
  ] } },
  { "id": "a2", "title": "t", "action": { "description": "d", "tasks": [
    { "id": "pick", "type": "fileDialog" },
    { "id": "run", "type": "shell", "command": "echo \${|" }
  ] } }
]`;
            const got = names(fixture);
            assert.ok(got.includes('pick'), got.join(','));
            assert.ok(!got.includes('otherTask'), `다른 액션의 태스크는 참조할 수 없다: ${got.join(',')}`);
        });

        /**
         * 폴더(`children`) 안의 액션들 (0.6.57).
         *
         * 바깥 객체를 액션으로 보고 **첫** `"tasks"` 를 집으면, 두 번째 자식을
         * 편집할 때 첫 번째 자식의 태스크가 제안된다 — 참조할 수 없는 id 를
         * 권하는 셈이다. 커서를 품은 **가장 안쪽** tasks 배열을 찾아야 한다.
         */
        const folderDoc = (cursorIn: 'first' | 'second' | 'third') => {
            const mark = (which: string) => which === cursorIn ? '|' : '';
            return `[
  { "id": "folder", "title": "F", "children": [
    { "id": "a1", "title": "one", "action": { "description": "d", "tasks": [
      { "id": "t-first", "type": "inputBox", "prompt": "x" },
      { "id": "r1", "type": "shell", "command": "echo \${${mark('first')}" }
    ] } },
    { "id": "a2", "title": "two", "action": { "description": "d", "tasks": [
      { "id": "t-second", "type": "fileDialog" },
      { "id": "r2", "type": "shell", "command": "echo \${${mark('second')}" }
    ] } },
    { "id": "a3", "title": "three", "action": { "description": "d", "tasks": [
      { "id": "t-third", "type": "folderDialog" },
      { "id": "r3", "type": "shell", "command": "echo \${${mark('third')}" }
    ] } }
  ] }
]`;
        };

        test('폴더의 두 번째 자식은 자기 액션의 태스크만 제안한다', () => {
            const got = names(folderDoc('second'));
            assert.ok(got.includes('t-second'), got.join(','));
            assert.ok(!got.includes('t-first') && !got.includes('t-third'),
                `다른 액션의 태스크가 섞였다: ${got.join(',')}`);
        });

        test('폴더의 세 번째 자식도 마찬가지다', () => {
            const got = names(folderDoc('third'));
            assert.ok(got.includes('t-third'), got.join(','));
            assert.ok(!got.includes('t-first') && !got.includes('t-second'), got.join(','));
        });

        test('폴더의 첫 번째 자식은 종전대로 동작한다', () => {
            const got = names(folderDoc('first'));
            assert.ok(got.includes('t-first'), got.join(','));
            assert.ok(!got.includes('t-second'), got.join(','));
        });

        test('참조 자리가 아니면 빈 목록', () => {
            assert.deepStrictEqual(names(doc(`{ "id": "run", "type": "shell", "command": "echo hi|" }`)), []);
        });
    });

    /**
     * 결과 키의 출처를 `simulateTaskResult` 하나로 둔 이유.
     * 태스크에 결과 키가 하나 늘면 Preview · Doctor · 자동완성이 함께 는다.
     */
    test('결과 키가 Preview/Doctor 와 같은 출처를 쓴다', () => {
        const { simulateTaskResult } = require('../previewRun');
        const expected = Object.keys(simulateTaskResult({ id: 'pick', type: 'fileDialog', options: { canSelectMany: true } }));
        const got = names(doc(`{ "id": "run", "type": "shell", "command": "echo \${pick.|" }`));
        assert.deepStrictEqual(got, expected.map(k => `pick.${k}`));
    });
});
