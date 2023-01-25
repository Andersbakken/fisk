import { Response } from "./Response";

export class ObjectCacheItem {
    response: Response;
    cacheHits: number;
    headerSize: number;

    constructor(response: unknown, headerSize: number) {
        this.headerSize = headerSize;
        this.response = response;
        this.cacheHits = 0;
    }

    get contentsSize(): number {
        return this.response.index.reduce((total, item) => {
            return total + item.bytes;
        }, 0);
    }
    get fileSize(): number {
        return 4 + this.headerSize + this.contentsSize;
    }
    // get headerSize
}
