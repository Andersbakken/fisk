#ifndef DWARFPATCHER_H
#define DWARFPATCHER_H

#include <string>

// Patches DWARF debug info in an ELF object file, replacing oldSourcePath
// with newSourcePath in DW_AT_name/DW_AT_comp_dir attributes.
// Returns true on success (or if no patching was needed), false on error.
bool patchDwarfSourcePath(const std::string &objectFile, const std::string &oldSourcePath, const std::string &newSourcePath);

#endif
