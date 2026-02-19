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
    /** Bit field description */
    description: string;
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

    if (bitPos.includes(':')) {
        // Range format: "12:10"
        const [endStr, startStr] = bitPos.split(':').map(s => s.trim());
        bitStart = parseInt(startStr, 10);
        bitEnd = parseInt(endStr, 10);
    } else {
        // Single bit: "0"
        bitStart = parseInt(bitPos, 10);
        bitEnd = bitStart;
    }

    // Validate bit positions
    if (isNaN(bitStart) || isNaN(bitEnd) || bitStart > bitEnd) {
        return null;
    }

    const bitWidth = bitEnd - bitStart + 1;

    // Parse reset value
    const resetValueNumeric = parseResetValue(resetValue);

    return {
        bitPosition: bitPos,
        bitStart,
        bitEnd,
        bitWidth,
        accessType,
        resetValue,
        resetValueNumeric,
        description
    };
}

/**
 * Parse reset value from various formats
 * Supports: 0x0, 0xFF, 0b1010, 255
 */
function parseResetValue(value: string): number | null {
    const cleaned = value.replace(/'/g, ''); // Remove digit separators

    // Hexadecimal: 0x0, 0xFF
    if (/^0[xX][0-9a-fA-F]+$/.test(cleaned)) {
        const num = parseInt(cleaned, 16);
        return isNaN(num) ? null : num;
    }

    // Binary: 0b1010
    if (/^0[bB][01]+$/.test(cleaned)) {
        const binaryPart = cleaned.replace(/^0[bB]/, '');
        const num = parseInt(binaryPart, 2);
        return isNaN(num) ? null : num;
    }

    // Decimal: 255
    if (/^\d+$/.test(cleaned)) {
        const num = parseInt(cleaned, 10);
        return isNaN(num) ? null : num;
    }

    return null;
}

/**
 * Calculate valid value range for a bit field
 * @param bitWidth Number of bits in the field
 * @returns Object with min and max values
 */
export function calculateValidRange(bitWidth: number): { min: number; max: number } {
    return {
        min: 0,
        max: Math.pow(2, bitWidth) - 1
    };
}

/**
 * Calculate bit mask for a bit field (32-bit)
 * Sets all bits in the field to 1
 * @param bitStart Starting bit position (LSB)
 * @param bitEnd Ending bit position (MSB)
 * @returns 32-bit mask value
 */
export function calculateBitMask(bitStart: number, bitEnd: number): number {
    // Validate input range (0-31 for 32-bit registers)
    if (bitStart < 0 || bitEnd > 31 || bitStart > bitEnd) {
        return 0;
    }
    const bitWidth = bitEnd - bitStart + 1;
    // Handle full 32-bit mask correctly (avoid 1 << 32 wrap issue)
    const fieldMask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
    return (fieldMask << bitStart) >>> 0; // Convert to unsigned 32-bit
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

    if (isNaN(declaredWidth) || declaredWidth <= 0) {
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

    // Scan backward from startLine
    for (let i = startLine; i >= 0; i--) {
        const line = lines[i];

        // When scanning backward, we need to process characters in reverse order too
        for (let j = line.length - 1; j >= 0; j--) {
            const char = line[j];
            if (char === '}') {
                braceDepth++;
            } else if (char === '{') {
                if (braceDepth === 0) {
                    // Found opening brace at current scope level
                    // This is a scope boundary, find its declaration
                    const scopeInfo = findScopeDeclaration(lines, i);
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
