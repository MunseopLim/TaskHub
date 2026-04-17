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
