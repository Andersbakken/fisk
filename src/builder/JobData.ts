import WebSocket from "ws";

export type JobData = {
    ws: WebSocket;
    ip: string;
    hash: string;
    name: string;
    sha1: string;
    hostname?: string;
    user?: string;
    sourceFile?: string;
    priority?: number;
    id: number;
    builderIp?: string;
};
