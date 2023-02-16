import { Database } from "./Database";
import { Environment } from "./Environment";
import { File } from "./File";
import { LinkProperties } from "./LinkProperties";
import { Links } from "./Links";
import { untarFile } from "./untarFile";
import assert from "assert";
import fs from "fs-extra";
import path from "path";

export class Environments {
    private _data: Record<string, Environment>;
    private _links: Record<string, Links>;
    private _path?: string;
    private _db?: Database;

    public static instance: Environments = new Environments();

    constructor() {
        this._data = {};
        this._links = {};
    }

    load(db: Database, p: string): Promise<void> {
        this._db = db;
        return db.get("links").then((l: Record<string, unknown> | undefined) => {
            if (l) {
                const links = l as Record<string, Record<string, LinkProperties>>;
                for (const srcHash in links) {
                    const targets = links[srcHash];
                    const data = (this._links[srcHash] = new Links());
                    for (const target in targets) {
                        const obj = targets[target];
                        data.set(target, obj.arguments, obj.blacklist);
                    }
                }
            }
            return new Promise<void>((resolve, reject) => {
                fs.stat(p)
                    .then((st) => {
                        if (st.isDirectory()) {
                            // we're good
                            this._path = p;
                            fs.readdir(p).then((files) => {
                                const promises: Array<Promise<void>> = [];
                                files.forEach((e) => {
                                    if (e.length === 47 && e.indexOf(".tar.gz", 40) === 40) {
                                        const tarFile = path.join(p, e);
                                        const hash = e.substr(0, 40);
                                        promises.push(
                                            untarFile(tarFile, "etc/compiler_info")
                                                .then((data: string) => {
                                                    const idx = data.indexOf("\n");
                                                    const info = JSON.parse(data.substr(0, idx));
                                                    const env = new Environment(
                                                        tarFile,
                                                        hash,
                                                        info.system,
                                                        info.originalPath
                                                    );
                                                    this._data[hash] = env;
                                                })
                                                .catch((err: unknown) => {
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
                                //     this.link("28CD22DF1176120F63EC463E095F13D4330194D7", "177EF462A7AEC31C26502F5833A92B51C177C01B", [], []);
                                // }, 1000);
                            });
                        } else {
                            reject(`Can't use path ${p}`);
                        }
                    })
                    .catch((e) => {
                        if ("code" in e && e.code === "ENOENT") {
                            // make the directory
                            fs.mkdirp(p, (err) => {
                                if (err) {
                                    reject(`Can't make directory ${p}: ${e.message}`);
                                    return;
                                }
                                // we're good
                                this._path = p;
                                resolve();
                            });
                        } else {
                            reject(`Can't make directory ${p}: ${e.message}`);
                        }
                    });
            });
        });
    }

    prepare(environment: Environment): File | undefined {
        if (environment.hash in this._data) {
            return undefined;
        }
        assert(this._path);
        fs.mkdirpSync(this._path);
        return new File(path.join(this._path, `${environment.hash}.tar.gz`), environment.hash);
    }

    complete(file: File): Promise<void> {
        return new Promise<void>((resolve) => {
            untarFile(file.path, "etc/compiler_info").then((data) => {
                const env = new Environment(file.path, file.hash);
                const idx = data.indexOf("\n");
                const info = JSON.parse(data.substr(0, idx));
                env.system = info.system;
                env.originalPath = info.originalPath;
                env.info = data.substr(idx + 1);
                this._data[file.hash] = env;
                resolve();
            });
        });
    }

    hasEnvironment(hash: string): boolean {
        return hash in this._data;
    }

    compatibleEnvironments(srcHash: string): string[] {
        const compatible = [];
        if (srcHash in this._data) {
            compatible.push(srcHash);
        }
        // console.log("checking", srcHash, this._links);
        const data = this._links[srcHash];
        if (data) {
            return compatible.concat(data.targetHashes);
        }
        return compatible;
    }

    extraArgs(srcHash: string, targetHash: string): string[] {
        const data = this._links[srcHash];
        if (data) {
            return data.arguments(targetHash);
        }
        return [];
    }

    link(srcHash: string, targetHash: string, args: string[], blacklist: string[]): Promise<void> {
        let data = this._links[srcHash];
        if (!data) {
            data = this._links[srcHash] = new Links();
        }
        data.set(targetHash, args, blacklist);
        return this.syncLinks();
    }

    unlink(srcHash?: string, targetHash?: string): Promise<void> {
        if (!srcHash) {
            for (const src in this._links) {
                const targets = this._links[src];
                targets.unset(targetHash);
                if (!targets.size) {
                    delete this._links[src];
                }
            }
        } else if (!targetHash) {
            delete this._links[srcHash];
        } else {
            const targets = this._links[srcHash];
            targets.unset(targetHash);
            if (!targets.size) {
                delete this._links[srcHash];
            }
        }
        return this.syncLinks();
    }

    get environments(): Record<string, Environment> {
        return this._data;
    }

    get path(): string {
        return this._path || "";
    }

    environment(hash: string): Environment | undefined {
        if (!(hash in this._data)) {
            return undefined;
        }
        return this.environments._data[hash];
    }

    linksInfo(): Record<string, Record<string, LinkProperties>> {
        const obj: Record<string, Record<string, LinkProperties>> = {};
        for (const srcHash in this._links) {
            obj[srcHash] = this._links[srcHash].targets;
        }
        return obj;
    }

    syncLinks(): Promise<void> {
        if (!this._db) {
            throw new Error("No db set");
        }
        return this._db.set("links", this.linksInfo());
    }

    remove(hash: string): void {
        // ### this should be promisified
        try {
            fs.removeSync(this.environments._data[hash].path);
            delete this.environments._data[hash];
            this.unlink(hash);
            this.unlink(undefined, hash);
            this.syncLinks();
        } catch (err: unknown) {
            console.error("Failed to remove environment", this._data[hash].path, err);
        }
    }
}
