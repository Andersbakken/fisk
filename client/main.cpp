#include "Client.h"
#include "CompilerArgs.h"
#include "Config.h"
#include "SlaveWebSocket.h"
#include "SchedulerWebSocket.h"
#include "Log.h"
#include "Preprocessed.h"
#include "Select.h"
#include <execinfo.h>
#include "Watchdog.h"
#include "WebSocket.h"
#include <json11.hpp>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <csignal>
#ifdef __linux__
#include <sys/prctl.h>
#endif
#include "DaemonSocket.h"

static unsigned long long preprocessedDuration = 0;
static unsigned long long preprocessedSlotDuration = 0;
extern "C" const char *npm_version;
static std::string schedulerUrl();
static int clientVerify();
int main(int argc, char **argv)
{
    if (getenv("FISKC_INVOKED")) {
        fprintf(stderr, "Recursive invocation of fiskc detected.\n");
        return 104;
    }
    setenv("FISKC_INVOKED", "1", 1);
    // usleep(500 * 1000);
    // return 0;
    std::atexit([]() {
        Client::Data &data = Client::data();
        if (Log::minLogLevel <= Log::Warn) {
            std::string str = Client::format("since epoch: %llu preprocess time: %llu (slot time: %llu)",
                                             Client::milliseconds_since_epoch,
                                             preprocessedDuration,
                                             preprocessedSlotDuration);
            for (size_t i=Watchdog::ConnectedToScheduler; i<=Watchdog::Finished; ++i) {
                str += Client::format("\n %s: %llu (%llu)", Watchdog::stageName(static_cast<Watchdog::Stage>(i)),
                                      data.watchdog->timings[i] - data.watchdog->timings[i - 1],
                                      data.watchdog->timings[i] - Client::started);
            }
            Log::log(Log::Warn, str);
        }
        delete data.watchdog;
        Log::shutdown();
    });

    const int argCount = argc;
    if (!Config::init(argc, argv) && !Config::help) {
        return 105;
    }

    if (Config::help || argCount == 1) {
        Config::usage(stdout);
        return 0;
    }

    if (Config::version) {
        printf("%s\n", npm_version);
        return 0;
    }


    std::string clientName = Config::name;

    Log::Level level = Log::Fatal;
    const std::string logLevel = Config::logLevel;
    if (!logLevel.empty()) {
        bool ok;
        level = Log::stringToLevel(logLevel.c_str(), &ok);
        if (!ok) {
            fprintf(stderr, "Invalid log level: %s (\"Verbose\", \"Debug\", \"Warn\", \"Error\" \"Fatal\" or \"Silent\")\n", logLevel.c_str());
            return 106;
        }
    }
    if (Config::verbose) {
        level = Log::Verbose;
    } else if (Config::debug) {
        level = Log::Debug;
    }
    std::string preresolved = Config::compiler;

    Log::init(level, Config::logFile, Config::logFileAppend ? Log::Append : Log::Overwrite);

    if (Log::minLogLevel <= Log::Debug) {
        Log::debug("CWD: %s", Client::cwd().c_str());
        std::string ret;
        for (int i=0; i<argc; ++i) {
            ret += " \"";
            ret += argv[i];
            ret += '"';
        }
        Log::debug("CMDLINE:%s", ret.c_str());
    }

    if (unsigned long long delay = Config::delay) {
        DEBUG("Sleeping for %llu ms", delay);
        usleep(static_cast<unsigned>(delay * 1000));
    }

    Client::Data &data = Client::data();
    data.watchdog = new Watchdog;
    data.argv = argv;
    data.argc = argc;
    auto signalHandler = [](int signal) {
        if (signal != SIGINT && signal != SIGTERM) {
            fprintf(stderr, "fiskc: Caught signal %d\n", signal);
            void *buffer[64];
            const int count = backtrace(buffer, sizeof(buffer) / sizeof(buffer[0]));
            backtrace_symbols_fd(buffer, count, fileno(stderr));
            fflush(stderr);
        }
        _exit(-signal);
    };
    for (int signal : { SIGHUP, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGALRM, SIGTERM }) {
        std::signal(signal, signalHandler);
    }
#ifdef __linux__
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() == 1) { // parent already dead
        return -SIGTERM;
    }
#endif

    struct sigaction act;
    memset(&act, 0, sizeof(struct sigaction));
    act.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &act, nullptr);

    if (Config::verify) {
        return clientVerify();
    }
    if (preresolved.empty()) {
        std::string fn;
        Client::parsePath(argv[0], &fn, nullptr);
        if (fn == "fiskc") {
            bool c = true;
            for (int i=1; i<argc; ++i) {
                if (Client::endsWith(".cpp", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".cxx", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".cc", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".C", argv[i])
                    || Client::endsWith(".cpp.o", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".cxx.o", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".cc.o", argv[i], Client::CaseInsensitive)
                    || Client::endsWith(".C.o", argv[i])
                    || (!strncmp(argv[i], "-std=", 4) && strstr(argv[i] + 4, "++"))) {
                    c = false;
                    break;
                }
            }
#ifdef __APPLE__
            preresolved = c ? "clang" : "clang++";
#else
            preresolved = c ? "gcc" : "g++";
#endif
        }
    }
    if (!Config::dumpSlots) {
        if (!Client::findCompiler(preresolved)) {
            FATAL("Can't find executable for %s %s", data.argv[0], preresolved.c_str());
            return 107;
        }
        DEBUG("Resolved compiler %s (%s) to \"%s\" \"%s\" \"%s\")",
              data.argv[0], preresolved.c_str(),
              data.compiler.c_str(), data.resolvedCompiler.c_str(),
              data.slaveCompiler.c_str());
    }

    DaemonSocket daemonSocket;
    if (!daemonSocket.connect()) {
        ERROR("Failed to connect to daemon");
        data.watchdog->stop();
        Client::runLocal("daemon connect failure");
    }

    Select select;
    select.add(&daemonSocket);
    select.add(data.watchdog);
    while (daemonSocket.state() == DaemonSocket::Connecting && !data.watchdog->timedOut()) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        if (Config::dumpSlots) {
            ERROR("Can't connect to daemon because of watchdog");
            return 1;
        } else {
            ERROR("Have to run locally because we timed out connecting to daemon");
            data.watchdog->stop();
            Client::runLocal("daemon connect failure");
        }
    }

    if (daemonSocket.state() != DaemonSocket::Connected) {
        if (Config::dumpSlots) {
            ERROR("Can't connect to daemon because of connect failure");
            return 1;
        } else {
            Client::runLocal("daemon connect failure 2");
        }
    }

    data.watchdog->transition(Watchdog::ConnectedToDaemon);

    if (Config::dumpSlots) {
        daemonSocket.send("{ \"type\": \"dumpSlots\" }");
        while (daemonSocket.state() == DaemonSocket::Connected && !data.watchdog->timedOut()) {
            select.exec();
        }
        return daemonSocket.state() == DaemonSocket::Closed ? 0 : 1;
    }

    auto runLocal = [&daemonSocket, &data, &select](const std::string &reason) {
        data.watchdog->stop();
        daemonSocket.send(DaemonSocket::AcquireCompileSlot);
        daemonSocket.waitForCompileSlot(select);
        Client::runLocal(reason);
    };


#if 0
    if (!Config::noDesire) {
        if (std::unique_ptr<Client::Slot> slot = Client::tryAcquireSlot(Client::Slot::DesiredCompile)) {
            runLocal("nodesire");
            return 0;
        }
    }
#endif

    if (Config::disabled) {
        DEBUG("Have to run locally because we're disabled");
        runLocal("disabled");
        return 0; // unreachable
    }

    {
        std::vector<std::string> args(data.argc);
        for (int i=0; i<data.argc; ++i) {
            // printf("%zu: %s\n", i, argv[i]);
            args[i] = data.argv[i];
        }

        if (!Config::color) {
            for (std::string &arg : args) {
                if (arg == "-fcolor-diagnostics") {
                    arg = "-fno-color-diagnostics";
                } else if (arg == "-fdiagnostics-color=always" || arg == "-fdiagnostics-color=auto") {
                    arg = "-fdiagnostics-color=never";
                }
            }
        }

        data.compilerArgs = CompilerArgs::create(args, &data.localReason);
    }
    if (!data.compilerArgs) {
        DEBUG("Have to run locally");
        runLocal(Client::format("compiler args parse failure: %s", CompilerArgs::localReasonToString(data.localReason)));
        return 0; // unreachable
    }

    daemonSocket.send(DaemonSocket::AcquireCppSlot);
    data.preprocessed = Preprocessed::create(data.compiler, data.compilerArgs, select, daemonSocket);
    assert(data.preprocessed);
    data.hash = Client::environmentHash(data.resolvedCompiler);
    std::map<std::string, std::string> headers;
    {
        char buf[1024];
        if (!getlogin_r(buf, sizeof(buf))) {
            headers["x-fisk-user"] = buf;
        } else if (const char *user = getenv("USER")) {
            headers["x-fisk-user"] = user;
        } else if (const char *username = getenv("USERNAME")) {
            headers["x-fisk-user"] = username;
        }
    }

    headers["x-fisk-environments"] = data.hash; // always a single one but fisk-slave sends multiple so we'll just keep it like this for now
    Client::parsePath(data.compilerArgs->sourceFile(), &headers["x-fisk-sourcefile"], nullptr);
    headers["x-fisk-client-name"] = Config::name;
    headers["x-fisk-config-version"] = std::to_string(Config::Version);
    headers["x-fisk-npm-version"] = npm_version;
    {
        std::string slave = Config::slave;
        if (!slave.empty())
            headers["x-fisk-slave"] = std::move(slave);
    }
    {
        std::string hostname = Config::hostname;
        if (!hostname.empty())
            headers["x-fisk-client-hostname"] = std::move(hostname);
    }
    const std::string url = schedulerUrl();

    bool releaseCppSlotOnCppFinished = true;
    {
        const std::string releaseCppSlotMode = Config::releaseCppSlotMode;
        if (!strcasecmp("cpp-finished", releaseCppSlotMode.c_str())) {
            releaseCppSlotOnCppFinished = true;
        } else if (!strcasecmp("upload-finished", releaseCppSlotMode.c_str())) {
            releaseCppSlotOnCppFinished = false;
        } else {
            FATAL("Invalid --release-cpp-slot-mode mode %s", releaseCppSlotMode.c_str());
        }
    }

    if (Config::objectCache) {
        DEBUG("Waiting for preprocessed");
        while (!data.preprocessed->done()
               && daemonSocket.state() == DaemonSocket::Connected
               && !data.watchdog->timedOut()) {
            select.exec();
        }
        if (data.watchdog->timedOut()) {
            DEBUG("Have to run locally because we timed out waiting for preprocessing");
            runLocal("watchdog preprocessing");
            return 0; // unreachable
        }
        if (releaseCppSlotOnCppFinished)
            daemonSocket.send(DaemonSocket::ReleaseCppSlot);
        data.watchdog->transition(Watchdog::PreprocessFinished);
        DEBUG("Preprocessed finished");
        preprocessedDuration = data.preprocessed->duration;
        preprocessedSlotDuration = data.preprocessed->slotDuration;

        if (data.preprocessed->exitStatus != 0) {
            ERROR("Failed to preprocess. Running locally");
            runLocal("preprocess error 2");
            return 0; // unreachable
        }

        if (data.preprocessed->stdOut.empty()) {
            ERROR("Empty preprocessed output. Running locally");
            runLocal("preprocess error 3");
            return 0; // unreachable
        }

        MD5_Update(&Client::data().md5, data.hash.c_str(), data.hash.size());

        unsigned char md5Buf[MD5_DIGEST_LENGTH];
        MD5_Final(md5Buf, &data.md5);
        std::string md5 = Client::toHex(md5Buf, sizeof(md5Buf));

        WARN("Got md5: %s", md5.c_str());
        headers["x-fisk-md5"] = std::move(md5);
    }

    SchedulerWebSocket schedulerWebsocket;
    if (!schedulerWebsocket.connect(url + "/compile", headers)) {
        DEBUG("Have to run locally because no server");
        runLocal("scheduler connect error");
        return 0; // unreachable
    }

    select.add(&schedulerWebsocket);
    DEBUG("Starting schedulerWebsocket");
    while (!schedulerWebsocket.done
           && !data.watchdog->timedOut()
           && schedulerWebsocket.state() >= SchedulerWebSocket::None
           && schedulerWebsocket.state() <= SchedulerWebSocket::ConnectedWebSocket) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out trying to connect ro the scheduler");
        runLocal("watchdog scheduler connect");
        return 0; // unreachable
    }

    if (!schedulerWebsocket.error.empty()) {
        DEBUG("Have to run locally because no server: %s", schedulerWebsocket.error.c_str());
        runLocal(schedulerWebsocket.error);
        return 0; // unreachable
    }

    DEBUG("Finished schedulerWebsocket");
    if (!schedulerWebsocket.done) {
        DEBUG("Have to run locally because no server 2");
        runLocal("scheduler connect error 2");
        return 0; // unreachable
    }

    if (schedulerWebsocket.needsEnvironment) {
        data.watchdog->stop();
        std::string dir;
        const std::string tarball = Client::prepareEnvironmentForUpload(&dir);
        // printf("GOT TARBALL %s\n", tarball.c_str());
        if (!tarball.empty()) {
            select.remove(&schedulerWebsocket);
            Client::uploadEnvironment(&schedulerWebsocket, tarball);
        }
        Client::recursiveRmdir(dir);
        runLocal("needs environment");
        return 0;
    }

    if ((data.slaveHostname.empty() && data.slaveIp.empty())
        || !data.slavePort) {
        DEBUG("Have to run locally because no slave");
        runLocal("no slave");
        return 0; // unreachable
    }

    // usleep(1000 * 1000 * 16);
    data.watchdog->transition(Watchdog::AcquiredSlave);
    SlaveWebSocket slaveWebSocket;
    select.add(&slaveWebSocket);
    headers["x-fisk-job-id"] = std::to_string(schedulerWebsocket.jobId);
    headers["x-fisk-slave-ip"] = data.slaveIp;
    if (!schedulerWebsocket.environment.empty()) {
        DEBUG("Changing our environment from %s to %s", data.hash.c_str(), schedulerWebsocket.environment.c_str());
        headers["x-fisk-environments"] = schedulerWebsocket.environment;
    }
    if (!slaveWebSocket.connect(Client::format("ws://%s:%d/compile",
                                               data.slaveHostname.empty() ? data.slaveIp.c_str() : data.slaveHostname.c_str(),
                                               data.slavePort), headers)) {
        DEBUG("Have to run locally because no slave connection");
        runLocal("slave connection failure");
        return 0; // unreachable
    }

    while (!data.watchdog->timedOut()
           && slaveWebSocket.state() < SchedulerWebSocket::ConnectedWebSocket
           && slaveWebSocket.state() > WebSocket::None) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out trying to connect to slave");
        runLocal("watchdog slave connect");
        return 0; // unreachable
    }

    if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because no slave connection 2");
        runLocal("slave connection failure 2");
        return 0;
    }
    data.watchdog->transition(Watchdog::ConnectedToSlave);
    if (!Config::objectCache) {
        DEBUG("Waiting for preprocessed");
        while (!data.preprocessed->done()
               && daemonSocket.state() == DaemonSocket::Connected
               && !data.watchdog->timedOut()) {
            select.exec();
        }
        if (data.watchdog->timedOut()) {
            DEBUG("Have to run locally because we timed out waiting for preprocessing");
            runLocal("watchdog preprocessing");
            return 0; // unreachable
        }

        if (releaseCppSlotOnCppFinished)
            daemonSocket.send(DaemonSocket::ReleaseCppSlot);
        data.watchdog->transition(Watchdog::PreprocessFinished);
        DEBUG("Preprocessed finished");
        preprocessedDuration = data.preprocessed->duration;
        preprocessedSlotDuration = data.preprocessed->slotDuration;

        if (data.preprocessed->exitStatus != 0) {
            ERROR("Failed to preprocess. Running locally");
            runLocal("preprocess error 4");
            return 0; // unreachable
        }

        if (data.preprocessed->stdOut.empty()) {
            ERROR("Empty preprocessed output. Running locally");
            runLocal("preprocess error 5");
            return 0; // unreachable
        }
    }


    std::vector<std::string> args = data.compilerArgs->commandLine;
    args[0] = data.slaveCompiler;
    if (!schedulerWebsocket.extraArguments.empty()) {
        args.reserve(args.size() + schedulerWebsocket.extraArguments.size());
        for (std::string &arg : schedulerWebsocket.extraArguments) {
            args.push_back(std::move(arg));
        }
        schedulerWebsocket.extraArguments.clear(); // since we moved it out
    }

    const bool wait = slaveWebSocket.handshakeResponseHeader("x-fisk-wait") == "true";
    json11::Json::object msg {
        { "commandLine", args },
        { "argv0", data.compiler },
        { "wait", wait },
        { "bytes", static_cast<int>(data.preprocessed->stdOut.size()) }
    };

    const std::string json = json11::Json(msg).dump();
    DEBUG("Sending to slave:\n%s\n", json.c_str());
    slaveWebSocket.wait = wait;
    slaveWebSocket.send(WebSocket::Text, json.c_str(), json.size());
    if (wait) {
        while (!slaveWebSocket.done
               && !data.watchdog->timedOut()
               && (slaveWebSocket.hasPendingSendData() || slaveWebSocket.wait) && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket) {
            select.exec();
        }
        if (slaveWebSocket.done) {
            if (slaveWebSocket.error.empty()) {
                if (!data.preprocessed->stdErr.empty()) {
                    fwrite(data.preprocessed->stdErr.c_str(), sizeof(char), data.preprocessed->stdErr.size(), stderr);
                }
                data.watchdog->transition(Watchdog::UploadedJob);
                data.watchdog->transition(Watchdog::Finished);
                data.watchdog->stop();
                schedulerWebsocket.close("cachehit");

                Client::writeStatistics();
                return data.exitCode;
            } else {
                ERROR("Have to run locally because something happened with the slave %s\n%s",
                      data.compilerArgs->sourceFile().c_str(),
                      slaveWebSocket.error.c_str());

                runLocal("error");
                return 0; // unreachable
            }
        }
        if (data.watchdog->timedOut()) {
            DEBUG("Have to run locally because we timed out waiting for slave");
            runLocal("watchdog");
            return 0; // unreachable
        }
        if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
            DEBUG("Have to run locally because something went wrong with the slave");
            runLocal("slave protocol error 6");
            return 0; // unreachable
        }
    }

    assert(!slaveWebSocket.wait);
    slaveWebSocket.send(WebSocket::Binary, data.preprocessed->stdOut.c_str(), data.preprocessed->stdOut.size());
    data.preprocessed->stdOut.clear();

    while (data.watchdog->timedOut()
           && slaveWebSocket.hasPendingSendData()
           && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out waiting for slave");
        runLocal("watchdog upload");
        return 0; // unreachable
    }

    if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because something went wrong with the slave");
        runLocal("slave connect error 3");
        return 0; // unreachable
    }

    data.watchdog->transition(Watchdog::UploadedJob);
    if (!releaseCppSlotOnCppFinished) {
        daemonSocket.send(DaemonSocket::ReleaseCppSlot);
    }

    while (!data.watchdog->timedOut()
           && !slaveWebSocket.done
           && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out waiting for slave somehoe");
        runLocal("watchdog slave");
        return 0; // unreachable
    }

    if (!slaveWebSocket.done) {
        DEBUG("Have to run locally because something went wrong with the slave, part deux");
        runLocal("slave network error");
        return 0; // unreachable
    }

    if (!slaveWebSocket.error.empty()) {
        DEBUG("Have to run locally because something went wrong with the slave, part trois: %s", slaveWebSocket.error.c_str());
        runLocal("slave error");
        return 0; // unreachable
    }

    if (!data.preprocessed->stdErr.empty()) {
        fwrite(data.preprocessed->stdErr.c_str(), sizeof(char), data.preprocessed->stdErr.size(), stderr);
    }
    data.watchdog->transition(Watchdog::Finished);
    data.watchdog->stop();
    schedulerWebsocket.close("slaved");

    Client::writeStatistics();
    return data.exitCode;
}

static std::string schedulerUrl()
{
    std::string url = Config::scheduler;
    if (url.find("://") == std::string::npos)
        url.insert(0, "ws://");

    size_t colon = url.find(':', 6);
    if (colon != std::string::npos) {
        ++colon;
        while (std::isdigit(url[colon])) {
            ++colon;
        }
    }
    if (colon != url.size())
        url.append(":8097");
    return url;
}

static int clientVerify()
{
    Client::data().watchdog->stop();
    std::map<std::string, std::string> headers;
    {
        char buf[1024];
        if (!getlogin_r(buf, sizeof(buf))) {
            headers["x-fisk-user"] = buf;
        } else if (const char *user = getenv("USER")) {
            headers["x-fisk-user"] = user;
        } else if (const char *username = getenv("USERNAME")) {
            headers["x-fisk-user"] = username;
        }
    }

    headers["x-fisk-client-name"] = Config::name;
    headers["x-fisk-config-version"] = std::to_string(Config::Version);
    headers["x-fisk-npm-version"] = npm_version;
    SchedulerWebSocket schedulerWebsocket;
    if (!schedulerWebsocket.connect(schedulerUrl() + "/client_verify", headers)) {
        FATAL("Failed to connect to scheduler %s", schedulerWebsocket.url().c_str());
        return 109;
    }

    {
        Select select;
        select.add(&schedulerWebsocket);

        DEBUG("Starting schedulerWebsocket");
        while (!schedulerWebsocket.done
               && schedulerWebsocket.state() >= SchedulerWebSocket::None
               && schedulerWebsocket.state() <= SchedulerWebSocket::ConnectedWebSocket) {
            select.exec();
        }
        DEBUG("Finished schedulerWebsocket");
        if (!schedulerWebsocket.done) {
            FATAL("Failed to connect to scheduler 2 %s", schedulerWebsocket.url().c_str());
            return 109;
        }
    }

    return 0;
}
