import * as vscode from 'vscode';

const settingNames = {
    enabled: ['experimental.aiScheduler.enabled', 'experimental.claudeScheduler.enabled'],
    executable: ['aiScheduler.executable', 'claudeScheduler.executable'],
    model: ['aiScheduler.model', 'claudeScheduler.model'],
    timeoutSeconds: ['aiScheduler.timeoutSeconds', 'claudeScheduler.timeoutSeconds'],
} as const;

/** These settings are machine-scoped: only explicit user values may override their defaults. */
export function aiScheduleSetting<T>(key: keyof typeof settingNames, fallback: T): T {
    const configuration = vscode.workspace.getConfiguration('taskhub');
    const [current, legacy] = settingNames[key];
    const inspected = configuration.inspect<T>(current);
    // Hidden legacy keys no longer have a registered scope. Never fall back to
    // their merged value: a repository must not supply a CLI executable path.
    return inspected?.globalValue ?? configuration.inspect<T>(legacy)?.globalValue ?? inspected?.defaultValue ?? fallback;
}

export function aiSchedulesEnabled(): boolean {
    return aiScheduleSetting<unknown>('enabled', false) === true;
}
