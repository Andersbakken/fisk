#ifndef SCHEDULERWEBSOCKET_H
#define SCHEDULERWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include <string>

class SchedulerWebSocket : public WebSocket
{
public:
    virtual void onConected() override
    {
        Watchdog::transition(Watchdog::ConnectedToScheduler);
    }
    virtual void onMessage(MessageType type, const void *data, size_t len) override
    {
        if (type == WebSocket::Text) {
            std::string err;
            json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
            if (!err.empty()) {
                ERROR("Failed to parse json from scheduler: %s", err.c_str());
                Watchdog::stop();
                Client::runLocal(Client::acquireSlot(Client::Wait));
                return;
            }
            DEBUG("GOT JSON\n%s", msg.dump().c_str());
            const std::string type = msg["type"].string_value();
            Client::Data &data = Client::data();
            if (type == "needsEnvironment") {
                const std::string execPath = Client::findExecutablePath(Client::data().argv[0]);
                std::string dirname;
                Client::parsePath(execPath.c_str(), 0, &dirname);
                if (execPath.empty() || dirname.empty()) {
                    ERROR("Failed to get current directory");
                    Watchdog::stop();
                    Client::runLocal(Client::acquireSlot(Client::Wait));
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

                assert(dirname.size() && dirname[dirname.size() - 1] == '/');
                std::string command = Client::format("bash -c \"cd %s../envuploader && '%s' './envuploader.js' '--scheduler=%s/uploadenvironment' '--host=%s' '--hash=%s' '--compiler=%s' '--silent' & disown\"",
                                                     dirname.c_str(), Config::nodePath().c_str(), Config::scheduler().c_str(), host,
                                                     data.hash.c_str(), data.resolvedCompiler.c_str());

                DEBUG("system(\"%s\")", command.c_str());
                const int ret = system(command.c_str());
                DEBUG("system -> %d", ret);
                Watchdog::stop();
                Client::runLocal(Client::acquireSlot(Client::Wait));
            } else if (type == "slave") {
                data.slaveIp = msg["ip"].string_value();
                data.slavePort = msg["port"].int_value();
                DEBUG("type %d", msg["port"].type());
                DEBUG("Got here %s:%d", data.slaveIp.c_str(), data.slavePort);
                done = true;
            } else {
                ERROR("Unexpected message type: %s", type.c_str());
            }
            // } else {
            //     printf("Got binary message: %zu bytes\n", len);
        }
    }

    bool done { false };
};


#endif /* SCHEDULERWEBSOCKET_H */
