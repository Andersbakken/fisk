#!/usr/bin/env node
'use strict';

var child_process = require('child_process');
var util = require('util');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var child_process__default = /*#__PURE__*/_interopDefaultLegacy(child_process);
var util__default = /*#__PURE__*/_interopDefaultLegacy(util);
var fs__default = /*#__PURE__*/_interopDefaultLegacy(fs);
var os__default = /*#__PURE__*/_interopDefaultLegacy(os);
var path__default = /*#__PURE__*/_interopDefaultLegacy(path);
var http__default = /*#__PURE__*/_interopDefaultLegacy(http);

const exec = util__default["default"].promisify(child_process__default["default"].exec);

function align(commands) {
    const cols = [];
    commands.forEach((x) => {
        while (cols.length < x.length) {
            cols.push(0);
        }
        x.forEach((y, idx) => {
            cols[idx] = Math.max(cols[idx], y.length);
        });
    });
    return commands.map((x) => x.map((y, idx) => y.padEnd(cols[idx])).join(" "));
}

function matchContains(pattern, str) {
    if (str.includes(pattern)) {
        // console.log(str, "includes", pattern);
        return true;
    }
    // console.log(str, "does not include", pattern);
    return false;
}

function matchExact(match, str) {
    if (str === match) {
        // console.log(str, "===", match);
        return true;
    }
    // console.log(str, "!==", match);
    return false;
}

function matchRegex(regex, str) {
    if (regex.exec(str)) {
        // console.log(str, "matches", regex);
        return true;
    }
    // console.log(str, "does not match", regex);
    return false;
}

let verbose;
let superVerbose;
let compileCommands = "compile_commands.json";
let scheduler = "http://localhost:6677";
let analyzeBuild = "analyze-build";
let output = ".";
let title = "clang-analyzer";
let fiskc = "fiskc";
const excludes = [];
const includes = [];
const removeArgs = [];
const extraArgs = [];
let standardRemoveArgs = [];
let maxParallelSha1Jobs = os__default["default"].cpus().length;
let maxCount = Number.MAX_SAFE_INTEGER;
standardRemoveArgs.push(matchRegex.bind(undefined, /-Wa,--[0-9][0-9]/), matchContains.bind(undefined, "-fno-var-tracking-assignments"), matchContains.bind(undefined, "-fno-delete-null-pointer-checks"), matchContains.bind(undefined, "ccache"));
function usage() {
    return align([
        ["fisk-clang-check ..."],
        [" [--help|-h]", "", "Display this help"],
        [" [--verbose|-v]", "", "Be more verbose"],
        [" [--version]", "", "Print version"],
        [
            " [--compile-commands|-c <file>]",
            `(default ${compileCommands})`,
            `Path to compile_commands.json (or directory)`
        ],
        [" [--fiskc <file>]", `(default ${fiskc})`, "Path to fiskc"],
        [" [--analyze-build|-C <file>]", `(default ${analyzeBuild})`, "Path to analyze-build"],
        [" [--exclude|-e <pattern>]", "(default [])", "Exclude files matching this pattern"],
        [" [--exclude-regex|-r <regex>]", "(default [])", "Exclude files matching this regex"],
        [" [--include|-i <pattern>]", "(default [])", "Only include files that match this pattern"],
        [" [--include-regex|-I <regex>]", "(default [])", "Only include files that match this regex"],
        [" [--remove-arg|-R <pattern>]", "(default [])", "Remove compiler arguments matching this pattern"],
        [" [--remove-arg-regex|-x <regex>]", "(default [])", "Remove compiler arguments matching this regex"],
        [" [--extra-arg|-A <arg>]", "(default [])", "Add this extra arg to the compile command"],
        [" [--scheduler|-k <address>]", `(default ${scheduler})`, "Address of fisk scheduler"],
        [" [--output-dir|-o <dir>]", `(default ${output})`, "Directory for html output"],
        [" [--html-title|-t <title>]", `(default ${title})`, "Title for html page"],
        [
            " [--no-standard-remove-args]",
            "(default false)",
            `Don't remove standard args (${standardRemoveArgs.join(", ")})`
        ],
        [
            " [--max-parallel-sha1-jobs | -s <number>]",
            `(default ${maxParallelSha1Jobs})`,
            "Max concurrent fiskc processes"
        ],
        [
            " [--max-count|-n <number>]",
            `(default ${maxCount})`,
            "Limit to the first <number> of files in compile_commands.json"
        ]
    ]).join("\n");
}
let opts$1;
function options() {
    if (!opts$1) {
        for (let idx = 2; idx < process.argv.length; ++idx) {
            const arg = process.argv[idx];
            switch (arg) {
                case "--help":
                case "-h":
                    console.log(usage());
                    process.exit(0);
                case "--version":
                    console.log(JSON.parse(fs__default["default"].readFileSync(path__default["default"].join(__dirname, "package.json"), "utf8")).version);
                    process.exit(0);
                case "--verbose":
                case "-v":
                    if (!verbose) {
                        verbose = console.log.bind(console);
                    }
                    else {
                        superVerbose = console.log.bind(console);
                    }
                    break;
                case "--fiskc":
                    fiskc = process.argv[++idx];
                    break;
                case "--output-dir":
                case "-o":
                    output = process.argv[++idx];
                    break;
                case "--html-title":
                case "-t":
                    title = process.argv[++idx];
                    break;
                case "--compile-commands":
                case "-c":
                    compileCommands = process.argv[++idx];
                    try {
                        if (fs__default["default"].statSync(compileCommands).isDirectory()) {
                            compileCommands = path__default["default"].join(compileCommands, "compile_commands.json");
                        }
                    }
                    catch (err) {
                        console.log("Balls", err);
                    }
                    break;
                case "--exclude":
                case "-e":
                    excludes.push(matchContains.bind(undefined, process.argv[++idx]));
                    break;
                case "--exclude-regex":
                case "-r":
                    excludes.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
                    break;
                case "--include":
                case "-i":
                    includes.push(matchContains.bind(undefined, process.argv[++idx]));
                    break;
                case "--include-regex":
                case "-I":
                    includes.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
                    break;
                case "--extra-arg":
                case "-A":
                    extraArgs.push(...process.argv[++idx].split(" ").filter((x) => x));
                    break;
                case "--remove-arg":
                case "-R":
                    removeArgs.push(matchExact.bind(undefined, process.argv[++idx]));
                    break;
                case "--remove-arg--regex":
                case "-x":
                    removeArgs.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
                    break;
                case "--no-standard-remove-args":
                    standardRemoveArgs = [];
                    break;
                case "--scheduler":
                case "-k":
                    scheduler = process.argv[++idx];
                    if (!/(https?:\/\/[^:]*)(:[0-9]+)\/?/.exec(scheduler)) {
                        console.error('Invalid server address. Must be "http(s)://host(:port)"');
                        process.exit(1);
                    }
                    break;
                case "--analyze-build":
                case "-C":
                    analyzeBuild = process.argv[++idx];
                    break;
                case "--max-parallel-sha1-jobs":
                case "-s":
                    maxParallelSha1Jobs = parseInt(process.argv[++idx]);
                    if (maxParallelSha1Jobs < 0 || !maxParallelSha1Jobs) {
                        console.error("Invalid --max-parallel-sha1-jobs", process.argv[idx]);
                        process.exit(1);
                    }
                    break;
                case "--max-count":
                case "-n":
                    maxCount = parseInt(process.argv[++idx]);
                    if (maxCount < 0 || !maxCount) {
                        console.error("Invalid --max-count", process.argv[idx]);
                        process.exit(1);
                    }
                    break;
            }
        }
        if (!verbose) {
            verbose = () => {
                /* */
            };
        }
        if (!superVerbose) {
            superVerbose = () => {
                /* */
            };
        }
        removeArgs.push(...standardRemoveArgs);
        opts$1 = {
            analyzeBuild,
            compileCommands,
            excludes,
            extraArgs,
            fiskc,
            includes,
            maxCount,
            maxParallelSha1Jobs,
            output,
            removeArgs,
            scheduler,
            standardRemoveArgs,
            superVerbose,
            title,
            verbose
        };
    }
    return opts$1;
}

function parallelize(max, promiseCreators) {
    const opts = options();
    opts.verbose("parallelize called with", promiseCreators.length, "jobs");
    return new Promise((resolve, reject) => {
        let idx = 0;
        const results = [];
        let active = 0;
        let rejected = false;
        const fill = () => {
            opts.verbose(`Fill called with idx: ${idx}/${promiseCreators.length} active: ${active}`);
            while (active < max && idx < promiseCreators.length) {
                const promise = promiseCreators[idx]();
                const then = (idx, result) => {
                    if (rejected) {
                        return;
                    }
                    results[idx] = result;
                    --active;
                    fill();
                };
                ++active;
                promise.then(then.bind(undefined, idx), (err) => {
                    if (!rejected) {
                        rejected = true;
                        reject(err);
                    }
                });
                ++idx;
            }
            if (!active) {
                resolve(results);
            }
        };
        fill();
    });
}

function post(path, body) {
    return new Promise((resolve, reject) => {
        const match = /https?:\/\/([^:]*)(:[0-9]+)\/?/.exec(options().scheduler);
        if (!match) {
            reject(new Error("Failed to parse scheduler"));
            return;
        }
        const opts = {
            host: match[1] || "",
            port: match[2] ? match[2].substring(1) : 80,
            path,
            method: "POST"
        };
        const req = http__default["default"].request(opts, (res) => {
            res.setEncoding("utf8");
            let response = "";
            res.on("data", (chunk) => {
                // console.log('Response: ' + chunk);
                response += chunk;
            });
            res.on("end", () => {
                resolve(response.trim());
            });
        });
        req.write(body);
        req.end();
    });
}

function sha1(command) {
    return exec(`${options().fiskc} --fisk-dump-sha1 --fisk-compiler=${command}`).then((result) => {
        const stdout = result.stdout;
        if (stdout.endsWith("\n")) {
            return stdout.substring(0, stdout.length - 1);
        }
        return stdout;
    });
}

const opts = options();
let compilationDatabase;
try {
    compilationDatabase = JSON.parse(fs__default["default"].readFileSync(opts.compileCommands, "utf8"));
    if (!Array.isArray(compilationDatabase)) {
        throw new Error(`${opts.compileCommands} doesn't contain the expected json`);
    }
}
catch (err) {
    console.error(usage());
    console.error("Failed to load compilationDatabase", opts.compileCommands, err.message);
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
const sha1s = new Map();
parallelize(opts.maxParallelSha1Jobs, compilationDatabase.map((item) => sha1.bind(undefined, item.command))).then((results) => {
    return post("/query", results.join("\n"))
        .then((result) => {
        results.forEach((res, idx) => {
            sha1s.set(res, result[idx] === "0");
        });
        return compilationDatabase.filter((x, idx) => result[idx] === "0");
    })
        .then((database) => {
        const dir = fs__default["default"].mkdtempSync(path__default["default"].join(os__default["default"].tmpdir(), "klung"));
        fs__default["default"].writeFileSync(path__default["default"].join(dir, "compile_commands.json"), JSON.stringify(database, undefined, 4));
        return dir;
    })
        .then((dir) => exec(`${opts.analyzeBuild} --cdb ${dir}/compile_commands.json --output ${opts.output} --html-title ${opts.title} --enable-checker=optin.cplusplus.* --enable-checker=optin.portability.*`))
        .then((result) => {
        opts.verbose(result);
        const match = /'scan-view ([^']+)'/.exec(result.stdout);
        if (!match) {
            throw new Error("Can't parse output " + JSON.stringify(result, undefined, 4));
        }
        else {
            return path__default["default"].join(match[1], "failures");
        }
    })
        .then((dir) => {
        opts.verbose("Got dir", dir);
        try {
            fs__default["default"].statSync(dir);
            return fs__default["default"].promises.readdir(dir);
        }
        catch (err) {
            opts.verbose("No failures", err);
            return undefined;
        }
    })
        .then((files) => {
        if (files) {
            files = files.filter((x) => x.endsWith(".info.txt"));
            // files.forEach((x) => {
            //     sha1s;
            // });
        }
        opts.verbose(files);
    })
        .catch((err) => {
        console.error("Something failed", err);
    });
});
// console.log(JSON.stringify(compilationDatabase, undefined, 4));
//# sourceMappingURL=fisk-clang-check.js.map
