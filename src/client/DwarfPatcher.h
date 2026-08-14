#ifndef DWARFPATCHER_H
#define DWARFPATCHER_H

#include <string>

// Patches DWARF debug info in an ELF object file. DW_AT_name goes from
// oldSourcePath to newSourcePath; DW_AT_comp_dir goes from the directory of
// oldSourcePath to compilationDir, which must be the directory the compiler
// would have run in locally, not the directory newSourcePath lives in.
// Returns true on success (or if no patching was needed), false on error.
bool patchDwarfSourcePath(const std::string &objectFile, const std::string &oldSourcePath, const std::string &newSourcePath,
                          const std::string &compilationDir);

#endif
