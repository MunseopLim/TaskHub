import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * `${…}` 참조 자동완성 provider 의 **글루**를 실제로 구동하는 테스트.
 *
 * 순수 모듈(`collectVariableCompletions` / `referencePrefixAt`)은
 * `variableCompletions.test.ts` 가 촘촘히 본다. 그 결과를 `CompletionItem` 으로
 * 옮기는 자리 — `item.range` · `insertText` · document selector 세 개 — 는
 * `vscode` 에 붙어 있어 그쪽에서 지나갈 수 없다. 여기서 본다.
 *
 * **왜 range 를 단언하는가.** provider 가 `range` 를 주지 않으면 VS Code 는 기본
 * 단어 범위로 대체하는데, JSON 에서 `.` 은 단어 구분자라 이미 입력한 `pick.` 이
 * 그대로 남고 그 뒤에 `pick.paths` 가 **덧붙는다** (`${pick.pick.paths}`). 오류가
 * 나지 않으므로 조용히 잘못된 텍스트가 들어간다. 같은 이유로 `insertText` 는
 * 키(`paths`)가 아니라 참조 전체(`pick.paths`)여야 range 와 짝이 맞는다.
 *
 * 파일은 디스크에 만든다 — selector 가 `scheme: 'file'` 이라 인메모리(untitled)
 * 문서로는 물리지 않는다.
 */
suite('${…} 자동완성 provider (등록 · range · selector)', function () {
    this.timeout(20000);

    /** 커서 자리. 파일에 쓰기 전에 지운다. */
    const CURSOR = '|';
    const FIXTURE = `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog", "options": { "canSelectMany": true } },
        { "id": "run", "type": "shell", "command": "echo \${pick.${CURSOR}" }
      ]
    }
  }
]`;

    /**
     * `??` 체인 중간. 커서는 **두 번째** 대안의 점 뒤에 있다.
     *
     * 여기가 이 파일에서 가장 아픈 자리다 — range 가 `${` 바로 뒤에서 시작하면
     * 항목을 고르는 순간 `${pick.` 이 아니라 표현식 **전체**가 대체되어 사용자가
     * 친 앞쪽 대안이 조용히 사라진다.
     */
    const COALESCE_FIXTURE = `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog", "options": { "canSelectMany": true } },
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${pick.path ?? ask.${CURSOR}" }
      ]
    }
  }
]`;

    /**
     * 낱말 **중간**에 커서가 있는 형태. `editor.suggest.insertMode` 가 `replace`
     * 인 사용자는 꼬리(`lue`)가 사라져야 하고, `insert` 인 사용자는 남아야 한다 —
     * 범위를 하나만 주면 설정과 무관하게 늘 남는다.
     */
    const MID_TOKEN_FIXTURE = `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${ask.va${CURSOR}lue}" }
      ]
    }
  }
]`;

    /**
     * `??` 체인 **이면서** 커서 뒤에 꼬리가 있는 형태. 두 규칙(대안 경계와 낱말
     * 끝)이 동시에 걸리는 유일한 자리라, `end` 가 어긋나면 앞 대안을 지우거나
     * 뒤 대안을 삼킨다.
     */
    const CHAIN_MID_TOKEN_FIXTURE = `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog" },
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${pick.path ?? ask.va${CURSOR}lue}" }
      ]
    }
  }
]`;

    /** `${` 바로 뒤 — 점이 없는 분기(태스크 id · 전역 참조). */
    const NO_DOT_FIXTURE = `[
  {
    "id": "a.multi",
    "title": "multi",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog", "options": { "canSelectMany": true } },
        { "id": "run", "type": "shell", "command": "echo \${${CURSOR}" }
      ]
    }
  }
]`;

    let tempDir: string;

    suiteSetup(async () => {
        // provider 는 `activate()` 안에서 등록된다. `onStartupFinished` 로 이미
        // 떠 있는 것이 보통이지만, 레이스를 남기지 않도록 명시적으로 기다린다.
        const ext = vscode.extensions.getExtension('Munseop.taskhub');
        assert.ok(ext, '확장을 찾지 못했다 — publisher.name 이 바뀌었는지 확인할 것');
        await ext.activate();
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-completion-')));
    });

    suiteTeardown(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    /** 경로마다 한 번 쓴 내용. 같은 경로에 다른 내용을 쓰는 것을 막는다. */
    const written = new Map<string, string>();

    async function openFixture(relPath: string, fixture: string = FIXTURE): Promise<{ doc: vscode.TextDocument; position: vscode.Position }> {
        const full = path.join(tempDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const offset = fixture.indexOf(CURSOR);
        assert.ok(offset >= 0, '픽스처에 커서가 없다');
        const text = fixture.slice(0, offset) + fixture.slice(offset + 1);
        // `openTextDocument` 는 이미 열린 URI 에 **캐시된 모델**을 돌려주므로
        // 디스크를 다시 읽지 않는다. 같은 경로에 다른 내용을 쓰면 조용히 옛
        // 내용을 보게 되니, 픽스처가 다르면 경로도 달라야 한다.
        const previous = written.get(full);
        assert.ok(previous === undefined || previous === text, `같은 경로에 다른 픽스처를 썼다: ${relPath}`);
        written.set(full, text);
        fs.writeFileSync(full, text, 'utf8');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
        return { doc, position: doc.positionAt(offset) };
    }

    /**
     * trigger character 로 `.` 을 넘겨 실제 입력에 가깝게 부른다.
     *
     * **이것으로 등록 목록을 검증할 수는 없다.** 이 명령은 trigger character 로
     * provider 를 거르지 않는다 — 거르는 것은 편집기의 SuggestModel 이고 명령은
     * 그 자리를 비운 채 registry 전체에 묻는다. 그래서 등록에서 `.` 이 빠져도
     * 아래 테스트들은 전부 통과한다(실제로 지워 보고 확인했다). 그 자리는
     * 마지막의 소스 가드가 맡는다.
     */
    async function completionsAt(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, position, '.'
        );
        return list?.items ?? [];
    }

    const labelOf = (item: vscode.CompletionItem): string =>
        typeof item.label === 'string' ? item.label : item.label.label;

    /** 단일 Range 로 준 것이 명령 경계를 넘으며 insert/replace 쌍이 될 수 있다. */
    function replaceRangeOf(item: vscode.CompletionItem): vscode.Range | undefined {
        if (!item.range) { return undefined; }
        return item.range instanceof vscode.Range ? item.range : item.range.replacing;
    }

    function insertRangeOf(item: vscode.CompletionItem): vscode.Range | undefined {
        if (!item.range) { return undefined; }
        return item.range instanceof vscode.Range ? item.range : item.range.inserting;
    }

    test('이미 입력한 `pick.` 을 덮는 range 로 참조 전체를 넣는다', async () => {
        const { doc, position } = await openFixture(path.join('.vscode', 'actions.json'));
        const items = await completionsAt(doc, position);

        const item = items.find(i => labelOf(i) === 'pick.paths');
        assert.ok(item, `\${pick. 뒤에서 pick.paths 를 제안하지 않았다: ${items.map(labelOf).join(',')}`);

        const range = replaceRangeOf(item);
        assert.ok(range, 'range 가 없으면 VS Code 가 기본 단어 범위를 쓰고 `pick.` 뒤에 덧붙는다');
        assert.strictEqual(
            doc.getText(range), 'pick.',
            'range 는 이미 입력한 부분을 정확히 덮어야 한다 — 좁으면 덧붙고 넓으면 `${` 를 먹는다'
        );
        assert.strictEqual(
            item.insertText, 'pick.paths',
            'range 가 `pick.` 을 덮으므로 넣는 것도 참조 전체여야 한다 (키만 넣으면 `${paths}`)'
        );
        // detail 은 순수 모듈이 낸 종류를 `describeVariableCompletion` 이 문구로
        // 옮긴 것이다. 그 연결이 끊기면 위젯 오른쪽이 빈 채로 뜬다.
        assert.ok(
            item.detail?.includes('fileDialog'),
            `detail 이 태스크 타입을 담지 않았다: ${item.detail}`
        );
    });

    test('제안 전체가 range 와 짝이 맞는다', async () => {
        // 하나만 보면 다른 키에서 어긋나는 회귀를 놓친다. 결과 키든 태스크 id 든
        // 이 자리에서는 전부 `pick.` 을 대체하는 참조여야 한다.
        const { doc, position } = await openFixture(path.join('.vscode', 'actions.json'));
        const ours = (await completionsAt(doc, position)).filter(i => labelOf(i).startsWith('pick.'));
        assert.ok(ours.length >= 2, `제안이 너무 적다: ${ours.map(labelOf).join(',')}`);
        for (const item of ours) {
            const range = replaceRangeOf(item);
            assert.ok(range && doc.getText(range) === 'pick.', `range 가 어긋났다: ${labelOf(item)}`);
            assert.strictEqual(item.insertText, labelOf(item), `insertText 가 라벨과 다르다: ${labelOf(item)}`);
        }
    });

    test('낱말 중간에서는 insert/replace 두 범위를 준다', async () => {
        const { doc, position } = await openFixture(path.join('midtoken', '.vscode', 'actions.json'), MID_TOKEN_FIXTURE);
        const items = await completionsAt(doc, position);

        const item = items.find(i => labelOf(i) === 'ask.value');
        assert.ok(item, `ask.value 를 제안하지 않았다: ${items.map(labelOf).join(',')}`);

        // 범위를 하나만 주면 VS Code 가 두 모드에 같은 것을 써서, replace 를
        // 고른 사용자도 꼬리를 떠안는다.
        assert.ok(!(item.range instanceof vscode.Range), 'insert/replace 쌍이 아니라 단일 range 다');

        const inserting = insertRangeOf(item)!;
        const replacing = replaceRangeOf(item)!;
        assert.strictEqual(doc.getText(inserting), 'ask.va', 'insert 는 커서까지만 덮는다');
        assert.strictEqual(doc.getText(replacing), 'ask.value', 'replace 는 낱말 끝까지 덮는다');

        // VS Code 의 요구 조건 — 어기면 항목이 조용히 무시된다.
        assert.ok(replacing.contains(inserting), 'replace 가 insert 를 품어야 한다');
        assert.ok(inserting.start.isEqual(replacing.start), '두 범위의 시작이 같아야 한다');

        // 수락 결과: replace 모드에서 꼬리가 남지 않는다.
        const applied = doc.getText().slice(0, doc.offsetAt(replacing.start))
            + String(item.insertText)
            + doc.getText().slice(doc.offsetAt(replacing.end));
        assert.ok(applied.includes('${ask.value}'), applied.split('\n').find(l => l.includes('echo')));
        assert.ok(!applied.includes('valuelue'), applied.split('\n').find(l => l.includes('echo')));
    });

    test('?? 체인 안의 낱말 중간에서도 그 대안만 덮는다', async () => {
        const { doc, position } = await openFixture(
            path.join('chainmid', '.vscode', 'actions.json'), CHAIN_MID_TOKEN_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'ask.value');
        assert.ok(item, '?? 뒤 낱말 중간에서 ask.value 를 제안하지 않았다');

        const replacing = replaceRangeOf(item)!;
        assert.strictEqual(doc.getText(replacing), 'ask.value',
            '대체 범위가 대안 하나를 정확히 덮어야 한다 — 넓으면 앞 대안을, 좁으면 꼬리를 남긴다');

        const applied = doc.getText().slice(0, doc.offsetAt(replacing.start))
            + String(item.insertText)
            + doc.getText().slice(doc.offsetAt(replacing.end));
        assert.ok(applied.includes('${pick.path ?? ask.value}'),
            applied.split('\n').find(l => l.includes('echo')));
    });

    test('?? 체인에서는 커서가 놓인 대안만 덮는다 (앞 대안을 지우지 않는다)', async () => {
        const { doc, position } = await openFixture(path.join('coalesce', '.vscode', 'actions.json'), COALESCE_FIXTURE);
        const items = await completionsAt(doc, position);

        const item = items.find(i => labelOf(i) === 'ask.value');
        assert.ok(item, `?? 뒤에서 ask.value 를 제안하지 않았다: ${items.map(labelOf).join(',')}`);

        const range = replaceRangeOf(item);
        assert.ok(range, 'range 가 없으면 VS Code 기본 단어 범위가 쓰여 덧붙는다');
        assert.strictEqual(
            doc.getText(range), 'ask.',
            'range 가 넓으면 앞 대안(`pick.path ?? `)까지 먹어 사용자가 친 것이 사라진다'
        );

        // 실제로 수락했을 때 문서가 어떻게 되는지까지 본다 — range 만 맞아도
        // 조합이 어긋나면 사용자가 보는 결과는 여전히 깨진다.
        const applied = doc.getText().slice(0, doc.offsetAt(range.start))
            + String(item.insertText)
            + doc.getText().slice(doc.offsetAt(range.end));
        assert.ok(
            applied.includes('${pick.path ?? ask.value'),
            `수락 결과에 앞 대안이 남지 않았다: ${applied.split('\n').find(l => l.includes('echo'))}`
        );

        // 앞 대안의 태스크 키를 이 자리에서 제안하면 안 된다 — 고르면 체인이
        // 통째로 그 참조로 바뀐다.
        assert.ok(
            !items.some(i => labelOf(i).startsWith('pick.')),
            `앞 대안의 키를 제안했다: ${items.map(labelOf).join(',')}`
        );
    });

    test('점이 없는 자리에서는 커서 위치를 덮는 빈 range 로 태스크 id 를 낸다', async () => {
        // 결과 키 분기와 range 계산이 다르다 — 여기서는 대체할 것이 없으므로
        // 빈 range 여야 하고, 넣는 것은 참조 이름 그대로다.
        const { doc, position } = await openFixture(path.join('nodot', '.vscode', 'actions.json'), NO_DOT_FIXTURE);
        const items = await completionsAt(doc, position);
        const names = items.map(labelOf);
        assert.ok(names.includes('pick'), `다른 태스크 id 를 내지 않았다: ${names.join(',')}`);
        assert.ok(names.includes('workspaceFolder'), `전역 참조를 내지 않았다: ${names.join(',')}`);

        const item = items.find(i => labelOf(i) === 'pick')!;
        const range = replaceRangeOf(item);
        assert.ok(range, 'range 가 없으면 앞 단어(`echo`)까지 먹을 수 있다');
        assert.strictEqual(doc.getText(range), '', '입력한 것이 없으므로 대체할 범위도 비어 있어야 한다');
        assert.strictEqual(item.insertText, 'pick');
    });

    test('selector 세 곳에서 모두 뜬다', async () => {
        // 등록된 세 패턴에 각각 대응한다. 하나가 빠지면 그 파일을 편집하는
        // 사용자에게는 기능이 아예 없는 것과 같다.
        const covered = [
            path.join('.vscode', 'actions.json'),
            path.join('.vscode', 'presets', 'my-preset.json'),
            path.join('media', 'actions_example.json'),
        ];
        for (const rel of covered) {
            const { doc, position } = await openFixture(rel);
            const names = (await completionsAt(doc, position)).map(labelOf);
            assert.ok(names.includes('pick.paths'), `${rel} 에서 제안이 없다: ${names.join(',')}`);
        }
    });

    test('selector 밖의 json 에는 뜨지 않는다', async () => {
        // 음성 대조군 — 위 세 개가 "아무 json 이나 물어서" 통과한 것이 아님을
        // 보인다. 임의의 json 에 붙으면 무관한 파일에서 엉뚱한 제안이 뜬다.
        const { doc, position } = await openFixture(path.join('notes', 'scratch.json'));
        const names = (await completionsAt(doc, position)).map(labelOf);
        assert.ok(!names.includes('pick.paths'), `selector 밖에서도 제안이 떴다: ${names.join(',')}`);
    });

    test('트리거 문자 `{` 와 `.` 이 등록돼 있다 (소스 가드)', () => {
        // 이 하나만 소스를 읽는 이유는 `completionsAt` 의 주석에 적었다 — 명령
        // 경로로는 등록 목록을 관찰할 수 없다. 이것이 빠지면 사용자는 `${pick.`
        // 까지 치고도 위젯을 못 보고, 위 테스트들은 전부 통과한다.
        const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'extension.ts'), 'utf-8');
        const at = source.indexOf('registerCompletionItemProvider(');
        assert.ok(at >= 0, 'provider 등록을 찾지 못했다 — 이 가드가 무력화됐다');
        const call = source.slice(at, source.indexOf('\n    );', at));
        assert.ok(/'\{',\s*'\.'/.test(call), `트리거 문자가 빠졌다:\n${call.slice(-200)}`);
    });
});
