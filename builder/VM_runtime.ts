import { Compile } from "./compile";
import fs from "fs";
import minimist from "minimist";
import os from "os";
import path from "path";
import process from "process";

const argv: minimist.ParsedArgs = minimist(process.argv.slice(2));

function send(message: string) {
    try {
        if (process.send) {
            process.send(message);
        } else {
            throw new Error("No send");
        }
    } catch (err) {
        console.error(`Couldn't send message ${message.type}. Going down`);
        process.exit();
    }
}

process.on('unhandledRejection', (reason, p) => {
    send({type: "error", message: `Unhandled rejection at: Promise ${p} reason: ${reason.stack}`});
    console.error('Unhandled rejection at: Promise', p, 'reason:', reason.stack);
});

process.on('uncaughtException', err => {
    send({type: "error", message: `Uncaught exception ${err.stack} ${err.toString()}`});
    console.error("Uncaught exception", err);
});

let pwd;
if (argv.user) {
    try {
        pwd = posix.getpwnam(argv.user);
    } catch(err) {
        console.error("Couldn't find user", argv.user);
        throw err;
    }

    try {
        process.initgroups(argv.user, pwd.gid);
    } catch(err) {
        throw new Error('Changing groups failed: ' + err.message);
    }
}

try {
    console.log("Chrooting to", argv.root);
    posix.chroot(argv.root);
} catch (err) {
    console.error('Changing root or user failed', err);
    process.exit(1);
}

if (pwd) {
    process.setgid(pwd.gid);
    process.setuid(pwd.uid);
}

process.on("error", error => {
    console.error(`Got process error ${error} ${JSON.stringify(argv)}. Going down`);
    process.exit();
});

const libDirs: string[] = [];
const mac = os.type() === "Darwin";

function isLibrary(file: string) {
    if (file === "ld.so.conf" || file === "ld.so.cache") {
return false;
}
    const suffix = path.extname(file);
    if (mac) {
return suffix === ".dylib";
}

    // console.log("got file", suffix, file);
    if (suffix === ".so") {
        return true;
    }
    return file.indexOf(".so.") !== -1;
}

function findLibraries(dir) {
    const files = fs.readdirSync(dir);
    // console.log("findLibraries", dir, files.length);
    let found = false;
    files.forEach(file => {
        let stat;
        try {
            stat = fs.statSync(path.join(dir, file));
        } catch (err) {
            console.error("Got error", err);
            return;
        }


        if (stat.isDirectory()) {
            findLibraries(path.join(dir, file));
        } else if (!found && stat.isFile() && isLibrary(file)) {
            found = true;
            libDirs.push(dir);
        }
    });
}

findLibraries("/");
if (argv.debug) {
console.log("Got lib directories", argv.root, libDirs);
}
if (libDirs.length) {
    process.env[mac ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH"] = libDirs.join(":");
}
setTimeout(() => { // hack
    try {
        send({type: "ready"});
    } catch (err) {
        console.error("Couldn't send ready. Going down");
        process.exit();
    }
}, 1000);

const compiles = {};
let destroying = false;

process.on('message', msg => {
    switch (msg.type) {
    case 'destroy':
        if (!compiles.length) {
            process.exit();
        } else {
            destroying = true;
        }
        break;
    case 'setDebug':
        if (msg.debug) {
            argv.debug = true;
        } else {
            delete argv.debug;
        }
        console.log("set debug to", msg.debug, "for", argv.root);
        break;
    case 'cancel': {
        const c = compiles[msg.id];
        if (c) {
c.kill();
}
        break;
    }
    case 'compile':
        try {
            // console.log("compiling for );
            if (argv.debug) {
                console.log("Creating new compile", msg.commandLine, msg.argv0, msg.dir);
            }
            const compile = new Compile(msg.commandLine, msg.argv0, msg.dir, argv.debug);
            // console.log("running thing", msg.commandLine);
            compile.on('stdout', data => send({ type: 'compileStdOut', id: msg.id, data: data }));
            compile.on('stderr', data => send({ type: 'compileStdErr', id: msg.id, data: data }));
            compile.on('exit', event => {
                delete compiles[msg.id];
                if ("error" in event) {
                    send({type: 'compileFinished', success: false, error: event.error, id: msg.id, files: event.files, exitCode: event.exitCode, sourceFile: event.sourceFile });
                } else {
                    send({type: 'compileFinished', success: true, id: msg.id, files: event.files, exitCode: event.exitCode, sourceFile: event.sourceFile });
                }
                if (destroying && !compiles.length) {
process.exit();
}
            });
            compiles[msg.id] = compile;
        } catch (err) {
            delete compiles[msg.id];
            send({type: 'compileFinished', success: false, id: msg.id, files: [], exitCode: -1, error: err.toString() });
        }
        break;
    }
});
