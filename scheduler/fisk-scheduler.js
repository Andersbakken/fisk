#!/usr/bin/env node

const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk/scheduler", require('minimist')(process.argv.slice(2)));
const Server = require("./server");
const common = require("../common")(option);
const Environments = require("./environments");
const server = new Server(option, common.Version);
const fs = require("fs-extra");
const bytes = require("bytes");
const crypto = require("crypto");
const Database = require("./database");

process.on("unhandledRejection", (reason, p) => {
    console.log("Unhandled Rejection at: Promise", p, "reason:", reason.stack);
});

let schedulerNpmVersion;
try {
    schedulerNpmVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"))).version;
} catch (err) {
    console.log("Couldn't parse package json", err);
    process.exit();
}

const clientMinimumVersion = [ 1, 1, 84 ];

const slaves = {};
const monitors = [];
let slaveCount = 0;
let activeJobs = 0;
let jobId = 0;
const db = new Database(path.join(common.cacheDir(), "db.json"));
const logFileDir = path.join(common.cacheDir(), "logs");
try {
    fs.mkdirSync(logFileDir);
} catch (err) {
}

const pendingUsers = {};

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
    if (monitors.length) {
        const info = slaveToMonitorInfo(slave, "slaveAdded");
        // console.log("send to monitors", info);
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

function removeSlave(slave) {
    --slaveCount;
    delete slaves[slaveKey(slave)];
    if (monitors.length) {
        const info = slaveToMonitorInfo(slave, "slaveRemoved");
        // console.log("send to monitors", info);
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
        let maxSize = bytes.parse(option("max-cache-size"));
        if (!maxSize) {
            resolve(false);
            return;
        }
        const p = Environments._path;
        try {
            let purged = false;
            fs.readdirSync(p).map(file => {
                // console.log("got file", file);
                let match = /^([^:]*):([^:]*):([^:]*).tar.gz$/.exec(file);
                if (!match)
                    return undefined;
                var abs = path.join(p, file);
                var stat;
                try {
                    stat = fs.statSync(abs);
                } catch (err) {
                    return undefined;
                }
                return {
                    path: abs,
                    hash: match[1],
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
    var needs = [];
    var unwanted = [];
    console.log("scheduler has", Object.keys(Environments.environments).sort());
    console.log("slave has", Object.keys(slave.environments).sort());
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
        needs.forEach(env => Environments.environments[env].send(slave));
        // Environments.requestEnvironments(slave);
    }
}

function environmentsInfo()
{
    let ret = Object.assign({}, Environments.environments);
    ret.maxSize = option("max-cache-size") || 0;
    ret.maxSizeBytes = bytes.parse(option("max-cache-size")) || 0;
    ret.usedSizeBytes = 0;
    for (let hash in Environments.environments) {
        let env = Environments.environments[hash];
        if (env.size)
            ret.usedSizeBytes += env.size;
    }
    ret.usedSize = bytes.format(ret.usedSizeBytes);
    ret.compatibilities = Environments.compatibilitiesInfo();
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
        res.send(JSON.stringify({ npmVersion: schedulerNpmVersion, environments: environmentsInfo(), configVersion: common.Version }, null, 4));
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
    const year = date.getFullYear(),
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

function addLogFile(log) {
    fs.writeFile(path.join(logFileDir, `${formatDate(new Date())} ${log.source} ${log.ip}`), log.contents);
}

server.on("slave", slave => {
    if (slave.npmVersion != schedulerNpmVersion) {
        console.log(`slave ${slave.ip} has bad npm version: ${slave.npmVersion} should have been: ${schedulerNpmVersion}`);
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
    slave.on("close", () => {
        removeSlave(slave);
        console.log("slave disconnected", slave.ip, slave.name || "", slave.hostname || "", "slaveCount is", slaveCount);
        slave.removeAllListeners();
    });

    slave.on("load", message => {
        slave.load = message.measure;
        // console.log(message);
    });

    slave.on("jobStarted", job => {
        if (monitors.length) {
            // console.log("GOT STUFF", job);
            let info = {
                type: "jobStarted",
                client: {
                    hostname: job.client.hostname,
                    ip: job.client.ip,
                    name: job.client.name
                },
                sourceFile: job.sourceFile,
                slave: {
                    hostname: job.slave.hostname,
                    ip: job.slave.ip,
                    name: job.slave.name,
                    port: job.slave.port
                },
                id: job.id
            };
            // console.log("send to monitors", info);
            monitors.forEach(monitor => monitor.send(info));
        }
        // console.log(`slave: ${job.slave.ip}:${job.slave.port} will build ${job.sourceFile} for ${job.client.name}`);
    });

    slave.on("jobFinished", job => {
        ++slave.jobsPerformed;
        slave.totalCompileSpeed += job.compileSpeed;
        slave.totalUploadSpeed += job.uploadSpeed;
        // console.log(`slave: ${slave.ip}:${slave.port} performed a job`, job);
        if (monitors.length) {
            const info = {
                type: "jobFinished",
                id: job.id,
                cppSize: job.cppSize,
                compileDuration: job.compileDuration,
                compileSpeed: job.compileSpeed,
                uploadDuration: job.uploadDuration,
                uploadSpeed: job.uploadSpeed
            };
            // console.log("send to monitors", info);
            monitors.forEach(monitor => monitor.send(info));
        }
    });

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
                    Environments.complete(file);
                    file = undefined;
                    // send any new environments to slaves
                    delete pendingEnvironments[hash];
                    purgeEnvironmentsToMaxSize().then(() => {
                        syncEnvironments();
                    }).catch(error => {
                        console.error("Got some error here", error);
                    });
                }
            }).catch(err => {
                console.log("file error", err);
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

let semaphoreMaintenanceTimers = {};
server.on("compile", compile => {
    compile.on("log", event => {
        addLogFile({ source: "client", ip: compile.ip, contents: event.message });
    });

    if (compile.npmVersion) {
        let match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(compile.npmVersion);
        let ok = false;
        if (match) {
            let major = parseInt(match[1]);
            let minor = parseInt(match[2]);
            let patch = parseInt(match[3]);
            if (major == clientMinimumVersion[0]
                && (minor > clientMinimumVersion[1] || (minor == clientMinimumVersion[1] && patch >= clientMinimumVersion[2]))) {
                ok = true;
            }
        }
        if (!ok) {
            compile.send("version_mismatch", { minimum_version: `${clientMinimumVersion[0]}.${clientMinimumVersion[1]}.${clientMinimumVersion[2]}` });
            return;
        }
    }
    // console.log("request", compile.hostname, compile.ip, compile.environment);
    const usableEnvs = Environments.compatibleEnvironments(compile.environment);
    if (!Environments.hasEnvironment(compile.environment) && requestEnvironment(compile)) {
        return;
    }
    // console.log("compatible environments", usableEnvs);

    if (!usableEnvs.length) {
        console.log(`We're already waiting for ${compile.environment} and we don't have any compatible ones`);
        compile.send("slave", {});
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
    if (!slave) {
        console.log(`Specific slave was requested and we couldn't match ${compile.environment} with that slave`);
        compile.send("slave", {});
    }
    let data = {};
    // console.log("WE'RE HERE", Object.keys(semaphoreMaintenanceTimers), compile.ip);
    if (compile.ip in semaphoreMaintenanceTimers) {
        clearTimeout(semaphoreMaintenanceTimers[compile.ip]);
    } else {
        data.maintain_semaphores = true;
    }
    semaphoreMaintenanceTimers[compile.ip] = setTimeout(() => {
        delete semaphoreMaintenanceTimers[compile.ip];
    }, 60 * 60000);

    if (slave) {
        if (env != compile.environment)
            data.environment = env;
        ++activeJobs;
        let sendTime = Date.now();
        ++slave.activeClients;
        ++slave.jobsScheduled;
        console.log(`${compile.name} ${compile.ip} ${compile.sourceFile} was assigned to slave ${slave.ip} ${slave.port} ${slave.name} score: ${bestScore} slave has ${slave.activeClients} and performed ${slave.jobsScheduled} jobs. Total active jobs is ${activeJobs}`);
        slave.lastJob = Date.now();
        let id = ++jobId;
        if (id == 2147483647)
            id = 0;
        data.id = id;
        data.ip = slave.ip;
        data.hostname = slave.hostname;
        data.port = slave.port;
        compile.send("slave", data);
    } else {
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
    monitors.push(client);
    function remove()
    {
        var idx = monitors.indexOf(client);
        if (idx != -1) {
            monitors.splice(idx, 1);
        }
        client.removeAllListeners();
    }
    forEachSlave(slave => {
        client.send(slaveToMonitorInfo(slave, "slaveAdded"));
    });
    let user;
    client.on("message", messageText => {
        // console.log("GOT MESSAGE", messageText);
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
        case 'linkEnvironments':
            Environments.link(message.srcHash, message.targetHash, message.arguments, message.blacklist);
            break;
        case 'unlinkEnvironments':
            Environments.unlink(message.srcHash, message.targetHash);
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

Environments.load(db, option("env-dir", path.join(common.cacheDir(), "environments")))
    .then(purgeEnvironmentsToMaxSize)
    // .then(() => {
    //     return db.get("users");
    // }).then(u => {
    //     console.log("got users", u);
    //     users = u || {};
    // })
    .then(() => server.listen())
    .catch(e => {
        console.error(e);
        process.exit();
    });
