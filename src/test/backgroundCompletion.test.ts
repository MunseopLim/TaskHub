import * as assert from 'assert';
import {
    BackgroundCompletionBatcher,
    BackgroundCompletionEvent,
    BackgroundCompletionPolicy,
    BackgroundCompletionTimer,
    formatBackgroundCompletionPresentation,
    shouldShowBackgroundCompletionNotification,
    shouldSurfaceBackgroundCompletion,
} from '../backgroundCompletion';

suite('백그라운드 완료 알림', () => {
    const policy: BackgroundCompletionPolicy = {
        thresholdMs: 10_000,
        outcomes: new Set(['success', 'failure']),
        notificationMode: 'whenUnfocused',
    };

    test('임계값 경계와 선택한 결과만 통과한다', () => {
        assert.strictEqual(shouldSurfaceBackgroundCompletion(9_999, 'success', policy), false);
        assert.strictEqual(shouldSurfaceBackgroundCompletion(10_000, 'success', policy), true);
        assert.strictEqual(shouldSurfaceBackgroundCompletion(30_000, 'failure', policy), true);
        assert.strictEqual(shouldSurfaceBackgroundCompletion(30_000, 'stopped', policy), false);
        assert.strictEqual(shouldSurfaceBackgroundCompletion(Number.NaN, 'success', policy), false);
    });

    test('완료 시점의 포커스와 알림 모드를 판정한다', () => {
        assert.strictEqual(shouldShowBackgroundCompletionNotification('whenUnfocused', true), false);
        assert.strictEqual(shouldShowBackgroundCompletionNotification('whenUnfocused', false), true);
        assert.strictEqual(shouldShowBackgroundCompletionNotification('always', true), true);
        assert.strictEqual(shouldShowBackgroundCompletionNotification('never', false), false);
    });

    test('단일 결과는 소요 시간·심각도·기존 실패 메시지를 보존한다', () => {
        const result = formatBackgroundCompletionPresentation([{
            title: 'Firmware',
            outcome: 'failure',
            durationMs: 65_200,
            message: "'Firmware' 액션 실패: linker error",
            showNotification: true,
        }], 'ko');

        assert.deepStrictEqual(result, {
            severity: 'error',
            statusText: '$(error) TaskHub: Firmware — 실패 (1m 5s)',
            notificationText: "'Firmware' 액션 실패: linker error (1m 5s)",
        });
    });

    test('여러 결과는 한 알림으로 접고 실패를 가장 높은 심각도로 삼는다', () => {
        const events: BackgroundCompletionEvent[] = [
            { title: 'A', outcome: 'success', durationMs: 10_000, showNotification: true },
            { title: 'B', outcome: 'failure', durationMs: 11_000, showNotification: true },
            { title: 'C', outcome: 'stopped', durationMs: 12_000, showNotification: true },
        ];
        const result = formatBackgroundCompletionPresentation(events, 'en');

        assert.strictEqual(result?.severity, 'error');
        assert.strictEqual(result?.notificationText,
            'TaskHub: 3 actions finished — 1 succeeded, 1 failed, 1 stopped.');
    });

    test('묶음 창은 첫 이벤트 기준으로 한 번만 예약하고 flush 뒤 재사용된다', () => {
        let scheduled: (() => void) | undefined;
        let setCount = 0;
        const timer: BackgroundCompletionTimer = {
            set: callback => { scheduled = callback; setCount++; return callback; },
            clear: () => { scheduled = undefined; },
        };
        const flushed: Array<readonly BackgroundCompletionEvent[]> = [];
        const batcher = new BackgroundCompletionBatcher(events => flushed.push(events), 750, timer);
        const event = (title: string): BackgroundCompletionEvent => ({
            title, outcome: 'success', durationMs: 10_000, showNotification: true,
        });

        batcher.enqueue(event('A'));
        batcher.enqueue(event('B'));
        assert.strictEqual(setCount, 1, '두 번째 완료가 묶음 창을 다시 예약하면 폭주가 계속 지연된다');
        scheduled?.();
        assert.deepStrictEqual(flushed.map(batch => batch.map(item => item.title)), [['A', 'B']]);

        batcher.enqueue(event('C'));
        assert.strictEqual(setCount, 2, 'flush 뒤 다음 묶음 창을 열 수 있어야 한다');
        batcher.dispose();
        assert.strictEqual(scheduled, undefined);
        batcher.enqueue(event('D'));
        assert.strictEqual(setCount, 2, 'dispose 뒤 enqueue가 배처를 되살리면 안 된다');
    });
});
