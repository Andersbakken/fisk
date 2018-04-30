#!/usr/bin/env node
const fs = require('fs');
const child_process = require('child_process');
const WebSocket = require('ws');

const argv = require('minimist')(process.argv.slice(2));
const silent = argv.silent;
let tarball;
let scheduler;

if (!argv.scheduler || !argv.hash || !argv.compiler || !argv.host) {
    console.log(argv);
    if (!silent) {
        console.error("Bad args, need --scheduler, --hash, --host and --compiler");
    }
    process.exit(1);
}
if (!/\/$/.exec(argv.scheduler)) {
    scheduler = argv.scheduler + '/';
} else {
    scheduler = argv.scheduler;
}

function die()
{
    if (!silent) {
        console.error.apply(console, arguments);
    }
    if (tarball) {
        try {
            fs.unlinkSync(tarball);
        } catch (err) {

        }
    }
    process.exit(1);
}

function makeTarball()
{
    console.log("Got called");
    return new Promise((resolve, reject) => {
        console.log("balls", `${__dirname}/icecc-create-env`);
        let out = "";
        let err = "";

        const package = child_process.spawn(`${__dirname}/icecc-create-env`, [ argv.compiler ], { shell: true, cwd: "/tmp" });
        package.stdout.on('data', (data) => {
            out += data;
        });

        package.stderr.on('data', (data) => {
            err += data;
        });

        package.on('close', (code) => {
            if (!code) {
                let lines = out.split('\n').filter(x => x);
                var line = lines[lines.length - 1]
                console.log(lines);
                console.log("This is it", line);
                tarball = line.split(" ")[1];
                console.log(tarball);
                resolve(`/tmp/${tarball}`);
            } else {
                die(`icecc-create-env exited with code: ${code}\n${err}`);
            }
            console.log(`child process exited with code ${code}`);
        });
    });
}

function connectWs()
{
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(argv.scheduler,
                                 [],
                                 {
                                     'headers': {
                                         'x-fisk-hash': argv.hash
                                     }
                                 });


        ws.on('open', function open() {
            resolve(ws);
        });

        ws.on('message', function incoming(data) {
            if (!silent)
                console.log("Got message from scheduler", data);
        });
    });
}

Promise.all([ makeTarball(), connectWs() ]).then((data) => {
    let ws = data[1];
    let size;
    try {
        size = fs.statSync(data[0]).size;
    } catch (err) {
        die("Got error ", err.toString());
    }
    // console.log("Got data", data, size);
    var f = fs.openSync(data[0], "r");
    if (!f) {
        die(`Failed to open file ${data[0]} for reading`);
    }
    
    ws.send(JSON.stringify({ hash: argv.hash, bytes: size, host: argv.host }));
    console.log("sent text message", size);
    const chunkSize = 16384;
    let sent = 0;
    let buf = Buffer.allocUnsafe(chunkSize);
    for (let i=0; i<size; i += chunkSize) {
        let s = Math.min(size - i, chunkSize);
        if (s < chunkSize) {
            buf = Buffer.alloc(s);
        }
        if (fs.readSync(f, buf, 0, s) != s) {
            die("Failed to read bytes from enviroment");
        }
        sent += s;
        ws.send(buf);
    }
    console.log(`sent ${sent} bytes`);
}).catch((err) => {
    die(err);
});
