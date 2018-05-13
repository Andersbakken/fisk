#!/usr/bin/env node

const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk/scheduler");
const Server = require("./server");
const common = require('../../common')(option);
const Environments = require("./environments");
const server = new Server(option);

const slaves = {};

function distribute(conf)
{
    let ips;
    if (conf && conf.slave) {
        if (conf.pendingEnvironments)
            return;
        ips = [ conf.slave.ip ];
    } else {
        ips = Object.keys(slaves);
    }
    let hashes;
    if (conf && conf.hash) {
        hashes = [ conf.hash ];
    } else {
        hashes = Object.keys(Environments.environments);
    }
    console.log("distribute", ips, hashes);
    for (var h=0; h<hashes.length; ++h) {
        let hash = hashes[h];
        for (let i=0; i<ips.length; ++i) {
            let ip = ips[i];
            let slave = slaves[ip];
            if (!slave.pendingEnvironments && slave.environments && slave.environments.indexOf(hash) === -1) {
                console.log("sending", hash, "to", ip);
                Environments.environment(hash).send(slave.client);
                slave.pendingEnvironments = true;
                break;
            }
        }
    }
}

server.on("slave", function(slave, environments) {
    console.log("slave connected", slave.ip, environments);
    slaves[slave.ip] = { client: slave, environments: environments, pendingEnvironments: false };
    distribute({slave: slave});

    slave.on('environments', function(message) {
        slaves[slave.ip].environments = message.environments;
        slave.pendingEnvironments = false;
        distribute({slave: slave});
    });

    slave.on("load", function(load) {
        // console.log("slave load", load);
        slaves[slave.ip].load = load.message;
    });
    slave.on("error", function(msg) {
        console.error(`slave error '${msg}' from ${slave.ip}`);
    });
    slave.on("close", function() {
        delete slaves[slave.ip];
        slave.removeAllListeners();
    });

    slave.on("jobFinished", function(job) {
        console.log("slave", slave.ip, "performed a job", job);
    });
});

server.on("compile", function(compile) {
    let file;
    compile.on("job", function(request) {
        console.log("request", request.environment);
        if (!Environments.hasEnvironment(request.environment)) {
            compile.send({ type: "needsEnvironment" });
            return;
        }

        let best = { load: Infinity };
        for (let ip in slaves) {
            let slave = slaves[ip];
            if ("load" in slave && "environments" in slave) {
                if (slave.environments.indexOf(request.environment) !== -1 && slave.load < best.load) {
                    best.load = slave.load;
                    best.ip = ip;
                    best.slavePort = slave.client.slavePort;
                }
            }
        }
        console.log("best", best);
        if (best.load < Infinity) {
            compile.send("slave", { ip: best.ip, port: best.slavePort });
        } else {
            compile.send("slave", {});
        }
    });
    compile.on("error", function(msg) {
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", function() {
        compile.removeAllListeners();
    });
});

server.on("uploadEnvironment", function(upload) {
    let file;
    let hash;
    upload.on("environment", function(environment) {
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
    upload.on("environmentdata", function(environment) {
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
    upload.on("error", function(msg) {
        console.error(`upload error '${msg}' from ${upload.ip}`);
        if (file) {
            file.discard();
            file = undefined;
        }
    });
    upload.on("close", function() {
        upload.removeAllListeners();
        if (file) {
            file.discard();
            file = undefined;
        }
    });
});

server.on("error", function(err) {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.load(option("env-dir", path.join(common.cacheDir(), "environments"))).then(() => {
    server.listen();
}).catch(e => {
    console.error(e);
    process.exit();
});
