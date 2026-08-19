import EventEmitter from "events";
import assert from "assert";
import child_process from "child_process";
import fs from "fs-extra";
import path from "path";
import type { ExitEvent, ExitEventFile } from "./ExitEvent";

// The client's real paths, which we bake into the object rather than emitting
// our own /compiles paths for the client to rewrite. That is the only approach
// that works for LTO, where the output is bitcode no ELF patcher can touch.
// Absent for a client too old to send them, in which case nothing is baked.
export interface ClientPaths {
    clientSourcePath?: string;
    clientCwd?: string;
}

// Flags asking the compiler to record its own argv, mapped to the negation the
// same compiler spells it with. -g* forms land in DW_AT_producer, -f* forms in a
// .GCC.command.line section; clang uses the command-line names and also accepts
// the gcc-switches ones as aliases.
const RECORD_FLAG_NEGATIONS: Record<string, string | undefined> = {
    "-grecord-command-line": "-gno-record-command-line",
    "-frecord-command-line": "-fno-record-command-line",
    "-grecord-gcc-switches": "-gno-record-gcc-switches",
    "-frecord-gcc-switches": "-fno-record-gcc-switches"
};

export class Compile extends EventEmitter {
    proc: child_process.ChildProcessWithoutNullStreams;

    constructor(
        args: string[],
        argv0: string,
        dir: string,
        debug: boolean,
        sourceFileName?: string,
        { clientSourcePath, clientCwd }: ClientPaths = {}
    ) {
        super();

        if (!args || !args.length || !dir || !argv0) {
            console.error(argv0, args, dir);
            throw new Error("Bad args");
        }
        const compiler = args.shift();
        if (compiler === undefined) {
            console.error(argv0, args, dir);
            throw new Error("Bad args");
        }
        const isClang = compiler.indexOf("clang") !== -1;

        let output: string | undefined;
        let outputFileName: string | undefined;
        let hasDashO: boolean = false;
        let hasDashX: boolean = false;
        let sourcePath: string | undefined;

        for (let i = 0; i < args.length; ++i) {
            // console.log(i, args[i]);
            switch (args[i]) {
                case "-o": {
                    hasDashO = true;
                    output = args[++i];
                    outputFileName = path.basename(output);
                    args[i] = outputFileName;
                    break;
                }

                case "-MF": {
                    args.splice(i--, 2);
                    break;
                }

                case "-MMD":
                case "-MD":
                case "-MM":
                case "-M":
                    args.splice(i--, 1);
                    continue;

                case "-MT":
                    args.splice(i--, 2);
                    continue;

                case "-cxx-isystem":
                case "-isysroot":
                case "-isystem":
                case "-iquote":
                case "-I":
                case "-F":
                    args.splice(i--, 2);
                    break;

                case "-x":
                    hasDashX = true;
                    if (!isClang) {
                        switch (args[++i]) {
                            case "c":
                                args[i] = "cpp-output";
                                break;
                            case "c++":
                                args[i] = "c++-cpp-output";
                                break;
                            case "objective-c":
                                args[i] = "objective-c-output";
                                break;
                            case "objective-c++":
                                args[i] = "objective-c++-cpp-output";
                                break;
                            default:
                                break;
                        }
                    } else {
                        ++i;
                    }
                    break;

                case "--param":
                case "-G":
                case "-T":
                case "-V":
                case "-Xanalyzer":
                case "-Xassembler":
                case "-Xclang":
                case "-Xlinker":
                case "-Xpreprocessor":
                case "-arch":
                case "-b":
                case "-gcc-toolchain":
                case "-imacros":
                case "-imultilib":
                case "-include":
                case "-iprefix":
                case "-ivfsoverlay":
                case "-iwithprefix":
                case "-iwithprefixbefore":
                case "-target":
                case "-framework":
                    ++i;
                    break;

                default:
                    if (
                        args[i].startsWith("-mlinker-version=") ||
                        args[i].startsWith("-stdlib=") ||
                        args[i].startsWith("-I") ||
                        args[i].startsWith("-F") ||
                        args[i].startsWith("-isystem") ||
                        args[i].startsWith("-isysroot") ||
                        args[i].startsWith("-cxx-isystem") ||
                        args[i].startsWith("-iquote") ||
                        args[i].startsWith("--sysroot=") ||
                        args[i].startsWith("--gcc-toolchain=")
                    ) {
                        args.splice(i--, 1);
                        break;
                    }

                    if (args[i][0] !== "-") {
                        if (sourcePath) {
                            console.log("Multiple source files", sourcePath, args[i]);
                            throw new Error("More than one source file");
                        }
                        sourcePath = args[i];
                        if (!sourceFileName) {
                            sourceFileName = path.basename(sourcePath);
                        }
                        args[i] = path.join(dir, sourceFileName);
                    }
                    break;
            }
        }
        if (!sourcePath) {
            throw new Error("No sourcefile");
        }

        const sourceFileInDir = path.join(dir, sourceFileName || path.basename(sourcePath));

        // Bake the client's real paths into the object instead of emitting the
        // builder's /compiles path for the client to rewrite afterwards. The
        // client folds these paths into its object-cache key, so a cached object
        // is only ever handed to a client that wants exactly these values.
        //
        // This is the only approach that covers LTO: with -flto the output is
        // bitcode, which no ELF-level patcher can load. It also needs no help
        // for compressed debug sections or for gcc, both of which defeat a byte
        // scan over the finished object.
        if (clientSourcePath && clientCwd) {
            // -grecord-command-line (clang) / -frecord-gcc-switches (gcc) embed
            // our own argv verbatim into DW_AT_producer or .GCC.command.line,
            // which would leave the builder's /compiles path in there. The
            // recorded line is our rewritten argv rather than the client's
            // anyway, so it is misleading as well as leaky -- turn it off.
            //
            // Negate each flag in place rather than dropping it and appending one
            // fixed negation: whichever compiler accepted the positive spelling
            // necessarily accepts its own negation, whereas a fixed flag is a
            // guess about the compiler.
            for (let i = 0; i < args.length; ++i) {
                const negation = RECORD_FLAG_NEGATIONS[args[i]];
                if (negation) {
                    args[i] = negation;
                }
            }

            // -fdebug-prefix-map only, for both compilers. clang also has
            // -Xclang -main-file-name / -Xclang -fdebug-compilation-dir, which
            // set the two values outright with no rule-precedence subtlety, but
            // those are cc1 internals reached through -Xclang and carry no
            // cross-version compatibility guarantee. -fdebug-prefix-map is a
            // driver flag that predates every compiler fisk supports (gcc 4.3,
            // clang 3.8), so it cannot fail on an older toolchain.
            //
            // The directory rule comes first and the more specific source-file
            // rule last: both compilers let a later mapping win, and the
            // directory is a prefix of the file. On gcc the file rule is inert --
            // gcc takes DW_AT_name from the #line markers in the preprocessed
            // source, which already name the client's file -- but it is harmless
            // there and needed for clang.
            args.push(`-fdebug-prefix-map=${dir}=${clientCwd}`);
            args.push(`-fdebug-prefix-map=${sourceFileInDir}=${clientSourcePath}`);
        }

        if (!hasDashX) {
            switch (path.extname(sourcePath)) {
                case ".C":
                case ".cc":
                case ".cpp":
                case ".CPP":
                case ".c++":
                case ".cp":
                case ".cxx":
                    args.unshift(isClang ? "c++" : "c++-cpp-output");
                    break;

                case ".ii":
                    args.unshift("c++-cpp-output");
                    break;

                case ".hh":
                case ".hpp":
                case ".H":
                    args.unshift("c++-header");
                    break;

                case ".h":
                    args.unshift("c-header");
                    break;

                case ".c":
                    args.unshift(isClang ? "c" : "cpp-output");
                    break;

                case ".i":
                    args.unshift("cpp-output");
                    break;

                case ".m":
                case ".mi":
                    args.unshift(isClang ? "objective-c" : "objective-c-cpp-output");
                    break;

                case ".s":
                    args.unshift("assembler");
                    break;

                case ".sx":
                case ".S":
                    args.unshift("assembler-with-cpp");
                    break;

                case ".mm":
                case ".M":
                case ".mii":
                    args.unshift(isClang ? "objective-c++" : "objective-c++-cpp-output");
                    break;

                default:
                    throw new Error(`Can't determine source language for file: ${sourcePath}`);
            }
            args.unshift("-x");
        }
        if (!isClang) {
            args.push("-fpreprocessed", "-fdirectives-only"); // this is not good for clang
        } else {
            args.push("-Wno-stdlibcxx-not-found");
        }

        if (!hasDashO) {
            const suffix = path.extname(sourcePath);
            outputFileName = output = sourcePath.substring(0, sourcePath.length - suffix.length) + ".o";
            args.push("-o", outputFileName);
        }

        // debug = true;
        if (debug) {
            console.log("Calling", argv0, compiler, args.map((x) => '"' + x + '"').join(" "));
        }
        if (!fs.existsSync("/usr/bin/as")) {
            this.emit("stderr", "as doesn't exist");
        }
        console.log(
            `Compiling source file: ${sourcePath}\n${[compiler, ...args]
                .map((x) => {
                    if (x.startsWith("-fdebug-prefix-map=")) {
                        x = x.replace(/_+$/, "___");
                    }
                    return x;
                })
                .join(" ")}`
        );
        // const env = Object.assign({ TMPDIR: dir, TEMPDIR: dir, TEMP: dir }, process.env);
        const proc: child_process.ChildProcessWithoutNullStreams = child_process.spawn(compiler, args, {
            /*env: env, */ cwd: dir // , maxBuffer: 1024 * 1024 * 16
        });
        this.proc = proc;
        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");

        proc.stdout.on("data", (data) => {
            this.emit("stdout", data);
        });
        proc.stderr.on("data", (data) => {
            this.emit("stderr", data);
        });
        proc.on("error", (err) => {
            this.emit("error", err);
        });

        proc.on("exit", (exitCode) => {
            // try {
            const files: ExitEventFile[] = [];
            let addDirError: Error | undefined;
            const addDir = (directory: string, prefix: string): void => {
                try {
                    const sourceBaseName = sourceFileName || path.basename(sourcePath!);
                    fs.readdirSync(directory).forEach((file: string) => {
                        if (file === sourceBaseName) {
                            return;
                        }
                        try {
                            assert(output !== undefined, "Must have output");
                            const stat = fs.statSync(path.join(directory, file));
                            if (stat.isDirectory()) {
                                addDir(path.join(directory, file), prefix ? prefix + file + "/" : file + "/");
                            } else if (stat.isFile()) {
                                if (file === outputFileName) {
                                    files.push({ path: output, mapped: path.join(prefix, file) });
                                } else {
                                    const ext = path.extname(file);
                                    switch (ext) {
                                        case ".gcno":
                                        case ".gcda":
                                        case ".dwo":
                                            files.push({
                                                path: output.substring(0, output.length - 2) + ext,
                                                mapped: path.join(prefix, file)
                                            });
                                            break;

                                        default:
                                            files.push({ path: path.join(prefix, file) });
                                            break;
                                    }
                                }
                                if (debug) {
                                    console.log("Added file", file, files[files.length - 1]);
                                }
                            }
                        } catch (err) {
                            console.error("Got an error file", path.join(directory, file), err);
                        }
                    });
                } catch (err: unknown) {
                    console.error("Got an error processing outputs for", sourcePath, err);
                    addDirError = err as Error;
                }
            };
            if (exitCode === 0) {
                addDir(dir, dir);
            }
            assert(sourcePath !== undefined, "Must have sourcePath4");
            if (addDirError) {
                const errorExitEvent: ExitEvent = {
                    exitCode: 110,
                    files: [],
                    error: addDirError.toString(),
                    sourcePath
                };
                this.emit("exit", errorExitEvent);
                return;
            }
            if (exitCode === null) {
                exitCode = 111;
            }
            const exitEvent: ExitEvent = { exitCode, files, sourcePath };
            this.emit("exit", exitEvent);
        });
    }

    kill(): void {
        this.proc.kill();
    }
}

// let preproc = fs.readFileSync("/tmp/preproc");
// let f = new Compile([ "/usr/bin/c++", "-Iclient", "-I3rdparty/json11", "-I3rdparty/wslay/lib/includes", "-I3rdparty/wslay/lib", "-I3rdparty/LUrlParser", "-I3rdparty/tiny-process-library", "-std=c++14", "-Wformat", "-Wall", "-g", "-MD", "-MT", "client/CMakeFiles/fiskc.dir/Config.cpp.o", "-MF", "client/CMakeFiles/fiskc.dir/Config.cpp.o.d", "-o", "client/CMakeFiles/fiskc.dir/Config.cpp.o", "-c", "client/Config.cpp" ], preproc);
// f.on('stdout', (data) => {
//     console.log("Got out", data.length);
// });

// f.on('stderr', (data) => {
//     console.log("Got err", data.toString());
// });
// f.on('error', error => {
//     console.log("Got error", error);
// });

// f.on('exit', event => {
//     console.log("Got exit", event);
// });
module.exports = Compile;
