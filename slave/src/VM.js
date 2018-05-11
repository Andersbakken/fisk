const EventEmitter = require('events');
const child_process = require('child_process');
const option = require("@jhanssen/options")("fisk-slave");
const fs = require('fs-extra');
const path = require('path');

let id = 0;
class CompileJob extends EventEmitter
{
    constructor(commandLine, argv0, vm) {
        super();
        this.vm = vm;
        this.commandLine = commandLine;
        this.argv0 = argv0;
        this.id = ++id;
        console.log("shait", commandLine, argv0, vm.root);
        this.dir = path.join(vm.root, 'compiles', "" + this.id);
        fs.mkdirpSync(this.dir);
        this.fd = fs.openSync(path.join(this.dir, 'sourcefile'), "w");
    }

    feed(data, last) {
        fs.writeSync(this.fd, data);
        if (last) {
            fs.close(this.fd);
            this.fd = undefined;
            this.vm.child.send({ type: "compile", commandLine: this.commandLine, argv0: this.argv0, id: this.id, dir: this.dir });
        }
    }
};

class VM
{
    constructor(root, hash) {
        this.root = root;
        this.hash = hash;
        this.compiles = {};

        fs.remove(path.join(root, 'compiles'));

        let args = [ `--root=${root}`, `--hash=${hash}` ];
        let user = option("vm_user");
        if (user)
            args.push(`--user=${user}`);
        this.child = child_process.fork(path.join(__dirname, "VM_runtime.js"), args);
        this.child.on('message', (msg) => {
            switch (msg.type) {
            case 'compileStdOut':
                this.compiles[msg.id].emit('stdout', msg.data);
                break;
            case 'compileStdErr':
                this.compiles[msg.id].emit('stderr', msg.data);
                break;
            case 'compileFinished':
                this.compiles[msg.id].emit('finished', {
                    exitCode: msg.exitCode,
                    files: msg.files.map(file => {
                        file.absolute = path.join(this.dir, file.mapped ? file.mapped : file.path);
                        delete file.mapped;
                        return file;
                    })
                });

                fs.remove(this.compiles[msg.id].dir);
                delete this.compiles[msg.id];
                break;
            }
        });
        this.child.on('exit', evt => {
            console.log("Child going down", evt);
            // ### need to handle the helper accidentally going down maybe?
        });
    }

    stop() {
        this.send({type: 'stop'});
    }

    startCompile(commandLine, argv0) {
        let compile = new CompileJob(commandLine, argv0, this);
        this.compiles[compile.id] = compile;
        return compile;
    }
};

module.exports = VM;
