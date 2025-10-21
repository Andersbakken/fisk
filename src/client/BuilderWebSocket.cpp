#include "BuilderWebSocket.h"

void BuilderWebSocket::onConnected()
{
}

void BuilderWebSocket::onMessage(MessageType messageType, const void *bytes, size_t len)
{
    Client::Data &data = Client::data();
    DEBUG("Got message %s %zu bytes", messageType == WebSocket::Text ? "text" : "binary", len);

    if (messageType == WebSocket::Binary) {
        handleFileContents(bytes, len);
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
            std::string uncolored;
            const std::string *haystack;
            if (stdErr.size() < 128 * 1024 && !hasJSONDiagnostics) {
                uncolored = Client::uncolor(stdErr);
                haystack = &uncolored;
            } else {
                haystack = &stdErr;
            }
            if (haystack->empty()
                || haystack->find("unable to rename temporary ") != std::string::npos
                || haystack->find("execvp: No such file or directory") != std::string::npos
                || haystack->find("cannot execute ") != std::string::npos
                || haystack->find("cannot open ") != std::string::npos
                || haystack->find("internal compiler error") != std::string::npos
                || haystack->find("error trying to exec") != std::string::npos) {
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
                    fwrite(Client::data().preprocessed->stdOut.data(), Client::data().preprocessed->stdOut.size(), 1, errorFile);
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

        if (!data.preprocessed->stdErr.empty()) {
            if (hasJSONDiagnostics) {
                const std::string formatted = Client::formatJSONDiagnostics(data.preprocessed->stdErr);
                if (!formatted.empty()) {
                    fwrite(formatted.c_str(), sizeof(char), formatted.size(), stderr);
                }
            } else {
                fwrite(data.preprocessed->stdErr.c_str(), sizeof(char), data.preprocessed->stdErr.size(), stderr);
            }
        }

        if (!stdOut.empty()) {
            fwrite(stdOut.c_str(), 1, stdOut.size(), stdout);
        }
        if (!stdErr.empty()) {
            if (hasJSONDiagnostics) {
                const std::string formatted = Client::formatJSONDiagnostics(stdErr);
                if (!formatted.empty()) {
                    fwrite(formatted.c_str(), sizeof(char), formatted.size(), stderr);
                }
            } else {
                fwrite(stdErr.c_str(), 1, stdErr.size(), stderr);
            }
        }

        const auto objectCache = msg["objectCache"];
        if (objectCache.is_bool() && objectCache.bool_value()) {
            data.objectCache = true;
        }

        if (!index.empty()) {
            files.reserve(index.size());
            for (size_t i=0; i<index.size(); ++i) {
                File ff;
                ff.path = index[i]["path"].string_value();
                ff.size = index[i]["bytes"].int_value();
                Client::data().totalWritten += ff.size;
                if (ff.path.empty()) {
                    ERROR("No file for idx: %zu", i);
                    Client::data().watchdog->stop();
                    error = "builder protocol error";
                    done = true;
                    return;
                }
                if (!ff.size) {
                    FILE *f = fopen(ff.path.c_str(), "w");
                    DEBUG("Opened file [%s] -> [%s] -> %p", files[0].path.c_str(), Client::realpath(files[0].path).c_str(), f);
                    if (!f) {
                        ERROR("Can't open file: %s", files[0].path.c_str());
                        Client::data().watchdog->stop();
                        error = "builder file open error";
                        done = true;
                    } else {
                        fclose(f);
                    }
                } else {
                    files.push_back(ff);
                }
            }
            done = files.empty();
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

void BuilderWebSocket::handleFileContents(const void *data, size_t len)
{
    DEBUG("Got binary data: %zu bytes", len);
    if (files.empty()) {
        ERROR("Unexpected binary data (%zu bytes)", len);
        Client::data().watchdog->stop();
        error = "builder protocol error 2";
        done = true;
        return;
    }
    File &front = files.front();
    if (len != front.size) {
        ERROR("Unexpected file data from server for file %s expected %zu, got %zu", front.path.c_str(), front.size, len);
        Client::data().watchdog->stop();
        error = "builder file data error";
        done = true;
        return;
    }

    FILE *f = fopen(front.path.c_str(), "w");
    DEBUG("Opened file [%s] -> [%s] -> %p", front.path.c_str(), Client::realpath(front.path).c_str(), f);
    if (!f) {
        ERROR("Failed to open file for writing %s (%d %s)", front.path.c_str(), errno, strerror(errno));
        Client::data().watchdog->stop();
        error = "builder file open error";
        done = true;
        return;
    }

    bool ok;
    if (Config::compress) {
        ok = Client::uncompressToFile(front.path, f, data, len);
    } else {
        ok = fwrite(data, 1, len, f) == len;
    }
    if (!ok) {
        ERROR("Failed to write to file %s (%d %s)", front.path.c_str(), errno, strerror(errno));
        Client::data().watchdog->stop();
        error = "builder file write error";
        done = true;
        return;
    }

    files.erase(files.begin());
    done = files.empty();
}

