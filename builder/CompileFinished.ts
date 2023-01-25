export type CompileFinishedFile = {
    path: string;
    mapped?: string;
};

export type CompileFinished = {
    type: "compileFinished";
    sourceFile: string;
    success: boolean;
    id: number;
    files: CompileFinishedFile[];
    exitCode: number;
    error?: string;
};
