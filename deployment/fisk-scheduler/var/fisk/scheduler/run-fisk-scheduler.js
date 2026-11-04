#!/usr/bin/env node

const child_process = require("child_process");
const fs = require("fs-extra");
const http = require("http");
const path = require("path");
const option = require("@jhanssen/options")({
    prefix: "fisk/scheduler",
    applicationPath: false,
    additionalFiles: ["fisk/scheduler.conf.override"]
});

const port = option.int("port", 8097);
const root = option("root", "/var/fisk");

try {
    fs.mkdirpSync(root);
} catch (err) {}

process.on("unhandledRejection", (reason, p) => {
    console.error("Unhandled Rejection at: Promise", p, "reason:", reason.stack);
});

process.on("unhandledException", (exception) => {
    console.error("Unhandled exception at: ", exception);
});

function npmTag() {
    return option("npm-tag") || "latest";
}

function npm(args, options) {
    return new Promise((resolve, reject) => {
        let str = `Running npm ${args}`;
        if (options && options.cwd) {
            str += ` in ${options.cwd}`;
        }
        console.log(str);
        let proc = child_process.exec(`npm ${args}`, options, (error, stdout, stderr) => {
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

function startFisk() {
    if (!fisk) {
        if (!checkForUpdateActive) {
            checkForUpdate();
        }

        const opts = {
            stdio: "inherit",
            cwd: path.join(root, "/prod/node_modules/@andersbakken/fisk/scheduler/"),
            execArgv: ["--max-old-space-size=8192"]
        };

        lastStart = Date.now();
        fisk = child_process.fork("./fisk-scheduler.js", [], opts);
        fisk.on("error", (error) => {
            console.log("Got error from fork", error, opts.cwd);
        });

        fisk.on("exit", (args) => {
            console.log("fisk exited: ", args);
            if (!killed) {
                fisk = undefined;
                if (Date.now() - lastStart > 10000) {
                    console.log("restarting in 1 second");
                    setTimeout(startFisk, 1000);
                } else {
                    console.log("something wrong with the fisk install, lets remove it");
                    let ret = child_process.exec(`rm -rf ${path.join(root, "prod")}`, () =>
                        setTimeout(checkForUpdate, 1000)
                    );
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

function needsUpdate() {
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

        // Check if tag is a version number (starts with digit or contains dots like "4.0.36")
        // If so, compare directly instead of looking up in dist-tag
        if (/^[\d.]/.test(tag)) {
            console.log(`We have ${currentVersion}, want ${tag} (version number)`);
            resolve(tag !== currentVersion);
            return;
        }

        return npm("dist-tag ls @andersbakken/fisk")
            .then((output) => {
                try {
                    const wanted = output[0]
                        .split("\n")
                        .filter((line) => {
                            return line.lastIndexOf(tag + ": ", 0) == 0;
                        })
                        .map((line) => /.*: (.*)/.exec(line)[1])[0];
                    console.log(`We have ${currentVersion}, need ${wanted} for tag: ${tag}`);
                    resolve(wanted != currentVersion);
                } catch (err) {
                    console.log("got an error parsing output", output[0], err);
                    resolve(true);
                }
            })
            .catch((error) => {
                console.log("Got an error getting dist-tag", error);
                resolve(true);
            });
    });
}

async function updateFisk() {
    try {
        fs.mkdirpSync(path.join(root, "/prod"));
    } catch (err) {}
    try {
        fs.mkdirpSync(path.join(root, "/stage"));
    } catch (err) {}

    const update = await needsUpdate();
    console.log("needsUpdate says", update);
    if (!update) {
        // No new version available, but if the scheduler file is missing
        // something's wrong with the install -- trigger a restart anyway.
        const schedulerFile = path.join(root, "/prod/node_modules/@andersbakken/fisk/scheduler/fisk-scheduler.js");
        return !fs.existsSync(schedulerFile);
    }

    await npm("cache clear --force");
    await npm("init --yes", { cwd: path.join(root, "stage") });

    // Pin node-addon-api to a version whose C++ requirements are met by the
    // system compiler on this host. The scheduler runs on old distros whose
    // g++ predates C++17, so we cannot use the default (currently
    // node-addon-api ^8.x -> C++17). node-addon-api 5.x is C++11, which
    // works on gcc 4.8+, and the fisk-native.cpp surface (HandleScope /
    // Value / Object / String / Error / Null) has been stable since 1.x.
    // This is an npm `overrides` block so it takes effect on any transitive
    // install of node-addon-api, including fisk-native's.
    const stagePkgPath = path.join(root, "stage", "package.json");
    const stagePkg = JSON.parse(fs.readFileSync(stagePkgPath));
    stagePkg.overrides = Object.assign({}, stagePkg.overrides, {
        "node-addon-api": "5.1.0"
    });
    fs.writeFileSync(stagePkgPath, JSON.stringify(stagePkg, null, 2));

    const tag = npmTag();
    await npm(`install --save --unsafe-perm @andersbakken/fisk@${tag} --node-gyp-version=8.4.1`, {
        cwd: path.join(root, "stage")
    });
    return true;
}

function copyToProd() {
    return new Promise((resolve, reject) => {
        child_process.exec(
            `rm -rf ${path.join(root, "prod")} && mv ${path.join(root, "stage")} ${path.join(root, "prod")}`,
            (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            }
        );
    });
}

function killFisk(state) {
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

const connectionTimeout = option.int("connection-timeout", 120000);
const connectionFailureThreshold = option.int("connection-failure-threshold", 3);
const connectionGracePeriod = option.int("connection-grace-period", 60000);
let consecutiveConnectionFailures = 0;

function checkForConnection() {
    return new Promise((resolve, reject) => {
        if (!fisk) {
            resolve("not running");
            return;
        }
        // Prefer the fork IPC channel: if the child process is still
        // connected over IPC it is alive as a process; a busy HTTP event
        // loop is not proof of death. Only fall through to the HTTP probe
        // when IPC is gone.
        if (fisk.connected === false || fisk.exitCode !== null || fisk.signalCode !== null) {
            resolve("not connected");
            return;
        }
        // Give the scheduler a grace window after (re)start before we
        // start counting probe failures against it. On a heavily loaded
        // scheduler the accept queue can back up for tens of seconds.
        if (Date.now() - lastStart < connectionGracePeriod) {
            resolve("connected");
            return;
        }
        const options = {
            host: "localhost",
            path: "/",
            port: port,
            method: "HEAD",
            timeout: connectionTimeout
        };
        let settled = false;
        const done = (state) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(state);
        };
        const req = http.request(options, (res) => {
            res.resume();
            done("connected");
        });
        req.on("timeout", () => {
            console.error(`Connection probe to :${port} timed out after ${connectionTimeout}ms`);
            req.destroy(new Error("probe timeout"));
        });
        req.on("error", (error) => {
            console.error("Got error trying to connect to webserver", error);
            done("not connected");
        });
        req.end();
    });
}

let checkForUpdateTimer;
async function checkForUpdate() {
    checkForUpdateActive = true;
    if (checkForUpdateTimer) {
        clearTimeout(checkForUpdateTimer);
        checkForUpdateTimer = undefined;
    }

    try {
        console.log("checking if fisk needs to be updated", typeof fisk);
        const updated = await updateFisk();
        console.log("needs update is", updated);

        let state;
        if (updated) {
            console.log("fisk is updated, stopping fisk");
            state = "updated";
        } else {
            console.log("checking for connection");
            state = await checkForConnection();
        }

        if (state === "connected" || state === "not running") {
            if (state === "connected") {
                consecutiveConnectionFailures = 0;
            }
            console.log("Nothing to update");
        } else if (state === "not connected") {
            consecutiveConnectionFailures += 1;
            console.log(
                `Connection probe failed (${consecutiveConnectionFailures}/${connectionFailureThreshold})`
            );
            if (consecutiveConnectionFailures < connectionFailureThreshold) {
                console.log("Not killing fisk yet, will re-probe next cycle");
            } else {
                console.log("killing fisk");
                await killFisk(state);
                consecutiveConnectionFailures = 0;
                console.log("fisk stopped");
                console.log("Restarting fisk");
            }
        } else {
            console.log("killing fisk");
            await killFisk(state);
            consecutiveConnectionFailures = 0;
            console.log("fisk stopped, copying to prod");
            if (state === "updated") {
                await copyToProd();
            }
            console.log("Restarting fisk");
        }
    } catch (error) {
        console.error(`Got error ${error}`);
    } finally {
        console.log("do I have fisk?", typeof fisk);
        if (!fisk) {
            startFisk();
        }
        checkForUpdateActive = false;
        checkForUpdateTimer = setTimeout(checkForUpdate, option.int("check-interval", 5 * 60000));
    }
}

process.on("SIGHUP", () => {
    console.log("got SIGHUP", checkForUpdateActive);
    if (!checkForUpdateActive) {
        checkForUpdate();
    }
});

checkForUpdate();
