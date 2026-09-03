import { Client, ClientType } from "./Client";
import type { ClientSocket } from "./Client";
import type { Options } from "@jhanssen/options";


export class Builder extends Client {
    jobsPerformed: number;
    totalCompileSpeed: number;
    totalUploadSpeed: number;
    system: string;
    slots: number;
    load: number;
    lastJob: number;
    activeClients: number;
    jobsScheduled: number;
    environments: Record<string, boolean | number>;

    constructor(ws: ClientSocket, ip: string, option?: Options) {
        super(ClientType.Builder, ws, ip, option);
        this.jobsPerformed = 0;
        this.totalCompileSpeed = 0;
        this.totalUploadSpeed = 0;
        this.system = "";
        this.slots = 0;
        this.load = 0;
        this.lastJob = 0;
        this.activeClients = 0;
        this.jobsScheduled = 0;
        this.environments = {};
    }
}
