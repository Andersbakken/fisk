import { VM } from "./VM";
import EventEmitter from "events";

class CompileJob extends EventEmitter {
    private vm: VM;
    private commandLine: string;
    private argv0: string;
    private id: number;
    private dir: string;
    private vmDir: string;
    private cppSize: number;
    private fd: number;
    private startCompile?: number;

    constructor(commandLine: string, argv0: string, id: number, vm: VM) {
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

    sendCallback(error?: Error): void {
        if (error) {
            console.error("Got send error for", this.vmDir, this.id, this.commandLine);
            this.vm.compileFinished({
                type: "compileFinished",
                success: false,
                id: this.id,
                files: [],
                exitCode: -1,
                error: error.toString()
            });
        }
    }

    feed(data: Buffer, last: boolean): void {
        fs.writeSync(this.fd, data);
        this.cppSize += data.length;
        if (last) {
            this.startCompile = Date.now();
            fs.close(this.fd);
            this.fd = undefined;
            this.vm.child.send(
                { type: "compile", commandLine: this.commandLine, argv0: this.argv0, id: this.id, dir: this.vmDir },
                this.sendCallback.bind(this)
            );
        }
    }

    cancel(): void {
        this.vm.child.send({ type: "cancel", id: this.id }, this.sendCallback.bind(this));
    }
}

export { CompileJob };
