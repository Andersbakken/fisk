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
    void handleResponseBinary(const void *data, size_t len);
    void fill(const unsigned char *data, const size_t bytes);

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
