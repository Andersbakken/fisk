#ifndef SCHEDULERWEBSOCKET_H
#define SCHEDULERWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include "Watchdog.h"
#include <string>

extern "C" const char *npm_version;

class SchedulerWebSocket : public WebSocket
{
public:
    virtual void onConnected() override
    {
        Client::data().watchdog->transition(Watchdog::ConnectedToScheduler);
    }
    virtual void onMessage(MessageType type, const void *data, size_t len) override
    {
        if (type == WebSocket::Text) {
            std::string err;
            json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
            if (!err.empty()) {
                ERROR("Failed to parse json from scheduler: %s", err.c_str());
                Client::data().watchdog->stop();
                Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "scheduler json parse error");
                return;
            }
            const std::string type = msg["type"].string_value();
            if (type == "needsEnvironment") {
                needsEnvironment = true;
                done = true;
            } else if (type == "slave") {
                slaveIp = msg["ip"].string_value();
                slaveHostname = msg["hostname"].string_value();
                environment = msg["environment"].string_value();
                slavePort = msg["port"].int_value();
                jobId = msg["id"].int_value();
                Client::data().maintainSemaphores = msg["maintain_semaphores"].bool_value();
                DEBUG("type %d", msg["port"].type());
                DEBUG("Got here %s:%d", slaveIp.c_str(), slavePort);
                done = true;
            } else if (type == "version_mismatch") {
                FATAL("Version mismatch detected, client version: %s minimum client version required: %s",
                      npm_version, msg["minimum_version"].string_value().c_str());
                _exit(108);
            } else {
                ERROR("Unexpected message type: %s", type.c_str());
            }
            // } else {
            //     printf("Got binary message: %zu bytes\n", len);
        }
    }

    bool done { false };
    bool responseDone { false };
    bool needsEnvironment { false };
    int jobId { 0 };
    uint16_t slavePort { 0 };
    std::string slaveIp, slaveHostname, environment;
};


#endif /* SCHEDULERWEBSOCKET_H */
