export type VMReadyMessage = {
    type: "ready";
};
export type VMErrorMessage = {
    type: "error";
    message: string;
};

export type VMCompileStdOut = {
    type: "compileStdOut";
    id: number;
    data: string;
};

export type VMCompileStdErr = {
    type: "compileStdErr";
    id: number;
    data: string;
};

export type VMCompileFinishedFile = {
    path: string;
    mapped?: string;
};

export type VMCompileFinished = {
    type: "compileFinished";
    sourceFile: string;
    success: boolean;
    id: number;
    files: VMCompileFinishedFile[];
    exitCode: number;
    error?: string;
};

export type VMMessage = VMReadyMessage | VMErrorMessage | VMCompileStdOut | VMCompileStdErr | VMCompileFinished;
