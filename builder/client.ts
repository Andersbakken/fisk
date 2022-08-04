const EventEmitter = require("events");
const WebSocket = require("ws");
const os = require('os');
const path = require('path');
const fs = require('fs');

class Client extends EventEmitter {
    constructor(option, configVersion) {
        super();

        this.configVersion = configVersion;
        this.scheduler = option("scheduler", "ws://localhost:8097");
        if (this.scheduler.indexOf('://') == -1)
            this.scheduler = "ws://" + this.scheduler;
        if (!/:[0-9]+$/.exec(this.scheduler))
            this.scheduler += ":8097";
        this.serverPort = option.int("port", 8096);
        this.hostname = option("hostname");
        this.name = option("name");
        this.slots = option.int("slots", os.cpus().length);
        this.labels = option("labels");
        try {
            this.npmVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"))).version;
        } catch (err) {
        }
        console.log("this is our npm version", this.npmVersion);
        if (!this.name) {
            if (this.hostname) {
                this.name = this.hostname;
            } else  {
                this.name = os.hostname();
            }
        }
    }

    connect(environments) {
        const url = `${this.scheduler}/builder`;
        console.log("connecting to", url);

        let remaining = 0;
        let system;
        switch (os.platform()) {
        case 'darwin': system = "Darwin"; break;
        case 'linux': system = "Linux"; break;
        default: console.error("Unknown platform", os.platform()); break;
        }
        switch (os.arch()) {
        case 'ia32': system += " i686"; break;
        case 'x64': system += " x86_64"; break;
        default: console.error("Unknown architecture", os.arch()); break;
        }
        let headers = {
            "x-fisk-port": this.serverPort,
            "x-fisk-environments": environments.join(";"),
            "x-fisk-config-version": this.configVersion,
            "x-fisk-builder-name": this.name,
            "x-fisk-system": system,
            "x-fisk-slots": this.slots,
            "x-fisk-npm-version": this.npmVersion
        };

        if (this.labels) {
            headers["x-fisk-builder-labels"] = this.labels;
        }

        if (this.hostname) {
            headers["x-fisk-builder-hostname"] = this.hostname;
        }

        this.ws = new WebSocket(url, { headers: headers });
        this.ws.on("open", () => {
            this.emit("connect");
        });
        this.ws.on("error", err => {
            console.error("client websocket error", err.message);
        });
        this.ws.on("upgrade", res => {
            this.emit("objectCache", res.headers["x-fisk-object-cache"] == "true");
        });

        this.ws.on("message", msg => {
            const error = msg => {
                this.ws.send(`{"error": "${msg}"}`);
                this.ws.close();
                this.emit("error", msg);
            };

            switch (typeof msg) {
            case "string":
                if (remaining) {
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
                if (!json.type) {
                    error("Bad message, no type");
                    return;
                }

                console.log("got message from scheduler", json.type);

                if (json.bytes) {
                    remaining = json.bytes;
                }
                this.emit(json.type, json);
                break;
            case "object":
                if (msg instanceof Buffer) {
                    if (!msg.length) {
                        // no data?
                        error("No data in buffer");
                        return;
                    }
                    if (remaining) {
                        // more data
                        if (msg.length > remaining) {
                            // woops
                            error(`length ${msg.length} > ${remaining}`);
                            return;
                        }
                        remaining -= msg.length;
                        this.emit("data", { data: msg, last: !remaining });
                    } else {
                        error(`Unexpected binary message of length: ${msg.length}`);
                    }
                } else {
                    error("Unexpected object");
                }
                break;
            }
        });
        this.ws.on("close", () => {
            if (remaining.bytes)
                this.emit("error", "Got close while reading a binary message");
            this.emit("close");
            if (this.ws)
                this.ws.removeAllListeners();
            this.ws = undefined;
        });
    }

    sendBinary(blob) {
        try {
            this.ws.send(blob);
        } catch (err) {
            this.emit("err", err.toString());
        }
    }
    send(type, msg) {
        if (!this.ws) {
            this.emit("error", "No connected websocket");
            return;
        }
        try {
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
        } catch (err) {
            this.emit("err", err.toString());
        }
    }
}

module.exports = Client;
