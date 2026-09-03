#include "SchedulerWebSocket.h"

std::string SchedulerWebSocket::type() const
{
    return "Scheduler";
}

void SchedulerWebSocket::onConnected()
{
    Client::data().watchdog->transition(Watchdog::ConnectedToScheduler);
}

void SchedulerWebSocket::onMessage(MessageType type, const void *bytes, size_t len)
{
    if (type != WebSocket::Text) {
        return;
    }

    SchedulerResponse response;
    response.applyRaw(std::string(reinterpret_cast<const char *>(bytes), len));
    needsEnvironment = response.needsEnvironment;
    jobId = response.jobId;
    environment = std::move(response.environment);
    extraArguments = std::move(response.extraArguments);
    if (!response.error.empty()) {
        Client::data().watchdog->stop();
        setError(response.error);
    }
    if (response.finished()) {
        done = true;
    }
}

bool SchedulerWebSocket::connectFinished()
{
    return done;
}
