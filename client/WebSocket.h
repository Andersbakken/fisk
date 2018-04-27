#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include <functional>
#include <string>
#include <vector>
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
    bool connect(std::string &&url);
    bool send(Mode mode, const void *data, size_t len);
    bool process(std::function<void(Mode mode, const void *data, size_t len)> &&onMessage);
private:
    std::function<void(Mode mode, const void *data, size_t len)> mOnMessage;

    std::string mUrl;
    int mFD { -1 };
    wslay_event_callbacks mCallbacks { 0 };
    wslay_event_context *mContext { 0 };
};

#endif /* WEBSOCKET_H */
