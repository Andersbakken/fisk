#include "SchedulerWebSocket.h"

void SchedulerWebSocket::onConnected()
{
    Client::data().watchdog->transition(Watchdog::ConnectedToScheduler);
}
