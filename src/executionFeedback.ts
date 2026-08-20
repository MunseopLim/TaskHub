/**
 * Controls user-facing action completion messages independently from the
 * persistent status rendered in the Actions tree.
 *
 * `followStatus` is intentionally the default so an existing
 * `showTaskStatus: false` setting keeps its pre-0.7.45 behaviour until the
 * user explicitly chooses a notification policy.
 */
export type ExecutionNotificationMode = 'followStatus' | 'on' | 'off';

export function isExecutionNotificationMode(value: unknown): value is ExecutionNotificationMode {
    return value === 'followStatus' || value === 'on' || value === 'off';
}

export function resolveExecutionNotifications(
    showTaskStatus: boolean,
    configuredMode: unknown
): boolean {
    const mode = isExecutionNotificationMode(configuredMode) ? configuredMode : 'followStatus';
    if (mode === 'on') {
        return true;
    }
    if (mode === 'off') {
        return false;
    }
    return showTaskStatus;
}

/**
 * Detached one-shot failures used to remain visible even when
 * `showTaskStatus` was off. Keep that edge of the legacy contract in
 * `followStatus`, while an explicit `off` must silence every execution
 * notification promised by the new setting.
 */
export function resolveDetachedFailureNotifications(configuredMode: unknown): boolean {
    const mode = isExecutionNotificationMode(configuredMode) ? configuredMode : 'followStatus';
    return mode !== 'off';
}
