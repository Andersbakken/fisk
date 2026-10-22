export interface CompileInit {
    args: string[];
    argv0: string;
    dir: string;
    debug: boolean;
    sourceFileName: string;
    compilerType: "clang" | "gcc";

    // The client's real paths, which we bake into the object rather than emitting
    // our own /compiles paths for the client to rewrite. That is the only approach
    // that works for LTO, where the output is bitcode no ELF patcher can touch.
    // Absent for a client too old to send them, in which case nothing is baked.
    clientSourcePath: string;
    clientCwd: string;
}
