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

            return this.calculateLayout(structName, members);
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
        const members: StructMember[] = [];
        let braceDepth = 0;
        let foundOpeningBrace = false;

        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];

            // Track braces
            for (const char of line) {
                if (char === '{') {
                    braceDepth++;
                    foundOpeningBrace = true;
                } else if (char === '}') {
                    braceDepth--;
                    if (braceDepth === 0 && foundOpeningBrace) {
                        // End of struct
                        return members;
                    }
                }
            }

            if (!foundOpeningBrace || braceDepth === 0) {
                continue;
            }

            // Parse member declaration
            // Pattern: Type memberName; or Type memberName[size];
            const memberMatch = line.match(/^\s*([\w\s*]+?)\s+(\w+)(?:\[(\d+)\])?\s*;/);
            if (memberMatch) {
                const type = memberMatch[1].trim();
                const name = memberMatch[2];
                const arraySize = memberMatch[3] ? parseInt(memberMatch[3], 10) : undefined;

                members.push({
                    name,
                    type,
                    offset: 0,  // Will be calculated
                    size: 0,    // Will be calculated
                    alignment: 0,  // Will be calculated
                    isArray: arraySize !== undefined,
                    arraySize
                });
            }
        }

        return members;
    }

    /**
     * Calculate struct layout with padding and alignment
     */
    private calculateLayout(structName: string, members: StructMember[]): StructSizeResult {
        let currentOffset = 0;
        let structAlignment = 1;
        let totalPadding = 0;

        const packingAlignment = this.typeConfig.packingAlignment || 8;

        for (const member of members) {
            // Get type size and alignment
            const typeInfo = this.getTypeInfo(member.type);

            // Apply packing alignment limit
            const memberAlignment = Math.min(typeInfo.alignment, packingAlignment);
            const memberSize = typeInfo.size * (member.arraySize || 1);

            // Update struct alignment (max of all member alignments)
            structAlignment = Math.max(structAlignment, memberAlignment);

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
            success: true
        };
    }

    /**
     * Get type information (size and alignment)
     * Supports recursive lookup for custom types
     */
    private getTypeInfo(type: string): TypeConfig {
        // Remove qualifiers
        const cleanType = type.replace(/\b(const|volatile|static|extern)\b/g, '').trim();

        // Check if it's a pointer
        if (cleanType.includes('*')) {
            return this.typeConfig.types['pointer'] || { size: 4, alignment: 4 };
        }

        // Check built-in types
        if (this.typeConfig.types[cleanType]) {
            return this.typeConfig.types[cleanType];
        }

        // Check custom types (previously calculated structs)
        const customType = this.customTypes.get(cleanType);
        if (customType) {
            return {
                size: customType.totalSize,
                alignment: customType.alignment
            };
        }

        // Default: assume int-sized
        return { size: 4, alignment: 4 };
    }

    /**
     * Calculate padding needed to align to given alignment
     */
    private calculatePadding(currentOffset: number, alignment: number): number {
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
            types: configJson.types || DEFAULT_TYPE_CONFIG.types,
            packingAlignment: configJson.packingAlignment || DEFAULT_TYPE_CONFIG.packingAlignment
        };
    }

    /**
     * Find struct definition in source code
     */
    static findStructDefinition(lines: string[], structName: string): number {
        const pattern = new RegExp(`\\b(struct|class)\\s+${structName}\\b`);

        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                return i;
            }
        }

        return -1;
    }
}
