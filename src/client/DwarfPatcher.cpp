#include "DwarfPatcher.h"
#include "Log.h"
#include <elfio/elfio.hpp>
#include <cstring>
#include <string>
#include <vector>
#include <zlib.h>

// DWARF constants
enum {
    DW_AT_name = 0x03,
    DW_AT_comp_dir = 0x1b,
    DW_FORM_strp = 0x0e,
    DW_FORM_line_strp = 0x1f,
    DW_FORM_addr = 0x01,
    DW_FORM_data1 = 0x0b,
    DW_FORM_data2 = 0x05,
    DW_FORM_data4 = 0x06,
    DW_FORM_data8 = 0x07,
    DW_FORM_sdata = 0x0d,
    DW_FORM_udata = 0x0f,
    DW_FORM_ref1 = 0x11,
    DW_FORM_ref2 = 0x12,
    DW_FORM_ref4 = 0x13,
    DW_FORM_ref8 = 0x14,
    DW_FORM_ref_udata = 0x15,
    DW_FORM_string = 0x08,
    DW_FORM_block1 = 0x0a,
    DW_FORM_block2 = 0x03,
    DW_FORM_block4 = 0x04,
    DW_FORM_block = 0x09,
    DW_FORM_flag = 0x0c,
    DW_FORM_flag_present = 0x19,
    DW_FORM_sec_offset = 0x17,
    DW_FORM_exprloc = 0x18,
    DW_FORM_ref_addr = 0x10,
    DW_FORM_strx = 0x1a,
    DW_FORM_strx1 = 0x25,
    DW_FORM_strx2 = 0x26,
    DW_FORM_strx3 = 0x27,
    DW_FORM_strx4 = 0x28,
    DW_FORM_addrx = 0x1b,
    DW_FORM_addrx1 = 0x29,
    DW_FORM_addrx2 = 0x2a,
    DW_FORM_addrx3 = 0x2b,
    DW_FORM_addrx4 = 0x2c,
    DW_FORM_ref_sig8 = 0x20,
    DW_FORM_implicit_const = 0x21,
    DW_FORM_loclistx = 0x22,
    DW_FORM_rnglistx = 0x23,
    DW_FORM_data16 = 0x1e,
    DW_FORM_ref_sup4 = 0x1c,
    DW_FORM_ref_sup8 = 0x24,
    DW_FORM_strp_sup = 0x1d,
    DW_FORM_indirect = 0x16,
};

// ELF constants
enum {
    SHF_COMPRESSED = 0x800,
    ELFCOMPRESS_ZLIB = 1,
};

static uint64_t readULEB128(const uint8_t *&p)
{
    uint64_t result = 0;
    unsigned shift = 0;
    do {
        result |= static_cast<uint64_t>(*p & 0x7f) << shift;
        shift += 7;
    } while (*p++ & 0x80);
    return result;
}

static int64_t readSLEB128(const uint8_t *&p)
{
    int64_t result = 0;
    unsigned shift = 0;
    uint8_t byte;
    do {
        byte = *p++;
        result |= static_cast<int64_t>(byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    if (shift < 64 && (byte & 0x40))
        result |= -(static_cast<int64_t>(1) << shift);
    return result;
}

// Returns the size in bytes that a DWARF attribute value occupies in .debug_info,
// or -1 if unknown/unsupported. For strp/line_strp, returns the offset size.
static int formSize(uint16_t form, uint8_t addressSize, uint8_t offsetSize, const uint8_t *&infoPtr)
{
    switch (form) {
    case DW_FORM_addr:
        return addressSize;
    case DW_FORM_data1:
    case DW_FORM_ref1:
    case DW_FORM_flag:
    case DW_FORM_strx1:
    case DW_FORM_addrx1:
        return 1;
    case DW_FORM_data2:
    case DW_FORM_ref2:
    case DW_FORM_strx2:
    case DW_FORM_addrx2:
        return 2;
    case DW_FORM_strx3:
    case DW_FORM_addrx3:
        return 3;
    case DW_FORM_data4:
    case DW_FORM_ref4:
    case DW_FORM_ref_sup4:
    case DW_FORM_strx4:
    case DW_FORM_addrx4:
        return 4;
    case DW_FORM_data8:
    case DW_FORM_ref8:
    case DW_FORM_ref_sig8:
    case DW_FORM_ref_sup8:
        return 8;
    case DW_FORM_data16:
        return 16;
    case DW_FORM_strp:
    case DW_FORM_line_strp:
    case DW_FORM_sec_offset:
    case DW_FORM_ref_addr:
    case DW_FORM_strp_sup:
        return offsetSize;
    case DW_FORM_flag_present:
    case DW_FORM_implicit_const:
        return 0;
    case DW_FORM_sdata:
        readSLEB128(infoPtr);
        return 0; // already advanced
    case DW_FORM_udata:
    case DW_FORM_ref_udata:
    case DW_FORM_loclistx:
    case DW_FORM_rnglistx:
    case DW_FORM_strx:
    case DW_FORM_addrx:
        readULEB128(infoPtr);
        return 0; // already advanced
    case DW_FORM_string: {
        int len = 0;
        while (infoPtr[len])
            ++len;
        return len + 1; // include null terminator
    }
    case DW_FORM_block1: {
        uint8_t sz = *infoPtr++;
        return sz;
    }
    case DW_FORM_block2: {
        uint16_t sz;
        memcpy(&sz, infoPtr, 2);
        infoPtr += 2;
        return sz;
    }
    case DW_FORM_block4: {
        uint32_t sz;
        memcpy(&sz, infoPtr, 4);
        infoPtr += 4;
        return sz;
    }
    case DW_FORM_block:
    case DW_FORM_exprloc: {
        uint64_t sz = readULEB128(infoPtr);
        return static_cast<int>(sz);
    }
    default:
        return -1;
    }
}

// Find the offset of str in sectionData as a complete null-terminated string.
static size_t findStringInSection(const char *sectionData, size_t sectionSize, const std::string &str)
{
    const char *needle = str.c_str();
    size_t needleLen = str.size();
    for (size_t i = 0; i + needleLen < sectionSize; ++i) {
        if (memcmp(sectionData + i, needle, needleLen) == 0 && sectionData[i + needleLen] == '\0') {
            return i;
        }
    }
    return static_cast<size_t>(-1);
}

// Decompress a SHF_COMPRESSED section. Returns false on failure.
static bool decompressSection(ELFIO::section *sec, std::vector<uint8_t> &out)
{
    const char *data = sec->get_data();
    size_t dataSize = sec->get_size();

    // Parse Elf64_Chdr or Elf32_Chdr
    // For ELF64: ch_type(4), ch_reserved(4), ch_size(8), ch_addralign(8) = 24 bytes
    // For ELF32: ch_type(4), ch_size(4), ch_addralign(4) = 12 bytes
    // We detect based on section's owner ELF class
    uint32_t chType;
    uint64_t uncompressedSize;
    size_t headerSize;

    memcpy(&chType, data, 4);
    if (chType != ELFCOMPRESS_ZLIB) {
        DEBUG("DwarfPatcher: unsupported compression type %u", chType);
        return false;
    }

    // Assume ELF64 since we're on x86_64
    headerSize = 24;
    memcpy(&uncompressedSize, data + 8, 8);

    out.resize(uncompressedSize);
    uLongf destLen = uncompressedSize;
    int ret = uncompress(out.data(), &destLen, reinterpret_cast<const Bytef *>(data + headerSize), dataSize - headerSize);
    if (ret != Z_OK) {
        DEBUG("DwarfPatcher: zlib uncompress failed: %d", ret);
        return false;
    }
    out.resize(destLen);
    return true;
}

// Compress data back into SHF_COMPRESSED format with Elf64_Chdr header.
static std::vector<uint8_t> compressSection(const std::vector<uint8_t> &uncompressed, uint64_t alignment)
{
    uLongf compBound = compressBound(uncompressed.size());
    std::vector<uint8_t> result(24 + compBound);

    // Write Elf64_Chdr
    uint32_t chType = ELFCOMPRESS_ZLIB;
    uint32_t chReserved = 0;
    uint64_t chSize = uncompressed.size();
    uint64_t chAlign = alignment;
    memcpy(result.data(), &chType, 4);
    memcpy(result.data() + 4, &chReserved, 4);
    memcpy(result.data() + 8, &chSize, 8);
    memcpy(result.data() + 16, &chAlign, 8);

    uLongf destLen = compBound;
    compress(result.data() + 24, &destLen, uncompressed.data(), uncompressed.size());
    result.resize(24 + destLen);
    return result;
}

// Structure to track which .debug_info offsets need relocation patching
struct AttrLocation {
    size_t infoOffset; // offset within .debug_info where the strp value is
    bool isName;       // true = DW_AT_name, false = DW_AT_comp_dir
};

// Parse the first CU's first DIE to find DW_AT_name and DW_AT_comp_dir positions.
// Takes decompressed data buffers.
static bool findAttrLocations(const uint8_t *infoData, size_t infoSize,
                              const uint8_t *abbrevData, size_t abbrevSize,
                              std::vector<AttrLocation> &locations)
{
    const uint8_t *p = infoData;

    // Read CU header
    uint32_t unitLength32;
    memcpy(&unitLength32, p, 4);
    p += 4;
    bool is64bit = (unitLength32 == 0xFFFFFFFF);
    if (is64bit)
        p += 8;
    uint8_t offsetSize = is64bit ? 8 : 4;

    uint16_t version;
    memcpy(&version, p, 2);
    p += 2;

    uint64_t abbrevOffset;
    uint8_t addressSize;

    if (version >= 5) {
        p++; // unit_type
        addressSize = *p++;
        if (is64bit) {
            memcpy(&abbrevOffset, p, 8);
            p += 8;
        } else {
            uint32_t tmp;
            memcpy(&tmp, p, 4);
            abbrevOffset = tmp;
            p += 4;
        }
    } else {
        if (is64bit) {
            memcpy(&abbrevOffset, p, 8);
            p += 8;
        } else {
            uint32_t tmp;
            memcpy(&tmp, p, 4);
            abbrevOffset = tmp;
            p += 4;
        }
        addressSize = *p++;
    }

    uint64_t abbrevCode = readULEB128(p);
    if (abbrevCode == 0)
        return false;

    // Find abbreviation
    const uint8_t *ap = abbrevData + abbrevOffset;
    const uint8_t *abbrevEnd = abbrevData + abbrevSize;
    while (ap < abbrevEnd) {
        uint64_t code = readULEB128(ap);
        if (code == 0)
            break;
        readULEB128(ap); // tag
        ap++;            // has_children

        if (code == abbrevCode) {
            while (ap < abbrevEnd) {
                uint64_t attrName = readULEB128(ap);
                uint64_t attrForm = readULEB128(ap);
                if (attrForm == DW_FORM_implicit_const)
                    readSLEB128(ap);
                if (attrName == 0 && attrForm == 0)
                    break;

                size_t attrOffset = p - infoData;

                if ((attrName == DW_AT_name || attrName == DW_AT_comp_dir)
                    && (attrForm == DW_FORM_strp || attrForm == DW_FORM_line_strp)) {
                    locations.push_back({ attrOffset, attrName == DW_AT_name });
                }

                // Advance past attribute value
                const uint8_t *before = p;
                int sz = formSize(static_cast<uint16_t>(attrForm), addressSize, offsetSize, p);
                if (sz < 0)
                    return false;
                if (p == before)
                    p += sz;
            }
            return true;
        } else {
            while (ap < abbrevEnd) {
                uint64_t an = readULEB128(ap);
                uint64_t af = readULEB128(ap);
                if (af == DW_FORM_implicit_const)
                    readSLEB128(ap);
                if (an == 0 && af == 0)
                    break;
            }
        }
    }
    return false;
}

bool patchDwarfSourcePath(const std::string &objectFile, const std::string &oldSourcePath, const std::string &newSourcePath)
{
    ELFIO::elfio elf;
    if (!elf.load(objectFile)) {
        DEBUG("DwarfPatcher: failed to load ELF: %s", objectFile.c_str());
        return false;
    }

    // Find sections
    ELFIO::section *debugInfo = nullptr;
    ELFIO::section *debugAbbrev = nullptr;
    ELFIO::section *debugStr = nullptr;
    ELFIO::section *relaDebugInfo = nullptr;

    for (auto &sec : elf.sections) {
        const std::string &name = sec->get_name();
        if (name == ".debug_info")
            debugInfo = sec.get();
        else if (name == ".debug_abbrev")
            debugAbbrev = sec.get();
        else if (name == ".debug_str")
            debugStr = sec.get();
        else if (name == ".rela.debug_info")
            relaDebugInfo = sec.get();
    }

    if (!debugInfo || !debugAbbrev) {
        DEBUG("DwarfPatcher: no .debug_info or .debug_abbrev in %s", objectFile.c_str());
        return true;
    }

    if (!debugStr) {
        DEBUG("DwarfPatcher: no .debug_str in %s", objectFile.c_str());
        return true;
    }

    // Decompress .debug_info and .debug_abbrev if compressed
    std::vector<uint8_t> infoDecompressed, abbrevDecompressed;
    const uint8_t *infoData;
    size_t infoSize;
    const uint8_t *abbrevDataPtr;
    size_t abbrevSize;

    if (debugInfo->get_flags() & SHF_COMPRESSED) {
        if (!decompressSection(debugInfo, infoDecompressed)) {
            DEBUG("DwarfPatcher: failed to decompress .debug_info in %s", objectFile.c_str());
            return false;
        }
        infoData = infoDecompressed.data();
        infoSize = infoDecompressed.size();
    } else {
        infoData = reinterpret_cast<const uint8_t *>(debugInfo->get_data());
        infoSize = debugInfo->get_size();
    }

    if (debugAbbrev->get_flags() & SHF_COMPRESSED) {
        if (!decompressSection(debugAbbrev, abbrevDecompressed)) {
            DEBUG("DwarfPatcher: failed to decompress .debug_abbrev in %s", objectFile.c_str());
            return false;
        }
        abbrevDataPtr = abbrevDecompressed.data();
        abbrevSize = abbrevDecompressed.size();
    } else {
        abbrevDataPtr = reinterpret_cast<const uint8_t *>(debugAbbrev->get_data());
        abbrevSize = debugAbbrev->get_size();
    }

    // Find DW_AT_name and DW_AT_comp_dir positions in .debug_info
    std::vector<AttrLocation> attrLocations;
    if (!findAttrLocations(infoData, infoSize, abbrevDataPtr, abbrevSize, attrLocations) || attrLocations.empty()) {
        DEBUG("DwarfPatcher: could not find DW_AT_name/DW_AT_comp_dir in %s", objectFile.c_str());
        return true;
    }

    // Compute old/new directory paths
    std::string oldDir, newDir;
    {
        size_t lastSlash = oldSourcePath.rfind('/');
        if (lastSlash != std::string::npos)
            oldDir = oldSourcePath.substr(0, lastSlash);
        lastSlash = newSourcePath.rfind('/');
        if (lastSlash != std::string::npos)
            newDir = newSourcePath.substr(0, lastSlash);
    }

    // Check if .debug_str is compressed (SHF_COMPRESSED)
    bool isCompressed = (debugStr->get_flags() & SHF_COMPRESSED) != 0;
    bool hasRelocations = (relaDebugInfo != nullptr);

    DEBUG("DwarfPatcher: .debug_str compressed=%d, has_relocations=%d", isCompressed, hasRelocations);

    if (hasRelocations) {
        // --- Relocation-based approach for relocatable .o files ---

        // Get the uncompressed .debug_str content
        std::vector<uint8_t> strData;
        if (isCompressed) {
            if (!decompressSection(debugStr, strData)) {
                DEBUG("DwarfPatcher: failed to decompress .debug_str in %s", objectFile.c_str());
                return false;
            }
        } else {
            strData.assign(debugStr->get_data(), debugStr->get_data() + debugStr->get_size());
        }

        // Use ELFIO's relocation accessor
        ELFIO::const_relocation_section_accessor rela(elf, relaDebugInfo);
        ELFIO::Elf64_Addr offset;
        ELFIO::Elf_Word symbol;
        unsigned rtype;
        ELFIO::Elf_Sxword addend;

        // Find the .debug_str section index for matching relocations
        ELFIO::Elf_Half debugStrIdx = debugStr->get_index();

        bool patched = false;

        for (const auto &loc : attrLocations) {
            // Find the relocation entry for this .debug_info offset
            for (ELFIO::Elf_Xword i = 0; i < rela.get_entries_num(); ++i) {
                rela.get_entry(i, offset, symbol, rtype, addend);

                if (static_cast<size_t>(offset) != loc.infoOffset)
                    continue;

                // Verify this relocation targets .debug_str
                std::string symName;
                ELFIO::Elf64_Addr symValue;
                ELFIO::Elf_Xword symSize;
                unsigned char symBind, symType, symOther;
                ELFIO::Elf_Half symSection;

                // Get the symbol table section
                ELFIO::section *symtab = elf.sections[relaDebugInfo->get_link()];
                ELFIO::const_symbol_section_accessor syma(elf, symtab);
                syma.get_symbol(symbol, symName, symValue, symSize, symBind, symType, symSection, symOther);

                if (symSection != debugStrIdx) {
                    DEBUG("DwarfPatcher: relocation at 0x%zx targets section %d, not .debug_str (%d)",
                          loc.infoOffset, symSection, debugStrIdx);
                    continue;
                }

                // The addend is the offset into the uncompressed .debug_str
                size_t strOffset = static_cast<size_t>(addend);
                if (strOffset >= strData.size()) {
                    DEBUG("DwarfPatcher: addend 0x%zx beyond .debug_str size 0x%zx", strOffset, strData.size());
                    continue;
                }

                const char *currentStr = reinterpret_cast<const char *>(strData.data() + strOffset);

                if (loc.isName && strcmp(currentStr, oldSourcePath.c_str()) == 0) {
                    // Append new source path to .debug_str
                    size_t newOffset = strData.size();
                    strData.insert(strData.end(), newSourcePath.begin(), newSourcePath.end());
                    strData.push_back('\0');
                    // Update the relocation addend
                    rela.set_entry(i, offset, symbol, rtype, static_cast<ELFIO::Elf_Sxword>(newOffset));
                    patched = true;
                    DEBUG("DwarfPatcher: patched DW_AT_name relocation addend 0x%zx -> 0x%zx", strOffset, newOffset);
                } else if (!loc.isName && !oldDir.empty() && strcmp(currentStr, oldDir.c_str()) == 0) {
                    size_t newOffset = strData.size();
                    strData.insert(strData.end(), newDir.begin(), newDir.end());
                    strData.push_back('\0');
                    rela.set_entry(i, offset, symbol, rtype, static_cast<ELFIO::Elf_Sxword>(newOffset));
                    patched = true;
                    DEBUG("DwarfPatcher: patched DW_AT_comp_dir relocation addend 0x%zx -> 0x%zx", strOffset, newOffset);
                }
                break;
            }
        }

        if (!patched) {
            DEBUG("DwarfPatcher: no matching relocations found to patch in %s", objectFile.c_str());
            return true;
        }

        // Write back the (possibly modified) .debug_str
        if (isCompressed) {
            uint64_t origAlign = 1;
            // Read alignment from original compression header
            if (debugStr->get_size() >= 24) {
                memcpy(&origAlign, debugStr->get_data() + 16, 8);
            }
            auto compressed = compressSection(strData, origAlign);
            debugStr->set_data(reinterpret_cast<const char *>(compressed.data()), compressed.size());
        } else {
            debugStr->set_data(reinterpret_cast<const char *>(strData.data()), strData.size());
        }
    } else {
        // --- Direct offset approach for linked binaries or non-relocated .o files ---
        size_t oldOffset = findStringInSection(debugStr->get_data(), debugStr->get_size(), oldSourcePath);
        if (oldOffset == static_cast<size_t>(-1)) {
            DEBUG("DwarfPatcher: old source path not found in .debug_str: %s", oldSourcePath.c_str());
            return true;
        }

        size_t newStrOffset = debugStr->get_size();
        std::string appendData = newSourcePath + '\0';
        size_t newDirOffset = static_cast<size_t>(-1);
        if (!oldDir.empty() && !newDir.empty() && oldDir != newDir) {
            newDirOffset = newStrOffset + appendData.size();
            appendData += newDir + '\0';
        }
        debugStr->append_data(appendData.c_str(), appendData.size());

        // Patch .debug_info offsets directly
        std::vector<uint8_t> infoDataCopy(debugInfo->get_data(), debugInfo->get_data() + debugInfo->get_size());
        bool patched = false;

        for (const auto &loc : attrLocations) {
            uint32_t currentOffset;
            memcpy(&currentOffset, &infoDataCopy[loc.infoOffset], 4);

            if (loc.isName && currentOffset == oldOffset) {
                uint32_t val = static_cast<uint32_t>(newStrOffset);
                memcpy(&infoDataCopy[loc.infoOffset], &val, 4);
                patched = true;
            } else if (!loc.isName && !oldDir.empty()) {
                size_t oldDirOffset = findStringInSection(debugStr->get_data(), debugStr->get_size(), oldDir);
                if (currentOffset == oldDirOffset && newDirOffset != static_cast<size_t>(-1)) {
                    uint32_t val = static_cast<uint32_t>(newDirOffset);
                    memcpy(&infoDataCopy[loc.infoOffset], &val, 4);
                    patched = true;
                }
            }
        }

        if (patched) {
            debugInfo->set_data(reinterpret_cast<const char *>(infoDataCopy.data()), infoDataCopy.size());
        }
    }

    if (!elf.save(objectFile)) {
        ERROR("DwarfPatcher: failed to save patched ELF: %s", objectFile.c_str());
        return false;
    }

    DEBUG("DwarfPatcher: patched source path in %s: %s -> %s", objectFile.c_str(), oldSourcePath.c_str(), newSourcePath.c_str());
    return true;
}
