import { LinkProperties } from "./LinkProperties";

export class Links {
    private _targets: Record<string, LinkProperties>;

    constructor() {
        this._targets = {};
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
    }

    get targets(): Record<string, LinkProperties> {
        return this._targets;
    }

    toObject(): Record<string, LinkProperties> {
        return this._targets;
    }

    contains(targetHash: string): boolean {
        return targetHash in this._targets;
    }

    arguments(targetHash: string): string[] {
        const ret = this._targets[targetHash];
        return ret ? ret.arguments : [];
    }

    blacklist(targetHash: string): string[] {
        const ret = this._targets[targetHash];
        return ret ? ret.blacklist : [];
    }

    set(targetHash: string, args: string[], blacklist?: string[]): void {
        this._targets[targetHash] = new LinkProperties(args, blacklist);
    }

    unset(targetHash: string): void {
        delete this._targets[targetHash];
    }

    get targetHashes(): string[] {
        return Object.keys(this._targets);
    }

    get size(): number {
        return Object.keys(this._targets).length;
    }
}
