#include "Client.h"
#include "CompilerArgs.h"
#include "Config.h"
#include "BuilderWebSocket.h"
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

    if (Config::dumpSha1) {
        return Client::dumpSha1();
    }

    if (!Config::dumpSlots) {
        if (!Client::findCompiler(preresolved)) {
            FATAL("Can't find executable for %s %s", data.argv[0], preresolved.c_str());
            return 107;
        }

        DEBUG("Resolved compiler %s (%s) to \"%s\" \"%s\" \"%s\")",
              data.argv[0], preresolved.c_str(),
              data.compiler.c_str(), data.resolvedCompiler.c_str(),
              data.builderCompiler.c_str());
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

    Client::CompilerInfo info;
    {
        std::vector<std::string> args(data.argc);
        for (int i=0; i<data.argc; ++i) {
            // printf("%zu: %s\n", i, argv[i]);
            args[i] = data.argv[i];
        }

        info = Client::compilerInfo(data.resolvedCompiler);
        data.hash = info.hash;
        data.compilerArgs = CompilerArgs::create(info, std::move(args), &data.localReason);
    }
    if (!data.compilerArgs) {
        DEBUG("Have to run locally");
        runLocal(Client::format("compiler args parse failure: %s", CompilerArgs::localReasonToString(data.localReason)));
        return 0; // unreachable
    }

    daemonSocket.send(DaemonSocket::AcquireCppSlot);
    data.preprocessed = Preprocessed::create(data.compiler, data.compilerArgs, &select, &daemonSocket);
    assert(data.preprocessed);

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

    headers["x-fisk-environments"] = data.hash; // always a single one but fisk-builder sends multiple so we'll just keep it like this for now
    Client::parsePath(data.compilerArgs->sourceFile(), &headers["x-fisk-sourcefile"], nullptr);
    headers["x-fisk-client-name"] = Config::name;
    headers["x-fisk-config-version"] = std::to_string(Config::Version);
    headers["x-fisk-npm-version"] = npm_version;
    headers["x-fisk-supports-compressed-response"] = "true";
    {
        std::string builder = Config::builder;
        if (!builder.empty())
            headers["x-fisk-builder"] = std::move(builder);
    }
    {
        std::string labels = Config::labels;
        if (!labels.empty())
            headers["x-fisk-builder-labels"] = std::move(labels);
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

        VERBOSE("SHA1'ing compiler hash [%s]", data.hash.c_str());
        Client::data().sha1Update(data.hash.c_str(), data.hash.size());

        const std::string tag = Config::objectCacheTag;
        VERBOSE("SHA1'ing object cache tag [%s]", tag.c_str());
        Client::data().sha1Update(tag.c_str(), tag.size());

        unsigned char sha1Buf[SHA_DIGEST_LENGTH];
        Client::data().sha1Final(sha1Buf);
        std::string sha1 = Client::toHex(sha1Buf, sizeof(sha1Buf));
        WARN("Got sha1: %s", sha1.c_str());
        headers["x-fisk-sha1"] = std::move(sha1);
    }

    std::unique_ptr<SchedulerWebSocket> schedulerWebsocket;
    do {
        if (schedulerWebsocket) {
            select.remove(schedulerWebsocket.get());
        }
        schedulerWebsocket.reset(new SchedulerWebSocket);
        if (!schedulerWebsocket->connect(url + "/compile", headers)) {
            DEBUG("Have to run locally because no server");
            runLocal("scheduler connect error");
            return 0; // unreachable
        }

        select.add(schedulerWebsocket.get());
        DEBUG("Starting schedulerWebsocket");
        while (!schedulerWebsocket->done
               && !data.watchdog->timedOut()
               && schedulerWebsocket->state() >= WebSocket::None
               && schedulerWebsocket->state() <= WebSocket::ConnectedWebSocket) {
            select.exec();
        }

        if (data.watchdog->timedOut()) {
            DEBUG("Have to run locally because we timed out trying to connect ro the scheduler");
            runLocal("watchdog scheduler connect");
            return 0; // unreachable
        }
    } while (!schedulerWebsocket->done);

    if (!schedulerWebsocket->error.empty()) {
        DEBUG("Have to run locally because no server: %s", schedulerWebsocket->error.c_str());
        runLocal(schedulerWebsocket->error);
        return 0; // unreachable
    }

    if (schedulerWebsocket->needsEnvironment) {
        data.watchdog->stop();
        std::string dir;
        const std::string tarball = Client::prepareEnvironmentForUpload(&dir);
        // printf("GOT TARBALL %s\n", tarball.c_str());
        if (!tarball.empty()) {
            select.remove(schedulerWebsocket.get());
            Client::uploadEnvironment(schedulerWebsocket.get(), tarball);
        }
        Client::recursiveRmdir(dir);
        runLocal("needs environment");
        return 0;
    }

    const bool objectCache = schedulerWebsocket->handshakeResponseHeader("x-fisk-object-cache") == "true";
    if (!objectCache && Config::objectCache) {
        const auto it = headers.find("x-fisk-sha1");
        if (it != headers.end()) {
            headers.erase(it);
        }
    }

    if ((data.builderHostname.empty() && data.builderIp.empty())
        || !data.builderPort) {
        ERROR("No builder available for environment %s (source: %s). "
              "This may indicate no builders have this compiler environment or a compatible cross-compiler.",
              data.hash.c_str(),
              data.compilerArgs ? data.compilerArgs->sourceFile().c_str() : "unknown");
        runLocal("no builder");
        return 0; // unreachable
    }

    // usleep(1000 * 1000 * 16);
    data.watchdog->transition(Watchdog::AcquiredBuilder);
    BuilderWebSocket builderWebSocket;
    builderWebSocket.hasJSONDiagnostics = ((Config::jsonDiagnostics || Config::jsonDiagnosticsRaw)
                                           && info.type == Client::CompilerType::GCC
                                           && info.version.major >= 10);
    select.add(&builderWebSocket);
    headers["x-fisk-job-id"] = std::to_string(schedulerWebsocket->jobId);
    headers["x-fisk-builder-ip"] = data.builderIp;

    headers["x-fisk-priority"] = std::to_string(Config::priority);
    if (!schedulerWebsocket->environment.empty()) {
        DEBUG("Changing our environment from %s to %s", data.hash.c_str(), schedulerWebsocket->environment.c_str());
        headers["x-fisk-environments"] = schedulerWebsocket->environment;
    }
    const std::string builderUrl = Client::format("ws://%s:%d/compile",
                                                  data.builderHostname.empty() ? data.builderIp.c_str() : data.builderHostname.c_str(),
                                                  data.builderPort);
    DEBUG("Connecting to builder %s", builderUrl.c_str());
    if (!builderWebSocket.connect(builderUrl, headers)) {
        DEBUG("Have to run locally because no builder connection");
        runLocal("builder connection failure");
        return 0; // unreachable
    }

    while (!data.watchdog->timedOut()
           && builderWebSocket.state() < WebSocket::ConnectedWebSocket
           && builderWebSocket.state() > WebSocket::None) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out trying to connect to builder");
        runLocal("watchdog builder connect");
        return 0; // unreachable
    }

    if (builderWebSocket.state() != WebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because no builder connection 2");
        runLocal("builder connection failure 2");
        return 0;
    }
    data.watchdog->transition(Watchdog::ConnectedToBuilder);
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
    args[0] = data.builderCompiler;
    if (!schedulerWebsocket->extraArguments.empty()) {
        args.reserve(args.size() + schedulerWebsocket->extraArguments.size());
        for (std::string &arg : schedulerWebsocket->extraArguments) {
            args.push_back(std::move(arg));
        }
        schedulerWebsocket->extraArguments.clear(); // since we moved it out
    }

    const bool wait = builderWebSocket.handshakeResponseHeader("x-fisk-wait") == "true";
    json11::Json::object msg {
        { "commandLine", args },
        { "argv0", data.compiler },
        { "wait", wait },
        { "compressed", Config::compress.get() },
        { "bytes", static_cast<int>(data.preprocessed->stdOut.size()) }
    };

    const std::string json = json11::Json(msg).dump();
    DEBUG("Sending to builder:\n%s\n", json.c_str());
    builderWebSocket.wait = wait;
    builderWebSocket.send(WebSocket::Text, json.c_str(), json.size());
    if (wait) {
        while (!builderWebSocket.done
               && !data.watchdog->timedOut()
               && (builderWebSocket.hasPendingSendData() || builderWebSocket.wait) && builderWebSocket.state() == WebSocket::ConnectedWebSocket) {
            select.exec();
        }
        if (builderWebSocket.done) {
            if (builderWebSocket.error.empty()) {
                if (!data.preprocessed->stdErr.empty()) {
                    if (builderWebSocket.hasJSONDiagnostics) {
                        const std::string formatted = Client::formatJSONDiagnostics(data.preprocessed->stdErr);
                        if (!formatted.empty()) {
                            fwrite(formatted.c_str(), sizeof(char), formatted.size(), stderr);
                        }
                    } else {
                        fwrite(data.preprocessed->stdErr.c_str(), sizeof(char), data.preprocessed->stdErr.size(), stderr);
                    }
                }
                data.watchdog->transition(Watchdog::UploadedJob);
                data.watchdog->transition(Watchdog::Finished);
                data.watchdog->stop();
                schedulerWebsocket->close("cachehit");

                Client::writeStatistics();
                return data.exitCode;
            } else {
                ERROR("Builder error while compiling %s on %s:%d (environment: %s): %s",
                      data.compilerArgs->sourceFile().c_str(),
                      data.builderHostname.empty() ? data.builderIp.c_str() : data.builderHostname.c_str(),
                      data.builderPort,
                      data.hash.c_str(),
                      builderWebSocket.error.c_str());

                runLocal("error");
                return 0; // unreachable
            }
        }
        if (data.watchdog->timedOut()) {
            DEBUG("Have to run locally because we timed out waiting for builder");
            runLocal("watchdog");
            return 0; // unreachable
        }
        if (builderWebSocket.state() != WebSocket::ConnectedWebSocket) {
            DEBUG("Have to run locally because something went wrong with the builder");
            runLocal("builder protocol error 6");
            return 0; // unreachable
        }
    }

    assert(!builderWebSocket.wait);
    builderWebSocket.send(WebSocket::Binary, data.preprocessed->stdOut.data(), data.preprocessed->stdOut.size());
    if (!Config::storePreprocessedDataOnError)
        data.preprocessed->stdOut.clear();

    while (!data.watchdog->timedOut()
           && builderWebSocket.hasPendingSendData()
           && builderWebSocket.state() == WebSocket::ConnectedWebSocket) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out waiting for builder");
        runLocal("watchdog upload");
        return 0; // unreachable
    }

    if (builderWebSocket.state() != WebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because something went wrong with the builder");
        runLocal("builder connect error 3");
        return 0; // unreachable
    }

    data.watchdog->transition(Watchdog::UploadedJob);
    if (!releaseCppSlotOnCppFinished) {
        daemonSocket.send(DaemonSocket::ReleaseCppSlot);
    }

    while (!data.watchdog->timedOut()
           && !builderWebSocket.done
           && builderWebSocket.state() == WebSocket::ConnectedWebSocket) {
        select.exec();
    }

    if (data.watchdog->timedOut()) {
        DEBUG("Have to run locally because we timed out waiting for builder somehow");
        runLocal("watchdog builder");
        return 0; // unreachable
    }

    if (!builderWebSocket.done) {
        DEBUG("Have to run locally because something went wrong with the builder, part deux");
        runLocal("builder network error");
        return 0; // unreachable
    }

    if (!builderWebSocket.error.empty()) {
        DEBUG("Have to run locally because something went wrong with the builder, part trois: %s", builderWebSocket.error.c_str());
        runLocal("builder error");
        return 0; // unreachable
    }

    data.watchdog->transition(Watchdog::Finished);
    data.watchdog->stop();
    schedulerWebsocket->close("builderd");

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
               && schedulerWebsocket.state() >= WebSocket::None
               && schedulerWebsocket.state() <= WebSocket::ConnectedWebSocket) {
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
