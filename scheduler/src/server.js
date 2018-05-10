const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");

class Client extends EventEmitter {
    constructor(obj) {
        super();
        for (let key in obj)
            this[key] = obj[key];
    }

    send(type, msg) {
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
        this.id = 0;
    }

    listen() {
        this.ws = new WebSocket.Server({
            port: this.option.int("port", 8097),
            backlog: this.option.int("backlog", 50)
        });
        console.log("listening on", this.ws.options.port);
        this.ws.on("connection", (ws, req) => { this._handleConnection(ws, req); });
    }

    _handleConnection(ws, req) {
        let client = undefined;
        let remaining = { bytes: undefined, type: undefined };
        let ip = req.connection.remoteAddress;
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

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
            if (!("x-fisk-environment" in req.headers)) {
                error("No x-fisk-environment header");
                return;
            }
            const environment = req.headers["x-fisk-environment"];

            client = new Client({ws: ws, ip: ip, type: Client.Type.Compile});
            this.emit("compile", client);

            process.nextTick(() => {
                client.emit("job", { environment: environment });
            });
            break;
        case "/slave":
            if (!("x-fisk-slave-port" in req.headers)) {
                error("No x-fisk-slave-port header");
                return;
            }

            if (!("x-fisk-environment" in req.headers)) {
                error("No x-fisk-slave-environment header");
                return;
            }
            const slavePort = parseInt(req.headers["x-fisk-slave-port"]);
            client = new Client({ws: ws, ip: ip, slavePort: slavePort, type: Client.Type.Slave });
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
                if ("type" in json)
                    client.emit(json.type, json);
            });
            let envs = req.headers["x-fisk-environment"].replace(/\s+/g, '').split(';').filter(x => x);
            this.emit("slave", client, envs);
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
                    if (!("host" in json)) {
                        error("Need a host property");
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

        ws.on("close", () => {
            if (remaining.bytes)
                client.emit("error", "Got close while reading a binary message");
            if (client)
                client.emit("close");
            ws.removeAllListeners();
        });
    }
}

module.exports = Server;
