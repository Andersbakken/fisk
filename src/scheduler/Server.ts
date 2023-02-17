import { Builder } from "./Builder";
import { Client, ClientType } from "./Client";
import { Compile } from "./Compile";
import { OptionsFunction } from "@jhanssen/options";
import EventEmitter from "events";
import Url from "url-parse";
import WebSocket from "ws";
import assert from "assert";
import crypto from "crypto";
import express from "express";
import fs from "fs";
import http from "http";
import stream from "stream";

function header(req: express.Request, name: string): string | undefined {
    const ret = req.headers[name];
    if (ret === undefined) {
        return undefined;
    }
    return String(ret);
}

export class Server extends EventEmitter {
    private option: OptionsFunction;
    private configVersion: number;
    private id: number;
    private app?: express.Express;
    private ws?: WebSocket.Server;
    private server?: http.Server;
    private nonces: WeakMap<express.Request, string>;
    private readonly baseUrl: string;

    objectCache: boolean;

    constructor(option: OptionsFunction, configVersion: number) {
        super();
        this.option = option;
        this.configVersion = configVersion;
        this.id = 0;
        this.objectCache = false;
        this.nonces = new WeakMap();
        this.baseUrl = `http://localhost:${this.option.int("port", 8097)}`;
    }

    listen(): Promise<void> {
        return new Promise<void>((resolve: () => void) => {
            this.app = express();
            this.emit("listen", this.app);

            const ui = this.option("ui");
            if (ui) {
                this.app.all("/*", (_: express.Request, res: express.Response) => {
                    res.redirect(String(ui));
                });
            }

            this.server = http.createServer(this.app);
            this.ws = new WebSocket.Server({ noServer: true });
            const port = this.option.int("port", 8097);
            let defaultBacklog = 128;
            try {
                defaultBacklog = parseInt(fs.readFileSync("/proc/sys/net/core/somaxconn", "utf8")) || 128;
            } catch (err: unknown) {
                /* */
            }

            const backlog = this.option.int("backlog", defaultBacklog);
            this.server.listen({ port, backlog, host: "0.0.0.0" });

            this.server.on("upgrade", (req: express.Request, socket: stream.Duplex, head: Buffer) => {
                assert(this.ws);
                this.ws.handleUpgrade(req, socket, head, (ws) => {
                    this._handleConnection(ws, req);
                });
            });

            this.ws.on("headers", (headers: string[], request: express.Request) => {
                const url = new Url(request.url, this.baseUrl);
                headers.push("x-fisk-object-cache: " + (this.objectCache ? "true" : "false"));
                if (url.pathname === "/monitor") {
                    const nonce = crypto.randomBytes(256).toString("base64");
                    headers.push(`x-fisk-nonce: ${nonce}`);
                    this.nonces.set(request, nonce);
                }
            });

            this.server.on("error", (error: Error) => {
                if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
                    console.log(`Port ${port} is in use...`);
                    setTimeout(() => {
                        assert(this.server);
                        this.server.listen({ port, backlog, host: "0.0.0.0" });
                    }, 1000);
                } else {
                    console.error("Got server error", error.toString());
                    this.emit("error", error);
                }
            });
            this.server.once("listening", () => {
                console.log("listening on", port);
                resolve();
            });
        });
    }

    get express(): express.Express | undefined {
        return this.app;
    }

    _handleCompile(req: express.Request, ws: WebSocket, ip: string): void {
        // look at headers
        if (!("x-fisk-environments" in req.headers)) {
            ws.send(`{"error": "No x-fisk-environments header"}`);
            ws.close();
            return;
        }

        const configVersion = parseInt(header(req, "x-fisk-config-version") || "");
        if (configVersion !== this.configVersion) {
            ws.send(`{"error": "Bad config version, expected ${this.configVersion}, got ${configVersion}"}`);
            ws.close();
            return;
        }
        const compileEnvironment = header(req, "x-fisk-environments");

        if (!compileEnvironment) {
            ws.send(`{"error": "No environment"}`);
            ws.close();
            return;
        }

        const sourceFile = header(req, "x-fisk-sourcefile");
        if (!sourceFile) {
            ws.send(`{"error": "No sourceFile"}`);
            ws.close();
            return;
        }
        const sha1 = header(req, "x-fisk-sha1");

        if (sha1 && sha1.length !== 40) {
            ws.send(`{"error": "Bad sha1 sum: ${sha1}"}`);
            ws.close();
            return;
        }
        const client = new Compile(ws, ip, compileEnvironment, sourceFile, sha1, this.option);
        const npmVersion = header(req, "x-fisk-npm-version");
        if (npmVersion) {
            client.npmVersion = npmVersion;
        }
        const preferredBuilder = header(req, "x-fisk-builder");
        if (preferredBuilder) {
            client.builder = preferredBuilder;
        }
        const labels = header(req, "x-fisk-builder-labels");
        if (labels) {
            client.labels = labels.split(/ +/).filter((x) => x);
        }
        const clientName = header(req, "x-fisk-client-name");
        if (clientName) {
            client.name = clientName;
        }
        const user = header(req, "x-fisk-user");
        if (user) {
            client.user = user;
        }
        const clientHostname = header(req, "x-fisk-client-hostname");
        if (clientHostname) {
            client.hostname = clientHostname;
        }
        this.emit("compile", client);
        const remaining: { bytes?: number; type?: string } = {};
        client.ws.on("close", (status, reason) => client.emit("close", status, reason));
        client.ws.on("error", (err) => client.emit("error", err));
        client.ws.on("close", (code, reason) => {
            if (remaining.bytes) {
                client.emit("error", "Got close while reading a binary message");
            }
            if (client) {
                client.emit("close", { code: code, reason: reason });
            }
            client.ws.removeAllListeners();
        });

        client.ws.on("message", (msg) => {
            switch (typeof msg) {
                case "string": {
                    if (remaining.bytes) {
                        // bad, client have to send all the data in a binary message before sending JSON
                        client.error(`Got JSON message while ${remaining.bytes} bytes remained of a binary message`);
                        return;
                    }
                    // assume JSON
                    let json: Record<string, unknown> | undefined;
                    let err = "";
                    try {
                        json = JSON.parse(msg);
                    } catch (e: unknown) {
                        err = (e as Error).message;
                    }
                    if (json === undefined) {
                        client.error(`Unable to parse string message as JSON: ${err}`);
                        return;
                    }

                    if (json.type === "log") {
                        client.emit("log", json);
                        return;
                    }
                    if (json.type !== "uploadEnvironment") {
                        client.error('Expected type: "uploadEnvironment"');
                        return;
                    }

                    if (!("hash" in json)) {
                        console.log(json);
                        client.error("Need a hash property");
                        return;
                    }
                    if (!("bytes" in json) || typeof json.bytes !== "number") {
                        console.log(json);
                        client.error("Need a bytes property");
                        return;
                    }

                    remaining.type = "uploadEnvironmentData";
                    remaining.bytes = json.bytes;

                    client.emit("uploadEnvironment", json);
                    break;
                }
                case "object":
                    if (msg instanceof Buffer) {
                        if (!msg.length) {
                            // no data?
                            client.error("No data in buffer");
                            return;
                        }
                        if (!remaining.bytes) {
                            client.error("Got binary message without a preceeding json message describing the data");
                            return;
                        }
                        if (msg.length > remaining.bytes) {
                            // woops
                            client.error(`length ${msg.length} > ${remaining.bytes}`);
                            return;
                        }
                        remaining.bytes -= msg.length;
                        assert(typeof remaining.type === "string");
                        client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                    }
                    break;
            }
        });
    }

    _handleBuilder(req: express.Request, client: Builder): void {
        client.ws.on("close", (code, reason) => {
            client.emit("close", { code: code, reason: reason });
            client.ws.removeAllListeners();
        });

        client.ws.on("error", () => {
            client.emit("close", { code: 1005, reason: "unknown" });
            client.ws.removeAllListeners();
        });

        if (!("x-fisk-port" in req.headers)) {
            client.error("No x-fisk-port header");
            return;
        }

        if (!("x-fisk-environments" in req.headers)) {
            client.error("No x-fisk-builder-environment header");
            return;
        }

        if (!("x-fisk-slots" in req.headers) || !parseInt(header(req, "x-fisk-slots") || "")) {
            client.error("No x-fisk-slots header");
            return;
        }

        const confVersion = parseInt(header(req, "x-fisk-config-version") || "");
        if (confVersion !== this.configVersion) {
            client.error(`Bad config version, expected ${this.configVersion}, got ${confVersion}`);
            return;
        }

        client.port = parseInt(header(req, "x-fisk-port") || "");
        client.name = header(req, "x-fisk-builder-name") || "";
        client.hostname = header(req, "x-fisk-builder-hostname") || "";
        const labels = header(req, "x-fisk-builder-labels");
        if (labels) {
            client.labels = labels.split(/ +/).filter((x) => x);
        }
        client.system = header(req, "x-fisk-system") || "";
        client.slots = parseInt(header(req, "x-fisk-slots") || "");
        client.npmVersion = header(req, "x-fisk-npm-version") || "";
        (header(req, "x-fisk-environments") || "")
            .replace(/\s+/g, "")
            .split(";")
            .forEach((env) => {
                if (env) {
                    client.environments[env] = true;
                }
            });
        client.ws.on("message", (msg) => {
            // console.log("Got message from builder", typeof msg, msg.length);
            switch (typeof msg) {
                case "string": {
                    // assume JSON
                    let json: Record<string, unknown> | undefined;
                    try {
                        json = JSON.parse(msg);
                    } catch (e) {
                        json = undefined;
                        /* */
                    }

                    if (json === undefined) {
                        client.error("Unable to parse string message as JSON");
                        return;
                    }
                    // console.log("Got message", json);
                    if ("type" in json && typeof json.type === "string") {
                        client.emit(json.type, json);
                    } else {
                        console.error("Bad message without type", json);
                    }
                }
                case "object":
                    if (msg instanceof Buffer) {
                        client.emit("data", msg);
                    }
                    break;
            }
        });
        // console.log("Got dude", client);
        this.emit("builder", client);
    }

    _handleMonitor(req: express.Request, client: Client): void {
        client.nonce = this.nonces.get(req);
        // console.log("Got nonce", req.nonce);
        client.ws.on("message", (message) => client.emit("message", message));
        this.emit("monitor", client);
        client.ws.on("close", (code, reason) => {
            client.ws.removeAllListeners();
            client.emit("close", { code: code, reason: reason });
        });

        client.ws.on("error", (err) => client.emit("error", err));
    }

    _handleClientVerify(req: express.Request, client: Client): void {
        Object.assign(client, { npmVersion: header(req, "x-fisk-npm-version") });
        this.emit("clientVerify", client);
        client.ws.on("close", (code, reason) => {
            client.ws.removeAllListeners();
            client.emit("close", { code: code, reason: reason });
        });

        client.ws.on("error", (err) => client.emit("error", err));
    }

    _handleConnection(ws: WebSocket, req: express.Request): void {
        let client = undefined;
        let ip = req.connection.remoteAddress;
        // console.log("_handleConnection", ip);

        if (!ip) {
            ws.send('{"error": "no ip for some reason"}');
            ws.close();
            return;
        }
        if (ip.substr(0, 7) === "::ffff:") {
            ip = ip.substr(7);
        }

        const url = new Url(req.url, this.baseUrl);
        switch (url.pathname) {
            case "/compile":
                this._handleCompile(req, ws, ip);
                break;
            case "/builder":
                client = new Builder(ws, ip);
                this._handleBuilder(req, client);
                break;
            case "/monitor":
                client = new Client(ClientType.Monitor, ws, ip);
                this._handleMonitor(req, client);
                break;
            case "/client_verify":
                client = new Client(ClientType.ClientVerify, ws, ip);
                this._handleClientVerify(req, client);
                break;
            default:
                console.error(`Invalid pathname ${url.pathname} from: ${ip}`);
                ws.close();
        }
    }
}
