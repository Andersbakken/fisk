import type { CompileOutputFile } from "./CompileOutputFile";

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

export interface VMCompileFinished {
    type: "compileFinished";
    sourcePath: string;
    success: boolean;
    id: number;
    files: CompileOutputFile[];
    exitCode: number;
    error?: string;
}

export type VMRuntimeMessage = VMReadyMessage | VMErrorMessage | VMCompileStdOut | VMCompileStdErr | VMCompileFinished;
