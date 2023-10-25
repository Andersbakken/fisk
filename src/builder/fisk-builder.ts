#!/usr/bin/env node

import { Client } from "./Client";
import { ObjectCache } from "./ObjectCache";
import { Server } from "./Server";
import { VM } from "./VM";
import { common as commonFunc, stringOrUndefined } from "../common";
import { load } from "./load";
import { quitOnError } from "./quitOnError";
import Url from "url-parse";
import assert from "assert";
import axios from "axios";
import bytes from "bytes";
import child_process from "child_process";
import fs from "fs-extra";
import options from "@jhanssen/options";
import os from "os";
import path from "path";
import ws from "ws";
import zlib from "zlib";
import type { CompileFinishedEvent, CompileFinishedEventFile } from "./CompileFinishedEvent";
import type { Contents } from "./ObjectCache";
import type { DropEnvironmentsMessage } from "../common/DropEnvironmentsMessage";
import type { FetchCacheObjectsMessage, FetchCacheObjectsMessageObject } from "../common/FetchCacheObjectsMessage";
import type { J } from "./J";
import type { Job } from "./Job";
import type { OptionsFunction } from "@jhanssen/options";
import type { Response } from "./Response";
import type express from "express";
import type http from "http";

const option: OptionsFunction = options({
    prefix: "fisk/builder",
    noApplicationPath: true,
    additionalFiles: ["fisk/builder.conf.override"]
});

const common = commonFunc(option);

if (process.getuid() !== 0) {
    console.error("fisk builder needs to run as root to be able to chroot");
    process.exit(1);
}

process.on("unhandledRejection", (reason: Record<string, unknown> | undefined, p: unknown) => {
    console.log("Unhandled Rejection at: Promise", p, "reason:", reason?.stack);
    if (client) {
        client.send("log", { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason?.stack}` });
    }
    quitOnError(option)();
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception", err);
    if (client) {
        client.send("log", { message: `Uncaught exception ${err.toString()} ${err.stack}` });
    }
    quitOnError(option)();
});

let debug = option("debug");

let objectCache: ObjectCache | undefined;

function getFromCache(job: Job, cb: (err?: Error) => void): boolean {
    // console.log("got job", job.sha1, objectCache ? objectCache.state(job.sha1) : false);
    // if (objectCache)
    //     console.log("objectCache", job.sha1, objectCache.state(job.sha1), objectCache.keys);
    if (!objectCache || objectCache.state(job.sha1) !== "exists") {
        return false;
    }
    const file = path.join(objectCache.dir, job.sha1);
    if (!fs.existsSync(file)) {
        console.log("The file is not even there", file);
        objectCache.remove(job.sha1);
        return false;
    }
    // console.log("we have it cached", job.sha1);

    let pointOfNoReturn = false;
    let fd: number | undefined;
    try {
        const item = objectCache.get(job.sha1);
        if (!item) {
            throw new Error("Couldn't find item " + job.sha1);
        }
        job.send(Object.assign({ objectCache: true }, item?.response));
        job.objectcache = true;
        pointOfNoReturn = true;
        fd = fs.openSync(path.join(objectCache.dir, item.response.sha1), "r");
        // console.log("here", item.response);
        let pos = 4 + item.headerSize;
        let fileIdx = 0;
        const work = (): void => {
            // console.log("work", job.sha1);
            const finish = (err?: Error): void => {
                if (fd !== undefined) {
                    fs.closeSync(fd);
                }
                if (err) {
                    objectCache?.remove(job.sha1);
                    job.close();
                } else {
                    assert(item, "Must have item");
                    ++item.cacheHits;
                }

                cb(err);
            };
            const f = item?.response.index[fileIdx];
            if (!f) {
                finish();
                return;
            }
            const buffer = Buffer.allocUnsafe(f.bytes);
            // console.log("reading from", file, path.join(objectCache.dir, item.response.sha1), pos);
            assert(fd !== undefined, "Must have fd");
            fs.read(fd, buffer, 0, f.bytes, pos, (err: NodeJS.ErrnoException, read) => {
                // console.log("GOT READ RESPONSE", file, fileIdx, err, read);
                if (err || read !== f.bytes) {
                    if (!err) {
                        err = new Error(`Short read ${read}/${f.bytes}`);
                    }
                    assert(objectCache, "Must have objectCache");
                    console.error(
                        `Failed to read ${f.bytes} from ${path.join(objectCache.dir, item.response.sha1)} got ${read} ${
                            err.message
                        }`
                    );
                    finish(err);
                } else {
                    // console.log("got good response from file", file);
                    // console.log("sending some data", buffer.length, fileIdx, item.response.index.length);
                    job.send(buffer);
                    pos += read;
                    if (++fileIdx < item.response.index.length) {
                        work();
                    } else {
                        finish();
                    }
                }
            });
        };
        work();
        return true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("Got some error here", err);
        }
        if (fd) {
            fs.closeSync(fd);
        }
        if (pointOfNoReturn) {
            job.close();
            return true; // hehe
        }
        return false;
        // console.log("The cache handled it");
    }
}

const environments: Record<string, VM> = {};
const client = new Client(option, common.Version);
client.on("objectCache", (enabled) => {
    const size = option("object-cache-size");
    const objectCacheSize = typeof size === "number" ? size : bytes.parse(String(size));
    // console.log("got object cache", enabled, objectCacheSize, option("object-cache-size"));
    if (enabled && objectCacheSize) {
        const objectCacheDir =
            stringOrUndefined(option("object-cache-dir")) || path.join(common.cacheDir(), "objectcache");

        objectCache = new ObjectCache(
            objectCacheDir,
            objectCacheSize,
            option.int("object-cache-purge-size") || objectCacheSize
        );
        objectCache.on("added", (data) => {
            assert(objectCache, "Must have objectCache");
            client.send({
                type: "objectCacheAdded",
                sha1: data.sha1,
                sourceFile: data.sourceFile,
                cacheSize: objectCache.size,
                fileSize: data.fileSize
            });
        });

        objectCache.on("removed", (data) => {
            assert(objectCache, "Must have objectCache");
            client.send({
                type: "objectCacheRemoved",
                sha1: data.sha1,
                sourceFile: data.sourceFile,
                cacheSize: objectCache.size,
                fileSize: data.fileSize
            });
        });
    } else {
        objectCache = undefined;
    }
});

client.on("fetch_cache_objects", (msg: unknown) => {
    const message = msg as FetchCacheObjectsMessage;
    console.log("Fetching", message.objects.length, "objects");
    let filesReceived = 0;
    const promises: Array<Promise<void>> = [];
    const max = Math.min(10, message.objects.length);
    for (let idx = 0; idx < max; ++idx) {
        promises.push(Promise.resolve());
    }
    message.objects.forEach((operation: FetchCacheObjectsMessageObject, idx) => {
        promises[idx % promises.length] = promises[idx % promises.length].then(() => {
            return new Promise<void>((resolve: () => void) => {
                assert(objectCache, "Must have objectCache");
                const file = path.join(objectCache.dir, operation.sha1);
                const url = `http://${operation.source}/objectcache/${operation.sha1}`;
                console.log("Downloading", url, "->", file);
                let expectedSize: number | undefined;
                let writeStream: fs.WriteStream;
                try {
                    writeStream = fs.createWriteStream(file);
                } catch (err: unknown) {
                    console.error("Got some error from write stream", err);
                    try {
                        fs.unlinkSync(file);
                    } catch (e) {
                        /* */
                    }
                    resolve();
                    return;
                }
                axios({ method: "get", url: url, responseType: "stream" })
                    .then((response) => {
                        expectedSize = parseInt(response.headers["content-length"]);
                        response.data.pipe(writeStream);
                        response.data.on("error", (err: unknown) => {
                            console.error("Got some error from stream", err);
                            writeStream.destroy(new Error("http stream error " + (err as Error).toString()));
                        });
                        // console
                    })
                    .catch((err: unknown) => {
                        console.error("Got some error", err);
                        writeStream.destroy(new Error("http error " + (err as Error).toString()));
                    });
                writeStream.on("finish", () => {
                    console.log("Finished writing file", file);
                    let stat;
                    try {
                        stat = fs.statSync(file);
                    } catch (err) {
                        /* */
                    }
                    if (!stat || stat.size !== expectedSize) {
                        console.log(
                            "Got wrong size for",
                            file,
                            url,
                            "\nGot",
                            stat ? stat.size : -1,
                            "expected",
                            expectedSize
                        );
                        try {
                            fs.unlinkSync(file);
                        } catch (err) {
                            // console.log("Got error unlinking file", file, err);
                        }
                    } else {
                        ++filesReceived;
                        assert(objectCache, "Must have objectcache");
                        objectCache.loadFile(file, stat.size);
                    }
                    resolve();
                });
                writeStream.on("error", (err) => {
                    console.error("Got stream error", err);
                    resolve();
                });
            });
        });
    });
    Promise.all(promises).then(() => {
        console.log("got results", filesReceived);
    });
    // chain.then(() => {
    //     console.log("Received", filesReceived, "files. Restarting");
    //     process.exit();
    // });
});

const environmentsRoot = path.join(common.cacheDir(), "environments");

function exec(command: string, opts: child_process.ExecOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        child_process.exec(
            command,
            opts,
            (err: child_process.ExecException | null, _: string | Buffer, stderr: string | Buffer) => {
                if (stderr) {
                    console.error("Got stderr from", command);
                }
                if (err) {
                    reject(new Error(`Failed to run command ${command}: ${err.message}`));
                } else {
                    console.log(command, "finished");
                    resolve();
                }
            }
        );
    });
}

function loadEnvironments(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        fs.readdir(environmentsRoot, (readDirError: NodeJS.ErrnoException, files: string[]) => {
            // console.log("GOT FILES", files);
            if (readDirError) {
                if (readDirError.code === "ENOENT") {
                    fs.mkdirp(environmentsRoot)
                        .then(() => {
                            // let user = option("fisk-user");
                            // let split = environmentsRoot.split("/");
                            // if (!user) {
                            //     if (split[0] == "home" || split[0] == "Users") {
                            //         user = split[1];
                            //     } else if (split[0] == "usr" && split[1] == "home") {
                            //         user = split[2];
                            //     }
                            // }
                            // if (!user) {
                            //     user = process.env["SUDO_USER"];
                            // }
                            // if (user) {
                            //     let p = "";
                            //     split.forEach(element => {
                            //         p += "/" + element;
                            // });
                            resolve();
                        })
                        .catch((error: Error) => {
                            reject(new Error("Failed to create directory " + error.message));
                        });
                    return;
                }
                reject(readDirError);
            } else {
                if (files) {
                    let pending = 0;
                    for (let i = 0; i < files.length; ++i) {
                        try {
                            const dir = path.join(environmentsRoot, files[i]);
                            const stat = fs.statSync(dir);
                            if (!stat.isDirectory()) {
                                fs.removeSync(dir);
                                continue;
                            }
                            let env;
                            try {
                                env = JSON.parse(fs.readFileSync(path.join(dir, "environment.json"), "utf8"));
                            } catch (error: unknown) {
                                /* */
                            }
                            if (env && env.hash) {
                                const vm = new VM(dir, env.hash, option);
                                ++pending;
                                environments[env.hash] = vm;
                                const errorHandler = (): void => {
                                    if (!vm.ready && !--pending) {
                                        resolve();
                                    }
                                };
                                vm.once("error", errorHandler);
                                vm.once("ready", () => {
                                    vm.ready = true;
                                    vm.removeListener("error", errorHandler);
                                    if (!--pending) {
                                        resolve();
                                    }
                                });
                            } else {
                                console.log("Removing directory", dir);
                                fs.removeSync(dir);
                            }
                        } catch (err: unknown) {
                            console.error(
                                `Got error loading environment ${files[i]} ${(err as Error).stack} ${
                                    (err as Error).message
                                }`
                            );
                        }
                    }
                    if (!pending) {
                        resolve();
                    }
                }
            }
        });
    });
}

let connectInterval: NodeJS.Timeout | undefined;
client.on("quit", (message: Record<string, unknown>) => {
    console.log(
        `Server wants us to quit: ${Number(message.code) || 0} purge environments: ${message.purgeEnvironments}`
    );
    if (message.purgeEnvironments) {
        try {
            fs.removeSync(environmentsRoot);
        } catch (err) {
            console.error("Failed to remove environments", environmentsRoot);
        }
    }
    process.exit(Number(message.code) || 0);
});

client.on("version_mismatch", (message) => {
    console.log(`We have the wrong version. We have ${client.npmVersion} but we need ${message.required_version}`);
    const versionFile = option("npm-version-file");
    if (versionFile) {
        try {
            fs.writeFileSync(String(versionFile), "@" + message.required_version);
        } catch (err) {
            console.error("Failed to write version file", versionFile, err);
        }
    }
    process.exit(message.code || 0);
});

client.on("clearObjectCache", () => {
    if (objectCache) {
        objectCache.clear();
    }
});

client.on("dropEnvironments", (message: DropEnvironmentsMessage) => {
    console.log(`Dropping environments ${message.environments}`);
    message.environments.forEach((env: string) => {
        const environment = environments[env];
        if (environment) {
            const dir = path.join(environmentsRoot, env);
            console.log(`Purge environment ${env} ${dir}`);
            environment.destroy();
            delete environments[env];
        }
    });
});

client.on("getEnvironments", (message) => {
    console.log(`Getting environments ${message.environments}`);
    let base = String(option("scheduler", "localhost:8097"));
    const idx = base.indexOf("://");
    if (idx !== -1) {
        base = base.substring(idx + 3);
    }
    base = "http://" + base;
    if (!/:[0-9]+$/.exec(base)) {
        base += ":8097";
    }
    base += "/environment/";
    const work = (): void => {
        if (!message.environments.length) {
            const restart = option("restart-on-new-environments");
            if (!restart) {
                setTimeout(() => {
                    client.send("environments", { environments: Object.keys(environments) });
                    console.log("Informing scheduler about our environments:", Object.keys(environments));
                }, option.int("inform-delay", 5000));
            } else {
                console.log("Restarting after we got our new environments");
                process.exit();
            }
            return;
        }
        const env = message.environments.splice(0, 1)[0];
        const url = base + env;
        console.log("Got environment url", url);

        const dir = path.join(environmentsRoot, env);
        try {
            fs.removeSync(dir);
        } catch (err) {
            /* */
        }
        fs.mkdirpSync(dir);

        const file = path.join(dir, "env.tar.gz");
        const writeStream = fs.createWriteStream(file);
        writeStream.on("finish", () => {
            console.log("Got finish", env);
            exec("tar xf '" + file + "'", { cwd: dir })
                .then(() => {
                    const json = path.join(dir, "environment.json");
                    console.log("Writing json file", json);
                    return fs.writeFile(json, JSON.stringify({ hash: env, created: new Date().toString() }));
                })
                .then(() => {
                    console.log(`Unlink ${file} ${env}`);
                    return fs.unlink(file);
                })
                .then(() => {
                    const vm = new VM(dir, env, option);
                    return new Promise<VM>((resolve, reject) => {
                        let done = false;
                        vm.on("error", (err) => {
                            if (!done) {
                                reject(err);
                            }
                        });
                        vm.on("ready", () => {
                            done = true;
                            resolve(vm);
                        });
                    });
                })
                .then((vm: VM) => {
                    environments[env] = vm;
                    setTimeout(work, 0);
                })
                .catch((err) => {
                    console.error("Got failure setting up environment", err);
                    try {
                        fs.removeSync(dir);
                    } catch (rmdirErr) {
                        console.error("Failed to remove directory", dir, rmdirErr);
                    }
                    setTimeout(work, 0);
                });
        });
        axios({ method: "get", url: url, responseType: "stream" })
            .then((response) => {
                response.data.pipe(writeStream);
                // console
            })
            .catch((error) => {
                console.log("Got error from request", error);
                if (writeStream.destroy instanceof Function) {
                    writeStream.destroy();
                } else {
                    writeStream.end();
                }
                try {
                    fs.removeSync(dir);
                } catch (err) {
                    /* */
                }
                fs.mkdirpSync(dir);
            });
    };
    work();
});

client.on("requestEnvironments", () => {
    console.log("scheduler wants us to inform of current environments", Object.keys(environments));
    client.send("environments", { environments: Object.keys(environments) });
});

client.on("connect", () => {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
    if (!load.running) {
        load.start(option.int("loadInterval", 1000) || 1000);
    }
    if (objectCache) {
        client.send({
            type: "objectCache",
            sha1s: objectCache.syncData(),
            maxSize: objectCache.maxSize,
            cacheSize: objectCache.size
        });
    }
});

client.on("error", (err) => {
    console.error("client error", err);
    if (load.running) {
        load.stop();
    }
});

client.on("close", () => {
    console.log("client closed");
    if (load.running) {
        load.stop();
    }
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log("Reconnecting...");
            client.connect(Object.keys(environments));
        }, 1000);
    }
});

client.on("command", (command) => {
    console.log("Got command", command);
    child_process.exec(
        command.command,
        { encoding: "utf8" },
        (err: child_process.ExecException | null, stdout: string, stderr: string) => {
            if (stdout) {
                console.log("Got stdout from", command, stdout);
            }
            if (stderr) {
                console.error("Got stderr from", command, stderr);
            }
            client.send({ type: "command", id: command.id, command: command.command, stdout, stderr });
        }
    );
});

const server = new Server(option, common.Version);
const jobQueue: J[] = [];

server.on("headers", (headers, req) => {
    // console.log("request is", req.url);
    let wait = false;
    if (objectCache && objectCache.state(req.headers["x-fisk-sha1"]) === "exists") {
        wait = true;
    } else if (jobQueue.length >= client.slots) {
        const priority = parseInt(req.headers["x-fisk-sha1"]) || 0;
        let idx = jobQueue.length - 1;
        while (idx >= client.slots) {
            const job = jobQueue[idx].job;
            if (job.priority >= priority) {
                break;
            }
            --idx;
        }

        wait = idx >= client.slots;
    }
    headers.push(`x-fisk-wait: ${wait}`);
});

server.on("listen", (app: express.Express) => {
    const setDebug = (enabled: boolean): void => {
        debug = enabled;
        for (const i in environments) {
            const env = environments[i];
            env.setDebug(debug);
        }
    };
    app.get("/debug", (_: http.IncomingMessage, res: express.Response) => {
        setDebug(true);
        res.sendStatus(200);
    });
    app.get("/nodebug", (_: http.IncomingMessage, res: express.Response) => {
        setDebug(false);
        res.sendStatus(200);
    });

    app.get("/objectcache/*", (req: http.IncomingMessage, res: express.Response) => {
        if (!objectCache) {
            res.sendStatus(404);
            return;
        }

        const parsed = new Url(req.url || "", server.baseUrl);

        const urlPath = parsed.pathname.substring(13);
        if (urlPath === "info") {
            res.send(JSON.stringify(objectCache.info(parsed.query), null, 4));
            return;
        }
        const data = objectCache.get(urlPath, true);
        if (!data) {
            res.sendStatus(404);
            return;
        }
        const file = path.join(objectCache.dir, urlPath);
        try {
            const stat = fs.statSync(file);
            res.set("Content-Length", String(stat.size));
            const rstream = fs.createReadStream(file);
            rstream.on("error", (err) => {
                console.error("Got read stream error for", file, err);
                rstream.close();
            });
            rstream.pipe(res);
        } catch (err) {
            console.error("Got some error", err);
            res.sendStatus(500);
        }
    });
});

function startPending(): void {
    // console.log(`startPending called ${jobQueue.length}`);
    for (let idx = 0; idx < jobQueue.length; ++idx) {
        const jj = jobQueue[idx];
        if (!jj.op && !jj.objectCache) {
            // console.log("starting jj", jj.id);
            jj.start();
            break;
        }
    }
}

server.on("job", (job: Job) => {
    const vm = environments[job.hash];
    if (!vm) {
        console.error("No vm for this hash", job.hash);
        job.close();
        return;
    }
    const jobStartTime = Date.now();
    let uploadDuration: undefined | number;

    // console.log("sending to server");
    const j: J = {
        id: job.id,
        job: job,
        op: undefined,
        done: false,
        aborted: false,
        started: false,
        heartbeatTimer: undefined,
        buffer: undefined,
        stdout: "",
        stderr: "",
        start: function () {
            const jobJob = this.job;
            if (j.aborted) {
                return;
            }
            if (
                getFromCache(jobJob, (err?: Error) => {
                    if (j.aborted) {
                        return;
                    }
                    if (err) {
                        console.error("cache failed, let the client handle doing it itself");
                        jobJob.close();
                    } else {
                        // console.log("GOT STUFF", job);
                        const info = {
                            type: "cacheHit",
                            client: {
                                hostname: jobJob.hostname,
                                ip: jobJob.ip,
                                name: jobJob.name,
                                user: jobJob.user
                            },
                            sourceFile: jobJob.sourceFile,
                            sha1: jobJob.sha1,
                            id: jobJob.id
                        };
                        // console.log("sending cachehit", info);
                        client.send(info);

                        console.log("Job finished from cache", j.id, jobJob.sourceFile, "for", jobJob.ip, jobJob.name);
                    }
                    j.done = true;
                    const idx = jobQueue.indexOf(j);
                    if (idx !== -1) {
                        jobQueue.splice(idx, 1);
                    }
                    startPending();
                })
            ) {
                j.objectCache = true;
                return;
            }
            j.started = true;
            client.send("jobStarted", {
                id: jobJob.id,
                sourceFile: jobJob.sourceFile,
                client: {
                    name: jobJob.name,
                    hostname: jobJob.hostname,
                    ip: jobJob.ip,
                    user: jobJob.user
                },
                builder: {
                    ip: jobJob.builderIp,
                    name: option("name"),
                    hostname: option("hostname") || os.hostname(),
                    port: server.port
                }
            });

            console.log("Starting job", j.id, jobJob.sourceFile, "for", jobJob.ip, jobJob.name, "wait", jobJob.wait);
            assert(jobJob.commandLine, "Must have commandLine");
            assert(jobJob.argv0, "Must have argv0");
            j.op = vm.startCompile(jobJob.commandLine, jobJob.argv0, jobJob.id);
            if (j.buffer) {
                j.op.feed(j.buffer);
                j.buffer = undefined;
            }
            if (jobJob.wait) {
                jobJob.send("resume", {});
            }
            j.op.on("stdout", (data) => {
                j.stdout += data;
            }); // ### is there ever any stdout? If there is, does the order matter for stdout vs stderr?
            j.op.on("stderr", (data) => {
                j.stderr += data;
            });
            j.op.on("finished", (event: CompileFinishedEvent) => {
                j.done = true;
                if (j.aborted) {
                    return;
                }
                const end = Date.now();
                const idx = jobQueue.indexOf(j);
                console.log(
                    "Job finished",
                    j.id,
                    jobJob.sourceFile,
                    "for",
                    jobJob.ip,
                    jobJob.name,
                    "exitCode",
                    event.exitCode,
                    "error",
                    event.error,
                    "in",
                    end - jobStartTime + "ms"
                );
                if (idx !== -1) {
                    jobQueue.splice(idx, 1);
                } else {
                    console.error("Can't find j?");
                    return;
                }

                // this can't be async, the directory is removed after the event is fired
                const forCache: Contents[] = event.files.map((f: CompileFinishedEventFile) => ({
                    contents: fs.readFileSync(f.absolute),
                    path: f.path
                }));
                const contents: Contents[] = !j.job.compressed
                    ? forCache
                    : forCache.map((x) => ({
                          path: x.path,
                          contents: x.contents.byteLength ? zlib.gzipSync(x.contents) : x.contents
                      }));
                const response: Response = {
                    type: "response",
                    index: contents.map((item) => {
                        return { path: item.path, bytes: item.contents.length };
                    }),
                    success: event.success,
                    exitCode: event.exitCode,
                    sha1: jobJob.sha1,
                    stderr: j.stderr,
                    stdout: j.stdout
                };
                if (event.error) {
                    response.error = event.error;
                }
                if (debug) {
                    console.log("Sending response", jobJob.ip, jobJob.hostname, response);
                }
                jobJob.send(response);
                if (
                    response.exitCode === 0 &&
                    event.success &&
                    objectCache &&
                    response.sha1 &&
                    objectCache.state(response.sha1) === "none"
                ) {
                    response.sourceFile = jobJob.sourceFile;
                    response.commandLine = jobJob.commandLine;
                    response.environment = jobJob.hash;
                    objectCache.add(response, forCache);
                }

                contents.forEach((x) => {
                    if (x.contents.byteLength) {
                        jobJob.send(x.contents);
                    }
                });
                // console.log("GOT ID", j);
                assert(uploadDuration !== undefined, "Must have uploadDuration");
                if (event.success) {
                    client.send("jobFinished", {
                        id: j.id,
                        cppSize: event.cppSize,
                        compileDuration: event.compileDuration,
                        compileSpeed: event.cppSize / event.compileDuration,
                        uploadDuration: uploadDuration,
                        uploadSpeed: event.cppSize / uploadDuration
                    });
                } else {
                    client.send("jobAborted", {
                        id: j.id,
                        cppSize: event.cppSize,
                        compileDuration: event.compileDuration,
                        compileSpeed: event.cppSize / event.compileDuration,
                        uploadDuration: uploadDuration,
                        uploadSpeed: event.cppSize / uploadDuration
                    });
                }
                startPending();
            });
        },
        cancel: function () {
            if (!j.done && j.op) {
                j.done = true;
                j.op.cancel();
            }
        }
    };

    j.heartbeatTimer = setInterval(() => {
        if (j.done || j.aborted || job.readyState !== ws.OPEN) {
            clearTimeout(j.heartbeatTimer);
        } else {
            // console.log("sending heartbeat");
            job.send("heartbeat", {});
        }
    }, 5000);

    job.on("error", (err) => {
        j.webSocketError = `${err} from ${job.name} ${job.hostname} ${job.ip}`;
        console.error("got error from job", j.webSocketError);
        j.done = true;
    });
    job.on("close", () => {
        job.removeAllListeners();
        j.done = true;
        const idx = jobQueue.indexOf(j);
        if (idx !== -1) {
            j.aborted = true;
            jobQueue.splice(idx, 1);
            j.cancel();
            if (j.started) {
                client.send("jobAborted", { id: j.id, webSocketError: j.webSocketError });
            }
            startPending();
        }
    });

    job.on("data", (data) => {
        // console.log("got data", this.id, typeof j.op);
        uploadDuration = Date.now() - jobStartTime;
        if (!j.op) {
            j.buffer = data.data;
            console.log("buffering...", data.data.byteLength);
        } else {
            j.op.feed(data.data);
        }
    });

    let idx = jobQueue.length;
    while (idx > 0) {
        const jobJob = jobQueue[idx - 1].job;
        if (jobJob.priority >= job.priority) {
            // console.log("Stopping at idx", idx, "Because of", job.priority, jobJob.priority, client.slots, jobJob.length);
            break;
        }
        --idx;
    }
    jobQueue.splice(idx, 0, j);

    if (jobQueue.length <= client.slots) {
        // console.log(`starting j ${j.id} because ${jobQueue.length} ${client.slots}`);
        j.start();
    } else {
        // console.log(`j ${j.id} is backlogged`, jobQueue.length, client.slots);
    }
});

server.on("error", (err) => {
    console.error("server error", err);
});

function start(): void {
    loadEnvironments()
        .then(() => {
            console.log(`Loaded ${Object.keys(environments).length} environments from ${environmentsRoot}`);
            console.log("environments", Object.keys(environments));
            client.connect(Object.keys(environments));
            server.listen();
        })
        .catch((err: unknown) => {
            console.error(`Failed to initialize ${(err as Error).message}`);
            setTimeout(start, 1000);
        });
}
load.on("data", (measure) => {
    // console.log("Got load", measure);
    try {
        client.send("load", { measure: measure });
    } catch (err) {
        /* */
    }
});
start();
