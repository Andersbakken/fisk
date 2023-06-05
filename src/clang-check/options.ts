import { align } from "./align";
import { matchContains } from "./matchContains";
import { matchRegex } from "./matchRegex";
import fs from "fs";

export type LogFunction = (...args: unknown[]) => void;
export type MatchFunction = (str: string) => boolean;

export interface Options {
    verbose: LogFunction;
    superVerbose: LogFunction;
    compileCommands: string;
    analyzeBuild: string;
    output: string;
    title: string;
    fiskc: string;
    excludes: MatchFunction[];
    includes: MatchFunction[];
    extraArgs: string[];
    removeArgs: MatchFunction[];
    standardRemoveArgs: MatchFunction[];
    maxParallelSha1Jobs: number;
    maxCount: number;
    scheduler: string;
}

let verbose: undefined | LogFunction;
let superVerbose: undefined | LogFunction;
let compileCommands: string = "compile_commands.json";
let scheduler = "http://localhost:6677";
let analyzeBuild: string = "analyze-build";
let output: string = ".";
let title: string = "clang-analyzer";
let fiskc: string = "fiskc";
const excludes: MatchFunction[] = [];
const includes: MatchFunction[] = [];
const removeArgs: MatchFunction[] = [];
const extraArgs: string[] = [];
let standardRemoveArgs: MatchFunction[] = [];
let maxParallelSha1Jobs = os.cpus().length;
let maxCount = Number.MAX_SAFE_INTEGER;

standardRemoveArgs.push(
    matchRegex.bind(undefined, /-Wa,--[0-9][0-9]/),
    matchContains.bind(undefined, "-fno-var-tracking-assignments"),
    matchContains.bind(undefined, "-fno-delete-null-pointer-checks"),
    matchContains.bind(undefined, "ccache")
);

export function usage(): string {
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

let opts: Options | undefined;
export function options(): Options {
    if (!opts) {
        for (let idx = 2; idx < process.argv.length; ++idx) {
            const arg = process.argv[idx];
            switch (arg) {
                case "--help":
                case "-h":
                    console.log(usage());
                    process.exit(0);
                case "--version":
                    console.log(JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"))).version);
                    process.exit(0);
                case "--verbose":
                case "-v":
                    if (!verbose) {
                        verbose = console.log.bind(console);
                    } else {
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
                        if (fs.statSync(compileCommands).isDirectory()) {
                            compileCommands = path.join(compileCommands, "compile_commands.json");
                        }
                    } catch (err) {
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
        opts = {
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

    return opts;
}
