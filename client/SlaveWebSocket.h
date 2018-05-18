#ifndef SLAVEWEBSOCKET_H
#define SLAVEWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include "Watchdog.h"
#include <string>

class SlaveWebSocket : public WebSocket
{
public:
    virtual void onMessage(Mode type, const void *data, size_t len) override
    {
        Log::debug("GOT MESSAGE %s %zu bytes", type == WebSocket::Text ? "text" : "binary", len);
        if (type == WebSocket::Text) {
            Log::debug("GOT MSG [%s]", std::string(reinterpret_cast<const char *>(data), len).c_str());
            std::string err;
            json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(data), len), err, json11::JsonParse::COMMENTS);
            if (!err.empty()) {
                Log::error("Failed to parse json from slave: %s", err.c_str());
                Watchdog::stop();
                Client::runLocal(Client::acquireSlot(Client::Wait));
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

            if (type != "response") {
                Log::error("Unexpected message type %s. Wanted \"response\"", msg["type"].string_value().c_str());
                Watchdog::stop();
                Client::runLocal(Client::acquireSlot(Client::Wait));
                return;
            }

            json11::Json::array index = msg["index"].array_items();
            Client::data().exitCode = msg["exitCode"].int_value();
            if (index.empty()) {
                Log::error("No files?");
                Watchdog::stop();
                Client::runLocal(Client::acquireSlot(Client::Wait));
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
                    Client::runLocal(Client::acquireSlot(Client::Wait));
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
                Client::runLocal(Client::acquireSlot(Client::Wait));
                return;
            }
            fill(reinterpret_cast<const unsigned char *>(data), len);
            if (files.empty())
                done = true;
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
                    Log::error("Failed to write to file %s (%d %s)", front->path.c_str(), errno, strerror(errno));
                    Watchdog::stop();
                    Client::runLocal(Client::acquireSlot(Client::Wait));
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
            Client::runLocal(Client::acquireSlot(Client::Wait));
        }
    }

    struct File {
        std::string path;
        size_t remaining;
    };

    std::vector<File> files;
    FILE *f { 0 };
    bool done { false };

};


#endif /* SLAVEWEBSOCKET_H */
