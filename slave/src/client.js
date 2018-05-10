const EventEmitter = require("events");
const WebSocket = require("ws");

const BinaryTypes = {
    // 0 and 1 is a special type that denotes a new compile or slave
    2: "environment"
};

class Client extends EventEmitter {
    constructor(option) {
        super();

        this.scheduler = option("scheduler", "localhost:8097");
        this.serverPort = option.int("port", 8096);
    }

    connect() {
        const url = `ws://${this.scheduler}/slave`;
        console.log("connecting to", this.scheduler);

        let remaining = { bytes: undefined, type: undefined, hash: undefined };
        this.ws = new WebSocket(url, {
            headers: {
                "x-fisk-slave-port": this.serverPort,
                "x-fisk-environment": ""
            }
        });
        this.ws.on("open", () => {
            this.emit("connect");
        });
        this.ws.on("error", err => {
            console.error("client websocket error", err.message);
        });
        this.ws.on("message", msg => {
            const error = msg => {
                this.ws.send(`{"error": "${msg}"}`);
                this.ws.close();
                this.emit("error", msg);
            };

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
                if (json.type === 'environment') {
                    remaining = json;
                } else if ("type" in json) {
                    this.emit(json.type, json);
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
                        this.emit(remaining.type, { data: msg, last: !remaining.bytes, hash: remaining.hash });
                    } else {
                        error(`Unexpected binary message of length: ${msg.length}`);
                    }
                }
                break;
            }
        });
        this.ws.on("close", () => {
            if (remaining.bytes)
                this.emit("error", "Got close while reading a binary message");
            this.emit("close");
            this.ws.removeAllListeners();
            this.ws = undefined;
        });
    }

    send(type, msg) {
        if (!this.ws) {
            this.emit("error", "No connected websocket");
            return;
        }
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
}

module.exports = Client;
