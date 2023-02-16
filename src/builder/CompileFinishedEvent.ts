export type CompileFinishedEventFile = {
    absolute: string;
    path: string;
};

export type CompileFinishedEvent = {
    cppSize: number;
    compileDuration: number;
    exitCode: number;
    success: boolean;
    error?: string;
    sourceFile: string;
    files: CompileFinishedEventFile[];
}
