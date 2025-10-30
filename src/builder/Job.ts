import EventEmitter from "events";
import WebSocket from "ws";
import type { JobData } from "./JobData";

export class Job extends EventEmitter implements JobData {
    ws: WebSocket;
    ip: string;
    hash: string;
    name: string;
    id: number;
    sha1?: string;

    hostname?: string;
    user?: string;
    sourceFile?: string;
    priority: number;
    builderIp?: string;
    closed?: boolean;
    compressed?: boolean;
    commandLine?: string[];
    argv0?: string;
    connectTime?: number;
    wait?: boolean;
    objectcache?: boolean;
    supportsCompressedResponse?: boolean;
    heartbeatTimer?: NodeJS.Timeout;

    constructor(data: JobData) {
        super();
        this.ws = data.ws;
        this.ip = data.ip;
        this.hash = data.hash;
        this.name = data.name;
        this.hostname = data.hostname;
        this.user = data.user;
        this.sourceFile = data.sourceFile;
        this.priority = data.priority || 0;
        this.sha1 = data.sha1;
        this.id = data.id;
        this.builderIp = data.builderIp;
        this.supportsCompressedResponse = data.supportsCompressedResponse;
    }

    get readyState(): number {
        return this.ws.readyState;
    }

    send(type: unknown, msg?: Record<string, unknown>): void {
        if (this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
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
            console.error("got send error", this.id, type, err);
        }
    }

    close(): void {
        this.closed = true;
        this.ws.close();
    }
}
