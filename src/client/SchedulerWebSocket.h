#ifndef SCHEDULERWEBSOCKET_H
#define SCHEDULERWEBSOCKET_H

#include "Client.h"
#include "SchedulerResponse.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <string>

class SchedulerWebSocket : public WebSocket
{
public:
    virtual std::string type() const override;
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
