import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BuiltinActionsMode, shouldIncludeBuiltinActions } from '../extension';

/**
 * "내장 예제 액션을 목록에서 분리" (0.6.14).
 *
 * 확장에 번들된 `media/actions.json`(`defaultButton.*`)은 모든 워크스페이스의
 * 액션 목록에 무조건 병합됐고 끄는 수단도 없었다. 사용자가 넣지 않은 항목이
 * 자기 프로젝트 작업 목록 한가운데 섞이는 상태였다.
 *
 * `taskhub.builtinActions`가 이를 세 가지로 가른다. `auto`는 프로젝트가
 * 아직 아무것도 갖고 있지 않을 때만 예제를 보여준다 — 온보딩 역할은 남기고,
 * 사용자가 자기 액션을 만드는 순간 비켜난다.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

suite('내장 예제 액션 노출 정책', () => {

    suite('shouldIncludeBuiltinActions', () => {
        const empty = { hasWorkspaceActions: false, hasPresetActions: false };
        const withWorkspace = { hasWorkspaceActions: true, hasPresetActions: false };
        const withPreset = { hasWorkspaceActions: false, hasPresetActions: true };
        const withBoth = { hasWorkspaceActions: true, hasPresetActions: true };

        // 0.6.24: auto의 의미가 바뀌었다. 0.6.14의 auto는 "프로젝트가 비었을
        // 때 예제를 트리에 넣는다"였지만, 그 주입이 0.6.15의 빈 화면 CTA를
        // 무력화했다 — VS Code는 트리가 완전히 비어야 welcome을 띄운다.
        // 이제 auto는 트리에 넣지 않고, CTA의 'Browse Examples' 버튼이 예제
        // 접근을 담당한다.
        test('auto: 빈 프로젝트에서도 예제를 트리에 넣지 않는다 (CTA가 대신함)', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('auto', empty), false,
                '예제가 주입되면 트리가 비지 않아 Create Action CTA가 뜰 수 없다');
        });

        test('auto: 자기 액션이 있는 프로젝트에서도 당연히 넣지 않는다', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('auto', withWorkspace), false);
            assert.strictEqual(shouldIncludeBuiltinActions('auto', withPreset), false);
            assert.strictEqual(shouldIncludeBuiltinActions('auto', withBoth), false);
        });

        test('always: 0.6.14 이전 동작 — 무조건 병합', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('always', empty), true);
            assert.strictEqual(shouldIncludeBuiltinActions('always', withBoth), true);
        });

        test('never: 빈 프로젝트에서도 보여주지 않는다', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('never', empty), false);
            assert.strictEqual(shouldIncludeBuiltinActions('never', withBoth), false);
        });

        test('auto와 never는 트리 주입 여부에서 같고, CTA 노출로만 갈린다', () => {
            // 두 값의 차이는 viewsWelcome의 when 절이 담당한다 (아래 manifest
            // 스위트에서 고정). 주입 로직에서는 동일해야 한다.
            for (const combo of [empty, withWorkspace, withPreset, withBoth]) {
                assert.strictEqual(
                    shouldIncludeBuiltinActions('auto', combo),
                    shouldIncludeBuiltinActions('never', combo)
                );
            }
        });

        test('세 모드 모두 hasWorkspaceActions/hasPresetActions 조합에 대해 결정적이다', () => {
            const modes: BuiltinActionsMode[] = ['auto', 'always', 'never'];
            const combos = [empty, withWorkspace, withPreset, withBoth];
            for (const mode of modes) {
                for (const combo of combos) {
                    const first = shouldIncludeBuiltinActions(mode, combo);
                    assert.strictEqual(shouldIncludeBuiltinActions(mode, combo), first,
                        `${mode}/${JSON.stringify(combo)} 결과가 호출마다 달라지면 캐시와 어긋난다`);
                }
            }
        });
    });

    suite('manifest / 번들 정합성', () => {
        test('taskhub.builtinActions 설정이 3-way enum이고 기본값은 auto', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
            const setting = pkg.contributes.configuration.properties['taskhub.builtinActions'];
            assert.ok(setting, '설정이 선언되어 있어야 한다');
            assert.deepStrictEqual(setting.enum, ['auto', 'always', 'never']);
            assert.strictEqual(setting.default, 'auto');
            assert.strictEqual(setting.enumDescriptions?.length, 3,
                'enum 값마다 설명이 붙어야 설정 UI에서 고를 수 있다');
        });

        test('빈 상태 CTA가 설정에 따라 두 갈래로 선언된다', () => {
            const welcomes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
                .contributes.viewsWelcome
                .filter((w: any) => w.view === 'mainView.main' && String(w.when).includes('workbenchState != empty'));

            assert.strictEqual(welcomes.length, 2, 'never 여부로 갈리는 두 변형이 있어야 한다');

            const withExamples = welcomes.find((w: any) => w.when.includes('!= never'));
            const withoutExamples = welcomes.find((w: any) => w.when.includes('== never'));
            assert.ok(withExamples && withoutExamples, `when 절이 상호 배타적이지 않다: ${welcomes.map((w: any) => w.when)}`);
            assert.ok(withExamples.contents.includes('showExampleJsonQuickPick'),
                'auto에서는 Browse Examples를 제공해야 한다');
            assert.ok(!withoutExamples.contents.includes('showExampleJsonQuickPick'),
                'never에서는 예제 버튼도 숨겨야 auto와 구분된다');
            for (const welcome of welcomes) {
                assert.ok(welcome.contents.includes('taskhub.createAction'), '두 변형 모두 주 CTA는 유지');
            }
        });

        test('번들 예제 파일은 여전히 존재한다 (always 모드와 Browse Examples가 읽을 대상)', () => {
            const mediaPath = path.join(REPO_ROOT, 'media', 'actions.json');
            assert.ok(fs.existsSync(mediaPath), 'media/actions.json이 사라지면 온보딩 경로가 빈다');
            const parsed = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
            assert.ok(Array.isArray(parsed) && parsed.length > 0);
        });
    });
});
