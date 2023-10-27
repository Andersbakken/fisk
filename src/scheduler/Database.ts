import fs from "fs";

type Operation = () => void;

export class Database {
    private busy: boolean;
    private queue: Operation[];

    static instance: Database = new Database("fisk.2");

    constructor(private readonly path: string) {
        this.busy = false;
        this.queue = [];
    }

    get(record: string): Promise<Record<string, unknown> | undefined> {
        return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
            // console.log("Reader promise", record, this.busy, this.queue);
            const perform = (): Promise<void> => {
                // console.log("perform called for read");
                return this._read()
                    .then((records?: Record<string, Record<string, unknown>>) => {
                        this.finishedOperation();
                        resolve(records ? records[record] : undefined);
                    })
                    .catch((err: unknown) => {
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

    set(key: string, value: unknown): Promise<void> {
        return new Promise((resolve, reject) => {
            const perform = (): Promise<void> => {
                return this._read()
                    .then((records: Record<string, unknown> | undefined) => {
                        if (!records) {
                            records = {};
                        }
                        records[key] = value;

                        fs.writeFile(this.path + ".tmp", JSON.stringify(records) + "\n", () => {
                            fs.rename(this.path + ".tmp", this.path, () => {
                                resolve();
                            });
                            this.finishedOperation();
                        });
                    })
                    .catch((err) => {
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

    _read(): Promise<Record<string, Record<string, unknown>>> {
        return new Promise<Record<string, Record<string, unknown>>>((resolve, reject) => {
            fs.readFile(this.path, "utf8", (err: NodeJS.ErrnoException | null, data: string) => {
                // console.log("got read", err, data);
                if (err) {
                    if (err.code === "ENOENT") {
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
                        } catch (error: unknown) {
                            fs.renameSync(this.path, this.path + ".error");
                            reject(
                                new Error(`Failed to parse JSON from file: ${this.path} ${(error as Error).message}`)
                            );
                        }
                    }
                }
            });
        });
    }

    finishedOperation(): void {
        // console.log("finishedOperation", this.queue.length);
        if (this.queue.length) {
            const func = this.queue.splice(0, 1)[0];
            func();
        } else {
            this.busy = false;
        }
    }
}

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
