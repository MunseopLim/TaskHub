/**
 * Parser for GNU linker scripts (.ld) and ARM scatter files (.sct).
 * Extracts memory region definitions (name, origin, size).
 *
 * Error contract:
 *   - Parse helpers return recognized regions without throwing on malformed
 *     input. Use {@link parseLinkerFileWithDiagnostics} to detect incomplete
 *     results before treating extracted regions as a complete memory map.
 *   - `parseSizeValue` returns `null` for unparseable input rather than NaN.
 */

import { MemoryRegion } from './elfParser';

/**
 * Result shape for diagnostic-aware parsing.
 * `incomplete` diagnostics mean extracted regions must not be used as a complete
 * map. `note` diagnostics describe checks outside region extraction. `warnings`
 * keeps the incomplete-result messages for callers of the original API.
 */
export interface LinkerParseResult {
    regions: MemoryRegion[];
    warnings: string[];
    diagnostics: LinkerParseDiagnostic[];
}

export interface LinkerParseDiagnostic {
    kind: 'incomplete' | 'note';
    code: 'empty-input' | 'gnu-memory' | 'scatter-header' | 'scatter-address'
        | 'scatter-attribute' | 'scatter-structure' | 'duplicate-region'
        | 'scatter-assert' | 'scatter-preprocessor';
    message: string;
    regionName?: string;
}

function linkerParseResult(regions: MemoryRegion[], diagnostics: LinkerParseDiagnostic[]): LinkerParseResult {
    return {
        regions,
        warnings: diagnostics.filter(diagnostic => diagnostic.kind === 'incomplete').map(diagnostic => diagnostic.message),
        diagnostics,
    };
}

/**
 * Parse a size string with optional K/M suffix.
 * Supports: 0x100000, 1M, 256K, 1024, 0x40000
 */
export function parseSizeValue(value: string): number | null {
    const trimmed = value.trim();
    const suffixMatch = trimmed.match(/^\+?(0[xX][\da-fA-F]+|\d+)\s*([KkMm]?)$/);
    if (!suffixMatch) { return null; }

    let num: number;
    const raw = suffixMatch[1];
    if (raw.toLowerCase().startsWith('0x')) {
        num = parseInt(raw, 16);
    } else {
        num = parseInt(raw, 10);
    }
    if (!Number.isSafeInteger(num)) { return null; }

    const suffix = suffixMatch[2].toUpperCase();
    if (suffix === 'K') { num *= 1024; }
    if (suffix === 'M') { num *= 1024 * 1024; }

    return Number.isSafeInteger(num) ? num : null;
}

/** Evaluate a bounded subset of GNU ld constant arithmetic without executing code. */
export function parseLinkerConstantExpression(expression: string): number | null {
    if (expression.length > 4096) { return null; }
    const tokens = expression.match(/0[xX][\da-fA-F]+[KkMm]?|\d+[KkMm]?|[()+*/%\-]/g) ?? [];
    if (tokens.length > 256 || tokens.join('') !== expression.replace(/\s/g, '')) { return null; }
    let position = 0;
    const primary = (): number | null => {
        const token = tokens[position++];
        if (token === '+' || token === '-') {
            const value = primary();
            return value === null ? null : token === '-' ? -value : value;
        }
        if (token === '(') {
            const value = sum();
            return tokens[position++] === ')' ? value : null;
        }
        if (token === undefined) { return null; }
        if (/^0\d/u.test(token)) {
            const octal = token.match(/^(0[0-7]+)([KkMm]?)$/u);
            if (!octal) { return null; }
            const scale = octal[2].toUpperCase() === 'K' ? 1024 : octal[2].toUpperCase() === 'M' ? 1024 * 1024 : 1;
            const value = parseInt(octal[1], 8) * scale;
            return Number.isSafeInteger(value) ? value : null;
        }
        return parseSizeValue(token);
    };
    const product = (): number | null => {
        let value = primary();
        while (['*', '/', '%'].includes(tokens[position])) {
            const operator = tokens[position++];
            const right = primary();
            if (value === null || right === null || ((operator === '/' || operator === '%') && right === 0)) {
                return null;
            }
            value = operator === '*' ? value * right : operator === '/' ? Math.trunc(value / right) : value % right;
            if (!Number.isSafeInteger(value)) { return null; }
        }
        return value;
    };
    const sum = (): number | null => {
        let value = product();
        while (tokens[position] === '+' || tokens[position] === '-') {
            const operator = tokens[position++];
            const right = product();
            if (value === null || right === null) { return null; }
            value = operator === '+' ? value + right : value - right;
            if (!Number.isSafeInteger(value)) { return null; }
        }
        return value;
    };
    const value = sum();
    return position === tokens.length && value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseGnuMemory(content: string): LinkerParseResult {
    const regions: MemoryRegion[] = [];
    const warnings: string[] = [];
    // GNU ld recognizes /* */ comments, not //. Quoted file names may contain
    // either sequence and even text resembling MEMORY, so mask them atomically.
    const source = content.replace(/"[^"]*"|\/\*[\s\S]*?(?:\*\/|$)/g,
        token => token.startsWith('"') ? '""' : ' ');
    const blocks = [...source.matchAll(/\bMEMORY\s*\{([^}]*)\}/g)];
    if (blocks.length === 0) {
        return linkerParseResult(regions, [{ kind: 'incomplete', code: 'gnu-memory', message: 'Linker script contains no complete MEMORY { ... } block.' }]);
    }
    if ([...source.matchAll(/\bMEMORY\s*\{/g)].length !== blocks.length) {
        warnings.push('An incomplete MEMORY block was found.');
    }
    for (const blockMatch of blocks) {
        const block = blockMatch[1];
        const headers = [...block.matchAll(/\b([A-Za-z_][\w.-]*)\s*(?:\([^)]*\))?\s*:/g)];
        if (headers.length === 0 || block.slice(0, headers[0]?.index).trim()) {
            warnings.push('MEMORY block contains no region lines or unsupported content.');
        }
        for (let index = 0; index < headers.length; index++) {
            const header = headers[index];
            const name = header[1];
            const declaration = block.slice(header.index! + header[0].length, headers[index + 1]?.index)
                .trim().replace(/;\s*$/, '').trim();
            const fields = declaration.match(/^(?:ORIGIN|org|o)\s*=\s*([\s\S]+?)\s*,\s*(?:LENGTH|len|l)\s*=\s*([\s\S]+)$/);
            const origin = fields ? parseLinkerConstantExpression(fields[1]) : null;
            const size = fields ? parseLinkerConstantExpression(fields[2]) : null;
            if (origin === null || size === null || !Number.isSafeInteger(origin + size)) {
                warnings.push(`MEMORY region "${name}" has an unsupported or invalid ORIGIN/LENGTH expression.`);
                continue;
            }
            if (regions.some(region => region.name === name)) {
                warnings.push(`MEMORY region "${name}" is declared more than once.`);
                continue;
            }
            regions.push({ name, origin, size });
        }
    }
    return linkerParseResult(regions, warnings.map(message => ({ kind: 'incomplete', code: 'gnu-memory', message })));
}

/** Parse GNU ld MEMORY regions. Use parseLinkerFileWithDiagnostics to detect partial results. */
export function parseLinkerScript(content: string): MemoryRegion[] {
    return parseGnuMemory(content).regions;
}

/**
 * Parse ARM scatter file (.sct) execution regions.
 *
 * Expected format:
 *   LR_IROM1 0x08000000 0x00100000 {
 *     ER_IROM1 0x08000000 0x00100000 { ... }
 *     RW_IRAM1 0x20000000 0x00040000 { ... }
 *   }
 *
 * We extract the execution regions (2nd level) as memory regions.
 */
export function parseScatterFile(content: string): MemoryRegion[] {
    return parseScatterFileInternal(content, []);
}

interface ScatterHeader {
    name: string;
    origin: number | null;
    relative: boolean;
    size: number | null;
}

/** ARM's grammar places attributes before the optional max_size, never after it. */
function parseScatterHeader(
    header: string,
    isLoad: boolean,
    diagnostics: LinkerParseDiagnostic[]
): ScatterHeader | undefined {
    const match = header.match(/^([A-Za-z_]\w*)\s+(\+\s*)?(\S+)(?:\s+([\s\S]*))?$/u);
    if (!match) {
        diagnostics.push({ kind: 'incomplete', code: 'scatter-header', message: 'Scatter region declaration could not be parsed.' });
        return undefined;
    }
    const [, name, relative, address, tail = ''] = match;
    const tokens = tail.trim() ? tail.trim().split(/\s+/u) : [];
    // These attributes do not change the declared execution address or capacity.
    // PI/RELOC permit relocation; ALIGN/EMPTY/OVERLAY need additional layout rules.
    const allowed = isLoad ? ['ABSOLUTE', 'NOCOMPRESS'] : ['ABSOLUTE', 'FIXED', 'NOCOMPRESS', 'UNINIT'];
    const attributes = new Set<string>();
    while (tokens.length > 0 && allowed.includes(tokens[0])) {
        const attribute = tokens.shift()!;
        if (attributes.has(attribute)) {
            diagnostics.push({ kind: 'incomplete', code: 'scatter-attribute', regionName: name,
                message: `Scatter region "${name}" repeats the ${attribute} attribute.` });
            return undefined;
        }
        attributes.add(attribute);
    }
    const size = tokens.length === 1 ? parseSizeValue(tokens[0]) : null;
    const origin = parseSizeValue(address);
    if (tokens.length > 1 || (tokens.length === 1 && size === null) || (!isLoad && tokens.length === 0)) {
        diagnostics.push({ kind: 'incomplete', code: 'scatter-header', regionName: name,
            message: `Scatter region "${name}" has unsupported attributes, an invalid size, or no explicit execution capacity.` });
        return undefined;
    }
    if (origin === null || (size !== null && !Number.isSafeInteger(origin + size))) {
        diagnostics.push({ kind: 'incomplete', code: 'scatter-address', regionName: name,
            message: `Scatter region "${name}" has an unsupported origin or size.` });
    }
    return { name, origin, relative: relative !== undefined, size };
}

function parseScatterFileInternal(content: string, diagnostics: LinkerParseDiagnostic[]): MemoryRegion[] {
    const regions: MemoryRegion[] = [];
    const seen = new Map<string, MemoryRegion>();
    // Preserve quoted selectors while removing comments: neither semicolons nor
    // braces inside a quoted object path are structural scatter syntax.
    const source = content.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?(?:\*\/|$)|;[^\n]*|\/\/[^\n]*/g,
        token => token.startsWith('"') ? token : token.replace(/[^\n]/g, ' '));
    let braceDepth = 0;
    let currentLoadOrigin: number | null = null;
    let loadCount = 0;
    let executionCount = 0;
    let pending = '';
    let pendingHasContent = false;
    let quoted = false;
    let hasAssertNote = false;
    let hasPreprocessorDiagnostic = false;
    for (let index = 0; index < source.length; index++) {
        const ch = source[index];
        if (quoted && ch === '\\') {
            if (braceDepth <= 1) { pending += ch + (source[index + 1] ?? ''); }
            index++;
            continue;
        }
        if (ch === '"') { quoted = !quoted; }
        if (quoted || ch === '"') {
            if (braceDepth <= 1) {
                pending += ch;
                pendingHasContent = true;
            }
            continue;
        }
        // A preprocessor can add/remove regions even when this file's numeric
        // headers look complete. Do not classify its directives as harmless notes.
        if (ch === '#' && !source.slice(source.lastIndexOf('\n', index - 1) + 1, index).trim()) {
            if (!hasPreprocessorDiagnostic) {
                diagnostics.push({ kind: 'incomplete', code: 'scatter-preprocessor',
                    message: 'Scatter preprocessing directives are not evaluated. Use preprocessed input or an ARM linker listing.' });
                hasPreprocessorDiagnostic = true;
            }
            const lineEnd = source.indexOf('\n', index);
            index = lineEnd < 0 ? source.length : lineEnd;
            continue;
        }
        // ScatterAssert is legal at top level and within a load region. Its
        // expression checks a completed link; it never declares a memory region.
        if (braceDepth <= 1 && !pendingHasContent && source.startsWith('ScatterAssert', index)) {
            const start = /^ScatterAssert\s*\(/u.exec(source.slice(index));
            if (start) {
                const expressionStart = index + start[0].length;
                let cursor = expressionStart;
                let depth = 1;
                for (; cursor < source.length && depth > 0; cursor++) {
                    if (source[cursor] === '{' || source[cursor] === '}') { break; }
                    if (source[cursor] === '(') { depth++; }
                    if (source[cursor] === ')') { depth--; }
                }
                if (depth !== 0 || !source.slice(expressionStart, cursor - 1).trim()) {
                    diagnostics.push({ kind: 'incomplete', code: 'scatter-structure',
                        message: 'ScatterAssert has an empty expression or unclosed parentheses.' });
                } else {
                    if (!hasAssertNote) {
                        diagnostics.push({ kind: 'note', code: 'scatter-assert',
                            message: 'ScatterAssert expressions were not evaluated; the declared memory regions are still available.' });
                        hasAssertNote = true;
                    }
                    index = cursor - 1;
                    pending = '';
                    pendingHasContent = false;
                    continue;
                }
            }
        }
        if (ch === '{') {
            if (braceDepth <= 1) {
                const isLoad = braceDepth === 0;
                const header = parseScatterHeader(pending.trim(), isLoad, diagnostics);
                if (isLoad) {
                    currentLoadOrigin = header?.origin ?? null;
                    if (header?.relative && loadCount > 0) {
                        currentLoadOrigin = null;
                        diagnostics.push({ kind: 'incomplete', code: 'scatter-address', regionName: header.name,
                            message: `Scatter load region "${header.name}" depends on the preceding region's linked length.` });
                    }
                    loadCount++;
                    executionCount = 0;
                } else {
                    if (header) {
                        let origin = header.origin;
                        if (header.relative) {
                            // max_size is a capacity, not the actual linked size.
                            // Only the first execution region has a known base.
                            origin = executionCount > 0 || currentLoadOrigin === null || origin === null
                                ? null : currentLoadOrigin + origin;
                        }
                        if (origin === null || header.size === null || !Number.isSafeInteger(origin + header.size)) {
                            diagnostics.push({ kind: 'incomplete', code: 'scatter-address', regionName: header.name,
                                message: `Scatter execution region "${header.name}" has an unresolved origin or size; relative successors require the linked length.` });
                        } else {
                            const previous = seen.get(header.name);
                            if (!previous) {
                                const region = { name: header.name, origin, size: header.size };
                                seen.set(header.name, region);
                                regions.push(region);
                            } else if (previous.origin !== origin || previous.size !== header.size) {
                                diagnostics.push({ kind: 'incomplete', code: 'duplicate-region', regionName: header.name,
                                    message: `Scatter execution region "${header.name}" is declared more than once with different addresses or sizes.` });
                            }
                        }
                    }
                    executionCount++;
                }
            } else {
                diagnostics.push({ kind: 'incomplete', code: 'scatter-structure', message: 'Scatter execution region contains an unexpected nested block.' });
            }
            braceDepth++;
            pending = '';
            pendingHasContent = false;
        } else if (ch === '}') {
            if (braceDepth === 0 || (braceDepth === 1 && pending.trim())) {
                diagnostics.push({ kind: 'incomplete', code: 'scatter-structure',
                    message: 'Scatter file contains an incomplete region declaration or unmatched closing brace.' });
            }
            braceDepth = Math.max(0, braceDepth - 1);
            if (braceDepth === 0) { currentLoadOrigin = null; }
            pending = '';
            pendingHasContent = false;
        } else if (braceDepth <= 1) {
            pending += ch;
            if (/\S/u.test(ch)) { pendingHasContent = true; }
        }
    }
    if (braceDepth !== 0 || pending.trim() || quoted) {
        diagnostics.push({ kind: 'incomplete', code: 'scatter-structure',
            message: 'Scatter file ends with an incomplete region declaration or unclosed block.' });
    }
    return regions;
}

/**
 * Auto-detect file type and parse accordingly.
 *
 * Returns an empty array when no regions can be extracted. Use
 * {@link parseLinkerFileWithDiagnostics} to also obtain warnings that explain
 * why the result might be empty.
 */
export function parseLinkerFile(content: string, filePath: string): MemoryRegion[] {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.sct')) {
        return parseScatterFile(content);
    }
    // Default to linker script (.ld, .lds, etc.)
    return parseLinkerScript(content);
}

/**
 * Same as {@link parseLinkerFile} but also reports warnings about the input.
 *
 * Warnings cover incomplete results and common empty-result cases:
 *   - skipped MEMORY/execution regions or invalid constant expressions
 *   - empty input
 *   - `.ld` file without a `MEMORY { ... }` block
 *   - `.sct` file without any execution regions below a load region
 */
export function parseLinkerFileWithDiagnostics(
    content: string,
    filePath: string
): LinkerParseResult {
    const diagnostics: LinkerParseDiagnostic[] = [];
    if (!content || content.trim().length === 0) {
        return linkerParseResult([], [{ kind: 'incomplete', code: 'empty-input', message: 'Linker script is empty.' }]);
    }

    const lower = filePath.toLowerCase();
    const isScatter = lower.endsWith('.sct');
    if (!isScatter) { return parseGnuMemory(content); }
    const regions = parseScatterFileInternal(content, diagnostics);

    if (regions.length === 0) {
        diagnostics.push({ kind: 'incomplete', code: 'scatter-structure',
            message: 'No execution regions found in scatter file. Expected "NAME 0xADDR 0xSIZE { ... }" lines nested inside a load region.' });
    }

    return linkerParseResult(regions, diagnostics);
}
