#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk/slave");
const common = require('../../common')(option);
const Server = require("./server");
const Client = require("./client");
const Compile = require("./compile");
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const VM = require('./VM');

let ports = ("" + option("ports", "")).split(',').filter(x => x).map(x => parseInt(x));
if (ports.length) {
    var children = ports.map(port => {
        let ret = child_process.fork(__filename, [
            "--port", port,
            "--name", option("name") + "_" + port,
            "--cache-dir", path.join(common.cacheDir(), "" + port),
            "--slots", Math.round(os.cpus().length / ports.length)
        ]);
        // ret.stdout.on('data', output => console.log(port, output));
        // ret.stderr.on('data', output => console.error(port, output));
        return ret;
    });
} else {
    let environments = {};
    const client = new Client(option);
    const environmentsRoot = path.join(common.cacheDir(), "environments");

    if (process.getuid() !== 0) {
        console.error("fisk slave needs to run as root to be able to chroot");
        process.exit(1);
    }

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
                            // let split = environmentsRoot.split('/');
                            // if (!user) {
                            //     if (split[0] == 'home' || split[0] == 'Users') {
                            //         user = split[1];
                            //     } else if (split[0] == 'usr' && split[1] == 'home') {
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
                                    environments[env.hash] = new VM(dir, env.hash, option("vm-user"));
                                } else {
                                    console.log("Removing directory", dir);
                                    fs.removeSync(dir);
                                }
                            } catch (err) {
                                console.error(`Got error loading environment ${files[i]} ${err.stack} ${err.message}`);
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
                environments[pendingEnvironment.hash] = new VM(pendingEnvironment.dir, pendingEnvironment.hash);
                console.log("STEP 4, sending environments back:", Object.keys(environments));
                client.send("environments", { environments: Object.keys(environments) });
                pendingEnvironment = undefined;
            }).catch((err) => {
                console.log("STEP 5");
                console.error("Got failure setting up environment", err);
                try {
                    fs.removeSync(pendingEnvironment.dir);
                } catch (rmdirErr) {
                    console.error("Failed to remove directory", pendingEnvironment.dir, rmdirErr);
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
        // load.start(option("loadInterval", 1000));
    });

    client.on("error", (err) => {
        console.error("client error", err);
    });

    client.on("close", () => {
        console.log("client closed");
        // if (load.running())
        //     load.stop();
        if (!connectInterval) {
            connectInterval = setInterval(() => {
                console.log("Reconnecting...");
                client.connect(Object.keys(environments));
            }, 1000);
        }
    });


    const server = new Server(option);

    server.on("job", (job) => {
        let vm = environments[job.hash];
        if (!vm) {
            console.error("No vm for this hash", job.hash);
            return;
        }
        console.log("job", job.argv0, Object.keys(job));
        let op = vm.startCompile(job.commandLine, job.argv0);
        op.on('stdout', data => job.send({ type: 'stdout', data: data }));
        op.on('stderr', data => job.send({ type: 'stderr', data: data }));
        op.on('finished', event => {
            // this can't be async, the directory is removed after the event is fired
            let contents = event.files.map(f => { return { contents: fs.readFileSync(f.absolute), path: f.path }; });
            job.send({
                type: 'response',
                index: contents.map(item => { return { path: item.path, bytes: item.contents.length }; }),
                exitCode: event.exitCode,
            });

            for (let i=0; i<contents.length; ++i) {
                job.send(contents[i].contents);
            }
            job.close();
            client.send("jobFinished", { client: { ip: job.ip, name: job.clientName }, sourceFile: event.sourceFile });
        });
        job.on("data", data => op.feed(data.data, data.last));
        job.on("error", (err) => {
            console.error("compile error", err);
        });
        job.on("close", () => {
            job.removeAllListeners();
        });
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
    start();
}
