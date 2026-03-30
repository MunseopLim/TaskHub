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
