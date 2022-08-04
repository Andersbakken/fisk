import { Option } from "@jhanssen/options";
import fs from "fs-extra";
import os from "os";
import path from "path";

const Version = 5;

type Opts = (key: string, defaultValue?: Option) => Option;

function cacheDir(option: Opts): string {
    let dir = option("cache-dir");
    if (!dir) {
        // @ts-ignore
        dir = path.join(os.homedir(), ".cache", "fisk", path.basename(option.prefix));
    }
    return String(dir);
}

function validateCache(option: Opts) {
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

export type Common = { cacheDir: () => string; Version: number };

export default function (option: Opts): Common {
    validateCache(option);
    return {
        cacheDir: cacheDir.bind(undefined, option),
        Version
    };
}
