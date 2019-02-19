#!/usr/bin/env node

const option = require('@jhanssen/options')('fisk/daemon', require('minimist')(process.argv.slice(2)));
const ws = require('ws');
const os = require('os');
const assert = require('assert');
const common = require('../common')(option);
const Server = require('./server');
const Slots = require('./slots');

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    if (client)
        client.send("log", { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason.stack}` });

});

process.on('uncaughtException', err => {
    console.error("Uncaught exception", err);
    if (client)
        client.send("log", { message: `Uncaught exception ${err.toString()} ${err.stack}` });
});

const server = new Server(option, common);
server.listen().then(() => {
    console.log("listening");
});

// server.on("message

server.on("error", (err) => {
    console.error("server error", err);
});

const cppSlots = new Slots(option.int("cpp-slots", Math.max(os.cpus().length * 2, 1)), "cpp");
const compileSlots = new Slots(option.int("slots", Math.max(os.cpus().length, 1)), "compile");

server.on('compile', compile => {
    let hasCppSlot = false;
    compile.on('acquireCppSlot', () => {
        assert(!hasCppSlot);
        hasCppSlot = true;
        cppSlots.acquire(compile.id, () => {
            compile.send({ type: "cppSlotAcquired" });
        });
    });

    compile.on('releaseCppSlot', () => {
        assert(hasCppSlot);
        if (hasCppSlot) {
            hasCppSlot = false;
            cppSlots.release(compile.id);
        }
    });

    let hasCompileSlot = false;
    compile.on('acquireCompileSlot', () => {
        assert(!hasCompileSlot);
        hasCompileSlot = true;
        compileSlots.acquire(compile.id, () => {
            compile.send({ type: "compileSlotAcquired" });
        });
    });

    compile.on('releaseCompileSlot', () => {
        assert(hasCompileSlot);
        if (hasCompileSlot) {
            hasCompileSlot = false;
            compileSlots.release(compile.id);
        }
    });

    compile.on('end', () => {
        if (hasCppSlot)
            cppSlots.release(compile.id);
        if (hasCompileSlot)
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
client.on("quit", message => {
    process.exit(message.code);
});

client.on("connect", () => {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
});

client.on("error", err => {
    console.error("client error", err);
});

client.on("close", () => {
    console.log("client closed");
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log("Reconnecting...");
            client.connect();
        }, 1000);
    }
});
*/
