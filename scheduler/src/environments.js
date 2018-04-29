const fs = require("fs-extra");
const mkdirp = require("mkdirp");
const path = require("path");

class File {
    constructor(path, environ) {
        this._path = path;
        this._fd = fs.openSync(path, "w");

        this.environ = environ;
    }

    save(data) {
        if (!this._fd)
            throw new Error(`No fd for ${this._path}`);
        return new Promise((resolve, reject) => {
            fs.write(this._fd, data).then(() => {
                resolve();
            }).catch(e => {
                fs.closeSync(this._fd);
                this._fd = undefined;

                reject(e);
            });
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
}

const send = {
    _queue: [],
    _sending: false,

    enqueue: function enqueue(client, file) {
        send._queue.push({ client: client, file: file });
        if (!send._sending) {
            send._next().then(() => {
                if (send._queue.length > 0) {
                    process.nextTick(send._next);
                }
            }).catch(e => {
                console.error(e);
            });
        }
    },

    _next() {
        send._sending = true;
        const q = send._queue.shift();
        let size;
        return new Promise((resolve, reject) => {
            fs.stat(q.file).then(st => {
                if (!st.isFile())
                    throw new Error(`${q.file} not a file`);
                size = st.size;
                return fs.open(q.file);
            }).then(fd => {
                // send file size to client
                q.client.send({ type: "environment", bytes: size });
                // read file in chunks and send
                const bufsiz = 32768;
                const buf = Buffer.alloc(bufsiz);
                let remaining = size;
                const readNext = () => {
                    if (!remaining) {
                        send._sending = false;
                        resolve();
                    }
                    const bytes = Math.min(bufsiz, remaining);
                    remaining -= bytes;
                    fs.read(fd, buf, 0, bytes).then(() => {
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
                send._sending = false;
                reject(e);
            });
        });
    }
};

class Environment {
    constructor(path, file) {
        this._path = path;
        this._file = file;
        this._hash = file.substr(0, file.length - 7);
    }

    get hash() {
        return this._hash;
    }

    send(client) {
        send.enqueue(client, path.join(this._path, this._file));
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
                        resolve();
                    });
                } else {
                    reject(`Can't make directory ${path}: ${e.message}`);
                }
            });
        });
    },

    prepare: function(environ) {
        if (environments._environs.indexOf(environ.message) !== -1)
            return undefined;
        return new File(path.join(environments._path, environ.message + ".tar.gz"), environ.message);
    },

    complete: function(file) {
        environments._environs.push(file.environ);
    },

    get environments() {
        return environments._environs;
    },

    _read(path) {
        environments._path = path;
        return new Promise((resolve, reject) => {
            fs.readdir(path).then(files => {
                const envs = files.filter(e => e.endsWith(".tar.gz"));
                for (let i = 0; i < envs.length; ++i) {
                    environments._environs.push(path, new Environment(envs[i]));
                }
                resolve();
            }).catch(e => {
                reject(e);
            });
        });
    }
};

module.exports = environments;
