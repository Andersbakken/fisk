import EventEmitter from "events";
import assert from "assert";
import child_process from "child_process";
import fs from "fs-extra";
import path from "path";
import type { ExitEvent, ExitEventFile } from "./ExitEvent";

export class Compile extends EventEmitter {
    proc: child_process.ChildProcessWithoutNullStreams;

    constructor(args: string[], argv0: string, dir: string, debug: boolean) {
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
        let sourceFile: string | undefined;

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
                case "-I":
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
                    if (/^-mlinker-version=/.exec(args[i]) || /^-stdlib=/.exec(args[i])) {
                        args.splice(i--, 1);
                        break;
                    }

                    if (args[i][0] !== "-") {
                        if (sourceFile) {
                            console.log("Multiple source files", sourceFile, args[i]);
                            throw new Error("More than one source file");
                        }
                        sourceFile = args[i];
                        args[i] = path.join(dir, "sourcefile");
                    }
                    break;
            }
        }
        if (!sourceFile) {
            throw new Error("No sourcefile");
        }

        if (!hasDashX) {
            switch (path.extname(sourceFile)) {
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
                    throw new Error(`Can't determine source language for file: ${sourceFile}`);
            }
            args.unshift("-x");
        }
        if (!isClang) {
            args.push("-fpreprocessed", "-fdirectives-only"); // this is not good for clang
        } else {
            args.push("-Wno-stdlibcxx-not-found");
        }

        if (!hasDashO) {
            const suffix = path.extname(sourceFile);
            outputFileName = output = sourceFile.substring(0, sourceFile.length - suffix.length) + ".o";
            args.push("-o", outputFileName);
        }

        // debug = true;
        if (debug) {
            console.log("Calling", argv0, compiler, args.map((x) => '"' + x + '"').join(" "));
        }
        if (!fs.existsSync("/usr/bin/as")) {
            this.emit("stderr", "as doesn't exist");
        }
        console.log(`Compiling source file: ${sourceFile}\n${[compiler, ...args].join(" ")}`);
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
            const addDir = (directory: string, prefix: string): void => {
                try {
                    fs.readdirSync(directory).forEach((file: string) => {
                        if (file === "sourcefile") {
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
                                } else if (path.extname(file) === ".gcno") {
                                    // console.log("mapping", output, prefix, file);
                                    files.push({
                                        path: output.substring(0, output.length - 1) + "gcno",
                                        mapped: path.join(prefix, file)
                                    });
                                } else if (path.extname(file) === ".gcda") {
                                    files.push({
                                        path: output.substring(0, output.length - 1) + "gcda",
                                        mapped: path.join(prefix, file)
                                    });
                                } else {
                                    files.push({ path: path.join(prefix, file) });
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
                    console.error("Got an error processing outputs for", sourceFile, err);
                    assert(sourceFile !== undefined, "Must have sourceFile");
                    const errorExitEvent: ExitEvent = {
                        exitCode: 110,
                        files: [],
                        error: (err as Error).toString(),
                        sourceFile
                    };

                    this.emit("exit", errorExitEvent);
                    4;
                }
            };
            if (exitCode === 0) {
                addDir(dir, dir);
            }
            if (exitCode === null) {
                exitCode = 111;
            }
            assert(sourceFile !== undefined, "Must have sourceFile4");
            const exitEvent: ExitEvent = { exitCode, files, sourceFile };
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
