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
    bool sha1;
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
    { "-z", 1, true }
};

// { "-Xarch_<arg1> <arg2>", 1, true },
// { "-Xarch_<arg1> <arg2>", 1, true },
// { // -Xopenmp-target=<triple> 1, true },
// { // -Xopenmp-target=<triple>, 1, true },

static inline size_t hasArg(const std::string &arg, bool &sha1)
{
    const OptionArg a { arg.c_str(), 1, false };
    const size_t idx = std::lower_bound(argOptions, argOptions + (sizeof(argOptions) / sizeof(argOptions[0])), a) - argOptions;
    if (idx < sizeof(argOptions) / sizeof(argOptions[0])) {
        if (!strcmp(arg.c_str(), argOptions[idx].name)) {
            sha1 = argOptions[idx].sha1;
            return argOptions[idx].args;
        }
    }
    return 0;
}

std::shared_ptr<CompilerArgs> CompilerArgs::create(const Client::CompilerInfo &info,
                                                   std::vector<std::string> &&arguments,
                                                   LocalReason *localReason)
{
    const bool objectCache = Config::objectCache;
    std::shared_ptr<CompilerArgs> ret(new CompilerArgs);
    ret->commandLine = std::move(arguments);
    ret->flags = None;
    ret->objectFileIndex = -1;
    bool hasDashC = false;
    std::string hasArch;
    bool hasProfileDir = false;
    bool hasProfiling = false;
    const bool hasJSONDiagnostics = ((Config::jsonDiagnostics || Config::jsonDiagnosticsRaw)
                                     && info.type == Client::CompilerType::GCC
                                     && info.version.major >= 10);

    size_t i;
    if (Log::minLogLevel <= Log::Verbose || !Config::color || hasJSONDiagnostics) {
        i = 0;
        while (i < ret->commandLine.size()) {
            std::string &arg = ret->commandLine[i];
            VERBOSE("%zu/%zu: %s", i+1, ret->commandLine.size(), arg.c_str());
            if (!Config::color) {
                if (arg == "-fcolor-diagnostics") {
                    arg = "-fno-color-diagnostics";
                } else if (arg == "-fdiagnostics-color=always" || arg == "-fdiagnostics-color=auto") {
                    arg = "-fdiagnostics-color=never";
                }
            }

            if (hasJSONDiagnostics && arg == "-fdiagnostics-parseable-fixits") {
                ret->commandLine.erase(ret->commandLine.begin() + i);
            } else {
                ++i;
            }
        }
    }

    auto sha1 = [&i, &ret, objectCache](size_t count = 1) {
        if (objectCache) {
            for (size_t aa = i; aa < i + count; ++aa) {
                const std::string &arg = ret->commandLine[aa];
                VERBOSE("SHA1'ing arg %zu [%s]", aa, arg.c_str());
                Client::data().sha1Update(arg.c_str(), arg.size());
            }
        }
    };

    for (i=1; i<ret->commandLine.size(); ++i) {
        const std::string &arg = ret->commandLine[i];

        if (arg == "-S") {
            DEBUG("-S, running local");
            *localReason = Local_DoNotAssemble;
            return nullptr;
        }

        if (arg == "-E") {
            DEBUG("-E, running local");
            *localReason = Local_Preprocess;
            return nullptr;
        }

        if (arg == "-fno-integrated-as") {
            DEBUG("-fno-integrated-as, running local");
            *localReason = Local_NoIntegratedAs;
            return nullptr;
        }

        if (arg == "-M" || arg == "-MM") {
            DEBUG("%s, running local", arg.c_str());
            *localReason = Local_Preprocess;
            return nullptr;
        }

        if (!strncmp(arg.c_str(), "-B", 2)) {
            DEBUG("%s, running local", arg.c_str());
            *localReason = Local_BinPath;
            return nullptr;
        }

        if (arg == "-march=native" || arg == "-mcpu=native" || arg == "-mtune=native") {
            DEBUG("Local archicture optimizations: %s. Run local", arg.c_str());
            *localReason = Local_NativeArch;
            return nullptr;
        }

        if (arg == "-fexec-charset" || arg == "-fwide-exec-charset" || arg == "-finput-charset") {
            DEBUG("build environment charset conversions: %s. Run local", arg.c_str());
            *localReason = Local_Charset;
            return nullptr;
        }

        if (!strncmp(arg.c_str(), "-fplugin=", 9) || !strncmp(arg.c_str(), "-fsanitize-blacklist=", 21)) {
            DEBUG("Extra files: %s. Run local", arg.c_str());
            *localReason = Local_ExtraFiles;
            return nullptr;
        }

        if (arg == "-") {
            DEBUG("STDIN input, building local");
            *localReason = Local_StdinInput;
            return nullptr;
        }

        if (arg == "-c") {
            hasDashC = true;
            sha1();
            continue;
        }


        if (arg == "-o") {
            if (i + 1 < ret->commandLine.size() && ret->commandLine[i + 1] == "-") {
                DEBUG("-o - This means different things for different compilers. Run local");
                *localReason = Local_StdOutOutput;
                return nullptr;
            }
            ret->flags |= HasDashO;
            ret->objectFileIndex = i + 1;
            sha1(2);
            ++i;
            continue;
        }

        if (!strncmp(arg.c_str(), "-fprofile-dir=", 14)) {
            hasProfileDir = true;
            sha1();
            continue;
        }

        if (arg == "-ftest-coverage" || arg == "-fprofile-arcs") {
            hasProfiling = true;
            sha1();
            continue;
        }

        if (arg == "-m32") {
            ret->flags |= HasDashM32;
            sha1();
            continue;
        }

        if (arg == "-m64") {
            ret->flags |= HasDashM64;
            sha1();
            continue;
        }

        if (arg == "-MF") {
            ret->flags |= HasDashMF;
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-MD") {
            ret->flags |= HasDashMD;
            sha1();
            continue;
        }

        if (arg == "-MMD") {
            ret->flags |= HasDashMMD;
            sha1();
            continue;
        }

        if (arg == "-MT") {
            ret->flags |= HasDashMT;
            sha1(2);
            ++i;
            continue;
        }

        if (!strncmp(arg.c_str(), "-Wa,", 4)) {
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
            continue;
        }

        if (arg == "-Xclang") {
            if (i + 1 < ret->commandLine.size() && ret->commandLine[i] == "-load") {
                DEBUG("Extra files: %s. Run local", arg.c_str());
                *localReason = Local_ExtraFiles;
                return nullptr;
            }
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-arch") {
            const std::string arch = ret->commandLine[i + 1];
            if (!hasArch.empty() && hasArch != arch) {
                DEBUG("multiple -arch options, building locally");
                *localReason = Local_MultiArch;
                return nullptr;
            }
            hasArch = arch;
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-x") {
            ret->flags |= HasDashX;
            if (i + 1 == ret->commandLine.size())
                return std::shared_ptr<CompilerArgs>();
            const std::string lang = ret->commandLine.at(i);
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
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-include" || arg == "-include-pch") {
            // we may have to handle this differently, gcc apparently falls back
            // to not using the pch file if it can't be found. Icecream code is
            // extremely confusing.
            sha1(2);
            ++i;
            continue;
        }

        {
            bool needSHA1 = false;
            if (size_t count = hasArg(arg, needSHA1)) {
                if (needSHA1)
                    sha1(count + 1);
                i += count;
                continue;
            }
        }

        if (!strncmp("-I", arg.c_str(), 2)) {
            continue;
        }

        if (arg[0] != '-') {
            if (ret->sourceFileIndex != std::numeric_limits<size_t>::max()) {
                if (!hasDashC) {
                    while (i < ret->commandLine.size()) {
                        if (ret->commandLine[i] == "-c") {
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
                    DEBUG("Multiple source files %s and %s", ret->commandLine[ret->sourceFileIndex].c_str(), arg.c_str());
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
                        { nullptr, None }
                    };
                    for (size_t ii=0; suffixes[ii].suffix; ++ii) {
                        if (!strcmp(ext, suffixes[ii].suffix)) {
                            ret->flags |= suffixes[ii].flag;
                            break;
                        }
                    }
                }
            }

            size_t len = 0;
            const char *fn = Client::trimSourceRoot(arg, &len);
            Client::data().sha1Update(fn, len);
            VERBOSE("SHA1'ing arg %zu [%.*s]", i, static_cast<int>(len), fn);
            continue;
        }

        VERBOSE("Unhandled arg %s", arg.c_str());
        sha1();
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
            Client::data().sha1Update("-o", 2);
            Client::data().sha1Update(out.c_str(), out.size());
            VERBOSE("SHA1'ing arg [-o]");
            VERBOSE("SHA1'ing arg [%s]", out.c_str());
        }
        ret->commandLine.push_back(std::move(out));
        ret->flags |= HasDashO;
    }

    if (hasProfiling && !hasProfileDir) {
        std::string dir;
        Client::parsePath(ret->output(), nullptr, &dir);
        dir = Client::realpath(dir);
        if (objectCache) {
            Client::data().sha1Update("-fprofile-dir=", 14);
            Client::data().sha1Update(dir.c_str(), dir.size());
            VERBOSE("SHA1'ing arg [-fprofile-dir=%s]", dir.c_str());
        }
        ret->commandLine.push_back("-fprofile-dir=" + dir);
    }

    if (ret->flags & (HasDashMMD|HasDashMD) && !(ret->flags & HasDashMF)) {
        const std::string out = ret->output();
        ret->commandLine.push_back("-MF");
        std::string dfile = out.substr(0, out.find_last_of('.')) + ".d";
        if (objectCache) {
            Client::data().sha1Update("-MF", 2);
            Client::data().sha1Update(dfile.c_str(), dfile.size());
            VERBOSE("SHA1'ing arg [-MF]");
            VERBOSE("SHA1'ing arg [%s]", dfile.c_str());
        }
        ret->commandLine.push_back(std::move(dfile));
    }

    if (hasJSONDiagnostics) {
        std::string arg = "-fdiagnostics-format=json";
        Client::data().sha1Update(arg.c_str(), arg.size());
        VERBOSE("SHA1'ing arg [%s]", arg.c_str());
        ret->commandLine.push_back(std::move(arg));
    }

    if (info.type == Client::CompilerType::Clang && info.version.major >= 15) {
        const std::string arg = "-Wno-gnu-line-marker";
        VERBOSE("SHA1'ing arg [%s]", arg.c_str());
        Client::data().sha1Update(arg.c_str(), arg.size());
        ret->commandLine.push_back(std::move(arg));
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
    case Local_NoIntegratedAs: return "NoIntegratedAs";
    case Local_BinPath: return "BinPath";
    }
    assert(0);
    return nullptr;
}

std::string CompilerArgs::output() const
{
    if (flags & HasDashO) {
        assert(objectFileIndex != std::string::npos);
        return commandLine.at(objectFileIndex);
    } else {
        std::string source = sourceFile();
        std::string output;
        Client::parsePath(source, &output, nullptr);
        const size_t lastDot = output.rfind('.');
        if (lastDot != std::string::npos) {
            output.resize(lastDot);
        }
        output += ".o";
        return output;
    }
}
