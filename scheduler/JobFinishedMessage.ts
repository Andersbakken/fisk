export interface JobFinishedMessage {
    id: number;
    compileSpeed: number;
    uploadSpeed: number;
    cppSize: number;
    compileDuration: number;
    uploadDuration: number;
}
