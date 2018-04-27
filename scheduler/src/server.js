/*global require,module*/

const EventEmitter = require("events");
const WebSocket = require("ws");

const BinaryTypes = {
    // 0 and 1 is a special type that denotes a new compile or slave
    2: "environment"
};

class Client extends EventEmitter {
    constructor(ws, ip, type) {
        super();
        this.ws = ws;
        this.ip = ip;
        this.type = type;
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

Client.Type = {
    Slave: 0,
    Compile: 1
};

class Server extends EventEmitter {
    constructor(option) {
        super();
        this.option = option;
        this.id = 0;
    }

    listen() {
        this.ws = new WebSocket.Server({
            port: this.option("port", 8097),
            backlog: this.option("backlog", 50)
        });
        console.log("listening on", this.ws.options.port);
        this.ws.on("connection", this._handleConnection);
    }

    _handleConnection(ws, req) {
        let client = undefined;
        let remaining = { bytes: undefined, type: undefined };
        const ip = req.connection.remoteAddress;
        ws.on("message", msg => {
            switch (typeof msg) {
            case "string":
                if (client === undefined) {
                    ws.send('{"error": "No client type received"}');
                    ws.close();
                    return;
                }
                // assume JSON
                let json;
                try {
                    json = JSON.parse(msg);
                } catch (e) {
                }
                if (json === undefined) {
                    ws.send('{"error": "Unable to parse string message as JSON"}');
                    ws.close();
                    return;
                }
                if ("type" in json) {
                    client.emit(json.type, json);
                } else {
                    ws.send('{"error": "No type property in JSON"}');
                    ws.close();
                    return;
                }
                break;
            case "object":
                if (msg instanceof Buffer) {
                    // first byte denotes our message type
                    if (!msg.length) {
                        // no data?
                        ws.send('{"error": "No data in buffer"}');
                        ws.close();
                        return;
                    }
                    if (remaining.bytes) {
                        // more data
                        if (msg.length > remaining.bytes) {
                            // woops
                            ws.send(`{"error": "length ${msg.length} > ${remaining.bytes}"}`);
                            ws.close();
                            return;
                        }
                        remaining.bytes -= msg.length;
                        client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                    } else {
                        const type = msg.readUInt8(0);
                        if (client === undefined) {
                            if (msg.length > 1) {
                                ws.send('{"error": "Client type message length must be exactly one byte"}');
                                ws.close();
                                return;
                            }
                            switch (type) {
                            case Client.Type.Slave:
                                client = new Client(ws, ip, type);
                                this.emit("slave", client);
                                break;
                            case Client.Type.Compile:
                                client = new Client(ws, ip, type);
                                this.emit("compile", client);
                                break;
                            default:
                                ws.send(`{"error": "Unrecognized client type: ${type}"}`);
                                ws.close();
                                break;
                            }
                            return;
                        }
                        if (msg.length < 5) {
                            ws.send('{"error": "No length in Buffer"}');
                            ws.close();
                            return;
                        }
                        if (!(type in BinaryTypes)) {
                            ws.send(`{"error": "Invalid binary type '${type}'"}`);
                            ws.close();
                            return;
                        }
                        const len = msg.readUInt32(1);
                        if (len < msg.length - 5) {
                            ws.send(`{"error": "length mismatch, ${len} vs ${msg.length - 5}"}`);
                            ws.close();
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
            if (client)
                client.emit("close");
        });
    }
}

module.exports = Server;
