import * as assert from 'assert';
import { buildActionRunReportHtml } from '../actionRunReport';
import { t } from '../i18n';
import type { ActionRunLog } from '../runLogStore';

suite('Action Run Report', () => {
    function sampleLog(): ActionRunLog {
        return {
            version: 1,
            actionId: 'build',
            actionTitle: 'Build <Firmware>',
            startedAt: Date.parse('2026-08-15T00:00:00.000Z'),
            finishedAt: Date.parse('2026-08-15T00:00:02.500Z'),
            durationMs: 2500,
            outcome: 'failure',
            error: 'compiler <failed>',
            tasks: [
                {
                    taskId: 'compile<script>',
                    type: 'command',
                    index: 1,
                    status: 'failure',
                    startedAt: Date.parse('2026-08-15T00:00:00.100Z'),
                    finishedAt: Date.parse('2026-08-15T00:00:02.400Z'),
                    durationMs: 2300,
                    command: 'gcc <main.c>',
                    cwd: '/workspace/project',
                    error: 'exit <1>',
                    exitCode: 1,
                    output: { availability: 'captured', stdout: 'hello <world>', stderr: 'bad & worse' },
                    diagnostics: { error: 1, warning: 2, info: 0, hint: 0 },
                    artifacts: ['/workspace/build/app.elf'],
                },
                {
                    taskId: 'flash',
                    type: 'shell',
                    index: 2,
                    status: 'not-run',
                    output: { availability: 'redacted' },
                    command: 'flash ***',
                    artifacts: ['***'],
                },
            ],
        };
    }

    test('태스크 요약 표는 항상 보이고 실패한 실행은 상세까지 펼친다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'nonce-123');

        assert.ok(html.includes('Build &lt;Firmware&gt;'));
        // 표가 접힘 안에 있으면 "어느 태스크가 실패했나"를 보려고 매번 한 번
        // 더 눌러야 한다. 표는 details 앞에 있어야 한다.
        const tableAt = html.indexOf('<table>');
        const detailsAt = html.indexOf('<details class="tasks"');
        assert.ok(tableAt > 0 && detailsAt > tableAt, 'the summary table must sit outside/above the details');
        assert.ok(/<details class="tasks" open>/.test(html), 'a failed run must open its task details');
        assert.ok(/<details class="task" open>/.test(html), 'the failed task itself stays open');
        assert.ok(html.includes('/workspace/build/app.elf'));
        assert.ok(html.includes('gcc &lt;main.c&gt;'));
        assert.ok(!html.includes('<script>'));
        assert.ok(!html.includes('compiler <failed>'));
    });

    test('성공한 실행에서는 태스크 상세를 접어 둔다', () => {
        const log = sampleLog();
        log.outcome = 'success';
        log.error = undefined;
        log.tasks.forEach(task => { task.status = 'success'; });
        const html = buildActionRunReportHtml(log, 'n');

        assert.ok(/<details class="tasks">/.test(html));
        assert.ok(!/<details class="tasks" open>/.test(html));
        assert.ok(html.includes('<table>'), 'the summary table stays visible even on success');
    });

    test('실패한 태스크 이름을 요약에 직접 적는다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'n');
        assert.ok(html.includes(escapeExpected('compile<script>')));
        assert.ok(html.includes(t('실패한 태스크', 'Failed task(s)')));
    });

    test('시그널로 죽은 태스크는 "null"이 아니라 시그널을 보여 준다', () => {
        const log = sampleLog();
        // Node 는 시그널 종료에 code=null, signal='SIGTERM' 을 준다 — Stop
        // 액션과 강제 종료 경로가 정확히 이 모양이다.
        log.tasks[0].exitCode = null;
        log.tasks[0].signal = 'SIGTERM';
        const html = buildActionRunReportHtml(log, 'n');

        assert.ok(html.includes('SIGTERM'), 'the signal must reach the report');
        assert.ok(!/>null</.test(html), 'exitCode null must never render as the string "null"');
    });

    test('종료 정보가 아예 없는 태스크는 자리표시자를 쓴다', () => {
        const log = sampleLog();
        log.tasks[0].exitCode = undefined;
        log.tasks[0].signal = undefined;
        const html = buildActionRunReportHtml(log, 'n');
        assert.ok(html.includes('—'));
        assert.ok(!/>null</.test(html));
    });

    test('TaskHub가 만든 사유는 읽는 시점의 언어로 옮긴다', () => {
        const log = sampleLog();
        log.outcome = 'stopped';
        log.error = 'Action stopped by the user.';
        log.errorCode = 'stopped-by-user';
        const html = buildActionRunReportHtml(log, 'n');

        assert.ok(html.includes(t('사용자 중지', 'Stopped by user')));
        assert.ok(html.includes(t('중지 사유', 'Stop reason')));
        assert.ok(html.includes(t('사용자가 실행을 중지했습니다.', 'The action was stopped by the user.')));
        // 로그에 남은 영어 원문이 그대로 새어 나오면 안 된다.
        assert.ok(!html.includes('Action stopped by the user.'));
    });

    test('취소된 실행과 비밀번호 파생 실패도 코드로 지역화한다', () => {
        const cancelled = sampleLog();
        cancelled.outcome = 'cancelled';
        cancelled.error = undefined;
        assert.ok(buildActionRunReportHtml(cancelled, 'n').includes(t('취소됨', 'Canceled')));

        const sensitive = sampleLog();
        sensitive.errorCode = 'sensitive-hidden';
        sensitive.tasks[0].errorCode = 'sensitive-hidden';
        sensitive.tasks[0].error = 'raw detail that must not surface';
        const html = buildActionRunReportHtml(sensitive, 'n');
        assert.ok(html.includes(t(
            'password 입력에서 파생된 실패라 상세를 숨겼습니다.',
            'Failure details are hidden because a task used a password input.'
        )));
        assert.ok(!html.includes('raw detail that must not surface'), 'the raw task error must stay hidden');
    });

    test('도구가 낸 원문 사유는 번역하지 않고 그대로 보여 준다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'n');
        assert.ok(html.includes('compiler &lt;failed&gt;'));
    });

    test('진단은 합계가 아니라 심각도별로 나눠 보여 준다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'n');
        assert.ok(html.includes(t('오류 1', '1 error(s)')));
        assert.ok(html.includes(t('경고 2', '2 warning(s)')));
        assert.ok(!html.includes(t('오류 1, 경고 2, 정보 0, 힌트 0', '1 error(s), 2 warning(s), 0 info, 0 hint(s)')));
    });

    test('진단이 하나도 없으면 없음으로 적는다', () => {
        const log = sampleLog();
        log.tasks.forEach(task => { task.diagnostics = undefined; });
        assert.ok(buildActionRunReportHtml(log, 'n').includes(t('없음', 'None')));
    });

    test('스크립트 없는 CSP와 nonce style만 허용한다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'nonce-456');

        assert.ok(html.includes("default-src 'none'; style-src 'nonce-nonce-456'"));
        assert.ok(html.includes('<style nonce="nonce-456">'));
        assert.ok(!/<script\b/i.test(html));
        assert.ok(!/enableCommandUris|https?:\/\//i.test(html));
    });

    test('큰 캡처 출력은 앞이 아니라 뒤를 남긴다', () => {
        const log = sampleLog();
        const head = '__HEAD_MARKER__';
        const tail = '__TAIL_MARKER__';
        const stdout = `${head}${'x'.repeat(210_000)}${tail}`;
        log.tasks[0].output.stdout = stdout;
        const html = buildActionRunReportHtml(log, 'n');

        // 빌드 오류는 거의 항상 출력 끝에 있다.
        assert.ok(html.includes(tail), 'the tail of the stream must survive truncation');
        assert.ok(!html.includes(head), 'the head is what gets dropped');
        assert.ok(html.length < stdout.length, `report unexpectedly embedded all output: ${html.length}`);
        // 잘린 뒤에도 표시 상한만큼은 남아 있어야 한다 — 통째로 버려도
        // 통과하던 느슨한 단언을 막는다.
        assert.ok(html.includes('x'.repeat(1000)), 'the retained slice must still hold the stream body');
        const hidden = stdout.length - 200_000;
        assert.ok(html.includes(hidden.toLocaleString()), 'the hidden character count must be visible');
    });

    test('로그 상한이 스트림을 통째로 버린 경우를 상세에 알린다', () => {
        const log = sampleLog();
        log.truncated = true;
        log.tasks[0].output = {
            availability: 'captured',
            stdout: '',
            stderr: undefined,
            truncated: true,
            originalBytes: 9_000_000,
        };
        const html = buildActionRunReportHtml(log, 'n');

        assert.ok(html.includes('<h3>stdout</h3>'), 'the dropped stream is still named');
        assert.ok(html.includes((9_000_000).toLocaleString()), 'the original size must be shown');
        // stderr 는 애초에 없었다. 공유 truncated 플래그로 없던 출력까지
        // "저장 안 됨" 이라고 말하면 안 된다.
        assert.ok(!html.includes('<h3>stderr</h3>'), 'a stream that never existed must not be reported as dropped');
    });

    test('태스크가 없는 로그도 렌더링한다', () => {
        const log = sampleLog();
        log.tasks = [];
        log.outcome = 'success';
        log.error = undefined;
        const html = buildActionRunReportHtml(log, 'n');
        assert.ok(html.includes('<tbody></tbody>'));
        assert.ok(html.includes(t('전체 0', '0 total')));
    });

    test('표는 table 시맨틱을 유지하고 스크롤 영역에 키보드로 닿는다', () => {
        const html = buildActionRunReportHtml(sampleLog(), 'n');
        assert.ok(/<div class="table-scroll" role="region" tabindex="0"/.test(html));
        assert.ok(!/table\s*{[^}]*display:\s*block/.test(html), 'display:block on <table> strips its role');
        assert.ok(html.includes('<th scope="col">') || html.includes('<th scope="col"><span'));
    });

    function escapeExpected(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
});
