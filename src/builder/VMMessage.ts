// From VM to VM_runtime
export interface VMCancelMessage {
    type: "cancel";
    id: number;
}

export interface VMCompileMessage {
    type: "compile";
    id: number;
    argv0: string;
    dir: string;
    sourceFileName: string;
    clientSourcePath: string;
    clientCwd: string;
    commandLine: string[];
}

export interface VMDestroyMessage {
    type: "destroy";
}

export interface VMSetDebugMessage {
    type: "setDebug";
    debug: boolean;
}
export type VMMessage = VMCancelMessage | VMCompileMessage | VMDestroyMessage | VMSetDebugMessage;
