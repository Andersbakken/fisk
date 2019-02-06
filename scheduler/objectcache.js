const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require("events");
const prettysize = require('prettysize');

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
    constructor(response, path, redundant, dataBytes) // not including the metadata
    {
        this.response = response;
        this.path = path;
        this.remaining = dataBytes;
        this.endCB = undefined;
        if (!redundant) {
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
        }
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

class Stream extends EventEmitter
{
    constructor(key)
    {
        super();
        this.key = key;
        this.pending = [];
    }

    addResponse(response)
    {
        this.emit("response", response);
    }

    addData(data)
    {
        this.emit("data", data);;
    }

    close()
    {
        this.emit("close");
    }
};

class ObjectCache
{
    constructor(dir, maxSize, purgeSize)
    {
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
                try {
                    if (file.fileName.length == 32) {
                        const headerSizeBuffer = Buffer.allocUnsafe(4);
                        fd = fs.openSync(file.path, "r");
                        fs.readSync(fd, headerSizeBuffer, 0, 4);
                        const headerSize = headerSizeBuffer.readUInt32LE(0);
                        const jsonBuffer = Buffer.allocUnsafe(headerSize);
                        fs.readSync(fd, jsonBuffer, 0, headerSize);
                        const response = JSON.parse(jsonBuffer.toString());
                        if (response.md5 != file.fileName)
                            throw new Error(`Got bad filename: ${file.fileName} vs ${response.md5}`);
                        let item = new ObjectCacheItem(response, headerSize);
                        if (item.fileSize != file.size)
                            throw new Error(`Got bad size for ${fileName} expected ${item.fileSize} got ${file.size}`);
                        fs.closeSync(fd);
                        this.size += item.fileSize;
                        this.cache[file.fileName] = item;
                    } else {
                        throw new Error("Unexpected file " + file.fileName);
                    }
                } catch (err) {
                    if (fd)
                        fs.closeSync(fd);
                    console.error("got failure", err);
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

    createStream(ip, port)
    {
        const key = ip + ":" + port;
        if (key in this.streams) {
            console.log("We already have this stream", key);
            // throw new Error("We already have this stream", key);
        }

        const stream = new Stream;
        stream.on("close", () => {
            stream.pending.forEach(item => {
                if (item.file) {
                    item.file.close();
                    try {
                        fs.unlinkSync(item.path);
                    } catch (err) {
                        console.error(`Failed to unlink ${item.path} ${err}`);
                    }
                    delete this.pending[item.md5];
                }
            });
            if (this.streams[key] == stream)
                delete this.streams[key];
        });

        let finishItem = (item) => {
            if (item.file) {
                item.end(() => {
                    // ### what if we get an error before this?
                    let cacheItem = new ObjectCacheItem(item.response, item.jsonLength);
                    let stat;
                    try {
                        stat = fs.statSync(path.join(this.dir, item.response.md5));
                        // console.log("stat is", stat.size, "for", path.join(this.dir, item.response.md5));
                        if (cacheItem.fileSize != stat.size) {
                            throw new Error(`Wrong file size for ${path.join(this.dir, item.response.md5)}, should have been ${cacheItem.fileSize} but ended up being ${stat.size}`);
                        }
                        this.cache[item.response.md5] = cacheItem;
                        this.size += cacheItem.fileSize;
                        if (this.size > this.maxSize)
                            this.purge(this.purgeSize);
                    } catch (err) {
                        console.error("Something wrong", err);
                    }
                    delete this.pending[item.response.md5];
                    // console.log("finished a file", item.response.md5);
                });
            }
            stream.pending.splice(0, 1);
            if (stream.pending.length && !stream.pending[0].remaining)
                finishItem(stream.pending[0]);
        };

        stream.on("response", response => {
            let redundant = false;
            if (this.state(response.md5) != 'none') {
                redundant = true;
            } else {
                this.pending[response.md5] = key;
            }
            let remaining = 0;
            response.index.forEach(file => { remaining += file.bytes; });
            let absolutePath = path.join(this.dir, response.md5);
            try {
                fs.mkdirpSync(this.dir);
            } catch (err) {
            }
            const item = new PendingItem(response, absolutePath, redundant, remaining);
            if (!redundant) {
                item.file.on("error", error => {
                    console.error("Got error writing file", error, absolutePath);
                    item.file.close();
                    delete item.file;
                    delete this.pending[response.md5];
                    try {
                        fs.unlinkSync(item.path);
                    } catch (err) {
                        if (err.code != "ENOENT")
                            console.error(`Failed to unlink ${item.path} ${err}`);
                    }
                });
                const json = Buffer.from(JSON.stringify(response));
                const headerSizeBuffer = Buffer.allocUnsafe(4);
                headerSizeBuffer.writeUInt32LE(json.length);
                item.write(headerSizeBuffer);
                item.write(json);
                item.jsonLength = json.length;
            }
            stream.pending.push(item);
            if (stream.pending.length == 1 && !stream.pending[0].remaining)
                finishItem(stream.pending[0]);

        });

        stream.on("data", data => {
            const item = stream.pending[0];
            if (data.length > item.remaining)
                throw new Error(`Got too much data here from ${key}. Needed ${item.remaining} got ${data.length}`);
            if (item.file)
                item.write(data);
            item.remaining -= data.length;
            // console.log("Got some bytes here", item.path, data.length, item.remaining, item.redundant ? "redundant" : "");
            if (!item.remaining) {
                finishItem(item);
            }
        });

        this.streams[key] = stream;
        return stream;
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
            ret[key] = prettysize(ret[key], ret[key] >= 1024); // don't want 0Bytes
        });
        return ret;
    }

    remove(md5)
    {
        try {
            this.size -= this.cache[md5].fileSize;
            delete this.cache[md5];
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
};

// let cache = new ObjectCache("/tmp/md5s", 1000000);

// let contents = Buffer.allocUnsafe(4944);
// for (let i=0; i<4944; ++i) {
//     contents[i] = i % 256;
// }

// cache.set("92627632d8d86185a0979fd2f116bd7a",
//           {
//               type: "response",
//               index: [ {path: "CMakeFiles/fisktest.dir/main.cpp.o", "bytes": 4944 }],
//               success: true, exitCode: 0, md5: "92627632d8d86185a0979fd2f116bd7a",
//               stdOut: [],
//               stdErr: []
//           },
//           contents);

module.exports = ObjectCache;
