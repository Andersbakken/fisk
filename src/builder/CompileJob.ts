import EventEmitter from "events";
import fs from "fs-extra";
import path from "path";
import type { VM } from "./VM";
import type { VMCompileFinished } from "./VMMessage";

export class CompileJob extends EventEmitter {
    // Creating the directory and opening the file used to be synchronous work
    // in the constructor, and feed() then wrote the whole preprocessed source
    // -- routinely megabytes -- with writeSync. All of it landed on the event
    // loop at the start of every job. The upload always arrives as a single
    // message, so feed() is only ever called once and can simply wait for this.
    private readonly opened: Promise<number>;

    dir: string;
    vmDir: string;
    sourceFileName: string;
    cppSize: number;
    startCompile?: number;

    constructor(
        readonly commandLine: string[],
        readonly argv0: string,
        readonly id: number,
        readonly vm: VM,
        readonly sourcePath?: string,
        readonly clientCwd?: string
    ) {
        super();
        this.dir = path.join(vm.root, "compiles", String(this.id));
        this.vmDir = path.join("/", "compiles", String(this.id));
        this.sourceFileName = sourcePath ? path.basename(sourcePath) : "sourcefile";
        this.cppSize = 0;
        this.startCompile = undefined;
        this.opened = fs.mkdirp(this.dir).then(() => fs.open(path.join(this.dir, this.sourceFileName), "w"));
        // Nothing awaits this until feed(), and an unhandled rejection in the
        // meantime would take the builder down.
        this.opened.catch(() => {
            /* reported by feed */
        });
    }

    sendCallback(error?: Error | null): void {
        if (error) {
            console.error("Got send error for", this.vmDir, this.id, this.commandLine);
            this.fail(error);
        }
    }

    feed(data: Buffer): void {
        this.opened
            .then(async (fd: number) => {
                await fs.write(fd, data);
                this.cppSize += data.length;
                this.startCompile = Date.now();
                await fs.close(fd);
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
            })
            .catch((err: unknown) => {
                console.error("Failed to write source file for", this.vmDir, this.id, err);
                this.fail(err as Error);
            });
    }

    cancel(): void {
        this.vm.child.send({ type: "cancel", id: this.id }, this.sendCallback.bind(this));
    }

    private fail(error: Error): void {
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
