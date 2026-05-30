/**
 * Parser for GNU linker scripts (.ld) and ARM scatter files (.sct).
 * Extracts memory region definitions (name, origin, size).
 *
 * Error contract:
 *   - Parse helpers never throw for malformed input; they return an empty
 *     region list instead. Callers that need to distinguish "no matches" from
 *     "structurally invalid" should use {@link parseLinkerFileWithDiagnostics}.
 *   - `parseSizeValue` returns `null` for unparseable input rather than NaN.
 */

import { MemoryRegion } from './elfParser';

/**
 * Result shape for diagnostic-aware parsing.
 * `warnings` is a list of human-readable messages. An empty `warnings` array means
 * the parser did not detect anything suspicious about the input.
 */
export interface LinkerParseResult {
    regions: MemoryRegion[];
    warnings: string[];
}

/**
 * Parse a size string with optional K/M suffix.
 * Supports: 0x100000, 1M, 256K, 1024, 0x40000
 */
export function parseSizeValue(value: string): number | null {
    const trimmed = value.trim();
    const suffixMatch = trimmed.match(/^\+?(0x[\da-fA-F]+|\d+)\s*([KkMm]?)$/);
    if (!suffixMatch) { return null; }

    let num: number;
    const raw = suffixMatch[1];
    if (raw.toLowerCase().startsWith('0x')) {
        num = parseInt(raw, 16);
    } else {
        num = parseInt(raw, 10);
    }
    if (isNaN(num)) { return null; }

    const suffix = suffixMatch[2].toUpperCase();
    if (suffix === 'K') { num *= 1024; }
    if (suffix === 'M') { num *= 1024 * 1024; }

    return num;
}

/**
 * Parse GNU linker script (.ld) MEMORY block.
 *
 * Expected format:
 *   MEMORY
 *   {
 *     NAME (attrs) : ORIGIN = 0x..., LENGTH = 0x...
 *     NAME (attrs) : ORIGIN = 0x..., LENGTH = 256K
 *   }
 */
export function parseLinkerScript(content: string): MemoryRegion[] {
    const regions: MemoryRegion[] = [];

    // Extract MEMORY { ... } block (handle multiline)
    const memoryBlockMatch = content.match(/MEMORY\s*\{([^}]*)\}/s);
    if (!memoryBlockMatch) { return regions; }

    const block = memoryBlockMatch[1];

    // Match each region line:
    //   NAME (attrs) : ORIGIN = value, LENGTH = value
    //   Also supports: org/o for ORIGIN, len/l for LENGTH
    const lineRegex = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*(?:ORIGIN|org|o)\s*=\s*(0x[\da-fA-F]+|\d+)\s*,\s*(?:LENGTH|len|l)\s*=\s*(0x[\da-fA-F]+|\d+[KkMm]?)/gm;

    let match;
    while ((match = lineRegex.exec(block)) !== null) {
        const name = match[1];
        const origin = parseSizeValue(match[2]);
        const size = parseSizeValue(match[3]);
        if (origin !== null && size !== null) {
            regions.push({ name, origin, size });
        }
    }

    return regions;
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
    const regions: MemoryRegion[] = [];
    const seen = new Set<string>();

    let braceDepth = 0;
    let currentLoadOrigin: number | null = null;
    const regionRegex = /^\s*(\w+)\s+(\+?(?:0x[\da-fA-F]+|\d+)|[A-Za-z_]\w*)\s+(\+?(?:0x[\da-fA-F]+|\d+)(?:[KkMm])?|[A-Za-z_][\w$()]*)(?:\s+[^{}]*)?\s*\{/u;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/;.*/, '');
        const depthBefore = braceDepth;
        const match = line.match(regionRegex);
        if (match) {
            const name = match[1];
            let origin = parseSizeValue(match[2]);
            const size = parseSizeValue(match[3]);

            if (match[2].startsWith('+')) {
                // '+offset' origins are relative to the enclosing load region.
                // If that base is unknown (e.g. a symbolic load origin), the
                // absolute address cannot be resolved — mark it unknown so the
                // region is skipped instead of leaking the raw offset as if it
                // were an absolute address.
                const relative = parseSizeValue(match[2]);
                origin = (currentLoadOrigin === null || relative === null)
                    ? null
                    : currentLoadOrigin + relative;
            }

            if (depthBefore === 0) {
                currentLoadOrigin = origin;
            } else if (origin !== null && size !== null) {
                if (!seen.has(name)) {
                    seen.add(name);
                    regions.push({ name, origin, size });
                }
            }
        }

        for (const ch of line) {
            if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
                if (braceDepth === 0) {
                    currentLoadOrigin = null;
                }
            }
        }
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
 * Emitted warnings cover the common "why did I get zero regions?" cases:
 *   - empty input
 *   - `.ld` file without a `MEMORY { ... }` block
 *   - `.sct` file without any execution regions below a load region
 */
export function parseLinkerFileWithDiagnostics(
    content: string,
    filePath: string
): LinkerParseResult {
    const warnings: string[] = [];
    if (!content || content.trim().length === 0) {
        warnings.push('Linker script is empty.');
        return { regions: [], warnings };
    }

    const lower = filePath.toLowerCase();
    const isScatter = lower.endsWith('.sct');
    const regions = isScatter ? parseScatterFile(content) : parseLinkerScript(content);

    if (regions.length === 0) {
        if (isScatter) {
            warnings.push(
                'No execution regions found in scatter file. Expected "NAME 0xADDR 0xSIZE { ... }" lines nested inside a load region.'
            );
        } else if (!/MEMORY\s*\{/.test(content)) {
            warnings.push('Linker script contains no MEMORY { ... } block.');
        } else {
            warnings.push(
                'MEMORY block found but no region lines matched "NAME (attrs) : ORIGIN = ..., LENGTH = ...".'
            );
        }
    }

    return { regions, warnings };
}
