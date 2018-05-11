const fs = require("fs-extra");
const path = require("path");

const socket = {
    _queue: [],
    _sending: false,

    enqueue(client, hash, file, skip) {
        socket._queue.push({ client: client, hash: hash, file: file, skip });
        if (!socket._sending) {
            socket._next().then(() => {
                if (socket._queue.length > 0) {
                    process.nextTick(socket._next);
                }
            }).catch(e => {
                console.error(e);
            });
        }
    },

    _next() {
        socket._sending = true;
        const q = socket._queue.shift();
        let size;
        return new Promise((resolve, reject) => {
            fs.stat(q.file).then(st => {
                if (!st.isFile())
                    throw new Error(`${q.file} not a file`);
                size = st.size;
                return fs.open(q.file, "r");
            }).then(fd => {
                let remaining = size;
                if (q.skip) {
                    let buf = Buffer.allocUnsafe(q.skip);
                    fs.readSync(fd, buf, 0, q.skip);
                    remaining -= q.skip;
                }
                // send file size to client
                q.client.send({ type: "environment", bytes: remaining, hash: q.hash });
                // read file in chunks and send
                let idx = 0;
                let last = undefined;
                const readNext = () => {
                    if (!remaining) {
                        socket._sending = false;
                        resolve();
                        return;
                    }
                    const bytes = Math.min(32768, remaining);
                    const buf = Buffer.allocUnsafe(bytes);

                    remaining -= bytes;
                    fs.read(fd, buf, 0, bytes).then(() => {
                        q.client.send(buf);
                        readNext();
                    }).catch(e => {
                        throw e;
                    });
                };
                readNext();
            }).catch(e => {
                socket._sending = false;
                reject(e);
            });
        });
    }
};

class Environment {
    constructor(path, hash, host, hostlen) {
        this._path = path;
        this._hash = hash;
        this._host = host;
        this._hostlen = hostlen;
        console.log("Created environment", JSON.stringify(this));
    }

    get hash() {
        return this._hash;
    }

    get host() {
        return this._host;
    }

    get file() {
        return this._hash + ".tar.gz";
    }

    send(client) {
        socket.enqueue(client, this.hash, this._path, this._hostlen + 4);
    }
}

class File {
    constructor(path, hash, host) {
        this._fd = fs.openSync(path, "w");
        this._headerWritten = false;
        this._pending = [];
        this._writing = false;

        this.path = path;
        this.hash = hash;
        this.host = host;
        this.hostlen = undefined;
    }

    save(data) {
        if (!this._fd)
            throw new Error(`No fd for ${this._path}`);
        return new Promise((resolve, reject) => {
            this._pending.push({ data: data, resolve: resolve, reject: reject });
            if (!this._writing) {
                this._writing = true;
                this._write();
            }
        });
    }

    discard() {
        if (!this._fd)
            throw new Error(`No fd for ${this._path}`);
        fs.closeSync(this._fd);
        fs.unlinkSync(this._path);
    }

    close() {
        if (!this._fd)
            throw new Error(`No fd for ${this._path}`);
        fs.closeSync(this._fd);
        this._fd = undefined;
    }

    _write() {
        const pending = this._pending.shift();
        this._writeHeader().then(() => {
            fs.write(this._fd, pending.data).then(() => {
                pending.resolve();

                if (this._pending.length > 0) {
                    process.nextTick(() => { this._write(); });
                } else {
                    this._writing = false;
                }
            }).catch(e => {
                fs.closeSync(this._fd);
                this._fd = undefined;
                pending.reject(e);
                this._clearPending(e);
            });
        }).catch(e => {
            fs.closeSync(this._fd);
            this._fd = undefined;
            pending.reject(e);
            this._clearPending(e);
        });
    }

    _writeHeader() {
        return new Promise((resolve, reject) => {
            if (this._headerWritten) {
                resolve();
                return;
            }
            this._headerWritten = true;

            const buf = Buffer.from(this.host, "utf8");
            const hdr = Buffer.alloc(4);

            this.hostlen = buf.length;

            hdr.writeUInt32LE(buf.length, 0);
            // console.log("writing header", buf.length + 4);
            fs.write(this._fd, Buffer.concat([hdr, buf], buf.length + 4)).then(() => {
                resolve();
            }).catch(e => {
                reject(e);
            });
        });
    }

    _clearPending(e) {
        if (!this._pending)
            return;

        for (let i = 0; i < this._pending.length; ++i) {
            this._pending[i].reject(e);
        }
        this._pending = undefined;
    }
}

const environments = {
    _data: {},
    _path: undefined,

    load(path) {
        return new Promise((resolve, reject) => {
            fs.stat(path).then(st => {
                if (st.isDirectory()) {
                    // we're good
                    environments._path = path;
                    environments._read(path).then(() => {
                        resolve();
                    }).catch(e => {
                        reject(`Can't make directory ${path}: ${e.message}`);
                    });
                } else {
                    reject(`Can't use path ${path}`);
                }
            }).catch(e => {
                if ("code" in e && e.code == "ENOENT") {
                    // make the directory
                    fs.mkdirp(path, err => {
                        if (err) {
                            reject(`Can't make directory ${path}: ${e.message}`);
                            return;
                        }
                        // we're good
                        environments._path = path;
                        resolve();
                    });
                } else {
                    reject(`Can't make directory ${path}: ${e.message}`);
                }
            });
        });
    },

    prepare(environment) {
        if (environment.hash in environments._data)
            return undefined;
        return new File(path.join(environments._path, environment.hash + ".tar.gz"), environment.hash, environment.host);
    },

    complete(file) {
        if (file.hostlen === undefined) {
            throw new Error("File hostlen undefined");
        }
        environments._data[file.hash] = new Environment(file.path, file.hash, file.host, file.hostlen);
    },

    hasEnvironment(hash) {
        return hash in environments._data;
    },

    get environments() {
        return environments._data;
    },

    environment(hash) {
        if (!(hash in environments._data))
            return undefined;
        return environments._data[hash];
    },

    _read(p) {
        return new Promise((resolve, reject) => {
            fs.readdir(p).then(files => {
                let envs = files.filter(e => e.endsWith(".tar.gz"));
                const next = () => {
                    if (!envs.length) {
                        resolve();
                        return;
                    }
                    const env = envs.shift();
                    let data = {};

                    fs.open(path.join(p, env), "r").then(fd => {
                        data.fd = fd;
                        data.buf = Buffer.alloc(1024);
                        return fs.read(fd, data.buf, 0, 1024);
                    }).then(bytes => {
                        if (bytes < 4) {
                            throw `Read ${bytes} from ${env}`;
                        }
                        data.bytes = bytes;
                        const fd = data.fd;
                        data.fd = undefined;
                        return fs.close(fd);
                    }).then(() => {
                        const hostlen = data.buf.readUInt32LE(0);
                        const host = data.buf.toString("utf8", 4, hostlen + 4);
                        const hash = env.substr(0, env.length - 7);
                        environments._data[hash] = new Environment(path.join(p, env), hash, host, hostlen);
                        process.nextTick(next);
                    }).catch(e => {
                        if (data.fd) {
                            fs.closeSync(data.fd);
                        }
                        console.error(e);
                        process.nextTick(next);
                    });
                };
                next();
            }).catch(e => {
                reject(e);
            });
        });
    }
};

module.exports = environments;
