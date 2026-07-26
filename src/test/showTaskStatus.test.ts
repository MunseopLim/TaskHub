import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { Action, MainViewProvider } from '../providers/mainViewProvider';
import { actionStates } from '../providers/actionStatus';
import { ActionItem, Action as PipelineAction } from '../schema';

/**
 * "`showTaskStatus=false`가 실제로 적용되도록" (0.6.16).
 *
 * 설정은 실행 직후의 refresh만 억제했을 뿐, `Action` TreeItem은 설정을 보지
 * 않고 `actionStates`에서 아이콘을 그렸다. 그래서 폴더를 접었다 펴거나 파일
 * 워처가 트리를 다시 그리면 꺼 놓은 상태 아이콘이 되살아났다.
 *
 * 핵심 구분: **모양(iconPath / description)은 설정으로 가리고,
 * 능력(contextValue)은 가리지 않는다.** 상태 표시를 껐다고 실행 중인 액션의
 * 중지 버튼까지 사라지면 안 된다.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        extensionPath: REPO_ROOT,
        subscriptions: [],
        workspaceState: {
            get: <T>(key: string, defaultValue?: T) => state.has(key) ? state.get(key) as T : defaultValue,
            update: (key: string, value: unknown) => { state.set(key, value); return Promise.resolve(); },
            keys: () => Array.from(state.keys()),
        },
        globalState: {
            get: <T>(_key: string, defaultValue?: T) => defaultValue,
            update: () => Promise.resolve(),
            keys: () => [],
            setKeysForSync: () => { },
        },
        extension: { packageJSON: { version: '0.0.0-test' } },
    } as unknown as vscode.ExtensionContext;
}

const multiTask: PipelineAction = {
    description: 'build',
    tasks: [
        { id: 'a', type: 'shell', command: 'echo a' },
        { id: 'b', type: 'shell', command: 'echo b' },
    ],
} as unknown as PipelineAction;

const singleShell: PipelineAction = {
    description: 'flash',
    tasks: [{ id: 'run', type: 'shell', command: 'echo flash' }],
} as unknown as PipelineAction;

function iconIdOf(item: vscode.TreeItem): string | undefined {
    return (item.iconPath as vscode.ThemeIcon | undefined)?.id;
}

suite('showTaskStatus 렌더 게이트', () => {

    teardown(() => {
        actionStates.clear();
    });

    suite('Action TreeItem', () => {
        test('설정이 꺼져 있으면 성공 아이콘 대신 타입 기본 아이콘을 쓴다', () => {
            actionStates.set('build', { state: 'success' });
            const item = new Action('Build', multiTask, vscode.TreeItemCollapsibleState.None, makeContext(), 'build', false);

            assert.strictEqual(iconIdOf(item), 'debug-alt', '✓ 아이콘이 남아 있으면 설정이 무시된 것');
            assert.strictEqual(item.description, undefined);
        });

        test('설정이 꺼져 있어도 contextValue는 실제 상태를 유지한다 (중지 버튼 보존)', () => {
            actionStates.set('build', { state: 'running', progress: { total: 2, completed: 0, running: [{ taskId: 'a', index: 1 }] } });
            const item = new Action('Build', multiTask, vscode.TreeItemCollapsibleState.None, makeContext(), 'build', false);

            assert.strictEqual(item.contextValue, 'runningAction',
                'contextValue까지 가리면 실행 중인 액션을 트리에서 멈출 수 없게 된다');
            assert.strictEqual(iconIdOf(item), 'debug-alt', '스피너는 보이면 안 된다');
            assert.strictEqual(item.description, undefined, '진행률도 상태 표시의 일부다');
        });

        test('설정이 꺼져 있으면 실패도 시각적으로 드러나지 않는다', () => {
            actionStates.set('flash', { state: 'failure' });
            const item = new Action('Flash', singleShell, vscode.TreeItemCollapsibleState.None, makeContext(), 'flash', false);

            assert.strictEqual(iconIdOf(item), 'terminal');
            assert.strictEqual(item.contextValue, 'failedAction');
        });

        test('설정이 켜져 있으면 기존 동작 그대로', () => {
            actionStates.set('build', { state: 'running', progress: { total: 2, completed: 0, running: [{ taskId: 'a', index: 1 }] } });
            const item = new Action('Build', multiTask, vscode.TreeItemCollapsibleState.None, makeContext(), 'build', true);

            assert.strictEqual(iconIdOf(item), 'sync~spin');
            assert.strictEqual(item.description, '1/2 · a');
            assert.strictEqual(item.contextValue, 'runningAction');
        });

        test('인자를 생략하면 켜진 것으로 본다 (기존 호출부 호환)', () => {
            actionStates.set('build', { state: 'success' });
            const item = new Action('Build', multiTask, vscode.TreeItemCollapsibleState.None, makeContext(), 'build');
            assert.strictEqual(iconIdOf(item), 'check');
        });

        test('실행 이력이 없는 액션은 설정과 무관하게 타입 아이콘', () => {
            const on = new Action('Flash', singleShell, vscode.TreeItemCollapsibleState.None, makeContext(), 'flash', true);
            const off = new Action('Flash', singleShell, vscode.TreeItemCollapsibleState.None, makeContext(), 'flash', false);
            assert.strictEqual(iconIdOf(on), 'terminal');
            assert.strictEqual(iconIdOf(off), 'terminal');
            assert.strictEqual(on.contextValue, 'action');
            assert.strictEqual(off.contextValue, 'action');
        });
    });

    suite('MainViewProvider 배선 (실제 설정)', () => {
        const actions: ActionItem[] = [
            { id: 'build', title: 'Build', action: multiTask } as unknown as ActionItem,
        ];

        async function withSetting<T>(value: boolean | undefined, run: () => Promise<T> | T): Promise<T> {
            const config = vscode.workspace.getConfiguration('taskhub');
            await config.update('showTaskStatus', value, vscode.ConfigurationTarget.Global);
            try {
                return await run();
            } finally {
                await config.update('showTaskStatus', undefined, vscode.ConfigurationTarget.Global);
            }
        }

        test('provider가 설정을 읽어 각 행에 전달한다 — 재렌더에도 아이콘이 되살아나지 않는다', async () => {
            actionStates.set('build', { state: 'success' });
            const provider = new MainViewProvider(makeContext(), () => actions);

            await withSetting(false, async () => {
                const first = (await provider.getChildren())[0];
                assert.strictEqual(iconIdOf(first), 'debug-alt');

                // 폴더 펼침/워처 등으로 트리가 다시 그려지는 상황을 모사.
                const second = (await provider.getChildren())[0];
                assert.strictEqual(iconIdOf(second), 'debug-alt',
                    '재렌더 시 상태 아이콘이 돌아오면 설정이 반쪽짜리다');
            });
        });

        test('설정을 다시 켜면 상태 아이콘이 돌아온다', async () => {
            actionStates.set('build', { state: 'success' });
            const provider = new MainViewProvider(makeContext(), () => actions);

            await withSetting(true, async () => {
                assert.strictEqual(iconIdOf((await provider.getChildren())[0]), 'check');
            });
        });
    });
});
