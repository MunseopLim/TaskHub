/**
 * Register decoder for decoding register values into bit field values
 * Parses register definitions from structs and decodes numeric values
 */

import { BitFieldInfo, extractBitFieldInfo } from './sfrBitFieldParser';

/**
 * Bit field definition for a register
 */
export interface BitFieldDefinition {
    /** Field name */
    name: string;
    /** Start bit position (LSB) */
    bitStart: number;
    /** End bit position (MSB) */
    bitEnd: number;
    /** Bit width */
    bitWidth: number;
    /** Description from comment */
    description?: string;
    /** Access type (RW, RO, WO, etc.) */
    accessType?: string;
    /** Reset value */
    resetValue?: string;
}

/**
 * Register definition containing multiple bit fields
 */
export interface RegisterDefinition {
    /** Register name (usually struct name) */
    name: string;
    /** List of bit fields in this register */
    fields: BitFieldDefinition[];
    /** Total register size in bits (usually 32) */
    totalBits: number;
}

/**
 * Decoded bit field value
 */
export interface DecodedField {
    /** Field name */
    name: string;
    /** Bit position string (e.g., "0" or "12:10") */
    bitPosition: string;
    /** Extracted field value */
    value: number;
    /** Hex representation */
    hex: string;
    /** Binary representation */
    binary: string;
    /** Decimal representation */
    decimal: string;
    /** Description if available */
    description?: string;
    /** Access type if available */
    accessType?: string;
}

/**
 * Register decoding result
 */
export interface RegisterDecodingResult {
    /** Register name */
    registerName: string;
    /** Original register value */
    registerValue: number;
    /** Decoded fields */
    fields: DecodedField[];
    /** Whether decoding was successful */
    success: boolean;
    /** Error message if decoding failed */
    error?: string;
}

/**
 * RegisterDecoder - decodes register values into bit field values
 */
export class RegisterDecoder {
    /**
     * Decode a register value into individual bit field values
     * @param value Register value to decode
     * @param definition Register definition with bit fields
     * @returns Decoding result with all field values
     */
    decodeValue(value: number, definition: RegisterDefinition): RegisterDecodingResult {
        try {
            const decodedFields: DecodedField[] = [];

            // Sort fields by bit position (LSB first) for consistent display
            const sortedFields = [...definition.fields].sort((a, b) => a.bitStart - b.bitStart);

            for (const field of sortedFields) {
                // Extract field value using bit mask
                const fieldValue = this.extractFieldValue(value, field.bitStart, field.bitEnd);

                // Format bit position
                const bitPosition = field.bitStart === field.bitEnd
                    ? `${field.bitStart}`
                    : `${field.bitEnd}:${field.bitStart}`;

                // Create decoded field
                const decodedField: DecodedField = {
                    name: field.name,
                    bitPosition,
                    value: fieldValue,
                    hex: `0x${fieldValue.toString(16).toUpperCase()}`,
                    binary: `0b${fieldValue.toString(2).padStart(field.bitWidth, '0')}`,
                    decimal: fieldValue.toString(10),
                    description: field.description,
                    accessType: field.accessType
                };

                decodedFields.push(decodedField);
            }

            return {
                registerName: definition.name,
                registerValue: value,
                fields: decodedFields,
                success: true
            };
        } catch (error) {
            return {
                registerName: definition.name,
                registerValue: value,
                fields: [],
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Extract a bit field value from a register value
     * @param registerValue Full register value
     * @param bitStart Start bit position (LSB)
     * @param bitEnd End bit position (MSB)
     * @returns Extracted field value
     */
    private extractFieldValue(registerValue: number, bitStart: number, bitEnd: number): number {
        const bitWidth = bitEnd - bitStart + 1;
        const mask = (1 << bitWidth) - 1;
        return (registerValue >>> bitStart) & mask;
    }

    /**
     * Parse a register definition from struct definition lines
     * @param lines Array of source code lines
     * @param structLineNumber Line number where struct starts
     * @param structName Struct name to parse
     * @returns Register definition or null if parsing failed
     */
    static parseRegisterFromStruct(
        lines: string[],
        structLineNumber: number,
        structName: string
    ): RegisterDefinition | null {
        const fields: BitFieldDefinition[] = [];
        let braceDepth = 0;
        let foundOpeningBrace = false;
        let totalBits = 32; // Default to 32-bit register

        // Scan forward from struct line to find all bit fields
        for (let i = structLineNumber; i < lines.length; i++) {
            const line = lines[i];

            // Track braces to know when struct ends
            for (const char of line) {
                if (char === '{') {
                    braceDepth++;
                    foundOpeningBrace = true;
                } else if (char === '}') {
                    braceDepth--;
                    if (braceDepth === 0 && foundOpeningBrace) {
                        // End of struct
                        if (fields.length > 0) {
                            return {
                                name: structName,
                                fields,
                                totalBits
                            };
                        }
                        return null;
                    }
                }
            }

            // Skip lines before opening brace
            if (!foundOpeningBrace) {
                continue;
            }

            // Try to extract bit field info
            const precedingLine = i > 0 ? lines[i - 1] : undefined;
            const bitFieldInfo = extractBitFieldInfo(line, precedingLine);

            if (bitFieldInfo && bitFieldInfo.commentInfo) {
                const field: BitFieldDefinition = {
                    name: bitFieldInfo.fieldName,
                    bitStart: bitFieldInfo.commentInfo.bitStart,
                    bitEnd: bitFieldInfo.commentInfo.bitEnd,
                    bitWidth: bitFieldInfo.commentInfo.bitWidth,
                    description: bitFieldInfo.commentInfo.description,
                    accessType: bitFieldInfo.commentInfo.accessType,
                    resetValue: bitFieldInfo.commentInfo.resetValue
                };

                fields.push(field);

                // Update total bits if needed
                if (bitFieldInfo.commentInfo.bitEnd >= totalBits) {
                    totalBits = bitFieldInfo.commentInfo.bitEnd + 1;
                }
            }
        }

        // If we reach end of file without closing brace
        if (fields.length > 0) {
            return {
                name: structName,
                fields,
                totalBits
            };
        }

        return null;
    }

    /**
     * Find struct definition line by struct name
     * @param lines Array of source code lines
     * @param structName Struct name to find
     * @returns Line number or -1 if not found
     */
    static findStructDefinition(lines: string[], structName: string): number {
        const pattern = new RegExp(`\\bstruct\\s+${structName}\\b`);

        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                return i;
            }
        }

        return -1;
    }

    /**
     * Find union definition line by union name or containing class/struct name
     * @param lines Array of source code lines
     * @param name Union name or class name to find
     * @returns Line number or -1 if not found
     */
    static findUnionDefinition(lines: string[], name: string): number {
        // Try to find union directly
        const unionPattern = new RegExp(`\\bunion\\s+${name}\\b`);
        for (let i = 0; i < lines.length; i++) {
            if (unionPattern.test(lines[i])) {
                return i;
            }
        }

        // Try to find class/struct that contains union
        const classPattern = new RegExp(`\\b(class|struct)\\s+${name}\\b`);
        for (let i = 0; i < lines.length; i++) {
            if (classPattern.test(lines[i])) {
                return i;
            }
        }

        return -1;
    }

    /**
     * Parse register definition from union containing a struct with bit fields
     * @param lines Array of source code lines
     * @param startLine Line number where union/class starts
     * @param name Union or class name
     * @returns Register definition or null if parsing failed
     */
    static parseRegisterFromUnion(
        lines: string[],
        startLine: number,
        name: string
    ): RegisterDefinition | null {
        const fields: BitFieldDefinition[] = [];
        let braceDepth = 0;
        let foundOpeningBrace = false;
        let inStruct = false;
        let structBraceDepth = 0;
        let totalBits = 32;

        // Scan forward to find union and inner struct
        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];

            // Look for struct keyword inside union (before processing braces)
            if (foundOpeningBrace && !inStruct && /\bstruct\b/.test(line)) {
                inStruct = true;
                structBraceDepth = 0;
            }

            // Track braces
            for (const char of line) {
                if (char === '{') {
                    braceDepth++;
                    foundOpeningBrace = true;
                    if (inStruct) {
                        structBraceDepth++;
                    }
                } else if (char === '}') {
                    braceDepth--;
                    if (inStruct) {
                        structBraceDepth--;
                        if (structBraceDepth === 0) {
                            // End of struct
                            inStruct = false;
                        }
                    }
                    if (braceDepth === 0 && foundOpeningBrace) {
                        // End of union/class
                        if (fields.length > 0) {
                            return {
                                name,
                                fields,
                                totalBits
                            };
                        }
                        return null;
                    }
                }
            }

            // Skip until we find opening brace
            if (!foundOpeningBrace) {
                continue;
            }

            // Parse bit fields only when inside struct
            if (inStruct && structBraceDepth > 0) {
                const precedingLine = i > 0 ? lines[i - 1] : undefined;
                const bitFieldInfo = extractBitFieldInfo(line, precedingLine);

                if (bitFieldInfo && bitFieldInfo.commentInfo) {
                    const field: BitFieldDefinition = {
                        name: bitFieldInfo.fieldName,
                        bitStart: bitFieldInfo.commentInfo.bitStart,
                        bitEnd: bitFieldInfo.commentInfo.bitEnd,
                        bitWidth: bitFieldInfo.commentInfo.bitWidth,
                        description: bitFieldInfo.commentInfo.description,
                        accessType: bitFieldInfo.commentInfo.accessType,
                        resetValue: bitFieldInfo.commentInfo.resetValue
                    };

                    fields.push(field);

                    // Update total bits
                    if (bitFieldInfo.commentInfo.bitEnd >= totalBits) {
                        totalBits = bitFieldInfo.commentInfo.bitEnd + 1;
                    }
                }
            }
        }

        // If we reach end of file
        if (fields.length > 0) {
            return {
                name,
                fields,
                totalBits
            };
        }

        return null;
    }
}
