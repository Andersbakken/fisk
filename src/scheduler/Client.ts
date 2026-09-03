import EventEmitter from "events";
import type { Options } from "@jhanssen/options";
import type WebSocket from "ws";

export const enum ClientType {
    Builder = 0,
    Compile = 1,
    UploadEnvironment = 2,
    Monitor = 3,
    ClientVerify = 4,
    Daemon = 5
}

// A fiskc process reaching us through its host daemon has no socket of its own:
// it is one multiplexed stream on that daemon's single connection (see
// DaemonJobSocket). Narrowing the transport to what Client actually calls is
// what lets it and a real websocket be the same kind of client. Event wiring
// stays in Server, where the real websocket is in scope and fully typed.
export type ClientSocket = Pick<WebSocket, "send" | "close" | "ping" | "terminate">;

export class Client extends EventEmitter {
    created: Date;
    pingSent?: number;
    nonce?: string;
    hostname: string;
    port: number;
    name: string;
    user: string;
    labels?: string[];
    npmVersion: string;

    constructor(readonly type: ClientType, readonly ws: ClientSocket, readonly ip: string, readonly option?: Options) {
        super();
        this.created = new Date();
        this.hostname = "";
        this.name = "";
        this.npmVersion = "";
        this.user = "";
        this.port = 0;
    }

    notePong(): void {
        this.pingSent = undefined;
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
            // Emit before closing. A real websocket closes asynchronously, but a
            // DaemonJobSocket does it synchronously and tears the job down -- and
            // removes these listeners -- so closing first means nobody ever hears
            // this, including whoever releases the job's counters.
            this.emit("error", message);
            this.ws.close();
        } catch (err) {
            /* */
        }
    }

    close(): void {
        this.ws.close();
    }
}
