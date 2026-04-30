/**
 * Pure module for converting shell-task output into structured diagnostic
 * records that the extension surface can hand to a `vscode.DiagnosticCollection`.
 *
 * No `vscode` dependency, no I/O — fully deterministic, fully unit-testable.
 * The extension layer is responsible for resolving relative paths against
 * the task's cwd and instantiating real `vscode.Diagnostic` objects.
 */

import type { DiagnosticConfig, DiagnosticPattern } from './schema';

/**
 * Output of `applyDiagnosticMatchers` — a flat list of structured records
 * that can be turned into `vscode.Diagnostic` instances at the extension
 * boundary. `file` is left as the raw matched string so the caller can
 * resolve it against the task's cwd (relative paths are common in compiler
 * output).
 */
export interface ParsedDiagnostic {
    file: string;
    line: number;          // 1-based
    column?: number;       // 1-based
    endLine?: number;      // 1-based
    endColumn?: number;    // 1-based
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    source?: string;
}

/**
 * Built-in matcher presets. Reference syntax in `output.diagnostics`:
 *   - `"$gcc"` — gcc / clang / arm-none-eabi-gcc style (path:line:col: severity: msg)
 *   - `"$tsc"` — TypeScript compiler (path(line,col): error TS####: msg)
 *
 * Adding a new preset: register it here. Matchers should match a SINGLE line
 * (the `$` anchor + per-line iteration is handled by the engine).
 */
export const DIAGNOSTIC_PRESETS: Readonly<Record<string, DiagnosticPattern>> = Object.freeze({
    gcc: {
        // Matches:  src/main.c:42:5: error: 'foo' undeclared
        // Also tolerates clang-style "fatal error", absolute paths, drive letters on Windows.
        pattern: '^(.+?):(\\d+):(\\d+):\\s*(fatal error|error|warning|note|info):\\s*(.+)$',
        file: 1,
        line: 2,
        column: 3,
        severity: 4,
        message: 5,
        defaultSeverity: 'error',
        source: 'gcc'
    },
    tsc: {
        // Matches:  src/foo.ts(42,5): error TS2304: Cannot find name 'bar'.
        // The TS#### code is folded into the message so users see it in Problems.
        pattern: '^(.+?)\\((\\d+),(\\d+)\\):\\s*(error|warning|info)\\s+TS\\d+:\\s*(.+)$',
        file: 1,
        line: 2,
        column: 3,
        severity: 4,
        message: 5,
        defaultSeverity: 'error',
        source: 'tsc'
    }
});

/**
 * Resolve a single matcher entry — either an inline `DiagnosticPattern` or a
 * preset shorthand string like `"$gcc"`. Throws on unknown preset so config
 * errors surface immediately rather than silently dropping diagnostics.
 */
export function resolveDiagnosticMatcher(entry: DiagnosticPattern | string): DiagnosticPattern {
    if (typeof entry === 'string') {
        if (!entry.startsWith('$')) {
            throw new Error(
                `Diagnostic preset reference '${entry}' must start with '$' (e.g. '$gcc').`
            );
        }
        const name = entry.slice(1);
        const preset = DIAGNOSTIC_PRESETS[name];
        if (!preset) {
            const available = Object.keys(DIAGNOSTIC_PRESETS).map(k => `$${k}`).sort().join(', ');
            throw new Error(
                `Unknown diagnostic preset '${entry}'. Available: ${available}.`
            );
        }
        return preset;
    }
    if (!entry || typeof entry !== 'object') {
        throw new Error('Diagnostic matcher entry must be a preset string or an object.');
    }
    return entry;
}

/**
 * Normalize a captured severity token into one of the four VS Code severity
 * buckets. Accepts common variants from gcc / clang / tsc / msvc, etc.
 *
 * Unrecognized text returns `undefined` so the caller can fall back to the
 * pattern's `defaultSeverity` rather than guessing.
 */
export function normalizeSeverity(
    raw: string | undefined
): 'error' | 'warning' | 'info' | 'hint' | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const t = raw.trim().toLowerCase();
    if (t === 'error' || t === 'fatal' || t === 'fatal error') {
        return 'error';
    }
    if (t === 'warning' || t === 'warn') {
        return 'warning';
    }
    if (t === 'info' || t === 'information' || t === 'note') {
        return 'info';
    }
    if (t === 'hint') {
        return 'hint';
    }
    return undefined;
}

/**
 * Read a numeric capture group as a positive integer, returning `undefined`
 * when the group is absent / empty / non-numeric. Used for line / column /
 * end-line / end-column where partial info is acceptable.
 */
function readPositiveInt(match: RegExpMatchArray, group: number | undefined): number | undefined {
    if (group === undefined) {
        return undefined;
    }
    if (group < 1 || group >= match.length) {
        return undefined;
    }
    const raw = match[group];
    if (typeof raw !== 'string' || raw.length === 0) {
        return undefined;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function compileMatcher(p: DiagnosticPattern): RegExp {
    let flags = p.flags ?? '';
    // We iterate lines ourselves; the `g` flag would interfere with
    // `String.prototype.match` returning groups on the first hit, so strip
    // it if the user added it. `m` is harmless and sometimes useful.
    flags = flags.replace(/g/g, '');
    try {
        return new RegExp(p.pattern, flags);
    } catch (e: any) {
        throw new Error(`Diagnostic pattern has invalid regex: ${e.message}`);
    }
}

function validatePattern(p: DiagnosticPattern): void {
    const required: Array<[string, number | undefined]> = [
        ['file', p.file],
        ['line', p.line],
        ['message', p.message]
    ];
    for (const [name, value] of required) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw new Error(
                `Diagnostic pattern is missing or has invalid '${name}' (must be a positive integer capture group index).`
            );
        }
    }
}

/**
 * Run one or more matcher patterns across a task's full output and return a
 * flat list of `ParsedDiagnostic` records. The output is split on `\r?\n`
 * and each pattern is applied to each line independently — multiple patterns
 * can produce diagnostics for the same line, and each line can produce at
 * most one diagnostic per pattern.
 *
 * Returns `[]` for an undefined / null / empty config so callers can skip the
 * extension-side DiagnosticCollection update path entirely.
 *
 * Throws on configuration errors (unknown preset, invalid regex, missing
 * required group) so the user sees the misconfiguration the first time the
 * task runs rather than silently getting no diagnostics.
 */
export function applyDiagnosticMatchers(
    output: string,
    config: DiagnosticConfig | undefined
): ParsedDiagnostic[] {
    if (config === undefined || config === null) {
        return [];
    }
    const entries = Array.isArray(config) ? config : [config];
    if (entries.length === 0) {
        return [];
    }

    const compiled: Array<{ pattern: DiagnosticPattern; re: RegExp }> = [];
    for (const entry of entries) {
        const pattern = resolveDiagnosticMatcher(entry);
        validatePattern(pattern);
        compiled.push({ pattern, re: compileMatcher(pattern) });
    }

    const lines = output.split(/\r?\n/);
    const results: ParsedDiagnostic[] = [];

    for (const line of lines) {
        if (line.length === 0) {
            continue;
        }
        for (const { pattern, re } of compiled) {
            const m = line.match(re);
            if (!m) {
                continue;
            }
            // file / line / message are required and validated above; if the
            // matched groups are out of range or empty we silently skip
            // rather than crash the whole pipeline (compiler output edge
            // case where the regex matches but groups are empty).
            const file = pattern.file < m.length ? m[pattern.file] : undefined;
            const lineNum = readPositiveInt(m, pattern.line);
            const message = pattern.message < m.length ? m[pattern.message] : undefined;
            if (!file || lineNum === undefined || !message) {
                continue;
            }
            const severityRaw =
                pattern.severity !== undefined && pattern.severity < m.length
                    ? m[pattern.severity]
                    : undefined;
            const severity =
                normalizeSeverity(severityRaw) ?? pattern.defaultSeverity ?? 'error';
            results.push({
                file,
                line: lineNum,
                column: readPositiveInt(m, pattern.column),
                endLine: readPositiveInt(m, pattern.endLine),
                endColumn: readPositiveInt(m, pattern.endColumn),
                severity,
                message,
                source: pattern.source
            });
        }
    }

    return results;
}
