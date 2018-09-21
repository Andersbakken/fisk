#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk/slave");
const common = require("../common")(option);
const Server = require("./server");
const Client = require("./client");
const Compile = require("./compile");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const child_process = require("child_process");
const VM = require("./VM");
const load = require("./load");

if (process.getuid() !== 0) {
    console.error("fisk slave needs to run as root to be able to chroot");
    process.exit(1);
}

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
});

let ports = ("" + option("ports", "")).split(",").filter(x => x).map(x => parseInt(x));
if (ports.length) {
    var name = option("name") || option("hostname") || os.hostname();
    var children = ports.map(port => {
        let ret = child_process.fork(__filename, [
            "--port", port,
            "--name", name + "_" + port,
            "--cache-dir", path.join(common.cacheDir(), "" + port),
            "--slots", Math.round(os.cpus().length / ports.length)
        ]);
        // ret.stdout.on("data", output => console.log(port, output));
        // ret.stderr.on("data", output => console.error(port, output));
        return ret;
    });
    process.exit();
}

let environments = {};
const client = new Client(option, common.Version);
const environmentsRoot = path.join(common.cacheDir(), "environments");

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

function loadEnvironments()
{
    return new Promise((resolve, reject) => {
        fs.readdir(environmentsRoot, (err, files) => {
            // console.log("GOT FILES", files);
            if (err) {
                if (err.code == "ENOENT") {
                    fs.mkdirp(environmentsRoot).then(() => {
                        // let user = option("fisk-user");
                        // let split = environmentsRoot.split("/");
                        // if (!user) {
                        //     if (split[0] == "home" || split[0] == "Users") {
                        //         user = split[1];
                        //     } else if (split[0] == "usr" && split[1] == "home") {
                        //         user = split[2];
                        //     }
                        // }
                        // if (!user) {
                        //     user = process.env["SUDO_USER"];
                        // }
                        // if (user) {
                        //     let p = "";
                        //     split.forEach(element => {
                        //         p += "/" + element;
                        // });
                        resolve();
                    }).catch((err) => {
                        reject(new Error("Failed to create directory " + err.message));
                    });
                    return;
                }
                reject(err);
            } else {
                if (files) {
                    let pending = 0;
                    for (let i=0; i<files.length; ++i) {
                        try {
                            let dir = path.join(environmentsRoot, files[i]);
                            let stat = fs.statSync(dir);
                            if (!stat.isDirectory()) {
                                fs.removeSync(dir);
                                continue;
                            }
                            let file, env;
                            try {
                                file = fs.readFileSync(path.join(dir, "environment.json"));
                                env = JSON.parse(fs.readFileSync(path.join(dir, "environment.json")));
                            } catch (err) {
                            }
                            if (env && env.hash) {
                                let vm = new VM(dir, env.hash, option("vm-user"), option("keep-compiles"));
                                ++pending;
                                environments[env.hash] = vm;
                                let errorHandler = () => {
                                    if (!vm.ready && !--pending) {
                                        resolve();
                                    }
                                };
                                vm.once('error', errorHandler);
                                vm.once('ready', () => {
                                    vm.ready = true;
                                    vm.removeListener("error", errorHandler);
                                    if (!--pending)
                                        resolve();
                                });
                            } else {
                                console.log("Removing directory", dir);
                                fs.removeSync(dir);
                            }
                        } catch (err) {
                            console.error(`Got error loading environment ${files[i]} ${err.stack} ${err.message}`);
                        }
                    }
                    if (!pending)
                        resolve();
                }
            }
        });
    });
}

let pendingEnvironment;
let connectInterval;
client.on("quit", message => {
    console.log(`Server wants us to quit: ${message.code || 0} purge environments: ${message.purgeEnvironments}`);
    if (message.purgeEnvironments) {
        try {
            fs.removeSync(environmentsRoot);
        } catch (err) {
            console.error("Failed to remove environments", environmentsRoot);
        }
    }
    process.exit(message.code);
});

client.on("dropEnvironments", message => {
    console.log(`Dropping environments ${message.environments}`);
    message.environments.forEach(env => {
        var environment = environments[env];
        if (environment) {
            const dir = path.join(environmentsRoot, env);
            console.log(`Purge environment ${env} ${dir}`);
            environment.destroy();
            delete environments[env];
        }
    });
});

client.on("requestEnvironments", message => {
    console.log("scheduler wants us to inform of current environments", Object.keys(environments));
    client.send("environments", { environments: Object.keys(environments) });
});

client.on("environment", message => {
    if (pendingEnvironment) {
        throw new Error("We already have a pending environment");
    }
    if (!message.hash) {
        throw new Error("Bad environment without hash");
    }

    if (message.hash in environments) {
        throw new Error("We already have this environment: " + message.hash);
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

let pendingVMS = 0;
client.on("data", message => {
    if (!pendingEnvironment || pendingEnvironment.done)
        throw new Error("We're not expecting data");

    if (message.last)
        pendingEnvironment.done = true;

    fs.writeSync(pendingEnvironment.fd, message.data);
    if (!message.last)
        return;

    fs.closeSync(pendingEnvironment.fd);
    pendingEnvironment.fd = undefined;

    var pending = pendingEnvironment;
    pendingEnvironment = undefined;

    console.log(`untar ${pending.file}`);
    ++pendingVMS;
    function inform()
    {
        if (!--pendingVMS && !pendingEnvironment) {
            client.send("environments", { environments: Object.keys(environments) });
            console.log("Informing scheduler about our environments:", Object.keys(environments), pendingEnvironment);
        }
    }
    exec("tar xf '" + pending.file + "'", { cwd: pending.dir }).
        then(() => {
            console.log("Checking that the environment runs", path.join(pending.dir, "bin", "true"));
            return exec(`"${path.join(pending.dir, "bin", "true")}"`, { cwd: pending.dir });
        }).then(() => {
            console.log("Write json file");
            return fs.writeFile(path.join(pending.dir, "environment.json"), JSON.stringify({ hash: pending.hash, created: new Date().toString() }));
        }).then(() => {
            console.log(`Unlink ${pending.file} ${pending.hash}`);
            return fs.unlink(pending.file);
        }).then(() => {
            environments[pending.hash] = new VM(pending.dir, pending.hash);
            inform();
        }).catch((err) => {
            console.error("Got failure setting up environment", err);
            try {
                fs.removeSync(pending.dir);
            } catch (rmdirErr) {
                console.error("Failed to remove directory", pending.dir, rmdirErr);
            }
            inform();
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
            client.connect(Object.keys(environments));
        }, 1000);
    }
});


const server = new Server(option, common.Version);
let jobQueue = [];

server.on('headers', (headers, request) => {
    // console.log("request is", request.headers);
    headers.push(`x-fisk-wait: ${jobQueue.length >= client.slots}`);
});

function startPending()
{
    // console.log(`startPending called ${jobQueue.length}`);
    for (let idx=0; idx<jobQueue.length; ++idx) {
        let jj = jobQueue[idx];
        if (!jj.op) {
            // console.log("starting jj", jj.id);
            jj.start();
            break;
        }
    }
}

server.on("job", (job) => {
    let vm = environments[job.hash];
    if (!vm) {
        console.error("No vm for this hash", job.hash);
        job.close();
        return;
    }
    const jobStartTime = Date.now();
    let uploadDuration;

    client.send("jobStarted", {
        id: job.id,
        sourceFile: job.sourceFile,
        client: {
            name: job.name,
            hostname: job.hostname,
            ip: job.ip,
        },
        slave: {
            ip: job.slaveIp,
            name: option("name"),
            hostname: option("hostname") || os.hostname(),
            port: server.port
        }
    });
    // console.log("sending to server");
    var j = {
        id: job.id,
        job: job,
        op: undefined,
        done: false,
        heartbeatTimer: undefined,
        buffers: [],
        start: function() {
            let job = this.job;
            this.heartbeatTimer = setInterval(() => {
                // console.log("sending heartbeat");
                job.send("heartbeat", {});
            }, 5000);
            console.log("Starting job", this.id, job.sourceFile, "for", job.ip, job.name, job.wait);
            this.op = vm.startCompile(job.commandLine, job.argv0);
            this.buffers.forEach(data => this.op.feed(data.data, data.last));
            if (job.wait) {
                job.send("resume", {});
            }
            delete this.buffers;
            this.op.on("stdout", data => job.send({ type: "stdout", data: data }));
            this.op.on("stderr", data => job.send({ type: "stderr", data: data }));
            this.op.on("finished", event => {
                this.done = true;
                let idx = jobQueue.indexOf(j);
                console.log("Job finished", this.id, job.sourceFile, "for", job.ip, job.clientName);
                if (idx != -1) {
                    jobQueue.splice(idx, 1);
                } else {
                    console.error("Can't find j?");
                    return;
                }

                // this can't be async, the directory is removed after the event is fired
                let contents = event.files.map(f => { return { contents: fs.readFileSync(f.absolute), path: f.path }; });
                job.send({
                    type: "response",
                    index: contents.map(item => { return { path: item.path, bytes: item.contents.length }; }),
                    exitCode: event.exitCode
                });

                for (let i=0; i<contents.length; ++i) {
                    job.send(contents[i].contents);
                }
                if (this.heartbeatTimer) {
                    clearTimeout(this.heartbeatTimer);
                    this.heartbeatTimer = undefined;
                }

                // job.close();
                const end = Date.now();
                // console.log("GOT ID", j);
                client.send("jobFinished", {
                    id: j.id,
                    cppSize: event.cppSize,
                    compileDuration: event.compileDuration,
                    compileSpeed: (event.cppSize / event.compileDuration),
                    uploadDuration: uploadDuration,
                    uploadSpeed: (event.cppSize / uploadDuration)
                });
                startPending();
            });
        },
        cancel: function() {
            if (!this.done && this.op) {
                this.op.cancel();
            }
            if (this.heartbeatTimer) {
                clearTimeout(this.heartbeatTimer);
                this.heartbeatTimer = undefined;
            }
        }
    };

    job.on("error", (err) => {
        console.error("got error from job", err);
    });
    job.on("close", () => {
        job.removeAllListeners();
        let idx = jobQueue.indexOf(j);
        if (idx != -1) {
            jobQueue.splice(idx, 1);
            j.cancel();
            client.send("jobAborted", { id: j.id });
            startPending();
        }
    });

    job.on("data", data => {
        // console.log("got data", this.id, data.last, typeof j.op);
        if (data.last)
            uploadDuration = Date.now() - jobStartTime;
        if (!j.op) {
            j.buffers.push(data);
            console.log("buffering...", j.buffers.length);
        } else {
            j.op.feed(data.data, data.last);
        }
    });

    jobQueue.push(j);
    if (jobQueue.length <= client.slots) {
        // console.log(`starting j ${j.id} because ${jobQueue.length} ${client.slots}`);
        j.start();
    } else {
        // console.log(`j ${j.id} is backlogged`, jobQueue.length, client.slots);
    }
});

server.on("error", (err) => {
    console.error("server error", err);
});

function start() {
    loadEnvironments().then(() => {
        console.log(`Loaded ${Object.keys(environments).length} environments from ${environmentsRoot}`);
        console.log("environments", Object.keys(environments));
        client.connect(Object.keys(environments));
        server.listen();
    }).catch((err) => {
        console.error(`Failed to load environments ${err.message}`);
        setTimeout(start, 1000);
    });
}
load.on("data", measure => {
    // console.log("Got load", measure);
    try {
        client.send("load", { measure: measure });
    } catch (err) {
    }
});
start();
