import type * as vscode from 'vscode';
import { createHash } from 'crypto';

// 0.8.59에서 제거한 Jenkins 연동이 남긴 저장 키. 새 기능에서 같은 이름을 재사용하지 않는다.
export const RETIRED_JENKINS_SERVERS_KEY = 'taskhub.jenkins.servers.v1';
export const RETIRED_JENKINS_WORKSPACE_KEYS = ['taskhub.jenkins.requests.v1', 'taskhub.jenkins.jobs.v1'] as const;

function retiredSecretKey(server: { id: string; url: string; username: string }): string {
    const identity = createHash('sha256').update(`${server.url}\n${server.username}`).digest('hex');
    return `taskhub.jenkins.token.${server.id}.${identity}`;
}

/**
 * 제거된 Jenkins 기능의 API token과 이력을 지운다. token에 의존하지 않는 워크스페이스 이력을 먼저 지우고,
 * 서버 목록은 token 뒤에 지우므로 token 삭제가 실패해도 다음 활성화에서 같은 목록으로 다시 시도한다.
 * 데이터가 없으면 아무것도 쓰지 않는다.
 */
export async function removeRetiredJenkinsData(
    context: { globalState: vscode.Memento; workspaceState: vscode.Memento; secrets: Pick<vscode.SecretStorage, 'delete'> }
): Promise<void> {
    for (const key of RETIRED_JENKINS_WORKSPACE_KEYS) {
        if (context.workspaceState.get(key) !== undefined) {
            await context.workspaceState.update(key, undefined);
        }
    }
    const servers = context.globalState.get<unknown>(RETIRED_JENKINS_SERVERS_KEY);
    if (Array.isArray(servers)) {
        for (const server of servers) {
            if (server && typeof server === 'object'
                && ['id', 'url', 'username'].every(key => typeof (server as Record<string, unknown>)[key] === 'string')) {
                await context.secrets.delete(retiredSecretKey(server as { id: string; url: string; username: string }));
            }
        }
    }
    if (servers !== undefined) {
        await context.globalState.update(RETIRED_JENKINS_SERVERS_KEY, undefined);
    }
}
