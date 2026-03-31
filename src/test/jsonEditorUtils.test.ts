import * as assert from 'assert';
import { buildSheetMap, getRowsByPath, SheetEntry } from '../jsonEditorUtils';
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
});
