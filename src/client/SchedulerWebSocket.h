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
    virtual void onMessage(MessageType type, const void *bytes, size_t len) override;

    bool done { false };
    std::string error;
    bool needsEnvironment { false };
    int jobId { 0 };
    std::string environment;
    std::vector<std::string> extraArguments;
};


#endif /* SCHEDULERWEBSOCKET_H */
