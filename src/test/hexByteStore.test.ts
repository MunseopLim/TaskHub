import * as assert from 'assert';
import { HexByteStore } from '../hexByteStore';
import { toFlatArray, hasData } from '../hexParser';
import { buildHexViewerPayload } from '../hexViewer';

suite('HEX 페이지 저장소', () => {
    test('페이지 경계·중복·0xff·높은 주소와 빈 주소를 구분한다', () => {
        const store = new HexByteStore();
        const expected = new Map<number, number>();
        for (const [address, value] of [[0, 0], [7, 0], [8, 255], [256, 2], [255, 1], [0xFFFF_FFFF, 255], [256, 3], [0x1_0000_0000, 9]]) {
            store.set(address, value);
            expected.set(address, value);
        }
        assert.strictEqual(store.size, expected.size);
        for (const [address, value] of expected) { assert.strictEqual(store.get(address), value); }
        assert.strictEqual(store.has(254), false);
        assert.deepStrictEqual([...store].sort((a, b) => a[0] - b[0]), [...expected].sort((a, b) => a[0] - b[0]));
    });

    test('기존 Map과 같은 평탄화·gap·부분 구간 결과를 낸다', () => {
        const data = new HexByteStore();
        const legacy = new Map<number, number>();
        for (let i = 0; i < 3000; i++) {
            const address = 0x9000_0000 + (i * 71) % 2048;
            data.set(address, i & 255);
            legacy.set(address, i & 255);
        }
        const common = { format: 'intel' as const, minAddress: 0x9000_0000, maxAddress: 0x9000_0800, byteCount: data.size };
        const actual = { ...common, data };
        const old = { ...common, data: legacy };
        for (const offset of [-10, 0, 255, 1024, 2049]) {
            assert.deepStrictEqual(toFlatArray(actual, common.minAddress + offset, 500, 0xCC),
                toFlatArray(old, common.minAddress + offset, 500, 0xCC));
            assert.strictEqual(hasData(actual, common.minAddress + offset), hasData(old, common.minAddress + offset));
        }
        assert.deepStrictEqual(buildHexViewerPayload(actual), buildHexViewerPayload(old));
    });

    test('256바이트마다 데이터와 존재 비트맵 288바이트만 저장하고 희소 페이지에는 상한을 둔다', () => {
        const data = new HexByteStore(576);
        for (let i = 0; i < 512; i++) { data.set(i, i & 255); }
        assert.strictEqual(data.size, 512);
        assert.strictEqual(data.storageBytes, 576);
        data.set(1, 255);
        assert.strictEqual(data.size, 512);
        assert.throws(() => data.set(0xFFFF0000, 1), /sparse storage exceeds/);
        assert.strictEqual(data.has(0xFFFF0000), false);
        assert.strictEqual(data.get(1), 255);
    });
});
