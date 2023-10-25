import { Client, ClientType } from "./Client";
import type { OptionsFunction } from "@jhanssen/options";
import type WebSocket from "ws";

export class Compile extends Client {
    environment: string;
    builder?: string;
    sha1?: string;
    sourceFile: string;

    constructor(
        ws: WebSocket,
        ip: string,
        environment: string,
        sourceFile: string,
        sha1?: string,
        option?: OptionsFunction
    ) {
        super(ClientType.Compile, ws, ip, option);
        this.environment = environment;
        this.sourceFile = sourceFile;
        this.sha1 = sha1;
    }
}
