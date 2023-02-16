export interface ObjectCacheAddedOrRemovedMessage {
    sha1: string;
    sourceFile: string;
    cacheSize: number;
    fileSize: number;
}
