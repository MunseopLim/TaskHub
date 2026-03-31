/**
 * Parser for GNU linker scripts (.ld) and ARM scatter files (.sct).
 * Extracts memory region definitions (name, origin, size).
 */

import { MemoryRegion } from './elfParser';

/**
 * Parse a size string with optional K/M suffix.
 * Supports: 0x100000, 1M, 256K, 1024, 0x40000
 */
export function parseSizeValue(value: string): number | null {
    const trimmed = value.trim();
    const suffixMatch = trimmed.match(/^(0x[\da-fA-F]+|\d+)\s*([KkMm]?)$/);
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

    // Strategy: first find load regions (top-level, not indented), then
    // find execution regions (indented) inside each load region's braces.
    // Load region pattern: starts at line beginning (no leading whitespace)
    // NAME 0xADDR 0xSIZE {
    const loadRegionRegex = /^(\w+)\s+0x[\da-fA-F]+\s+0x[\da-fA-F]+\s*\{/gm;
    const loadRegionNames = new Set<string>();
    let lrMatch;
    while ((lrMatch = loadRegionRegex.exec(content)) !== null) {
        loadRegionNames.add(lrMatch[1]);
    }

    // Match all regions with: NAME 0xADDR 0xSIZE {
    const allRegionRegex = /(\w+)\s+(0x[\da-fA-F]+)\s+(0x[\da-fA-F]+)\s*\{/gm;
    let match;
    while ((match = allRegionRegex.exec(content)) !== null) {
        const name = match[1];
        // Skip load regions (top-level)
        if (loadRegionNames.has(name)) { continue; }
        const origin = parseSizeValue(match[2]);
        const size = parseSizeValue(match[3]);
        if (origin !== null && size !== null && !seen.has(name)) {
            seen.add(name);
            regions.push({ name, origin, size });
        }
    }

    return regions;
}

/**
 * Auto-detect file type and parse accordingly.
 */
export function parseLinkerFile(content: string, filePath: string): MemoryRegion[] {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.sct')) {
        return parseScatterFile(content);
    }
    // Default to linker script (.ld, .lds, etc.)
    return parseLinkerScript(content);
}
