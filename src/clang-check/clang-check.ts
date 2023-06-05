#!/usr/bin/env node

import { exec } from "./exec";
import { options, usage } from "./options";
import { parallelize } from "./parallelize";
import { post } from "./post";
import { sha1 } from "./sha1";
import fs from "fs";
import os from "os";
import path from "path";

const opts = options();

interface CompilationDatabaseItem {
    directory: string;
    command: string;
    file: string;
}

type CompilationDatabase = CompilationDatabaseItem[];

let compilationDatabase: CompilationDatabase;
try {
    compilationDatabase = JSON.parse(fs.readFileSync(opts.compileCommands, "utf8"));
    if (!Array.isArray(compilationDatabase)) {
        throw new Error(`${opts.compileCommands} doesn't contain the expected json`);
    }
} catch (err: unknown) {
    console.error(usage());
    console.error("Failed to load compilationDatabase", opts.compileCommands, (err as Error).message);
    process.exit(1);
}

let count = 0;
compilationDatabase = compilationDatabase.filter((item) => {
    opts.superVerbose(item);
    if (count === opts.maxCount) {
        // superVerbose("--max-count reached", maxCount);
        return false;
    }
    if (item.file.endsWith(".S")) {
        opts.verbose("excluded because it's assembly", item.file);
        return false;
    }
    if (opts.excludes.some((x) => x(item.file))) {
        opts.verbose("excluded because of excludes[]", item.file);
        return false;
    }
    if (opts.includes.length && !opts.includes.some((x) => x(item.file))) {
        opts.verbose("excluded because of includes[] not matching", item.file);
        return false;
    }
    const commands = item.command.split(" ").filter((arg) => {
        if (opts.removeArgs.some((x) => x(arg))) {
            opts.superVerbose("Filtered out arg", arg, "for", item.file);
            return false;
        }
        return true;
    });
    ++count;
    commands.push(...opts.extraArgs);
    item.command = commands.join(" ");
    if (opts.excludes.length || opts.includes.length) {
        opts.verbose("Included", item.file);
    }

    return true;
});

const sha1s = new Map<string, boolean>();

parallelize<string>(
    opts.maxParallelSha1Jobs,
    compilationDatabase.map((item) => sha1.bind(undefined, item.command))
).then((results: string[]) => {
    return post("/query", results.join("\n"))
        .then((result) => {
            results.forEach((res: string, idx: number) => {
                sha1s.set(res, result[idx] === "0");
            });
            return compilationDatabase.filter((x: CompilationDatabaseItem, idx: number) => result[idx] === "0");
        })
        .then((database: CompilationDatabase) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klung"));
            fs.writeFileSync(path.join(dir, "compile_commands.json"), JSON.stringify(database, undefined, 4));
            return dir;
        })
        .then((dir: string) =>
            exec(
                `${opts.analyzeBuild} --cdb ${dir}/compile_commands.json --output ${opts.output} --html-title ${opts.title} --enable-checker=optin.cplusplus.* --enable-checker=optin.portability.*`
            )
        )
        .then((result: { stdout: string; stderr: string }) => {
            opts.verbose(result);
            const match = /'scan-view ([^']+)'/.exec(result.stdout);
            if (!match) {
                throw new Error("Can't parse output " + JSON.stringify(result, undefined, 4));
            } else {
                return path.join(match[1], "failures");
            }
        })
        .then((dir: string) => {
            opts.verbose("Got dir", dir);
            try {
                fs.statSync(dir);
                return fs.promises.readdir(dir);
            } catch (err) {
                opts.verbose("No failures", err);
                return undefined;
            }
        })
        .then((files?: string[]) => {
            if (files) {
                files = files.filter((x: string) => x.endsWith(".info.txt"));
                // files.forEach((x) => {
                //     sha1s;
                // });
            }
            opts.verbose(files);
        })
        .catch((err: unknown) => {
            console.error("Something failed", err);
        });
});

// console.log(JSON.stringify(compilationDatabase, undefined, 4));
