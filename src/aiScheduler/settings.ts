import * as vscode from 'vscode';
import { legacyAiScheduler } from './compatibility';

const settingNames = {
    enabled: ['aiScheduler.enabled', 'experimental.aiScheduler.enabled', legacyAiScheduler.enabledSetting],
    executable: ['aiScheduler.executable', legacyAiScheduler.executableSetting],
    model: ['aiScheduler.model', legacyAiScheduler.modelSetting],
    timeoutSeconds: ['aiScheduler.timeoutSeconds', legacyAiScheduler.timeoutSetting],
} as const;

/** These settings are machine-scoped: only explicit user values may override their defaults. */
export function aiScheduleSetting<T>(key: keyof typeof settingNames, fallback: T): T {
    const configuration = vscode.workspace.getConfiguration('taskhub');
    // Hidden legacy keys no longer have a registered scope. Never fall back to
    // their merged value: a repository must not supply a CLI executable path.
    for (const name of settingNames[key]) {
        const value = configuration.inspect<T>(name)?.globalValue;
        if (value !== undefined && value !== null) { return value; }
    }
    return configuration.inspect<T>(settingNames[key][0])?.defaultValue ?? fallback;
}

export function aiSchedulesEnabled(): boolean {
    return aiScheduleSetting<unknown>('enabled', true) === true;
}
