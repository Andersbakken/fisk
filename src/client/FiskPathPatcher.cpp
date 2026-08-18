#include "FiskPathPatcher.h"
#include "Log.h"
#include <cstring>
#include <string>
#include <vector>

// Keep in sync with FISK_PAD_LENGTH / FISK_NAME_PAD / FISK_CDIR_PAD
// in src/builder/VM_runtime/Compile.ts. PATH_MAX, so any path the client can
// legally have fits in the padded region without truncation.
static constexpr size_t FISK_PAD_LENGTH = 4096;
static constexpr const char FISK_NAME_PREFIX[] = "/fisk-name";
static constexpr const char FISK_CDIR_PREFIX[] = "/fisk-cdir";
static constexpr char FISK_PAD_CHAR = '_';

static std::vector<uint8_t> makePad(const char *prefix)
{
    const size_t prefixLen = strlen(prefix);
    std::vector<uint8_t> pad(FISK_PAD_LENGTH);
    memcpy(pad.data(), prefix, prefixLen);
    memset(pad.data() + prefixLen, FISK_PAD_CHAR, FISK_PAD_LENGTH - prefixLen);
    return pad;
}

// Build the byte block that overwrites a pad: the path, then NUL fill. The
// trailing NULs terminate the string and blank the rest of the padded region.
// A path that does not fit would be silently corrupted, so refuse instead --
// a wrong path in a backtrace is worse than an unpatched one.
static bool makeReplacement(const std::string &path, const char *what, std::vector<uint8_t> &out)
{
    if (path.size() >= FISK_PAD_LENGTH) {
        ERROR("FiskPathPatcher: %s path is %zu bytes, does not fit in the %zu byte padded region, "
              "leaving it unpatched: %s",
              what, path.size(), FISK_PAD_LENGTH, path.c_str());
        return false;
    }
    out.assign(FISK_PAD_LENGTH, 0);
    memcpy(out.data(), path.data(), path.size());
    return true;
}

static size_t scanAndReplace(std::vector<uint8_t> &data,
                             const std::vector<uint8_t> &needle,
                             const std::vector<uint8_t> &replacement,
                             const char *label)
{
    size_t count = 0;
    const size_t len = needle.size();
    if (data.size() < len)
        return 0;

    for (size_t i = 0; i <= data.size() - len; ++i) {
        if (memcmp(data.data() + i, needle.data(), len) == 0) {
            memcpy(data.data() + i, replacement.data(), len);
            ++count;
            i += len - 1;
        }
    }
    if (count)
        DEBUG("FiskPathPatcher: replaced %zu %s occurrence(s)", count, label);
    return count;
}

bool patchFiskPaths(const std::string &objectFile,
                    const std::string &sourceFile,
                    const std::string &compilationDir)
{
    FILE *f = fopen(objectFile.c_str(), "rb");
    if (!f) {
        DEBUG("FiskPathPatcher: can't open %s", objectFile.c_str());
        return false;
    }

    fseek(f, 0, SEEK_END);
    const long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size <= 0 || static_cast<size_t>(size) < FISK_PAD_LENGTH) {
        fclose(f);
        return false;
    }

    std::vector<uint8_t> data(static_cast<size_t>(size));
    if (fread(data.data(), 1, data.size(), f) != data.size()) {
        fclose(f);
        DEBUG("FiskPathPatcher: short read on %s", objectFile.c_str());
        return false;
    }
    fclose(f);

    std::vector<uint8_t> nameRep, cdirRep;
    const bool haveName = makeReplacement(sourceFile, "source file", nameRep);
    const bool haveCdir = makeReplacement(compilationDir, "compilation dir", cdirRep);

    size_t total = 0;
    if (haveName)
        total += scanAndReplace(data, makePad(FISK_NAME_PREFIX), nameRep, "DW_AT_name");
    if (haveCdir)
        total += scanAndReplace(data, makePad(FISK_CDIR_PREFIX), cdirRep, "DW_AT_comp_dir");

    if (!total)
        return false;

    f = fopen(objectFile.c_str(), "wb");
    if (!f) {
        ERROR("FiskPathPatcher: can't write %s", objectFile.c_str());
        return false;
    }
    fwrite(data.data(), 1, data.size(), f);
    fclose(f);

    DEBUG("FiskPathPatcher: patched %s (%zu replacement(s))", objectFile.c_str(), total);
    return true;
}
