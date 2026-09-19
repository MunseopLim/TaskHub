import * as assert from 'node:assert';
import { getEventListeners } from 'node:events';
import { createJenkinsScope } from '../jenkins/lifecycle';

suite('Jenkins operation lifecycle', () => {
    test('either parent cancels an operation without cancelling unrelated parent work', () => {
        const feature = new AbortController();
        const request = new AbortController();
        const scope = createJenkinsScope([feature.signal, request.signal]);
        request.abort();
        assert.strictEqual(scope.signal.aborted, true);
        assert.strictEqual(feature.signal.aborted, false);
        scope.dispose();
        assert.strictEqual(getEventListeners(feature.signal, 'abort').length, 0);
    });

    test('deadlines cancel waiting operations while the host event loop keeps running', async () => {
        const scope = createJenkinsScope([], 10);
        try {
            await new Promise<void>(resolve => scope.signal.addEventListener('abort', () => resolve(), { once: true }));
            assert.strictEqual(scope.signal.aborted, true);
        } finally { scope.dispose(); }
    });

    test('repeated operation teardown releases listeners and respects an already-disabled feature', () => {
        const feature = new AbortController();
        for (let index = 0; index < 100; index++) {
            const scope = createJenkinsScope([feature.signal], 30000);
            scope.dispose(); scope.dispose();
        }
        assert.strictEqual(getEventListeners(feature.signal, 'abort').length, 0);
        feature.abort();
        const disabled = createJenkinsScope([feature.signal]);
        assert.strictEqual(disabled.signal.aborted, true);
        disabled.dispose();
    });
});
