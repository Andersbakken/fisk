const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");

const BinaryTypes = {
    // 0 and 1 is a special type that denotes a new compile or slave
    2: "environment"
};

class Compile extends EventEmitter {
    constructor(ws, ip) {
        super();
        this.ws = ws;
        this.ip = ip;
    }

    send(type, msg) {
        if (msg === undefined) {
            this.ws.send(JSON.stringify(type));
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
};

class Server extends EventEmitter {
    constructor(option) {
        super();
        this.option = option;
        this.id = 0;
    }

    listen() {
        this.ws = new WebSocket.Server({
            port: this.option("port", 8096),
            backlog: this.option("backlog", 50)
        });
        console.log("listening on", this.ws.options.port);
        this.ws.on("connection", this._handleConnection);
    }

    _handleConnection(ws, req) {
        let client = undefined;
        let remaining = { bytes: undefined, type: undefined };
        const ip = req.connection.remoteAddress;

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
            client = new Compile(ws, ip);
            this.emit("compile", client);
            break;
        default:
            error(`Invalid pathname ${url.pathname}`);
            return;
        }

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
                if ("type" in json) {
                    client.emit(json.type, json);
                } else {
                    error("No type property in JSON");
                    return;
                }
                break;
            case "object":
                if (msg instanceof Buffer) {
                    if (!msg.length) {
                        // no data?
                        error("No data in buffer");
                        return;
                    }
                    if (remaining.bytes) {
                        // more data
                        if (msg.length > remaining.bytes) {
                            // woops
                            error(`length ${msg.length} > ${remaining.bytes}`);
                            return;
                        }
                        remaining.bytes -= msg.length;
                        client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                    } else {
                        // first byte denotes our message type
                        const type = msg.readUInt8(0);
                        if (msg.length < 5) {
                            error("No length in Buffer");
                            return;
                        }
                        if (!(type in BinaryTypes)) {
                            error(`Invalid binary type '${type}`);
                            return;
                        }
                        const len = msg.readUInt32(1);
                        if (len < msg.length - 5) {
                            error(`length mismatch, ${len} vs ${msg.length - 5}`);
                            return;
                        }
                        if (len > msg.length - 5) {
                            remaining.type = BinaryTypes[type];
                            remaining.bytes = len - (msg.length - 5);
                        }
                        client.emit(BinaryTypes[type], { data: msg.slice(5), last: !remaining.bytes });
                    }
                }
                break;
            }
        });
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
