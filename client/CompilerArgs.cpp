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

#include "CompilerArgs.h"
#include "Log.h"
#include "Client.h"
#include <string.h>

struct OptionArg {
    const char *name;
    size_t args;
    bool operator<(const OptionArg &other) const { return strcmp(name, other.name) < 0; }
};

static const OptionArg argOptions[] = {
    { "--CLASSPATH", 1 },
    { "--assert", 1 },
    { "--bootclasspath", 1 },
    { "--classpath", 1 },
    { "--config", 1 },
    { "--define-macro", 1 },
    { "--dyld-prefix", 1 },
    { "--encoding", 1 },
    { "--extdirs", 1 },
    { "--for-linker", 1 },
    { "--force-link", 1 },
    { "--include-directory", 1 },
    { "--include-directory-after", 1 },
    { "--include-prefix", 1 },
    { "--include-with-prefix", 1 },
    { "--include-with-prefix-after", 1 },
    { "--include-with-prefix-before", 1 },
    { "--language", 1 },
    { "--library-directory", 1 },
    { "--mhwdiv", 1 },
    { "--output", 1 },
    { "--output-class-directory", 1 },
    { "--param", 1 },
    { "--prefix", 1 },
    { "--print-file-name", 1 },
    { "--print-prog-name", 1 },
    { "--resource", 1 },
    { "--rtlib", 1 },
    { "--serialize-diagnostics", 1 },
    { "--std", 1 },
    { "--stdlib", 1 },
    { "--sysroot", 1 },
    { "--system-header-prefix", 1 },
    { "--undefine-macro", 1 },
    { "-Xanalyzer", 1 },
    { "-Xassembler", 1 },
    { "-Xclang", 1 },
    { "-Xcuda-fatbinary", 1 },
    { "-Xcuda-ptxas", 1 },
    { "-Xlinker", 1 },
    { "-Xopenmp-target", 1 },
    { "-Xpreprocessor", 1 },
    { "-allowable_client", 1 },
    { "-arch", 1 },
    { "-arch_only", 1 },
    { "-arcmt-migrate-report-output", 1 },
    { "-bundle_loader", 1 },
    { "-dependency-dot", 1 },
    { "-dependency-file", 1 },
    { "-dylib_file", 1 },
    { "-exported_symbols_list", 1 },
    { "-filelist", 1 },
    { "-fmodule-implementation-of", 1 },
    { "-fmodule-name", 1 },
    { "-fmodules-user-build-path", 1 },
    { "-fnew-alignment", 1 },
    { "-force_load", 1 },
    { "-framework", 1 },
    { "-frewrite-map-file", 1 },
    { "-ftrapv-handler", 1 },
    { "-gcc-toolchain", 1 },
    { "-image_base", 1 },
    { "-imultilib", 1 },
    { "-include", 1 },
    { "-include-pch", 1 },
    { "-init", 1 },
    { "-install_name", 1 },
    { "-lazy_framework", 1 },
    { "-lazy_library", 1 },
    { "-meabi", 1 },
    { "-mllvm", 1 },
    { "-module-dependency-dir", 1 },
    { "-mthread-model", 1 },
    { "-multiply_defined", 1 },
    { "-multiply_defined_unused", 1 },
    { "-o", 1 },
    { "-read_only_relocs", 1 },
    { "-rpath", 1 },
    { "-sectalign", 3 },
    { "-sectcreate", 3 },
    { "-sectobjectsymbols", 2 },
    { "-sectorder", 3 },
    { "-seg_addr_table", 1 },
    { "-seg_addr_table_filename", 1 },
    { "-segaddr", 2 },
    { "-segcreate", 3 },
    { "-segprot", 3 },
    { "-segs_read_only_addr", 1 },
    { "-segs_read_write_addr", 1 },
    { "-serialize-diagnostics", 1 },
    { "-target", 1 },
    { "-umbrella", 1 },
    { "-unexported_symbols_list", 1 },
    { "-weak_framework", 1 },
    { "-weak_library", 1 },
    { "-weak_reference_mismatches", 1 },
    { "-x", 1 },
    { "-z", 1 }
};

// { "-Xarch_<arg1> <arg2>", 1 },
// { "-Xarch_<arg1> <arg2>", 1 },
// { // -Xopenmp-target=<triple> 1 },
// { // -Xopenmp-target=<triple>, 1 },

static inline size_t hasArg(const std::string &arg)
{
    const OptionArg a { arg.c_str(), 1 };
    const size_t idx = std::lower_bound(argOptions, argOptions + (sizeof(argOptions) / sizeof(argOptions[0])), a) - argOptions;
    if (idx < sizeof(argOptions) / sizeof(argOptions[0])) {
        if (!strcmp(arg.c_str(), argOptions[idx].name)) {
            return argOptions[idx].args;
        }
    }
    return 0;
}

std::shared_ptr<CompilerArgs> CompilerArgs::create(const std::vector<std::string> &args)
{
    std::shared_ptr<CompilerArgs> ret(new CompilerArgs);
    ret->commandLine = args;
    ret->flags = None;
    ret->objectFileIndex = -1;
    bool hasDashC = false;
    bool hasArch = false;
    for (size_t i=1; i<args.size(); ++i) {
        const std::string &arg = args[i];
        if (arg.empty()) {
        } else if (arg == "-c") {
            hasDashC = true;
        } else if (arg == "-S") {
            DEBUG("-S, running local");
            return nullptr;
        } else if (arg == "-E") {
            DEBUG("-E, running local");
            return nullptr;
        } else if (arg == "-o") {
            if (i + 1 < args.size() && args[i + 1] == "-") {
                DEBUG("-o - This means different things for different compilers. Run local");
                return nullptr;
            }
            ret->flags |= HasDashO;
            ret->objectFileIndex = ++i;
        } else if (arg == "-m32") {
            ret->flags |= HasDashM32;
        } else if (arg == "-m64") {
            ret->flags |= HasDashM64;
        } else if (arg == "-MF") {
            ret->flags |= HasDashMF;
            ++i;
        } else if (arg == "-MD") {
            ret->flags |= HasDashMD;
        } else if (arg == "-MMD") {
            ret->flags |= HasDashMMD;
        } else if (arg == "-MT") {
            ret->flags |= HasDashMT;
            ++i;
        } else if (arg == "-M" || arg == "-MM" || !strncmp(arg.c_str(), "-B", 2)) {
            DEBUG("%s, running local", arg.c_str());
            return nullptr;
        } else if (!strncmp(arg.c_str(), "-Wa,", 4)) {
            // stolen from icecc
            const char *pos = arg.c_str() + 4;

            while ((pos = strstr(pos + 1, "-a"))) {
                pos += 2;

                while ((*pos >= 'a') && (*pos <= 'z')) {
                    pos++;
                }

                if (*pos == '=') {
                    DEBUG("Incompatible arg %s building local", arg.c_str());
                    return nullptr;
                }

                if (!*pos) {
                    break;
                }
            }

            /* Some weird build systems pass directly additional assembler files.
             * Example: -Wa,src/code16gcc.s
             * Need to handle it locally then. Search if the first part after -Wa, does not start with -
             */
            pos = arg.c_str() + 3;

            while (*pos) {
                if ((*pos == ',') || (*pos == ' ')) {
                    pos++;
                    continue;
                }

                if (*pos == '-') {
                    break;
                }

                DEBUG("Incompatible arg (2) %s building local", arg.c_str());
                return nullptr;
            }
        } else if (!strncmp(arg.c_str(), "-fdump", 6)
                   || arg == "-combine"
                   || arg == "-fprofile-arcs"
                   || arg == "-ftest-coverage"
                   || arg == "-frepo"
                   || arg == "-fprofile-generate"
                   || arg == "-fprofile-use"
                   || arg == "-save-temps"
                   || arg == "--save-temps"
                   || arg == "-fbranch-probabilities") {
            DEBUG("Profiling arg: %s. Run local", arg.c_str());
            return nullptr;
        } else if (arg == "-march=native" || arg == "-mcpu=native" || arg == "-mtune=native") {
            DEBUG("Local archicture optimizations: %s. Run local", arg.c_str());
            return nullptr;
        } else if (arg == "-fexec-charset" || arg == "-fwide-exec-charset" || arg == "-finput-charset") {
            DEBUG("build environment charset conversions: %s. Run local", arg.c_str());
            return nullptr;
        } else if (!strncmp(arg.c_str(), "-fplugin=", 9) || !strncmp(arg.c_str(), "-fsanitize-blacklist=", 21)) {
            DEBUG("Extra files: %s. Run local", arg.c_str());
            return nullptr;
        } else if (arg == "-Xclang") {
            if (++i < args.size() && args[i] == "-load") {
                DEBUG("Extra files: %s. Run local", arg.c_str());
                return nullptr;
            }
        } else if (arg == "-arch") {
            if (hasArch) {
                DEBUG("multiple -arch options, building locally");
                return nullptr;
            }
            hasArch = true;
            ++i;
        } else if (arg == "-x") {
            ret->flags |= HasDashX;
            if (++i == args.size())
                return std::shared_ptr<CompilerArgs>();
            const std::string lang = args.at(i);
            const CompilerArgs::Flag languages[] = {
                CPlusPlus,
                C,
                CPreprocessed,
                CPlusPlusPreprocessed,
                ObjectiveC,
                ObjectiveCPreprocessed,
                ObjectiveCPlusPlus,
                ObjectiveCPlusPlusPreprocessed,
                AssemblerWithCpp,
                Assembler
            };
            for (size_t j=0; j<sizeof(languages) / sizeof(languages[0]); ++j) {
                if (lang == CompilerArgs::languageName(languages[j])) {
                    ret->flags &= ~LanguageMask;
                    ret->flags |= languages[j];
                    // -x takes precedence
                    break;
                }
            }
        } else if (arg == "-include" || arg == "-include-pch") {
            // we may have to handle this differently, gcc apparently falls back
            // to not using the pch file if it can't be found. Icecream code is
            // extremely confusing.
            ++i;
        } else if (size_t count = hasArg(arg)) {
            i += count;
        } else if (arg[0] != '-') {
            ret->sourceFileIndex = i;
            if (!(ret->flags & LanguageMask)) {
                const size_t lastDot = arg.rfind('.');
                if (lastDot != std::string::npos) {
                    const char *ext = arg.c_str() + lastDot + 1;
                    // https://gcc.gnu.org/onlinedocs/gcc/Overall-Options.html
                    struct {
                        const char *suffix;
                        const Flag flag;
                    } static const suffixes[] = {
                        { "C", CPlusPlus },
                        { "cc", CPlusPlus },
                        { "cxx", CPlusPlus },
                        { "cpp", CPlusPlus },
                        { "cp", CPlusPlus },
                        { "CPP", CPlusPlus },
                        { "c++", CPlusPlus },
                        { "ii", CPlusPlusPreprocessed },
                        { "c", C },
                        { "i", CPreprocessed },
                        { "m", ObjectiveC },
                        { "mi", ObjectiveCPreprocessed },
                        { "M", ObjectiveCPlusPlus },
                        { "mm", ObjectiveCPlusPlus },
                        { "mii", ObjectiveCPlusPlusPreprocessed },
                        { "S", Assembler },
                        { "sx", Assembler },
                        { "s", AssemblerWithCpp },
                        { 0, None }
                    };
                    for (size_t i=0; suffixes[i].suffix; ++i) {
                        if (!strcmp(ext, suffixes[i].suffix)) {
                            ret->flags |= suffixes[i].flag;
                            break;
                        }
                    }
                }
            }
        } else if (arg == "-") {
            DEBUG("STDIN input, building local");
            return nullptr;
        }
    }

    if (!hasDashC) {
        DEBUG("link job, building local");
        return nullptr;
    }

// #warning need to handle color diagnostics
// #warning need to handle clang_get_default_target

    if (ret->flags & (AssemblerWithCpp|Assembler)) {
        DEBUG("Assembler, building local");
        return nullptr;
    }

    if (!(ret->flags & HasDashO)) {
        ret->commandLine.push_back("-o");
        ret->commandLine.push_back(ret->output());
        ret->flags |= HasDashO;
    }

    if (ret->flags & (HasDashMMD|HasDashMD) && !(ret->flags & HasDashMF)) {
        const std::string out = ret->output();
        std::string dfile = out.substr(0, out.find_last_of('.')) + ".d";
        ret->commandLine.push_back("-MF");
        ret->commandLine.push_back(std::move(dfile));
    }

    return ret;
}

const char *CompilerArgs::languageName(Flag flag, bool preprocessed)
{
    if (preprocessed) {
        const Flag preflag = preprocessedFlag(flag);
        if (preflag != None)
            flag = preflag;
    }
    switch (flag) {
    case CPlusPlus: return "c++";
    case C: return "c";
    case CPreprocessed: return "cpp-output";
    case CPlusPlusPreprocessed: return "c++-cpp-output";
    case ObjectiveC: return "objective-c";
    case ObjectiveCPreprocessed: return "objective-c-cpp-output";
    case ObjectiveCPlusPlus: return "objective-c++";
    case ObjectiveCPlusPlusPreprocessed: return "objective-c++-cpp-output";
    case AssemblerWithCpp: return "assembler-with-cpp";
    case Assembler: return "assembler";
    default: break;
    }
    return "";
}
