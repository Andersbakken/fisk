import assert from "assert";
import fs from "fs-extra";

type Pending = { data: Buffer; resolve: () => void; reject: (err: Error) => void };

export class File {
    private _fd?: number;
    private _pending?: Pending[];
    private _writing: boolean;

    public path: string;
    public hash: string;
    public system?: string;
    public originalPath?: string;

    constructor(path: string, hash: string) {
        this._fd = fs.openSync(path, "w");

        this.path = path;
        this.hash = hash;
        this.system = undefined;
        this._writing = false;
        this.originalPath = undefined;
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
    }

    save(data: Buffer): Promise<void> {
        if (this._fd === undefined) {
            throw new Error(`No fd for ${this.path}`);
        }
        return new Promise<void>((resolve, reject) => {
            if (!this._pending) {
                this._pending = [];
            }
            this._pending.push({ data, resolve, reject });
            if (!this._writing) {
                this._writing = true;
                this._write();
            }
        });
    }

    discard(): void {
        if (!this._fd) {
            throw new Error(`No fd for ${this.path}`);
        }
        fs.closeSync(this._fd);
        fs.unlinkSync(this.path);
    }

    close(): void {
        if (this._fd === undefined) {
            throw new Error(`No fd for ${this.path}`);
        }
        fs.closeSync(this._fd);
        this._fd = undefined;
    }

    _write(): void {
        assert(this._pending);
        const pending = this._pending.shift();
        if (pending) {
            assert(this._fd !== undefined);
            fs.write(this._fd, pending.data)
                .then(() => {
                    pending.resolve();
                    assert(this._pending);
                    if (this._pending.length > 0) {
                        process.nextTick(() => {
                            this._write();
                        });
                    } else {
                        this._writing = false;
                    }
                })
                .catch((e) => {
                    assert(this._fd !== undefined);
                    fs.closeSync(this._fd);
                    this._fd = undefined;
                    pending.reject(e);
                    this._clearPending(e);
                });
        }
    }

    _clearPending(e: Error): void {
        if (!this._pending) {
            return;
        }

        for (let i = 0; i < this._pending.length; ++i) {
            this._pending[i].reject(e);
        }
        this._pending = undefined;
    }
}
