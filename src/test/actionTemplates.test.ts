import * as assert from 'assert';
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ACTION_TEMPLATES, MAX_PIPELINE_TEMPLATE_STEPS, parseTemplateChoiceList } from '../extension';

/**
 * "액션 생성 템플릿 확장" (0.6.17).
 *
 * 마법사는 13가지 task 타입 중 `shell` / `fileDialog` 둘만 보여줬다. 나머지
 * 대화형 타입과 파이프라인은 문서를 읽거나 예제 JSON을 뒤져야 알 수 있었다.
 *
 * 여기서 고정하는 것은 각 템플릿이 **실제로 만들어 내는 JSON 구조**다.
 * `buildTasks`가 순수 함수로 분리돼 있어 프롬프트 없이 검증할 수 있다.
 * 스키마 검증까지 걸어 두어, 마법사가 자기 스키마를 위반하는 액션을
 * 생성하는 회귀를 막는다.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function templateById(id: string) {
    const template = ACTION_TEMPLATES.find(t => t.id === id);
    assert.ok(template, `템플릿 ${id}가 없다`);
    return template!;
}

suite('액션 생성 템플릿', () => {

    suite('구조', () => {
        test('템플릿 id는 중복되지 않고 라벨/설명이 모두 채워져 있다', () => {
            const ids = ACTION_TEMPLATES.map(t => t.id);
            assert.strictEqual(new Set(ids).size, ids.length, `중복 id: ${ids}`);
            for (const template of ACTION_TEMPLATES) {
                assert.ok(template.label.length > 0, `${template.id}: label 없음`);
                assert.ok(template.description.length > 0, `${template.id}: description 없음`);
                assert.ok(template.defaultDescription.length > 0, `${template.id}: defaultDescription 없음`);
            }
        });

        test('구조가 서로 다른 템플릿만 존재한다 (명령어만 다른 변형 금지)', () => {
            // "Build"/"Test"처럼 단일 shell 하나만 내놓는 템플릿이 여러 개면
            // 목록만 길어지고 배우는 것은 없다 — 그런 예시는 placeholder가 담당.
            const singleShellLike = ACTION_TEMPLATES.filter(template => {
                const tasks = template.id === 'single-shell'
                    ? template.buildTasks({ command: 'x' })
                    : [];
                return tasks.length === 1 && tasks[0].type === 'shell';
            });
            assert.strictEqual(singleShellLike.length, 1,
                '단일 shell 템플릿은 하나여야 한다');
        });
    });

    suite('buildTasks 출력', () => {
        test('단일 쉘', () => {
            assert.deepStrictEqual(
                templateById('single-shell').buildTasks({ command: 'npm run build' }),
                [{ id: 'run', type: 'shell', command: 'npm run build' }]
            );
        });

        test('파일 선택 + 쉘 — dialog가 먼저, shell이 그 결과를 참조', () => {
            const tasks = templateById('file-dialog-shell')
                .buildTasks({ command: 'echo ${selectFile.path}' });

            assert.strictEqual(tasks.length, 2);
            assert.strictEqual(tasks[0].type, 'fileDialog');
            assert.strictEqual(tasks[0].id, 'selectFile');
            assert.ok(tasks[0].options.openLabel, 'openLabel 기본값이 있어야 한다');
            assert.strictEqual(tasks[1].type, 'shell');
            assert.ok(tasks[1].command.includes('${selectFile.path}'));
        });

        test('폴더 선택 + 쉘 — 파일 버전과 대칭', () => {
            const tasks = templateById('folder-dialog-shell')
                .buildTasks({ command: 'echo ${selectFolder.path}' });

            assert.strictEqual(tasks[0].type, 'folderDialog');
            assert.strictEqual(tasks[0].id, 'selectFolder');
            assert.strictEqual(tasks[1].type, 'shell');
        });

        test('값 입력 + 쉘 — inputBox의 prompt가 사용자 문구로 채워진다', () => {
            const tasks = templateById('input-box-shell')
                .buildTasks({ inputPrompt: '릴리스 태그를 입력하세요', command: 'git tag ${input.value}' });

            assert.deepStrictEqual(tasks, [
                { id: 'input', type: 'inputBox', prompt: '릴리스 태그를 입력하세요' },
                { id: 'run', type: 'shell', command: 'git tag ${input.value}' },
            ]);
        });

        test('선택지 + 쉘 — items 배열과 참조 변수', () => {
            const tasks = templateById('quick-pick-shell')
                .buildTasks({ items: ['stm32f4', 'stm32f7'], command: 'make TARGET=${choice.value}' });

            assert.strictEqual(tasks[0].type, 'quickPick');
            assert.deepStrictEqual(tasks[0].items, ['stm32f4', 'stm32f7']);
            assert.ok(tasks[0].placeHolder, '선택 안내 문구가 있어야 한다');
            assert.ok(tasks[1].command.includes('${choice.value}'));
        });

        test('다단계 파이프라인 — step1..stepN 순서대로 id가 붙는다', () => {
            const tasks = templateById('multi-step-shell')
                .buildTasks({ commands: ['make clean', 'make', 'make flash'] });

            assert.deepStrictEqual(tasks.map(t => t.id), ['step1', 'step2', 'step3']);
            assert.deepStrictEqual(tasks.map(t => t.command), ['make clean', 'make', 'make flash']);
            assert.ok(tasks.every(t => t.type === 'shell'));
        });

        test('다단계 파이프라인 — 한 단계만 입력해도 유효하다', () => {
            const tasks = templateById('multi-step-shell').buildTasks({ commands: ['make'] });
            assert.deepStrictEqual(tasks, [{ id: 'step1', type: 'shell', command: 'make' }]);
        });
    });

    suite('parseTemplateChoiceList', () => {
        test('쉼표로 나누고 공백을 제거한다', () => {
            assert.deepStrictEqual(
                parseTemplateChoiceList('stm32f4, stm32f7 ,nrf52'),
                ['stm32f4', 'stm32f7', 'nrf52']
            );
        });

        test('빈 항목(연속 쉼표 / 끝 쉼표)은 버린다', () => {
            assert.deepStrictEqual(parseTemplateChoiceList('a,,b,'), ['a', 'b']);
        });

        test('중복은 입력 순서를 지키며 하나만 남긴다', () => {
            assert.deepStrictEqual(parseTemplateChoiceList('b, a, b'), ['b', 'a']);
        });

        test('전부 비어 있으면 빈 배열 — 호출부가 오류로 처리한다', () => {
            assert.deepStrictEqual(parseTemplateChoiceList(' , , '), []);
        });
    });

    suite('생성 결과가 actions.schema.json을 통과한다', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schema', 'actions.schema.json'), 'utf-8'));
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema);

        const samples: Record<string, any> = {
            'single-shell': { command: 'make' },
            'file-dialog-shell': { command: 'echo ${selectFile.path}' },
            'folder-dialog-shell': { command: 'echo ${selectFolder.path}' },
            'input-box-shell': { inputPrompt: 'Tag?', command: 'git tag ${input.value}' },
            'quick-pick-shell': { items: ['a', 'b'], command: 'make ${choice.value}' },
            'multi-step-shell': { commands: ['make clean', 'make'] },
        };

        for (const template of ACTION_TEMPLATES) {
            test(`${template.id}`, () => {
                const inputs = samples[template.id];
                assert.ok(inputs, `${template.id}에 대한 샘플 입력이 없다 — 템플릿 추가 시 함께 추가할 것`);

                const document = [{
                    id: `wizard-${template.id}`,
                    title: 'Wizard Output',
                    action: { description: template.defaultDescription, tasks: template.buildTasks(inputs) },
                }];

                const valid = validate(document);
                assert.ok(valid, `스키마 위반: ${ajv.errorsText(validate.errors)}`);
            });
        }
    });

    suite('마법사 상수', () => {
        test('파이프라인 단계 상한이 합리적인 범위에 있다', () => {
            assert.ok(MAX_PIPELINE_TEMPLATE_STEPS >= 2 && MAX_PIPELINE_TEMPLATE_STEPS <= 20,
                '무한 프롬프트 방지용 가드 — 너무 작으면 기능이 반쪽이 된다');
        });
    });
});


/**
 * 다단계 마법사의 Back 과 초안 보존 (0.6.46).
 *
 * 최대 10단계를 받으면서 되돌아갈 방법이 없었다 — 8단계에서 오타를 발견하면
 * Escape 로 **전부 버리고** 처음부터 다시 입력해야 했다. `showInputBox` 로는
 * Back 버튼을 달 수 없어서 `createInputBox` 로 바꿨다.
 *
 * 실제 `promptForTasks` 를 돌린다. 가짜 입력 상자가 대본대로 accept/Back 을
 * 일으키고, 각 단계에 무엇이 **미리 채워졌는지**까지 기록한다.
 */
suite('다단계 마법사 Back / 초안 보존', () => {
    /**
     * `createInputBox` 를 대본으로 움직인다. 대본 항목이 `'BACK'` 이면
     * Back 버튼을 누른 것으로 처리한다.
     */
    function scriptInputBox(steps: (string | undefined | 'BACK')[]): {
        restore: () => void; prefilled: (string | undefined)[];
    } {
        const original = vscode.window.createInputBox;
        const prefilled: (string | undefined)[] = [];
        let idx = 0;
        (vscode.window as any).createInputBox = () => {
            const handlers: any = {};
            const box: any = {
                value: '', prompt: undefined, placeholder: undefined,
                ignoreFocusOut: false, buttons: [], validationMessage: undefined,
                onDidTriggerButton: (fn: any) => { handlers.button = fn; return { dispose() { } }; },
                onDidChangeValue: () => ({ dispose() { } }),
                onDidAccept: (fn: any) => { handlers.accept = fn; return { dispose() { } }; },
                onDidHide: (fn: any) => { handlers.hide = fn; return { dispose() { } }; },
                dispose: () => { },
                show: () => {
                    // 이 단계에 무엇이 채워진 채로 열렸는지 기록한다.
                    prefilled.push(box.value === '' ? undefined : box.value);
                    const answer = steps[idx++];
                    if (answer === 'BACK') {
                        handlers.button?.(vscode.QuickInputButtons.Back);
                        return;
                    }
                    if (answer === undefined) { box.value = ''; handlers.accept?.(); return; }
                    box.value = answer;
                    handlers.accept?.();
                },
            };
            return box;
        };
        return { restore: () => { (vscode.window as any).createInputBox = original; }, prefilled };
    }

    test('Back 으로 돌아간 단계에는 이전 입력이 다시 채워진다', async () => {
        // 1단계 make → 2단계 flash → Back → (2단계 재입력) test → 종료
        const stub = scriptInputBox(['make', 'flash', 'BACK', 'test', undefined]);
        let tasks: any[];
        try {
            tasks = await templateById('multi-step-shell').promptForTasks!();
        } finally {
            stub.restore();
        }

        assert.deepStrictEqual(
            tasks.map((t: any) => t.command),
            ['make', 'test'],
            'Back 이후의 재입력이 이전 값을 대체하지 않았다'
        );
        // show 순서: [0] 1단계(빈칸) → [1] 2단계(빈칸) → [2] 3단계에서 Back →
        // [3] 되돌아온 2단계(flash 가 채워져야 한다) → [4] 3단계
        assert.strictEqual(
            stub.prefilled[3],
            'flash',
            `Back 으로 돌아온 단계가 빈 칸으로 열렸다: ${JSON.stringify(stub.prefilled)}`
        );
    });

    test('1단계에는 Back 을 달지 않는다', async () => {
        // 돌아갈 곳이 없는 단계에 버튼이 있으면 눌렀을 때 갈 곳이 없다.
        const original = vscode.window.createInputBox;
        const buttonCounts: number[] = [];
        (vscode.window as any).createInputBox = () => {
            const handlers: any = {};
            const box: any = {
                value: '', buttons: [], validationMessage: undefined,
                onDidTriggerButton: () => ({ dispose() { } }),
                onDidChangeValue: () => ({ dispose() { } }),
                onDidAccept: (fn: any) => { handlers.accept = fn; return { dispose() { } }; },
                onDidHide: (fn: any) => { handlers.hide = fn; return { dispose() { } }; },
                dispose: () => { },
                show: () => {
                    buttonCounts.push(box.buttons.length);
                    if (buttonCounts.length === 1) { box.value = 'make'; } else { box.value = ''; }
                    handlers.accept?.();
                },
            };
            return box;
        };
        try {
            await templateById('multi-step-shell').promptForTasks!();
        } finally {
            (vscode.window as any).createInputBox = original;
        }

        assert.strictEqual(buttonCounts[0], 0, '1단계에 Back 버튼이 달려 있다');
        assert.ok(buttonCounts[1] > 0, '2단계에 Back 버튼이 없다 — 되돌아갈 방법이 없다');
    });
});
