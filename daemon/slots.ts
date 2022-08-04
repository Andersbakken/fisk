import EventEmitter from "events";
import assert from "assert";

export type Dump = {
    used: number;
    pending: Record<number, unknown>;
    capacity: number;
};

class Slots extends EventEmitter {
    private count: number;
    private name: string;
    private debug: boolean;
    private used: Map<number, unknown>;
    private pending: Map<number, { data: unknown; cb: () => void }>;

    constructor(count: number, name: string, debug: boolean) {
        super();
        this.count = count;
        this.name = name;
        this.used = new Map();
        this.debug = debug;
        this.pending = new Map();
        if (this.debug) {
            console.log("Slots created", this.toString());
        }
    }

    acquire(id: number, data: unknown, cb: () => void): void {
        if (this.used.size < this.count) {
            this.used.set(id, data);
            if (this.debug) {
                console.log("acquired slot", id, data, this.toString());
            }
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
                p[1].cb();
                break;
            }
        }
    }
    toString(): string {
        return `${this.name} ${this.used.size}/${this.count}`;
    }

    dump(): Dump {
        const pending: Record<number, unknown> = {},
            used: Record<number, unknown> = {};
        for (const p of this.pending) {
            pending[p[0]] = p[1].data;
        }

        for (const p of this.used) {
            used[p[0]] = p[1];
        }
        return { pending: pending, capacity: this.count, used: this.used.size };
    }
}

export { Slots };
