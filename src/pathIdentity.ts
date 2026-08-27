import * as path from 'path';

/**
 * 파일을 Map 키로 사용할 때의 플랫폼별 identity를 만든다.
 *
 * Windows 파일 시스템은 대소문자를 구분하지 않고, VS Code의 `Uri.file()`은
 * 드라이브 문자를 소문자로 바꿀 수 있다. 표시용 경로까지 바꾸지 않고 identity만
 * case-fold해 같은 파일이 서로 다른 패널로 취급되는 것을 막는다.
 */
export function filePathIdentityKey(
    filePath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const resolved = pathApi.resolve(filePath);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
