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

    std::vector<std::string> args(argc);
    for (size_t i=0; i<argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = argv[i];
    }
    std::shared_ptr<CompilerArgs> compilerArgs = CompilerArgs::create(args);
    if (!compilerArgs || compilerArgs->mode != CompilerArgs::Compile) {
        Log::debug("Have to run locally because mode %s",
                   CompilerArgs::modeName(compilerArgs ? compilerArgs->mode : CompilerArgs::Invalid));
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }

    // Watchdog::start(compiler, argc, argv);
    Config config;
    WebSocket websocket;

    struct sigaction act;
    memset(&act, 0, sizeof(struct sigaction));
    act.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &act, 0);

    if (!websocket.connect(config.scheduler())) {
        Log::debug("Have to run locally because no server");
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }
    json11::Json my_json = json11::Json::object {
        { "client", config.clientName() },
        { "foobar", false }
    };
    const std::string msg = my_json.dump();

    if (!websocket.send(WebSocket::Text, msg.c_str(), msg.size())) {
        Log::debug("Have to run locally because no send");
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }

    if (!websocket.process([](WebSocket::Mode type, const void *data, size_t len) {
                if (type == WebSocket::Text) {
                    printf("Got message: \n");
                    fwrite(data, 1, len, stdout);
                    printf("\n");
                } else {
                    printf("Got binary message: %zu bytes\n", len);
                }
            })) {
        return Client::runLocal(compiler, argc, argv, Client::acquireSlot(Client::Wait));
    }
    return 0;
}

