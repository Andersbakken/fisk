const EventEmitter = require('events');
const ClientBuffer = require('./clientbuffer');

class Compile extends EventEmitter
{
    constructor(conn, id)
    {
        super();
        this.id = id;
        this.connection = conn;
        this.buffer = new ClientBuffer;
        this.messageLength =  0;

        this.connection.on('data', this._onData.bind(this));
        this.connection.on('end', () => {
            // console.log("connection ended", id);
            this.emit('end');
        });
    }

    send(message)
    {
        try {
            let msg = Buffer.from(JSON.stringify(message), "utf8");
            let header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(msg.length);
            this.connection.write(header);
            this.connection.write(msg);
        } catch (err) {
            console.error("Got error sending message", err);
        }
    }

    _onData(data)
    {
        // console.log("got data", data.length);
        this.buffer.write(data);
        while (true) {
            if (!this.messageLength) {
                if (this.buffer.available < 4)
                    break;
                this.messageLength = this.buffer.read(4).readUInt32BE();
            }

            if (this.messageLength > this.buffer.available) {
                // console.log("Still waiting on data", this.messageLength, this.buffer.available);
                break;
            }

            let raw = this.buffer.read(this.messageLength);
            this.messageLength = 0;

            try {
                let msg = JSON.parse(raw.toString('utf8'));
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
