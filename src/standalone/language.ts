/** A terminal has no VS Code language setting. Follow the process locale. */
export function t(ko: string, en: string): string {
    const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    return locale.toLowerCase().startsWith('ko') ? ko : en;
}
