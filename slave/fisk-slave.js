#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk/slave", require('minimist')(process.argv.slice(2)));
const request = require("request");
const common = require("../common")(option);
const Server = require("./server");
const Client = require("./client");
const Compile = require("./compile");
const bytes = require('bytes');
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const child_process = require("child_process");
const VM = require("./VM");
const load = require("./load");
const ObjectCache = require('./objectcache');

if (process.getuid() !== 0) {
    console.error("fisk slave needs to run as root to be able to chroot");
    process.exit(1);
}

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    if (client)
        client.send("log", { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason.stack}` });

});

process.on('uncaughtException', err => {
    console.error("Uncaught exception", err);
    if (client)
        client.send("log", { message: `Uncaught exception ${err.toString()} ${err.stack}` });
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

let objectCache;

function getFromCache(job, cb)
{
    // console.log("got job", job.md5, objectCache ? objectCache.state(job.md5) : false);
    // if (objectCache)
    //     console.log("objectCache", job.md5, objectCache.state(job.md5), objectCache.keys);
    if (!objectCache || objectCache.state(job.md5) != "exists")
        return false;
    const file = path.join(objectCache.dir, job.md5);
    if (!fs.existsSync(file)) {
        console.log("The file is not even there", file);
        objectCache.remove(job.md5);
        return false;
    }
    // console.log("we have it cached", job.md5);

    let pointOfNoReturn = false;
    let fd;
    try {
        let item = objectCache.get(job.md5);
        job.send(Object.assign({objectCache: true}, item.response));
        job.objectcache = true;
        pointOfNoReturn = true;
        fd = fs.openSync(path.join(objectCache.dir, item.response.md5), "r");
        // console.log("here", item.response);
        let pos = 4 + item.headerSize;
        let fileIdx = 0;
        const work = () => {
            // console.log("work", job.md5);
            function finish(err)
            {
                fs.closeSync(fd);
                if (err) {
                    objectCache.remove(job.md5);
                    job.close();
                } else {
                    ++item.cacheHits;
                }

                cb(err);
            }
            const file = item.response.index[fileIdx];
            if (!file) {
                finish();
                return;
            }
            const buffer = Buffer.allocUnsafe(file.bytes);
            // console.log("reading from", file, path.join(objectCache.dir, item.response.md5), pos);
            fs.read(fd, buffer, 0, file.bytes, pos, (err, read) => {
                // console.log("GOT READ RESPONSE", file, fileIdx, err, read);
                if (err || read != file.bytes) {
                    if (!err) {
                        err = `Short read ${read}/${file.bytes}`;
                    }
                    console.error(`Failed to read ${file.bytes} from ${path.join(objectCache.dir, item.response.md5)} got ${read} ${err}`);
                    finish(err);
                } else {
                    // console.log("got good response from file", file);
                    // console.log("sending some data", buffer.length, fileIdx, item.response.index.length);
                    job.send(buffer);
                    pos += read;
                    if (++fileIdx < item.response.index.length) {
                        work();
                    } else {
                        finish();
                    }
                }
            });
        };
        work();
        return true;
    } catch (err) {
        if (err.code != "ENOENT")
            console.error("Got some error here", err);
        if (fd)
            fs.closeSync(fd);
        if (pointOfNoReturn) {
            job.close();
            return true; // hehe
        }
        return false;
        // console.log("The cache handled it");
    }
}

let environments = {};
const client = new Client(option, common.Version);
client.on("objectCache", enabled => {
    let objectCacheSize = bytes.parse(option('object-cache-size'));
    if (enabled && objectCacheSize) {
        const objectCacheDir = option('object-cache-dir') || path.join(common.cacheDir(), 'objectcache');

        objectCache = new ObjectCache(objectCacheDir, objectCacheSize, option.int('object-cache-purge-size') || objectCacheSize);
        objectCache.on("added", data => {
            client.send({ type: "objectCacheAdded", md5: data.md5, sourceFile: data.sourceFile });
        });

        objectCache.on("removed", data => {
            client.send({ type: "objectCacheRemoved", md5: data.md5, sourceFile: data.sourceFile });
        });
    } else {
        objectCache = undefined;
    }
});

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
                                let opts = {
                                    user: option("vm-user"),
                                    keepCompiles: option("keep-compiles"),
                                    debug: option("debug")
                                };
                                let vm = new VM(dir, env.hash, opts);
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

client.on("clearObjectCache", () => {
    if (objectCache) {
        objectCache.clear();
    }
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

client.on("getEnvironments", message => {
    console.log(`Getting environments ${message.environments}`);
    let base = option("scheduler", "localhost:8097");
    let idx = base.indexOf("://");
    if (idx != -1)
        base = base.substr(idx + 3);
    base = "http://" + base;
    if (!/:[0-9]+$/.exec(base))
        base += ":8097";
    base += "/environment/";
    function work()
    {
        if (!message.environments.length) {
            setTimeout(() => {
                client.send("environments", { environments: Object.keys(environments) });
                console.log("Informing scheduler about our environments:", Object.keys(environments));
            }, option.int("inform-delay", 30000));
            return;
        }
        let env = message.environments.splice(0, 1)[0];
        const url = base + env;
        console.log("got url", url);

        const dir = path.join(environmentsRoot, env);
        try {
            fs.removeSync(dir);
        } catch (err) {
        }
        if (!fs.mkdirpSync(dir)) {
            console.error("Can't create environment directory for slave: " + dir);
            setTimeout(work, 0);
            return;
        }

        let file = path.join(dir, "env.tar.gz");
        let stream = fs.createWriteStream(file);
        request.get(url)
            .on('error', err => {
                console.log("Got error from request", err);
                stream.close();
                try {
                    fs.removeSync(dir);
                } catch (err) {
                }
                if (!fs.mkdirpSync(dir)) {
                    console.error("Can't create environment directory for slave: " + dir);
                    setTimeout(work, 0);
                }
                return;
            }).on('end', event => {
                stream.close();
                console.log("Got end", env);
                exec("tar xf '" + file + "'", { cwd: dir }).
                    then(() => {
                        console.log("Checking that the environment runs", path.join(dir, "bin", "true"));
                        return exec(`"${path.join(dir, "bin", "true")}"`, { cwd: dir });
                    }).then(() => {
                        console.log("Write json file");
                        return fs.writeFile(path.join(dir, "environment.json"), JSON.stringify({ hash: env, created: new Date().toString() }));
                    }).then(() => {
                        console.log(`Unlink ${file} ${env}`);
                        return fs.unlink(file);
                    }).then(() => {
                        let opts = {
                            user: option("vm-user"),
                            keepCompiles: option("keep-compiles"),
                            debug: option("debug")
                        };

                        let vm = new VM(dir, env, opts);
                        return new Promise((resolve, reject) => {
                            let done = false;
                            vm.on('error', err => {
                                if (!done) {
                                    reject(err);
                                }
                            });
                            vm.on('ready', () => {
                                done = true;
                                resolve(vm);
                            });
                        });
                    }).then(vm => {
                        environments[env] = vm;
                        setTimeout(work, 0);
                    }).catch((err) => {
                        console.error("Got failure setting up environment", err);
                        try {
                            fs.removeSync(dir);
                        } catch (rmdirErr) {
                            console.error("Failed to remove directory", dir, rmdirErr);
                        }
                        setTimeout(work, 0);
                    });
            }).pipe(stream);
    }
    work();
});

client.on("requestEnvironments", message => {
    console.log("scheduler wants us to inform of current environments", Object.keys(environments));
    client.send("environments", { environments: Object.keys(environments) });
});

client.on("connect", () => {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
    if (!load.running)
        load.start(option("loadInterval", 1000));
    if (objectCache)
        client.send({ type: "objectCache", md5s: objectCache.keys() });
});

client.on("error", err => {
    console.error("client error", err);
    if (load.running)
        load.stop();
});

client.on("close", () => {
    console.log("client closed");
    if (load.running)
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
    let wait = (jobQueue.length >= client.slots || (objectCache && objectCache.state(request.headers["x-fisk-md5"]) == "exists"));
    headers.push(`x-fisk-wait: ${wait}`);
});

function startPending()
{
    // console.log(`startPending called ${jobQueue.length}`);
    for (let idx=0; idx<jobQueue.length; ++idx) {
        let jj = jobQueue[idx];
        if (!jj.op && !jj.objectCache) {
            // console.log("starting jj", jj.id);
            jj.start();
            break;
        }
    }
}

server.on("job", job => {
    let vm = environments[job.hash];
    if (!vm) {
        console.error("No vm for this hash", job.hash);
        job.close();
        return;
    }
    const jobStartTime = Date.now();
    let uploadDuration;

    // console.log("sending to server");
    var j = {
        id: job.id,
        job: job,
        op: undefined,
        done: false,
        aborted: false,
        heartbeatTimer: undefined,
        buffers: [],
        stdout: "",
        stderr: "",
        start: function() {
            let job = this.job;
            if (getFromCache(job, err => {
                if (err) {
                    console.error("cache failed, let the client handle doing it itself");
                    job.close();
                } else {
                    // console.log("GOT STUFF", job);
                    let info = {
                        type: "cacheHit",
                        client: {
                            hostname: job.hostname,
                            ip: job.ip,
                            name: job.name,
                            user: job.user
                        },
                        sourceFile: job.sourceFile,
                        id: job.id
                    };
                    // console.log("sending cachehit", info);
                    client.send(info);

                    console.log("Job finished from cache", j.id, job.sourceFile, "for", job.ip, job.name);
                }
                j.done = true;
                let idx = jobQueue.indexOf(j);
                if (idx != -1)
                    jobQueue.splice(idx, 1);
                startPending();
            })) {
                j.objectCache = true;
                return;
            }
            client.send("jobStarted", {
                id: job.id,
                sourceFile: job.sourceFile,
                client: {
                    name: job.name,
                    hostname: job.hostname,
                    ip: job.ip,
                    user: job.user
                },
                slave: {
                    ip: job.slaveIp,
                    name: option("name"),
                    hostname: option("hostname") || os.hostname(),
                    port: server.port
                }
            });

            console.log("Starting job", j.id, job.sourceFile, "for", job.ip, job.name, job.wait);
            j.op = vm.startCompile(job.commandLine, job.argv0, job.id);
            j.buffers.forEach(data => j.op.feed(data.data, data.last));
            if (job.wait) {
                job.send("resume", {});
            }
            delete j.buffers;
            j.op.on("stdout", data => { j.stdout += data; }); // ### is there ever any stdout? If there is, does the order matter for stdout vs stderr?
            j.op.on("stderr", data => { j.stderr += data; });
            j.op.on("finished", event => {
                j.done = true;
                if (j.aborted)
                    return;
                let idx = jobQueue.indexOf(j);
                console.log("Job finished", j.id, job.sourceFile, "for", job.ip, job.name);
                if (idx != -1) {
                    jobQueue.splice(idx, 1);
                } else {
                    console.error("Can't find j?");
                    return;
                }

                // this can't be async, the directory is removed after the event is fired
                let contents = event.files.map(f => { return { contents: fs.readFileSync(f.absolute), path: f.path }; });
                let response = {
                    type: "response",
                    index: contents.map(item => { return { path: item.path, bytes: item.contents.length }; }),
                    success: event.success,
                    exitCode: event.exitCode,
                    md5: job.md5,
                    stderr: j.stderr,
                    stdout: j.stdout
                };
                job.send(response);
                if (event.success && objectCache && response.md5 && objectCache.state(response.md5) == 'none') {
                    response.sourceFile = job.sourceFile;
                    objectCache.add(response, contents);
                }

                for (let i=0; i<contents.length; ++i) {
                    job.send(contents[i].contents);
                }
                // job.close();
                const end = Date.now();
                // console.log("GOT ID", j);
                if (event.success) {
                    client.send("jobFinished", {
                        id: j.id,
                        cppSize: event.cppSize,
                        compileDuration: event.compileDuration,
                        compileSpeed: (event.cppSize / event.compileDuration),
                        uploadDuration: uploadDuration,
                        uploadSpeed: (event.cppSize / uploadDuration)
                    });
                } else {
                    client.send("jobAborted", {
                        id: j.id,
                        cppSize: event.cppSize,
                        compileDuration: event.compileDuration,
                        compileSpeed: (event.cppSize / event.compileDuration),
                        uploadDuration: uploadDuration,
                        uploadSpeed: (event.cppSize / uploadDuration)
                    });
                }
                startPending();
            });
        },
        cancel: function() {
            if (!j.done && j.op) {
                j.done = true;
                j.op.cancel();
            }
        }
    };

    job.heartbeatTimer = setInterval(() => {
        if (job.done || job.aborted) {
            clearTimeout(job.heartbeatTimer);
        } else {
            // console.log("sending heartbeat");
            job.send("heartbeat", {});
        }
    }, 5000);

    job.on("error", (err) => {
        job.webSocketError = `${err} from ${job.name} ${job.hostname} ${job.ip}`;
        console.error("got error from job", job.webSocketError);
        j.done = true;
    });
    job.on("close", () => {
        job.removeAllListeners();
        job.done = true;
        let idx = jobQueue.indexOf(j);
        if (idx != -1) {
            j.aborted = true;
            jobQueue.splice(idx, 1);
            j.cancel();
            client.send("jobAborted", { id: j.id, webSocketError: job.webSocketError });
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
        console.error(`Failed to initialize ${err.message}`);
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
