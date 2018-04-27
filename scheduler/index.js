/*global require*/

const option = require("@jhanssen/options")("fisk-scheduler");
const Server = require("./src/server");
const server = new Server(option);

const slaves = {};

server.on("slave", function(slave) {
    slaves[slave.ip] = {};
    slave.on("load", function(load) {
        slaves[slave.ip].load = slave.load;
    });
    slave.on("environments", function(environs) {
        slave[slave.ip].environs = environs;
    });
    slave.on("close", function() {
        delete slaves[slave.ip];
        slave.removeAllListeners();
    });
});

server.on("compile", function(compile) {
    compile.on("requestSlave", function(request) {
        let best = { load: Infinity };
        for (let ip in slaves) {
            let slave = slaves[ip];
            if ("load" in slave) {
                if (slave.load < best.load) {
                    best.load = slave.load;
                    best.ip = ip;
                }
            }
        }
        if (best.load < Infinity) {
            compile.send("requestSlave", { ip: best.ip });
        } else {
            compile.send("requestSlave", {});
        }
    });
    compile.on("environment", function(environ) {
        // distribute environment to slaves
    });
    compile.on("close", function() {
        compile.removeAllListeners();
    });
});

server.on("error", function(err) {
    console.error(`error '${err.message}' from ${err.ip}`);
});

server.listen();
