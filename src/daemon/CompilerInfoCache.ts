import { createHash } from "crypto";
import { execFile } from "child_process";
import { promises as fsPromises } from "fs";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

export type CompilerType = "clang" | "gcc" | "unknown";

export interface CompilerVersion {
    major: number;
    minor: number;
    patch: number;
}

export interface CompilerInfo {
    hash: string;
    input: string;
    type: CompilerType;
    version: CompilerVersion;
}

// Prefixes removed from a compiler's `-v` output before hashing / parsing.
// Must match filter() in src/client/Client.cpp (lines 234-257).
const FILTER_PREFIXES: readonly string[] = [
    "COLLECT_",
    "InstalledDir: ",
    "Found candidate GCC installation: ",
    "Selected GCC installation: "
];

// Remove any line that starts with one of the filter prefixes.
// Equivalent to the C++ filter() loop that removes needle from line-starts only.
function filterOutput(output: string): string {
    let result = output;
    for (const needle of FILTER_PREFIXES) {
        const lines = result.split("\n");
        const kept: string[] = [];
        for (const line of lines) {
            if (!line.startsWith(needle)) {
                kept.push(line);
            }
        }
        result = kept.join("\n");
    }
    return result;
}

// Emulate sscanf cascade "%d.%d.%d" -> "%d.%d" -> "%d".
function parseVersion(suffix: string): CompilerVersion {
    const three = /^(\d+)\.(\d+)\.(\d+)/.exec(suffix);
    if (three) {
        return {
            major: parseInt(three[1], 10),
            minor: parseInt(three[2], 10),
            patch: parseInt(three[3], 10)
        };
    }
    const two = /^(\d+)\.(\d+)/.exec(suffix);
    if (two) {
        return { major: parseInt(two[1], 10), minor: parseInt(two[2], 10), patch: 0 };
    }
    const one = /^(\d+)/.exec(suffix);
    if (one) {
        return { major: parseInt(one[1], 10), minor: 0, patch: 0 };
    }
    return { major: 0, minor: 0, patch: 0 };
}

// Byte-for-byte port of createCompilerInfo() in src/client/Client.cpp (lines 290-341).
export function createCompilerInfo(exec: string, versionInfo: string): CompilerInfo {
    let type: CompilerType = "unknown";
    let input = "";
    let version: CompilerVersion = { major: 0, minor: 0, patch: 0 };
    let foundVersion = false;

    const lines = versionInfo.split("\n");
    for (const line of lines) {
        if (line.startsWith("gcc version ")) {
            type = "gcc";
            const suffix = line.substring(12);
            input += suffix;
            version = parseVersion(suffix);
            foundVersion = true;
        } else if (line.startsWith("clang version ")) {
            type = "clang";
            const suffix = line.substring(14);
            input += suffix;
            version = parseVersion(suffix);
            foundVersion = true;
        } else if (line.startsWith("Target: ")) {
            const suffix = line.substring(8);
            input += suffix;
        }
    }

    if (!foundVersion) {
        const lower = exec.toLowerCase();
        if (lower.indexOf("clang") !== -1) {
            type = "clang";
        } else if (lower.indexOf("gcc") !== -1) {
            type = "gcc";
        }
    }

    const hash = createHash("sha1").update(input).digest("hex").toUpperCase();
    return { hash, input, type, version };
}

export class CompilerInfoCache {
    private readonly cache: Map<string, CompilerInfo> = new Map<string, CompilerInfo>();
    private readonly pending: Map<string, Promise<CompilerInfo>> = new Map<string, Promise<CompilerInfo>>();

    async get(compilerPath: string): Promise<CompilerInfo> {
        if (typeof compilerPath !== "string" || compilerPath.length === 0) {
            throw new Error("CompilerInfoCache.get: compilerPath must be a non-empty string");
        }
        const absPath = path.resolve(compilerPath);
        const stat = await fsPromises.stat(absPath);
        const key = `${absPath}:${stat.mtimeMs}`;

        const cached = this.cache.get(key);
        if (cached) {
            return cached;
        }

        const inflight = this.pending.get(key);
        if (inflight) {
            return inflight;
        }

        const compute = CompilerInfoCache.compute(absPath).then((info) => {
            this.cache.set(key, info);
            return info;
        });
        this.pending.set(key, compute);

        // Clean up the pending map on both success and failure so a failed
        // lookup doesn't wedge the key forever. We attach a no-op catch on
        // the cleanup chain because the original rejection is already
        // surfaced through the returned `compute` promise.
        compute
            .finally(() => {
                this.pending.delete(key);
            })
            .catch(() => {
                /* rejection observed by caller via the returned `compute` */
            });

        return compute;
    }

    private static async compute(absPath: string): Promise<CompilerInfo> {
        const { stdout, stderr } = await execFileAsync(absPath, ["-v"], {
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024
        });
        const combined = `${stdout}${stderr}`;
        const filtered = filterOutput(combined);
        return createCompilerInfo(absPath, filtered);
    }
}
