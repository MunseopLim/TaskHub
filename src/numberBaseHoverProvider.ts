import * as vscode from 'vscode';
import {
    extractBitFieldInfo,
    extractHierarchy,
    formatHierarchy,
    calculateValidRange,
    calculateBitMask,
    CompleteBitFieldInfo
} from './sfrBitFieldParser';

/**
 * Hover provider that shows number base conversions for C/C++ numeric literals
 * and SFR bit field information
 */
export class NumberBaseHoverProvider implements vscode.HoverProvider {
    private isProcessingHover: boolean = false;

    /**
     * Regex patterns for detecting different number formats
     */
    private readonly patterns = {
        // Hexadecimal: 0xABC, 0XABC (with optional digit separators)
        hex0x: /\b0[xX][0-9a-fA-F']+\b/,
        // Hexadecimal with 'h' suffix: ABCh, ABCh (with optional digit separators)
        hexH: /\b[0-9a-fA-F']+[hH]\b/,
        // Binary: 0b1010, 0B1010 (with optional digit separators)
        binary: /\b0[bB][01']+\b/,
        // Decimal: 123, 1'000'000 (with optional digit separators)
        decimal: /\b\d[\d']*\b/,
    };

    /**
     * Provide hover information for numbers in the document
     */
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        // Prevent infinite recursion when calling hover provider
        if (this.isProcessingHover) {
            return undefined;
        }

        // Check if the feature is enabled
        const config = vscode.workspace.getConfiguration('taskhub.hover');
        const enabled = config.get('numberBase.enabled', true);
        if (!enabled) {
            return undefined;
        }

        // Get the current line
        const line = document.lineAt(position.line);
        const lineText = line.text;
        const charPosition = position.character;

        // First, try to detect SFR bit field
        const bitFieldHover = await this.tryBitFieldHover(document, position);
        if (bitFieldHover) {
            return bitFieldHover;
        }

        // Try to find a number at the current position
        const result = this.findNumberAtPosition(lineText, charPosition);
        if (result) {
            // Try to parse the number
            const parsedNumber = this.parseNumber(result.text);
            if (parsedNumber !== null) {
                // Create range for the hover
                const range = new vscode.Range(
                    position.line,
                    result.start,
                    position.line,
                    result.end
                );

                // Generate hover content
                const hoverContent = this.generateHoverContent(parsedNumber, result.text);
                return new vscode.Hover(hoverContent, range);
            }
        }

        // If not a number literal, try to find identifier value
        const identifierValue = await this.getIdentifierValue(document, position);
        if (identifierValue !== null) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) {
                const word = document.getText(wordRange);
                const hoverContent = this.generateHoverContent(identifierValue, word);
                return new vscode.Hover(hoverContent, wordRange);
            }
        }

        return undefined;
    }

    /**
     * Get the numeric value of an identifier (const, enum, etc.) using LSP
     * Returns the numeric value if found, null otherwise
     */
    private async getIdentifierValue(document: vscode.TextDocument, position: vscode.Position): Promise<number | null> {
        try {
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                return null;
            }

            const word = document.getText(wordRange);

            // Use LSP to find the definition of the symbol at this position
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
            );

            if (!definitions || definitions.length === 0) {
                return null;
            }

            // Get the first definition
            const definition = definitions[0];

            // Try to get hover information at the definition location
            // This will give us the preprocessed value for enums
            this.isProcessingHover = true;
            try {
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    definition.uri,
                    definition.range.start
                );

                if (hovers && hovers.length > 0) {
                    for (const hover of hovers) {
                        for (const content of hover.contents) {
                            const text = typeof content === 'string' ? content : content.value;

                            // Try to extract enum value from hover text
                            // Format: "(enum Test1) Test3_third = 1"
                            const enumValueMatch = text.match(/=\s*(0x[0-9a-fA-F]+|0b[01]+|\d+)/);
                            if (enumValueMatch) {
                                const valueStr = enumValueMatch[1];
                                const value = this.parseNumber(valueStr);
                                if (value !== null) {
                                    return value;
                                }
                            }
                        }
                    }
                }
            } finally {
                this.isProcessingHover = false;
            }

            // Fallback: Open the document containing the definition
            const defDocument = await vscode.workspace.openTextDocument(definition.uri);

            // Try to extract value from the definition line and surrounding context
            const value = await this.extractValueFromDefinitionContext(defDocument, definition.range.start.line, word);

            if (value !== null) {
                return value;
            }

            return null;
        } catch (error) {
            // LSP might not be available or symbol not found
            return null;
        }
    }

    /**
     * Extract value from definition considering surrounding context (for enums)
     */
    private async extractValueFromDefinitionContext(
        document: vscode.TextDocument,
        startLine: number,
        symbolName: string
    ): Promise<number | null> {
        const defLine = document.lineAt(startLine);
        const defText = defLine.text;

        // Try to extract from the definition line itself
        const directValue = this.extractValueFromLine(defText, symbolName);
        if (directValue !== null) {
            return directValue;
        }

        // Check if this is an enum declaration or enum member
        // If it's an enum member, search upward for the enum declaration
        let enumDeclLine = startLine;

        // Search upward for enum declaration (max 100 lines up)
        if (!defText.includes('enum')) {
            // Search upward for enum keyword
            for (let i = startLine; i >= Math.max(0, startLine - 100); i--) {
                const line = document.lineAt(i);
                const text = line.text;
                if (text.includes('enum')) {
                    enumDeclLine = i;
                    break;
                }
                // Stop if we hit a closing brace (end of previous scope)
                if (text.trim() === '};' || text.trim() === '}') {
                    break;
                }
            }
        }

        // Try to extract enum value
        if (enumDeclLine !== startLine || defText.includes('enum')) {
            return await this.extractEnumValue(document, enumDeclLine, symbolName);
        }

        return null;
    }

    /**
     * Extract enum value with support for implicit values
     * Handles: enum { A, B, C = 5, D }  where A=0, B=1, C=5, D=6
     */
    private async extractEnumValue(
        document: vscode.TextDocument,
        startLine: number,
        symbolName: string
    ): Promise<number | null> {
        const maxLines = Math.min(startLine + 100, document.lineCount);
        let currentValue = 0;
        let inEnumBody = false;

        for (let i = startLine; i < maxLines; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();

            // Start of enum body
            if (text.includes('{')) {
                inEnumBody = true;
                continue;
            }

            // End of enum body
            if (text.includes('};')) {
                break;
            }

            if (!inEnumBody) {
                continue;
            }

            // Parse enum entries (can be multiple per line or comma-separated)
            const entries = text.split(',').map(e => e.trim()).filter(e => e.length > 0);

            for (const entry of entries) {
                // Check if this entry has an explicit value: NAME = VALUE
                const assignMatch = entry.match(/^\s*(\w+)\s*=\s*([0-9a-fA-FxXbB']+)/);
                if (assignMatch) {
                    const name = assignMatch[1];
                    const value = this.parseNumber(assignMatch[2]);

                    if (name === symbolName && value !== null) {
                        return value;
                    }

                    if (value !== null) {
                        currentValue = value + 1;  // Next implicit value
                    }
                } else {
                    // No explicit value, use currentValue
                    const nameMatch = entry.match(/^\s*(\w+)/);
                    if (nameMatch) {
                        const name = nameMatch[1];
                        if (name === symbolName) {
                            return currentValue;
                        }
                        currentValue++;  // Next implicit value
                    }
                }
            }
        }

        return null;
    }

    /**
     * Extract numeric value from a single line
     * Supports: const int X = 0xFF; X = 0xFF; #define X 0xFF
     */
    private extractValueFromLine(text: string, symbolName?: string): number | null {
        // Pattern for const/variable/enum: NAME = VALUE; or NAME = VALUE,
        const assignPattern = /=\s*([0-9a-fA-FxXbB']+)\s*[;,]/;
        const assignMatch = text.match(assignPattern);
        if (assignMatch) {
            return this.parseNumber(assignMatch[1]);
        }

        // Pattern for #define: #define NAME VALUE
        const definePattern = /#define\s+\w+\s+([0-9a-fA-FxXbB']+)/;
        const defineMatch = text.match(definePattern);
        if (defineMatch) {
            return this.parseNumber(defineMatch[1]);
        }

        return null;
    }

    /**
     * Find a number literal at the given position in the text
     * Returns the text and its start/end positions, or null if not found
     */
    private findNumberAtPosition(text: string, position: number): { text: string; start: number; end: number } | null {
        // Define all number patterns with global flag to find all matches
        const numberPatterns = [
            // Hexadecimal with 0x prefix (must come before decimal)
            { regex: /0[xX][0-9a-fA-F']+/g, priority: 1 },
            // Binary with 0b prefix (must come before decimal)
            { regex: /0[bB][01']+/g, priority: 1 },
            // Hexadecimal with h suffix
            { regex: /[0-9a-fA-F][0-9a-fA-F']*[hH]/g, priority: 2 },
            // Decimal numbers (lowest priority to avoid matching parts of hex)
            { regex: /\b\d[\d']*/g, priority: 3 },
        ];

        // Find all matches and check if position is within any of them
        const matches: Array<{ text: string; start: number; end: number; priority: number }> = [];

        for (const { regex, priority } of numberPatterns) {
            let match;
            while ((match = regex.exec(text)) !== null) {
                const start = match.index;
                const end = start + match[0].length;

                // Check if the position is within this match
                if (position >= start && position < end) {
                    matches.push({
                        text: match[0],
                        start,
                        end,
                        priority
                    });
                }
            }
        }

        // Return the match with highest priority (lowest priority number)
        if (matches.length > 0) {
            matches.sort((a, b) => a.priority - b.priority);
            return matches[0];
        }

        return null;
    }

    /**
     * Parse a number from various formats and return its decimal value
     * Returns null if the input is not a valid number
     */
    private parseNumber(text: string): number | null {
        // Remove digit separators (')
        const cleanText = text.replace(/'/g, '');

        // Check for hexadecimal (0x prefix)
        if (this.patterns.hex0x.test(text)) {
            const value = parseInt(cleanText, 16);
            return isNaN(value) ? null : value;
        }

        // Check for hexadecimal (h suffix)
        if (this.patterns.hexH.test(text)) {
            const hexPart = cleanText.slice(0, -1); // Remove 'h' or 'H'
            const value = parseInt(hexPart, 16);
            return isNaN(value) ? null : value;
        }

        // Check for binary (0b prefix)
        if (this.patterns.binary.test(text)) {
            const binaryPart = cleanText.replace(/^0[bB]/, ''); // Remove 0b or 0B prefix
            const value = parseInt(binaryPart, 2);
            return isNaN(value) ? null : value;
        }

        // Check for decimal
        if (this.patterns.decimal.test(text)) {
            const value = parseInt(cleanText, 10);
            return isNaN(value) ? null : value;
        }

        return null;
    }

    /**
     * Generate Markdown formatted hover content showing the number in different bases
     */
    private generateHoverContent(value: number, original: string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        // Show conversions
        md.appendMarkdown(`**Hex:** \`0x${value.toString(16).toUpperCase()}\`\n\n`);
        md.appendMarkdown(`**Dec:** \`${value.toString(10)}\`\n\n`);
        md.appendMarkdown(`**Bin:** \`0b${value.toString(2)}\`\n\n`);

        // Add bit position display for all valid positive integers
        // JavaScript can safely represent integers up to Number.MAX_SAFE_INTEGER (2^53 - 1)
        if (value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
            md.appendMarkdown(this.generateBitPositionDisplay(value));
        }

        return md;
    }

    /**
     * Generate a bit position display showing which bits are set
     * - 32-bit values: displayed as one row
     * - 64-bit values: displayed as two 32-bit rows
     */
    private generateBitPositionDisplay(value: number): string {
        // Determine if this is a 64-bit value
        const is64Bit = value > 0xFFFFFFFF;
        const bitWidth = is64Bit ? 64 : 32;
        const binary = value.toString(2).padStart(bitWidth, '0');
        const setBits: number[] = [];

        // Find all set bits
        for (let i = 0; i < bitWidth; i++) {
            if (binary[bitWidth - 1 - i] === '1') {
                setBits.push(i);
            }
        }

        let result = `---\n\n**Bit Information (${bitWidth}-bit)**\n\n`;

        if (is64Bit) {
            // 64-bit: Display as two 32-bit rows using tables
            for (let row = 0; row < 2; row++) {
                const startBit = (1 - row) * 32 + 31;  // First row: bits 63-32, Second row: bits 31-0
                const endBit = (1 - row) * 32;
                const rowBits = binary.substring(row * 32, (row + 1) * 32);

                // Create bit position labels (every 4th bit - showing LSB of each group)
                const labels = [];
                const bitGroups = [];
                for (let i = 0; i < 8; i++) {  // 8 groups of 4 bits
                    const bitPos = startBit - (i * 4) - 3;  // LSB of each 4-bit group
                    labels.push(bitPos.toString());
                    bitGroups.push(rowBits.substring(i * 4, i * 4 + 4));
                }

                result += `|${labels.join('|')}|\n`;
                result += `|${labels.map(() => '---:').join('|')}|\n`;
                result += `|${bitGroups.join('|')}|\n`;
                if (row < 1) {
                    result += '\n';
                }
            }
        } else {
            // 32-bit: Display as one row using table
            const labels = [];
            const bitGroups = [];
            for (let i = 0; i < 8; i++) {  // 8 groups of 4 bits
                const bitPos = 31 - (i * 4) - 3;  // LSB of each 4-bit group (28, 24, 20, 16, 12, 8, 4, 0)
                labels.push(bitPos.toString());
                bitGroups.push(binary.substring(i * 4, i * 4 + 4));
            }

            result += `|${labels.join('|')}|\n`;
            result += `|${labels.map(() => '---:').join('|')}|\n`;
            result += `|${bitGroups.join('|')}|\n`;
        }

        result += '\n';

        // List set bits
        if (setBits.length > 0) {
            result += `**Set bits:** ${setBits.join(', ')}\n`;
        } else {
            result += `**Set bits:** none (value is 0)\n`;
        }

        return result;
    }

    /**
     * Try to provide hover information for SFR bit field
     * Returns hover if current position is on a bit field declaration or usage
     */
    private async tryBitFieldHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Hover | null> {
        const line = document.lineAt(position.line);
        const lineText = line.text;

        // Get preceding line for comment detection
        const precedingLine = position.line > 0 ? document.lineAt(position.line - 1).text : undefined;

        // Try to extract bit field info from current line (declaration)
        let bitFieldInfo = extractBitFieldInfo(lineText, precedingLine);

        // If not found on current line, try to find definition using LSP
        if (!bitFieldInfo || !bitFieldInfo.commentInfo) {
            bitFieldInfo = await this.tryBitFieldFromDefinition(document, position);
        }

        if (!bitFieldInfo || !bitFieldInfo.commentInfo) {
            return null;
        }

        // Check if cursor is on the field name
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

        if (word !== bitFieldInfo.fieldName) {
            return null;
        }

        // Get all definition and declaration locations
        const [definitions, declarations] = await Promise.all([
            vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
            ),
            vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDeclarationProvider',
                document.uri,
                position
            )
        ]);

        // Combine and deduplicate locations
        const allLocations: vscode.Location[] = [];
        const locationSet = new Set<string>();

        const addLocation = (loc: vscode.Location) => {
            const key = `${loc.uri.toString()}:${loc.range.start.line}:${loc.range.start.character}`;
            if (!locationSet.has(key)) {
                locationSet.add(key);
                allLocations.push(loc);
            }
        };

        if (definitions) {
            definitions.forEach(addLocation);
        }
        if (declarations) {
            declarations.forEach(addLocation);
        }

        // If we found limited results, try workspace symbol search for more
        if (allLocations.length <= 1 && word) {
            const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                word
            );

            if (workspaceSymbols) {
                // Filter for exact name match
                const exactMatches = workspaceSymbols.filter(sym => sym.name === word);

                // Add locations from workspace symbols
                for (const symbol of exactMatches) {
                    addLocation(symbol.location);
                }
            }
        }

        if (allLocations.length === 0) {
            // No definitions found, use current location
            const lines: string[] = [];
            for (let i = 0; i < document.lineCount; i++) {
                lines.push(document.getText(document.lineAt(i).range));
            }
            const scopes = extractHierarchy(lines, position.line);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            const filePath = workspaceFolder
                ? vscode.workspace.asRelativePath(document.uri, false)
                : document.uri.fsPath;

            const hoverContent = this.generateBitFieldHoverContent(
                bitFieldInfo,
                scopes,
                filePath,
                position.line + 1
            );
            return new vscode.Hover(hoverContent, wordRange);
        }

        // Generate hover content for all definitions
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        // Show count if multiple definitions
        if (allLocations.length > 1) {
            md.appendMarkdown(`*Multiple definitions found (${allLocations.length})*\n\n`);
            md.appendMarkdown('---\n\n');
        }

        // Show first definition in full detail
        const firstDefinition = allLocations[0];
        const firstDocument = await vscode.workspace.openTextDocument(firstDefinition.uri);
        const firstLine = firstDefinition.range.start.line;

        // Extract hierarchy information from first document
        const firstLines: string[] = [];
        for (let j = 0; j < firstDocument.lineCount; j++) {
            firstLines.push(firstDocument.getText(firstDocument.lineAt(j).range));
        }
        const firstScopes = extractHierarchy(firstLines, firstLine);

        // Get file path relative to workspace
        const firstWorkspaceFolder = vscode.workspace.getWorkspaceFolder(firstDocument.uri);
        const firstFilePath = firstWorkspaceFolder
            ? vscode.workspace.asRelativePath(firstDocument.uri, false)
            : firstDocument.uri.fsPath;

        // Generate and append first definition content
        const firstContent = this.generateBitFieldHoverContent(
            bitFieldInfo,
            firstScopes,
            firstFilePath,
            firstLine + 1
        );
        md.appendMarkdown(firstContent.value);

        // For remaining definitions, just show file paths
        if (allLocations.length > 1) {
            md.appendMarkdown('\n\n---\n\n');
            md.appendMarkdown('**Additional definitions:**\n\n');

            for (let i = 1; i < allLocations.length; i++) {
                const definition = allLocations[i];
                const targetDocument = await vscode.workspace.openTextDocument(definition.uri);
                const targetLine = definition.range.start.line;

                // Extract bit field info from this specific definition
                const defLineText = targetDocument.lineAt(targetLine).text;
                const precedingLineText = targetLine > 0
                    ? targetDocument.lineAt(targetLine - 1).text
                    : undefined;
                const thisBitFieldInfo = extractBitFieldInfo(defLineText, precedingLineText);

                // Extract hierarchy information from target document
                const lines: string[] = [];
                for (let j = 0; j < targetDocument.lineCount; j++) {
                    lines.push(targetDocument.getText(targetDocument.lineAt(j).range));
                }
                const scopes = extractHierarchy(lines, targetLine);

                // Get file path relative to workspace
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetDocument.uri);
                const filePath = workspaceFolder
                    ? vscode.workspace.asRelativePath(targetDocument.uri, false)
                    : targetDocument.uri.fsPath;

                const hierarchyName = formatHierarchy(scopes, bitFieldInfo.fieldName);

                // Use the comment info from THIS definition, not the first one
                const comment = thisBitFieldInfo?.commentInfo ?? bitFieldInfo.commentInfo!;

                // Create clickable file link with line number
                const fileLink = `[${filePath}:${targetLine + 1}](${definition.uri.toString()}#${targetLine + 1})`;
                md.appendMarkdown(`- ${fileLink} - ${hierarchyName} [${comment.bitPosition}][${comment.accessType}]\n`);
            }
        }

        return new vscode.Hover(md, wordRange);
    }

    /**
     * Try to get bit field info from definition using LSP
     */
    private async tryBitFieldFromDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<CompleteBitFieldInfo | null> {
        try {
            // Get word at current position
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                return null;
            }

            // Use LSP to find definition
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
            );

            if (!definitions || definitions.length === 0) {
                return null;
            }

            // Get the first definition
            const definition = definitions[0];

            // Open the document containing the definition
            const defDocument = await vscode.workspace.openTextDocument(definition.uri);
            const defLine = defDocument.lineAt(definition.range.start.line);
            const defLineText = defLine.text;

            // Get preceding line for comment
            const precedingLine = definition.range.start.line > 0
                ? defDocument.lineAt(definition.range.start.line - 1).text
                : undefined;

            // Try to extract bit field info from definition line
            const bitFieldInfo = extractBitFieldInfo(defLineText, precedingLine);
            return bitFieldInfo;
        } catch (error) {
            return null;
        }
    }

    /**
     * Generate hover content for SFR bit field
     */
    private generateBitFieldHoverContent(
        bitFieldInfo: CompleteBitFieldInfo,
        scopes: any[],
        filePath: string,
        lineNumber: number
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        const comment = bitFieldInfo.commentInfo!;
        const hierarchyName = formatHierarchy(scopes, bitFieldInfo.fieldName);

        // Title with hierarchy
        md.appendMarkdown(`### ${hierarchyName}\n\n`);

        // Property table (left-aligned)
        md.appendMarkdown('| Property | Value |\n');
        md.appendMarkdown('|---|---|\n');
        md.appendMarkdown(`| **Bit Position** | ${comment.bitPosition} |\n`);

        // Add bit width for multi-bit fields
        if (comment.bitWidth > 1) {
            md.appendMarkdown(`| **Bit Width** | ${comment.bitWidth} bits |\n`);
        }

        md.appendMarkdown(`| **Access Type** | ${comment.accessType} |\n`);

        // Reset value with conversions for multi-bit fields
        if (comment.bitWidth > 1 && comment.resetValueNumeric !== null) {
            const hex = '0x' + comment.resetValueNumeric.toString(16).toUpperCase();
            const dec = comment.resetValueNumeric.toString(10);
            const bin = '0b' + comment.resetValueNumeric.toString(2);
            md.appendMarkdown(`| **Reset Value** | ${comment.resetValue} (Dec: ${dec}, Bin: ${bin}) |\n`);
        } else {
            md.appendMarkdown(`| **Reset Value** | ${comment.resetValue} |\n`);
        }

        // Bit mask (32-bit) - shows the value when all bits in this field are set to 1
        const bitMask = calculateBitMask(comment.bitStart, comment.bitEnd);
        const bitMaskHex = '0x' + bitMask.toString(16).toUpperCase().padStart(8, '0');
        md.appendMarkdown(`| **Bit Mask** | ${bitMaskHex} |\n`);

        // File location
        md.appendMarkdown(`| **File** | ${filePath}:${lineNumber} |\n\n`);

        // Description
        md.appendMarkdown(`**Description:** ${comment.description}\n`);

        return md;
    }
}
