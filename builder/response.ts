type ResponseIndex = { path: string; bytes: number };
export type Response = {
    type: "response";
    index: ResponseIndex[];
    success: boolean;
    exitCode: number;
    sha1: string;
    stderr?: string;
    stdout?: string;
    error?: string;
};
