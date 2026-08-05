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
const IDENTIFIER_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

/**
 * 확장 결과 문자열의 상한. 깊이 제한만으로는 부족하다 — `Mn = M(n-1) M(n-1)`
 * 형태는 깊이가 얕아도 결과가 2^n 으로 커진다. 실제 헤더의 매크로는 수백 자를
 * 넘지 않으므로 64KB 면 정상 사용에는 닿지 않는다.
 */
const MAX_EXPANDED_LENGTH = 64 * 1024;

/**
 * 치환 횟수 상한. 길이는 짧게 유지되면서 노드 수만 폭발하는 형태
 * (`#define M9 M8 M8` 를 빈 매크로로 쌓는 등)를 막는다.
 */
const MAX_EXPANSIONS = 20000;

/**
 * `expansionSteps` 에 담을 최대 항목 수. **메모리 상한이다** — 무제한으로 모으면
 * 결과 문자열보다 먼저 메모리를 먹는다 (깊이 18 짜리 이진 매크로에서 262,144
 * 항목 / 9.7MB 였다).
 *
 * **표시 상한이 아니다.** 현재 호버(`numberBaseHoverProvider`)는 이 배열의
 * **개수만** 보고(`length > 1` 로 "확장할 것이 있는가" 를 가른다) 내용은 쓰지
 * 않는다. 단계 목록을 실제로 보여 주려면 그쪽 렌더러를 함께 고쳐야 한다.
 */
const MAX_STEPS = 500;

export class MacroExpander {
    private maxDepth = 50; // Prevent infinite recursion
    private expandingMacros: Set<string> = new Set();
    /**
     * 매크로 이름 → 확장 결과. `Mn = M(n-1) M(n-1)` 같은 공유 하위식을 한 번만
     * 계산해 지수 팽창을 선형으로 접는다.
     *
     * **순수한 확장만 담는다.** 확장 도중 `expandingMacros` 때문에 건너뛴
     * 식별자가 하나라도 있었다면 그 결과는 "누가 위에서 확장 중이었는가"에
     * 의존하므로 다른 자리에서 재사용하면 안 된다. `circularSkips` 카운터가
     * 하위 트리 동안 변했는지로 그것을 판별한다.
     *
     * **`height` 를 함께 담는다** — 그 확장이 소비한 상대 재귀 깊이다. memo hit
     * 은 재귀를 건너뛰므로 깊이 검사도 함께 건너뛰게 되는데, 치환이 역순이라
     * 어느 매크로가 먼저 캐시되는지가 토큰 순서에 달려 있다. 그러면 같은
     * 정의 집합인데 `M0 M50` 은 성공하고 `M50 M0` 은 깊이 초과로 실패하는,
     * 순서에 따라 답이 달라지는 상태가 된다. 지금 깊이에서 재사용했을 때
     * 한도를 넘을 캐시는 쓰지 않고 정상 경로로 다시 확장해 판정을 맡긴다.
     */
    private memo: Map<string, { text: string; height: number }> = new Map();
    private circularSkips = 0;
    private expansionCount = 0;
    private stepsTruncated = false;

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
        // memo 는 `macros` 맵 하나에 대해서만 유효하다. 호출마다 비운다.
        this.memo.clear();
        this.circularSkips = 0;
        this.expansionCount = 0;
        this.stepsTruncated = false;

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

            // 길이 검사는 **치환 전에도** 필요하다. 치환 후에만 재면 참조가
            // 하나도 없는 거대 매크로가 그대로 통과한다 — 확장 자체는 공짜지만
            // 70KB 짜리 문자열이 steps 와 확장 결과를 타고 그대로 흐른다.
            this.assertWithinLengthBudget(macroDef.value);
            steps.push(`${macroName} = ${macroDef.value}`);
            const expanded = this.expandRecursive(macroDef.value, macros, steps, 0).text;
            // 0.6.59 는 여기서 "몇 번 접혔는지" 를 한 줄로 남겼다. 근거는 "단계가
            // 이유 없이 중간을 건너뛴 것처럼 보인다" 였는데, **단계 목록은 어디에도
            // 표시되지 않으므로** 그 문장은 사실이 아니었다 — 호버는 개수만 보고
            // 내용을 쓰지 않는다. 읽는 사람이 없는 안내라 걷어냈다.
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
    ): { text: string; height: number } {
        // Prevent infinite recursion
        if (depth > this.maxDepth) {
            throw new Error('Maximum macro expansion depth exceeded');
        }
        // 진입 시점의 값도 예산 안이어야 한다. 참조가 없는 leaf 는 치환이
        // 일어나지 않아 아래의 치환 후 검사에 닿지 않는다.
        this.assertWithinLengthBudget(value);

        let result = value;
        let hasExpansion = false;
        // 이 호출이 소비한 상대 재귀 깊이. 확장이 없으면 0, 있으면
        // 1 + (자식 중 가장 깊은 것). depth d 인 노드의 하위 트리가 닿는 가장
        // 깊은 depth 는 d + height 다 — memo 재사용 가능 여부를 이 값으로 판정한다.
        let height = 0;

        // Replace each identifier with its expansion if it's a macro
        const matches = Array.from(value.matchAll(IDENTIFIER_PATTERN));

        // Process in reverse order to maintain positions
        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];
            const identifier = match[0];
            const startIndex = match.index!;

            // Skip if this macro is currently being expanded (circular reference).
            // 이 skip 이 일어났다는 것은 지금 계산 중인 결과가 호출 문맥에
            // 의존한다는 뜻이므로, 상위에서 memo 에 담지 못하도록 기록한다.
            if (this.expandingMacros.has(identifier)) {
                this.circularSkips++;
                continue;
            }

            // Check if identifier is a defined macro
            const macroDef = macros.get(identifier);
            if (macroDef) {
                const cached = this.memo.get(identifier);
                // 캐시를 지금 자리에 끼워 넣으면 자식 호출은 depth + 1 에서
                // 시작해 depth + 1 + height 까지 내려간다. 그 값이 한도를 넘으면
                // 캐시를 쓰지 않고 정상 경로로 다시 확장한다 — 그래야 토큰
                // 순서와 무관하게 같은 답(깊이 초과)이 나온다.
                const usable = cached !== undefined && depth + 1 + cached.height <= this.maxDepth;
                let expandedMacro: string;
                let childHeight: number;

                if (usable) {
                    expandedMacro = cached!.text;
                    childHeight = cached!.height;
                } else {
                    // Mark as expanding to prevent circular reference
                    this.expandingMacros.add(identifier);
                    const skipsBefore = this.circularSkips;
                    let sub: { text: string; height: number };

                    try {
                        // Recursively expand the macro value
                        sub = this.expandRecursive(
                            macroDef.value,
                            macros,
                            steps,
                            depth + 1
                        );
                    } finally {
                        // Unmark
                        this.expandingMacros.delete(identifier);
                    }

                    expandedMacro = sub.text;
                    childHeight = sub.height;
                    if (this.circularSkips === skipsBefore) {
                        this.memo.set(identifier, sub);
                    }
                }

                height = Math.max(height, 1 + childHeight);

                if (++this.expansionCount > MAX_EXPANSIONS) {
                    throw new Error(
                        `Macro expansion exceeded ${MAX_EXPANSIONS} substitutions — the definitions expand combinatorially.`
                    );
                }

                // Replace in result
                result = result.substring(0, startIndex) +
                         expandedMacro +
                         result.substring(startIndex + identifier.length);

                this.assertWithinLengthBudget(result);

                hasExpansion = true;
            }
        }

        // Add step if there was any expansion
        if (hasExpansion) {
            this.pushStep(steps, `→ ${result}`);
        }

        return { text: result, height };
    }

    /**
     * 문자열 하나가 길이 예산 안인지 확인한다. 확장의 **모든 단계**(진입 시점의
     * 원본 값, 치환 결과)가 이 검사를 거쳐야 한다 — 한 자리만 빠지면 그 경로로
     * 예산이 통째로 우회된다.
     */
    private assertWithinLengthBudget(value: string): void {
        if (value.length > MAX_EXPANDED_LENGTH) {
            throw new Error(
                `Macro expansion exceeded ${MAX_EXPANDED_LENGTH} characters — the definitions expand combinatorially.`
            );
        }
    }

    /**
     * steps 를 상한까지만 모은다. 상한에 닿으면 잘렸다는 사실을 한 줄로 남긴다 —
     * 배열만 보고 확장이 거기서 끝났다고 읽지 않도록 하기 위한 표시다.
     *
     * **지금 이 표시를 읽는 화면은 없다.** 호버는 `expansionSteps` 의 개수만 본다
     * ({@link MAX_STEPS} 주석 참조). 단계 목록을 실제로 보여 주게 되면 이 줄이
     * 그때 의미를 갖는다.
     */
    private pushStep(steps: string[], step: string): void {
        if (steps.length < MAX_STEPS) {
            steps.push(step);
            return;
        }
        if (!this.stepsTruncated) {
            this.stepsTruncated = true;
            steps.push(`… (expansion steps truncated at ${MAX_STEPS})`);
        }
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
            if (!/^#define(?:\s|$)/.test(trimmed)) {
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

            // Handle simple hex: 0xABC or 0xABCU
            if (/^0[xX][0-9a-fA-F]+[ULul]*$/.test(cleaned)) {
                // Remove suffix and parse
                const numStr = cleaned.replace(/[ULul]+$/, '');
                return parseInt(numStr, 16);
            }

            // Handle simple binary: 0b1010 or 0b1010U
            if (/^0[bB][01]+[ULul]*$/.test(cleaned)) {
                // Remove suffix and parse
                const numStr = cleaned.replace(/[ULul]+$/, '').substring(2);
                return parseInt(numStr, 2);
            }

            // Handle simple decimal: 123 or 123U
            if (/^\d+[ULul]*$/.test(cleaned)) {
                // Remove suffix and parse
                const numStr = cleaned.replace(/[ULul]+$/, '');
                return parseInt(numStr, 10);
            }

            // Remove integer suffixes (U, L, UL, ULL, LL, etc.) before evaluation
            // This handles decimal, hex, and binary numbers with suffixes
            cleaned = cleaned.replace(/\b(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)[ULul]+\b/g, '$1');

            // Convert hex numbers to decimal for evaluation
            cleaned = cleaned.replace(/0[xX][0-9a-fA-F]+/g, (match) => {
                return parseInt(match, 16).toString();
            });

            // Convert binary numbers to decimal for evaluation
            cleaned = cleaned.replace(/0[bB][01]+/g, (match) => {
                return parseInt(match.substring(2), 2).toString();
            });

            // Try to evaluate expressions with operators
            // For safety, only allow specific characters, and bound length to avoid ReDoS/huge eval payloads.
            if (cleaned.length > 4096) { return null; }
            const safeExpression = /^[\d\s+\-*/<>|&^()]+$/;
            if (safeExpression.test(cleaned)) {
                // Replace shift operators with multiplication/division; clamp shift count to 63 bits
                // to match C semantics for 64-bit integers and avoid Math.pow overflow surprises.
                cleaned = cleaned.replace(/(\d+)\s*<<\s*(\d+)/g, (_, num, shift) => {
                    const s = Math.min(63, Math.max(0, parseInt(shift, 10) || 0));
                    return (parseInt(num, 10) * Math.pow(2, s)).toString();
                });
                cleaned = cleaned.replace(/(\d+)\s*>>\s*(\d+)/g, (_, num, shift) => {
                    const s = Math.min(63, Math.max(0, parseInt(shift, 10) || 0));
                    return Math.floor(parseInt(num, 10) / Math.pow(2, s)).toString();
                });

                // The expression has already passed a strict numeric/operator whitelist above.
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
