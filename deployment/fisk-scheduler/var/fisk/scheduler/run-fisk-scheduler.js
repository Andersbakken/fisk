#!/usr/bin/env node

const child_process = require('child_process');
const fs = require("fs-extra");
const http = require("http");
const path = require('path');
const option = require('@jhanssen/options')({ prefix: 'fisk/scheduler',
                                              applicationPath: false,
                                              additionalFiles: [ "fisk/scheduler.conf.override" ] });

const port = option.int("port", 8097);
const root = option("root", "/var/fisk");

try {
    fs.mkdirpSync(root);
} catch (err) {
}

process.on("unhandledRejection", (reason, p) => {
    console.error("Unhandled Rejection at: Promise", p, "reason:", reason.stack);
});

process.on("unhandledException", exception => {
    console.error("Unhandled exception at: ", exception);
});

function npmTag()
{
    return option('npm-tag') || 'latest';
}

function npm(args, options)
{
    return new Promise((resolve, reject) => {
        let str = `Running /usr/bin/env npm ${args}`;
        if (options && options.cwd)
            str += ` in ${options.cwd}`;
        console.log(str);
        let proc = child_process.exec(`/usr/bin/env npm ${args}`, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }

            // if (stderr) {
            //     console.error(`stderr: ${stderr}`);
            // }
            resolve([stdout, stderr]);
        });
        proc.stdout.pipe(process.stdout);
        proc.stderr.pipe(process.stderr);
    });
}

// setInterval(() => {
//     console.log("foo", checkForUpdateActive);
// }, 5000);

let fisk;
let killed = false;
let lastStart = 0;
let checkForUpdateActive = false;

function startFisk()
{
    if (!fisk) {
        if (!checkForUpdateActive) {
            checkForUpdate();
        }

        const opts = {
            stdio: "inherit",
            cwd: path.join(root, "/prod/node_modules/@andersbakken/fisk/scheduler/")
        };

        lastStart = Date.now();
        fisk = child_process.fork("./fisk-scheduler.js", [ "--max_old_space_size=8192" ], opts);
        fisk.on("error", error => {
            console.log("Got error from fork", error, opts.cwd);
        });

        fisk.on("exit", args => {
            console.log("fisk exited: ", args);
            if (!killed) {
                fisk = undefined;
                if (Date.now() - lastStart > 10000) {
                    console.log("restarting in 1 second");
                    setTimeout(startFisk, 1000);
                } else {
                    console.log("something wrong with the fisk install, lets remove it");
                    let ret = child_process.exec(`rm -rf ${path.join(root, "prod")}`, () => setTimeout(checkForUpdate, 1000));
                }
            } else {
                killed = false;
            }
        });

        // fisk.on("close", () => console.log("got close"));
        // fisk.on("exit", () => console.log("got exit"));
        // fisk.on("disconnect", () => console.log("got disconnect"));
    }
}

function needsUpdate()
{
    return new Promise((resolve, reject) => {
        const packageDotJson = path.join(root, "/prod/node_modules/@andersbakken/fisk/package.json");
        if (!fs.existsSync(packageDotJson)) {
            resolve(true);
            return;
        }

        let currentVersion;
        try {
            currentVersion = JSON.parse(fs.readFileSync(packageDotJson)).version;
            if (!currentVersion) {
                console.log("Can't read current version from", packageDotJson);
                resolve(true);
                return undefined;
            }
        } catch (err) {
            console.log("Got an error trying to json parse package.json", packageDotJson, err);
            resolve(true);
            return;
        }
        const tag = npmTag();
        return npm("dist-tag ls @andersbakken/fisk").then(output => {
            try {
                const wanted = output[0].split('\n').filter(line => { return line.lastIndexOf(tag + ": ", 0) == 0; }).map(line => /.*: (.*)/.exec(line)[1])[0];
                console.log(`We have ${currentVersion}, need ${wanted} for tag: ${tag}`);
                resolve(wanted != currentVersion);
            } catch (err) {
                console.log("got an error parsing output", output[0], err);
                resolve(true);
            }
        }).catch(error => {
            console.log("Got an error getting dist-tag", error);
            resolve(true);
        });
    });
}

function updateFisk()
{
    return new Promise((resolve, reject) => {
        try {
            fs.mkdirpSync(path.join(root, "/prod"));
        } catch (err) {
        }
        try {
            fs.mkdirpSync(path.join(root, "/stage"));
        } catch (err) {
        }

        needsUpdate().then(update => {
            console.log("needsUpdate says", update);
            if (!update) {
                throw !fs.existsSync(path.join(root, "/prod/node_modules/@andersbakken/fisk/scheduler/fisk-scheduler.js"));
            } else {
                return npm("cache clear --force");
            }
        }).then(() => {
            return npm("init --yes", { cwd: path.join(root, "stage") });
        }).then(() => {
            const tag = npmTag();
            return npm(`install --save --unsafe-perm @andersbakken/fisk@${tag}`, { cwd: path.join(root, "stage") });
        }).then(() => {
            resolve(true);
        }).catch(result => {
            if (typeof result !== 'boolean') {
                console.error(`Something failed ${result}`);
                reject(result);
            } else {
                resolve(result);
            }
        });
    });
}

function copyToProd()
{
    return new Promise((resolve, reject) => {
        child_process.exec(`rm -rf ${path.join(root, "prod")} && mv ${path.join(root, "stage")} ${path.join(root, "prod")}`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function killFisk(state)
{
    return new Promise((resolve, reject) => {
        if (fisk) {
            killed = true;
            let id = setTimeout(() => {
                fisk.kill("SIGKILL");
            }, 5000);
            fisk.once("exit", () => {
                clearTimeout(id);
                fisk = undefined;
                resolve(state);
            });
            fisk.kill();
            return;
        }
        resolve(state);
    });
}

function checkForConnection()
{
    return new Promise((resolve, reject) => {
        if (!fisk) {
            resolve("not running");
            return;
        }
        const options = {
            host: "localhost",
            path: "/",
            port: port,
            method: "HEAD",
            timeout: 15000
        };
        const req = http.request(options, res => {
            resolve("connected");
        });
        req.on("error", error => {
            console.error("Got error trying to connect to webserver", error);
            resolve("not connected");
        });
        req.end();
    });
}

let checkForUpdateTimer;
function checkForUpdate()
{
    checkForUpdateActive = true;
    if (checkForUpdateTimer) {
        clearTimeout(checkForUpdateTimer);
        checkForUpdateTimer = undefined;
    }
    function final() // node 8 doesn't have finally
    {
        console.log("do I have fisk?", typeof fisk);
        if (!fisk)
            startFisk();
        checkForUpdateActive = false;
        checkForUpdateTimer = setTimeout(checkForUpdate, option.int("check-interval", 5 * 60000));
    }
    console.log("checking if fisk needs to be updated", typeof fisk);
    updateFisk().then(updated => {
        console.log("needs update is", updated);
        if (updated) {
            console.log("fisk is updated, stopping fisk");
            return "updated";
        } else {
            console.log("checking for connection");
            return checkForConnection();
        }
    }).then(state => {
        switch (state) {
        case "updated":
        case "not connected":
            break;
        case "connected":
        case "not running":
            throw false;
        }
        console.log("killing fisk");
        return killFisk(state);
    }).then(state => {
        console.log("fisk stopped, copying to prod");
        if (state == "updated")
            return copyToProd();
        return undefined;
    }).then(() => {
        console.log("Restarting fisk");
        final();
    }).catch(error => {
        console.log("got here", error);
        if (!error) {
            console.log("Nothing to update");
        } else {
            console.error(`Got error ${error}`);
        }
        final();
    });
}


process.on("SIGHUP", () => {
    console.log("got SIGHUP", checkForUpdateActive);
    if (!checkForUpdateActive)
        checkForUpdate();
});

checkForUpdate();
