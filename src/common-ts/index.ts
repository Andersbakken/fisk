import { Option, OptionsFunction } from "@jhanssen/options";
import fs from "fs-extra";
import os from "os";
import path from "path";

const Version = 5;

function cacheDir(option: OptionsFunction): string {
    let dir = option("cache-dir");
    if (!dir) {
        dir = path.join(os.homedir(), ".cache", "fisk", path.basename(option.prefix || ""));
    }
    return dir as string;
}

function validateCache(option: OptionsFunction): void {
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

export type Common = {
    cacheDir: () => string;
    Version: number;
};

export function common(option: OptionsFunction): Common {
    validateCache(option);
    return {
        cacheDir: cacheDir.bind(undefined, option),
        Version
    };
}

export function stringOrUndefined(value: Option): string | undefined {
    return value === undefined ? undefined : String(value);
}
