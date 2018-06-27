#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include "Log.h"

Watchdog::Watchdog()
    : mStopped(!Config::watchdog())
{
    mTransitionTime = Watchdog::timings[Initial] = Client::started;
}

void Watchdog::transition(Stage stage)
{
    assert(stage > 0);
    assert(mStage + 1 == stage);
    Watchdog::timings[stage] = Client::mono();
    std::unique_lock<std::mutex> lock(Client::mutex());
    DEBUG("Watchdog transition from %s to %s (stage took %llu)", stageName(mStage), stageName(stage), Watchdog::timings[stage] - Watchdog::timings[stage - 1]);
    mStage = stage;
    mTransitionTime = Client::mono();
}

void Watchdog::stop()
{
    mStopped = true;
}

int Watchdog::timeout() const
{
    if (mStopped)
        return -1;
    const unsigned long long now = Client::mono();
    unsigned long long timeout = mTransitionTime;
    switch (mStage) {
    case Initial:
        timeout += Config::schedulerConnectTimeout();
        break;
    case ConnectedToScheduler:
        timeout += Config::acquiredSlaveTimeout();
        break;
    case AcquiredSlave:
        timeout += Config::slaveConnectTimeout();
        break;
    case ConnectedToSlave:
        timeout += Config::uploadJobTimeout();
        break;
    case UploadedJob:
        timeout += Config::responseTimeout();
        break;
    case Finished:
        return -1;
    }
    if (now >= timeout) {
        DEBUG("Already timed out waiting for %s", stageName(static_cast<Stage>(mStage + 1)));
        return 0;
    }
    // DEBUG("Setting watchdog timeout to %llu waiting for %s",
    //       timeout - now,
    //       stageName(static_cast<Stage>(mStage + 1)));
    return timeout - now;
}

void Watchdog::onTimeout()
{
    DEBUG("Watchdog timed out waiting for %s", stageName(static_cast<Stage>(mStage + 1)));
    Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
}
