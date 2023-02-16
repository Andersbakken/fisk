export type ObjectCacheMessageSha1 = {
    sha1: string;
    fileSize: number;
};

export interface ObjectCacheMessage {
    sha1s: ObjectCacheMessageSha1[];
    maxSize: number;
    cacheSize: number;
}
