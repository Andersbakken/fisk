import { Common } from "../common";
import { OptionsFunction } from "@jhanssen/options";
import express from "express";
import fs from "fs";
import path from "path";

type FileAndStat = { filePath: string; file: string; stat?: fs.Stats };
// const usage = "klang.js [--port|-p <port>] [--dir|-d <dir>] [--help|-h] [--verbose|-v] [--max-entries|-m <count]";

export class Klung {
    private filesArray: string[];
    private filesSet: Set<string>;
    private watchSuspended: boolean;
    private maxEntries: number;
    private dir: string;
    private cleaning: boolean;

    constructor(option: OptionsFunction, common: Common) {
        this.filesArray = [];
        this.filesSet = new Set();
        this.cleaning = false;
        this.watchSuspended = false;
        this.dir = String(option("clang-check-dir", path.join(common.cacheDir(), "clang-check")));
        this.maxEntries = option.int("clang-check-cache-size") || 50000;

        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch (err) {
            if (err.code !== "EEXIST") {
                console.error("Can't create directory", this.dir, err);
                process.exit(1);
            }
        }

        this.clean().then(() => {
            setInterval(this.clean.bind(this), 60 * 1000 * 1000);
            fs.watch(this.dir, (event: unknown) => {
                console.log("Got fs watch event", event, this.watchSuspended);
                if (this.watchSuspended || this.cleaning) {
                    return;
                }
                this.cleaning = true;
                setTimeout(() => {
                    this.clean().then(() => {
                        this.cleaning = false;
                    });
                }, 1000);
            });
        });
    }

    clear(_: express.Request, res: express.Response): void {
        this.filesArray.forEach((x: string) => fs.unlinkSync(path.join(this.dir, x)));
        console.log("Cleared", this.filesArray.length, "entries");
        this.filesArray = [];
        this.filesSet = new Set();
        res.send("OK");
    }

    list(_: express.Request, res: express.Response): void {
        res.send(this.filesArray.join("\n") + "\n");
    }

    query(req: express.Request, res: express.Response): void {
        if (!req.body || typeof req.body !== "string") {
            res.sendStatus(404);
            return;
        }

        const files = (req.body.includes(",") ? req.body.split(",") : req.body.split("\n")).filter((x: string) => x);

        const old = this.watchSuspended;
        this.watchSuspended = true;

        res.end(
            files
                .map((x: string) => {
                    if (this.filesSet.has(x)) {
                        this.touch(x);
                        return 1;
                    }
                    return 0;
                })
                .join("") + "\n"
        );
        this.watchSuspended = old;
    }

    commit(req: express.Request, res: express.Response): void {
        if (!req.body || typeof req.body !== "string") {
            res.sendStatus(404);
            return;
        }

        const files = (req.body.includes(",") ? req.body.split(",") : req.body.split("\n")).filter((x: string) => x);

        const old = this.watchSuspended;
        this.watchSuspended = true;
        files.forEach((file: string) => {
            if (!this.filesSet.has(file)) {
                this.filesSet.add(file);
                this.filesArray.push(file);
            }
            this.touch(file);
        });
        res.end();
        this.watchSuspended = old;
    }

    private clean(): Promise<void> {
        return new Promise((resolve) => {
            fs.readdir(this.dir, (err, f: string[]) => {
                if (err) {
                    console.error("Got an error cleaning files", err); // quit?
                    return;
                }
                this.filesArray = f;
                this.filesSet = new Set(f);
                // console.log("files", f.length, "maxEntries", maxEntries);
                if (f.length <= this.maxEntries) {
                    resolve();
                    return;
                }

                const filesAndStat: FileAndStat[] = f
                    .map((file: string) => {
                        try {
                            const filePath = path.join(this.dir, file);
                            const stat = fs.statSync(filePath);
                            return { filePath, stat, file };
                        } catch (err) {
                            console.error("Couldn't stat file", path.join(this.dir, file));
                            return { file: "", filePath: "" };
                        }
                    })
                    .filter((x: FileAndStat) => x.file)
                    .sort((l: FileAndStat, r: FileAndStat) => {
                        if (!l.stat || !r.stat) {
                            throw new Error(`Hm ${JSON.stringify(l)} ${JSON.stringify(r)}`);
                        }
                        return l.stat.mtimeMs - r.stat.mtimeMs;
                    });

                for (let idx = 0; idx < filesAndStat.length - this.maxEntries; ++idx) {
                    console.log("removing file", filesAndStat[idx].filePath);
                    fs.unlinkSync(filesAndStat[idx].filePath);
                    this.filesSet.delete(filesAndStat[idx].file);
                }
                this.filesArray.splice(0, filesAndStat.length - this.maxEntries);
                resolve();
            });
        });
    }

    private touch(file: string): void {
        fs.closeSync(fs.openSync(path.join(this.dir, file), "a"));
    }
}
