export type CompileFinished = {
    type: "compileFinished";
    sourceFile: string;
    success: boolean;
    id: number;
    files: string[];
    exitCode: number;
    error?: string;
};
