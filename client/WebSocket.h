#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <functional>
#include <string>
#include <vector>
#include <map>
#include <wslay/wslay.h>
#include "Select.h"

class WebSocket : public Socket
{
public:
    WebSocket();
    ~WebSocket();

    enum Mode {
        Text,
        Binary
    };
    bool connect(std::string &&url, const std::map<std::string, std::string> &headers,
                 std::function<void(Mode mode, const void *data, size_t len)> &&onMessage);
    bool send(Mode mode, const void *data, size_t len);
    void close(const char *reason);

protected:
    virtual unsigned int mode() const override;
    virtual int timeout() const override { return -1; }
    virtual int fd() const override { return mFD; }
    virtual void onWrite() override;
    virtual void onRead() override;
    virtual void onTimeout() override {}
private:
    void send();
    std::function<void(Mode mode, const void *data, size_t len)> mOnMessage;

    std::string mUrl;
    int mFD { -1 };
    wslay_event_callbacks mCallbacks { 0 };
    wslay_event_context *mContext { 0 };

    std::vector<unsigned char> mRecvBuffer, mSendBuffer;
    bool mError { false };
    bool mClosed { false };
};

#endif /* WEBSOCKET_H */
