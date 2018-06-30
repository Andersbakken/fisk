#include "Client.h"
#include "CompilerArgs.h"
#include "Config.h"
#include "SlaveWebSocket.h"
#include "SchedulerWebSocket.h"
#include "Log.h"
#include "Select.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <json11.hpp>
#include <climits>
#include <cstdlib>
#include <regex>
#include <cstring>
#include <unistd.h>
#include <csignal>

static const unsigned long long milliseconds_since_epoch = std::chrono::system_clock::now().time_since_epoch() / std::chrono::milliseconds(1);
static unsigned long long preprocessedDuration = 0;
static unsigned long long preprocessedSlotDuration = 0;
static void usage(FILE *f);
int main(int argcIn, char **argvIn)
{
    // usleep(500 * 1000);
    // return 0;
    std::atexit([]() {
            for (sem_t *semaphore : Client::data().semaphores) {
                sem_post(semaphore);
            }
            if (Watchdog *watchdog = Client::data().watchdog) {
                if (Log::minLogLevel <= Log::Warn) {
                    std::string str = Client::format("since epoch: %llu preprocess time: %llu (slot time: %llu)",
                                                     milliseconds_since_epoch, preprocessedDuration, preprocessedSlotDuration);
                    for (size_t i=Watchdog::ConnectedToScheduler; i<=Watchdog::Finished; ++i) {
                        str += Client::format(" %s: %llu (%llu)", Watchdog::stageName(static_cast<Watchdog::Stage>(i)),
                                              watchdog->timings[i] - watchdog->timings[i - 1],
                                              watchdog->timings[i] - Client::started);
                    }
                    Log::log(Log::Warn, str);
                }
            }
        });

    Config::init();
    std::string logLevel = Config::logLevel();
    std::string logFile = Config::logFile();
    const char *env;
    if ((env = getenv("FISK_LOG"))) {
        logLevel = env;
    } else if ((env = getenv("FISK_DEBUG"))) {
        logLevel = env;
    } else if ((env = getenv("FISK_VERBOSE"))) {
        if (!*env || strcmp(env, "0")) {
            logLevel = "Debug";
        }
    }

    if ((env = getenv("FISK_LOG_FILE"))) {
        logFile = env;
    }

    Log::LogFileMode logFileMode = Log::Overwrite;
    if ((env = getenv("FISK_LOG_APPEND"))) {
        logFileMode = Log::Append;
    }

    bool disabled = false;
    if ((env = getenv("FISK_DISABLED"))) {
        disabled = !strlen(env) || !strcmp(env, "1");
    }

    const char *preresolved = getenv("FISK_COMPILER");
    const char *slave = getenv("FISK_SLAVE");
    const char *scheduler = getenv("FISK_SCHEDULER");

    Watchdog watchdog;
    Client::Data &data = Client::data();
    data.watchdog = &watchdog;
    auto signalHandler = [](int) {
        for (sem_t *semaphore : Client::data().semaphores) {
            sem_post(semaphore);
        }
        _exit(1);
    };
    for (int signal : { SIGINT, SIGHUP, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGALRM, SIGTERM }) {
        std::signal(signal, signalHandler);
    }
    data.argv = new char *[argcIn + 1];
    bool noMoreFiskOptions = false;
    for (int i=0; i<argcIn; ++i) {
        if (noMoreFiskOptions) {
            data.argv[data.argc++] = argvIn[i];
        } else if (!strcmp("--", argvIn[i])) {
            noMoreFiskOptions = true;
        } else if (!strcmp("--help", argvIn[i]) || !strcmp("--fisk-help", argvIn[i])) {
            std::string filename;
            Client::parsePath(argvIn[0], &filename, 0);
            if (!strcmp("--fisk-help", argvIn[i]) || filename == "fiskc") {
                usage(stdout);
                return 0;
            } else {
                data.argv[data.argc++] = argvIn[i];
            }
        } else if (!strncmp("--fisk-log-level=", argvIn[i], 17)
                   || !strncmp("--fisk-log=", argvIn[i], 11)
                   || !strncmp("--fisk-debug-level=", argvIn[i], 19)
                   || !strncmp("--fisk-debug=", argvIn[i], 13)) {
            logLevel = strchr(argvIn[i], '=') + 1;
        } else if (!strcmp("--fisk-verbose", argvIn[i])) {
            logLevel = "Debug";
        } else if (i + 1 < argcIn && (!strcmp("--fisk-log-level", argvIn[i])
                                      || !strcmp("--fisk-log-level", argvIn[i])
                                      || !strcmp("--fisk-log", argvIn[i])
                                      || !strcmp("--fisk-debug", argvIn[i]))) {
            logLevel = argvIn[++i];
        } else if (!strncmp("--fisk-log-file=", argvIn[i], 16)) {
            logFile = argvIn[i] + 16;
        } else if (i + 1 < argcIn && !strcmp("--fisk-log-file", argvIn[i])) {
            logFile = argvIn[++i];
        } else if (!strcmp("--fisk-log-file-append", argvIn[i])) {
            logFileMode = Log::Append;
        } else if (!strncmp("--fisk-compiler=", argvIn[i], 16)) {
            preresolved = argvIn[i] + 16;
        } else if (i + 1 < argcIn && !strcmp("--fisk-compiler", argvIn[i])) {
            preresolved = argvIn[++i];
        } else if (!strncmp("--fisk-slave=", argvIn[i], 13)) {
            slave = argvIn[i] + 13;
        } else if (i + 1 < argcIn && !strcmp("--fisk-slave", argvIn[i])) {
            slave = argvIn[++i];
        } else if (!strncmp("--fisk-scheduler=", argvIn[i], 17)) {
            scheduler = argvIn[i] + 17;
        } else if (i + 1 < argcIn && !strcmp("--fisk-scheduler", argvIn[i])) {
            scheduler = argvIn[++i];
        } else if (!strcmp("--fisk-disabled", argvIn[i])) {
            disabled = true;
        } else if (!strcmp("--fisk-clean-semaphores", argvIn[i])) {
            for (Client::Slot::Type type : { Client::Slot::Compile, Client::Slot::Cpp }) {
                if (sem_unlink(Client::Slot::typeToString(type))) {
                    fprintf(stderr, "Failed to unlink semaphore %s: %d %s\n",
                            Client::Slot::typeToString(type), errno, strerror(errno));
                }
            }
            return 0;
        } else if (!strcmp("--fisk-dump-semaphores", argvIn[i])) {
#ifdef __APPLE__
            fprintf(stderr, "sem_getvalue(2) is not functional on mac so this option doesn't work\n");
#else
            for (Client::Slot::Type type : { Client::Slot::Compile, Client::Slot::Cpp }) {
                sem_t *sem = sem_open(Client::Slot::typeToString(type), O_CREAT, 0666, Client::Slot::slots(type));
                if (!sem) {
                    fprintf(stderr, "Failed to open semaphore %s slots: %zu: %d %s\n",
                            Client::Slot::typeToString(type), Client::Slot::slots(type),
                            errno, strerror(errno));
                    continue;
                }
                int val = -1;
                sem_getvalue(sem, &val);
                printf("%s %d/%zu\n", Client::Slot::typeToString(type), val, Client::Slot::slots(type));
                sem_close(sem);
            }
#endif

            return 0;
        } else if (!strncmp("--fisk", argvIn[i], 6)) {
            usage(stderr);
            fprintf(stderr, "Unknown option %s\n", argvIn[i]);
            return 1;
        } else {
            data.argv[data.argc++] = argvIn[i];
        }
    }
    Log::Level level = Log::Silent;
    if (!logLevel.empty()) {
        bool ok;
        level = Log::stringToLevel(logLevel.c_str(), &ok);
        if (!ok) {
            fprintf(stderr, "Invalid log level: %s (\"Debug\", \"Warn\", \"Error\" or \"Silent\")\n", logLevel.c_str());
            return 1;
        }
    }

    Log::init(level, std::move(logFile), logFileMode);

    if (!Client::findCompiler(preresolved)) {
        ERROR("Can't find executable for %s", data.argv[0]);
        return 1;
    }
    DEBUG("Resolved compiler %s (%s) to \"%s\" \"%s\" \"%s\")",
          data.argv[0], preresolved ? preresolved : "",
          data.compiler.c_str(), data.resolvedCompiler.c_str(),
          data.slaveCompiler.c_str());

    if (disabled) {
        DEBUG("Have to run locally because we're disabled");
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    std::vector<std::string> args(data.argc);
    for (int i=0; i<data.argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = data.argv[i];
    }
    data.compilerArgs = CompilerArgs::create(args);
    if (!data.compilerArgs
        || data.compilerArgs->mode != CompilerArgs::Compile
        || data.compilerArgs->flags & CompilerArgs::StdinInput
        || data.compilerArgs->sourceFileIndexes.size() != 1) {
        DEBUG("Have to run locally because mode %s - flags 0x%x - source files: %zu",
              CompilerArgs::modeName(data.compilerArgs ? data.compilerArgs->mode : CompilerArgs::Invalid),
              data.compilerArgs ? data.compilerArgs->flags : 0, data.compilerArgs ? data.compilerArgs->sourceFileIndexes.size() : 0);
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    SchedulerWebSocket schedulerWebsocket;

    struct sigaction act;
    memset(&act, 0, sizeof(struct sigaction));
    act.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &act, 0);

    std::unique_ptr<Client::Preprocessed> preprocessed = Client::preprocess(data.compiler, data.compilerArgs);
    if (!preprocessed) {
        ERROR("Failed to preprocess");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    data.hash = Client::environmentHash(data.resolvedCompiler);
    std::vector<std::string> compatibleHashes = Config::compatibleHashes(data.hash);
    std::string hashes = data.hash;
    for (const std::string &compatibleHash : compatibleHashes) {
        hashes += ";" + compatibleHash;
    }
    DEBUG("Got hashes %s for %s", hashes.c_str(), data.resolvedCompiler.c_str());
    std::map<std::string, std::string> headers;
    headers["x-fisk-environments"] = hashes;
    Client::parsePath(data.compilerArgs->sourceFile(0), &headers["x-fisk-sourcefile"], 0);
    headers["x-fisk-client-name"] = Config::name();
    headers["x-fisk-config-version"] = std::to_string(Config::Version);
    if (slave)
        headers["x-fisk-slave"] = slave;
    {
        std::string hostname = Config::hostname();
        if (!hostname.empty())
            headers["x-fisk-client-hostname"] = std::move(hostname);
    }
    std::string url = scheduler ? std::string(scheduler) : Config::scheduler();
    if (url.find("://") == std::string::npos)
        url.insert(0, "ws://");

    std::regex regex(":[0-9]+$", std::regex_constants::ECMAScript);
    if (!std::regex_search(url, regex))
        url.append(":8097");

    if (!schedulerWebsocket.connect(url + "/compile", headers)) {
        DEBUG("Have to run locally because no server");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    {
        Select select;
        select.add(&watchdog);
        select.add(&schedulerWebsocket);

        DEBUG("Starting schedulerWebsocket");
        while (!schedulerWebsocket.done && schedulerWebsocket.state() <= SchedulerWebSocket::ConnectedWebSocket)
            select.exec();
        DEBUG("Finished schedulerWebsocket");
    }

    if (schedulerWebsocket.maintainSemaphores) {
        for (Client::Slot::Type type : { Client::Slot::Compile, Client::Slot::Cpp }) {
            if (sem_unlink(Client::Slot::typeToString(type))) {
                if (errno != ENOENT) {
                    ERROR("Failed to unlink semaphore %s: %d %s",
                          Client::Slot::typeToString(type), errno, strerror(errno));
                } else {
                    DEBUG("Semaphore %s didn't exist", Client::Slot::typeToString(type));
                }
            } else {
                DEBUG("Destroyed semaphore %s", Client::Slot::typeToString(type));
            }
        }
    }

    if (schedulerWebsocket.needsEnvironment) {
        watchdog.stop();
        const std::string tarball = Client::prepareEnvironmentForUpload();
        printf("GOT TARBALL %s\n", tarball.c_str());
        if (!tarball.empty()) {
            Client::uploadEnvironment(&schedulerWebsocket, tarball);
        }
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0;
    }

    if ((schedulerWebsocket.slaveHostname.empty() && schedulerWebsocket.slaveIp.empty())
        || !schedulerWebsocket.slavePort) {
        DEBUG("Have to run locally because no slave");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    // usleep(1000 * 1000 * 16);
    watchdog.transition(Watchdog::AcquiredSlave);
    SlaveWebSocket slaveWebSocket;
    Select select;
    select.add(&slaveWebSocket);
    select.add(&watchdog);
    headers["x-fisk-job-id"] = std::to_string(schedulerWebsocket.jobId);
    if (!slaveWebSocket.connect(Client::format("ws://%s:%d/compile",
                                               schedulerWebsocket.slaveHostname.empty() ? schedulerWebsocket.slaveIp.c_str() : schedulerWebsocket.slaveHostname.c_str(),
                                               schedulerWebsocket.slavePort), headers)) {
        DEBUG("Have to run locally because no slave connection");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    while (slaveWebSocket.state() < SchedulerWebSocket::ConnectedWebSocket)
        select.exec();

    DEBUG("Waiting for preprocessed");
    preprocessed->wait();
    DEBUG("Preprocessed finished");
    preprocessedDuration = preprocessed->duration;
    preprocessedSlotDuration = preprocessed->slotDuration;

    if (preprocessed->exitStatus != 0) {
        ERROR("Failed to preprocess. Running locally");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    args[0] = data.slaveCompiler;
    const bool wait = slaveWebSocket.handshakeResponseHeader("x-fisk-wait") == "true";
    json11::Json::object msg {
        { "commandLine", args },
        { "argv0", data.compiler },
        { "wait", wait },
        { "bytes", static_cast<int>(preprocessed->stdOut.size()) }
    };

    std::string json = json11::Json(msg).dump();
    slaveWebSocket.wait = wait;
    slaveWebSocket.send(WebSocket::Text, json.c_str(), json.size());
    if (wait) {
        while ((slaveWebSocket.hasPendingSendData() || slaveWebSocket.wait) && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
            select.exec();
        if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
            DEBUG("Have to run locally because something went wrong with the slave");
            watchdog.stop();
            Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
            return 0; // unreachable
        }
    }

    assert(!slaveWebSocket.wait);
    slaveWebSocket.send(WebSocket::Binary, preprocessed->stdOut.c_str(), preprocessed->stdOut.size());

    while (slaveWebSocket.hasPendingSendData() && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
        select.exec();
    if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because something went wrong with the slave");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    watchdog.transition(Watchdog::UploadedJob);

    // usleep(1000 * 500);
    // return 0;
    while (!slaveWebSocket.done && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
        select.exec();
    if (slaveWebSocket.done) {
        if (!preprocessed->stdErr.empty()) {
            fwrite(preprocessed->stdErr.c_str(), sizeof(char), preprocessed->stdErr.size(), stderr);
        }
        watchdog.transition(Watchdog::Finished);
        watchdog.stop();
        schedulerWebsocket.close("slaved");
        return data.exitCode;
    }

    DEBUG("Have to run locally because something went wrong with the slave, part deux");
    watchdog.stop();
    Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
    return 0; // unreachable
}

static void usage(FILE *f)
{
    fprintf(f,
            "Usage: fiskc [...options...]\n"
            "Options:\n"
            "  --help                             Display this help (if argv0 is fiskc)\n"
            "\n"
            "  --fisk-help                        Display this help\n"
            "\n"
            "  --fisk-log-level=[loglevel]        Set log level\n"
            "  --fisk-log=[loglevel]              Level can be: \"debug\", \"warn\", \"error\" or \"silent\"\n"
            "  --fisk-debug-level=[loglevel]\n"
            "  --fisk-debug=[loglevel]\n"
            "  --fisk-log-level [loglevel]\n"
            "  --fisk-log [loglevel]\n"
            "  --fisk-debug-level [loglevel]\n"
            "  --fisk-debug [loglevel]\n"
            "\n"
            "  --fisk-verbose                     Set log level to \"debug\"\n"
            "\n"
            "  --fisk-log-file=[file]             Log to file\n"
            "  --fisk-log-file [file]\n"
            "  --fisk-log-file-append\n           Append to log file\n"
            "\n"
            "  --fisk-compiler=[compiler]         Set fisk's resolved compiler to [compiler]\n"
            "  --fisk-compiler [compiler]\n"
            "\n"
            "  --fisk-slave=[ip address]          Set fisk's preferred slave\n"
            "  --fisk-slave [ip address]\n"
            "\n"
            "  --fisk-scheduler=[url]             Set fisk's scheduler url (\"ws://127.0.0.1:8097\")\n"
            "  --fisk-scheduler [url]\n"
            "\n"
            "  --fisk-disabled                    Run all jobs locally\n"
            "\n"
            "  --fisk-clean-semaphores            Drop semaphores. This could be useful if fiskc has crashed while holding a semaphore\n"
            "\n"
            "  --fisk-dump-semaphores             Dump info about semaphores\n"
            "  --                                 Pass all remaining arguments directly to the compiler\n"
            "\n"
            "Environment variables:\n"
            "  FISK_LOG                           Set log level\n"
            "  FISK_DEBUG                         Set log level\n"
            "  FISK_VERBOSE                       Set log level to \"debug\" if value != \"0\"\n"
            "  FISK_LOG_FILE                      Set log file\n"
            "  FISK_LOG_APPEND                    Append to log file\n"
            "  FISK_DISABLED                      Run all jobs locally\n"
            "  FISK_COMPILER                      Set resolved compiler\n"
            "  FISK_SCHEDULER                     Set scheduler url\n"
            "  FISK_SLAVE                         Set preferred slave\n");
}
