#!/usr/bin/env node

import { CompilerInfoStore } from "./CompilerInfoCache";
import { Constants } from "./Constants";
import { SchedulerConnection } from "./SchedulerConnection";
import { Server } from "./Server";
import { Slots } from "./Slots";
import { common as commonFunc } from "../common";
import assert from "assert";
import createOptions from "@jhanssen/options";
import fs from "fs";
import os from "os";
import path from "path";
import type { Compile } from "./Compile";
import type { CompilerInfo, Probe } from "./CompilerInfoCache";
import type { Options } from "@jhanssen/options";
import type { SchedulerJobUpdate } from "./SchedulerConnection";

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
  --scheduler=URL        Scheduler to keep a connection to on behalf of fiskc
                         (default: whatever url the clients ask for)
  --name=NAME            Name reported to the scheduler (default: hostname)
  --hostname=NAME        Hostname reported to the scheduler (default: os.hostname())

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
    console.error("Unhandled Rejection at: Promise", p, "reason:", reason?.stack);
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

console.log(
    `cpp slots: ${cppSlots.capacity}, compile slots: ${compileSlots.capacity}, local slots: ${localSlots.capacity}, local max load: ${localSlotsMaxLoad}`
);

const compilerInfoStore = new CompilerInfoStore(undefined, (...args: unknown[]) => {
    console.log("compilerInfo:", ...args);
});

function daemonNpmVersion(): string {
    try {
        return String(JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).version);
    } catch (err) {
        return "";
    }
}

function normalizeSchedulerUrl(url: string): string {
    let ret = url;
    if (ret.indexOf("://") === -1) {
        ret = "ws://" + ret;
    }
    if (!/:[0-9]+$/.exec(ret)) {
        ret += ":8097";
    }
    return ret;
}

const daemonHostname = option.string("hostname") || os.hostname();
const daemonName = option.string("name") || daemonHostname;

let scheduler: SchedulerConnection | undefined;

function connectToScheduler(url: string): SchedulerConnection {
    const connection = new SchedulerConnection(
        url,
        common.Version,
        daemonNpmVersion(),
        daemonName,
        daemonHostname,
        debug
    );
    connection.connect();
    return connection;
}

const configuredScheduler = option.string("scheduler");
if (configuredScheduler) {
    scheduler = connectToScheduler(normalizeSchedulerUrl(configuredScheduler));
}

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

    // fiskc no longer talks to the scheduler itself; it asks us, and we answer
    // over the connection we already hold. Its process only lives for one
    // translation unit, so a request belongs to exactly one fiskc and dies with it.
    let builderRequestId: number | undefined;
    let builderRequestScheduler: SchedulerConnection | undefined;

    const finishBuilderRequest = (reason: string): void => {
        if (builderRequestId !== undefined && builderRequestScheduler) {
            builderRequestScheduler.finishJob(builderRequestId, reason);
        }
        builderRequestId = undefined;
        builderRequestScheduler = undefined;
    };

    compile.on("requestBuilder", (msg?: Record<string, unknown>) => {
        const str = (key: string): string | undefined => {
            const value = msg?.[key];
            return typeof value === "string" && value ? value : undefined;
        };
        // fallback means "we cannot serve this, but the scheduler probably can":
        // fiskc then connects directly. A scheduler that is down or not keeping up
        // is deliberately not one of those cases -- having every fiskc on the host
        // pile onto it is exactly what this whole path exists to stop.
        const respond = (update: SchedulerJobUpdate, objectCache: boolean, fallback: boolean = false): void => {
            compile.send({
                type: "builderResponse",
                objectCache,
                fallback,
                message: update.message,
                error: update.error
            });
        };

        if (builderRequestId !== undefined) {
            respond({ error: "Already requested a builder" }, false);
            return;
        }

        const configVersion = typeof msg?.configVersion === "number" ? msg.configVersion : -1;
        if (configVersion !== common.Version) {
            respond(
                { error: `Bad config version, daemon has ${common.Version}, fiskc has ${configVersion}` },
                false,
                true
            );
            return;
        }

        const environment = str("environment");
        const sourceFile = str("sourceFile");
        if (!environment || !sourceFile) {
            respond({ error: "requestBuilder needs an environment and a sourceFile" }, false);
            return;
        }

        const requestedUrl = str("scheduler");
        if (!scheduler && requestedUrl) {
            // Nothing in daemon.conf: adopt the scheduler our clients are
            // configured with, so existing deployments keep working untouched.
            console.log("adopting scheduler url from", compile.id, requestedUrl);
            scheduler = connectToScheduler(requestedUrl);
        }
        const connection = scheduler;
        if (!connection) {
            respond({ error: "No scheduler configured for this daemon" }, false, true);
            return;
        }
        if (requestedUrl && requestedUrl !== connection.url) {
            respond(
                { error: `fiskc wants scheduler ${requestedUrl}, daemon is connected to ${connection.url}` },
                false,
                true
            );
            return;
        }

        const id = connection.requestBuilder(
            {
                environment,
                sourceFile,
                sha1: str("sha1"),
                name: str("name"),
                user: str("user"),
                hostname: str("hostname"),
                builder: str("builder"),
                labels: str("labels"),
                npmVersion: str("npmVersion")
            },
            (update: SchedulerJobUpdate) => {
                respond(update, connection.objectCache);
            }
        );
        if (id === undefined) {
            // Disconnected is not the same failure as backed up. A scheduler that
            // is merely restarting is still reachable by fiskc, whose direct path
            // retries across exactly that RST, so let it. Only refuse fallback
            // when the scheduler is up but not keeping up.
            const backedUp = connection.isConnected;
            respond(
                {
                    error: backedUp
                        ? `Scheduler ${connection.url} is not keeping up`
                        : `Not connected to scheduler ${connection.url}`
                },
                false,
                !backedUp
            );
            return;
        }
        builderRequestId = id;
        builderRequestScheduler = connection;
    });
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

    // The daemon cannot see, let alone run, the compiler: it usually lives in
    // the client's container. Clients identify it with a key they compute
    // themselves and run the probes on our behalf when asked.
    const requester = {
        id: compile.id,
        requestCompilerInfo(key: string, probes: readonly Probe[], timeoutMs: number): void {
            compile.send({ type: "compilerInfoRequest", key, probes, timeoutMs });
        }
    };

    compile.on("acquireSlot", (msg?: { type?: string; compilerKey?: unknown; "no-local"?: boolean }) => {
        console.log("acquireSlot", msg);

        const compilerKey: string | null =
            msg && typeof msg.compilerKey === "string" && msg.compilerKey.length > 0 ? msg.compilerKey : null;

        const infoResult: Promise<CompilerInfoResult> = compilerKey
            ? compilerInfoStore.get(compilerKey, requester).then(
                  (info: CompilerInfo): CompilerInfoResult => ({ info, error: null }),
                  (err: unknown): CompilerInfoResult => {
                      const message = err instanceof Error ? err.message : String(err);
                      if (debug) {
                          console.log("acquireSlot -> compilerInfoStore failed", compilerKey, message);
                      }
                      return { info: null, error: message };
                  }
              )
            : Promise.resolve<CompilerInfoResult>({ info: null, error: "acquireSlot missing compiler key" });

        infoResult
            .then(({ info, error }) => {
                if (compileClosed) {
                    return;
                }
                const respond = (slot: "local" | "cpp"): void => {
                    const response: Record<string, unknown> = {
                        type: "slotAcquired",
                        slot,
                        compilerInfo: info,
                        // Tells fiskc it can ask us for a builder. A daemon too old to
                        // know about requestBuilder says nothing here, and fiskc then
                        // connects to the scheduler itself like it always did instead
                        // of waiting out its watchdog for an answer we never send.
                        schedulerProxy: true
                    };
                    if (error) {
                        response.error = error;
                    }
                    compile.send(response);
                };

                if (
                    !msg?.["no-local"] &&
                    canAcquireLocalSlot() &&
                    localSlots.tryAcquire(compile.id, { pid: compile.pid })
                ) {
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

    compile.on("compilerInfoResponse", (msg?: { key?: unknown; results?: unknown; error?: unknown }) => {
        const key = msg && typeof msg.key === "string" ? msg.key : "";
        if (!key) {
            console.error("compilerInfoResponse without a key from", compile.id);
            return;
        }
        if (typeof msg?.error === "string" && msg.error.length) {
            compilerInfoStore.fail(key, msg.error);
            return;
        }
        if (!msg?.results || typeof msg.results !== "object") {
            compilerInfoStore.fail(key, "compilerInfoResponse without results");
            return;
        }
        compilerInfoStore.provide(key, msg.results as Record<string, string | null>);
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
        finishBuilderRequest("fiskc gone");
        // If this client owed us compiler info, hand the job to another waiter.
        compilerInfoStore.clientGone(requester);
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
        finishBuilderRequest("fiskc gone");
        // If this client owed us compiler info, hand the job to another waiter.
        compilerInfoStore.clientGone(requester);
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
    scheduler?.close();
});

process.on("SIGINT", () => {
    server.close();
    scheduler?.close();
    process.exit();
});
