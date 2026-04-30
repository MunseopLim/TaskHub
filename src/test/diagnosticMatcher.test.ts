import * as assert from 'assert';
import {
    applyDiagnosticMatchers,
    normalizeSeverity,
    resolveDiagnosticMatcher,
    DIAGNOSTIC_PRESETS,
} from '../diagnosticMatcher';
import type { DiagnosticPattern } from '../schema';

suite('diagnosticMatcher', () => {

    suite('normalizeSeverity', () => {
        test('maps gcc/clang severity tokens to canonical buckets', () => {
            assert.strictEqual(normalizeSeverity('error'), 'error');
            assert.strictEqual(normalizeSeverity('Error'), 'error');
            assert.strictEqual(normalizeSeverity('ERROR'), 'error');
            assert.strictEqual(normalizeSeverity('fatal error'), 'error');
            assert.strictEqual(normalizeSeverity('fatal'), 'error');
            assert.strictEqual(normalizeSeverity('warning'), 'warning');
            assert.strictEqual(normalizeSeverity('warn'), 'warning');
            assert.strictEqual(normalizeSeverity('note'), 'info');
            assert.strictEqual(normalizeSeverity('info'), 'info');
            assert.strictEqual(normalizeSeverity('information'), 'info');
            assert.strictEqual(normalizeSeverity('hint'), 'hint');
        });

        test('returns undefined for unrecognized severities so callers fall back to default', () => {
            assert.strictEqual(normalizeSeverity('debug'), undefined);
            assert.strictEqual(normalizeSeverity('TS2304'), undefined);
            assert.strictEqual(normalizeSeverity(''), undefined);
            assert.strictEqual(normalizeSeverity(undefined), undefined);
        });

        test('handles whitespace tolerantly', () => {
            assert.strictEqual(normalizeSeverity('  Warning  '), 'warning');
        });
    });

    suite('resolveDiagnosticMatcher', () => {
        test('resolves preset shorthand strings to the registered pattern', () => {
            const gcc = resolveDiagnosticMatcher('$gcc');
            assert.strictEqual(gcc, DIAGNOSTIC_PRESETS.gcc);
            assert.strictEqual(gcc.source, 'gcc');
        });

        test('throws on unknown preset with the available list in the error message', () => {
            assert.throws(
                () => resolveDiagnosticMatcher('$unknown'),
                /Unknown diagnostic preset.*\$gcc.*\$tsc/
            );
        });

        test('throws when a string entry does not start with $', () => {
            assert.throws(
                () => resolveDiagnosticMatcher('gcc'),
                /must start with '\$'/
            );
        });

        test('returns inline pattern objects unchanged', () => {
            const inline: DiagnosticPattern = {
                pattern: '^(.+):(\\d+):(.+)$', file: 1, line: 2, message: 3
            };
            assert.strictEqual(resolveDiagnosticMatcher(inline), inline);
        });
    });

    suite('$gcc preset', () => {
        const sample = [
            "src/main.c:42:5: error: 'foo' undeclared (first use in this function)",
            "src/main.c:73:12: warning: unused variable 'tmp' [-Wunused-variable]",
            "src/main.c:100:1: note: previous declaration was here"
        ].join('\n');

        test('matches gcc-style output and yields one diagnostic per line', () => {
            const out = applyDiagnosticMatchers(sample, '$gcc');
            assert.strictEqual(out.length, 3);
        });

        test('extracts file / line / column / severity / message correctly', () => {
            const out = applyDiagnosticMatchers(sample, '$gcc');
            assert.deepStrictEqual(out[0], {
                file: 'src/main.c',
                line: 42,
                column: 5,
                endLine: undefined,
                endColumn: undefined,
                severity: 'error',
                message: "'foo' undeclared (first use in this function)",
                source: 'gcc'
            });
            assert.strictEqual(out[1].severity, 'warning');
            assert.strictEqual(out[2].severity, 'info'); // note → info
        });

        test('handles fatal error severity (clang-style)', () => {
            const fatal = "src/main.c:1:10: fatal error: 'missing.h' file not found";
            const out = applyDiagnosticMatchers(fatal, '$gcc');
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].severity, 'error');
            assert.strictEqual(out[0].message, "'missing.h' file not found");
        });

        test('absolute paths and Windows drive letters pass through unchanged', () => {
            const win = 'C:/build/main.c:5:10: error: bad';
            const abs = '/usr/src/main.c:5:10: error: bad';
            assert.strictEqual(applyDiagnosticMatchers(win, '$gcc')[0].file, 'C:/build/main.c');
            assert.strictEqual(applyDiagnosticMatchers(abs, '$gcc')[0].file, '/usr/src/main.c');
        });

        test('unrelated lines are skipped', () => {
            const mixed = [
                'gcc -O2 -c src/main.c',                       // build command — ignore
                'src/main.c:42:5: error: x',                   // diagnostic
                "make: *** [Makefile:10: build] Error 1"       // make failure — ignore
            ].join('\n');
            const out = applyDiagnosticMatchers(mixed, '$gcc');
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].line, 42);
        });
    });

    suite('$tsc preset', () => {
        test('matches TypeScript compiler output', () => {
            const sample = "src/foo.ts(42,5): error TS2304: Cannot find name 'bar'.";
            const out = applyDiagnosticMatchers(sample, '$tsc');
            assert.strictEqual(out.length, 1);
            assert.deepStrictEqual(out[0], {
                file: 'src/foo.ts',
                line: 42,
                column: 5,
                endLine: undefined,
                endColumn: undefined,
                severity: 'error',
                message: "Cannot find name 'bar'.",
                source: 'tsc'
            });
        });
    });

    suite('applyDiagnosticMatchers — array config + multi-pattern', () => {
        test('runs every pattern across every line', () => {
            const customWarning: DiagnosticPattern = {
                // a pretend toolchain that says "WARN @ path:line"
                pattern: '^WARN @ (.+?):(\\d+) (.+)$',
                file: 1, line: 2, message: 3,
                defaultSeverity: 'warning',
                source: 'custom'
            };
            const out = applyDiagnosticMatchers(
                [
                    'src/main.c:42:5: error: foo',
                    'WARN @ src/util.c:10 unused symbol'
                ].join('\n'),
                ['$gcc', customWarning]
            );
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].source, 'gcc');
            assert.strictEqual(out[1].source, 'custom');
            assert.strictEqual(out[1].severity, 'warning');
        });

        test('empty config returns empty array (no work)', () => {
            assert.deepStrictEqual(applyDiagnosticMatchers('anything', undefined), []);
            assert.deepStrictEqual(applyDiagnosticMatchers('anything', []), []);
        });

        test('output with no matching lines returns empty array', () => {
            const out = applyDiagnosticMatchers('build complete\nlinked\n', '$gcc');
            assert.deepStrictEqual(out, []);
        });
    });

    suite('applyDiagnosticMatchers — error paths', () => {
        test('invalid regex pattern throws with a clear message', () => {
            const bad: DiagnosticPattern = {
                pattern: '(', file: 1, line: 2, message: 3
            };
            assert.throws(
                () => applyDiagnosticMatchers('foo', bad),
                /invalid regex/
            );
        });

        test('missing required group field throws', () => {
            const noFile: any = { pattern: '.', line: 1, message: 2 };
            const noLine: any = { pattern: '.', file: 1, message: 2 };
            const noMsg: any  = { pattern: '.', file: 1, line: 2 };
            assert.throws(() => applyDiagnosticMatchers('x', noFile), /'file'/);
            assert.throws(() => applyDiagnosticMatchers('x', noLine), /'line'/);
            assert.throws(() => applyDiagnosticMatchers('x', noMsg),  /'message'/);
        });

        test('non-positive group index is rejected at validation time', () => {
            const zero: any = { pattern: '.', file: 0, line: 1, message: 2 };
            assert.throws(() => applyDiagnosticMatchers('x', zero), /positive integer/);
        });
    });

    suite('applyDiagnosticMatchers — defensive line-number handling', () => {
        test('non-numeric line group is silently dropped (no crash on weird matches)', () => {
            // pretend pattern where line group resolves to a non-numeric token
            const odd: DiagnosticPattern = {
                pattern: '^(.+?):(.+?):(.+)$',
                file: 1, line: 2, message: 3,
                defaultSeverity: 'error'
            };
            const out = applyDiagnosticMatchers('main.c:NaN:something', odd);
            assert.strictEqual(out.length, 0);
        });

        test('empty file group is silently dropped', () => {
            const odd: DiagnosticPattern = {
                pattern: '^(.*?):(\\d+):(.+)$',
                file: 1, line: 2, message: 3
            };
            const out = applyDiagnosticMatchers(':5:msg', odd);
            assert.strictEqual(out.length, 0);
        });
    });

    suite('applyDiagnosticMatchers — fallback severity', () => {
        test('when severity group is absent, defaultSeverity is used', () => {
            const noSev: DiagnosticPattern = {
                pattern: '^(.+?):(\\d+):(.+)$',
                file: 1, line: 2, message: 3,
                defaultSeverity: 'warning'
            };
            const out = applyDiagnosticMatchers('main.c:5:lint hit', noSev);
            assert.strictEqual(out[0].severity, 'warning');
        });

        test('when severity group is present but unrecognized, defaultSeverity wins', () => {
            const odd: DiagnosticPattern = {
                pattern: '^(.+?):(\\d+):(\\w+):(.+)$',
                file: 1, line: 2, severity: 3, message: 4,
                defaultSeverity: 'hint'
            };
            const out = applyDiagnosticMatchers('main.c:5:debug:extra info', odd);
            assert.strictEqual(out[0].severity, 'hint');
        });

        test('without severity group AND without defaultSeverity, falls back to "error"', () => {
            const noSev: DiagnosticPattern = {
                pattern: '^(.+?):(\\d+):(.+)$',
                file: 1, line: 2, message: 3
            };
            const out = applyDiagnosticMatchers('main.c:5:msg', noSev);
            assert.strictEqual(out[0].severity, 'error');
        });
    });
});
