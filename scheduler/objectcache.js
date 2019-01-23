const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require("events");

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
        if (!redundant) {
            this.file = fs.createWriteStream(path);
            this.file.on("drain", () => {
                let buf = this.buffer;
                this.buffer = undefined;
                buf.forEach(b => this.write(b));
            });
            this.buffer = undefined;
        }
    }

    write(data) {
        if (this.buffer) {
            this.buffer.push(data);
        } else if (!this.file.write(data)) {
            this.buffer = [ data ];
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
            fs.readdirSync(this.dir).forEach(fileName => {
                try {
                    if (fileName.length == 32) {
                        let fd;
                        const headerSizeBuffer = Buffer.allocUnsafe(4);
                        fd = fs.openSync(path.join(dir, fileName), "r");
                        fs.readSync(fd, headerSizeBuffer, 0, 4);
                        const headerSize = headerSizeBuffer.readUInt32LE(0);
                        const jsonBuffer = Buffer.allocUnsafe(headerSize);
                        fs.readSync(fd, jsonBuffer, 0, headerSize);
                        fs.closeSync(fd);
                        const response = JSON.parse(jsonBuffer.toString());
                        if (response.md5 != fileName)
                            throw new Error(`Got bad filename: ${fileName} vs ${response.md5}`);
                        let item = new ObjectCacheItem(response, headerSize);
                        this.size += item.fileSize;
                        this.cache[fileName] = item;
                    }
                } catch (err) {
                    console.error("got failure", err);
                    try {
                        fs.unlinkSync(path.join(dir, fileName));
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

    createStream(ip, port)
    {
        const key = ip + ":" + port;
        if (key in this.streams) {
            throw new Error("We already have this stream", key);
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
            delete this.streams[key];
        });
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
                if (item.file) {
                    item.file.end();
                    if (item.file) { // can end emit an error synchronously?
                        let cacheItem = new ObjectCacheItem(item.response, item.jsonLength);
                        this.cache[item.response.md5] = cacheItem;
                        this.size += cacheItem.fileSize;
                        if (this.size > this.maxSize)
                            this.purge(this.purgeSize);
                        delete this.pending[item.response.md5];
                        // console.log("finished a file", item.response.md5);
                    }
                }
                stream.pending.splice(0, 1);
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

    dump()
    {
        return Object.assign({ cacheHits: this.cacheHits, usage: this.size / this.maxSize }, this);
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
        return this.cache[md5];
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
