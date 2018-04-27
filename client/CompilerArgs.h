#ifndef CompilerArgs_h
#define CompilerArgs_h

/* This file is part of Plast.

   Plast is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   Plast is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with Plast.  If not, see <http://www.gnu.org/licenses/>. */

#include <vector>
#include <string>
#include <memory>
#include <cstdint>
#include <assert.h>

struct CompilerArgs
{
    std::vector<std::string> commandLine;
    std::vector<size_t> sourceFileIndexes;
    size_t objectFileIndex { std::string::npos };
    std::vector<std::string> sourceFiles() const
    {
        std::vector<std::string> ret;
        ret.reserve(sourceFileIndexes.size());
        for (size_t idx : sourceFileIndexes) {
            ret.push_back(commandLine.at(idx));
        }
        return ret;
    }

    enum Mode {
        Invalid,
        Compile,
        Preprocess,
        Link
    } mode { Invalid };

    static const char *modeName(Mode mode)
    {
        switch (mode) {
        case Invalid: return "Invalid";
        case Compile: return "compile";
        case Preprocess: return "preprocess";
        case Link: return "link";
        }
        return "";
    }
    const char *modeName() const
    {
        return modeName(mode);
    }

    enum Flag {
        None = 0x00000,
        NoAssemble = 0x00001,
        MultiSource = 0x00002,
        HasDashO = 0x00004,
        HasDashX = 0x00008,
        HasDashMF = 0x00010,
        HasDashMMD = 0x00020,
        HasDashMT = 0x00040,
        HasDashM32 = 0x00080,
        HasDashM64 = 0x00100,
        StdinInput = 0x00200,
        // Languages
        CPlusPlus = 0x001000,
        C = 0x002000,
        CPreprocessed = 0x004000,
        CPlusPlusPreprocessed = 0x008000,
        ObjectiveC = 0x010000,
        ObjectiveCPreprocessed = 0x20000,
        ObjectiveCPlusPlus = 0x040000,
        ObjectiveCPlusPlusPreprocessed = 0x080000,
        AssemblerWithCpp = 0x100000,
        Assembler = 0x200000,
        LanguageMask = CPlusPlus|C|CPreprocessed|CPlusPlusPreprocessed|ObjectiveC|ObjectiveCPreprocessed|ObjectiveCPlusPlus|ObjectiveCPlusPlusPreprocessed|AssemblerWithCpp|Assembler
    };
    static Flag preprocessedFlag(Flag);
    static const char *languageName(Flag flag, bool preprocessed = false);
    uint32_t flags { 0 };

    static std::shared_ptr<CompilerArgs> create(const std::vector<std::string> &args);

    std::string sourceFile(size_t idx = 0) const
    {
        if (idx < sourceFileIndexes.size())
            return commandLine.at(sourceFileIndexes.at(idx));
        return std::string();
    }

    std::string output() const
    {
        if (flags & HasDashO) {
            assert(objectFileIndex != std::string::npos);
            return commandLine.at(objectFileIndex);
        } else {
            std::string source = sourceFile();
            const size_t lastDot = source.rfind('.');
            if (lastDot != std::string::npos && lastDot > source.rfind('/')) {
                source.resize(lastDot - 1); // ### is this right?
            }
            source.push_back('o');
            return source;
        }
    }
};

inline CompilerArgs::Flag CompilerArgs::preprocessedFlag(Flag flag)
{
    switch (flag) {
    case C:
        return CPreprocessed;
    case CPlusPlus:
        return CPlusPlusPreprocessed;
    default:
        break;
    }
    return None;
}

#if 0
inline Serializer &operator<<(Serializer &serializer, const CompilerArgs &args)
{
    serializer << args.commandLine << args.sourceFileIndexes << args.objectFileIndex
               << static_cast<uint8_t>(args.mode) << static_cast<uint32_t>(args.flags);
    return serializer;
}

inline Deserializer &operator>>(Deserializer &deserializer, CompilerArgs &args)
{
    uint8_t mode;
    deserializer >> args.commandLine >> args.sourceFileIndexes >> args.objectFileIndex >> mode >> args.flags;
    args.mode = static_cast<CompilerArgs::Mode>(mode);
    return deserializer;
}
#endif

#endif
