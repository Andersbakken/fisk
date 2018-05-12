const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const Version = 2;

function cacheDir(option)
{
    var dir = option("cache_dir");
    if (!dir) {
        dir = path.join(os.homedir(), ".cache", "fisk", path.basename(option.prefix));
    }
    return dir;
}

function validateCache(option)
{
    const dir = cacheDir(option);
    const file = path.join(dir, 'version');
    console.log(dir);
    try {
        var version = fs.readFileSync(file);
        if (version.readUInt32BE() == Version) {
            return;
        }
    } catch (err) {
    }
    fs.remove(dir);
    fs.mkdirpSync(dir);
    var buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(Version);
    fs.writeFileSync(file, buf);
}


module.exports = function(option) {
    validateCache(option);
    return {
        cacheDir: cacheDir.bind(this, option)
    };
};
