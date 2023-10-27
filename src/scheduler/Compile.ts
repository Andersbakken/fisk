import { Client, ClientType } from "./Client";
import type { OptionsFunction } from "@jhanssen/options";
import type WebSocket from "ws";

export class Compile extends Client {
    builder?: string;

    constructor(
        ws: WebSocket,
        ip: string,
        readonly environment: string,
        readonly sourceFile: string,
        readonly sha1?: string,
        option?: OptionsFunction
    ) {
        super(ClientType.Compile, ws, ip, option);
    }
}
