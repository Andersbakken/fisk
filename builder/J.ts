import { CompileJob } from "./CompileJob";
import { Job } from "./Job";

export type J = {
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
};
