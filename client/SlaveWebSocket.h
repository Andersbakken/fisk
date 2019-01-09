#ifndef SLAVEWEBSOCKET_H
#define SLAVEWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include "Watchdog.h"
#include "JobReceiver.h"
#include <string>

class SlaveWebSocket : public WebSocket, public JobReceiver
{
public:
    bool wait { false };
    virtual void onConected() override
    {
    }
    virtual void onMessage(MessageType messageType, const void *data, size_t len) override
    {
        DEBUG("GOT MESSAGE %s %zu bytes", messageType == WebSocket::Text ? "text" : "binary", len);
        if (handleMessage(messageType, data, len, &done))
            return;

        if (messageType != WebSocket::Text) {
            ERROR("Unexpected binary message");
            Client::data().watchdog->stop();
            Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error 4");
            return;
        }

        WARN("Got message from slave %s %s", url().c_str(),
             std::string(reinterpret_cast<const char *>(data), len).c_str());
        std::string err;
        json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
        if (!err.empty()) {
            ERROR("Failed to parse json from slave: %s", err.c_str());
            Client::data().watchdog->stop();
            Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave json parse error");
            return;
        }

        const std::string type = msg["type"].string_value();

        if (type == "resume") {
            wait = false;
            DEBUG("Resume happened. Let's upload data");
            return;
        }

        if (type == "heartbeat") {
            DEBUG("Got a heartbeat.");
            Client::data().watchdog->heartbeat();
            return;
        }

        ERROR("Unexpected message type %s. Wanted \"response\"", msg["type"].string_value().c_str());
        Client::data().watchdog->stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error 5");
    }

    bool done { false };
};


#endif /* SLAVEWEBSOCKET_H */
