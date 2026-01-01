/**
 * Macro expander for C/C++ preprocessor macros
 * Recursively expands #define macros to their final values
 */

/**
 * Parsed macro definition
 */
export interface MacroDefinition {
    /** Macro name */
    name: string;
    /** Raw macro value (unexpanded) */
    value: string;
    /** Parameters for function-like macros */
    parameters?: string[];
}

/**
 * Result of macro expansion
 */
export interface MacroExpansionResult {
    /** Final expanded value */
    expandedValue: string;
    /** Expansion steps for debugging */
    expansionSteps: string[];
    /** Whether expansion was successful */
    success: boolean;
    /** Error message if expansion failed */
    error?: string;
}

/**
 * MacroExpander - recursively expands C/C++ preprocessor macros
 */
export class MacroExpander {
    private maxDepth = 50; // Prevent infinite recursion
    private expandingMacros: Set<string> = new Set();

    /**
     * Expand a macro definition recursively
     * @param macroName Name of the macro to expand
     * @param macros Map of all available macro definitions
     * @returns Expansion result with steps
     */
    expandMacro(
        macroName: string,
        macros: Map<string, MacroDefinition>
    ): MacroExpansionResult {
        const steps: string[] = [];
        this.expandingMacros.clear();

        try {
            const macroDef = macros.get(macroName);
            if (!macroDef) {
                return {
                    expandedValue: macroName,
                    expansionSteps: steps,
                    success: false,
                    error: `Macro "${macroName}" not found`
                };
            }

            steps.push(`${macroName} = ${macroDef.value}`);
            const expanded = this.expandRecursive(macroDef.value, macros, steps, 0);

            return {
                expandedValue: expanded,
                expansionSteps: steps,
                success: true
            };
        } catch (error) {
            return {
                expandedValue: macroName,
                expansionSteps: steps,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Recursively expand macro references in a value
     */
    private expandRecursive(
        value: string,
        macros: Map<string, MacroDefinition>,
        steps: string[],
        depth: number
    ): string {
        // Prevent infinite recursion
        if (depth > this.maxDepth) {
            throw new Error('Maximum macro expansion depth exceeded');
        }

        // Find all potential macro references (identifiers)
        const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
        let result = value;
        let hasExpansion = false;

        // Replace each identifier with its expansion if it's a macro
        const matches = Array.from(value.matchAll(identifierPattern));

        // Process in reverse order to maintain positions
        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            const identifier = match[0];
            const startIndex = match.index!;

            // Skip if this macro is currently being expanded (circular reference)
            if (this.expandingMacros.has(identifier)) {
                continue;
            }

            // Check if identifier is a defined macro
            const macroDef = macros.get(identifier);
            if (macroDef) {
                // Mark as expanding to prevent circular reference
                this.expandingMacros.add(identifier);

                // Recursively expand the macro value
                const expandedMacro = this.expandRecursive(
                    macroDef.value,
                    macros,
                    steps,
                    depth + 1
                );

                // Replace in result
                result = result.substring(0, startIndex) +
                         expandedMacro +
                         result.substring(startIndex + identifier.length);

                hasExpansion = true;

                // Unmark
                this.expandingMacros.delete(identifier);
            }
        }

        // Add step if there was any expansion
        if (hasExpansion) {
            steps.push(`→ ${result}`);
        }

        return result;
    }

    /**
     * Parse #define directives from text
     * @param text Source code text
     * @returns Map of macro definitions
     */
    static parseMacroDefinitions(text: string): Map<string, MacroDefinition> {
        const macros = new Map<string, MacroDefinition>();
        const lines = text.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip non-define lines
            if (!trimmed.startsWith('#define')) {
                continue;
            }

            // Remove #define prefix
            const defineContent = trimmed.substring(7).trim();

            // Parse macro name and value
            // Pattern: NAME value or NAME(params) value
            const simplePattern = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/;
            const match = defineContent.match(simplePattern);

            if (match) {
                const name = match[1];
                let value = match[2].trim();

                // Remove trailing comments
                const commentIndex = value.indexOf('//');
                if (commentIndex !== -1) {
                    value = value.substring(0, commentIndex).trim();
                }

                macros.set(name, {
                    name,
                    value
                });
            }
        }

        return macros;
    }

    /**
     * Try to evaluate expanded macro to a numeric value
     * @param expanded Expanded macro string
     * @returns Numeric value or null if not evaluable
     */
    static evaluateToNumber(expanded: string): number | null {
        try {
            // Remove whitespace
            let cleaned = expanded.trim();

            // Handle simple hex: 0xABC
            if (/^0[xX][0-9a-fA-F]+$/.test(cleaned)) {
                return parseInt(cleaned, 16);
            }

            // Handle simple binary: 0b1010
            if (/^0[bB][01]+$/.test(cleaned)) {
                return parseInt(cleaned.substring(2), 2);
            }

            // Handle simple decimal
            if (/^\d+$/.test(cleaned)) {
                return parseInt(cleaned, 10);
            }

            // Convert hex numbers to decimal for evaluation
            cleaned = cleaned.replace(/0[xX][0-9a-fA-F]+/g, (match) => {
                return parseInt(match, 16).toString();
            });

            // Convert binary numbers to decimal for evaluation
            cleaned = cleaned.replace(/0[bB][01]+/g, (match) => {
                return parseInt(match.substring(2), 2).toString();
            });

            // Try to evaluate expressions with operators
            // For safety, only allow specific characters
            const safeExpression = /^[\d\s+\-*/<>|&^()]+$/;
            if (safeExpression.test(cleaned)) {
                // Replace shift operators with multiplication/division
                // Handle both with and without surrounding whitespace
                cleaned = cleaned.replace(/(\d+)\s*<<\s*(\d+)/g, (_, num, shift) => {
                    return (parseInt(num) * Math.pow(2, parseInt(shift))).toString();
                });
                cleaned = cleaned.replace(/(\d+)\s*>>\s*(\d+)/g, (_, num, shift) => {
                    return Math.floor(parseInt(num) / Math.pow(2, parseInt(shift))).toString();
                });

                // Use Function constructor for safe evaluation
                const result = new Function(`return ${cleaned}`)();
                if (typeof result === 'number' && !isNaN(result)) {
                    return Math.floor(result);
                }
            }

            return null;
        } catch {
            return null;
        }
    }
}
