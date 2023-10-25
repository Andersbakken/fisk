export interface VMReadyMessage {
    type: "ready";
}
export interface VMErrorMessage {
    type: "error";
    message: string;
}

export interface VMCompileStdOut {
    type: "compileStdOut";
    id: number;
    data: string;
}

export interface VMCompileStdErr {
    type: "compileStdErr";
    id: number;
    data: string;
}

export interface VMCompileFinishedFile {
    path: string;
    mapped?: string;
}

export interface VMCompileFinished {
    type: "compileFinished";
    sourceFile: string;
    success: boolean;
    id: number;
    files: VMCompileFinishedFile[];
    exitCode: number;
    error?: string;
}

export type VMMessage = VMReadyMessage | VMErrorMessage | VMCompileStdOut | VMCompileStdErr | VMCompileFinished;
