/**
 * Pure utilities extracted from `extension.ts` for pipeline execution:
 *   - variable interpolation (with sanitation)
 *   - workspace-relative path resolution
 *   - command-line tokenization / shell-argument quoting
 *   - PowerShell / POSIX invocation builders
 *
 * This module has no dependency on the `vscode` API, which makes the helpers
 * easy to unit-test and re-use. Keep anything that needs `vscode.workspace`,
 * `vscode.window`, etc. in `extension.ts`.
 *
 * `extension.ts` re-exports everything here so that existing
 * `import { ... } from './extension'` call sites (including tests) continue to
 * work unchanged.
 */

import * as path from 'path';
import type { OutputCapture } from './schema';

/** Maximum allowed length of a single interpolated value. */
export const INTERPOLATED_VALUE_MAX_LENGTH = 32 * 1024;

/**
 * Predicate used by `executeShellCommand` to decide whether a newly arrived
 * chunk would push the total captured output past the user-configured limit.
 *
 * Pulled out as a standalone helper so that the off-by-one boundary
 * (`currentBytes + chunkBytes > limitBytes`) can be exercised by unit tests
 * without spawning a real subprocess. Keeping it pure also guards against an
 * accidental `>=` → `>` / `>` → `>=` swap during future edits.
 */
export function wouldExceedCaptureLimit(currentBytes: number, chunkBytes: number, limitBytes: number): boolean {
    return currentBytes + chunkBytes > limitBytes;
}

/** Reserved capture names that would shadow built-in task result properties. */
const RESERVED_CAPTURE_NAMES = new Set([
    'output', 'outputDir', 'path', 'dir', 'name', 'fileNameOnly', 'fileExt',
    'value', 'values', 'archivePath', 'confirmed'
]);

/**
 * Apply one or more capture rules to a task's string output and return a map
 * of `{ name: value }` pairs to be merged into the task's result object.
 *
 * This is a pure function — no I/O, no `vscode` dependency — so it can be
 * unit-tested directly. Silently skips rules whose selector does not match
 * and throws only on configuration errors (e.g. missing `name`, invalid
 * regex, reserved name, duplicate name).
 */
export function applyOutputCapture(
    output: string,
    capture: OutputCapture | OutputCapture[] | undefined
): Record<string, string> {
    if (!capture) { return {}; }
    const rules = Array.isArray(capture) ? capture : [capture];
    const results: Record<string, string> = {};

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            throw new Error('Each capture rule must be an object.');
        }
        const name = rule.name;
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error("Capture rule is missing a non-empty 'name'.");
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`Capture name '${name}' must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
        }
        if (RESERVED_CAPTURE_NAMES.has(name)) {
            throw new Error(`Capture name '${name}' is reserved and cannot be used.`);
        }
        if (Object.prototype.hasOwnProperty.call(results, name)) {
            throw new Error(`Duplicate capture name '${name}'.`);
        }

        let selected: string | undefined;

        if (typeof rule.regex === 'string' && rule.regex.length > 0) {
            let re: RegExp;
            try {
                re = new RegExp(rule.regex, rule.flags ?? '');
            } catch (e: any) {
                throw new Error(`Capture '${name}' has invalid regex: ${e.message}`);
            }
            const m = output.match(re);
            if (m) {
                // Default group: 1 if the pattern has capture groups, otherwise 0
                // (full match). Explicit out-of-range group is silently skipped.
                const defaultGroup = m.length > 1 ? 1 : 0;
                const group = rule.group ?? defaultGroup;
                if (group < 0 || group >= m.length) {
                    selected = undefined;
                } else {
                    selected = m[group];
                }
            }
        } else if (typeof rule.line === 'number' && Number.isInteger(rule.line)) {
            const lines = output.split(/\r?\n/);
            const idx = rule.line < 0 ? lines.length + rule.line : rule.line;
            if (idx >= 0 && idx < lines.length) {
                selected = lines[idx];
            }
        } else {
            selected = output;
        }

        if (selected === undefined) { continue; }
        if (rule.trim) { selected = selected.trim(); }
        results[name] = selected;
    }

    return results;
}

/**
 * Resolve `targetPath` and ensure it lands inside one of the provided workspace roots.
 *
 * Security contract:
 *   - null-byte in the path is rejected.
 *   - Relative paths are resolved against `baseDir` (typically the action's
 *     workspace folder) — NOT `process.cwd()`. This keeps behaviour stable
 *     regardless of how VS Code was launched.
 *   - The final resolved path must be inside at least one `workspaceRoots`
 *     entry, otherwise throws.
 */
export function resolveWithinWorkspace(
    targetPath: string,
    workspaceRoots: string[],
    baseDir?: string
): string {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('A file path is required.');
    }
    if (/\x00/.test(targetPath)) {
        throw new Error('File path contains a null byte, which is not allowed.');
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        throw new Error('No workspace folder is available to validate the path.');
    }
    // Relative paths must resolve against the action's workspace, NOT process.cwd().
    // Configs with "filePath": "report.txt" would otherwise land in an arbitrary
    // directory determined by how VS Code was launched.
    let resolved: string;
    if (path.isAbsolute(targetPath)) {
        resolved = path.resolve(targetPath);
    } else {
        const base = baseDir && baseDir.length > 0 ? path.resolve(baseDir) : normalizedRoots[0];
        resolved = path.resolve(base, targetPath);
    }
    const isInside = normalizedRoots.some(root => {
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!isInside) {
        throw new Error(
            `Refusing to access '${resolved}' because it is outside the current workspace folder(s).`
        );
    }
    return resolved;
}

/**
 * Validate and coerce a value about to be substituted into a shell template.
 * Returns `undefined` for null/undefined/objects/arrays (caller should keep
 * the literal `${...}` placeholder). Throws on null byte or length overflow.
 */
export function sanitizeInterpolatedValue(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    let stringValue: string;
    if (typeof value === 'string') {
        stringValue = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        stringValue = String(value);
    } else {
        return undefined;
    }
    if (stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH) {
        throw new Error(
            `Interpolated value exceeds maximum length (${INTERPOLATED_VALUE_MAX_LENGTH} chars).`
        );
    }
    if (/\x00/.test(stringValue)) {
        throw new Error('Interpolated value contains a null byte, which is not allowed.');
    }
    return stringValue;
}

/**
 * Replace `${stepId.property}` / `${stepId}` / `${name}` occurrences in `template`
 * using values from `context`, running each value through `sanitizeInterpolatedValue`.
 * Unknown references are left untouched.
 */
export function interpolatePipelineVariables(template: string, context: any): string {
    if (typeof template !== 'string') { return template; }
    const regex = /\${([^}]+)}/g;
    return template.replace(regex, (match, expression) => {
        let foundValue: any;
        const parts = expression.split('.');
        const stepId = parts[0];
        const property = parts.slice(1).join('.');
        if (context[stepId] && property && context[stepId][property] !== undefined) { foundValue = context[stepId][property]; }
        else if (context[stepId] && context[stepId].output !== undefined) { foundValue = context[stepId].output; }
        else if (context[stepId] && context[stepId].outputDir !== undefined) { foundValue = context[stepId].outputDir; }
        else if (context[expression] !== undefined) { foundValue = context[expression]; }
        const sanitized = sanitizeInterpolatedValue(foundValue);
        if (sanitized !== undefined) { return sanitized; }
        return match;
    });
}

/**
 * Resolve a `command` value which may be a raw string or a per-platform object
 * (`{ windows, macos, linux }`) to a single string for the current platform.
 */
export function getCommandString(command: any): string {
    if (typeof command === 'string') { return command; }
    if (typeof command === 'object' && command !== null) {
        const platform = process.platform;
        if (platform === 'win32' && command.windows) { return command.windows; }
        else if (platform === 'darwin' && command.macos) { return command.macos; }
        else if (platform === 'linux' && command.linux) { return command.linux; }
    }
    throw new Error(`Invalid or unsupported 'command' property for the current platform (${process.platform}). Provide a string or an object with platform-specific entries.`);
}

/**
 * Resolve a `tool` value (string or per-platform object) to a shell-safe command
 * fragment. Adds surrounding double quotes only if the path contains spaces.
 */
export function getToolCommand(tool: any): string {
    let toolCommand: string | undefined;
    if (typeof tool === 'string') {
        toolCommand = tool;
    } else if (typeof tool === 'object' && tool !== null) {
        const platform = process.platform;
        if (platform === 'win32' && tool.windows) { toolCommand = tool.windows; }
        else if (platform === 'darwin' && tool.macos) { toolCommand = tool.macos; }
        else if (platform === 'linux' && tool.linux) { toolCommand = tool.linux; }
    }

    if (!toolCommand) {
        throw new Error(`No tool path specified for the current platform (${process.platform}) in actions.json`);
    }

    // Quote the command if it contains spaces to handle paths like "C:\Program Files\..."
    if (toolCommand.includes(' ') && !toolCommand.startsWith('"')) {
        toolCommand = `"${toolCommand}"`;
    }
    return toolCommand;
}

/**
 * Split a shell-like command string into tokens, respecting single/double
 * quotes. Double-quoted strings support `\"` and `\\` escapes. Note that this
 * is intentionally minimal — it does NOT understand backticks, variable
 * expansion, or operators like `&&`, `|`. It is only used to separate
 * `executable` from `args`; final shell metacharacter handling is deferred to
 * the per-platform quoting helpers below.
 */
export function tokenizeCommandLine(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: string | null = null;

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quoteChar) {
            if (char === quoteChar) {
                quoteChar = null;
            } else if (char === '\\' && quoteChar === '"' && i + 1 < command.length) {
                const next = command[i + 1];
                if (next === '"' || next === '\\') {
                    current += next;
                    i++;
                } else {
                    current += char;
                }
            } else {
                current += char;
            }
        } else if (char === '"' || char === '\'') {
            quoteChar = char;
        } else if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

/**
 * Take a raw command string and extra args, and return the executable as a
 * separate token from the (combined) arg list.
 */
export function mergeCommandAndArgs(command: string, extraArgs: string[]): { executable: string; args: string[] } {
    const baseTokens = tokenizeCommandLine(command.trim());
    if (baseTokens.length === 0) {
        throw new Error('Cannot execute an empty command.');
    }
    const executable = baseTokens[0];
    const initialArgs = baseTokens.slice(1);
    const combinedArgs = [...initialArgs, ...(extraArgs || [])];
    return { executable, args: combinedArgs };
}

/**
 * Single-quote an argument for PowerShell. Inside PowerShell single quotes,
 * everything is literal except another single quote, which is escaped as `''`.
 */
export function quotePowerShellArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build a PowerShell invocation script (`& 'exe' 'arg1' 'arg2'`) plus a
 * display string for logs. When `enforceUtf8Console` is true, the script
 * prepends a `[Console]::OutputEncoding = UTF8` directive.
 */
export function buildPowerShellInvocation(command: string, args: string[], enforceUtf8Console: boolean): { script: string; display: string } {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const quotedExe = quotePowerShellArgument(executable);
    const quotedArgs = combinedArgs.map(arg => quotePowerShellArgument(arg));
    const invocation = `& ${quotedExe}${quotedArgs.length ? ' ' + quotedArgs.join(' ') : ''}`;
    const prefix = enforceUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
    const script = `${prefix}${invocation}`;
    return { script, display: invocation };
}

/** Encode a PowerShell script as UTF-16 LE Base64, suitable for `-EncodedCommand`. */
export function encodePowerShellScript(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Single-quote an argument for POSIX shells (sh/bash/zsh). Inside single
 * quotes, everything is literal except another single quote, which is escaped
 * via the `'\''` idiom.
 */
export function quotePosixArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a POSIX-shell command line (`exe 'arg1' 'arg2'`). The executable is
 * only quoted if it contains a character outside the safe set — keeping
 * pathless names like `npm` readable in logs.
 */
export function buildPosixCommandLine(command: string, args: string[]): string {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const commandPart = /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : quotePosixArgument(executable);
    const parts = [commandPart, ...combinedArgs.map(arg => quotePosixArgument(arg))];
    return parts.join(' ');
}

/**
 * Scheme allowlist for external link opening. `command:` / `file:` / `vscode:`
 * and arbitrary custom schemes are rejected so a malicious links.json cannot
 * invoke VS Code commands or launch OS-registered handlers.
 */
export const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

export type LinkSchemeValidation =
    | { ok: true; scheme: string; url: string }
    | { ok: false; reason: 'empty' | 'invalid' }
    | { ok: false; reason: 'scheme'; scheme: string };

/**
 * Validate a raw URL string against {@link ALLOWED_LINK_SCHEMES}. Kept free of
 * any `vscode` dependency so it can be unit-tested directly.
 */
export function validateLinkScheme(rawUrl: unknown): LinkSchemeValidation {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return { ok: false, reason: 'empty' };
    }
    // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    const match = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rawUrl);
    if (!match) {
        return { ok: false, reason: 'invalid' };
    }
    const scheme = match[1].toLowerCase();
    if (!ALLOWED_LINK_SCHEMES.has(scheme)) {
        return { ok: false, reason: 'scheme', scheme };
    }
    return { ok: true, scheme, url: rawUrl };
}

/**
 * Resolve a favorite entry's path to an absolute path that is guaranteed to
 * live inside one of the current workspace roots. Throws (via
 * {@link resolveWithinWorkspace}) when the path escapes the workspace — even
 * if the user hand-crafted `.vscode/favorites.json` with `../` traversal or
 * an absolute path to elsewhere on disk.
 */
export function resolveFavoriteFilePath(
    rawPath: string,
    workspaceFolderPath: string,
    workspaceRoots: string[]
): string {
    const interpolated = rawPath.replace('${workspaceFolder}', workspaceFolderPath || '');
    return resolveWithinWorkspace(interpolated, workspaceRoots, workspaceFolderPath || undefined);
}

/**
 * Convert an absolute file path to a `${workspaceFolder}`-relative form when
 * the file lives inside the given workspace root. Returns the original path
 * otherwise. Used so that favorites / links stored in `.vscode/*.json` stay
 * portable across machines (the schema already documents this as the
 * preferred form; see favorites_example.json).
 *
 * Output always uses POSIX-style separators (`/`) to keep the serialized
 * JSON stable across Windows/macOS/Linux collaborators.
 */
export function toWorkspaceRelativePath(absolutePath: string, workspaceFolderPath: string | undefined): string {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
        return absolutePath;
    }
    if (!workspaceFolderPath) {
        return absolutePath;
    }
    const normalizedRoot = path.resolve(workspaceFolderPath);
    const normalizedTarget = path.resolve(absolutePath);
    const rel = path.relative(normalizedRoot, normalizedTarget);
    if (rel === '' ) {
        return '${workspaceFolder}';
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return absolutePath;
    }
    return '${workspaceFolder}/' + rel.split(path.sep).join('/');
}

/**
 * Normalize line endings of `content` according to `eol`.
 *   - `lf`   : every CRLF becomes LF (lone CRs are left alone).
 *   - `crlf` : every LF becomes CRLF. Existing CRLF sequences are preserved
 *              (we collapse to LF first so we never emit CRCRLF).
 *   - `keep` : content is returned unchanged.
 * Anything else is treated as `keep`.
 */
export function normalizeEol(content: string, eol: 'lf' | 'crlf' | 'keep' | undefined): string {
    if (eol === 'lf') { return content.replace(/\r\n/g, '\n'); }
    if (eol === 'crlf') { return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
    return content;
}

/**
 * Encode `content` into a Buffer for `writeFile` / `appendFile`.
 *   - `utf8`    : plain UTF-8 bytes, no BOM.
 *   - `utf8bom` : UTF-8 bytes prefixed with the 3-byte BOM (EF BB BF). When
 *                 `includeBom` is false (e.g. append to an existing file) the
 *                 BOM is omitted so we do not plant a BOM mid-file.
 *   - `ascii`   : Node's `ascii` encoding; non-ASCII characters get replaced
 *                 by `?` — callers should validate inputs if that matters.
 */
export function encodeFileContent(
    content: string,
    encoding: 'utf8' | 'utf8bom' | 'ascii' | undefined,
    includeBom: boolean = true
): Buffer {
    if (encoding === 'ascii') {
        return Buffer.from(content, 'ascii');
    }
    if (encoding === 'utf8bom') {
        const utf8 = Buffer.from(content, 'utf8');
        return includeBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8;
    }
    return Buffer.from(content, 'utf8');
}

/**
 * Race `promise` against a timer of `timeoutSeconds`. On timeout, rejects with
 * an Error whose message includes `taskId`. When the timer fires, `onTimeout`
 * is invoked so the caller can kick off side-effect cleanup (e.g. terminate a
 * running child process); the original `promise` still runs to completion but
 * its eventual result is discarded. A non-positive or undefined
 * `timeoutSeconds` disables the timeout entirely and returns `promise` as-is.
 *
 * This helper is intentionally free of `vscode` dependencies so it can be
 * unit-tested in isolation. It does NOT silence unhandled rejections from the
 * original promise — callers should attach a catch handler if the task is
 * expected to reject after the timeout.
 */
export function withTaskTimeout<T>(
    promise: Promise<T>,
    timeoutSeconds: number | undefined,
    taskId: string,
    onTimeout?: () => void
): Promise<T> {
    if (!timeoutSeconds || timeoutSeconds <= 0 || !Number.isFinite(timeoutSeconds)) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) { return; }
            settled = true;
            try { onTimeout?.(); } catch { /* swallow — best effort */ }
            reject(new Error(`Task '${taskId}' timed out after ${timeoutSeconds}s.`));
        }, timeoutSeconds * 1000);
        promise.then(
            value => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
        // Swallow unhandled rejection if the task settles *after* a timeout.
        // We already surfaced the timeout error above; the original error is
        // just noise at that point.
        promise.catch(() => { /* already reported via timeout */ });
    });
}
