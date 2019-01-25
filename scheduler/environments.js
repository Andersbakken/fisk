const fs = require("fs-extra");
const path = require("path");

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

    toString() {
        return JSON.stringify(this, null, 4);
    }

    get file() {
        return `${this.hash}_${this.system}.tar.gz`;
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

    toString() {
        return JSON.stringify(this, null, 4);
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

class CompatibilityProperties {
    constructor(args, blacklist) {
        this.arguments = args || [];
        this.blacklist = blacklist || [];
    }

    toString() {
        return JSON.stringify(this, null, 4);
    }
};

class Compatibilities {
    constructor() {
        this._targets = {};
    }

    toString() {
        return JSON.stringify(this, null, 4);
    }

    get targets() {
        return this._targets;
    }

    toObject() {
        return this._targets;
    }

    contains(targetHash) {
        return targetHash in this._targets;
    }

    arguments(targetHash) {
        const ret = this._targets[targetHash];
        return ret ? ret.arguments : [];
    }

    blacklist(targetHash) {
        const ret = this._targets[targetHash];
        return ret ? ret.blacklist : [];
    }

    set(targetHash, args, blacklist) {
        this._targets[targetHash] = new CompatibilityProperties(args, blacklist);
    }

    unset(targetHash) {
        delete this._targets[targetHash];
    }

    get targetHashes() {
        return Object.keys(this._targets);
    }

    get size() {
        return Object.keys(this._targets).length;
    }
};

const environments = {
    _data: {}, // key: hash, value: class Environment
    _compatibilities: {}, // key: srcHash, value: class Compatibilities { targetHash, CompatibilityProperties { arguments, blacklist } }
    _path: undefined,
    _db: undefined,

    load(db, p) {
        this._db = db;
        return db.get("compatibilities").then(compatibilities => {
            if (compatibilities) {
                for (var srcHash in compatibilities) {
                    let targets = compatibilities[srcHash];
                    let data = environments._compatibilities[srcHash] = new Compatibilities();
                    for (let target in targets) {
                        let obj = targets[target];
                        data.set(target, obj.arguments, obj.blacklist);
                    }
                }
            }
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
                            // setTimeout(() => {
                            //     // console.log(JSON.stringify(environments._compatibilities, null, 4));
                            //     environments.link("28CD22DF1176120F63EC463E095F13D4330194D7", "177EF462A7AEC31C26502F5833A92B51C177C01B", [], []);
                            // }, 1000);
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

    compatibleEnvironments(srcHash) {
        let compatible = [];
        if (srcHash in environments._data)
            compatible.push(srcHash);
        // console.log("checking", srcHash, environments._compatibilities);
        let data = environments._compatibilities[srcHash];
        if (data)
            return compatible.concat(data.targetHashes);
        return compatible;
    },

    link(srcHash, targetHash, args, blacklist) {
        let data = environments._compatibilities[srcHash];
        if (!data)
            data = environments._compatibilities[srcHash] = new Compatibilities();
        data.set(targetHash, args, blacklist);
        return this.syncCompatibilities();
    },

    unlink(srcHash, targetHash) {
        if (!srcHash) {
            for (let src in environments._compatibilities) {
                let targets = environments._compatibilities[src];
                targets.unset(targetHash);
                if (!targets.size) {
                    delete environments._compatibilities[src];
                }
            }
        } else if (!targetHash) {
            delete environments._compatibilities[srcHash];
        } else {
            let targets = environments._compatibilities[srcHash];
            targets.unset(targetHash);
            if (!targets.size) {
                delete environments._compatibilities[srcHash];
            }
        }
        return this.syncCompatibilities();
    },

    get environments() {
        return environments._data;
    },

    environment(hash) {
        if (!(hash in environments._data))
            return undefined;
        return environments._data[hash];
    },

    compatibilitiesInfo() {
        let obj = {};
        for (let srcHash in this._compatibilities) {
            obj[srcHash] = this._compatibilities[srcHash].targets;
        }
        return obj;
    },

    syncCompatibilities() {
        return this._db.set("compatibilities", this.compatibilitiesInfo());
    },

    remove(hash) { // ### this should be promisified
        try {
            fs.removeSync(environments._data[hash].path);
            delete environments._data[hash];
            this.unlink(hash);
            this.unlink(undefined, hash);
            this.syncCompatibilities();
        } catch (err) {
            console.error("Failed to remove environment", environments._data[hash].path, err);
            return;
        }
    }
};

module.exports = environments;
