import { Client, ClientType } from "./Client";
import { Compile } from "./Compile";
import { DaemonJobSocket } from "./DaemonJobSocket";
import type { ClientSocket } from "./Client";
import type { Options } from "@jhanssen/options";

export interface DaemonJobRequest {
    id: number;
    environment: string;
    sourcePath: string;
    sha1?: string;
    name?: string;
    user?: string;
    hostname?: string;
    builder?: string;
    labels?: string[];
    npmVersion?: string;
}

function decode(message: string): unknown {
    try {
        return JSON.parse(message);
    } catch (err) {
        return { error: `Unserializable scheduler message: ${message}` };
    }
}

export class DaemonConnection extends Client {
    private readonly jobs: Map<number, Compile>;

    constructor(ws: ClientSocket, ip: string, option?: Options) {
        super(ClientType.Daemon, ws, ip, option);
        this.jobs = new Map();
    }

    get activeJobs(): number {
        return this.jobs.size;
    }

    createJob(request: DaemonJobRequest): Compile | undefined {
        if (this.jobs.has(request.id)) {
            return undefined;
        }
        const socket = new DaemonJobSocket(
            (message: string) => {
                this.send({ type: "jobMessage", id: request.id, message: decode(message) });
            },
            (reason: string) => {
                this.finishJob(request.id, reason, true);
            }
        );
        const compile = new Compile(
            socket,
            this.ip,
            request.environment,
            request.sourcePath,
            request.sha1,
            this.option
        );
        compile.canUploadEnvironment = false;
        compile.npmVersion = request.npmVersion || "";
        compile.name = request.name || this.name;
        compile.hostname = request.hostname || this.hostname;
        compile.user = request.user || "";
        if (request.builder) {
            compile.builder = request.builder;
        }
        if (request.labels?.length) {
            compile.labels = request.labels;
        }
        this.jobs.set(request.id, compile);
        return compile;
    }

    // The end of a job is a message now, not a socket close, so every exit has to
    // funnel through here: the daemon saying the fiskc process is gone, the
    // scheduler closing the job itself, or this whole connection dropping. Missing
    // one leaks a builder's activeClients slot and the scheduler's activeJobs
    // count for as long as the scheduler runs.
    finishJob(id: number, reason: string, notifyDaemon: boolean): void {
        const compile = this.jobs.get(id);
        if (!compile) {
            return;
        }
        this.jobs.delete(id);
        if (notifyDaemon) {
            this.send({ type: "jobClosed", id, reason });
        }
        compile.emit("close", { code: 1000, reason });
        compile.removeAllListeners();
    }

    finishAllJobs(reason: string): void {
        for (const id of Array.from(this.jobs.keys())) {
            this.finishJob(id, reason, false);
        }
    }
}
