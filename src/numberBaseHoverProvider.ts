import * as vscode from 'vscode';

/**
 * Hover provider that shows number base conversions for C/C++ numeric literals
 */
export class NumberBaseHoverProvider implements vscode.HoverProvider {

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
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
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

        // Try to find a number at the current position
        const result = this.findNumberAtPosition(lineText, charPosition);
        if (!result) {
            return undefined;
        }

        // Try to parse the number
        const parsedNumber = this.parseNumber(result.text);
        if (parsedNumber === null) {
            return undefined;
        }

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
}
