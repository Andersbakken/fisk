declare module "mktemp" {
    export function createDir(pattern: string): Promise<string>;
}
