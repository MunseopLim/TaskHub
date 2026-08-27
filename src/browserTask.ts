import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from './i18n';

export type BrowserTaskTarget = 'integrated' | 'default';

export interface BrowserTaskRequest {
    url: string;
    target?: BrowserTaskTarget;
    baseDir?: string;
}

export interface BrowserTaskResult {
    /**
     * TaskHub가 검증한 정규화 URL. Integrated Browser에는 이 문자열을 그대로
     * 전달한다. 로컬 file URI는 경로를 percent-encode하되 query와 fragment의
     * 의미를 보존한다. `default` 대상은 대응하는 vscode.Uri를 `openExternal`에
     * 전달하므로 실제 외부 주소 또는 query 표현과 다를 수 있다.
     */
    url: string;
    /** 로컬 파일을 연 경우에만 존재하는 정규화된 절대 경로. */
    path?: string;
}

/**
 * VS Code 경계는 주입 가능하게 유지한다. 경로 검증과 명령 선택을 실제로 실행하는
 * 단위 테스트가 특정 VS Code 버전의 내장 명령 집합에 의존하지 않게 하기 위함이다.
 */
export interface BrowserTaskDeps {
    getCommands: (filterInternal?: boolean) => Thenable<string[]>;
    executeCommand: <T = unknown>(command: string, ...rest: unknown[]) => Thenable<T>;
    openExternal: (target: vscode.Uri) => Thenable<boolean>;
    asExternalUri: (target: vscode.Uri) => Thenable<vscode.Uri>;
    remoteName: () => string | undefined;
}

const defaultDeps: BrowserTaskDeps = {
    getCommands: filterInternal => vscode.commands.getCommands(filterInternal),
    executeCommand: (command, ...rest) => vscode.commands.executeCommand(command, ...rest),
    openExternal: target => vscode.env.openExternal(target),
    asExternalUri: target => vscode.env.asExternalUri(target),
    remoteName: () => vscode.env.remoteName,
};

const INTEGRATED_BROWSER_COMMAND = 'workbench.action.browser.open';
const SIMPLE_BROWSER_COMMAND = 'simpleBrowser.show';
const URI_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

interface ResolvedBrowserTarget {
    uri: vscode.Uri;
    url: string;
    path?: string;
}

interface ParsedAbsoluteUri {
    uri: vscode.Uri;
    normalizedUrl: string;
    search: string;
    hash: string;
}

function serializeLocalFileUri(uri: vscode.Uri, search = '', hash = ''): string {
    // VS Code의 file-open 경로처럼 path는 표준 인코딩하되, URL query의 `=`/`&`와
    // 이미 인코딩된 값은 다시 해석하지 않는다.
    return `${uri.with({ query: '', fragment: '' }).toString()}${search}${hash}`;
}

function parseAbsoluteUri(rawUrl: string): ParsedAbsoluteUri | undefined {
    const schemeMatch = URI_SCHEME_RE.exec(rawUrl);
    // `C:\\...`는 URI 스킴 `c:`가 아니라 Windows 절대 경로다. 비-Windows
    // 호스트에서도 actions.json을 정적으로 검증할 때 같은 구분을 유지한다.
    if (!schemeMatch || WINDOWS_ABSOLUTE_PATH_RE.test(rawUrl)) {
        return undefined;
    }
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'file') {
        throw new Error(t(
            `브라우저 태스크는 http, https, file 주소만 지원합니다: ${scheme}`,
            `Browser tasks support only http, https, and file URLs: ${scheme}`,
        ));
    }
    try {
        // WHATWG URL로 먼저 검사해 `https://`처럼 호스트가 없는 입력이 VS Code의
        // 관대한 Uri.parse를 통과하지 않게 한다.
        const parsed = new URL(rawUrl);
        const normalizedUrl = parsed.toString();
        return {
            uri: vscode.Uri.parse(normalizedUrl, true),
            normalizedUrl,
            search: parsed.search,
            hash: parsed.hash,
        };
    } catch {
        throw new Error(t(
            `올바른 브라우저 주소가 아닙니다: ${rawUrl}`,
            `Invalid browser URL: ${rawUrl}`,
        ));
    }
}

function resolveLocalFile(
    rawPath: string,
    baseDir: string | undefined,
): ResolvedBrowserTarget {
    if (/\x00/.test(rawPath)) {
        throw new Error(t(
            '브라우저 파일 경로에는 null 바이트를 사용할 수 없습니다.',
            'A browser file path cannot contain a null byte.',
        ));
    }
    if (!path.isAbsolute(rawPath) && (!baseDir || baseDir.length === 0)) {
        throw new Error(t(
            '상대 브라우저 파일 경로 또는 상대 cwd를 해석할 기준 폴더가 없습니다. 절대 cwd를 지정하거나 워크스페이스 폴더를 여세요.',
            'A relative browser file path or cwd has no base folder. Set an absolute cwd or open a workspace folder.',
        ));
    }
    // fileDialog/pathDialog 결과와 임시 폴더의 생성물도 열 수 있어야 하므로 절대
    // 경로를 워크스페이스로 제한하지 않는다. 상대 경로의 기준만 실행 문맥으로 고정한다.
    const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(baseDir as string, rawPath);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolvedPath);
    } catch (error) {
        throw new Error(t(
            `브라우저에서 열 파일을 찾을 수 없습니다: ${resolvedPath}`,
            `Browser task file not found: ${resolvedPath}`,
        ), { cause: error });
    }
    if (!stat.isFile()) {
        throw new Error(t(
            `브라우저 태스크는 일반 파일만 열 수 있습니다: ${resolvedPath}`,
            `Browser tasks can open only regular files: ${resolvedPath}`,
        ));
    }
    const uri = vscode.Uri.file(resolvedPath);
    return {
        uri,
        url: serializeLocalFileUri(uri),
        path: resolvedPath,
    };
}

function resolveBrowserTarget(
    request: BrowserTaskRequest,
    remoteName: string | undefined,
): ResolvedBrowserTarget {
    if (typeof request.url !== 'string' || request.url.length === 0) {
        throw new Error(t(
            '브라우저 태스크에 url이 필요합니다.',
            'A browser task requires a url.',
        ));
    }

    const absoluteUri = parseAbsoluteUri(request.url);
    if ((!absoluteUri || absoluteUri.uri.scheme === 'file') && remoteName) {
        throw new Error(t(
            'Remote 환경에서는 확장 호스트의 로컬 파일을 브라우저로 직접 열 수 없습니다. 파일이 있는 디렉터리에서 HTTP 서버를 실행하고 http://localhost:<port>/... 주소를 사용하세요.',
            'Browser tasks cannot open extension-host local files directly in a Remote environment. Serve the file over HTTP and use an http://localhost:<port>/... URL.',
        ));
    }
    if (!absoluteUri) {
        return resolveLocalFile(request.url, request.baseDir);
    }
    if (absoluteUri.uri.scheme === 'file') {
        if (absoluteUri.uri.authority) {
            throw new Error(t(
                '네트워크 authority가 있는 file URL은 지원하지 않습니다. 로컬 경로를 사용하거나 파일을 HTTP(S)로 제공하세요.',
                'File URLs with a network authority are not supported. Use a local path or serve the file over HTTP(S).',
            ));
        }
        const local = resolveLocalFile(absoluteUri.uri.fsPath, request.baseDir);
        return {
            ...local,
            uri: local.uri.with({
                query: absoluteUri.uri.query,
                fragment: absoluteUri.uri.fragment,
            }),
            url: serializeLocalFileUri(local.uri, absoluteUri.search, absoluteUri.hash),
        };
    }
    return { uri: absoluteUri.uri, url: absoluteUri.normalizedUrl };
}

/**
 * Browser 태스크의 대상 주소를 검증하고 요청한 브라우저에서 연다.
 *
 * `integrated`는 내장 브라우저 명령이 없는 환경에서 OS 기본 브라우저로 조용히
 * 폴백하지 않는다. HTTP(S)만 구형 Simple Browser로 호환 폴백하고, 로컬 파일은
 * 최신 Integrated Browser가 없으면 사용자가 취할 수 있는 조치를 포함해 실패한다.
 */
export async function openBrowserTask(
    request: BrowserTaskRequest,
    deps: BrowserTaskDeps = defaultDeps,
): Promise<BrowserTaskResult> {
    const target = request.target ?? 'integrated';
    if (target !== 'integrated' && target !== 'default') {
        throw new Error(t(
            `지원하지 않는 브라우저 대상입니다: ${String(target)}`,
            `Unsupported browser target: ${String(target)}`,
        ));
    }

    const remoteName = deps.remoteName();
    const resolved = resolveBrowserTarget(request, remoteName);
    let targetUri = resolved.uri;

    if (target === 'default') {
        // openExternal 자체가 Remote URI 전달을 처리하므로 asExternalUri를 먼저
        // 적용하지 않는다(VS Code API 계약). 이미 인코딩된 reserved query 문자를
        // Uri.query에 억지로 보존하면 VS Code에서 이중 인코딩되므로 정규 Uri를
        // 넘기고, 결과와 오류에는 검증한 URL을 유지한다. false는 실제로 열리지
        // 않았다는 뜻이다.
        const opened = await deps.openExternal(targetUri);
        if (!opened) {
            throw new Error(t(
                `기본 브라우저에서 주소를 열지 못했습니다: ${resolved.url}`,
                `Could not open the URL in the default browser: ${resolved.url}`,
            ));
        }
        return {
            url: resolved.url,
            ...(resolved.path ? { path: resolved.path } : {}),
        };
    }

    let targetUrl = resolved.url;
    if ((targetUri.scheme === 'http' || targetUri.scheme === 'https') && remoteName) {
        targetUri = await deps.asExternalUri(targetUri);
        // asExternalUri 뒤에는 원본 문자열이 없으므로 VS Code가 반환한 URI의 query
        // delimiter를 보존하는 직렬화가 최선이다.
        targetUrl = targetUri.toString(true);
    }

    const commands = new Set(await deps.getCommands(true));
    if (commands.has(INTEGRATED_BROWSER_COMMAND)) {
        await deps.executeCommand(INTEGRATED_BROWSER_COMMAND, targetUrl);
    } else if ((targetUri.scheme === 'http' || targetUri.scheme === 'https')
        && commands.has(SIMPLE_BROWSER_COMMAND)) {
        await deps.executeCommand(SIMPLE_BROWSER_COMMAND, targetUrl);
    } else if (targetUri.scheme === 'file') {
        throw new Error(t(
            '이 VS Code 버전의 내장 브라우저는 로컬 파일을 열 수 없습니다. VS Code를 업데이트하거나 target을 "default"로 설정하세요.',
            'This VS Code version cannot open local files in the integrated browser. Update VS Code or set target to "default".',
        ));
    } else {
        throw new Error(t(
            '사용 가능한 VS Code 내장 브라우저를 찾을 수 없습니다. VS Code를 업데이트하거나 target을 "default"로 설정하세요.',
            'No VS Code integrated browser is available. Update VS Code or set target to "default".',
        ));
    }

    return {
        url: targetUrl,
        ...(resolved.path ? { path: resolved.path } : {}),
    };
}
