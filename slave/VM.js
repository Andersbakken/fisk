const EventEmitter = require('events');
const child_process = require('child_process');
const fs = require('fs-extra');
const path = require('path');

class CompileJob extends EventEmitter
{
    constructor(commandLine, argv0, id, vm) {
        super();
        this.vm = vm;
        this.commandLine = commandLine;
        this.argv0 = argv0;
        this.id = id;
        this.dir = path.join(vm.root, 'compiles', "" + this.id);
        this.vmDir = path.join('/', 'compiles', "" + this.id);
        fs.mkdirpSync(this.dir);
        this.fd = fs.openSync(path.join(this.dir, 'sourcefile'), "w");
        this.cppSize = 0;
        this.startCompile = undefined;
    }

    sendCallback(error) {
        if (error) {
            console.error("Got send error for", this.vmDir, this.id, this.commandLine);
            this.vm.compileFinished({type: 'compileFinished', success: false, id: this.id, files: [], exitCode: -1, error: error.toString() });
        }
    }

    feed(data, last) {
        fs.writeSync(this.fd, data);
        this.cppSize += data.length;
        if (last) {
            this.startCompile = Date.now();
            fs.close(this.fd);
            this.fd = undefined;
            this.vm.child.send({ type: "compile", commandLine: this.commandLine, argv0: this.argv0, id: this.id, dir: this.vmDir}, this.sendCallback);
        }
    }

    cancel() {
        this.vm.child.send({ type: "cancel", id: this.id}, this.sendCallback);
    }
};

class VM extends EventEmitter
{
    constructor(root, hash, options) {
        super();
        this.root = root;
        this.hash = hash;
        this.compiles = {};
        this.destroying = false;
        this.keepCompiles = options.keepCompiles || false;

        fs.remove(path.join(root, 'compiles'));

        let args = [ `--root=${root}`, `--hash=${hash}` ];
        if (options.user)
            args.push(`--user=${options.user}`);
        if (options.debug)
            args.push("--debug");

        this.child = child_process.fork(path.join(__dirname, "VM_runtime.js"), args);
        let gotReady = false;
        this.child.on('message', msg => {
            // console.log("GOT MESSAGE", msg);
            switch (msg.type) {
            case 'ready':
                gotReady = true;
                this.emit('ready', { success: true });
                break;
            case 'error':
                console.error("Got error from runtime", this.hash, msg.message);
                break;
            case 'compileStdOut': {
                let compile = this.compiles[msg.id];
                if (compile)
                    compile.emit('stdout', msg.data);
                break; }
            case 'compileStdErr': {
                let compile = this.compiles[msg.id];
                if (compile)
                    compile.emit('stderr', msg.data);
                break; }
            case 'compileFinished':
                this.compileFinished(msg);
                break;
            }
        });
        this.child.on('error', err => {
            if (!gotReady) {
                this.emit('ready', { success: false, error: err });
            } else {
                console.error("Got error", err);
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

    compileFinished(msg) {
        let compile = this.compiles[msg.id];
        if (!compile)
            return;
        if (msg.error)
            console.error("Got some error", msg.error);
        const now = Date.now();
        compile.emit('finished', {
            cppSize: compile.cppSize,
            compileDuration: (now - compile.startCompile),
            exitCode: msg.exitCode,
            success: msg.success,
            error: msg.error,
            sourceFile: msg.sourceFile,
            files: msg.files.map(file => {
                file.absolute = path.join(this.root, file.mapped ? file.mapped : file.path);
                delete file.mapped;
                return file;
            })
        });

        if (!this.keepCompiles)
            fs.remove(this.compiles[msg.id].dir);
        delete this.compiles[msg.id];
    }

    destroy() {
        this.destroying = true;
        this.child.send({type: 'destroy'}, err => {
            if (err) {
                console.error("Failed to send destroy message to child", this.hash, err);
                this.child.kill();
            }
        });
    }

    startCompile(commandLine, argv0, id) {
        let compile = new CompileJob(commandLine, argv0, id, this);
        this.compiles[compile.id] = compile;
        // console.log("startCompile " + compile.id);
        return compile;
    }
};

module.exports = VM;
