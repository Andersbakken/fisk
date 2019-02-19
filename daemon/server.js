const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs-extra');

class ClientBuffer
{
    constructor()
    {
        this.buffers = [];
        this.offset = 0;
    }

    write(buffer)
    {
        this.buffers.push(buffer);
        console.log("write", buffer.length, this.buffers.length, this.available);
    }

    read(len)
    {
        if (!len)
            throw new Error("Don't be a tool");
        if (len > this.available)
            throw new Error("We don't have this many bytes available " + len + ">" + this.available);

        console.log("read", len, this.available);
        let ret;

        if (this.buffers[0].length - this.offset >= len) { // buffers[0] is enough
            let buf = this.buffers[0];
            if (buf.length - this.offset == len) {
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
            let buf = this.buffers[0];
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

    get available()
    {
        return this.buffers.reduce((total, buf) => total + buf.length, 0) - this.offset;
    }
};

class Server extends EventEmitter
{
    constructor(option, common)
    {
        super();
        this.file = option("socket", path.join(common.cacheDir(option), "socket"));
        this.server = undefined;
        this._connections = {};
        this._connectionId = 0;
    }

    close()
    {
        if (this.server)
            this.server.close();
        try {
            fs.unlinkSync(this.file);
        } catch (err) {
        }
    }

    listen()
    {
        try {
            fs.unlinkSync(this.file); // this should be more
                                      // complicated with attempts to
                                      // cleanly shut down and whatnot
        } catch (err) {
        }
        return new Promise((resolve, reject) => {
            let connected = false;
            this.server = net.createServer(this._onConnection.bind(this)).listen(this.file, () => {
                connected = true;
                resolve();
            });
            this.server.on('error', err => {
                if (!connected) {
                    console.error("Got server error", err);
                    setTimeout(this.listen.bind(this), 1000);
                }
            });

            this.server.on('close', () => {
                if (!connected) {
                    console.error("Got server error", err);
                    setTimeout(this.listen.bind(this), 1000);
                }
            });
        });
    }
    _onConnection(conn)
    {
        conn.connectionId = ++this._connectionId;
        this._connections[conn.connectionId] = conn;
        conn.on('end', () => {
            console.log("connection ended", conn.connectionId);
            delete this._connections[conn.connectionId];
        });

        let msgLength;
        let buffer = new ClientBuffer;

        conn.on('data', data => {
            buffer.write(data);
            while (true) {
                if (!msgLength) {
                    if (buffer.available < 4)
                        break;
                    msgLength = buffer.read(4).readUInt32BE();
                }

                if (msgLength > buffer.available) {
                    console.log("Still waiting on data", msgLength, buffer.available);
                    break;
                }

                let raw = buffer.read(msgLength);
                msgLength = 0;

                try {
                    let msg = JSON.parse(raw.toString('utf8'));
                    console.log("Got message", msg);
                    this.emit('message', msg);
                } catch (err) {
                    console.error("Bad JSON received", err);
                    conn.close();
                    break;
                }
            }
        });
    }
}

/*

function createServer(socket){
    console.log('Creating server.');
    var server = net.createServer(function(stream) {
        console.log('Connection acknowledged.');

        // Store all connections so we can terminate them if the server closes.
        // An object is better than an array for these.
        var self = Date.now();
        connections[self] = (stream);
        stream.on('end', function() {
            console.log('Client disconnected.');
            delete connections[self];
        });

        // Messages are buffers. use toString
        stream.on('data', function(msg) {
            msg = msg.toString();
            if(msg === '__snootbooped'){
                console.log("Client's snoot confirmed booped.");
                return;
            }

            console.log('Client:', msg);

            if(msg === 'foo'){
                stream.write('bar');
            }

            if(msg === 'baz'){
                stream.write('qux');
            }

            if(msg === 'here come dat boi'){
                stream.write('Kill yourself.');
            }

        });
    })
        .listen(socket)
        .on('connection', function(socket){
            console.log('Client connected.');
            console.log('Sending boop.');
            socket.write('__boop');
            //console.log(Object.keys(socket));
        })
    ;
    return server;
}

*/

module.exports = Server;
