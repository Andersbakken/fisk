/* eslint-disable max-classes-per-file */

import { Duplex } from "stream";
import { options } from "@jhanssen/options";
import EventEmitter from "events";
import Url from "url";
import WebSocket from "ws";
import assert from "assert";
import express, { Express } from "express";
import http from "http";

type JobData = {
    ws: WebSocket;
    ip: string;
    hash: string;
    name: string;
    hostname: string;
    user: string;
    sourceFile: string;
    sha1: string;
    id: number;
    builderIp: string;
};

type Message = { type: string; message: unknown };
class Job extends EventEmitter {
    private ws: WebSocket;
    private ip: string;
    private hash: string;
    private name: string;
    private hostname: string;
    private user: string;
    private sourceFile: string;
    private builderIp: string;
    private closed?: boolean;

    public id: number;
    public sha1: string;
    public objectcache?: boolean;

    constructor(data: JobData) {
        super();
        this.ws = data.ws;
        this.ip = data.ip;
        this.hash = data.hash;
        this.name = data.name;
        this.hostname = data.hostname;
        this.user = data.user;
        this.sourceFile = data.sourceFile;
        this.sha1 = data.sha1;
        this.id = data.id;
        this.builderIp = data.builderIp;
    }

    send(type: string | unknown, msg?: unknown): void {
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
                let tosend: Message;
                if (msg && typeof msg === "object") {
                    tosend = msg as Message;
                    tosend.type = type as string;
                } else {
                    tosend = { type: type as string, message: msg };
                }
                this.ws.send(JSON.stringify(tosend));
            }
        } catch (err) {
            console.error("got send error", this.id, type, err);
        }
    }

    get readyState(): number {
        return this.ws.readyState;
    }

    close(): void {
        this.closed = true;
        this.ws.close();
    }
}

class Server extends EventEmitter {
    private option: typeof options;
    private id: number;
    private configVersion: string;
    private app?: Express;
    private server?: http.Server;
    private port?: number;
    private ws?: WebSocket.Server;

    constructor(option: typeof options, configVersion: string) {
        super();
        this.option = option;
        this.id = 0;
        this.configVersion = configVersion;
        this.app = undefined;
    }

    listen(): void {
        this.app = express();
        this.emit("listen", this.app);
        this.port = this.option.int("port", 8096);

        this.server = http.createServer(this.app);
        this.ws = new WebSocket.Server({ noServer: true, backlog: this.option.int("backlog", 50) });
        this.server.listen({ port: this.port, backlog: this.option.int("backlog", 50), host: "0.0.0.0" });

        this.server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
            assert(this.ws);
            this.ws.handleUpgrade(req, socket, head, (ws: WebSocket) => {
                this._handleConnection(ws, req);
            });
        });

        console.log("listening on", this.port);
        this.ws.on("headers", (headers, request) => {
            this.emit("headers", headers, request);
        });
    }

    _handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
        const connectTime = Date.now();
        let client = undefined;
        let bytes = undefined;
        let ip = req.connection.remoteAddress;
        let clientEmitted = false;
        const error = (msg) => {
            ws.send(`{"error": "${msg}"}`);
            ws.close();
            if (client && clientEmitted) {
                client.emit("error", msg);
            } else {
                this.emit("error", { ip: ip, message: msg });
            }
        };

        if (!ip) {
            // already closed
            // console.log(req.connection, ws.readyState);
            return;
        }
        if (ip.substr(0, 7) === "::ffff:") {
            ip = ip.substr(7);
        }

        const url = Url.parse(req.url);
        switch (url.pathname) {
            case "/compile": {
                const hash = req.headers["x-fisk-environments"];
                if (!hash) {
                    error("Bad ws request, no environments");
                    return;
                }
                const name = req.headers["x-fisk-client-name"];
                const configVersion = req.headers["x-fisk-config-version"];
                if (configVersion !== this.configVersion) {
                    error(`Bad config version, expected ${this.configVersion}, got ${configVersion}`);
                    return;
                }

                // console.log("GOT HEADERS", req.headers);
                client = new Job({
                    ws: ws,
                    ip: ip,
                    hash: hash,
                    name: name,
                    hostname: req.headers["x-fisk-client-hostname"],
                    user: req.headers["x-fisk-user"],
                    sourceFile: req.headers["x-fisk-sourcefile"],
                    sha1: req.headers["x-fisk-sha1"],
                    id: parseInt(req.headers["x-fisk-job-id"]),
                    builderIp: req.headers["x-fisk-builder-ip"]
                });

                break;
            }
            default:
                error(`Invalid pathname ${url.pathname}`);
                return;
        }

        ws.on("message", (msg) => {
            switch (typeof msg) {
                case "string": {
                    // console.log("Got message", msg);
                    if (bytes) {
                        // bad, client have to send all the data in a binary message before sending JSON
                        error(`Got JSON message while ${bytes} bytes remained of a binary message`);
                        return;
                    }
                    // assume JSON
                    let json;
                    try {
                        json = JSON.parse(msg);
                    } catch (e) {
                        /* */
                    }
                    if (json === undefined) {
                        error("Unable to parse string message as JSON");
                        return;
                    }
                    bytes = json.bytes;
                    client.commandLine = json.commandLine;
                    client.argv0 = json.argv0;
                    client.connectTime = connectTime;
                    client.wait = json.wait;
                    this.emit("job", client);
                    clientEmitted = true;
                    break;
                }
                case "object":
                    if (msg instanceof Buffer) {
                        // console.log("Got binary", msg.length, bytes);
                        if (!msg.length) {
                            // no data?
                            console.error("No data in buffer");
                            return;
                        }
                        if (!bytes) {
                            error("Got binary message without a preceeding json message describing the data");
                            return;
                        }
                        if (msg.length > bytes) {
                            // woops
                            error(`length ${msg.length} > ${bytes}`);
                            return;
                        }
                        bytes -= msg.length;
                        // console.log("Emitting", "data", { data: msg.length, last: !bytes });
                        client.emit("data", { data: msg, last: !bytes });
                    }
                    break;
            }
        });
        ws.on("close", () => {
            if (client && clientEmitted) {
                // console.error("GOT WS CLOSE", bytes, client.objectcache);
                client.emit("close");
            }
            ws.removeAllListeners();
        });
        ws.on("error", (error) => {
            console.log("GOT WS ERROR", error);
            if (client && clientEmitted) {
                client.emit("error", error);
            }
        });
    }
}

export { Server, Job };
