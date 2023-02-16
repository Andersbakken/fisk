export interface ObjectCacheMessage {
    type: "objectCache";
    sha1s: Array<{ sha1: string; fileSize: number }>;
    maxSize: number;
    cacheSize: number;
}
