/**
 * Parser for SFR (Special Function Register) bit field comments
 * Extracts bit position, access type, reset value, and description from C/C++ comments
 */

/**
 * Parsed bit field information from comment
 */
export interface BitFieldInfo {
    /** Bit position (e.g., "0" or "12:10") */
    bitPosition: string;
    /** Start bit index (e.g., 0 or 10) */
    bitStart: number;
    /** End bit index (e.g., 0 or 12) */
    bitEnd: number;
    /** Number of bits in this field */
    bitWidth: number;
    /** Access type (e.g., "RW1C", "RO", "WO") */
    accessType: string;
    /** Reset/initial value (e.g., "0x0", "0x7") */
    resetValue: string;
    /** Numeric reset value */
    resetValueNumeric: number | null;
    /** Exact decimal reset value when it does not fit a safe Number. JSON-safe for hover candidate comparison. */
    resetValueExact?: string;
    /** Bit field description */
    description: string;
}

export const SFR_MAX_BITS = 64;

/** Validate before allocating a mask or padding a binary string. */
export function isValidSfrBitRange(bitStart: number, bitEnd: number, bitWidth = bitEnd - bitStart + 1): boolean {
    return Number.isInteger(bitStart) && Number.isInteger(bitEnd) && Number.isInteger(bitWidth)
        && bitStart >= 0 && bitEnd < SFR_MAX_BITS && bitStart <= bitEnd
        && bitWidth === bitEnd - bitStart + 1;
}

/**
 * Parse SFR bit field comment
 * Format: // [bit_pos] [ACCESS_TYPE][reset_val] Description
 * Example: // [0] [RW1C][0x0] Test interrupt 1
 * Example: // [12:10][RW1C][0x7] Test field 0
 */
export function parseBitFieldComment(comment: string): BitFieldInfo | null {
    // Remove leading '//' and trim
    const cleaned = comment.replace(/^\/\/\s*/, '').trim();

    // Pattern: [bit_pos] [ACCESS_TYPE][reset_val] Description
    // Match: [0] [RW1C][0x0] Test interrupt 1
    // Match: [12:10][RW1C][0x7] Test field 0
    const pattern = /^\[([^\]]+)\]\s*\[([^\]]+)\]\[([^\]]+)\]\s*(.+)$/;
    const match = cleaned.match(pattern);

    if (!match) {
        return null;
    }

    const bitPos = match[1].trim();
    const accessType = match[2].trim();
    const resetValue = match[3].trim();
    const description = match[4].trim();

    // Parse bit position
    let bitStart: number;
    let bitEnd: number;

    if (!/^\d+(?:\s*:\s*\d+)?$/.test(bitPos)) { return null; }
    if (bitPos.includes(':')) {
        // Range format: "12:10"
        const [endStr, startStr] = bitPos.split(':').map(s => s.trim());
        bitStart = Number(startStr);
        bitEnd = Number(endStr);
    } else {
        // Single bit: "0"
        bitStart = Number(bitPos);
        bitEnd = bitStart;
    }

    // Validate bit positions
    if (!isValidSfrBitRange(bitStart, bitEnd)) {
        return null;
    }

    const bitWidth = bitEnd - bitStart + 1;

    // Parse reset value
    const reset = parseResetValue(resetValue);
    const resetValueNumeric = reset !== null && reset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reset) : null;

    return {
        bitPosition: bitPos,
        bitStart,
        bitEnd,
        bitWidth,
        accessType,
        resetValue,
        resetValueNumeric,
        ...(reset !== null && resetValueNumeric === null ? { resetValueExact: reset.toString() } : {}),
        description
    };
}

/**
 * Parse reset value from various formats
 * Supports: 0x0, 0xFF, 0b1010, 255
 */
function parseResetValue(value: string): bigint | null {
    // 64-bit binary with digit separators needs at most 129 characters.
    if (value.length > 256 || !/^(?:0[xX][\da-fA-F](?:'?[\da-fA-F])*|0[bB][01](?:'?[01])*|\d(?:'?\d)*)$/.test(value)) {
        return null;
    }
    const integer = BigInt(value.replace(/'/g, ''));
    return integer < (1n << BigInt(SFR_MAX_BITS)) ? integer : null;
}

/**
 * Calculate valid value range for a bit field
 * @param bitWidth Number of bits in the field
 * @returns Object with min and max values
 */
export function calculateValidRange(bitWidth: number): { min: number; max: number | bigint } {
    if (!isValidSfrBitRange(0, bitWidth - 1)) { return { min: 0, max: 0 }; }
    const max = (1n << BigInt(bitWidth)) - 1n;
    return { min: 0, max: max <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(max) : max };
}

/**
 * Calculate an exact bit mask for a bit field (up to 64-bit).
 * Sets all bits in the field to 1
 * @param bitStart Starting bit position (LSB)
 * @param bitEnd Ending bit position (MSB)
 * @returns Number for 32-bit masks, BigInt for masks reaching bit 32 or above
 */
export function calculateBitMask(bitStart: number, bitEnd: number): number | bigint {
    if (!isValidSfrBitRange(bitStart, bitEnd)) {
        return 0;
    }
    const bitWidth = bitEnd - bitStart + 1;
    const mask = ((1n << BigInt(bitWidth)) - 1n) << BigInt(bitStart);
    return bitEnd < 32 ? Number(mask) : mask;
}

/**
 * Parsed bit field declaration from source code
 */
export interface BitFieldDeclaration {
    /** Field name (e.g., "int0_set") */
    fieldName: string;
    /** Bit width from declaration (e.g., 1 from ": 1;") */
    declaredWidth: number;
    /** Line text */
    lineText: string;
    /** Inline comment if present */
    inlineComment: string | null;
}

/**
 * Parse bit field declaration line
 * Format: Type fieldName : bitWidth; // optional comment
 * Example: Type int0_set  : 1; // [0] [RW1C][0x0] Test interrupt 1
 * Example: Type int_field_0 : 3; // [12:10][RW1C][0x7] Test field 0
 */
export function parseBitFieldDeclaration(line: string): BitFieldDeclaration | null {
    // Pattern: Type fieldName : bitWidth;
    // Match before any comment to get the declaration part
    const beforeComment = line.split('//')[0];

    // Pattern: identifier : number;
    // This matches: Type int0_set : 1;
    const pattern = /(\w+)\s*:\s*(\d+)\s*;/;
    const match = beforeComment.match(pattern);

    if (!match) {
        return null;
    }

    const fieldName = match[1];
    const declaredWidth = parseInt(match[2], 10);

    if (!isValidSfrBitRange(0, declaredWidth - 1)) {
        return null;
    }

    // Extract inline comment if present
    const commentParts = line.split('//');
    const inlineComment = commentParts.length > 1 ? '//' + commentParts.slice(1).join('//') : null;

    return {
        fieldName,
        declaredWidth,
        lineText: line,
        inlineComment
    };
}

/**
 * Complete bit field information combining declaration and comment
 */
export interface CompleteBitFieldInfo {
    /** Field name */
    fieldName: string;
    /** Declared bit width */
    declaredWidth: number;
    /** Bit field info from comment (if available) */
    commentInfo: BitFieldInfo | null;
}

/**
 * Extract complete bit field information from a line (or line + preceding comment)
 * @param currentLine Current line containing bit field declaration
 * @param precedingLine Optional preceding line that might contain comment
 * @returns Complete bit field info or null
 */
export function extractBitFieldInfo(
    currentLine: string,
    precedingLine?: string
): CompleteBitFieldInfo | null {
    // Parse the declaration
    const declaration = parseBitFieldDeclaration(currentLine);
    if (!declaration) {
        return null;
    }

    // Try to get comment info from inline comment first
    let commentInfo: BitFieldInfo | null = null;
    if (declaration.inlineComment) {
        commentInfo = parseBitFieldComment(declaration.inlineComment);
    }

    // If no inline comment, try preceding line
    if (!commentInfo && precedingLine) {
        const trimmed = precedingLine.trim();
        if (trimmed.startsWith('//')) {
            commentInfo = parseBitFieldComment(trimmed);
        }
    }

    if (commentInfo && commentInfo.bitWidth !== declaration.declaredWidth) { commentInfo = null; }

    return {
        fieldName: declaration.fieldName,
        declaredWidth: declaration.declaredWidth,
        commentInfo
    };
}

/**
 * Scope information for hierarchy extraction
 */
export interface ScopeInfo {
    /** Scope type: class, struct, union, namespace */
    type: 'class' | 'struct' | 'union' | 'namespace';
    /** Scope name (if available) */
    name: string | null;
    /** Line number where this scope starts */
    lineNumber: number;
}

/**
 * Extract hierarchy from document lines starting from a given line
 * Scans backward to find enclosing class/struct/union scopes
 * @param lines Array of document lines
 * @param startLine Line number to start scanning from (0-based)
 * @returns Array of scope info, from outermost to innermost
 */
export function extractHierarchy(lines: string[], startLine: number): ScopeInfo[] {
    const scopes: ScopeInfo[] = [];
    let braceDepth = 0; // Track brace depth as we scan backward
    const scanLines = sanitizeLinesForScopeScan(lines);

    // Scan backward from startLine
    for (let i = startLine; i >= 0; i--) {
        const line = scanLines[i];

        // When scanning backward, we need to process characters in reverse order too
        for (let j = line.length - 1; j >= 0; j--) {
            const char = line[j];
            if (char === '}') {
                braceDepth++;
            } else if (char === '{') {
                if (braceDepth === 0) {
                    // Found opening brace at current scope level
                    // This is a scope boundary, find its declaration
                    const scopeInfo = findScopeDeclaration(scanLines, i);
                    if (scopeInfo) {
                        scopes.unshift(scopeInfo); // Add to beginning (outermost first)
                    }
                } else {
                    braceDepth--;
                }
            }
        }
    }

    return scopes;
}

function sanitizeLinesForScopeScan(lines: string[]): string[] {
    const sanitized: string[] = [];
    let inBlockComment = false;
    for (const line of lines) {
        let out = '';
        let inString: '"' | '\'' | null = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            const next = i + 1 < line.length ? line[i + 1] : '';
            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    out += '  ';
                    i++;
                } else {
                    out += ' ';
                }
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    out += ' ';
                    i++;
                    if (i < line.length) { out += ' '; }
                    continue;
                }
                if (ch === inString) { inString = null; }
                out += ' ';
                continue;
            }
            if (ch === '/' && next === '/') {
                out += ' '.repeat(line.length - i);
                break;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                out += '  ';
                i++;
                continue;
            }
            if (ch === '"' || ch === '\'') {
                inString = ch;
                out += ' ';
                continue;
            }
            out += ch;
        }
        sanitized.push(out);
    }
    return sanitized;
}

// Patterns for class/struct/union/namespace declarations (module-level to avoid recompilation per call)
// Match: class ClassName {
// Match: struct StructName {
// Match: union UnionName {
// Match: template<...> class ClassName {
const SCOPE_DECLARATION_PATTERNS = [
    { type: 'class' as const, regex: /\bclass\s+(\w+)/g },
    { type: 'struct' as const, regex: /\bstruct\s+(\w+)?/g }, // struct can be anonymous
    { type: 'union' as const, regex: /\bunion\s+(\w+)?/g },   // union can be anonymous
    { type: 'namespace' as const, regex: /\bnamespace\s+(\w+)/g },
];

/**
 * Find scope declaration (class/struct/union) around a given line
 * @param lines Array of document lines
 * @param lineNumber Line number where opening brace was found
 * @returns Scope info or null
 */
function findScopeDeclaration(lines: string[], lineNumber: number): ScopeInfo | null {
    // Check current line and a few lines before for scope declaration
    const searchRange = 5; // Look up to 5 lines back
    const startIdx = Math.max(0, lineNumber - searchRange);

    // Collect lines for analysis
    const relevantLines: string[] = [];
    for (let i = startIdx; i <= lineNumber; i++) {
        relevantLines.push(lines[i]);
    }

    const combinedText = relevantLines.join(' ');

    const patterns = SCOPE_DECLARATION_PATTERNS;

    // Find all matches and use the last (closest) one
    let lastMatch: { type: 'class' | 'struct' | 'union' | 'namespace'; name: string | null } | null = null;
    let lastMatchIndex = -1;

    for (const { type, regex } of patterns) {
        regex.lastIndex = 0; // Reset regex state
        let match;
        while ((match = regex.exec(combinedText)) !== null) {
            const matchIndex = match.index;
            if (matchIndex > lastMatchIndex) {
                lastMatchIndex = matchIndex;
                const name = match[1] || null; // Can be null for anonymous struct/union
                lastMatch = { type, name };
            }
        }
    }

    if (lastMatch) {
        return {
            type: lastMatch.type,
            name: lastMatch.name,
            lineNumber
        };
    }

    return null;
}

/**
 * Access type descriptions mapping
 * Maps access type abbreviations to their full descriptions
 */
const ACCESS_TYPE_DESCRIPTIONS: Record<string, string> = {
    'RO': 'Read Only',
    'WO': 'Write Only',
    'RW': 'Read / Write',
    'RW1C': 'Write 1 to Clear',
    'RW1S': 'Write 1 to Set',
    'W1C': 'Write 1 to Clear',
    'RWC': 'Read / Write Clear',
    'RWS': 'Sticky bit',
};

/**
 * Get the description for an access type abbreviation
 * @param accessType The access type abbreviation (e.g., "RW1C", "RO")
 * @returns Full description or the original string if not found
 */
export function getAccessTypeDescription(accessType: string): string {
    const upperType = accessType.toUpperCase();
    const description = ACCESS_TYPE_DESCRIPTIONS[upperType];
    return description ? `${accessType} (${description})` : accessType;
}

/**
 * Format hierarchy as a qualified name (e.g., "RegTestInt::IntRegSts::int0_set")
 * @param scopes Array of scope info
 * @param fieldName The bit field name
 * @returns Qualified name string
 */
export function formatHierarchy(scopes: ScopeInfo[], fieldName: string): string {
    const parts: string[] = [];

    // Add named scopes
    for (const scope of scopes) {
        if (scope.name) {
            parts.push(scope.name);
        }
    }

    // Add field name
    parts.push(fieldName);

    return parts.join('::');
}
