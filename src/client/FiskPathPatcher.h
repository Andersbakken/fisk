#ifndef FISKPATHPATCHER_H
#define FISKPATHPATCHER_H

#include <string>

// Scans an object file (ELF or LTO bitcode) for the fixed padded canonical
// prefixes written by the fisk builder's -fdebug-prefix-map flags, and
// overwrites them in-place with the real source path and compilation
// directory.  Returns true if any replacements were made.
bool patchFiskPaths(const std::string &objectFile,
                    const std::string &sourceFile,
                    const std::string &compilationDir);

#endif
