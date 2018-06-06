const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");
const http = require('http');
const express = require('express');

class Client extends EventEmitter {
    constructor(obj) {
        super();
        for (let key in obj)
            this[key] = obj[key];
        this.created = new Date();
    }

    send(type, msg) {
        try {
            if (msg === undefined) {
                if (type instanceof Buffer) {
                    this.ws.send(type);
                } else {
                    this.ws.send(JSON.stringify(type));
                }
            } else {
                let tosend;
                if (typeof msg === "object") {
                    tosend = msg;
                    tosend.type = type;
                } else {
                    tosend = { type: type, message: msg };
                }
                this.ws.send(JSON.stringify(tosend));
            }
        } catch (err) {

        }
    }

    close() {
        this.ws.close();
    }
};

Client.Type = {
    Slave: 0,
    Compile: 1,
    UploadEnvironment: 2
};

class Server extends EventEmitter {
    constructor(option) {
        super();
        this.option = option;
        this.app = express();
        this.id = 0;
    }

    listen() {
        this.server = http.createServer(this.app);
        this.ws = new WebSocket.Server({ server: this.server });
        const port = this.option.int("port", 8097);
        this.server.listen(port, this.option.int("backlog", 50));
        console.log("listening on", port);
        this.ws.on("connection", (ws, req) => { this._handleConnection(ws, req); });
    }

    get express() { return this.app; }

    _handleConnection(ws, req) {
        let client = undefined;
        let remaining = { bytes: undefined, type: undefined };
        let ip = req.connection.remoteAddress;
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

        console.log("_handleConnection", ip);

        const error = msg => {
            ws.send(`{"error": "${msg}"}`);
            ws.close();
            if (client) {
                client.emit("error", msg);
            } else {
                this.emit("error", { ip: ip, message: msg });
            }
        };

        const url = Url.parse(req.url);
        switch (url.pathname) {
        case "/compile":
            // look at headers
            if (!("x-fisk-environments" in req.headers)) {
                error("No x-fisk-environments header");
                return;
            }
            const compileEnvironments = req.headers["x-fisk-environments"].replace(/\s+/g, '').split(';').filter(x => x);

            let data = {
                ws: ws,
                ip: ip,
                type: Client.Type.Compile,
                environments: compileEnvironments
            };
            const preferredSlave = req.headers["x-fisk-slave"];
            if (preferredSlave)
                data.slave = preferredSlave;
            const clientName = req.headers["x-fisk-client-name"];
            if (clientName)
                data.name = clientName;
            client = new Client(data);
            this.emit("compile", client);
            ws.on('close', (status, reason) => client.emit('close', status, reason));
            ws.on('error', err => client.emit('error', err));
            break;
        case "/slave":
            if (!("x-fisk-port" in req.headers)) {
                error("No x-fisk-port header");
                return;
            }

            if (!("x-fisk-environments" in req.headers)) {
                error("No x-fisk-slave-environment header");
                return;
            }

            if (!("x-fisk-slots" in req.headers) || !parseInt(req.headers["x-fisk-slots"])) {
                error("No x-fisk-slots header");
                return;
            }

            const port = parseInt(req.headers["x-fisk-port"]);
            const name = req.headers["x-fisk-slave-name"];
            const hostname = req.headers["x-fisk-slave-hostname"];
            const system = req.headers["x-fisk-system"];
            const slots = parseInt(req.headers["x-fisk-slots"]);
            console.log(req.headers);
            let environments = {};
            req.headers["x-fisk-environments"].replace(/\s+/g, '').split(';').forEach(env => {
                if (env)
                    environments[env] = true;
            });
            client = new Client({ ws: ws,
                                  ip: ip,
                                  port: port,
                                  type: Client.Type.Slave,
                                  name: name,
                                  slots: slots,
                                  jobsPerformed: 0,
                                  jobsScheduled: 0,
                                  lastJob: 0,
                                  hostname: hostname,
                                  environments: environments,
                                  system: system });
            ws.on("message", msg => {
                let json;
                try {
                    json = JSON.parse(msg);
                } catch (e) {
                }
                if (json === undefined) {
                    error("Unable to parse string message as JSON");
                    return;
                }
                // console.log("GOT MESSAGE", json);
                if ("type" in json) {
                    client.emit(json.type, json);
                }
            });
            // console.log("Got dude", envs);
            this.emit("slave", client);
            break;
        case "/uploadenvironment":
            client = new Client({ws: ws, ip: ip, type: Client.Type.UploadEnvironment});
            this.emit("uploadEnvironment", client);

            ws.on("message", msg => {
                switch (typeof msg) {
                case "string":
                    if (remaining.bytes) {
                        // bad, client have to send all the data in a binary message before sending JSON
                        error(`Got JSON message while ${remaining.bytes} bytes remained of a binary message`);
                        return;
                    }
                    // assume JSON
                    let json;
                    try {
                        json = JSON.parse(msg);
                    } catch (e) {
                    }
                    if (json === undefined) {
                        error("Unable to parse string message as JSON");
                        return;
                    }
                    if (!("system" in json)) {
                        error("Need a systen property");
                        return;
                    }
                    if (!("hash" in json)) {
                        error("Need a hash property");
                        return;
                    }
                    if (!("bytes" in json)) {
                        error("Need a bytes property");
                        return;
                    }

                    remaining.type = "environmentdata";
                    remaining.bytes = json.bytes;

                    client.emit("environment", json);

                    break;
                case "object":
                    if (msg instanceof Buffer) {
                        if (!msg.length) {
                            // no data?
                            error("No data in buffer");
                            return;
                        }
                        if (!remaining.bytes) {
                            error("Got binary message without a preceeding json message describing the data");
                            return;
                        }
                        if (msg.length > remaining.bytes) {
                            // woops
                            error(`length ${msg.length} > ${remaining.bytes}`);
                            return;
                        }
                        remaining.bytes -= msg.length;
                        client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                    }
                    break;
                }
            });

            break;
        default:
            error(`Invalid pathname ${url.pathname}`);
            return;
        }

        ws.on("close", (code, reason) => {
            if (remaining.bytes)
                client.emit("error", "Got close while reading a binary message");
            if (client)
                client.emit("close", { code: code, reason: reason });
            ws.removeAllListeners();
        });
    }
}

module.exports = Server;
