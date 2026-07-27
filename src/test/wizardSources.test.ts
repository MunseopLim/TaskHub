import * as assert from 'assert';
import { ActionItem } from '../schema';
import {
    collectTakenActionIds,
    deriveActionIdFromTitle,
    validateActionIdInput,
    wizardTakenActionIds,
} from '../extension';

/**
 * 마법사가 보는 "이미 쓰인 ID" 범위 (0.6.32).
 *
 * 마법사는 새 액션의 id를 제목에서 도출하고(`deriveActionIdFromTitle`)
 * 충돌하면 `-2`를 붙인다. 그 판단의 입력이 `existingIds`인데, 0.6.31까지
 * **대상 폴더의 파일 + 번들 예제**만 담고 있었다. 두 방향 모두 틀렸다.
 *
 *   - 번들 예제는 `taskhub.builtinActions`가 숨겨도 id가 예약된 채였다.
 *     목록에 없는 액션 때문에 `펌웨어-빌드-2` 같은 id가 생긴다.
 *   - 선택된 preset과 **다른 워크스페이스 폴더**는 아예 보이지 않았다.
 *     그쪽과 같은 id를 만들어도 아무 오류가 없다 — 교차 소스 중복은 출력
 *     채널 경고일 뿐이고, `mergeActions`가 우선순위로 조용히 해소한다.
 *     결과는 둘 중 하나가 그림자에 가려지는 것이고,
 *     `taskhub.runAction.<id>`가 어느 쪽을 실행할지는 순회 순서에 달린다.
 *
 * 수정은 트리 로더와 같은 resolver(`collectEffectiveActionSources`)를 쓰게
 * 한 것이다. 여기서는 그 결과를 소비하는 순수 함수를 고정한다 — resolver
 * 자체는 VS Code 설정과 워크스페이스에 의존해 단위 테스트로 가둘 수 없다.
 */
suite('마법사가 보는 기존 ID 범위', () => {

    const action = (id: string): ActionItem =>
        ({ id, title: id, action: { description: '', tasks: [] } }) as unknown as ActionItem;

    const folder = (id: string, children: ActionItem[]): ActionItem =>
        ({ id, title: id, type: 'folder', children }) as unknown as ActionItem;

    suite('collectTakenActionIds', () => {
        test('여러 소스의 id를 하나로 모은다', () => {
            const taken = collectTakenActionIds([
                { actions: [action('fw-build')] },
                { actions: [action('preset-deploy')] },
                { actions: [action('other-folder-test')] },
            ]);

            assert.deepStrictEqual(
                Array.from(taken).sort(),
                ['fw-build', 'other-folder-test', 'preset-deploy']
            );
        });

        test('폴더 안에 중첩된 id도 센다', () => {
            // 폴더 하위 액션과 충돌해도 파일 로드가 실패하므로 반드시 포함해야 한다.
            const taken = collectTakenActionIds([
                { actions: [folder('group', [action('nested'), action('deep')])] },
            ]);

            assert.ok(taken.has('nested'));
            assert.ok(taken.has('deep'));
        });

        test('소스가 없으면 빈 집합 (첫 액션 생성 경로)', () => {
            assert.strictEqual(collectTakenActionIds([]).size, 0);
        });

        test('같은 id가 두 소스에 있어도 한 번만 센다', () => {
            const taken = collectTakenActionIds([
                { actions: [action('dup')] },
                { actions: [action('dup')] },
            ]);
            assert.strictEqual(taken.size, 1);
        });
    });

    suite('도출된 id가 다른 소스와 충돌하지 않는다', () => {
        test('preset이 쓰는 id면 마법사가 접미사를 붙인다', () => {
            // 0.6.31까지는 preset이 보이지 않아 그대로 `deploy`가 나왔고,
            // 저장 후 둘 중 하나가 조용히 그림자에 가려졌다.
            const taken = collectTakenActionIds([
                { actions: [] },                         // 대상 폴더는 비어 있다
                { actions: [action('deploy')] },         // preset
            ]);

            assert.strictEqual(deriveActionIdFromTitle('Deploy', taken), 'deploy-2');
        });

        test('다른 워크스페이스 폴더가 쓰는 id도 마찬가지', () => {
            const taken = collectTakenActionIds([
                { actions: [] },
                { actions: [action('build')] },          // 다른 폴더
            ]);

            assert.strictEqual(deriveActionIdFromTitle('Build', taken), 'build-2');
        });

        test('숨겨진 번들 예제는 더 이상 id를 예약하지 않는다', () => {
            // `builtinActions`가 auto/never면 resolver가 번들을 빈 소스로
            // 돌려주므로, 사용자가 defaultButton.* 이름을 써도 막히지 않는다.
            const taken = collectTakenActionIds([
                { actions: [] },
                { actions: [] },                         // 숨겨진 번들
            ]);

            assert.strictEqual(deriveActionIdFromTitle('showEnv', taken), 'showenv');
            assert.strictEqual(validateActionIdInput('defaultButton.showEnv', taken), undefined);
        });
    });

    /**
     * 배선 자체를 고정한다.
     *
     * `collectTakenActionIds`만 검사하면 마법사가 `otherSources`를 넘기지 않게
     * 되돌아가도 전부 통과한다 — 결함이 있던 자리가 정확히 그 인자였다.
     * 그래서 호출부를 `wizardTakenActionIds`로 뽑아 두 인자를 함께 못박는다.
     */
    suite('wizardTakenActionIds — 두 인자를 모두 본다', () => {
        test('대상 폴더와 다른 소스를 모두 포함한다', () => {
            const taken = wizardTakenActionIds({
                workspaceActions: [action('own-build')],
                otherSources: [
                    { actions: [action('bundled-demo')] },
                    { actions: [action('preset-deploy')] },
                    { actions: [action('sibling-test')] },
                ],
            });

            assert.deepStrictEqual(
                Array.from(taken).sort(),
                ['bundled-demo', 'own-build', 'preset-deploy', 'sibling-test']
            );
        });

        test('otherSources를 빠뜨리면 다른 소스의 id가 사라진다 (회귀 형태 고정)', () => {
            // 0.6.31 이전 동작을 재현해, 무엇이 없어지는지 명시한다.
            const withOthers = wizardTakenActionIds({
                workspaceActions: [action('own')],
                otherSources: [{ actions: [action('elsewhere')] }],
            });
            const withoutOthers = wizardTakenActionIds({
                workspaceActions: [action('own')],
                otherSources: [],
            });

            assert.ok(withOthers.has('elsewhere'));
            assert.ok(!withoutOthers.has('elsewhere'),
                '이 차이가 사라지면 두 경로가 다시 갈라져도 테스트가 침묵한다');
        });

        test('대상 폴더가 비어 있어도 다른 소스는 그대로 반영된다', () => {
            const taken = wizardTakenActionIds({
                workspaceActions: [],
                otherSources: [{ actions: [action('preset-only')] }],
            });
            assert.ok(taken.has('preset-only'), '첫 액션을 만드는 프로젝트에서도 충돌은 막아야 한다');
        });
    });

    suite('확인 단계의 수동 ID 입력도 같은 범위를 본다', () => {
        test('다른 소스가 쓰는 id를 직접 입력하면 거부한다', () => {
            const taken = collectTakenActionIds([
                { actions: [action('fw-build')] },
                { actions: [action('preset-deploy')] },
            ]);

            assert.ok(validateActionIdInput('preset-deploy', taken),
                '자동 도출만 막고 수동 입력을 열어 두면 같은 충돌이 그대로 생긴다');
            assert.strictEqual(validateActionIdInput('brand-new', taken), undefined);
        });
    });
});
