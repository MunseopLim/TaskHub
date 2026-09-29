import * as assert from 'assert';
import { plainNotificationText } from '../notificationText';

suite('알림 외부 텍스트', () => {
    test('일반 진단과 줄바꿈·경로는 그대로 표시한다', () => {
        const message = 'Build failed: exit 7\nC:\\work\\main.c:13: missing symbol\n소스를 확인하세요.';
        assert.strictEqual(plainNotificationText(message), message);
    });

    test('알림의 command/file/https 링크 문법과 대소문자 command scheme을 무력화한다', () => {
        for (const link of [
            '[Run](command:taskhub.testProbe)',
            '[Run](CoMmAnD:taskhub.testProbe?%5B%22x%22%5D "title")',
            '\\[Run\\](command:taskhub.testProbe)',
            '[[nested]](command:taskhub.testProbe)',
            '[Open](file:/private/source.c)',
            '[External](https://example.invalid)',
        ]) {
            const result = plainNotificationText(link);
            assert.ok(!/[\[\]]|command:/i.test(result), result);
            assert.ok(result.includes('［') && result.includes('］'), '표시할 문구는 읽을 수 있어야 한다');
            assert.strictEqual(plainNotificationText(result), result, '중복 적용해도 표시가 바뀌면 안 된다');
        }
        assert.strictEqual(plainNotificationText('[Run](COMMAND:test)'), '［Run］(COMMAND：test)');
    });
});
