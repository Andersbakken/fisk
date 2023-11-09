import Buffer from "Buffer";
import EventEmitter from "events";
import crypto from "crypto";
import fs from "fs";
import type { Response } from "./Response";
import { IndexItem } from "./Response";

export class ObjectCacheItem extends EventEmitter {
    cacheHits: number;

    constructor(readonly response: Response, readonly headerSize: number) {
        super();
        this.cacheHits = 0;
    }

    get contentsSize(): number {
        return this.response.index.reduce((total, item) => {
            return total + item.bytes;
        }, 0);
    }
    get fileSize(): number {
        return 4 + 16 + this.headerSize + this.contentsSize;
    }

    read(fd: number): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let byteOffset = 4;
            const expectedMd5 = await this.readChunk(fd, byteOffset, 16);
            byteOffset += 16 + this.headerSize;
            const hash = crypto.createHash("md5");
            this.response.index.forEach(async (chunk: IndexItem, idx: number) => {
                const chunk = await this.readChunk(fd, byteOffset, chunk
            });
            // let idx = 0;
            // const expectedMd5 = Buffer.allocUnsafe(16);
            // const md5 = fs.readFileSync(fd, expectedMd5, 4, 16, (error?: NodeJS.ErrnoException) => {

            // });

            const readNext = () => {
                if (idx === this.response.index.length) {
                }
            };

            const buffer = Buffer.allocUnsafe(f.bytes);
        });
    }

    private readChunk(fd: number, byteOffset: number, byteLength: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.allocUnsafe(byteLength);
            fs.read(fd, buffer, 0, byteLength, byteOffset, (err?: NodeJS.ErrnoException, bytesRead: number) => {
                if (err) {
                    reject(err);
                } else if (bytesRead !== byteLength) {
                    reject(
                        new Error(
                            `Short read from object cache file ${JSON.stringify(
                                this.response
                            )} ${byteOffset} ${byteLength} ${bytesRead}`
                        )
                    );
                } else {
                    resolve(buffer);
                }
            });
        });
    }
}

