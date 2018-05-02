#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk-slave");
const Server = require("./src/server");
const Client = require("./src/client");
const load = require("./src/load");
const Compile = require("./src/compile");

const client = new Client(option);

let connectInterval;
client.on("environment", function(environ) {
    // environment from scheduler
});

load.on("data", function(data) {
    // console.log("sending load", data);
    client.send("load", data);
});

client.on("connect", function() {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
    load.start(option("loadInterval", 1000));
});

client.on("error", function(err) {
    console.log("client error", err);
});

client.on("close", function() {
    console.log("client closed");
    if (load.running())
        load.stop();
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log("Reconnecting...");
            client.connect();
        }, 1000);
    }
});


client.connect();

const server = new Server(option);

server.on("compile", function(compile) {
    let commandLine;
    compile.on("job", function(job) {
        commandLine = job.commandLine;
    });
    compile.on("jobdata", function(data) {
        if (data.last) {
            console.log("Got data", data.data.length, commandLine);
            let c = new Compile(commandLine, data.data);
            c.on('stdout', data => { console.log("Got stdout", data); compile.send({ type: 'stdout', data: data }); });
            c.on('stderr', data => { console.log("Got stderr", data); compile.send({ type: 'stderr', data: data }); });
            c.on('exit', event => {
                compile.send({
                    type: 'response',
                    index: event.files.map(item => {
                        return { path: item.path, bytes: item.contents.length };
                    }),
                    exitCode: event.exitCode,
                });
                for (var i=0; i<event.files.length; ++i) {
                    compile.send(event.files[i].contents);
                }
                compile.close();
            });

            // compile.send({ type: "response", index: [ { path: "fisk.c.o", bytes: 984 }, { path: "fisk.c.d", bytes: 100 } ] });
            // var dotO = Buffer.allocUnsafe(984);
            // compile.send(dotO);
            // var dotD = Buffer.allocUnsafe(100);
            // compile.send(dotD);
        }

    });
    compile.on("error", function(err) {
        console.error("compile error", err);
    });
    compile.on("close", function() {
        compile.removeAllListeners();
    });
});

server.on("error", function(err) {
    console.error("server error", err);
});

server.listen();
