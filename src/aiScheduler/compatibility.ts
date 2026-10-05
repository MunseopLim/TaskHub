/** Previous releases used these persisted names. Keep them only at compatibility boundaries. */
export const legacyAiScheduler = {
    commandPrefix: 'taskhub.claudeScheduler',
    viewFocusCommand: 'mainView.claudeSchedules.focus',
    stateKey: 'taskhub.claudeSchedules.v1',
    featureId: 'claudeScheduler',
    storageDirectory: 'claude-scheduler',
    enabledSetting: 'experimental.claudeScheduler.enabled',
    executableSetting: 'claudeScheduler.executable',
    modelSetting: 'claudeScheduler.model',
    timeoutSetting: 'claudeScheduler.timeoutSeconds',
} as const;
