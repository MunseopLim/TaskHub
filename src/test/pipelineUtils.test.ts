import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
    INTERPOLATED_VALUE_MAX_LENGTH,
    sanitizeInterpolatedValue,
    interpolatePipelineVariables,
    resolveWithinWorkspace,
    tokenizeCommandLine,
    mergeCommandAndArgs,
    quotePosixArgument,
    quotePowerShellArgument,
    buildPosixCommandLine,
    buildPowerShellInvocation,
    encodePowerShellScript,
    getCommandString,
    getToolCommand,
    applyOutputCapture,
} from '../pipelineUtils';

/**
 * These tests import directly from ../pipelineUtils (not ../extension) to
 * guarantee the module has no hidden dependency on `vscode` or on other parts
 * of extension.ts. If someone accidentally adds such a dependency, this test
 * file will fail to load.
 */
suite('pipelineUtils — direct-import smoke suite', () => {
    test('INTERPOLATED_VALUE_MAX_LENGTH matches documented 32 KB cap', () => {
        assert.strictEqual(INTERPOLATED_VALUE_MAX_LENGTH, 32 * 1024);
    });

    test('sanitizeInterpolatedValue round-trips plain strings', () => {
        assert.strictEqual(sanitizeInterpolatedValue('hello'), 'hello');
    });

    test('interpolatePipelineVariables replaces known keys', () => {
        const out = interpolatePipelineVariables('hi ${name}', { name: 'Alice' });
        assert.strictEqual(out, 'hi Alice');
    });

    test('resolveWithinWorkspace works with only path + roots', () => {
        const root = path.resolve(os.tmpdir(), 'pipelineUtils-smoke');
        const p = path.join(root, 'a.txt');
        assert.strictEqual(resolveWithinWorkspace(p, [root]), p);
    });

    test('tokenizeCommandLine handles quoted segments', () => {
        assert.deepStrictEqual(
            tokenizeCommandLine('cmd "a b" c'),
            ['cmd', 'a b', 'c']
        );
    });

    test('mergeCommandAndArgs splits executable from combined args', () => {
        const { executable, args } = mergeCommandAndArgs('npm run build', ['--prod']);
        assert.strictEqual(executable, 'npm');
        assert.deepStrictEqual(args, ['run', 'build', '--prod']);
    });

    test('POSIX quoting escapes single quotes via the close-escape-reopen idiom', () => {
        assert.strictEqual(quotePosixArgument("it's"), "'it'\\''s'");
        assert.strictEqual(quotePosixArgument(''), "''");
    });

    test('PowerShell quoting doubles embedded single quotes', () => {
        assert.strictEqual(quotePowerShellArgument("it's"), "'it''s'");
    });

    test('buildPosixCommandLine quotes args but leaves safe executable names bare', () => {
        const line = buildPosixCommandLine('echo', ['hello', '; rm']);
        assert.ok(line.startsWith('echo '), `unexpected line: ${line}`);
        assert.ok(line.includes("'hello'"));
        assert.ok(line.includes("'; rm'"));
    });

    test('buildPowerShellInvocation wraps into `& exe args` form', () => {
        const { script, display } = buildPowerShellInvocation('echo', ['hi'], false);
        assert.ok(display.startsWith('& '));
        assert.strictEqual(script, display);
    });

    test('encodePowerShellScript returns UTF-16 LE base64', () => {
        const encoded = encodePowerShellScript('a');
        const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
        assert.strictEqual(decoded, 'a');
    });

    test('getCommandString accepts a plain string', () => {
        assert.strictEqual(getCommandString('npm test'), 'npm test');
    });

    test('getToolCommand quotes paths containing spaces', () => {
        const out = getToolCommand('C:/Program Files/Tool/bin.exe');
        assert.strictEqual(out, '"C:/Program Files/Tool/bin.exe"');
    });
});

suite('applyOutputCapture', () => {
    test('returns empty object when capture is undefined', () => {
        assert.deepStrictEqual(applyOutputCapture('anything', undefined), {});
    });

    test('regex: extracts default capture group 1', () => {
        const out = applyOutputCapture('commit abc1234\n', { name: 'sha', regex: 'commit ([a-f0-9]+)' });
        assert.deepStrictEqual(out, { sha: 'abc1234' });
    });

    test('regex: explicit group 0 returns full match', () => {
        const out = applyOutputCapture('value=42', { name: 'whole', regex: 'value=(\\d+)', group: 0 });
        assert.deepStrictEqual(out, { whole: 'value=42' });
    });

    test('regex: miss produces no entry', () => {
        const out = applyOutputCapture('nothing interesting', { name: 'v', regex: '^v(\\d+)' });
        assert.deepStrictEqual(out, {});
    });

    test('regex: out-of-range group is skipped silently', () => {
        const out = applyOutputCapture('hello', { name: 'v', regex: 'hello', group: 5 });
        assert.deepStrictEqual(out, {});
    });

    test('regex: invalid pattern throws with task-friendly message', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: 'v', regex: '(' }),
            /Capture 'v' has invalid regex/
        );
    });

    test('regex: flags are honored', () => {
        const out = applyOutputCapture('line1\nMATCH\nline3', {
            name: 'pick', regex: 'match', flags: 'i'
        });
        assert.deepStrictEqual(out, { pick: 'MATCH' });
    });

    test('line: positive index selects by 0-based line', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'second', line: 1 });
        assert.deepStrictEqual(out, { second: 'b' });
    });

    test('line: negative index counts from end', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'last', line: -1 });
        assert.deepStrictEqual(out, { last: 'c' });
    });

    test('line: out-of-range index is skipped', () => {
        assert.deepStrictEqual(applyOutputCapture('a\nb', { name: 'v', line: 99 }), {});
        assert.deepStrictEqual(applyOutputCapture('a\nb', { name: 'v', line: -99 }), {});
    });

    test('no selector: uses full output', () => {
        assert.deepStrictEqual(
            applyOutputCapture('raw', { name: 'all' }),
            { all: 'raw' }
        );
    });

    test('trim: applies after selection', () => {
        const out = applyOutputCapture('  hi  \n', { name: 'v', trim: true });
        assert.deepStrictEqual(out, { v: 'hi' });
    });

    test('trim: works with regex selection', () => {
        const out = applyOutputCapture('ver: [ 1.2.3 ]', {
            name: 'v', regex: '\\[(.+)\\]', trim: true
        });
        assert.deepStrictEqual(out, { v: '1.2.3' });
    });

    test('array: applies multiple rules', () => {
        const out = applyOutputCapture('commit abc123\nAuthor: Jane\n', [
            { name: 'sha', regex: 'commit ([a-f0-9]+)' },
            { name: 'author', regex: 'Author: (.+)', trim: true }
        ]);
        assert.deepStrictEqual(out, { sha: 'abc123', author: 'Jane' });
    });

    test('missing name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: '' } as any),
            /missing a non-empty 'name'/
        );
    });

    test('invalid name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: '1bad' } as any),
            /Capture name '1bad' must match/
        );
    });

    test('reserved name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: 'output' }),
            /Capture name 'output' is reserved/
        );
    });

    test('duplicate name throws', () => {
        assert.throws(
            () => applyOutputCapture('hello', [
                { name: 'v', regex: 'hello' },
                { name: 'v', regex: '.' }
            ]),
            /Duplicate capture name 'v'/
        );
    });
});
