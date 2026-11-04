export class NodeData {
    readonly sha1s: Set<string>;

    constructor(public size: number, readonly maxSize: number, sha1s: Iterable<string>) {
        this.sha1s = new Set(sha1s);
    }
}
