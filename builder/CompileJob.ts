import { VM } from "./VM";
import { VMCompileFinished } from "./VMMessage";
import EventEmitter from "events";
import assert from "assert";
import fs from "fs-extra";
import path from "path";

export class CompileJob extends EventEmitter {
    vm: VM;
    commandLine: string[];
    id: number;
    argv0: string;
    dir: string;
    vmDir: string;
    cppSize: number;
    startCompile?: number;
    fd?: number;

    constructor(commandLine: string[], argv0: string, id: number, vm: VM) {
        super();
        this.vm = vm;
        this.commandLine = commandLine;
        this.argv0 = argv0;
        this.id = id;
        this.dir = path.join(vm.root, "compiles", String(this.id));
        this.vmDir = path.join("/", "compiles", String(this.id));
        fs.mkdirpSync(this.dir);
        this.fd = fs.openSync(path.join(this.dir, "sourcefile"), "w");
        this.cppSize = 0;
        this.startCompile = undefined;
    }

    sendCallback(error?: Error | null): void {
        if (error) {
            console.error("Got send error for", this.vmDir, this.id, this.commandLine);
            const compileFinished: VMCompileFinished = {
                type: "compileFinished",
                success: false,
                id: this.id,
                files: [],
                exitCode: -1,
                sourceFile: "",
                error: error.toString()
            };
            this.vm.compileFinished(compileFinished);
        }
    }

    feed(data: Buffer): void {
        assert(this.fd !== undefined, "Must have fd");
        fs.writeSync(this.fd, data);
        this.cppSize += data.length;
        this.startCompile = Date.now();
        fs.close(this.fd);
        this.fd = undefined;
        this.vm.child.send(
            { type: "compile", commandLine: this.commandLine, argv0: this.argv0, id: this.id, dir: this.vmDir },
            this.sendCallback.bind(this)
        );
    }

    cancel(): void {
        this.vm.child.send({ type: "cancel", id: this.id }, this.sendCallback.bind(this));
    }
}
