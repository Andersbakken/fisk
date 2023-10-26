import fs from "fs-extra";
import type { Response } from "./Response";

export class ObjectCachePendingItem {
    response: Response;
    file: fs.WriteStream;
    path: string;
    remaining: number;
    endCB?: () => void;
    buffer?: Buffer[];
    jsonLength: number;

    constructor(
        response: Response,
        path: string,
        dataBytes: number // not including the metadata
    ) {
        this.response = response;
        this.path = path;
        this.remaining = dataBytes;
        this.endCB = undefined;
        this.file = fs.createWriteStream(path);
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
            if (!this.buffer && this.endCB) {
                this.file.end();
                this.endCB();
            }
        });
        this.buffer = undefined;

        const json = Buffer.from(JSON.stringify(response));
        const headerSizeBuffer = Buffer.allocUnsafe(4);
        headerSizeBuffer.writeUInt32LE(json.length);
        this.write(headerSizeBuffer);
        this.write(json);
        this.jsonLength = json.length;
    }

    write(data: Buffer): void {
        // console.log("GOT DATA", this.path, data.length, this.buffer);
        if (this.buffer) {
            this.buffer.push(data);
        } else if (!this.file.write(data)) {
            // console.log("Failed to write", data.length);
            this.buffer = [];
        }
    }

    end(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.endCB) {
                reject(new Error("Don't end twice"));
                return;
            }
            if (this.buffer) {
                this.endCB = resolve;
            } else {
                this.file.end(resolve);
            }
        });
    }
}
