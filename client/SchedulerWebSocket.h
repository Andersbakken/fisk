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
    virtual void onConnected() override;
    virtual void onMessage(MessageType type, const void *bytes, size_t len) override
    {
        if (type == WebSocket::Text) {
            Client::Data &data = Client::data();
            std::string err;
            json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(bytes), len), err, json11::JsonParse::COMMENTS);
            if (!err.empty()) {
                ERROR("Failed to parse json from scheduler: %s", err.c_str());
                data.watchdog->stop();
                error = "scheduler json parse error";
                done = true;
                return;
            }
            const std::string t = msg["type"].string_value();
            if (t == "needsEnvironment") {
                needsEnvironment = true;
                done = true;
            } else if (t == "builder") {
                data.builderIp = msg["ip"].string_value();
                Client::data().builderHostname = msg["hostname"].string_value();
                environment = msg["environment"].string_value();
                std::vector<json11::Json> extraArgs = msg["extraArgs"].array_items();
                extraArguments.reserve(extraArgs.size());
                for (const json11::Json &arg : extraArgs) {
                    extraArguments.push_back(arg.string_value());
                }
                data.builderPort = static_cast<uint16_t>(msg["port"].int_value());
                jobId = msg["id"].int_value();
                DEBUG("type %d", msg["port"].type());
                DEBUG("Got here %s:%d", data.builderIp.c_str(), data.builderPort);
                done = true;
            } else if (t == "version_mismatch") {
                FATAL("*** Fisk Version mismatch detected, client version: %s minimum client version required: %s. Please update your fisk client.",
                      npm_version, msg["minimum_version"].string_value().c_str());
                _exit(108);
            } else if (t == "version_verified") {
                ERROR("Fisk Version verified, client version: %s minimum client version required: %s",
                      npm_version, msg["minimum_version"].string_value().c_str());
                done = true;
            } else {
                ERROR("Unexpected message type: %s", t.c_str());
            }
            // } else {
            //     printf("Got binary message: %zu bytes\n", len);
        }
    }

    bool done { false };
    std::string error;
    bool needsEnvironment { false };
    int jobId { 0 };
    std::string environment;
    std::vector<std::string> extraArguments;
};


#endif /* SCHEDULERWEBSOCKET_H */
