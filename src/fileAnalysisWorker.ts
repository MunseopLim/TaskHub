import { parentPort, workerData } from 'worker_threads';
import { parseHexBuffer } from './hexParser';
import { parseElf32 } from './elfParser';
import { analyzeArmLinkList } from './armLinkListParser';

const { kind, extension, content, forceBinary } = workerData;
const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
try {
    const result = kind === 'hex' ? parseHexBuffer(extension, buffer, forceBinary)
        : kind === 'elf' ? parseElf32(buffer) : analyzeArmLinkList(buffer.toString('utf8'));
    parentPort!.postMessage({ result, content }, [content.buffer]);
} catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
