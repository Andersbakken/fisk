import { NodeData } from "./NodeData";

export class SHA1Data {
    fileSize: number;
    nodes: NodeData[];

    constructor(fileSize: number, node: NodeData) {
        this.fileSize = fileSize;
        this.nodes = [node];
    }
}
