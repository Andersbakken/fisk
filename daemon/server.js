const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs-extra');
const ClientBuffer = require('./clientbuffer');
const Compile = require('./compile');

class Server extends EventEmitter
{
    constructor(option, common)
    {
        super();
        this.debug = option("debug");
        this.file = option("socket", path.join(common.cacheDir(option), "socket"));
        this.server = undefined;
        this.option = option;
        this._connections = {};
        this._connectionId = 0;
    }

    close()
    {
        if (this.debug)
            console.log("Server::close");
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
                fs.chmodSync(this.file, '777');
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
        let compile = new Compile(conn, ++this._connectionId, this.option);
        if (this.debug)
            console.log("Server::_onConnection", compile.id);
        if (this._connectionId == Math.pow(2, 31) - 1)
            this._connectionId = 0;
        this._connections[compile.id] = conn;
        compile.on('end', () => {
            if (this.debug)
                console.log("Compile::end");

            delete this._connections[compile.id];
        });
        this.emit('compile', compile);
    }
}

module.exports = Server;
