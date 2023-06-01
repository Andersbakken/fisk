#include "Config.h"
#include "Client.h"
#include "Log.h"
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <thread>
#include <arpa/inet.h>
#include <sys/types.h>
#include <sys/file.h>

extern char **environ;

static json11::Json value(const std::vector<json11::Json> &jsons, const std::string &key)
{
    for (const json11::Json &json : jsons) {
        const json11::Json &value = json[key];
        if (!value.is_null()) {
            return value;
        }
    }
    return json11::Json();
}

namespace Config {
static std::map<std::string, GetterBase *> sGetters;
static std::vector<GetterBase *> sOrderedGetters;
GetterBase::GetterBase(const char *arg, const char *hlp)
    : mHelp(hlp)
{
    if (arg) {
        mJsonKey.assign(arg);
        mEnvironmentVariable = "FISK_" + mJsonKey;
        for (char *ch = &mEnvironmentVariable[5]; *ch; ++ch) {
            if (*ch == '-') {
                *ch = '_';
            } else {
                *ch = static_cast<char>(std::toupper(*ch));
            }
        }
        mCommandLine = "--fisk-" + mJsonKey;
        assert(sGetters.find(mJsonKey) == sGetters.end());
        sGetters[mJsonKey] = this;
    }
    sOrderedGetters.push_back(this);
}

GetterBase::~GetterBase()
{
}

static std::string defaultObjectCacheTag()
{
    char username[256];
    const char *user;
    if (!getlogin_r(username, sizeof(username))) {
        user = username;
    } else {
        user = getenv("USER");
        if (!user) {
            user = getenv("USERNAME");
            if (!user) {
                user = "unknown";
            }
        }
    }
    char host[1024];
    ::gethostname(host, sizeof(host));
    return Client::format("%s-%s", user, host);
}

Getter<bool> help("help", "Display this help", false);
Getter<bool> version("version", "Display fisk version and exit", false);
Getter<bool> dumpSha1("dump-sha1", "Only dump sha1 of file", false);
static Separator s1;
Getter<std::string> scheduler("scheduler", "Set fiskc's scheduler url", "ws://localhost:8097");
Getter<std::string> socket("socket", "Set fiskc's socket file", "/var/fisk/daemon/data/socket");
Getter<std::string> builder("builder", "Set to hostname, name or ip if you have a preferred builder");
Getter<std::string> labels("labels", "Set to whitespace separated list of labels. The selected builder must match all these labels");
static Separator s2;
static Separator s3("Options:");
Getter<bool> color("color", "Set to false to disable colorized output", true);
Getter<bool> jsonDiagnostics("json-diagnostics",
                             "Use json-diagnostics (-fdignostics-format=json) when possible to print proper carets for warnings and errors",
                             false);
Getter<bool> jsonDiagnosticsRaw("json-diagnostics-raw",
                                "Use json-diagnostics (-fdignostics-format=json) when possible but print the json directly without transforming it",
                                false);

Getter<bool> dumpSlots("dump-slots", "Dump slots info for fisk-daemon", false);
Getter<bool> syncFileSystem("sync-file-system", "Call sync(2) after all writes", false);
Getter<bool> disabled("disabled", "Set to true if you don't want to distribute this job", false);
Getter<int> priority("priority", "Set to a higher value if you want to jump the line", 0);
Getter<bool> noDesire("no-desire", "Set to true if you want to override desired-slots to for this job", false);
Getter<bool> objectCache("object-cache", "Set to true if you want the scheduler to cache output from compiles. Also requires the scheduler to be configured with --object-cache and the builders to have --object-cache-size", true);
Getter<std::string> objectCacheTag("object-cache-tag", "Additional tag that gets sha1'ed into the cache key, default is username-hostname", defaultObjectCacheTag());
Getter<bool> storePreprocessedDataOnError("store-preprocessed-data-on-error", "Set to true to store the preprocessed data on errors", false);
Getter<bool> watchdog("watchdog", "Whether watchdog is enabled", true);
Getter<bool> verify("verify", "Only verify that the npm version is correct", false);
Getter<unsigned long long> delay("delay", "Delay this many milliseconds before starting", 0);
Getter<bool> compress("compress", "Compress preprocessed output");
Getter<bool> discardComments("discard-comments", "Discard comments when preprocessing", true);
Getter<std::string> nodePath("node-path", "Path to nodejs executable", "node");
static Separator s4;
static Separator s5("Timeouts:");
Getter<unsigned long long> daemonConnectTimeout("daemon-connect-timeout", "Set daemon connect timeout", 10000);
Getter<unsigned long long> slotAcquisitionTimeout("slot-acquisition-timeout", "Set local compile slot acquisition timeout", 30000);
Getter<unsigned long long> schedulerConnectTimeout("scheduler-connect-timeout", "Set scheduler connect watchdog timeout", 15000);
Getter<unsigned long long> acquiredBuilderTimeout("acquire-builder-timeout", "Set acquired builder watchdog timeout", 7500);
Getter<unsigned long long> builderConnectTimeout("builder-connect-timeout", "Set builder connect watchdog timeout", 7500);
Getter<unsigned long long> preprocessTimeout("preprocess-timeout", "Set preprocess watchdog timeout", 10 * 60000);
Getter<unsigned long long> uploadJobTimeout("upload-job-timeout", "Set upload job watchdog timeout", 15000);
Getter<unsigned long long> responseTimeout("response-timeout", "Set response watchdog timeout (resets for every heartbeat (5s))", 10000); // restarts on each heartbeat which happen every 5 seconds
Getter<std::string> compiler("compiler", "Set fiskc's resolved compiler");
Getter<std::string> cacheDir("cache-dir", "Set fiskc's cache dir", getenv("HOME") ? std::string(getenv("HOME") + std::string("/.cache/fisk/client/")) : std::string(),
                             [](const std::string &value) {
                                 if (value.empty())
                                     return value;
                                 if (value[value.size() - 1] != '/')
                                     return value + '/';
                                 return value;
                             });
Getter<std::string> statisticsLog("statistics-log", "Dump statistics into this file");

static Separator s6;
static Separator s7("CPU allowances:");
Getter<size_t> compileSlots("slots", "Number of compile slots", std::thread::hardware_concurrency(), [](const size_t &value) { return std::max<size_t>(1, value); });
Getter<size_t> desiredCompileSlots("desired-slots", "Number of desired compile slots", 0);
Getter<size_t> cppSlots("cpp-slots", "Number of preprocess slots", std::thread::hardware_concurrency() * 2, [](const size_t &value) { return std::max<size_t>(1, value); });
Getter<std::string> releaseCppSlotMode("release-cpp-slot-mode", "Release cpp slot mode: cpp-finished or upload-finished", "cpp-finished");

static Separator s8;
static Separator s9("Identity:");
Getter<std::string> hostname("hostname", "Set hostname", std::string(), [](const std::string &value) {
    if (!value.empty())
        return value;
    std::string n(256, ' ');
    ::gethostname(&n[0], n.size());
    n.resize(strlen(n.c_str()));
    return n;
});
Getter<std::string> name("name", "Set name (used for visualization)", std::string(), [](const std::string &value) {
    if (!value.empty())
        return value;
    return static_cast<std::string>(hostname);
});
static  Separator s10;
static Separator s11("Logging:");
Getter<bool> logStdOut("log-stdout", "Write logs to stdout (rather than stderr than)", false);
Getter<std::string> logFile("log-file", "Log file");
Getter<bool> logFileAppend("log-file-append", "Append to log file (rather than overwriting)", false);
Getter<std::string> logLevel("log-level", "Log level (Level can be: \"verbose\", \"debug\", \"warn\", \"error\", \"fatal\" or \"silent\")", "fatal");

Getter<bool> logTimePrefix("log-time-prefix", "Add a time prefix to logs", false);
Getter<bool> debug("debug", "Set log level to \"debug\"", false);
Getter<bool> verbose("verbose", "Set log level to \"verbose\"", false);
};

bool Config::init(int &argc, char **&argv)
{
    std::vector<json11::Json> jsons;
    auto load = [](const std::string &path, std::vector<json11::Json> &j) {
        std::string contents;
        bool opened;
        std::string err;
        if (!Client::readFile(path, contents, &opened, &err)) {
            if (opened) {
                fprintf(stderr, "%s\n", err.c_str());
                return false;
            }
            return true;
        }

        json11::Json parsed = json11::Json::parse(contents, err, json11::JsonParse::COMMENTS);
        if (!err.empty()) {
            fprintf(stderr, "Failed to parse json from %s: %s\n", path.c_str(), err.c_str());
            return false;
        }
        j.push_back(std::move(parsed));
        return true;
    };
    if (const char *home = getenv("HOME")) {
        if (!load(std::string(home) + "/.config/fisk/client.conf", jsons)) {
            return false;
        }
    }
    if (!load("/etc/xdg/fisk/client.conf.override", jsons))
        return false;
    if (!load("/etc/xdg/fisk/client.conf", jsons))
        return false;

    std::map<std::string, std::string> commandLine, environmentVariables;
    int i = 1;
    auto consumeArg = [&i, &argv, &argc](int extra) {
        memmove(&argv[i], &argv[i + extra + 1], sizeof(argv[0]) * (argc - i + 1));
        argc -= (extra + 1);
        argv[argc] = nullptr;
    };

    bool gotHelp = false;
    bool gotVersion = false;

    std::vector<std::string> &originalArgs = Client::data().originalArgs;
    originalArgs.resize(argc);
    for (int j=0; j<argc; ++j) {
        originalArgs[j] = argv[j];
    }

    if (argc > 1 && !access(argv[1], X_OK)) {
        // kinda hacky and hidden but it makes fiskc easier to use.
        compiler.apply(std::string(argv[i]));
        compiler.mDone = true;
        consumeArg(0);
    }

    while (i < argc) {
        if (!strcmp("--help", argv[i])) {
            gotHelp = true;
            ++i;
            continue;
        }

        if (!strcmp("--version", argv[i])) {
            gotVersion = true;
            ++i;
            continue;
        }

        if (strncmp("--fisk-", argv[i], 7)) {
            ++i;
            continue;
        }

        std::string key;
        char *eq = strchr(argv[i] + 8, '=');
        if (eq) {
            key.assign(argv[i] + 7, eq);
        } else {
            key = argv[i] + 7;
        }
        auto it = sGetters.find(key);
        bool no = false;
        if (it == sGetters.end() && !strncmp(key.c_str(), "no-", 3)) {
            it = sGetters.find(key.substr(3));
            no = true;
        }
        if (it == sGetters.end() || (no && !it->second->isBoolean())) {
            fprintf(stderr, "Unknown argument %s\n", argv[i]);
            // for (auto foo : sGetters) {
            //     fprintf(stderr, "Balls: %s\n", foo.first.c_str());
            // }
            return false;
        }
        if (!it->second->requiresArgument() && !eq) {
            if (i + 1 < argc) { // optional arg
                int extra = 1;
                if (!it->second->apply(std::string(argv[i + 1]))) {
                    const bool ret = it->second->apply(std::string());
                    assert(ret);
                    (void)ret;
                    extra = 0;
                }
                consumeArg(extra);
            } else {
                const bool ret = it->second->apply(std::string());
                assert(ret);
                (void)ret;
                consumeArg(0);
            }
            it->second->mDone = true;
            if (no)
                it->second->flip();
            continue;
        }
        if (eq) {
            if (it->second->apply(std::string(eq + 1))) {
                it->second->mDone = true;
                consumeArg(0);
                if (no)
                    it->second->flip();
                continue;
            } else {
                usage(stderr);
                fprintf(stderr, "Can't parse argument %s\n", argv[i]);
                return false;
            }
        }

        if (i + 1 >= argc) {
            usage(stderr);
            fprintf(stderr, "Missing argument for \"%s\"\n", argv[i]);
            return false;
        }

        if (!it->second->apply(std::string(argv[i + 1]))) {
            usage(stderr);
            fprintf(stderr, "Can't parse argument %s %s\n", argv[i], argv[i + 1]);
            return false;
        }
        consumeArg(1);
        it->second->mDone = true;
    }

    if ((gotHelp || gotVersion) && static_cast<std::string>(compiler).empty()) {
        std::string file;
        Client::parsePath(argv[0], &file, nullptr);
        if (file == "fiskc") {
            if (gotHelp) {
                help.apply(std::string());
            } else {
                version.apply(std::string());
            }
        }
    }

    if (environ) {
        for (size_t j=0; environ[j]; ++j) {
            const char *env = environ[j];
            if (strncmp(env, "FISK_", 5))
                continue;

            const char *eq = strchr(env, '=');
            std::string key, value;
            if (!eq) {
                key = env + 5;
            } else {
                key = std::string(env + 5, eq);
                value = eq + 1;
            }

            for (char *ch = &key[0]; *ch; ++ch) {
                if (*ch == '_') {
                    *ch = '-';
                } else {
                    *ch = static_cast<char>(std::tolower(*ch));
                }
            }
            bool no = false;
            auto it = sGetters.find(key);
            if (it == sGetters.end() && !strncmp(key.c_str(), "no-", 3)) {
                it = sGetters.find(key.substr(3));
                no = true;
            }

            if (it == sGetters.end() || (no && !it->second->isBoolean())) {
                continue;
            }
            if (it->second->mDone) // set from command line, no need to worry about environment
                continue;

            if (!it->second->apply(value)) {
                usage(stderr);
                fprintf(stderr, "Can't parse environment variable %s\n", env);
                return false;
            }
            if (no)
                it->second->flip();
            it->second->mDone = true;
        }
    }

    for (const auto &getter : sGetters) {
        VERBOSE("Config %s = %s", getter.first.c_str(), getter.second->toString().c_str());
        if (getter.second->mDone)
            continue;
        std::string key = getter.second->jsonKey();
        json11::Json val = value(jsons, key);
        bool no = false;
        if (val.is_null() && getter.second->isBoolean()) {
            key = "no_" + key;
            val = value(jsons, key);
            no = true;
        }
        if (val.is_null())
            continue;

        if (!getter.second->apply(val)) {
            usage(stderr);
            fprintf(stderr, "Can't parse %s for %s\n", val.dump().c_str(), getter.second->jsonKey().c_str());
            return false;
        }
        if (no)
            getter.second->flip();

        getter.second->mDone = true;
    }

    const std::string dir = cacheDir;
    std::string versionFile = dir + "version";
    int fd = open(versionFile.c_str(), O_RDONLY|O_CLOEXEC);
    if (fd != -1) {
        flock(fd, LOCK_SH); // what if it fails?
        uint32_t ver;
        if (read(fd, &ver, sizeof(ver)) == sizeof(ver)) {
            flock(fd, LOCK_UN); // what if it fails?
            ::close(fd);
            if (ver == htonl(Version)) {
                return true;
            }
        }
    }
    Client::recursiveRmdir(dir);
    Client::recursiveMkdir(dir);

    fd = open(versionFile.c_str(), O_CREAT|O_RDWR|O_CLOEXEC, S_IRUSR|S_IWUSR|S_IRGRP|S_IWGRP|S_IROTH);
    if (fd != -1) {
        flock(fd, LOCK_EX); // what if it fails?
        const uint32_t ver = htonl(Version);
        if (write(fd, &ver, sizeof(ver)) != sizeof(ver)) {
            fprintf(stderr, "Failed to write to versionfile %d %s\n", errno, strerror(errno));
        }
        flock(fd, LOCK_UN);
        ::close(fd);
    }
    return true;
}

void Config::usage(FILE *f)
{
    fprintf(f,
            "Usage: fiskc [...options...]\n"
            "Options:\n"
            "--------\n");
    int max = 0;
    for (const auto &getter : sGetters) {
        max = std::max<int>(max, static_cast<int>(2 + 7 + getter.first.size() + 1 + 8 + 3 + 3));
    }
    fprintf(f, "  --help%*s%s (false)\n", max - 11, "", "Display this help (if argv0 is fiskc)");
    fprintf(f, "  --version%*s%s (false)\n", max - 14, "", "Display version information (if argv0 is fiskc)");

    for (const GetterBase *getter : sOrderedGetters) {
        if (getter->jsonKey().empty()) {
            fprintf(f, "%s\n", getter->help());
            continue;
        }
        fprintf(f, "  %s", getter->commandLine().c_str());
        int used = static_cast<int>(2 + getter->commandLine().size());
        if (getter->requiresArgument()) {
            fprintf(f, "=[value]");
            used += 8;
        }
        used += 3;
        fprintf(f, "%*s%s (%s)\n", max - used, "", getter->help(), getter->toString().c_str());
    }
    fprintf(f,
            "\n"
            "Environment variables:\n"
            "----------------------\n");
    for (const GetterBase *getter : sOrderedGetters) {
        if (getter->jsonKey().empty()) {
            fprintf(f, "%s\n", getter->help());
            continue;
        }

        fprintf(f, "  %s", getter->environmentVariable().c_str());
        int used = static_cast<int>(6 + getter->environmentVariable().size());
        fprintf(f, "%*s%s (%s)\n", max - used, "", getter->help(), getter->toString().c_str());
    }
}

Config::Separator::~Separator()
{
}
