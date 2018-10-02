const path = require('path');
const posix = require('posix');
const Compile = require('./compile');

const argv = require('minimist')(process.argv.slice(2));

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
process.send({type: "ready"});

let compiles = {};
let destroying = false;

process.on('message', (msg) => {
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
            let compile = new Compile(msg.commandLine, msg.argv0, msg.dir);
            // console.log("running thing", msg.commandLine);
            compile.on('stdout', data => process.send({ type: 'compileStdOut', id: msg.id, data: data }));
            compile.on('stderr', data => process.send({ type: 'compileStdErr', id: msg.id, data: data }));
            compile.on('exit', event => {
                delete compiles[msg.id];
                process.send({type: 'compileFinished', success: true, id: msg.id, files: event.files, exitCode: event.exitCode, sourceFile: event.sourceFile });
                if (destroying && !compiles.length)
                    process.exit();
            });
            compiles[msg.id] = compile;
        } catch (err) {
            delete compiles[msg.id];
            process.send({type: 'compileFinished', success: false, id: msg.id, files: [], exitCode: -1 });
        }
        break;
    }
});
