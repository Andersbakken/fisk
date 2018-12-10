#ifndef SLAVEWEBSOCKET_H
#define SLAVEWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include "Watchdog.h"
#include <string>

class SlaveWebSocket : public WebSocket
{
public:
    bool wait { false };
    virtual void onConected() override
    {
    }
    virtual void onMessage(MessageType type, const void *data, size_t len) override
    {
        DEBUG("GOT MESSAGE %s %zu bytes", type == WebSocket::Text ? "text" : "binary", len);
        if (type == WebSocket::Text) {
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

            if (type == "stderr") {
                const std::string output = msg["data"].string_value();
                if (!output.empty()) {
                    fwrite(output.c_str(), 1, output.size(), stderr);
                }
                return;
            }

            if (type == "stdout") {
                const std::string output = msg["data"].string_value();
                if (!output.empty()) {
                    fwrite(output.c_str(), 1, output.size(), stdout);
                }
                return;
            }

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

            if (type != "response") {
                ERROR("Unexpected message type %s. Wanted \"response\"", msg["type"].string_value().c_str());
                Client::data().watchdog->stop();
                Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error");
                return;
            }

            const auto success = msg["success"];
            if (success.is_bool() && !success.bool_value()) {
                ERROR("Slave had some issue. Build locally");
                Client::data().watchdog->stop();
                Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave run failure");
                return;
            }

            json11::Json::array index = msg["index"].array_items();
            Client::data().exitCode = msg["exitCode"].int_value();
            if (!index.empty()) {
                files.resize(index.size());
                for (size_t i=0; i<index.size(); ++i) {
                    File &ff = files[i];
                    ff.path = index[i]["path"].string_value();
                    ff.remaining = index[i]["bytes"].int_value();
                    totalWritten += ff.remaining;
                    if (ff.path.empty()) {
                        ERROR("No file for idx: %zu", i);
                        Client::data().watchdog->stop();
                        Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error 2");
                        return;
                    }
                }
                f = fopen(files[0].path.c_str(), "w");
                if (!f) {
                    ERROR("Can't open file: %s", files[0].path.c_str());
                    Client::data().watchdog->stop();
                    Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave file open error");
                    return;
                }
                assert(f);
                if (files[0].remaining)
                    fill(0, 0);
            } else {
                done = true;
            }
        } else {
            DEBUG("Got binary data: %zu bytes", len);
            if (files.empty()) {
                ERROR("Unexpected binary data (%zu bytes)", len);
                Client::data().watchdog->stop();
                Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error 3");
                return;
            }
            fill(reinterpret_cast<const unsigned char *>(data), len);
            if (files.empty()) {
                done = true;
                Client::data().totalWritten = totalWritten;
            }
        }
    }

    void fill(const unsigned char *data, const size_t bytes)
    {
        assert(f);
        auto *front = &files.front();
        size_t offset = 0;
        do {
            const size_t b = std::min(front->remaining, bytes);
            assert(f);
            if (b) {
                if (fwrite(data + offset, 1, b, f) != b) {
                    ERROR("Failed to write to file %s (%d %s)", front->path.c_str(), errno, strerror(errno));
                    Client::data().watchdog->stop();
                    Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave file write error");
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
                if (!f) {
                    Client::data().watchdog->stop();
                    Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave file open error 2");
                    return;
                }

                assert(f);
                continue;
            }
        } while (offset < bytes);
        if (offset < bytes) {
            ERROR("Extraneous bytes. Abandon ship (%zu/%zu)", offset, bytes);
            Client::data().watchdog->stop();
            Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "slave protocol error 4");
        }
    }

    struct File {
        std::string path;
        size_t remaining;
    };

    std::vector<File> files;
    size_t totalWritten { 0 };
    FILE *f { 0 };
    bool done { false };
};


#endif /* SLAVEWEBSOCKET_H */
