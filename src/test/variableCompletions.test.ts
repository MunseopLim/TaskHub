import * as assert from 'assert';
import { collectVariableCompletions, referencePrefixAt } from '../variableCompletions';

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
         * 캡처는 **결과에 문자열 `output` 이 있을 때만** 적용된다 (0.6.60).
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
         * 폴더(`children`) 안의 액션들 (0.6.59).
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
