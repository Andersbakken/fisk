/*global require*/

const option = require("@jhanssen/options")("fisk-scheduler");
const Server = require("./src/server");
const server = new Server(option);

const slaves = {};

server.on("load", function(slave) {
    if (!(slave.ip in slaves))
        slaves[slave.ip] = {};
    slaves[slave.ip].load = slave.load;
});

server.on("close", function(client) {
    if (client.slave)
        delete slaves[client.ip];
});

server.on("requestSlave", function(client) {
    // find a slave
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
        client.send("requestSlave", { ip: best.ip });
    } else {
        client.send("requestSlave", {});
    }
});

server.on("error", function(error) {
    throw error;
});

server.on("environment", function(environ) {
    // distribute environment to slaves
});

server.listen();
