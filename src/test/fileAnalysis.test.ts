import * as assert from 'assert';
import { analyzeElfBuffer, analyzeHexBuffer, analyzeListingBuffer } from '../fileAnalysis';
import { EventEmitter } from 'events';
import type { Worker } from 'worker_threads';
import { parseArmLinkList } from '../armLinkListParser';
import { parseBinary } from '../hexParser';
import { HexByteStore } from '../hexByteStore';
import { parseElf32 } from '../elfParser';
import { buildMinimalElf32 } from './fixtures/elfFixtures';

suite('대용량 파일 분석 worker', () => {
    test('IT-312: 100MB ARM Listing 분석 중 호스트 타이머가 진행되고 영역·엔트리를 보존한다', async function () {
        this.timeout(15000);
        const listing = 'Execution Region FLASH (Exec base: 0x08000000, Size: 0x10, Max: 0x100)\n'
            + '    0x08000000 0x00000010 Code RO 1 .text.main main.o(.text)\n';
        const content = Buffer.alloc(100 * 1024 * 1024, 0x20);
        content.write(listing);
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        try {
            const { empty, ...result } = await analyzeListingBuffer(content);
            assert.strictEqual(empty, false);
            assert.deepStrictEqual(result, parseArmLinkList(listing));
            assert.strictEqual(result.execRegions[0].entries[0].func, 'main');
            assert.ok(ticks > 0, 'Listing parsing must leave the extension host responsive');
            assert.strictEqual((await analyzeListingBuffer(Buffer.from(' \n\t'))).empty, true);
        } finally { clearInterval(timer); }
    });

    test('IT-313: 30초 뒤 도착한 worker 결과도 시간 제한 없이 받아들인다', async () => {
        const workerModule = require('worker_threads') as { Worker: typeof Worker };
        const originalWorker = workerModule.Worker;
        const originalTimeout = global.setTimeout;
        const deadlines: Array<() => void> = [];
        let controlled: EventEmitter | undefined;
        const content = Buffer.alloc(1024 * 1024, 0x7e);
        class ControlledWorker extends EventEmitter {
            constructor() { super(); controlled = this; }
            async terminate(): Promise<number> { return 0; }
        }
        let observed: Promise<unknown> | undefined;
        let settled = false;
        try {
            workerModule.Worker = ControlledWorker as unknown as typeof Worker;
            global.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
                if (delay === 30000) { deadlines.push(() => callback(...args)); return 0 as unknown as NodeJS.Timeout; }
                return originalTimeout(callback, delay, ...args);
            }) as typeof global.setTimeout;
            observed = analyzeHexBuffer('.bin', content).then(result => { settled = true; return result; },
                error => { settled = true; return error; });
            for (const expire of deadlines) { expire(); }
            for (let turn = 0; turn < 5; turn++) { await Promise.resolve(); }
            assert.strictEqual(settled, false, 'Elapsed wall time must not discard a valid pending analysis');
            controlled!.emit('message', { result: parseBinary(content), content });
            const result = await observed;
            assert.ok(!(result instanceof Error));
            assert.deepStrictEqual(Buffer.from((result as Awaited<ReturnType<typeof analyzeHexBuffer>>).rawBuffer!), content);
        } finally {
            controlled?.emit('message', { result: parseBinary(content), content });
            await observed;
            workerModule.Worker = originalWorker;
            global.setTimeout = originalTimeout;
        }
    });

    test('IT-304: 50MB HEX를 분석하는 동안 호스트 타이머가 진행되고 페이지 저장소가 복원된다', async function () {
        this.timeout(15000);
        const record = ':10000000000102030405060708090A0B0C0D0E0F78\n';
        const content = Buffer.from(record.repeat(Math.floor(50 * 1024 * 1024 / record.length)));
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        try {
            const result = await analyzeHexBuffer('.hex', content);
            assert.ok(ticks > 0, 'The host event loop must keep processing while the parser is busy');
            assert.strictEqual(result.format, 'intel');
            assert.strictEqual(result.byteCount, 16);
            assert.ok(result.data instanceof HexByteStore);
            assert.strictEqual(result.data.get(15), 15);
            assert.strictEqual(result.data.has(16), false);
            assert.deepStrictEqual([...result.data], Array.from({ length: 16 }, (_, index) => [index, index]));
            const copy = new Uint8Array(16);
            result.data.copyTo(copy, 0);
            assert.deepStrictEqual([...copy], Array.from({ length: 16 }, (_, index) => index));
        } finally { clearInterval(timer); }
    });

    test('IT-305: worker의 binary 결과는 파일 offset과 원본 바이트를 보존한다', async () => {
        const content = Buffer.alloc(1024 * 1024, 0x3a);
        content[content.length - 1] = 0xfe;
        const result = await analyzeHexBuffer('.hex', content, true);
        assert.strictEqual(result.format, 'binary');
        assert.strictEqual(result.byteCount, content.length);
        assert.strictEqual(result.minAddress, 0);
        assert.strictEqual(result.maxAddress, content.length - 1);
        assert.deepStrictEqual(Buffer.from(result.rawBuffer!), content);
    });

    test('IT-306: 100MB ELF의 파싱 결과와 후속 DWARF 분석에 쓰는 버퍼가 보존된다', async function () {
        this.timeout(15000);
        const content = Buffer.alloc(100 * 1024 * 1024);
        buildMinimalElf32().copy(content);
        const expected = parseElf32(content);
        const result = await analyzeElfBuffer(content);
        assert.deepStrictEqual(result.result, expected);
        assert.ok(Buffer.isBuffer(result.content));
        assert.ok(result.content.equals(content));
    });

    test('IT-307: worker 파싱 실패는 호출자에게 반환되고 다음 분석은 정상 동작한다', async () => {
        await assert.rejects(analyzeElfBuffer(Buffer.alloc(1024 * 1024)));
        const result = await analyzeHexBuffer('.bin', Buffer.from([1, 2, 3]));
        assert.deepStrictEqual([...result.rawBuffer!], [1, 2, 3]);
    });
});
