import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionItem } from '../schema';

/**
 * 마법사 종단 흐름 — 확인 단계에서 ID를 바꾼 뒤 저장하고 바로 실행하는 경로.
 *
 * 0.6.18이 저장 전 확인 단계를, 0.6.25가 그 단계의 'ID 변경' 버튼을 넣었다.
 * 그런데 확인 단계는 `newAction.id`를 제자리에서 바꾸는 반면 저장 이후 코드는
 * 최초에 도출된 `id` 지역 변수를 계속 들고 있었다. 결과적으로 '바로 실행'이
 * 존재하지 않는 ID로 `executeActionById`를 불러, 방금 만든 액션에 대해
 * "액션을 찾을 수 없습니다"가 떴다.
 *
 * 0.6.19~0.6.26의 마법사 테스트 20여 종이 이걸 못 잡은 이유는 전부 순수 함수
 * (`buildTasks`, `validateActionIdInput`, `buildWizardReviewDetail`) 경계에서
 * 멈췄기 때문이다. 결함은 그 경계 **바깥**, 저장과 후속 실행 사이의 배선에
 * 있었다. 그래서 이 파일은 유일하게 `taskhub.createAction` 명령 자체를 돌린다.
 *
 * 프롬프트 응답은 호출 순서로 지정한다 — 마법사가 프롬프트를 추가/제거하면
 * 이 테스트가 먼저 깨지는데, 그건 의도된 신호다.
 */
suite('마법사 생성 종단 흐름', () => {

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const actionsPath = workspaceFolder
        ? path.join(workspaceFolder.uri.fsPath, '.vscode', 'actions.json')
        : undefined;

    /** 테스트가 만든 actions.json을 지운다 (원래 없던 파일이다). */
    function cleanupActionsFile(): void {
        if (!actionsPath) { return; }
        try {
            if (fs.existsSync(actionsPath)) { fs.unlinkSync(actionsPath); }
        } catch { /* 정리 실패가 테스트 결과를 바꾸지는 않는다 */ }
    }

    setup(cleanupActionsFile);
    teardown(cleanupActionsFile);

    /**
     * VS Code 프롬프트 API를 순서대로 대본에 따라 응답하도록 바꾸고, 복원
     * 함수를 돌려준다. 대본이 다 떨어지면 `undefined`(취소)를 준다.
     *
     * `information`은 **버튼 문구가 아니라 위치**로 지정한다. 생산 코드는
     * `t('저장','Save')` 결과와 반환값을 비교하므로, 대본에 한국어 문구를
     * 박아 두면 한국어 호스트에서만 통과하고 영어 CI에서는 조용히 "취소"로
     * 해석된다 — 0.6.26 문자열 탐지기가 `Function ▶`을 놓친 것과 같은 함정이다.
     */
    function scriptPrompts(script: {
        quickPick: any[];
        inputBox: (string | undefined)[];
        /** 제시된 버튼 중 몇 번째를 누를지. `undefined`면 dialog 취소. */
        information: (number | undefined)[];
    }) {
        const original = {
            showQuickPick: vscode.window.showQuickPick,
            showInputBox: vscode.window.showInputBox,
            createInputBox: vscode.window.createInputBox,
            showInformationMessage: vscode.window.showInformationMessage,
            executeCommand: vscode.commands.executeCommand,
        };
        const seen = { quickPick: 0, inputBox: 0, information: 0 };
        const executed: { command: string; args: any[] }[] = [];

        (vscode.window as any).showQuickPick = async (items: any) => {
            const resolved = await Promise.resolve(items);
            const answer = script.quickPick[seen.quickPick++];
            if (typeof answer === 'function') { return answer(resolved); }
            return answer;
        };
        (vscode.window as any).showInputBox = async () => script.inputBox[seen.inputBox++];
        // 마법사는 Back 버튼을 달기 위해 `createInputBox` 를 쓴다
        // (`showInputBox` 로는 버튼을 달 수 없다). 스크립트의 다음 답을
        // 그대로 accept 시키는 최소 구현으로 대신한다.
        (vscode.window as any).createInputBox = () => {
            const handlers: { accept?: () => void; hide?: () => void } = {};
            const box: any = {
                value: '',
                prompt: undefined,
                placeholder: undefined,
                ignoreFocusOut: false,
                buttons: [],
                validationMessage: undefined,
                onDidTriggerButton: () => ({ dispose() { /* 이 스텁은 Back 을 누르지 않는다 */ } }),
                onDidChangeValue: () => ({ dispose() { /* no-op */ } }),
                onDidAccept: (fn: () => void) => { handlers.accept = fn; return { dispose() { /* no-op */ } }; },
                onDidHide: (fn: () => void) => { handlers.hide = fn; return { dispose() { /* no-op */ } }; },
                dispose: () => { /* no-op */ },
                show: () => {
                    const answer = script.inputBox[seen.inputBox++];
                    if (answer === undefined) {
                        // 취소(Escape) 를 흉내 낸다.
                        handlers.hide?.();
                        return;
                    }
                    box.value = answer;
                    handlers.accept?.();
                },
            };
            return box;
        };
        const prompts: { buttons: string[]; modal: boolean }[] = [];
        (vscode.window as any).showInformationMessage = async (...args: any[]) => {
            // 시그니처는 (message, options?, ...items) 두 갈래다. 문자열 항목만
            // 추리면 modal / 비modal 양쪽을 같은 방식으로 다룰 수 있다.
            const buttons = args.slice(1).filter((a: any) => typeof a === 'string');
            const options = args[1];
            prompts.push({
                buttons,
                modal: !!(options && typeof options === 'object' && options.modal),
            });
            const index = script.information[seen.information++];
            return index === undefined ? undefined : buttons[index];
        };
        (vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
            executed.push({ command, args });
            // 실제 실행은 하지 않는다 — 검증 대상은 "어떤 ID로 불렀는가"이고,
            // 실제 실행은 터미널과 태스크를 띄워 테스트를 오염시킨다.
            if (command === 'taskhub.executeActionById') { return undefined; }
            return (original.executeCommand as any)(command, ...args);
        };

        return {
            executed,
            seen,
            prompts,
            restore() {
                (vscode.window as any).showQuickPick = original.showQuickPick;
                (vscode.window as any).showInputBox = original.showInputBox;
                (vscode.window as any).createInputBox = original.createInputBox;
                (vscode.window as any).showInformationMessage = original.showInformationMessage;
                (vscode.commands as any).executeCommand = original.executeCommand;
            },
        };
    }

    function readActions(): ActionItem[] {
        assert.ok(actionsPath && fs.existsSync(actionsPath), 'actions.json이 저장되어야 한다');
        return JSON.parse(fs.readFileSync(actionsPath!, 'utf-8'));
    }

    test('IT-119: 확인 단계에서 ID를 바꾸면 저장·실행 모두 새 ID를 쓴다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');

        const script = scriptPrompts({
            // 템플릿 선택 — 가장 단순한 단일 쉘 명령어
            quickPick: [(items: any[]) => items[0]],
            inputBox: [
                'Build Firmware',        // 제목
                'echo hi',               // 쉘 명령어
                'renamed-by-user',       // 확인 단계의 'ID 변경'
            ],
            // 확인 modal 1회차 → [저장, ID 변경, 자세히 보기] 중 1번(ID 변경),
            // 2회차 → 0번(저장), 생성 후 안내 → [열기, 바로 실행] 중 1번.
            information: [1, 0, 1],
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            // 대본이 위치로 버튼을 고르므로, 버튼 구성이 바뀌면 조용히 엉뚱한
            // 버튼을 누르게 된다. 첫 확인 modal의 버튼 수를 함께 못박는다.
            assert.strictEqual(
                script.prompts[0]?.buttons.length,
                3,
                `확인 modal은 저장/ID 변경/자세히 보기 3개여야 한다: ${JSON.stringify(script.prompts[0])}`
            );

            const saved = readActions();
            const created = saved.find(item => item.title === 'Build Firmware');
            assert.ok(created, `저장된 액션을 찾지 못했다: ${JSON.stringify(saved)}`);
            assert.strictEqual(
                created!.id,
                'renamed-by-user',
                '디스크에는 사용자가 바꾼 ID가 적혀야 한다'
            );

            const runCall = script.executed.find(call => call.command === 'taskhub.executeActionById');
            assert.ok(runCall, `'바로 실행'이 executeActionById를 불러야 한다: ${JSON.stringify(script.executed)}`);
            assert.strictEqual(
                runCall!.args[0]?.id,
                'renamed-by-user',
                '바로 실행이 최초 도출 ID(build-firmware)가 아닌 변경된 ID를 써야 한다'
            );
        } finally {
            script.restore();
        }
    });

    test('IT-120: ID를 바꾸지 않으면 제목에서 도출한 ID가 그대로 쓰인다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');

        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            information: [0, 1],   // 저장 → 바로 실행
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            const created = readActions().find(item => item.title === 'Build Firmware');
            assert.ok(created, '저장된 액션을 찾지 못했다');
            assert.strictEqual(created!.id, 'build-firmware');

            const runCall = script.executed.find(call => call.command === 'taskhub.executeActionById');
            assert.ok(runCall, "'바로 실행'이 executeActionById를 불러야 한다");
            assert.strictEqual(runCall!.args[0]?.id, 'build-firmware');
        } finally {
            script.restore();
        }
    });

    test('IT-122: 자세히 보기 이후의 확인 프롬프트는 modal이 아니다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');

        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            // 1회차 → 2번(자세히 보기), 2회차 → 0번(저장), 생성 후 → 취소
            information: [2, 0, undefined],
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            assert.strictEqual(script.prompts[0]?.modal, true, '첫 확인은 modal이 맞다');
            // 핵심: 검토 문서를 연 뒤 modal을 다시 띄우면 VS Code가 워크벤치를
            // 가려 그 문서를 스크롤할 수 없다 — 자세히 보기가 무의미해진다.
            assert.strictEqual(
                script.prompts[1]?.modal,
                false,
                '문서를 연 뒤의 재확인은 비modal이어야 문서를 읽을 수 있다'
            );
            assert.strictEqual(
                script.prompts[1]?.buttons.length,
                3,
                '비modal로 바뀌어도 선택지는 그대로 3개여야 한다'
            );

            const created = readActions().find(item => item.title === 'Build Firmware');
            assert.ok(created, '자세히 보기 후 저장이 정상 동작해야 한다');
        } finally {
            script.restore();
            // 검토 문서(untitled)가 남으면 이후 테스트의 활성 에디터를 오염시킨다.
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('IT-147: modal 취소는 되묻지 않고 한 번에 끝난다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');
        // modal 의 Cancel/Escape 는 **명시적인 의사표시**다. 실수로 닫히는
        // 알림과 같이 취급해 되물으면, 일부러 취소한 사용자가 두 번 닫아야 한다.
        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            information: [undefined],
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            assert.strictEqual(
                script.prompts.length, 1,
                `modal 취소 뒤에 알림이 더 떴다: ${JSON.stringify(script.prompts)}`
            );
            assert.ok(!fs.existsSync(actionsPath!), '취소했는데 actions.json이 생성됐다');
        } finally {
            script.restore();
        }
    });

    test('IT-148: 알림이 닫히면 초안을 살린 채 되묻고, 다시 검토는 알림 형태를 유지한다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');
        // 비modal 알림은 X 나 Clear All Notifications 로 실수로 닫힌다. 그때
        // 최대 10단계의 입력이 통째로 사라지면 안 된다.
        //
        // 재진입 시 **modal 로 돌아가서도 안 된다** — 검토 문서를 연 사실이
        // 함수 지역 변수였을 때, 열려 있는 그 문서 위에 modal 이 다시 떴다.
        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            // 1) 확인 modal → 자세히 보기(2)
            // 2) 확인 알림 → 닫힘(undefined)
            // 3) 되묻는 알림 → 다시 검토(0)
            // 4) 확인 → 저장(0)
            // 5) 생성 후 안내 → actions.json 열기(0)
            information: [2, undefined, 0, 0, 0],
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            assert.strictEqual(script.prompts.length, 5, `프롬프트 순서가 다르다: ${JSON.stringify(script.prompts)}`);
            assert.deepStrictEqual(
                script.prompts[2]?.buttons.length, 2,
                '되묻는 알림은 [다시 검토, 버리기] 두 개여야 한다 — 초안을 버리는 선택이 이름 없는 X 뿐이면 안 된다'
            );
            assert.strictEqual(
                script.prompts[3]?.modal, false,
                '다시 검토가 modal 로 돌아갔다 — 열려 있는 검토 문서를 가려 스크롤할 수 없게 된다'
            );

            const saved = readActions();
            assert.strictEqual(
                saved.filter(item => item.title === 'Build Firmware').length, 1,
                `재진입이 액션을 중복 삽입했다: ${JSON.stringify(saved)}`
            );
        } finally {
            script.restore();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('IT-149: 되묻는 알림에서 버리기를 고르면 저장하지 않는다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');
        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            information: [2, undefined, 1],   // 자세히 보기 → 알림 닫힘 → 버리기
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            assert.ok(!fs.existsSync(actionsPath!), '버리기를 골랐는데 actions.json이 생성됐다');
            assert.strictEqual(script.prompts.length, 3, `버리기 뒤에 더 물었다: ${JSON.stringify(script.prompts)}`);
        } finally {
            script.restore();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('IT-121: 확인 단계를 취소하면 파일을 만들지 않는다', async function () {
        this.timeout(20000);
        assert.ok(workspaceFolder, '워크스페이스 폴더가 필요하다');

        const script = scriptPrompts({
            quickPick: [(items: any[]) => items[0]],
            inputBox: ['Build Firmware', 'echo hi'],
            information: [undefined],   // modal 취소
        });

        try {
            await vscode.commands.executeCommand('taskhub.createAction');

            assert.ok(
                !fs.existsSync(actionsPath!),
                '취소했는데 actions.json이 생성됐다'
            );
            assert.strictEqual(
                script.executed.filter(c => c.command === 'taskhub.executeActionById').length,
                0,
                '취소했는데 실행이 일어났다'
            );
        } finally {
            script.restore();
        }
    });
});
