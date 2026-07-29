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
        // 0.6.32: 판단이 모드 하나에만 달려 있다는 사실을 시그니처가 드러낸다.
        // 이전에는 hasWorkspaceActions / hasPresetActions도 받았는데(0.6.14의
        // auto가 참조했다), 0.6.24에서 auto가 그것들을 보지 않게 된 뒤에도
        // "나중에 필요할지 몰라" 남아 있었다. 읽는 사람에게는 그 입력이 결과에
        // 영향을 준다는 잘못된 신호였고, 호출부는 쓰지 않을 값을 계산했다.

        // 0.6.24: auto의 의미가 바뀌었다. 0.6.14의 auto는 "프로젝트가 비었을
        // 때 예제를 트리에 넣는다"였지만, 그 주입이 0.6.15의 빈 화면 CTA를
        // 무력화했다 — VS Code는 트리가 완전히 비어야 welcome을 띄운다.
        // 이제 auto는 트리에 넣지 않고, CTA의 'Browse Examples' 버튼이 예제
        // 접근을 담당한다.
        test('auto: 예제를 트리에 넣지 않는다 (CTA가 대신함)', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('auto'), false,
                '예제가 주입되면 트리가 비지 않아 Create Action CTA가 뜰 수 없다');
        });

        test('always: 0.6.14 이전 동작 — 무조건 병합', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('always'), true);
        });

        test('never: 보여주지 않는다', () => {
            assert.strictEqual(shouldIncludeBuiltinActions('never'), false);
        });

        test('auto와 never는 트리 주입 여부에서 같고, CTA 노출로만 갈린다', () => {
            // 두 값의 차이는 viewsWelcome의 when 절이 담당한다 (아래 manifest
            // 스위트에서 고정). 주입 로직에서는 동일해야 한다.
            assert.strictEqual(
                shouldIncludeBuiltinActions('auto'),
                shouldIncludeBuiltinActions('never')
            );
        });

        test('세 모드 모두 결정적이다', () => {
            const modes: BuiltinActionsMode[] = ['auto', 'always', 'never'];
            for (const mode of modes) {
                const first = shouldIncludeBuiltinActions(mode);
                assert.strictEqual(shouldIncludeBuiltinActions(mode), first,
                    `${mode} 결과가 호출마다 달라지면 캐시와 어긋난다`);
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
            // 0.6.27부터 본문은 `%welcome.*%` 자리표시자이므로 nls 번들을 거쳐
            // 해석한다. 해석하지 않으면 아래 `contents.includes(...)` 검사가
            // 자리표시자만 들여다보며 전부 실패한다.
            const nls: Record<string, string> = JSON.parse(
                fs.readFileSync(path.join(REPO_ROOT, 'package.nls.json'), 'utf-8')
            );
            const welcomes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
                .contributes.viewsWelcome
                .filter((w: any) => w.view === 'mainView.main' && String(w.when).includes('workbenchState != empty'))
                .map((w: any) => ({
                    ...w,
                    contents: String(w.contents).replace(/^%([\w.]+)%$/, (whole: string, key: string) => {
                        assert.ok(key in nls, `nls 번들에 없는 키를 참조한다: ${whole}`);
                        return nls[key];
                    }),
                }));

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

        /**
         * 번들 액션은 **모든 사용자가 설치 직후 실행할 수 있는** 것이고, 새 액션을
         * 만들 때 베끼는 본보기이기도 하다. 0.6.47 이 `shell` 을 raw 셸 실행으로
         * 바꾼 뒤 `printenv ${input_env_name.value}` 는 사용자가 입력한 이름에
         * `; ...` 가 있으면 뒤의 명령까지 실행하는 형태가 됐다 — 우리가 문서로
         * 금지한 패턴을 우리가 배포하고 있었다.
         */
        test('번들 액션은 raw shell 에 값을 보간하지 않는다', () => {
            const mediaPath = path.join(REPO_ROOT, 'media', 'actions.json');
            const parsed = JSON.parse(fs.readFileSync(mediaPath, 'utf-8'));
            const offenders: string[] = [];
            for (const item of parsed) {
                for (const task of item?.action?.tasks ?? []) {
                    if (task.type !== 'shell') { continue; }
                    const branches = typeof task.command === 'string'
                        ? [task.command]
                        : Object.values(task.command ?? {}).filter((v): v is string => typeof v === 'string');
                    if (branches.some(branch => /\$\{[^}]+\}/.test(branch))) {
                        offenders.push(`${item.id}.${task.id}`);
                    }
                }
            }
            assert.deepStrictEqual(
                offenders, [],
                `번들 액션이 raw 셸에 값을 끼워 넣는다 (command 타입이나 args 를 쓸 것): ${offenders.join(', ')}`
            );
        });
    });
});
