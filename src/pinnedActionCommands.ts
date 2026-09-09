import * as vscode from 'vscode';
import { t } from './i18n';
import { InputProfileStore, InputProfileInspection, inspectInputProfile } from './inputProfiles';
import { PinnedActionReference, PinnedActionStore, PinnedActionStoreError, findPinnedInputProfile } from './pinnedActions';
import { Action, PinnedAction } from './providers/mainViewProvider';
import type { ActionItem, Task } from './schema';

interface PinnedActionCommandOptions {
    store: PinnedActionStore;
    profiles: InputProfileStore;
    loadActions: () => ActionItem[];
    findAction: (actions: ActionItem[], id: string) => ActionItem | undefined;
    refresh: () => void;
    validateInputs: (inspection: InputProfileInspection, tasks: Task[]) => InputProfileInspection;
    confirmOutdated: (name: string, inspection: InputProfileInspection) => Promise<boolean>;
    /** 실행 자체의 실패 알림·로그 정책은 기존 executeAction 경로가 소유한다. */
    execute: (item: ActionItem, actions: ActionItem[], inputs?: Record<string, unknown>) => Promise<void>;
}

function errorMessage(error: unknown): string {
    if (error instanceof PinnedActionStoreError) {
        if (error.code === 'too-many-pins') {
            return t('고정 항목은 워크스페이스당 최대 100개까지 저장할 수 있습니다.', 'A workspace can store up to 100 pinned actions.');
        }
        if (error.code === 'store-too-large') {
            return t('고정 목록이 저장 한도를 초과했습니다.', 'The pinned action list exceeds its storage limit.');
        }
        return t('고정 목록이 손상되었거나 지원하지 않는 형식입니다. 기존 데이터는 변경하지 않았습니다.', 'Pinned action storage is corrupt or uses an unsupported format. Existing data has not been changed.');
    }
    const detail = error instanceof Error ? error.message : String(error);
    return t(`고정 액션을 처리할 수 없습니다: ${detail}`, `Could not use pinned actions: ${detail}`);
}

export function registerPinnedActionCommands(options: PinnedActionCommandOptions): vscode.Disposable {
    const { store, profiles, loadActions, findAction, refresh } = options;

    const resolve = (pin: PinnedActionReference) => {
        const actions = loadActions();
        const item = findAction(actions, pin.actionId);
        if (!item?.action) {
            throw new Error(t(`액션 '${pin.actionId}'을(를) 찾을 수 없습니다.`, `Action '${pin.actionId}' no longer exists.`));
        }
        const profile = pin.profileId === undefined ? undefined : findPinnedInputProfile(pin, profiles);
        if (pin.profileId !== undefined && (!profile || profile.actionId !== pin.actionId)) {
            throw new Error(t('고정한 입력 프로필을 찾을 수 없습니다. 고정을 해제하고 다시 등록하세요.', 'The pinned input profile no longer exists. Unpin this entry and pin it again.'));
        }
        return { actions, item, profile };
    };

    const pinCommand = vscode.commands.registerCommand('taskhub.pinAction', async (actionItem?: Action) => {
        if (!actionItem?.id || actionItem instanceof PinnedAction) { return; }
        try {
            const actionId = actionItem.id;
            const { item } = resolve({ actionId });
            const items: Array<vscode.QuickPickItem & { pin: PinnedActionReference }> = [{
                label: t('액션만 고정', 'Pin action only'),
                description: t('실행할 때 입력을 선택합니다.', 'Choose inputs when running.'),
                pin: { actionId },
            }];
            try {
                items.push(...profiles.list(actionId).map(profile => ({
                    label: profile.name,
                    description: t('저장한 입력 프로필로 바로 실행합니다.', 'Run directly with this saved input profile.'),
                    pin: { actionId, profileId: profile.id },
                })));
            } catch {
                // 액션만 고정하는 동작은 프로필 저장소에 의존하지 않는다.
                items[0].detail = t(
                    '저장된 입력 프로필을 읽을 수 없어 액션만 고정할 수 있습니다. 기존 프로필 데이터는 변경하지 않습니다.',
                    'Saved input profiles are unavailable, so only the action can be pinned. Existing profile data will be preserved.'
                );
            }
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: t(`'${item.title}'의 고정할 실행 방식 선택`, `Choose how to pin '${item.title}'`),
                ignoreFocusOut: false,
                matchOnDescription: true,
            });
            if (!selected) { return; }
            // 선택창이 열린 사이 삭제된 액션·프로필을 새 고정으로 저장하지 않는다.
            resolve(selected.pin);
            if (await store.add(selected.pin)) {
                refresh();
            } else {
                vscode.window.showInformationMessage(t('이미 상단에 고정된 항목입니다.', 'This entry is already pinned.'));
            }
        } catch (error) {
            vscode.window.showErrorMessage(errorMessage(error));
        }
    });

    const runCommand = vscode.commands.registerCommand('taskhub.runPinnedAction', async (row?: PinnedAction) => {
        if (!row?.pin) { return; }
        try {
            const pin = row.pin;
            for (;;) {
                if (!store.has(pin)) {
                    throw new Error(t('이 항목은 더 이상 고정되어 있지 않습니다.', 'This entry is no longer pinned.'));
                }
                const current = resolve(pin);
                const inspection = current.profile
                    ? options.validateInputs(inspectInputProfile(current.profile, current.item.action!.tasks), current.item.action!.tasks)
                    : undefined;
                if (current.profile && inspection && inspection.staleTaskIds.length > 0) {
                    const signature = JSON.stringify([current.item, current.profile]);
                    if (!await options.confirmOutdated(current.profile.name, inspection)) { return; }
                    // 확인창이 열린 동안 정의·입력·고정 여부가 바뀌면 최신 값으로 재검토한다.
                    if (!store.has(pin)) { continue; }
                    const latest = resolve(pin);
                    if (JSON.stringify([latest.item, latest.profile]) !== signature) { continue; }
                }
                await options.execute(current.item, current.actions, inspection?.usableInputs);
                return;
            }
        } catch (error) {
            vscode.window.showErrorMessage(errorMessage(error));
            refresh();
        }
    });

    const unpinCommand = vscode.commands.registerCommand('taskhub.unpinAction', async (row?: PinnedAction) => {
        if (!row?.pin) { return; }
        try {
            if (await store.remove(row.pin)) { refresh(); }
        } catch (error) {
            vscode.window.showErrorMessage(errorMessage(error));
        }
    });
    return vscode.Disposable.from(pinCommand, runCommand, unpinCommand);
}
