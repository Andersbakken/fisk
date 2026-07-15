import { Compile } from "./Compile";
import EventEmitter from "events";
import fs from "fs-extra";
import net from "net";
import path from "path";
import type { Common } from "../common";
import type { Options } from "@jhanssen/options";

// systemd socket activation: the first passed fd is at SD_LISTEN_FDS_START (3).
// See sd_listen_fds(3). systemd sets LISTEN_PID to the PID it should be
// consumed by; a child process must be exec'd (not fork+exec of a wrapper)
// so its own pid matches. We fail hard on any mismatch rather than silently
// falling back to path binding, because that fallback would unlink the
// systemd-owned socket file and re-create a new inode, defeating the whole
// point of activation (and breaking every docker container that bind-mounted
// the socket file).
const SD_LISTEN_FDS_START = 3;

type ActivationResult = { fd: number } | "none" | "mismatch";

function systemdListenFd(): ActivationResult {
    const pidRaw = process.env.LISTEN_PID;
    const fdsRaw = process.env.LISTEN_FDS;
    // Consume the activation env so any subprocess we spawn does not inherit
    // stale LISTEN_PID/LISTEN_FDS. sd_listen_fds_with_names(3) recommends
    // unsetenv after use.
    delete process.env.LISTEN_PID;
    delete process.env.LISTEN_FDS;
    delete process.env.LISTEN_FDNAMES;

    if (!pidRaw && !fdsRaw) {
        return "none";
    }
    if (!pidRaw || !fdsRaw) {
        return "mismatch";
    }
    const pid = Number(pidRaw);
    const count = Number(fdsRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(count) || count < 1) {
        return "mismatch";
    }
    if (pid !== process.pid) {
        return "mismatch";
    }
    return { fd: SD_LISTEN_FDS_START };
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
        const activation = systemdListenFd();
        if (activation === "mismatch") {
            console.error(
                "fisk-daemon: LISTEN_FDS/LISTEN_PID present but do not match our pid. Refusing to fall back to path binding -- exiting so systemd can restart us with correct activation."
            );
            process.exit(1);
        }
        if (activation !== "none") {
            const inheritedFd = activation.fd;
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
