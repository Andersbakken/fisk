interface IndexItem {
    bytes: number;
    uncompressedSize: number;
}

export interface Response {
    type: "response";
    // path: string;
    sha1: string;
    index: IndexItem[];
    error?: string;
    exitCode: number;
    success: boolean;
    sourceFile?: string;
    environment?: string;
    commandLine?: string[];
    stderr?: string;
    stdout?: string;
}
