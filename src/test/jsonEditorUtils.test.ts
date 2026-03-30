import * as assert from 'assert';
import { buildSheetMap, getRowsByPath, SheetEntry } from '../jsonEditorUtils';

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
});
