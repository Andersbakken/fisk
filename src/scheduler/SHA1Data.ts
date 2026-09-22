import type { Builder } from "./Builder";

export class SHA1Data {
    nodes: Set<Builder>;

    constructor(readonly fileSize: number, node: Builder) {
        this.fileSize = fileSize;
        this.nodes = new Set([node]);
    }
}
