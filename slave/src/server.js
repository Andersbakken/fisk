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

class Server extends EventEmitter {
    constructor(option) {
        super();
        this.option = option;
        this.id = 0;
    }

    listen() {
        this.ws = new WebSocket.Server({
            port: this.option.int("port", 8096),
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
                console.log("Got message", msg);
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
                remaining.type = "jobdata";
                remaining.bytes = json.bytes;
                client.emit("job", json);
                break;
            case "object":
                if (msg instanceof Buffer) {
                    console.log("Got binary", msg.length, remaining.bytes);
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
                    console.log("Emitting", remaining.type, { data: msg.length, last: !remaining.bytes });
                    client.emit(remaining.type, { data: msg, last: !remaining.bytes });
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
