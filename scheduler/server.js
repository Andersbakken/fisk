const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");
const http = require("http");
const express = require("express");
const path = require("path");
const crypto = require("crypto");

class Client extends EventEmitter {
    constructor(object) {
        super();
        this.created = new Date();
        Object.assign(this, object);
        this.pingSent = undefined;
        this.ws.on("pong", () => {
            // console.log("got pong", this.name);
            this.pingSent = undefined;
        });
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

    ping() {
        if (this.option && this.pingSent) {
            const max = this.option.int("max-pong-interval", 60000);
            console.log("checking ping", max, Date.now() - max, this.pingSent);
            if (Date.now() - max > this.pingSent) {
                this.ws.close();
                return;
            }
        }
        this.ws.ping();
        this.pingSent = Date.now();
    }

    error(message) {
        try {
            this.ws.send(`{"error": "${message}"}`);
            this.ws.close();
            this.emit("error", message);
        } catch (err) {
        }
    }

    close() {
        this.ws.close();
    }
};

Client.Type = {
    Builder: 0,
    Compile: 1,
    UploadEnvironment: 2,
    Monitor: 3,
    ClientVerify: 4
};

class Server extends EventEmitter {
    constructor(option, configVersion) {
        super();
        this.option = option;
        this.configVersion = configVersion;
        this.id = 0;
        this.nonces = {};
        this.objectCache = undefined;
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.app = express();
            this.emit("listen", this.app);

            let ui = this.option("ui");
            if (ui) {
                this.app.all("/*", function(req, res, next) {
                    res.redirect(ui);
                });
            }

            this.server = http.createServer(this.app);
            this.ws = new WebSocket.Server({ noServer: true });
            const port = this.option.int("port", 8097);
            this.server.listen({ port: port, backlog: this.option.int("backlog", 1024), host: "0.0.0.0" });

            this.server.on("upgrade", (req, socket, head) => {
                this.ws.handleUpgrade(req, socket, head, (ws) => {
                    this._handleConnection(ws, req);
                });
            });

            this.ws.on("headers", (headers, request) => {
                const url = Url.parse(request.url);
                headers.push("x-fisk-object-cache: " + (this.objectCache ? "true" : "false"));
                if (url.pathname == "/monitor") {
                    const nonce = crypto.randomBytes(256).toString("base64");
                    headers.push(`x-fisk-nonce: ${nonce}`);
                    request.nonce = nonce;
                }
            });

            this.server.on("error", error => {
                if (error.code == "EADDRINUSE") {
                    console.log(`Port ${port} is in use...`);
                    setTimeout(() => {
                        this.server.listen({ port: port, backlog: this.option.int("backlog", 50), host: "0.0.0.0"});
                    }, 1000);
                } else {
                    console.error("Got server error", error.toString());
                    this.emit("error", error);
                }
            });
            this.server.once("listening", () => {
                console.log("listening on", port);
                resolve();
            });
        });
    }

    get express() { return this.app; }

    _handleCompile(req, client) {
        // look at headers
        if (!("x-fisk-environments" in req.headers)) {
            client.error("No x-fisk-environments header");
            return;
        }

        const configVersion = req.headers["x-fisk-config-version"];
        if (configVersion != this.configVersion) {
            client.error(`Bad config version, expected ${this.configVersion}, got ${configVersion}`);
            return;
        }
        const compileEnvironment = req.headers["x-fisk-environments"];

        let data = {
            environment: compileEnvironment,
            sourceFile: req.headers["x-fisk-sourcefile"],
            sha1: req.headers["x-fisk-sha1"]
        };

        if (data.sha1 && data.sha1.length != 40) {
            client.error(`Bad sha1 sum: ${data.sha1}`);
            return;
        }
        const npmVersion = req.headers["x-fisk-npm-version"];
        if (npmVersion)
            data.npmVersion = npmVersion;
        const preferredBuilder = req.headers["x-fisk-builder"];
        if (preferredBuilder)
            data.builder = preferredBuilder;
        const labels = req.headers["x-fisk-builder-labels"];
        if (labels) {
            data.labels = labels.split(/ +/).filter(x => x);
        }
        const clientName = req.headers["x-fisk-client-name"];
        if (clientName)
            data.name = clientName;
        const user = req.headers["x-fisk-user"];
        if (user)
            data.user = user;
        const clientHostname = req.headers["x-fisk-client-hostname"];
        if (clientHostname)
            data.hostname = clientHostname;
        Object.assign(client, data);
        this.emit("compile", client);
        let remaining = { bytes: undefined, type: undefined };
        client.ws.on("close", (status, reason) => client.emit("close", status, reason));
        client.ws.on("error", err => client.emit("error", err));
        client.ws.on("close", (code, reason) => {
            if (remaining.bytes)
                client.emit("error", "Got close while reading a binary message");
            if (client)
                client.emit("close", { code: code, reason: reason });
            client.ws.removeAllListeners();
        });

        client.ws.on("message", msg => {
            switch (typeof msg) {
            case "string":
                if (remaining.bytes) {
                    // bad, client have to send all the data in a binary message before sending JSON
                    client.error(`Got JSON message while ${remaining.bytes} bytes remained of a binary message`);
                    return;
                }
                // assume JSON
                let json;
                try {
                    json = JSON.parse(msg);
                } catch (e) {
                }
                if (json === undefined) {
                    client.error("Unable to parse string message as JSON");
                    return;
                }

                if (json.type == "log") {
                    client.emit("log", json);
                    return;
                }
                if (json.type != "uploadEnvironment") {
                    client.error("Expected type: \"uploadEnvironment\"");
                    return;
                }

                if (!("hash" in json)) {
                    console.log(json);
                    client.error("Need a hash property");
                    return;
                }
                if (!("bytes" in json)) {
                    console.log(json);
                    client.error("Need a bytes property");
                    return;
                }

                remaining.type = "uploadEnvironmentData";
                remaining.bytes = json.bytes;

                client.emit("uploadEnvironment", json);
                break;
            case "object":
                if (msg instanceof Buffer) {
                    if (!msg.length) {
                        // no data?
                        client.error("No data in buffer");
                        return;
                    }
                    if (!remaining.bytes) {
                        client.error("Got binary message without a preceeding json message describing the data");
                        return;
                    }
                    if (msg.length > remaining.bytes) {
                        // woops
                        client.error(`length ${msg.length} > ${remaining.bytes}`);
                        return;
                    }
                    remaining.bytes -= msg.length;
                    client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                }
                break;
            }
        });
    }

    _handleBuilder(req, client) {
        client.ws.on("close", (code, reason) => {
            client.emit("close", { code: code, reason: reason });
            client.ws.removeAllListeners();
        });

        client.ws.on("error", (code, reason) => {
            client.emit("close", { code: 1005, reason: "unknown" });
            client.ws.removeAllListeners();
        });

        if (!("x-fisk-port" in req.headers)) {
            client.error("No x-fisk-port header");
            return;
        }

        if (!("x-fisk-environments" in req.headers)) {
            client.error("No x-fisk-builder-environment header");
            return;
        }

        if (!("x-fisk-slots" in req.headers) || !parseInt(req.headers["x-fisk-slots"])) {
            client.error("No x-fisk-slots header");
            return;
        }

        const confVersion = req.headers["x-fisk-config-version"];
        if (confVersion != this.configVersion) {
            client.error(`Bad config version, expected ${this.configVersion}, got ${confVersion}`);
            return;
        }

        const port = parseInt(req.headers["x-fisk-port"]);
        const name = req.headers["x-fisk-builder-name"];
        const hostname = req.headers["x-fisk-builder-hostname"];
        let labels = req.headers["x-fisk-builder-labels"];
        if (labels)
            labels = labels.split(/ +/).filter(x => x);
        const system = req.headers["x-fisk-system"];
        const slots = parseInt(req.headers["x-fisk-slots"]);
        const npmVersion = req.headers["x-fisk-npm-version"];
        let environments = {};
        req.headers["x-fisk-environments"].replace(/\s+/g, "").split(";").forEach(env => {
            if (env)
                environments[env] = true;
        });
        Object.assign(client, {
            port: port,
            name: name,
            labels: labels,
            slots: slots,
            jobsPerformed: 0,
            jobsScheduled: 0,
            totalCompileSpeed: 0,
            totalUploadSpeed: 0,
            lastJob: 0,
            load: 0,
            npmVersion: npmVersion,
            hostname: hostname,
            environments: environments,
            system: system
        });
        client.ws.on("message", msg => {
            // console.log("Got message from builder", typeof msg, msg.length);
            switch (typeof msg) {
            case "string":
                // assume JSON
                let json;
                try {
                    json = JSON.parse(msg);
                } catch (e) {
                }

                if (json === undefined) {
                    client.error("Unable to parse string message as JSON");
                    return;
                }
                // console.log("Got message", json);
                if ("type" in json) {
                    client.emit(json.type, json);
                } else {
                    console.error("Bad message without type", json);
                }
            case "object":
                if (msg instanceof Buffer) {
                    client.emit("data", msg);
                }
                break;
            }
        });
        // console.log("Got dude", envs);
        this.emit("builder", client);
    }

    _handleMonitor(req, client) {
        client.nonce = req.nonce;
        // console.log("Got nonce", req.nonce);
        client.ws.on("message", message => client.emit("message", message));
        this.emit("monitor", client);
        client.ws.on("close", (code, reason) => {
            client.ws.removeAllListeners();
            client.emit("close", { code: code, reason: reason });
        });

        client.ws.on("error", err => client.emit("error", err));
    }

    _handleClientVerify(req, client) {
        Object.assign(client, {npmVersion: req.headers["x-fisk-npm-version"] });
        this.emit("clientVerify", client);
        client.ws.on("close", (code, reason) => {
            client.ws.removeAllListeners();
            client.emit("close", { code: code, reason: reason });
        });

        client.ws.on("error", err => client.emit("error", err));
    }

    _handleConnection(ws, req) {
        let client = undefined;
        let ip = req.connection.remoteAddress;
        // console.log("_handleConnection", ip);

        if (!ip) {
            ws.send("{\"error\": \"no ip for some reason\"}");
            ws.close();
            return;
        }
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

        const url = Url.parse(req.url);
        switch (url.pathname) {
        case "/compile":
            client = new Client({ type: Client.Compile, ws: ws, ip: ip });
            this._handleCompile(req, client);
            break;
        case "/builder":
            client = new Client({ type: Client.Builder, ws: ws, ip: ip, option: this.option });
            this._handleBuilder(req, client);
            break;
        case "/monitor":
            client = new Client({ type: Client.Type.Monitor, ws: ws, ip: ip });
            this._handleMonitor(req, client);
            break;
        case "/client_verify":
            client = new Client({ type: Client.Type.ClientVerify, ws: ws, ip: ip });
            this._handleClientVerify(req, client);
            break;
        default:
            console.error(`Invalid pathname ${url.pathname} from: ${ip}`);
            ws.close();
            return;
        }
    }
}

module.exports = Server;
