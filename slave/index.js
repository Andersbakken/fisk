const option = require("@jhanssen/options")("fisk-slave");
const Server = require("./src/server");
const Client = require("./src/client");
const load = require("./src/load");

const client = new Client(option);

client.on("environment", function(environ) {
    // environment from scheduler
});

client.on("connect", function() {
    console.log("connected");
    load.on("data", function(data) {
        console.log("sending load", data);
        client.send("load", data);
    });
    load.start(option("loadInterval", 1000));
});

client.on("error", function(err) {
    console.log("client error", err);
});

client.on("close", function() {
    console.log("client closed");
    load.removeAllListeners();
    if (load.running()) {
        load.stop();
    }
});

client.connect();

const server = new Server(option);

server.on("compile", function(compile) {
    compile.on("job", function(job) {
    });
    compile.on("data", function(data) {
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
