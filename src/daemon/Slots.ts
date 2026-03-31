import EventEmitter from "events";
import assert from "assert";

export interface Data {
    pid: number;
}

interface MapData {
    cb: () => void;
    data: Data;
}

export class Slots extends EventEmitter {
    private pending: Map<number, MapData>;
    private used: Map<number, Data>;
    private _totalAcquired: number;

    constructor(private readonly count: number, private readonly name: string, private readonly debug: boolean) {
        super();
        this.used = new Map();
        this.pending = new Map();
        this._totalAcquired = 0;
        if (this.debug) {
            console.log("Slots created", this.toString());
        }
    }

    get capacity(): number {
        return this.count;
    }

    get active(): number {
        return this.used.size;
    }

    get totalAcquired(): number {
        return this._totalAcquired;
    }

    tryAcquire(id: number, data: Data): boolean {
        if (this.used.size < this.count) {
            this.used.set(id, data);
            ++this._totalAcquired;
            if (this.debug) {
                console.log("tryAcquire succeeded", id, data, this.toString());
            }
            this.emit("changed");
            return true;
        }
        return false;
    }

    acquire(id: number, data: Data, cb: () => void): void {
        if (this.used.size < this.count) {
            this.used.set(id, data);
            ++this._totalAcquired;
            if (this.debug) {
                console.log("acquired slot", id, data, this.toString());
            }
            this.emit("changed");
            cb();
        } else {
            if (this.debug) {
                console.log("pending slot", id, this.toString());
            }
            this.pending.set(id, { data: data, cb: cb });
        }
    }

    release(id: number): void {
        this.pending.delete(id);
        if (this.used.has(id)) {
            const data = this.used.get(id);
            this.used.delete(id);
            assert(this.used.size < this.count);
            assert(this.used.size + 1 === this.count || this.pending.size === 0);
            if (this.debug) {
                console.log("released", id, data, this.toString());
            }
            // eslint-disable-next-line no-unreachable-loop
            for (const p of this.pending) {
                this.used.set(p[0], p[1].data);
                this.pending.delete(p[0]);
                ++this._totalAcquired;
                p[1].cb();
                break;
            }
            this.emit("changed");
        }
    }

    toString(): string {
        return `${this.name} ${this.used.size}/${this.count}`;
    }

    dump(): unknown {
        const pending: Record<number, unknown> = {};
        const used: Record<number, unknown> = {};
        for (const p of this.pending) {
            pending[p[0]] = p[1].data;
        }

        for (const p of this.used) {
            used[p[0]] = p[1];
        }
        return { used: used, pending: pending, capacity: this.count, usedSize: this.used.size };
    }
}
