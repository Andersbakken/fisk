export interface JobMonitorMessageClient {
    hostname?: string;
    ip: string;
    name?: string;
    user?: string;
    labels?: string[];
    port?: number;
}

export interface JobMonitorMessageBase {
    client: JobMonitorMessageClient;
    sourceFile: string;
    builder: JobMonitorMessageClient;
    id: number;
    jobs?: number;
    jobsFailed?: number;
    jobsStarted?: number;
    jobsFinished?: number;
    jobsScheduled?: number;
    cacheHits?: number;
}

export interface JobMonitorMessage extends JobMonitorMessageBase {
    type: "jobStarted" | "jobScheduled" | "cacheHit";
}
