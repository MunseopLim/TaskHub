import * as assert from 'assert';
import {
    WIZARD_REVIEW_LIST_LIMIT,
    buildWizardReviewDetail,
    buildWizardReviewDocument,
    diffDoctorFindings,
} from '../extension';
import { DoctorFinding } from '../doctor';
import { ActionItem } from '../schema';

/**
 * "저장 전 확인 단계" (0.6.18).
 *
 * 마법사는 마지막 프롬프트가 끝나면 곧바로 디스크에 썼다. 그래서 두 가지가
 * 사용자 눈에 띄지 않았다.
 *
 *   1. **자동 도출된 id** — `taskhub.runAction.<id>` 커맨드 이름이 되어
 *      keybindings.json에 노출되고, 나중에 바꾸면 단축키가 깨진다.
 *   2. 새 액션이 새로 만들어 내는 Doctor 경고.
 *
 * 2번은 파일 전체를 린트해야 알 수 있는데(id 충돌은 액션 간 문제), 그대로
 * 보여주면 기존 액션이 원래 갖고 있던 문제까지 새 액션 탓으로 보인다.
 * 그래서 before/after를 비교해 **새로 생긴 것만** 보고한다.
 */

function finding(overrides: Partial<DoctorFinding> & { code: string; message: string }): DoctorFinding {
    return {
        filePath: 'C:/proj/.vscode/actions.json',
        sourceLabel: 'workspace',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        severity: 'warning',
        ...overrides,
    };
}

const sampleAction: ActionItem = {
    id: 'fw-build',
    title: 'Build Firmware',
    action: {
        description: 'Build it',
        tasks: [
            { id: 'selectFile', type: 'fileDialog' },
            { id: 'run', type: 'shell', command: 'make ${selectFile.path}' },
        ],
    },
} as unknown as ActionItem;

suite('마법사 저장 전 확인', () => {

    suite('diffDoctorFindings', () => {
        test('기존 파일에 이미 있던 경고는 새 액션 탓으로 보고하지 않는다', () => {
            const existing = finding({ code: 'preview.unresolved', message: 'old problem' });
            const introduced = finding({ code: 'id.duplicate', message: 'new problem' });

            const result = diffDoctorFindings([existing], [existing, introduced]);

            assert.deepStrictEqual(result.map(f => f.code), ['id.duplicate']);
        });

        test('같은 경고가 하나 더 늘어나면 늘어난 만큼만 보고한다', () => {
            const dup = () => finding({ code: 'regex.invalid', message: 'bad regex' });
            const result = diffDoctorFindings([dup()], [dup(), dup()]);
            assert.strictEqual(result.length, 1, '중복 발생 횟수까지 반영해야 한다');
        });

        test('줄 위치만 밀린 항목은 새 경고로 보지 않는다', () => {
            // 액션을 삽입하면 뒤쪽 findings의 range가 전부 밀린다. range로
            // 비교하면 무관한 경고가 전부 "새 경고"로 둔갑한다.
            const before = finding({ code: 'write.outside', message: 'writes outside workspace' });
            const after = finding({
                code: 'write.outside',
                message: 'writes outside workspace',
                range: { startLine: 42, startColumn: 3, endLine: 42, endColumn: 9 },
            });

            assert.deepStrictEqual(diffDoctorFindings([before], [after]), []);
        });

        test('경고가 사라졌어도 음수 결과 없이 빈 배열', () => {
            const gone = finding({ code: 'a', message: 'x' });
            assert.deepStrictEqual(diffDoctorFindings([gone, gone], [gone]), []);
        });

        test('둘 다 비어 있으면 빈 배열', () => {
            assert.deepStrictEqual(diffDoctorFindings([], []), []);
        });
    });

    suite('buildWizardReviewDetail', () => {
        test('자동 도출된 id를 가장 먼저 보여준다', () => {
            const detail = buildWizardReviewDetail(sampleAction, 'Root', [], 'ko');
            assert.ok(detail.startsWith('ID: fw-build'),
                `id가 안 보이면 확인 단계의 존재 이유 절반이 사라진다:\n${detail}`);
        });

        test('저장 위치와 task 목록을 보여준다', () => {
            const detail = buildWizardReviewDetail(sampleAction, 'Firmware', [], 'ko');
            assert.ok(detail.includes('위치: Firmware'), detail);
            assert.ok(detail.includes('Task 2개'), detail);
            assert.ok(detail.includes('1. selectFile (fileDialog)'), detail);
            assert.ok(detail.includes('2. run (shell) — make ${selectFile.path}'), detail);
        });

        test('경고가 없으면 점검 섹션 자체가 없다', () => {
            const detail = buildWizardReviewDetail(sampleAction, 'Root', [], 'ko');
            assert.ok(!detail.includes('점검 결과'), detail);
        });

        test('경고가 있으면 심각도별 개수와 메시지를 보여준다', () => {
            const findings = [
                finding({ code: 'id.duplicate', message: 'duplicate id', severity: 'error', messageKo: '중복된 id' }),
                finding({ code: 'preview.unresolved', message: 'unresolved var' }),
            ];
            const detail = buildWizardReviewDetail(sampleAction, 'Root', findings, 'ko');

            assert.ok(detail.includes('오류 1건, 경고 1건'), detail);
            assert.ok(detail.includes('✗ [id.duplicate] 중복된 id'), 'ko에서는 messageKo를 쓴다');
            assert.ok(detail.includes('⚠ [preview.unresolved] unresolved var'), detail);
        });

        test('영어 로케일에서는 messageKo가 있어도 영문 메시지를 쓴다', () => {
            const findings = [finding({ code: 'id.duplicate', message: 'duplicate id', messageKo: '중복된 id' })];
            const detail = buildWizardReviewDetail(sampleAction, 'Root', findings, 'en');

            assert.ok(detail.includes('duplicate id'), detail);
            assert.ok(!detail.includes('중복된 id'), detail);
            assert.ok(detail.includes('Id: fw-build'), detail);
        });

        test(`task가 ${WIZARD_REVIEW_LIST_LIMIT}개를 넘으면 접는다 (modal이 화면을 넘지 않도록)`, () => {
            const many: ActionItem = {
                id: 'big', title: 'Big',
                action: {
                    description: 'many',
                    tasks: Array.from({ length: WIZARD_REVIEW_LIST_LIMIT + 3 }, (_, i) => ({
                        id: `step${i + 1}`, type: 'shell', command: `echo ${i}`,
                    })),
                },
            } as unknown as ActionItem;

            const detail = buildWizardReviewDetail(many, 'Root', [], 'ko');
            assert.ok(detail.includes(`Task ${WIZARD_REVIEW_LIST_LIMIT + 3}개`), '헤더는 전체 개수');
            assert.ok(detail.includes('… 외 3개'), detail);
            assert.ok(!detail.includes(`${WIZARD_REVIEW_LIST_LIMIT + 1}. step`), '한계치 넘는 행은 나열하지 않는다');
        });

        test('quickPick / inputBox task도 요약 문구를 갖는다', () => {
            const action: ActionItem = {
                id: 'pick', title: 'Pick',
                action: {
                    description: 'd',
                    tasks: [
                        { id: 'choice', type: 'quickPick', items: ['a', 'b'] },
                        { id: 'input', type: 'inputBox', prompt: 'Tag?' },
                    ],
                },
            } as unknown as ActionItem;

            const detail = buildWizardReviewDetail(action, 'Root', [], 'ko');
            assert.ok(detail.includes('1. choice (quickPick) — a, b'), detail);
            assert.ok(detail.includes('2. input (inputBox) — Tag?'), detail);
        });
    });

    suite('buildWizardReviewDocument', () => {
        test('저장될 JSON 전문과 Preview 리포트를 함께 담는다', () => {
            const document = buildWizardReviewDocument(sampleAction, [], 'PREVIEW-REPORT-BODY', 'ko');

            assert.ok(document.includes('"id": "fw-build"'), 'JSON 전문이 있어야 한다');
            assert.ok(document.includes('"type": "fileDialog"'), document);
            assert.ok(document.includes('PREVIEW-REPORT-BODY'), 'Preview 리포트가 있어야 한다');
            assert.ok(document.includes('미리보기'), '문서가 저장본이 아니라는 안내가 필요하다');
        });

        test('점검 결과는 주석으로 덧붙는다 (JSON 파트를 오염시키지 않도록)', () => {
            const findings = [finding({ code: 'id.duplicate', message: 'duplicate id' })];
            const document = buildWizardReviewDocument(sampleAction, findings, 'x', 'ko');

            const findingLine = document.split('\n').find(line => line.includes('id.duplicate'));
            assert.ok(findingLine, '점검 결과가 문서에 없다');
            assert.ok(findingLine!.trimStart().startsWith('//'), `주석이 아니면 JSON 파싱이 깨진다: ${findingLine}`);
        });

        test('JSON 부분만 떼어내면 그대로 파싱된다', () => {
            const document = buildWizardReviewDocument(sampleAction, [], 'x', 'ko');
            const jsonBlock = document.split('\n\n')[1];
            assert.deepStrictEqual(JSON.parse(jsonBlock), JSON.parse(JSON.stringify(sampleAction)));
        });
    });
});
