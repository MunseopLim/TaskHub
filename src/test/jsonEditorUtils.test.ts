import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildSheetMap, getRowsByPath, SheetEntry, parseValue, coerceEditedCellValue, shouldOfferRecovery, RecoveryEntry, makeRecoveryStore, MinimalWorkspaceState, buildDraftSnapshot, DraftSnapshotInput } from '../jsonEditorUtils';
import { wrapIfArray, unwrapIfRootArray, ROOT_ARRAY_KEY } from '../jsonEditor';

function readSourceForRegex(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

suite('JsonEditorUtils Test Suite', () => {
    suite('buildSheetMap', () => {
        test('flat array sheets', () => {
            const data = {
                sheet1: [{ a: 1 }],
                sheet2: [{ b: 2 }]
            };
            const result = buildSheetMap(data);
            assert.deepStrictEqual(result, [
                { label: 'sheet1', path: ['sheet1'] },
                { label: 'sheet2', path: ['sheet2'] }
            ]);
        });

        test('nested object with sub-arrays', () => {
            const data = {
                sheet1: [{ a: 1 }],
                sheet2: {
                    info: [{ name: 'test' }],
                    test: [{ name: 'test2' }]
                }
            };
            const result = buildSheetMap(data);
            assert.deepStrictEqual(result, [
                { label: 'sheet1', path: ['sheet1'] },
                { label: 'sheet2 > info', path: ['sheet2', 'info'] },
                { label: 'sheet2 > test', path: ['sheet2', 'test'] }
            ]);
        });

        test('nested object with non-array values are skipped', () => {
            const data = {
                config: {
                    name: 'test',
                    items: [{ a: 1 }]
                }
            };
            const result = buildSheetMap(data);
            assert.deepStrictEqual(result, [
                { label: 'config > items', path: ['config', 'items'] }
            ]);
        });

        test('empty object returns empty map', () => {
            const result = buildSheetMap({});
            assert.deepStrictEqual(result, []);
        });

        test('mixed: arrays, objects, and primitives', () => {
            const data = {
                list: [{ x: 1 }],
                nested: {
                    sub: [{ y: 2 }]
                },
                count: 42,
                label: 'text'
            };
            const result = buildSheetMap(data as Record<string, unknown>);
            assert.deepStrictEqual(result, [
                { label: 'list', path: ['list'] },
                { label: 'nested > sub', path: ['nested', 'sub'] }
            ]);
        });

        test('empty arrays are included', () => {
            const data = {
                empty: [] as unknown[]
            };
            const result = buildSheetMap(data);
            assert.deepStrictEqual(result, [
                { label: 'empty', path: ['empty'] }
            ]);
        });
    });

    suite('getRowsByPath', () => {
        const data = {
            sheet1: [{ a: 1 }, { a: 2 }],
            sheet2: {
                info: [{ name: 'test' }],
                test: [{ name: 'test2' }]
            }
        };

        test('single-level path', () => {
            const rows = getRowsByPath(data, ['sheet1']);
            assert.deepStrictEqual(rows, [{ a: 1 }, { a: 2 }]);
        });

        test('two-level path', () => {
            const rows = getRowsByPath(data, ['sheet2', 'info']);
            assert.deepStrictEqual(rows, [{ name: 'test' }]);
        });

        test('returns reference to original array (mutations propagate)', () => {
            const testData = { items: [{ v: 1 }] };
            const rows = getRowsByPath(testData, ['items']);
            assert.ok(rows);
            rows!.push({ v: 2 });
            assert.strictEqual((testData.items as unknown[]).length, 2);
        });

        test('invalid path returns null', () => {
            const rows = getRowsByPath(data, ['nonexistent']);
            assert.strictEqual(rows, null);
        });

        test('path to non-array returns null', () => {
            const rows = getRowsByPath({ config: 'string' }, ['config']);
            assert.strictEqual(rows, null);
        });

        test('deep invalid path returns null', () => {
            const rows = getRowsByPath(data, ['sheet2', 'nonexistent']);
            assert.strictEqual(rows, null);
        });
    });

    suite('wrapIfArray', () => {
        test('should wrap top-level array', () => {
            const data = [{ id: 'a' }, { id: 'b' }];
            const result = wrapIfArray(data);
            assert.strictEqual(result.isRootArray, true);
            assert.ok(ROOT_ARRAY_KEY in result.wrapped);
            assert.deepStrictEqual(result.wrapped[ROOT_ARRAY_KEY], data);
        });

        test('should not wrap object', () => {
            const data = { items: [1, 2, 3] };
            const result = wrapIfArray(data);
            assert.strictEqual(result.isRootArray, false);
            assert.deepStrictEqual(result.wrapped, data);
        });

        test('should wrap empty array', () => {
            const result = wrapIfArray([]);
            assert.strictEqual(result.isRootArray, true);
            assert.deepStrictEqual(result.wrapped[ROOT_ARRAY_KEY], []);
        });

        test('wrapped array works with buildSheetMap', () => {
            const data = [{ id: 'action1', title: 'Test' }];
            const { wrapped } = wrapIfArray(data);
            const sheets = buildSheetMap(wrapped);
            assert.strictEqual(sheets.length, 1);
            assert.strictEqual(sheets[0].label, ROOT_ARRAY_KEY);
            assert.deepStrictEqual(sheets[0].path, [ROOT_ARRAY_KEY]);
        });

        test('wrapped array rows accessible via getRowsByPath', () => {
            const data = [{ id: 'a' }, { id: 'b' }];
            const { wrapped } = wrapIfArray(data);
            const rows = getRowsByPath(wrapped, [ROOT_ARRAY_KEY]);
            assert.deepStrictEqual(rows, data);
        });
    });

    suite('unwrapIfRootArray', () => {
        test('should unwrap when isRootArray is true', () => {
            const original = [{ id: 'a' }];
            const wrapped = { [ROOT_ARRAY_KEY]: original };
            const result = unwrapIfRootArray(wrapped, true);
            assert.deepStrictEqual(result, original);
        });

        test('should return object as-is when isRootArray is false', () => {
            const data = { items: [1, 2] };
            const result = unwrapIfRootArray(data, false);
            assert.deepStrictEqual(result, data);
        });

        test('should return object as-is when key is missing and isRootArray is true', () => {
            const data = { other: 'value' };
            const result = unwrapIfRootArray(data as any, true);
            assert.deepStrictEqual(result, data);
        });

        test('round-trip: wrap then unwrap preserves original array', () => {
            const original = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
            const { wrapped, isRootArray } = wrapIfArray(original);
            const restored = unwrapIfRootArray(wrapped, isRootArray);
            assert.deepStrictEqual(restored, original);
        });

        test('round-trip: wrap then unwrap preserves original object', () => {
            const original = { links: [{ title: 'x', link: 'y' }] };
            const { wrapped, isRootArray } = wrapIfArray(original);
            const restored = unwrapIfRootArray(wrapped, isRootArray);
            assert.deepStrictEqual(restored, original);
        });
    });

    suite('coerceEditedCellValue (string type preservation)', () => {
        test('keeps a leading-zero numeric string as a string when original was a string', () => {
            // Regression: before the fix, editing "00123" committed the value as
            // the number 123 and lost the leading zeros.
            assert.strictEqual(coerceEditedCellValue('00123', 'original'), '00123');
        });

        test('keeps the literal "true" / "false" / "null" as strings when original was a string', () => {
            assert.strictEqual(coerceEditedCellValue('true', ''), 'true');
            assert.strictEqual(coerceEditedCellValue('false', ''), 'false');
            assert.strictEqual(coerceEditedCellValue('null', ''), 'null');
        });

        test('still coerces values when the original cell was a number', () => {
            assert.strictEqual(coerceEditedCellValue('42', 7), 42);
        });

        test('still coerces values when the original cell was a boolean', () => {
            assert.strictEqual(coerceEditedCellValue('false', true), false);
        });

        test('parseValue behaves as the documented coercion', () => {
            assert.strictEqual(parseValue(''), '');
            assert.strictEqual(parseValue('null'), null);
            assert.strictEqual(parseValue('true'), true);
            assert.strictEqual(parseValue('false'), false);
            assert.strictEqual(parseValue('42'), 42);
            assert.strictEqual(parseValue('Infinity'), 'Infinity');
            assert.strictEqual(parseValue('-Infinity'), '-Infinity');
            assert.strictEqual(parseValue('hello'), 'hello');
        });
    });

    /**
     * Regression coverage for three draft-recovery bugs that the source-regex
     * mirror guards could not catch:
     *
     *   1) Primitive draft snapshots used to coerce number/boolean/null cells
     *      to string by always assigning `input.value`. After commit-aligned
     *      coercion, the draft preserves the original cell type.
     *   2) JSON-edit textareas were skipped wholesale; valid JSON drafts now
     *      flow into the recovery snapshot, while invalid input is dropped.
     *   3) Drafts that revert the cell to its saved value used to leave a
     *      stale recovery entry behind, producing a phantom recovery prompt
     *      on reopen. The helper now reports `clean` so the caller can clear
     *      the entry via `modified=false`.
     */
    suite('buildDraftSnapshot (draft recovery semantics)', () => {
        function input(partial: Partial<DraftSnapshotInput> & Pick<DraftSnapshotInput, 'data' | 'sheetPath' | 'rowIdx' | 'col' | 'rawInputValue'>): DraftSnapshotInput {
            return {
                lastSavedSnapshot: null,
                ...partial
            };
        }

        test('preserves number type for primitive cell drafts', () => {
            const data = { items: [{ qty: 2 }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'qty',
                rawInputValue: '3'
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.strictEqual(snap.items[0].qty, 3);
            assert.strictEqual(typeof snap.items[0].qty, 'number');
            // Source data must not be mutated — same invariant as the original
            // sendDraftSnapshot; otherwise commitCell's string-vs-non-string
            // branch in jsonEditor.ts would observe corrupted oldVal types.
            assert.strictEqual(data.items[0].qty, 2);
        });

        test('preserves boolean type for primitive cell drafts', () => {
            const data = { items: [{ enabled: true }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'enabled',
                rawInputValue: 'false'
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.strictEqual(snap.items[0].enabled, false);
            assert.strictEqual(typeof snap.items[0].enabled, 'boolean');
        });

        test('preserves null type for primitive cell drafts', () => {
            const data: any = { items: [{ ref: null }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'ref',
                rawInputValue: 'null'
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.strictEqual(snap.items[0].ref, null);
        });

        test('keeps string type when original is string (matches commitCell)', () => {
            // Regression invariant from coerceEditedCellValue: when the cell
            // was a string, raw input is preserved as-is even if it parses
            // as a number — otherwise "00123" silently becomes 123.
            const data = { items: [{ code: 'abc' }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'code',
                rawInputValue: '00123'
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.strictEqual(snap.items[0].code, '00123');
        });

        test('valid JSON in json-edit textarea is captured for recovery', () => {
            const data = { items: [{ tags: ['a', 'b'] }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'tags',
                rawInputValue: '["x","y","z"]',
                isJsonEdit: true
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.deepStrictEqual(snap.items[0].tags, ['x', 'y', 'z']);
        });

        test('valid JSON object in json-edit textarea is captured', () => {
            const data = { items: [{ meta: { a: 1 } }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'meta',
                rawInputValue: '{"a":2,"b":3}',
                isJsonEdit: true
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.deepStrictEqual(snap.items[0].meta, { a: 2, b: 3 });
        });

        test('invalid JSON in json-edit textarea returns skip', () => {
            // Policy: if raw text is not parseable, do not overwrite the prior
            // valid draft (caller should leave the recovery entry intact).
            const data = { items: [{ tags: ['a'] }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'tags',
                rawInputValue: '[1, 2,',  // unterminated
                isJsonEdit: true
            }));
            assert.strictEqual(result.kind, 'skip');
        });

        test('reverting input back to saved value returns clean (Finding 3)', () => {
            const data = { items: [{ name: 'foo' }] };
            const lastSavedSnapshot = JSON.stringify(data);
            // 사용자가 'foo' → 'bar' 후 다시 'foo' 로 되돌린 마지막 keystroke.
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'name',
                rawInputValue: 'foo',
                lastSavedSnapshot
            }));
            assert.strictEqual(result.kind, 'clean');
        });

        test('non-clean primitive draft still emits snapshot when baseline differs', () => {
            const data = { items: [{ name: 'foo' }] };
            const lastSavedSnapshot = JSON.stringify(data);
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'name',
                rawInputValue: 'bar',
                lastSavedSnapshot
            }));
            assert.strictEqual(result.kind, 'snapshot');
        });

        test('array item draft applies raw string at the given index only', () => {
            const data = { items: [{ tags: ['a', 'b', 'c'] }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'tags',
                rawInputValue: 'B!',
                arrIdx: 1
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.deepStrictEqual(snap.items[0].tags, ['a', 'B!', 'c']);
        });

        test('invalid arrIdx returns skip', () => {
            const data = { items: [{ tags: ['a'] }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'tags',
                rawInputValue: 'X',
                arrIdx: 5
            }));
            assert.strictEqual(result.kind, 'skip');
        });

        test('arrIdx pointing at a non-array column returns skip', () => {
            const data = { items: [{ name: 'foo' }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'name',
                rawInputValue: 'X',
                arrIdx: 0
            }));
            assert.strictEqual(result.kind, 'skip');
        });

        test('out-of-range rowIdx returns skip', () => {
            const data = { items: [{ name: 'foo' }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 7,
                col: 'name',
                rawInputValue: 'X'
            }));
            assert.strictEqual(result.kind, 'skip');
        });

        test('bad sheet path returns skip', () => {
            const data = { items: [{ name: 'foo' }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['nope'],
                rowIdx: 0,
                col: 'name',
                rawInputValue: 'X'
            }));
            assert.strictEqual(result.kind, 'skip');
        });

        test('does not mutate input data on snapshot', () => {
            const data = { items: [{ qty: 2 }] };
            const before = JSON.stringify(data);
            buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'qty',
                rawInputValue: '99'
            }));
            assert.strictEqual(JSON.stringify(data), before);
        });

        test('does not mutate input data on json-edit snapshot', () => {
            const data = { items: [{ tags: ['a'] }] };
            const before = JSON.stringify(data);
            buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: 'tags',
                rawInputValue: '["b","c"]',
                isJsonEdit: true
            }));
            assert.strictEqual(JSON.stringify(data), before);
        });

        test('empty-string column key is a valid JSON key (not skipped)', () => {
            // 회귀 가드: JSON 은 {"": "value"} 처럼 빈 문자열 key 도 허용한다.
            // 이전 코드는 `!col` 로 검사해 빈 문자열을 skip 시켰는데, 그러면
            // 해당 셀을 commit 전 패널을 닫으면 dirty 표시만 켜지고 draft
            // recovery 가 남지 않아 사용자가 미커밋 입력을 잃는다.
            const data = { items: [{ '': 'value' }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: '',
                rawInputValue: 'updated'
            }));
            assert.strictEqual(result.kind, 'snapshot');
            const snap = (result as { kind: 'snapshot'; data: any }).data;
            assert.strictEqual(snap.items[0][''], 'updated');
        });

        test('non-string col returns skip (defensive against missing dataset.col)', () => {
            const data = { items: [{ a: 1 }] };
            const result = buildDraftSnapshot(input({
                data,
                sheetPath: ['items'],
                rowIdx: 0,
                col: undefined as unknown as string,
                rawInputValue: 'x'
            }));
            assert.strictEqual(result.kind, 'skip');
        });
    });

    suite('shouldOfferRecovery', () => {
        const baseEntry: RecoveryEntry = {
            data: { foo: 'bar' },
            isRootArray: false,
            fileMtimeMs: 1_700_000_000_000,
            capturedAt: 1_700_000_000_500
        };

        test('offers recovery when file mtime is unchanged', () => {
            assert.strictEqual(shouldOfferRecovery(baseEntry, 1_700_000_000_000), true);
        });

        test('skips recovery when file was modified externally after the snapshot', () => {
            // 외부에서 파일이 더 새로 쓰여졌으면 스냅샷은 stale이므로 폐기.
            assert.strictEqual(shouldOfferRecovery(baseEntry, 1_700_000_005_000), false);
        });

        test('tolerates 1ms filesystem time rounding', () => {
            // HFS+/FAT 등 1초 미만 해상도가 없는 파일시스템에서 들쭉날쭉한 mtime을
            // 외부 변경으로 오해하지 않도록 한다.
            assert.strictEqual(shouldOfferRecovery(baseEntry, 1_700_000_000_001), true);
        });

        test('still offers recovery when current mtime is earlier (clock skew etc.)', () => {
            // 현재 mtime이 캡처 mtime보다 더 이전인 경우는 캡처 이후 외부 변경이
            // 발생하지 않은 것이므로 제안한다.
            assert.strictEqual(shouldOfferRecovery(baseEntry, 1_699_999_999_000), true);
        });

        test('rejects entries without a numeric fileMtimeMs', () => {
            const broken = { ...baseEntry, fileMtimeMs: undefined as unknown as number };
            assert.strictEqual(shouldOfferRecovery(broken, 1_700_000_000_000), false);
        });

        test('rejects when mtime matches but file size differs (mtime-preserving external change)', () => {
            // 회귀 가드: 외부 도구가 mtime 을 보존하거나 (touch -r, rsync --times)
            // 파일시스템 해상도 때문에 같은 mtime 이지만 내용이 다르면, mtime-only
            // 검사는 stale 스냅샷을 복구 대상으로 잘못 제안한다. size fingerprint
            // 로 한 단계 더 거른다.
            const sized: RecoveryEntry = { ...baseEntry, fileSize: 128 };
            assert.strictEqual(shouldOfferRecovery(sized, 1_700_000_000_000, 256), false);
        });

        test('still offers recovery when mtime and size both match', () => {
            const sized: RecoveryEntry = { ...baseEntry, fileSize: 128 };
            assert.strictEqual(shouldOfferRecovery(sized, 1_700_000_000_000, 128), true);
        });

        test('falls back to mtime-only when entry lacks fileSize (legacy entry)', () => {
            // 옛 세션이 남긴 entry 에는 fileSize 가 없다. 그 경우엔 mtime-only 로
            // 폴백해 호환성을 유지한다.
            assert.strictEqual(shouldOfferRecovery(baseEntry, 1_700_000_000_000, 999), true);
        });

        test('falls back to mtime-only when current size unknown (file vanished etc.)', () => {
            const sized: RecoveryEntry = { ...baseEntry, fileSize: 128 };
            assert.strictEqual(shouldOfferRecovery(sized, 1_700_000_000_000, undefined), true);
        });
    });

    /**
     * The TaskHub JSON Editor webview ships its JS as a string template inside
     * `getWebviewContent()` in src/jsonEditor.ts. The host-side tests above
     * only exercise the mirror copy in src/jsonEditorUtils.ts, so a silent
     * drift between the two would pass CI while breaking the real editor.
     *
     * These smoke tests pin two things:
     *   1. The mirror's documentation keeps listing every webview function
     *      it claims to mirror (someone removing a reference should fail
     *      the test instead of losing it silently).
     *   2. The webview's `parseValue`, when extracted and evaluated in
     *      isolation, produces identical results to the mirror's `parseValue`
     *      across a fixture of tricky inputs.
     */
    suite('webview ↔ jsonEditorUtils mirror synchronization', () => {
        // src/ is the rootDir; compiled tests live in out/test/ so the source
        // tree is reached via ../../src/ from this file at runtime.
        const srcDir = path.resolve(__dirname, '..', '..', 'src');
        const editorSource = readSourceForRegex(path.join(srcDir, 'jsonEditor.ts'));
        const mirrorSource = readSourceForRegex(path.join(srcDir, 'jsonEditorUtils.ts'));

        test('mirror header references every synchronization target by name', () => {
            for (const name of ['buildSheetMap', 'getActiveRows', 'parseValue', 'commitCell', 'sendDraftSnapshot']) {
                assert.ok(
                    mirrorSource.includes(name),
                    `mirror header must mention "${name}" so drift is visible`
                );
            }
        });

        test('webview source still defines parseValue and the string-preservation branch', () => {
            // Catches the case where someone rewrites the webview but forgets
            // to keep the string-type-preservation branch that the mirror
            // tests above rely on.
            assert.ok(
                /function\s+parseValue\s*\(\s*str\s*\)/.test(editorSource),
                'webview template must still define parseValue(str)'
            );
            assert.ok(
                /typeof\s+oldVal\s*===\s*'string'\s*\?\s*input\.value\s*:\s*parseValue\(/.test(editorSource),
                'webview commitCell must still preserve string type via parseValue bypass'
            );
        });

        test('webview commitCell still returns false on invalid JSON to block save', () => {
            // 회귀 가드: invalid JSON 입력 분기는 반드시 `return false`이고
            // 함수 끝은 `return true` 여야 한다. 이 두 가지를 모두 잃으면
            // Save 차단이 동작하지 않아 stale data가 디스크에 기록될 수 있다.
            const commitMatch = editorSource.match(/function commitCell\(td\) \{([\s\S]*?)\n    \}\s*\n/);
            assert.ok(commitMatch, 'could not locate the webview commitCell function body');
            const body = commitMatch![1];
            const returnFalseHits = body.match(/return false;/g) || [];
            assert.ok(
                returnFalseHits.length >= 2,
                'commitCell must return false on every invalid-JSON branch (expected >= 2 occurrences, got ' + returnFalseHits.length + ')'
            );
            assert.ok(
                /return true;\s*\n\s{0,8}\}\s*$/.test(body) || /return true;\s*$/m.test(body),
                'commitCell must end with `return true;` so successful commits do not falsely block save'
            );
        });

        test('webview Save action gates on commitCell return value', () => {
            // saveAction()이 editing td의 commitCell 결과로 분기해야 invalid
            // 셀이 있는 동안 호스트로 save 메시지가 나가지 않는다.
            assert.ok(
                /if\s*\(\s*editingTd\s*&&\s*!commitCell\(\s*editingTd\s*\)\s*\)\s*\{\s*return;\s*\}/.test(editorSource),
                'saveAction must abort early when commitCell(editingTd) returns false'
            );
        });

        test('webview undo/redo guard against in-progress cell edits', () => {
            // 셀 편집 중에는 브라우저 input의 기본 undo가 우선이어야 한다.
            // td.editing 가드가 사라지면 한 글자 지우려다 직전 행 삭제가
            // 되돌려지는 사고가 발생한다.
            assert.ok(
                /function undo\(\)[\s\S]*?td\.editing[\s\S]*?return;/.test(editorSource),
                'undo() must early-return while a cell is being edited'
            );
            assert.ok(
                /function redo\(\)[\s\S]*?td\.editing[\s\S]*?return;/.test(editorSource),
                'redo() must early-return while a cell is being edited'
            );
        });

        test('webview parseValue behaves identically to the mirror parseValue', () => {
            // Extract the webview's parseValue text and re-evaluate it in an
            // isolated Function scope, then compare its output to the mirror
            // across a fixture that covers every branch of the coercion.
            const match = editorSource.match(/function parseValue\(str\) \{([\s\S]*?)\n    \}/);
            assert.ok(match, 'could not locate the webview parseValue function body');
            const webviewParseValue = new Function('str', match![1]) as (s: string) => unknown;

            const fixtures: string[] = [
                '', 'null', 'true', 'false',
                '0', '42', '-3.14', '00123',
                ' ', '   ', 'hello', 'NaN', 'Infinity', '-Infinity',
                '1e10', '0xFF', '  42  '
            ];
            for (const input of fixtures) {
                const fromWebview = webviewParseValue(input);
                const fromMirror = parseValue(input);
                assert.deepStrictEqual(
                    fromWebview,
                    fromMirror,
                    `parseValue drift for input ${JSON.stringify(input)}: ` +
                    `webview=${JSON.stringify(fromWebview)}, mirror=${JSON.stringify(fromMirror)}`
                );
            }
        });

        test('every mutation site pushes to history', () => {
            // 회귀 가드: 새 mutation 경로를 추가하면서 pushHistory 호출을
            // 빠뜨리면 그 편집은 Undo로 되돌릴 수 없게 된다. 현재 webview에서
            // 데이터가 변하는 경로는 정확히 다음과 같다.
            const markers = [
                'data-remove-arr',   // tag 삭제
                'data-add-arr',      // tag 추가
                'data-convert',      // string ↔ array
                'data-delete-row',   // 행 삭제
                'dragSrcIdx',        // drag drop 정렬
                'btnAddRow',         // 새 행 추가
                'commitCell'         // 셀 commit (changed branch)
            ];
            for (const marker of markers) {
                const re = new RegExp(marker + '[\\s\\S]{0,1200}?pushHistory\\(\\)');
                assert.ok(
                    re.test(editorSource),
                    'mutation path "' + marker + '" must call pushHistory() within the same handler'
                );
            }
        });

        test('row-shifting mutations call commitActiveCellOrAbort first', () => {
            // 회귀 가드: blur 100ms timeout이 활성 셀 commit을 지연시키는 동안
            // 다른 행 삭제/드래그/추가/convert 가 일어나면 stale td.dataset.row로
            // 엉뚱한 행에 쓰거나 detach 된 td 의 isConnected 가드로 commit 이
            // skip 되어 사용자 입력이 사라진다. renderTable 을 호출하는 모든
            // 핸들러는 mutation 전에 commitActiveCellOrAbort()를 호출하고
            // false면 return해야 한다.
            const guards = [
                'data-delete-row',  // 행 삭제 클릭
                'data-convert',     // string ↔ array (renderTable 로 다른 셀 detach)
                'dragstart',        // 드래그 시작 (드래그 이전에 commit)
                'btnAddRow'         // 새 행 추가
            ];
            for (const marker of guards) {
                const re = new RegExp(marker + '[\\s\\S]{0,500}?if\\s*\\(\\s*!commitActiveCellOrAbort\\(\\)\\s*\\)');
                assert.ok(
                    re.test(editorSource),
                    'row-shifting handler "' + marker + '" must guard with `if (!commitActiveCellOrAbort()) { return; }` before mutating'
                );
            }
        });

        test('blur commit timeout checks td.isConnected', () => {
            // 회귀 가드: 100ms 지연 commit이 detach된 td를 만나도 commit이
            // 진행되지 않도록. (commitActiveCellOrAbort 가드와 함께 defense
            // in depth 로 동작한다.)
            const isConnectedHits = (editorSource.match(/td\.isConnected\s*&&\s*td\.classList\.contains\('editing'\)/g) || []);
            assert.ok(
                isConnectedHits.length >= 2,
                'blur timeout(s) must check td.isConnected before commitCell to avoid stale-row commits (expected >= 2 occurrences for input + textarea, got ' + isConnectedHits.length + ')'
            );
        });

        test('restoreFromHistoryIndex sends snapshot only when dirty after restore', () => {
            // 회귀 가드: undo로 saved 상태에 도달했을 때 clean snapshot을
            // 보내면 host가 modified=false로 비운 recovery 엔트리에 곧바로
            // clean 데이터를 다시 써, 다음 reopen에서 의미 없는 복구 프롬프트가
            // 뜬다. 분기 안에서만 'snapshot' postMessage가 일어나야 한다.
            const restoreMatch = editorSource.match(/function restoreFromHistoryIndex\(idx\) \{([\s\S]*?)\n    \}/);
            assert.ok(restoreMatch, 'could not locate restoreFromHistoryIndex body');
            const body = restoreMatch![1];
            assert.ok(
                /if\s*\(\s*dirtyNow\s*\)\s*\{[\s\S]*?postMessage\(\s*\{\s*command:\s*'snapshot'/.test(body),
                'restoreFromHistoryIndex must gate `command: \'snapshot\'` on dirtyNow'
            );
            // Sanity check: 분기 밖에 또 다른 postMessage('snapshot')이 없어야 한다.
            const all = body.match(/postMessage\(\s*\{\s*command:\s*'snapshot'/g) || [];
            assert.strictEqual(
                all.length, 1,
                'restoreFromHistoryIndex should send the snapshot exactly once (within the dirty branch)'
            );
        });

        test('cancelCell reconciles draft snapshot/dirty state on Escape', () => {
            // 회귀 가드: cancelCell 이 단순히 td.editing 클래스만 제거하면, 입력 중
            // 매 keystroke 마다 sendDraftSnapshot 이 host 에 누적시킨 draft snapshot
            // 과 modified=true 가 그대로 남아 — (1) reopen 시 cancel 한 입력이
            // "복구하시겠습니까?" 로 되살아나거나, (2) data 는 saved 와 같은데
            // modified 표시만 남는 false positive 가 생긴다. pushHistory /
            // restoreFromHistoryIndex 와 동일한 정책(snap vs lastSavedSnapshot
            // 비교 → setModified(dirtyNow), dirty 일 때만 snapshot 송신) 으로
            // host 상태를 동기화해야 한다.
            const cancelMatch = editorSource.match(/function cancelCell\(td\) \{([\s\S]*?)\n    \}/);
            assert.ok(cancelMatch, 'could not locate cancelCell body');
            const body = cancelMatch![1];
            assert.ok(
                /const\s+dirtyNow\s*=\s*snap\s*!==\s*lastSavedSnapshot/.test(body),
                'cancelCell must compute dirtyNow from snapshotData() vs lastSavedSnapshot to mirror pushHistory'
            );
            assert.ok(
                /setModified\(\s*dirtyNow\s*\)/.test(body),
                'cancelCell must call setModified(dirtyNow) so cancelled drafts that reverted to clean turn off the dirty flag (host clears recovery)'
            );
            assert.ok(
                /if\s*\(\s*dirtyNow\s*\)\s*\{[\s\S]*?postMessage\(\s*\{\s*command:\s*'snapshot'/.test(body),
                'cancelCell must overwrite host recovery with current data when other committed changes remain (gated on dirtyNow)'
            );
            // Sanity: snapshot 송신은 정확히 한 번, dirtyNow 분기 안에서만.
            const all = body.match(/postMessage\(\s*\{\s*command:\s*'snapshot'/g) || [];
            assert.strictEqual(
                all.length, 1,
                'cancelCell should send the snapshot exactly once (within the dirty branch) — outside the branch would re-create a stale recovery entry that the setModified(false) call had cleared'
            );
        });

        test('file watcher uses directory-wide pattern + fsPath gate (avoids brace-escape pitfall)', () => {
            // 회귀 가드: basename 을 RelativePattern 의 glob 으로 직접 넘기면
            // 파일명에 `{` `}` 가 있을 때 어떤 escape 도 minimatch 의 brace
            // 확장과 안전히 호환되지 않는다 (예: `a{b,c}.json` 의 brace 를
            // character class 로 escape 한 `a[{]b,c[}].json` 도 매치 실패).
            // 따라서 `*` 로 디렉터리 전체를 보고 콜백의 fsPath 비교로 target
            // 만 골라내는 패턴을 보존해야 한다.
            assert.ok(
                /new\s+vscode\.RelativePattern\(\s*vscode\.Uri\.file\(\s*path\.dirname\(\s*filePath\s*\)\s*\)\s*,\s*'\*'\s*\)/.test(editorSource),
                'createFileSystemWatcher must use a directory-wide `*` glob (the per-basename escape approach is fragile against brace expansion)'
            );
            // basename + escape 패턴이 부활하지 않았는지 — escape regex 가 다시
            // 등장하면 brace 파일명에서 매치 실패가 되살아난다.
            assert.ok(
                !/\.replace\(\s*\/\[\*\?\[\{\}\]\/g/.test(editorSource),
                'basename glob escape must not return — minimatch brace expansion makes it unsafe (use directory-wide pattern instead)'
            );
            assert.ok(
                /path\.normalize\(\s*changedUri\.fsPath\s*\)\s*!==\s*[a-zA-Z]+/.test(editorSource),
                'external-change handler must compare path.normalize(changedUri.fsPath) against the target path so the directory-wide pattern only triggers for the actual file'
            );
        });

        test('external-change Keep branch must NOT overwrite host isRootArray', () => {
            // 회귀 가드: Keep 은 사용자의 *편집본* 을 보존하기로 한 결정 — 디스크가
            // shape 가 다르더라도(array → object 등) host 의 isRootArray 는 user
            // data 의 root shape 를 가리키므로 그대로 둬야 한다. 디스크 shape 으로
            // 덮어쓰면 다음 save 에서 unwrapIfRootArray 가 잘못 동작해, array 형태
            // 의 user data 가 디스크에 `{"_rootArray":[...]}` object 로 기록된다.
            const keepBranch = editorSource.match(/if\s*\(\s*choice\s*!==\s*reloadLabel\s*\)\s*\{([\s\S]*?)\n\s{12}\}/);
            assert.ok(keepBranch, 'could not locate Keep branch body');
            const body = keepBranch![1];
            assert.ok(
                !/isRootArray\s*=\s*newWrapped\.isRootArray/.test(body),
                'Keep branch must NOT assign newWrapped.isRootArray to host isRootArray — that overwrites the user-edit shape with disk shape and corrupts subsequent saves'
            );
            // wrapIfArray 호출은 webview 에 보낼 wrapped data 를 만들기 위해
            // 여전히 필요하지만, 그 결과의 isRootArray 는 host 에 반영하면 안 된다.
            assert.ok(
                /wrapIfArray\(\s*newDiskParsed\s*\)/.test(body),
                'Keep branch must still call wrapIfArray() on the new disk content to derive the wrapped form passed to the webview'
            );
        });

        test('open path unifies all disk-step failures (stat/size/read/parse) through a single recovery fallback', () => {
            // 회귀 가드: 12차에서 stat 실패 / 파일 크기 초과 / 파일 읽기 실패 /
            // JSON parse 실패 4 가지 early-return 을 단일 fallback 분기로 통합.
            // 이로써 dirty close 후 외부 사고 (파일 삭제 / 사이즈 폭증 / invalid
            // JSON 등) 가 발생해도 reopen 시 사용자의 미저장 변경이 영원히
            // 잠기지 않고 매칭 recovery 가 제안된다.
            const openPath = editorSource.match(/async function openJsonEditorWithPath\([\s\S]*?\n\}\s*\n/);
            assert.ok(openPath, 'could not locate openJsonEditorWithPath');
            const body = openPath![0];

            // 4 가지 disk-step 실패 모두 earlyError 객체 (msg + mtimeForRecovery) 로
            // 캡쳐되어야 한다 — 각 단계가 별도로 early-return 으로 빠지면 fallback
            // 통합이 깨진다.
            const earlyErrorAssignments = body.match(/earlyError\s*=\s*\{/g) || [];
            assert.ok(
                earlyErrorAssignments.length >= 4,
                `4 disk-step failures (stat / size / read / parse) must each capture into earlyError, found only ${earlyErrorAssignments.length}`
            );

            // earlyError 가 set 됐을 때 getRecoveryEntry + offerRecoveryIfAny 를
            // 통과한 뒤 — 만약 fallback 이 없으면 그때만 error 메시지 + return.
            assert.ok(
                /if\s*\(\s*earlyError\s*\)\s*\{[\s\S]*?getRecoveryEntry\(\s*context\s*,\s*filePath\s*\)[\s\S]*?offerRecoveryIfAny\(/.test(body),
                'earlyError branch must call getRecoveryEntry + offerRecoveryIfAny before showing the error'
            );
            assert.ok(
                /if\s*\(\s*!fallback\s*\)\s*\{\s*\n[\s\S]*?showErrorMessage\(\s*earlyError\.msg\s*\)[\s\S]*?return;\s*\n/.test(body),
                'earlyError branch must show the captured error and return only when no fallback recovery exists'
            );

            // disk-fail fallback 분기는 baselineUnknownForWebview 플래그를 켜
            // webview 가 빈 문자열 sentinel 로 lastSavedSnapshot 을 잡게 한다 →
            // dirty=true 로 시작. (이전 12차 코드는 `savedDataForWebview = {}`
            // 객체 sentinel 을 썼지만 사용자가 실제로 빈 객체를 편집 중일 때
            // 충돌 — 13차에서 baselineUnknown 신호로 교체.)
            assert.ok(
                /baselineUnknownForWebview\s*=\s*true/.test(body),
                'disk-fail fallback must set baselineUnknownForWebview=true (the empty-string sentinel cannot be produced by JSON.stringify of any user data, unlike the old {} object sentinel)'
            );

            // 4 개의 개별 early-return 이 부활하지 않도록 negative guard. 기존
            // showErrorMessage + return 패턴이 4 곳에서 분기되면 통합이 깨진 것.
            // args 안에 `;` 가 없는 단일 문장 호출만 매치되도록 [^;] 로 제한 —
            // 그렇지 않으면 lazy [\s\S]*? 가 멀리 떨어진 다른 함수의 return; 까지
            // 잡아 false positive 가 발생한다.
            const stragglingErrorReturns = body.match(/showErrorMessage\([^;]*?\)\s*;\s*\n\s*return;/g) || [];
            assert.ok(
                stragglingErrorReturns.length <= 1,
                `disk-step failures must funnel through the single earlyError branch — found ${stragglingErrorReturns.length} straggling 'showErrorMessage(...); return;' patterns (expected ≤ 1 for the unified earlyError handler)`
            );
        });

        test('Keep branch parse-fail signals markBaselineUnknown (no `{}` sentinel collision)', () => {
            // 회귀 가드: external-change *Keep* 분기에서 새 디스크 baseline 의
            // read/parse 가 실패하면 webview 의 lastSavedSnapshot 이 *옛* baseline
            // 으로 남아, 사용자가 undo / 수동 revert 로 그 옛 데이터에 도달할 때
            // dirty 가 false 로 풀려 host 가 recovery 를 비우고 — 다음 save 가
            // invalid 디스크를 silent 하게 덮어쓴다. webview 에 명시적
            // markBaselineUnknown 을 보내 sentinel (빈 문자열 — JSON.stringify
            // 결과와 절대 같지 않음) 로 baseline 을 잡게 한다. (이전 버전은
            // `data: {}` 객체 sentinel 을 썼지만 사용자가 실제 빈 객체를 편집
            // 중일 때 충돌했음 — 그 패턴은 다시 들어오면 안 된다.)
            const keepBranch = editorSource.match(/if\s*\(\s*choice\s*!==\s*reloadLabel\s*\)\s*\{([\s\S]*?)\n\s{12}\}/);
            assert.ok(keepBranch, 'could not locate Keep branch body');
            const body = keepBranch![1];
            assert.ok(
                /\}\s*catch\s*\([^)]*\)\s*\{[\s\S]*?postMessage\(\s*\{\s*command:\s*'markBaselineUnknown'\s*\}/.test(body),
                'Keep branch catch (disk read/parse fail) must postMessage `markBaselineUnknown` (not data:{}) so webview uses the empty-string sentinel and cannot collide with real `{}` user data'
            );
            // 옛 `data: {}` 패턴이 부활하지 않았는지 negative guard.
            assert.ok(
                !/postMessage\(\s*\{\s*\n?\s*command:\s*'setSavedBaseline'\s*,\s*\n?\s*data:\s*\{\s*\}\s*\n?\s*\}/.test(body),
                'Keep branch must not send `setSavedBaseline` with empty-object data — that sentinel collides with users editing `{}`. Use markBaselineUnknown instead.'
            );
        });

        test('webview encodes BASELINE_UNKNOWN_SENTINEL as the empty string', () => {
            // 회귀 가드: sentinel 은 JSON.stringify 결과와 *절대* 같을 수 없는 값
            // 이어야 한다. 빈 문자열 ('') 은 JSON.stringify 가 어떤 valid 객체에
            // 대해서도 만들지 못하는 형태이므로 안전한 sentinel. 만일 sentinel 이
            // 우연히 valid JSON 으로 바뀌면 (예: '{}' 또는 'null') 사용자 데이터와
            // 충돌해 dirty=false 가 풀린다.
            assert.ok(
                /const\s+BASELINE_UNKNOWN_SENTINEL\s*=\s*''/.test(editorSource),
                'webview BASELINE_UNKNOWN_SENTINEL must be the empty string — any other value risks colliding with JSON.stringify output of real user data'
            );
            // markBaselineUnknown 핸들러가 sentinel 을 사용하는지.
            const handlerMatch = editorSource.match(/msg\.command\s*===\s*'markBaselineUnknown'\s*\)\s*\{([\s\S]*?)\n\s{8}\}/);
            assert.ok(handlerMatch, 'webview must handle markBaselineUnknown message');
            const body = handlerMatch![1];
            assert.ok(
                /lastSavedSnapshot\s*=\s*BASELINE_UNKNOWN_SENTINEL/.test(body),
                'markBaselineUnknown handler must set lastSavedSnapshot to the sentinel constant'
            );
            assert.ok(
                /setModified\(\s*true\s*\)/.test(body),
                'markBaselineUnknown handler must mark dirty=true so subsequent setModified(false) transitions actually fire and host snapshot writes are not lost'
            );
        });

        test('disk-fail fallback uses baselineUnknown flag, not `{}` data sentinel', () => {
            // 회귀 가드: open 의 disk-fail fallback (stat / size / read / parse 실패
            // 후 recovery 사용) 은 `savedDataForWebview = {}` 대신 `baselineUnknownForWebview = true`
            // 플래그를 켜야 한다. webview 는 이를 받아 lastSavedSnapshot 을 빈
            // 문자열 sentinel 로 잡아 사용자 데이터와 충돌하지 않게 dirty 유지.
            const openPath = editorSource.match(/async function openJsonEditorWithPath\([\s\S]*?\n\}\s*\n/);
            assert.ok(openPath, 'could not locate openJsonEditorWithPath');
            const body = openPath![0];
            assert.ok(
                /baselineUnknownForWebview\s*=\s*true/.test(body),
                'disk-fail fallback must set baselineUnknownForWebview=true (replaces the brittle `savedDataForWebview = {}` sentinel)'
            );
            // 옛 `savedDataForWebview = {}` 패턴이 부활하지 않았는지.
            assert.ok(
                !/savedDataForWebview\s*=\s*\{\s*\}/.test(body),
                'open path must not assign empty-object to savedDataForWebview — that sentinel collides with users editing `{}`. Use baselineUnknownForWebview flag instead.'
            );
            // getWebviewContent 호출에 새 인수 전달 확인.
            assert.ok(
                /getWebviewContent\([\s\S]*?baselineUnknownForWebview\s*\)/.test(body),
                'getWebviewContent call must pass baselineUnknownForWebview as the new parameter'
            );
        });

        test('case `reload` and watcher auto-reload both apply size guard', () => {
            // 회귀 가드: open 경로의 10MB 한도가 reload 경로에도 적용되어야 한다.
            // 외부에서 파일이 거대 JSON 으로 바뀐 경우 readFileSync 가 메모리를
            // 크게 잡아먹으므로 stat 의 size 를 먼저 확인해야 한다.
            const reloadCase = editorSource.match(/case 'reload':[\s\S]*?\n\s{16}\}/);
            assert.ok(reloadCase, 'could not locate case reload body');
            assert.ok(
                /JSON_EDITOR_MAX_FILE_SIZE/.test(reloadCase![0]) &&
                /size\s*>\s*JSON_EDITOR_MAX_FILE_SIZE/.test(reloadCase![0]),
                'case `reload` must check sizeStat.size against JSON_EDITOR_MAX_FILE_SIZE before readFileSync'
            );
            // watcher auto-reload 에도 동일하게 size guard 적용.
            const watcher = editorSource.match(/handleExternalChange\s*=\s*async[\s\S]*?\n\s{4}\};/);
            assert.ok(watcher, 'could not locate watcher handleExternalChange');
            assert.ok(
                /changedStat\.size\s*>\s*JSON_EDITOR_MAX_FILE_SIZE/.test(watcher![0]),
                'watcher auto-reload must check changedStat.size against JSON_EDITOR_MAX_FILE_SIZE before readFileSync'
            );
        });

        test('watcher auto-reload catch updates mtime and marks baselineUnknown on parse fail', () => {
            // 회귀 가드: clean editor 에서 외부 파일이 invalid JSON 으로 바뀐
            // 경우, auto-reload 의 catch 가 단순히 경고만 띄우고 baselineMtimeMs
            // 를 그대로 두면 (1) 이후 user 편집의 recovery 가 옛 mtime 으로
            // stamp 되어 reopen 시 stale 로 폐기되고 (2) webview 의
            // lastSavedSnapshot 은 옛 valid disk 데이터라 user 가 그것에 도달하면
            // dirty=false 로 풀린다. mtime 을 갱신하고 markBaselineUnknown 으로
            // dirty 전환해야 한다.
            const watcher = editorSource.match(/handleExternalChange\s*=\s*async[\s\S]*?\n\s{4}\};/);
            assert.ok(watcher, 'could not locate watcher handleExternalChange');
            // catch 블록에서 baselineMtimeMs 갱신 + markBaselineUnknown postMessage.
            assert.ok(
                /catch\s*\([^)]*\)\s*\{[\s\S]*?baselineMtimeMs\s*=\s*changedStat\.mtimeMs[\s\S]*?postMessage\(\s*\{\s*command:\s*'markBaselineUnknown'\s*\}/.test(watcher![0]),
                'auto-reload catch must update baselineMtimeMs and post markBaselineUnknown so the user\'s next edit lands in a recovery entry stamped with the new mtime'
            );
        });

        test("external-change Keep branch refreshes webview's lastSavedSnapshot", () => {
            // 회귀 가드: Keep 후 host 가 baselineMtimeMs 만 갱신하고 webview 의
            // saved baseline 을 그대로 두면, 사용자가 undo / 수동 revert 로 옛
            // 디스크 데이터로 돌아갈 때 dirty=false 가 되어 host 가 recovery 를
            // 비우고 — 다음 save 가 디스크의 외부 변경을 silent 하게 덮어쓴다.
            // Keep 분기에서 디스크를 다시 읽어 webview 에 setSavedBaseline 을
            // 보내야 한다.
            const reloadLabelMatch = editorSource.match(/const\s+reloadLabel\s*=\s*t\(/);
            assert.ok(reloadLabelMatch, 'could not locate Keep/Reload modal in watcher');
            // Keep 분기 (choice !== reloadLabel) 안에 fs.readFileSync(filePath)
            // 와 setSavedBaseline postMessage 가 모두 있어야 한다.
            const keepBranch = editorSource.match(/if\s*\(\s*choice\s*!==\s*reloadLabel\s*\)\s*\{([\s\S]*?)\n\s{12}\}/);
            assert.ok(keepBranch, 'could not locate Keep branch body');
            const body = keepBranch![1];
            assert.ok(
                /fs\.readFileSync\(\s*filePath\s*,\s*'utf-8'\s*\)/.test(body),
                'Keep branch must read disk content again to refresh the saved baseline'
            );
            assert.ok(
                /postMessage\(\s*\{\s*\n?\s*command:\s*'setSavedBaseline'/.test(body),
                'Keep branch must postMessage setSavedBaseline so webview updates lastSavedSnapshot to the new disk content'
            );
        });

        test('webview handles setSavedBaseline by updating lastSavedSnapshot and re-evaluating dirty', () => {
            // 회귀 가드: 위의 host-side 메시지를 webview 가 정확히 처리해야 함.
            // lastSavedSnapshot 갱신 + dirty 재계산 + dirty 분기 안에서만 snapshot
            // 송신 (pushHistory / cancelCell 와 동일 정책 — 분기 밖 송신은
            // setModified(false) 가 비운 recovery 를 곧바로 다시 채워 의도가 깨진다).
            const handlerMatch = editorSource.match(/msg\.command\s*===\s*'setSavedBaseline'\s*\)\s*\{([\s\S]*?)\n\s{8}\}/);
            assert.ok(handlerMatch, 'webview must handle setSavedBaseline message');
            const body = handlerMatch![1];
            assert.ok(
                /lastSavedSnapshot\s*=\s*JSON\.stringify\(\s*msg\.data\s*\)/.test(body),
                'setSavedBaseline handler must set lastSavedSnapshot from the new disk data'
            );
            assert.ok(
                /const\s+dirtyNow\s*=\s*snapshotData\(\)\s*!==\s*lastSavedSnapshot/.test(body),
                'setSavedBaseline handler must recompute dirtyNow against the new baseline'
            );
            assert.ok(
                /setModified\(\s*dirtyNow\s*\)/.test(body),
                'setSavedBaseline handler must call setModified(dirtyNow) (mirrors pushHistory policy)'
            );
            assert.ok(
                /if\s*\(\s*dirtyNow\s*\)\s*\{[\s\S]*?postMessage\(\s*\{\s*command:\s*'snapshot'/.test(body),
                'setSavedBaseline handler must send snapshot only inside the dirty branch'
            );
        });

        test('file watcher routes onDidCreate to the same handler as onDidChange', () => {
            // 회귀 가드: atomic replace (rename(temp, target)) 또는 외부 도구의
            // delete + create 시퀀스에서는 change 이벤트가 안 오고 create 만 온다.
            // ignoreCreateEvents=true 거나 onDidCreate 핸들러가 없으면 stale data
            // 를 들고 있다가 사용자가 저장하면서 외부 변경을 덮는 사고가 발생한다.
            assert.ok(
                /createFileSystemWatcher\([\s\S]{0,200}?false,\s*\/\/\s*ignoreCreateEvents/.test(editorSource),
                'createFileSystemWatcher must pass false for ignoreCreateEvents so atomic replace recreations are observed'
            );
            // 동일 핸들러가 두 이벤트에 모두 라우팅되는지 — 둘 다 같은 함수 참조
            // 를 받아야 분기 누락이 없다.
            assert.ok(
                /onDidChange\(\s*handleExternalChange\s*\)/.test(editorSource),
                'watcher must wire onDidChange to handleExternalChange'
            );
            assert.ok(
                /onDidCreate\(\s*handleExternalChange\s*\)/.test(editorSource),
                'watcher must also wire onDidCreate to handleExternalChange — atomic replace surfaces only as create'
            );
        });

        test('file watcher onDidDelete uses grace-period existence check', () => {
            // 회귀 가드: atomic replace 는 delete 직후 create 가 따라온다.
            // onDidDelete 가 즉시 경고를 띄우면 사용자가 같은 파일에 대해 두
            // 번의 모달 (delete 경고 + create 의 reload prompt) 을 보게 된다.
            // 짧은 grace period 후 fs.statSync 로 파일이 정말 사라졌는지 확인
            // 하고 그때만 경고하는 패턴이 보존되어야 한다.
            const deleteMatch = editorSource.match(/onDidDelete\(\(\) => \{([\s\S]*?)\}\);/);
            assert.ok(deleteMatch, 'could not locate watcher onDidDelete handler');
            const body = deleteMatch![1];
            assert.ok(
                /setTimeout\([\s\S]*?fs\.statSync\(\s*filePath\s*\)/.test(body),
                'onDidDelete must schedule a delayed fs.statSync(filePath) check so atomic replace (delete + create) does not raise a misleading warning'
            );
        });

        test('webview buildDraftSnapshot accepts empty-string col (typeof check, not falsy)', () => {
            // 회귀 가드: `!col` 검사는 빈 문자열 column 을 부당하게 skip 시킨다.
            // JSON 은 {"": "value"} 처럼 빈 문자열 key 를 허용하므로 typeof
            // 검사로 바꿔야 해당 셀의 미커밋 draft 도 recovery 에 남는다.
            const fn = editorSource.match(/function buildDraftSnapshot\(args\) \{([\s\S]*?)\n    \}/);
            assert.ok(fn, 'webview must define buildDraftSnapshot(args)');
            const body = fn![1];
            assert.ok(
                /typeof\s+col\s*!==\s*'string'/.test(body),
                "webview buildDraftSnapshot must guard col with `typeof col !== 'string'` (typeof check, not falsy) so empty-string keys are not rejected"
            );
            assert.ok(
                !/\|\|\s*!col\b/.test(body),
                'webview buildDraftSnapshot must not use the `!col` falsy check (regression — empty-string keys would be skipped)'
            );
        });

        test('every host recovery-clearing site also clears currentLastReceivedSnapshot', () => {
            // 회귀 가드: setRecoveryEntry(...null) 로 workspaceState 의 recovery
            // 엔트리를 비우는 host 경로는 currentLastReceivedSnapshot 캐시도
            // 함께 비워야 한다. 그렇지 않으면 cache 에 남은 stale snapshot 이
            // 외부 변경 *Keep current edits* 분기에서 새 mtime 으로 recovery 에
            // 다시 써져, cancelled / saved / reloaded 후 사용자가 mid-edit
            // invalid (json-edit) 상태로 dirty 만 다시 켠 경로에서 의도와
            // 정반대로 stale draft 가 reopen 시 부활한다.
            //
            // (offerRecoveryIfAny 의 두 setRecoveryEntry(null) 사이트는 panel
            // 셋업 전이라 currentLastReceivedSnapshot 이 이미 undefined 이므로
            // 검증 대상에서 제외 — discardPriorRecoveryIfAny / onDidDispose 가
            // 그 이전에 클리어한다.)
            type Site = { name: string; window: string | undefined };
            const sites: Site[] = [
                {
                    name: "case 'modified' (modified=false branch)",
                    window: editorSource.match(/case 'modified':[\s\S]{0,800}?break;/)?.[0],
                },
                {
                    name: "case 'save' success branch",
                    window: editorSource.match(/case 'save':[\s\S]{0,1500}?break;/)?.[0],
                },
                {
                    // case 'reload' 의 첫 break; 는 confirmDiscardIfDirty 거부 시
                    // early-return 이라 성공 분기까지 안 닿는다. reloadedStat
                    // 변수는 성공 try-block 에서만 선언되므로 그 anchor 사용.
                    name: "case 'reload' success branch",
                    window: editorSource.match(/reloadedStat\s*=\s*fs\.statSync[\s\S]{0,1500}?postMessage\(\s*\{\s*command:\s*'loadData'/)?.[0],
                },
                {
                    name: 'auto-reload watcher branch',
                    window: editorSource.match(/baselineMtimeMs\s*=\s*changedStat\.mtimeMs[\s\S]{0,1000}?postMessage\(\s*\{\s*command:\s*'loadData'/)?.[0],
                },
            ];
            for (const site of sites) {
                assert.ok(site.window, `could not locate ${site.name}`);
                assert.ok(
                    /setRecoveryEntry\(\s*context\s*,\s*filePath\s*,\s*null\s*\)/.test(site.window!),
                    `${site.name} should clear the recovery entry (sanity check — if this fails, the regex anchor needs updating)`
                );
                assert.ok(
                    /currentLastReceivedSnapshot\s*=\s*undefined/.test(site.window!),
                    `${site.name} clears the recovery entry but NOT currentLastReceivedSnapshot — ` +
                    `the leftover cache lets the watcher Keep-current-edits branch resurrect a stale ` +
                    `draft on the next external change. Add 'currentLastReceivedSnapshot = undefined;' ` +
                    `next to the existing setRecoveryEntry(...null) call.`
                );
            }
        });

        test('resetHistoryToCurrent uses savedSnapshot baseline when present', () => {
            // 회귀 가드: 복구 데이터로 boot한 webview는 디스크 데이터를 saved
            // baseline으로 잡아야 modified 표시가 켜지고 undo 비교가 정확하다.
            const resetMatch = editorSource.match(/function resetHistoryToCurrent\(\) \{([\s\S]*?)\n    \}/);
            assert.ok(resetMatch, 'could not locate resetHistoryToCurrent body');
            const body = resetMatch![1];
            assert.ok(
                /lastSavedSnapshot\s*=\s*savedSnapshot\s*!==\s*undefined\s*\?\s*savedSnapshot/.test(body),
                'resetHistoryToCurrent must seed lastSavedSnapshot from savedSnapshot when defined'
            );
            assert.ok(
                /setModified\s*\(\s*dirtyNow\s*\)/.test(body),
                'resetHistoryToCurrent must call setModified with the dirtyNow comparison'
            );
        });
    });

    /**
     * makeRecoveryStore는 jsonEditor.ts host가 사용하는 실제 직렬화 store와
     * 같은 코드를 단위테스트가 in-memory state로 직접 검증할 수 있게 한다.
     * 통합 시나리오(debounce, dispose flush, external Keep, blur timeout 등)는
     * source regex 회귀 가드로 보완한다.
     */
    suite('makeRecoveryStore', () => {
        function makeMemState(): { state: MinimalWorkspaceState; updates: Array<{ key: string; valueJson: string }>; gateUpdate?: (resolve: () => void) => void } {
            const map = new Map<string, unknown>();
            const updates: Array<{ key: string; valueJson: string }> = [];
            const captured: { gateUpdate?: (resolve: () => void) => void } = {};
            const state: MinimalWorkspaceState = {
                get<T>(key: string, def: T): T {
                    return (map.has(key) ? map.get(key) : def) as T;
                },
                update(key: string, value: unknown): PromiseLike<void> {
                    return new Promise<void>((resolve) => {
                        const apply = () => {
                            if (value === undefined) {
                                map.delete(key);
                            } else {
                                map.set(key, JSON.parse(JSON.stringify(value)));
                            }
                            updates.push({ key, valueJson: JSON.stringify(value ?? null) });
                            resolve();
                        };
                        if (captured.gateUpdate) {
                            captured.gateUpdate(apply);
                        } else {
                            apply();
                        }
                    });
                }
            };
            return { state, updates, get gateUpdate() { return captured.gateUpdate; }, set gateUpdate(g) { captured.gateUpdate = g; } } as any;
        }

        const KEY = 'taskhub.jsonEditor.recovery';

        test('round-trip: set entry, get it back, clear it', async () => {
            const env = makeMemState();
            const store = makeRecoveryStore(env.state, KEY);
            const entry: RecoveryEntry = {
                data: { items: [{ id: 'a' }] },
                isRootArray: false,
                fileMtimeMs: 1_700_000_000_000,
                capturedAt: 1_700_000_000_500
            };
            await store.set('/abs/foo.json', entry);
            assert.deepStrictEqual(store.get('/abs/foo.json'), entry);

            await store.set('/abs/foo.json', null);
            assert.strictEqual(store.get('/abs/foo.json'), undefined);
        });

        test('multiple files coexist in the recovery map', async () => {
            const env = makeMemState();
            const store = makeRecoveryStore(env.state, KEY);
            const a: RecoveryEntry = { data: { kind: 'a' }, isRootArray: false, fileMtimeMs: 1, capturedAt: 1 };
            const b: RecoveryEntry = { data: { kind: 'b' }, isRootArray: true, fileMtimeMs: 2, capturedAt: 2 };
            await store.set('/abs/a.json', a);
            await store.set('/abs/b.json', b);
            assert.deepStrictEqual(store.get('/abs/a.json'), a);
            assert.deepStrictEqual(store.get('/abs/b.json'), b);
        });

        test('serializes interleaved updates to avoid lost-clear race (save vs in-flight snapshot)', async () => {
            // 회귀 가드: 디바운스 timer가 fire된 직후 save가 들어와도 마지막
            // 호출(save's clear)이 최종 상태가 되어야 한다. 첫 update의
            // workspaceState.update가 await로 미해결 상태일 때 두 번째 호출이
            // 이루어지면, 직렬화 없이는 둘 다 같은 baseline map을 읽고
            // last-write-wins 가 되어 의도와 반대 결과(clear가 entry 부활에
            // 덮인다)가 나올 수 있다.
            const env: any = makeMemState();
            const store = makeRecoveryStore(env.state, KEY);
            const filePath = '/abs/foo.json';
            const snapshotEntry: RecoveryEntry = { data: { v: 'in-flight' }, isRootArray: false, fileMtimeMs: 100, capturedAt: 1 };

            // 첫 update를 인위적으로 지연시켜, 그 사이에 두 번째 호출(set null)이
            // 이루어지도록 한다. 직렬화가 없다면 두 호출이 같은 빈 map 을 읽고
            // 둘 다 update를 보내 race가 발생.
            const pendingResolvers: Array<() => void> = [];
            env.gateUpdate = (apply: () => void) => { pendingResolvers.push(apply); };

            // store.set 두 번 호출은 모두 chain.then(...) 으로 microtask 큐에 들어
            // 가므로, 동기 라인에서는 아직 state.update 가 호출되지 않은 상태이다.
            const setSnapshot = store.set(filePath, snapshotEntry);
            const setClear = store.set(filePath, null);

            // microtask 한 turn — 첫 chain handler 가 실행되어 state.update 가
            // 호출되며 apply 가 pendingResolvers 로 들어가야 한다. 두 번째 update
            // 는 아직 chain 에서 대기.
            await Promise.resolve();
            assert.strictEqual(pendingResolvers.length, 1, 'first update should be gated by now');
            assert.strictEqual(env.updates.length, 0, 'no update should have been applied yet');

            // 첫 번째 gate release → setSnapshot 이 resolve.
            pendingResolvers[0]();
            await setSnapshot;
            assert.strictEqual(env.updates.length, 1, 'first set should land first');

            // 두 번째 update 가 chain 에서 풀려나 state.update 를 호출하기까지
            // 한 microtask turn 더 필요. 직렬화가 없다면 setClear 의 read 가
            // 첫 update 와 같은 baseline map(빈 map)을 봐 race 가 발생했을 것.
            await Promise.resolve();
            assert.strictEqual(pendingResolvers.length, 2, 'second update should now be pending');

            pendingResolvers[1]();
            await setClear;
            assert.strictEqual(env.updates.length, 2, 'second set should land after the first');
            assert.strictEqual(store.get(filePath), undefined, 'final state must be the LAST queued operation (clear)');
        });

        test('chain survives an individual update rejection so subsequent calls still proceed', async () => {
            // 한 update가 실패해도 chain은 catch로 swallow해 다음 update는
            // 진행되어야 한다. 호출자에게는 원래 promise가 그대로 reject 된다.
            const map = new Map<string, unknown>();
            let failNext = true;
            const state: MinimalWorkspaceState = {
                get<T>(key: string, def: T): T {
                    return (map.has(key) ? map.get(key) : def) as T;
                },
                update(key: string, value: unknown): PromiseLike<void> {
                    if (failNext) {
                        failNext = false;
                        return Promise.reject(new Error('boom'));
                    }
                    map.set(key, value);
                    return Promise.resolve();
                }
            };
            const store = makeRecoveryStore(state, KEY);
            const entry: RecoveryEntry = { data: { ok: 1 }, isRootArray: false, fileMtimeMs: 1, capturedAt: 1 };

            await assert.rejects(() => store.set('/a.json', entry), /boom/);
            // 다음 호출은 chain swallow 덕에 정상 진행.
            await store.set('/b.json', entry);
            assert.deepStrictEqual(store.get('/b.json'), entry);
        });

        test('get reads synchronous shadow immediately after set, before persist resolves', async () => {
            // 회귀 가드: P2 (round 3). dispose 핸들러가 비동기 flush 를
            // fire-and-forget 으로 트리거한 직후 사용자가 같은 파일을 즉시
            // reopen 하면, naive 한 state.get() 은 아직 persist 되지 않은
            // in-flight write 를 보지 못해 recovery prompt 를 놓친다.
            // 이 store 는 set 호출 시점에 shadow 가 동기 갱신되어 그 race 를 닫는다.
            //
            // 시나리오: state.update 를 인위적으로 보류시킨 채 set 을 호출하고,
            // update 가 resolve 되기 *전에* get 이 새 값을 반환해야 한다.
            const store = makeRecoveryStore({
                get<T>(_k: string, def: T): T { return def; },
                update(_k: string, _v: unknown): PromiseLike<void> {
                    // 영원히 resolve 하지 않는 약속: persist 가 아직 끝나지 않은 상태.
                    return new Promise<void>(() => undefined);
                }
            }, KEY);
            const entry: RecoveryEntry = { data: { v: 1 }, isRootArray: false, fileMtimeMs: 1, capturedAt: 1 };
            const fp = '/abs/dirty.json';

            // set 의 promise 는 await 하지 않는다 — persist 는 미해결 상태로 둔다.
            void store.set(fp, entry);

            // 핵심 단언: persist 가 끝나기 전에도 shadow 는 새 entry 를 반환해야 한다.
            assert.deepStrictEqual(store.get(fp), entry, 'shadow must surface in-flight set immediately');
        });

        test('set passes a cloned map to update so update mutation does not leak into the shadow', async () => {
            // 회귀 가드: P2 (round 3). update 호출자가 받은 map 을 보관/mutate
            // 해도 store 의 shadow 는 영향을 받지 않아야 한다. Memento 가
            // get() 에서 내부 reference 를 그대로 돌려주는 구현일 때, naive 한
            // map[k] = v 직접 mutation 은 update 실패 전에도 in-memory 상태를
            // 새게 한다. 이 store 는 항상 clone 을 update 로 넘긴다.
            let receivedByUpdate: Record<string, RecoveryEntry> | undefined;
            const store = makeRecoveryStore({
                get<T>(_k: string, def: T): T { return def; },
                update(_k: string, value: unknown): PromiseLike<void> {
                    receivedByUpdate = value as Record<string, RecoveryEntry>;
                    return Promise.resolve();
                }
            }, KEY);
            const entry: RecoveryEntry = { data: { v: 1 }, isRootArray: false, fileMtimeMs: 1, capturedAt: 1 };
            await store.set('/abs/foo.json', entry);

            assert.ok(receivedByUpdate, 'update must have been called');
            // update 가 받은 map 을 외부에서 mutate.
            (receivedByUpdate as Record<string, RecoveryEntry>)['/abs/foo.json'] = { ...entry, data: { tampered: true } };
            delete (receivedByUpdate as Record<string, RecoveryEntry>)['/abs/foo.json']; // 외부에서 통째로 지우는 시나리오

            // shadow 는 영향 없어야 한다.
            assert.deepStrictEqual(store.get('/abs/foo.json'), entry, 'shadow must not be affected by external mutation of the value passed to update()');
        });

        test('shadow survives an update failure (per-session resilience)', async () => {
            // 회귀 가드: 일반 Memento 호환. update 가 실패해도 shadow 는 그
            // 세션 동안 in-memory recovery state 로 동작해야 한다.
            // (재구동 시 workspaceState 로 부터 새로 읽기 때문에 disk-failure 는
            // 다음 세션부터 자연스럽게 잊힌다.)
            const store = makeRecoveryStore({
                get<T>(_k: string, def: T): T { return def; },
                update(_k: string, _v: unknown): PromiseLike<void> {
                    return Promise.reject(new Error('disk full'));
                }
            }, KEY);
            const entry: RecoveryEntry = { data: { v: 1 }, isRootArray: false, fileMtimeMs: 1, capturedAt: 1 };

            await assert.rejects(() => store.set('/a.json', entry), /disk full/);
            // shadow 는 그 세션 동안 entry 를 보존.
            assert.deepStrictEqual(store.get('/a.json'), entry);
        });
    });

    suite('host: recovery & watcher contract', () => {
        const srcDir = path.resolve(__dirname, '..', '..', 'src');
        const editorSource = readSourceForRegex(path.join(srcDir, 'jsonEditor.ts'));

        test('panel dispose flushes pending snapshot before reset', () => {
            // 회귀 가드: P1-1. dispose 핸들러가 currentFlushPendingSnapshot을
            // 호출한 뒤에 모듈-레벨 상태를 리셋해야 debounce 창 안에 닫힌
            // 변경이 살아남는다.
            const disposeMatch = editorSource.match(/onDidDispose\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*;\s*\n/);
            assert.ok(disposeMatch, 'could not locate onDidDispose body');
            const body = disposeMatch![1];
            const flushIdx = body.indexOf('currentFlushPendingSnapshot');
            const clearIdx = body.indexOf('clearSnapshotTimer');
            assert.ok(flushIdx >= 0, 'dispose handler must invoke currentFlushPendingSnapshot');
            assert.ok(clearIdx >= 0, 'dispose handler still calls clearSnapshotTimer at the end');
            assert.ok(flushIdx < clearIdx, 'flush must run BEFORE clearSnapshotTimer (which discards pending)');
        });

        test('external-change Keep branch updates baselineMtimeMs and writes recovery immediately', () => {
            // 회귀 가드: P2-3. 사용자가 Keep을 골랐을 때 baselineMtimeMs가
            // 새 외부 mtime으로 갱신되지 않으면 reopen 시 shouldOfferRecovery가
            // stale로 폐기해 사용자의 명시적 Keep이 무시된다.
            const keepBranch = editorSource.match(/if\s*\(\s*choice\s*!==\s*reloadLabel\s*\)\s*\{([\s\S]*?)return;\s*\n\s*\}\s*\n\s*\}/);
            assert.ok(keepBranch, 'could not locate the external-change Keep branch');
            const body = keepBranch![1];
            assert.ok(/baselineMtimeMs\s*=\s*postPromptStat\.mtimeMs/.test(body),
                'Keep branch must update baselineMtimeMs from a fresh post-prompt stat');
            assert.ok(/baselineFileSize\s*=\s*postPromptStat\.size/.test(body),
                'Keep branch must update baselineFileSize from the same post-prompt stat');
            assert.ok(/writeSnapshotEntry\(\s*currentLastReceivedSnapshot/.test(body),
                'Keep branch must immediately write the latest received snapshot to recovery so close-without-edit is preserved');
        });

        test('external-change Keep branch re-stats AFTER prompt to defeat in-prompt mtime races', () => {
            // 회귀 가드: prompt 가 떠 있는 동안 파일이 한 번 더 외부에서 변경되면,
            // 콜백 시작에서 잡은 changedStat.mtime 은 stale 이다. 응답 직후 fresh
            // stat 을 다시 잡지 않으면 baseline/recovery 가 옛 mtime 으로 stamp 돼
            // reopen 에서 stale 로 폐기, 사용자의 명시적 Keep 이 무시된다.
            const keepBranch = editorSource.match(/if\s*\(\s*choice\s*!==\s*reloadLabel\s*\)\s*\{([\s\S]*?)return;\s*\n\s*\}\s*\n\s*\}/);
            assert.ok(keepBranch, 'could not locate the external-change Keep branch');
            const body = keepBranch![1];
            // showWarningMessage(prompt) 의 await 이 끝난 뒤(=Keep 분기 진입 후)에
            // statSync 호출이 와야 한다. 분기 안 어딘가에서 fs.statSync 가 호출되는지.
            assert.ok(/fs\.statSync\(\s*filePath\s*\)/.test(body),
                'Keep branch must re-stat the file AFTER the prompt response');
            // 그 결과로 baseline 을 갱신해야지, prompt 직전 changedStat 으로
            // baselineMtimeMs 를 채우면 race 가 닫히지 않는다.
            assert.ok(!/baselineMtimeMs\s*=\s*changedStat\.mtimeMs/.test(body),
                'Keep branch must not assign baselineMtimeMs from the pre-prompt changedStat');
        });

        test('manual Reload failure path updates baseline + flips webview to baseline-unknown', () => {
            // 회귀 가드: 사용자가 *다시 읽기* 를 눌렀는데 size 초과 / read 실패 /
            // parse 실패 로 reload 가 무산되면, 현재 webview 데이터는 옛 디스크 기준
            // 인데 새 디스크 mtime 과 동기화되지 않는다. 그 상태에서 사용자가 계속
            // 편집하고 닫으면 recovery 가 옛 mtime 으로 stamp 되어 reopen 시 stale 로
            // 버려진다. watcher 의 auto-reload 실패 경로와 동일한 처치 — baseline
            // 갱신 + markBaselineUnknown — 이 manual Reload 에도 와야 한다.
            //
            // editorSource 전체에서 헬퍼 정의를 직접 찾는다 — case 'reload' 블록의
            // 첫 break 가 confirmDiscardIfDirty 의 early-return 이라 case 블록 자체를
            // slice 하면 helper 정의가 잘려나간다.
            const helper = editorSource.match(/const\s+handleReloadFailure\s*=\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n[ \t]+\};/);
            assert.ok(helper, 'reload case must define handleReloadFailure helper');
            const helperBody = helper![2];
            assert.ok(/baselineMtimeMs\s*=\s*statForBaseline\.mtimeMs/.test(helperBody),
                'handleReloadFailure must update baselineMtimeMs from a stat snapshot');
            assert.ok(/baselineFileSize\s*=\s*statForBaseline\.size/.test(helperBody),
                'handleReloadFailure must update baselineFileSize from the same stat snapshot');
            assert.ok(/currentIsDirty\s*=\s*true/.test(helperBody),
                'handleReloadFailure must flip currentIsDirty to true');
            assert.ok(/markBaselineUnknown/.test(helperBody),
                'handleReloadFailure must send markBaselineUnknown to the webview');
            // size-exceeded 와 catch 블록 양쪽에서 호출돼야 한다. `const handleReloadFailure
            // =` 정의는 `handleReloadFailure(` 패턴과 안 겹치므로 호출만 카운트된다.
            const calls = editorSource.match(/handleReloadFailure\s*\(/g) || [];
            assert.ok(
                calls.length >= 2,
                'handleReloadFailure must be invoked from both the size-exceeded path and the catch block (expected >= 2 calls, got ' + calls.length + ')'
            );
        });

        test('watcher self-write suppression requires both mtime AND size to match', () => {
            // 회귀 가드: mtime 만으로 self-write 를 식별하면 mtime 보존형 외부 변경
            // (`touch -r`, 일부 sync 도구) 이 self-write 로 오인돼 watcher 가
            // 무시한다 → 사용자가 stale data 위에서 편집 → close 시 recovery 가
            // 옛 baseline size 로 stamp → reopen 시 size mismatch 로 폐기 →
            // 편집본 손실. mtime 일치 + size 불일치는 외부 변경 경로로 흘려야 한다.
            //
            // suppression 표현식의 위치는 `JSON Editor가 방금 쓴 변경이면 무시`
            // 주석 직후. 그 if 블록 head 를 잡아 size 검사 조건이 들어 있는지 확인.
            const suppressMatch = editorSource.match(
                /JSON Editor가 방금 쓴 변경이면 무시[\s\S]{0,400}?if\s*\(([\s\S]*?)\)\s*\{\s*\n\s*return;/
            );
            assert.ok(suppressMatch, 'could not locate the watcher self-write suppression block');
            const condition = suppressMatch![1];
            assert.ok(/currentLastWriteMtime/.test(condition),
                'suppression must still gate on currentLastWriteMtime');
            assert.ok(/currentLastWriteSize/.test(condition),
                'suppression must also consult currentLastWriteSize so mtime-preserving external changes are NOT suppressed');
            assert.ok(/changedStat\.size/.test(condition),
                'suppression must compare changedStat.size against currentLastWriteSize');
        });

        test('module declares currentLastWriteSize paired with currentLastWriteMtime', () => {
            // 회귀 가드: paired 변수가 사라지면 위 suppression 검사가 매번
            // undefined 와 비교돼 사실상 mtime-only 로 회귀한다.
            assert.ok(
                /let\s+currentLastWriteSize\s*:\s*number\s*\|\s*undefined\s*;/.test(editorSource),
                'module must declare currentLastWriteSize: number | undefined'
            );
            // currentLastWriteMtime = ... 를 갱신하는 모든 사이트는
            // currentLastWriteSize 도 함께 갱신해야 한다 — 호출 횟수 동일.
            // (lookahead 로 `===`, `==`, `=>` 비교/화살표 토큰을 제외해 진짜
            // 할당만 카운트.)
            const mtimeWrites = editorSource.match(/currentLastWriteMtime\s*=(?![=>])/g) || [];
            const sizeWrites = editorSource.match(/currentLastWriteSize\s*=(?![=>])/g) || [];
            assert.strictEqual(
                sizeWrites.length, mtimeWrites.length,
                `currentLastWriteMtime assignments (${mtimeWrites.length}) must be matched 1:1 by currentLastWriteSize assignments (${sizeWrites.length})`
            );
        });

        test('writeSnapshotEntry stamps both fileMtimeMs and fileSize', () => {
            // 회귀 가드: size fingerprint 가 빠지면 mtime 보존형 외부 변경
            // (예: `touch -r`) 을 reopen 에서 잡지 못해 사용자가 보지 않은
            // 변경 위에 stale 복구가 덮인다.
            const writer = editorSource.match(/const\s+writeSnapshotEntry\s*=\s*\([^)]*\)\s*:\s*Promise<void>\s*=>\s*\{([\s\S]*?)\n\s{4}\};/);
            assert.ok(writer, 'could not locate writeSnapshotEntry');
            const body = writer![1];
            assert.ok(/fileMtimeMs\s*:\s*baselineMtimeMs/.test(body),
                'writeSnapshotEntry must record baselineMtimeMs');
            assert.ok(/fileSize\s*:\s*baselineFileSize/.test(body),
                'writeSnapshotEntry must also record baselineFileSize as a secondary fingerprint');
        });

        test('confirmDiscardIfDirty success path clears prior recovery state', () => {
            // 회귀 가드: P2-1. 사용자가 *변경사항 버리기* 를 골랐는데도
            // discardPriorRecoveryIfAny()를 호출하지 않으면, 다음 reopen에서
            // 방금 버린 변경이 *복구 프롬프트*로 되살아난다. opener의 두
            // confirmDiscardIfDirty 분기 모두에서 호출되어야 한다.
            const opener = editorSource.match(/async function openJsonEditorWithPath[\s\S]*?\n\}\s*\n/);
            assert.ok(opener, 'could not locate openJsonEditorWithPath');
            const body = opener![0];
            // 두 분기(다른 파일 / 같은 파일 dirty reopen) 양쪽 모두에서 호출 확인.
            const calls = body.match(/discardPriorRecoveryIfAny\(\s*context\s*,\s*currentFilePath\s*\)/g) || [];
            assert.ok(
                calls.length >= 2,
                'opener must call discardPriorRecoveryIfAny in both confirmDiscardIfDirty branches (expected >= 2 calls, got ' + calls.length + ')'
            );
            // helper 자체가 pending snapshot/lastReceived도 함께 정리하는지.
            const helper = editorSource.match(/async function discardPriorRecoveryIfAny[\s\S]*?\n\}\s*\n/);
            assert.ok(helper, 'could not locate discardPriorRecoveryIfAny');
            const helperBody = helper![0];
            assert.ok(/currentPendingSnapshot\s*=\s*undefined/.test(helperBody),
                'discardPriorRecoveryIfAny must clear currentPendingSnapshot');
            assert.ok(/currentLastReceivedSnapshot\s*=\s*undefined/.test(helperBody),
                'discardPriorRecoveryIfAny must clear currentLastReceivedSnapshot');
            assert.ok(/setRecoveryEntry\(\s*context\s*,\s*filePath\s*,\s*null\s*\)/.test(helperBody),
                'discardPriorRecoveryIfAny must clear the workspaceState entry');
        });

        test('setRecoveryEntry routes through the serialized RecoveryStore', () => {
            // 회귀 가드: 직접 workspaceState.update 를 호출하면 race lock 을
            // 우회해 save vs in-flight snapshot 사이의 read-modify-write race 가
            // 다시 열린다.
            assert.ok(
                /makeRecoveryStore\(\s*context\.workspaceState\s*,\s*RECOVERY_STATE_KEY\s*\)/.test(editorSource),
                'host must construct the recovery store via makeRecoveryStore so updates are serialized'
            );
            assert.ok(
                /function setRecoveryEntry[\s\S]*?getRecoveryStore\(\s*context\s*\)\.set\(/.test(editorSource),
                'setRecoveryEntry must delegate to RecoveryStore.set'
            );
        });

        test('openJsonEditorFromUri normalizes the menu argument through coerceToUri', () => {
            // 회귀 가드: taskhub.openJsonEditorFromUri 는 explorer/editor/scm 메뉴에
            // 노출돼 있어 VS Code 가 `Uri` 외에 `SourceControlResourceState`
            // (`{ resourceUri: Uri }`) 형태도 넘긴다. 첫 인자를 그대로 `Uri` 로
            // 취급하면 SCM 메뉴에서 `uri.fsPath` 가 undefined → openJsonEditorWithPath
            // 의 `filePath.split(...)` 에서 터진다. previewOpener 의 coerceToUri 로
            // 정규화해야 한다.
            assert.ok(
                /import\s*\{[^}]*\bcoerceToUri\b[^}]*\}\s*from\s*['"]\.\/previewOpener['"]/.test(editorSource),
                'jsonEditor.ts must import coerceToUri from ./previewOpener'
            );
            const fnMatch = editorSource.match(/export async function openJsonEditorFromUri\([\s\S]*?\n\}/);
            assert.ok(fnMatch, 'could not locate openJsonEditorFromUri body');
            const body = fnMatch![0];
            assert.ok(
                /\bcoerceToUri\s*\(/.test(body),
                'openJsonEditorFromUri must run its first argument through coerceToUri(...)'
            );
            // 인자 시그니처가 `unknown` 이어야 좁은 `vscode.Uri` 타입 가정으로
            // 회귀하지 않는다 (extension.ts 의 명령 람다도 raw 인자를 그대로 넘긴다).
            assert.ok(
                /openJsonEditorFromUri\(\s*context:\s*vscode\.ExtensionContext\s*,\s*\w+\??\s*:\s*unknown/.test(body),
                'openJsonEditorFromUri must accept the raw menu argument typed as unknown, not vscode.Uri'
            );
        });
    });

    suite('webview: review round 2 contracts', () => {
        const srcDir = path.resolve(__dirname, '..', '..', 'src');
        const editorSource = readSourceForRegex(path.join(srcDir, 'jsonEditor.ts'));

        test('primitive-array add/remove handlers sync editing input values into data first', () => {
            // 회귀 가드: P1. 사용자가 input[data-arr-idx] 를 수정한 뒤
            // + Add 또는 ✕ 를 누르면, mutation 핸들러가 syncEditingArrayCellToData
            // 로 input.value 를 먼저 data 에 반영해야 한다. 그렇게 하지 않으면
            // renderTable 이 DOM 을 갈아치우는 순간 input.value 가 영영 사라진다.
            for (const marker of ['data-add-arr', 'data-remove-arr']) {
                const re = new RegExp(marker + '[\\s\\S]{0,400}?syncEditingArrayCellToData\\(\\s*td\\s*\\)');
                assert.ok(
                    re.test(editorSource),
                    'handler "' + marker + '" must call syncEditingArrayCellToData(td) before mutating arr'
                );
            }
            // 동기화 후에야 splice/push 가 와야 한다 — splice/push 가 sync 호출
            // 보다 앞에 있으면 사용자가 마지막에 수정한 input value 가 누락된다.
            const removeBlock = editorSource.match(/data-remove-arr[\s\S]{0,1500}?arr\.splice\(/);
            assert.ok(removeBlock, 'remove handler must end with arr.splice');
            assert.ok(
                /syncEditingArrayCellToData\([\s\S]*?\)[\s\S]*?arr\.splice\(/.test(removeBlock![0]),
                'syncEditingArrayCellToData must precede arr.splice'
            );
            const addBlock = editorSource.match(/data-add-arr[\s\S]{0,1500}?arr\.push\(/);
            assert.ok(addBlock, 'add handler must end with arr.push');
            assert.ok(
                /syncEditingArrayCellToData\([\s\S]*?\)[\s\S]*?arr\.push\(/.test(addBlock![0]),
                'syncEditingArrayCellToData must precede arr.push'
            );
        });

        test('pushHistory centralizes dirty + snapshot decision via lastSavedSnapshot', () => {
            // 회귀 가드: P2-2. 수동 revert(foo→bar→foo) 시 데이터가 saved
            // baseline 과 같아져도 dirty 표시가 남으면 안 된다. pushHistory 가
            // snap !== lastSavedSnapshot 으로 판단해 setModified(dirtyNow) 를 호출
            // 하고, dirty 일 때만 snapshot 을 보내야 한다.
            const pushMatch = editorSource.match(/function pushHistory\(\) \{([\s\S]*?)\n    \}/);
            assert.ok(pushMatch, 'could not locate pushHistory body');
            const body = pushMatch![1];
            assert.ok(
                /const\s+dirtyNow\s*=\s*snap\s*!==\s*lastSavedSnapshot/.test(body),
                'pushHistory must compute dirtyNow as snap !== lastSavedSnapshot'
            );
            assert.ok(
                /setModified\(\s*dirtyNow\s*\)/.test(body),
                'pushHistory must call setModified(dirtyNow) so manual revert clears the modified flag'
            );
            const all = body.match(/postMessage\(\s*\{\s*command:\s*'snapshot'/g) || [];
            assert.strictEqual(all.length, 1, 'pushHistory should send the snapshot exactly once (within the dirty branch)');
            assert.ok(
                /if\s*\(\s*dirtyNow\s*\)\s*\{[\s\S]*?postMessage\(\s*\{\s*command:\s*'snapshot'/.test(body),
                'pushHistory must gate the snapshot send on dirtyNow to avoid resurrecting a cleared recovery entry'
            );
        });

        test('mutation handlers no longer call setModified(true) — pushHistory owns the decision', () => {
            // 회귀 가드: P2-2 후속. 핸들러에 setModified(true) 가 남아 있으면
            // 수동 revert 시 modified=true → modified=false 가 두 번 송신되어
            // host 가 의미 없는 work 를 하고, 더 나쁘게는 race 가 다시 열린다.
            // mutation 사이트들에서 setModified(true) 가 사라졌는지 정적 검사.
            const sites = ['data-remove-arr', 'data-add-arr', 'data-convert', 'data-delete-row', 'dragSrcIdx', 'btnAddRow'];
            for (const marker of sites) {
                // 각 사이트의 핸들러 안에서 첫 setModified( 가 등장하면 fail.
                const re = new RegExp(marker + '[\\s\\S]{0,1200}?setModified\\(\\s*true\\s*\\)');
                assert.ok(
                    !re.test(editorSource),
                    'handler "' + marker + '" must not call setModified(true) directly — pushHistory owns dirty state'
                );
            }
            // commitCell 의 changed 분기도 동일.
            const commitMatch = editorSource.match(/function commitCell\(td\) \{([\s\S]*?)\n    \}\s*\n/);
            assert.ok(commitMatch, 'could not locate commitCell body');
            assert.ok(
                !/setModified\(\s*true\s*\)/.test(commitMatch![1]),
                'commitCell must not call setModified(true) — pushHistory owns dirty state'
            );
        });

        test('tab click commits the active cell before switching sheets', () => {
            // 회귀 가드: P1 (round 3). 탭 클릭은 즉시 renderTabs/renderTable 로
            // DOM 을 갈아 치워 활성 셀의 td 를 detach 시킨다. blur 100ms timeout
            // 은 isConnected 가드에 막혀 commit 이 스킵되어 입력이 유실된다.
            // tab.onclick 핸들러가 commitActiveCellOrAbort() 를 먼저 호출해야 한다.
            assert.ok(
                /tab\.onclick\s*=\s*\(\)\s*=>\s*\{[\s\S]*?if\s*\(\s*!commitActiveCellOrAbort\(\)\s*\)\s*\{\s*return;\s*\}[\s\S]*?activeIdx\s*=\s*idx/.test(editorSource),
                'tab.onclick must call commitActiveCellOrAbort() before mutating activeIdx and re-rendering'
            );
        });

        test('Reload button commits the active cell before posting reload to host', () => {
            // 회귀 가드: P1 (round 3). Reload 는 host 의 confirmDiscardIfDirty 를
            // 거치지만, 활성 셀의 미커밋 입력은 아직 data 에 들어가지 않아 dirty
            // 판정 자체가 거짓일 수 있다. webview 가 먼저 commit 을 시도해 입력을
            // 보존하고, invalid 이면 reload 를 중단해야 한다.
            assert.ok(
                /btnReload[\s\S]*?addEventListener\(\s*'click'[\s\S]*?if\s*\(\s*!commitActiveCellOrAbort\(\)\s*\)\s*\{\s*return;\s*\}[\s\S]*?postMessage\(\s*\{\s*command:\s*'reload'/.test(editorSource),
                'Reload click handler must commitActiveCellOrAbort() before posting reload'
            );
        });

        test('cell-edit inputs broadcast draft snapshots on every keystroke', () => {
            // 회귀 가드: P1 (round 3). 패널이 강제로 닫히는 시나리오에서 활성
            // 셀의 미커밋 입력이 host recovery 에 남도록, 모든 cell-edit input/
            // textarea 가 input 이벤트마다 draft snapshot 을 송신해야 한다.
            assert.ok(
                /document\.querySelectorAll\(\s*'\.cell-edit input,\s*\.cell-edit textarea'\s*\)[\s\S]*?addEventListener\(\s*'input'\s*,[\s\S]*?sendDraftSnapshot\(/.test(editorSource),
                'every cell-edit input/textarea must wire an input listener that calls sendDraftSnapshot'
            );
            // sendDraftSnapshot 은 핵심 로직을 buildDraftSnapshot 헬퍼에 위임
            // (round 4). 위임 사이트와 결과 분기(snapshot/clean) 모두 보존되는지
            // 확인 — 직접 postMessage 만 호출하는 옛 코드로 회귀하면 타입 손실
            // (Finding 1) / json-edit 미복구 (Finding 2) / clean revert 노이즈
            // (Finding 3) 가 모두 부활한다.
            const drafted = editorSource.match(/function sendDraftSnapshot\(input\) \{([\s\S]*?)\n    \}/);
            assert.ok(drafted, 'could not locate sendDraftSnapshot');
            const body = drafted![1];
            assert.ok(
                /buildDraftSnapshot\(\s*\{/.test(body),
                'sendDraftSnapshot must delegate to buildDraftSnapshot (do not inline the deep-clone logic)'
            );
            assert.ok(
                /result\.kind\s*===\s*'snapshot'[\s\S]*?setModified\(\s*true\s*\)[\s\S]*?postMessage\(\s*\{\s*command:\s*'snapshot'/.test(body),
                'sendDraftSnapshot must call setModified(true) before posting `snapshot` so host currentIsDirty is set ' +
                '(otherwise external-change watcher auto-reloads and discards in-flight typing, and clean-revert ' +
                'setModified(false) is silently a no-op because modified never went true).'
            );
            assert.ok(
                /result\.kind\s*===\s*'clean'[\s\S]*?setModified\(\s*false\s*\)/.test(body),
                'sendDraftSnapshot must call setModified(false) on the clean result kind so host clears the recovery entry'
            );
            assert.ok(
                /result\.kind\s*===\s*'skip'[\s\S]*?setModified\(\s*true\s*\)/.test(body),
                'sendDraftSnapshot must call setModified(true) on the skip result kind too — the most common skip ' +
                'case is json-edit textarea with mid-edit invalid JSON, where the user has uncommitted input but ' +
                'no parseable draft to capture. Without dirty=true, external-change auto-reload and file-switch ' +
                'silently discard that input.'
            );
        });

        test('webview buildDraftSnapshot mirrors the jsonEditorUtils helper', () => {
            // 회귀 가드 (round 4): webview 의 IIFE 가 외부 모듈을 import 못 하므로
            // buildDraftSnapshot 본체가 webview 와 mirror 양쪽에 존재해야 한다.
            // 핵심 분기(타입 보존 / json-edit valid 캡처 / clean revert 인식) 가
            // 한쪽에서만 살아남으면 단위테스트가 통과해도 실제 webview 에서는
            // 데이터 손상이 발생한다.
            const fn = editorSource.match(/function buildDraftSnapshot\(args\) \{([\s\S]*?)\n    \}/);
            assert.ok(fn, 'webview must define buildDraftSnapshot(args)');
            const body = fn![1];
            assert.ok(
                /JSON\.parse\(\s*JSON\.stringify\(\s*data\s*\)\s*\)/.test(body),
                'webview buildDraftSnapshot must operate on a deep clone of data, not mutate it'
            );
            assert.ok(
                /typeof\s+oldVal\s*===\s*'string'\s*\)\s*\?\s*rawInputValue\s*:\s*parseValue\(/.test(body),
                'webview buildDraftSnapshot must preserve cell type via the same string-vs-non-string coercion as commitCell'
            );
            assert.ok(
                /isJsonEdit[\s\S]*?JSON\.parse\(\s*rawInputValue\s*\)/.test(body),
                'webview buildDraftSnapshot must parse json-edit raw text (Finding 2 — valid JSON drafts must reach recovery)'
            );
            assert.ok(
                /JSON\.stringify\(\s*draft\s*\)\s*===\s*lastSavedSnapshot/.test(body),
                'webview buildDraftSnapshot must compare against lastSavedSnapshot to detect clean reverts (Finding 3)'
            );
            assert.ok(
                /return\s*\{\s*kind:\s*'clean'\s*\}/.test(body),
                'webview buildDraftSnapshot must return { kind: clean } when draft equals lastSavedSnapshot'
            );
        });

        test('syncEditingArrayCellToData mutates arr in place to keep getActiveRows reference', () => {
            // 회귀 가드: 헬퍼가 새 array 를 할당하면 row 객체의 reference 가
            // 끊어져 getActiveRows()[rowIdx][col] 와 헬퍼 반환값이 분기한다.
            // splice/push 가 원본에 안 가 사용자의 변경이 데이터에 반영되지 않는다.
            // arr 자체의 in-place 갱신 패턴(arr.length = 0; for ... arr.push(v))
            // 이 보존되었는지 확인.
            const helper = editorSource.match(/function syncEditingArrayCellToData\(td\) \{([\s\S]*?)\n    \}/);
            assert.ok(helper, 'could not locate syncEditingArrayCellToData');
            const body = helper![1];
            assert.ok(
                /arr\.length\s*=\s*0/.test(body),
                'syncEditingArrayCellToData must reset arr.length to 0 (in-place clear) instead of reassigning to a new array'
            );
            assert.ok(
                /for\s*\([\s\S]*?of\s+newArr\s*\)[\s\S]*?arr\.push\(/.test(body),
                'syncEditingArrayCellToData must repopulate arr via push so the original reference is preserved'
            );
        });
    });
});
