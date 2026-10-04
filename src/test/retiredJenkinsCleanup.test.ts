import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
    RETIRED_JENKINS_SERVERS_KEY,
    RETIRED_JENKINS_WORKSPACE_KEYS,
    removeRetiredJenkinsData,
} from '../retiredJenkinsCleanup';

function createMemento(initial: Record<string, unknown> = {}): { memento: vscode.Memento; values: Map<string, unknown>; writes: string[] } {
    const values = new Map<string, unknown>(Object.entries(initial));
    const writes: string[] = [];
    const memento = {
        get: <T>(key: string, defaultValue?: T) => values.has(key) ? values.get(key) as T : defaultValue,
        update: async (key: string, value: unknown) => {
            writes.push(key);
            if (value === undefined) { values.delete(key); } else { values.set(key, value); }
        },
        keys: () => [...values.keys()],
    } as vscode.Memento;
    return { memento, values, writes };
}

function createSecrets(keys: string[], failOn?: string): { secrets: vscode.SecretStorage; stored: Set<string>; deletes: string[] } {
    const stored = new Set(keys);
    const deletes: string[] = [];
    const secrets = {
        get: async (key: string) => stored.has(key) ? 'token' : undefined,
        store: async (key: string) => { stored.add(key); },
        delete: async (key: string) => {
            deletes.push(key);
            if (key === failOn) { throw new Error('keychain locked'); }
            stored.delete(key);
        },
        keys: async () => [...stored],
        onDidChange: (() => ({ dispose() { /* noop */ } })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>,
    } as unknown as vscode.SecretStorage;
    return { secrets, stored, deletes };
}

// 0.8.58까지의 저장 형식으로 만든 token 키. 계산식이 바뀌면 기존 사용자의 token이 지워지지 않고 남는다.
const ALICE_TOKEN_KEY = 'taskhub.jenkins.token.s1.a3868d55947df3f00fbf24b29971dc8d5aebde4c21563b07ee4cdbcd2874e95a';
const ALICE = { id: 's1', name: 'CI', url: 'https://ci.example.com/jenkins/', username: 'alice' };
const BOB = { id: 's2', name: 'Lab', url: 'http://10.0.0.5:8080/', username: 'bob' };
const BOB_TOKEN_KEY = 'taskhub.jenkins.token.s2.f28c395ff84182c7a118c274f5bab7f93afbf7e8fd975c34fba2888e242ab1d5';

suite('제거된 Jenkins 데이터 정리', () => {
    test('저장된 서버의 API token과 서버 목록·요청 이력을 지운다', async () => {
        const global = createMemento({ [RETIRED_JENKINS_SERVERS_KEY]: [ALICE, { id: 'broken' }], other: 1 });
        const workspace = createMemento({ [RETIRED_JENKINS_WORKSPACE_KEYS[0]]: [{ id: 'r1' }], [RETIRED_JENKINS_WORKSPACE_KEYS[1]]: [], keep: true });
        const { secrets, stored } = createSecrets([ALICE_TOKEN_KEY, 'unrelated.secret']);

        await removeRetiredJenkinsData({ globalState: global.memento, workspaceState: workspace.memento, secrets });

        assert.deepStrictEqual([...stored], ['unrelated.secret']);
        assert.deepStrictEqual([...global.values.keys()], ['other']);
        assert.deepStrictEqual([...workspace.values.keys()], ['keep']);
    });

    test('정리할 데이터가 없으면 저장소에 쓰지 않는다', async () => {
        const global = createMemento({ other: 1 });
        const workspace = createMemento();
        const { secrets, deletes } = createSecrets([]);

        await removeRetiredJenkinsData({ globalState: global.memento, workspaceState: workspace.memento, secrets });

        assert.deepStrictEqual(global.writes, []);
        assert.deepStrictEqual(workspace.writes, []);
        assert.deepStrictEqual(deletes, []);
    });

    test('서버 목록을 다른 창이 먼저 지운 워크스페이스에서도 이력만 지운다', async () => {
        const global = createMemento();
        const workspace = createMemento({ [RETIRED_JENKINS_WORKSPACE_KEYS[0]]: [{ id: 'r1' }], [RETIRED_JENKINS_WORKSPACE_KEYS[1]]: [] });
        const { secrets, deletes } = createSecrets([]);

        await removeRetiredJenkinsData({ globalState: global.memento, workspaceState: workspace.memento, secrets });

        assert.strictEqual(workspace.values.size, 0);
        assert.deepStrictEqual(global.writes, []);
        assert.deepStrictEqual(deletes, []);
    });

    test('손상된 서버 목록 값은 token 삭제 없이 지운다', async () => {
        for (const corrupt of [{}, 'x', 42, null]) {
            const global = createMemento({ [RETIRED_JENKINS_SERVERS_KEY]: corrupt });
            const { secrets, deletes } = createSecrets([]);

            await removeRetiredJenkinsData({ globalState: global.memento, workspaceState: createMemento().memento, secrets });

            assert.ok(!global.values.has(RETIRED_JENKINS_SERVERS_KEY), JSON.stringify(corrupt));
            assert.deepStrictEqual(deletes, []);
        }
    });

    test('token 삭제가 실패하면 서버 목록을 남겨 다음 활성화에서 다시 시도한다', async () => {
        const global = createMemento({ [RETIRED_JENKINS_SERVERS_KEY]: [ALICE, BOB] });
        const workspace = createMemento({ [RETIRED_JENKINS_WORKSPACE_KEYS[0]]: [{ id: 'r1' }] });
        const failing = createSecrets([ALICE_TOKEN_KEY, BOB_TOKEN_KEY], ALICE_TOKEN_KEY);

        await assert.rejects(removeRetiredJenkinsData({ globalState: global.memento, workspaceState: workspace.memento, secrets: failing.secrets }), /keychain locked/);
        assert.deepStrictEqual(failing.deletes, [ALICE_TOKEN_KEY], '실패 뒤의 서버는 이번 회차에서 시도하지 않는다');
        assert.ok(global.values.has(RETIRED_JENKINS_SERVERS_KEY));
        assert.strictEqual(workspace.values.size, 0, 'token과 무관한 이력은 보안 저장소 장애와 관계없이 지운다');

        const retry = createSecrets([ALICE_TOKEN_KEY, BOB_TOKEN_KEY]);
        await removeRetiredJenkinsData({ globalState: global.memento, workspaceState: workspace.memento, secrets: retry.secrets });
        assert.strictEqual(retry.stored.size, 0);
        assert.ok(!global.values.has(RETIRED_JENKINS_SERVERS_KEY));
    });
});
