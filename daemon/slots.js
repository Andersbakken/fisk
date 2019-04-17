const EventEmitter = require('events');
const assert = require('assert');

class Slots extends EventEmitter
{
    constructor(count, name, debug)
    {
        super();
        this.count = count;
        this.name = name;
        this.used = new Map();
        this.debug = debug;
        this.pending = new Map();
        if (this.debug)
            console.log("Slots created", this.toString());
    }

    acquire(id, data, cb)
    {
        if (this.used.size < this.count) {
            this.used.set(id, data);
            if (this.debug)
                console.log("acquired slot", id, data, this.toString());
            cb();
        } else {
            if (this.debug)
                console.log("pending slot", id, this.toString());
            this.pending.set(id, {data: data, cb: cb});
        }
    }

    release(id)
    {
        this.pending.delete(id);
        if (this.used.has(id)) {
            let data = this.used.get(id);
            this.used.delete(id);
            assert(this.used.size < this.count);
            assert(this.used.size + 1 == this.count || this.pending.size == 0);
            if (this.debug)
                console.log("released", id, data, this.toString());
            for (let p of this.pending) {
                this.used.set(p[0], p[1].data);
                this.pending.delete(p[0]);
                p[1].cb();
                break;
            }
       }
    }
    toString()
    {
        return `${this.name} ${this.used.size}/${this.count}`;
    }

    dump()
    {
        let pending = {}, used = {};
        for (let p of this.pending) {
            pending[p[0]] = p[1].data;
        }

        for (let p of this.used) {
            used[p[0]] = p[1];
        }
        return { used: used, pending: pending };
    }
}

module.exports = Slots;
