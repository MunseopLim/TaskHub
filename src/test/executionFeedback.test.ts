import * as assert from 'assert';
import {
    isExecutionNotificationMode,
    resolveDetachedFailureNotifications,
    resolveExecutionNotifications,
} from '../executionFeedback';

suite('액션 실행 알림 정책', () => {
    test('followStatus는 기존 showTaskStatus 동작을 보존한다', () => {
        assert.strictEqual(resolveExecutionNotifications(true, 'followStatus'), true);
        assert.strictEqual(resolveExecutionNotifications(false, 'followStatus'), false);
        assert.strictEqual(resolveDetachedFailureNotifications('followStatus'), true,
            '기존에는 상태 표시를 꺼도 분리 실행된 원샷 실패를 알렸다');
    });

    test('on은 상태 표시를 꺼도 알림을 켠다', () => {
        assert.strictEqual(resolveExecutionNotifications(false, 'on'), true);
        assert.strictEqual(resolveDetachedFailureNotifications('on'), true);
    });

    test('off는 상태 표시를 켜도 알림을 끈다', () => {
        assert.strictEqual(resolveExecutionNotifications(true, 'off'), false);
        assert.strictEqual(resolveDetachedFailureNotifications('off'), false);
    });

    test('잘못된 값은 호환 모드로 안전하게 폴백한다', () => {
        assert.strictEqual(isExecutionNotificationMode('invalid'), false);
        assert.strictEqual(resolveExecutionNotifications(false, 'invalid'), false);
        assert.strictEqual(resolveExecutionNotifications(true, undefined), true);
        assert.strictEqual(resolveDetachedFailureNotifications('invalid'), true);
    });
});
