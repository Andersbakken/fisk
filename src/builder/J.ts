import type { CompileJob } from "./CompileJob";
import type { Job } from "./Job";

export interface J {
    aborted: boolean;
    done: boolean;
    heartbeatTimer: NodeJS.Timeout | undefined;
    id: number;
    job: Job;
    started: boolean;
    stderr: string;
    stdout: string;

    buffer?: Buffer;
    objectCache?: boolean;
    op?: CompileJob;
    webSocketError?: string;

    cancel: () => void;
    start: () => void;
}
