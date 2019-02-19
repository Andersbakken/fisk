#ifndef DAEMONSOCKET_H
#define DAEMONSOCKET_H

#include "Select.h"

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

    int mFD { -1 };
    State mState { None };
    std::string mSendBuffer;
    size_t mSendBufferOffset { 0 };
    std::string mRecvBuffer;

};

#endif /* DAEMONSOCKET_H */
