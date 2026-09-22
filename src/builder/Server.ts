import { Job } from "./Job";
import { defaultBacklog } from "../common";
import EventEmitter from "events";
import Url from "url-parse";
import WebSocket from "ws";
import assert from "assert";
import express from "express";
import http from "http";
import zlib from "zlib";
import type { Options } from "@jhanssen/options";
import type net from "net";
import type stream from "stream";

export class Server extends EventEmitter {
    private app?: express.Express;
    private server?: net.Server;
    private ws?: WebSocket.Server;

    readonly baseUrl: string;
    port?: number;

    // Until this is set the port is open but every upgrade is turned away with
    // a 503. Listening while still loading environments is deliberate: a closed
    // port during a restart is indistinguishable, from the client's side, from
    // a builder that is simply too busy to answer, and both cost it a full
    // handshake budget before it gives up and compiles locally.
    ready: boolean = false;

    // Returns a reason to refuse the connection, or undefined to accept it.
    shed?: (req: http.IncomingMessage) => string | undefined;

    constructor(private readonly option: Options, private readonly configVersion: number) {
        super();
        this.app = undefined;
        this.baseUrl = `http://localhost:${this.option.int("port", 8096)}`;
    }

    listen(): void {
        this.app = express();
        this.emit("listen", this.app);
        this.port = this.option.int("port", 8096);

        this.server = http.createServer(this.app);
        // No backlog here on purpose: ws only uses that option when it creates
        // its own http server, which noServer mode explicitly does not do.
        this.ws = new WebSocket.Server({ noServer: true });
        this.server.listen({
            port: this.port,
            backlog: this.option.int("backlog", defaultBacklog()),
            host: "0.0.0.0"
        });

        this.server.on("upgrade", (req: http.IncomingMessage, socket: stream.Duplex, head: Buffer) => {
            assert(this.ws, "Must have ws");
            const reason = this.ready ? this.shed?.(req) : "starting up";
            if (reason) {
                Server.refuse(socket, reason);
                this.emit("shed", reason, req);
                return;
            }
            this.ws.handleUpgrade(req, socket, head, (ws) => {
                this._handleConnection(ws, req);
            });
        });

        console.log("listening on", this.port);
        this.ws.on("headers", (headers: string[], request: http.IncomingMessage) => {
            this.emit("headers", headers, request);
        });
    }

    _handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
        const connectTime = Date.now();
        let client: Job | undefined;
        let bytes: number | undefined;
        let ip = req.connection.remoteAddress;
        let clientEmitted = false;
        const error = (msg: string): void => {
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
        if (ip.substring(0, 7) === "::ffff:") {
            ip = ip.substring(7);
        }

        const url = new Url(req.url || "", this.baseUrl);
        switch (url.pathname) {
            case "/compile": {
                const hash = String(req.headers["x-fisk-environments"]);
                if (!hash) {
                    error("Bad ws request, no environments");
                    return;
                }
                const name = String(req.headers["x-fisk-client-name"]);
                const configVersion = parseInt(String(req.headers["x-fisk-config-version"]), 10);
                if (configVersion !== this.configVersion) {
                    error(`Bad config version, expected ${this.configVersion}, got ${configVersion}`);
                    return;
                }

                // console.log("GOT HEADERS", req.headers);
                let builderIp = req.headers["x-fisk-builder-ip"];
                if (Array.isArray(builderIp)) {
                    builderIp = String(builderIp);
                }

                const sha1 = req.headers["x-fisk-sha1"];
                if (Array.isArray(sha1)) {
                    error("Bad sha1 header [" + sha1.join(", ") + "]");
                    return;
                }

                client = new Job({
                    builderIp,
                    hash,
                    hostname: String(req.headers["x-fisk-client-hostname"]),
                    id: parseInt(String(req.headers["x-fisk-job-id"])),
                    ip,
                    name,
                    priority: parseInt(String(req.headers["x-fisk-priority"])),
                    sha1,
                    sourcePath: String(req.headers["x-fisk-sourcefile"]),
                    user: String(req.headers["x-fisk-user"]),
                    supportsCompressedResponse: req.headers["x-fisk-supports-compressed-response"] === "true",
                    ws
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
                    assert(client, "Must client");
                    client.compressed = json.compressed;
                    client.commandLine = json.commandLine;
                    client.argv0 = json.argv0;
                    client.cwd = json.cwd;
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
                            error("No data in buffer");
                            return;
                        }
                        if (!bytes) {
                            error("Got binary message without a preceeding json message describing the data");
                            return;
                        }
                        if (msg.length !== bytes) {
                            // woops
                            error(`length ${msg.length} !== ${bytes}`);
                            return;
                        }
                        bytes = 0;
                        // console.log("GOT DATA", client.compressed, msg.length);
                        assert(client, "Gotta client");
                        if (client.compressed) {
                            zlib.gunzip(msg, (err, data) => {
                                if (err) {
                                    error(`Got error inflating data ${err}`);
                                } else {
                                    assert(client, "Gotta client");
                                    client.emit("data", { data });
                                }
                            });
                        } else {
                            client.emit("data", { data: msg });
                        }
                    }
                    break;
                default:
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

        ws.on("error", (err: unknown) => {
            console.log("GOT WS ERROR", err);
            if (client && clientEmitted) {
                client.emit("error", err);
            }
        });
    }

    private static refuse(socket: stream.Duplex, reason: string): void {
        // Answered before the handshake so the client gets a real status code
        // instead of silence. Retry-After is in seconds per RFC 7231.
        socket.write(
            "HTTP/1.1 503 Service Unavailable\r\n" +
                "Retry-After: 1\r\n" +
                `x-fisk-shed-reason: ${reason}\r\n` +
                "Connection: close\r\n" +
                "Content-Length: 0\r\n" +
                "\r\n"
        );
        socket.destroy();
    }
}
