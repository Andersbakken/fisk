#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <functional>
#include <string>
#include <vector>
#include <map>
#include <wslay/wslay.h>

class WebSocket
{
public:
    WebSocket();
    ~WebSocket();

    enum Mode {
        Text,
        Binary
    };
    bool connect(std::string &&url, const std::map<std::string, std::string> &headers);
    bool send(Mode mode, const void *data, size_t len);
    bool exec(std::function<void(Mode mode, const void *data, size_t len)> &&onMessage);
    void exit();
private:
    std::function<void(Mode mode, const void *data, size_t len)> mOnMessage;

    std::string mUrl;
    int mFD { -1 };
    wslay_event_callbacks mCallbacks { 0 };
    wslay_event_context *mContext { 0 };

    std::vector<unsigned char> mRecvBuffer, mSendBuffer;
    bool mExit { false };
};

#endif /* WEBSOCKET_H */
