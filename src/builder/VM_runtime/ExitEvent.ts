export interface ExitEventFile {
    path: string;
    mapped?: string;
}

export interface ExitEvent {
    exitCode: number;
    files: ExitEventFile[];
    error?: string;
    sourcePath: string;
}
