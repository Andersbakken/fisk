#ifndef DAEMONSOCKET_H
#define DAEMONSOCKET_H

#include "Select.h"
#include <string>
#include <condition_variable>
#include <mutex>

class DaemonSocket : public Socket
{
public:
    DaemonSocket();
    bool connect();

    enum State {
        Error = -2,
        Closed = -1,
        None,
        Connecting,
        Connected
    };
    State state() const { return mState; }
    bool hasPendingSendData() const { return !mSendBuffer.empty(); }
    enum Command {
        AcquireCppSlot = 1,
        AcquireCompileSlot = 2,
        TryAcquireCompileSlot = 3,
        ReleaseCppSlot = 4,
        ReleaseCompileSlot = 5,
        JSON = 6
    };

    void send(const std::string &json);
    void send(Command cmd);
    bool hasCppSlot() const;
    bool waitForCppSlot();

    bool hasCompileSlot() const { return mCompileSlotState == CompileSlot_Acquired; }
    bool waitForCompileSlot(Select &select);
    std::string error() const { return mError; }
    void processJSON(const std::string &json);
protected:
    // Socket
    virtual unsigned int mode() const override;
    virtual int timeout() override { return -1; }
    virtual int fd() const override { return mFD; }
    virtual void onWrite() override;
    virtual void onRead() override;
    virtual void onTimeout() override {}
private:
    void write();
    void close(std::string &&err = std::string());
    enum Response {
        CppSlotAcquired = 10,
        CompileSlotAcquired = 11,
        CompileSlotNotAcquired = 12,
        JSONResponse = 13
    };
    size_t processMessage(const char *msg, size_t len);

    int mFD { -1 };
    State mState { None };
    std::string mSendBuffer;
    size_t mSendBufferOffset { 0 };
    std::string mRecvBuffer;
    bool mHasCppSlot { false };
    enum CompileSlotState {
        CompileSlot_None,
        CompileSlot_Acquired,
        CompileSlot_Failed
    } mCompileSlotState { CompileSlot_None };
    std::string mError;
    mutable std::mutex mMutex;
    std::condition_variable mCond;

};

#endif /* DAEMONSOCKET_H */
