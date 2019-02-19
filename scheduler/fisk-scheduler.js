#!/usr/bin/env node

const path = require('path');
const os = require('os');
const option = require('@jhanssen/options')('fisk/scheduler', require('minimist')(process.argv.slice(2)));
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

const clientMinimumVersion = "3.1.7";
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

const slaves = {};
const monitors = [];
let slaveCount = 0;
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
    new Peak(60 * 1000, "Last hour"),
    new Peak(24 * 60 * 1000, "Last 24 hours"),
    new Peak(7 * 24 * 60 * 1000, "Last 7 days"),
    new Peak(30 * 24 * 60 * 1000, "Last 30 days"),
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
            slave: {
                ip: job.slave.ip,
                name: job.slave.name,
                port: job.slave.port
            },
            id: job.id
        };
        if (job.slave.hostname)
            info.slave.hostname = job.slave.hostname;

        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => monitor.send(info));
    }
}

function cacheHit(slave, job)
{
    if (objectCache)
        ++objectCache.hits;
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
            slave: {
                ip: slave.ip,
                name: slave.name,
                port: slave.port
            },
            id: job.id,
            jobs: (objectCache ? objectCache.hits : 0) + jobsFailed + jobsFinished,
            jobsFailed: jobsFailed,
            jobsStarted: jobsStarted,
            jobsFinished: jobsFinished,
            jobsScheduled: jobsScheduled,
            cacheHits: objectCache ? objectCache.hits : 0
        };
        if (slave.hostname)
            info.slave.hostname = job.slave.hostname;
        if (monitorsLog)
            console.log("send to monitors", info);
        // console.log("sending info", info);
        monitors.forEach(monitor => monitor.send(info));
    }
}

function jobFinished(slave, job)
{
    ++jobsFinished;
    ++slave.jobsPerformed;
    slave.totalCompileSpeed += job.compileSpeed;
    slave.totalUploadSpeed += job.uploadSpeed;
    // console.log(`slave: ${slave.ip}:${slave.port} performed a job`, job);
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

function slaveKey() {
    if (arguments.length == 1) {
        return arguments[0].ip + " " + arguments[0].port;
    } else {
        return arguments[0] + " " + arguments[1];
    }
}

function slaveToMonitorInfo(slave, type)
{
    return {
        type: type,
        ip: slave.ip,
        name: slave.name,
        hostname: slave.hostname,
        slots: slave.slots,
        port: slave.port,
        jobsPerformed: slave.jobsPerformed,
        compileSpeed: slave.jobsPerformed / slave.totalCompileSpeed || 0,
        uploadSpeed: slave.jobsPerformed / slave.totalUploadSpeed || 0,
        system: slave.system,
        created: slave.created,
        npmVersion: slave.npmVersion,
        environments: Object.keys(slave.environments)
    };
}

function insertSlave(slave) {
    slaves[slaveKey(slave)] = slave;
    ++slaveCount;
    capacity += slave.slots;
    if (monitors.length) {
        const info = slaveToMonitorInfo(slave, "slaveAdded");
        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => {
            monitor.send(info);
        });
    }
}

function forEachSlave(cb) {
    for (let key in slaves) {
        cb(slaves[key]);
    }
}

if (option('object-cache')) {
    objectCache = new ObjectCacheManager;
    objectCache.on("cleared", () => {
        jobsFailed = 0;
        jobsStarted = 0;
        jobsScheduled = 0;
        jobsFinished = 0;
        const msg = { type: "clearObjectCache" };
        forEachSlave(slave => slave.send(msg));
        let info = statsMessage();
        monitors.forEach(monitor => monitor.send(info));
    });
}

function removeSlave(slave) {
    --slaveCount;
    capacity -= slave.slots;
    delete slaves[slaveKey(slave)];
    if (monitors.length) {
        const info = slaveToMonitorInfo(slave, "slaveRemoved");
        if (monitorsLog)
            console.log("send to monitors", info);
        monitors.forEach(monitor => {
            monitor.send(info);
        });
    }

}

function findSlave(ip, port) {
    return slaves(slaveKey(ip, port));
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
                console.log("Should purge env", env.hash);
            });
            resolve(purged);
        } catch (err) {
            resolve(false);
            return;
        }
    });
}

function syncEnvironments(slave)
{
    if (!slave) {
        forEachSlave(syncEnvironments);
        return;
    }
    let needs = [];
    let unwanted = [];
    console.log("scheduler has", Object.keys(Environments.environments).sort());
    console.log("slave has", slave.ip, Object.keys(slave.environments).sort());
    for (let env in Environments.environments) {
        if (env in slave.environments) {
            slave.environments[env] = -1;
        } else if (Environments.environments[env].canRun(slave.system)) {
            needs.push(env);
        }
    }
    for (let env in slave.environments) {
        if (slave.environments[env] != -1) {
            unwanted.push(env);
            delete slave.environments[env];
        } else {
            slave.environments[env] = true;
        }
    }
    console.log("unwanted", unwanted);
    console.log("needs", needs);
    if (unwanted.length) {
        slave.send({ type: "dropEnvironments", environments: unwanted });
    }
    if (needs.length) {
        slave.send({ type: "getEnvironments", environments: needs });
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
        res.send(JSON.stringify(environmentsInfo(), null, 4));
    });

    app.get("/slaves", (req, res, next) => {
        let ret = [];
        for (let ip in slaves) {
            let s = slaves[ip];
            ret.push({
                ip: s.ip,
                name: s.name,
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
                npmVersion: s.npmVersion,
                environments: Object.keys(s.environments)
            });
        }
        res.send(JSON.stringify(ret, null, 4));
    });

    app.get("/info", (req, res, next) => {
        const now = Date.now();
        const jobs = jobsFailed + jobsStarted + (objectCache ? objectCache.hits : 0);
        function percentage(count)
        {
            return { count: count, percentage: (count ? count * 100 / jobs : 0).toFixed(1) + "%" };
        }

        let obj = {
            slaveCount: Object.keys(slaves).length,
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
        res.send(JSON.stringify(obj, null, 4));
    });

    app.get("/objectcache", (req, res, next) => {
        if (!objectCache) {
            res.sendStatus(404);
            return;
        }

        if (req.query && "clear" in req.query) {
            objectCache.clear();
            res.sendStatus(200);
        } else {
            res.send(JSON.stringify(objectCache.dump(req.query || {}), null, 4) + "\n");
        }
    });

    app.get("/quit-slaves", (req, res, next) => {
        res.sendStatus(200);
        const msg = {
            type: "quit",
            code: req.query.code || 0,
            purgeEnvironments: "purge_environments" in req.query
        };
        console.log("Sending quit message to slaves", msg, Object.keys(slaves));
        for (let ip in slaves) {
            slaves[ip].send(msg);
        }
    });

    app.get('/environment/*', function(req, res, next) {
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

    app.get("/quit", (req, res, next) => {
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

try {
    fs.watch(logFileDir, (type, filename) => {
        if (type == "rename" && monitors.length) {
            fs.readdir(logFileDir, (err, files) => {
                const msg = { type: "logFiles", files: files || [] };
                // console.log("sending files", msg);
                monitors.forEach(monitor => monitor.send(msg));
            });
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
    return `${month}_${day}_${hour}:${minute}:${second}`;
}

function addLogFile(log, cb) {
    fs.writeFile(path.join(logFileDir, `${formatDate(new Date())} ${log.source} ${log.ip}`), log.contents, cb);
}

server.on("slave", slave => {
    if (compareVersions(schedulerNpmVersion, slave.npmVersion) >= 1) {
        console.log(`slave ${slave.ip} has bad npm version: ${slave.npmVersion} should have been at least: ${schedulerNpmVersion}`);
        slave.send({ type: "quit" });
        return;
    }
    slave.activeClients = 0;
    insertSlave(slave);
    console.log("slave connected", slave.npmVersion, slave.ip, slave.name || "", slave.hostname || "", Object.keys(slave.environments), "slaveCount is", slaveCount);
    syncEnvironments(slave);

    slave.on("environments", message => {
        slave.environments = {};
        message.environments.forEach(env => slave.environments[env] = true);
        syncEnvironments(slave);
    });

    slave.on("log", event => {
        addLogFile({ source: "slave", ip: slave.ip, contents: event.message });
    });

    slave.on("error", msg => {
        console.error(`slave error '${msg}' from ${slave.ip}`);
    });

    slave.on("objectCache", msg => {
        objectCache.addNode(slave, msg.md5s);
    });

    slave.on("objectCacheAdded", msg => {
        objectCache.insert(msg, slave);
    });

    slave.on("objectCacheRemoved", msg => {
        objectCache.remove(msg, slave);
    });

    slave.on("close", () => {
        removeSlave(slave);
        if (objectCache)
            objectCache.removeNode(slave);
        console.log("slave disconnected", slave.ip, slave.name || "", slave.hostname || "", "slaveCount is", slaveCount);
        slave.removeAllListeners();
    });

    slave.on("load", message => {
        slave.load = message.measure;
        // console.log(message);
    });

    slave.on("jobStarted", job => {
        ++jobsStarted;
        jobStartedOrScheduled("jobStarted", job);
    });
    slave.on("jobFinished", job => jobFinished(slave, job));
    slave.on("cacheHit", job => cacheHit(slave, job));

    slave.on("jobAborted", job => {
        console.log(`slave: ${slave.ip}:${slave.port} aborted a job`, job);
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
                    // send any new environments to slaves
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

let semaphoreMaintenanceTimers = {};
server.on("compile", compile => {
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
        compile.send("slave", {});
        ++jobsFailed;
        return;
    }

    function score(s) {
        let available = Math.min(4, s.slots - s.activeClients);
        return available * (1 - s.load);
    }
    let file;
    let slave;
    let bestScore;
    let env;
    let extraArgs;
    let blacklistedArgs;
    // console.log("got usableEnvs", usableEnvs);
    let foundInCache = false;
    if (objectCache) {
        let cacheNodes = objectCache.get(compile.md5);
        if (cacheNodes) {
            cacheNodes.forEach(s => {
                if (compile.slave && slave != compile.slave)
                    return;
                const slaveScore = score(s);
                if (!slave || slaveScore > bestScore || (slaveScore == bestScore && slave.lastJob < s.lastJob)) {
                    bestScore = slaveScore;
                    slave = s;
                    foundInCache = true;
                }
            });
            if (slave && !(compile.environment in slave.environments)) {
                for (let i=0; i<usableEnvs.length; ++i) {
                    // console.log("checking slave", s.name, s.environments);
                    if (usableEnvs[i] in slave.environments) {
                        env = usableEnvs[i];
                        break;
                    }
                }
            }
        }
    }
    if (!slave) {
        forEachSlave(s => {
            if (compile.slave && compile.slave != s.ip && compile.slave != s.name)
                return;

            for (let i=0; i<usableEnvs.length; ++i) {
                // console.log("checking slave", s.name, s.environments);
                if (usableEnvs[i] in s.environments) {
                    const slaveScore = score(s);
                    // console.log("comparing", slaveScore, bestScore);
                    if (!slave || slaveScore > bestScore || (slaveScore == bestScore && slave.lastJob < s.lastJob)) {
                        bestScore = slaveScore;
                        slave = s;
                        env = usableEnvs[i];
                    }
                    break;
                }
            }
        });
    }
    if (!slave && compile.slave) {
        ++jobsFailed;
        console.log(`Specific slave was requested and we couldn't match ${compile.environment} with that slave`);
        compile.send("slave", {});
        return;
    }
    let data = {};
    // console.log("WE'RE HERE", Object.keys(semaphoreMaintenanceTimers), compile.ip);
    if (option("maintain-semaphores")) {
        if (compile.ip in semaphoreMaintenanceTimers) {
            clearTimeout(semaphoreMaintenanceTimers[compile.ip]);
        } else {
            data.maintain_semaphores = true;
        }
        semaphoreMaintenanceTimers[compile.ip] = setTimeout(() => {
            delete semaphoreMaintenanceTimers[compile.ip];
        }, 60 * 60000);
    }

    if (slave) {
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
        ++slave.activeClients;
        ++slave.jobsScheduled;
        console.log(`${compile.name} ${compile.ip} ${compile.sourceFile} was assigned to slave ${slave.ip} ${slave.port} ${slave.name} score: ${bestScore} objectCache: ${foundInCache}. `
                    + `Slave has ${slave.activeClients} and performed ${slave.jobsScheduled} jobs. Total active jobs is ${activeJobs}`);
        slave.lastJob = Date.now();
        let id = nextJobId();
        data.id = id;
        data.ip = slave.ip;
        data.hostname = slave.hostname;
        data.port = slave.port;
        compile.send("slave", data);
        jobStartedOrScheduled("jobScheduled", { client: compile, slave: slave, id: id, sourceFile: compile.sourceFile });
        ++jobsScheduled;
    } else {
        ++jobsFailed;
        console.log("No slave for you", compile.ip);
        compile.send("slave", data);
    }
    compile.on("error", msg => {
        if (slave) {
            --slave.activeClients;
            --activeJobs;
            slave = undefined;
        }
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", event => {
        // console.log("Client disappeared");
        compile.removeAllListeners();
        if (slave) {
            --slave.activeClients;
            --activeJobs;
            slave = undefined;
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
    forEachSlave(slave => {
        const info = slaveToMonitorInfo(slave, "slaveAdded");
        if (monitorsLog)
            console.log("sending to monitor", info);
        client.send(info);
    });
    let info = statsMessage();
    if (monitorsLog)
        console.log("sending info to monitor", info);

    client.send(info);
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
        case 'logFiles':
            // console.log("logFiles:", message);
            fs.readdir(logFileDir, (err, files) => {
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

    let fakeSlaves = [];
    let jobs = [];
    for (let i=0; i<count; ++i) {
        const ip = randomIp();
        const fakeSlave = {
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
        for (let j=0; j<fakeSlave.slots; ++j) {
            jobs.push({ slave: fakeSlave });
        }
        fakeSlaves.push(fakeSlave);
        insertSlave(fakeSlave);
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
            if (jobs[i].slave.gone) {
                if (percentage <= 10) {
                    jobs[i].slave.gone = false;
                    insertSlave(jobs[i].slave);
                } else {
                    continue;
                }
            } else if (percentage <= 1) {
                jobs[i].slave.gone = true;
                removeSlave(jobs[i].slave);
                while (jobs[i + 1] && jobs[i + 1].slave == jobs[i].slave) {
                    ++i;
                }
                continue;
            }
            if (percentage <= 30) {
                if (!jobs[i].client) {
                    jobs[i].client = clients[parseInt(Math.random() * clientCount)];
                    jobs[i].id = nextJobId();
                    jobStartedOrScheduled("jobScheduled", { client: jobs[i].client, slave: jobs[i].slave, id: jobs[i].id, sourceFile: randomSourceFile() });
                    jobStartedOrScheduled("jobStarted", { client: jobs[i].client, slave: jobs[i].slave, id: jobs[i].id, sourceFile: randomSourceFile() });
                } else {
                    // const client = jobs[i].client;
                    // const id = jobs[i].id;
                    jobFinished(jobs[i].slave, { id: jobs[i].id,
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
