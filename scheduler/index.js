const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk-scheduler");
const Server = require("./src/server");
const Environments = require("./src/environments");
const server = new Server(option);

const slaves = {};

server.on("slave", function(slave) {
    console.log("slave connected", slave.ip);
    slaves[slave.ip] = { client: slave };
    slave.on("load", function(load) {
        console.log("slave load", load);
        slaves[slave.ip].load = load.message;
    });
    slave.on("environments", function(environs) {
        slaves[slave.ip].environments = environs;
        // send the slave any new environments
        for (var k in Environments.environments) {
            if (environs.indexOf(k) === -1) {
                Environments.environments[k].send(slave);
            }
        }
    });
    slave.on("error", function(msg) {
        console.error(`slave error '${msg}' from ${slave.ip}`);
    });
    slave.on("close", function() {
        delete slaves[slave.ip];
        slave.removeAllListeners();
    });
});

server.on("compile", function(compile) {
    compile.on("job", function(request) {
        /*
        if (!(request.environment in environments)) {
            compile.send("slave", { needsEnvironment: true });
            return;
        }
        */

        let best = { load: Infinity };
        for (let ip in slaves) {
            let slave = slaves[ip];
            if ("load" in slave && "environments" in slave) {
                if (/*slave.environments.indexOf(request.environment) !== -1 &&*/ slave.load < best.load) {
                    best.load = slave.load;
                    best.ip = ip;
                }
            }
        }
        if (best.load < Infinity) {
            compile.send("slave", { ip: best.ip });
        } else {
            compile.send("slave", {});
        }
    });
    compile.on("environment", function(environ) {
        if (!Environments.prepare(environ)) {
            // we already have this environment
            console.error("already got environment", environ.message);
            compile.send({ "error": "already got environment" });
            compile.close();
        }
    });
    compile.on("environmentdata", function(environ) {
        Environments.save(environ).then(() => {
            if (environ.last) {
                Environments.complete();
                // send any new environments to slaves
                for (var ip in slaves) {
                    let slave = slaves[ip];
                    for (var ek in Environments.environments) {
                        if (slave.environments.indexOf(ek) === -1) {
                            Environments.environments[ek].send(slave.client);
                        }
                    }
                }
            }});
    });
    compile.on("error", function(msg) {
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", function() {
        compile.removeAllListeners();
    });
});

server.on("error", function(err) {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.load(option("env-dir", path.join(os.homedir(), ".cache", "fisk", "environs"))).then(() => {
    server.listen();
}).catch(e => {
    console.error(e);
    process.exit();
});
