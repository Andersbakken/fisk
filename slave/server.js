
const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");

class Job extends EventEmitter {
    constructor(data) {
        super();
        for (let key in data)
            this[key] = data[key];
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
            console.error("got send error", type, err);
        }
    }

    get readyState() {
        return this.ws.readyState;
    }

    close() {
        this.ws.close();
    }
};

class Server extends EventEmitter {
    constructor(option, configVersion) {
        super();
        this.option = option;
        this.id = 0;
        this.configVersion = configVersion;
    }

    listen() {
        this.port = this.option.int("port", 8096);
        this.ws = new WebSocket.Server({
            port: this.port,
            backlog: this.option.int("backlog", 50)
        });
        console.log("listening on", this.ws.options.port);
        this.ws.on("connection", (ws, req) => { this._handleConnection(ws, req); });
        this.ws.on('headers', (headers, request) => this.emit('headers', headers, request));
    }


    _handleConnection(ws, req) {
        const connectTime = Date.now();
        let client = undefined;
        let bytes = undefined;
        let ip = req.connection.remoteAddress;
        const error = msg => {
            ws.send(`{"error": "${msg}"}`);
            ws.close();
            if (client) {
                client.emit("error", msg);
            } else {
                this.emit("error", { ip: ip, message: msg });
            }
        };

        if (!ip) {
            error("No ip");
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
                               md5: req.headers["x-fisk-md5"],
                               id: parseInt(req.headers["x-fisk-job-id"]),
                               slaveIp: req.headers["x-fisk-slave-ip"] });

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
                break;
            case "object":
                if (msg instanceof Buffer) {
                    // console.log("Got binary", msg.length, bytes);
                    if (!msg.length) {
                        // no data?
                        console.error("No data in buffer");
                        return;
                    }
                    if (!bytes) {
                        error("Got binary message without a preceeding json message describing the data");
                        return;
                    }
                    if (msg.length > bytes) {
                        // woops
                        error(`length ${msg.length} > ${bytes}`);
                        return;
                    }
                    bytes -= msg.length;
                    // console.log("Emitting", "data", { data: msg.length, last: !bytes });
                    client.emit("data", { data: msg, last: !bytes });
                }
                break;
            }
        });
        ws.on("close", () => {
            // console.log("GOT WS CLOSE");
            if (bytes && !client.objectcache)
                client.emit("error", "Got close while reading a binary message");
            if (client)
                client.emit("close");
            ws.removeAllListeners();
        });
        ws.on("error", (error) => {
            // console.log("GOT WS ERROR");
            if (client)
                client.emit("error", error);
        });
    }
}

module.exports = Server;
