const EventEmitter = require('events');
const assert = require('assert');

class Slots extends EventEmitter
{
    constructor(count, name, debug)
    {
        super();
        this.count = count;
        this.name = name;
        this.used = new Set;
        this.debug = debug;
        this.pending = new Map();
        if (this.debug)
            console.log("Slots created", this.toString());
    }

    acquire(id, cb)
    {
        if (this.used.size < this.count) {
            this.used.add(id);
            if (this.debug)
                console.log("acquired slot", id, this.toString());
            cb();
        } else {
            if (this.debug)
                console.log("pending slot", id, this.toString());
            this.pending.set(id, cb);
        }
    }

    release(id)
    {
        this.pending.delete(id);
        if (this.used.delete(id)) {
            assert(this.used.size < this.count);
            assert(this.used.size + 1 == this.count || this.pending.size == 0);
            if (this.debug)
                console.log("released", id, this.toString());
            for (let p of this.pending) {
                this.used.add(p[0]);
                this.pending.delete(p[0]);
                p[1]();
                break;
            }
       }
    }
    toString()
    {
        return `${this.name} ${this.used.size}/${this.count}`;
    }
}

module.exports = Slots;
