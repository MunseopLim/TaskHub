import * as vscode from 'vscode';

/**
 * 로케일에 따라 한국어 또는 영어 메시지를 반환합니다.
 * VS Code가 한국어(`ko`)로 설정되어 있으면 한국어, 그 외에는 영어를 반환합니다.
 */
export function t(ko: string, en: string): string {
    return vscode.env.language.startsWith('ko') ? ko : en;
}
