import { OptionsFunction } from "@jhanssen/options";
import EventEmitter from "events";
import WebSocket from "ws";
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

export class Client extends EventEmitter {
    configVersion: number;
    scheduler: string;
    hostname?: string;
    name?: string;
    npmVersion?: string;
    ws?: WebSocket;
    serverPort: number;

    constructor(option: OptionsFunction, configVersion: number) {
        super();

        this.configVersion = configVersion;
        this.scheduler = String(option("scheduler", "ws://localhost:8097"));
        if (this.scheduler.indexOf("://") === -1) {
            this.scheduler = "ws://" + this.scheduler;
        }
        const match = /:([0-9]+)$/.exec(this.scheduler);
        if (match) {
            this.serverPort = parseInt(match[1], 10);
        } else {
            this.serverPort = 8097;
            this.scheduler += ":8097";
        }
        let tmp = option("hostname");
        this.hostname = tmp === undefined ? undefined : String(tmp);
        tmp = option("name");
        this.name = tmp === undefined ? undefined : String(tmp);
        try {
            this.npmVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")).version;
        } catch (err) {
            /* */
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

        const headers: Record<string, string> = {
            "x-fisk-port": String(this.serverPort),
            "x-fisk-config-version": String(this.configVersion),
            "x-fisk-daemon-name": String(this.name),
            "x-fisk-npm-version": String(this.npmVersion)
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
        this.ws.on("message", (msg: unknown) => {
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
            assert(this.ws, "Must have ws");
            this.ws.send(blob);
        } catch (err: unknown) {
            this.emit("err", (err as Error).toString());
        }
    }
    send(type: unknown, msg?: Record<string, unknown>): void {
        if (!this.ws) {
            this.emit("error", "No connected websocket");
            return;
        }
        try {
            if (msg === undefined) {
                this.ws.send(JSON.stringify(type));
            } else {
                let tosend: Record<string, unknown>;
                if (typeof msg === "object") {
                    tosend = msg;
                    tosend.type = type;
                } else {
                    tosend = { type: type, message: msg };
                }
                this.ws.send(JSON.stringify(tosend));
            }
        } catch (err: unknown) {
            this.emit("err", (err as Error).toString());
        }
    }
}
