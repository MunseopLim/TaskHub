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

        test('auto: 프로젝트에 액션이 없으면 예제를 보여준다 (온보딩)', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('auto', empty), true);
        });

        test('auto: 워크스페이스 actions.json이 생기면 예제가 사라진다', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('auto', withWorkspace), false);
        });

        test('auto: 프리셋을 적용한 것도 "자기 액션이 있다"로 본다', () => {
            // 프리셋은 사용자가 taskhub.preset.selected로 직접 켠 것이므로
            // 그 목록에 데모 버튼이 섞일 이유가 없다.
            assert.strictEqual(shouldIncludeBuiltinActions('auto', withPreset), false);
        });

        test('auto: 둘 다 있으면 당연히 숨긴다', () => {
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

        test('번들 예제 파일은 여전히 존재한다 (auto 경로가 읽을 대상)', () => {
            const mediaPath = path.join(REPO_ROOT, 'media', 'actions.json');
            assert.ok(fs.existsSync(mediaPath), 'media/actions.json이 사라지면 온보딩 경로가 빈다');
            const parsed = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
            assert.ok(Array.isArray(parsed) && parsed.length > 0);
        });
    });
});
