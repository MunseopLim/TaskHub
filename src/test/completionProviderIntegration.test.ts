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

    async function openFixture(relPath: string): Promise<{ doc: vscode.TextDocument; position: vscode.Position }> {
        const full = path.join(tempDir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const offset = FIXTURE.indexOf(CURSOR);
        assert.ok(offset >= 0, '픽스처에 커서가 없다');
        fs.writeFileSync(full, FIXTURE.slice(0, offset) + FIXTURE.slice(offset + 1), 'utf8');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
        return { doc, position: doc.positionAt(offset) };
    }

    /**
     * trigger character 로 `.` 을 넘긴다 — VS Code 는 그 문자를 등록하지 않은
     * provider 를 건너뛰므로, 등록 목록에서 `.` 이 빠지면 여기서 걸린다.
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
});
