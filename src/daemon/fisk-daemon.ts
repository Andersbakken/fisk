#!/usr/bin/env node

import { Constants } from "./Constants";
import { Server } from "./Server";
import { Slots } from "./Slots";
import { common as commonFunc } from "../common";
import assert from "assert";
import createOptions from "@jhanssen/options";
import os from "os";
import type { Options } from "@jhanssen/options";

const option: Options = createOptions({
    prefix: "fisk/daemon",
    noApplicationPath: true,
    additionalFiles: ["fisk/daemon.conf.override"]
});
const common = commonFunc(option);
const debug = option("debug") as boolean;

process.on("unhandledRejection", (reason: Error, p: Promise<unknown>) => {
    console.log("Unhandled Rejection at: Promise", p, "reason:", reason?.stack);
    process.exit();
    // if (client)
    //     client.send('log', { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason.stack}` });
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception", err);
    process.exit();
    // if (client)
    //     client.send('log', { message: `Uncaught exception ${err.toString()} ${err.stack}` });
});

const server = new Server(option, common);
server.listen().then(() => {
    console.log("listening on", server.file);
});

// server.on("message

server.on("error", (err) => {
    console.error("server error", err);
});

const cppSlots = new Slots(option.int("cpp-slots", Math.max(os.cpus().length * 2, 1)), "cpp", debug);
const compileSlots = new Slots(option.int("slots", Math.max(os.cpus().length, 1)), "compile", debug);

server.on("compile", (compile) => {
    compile.on("dumpSlots", () => {
        const ret = { cpp: cppSlots.dump(), compile: compileSlots.dump() };
        if (debug) {
            console.log("sending dump", ret);
        }

        compile.send(ret);
    });
    let requestedCppSlot = false;
    compile.on("acquireCppSlot", () => {
        if (debug) {
            console.log("acquireCppSlot");
        }

        assert(!requestedCppSlot);
        requestedCppSlot = true;
        cppSlots.acquire(compile.id, { pid: compile.pid }, () => {
            // compile.send({ type: 'cppSlotAcquired' });
            compile.send(Constants.CppSlotAcquired);
        });
    });

    compile.on("releaseCppSlot", () => {
        if (debug) {
            console.log("releaseCppSlot");
        }

        assert(requestedCppSlot);
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
    });

    let requestedCompileSlot = false;
    compile.on("acquireCompileSlot", () => {
        if (debug) {
            console.log("acquireCompileSlot");
        }

        assert(!requestedCompileSlot);
        requestedCompileSlot = true;
        compileSlots.acquire(compile.id, { pid: compile.pid }, () => {
            // compile.send({ type: 'compileSlotAcquired' });
            compile.send(Constants.CompileSlotAcquired);
        });
    });

    compile.on("releaseCompileSlot", () => {
        if (debug) {
            console.log("releaseCompileSlot");
        }

        assert(requestedCompileSlot);
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
    });

    compile.on("error", (err: Error) => {
        if (debug) {
            console.error("Got error from fiskc", compile.id, compile.pid, err);
        }
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
    });

    compile.on("end", () => {
        if (debug) {
            console.log("got end from", compile.id, compile.pid);
        }
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
    });
});

process.on("exit", () => {
    server.close();
});

process.on("SIGINT", () => {
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
