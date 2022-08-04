import { CompileJob } from "./compilejob";
import { options } from "@jhanssen/options";
import { quitOnError } from "./quit-on-error";
import EventEmitter from "events";
import child_process from "child_process";
import fs from "fs-extra";
import path from "path";

class VM extends EventEmitter {
    private root: string;
    private hash: string;
    private compiles: Record<number, CompileJob>;
    private destroying: boolean;
    private keepCompiles: boolean;
    private child: child_process.ChildProcess;

    constructor(root: string, hash: string, option: typeof options) {
        super();
        quitOnError(option);
        this.root = root;
        this.hash = hash;
        this.compiles = {};
        this.destroying = false;
        this.keepCompiles = Boolean(option("keep-compiles"));

        fs.remove(path.join(root, "compiles"));

        const args = [`--root=${root}`, `--hash=${hash}`];
        const user = option("vm-user");
        if (user) {
            args.push(`--user=${user}`);
        }
        if (option("debug")) {
            args.push("--debug");
        }

        this.child = child_process.fork(path.join(__dirname, "VM_runtime.js"), args);
        let gotReady = false;
        this.child.on("message", (msg: unknown) => {
            // console.log("Got message", msg);
            switch (msg.type) {
                case "ready":
                    gotReady = true;
                    this.emit("ready", { success: true });
                    break;
                case "error":
                    console.error("Got error from runtime", this.hash, msg.message);
                    break;
                case "compileStdOut": {
                    const compile = this.compiles[msg.id];
                    if (compile) {
                        compile.emit("stdout", msg.data);
                    }
                    break;
                }
                case "compileStdErr": {
                    const compile = this.compiles[msg.id];
                    if (compile) {
                        compile.emit("stderr", msg.data);
                    }
                    break;
                }
                case "compileFinished":
                    this.compileFinished(msg);
                    break;
            }
        });
        this.child.on("error", (err) => {
            if (!gotReady) {
                this.emit("ready", { success: false, error: err });
            } else {
                console.error("Got error", err);
            }
        });
        this.child.on("exit", (evt) => {
            console.log("Child going down", evt, this.destroying);
            if (this.destroying) {
                fs.remove(root);
            }
            // ### need to handle the helper accidentally going down maybe?
            this.emit("exit");
        });
    }

    compileFinished(msg: unknown): void {
        const compile = this.compiles[msg.id];
        if (!compile) {
            return;
        }
        if (msg.error) {
            console.error("Got some error", msg.error);
        }
        const now = Date.now();
        compile.emit("finished", {
            cppSize: compile.cppSize,
            compileDuration: now - compile.startCompile,
            exitCode: msg.exitCode,
            success: msg.success,
            error: msg.error,
            sourceFile: msg.sourceFile,
            files: msg.files.map((file) => {
                file.absolute = path.join(this.root, file.mapped ? file.mapped : file.path);
                delete file.mapped;
                return file;
            })
        });

        if (!this.keepCompiles) {
            fs.remove(this.compiles[msg.id].dir);
        }
        delete this.compiles[msg.id];
    }

    destroy(): void {
        this.destroying = true;
        this.child.send({ type: "destroy" }, (err) => {
            if (err) {
                console.error("Failed to send destroy message to child", this.hash, err);
                this.child.kill();
            }
        });
    }

    startCompile(commandLine: string, argv0: string, id: number):void {
        const compile = new CompileJob(commandLine, argv0, id, this);
        this.compiles[compile.id] = compile;
        // console.log("startCompile " + compile.id);
        return compile;
    }

    setDebug(debug: boolean): void {
        this.child.send({ type: "setDebug", debug: debug });
    }
}

export { VM };

