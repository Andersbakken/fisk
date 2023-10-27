import type { Builder } from "./Builder";

export class SHA1Data {
    nodes: Builder[];

    constructor(readonly fileSize: number, node: Builder) {
        this.fileSize = fileSize;
        this.nodes = [node];
    }
}
