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
    bool md5;
    bool operator<(const OptionArg &other) const { return strcmp(name, other.name) < 0; }
};

static const OptionArg argOptions[] = {
    { "--CLASSPATH", 1, true },
    { "--assert", 1, true },
    { "--bootclasspath", 1, true },
    { "--classpath", 1, true },
    { "--config", 1, true },
    { "--define-macro", 1, true },
    { "--dyld-prefix", 1, true },
    { "--encoding", 1, true },
    { "--extdirs", 1, true },
    { "--for-linker", 1, true },
    { "--force-link", 1, true },
    { "--include-directory", 1, true },
    { "--include-directory-after", 1, true },
    { "--include-prefix", 1, true },
    { "--include-with-prefix", 1, true },
    { "--include-with-prefix-after", 1, true },
    { "--include-with-prefix-before", 1, true },
    { "--language", 1, true },
    { "--library-directory", 1, true },
    { "--mhwdiv", 1, true },
    { "--output", 1, true },
    { "--output-class-directory", 1, true },
    { "--param", 1, true },
    { "--prefix", 1, true },
    { "--print-file-name", 1, true },
    { "--print-prog-name", 1, true },
    { "--resource", 1, true },
    { "--rtlib", 1, true },
    { "--serialize-diagnostics", 1, true },
    { "--std", 1, true },
    { "--stdlib", 1, true },
    { "--sysroot", 1, true },
    { "--system-header-prefix", 1, true },
    { "--undefine-macro", 1, true },
    { "-I", 1, false },
    { "-Xanalyzer", 1, true },
    { "-Xassembler", 1, true },
    { "-Xclang", 1, true },
    { "-Xcuda-fatbinary", 1, true },
    { "-Xcuda-ptxas", 1, true },
    { "-Xlinker", 1, true },
    { "-Xopenmp-target", 1, true },
    { "-Xpreprocessor", 1, true },
    { "-allowable_client", 1, true },
    { "-arch", 1, true },
    { "-arch_only", 1, true },
    { "-arcmt-migrate-report-output", 1, true },
    { "-bundle_loader", 1, true },
    { "-cxx-isystem", 1, false },
    { "-dependency-dot", 1, true },
    { "-dependency-file", 1, true },
    { "-dylib_file", 1, true },
    { "-exported_symbols_list", 1, true },
    { "-filelist", 1, true },
    { "-fmodule-implementation-of", 1, true },
    { "-fmodule-name", 1, true },
    { "-fmodules-user-build-path", 1, true },
    { "-fnew-alignment", 1, true },
    { "-force_load", 1, true },
    { "-framework", 1, true },
    { "-frewrite-map-file", 1, true },
    { "-ftrapv-handler", 1, true },
    { "-gcc-toolchain", 1, true },
    { "-image_base", 1, true },
    { "-imultilib", 1, true },
    { "-include", 1, true },
    { "-include-pch", 1, true },
    { "-init", 1, true },
    { "-install_name", 1, true },
    { "-isysroot", 1, true },
    { "-isystem", 1, false },
    { "-lazy_framework", 1, true },
    { "-lazy_library", 1, true },
    { "-meabi", 1, true },
    { "-mllvm", 1, true },
    { "-module-dependency-dir", 1, true },
    { "-mthread-model", 1, true },
    { "-multiply_defined", 1, true },
    { "-multiply_defined_unused", 1, true },
    { "-o", 1, true },
    { "-read_only_relocs", 1, true },
    { "-rpath", 1, true },
    { "-sectalign", 3, true },
    { "-sectcreate", 3, true },
    { "-sectobjectsymbols", 2, true },
    { "-sectorder", 3, true },
    { "-seg_addr_table", 1, true },
    { "-seg_addr_table_filename", 1, true },
    { "-segaddr", 2, true },
    { "-segcreate", 3, true },
    { "-segprot", 3, true },
    { "-segs_read_only_addr", 1, true },
    { "-segs_read_write_addr", 1, true },
    { "-serialize-diagnostics", 1, true },
    { "-target", 1, true },
    { "-umbrella", 1, true },
    { "-unexported_symbols_list", 1, true },
    { "-weak_framework", 1, true },
    { "-weak_library", 1, true },
    { "-weak_reference_mismatches", 1, true },
    { "-x", 1, true },
    { "-z", 1 }
};

// { "-Xarch_<arg1> <arg2>", 1, true },
// { "-Xarch_<arg1> <arg2>", 1, true },
// { // -Xopenmp-target=<triple> 1, true },
// { // -Xopenmp-target=<triple>, 1, true },

static inline size_t hasArg(const std::string &arg, bool &md5)
{
    const OptionArg a { arg.c_str(), 1 };
    const size_t idx = std::lower_bound(argOptions, argOptions + (sizeof(argOptions) / sizeof(argOptions[0])), a) - argOptions;
    if (idx < sizeof(argOptions) / sizeof(argOptions[0])) {
        if (!strcmp(arg.c_str(), argOptions[idx].name)) {
            md5 = argOptions[idx].md5;
            return argOptions[idx].args;
        }
    }
    return 0;
}

std::shared_ptr<CompilerArgs> CompilerArgs::create(const std::vector<std::string> &args, LocalReason *localReason)
{
    const bool objectCache = Config::objectCache;
    std::shared_ptr<CompilerArgs> ret(new CompilerArgs);
    ret->commandLine = args;
    ret->flags = None;
    ret->objectFileIndex = -1;
    bool hasDashC = false;
    bool hasArch = false;
    if (Log::minLogLevel <= Log::Verbose) {
        for (size_t i=0; i<args.size(); ++i) {
            VERBOSE("%zu/%zu: %s", i+1, args.size(), args[i].c_str());
        }
    }

    for (size_t i=1; i<args.size(); ++i) {
        bool md5 = true;
        const std::string &arg = args[i];
        if (arg.empty()) {
        } else if (arg == "-c") {
            hasDashC = true;
        } else if (arg == "-S") {
            DEBUG("-S, running local");
            *localReason = Local_DoNotAssemble;
            return nullptr;
        } else if (arg == "-E") {
            DEBUG("-E, running local");
            *localReason = Local_Preprocess;
            return nullptr;
        } else if (arg == "-o") {
            if (i + 1 < args.size() && args[i + 1] == "-") {
                DEBUG("-o - This means different things for different compilers. Run local");
                *localReason = Local_StdOutOutput;
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
            *localReason = Local_Preprocess;
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
                    *localReason = Local_ParseError;
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
                *localReason = Local_ParseError;
                return nullptr;
            }
        } else if (arg == "-march=native" || arg == "-mcpu=native" || arg == "-mtune=native") {
            DEBUG("Local archicture optimizations: %s. Run local", arg.c_str());
            *localReason = Local_NativeArch;
            return nullptr;
        } else if (arg == "-fexec-charset" || arg == "-fwide-exec-charset" || arg == "-finput-charset") {
            DEBUG("build environment charset conversions: %s. Run local", arg.c_str());
            *localReason = Local_Charset;
            return nullptr;
        } else if (!strncmp(arg.c_str(), "-fplugin=", 9) || !strncmp(arg.c_str(), "-fsanitize-blacklist=", 21)) {
            DEBUG("Extra files: %s. Run local", arg.c_str());
            *localReason = Local_ExtraFiles;
            return nullptr;
        } else if (arg == "-Xclang") {
            if (++i < args.size() && args[i] == "-load") {
                DEBUG("Extra files: %s. Run local", arg.c_str());
                *localReason = Local_ExtraFiles;
                return nullptr;
            }
        } else if (arg == "-arch") {
            if (hasArch) {
                DEBUG("multiple -arch options, building locally");
                *localReason = Local_MultiArch;
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
        } else if (size_t count = hasArg(arg, md5)) {
            i += count;
        } else if (!strncmp("-I", arg.c_str(), 2)) {
            md5 = false;
        } else if (arg[0] != '-') {
            if (ret->sourceFileIndex != std::numeric_limits<size_t>::max()) {
                if (!hasDashC) {
                    while (i < args.size()) {
                        if (args[i] == "-c") {
                            hasDashC = true;
                            break;
                        }
                        ++i;
                    }
                }
                if (!hasDashC) {
                    DEBUG("link job, building local");
                    *localReason = Local_Link;
                } else {
                    DEBUG("Multiple source files %s and %s", args[ret->sourceFileIndex].c_str(), arg.c_str());
                    *localReason = Local_MultiSource;
                }
                return nullptr;
            }
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
            md5 = false;
        } else if (arg == "-") {
            DEBUG("STDIN input, building local");
            *localReason = Local_StdinInput;
            return nullptr;
        }

        if (objectCache) {
            if (md5) {
                MD5_Update(&Client::data().md5, arg.c_str(), arg.size());
                VERBOSE("Md5'ing arg [%s]", arg.c_str());
            } else {
                VERBOSE("Not md5'ing arg [%s]", arg.c_str());
            }
        }
    }
    if (ret->sourceFileIndex == std::numeric_limits<size_t>::max()) {
        DEBUG("No src file, building local");
        *localReason = Local_NoSources;
        return nullptr;
    }

    if (!hasDashC) {
        *localReason = Local_Link;
        DEBUG("link job, building local");
        return nullptr;
    }

    // #warning need to handle clang_get_default_target

    if (ret->flags & (AssemblerWithCpp|Assembler)) {
        DEBUG("Assembler, building local");
        *localReason = Local_DoNotAssemble;
        return nullptr;
    }

    if (!(ret->flags & HasDashO)) {
        ret->commandLine.push_back("-o");
        std::string out = ret->output();
        if (objectCache) {
            MD5_Update(&Client::data().md5, "-o", 2);
            MD5_Update(&Client::data().md5, out.c_str(), out.size());
        }
        ret->commandLine.push_back(std::move(out));
        ret->flags |= HasDashO;
    }

    if (ret->flags & (HasDashMMD|HasDashMD) && !(ret->flags & HasDashMF)) {
        const std::string out = ret->output();
        ret->commandLine.push_back("-MF");
        std::string dfile = out.substr(0, out.find_last_of('.')) + ".d";
        if (objectCache) {
            MD5_Update(&Client::data().md5, "-MF", 2);
            MD5_Update(&Client::data().md5, dfile.c_str(), dfile.size());
        }
        ret->commandLine.push_back(std::move(dfile));
    }
    *localReason = Remote;
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

const char *CompilerArgs::localReasonToString(LocalReason reason)
{
    switch (reason) {
    case Remote: return "Remote";
    case Local_Preprocess: return "Preprocess";
    case Local_DoNotAssemble: return "DoNotAssemble";
    case Local_StdOutOutput: return "StdOutOutput";
    case Local_ParseError: return "ParseError";
    case Local_NativeArch: return "NativeArch";
    case Local_Charset: return "Charset";
    case Local_ExtraFiles: return "ExtraFiles";
    case Local_MultiArch: return "MultiArch";
    case Local_MultiSource: return "MultiSource";
    case Local_StdinInput: return "StdinInput";
    case Local_NoSources: return "NoSources";
    case Local_Link: return "Link";
    }
    abort();
    return 0;
}
