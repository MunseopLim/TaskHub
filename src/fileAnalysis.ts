import * as path from 'path';
import { Worker } from 'worker_threads';
import { HexByteStore } from './hexByteStore';
import { HexParseResult, parseHexBuffer } from './hexParser';
import { parseElf32 } from './elfParser';
import { analyzeArmLinkList } from './armLinkListParser';
import { t } from './i18n';

/** Small inputs stay local; large parsing never occupies the extension host. */
const WORKER_THRESHOLD = 512 * 1024;

async function analyze<T>(kind: 'hex' | 'elf' | 'listing', extension: string, content: Buffer,
    local: () => T, forceBinary = false): Promise<{ result: T; content: Buffer }> {
    if (content.length < WORKER_THRESHOLD) { return { result: local(), content }; }
    return new Promise((resolve, reject) => {
        // A dedicated transferable buffer also works when readFile returned a pooled Buffer.
        const input = Uint8Array.from(content);
        const worker = new Worker(path.join(__dirname, 'fileAnalysisWorker.js'), {
            workerData: { kind, extension, content: input, forceBinary }, transferList: [input.buffer],
        });
        let settled = false;
        const finish = (error?: Error, value?: { result: T; content: Buffer }): void => {
            if (settled) { return; }
            settled = true;
            void worker.terminate().then(() => {
                if (error) { reject(error); } else { resolve(value!); }
            }, reject);
        };
        worker.once('error', error => finish(error));
        worker.once('exit', code => finish(new Error(t(`파일 분석 worker가 종료됐습니다 (${code}).`, `File analysis worker exited (${code}).`))));
        worker.once('message', message => {
            if (message.error) { finish(new Error(message.error)); return; }
            const bytes = message.content as Uint8Array;
            finish(undefined, { result: message.result as T,
                content: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
        });
    });
}

export async function analyzeHexBuffer(extension: string, content: Buffer, forceBinary = false): Promise<HexParseResult> {
    const { result } = await analyze('hex', extension, content, () => parseHexBuffer(extension, content, forceBinary), forceBinary);
    if (!(result.data instanceof Map)) { Object.setPrototypeOf(result.data, HexByteStore.prototype); }
    return result;
}

export function analyzeElfBuffer(content: Buffer): Promise<{ result: ReturnType<typeof parseElf32>; content: Buffer }> {
    return analyze('elf', '', content, () => parseElf32(content));
}

export async function analyzeListingBuffer(content: Buffer): Promise<ReturnType<typeof analyzeArmLinkList>> {
    const { result } = await analyze('listing', '', content, () => analyzeArmLinkList(content.toString('utf8')));
    return result;
}
