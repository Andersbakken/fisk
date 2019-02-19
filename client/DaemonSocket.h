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
    void send(const std::string &json);

    enum State {
        Error = -2,
        Closed = -1,
        None,
        Connecting,
        Connected
    };
    State state() const { return mState; }
    bool hasPendingSendData() const { return !mSendBuffer.empty(); }
    void acquireCppSlot();
    bool hasCppSlot() const;
    bool waitForCppSlot();
    void releaseCppSlot();

    void acquireCompileSlot();
    bool hasCompileSlot() const { return mHasCompileSlot; }
    bool waitForCompileSlot(Select &select);
    std::string error() const { return mError; }
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
    void processMessage(const std::string &message);

    int mFD { -1 };
    State mState { None };
    std::string mSendBuffer;
    size_t mSendBufferOffset { 0 };
    std::string mRecvBuffer;
    bool mHasCppSlot { false };
    bool mHasCompileSlot { false };
    std::string mError;
    mutable std::mutex mMutex;
    std::condition_variable mCond;

};

#endif /* DAEMONSOCKET_H */
