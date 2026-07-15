import { Compile } from "./Compile";
import EventEmitter from "events";
import fs from "fs-extra";
import net from "net";
import path from "path";
import type { Common } from "../common";
import type { Options } from "@jhanssen/options";

// systemd socket activation: the first passed fd is at SD_LISTEN_FDS_START (3).
// See sd_listen_fds(3). When LISTEN_PID matches our pid and LISTEN_FDS >= 1,
// listen on the inherited fd instead of creating a new socket. This lets
// systemd own the socket file, so its inode survives daemon restarts and any
// bind-mount of the socket (e.g. docker -v /tmp/fisk.socket:/tmp/fisk.socket)
// keeps working across upgrades.
const SD_LISTEN_FDS_START = 3;

function systemdListenFd(): number | undefined {
    const pid = process.env.LISTEN_PID;
    const fds = process.env.LISTEN_FDS;
    if (!pid || !fds) {
        return undefined;
    }
    if (parseInt(pid, 10) !== process.pid) {
        return undefined;
    }
    const count = parseInt(fds, 10);
    if (!count || count < 1) {
        return undefined;
    }
    return SD_LISTEN_FDS_START;
}

export class Server extends EventEmitter {
    private readonly debug: boolean;
    private server?: net.Server;
    private _connectionId: number;
    private _connections: Record<string, net.Socket>;
    private _activated: boolean;

    readonly file: string;

    constructor(private readonly option: Options, common: Common) {
        super();
        this.debug = option("debug") as boolean;
        this.file = option("socket", path.join(common.cacheDir(), "socket")) as string;
        this.server = undefined;
        this.option = option;
        this._connections = {};
        this._connectionId = 0;
        this._activated = false;
    }

    close(): void {
        if (this.debug) {
            console.log("Server::close");
        }
        if (this.server) {
            this.server.close();
        }
        // When socket-activated, systemd owns the socket file. Do not unlink
        // it -- that would break the bind-mount contract for existing clients.
        if (!this._activated) {
            try {
                fs.unlinkSync(this.file);
            } catch (err) {
                /* */
            }
        }
    }

    listen(): Promise<void> {
        const inheritedFd = systemdListenFd();
        if (inheritedFd !== undefined) {
            this._activated = true;
            if (this.debug) {
                console.log("Server::listen using systemd-activated fd", inheritedFd);
            }
            return new Promise<void>((resolve: () => void) => {
                let connected = false;
                this.server = net.createServer(this._onConnection.bind(this));
                this.server.listen({ fd: inheritedFd }, () => {
                    connected = true;
                    resolve();
                });
                this.server.on("error", (err: Error) => {
                    if (!connected) {
                        console.error("Got server error", err);
                        setTimeout(this.listen.bind(this), 1000);
                    }
                });
                this.server.on("close", () => {
                    if (!connected) {
                        setTimeout(this.listen.bind(this), 1000);
                    }
                });
            });
        }

        try {
            fs.unlinkSync(this.file); // this should be more
            // complicated with attempts to
            // cleanly shut down and whatnot
        } catch (err) {
            /* */
        }

        return new Promise<void>((resolve: () => void) => {
            let connected = false;
            this.server = net.createServer(this._onConnection.bind(this)).listen(this.file, () => {
                fs.chmodSync(this.file, "777");
                connected = true;
                resolve();
            });
            this.server.on("error", (err: Error) => {
                if (!connected) {
                    console.error("Got server error", err);
                    setTimeout(this.listen.bind(this), 1000);
                }
            });

            this.server.on("close", () => {
                if (!connected) {
                    setTimeout(this.listen.bind(this), 1000);
                }
            });
        });
    }
    _onConnection(conn: net.Socket): void {
        const compile = new Compile(conn, ++this._connectionId, this.option);
        if (this.debug) {
            console.log("Server::_onConnection", compile.id);
        }
        if (this._connectionId === Math.pow(2, 31) - 1) {
            this._connectionId = 0;
        }
        this._connections[compile.id] = conn;
        compile.on("end", () => {
            if (this.debug) {
                console.log("Compile::end");
            }

            delete this._connections[compile.id];
        });
        this.emit("compile", compile);
    }
}
