import EventEmitter from "events";
import type { OptionsFunction } from "@jhanssen/options";
import type WebSocket from "ws";

export const enum ClientType {
    Builder = 0,
    Compile = 1,
    UploadEnvironment = 2,
    Monitor = 3,
    ClientVerify = 4
}

export class Client extends EventEmitter {
    type: ClientType;
    created: Date;
    pingSent?: number;
    ws: WebSocket;
    ip: string;
    option?: OptionsFunction;
    nonce?: string;
    hostname: string;
    port: number;
    name: string;
    user: string;
    labels?: string[];
    npmVersion: string;

    constructor(type: ClientType, ws: WebSocket, ip: string, option?: OptionsFunction) {
        super();
        this.created = new Date();
        this.type = type;
        this.ws = ws;
        this.ip = ip;
        this.option = option;
        this.hostname = "";
        this.name = "";
        this.npmVersion = "";
        this.user = "";
        this.port = 0;

        this.ws.on("pong", () => {
            // console.log("got pong", this.name);
            this.pingSent = undefined;
        });
    }

    send(type: unknown, msg?: Record<string, unknown>): void {
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
            /* */
        }
    }

    ping(): void {
        if (this.option && this.pingSent) {
            const max = this.option.int("max-pong-interval", 60000);
            console.log("checking ping", max, Date.now() - max, this.pingSent);
            if (Date.now() - max > this.pingSent) {
                this.ws.close();
                return;
            }
        }
        this.ws.ping();
        this.pingSent = Date.now();
    }

    error(message: string): void {
        try {
            this.ws.send(`{"error": "${message}"}`);
            this.ws.close();
            this.emit("error", message);
        } catch (err) {
            /* */
        }
    }

    close(): void {
        this.ws.close();
    }
}
