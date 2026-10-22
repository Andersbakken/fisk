import type { CompileOutputFile } from "../CompileOutputFile";

export interface ExitEvent {
    exitCode: number;
    files: CompileOutputFile[];
    error?: string;
    sourcePath: string;
}
