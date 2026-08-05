import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewContent } from '../jsonEditor';

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
    const html = getWebviewContent({ rows: [{ a: 1 }] }, undefined, '/tmp/sample.json', fakeWebview, false, SESSION);

    /** webview HTML 에서 `function name(...) { ... }` 하나를 통째로 뽑는다. */
    function extractFn(name: string): string {
        const re = new RegExp('\\n    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}');
        const m = html.match(re);
        assert.ok(m, `webview 스크립트에서 function ${name} 을 찾지 못했다`);
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
            extractFn('parseValue'),
            extractFn('coerceCellValue'),
            extractFn('coerceEditedArrayItems'),
            extractFn('buildDraftSnapshot'),
            extractFn('effectiveBaselineOf'),
            extractFn('effectiveBaseline'),
            extractFn('decideSaveResult'),
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
            'function buildSheetMap() {}',
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
            'document', 'vscode', 'SESSION_ID', 'BASELINE_UNKNOWN_SENTINEL',
            'data', 'sheetMap', 'lastSavedSnapshot', 'modified', 'pendingSaveSnapshots',
            script
        );
        const api = factory(
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
                extractFn('parseValue'),
                extractFn('coerceCellValue'),
                extractFn('coerceEditedArrayItems'),
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

            const factory = new Function('data', 'sheetMap', 'historyPushes', 'errors', script);
            const api = factory(data, sheets, historyPushes, errors);
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

        /** `document.querySelectorAll('[data-…]').forEach(btn => { … });` 블록 하나. */
        function extractWiring(attr: string): string {
            const re = new RegExp(
                'document\\.querySelectorAll\\(\'\\[' + attr + '\\]\'\\)\\.forEach\\(btn => \\{[\\s\\S]*?\\n        \\}\\);'
            );
            const m = html.match(re);
            assert.ok(m, `webview 스크립트에서 ${attr} 배선을 찾지 못했다`);
            return m![0];
        }

        function bootHandlers(data: unknown, sheets: { label: string; path: string[] }[] = sheetMap) {
            /** 핸들러가 "진행했다" 는 증거. 빠져나갔으면 비어 있어야 한다. */
            const calls: string[] = [];
            const td = makeEditingCell(0, 'tags', [
                makeInput('1', { arrIdx: 0 }),
                makeInput('2', { arrIdx: 1 }),
            ]);
            const handlers: Record<string, (e: unknown) => void> = {};
            const doc = {
                querySelectorAll(selector: string) {
                    assert.ok(selector === REMOVE || selector === ADD, `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return [{
                        dataset: { removeArr: '0' },
                        closest: (sel: string) => {
                            assert.strictEqual(sel, 'td', `가짜 DOM 이 모르는 셀렉터: ${sel}`);
                            return td;
                        },
                        addEventListener: (type: string, fn: (e: unknown) => void) => {
                            assert.strictEqual(type, 'click', `예상 밖의 이벤트: ${type}`);
                            handlers[selector] = fn;
                        },
                    }];
                },
                // "+" 는 다시 그린 뒤 새 td 를 찾아 포커스한다. 이 가짜 DOM 은
                // 다시 그리지 않으므로 없다고 답한다 — 실제 코드도 `if (newTd)`
                // 로 그 경우를 다룬다.
                querySelector(selector: string) {
                    calls.push('querySelector');
                    assert.strictEqual(selector, 'td[data-row="0"][data-col="tags"]', `가짜 DOM 이 모르는 셀렉터: ${selector}`);
                    return null;
                },
            };

            const script = [
                extractFn('parseValue'),
                extractFn('coerceCellValue'),
                extractFn('coerceEditedArrayItems'),
                extractFn('getActiveRows'),
                extractFn('syncEditingArrayCellToData'),
                'let activeIdx = 0;',
                'function pushHistory() { calls.push("pushHistory"); }',
                'function renderTable() { calls.push("renderTable"); }',
                extractWiring('data-remove-arr'),
                extractWiring('data-add-arr'),
            ].join('\n');
            new Function('document', 'data', 'sheetMap', 'calls', script)(doc, data, sheets, calls);

            return {
                calls,
                click(selector: string) {
                    const fn = handlers[selector];
                    assert.ok(fn, `${selector} 에 click 핸들러가 등록되지 않았다`);
                    fn({ stopPropagation() { /* 실제 코드가 부른다 */ } });
                },
            };
        }

        test('활성 시트가 없으면 ✕ 는 아무것도 하지 않는다', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data, []);

            click(REMOVE);

            assert.deepStrictEqual(calls, [], 'sync 가 null 을 돌려줬는데 진행했다');
            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2] }] });
        });

        test('활성 시트가 없으면 + 도 아무것도 하지 않는다', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data, []);

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
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable']);
        });

        test('정상 상태에서는 + 가 실제로 추가한다 (양성 대조)', () => {
            const data = { rows: [{ tags: [1, 2] }] };
            const { click, calls } = bootHandlers(data);

            click(ADD);

            assert.deepStrictEqual(data, { rows: [{ tags: [1, 2, ''] }] });
            assert.deepStrictEqual(calls, ['pushHistory', 'renderTable', 'querySelector']);
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
