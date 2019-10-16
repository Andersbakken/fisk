#include "Watchdog.h"
#include "Config.h"
#include "Client.h"
#include "Log.h"

Watchdog::Watchdog()
    : mState(Config::watchdog ? Running : Stopped)
{
    mTransitionTime = Watchdog::timings[Initial] = Client::mono();
    if (Config::objectCache) {
        stages = { Initial, ConnectedToDaemon, PreprocessFinished, ConnectedToScheduler, AcquiredSlave, ConnectedToSlave, UploadedJob, Finished };
    } else {
        stages = { Initial, ConnectedToDaemon, ConnectedToScheduler, AcquiredSlave, ConnectedToSlave, PreprocessFinished, UploadedJob, Finished };
    }
}

void Watchdog::transition(Stage stage)
{
    if (mState != Running)
        return;
    Watchdog::timings[mStage + 1] = Client::mono();
    std::unique_lock<std::mutex> lock(Client::mutex());
    DEBUG("Watchdog transition from %s to %s (stage took %llu)",
          stageName(stages[mStage]), stageName(stage),
          Watchdog::timings[mStage + 1] - Watchdog::timings[mStage]);
    assert(stages[mStage + 1] == stage);
    ++mStage;
    mTransitionTime = Client::mono();
}

Watchdog::Stage Watchdog::currentStage() const
{
    std::unique_lock<std::mutex> lock(Client::mutex());
    return stages[mStage];
}

void Watchdog::stop()
{
    if (mState == Running)
        mState = Stopped;
}

int Watchdog::timeout()
{
    if (mState != Running || stages[mStage] == Finished)
        return -1;
    const unsigned long long now = Client::mono();
    mTimeoutTime = mTransitionTime;
    switch (stages[mStage + 1]) {
    case Initial:
        assert(0);
        break;
    case ConnectedToDaemon:
        mTimeoutTime += Config::daemonConnectTimeout;
        break;
    case ConnectedToScheduler:
        mTimeoutTime += Config::schedulerConnectTimeout;
        break;
    case PreprocessFinished:
        mTimeoutTime += Config::preprocessTimeout;
        break;
    case AcquiredSlave:
        mTimeoutTime += Config::acquiredSlaveTimeout;
        break;
    case ConnectedToSlave:
        mTimeoutTime += Config::slaveConnectTimeout;
        break;
    case UploadedJob:
        mTimeoutTime += Config::uploadJobTimeout;
        break;
    case Finished:
        mTimeoutTime += Config::responseTimeout;
        break;
    }
    if (now >= mTimeoutTime) {
        DEBUG("Already timed out waiting for %s", stageName(static_cast<Stage>(mStage + 1)));
        return 0;
    }
    VERBOSE("Setting watchdog timeout to %llu (%llu/%llu) waiting for %s",
            mTimeoutTime - now,
            mTimeoutTime, now,
            stageName(static_cast<Stage>(mStage + 1)));
    return static_cast<int>(mTimeoutTime - now);
}

void Watchdog::onTimeout()
{
    if (mState == Running && Client::mono() >= mTimeoutTime) {
        ERROR("%d %d Watchdog timed out waiting for %s", mState, static_cast<int>(Config::watchdog), stageName(static_cast<Stage>(stages[mStage + 1])));
        // Client::runLocal(Client::acquireSlot(Client::Slot::Compile), "watchdog");
        mState = TimedOut;
    }
}

void Watchdog::heartbeat()
{
    mTransitionTime = Client::mono();
    wakeup();
}
