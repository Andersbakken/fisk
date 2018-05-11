#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk-slave");
const Server = require("./src/server");
const Client = require("./src/client");
const load = require("./src/load");
const Compile = require("./src/compile");
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

let environments = [];
const client = new Client(option);
const environmentsRoot = path.join(os.homedir(), ".cache", "fisk", "slave", "environments");

function loadEnvironments()
{
    return new Promise((resolve, reject) => {
        fs.readdir(environmentsRoot, (err, files) => {
            console.log("GOT FILES", files);
            if (err) {
                if (err.code == "ENOENT") {
                    fs.mkdirp(environmentsRoot).then(() => {
                        resolve();
                    }).catch((err) => {
                        reject(new Error("Failed to create directory " + err.message));
                    });
                    return;
                }
                reject(err);
            } else {
                if (files) {
                    for (var i=0; i<files.length; ++i) {
                        try {
                            let dir = path.join(environmentsRoot, files[i]);
                            let stat = fs.statSync(dir);
                            console.log("HERE", dir);
                            if (!stat.isDirectory()) {
                                fs.removeSync(dir);
                                continue;
                            }
                            var env = JSON.parse(fs.readFileSync(path.join(dir, "environment.json")));
                            if (env.hash) {
                                environments.push({hash: env.hash, dir: dir});
                            } else {
                                fs.removeSync(dir);
                            }
                        } catch (err) {
                            console.error(`Got error loading environment ${files[i]} ${err.message}`);
                        }
                    }
                }
                resolve();
            }
        });
    });
}

let pendingEnvironment;
let connectInterval;
client.on("environment", message => {
    if (pendingEnvironment) {
        throw new Error("We already have a pending environment");
    }
    if (!message.hash) {
        throw new Error("Bad environment without hash");
    }

    console.log("Got env", message);
    const dir = path.join(environmentsRoot, message.hash);
    try {
        fs.removeSync(dir);
    } catch (err) {
    }
    if (!fs.mkdirpSync(dir)) {
        throw new Error("Can't create environment directory for slave: " + dir);
    }

    let file = path.join(dir, "env.tar.gz");
    let fd = fs.openSync(file, "w");
    if (fd == -1)
        throw new Error("Couldn't open file " + file + " for writing");
    pendingEnvironment = { hash: message.hash, fd: fd, dir: dir, file: file, done: false };
    // environment from scheduler
});

function exec(command, options)
{
    return new Promise((resolve, reject) => {
        child_process.exec(command, options, (err, stdout, stderr) => {
            if (stderr) {
                console.error("Got stderr from", command);
            }
            if (err) {
                reject(new Error(`Failed to run command ${command}: ${err.message}`));
            } else {
                console.log(command, "finished");
                resolve();
            }
        });
    });
}

client.on("data", message => {
    if (!pendingEnvironment || pendingEnvironment.done)
        throw new Error("We're not expecting data");

    if (message.last)
        pendingEnvironment.done = true;

    fs.writeSync(pendingEnvironment.fd, message.data);
    if (!message.last)
        return;

    exec("tar xf '" + pendingEnvironment.file + "'", { cwd: pendingEnvironment.dir }).
        then(() => {
            console.log("STEP 1");
            return exec(path.join(pendingEnvironment.dir, "bin", "true"), { cwd: pendingEnvironment.dir });
        }).then(() => {
            console.log("STEP 2");
            return fs.writeFile(path.join(pendingEnvironment.dir, "environment.json"), JSON.stringify({ hash: pendingEnvironment.hash, created: new Date().toString() }));
        }).then(() => {
            console.log("STEP 3");
            return fs.unlink(pendingEnvironment.file);
        }).then(() => {
            console.log("STEP 4");
            client.send("environment", { hash: pendingEnvironment.hash });
            environments.push({ hash: pendingEnvironment.hash, dir: pendingEnvironment.dir });
            pendingEnvironment = undefined;
        }).catch((err) => {
            console.log("STEP 5");
            console.error("Got failure setting up environment", err);
            try {
                fs.removeSync(pendingEnvironment.dir);
            } catch (rmdirErr) {
                console.error("Failed to remove directory", dir, rmdirErr);
            }
            pendingEnvironment = undefined;
        });
});

client.on("connect", () => {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
    load.start(option("loadInterval", 1000));
});

load.on("data", (data) => {
    // console.log("sending load", data);
    client.send("load", data);
});

client.on("error", (err) => {
    console.error("client error", err);
});

client.on("close", () => {
    console.log("client closed");
    if (load.running())
        load.stop();
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log("Reconnecting...");
            client.connect(environments);
        }, 1000);
    }
});


const server = new Server(option);

server.on("compile", (compile) => {
    let commandLine;
    compile.on("job", (job) => {
        commandLine = job.commandLine;
    });
    compile.on("jobdata", (data) => {
        if (data.last) {
            // console.log("Got data", data.data.length, commandLine);
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
    compile.on("error", (err) => {
        console.error("compile error", err);
    });
    compile.on("close", () => {
        compile.removeAllListeners();
    });
});

server.on("error", (err) => {
    console.error("server error", err);
});

function start() {
    loadEnvironments().then(() => {
        console.log(`Loaded ${environments.length} from ${environmentsRoot}`);
        client.connect(environments);
        server.listen();
    }).catch((err) => {
        console.error(`Failed to load environments ${err.message}`);
        setTimeout(start, 1000);
    });
}
start();
