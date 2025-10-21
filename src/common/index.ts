import fs from "fs-extra";
import os from "os";
import path from "path";
import type { Options } from "@jhanssen/options";

const Version = 6;

function cacheDir(option: Options): string {
    let dir = option("cache-dir");
    if (!dir) {
        dir = path.join(os.homedir(), ".cache", "fisk", path.basename(option.prefix || ""));
    }
    return dir as string;
}

function validateCache(option: Options): void {
    const dir = cacheDir(option);
    const file = path.join(dir, "version");
    // console.log(dir);
    let version;
    try {
        version = fs.readFileSync(file);
        if (version.readUInt32BE() === Version) {
            return;
        }
    } catch (err) {
        /* */
    }
    if (version) {
        console.log(`Wrong version. Destroying cache ${dir}`);
    }
    fs.removeSync(dir);
    fs.mkdirpSync(dir);
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(Version);
    fs.writeFileSync(file, buf);
}

export interface Common {
    cacheDir: () => string;
    Version: number;
}

export function common(option: Options): Common {
    validateCache(option);
    return {
        cacheDir: cacheDir.bind(undefined, option),
        Version
    };
}
