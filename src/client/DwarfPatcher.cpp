#include "DwarfPatcher.h"
#include "Log.h"
#include <cstdint>
#include <cstring>
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wextra-semi"
#pragma clang diagnostic ignored "-Wshadow-field-in-constructor"
#pragma clang diagnostic ignored "-Wshadow-field"
#pragma clang diagnostic ignored "-Wdocumentation"
#pragma clang diagnostic ignored "-Wcast-qual"
#pragma clang diagnostic ignored "-Wcast-align"
#pragma clang diagnostic ignored "-Wnrvo"
#pragma clang diagnostic ignored "-Wweak-vtables"
#pragma clang diagnostic ignored "-Wshorten-64-to-32"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wshadow"
#pragma GCC diagnostic ignored "-Wcast-qual"
#pragma GCC diagnostic ignored "-Wcast-align"
#endif
#include <elfio/elfio.hpp>
#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include <string>
#include <vector>
#include <zlib.h>

// DWARF constants
enum
{
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
enum
{
    SHF_COMPRESSED = 0x800,
    ELFCOMPRESS_ZLIB = 1,
};

// How a DW_AT_name / DW_AT_comp_dir attribute references its string.
enum
{
    STR_STRP = 0,      // offset into .debug_str
    STR_STRX = 1,      // index into .debug_str_offsets (string in .debug_str)
    STR_LINESTRP = 2,  // offset into .debug_line_str
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

// The ELF compression header (Chdr) has a different layout for ELF32 and ELF64:
//   ELF32: ch_type(4), ch_size(4), ch_addralign(4)  = 12 bytes
//   ELF64: ch_type(4), ch_reserved(4), ch_size(8), ch_addralign(8) = 24 bytes
// Everything here must be driven by the ELF class of the file being patched,
// not the host that happens to be running the patcher.
static size_t chdrHeaderSize(int elfClass)
{
    return elfClass == ELFIO::ELFCLASS32 ? 12 : 24;
}

static uint64_t readChdrUncompressedSize(ELFIO::section *sec, int elfClass)
{
    const char *data = sec->get_data();
    if (elfClass == ELFIO::ELFCLASS32) {
        uint32_t chSize;
        memcpy(&chSize, data + 4, 4);
        return chSize;
    }
    uint64_t chSize;
    memcpy(&chSize, data + 8, 8);
    return chSize;
}

static uint64_t readChdrAlign(ELFIO::section *sec, int elfClass)
{
    const char *data = sec->get_data();
    if (elfClass == ELFIO::ELFCLASS32) {
        uint32_t chAlign;
        memcpy(&chAlign, data + 8, 4);
        return chAlign;
    }
    uint64_t chAlign;
    memcpy(&chAlign, data + 16, 8);
    return chAlign;
}

// Decompress a SHF_COMPRESSED section. Returns false on failure.
static bool decompressSection(ELFIO::section *sec, int elfClass, std::vector<uint8_t> &out)
{
    const char *data = sec->get_data();
    size_t dataSize = sec->get_size();

    uint32_t chType;
    memcpy(&chType, data, 4);
    if (chType != ELFCOMPRESS_ZLIB) {
        DEBUG("DwarfPatcher: unsupported compression type %u", chType);
        return false;
    }

    const uint64_t uncompressedSize = readChdrUncompressedSize(sec, elfClass);
    const size_t headerSize = chdrHeaderSize(elfClass);

    out.resize(static_cast<size_t>(uncompressedSize));
    uLongf destLen = uncompressedSize;
    int ret = uncompress(out.data(), &destLen, reinterpret_cast<const Bytef *>(data + headerSize), dataSize - headerSize);
    if (ret != Z_OK) {
        DEBUG("DwarfPatcher: zlib uncompress failed: %d", ret);
        return false;
    }
    out.resize(destLen);
    return true;
}

// Compress data back into SHF_COMPRESSED format with a Chdr header matching the ELF class.
static std::vector<uint8_t> compressSection(int elfClass, const std::vector<uint8_t> &uncompressed, uint64_t alignment)
{
    uLongf compBound = compressBound(uncompressed.size());
    const size_t headerSize = chdrHeaderSize(elfClass);
    std::vector<uint8_t> result(headerSize + compBound);

    if (elfClass == ELFIO::ELFCLASS32) {
        uint32_t chType = ELFCOMPRESS_ZLIB;
        uint32_t chSize = static_cast<uint32_t>(uncompressed.size());
        uint32_t chAlign = static_cast<uint32_t>(alignment);
        memcpy(result.data(), &chType, 4);
        memcpy(result.data() + 4, &chSize, 4);
        memcpy(result.data() + 8, &chAlign, 4);
    } else {
        uint32_t chType = ELFCOMPRESS_ZLIB;
        uint32_t chReserved = 0;
        uint64_t chSize = uncompressed.size();
        uint64_t chAlign = alignment;
        memcpy(result.data(), &chType, 4);
        memcpy(result.data() + 4, &chReserved, 4);
        memcpy(result.data() + 8, &chSize, 8);
        memcpy(result.data() + 16, &chAlign, 8);
    }

    uLongf destLen = compBound;
    compress(result.data() + headerSize, &destLen, uncompressed.data(), uncompressed.size());
    result.resize(headerSize + destLen);
    return result;
}

// Holds a possibly SHF_COMPRESSED section in a decompressed, modifiable buffer.
// Nothing is written back to the ELF unless modified.
struct SectionBuffer
{
    ELFIO::section *sec = nullptr;
    std::vector<uint8_t> data;
    bool compressed = false;
    uint64_t origAlign = 1;
    bool modified = false;

    bool load(int elfClass, ELFIO::section *s)
    {
        sec = s;
        if (!s)
            return false;
        compressed = (s->get_flags() & SHF_COMPRESSED) != 0;
        if (compressed) {
            origAlign = readChdrAlign(s, elfClass);
            return decompressSection(s, elfClass, data);
        }
        data.assign(s->get_data(), s->get_data() + s->get_size());
        return true;
    }

    void save(int elfClass)
    {
        if (!sec || !modified)
            return;
        if (compressed) {
            auto compressedData = compressSection(elfClass, data, origAlign);
            sec->set_data(reinterpret_cast<const char *>(compressedData.data()), static_cast<ELFIO::Elf_Word>(compressedData.size()));
        } else {
            sec->set_data(reinterpret_cast<const char *>(data.data()), static_cast<ELFIO::Elf_Word>(data.size()));
        }
    }

    bool readOffset(size_t pos, uint8_t size, size_t &out) const
    {
        if (pos + size > data.size())
            return false;
        if (size == 4) {
            uint32_t v;
            memcpy(&v, data.data() + pos, 4);
            out = v;
            return true;
        }
        if (size == 8) {
            uint64_t v;
            memcpy(&v, data.data() + pos, 8);
            out = v;
            return true;
        }
        return false;
    }

    bool writeOffset(size_t pos, uint8_t size, size_t val)
    {
        if (pos + size > data.size())
            return false;
        if (size == 4) {
            uint32_t v = static_cast<uint32_t>(val);
            memcpy(data.data() + pos, &v, 4);
            modified = true;
            return true;
        }
        if (size == 8) {
            uint64_t v = static_cast<uint64_t>(val);
            memcpy(data.data() + pos, &v, 8);
            modified = true;
            return true;
        }
        return false;
    }

    size_t find(const std::string &str) const
    {
        return findStringInSection(reinterpret_cast<const char *>(data.data()), data.size(), str);
    }

    // Return the offset of str, appending it (with NUL) if not present.
    size_t append(const std::string &str)
    {
        size_t off = find(str);
        if (off != static_cast<size_t>(-1))
            return off;
        off = data.size();
        data.insert(data.end(), str.begin(), str.end());
        data.push_back('\0');
        modified = true;
        return off;
    }

    // NUL out len bytes at off. Offsets of every other string are preserved, so
    // no relocation or in-section offset needs rewriting; the string simply
    // becomes empty. Only safe once the range is known to be unreferenced.
    void blank(size_t off, size_t len)
    {
        if (!len || off + len > data.size())
            return;
        memset(data.data() + off, 0, len);
        modified = true;
    }
};

// Structure to track which .debug_info offsets need relocation patching
struct AttrLocation
{
    size_t infoOffset; // offset within .debug_info where the attribute value is
    bool isName; // true = DW_AT_name, false = DW_AT_comp_dir
    uint8_t strForm; // STR_STRP / STR_STRX / STR_LINESTRP
    uint8_t offsetSize; // CU offset size: 4 (DWARF32) or 8 (DWARF64)
};

static uint8_t attributeStrForm(uint16_t form)
{
    switch (form) {
        case DW_FORM_strp:
            return STR_STRP;
        case DW_FORM_line_strp:
            return STR_LINESTRP;
        case DW_FORM_strx:
        case DW_FORM_strx1:
        case DW_FORM_strx2:
        case DW_FORM_strx3:
        case DW_FORM_strx4:
            return STR_STRX;
        default:
            return 0xff;
    }
}

// Read the strx index value stored at p for a given strx form.
static uint64_t readStrxIndex(const uint8_t *p, uint8_t form)
{
    switch (form) {
        case DW_FORM_strx1:
            return *p;
        case DW_FORM_strx2: {
            uint16_t v = 0;
            memcpy(&v, p, 2);
            return v;
        }
        case DW_FORM_strx3: {
            uint32_t v = 0;
            memcpy(&v, p, 3);
            return v;
        }
        case DW_FORM_strx4: {
            uint32_t v = 0;
            memcpy(&v, p, 4);
            return v;
        }
        default: { // DW_FORM_strx is a ULEB128
            const uint8_t *q = p;
            return readULEB128(q);
        }
    }
}

// Size of the DWARF5 .debug_str_offsets contribution header, and the size of
// each entry (matches the CU offset size). Returns 0 on failure.
static size_t strOffsetsHeaderSize(const uint8_t *data, size_t size, uint8_t &entrySize)
{
    if (size < 8)
        return 0;
    uint32_t unitLength;
    memcpy(&unitLength, data, 4);
    size_t header = 4;
    uint8_t es = 4;
    if (unitLength == 0xffffffffu) { // DWARF64
        es = 8;
        header += 8;
    }
    header += 4; // version + padding
    entrySize = es;
    return header;
}

// Parse the first CU's first DIE to find DW_AT_name and DW_AT_comp_dir positions.
// Takes decompressed data buffers.
static bool findAttrLocations(const uint8_t *infoData, size_t infoSize, const uint8_t *abbrevData, size_t abbrevSize,
                              std::vector<AttrLocation> &locations)
{
    (void)infoSize;
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
        ap++; // has_children

        if (code == abbrevCode) {
            while (ap < abbrevEnd) {
                uint64_t attrName = readULEB128(ap);
                uint64_t attrForm = readULEB128(ap);
                if (attrForm == DW_FORM_implicit_const)
                    readSLEB128(ap);
                if (attrName == 0 && attrForm == 0)
                    break;

                size_t attrOffset = p - infoData;

                if (attrName == DW_AT_name || attrName == DW_AT_comp_dir) {
                    uint8_t strForm = attributeStrForm(static_cast<uint16_t>(attrForm));
                    if (strForm != 0xff) {
                        locations.push_back({ attrOffset, attrName == DW_AT_name, strForm, offsetSize });
                    }
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

// Find the relocation entry whose r_offset equals targetOffset.
static bool findRelocation(ELFIO::const_relocation_section_accessor &acc, ELFIO::Elf64_Addr targetOffset,
                           ELFIO::Elf_Xword &index, ELFIO::Elf_Word &symbol, unsigned &type, ELFIO::Elf_Sxword &addend)
{
    for (ELFIO::Elf_Xword i = 0; i < acc.get_entries_num(); ++i) {
        ELFIO::Elf64_Addr offset;
        ELFIO::Elf_Word sym;
        unsigned rtype;
        ELFIO::Elf_Sxword ad;
        acc.get_entry(i, offset, sym, rtype, ad);
        if (offset == targetOffset) {
            index = i;
            symbol = sym;
            type = rtype;
            addend = ad;
            return true;
        }
    }
    return false;
}

// Collect every offset into the section with index strSectionIndex that is
// still reachable through a relocation, so a candidate byte range can be
// proven dead before it is blanked.
//
// .debug_str is SHF_MERGE|SHF_STRINGS, so the linker lets one string be the
// tail of another: a reference to offset 0x70 of "/compiles/3/sourcefile" is a
// live reference to "sourcefile". Interior offsets therefore matter just as
// much as the start, which is why whole ranges are tested rather than exact
// starts.
static void collectStringRefs(ELFIO::elfio &elf, ELFIO::Elf_Half strSectionIndex, std::vector<size_t> &refs)
{
    for (const auto &sec : elf.sections) {
        if (sec->get_type() != ELFIO::SHT_RELA && sec->get_type() != ELFIO::SHT_REL)
            continue;

        ELFIO::section *symSec = elf.sections[sec->get_link()];
        if (!symSec)
            continue;
        ELFIO::const_symbol_section_accessor symbols(elf, symSec);
        ELFIO::const_relocation_section_accessor relocations(elf, sec.get());

        for (ELFIO::Elf_Xword i = 0; i < relocations.get_entries_num(); ++i) {
            ELFIO::Elf64_Addr offset;
            ELFIO::Elf_Word symbol;
            unsigned type;
            ELFIO::Elf_Sxword addend;
            if (!relocations.get_entry(i, offset, symbol, type, addend))
                continue;

            std::string name;
            ELFIO::Elf64_Addr value;
            ELFIO::Elf_Xword size;
            unsigned char bind;
            unsigned char symType;
            ELFIO::Elf_Half sectionIndex;
            unsigned char other;
            if (!symbols.get_symbol(symbol, name, value, size, bind, symType, sectionIndex, other))
                continue;
            if (sectionIndex != strSectionIndex)
                continue;
            if (addend >= 0)
                refs.push_back(static_cast<size_t>(addend));
        }
    }
}

static bool rangeIsReferenced(const std::vector<size_t> &refs, size_t offset, size_t length)
{
    for (size_t ref : refs) {
        if (ref >= offset && ref < offset + length)
            return true;
    }
    return false;
}

// A string that has been replaced and whose bytes are candidates for removal.
struct DeadString
{
    SectionBuffer *section = nullptr;
    size_t offset = 0;
    size_t length = 0;
};

bool patchDwarfSourcePath(const std::string &objectFile, const std::string &oldSourcePath, const std::string &newSourcePath)
{
    ELFIO::elfio elf;
    if (!elf.load(objectFile)) {
        DEBUG("DwarfPatcher: failed to load ELF: %s", objectFile.c_str());
        return false;
    }
    const int elfClass = elf.get_class();

    // Find sections
    ELFIO::section *debugInfo = nullptr;
    ELFIO::section *debugAbbrev = nullptr;
    ELFIO::section *debugStr = nullptr;
    ELFIO::section *debugLineStr = nullptr;
    ELFIO::section *debugStrOffsets = nullptr;
    ELFIO::section *relaDebugInfo = nullptr;
    ELFIO::section *relaDebugStrOffsets = nullptr;

    for (auto &sec : elf.sections) {
        const std::string &name = sec->get_name();
        if (name == ".debug_info" || name == ".debug_info.dwo")
            debugInfo = sec.get();
        else if (name == ".debug_abbrev" || name == ".debug_abbrev.dwo")
            debugAbbrev = sec.get();
        else if (name == ".debug_str" || name == ".debug_str.dwo")
            debugStr = sec.get();
        else if (name == ".debug_line_str" || name == ".debug_line_str.dwo")
            debugLineStr = sec.get();
        else if (name == ".debug_str_offsets" || name == ".debug_str_offsets.dwo")
            debugStrOffsets = sec.get();
        else if (name == ".rela.debug_info" || name == ".rel.debug_info")
            relaDebugInfo = sec.get();
        else if (name == ".rela.debug_str_offsets" || name == ".rel.debug_str_offsets")
            relaDebugStrOffsets = sec.get();
    }

    if (!debugInfo || !debugAbbrev) {
        DEBUG("DwarfPatcher: no .debug_info or .debug_abbrev in %s", objectFile.c_str());
        return true;
    }

    if (!debugStr && !debugLineStr && !debugStrOffsets) {
        DEBUG("DwarfPatcher: no string sections (.debug_str/.debug_line_str/.debug_str_offsets) in %s", objectFile.c_str());
        return true;
    }

    // Decompress .debug_info and .debug_abbrev so they can be parsed (and patched).
    SectionBuffer infoBuf, abbrevBuf;
    if (!infoBuf.load(elfClass, debugInfo)) {
        DEBUG("DwarfPatcher: failed to decompress .debug_info in %s", objectFile.c_str());
        return false;
    }
    if (!abbrevBuf.load(elfClass, debugAbbrev)) {
        DEBUG("DwarfPatcher: failed to decompress .debug_abbrev in %s", objectFile.c_str());
        return false;
    }

    // Find DW_AT_name and DW_AT_comp_dir positions in .debug_info
    std::vector<AttrLocation> attrLocations;
    if (!findAttrLocations(infoBuf.data.data(), infoBuf.data.size(), abbrevBuf.data.data(), abbrevBuf.data.size(), attrLocations) || attrLocations.empty()) {
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

    SectionBuffer strBuf, lineStrBuf, strOffsetsBuf;
    strBuf.load(elfClass, debugStr);
    lineStrBuf.load(elfClass, debugLineStr);
    strOffsetsBuf.load(elfClass, debugStrOffsets);

    // For RELA relocation sections the string offset lives in the relocation's
    // addend, which ELFIO can rewrite. For REL sections the addend lives in the
    // target section data itself (ELFIO's set_entry ignores the addend for REL),
    // so we patch the decompressed target data directly instead.
    const bool infoUsesRela = relaDebugInfo && relaDebugInfo->get_type() == ELFIO::SHT_RELA;
    const bool strOffsetsUsesRela = relaDebugStrOffsets && relaDebugStrOffsets->get_type() == ELFIO::SHT_RELA;

    DEBUG("DwarfPatcher: .debug_str compressed=%d, .debug_info relocations=%s, .debug_str_offsets relocations=%s",
          strBuf.compressed ? 1 : 0, infoUsesRela ? "rela" : (relaDebugInfo ? "rel" : "none"),
          strOffsetsUsesRela ? "rela" : (relaDebugStrOffsets ? "rel" : "none"));

    bool patched = false;
    std::vector<DeadString> deadStrings;

    for (const auto &loc : attrLocations) {
        const std::string &expected = loc.isName ? oldSourcePath : oldDir;
        const std::string &replacement = loc.isName ? newSourcePath : newDir;
        if (expected.empty() || replacement.empty() || expected == replacement)
            continue;

        SectionBuffer *strSection = nullptr;
        SectionBuffer *owningBuf = nullptr;
        size_t valuePos = 0;
        ELFIO::section *relSec = nullptr;
        bool usesRela = false;

        switch (loc.strForm) {
            case STR_STRP:
                strSection = &strBuf;
                owningBuf = &infoBuf;
                valuePos = loc.infoOffset;
                relSec = relaDebugInfo;
                usesRela = infoUsesRela;
                break;
            case STR_LINESTRP:
                strSection = &lineStrBuf;
                owningBuf = &infoBuf;
                valuePos = loc.infoOffset;
                relSec = relaDebugInfo;
                usesRela = infoUsesRela;
                break;
            case STR_STRX: {
                strSection = &strBuf;
                owningBuf = &strOffsetsBuf;
                relSec = relaDebugStrOffsets;
                usesRela = strOffsetsUsesRela;
                uint8_t entrySize = 0;
                size_t headerSize = strOffsetsHeaderSize(strOffsetsBuf.data.data(), strOffsetsBuf.data.size(), entrySize);
                if (!headerSize)
                    continue;
                uint64_t index = readStrxIndex(infoBuf.data.data() + loc.infoOffset, loc.strForm);
                valuePos = headerSize + static_cast<size_t>(index) * entrySize;
                break;
            }
            default:
                continue;
        }

        if (!strSection || !owningBuf)
            continue;

        // Offset of the old string inside the string section.
        size_t oldOffset = strSection->find(expected);
        if (oldOffset == static_cast<size_t>(-1))
            continue;

        bool matched = false;

        if (usesRela && relSec) {
            // Rewrite the relocation addend to point at the new string.
            ELFIO::const_relocation_section_accessor relacc(elf, relSec);
            ELFIO::Elf_Xword idx;
            ELFIO::Elf_Word symbol;
            unsigned rtype;
            ELFIO::Elf_Sxword addend;
            if (findRelocation(relacc, static_cast<ELFIO::Elf64_Addr>(valuePos), idx, symbol, rtype, addend)) {
                if (addend >= 0 && static_cast<size_t>(addend) < strSection->data.size()) {
                    const char *currentStr = reinterpret_cast<const char *>(strSection->data.data() + addend);
                    if (strcmp(currentStr, expected.c_str()) == 0) {
                        const size_t deadOffset = static_cast<size_t>(addend);
                        size_t newOffset = strSection->append(replacement);
                        relacc.set_entry(idx, static_cast<ELFIO::Elf64_Addr>(valuePos), symbol, rtype, static_cast<ELFIO::Elf_Sxword>(newOffset));
                        matched = true;
                        deadStrings.push_back({ strSection, deadOffset, expected.size() });
                        DEBUG("DwarfPatcher: patched %s relocation addend 0x%zx -> 0x%zx", loc.isName ? "DW_AT_name" : "DW_AT_comp_dir", addend, newOffset);
                    }
                }
            }
        } else {
            // Patch the string offset value in place (REL addend, or a linked file).
            // Validate by comparing the string actually referenced rather than the
            // first copy of it in the section: the compiler may emit the same text
            // more than once, in which case the referenced copy is not oldOffset.
            size_t currentOffset = 0;
            if (owningBuf->readOffset(valuePos, loc.offsetSize, currentOffset) && currentOffset < strSection->data.size()) {
                const char *currentStr = reinterpret_cast<const char *>(strSection->data.data() + currentOffset);
                if (strcmp(currentStr, expected.c_str()) == 0) {
                    size_t newOffset = strSection->append(replacement);
                    owningBuf->writeOffset(valuePos, loc.offsetSize, newOffset);
                    matched = true;
                    deadStrings.push_back({ strSection, currentOffset, expected.size() });
                    DEBUG("DwarfPatcher: patched %s offset 0x%zx -> 0x%zx", loc.isName ? "DW_AT_name" : "DW_AT_comp_dir", currentOffset, newOffset);
                }
            }
        }

        if (matched)
            patched = true;
    }

    if (!patched) {
        DEBUG("DwarfPatcher: no matching strings found to patch in %s", objectFile.c_str());
        return true;
    }

    // Erase the strings that were just orphaned, so the chroot path no longer
    // appears in the object at all. Skipped unless the string section is
    // addressed purely by relocations, because in a file that references it
    // with plain in-section offsets those references cannot be enumerated here
    // and a live string could be destroyed.
    for (const auto &dead : deadStrings) {
        if (!dead.section || !dead.section->sec)
            continue;

        std::vector<size_t> refs;
        collectStringRefs(elf, dead.section->sec->get_index(), refs);
        if (refs.empty()) {
            DEBUG("DwarfPatcher: not blanking 0x%zx, %s has no relocation references to verify against",
                  dead.offset, dead.section->sec->get_name().c_str());
            continue;
        }

        if (rangeIsReferenced(refs, dead.offset, dead.length)) {
            DEBUG("DwarfPatcher: not blanking 0x%zx (%zu bytes), still referenced", dead.offset, dead.length);
            continue;
        }

        dead.section->blank(dead.offset, dead.length);
        DEBUG("DwarfPatcher: blanked orphaned string at 0x%zx (%zu bytes)", dead.offset, dead.length);
    }

    // Write back sections that were actually modified. Compressed sections are
    // recompressed; untouched ones are left alone (never recompress blindly).
    infoBuf.save(elfClass);
    strOffsetsBuf.save(elfClass);
    strBuf.save(elfClass);
    lineStrBuf.save(elfClass);

    if (!elf.save(objectFile)) {
        ERROR("DwarfPatcher: failed to save patched ELF: %s", objectFile.c_str());
        return false;
    }

    DEBUG("DwarfPatcher: patched source path in %s: %s -> %s", objectFile.c_str(), oldSourcePath.c_str(), newSourcePath.c_str());
    return true;
}
