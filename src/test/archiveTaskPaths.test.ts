import * as assert from 'assert';
import { archiveResultValue, unzipLocations } from '../archiveTaskPaths';

suite('Archive task locations', () => {
    test('reads preferred fields, a string result and fields inside an output object', () => {
        assert.strictEqual(archiveResultValue('a.zip', ['path']), 'a.zip');
        assert.strictEqual(archiveResultValue({ archivePath: 'b.zip', output: 'x' }, ['path', 'archivePath']), 'b.zip');
        assert.strictEqual(archiveResultValue({ output: { path: 'c.zip' } }, ['path']), 'c.zip');
        assert.strictEqual(archiveResultValue({ output: 'd.zip' }, ['path']), 'd.zip');
        assert.strictEqual(archiveResultValue({ other: 1 }, ['path']), undefined);
    });

    test('prefers the task fields, then the named results, then the archive result folder', () => {
        const results = Object.assign(Object.create(null), {
            pick: { path: '/w/in.zip', dir: '/w' },
            dest: { outputDir: '/w/out' },
        });
        assert.deepStrictEqual(unzipLocations({ archive: 'own.zip', destination: 'here', inputs: { archive: 'pick' } }, results),
            { archive: 'own.zip', destination: 'here' });
        assert.deepStrictEqual(unzipLocations({ inputs: { file: 'pick', destination: 'dest' } }, results),
            { archive: '/w/in.zip', destination: '/w/out' });
        assert.deepStrictEqual(unzipLocations({ inputs: { archive: 'pick' } }, results), { archive: '/w/in.zip', destination: '/w' });
        assert.deepStrictEqual(unzipLocations({ inputs: { archive: 'missing' } }, results), {});
        // A text result names the archive only; the archive's folder is used, never the archive path itself.
        assert.deepStrictEqual(unzipLocations({ inputs: { archive: 'name' } }, Object.assign(Object.create(null), { name: { output: 'out/fw.zip' } })),
            { archive: 'out/fw.zip', destination: undefined });
        assert.deepStrictEqual(unzipLocations({ inputs: { archive: 'name' } }, Object.assign(Object.create(null), { name: 'out/fw.zip' })),
            { archive: 'out/fw.zip', destination: undefined });
        // A task id that only exists on the prototype chain is not a result.
        assert.deepStrictEqual(unzipLocations({ inputs: { archive: 'toString' } }, results), {});
    });
});
