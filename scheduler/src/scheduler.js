#!/usr/bin/env node

const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk/scheduler");
const Server = require("./server");
const common = require('../../common')(option);
const Environments = require("./environments");
const server = new Server(option);

const slaves = {};

function slaveKey() {
    if (arguments.length == 1) {
        return arguments[0].ip + " " + arguments[0].port;
    } else {
        return arguments[0] + " " + arguments[1];
    }
}

function insertSlave(slave) {
    slaves[slaveKey(slave)] = slave;
}

function forEachSlave(cb) {
    for (let key in slaves) {
        cb(slaves[key]);
    }
}

function removeSlave(slave) {
    delete slaves[slaveKey(slave)];
}

function findSlave(ip, port) {
    return slaves(slaveKey(ip, port));
}

function distribute(conf)
{
    let keys;
    if (conf && conf.slave) {
        if (conf.pendingEnvironments)
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
    console.log("distribute", keys, hashes);
    for (let h=0; h<hashes.length; ++h) {
        let hash = hashes[h];
        for (let i=0; i<keys.length; ++i) {
            let key = keys[i];
            let slave = slaves[key];
            if (!slave.pendingEnvironments && slave.environments && !(hash in slave.environments)) {
                console.log("sending", hash, "to", key);
                Environments.environment(hash).send(slave);
                slave.pendingEnvironments = true;
            }
        }
    }
}

server.express.get("/slaves", (req, res, next) => {
    let ret = [];
    for (let ip in slaves) {
        let s = slaves[ip];
        ret.push({
            architecture: s.architecture,
            ip: s.ip,
            name: s.name,
            slots: s.slots,
            port: s.port,
            activeClients: s.activeClients,
            jobsScheduled: s.jobsScheduled,
            lastJob: new Date(s.lastJob).toString(),
            jobsPerformed: s.jobsPerformed,
            hostname: s.hostname,
            name: s.name,
            created: s.created,
            environments: Object.keys(s.environments)
        });
    }
    res.send(ret);
});

server.express.get("/quit-slaves", (req, res, next) => {
    res.sendStatus(200);
    const msg = {
        type: "quit",
        code: req.query.code || 0
    };
    console.log("Sending quit message to slaves", Object.keys(slaves));
    for (let ip in slaves) {
        slaves[ip].send(msg);
    }
});

server.on("slave", function(slave) {
    console.log("slave connected", slave.ip, Object.keys(slave.environments));
    slave.activeClients = 0;
    slave.pendingEnvironments = false;
    insertSlave(slave);
    distribute({slave: slave});

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
        slave.removeAllListeners();
    });

    slave.on("jobFinished", function(job) {
        ++slave.jobsPerformed;
        console.log("slave", slave.ip, "performed a job", job);
    });
});

server.on("compile", function(compile) {
    let file;
    let slave;
    compile.on("job", function(request) {
        console.log("request", request.environment);
        if (!Environments.hasEnvironment(request.environment)) {
            compile.send({ type: "needsEnvironment" });
            return;
        }

        function score(s) {
            if (!s)
                return -Infinity;
            return Math.min(4, s.slots - s.activeClients);
        }
        let bestScore = -Infinity;
        forEachSlave(s => {
            if (!(request.environment in s.environments))
                return;

            let slaveScore = score(s);
            if (s > bestScore || (s == bestScore && s.lastJob < slave.lastJob)) {
                bestScore = s;
                slave = s;
            }
        });
        if (slave) {
            console.log("Got best", slave.ip, bestScore, slave.lastJob);
            ++slave.activeClients;
            ++slave.jobsScheduled;
            slave.lastJob = Date.now();
            compile.send("slave", { ip: slave.ip, hostname: slave.hostname, port: slave.port });
        } else {
            compile.send("slave", {});
        }
    });
    compile.on("error", msg => {
        if (slave) {
            --slave.activeClients;
            slave = undefined;
        }
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", event => {
        console.log("Client disappeared");
        compile.removeAllListeners();
        if (slave) {
            --slave.activeClients;
            slave = undefined;
        }
    });
});

server.on("uploadEnvironment", upload => {
    let file;
    let hash;
    upload.on("environment", environment => {
        file = Environments.prepare(environment);
        console.log("Got environment message", environment, typeof file);
        if (!file) {
            // we already have this environment
            console.error("already got environment", environment.message);
            upload.send({ error: "already got environment" });
            upload.close();
        } else {
            hash = environment.hash;
        }
    });
    upload.on("environmentdata", environment => {
        if (!file) {
            console.error("no pending file");
            upload.send({ error: "no pending file" });
            upload.close();
        }
        console.log("Got environmentdata message", environment.data.length, environment.last);
        file.save(environment.data).then(() => {
            if (environment.last) {
                file.close();
                upload.close();
                Environments.complete(file);
                file = undefined;
                // send any new environments to slaves
                distribute({hash: hash});
            }
        }).catch(err => {
            console.log("file error", err);
            file = undefined;
        });
    });
    upload.on("error", msg => {
        console.error(`upload error '${msg}' from ${upload.ip}`);
        if (file) {
            file.discard();
            file = undefined;
        }
    });
    upload.on("close", () => {
        upload.removeAllListeners();
        if (file) {
            file.discard();
            file = undefined;
        }
    });
});

server.on("error", err => {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.load(option("env-dir", path.join(common.cacheDir(), "environments"))).then(() => {
    server.listen();
}).catch(e => {
    console.error(e);
    process.exit();
});
