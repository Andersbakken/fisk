
const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");
const http = require("http");
const express = require("express");

class Job extends EventEmitter {
    constructor(data) {
        super();
        for (let key in data)
            this[key] = data[key];
    }

    send(type, msg) {
        if (this.ws.readyState !== WebSocket.OPEN)
            return;
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
            console.error("got send error", this.id, type, err);
        }
    }

    get readyState() {
        return this.ws.readyState;
    }

    close() {
        this.closed = true;
        this.ws.close();
    }
};

class Server extends EventEmitter {
    constructor(option, configVersion) {
        super();
        this.option = option;
        this.id = 0;
        this.configVersion = configVersion;
        this.app = undefined;
    }

    listen() {
        this.app = express();
        this.emit("listen", this.app);
        this.port = this.option.int("port", 8096);

        this.server = http.createServer(this.app);
        this.ws = new WebSocket.Server({ noServer: true, backlog: this.option.int("backlog", 50) });
        this.server.listen({ port: this.port, backlog: this.option.int("backlog", 50), host: "0.0.0.0" });

        this.server.on("upgrade", (req, socket, head) => {
            this.ws.handleUpgrade(req, socket, head, (ws) => {
                this._handleConnection(ws, req);
            });
        });

        console.log("listening on", this.port);
        this.ws.on("headers", (headers, request) => {
            this.emit("headers", headers, request);
        });
    }

    _handleConnection(ws, req) {
        const connectTime = Date.now();
        let client = undefined;
        let bytes = undefined;
        let ip = req.connection.remoteAddress;
        let clientEmitted = false;
        const error = msg => {
            ws.send(`{"error": "${msg}"}`);
            ws.close();
            if (client && clientEmitted) {
                client.emit("error", msg);
            } else {
                this.emit("error", { ip: ip, message: msg });
            }
        };

        if (!ip) { // already closed
            // console.log(req.connection, ws.readyState);
            return;
        }
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

        const url = Url.parse(req.url);
        switch (url.pathname) {
        case "/compile":
            const hash = req.headers["x-fisk-environments"];
            if (!hash) {
                error("Bad ws request, no environments");
                return;
            }
            const name = req.headers["x-fisk-client-name"];
            const configVersion = req.headers["x-fisk-config-version"];
            if (configVersion != this.configVersion) {
                error(`Bad config version, expected ${this.configVersion}, got ${configVersion}`);
                return;
            }

            // console.log("GOT HEADERS", req.headers);
            client = new Job({ ws: ws,
                               ip: ip,
                               hash: hash,
                               name: name,
                               hostname: req.headers["x-fisk-client-hostname"],
                               user: req.headers["x-fisk-user"],
                               sourceFile: req.headers["x-fisk-sourcefile"],
                               sha1: req.headers["x-fisk-sha1"],
                               id: parseInt(req.headers["x-fisk-job-id"]),
                               builderIp: req.headers["x-fisk-builder-ip"] });

            break;
        default:
            error(`Invalid pathname ${url.pathname}`);
            return;
        }

        ws.on("message", msg => {
            switch (typeof msg) {
            case "string":
                // console.log("Got message", msg);
                if (bytes) {
                    // bad, client have to send all the data in a binary message before sending JSON
                    error(`Got JSON message while ${bytes} bytes remained of a binary message`);
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
                bytes = json.bytes;
                client.commandLine = json.commandLine;
                client.argv0 = json.argv0;
                client.connectTime = connectTime;
                client.wait = json.wait;
                this.emit("job", client);
                clientEmitted = true;
                break;
            case "object":
                if (msg instanceof Buffer) {
                    // console.log("Got binary", msg.length, bytes);
                    if (!msg.length) {
                        // no data?
                        error("No data in buffer");
                        return;
                    }
                    if (!bytes) {
                        error("Got binary message without a preceeding json message describing the data");
                        return;
                    }
                    if (msg.length !== bytes) {
                        // woops
                        error(`length ${msg.length} !== ${bytes}`);
                        return;
                    }
                    bytes = 0;
                    client.emit("data", { data: msg });
                }
                break;
            }
        });
        ws.on("close", () => {
            if (client && clientEmitted) {
                // console.error("GOT WS CLOSE", bytes, client.objectcache);
                client.emit("close");
            }
            ws.removeAllListeners();
        });
        ws.on("error", (error) => {
            console.log("GOT WS ERROR", error);
            if (client && clientEmitted)
                client.emit("error", error);
        });
    }
}

module.exports = Server;
