import { options } from "@jhanssen/options";
import EventEmitter from "events";
import WebSocket from "ws";
import fs from "fs";
import os from "os";
import path from "path";

type Message = { type: string; message: unknown };

class Client extends EventEmitter {
    private configVersion: string;
    private scheduler: string;
    private hostname: string;
    private name: string;
    private npmVersion: string;
    private serverPort?: number;
    private ws?: WebSocket;

    constructor(option: typeof options, configVersion: string) {
        super();

        this.configVersion = configVersion;
        this.scheduler = String(option("scheduler", "ws://localhost:8097"));
        if (this.scheduler.indexOf("://") === -1) {
            this.scheduler = "ws://" + this.scheduler;
        }
        if (!/:[0-9]+$/.exec(this.scheduler)) {
            this.scheduler += ":8097";
        }
        this.hostname = option("hostname");
        this.name = option("name");
        try {
            this.npmVersion =
                JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).version || "";
        } catch (err) {
            this.npmVersion = "";
        }
        console.log("this is our npm version", this.npmVersion);
        if (!this.name) {
            if (this.hostname) {
                this.name = this.hostname;
            } else {
                this.name = os.hostname();
            }
        }
    }

    connect(): void {
        const url = `${this.scheduler}/daemon`;
        console.log("connecting to", url);

        const headers: Record<string, string | number> = {
            "x-fisk-port": this.serverPort,
            "x-fisk-config-version": this.configVersion,
            "x-fisk-daemon-name": this.name,
            "x-fisk-npm-version": this.npmVersion
        };
        if (this.hostname) {
            headers["x-fisk-builder-hostname"] = this.hostname;
        }

        this.ws = new WebSocket(url, { headers: headers });
        this.ws.on("open", () => {
            this.emit("connect");
        });
        this.ws.on("error", (err) => {
            console.error("client websocket error", err.message);
        });
        this.ws.on("message", (msg) => {
            // const error = (msg) => {
            //     this.ws.send(`{"error": "${msg}"}`);
            //     this.ws.close();
            //     this.emit("error", msg);
            // };
            console.log("Got message from scheduler", msg);
        });
        this.ws.on("close", () => {
            this.emit("close");
            if (this.ws) {
                this.ws.removeAllListeners();
            }
            this.ws = undefined;
        });
    }

    sendBinary(blob: Buffer): void {
        try {
            this.ws.send(blob);
        } catch (err) {
            this.emit("err", err.toString());
        }
    }
    send(type: string | Message, msg: string | Message): void {
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

export { Client };
