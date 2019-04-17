#!/usr/bin/env node

const option = require('@jhanssen/options')({ prefix: 'fisk/daemon',
                                              applicationPath: false,
                                              additionalFiles: [ "fisk/daemon.conf.override" ] });
const ws = require('ws');
const os = require('os');
const assert = require('assert');
const common = require('../common')(option);
const Server = require('./server');
const Slots = require('./slots');
const Constants = require('./constants');

const debug = option('debug');

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    process.exit();
    // if (client)
    //     client.send('log', { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason.stack}` });

});

process.on('uncaughtException', err => {
    console.error('Uncaught exception', err);
    process.exit();
    // if (client)
    //     client.send('log', { message: `Uncaught exception ${err.toString()} ${err.stack}` });
});

const server = new Server(option, common);
server.listen().then(() => {
    console.log('listening on', server.file);
});

// server.on("message

server.on('error', (err) => {
    console.error('server error', err);
});

const cppSlots = new Slots(option.int('cpp-slots', Math.max(os.cpus().length * 2, 1)), 'cpp', debug);
const compileSlots = new Slots(option.int('slots', Math.max(os.cpus().length, 1)), 'compile', debug);

server.on('compile', compile => {
    compile.on("dumpSlots", () => {
        let ret = { cpp: cppSlots.dump(), compile: compileSlots.dump() };
        if (debug)
            console.log("sending dump", ret);

        compile.send(ret);
    });
    let requestedCppSlot = false;
    compile.on('acquireCppSlot', () => {
        if (debug)
            console.log('acquireCppSlot');

        assert(!requestedCppSlot);
        requestedCppSlot = true;
        cppSlots.acquire(compile.id, {pid: compile.pid}, () => {
            // compile.send({ type: 'cppSlotAcquired' });
            compile.send(Constants.CppSlotAcquired);
        });
    });

    compile.on('error', err => {
        if (debug) {
            console.error('Got error from fiskc', err);
        }
    });

    compile.on('releaseCppSlot', () => {
        if (debug)
            console.log('releaseCppSlot');

        assert(requestedCppSlot);
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
    });

    let requestedCompileSlot = false;
    compile.on('acquireCompileSlot', () => {
        if (debug)
            console.log('acquireCompileSlot');

        assert(!requestedCompileSlot);
        requestedCompileSlot = true;
        compileSlots.acquire(compile.id, {pid: compile.pid}, () => {
            // compile.send({ type: 'compileSlotAcquired' });
            compile.send(Constants.CompileSlotAcquired);
        });
    });

    compile.on('releaseCompileSlot', () => {
        if (debug)
            console.log('releaseCompileSlot');

        assert(requestedCompileSlot);
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
    });

    compile.on('end', () => {
        if (debug)
            console.log("got end from", compile.id, compile.pid);
        if (requestedCppSlot)
            cppSlots.release(compile.id);
        if (requestedCompileSlot)
            compileSlots.release(compile.id);
    });
});

process.on('exit', () => {
    server.close();
});

process.on('SIGINT', sig => {
    server.close();
    process.exit();
});

/*
  const client = new Client(option, common.Version);

let connectInterval;
client.on('quit', message => {
    process.exit(message.code);
});

client.on('connect', () => {
    console.log('connected');
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
});

client.on('error', err => {
    console.error('client error', err);
});

client.on('close', () => {
    console.log('client closed');
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log('Reconnecting...');
            client.connect();
        }, 1000);
    }
});
*/
