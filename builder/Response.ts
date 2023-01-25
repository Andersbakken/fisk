type IndexItem = {
    bytes: number;
};

export type Response = {
    path: string;
    sha1: string;
    index: IndexItem[];
};
