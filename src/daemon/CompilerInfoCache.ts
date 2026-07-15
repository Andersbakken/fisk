import { createHash } from "crypto";
import { createReadStream, promises as fsPromises } from "fs";
import { execFile } from "child_process";
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

function getFileSha1(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha1");
        const stream = createReadStream(filePath);
        stream.on("data", (chunk: Buffer): void => {
            hash.update(chunk);
        });
        stream.on("end", (): void => {
            resolve(hash.digest("hex"));
        });
        stream.on("error", (err: Error): void => {
            reject(err);
        });
    });
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
export async function createCompilerInfo(exec: string, versionInfo: string): Promise<CompilerInfo> {
    let type: CompilerType = "unknown";
    let input = "";
    let version: CompilerVersion = { major: 0, minor: 0, patch: 0 };
    let foundVersion = false;

    const lines = versionInfo.split("\n");
    for (const line of lines) {
        const versionMatch = /(clang|gcc) version *?(\d+\.\d+\.\d+).*?/.exec(line);
        if (versionMatch) {
            switch (versionMatch[1]) {
                case "clang":
                    type = "clang";
                    break;
                case "gcc":
                    type = "gcc";
                    break;
            }
            version = parseVersion(versionMatch[2]);
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

    const hash = await getFileSha1(exec);
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
        return createCompilerInfo(absPath, combined);
    }
}
