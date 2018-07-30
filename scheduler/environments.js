const fs = require("fs-extra");
const path = require("path");

const socket = {
    _queue: new Map(),

    requestEnvironments(client) {
        console.log("queueing requestEnvironments");
        var key = client.ip + " " + client.port;
        if (!socket._queue[key])
            socket._queue[key] = { client: client, sending: false, messages: [] };
        socket._queue[key].messages.push({ requestEnvironments: true });
        if (!socket._queue[key].sending) {
            socket._next(key);
        }
    },
    enqueue(client, hash, system, file) {
        console.log("queuing", file, hash, "for", client.ip);
        var key = client.ip + " " + client.port;
        if (!socket._queue[key])
            socket._queue[key] = { client: client, sending: false, messages: [] };

        let found = false;
        if (!socket._queue[key].messages.find(pending => pending.hash == hash && pending.system == system && pending.file == file)) {
            socket._queue[key].messages.push({ hash: hash, system: system, file: file });
            if (!socket._queue[key].sending) {
                socket._next(key);
            }
        }
    },

    _next(key) {
        let data = socket._queue[key];
        if (data.sending)
            throw new Error("We're already sending!");
        data.sending = true;
        let client = data.client;
        const q = data.messages.shift();
        console.log("about to send", q, "to", key);
        if (q.requestEnvironments) {
            client.send({ type: "requestEnvironments" });
            data.sending = false;
            if (data.messages.length)
                process.nextTick(socket._next, key);
            return;
        }
        let size;
        // console.log("About to send", q.file, "to", client.ip, ":", client.port);
        fs.stat(q.file).then(st => {
            if (!st.isFile())
                throw new Error(`${q.file} not a file`);
            size = st.size;
            return fs.open(q.file, "r");
        }).then(fd => {
            let remaining = size;
            // send file size to client
            client.send({ type: "environment", bytes: remaining, hash: q.hash, system: q.system });
            // read file in chunks and send
            let idx = 0;
            let last = undefined;
            const readNext = () => {
                if (!remaining) {
                    data.sending = false;
                    console.log("Finished sending env", q.file, data.messages.length, key);
                    if (data.messages.length) {
                        process.nextTick(socket._next, key);
                    } else {
                        delete socket._queue[key];
                        console.log(`queue for ${key} is empty`);
                    }
                    return;
                }
                const bytes = Math.min(32768, remaining);
                const buf = Buffer.allocUnsafe(bytes);

                remaining -= bytes;
                fs.read(fd, buf, 0, bytes).then(() => {
                    client.send(buf);
                    readNext();
                }).catch(e => {
                    throw e;
                });
            };
            readNext();
        }).catch(e => {
            data.sending = false;
            console.error("Got error when sending", e.message, e.stack);
        });
    }
};

class Environment {
    constructor(path, hash, system, originalPath) {
        this.path = path;
        this.hash = hash;
        this.system = system;
        this.originalPath = originalPath;
        try {
            this.size = fs.statSync(path).size;
        } catch (err) {
        }
        console.log("Created environment", JSON.stringify(this), originalPath);
    }


    get file() {
        return `${this.hash}_${this.system}.tar.gz`;
    }

    send(client) {
        socket.enqueue(client, this.hash, this.system, this.path);
    }

    canRun(system) {
        switch (system) {
        case 'Linux i686':
        case 'Darwin i686': // ### this is not really a thing
            return this.system == system;
        case 'Linux x86_64':
            return !!/^Linux /.exec(this.system);
        case 'Darwin x86_64':
            return !!/^Darwin /.exec(this.system);
        default:
            console.error("Unknown system", system);
            return false;
        }
    }
}

class File {
    constructor(path, hash, system, originalPath) {
        this._fd = fs.openSync(path, "w");
        this._pending = [];
        this._writing = false;

        this.path = path;
        this.hash = hash;
        this.system = system;
        this.originalPath = originalPath;
    }

    save(data) {
        if (!this._fd)
            throw new Error(`No fd for ${this.path}`);
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
            throw new Error(`No fd for ${this.path}`);
        fs.closeSync(this._fd);
        fs.unlinkSync(this.path);
    }

    close() {
        if (!this._fd)
            throw new Error(`No fd for ${this.path}`);
        fs.closeSync(this._fd);
        this._fd = undefined;
    }

    _write() {
        const pending = this._pending.shift();
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

    load(p) {
        return new Promise((resolve, reject) => {
            fs.stat(p).then(st => {
                if (st.isDirectory()) {
                    // we're good
                    environments._path = p;
                    fs.readdir(p).then(files => {
                        files.forEach(e => {
                            let match = /^([^:]*):([^:]*):([^:]*).tar.gz$/.exec(e);
                            if (match) {
                                const hash = match[1];
                                const system = match[2];
                                const originalPath = decodeURIComponent(match[3]);
                                environments._data[hash] = new Environment(path.join(p, e), hash, system, originalPath);
                            }
                        });
                        resolve();
                    });
                } else {
                    reject(`Can't use path ${p}`);
                }
            }).catch(e => {
                if ("code" in e && e.code == "ENOENT") {
                    // make the directory
                    fs.mkdirp(p, err => {
                        if (err) {
                            reject(`Can't make directory ${p}: ${e.message}`);
                            return;
                        }
                        // we're good
                        environments._path = p;
                        resolve();
                    });
                } else {
                    reject(`Can't make directory ${p}: ${e.message}`);
                }
            });
        });
    },

    prepare(environment) {
        if (environment.hash in environments._data)
            return undefined;
        fs.mkdirpSync(environments._path);
        return new File(path.join(environments._path, `${environment.hash}:${environment.system}:${encodeURIComponent(environment.originalPath)}.tar.gz`),
                        environment.hash, environment.system, environment.originalPath);
    },

    complete(file) {
        environments._data[file.hash] = new Environment(file.path, file.hash, file.system, file.originalPath);
    },

    hasEnvironment(hash) {
        return hash in environments._data;
    },

    requestEnvironments(slave) {
        socket.requestEnvironments(slave);
    },

    get environments() {
        return environments._data;
    },

    environment(hash) {
        if (!(hash in environments._data))
            return undefined;
        return environments._data[hash];
    },

    remove(hash) {
        try {
            fs.removeSync(environments._data[hash].path);
            delete environments._data[hash];
        } catch (err) {
            console.error("Failed to remove environment", environments._data[hash].path, err);
            return;
        }
    }
};

module.exports = environments;
