#ifndef WATCHDOG_H
#define WATCHDOG_H

#include "Client.h"
#include "Select.h"
#include <assert.h>
#include <assert.h>
#include <atomic>
#include <string>
#include <vector>

class Watchdog : public Socket
{
public:
    Watchdog();
    enum Stage {
        Initial,
        ConnectedToDaemon,
        PreprocessFinished,
        ConnectedToScheduler,
        AcquiredSlave,
        ConnectedToSlave,
        UploadedJob,
        Finished
    };

    std::vector<Stage> stages;
    unsigned long long timings[Finished + 1] { 0 };
    static inline const char *stageName(Stage stage)
    {
        switch (stage) {
        case Initial: return "Initial";
        case ConnectedToDaemon: return "ConnectedToDaemon";
        case ConnectedToScheduler: return "ConnectedToScheduler";
        case AcquiredSlave: return "AcquiredSlave";
        case ConnectedToSlave: return "ConnectedToSlave";
        case PreprocessFinished: return "PreprocessFinished";
        case UploadedJob: return "UploadedJob";
        case Finished: return "Finished";
        }
        assert(0);
        return "";
    }
    void transition(Stage stage);
    void heartbeat();
    void stop();
    bool timedOut() const { return mState == TimedOut; }
protected:
    virtual int fd() const override { return -1; }
    virtual unsigned int mode() const override { return None; }
    virtual void onWrite() override {}
    virtual void onRead() override {}
    virtual void onTimeout() override;
    virtual int timeout() override;
private:
    size_t mStage { 0 };
    enum State {
        Running,
        Stopped,
        Suspended,
        TimedOut
    } mState { Running };
    unsigned long long mTransitionTime { Client::mono() };
    unsigned long long mTimeoutTime { 0 };
};

#endif /* WATCHDOG_H */
