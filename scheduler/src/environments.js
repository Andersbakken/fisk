const fs = require("fs-extra");
const mkdirp = require("mkdirp");

const environments = {
    _environs: [],
    _path: undefined,
    _saving: undefined,

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
        if (environments._saving)
            throw new Error("Already saving");
        environments._saving = { environ: environ };
        try {
            environments._saving.fd = fs.openSync(environ.message + ".tar.gz", "w");
        } catch (e) {
            environments._saving = undefined;
            throw e;
        }
    },

    save: function save(data) {
        if (!environments._saving)
            throw new Error("Not saving");
        return new Promise((resolve, reject) => {
            fs.write(environments._saving.fd, data).then(() => {
                resolve();
            }).catch(e => {
                reject(e);
            });
        });
    },

    complete: function() {
        if (!environments._saving)
            throw new Error("Not saving");
        fs.closeSync(environments._saving.fd);
        environments._saving = undefined;
        return new Promise((resolve, reject) => {
        });
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
