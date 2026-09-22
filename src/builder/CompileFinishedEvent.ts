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
    sourcePath: string;
    files: CompileFinishedEventFile[];

    // The compile directory stays on disk until this is called, so the handler
    // can read the output files without racing the cleanup. Must be called
    // exactly once, on every path out of the handler, or the directory leaks
    // until the builder restarts.
    release: () => void;
}
