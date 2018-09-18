#ifndef CompilerArgs_h
#define CompilerArgs_h

/* This file is part of Fisk.

   Fisk is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   Fisk is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with Fisk.  If not, see <http://www.gnu.org/licenses/>. */

#include <vector>
#include <string>
#include <memory>
#include <cstdint>
#include <assert.h>
#include <limits>

struct CompilerArgs
{
    std::vector<std::string> commandLine;
    size_t sourceFileIndex { std::numeric_limits<size_t>::max() };
    size_t objectFileIndex { std::numeric_limits<size_t>::max() };

    enum Flag {
        None = 0x000000,
        MultiSource = 0x000001,
        HasDashO = 0x000002,
        HasDashX = 0x000004,
        HasDashMF = 0x000008,
        HasDashMMD = 0x000010,
        HasDashMD = 0x000020,
        HasDashMT = 0x000040,
        HasDashM32 = 0x000080,
        HasDashM64 = 0x000100,
        // Languages
        CPlusPlus = 0x0010000,
        C = 0x0020000,
        CPreprocessed = 0x0040000,
        CPlusPlusPreprocessed = 0x0080000,
        ObjectiveC = 0x0100000,
        ObjectiveCPreprocessed = 0x0200000,
        ObjectiveCPlusPlus = 0x0400000,
        ObjectiveCPlusPlusPreprocessed = 0x0800000,
        AssemblerWithCpp = 0x01000000,
        Assembler = 0x02000000,
        LanguageMask = CPlusPlus|C|CPreprocessed|CPlusPlusPreprocessed|ObjectiveC|ObjectiveCPreprocessed|ObjectiveCPlusPlus|ObjectiveCPlusPlusPreprocessed|AssemblerWithCpp|Assembler
    };
    static Flag preprocessedFlag(Flag);
    static const char *languageName(Flag flag, bool preprocessed = false);
    uint32_t flags { 0 };

    static std::shared_ptr<CompilerArgs> create(const std::vector<std::string> &args);

    std::string sourceFile() const
    {
        assert(sourceFileIndex != std::numeric_limits<size_t>::max());
        return commandLine.at(sourceFileIndex);
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

#endif
