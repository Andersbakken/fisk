import type { LinkProperties } from "./LinkProperties";

export class Links {
    private _targets: Record<string, LinkProperties>;

    constructor() {
        this._targets = {};
    }

    get targets(): Record<string, LinkProperties> {
        return this._targets;
    }

    get targetHashes(): string[] {
        return Object.keys(this._targets);
    }

    get size(): number {
        return Object.keys(this._targets).length;
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
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
        this._targets[targetHash] = { arguments: args, blacklist: blacklist || [] };
    }

    unset(targetHash: string): void {
        delete this._targets[targetHash];
    }
}
