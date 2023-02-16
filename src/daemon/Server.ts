import { Common } from "../common-ts/index";
import { Compile } from "./Compile";
import { OptionsFunction } from "@jhanssen/options";
import EventEmitter from "events";
import fs from "fs-extra";
import net from "net";
import path from "path";

export class Server extends EventEmitter {
    private readonly debug: boolean;
    private server?: net.Server;
    private option: OptionsFunction;
    private _connectionId: number;
    private _connections: Record<string, net.Socket>;

    readonly file: string;

    constructor(option: OptionsFunction, common: Common) {
        super();
        this.debug = option("debug") as boolean;
        this.file = option("socket", path.join(common.cacheDir(), "socket")) as string;
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
