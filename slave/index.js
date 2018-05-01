const option = require("@jhanssen/options")("fisk-slave");
const Server = require("./src/server");
const Client = require("./src/client");
const load = require("./src/load");

const client = new Client(option);

let connectInterval;
client.on("environment", function(environ) {
    // environment from scheduler
});

load.on("data", function(data) {
    console.log("sending load", data);
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
    compile.on("job", function(job) {
    });
    compile.on("jobdata", function(data) {
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
