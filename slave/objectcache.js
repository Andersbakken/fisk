const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require("events");

function prettysize(bytes)
{
    const prettysize = require('prettysize');
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
        this.streams = {};
        this.size = 0;
        // console.log(fs.readdirSync(this.dir, { withFileTypes: true }));
        try {
            fs.readdirSync(this.dir).map(fileName => {
                let ret = { fileName: fileName, path: path.join(this.dir, fileName) };
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
            }).sort((a, b) => a.atime - b.atime).forEach(file => {
                // console.log("got file", file);
                let fd;
                let jsonBuffer;
                try {
                    if (file.fileName.length == 32) {
                        const headerSizeBuffer = Buffer.allocUnsafe(4);
                        fd = fs.openSync(file.path, "r");
                        fs.readSync(fd, headerSizeBuffer, 0, 4);
                        const headerSize = headerSizeBuffer.readUInt32LE(0);
                        jsonBuffer = Buffer.allocUnsafe(headerSize);
                        fs.readSync(fd, jsonBuffer, 0, headerSize);
                        const response = JSON.parse(jsonBuffer.toString());
                        if (response.md5 != file.fileName)
                            throw new Error(`Got bad filename: ${file.fileName} vs ${response.md5}`);
                        let item = new ObjectCacheItem(response, headerSize);
                        if (item.fileSize != file.size)
                            throw new Error(`Got bad size for ${file.fileName} expected ${item.fileSize} got ${file.size}`);
                        fs.closeSync(fd);
                        this.size += item.fileSize;
                        this.cache[file.fileName] = item;
                    } else {
                        throw new Error("Unexpected file " + file.fileName);
                    }
                } catch (err) {
                    if (fd)
                        fs.closeSync(fd);
                    console.error("got failure", err,  jsonBuffer.toString().substr(0, 100));
                    try {
                        fs.removeSync(file.path);
                    } catch (doubleError) {
                        console.error("Can't even delete this one", doubleError);
                    }
                }
                return undefined;
            });
        } catch (err) {
            console.error(`Got error reading directory ${dir}: ${err}`);
        }
        console.log("initializing object cache with", this.dir, "maxSize", prettysize(maxSize), "size", prettysize(this.size));
    }

    state(md5)
    {
        if (md5 in this.cache) {
            return "exists";
        } else if (md5 in this.pending) {
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
        if (response.md5 in this.pending) {
            console.log("Already writing this, I suppose this is possible", response);
            return;
        } else if (response.md5 in this.cache) {
            throw new Error("This should not happen. We already have " + response.md5 + " in the cache");
        }
        let absolutePath = path.join(this.dir, response.md5);
        try {
            fs.mkdirpSync(this.dir);
        } catch (err) {
        }

        let remaining = 0;
        response.index.forEach(file => { remaining += file.bytes; });

        let pendingItem = new PendingItem(response, absolutePath, remaining);
        pendingItem.file.on("error", err => {
            console.error("Failed to write pendingItem", response, err);
            delete this.pending[response.md5];
        });
        this.pending[response.md5] = pendingItem;
        contents.forEach(c => pendingItem.write(c.contents));
        pendingItem.end(() => {
            if (this.pending[response.md5] == pendingItem) {
                let cacheItem = new ObjectCacheItem(response, pendingItem.jsonLength);
                try {
                    let stat = fs.statSync(path.join(this.dir, response.md5));
                    // console.log("stat is", stat.size, "for", path.join(this.dir, response.md5));
                    // console.log("shit", cacheItem);
                    // console.log("ass", pendingItem);
                    if (cacheItem.fileSize != stat.size) {
                        throw new Error(`Wrong file size for ${path.join(this.dir, response.md5)}, should have been ${cacheItem.fileSize} but ended up being ${stat.size}`);
                    }
                    this.cache[response.md5] = cacheItem;
                    this.emit("added", response.md5);

                    this.size += cacheItem.fileSize;
                    if (this.size > this.maxSize)
                        this.purge(this.purgeSize);
                    console.log("Finished writing", response.md5);
                } catch (err) {
                    console.error("Something wrong", err);
                    try {
                        fs.unlinkSync(pendingItem.path);
                    } catch (err) {
                        if (err.code != "ENOENT")
                            console.error(`Failed to unlink ${pendingItem.path} ${err}`);
                    }
                }

                delete this.pending[response.md5];
            }
        });
    }

    get cacheHits()
    {
        let ret = 0;
        for (let md5 in this.cache) {
            ret += this.cache[md5].cacheHits;
        }
        return ret;
    }

    dump(query)
    {
        const ret = Object.assign({ cacheHits: this.cacheHits, usage: ((this.size / this.maxSize) * 100).toFixed(1) }, this);
        ret.count = Object.keys(ret.cache).length;
        if (!("objects" in query))
            delete ret.cache;
        if (!("streams" in query))
            delete ret.streams;
        if (!("pending" in query))
            delete ret.pending;
        [ "maxSize", "size", "purgeSize" ].forEach(key => {
            ret[key] = prettysize(ret[key]);
        });
        return ret;
    }

    remove(md5)
    {
        try {
            this.size -= this.cache[md5].fileSize;
            delete this.cache[md5];
            this.emit("removed", md5);
            fs.unlinkSync(path.join(this.dir, md5));
        } catch (err) {
            console.error("Can't remove file", path.join(this.dir, md5), err.toString());
        }

    }

    purge(targetSize)
    {
        for (let md5 in this.cache) {
            if (this.size <= targetSize) {
                break;
            }
            console.log(`purging ${md5} because ${this.size} >= ${targetSize}`);
            this.remove(md5);
        }
    }

    get(md5)
    {
        let ret = this.cache[md5];
        if (ret) {
            delete this.cache[md5];
            this.cache[md5] = ret;
        }
        return ret;
    }

    keys()
    {
        return Object.keys(this.cache);
    }
};

module.exports = ObjectCache;