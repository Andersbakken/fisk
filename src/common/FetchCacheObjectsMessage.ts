export interface FetchCacheObjectsMessageObject {
    sha1: string;
    source: string;
}

export interface FetchCacheObjectsMessage {
    type: "fetch_cache_objects";
    objects: FetchCacheObjectsMessageObject[];
}
