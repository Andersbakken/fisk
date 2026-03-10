export interface CacheHitMessage {
    client: {
        hostname: string;
        ip: string;
        name: string;
        user: string;
    };
    sourcePath: string;
    sha1: string;
    id: number;
}
