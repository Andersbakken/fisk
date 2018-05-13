#ifndef WATCHDOG_H
#define WATCHDOG_H

#include <string>

namespace Watchdog {
enum Stage {
    Initial,
    ConnectedToScheduler,
    AcquiredSlave,
    ConnectedToSlave,
    WaitingForResponse
};
inline const char *stageName(Stage stage)
{
    switch (stage) {
    case Initial: return "Initial";
    case ConnectedToScheduler: return "ConnectedToScheduler";
    case AcquiredSlave: return "AcquiredSlave";
    case ConnectedToSlave: return "ConnectedToSlave";
    case WaitingForResponse: return "WaitingForResponse";
    }
    assert(0);
    return "";
}
void transition(Stage stage);
void start(const std::string &compiler, int argc, char **argv);
void stop();
};

#endif /* WATCHDOG_H */
