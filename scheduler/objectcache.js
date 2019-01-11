const fs = require('fs-extra');
const path = require('path');

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
                        const response = JSON.parse(jsonBuffer.toString());
                        if (response.md5 != fileName)
                            throw new Error(`Got bad filename: ${fileName} vs ${response.md5}`);
                        fs.closeSync(fd);
                        let item = new ObjectCacheItem(response, headerSize);
                        this.size += item.fileSize;
                        this.cache[fileName] = item;
                    }
                } catch (err) {
                    console.log("got failure", err);
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

    insert(response, cb)
    {
        if (this.state(response.md5) != "none")
            throw new Error(`Already doing this response.md5: ${response.md5}`);

        let aborted = false;
        let finished = false;
        let error = false;

        const absolutePath = path.join(this.dir, response.md5);
        const fd = fs.openSync(absolutePath, "w");
        const json = Buffer.from(JSON.stringify(response));;
        const headerSizeBuffer = Buffer.allocUnsafe(4);
        let remaining = 0;
        response.index.forEach(file => { remaining += file.bytes; });
        headerSizeBuffer.writeUInt32LE(json.length);
        fs.writeSync(fd, headerSizeBuffer);
        fs.writeSync(fd, json);
        this.pending[response.md5] = true;

        const pieces = [];

        let writing = false;
        const write = () => {
            // console.log(`write called for ${response.md5}`);
            if (writing || !pieces.length)
                return;
            writing = true;
            const piece = pieces.splice(0, 1)[0];
            const onWrite = (err) => {
                if (aborted) {
                    try {
                        fs.closeSync(fd);
                        fs.unlinkSync(fd);
                    } catch (err) {
                    }
                    delete this.pending[response.md5];
                    cb(false);
                    return;
                }
                writing = false;
                if (err)
                    error = true;
                // console.log(`wrote ${piece.length} out of ${remaining}`);
                remaining -= piece.length;
                if (!remaining) {
                    delete this.pending[response.md5];
                    finished = true;
                    if (error) {
                        try {
                            fs.closeSync(fd);
                            fd.unlinkSync(fd);
                        } catch (e) {
                            console.error(`Failed to do something here for ${response.md5} ${e}`);
                        }
                    } else {
                        let buf = new ObjectCacheItem(response, json.length);
                        this.cache[response.md5] = buf;
                        this.size += buf.fileSize;
                        if (this.size > this.maxSize)
                            this.purge(this.purgeSize);
                    }
                    cb(!error);
                }
            };

            if (error) {
                onWrite(undefined);
            } else {
                fs.write(fd, piece, onWrite);
            }
        };

        return {
            feed: (data) => {
                // console.log(`feed called for ${response.md5}`);
                if (aborted)
                    throw new Error("You've already aborted you dolt");
                if (finished)
                    throw new Error("You've already finished you nitwit");

                pieces.push(data);
                write();
            },
            abort: (data) => {
                if (aborted)
                    throw new Error("You've already finished you dunce");
                if (finished)
                    throw new Error("You've already finished you chump");

                aborted = true;
                if (!writing) {
                    try {
                        fs.closeSync(fd);
                        fs.unlinkSync(fd);
                    } catch (err) {
                    }
                    delete this.pending[response.md5];
                    cb(undefined, false);
                }
            }
        };
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
        return Object.assign({ cacheHits: this.cacheHits }, this);
    }

    remove(md5)
    {
        try {
            fs.unlinkSync(path.join(this.dir, md5));
            this.size -= this.cache[md5].fileSize;
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
