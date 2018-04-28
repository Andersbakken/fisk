const option = require("@jhanssen/options")("fisk-scheduler");
const Server = require("./src/server");
const Environments = require("./src/environments");
const server = new Server(option);

const slaves = {};
let environments;

server.on("slave", function(slave) {
    console.log("slave connected", slave.ip);
    slaves[slave.ip] = { client: slave };
    slave.on("load", function(load) {
        console.log("slave load", load);
        slaves[slave.ip].load = load.message;
    });
    slave.on("environments", function(environs) {
        slave[slave.ip].environments = environs;
        // send the slave any new environments
        for (var k in environments) {
            // ### should verify that the slave has the right architechture here
            if (environs.indexOf(k) === -1) {
                environments[k].send(slave);
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
        // save environment and distribute to slaves
        Environments.save(environ);
        // ### should verify that the slave has the right architechture here
        for (var ip in slaves) {
            let slave = slaves[ip];
            slave.client.send(environ);
        }
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

Environments.load(envs => {
    environments = envs;
    server.listen();
});
