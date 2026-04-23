/**
 * webview JS(jsonEditor.ts의 getWebviewContent 내부 `buildSheetMap`/`getActiveRows`/
 * `parseValue`/`coerceEditedCellValue`)의 테스트용 미러. 프로덕션 코드는 webview 내부
 * JS 문자열을 사용하므로 이 파일을 import하지 못한다. 로직을 변경할 때는 반드시
 * jsonEditor.ts의 동일 함수도 함께 수정해야 한다.
 * (동기화 대상: jsonEditor.ts의 buildSheetMap / getActiveRows / parseValue / commitCell)
 */
export interface SheetEntry {
    label: string;
    path: string[];
}

export function buildSheetMap(data: Record<string, unknown>): SheetEntry[] {
    const sheetMap: SheetEntry[] = [];
    Object.keys(data).forEach(key => {
        const val = data[key];
        if (Array.isArray(val)) {
            sheetMap.push({ label: key, path: [key] });
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const obj = val as Record<string, unknown>;
            Object.keys(obj).forEach(subKey => {
                if (Array.isArray(obj[subKey])) {
                    sheetMap.push({ label: key + ' > ' + subKey, path: [key, subKey] });
                }
            });
        }
    });
    return sheetMap;
}

export function getRowsByPath(data: Record<string, unknown>, path: string[]): unknown[] | null {
    let ref: unknown = data;
    for (const k of path) {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
            ref = (ref as Record<string, unknown>)[k];
        } else {
            return null;
        }
    }
    return Array.isArray(ref) ? ref : null;
}

/**
 * Mirror of the webview's `parseValue`. Coerces the raw input string for a
 * simple cell editor back into a primitive JS value. Exported so the coercion
 * rules can be exercised in unit tests alongside {@link coerceEditedCellValue}.
 */
export function parseValue(str: string): unknown {
    if (str === '') { return ''; }
    if (str === 'null') { return null; }
    if (str === 'true') { return true; }
    if (str === 'false') { return false; }
    const num = Number(str);
    if (!isNaN(num) && str.trim() !== '') { return num; }
    return str;
}

/**
 * Mirror of the webview `commitCell` branch that assigns a new value for a
 * plain (non-array) cell edit.
 *
 * The key invariant — and the reason this helper exists separately from
 * {@link parseValue} — is that when the original cell was a string the raw
 * input must be preserved as-is, so values like `"00123"`, `"true"`, `"null"`
 * do not get silently re-typed on save.
 */
export function coerceEditedCellValue(rawInput: string, oldValue: unknown): unknown {
    if (typeof oldValue === 'string') {
        return rawInput;
    }
    return parseValue(rawInput);
}
