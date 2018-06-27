#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <functional>
#include <string>
#include <vector>
#include <map>
#include <wslay/wslay.h>
#include "Select.h"
#include <LUrlParser.h>

class WebSocket : public Socket
{
public:
    WebSocket();
    ~WebSocket();

    enum MessageType {
        Text,
        Binary
    };
    bool connect(std::string &&url, const std::map<std::string, std::string> &headers);
    bool send(MessageType mode, const void *data, size_t len);
    void close(const char *reason);
    bool hasPendingSendData() const { return !mSendBuffer.empty(); }
    enum State {
        Error = -2,
        Closed = -1,
        None,
        ConnectingTCP,
        ConnectedTCP,
        WaitingForUpgrade,
        ConnectedWebSocket
    };
    State state() const { return mState; }

protected:
    virtual void onMessage(MessageType mode, const void *data, size_t len) = 0;
    virtual void onConected() = 0;

    // Socket
    virtual unsigned int mode() const override;
    virtual int timeout() const override { return -1; }
    virtual int fd() const override { return mFD; }
    virtual void onWrite() override;
    virtual void onRead() override;
    virtual void onTimeout() override {}
private:
    bool requestUpgrade();
    void acceptUpgrade();
    void send();
    std::string mUrl, mHost, mClientKey;
    int mPort { -1 };
    LUrlParser::clParseURL mParsedUrl;
    std::map<std::string, std::string> mHeaders;
    int mFD { -1 };
    wslay_event_callbacks mCallbacks { 0 };
    wslay_event_context *mContext { 0 };
    bool mWatchDogTimedOut { false };

    std::vector<unsigned char> mRecvBuffer, mSendBuffer;
    State mState { None };
};

#endif /* WEBSOCKET_H */
