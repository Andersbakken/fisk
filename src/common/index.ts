import fs from "fs-extra";
import os from "os";
import path from "path";
import type { Options } from "@jhanssen/options";

const Version = 5;
// 6: objects now carry the client's real source path and compilation dir,
// baked in at compile time instead of the builder's /compiles paths, and the
// stored response no longer keeps the paths the client used to patch with.
const ObjectCacheFormatVersion = 6;

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

function validateObjectCache(option: Options): void {
    const dir = cacheDir(option);
    const objectCacheDir = option.string("object-cache-dir") || path.join(dir, "objectcache");
    const file = path.join(objectCacheDir, "version");
    let version;
    try {
        version = fs.readFileSync(file);
        if (version.readUInt32BE() === ObjectCacheFormatVersion) {
            return;
        }
    } catch (err) {
        /* */
    }
    if (version) {
        console.log(`Wrong object cache version. Destroying object cache ${objectCacheDir}`);
    }
    fs.removeSync(objectCacheDir);
    fs.mkdirpSync(objectCacheDir);
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(ObjectCacheFormatVersion);
    fs.writeFileSync(file, buf);
}

export interface Common {
    cacheDir: () => string;
    Version: number;
    ObjectCacheFormatVersion: number;
}

// Only the builder keeps an object cache on disk. The scheduler tracks which
// builder holds which sha1 in memory, and the daemon uses cacheDir purely for
// the default socket path -- validating an object cache for either created a
// directory they never read and, on a format bump, tried to destroy one they do
// not necessarily own.
export function common(option: Options, hasObjectCache: boolean = false): Common {
    validateCache(option);
    if (hasObjectCache) {
        validateObjectCache(option);
    }
    return {
        cacheDir: cacheDir.bind(undefined, option),
        Version,
        ObjectCacheFormatVersion
    };
}
