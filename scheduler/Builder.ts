export interface Builder {
    ip: string;
    name: string;
    hostname?: string;
    port: number;
    labels?: string[];
}
