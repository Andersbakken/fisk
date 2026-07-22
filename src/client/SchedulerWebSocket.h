#ifndef SCHEDULERWEBSOCKET_H
#define SCHEDULERWEBSOCKET_H

#include "Client.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <string>

extern "C" const char *npm_version;

class SchedulerWebSocket : public WebSocket
{
public:
    virtual void onConnected() override;
    virtual void onMessage(MessageType type, const void *bytes, size_t len) override;
    virtual bool connectFinished() override;

    bool done { false };
    bool needsEnvironment { false };
    int jobId { 0 };
    std::string environment;
    std::vector<std::string> extraArguments;
};

#endif /* SCHEDULERWEBSOCKET_H */
