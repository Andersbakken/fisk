#!/usr/bin/env node

const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk/scheduler");
const Server = require("./server");
const common = require('../common')(option);
const Environments = require("./environments");
const server = new Server(option);
const fs = require("fs-extra");
const bytes = require("bytes");

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
});

const slaves = {};
const monitors = [];
let slaveCount = 0;
let activeJobs = 0;
let jobId = 0;

function slaveKey() {
    if (arguments.length == 1) {
        return arguments[0].ip + " " + arguments[0].port;
    } else {
        return arguments[0] + " " + arguments[1];
    }
}

function insertSlave(slave) {
    slaves[slaveKey(slave)] = slave;
    ++slaveCount;
}

function forEachSlave(cb) {
    for (let key in slaves) {
        cb(slaves[key]);
    }
}

function removeSlave(slave) {
    --slaveCount;
    delete slaves[slaveKey(slave)];
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
                console.log("got file", file);
                let match = /^([A-Za-z0-9]*)_(.*).tar.gz$/.exec(file);
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

function distribute(conf)
{
    let keys;
    if (conf && conf.slave) {
        if (conf.slave.pendingEnvironments)
            return;
        keys = [ slaveKey(conf.slave) ];
    } else {
        keys = Object.keys(slaves);
    }
    let hashes;
    if (conf && conf.hash) {
        hashes = [ conf.hash ];
    } else {
        hashes = Object.keys(Environments.environments);
    }
    // console.log("distribute", keys, hashes);
    for (let h=0; h<hashes.length; ++h) {
        let hash = hashes[h];
        for (let i=0; i<keys.length; ++i) {
            let key = keys[i];
            let slave = slaves[key];
            if (!slave.pendingEnvironments && slave.environments && !(hash in slave.environments)) {
                let e = Environments.environment(hash);
                if (e.canRun(slave.system)) {
                    console.log("sending", hash, "to", key);
                    Environments.environment(hash).send(slave);
                    slave.pendingEnvironments = true;
                // } else {
                //     console.log("slave can't run this environment", key, hash);
                }
            }
        }
    }
}

server.express.get("/environments", (req, res, next) => {
    res.send(Object.keys(Environments.environments));
});

server.express.get("/slaves", (req, res, next) => {
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
            compileSpeed: s.jobsPerformed / s.totalCompileSpeed,
            uploadSpeed: s.jobsPerformed / s.totalUploadSpeed,
            hostname: s.hostname,
            system: s.system,
            name: s.name,
            created: s.created,
            load: s.load,
            version: s.version,
            environments: Object.keys(s.environments)
        });
    }
    res.send(ret);
});

server.express.get("/info", (req, res, next) => {
    let version = -1;
    try {
        version = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"))).version;
    } catch (err) {
        console.log("Couldn't parse package json", err);
    }

    res.send({ version: version, environments: Object.keys(Environments.environments) });
});

server.express.get("/quit-slaves", (req, res, next) => {
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

server.express.get("/quit", (req, res, next) => {
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

server.on("slave", function(slave) {
    slave.activeClients = 0;
    slave.pendingEnvironments = false;
    insertSlave(slave);
    console.log("slave connected", slave.ip, slave.name || "", slave.hostName || "", Object.keys(slave.environments), "slaveCount is", slaveCount);
    if (Object.keys(slave.environments).sort() != Object.keys(Environments.environments).sort()) {
        slave.send({type: "filterEnvironments", environments: Object.keys(Environments.environments).reduce((obj, value) => { obj[value] = true; return obj; }, {}) });
    } else {
        distribute({slave: slave});
    }

    slave.on('environments', function(message) {
        slave.environments = {};
        message.environments.forEach(env => slave.environments[env] = true);
        slave.pendingEnvironments = false;
        distribute({slave: slave});
    });

    slave.on("error", function(msg) {
        console.error(`slave error '${msg}' from ${slave.ip}`);
    });
    slave.on("close", function() {
        removeSlave(slave);
        console.log("slave disconnected", slave.ip, slave.name || "", slave.hostName || "", "slaveCount is", slaveCount);
        slave.removeAllListeners();
    });

    slave.on("load", message => {
        slave.load = message.measure;
        // console.log(message);
    });

    slave.on("jobFinished", function(job) {
        ++slave.jobsPerformed;
        slave.totalCompileSpeed += job.compileSpeed;
        slave.totalUploadSpeed += job.uploadSpeed;
        console.log(`slave: ${slave.ip}:${slave.port} performed a job`, job);
        job.type = "jobPerformed";
        monitors.forEach(monitor => monitor.send(job));
    });
});

let semaphoreMaintenanceTimers = {};
let pendingEnvironments = {};
server.on("compile", function(compile) {
    let arrived = Date.now();
    // console.log("request", compile.environments);
    let found = false;
    for (let i=0; i<compile.environments.length; ++i) {
        if (Environments.hasEnvironment(compile.environments[i])) {
            found = true;
            break;
        }
    }
    let needed = [];
    if (!found) {
        compile.environments.forEach(env => {
            // console.log(`checking ${env} ${pendingEnvironments} ${env in pendingEnvironments}`);
            if (!(env in pendingEnvironments)) {
                needed.push(env);
                pendingEnvironments[env] = true;
            }
        });
        if (!needed.length) {
            console.log(`We're already waiting for ${compile.environments}`);
            compile.send("slave", {});
            return;
        }
        console.log(`Asking ${compile.name} ${compile.ip} to upload ${needed}`);
        compile.send({ type: "needsEnvironment", environments: needed });

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
                if (environment.last)
                    gotLast = true;
                console.log("Got environmentdata message", environment.data.length, environment.last);
                file.save(environment.data).then(() => {
                    if (environment.last) {
                        file.close();
                        compile.close();
                        Environments.complete(file);
                        file = undefined;
                        // send any new environments to slaves
                        delete pendingEnvironments[hash];
                        purgeEnvironmentsToMaxSize().then(purged => {
                            var msg = {type: "filterEnvironments", environments: Object.keys(Environments.environments).reduce((obj, value) => { obj[value] = true; return obj; }, {}) };
                            forEachSlave(slave => slave.send(msg));
                            distribute({hash: hash});
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
            needed.forEach(env => {
                delete pendingEnvironments[env];
            });
        });
        compile.on("close", () => {
            console.log("compile with upload closed", needed, gotLast);
            if (file && !gotLast) {
                file.discard();
                file = undefined;
            }
            needed.forEach(env => {
                delete pendingEnvironments[env];
            });
        });

        return;
    }

    function score(s) {
        let available = Math.min(4, s.slots - s.activeClients);
        return available * (1 - s.load);
    }
    let file;
    let slave;
    let bestScore;
    forEachSlave(s => {
        found = false;
        for (let i=0; i<compile.environments.length; ++i) {
            if (compile.environments[i] in s.environments) {
                found = true;
                break;
            }
        }

        // console.log(`Any finds for ${compile.environments} ${found}`);

        if (found) {
            let slaveScore;
            // console.log("Got compile.slave", compile.slave, s.ip);
            if (compile.slave && (compile.slave == s.ip || compile.slave == s.name)) {
                slaveScore = Infinity;
            } else {
                slaveScore = score(s);
            }
            // console.log("comparing", slaveScore, bestScore);
            if (!slave || slaveScore > bestScore || (slaveScore == bestScore && s.lastJob < slave.lastJob)) {
                bestScore = slaveScore;
                slave = s;
            }
        // } else {
        //     console.log("Dude doesn't have the compiler", s.ip);
        }
    });
    let data = {};
    // console.log("WE'RE HERE", Object.keys(semaphoreMaintenanceTimers), compile.ip);
    if (compile.ip in semaphoreMaintenanceTimers) {
        clearTimeout(semaphoreMaintenanceTimers[compile.ip]);
    } else {
        semaphoreMaintenanceTimers[compile.ip] = setTimeout(() => {
            delete semaphoreMaintenanceTimers[compile.ip];
        }, 60 * 60000);
        data["maintain_semaphores"] = true;
    }

    if (slave) {
        ++activeJobs;
        let sendTime = Date.now();
        // console.log(`${compile.name} ${compile.ip} ${compile.sourceFile} got slave ${slave.ip} ${slave.port} ${slave.name} score: ${bestScore} active jobs is ${activeJobs} arrived ${arrived} chewed for ${sendTime - arrived}`);
        ++slave.activeClients;
        ++slave.jobsScheduled;
        slave.lastJob = Date.now();
        let id = ++jobId;
        if (id == 2147483647)
            id = 0;
        data.id = id;
        data.ip = slave.ip;
        data.hostName = slave.hostName;
        data.port = slave.port;
        compile.send("slave", data);
    } else {
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
    client.on("close", remove);
    client.on("error", remove);
});

server.on("error", err => {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.load(option("env-dir", path.join(common.cacheDir(), "environments")))
    .then(purgeEnvironmentsToMaxSize)
    .then(() => server.listen())
    .catch(e => {
        console.error(e);
        process.exit();
    });
