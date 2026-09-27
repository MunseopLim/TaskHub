/** 256개 주소의 데이터와 존재 여부를 한 배열에 보관한다. */
const PAGE_SIZE = 256;
const PAGE_BYTES = PAGE_SIZE + PAGE_SIZE / 8;
/** 희소 주소가 페이지를 과도하게 만드는 입력도 제한한다(typed array 저장 공간). */
export const HEX_MAX_STORAGE_BYTES = 64 * 1024 * 1024;

/** 바이트별 Map 대신 페이지별 typed array를 사용하는 HEX/SREC 저장소. */
export class HexByteStore implements Iterable<[number, number]> {
    private readonly pages = new Map<number, Uint8Array>();
    private lastPageNumber = -1;
    private lastPage: Uint8Array | undefined;
    private count = 0;

    constructor(private readonly storageLimit = HEX_MAX_STORAGE_BYTES) {}

    get size(): number { return this.count; }
    get storageBytes(): number { return this.pages.size * PAGE_BYTES; }

    set(address: number, value: number): void {
        const pageNumber = Math.floor(address / PAGE_SIZE);
        let page = pageNumber === this.lastPageNumber ? this.lastPage : this.pages.get(pageNumber);
        if (!page) {
            if (this.storageBytes + PAGE_BYTES > this.storageLimit) {
                throw new Error(`HEX/SREC sparse storage exceeds ${this.storageLimit} bytes; refusing to load.`);
            }
            page = new Uint8Array(PAGE_BYTES);
            this.pages.set(pageNumber, page);
        }
        this.lastPageNumber = pageNumber;
        this.lastPage = page;
        const offset = address % PAGE_SIZE;
        const presenceIndex = PAGE_SIZE + (offset >>> 3);
        const mask = 1 << (offset & 7);
        if ((page[presenceIndex] & mask) === 0) { this.count++; }
        page[presenceIndex] |= mask;
        page[offset] = value;
    }

    get(address: number): number | undefined {
        const page = this.pages.get(Math.floor(address / PAGE_SIZE));
        const offset = address % PAGE_SIZE;
        return page && (page[PAGE_SIZE + (offset >>> 3)] & (1 << (offset & 7))) !== 0 ? page[offset] : undefined;
    }

    has(address: number): boolean { return this.get(address) !== undefined; }

    /** 빈 주소 공간을 순회하지 않고 실제 페이지의 해당 범위만 복사한다. */
    copyTo(target: Uint8Array, startAddress: number, gap?: Uint8Array): void {
        const end = startAddress + target.length;
        for (const [pageNumber, page] of this.pages) {
            const base = pageNumber * PAGE_SIZE;
            const from = Math.max(startAddress - base, 0);
            const to = Math.min(end - base, PAGE_SIZE);
            for (let index = from; index < to; index++) {
                if ((page[PAGE_SIZE + (index >>> 3)] & (1 << (index & 7))) === 0) { continue; }
                const offset = base + index - startAddress;
                target[offset] = page[index];
                if (gap) { gap[offset >>> 3] |= 1 << (offset & 7); }
            }
        }
    }

    *[Symbol.iterator](): IterableIterator<[number, number]> {
        for (const [pageNumber, page] of this.pages) {
            for (let offset = 0; offset < PAGE_SIZE; offset++) {
                if ((page[PAGE_SIZE + (offset >>> 3)] & (1 << (offset & 7))) !== 0) {
                    yield [pageNumber * PAGE_SIZE + offset, page[offset]];
                }
            }
        }
    }
}
