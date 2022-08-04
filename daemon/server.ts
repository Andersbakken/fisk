import { Common } from "../common";
import { Compile } from "./compile";
import { Option } from "@jhanssen/options";
import EventEmitter from "events";
import fs from "fs-extra";
import net, { Socket } from "net";
import path from "path";

type Opts = (key: string, defaultValue?: Option) => Option;

class Server extends EventEmitter {
    private debug: boolean;
    private server?: net.Server;
    private option: Opts;
    private _connections: Record<number, Socket>;
    private _connectionId: number;

    public file: string;

    constructor(option: Opts, common: Common) {
        super();
        this.debug = Boolean(option("debug"));
        this.file = String(option("socket", path.join(common.cacheDir(), "socket")));
        this.server = undefined;
        this.option = option;
        this._connections = {};
        this._connectionId = 0;
    }

    close(): void {
        if (this.debug) {
            console.log("Server::close");
        }
        if (this.server) {
            this.server.close();
        }
        try {
            fs.unlinkSync(this.file);
        } catch (err) {
            /* */
        }
    }

    listen(): Promise<void> {
        try {
            fs.unlinkSync(this.file); // this should be more
            // complicated with attempts to
            // cleanly shut down and whatnot
        } catch (err) {
            /* */
        }
        return new Promise((resolve) => {
            let connected = false;
            this.server = net.createServer(this._onConnection.bind(this)).listen(this.file, () => {
                fs.chmodSync(this.file, "777");
                connected = true;
                resolve();
            });
            this.server.on("error", (err) => {
                if (!connected) {
                    console.error("Got server error", err);
                    setTimeout(this.listen.bind(this), 1000);
                }
            });

            this.server.on("close", (err: unknown) => {
                if (!connected) {
                    console.error("Got server error", err);
                    setTimeout(this.listen.bind(this), 1000);
                }
            });
        });
    }
    _onConnection(conn: Socket): void {
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

export { Server };
