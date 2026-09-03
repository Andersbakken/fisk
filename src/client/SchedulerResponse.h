#ifndef SCHEDULERRESPONSE_H
#define SCHEDULERRESPONSE_H

#include "Client.h"
#include <string>
#include <vector>

// The scheduler's answer to "give me a builder". It reaches us either on our own
// websocket or relayed by the daemon over the unix socket, and both paths have to
// interpret it identically, so this is the only place that knows the messages.
struct SchedulerResponse
{
    // A terminal message arrived; there is nothing more to wait for.
    bool done { false };
    bool needsEnvironment { false };
    int jobId { 0 };
    std::string environment;
    std::vector<std::string> extraArguments;
    // Non-empty means we cannot compile remotely for this translation unit.
    std::string error;

    bool finished() const
    {
        return done || !error.empty();
    }

    // Also fills in the builder ip/hostname/port in Client::data().
    void apply(const nlohmann::json &msg);
    void applyRaw(const std::string &raw);
};

#endif /* SCHEDULERRESPONSE_H */
