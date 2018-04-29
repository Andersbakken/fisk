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
                environments._environs = files.filter(e => e.endsWith(".tar.gz")).map(e => e.substr(0, e.length - 7));
                resolve();
            }).catch(e => {
                reject(e);
            });
        });
    }
};

module.exports = environments;
