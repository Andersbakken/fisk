export type FetchCacheObjectsMessageObject = {
    sha1: string;
    source: string;
};

export type FetchCacheObjectsMessage = {
    type: "fetch_cache_objects";
    objects: FetchCacheObjectsMessageObject[];
};
