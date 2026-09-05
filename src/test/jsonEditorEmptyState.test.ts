import * as assert from 'assert';
import { buildJsonEditorStrings, getWebviewContent } from '../jsonEditor';
import { addJsonEditorField, buildSheetMap, coerceEditedCellValue, coerceEditedArrayItems, effectiveBaseline, getRowsByPath } from '../jsonEditorUtils';

/** 실제 배포 HTML의 폼 이벤트와 history/save 경로를 최소 DOM 위에서 실행한다. */
function boot(initial: Record<string, unknown>) {
    const html = getWebviewContent(initial, undefined, '/tmp/empty.json', { cspSource: 'https://test.invalid' } as any,
        false, 1, 'https://test.invalid/logic.js');
    const functions = [
        'escapeHtml', 'escapeAttr', 'fmt', 'isPlainObject', 'getActiveRows', 'rebuildSheetMap',
        'renderTable', 'setFieldFormVisible', 'resetFieldForm', 'syncFieldFormForSheet', 'showFieldForm', 'cancelFieldForm', 'setModified',
        'pushHistory', 'resetHistoryToCurrent', 'updateUndoRedoButtons', 'restoreFromHistoryIndex',
        'undo', 'redo', 'saveAction', 'currentBaseline', 'evictHistoryToCap', 'commitActiveCellOrAbort', 'commitCell',
    ].map(name => {
        const found = html.match(new RegExp('\\n    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}'));
        assert.ok(found, `실제 ${name} 함수를 찾지 못했다`);
        return found![0];
    });
    functions.push(html.match(/function snapshotData\(\) \{[^\n]+\}/)![0]);
    const wiring = [
        ['btnAddField', 'click'], ['btnCancelField', 'click'], ['fieldForm', 'keydown'],
        ['fieldForm', 'submit'], ['btnAddRow', 'click'], ['btnOpenSource', 'click'],
    ].map(([id, event]) => {
        const found = html.match(new RegExp("document\\.getElementById\\('" + id + "'\\)\\.addEventListener\\('" + event
            + "', (?:[A-Za-z]+\\);|\\([^)]*\\) => \\{[\\s\\S]*?\\n    \\}\\);)"));
        assert.ok(found, `${id} ${event} 배선을 찾지 못했다`);
        return found![0];
    });
    let focused = '';
    let editingCell: any;
    const timers: Array<() => void> = [];
    class Element {
        value = '';
        private markup = '';
        get innerHTML() { return this.markup; }
        set innerHTML(value: string) {
            this.markup = value;
            if (this.id === 'tableWrapper' && editingCell) {
                editingCell.isConnected = false;
                editingCell = undefined;
            }
        }
        textContent = '';
        hidden = false;
        disabled = false;
        readonly attrs = new Map<string, string>();
        readonly listeners = new Map<string, (event: any) => void>();
        readonly classList = { toggle: () => {} };
        closest?: (selector: string) => unknown;
        constructor(readonly id: string) {}
        setAttribute(key: string, value: string) { this.attrs.set(key, value); }
        removeAttribute(key: string) { this.attrs.delete(key); }
        focus() { focused = this.id; }
        addEventListener(event: string, callback: (event: any) => void) { this.listeners.set(event, callback); }
        fire(event: string, values: Record<string, unknown> = {}) {
            this.listeners.get(event)?.({ preventDefault() {}, ...values });
        }
    }
    const elements = new Map<string, Element>();
    const element = (id: string): Element => {
        if (!elements.has(id)) { elements.set(id, new Element(id)); }
        return elements.get(id)!;
    };
    const posted: any[] = [];
    let api: {
        data(): Record<string, unknown>; undo(): void; redo(): void; save(): void; render(): void; dirty(): boolean;
        wireCellInputs(): void; switchSheet(index: number): void;
    };
    const document = {
        getElementById: element,
        querySelector: (selector: string) => {
            assert.strictEqual(selector, 'td.editing');
            return editingCell?.classList.contains('editing') ? editingCell : null;
        },
        querySelectorAll: (selector: string) => {
            if (selector === '.cell-edit input[type="text"]:not([data-arr-idx])') {
                return editingCell ? [editingCell.input] : [];
            }
            assert.strictEqual(selector, 'td[data-col]');
            const rows = getRowsByPath(api?.data() ?? initial, buildSheetMap(api?.data() ?? initial)[0]?.path ?? []);
            const row = rows?.find(value => value !== null && typeof value === 'object' && !Array.isArray(value));
            return Object.keys(row ?? {}).map(col => ({ dataset: { col }, querySelector: () => ({ focus: () => { focused = col; } }) }));
        },
    };
    const simpleInputWiring = html.match(/document\.querySelectorAll\('\.cell-edit input\[type="text"\]:not\(\[data-arr-idx\]\)'\)\.forEach\(input => \{[\s\S]*?\n        \}\);/);
    assert.ok(simpleInputWiring, '실제 셀 input의 Enter/blur 배선을 찾지 못했다');
    const script = [
        'let data = JSON.parse(JSON.stringify(initial)), sheetMap = [], activeIdx = 0, modified = false;',
        'let fieldFormSheetKey, fieldFormHadFields = false;',
        'let historyStack = [], historyIndex = -1, lastSavedSnapshot = null, savedSnapshot, lastRecoverableDraft, saveSeq = 0;',
        'const pendingSaveSnapshots = new Map(), MAX_PENDING_SAVES = 8, HISTORY_MAX_STEPS = 20, HISTORY_MAX_BYTES = 16 * 1024 * 1024;',
        'function renderTabs() {} function attachCellEvents() {} function detectMultiline() { return false; }',
        'function renderCellView(value) { return "<div class=cell-view>" + escapeHtml(String(value)) + "</div>"; }',
        'function renderCellEdit() { return ""; } function announce(message) { document.getElementById("status").textContent = message; }',
        'function showError(message) { document.getElementById("cellError").textContent = message; }',
        'function wireCellInputs() {' + simpleInputWiring![0] + '}',
        ...functions, ...wiring,
        'rebuildSheetMap(); renderTable(); resetHistoryToCurrent();',
        'return {data: () => data, undo, redo, save: saveAction, render: renderTable, dirty: () => modified, wireCellInputs, switchSheet: index => { activeIdx = index; renderTable(); }};',
    ].join('\n');
    api = new Function('initial', 'document', 'S', 'vscode', 'setTimeout',
        'addJsonEditorField', 'buildSheetMap', 'getRowsByPath', 'effectiveBaseline', 'coerceEditedCellValue', 'coerceEditedArrayItems', script)(
        initial, document, buildJsonEditorStrings(), { postMessage: (value: unknown) => posted.push(JSON.parse(JSON.stringify(value))) },
        (callback: () => void) => timers.push(callback), addJsonEditorField, buildSheetMap, getRowsByPath, effectiveBaseline,
        coerceEditedCellValue, coerceEditedArrayItems
    );
    function editCell(col: string, value: string, json: boolean = false): Element {
        const input = new Element('cell-input');
        input.value = value;
        let editing = true;
        const td = {
            input, dataset: { row: '0', col }, isConnected: true,
            classList: {
                contains: (name: string) => name === 'editing' && editing,
                remove: () => { editing = false; },
            },
            querySelector: (selector: string) => {
                if (selector === '.cell-edit textarea.json-edit') { return json ? input : null; }
                if (selector === '.cell-edit textarea') { return null; }
                if (selector === '.cell-edit input') { return input; }
                throw new Error('알 수 없는 셀 selector: ' + selector);
            },
        };
        input.closest = () => td;
        editingCell = td;
        api.wireCellInputs();
        return input;
    }
    return { api, element, posted, focused: () => focused, editCell, flushTimers: () => {
        while (timers.length > 0) { timers.shift()!(); }
    }, html };
}

suite('JSON Editor 빈 표와 필드 생성', () => {
    test('배열 없는 일반 객체는 내용을 보존하고 행/필드 대신 원문 열기를 제공한다', () => {
        const h = boot({ enabled: true });
        assert.strictEqual(h.element('btnAddRow').disabled, true);
        assert.strictEqual(h.element('btnAddField').disabled, true);
        assert.ok(h.element('tableWrapper').innerHTML.includes(buildJsonEditorStrings().noSheets));
        h.element('btnOpenSource').fire('click');
        assert.deepStrictEqual(h.posted, [{ command: 'openSource' }]);
        assert.deepStrictEqual(h.api.data(), { enabled: true });
    });

    for (const initialRows of [[], [{}]]) {
        test(`${JSON.stringify(initialRows)}의 필드 생성은 편집·저장·Undo·복구 경로에 들어간다`, () => {
            const h = boot({ rows: initialRows });
            h.element('btnAddRow').fire('click');
            assert.deepStrictEqual(h.api.data(), { rows: initialRows }, '행 추가로 빈 객체를 쌓지 않는다');
            assert.strictEqual(h.focused(), 'fieldName');
            h.element('fieldName').value = ' name ';
            h.element('fieldForm').fire('submit');
            assert.deepStrictEqual(h.api.data(), { rows: [{ name: '' }] });
            assert.ok(h.element('tableWrapper').innerHTML.includes('data-col="name"'));
            assert.strictEqual(h.focused(), 'name');
            assert.strictEqual(h.api.dirty(), true);
            assert.deepStrictEqual(h.posted.find(message => message.command === 'snapshot').data, { rows: [{ name: '' }] });
            h.api.save();
            assert.deepStrictEqual(h.posted.find(message => message.command === 'save').data, { rows: [{ name: '' }] });
            // 응답 대기 저장의 baseline과 Undo는 별도 회귀 테스트가 검증한다.
            const fresh = boot({ rows: initialRows });
            fresh.element('fieldName').value = 'name';
            fresh.element('fieldForm').fire('submit');
            fresh.api.undo();
            assert.deepStrictEqual(fresh.api.data(), { rows: initialRows });
            assert.strictEqual(fresh.api.dirty(), false);
            fresh.api.redo();
            assert.deepStrictEqual(fresh.api.data(), { rows: [{ name: '' }] });
        });
    }

    test('기존 표는 필드를 늘릴 수 있고 빈 이름·중복 이름·취소는 데이터를 바꾸지 않는다', () => {
        const h = boot({ rows: [{ name: 'A' }, { name: 'B' }] });
        for (const value of ['   ', 'name']) {
            h.element('btnAddField').fire('click');
            h.element('fieldName').value = value;
            h.element('fieldForm').fire('submit');
            assert.strictEqual(h.element('fieldName').attrs.get('aria-invalid'), 'true');
            assert.strictEqual(h.focused(), 'fieldName');
            assert.strictEqual(h.api.dirty(), false);
        }
        h.element('fieldForm').fire('keydown', { key: 'Escape' });
        assert.strictEqual(h.element('fieldForm').hidden, true);
        assert.strictEqual(h.focused(), 'btnAddField');
        h.element('btnAddField').fire('click');
        h.element('fieldName').value = 'new';
        h.element('btnCancelField').fire('click');
        assert.strictEqual(h.api.dirty(), false);
        h.element('btnAddField').fire('click');
        h.element('fieldName').value = 'count';
        h.element('fieldForm').fire('submit');
        assert.deepStrictEqual(h.api.data(), { rows: [{ name: 'A', count: '' }, { name: 'B', count: '' }] });
    });

    test('마지막 행 삭제 후에는 필드 폼을 다시 제공한다', () => {
        const h = boot({ rows: [{ name: 'A' }] });
        (h.api.data().rows as unknown[]).splice(0, 1);
        h.api.render();
        assert.strictEqual(h.element('fieldForm').hidden, false);
        h.element('fieldName').value = 'id';
        h.element('fieldForm').fire('submit');
        assert.deepStrictEqual(h.api.data(), { rows: [{ id: '' }] });
    });

    for (const blurBeforeSubmit of [false, true]) {
        test(`필드 제출 전 셀 ${blurBeforeSubmit ? '지연 blur' : '동기 commit'} 재렌더가 필드 이름을 지우지 않는다`, () => {
            const h = boot({ rows: [{ name: 'A' }] });
            h.element('btnAddField').fire('click');
            h.element('fieldName').value = 'newColumn';
            const input = h.editCell('name', 'B');
            // 실제 input blur 리스너의 타이머를 예약한다. 제출이 먼저 일어나면
            // commitActiveCellOrAbort가, 타이머가 먼저면 blur가 실제 commitCell을 부른다.
            input.fire('blur');
            if (blurBeforeSubmit) {
                h.flushTimers();
                assert.strictEqual(h.element('fieldForm').hidden, false);
                assert.strictEqual(h.element('fieldName').value, 'newColumn');
            }
            h.element('fieldForm').fire('submit');
            h.flushTimers();
            assert.deepStrictEqual(h.api.data(), { rows: [{ name: 'B', newColumn: '' }] });
            assert.strictEqual(h.element('fieldError').textContent, '');
            assert.strictEqual(h.element('fieldForm').hidden, true, '성공한 제출은 폼을 닫는다');
            assert.strictEqual(h.element('fieldName').value, '');
            const snapshots = h.posted.filter(message => message.command === 'snapshot');
            assert.strictEqual(snapshots.length, 2, '셀 편집과 필드 추가가 각자의 Undo/복구 단계를 만든다');
        });
    }

    test('셀 Enter commit은 열려 있는 필드 오류를 숨기지 않고 시트 전환만 초기화한다', () => {
        const h = boot({ first: [{ name: 'A' }], second: [{ id: 1 }] });
        h.element('btnAddField').fire('click');
        h.element('fieldName').value = 'name';
        h.element('fieldForm').fire('submit');
        const error = buildJsonEditorStrings().fieldNameDuplicate;
        assert.strictEqual(h.element('fieldError').textContent, error);
        h.editCell('name', 'B').fire('keydown', { key: 'Enter' });
        assert.strictEqual(h.element('fieldForm').hidden, false);
        assert.strictEqual(h.element('fieldName').value, 'name');
        assert.strictEqual(h.element('fieldError').textContent, error);
        assert.strictEqual(h.element('fieldName').attrs.get('aria-invalid'), 'true');
        h.api.switchSheet(1);
        assert.strictEqual(h.element('fieldForm').hidden, true);
        assert.strictEqual(h.element('fieldName').value, '');
        assert.strictEqual(h.element('fieldError').textContent, '');
        h.api.switchSheet(0);
        assert.strictEqual(h.element('fieldForm').hidden, true);
    });

    test('필드 없는 시트에서도 취소한 폼을 같은 시트의 재렌더가 다시 열지 않는다', () => {
        const h = boot({ rows: [] });
        h.element('fieldName').value = 'draft';
        h.element('btnCancelField').fire('click');
        h.api.render();
        assert.strictEqual(h.element('fieldForm').hidden, true);
        assert.strictEqual(h.element('fieldName').value, '');
        h.element('btnAddField').fire('click');
        assert.strictEqual(h.element('fieldForm').hidden, false);
        assert.strictEqual(h.focused(), 'fieldName');
    });

    test('파싱 중인 셀은 필드 추가로 사라지지 않으며 원문 열기는 막지 않는다', () => {
        const h = boot({ rows: [{ value: { a: 1 } }] });
        h.editCell('value', '{', true);
        h.element('btnAddField').fire('click');
        assert.strictEqual(h.element('fieldForm').hidden, true);
        h.element('fieldName').value = 'other';
        h.element('fieldForm').fire('submit');
        assert.deepStrictEqual(h.api.data(), { rows: [{ value: { a: 1 } }] });
        h.element('btnOpenSource').fire('click');
        assert.deepStrictEqual(h.posted, [{ command: 'openSource' }]);
    });

    test('특수 키는 prototype을 바꾸지 않고 JSON 데이터로 왕복한다', () => {
        for (const name of ['__proto__', 'constructor', 'prototype']) {
            const rows: unknown[] = [];
            assert.strictEqual(addJsonEditorField(rows, name), 'added');
            const row = rows[0] as Record<string, unknown>;
            assert.strictEqual(Object.getPrototypeOf(row), Object.prototype);
            assert.strictEqual(Object.hasOwn(row, name), true);
            assert.strictEqual(JSON.parse(JSON.stringify(row))[name], '');
            assert.strictEqual(addJsonEditorField(rows, name), 'duplicate-name');
        }
    });
});
