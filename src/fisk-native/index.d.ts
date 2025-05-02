export interface Passwd {
    name: string;
    passwd: string;
    uid: number;
    gid: number;
    gecos: string | null;
    shell: string;
    dir: string;
}

export function getpwnam(user: string): Passwd;
export function chroot(path: string): void;

export type Resource = "core" | "cpu" | "data" | "fsize" | "nofile" | "nproc" | "stack" | "as";
export function setrlimit(resource: Resource, limit: { soft?: number | null; hard?: number | null }): void;
