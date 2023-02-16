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
    virtual void onMessage(MessageType messageType, const void *bytes, size_t len) override;
    void handleFileContents(const void *data, size_t len);

    struct File {
        std::string path;
        size_t size;
    };

    std::vector<File> files;
    bool done { false };
    std::string error;
};


#endif /* BUILDERWEBSOCKET_H */
