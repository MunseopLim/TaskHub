import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildSheetMap, getRowsByPath, SheetEntry, parseValue, coerceEditedCellValue } from '../jsonEditorUtils';
import { wrapIfArray, unwrapIfRootArray, ROOT_ARRAY_KEY } from '../jsonEditor';

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
            assert.strictEqual(parseValue('hello'), 'hello');
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
        const editorSource = fs.readFileSync(path.join(srcDir, 'jsonEditor.ts'), 'utf-8');
        const mirrorSource = fs.readFileSync(path.join(srcDir, 'jsonEditorUtils.ts'), 'utf-8');

        test('mirror header references every synchronization target by name', () => {
            for (const name of ['buildSheetMap', 'getActiveRows', 'parseValue', 'commitCell']) {
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
                ' ', '   ', 'hello', 'NaN',
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
    });
});
