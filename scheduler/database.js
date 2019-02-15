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
                            fs.renameSync(this.path, this.path + ".error");
                            reject(new Error(`Failed to parse JSON from file: ${this.path} ${err}`));
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
    set(...keyValuePairs) {
        return this.read().then(records => {
            return new Promise((resolve, reject) => {
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
