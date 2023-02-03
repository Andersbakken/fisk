import prettybytes from "pretty-bytes";

export function prettySize(bytes: number): string {
    return bytes >= 1024 ? prettybytes(bytes) : String(bytes);
}
