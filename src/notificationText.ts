/**
 * VS Code notification strings parse `[label](command:...)` as executable links;
 * backslash escaping is not supported by their linked-text parser. Keep external
 * output readable using full-width punctuation, only at the notification boundary.
 * Never use this for the original log, filesystem path, or webview data.
 */
export function plainNotificationText(message: string): string {
    return message.replace(/\[/g, '［').replace(/\]/g, '］').replace(/command:/gi, value => `${value.slice(0, -1)}：`);
}
