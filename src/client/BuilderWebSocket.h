#ifndef BUILDERWEBSOCKET_H
#define BUILDERWEBSOCKET_H

#include "Client.h"
#include "Preprocessed.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <string>

extern "C" const char *npm_version;

class BuilderWebSocket : public WebSocket
{
public:
    virtual void onConnected() override;
    virtual void onMessage(MessageType messageType, const void *bytes, size_t len) override;
    virtual bool connectFinished() override;
    void handleFileContents(const void *data, size_t len);

    struct File
    {
        std::string path;
        size_t size;
    };

    bool wait { false };
    std::vector<File> files;
    bool done { false };
    std::string error;
    std::string cachedSourcePath;
};

#endif /* BUILDERWEBSOCKET_H */
