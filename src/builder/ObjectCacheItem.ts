import type { Response } from "./Response";

export class ObjectCacheItem {
    cacheHits: number;

    constructor(readonly response: Response, readonly headerSize: number) {
        this.cacheHits = 0;
    }

    get contentsSize(): number {
        return this.response.index.reduce((total, item) => {
            return total + item.uncompressedSize;
        }, 0);
    }
    get fileSize(): number {
        return 4 + this.headerSize + this.contentsSize;
    }
    // get headerSize
}
