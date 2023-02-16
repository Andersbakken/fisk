import { Builder } from "./Builder";

export class SHA1Data {
    fileSize: number;
    nodes: Builder[];

    constructor(fileSize: number, node: Builder) {
        this.fileSize = fileSize;
        this.nodes = [node];
    }
}
