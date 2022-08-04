const fs = require("fs-extra");
const path = require("path");
const child_process = require("child_process");
const mktemp = require("mktemp");

function untarFile(archive, file, encoding) {
    return new Promise((resolve, reject) => {
        mktemp.createDir("/tmp/fisk_env_infoXXXX").then((tmpdir) => {
            child_process.exec(`tar -zxf "${archive}" ${file}`, { cwd: tmpdir }, (err, stdout, stderr) => {
                if (err) {
                    reject(err);
                    return;
                }
                fs.readFile(path.join(tmpdir, file), encoding || "utf8", (err, data) => {
                    try {
                        fs.removeSync(tmpdir);
                    } catch (e) {
                        console.error("Got an error removing the temp dir", tmpdir);
                    }
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
        });
    });
}

class Environment {
    constructor(path, hash, system, originalPath) {
        this.path = path;
        this.hash = hash;
        this.system = system;
        this.originalPath = originalPath;
        this.info = undefined;
        try {
            this.size = fs.statSync(path).size;
        } catch (err) {}
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
            case "Linux i686":
            case "Darwin i686": // ### this is not really a thing
                return this.system === system;
            case "Linux x86_64":
                return !!/^Linux /.exec(this.system);
            case "Darwin x86_64":
                return !!/^Darwin /.exec(this.system);
            default:
                console.error("Unknown system", system);
                return false;
        }
    }
}

class File {
    constructor(path, hash) {
        this._fd = fs.openSync(path, "w");
        this._pending = [];
        this._writing = false;

        this.path = path;
        this.hash = hash;
        this.system = undefined;
        this.originalPath = undefined;
    }

    toString() {
        return JSON.stringify(this, null, 4);
    }

    save(data) {
        if (!this._fd) throw new Error(`No fd for ${this.path}`);
        return new Promise((resolve, reject) => {
            this._pending.push({ data: data, resolve: resolve, reject: reject });
            if (!this._writing) {
                this._writing = true;
                this._write();
            }
        });
    }

    discard() {
        if (!this._fd) throw new Error(`No fd for ${this.path}`);
        fs.closeSync(this._fd);
        fs.unlinkSync(this.path);
    }

    close() {
        if (!this._fd) throw new Error(`No fd for ${this.path}`);
        fs.closeSync(this._fd);
        this._fd = undefined;
    }

    _write() {
        const pending = this._pending.shift();
        fs.write(this._fd, pending.data)
            .then(() => {
                pending.resolve();

                if (this._pending.length > 0) {
                    process.nextTick(() => {
                        this._write();
                    });
                } else {
                    this._writing = false;
                }
            })
            .catch((e) => {
                fs.closeSync(this._fd);
                this._fd = undefined;
                pending.reject(e);
                this._clearPending(e);
            });
    }

    _clearPending(e) {
        if (!this._pending) return;

        for (let i = 0; i < this._pending.length; ++i) {
            this._pending[i].reject(e);
        }
        this._pending = undefined;
    }
}

class LinkProperties {
    constructor(args, blacklist) {
        this.arguments = args || [];
        this.blacklist = blacklist || [];
    }

    toString() {
        return JSON.stringify(this, null, 4);
    }
}

class Links {
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
        this._targets[targetHash] = new LinkProperties(args, blacklist);
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
}

const environments = {
    _data: {}, // key: hash, value: class Environment
    _links: {}, // key: srcHash, value: class Links { targetHash, LinkProperties { arguments, blacklist } }
    _path: undefined,
    _db: undefined,

    load(db, p) {
        this._db = db;
        return db.get("links").then((links) => {
            if (links) {
                for (var srcHash in links) {
                    let targets = links[srcHash];
                    let data = (environments._links[srcHash] = new Links());
                    for (let target in targets) {
                        let obj = targets[target];
                        data.set(target, obj.arguments, obj.blacklist);
                    }
                }
            }
            return new Promise((resolve, reject) => {
                fs.stat(p)
                    .then((st) => {
                        if (st.isDirectory()) {
                            // we're good
                            environments._path = p;
                            fs.readdir(p).then((files) => {
                                let promises = [];
                                files.forEach((e) => {
                                    if (e.length === 47 && e.indexOf(".tar.gz", 40) === 40) {
                                        const tarFile = path.join(p, e);
                                        const hash = e.substr(0, 40);
                                        let env = new Environment(tarFile);
                                        promises.push(
                                            untarFile(tarFile, "etc/compiler_info")
                                                .then((data) => {
                                                    const idx = data.indexOf("\n");
                                                    const info = JSON.parse(data.substr(0, idx));
                                                    env.system = info.system;
                                                    env.originalPath = info.originalPath;
                                                    env.info = data.substr(idx + 1);
                                                    environments._data[hash] = env;
                                                })
                                                .catch((err) => {
                                                    console.error("Failed to extract compiler_info", err);
                                                })
                                        );
                                    }
                                });
                                Promise.all(promises).then(() => {
                                    resolve();
                                });

                                // setTimeout(() => {
                                //     // console.log(JSON.stringify(environments._links, null, 4));
                                //     environments.link("28CD22DF1176120F63EC463E095F13D4330194D7", "177EF462A7AEC31C26502F5833A92B51C177C01B", [], []);
                                // }, 1000);
                            });
                        } else {
                            reject(`Can't use path ${p}`);
                        }
                    })
                    .catch((e) => {
                        if ("code" in e && e.code == "ENOENT") {
                            // make the directory
                            fs.mkdirp(p, (err) => {
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
        if (environment.hash in environments._data) return undefined;
        fs.mkdirpSync(environments._path);
        return new File(path.join(environments._path, `${environment.hash}.tar.gz`), environment.hash);
    },

    complete(file) {
        return new Promise((resolve, reject) => {
            untarFile(file.path, "etc/compiler_info").then((data) => {
                let env = new Environment(file.path, file.hash);
                const idx = data.indexOf("\n");
                const info = JSON.parse(data.substr(0, idx));
                env.system = info.system;
                env.originalPath = info.originalPath;
                env.info = data.substr(idx + 1);
                environments._data[file.hash] = env;
                resolve();
            });
        });
    },

    hasEnvironment(hash) {
        return hash in environments._data;
    },

    compatibleEnvironments(srcHash) {
        let compatible = [];
        if (srcHash in environments._data) compatible.push(srcHash);
        // console.log("checking", srcHash, environments._links);
        let data = environments._links[srcHash];
        if (data) return compatible.concat(data.targetHashes);
        return compatible;
    },

    extraArgs(srcHash, targetHash) {
        let data = environments._links[srcHash];
        if (data) {
            return data.arguments(targetHash);
        }
        return [];
    },

    link(srcHash, targetHash, args, blacklist) {
        let data = environments._links[srcHash];
        if (!data) data = environments._links[srcHash] = new Links();
        data.set(targetHash, args, blacklist);
        return this.syncLinks();
    },

    unlink(srcHash, targetHash) {
        if (!srcHash) {
            for (let src in environments._links) {
                let targets = environments._links[src];
                targets.unset(targetHash);
                if (!targets.size) {
                    delete environments._links[src];
                }
            }
        } else if (!targetHash) {
            delete environments._links[srcHash];
        } else {
            let targets = environments._links[srcHash];
            targets.unset(targetHash);
            if (!targets.size) {
                delete environments._links[srcHash];
            }
        }
        return this.syncLinks();
    },

    get environments() {
        return environments._data;
    },

    environment(hash) {
        if (!(hash in environments._data)) return undefined;
        return environments._data[hash];
    },

    linksInfo() {
        let obj = {};
        for (let srcHash in this._links) {
            obj[srcHash] = this._links[srcHash].targets;
        }
        return obj;
    },

    syncLinks() {
        return this._db.set("links", this.linksInfo());
    },

    remove(hash) {
        // ### this should be promisified
        try {
            fs.removeSync(environments._data[hash].path);
            delete environments._data[hash];
            this.unlink(hash);
            this.unlink(undefined, hash);
            this.syncLinks();
        } catch (err) {
            console.error("Failed to remove environment", environments._data[hash].path, err);
            return;
        }
    }
};

export { environments };
