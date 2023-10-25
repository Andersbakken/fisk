export interface CompileFinishedEventFile {
    absolute: string;
    path: string;
}

export interface CompileFinishedEvent {
    cppSize: number;
    compileDuration: number;
    exitCode: number;
    success: boolean;
    error?: string;
    sourceFile: string;
    files: CompileFinishedEventFile[];
}
