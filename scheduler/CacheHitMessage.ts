export interface CacheHitMessage {
    client: {
        hostname: string;
        ip: string;
        name: string;
        user: string;
    };
    sourceFile: string;
    sha1: string;
    id: number;
}
