import EventEmitter from "events";
import WebSocket from "ws";

export interface SchedulerJobUpdate {
    message?: Record<string, unknown>;
    error?: string;
}

const reconnectBaseMs = 500;
const reconnectMaxMs = 10000;
const pingIntervalMs = 30000;
const pongTimeoutMs = 90000;
// Requests are a few hundred bytes, so anything queued beyond this means the
// scheduler has stopped reading. Refusing new requests then makes fiskc compile
// locally right away instead of waiting out its watchdog on a socket that is
// never going to answer.
const maxBufferedBytes = 4 * 1024 * 1024;

export class SchedulerConnection extends EventEmitter {
    private ws?: WebSocket;
    private nextId: number;
    private readonly jobs: Map<number, (update: SchedulerJobUpdate) => void>;
    private reconnectAttempt: number;
    private reconnectTimer?: NodeJS.Timeout;
    private pingTimer?: NodeJS.Timeout;
    private lastPong: number;
    private connected: boolean;
    private stopped: boolean;
    private cache: boolean;

    constructor(
        readonly url: string,
        private readonly configVersion: number,
        private readonly npmVersion: string,
        private readonly name: string,
        private readonly hostname: string,
        private readonly debug: boolean
    ) {
        super();
        this.nextId = 1;
        this.jobs = new Map();
        this.reconnectAttempt = 0;
        this.lastPong = 0;
        this.connected = false;
        this.stopped = false;
        this.cache = false;
        console.log("SchedulerConnection", url, configVersion, npmVersion, name, hostname);
    }

    get isConnected(): boolean {
        return this.connected;
    }

    get objectCache(): boolean {
        return this.cache;
    }

    get activeJobs(): number {
        return this.jobs.size;
    }

    connect(): void {
        if (this.ws || this.stopped) {
            return;
        }
        const url = `${this.url}/daemon`;
        const ws = new WebSocket(url, {
            headers: {
                "x-fisk-config-version": String(this.configVersion),
                "x-fisk-npm-version": this.npmVersion,
                "x-fisk-daemon-name": this.name,
                "x-fisk-daemon-hostname": this.hostname
            }
        });
        this.ws = ws;

        ws.on("upgrade", (res) => {
            this.cache = res.headers["x-fisk-object-cache"] === "true";
        });

        ws.on("open", () => {
            this.connected = true;
            this.reconnectAttempt = 0;
            this.lastPong = Date.now();
            this.startPinging();
            console.log(`connected to scheduler ${url} (object cache: ${this.cache})`);
            this.emit("connect");
        });

        ws.on("pong", () => {
            this.lastPong = Date.now();
        });

        ws.on("message", (msg) => {
            this.onMessage(msg);
        });

        ws.on("error", (err: Error) => {
            console.error(`scheduler connection error ${url}: ${err.message}`);
        });

        ws.on("close", (code: number, reason: string) => {
            this.onDisconnected(`scheduler connection closed: ${code} ${reason}`);
        });
    }

    close(): void {
        this.stopped = true;
        this.stopPinging();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = undefined;
        }
        this.failAllJobs("daemon shutting down");
    }

    requestBuilder(
        request: Record<string, unknown>,
        onUpdate: (update: SchedulerJobUpdate) => void
    ): number | undefined {
        const ws = this.ws;
        if (!this.connected || !ws) {
            return undefined;
        }
        if (ws.bufferedAmount > maxBufferedBytes) {
            console.error(`scheduler connection is backed up (${ws.bufferedAmount} bytes), refusing request`);
            return undefined;
        }
        const id = this.nextId++;
        if (this.nextId === Math.pow(2, 31) - 1) {
            this.nextId = 1;
        }
        console.log("SchedulerConnection::requestBuilder", id, request);
        try {
            ws.send(JSON.stringify(Object.assign({}, request, { type: "compileRequest", id })));
        } catch (err) {
            console.error("failed to send compileRequest to scheduler", err);
            return undefined;
        }
        this.jobs.set(id, onUpdate);
        return id;
    }

    // The scheduler counts this job as active until it hears otherwise -- there is
    // no socket left to close on its behalf -- so this has to run for every fiskc
    // that goes away, successful or not.
    finishJob(id: number, reason: string): void {
        if (!this.jobs.delete(id)) {
            return;
        }
        if (this.debug) {
            console.log("SchedulerConnection::finishJob", id, reason);
        }
        if (this.connected && this.ws) {
            try {
                this.ws.send(JSON.stringify({ type: "compileDone", id, reason }));
            } catch (err) {
                console.error("failed to send compileDone to scheduler", err);
            }
        }
    }

    private onMessage(msg: WebSocket.Data): void {
        if (typeof msg !== "string") {
            console.error("Unexpected binary message from scheduler");
            return;
        }
        let json: Record<string, unknown> | undefined;
        try {
            json = JSON.parse(msg);
        } catch (err) {
            console.error("Unable to parse message from scheduler as JSON", msg);
            return;
        }
        if (!json) {
            return;
        }
        if (typeof json.error === "string") {
            console.error(`scheduler rejected us: ${json.error}`);
            return;
        }
        if (typeof json.id !== "number") {
            console.error("Message from scheduler without a job id", json);
            return;
        }
        const onUpdate = this.jobs.get(json.id);
        if (!onUpdate) {
            if (this.debug) {
                console.log("Message for a job that is already gone", json);
            }
            return;
        }
        switch (json.type) {
            case "jobMessage":
                if (json.message && typeof json.message === "object") {
                    onUpdate({ message: json.message as Record<string, unknown> });
                } else {
                    onUpdate({ error: "Malformed jobMessage from scheduler" });
                }
                break;
            case "jobClosed":
                this.jobs.delete(json.id);
                onUpdate({ error: typeof json.reason === "string" ? json.reason : "scheduler closed the job" });
                break;
            default:
                console.error("Unexpected message type from scheduler", json.type);
                break;
        }
    }

    private onDisconnected(reason: string): void {
        this.connected = false;
        this.stopPinging();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws = undefined;
        }
        console.error(reason);
        this.failAllJobs(reason);
        this.emit("disconnect", reason);
        this.scheduleReconnect();
    }

    private failAllJobs(reason: string): void {
        const pending = Array.from(this.jobs.values());
        this.jobs.clear();
        for (const onUpdate of pending) {
            onUpdate({ error: reason });
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        const shift = Math.min(this.reconnectAttempt, 6);
        // Jitter, because every daemon in the fleet loses its connection at the
        // same moment when the scheduler restarts.
        const delay = Math.min(reconnectBaseMs * Math.pow(2, shift), reconnectMaxMs) * (0.8 + Math.random() * 0.4);
        ++this.reconnectAttempt;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
    }

    private startPinging(): void {
        this.stopPinging();
        this.pingTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws) {
                return;
            }
            if (Date.now() - this.lastPong > pongTimeoutMs) {
                console.error("scheduler stopped answering pings, reconnecting");
                ws.terminate();
                return;
            }
            try {
                ws.ping();
            } catch (err) {
                console.error("failed to ping scheduler", err);
            }
        }, pingIntervalMs);
    }

    private stopPinging(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }
}
