export interface ObjectCacheEntry {
    sha1: string;
    fileSize: number;
}

export interface ObjectCacheSnapshot {
    sha1s: ObjectCacheEntry[];
    maxSize: number;
    cacheSize: number;
}

export interface ObjectCacheMessage extends ObjectCacheSnapshot {
    type: "objectCache";
}
