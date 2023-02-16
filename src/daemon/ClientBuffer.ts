export class ClientBuffer {
    private buffers: Buffer[];
    private offset: number;

    constructor() {
        this.buffers = [];
        this.offset = 0;
    }

    write(buffer: Buffer): void {
        this.buffers.push(buffer);
        // console.log("write", buffer.length, this.buffers.length, this.available);
    }

    peek(): number {
        if (!this.available) {
            throw new Error("No data available");
        }
        return this.buffers[0][this.offset];
    }

    read(len: number): Buffer {
        if (!len) {
            throw new Error("Don't be a tool");
        }
        if (len > this.available) {
            throw new Error("We don't have this many bytes available " + len + ">" + this.available);
        }

        // console.log("read", len, this.available);
        let ret;

        if (this.buffers[0].length - this.offset >= len) {
            // buffers[0] is enough
            const buf = this.buffers[0];
            if (buf.length - this.offset === len) {
                ret = this.offset ? buf.slice(this.offset) : buf;
                this.offset = 0;
                this.buffers.splice(0, 1);
                return ret;
            }
            ret = buf.slice(this.offset, this.offset + len);
            this.offset += len;
            return ret;
        }

        ret = Buffer.allocUnsafe(len);
        let retOffset = 0;
        this.buffers[0].copy(ret, 0, this.offset);
        retOffset += this.buffers[0].length - this.offset;
        this.offset = 0;
        this.buffers.splice(0, 1);
        while (retOffset < len) {
            const needed = len - retOffset;
            const buf = this.buffers[0];
            if (buf.length <= needed) {
                this.buffers[0].copy(ret, retOffset);
                retOffset += this.buffers[0].length;
                this.buffers.splice(0, 1);
            } else {
                this.buffers[0].copy(ret, retOffset, 0, needed);
                retOffset += needed;
                this.offset = needed;
            }
        }
        return ret;
    }

    get available(): number {
        return this.buffers.reduce((total, buf) => total + buf.length, 0) - this.offset;
    }
}
