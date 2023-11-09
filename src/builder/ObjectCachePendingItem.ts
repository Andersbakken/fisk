import EventEmitter from "events";
import assert from "assert";
import crypto from "crypto";
import fs from "fs-extra";
import type { Response } from "./Response";

export class ObjectCachePendingItem extends EventEmitter {
    private readonly hash: crypto.Hash;
    private readonly fd: number;
    private readonly file: fs.WriteStream;
    private endResolve?: () => void;
    private endReject?: (error: Error) => void;
    private buffer?: Buffer[];

    readonly jsonLength: number;

    constructor(readonly response: Response, readonly path: string) {
        super();
        this.hash = crypto.createHash("md5");
        this.fd = fs.openSync(path, "w");
        this.file = fs.createWriteStream(path, { fd: this.fd });
        this.file.on("error", (err: Error) => {
            this.emit("error", err);
        });
        this.file.on("drain", () => {
            // console.log("Got drain", this.buffer.length);
            const buf = this.buffer;
            this.buffer = undefined;
            if (!buf) {
                throw new Error("Should have had a buffer");
            }
            buf.forEach((b) => {
                this.write(b);
            });
            if (!this.buffer && this.endResolve) {
                assert(this.endReject);
                this.file.end();
                this.writeHash().then(this.endResolve, this.endReject);
            }
        });
        this.buffer = undefined;

        const json = Buffer.from(JSON.stringify(response));
        // 4 bytes for the length of the headerbuffer, 16 bytes for the md5 sum
        const headerSizeBuffer = Buffer.allocUnsafe(20);
        headerSizeBuffer.writeUInt32LE(json.length);
        this.writeInternal(headerSizeBuffer, false);
        this.writeInternal(json, false);
        this.jsonLength = json.length;
    }

    write(data: Buffer): void {
        this.writeInternal(data, true);
    }

    end(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.endResolve) {
                reject(new Error("Don't end twice"));
                return;
            }
            if (this.buffer) {
                this.endResolve = resolve;
                this.endReject = reject;
            } else {
                this.file.end(() => {
                    this.writeHash().then(resolve, reject);
                });
            }
        });
    }

    private writeInternal(data: Buffer, hash: boolean): void {
        // console.log("GOT DATA", this.path, data.length, this.buffer);
        if (this.buffer) {
            this.buffer.push(data);
        } else if (this.file.write(data)) {
            if (hash) {
                this.hash.update(data);
            }
        } else {
            // console.log("Failed to write", data.length);
            this.buffer = [];
        }
    }

    private writeHash(): Promise<void> {
        return new Promise((resolve, reject) => {
            const hash: Buffer = this.hash.digest();
            assert(hash.length === 16);
            fs.write(this.fd, hash, 0, hash.length, 4, (error?: NodeJS.ErrnoException) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
}
