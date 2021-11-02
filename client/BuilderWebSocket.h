#ifndef BUILDERWEBSOCKET_H
#define BUILDERWEBSOCKET_H

#include "WebSocket.h"
#include "Client.h"
#include "Preprocessed.h"
#include "Watchdog.h"
#include <string>

extern "C" const char *npm_version;
class BuilderWebSocket : public WebSocket
{
public:
    bool wait { false };
    virtual void onConnected() override;
    virtual void onMessage(MessageType messageType, const void *bytes, size_t len) override
    {
        Client::Data &data = Client::data();
        DEBUG("Got message %s %zu bytes", messageType == WebSocket::Text ? "text" : "binary", len);

        if (messageType == WebSocket::Binary) {
            handleResponseBinary(bytes, len);
            return;
        }

        WARN("Got message from builder %s %s", url().c_str(),
             std::string(reinterpret_cast<const char *>(bytes), len).c_str());
        std::string err;
        json11::Json msg = json11::Json::parse(std::string(reinterpret_cast<const char *>(bytes), len), err, json11::JsonParse::COMMENTS);
        if (!err.empty()) {
            ERROR("Failed to parse json from builder: %s", err.c_str());
            data.watchdog->stop();
            error = "builder json parse error";
            done = true;
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
            data.watchdog->heartbeat();
            return;
        }

        if (type == "response") {
            const auto success = msg["success"];
            if (!success.is_bool() || !success.bool_value()) {
                ERROR("Builder had some issue. Build locally: %s", msg["error"].string_value().c_str());
                data.watchdog->stop();
                error = "builder run failure";
                done = true;
                return;
            }

            json11::Json::array index = msg["index"].array_items();
            data.exitCode = msg["exitCode"].int_value();
            const std::string stdOut = msg["stdout"].string_value();
            const std::string stdErr = msg["stderr"].string_value();

            if (data.exitCode) {
                const std::string uncolored = Client::uncolor(stdErr);
                if (uncolored.empty()
                    || uncolored.find("unable to rename temporary ") != std::string::npos
                    || uncolored.find("execvp: No such file or directory") != std::string::npos
                    || uncolored.find("cannot execute ") != std::string::npos
                    || uncolored.find("internal compiler error") != std::string::npos
                    || uncolored.find("error trying to exec") != std::string::npos) {
                    ERROR("Builder %s%s had a suspicious error. Building locally:\n%s",
                          data.builderHostname.empty() ? "" : (" " + data.builderHostname).c_str(),
                          url().c_str(),
                          Client::base64(stdErr).c_str());
                    data.watchdog->stop();
                    error = "suspicious error";
                    done = true;
                    return;
                }
                std::string str;
                if (Client::data().preprocessed && Config::storePreprocessedDataOnError) {
                    std::string basename;
                    Client::parsePath(data.compilerArgs->sourceFile(), &basename, nullptr);
                    FILE *errorFile = fopen((basename + ".error.ii").c_str(), "w");
                    if (errorFile) {
                        fwrite(Client::data().preprocessed->stdOut.c_str(), Client::data().preprocessed->stdOut.size(), 1, errorFile);
                        fclose(errorFile);
                        str = "Wrote error to " + (basename + ".error.ii");
                    } else {
                        str = std::string("Failed to open file ") + strerror(errno);
                    }
                }

                fprintf(stderr, "error: exit code: %d Fisk builder: %s source file: %s cache: %s fisk-version: %s\n%s\n",
                        data.exitCode, url().c_str(), data.compilerArgs->sourceFile().c_str(),
                        data.objectCache ? "true" : "false", npm_version, str.c_str());

            }

            if (!stdOut.empty()) {
                fwrite(stdOut.c_str(), 1, stdOut.size(), stdout);
            }
            if (!stdErr.empty()) {
                fwrite(stdErr.c_str(), 1, stdErr.size(), stderr);
            }

            const auto objectCache = msg["objectCache"];
            if (objectCache.is_bool() && objectCache.bool_value()) {
                data.objectCache = true;
            }

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
                        error = "builder protocol error";
                        done = true;
                        return;
                    }
                }
                f = fopen(files[0].path.c_str(), "w");
                DEBUG("Opened file [%s] -> [%s] -> %p", files[0].path.c_str(), Client::realpath(files[0].path).c_str(), f);
                if (!f) {
                    ERROR("Can't open file: %s", files[0].path.c_str());
                    Client::data().watchdog->stop();
                    error = "builder file open error";
                    done = true;
                    return;
                }
                assert(f);
                if (files[0].remaining)
                    fill(nullptr, 0);
            } else {
                done = true;
            }
            return;
        }

        ERROR("Unexpected message type %s.", msg["type"].string_value().c_str());
        Client::data().watchdog->stop();
        error = "builder protocol error 5";
        done = true;
    }

    void handleResponseBinary(const void *data, size_t len)
    {
        DEBUG("Got binary data: %zu bytes", len);
        if (files.empty()) {
            ERROR("Unexpected binary data (%zu bytes)", len);
            Client::data().watchdog->stop();
            error = "builder protocol error 2";
            done = true;
            return;
        }
        fill(reinterpret_cast<const unsigned char *>(data), len);
        if (files.empty()) {
            done = true;
            Client::data().totalWritten = totalWritten;
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
                    error = "builder file write error";
                    done = true;
                    return;
                }
                offset += b;
                front->remaining -= b;
            }
            if (!front->remaining) {
                int ret;
                EINTRWRAP(ret, fclose(f));
                f = nullptr;
                files.erase(files.begin());
                if (files.empty()) {
                    if (Config::syncFileSystem) {
                        DEBUG("Syncing file system");
                        sync();
                    }
                    break;
                }
                front = &files.front();
                f = fopen(front->path.c_str(), "w");
                DEBUG("Opened file [%s] -> [%s] -> %p", front->path.c_str(), Client::realpath(front->path).c_str(), f);
                if (!f) {
                    Client::data().watchdog->stop();
                    error = "builder file open error 2";
                    done = true;
                    return;
                }

                assert(f);
                continue;
            }
        } while (offset < bytes);
        if (offset < bytes) {
            ERROR("Extraneous bytes. Abandon ship (%zu/%zu)", offset, bytes);
            Client::data().watchdog->stop();
            error = "builder protocol error 3";
            done = true;
        }
    }

    struct File {
        std::string path;
        size_t remaining;
    };

    std::vector<File> files;
    size_t totalWritten { 0 };
    FILE *f { nullptr };
    bool done { false };
    std::string error;
};


#endif /* BUILDERWEBSOCKET_H */
