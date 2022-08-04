const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const Version = 5;

function cacheDir(option)
{
    let dir = option("cache-dir");
    if (!dir) {
        dir = path.join(os.homedir(), ".cache", "fisk", path.basename(option.prefix));
    }
    return dir;
}

function validateCache(option)
{
    const dir = cacheDir(option);
    const file = path.join(dir, 'version');
    // console.log(dir);
    let version;
    try {
        version = fs.readFileSync(file);
        if (version.readUInt32BE() == Version) {
            return;
        }
    } catch (err) {
    }
    if (version)
        console.log(`Wrong version. Destroying cache ${dir}`);
    fs.removeSync(dir);
    fs.mkdirpSync(dir);
    let buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(Version);
    fs.writeFileSync(file, buf);
}


module.exports = function(option) {
    validateCache(option);
    return {
        cacheDir: cacheDir.bind(this, option),
        Version: Version
    };
};
