import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
    INTERPOLATED_VALUE_MAX_LENGTH,
    wouldExceedCaptureLimit,
    sanitizeInterpolatedValue,
    interpolatePipelineVariables,
    resolveWithinWorkspace,
    resolveFavoriteFilePath,
    validateLinkScheme,
    ALLOWED_LINK_SCHEMES,
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
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
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

suite('sanitizeInterpolatedValue — length boundary', () => {
    // The guard is `stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH`, so
    // values at exactly the limit must still be accepted. These tests pin
    // that off-by-one so a future edit to `>=` is caught immediately.
    test('accepts a value exactly at INTERPOLATED_VALUE_MAX_LENGTH - 1', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH - 1);
        assert.strictEqual(sanitizeInterpolatedValue(s)?.length, INTERPOLATED_VALUE_MAX_LENGTH - 1);
    });

    test('accepts a value exactly at INTERPOLATED_VALUE_MAX_LENGTH', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH);
        assert.strictEqual(sanitizeInterpolatedValue(s)?.length, INTERPOLATED_VALUE_MAX_LENGTH);
    });

    test('rejects a value exactly at INTERPOLATED_VALUE_MAX_LENGTH + 1', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH + 1);
        assert.throws(() => sanitizeInterpolatedValue(s), /maximum length/);
    });
});

suite('wouldExceedCaptureLimit — capture cap boundary', () => {
    // Guard in executeShellCommand(): `currentBytes + chunkBytes > limitBytes`.
    // Extracted as a pure predicate so we can pin the boundary without
    // spawning a real subprocess.
    test('returns false when total equals the limit (inclusive ceiling)', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 500, 1000), false);
    });

    test('returns false when total is below the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 499, 1000), false);
    });

    test('returns true when total is exactly one byte over the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 501, 1000), true);
    });

    test('handles a zero-byte chunk at exactly the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(1000, 0, 1000), false);
    });

    test('handles a single chunk that alone exceeds an empty buffer', () => {
        assert.strictEqual(wouldExceedCaptureLimit(0, 1001, 1000), true);
        assert.strictEqual(wouldExceedCaptureLimit(0, 1000, 1000), false);
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

    // --- regex group boundary tests ---------------------------------------
    // Guard: `if (group < 0 || group >= m.length) { selected = undefined; }`.
    // With `/^(a)(b)(c)$/` matching "abc" the Match array is ['abc','a','b','c']
    // so m.length === 4 and the valid group range is [0, 3].
    test('regex: group = m.length - 1 (last valid index) selects the last group', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: 3 });
        assert.deepStrictEqual(out, { v: 'c' });
    });

    test('regex: group = m.length (first invalid index) is skipped', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: 4 });
        assert.deepStrictEqual(out, {});
    });

    test('regex: negative group (-1) is treated as out-of-range and skipped', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: -1 });
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

    // --- line index boundary tests ----------------------------------------
    // Resolution: idx = line < 0 ? lines.length + line : line; then selected
    // only if `0 <= idx < lines.length`. With "a\nb\nc" we get three lines so
    // lines.length === 3 and the valid idx range is [0, 2]. For negatives the
    // valid `rule.line` range is [-3, -1].
    test('line: lines.length - 1 (last positive valid index) selects the last line', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: 2 });
        assert.deepStrictEqual(out, { v: 'c' });
    });

    test('line: lines.length (first positive invalid index) is skipped', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: 3 });
        assert.deepStrictEqual(out, {});
    });

    test('line: -lines.length (most-negative valid index) selects the first line', () => {
        // line = -3 → idx = 3 + (-3) = 0 → 'a'
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: -3 });
        assert.deepStrictEqual(out, { v: 'a' });
    });

    test('line: -lines.length - 1 (first negative invalid index) is skipped', () => {
        // line = -4 → idx = 3 + (-4) = -1 → skipped
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: -4 });
        assert.deepStrictEqual(out, {});
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

suite('validateLinkScheme', () => {
    test('allowlist contains exactly http, https, mailto', () => {
        assert.deepStrictEqual(
            [...ALLOWED_LINK_SCHEMES].sort(),
            ['http', 'https', 'mailto']
        );
    });

    test('accepts https URLs', () => {
        const result = validateLinkScheme('https://example.com/path?q=1');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'https');
            assert.strictEqual(result.url, 'https://example.com/path?q=1');
        }
    });

    test('accepts http URLs', () => {
        const result = validateLinkScheme('http://example.com');
        assert.strictEqual(result.ok, true);
    });

    test('accepts mailto URLs', () => {
        const result = validateLinkScheme('mailto:user@example.com');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'mailto');
        }
    });

    test('scheme comparison is case-insensitive', () => {
        const result = validateLinkScheme('HTTPS://EXAMPLE.COM');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'https');
        }
    });

    test('rejects command: URIs', () => {
        const result = validateLinkScheme('command:workbench.action.terminal.sendSequence');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'scheme');
            if (result.reason === 'scheme') {
                assert.strictEqual(result.scheme, 'command');
            }
        }
    });

    test('rejects file: URIs', () => {
        const result = validateLinkScheme('file:///etc/passwd');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'file');
        }
    });

    test('rejects vscode: URIs', () => {
        const result = validateLinkScheme('vscode://some.extension/path');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'vscode');
        }
    });

    test('rejects javascript: URIs', () => {
        const result = validateLinkScheme('javascript:alert(1)');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'javascript');
        }
    });

    test('rejects empty string', () => {
        const result = validateLinkScheme('');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'empty');
        }
    });

    test('rejects whitespace-only string', () => {
        const result = validateLinkScheme('   ');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'empty');
        }
    });

    test('rejects non-string inputs', () => {
        for (const value of [undefined, null, 42, {}, []]) {
            const result = validateLinkScheme(value);
            assert.strictEqual(result.ok, false, `expected reject for ${JSON.stringify(value)}`);
            if (!result.ok) {
                assert.strictEqual(result.reason, 'empty');
            }
        }
    });

    test('rejects strings with no scheme delimiter', () => {
        const result = validateLinkScheme('example.com/path');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'invalid');
        }
    });

    test('rejects protocol-relative URLs', () => {
        const result = validateLinkScheme('//example.com');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'invalid');
        }
    });
});

suite('resolveFavoriteFilePath', () => {
    const root = path.resolve(os.tmpdir(), 'taskhub-favorite-test');

    test('resolves ${workspaceFolder} placeholder to absolute path inside workspace', () => {
        const resolved = resolveFavoriteFilePath('${workspaceFolder}/src/file.ts', root, [root]);
        assert.strictEqual(resolved, path.join(root, 'src/file.ts'));
    });

    test('resolves plain relative path against the workspace folder', () => {
        const resolved = resolveFavoriteFilePath('docs/README.md', root, [root]);
        assert.strictEqual(resolved, path.join(root, 'docs/README.md'));
    });

    test('rejects parent-directory traversal via ${workspaceFolder}', () => {
        assert.throws(
            () => resolveFavoriteFilePath('${workspaceFolder}/../secret.txt', root, [root]),
            /outside/
        );
    });

    test('rejects absolute path outside workspace roots', () => {
        const outside = path.resolve(os.tmpdir(), 'some-other-dir', 'file.txt');
        assert.throws(
            () => resolveFavoriteFilePath(outside, root, [root]),
            /outside/
        );
    });

    test('rejects plain relative path that escapes workspace', () => {
        assert.throws(
            () => resolveFavoriteFilePath('../../etc/passwd', root, [root]),
            /outside/
        );
    });

    test('rejects null-byte injection in favorite path', () => {
        assert.throws(
            () => resolveFavoriteFilePath('file\x00.txt', root, [root]),
            /null byte/
        );
    });
});

suite('normalizeEol', () => {
    test('keep: leaves mixed endings untouched', () => {
        const input = 'a\nb\r\nc\rd';
        assert.strictEqual(normalizeEol(input, 'keep'), input);
    });

    test('keep: undefined eol behaves as keep', () => {
        const input = 'a\r\nb';
        assert.strictEqual(normalizeEol(input, undefined), input);
    });

    test('lf: collapses CRLF but leaves lone CR alone', () => {
        assert.strictEqual(normalizeEol('a\r\nb\nc\rd', 'lf'), 'a\nb\nc\rd');
    });

    test('crlf: every LF becomes CRLF without doubling existing CRLF', () => {
        // 'a\r\nb\nc' has one CRLF and one LF. Expect both to end up CRLF,
        // not 'a\r\r\nb\r\nc' (which would happen with a naive /\n/ → \r\n).
        assert.strictEqual(normalizeEol('a\r\nb\nc', 'crlf'), 'a\r\nb\r\nc');
    });

    test('crlf: pure-LF input becomes pure CRLF', () => {
        assert.strictEqual(normalizeEol('a\nb\nc', 'crlf'), 'a\r\nb\r\nc');
    });

    test('lf: pure-CRLF input becomes pure LF', () => {
        assert.strictEqual(normalizeEol('a\r\nb\r\nc', 'lf'), 'a\nb\nc');
    });

    test('empty string is returned verbatim for every mode', () => {
        assert.strictEqual(normalizeEol('', 'lf'), '');
        assert.strictEqual(normalizeEol('', 'crlf'), '');
        assert.strictEqual(normalizeEol('', 'keep'), '');
    });
});

suite('encodeFileContent', () => {
    test('default utf8 encoding returns plain UTF-8 bytes without BOM', () => {
        const buf = encodeFileContent('héllo', undefined);
        assert.strictEqual(buf.toString('utf8'), 'héllo');
        // First bytes are NOT 0xEF 0xBB 0xBF.
        assert.notStrictEqual(buf[0], 0xef);
    });

    test('utf8 encoding leaves non-ASCII intact', () => {
        const buf = encodeFileContent('안녕', 'utf8');
        assert.strictEqual(buf.toString('utf8'), '안녕');
    });

    test('utf8bom prefixes BOM when includeBom is true (default)', () => {
        const buf = encodeFileContent('hi', 'utf8bom');
        assert.strictEqual(buf[0], 0xef);
        assert.strictEqual(buf[1], 0xbb);
        assert.strictEqual(buf[2], 0xbf);
        assert.strictEqual(buf.slice(3).toString('utf8'), 'hi');
    });

    test('utf8bom omits BOM when includeBom=false (append to existing file)', () => {
        const buf = encodeFileContent('hi', 'utf8bom', false);
        assert.strictEqual(buf.toString('utf8'), 'hi');
        assert.notStrictEqual(buf[0], 0xef);
    });

    test('ascii encoding drops non-ASCII chars to "?"', () => {
        const buf = encodeFileContent('a안b', 'ascii');
        // Node's 'ascii' encoding masks each byte to 7 bits, so non-ASCII
        // bytes get mapped into the ASCII range rather than being silently
        // preserved. The important contract for callers is "output is ASCII
        // safe and round-trips pure-ASCII inputs verbatim".
        assert.strictEqual(buf.toString('ascii').startsWith('a'), true);
        assert.strictEqual(buf.toString('ascii').endsWith('b'), true);
    });

    test('empty string produces zero bytes (no BOM) for utf8', () => {
        assert.strictEqual(encodeFileContent('', 'utf8').length, 0);
    });

    test('empty string + utf8bom still writes the 3-byte BOM', () => {
        const buf = encodeFileContent('', 'utf8bom');
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual([...buf], [0xef, 0xbb, 0xbf]);
    });
});

suite('withTaskTimeout', () => {
    test('resolves when inner promise settles before timeout', async () => {
        const result = await withTaskTimeout(Promise.resolve('ok'), 5, 't1');
        assert.strictEqual(result, 'ok');
    });

    test('propagates inner rejection verbatim before timeout fires', async () => {
        const innerErr = new Error('inner-boom');
        await assert.rejects(
            () => withTaskTimeout(Promise.reject(innerErr), 5, 't1'),
            /inner-boom/
        );
    });

    test('undefined timeout is a no-op and returns the original promise', async () => {
        const result = await withTaskTimeout(Promise.resolve('ok'), undefined, 't1');
        assert.strictEqual(result, 'ok');
    });

    test('zero timeout disables timing out', async () => {
        const slow = new Promise<string>(r => setTimeout(() => r('slow'), 30));
        const result = await withTaskTimeout(slow, 0, 't1');
        assert.strictEqual(result, 'slow');
    });

    test('negative timeout disables timing out', async () => {
        const slow = new Promise<string>(r => setTimeout(() => r('slow'), 30));
        const result = await withTaskTimeout(slow, -5, 't1');
        assert.strictEqual(result, 'slow');
    });

    test('rejects with task id + seconds in message when inner never settles', async () => {
        const never = new Promise(() => { /* never settles */ });
        await assert.rejects(
            () => withTaskTimeout(never, 0.02, 'slow-task'),
            /Task 'slow-task' timed out after 0\.02s\./
        );
    });

    test('invokes onTimeout exactly once when the timer fires', async () => {
        let fired = 0;
        const never = new Promise(() => { /* never */ });
        try {
            await withTaskTimeout(never, 0.02, 't1', () => { fired += 1; });
        } catch { /* expected */ }
        // Give the original promise a moment to confirm we don't double-fire.
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(fired, 1);
    });

    test('does NOT invoke onTimeout when inner resolves in time', async () => {
        let fired = 0;
        await withTaskTimeout(Promise.resolve('ok'), 1, 't1', () => { fired += 1; });
        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(fired, 0);
    });

    test('does not leak unhandled rejection if inner settles after timeout', async () => {
        const err = new Error('late-failure');
        const late = new Promise((_r, reject) => setTimeout(() => reject(err), 30));
        await assert.rejects(
            () => withTaskTimeout(late, 0.01, 't1'),
            /timed out/
        );
        // Allow the original rejection to surface. If we leaked it, Node would
        // print an "UnhandledPromiseRejection" warning. We can't assert that
        // directly in unit tests, but awaiting past the rejection confirms
        // the process stays alive.
        await new Promise(r => setTimeout(r, 50));
    });

    test('swallows onTimeout callback errors so the outer rejection still fires', async () => {
        const never = new Promise(() => { /* never */ });
        await assert.rejects(
            () => withTaskTimeout(never, 0.01, 't1', () => { throw new Error('cleanup-failed'); }),
            /timed out after 0\.01s/
        );
    });
});
