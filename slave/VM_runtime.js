const path = require('path');
const posix = require('posix');
const Compile = require('./compile');

const argv = require('minimist')(process.argv.slice(2));

function send(message) {
    try {
        process.send(message);
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
        throw new Error('changing groups failed: ' + err.message);
    }
}

try {
    console.log("chrooting to", argv.root);
    posix.chroot(argv.root);
} catch (err) {
    console.error('changing root or user failed', err);
    process.exit(1);
}

if (pwd) {
    process.setgid(pwd.gid);
    process.setuid(pwd.uid);
}

process.on("error", error => {
    console.error(`Got process error ${error}. Going down`);
    process.exit();
});

setTimeout(() => { // hack
    try {
        send({type: "ready"});
    } catch (err) {
        console.error("Couldn't send ready. Going down");
        process.exit();
    }
}, 1000);

let compiles = {};
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
    case 'cancel':
        let c = compiles[msg.id];
        if (c)
            c.kill();
        break;
    case 'compile':
        try {
            // console.log("compiling for );
            if (argv.debug) {
                console.log("Creating new compile", msg.commandLine, msg.argv0, msg.dir);
            }
            let compile = new Compile(msg.commandLine, msg.argv0, msg.dir, argv.debug);
            // console.log("running thing", msg.commandLine);
            compile.on('stdout', data => send({ type: 'compileStdOut', id: msg.id, data: data }));
            compile.on('stderr', data => send({ type: 'compileStdErr', id: msg.id, data: data }));
            compile.on('exit', event => {
                delete compiles[msg.id];
                send({type: 'compileFinished', success: true, id: msg.id, files: event.files, exitCode: event.exitCode, sourceFile: event.sourceFile });
                if (destroying && !compiles.length)
                    process.exit();
            });
            compiles[msg.id] = compile;
        } catch (err) {
            delete compiles[msg.id];
            send({type: 'compileFinished', success: false, id: msg.id, files: [], exitCode: -1, error: err.toString() });
        }
        break;
    }
});
