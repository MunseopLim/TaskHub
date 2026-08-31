import * as vscode from 'vscode';
import { t } from './i18n';

export const MARKDOWN_EXTENSIONS: ReadonlyArray<string> = ['.md', '.markdown'];
export const HTML_EXTENSIONS: ReadonlyArray<string> = ['.html', '.htm'];

const MARKDOWN_SET = new Set(MARKDOWN_EXTENSIONS);
const HTML_SET = new Set(HTML_EXTENSIONS);

/**
 * Returns the lowercased extension (including the leading dot) of a URI's
 * path, or '' if the path has no extension. Operates on `uri.path` (not
 * `fsPath`) so non-file schemes also resolve correctly.
 */
export function extensionOf(uri: vscode.Uri): string {
    const lastSlash = Math.max(uri.path.lastIndexOf('/'), uri.path.lastIndexOf('\\'));
    const basename = uri.path.slice(lastSlash + 1);
    const dot = basename.lastIndexOf('.');
    if (dot <= 0) {
        return '';
    }
    return basename.slice(dot).toLowerCase();
}

export function isMarkdownUri(uri: vscode.Uri): boolean {
    return MARKDOWN_SET.has(extensionOf(uri));
}

export function isHtmlUri(uri: vscode.Uri): boolean {
    return HTML_SET.has(extensionOf(uri));
}

/**
 * Normalizes the heterogeneous first argument that VS Code passes to a
 * context-menu command into a `Uri`. Each menu surface delivers a different
 * shape:
 *
 *   - `explorer/context`        → `Uri` (single) or `Uri[]` (multi-select).
 *   - `editor/title/context`    → `Uri`.
 *   - `scm/resourceState/context` → `SourceControlResourceState`
 *     (`{ resourceUri: Uri, ... }`) or an array of them.
 *   - Command palette / programmatic → arbitrary / undefined.
 *
 * Returns the first usable `Uri` it finds, or `undefined` if it cannot resolve
 * one. The caller is responsible for falling back to the active editor and
 * for surfacing the not-matched error.
 */
export function coerceToUri(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (Array.isArray(arg)) {
        for (const item of arg) {
            const resolved = coerceToUri(item);
            if (resolved) {
                return resolved;
            }
        }
        return undefined;
    }
    if (arg && typeof arg === 'object' && 'resourceUri' in arg) {
        const resourceUri = (arg as { resourceUri: unknown }).resourceUri;
        if (resourceUri instanceof vscode.Uri) {
            return resourceUri;
        }
    }
    return undefined;
}

export interface PreviewOpenerDeps {
    executeCommand: <T = unknown>(command: string, ...rest: unknown[]) => Thenable<T>;
    openExternal: (target: vscode.Uri) => Thenable<boolean>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    activeTextEditor: () => vscode.TextEditor | undefined;
}

const defaultDeps: PreviewOpenerDeps = {
    executeCommand: (command, ...rest) => vscode.commands.executeCommand(command, ...rest),
    openExternal: (target) => vscode.env.openExternal(target),
    showErrorMessage: (message) => vscode.window.showErrorMessage(message),
    activeTextEditor: () => vscode.window.activeTextEditor,
};

function resolveTargetUri(
    arg: unknown,
    matches: (uri: vscode.Uri) => boolean,
    notMatchedKo: string,
    notMatchedEn: string,
    notOpenKo: string,
    notOpenEn: string,
    deps: PreviewOpenerDeps,
): vscode.Uri | undefined {
    const coerced = coerceToUri(arg);
    if (coerced) {
        if (!matches(coerced)) {
            void deps.showErrorMessage(t(notMatchedKo, notMatchedEn));
            return undefined;
        }
        return coerced;
    }
    const editor = deps.activeTextEditor();
    if (editor && matches(editor.document.uri)) {
        return editor.document.uri;
    }
    void deps.showErrorMessage(t(notOpenKo, notOpenEn));
    return undefined;
}

export async function openMarkdownPreview(arg?: unknown, deps: PreviewOpenerDeps = defaultDeps): Promise<void> {
    const target = resolveTargetUri(
        arg,
        isMarkdownUri,
        '마크다운(.md/.markdown) 파일이 아닙니다.',
        'Not a Markdown (.md/.markdown) file.',
        '열려 있는 Markdown 파일이 없습니다. 파일을 열고 다시 실행하세요.',
        'No Markdown file is open. Open a file and run the command again.',
        deps,
    );
    if (!target) {
        return;
    }
    await deps.executeCommand('markdown.showPreviewToSide', target);
}

export async function openHtmlInBrowser(arg?: unknown, deps: PreviewOpenerDeps = defaultDeps): Promise<void> {
    const target = resolveTargetUri(
        arg,
        isHtmlUri,
        'HTML(.html/.htm) 파일이 아닙니다.',
        'Not an HTML (.html/.htm) file.',
        '열려 있는 HTML 파일이 없습니다. 파일을 열고 다시 실행하세요.',
        'No HTML file is open. Open a file and run the command again.',
        deps,
    );
    if (!target) {
        return;
    }
    const opened = await deps.openExternal(target);
    if (!opened) {
        await deps.showErrorMessage(t(
            'HTML 파일을 기본 브라우저에서 열지 못했습니다.',
            'Could not open the HTML file in the default browser.'
        ));
    }
}
