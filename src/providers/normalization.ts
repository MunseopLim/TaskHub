/**
 * Pure normalization helpers shared by the link / favorite providers and by
 * `extension.ts`. They have no dependency on the `vscode` API and are kept
 * here to avoid circular imports between `extension.ts` and the provider
 * modules.
 *
 * `extension.ts` re-exports these so existing callers (including tests)
 * can keep importing from `./extension` unchanged.
 */

export function normalizeTags(rawTags: unknown): string[] | undefined {
    if (!Array.isArray(rawTags)) {
        return undefined;
    }
    const cleaned = rawTags
        .map(tag => typeof tag === 'string' ? tag.trim() : '')
        .filter(tag => tag.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
}

export function normalizeLineNumber(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const value = Math.floor(raw);
        return value > 0 ? value : undefined;
    }
    if (typeof raw === 'string') {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return undefined;
}
