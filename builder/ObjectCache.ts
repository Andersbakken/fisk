import { ObjectCacheItem } from "./ObjectCacheItem";
import { ObjectCachePendingItem } from "./ObjectCachePendingItem";
import { Response } from "./Response";
import EventEmitter from "events";
import fs from "fs-extra";
import path from "path";
import prettybytes from "pretty-bytes";

function prettysize(bytes: number): string {
    return bytes >= 1024 ? prettybytes(bytes) : String(bytes);
}

type FileType = {
    path: string;
    size?: number;
    atime?: number;
};

export type SyncData = {
    sha1: string;
    fileSize: number;
};

export type InfoType = {
    cacheHits: number;
    usage: string;
    count: number;
    cache?: Record<string, ObjectCacheItem>;
    pending?: Record<string, ObjectCachePendingItem>;
    dir: string;
    size: number | string;
    maxSize: number | string;
    purgeSize: number | string;
};

export class ObjectCache extends EventEmitter {
    private purgeSize: number;
    private cache: Record<string, ObjectCacheItem>;
    private pending: Record<string, ObjectCachePendingItem>;

    dir: string;
    size: number;
    maxSize: number;

    constructor(dir: string, maxSize: number, purgeSize: number) {
        super();
        this.dir = dir;
        fs.mkdirpSync(dir);
        this.maxSize = maxSize;
        this.purgeSize = purgeSize;
        this.cache = {};
        this.pending = {};
        this.size = 0;
        // console.log(fs.readdirSync(this.dir, { withFileTypes: true }));
        try {
            fs.readdirSync(this.dir)
                .map((fileName) => {
                    const ret: FileType = { path: path.join(this.dir, fileName) };
                    if (fileName.length === 32) {
                        try {
                            const stat = fs.statSync(ret.path);
                            if (stat.isFile()) {
                                ret.size = stat.size;
                                ret.atime = stat.atimeMs;
                            }
                        } catch (err) {
                            console.error("Got error stating", ret.path, err);
                        }
                    }
                    return ret;
                })
                .sort((a, b) => a.atime - b.atime)
                .forEach((item) => {
                    this.loadFile(item.path, item.size);
                });
        } catch (err) {
            console.error(`Got error reading directory ${dir}:`, err);
        }
        console.log(
            "initializing object cache with",
            this.dir,
            "maxSize",
            prettysize(maxSize),
            "size",
            prettysize(this.size)
        );
    }

    loadFile(filePath: string, fileSize: number): void {
        const fileName = path.basename(filePath);
        // console.log("got file", file);
        let fd;
        let jsonBuffer;
        try {
            if (fileName.length === 32) {
                const headerSizeBuffer = Buffer.allocUnsafe(4);
                fd = fs.openSync(filePath, "r");
                const stat = fs.statSync(filePath);
                fs.readSync(fd, headerSizeBuffer, 0, 4, null);
                const headerSize = headerSizeBuffer.readUInt32LE(0);
                // console.log("got headerSize", headerSize);
                if (headerSize < 10 || headerSize > 1024 * 16) {
                    throw new Error(`Got bad header size for ${fileName}: ${headerSize}`);
                }
                jsonBuffer = Buffer.allocUnsafe(headerSize);
                fs.readSync(fd, jsonBuffer, 0, headerSize, null);
                const response = JSON.parse(jsonBuffer.toString());
                if (response.sha1 !== fileName) {
                    throw new Error(`Got bad filename: ${fileName} vs ${response.sha1}`);
                }
                const item = new ObjectCacheItem(response, headerSize);
                if (item.fileSize !== fileSize) {
                    throw new Error(`Got bad size for ${fileName} expected ${item.fileSize} got ${fileSize}`);
                }
                fs.closeSync(fd);
                this.size += item.fileSize;
                this.cache[fileName] = item;
                this.emit("added", { sha1: response.sha1, sourceFile: response.sourceFile, fileSize: stat.size });
            } else {
                throw new Error("Unexpected file " + fileName);
            }
        } catch (err) {
            if (fd) {
                fs.closeSync(fd);
            }
            console.error("got failure", filePath, err, jsonBuffer ? jsonBuffer.toString().substr(0, 100) : undefined);
            try {
                fs.removeSync(filePath);
            } catch (doubleError) {
                console.error("Can't even delete this one", doubleError);
            }
        }
        return undefined;
    }

    state(sha1: string): string {
        if (sha1 in this.cache) {
            return "exists";
        }
        if (sha1 in this.pending) {
            return "pending";
        }
        return "none";
    }

    get keys(): string[] {
        return Object.keys(this.cache);
    }

    clear(): void {
        this.purge(0);
    }

    add(response: Response, contents: Buffer): void {
        if (response.sha1 in this.pending) {
            console.log("Already writing this, I suppose this is possible", response);
            return;
        }
        if (response.sha1 in this.cache) {
            throw new Error("This should not happen. We already have " + response.sha1 + " in the cache");
        }
        const absolutePath = path.join(this.dir, response.sha1);
        try {
            fs.mkdirpSync(this.dir);
        } catch (err) {
            /* */
        }

        let remaining = 0;
        response.index.forEach((file) => {
            remaining += file.bytes;
        });

        const pendingItem = new ObjectCachePendingItem(response, absolutePath, remaining);
        pendingItem.file.on("error", (err) => {
            console.error("Failed to write pendingItem", response, err);
            delete this.pending[response.sha1];
        });
        this.pending[response.sha1] = pendingItem;
        contents.forEach((c) => pendingItem.write(c.contents));
        pendingItem.end(() => {
            if (this.pending[response.sha1] === pendingItem) {
                const cacheItem = new ObjectCacheItem(response, pendingItem.jsonLength);
                try {
                    const stat = fs.statSync(path.join(this.dir, response.sha1));
                    // console.log("stat is", stat.size, "for", path.join(this.dir, response.sha1));
                    // console.log("shit", cacheItem);
                    // console.log("ass", pendingItem);
                    if (cacheItem.fileSize !== stat.size) {
                        throw new Error(
                            `Wrong file size for ${path.join(this.dir, response.sha1)}, should have been ${
                                cacheItem.fileSize
                            } but ended up being ${stat.size}`
                        );
                    }
                    this.cache[response.sha1] = cacheItem;
                    // console.log(response);
                    this.emit("added", {
                        sha1: response.sha1,
                        sourceFile: response.sourceFile,
                        fileSize: cacheItem.fileSize
                    });

                    this.size += cacheItem.fileSize;
                    if (this.size > this.maxSize) {
                        this.purge(this.purgeSize);
                    }
                    console.log("Finished writing", response.sha1);
                } catch (err: unknown) {
                    console.error("Something wrong", err);
                    try {
                        fs.unlinkSync(pendingItem.path);
                    } catch (err2: unknown) {
                        if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") {
                            console.error(`Failed to unlink ${pendingItem.path} ${err}`);
                        }
                    }
                }

                delete this.pending[response.sha1];
            }
        });
    }

    get cacheHits(): number {
        let ret = 0;
        for (const sha1 in this.cache) {
            ret += this.cache[sha1].cacheHits;
        }
        return ret;
    }

    info(query?: URLSearchParams): InfoType {
        const ret: InfoType = {
            dir: this.dir,
            cacheHits: this.cacheHits,
            usage: ((this.size / this.maxSize) * 100).toFixed(1),
            count: Object.keys(ret.cache).length,
            cache: this.cache,
            pending: this.pending,
            maxSize: prettysize(this.maxSize),
            size: prettysize(this.size),
            purgeSize: prettysize(this.purgeSize)
        };
        ret.count = Object.keys(ret.cache).length;
        if (!query || !("object" in query)) {
            delete ret.cache;
        }
        if (!query || !("pending" in query)) {
            delete ret.pending;
        }
        return ret;
    }

    remove(sha1: string): void {
        try {
            const info = this.cache[sha1];
            this.size -= info.fileSize;
            delete this.cache[sha1];
            this.emit("removed", { sha1: sha1, sourceFile: info.response.sourceFile, fileSize: info.fileSize });
            fs.unlinkSync(path.join(this.dir, sha1));
        } catch (err) {
            console.error("Can't remove file", path.join(this.dir, sha1), err.toString());
        }
    }

    purge(targetSize: number): void {
        for (const sha1 in this.cache) {
            if (this.size <= targetSize) {
                break;
            }
            console.log(`purging ${sha1} because ${this.size} >= ${targetSize}`);
            this.remove(sha1);
        }
    }

    get(sha1: string, dontTouch?: boolean): ObjectCacheItem | undefined {
        const ret = this.cache[sha1];
        if (!dontTouch && ret) {
            delete this.cache[sha1];
            this.cache[sha1] = ret;
        }
        return ret;
    }

    syncData(): SyncData[] {
        const ret = [];
        for (const key in this.cache) {
            ret.push({ sha1: key, fileSize: this.cache[key].fileSize });
        }
        return ret;
    }
}
