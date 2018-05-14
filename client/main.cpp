#include "Client.h"
#include "CompilerArgs.h"
#include "Config.h"
#include "Log.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <json11.hpp>
#include <climits>
#include <cstdlib>
#include <string.h>
#include <unistd.h>
#include <signal.h>

static std::string compiler; // this is the next one on the path and the one we will exec if we run locally
static std::string resolvedCompiler; // this one resolves g++ to gcc and is used for generating hash
static int argc = 0;
static char **argv = 0;;
static std::string hash;
int main(int argcIn, char **argvIn)
{
    Config::init();
    std::string logLevel = Config::logLevel();
    std::string logFile = Config::logFile();
    const char *env;
    if ((env = getenv("FISK_LOG"))) {
        logLevel = env;
    } else if ((env = getenv("FISK_DEBUG"))) {
        logLevel = env;
    }

    if ((env = getenv("FISK_LOG_FILE"))) {
        logFile = env;
    }

    bool disabled = false;
    if ((env = getenv("FISK_DISABLED"))) {
        disabled = strlen(env) && !strcmp(env, "0");
    }

    const char *preresolved = getenv("FISK_COMPILER");

    argv = new char *[argcIn + 1];
    std::unique_ptr<char *[]> argvptr(argv);
    for (int i=0; i<argcIn; ++i) {
        if (!strncmp("--fisk-log-level=", argvIn[i], 17) || !strncmp("--fisk-log-debug=", argvIn[i], 17)) {
            logLevel = argvIn[i] + 17;
        } else if (!strncmp("--fisk-log-file=", argvIn[i], 16)) {
            logFile = argvIn[i] + 16;
        } else if (!strncmp("--fisk-compiler=", argvIn[i], 16)) {
            preresolved = argvIn[i] + 16;
        } else if (!strcmp("--fisk-disabled", argvIn[i])) {
            disabled = true;
        } else {
            argv[argc++] = argvIn[i];
        }
    }
    Log::Level level = Log::Silent;
    if (!logLevel.empty()) {
        bool ok;
        level = Log::stringToLevel(logLevel.c_str(), &ok);
        if (!ok) {
            fprintf(stderr, "Invalid log level: %s (\"Debug\", \"Warning\", \"Error\" or \"Silent\")\n", logLevel.c_str());
            return 1;
        }
    }

    Log::init(level, std::move(logFile));

    std::string slaveCompiler; // this is the one that actually will exist on the slave
    compiler = Client::findCompiler(argv[0], preresolved, &resolvedCompiler, &slaveCompiler);
    Log::debug("Resolved compiler %s (%s) to \"%s\" \"%s\" \"%s\")",
               argv[0], preresolved ? preresolved : "",
               compiler.c_str(), resolvedCompiler.c_str(), slaveCompiler.c_str());
    if (compiler.empty()) {
        Log::error("Can't find executable for %s", argv[0]);
        return 1;
    }

    if (disabled) {
        Log::debug("Have to run locally because we're disabled");
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    std::vector<std::string> args(argc);
    for (int i=0; i<argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = argv[i];
    }
    std::shared_ptr<CompilerArgs> compilerArgs = CompilerArgs::create(args);
    if (!compilerArgs
        || compilerArgs->mode != CompilerArgs::Compile
        || compilerArgs->flags & CompilerArgs::StdinInput
        || compilerArgs->sourceFileIndexes.size() != 1) {
        Log::debug("Have to run locally because mode %s - flags 0x%x - source files: %zu",
                   CompilerArgs::modeName(compilerArgs ? compilerArgs->mode : CompilerArgs::Invalid),
                   compilerArgs ? compilerArgs->flags : 0, compilerArgs ? compilerArgs->sourceFileIndexes.size() : 0);
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    if (!Config::noLocal()) {
        std::unique_ptr<Client::Slot> slot = Client::acquireSlot(Client::Try);
        if (slot) {
            Client::runLocal(compiler, argc, argv, std::move(slot));
            return 0; // unreachable
        }
    }
    Watchdog::start(compiler, argc, argv);
    WebSocket websocket;

    struct sigaction act;
    memset(&act, 0, sizeof(struct sigaction));
    act.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &act, 0);

    std::unique_ptr<Client::Preprocessed> preprocessed = Client::preprocess(compiler, compilerArgs);
    if (!preprocessed) {
        Log::error("Failed to preprocess");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    hash = Client::environmentHash(resolvedCompiler);
    std::vector<std::string> compatibleHashes = Config::compatibleHashes(hash);;
    std::string hashes = hash;
    for (const std::string &compatibleHash : compatibleHashes) {
        hashes += ";" + compatibleHash;
    }
    Log::debug("Got hashes %s for %s", hashes.c_str(), resolvedCompiler.c_str());
    std::map<std::string, std::string> headers;
    headers["x-fisk-environments"] = hashes;
    headers["x-fisk-client-name"] = Config::name();
    {
        std::string hostname = Config::hostname();
        if (!hostname.empty())
            headers["x-fisk-client-hostname"] = std::move(hostname);
    }
    if (!websocket.connect(Config::scheduler() + "/compile", headers)) {
        Log::debug("Have to run locally because no server");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    std::string slaveIp;
    uint16_t slavePort = 0;

    if (!websocket.exec([&slavePort, &slaveIp, &websocket](WebSocket::Mode type, const void *data, size_t len) {
                if (type == WebSocket::Text) {
                    std::string err;
                    json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
                    if (!err.empty()) {
                        Log::error("Failed to parse json from scheduler: %s", err.c_str());
                        Watchdog::stop();
                        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                        return;
                    }
                    Log::debug("GOT JSON\n%s", msg.dump().c_str());
                    const std::string type = msg["type"].string_value();
                    if (type == "needsEnvironment") {
                        const std::string execPath = Client::findExecutablePath(argv[0]);
                        std::string dirname;
                        Client::parsePath(execPath.c_str(), 0, &dirname);
                        if (execPath.empty() || dirname.empty()) {
                            Log::error("Failed to get current directory");
                            Watchdog::stop();
                            Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                            return;
                        }
#ifdef __APPLE__
                        const char *host = "Darwin x86_64";
#elif defined(__linux__) && defined(__i686)
                        const char *host = "Linux i686"
#elif defined(__linux__) && defined(__x86_64)
                        const char *host = "Linux x86_64";
#else
#error unsupported platform
#endif

                        std::string command = Client::format("bash -c \"cd %s/../envuploader && '%s' './envuploader.js' '--scheduler=%s/uploadenvironment' '--host=%s' '--hash=%s' '--compiler=%s' '--silent' & disown\"",
                                                             dirname.c_str(), Config::nodePath().c_str(), Config::scheduler().c_str(), host, hash.c_str(), resolvedCompiler.c_str());

                        Log::debug("system(\"%s\")", command.c_str());
                        system(command.c_str());
                        Watchdog::stop();
                        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                    } else if (type == "slave") {
                        slaveIp = msg["ip"].string_value();
                        slavePort = msg["port"].int_value();
                        Log::debug("type %d", msg["port"].type());
                        Log::debug("Got here %s:%d", slaveIp.c_str(), slavePort);
                        websocket.exit();
                    } else {
                        Log::error("Unexpected message type: %s", type.c_str());
                    }
                    // } else {
                    //     printf("Got binary message: %zu bytes\n", len);
                }
            })) {
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    if (slaveIp.empty() || !slavePort) {
        Log::debug("Have to run locally because no slave");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }

    preprocessed->wait();
    if (preprocessed->exitStatus != 0) {
        Log::error("Failed to preprocess. Running locally");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }
    // usleep(1000 * 1000 * 16);
    Watchdog::transition(Watchdog::AcquiredSlave);
    WebSocket slaveWS;
    if (!slaveWS.connect(Client::format("ws://%s:%d/compile", slaveIp.c_str(), slavePort), headers)) {
        Log::debug("Have to run locally because no slave connection");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable

    }
    Watchdog::transition(Watchdog::ConnectedToSlave);
    args[0] = slaveCompiler;
    json11::Json::object msg {
        { "commandLine", args },
        { "argv0", compiler },
        { "bytes", static_cast<int>(preprocessed->stdOut.size()) }
    };
    std::string json = json11::Json(msg).dump();
    slaveWS.send(WebSocket::Text, json.c_str(), json.size());
    slaveWS.send(WebSocket::Binary, preprocessed->stdOut.c_str(), preprocessed->stdOut.size());
    Watchdog::transition(Watchdog::WaitingForResponse);
    struct File {
        std::string path;
        size_t remaining;
    };
    std::vector<File> files;
    FILE *f = 0;
    int exitCode = 0;
    auto fill = [&files, &f](const unsigned char *data, const size_t bytes) {
        assert(f);
        auto *front = &files.front();
        size_t offset = 0;
        do {
            const size_t b = std::min(front->remaining, bytes);
            assert(f);
            if (b) {
                if (fwrite(data + offset, 1, b, f) != b) {
                    Log::error("Failed to write to file %s (%d %s)", front->path.c_str(), errno, strerror(errno));
                    Watchdog::stop();
                    Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                    return;
                }
                offset += b;
                front->remaining -= b;
            }
            if (!front->remaining) {
                fclose(f);
                f = 0;
                files.erase(files.begin());
                if (files.empty())
                    break;
                front = &files.front();
                f = fopen(front->path.c_str(), "w");
                continue;
            }
        } while (offset < bytes);
        if (offset < bytes) {
            Log::error("Extraneous bytes. Abandon ship (%zu/%zu)", offset, bytes);
            Watchdog::stop();
            Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        }
    };
    auto process = [&files, &f, &fill, &exitCode, &slaveWS](WebSocket::Mode type, const void *data, size_t len) {
        Log::debug("GOT MESSAGE %s %zu bytes", type == WebSocket::Text ? "text" : "binary", len);
        if (type == WebSocket::Text) {
            Log::debug("GOT MSG [%s]", std::string(reinterpret_cast<const char *>(data), len).c_str());
            std::string err;
            json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
            if (!err.empty()) {
                Log::error("Failed to parse json from slave: %s", err.c_str());
                Watchdog::stop();
                Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                return;
            }

            const std::string type = msg["type"].string_value();

            if (type == "output") {
                const std::string output = msg["data"].string_value();
                if (!output.empty()) {
                    fwrite(output.c_str(), 1, output.size(), msg["stderr"].bool_value() ? stderr : stdout);
                }
                return;
            }

            if (type != "response") {
                Log::error("Unexpected message type %s. Wanted \"response\"", msg["type"].string_value().c_str());
                Watchdog::stop();
                Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                return;
            }

            json11::Json::array index = msg["index"].array_items();
            exitCode = msg["exitCode"].int_value();
            if (index.empty()) {
                Log::error("No files?");
                Watchdog::stop();
                Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                return;
            }
            files.resize(index.size());
            for (size_t i=0; i<index.size(); ++i) {
                File &ff = files[i];
                ff.path = index[i]["path"].string_value();
                ff.remaining = index[i]["bytes"].int_value();
                if (ff.path.empty()) {
                    Log::error("No file for idx: %zu", i);
                    Watchdog::stop();
                    Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                    return;
                }
            }
            f = fopen(files[0].path.c_str(), "w");
            if (files[0].remaining)
                fill(0, 0);
        } else {
            Log::debug("Got binary data: %zu bytes", len);
            if (files.empty()) {
                Log::error("Unexpected binary data (%zu bytes)", len);
                Watchdog::stop();
                Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                return;
            }
            fill(reinterpret_cast<const unsigned char *>(data), len);
            if (files.empty())
                slaveWS.exit();
        };
    };
    if (!slaveWS.exec(process)) { // ### This could happen even if we've already written all the data
        Log::debug("Have to run locally because failed to get message from slave");
        Watchdog::stop();
        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        return 0; // unreachable
    }
    Watchdog::stop();
    return exitCode;
}
