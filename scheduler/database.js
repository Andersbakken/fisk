const fs = require('fs');

class Database {
    constructor(path) {
        this.path = path;
    }

    read() {
        return new Promise((resolve, reject) => {
            fs.readFile(this.path, (err, data) => {
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
                            reject(`Failed to parse JSON from file: ${this.path} ${err}`);
                        }
                    }
                }
            });
        });
    }
    get(record) {
        return this.read().then(records => {
            return records ? records[record] : undefined;
        });
    }
    set(record, value) {
        return this.read().then(records => {
            return new Promise((resolve, reject) => {
                if (!records)
                    records = {};
                records[record] = value;

                fs.writeFile(this.path + ".tmp", JSON.stringify(records), err => {
                    if (err) {
                        reject(err);
                    } else {
                        fs.rename(this.path + ".tmp", this.path, (err) => {
                            if (err) {
                                reject(`Failed to rename ${this.path}.tmp to ${this.path} ${err}`);
                            } else {
                                resolve();
                            }
                        });
                    }
                });
            });
        });
    }
}

// const db = new Database("fisk.2");
// db.get("ball").
//     then(result => {
//         console.log("read ball", result);
//         if (!result)
//             result = [];
//         result.push(result.length);
//         return db.set("ball", result);
//     }).
//     then(console.log.bind(console)).
//     catch(console.error.bind.console);

module.exports = Database;
