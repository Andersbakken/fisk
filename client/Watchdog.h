#ifndef WATCHDOG_H
#define WATCHDOG_H

#include "Client.h"
#include "Select.h"
#include <assert.h>
#include <assert.h>
#include <atomic>
#include <string>

class Watchdog : public Socket
{
public:
    Watchdog();
    enum Stage {
        Initial,
        PreprocessFinished,
        ConnectedToScheduler,
        AcquiredSlave,
        ConnectedToSlave,
        UploadedJob,
        Finished
    };

    unsigned long long timings[Finished + 1] { 0 };
    static inline const char *stageName(Stage stage)
    {
        switch (stage) {
        case Initial: return "Initial";
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
protected:
    virtual int fd() const override { return -1; }
    virtual unsigned int mode() const override { return None; }
    virtual void onWrite() override {}
    virtual void onRead() override {}
    virtual void onTimeout() override;
    virtual int timeout() override;
private:
    Watchdog::Stage mStage { Watchdog::Initial };
    enum State {
        Running,
        Stopped,
        Suspended
    } mState { Running };
    unsigned long long mTransitionTime { Client::mono() };
    unsigned long long mTimeoutTime { 0 };
};

#endif /* WATCHDOG_H */
