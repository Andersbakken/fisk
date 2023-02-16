#!/usr/bin/env node

import { Builder } from "./Builder";
import { BuilderAddedMessage, BuilderRemovedMessage } from "../common-ts/BuilderAddedOrRemovedMessage";
import { CacheHitMessage } from "./CacheHitMessage";
import { Client } from "./Client";
import { Compile } from "./Compile";
import { Database } from "./Database";
import { Environments } from "./Environments";
import { File } from "./File";
import { JobFinishedMessage } from "./JobFinishedMessage";
import { JobMonitorMessage } from "../common-ts/JobMonitorMessage";
import { JobScheduledMessage } from "./JobScheduledMessage";
import { JobStartedMessage } from "./JobStartedMessage";
import { MonitorMessage } from "./MonitorMessage";
import { ObjectCacheManager } from "./ObjectCacheManager";
import { Peak } from "./Peak";
import { PeakData } from "./PeakData";
import { Server } from "./Server";
import { common as commonFunc } from "../common-ts/index";
import assert from "assert";
import bytes from "bytes";
import compareVersions from "compare-versions";
import crypto from "crypto";
import express from "express";
import fs from "fs-extra";
import humanizeDuration from "humanize-duration";
import options, { OptionsFunction } from "@jhanssen/options";
import path from "path";
import posix from "posix";

const option: OptionsFunction = options({
    prefix: "fisk/builder",
    noApplicationPath: true,
    additionalFiles: ["fisk/builder.conf.override"]
});
const common = commonFunc(option);

const server = new Server(option, common.Version);

const clientMinimumVersion = "3.4.96";
const serverStartTime = Date.now();
process.on("unhandledRejection", (reason: Error, p: Promise<unknown>) => {
    console.error("Unhandled Rejection at: Promise", p, "reason:", reason?.stack);
    addLogFile({ source: "no source file", ip: "self", contents: `reason: ${reason.stack} p: ${p}\n` });
    // process.exit();
});

process.on("uncaughtException", (err: Error) => {
    console.error("Uncaught exception", err);
    addLogFile({ source: "no source file", ip: "self", contents: err.toString() + err.stack + "\n" });
    // process.exit();
});

const monitorsLog = option("monitor-log");

server.on("error", (error) => {
    throw new error();
});

let schedulerNpmVersion: string;
try {
    schedulerNpmVersion = String(JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).version);
} catch (err) {
    console.log("Couldn't parse package json", err);
    process.exit();
}

const builders: Record<string, Builder> = {};

const monitors: Client[] = [];
let builderCount = 0;
let activeJobs = 0;
let capacity = 0;
let jobsFailed = 0;
let jobsStarted = 0;
let jobsScheduled = 0;
let jobsFinished = 0;
let jobId = 0;
const db = new Database(path.join(common.cacheDir(), "db.json"));
let objectCache: ObjectCacheManager | undefined;
const logFileDir = path.join(common.cacheDir(), "logs");
try {
    fs.mkdirSync(logFileDir);
} catch (err) {
    /* */
}

const peaks = [
    new Peak(60 * 60 * 1000, "Last hour"),
    new Peak(24 * 60 * 60 * 1000, "Last 24 hours"),
    new Peak(7 * 24 * 60 * 60 * 1000, "Last 7 days"),
    new Peak(30 * 24 * 60 * 60 * 1000, "Last 30 days"),
    new Peak(0, "Forever")
];

function peakData(): Record<string, PeakData | string | number> {
    const ret: Record<string, PeakData | string | number> = {};
    peaks.forEach((peak) => (ret[peak.name] = peak.toObject()));
    return ret;
}

function statsMessage() {
    const info = peakData();
    info.type = "stats";
    const jobs = jobsFailed + jobsFinished + (objectCache ? objectCache.hits : 0);
    info.jobs = jobs;
    info.jobsFailed = jobsFailed;
    info.jobsScheduled = jobsScheduled;
    info.jobsFinished = jobsFinished;
    info.jobsStarted = jobsStarted;
    info.cacheHits = objectCache ? objectCache.hits : 0;
    return info;
}

const pendingUsers: Record<string, boolean> = {};

function nextJobId() {
    let id = ++jobId;
    if (id === 2147483647) {
        id = 1;
    }
    return id;
}

function jobStartedOrScheduled(type: "jobStarted" | "jobScheduled", job: JobStartedMessage | JobScheduledMessage) {
    if (monitors.length) {
        // console.log("GOT STUFF", job);
        const info: JobMonitorMessage = {
            type: type,
            client: {
                hostname: job.client.hostname,
                ip: job.client.ip,
                name: job.client.name,
                user: job.client.user,
                labels: job.client.labels
            },
            sourceFile: job.sourceFile,
            builder: {
                hostname: job.builder.hostname,
                ip: job.builder.ip,
                name: job.builder.name,
                port: job.builder.port,
                labels: job.builder.labels
            },
            id: job.id
        };

        if (monitorsLog) {
            console.log("send to monitors", info);
        }
        monitors.forEach((monitor) => monitor.send(info));
    }
}

function cacheHit(builder: Builder, message: CacheHitMessage) {
    if (objectCache) {
        objectCache.hit(message.sha1);
    }
    if (monitors.length) {
        const info: JobMonitorMessage = {
            type: "cacheHit",
            client: {
                hostname: message.client.hostname,
                ip: message.client.ip,
                name: message.client.name,
                user: message.client.user
            },
            sourceFile: message.sourceFile,
            builder: {
                ip: builder.ip,
                name: builder.name,
                port: builder.port,
                labels: builder.labels
            },
            id: message.id,
            jobs: (objectCache ? objectCache.hits : 0) + jobsFailed + jobsFinished,
            jobsFailed: jobsFailed,
            jobsStarted: jobsStarted,
            jobsFinished: jobsFinished,
            jobsScheduled: jobsScheduled,
            cacheHits: objectCache ? objectCache.hits : 0
        };
        if (builder.hostname) {
            info.builder.hostname = builder.hostname;
        }
        if (monitorsLog) {
            console.log("send to monitors", info);
        }
        // console.log("sending info", info);
        monitors.forEach((monitor) => monitor.send(info));
    }
}

function jobFinished(builder: Builder, job: JobFinishedMessage) {
    ++jobsFinished;
    ++builder.jobsPerformed;
    builder.totalCompileSpeed += job.compileSpeed;
    builder.totalUploadSpeed += job.uploadSpeed;
    // console.log(`builder: ${builder.ip}:${builder.port} performed a job`, job);
    if (monitors.length) {
        const jobs = jobsFailed + jobsFinished + (objectCache ? objectCache.hits : 0);
        const info = {
            type: "jobFinished",
            id: job.id,
            cppSize: job.cppSize,
            compileDuration: job.compileDuration,
            uploadDuration: job.uploadDuration,
            jobs: jobs,
            jobsStarted: jobsStarted,
            jobsFailed: jobsFailed,
            jobsFinished: jobsFinished,
            jobsScheduled: jobsScheduled,
            cacheHits: objectCache ? objectCache.hits : 0
        };
        if (monitorsLog) {
            console.log("send to monitors", info);
        }
        monitors.forEach((monitor) => monitor.send(info));
    }
}

function builderKey(ip: string | Builder, port?: number): string {
    if (typeof ip === "object") {
        return ip.ip + " " + ip.port;
    }
    return ip + " " + port;
}

function builderToMonitorInfo(
    builder: Builder,
    type: "builderAdded" | "builderRemoved"
): BuilderAddedMessage | BuilderRemovedMessage {
    return {
        type: type,
        ip: builder.ip,
        name: builder.name,
        hostname: builder.hostname,
        slots: builder.slots,
        port: builder.port,
        jobsPerformed: builder.jobsPerformed,
        compileSpeed: builder.jobsPerformed / builder.totalCompileSpeed || 0,
        uploadSpeed: builder.jobsPerformed / builder.totalUploadSpeed || 0,
        system: builder.system,
        created: builder.created.toString(),
        npmVersion: builder.npmVersion,
        environments: builder.environments ? Object.keys(builder.environments) : [],
        labels: builder.labels
    };
}

function insertBuilder(builder: Builder) {
    builders[builderKey(builder)] = builder;
    ++builderCount;
    assert(typeof builder.slots === "number");
    capacity += builder.slots;
    if (monitors.length) {
        const info = builderToMonitorInfo(builder, "builderAdded");
        if (monitorsLog) {
            console.log("send to monitors", info);
        }
        monitors.forEach((monitor) => {
            monitor.send(info);
        });
    }
}

function forEachBuilder(cb: (builder: Builder) => void) {
    for (const key in builders) {
        cb(builders[key]);
    }
}

function onObjectCacheCleared(): void {
    jobsFailed = 0;
    jobsStarted = 0;
    jobsScheduled = 0;
    jobsFinished = 0;
    const msg = { type: "clearObjectCache" };
    forEachBuilder((builder) => builder.send(msg));
    const info = statsMessage();
    monitors.forEach((monitor) => monitor.send(info));
}

function setObjectCacheEnabled(on: boolean): void {
    if (on && !objectCache) {
        objectCache = new ObjectCacheManager(option);
        objectCache.on("cleared", onObjectCacheCleared);
        server.objectCache = true;
    } else if (!on && objectCache) {
        objectCache.removeAllListeners();
        objectCache = undefined;
        server.objectCache = false;
    }
}

if (option("object-cache")) {
    setObjectCacheEnabled(true);
}

function removeBuilder(builder: Builder): void {
    --builderCount;
    assert(typeof builder.slots === "number");
    capacity -= builder.slots;
    delete builders[builderKey(builder)];

    if (monitors.length) {
        const info = builderToMonitorInfo(builder, "builderRemoved");
        if (monitorsLog) {
            console.log("send to monitors", info);
        }
        monitors.forEach((monitor) => {
            monitor.send(info);
        });
    }
}

interface EnvInfo {
    path: string;
    hash: string;
    size: number;
    created: number;
}

function purgeEnvironmentsToMaxSize() {
    return new Promise<boolean>((resolve: (val: boolean) => void) => {
        let max = option("max-environment-size");
        if (typeof max === "string") {
            max = bytes.parse(max);
        } else if (typeof max !== "number") {
            max = 0;
        }
        if (!max) {
            resolve(false);
            return;
        }

        let maxSize: number = max;

        const p = Environments.instance.path;
        try {
            let purged = false;
            fs.readdirSync(p)
                .map((file: string) => {
                    // console.log("got file", file);
                    const abs = path.join(p, file);
                    if (file.length !== 47 || file.indexOf(".tar.gz", 40) !== 40) {
                        try {
                            console.log("Removing unexpected file", abs);
                            fs.removeSync(abs);
                        } catch (err) {
                            console.error("Failed to remove file", abs, err);
                        }
                        return undefined;
                    }
                    let stat;
                    try {
                        stat = fs.statSync(abs);
                    } catch (err) {
                        return undefined;
                    }
                    return {
                        path: abs,
                        hash: file.substr(0, 40),
                        size: stat.size,
                        created: stat.birthtimeMs
                    };
                })
                .filter((x: EnvInfo | undefined) => x)
                .sort((a: EnvInfo | undefined, b: EnvInfo | undefined) => {
                    // console.log(`comparing ${a.path} ${a.created} to ${b.path} ${b.created}`);
                    return (b?.created || 0) - (a?.created || 0);
                })
                .forEach((env: EnvInfo | undefined) => {
                    if (!env) {
                        return;
                    }
                    if (maxSize >= env.size) {
                        maxSize -= env.size;
                        return;
                    }
                    purged = true;
                    Environments.instance.remove(env.hash);
                    console.log("Should purge env", env.hash, maxSize, env.size);
                });
            resolve(purged);
        } catch (err) {
            resolve(false);
        }
    });
}

function syncEnvironments(builder?: Builder) {
    if (!builder) {
        forEachBuilder(syncEnvironments);
        return;
    }
    const needs = [];
    const unwanted = [];
    console.log("scheduler has", Object.keys(Environments.instance.environments).sort());
    assert(builder.environments);
    assert(builder.system);
    console.log("builder has", builder.ip, Object.keys(builder.environments).sort());
    for (const env in Environments.instance.environments) {
        if (env in builder.environments) {
            builder.environments[env] = -1;
        } else if (Environments.instance.environments[env].canRun(builder.system)) {
            needs.push(env);
        }
    }
    for (const env in builder.environments) {
        if (builder.environments[env] !== -1) {
            unwanted.push(env);
            delete builder.environments[env];
        } else {
            builder.environments[env] = true;
        }
    }
    console.log("unwanted", unwanted);
    console.log("needs", needs);
    if (unwanted.length) {
        builder.send({ type: "dropEnvironments", environments: unwanted });
    }
    if (needs.length) {
        builder.send({ type: "getEnvironments", environments: needs });
    }
}

function environmentsInfo() {
    const ret: Record<string, unknown> = Object.assign({}, Environments.instance.environments);
    ret.maxSize = option("max-environment-size") || 0;
    const max = option("max-environment-size");
    ret.maxSizeBytes = max ? bytes.parse(String(max)) || 0 : 0;
    let usedSizeBytes = 0;
    for (const hash in Environments.instance.environments) {
        const env = Environments.instance.environments[hash];
        if (env.size) {
            usedSizeBytes += env.size;
        }
    }
    ret.usedSize = bytes.format(usedSizeBytes);
    ret.links = Environments.instance.linksInfo();
    ret.usedSizeBytes = usedSizeBytes;
    return ret;
}

server.on("listen", (app: express.Application) => {
    app.get("/environments", (req: express.Request, res: express.Response) => {
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(environmentsInfo(), null, pretty) + "\n");
    });

    app.get("/clear-log-files", (_: express.Request, res: express.Response) => {
        clearLogFiles();
        res.sendStatus(200);
    });

    app.get("/builders", (req: express.Request, res: express.Response) => {
        const ret = [];
        const now = Date.now();
        for (const builderKey in builders) {
            const s: Builder = builders[builderKey];
            ret.push({
                ip: s.ip,
                name: s.name,
                labels: s.labels,
                slots: s.slots,
                port: s.port,
                activeClients: s.activeClients,
                jobsScheduled: s.jobsScheduled,
                lastJob: s.lastJob ? new Date(s.lastJob).toString() : "",
                jobsPerformed: s.jobsPerformed,
                compileSpeed: s.jobsPerformed / s.totalCompileSpeed || 0,
                uploadSpeed: s.jobsPerformed / s.totalUploadSpeed || 0,
                hostname: s.hostname,
                system: s.system,
                created: s.created,
                load: s.load,
                uptime: now - s.created.valueOf(),
                npmVersion: s.npmVersion,
                environments: Object.keys(s.environments)
            });
        }
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(ret, null, pretty) + "\n");
    });

    app.get("/info", (req: express.Request, res: express.Response) => {
        const now = Date.now();
        const jobs = jobsFailed + jobsStarted + (objectCache ? objectCache.hits : 0);
        function percentage(count: number): unknown {
            return { count: count, percentage: (count ? (count * 100) / jobs : 0).toFixed(1) + "%" };
        }

        const obj = {
            builderCount: Object.keys(builders).length,
            npmVersion: schedulerNpmVersion,
            environments: environmentsInfo(),
            configVersion: common.Version,
            capacity: capacity,
            activeJobs: activeJobs,
            peaks: peakData(),
            jobsFailed: percentage(jobsFailed),
            jobsStarted: jobsStarted,
            jobs: jobs,
            jobsScheduled: jobsScheduled,
            jobsFinished: percentage(jobsFinished),
            cacheHits: percentage(objectCache ? objectCache.hits : 0),
            uptimeMS: now - serverStartTime,
            uptime: humanizeDuration(now - serverStartTime),
            serverStartTime: new Date(serverStartTime).toString()
        };
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(obj, null, pretty) + "\n");
    });

    app.get("/objectcache", (req: express.Request, res: express.Response) => {
        if ("on" in req.query) {
            if (option("object-cache")) {
                setObjectCacheEnabled(true);
                res.sendStatus(200);
            } else {
                res.sendStatus(400);
            }
            return;
        }

        if ("off" in req.query) {
            setObjectCacheEnabled(false);
            res.sendStatus(200);
            return;
        }

        if (!objectCache) {
            res.sendStatus(404);
            return;
        }

        if (req.query && "clear" in req.query) {
            objectCache.clear();
            res.sendStatus(200);
        } else if (req.query && "distribute" in req.query) {
            objectCache.distribute(req.query, res);
            res.sendStatus(200);
        } else {
            const pretty = req.query && req.query.unpretty ? undefined : 4;
            res.send(JSON.stringify(objectCache.dump(req.query || {}), null, pretty) + "\n");
        }
    });

    app.get("/quit-builders", (req, res) => {
        res.sendStatus(200);
        const msg = {
            type: "quit",
            code: req.query.code || 0,
            purgeEnvironments: "purge_environments" in req.query
        };
        console.log("Sending quit message to builders", msg, Object.keys(builders));
        for (const ip in builders) {
            builders[ip].send(msg);
        }
    });

    app.get("/environment/*", function (req, res) {
        const hash = req.path.substr(13);
        const env = Environments.instance.environment(hash);
        console.log("got env request", hash, env);
        if (!env) {
            res.sendStatus(404);
            return;
        }

        const rstream = fs.createReadStream(env.path);
        rstream.on("error", (err) => {
            console.error("Got read stream error for", env.path, err);
            rstream.close();
        });
        rstream.pipe(res);
    });

    app.get("/quit", (req, res) => {
        console.log("quitting", req.query);
        if ("purge_environments" in req.query) {
            try {
                fs.removeSync(path.join(common.cacheDir(), "environments"));
            } catch (err) {
                /* */
            }
        }
        res.sendStatus(200);
        setTimeout(() => process.exit(), 100);
    });
});

function updateLogFilesToMonitors() {
    if (monitors.length) {
        fs.readdir(logFileDir, (err, files) => {
            if (files) {
                files = files.reverse();
            }
            const msg = { type: "logFiles", files: files || [] };
            // console.log("sending files", msg);
            monitors.forEach((monitor) => monitor.send(msg));
        });
    }
}

function clearLogFiles() {
    fs.readdir(logFileDir, (err, files) => {
        if (err) {
            console.log("Got error removing log files", err);
            return;
        }

        for (const file of files) {
            fs.unlink(path.join(logFileDir, file), (err) => {
                if (err) {
                    console.log("failed to remove file", path.join(logFileDir, file), err);
                }
            });
        }
        updateLogFilesToMonitors();
    });
}

try {
    fs.watch(logFileDir, (type: string) => {
        if (type === "rename") {
            updateLogFilesToMonitors();
        }
    });
} catch (err) {
    /* */
}

function formatDate(date: Date): string {
    const year = date.getFullYear();
    let month: string | number = date.getMonth() + 1; // months are zero indexed
    let day: string | number = date.getDate();
    let hour: string | number = date.getHours();
    let minute: string | number = date.getMinutes();
    let second: string | number = date.getSeconds();

    if (month < 10) {
        month = "0" + month;
    }
    if (day < 10) {
        day = "0" + day;
    }
    if (hour < 10) {
        hour = "0" + hour;
    }
    if (minute < 10) {
        minute = "0" + minute;
    }
    if (second < 10) {
        second = "0" + second;
    }
    return `${year}_${month}_${day}_${hour}:${minute}:${second}`;
}

interface LogEntry {
    source: string;
    ip: string;
    contents: string;
}

function addLogFile(log: LogEntry): void {
    try {
        fs.writeFileSync(path.join(logFileDir, `${formatDate(new Date())} ${log.source} ${log.ip}`), log.contents);
    } catch (err) {
        console.error(`Failed to write log file from ${log.ip}`, err);
    }
}

server.on("builder", (builder: Builder) => {
    if (compareVersions(schedulerNpmVersion, builder.npmVersion) >= 1) {
        console.log(
            `builder ${builder.ip} has bad npm version: ${builder.npmVersion} should have been at least: ${schedulerNpmVersion}`
        );
        builder.send({ type: "version_mismatch", required_version: schedulerNpmVersion, code: 1 });
        return;
    }
    builder.activeClients = 0;
    insertBuilder(builder);
    console.log(
        "builder connected",
        builder.npmVersion,
        builder.ip,
        builder.name || "",
        builder.hostname || "",
        Object.keys(builder.environments),
        "builderCount is",
        builderCount
    );
    syncEnvironments(builder);

    builder.on("environments", (message: { environments: string[] }) => {
        builder.environments = {};
        message.environments.forEach((env: string) => (builder.environments[env] = true));
        syncEnvironments(builder);
    });

    builder.on("log", (event) => {
        addLogFile({ source: "builder", ip: builder.ip, contents: event.message });
    });

    builder.on("error", (msg) => {
        console.error(`builder error '${msg}' from ${builder.ip}`);
    });

    builder.on("objectCache", (msg) => {
        if (objectCache) {
            objectCache.addNode(builder, msg);
        }
    });

    builder.on("objectCacheAdded", (msg) => {
        if (objectCache) {
            objectCache.insert(msg, builder);
        }
    });

    builder.on("objectCacheRemoved", (msg) => {
        if (objectCache) {
            objectCache.remove(msg, builder);
        }
    });

    builder.on("close", () => {
        removeBuilder(builder);
        if (objectCache) {
            objectCache.removeNode(builder);
        }
        console.log(
            `builder disconnected ${builder.ip}:${builder.port} ${builder.name} ${builder.hostname} builderCount is ${builderCount}`
        );
        builder.removeAllListeners();
    });

    builder.on("load", (message) => {
        builder.load = message.measure;
        // console.log(message);
    });

    builder.on("jobStarted", (job) => {
        ++jobsStarted;
        jobStartedOrScheduled("jobStarted", job);
    });
    builder.on("jobFinished", (job) => jobFinished(builder, job));
    builder.on("cacheHit", (job) => cacheHit(builder, job));

    builder.on("jobAborted", (job) => {
        console.log(`builder: ${builder.ip}:${builder.port} aborted a job`, job);
        if (monitors.length) {
            const info = {
                type: "jobAborted",
                id: job.id
            };

            monitors.forEach((monitor) => monitor.send(info));
        }
    });
});

const pendingEnvironments: Record<string, boolean> = {};
function requestEnvironment(compile: Compile) {
    if (compile.environment in pendingEnvironments) {
        return false;
    }
    pendingEnvironments[compile.environment] = true;

    console.log(`Asking ${compile.name} ${compile.ip} to upload ${compile.environment}`);
    compile.send({ type: "needsEnvironment" });

    let file: File | undefined;
    let gotLast = false;
    compile.on("uploadEnvironment", (environment) => {
        file = Environments.instance.prepare(environment);
        console.log("Got environment message", environment, typeof file);
        if (!file) {
            // we already have this environment
            console.error("already got environment", environment.message);
            compile.send({ error: "already got environment" });
            compile.close();
            return;
        }
        const hash = environment.hash;
        compile.on("uploadEnvironmentData", (environment) => {
            if (!file) {
                console.error("no pending file");
                compile.send({ error: "no pending file" });
                compile.close();
                return;
            }
            if (environment.last) {
                gotLast = true;
                console.log("Got environmentdata message", environment.data.length, environment.last);
            }
            file.save(environment.data)
                .then(() => {
                    if (environment.last) {
                        assert(file);
                        file.close();
                        compile.close();
                        return Environments.instance.complete(file);
                    }
                    return undefined;
                })
                .then(() => {
                    if (environment.last) {
                        file = undefined;
                        // send any new environments to builders
                        delete pendingEnvironments[hash];
                        return purgeEnvironmentsToMaxSize();
                    }
                    return undefined;
                })
                .then(() => {
                    if (environment.last) {
                        syncEnvironments();
                    }
                })
                .catch((error) => {
                    console.error("Got some error here", error);
                    file = undefined;
                });
        });
    });
    compile.on("error", (msg) => {
        console.error(`upload error '${msg}' from ${compile.ip}`);
        if (file) {
            file.discard();
            file = undefined;
        }
        delete pendingEnvironments[compile.environment];
    });
    compile.once("close", () => {
        if (file && !gotLast) {
            console.log("compile with upload closed", compile.environment, "discarding");
            file.discard();
            file = undefined;
        }
        delete pendingEnvironments[compile.environment];
    });
    return true;
}

server.on("clientVerify", (clientVerify: Client) => {
    if (compareVersions(clientMinimumVersion, clientVerify.npmVersion) >= 1) {
        clientVerify.send("version_mismatch", { minimum_version: `${clientMinimumVersion}` });
    } else {
        clientVerify.send("version_verified", { minimum_version: `${clientMinimumVersion}` });
    }
});

server.on("compile", (compile: Compile) => {
    compile.on("log", (event: { message: string }) => {
        addLogFile({ source: "client", ip: compile.ip, contents: event.message });
    });

    if (compareVersions(clientMinimumVersion, compile.npmVersion) >= 1) {
        ++jobsFailed;
        compile.send("version_mismatch", { minimum_version: `${clientMinimumVersion}` });
        return;
    }

    // console.log("request", compile.hostname, compile.ip, compile.environment);
    const usableEnvs = Environments.instance.compatibleEnvironments(compile.environment);
    if (!Environments.instance.hasEnvironment(compile.environment) && requestEnvironment(compile)) {
        ++jobsFailed;
        return;
    }
    // console.log("compatible environments", usableEnvs);

    if (!usableEnvs.length) {
        console.log(`We're already waiting for ${compile.environment} and we don't have any compatible ones`);
        compile.send("builder", {});
        ++jobsFailed;
        return;
    }

    function score(s: Builder) {
        const available = Math.min(4, s.slots - s.activeClients);
        return available * (1 - s.load);
    }
    let builder: undefined | Builder;
    let bestScore = Number.MIN_SAFE_INTEGER;
    let env: undefined | string;
    // console.log("got usableEnvs", usableEnvs);
    // ### should have a function match(s) that checks for env, score and compile.builder etc
    let foundInCache = false;

    function filterBuilder(s: Builder) {
        if (compile.builder && compile.builder !== s.ip && compile.builder !== s.name) {
            return false;
        }

        if (compile.labels) {
            for (let i = 0; i < compile.labels.length; ++i) {
                if (!s.labels || s.labels.indexOf(compile.labels[i]) === -1) {
                    return false;
                }
            }
        }
        return true;
    }

    if (objectCache && compile.sha1) {
        const data = objectCache.get(compile.sha1);
        if (data) {
            data.nodes.forEach((s) => {
                if (!filterBuilder(s)) {
                    return;
                }
                const builderScore = score(s);
                if (
                    !builder ||
                    builderScore > bestScore ||
                    (builderScore === bestScore && builder.lastJob < s.lastJob)
                ) {
                    bestScore = builderScore;
                    builder = s;
                    foundInCache = true;
                }
            });
        }
    }
    if (!builder) {
        forEachBuilder((s) => {
            if (!filterBuilder(s)) {
                return;
            }

            for (let i = 0; i < usableEnvs.length; ++i) {
                // console.log("checking builder", s.name, s.environments);
                if (usableEnvs[i] in s.environments) {
                    const builderScore = score(s);
                    // console.log("comparing", builderScore, bestScore);
                    if (
                        !builder ||
                        builderScore > bestScore ||
                        (builderScore === bestScore && s.lastJob < builder.lastJob)
                    ) {
                        bestScore = builderScore;
                        builder = s;
                        env = usableEnvs[i];
                        break;
                    }
                }
            }
        });
    }
    if (!builder) {
        if (compile.builder) {
            ++jobsFailed;
            console.log(
                `Specific builder "${compile.builder}" was requested and we couldn't find a builder with that ${compile.environment}`
            );
            compile.send("builder", {});
            return;
        }

        if (compile.labels) {
            ++jobsFailed;
            console.log(
                `Specific labels "${compile.labels}" were specified we couldn't match ${compile.environment} with any builder with those labels`
            );
            compile.send("builder", {});
            return;
        }
        ++jobsFailed;
        console.log("No builder for you", compile.ip);
        compile.send("builder", {});
        return;
    }

    const data: Record<string, string | string[] | undefined | number> = {};
    if (env && env !== compile.environment) {
        data.environment = env;
        data.extraArgs = Environments.instance.extraArgs(compile.environment, env);
    }
    ++activeJobs;
    const utilization = activeJobs / capacity;
    let peakInfo = false;
    const now = Date.now();
    peaks.forEach((peak) => {
        if (peak.record(now, activeJobs, utilization)) {
            peakInfo = true;
        }
    });
    if (peakInfo && monitors.length) {
        const info = statsMessage();
        monitors.forEach((monitor) => monitor.send(info));
    }
    ++builder.activeClients;
    ++builder.jobsScheduled;
    console.log(
        `${compile.name} ${compile.ip} ${compile.sourceFile} was assigned to builder ${builder.ip} ${builder.port} ${builder.name} score: ${bestScore} objectCache: ${foundInCache}. ` +
            `Builder has ${builder.activeClients} and performed ${builder.jobsScheduled} jobs. Total active jobs is ${activeJobs}`
    );
    builder.lastJob = Date.now();
    const id = nextJobId();
    data.id = id;
    data.ip = builder.ip;
    data.hostname = builder.hostname;
    data.port = builder.port;
    compile.send("builder", data);
    jobStartedOrScheduled("jobScheduled", {
        client: {
            name: compile.name,
            hostname: compile.hostname,
            ip: compile.ip,
            user: compile.user,
            labels: compile.labels
        },
        builder: {
            name: builder.name,
            hostname: builder.hostname,
            ip: builder.ip,
            user: builder.user,
            port: builder.port
        },
        id: id,
        sourceFile: compile.sourceFile
    });
    ++jobsScheduled;
    compile.on("error", (msg) => {
        if (builder) {
            --builder.activeClients;
            --activeJobs;
            builder = undefined;
        }
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", () => {
        // console.log("Client disappeared");
        compile.removeAllListeners();
        if (builder) {
            --builder.activeClients;
            --activeJobs;
            builder = undefined;
        }
    });
});

function writeConfiguration(change: unknown): void {
    console.log(writeConfiguration, change);
}

function hash(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 12000, 256, "sha512", (err: Error | null, hash: Buffer) => {
            if (err) {
                reject(err);
            } else {
                resolve(hash);
            }
        });
    });
}

function randomBytes(bytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(bytes, (err: Error | null, result: Buffer) => {
            if (err) {
                reject(new Error(`Failed to random bytes ${err}`));
            } else {
                resolve(result);
            }
        });
    });
}

function sendInfoToClient(client: Client): void {
    forEachBuilder((builder) => {
        const info = builderToMonitorInfo(builder, "builderAdded");
        if (monitorsLog) {
            console.log("sending to monitor", info);
        }
        client.send(info);
    });
    const info = statsMessage();
    if (monitorsLog) {
        console.log("sending info to monitor", info);
    }

    client.send(info);

    const scheduler = { version: schedulerNpmVersion, type: "schedulerInfo" };
    client.send(scheduler);
}

interface User {
    cookie: string;
    cookieIp: string;
    cookieExpiration: number;
    salt: string;
    hash: string;
}

server.on("monitor", (client: Client) => {
    if (monitorsLog) {
        console.log("Got monitor", client.ip, client.hostname);
    }
    monitors.push(client);
    function remove() {
        const idx = monitors.indexOf(client);
        if (idx !== -1) {
            monitors.splice(idx, 1);
        }
        client.removeAllListeners();
    }
    let user: string | undefined;
    client.on("message", (messageText) => {
        if (monitorsLog) {
            console.log("Got message from monitor", client.ip, client.hostname, messageText);
        }
        let message: MonitorMessage;
        try {
            message = JSON.parse(messageText);
        } catch (err) {
            console.error(`Bad json message from monitor ${err.message}`);
            client.send({ success: false, error: `Bad message won't parse as JSON: ${err}` });
            client.close();
            return;
        }
        switch (message.type) {
            case "sendInfo":
                sendInfoToClient(client);
                break;
            case "clearLogFiles":
                clearLogFiles();
                updateLogFilesToMonitors();
                break;
            case "logFiles":
                // console.log("logFiles:", message);
                fs.readdir(logFileDir, (err, files) => {
                    if (files) {
                        files = files.reverse();
                    }
                    console.log("sending files", files);
                    client.send({ type: "logFiles", files: files || [] });
                });
                break;
            case "logFile": {
                // console.log("logFile:", message);
                if (!message.file || message.file.indexOf("../") !== -1 || message.file.indexOf("/..") !== -1) {
                    client.close();
                    return;
                }
                const f = path.join(logFileDir, message.file);
                fs.readFile(f, "utf8", (err, contents) => {
                    // console.log("sending file", f, contents.length);
                    client.send({ type: "logFile", file: f, contents: contents || "" });
                });
                break;
            }
            case "readConfiguration":
                break;
            case "writeConfiguration":
                if (!user) {
                    client.send({
                        type: "writeConfiguration",
                        success: false,
                        error: `Unauthenticated message: ${message.type}`
                    });
                    return;
                }
                writeConfiguration(message);
                break;
            case "listEnvironments":
                client.send({ type: "listEnvironments", environments: environmentsInfo() });
                break;
            case "linkEnvironments":
                Environments.instance
                    .link(
                        message.srcHash ?? "",
                        message.targetHash ?? "",
                        message.arguments ?? [],
                        message.blacklist ?? []
                    )
                    .then(() => {
                        const info = { type: "listEnvironments", environments: environmentsInfo() };
                        monitors.forEach((monitor) => monitor.send(info));
                    });
                break;
            case "unlinkEnvironments":
                Environments.instance.unlink(message.srcHash, message.targetHash).then(() => {
                    const info = { type: "listEnvironments", environments: environmentsInfo() };
                    monitors.forEach((monitor) => monitor.send(info));
                });
                break;
            case "listUsers": {
                if (!user) {
                    client.send({
                        type: "listUsers",
                        success: false,
                        error: `Unauthenticated message: ${message.type}`
                    });
                    return;
                }
                db.get("users")
                    .then((users) => {
                        if (!users) {
                            users = {};
                        }
                        client.send({ type: "listUsers", success: true, users: Object.keys(users) });
                    })
                    .catch((err) => {
                        console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                        client.send({ type: "listUsers", success: false, error: err.toString() });
                    });
                break;
            }
            case "removeUser": {
                if (!user) {
                    client.send({
                        type: "removeUser",
                        success: false,
                        error: `Unauthenticated message: ${message.type}`
                    });
                    return;
                }
                if (!message.user) {
                    client.send({ type: "removeUser", success: false, error: "Bad removeUser message" });
                    return;
                }

                if (pendingUsers[message.user]) {
                    client.send({ type: "removeUser", success: false, error: "Someone's here already" });
                    return;
                }
                pendingUsers[message.user] = true;
                db.get("users")
                    .then((users?: Record<string, unknown>) => {
                        if (!users || !message.user || !users[message.user]) {
                            throw new Error(`user ${message.user} doesn't exist`);
                        }
                        delete users[message.user];
                        return db.set("users", users);
                    })
                    .then(() => {
                        client.send({ type: "removeUser", success: true, user: message.user });
                    })
                    .catch((err) => {
                        console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                        client.send({ type: "removeUser", success: false, error: err.toString() });
                    })
                    .finally(() => {
                        if (message.user) {
                            delete pendingUsers[message.user];
                        }
                    });

                // console.log("gotta remove user", message);
                break;
            }
            case "login": {
                user = undefined;
                if (!message.user || (!message.password && !message.hmac)) {
                    client.send({ type: "login", success: false, error: "Bad login message" });
                    return;
                }
                let users: Record<string, User> = {};
                db.get("users")
                    .then((u: Record<string, unknown> | undefined) => {
                        users = u as Record<string, User>;
                        if (!users || !message.user || !users[message.user]) {
                            throw new Error(`User: ${message.user} does not seem to exist`);
                        }
                        if (message.hmac) {
                            if (!users[message.user].cookie) {
                                throw new Error("No cookie");
                            } else if (users[message.user].cookieIp !== client.ip) {
                                throw new Error("Wrong ip address");
                            } else if (users[message.user].cookieExpiration || 0 <= Date.now()) {
                                throw new Error("Cookie expired");
                            } else {
                                const hmac = crypto.createHmac(
                                    "sha512",
                                    Buffer.from(users[message.user].cookie, "base64")
                                );
                                hmac.write(client.nonce);
                                hmac.end();
                                const hmacString = hmac.read().toString("base64");
                                if (hmacString !== message.hmac) {
                                    throw new Error(`Wrong password ${message.user}`);
                                }
                                return undefined;
                            }
                        } else {
                            return hash(message.password || "", Buffer.from(users[message.user].salt, "base64")).then(
                                (hash) => {
                                    if (users[message.user || ""]?.hash !== hash.toString("base64")) {
                                        throw new Error(`Wrong password ${message.user}`);
                                    }
                                }
                            );
                        }
                    })
                    .then(() => {
                        return randomBytes(256);
                    })
                    .then((cookie) => {
                        user = message.user;
                        const expiration = new Date(Date.now() + 12096e5);
                        users[message.user || ""].cookie = cookie.toString("base64");
                        users[message.user || ""].cookieIp = client.ip;
                        users[message.user || ""].cookieExpiration = expiration.valueOf();
                        return db.set("users", users);
                    })
                    .then(() => {
                        client.send({
                            type: "login",
                            success: true,
                            user: message.user,
                            cookie: users[message.user || ""].cookie
                        });
                    })
                    .catch((err) => {
                        console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                        client.send({ type: "login", success: false, error: err.toString() });
                    });
                break;
            }
            case "addUser": {
                if (!message.user || !message.password) {
                    client.send({ type: "addUser", success: false, error: "Bad addUser message" });
                    return;
                }
                if (pendingUsers[message.user]) {
                    client.send({ type: "addUser", success: false, error: "Someone's here already" });
                    return;
                }
                pendingUsers[message.user] = true;
                let users: Record<string, User> = {};
                db.get("users")
                    .then((u: Record<string, unknown> | undefined) => {
                        users = (u as Record<string, User>) || {};
                        if (users[message.user || ""]) {
                            throw new Error(`user ${message.user} already exists`);
                        }
                        return randomBytes(256);
                    })
                    .then((salt: Buffer) => {
                        users[message.user || ""] = {
                            cookieIp: "",
                            salt: salt.toString("base64"),
                            cookie: "",
                            cookieExpiration: 0,
                            hash: ""
                        };
                        return hash(message.password || "", salt);
                    })
                    .then((hash) => {
                        users[message.user || ""].hash = hash.toString("base64");
                        return randomBytes(256);
                    })
                    .then((cookie) => {
                        users[message.user || ""].cookie = cookie.toString("base64");
                        users[message.user || ""].cookieExpiration = Date.now() + 12096e5;
                        users[message.user || ""].cookieIp = client.ip;
                        return db.set("users", users);
                    })
                    .then(() => {
                        // console.log("here", values);
                        // values = [1,2];
                        client.send({
                            type: "addUser",
                            success: true,
                            user: message.user,
                            cookie: users[message.user || ""].cookie
                        });
                    })
                    .catch((err) => {
                        console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                        client.send({ type: "addUser", success: false, error: err.toString() });
                    })
                    .finally(() => {
                        delete pendingUsers[message.user || ""];
                    });

                // console.log("gotta add user", message);
                break;
            }
        }
    });
    client.on("close", remove);
    client.on("error", remove);
});

server.on("error", (err) => {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.instance
    .load(db, String(option("env-dir", path.join(common.cacheDir(), "environments"))))
    .then(() => {
        const limit = option.int("max-file-descriptors");
        if (limit) {
            console.log("setting limit", limit);
            posix.setrlimit("nofile", { soft: limit });
        }
    })
    .then(purgeEnvironmentsToMaxSize)
    // .then(() => {
    //     return db.get("users");
    // }).then(u => {
    //     console.log("got users", u);
    //     users = u || {};
    // })
    .then(() => server.listen())
    .then(() => {
        setInterval(() => {
            // console.log("sending pings");
            for (const key in builders) {
                const builder = builders[key];
                builder.ping();
            }
        }, option.int("ping-interval", 20000));
    })
    .catch((e) => {
        console.error(e);
        process.exit();
    });
