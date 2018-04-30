const fs = require("fs-extra");
const mkdirp = require("mkdirp");
const path = require("path");

const socket = {
    _queue: [],
    _sending: false,

    enqueue: function enqueue(client, file, skip) {
        socket._queue.push({ client: client, file: file, skip });
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
            const data = {};
            fs.stat(q.file).then(st => {
                if (!st.isFile())
                    throw new Error(`${q.file} not a file`);
                size = st.size;
                return fs.open(q.file);
            }).then(fd => {
                // discard x number of bytes
                // no seek? nice going node
                data.fd = fd;
                const gah = Buffer.alloc(q.skip);
                return fs.read(fd, gah, 0, q.skip);
            }).then(() => {
                // send file size to client
                q.client.send({ type: "environment", bytes: size });
                // read file in chunks and send
                const bufsiz = 32768;
                const buf = Buffer.alloc(bufsiz);
                let remaining = size;
                const readNext = () => {
                    if (!remaining) {
                        socket._sending = false;
                        resolve();
                    }
                    const bytes = Math.min(bufsiz, remaining);
                    remaining -= bytes;
                    fs.read(data.fd, buf, 0, bytes).then(() => {
                        if (bytes === bufsiz) {
                            q.client.send(buf);
                        } else {
                            q.client.send(buf.slice(0, bytes));
                        }
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
    constructor(path, file, host, hostlen) {
        this._path = path;
        this._file = file;
        this._hash = file.substr(0, file.length - 7);
        this._host = host;
        this._hostlen = hostlen;
    }

    get hash() {
        return this._hash;
    }

    get host() {
        return this._host;
    }

    send(client) {
        socket.enqueue(client, path.join(this._path, this._file), this._hostlen);
    }
}

class File {
    constructor(path, environ, host) {
        this._fd = fs.openSync(path, "w");
        this._headerWritten = false;
        this._pending = [];

        this.path = path;
        this.environ = environ;
        this.host = host;
        this.hostlen = undefined;
    }

    save(data) {
        if (!this._fd)
            throw new Error(`No fd for ${this._path}`);
        return new Promise((resolve, reject) => {
            this._pending.push({ data: data, resolve: resolve, reject: reject });
            if (this._pending.length === 1) {
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

            this.hostlen = buf.length + 4;

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
    _environs: [],
    _path: undefined,

    load: function load(path) {
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
                    mkdirp(path, err => {
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

    prepare: function(environ) {
        if (environments._environs.indexOf(environ.hash) !== -1)
            return undefined;
        return new File(path.join(environments._path, environ.hash + ".tar.gz"), environ.hash, environ.host);
    },

    complete: function(file) {
        if (file.hostlen === undefined) {
            throw new Error("File hostlen undefined");
        }
        environments._environs.push(new Environment(file.path, file.environ, file.host, file.hostlen));
    },

    hasEnvironment: function hasEnvironment(hash) {
        for (var i = 0; i < environments._environs.length; ++i) {
            const env = environments._environs[i];
            if (env.hash === hash) {
                return true;
            }
        }
        return false;
    },

    get environments() {
        return environments._environs;
    },

    _read(p) {
        return new Promise((resolve, reject) => {
            fs.readdir(p).then(files => {
                let envs = files.filter(e => e.endsWith(".tar.gz"));
                // let toread = [];
                // for (let i = 0; i < envs.length; ++i) {
                //     toread.push(envs[i])
                //     environments._environs.push(new Environment(p, envs[i]));
                // }
                const next = () => {
                    if (!envs.length) {
                        resolve();
                        return;
                    }
                    const env = envs.shift();
                    let data = {};
                    fs.open(path.join(p, env)).then(fd => {
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
                        const host = data.buf.toString("utf8", 4, hostlen);
                        environments._environs.push(new Environment(p, env, host, hostlen));
                    }).catch(e => {
                        if (data.fd) {
                            fs.closeSync(data.fd);
                        }
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
