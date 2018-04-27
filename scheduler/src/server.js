/*global require,module*/

const EventEmitter = require("events");
const WebSocket = require("ws");

const BinaryTypes = {
    // 0 is a special type that denotes a new slave
    1: "environment"
};
const SlaveType = 0;

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
        let slave = undefined;
        let remaining = { bytes: undefined, type: undefined };
        const ip = req.connection.remoteAddress;
        ws.on("message", msg => {
            switch (typeof msg) {
            case "string":
                if (slave === undefined)
                    slave = false;
                // assume JSON
                let json;
                try {
                    json = JSON.parse(msg);
                } catch (e) {
                }
                if (json === undefined) {
                    this.emit("error", "Unable to parse string message as JSON");
                }
                if ("type" in json) {
                    json.ip = ip;
                    json.slave = slave;
                    this.emit(json.type, json);
                } else {
                    this.emit("error", "No type in JSON");
                }
                break;
            case "object":
                if (msg instanceof Buffer) {
                    // first byte denotes our message type
                    if (!msg.length) {
                        // no data?
                        this.emit("error", "No data in Buffer");
                        return;
                    }
                    if (remaining.bytes) {
                        // more data
                        if (msg.length > remaining.bytes) {
                            // woops
                            this.emit("error", `length ${msg.length} > ${remaining.bytes}`);
                            ws.close();
                            return;
                        }
                        remaining.bytes -= msg.length;
                        this.emit(remaining.type, { ip: ip, slave: slave, data: msg, last: !remaining.bytes });
                    } else {
                        const type = msg.readUInt8(0);
                        if (type === SlaveType) {
                            // new slave reporting
                            slave = true;
                        } else {
                            if (msg.length < 5) {
                                this.emit("error", "No length in Buffer");
                                ws.close();
                                return;
                            }
                            if (slave === undefined)
                                slave = false;
                            if (!(type in BinaryTypes)) {
                                this.emit("error", `Invalid binary type '${type}'`);
                                ws.close();
                                return;
                            }
                            const len = msg.readUInt32(1);
                            if (len < msg.length - 5) {
                                this.emit("error", `length mismatch, ${len} vs ${msg.length - 5}`);
                                ws.close();
                                return;
                            }
                            if (len > msg.length - 5) {
                                remaining.type = BinaryTypes[type];
                                remaining.bytes = len - (msg.length - 5);
                            }
                            this.emit(BinaryTypes[type], { ip: ip, slave: slave, data: msg.slice(5), last: !remaining.bytes });
                        }
                    }
                }
                break;
            }
        });
        ws.on("close", () => {
            this.emit("close", { ip: ip, slave: slave });
        });
    }
}

module.exports = Server;
