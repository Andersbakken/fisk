export interface MonitorMessage {
    type: string;
    file?: string;
    srcHash?: string;
    user?: string;
    password?: string;
    hmac?: string;
    targetHash?: string;
    arguments?: string[];
    blacklist?: string[];
}
