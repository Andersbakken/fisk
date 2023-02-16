export class NodeData {
    size: number;
    maxSize: number;
    sha1s: string[];

    constructor(size: number, maxSize: number, sha1s: string[]) {
        this.sha1s = sha1s;
        this.size = size;
        this.maxSize = maxSize;
    }
}
