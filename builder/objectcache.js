const fs = require("fs-extra");
const path = require("path");
const EventEmitter = require("events");

function prettysize(bytes)
{
    const prettysize = require("prettysize");
    return prettysize(bytes, bytes >= 1024); // don't want 0Bytes
}

class ObjectCacheItem
{
    constructor(response, headerSize)
    {
        this.headerSize = headerSize;
        this.response = response;
        this.cacheHits = 0;
    }

    get contentsSize() { return this.response.index.reduce((total, item) => { return total + item.bytes; }, 0); }
    get fileSize() { return 4 + this.headerSize + this.contentsSize; }
    // get headerSize
};

class PendingItem
{
    constructor(response, path, dataBytes) // not including the metadata
    {
        this.response = response;
        this.path = path;
        this.remaining = dataBytes;
        this.endCB = undefined;
        this.file = fs.createWriteStream(path);
        this.file.on("drain", () => {
            // console.log("Got drain", this.buffer.length);
            let buf = this.buffer;
            this.buffer = undefined;
            buf.forEach(b => this.write(b));
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

    write(data) {
        // console.log("GOT DATA", this.path, data.length, this.buffer);
        if (this.buffer) {
            this.buffer.push(data);
        } else if (!this.file.write(data)) {
            // console.log("Failed to write", data.length);
            this.buffer = [];
        }
    }
    end(cb)
    {
        if (this.buffer) {
            this.endCB = cb;
        } else {
            this.file.end(cb);
        }
    }
};

class ObjectCache extends EventEmitter
{
    constructor(dir, maxSize, purgeSize)
    {
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
            fs.readdirSync(this.dir).map(fileName => {
                let ret = { path: path.join(this.dir, fileName) };
                if (fileName.length == 32) {
                    try {
                        let stat = fs.statSync(ret.path);
                        if (stat.isFile()) {
                            ret.size = stat.size;
                            ret.atime = stat.atimeMs;
                        }
                    } catch (err) {
                        console.error("Got error stating", ret.path, err);
                    }
                }
                return ret;
            }).sort((a, b) => a.atime - b.atime).forEach(item => {
                this.loadFile(item.path, item.size);
            });
        } catch (err) {
            console.error(`Got error reading directory ${dir}:`, err);
        }
        console.log("initializing object cache with", this.dir, "maxSize", prettysize(maxSize), "size", prettysize(this.size));
    }

    loadFile(filePath, fileSize)
    {
        let fileName = path.basename(filePath);
        // console.log("got file", file);
        let fd;
        let jsonBuffer;
        try {
            if (fileName.length == 32) {
                const headerSizeBuffer = Buffer.allocUnsafe(4);
                fd = fs.openSync(filePath, "r");
                const stat = fs.statSync(filePath);
                fs.readSync(fd, headerSizeBuffer, 0, 4);
                const headerSize = headerSizeBuffer.readUInt32LE(0);
                // console.log("got headerSize", headerSize);
                if (headerSize < 10 || headerSize > 1024 * 16)
                    throw new Error(`Got bad header size for ${fileName}: ${headerSize}`);
                jsonBuffer = Buffer.allocUnsafe(headerSize);
                fs.readSync(fd, jsonBuffer, 0, headerSize);
                const response = JSON.parse(jsonBuffer.toString());
                if (response.sha1 != fileName)
                    throw new Error(`Got bad filename: ${fileName} vs ${response.sha1}`);
                let item = new ObjectCacheItem(response, headerSize);
                if (item.fileSize != fileSize)
                    throw new Error(`Got bad size for ${fileName} expected ${item.fileSize} got ${fileSize}`);
                fs.closeSync(fd);
                this.size += item.fileSize;
                this.cache[fileName] = item;
                this.emit("added", { sha1: response.sha1, sourceFile: response.sourceFile, fileSize: stat.size });
            } else {
                throw new Error("Unexpected file " + fileName);
            }
        } catch (err) {
            if (fd)
                fs.closeSync(fd);
            console.error("got failure", filePath, err, jsonBuffer ? jsonBuffer.toString().substr(0, 100) : undefined);
            try {
                fs.removeSync(filePath);
            } catch (doubleError) {
                console.error("Can't even delete this one", doubleError);
            }
        }
        return undefined;
    }

    state(sha1)
    {
        if (sha1 in this.cache) {
            return "exists";
        } else if (sha1 in this.pending) {
            return "pending";
        }
        return "none";
    }

    get keys()
    {
        return Object.keys(this.cache);
    }

    clear() {
        this.purge(0);
    }

    add(response, contents) {
        if (response.sha1 in this.pending) {
            console.log("Already writing this, I suppose this is possible", response);
            return;
        } else if (response.sha1 in this.cache) {
            throw new Error("This should not happen. We already have " + response.sha1 + " in the cache");
        }
        let absolutePath = path.join(this.dir, response.sha1);
        try {
            fs.mkdirpSync(this.dir);
        } catch (err) {
        }

        let remaining = 0;
        response.index.forEach(file => { remaining += file.bytes; });

        let pendingItem = new PendingItem(response, absolutePath, remaining);
        pendingItem.file.on("error", err => {
            console.error("Failed to write pendingItem", response, err);
            delete this.pending[response.sha1];
        });
        this.pending[response.sha1] = pendingItem;
        contents.forEach(c => pendingItem.write(c.contents));
        pendingItem.end(() => {
            if (this.pending[response.sha1] == pendingItem) {
                let cacheItem = new ObjectCacheItem(response, pendingItem.jsonLength);
                try {
                    let stat = fs.statSync(path.join(this.dir, response.sha1));
                    // console.log("stat is", stat.size, "for", path.join(this.dir, response.sha1));
                    // console.log("shit", cacheItem);
                    // console.log("ass", pendingItem);
                    if (cacheItem.fileSize != stat.size) {
                        throw new Error(`Wrong file size for ${path.join(this.dir, response.sha1)}, should have been ${cacheItem.fileSize} but ended up being ${stat.size}`);
                    }
                    this.cache[response.sha1] = cacheItem;
                    // console.log(response);
                    this.emit("added", { sha1: response.sha1, sourceFile: response.sourceFile, fileSize: cacheItem.fileSize });

                    this.size += cacheItem.fileSize;
                    if (this.size > this.maxSize)
                        this.purge(this.purgeSize);
                    console.log("Finished writing", response.sha1);
                } catch (err) {
                    console.error("Something wrong", err);
                    try {
                        fs.unlinkSync(pendingItem.path);
                    } catch (err) {
                        if (err.code != "ENOENT")
                            console.error(`Failed to unlink ${pendingItem.path} ${err}`);
                    }
                }

                delete this.pending[response.sha1];
            }
        });
    }

    get cacheHits()
    {
        let ret = 0;
        for (let sha1 in this.cache) {
            ret += this.cache[sha1].cacheHits;
        }
        return ret;
    }

    info(query)
    {
        if (!query)
            query = {};
        const ret = Object.assign({ cacheHits: this.cacheHits, usage: ((this.size / this.maxSize) * 100).toFixed(1) }, this);
        ret.count = Object.keys(ret.cache).length;
        delete ret._events;
        delete ret._eventsCount;
        if (!("objects" in query))
            delete ret.cache;
        if (!("pending" in query))
            delete ret.pending;
        [ "maxSize", "size", "purgeSize" ].forEach(key => {
            ret[key] = prettysize(ret[key]);
        });
        return ret;
    }

    remove(sha1)
    {
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

    purge(targetSize)
    {
        for (let sha1 in this.cache) {
            if (this.size <= targetSize) {
                break;
            }
            console.log(`purging ${sha1} because ${this.size} >= ${targetSize}`);
            this.remove(sha1);
        }
    }

    get(sha1, dontTouch)
    {
        let ret = this.cache[sha1];
        if (!dontTouch && ret) {
            delete this.cache[sha1];
            this.cache[sha1] = ret;
        }
        return ret;
    }

    syncData()
    {
        let ret = [];
        for (let key in this.cache) {
            ret.push({ sha1: key, fileSize: this.cache[key].fileSize });
        }
        return ret;
    }
};

module.exports = ObjectCache;
