#ifndef WATCHDOG_H
#define WATCHDOG_H

#include <string>
#include <assert.h>

namespace Watchdog {
enum Stage {
    Initial,
    ConnectedToScheduler,
    AcquiredSlave,
    ConnectedToSlave,
    UploadedJob,
    Finished
};

extern unsigned long long timings[Finished + 1];
inline const char *stageName(Stage stage)
{
    switch (stage) {
    case Initial: return "Initial";
    case ConnectedToScheduler: return "ConnectedToScheduler";
    case AcquiredSlave: return "AcquiredSlave";
    case ConnectedToSlave: return "ConnectedToSlave";
    case UploadedJob: return "UploadedJob";
    case Finished: return "Finished";
    }
    assert(0);
    return "";
}
void transition(Stage stage);
void start(const std::string &compiler, int argc, char **argv);
void stop();
bool timedOut();
};

#endif /* WATCHDOG_H */
