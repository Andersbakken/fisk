import { CompileFinished, CompileFinishedFile } from "./CompileFinished";
import { CompileFinishedEvent } from "./CompileFinishedEvent";
import { CompileJob } from "./CompileJob";
import { OptionsFunction } from "@jhanssen/options";
import EventEmitter from "events";
import child_process from "child_process";
import fs from "fs-extra";
import path from "path";

export class VM extends EventEmitter {
    root: string;
    hash: string;
    option: OptionsFunction;
    compiles: Record<number, CompileJob>;
    keepCompiles: boolean;
    destroying: boolean;
    child: child_process.ChildProcess;
    ready: boolean;

    constructor(root: string, hash: string, option: OptionsFunction) {
        super();
        this.root = root;
        this.hash = hash;
        this.compiles = {};
        this.destroying = false;
        this.keepCompiles = Boolean(option("keep-compiles"));
        this.option = option;

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
        this.ready = false;
        this.child.on("message", (msg) => {
            // console.log("Got message", msg);
            switch (msg.type) {
                case "ready":
                    this.ready = true;
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
            if (!this.ready) {
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

    compileFinished(msg: CompileFinished): void {
        const compile = this.compiles[msg.id];
        if (!compile) {
            return;
        }
        if (msg.error) {
            console.error("Got some error", msg.error);
        }
        const now = Date.now();
        const finishedEvent: CompileFinishedEvent = {
            cppSize: compile.cppSize,
            compileDuration: now - (compile.startCompile || 0),
            exitCode: msg.exitCode,
            success: msg.success,
            error: msg.error,
            sourceFile: msg.sourceFile,
            files: msg.files.map((file: CompileFinishedFile) => {
                return {
                    path: file.path,
                    absolute: path.join(this.root, file.mapped ? file.mapped : file.path)
                }
            })
        };

        compile.emit("finished", finishedEvent);

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

    startCompile(commandLine: string[], argv0: string, id: number): CompileJob {
        const compile = new CompileJob(commandLine, argv0, id, this);
        this.compiles[compile.id] = compile;
        // console.log("startCompile " + compile.id);
        return compile;
    }

    setDebug(debug: boolean): void {
        this.child.send({ type: "setDebug", debug });
    }
}


