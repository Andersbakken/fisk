export class LinkProperties {
    public arguments: string[];
    public blacklist: string[];

    constructor(args?: string[], blacklist?: string[]) {
        this.arguments = args || [];
        this.blacklist = blacklist || [];
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
    }
}
