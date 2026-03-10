export interface ObjectCacheAddedOrRemovedMessage {
    sha1: string;
    sourcePath: string;
    cacheSize: number;
    fileSize: number;
}
