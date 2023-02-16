export interface JobScheduledMessage {
    client: {
        name: string;
        hostname: string;
        ip: string;
        user: string;
        labels?: string;
    };
    builder: {
        name: string;
        hostname: string;
        ip: string;
        user: string;
        port: number;
        labels?: string;
    };
    id: number;
    sourceFile: string;
}
