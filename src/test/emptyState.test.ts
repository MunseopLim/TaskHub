import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MainViewProvider } from '../providers/mainViewProvider';
import { ActionItem } from '../schema';

/**
 * "빈 상태 안내(viewsWelcome)" (0.6.15).
 *
 * VS Code는 TreeDataProvider가 **아무 항목도 반환하지 않을 때만** welcome
 * 뷰를 띄운다. Actions 패널은 맨 위에 버전 행을 항상 넣고 있었기 때문에 트리가
 * 절대 비지 않았고, CTA를 선언해도 뜰 수 없는 구조였다.
 *
 * 여기서 고정하는 것:
 *   1. 액션이 없으면 트리가 정말로 빈다 (welcome이 뜰 수 있는 조건)
 *   2. actions.json이 깨졌을 때는 "액션이 없음"이 아니라 에러 행을 보여준다
 *      — 200개짜리 파일을 가진 사용자에게 "첫 액션을 만드세요"는 오안내다
 *   3. manifest의 welcome 항목이 실재하는 명령만 가리킨다
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeContext(version = '9.9.9-test'): vscode.ExtensionContext {
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
        extension: { packageJSON: { version } },
    } as unknown as vscode.ExtensionContext;
}

function labelOf(item: vscode.TreeItem): string | undefined {
    return typeof item.label === 'string' ? item.label : item.label?.label;
}

suite('빈 상태 안내 (viewsWelcome)', () => {

    suite('MainViewProvider 트리', () => {
        test('액션이 없으면 트리가 완전히 빈다 — welcome이 뜰 수 있는 유일한 조건', async () => {
            const provider = new MainViewProvider(makeContext(), () => []);
            const roots = await provider.getChildren();
            assert.deepStrictEqual(roots, [],
                '행이 하나라도 남으면 VS Code는 welcome 뷰를 표시하지 않는다');
        });

        test('버전은 더 이상 트리 행이 아니다', async () => {
            const actions: ActionItem[] = [
                { id: 'build', title: 'Build', action: { description: 'b', tasks: [] } } as unknown as ActionItem,
            ];
            const provider = new MainViewProvider(makeContext('1.2.3-test'), () => actions);
            const roots = await provider.getChildren();

            assert.strictEqual(roots.length, 1);
            assert.strictEqual(labelOf(roots[0]), 'Build');
            assert.strictEqual(roots.some(item => labelOf(item) === '1.2.3-test'), false);
        });

        test('actions.json 로드 실패는 빈 상태가 아니라 에러 행으로 표시된다', async () => {
            const provider = new MainViewProvider(makeContext(), () => {
                throw new Error('Unexpected token } in JSON at position 42');
            });
            const roots = await provider.getChildren();

            assert.strictEqual(roots.length, 1, '에러 행 하나 — 트리가 비면 "액션 없음" CTA가 잘못 뜬다');
            assert.strictEqual(roots[0].contextValue, 'actionsLoadError');
            assert.ok(String(roots[0].description).includes('position 42'),
                '실패 이유가 행에 그대로 보여야 한다');
            assert.strictEqual(roots[0].command?.command, 'taskhub.editActions',
                '클릭하면 문제의 파일로 갈 수 있어야 한다');
        });

        test('에러가 실패한 파일 경로를 담고 있으면 그 파일을 연다 (0.6.24)', async () => {
            // 멀티루트에서 `taskhub.editActions`는 어느 폴더를 편집할지 다시
            // 묻기 때문에, 멀쩡한 파일을 열고 정작 깨진 파일은 감출 수 있다.
            const brokenPath = process.platform === 'win32' ? 'C:\\proj-b\\.vscode\\actions.json' : '/proj-b/.vscode/actions.json';
            const provider = new MainViewProvider(makeContext(), () => {
                const error = new Error('Error parsing JSON in actions.json: Unexpected token }') as Error & { filePath?: string };
                error.filePath = brokenPath;
                throw error;
            });

            const row = (await provider.getChildren())[0];
            assert.strictEqual(row.command?.command, 'vscode.open');
            const target = row.command?.arguments?.[0] as vscode.Uri;
            assert.strictEqual(
                target.fsPath.toLowerCase(),
                vscode.Uri.file(brokenPath).fsPath.toLowerCase(),
                '실패한 파일이 아닌 다른 파일을 열면 사용자는 원인을 찾지 못한다'
            );
        });

        test('경로 없는 에러(소스 간 중복 id 등)는 기존 명령으로 폴백한다', async () => {
            const provider = new MainViewProvider(makeContext(), () => {
                throw new Error('Additional validation failed for workspace: duplicate id');
            });
            const row = (await provider.getChildren())[0];
            assert.strictEqual(row.command?.command, 'taskhub.editActions');
        });

        test('로드가 복구되면 에러 행도 사라진다', async () => {
            let broken = true;
            const provider = new MainViewProvider(makeContext(), () => {
                if (broken) { throw new Error('broken'); }
                return [];
            });

            assert.strictEqual((await provider.getChildren())[0].contextValue, 'actionsLoadError');
            broken = false;
            assert.deepStrictEqual(await provider.getChildren(), []);
        });
    });

    suite('manifest', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
        // 0.6.27부터 본문은 `%welcome.*%` 자리표시자이고 실제 문구는 nls 번들에
        // 있다. 번들을 거쳐 해석하지 않으면 이 검사들이 자리표시자 문자열을
        // 들여다보며 무의미하게 통과한다.
        const nls: Record<string, string> = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf-8')
        );
        const resolveNls = (value: string): string =>
            value.replace(/^%([\w.]+)%$/, (whole, key) => {
                assert.ok(key in nls, `nls 번들에 없는 키를 참조한다: ${whole}`);
                return nls[key];
            });
        const welcomes: Array<{ view: string; when?: string; contents: string }> =
            (manifest.contributes.viewsWelcome ?? []).map((w: any) => ({
                ...w,
                contents: resolveNls(w.contents),
            }));

        test('Actions / Links / Favorites 세 뷰에 빈 상태 안내가 있다', () => {
            for (const view of ['mainView.main', 'mainView.linkWorkspace', 'mainView.favorite']) {
                assert.ok(welcomes.some(w => w.view === view), `${view}에 viewsWelcome이 없다`);
            }
        });

        test('안내가 가리키는 명령이 모두 실재한다', () => {
            const declared = new Set<string>(manifest.contributes.commands.map((c: any) => c.command));
            // VS Code 내장 명령은 확장이 선언하지 않는다.
            const builtin = new Set(['vscode.openFolder']);
            const referenced = welcomes.flatMap(w =>
                Array.from(w.contents.matchAll(/\(command:([^)\s]+)\)/g)).map(m => m[1]));

            assert.ok(referenced.length > 0, '명령 링크가 하나도 없으면 CTA가 아니다');
            for (const id of referenced) {
                assert.ok(declared.has(id) || builtin.has(id), `존재하지 않는 명령을 가리킨다: ${id}`);
            }
        });

        test('폴더가 열리지 않은 상태에는 별도 안내가 있다', () => {
            const empty = welcomes.filter(w => w.when === 'workbenchState == empty');
            assert.ok(empty.length > 0, '폴더 없이 시작한 사용자에게 "액션 만들기"는 실행 불가능한 안내다');
            assert.ok(empty.every(w => w.contents.includes('vscode.openFolder')));
        });

        test('제목 표시줄 아이콘은 3개 이하로 유지된다 (하나는 실행 중에만)', () => {
            const navigation = manifest.contributes.menus['view/title']
                .filter((e: any) => e.when.includes('mainView.main') && String(e.group).startsWith('navigation'));
            assert.ok(navigation.length <= 3,
                `아이콘 줄이 다시 늘어났다 (${navigation.length}개): ${navigation.map((e: any) => e.command).join(', ')}`);
            const conditional = navigation.filter((e: any) => e.when.includes('taskhub.hasRunningActions'));
            assert.strictEqual(conditional.length, 1, '중지 버튼은 조건부 하나여야 한다');
        });
    });
});
