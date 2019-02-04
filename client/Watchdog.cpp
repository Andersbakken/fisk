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
    if (mStage == 0) {
        if (Config::objectCache) {
            stages = { Initial, PreprocessFinished, ConnectedToScheduler, AcquiredSlave, ConnectedToSlave, UploadedJob, Finished };
        } else {
            stages = { Initial, ConnectedToScheduler, AcquiredSlave, ConnectedToSlave, PreprocessFinished, UploadedJob, Finished };
        }
    }
    Watchdog::timings[mStage + 1] = Client::mono();
    std::unique_lock<std::mutex> lock(Client::mutex());
    DEBUG("Watchdog transition from %s to %s (stage took %llu)",
          stageName(stages[mStage]), stageName(stage),
          Watchdog::timings[mStage + 1] - Watchdog::timings[mStage]);
    assert(stages[mStage + 1] == stage);
    ++mStage;
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
        ERROR("%d %d Watchdog timed out waiting for %s", mState, (int)Config::watchdog, stageName(static_cast<Stage>(stages[mState + 1])));
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "watchdog");
    }
}

void Watchdog::heartbeat()
{
    mTransitionTime = Client::mono();
    wakeup();
}
