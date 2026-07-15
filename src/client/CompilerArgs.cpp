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
#include "Client.h"
#include "Log.h"
#include <string.h>

enum OptionFlag
{
    None = 0x0,
    Sha1 = 0x1,
    SkipPreprocess = 0x2
};

struct OptionArg
{
    const char *name;
    size_t args;
    uint32_t flags;

    bool operator<(const OptionArg &other) const
    {
        return strcmp(name, other.name) < 0;
    }
};

static const OptionArg argOptions[] = { { "--CLASSPATH", 1, Sha1 },
                                        { "--assert", 1, Sha1 },
                                        { "--bootclasspath", 1, Sha1 },
                                        { "--classpath", 1, Sha1 },
                                        { "--config", 1, Sha1 },
                                        { "--coverage", 0, Sha1 | SkipPreprocess },
                                        { "--define-macro", 1, Sha1 },
                                        { "--dyld-prefix", 1, Sha1 },
                                        { "--encoding", 1, Sha1 },
                                        { "--extdirs", 1, Sha1 },
                                        { "--for-linker", 1, Sha1 | SkipPreprocess },
                                        { "--force-link", 1, Sha1 | SkipPreprocess },
                                        { "--include-directory", 1, None },
                                        { "--include-directory-after", 1, None },
                                        { "--include-prefix", 1, None },
                                        { "--include-with-prefix", 1, None },
                                        { "--include-with-prefix-after", 1, None },
                                        { "--include-with-prefix-before", 1, None },
                                        { "--language", 1, Sha1 },
                                        { "--library-directory", 1, Sha1 },
                                        { "--mhwdiv", 1, Sha1 },
                                        { "--output", 1, Sha1 },
                                        { "--output-class-directory", 1, Sha1 },
                                        { "--param", 1, Sha1 },
                                        { "--prefix", 1, Sha1 },
                                        { "--print-file-name", 1, Sha1 },
                                        { "--print-prog-name", 1, Sha1 },
                                        { "--resource", 1, None },
                                        { "--rtlib", 1, Sha1 },
                                        { "--serialize-diagnostics", 1, None },
                                        { "--std", 1, Sha1 },
                                        { "--stdlib", 1, Sha1 },
                                        { "--sysroot", 1, None },
                                        { "--system-header-prefix", 1, Sha1 },
                                        { "--undefine-macro", 1, Sha1 },
                                        { "-F", 1, None },
                                        { "-G", 1, Sha1 },
                                        { "-I", 1, None },
                                        { "-MQ", 1, Sha1 },
                                        { "-Xanalyzer", 1, Sha1 },
                                        { "-Xarch_device", 1, Sha1 },
                                        { "-Xarch_host", 1, Sha1 },
                                        { "-Xassembler", 1, Sha1 },
                                        { "-Xclang", 1, Sha1 },
                                        { "-Xclangas", 1, Sha1 },
                                        { "-Xcuda-fatbinary", 1, Sha1 },
                                        { "-Xcuda-ptxas", 1, Sha1 },
                                        { "-Xlinker", 1, Sha1 | SkipPreprocess },
                                        { "-Xopenmp-target", 1, Sha1 },
                                        { "-Xpreprocessor", 1, Sha1 },
                                        { "-alias_list", 1, None },
                                        { "-allowable_client", 1, Sha1 },
                                        { "-arch", 1, Sha1 },
                                        { "-arch_only", 1, Sha1 },
                                        { "-arcmt-migrate-report-output", 1, None },
                                        { "-aux-info", 1, None },
                                        { "-bundle_loader", 1, None },
                                        { "-c", 0, Sha1 | SkipPreprocess },
                                        { "-client_name", 1, Sha1 },
                                        { "-compatibility_version", 1, Sha1 },
                                        { "-current_version", 1, Sha1 },
                                        { "-cxx-isystem", 1, None },
                                        { "-darwin-target-variant", 1, Sha1 },
                                        { "-darwin-target-variant-triple", 1, Sha1 },
                                        { "-dependency-dot", 1, None },
                                        { "-dependency-file", 1, None },
                                        { "-dumpbase", 1, None },
                                        { "-dumpbase-ext", 1, Sha1 },
                                        { "-dumpdir", 1, None },
                                        { "-dylib_file", 1, None },
                                        { "-dylinker_install_name", 1, None },
                                        { "-exported_symbols_list", 1, None },
                                        { "-filelist", 1, None },
                                        { "-fmodule-implementation-of", 1, Sha1 },
                                        { "-fmodule-name", 1, Sha1 },
                                        { "-fmodules-user-build-path", 1, None },
                                        { "-fnew-alignment", 1, Sha1 },
                                        { "-force_load", 1, None },
                                        { "-fprofile-arcs", 0, Sha1 | SkipPreprocess },
                                        { "-framework", 1, Sha1 | SkipPreprocess },
                                        { "-frewrite-map-file", 1, None },
                                        { "-ftest-coverage", 0, Sha1 | SkipPreprocess },
                                        { "-ftrapv-handler", 1, Sha1 },
                                        { "-gcc-toolchain", 1, None },
                                        { "-idirafter", 1, None },
                                        { "-iframework", 1, None },
                                        { "-iframeworkwithsysroot", 1, None },
                                        { "-imacros", 1, None },
                                        { "-image_base", 1, Sha1 },
                                        { "-imultiarch", 1, None },
                                        { "-imultilib", 1, None },
                                        { "-include", 1, None },
                                        { "-include-pch", 1, None },
                                        { "-index-store-path", 1, None },
                                        { "-init", 1, Sha1 },
                                        { "-install_name", 1, Sha1 },
                                        { "-iprefix", 1, None },
                                        { "-iquote", 1, None },
                                        { "-isysroot", 1, None },
                                        { "-isystem", 1, None },
                                        { "-isystem-after", 1, None },
                                        { "-iwithprefix", 1, None },
                                        { "-iwithprefixbefore", 1, None },
                                        { "-iwithsysroot", 1, None },
                                        { "-lazy_framework", 1, Sha1 },
                                        { "-lazy_library", 1, Sha1 },
                                        { "-meabi", 1, Sha1 },
                                        { "-mllvm", 1, Sha1 },
                                        { "-mmlir", 1, Sha1 },
                                        { "-module-dependency-dir", 1, None },
                                        { "-mthread-model", 1, Sha1 },
                                        { "-multiply_defined", 1, Sha1 },
                                        { "-multiply_defined_unused", 1, Sha1 },
                                        { "-no-pie", 0, Sha1 | SkipPreprocess },
                                        { "-nodefaultlibs", 0, Sha1 | SkipPreprocess },
                                        { "-nostartfiles", 0, Sha1 | SkipPreprocess },
                                        { "-nostdlib", 0, Sha1 | SkipPreprocess },
                                        { "-o", 1, Sha1 | SkipPreprocess },
                                        { "-pagezero_size", 1, Sha1 },
                                        { "-pie", 0, Sha1 | SkipPreprocess },
                                        { "-rdynamic", 0, Sha1 | SkipPreprocess },
                                        { "-read_only_relocs", 1, Sha1 },
                                        { "-reexport_framework", 1, Sha1 },
                                        { "-resource-dir", 1, None },
                                        { "-rpath", 1, Sha1 },
                                        { "-s", 0, Sha1 | SkipPreprocess },
                                        { "-save-temps", 0, Sha1 | SkipPreprocess },
                                        { "-sectalign", 3, Sha1 },
                                        { "-sectcreate", 3, Sha1 },
                                        { "-sectobjectsymbols", 2, Sha1 },
                                        { "-sectorder", 3, Sha1 },
                                        { "-seg1addr", 1, Sha1 },
                                        { "-seg_addr_table", 1, Sha1 },
                                        { "-seg_addr_table_filename", 1, Sha1 },
                                        { "-segaddr", 2, Sha1 },
                                        { "-segcreate", 3, Sha1 },
                                        { "-segprot", 3, Sha1 },
                                        { "-segs_read_only_addr", 1, Sha1 },
                                        { "-segs_read_write_addr", 1, Sha1 },
                                        { "-serialize-diagnostics", 1, None },
                                        { "-shared", 0, Sha1 | SkipPreprocess },
                                        { "-shared-libgcc", 0, Sha1 | SkipPreprocess },
                                        { "-static", 0, Sha1 | SkipPreprocess },
                                        { "-static-libgcc", 0, Sha1 | SkipPreprocess },
                                        { "-static-libstdc++", 0, Sha1 | SkipPreprocess },
                                        { "-sub_library", 1, Sha1 },
                                        { "-sub_umbrella", 1, Sha1 },
                                        { "-target", 1, Sha1 },
                                        { "-u", 1, Sha1 | SkipPreprocess },
                                        { "-umbrella", 1, Sha1 },
                                        { "-undefined", 1, Sha1 },
                                        { "-unexported_symbols_list", 1, None },
                                        { "-weak_framework", 1, Sha1 },
                                        { "-weak_library", 1, Sha1 },
                                        { "-weak_reference_mismatches", 1, Sha1 },
                                        { "-working-directory", 1, None },
                                        { "-wrapper", 1, None },
                                        { "-x", 1, Sha1 },
                                        { "-z", 1, Sha1 } };

static inline const OptionArg *lookupOption(const std::string &arg)
{
    constexpr size_t count = sizeof(argOptions) / sizeof(argOptions[0]);
    const OptionArg key { arg.c_str(), 0, 0 };
    const OptionArg *end = argOptions + count;
    const OptionArg *it = std::lower_bound(argOptions, end, key);
    if (it != end && !strcmp(it->name, arg.c_str())) {
        return it;
    }
    return nullptr;
}

static inline size_t hasArg(const std::string &arg, bool &sha1)
{
    if (const OptionArg *o = lookupOption(arg)) {
        sha1 = o->flags & Sha1;
        return o->args;
    }
    return 0;
}

// Caller contract for the object-cache SHA1 chain (must not be reordered):
//   create() -> finalize(info) -> preprocess-driven sha1Update -> sha1Final.
// finalize() applies the compiler-info-gated arg tweaks and their sha1Update
// calls; running finalize() out of order corrupts the cache key.
std::shared_ptr<CompilerArgs> CompilerArgs::create(std::vector<std::string> &&arguments,
                                                   LocalReason *localReason)
{
    const bool objectCache = Config::objectCache;
    std::shared_ptr<CompilerArgs> ret = std::make_shared<CompilerArgs>();
    ret->commandLine = std::move(arguments);
    ret->flags = None;
    ret->objectFileIndex = -1;
    bool hasDashC = false;
    std::string hasArch;
    bool hasProfileDir = false;
    bool hasProfiling = false;

    size_t i;
    if (Log::minLogLevel <= Log::Verbose || !Config::color) {
        i = 0;
        while (i < ret->commandLine.size()) {
            std::string &arg = ret->commandLine[i];
            VERBOSE("%zu/%zu: %s", i + 1, ret->commandLine.size(), arg.c_str());
            if (!Config::color) {
                if (arg == "-fcolor-diagnostics") {
                    arg = "-fno-color-diagnostics";
                } else if (arg == "-fdiagnostics-color=always" || arg == "-fdiagnostics-color=auto") {
                    arg = "-fdiagnostics-color=never";
                }
            }
            ++i;
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

    for (i = 1; i < ret->commandLine.size(); ++i) {
        const std::string &arg = ret->commandLine[i];

        if (arg == "-S") {
            DEBUG("-S, running local");
            *localReason = Local_DoNotAssemble;
            ret.reset();
            goto end;
        }

        if (arg == "-E") {
            DEBUG("-E, running local");
            *localReason = Local_Preprocess;
            ret.reset();
            goto end;
        }

        if (arg == "-fno-integrated-as") {
            DEBUG("-fno-integrated-as, running local");
            *localReason = Local_NoIntegratedAs;
            ret.reset();
            goto end;
        }

        if (arg == "-M" || arg == "-MM") {
            DEBUG("%s, running local", arg.c_str());
            *localReason = Local_Preprocess;
            ret.reset();
            goto end;
        }

        if (!strncmp(arg.c_str(), "-B", 2)) {
            DEBUG("%s, running local", arg.c_str());
            *localReason = Local_BinPath;
            ret.reset();
            goto end;
        }

        if (arg == "-march=native" || arg == "-mcpu=native" || arg == "-mtune=native") {
            DEBUG("Local archicture optimizations: %s. Run local", arg.c_str());
            *localReason = Local_NativeArch;
            ret.reset();
            goto end;
        }

        if (arg == "-fexec-charset" || arg == "-fwide-exec-charset" || arg == "-finput-charset") {
            DEBUG("build environment charset conversions: %s. Run local", arg.c_str());
            *localReason = Local_Charset;
            ret.reset();
            goto end;
        }

        if (!strncmp(arg.c_str(), "-fplugin=", 9) || !strncmp(arg.c_str(), "-fsanitize-blacklist=", 21)) {
            DEBUG("Extra files: %s. Run local", arg.c_str());
            *localReason = Local_ExtraFiles;
            ret.reset();
            goto end;
        }

        if (arg == "-") {
            DEBUG("STDIN input, building local");
            *localReason = Local_StdinInput;
            ret.reset();
            goto end;
        }

        if (arg == "-c") {
            hasDashC = true;
            sha1();
            continue;
        }

        if (arg == "-o") {
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("-o without an argument, building local");
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
            if (ret->commandLine[i + 1] == "-") {
                DEBUG("-o - This means different things for different compilers. Run local");
                *localReason = Local_StdOutOutput;
                ret.reset();
                goto end;
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
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("-MF without an argument, building local");
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
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
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("-MT without an argument, building local");
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
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
                    ret.reset();
                    goto end;
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
                ret.reset();
                goto end;
            }
            continue;
        }

        if (arg == "-Xclang") {
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("-Xclang without an argument, building local");
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
            if (ret->commandLine[i + 1] == "-load") {
                DEBUG("Extra files: %s. Run local", arg.c_str());
                *localReason = Local_ExtraFiles;
                ret.reset();
                goto end;
            }
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-arch") {
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("-arch without an argument, building local");
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
            const std::string arch = ret->commandLine[i + 1];
            if (!hasArch.empty() && hasArch != arch) {
                DEBUG("multiple -arch options, building locally");
                *localReason = Local_MultiArch;
                ret.reset();
                goto end;
            }
            hasArch = arch;
            sha1(2);
            ++i;
            continue;
        }

        if (arg == "-x") {
            ret->flags |= HasDashX;
            if (i + 1 == ret->commandLine.size()) {
                ret.reset();
                goto end;
            }

            const std::string lang = ret->commandLine.at(i + 1);
            const CompilerArgs::Flag languages[] = { CPlusPlus, C, CPreprocessed, CPlusPlusPreprocessed, ObjectiveC, ObjectiveCPreprocessed, ObjectiveCPlusPlus, ObjectiveCPlusPlusPreprocessed, AssemblerWithCpp, Assembler };
            for (size_t j = 0; j < sizeof(languages) / sizeof(languages[0]); ++j) {
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
            if (i + 1 >= ret->commandLine.size()) {
                DEBUG("%s without an argument, building local", arg.c_str());
                *localReason = Local_ParseError;
                ret.reset();
                goto end;
            }
            sha1(2);
            ++i;
            continue;
        }

        {
            bool needSHA1 = false;
            if (size_t count = hasArg(arg, needSHA1)) {
                if (i + count >= ret->commandLine.size()) {
                    DEBUG("%s missing operand(s), building local", arg.c_str());
                    *localReason = Local_ParseError;
                    ret.reset();
                    goto end;
                }
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
                ret.reset();
                goto end;
            }
            ret->sourceFileIndex = i;
            if (!(ret->flags & LanguageMask)) {
                const size_t lastDot = arg.rfind('.');
                if (lastDot != std::string::npos) {
                    const char *ext = arg.c_str() + lastDot + 1;

                    // https://gcc.gnu.org/onlinedocs/gcc/Overall-Options.html
                    struct
                    {
                        const char *suffix;
                        const Flag flag;
                    } static const suffixes[] = { { "C", CPlusPlus },
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
                                                  { nullptr, None } };

                    for (size_t ii = 0; suffixes[ii].suffix; ++ii) {
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
        ret.reset();
        goto end;
    }

    // Check if this looks like a build system compile test
    {
        const std::string &src = ret->commandLine[ret->sourceFileIndex];
        std::string basename;
        Client::parsePath(src, &basename, nullptr);

        // autoconf/automake: conftest.c, conftest.cc, conftest.cpp, etc.
        if (basename.size() >= 10 && !strncmp(basename.c_str(), "conftest.", 9)) {
            DEBUG("Compile test (conftest): %s, building local", src.c_str());
            *localReason = Local_CompileTest;
            ret.reset();
            goto end;
        }

        // cmake compile tests: anything in CMakeFiles/ subdirectory
        if (src.find("/CMakeFiles/") != std::string::npos || !strncmp(src.c_str(), "CMakeFiles/", 11)) {
            DEBUG("Compile test (CMakeFiles): %s, building local", src.c_str());
            *localReason = Local_CompileTest;
            ret.reset();
            goto end;
        }
    }

    if (!hasDashC) {
        *localReason = Local_Link;
        DEBUG("link job, building local");
        ret.reset();
        goto end;
    }

    // #warning need to handle clang_get_default_target

    if (ret->flags & (AssemblerWithCpp | Assembler)) {
        DEBUG("Assembler, building local");
        *localReason = Local_DoNotAssemble;
        ret.reset();
        goto end;
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

    if (ret->flags & (HasDashMMD | HasDashMD) && !(ret->flags & HasDashMF)) {
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

    *localReason = Remote;

end:
    return ret;
}

void CompilerArgs::finalize(const Client::CompilerInfo &info)
{
    const bool hasJSONDiagnostics = ((Config::jsonDiagnostics || Config::jsonDiagnosticsRaw)
                                     && info.type == Client::CompilerType::GCC
                                     && info.version.major >= 10);

    if (hasJSONDiagnostics) {
        for (size_t i = 0; i < commandLine.size();) {
            if (commandLine[i] == "-fdiagnostics-parseable-fixits") {
                commandLine.erase(commandLine.begin() + i);
                if (sourceFileIndex != std::numeric_limits<size_t>::max() && sourceFileIndex > i) {
                    --sourceFileIndex;
                }
                if (objectFileIndex != std::numeric_limits<size_t>::max() && objectFileIndex > i) {
                    --objectFileIndex;
                }
            } else {
                ++i;
            }
        }

        std::string arg = "-fdiagnostics-format=json";
        Client::data().sha1Update(arg.c_str(), arg.size());
        VERBOSE("SHA1'ing arg [%s]", arg.c_str());
        commandLine.push_back(std::move(arg));
    }

    if (info.type == Client::CompilerType::Clang && info.version.major >= 15) {
        std::string arg = "-Wno-gnu-line-marker";
        VERBOSE("SHA1'ing arg [%s]", arg.c_str());
        Client::data().sha1Update(arg.c_str(), arg.size());
        commandLine.push_back(std::move(arg));
    }
}

const char *CompilerArgs::languageName(Flag flag, bool preprocessed)
{
    if (preprocessed) {
        const Flag preflag = preprocessedFlag(flag);
        if (preflag != None)
            flag = preflag;
    }
    switch (flag) {
        case CPlusPlus:
            return "c++";
        case C:
            return "c";
        case CPreprocessed:
            return "cpp-output";
        case CPlusPlusPreprocessed:
            return "c++-cpp-output";
        case ObjectiveC:
            return "objective-c";
        case ObjectiveCPreprocessed:
            return "objective-c-cpp-output";
        case ObjectiveCPlusPlus:
            return "objective-c++";
        case ObjectiveCPlusPlusPreprocessed:
            return "objective-c++-cpp-output";
        case AssemblerWithCpp:
            return "assembler-with-cpp";
        case Assembler:
            return "assembler";
        default:
            break;
    }
    return "";
}

const char *CompilerArgs::localReasonToString(LocalReason reason)
{
    switch (reason) {
        case Remote:
            return "Remote";
        case Local_Preprocess:
            return "Preprocess";
        case Local_DoNotAssemble:
            return "DoNotAssemble";
        case Local_StdOutOutput:
            return "StdOutOutput";
        case Local_ParseError:
            return "ParseError";
        case Local_NativeArch:
            return "NativeArch";
        case Local_Charset:
            return "Charset";
        case Local_ExtraFiles:
            return "ExtraFiles";
        case Local_MultiArch:
            return "MultiArch";
        case Local_MultiSource:
            return "MultiSource";
        case Local_StdinInput:
            return "StdinInput";
        case Local_NoSources:
            return "NoSources";
        case Local_Link:
            return "Link";
        case Local_NoIntegratedAs:
            return "NoIntegratedAs";
        case Local_BinPath:
            return "BinPath";
        case Local_CompileTest:
            return "CompileTest";
    }
    assert(0);
    return nullptr;
}

static bool skipForPreprocessPrefix(const std::string &arg)
{
    if (!strncmp(arg.c_str(), "-Wl,", 4))
        return true;
    if (!strncmp(arg.c_str(), "-fuse-ld=", 9))
        return true;
    if (!strncmp(arg.c_str(), "-save-temps=", 12))
        return true;
    if (arg.size() > 2 && arg[0] == '-' && (arg[1] == 'l' || arg[1] == 'L'))
        return true;
    return false;
}

std::string CompilerArgs::preprocessCommandLine(const std::string &compiler) const
{
    std::string ret = compiler;
    for (size_t i = 1; i < commandLine.size(); ++i) {
        const std::string &arg = commandLine[i];
        if (const OptionArg *o = lookupOption(arg); o && (o->flags & SkipPreprocess)) {
            i += std::min(o->args, commandLine.size() - i - 1);
            continue;
        }
        if (skipForPreprocessPrefix(arg)) {
            continue;
        }
        ret += " '";
        ret += arg;
        ret += '\'';
    }
    ret += " '-E'";
    if (Client::data().builderCompiler.find("clang") != std::string::npos) {
        ret += " '-frewrite-includes'";
    } else {
        ret += " '-fdirectives-only'";
    }
    if (!Config::discardComments) {
        ret += " '-C'";
    }
    return ret;
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
