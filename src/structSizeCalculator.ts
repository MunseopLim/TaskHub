/**
 * Struct size calculator with support for padding and alignment
 * Calculates struct/class sizes based on type configuration
 */

/**
 * Type configuration for size and alignment
 */
export interface TypeConfig {
    /** Size in bytes */
    size: number;
    /** Alignment requirement in bytes */
    alignment: number;
}

/**
 * Type configuration file format
 */
export interface TypeConfigFile {
    /** Type definitions with size and alignment */
    types: Record<string, TypeConfig>;
    /** Default struct packing alignment (1, 2, 4, 8) */
    packingAlignment?: number;
}

/**
 * Struct member information
 */
export interface StructMember {
    /** Member name */
    name: string;
    /** Member type */
    type: string;
    /** Offset from struct beginning */
    offset: number;
    /** Member size in bytes */
    size: number;
    /** Alignment requirement */
    alignment: number;
    /** Whether this is an array */
    isArray?: boolean;
    /** Array size if applicable */
    arraySize?: number;
    /** Whether this member is a C/C++ bit-field */
    isBitField?: boolean;
    /** Bit-field width when isBitField is true */
    bitWidth?: number;
    /** Whether this bit-field has no declarator name */
    isAnonymousBitField?: boolean;
    /** Precomputed size for anonymous nested struct/union members */
    fixedSize?: number;
    /** Precomputed alignment for anonymous nested struct/union members */
    fixedAlignment?: number;
}

/**
 * Struct size calculation result
 */
export interface StructSizeResult {
    /** Struct name */
    structName: string;
    /** Total size in bytes (including padding) */
    totalSize: number;
    /** Struct alignment requirement */
    alignment: number;
    /** List of members with offsets */
    members: StructMember[];
    /** Total padding bytes added */
    padding: number;
    /** Whether calculation was successful */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

type AggregateKind = 'struct' | 'class' | 'union';

/**
 * Default type configurations for common C/C++ types
 */
const DEFAULT_TYPE_CONFIG: TypeConfigFile = {
    types: {
        'char': { size: 1, alignment: 1 },
        'signed char': { size: 1, alignment: 1 },
        'unsigned char': { size: 1, alignment: 1 },
        'int8_t': { size: 1, alignment: 1 },
        'uint8_t': { size: 1, alignment: 1 },

        'short': { size: 2, alignment: 2 },
        'short int': { size: 2, alignment: 2 },
        'unsigned short': { size: 2, alignment: 2 },
        'int16_t': { size: 2, alignment: 2 },
        'uint16_t': { size: 2, alignment: 2 },

        'int': { size: 4, alignment: 4 },
        'unsigned int': { size: 4, alignment: 4 },
        'long': { size: 4, alignment: 4 },
        'unsigned long': { size: 4, alignment: 4 },
        'int32_t': { size: 4, alignment: 4 },
        'uint32_t': { size: 4, alignment: 4 },

        'long long': { size: 8, alignment: 8 },
        'unsigned long long': { size: 8, alignment: 8 },
        'int64_t': { size: 8, alignment: 8 },
        'uint64_t': { size: 8, alignment: 8 },

        'float': { size: 4, alignment: 4 },
        'double': { size: 8, alignment: 8 },

        'void*': { size: 4, alignment: 4 },
        'pointer': { size: 4, alignment: 4 },

        // Windows types
        'BYTE': { size: 1, alignment: 1 },
        'CHAR': { size: 1, alignment: 1 },
        'UCHAR': { size: 1, alignment: 1 },
        'UINT8': { size: 1, alignment: 1 },
        'INT8': { size: 1, alignment: 1 },
        'BOOLEAN': { size: 1, alignment: 1 },

        'WORD': { size: 2, alignment: 2 },
        'SHORT': { size: 2, alignment: 2 },
        'USHORT': { size: 2, alignment: 2 },
        'UINT16': { size: 2, alignment: 2 },
        'INT16': { size: 2, alignment: 2 },

        'DWORD': { size: 4, alignment: 4 },
        'LONG': { size: 4, alignment: 4 },
        'ULONG': { size: 4, alignment: 4 },
        'UINT32': { size: 4, alignment: 4 },
        'INT32': { size: 4, alignment: 4 },
        'BOOL': { size: 4, alignment: 4 },

        'QWORD': { size: 8, alignment: 8 },
        'LONGLONG': { size: 8, alignment: 8 },
        'ULONGLONG': { size: 8, alignment: 8 },
        'UINT64': { size: 8, alignment: 8 },
        'INT64': { size: 8, alignment: 8 },
        'DWORD64': { size: 8, alignment: 8 }
    },
    packingAlignment: 8  // Default to natural alignment
};

/**
 * StructSizeCalculator - calculates struct/class sizes with padding
 */
export class StructSizeCalculator {
    private typeConfig: TypeConfigFile;
    private customTypes: Map<string, StructSizeResult> = new Map();

    constructor(typeConfig?: TypeConfigFile) {
        this.typeConfig = typeConfig || DEFAULT_TYPE_CONFIG;
    }

    /**
     * Calculate size of a struct
     * @param structName Name of the struct
     * @param lines Source code lines containing struct definition
     * @param startLine Line where struct starts
     * @returns Size calculation result
     */
    calculateStructSize(
        structName: string,
        lines: string[],
        startLine: number
    ): StructSizeResult {
        try {
            if (startLine < 0 || startLine >= lines.length) {
                return {
                    structName,
                    totalSize: 0,
                    alignment: 1,
                    members: [],
                    padding: 0,
                    success: false,
                    error: 'Struct definition not found'
                };
            }
            const aggregateKind = this.getAggregateKind(lines[startLine]);
            const members = this.parseStructMembers(lines, startLine);

            if (members.length === 0) {
                return {
                    structName,
                    totalSize: 0,
                    alignment: 1,
                    members: [],
                    padding: 0,
                    success: false,
                    error: 'No members found in struct'
                };
            }

            return aggregateKind === 'union'
                ? this.calculateUnionLayout(structName, members)
                : this.calculateLayout(structName, members);
        } catch (error) {
            return {
                structName,
                totalSize: 0,
                alignment: 1,
                members: [],
                padding: 0,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Parse struct members from source code
     */
    private parseStructMembers(lines: string[], startLine: number): StructMember[] {
        const body = this.extractAggregateBody(lines, startLine);
        if (body === null) {
            return [];
        }
        return this.parseMemberStatements(body);
    }

    private extractAggregateBody(lines: string[], startLine: number): string | null {
        let foundOpeningBrace = false;
        let braceDepth = 0;
        let body = '';
        let inBlockComment = false;

        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];
            let inString: '"' | '\'' | null = null;

            for (let ci = 0; ci < line.length; ci++) {
                const ch = line[ci];
                const next = ci + 1 < line.length ? line[ci + 1] : '';

                if (inBlockComment) {
                    if (ch === '*' && next === '/') {
                        inBlockComment = false;
                        ci++;
                    }
                    continue;
                }
                if (inString) {
                    if (foundOpeningBrace && braceDepth > 0) { body += ch; }
                    if (ch === '\\') {
                        ci++;
                        if (foundOpeningBrace && braceDepth > 0 && ci < line.length) { body += line[ci]; }
                        continue;
                    }
                    if (ch === inString) { inString = null; }
                    continue;
                }
                if (ch === '/' && next === '/') {
                    break;
                }
                if (ch === '/' && next === '*') {
                    inBlockComment = true;
                    ci++;
                    continue;
                }
                if (ch === '"' || ch === '\'') {
                    inString = ch;
                    if (foundOpeningBrace && braceDepth > 0) { body += ch; }
                    continue;
                }
                if (ch === '{') {
                    if (foundOpeningBrace && braceDepth > 0) { body += ch; }
                    foundOpeningBrace = true;
                    braceDepth++;
                    continue;
                }
                if (ch === '}') {
                    braceDepth--;
                    if (braceDepth === 0 && foundOpeningBrace) {
                        return body;
                    }
                    if (foundOpeningBrace && braceDepth > 0) { body += ch; }
                    continue;
                }
                if (foundOpeningBrace && braceDepth > 0) {
                    body += ch;
                }
            }
            if (foundOpeningBrace && braceDepth > 0) {
                body += '\n';
            }
        }

        return null;
    }

    private parseMemberStatements(body: string): StructMember[] {
        const members: StructMember[] = [];
        for (const statement of this.splitTopLevelStatements(body)) {
            const trimmed = statement.trim();
            if (!trimmed || /^(public|private|protected)\s*:$/u.test(trimmed)) {
                continue;
            }
            if (this.parseAnonymousAggregateMember(trimmed, members)) {
                continue;
            }
            this.parseDeclarationStatement(trimmed, members);
        }
        return members;
    }

    private splitTopLevelStatements(body: string): string[] {
        const statements: string[] = [];
        let current = '';
        let braceDepth = 0;
        let bracketDepth = 0;
        let inString: '"' | '\'' | null = null;

        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            current += ch;

            if (inString) {
                if (ch === '\\') {
                    i++;
                    if (i < body.length) { current += body[i]; }
                    continue;
                }
                if (ch === inString) { inString = null; }
                continue;
            }
            if (ch === '"' || ch === '\'') {
                inString = ch;
            } else if (ch === '{') {
                braceDepth++;
            } else if (ch === '}') {
                braceDepth = Math.max(0, braceDepth - 1);
            } else if (ch === '[') {
                bracketDepth++;
            } else if (ch === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
            } else if (ch === ';' && braceDepth === 0 && bracketDepth === 0) {
                statements.push(current.slice(0, -1));
                current = '';
            }
        }
        if (current.trim()) {
            statements.push(current);
        }
        return statements;
    }

    private parseAnonymousAggregateMember(statement: string, members: StructMember[]): boolean {
        const aggregateMatch = statement.match(/^\s*(struct|union)\b/u);
        if (!aggregateMatch || !statement.includes('{')) {
            return false;
        }
        const openIdx = statement.indexOf('{');
        const closeIdx = this.findMatchingBraceInText(statement, openIdx);
        if (closeIdx < 0) {
            return false;
        }
        const tail = statement.slice(closeIdx + 1).trim();
        const kind = aggregateMatch[1] as AggregateKind;
        const nestedBody = statement.slice(openIdx + 1, closeIdx);
        const nestedMembers = this.parseMemberStatements(nestedBody);
        if (nestedMembers.length === 0) {
            return false;
        }

        // Resolve the declarator after the closing brace:
        //   `} name;` / `} name[2];` → named nested member
        //   `};`                     → C11 anonymous struct/union member. gcc/clang
        //                              lay it out as a sub-object at the parent's
        //                              next slot (same size/alignment as a named
        //                              nested member); only the field NAMES are
        //                              injected for access, which does not affect
        //                              sizeof. Without this branch the whole block
        //                              was dropped, undersizing the struct.
        let nestedName: string;
        let arraySize: number | undefined;
        if (tail === '') {
            nestedName = `<anonymous ${kind}>`;
            arraySize = undefined;
        } else {
            const memberMatch = tail.match(/^(\w+)(?:\[(0[xX][\da-fA-F]+|\d+)\])?$/u);
            if (!memberMatch) {
                return false;
            }
            nestedName = memberMatch[1];
            arraySize = this.parseArraySize(memberMatch[2]);
        }

        const nestedResult = kind === 'union'
            ? this.calculateUnionLayout(nestedName, nestedMembers)
            : this.calculateLayout(nestedName, nestedMembers);
        members.push({
            name: nestedName,
            type: `anonymous ${kind}`,
            offset: 0,
            size: 0,
            alignment: 0,
            isArray: arraySize !== undefined,
            arraySize,
            fixedSize: nestedResult.totalSize,
            fixedAlignment: nestedResult.alignment
        });
        return true;
    }

    private findMatchingBraceInText(text: string, openIdx: number): number {
        let depth = 0;
        let inString: '"' | '\'' | null = null;
        for (let i = openIdx; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (ch === '\\') { i++; continue; }
                if (ch === inString) { inString = null; }
                continue;
            }
            if (ch === '"' || ch === '\'') {
                inString = ch;
            } else if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) { return i; }
            }
        }
        return -1;
    }

    private parseDeclarationStatement(statement: string, members: StructMember[]): void {
        if (/[{}]/u.test(statement) || /^\s*(typedef|using)\b/u.test(statement)) {
            return;
        }
        const declarators = this.splitTopLevelCommas(statement);
        let baseType: string | undefined;

        for (let i = 0; i < declarators.length; i++) {
            const part = declarators[i].trim();
            if (!part) { continue; }
            let declarator = part;
            if (i === 0) {
                const first = part.match(/^([\w\s*]+?)\s+((?:\*?\s*\w+(?:\s*\[(?:0[xX][\da-fA-F]+|\d+)\])?(?:\s*:\s*\d+)?)|(?:\s*:\s*\d+))$/u);
                if (!first) { return; }
                baseType = first[1].trim();
                declarator = first[2].trim();
            }
            if (!baseType) { return; }
            const parsed = this.parseDeclarator(baseType, declarator);
            if (parsed) {
                members.push(parsed);
            }
        }
    }

    /**
     * Parse a C array-dimension token, accepting both decimal (`16`) and
     * hexadecimal (`0x10`) sizes — the latter is common in embedded buffers
     * such as `uint8_t buf[0x100];`. Returns undefined for missing/invalid sizes.
     */
    private parseArraySize(text: string | undefined): number | undefined {
        if (text === undefined || text === '') {
            return undefined;
        }
        const n = Number(text);
        return Number.isInteger(n) && n >= 0 ? n : undefined;
    }

    private splitTopLevelCommas(statement: string): string[] {
        const parts: string[] = [];
        let current = '';
        let bracketDepth = 0;
        for (const ch of statement) {
            if (ch === '[') { bracketDepth++; }
            if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); }
            if (ch === ',' && bracketDepth === 0) {
                parts.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        parts.push(current);
        return parts;
    }

    private parseDeclarator(baseType: string, declarator: string): StructMember | null {
        const unnamedBitField = declarator.match(/^:\s*(\d+)$/u);
        if (unnamedBitField) {
            const bitWidth = parseInt(unnamedBitField[1], 10);
            return {
                name: `<anonymous:${bitWidth}>`,
                type: baseType,
                offset: 0,
                size: 0,
                alignment: 0,
                isBitField: true,
                isAnonymousBitField: true,
                bitWidth
            };
        }

        const match = declarator.match(/^(\*?)\s*(\w+)(?:\s*\[(0[xX][\da-fA-F]+|\d+)\])?(?:\s*:\s*(\d+))?$/u);
        if (!match) {
            return null;
        }
        const ptrPrefix = match[1];
        const name = match[2];
        const arraySize = this.parseArraySize(match[3]);
        const bitWidth = match[4] ? parseInt(match[4], 10) : undefined;
        const type = ptrPrefix ? `${baseType} *` : baseType;
        return {
            name,
            type,
            offset: 0,
            size: 0,
            alignment: 0,
            isArray: arraySize !== undefined,
            arraySize,
            isBitField: bitWidth !== undefined,
            bitWidth
        };
    }

    /**
     * Calculate struct layout with padding and alignment
     */
    private calculateLayout(structName: string, members: StructMember[]): StructSizeResult {
        let currentOffset = 0;
        let structAlignment = 1;
        let totalPadding = 0;
        let hasUnresolvedTypes = false;
        let activeBitField:
            | { type: string; storageOffset: number; storageSize: number; storageBits: number; alignment: number; usedBits: number }
            | undefined;

        const packingAlignment = this.typeConfig.packingAlignment || 8;

        const flushBitField = () => {
            if (activeBitField) {
                currentOffset = activeBitField.storageOffset + activeBitField.storageSize;
                activeBitField = undefined;
            }
        };

        for (const member of members) {
            // Get type size and alignment
            const typeInfo = this.getMemberTypeInfo(member);
            if (!typeInfo.resolved) {
                hasUnresolvedTypes = true;
            }

            // Apply packing alignment limit
            const memberAlignment = Math.min(typeInfo.alignment, packingAlignment);
            const memberSize = typeInfo.size * (member.arraySize || 1);

            // Update struct alignment (max of all member alignments)
            structAlignment = Math.max(structAlignment, memberAlignment);

            if (member.isBitField) {
                const bitWidth = member.bitWidth ?? 0;
                const storageSize = typeInfo.size;
                const storageBits = Math.max(1, storageSize * 8);
                if (member.isAnonymousBitField && bitWidth === 0) {
                    flushBitField();
                    const padding = this.calculatePadding(currentOffset, memberAlignment);
                    totalPadding += padding;
                    currentOffset += padding;
                    member.offset = currentOffset;
                    member.size = 0;
                    member.alignment = memberAlignment;
                    continue;
                }
                const needsNewStorage = !activeBitField
                    || activeBitField.type !== member.type
                    || activeBitField.usedBits + bitWidth > activeBitField.storageBits;
                if (needsNewStorage) {
                    flushBitField();
                    const padding = this.calculatePadding(currentOffset, memberAlignment);
                    totalPadding += padding;
                    currentOffset += padding;
                    activeBitField = {
                        type: member.type,
                        storageOffset: currentOffset,
                        storageSize,
                        storageBits,
                        alignment: memberAlignment,
                        usedBits: 0
                    };
                }
                const bitField = activeBitField!;
                member.offset = bitField.storageOffset;
                member.size = storageSize;
                member.alignment = memberAlignment;
                bitField.usedBits += bitWidth;
                continue;
            }

            flushBitField();

            // Add padding before this member
            const padding = this.calculatePadding(currentOffset, memberAlignment);
            totalPadding += padding;
            currentOffset += padding;

            // Set member offset and size
            member.offset = currentOffset;
            member.size = memberSize;
            member.alignment = memberAlignment;

            // Move to next position
            currentOffset += memberSize;
        }

        flushBitField();

        // Add trailing padding to align struct size to struct alignment
        const trailingPadding = this.calculatePadding(currentOffset, structAlignment);
        totalPadding += trailingPadding;
        currentOffset += trailingPadding;

        return {
            structName,
            totalSize: currentOffset,
            alignment: structAlignment,
            members,
            padding: totalPadding,
            success: !hasUnresolvedTypes
        };
    }

    private calculateUnionLayout(structName: string, members: StructMember[]): StructSizeResult {
        let maxSize = 0;
        let unionAlignment = 1;
        let hasUnresolvedTypes = false;
        const packingAlignment = this.typeConfig.packingAlignment || 8;

        for (const member of members) {
            const typeInfo = this.getMemberTypeInfo(member);
            if (!typeInfo.resolved) {
                hasUnresolvedTypes = true;
            }
            const memberAlignment = Math.min(typeInfo.alignment, packingAlignment);
            const memberSize = typeInfo.size * (member.arraySize || 1);
            unionAlignment = Math.max(unionAlignment, memberAlignment);
            maxSize = Math.max(maxSize, memberSize);
            member.offset = 0;
            member.size = memberSize;
            member.alignment = memberAlignment;
        }

        const trailingPadding = this.calculatePadding(maxSize, unionAlignment);
        return {
            structName,
            totalSize: maxSize + trailingPadding,
            alignment: unionAlignment,
            members,
            padding: trailingPadding,
            success: !hasUnresolvedTypes
        };
    }

    private getMemberTypeInfo(member: StructMember): TypeConfig & { resolved: boolean } {
        if (typeof member.fixedSize === 'number' && typeof member.fixedAlignment === 'number') {
            return { size: member.fixedSize, alignment: member.fixedAlignment, resolved: true };
        }
        return this.getTypeInfo(member.type);
    }

    /**
     * Get type information (size and alignment)
     * Supports recursive lookup for custom types
     * Returns resolved: false if the type is unknown (not built-in and not a registered custom type)
     */
    private getTypeInfo(type: string): TypeConfig & { resolved: boolean } {
        // Remove qualifiers
        const cleanType = type
            .replace(/\b(const|volatile|static|extern)\b/g, '')
            .replace(/\b(struct|class|union)\s+/g, '')
            .trim();

        // Check if it's a pointer
        if (cleanType.includes('*')) {
            const info = this.typeConfig.types['pointer'] || { size: 4, alignment: 4 };
            return { ...info, resolved: true };
        }

        // Check built-in types
        if (this.typeConfig.types[cleanType]) {
            return { ...this.typeConfig.types[cleanType], resolved: true };
        }

        // Check custom types (previously calculated structs)
        const customType = this.customTypes.get(cleanType);
        if (customType) {
            return {
                size: customType.totalSize,
                alignment: customType.alignment,
                resolved: true
            };
        }

        // Default: assume int-sized but mark as unresolved
        return { size: 4, alignment: 4, resolved: false };
    }

    /**
     * Calculate padding needed to align to given alignment
     */
    private calculatePadding(currentOffset: number, alignment: number): number {
        // Guard against zero/negative alignment from misconfigured types (modulo 0 → NaN/hang).
        if (!Number.isFinite(alignment) || alignment <= 0) { return 0; }
        const remainder = currentOffset % alignment;
        return remainder === 0 ? 0 : alignment - remainder;
    }

    /**
     * Register a custom type (struct/class) for use in other structs
     */
    registerCustomType(result: StructSizeResult): void {
        this.customTypes.set(result.structName, result);
    }

    /**
     * Load type configuration from JSON object
     */
    static loadTypeConfig(configJson: any): TypeConfigFile {
        return {
            types: { ...DEFAULT_TYPE_CONFIG.types, ...(configJson.types || {}) },
            packingAlignment: configJson.packingAlignment || DEFAULT_TYPE_CONFIG.packingAlignment
        };
    }

    /**
     * Find struct definition in source code
     */
    static findStructDefinition(lines: string[], structName: string): number {
        const pattern = new RegExp(`\\b(struct|class|union)\\s+${structName}\\b`);

        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                return i;
            }
        }

        return -1;
    }

    private getAggregateKind(line: string): AggregateKind {
        const match = line.match(/\b(struct|class|union)\b/u);
        return (match?.[1] as AggregateKind | undefined) ?? 'struct';
    }
}
