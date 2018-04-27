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
void transition(Stage stage);
void start(const std::string &compiler, int argc, char **argv);
void stop();
};

#endif /* WATCHDOG_H */
