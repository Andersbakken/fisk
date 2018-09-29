#!/usr/bin/env nodejs

const child_process = require('child_process');
const fs = require('fs');

process.on("unhandledRejection", (reason, p) => {
    console.log("Unhandled Rejection at: Promise", p, "reason:", reason.stack);
});

function removeDirContents(path)
{
    function go(path, rmdir) {
        if (fs.existsSync(path)) {
            fs.readdirSync(path).forEach(function(file, index){
                const curPath = path + "/" + file;
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    go(curPath, true);
                } else { // delete file
                    fs.unlinkSync(curPath);
                }
            });
            if (rmdir)
                fs.rmdirSync(path);
        }
    }
    go(path, false);
}

function npm(args, options)
{
    return new Promise((resolve, reject) => {
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

let fisk;
let killed = false;
function startFisk()
{
    if (!fisk) {
        fisk = child_process.execFile("node", [ "./fisk-scheduler.js" ],
                                      { cwd: "/var/fisk/prod/node_modules/@andersbakken/fisk/scheduler/" }, (error, stdout, stderr) => {
                                          console.log("fisk exited: ", error);
                                          if (!killed) {
                                              fisk = undefined;
                                              console.log("restarting in 1 second");
                                              setTimeout(startFisk, 1000);
                                          } else {
                                              killed = false;
                                          }

                                      });
        fisk.stdout.pipe(process.stdout);
        fisk.stderr.pipe(process.stderr);
    }
}

function needsUpdate()
{
    return new Promise((resolve, reject) => {
        if (fs.existsSync("/var/fisk/stage/node_modules/@andersbakken/fisk/scheduler/fisk-scheduler.js")) {
            npm("outdated @andersbakken/fisk", { cwd: "/var/fisk/stage" }).then(() => {
                resolve(false);
            }).catch(error => {
                resolve(true);
            });
        } else {
            resolve(true);
        }
    });
}

function updateFisk()
{
    return new Promise((resolve, reject) => {
        // console.log("0");
        try {
            fs.mkdirSync("/var/fisk/prod");
        } catch (err) {
        }
        try {
            fs.mkdirSync("/var/fisk/stage");
        } catch (err) {
        }

        needsUpdate().then(update => {
            console.log("1", update);
            if (!update) {
                throw !fs.existsSync("/var/fisk/prod/node_modules/@andersbakken/fisk/scheduler/fisk-scheduler.js");
            } else {
                return npm("cache clear --force");
            }
        }).then(() => {
            console.log("a");
            return npm("install --unsafe-perm @andersbakken/fisk", { cwd: "/var/fisk/stage" });
        }).then(() => {
            console.log("b");
            return npm("install", { cwd: "/var/fisk/stage/node_modules/@andersbakken/fisk/ui" });
        }).then(() => {
            console.log("c");
            return npm("run dist", { cwd: "/var/fisk/stage/node_modules/@andersbakken/fisk/ui" });
        }).then(() => {
            console.log("d");
            resolve(true);
        }).catch(error => {
            // console.log("got error", error);
            if (typeof error !== 'boolean') {
                console.error(`Something failed ${error}`);
                reject(error);
            } else {
                resolve(error);
            }
        });
    });
}

function copyToProd()
{
    return new Promise((resolve, reject) => {
        child_process.exec("rm -rf /var/fisk/prod && cp -ra /var/fisk/stage /var/fisk/prod", (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function killFisk()
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
                resolve();
            });
            fisk.kill();
            return;
        }
        resolve();
    });
}

function checkForUpdate()
{
    function final() // node 8 doesn't have finally
    {
        console.log("do I have fisk?", typeof fisk);
        if (!fisk)
            startFisk();
        setTimeout(checkForUpdate, 5 * 60000);

    }
    console.log("checking if fisk needs to be updated");
    updateFisk().then(updated => {
        if (!updated) {
            throw undefined;
        }
        console.log("fisk is updated, stopping fisk");
        return killFisk();
    }).then(() => {
        console.log("fisk stopped, copying to prod");
        return copyToProd();
    }).then(() => {
        console.log("Fisk updated, restarting");
        final();
    }).catch(error => {
        if (!error) {
            console.log("Nothing to update");
        } else {
            console.error(`Got error ${error}`);
        }
        final();
    });
}

checkForUpdate();

