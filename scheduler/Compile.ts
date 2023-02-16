import { Client, ClientType } from "./Client";
import { OptionsFunction } from "@jhanssen/options";
import WebSocket from "ws";

export class Compile extends Client {
    environment: string;
    builder?: string;
    sha1?: string;
    sourceFile: string;

    constructor(ws: WebSocket, ip: string, option?: OptionsFunction) {
        super(ClientType.Compile, ws, ip, option);
        this.environment = "";
        this.sourceFile = "";
    }
}
