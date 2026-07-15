#!/usr/bin/env node

import { CompilerInfoCache } from "./CompilerInfoCache";
import { Constants } from "./Constants";
import { Server } from "./Server";
import { Slots } from "./Slots";
import { common as commonFunc } from "../common";
import assert from "assert";
import createOptions from "@jhanssen/options";
import os from "os";
import type { Compile } from "./Compile";
import type { CompilerInfo } from "./CompilerInfoCache";
import type { Options } from "@jhanssen/options";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Usage: fisk-daemon [options]

Options:
  --debug                Enable debug logging
  --socket=PATH          Unix socket path (default: ~/.cache/fisk/daemon/socket)
  --cpp-slots=N          Preprocess slot count (default: cpus * 2)
  --slots=N              Compile slot count (default: cpus)
  --local-slots=N        Local compile slot count (default: 0, disabled)
  --local-slots-max-load=N  Max system load average (1-min) to allow local compiles (default: 0, no limit)
  --cache-dir=PATH       Cache directory (default: ~/.cache/fisk/daemon)

Config files: ~/.config/fisk/daemon.conf, /etc/xdg/fisk/daemon.conf
Environment variables: FISK_DAEMON_DEBUG, FISK_DAEMON_SLOTS, etc.`);
    process.exit(0);
}

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
const localSlotCount = option.int("local-slots", 0);
const localSlots = new Slots(localSlotCount, "local", debug);
const localSlotsMaxLoad = (option("local-slots-max-load") as number) || 0;

const compilerInfoCache = new CompilerInfoCache();

interface CompilerInfoResult {
    info: CompilerInfo | null;
    error: string | null;
}

interface SlotSubscriber {
    compile: Compile;
    handler: () => void;
}

const slotSubscribers: SlotSubscriber[] = [];

function slotsInfo(): Record<string, unknown> {
    return {
        type: "slotsInfo",
        local: {
            active: localSlots.active,
            capacity: localSlots.capacity,
            total: localSlots.totalAcquired
        },
        cpp: {
            active: cppSlots.active,
            capacity: cppSlots.capacity,
            total: cppSlots.totalAcquired
        },
        compile: {
            active: compileSlots.active,
            capacity: compileSlots.capacity,
            total: compileSlots.totalAcquired
        }
    };
}

function broadcastSlotsInfo(): void {
    if (slotSubscribers.length === 0) {
        return;
    }
    const info = slotsInfo();
    for (const sub of slotSubscribers) {
        sub.compile.send(info);
    }
}

for (const slots of [localSlots, cppSlots, compileSlots]) {
    slots.on("changed", broadcastSlotsInfo);
}

function canAcquireLocalSlot(): boolean {
    if (localSlotCount <= 0) {
        return false;
    }
    if (localSlotsMaxLoad > 0) {
        const loadAvg = os.loadavg()[0];
        if (loadAvg > localSlotsMaxLoad) {
            if (debug) {
                console.log(`Local slot denied: load ${loadAvg.toFixed(2)} > max ${localSlotsMaxLoad}`);
            }
            return false;
        }
    }
    return true;
}

server.on("compile", (compile) => {
    compile.on("dumpSlots", () => {
        const ret = { cpp: cppSlots.dump(), compile: compileSlots.dump(), local: localSlots.dump() };
        if (debug) {
            console.log("sending dump", ret);
        }

        compile.send(ret);
    });

    compile.on("subscribeSlots", () => {
        if (debug) {
            console.log("subscribeSlots from", compile.id);
        }

        const subscriber: SlotSubscriber = {
            compile,
            handler: () => {
                // Remove subscriber on disconnect
                const idx = slotSubscribers.indexOf(subscriber);
                if (idx !== -1) {
                    slotSubscribers.splice(idx, 1);
                }
            }
        };
        slotSubscribers.push(subscriber);
        compile.on("end", subscriber.handler);
        compile.on("error", subscriber.handler);

        // Send current state immediately
        compile.send(slotsInfo());
    });
    let requestedCppSlot = false;
    let requestedLocalSlot = false;
    let compileClosed = false;
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

    compile.on("acquireSlot", (msg?: { type?: string; compiler?: unknown }) => {
        if (debug) {
            console.log("acquireSlot", msg);
        }

        const compilerPath: string | null =
            msg && typeof msg.compiler === "string" && msg.compiler.length > 0 ? msg.compiler : null;

        const infoResult: Promise<CompilerInfoResult> = compilerPath
            ? compilerInfoCache.get(compilerPath).then(
                  (info: CompilerInfo): CompilerInfoResult => ({ info, error: null }),
                  (err: unknown): CompilerInfoResult => {
                      const message = err instanceof Error ? err.message : String(err);
                      if (debug) {
                          console.log("acquireSlot -> compilerInfoCache failed", compilerPath, message);
                      }
                      return { info: null, error: message };
                  }
              )
            : Promise.resolve<CompilerInfoResult>({ info: null, error: "acquireSlot missing compiler path" });

        infoResult
            .then(({ info, error }) => {
                if (compileClosed) {
                    return;
                }
                const respond = (slot: "local" | "cpp"): void => {
                    const response: Record<string, unknown> = {
                        type: "slotAcquired",
                        slot,
                        compilerInfo: info
                    };
                    if (error) {
                        response.error = error;
                    }
                    compile.send(response);
                };

                if (canAcquireLocalSlot() && localSlots.tryAcquire(compile.id, { pid: compile.pid })) {
                    if (debug) {
                        console.log("acquireSlot -> local slot granted");
                    }
                    requestedLocalSlot = true;
                    respond("local");
                } else {
                    if (debug) {
                        console.log("acquireSlot -> falling back to cpp slot");
                    }
                    assert(!requestedCppSlot);
                    requestedCppSlot = true;
                    cppSlots.acquire(compile.id, { pid: compile.pid }, () => {
                        respond("cpp");
                    });
                }
            })
            .catch((err: unknown) => {
                // Defensive: the process-wide unhandledRejection handler calls process.exit().
                console.error("acquireSlot handler failed unexpectedly", err);
            });
    });

    compile.on("releaseLocalSlot", () => {
        if (debug) {
            console.log("releaseLocalSlot");
        }

        assert(requestedLocalSlot);
        if (requestedLocalSlot) {
            requestedLocalSlot = false;
            localSlots.release(compile.id);
        }
    });

    compile.on("error", (err: Error) => {
        if (debug) {
            console.error("Got error from fiskc", compile.id, compile.pid, err);
        }
        compileClosed = true;
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
        if (requestedLocalSlot) {
            requestedLocalSlot = false;
            localSlots.release(compile.id);
        }
    });

    compile.on("end", () => {
        if (debug) {
            console.log("got end from", compile.id, compile.pid);
        }
        compileClosed = true;
        if (requestedCppSlot) {
            requestedCppSlot = false;
            cppSlots.release(compile.id);
        }
        if (requestedCompileSlot) {
            requestedCompileSlot = false;
            compileSlots.release(compile.id);
        }
        if (requestedLocalSlot) {
            requestedLocalSlot = false;
            localSlots.release(compile.id);
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
