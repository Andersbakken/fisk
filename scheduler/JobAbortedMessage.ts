export interface JobAbortedMessage {
    compileSpeed?: number;
    uploadSpeed?: number;
    cppSize?: number;
    compileDuration?: number;
    uploadDuration?: number;
    id: number;
    webSocketError?: string;
}
