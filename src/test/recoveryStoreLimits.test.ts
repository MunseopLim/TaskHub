import * as assert from 'assert';
import {
    RECOVERY_MAX_ENTRIES,
    RecoveryEntry,
    makeRecoveryStore,
    pruneRecoveryEntries,
} from '../jsonEditorUtils';

/**
 * JSON Editor 복구 스냅샷의 저장 상한 (0.6.36).
 *
 * dirty 상태로 닫은 파일의 스냅샷은 workspaceState 에 보관되는데, 항목 하나가
 * **파일 전체의 파싱 결과**다. 다이얼로그 위치(경로 문자열 하나)와는 무게가
 * 다른데도 개수·총량 제한이 전혀 없어서, 큰 JSON 을 여럿 dirty 로 닫으면
 * workspaceState 와 in-memory shadow 가 함께 선형으로 자랐다.
 *
 * 두 가지를 함께 본다.
 *
 *   - **개수 상한**만으로는 부족하다. 20MB 짜리 20개면 개수는 지켜도 400MB 다.
 *     실제 무게는 바이트이므로 총량으로도 자른다.
 *   - **로드 시점**에도 적용해야 한다.  에서만 자르면 이미 상한을
 *     넘겨 쌓아 둔 기존 사용자는 다음 저장 전까지 그대로 위험하고, 그 사이
 *     shadow 가 전량을 메모리에 붙잡는다.
 *
 * **수명(TTL) 기준 삭제는 일부러 넣지 않았다.** 여기 담긴 것은 사용자의
 * 미저장 작업이라, "2주 지났으니 지운다" 같은 시계 기반 정책은 메모리 상한의
 * 부수 효과로 결정할 일이 아니다.
 */
suite('JSON Editor 복구 스냅샷', () => {

    const entry = (capturedAt: number): RecoveryEntry =>
        ({ data: { rows: [] }, isRootArray: false, fileMtimeMs: capturedAt, capturedAt });

    test('상한 이하면 그대로 둔다 (같은 객체를 돌려준다)', () => {
        const map = { '/a.json': entry(1) };
        assert.strictEqual(pruneRecoveryEntries(map), map);
    });

    test('상한을 넘으면 오래된 스냅샷부터 버린다', () => {
        const map: Record<string, RecoveryEntry> = {};
        for (let i = 0; i < RECOVERY_MAX_ENTRIES + 5; i++) {
            map[`/f${i}.json`] = entry(i);
        }

        const kept = pruneRecoveryEntries(map);

        assert.strictEqual(Object.keys(kept).length, RECOVERY_MAX_ENTRIES);
        assert.ok(kept[`/f${RECOVERY_MAX_ENTRIES + 4}.json`], '최신 스냅샷이 남아야 한다');
        assert.ok(!kept['/f0.json'], '가장 오래된 스냅샷이 남아 있다');
    });

    test('capturedAt 이 같으면 경로로 갈라 결과가 결정적이다', () => {
        const map = { '/b.json': entry(5), '/a.json': entry(5), '/c.json': entry(5) };
        const first = Object.keys(pruneRecoveryEntries(map, 2)).sort();
        const second = Object.keys(pruneRecoveryEntries(map, 2)).sort();
        assert.deepStrictEqual(first, second);
        assert.deepStrictEqual(first, ['/a.json', '/b.json']);
    });

    test('capturedAt 이 없는 옛 항목도 안전하게 다룬다', () => {
        const broken = { data: {}, isRootArray: false, fileMtimeMs: 1 } as unknown as RecoveryEntry;
        const map: Record<string, RecoveryEntry> = { '/old.json': broken };
        for (let i = 0; i < RECOVERY_MAX_ENTRIES; i++) { map[`/n${i}.json`] = entry(i + 100); }

        const kept = pruneRecoveryEntries(map);

        assert.strictEqual(Object.keys(kept).length, RECOVERY_MAX_ENTRIES);
        assert.ok(!kept['/old.json'], 'capturedAt 이 없으면 가장 오래된 것으로 취급해 먼저 버린다');
    });

    test('총량 상한 — 개수는 지켜도 바이트가 크면 자른다', () => {
        // 20MB × 20개면 개수는 통과해도 400MB 다. 실제 무게는 바이트다.
        const big = (capturedAt: number, chars: number): RecoveryEntry =>
            ({ data: { blob: 'x'.repeat(chars) }, isRootArray: false, fileMtimeMs: capturedAt, capturedAt });
        const map: Record<string, RecoveryEntry> = {};
        for (let i = 0; i < 10; i++) { map[`/big${i}.json`] = big(i, 5_000_000); }

        const kept = pruneRecoveryEntries(map);

        assert.ok(
            Object.keys(kept).length < 10,
            `개수(10)는 상한(${RECOVERY_MAX_ENTRIES}) 이하지만 총량이 넘으므로 잘려야 한다`
        );
        assert.ok(kept['/big9.json'], '최신 항목은 남아야 한다');
    });

    test('총량을 넘는 단일 스냅샷도 하나는 남긴다', () => {
        // 방금 닫은 파일의 복구본을 "크다"는 이유로 통째로 버리면 기능
        // 자체가 없는 것과 같다.
        const huge: RecoveryEntry = {
            data: { blob: 'x'.repeat(64 * 1024 * 1024) },
            isRootArray: false, fileMtimeMs: 1, capturedAt: 1,
        };
        const kept = pruneRecoveryEntries({ '/huge.json': huge });
        assert.strictEqual(Object.keys(kept).length, 1);
    });

    test('이미 쌓여 있던 항목을 로드 시점에 정리한다', async () => {
        // set() 에서만 자르면, 이미 상한을 넘겨 저장해 둔 기존 사용자는
        // 다음 저장이 일어나기 전까지 그대로 위험하고 shadow 가 전량을
        // 메모리에 붙잡는다.
        const overflowing: Record<string, RecoveryEntry> = {};
        for (let i = 0; i < RECOVERY_MAX_ENTRIES + 10; i++) {
            overflowing[`/old${i}.json`] = entry(i);
        }
        const backing: Record<string, unknown> = { recovery: overflowing };
        const state = {
            get: <T>(key: string, dflt: T) => (key in backing ? backing[key] as T : dflt),
            update: (key: string, value: unknown) => { backing[key] = value; return Promise.resolve(); },
        };

        const store = makeRecoveryStore(state, 'recovery');

        assert.strictEqual(store.get('/old0.json'), undefined, '오래된 항목이 shadow 에 남아 있다');
        assert.ok(store.get(`/old${RECOVERY_MAX_ENTRIES + 9}.json`), '최신 항목이 사라졌다');
        // persist 도 맞춰야 다음 실행마다 같은 정리를 반복하지 않는다.
        await Promise.resolve();
        const persisted = backing['recovery'] as Record<string, RecoveryEntry>;
        assert.strictEqual(Object.keys(persisted).length, RECOVERY_MAX_ENTRIES);
    });

    test('store 가 쓸 때마다 상한을 지킨다', async () => {
        const backing: Record<string, unknown> = {};
        const state = {
            get: <T>(key: string, dflt: T) => (key in backing ? backing[key] as T : dflt),
            update: (key: string, value: unknown) => { backing[key] = value; return Promise.resolve(); },
        };
        const store = makeRecoveryStore(state, 'recovery');

        for (let i = 0; i < RECOVERY_MAX_ENTRIES + 5; i++) {
            await store.set(`/f${i}.json`, entry(i));
        }

        const persisted = backing['recovery'] as Record<string, RecoveryEntry>;
        assert.strictEqual(
            Object.keys(persisted).length,
            RECOVERY_MAX_ENTRIES,
            '쓸 때마다 상한을 지키지 않으면 저장소가 무한히 자란다'
        );
        // shadow 도 함께 줄었는지 — 여기가 새면 in-memory 만 계속 자란다.
        assert.strictEqual(store.get('/f0.json'), undefined, 'shadow 에 축출된 항목이 남아 있다');
        assert.ok(store.get(`/f${RECOVERY_MAX_ENTRIES + 4}.json`), '최신 항목이 사라졌다');
    });
});
