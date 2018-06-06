const child_process = require('child_process');
const mktemp = require('mktemp');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const magicalObjectName = 'fisk-slave-out';

class Compile extends EventEmitter {
    constructor(args, argv0, dir) {
        super();
        if (!args || !args.length || !dir || !argv0) {
            console.error(argv0, args, dir);
            throw new Error("Bad args");
        }
        let compiler = args.shift();

        let hasDashX = false;
        let sourceFile;
        let originalOutput;
        for (let i=0; i<args.length; ++i) {
            switch (args[i]) {
            case '-o':
                originalOutput = args[++i];
                args[i] = path.join(dir, magicalObjectName);
                break;
            case '-x':
                hasDashX = true;
                switch (args[++i]) {
                case 'c':
                    args[i] = 'cpp-output';
                    break;
                case 'c++':
                    args[i] = 'c++-cpp-output';
                    break;
                case 'objective-c':
                    args[i] = 'objective-c-output';
                    break;
                case 'objective-c++':
                    args[i] = 'objective-c++-cpp-output';
                    break;
                default:
                    break;
                }
                break;
            case '--param':
            case '-G':
            case '-I':
            case '-MF':
            case '-MQ':
            case '-MT':
            case '-T':
            case '-V':
            case '-Xanalyzer':
            case '-Xassembler':
            case '-Xclang':
            case '-Xlinker':
            case '-Xpreprocessor':
            case '-arch':
            case '-b':
            case '-gcc-toolchain':
            case '-imacros':
            case '-imultilib':
            case '-include':
            case '-iprefix':
            case '-isysroot':
            case '-isystem':
            case '-ivfsoverlay':
            case '-iwithprefix':
            case '-iwithprefixbefore':
            case '-target':
                ++i;
                break;
            default:
                if (args[i][0] != '-') {
                    if (sourceFile) {
                        throw new Error("More than one source file");
                    }
                    sourceFile = args[i];
                    args[i] = path.join(dir, 'sourcefile');
                }
                break;
            }
        }
        if (!sourceFile) {
            throw new Error("No sourcefile");
        }

        if (!originalOutput) {
            args.push('-o');
            args.push(path.join(dir, magicalObjectName));
            originalOutput = sourceFile.substr(0, sourceFile.length - path.extname(sourceFile).length + 1) + "o";
        }

        if (!hasDashX) {
            if (compiler.indexOf('g++') != -1 || compiler.indexOf('c++') != -1) {
                args.unshift('c++-cpp-output');
            } else {
                switch (path.extname(sourceFile)) {
                case '.C':
                case '.cc':
                case '.cpp':
                case '.CPP':
                case '.c++':
                case '.cp':
                case '.cxx':
                case '.ii':
                    args.unshift('c++-cpp-output');
                    break;
                case '.hh':
                case '.hpp':
                case '.H':
                    args.unshift('c++-header');
                    break;
                case '.h':
                    args.unshift('c-header');
                    break;
                case '.c':
                    args.unshift('cpp-output');
                    break;
                case '.m':
                case '.mi':
                    args.unshift('objective-c-cpp-output');
                    break;
                case '.mm':
                case '.M':
                case '.mii':
                    args.unshift('objective-c++-cpp-output');
                    break;
                default:
                    throw new Error(`Can't determine source language for file: ${sourceFile}`);
                }
            }
            args.unshift('-x');
        }
        if (compiler.indexOf('clang') == -1)
            args.push('-fpreprocessed'); // this is not good for clang
        console.log("CALLING " + argv0 + " " + compiler + " " + args.join(' '));
        let proc = child_process.spawn(compiler, args, { cwd: dir, argv0: argv0 });
        this.proc = proc;
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');

        proc.stdout.on('data', data => {
            this.emit('stdout', data);
        });
        proc.stderr.on('data', data => {
            this.emit('stderr', data);
        });
        proc.on('error', err => {
            this.emit('error', err);
        });

        proc.on('exit', (exitCode) => {
            // try {
            let files = [];
            function addDir(dir, prefix) {
                try {
                    fs.readdirSync(dir).forEach(file => {
                        if (file === 'sourcefile')
                            return;
                        try {
                            let stat = fs.statSync(path.join(dir, file));
                            if (stat.isDirectory()) {
                                addDir(path.join(dir, file), prefix ? prefix + file + '/' : file + '/');
                            } else if (stat.isFile()) {
                                if (file === magicalObjectName) {
                                    files.push({ path: originalOutput, mapped: path.join(prefix, file) });
                                } else {
                                    files.push({ path: path.join(prefix, file) });
                                }
                            }
                        } catch (err) {
                        }
                        // console.log("ADDED FILE", file, files[files.length - 1]);
                    });
                } catch (err) {
                    this.emit('exit', { exitCode: 101, files: [], error: err, sourceFile: sourceFile });
                    return;
                }
            }
            addDir(dir, dir);
            this.emit('exit', { exitCode: exitCode, files: files, sourceFile: sourceFile });
        });
    }
    kill() {
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
