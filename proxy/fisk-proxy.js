#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk/proxy");
const WebSocket = require('ws');

let scheduler = option("scheduler", "ws://localhost:8097");
if (scheduler.indexOf('://') == -1)
    scheduler = "ws://" + scheduler;
if (!/:[0-9]+$/.exec(scheduler))
    scheduler += ":8097";
console.log("scheduler is", scheduler);

let server;
const port = option.int("port", 8099);
let tasks = {};
function handleConnection(ws, req)
{
    // console.log("got req", req.headers, req.url);

    if (req.url != "/compile") {
        console.log("Bad request", req.url);
        ws.close();
        return;
    }

    if (!req.headers["x-fisk-job-id"]) {
        try {
            // console.log(req.headers);
            let headers = {};
            for (let key in req.headers) {
                if (/^x-fisk-/.exec(key)) {
                    headers[key] = req.headers[key];
                }
            }
            let proxyWs = new WebSocket(`${scheduler}${req.url}`, { headers: headers });
            proxyWs.on("error", err => { console.error("Got error", err.message); });
            proxyWs.on("message", msg => {
                // console.log("Got message", msg);
                const message = JSON.parse(msg);
                if (message.type == "slave" && message.ip) {
                    let copy = JSON.parse(msg);
                    let ip = req.connection.remoteAddress;
                    if (ip.substr(0, 7) == "::ffff:") {
                        ip = ip.substr(7);
                    }
                    copy.ip = ip;
                    copy.port = port;
                    // console.log("sending copy", copy);
                    tasks[copy.id] = { ws: ws, slaveIp: message.ip, slavePort: message.port };
                    ws.send(JSON.stringify(copy));
                } else {
                    ws.send(msg);
                }
            });
            proxyWs.on("close", () => {
                // console.log("Got close");
                proxyWs = undefined;
                if (ws)
                    ws.close();
            });
            let pendingMessages = [];
            proxyWs.on("open", () => {
                // console.log("got open");
                pendingMessages.forEach(msg => { proxyWs.send(msg); });
                pendingMessages = undefined;
            });
            ws.on("close", () => {
                // console.log("Client closed");
                ws = undefined;
                if (proxyWs)
                    proxyWs.close();
            });
            ws.on("message", msg => {
                // console.log("Got message from client", msg);
                if (pendingMessages) {
                    pendingMessages.push(msg);
                } else {
                    proxyWs.send(msg);
                }
            });
        } catch (err) {
            console.log("Got error", err.toString());
            ws.close();
        }
    } else {
        let id = req.headers["x-fisk-job-id"];
        let task = tasks[id];
        delete tasks[id];
        let headers = {};
        let pendingMessages = [];
        for (let key in req.headers) {
            if (/^x-fisk-/.exec(key)) {
                headers[key] = req.headers[key];
            }
        }
        let proxyWs = new WebSocket(`ws://${task.slaveIp}:${task.slavePort}/compile`, { headers: headers });
        proxyWs.on("close", () => {
            // console.log("Got close 2");
            proxyWs = undefined;
            if (ws)
                ws.close();
        });
        proxyWs.on("open", () => {
            // console.log("got open 2");
            // console.log("got open");
            pendingMessages.forEach(msg => { proxyWs.send(msg); });
            pendingMessages = undefined;
        });

        ws.on("close", () => {
            // console.log("Client closed 2");
            ws = undefined;
            if (proxyWs)
                proxyWs.close();
        });
        ws.on("message", msg => {
            // console.log("Got message from client 2", msg, !!pendingMessages);
            if (pendingMessages) {
                pendingMessages.push(msg);
            } else {
                proxyWs.send(msg);
            }
        });

        proxyWs.on("message", msg => {
            // console.log("Got message from slave", msg);
            ws.send(msg);
        });

        console.log("Now to connect to the slave");
        // ws.on("close", () => {
        //     console.log("Client 2 closed");
        // });
        // ws.on("message", msg => {
        //     console.log("Got message 2 from client", msg);
        // });
    }
}

function listen()
{
    server = new WebSocket.Server({
        port: port,
        backlog: option.int("backlog", 50)
    });
    console.log("listening on", server.options.port);
    server.on("connection", handleConnection);
}

listen();
