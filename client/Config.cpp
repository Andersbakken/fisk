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
GetterBase::GetterBase(const char *arg, const char *help)
    : mHelp(help)
{
    if (arg) {
        mJsonKey.assign(arg);
        mEnvironmentVariable = "FISK_" + mJsonKey;
        for (char *ch = &mEnvironmentVariable[5]; *ch; ++ch) {
            if (*ch == '-') {
                *ch = '_';
            } else {
                *ch = std::toupper(*ch);
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

Getter<bool> help("help", "Display this help", false);
Getter<bool> version("version", "Display fisk version and exit", false);
Separator s1;
Getter<std::string> scheduler("scheduler", "Set fiskc's scheduler url", "ws://localhost:8097");
Getter<std::string> slave("slave", "Set to hostname, name or ip if you have a preferred slave");
Separator s2;
Separator s3("Options:");
Getter<bool> disabled("disabled", "Set to true if you don't want to distribute this job", false);
Getter<bool> noDesire("no-desire", "Set to true if you want to override desired-slots to for this job", false);
Getter<bool> objectCache("object-cache", "Set to true if you want the scheduler to cache output from compiles. Also requires the scheduler to be configured with --object-cache-size", true);
Getter<bool> watchdog("watchdog", "Whether watchdog is enabled", false);
Getter<unsigned long long> delay("delay", "Delay this many milliseconds before starting", 0);
Getter<bool> discardComments("discard-comments", "Discard comments when preprocessing", true);
Getter<std::string> nodePath("node-path", "Path to nodejs executable", "node");
Separator s4("Timeouts:");
Getter<unsigned long long> schedulerConnectTimeout("scheduler-connect-timeout", "Set scheduler connect watchdog timeout", 5000);
Getter<unsigned long long> acquiredSlaveTimeout("acquire-slave-timeout", "Set acquired slave watchdog timeout", 3000);
Getter<unsigned long long> slaveConnectTimeout("slave-connect-timeout", "Set slave connect watchdog timeout", 3000);
Getter<unsigned long long> preprocessTimeout("preprocess-timeout", "Set preprocess watchdog timeout", 5000);
Getter<unsigned long long> uploadJobTimeout("upload-job-timeout", "Set upload job watchdog timeout", 10000);
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

Separator s5;
Separator s6("CPU allowances:");
Getter<size_t> compileSlots("slots", "Number of compile slots", std::thread::hardware_concurrency(), [](const size_t &value) { return std::max<size_t>(1, value); });
Getter<size_t> desiredCompileSlots("desired-slots", "Number of desired compile slots", 0);
Getter<size_t> cppSlots("cpp-slots", "Number of preprocess slots", std::thread::hardware_concurrency() * 2, [](const size_t &value) { return std::max<size_t>(1, value); });

Separator s7;
Separator s8("Identity:");
Getter<std::string> hostname("hostname", "Set hostname", std::string(), [](const std::string &value) {
        if (!value.empty())
            return value;
        std::string name(256, ' ');
        ::gethostname(&name[0], name.size());
        name.resize(strlen(name.c_str()));
        return name;
    });
Getter<std::string> name("name", "Set name (used for visualization)", std::string(), [](const std::string &value) {
        if (!value.empty())
            return value;
        return static_cast<std::string>(hostname);
    });
Separator s9;
Separator s10("Logging:");
Getter<bool> logStdOut("log-stdout", "Write logs to stdout (rather than stderr than)", false);
Getter<std::string> logFile("log-file", "Log file");
Getter<bool> logFileAppend("log-file-append", "Append to log file (rather than overwriting)", false);
Getter<std::string> logLevel("log-level", "Log level (Level can be: \"verbose\", \"debug\", \"warn\", \"error\" or \"silent\")",
#ifdef NDEBUG
                             "silent"
#else
                             "error"
#endif
    );

Getter<bool> logTimePrefix("log-time-prefix", "Add a time prefix to logs", false);
Getter<bool> debug("debug", "Set log level to \"debug\"", false);
Getter<bool> verbose("verbose", "Set log level to \"verbose\"", false);
Separator s11;
Separator s12("Semaphores:");
Getter<bool> dumpSemaphores("dump-semaphores", "Dump info about fiskc's semaphores", false);
Getter<bool> cleanSemaphores("clean-semaphores", "Clean fiskc's semaphores", false);

};

bool Config::init(int &argc, char **&argv)
{
    std::vector<json11::Json> jsons;
    auto load = [](const std::string &path, std::vector<json11::Json> &j) {
        FILE *f = fopen(path.c_str(), "r");
        if (!f)
            return true;
        fseek(f, 0, SEEK_END);
        const long size = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (!size) {
            fclose(f);
            return false;
        }

        std::string contents(size, ' ');
        const size_t read = fread(&contents[0], 1, size, f);
        fclose(f);
        if (read != static_cast<size_t>(size)) {
            fprintf(stderr, "Failed to read from file: %s (%d %s)\n", path.c_str(), errno, strerror(errno));
            return false;
        }

        std::string err;
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
    if (!load("/etc/xdg/fisk/client.conf", jsons))
        return false;
    if (!load("/etc/xdg/fisk/client.conf.override", jsons))
        return false;

    std::map<std::string, std::string> commandLine, environmentVariables;
    int i = 1;
    auto consumeArg = [&i, &argv, &argc](int extra) {
        memmove(&argv[i], &argv[i + extra + 1], sizeof(argv[0]) * (argc - i + 1));
        argc -= (extra + 1);
        argv[argc] = 0;
    };

    bool gotHelp = false;
    bool gotVersion = false;

    std::vector<std::string> &originalArgs = Client::data().originalArgs;
    originalArgs.resize(argc);
    for (int i=0; i<argc; ++i) {
        originalArgs[i] = argv[i];
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
        if (it == sGetters.end()) {
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
            continue;
        }
        if (eq) {
            if (it->second->apply(std::string(eq + 1))) {
                it->second->mDone = true;
                consumeArg(0);
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
            return true;
        }
    }

    if (environ) {
        for (size_t i=0; environ[i]; ++i) {
            char *env = environ[i];
            if (strncmp(env, "FISK_", 5))
                continue;

            char *eq = strchr(env, '=');
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
                    *ch = std::tolower(*ch);
                }
            }
            auto it = sGetters.find(key);
            if (it == sGetters.end()) { // not found, treat as error?
                continue;
            }
            if (it->second->mDone) // set from command line, no need to worry about environment
                continue;

            if (!it->second->apply(value)) {
                usage(stderr);
                fprintf(stderr, "Can't parse environment variable %s\n", env);
                return false;
            }
            it->second->mDone = true;
        }
    }

    for (const std::pair<std::string, GetterBase *> &getter : sGetters) {
        if (getter.second->mDone)
            continue;
        const json11::Json val = value(jsons, getter.second->jsonKey());
        if (!val.is_null() && !getter.second->apply(val)) {
            usage(stderr);
            fprintf(stderr, "Can't parse %s for %s\n", val.dump().c_str(), getter.second->jsonKey().c_str());
            return false;
        }
        getter.second->mDone = true;
    }

    const std::string dir = cacheDir;
    std::string versionFile = dir + "version";
    int fd = open(versionFile.c_str(), O_RDONLY|O_CLOEXEC);
    if (fd != -1) {
        flock(fd, LOCK_SH); // what if it fails?
        uint32_t version;
        if (read(fd, &version, sizeof(version)) == sizeof(version)) {
            flock(fd, LOCK_UN); // what if it fails?
            ::close(fd);
            if (version == htonl(Version)) {
                return true;
            }
        }
    }
    Client::recursiveRmdir(dir);
    Client::recursiveMkdir(dir);

    fd = open(versionFile.c_str(), O_CREAT|O_RDWR|O_CLOEXEC, S_IRUSR|S_IWUSR|S_IRGRP|S_IWGRP|S_IROTH);
    if (fd != -1) {
        flock(fd, LOCK_EX); // what if it fails?
        const uint32_t version = htonl(Version);
        if (write(fd, &version, sizeof(version)) != sizeof(version)) {
            ERROR("Failed to log");
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
    for (const std::pair<std::string, GetterBase *> &getter : sGetters) {
        max = std::max<int>(max, 2 + 7 + getter.first.size() + 1 + 8 + 3 + 3);
    }
    fprintf(f, "  --help%*s%s (false)\n", max - 12, "", "Display this help (if argv0 is fiskc)");
    for (const GetterBase *getter : sOrderedGetters) {
        if (getter->jsonKey().empty()) {
            fprintf(f, "%s\n", getter->help());
            continue;
        }
        fprintf(f, "  %s", getter->commandLine().c_str());
        int used = 2 + getter->commandLine().size();
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
        int used = 6 + getter->environmentVariable().size();
        fprintf(f, "%*s%s (%s)\n", max - used, "", getter->help(), getter->toString().c_str());
    }
}
