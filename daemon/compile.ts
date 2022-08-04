const EventEmitter = require('events');
const ClientBuffer = require('./clientbuffer');
const Constants = require('./constants');

class Compile extends EventEmitter
{
    constructor(conn, id, option)
    {
        super();
        this.debug = option("debug");
        this.id = id;
        this.connection = conn;
        this.buffer = new ClientBuffer;
        this.messageLength =  0;
        this.pid = undefined;

        this.connection.on('data', this._onData.bind(this));
        this.connection.on('end', () => {
            // console.log("connection ended", id);
            this.emit('end');
        });
        this.connection.on('error', err => {
            // console.log("connection error", id, err);
            this.emit('error', err);
        });
    }

    send(message)
    {
        if (this.debug)
            console.log("Compile::send", message);

        try {
            if (typeof message === 'number') {
                this.connection.write(Buffer.from([message]));
            } else {
                let msg = Buffer.from(JSON.stringify(message), "utf8");
                let header = Buffer.allocUnsafe(5);
                header.writeUInt8(Constants.JSONResponse, 0);
                header.writeUInt32BE(msg.length, 1);
                if (this.debug) {
                    console.log("Compile::send header", header, Constants.JSONResponse);
                }
                this.connection.write(header);
                this.connection.write(msg);
            }
        } catch (err) {
            console.error("Got error sending message", err);
        }
    }

    _onData(data)
    {

        // console.log("got data", data.length);
        this.buffer.write(data);
        let available = this.buffer.available;
        if (this.debug)
            console.log("Compile::_onData", "id", this.id, "pid", this.pid,
                        data, "available", available, this.messageLength);

        if (!this.pid) {
            if (available < 4)
                return;

            let pidBuffer = this.buffer.read(4);
            available -= 4;
            this.pid = pidBuffer.readUInt32BE();
            if (this.debug)
                console.log("Compile::_onData got pid", "id", this.id, "pid", this.pid);
        }

        let emit = type => {
            if (this.debug)
                console.log("Compile::_onData::emit", type, available);

            let read = this.buffer.read(1);
            if (this.debug) {
                console.log("Discarded", read);
            }
            --available;
            this.emit(type);
        };

        while (available) {
            if (!this.messageLength) {
                if (this.debug)
                    console.log("peeking", this.buffer.peek());

                switch (this.buffer.peek()) {
                case Constants.AcquireCppSlot:
                    emit('acquireCppSlot');
                    continue;
                case Constants.AcquireCompileSlot:
                    emit('acquireCompileSlot');
                    continue;
                case Constants.ReleaseCppSlot:
                    emit('releaseCppSlot');
                    continue;
                case Constants.ReleaseCompileSlot:
                    emit('releaseCompileSlot');
                    continue;
                case Constants.JSON:
                    if (available < 5)
                        break;
                    this.buffer.read(1);
                    this.messageLength = this.buffer.read(4).readUInt32BE();
                    available -= 5;
                    break;
                default:
                    console.error("Bad data", this.buffer.peek(), "available", available);
                    throw new Error("Got unexpected type " + this.buffer.peek());
                }
            }

            if (!this.messageLength || this.messageLength > available) {
                // console.log("Still waiting on data", this.messageLength, this.buffer.available);
                break;
            }

            let raw = this.buffer.read(this.messageLength);
            available -= this.messageLength;
            this.messageLength = 0;

            try {
                let msg = JSON.parse(raw.toString('utf8'));
                if (this.debug)
                    console.log("Got json message", msg);
                // console.log("Got message", msg);
                this.emit(msg.type, msg);
            } catch (err) {
                console.error("Bad JSON received", err);
                this.connection.destroy();
                break;
            }
        }
    }
}

module.exports = Compile;
