import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { getWebviewContent, buildJsonEditorStrings } from '../jsonEditor';

/**
 * **실제로 배포되는 webview 스크립트를 실행하는** 테스트.
 *
 * 지금까지 미커밋 draft 관련 테스트는 두 종류뿐이었다.
 *
 *   1. `src/jsonEditorUtils.ts` 의 **미러**를 부르는 단위테스트 — 완성된
 *      `arrValues` 배열을 헬퍼에 직접 넣는다. DOM 에서 그 배열을 **모으는**
 *      코드는 한 줄도 실행되지 않는다.
 *   2. 소스 정규식 가드 — "이 문자열이 코드에 있는가" 를 볼 뿐이라 로직이
 *      틀려도 통과한다.
 *
 * 그 사이에 실제 버그가 살았다: 저장 응답 처리는 활성 셀이 있으면 dirty 로
 * 두면서도 recovery 로는 **DOM 입력이 빠진 커밋 데이터**를 다시 보내, 응답을
 * 기다리는 동안 친 입력이 복구 스냅샷에서 사라졌다.
 *
 * 그래서 여기서는 `getWebviewContent()` 가 만든 **HTML 안의 함수 본문을 그대로
 * 뽑아** 가짜 DOM 위에서 돌린다. 셀렉터 문자열까지 실제 코드의 것을 쓰므로,
 * 셀렉터가 바뀌면 (아래 가짜 DOM 이 모르는 셀렉터라) 테스트가 깨진다.
 */
suite('JSON Editor webview — 활성 셀 draft (실행 테스트)', () => {

    const SESSION = 7;
    const sheetMap = [{ label: 'rows', path: ['rows'] }];
    const fakeWebview = { cspSource: 'https://test.invalid' } as unknown as vscode.Webview;
    const html = getWebviewContent({ rows: [{ a: 1 }] }, undefined, '/tmp/sample.json', fakeWebview, false, SESSION, 'https://test.invalid/jsonEditorWebview.js');

    /**
     * **배포되는 로직 번들.** webview 가 전역으로 받는 것과 같은 산출물이다.
     *
     * `parseValue` 같은 순수 로직은 더 이상 템플릿 리터럴 안에 사본으로 있지
     * 않고 `dist/jsonEditorWebview.js` 가 올려 준다. 그래서 여기서도 정규식으로
     * 뜯어내는 대신 그 파일을 그대로 실행해 쓴다 — 하네스가 실제로 배달되는
     * 것과 같은 코드를 돌린다는 이 스위트의 전제를 유지한다.
     */
    let cachedLogicBundle: unknown;
    function logicBundle(): unknown {
        // **지연 로드다.** 스위트 정의 시점에 읽으면 번들이 없을 때 Mocha 의
        // 파일 로딩 단계에서 터져 **한 건도 실행되지 않은 채** 런 전체가 죽는다
        // — 무관한 회귀까지 전부 가려진다. 테스트 안에서 실패해야 한 건만 붉다.
        if (cachedLogicBundle === undefined) {
            const bundlePath = path.resolve(__dirname, '..', '..', 'dist', 'jsonEditorWebview.js');
            assert.ok(fs.existsSync(bundlePath), `번들이 없다: ${bundlePath} (node esbuild.js 를 먼저 돌린다)`);
            const sandbox: Record<string, unknown> = {};
            vm.runInNewContext(fs.readFileSync(bundlePath, 'utf-8'), sandbox);
            assert.ok(sandbox.TaskHubJsonEditorLogic, '번들이 TaskHubJsonEditorLogic 전역을 올리지 않았다');
            cachedLogicBundle = sandbox.TaskHubJsonEditorLogic;
        }
        return cachedLogicBundle;
    }

    /**
     * 번들에서 꺼내는 문장. **인라인 스크립트의 것을 그대로 가져와** 전역 이름만
     * 하네스의 인자 이름으로 바꾼다 — 손으로 베껴 두면 꺼내는 목록이 늘어날 때
     * 조용히 어긋난다.
     */
    const PULL_FROM_BUNDLE = (() => {
        const m = html.match(/const \{[^}]+\} = TaskHubJsonEditorLogic;/);
        assert.ok(m, '인라인 스크립트에서 번들 구조분해 문장을 찾지 못했다');
        return m![0].replace('TaskHubJsonEditorLogic', 'LOGIC');
    })();

    /** webview HTML 에서 `function name(...) { ... }` 하나를 통째로 뽑는다. */
    function extractFn(name: string): string {
        const re = new RegExp('\\n    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}');
        const m = html.match(re);
        assert.ok(m, `webview 스크립트에서 function ${name} 을 찾지 못했다`);
        return m![0];
    }

    /** `document.querySelectorAll('[data-…]').forEach(btn => { … });` 블록 하나. */
    function extractWiring(attr: string): string {
        const re = new RegExp(
            'document\\.querySelectorAll\\(\'\\[' + attr + '\\]\'\\)\\.forEach\\(btn => \\{[\\s\\S]*?\\n        \\}\\);'
        );
        const m = html.match(re);
        assert.ok(m, `webview 스크립트에서 ${attr} 배선을 찾지 못했다`);
        // 블록이 더 깊이 들여쓰기되면 종결자가 **다음 블록의** 8칸 `});` 에
        // 걸려 두 배선을 통째로 삼킨다. 그래도 테스트는 통과하므로(같은
        // 핸들러가 두 번 등록될 뿐) 여기서 끊는다.
        const handlerCount = m![0].split("addEventListener('click'").length - 1;
        assert.strictEqual(handlerCount, 1, `${attr} 배선 추출이 이웃 블록까지 삼켰다`);
        return m![0];
    }

    /** `window.addEventListener('message', ...)` 의 본문. */
    function extractMessageHandlerBody(): string {
        const m = html.match(/window\.addEventListener\('message', \(event\) => \{([\s\S]*?)\n    \}\);/);
        assert.ok(m, 'webview 스크립트에서 message 리스너를 찾지 못했다');
        return m![1];
    }

    // ── 가짜 DOM ────────────────────────────────────────────────────────────
    // 셀렉터는 **실제 코드가 쓰는 문자열 그대로만** 받는다. 모르는 셀렉터가
    // 오면 즉시 실패시켜, 코드가 바뀌었는데 테스트가 조용히 null 을 보고
    // 통과하는 상황을 막는다.
    const CELL_EDITOR_SELECTOR = '.cell-edit input, .cell-edit textarea';
    const ARR_INPUT_SELECTOR = '.cell-edit input[data-arr-idx]';

    interface FakeInput {
        value: string;
        dataset: { arrIdx?: string };
        classList: { contains(name: string): boolean };
        /** `sendDraftSnapshot` 이 쓰는 `input.closest('td')`. 셀에 붙일 때 채운다. */
        closest?(selector: string): unknown;
    }

    function makeInput(value: string, opts: { arrIdx?: number; jsonEdit?: boolean } = {}): FakeInput {
        return {
            value,
            dataset: opts.arrIdx === undefined ? {} : { arrIdx: String(opts.arrIdx) },
            classList: { contains: (name: string) => name === 'json-edit' && !!opts.jsonEdit },
        };
    }

    function makeEditingCell(row: number, col: string, inputs: FakeInput[]) {
        const td = {
            classList: { contains: (name: string) => name === 'editing' },
            dataset: { row: String(row), col },
            querySelector(selector: string) {
                assert.strictEqual(selector, CELL_EDITOR_SELECTOR, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                return inputs[0] ?? null;
            },
            querySelectorAll(selector: string) {
                assert.strictEqual(selector, ARR_INPUT_SELECTOR, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                return inputs.filter(i => i.dataset.arrIdx !== undefined);
            },
        };
        for (const input of inputs) {
            input.closest = (selector: string) => {
                assert.strictEqual(selector, 'td', `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                return td;
            };
        }
        return td;
    }

    function makeDocument(editingCell: ReturnType<typeof makeEditingCell> | null) {
        const flagClasses = new Set<string>();
        return {
            flagClasses,
            querySelector(selector: string) {
                assert.strictEqual(selector, 'td.editing', `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                return editingCell;
            },
            getElementById(id: string) {
                assert.strictEqual(id, 'modifiedFlag', `가짜 DOM 이 모르는 id: ${id}`);
                return {
                    classList: {
                        toggle: (name: string, on: boolean) => {
                            if (on) { flagClasses.add(name); } else { flagClasses.delete(name); }
                        },
                    },
                };
            },
        };
    }

    // ── 스크립트 조립 ───────────────────────────────────────────────────────
    /**
     * webview 의 draft/저장응답 관련 함수 + message 리스너 본문을 하나의
     * 스코프에 모아 실행 가능한 API 로 돌려준다. 렌더링·히스토리처럼 이
     * 시나리오와 무관한 것만 스텁으로 넣는다.
     */
    function bootWebview(options: {
        data: unknown;
        sheetMap: { label: string; path: string[] }[];
        editingCell?: ReturnType<typeof makeEditingCell> | null;
        lastSavedSnapshot: string | null;
        pending?: [unknown, string][];
    }) {
        const posted: any[] = [];
        const doc = makeDocument(options.editingCell ?? null);
        const fakeVscode = { postMessage: (m: unknown) => { posted.push(m); } };

        const script = [
            PULL_FROM_BUNDLE,
            extractFn('buildDraftSnapshot'),
            extractFn('currentBaseline'),
            extractFn('snapshotData'),
            extractFn('readActiveCellEdit'),
            extractFn('activeDraftState'),
            extractFn('sendDraftSnapshot'),
            extractFn('setModified'),
            extractFn('setModifiedLocal'),
            // 선언만 있는 상태 (webview 에서는 IIFE 지역 변수). 이 값을 읽고 쓰는
            // 로직 자체는 위 실제 함수들이 그대로 들고 온다. renderTable 이
            // 이것을 비우는 것만 여기서 재현되지 않으므로, 그쪽은
            // jsonEditorUtils.test.ts 의 소스 가드로 고정한다.
            'let lastRecoverableDraft;',
            // 이 시나리오와 무관한 협력자들은 스텁.
            'function updateUndoRedoButtons() {}',
            // buildSheetMap 은 스텁을 두지 않는다 — 이름이 번들 구조분해와 겹쳐
            // `Identifier has already been declared` 가 된다. 전역 sheetMap 을
            // 갈아끼우는 쪽은 rebuildSheetMap 이므로 그것만 스텁으로 둔다.
            'function rebuildSheetMap() {}',
            'function renderTabs() {}',
            'function renderTable() {}',
            'function resetHistoryToCurrent() {}',
            'let savedSnapshot;',
            'let activeIdx = 0;',
            'const handleMessage = (event) => {' + extractMessageHandlerBody() + '\n    };',
            'return {',
            '    handleMessage: handleMessage,',
            '    draft: () => activeDraftState(),',
            // 사용자의 keystroke 하나. 실제 input 이벤트 핸들러가 부르는 것과
            // 같은 함수를 같은 인자로 부른다.
            '    type: (input, value) => { input.value = value; sendDraftSnapshot(input); },',
            '    state: () => ({ lastSavedSnapshot: lastSavedSnapshot, modified: modified, lastRecoverableDraft: lastRecoverableDraft, pending: Array.from(pendingSaveSnapshots.entries()) })',
            '};',
        ].join('\n');

        const factory = new Function(
            'LOGIC',
            'document', 'vscode', 'SESSION_ID', 'BASELINE_UNKNOWN_SENTINEL',
            'data', 'sheetMap', 'lastSavedSnapshot', 'modified', 'pendingSaveSnapshots',
            script
        );
        const api = factory(
            logicBundle(),
            doc, fakeVscode, SESSION, '',
            options.data, options.sheetMap, options.lastSavedSnapshot, false,
            new Map(options.pending ?? [])
        );
        return { api, posted, doc };
    }

    // ── commit / sync ───────────────────────────────────────────────────────
    /**
     * `commitCell` 의 배열 분기와 `syncEditingArrayCellToData` 를 **실제로
     * 실행한다**.
     *
     * draft 쪽(`buildDraftSnapshot`)은 위 suite 가 돌리지만, 값이 디스크로 가는
     * 경로는 이 둘이다 — 그동안 소스 정규식 가드만 걸려 있어서 로직이 틀려도
     * 통과했다. 배열이 문자열로 굳는 결함이 정확히 이 두 함수에 있었다.
     */
    suite('배열 셀 커밋이 항목 타입을 보존한다 (실행 테스트)', () => {
        const JSON_EDIT_SELECTOR = '.cell-edit textarea.json-edit';
        const SCALAR_TEXTAREA_SELECTOR = '.cell-edit textarea';
        const SCALAR_INPUT_SELECTOR = '.cell-edit input';

        /** commitCell 이 쓰는 셀렉터까지 아는 td. 모르는 셀렉터는 즉시 실패. */
        function makeCommitCell(row: number, col: string, inputs: FakeInput[], jsonEdit?: FakeInput) {
            let editing = true;
            return {
                isEditing: () => editing,
                classList: {
                    contains: (name: string) => name === 'editing' && editing,
                    remove: (name: string) => { if (name === 'editing') { editing = false; } },
                },
                dataset: { row: String(row), col },
                querySelector(selector: string) {
                    if (selector === JSON_EDIT_SELECTOR) { return jsonEdit ?? null; }
                    if (selector === SCALAR_TEXTAREA_SELECTOR) { return null; }
                    if (selector === SCALAR_INPUT_SELECTOR) { return inputs[0] ?? null; }
                    return assert.fail(`가짜 DOM 이 모르는 셀렉터: ${selector}`);
                },
                querySelectorAll(selector: string) {
                    assert.strictEqual(selector, ARR_INPUT_SELECTOR, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return inputs.filter(i => i.dataset.arrIdx !== undefined);
                },
            };
        }

        /**
         * commitCell / syncEditingArrayCellToData 를 한 스코프에 모아 실행한다.
         * `sheets` 를 비우면 활성 시트가 없는 상태(=`getActiveRows()` 가 null)를
         * 재현한다.
         */
        function bootCommit(data: unknown, sheets: { label: string; path: string[] }[] = sheetMap) {
            /** pushHistory 가 불린 시점의 data 스냅샷 — "변경으로 봤는가" 의 증거. */
            const historyPushes: string[] = [];
            const errors: string[] = [];

            const script = [
                PULL_FROM_BUNDLE,
                extractFn('getActiveRows'),
                extractFn('syncEditingArrayCellToData'),
                extractFn('commitCell'),
                'let activeIdx = 0;',
                // 이 시나리오와 무관한 협력자들. pushHistory 만은 호출 여부가
                // 의미를 가지므로(변경으로 봤는지) 기록한다.
                'function pushHistory() { historyPushes.push(JSON.stringify(data)); }',
                'function renderTable() {}',
                'function showError(message) { errors.push(message); }',
                'function fmt(template, values) { return template + JSON.stringify(values); }',
                'const S = { invalidJsonInCell: "invalid-json-in-cell" };',
                'return {',
                '    commit: (td) => commitCell(td),',
                '    sync: (td) => syncEditingArrayCellToData(td),',
                '    data: () => data,',
                '};',
            ].join('\n');

            const factory = new Function('LOGIC', 'data', 'sheetMap', 'historyPushes', 'errors', script);
            const api = factory(logicBundle(), data, sheets, historyPushes, errors);
            return { api, historyPushes, errors };
        }

        test('값을 바꾸지 않고 열었다 나가면 항목 타입이 그대로다', () => {
            // 이 결함의 트리거: 편집이 아니라 **클릭했다 나가기**. 항목마다
            // text input 을 그리므로 값이 전부 string 으로 돌아오고, 그대로 모으면
            // [1, true, null] 이 ["1","true","null"] 로 디스크에 기록됐다.
            const data = { rows: [{ tags: [1, true, null] }] };
            const { api, historyPushes } = bootCommit(data);
            const cell = makeCommitCell(0, 'tags', [
                makeInput('1', { arrIdx: 0 }),
                makeInput('true', { arrIdx: 1 }),
                makeInput('null', { arrIdx: 2 }),
            ]);

            assert.strictEqual(api.commit(cell), true);

            assert.deepStrictEqual(api.data(), { rows: [{ tags: [1, true, null] }] });
            assert.deepStrictEqual(historyPushes, [], '변경이 없는데 히스토리에 쌓였다');
        });

        test('고친 항목만 바뀌고 나머지 타입은 유지된다', () => {
            const data = { rows: [{ tags: [1, true, null] }] };
            const { api, historyPushes } = bootCommit(data);
            const cell = makeCommitCell(0, 'tags', [
                makeInput('10', { arrIdx: 0 }),
                makeInput('true', { arrIdx: 1 }),
                makeInput('null', { arrIdx: 2 }),
            ]);

            api.commit(cell);

            assert.deepStrictEqual(api.data(), { rows: [{ tags: [10, true, null] }] });
            assert.strictEqual(historyPushes.length, 1, '실제 변경은 히스토리에 쌓여야 한다');
        });

        test('문자열 배열은 raw 를 그대로 지킨다', () => {
            // 숫자로 보이는 문자열("007")이 숫자로 바뀌면 그것도 데이터 손상이다.
            const data = { rows: [{ tags: ['007', 'true'] }] };
            const { api, historyPushes } = bootCommit(data);
            const cell = makeCommitCell(0, 'tags', [
                makeInput('007', { arrIdx: 0 }),
                makeInput('true', { arrIdx: 1 }),
            ]);

            api.commit(cell);

            assert.deepStrictEqual(api.data(), { rows: [{ tags: ['007', 'true'] }] });
            assert.deepStrictEqual(historyPushes, []);
        });

        test('태그 추가·삭제 직전의 sync 도 같은 규칙을 쓰고 배열 참조를 지킨다', () => {
            // ✕ / + 버튼은 sync 한 뒤 그 **같은 배열**에 splice/push 한다.
            // 새 배열로 갈아끼우면 그 뒤의 splice 가 data 에 닿지 않는다.
            const data = { rows: [{ tags: [1, 2] }] };
            const { api } = bootCommit(data);
            const original = data.rows[0].tags;
            const cell = makeCommitCell(0, 'tags', [
                makeInput('1', { arrIdx: 0 }),
                makeInput('20', { arrIdx: 1 }),
            ]);

            const arr = api.sync(cell);

            assert.strictEqual(arr, original, 'sync 가 배열 참조를 바꾸면 이후 splice/push 가 유실된다');
            assert.deepStrictEqual(arr, [1, 20], '항목 타입을 보존한 채 제자리에서 갱신해야 한다');
            arr.splice(0, 1);
            assert.deepStrictEqual(api.data(), { rows: [{ tags: [20] }] }, 'sync 뒤의 splice 가 data 에 반영돼야 한다');
        });

        /**
         * 시트·행이 어긋난 상태의 sync.
         *
         * 두 호출부(✕ / +)는 `renderTable()` 이 매번 새로 만드는 버튼의 핸들러라
         * 현재는 여기에 닿지 않는다. 그래도 고정해 두는 이유: 호출부는 이미
         * `null` 계약을 지키고 host 미러(`buildDraftSnapshot`)도 같은 어긋남을
         * skip 하는데, 여기서만 그냥 읽으면 어긋나는 순간 **TypeError 로 webview
         * 스크립트 전체가 죽는다** — 화면은 남고 버튼만 조용히 먹통이 된다.
         */
        test('활성 시트가 없으면 터지지 않고 null 을 돌려준다', () => {
            const { api } = bootCommit({ rows: [{ tags: [1, 2] }] }, []);
            const cell = makeCommitCell(0, 'tags', [makeInput('1', { arrIdx: 0 })]);
            assert.strictEqual(api.sync(cell), null);
        });

        test('배열이 아닌 셀에서는 null 을 돌려준다', () => {
            // data-convert 로 배열이 문자열이 된 뒤 stale 한 td 가 남는 모양.
            // 이 분기가 없으면 호출부가 문자열에 splice 를 시도한다.
            const { api } = bootCommit({ rows: [{ tags: 'abc' }] });
            const cell = makeCommitCell(0, 'tags', [makeInput('a', { arrIdx: 0 })]);
            assert.strictEqual(api.sync(cell), null);
        });

        test('행 인덱스가 범위를 넘어도 터지지 않는다', () => {
            // 지연 commit 이 stale 한 dataset.row 를 들고 오는 경우의 모양.
            const { api } = bootCommit({ rows: [{ tags: [1, 2] }] });
            const cell = makeCommitCell(5, 'tags', [makeInput('1', { arrIdx: 0 })]);
            assert.strictEqual(api.sync(cell), null);
        });

        test('"+" 로 추가한 항목이 숫자 배열을 문자열로 오염시키지 않는다', () => {
            // "+" 버튼의 결과 상태: arr.push('') 뒤 다시 그려 빈 칸이 하나 늘어난
            // 모습. 거기에 3 을 입력하고 커밋한다. 빈 자리를 "문자열 항목" 으로
            // 보면 [1, 2, "3"] 이 되어 스키마가 붙은 파일에서 특히 성가시다.
            const data = { rows: [{ tags: [1, 2, ''] }] };
            const { api } = bootCommit(data);
            const cell = makeCommitCell(0, 'tags', [
                makeInput('1', { arrIdx: 0 }),
                makeInput('2', { arrIdx: 1 }),
                makeInput('3', { arrIdx: 2 }),
            ]);

            api.commit(cell);

            assert.deepStrictEqual(api.data(), { rows: [{ tags: [1, 2, 3] }] });
        });

        test('배열 셀의 json-edit 이 invalid 면 커밋을 거부하고 편집을 유지한다', () => {
            // 객체가 든 배열은 항목별 input 대신 textarea 하나로 그린다. 여기서
            // false 를 돌려주지 않으면 호출부(Save · 다른 셀 클릭 · 행 조작)가
            // 그대로 진행해 **화면과 다른 stale 데이터**가 저장된다.
            const data = { rows: [{ tags: [{ k: 1 }] }] };
            const { api, errors, historyPushes } = bootCommit(data);
            const textarea = makeInput('[{"k":', { jsonEdit: true });
            const cell = makeCommitCell(0, 'tags', [], textarea);

            assert.strictEqual(api.commit(cell), false, 'invalid JSON 을 커밋 성공으로 돌려주면 안 된다');
            assert.strictEqual(cell.isEditing(), true, '편집을 풀면 사용자가 고칠 자리를 잃는다');
            assert.strictEqual(errors.length, 1, '무엇이 잘못됐는지 알려야 한다');
            assert.deepStrictEqual(historyPushes, []);
            assert.deepStrictEqual(api.data(), { rows: [{ tags: [{ k: 1 }] }] }, '데이터를 건드리면 안 된다');
        });

        /**
         * scalar 셀의 타입 보존. 이 분기는 실행 테스트가 하나도 없었다.
         *
         * 규칙은 번들의 `coerceEditedCellValue` 한 곳에 있지만, **commitCell 이
         * 그것을 실제로 부르는지**는 별개다 — 예전에는 같은 삼항식을 손으로 다시
         * 써 두어, 규칙을 바꿔도 이 자리만 옛 동작으로 남을 수 있었다.
         */
        test('scalar 셀은 옛 값이 문자열이면 raw 를 유지하고 아니면 해석한다', () => {
            const numeric = { rows: [{ n: 1 }] };
            const numApi = bootCommit(numeric);
            numApi.api.commit(makeCommitCell(0, 'n', [makeInput('42')]));
            assert.deepStrictEqual(numApi.api.data(), { rows: [{ n: 42 }] }, '숫자 셀은 숫자로 남아야 한다');

            const stringy = { rows: [{ s: '1' }] };
            const strApi = bootCommit(stringy);
            strApi.api.commit(makeCommitCell(0, 's', [makeInput('00123')]));
            assert.deepStrictEqual(
                strApi.api.data(), { rows: [{ s: '00123' }] },
                '문자열 셀은 "00123" 이 숫자 123 으로 굳으면 안 된다'
            );
        });

        /**
         * `getActiveRows` 가 번들의 `getRowsByPath` 에 위임하는지.
         *
         * 시트 경로의 종단이 배열이 아니면 null 이어야 한다. 예전의 "검사 없이
         * 따라가기" 로 되돌리면 여기서 배열 아닌 것을 그대로 돌려주고, 호출부가
         * 조용히 엉뚱한 값을 만진다. (제품에서 도달하는 경로는 없다 — 위임이
         * 유지되는지만 고정한다.)
         */
        test('시트 경로가 배열에 닿지 못하면 sync 가 null 을 돌려준다', () => {
            const { api } = bootCommit({ rows: { 0: { tags: [1, 2] } } } as unknown as Record<string, unknown>);
            const cell = makeCommitCell(0, 'tags', [makeInput('1', { arrIdx: 0 })]);
            assert.strictEqual(api.sync(cell), null, '배열이 아닌 종단을 행 목록으로 받았다');
        });

        test('편집 중이 아닌 셀은 커밋이 아무것도 하지 않는다', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { api, historyPushes } = bootCommit(data);
            const cell = makeCommitCell(0, 'tags', [makeInput('9', { arrIdx: 0 })]);
            cell.classList.remove('editing');

            assert.strictEqual(api.commit(cell), true);

            assert.deepStrictEqual(api.data(), { rows: [{ tags: [1, 2] }] });
            assert.deepStrictEqual(historyPushes, []);
        });
    });

    // ── ✕ / + 버튼 핸들러 ───────────────────────────────────────────────────
    /**
     * 배열 태그의 ✕ / + 는 `syncEditingArrayCellToData` 의 `null` 계약을 지키는
     * **유일한** 소비자다. 그 계약은 그동안 소스 정규식으로만 고정돼 있어,
     * `if (!arr) { return; }` 가 사라져도 검사에 걸리지 않았다 — 그러면 어긋난
     * 상태에서 `arr.splice` 가 TypeError 로 스크립트 전체를 죽인다(헬퍼에 가드를
     * 넣어 `null` 을 돌려주기 시작한 만큼, 이제 그 값을 받는 쪽이 관건이다).
     * 배포되는 스크립트에서 두 핸들러를 그대로 떼어 실행한다.
     */
    suite('배열 태그 ✕ / + 가 어긋난 상태에서 빠져나간다 (실행 테스트)', () => {

        const REMOVE = '[data-remove-arr]';
        const ADD = '[data-add-arr]';
        /** ✕ 가 포커스를 옮길 대상 — 항목의 input 이 아니라 그 항목의 ✕ 버튼이다. */
        const REMOVE_ITEMS_SELECTOR = '.cell-edit [data-remove-arr]';

        /**
         * `renderTable()` 뒤에도 표에 남아 있는 td.
         *
         * input 개수를 **호출 시점의 실제 배열**에서 뽑는다. 예전에는 3 개를
         * 하드코딩해 두어, "마지막 칸에 포커스했다" 는 단언이 인과인지 시험
         * 데이터와 우연히 맞은 것인지 구별되지 않았다 — 배열 길이를 바꿔도
         * 가짜 DOM 만 옛 개수를 계속 보고했다.
         */
        function makeRenderedCell(col: string, readArr: () => unknown[]) {
            /** 포커스를 받은 것. `input:2` / `remove:1` / `add` 로 기록한다 — ✕ 와
             *  + 는 서로 **다른 종류의 요소**를 겨냥하므로 인덱스만으로는 부족하다. */
            const focused: string[] = [];
            const added: string[] = [];
            return {
                focused,
                added,
                dataset: { col },
                classList: { add: (name: string) => added.push(name) },
                querySelectorAll(selector: string) {
                    const kind = selector === ARR_INPUT_SELECTOR ? 'input'
                        : selector === REMOVE_ITEMS_SELECTOR ? 'remove'
                            : null;
                    assert.ok(kind, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return readArr().map((_, i) => ({ focus: () => focused.push(`${kind}:${i}`) }));
                },
                querySelector(selector: string) {
                    assert.strictEqual(selector, '[data-add-arr]', `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return { focus: () => focused.push('add') };
                },
            };
        }

        interface HandlerOptions {
            /** 활성 시트 목록. 비우면 `getActiveRows()` 가 null 이다. */
            sheets?: { label: string; path: string[] }[];
            /** ✕ 버튼이 자기 자리로 들고 있는 인덱스. */
            removeArr?: string;
            /** 편집 중인 셀의 열 이름. 기본 `tags`. */
            col?: string;
            /** 다시 그린 표에서 그 셀을 찾을 수 있는지. 기본 true. */
            rerendered?: boolean;
            /** 버튼의 `closest('td')` 가 null 을 돌려주는 상황. */
            detachedButton?: boolean;
        }

        function bootHandlers(data: unknown, options: HandlerOptions = {}) {
            const sheets = options.sheets ?? sheetMap;
            const col = options.col ?? 'tags';
            /** 핸들러가 "진행했다" 는 증거. 빠져나갔으면 비어 있어야 한다. */
            const calls: string[] = [];
            const readArr = () => {
                const rows = (data as { rows?: Record<string, unknown>[] }).rows;
                const val = rows?.[0]?.[col];
                return Array.isArray(val) ? val : [];
            };
            // 편집 중인 셀의 input 도 **시험 데이터에서 뽑는다.** 개수를 2 로
            // 고정해 두면 핸들러가 부르는 sync 가 배열을 늘 길이 2 로 덮어써서,
            // 배열 길이에 의존하는 단언이 전부 시험 데이터와 무관해진다.
            const td = makeEditingCell(0, col, readArr().map((v, i) => makeInput(String(v), { arrIdx: i })));
            const rendered = makeRenderedCell(col, readArr);
            // 같은 행의 다른 열. col 을 보지 않고 첫 셀을 집으면 여기에 걸린다.
            const decoy = makeRenderedCell('other', () => []);
            const handlers: Record<string, (e: unknown) => void> = {};
            const doc = {
                querySelectorAll(selector: string) {
                    // 다시 그린 표에서 셀을 되찾는 경로. **열 이름은 셀렉터에
                    // 들어가지 않는다** — 들어가면 아래 단언이 즉시 깨진다.
                    if (selector === 'td[data-row="0"]') {
                        calls.push('refind');
                        return options.rerendered === false ? [decoy] : [decoy, rendered];
                    }
                    assert.ok(selector === REMOVE || selector === ADD, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return [{
                        dataset: { removeArr: options.removeArr ?? '0' },
                        closest: (sel: string) => {
                            assert.strictEqual(sel, 'td', `가짜 DOM 이 모르는 셀렉터: ${sel}`);
                            return options.detachedButton ? null : td;
                        },
                        addEventListener: (type: string, fn: (e: unknown) => void) => {
                            assert.strictEqual(type, 'click', `예상 밖의 이벤트: ${type}`);
                            handlers[selector] = fn;
                        },
                    }];
                },
            };

            /** 스크린리더로 나간 문구. 실제 문자열 번들과 실제 fmt 를 거친 결과다. */
            const announced: string[] = [];
            const script = [
                PULL_FROM_BUNDLE,
                extractFn('getActiveRows'),
                extractFn('syncEditingArrayCellToData'),
                extractFn('findCellByCol'),
                extractFn('refocusArrayCell'),
                extractFn('fmt'),
                'let activeIdx = 0;',
                'function announce(msg) { announced.push(msg); }',
                'function pushHistory() { calls.push("pushHistory"); }',
                'function renderTable() { calls.push("renderTable"); }',
                extractWiring('data-remove-arr'),
                extractWiring('data-add-arr'),
            ].join('\n');
            // S 는 진짜 번들을 쓴다 — 핸들러가 없는 키를 부르면 fmt 가 그대로
            // 통과시켜 `undefined` 가 아니라 템플릿이 남으므로 단언에서 드러난다.
            new Function('LOGIC', 'document', 'data', 'sheetMap', 'calls', 'announced', 'S', script)(
                logicBundle(), doc, data, sheets, calls, announced, buildJsonEditorStrings());

            return {
                calls,
                rendered,
                announced,
                click(selector: string) {
                    const fn = handlers[selector];
                    assert.ok(fn, `${selector} 에 click 핸들러가 등록되지 않았다`);
                    fn({ stopPropagation() { /* 실제 코드가 부른다 */ } });
                },
            };
        }

        test('활성 시트가 없으면 ✕ 는 아무것도 하지 않는다', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data, { sheets: [] });

            click(REMOVE);

            assert.deepStrictEqual(calls, [], 'sync 가 null 을 돌려줬는데 진행했다');
            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2] }] });
        });

        test('활성 시트가 없으면 + 도 아무것도 하지 않는다', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data, { sheets: [] });

            click(ADD);

            assert.deepStrictEqual(calls, [], 'sync 가 null 을 돌려줬는데 진행했다');
            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2] }] });
        });

        test('정상 상태에서는 ✕ 가 실제로 지운다 (양성 대조)', () => {
            // 위 두 테스트가 "가짜 DOM 이 틀려서" 조용히 통과하는 것을 막는다.
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data);

            click(REMOVE);

            assert.deepStrictEqual(data, { rows: [{ tags: [2] }] });
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable', 'refind']);
        });

        test('✕ 는 자기 자리의 항목만 지운다', () => {
            // 인덱스를 안 쓰고 늘 0 번을 지워도 위 양성 대조는 통과한다.
            const data = { rows: [{ tags: [1, 2] }] };
            const { click } = bootHandlers(data, { removeArr: '1' });

            click(REMOVE);

            assert.deepStrictEqual(data, { rows: [{ tags: [1] }] }, '누른 태그가 아닌 것을 지웠다');
        });

        test('정상 상태에서는 + 가 실제로 추가한다 (양성 대조)', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data);

            click(ADD);

            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2, ''] }] });
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable', 'refind']);
        });

        test('+ 는 새로 생긴 마지막 칸에 포커스를 준다', () => {
            // 이 버튼의 요점은 "빈 칸이 하나 늘어난다" 가 아니라 "거기에 바로
            // 입력할 수 있다" 이다. 다시 그린 뒤의 분기라 앞 테스트로는 안 닿는다.
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1, 2] }] });

            click(ADD);

            assert.deepStrictEqual(rendered.added, ['editing'], '새 셀을 편집 상태로 두지 않았다');
            assert.deepStrictEqual(rendered.focused, ['input:2'], '새로 생긴 빈 칸에 포커스해야 한다');
        });

        test('+ 의 포커스 위치가 배열 길이를 따라간다', () => {
            // 앞 테스트만 있으면 "늘 2 번" 이라는 구현으로도 통과한다.
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1, 2, 3, 4] }] });

            click(ADD);

            assert.deepStrictEqual(rendered.focused, ['input:4'], '길이가 바뀌면 포커스 자리도 따라가야 한다');
        });

        test('빈 배열에서도 + 가 첫 칸을 만들고 포커스한다', () => {
            // input 이 0 개라 sync 가 수집 없이 arr 만 돌려주는 유일한 경로다.
            const data = { rows: [{ tags: [] as unknown[] }] };
            const { click, rendered } = bootHandlers(data);

            click(ADD);

            assert.deepStrictEqual(data, { rows: [{ tags: [''] }] });
            assert.deepStrictEqual(rendered.focused, ['input:0']);
        });

        /**
         * ✕ 뒤에도 셀이 편집 상태로 남는지, 그리고 **무엇에** 포커스가 가는지.
         *
         * `renderTable()` 은 wrapper 를 통째로 갈아치우므로, 되돌리지 않으면
         * 태그 하나 지울 때마다 셀이 view 모드로 접히고 포커스가 body 로
         * 떨어진다 — 세 개를 지우려면 셀을 세 번 다시 열어야 했다.
         *
         * 포커스는 항목의 input 이 **아니라** 그 항목의 ✕ 버튼으로 간다.
         * input 으로 보내면 버튼을 Enter 로 누른 키보드 사용자가 텍스트 필드에
         * 도착하고, 이어 누르는 Enter 가 commitCell 로 가 셀이 접힌다.
         */
        test('✕ 뒤에도 셀은 편집 상태로 남고 다음 ✕ 로 포커스가 간다', () => {
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1, 2, 3] }] }, { removeArr: '1' });

            click(REMOVE);

            assert.deepStrictEqual(rendered.added, ['editing'], '셀이 편집 상태에서 빠져나갔다');
            assert.deepStrictEqual(rendered.focused, ['remove:1'], '지운 자리로 올라온 항목의 ✕ 에 포커스해야 한다');
        });

        test('✕ 는 지운 자리를 따라간다 (늘 마지막이 아니다)', () => {
            // [1,2,3,4] 의 0 번을 지우면 새 길이는 3 이고 지운 자리는 0 이다.
            // `items[items.length - 1]` 로 잘못 써도 앞 두 테스트는 통과한다 —
            // 거기서는 지운 자리가 우연히 새 마지막 자리와 같기 때문이다.
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1, 2, 3, 4] }] }, { removeArr: '0' });

            click(REMOVE);

            assert.deepStrictEqual(rendered.focused, ['remove:0'], '지운 자리가 아닌 곳에 포커스했다');
        });

        test('✕ 가 마지막 항목을 지우면 그 앞으로 물러난다', () => {
            // 지운 자리(2)가 새 길이(2)를 넘으므로 그대로 쓰면 undefined.focus() 다.
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1, 2, 3] }] }, { removeArr: '2' });

            click(REMOVE);

            assert.deepStrictEqual(rendered.focused, ['remove:1'], '남은 마지막 자리로 물러나야 한다');
        });

        test('마지막 하나 남은 태그를 지우면 + 버튼이 포커스를 받는다', () => {
            // 항목이 0 개면 포커스를 줄 것이 없다. 그냥 두면 body 로 떨어진다.
            const { click, rendered } = bootHandlers({ rows: [{ tags: [1] }] });

            click(REMOVE);

            assert.deepStrictEqual(rendered.focused, ['add'], '"+" 로 포커스를 넘기지 않았다');
            assert.deepStrictEqual(rendered.added, ['editing'], '빈 배열에서도 편집 상태는 유지해야 "+" 가 보인다');
        });

        /**
         * 포커스 이동만으로는 무슨 일이 일어났는지 알 수 없다.
         *
         * ["debug", "debug-2"] 처럼 값이 비슷하면, 다음 항목으로 옮겨 간 포커스는
         * 스크린리더에게 "삭제됐다" 와 구별되지 않는다. 실제 문자열 번들과 실제
         * `fmt` 를 거치므로, 템플릿 키가 어긋나면 `{n}` 이 남아 단언이 깨진다.
         */
        test('✕ / + 가 스크린리더에 결과를 알린다', () => {
            const removed = bootHandlers({ rows: [{ tags: [1, 2, 3] }] }, { removeArr: '1' });
            removed.click(REMOVE);
            assert.strictEqual(removed.announced.length, 1, '삭제를 알리지 않았다');
            assert.ok(!/[{}]/.test(removed.announced[0]), `템플릿이 그대로 남았다: ${removed.announced[0]}`);
            assert.ok(/2/.test(removed.announced[0]), `몇 번째를 지웠는지 없다: ${removed.announced[0]}`);

            const added = bootHandlers({ rows: [{ tags: [1, 2] }] });
            added.click(ADD);
            assert.strictEqual(added.announced.length, 1, '추가를 알리지 않았다');
            assert.ok(!/[{}]/.test(added.announced[0]), `템플릿이 그대로 남았다: ${added.announced[0]}`);
            assert.ok(/3/.test(added.announced[0]), `총 개수가 없다: ${added.announced[0]}`);
        });

        /**
         * 버튼이 td 밖으로 떨어진 상태.
         *
         * `syncEditingArrayCellToData` 의 `if (!td) { return null; }` 는 이 두
         * 호출부를 위해 있는데, 예전에는 `+` 가 그 계약에 닿기 전에
         * `td.dataset.row` 를 먼저 읽어 TypeError 로 죽었다.
         */
        test('버튼이 td 를 못 찾으면 두 핸들러 모두 조용히 빠져나간다', () => {
            for (const selector of [REMOVE, ADD]) {
                const data = { rows: [{ tags: [1, 2] }] };
                const { click, calls } = bootHandlers(data, { detachedButton: true });

                click(selector);

                assert.deepStrictEqual(calls, [], `${selector} 가 td 없이 진행했다`);
                assert.deepStrictEqual(data, { rows: [{ tags: [1, 2] }] });
            }
        });

        /**
         * 열 이름이 셀렉터 문자열에 들어가지 않는지.
         *
         * 예전에는 `td[data-col="' + col + '"]` 로 이어 붙였다. 마크업은
         * escapeAttr 로 쓰지만 브라우저가 `&quot;` 를 되돌려 놓으므로
         * `dataset.col` 에는 진짜 따옴표가 들어 있고, 그 상태로 이어 붙이면
         * querySelector 가 문법 오류로 던져 **그 핸들러가 거기서 멈춘다** —
         * 항목은 추가되지만 포커스는 가지 않고 오류 배너만 뜬다.
         */
        test('열 이름에 따옴표가 있어도 셀을 되찾는다', () => {
            const data = { rows: [{ 'ta"g\\s': [1, 2] }] };
            const { click, rendered } = bootHandlers(data, { col: 'ta"g\\s' });

            click(ADD);

            assert.deepStrictEqual(data, { rows: [{ 'ta"g\\s': [1, 2, ''] }] });
            assert.deepStrictEqual(rendered.focused, ['input:2'], '따옴표가 든 열에서 셀을 못 찾았다');
        });

        test('다시 그린 표에 그 셀이 없으면 조용히 넘어간다', () => {
            // 시트를 바꾸는 등으로 열이 사라진 경우. 던지면 스크립트가 죽는다.
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls, rendered } = bootHandlers(data, { rerendered: false });

            click(ADD);

            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2, ''] }] }, 'mutation 자체는 끝나 있어야 한다');
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable', 'refind']);
            assert.deepStrictEqual(rendered.added, [], '못 찾았는데 무언가를 편집 상태로 만들었다');
            assert.deepStrictEqual(rendered.focused, [], '못 찾았는데 어딘가에 포커스했다');
        });
    });

    // ── scalar 셀 타입 변환 ──────────────────────────────────────────────────
    /**
     * 숫자 칸에 문자열을 한 번이라도 넣으면 그 셀은 문자열이 되고, 이후
     * `coerceEditedCellValue` 의 "옛 값이 문자열이면 raw 유지" 규칙 때문에 숫자를
     * 입력해도 계속 문자열로 남았다. 규칙 자체는 `"00123"` 을 지키려는 것이라
     * 옳지만, **빠져나올 문이 없었다** — 표에서는 36 과 "36" 이 똑같이 보이므로
     * 사용자는 그 사실조차 알 수 없다.
     */
    suite('scalar 셀 타입 변환 (실행 테스트)', () => {

        const S = buildJsonEditorStrings();

        /**
         * 배포되는 renderCellView 를 그대로 떼어 돌린다. `fmt` · `escapeAttr` 도
         * 함께 내보내, 기대 tooltip 을 **실제 문자열 번들 + 실제 이스케이프**로
         * 만든다 — 문구를 손으로 적으면 로케일에 묶이고 이스케이프도 놓친다.
         */
        const R = (() => {
            const script = [
                PULL_FROM_BUNDLE,
                extractFn('fmt'),
                extractFn('escapeHtml'),
                extractFn('escapeAttr'),
                extractFn('isPlainObject'),
                extractFn('hasOnlyPrimitives'),
                extractFn('summarizeObject'),
                extractFn('retypedScalar'),
                extractFn('renderCellView'),
                'return {',
                '    render: (val) => renderCellView(val, Array.isArray(val), false),',
                '    fmt: fmt,',
                '    escapeAttr: escapeAttr,',
                '};',
            ].join('\n');
            return new Function('LOGIC', 'S', script)(logicBundle(), S) as {
                render(val: unknown): string;
                fmt(template: string, values: Record<string, string>): string;
                escapeAttr(str: string): string;
            };
        })();

        /** 기대 tooltip: 실제 템플릿에 preview 를 끼우고 속성용으로 이스케이프. */
        function expectedTitle(key: 'toValueType' | 'toStringType', preview: string): string {
            return R.escapeAttr(R.fmt(S[key], { preview }));
        }

        /** 변환 버튼의 label 과 tooltip. 버튼이 없으면 null. */
        function retypeButton(val: unknown): { label: string; title: string } | null {
            const html = R.render(val);
            const m = html.match(
                /<button class="convert-btn" data-convert="retype" title="([^"]*)" aria-label="([^"]*)">([^<]*)<\/button>/
            );
            if (!m) { return null; }
            // 아이콘만 있는 버튼이라 이름이 없으면 스크린리더에는 존재하지 않는 것과 같다.
            assert.strictEqual(m[2], m[1], 'aria-label 이 title 과 달라졌다');
            return { title: m[1], label: m[3] };
        }

        test('숫자·불리언 셀은 문자열로 바꾸는 버튼을 낸다', () => {
            assert.deepStrictEqual(retypeButton(36), { label: '#→s', title: expectedTitle('toStringType', '"36"') });
            assert.deepStrictEqual(retypeButton(true), { label: '#→s', title: expectedTitle('toStringType', '"true"') });
            // expectedTitle 은 같은 템플릿·같은 fmt 로 만들므로 템플릿에서
            // {preview} 가 통째로 빠져도 통과한다. 결과가 실제로 보이는지는
            // 리터럴로 못박는다 (따옴표까지 — 그게 이 방향의 요점이다).
            assert.ok(retypeButton(36)!.title.includes('&quot;36&quot;'), '문자열이 된다는 것이 안 보인다');
        });

        test('값으로 읽히는 문자열 셀은 값으로 바꾸는 버튼을 낸다', () => {
            assert.deepStrictEqual(retypeButton('36'), { label: 's→#', title: expectedTitle('toValueType', '36') });
            assert.deepStrictEqual(retypeButton('true'), { label: 's→#', title: expectedTitle('toValueType', 'true') });
            assert.deepStrictEqual(retypeButton('null'), { label: 's→#', title: expectedTitle('toValueType', 'null') });
            assert.ok(retypeButton('36')!.title.includes('36'), '무엇이 되는지가 안 보인다');
        });

        test('null 은 문자열로 되돌릴 수 있다 (일방통행이 되지 않도록)', () => {
            // "null" → null 을 허용하면서 반대 방향이 없으면, 이 기능이 없애려던
            // 일방통행을 새로 하나 만드는 셈이다.
            assert.deepStrictEqual(retypeButton(null), { label: '#→s', title: expectedTitle('toStringType', '"null"') });
        });

        /**
         * 2^53 을 넘는 정수 문자열.
         *
         * double 을 거치면서 값이 조용히 달라진다 — "0xFFFFFFFFFFFFFFFF" 는
         * …551615 가 아니라 …552000 이 된다. 이 확장의 영역이 임베디드라 64비트
         * 마스크·주소가 실제로 이런 모양이고, tooltip 에 미리 보여 준다 해도
         * 20자리 중 끝 네 자리가 다른 것을 눈으로 걸러 내지는 못한다.
         */
        test('정확히 표현할 수 없는 큰 정수에는 버튼을 내지 않는다', () => {
            for (const val of ['0xFFFFFFFFFFFFFFFF', '12345678901234567890', '9007199254740993']) {
                assert.strictEqual(retypeButton(val), null, `${val} 이 double 을 거쳐 손상될 뻔했다`);
            }
            // 경계 바로 안쪽은 그대로 바꿀 수 있어야 한다 (가드가 과하지 않다).
            assert.deepStrictEqual(
                retypeButton('9007199254740991'),
                { label: 's→#', title: expectedTitle('toValueType', '9007199254740991') }
            );
        });

        test('바꿔도 그대로인 값에는 버튼을 내지 않는다', () => {
            // 버튼이 아무 일도 하지 않으면 사용자를 속이는 것이다.
            for (const val of ['abc', '', undefined, '  ']) {
                assert.strictEqual(retypeButton(val), null, `${JSON.stringify(val)} 에 쓸모없는 버튼이 붙었다`);
            }
        });

        test('결과를 tooltip 으로 미리 보여 준다 (16진 문자열은 10진수가 된다)', () => {
            // "0x40013800" 은 JS 에서 숫자로도 읽힌다. 무엇이 될지 보이지 않으면
            // 누르기 전에 알 수 없고, 눌러 보고 나서야 주소가 10진수로 바뀐 것을
            // 발견하게 된다.
            assert.deepStrictEqual(
                retypeButton('0x40013800'),
                { label: 's→#', title: expectedTitle('toValueType', '1073821696') }
            );
            // 이 미리보기가 없으면 사용자는 주소가 10진수로 바뀐 뒤에야 안다.
            assert.ok(retypeButton('0x40013800')!.title.includes('1073821696'));
        });

        // ── 클릭 핸들러 ──────────────────────────────────────────────────
        function bootConvert(
            data: unknown,
            options: { col?: string; sheets?: typeof sheetMap; convert?: string; row?: string } = {}
        ) {
            const col = options.col ?? 'v';
            const calls: string[] = [];
            const announced: string[] = [];
            const td = { dataset: { row: options.row ?? '0', col } };
            let clickHandler: ((e: unknown) => void) | undefined;
            const doc = {
                querySelectorAll(selector: string) {
                    assert.strictEqual(selector, '[data-convert]', `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return [{
                        dataset: { convert: options.convert ?? 'retype' },
                        closest: (sel: string) => {
                            assert.strictEqual(sel, 'td[data-row]', `가짜 DOM 이 모르는 셀렉터: ${sel}`);
                            return td;
                        },
                        addEventListener: (type: string, fn: (e: unknown) => void) => {
                            assert.strictEqual(type, 'click', `예상 밖의 이벤트: ${type}`);
                            clickHandler = fn;
                        },
                    }];
                },
            };
            const script = [
                PULL_FROM_BUNDLE,
                extractFn('fmt'),
                extractFn('getActiveRows'),
                extractFn('retypedScalar'),
                'let activeIdx = 0;',
                'function commitActiveCellOrAbort() { return true; }',
                'function pushHistory() { calls.push("pushHistory"); }',
                'function renderTable() { calls.push("renderTable"); }',
                'function announce(msg) { announced.push(msg); }',
                extractWiring('data-convert'),
            ].join('\n');
            new Function('LOGIC', 'document', 'data', 'sheetMap', 'calls', 'announced', 'S', script)(
                logicBundle(), doc, data, options.sheets ?? sheetMap, calls, announced, S);

            return {
                calls,
                announced,
                click() {
                    assert.ok(clickHandler, 'data-convert 에 click 핸들러가 등록되지 않았다');
                    clickHandler!({ stopPropagation() { /* 실제 코드가 부른다 */ } });
                },
            };
        }

        test('문자열 셀을 눌러 숫자로 되돌린다', () => {
            const data = { rows: [{ v: '54' }] };
            const { click, calls } = bootConvert(data);

            click();

            assert.deepStrictEqual(data, { rows: [{ v: 54 }] });
            assert.strictEqual(typeof data.rows[0].v, 'number', '보이기만 숫자면 소용없다');
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable'], 'undo 로 되돌릴 수 있어야 한다');
        });

        test('숫자 셀을 눌러 문자열로 바꾼다', () => {
            const data = { rows: [{ v: 54 }] };
            bootConvert(data).click();
            assert.deepStrictEqual(data, { rows: [{ v: '54' }] });
            assert.strictEqual(typeof data.rows[0].v, 'string');
        });

        /**
         * 이 기능이 실제로 여는 문.
         *
         * 사용자가 겪은 그대로 재현한다: 숫자 칸에 문자열을 한 번 넣어 셀이
         * 문자열로 굳고, 그 뒤로는 숫자를 입력해도 문자열로 남는다. 변환 버튼을
         * 누른 **뒤에는** 같은 입력이 숫자로 들어가야 한다.
         */
        test('문자열로 굳은 칸이 변환 뒤에는 다시 숫자를 받는다', () => {
            const logic = logicBundle() as { coerceEditedCellValue(raw: string, old: unknown): unknown };

            // 1) irq: 36 인 칸에 "abc" 를 넣는다 → 문자열로 굳는다.
            const stuck = logic.coerceEditedCellValue('abc', 36);
            assert.strictEqual(typeof stuck, 'string');
            // 2) 다시 숫자를 넣어도 문자열이다 — 이게 사용자가 본 것이다.
            const stillString = logic.coerceEditedCellValue('54', stuck);
            assert.strictEqual(stillString, '54');
            assert.strictEqual(typeof stillString, 'string', '전제가 깨졌다면 이 기능의 이유도 사라진다');

            // 3) 변환 버튼을 누른다.
            const data = { rows: [{ v: stillString }] };
            bootConvert(data).click();
            assert.strictEqual(data.rows[0].v, 54);

            // 4) 이제 같은 편집이 숫자로 들어간다.
            const after = logic.coerceEditedCellValue('99', data.rows[0].v);
            assert.strictEqual(after, 99);
            assert.strictEqual(typeof after, 'number', '변환하고도 여전히 문자열이 되면 문이 열리지 않은 것이다');
        });

        test('무엇으로 바뀌었는지 스크린리더에 알린다', () => {
            // 표에서는 36 과 "36" 이 똑같이 보이므로 화면만으로는 알 수 없다.
            const { click, announced } = bootConvert({ rows: [{ v: '54' }] });

            click();

            assert.strictEqual(announced.length, 1, '변환을 알리지 않았다');
            assert.ok(!/[{}]/.test(announced[0]), `템플릿이 그대로 남았다: ${announced[0]}`);
            assert.ok(/\bv\b/.test(announced[0]), `어느 열인지 없다: ${announced[0]}`);
            assert.ok(/54/.test(announced[0]), `무엇이 됐는지 없다: ${announced[0]}`);
        });

        test('바꿀 것이 없으면 아무것도 하지 않는다', () => {
            // 렌더 시점과 클릭 사이에 값이 바뀌었을 수 있다.
            const data = { rows: [{ v: 'abc' }] };
            const { click, calls, announced } = bootConvert(data);

            click();

            assert.deepStrictEqual(data, { rows: [{ v: 'abc' }] });
            assert.deepStrictEqual(calls, [], '바꾼 것이 없는데 히스토리를 쌓았다');
            assert.deepStrictEqual(announced, []);
        });

        test('활성 시트가 없으면 아무것도 하지 않는다', () => {
            const data = { rows: [{ v: '54' }] };
            const { click, calls } = bootConvert(data, { sheets: [] });

            click();

            assert.deepStrictEqual(data, { rows: [{ v: '54' }] });
            assert.deepStrictEqual(calls, [], 'getActiveRows 가 null 인데 진행했다');
        });

        test('행 인덱스가 범위를 넘어도 아무것도 하지 않는다', () => {
            // 가드의 나머지 절반. 지연 commit 이 stale 한 dataset.row 를 들고 오는
            // 경우다 — `!rows` 만 검사하면 여기서 undefined 에 대입하며 죽는다.
            const data = { rows: [{ v: '54' }] };
            const { click, calls } = bootConvert(data, { row: '5' });

            click();

            assert.deepStrictEqual(data, { rows: [{ v: '54' }] });
            assert.deepStrictEqual(calls, []);
        });

        test('숫자를 문자열로 바꿀 때는 따옴표까지 알린다', () => {
            // 이 방향에서만 JSON.stringify 와 String 이 갈린다. s→# 쪽만 보면
            // 알림에서 따옴표가 사라져도 통과한다 — 따옴표가 이 알림의 요점인데도.
            const { click, announced } = bootConvert({ rows: [{ v: 54 }] });

            click();

            assert.strictEqual(announced.length, 1);
            assert.ok(/\"54\"/.test(announced[0]), `문자열이 됐다는 것이 안 보인다: ${announced[0]}`);
        });

        /**
         * 같은 핸들러의 다른 두 갈래. 이번 변경이 두 줄을 모두 고쳐 썼는데
         * (`getActiveRows()[rowIdx][col] =` → `rows[rowIdx][col] =`) 실행 테스트가
         * 하나도 없었다 — 잘못 고쳐도 아무것도 실패하지 않는다.
         */
        test('split / join 갈래도 같은 행에 쓴다', () => {
            const splitData = { rows: [{ v: 'a, b ,c' }] };
            bootConvert(splitData, { convert: 'split' }).click();
            assert.deepStrictEqual(splitData, { rows: [{ v: ['a', 'b', 'c'] }] }, '쉼표 분리 + 공백 정리');

            const joinData = { rows: [{ v: ['a', 'b'] }] };
            bootConvert(joinData, { convert: 'join' }).click();
            assert.deepStrictEqual(joinData, { rows: [{ v: 'a, b' }] });
        });
    });

    // ── activeDraftState ────────────────────────────────────────────────────
    suite('activeDraftState 가 DOM 의 미커밋 입력을 읽는다', () => {

        test('배열 셀의 input 두 개를 모두 반영하고 항목 타입을 보존한다', () => {
            // 실제 흐름: [1, "a"] 셀을 열어 첫 칸을 10, 둘째 칸을 "x" 로 고친 뒤
            // 아직 Enter 를 누르지 않은 상태. 예전에는 이벤트가 난 input 하나만
            // 반영되어 나머지 입력이 draft 에서 사라졌고, 전부 문자열로 굳었다.
            const data = { rows: [{ tags: [1, 'a'] }] };
            const cell = makeEditingCell(0, 'tags', [
                makeInput('10', { arrIdx: 0 }),
                makeInput('x', { arrIdx: 1 }),
            ]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            const draft = api.draft();

            assert.strictEqual(draft.valid, true);
            assert.deepStrictEqual(
                draft.data, { rows: [{ tags: [10, 'x'] }] },
                '두 input 이 함께 반영되고 숫자 항목은 숫자로 남아야 한다'
            );
            assert.strictEqual(draft.snapshot, JSON.stringify({ rows: [{ tags: [10, 'x'] }] }));
            assert.deepStrictEqual(data, { rows: [{ tags: [1, 'a'] }] }, 'draft 계산이 원본 data 를 건드리면 안 된다');
        });

        test('활성 셀이 없으면 커밋된 데이터를 그대로 돌려준다', () => {
            const data = { rows: [{ a: 1 }] };
            const { api } = bootWebview({ data, sheetMap, editingCell: null, lastSavedSnapshot: JSON.stringify(data) });

            const draft = api.draft();

            assert.strictEqual(draft.valid, true);
            assert.strictEqual(draft.data, data);
            assert.strictEqual(draft.snapshot, JSON.stringify(data));
        });

        test('값을 바꾸지 않고 셀만 열었으면 draft 가 커밋 데이터와 같다', () => {
            // P2: "활성 셀이 있으면 무조건 dirty" 였을 때, 값을 건드리지 않고
            // 클릭만 해도 저장 뒤 영원히 dirty 로 남았다.
            const data = { rows: [{ a: 'keep' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('keep')]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            assert.strictEqual(api.draft().snapshot, JSON.stringify(data));
        });

        test('json-edit 의 mid-edit invalid JSON 은 valid=false 로 알린다', () => {
            const data = { rows: [{ obj: { k: 1 } }] };
            const cell = makeEditingCell(0, 'obj', [makeInput('{ "k": ', { jsonEdit: true })]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            const draft = api.draft();

            assert.strictEqual(draft.valid, false, 'draft 로 표현할 수 없으면 호출부가 무조건 dirty 로 두어야 한다');
            assert.strictEqual(draft.data, data, '표현할 수 없을 때는 커밋된 데이터를 돌려준다');
        });

        test('null 셀을 열어 두기만 하면 draft 가 커밋 데이터와 같다', () => {
            // null / undefined / '' 셀은 input 에 `""` 로 그려진다. 그 자체를
            // 변경으로 보면 (1) 저장 뒤에도 dirty 가 풀리지 않고 — blur 의
            // commitCell 은 empty 가드 때문에 changed 로 보지 않아 dirty 를
            // 다시 계산하지 않는다 — (2) recovery 스냅샷에 null → "" 이 굳는다.
            const data = { rows: [{ a: null }] };
            const cell = makeEditingCell(0, 'a', [makeInput('')]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            const draft = api.draft();

            assert.strictEqual(draft.snapshot, JSON.stringify(data), 'null 을 "" 로 바꾸면 안 된다');
            assert.deepStrictEqual(draft.data, { rows: [{ a: null }] });
        });

        test('그 열이 아예 없는 행에 빈 키를 만들지 않는다', () => {
            // sparse 한 표에서 빈 셀을 열기만 해도 그 행에 `col: ""` 가 생기면,
            // 복구본을 받아 저장할 때 그 변형이 디스크에 기록된다.
            const data = { rows: [{ a: 1 }, { b: 2 }] };
            const cell = makeEditingCell(1, 'a', [makeInput('')]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            assert.deepStrictEqual(api.draft().data, { rows: [{ a: 1 }, { b: 2 }] });
        });

        test('빈 셀에 실제로 값을 입력하면 반영한다 (가드가 과하지 않다)', () => {
            const data = { rows: [{ a: null }] };
            const cell = makeEditingCell(0, 'a', [makeInput('typed')]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            assert.deepStrictEqual(api.draft().data, { rows: [{ a: 'typed' }] });
        });

        test('값이 있던 셀을 비우는 것은 변경이다', () => {
            const data = { rows: [{ a: 'x' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('')]);
            const { api } = bootWebview({ data, sheetMap, editingCell: cell, lastSavedSnapshot: JSON.stringify(data) });

            assert.deepStrictEqual(api.draft().data, { rows: [{ a: '' }] });
        });

        test('scalar 셀은 옛 값의 타입을 따라 보간한다', () => {
            const data = { rows: [{ n: 1, s: '1' }] };
            const numeric = bootWebview({
                data, sheetMap, lastSavedSnapshot: null,
                editingCell: makeEditingCell(0, 'n', [makeInput('42')]),
            }).api.draft();
            const stringy = bootWebview({
                data, sheetMap, lastSavedSnapshot: null,
                editingCell: makeEditingCell(0, 's', [makeInput('42')]),
            }).api.draft();

            assert.deepStrictEqual(numeric.data, { rows: [{ n: 42, s: '1' }] });
            assert.deepStrictEqual(stringy.data, { rows: [{ n: 1, s: '42' }] });
        });
    });

    // ── saveResult 처리 ─────────────────────────────────────────────────────
    suite('saveResult 처리 (실제 메시지 핸들러)', () => {

        function saveResult(api: any, seq: number, success = true) {
            api.handleMessage({ data: { command: 'saveResult', session: SESSION, seq, success } });
        }

        test('응답 대기 중 친 입력이 recovery 로 되돌아간다', () => {
            // P1 재현: B 저장 요청 → 응답 대기 중 셀에 D 입력 → saveResult 도착.
            // 예전에는 이 시점에 **커밋된 B** 를 snapshot 으로 다시 보내, host 의
            // recovery 가 D → B 로 덮여 commit 전에 패널을 닫으면 D 가 사라졌다.
            const committed = { rows: [{ a: 'B' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('D')]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'A' }] }),
                pending: [[1, JSON.stringify(committed)]],
            });

            saveResult(api, 1);

            const snapshots = posted.filter(m => m.command === 'snapshot');
            assert.strictEqual(snapshots.length, 1, 'dirty 인데 recovery 를 다시 채우지 않았다');
            assert.deepStrictEqual(
                snapshots[0].data, { rows: [{ a: 'D' }] },
                '커밋된 데이터를 보내면 응답 대기 중 친 입력이 복구 스냅샷에서 사라진다'
            );
            const ack = posted.find(m => m.command === 'saveAck');
            assert.deepStrictEqual(ack, { command: 'saveAck', seq: 1, dirty: true });
        });

        /**
         * `loadData` 도 **baseline 을 교체하는 경로**다. 디스크 내용이 우리가
         * 쓴 것이 아니게 되므로, 진행 중이던 저장의 스냅샷은 더 이상 "디스크에
         * 있을 내용" 이 아니다.
         *
         * `setSavedBaseline` 과 `markBaselineUnknown` 은 정확히 이 이유로
         * `pendingSaveSnapshots.clear()` 를 하고 주석까지 달아 두었는데
         * `loadData` 만 빠져 있었다. 재로드 경로(host 의 `reload` / 외부 변경
         * 자동 재읽기)에는 `awaitingSaveAck` 가드가 없어 저장 응답을 기다리는
         * 사이에 `loadData` 가 도착할 수 있다.
         *
         * 남겨 두면 두 가지가 깨진다.
         *  - `effectiveBaseline()` 이 재로드된 디스크 내용 대신 **옛 pending
         *    스냅샷**을 기준으로 삼는다. 사용자가 그 내용에 도달하면 `clean` 이
         *    되어 host 가 recovery 를 비우는데, 디스크는 다른 내용이다.
         *  - 뒤늦게 도착한 `saveResult` 가 baseline 을 그 옛 저장 내용으로
         *    **되돌린다**.
         */
        test('loadData 는 진행 중이던 저장 기록을 무효화한다', () => {
            const inFlight = JSON.stringify({ rows: [{ a: 'B' }] });
            const { api } = bootWebview({
                data: { rows: [{ a: 'B' }] },
                sheetMap,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'A' }] }),
                pending: [[1, inFlight]],
            });

            api.handleMessage({
                data: { command: 'loadData', session: SESSION, data: { rows: [{ a: 'D' }] } }
            });

            assert.deepStrictEqual(
                api.state().pending, [],
                'baseline 이 교체됐는데 옛 저장 기록이 남았다 — effectiveBaseline 이 디스크 대신 그것을 기준으로 삼는다'
            );
        });

        test('재로드 뒤 도착한 saveResult 는 baseline 을 되돌리지 않는다', () => {
            const inFlight = JSON.stringify({ rows: [{ a: 'B' }] });
            const reloaded = JSON.stringify({ rows: [{ a: 'D' }] });
            const { api, posted } = bootWebview({
                data: { rows: [{ a: 'B' }] },
                // 재로드가 끝난 상태의 baseline (실제로는 resetHistoryToCurrent 가
                // 세팅한다 — 이 하네스에서는 스텁이라 초기값으로 대신 둔다).
                lastSavedSnapshot: reloaded,
                sheetMap,
                pending: [[1, inFlight]],
            });

            api.handleMessage({
                data: { command: 'loadData', session: SESSION, data: { rows: [{ a: 'D' }] } }
            });
            saveResult(api, 1);

            assert.strictEqual(
                api.state().lastSavedSnapshot, reloaded,
                'baseline 이 옛 저장 내용으로 되돌아갔다 — 화면과 디스크가 다른데 clean 으로 판정될 수 있다'
            );
            const ack = posted.find(m => m.command === 'saveAck');
            assert.strictEqual(ack.dirty, true, '알 수 없는 seq 는 무조건 dirty 여야 한다');
        });

        test('배열 셀의 미커밋 입력도 타입 그대로 recovery 에 남는다', () => {
            const committed = { rows: [{ tags: [1, 2] }] };
            const cell = makeEditingCell(0, 'tags', [
                makeInput('1', { arrIdx: 0 }),
                makeInput('30', { arrIdx: 1 }),
            ]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify(committed),
                pending: [[1, JSON.stringify(committed)]],
            });

            saveResult(api, 1);

            const snapshot = posted.find(m => m.command === 'snapshot');
            assert.ok(snapshot, '배열 셀의 미커밋 입력이 recovery 로 가지 않았다');
            assert.deepStrictEqual(
                snapshot.data, { rows: [{ tags: [1, 30] }] },
                '문자열로 굳으면 복구 후 저장에서 디스크에 문자열 배열이 기록된다'
            );
        });

        test('값을 바꾸지 않고 셀만 열어 둔 상태는 clean 으로 확정된다', () => {
            // P2: `td.editing` 존재만으로 dirty 를 켜면, 이후 blur 는 값이
            // 그대로일 때 commitCell 의 changed 분기를 타지 않아 dirty 가 다시
            // 계산되지 않는다 — 저장했는데도 영원히 dirty 로 남는다.
            const committed = { rows: [{ a: 'same' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('same')]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'old' }] }),
                pending: [[1, JSON.stringify(committed)]],
            });

            saveResult(api, 1);

            const ack = posted.find(m => m.command === 'saveAck');
            assert.deepStrictEqual(ack, { command: 'saveAck', seq: 1, dirty: false });
            assert.deepStrictEqual(
                posted.filter(m => m.command === 'snapshot'), [],
                'clean 인데 snapshot 을 보내면 host 가 방금 비운 recovery 를 되살린다'
            );
        });

        test('빈 셀을 열어 둔 것만으로 dirty 가 되지 않는다', () => {
            // 위 empty 가드가 없으면 이 저장은 clean 으로 확정되지 않고, 이후
            // blur 도 dirty 를 다시 계산하지 않아 편집기가 계속 dirty 로 남는다.
            const committed = { rows: [{ a: null }] };
            const cell = makeEditingCell(0, 'a', [makeInput('')]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'old' }] }),
                pending: [[1, JSON.stringify(committed)]],
            });

            saveResult(api, 1);

            assert.deepStrictEqual(posted.find(m => m.command === 'saveAck'), { command: 'saveAck', seq: 1, dirty: false });
            assert.deepStrictEqual(
                posted.filter(m => m.command === 'snapshot'), [],
                'null 을 "" 로 바꾼 스냅샷이 복구본으로 남으면 복구 후 저장에서 디스크가 바뀐다'
            );
        });

        test('draft 를 표현할 수 없는 미커밋 입력은 무조건 dirty 로 둔다', () => {
            const committed = { rows: [{ obj: { k: 1 } }] };
            const cell = makeEditingCell(0, 'obj', [makeInput('{ "k": ', { jsonEdit: true })]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ obj: { k: 0 } }] }),
                pending: [[1, JSON.stringify(committed)]],
            });

            saveResult(api, 1);

            const ack = posted.find(m => m.command === 'saveAck');
            assert.strictEqual(ack.dirty, true, 'invalid mid-edit 입력을 clean 으로 확정하면 host 가 recovery 를 비운다');
        });

        test('invalid 로 넘어가도 직전의 valid draft 가 recovery 로 간다', () => {
            // json-edit textarea 는 타이핑 도중 반드시 invalid 를 지난다.
            // valid D 를 친 뒤 invalid E 상태에서 응답이 오면, 커밋된 B 를
            // 보내는 순간 host 의 recovery 에 있던 D 가 옛 내용으로 덮인다.
            const committed = { rows: [{ obj: { k: 1 } }] };
            const input = makeInput('{"k":1}', { jsonEdit: true });
            const cell = makeEditingCell(0, 'obj', [input]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify(committed),
                pending: [[1, JSON.stringify(committed)]],
            });

            api.type(input, '{"k":42}');    // valid D — host recovery = D
            api.type(input, '{"k":42');     // invalid E — 아무것도 보내지 않음
            posted.length = 0;              // 저장 응답이 보내는 것만 본다
            saveResult(api, 1);

            const snapshots = posted.filter(m => m.command === 'snapshot');
            assert.strictEqual(snapshots.length, 1, 'dirty 인데 recovery 를 채우지 않았다');
            assert.deepStrictEqual(
                snapshots[0].data, { rows: [{ obj: { k: 42 } }] },
                '커밋된 데이터를 보내면 직전 keystroke 가 남긴 valid draft 가 사라진다'
            );
            assert.strictEqual(posted.find(m => m.command === 'saveAck').dirty, true);
        });

        test('처음부터 invalid 면 커밋 데이터를 새로 보내지 않는다', () => {
            // 보낼 수 있는 draft 가 없다. 커밋 데이터를 밀어 넣으면 host 의
            // recovery 가 (더 나을 수도 있는) 기존 내용에서 덮인다 — dirty
            // 표시만으로 reload/파일 전환은 이미 막힌다.
            const committed = { rows: [{ obj: { k: 1 } }] };
            const input = makeInput('{"k":', { jsonEdit: true });
            const cell = makeEditingCell(0, 'obj', [input]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ obj: { k: 0 } }] }),
                pending: [[1, JSON.stringify(committed)]],
            });

            api.type(input, '{"k":');
            posted.length = 0;
            saveResult(api, 1);

            assert.deepStrictEqual(
                posted.filter(m => m.command === 'snapshot'), [],
                '표현 가능한 draft 가 없는데 커밋 데이터를 recovery 로 밀어 넣었다'
            );
            assert.strictEqual(posted.find(m => m.command === 'saveAck').dirty, true, 'dirty 표시는 유지해야 한다');
        });

        test('입력이 baseline 으로 되돌아오면 캐시도 함께 풀린다', () => {
            // clean 판정에서 host 는 recovery 를 비운다. 그 뒤 invalid 로 넘어가도
            // 되살릴 draft 는 없어야 한다 — 남겨 두면 사용자가 되돌린 값이
            // 복구 프롬프트로 부활한다.
            const committed = { rows: [{ obj: { k: 1 } }] };
            const input = makeInput('{"k":1}', { jsonEdit: true });
            const cell = makeEditingCell(0, 'obj', [input]);
            const { api } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify(committed),
            });

            api.type(input, '{"k":42}');
            assert.notStrictEqual(api.state().lastRecoverableDraft, undefined);
            api.type(input, '{"k":1}');     // baseline 으로 복귀 → clean
            assert.strictEqual(api.state().lastRecoverableDraft, undefined);
        });

        test('저장이 실패해도 아직 날아가고 있는 저장이 dirty 기준이다', () => {
            // seq1=B · seq2=C 가 pending 인 상태에서 seq1 이 **실패**하고 화면은
            // 옛 baseline A 로 undo 돼 있다. 실패한 저장은 디스크에 닿지 않았지만
            // seq2 는 곧 C 를 남기므로 화면(A)과 디스크(C)는 결국 다르다.
            // 여기서 dirty:false 를 보내면 host 가 (saveAck 의 dirty 를 무조건
            // 적용하므로) 복구 항목을 지운다.
            const screen = { rows: [{ a: 'A' }] };
            const { api, posted } = bootWebview({
                data: screen,
                sheetMap,
                lastSavedSnapshot: JSON.stringify(screen),
                pending: [
                    [1, JSON.stringify({ rows: [{ a: 'B' }] })],
                    [2, JSON.stringify({ rows: [{ a: 'C' }] })],
                ],
            });

            saveResult(api, 1, false);

            const ack = posted.find(m => m.command === 'saveAck');
            assert.deepStrictEqual(
                ack, { command: 'saveAck', seq: 1, dirty: true },
                '남은 저장이 디스크의 최종 내용을 정하는데 clean 으로 알렸다'
            );
            assert.strictEqual(
                api.state().lastSavedSnapshot, JSON.stringify(screen),
                '실패한 저장이 baseline 을 옮기면 안 된다'
            );
            assert.deepStrictEqual(
                api.state().pending.map((e: [unknown, string]) => e[0]), [2],
                '응답받은 항목만 pending 에서 빠져야 한다'
            );
        });

        test('실패해도 남은 저장이 화면과 같으면 clean 이다 (가드가 과하지 않다)', () => {
            const screen = { rows: [{ a: 'C' }] };
            const { api, posted } = bootWebview({
                data: screen,
                sheetMap,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'A' }] }),
                pending: [
                    [1, JSON.stringify({ rows: [{ a: 'B' }] })],
                    [2, JSON.stringify(screen)],
                ],
            });

            saveResult(api, 1, false);

            assert.strictEqual(
                posted.find(m => m.command === 'saveAck').dirty, false,
                '곧 디스크가 화면과 같아지는데 불필요하게 dirty 로 남겼다'
            );
        });

        test('남의 세션 응답은 pending 스냅샷을 건드리지 않는다', () => {
            const committed = { rows: [{ a: 1 }] };
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                lastSavedSnapshot: JSON.stringify(committed),
                pending: [[1, JSON.stringify(committed)]],
            });

            api.handleMessage({ data: { command: 'saveResult', session: SESSION + 1, seq: 1, success: true } });

            assert.deepStrictEqual(posted, [], '남의 세션 응답에 반응하면 안 된다');
            assert.strictEqual(api.state().pending.length, 1, '남의 응답으로 pending 을 지우면 내 응답이 unknown seq 로 떨어진다');
        });
    });

    // ── baseline 교체 경로 ──────────────────────────────────────────────────
    suite('baseline 교체 경로도 같은 draft 를 쓴다', () => {

        test('setSavedBaseline: 커밋 데이터가 새 디스크와 같아도 활성 입력이 있으면 dirty', () => {
            // 외부 변경 *Keep current edits* 분기. 커밋된 data 만 보면 새 디스크
            // 내용과 같아 clean 이 되고, host 가 recovery 를 지운다 — 화면에는
            // 아직 커밋 안 된 입력이 남아 있는데도.
            const committed = { rows: [{ a: 'same' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('typing')]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify({ rows: [{ a: 'old' }] }),
            });

            api.handleMessage({ data: { command: 'setSavedBaseline', session: SESSION, data: committed } });

            assert.deepStrictEqual(
                posted.find(m => m.command === 'modified'), { command: 'modified', value: true },
                '활성 셀의 입력이 디스크와 다른데 clean 으로 처리했다'
            );
            assert.deepStrictEqual(
                posted.find(m => m.command === 'snapshot')?.data, { rows: [{ a: 'typing' }] },
                'recovery 에는 커밋 데이터가 아니라 화면의 입력이 들어가야 한다'
            );
        });

        test('markBaselineUnknown: recovery 로 미커밋 입력을 보낸다', () => {
            const committed = { rows: [{ a: 'committed' }] };
            const cell = makeEditingCell(0, 'a', [makeInput('typing')]);
            const { api, posted } = bootWebview({
                data: committed,
                sheetMap,
                editingCell: cell,
                lastSavedSnapshot: JSON.stringify(committed),
            });

            api.handleMessage({ data: { command: 'markBaselineUnknown', session: SESSION } });

            assert.deepStrictEqual(
                posted.find(m => m.command === 'snapshot')?.data, { rows: [{ a: 'typing' }] },
                'baseline 을 모르는 상태에서 커밋 데이터를 보내면 미커밋 입력이 덮인다'
            );
        });

        /** invalid 입력 상태에서 두 경로가 각각 무엇을 보내는지. */
        for (const command of ['setSavedBaseline', 'markBaselineUnknown']) {
            test(`${command}: invalid 입력이면 직전 valid draft 를 보낸다`, () => {
                const committed = { rows: [{ obj: { k: 1 } }] };
                const input = makeInput('{"k":1}', { jsonEdit: true });
                const cell = makeEditingCell(0, 'obj', [input]);
                const { api, posted } = bootWebview({
                    data: committed,
                    sheetMap,
                    editingCell: cell,
                    lastSavedSnapshot: JSON.stringify(committed),
                });

                api.type(input, '{"k":42}');
                api.type(input, '{"k":42');
                posted.length = 0;
                api.handleMessage({ data: { command, session: SESSION, data: committed } });

                assert.deepStrictEqual(
                    posted.find(m => m.command === 'snapshot')?.data, { rows: [{ obj: { k: 42 } }] },
                    '커밋 데이터를 보내면 직전 keystroke 가 남긴 valid draft 가 덮인다'
                );
            });

            test(`${command}: 표현 가능한 draft 가 없으면 아무것도 보내지 않는다`, () => {
                const committed = { rows: [{ obj: { k: 1 } }] };
                const input = makeInput('{"k":', { jsonEdit: true });
                const cell = makeEditingCell(0, 'obj', [input]);
                const { api, posted } = bootWebview({
                    data: committed,
                    sheetMap,
                    editingCell: cell,
                    lastSavedSnapshot: JSON.stringify(committed),
                });

                api.type(input, '{"k":');
                posted.length = 0;
                api.handleMessage({ data: { command, session: SESSION, data: committed } });

                assert.deepStrictEqual(
                    posted.filter(m => m.command === 'snapshot'), [],
                    '표현 가능한 draft 가 없는데 커밋 데이터를 recovery 로 밀어 넣었다'
                );
                // dirty 는 이미 keystroke 에서 host 로 갔다 (setModified 는 값이
                // 바뀔 때만 보낸다). 여기서는 그것이 풀리지 않았는지를 본다.
                assert.strictEqual(api.state().modified, true, 'dirty 표시는 유지해야 reload/전환이 막힌다');
            });
        }
    });
});
