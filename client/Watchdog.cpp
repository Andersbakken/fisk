#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include "Log.h"

Watchdog::Watchdog()
    : mState(Config::watchdog ? Running : Stopped)
{
    mTransitionTime = Watchdog::timings[Initial] = Client::mono();
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
    if (mState == Running)
        mState = Stopped;
}

int Watchdog::timeout()
{
    if (mState != Running)
        return -1;
    const unsigned long long now = Client::mono();
    mTimeoutTime = mTransitionTime;
    switch (mStage) {
    case Initial:
        mTimeoutTime += Config::schedulerConnectTimeout;
        break;
    case ConnectedToScheduler:
        mTimeoutTime += Config::acquiredSlaveTimeout;
        break;
    case AcquiredSlave:
        mTimeoutTime += Config::slaveConnectTimeout;
        break;
    case ConnectedToSlave:
        mTimeoutTime += Config::preprocessTimeout;
        break;
    case PreprocessFinished:
        mTimeoutTime += Config::uploadJobTimeout;
        break;
    case UploadedJob:
        mTimeoutTime += Config::responseTimeout;
        break;
    case Finished:
        return -1;
    }
    if (now >= mTimeoutTime) {
        DEBUG("Already timed out waiting for %s", stageName(static_cast<Stage>(mStage + 1)));
        return 0;
    }
    VERBOSE("Setting watchdog timeout to %llu (%llu/%llu) waiting for %s",
            mTimeoutTime - now,
            mTimeoutTime, now,
            stageName(static_cast<Stage>(mStage + 1)));
    return mTimeoutTime - now;
}

void Watchdog::onTimeout()
{
    if (mState == Running && Client::mono() >= mTimeoutTime) {
        ERROR("Watchdog timed out waiting for %s", stageName(static_cast<Stage>(mStage + 1)));
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
    }
}

void Watchdog::heartbeat()
{
    mTransitionTime = Client::mono();
    wakeup();
}
