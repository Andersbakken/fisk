import EventEmitter from "events";
import assert from "assert";
import fs from "fs-extra";
import path from "path";
import type { VM } from "./VM";
import type { VMCompileFinished } from "./VMMessage";

export class CompileJob extends EventEmitter {
    dir: string;
    vmDir: string;
    sourceFileName: string;
    cppSize: number;
    startCompile?: number;
    fd?: number;

    constructor(readonly commandLine: string[], readonly argv0: string, readonly id: number, readonly vm: VM, readonly sourcePath?: string, readonly clientCwd?: string) {
        super();
        this.dir = path.join(vm.root, "compiles", String(this.id));
        this.vmDir = path.join("/", "compiles", String(this.id));
        this.sourceFileName = sourcePath ? path.basename(sourcePath) : "sourcefile";
        fs.mkdirpSync(this.dir);
        this.fd = fs.openSync(path.join(this.dir, this.sourceFileName), "w");
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
                sourcePath: "",
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
        fs.closeSync(this.fd);
        this.fd = undefined;
        this.vm.child.send(
            {
                type: "compile",
                commandLine: this.commandLine,
                argv0: this.argv0,
                id: this.id,
                dir: this.vmDir,
                sourceFileName: this.sourceFileName,
                clientSourcePath: this.sourcePath,
                clientCwd: this.clientCwd
            },
            this.sendCallback.bind(this)
        );
    }

    cancel(): void {
        this.vm.child.send({ type: "cancel", id: this.id }, this.sendCallback.bind(this));
    }
}
