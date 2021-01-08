#!/usr/bin/env node

const path = require('path');
const os = require('os');
const option = require('@jhanssen/options')({ prefix: 'fisk/scheduler',
                                              applicationPath: false,
                                              additionalFiles: [ "fisk/scheduler.conf.override" ] });
const posix = require('posix');
const Server = require('./server');
const common = require('../common')(option);
const Environments = require('./environments');
const server = new Server(option, common.Version);
const fs = require('fs-extra');
const bytes = require('bytes');
const crypto = require('crypto');
const Database = require('./database');
const Peak = require('./peak');
const ObjectCacheManager = require('./objectcachemanager');
const compareVersions = require('compare-versions');
const humanizeDuration = require('humanize-duration');
const wol = require('wake_on_lan');
let wolBuilders = {};
(option("wake-on-lan-builders") || []).forEach(builder => {
    if (!builder.name || !builder.mac) {
        console.error("Bad wol, missing name or mac address");
    } else if (builder.name in wolBuilders) {
        console.error(`Duplicate name for wol-builder ${JSON.stringify(builder)}`);
    } else {
        wolBuilders[builder.name] = { mac: builder.mac, connected: false, address: builder.address || "255.255.255.255" };
    }
});

const clientMinimumVersion = "3.1.39";
const serverStartTime = Date.now();
process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    addLogFile({ source: "no source file", ip: "self", contents: `reason: ${reason.stack} p: ${p}\n` }, () => {
        process.exit();
    });
});

process.on('uncaughtException', err => {
    console.error("Uncaught exception", err);
    addLogFile({ source: "no source file", ip: "self", contents: err.toString() + err.stack + "\n" }, () => {
        process.exit();
    });
});

const monitorsLog = option("monitor-log");

server.on("error", error => {
    throw new error;
});

let schedulerNpmVersion;
try {
    schedulerNpmVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).version;
} catch (err) {
    console.log("Couldn't parse package json", err);
    process.exit();
}

const builders = {};
let lastWol = 0;
function sendWols()
{
    const now = Date.now();
    // console.log("sendWols", now, lastWol, now - lastWol);
    if (now - lastWol < 60000)
        return;

    lastWol = now;
    let byName;
    for (let name in wolBuilders) {
        const wolBuilder = wolBuilders[name];
        if (wolBuilder.connected)
            continue;
        if (!byName) {
            byName = {};
            for (let key in builders) {
                const builder = builders[key];
                if (builder.name)
                    byName[builder.name] = builder;
            }
        }
        if (!(name in byName)) {
            wol.wake(wolBuilder.mac, error => {
                console.log("sending wol", JSON.stringify(wolBuilder));
                if (error) {
                    console.error(`Failed to wol builder: ${JSON.stringify(wolBuilder)}: ${error}`);
                }
            });
        } else {
            console.log(wolBuilder, "is already connected");
        }
    }
}

const monitors = [];
let builderCount = 0;
let activeJobs = 0;
let capacity = 0;
let jobsFailed = 0;
let jobsStarted = 0;
let jobsScheduled = 0;
let jobsFinished = 0;
let jobId = 0;
const db = new Database(path.join(common.cacheDir(), "db.json"));
let objectCache;
const logFileDir = path.join(common.cacheDir(), "logs");
try {
    fs.mkdirSync(logFileDir);
} catch (err) {
}

const peaks = [
    new Peak(60 * 60 * 1000, "Last hour"),
    new Peak(24 * 60 * 60 * 1000, "Last 24 hours"),
    new Peak(7 * 24 * 60 * 60 * 1000, "Last 7 days"),
    new Peak(30 * 24 * 60 * 60 * 1000, "Last 30 days"),
    new Peak(undefined, "Forever")
];

function peakData()
{
    let ret = {};
    peaks.forEach(peak => ret[peak.name] = peak.toObject());
    return ret;
}

function statsMessage()
{
    let info = peakData();
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

const pendingUsers = {};

function nextJobId()
{
    let id = ++jobId;
    if (id == 2147483647)
        id = 1;
    return id;
}

function jobStartedOrScheduled(type, job)
{
    if (monitors.length) {
        // console.log("GOT STUFF", job);
        let info = {
            type: type,
            client: {
                hostname: job.client.hostname,
                ip: job.client.ip,
                name: job.client.name,
                user: job.client.user
            },
            sourceFile: job.sourceFile,
            builder: {
                ip: job.builder.ip,
                name: job.builder.name,
                port: job.builder.port
            },
            id: job.id
        };
        if (job.builder.hostname)
            info.builder.hostname = job.builder.hostname;

        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => monitor.send(info));
    }
}

function cacheHit(builder, job)
{
    if (objectCache)
        objectCache.hit(job.md5);
    if (monitors.length) {
        let info = {
            type: "cacheHit",
            client: {
                hostname: job.client.hostname,
                ip: job.client.ip,
                name: job.client.name,
                user: job.client.user
            },
            sourceFile: job.sourceFile,
            builder: {
                ip: builder.ip,
                name: builder.name,
                port: builder.port
            },
            id: job.id,
            jobs: (objectCache ? objectCache.hits : 0) + jobsFailed + jobsFinished,
            jobsFailed: jobsFailed,
            jobsStarted: jobsStarted,
            jobsFinished: jobsFinished,
            jobsScheduled: jobsScheduled,
            cacheHits: objectCache ? objectCache.hits : 0
        };
        if (builder.hostname)
            info.builder.hostname = builder.hostname;
        if (monitorsLog)
            console.log("send to monitors", info);
        // console.log("sending info", info);
        monitors.forEach(monitor => monitor.send(info));
    }
}

function jobFinished(builder, job)
{
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
        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => monitor.send(info));
    }
}

function builderKey() {
    if (arguments.length == 1) {
        return arguments[0].ip + " " + arguments[0].port;
    } else {
        return arguments[0] + " " + arguments[1];
    }
}

function builderToMonitorInfo(builder, type)
{
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
        created: builder.created,
        npmVersion: builder.npmVersion,
        environments: Object.keys(builder.environments)
    };
}

function insertBuilder(builder) {
    builders[builderKey(builder)] = builder;
    if (builder.name && builder.name in wolBuilders) {
        wolBuilders[builder.name].connected = true;
    }
    ++builderCount;
    capacity += builder.slots;
    if (monitors.length) {
        const info = builderToMonitorInfo(builder, "builderAdded");
        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => {
            monitor.send(info);
        });
    }
}

function forEachBuilder(cb) {
    for (let key in builders) {
        cb(builders[key]);
    }
}

if (option('object-cache')) {
    objectCache = new ObjectCacheManager(option);
    objectCache.on("cleared", () => {
        jobsFailed = 0;
        jobsStarted = 0;
        jobsScheduled = 0;
        jobsFinished = 0;
        const msg = { type: "clearObjectCache" };
        forEachBuilder(builder => builder.send(msg));
        let info = statsMessage();
        monitors.forEach(monitor => monitor.send(info));
    });
}

function removeBuilder(builder) {
    --builderCount;
    capacity -= builder.slots;
    delete builders[builderKey(builder)];
    if (builder.name && builder.name in wolBuilders) {
        lastWol = 0; // lets recussitate him right away!
        wolBuilders[builder.name].connected = false;
    }

    if (monitors.length) {
        const info = builderToMonitorInfo(builder, "builderRemoved");
        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => {
            monitor.send(info);
        });
    }

}

function purgeEnvironmentsToMaxSize()
{
    return new Promise((resolve, reject) => {
        let maxSize = bytes.parse(option("max-environment-size"));
        if (!maxSize) {
            resolve(false);
            return;
        }
        const p = Environments._path;
        try {
            let purged = false;
            fs.readdirSync(p).map(file => {
                // console.log("got file", file);
                const abs = path.join(p, file);
                if (file.length != 47 || file.indexOf(".tar.gz", 40) != 40) {
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
            }).sort((a, b) => {
                // console.log(`comparing ${a.path} ${a.created} to ${b.path} ${b.created}`);
                return b.created - a.created;
            }).forEach(env => {
                if (!env)
                    return;
                if (maxSize >= env.size) {
                    maxSize -= env.size;
                    return;
                }
                purged = true;
                Environments.remove(env.hash);
                console.log("Should purge env", env.hash, maxSize, env.size);
            });
            resolve(purged);
        } catch (err) {
            resolve(false);
            return;
        }
    });
}

function syncEnvironments(builder)
{
    if (!builder) {
        forEachBuilder(syncEnvironments);
        return;
    }
    let needs = [];
    let unwanted = [];
    console.log("scheduler has", Object.keys(Environments.environments).sort());
    console.log("builder has", builder.ip, Object.keys(builder.environments).sort());
    for (let env in Environments.environments) {
        if (env in builder.environments) {
            builder.environments[env] = -1;
        } else if (Environments.environments[env].canRun(builder.system)) {
            needs.push(env);
        }
    }
    for (let env in builder.environments) {
        if (builder.environments[env] != -1) {
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

function environmentsInfo()
{
    let ret = Object.assign({}, Environments.environments);
    ret.maxSize = option("max-environment-size") || 0;
    ret.maxSizeBytes = bytes.parse(option("max-environment-size")) || 0;
    ret.usedSizeBytes = 0;
    for (let hash in Environments.environments) {
        let env = Environments.environments[hash];
        if (env.size)
            ret.usedSizeBytes += env.size;
    }
    ret.usedSize = bytes.format(ret.usedSizeBytes);
    ret.links = Environments.linksInfo();
    return ret;
}

server.on("listen", app => {
    app.get("/environments", (req, res, next) => {
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(environmentsInfo(), null, pretty) + "\n");
    });

    app.get("/clear-log-files", (req, res, next) => {
        clearLogFiles();
        res.sendStatus(200);
    });

    app.get("/builders", (req, res, next) => {
        let ret = [];
        const now = Date.now();
        for (let builderKey in builders) {
            let s = builders[builderKey];
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
                name: s.name,
                created: s.created,
                load: s.load,
                uptime: now - s.created.valueOf(),
                npmVersion: s.npmVersion,
                environments: Object.keys(s.environments),
            });
        }
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(ret, null, pretty) + "\n");
    });

    app.get("/info", (req, res, next) => {
        const now = Date.now();
        const jobs = jobsFailed + jobsStarted + (objectCache ? objectCache.hits : 0);
        function percentage(count)
        {
            return { count: count, percentage: (count ? count * 100 / jobs : 0).toFixed(1) + "%" };
        }

        let obj = {
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
            serverStartTime: new Date(serverStartTime).toString(),
            wolBuilders: wolBuilders
        };
        const pretty = req.query && req.query.unpretty ? undefined : 4;
        res.send(JSON.stringify(obj, null, pretty) + "\n");
    });

    app.get("/objectcache", (req, res) => {
        if (!objectCache) {
            res.sendStatus(404);
            return;
        }

        if (req.query && "clear" in req.query) {
            objectCache.clear();
            res.sendStatus(200);
        } else if (req.query && "distribute" in req.query) {
            objectCache.distribute(req.query, res);
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
        for (let ip in builders) {
            builders[ip].send(msg);
        }
    });

    app.get('/environment/*', function(req, res) {
        const hash = req.path.substr(13);
        const env = Environments.environment(hash);
        console.log("got env request", hash, env);
        if (!env) {
            res.sendStatus(404);
            return;
        }

        const rstream = fs.createReadStream(env.path);
        rstream.on("error", err => {
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
            }
        }
        res.sendStatus(200);
        setTimeout(() => process.exit(), 100);
    });
});

function updateLogFilesToMonitors()
{
    if (monitors.length) {
        fs.readdir(logFileDir, (err, files) => {
            if (files)
                files = files.reverse();
            const msg = { type: "logFiles", files: files || [] };
            // console.log("sending files", msg);
            monitors.forEach(monitor => monitor.send(msg));
        });
    }
}

function clearLogFiles()
{
    fs.readdir(logFileDir, (err, files) => {
        if (err) {
            console.log("Got error removing log files", err);
            return;
        }

        for (const file of files) {
            fs.unlink(path.join(logFileDir, file), err => {
                if (err)
                    console.log("failed to remove file", path.join(logFileDir, file), err);
            });
        }
        updateLogFilesToMonitors();
    });
}

try {
    fs.watch(logFileDir, (type, filename) => {
        if (type == "rename") {
            updateLogFilesToMonitors();
        }
    });
} catch (err) {
}

function formatDate(date)
{
    let year = date.getFullYear(),
        month = date.getMonth() + 1, // months are zero indexed
        day = date.getDate(),
        hour = date.getHours(),
        minute = date.getMinutes(),
        second = date.getSeconds();

    if (month < 10)
        month = '0' + month;
    if (day < 10)
        day = '0' + day;
    if (hour < 10)
        hour = '0' + hour;
    if (minute < 10)
        minute = "0" + minute;
    if (second < 10)
        second = "0" + second;
    return `${year}_${month}_${day}_${hour}:${minute}:${second}`;
}

function addLogFile(log, cb) {
    try {
        fs.writeFileSync(path.join(logFileDir, `${formatDate(new Date())} ${log.source} ${log.ip}`), log.contents, cb);
    } catch (err) {
        console.error(`Failed to write log file from ${log.ip}`, err);
    }
}

server.on("builder", builder => {
    if (compareVersions(schedulerNpmVersion, builder.npmVersion) >= 1) {
        console.log(`builder ${builder.ip} has bad npm version: ${builder.npmVersion} should have been at least: ${schedulerNpmVersion}`);
        builder.send({ type: "version_mismatch", required_version: schedulerNpmVersion, code: 1 });
        return;
    }
    builder.activeClients = 0;
    insertBuilder(builder);
    console.log("builder connected", builder.npmVersion, builder.ip, builder.name || "", builder.hostname || "", Object.keys(builder.environments), "builderCount is", builderCount);
    syncEnvironments(builder);

    builder.on("environments", message => {
        builder.environments = {};
        message.environments.forEach(env => builder.environments[env] = true);
        syncEnvironments(builder);
    });

    builder.on("log", event => {
        addLogFile({ source: "builder", ip: builder.ip, contents: event.message });
    });

    builder.on("error", msg => {
        console.error(`builder error '${msg}' from ${builder.ip}`);
    });

    builder.on("objectCache", msg => {
        objectCache.addNode(builder, msg);
    });

    builder.on("objectCacheAdded", msg => {
        objectCache.insert(msg, builder);
    });

    builder.on("objectCacheRemoved", msg => {
        objectCache.remove(msg, builder);
    });

    builder.on("close", () => {
        removeBuilder(builder);
        if (objectCache)
            objectCache.removeNode(builder);
        console.log(`builder disconnected ${builder.ip}:${builder.port} ${builder.name} ${builder.hostname} builderCount is ${builderCount}`);
        builder.removeAllListeners();
    });

    builder.on("load", message => {
        builder.load = message.measure;
        // console.log(message);
    });

    builder.on("jobStarted", job => {
        ++jobsStarted;
        jobStartedOrScheduled("jobStarted", job);
    });
    builder.on("jobFinished", job => jobFinished(builder, job));
    builder.on("cacheHit", job => cacheHit(builder, job));

    builder.on("jobAborted", job => {
        console.log(`builder: ${builder.ip}:${builder.port} aborted a job`, job);
        if (monitors.length) {
            const info = {
                type: "jobAborted",
                id: job.id
            };

            monitors.forEach(monitor => monitor.send(info));
        }
    });
});

let pendingEnvironments = {};
function requestEnvironment(compile)
{
    if (compile.environment in pendingEnvironments)
        return false;
    pendingEnvironments[compile.environment] = true;

    console.log(`Asking ${compile.name} ${compile.ip} to upload ${compile.environment}`);
    compile.send({ type: "needsEnvironment" });

    let file;
    let gotLast = false;
    compile.on("uploadEnvironment", environment => {
        file = Environments.prepare(environment);
        console.log("Got environment message", environment, typeof file);
        if (!file) {
            // we already have this environment
            console.error("already got environment", environment.message);
            compile.send({ error: "already got environment" });
            compile.close();
            return;
        }
        let hash = environment.hash;
        compile.on("uploadEnvironmentData", environment => {
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
            file.save(environment.data).then(() => {
                if (environment.last) {
                    file.close();
                    compile.close();
                    return Environments.complete(file);
                }
                return undefined;
            }).then(() => {
                if (environment.last) {
                    file = undefined;
                    // send any new environments to builders
                    delete pendingEnvironments[hash];
                    return purgeEnvironmentsToMaxSize();
                }
                return undefined;
            }).then(() => {
                if (environment.last) {
                    syncEnvironments();
                }
            }).catch(error => {
                console.error("Got some error here", error);
                file = undefined;
            });
        });
    });
    compile.on("error", msg => {
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

server.on("clientVerify", clientVerify => {
    if (compareVersions(clientMinimumVersion, clientVerify.npmVersion) >= 1) {
        clientVerify.send("version_mismatch", { minimum_version: `${clientMinimumVersion}` });
    } else {
        clientVerify.send("version_verified", { minimum_version: `${clientMinimumVersion}` });
    }
});

server.on("compile", compile => {
    sendWols();
    compile.on("log", event => {
        addLogFile({ source: "client", ip: compile.ip, contents: event.message });
    });

    if (compareVersions(clientMinimumVersion, compile.npmVersion) >= 1) {
        ++jobsFailed;
        compile.send("version_mismatch", { minimum_version: `${clientMinimumVersion}` });
        return;
    }

    // console.log("request", compile.hostname, compile.ip, compile.environment);
    const usableEnvs = Environments.compatibleEnvironments(compile.environment);
    if (!Environments.hasEnvironment(compile.environment) && requestEnvironment(compile)) {
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

    function score(s) {
        let available = Math.min(4, s.slots - s.activeClients);
        return available * (1 - s.load);
    }
    let file;
    let builder;
    let bestScore;
    let env;
    let extraArgs;
    let blacklistedArgs;
    // console.log("got usableEnvs", usableEnvs);
    // ### should have a function match(s) that checks for env, score and compile.builder etc
    let foundInCache = false;
    if (objectCache) {
        let data = objectCache.get(compile.md5);
        if (data) {
            data.nodes.forEach(s => {
                if (compile.builder && builder != compile.builder)
                    return;
                const builderScore = score(s);
                if (!builder || builderScore > bestScore || (builderScore == bestScore && builder.lastJob < s.lastJob)) {
                    bestScore = builderScore;
                    builder = s;
                    foundInCache = true;
                }
            });
            if (builder && !(compile.environment in builder.environments)) {
                for (let i=0; i<usableEnvs.length; ++i) {
                    // console.log("checking builder", s.name, s.environments);
                    if (usableEnvs[i] in builder.environments) {
                        env = usableEnvs[i];
                        break;
                    }
                }
                if (!env)
                    builder = undefined;
            }
        }
    }
    if (!builder) {
        forEachBuilder(s => {
            if (compile.builder && compile.builder != s.ip && compile.builder != s.name)
                return;

            if (compile.labels) {
                for (let i=0; i<compile.labels.length; ++i) {
                    if (!s.labels || s.labels.indexOf(compile.labels[i]) === -1) {
                        return;
                    }
                }
            }

            for (let i=0; i<usableEnvs.length; ++i) {
                // console.log("checking builder", s.name, s.environments);
                if (usableEnvs[i] in s.environments) {
                    const builderScore = score(s);
                    // console.log("comparing", builderScore, bestScore);
                    if (!builder || builderScore > bestScore || (builderScore == bestScore && builder.lastJob < s.lastJob)) {
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
            console.log(`Specific builder "${compile.builder}" was requested and we couldn't find a builder with that ${compile.environment}`);
            compile.send("builder", {});
            return;
        }

        if (compile.labels) {
            ++jobsFailed;
            console.log(`Specific labels "${compile.labels}" were specified we couldn't match ${compile.environment} with any builder with those labels`);
            compile.send("builder", {});
            return;
        }
    }

    let data = {};

    if (builder) {
        if (env != compile.environment) {
            data.environment = env;
            data.extraArgs = Environments.extraArgs(compile.environment, env);
        }
        ++activeJobs;
        let utilization = (activeJobs / capacity);
        let peakInfo = false;
        const now = Date.now();
        peaks.forEach(peak => {
            if (peak.record(now, activeJobs, utilization))
                peakInfo = true;
        });
        if (peakInfo && monitors.length) {
            let info = statsMessage();
            monitors.forEach(monitor => monitor.send(info));
        }
        let sendTime = Date.now();
        ++builder.activeClients;
        ++builder.jobsScheduled;
        console.log(`${compile.name} ${compile.ip} ${compile.sourceFile} was assigned to builder ${builder.ip} ${builder.port} ${builder.name} score: ${bestScore} objectCache: ${foundInCache}. `
                    + `Builder has ${builder.activeClients} and performed ${builder.jobsScheduled} jobs. Total active jobs is ${activeJobs}`);
        builder.lastJob = Date.now();
        let id = nextJobId();
        data.id = id;
        data.ip = builder.ip;
        data.hostname = builder.hostname;
        data.port = builder.port;
        compile.send("builder", data);
        jobStartedOrScheduled("jobScheduled", { client: compile, builder: builder, id: id, sourceFile: compile.sourceFile });
        ++jobsScheduled;
    } else {
        ++jobsFailed;
        console.log("No builder for you", compile.ip);
        compile.send("builder", data);
    }
    compile.on("error", msg => {
        if (builder) {
            --builder.activeClients;
            --activeJobs;
            builder = undefined;
        }
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", event => {
        // console.log("Client disappeared");
        compile.removeAllListeners();
        if (builder) {
            --builder.activeClients;
            --activeJobs;
            builder = undefined;
        }
    });
});

function writeConfiguration(change)
{

}

function hash(password, salt)
{
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 12000, 256, "sha512", (err, hash) => {
            if (err) {
                reject(err);
            } else {
                resolve(hash);
            }
        });
    });
};

function randomBytes(bytes)
{
    return new Promise((resolve, reject) => {
        crypto.randomBytes(bytes, (err, result) => {
            if (err) {
                reject(`Failed to random bytes ${err}`);
            } else {
                resolve(result);
            }
        });
    });
}

function sendInfoToClient(client)
{
    forEachBuilder(builder => {
        const info = builderToMonitorInfo(builder, "builderAdded");
        if (monitorsLog)
            console.log("sending to monitor", info);
        client.send(info);
    });
    let info = statsMessage();
    if (monitorsLog)
        console.log("sending info to monitor", info);

    client.send(info);

    let scheduler = { version: schedulerNpmVersion, type: "schedulerInfo" };
    client.send(scheduler);
}

server.on("monitor", client => {
    if (monitorsLog)
        console.log("Got monitor", client.ip, client.hostname);
    monitors.push(client);
    function remove()
    {
        let idx = monitors.indexOf(client);
        if (idx != -1) {
            monitors.splice(idx, 1);
        }
        client.removeAllListeners();
    }
    let user;
    client.on("message", messageText => {
        if (monitorsLog)
            console.log("Got message from monitor", client.ip, client.hostname, messageText);
        let message;
        try {
            message = JSON.parse(messageText);
        } catch (err) {
            console.error(`Bad json message from monitor ${err.message}`);
            client.send({ success: false, error: `Bad message won't parse as JSON: ${err}` });
            client.close();
            return;
        }
        switch (message.type) {
        case 'sendInfo':
            sendInfoToClient(client);
            break;
        case 'clearLogFiles':
            clearLogFiles();
            updateLogFilesToMonitors();
            break;
        case 'logFiles':
            // console.log("logFiles:", message);
            fs.readdir(logFileDir, (err, files) => {
                if (files)
                    files = files.reverse();
                console.log("sending files", files);
                client.send({ type: "logFiles", files: files || [] });
            });
            break;
        case 'logFile':
            // console.log("logFile:", message);
            if (message.file.indexOf("../") != -1 || message.file.indexOf("/..") != -1) {
                client.close();
                return;
            }
            const f = path.join(logFileDir, message.file);
            fs.readFile(f, "utf8", (err, contents) => {
                // console.log("sending file", f, contents.length);
                client.send({ type: "logFile", file: f, contents: contents || ""});
            });
            break;
        case 'readConfiguration':
            break;
        case 'writeConfiguration':
            if (!user) {
                client.send({ type: "writeConfiguration", success: false, "error": `Unauthenticated message: ${message.type}` });
                return;
            }
            writeConfiguration(message);
            break;
        case 'listEnvironments':
            client.send({ type: "listEnvironments", environments: environmentsInfo() });
            break;
        case 'linkEnvironments':
            Environments.link(message.srcHash, message.targetHash, message.arguments, message.blacklist).then(() => {
                const info = { type: "listEnvironments", environments: environmentsInfo() };
                monitors.forEach(monitor => monitor.send(info));
            });
            break;
        case 'unlinkEnvironments':
            Environments.unlink(message.srcHash, message.targetHash).then(() => {
                const info = { type: "listEnvironments", environments: environmentsInfo() };
                monitors.forEach(monitor => monitor.send(info));
            });
            break;
        case 'listUsers': {
            if (!user) {
                client.send({ type: "listUsers", success: false, "error": `Unauthenticated message: ${message.type}` });
                return;
            }
            db.get("users").then(users => {
                if (!users)
                    users = {};
                client.send({ type: "listUsers", success: true, users: Object.keys(users) });
            }).catch(err => {
                console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                client.send({ type: "listUsers", success: false, error: err.toString() });
            });
            break; }
        case 'removeUser': {
            if (!user) {
                client.send({ type: "removeUser", success: false, "error": `Unauthenticated message: ${message.type}` });
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
            let users;
            db.get("users").then(users => {
                if (!users || !users[message.user]) {
                    throw new Error(`user ${message.user} doesn't exist`);
                }
                delete users[message.user];
                return db.set("users", users);
            }).then(() => {
                client.send({ type: "removeUser", success: true, user: message.user });
            }).catch(err => {
                console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                client.send({ type: "removeUser", success: false, error: err.toString() });
            }).finally(() => {
                delete pendingUsers[message.user];
            });

            // console.log("gotta remove user", message);
            break; }
        case 'login': {
            user = undefined;
            if (!message.user || (!message.password && !message.hmac)) {
                client.send({ type: "login", success: false, error: "Bad login message" });
                return;
            }
            let users;
            db.get("users").then(u => {
                users = u || {};
                if (!users[message.user]) {
                    throw new Error(`User: ${message.user} does not seem to exist`);
                }
                if (message.hmac) {
                    if (!users[message.user].cookie) {
                        throw new Error("No cookie");
                    } else if (users[message.user].cookieIp != client.ip) {
                        throw new Error("Wrong ip address");
                    } else if (users[message.user].cookieExpiration <= Date.now()) {
                        throw new Error("Cookie expired");
                    } else {
                        const hmac = crypto.createHmac("sha512", Buffer.from(users[message.user].cookie, "base64"));
                        hmac.write(client.nonce);
                        hmac.end();
                        const hmacString = hmac.read().toString("base64");
                        if (hmacString != message.hmac) {
                            throw new Error(`Wrong password ${message.user}`);
                        };
                        return undefined;
                    }
                } else {
                    return hash(message.password, Buffer.from(users[message.user].salt, "base64")).then(hash => {
                        if (users[message.user].hash != hash.toString('base64')) {
                            throw new Error(`Wrong password ${message.user}`);
                        }
                    });
                }
            }).then(() => {
                return randomBytes(256);
            }).then(cookie => {
                user = message.user;
                const expiration = new Date(Date.now() + 12096e5);
                users[message.user].cookie = cookie.toString("base64");
                users[message.user].cookieIp = client.ip;
                users[message.user].cookieExpiration = expiration.valueOf();
                return db.set("users", users);
            }).then(() => {
                client.send({ type: "login", success: true, user: message.user, cookie: users[message.user].cookie });
            }).catch(err => {
                console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                client.send({ type: "login", success: false, error: err.toString() });
            });
            break; }
        case 'addUser': {
            if (!message.user || !message.password) {
                client.send({ type: "addUser", success: false, error: "Bad addUser message" });
                return;
            }
            if (pendingUsers[message.user]) {
                client.send({ type: "addUser", success: false, error: "Someone's here already" });
                return;
            }
            pendingUsers[message.user] = true;
            let users;
            db.get("users").then(u => {
                users = u || {};
                if (users[message.user]) {
                    throw new Error(`user ${message.user} already exists`);
                }
                return randomBytes(256);
            }).then(salt => {
                users[message.user] = { salt: salt.toString("base64") };
                return hash(message.password, salt);
            }).then(hash => {
                users[message.user].hash = hash.toString("base64");
                return randomBytes(256);
            }).then(cookie => {
                users[message.user].cookie = cookie.toString("base64");
                users[message.user].cookieExpiration = (Date.now() + 12096e5);
                users[message.user].cookieIp = client.ip;
                return db.set("users", users);
            }).then(() => {
                // console.log("here", values);
                // values = [1,2];
                client.send({ type: "addUser",
                              success: true,
                              user: message.user,
                              cookie: users[message.user].cookie });
            }).catch(err => {
                console.error(`Something went wrong ${message.type} ${err.toString()} ${err.stack}`);
                client.send({ type: "addUser", success: false, error: err.toString() });
            }).finally(() => {
                delete pendingUsers[message.user];
            });

            // console.log("gotta add user", message);
            break; }
        }
    });
    client.on("close", remove);
    client.on("error", remove);
});

server.on("error", err => {
    console.error(`error '${err.message}' from ${err.ip}`);
});

function simulate(count)
{
    let usedIps = {};
    function randomIp(transient)
    {
        let ip;
        do {
            ip = [ parseInt(Math.random() * 256), parseInt(Math.random() * 256), parseInt(Math.random() * 256), parseInt(Math.random() * 256) ].join(".");
        } while (ip in usedIps);
        if (!transient)
            usedIps[ip] = true;
        return ip;
    }

    const randomWords = require('random-words');
    function randomName() { return randomWords({ min: 1, max: 5, join: " " }); }
    function randomSourceFile() { return randomWords({ min: 1, max: 2, join: "_" }) + ".cpp"; }
    function randomHostname() { return randomWords({ exactly: 1, wordsPerString: 1 + parseInt(Math.random() * 2), separator: '-' }); }

    let fakeBuilders = [];
    let jobs = [];
    for (let i=0; i<count; ++i) {
        const ip = randomIp();
        const fakeBuilder = {
            ip: ip,
            name: randomName(),
            hostname: randomHostname(),
            slots: [4, 16, 32][parseInt(Math.random() * 3)],
            port: 8097,
            jobsPerformed: 0,
            compileSpeed: 0,
            uploadSpeed: 0,
            system: "Linux x86_64",
            created: new Date(),
            npmVersion: schedulerNpmVersion,
            environments: Object.keys(Environments.environments)
        };
        for (let j=0; j<fakeBuilder.slots; ++j) {
            jobs.push({ builder: fakeBuilder });
        }
        fakeBuilders.push(fakeBuilder);
        insertBuilder(fakeBuilder);
    }
    const clients = [];
    const clientCount = count / 2 || 1;
    for (let i=0; i<clientCount; ++i) {
        clients[i] = { hostname: randomHostname(), ip: randomIp(true), name: randomName() };
    }
    function tick()
    {
        for (let i=0; i<jobs.length; ++i) {
            const percentage = Math.random() * 100;
            if (jobs[i].builder.gone) {
                if (percentage <= 10) {
                    jobs[i].builder.gone = false;
                    insertBuilder(jobs[i].builder);
                } else {
                    continue;
                }
            } else if (percentage <= 1) {
                jobs[i].builder.gone = true;
                removeBuilder(jobs[i].builder);
                while (jobs[i + 1] && jobs[i + 1].builder == jobs[i].builder) {
                    ++i;
                }
                continue;
            }
            if (percentage <= 30) {
                if (!jobs[i].client) {
                    jobs[i].client = clients[parseInt(Math.random() * clientCount)];
                    jobs[i].id = nextJobId();
                    jobStartedOrScheduled("jobScheduled", { client: jobs[i].client, builder: jobs[i].builder, id: jobs[i].id, sourceFile: randomSourceFile() });
                    jobStartedOrScheduled("jobStarted", { client: jobs[i].client, builder: jobs[i].builder, id: jobs[i].id, sourceFile: randomSourceFile() });
                } else {
                    // const client = jobs[i].client;
                    // const id = jobs[i].id;
                    jobFinished(jobs[i].builder, { id: jobs[i].id,
                                                 cppSize: parseInt(Math.random() * 1024 * 1024 * 4),
                                                 compileDuration: parseInt(Math.random() * 5000),
                                                 uploadDuration: parseInt(Math.random() * 500) });
                    delete jobs[i].client;
                    delete jobs[i].id;
                }
            }
        }
        setTimeout(tick, Math.random() * 2000);
    }
    tick();
}

Environments.load(db, option("env-dir", path.join(common.cacheDir(), "environments")))
    .then(() => {
        const limit = option.int('max-file-descriptors');
        if (limit) {
            console.log("setting limit", limit);
            posix.setrlimit('nofile', { soft: limit });
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
        const simulateCount = option("simulate");
        if (simulateCount) {
            simulate(parseInt(simulateCount) || 64);
        }
    }).catch(e => {
        console.error(e);
        process.exit();
    });
