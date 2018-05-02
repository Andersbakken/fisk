const child_process = require('child_process');
const EventEmitter = require('events');

let id = 1;
let children = {};


class Child extends EventEmitter {
    constructor(params) {
        if (!params.script)
            throw new Error("Missing script");
        this.id = id++;
        this.script = params.script;
        this.user = params.user;
        this.chroot = params.chroot;
        this.child = child_process.fork(`__dirname/service_fork_helper.js`);
        this.child.send({script: this.script, user: this.user, chroot: this.chroot, id: this.id });
        this.child.on('message', msg => { this.emit('message', msg); });
        this.child.on('exit', event => { this.emit('exit', event); });
    }

    send(msg) {
        this.process.send(msg);
    }
}

let peerId = 1;
class Peer extends EventEmitter {
    constructor(params) {
        if (!params.script)
            throw new Error("Missing script");
        this.peerId = peerId++;
        process.send({ type: "launchPeer", pid: process.pid, peerId: this.peerId, script: params.script, user: params.user, chroot: params.chroot });
        process.on('message', msg => {
            if (msg.type == "message") {

            }
        });
    }

    send(msg) {
        let m = { type: "peerMessage", pid: process.pid, peerId: this.peerId, message: msg };
        process.send(m);
    }
}


class Peer extends EventEmitter {
    constructor(remoteId) {
        this.remoteId = remoteId;
    }
}

let launchId = 1;
class Parent extends EventEmitter {
    // constructor() {
    //     process.on('message
    // }

    launch(params, cb) {
        process.send({ type: 'launch', params: params, launchId: launchId++ });
    }
}


module.exports = { Child, Parent: new Parent() };
