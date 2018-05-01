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

int main(int argc, char **argv)
{
    std::string compiler = Client::findCompiler(argc, argv);
    if (compiler.empty()) {
        Log::error("Can't find executable for %s", argv[0]);
        return 1;
    }

    Config::init();

    std::vector<std::string> args(argc);
    for (int i=0; i<argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = argv[i];
    }
    std::shared_ptr<CompilerArgs> compilerArgs = CompilerArgs::create(args);
    if (!compilerArgs || compilerArgs->mode != CompilerArgs::Compile) {
        Log::debug("Have to run locally because mode %s",
                   CompilerArgs::modeName(compilerArgs ? compilerArgs->mode : CompilerArgs::Invalid));
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }

    if (!Config::noLocal()) {
        std::unique_ptr<Client::Slot> slot = Client::acquireSlot(Client::Try);
        if (slot)
            return Client::runLocal(compiler, argc, argv, std::move(slot));
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
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }

    const std::string hash = Client::environmentHash(compiler);
    Log::info("Got hash %s for %s", hash.c_str(), compiler.c_str());
    if (!websocket.connect(Config::scheduler() + "/compile", hash)) {
        Log::debug("Have to run locally because no server");
        Watchdog::stop();
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }
    // json11::Json my_json = json11::Json::object {
    //     { "client", Config::clientName() },
    //     { "type", "compile" }
    // };
    // const std::string msg = my_json.dump();

    // if (!websocket.send(WebSocket::Text, msg.c_str(), msg.size())) {
    //     Log::debug("Have to run locally because no send");
    //     Watchdog::stop();
    //     return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    // }

    std::string slaveIp;
    uint16_t slavePort = 0;

    if (!websocket.process([&compiler, &hash, argc, argv, &slavePort, &slaveIp](WebSocket::Mode type, const void *data, size_t len) {
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

                        std::string command = Client::format("bash -c \"cd %s/../envuploader && '%s' './index.js' '--scheduler=%s/uploadenvironment' '--host=%s' '--hash=%s' '--compiler=%s' '--silent' & disown\"",
                                                             dirname.c_str(), Config::node().c_str(), Config::scheduler().c_str(), host, hash.c_str(), compiler.c_str());

                        Log::debug("system(\"%s\")", command.c_str());
                        system(command.c_str());
                        Watchdog::stop();
                        Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
                    } else if (type == "slave") {
                        slaveIp = msg["ip"].string_value();
                        slavePort = msg["port"].int_value();
                        Log::debug("type %d", msg["port"].type());
                        Log::debug("Got here %s:%d", slaveIp.c_str(), slavePort);
                    } else {
                        Log::error("Unexpected message type: %s", type.c_str());
                    }
                } else {
                    printf("Got binary message: %zu bytes\n", len);
                }
            })) {
        Watchdog::stop();
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }

    if (!slaveIp.empty() && slavePort) {
        preprocessed->wait();
        if (preprocessed->exitStatus != 0) {
            Log::error("Failed to preprocess. Running locally");
            Watchdog::stop();
            return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        }
        Watchdog::transition(Watchdog::AcquiredSlave);
        WebSocket slaveWS;
        if (!slaveWS.connect(Client::format("ws://%s:%d/compile", slaveIp.c_str(), slavePort), hash)) {
            Log::debug("Have to run locally because no slave connection");
            Watchdog::stop();
            return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
        }
        Watchdog::transition(Watchdog::ConnectedToSlave);
        args[0] = compiler;
        json11::Json::object msg {
            { "commandLine", args },
            { "bytes", static_cast<int>(preprocessed->stdOut.size()) }
        };
        std::string json = json11::Json(msg).dump();
        slaveWS.send(WebSocket::Text, json.c_str(), json.size());
        slaveWS.send(WebSocket::Binary, preprocessed->stdOut.c_str(), preprocessed->stdOut.size());
        Watchdog::transition(Watchdog::WaitingForResponse);
        if (!slaveWS.process([](WebSocket::Mode type, const void *data, size_t len) {


                })) {
        }
    } else {
        Log::debug("Have to run locally because no slave");
        Watchdog::stop();
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }
    return 0;
}

