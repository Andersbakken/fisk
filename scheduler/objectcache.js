const fs = require('fs-extra');
const path = require('path');

class ObjectCacheItem
{
    constructor(fileName, absolutePath, response, contents)
    {
        this.fileName = fileName;
        let fd;
        const headerLengthBuffer = Buffer.allocUnsafe(4);
        if (response) {
            fd = fs.openSync(absolutePath, "w");
            const json = Buffer.from(JSON.stringify(response));;
            headerLengthBuffer.writeUInt32LE(json.length);
            fs.writeSync(fd, headerLengthBuffer);
            fs.writeSync(fd, json);
            let contentsLength = 0;
            contents.forEach(file => {
                contentsLength += file.length;
                fs.writeSync(fd, file);
            });
            this.contentsSize = headerLengthBuffer.length + json.length + contentsLength;
            this.headerLength = json.length;
            this.response = response;
            // console.log("wrote some shit", absolutePath);
        } else {
            fd = fs.openSync(absolutePath, "r");
            fs.readSync(fd, headerLengthBuffer, 0, 4);
            this.headerLength = headerLengthBuffer.readUInt32LE(0);
            const jsonBuffer = Buffer.allocUnsafe(this.headerLength);
            fs.readSync(fd, jsonBuffer, 0, this.headerLength);
            this.response = JSON.parse(jsonBuffer.toString());
            this.contentsSize = fs.fstatSync(fd).size - this.headerLength - 4;
        }
        fs.closeSync(fd);
    }

    get fileSize() { return 4 + this.headerLength + this.contentsSize; }

    // get contentsSize
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
        this.size = 0;
        // console.log(fs.readdirSync(this.dir, { withFileTypes: true }));
        try {
            fs.readdirSync(this.dir).forEach(fileName => {
                try {
                    if (fileName.length == 32) {
                        let item = new ObjectCacheItem(fileName, path.join(dir, fileName));
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

    has(md5)
    {
        return md5 in this.cache;
    }

    get keys()
    {
        return Object.keys(this.cache);
    }

    set(md5, response, contents)
    {
        if (this.has(md5))
            return;
        let buf = new ObjectCacheItem(md5, path.join(this.dir, md5), response, contents);
        this.cache[md5] = buf;
        this.size += buf.fileSize;
        if (this.size > this.maxSize)
            this.purge(this.purgeSize);
    }

    purge(targetSize)
    {
        for (let md5 in this.cache) {
            if (this.size <= targetSize) {
                break;
            }
            try {
                console.log(`purging ${md5} because ${this.size} >= ${targetSize}`);
                fs.unlinkSync(path.join(this.dir, md5));
                this.size -= this.cache[md5].fileSize;
            } catch (err) {
                console.error("Can't purge file", path.join(this.dir, md5), err.toString());
            }
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
