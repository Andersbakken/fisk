const fs = require('fs');

class Database {
    constructor(path) {
        this.path = path;
        this.busy = false;
        this.queue = [];
    }

    get(record) {
        return new Promise((resolve, reject) => {
            // console.log("Reader promise", record, this.busy, this.queue);
            const perform = () => {
                // console.log("perform called for read");
                return this._read().then(records => {
                    this.finishedOperation();
                    resolve(records ? records[record] : undefined);
                }).catch(err => {
                    reject(err);
                    this.finishedOperation();
                });
            };
            if (this.busy) {
                this.queue.push(perform);
            } else {
                this.busy = true;
                perform();
            }
        });
    }

    set(...keyValuePairs) {
        return new Promise((resolve, reject) => {
            const perform = () => {
                return this._read().then(records => {
                    if (!records)
                        records = {};
                    for (let i=0; i<keyValuePairs.length; i+=2)
                        records[keyValuePairs[i]] = keyValuePairs[i + 1];

                    fs.writeFile(this.path + ".tmp", JSON.stringify(records) + "\n", err => {
                        if (err) {
                            reject(err);
                        } else {
                            fs.rename(this.path + ".tmp", this.path, (err) => {
                                if (err) {
                                    reject(new Error(`Failed to rename ${this.path}.tmp to ${this.path} ${err}`));
                                } else {
                                    resolve();
                                }
                            });
                        }
                        this.finishedOperation();
                    });
                }).catch(err => {
                    reject(err);
                    this.finishedOperation();
                });
            };

            if (this.busy) {
                this.queue.push(perform);
            } else {
                this.busy = true;
                perform();
            }
        });
    }

    _read() {
        return new Promise((resolve, reject) => {
            fs.readFile(this.path, (err, data) => {
                // console.log("got read", err, data);
                if (err) {
                    if (err.code == "ENOENT") {
                        resolve({});
                    } else {
                        reject(err);
                    }
                } else {
                    if (!data) {
                        resolve({});
                    } else {
                        try {
                            resolve(JSON.parse(data));
                        } catch (err) {
                            fs.renameSync(this.path, this.path + ".error");
                            reject(new Error(`Failed to parse JSON from file: ${this.path} ${err}`));
                        }
                    }
                }
            });
        });
    }

    finishedOperation() {
        // console.log("finishedOperation", this.queue.length);
        if (this.queue.length) {
            const func = this.queue.splice(0, 1)[0];
            func();
        } else {
            this.busy = false;
        }
    }
}

const db = new Database("fisk.2");
// db.get("ball").
//     then(result => {
//         console.log("read ball", result);
//         if (!result)
//             result = [];
//         result.push(result.length);
//         return db.set("ball", result).then(val => {
//             console.log("set 1", val);
//         }).catch(err => {
//             console.log("set 1 err", err);
//         });

//         return db.set("ball2", result).then(val => {
//             console.log("set 2", val);
//         }).catch(err => {
//             console.log("set 2 err", err);
//         });

//         return db.set("ball3", result).then(val => {
//             console.log("set 3", val);
//         }).catch(err => {
//             console.log("set 3 err", err);
//         });
//     }).then(val => {

//     }).catch(err => {

//     });

// db.set("a", 1).then(a => console.log("got a", a)).catch(err => console.error("a error", err));
// db.set("a", 2).then(a => console.log("got b", a)).catch(err => console.error("b error", err));
// db.set("a", 3).then(a => console.log("got c", a)).catch(err => console.error("c error", err));
// db.get("a").then(a => console.log("read a", a)).catch(err => {
//     console.error("got err", err);
// });

module.exports = Database;
