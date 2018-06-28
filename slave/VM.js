const EventEmitter = require('events');
const child_process = require('child_process');
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
        this.dir = path.join(vm.root, 'compiles', "" + this.id);
        this.vmDir = path.join('/', 'compiles', "" + this.id);
        fs.mkdirpSync(this.dir);
        this.fd = fs.openSync(path.join(this.dir, 'sourcefile'), "w");
        this.cppSize = 0;
        this.startCompile = undefined;
    }


    feed(data, last) {
        fs.writeSync(this.fd, data);
        this.cppSize += data.length;
        if (last) {
            this.startCompile = Date.now();
            fs.close(this.fd);
            this.fd = undefined;
            this.vm.child.send({ type: "compile", commandLine: this.commandLine, argv0: this.argv0, id: this.id, dir: this.vmDir});
        }
    }

    cancel() {
        this.vm.child.send({ type: "cancel", id: this.id});
    }
};

class VM extends EventEmitter
{
    constructor(root, hash, user) {
        super();
        this.root = root;
        this.hash = hash;
        this.compiles = {};
        this.compileCount = 0;
        this.destroying = false;

        fs.remove(path.join(root, 'compiles'));

        let args = [ `--root=${root}`, `--hash=${hash}` ];
        if (user)
            args.push(`--user=${user}`);
        this.child = child_process.fork(path.join(__dirname, "VM_runtime.js"), args);
        this.child.on('message', (msg) => {
            let that;
            switch (msg.type) {
            case 'ready':
                this.emit('ready');
                break;
            case 'compileStdOut':
                that = this.compiles[msg.id];
                if (that)
                    that.emit('stdout', msg.data);
                break;
            case 'compileStdErr':
                that = this.compiles[msg.id];
                if (that)
                    that.emit('stderr', msg.data);
                break;
            case 'compileFinished':
                that = this.compiles[msg.id];
                if (!that)
                    return;
                const now = Date.now();
                that.emit('finished', {
                    cppSize: that.cppSize,
                    compileDuration: (now - that.startCompile),
                    exitCode: msg.exitCode,
                    sourceFile: msg.sourceFile,
                    files: msg.files.map(file => {
                        file.absolute = path.join(this.root, file.mapped ? file.mapped : file.path);
                        delete file.mapped;
                        return file;
                    })
                });

                fs.remove(this.compiles[msg.id].dir);
                delete this.compiles[msg.id];
                if (!--this.compileCount)
                    id = 0;
                break;
            }
        });
        this.child.on('exit', evt => {
            console.log("Child going down", evt, this.destroying);
            if (this.destroying)
                fs.remove(root);
            // ### need to handle the helper accidentally going down maybe?
            this.emit("exit");
        });
    }

    destroy() {
        this.destroying = true;
        this.child.send({type: 'destroy'});
    }

    startCompile(commandLine, argv0) {
        let compile = new CompileJob(commandLine, argv0, this);
        this.compiles[compile.id] = compile;
        ++this.compileCount;
        console.log("startCompile " + compile.id);
        return compile;
    }
};

module.exports = VM;
