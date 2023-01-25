export type ExitEventFile = {
    path: string;
    mapped?: string;
}

export type ExitEvent = {
    exitCode: number;
    files: ExitEventFile[];
    error?: string;
    sourceFile: string;
};
