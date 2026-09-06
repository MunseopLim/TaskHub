import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

suite('JSON 스키마 편집 지원 (VS Code JSON language service)', function () {
    this.timeout(30000);

    let tempDir: string;
    let sequence = 0;
    const marker = '/*cursor*/';
    const labelOf = (item: vscode.CompletionItem): string =>
        typeof item.label === 'string' ? item.label : item.label.label;
    const wrap = (task: string): string =>
        `[{"id":"a.demo","title":"Demo","action":{"description":"Demo","tasks":[${task}]}}]`;

    async function openFixture(text: string, relativePath = '.vscode/actions.json') {
        const offset = text.indexOf(marker);
        assert.ok(offset >= 0, '커서 표시가 필요하다');
        const file = path.join(tempDir, String(sequence++), relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text.replace(marker, ''), 'utf8');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        return { doc, position: doc.positionAt(offset) };
    }

    async function getItems(doc: vscode.TextDocument, position: vscode.Position) {
        const result = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider', doc.uri, position
        );
        return result?.items ?? [];
    }

    async function suggest(task: string, relativePath?: string) {
        const { doc, position } = await openFixture(wrap(task), relativePath);
        return (await getItems(doc, position)).map(labelOf).sort();
    }

    suiteSetup(async () => {
        await vscode.extensions.getExtension('Munseop.taskhub')!.activate();
        await vscode.extensions.getExtension('vscode.json-language-features')!.activate();
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-json-schema-')));
        const { doc, position } = await openFixture(wrap(`{"type":"command",${marker}}`));
        // JSON 서버의 provider 등록과 manifest 스키마 연결이 끝난 뒤 검사한다.
        // 개별 테스트는 재시도하지 않으므로 잘못된 추천을 기다려서 숨기지 않는다.
        const deadline = Date.now() + 15000;
        while (!(await getItems(doc, position)).some(item => labelOf(item) === 'timeoutSeconds')) {
            assert.ok(Date.now() < deadline, 'JSON 스키마 자동완성 준비 시간 초과');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    });

    suiteTeardown(() => {
        if (tempDir) { fs.rmSync(tempDir, { recursive: true, force: true }); }
    });

    const common = [
        'id', 'when', 'dependsOn', 'parallel', 'timeoutSeconds', 'continueOnError',
        'output', 'passTheResultToNextTask', 'allowSecretContent',
    ];
    const byType: Record<string, string[]> = {
        command: ['command', 'args', 'cwd', 'env', 'revealTerminal', 'isOneShot', 'forEach'],
        shell: ['command', 'args', 'cwd', 'env', 'revealTerminal', 'isOneShot', 'forEach'],
        fileDialog: ['options'],
        folderDialog: ['options'],
        pathDialog: ['mode', 'options'],
        inputBox: ['prompt', 'value', 'placeHolder', 'password', 'prefix', 'suffix', 'validatePattern', 'validateMessage', 'extractPattern'],
        quickPick: ['items', 'placeHolder', 'canPickMany', 'default', 'allowCustom', 'rememberLastSelection', 'itemsFromCommand', 'itemsFromCommandFormat', 'itemsExclude', 'cwd'],
        envPick: ['placeHolder'],
        confirm: ['message', 'confirmLabel', 'cancelLabel'],
        zip: ['tool', 'source', 'archive', 'cwd', 'env', 'forEach'],
        unzip: ['tool', 'inputs', 'archive', 'destination', 'cwd', 'env', 'forEach'],
        stringManipulation: ['function', 'input', 'forEach'],
        writeFile: ['path', 'content', 'encoding', 'eol', 'overwrite', 'mkdirs', 'forEach'],
        appendFile: ['path', 'content', 'encoding', 'eol', 'mkdirs', 'forEach'],
        browser: ['url', 'target', 'cwd'],
    };

    for (const [type, fields] of Object.entries(byType)) {
        test(`${type}: 필수 필드 작성 전에도 공통·해당 타입 필드만 추천한다`, async () => {
            const names = await suggest(`{"type":"${type}",${marker}}`);
            assert.deepStrictEqual(names, [...common, ...fields].sort());
        });
    }

    test('type 미지정·미완성 값에서는 id/type과 공통 필드부터 안내한다', async () => {
        assert.deepStrictEqual(await suggest(`{${marker}}`), [...common, 'type'].sort());
        assert.deepStrictEqual(await suggest(`{"type":"comm",${marker}}`), [...common].sort());
    });

    test('다른 타입의 기존 필드나 잘못된 값이 있어도 type을 기준으로 추천한다', async () => {
        const names = await suggest(`{"type":"command","id":42,"options":{},"args":false,${marker}}`);
        assert.deepStrictEqual(names, [...common, ...byType.command].filter(key => !['id', 'args'].includes(key)).sort());
    });

    test('기존 default·forEach 검증 조건에서 무관한 추천이 새어 나오지 않는다', async () => {
        const names = await suggest(`{"type":"zip","default":[],"forEach":[],${marker}}`);
        assert.deepStrictEqual(names, [...common, ...byType.zip].filter(key => key !== 'forEach').sort());
    });

    test('입력 중인 키와 type보다 앞에 있는 커서에서도 해당 타입을 따른다', async () => {
        const names = await suggest(`{"co${marker}":null,"type":"command"}`);
        assert.ok(names.includes('command'), names.join(', '));
        assert.ok(!names.includes('confirmLabel'), names.join(', '));
        assert.ok(!names.includes('content'), names.join(', '));
    });

    test('switch 바깥에서는 분기 기본값을 설정할 수 있다', async () => {
        const names = await suggest(`{"type":"switch",${marker}}`);
        const inherited = new Set(['on', 'cases', 'defaultCase']);
        for (const type of ['command', 'shell', 'zip', 'unzip', 'stringManipulation', 'writeFile', 'appendFile', 'browser']) {
            for (const key of byType[type]) {
                if (key !== 'forEach') { inherited.add(key); }
            }
        }
        assert.deepStrictEqual(names, [...common, ...inherited].sort());
    });

    test('switch case와 defaultCase에서도 내부 type에 맞는 실행 필드만 추천한다', async () => {
        for (const field of ['"cases":{"run":', '"defaultCase":']) {
            const end = field.startsWith('"cases"') ? '}' : '';
            for (const type of ['command', 'shell', 'zip', 'unzip', 'stringManipulation', 'writeFile', 'appendFile', 'browser']) {
                const names = await suggest(`{"type":"switch",${field}{"type":"${type}",${marker}}${end}}`);
                const expected = ['allowSecretContent', 'output', 'passTheResultToNextTask', ...byType[type].filter(key => key !== 'forEach')];
                assert.deepStrictEqual(names, expected.sort(), `${field} ${type}`);
            }
        }
    });

    test('중첩 options·output의 필드 추천을 유지한다', async () => {
        const options = await suggest(`{"type":"fileDialog","options":{${marker}}}`);
        assert.ok(options.includes('canSelectMany'), options.join(', '));
        assert.ok(options.includes('filters'), options.join(', '));
        assert.ok(!options.includes('command'), options.join(', '));
        const output = await suggest(`{"type":"inputBox","output":{${marker}}}`);
        assert.ok(output.includes('mode'), output.join(', '));
        assert.ok(output.includes('capture'), output.join(', '));
    });

    test('OS별 command 키와 browser target 허용값을 계속 추천한다', async () => {
        assert.deepStrictEqual(await suggest(`{"type":"command","command":{${marker}}}`), ['linux', 'macos', 'windows']);
        assert.deepStrictEqual(await suggest(`{"type":"browser","target":${marker}}`), ['"default"', '"integrated"']);
    });

    test('워크스페이스 프리셋과 번들 예제에도 스키마가 연결된다', async () => {
        for (const file of ['.vscode/presets/demo.json', 'media/actions_example.json']) {
            assert.deepStrictEqual(await suggest(`{"type":"fileDialog",${marker}}`, file), [...common, 'options'].sort());
        }
    });

    test('추천 상세 설명에 실제 command·args 입력 예제가 표시된다', async () => {
        const { doc, position } = await openFixture(wrap(`{"type":"command",${marker}}`));
        const items = await getItems(doc, position);
        const documentation = (key: string): string => {
            const value = items.find(item => labelOf(item) === key)?.documentation;
            return typeof value === 'string' ? value : value?.value ?? '';
        };
        assert.match(documentation('command'), /probe\.cjs/);
        assert.match(documentation('command'), /인자 세 개/);
        assert.match(documentation('args'), /two words/);
        assert.match(documentation('args'), /본문 맨 뒤/);
    });

    test('기존 무관 필드와 다른 설정 파일의 hover도 설명·예제를 보여준다', async () => {
        const fixtures = [
            { file: '.vscode/actions.json', text: wrap(`{"type":"inputBox","comm${marker}and":"node"}`), words: ['probe', 'two words', '인자 세 개'] },
            { file: '.vscode/links.json', text: `[{"ti${marker}tle":"문서","link":"https://example.com"}]`, words: ['Example:', 'title'] },
            { file: '.vscode/favorites.json', text: `[{"title":"Main","pa${marker}th":"src/main.c"}]`, words: ['Example:', 'workspaceFolder'] },
            { file: '.vscode/taskhub_types.json', text: `{"types":{"pointer":{"si${marker}ze":8,"alignment":8}}}`, words: ['Example:', '바이트'] },
            { file: '.vscode/actions.json', text: wrap(`{"type":"fileDialog","options":{"default${marker}Uri":"\${workspaceFolder}"}}`), words: ['defaultUri', '예'] },
        ];
        for (const fixture of fixtures) {
            const { doc, position } = await openFixture(fixture.text, fixture.file);
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
            const contents = (hovers ?? []).flatMap(hover => hover.contents)
                .map(content => typeof content === 'string' ? content : content.value).join('\n');
            for (const word of fixture.words) {
                assert.ok(contents.includes(word), `${fixture.file}: ${word} 설명 누락: ${contents}`);
            }
        }
    });
});

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

    /**
     * 점이 **없는** 자리인데 커서 뒤에는 이미 `.key` 가 있는 형태. 여기서
     * `insertText` 는 맨 id 라, 대체 범위를 대안 끝까지 잡으면 `.value` 가 함께
     * 지워져 `${ask}` 가 된다 — 오류도 안 나고, bare 참조는 `output`/`outputDir`
     * 폴백을 타 **사용자가 쓰던 것과 다른 값**을 가리킨다.
     */
    const NO_DOT_MID_FIXTURE = `[
  {
    "id": "a.nodotmid",
    "title": "nodotmid",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${as${CURSOR}k.value}" }
      ]
    }
  }
]`;

    /**
     * 공백이 든 task id. 스키마가 막지 않고 런타임도 해석하는데, 대안 경계는
     * 공백에서 끊긴다 — 범위(`my`)와 넣는 글자(`my task`)가 어긋나는 유일한 자리다.
     * `insert` 모드에서도 걸리므로 range 를 쪼개기 전부터 있던 결함이다.
     */
    const SPACED_ID_FIXTURE = `[
  {
    "id": "a.spacedid",
    "title": "spacedid",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "my task", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${my${CURSOR} task.value}" }
      ]
    }
  }
]`;

    /** 닫는 `}` 가 없고 커서 뒤가 사용자의 명령 인자인 형태. */
    const UNCLOSED_TAIL_FIXTURE = `[
  {
    "id": "a.unclosed",
    "title": "unclosed",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "gen", "type": "inputBox", "prompt": "name" },
        { "id": "run", "type": "shell", "command": "cp \${gen.${CURSOR}report.html dist/" }
      ]
    }
  }
]`;

    /** 커서가 `??` 연산자 **안**에 있는 형태. */
    const IN_OPERATOR_FIXTURE = `[
  {
    "id": "a.inop",
    "title": "inop",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "pick", "type": "fileDialog" },
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${pick.path ?${CURSOR}? ask.value}" }
      ]
    }
  }
]`;

    /** 항목을 수락했을 때 문서가 어떻게 되는가. */
    function applyItem(doc: vscode.TextDocument, item: vscode.CompletionItem): string {
        const replacing = replaceRangeOf(item)!;
        return doc.getText().slice(0, doc.offsetAt(replacing.start))
            + String(item.insertText)
            + doc.getText().slice(doc.offsetAt(replacing.end));
    }

    test('점이 없는 자리에서 뒤에 `.key` 가 있으면 id 만 덮는다', async () => {
        const { doc, position } = await openFixture(
            path.join('nodotmid', '.vscode', 'actions.json'), NO_DOT_MID_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'ask');
        assert.ok(item, '점 없는 자리에서 태스크 id 를 제안하지 않았다');

        const replacing = replaceRangeOf(item)!;
        assert.strictEqual(doc.getText(replacing), 'ask',
            '넣는 것은 맨 id 인데 범위가 `ask.value` 면 `.value` 가 지워진다');

        const applied = applyItem(doc, item);
        assert.ok(applied.includes('${ask.value}'), applied.split('\n').find(l => l.includes('echo')));
        // `${ask}` 는 유효한 참조 모양이라 사용자가 되돌릴 이유를 못 알아챈다.
        assert.ok(!applied.includes('${ask}'), '`.value` 가 지워져 bare 참조가 됐다');
    });

    test('공백이 든 task id 를 골라도 뒤쪽이 겹쳐 남지 않는다', async () => {
        const { doc, position } = await openFixture(
            path.join('spacedid', '.vscode', 'actions.json'), SPACED_ID_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'my task');
        assert.ok(item, '공백이 든 id 를 제안하지 않았다');

        assert.strictEqual(doc.getText(replaceRangeOf(item)!), 'my task',
            '범위가 `my` 뿐이면 `my task` 를 넣어 `${my task task.value}` 가 된다');

        const applied = applyItem(doc, item);
        assert.ok(applied.includes('${my task.value}'), applied.split('\n').find(l => l.includes('echo')));
        assert.ok(!applied.includes('task task'), applied.split('\n').find(l => l.includes('echo')));
    });

    test('닫히지 않은 참조에서는 사용자의 명령 인자를 삼키지 않는다', async () => {
        const { doc, position } = await openFixture(
            path.join('unclosed', '.vscode', 'actions.json'), UNCLOSED_TAIL_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'gen.value');
        assert.ok(item, '닫히지 않은 참조에서 결과 키를 제안하지 않았다');

        assert.strictEqual(doc.getText(replaceRangeOf(item)!), 'gen.',
            '`report.html` 이 참조의 속성인지 인자인지 알 수 없으므로 커서로 죄어야 한다');

        const applied = applyItem(doc, item);
        // 꼬리가 붙어 남는 것은 감수한다 — 눈에 띄고 지울 것이 명확하다.
        assert.ok(applied.includes('report.html'), `사용자 인자가 사라졌다: ${applied.split('\n').find(l => l.includes('cp'))}`);
        assert.ok(applied.includes('dist/'), applied.split('\n').find(l => l.includes('cp')));
    });

    /**
     * 커서 뒤 글자와 **정확히 이어지지 않는** 태스크 id 후보. `ask` 를 치는
     * 중에 형제 `asky` 를 고르는 자리다 — 여기서 대안 끝까지 덮으면 `${asky}` 가
     * 되어 `.value` 가 사라지고 bare 폴백을 탄다. 정확 일치 규칙만으로는 안 막힌다.
     */
    const SIBLING_ID_FIXTURE = `[
  {
    "id": "a.sibling",
    "title": "sibling",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "asky", "type": "inputBox", "prompt": "tag2" },
        { "id": "run", "type": "shell", "command": "echo \${as${CURSOR}k.value}" }
      ]
    }
  }
]`;

    test('이어지지 않는 형제 id 를 골라도 뒤의 `.key` 는 남는다', async () => {
        const { doc, position } = await openFixture(
            path.join('sibling', '.vscode', 'actions.json'), SIBLING_ID_FIXTURE
        );
        const items = await completionsAt(doc, position);

        const sibling = items.find(i => labelOf(i) === 'asky');
        assert.ok(sibling, `형제 id 를 제안하지 않았다: ${items.map(labelOf).join(',')}`);
        assert.strictEqual(doc.getText(replaceRangeOf(sibling)!), 'ask',
            'id 를 치는 자리에서는 뒤따르는 `.key` 를 덮지 않는다');
        const applied = applyItem(doc, sibling);
        assert.ok(applied.includes('${asky.value}'), applied.split('\n').find(l => l.includes('echo')));
        assert.ok(!applied.includes('${asky}'), '`.value` 가 지워져 bare 참조가 됐다');

        // 대조군: 전역 참조는 `.key` 를 갖지 않으므로 표현식 전체를 대체해야 한다.
        // 여기까지 좁히면 `${workspaceFolder.value}` 라는 해석 불가능한 것이 나온다.
        const builtin = items.find(i => labelOf(i) === 'workspaceFolder');
        assert.ok(builtin, '전역 참조를 제안하지 않았다');
        assert.strictEqual(doc.getText(replaceRangeOf(builtin)!), 'ask.value',
            '전역 참조는 표현식 전체를 대체한다');
        assert.ok(applyItem(doc, builtin).includes('${workspaceFolder}'));
    });

    /**
     * 후보가 **기존 토큰의 접두사**인 자리. `ask` 를 고르는데 문서에는 `asky` 가
     * 적혀 있다. 길이만 맞춰 대체하면 `y` 가 남아 `${asky.value}` 가 되고,
     * 사용자는 **고르지 않은 참조**를 갖게 된다 — 오류는 나지 않는다.
     */
    const PREFIX_OF_TOKEN_FIXTURE = `[
  {
    "id": "a.prefixtoken",
    "title": "prefixtoken",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "asky", "type": "inputBox", "prompt": "tag2" },
        { "id": "run", "type": "shell", "command": "echo \${as${CURSOR}ky.value}" }
      ]
    }
  }
]`;

    test('후보가 기존 토큰의 접두사면 토큰 전체를 대체한다', async () => {
        const { doc, position } = await openFixture(
            path.join('prefixtoken', '.vscode', 'actions.json'), PREFIX_OF_TOKEN_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'ask');
        assert.ok(item, '짧은 쪽 id 를 제안하지 않았다');

        assert.strictEqual(doc.getText(replaceRangeOf(item)!), 'asky',
            '`ask` 길이만큼만 덮으면 `y` 가 남아 고르지 않은 참조가 된다');

        const applied = applyItem(doc, item);
        assert.ok(applied.includes('${ask.value}'), applied.split('\n').find(l => l.includes('echo')));
        assert.ok(!applied.includes('${asky'), `고르지 않은 \`asky\` 가 남았다: ${applied.split('\n').find(l => l.includes('echo'))}`);
    });

    /**
     * 후보 뒤의 `.` 을 **무조건** 경계로 보면 반대쪽이 깨진다 — 남긴 `.key` 를
     * 받아 줄 후보가 아니기 때문이다. 전역 참조는 키를 갖지 않고, 결과 키 후보는
     * 이미 키까지 품고 있다. 둘 다 런타임이 해석하지 못해 리터럴로 남는다.
     */
    const DOT_TAIL_FIXTURE = `[
  {
    "id": "a.dottail",
    "title": "dottail",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${ask.va${CURSOR}lue.extra}" }
      ]
    }
  }
]`;

    const BUILTIN_DOT_TAIL_FIXTURE = `[
  {
    "id": "a.builtindot",
    "title": "builtindot",
    "action": {
      "description": "d",
      "tasks": [
        { "id": "ask", "type": "inputBox", "prompt": "tag" },
        { "id": "run", "type": "shell", "command": "echo \${workspaceFol${CURSOR}der.foo}" }
      ]
    }
  }
]`;

    test('결과 키 후보는 뒤의 `.extra` 를 남기지 않는다', async () => {
        const { doc, position } = await openFixture(
            path.join('dottail', '.vscode', 'actions.json'), DOT_TAIL_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'ask.value');
        assert.ok(item, '결과 키를 제안하지 않았다');

        const applied = applyItem(doc, item);
        assert.ok(applied.includes('${ask.value}'), applied.split('\n').find(l => l.includes('echo')));
        // `${ask.value.extra}` 는 런타임이 해석하지 못해 리터럴로 남는다.
        assert.ok(!applied.includes('value.extra'),
            `해석되지 않을 꼬리를 남겼다: ${applied.split('\n').find(l => l.includes('echo'))}`);
    });

    test('전역 참조는 뒤의 `.foo` 를 남기지 않는다', async () => {
        const { doc, position } = await openFixture(
            path.join('builtindot', '.vscode', 'actions.json'), BUILTIN_DOT_TAIL_FIXTURE
        );
        const item = (await completionsAt(doc, position)).find(i => labelOf(i) === 'workspaceFolder');
        assert.ok(item, '전역 참조를 제안하지 않았다');

        const applied = applyItem(doc, item);
        assert.ok(applied.includes('${workspaceFolder}'), applied.split('\n').find(l => l.includes('echo')));
        assert.ok(!applied.includes('workspaceFolder.foo'),
            `전역 참조에 없는 키를 남겼다: ${applied.split('\n').find(l => l.includes('echo'))}`);
    });

    test('커서가 `??` 안이면 아무 참조도 제안하지 않는다', async () => {
        const { doc, position } = await openFixture(
            path.join('inop', '.vscode', 'actions.json'), IN_OPERATOR_FIXTURE
        );
        const names = (await completionsAt(doc, position)).map(labelOf);
        // 무엇을 고르든 대체 범위가 `??` 를 삼켜 체인이 통째로 리터럴이 된다.
        const ours = names.filter(n => n.startsWith('pick') || n.startsWith('ask') || n === 'workspaceFolder');
        assert.deepStrictEqual(ours, [], `연산자 안에서 제안이 떴다: ${names.join(',')}`);
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
