import * as vscode from 'vscode';
import { t } from './i18n';
import { fetchLinkTitle } from './linkTitle';
import { validateLinkUrlForSave } from './pipelineUtils';

/** 링크 추가를 명시적으로 시작한 경우에만 클립보드의 URL을 제안한다. */
export async function readClipboardLinkUrl(
    readText: () => Thenable<string> = () => vscode.env.clipboard.readText(),
): Promise<string | undefined> {
    try {
        const text = await readText();
        if (text.length > 16 * 1024) {
            return undefined;
        }
        const url = text.trim();
        if (/[\r\n]/.test(url) || !validateLinkUrlForSave(url).ok) {
            return undefined;
        }
        return url;
    } catch {
        return undefined;
    }
}

/** 제목 조회 중에도 입력·확정·취소가 가능하며, 사용자가 고친 제목은 유지한다. */
export function promptLinkTitle(
    url: string,
    fallbackTitle: string,
    fetchTitle: typeof fetchLinkTitle = fetchLinkTitle,
): Promise<string | undefined> {
    return new Promise(resolve => {
        const input = vscode.window.createInputBox();
        const controller = new AbortController();
        const subscriptions: vscode.Disposable[] = [];
        let settled = false;
        let edited = false;

        input.title = t('링크 추가', 'Add Link');
        input.prompt = t('링크 제목 — 자동으로 가져오며 직접 수정할 수 있습니다', 'Link title — suggested automatically; you can edit it');
        input.placeholder = 'e.g. Project Dashboard';
        input.value = fallbackTitle;
        input.valueSelection = [0, fallbackTitle.length];
        input.ignoreFocusOut = true;
        input.busy = true;

        const finish = (value: string | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            controller.abort();
            for (const subscription of subscriptions) {
                subscription.dispose();
            }
            input.dispose();
            resolve(value);
        };

        subscriptions.push(
            input.onDidChangeValue(value => {
                // 입력창 초기값의 UI 반영도 change 이벤트로 돌아올 수 있다.
                if (value !== fallbackTitle) {
                    edited = true;
                }
                input.validationMessage = undefined;
            }),
            input.onDidAccept(() => {
                const title = input.value.trim();
                if (!title) {
                    input.validationMessage = t('제목을 입력하세요', 'Enter a title');
                    return;
                }
                finish(title);
            }),
            input.onDidHide(() => finish(undefined)),
        );
        input.show();

        if (!settled) {
            void Promise.resolve()
                .then(() => settled ? undefined : fetchTitle(url, controller.signal))
                .then(title => {
                    if (settled) {
                        return;
                    }
                    if (title && !edited && input.value === fallbackTitle) {
                        input.value = title;
                        input.valueSelection = [0, title.length];
                    }
                    input.busy = false;
                }, () => {
                    if (!settled) {
                        input.busy = false;
                    }
                });
        }
    });
}
